/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's objects as a program sees them through IDispatchEx, and the
 * program's objects as a script sees them: one engine's half of the COM
 * crossing, over the shared runtime's guest bridge and dispatch server.
 *
 * What crosses is VBScript's: a number goes out as the VARTYPE of its
 * subtype -- an Integer as VT_I2, a Double as VT_R8 even when it is whole --
 * Nothing as a VT_DISPATCH holding no pointer, an array as a SAFEARRAY of
 * VARIANTs; and comes back the same way, a VT_I2 an Integer, a null
 * interface Nothing. JScript, which has one number, reads all of them as
 * numbers and writes a whole one as VT_I4; that is the difference.
 *
 * Names match without case, as VBScript's do. Of an instance of a script's
 * class, only Public members are reached; its DISPID_VALUE is the class's
 * Default member. A GetRef answer is called through DISPID_VALUE. A script
 * error inside a call the program made comes back to it as
 * DISP_E_EXCEPTION, the EXCEPINFO carrying VBScript's number as an HRESULT.
 */

import { drive } from '../script/drive.js';
import { externalTarget, createDispatchServer } from '../script/dispatch-server.js';
import {
    DISP_E_MEMBERNOTFOUND, E_FAIL, ExternalError, ExternalObject,
} from '../script/external.js';
import {
    DISPATCH_PROPERTYPUT, DISPATCH_PROPERTYPUTREF, DISPID_STARTENUM, DISPID_UNKNOWN,
    createGuestBridge,
} from '../script/guest-dispatch.js';
import { ScriptAbort } from '../script/engine.js';
import { VBScriptError } from './engine.js';
import { Var } from './interpreter.js';
import {
    FunctionRef, VBObject, adoptVariant, fromHost, prepareVariant,
} from './values.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('./engine.js').VBScriptEngine} VBScriptEngine
 * @typedef {import('../script/dispatch-server.js').DispatchTarget} DispatchTarget
 */

/** E_ABORT: a call the embedder stopped. */
const E_ABORT = 0x80004004 | 0;

/**
 * Runs what a program asked of a script object, its failure as the
 * program is told of one; what the call let go of is terminated after it
 * when no script is running underneath.
 *
 * @param {VBScriptEngine} engine
 * @param {() => Generator<unknown, Value, unknown>} steps
 * @returns {Promise<Value>}
 */
async function answer(engine, steps){
    const interp = engine.interpreter;
    try
    {
        return await drive((function*(){
            const value = yield* steps();
            if (interp.depth === 0)
            {
                yield* interp.flush(0);
            }
            return value;
        })());
    }
    catch (e){
        const failure = engine.failure(e, null);
        if (failure instanceof VBScriptError)
        {
            throw new ExternalError(failure.scode, failure.description, failure.source);
        }
        if (failure instanceof ScriptAbort)
        {
            throw new ExternalError(E_ABORT, failure.message, '');
        }
        throw failure instanceof ExternalError ? failure : new ExternalError(E_FAIL);
    }
}

/**
 * A list of names numbered as a program first asks for them, from 1.
 */
class Names
{
    constructor(){
        /** @type {string[]} the keys, in lower case */
        this.keys = [];
    }

    /** @param {string} key @returns {number} */
    idOf(key){
        let index = this.keys.indexOf(key);
        if (index < 0)
        {
            index = this.keys.push(key) - 1;
        }
        return index + 1;
    }

    /** @param {number} dispid @returns {string | undefined} */
    keyOf(dispid){
        return this.keys[dispid - 1];
    }
}

/**
 * The next of a list of keys after `dispid`, numbered as it goes.
 *
 * @param {Names} names @param {string[]} listed @param {number} dispid @returns {number}
 */
function nextOf(names, listed, dispid){
    let from = 0;
    if (dispid !== DISPID_STARTENUM)
    {
        const at = listed.indexOf(names.keyOf(dispid) ?? '');
        if (at < 0)
        {
            return DISPID_UNKNOWN;
        }
        from = at + 1;
    }
    return from < listed.length ? names.idOf(listed[from]) : DISPID_UNKNOWN;
}

/**
 * Whether a call writes: DISPATCH_PROPERTYPUT or PUTREF.
 *
 * @param {number} flags
 */
const putting = flags=>(flags & (DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF)) !== 0;

/**
 * An instance of a script's class, its Public members numbered.
 *
 * @param {VBScriptEngine} engine @param {VBObject} object @returns {DispatchTarget}
 */
export function classTarget(engine, object){
    const interp = engine.interpreter;
    const cls = object.cls;
    const names = new Names();
    /** @type {Map<string, string>} each member's name as the class spells it */
    const spelled = new Map([...cls.fields.map((/** @type {any} */ f)=>[f.key, f.name])]);
    for (const [key, member] of cls.members)
    {
        const proc = member.method ?? member.get ?? member.let ?? member.set;
        if (proc)
        {
            spelled.set(key, proc.name);
        }
    }
    const listed = ()=>[...cls.members].filter(([, member])=>member.isPublic).map(([key])=>key);
    return {
        dispId(name){
            const key = name.toLowerCase();
            return cls.members.get(key)?.isPublic ? names.idOf(key) : DISPID_UNKNOWN;
        },
        nameOf: dispid=>{
            const key = names.keyOf(dispid);
            return key === undefined ? null : spelled.get(key) ?? key;
        },
        invoke(dispid, flags, args){
            const key = dispid === 0 ? cls.defaultKey : names.keyOf(dispid);
            const member = key === null || key === undefined ? undefined : cls.members.get(key);
            if (member === undefined || !member.isPublic)
            {
                throw new ExternalError(DISP_E_MEMBERNOTFOUND);
            }
            const values = args.map(fromHost);
            return answer(engine, function*(){
                if (putting(flags))
                {
                    const set = (flags & DISPATCH_PROPERTYPUTREF) !== 0;
                    const value = values[values.length - 1];
                    const rest = values.slice(0, -1);
                    interp.pin(value);
                    if (member.field)
                    {
                        const field = /** @type {Var} */ (object.fields.get(/** @type {string} */ (key)));
                        if (rest.length > 0)
                        {
                            yield* interp.storeIndexed(field.value, rest, value, set);
                        }
                        else
                        {
                            interp.assignRef(field, value);
                        }
                        return undefined;
                    }
                    yield* interp.putProperty(object, member, rest, value, set);
                    return undefined;
                }
                if (member.field)
                {
                    const field = /** @type {Var} */ (object.fields.get(/** @type {string} */ (key)));
                    const value = yield* interp.applyValues(field.value, values);
                    interp.pin(value);
                    return value;
                }
                const value = yield* interp.callClassMember(object, member, values);
                interp.pin(value);
                return value;
            });
        },
        next: dispid=>nextOf(names, listed(), dispid),
        remove: ()=>false,
    };
}

/**
 * A procedure GetRef made: called through DISPID_VALUE.
 *
 * @param {VBScriptEngine} engine @param {FunctionRef} ref @returns {DispatchTarget}
 */
export function functionTarget(engine, ref){
    const interp = engine.interpreter;
    return {
        dispId: ()=>DISPID_UNKNOWN,
        nameOf: ()=>null,
        invoke(dispid, flags, args){
            if (dispid !== 0 || putting(flags))
            {
                throw new ExternalError(DISP_E_MEMBERNOTFOUND);
            }
            return answer(engine, function*(){
                const value = yield* interp.callProc(ref.proc, null, args.map(fromHost));
                interp.pin(value);
                return value;
            });
        },
        next: ()=>DISPID_UNKNOWN,
        remove: ()=>false,
    };
}

/**
 * The script's global namespace: its variables and procedures, what
 * GetScriptDispatch hands a program.
 *
 * @param {VBScriptEngine} engine @returns {DispatchTarget}
 */
export function globalTarget(engine){
    const interp = engine.interpreter;
    const names = new Names();
    /** @param {string} key */
    const known = key=>interp.globals.has(key) || interp.procs.has(key);
    return {
        dispId(name, _caseInsensitive, ensure){
            const key = name.toLowerCase();
            if (known(key))
            {
                return names.idOf(key);
            }
            if (ensure)
            {
                interp.globals.set(key, new Var(undefined));
                return names.idOf(key);
            }
            return DISPID_UNKNOWN;
        },
        nameOf: dispid=>{
            const key = names.keyOf(dispid);
            if (key === undefined)
            {
                return null;
            }
            return interp.procs.get(key)?.name ?? key;
        },
        invoke(dispid, flags, args){
            const key = names.keyOf(dispid);
            if (key === undefined || !known(key))
            {
                throw new ExternalError(DISP_E_MEMBERNOTFOUND);
            }
            const values = args.map(fromHost);
            return answer(engine, function*(){
                const variable = interp.globals.get(key);
                if (putting(flags))
                {
                    const value = values[values.length - 1];
                    const rest = values.slice(0, -1);
                    if (variable === undefined || variable.readOnly)
                    {
                        throw new ExternalError(DISP_E_MEMBERNOTFOUND);
                    }
                    interp.pin(value);
                    if (rest.length > 0)
                    {
                        yield* interp.storeIndexed(variable.value, rest, value,
                            (flags & DISPATCH_PROPERTYPUTREF) !== 0);
                    }
                    else
                    {
                        interp.assignRef(variable, value);
                    }
                    return undefined;
                }
                const value = variable !== undefined
                    ? yield* interp.applyValues(variable.value, values)
                    : yield* interp.callProc(/** @type {any} */ (interp.procs.get(key)), null,
                        values);
                interp.pin(value);
                return value;
            });
        },
        next: dispid=>nextOf(names, [...interp.globals.keys(), ...interp.procs.keys()], dispid),
        remove: ()=>false,
    };
}

/**
 * @typedef {Object} ScriptComHost
 * @property {import('../script/variant.js').GuestCom} com
 * @property {(object: import('../ole32/objects.js').ComObject, iid: string) => number} publish
 * @property {string} clsid  The class the script's objects say they are.
 */

/**
 * The COM crossing of one engine: the guest bridge its scripts reach
 * programs' objects through, and the server its own objects are reached
 * through.
 *
 * @param {VBScriptEngine} engine @param {ScriptComHost} host
 */
export function createScriptCom(engine, host){
    /** @type {import('../script/dispatch-server.js').DispatchServer} */
    let server;
    const bridge = createGuestBridge(host.com, {
        exportObject: value=>{
            if (value instanceof VBObject)
            {
                engine.interpreter.pin(value);
                return server.export(value, ()=>classTarget(engine, value));
            }
            if (value instanceof FunctionRef)
            {
                return server.export(value, ()=>functionTarget(engine, value));
            }
            if (value instanceof ExternalObject)
            {
                return server.export(value, ()=>externalTarget(value));
            }
            return 0;
        },
        findExported: pointer=>server.find(pointer),
        prepare: prepareVariant,
        adopt: adoptVariant,
    });
    server = createDispatchServer({ bridge, publish: host.publish, clsid: host.clsid });
    return { bridge, server };
}

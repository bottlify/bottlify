/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * JScript's objects as a program sees them through IDispatchEx, and the
 * program's objects as a script sees them: one engine's half of the COM
 * crossing, over the shared runtime's guest bridge and dispatch server.
 *
 * A member's DISPID is its place in the order the program first asked for
 * it, from 1; DISPID_VALUE is the object itself, so a script function a
 * program was handed is called through it. Names match with case, as
 * JScript's do, unless the program asks otherwise (fdexNameCaseInsensitive).
 * A script error inside a call the program made comes back to it as
 * DISP_E_EXCEPTION, the EXCEPINFO carrying JScript's number and description.
 */

import { drive } from '../script/drive.js';
import { externalTarget, createDispatchServer } from '../script/dispatch-server.js';
import {
    DISP_E_MEMBERNOTFOUND, E_FAIL, ExternalError, ExternalObject,
} from '../script/external.js';
import {
    DISPATCH_CONSTRUCT, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT,
    DISPATCH_PROPERTYPUTREF, DISPID_STARTENUM, DISPID_UNKNOWN, createGuestBridge,
} from '../script/guest-dispatch.js';
import { VBArrayObject } from './builtins-jscript.js';
import { JScriptError } from './engine.js';
import { enumerableNames } from './interpreter.js';
import { JSFunction, JSObject, ScriptAbort } from './objects.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('./engine.js').JScriptEngine} JScriptEngine
 * @typedef {import('../script/dispatch-server.js').DispatchTarget} DispatchTarget
 */

/** E_ABORT: a call the embedder stopped. */
const E_ABORT = 0x80004004 | 0;

/**
 * Runs what a program asked of a script object, its failure as the
 * program is told of one.
 *
 * @param {JScriptEngine} engine
 * @param {() => Generator<unknown, Value, unknown>} steps
 * @returns {Promise<Value>}
 */
async function answer(engine, steps){
    try
    {
        return await drive(steps());
    }
    catch (e){
        const failure = engine.failure(e, null);
        if (failure instanceof JScriptError)
        {
            throw new ExternalError(failure.number, failure.description, failure.source);
        }
        if (failure instanceof ScriptAbort)
        {
            throw new ExternalError(E_ABORT, failure.message, '');
        }
        throw failure instanceof ExternalError ? failure : new ExternalError(E_FAIL);
    }
}

/**
 * Invoke on a script object's member, or on the object itself (a null
 * name): a method called with the object as `this` unless the program named
 * one, a property read or written, a constructor called with `new`.
 *
 * @param {JScriptEngine} engine @param {JSObject} object @param {string | null} name
 * @param {number} flags @param {Value[]} args @param {Value} thisValue
 * @returns {Generator<unknown, Value, unknown>}
 */
function* invokeMember(engine, object, name, flags, args, thisValue){
    const realm = engine.realm;
    if ((flags & (DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF)) !== 0)
    {
        if (name === null)
        {
            throw realm.typeError(5008);
        }
        yield* engine.interpreter.putMember(object, name, args[args.length - 1]);
        return undefined;
    }
    const target = name === null ? object : object.get(name);
    if ((flags & DISPATCH_CONSTRUCT) !== 0)
    {
        return yield* realm.construct(target, args);
    }
    if ((flags & DISPATCH_METHOD) !== 0)
    {
        if (target instanceof JSFunction || target instanceof ExternalObject)
        {
            return yield* realm.call(target, thisValue === undefined
                ? (name === null ? undefined : object) : thisValue, args);
        }
        if ((flags & DISPATCH_PROPERTYGET) === 0 || args.length > 0)
        {
            throw realm.typeError(5002);
        }
    }
    if (name === null)
    {
        return yield* realm.toPrimitive(object, 'string');
    }
    return target;
}

/**
 * A script object's members as IDispatchEx numbers them.
 *
 * @param {JScriptEngine} engine @param {JSObject} object
 * @returns {DispatchTarget}
 */
export function objectTarget(engine, object){
    /** @type {string[]} */
    const names = [];
    /** @type {Map<string, number>} */
    const ids = new Map();
    /** @param {string} name @returns {number} */
    const idOf = name=>{
        let id = ids.get(name);
        if (id === undefined)
        {
            id = names.push(name);
            ids.set(name, id);
        }
        return id;
    };
    /** @param {string} name @returns {string | null} the spelling the object has */
    const caseless = name=>{
        const wanted = name.toLowerCase();
        for (let o = /** @type {JSObject | null} */ (object); o !== null; o = o.proto)
        {
            for (const [key] of o.ownNames())
            {
                if (key.toLowerCase() === wanted)
                {
                    return key;
                }
            }
        }
        return null;
    };
    return {
        dispId(name, caseInsensitive, ensure){
            if (object.has(name))
            {
                return idOf(name);
            }
            const spelled = caseInsensitive ? caseless(name) : null;
            if (spelled !== null)
            {
                return idOf(spelled);
            }
            if (ensure)
            {
                object.put(name, undefined);
                return idOf(name);
            }
            return DISPID_UNKNOWN;
        },
        nameOf: dispid=>names[dispid - 1] ?? null,
        invoke(dispid, flags, args, thisValue){
            const name = dispid === 0 ? null : names[dispid - 1];
            if (name === undefined)
            {
                throw new ExternalError(DISP_E_MEMBERNOTFOUND);
            }
            return answer(engine, ()=>invokeMember(engine, object, name, flags, args, thisValue));
        },
        next(dispid){
            const listed = enumerableNames(object);
            let from = 0;
            if (dispid !== DISPID_STARTENUM)
            {
                const at = listed.indexOf(names[dispid - 1] ?? '');
                if (at < 0)
                {
                    return DISPID_UNKNOWN;
                }
                from = at + 1;
            }
            return from < listed.length ? idOf(listed[from]) : DISPID_UNKNOWN;
        },
        remove(dispid){
            const name = names[dispid - 1];
            return name !== undefined && object.delete(name);
        },
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
 * @param {JScriptEngine} engine @param {ScriptComHost} host
 */
export function createScriptCom(engine, host){
    /** @type {import('../script/dispatch-server.js').DispatchServer} */
    let server;
    const bridge = createGuestBridge(host.com, {
        exportObject: value=>{
            if (value instanceof JSObject)
            {
                return server.export(value, ()=>objectTarget(engine, value));
            }
            if (value instanceof ExternalObject)
            {
                return server.export(value, ()=>externalTarget(value));
            }
            return 0;
        },
        findExported: pointer=>server.find(pointer),
        // A VBArray hands back the array it was made from.
        prepare: value=>(value instanceof VBArrayObject ? value.array : value),
    });
    server = createDispatchServer({ bridge, publish: host.publish, clsid: host.clsid });
    return { bridge, server };
}

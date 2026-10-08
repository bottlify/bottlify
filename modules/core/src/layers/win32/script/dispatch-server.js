/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A script's objects, as IDispatchEx objects a program can call: what an
 * active script's GetScriptDispatch hands out, and what a script function
 * passed to a program's method becomes.
 *
 * The object model is the language's: a {@link DispatchTarget} names its
 * members, numbers them and answers Invoke on them. This file is the COM
 * half -- the vtables of IDispatch and IDispatchEx (oaidl.h, dispex.h), the
 * DISPPARAMS read into values, the answer written into the result VARIANT,
 * a failure into the EXCEPINFO -- and keeps one COM object per script
 * object while the program holds it, so that the same object handed out
 * twice is the same pointer.
 */

import { createComObject } from '../ole32/objects.js';
import {
    DISP_E_EXCEPTION, DISP_E_MEMBERNOTFOUND, DISP_E_UNKNOWNNAME, E_NOTIMPL, ExternalError,
} from './external.js';
import {
    DISPATCH_CONSTRUCT, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT,
    DISPATCH_PROPERTYPUTREF, DISPID_PROPERTYPUT, DISPID_STARTENUM, DISPID_THIS, DISPID_UNKNOWN,
    DISPID_VALUE, IID_IDISPATCH, IID_IDISPATCHEX,
} from './guest-dispatch.js';
import { VARIANT_SIZE } from './variant.js';

/**
 * @typedef {import('./values.js').Value} Value
 * @typedef {import('../ole32/objects.js').ComObject} ComObject
 * @typedef {import('../ole32/objects.js').ComInterfaceDescriptor} ComInterfaceDescriptor
 */

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const E_POINTER = 0x80004003 | 0;
const DISP_E_BADINDEX = 0x8002000b | 0;
const DISP_E_NONAMEDARGS = 0x80020007 | 0;
const EXCEPINFO_SIZE = 32;
/** grfdex bits GetDispID reads. */
const FDEX_NAME_ENSURE = 0x2;
const FDEX_NAME_CASE_INSENSITIVE = 0x8;
/** How far a name a program passes is read. */
const MAX_NAME = 1024;

/**
 * A script object's members, as IDispatchEx numbers them. A failure is an
 * {@link ExternalError}; DISP_E_MEMBERNOTFOUND and DISP_E_UNKNOWNNAME are
 * answered as they are, anything else as an exception the EXCEPINFO
 * describes.
 *
 * @typedef {Object} DispatchTarget
 * @property {(name: string, caseInsensitive: boolean, ensure: boolean) => number} dispId
 *     DISPID_UNKNOWN for a name the object does not have (and, with
 *     `ensure`, cannot make).
 * @property {(dispid: number) => string | null} nameOf
 * @property {(dispid: number, flags: number, args: Value[], thisValue: Value | undefined)
 *     => Value | Promise<Value>} invoke
 *     The arguments first first; a put's value is the last of them.
 * @property {(dispid: number) => number} next  The member after `dispid`
 *     (DISPID_STARTENUM for the first), or DISPID_UNKNOWN past the last.
 * @property {(dispid: number) => boolean} remove
 */

/**
 * @typedef {Object} DispatchServerHost
 * @property {import('./guest-dispatch.js').GuestBridge} bridge
 *     How values cross: the same codec the script's guest calls use.
 * @property {(object: ComObject, iid: string) => number} publish
 *     The object's vtable for an interface, in guest memory (the bridge's
 *     publishInterface).
 * @property {string} clsid  The class the objects say they are.
 */

/** @param {DispatchServerHost} host */
export function createDispatchServer(host){
    const { bridge } = host;
    const { codec } = bridge;
    const memory = codec.memory;
    /** @type {WeakMap<object, ComObject>} the live COM object of each script object */
    const live = new WeakMap();
    /** @type {Map<number, object>} each published pointer's script object */
    const published = new Map();

    /** @param {ComObject} object @returns {DispatchTarget} */
    const targetOf = object=>object.state.target;

    /**
     * @param {number} out @param {number} value @returns {boolean} whether it was written
     */
    const writeOut = (out, value)=>{
        if ((out >>> 0) === 0)
        {
            return false;
        }
        memory.writeU32(out >>> 0, value);
        return true;
    };

    /**
     * Fills an EXCEPINFO with a failure: its source, description and code.
     *
     * @param {number} excepinfo @param {ExternalError} failure
     */
    const describe = async(excepinfo, failure)=>{
        if ((excepinfo >>> 0) === 0)
        {
            return;
        }
        memory.zero(excepinfo, EXCEPINFO_SIZE);
        memory.writeU32(excepinfo + 4, await codec.allocateBstr(failure.source));
        memory.writeU32(excepinfo + 8, await codec.allocateBstr(failure.description));
        memory.writeU32(excepinfo + 28, failure.number);
    };

    /**
     * InvokeEx: the DISPPARAMS read, the target asked, the answer written.
     *
     * @param {DispatchTarget} target @param {number} dispid @param {number} flags
     * @param {number} params @param {number} result @param {number} excepinfo
     * @returns {Promise<number>}
     */
    const invoke = async(target, dispid, flags, params, result, excepinfo)=>{
        // What the script does next calls the guest back on the caller's thread.
        bridge.enter();
        if ((params >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const variants = memory.u32(params);
        const namedIds = memory.u32(params + 4);
        const count = memory.u32(params + 8);
        const namedCount = memory.u32(params + 12);
        /** @type {Value} */
        let thisValue;
        /** @type {{ value: Value } | null} */
        let put = null;
        for (let j = 0; j < namedCount; j++)
        {
            const id = memory.i32(namedIds + j * 4);
            const value = await codec.read(variants + j * VARIANT_SIZE, false);
            if (id === DISPID_THIS)
            {
                thisValue = value;
            }
            else if (id === DISPID_PROPERTYPUT)
            {
                put = { value };
            }
            else
            {
                return DISP_E_NONAMEDARGS;
            }
        }
        const args = [];
        for (let k = 0; k < count - namedCount; k++)
        {
            args.push(await codec.read(variants + (count - 1 - k) * VARIANT_SIZE, false));
        }
        const putting = (flags & (DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF)) !== 0;
        if (putting && put !== null)
        {
            args.push(put.value);
        }
        try
        {
            const answer = await target.invoke(dispid, flags, args, thisValue);
            if ((result >>> 0) !== 0 && !putting)
            {
                await codec.write(result >>> 0, answer);
            }
            return S_OK;
        }
        catch (e){
            if (!(e instanceof ExternalError))
            {
                throw e;
            }
            if (e.number === DISP_E_MEMBERNOTFOUND || e.number === DISP_E_UNKNOWNNAME)
            {
                return e.number;
            }
            await describe(excepinfo >>> 0, e);
            return DISP_E_EXCEPTION;
        }
    };

    /** @type {ComInterfaceDescriptor} */
    const dispatch = {
        id: IID_IDISPATCH,
        methods: [
            /** HRESULT GetTypeInfoCount(UINT *pctinfo) */
            { name: 'GetTypeInfoCount', argBytes: 8,
                invoke: (_object, [out])=>(writeOut(out, 0) ? S_OK : E_INVALIDARG) },
            /** HRESULT GetTypeInfo(UINT, LCID, ITypeInfo **) -- a script object has none. */
            { name: 'GetTypeInfo', argBytes: 16,
                invoke: (_object, [, , out])=>{
                    writeOut(out, 0);
                    return DISP_E_BADINDEX;
                } },
            /**
             * HRESULT GetIDsOfNames(REFIID, LPOLESTR *rgszNames, UINT cNames, LCID,
             *     DISPID *rgDispId)
             *
             * A member's name, as JScript matches one, with case; the names
             * after it would name arguments, which a script function's are not.
             */
            { name: 'GetIDsOfNames', argBytes: 24,
                invoke: (object, [, names, count, , out])=>{
                    if ((names >>> 0) === 0 || (out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    let hr = S_OK;
                    for (let i = 0; i < (count >>> 0); i++)
                    {
                        const name = memory.readWideString(memory.u32((names >>> 0) + i * 4),
                            MAX_NAME);
                        const id = i === 0
                            ? targetOf(object).dispId(name, false, false) : DISPID_UNKNOWN;
                        memory.writeU32((out >>> 0) + i * 4, id >>> 0);
                        if (id === DISPID_UNKNOWN)
                        {
                            hr = DISP_E_UNKNOWNNAME;
                        }
                    }
                    return hr;
                } },
            /**
             * HRESULT Invoke(DISPID, REFIID, LCID, WORD wFlags, DISPPARAMS *,
             *     VARIANT *pVarResult, EXCEPINFO *, UINT *puArgErr)
             */
            { name: 'Invoke', argBytes: 36,
                invoke: (object, [id, , , flags, params, result, excepinfo])=>invoke(
                    targetOf(object), id | 0, flags & 0xffff, params, result, excepinfo) },
        ],
    };

    /** @type {ComInterfaceDescriptor} */
    const dispatchEx = {
        id: IID_IDISPATCHEX,
        methods: [
            ...dispatch.methods,
            /** HRESULT GetDispID(BSTR bstrName, DWORD grfdex, DISPID *pid) */
            { name: 'GetDispID', argBytes: 16,
                invoke: (object, [name, grfdex, out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    const id = targetOf(object).dispId(codec.readBstr(name >>> 0),
                        (grfdex & FDEX_NAME_CASE_INSENSITIVE) !== 0,
                        (grfdex & FDEX_NAME_ENSURE) !== 0);
                    memory.writeU32(out >>> 0, id >>> 0);
                    return id === DISPID_UNKNOWN ? DISP_E_UNKNOWNNAME : S_OK;
                } },
            /**
             * HRESULT InvokeEx(DISPID, LCID, WORD wFlags, DISPPARAMS *,
             *     VARIANT *pvarRes, EXCEPINFO *, IServiceProvider *)
             */
            { name: 'InvokeEx', argBytes: 32,
                invoke: (object, [id, , flags, params, result, excepinfo])=>invoke(
                    targetOf(object), id | 0, flags & 0xffff, params, result, excepinfo) },
            /** HRESULT DeleteMemberByName(BSTR, DWORD grfdex) */
            { name: 'DeleteMemberByName', argBytes: 12,
                invoke: (object, [name, grfdex])=>{
                    const target = targetOf(object);
                    const id = target.dispId(codec.readBstr(name >>> 0),
                        (grfdex & FDEX_NAME_CASE_INSENSITIVE) !== 0, false);
                    return id !== DISPID_UNKNOWN && target.remove(id) ? S_OK : S_FALSE;
                } },
            /** HRESULT DeleteMemberByDispID(DISPID) */
            { name: 'DeleteMemberByDispID', argBytes: 8,
                invoke: (object, [id])=>(targetOf(object).remove(id | 0) ? S_OK : S_FALSE) },
            /** HRESULT GetMemberProperties(DISPID, DWORD, DWORD *) */
            { name: 'GetMemberProperties', argBytes: 16,
                invoke: (_object, [, , out])=>{
                    writeOut(out, 0);
                    return E_NOTIMPL;
                } },
            /** HRESULT GetMemberName(DISPID, BSTR *) */
            { name: 'GetMemberName', argBytes: 12,
                invoke: async(object, [id, out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    const name = targetOf(object).nameOf(id | 0);
                    memory.writeU32(out >>> 0, name === null ? 0 : await codec.allocateBstr(name));
                    return name === null ? DISP_E_UNKNOWNNAME : S_OK;
                } },
            /** HRESULT GetNextDispID(DWORD grfdex, DISPID id, DISPID *pid) */
            { name: 'GetNextDispID', argBytes: 16,
                invoke: (object, [, id, out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    const next = targetOf(object).next(id | 0);
                    memory.writeU32(out >>> 0, next >>> 0);
                    return next === DISPID_UNKNOWN ? S_FALSE : S_OK;
                } },
            /** HRESULT GetNameSpaceParent(IUnknown **) */
            { name: 'GetNameSpaceParent', argBytes: 8,
                invoke: (_object, [out])=>{
                    writeOut(out, 0);
                    return E_NOTIMPL;
                } },
        ],
    };
    return {
        /**
         * The IDispatch pointer of a script object, carrying a reference for
         * whoever receives it; one COM object per script object while any
         * reference to it is held.
         *
         * @param {object} key  The script object.
         * @param {() => DispatchTarget} makeTarget
         * @param {string} [iid]  IID_IDispatch, or IID_IDispatchEx.
         * @returns {number}
         */
        export(key, makeTarget, iid = IID_IDISPATCH){
            let object = live.get(key);
            if (object && !object.destroyed)
            {
                object.addRef();
            }
            else
            {
                /** @type {number[]} */
                const pointers = [];
                object = createComObject(host.clsid, {
                    interfaces: [dispatch, dispatchEx],
                    state: { target: makeTarget(), key, pointers },
                    destroy: ()=>{
                        live.delete(key);
                        for (const pointer of pointers)
                        {
                            published.delete(pointer);
                        }
                    },
                });
                live.set(key, object);
            }
            const pointer = host.publish(object, iid) >>> 0;
            if (pointer === 0)
            {
                object.release();
                return 0;
            }
            if (!published.has(pointer))
            {
                published.set(pointer, key);
                object.state.pointers.push(pointer);
            }
            return pointer;
        },

        /**
         * The script object behind a pointer this server published, or
         * undefined.
         *
         * @param {number} pointer @returns {object | undefined}
         */
        find(pointer){
            return published.get(pointer >>> 0);
        },
    };
}

/** @typedef {ReturnType<typeof createDispatchServer>} DispatchServer */

/**
 * A DispatchTarget over an external object: a host object handed on to a
 * program, its members numbered as the program asks for them.
 *
 * @param {import('./external.js').ExternalObject} external @returns {DispatchTarget}
 */
export function externalTarget(external){
    /** @type {string[]} */
    const names = [];
    /** @param {string} name */
    const idOf = name=>{
        let index = names.indexOf(name);
        if (index < 0)
        {
            index = names.push(name) - 1;
        }
        return index + 1;
    };
    return {
        // Only a host object answers at once; a name it has to wait to know
        // is a name it does not have.
        dispId: name=>(external.has(name) === true ? idOf(name) : DISPID_UNKNOWN),
        nameOf: dispid=>names[dispid - 1] ?? null,
        invoke(dispid, flags, args){
            const name = dispid === DISPID_VALUE ? null : names[dispid - 1];
            if (name === undefined)
            {
                throw new ExternalError(DISP_E_MEMBERNOTFOUND);
            }
            if ((flags & (DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF)) !== 0)
            {
                return external.put(name, args[args.length - 1], args.slice(0, -1));
            }
            if ((flags & DISPATCH_METHOD) !== 0)
            {
                return external.call(name, args);
            }
            if ((flags & (DISPATCH_PROPERTYGET | DISPATCH_CONSTRUCT)) === DISPATCH_PROPERTYGET)
            {
                return external.get(name, args);
            }
            throw new ExternalError(DISP_E_MEMBERNOTFOUND);
        },
        next(dispid){
            const index = dispid === DISPID_STARTENUM ? 0 : dispid;
            return index < names.length ? index + 1 : DISPID_UNKNOWN;
        },
        remove: ()=>false,
    };
}

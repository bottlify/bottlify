/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CreateStdDispatch's object: an IDispatch over an object a program wrote,
 * answered by the ITypeInfo that describes it.
 *
 * What the caller gets back is the object's own IUnknown, and IDispatch is a
 * second interface it hands out -- a different pointer, as Windows' is. With
 * an outer object the IDispatch is an aggregate's: its QueryInterface, AddRef
 * and Release go to the outer one, which decides what else the whole answers
 * to, while the IUnknown handed back stays the inner, non-delegating one the
 * outer keeps. GetIDsOfNames and Invoke are the type information's, over the
 * program's `this`; the type information is the program's or ours, called
 * through its vtable either way.
 */

import { IUNKNOWN_METHODS } from '../ole32/objects.js';
import { readGuid, GUID_NULL } from '../ole32/guid.js';

export const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const DISP_E_BADINDEX = 0x8002000b | 0;
const DISP_E_UNKNOWNINTERFACE = 0x80020001 | 0;

/** ITypeInfo's vtable: AddRef, Release, GetIDsOfNames and Invoke. */
const TYPEINFO_ADDREF = 1;
const TYPEINFO_RELEASE = 2;
const TYPEINFO_GETIDSOFNAMES = 10;
const TYPEINFO_INVOKE = 11;

/**
 * @typedef {Object} StdDispatchHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(object: any, interfaceId: string) => number} publish
 * @property {(entry: number, args: number[]) => Promise<number>} call  into guest code
 * @property {(state: any, interfaces: Readonly<Record<string, readonly any[]>>,
 *     destroy?: () => void) => any} adapt
 */

/**
 * @typedef {Object} StdDispatchState
 * @property {number} outer  the aggregating object, or 0
 * @property {number} self  the program's object Invoke is made on
 * @property {number} typeInfo
 */

/** @param {StdDispatchHost} host */
export function createStdDispatchObjects(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        host.writeMemory(address, Uint8Array.from([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
    };
    /**
     * A method of a guest object, called through its vtable.
     *
     * @param {number} object @param {number} slot @param {number[]} args
     */
    const callMethod = (object, slot, args)=>
        host.call(readU32(readU32(object) + slot * 4), [object, ...args]);

    /** @param {number} riid */
    const isNull = riid=>riid !== 0 && readGuid(host, riid) === GUID_NULL;

    const DISPATCH_TAIL = Object.freeze([
        { name: 'GetTypeInfoCount', argBytes: 8,
            /** @param {unknown} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, 1);
                return S_OK;
            } },
        { name: 'GetTypeInfo', argBytes: 16,
            /** @param {{ state: StdDispatchState }} object @param {number[]} args */
            invoke: ({ state }, [index, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, 0);
                if ((index >>> 0) !== 0)
                {
                    return DISP_E_BADINDEX;
                }
                writeU32(out >>> 0, state.typeInfo);
                return callMethod(state.typeInfo, TYPEINFO_ADDREF, []).then(()=>S_OK);
            } },
        { name: 'GetIDsOfNames', argBytes: 24,
            /** @param {{ state: StdDispatchState }} object @param {number[]} args */
            invoke: ({ state }, [riid, names, count, , ids])=>(!isNull(riid >>> 0)
                ? DISP_E_UNKNOWNINTERFACE
                : callMethod(state.typeInfo, TYPEINFO_GETIDSOFNAMES,
                    [names >>> 0, count >>> 0, ids >>> 0])) },
        { name: 'Invoke', argBytes: 36,
            /** @param {{ state: StdDispatchState }} object @param {number[]} args */
            invoke: ({ state }, [dispid, riid, , flags, params, result, exception, argError])=>
                (!isNull(riid >>> 0) ? DISP_E_UNKNOWNINTERFACE
                    : callMethod(state.typeInfo, TYPEINFO_INVOKE, [state.self, dispid,
                        flags & 0xffff, params >>> 0, result >>> 0, exception >>> 0,
                        argError >>> 0])) },
    ]);

    // An aggregate's IDispatch answers for the outer object in all three.
    const DELEGATING = Object.freeze([
        { name: 'QueryInterface', argBytes: 12,
            /** @param {{ state: StdDispatchState }} object @param {number[]} args */
            invoke: ({ state }, [riid, out])=>callMethod(state.outer, 0, [riid >>> 0, out >>> 0]) },
        { name: 'AddRef', argBytes: 4,
            /** @param {{ state: StdDispatchState }} object */
            invoke: ({ state })=>callMethod(state.outer, 1, []) },
        { name: 'Release', argBytes: 4,
            /** @param {{ state: StdDispatchState }} object */
            invoke: ({ state })=>callMethod(state.outer, 2, []) },
    ]);

    const STANDALONE = Object.freeze({
        [IID_IDISPATCH]: Object.freeze([...IUNKNOWN_METHODS, ...DISPATCH_TAIL]),
    });
    const AGGREGATED = Object.freeze({
        [IID_IDISPATCH]: Object.freeze([...DELEGATING, ...DISPATCH_TAIL]),
    });

    return {
        /**
         * The inner IUnknown of a standard dispatch object, holding a
         * reference to the type information until its last one goes.
         *
         * @param {number} outer @param {number} self @param {number} typeInfo
         * @returns {Promise<number>}
         */
        create(outer, self, typeInfo){
            /** @type {StdDispatchState} */
            const state = { outer, self, typeInfo };
            const adapter = host.adapt(state, outer !== 0 ? AGGREGATED : STANDALONE,
                ()=>void callMethod(typeInfo, TYPEINFO_RELEASE, []));
            return callMethod(typeInfo, TYPEINFO_ADDREF, [])
                .then(()=>host.publish(adapter, '{00000000-0000-0000-C000-000000000046}') >>> 0);
        },
    };
}

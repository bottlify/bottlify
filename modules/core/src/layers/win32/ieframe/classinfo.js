/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The control's class as IProvideClassInfo::GetClassInfo describes it: the
 * coclass of shdocvw's type library, an ITypeInfo of its attributes, name
 * and the two interfaces it implements (its default and its event source).
 * There is no type library file behind it, so the interfaces themselves
 * are not described, and asking for them is said once.
 */

import { createComObject } from '../ole32/objects.js';
import { parseGuid } from '../ole32/guid.js';

const S_OK = 0;
const E_NOTIMPL = 0x80004001;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;
const TYPE_E_ELEMENTNOTFOUND = 0x8002802b;

export const IID_ITYPEINFO = '{00020401-0000-0000-C000-000000000046}';

/** TYPEATTR's size and the offsets written; the rest stays zero. */
const TYPEATTR_SIZE = 76;
const TKIND_COCLASS = 5;
/** TYPEFLAG_FCANCREATE | TYPEFLAG_FCONTROL: a control a container makes. */
const COCLASS_FLAGS = 0x2 | 0x20;
/** IMPLTYPEFLAG_FDEFAULT, and FSOURCE with it for the events. */
const IMPL_DEFAULT = 0x1;
const IMPL_SOURCE = 0x2;
/** MEMBERID_NIL, what TYPEATTR names no constructor with. */
const MEMBERID_NIL = -1;

/** ITypeInfo after IUnknown, with each method's stdcall bytes (`this` included). */
const METHODS = /** @type {[string, number][]} */ ([['GetTypeAttr', 8], ['GetTypeComp', 8],
    ['GetFuncDesc', 12], ['GetVarDesc', 12], ['GetNames', 20], ['GetRefTypeOfImplType', 12],
    ['GetImplTypeFlags', 12], ['GetIDsOfNames', 16], ['Invoke', 32], ['GetDocumentation', 24],
    ['GetDllEntry', 24], ['GetRefTypeInfo', 12], ['AddressOfMember', 16],
    ['CreateInstance', 16], ['GetMops', 12], ['GetContainingTypeLib', 12],
    ['ReleaseTypeAttr', 8], ['ReleaseFuncDesc', 8], ['ReleaseVarDesc', 8]]);

/**
 * @typedef {Object} ClassInfoHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 * @property {(text: string) => number} bstr  a BSTR the caller frees, or 0
 * @property {(api: string, detail: string) => void} sayOnce
 */

/**
 * @param {ClassInfoHost} host
 */
export function createClassInfo(host){
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));

    /** @type {Record<string, (object: any, args: number[]) => number>} */
    const IMPL = {
        GetTypeAttr: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const at = host.heap.allocate(TYPEATTR_SIZE) >>> 0;
            if (at === 0)
            {
                return E_OUTOFMEMORY;
            }
            const bytes = new Uint8Array(TYPEATTR_SIZE);
            const view = new DataView(bytes.buffer);
            bytes.set(/** @type {Uint8Array} */ (parseGuid(object.state.clsid)), 0);
            view.setInt32(24, MEMBERID_NIL, true);
            view.setInt32(28, MEMBERID_NIL, true);
            view.setUint32(40, TKIND_COCLASS, true);
            view.setUint16(48, 2, true);
            view.setUint16(52, 4, true);
            view.setUint16(54, COCLASS_FLAGS, true);
            view.setUint16(56, 1, true);
            view.setUint16(58, 1, true);
            host.writeMemory(at, bytes);
            putU32(out, at);
            return S_OK;
        },
        ReleaseTypeAttr: (_, [attr])=>{
            if ((attr >>> 0) !== 0)
            {
                host.heap.free(attr >>> 0);
            }
            return S_OK;
        },
        GetImplTypeFlags: (_, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if ((index >>> 0) > 1)
            {
                return TYPE_E_ELEMENTNOTFOUND;
            }
            putU32(out, index === 0 ? IMPL_DEFAULT : IMPL_DEFAULT | IMPL_SOURCE);
            return S_OK;
        },
        GetDocumentation: (object, [, name, doc, context, file])=>{
            for (const [at, text] of /** @type {[number, string][]} */ ([[name, object.state.name],
                [doc, object.state.doc]]))
            {
                if ((at >>> 0) !== 0)
                {
                    putU32(at, host.bstr(text));
                }
            }
            for (const at of [context, file])
            {
                if ((at >>> 0) !== 0)
                {
                    putU32(at, 0);
                }
            }
            return S_OK;
        },
    };

    /**
     * The ITypeInfo of one class, its reference held by the caller.
     *
     * @param {string} clsid @param {string} name @param {string} doc
     */
    return (clsid, name, doc)=>createComObject(IID_ITYPEINFO, {
        interfaces: [{
            id: IID_ITYPEINFO,
            methods: METHODS.map(([method, argBytes])=>({
                name: method, argBytes,
                invoke: IMPL[method] ?? (()=>{
                    host.sayOnce(`ITypeInfo::${method}`, 'the WebBrowser class\'s type is'
                        + ' described by its attributes alone: E_NOTIMPL');
                    return E_NOTIMPL;
                }),
            })),
        }],
        state: { clsid, name, doc },
    });
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IRecordInfo: a user-defined structure handled by its type description,
 * which is how a VT_RECORD variant or a SAFEARRAY of records owns, copies and
 * frees the strings, variants and interfaces inside one.
 *
 * Each field is worked by what its type owns. A BSTR is freed by a clear and
 * duplicated by a copy, a VARIANT goes through VariantClear and VariantCopy,
 * an interface pointer is released and AddRef'd, and a structure inside a
 * structure is worked field by field the same way; anything else is bytes.
 * A copy empties its target first, as Windows' does, so a target holding an
 * interface lets go of it before it takes the source's.
 */

import { IUNKNOWN_METHODS } from '../ole32/objects.js';
import { readGuid, writeGuid } from '../ole32/guid.js';
import {
    isImport, resolveReference, TKIND_DISPATCH, TKIND_INTERFACE, TKIND_RECORD,
} from './typelib.js';

export const IID_IRECORDINFO = '{0000002F-0000-0000-C000-000000000046}';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const TYPE_E_FIELDNOTFOUND = 0x80028017 | 0;
const DISP_E_BADVARTYPE = 0x80020008 | 0;

const VT_BSTR = 8;
const VT_DISPATCH = 9;
const VT_VARIANT = 12;
const VT_UNKNOWN = 13;
const VT_PTR = 26;
const VT_CARRAY = 28;
const VT_USERDEFINED = 29;

/** Bytes a field of each plain VARTYPE takes, for GetField. */
const SIZES = Object.freeze({ 2: 2, 3: 4, 4: 4, 5: 8, 6: 8, 7: 8, 10: 4, 11: 2, 16: 1, 17: 1,
    18: 2, 19: 4, 20: 8, 21: 8, 22: 4, 23: 4, 25: 4 });

/**
 * @typedef {import('./typelib.js').TypeLibrary} TypeLibrary
 * @typedef {import('./typelib.js').TypeInfoDescription} TypeInfoDescription
 * @typedef {import('./typelib.js').TypeDescription} TypeDescription
 */

/**
 * @typedef {Object} RecordInfoHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => boolean }} heap
 * @property {(object: any, interfaceId: string) => number} publish
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number>} call  into
 *           guest code, on the thread whose call this is
 * @property {() => unknown} thread  the thread whose call this is, read as a call begins
 * @property {(state: any, interfaces: Readonly<Record<string, readonly any[]>>,
 *     destroy?: () => void) => any} adapt
 * @property {(pvar: number, thread: unknown) => number | Promise<number>} clearVariant
 * @property {(dest: number, src: number, thread: unknown) => number | Promise<number>} copyVariant
 * @property {(bstr: number) => number} copyBstr  a new BSTR with the same bytes; 0 for none
 * @property {(bstr: number) => void} freeBstr
 * @property {(text: string) => number} allocateBstr
 * @property {(api: string, detail: string) => void} divergence
 */

/**
 * @typedef {Object} RecordState
 * @property {TypeLibrary} library
 * @property {TypeInfoDescription} description
 * @property {number} typeInfo  the ITypeInfo it was made from, which it holds
 */

/**
 * What a field's type asks of a clear and a copy.
 *
 * @typedef {{ kind: 'bytes' } | { kind: 'bstr' } | { kind: 'variant' } | { kind: 'interface' }
 *     | { kind: 'record', description: TypeInfoDescription }} FieldKind
 */

/** @param {RecordInfoHost} host */
export function createRecordInfoObjects(host){
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
     * @param {number} object @param {number} slot @param {number[]} args
     * @param {unknown} thread
     */
    const callMethod = (object, slot, args, thread)=>
        host.call(readU32(readU32(object) + slot * 4), [object, ...args], thread);

    /**
     * The type a reference names within the library, or null for an import.
     *
     * @param {TypeLibrary} library @param {number} hreftype
     * @returns {TypeInfoDescription | null}
     */
    const local = (library, hreftype)=>{
        const reference = resolveReference(library, hreftype);
        return reference && !isImport(reference) ? reference : null;
    };

    /**
     * @param {TypeLibrary} library @param {TypeDescription} type
     * @returns {FieldKind}
     */
    const kindOf = (library, type)=>{
        switch (type.vt)
        {
            case VT_BSTR: return { kind: 'bstr' };
            case VT_VARIANT: return { kind: 'variant' };
            case VT_UNKNOWN:
            case VT_DISPATCH: return { kind: 'interface' };
            case VT_PTR: {
                const target = type.element;
                const named = target?.vt === VT_USERDEFINED ? local(library, target.hreftype)
                    : null;
                return named && (named.kind === TKIND_INTERFACE || named.kind === TKIND_DISPATCH)
                    ? { kind: 'interface' } : { kind: 'bytes' };
            }
            case VT_USERDEFINED: {
                const named = local(library, type.hreftype);
                if (named?.alias)
                {
                    return kindOf(library, named.alias);
                }
                return named?.kind === TKIND_RECORD ? { kind: 'record', description: named }
                    : { kind: 'bytes' };
            }
            default: return { kind: 'bytes' };
        }
    };

    /**
     * Runs the steps one after another, a guest call at a time.
     *
     * @param {(() => unknown)[]} steps
     * @returns {Promise<number>}
     */
    const inOrder = steps=>steps.reduce((before, step)=>before.then(()=>step()),
        /** @type {Promise<unknown>} */ (Promise.resolve())).then(()=>S_OK);

    /**
     * The steps that empty a record in place.
     *
     * @param {TypeLibrary} library @param {TypeInfoDescription} description @param {number} at
     * @param {unknown} thread
     * @returns {(() => unknown)[]}
     */
    const clearSteps = (library, description, at, thread)=>description.variables.flatMap(variable=>{
        const address = at + variable.offset;
        const field = kindOf(library, variable.type);
        switch (field.kind)
        {
            case 'bstr': return [()=>{
                host.freeBstr(readU32(address));
                writeU32(address, 0);
            }];
            case 'variant': return [()=>host.clearVariant(address, thread)];
            case 'interface': return [()=>{
                const pointer = readU32(address);
                writeU32(address, 0);
                return pointer === 0 ? 0 : callMethod(pointer, 2, [], thread);
            }];
            case 'record': return clearSteps(library, field.description, address, thread);
            default: return [];
        }
    });

    /**
     * The steps that copy a record over an emptied one.
     *
     * @param {TypeLibrary} library @param {TypeInfoDescription} record
     * @param {number} from @param {number} to @param {unknown} thread
     * @returns {(() => unknown)[]}
     */
    const copySteps = (library, record, from, to, thread)=>record.variables.flatMap(variable=>{
        const source = from + variable.offset;
        const target = to + variable.offset;
        const field = kindOf(library, variable.type);
        switch (field.kind)
        {
            case 'bstr': return [()=>writeU32(target, host.copyBstr(readU32(source)))];
            case 'variant': return [()=>host.copyVariant(target, source, thread)];
            case 'interface': return [()=>{
                const pointer = readU32(source);
                writeU32(target, pointer);
                return pointer === 0 ? 0 : callMethod(pointer, 1, [], thread);
            }];
            case 'record': return copySteps(library, field.description, source, target,
                thread);
            default: return [()=>host.writeMemory(target,
                host.readMemory(source, sizeOf(library, variable.type)).slice())];
        }
    });

    /**
     * The bytes a field of plain data takes: what is between it and the next.
     *
     * @param {TypeLibrary} library @param {TypeDescription} type
     * @returns {number}
     */
    const sizeOf = (library, type)=>{
        if (type.vt === VT_CARRAY && type.array)
        {
            return type.array.bounds.reduce((total, bound)=>total * bound.elements, 1)
                * sizeOf(library, type.array.element);
        }
        if (type.vt === VT_USERDEFINED)
        {
            const named = local(library, type.hreftype);
            return named?.alias ? sizeOf(library, named.alias) : named?.instanceSize ?? 4;
        }
        return /** @type {Record<number, number>} */ (SIZES)[type.vt] ?? 4;
    };

    /** @param {RecordState} state @param {string} name */
    const fieldNamed = (state, name)=>state.description.variables
        .find(variable=>variable.name?.toLowerCase() === name.toLowerCase()) ?? null;

    /** @param {number} address */
    const readWide = address=>{
        let text = '';
        for (let at = address;; at += 2)
        {
            const bytes = host.readMemory(at, 2);
            const unit = bytes[0] | (bytes[1] << 8);
            if (unit === 0)
            {
                return text;
            }
            text += String.fromCharCode(unit);
        }
    };

    /** @typedef {{ state: RecordState }} Self */

    const METHODS = Object.freeze([
        ...IUNKNOWN_METHODS,
        { name: 'RecordInit', argBytes: 8,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [record])=>{
                if ((record >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(record >>> 0, new Uint8Array(state.description.instanceSize));
                return S_OK;
            } },
        { name: 'RecordClear', argBytes: 8,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [record])=>((record >>> 0) === 0 ? E_INVALIDARG
                : inOrder(clearSteps(state.library, state.description, record >>> 0,
                    host.thread()))) },
        { name: 'RecordCopy', argBytes: 12,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [from, to])=>{
                if ((from >>> 0) === 0 || (to >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.thread();
                return inOrder([
                    ...clearSteps(state.library, state.description, to >>> 0, thread),
                    ...copySteps(state.library, state.description, from >>> 0, to >>> 0,
                        thread)]);
            } },
        { name: 'GetGuid', argBytes: 8,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(host, out >>> 0,
                    state.description.guid ?? '{00000000-0000-0000-0000-000000000000}');
                return S_OK;
            } },
        { name: 'GetName', argBytes: 8,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const bstr = host.allocateBstr(state.description.name);
                writeU32(out >>> 0, bstr);
                return bstr === 0 ? E_OUTOFMEMORY : S_OK;
            } },
        { name: 'GetSize', argBytes: 8,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, state.description.instanceSize);
                return S_OK;
            } },
        { name: 'GetTypeInfo', argBytes: 8,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, state.typeInfo);
                return callMethod(state.typeInfo, 1, [], host.thread()).then(()=>S_OK);
            } },
        { name: 'GetField', argBytes: 16,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [record, name, out])=>{
                if ((record >>> 0) === 0 || (name >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const field = fieldNamed(state, readWide(name >>> 0));
                if (!field)
                {
                    return TYPE_E_FIELDNOTFOUND;
                }
                const vt = field.type.vt;
                const size = /** @type {Record<number, number>} */ (SIZES)[vt];
                const at = (record >>> 0) + field.offset;
                if (vt === VT_VARIANT)
                {
                    return host.copyVariant(out >>> 0, at, host.thread());
                }
                if (vt === VT_BSTR)
                {
                    const bytes = new Uint8Array(16);
                    bytes[0] = VT_BSTR;
                    host.writeMemory(out >>> 0, bytes);
                    writeU32((out >>> 0) + 8, host.copyBstr(readU32(at)));
                    return S_OK;
                }
                if (size === undefined)
                {
                    return DISP_E_BADVARTYPE;
                }
                const bytes = new Uint8Array(16);
                bytes[0] = vt;
                bytes.set(host.readMemory(at, size), 8);
                host.writeMemory(out >>> 0, bytes);
                return S_OK;
            } },
        ...['GetFieldNoCopy', 'PutField', 'PutFieldNoCopy'].map(name=>({
            name, argBytes: 20,
            /** @returns {number} */
            invoke: ()=>{
                host.divergence(`IRecordInfo::${name}`, 'not implemented');
                return 0x80004001 | 0;
            },
        })),
        { name: 'GetFieldNames', argBytes: 12,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [count, names])=>{
                if ((count >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const all = state.description.variables;
                if ((names >>> 0) === 0)
                {
                    writeU32(count >>> 0, all.length);
                    return S_OK;
                }
                const room = Math.min(readU32(count >>> 0), all.length);
                for (let index = 0; index < room; index++)
                {
                    writeU32((names >>> 0) + index * 4, host.allocateBstr(all[index].name ?? ''));
                }
                writeU32(count >>> 0, room);
                return S_OK;
            } },
        { name: 'IsMatchingType', argBytes: 8,
            /**
             * The same GUID is the same type, whatever its fields.
             *
             * @param {Self} object @param {number[]} args
             */
            invoke: ({ state }, [other])=>{
                if ((other >>> 0) === 0)
                {
                    return 0;
                }
                const slot = host.heap.allocate(16);
                if (slot === 0)
                {
                    return 0;
                }
                return callMethod(other >>> 0, 6, [slot], host.thread()).then(hr=>{
                    const same = (hr | 0) >= 0 && readGuid(host, slot)
                        === (state.description.guid ?? '{00000000-0000-0000-0000-000000000000}');
                    host.heap.free(slot);
                    return same ? 1 : 0;
                });
            } },
        { name: 'RecordCreate', argBytes: 4,
            /** @param {Self} object */
            invoke: ({ state })=>{
                const record = host.heap.allocate(Math.max(state.description.instanceSize, 1));
                if (record !== 0)
                {
                    host.writeMemory(record, new Uint8Array(state.description.instanceSize));
                }
                return record;
            } },
        { name: 'RecordCreateCopy', argBytes: 12,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [from, out])=>{
                if ((from >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const record = host.heap.allocate(Math.max(state.description.instanceSize, 1));
                if (record === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(record, new Uint8Array(state.description.instanceSize));
                writeU32(out >>> 0, record);
                return inOrder(copySteps(state.library, state.description, from >>> 0, record,
                    host.thread()));
            } },
        { name: 'RecordDestroy', argBytes: 8,
            /** @param {Self} object @param {number[]} args */
            invoke: ({ state }, [record])=>{
                if ((record >>> 0) === 0)
                {
                    return S_OK;
                }
                return inOrder(clearSteps(state.library, state.description, record >>> 0,
                    host.thread()))
                    .then(()=>{
                        host.heap.free(record >>> 0);
                        return S_OK;
                    });
            } },
    ]);

    const interfaces = Object.freeze({ [IID_IRECORDINFO]: METHODS });

    return {
        /**
         * An IRecordInfo for a record type, keeping the ITypeInfo it came
         * from for GetTypeInfo.
         *
         * @param {TypeLibrary} library @param {TypeInfoDescription} description
         * @param {number} typeInfo
         * @returns {Promise<number>}
         */
        create(library, description, typeInfo){
            /** @type {RecordState} */
            const state = { library, description, typeInfo };
            // No reference to the type information is taken: what a record
            // is worked by is the description, held here, and a call into the
            // guest from the last Release -- to give one back -- stops the
            // engine's turn.
            return Promise.resolve(host.publish(host.adapt(state, interfaces), IID_IRECORDINFO)
                >>> 0);
        },
    };
}

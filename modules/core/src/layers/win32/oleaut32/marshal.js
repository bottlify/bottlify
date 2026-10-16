/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The typelib marshaler: a call through an interface a type library
 * describes, taken out of one process's memory as values and put back into
 * another's.
 *
 * An interface registered with the universal marshaler -- `ProxyStubClsid32`
 * naming PSOAInterface or PSDispatch, which RegisterTypeLib writes for every
 * dual and [oleautomation] interface -- has no proxy of its own: its type
 * library is the whole description of how its calls travel. This file reads
 * that description into wire types and moves a call along it in four steps:
 * the caller's arguments become a request, the request becomes the callee's
 * arguments, the callee's [out] parameters become a reply, and the reply is
 * written through the caller's pointers.
 *
 * Nothing here knows how the two processes talk. A value that is itself an
 * interface pointer crosses as whatever the side's `exportInterface` answers
 * and comes back through its `importInterface`: that is the channel's
 * business, in ole32.
 *
 * The rules of ownership are COM's. An [in] value belongs to the caller and
 * is freed by the stub once the call returns; an [out] value belongs to
 * whoever receives it, so the stub frees its copy after taking it apart and
 * the caller's side is written with a fresh one; an [in, out] value is freed
 * on the caller's side before the new one is written over it.
 */

import { HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';
import {
    TKIND_ALIAS, TKIND_COCLASS, TKIND_DISPATCH, TKIND_ENUM, TKIND_INTERFACE, TKIND_RECORD,
    VT_BOOL, VT_BSTR, VT_CARRAY, VT_I1, VT_I2, VT_I4, VT_PTR, VT_R4, VT_R8, VT_SAFEARRAY,
    VT_UI1, VT_UI2, VT_UI4, VT_USERDEFINED, isImport, resolveReference,
} from './typelib.js';
import { STDOLE_GUID, STDOLE_TYPES, parseTypeLibrary } from './sltg.js';
import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';
import { findResource } from '../../loader/internal/resources.js';
import { decodeAnsi } from '../kernel32/locale.js';

export const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
export const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
export const IID_ICLASSFACTORY = '{00000001-0000-0000-C000-000000000046}';

/** The proxy/stub classes whose interfaces a type library describes. */
const PSOAINTERFACE = '{00020424-0000-0000-C000-000000000046}';
const PSDISPATCH = '{00020420-0000-0000-C000-000000000046}';

const VT_EMPTY = 0;
const VT_NULL = 1;
const VT_CY = 6;
const VT_DATE = 7;
const VT_DISPATCH = 9;
const VT_ERROR = 10;
const VT_VARIANT = 12;
const VT_UNKNOWN = 13;
const VT_DECIMAL = 14;
const VT_I8 = 20;
const VT_UI8 = 21;
const VT_INT = 22;
const VT_UINT = 23;
const VT_VOID = 24;
const VT_HRESULT = 25;
const VT_LPSTR = 30;
const VT_LPWSTR = 31;
const VT_ARRAY = 0x2000;
const VT_BYREF = 0x4000;
const VT_TYPEMASK = 0xfff;

const TYPEFLAG_FDUAL = 0x40;

export const PARAMFLAG_FIN = 1;
export const PARAMFLAG_FOUT = 2;

const FADF_BSTR = 0x100;
const FADF_UNKNOWN = 0x200;
const FADF_DISPATCH = 0x400;
const FADF_VARIANT = 0x800;

const VARIANT_BYTES = 16;
const SAFEARRAY_BOUNDS = 16;
const LONGEST_STRING = 0x10000;

/**
 * How one value travels. A `word` is copied as its bytes; everything else
 * points somewhere, and what it points at crosses in its place.
 *
 * @typedef {Object} WireType
 * @property {'word' | 'bstr' | 'lpstr' | 'lpwstr' | 'variant' | 'interface' | 'pointer'
 *     | 'record' | 'safearray' | 'array' | 'dispparams' | 'null' | 'unsupported'} kind
 * @property {number} [bytes]            A word's or a record's size.
 * @property {string | null} [iid]       An interface's, when the type says.
 * @property {number} [iidFrom]          Else the parameter whose GUID names it.
 * @property {WireType} [to]             What a pointer or an array holds.
 * @property {{ offset: number, type: WireType }[]} [fields]
 *           The parts of a record that are not plain bytes.
 * @property {number} [countFrom]        The parameter that counts an array.
 * @property {string} [why]              Why an unsupported type is one.
 */

/**
 * @typedef {Object} ParameterWire
 * @property {string} name
 * @property {number} flags   PARAMFLAG_*.
 * @property {WireType} type
 */

/**
 * @typedef {Object} MethodDescription
 * @property {string} name
 * @property {number} slot
 * @property {ParameterWire[]} parameters
 * @property {string | null} unsupported  Why the method cannot cross, or null.
 */

/**
 * @typedef {Object} InterfaceDescription
 * @property {string} iid
 * @property {string} name
 * @property {(MethodDescription | null)[]} methods
 *           By vtable slot. IUnknown's three are null: a proxy answers them.
 */

/**
 * One process's memory and the services a value crossing into or out of it
 * needs there.
 *
 * @typedef {Object} MarshalSide
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate       Task memory.
 * @property {(address: number) => void} free
 * @property {(bytes: Uint8Array) => number} allocateBstr  From its content.
 * @property {(bstr: number) => void} freeBstr
 * @property {(vt: number, bounds: { elements: number, lower: number }[]) => number}
 *           createSafeArray  SafeArrayCreate, the bounds leftmost first.
 * @property {(array: number) => unknown} destroySafeArray  Answered once the
 *     array has released what it holds, which may be a call into the program.
 * @property {(pointer: number, iid: string, transfer: boolean) => Promise<any>}
 *           exportInterface  An interface pointer as the other side will know
 *           it. With `transfer`, the reference it carries goes with it;
 *           without, the channel takes one of its own.
 * @property {(reference: any, iid: string) => Promise<number>} importInterface
 *           A reference from the other side as a pointer here, holding one
 *           reference for whoever receives it.
 * @property {(pointer: number) => Promise<unknown>} releaseInterface
 */

/**
 * @typedef {Object} WireContext
 * @property {boolean} transfer   Whether an interface crossing takes its reference.
 * @property {(parameter: number) => string | null} iidOf
 *           The GUID a parameter holds, for an interface typed by another one.
 * @property {(parameter: number) => number} countOf
 * @property {{ type: WireType, address: number }[]} owned
 *           Blocks made along the way that no by-value word points at: the
 *           referent of a VT_BYREF variant.
 */

/** @param {number} bytes */
const word = bytes=>/** @type {WireType} */ ({ kind: 'word', bytes });
/** @param {string} why */
const unsupported = why=>/** @type {WireType} */ ({ kind: 'unsupported', why });
/** @param {string | null} iid */
const iface = iid=>/** @type {WireType} */ ({ kind: 'interface', iid });
/** @param {WireType} to */
const pointer = to=>/** @type {WireType} */ ({ kind: 'pointer', to });

/** A GUID passed by reference, as REFIID and REFCLSID are. */
const REFGUID = pointer({ kind: 'record', bytes: 16, fields: [] });

/**
 * EXCEPINFO: three strings, and two words that point into the process that
 * filled it in and cross as nothing.
 */
const EXCEPINFO = /** @type {WireType} */ ({ kind: 'record', bytes: 32, fields: [
    { offset: 4, type: { kind: 'bstr' } },
    { offset: 8, type: { kind: 'bstr' } },
    { offset: 12, type: { kind: 'bstr' } },
    { offset: 20, type: { kind: 'null' } },
    { offset: 24, type: { kind: 'null' } },
] });

/** The type of the value a VARTYPE names, inside a variant or an array. */
/** @param {number} vt @returns {WireType | null} */
function typeOfVartype(vt){
    switch (vt)
    {
        case VT_I1:
        case VT_UI1:
            return word(1);
        case VT_I2:
        case VT_UI2:
        case VT_BOOL:
            return word(2);
        case VT_I4:
        case VT_UI4:
        case VT_INT:
        case VT_UINT:
        case VT_ERROR:
        case VT_R4:
        case VT_HRESULT:
            return word(4);
        case VT_R8:
        case VT_DATE:
        case VT_CY:
        case VT_I8:
        case VT_UI8:
            return word(8);
        case VT_BSTR:
            return { kind: 'bstr' };
        case VT_UNKNOWN:
            return iface(IID_IUNKNOWN);
        case VT_DISPATCH:
            return iface(IID_IDISPATCH);
        case VT_VARIANT:
            return { kind: 'variant' };
        default:
            return null;
    }
}

/**
 * A value's size where it is stored.
 *
 * @param {WireType} type
 */
export function sizeOf(type){
    switch (type.kind)
    {
        case 'word':
        case 'record':
            return /** @type {number} */ (type.bytes);
        case 'variant':
            return VARIANT_BYTES;
        default:
            return 4;
    }
}

/** A value's size on the stack: whole words, a byte or a short widened to one. */
/** @param {WireType} type */
const stackSize = type=>(sizeOf(type) + 3) & ~3;

/** @param {Uint8Array} bytes @param {number} at */
const u16 = (bytes, at)=>bytes[at] | (bytes[at + 1] << 8);
/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
    | (bytes[at + 3] << 24)) >>> 0;
/** @param {number} value */
const le32 = value=>Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    (value >>> 24) & 0xff);
/** @param {Uint8Array} bytes @param {number} at @param {number} value */
const put32 = (bytes, at, value)=>bytes.set(le32(value), at);

/** @param {number[]} words */
function bytesOfWords(words){
    const bytes = new Uint8Array(words.length * 4);
    words.forEach((value, index)=>put32(bytes, index * 4, value >>> 0));
    return bytes;
}

/** @param {Uint8Array} bytes */
function wordsOfBytes(bytes){
    const words = [];
    for (let at = 0; at < bytes.length; at += 4)
    {
        words.push(u32(bytes, at));
    }
    return words;
}

/**
 * The wire types of one library's types.
 *
 * @param {import('./typelib.js').TypeLibrary} library
 */
function libraryTypes(library){
    /**
     * @param {import('./typelib.js').TypeDescription} type
     * @param {Set<number>} [seen]  References being resolved, against a cycle.
     * @returns {WireType}
     */
    const wireOf = (type, seen = new Set())=>{
        const plain = typeOfVartype(type.vt);
        if (plain)
        {
            return plain;
        }
        switch (type.vt)
        {
            case VT_LPSTR:
                return { kind: 'lpstr' };
            case VT_LPWSTR:
                return { kind: 'lpwstr' };
            case VT_SAFEARRAY:
                return { kind: 'safearray' };
            case VT_PTR: {
                if (!type.element)
                {
                    return unsupported('a pointer to nothing');
                }
                const to = wireOf(type.element, seen);
                // An interface is named by its type; a pointer to it is the
                // interface pointer itself, the one word that crosses.
                if (to.kind === 'record' && to.iid !== undefined)
                {
                    return iface(to.iid);
                }
                if (to.kind === 'unsupported')
                {
                    return to;
                }
                return pointer(to);
            }
            case VT_CARRAY: {
                const array = type.array;
                const element = array ? wireOf(array.element, seen) : null;
                if (!array || !element || element.kind !== 'word')
                {
                    return unsupported('a C array of anything but numbers');
                }
                const count = array.bounds.reduce((product, bound)=>product * bound.elements, 1);
                return { kind: 'record', bytes: count * /** @type {number} */ (element.bytes),
                    fields: [] };
            }
            case VT_USERDEFINED:
                return userDefined(type.hreftype, seen);
            case VT_VOID:
                return unsupported('an untyped pointer');
            default:
                return unsupported(`VARTYPE ${type.vt}`);
        }
    };

    /**
     * A named type. An interface comes back as a record carrying its IID --
     * never a value on its own, only behind the pointer that makes it one.
     *
     * @param {number} hreftype @param {Set<number>} seen
     * @returns {WireType}
     */
    const userDefined = (hreftype, seen)=>{
        const reference = resolveReference(library, hreftype);
        if (!reference || seen.has(hreftype))
        {
            return unsupported(`an unresolved type (${hreftype})`);
        }
        if (isImport(reference))
        {
            const stdole = reference.library.guid?.toUpperCase() === STDOLE_GUID
                ? STDOLE_TYPES[reference.typeIndex] : undefined;
            if (stdole?.name === 'GUID')
            {
                return { kind: 'record', bytes: 16, fields: [] };
            }
            const iid = reference.guid ?? stdole?.guid ?? null;
            if ((reference.kind === TKIND_INTERFACE || reference.kind === TKIND_DISPATCH) && iid)
            {
                return { kind: 'record', bytes: 4, iid };
            }
            return unsupported(`a type of another library (${reference.library.name})`);
        }
        const within = new Set(seen).add(hreftype);
        switch (reference.kind)
        {
            case TKIND_ENUM:
                return word(4);
            case TKIND_ALIAS:
                return reference.alias
                    ? wireOf(reference.alias, within)
                    : unsupported(`the alias ${reference.name}`);
            case TKIND_INTERFACE:
            case TKIND_DISPATCH:
                return { kind: 'record', bytes: 4, iid: reference.guid };
            case TKIND_COCLASS: {
                const primary = reference.implementedTypes.find(entry=>(entry.flags & 1) !== 0)
                    ?? reference.implementedTypes[0];
                return primary
                    ? userDefined(primary.hreftype, within)
                    : unsupported(`the coclass ${reference.name}`);
            }
            case TKIND_RECORD: {
                /** @type {{ offset: number, type: WireType }[]} */
                const fields = [];
                for (const variable of reference.variables)
                {
                    const type = wireOf(variable.type, within);
                    if (type.kind === 'unsupported')
                    {
                        return unsupported(`${reference.name}.${variable.name}: ${type.why}`);
                    }
                    if (type.kind !== 'word' && !(type.kind === 'record' && !type.fields?.length))
                    {
                        fields.push({ offset: variable.offset, type });
                    }
                }
                return { kind: 'record', bytes: reference.instanceSize, fields };
            }
            default:
                return unsupported(`the type ${reference.name}`);
        }
    };

    return { wireOf };
}

/** IUnknown's three slots, which a proxy answers itself. */
const UNKNOWN_SLOTS = 3;

/**
 * IDispatch's four, as oleaut32's own proxy sends them. GetTypeInfo's
 * ITypeInfo has a proxy of its own and no type library, so it does not cross.
 *
 * @type {MethodDescription[]}
 */
const DISPATCH_METHODS = [
    { name: 'GetTypeInfoCount', slot: 3, unsupported: null, parameters: [
        { name: 'pctinfo', flags: PARAMFLAG_FOUT, type: pointer(word(4)) },
    ] },
    { name: 'GetTypeInfo', slot: 4, unsupported: 'ITypeInfo crosses through its own proxy',
        parameters: [] },
    { name: 'GetIDsOfNames', slot: 5, unsupported: null, parameters: [
        { name: 'riid', flags: PARAMFLAG_FIN, type: REFGUID },
        { name: 'rgszNames', flags: PARAMFLAG_FIN,
            type: { kind: 'array', to: { kind: 'lpwstr' }, countFrom: 2 } },
        { name: 'cNames', flags: PARAMFLAG_FIN, type: word(4) },
        { name: 'lcid', flags: PARAMFLAG_FIN, type: word(4) },
        { name: 'rgDispId', flags: PARAMFLAG_FOUT,
            type: { kind: 'array', to: word(4), countFrom: 2 } },
    ] },
    { name: 'Invoke', slot: 6, unsupported: null, parameters: [
        { name: 'dispIdMember', flags: PARAMFLAG_FIN, type: word(4) },
        { name: 'riid', flags: PARAMFLAG_FIN, type: REFGUID },
        { name: 'lcid', flags: PARAMFLAG_FIN, type: word(4) },
        { name: 'wFlags', flags: PARAMFLAG_FIN, type: word(2) },
        { name: 'pDispParams', flags: PARAMFLAG_FIN | PARAMFLAG_FOUT,
            type: { kind: 'dispparams' } },
        { name: 'pVarResult', flags: PARAMFLAG_FOUT, type: pointer({ kind: 'variant' }) },
        { name: 'pExcepInfo', flags: PARAMFLAG_FOUT, type: pointer(EXCEPINFO) },
        { name: 'puArgErr', flags: PARAMFLAG_FOUT, type: pointer(word(4)) },
    ] },
];

/** The interfaces every proxy knows without a library. */
/** @type {Map<string, InterfaceDescription>} */
const BUILT_IN = new Map([
    [IID_IUNKNOWN, { iid: IID_IUNKNOWN, name: 'IUnknown', methods: [null, null, null] }],
    [IID_IDISPATCH, { iid: IID_IDISPATCH, name: 'IDispatch',
        methods: [null, null, null, ...DISPATCH_METHODS] }],
    [IID_ICLASSFACTORY, { iid: IID_ICLASSFACTORY, name: 'IClassFactory', methods: [
        null, null, null,
        { name: 'CreateInstance', slot: 3, unsupported: null, parameters: [
            { name: 'pUnkOuter', flags: PARAMFLAG_FIN, type: iface(IID_IUNKNOWN) },
            { name: 'riid', flags: PARAMFLAG_FIN, type: REFGUID },
            { name: 'ppvObject', flags: PARAMFLAG_FOUT,
                type: pointer({ kind: 'interface', iid: null, iidFrom: 1 }) },
        ] },
        { name: 'LockServer', slot: 4, unsupported: null, parameters: [
            { name: 'fLock', flags: PARAMFLAG_FIN, type: word(4) },
        ] },
    ] }],
]);

/**
 * An interface's methods from the type that describes it: its bases' first,
 * then its own, each at the slot its vtable offset names.
 *
 * @param {import('./typelib.js').TypeLibrary} library
 * @param {import('./typelib.js').TypeInfoDescription} type
 * @returns {InterfaceDescription}
 */
export function describeType(library, type){
    const { wireOf } = libraryTypes(library);
    /** @type {(MethodDescription | null)[]} */
    const methods = [];

    /** @param {import('./typelib.js').TypeInfoDescription} described @param {number} depth */
    const add = (described, depth)=>{
        const base = described.implementedTypes[0];
        const reference = base ? resolveReference(library, base.hreftype) : null;
        if (reference && isImport(reference))
        {
            const guid = reference.guid ?? (reference.library.guid?.toUpperCase() === STDOLE_GUID
                ? STDOLE_TYPES[reference.typeIndex]?.guid : null);
            BUILT_IN.get(guid ?? '')?.methods.forEach((method, slot)=>{
                methods[slot] = method;
            });
        }
        else if (reference && depth < 16)
        {
            add(reference, depth + 1);
        }
        const dual = (described.flags & TYPEFLAG_FDUAL) !== 0;
        if (described.kind === TKIND_DISPATCH && !dual)
        {
            // A dispinterface has no vtable of its own: it is IDispatch.
            BUILT_IN.get(IID_IDISPATCH)?.methods.forEach((method, slot)=>{
                methods[slot] = method;
            });
            return;
        }
        for (const fn of described.functions)
        {
            const slot = fn.vtableOffset >>> 2;
            const parameters = fn.parameters.map((parameter, index)=>({
                name: parameter.name ?? `argument ${index}`,
                flags: (parameter.flags & (PARAMFLAG_FIN | PARAMFLAG_FOUT)) || PARAMFLAG_FIN,
                type: wireOf(parameter.type),
            }));
            const refused = parameters.find(parameter=>parameter.type.kind === 'unsupported'
                || (parameter.type.kind === 'record' && parameter.type.iid !== undefined));
            methods[slot] = {
                name: fn.name ?? `slot ${slot}`,
                slot,
                parameters,
                unsupported: refused
                    ? `${refused.name}: ${refused.type.why ?? 'an interface passed by value'}`
                    : fn.callingConvention !== 4 ? 'not stdcall' : null,
            };
        }
    };
    add(type, 0);
    for (let slot = 0; slot < UNKNOWN_SLOTS; slot++)
    {
        methods[slot] = null;
    }
    return { iid: type.guid ?? '', name: type.name, methods };
}

/**
 * @typedef {Object} CatalogHost
 * @property {{ root: (id: number) => any, open: (key: any, path: string) => any,
 *     getValue: (key: any, name: string) => { data: Uint8Array } | null,
 *     subkeys?: (key: any) => string[] }} [hive]
 * @property {(path: string) => Uint8Array | Promise<Uint8Array> | null} readFile
 */

/**
 * Which interfaces a process can send across, and how: the built-in three,
 * and every one the registry says a type library describes.
 *
 * @param {CatalogHost} host
 */
export function createInterfaceCatalog(host){
    /** @type {Map<string, Promise<InterfaceDescription | null>>} */
    const known = new Map();
    /** @type {Map<string, Promise<import('./typelib.js').TypeLibrary | null>>} */
    const libraries = new Map();

    /** @param {string} path @returns {string | null} */
    const text = path=>{
        const hive = host.hive;
        const root = hive?.root(HKEY_CLASSES_ROOT);
        const slash = path.lastIndexOf('|');
        const key = root ? hive?.open(root, path.slice(0, slash)) : null;
        const value = key ? hive?.getValue(key, path.slice(slash + 1)) : null;
        if (!value)
        {
            return null;
        }
        const end = value.data.indexOf(0);
        return decodeAnsi(end < 0 ? value.data : value.data.subarray(0, end));
    };

    /** @param {string} file @returns {Promise<import('./typelib.js').TypeLibrary | null>} */
    const library = file=>{
        const cached = libraries.get(file.toLowerCase());
        if (cached)
        {
            return cached;
        }
        const loading = (async()=>{
            const indexed = /^(.*)\\(\d+)$/.exec(file);
            let bytes = await host.readFile(file);
            let index = 1;
            if (!bytes && indexed)
            {
                bytes = await host.readFile(indexed[1]);
                index = Number(indexed[2]);
            }
            if (!bytes)
            {
                return null;
            }
            if (bytes[0] === 0x4d && bytes[1] === 0x5a)
            {
                const image = parsePe(bytes);
                const found = findResource(bytes, image, 'TYPELIB', index);
                if (!found)
                {
                    return null;
                }
                const at = rvaToFileOffset(image, found.rva);
                bytes = bytes.subarray(at, at + found.size);
            }
            return parseTypeLibrary(bytes);
        })().catch(()=>null);
        libraries.set(file.toLowerCase(), loading);
        return loading;
    };

    /**
     * @param {string} iid
     * @returns {Promise<InterfaceDescription | null>}
     */
    const lookUp = async iid=>{
        const proxy = text(`Interface\\${iid}\\ProxyStubClsid32|`)
            ?? text(`Interface\\${iid}\\ProxyStubClsid|`);
        const libid = text(`Interface\\${iid}\\TypeLib|`);
        if (!libid || (proxy && ![PSOAINTERFACE, PSDISPATCH].includes(proxy.toUpperCase())))
        {
            return null;
        }
        const version = text(`Interface\\${iid}\\TypeLib|Version`) ?? '1.0';
        const file = ['0', '9', '409'].map(lcid=>
            text(`TypeLib\\${libid}\\${version}\\${lcid}\\win32|`)).find(Boolean);
        const loaded = file ? await library(file) : null;
        const type = loaded?.typeInfos.find(candidate=>
            candidate.guid?.toUpperCase() === iid.toUpperCase());
        return loaded && type ? describeType(loaded, type) : null;
    };

    return {
        /**
         * How calls through an interface travel; null when nothing describes it.
         *
         * @param {string} iid  Canonical form.
         * @returns {Promise<InterfaceDescription | null>}
         */
        describe(iid){
            const builtIn = BUILT_IN.get(iid);
            if (builtIn)
            {
                return Promise.resolve(builtIn);
            }
            let found = known.get(iid);
            if (!found)
            {
                found = lookUp(iid);
                known.set(iid, found);
            }
            return found;
        },
    };
}

/**
 * Values in and out of one side's memory.
 *
 * @param {MarshalSide} side
 */
export function createWire(side){
    /** @param {number} address @param {boolean} wide */
    const readString = (address, wide)=>{
        const unit = wide ? 2 : 1;
        const chunk = 256;
        /** @type {number[]} */
        const out = [];
        for (let at = address; out.length < LONGEST_STRING; at += chunk)
        {
            const bytes = side.readMemory(at, chunk);
            for (let index = 0; index + unit <= bytes.length; index += unit)
            {
                if (bytes[index] === 0 && (!wide || bytes[index + 1] === 0))
                {
                    return Uint8Array.from(out);
                }
                out.push(bytes[index]);
                if (wide)
                {
                    out.push(bytes[index + 1]);
                }
            }
        }
        return Uint8Array.from(out);
    };

    /** @param {number} address */
    const readBstr = address=>{
        const length = u32(side.readMemory(address - 4, 4), 0);
        return side.readMemory(address, length).slice();
    };

    /**
     * The element type of an array that says what it holds.
     *
     * @param {number} features @param {number} elementBytes
     * @returns {number}
     */
    const vartypeOfArray = (features, elementBytes)=>{
        if (features & FADF_BSTR)
        {
            return VT_BSTR;
        }
        if (features & FADF_UNKNOWN)
        {
            return VT_UNKNOWN;
        }
        if (features & FADF_DISPATCH)
        {
            return VT_DISPATCH;
        }
        if (features & FADF_VARIANT)
        {
            return VT_VARIANT;
        }
        return ({ 1: VT_UI1, 2: VT_I2, 4: VT_I4, 8: VT_R8 })[elementBytes] ?? VT_EMPTY;
    };

    /**
     * A stored value, taken out of memory.
     *
     * @param {WireType} type @param {Uint8Array} bytes  The value as stored.
     * @param {WireContext} context
     * @returns {Promise<any>}
     */
    const decode = async(type, bytes, context)=>{
        switch (type.kind)
        {
            case 'word':
                return bytes.slice(0, type.bytes);
            case 'null':
                return null;
            case 'bstr': {
                const at = u32(bytes, 0);
                return at === 0 ? null : readBstr(at);
            }
            case 'lpstr':
            case 'lpwstr': {
                const at = u32(bytes, 0);
                return at === 0 ? null : readString(at, type.kind === 'lpwstr');
            }
            case 'interface': {
                const at = u32(bytes, 0);
                if (at === 0)
                {
                    return null;
                }
                const iid = type.iid ?? context.iidOf(type.iidFrom ?? -1) ?? IID_IUNKNOWN;
                return { iid, reference: await side.exportInterface(at, iid, context.transfer) };
            }
            case 'pointer': {
                const at = u32(bytes, 0);
                const to = /** @type {WireType} */ (type.to);
                return at === 0
                    ? null
                    : { value: await decode(to, side.readMemory(at, sizeOf(to)), context) };
            }
            case 'record': {
                const raw = bytes.slice(0, type.bytes);
                const fields = [];
                for (const field of type.fields ?? [])
                {
                    fields.push(await decode(field.type,
                        raw.subarray(field.offset, field.offset + sizeOf(field.type)), context));
                }
                return { raw, fields };
            }
            case 'array': {
                const at = u32(bytes, 0);
                const to = /** @type {WireType} */ (type.to);
                if (at === 0)
                {
                    return null;
                }
                const count = context.countOf(type.countFrom ?? -1);
                const elements = [];
                for (let index = 0; index < count; index++)
                {
                    elements.push(await decode(to,
                        side.readMemory(at + index * sizeOf(to), sizeOf(to)), context));
                }
                return elements;
            }
            case 'variant':
                return decodeVariant(bytes, context);
            case 'safearray':
                return decodeArray(u32(bytes, 0), context);
            case 'dispparams': {
                const at = u32(bytes, 0);
                if (at === 0)
                {
                    return null;
                }
                const head = side.readMemory(at, 16);
                const count = u32(head, 8);
                const named = u32(head, 12);
                const args = [];
                for (let index = 0; index < count; index++)
                {
                    args.push(await decodeVariant(
                        side.readMemory(u32(head, 0) + index * VARIANT_BYTES, VARIANT_BYTES),
                        context));
                }
                const ids = named === 0
                    ? new Uint8Array(0)
                    : side.readMemory(u32(head, 4), named * 4);
                return { args, named: wordsOfBytes(ids) };
            }
            default:
                throw new Error(`cannot marshal ${type.why ?? type.kind}`);
        }
    };

    /** @param {Uint8Array} bytes @param {WireContext} context */
    const decodeVariant = async(bytes, context)=>{
        const vt = u16(bytes, 0);
        const base = vt & VT_TYPEMASK;
        if (base === VT_DECIMAL && (vt & VT_BYREF) === 0)
        {
            return { vt, raw: bytes.slice(0, VARIANT_BYTES) };
        }
        if (vt & VT_ARRAY)
        {
            const at = (vt & VT_BYREF) ? u32(side.readMemory(u32(bytes, 8), 4), 0) : u32(bytes, 8);
            return { vt, value: await decodeArray(at, context) };
        }
        if (base === VT_EMPTY || base === VT_NULL)
        {
            return { vt };
        }
        const type = typeOfVartype(base);
        if (!type || (base === VT_VARIANT && (vt & VT_BYREF) === 0))
        {
            throw new Error(`cannot marshal a variant of VARTYPE ${vt}`);
        }
        if (vt & VT_BYREF)
        {
            // No referent at all is apart from one that holds nothing -- a
            // BSTR* at a NULL string: the callee is handed a cell either way
            // but the first, as COM hands it.
            const at = u32(bytes, 8);
            return at === 0 ? { vt, value: null, absent: true }
                : { vt, value: await decode(type, side.readMemory(at, sizeOf(type)), context) };
        }
        return { vt, value: await decode(type, bytes.subarray(8, 8 + sizeOf(type)), context) };
    };

    /** @param {number} at @param {WireContext} context */
    const decodeArray = async(at, context)=>{
        if (at === 0)
        {
            return null;
        }
        const head = side.readMemory(at, SAFEARRAY_BOUNDS);
        const dims = u16(head, 0);
        const features = u16(head, 2);
        const elementBytes = u32(head, 4);
        const bounds = [];
        let count = 1;
        for (let index = 0; index < dims; index++)
        {
            const bound = side.readMemory(at + SAFEARRAY_BOUNDS + index * 8, 8);
            bounds.push({ elements: u32(bound, 0), lower: u32(bound, 4) | 0 });
            count *= u32(bound, 0);
        }
        const vt = vartypeOfArray(features, elementBytes);
        const type = typeOfVartype(vt);
        const data = u32(head, 12);
        if (!type || type.kind === 'word')
        {
            return { vt, bounds, data: side.readMemory(data, count * elementBytes).slice() };
        }
        const elements = [];
        for (let index = 0; index < count; index++)
        {
            elements.push(await decode(type,
                side.readMemory(data + index * elementBytes, elementBytes), context));
        }
        return { vt, bounds, elements };
    };

    /**
     * A value put into memory: the bytes it is stored as, with whatever it
     * points at made first.
     *
     * @param {WireType} type @param {any} wire @param {WireContext} context
     * @returns {Promise<Uint8Array>}
     */
    const encode = async(type, wire, context)=>{
        switch (type.kind)
        {
            case 'word': {
                const out = new Uint8Array(/** @type {number} */ (type.bytes));
                out.set(wire.subarray(0, out.length));
                return out;
            }
            case 'null':
                return new Uint8Array(4);
            case 'bstr':
                return le32(wire === null ? 0 : side.allocateBstr(wire));
            case 'lpstr':
            case 'lpwstr': {
                if (wire === null)
                {
                    return new Uint8Array(4);
                }
                const unit = type.kind === 'lpwstr' ? 2 : 1;
                const at = side.allocate(wire.length + unit);
                side.writeMemory(at, wire);
                side.writeMemory(at + wire.length, new Uint8Array(unit));
                return le32(at);
            }
            case 'interface':
                return le32(wire === null
                    ? 0
                    : await side.importInterface(wire.reference, wire.iid));
            case 'pointer': {
                if (wire === null)
                {
                    return new Uint8Array(4);
                }
                const to = /** @type {WireType} */ (type.to);
                const at = side.allocate(sizeOf(to));
                side.writeMemory(at, await encode(to, wire.value, context));
                return le32(at);
            }
            case 'record': {
                const out = wire.raw.slice();
                for (const [index, field] of (type.fields ?? []).entries())
                {
                    out.set(await encode(field.type, wire.fields[index], context), field.offset);
                }
                return out;
            }
            case 'array': {
                if (wire === null)
                {
                    return new Uint8Array(4);
                }
                const to = /** @type {WireType} */ (type.to);
                const at = side.allocate(Math.max(wire.length, 1) * sizeOf(to));
                for (const [index, element] of wire.entries())
                {
                    side.writeMemory(at + index * sizeOf(to), await encode(to, element, context));
                }
                return le32(at);
            }
            case 'variant':
                return encodeVariant(wire, context);
            case 'safearray':
                return le32(await encodeArray(wire, context));
            case 'dispparams': {
                if (wire === null)
                {
                    return new Uint8Array(4);
                }
                const args = side.allocate(Math.max(wire.args.length, 1) * VARIANT_BYTES);
                for (const [index, argument] of wire.args.entries())
                {
                    side.writeMemory(args + index * VARIANT_BYTES,
                        await encodeVariant(argument, context));
                }
                const named = side.allocate(Math.max(wire.named.length, 1) * 4);
                side.writeMemory(named, bytesOfWords(wire.named));
                const head = side.allocate(16);
                side.writeMemory(head, bytesOfWords(
                    [args, named, wire.args.length, wire.named.length]));
                return le32(head);
            }
            default:
                throw new Error(`cannot marshal ${type.why ?? type.kind}`);
        }
    };

    /** @param {any} wire @param {WireContext} context */
    const encodeVariant = async(wire, context)=>{
        if (wire.raw)
        {
            return wire.raw.slice();
        }
        const out = new Uint8Array(VARIANT_BYTES);
        out[0] = wire.vt & 0xff;
        out[1] = wire.vt >> 8;
        const base = wire.vt & VT_TYPEMASK;
        if (wire.vt & VT_ARRAY)
        {
            const array = await encodeArray(wire.value, context);
            if (wire.vt & VT_BYREF)
            {
                const cell = side.allocate(4);
                side.writeMemory(cell, le32(array));
                context.owned.push({ type: { kind: 'safearray' }, address: cell });
                put32(out, 8, cell);
            }
            else
            {
                put32(out, 8, array);
            }
            return out;
        }
        const type = typeOfVartype(base);
        if (!type || base === VT_EMPTY || base === VT_NULL)
        {
            return out;
        }
        if (wire.vt & VT_BYREF)
        {
            if (wire.absent)
            {
                return out;
            }
            // Nothing a byref variant is cleared by frees what it points at,
            // so the block is the stub's to give back.
            const cell = side.allocate(sizeOf(type));
            side.writeMemory(cell, await encode(type, wire.value, context));
            context.owned.push({ type, address: cell });
            put32(out, 8, cell);
            return out;
        }
        out.set(await encode(type, wire.value, context), 8);
        return out;
    };

    /** @param {any} wire @param {WireContext} context @returns {Promise<number>} */
    const encodeArray = async(wire, context)=>{
        if (wire === null)
        {
            return 0;
        }
        const at = side.createSafeArray(wire.vt, [...wire.bounds].reverse());
        if (at === 0)
        {
            return 0;
        }
        const head = side.readMemory(at, SAFEARRAY_BOUNDS);
        const data = u32(head, 12);
        const elementBytes = u32(head, 4);
        if (wire.data)
        {
            side.writeMemory(data, wire.data);
            return at;
        }
        const type = /** @type {WireType} */ (typeOfVartype(wire.vt));
        for (const [index, element] of wire.elements.entries())
        {
            side.writeMemory(data + index * elementBytes, await encode(type, element, context));
        }
        return at;
    };

    /**
     * Frees what a stored value owns. An interface whose reference already
     * went with it (`transferred`) is left alone.
     *
     * @param {WireType} type @param {Uint8Array} bytes
     * @param {WireContext} context @param {boolean} [transferred]
     */
    const dispose = async(type, bytes, context, transferred = false)=>{
        const at = type.kind === 'word' || type.kind === 'record' || type.kind === 'variant'
            ? 0 : u32(bytes, 0);
        switch (type.kind)
        {
            case 'bstr':
                if (at !== 0)
                {
                    side.freeBstr(at);
                }
                return;
            case 'lpstr':
            case 'lpwstr':
                if (at !== 0)
                {
                    side.free(at);
                }
                return;
            case 'interface':
                if (at !== 0 && !transferred)
                {
                    await side.releaseInterface(at);
                }
                return;
            case 'pointer': {
                if (at === 0)
                {
                    return;
                }
                const to = /** @type {WireType} */ (type.to);
                await dispose(to, side.readMemory(at, sizeOf(to)), context, transferred);
                side.free(at);
                return;
            }
            case 'record':
                for (const field of type.fields ?? [])
                {
                    await dispose(field.type,
                        bytes.subarray(field.offset, field.offset + sizeOf(field.type)),
                        context, transferred);
                }
                return;
            case 'array': {
                if (at === 0)
                {
                    return;
                }
                const to = /** @type {WireType} */ (type.to);
                const count = context.countOf(type.countFrom ?? -1);
                for (let index = 0; index < count; index++)
                {
                    await dispose(to, side.readMemory(at + index * sizeOf(to), sizeOf(to)),
                        context, transferred);
                }
                side.free(at);
                return;
            }
            case 'variant': {
                const vt = u16(bytes, 0);
                if (vt & VT_BYREF)
                {
                    return;
                }
                if (vt & VT_ARRAY)
                {
                    if (u32(bytes, 8) !== 0)
                    {
                        await side.destroySafeArray(u32(bytes, 8));
                    }
                    return;
                }
                const inner = typeOfVartype(vt & VT_TYPEMASK);
                if (inner && inner.kind !== 'word' && inner.kind !== 'variant')
                {
                    await dispose(inner, bytes.subarray(8, 12), context, transferred);
                }
                return;
            }
            case 'safearray':
                if (at !== 0)
                {
                    await side.destroySafeArray(at);
                }
                return;
            case 'dispparams': {
                if (at === 0)
                {
                    return;
                }
                const head = side.readMemory(at, 16);
                for (let index = 0; index < u32(head, 8); index++)
                {
                    await dispose({ kind: 'variant' },
                        side.readMemory(u32(head, 0) + index * VARIANT_BYTES, VARIANT_BYTES),
                        context, transferred);
                }
                side.free(u32(head, 0));
                side.free(u32(head, 4));
                side.free(at);
                return;
            }
            default:
                return;
        }
    };

    /** @param {WireContext} context */
    const disposeOwned = async context=>{
        for (const { type, address } of context.owned.splice(0))
        {
            await dispose(type, side.readMemory(address, sizeOf(type)), context);
            side.free(address);
        }
    };

    return { decode, encode, dispose, disposeOwned, decodeVariant, encodeVariant };
}

/**
 * Where each parameter sits on the stack, after `this`.
 *
 * @param {MethodDescription} method
 */
function layout(method){
    const offsets = [];
    let at = 0;
    for (const parameter of method.parameters)
    {
        offsets.push(at);
        at += stackSize(parameter.type);
    }
    return { offsets, bytes: at };
}

/** @param {MethodDescription} method */
export const argumentBytes = method=>4 + layout(method).bytes;

/**
 * A context over one call's request, for the parameters that name another's
 * GUID or count.
 *
 * @param {any[]} request @param {boolean} transfer
 * @returns {WireContext}
 */
function contextOver(request, transfer){
    return {
        transfer,
        iidOf: index=>{
            const value = request[index]?.value?.raw ?? request[index]?.raw;
            return value instanceof Uint8Array && value.length >= 16 ? formatGuid(value) : null;
        },
        countOf: index=>{
            const value = request[index];
            return value instanceof Uint8Array ? u32(Uint8Array.from([...value, 0, 0, 0, 0]), 0)
                : 0;
        },
        owned: [],
    };
}

/** @param {number} flags */
const isIn = flags=>(flags & PARAMFLAG_FIN) !== 0 || (flags & PARAMFLAG_FOUT) === 0;
/** @param {number} flags */
const isOut = flags=>(flags & PARAMFLAG_FOUT) !== 0;

/**
 * The caller's side of a call: its arguments as a request. An [out]-only
 * pointer crosses as whether it was given at all.
 *
 * @param {MarshalSide} side @param {MethodDescription} method
 * @param {number[]} args  The words after `this`.
 * @returns {Promise<any[]>}
 */
export async function marshalRequest(side, method, args){
    const wire = createWire(side);
    const bytes = bytesOfWords(args);
    const { offsets } = layout(method);
    /** @type {any[]} */
    const request = [];
    const context = contextOver(request, false);
    // An array is read once what counts it has been: the count may come after
    // it, as GetIDsOfNames' cNames comes after rgszNames.
    const order = [...method.parameters.keys()].sort((a, b)=>
        Number(method.parameters[a].type.kind === 'array')
            - Number(method.parameters[b].type.kind === 'array'));
    for (const index of order)
    {
        const parameter = method.parameters[index];
        const at = bytes.subarray(offsets[index], offsets[index] + sizeOf(parameter.type));
        // A caller's array of results is a buffer, not a value: it crosses
        // as whether there is one, like a pointer that is only [out].
        const crosses = parameter.type.kind === 'array'
            ? !isOut(parameter.flags)
            : isIn(parameter.flags);
        request[index] = crosses
            ? await wire.decode(parameter.type, at, context)
            : u32(at, 0) !== 0;
    }
    return request;
}

/**
 * The callee's side: the request laid out as the method's arguments, each
 * [out] parameter given a zeroed place to write.
 *
 * @param {MarshalSide} side @param {MethodDescription} method @param {any[]} request
 * @returns {Promise<{ words: number[], laid: Uint8Array[], context: WireContext }>}
 */
export async function unmarshalRequest(side, method, request){
    const wire = createWire(side);
    const context = contextOver(request, false);
    /** @type {Uint8Array[]} */
    const laid = [];
    for (const [index, parameter] of method.parameters.entries())
    {
        const type = parameter.type;
        if (typeof request[index] === 'boolean')
        {
            let address = 0;
            if (request[index])
            {
                const bytes = type.kind === 'array'
                    ? Math.max(context.countOf(type.countFrom ?? -1), 1)
                        * sizeOf(/** @type {WireType} */ (type.to))
                    : sizeOf(/** @type {WireType} */ (type.to));
                address = side.allocate(bytes);
                side.writeMemory(address, new Uint8Array(bytes));
            }
            laid.push(le32(address));
            continue;
        }
        const bytes = await wire.encode(type, request[index], context);
        const padded = new Uint8Array(stackSize(type));
        padded.set(bytes);
        laid.push(padded);
    }
    const words = laid.flatMap(bytes=>wordsOfBytes(bytes));
    return { words, laid, context };
}

/**
 * The callee's side once the method has returned: its [out] parameters as a
 * reply, and everything the stub made for the call given back.
 *
 * @param {MarshalSide} side @param {MethodDescription} method
 * @param {any[]} request @param {{ laid: Uint8Array[], context: WireContext }} call
 * @returns {Promise<any[]>}
 */
export async function marshalReply(side, method, request, call){
    const wire = createWire(side);
    const context = { ...contextOver(request, true), owned: call.context.owned };
    /** @type {any[]} */
    const reply = [];
    for (const [index, parameter] of method.parameters.entries())
    {
        const type = parameter.type;
        const at = u32(call.laid[index], 0);
        if (!isOut(parameter.flags) || at === 0)
        {
            continue;
        }
        if (type.kind === 'dispparams')
        {
            reply[index] = await byrefValues(side, wire, at, context);
            continue;
        }
        const to = /** @type {WireType} */ (type.to);
        if (type.kind === 'array')
        {
            reply[index] = await wire.decode(type, call.laid[index], context);
            continue;
        }
        reply[index] = await wire.decode(to, side.readMemory(at, sizeOf(to)), context);
    }
    for (const [index, parameter] of method.parameters.entries())
    {
        const type = parameter.type;
        const at = u32(call.laid[index], 0);
        if (isOut(parameter.flags) && type.kind !== 'dispparams')
        {
            if (at !== 0)
            {
                if (type.kind === 'array')
                {
                    await wire.dispose(type, call.laid[index], context, true);
                }
                else
                {
                    await wire.dispose(/** @type {WireType} */ (type.to),
                        side.readMemory(at, sizeOf(/** @type {WireType} */ (type.to))),
                        context, true);
                    side.free(at);
                }
            }
            continue;
        }
        await wire.dispose(type, call.laid[index], context);
    }
    await wire.disposeOwned(context);
    return reply;
}

/**
 * What each by-reference argument of a DISPPARAMS points at now: an
 * Invoke's [in, out] arguments.
 *
 * @param {MarshalSide} side @param {ReturnType<typeof createWire>} wire
 * @param {number} at @param {WireContext} context
 */
async function byrefValues(side, wire, at, context){
    const head = side.readMemory(at, 16);
    const updates = [];
    for (let index = 0; index < u32(head, 8); index++)
    {
        const variant = side.readMemory(u32(head, 0) + index * VARIANT_BYTES, VARIANT_BYTES);
        if (u16(variant, 0) & VT_BYREF)
        {
            updates.push({ index, value: await wire.decodeVariant(variant, context) });
        }
    }
    return updates;
}

/**
 * The caller's side once the reply is in: each [out] value written through
 * the pointer the caller gave, over whatever an [in, out] one held.
 *
 * @param {MarshalSide} side @param {MethodDescription} method
 * @param {number[]} args @param {any[]} request @param {any[]} reply
 */
export async function unmarshalReply(side, method, args, request, reply){
    const wire = createWire(side);
    const context = contextOver(request, false);
    const bytes = bytesOfWords(args);
    const { offsets } = layout(method);
    for (const [index, parameter] of method.parameters.entries())
    {
        const type = parameter.type;
        const at = u32(bytes, offsets[index]);
        if (!isOut(parameter.flags) || at === 0 || reply[index] === undefined)
        {
            continue;
        }
        if (type.kind === 'dispparams')
        {
            const head = side.readMemory(at, 16);
            for (const update of reply[index])
            {
                const variant = side.readMemory(u32(head, 0) + update.index * VARIANT_BYTES,
                    VARIANT_BYTES);
                const target = typeOfVartype(u16(variant, 0) & VT_TYPEMASK);
                const cell = u32(variant, 8);
                if (!target || cell === 0 || update.value.absent)
                {
                    continue;
                }
                await wire.dispose(target, side.readMemory(cell, sizeOf(target)), context);
                side.writeMemory(cell, await wire.encode(target, update.value.value, context));
            }
            continue;
        }
        if (type.kind === 'array')
        {
            const to = /** @type {WireType} */ (type.to);
            for (const [element, value] of reply[index].entries())
            {
                side.writeMemory(at + element * sizeOf(to), await wire.encode(to, value, context));
            }
            continue;
        }
        const to = /** @type {WireType} */ (type.to);
        if ((parameter.flags & PARAMFLAG_FIN) !== 0)
        {
            await wire.dispose(to, side.readMemory(at, sizeOf(to)), context);
        }
        side.writeMemory(at, await wire.encode(to, reply[index], context));
    }
}

/** @param {string} text @returns {string | null} */
export const canonicalIid = text=>{
    const bytes = parseGuid(text);
    return bytes ? formatGuid(bytes) : null;
};

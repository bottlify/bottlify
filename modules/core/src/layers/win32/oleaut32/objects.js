/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ITypeLib and ITypeInfo: a parsed type library, laid out for a program.
 *
 * Everything a program reads through these interfaces is a structure in its
 * own memory -- a TYPEATTR, a FUNCDESC with its parameters, a VARDESC with its
 * constant -- allocated on request and given back through the matching
 * Release method. The structures nest through pointers (a FUNCDESC points at
 * its parameter array, a pointer type at the type it points to), so each one
 * is built as a single block with the pointers inside it patched once the
 * block's address is known, and released as a single block. A program that
 * frees a piece of one on its own is doing what the contract forbids.
 *
 * The one thing not read off the file is what a dispinterface inherits. A
 * type library stores a dispinterface's own methods only; the seven of
 * IDispatch it starts with are counted into cFuncs and answered first, which
 * is how a program walking `GetFuncDesc` from zero finds the same table it
 * would find on Windows.
 */

import { IID_IUNKNOWN, IUNKNOWN_METHODS } from '../ole32/objects.js';
import { readGuid, writeGuid } from '../ole32/guid.js';
import {
    TKIND_DISPATCH, TKIND_INTERFACE,
    VT_BSTR, VT_CARRAY, VT_PTR, VT_SAFEARRAY, VT_USERDEFINED,
    isImport, resolveReference,
} from './typelib.js';
import { createInvoker } from './invoke.js';

/** The interfaces these objects answer to. */
export const IID_ITYPELIB = '{00020402-0000-0000-C000-000000000046}';
export const IID_ITYPEINFO = '{00020401-0000-0000-C000-000000000046}';

/** HRESULTs. */
const S_OK = 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_POINTER = 0x80004003 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_INVALIDARG = 0x80070057 | 0;
const DISP_E_UNKNOWNNAME = 0x80020006 | 0;
const DISP_E_MEMBERNOTFOUND = 0x80020003 | 0;
const TYPE_E_ELEMENTNOTFOUND = 0x8002802b | 0;
const TYPE_E_CANTLOADLIBRARY = 0x80029c4a | 0;

/** MEMBERID_NIL: a member that does not exist. */
const MEMBERID_NIL = -1;

/** FUNCKIND / INVOKEKIND / CALLCONV values the synthesised descriptions use. */
const FUNC_PUREVIRTUAL = 1;
const FUNC_DISPATCH = 4;
const INVOKE_FUNC = 1;
const CC_STDCALL = 4;

/** TYPEFLAG bits that a dispinterface view drops. */
const TYPEFLAG_FOLEAUTOMATION = 0x100;

/** Types the synthesised descriptions are made of. */
const VT_VOID = 24;
const VT_HRESULT = 25;
const VT_UI4 = 19;
const VT_UI2 = 18;
const VT_I4 = 3;
const VT_UINT = 23;
const VT_I1 = 16;

/** Structure sizes, 32-bit. */
const TLIBATTR_BYTES = 32;
const TYPEATTR_BYTES = 76;
const FUNCDESC_BYTES = 52;
const VARDESC_BYTES = 36;
const ELEMDESC_BYTES = 16;
const TYPEDESC_BYTES = 8;
const VARIANT_BYTES = 16;

/** The pointer size, and IDispatch's vtable in slots. */
const WORD = 4;
const IDISPATCH_SLOTS = 7;

/** Where the well-known imports come from, and which they are. */
const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';

/**
 * The reference a dual interface's dispinterface hands out for its vtable
 * twin. Not an offset into any table, and never mistaken for one: the low bits
 * that would mark an import are set, and no import record lives this far in.
 */
const DUAL_TWIN_HREFTYPE = -2;

/**
 * @typedef {import('./typelib.js').TypeLibrary} TypeLibrary
 * @typedef {import('./typelib.js').TypeInfoDescription} TypeInfoDescription
 * @typedef {import('./typelib.js').FunctionDescription} FunctionDescription
 * @typedef {import('./typelib.js').TypeDescription} TypeDescription
 * @typedef {import('./typelib.js').ParameterDescription} ParameterDescription
 */

/** @param {number} vt @returns {TypeDescription} */
const plain = vt=>({ vt, element: null, hreftype: -1, array: null });
/** @param {TypeDescription} element @returns {TypeDescription} */
const pointerTo = element=>({ vt: VT_PTR, element, hreftype: -1, array: null });

/**
 * @param {string} name @param {number} memberId @param {number} slot
 * @param {TypeDescription} returns
 * @param {[string, TypeDescription, number][]} parameters  name, type, PARAMFLAG bits
 * @returns {FunctionDescription}
 */
const method = (name, memberId, slot, returns, parameters)=>({
    memberId,
    name,
    funcKind: FUNC_PUREVIRTUAL,
    invokeKind: INVOKE_FUNC,
    callingConvention: CC_STDCALL,
    vtableOffset: slot * WORD,
    flags: 0,
    returns,
    parameters: parameters.map(([parameter, type, flags])=>({ name: parameter, type, flags })),
    optionalParameters: 0,
    helpString: null,
});

/** PARAMFLAG bits. */
const PARAMFLAG_FIN = 1;
const PARAMFLAG_FOUT = 2;

/**
 * IUnknown and IDispatch, which every automation library imports from the
 * standard library and none carries. Their shape is fixed by the platform,
 * so describing them here is describing the platform, not a library. The
 * structures they take by pointer are described as pointers to void: what a
 * program needs from these is the count and order of the methods and the
 * arity of each, never the layout of a GUID.
 *
 * @type {Readonly<Record<string, TypeInfoDescription>>}
 */
const STANDARD_TYPES = Object.freeze({
    [IID_IUNKNOWN]: standardInterface('IUnknown', IID_IUNKNOWN, [
        method('QueryInterface', 0x60000000, 0, plain(VT_HRESULT), [
            ['riid', pointerTo(plain(VT_VOID)), PARAMFLAG_FIN],
            ['ppvObj', pointerTo(pointerTo(plain(VT_VOID))), PARAMFLAG_FOUT]]),
        method('AddRef', 0x60000001, 1, plain(VT_UI4), []),
        method('Release', 0x60000002, 2, plain(VT_UI4), []),
    ]),
    [IID_IDISPATCH]: standardInterface('IDispatch', IID_IDISPATCH, [
        method('QueryInterface', 0x60000000, 0, plain(VT_HRESULT), [
            ['riid', pointerTo(plain(VT_VOID)), PARAMFLAG_FIN],
            ['ppvObj', pointerTo(pointerTo(plain(VT_VOID))), PARAMFLAG_FOUT]]),
        method('AddRef', 0x60000001, 1, plain(VT_UI4), []),
        method('Release', 0x60000002, 2, plain(VT_UI4), []),
        method('GetTypeInfoCount', 0x60010000, 3, plain(VT_HRESULT), [
            ['pctinfo', pointerTo(plain(VT_UINT)), PARAMFLAG_FOUT]]),
        method('GetTypeInfo', 0x60010001, 4, plain(VT_HRESULT), [
            ['itinfo', plain(VT_UINT), PARAMFLAG_FIN],
            ['lcid', plain(VT_UI4), PARAMFLAG_FIN],
            ['pptinfo', pointerTo(pointerTo(plain(VT_VOID))), PARAMFLAG_FOUT]]),
        method('GetIDsOfNames', 0x60010002, 5, plain(VT_HRESULT), [
            ['riid', pointerTo(plain(VT_VOID)), PARAMFLAG_FIN],
            ['rgszNames', pointerTo(pointerTo(plain(VT_I1))), PARAMFLAG_FIN],
            ['cNames', plain(VT_UINT), PARAMFLAG_FIN],
            ['lcid', plain(VT_UI4), PARAMFLAG_FIN],
            ['rgdispid', pointerTo(plain(VT_I4)), PARAMFLAG_FOUT]]),
        method('Invoke', 0x60010003, 6, plain(VT_HRESULT), [
            ['dispidMember', plain(VT_I4), PARAMFLAG_FIN],
            ['riid', pointerTo(plain(VT_VOID)), PARAMFLAG_FIN],
            ['lcid', plain(VT_UI4), PARAMFLAG_FIN],
            ['wFlags', plain(VT_UI2), PARAMFLAG_FIN],
            ['pdispparams', pointerTo(plain(VT_VOID)), PARAMFLAG_FIN],
            ['pvarResult', pointerTo(plain(VT_VOID)), PARAMFLAG_FOUT],
            ['pexcepinfo', pointerTo(plain(VT_VOID)), PARAMFLAG_FOUT],
            ['puArgErr', pointerTo(plain(VT_UINT)), PARAMFLAG_FOUT]]),
    ]),
});

/**
 * An object the bridge can publish: one reference to start with -- the
 * caller's -- and the same method table for an interface every time, which
 * is what lets the bridge share one vtable among every object of a kind.
 *
 * @param {any} state
 * @param {Readonly<Record<string, readonly any[]>>} interfaces
 *        By interface id: the full table, IUnknown's three first.
 * @param {() => void} [destroy]  Called once, when the last reference goes.
 * @returns {ComAdapter}
 */
export function createAdapter(state, interfaces, destroy){
    let references = 1;
    return {
        state,
        interfaceFor(asked){
            if (asked === IID_IUNKNOWN)
            {
                return { id: asked, methods: IUNKNOWN_METHODS };
            }
            const methods = interfaces[asked];
            return methods ? { id: asked, methods } : null;
        },
        addRef: ()=>++references,
        release(){
            references--;
            if (references === 0)
            {
                destroy?.();
            }
            return Math.max(references, 0);
        },
    };
}

/**
 * @param {string} name @param {string} guid @param {FunctionDescription[]} functions
 * @returns {TypeInfoDescription}
 */
function standardInterface(name, guid, functions){
    return {
        index: -1,
        hreftype: -1,
        name,
        kind: TKIND_INTERFACE,
        guid,
        flags: 0,
        majorVersion: 0,
        minorVersion: 0,
        helpString: null,
        instanceSize: WORD,
        alignment: WORD,
        vtableSize: functions.length * WORD,
        functions,
        variables: [],
        implementedTypes: guid === IID_IUNKNOWN ? [] : [{ hreftype: -1, flags: 0 }],
        alias: null,
    };
}

/**
 * A structure under construction: bytes, plus the offsets of the words that
 * are pointers into the same block and need the block's address added once
 * it is known.
 */
class Block {
    constructor(){
        /** @type {number[]} */
        this.bytes = [];
        /** @type {number[]} */
        this.fixups = [];
    }

    /** @param {number} count @returns {number} the offset of the reserved bytes */
    reserve(count){
        const at = this.bytes.length;
        for (let index = 0; index < count; index++)
        {
            this.bytes.push(0);
        }
        return at;
    }

    /** @param {number} at @param {number} value */
    u16(at, value){
        this.bytes[at] = value & 0xff;
        this.bytes[at + 1] = (value >>> 8) & 0xff;
    }

    /** @param {number} at @param {number} value */
    u32(at, value){
        this.u16(at, value & 0xffff);
        this.u16(at + 2, (value >>> 16) & 0xffff);
    }

    /** @param {number} at @param {number} target  An offset in this block. */
    pointer(at, target){
        this.fixups.push(at);
        this.u32(at, target);
    }

    /** @param {number} at @param {Uint8Array} data */
    put(at, data){
        for (let index = 0; index < data.length; index++)
        {
            this.bytes[at + index] = data[index];
        }
    }

    /**
     * @param {{ allocate: (bytes: number) => number }} heap
     * @param {(address: number, bytes: Uint8Array) => void} write
     * @returns {number} the block's address, or 0
     */
    commit(heap, write){
        const address = heap.allocate(this.bytes.length);
        if (address === 0)
        {
            return 0;
        }
        for (const at of this.fixups)
        {
            this.u32(at, this.readU32(at) + address);
        }
        write(address, Uint8Array.from(this.bytes));
        return address;
    }

    /** @param {number} at */
    readU32(at){
        return (this.bytes[at] | (this.bytes[at + 1] << 8) | (this.bytes[at + 2] << 16)
            | (this.bytes[at + 3] << 24)) >>> 0;
    }
}

/**
 * A TYPEDESC into a block, with whatever it points at appended after it.
 *
 * @param {Block} block @param {number} at @param {TypeDescription} type
 */
function writeTypeDesc(block, at, type){
    block.u16(at + 4, type.vt);
    if ((type.vt === VT_PTR || type.vt === VT_SAFEARRAY) && type.element)
    {
        const inner = block.reserve(TYPEDESC_BYTES);
        block.pointer(at, inner);
        writeTypeDesc(block, inner, type.element);
    }
    else if (type.vt === VT_USERDEFINED)
    {
        block.u32(at, type.hreftype);
    }
    else if (type.vt === VT_CARRAY && type.array)
    {
        // ARRAYDESC: the element's TYPEDESC, the dimension count, then one
        // SAFEARRAYBOUND (elements, lower bound) per dimension.
        const bounds = type.array.bounds;
        const array = block.reserve(TYPEDESC_BYTES + 4 + bounds.length * 8);
        block.pointer(at, array);
        writeTypeDesc(block, array, type.array.element);
        block.u16(array + TYPEDESC_BYTES, bounds.length);
        bounds.forEach((bound, index)=>{
            block.u32(array + TYPEDESC_BYTES + 4 + index * 8, bound.elements);
            block.u32(array + TYPEDESC_BYTES + 8 + index * 8, bound.lower);
        });
    }
}

/**
 * An ELEMDESC: a TYPEDESC, then the PARAMDESC (no default, the flags).
 *
 * @param {Block} block @param {number} at @param {TypeDescription} type @param {number} flags
 */
function writeElemDesc(block, at, type, flags){
    writeTypeDesc(block, at, type);
    block.u16(at + 12, flags);
}

/**
 * @typedef {Object} TypeLibraryObjectsHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => boolean }} heap
 *           The task allocator's heap: what the Release methods give back to.
 * @property {(object: ComAdapter, interfaceId: string) => number} publish
 * @property {(entry: number, args: number[]) => Promise<number>} call
 *           A stdcall into guest code, for ITypeInfo::Invoke.
 * @property {(pvar: number) => void} clearVariant
 * @property {(bstr: number) => string} readBstr
 * @property {(text: string) => number} allocateBstr
 * @property {(bstr: number) => void} freeBstr
 * @property {(api: string, detail: string) => void} divergence
 */

/**
 * What the bridge publishes: an object it can ask for an interface's method
 * table, and count references on.
 *
 * @typedef {Object} ComAdapter
 * @property {any} state
 * @property {(id: string) => { id: string, methods: readonly any[] } | null} interfaceFor
 * @property {() => number} addRef
 * @property {() => number} release
 */

/**
 * @typedef {Object} LoadedLibrary
 * @property {TypeLibrary} library
 * @property {string} path      Where it was loaded from, for RegisterTypeLib.
 * @property {number} pointer   Its ITypeLib in guest memory.
 */

/**
 * A type's description as the flat entry points reach it: ITypeInfo's
 * methods, callable with what the program handed them.
 *
 * @typedef {Object} LoadedTypeInfo
 * @property {(names: number, count: number, out: number) => number} getIDsOfNames
 */

/**
 * @typedef {Object} TypeLibraryObjects
 * @property {(library: TypeLibrary, path: string) => number} open
 *           Publishes a library and answers with its ITypeLib pointer, or 0.
 * @property {(pointer: number) => LoadedLibrary | null} libraryAt
 *           The library behind an ITypeLib pointer a program handed back.
 * @property {(pointer: number) => LoadedTypeInfo | null} typeInfoAt
 *           The type behind an ITypeInfo pointer a program handed back.
 */

/**
 * @param {TypeLibraryObjectsHost} host
 * @returns {TypeLibraryObjects}
 */
export function createTypeLibraryObjects(host){
    const memory = { readMemory: host.readMemory, writeMemory: host.writeMemory };
    const invoker = createInvoker({
        readMemory: host.readMemory,
        writeMemory: host.writeMemory,
        heap: host.heap,
        call: host.call,
        clearVariant: host.clearVariant,
        readBstr: host.readBstr,
        allocateBstr: host.allocateBstr,
        freeBstr: host.freeBstr,
        divergence: host.divergence,
    });

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /** @param {number} address @returns {string} */
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

    /**
     * Writes a BSTR where a program asked for one, or nothing where it passed
     * NULL for the slot -- every documentation call lets a caller decline any
     * of its strings.
     *
     * @param {number} slot @param {string | null} text
     * @returns {boolean} false when the string could not be allocated
     */
    const giveString = (slot, text)=>{
        if (slot === 0)
        {
            return true;
        }
        if (text === null)
        {
            writeU32(slot, 0);
            return true;
        }
        const bstr = host.allocateBstr(text);
        writeU32(slot, bstr);
        return bstr !== 0;
    };

    /** @type {Map<number, LoadedLibrary>} */
    const byPointer = new Map();
    /** @type {Map<number, TypeInfoState>} */
    const typeInfosByPointer = new Map();

    /** @param {any} state @param {readonly any[]} methods @param {string} id @param {() => void} [destroy] */
    const adapter = (state, methods, id, destroy)=>createAdapter(state, { [id]: methods }, destroy);

    /**
     * @typedef {Object} TypeInfoState
     * @property {LibraryState} owner
     * @property {TypeInfoDescription} description
     * @property {number} pointer
     * @property {Map<number, number>} bstrs  Constants handed out, by VARDESC.
     * @property {ComAdapter} object
     */

    /**
     * @typedef {Object} LibraryState
     * @property {TypeLibrary} library
     * @property {string} path
     * @property {number} pointer
     * @property {Map<number, TypeInfoState>} typeInfos  By hreftype.
     * @property {ComAdapter} object
     */

    /**
     * The functions a type answers for, in GetFuncDesc order: a
     * dispinterface's start with IDispatch's seven.
     *
     * @param {TypeInfoDescription} description
     * @returns {FunctionDescription[]}
     */
    const functionsOf = description=>(description.kind === TKIND_DISPATCH
        ? [...STANDARD_TYPES[IID_IDISPATCH].functions, ...description.functions]
        : description.functions);

    /**
     * The ITypeInfo for one type of a library, made once per type.
     *
     * @param {LibraryState} owner @param {number} hreftype
     * @param {TypeInfoDescription} description
     * @returns {number} its pointer, or 0
     */
    const typeInfoFor = (owner, hreftype, description)=>{
        const known = owner.typeInfos.get(hreftype);
        if (known)
        {
            known.object.addRef();
            return known.pointer;
        }
        /** @type {TypeInfoState} */
        const state = {
            owner, description, pointer: 0, bstrs: new Map(),
            object: /** @type {ComAdapter} */ (/** @type {unknown} */ (null)),
        };
        state.object = adapter(state, TYPEINFO_METHODS, IID_ITYPEINFO, ()=>{
            owner.typeInfos.delete(hreftype);
            typeInfosByPointer.delete(state.pointer);
            owner.object.release();
        });
        // A type keeps its library alive: a program may release the library
        // and go on reading the type.
        owner.object.addRef();
        state.pointer = host.publish(state.object, IID_ITYPEINFO) >>> 0;
        if (state.pointer === 0)
        {
            owner.object.release();
            return 0;
        }
        owner.typeInfos.set(hreftype, state);
        typeInfosByPointer.set(state.pointer, state);
        return state.pointer;
    };

    /**
     * ITypeInfo::GetRefTypeInfo's answer for a reference: a type of the same
     * library, or one of the two standard interfaces every library imports.
     *
     * @param {LibraryState} owner @param {number} hreftype
     * @returns {number} the ITypeInfo pointer, or 0 when nothing describes it
     */
    const referencedTypeInfo = (owner, hreftype)=>{
        const reference = resolveReference(owner.library, hreftype);
        if (!reference)
        {
            return 0;
        }
        if (!isImport(reference))
        {
            return typeInfoFor(owner, hreftype, reference);
        }
        const standard = reference.guid === null ? undefined : STANDARD_TYPES[reference.guid];
        if (!standard)
        {
            host.divergence('LoadTypeLib',
                `a type imported from ${reference.library.name} cannot be described`);
            return 0;
        }
        return typeInfoFor(owner, hreftype, standard);
    };

    const TYPELIB_METHODS = Object.freeze([
        ...IUNKNOWN_METHODS,
        /** UINT GetTypeInfoCount(): the count itself, not an HRESULT. */
        { name: 'GetTypeInfoCount', argBytes: 4,
            /** @param {ComAdapter} object */
            invoke: object=>object.state.library.typeInfos.length },
        { name: 'GetTypeInfo', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [index, out])=>{
                /** @type {LibraryState} */
                const state = object.state;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const description = state.library.typeInfos[index >>> 0];
                if (!description)
                {
                    writeU32(out >>> 0, 0);
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                const pointer = typeInfoFor(state, description.hreftype, description);
                writeU32(out >>> 0, pointer);
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            } },
        { name: 'GetTypeInfoType', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [index, out])=>{
                const description = object.state.library.typeInfos[index >>> 0];
                if (!description || (out >>> 0) === 0)
                {
                    return description ? E_INVALIDARG : TYPE_E_ELEMENTNOTFOUND;
                }
                writeU32(out >>> 0, description.kind);
                return S_OK;
            } },
        { name: 'GetTypeInfoOfGuid', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [guid, out])=>{
                /** @type {LibraryState} */
                const state = object.state;
                if ((guid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const wanted = readGuid(memory, guid >>> 0);
                const description = state.library.typeInfos.find(entry=>entry.guid === wanted);
                if (!description)
                {
                    writeU32(out >>> 0, 0);
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                const pointer = typeInfoFor(state, description.hreftype, description);
                writeU32(out >>> 0, pointer);
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            } },
        { name: 'GetLibAttr', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [out])=>{
                /** @type {TypeLibrary} */
                const library = object.state.library;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const block = new Block();
                block.reserve(TLIBATTR_BYTES);
                block.u32(16, library.lcid);
                block.u32(20, library.sysKind);
                block.u16(24, library.majorVersion);
                block.u16(26, library.minorVersion);
                block.u16(28, library.flags);
                const address = block.commit(host.heap, host.writeMemory);
                writeU32(out >>> 0, address);
                if (address === 0)
                {
                    return E_OUTOFMEMORY;
                }
                if (library.guid !== null)
                {
                    writeGuid(memory, address, library.guid);
                }
                return S_OK;
            } },
        { name: 'GetTypeComp', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [out])=>{
                writeU32(out >>> 0, 0);
                host.divergence('ITypeLib::GetTypeComp', 'no ITypeComp is offered');
                return E_NOTIMPL;
            } },
        { name: 'GetDocumentation', argBytes: 24,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [index, name, doc, helpContext, helpFile])=>{
                /** @type {TypeLibrary} */
                const library = object.state.library;
                // Index -1 documents the library itself.
                const described = index === -1
                    ? { name: library.name, helpString: library.helpString }
                    : library.typeInfos[index >>> 0];
                if (!described)
                {
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                if ((helpContext >>> 0) !== 0)
                {
                    writeU32(helpContext >>> 0, 0);
                }
                const given = giveString(name >>> 0, described.name)
                    && giveString(doc >>> 0, described.helpString)
                    && giveString(helpFile >>> 0, library.helpFile);
                return given ? S_OK : E_OUTOFMEMORY;
            } },
        { name: 'IsName', argBytes: 16,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [nameBuffer, , out])=>{
                const found = findByName(object.state.library, readWide(nameBuffer >>> 0));
                if ((out >>> 0) !== 0)
                {
                    writeU32(out >>> 0, found.length > 0 ? 1 : 0);
                }
                return S_OK;
            } },
        { name: 'FindName', argBytes: 24,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [nameBuffer, , typeInfos, memberIds, count])=>{
                /** @type {LibraryState} */
                const state = object.state;
                if ((count >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const room = host.readMemory(count >>> 0, 2);
                const wanted = room[0] | (room[1] << 8);
                const found = findByName(state.library, readWide(nameBuffer >>> 0))
                    .slice(0, wanted);
                found.forEach((hit, index)=>{
                    writeU32((typeInfos >>> 0) + index * WORD,
                        typeInfoFor(state, hit.type.hreftype, hit.type));
                    writeU32((memberIds >>> 0) + index * WORD, hit.memberId);
                });
                host.writeMemory(count >>> 0,
                    Uint8Array.from([found.length & 0xff, found.length >> 8]));
                return S_OK;
            } },
        { name: 'ReleaseTLibAttr', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [attr])=>{
                host.heap.free(attr >>> 0);
                return 0;
            } },
    ]);

    /**
     * ITypeInfo::GetIDsOfNames. The first name is a member's; the rest name
     * its parameters, whose ids are their positions.
     *
     * @param {TypeInfoDescription} type
     * @param {number} names @param {number} count @param {number} out
     */
    const getIDsOfNames = (type, names, count, out)=>{
        if (names === 0 || out === 0)
        {
            return E_INVALIDARG;
        }
        const wanted = readWide(readU32(names)).toLowerCase();
        const members = [...functionsOf(type), ...type.variables];
        const member = members.find(entry=>entry.name?.toLowerCase() === wanted);
        if (!member)
        {
            for (let index = 0; index < count; index++)
            {
                writeU32(out + index * WORD, MEMBERID_NIL);
            }
            return DISP_E_UNKNOWNNAME;
        }
        writeU32(out, member.memberId);
        let result = S_OK;
        const parameters = 'parameters' in member ? member.parameters : [];
        for (let index = 1; index < count; index++)
        {
            const name = readWide(readU32(names + index * WORD)).toLowerCase();
            const position = parameters.findIndex(
                parameter=>parameter.name?.toLowerCase() === name);
            writeU32(out + index * WORD, position < 0 ? MEMBERID_NIL : position);
            if (position < 0)
            {
                result = DISP_E_UNKNOWNNAME;
            }
        }
        return result;
    };

    /**
     * Types and members called `name`, the way FindName and IsName look: the
     * type's own name, then its functions' and variables', case folded.
     *
     * @param {TypeLibrary} library @param {string} name
     * @returns {{ type: TypeInfoDescription, memberId: number }[]}
     */
    const findByName = (library, name)=>{
        const folded = name.toLowerCase();
        const hits = [];
        for (const type of library.typeInfos)
        {
            if (type.name.toLowerCase() === folded)
            {
                hits.push({ type, memberId: MEMBERID_NIL });
                continue;
            }
            const member = [...type.functions, ...type.variables]
                .find(entry=>entry.name?.toLowerCase() === folded);
            if (member)
            {
                hits.push({ type, memberId: member.memberId });
            }
        }
        return hits;
    };

    const TYPEINFO_METHODS = Object.freeze([
        ...IUNKNOWN_METHODS,
        { name: 'GetTypeAttr', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [out])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                const type = state.description;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const dispatch = type.kind === TKIND_DISPATCH;
                const block = new Block();
                block.reserve(TYPEATTR_BYTES);
                block.u32(16, state.owner.library.lcid);
                block.u32(24, MEMBERID_NIL);
                block.u32(28, MEMBERID_NIL);
                block.u32(36, type.instanceSize);
                block.u32(40, type.kind);
                block.u16(44, functionsOf(type).length);
                block.u16(46, type.variables.length);
                block.u16(48, type.implementedTypes.length);
                // A dispinterface's table is IDispatch's, whatever it declares.
                block.u16(50, dispatch ? IDISPATCH_SLOTS * WORD : type.vtableSize);
                block.u16(52, type.alignment);
                block.u16(54, dispatch ? type.flags & ~TYPEFLAG_FOLEAUTOMATION : type.flags);
                block.u16(56, type.majorVersion);
                block.u16(58, type.minorVersion);
                if (type.alias)
                {
                    writeTypeDesc(block, 60, type.alias);
                }
                const address = block.commit(host.heap, host.writeMemory);
                writeU32(out >>> 0, address);
                if (address === 0)
                {
                    return E_OUTOFMEMORY;
                }
                if (type.guid !== null)
                {
                    writeGuid(memory, address, type.guid);
                }
                return S_OK;
            } },
        { name: 'GetTypeComp', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [out])=>{
                writeU32(out >>> 0, 0);
                host.divergence('ITypeInfo::GetTypeComp', 'no ITypeComp is offered');
                return E_NOTIMPL;
            } },
        { name: 'GetFuncDesc', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [index, out])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const type = state.description;
                const fn = functionsOf(type)[index >>> 0];
                if (!fn)
                {
                    writeU32(out >>> 0, 0);
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                const block = new Block();
                block.reserve(FUNCDESC_BYTES);
                const dispatch = type.kind === TKIND_DISPATCH;
                block.u32(0, fn.memberId);
                block.u32(12, dispatch ? FUNC_DISPATCH : fn.funcKind);
                block.u32(16, fn.invokeKind);
                block.u32(20, fn.callingConvention);
                block.u16(24, fn.parameters.length);
                block.u16(26, fn.optionalParameters);
                block.u16(28, dispatch ? 0 : fn.vtableOffset);
                block.u16(48, fn.flags);
                writeElemDesc(block, 32, fn.returns, 0);
                if (fn.parameters.length > 0)
                {
                    const parameters = block.reserve(fn.parameters.length * ELEMDESC_BYTES);
                    block.pointer(8, parameters);
                    fn.parameters.forEach((parameter, at)=>writeElemDesc(
                        block, parameters + at * ELEMDESC_BYTES, parameter.type, parameter.flags));
                }
                const address = block.commit(host.heap, host.writeMemory);
                writeU32(out >>> 0, address);
                return address === 0 ? E_OUTOFMEMORY : S_OK;
            } },
        { name: 'GetVarDesc', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [index, out])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const variable = state.description.variables[index >>> 0];
                if (!variable)
                {
                    writeU32(out >>> 0, 0);
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                const block = new Block();
                block.reserve(VARDESC_BYTES);
                block.u32(0, variable.memberId);
                writeElemDesc(block, 12, variable.type, 0);
                block.u16(28, variable.flags);
                block.u32(32, variable.varKind);
                let bstr = 0;
                if (variable.constant)
                {
                    // A constant is a VARIANT the descriptor points at; a
                    // string one owns a BSTR, released with the descriptor.
                    const variant = block.reserve(VARIANT_BYTES);
                    block.pointer(8, variant);
                    block.u16(variant, variable.constant.vt);
                    const value = variable.constant.value;
                    if (typeof value === 'string')
                    {
                        bstr = host.allocateBstr(value);
                        block.u32(variant + 8, bstr);
                    }
                    else if (variable.constant.vt === VT_BSTR)
                    {
                        block.u32(variant + 8, 0);
                    }
                    else
                    {
                        const bytes = new Uint8Array(8);
                        const view = new DataView(bytes.buffer);
                        if (Number.isInteger(value))
                        {
                            view.setUint32(0, /** @type {number} */ (value) >>> 0, true);
                        }
                        else
                        {
                            view.setFloat64(0, /** @type {number} */ (value ?? 0), true);
                        }
                        block.put(variant + 8, bytes);
                    }
                }
                else
                {
                    block.u32(8, variable.offset);
                }
                const address = block.commit(host.heap, host.writeMemory);
                writeU32(out >>> 0, address);
                if (address === 0)
                {
                    host.freeBstr(bstr);
                    return E_OUTOFMEMORY;
                }
                if (bstr !== 0)
                {
                    state.bstrs.set(address, bstr);
                }
                return S_OK;
            } },
        { name: 'GetNames', argBytes: 20,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [memberId, names, max, count])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                const type = state.description;
                const fn = functionsOf(type).find(entry=>entry.memberId === (memberId | 0));
                const variable = fn ? null
                    : type.variables.find(entry=>entry.memberId === (memberId | 0));
                if (!fn && !variable)
                {
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                // The member's own name first, then its parameters', as many as
                // the caller has room for.
                const all = fn
                    ? [fn.name ?? '', ...fn.parameters.map(parameter=>parameter.name ?? '')]
                    : [variable?.name ?? ''];
                const given = all.slice(0, max >>> 0);
                for (let index = 0; index < given.length; index++)
                {
                    if (!giveString((names >>> 0) + index * WORD, given[index]))
                    {
                        return E_OUTOFMEMORY;
                    }
                }
                if ((count >>> 0) !== 0)
                {
                    writeU32(count >>> 0, given.length);
                }
                return S_OK;
            } },
        { name: 'GetRefTypeOfImplType', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [index, out])=>{
                /** @type {TypeInfoDescription} */
                const type = object.state.description;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                // Index -1 on a dual interface's dispinterface names the
                // vtable interface behind it: the same type, seen the other way.
                if (index === -1)
                {
                    if (type.kind !== TKIND_DISPATCH)
                    {
                        return TYPE_E_ELEMENTNOTFOUND;
                    }
                    writeU32(out >>> 0, DUAL_TWIN_HREFTYPE);
                    return S_OK;
                }
                const implemented = type.implementedTypes[index >>> 0];
                if (!implemented)
                {
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                writeU32(out >>> 0, implemented.hreftype);
                return S_OK;
            } },
        { name: 'GetImplTypeFlags', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [index, out])=>{
                const implemented = object.state.description.implementedTypes[index >>> 0];
                if (!implemented || (out >>> 0) === 0)
                {
                    return implemented ? E_INVALIDARG : TYPE_E_ELEMENTNOTFOUND;
                }
                writeU32(out >>> 0, implemented.flags);
                return S_OK;
            } },
        { name: 'GetIDsOfNames', argBytes: 16,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [names, count, out])=>
                getIDsOfNames(object.state.description, names >>> 0, count >>> 0, out >>> 0) },
        /**
         * HRESULT Invoke(PVOID pvInstance, MEMBERID memid, WORD wFlags,
         *     DISPPARAMS *pDispParams, VARIANT *pVarResult,
         *     EXCEPINFO *pExcepInfo, UINT *puArgErr)
         */
        { name: 'Invoke', argBytes: 32,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [instance, memid, flags, params, result, excepInfo, argErr])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                const type = state.description;
                if ((instance >>> 0) === 0 || (params >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const fn = invoker.find(functionsOf(type), memid | 0, flags & 0xffff);
                if (!fn)
                {
                    return DISP_E_MEMBERNOTFOUND;
                }
                return invoker.invoke(state.owner.library, type, fn, instance >>> 0,
                    flags & 0xffff, params >>> 0, result >>> 0, excepInfo >>> 0, argErr >>> 0);
            } },
        { name: 'GetDocumentation', argBytes: 24,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [memberId, name, doc, helpContext, helpFile])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                const type = state.description;
                /** @type {{ name: string | null, helpString: string | null } | undefined} */
                let described;
                if (memberId === MEMBERID_NIL)
                {
                    described = type;
                }
                else
                {
                    const variable = type.variables.find(entry=>entry.memberId === (memberId | 0));
                    described = functionsOf(type).find(entry=>entry.memberId === (memberId | 0))
                        ?? (variable ? { name: variable.name, helpString: null } : undefined);
                }
                if (!described)
                {
                    return TYPE_E_ELEMENTNOTFOUND;
                }
                if ((helpContext >>> 0) !== 0)
                {
                    writeU32(helpContext >>> 0, 0);
                }
                const given = giveString(name >>> 0, described.name)
                    && giveString(doc >>> 0, described.helpString)
                    && giveString(helpFile >>> 0, state.owner.library.helpFile);
                return given ? S_OK : E_OUTOFMEMORY;
            } },
        { name: 'GetDllEntry', argBytes: 24,
            /** @param {ComAdapter} object */
            invoke: object=>{
                host.divergence('ITypeInfo::GetDllEntry',
                    `${object.state.description.name} is not a module`);
                return E_NOTIMPL;
            } },
        { name: 'GetRefTypeInfo', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [hreftype, out])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (hreftype === DUAL_TWIN_HREFTYPE)
                {
                    // The vtable view of a dual interface: the same type.
                    object.addRef();
                    writeU32(out >>> 0, state.pointer);
                    return S_OK;
                }
                const pointer = referencedTypeInfo(state.owner, hreftype | 0);
                writeU32(out >>> 0, pointer);
                return pointer === 0 ? TYPE_E_CANTLOADLIBRARY : S_OK;
            } },
        { name: 'AddressOfMember', argBytes: 16,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out >>> 0, 0);
                }
                host.divergence('ITypeInfo::AddressOfMember',
                    `${object.state.description.name} is not a module`);
                return E_NOTIMPL;
            } },
        { name: 'CreateInstance', argBytes: 16,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out >>> 0, 0);
                }
                host.divergence('ITypeInfo::CreateInstance',
                    `${object.state.description.name}: no class factory is reachable `
                    + 'from a description');
                return E_NOTIMPL;
            } },
        { name: 'GetMops', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [, out])=>{
                writeU32(out >>> 0, 0);
                return S_OK;
            } },
        { name: 'GetContainingTypeLib', argBytes: 12,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [out, index])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                state.owner.object.addRef();
                writeU32(out >>> 0, state.owner.pointer);
                if ((index >>> 0) !== 0)
                {
                    writeU32(index >>> 0, state.description.index >>> 0);
                }
                return S_OK;
            } },
        { name: 'ReleaseTypeAttr', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [attr])=>{
                host.heap.free(attr >>> 0);
                return 0;
            } },
        { name: 'ReleaseFuncDesc', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [desc])=>{
                host.heap.free(desc >>> 0);
                return 0;
            } },
        { name: 'ReleaseVarDesc', argBytes: 8,
            /** @param {ComAdapter} object @param {number[]} args */
            invoke: (object, [desc])=>{
                /** @type {TypeInfoState} */
                const state = object.state;
                const bstr = state.bstrs.get(desc >>> 0);
                if (bstr !== undefined)
                {
                    host.freeBstr(bstr);
                    state.bstrs.delete(desc >>> 0);
                }
                host.heap.free(desc >>> 0);
                return 0;
            } },
    ]);

    return {
        open(library, path){
            /** @type {LibraryState} */
            const state = {
                library, path, pointer: 0, typeInfos: new Map(),
                object: /** @type {ComAdapter} */ (/** @type {unknown} */ (null)),
            };
            state.object = adapter(state, TYPELIB_METHODS, IID_ITYPELIB, ()=>{
                byPointer.delete(state.pointer);
            });
            state.pointer = host.publish(state.object, IID_ITYPELIB) >>> 0;
            if (state.pointer !== 0)
            {
                byPointer.set(state.pointer, state);
            }
            return state.pointer;
        },
        libraryAt: pointer=>byPointer.get(pointer >>> 0) ?? null,
        typeInfoAt(pointer){
            const state = typeInfosByPointer.get(pointer >>> 0);
            return state
                ? { getIDsOfNames: (names, count, out)=>
                    getIDsOfNames(state.description, names, count, out) }
                : null;
        },
    };
}

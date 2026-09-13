/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OLE Automation: the string type COM passes across an interface, and the
 * tagged union that carries a value of any type at all.
 *
 * Two things about this library decide whether anything built on it works.
 *
 * A BSTR is not the pointer it looks like. The caller holds a pointer to the
 * characters, and the byte count lives in the four bytes *before* that address,
 * with a terminator after the last character. So the block that is allocated
 * and the address that is handed out are not the same address, every length
 * question is answered from the prefix rather than by scanning, and a string
 * containing an embedded NUL -- which is legal, and is why the prefix exists --
 * survives a round trip. Get the prefix wrong and a program reads a length from
 * whatever the allocator happened to leave in front of the block.
 *
 * And it is imported by ordinal. A program of this era links oleaut32 through
 * numbers, with no name anywhere in its import table to fall back on, so the
 * table at the bottom of this file is as much a part of the contract as the
 * function bodies: a number bound to the wrong function is a call that succeeds
 * into the wrong code with no diagnostic anywhere.
 */

import { HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { readGuid } from '../ole32/guid.js';
import { createAdapter, createTypeLibraryObjects } from './objects.js';
import { createErrorInfoObjects } from './errorinfo.js';
import { parseTypeLib } from './typelib.js';

/** The prefix, in bytes, and where the caller's pointer sits relative to it. */
const PREFIX_BYTES = 4;

/** A VARIANT, and the offset of the union inside it. */
const VARIANT_BYTES = 16;
const VARIANT_VALUE = 8;

/** The variant types this build knows how to carry and convert. */
const VT_EMPTY = 0;
const VT_NULL = 1;
const VT_I2 = 2;
const VT_I4 = 3;
const VT_R4 = 4;
const VT_R8 = 5;
const VT_BSTR = 8;
const VT_DISPATCH = 9;
const VT_ERROR = 10;
const VT_BOOL = 11;
const VT_UNKNOWN = 13;
const VT_I1 = 16;
const VT_UI1 = 17;
const VT_UI2 = 18;
const VT_UI4 = 19;
const VT_INT = 22;
const VT_UINT = 23;

/**
 * A SAFEARRAY: where its bounds start, and the feature bits that say what
 * its elements own.
 */
const SAFEARRAY_BOUNDS = 16;
const FADF_BSTR = 0x100;
const FADF_UNKNOWN = 0x200;
const FADF_DISPATCH = 0x400;
const FADF_VARIANT = 0x800;

/** The two bits of a VARTYPE that are not the type. */
const VT_BYREF = 0x4000;
const VT_TYPEMASK = 0x0fff;

/**
 * VARIANT_TRUE is minus one, not one.
 *
 * A program tests `== VARIANT_TRUE` as often as it tests for non-zero, so a
 * boolean stored as 1 reads as neither true nor false to the code that asked.
 */
const VARIANT_TRUE = -1;
const VARIANT_FALSE = 0;

/** VariantChangeType's flags: only the one that changes an answer here. */
const VARIANT_ALPHABOOL = 0x0002;

/** HRESULTs this file produces. */
const S_OK = 0x00000000;
/** What GetErrorInfo answers when nothing has been set. */
const S_FALSE = 0x00000001;
const TYPE_E_CANTLOADLIBRARY = 0x80029c4a | 0;
const TYPE_E_LIBNOTREGISTERED = 0x8002801d | 0;
const TYPE_E_REGISTRYACCESS = 0x8002801c | 0;
const E_INVALIDARG = 0x80070057;
const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;
const DISP_E_TYPEMISMATCH = 0x80020005;
const DISP_E_PARAMNOTFOUND = 0x80020004 | 0;
const DISP_E_BADINDEX = 0x8002000b | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const DISP_E_BADVARTYPE = 0x80020008;
const DISP_E_OVERFLOW = 0x8002000a;

/**
 * @typedef {Object} AutomationHeap
 * @property {(bytes: number) => number} allocate  The address, or 0 if nothing fits.
 * @property {(address: number) => boolean} free
 */

/**
 * The volume, as far as loading a type library needs it: whether a path is a
 * file, and its bytes.
 *
 * @typedef {Object} AutomationFiles
 * @property {(path: string) => { exists: boolean, isDirectory: boolean, size: number } | null} stat
 * @property {(path: string, mode: { read: boolean }) => any} open
 * @property {(node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 * @property {(node: any) => void} close
 */

/**
 * The registry, as far as a type library's registration needs it: keys under
 * HKEY_CLASSES_ROOT, and one string value on each.
 *
 * @typedef {Object} AutomationHive
 * @property {(id: number) => any} root
 * @property {(key: any, path: string) => any} open
 * @property {(key: any, path: string) => { key: any }} create
 * @property {(key: any, path: string) => string} remove
 * @property {(key: any, name: string) => { type: number, data: Uint8Array } | null} getValue
 * @property {(key: any, name: string, type: number, data: Uint8Array) => void} setValue
 */

/**
 * @typedef {Object} AutomationHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {AutomationHeap} heap  Where a BSTR's block comes from.
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 *           Where "this call succeeded and did not do all of what it promises"
 *           goes. Said once per distinct difference by whoever receives it.
 * @property {AutomationFiles} [files]  Where LoadTypeLib reads from. Without
 *           it no library loads.
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 *           Puts an ITypeLib or ITypeInfo into guest memory.
 * @property {AutomationHive} [hive]  Where a library is registered.
 * @property {(entry: number, args: number[]) => Promise<number>} [call]
 *           A stdcall into guest code, which is what ITypeInfo::Invoke is.
 */

/**
 * What a variant holds, read out of guest memory before anything is freed.
 *
 * Materialised rather than read through, because a conversion is allowed to
 * write its answer over its own source: clearing the destination first would
 * free the very string the conversion is about to read.
 *
 * @typedef {Object} LoadedVariant
 * @property {number} type       The base VARTYPE, with VT_BYREF taken off.
 * @property {boolean} byref     Whether the variant held a reference.
 * @property {number} pointer    A BSTR or an interface pointer, else 0.
 * @property {number | null} number  The value as a number, where it is one.
 * @property {string | null} text    A BSTR's characters, read before any free.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * All stdcall, which is the bridge's default, so none of them says so.
 *
 * @param {AutomationHost} host
 */
export function createAutomationFunctions(host){
    const report = host.divergence ?? (()=>{});

    /** @param {number} address @param {number} length */
    const peek = (address, length)=>{
        const bytes = host.readMemory(address, length);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };

    /** @param {number} address */
    const readU16 = address=>peek(address, 2).getUint16(0, true);
    /** @param {number} address */
    const readU32 = address=>peek(address, 4).getUint32(0, true);

    /** @param {number} address @param {number} value */
    const writeU16 = (address, value)=>{
        const bytes = new Uint8Array(2);
        new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
        host.writeMemory(address, bytes);
    };

    /** The IErrorInfo a program last set and nothing has yet collected. */
    let heldErrorInfo = 0;

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /**
     * Allocates a BSTR over the given bytes of character data.
     *
     * The block is the prefix, the data and a two-byte terminator; the caller
     * is handed the address after the prefix. A byte count is what is stored,
     * even though the length a program usually asks for is in characters --
     * SysAllocStringByteLen exists precisely to make an odd one, and the
     * terminator is written whole either way.
     *
     * @param {Uint8Array} data
     * @returns {number} the BSTR, or 0 if it could not be allocated.
     */
    const allocateBstr = data=>{
        const block = host.heap.allocate(PREFIX_BYTES + data.length + 2);
        if (block === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array(PREFIX_BYTES + data.length + 2);
        new DataView(bytes.buffer).setUint32(0, data.length, true);
        bytes.set(data, PREFIX_BYTES);
        host.writeMemory(block, bytes);
        return block + PREFIX_BYTES;
    };

    /** @param {string} text @returns {Uint8Array} its UTF-16 code units */
    const encode = text=>{
        const bytes = new Uint8Array(text.length * 2);
        const data = new DataView(bytes.buffer);
        for (let index = 0; index < text.length; index++)
        {
            data.setUint16(index * 2, text.charCodeAt(index), true);
        }
        return bytes;
    };

    /** @param {number} bstr @returns {number} the byte count in its prefix */
    const byteLengthOf = bstr=>bstr === 0 ? 0 : readU32(bstr - PREFIX_BYTES);

    /**
     * A BSTR's characters, embedded NULs and all.
     *
     * Read from the prefix rather than to the first terminator: the length is
     * what makes a BSTR a BSTR, and a program that put a NUL in the middle of
     * one expects to get it back.
     *
     * @param {number} bstr
     */
    const readBstr = bstr=>{
        if (bstr === 0)
        {
            return '';
        }
        const units = byteLengthOf(bstr) >> 1;
        const bytes = host.readMemory(bstr, units * 2);
        let text = '';
        for (let index = 0; index < units; index++)
        {
            text += String.fromCharCode(bytes[index * 2] | (bytes[index * 2 + 1] << 8));
        }
        return text;
    };

    /** @param {number} bstr */
    const freeBstr = bstr=>{
        if (bstr !== 0)
        {
            host.heap.free(bstr - PREFIX_BYTES);
        }
    };

    /**
     * Copies `cch` characters from an OLECHAR buffer into a new BSTR.
     *
     * A NULL source is not a failure: the string is allocated to the length
     * asked for and left zeroed, which is what a program that is about to fill
     * the buffer itself is asking for.
     *
     * @param {number} source @param {number} cch
     */
    const allocateFrom = (source, cch)=>{
        const data = source === 0
            ? new Uint8Array(cch * 2)
            : host.readMemory(source, cch * 2).slice();
        return allocateBstr(data);
    };

    /** @param {number} address @returns {number} characters before the terminator */
    const lengthOfWide = address=>{
        let units = 0;
        while (readU16(address + units * 2) !== 0)
        {
            units++;
        }
        return units;
    };

    /**
     * The value at an address, read as the given type.
     *
     * @param {number} type @param {number} at
     * @returns {number | null} null when the type is not a number at all.
     */
    const numberAt = (type, at)=>{
        const data = peek(at, 8);
        switch (type)
        {
            case VT_EMPTY:
            case VT_NULL:
                return 0;
            case VT_I1:
                return data.getInt8(0);
            case VT_UI1:
                return data.getUint8(0);
            case VT_I2:
            case VT_BOOL:
                return data.getInt16(0, true);
            case VT_UI2:
                return data.getUint16(0, true);
            case VT_I4:
            case VT_INT:
            case VT_ERROR:
                return data.getInt32(0, true);
            case VT_UI4:
            case VT_UINT:
                return data.getUint32(0, true);
            case VT_R4:
                return data.getFloat32(0, true);
            case VT_R8:
                return data.getFloat64(0, true);
            default:
                return null;
        }
    };

    /**
     * Reads a variant out of guest memory.
     *
     * @param {number} pvar
     * @param {boolean} indirect  Whether to follow VT_BYREF to the value.
     * @returns {LoadedVariant | null} null when a reference points nowhere.
     */
    const load = (pvar, indirect)=>{
        const declared = readU16(pvar);
        const type = declared & VT_TYPEMASK;
        const byref = (declared & VT_BYREF) !== 0;
        const at = byref ? readU32(pvar + VARIANT_VALUE) : pvar + VARIANT_VALUE;
        if (byref && !indirect)
        {
            return { type, byref, pointer: at, number: null, text: null };
        }
        if (byref && at === 0)
        {
            return null;
        }
        if (type === VT_BSTR)
        {
            const bstr = readU32(at);
            return { type, byref: false, pointer: bstr, number: null, text: readBstr(bstr) };
        }
        if (type === VT_DISPATCH || type === VT_UNKNOWN)
        {
            return { type, byref: false, pointer: readU32(at), number: null, text: null };
        }
        return { type, byref: false, pointer: 0, number: numberAt(type, at), text: null };
    };

    /**
     * Empties a variant, releasing whatever it owned.
     *
     * @param {number} pvar
     */
    const clear = pvar=>{
        const declared = readU16(pvar);
        const type = declared & VT_TYPEMASK;
        if ((declared & VT_BYREF) === 0)
        {
            if (type === VT_BSTR)
            {
                freeBstr(readU32(pvar + VARIANT_VALUE));
            }
            else if (type === VT_DISPATCH || type === VT_UNKNOWN)
            {
                // The reference is dropped rather than released: Release lives
                // on a vtable in the guest, and calling back into it from here
                // is a re-entrancy this library does not have. Leaking a
                // reference keeps an object alive that should have died, which
                // is the safe direction -- releasing one we do not hold would
                // free an object still in use.
                report('OLE Automation',
                    'VariantClear does not Release the interface a variant held');
            }
        }
        host.writeMemory(pvar, new Uint8Array(VARIANT_BYTES));
    };

    /**
     * Writes a loaded value into a variant as the given type, converting.
     *
     * The destination is expected to have been cleared already.
     *
     * @param {number} pvar @param {number} type @param {LoadedVariant} value
     * @param {number} flags
     * @returns {number} an HRESULT
     */
    const store = (pvar, type, value, flags)=>{
        const at = pvar + VARIANT_VALUE;
        if (type === VT_EMPTY || type === VT_NULL)
        {
            writeU16(pvar, type);
            return S_OK;
        }
        if (type === VT_DISPATCH || type === VT_UNKNOWN)
        {
            if (value.type !== VT_DISPATCH && value.type !== VT_UNKNOWN)
            {
                return DISP_E_TYPEMISMATCH;
            }
            report('OLE Automation',
                'a variant carrying an interface is copied without an AddRef');
            writeU16(pvar, type);
            writeU32(at, value.pointer);
            return S_OK;
        }
        if (type === VT_BSTR)
        {
            const text = value.text ?? formatNumber(value, flags);
            if (text === null)
            {
                return DISP_E_TYPEMISMATCH;
            }
            const bstr = allocateBstr(encode(text));
            if (bstr === 0)
            {
                return E_OUTOFMEMORY;
            }
            writeU16(pvar, VT_BSTR);
            writeU32(at, bstr);
            return S_OK;
        }

        const number = value.text === null ? value.number : parseText(value.text);
        if (number === null || !Number.isFinite(number))
        {
            return DISP_E_TYPEMISMATCH;
        }
        const bytes = new Uint8Array(8);
        const data = new DataView(bytes.buffer);
        switch (type)
        {
            case VT_I1: data.setInt8(0, truncate(number)); break;
            case VT_UI1: data.setUint8(0, truncate(number)); break;
            case VT_I2: data.setInt16(0, truncate(number), true); break;
            case VT_UI2: data.setUint16(0, truncate(number), true); break;
            case VT_BOOL:
                data.setInt16(0, number !== 0 ? VARIANT_TRUE : VARIANT_FALSE, true);
                break;
            case VT_I4:
            case VT_INT:
            case VT_ERROR: data.setInt32(0, truncate(number), true); break;
            case VT_UI4:
            case VT_UINT: data.setUint32(0, truncate(number) >>> 0, true); break;
            case VT_R4: data.setFloat32(0, number, true); break;
            case VT_R8: data.setFloat64(0, number, true); break;
            default:
                report('OLE Automation', `no conversion to VARTYPE ${type}`);
                return DISP_E_BADVARTYPE;
        }
        // An integral target rounds rather than truncates, and a value that
        // will not fit is an overflow rather than a silent wrap.
        if (type !== VT_R4 && type !== VT_R8 && type !== VT_BOOL
            && !fits(type, truncate(number)))
        {
            return DISP_E_OVERFLOW;
        }
        writeU16(pvar, type);
        host.writeMemory(at, bytes);
        return S_OK;
    };

    /**
     * The integral value a conversion produces: rounded to nearest, halves away
     * from zero, which is what the automation conversions do rather than the
     * banker's rounding a naive implementation inherits from its language.
     *
     * @param {number} number
     */
    const truncate = number=>Math.sign(number) * Math.round(Math.abs(number));

    /** @param {number} type @param {number} number */
    const fits = (type, number)=>{
        switch (type)
        {
            case VT_I1: return number >= -128 && number <= 127;
            case VT_UI1: return number >= 0 && number <= 255;
            case VT_I2: return number >= -32768 && number <= 32767;
            case VT_UI2: return number >= 0 && number <= 65535;
            case VT_UI4:
            case VT_UINT: return number >= 0 && number <= 4294967295;
            default: return number >= -2147483648 && number <= 2147483647;
        }
    };

    /**
     * A number as a program expects to read it back.
     *
     * @param {LoadedVariant} value @param {number} flags
     * @returns {string | null}
     */
    const formatNumber = (value, flags)=>{
        if (value.number === null)
        {
            return null;
        }
        if (value.type === VT_BOOL)
        {
            // Windows spells a boolean as its number unless asked for words,
            // which is what VARIANT_ALPHABOOL asks for.
            const alpha = (flags & VARIANT_ALPHABOOL) !== 0;
            const truth = value.number !== 0;
            return alpha ? (truth ? 'True' : 'False') : (truth ? '-1' : '0');
        }
        if (value.type === VT_EMPTY || value.type === VT_NULL)
        {
            return '';
        }
        return String(value.number);
    };

    /**
     * The number a string holds, or null if it holds none.
     *
     * @param {string} text
     */
    const parseText = text=>{
        const trimmed = text.trim();
        if (trimmed === '')
        {
            return 0;
        }
        const number = Number(trimmed);
        return Number.isNaN(number) ? null : number;
    };

    /**
     * VariantChangeType and VariantChangeTypeEx, which differ only in taking a
     * locale this build has nothing to do with.
     *
     * @param {number} dest @param {number} src @param {number} flags @param {number} vt
     */
    const changeType = (dest, src, flags, vt)=>{
        if (dest === 0 || src === 0)
        {
            return E_INVALIDARG;
        }
        const type = vt & VT_TYPEMASK;
        if ((vt & VT_BYREF) !== 0)
        {
            return DISP_E_BADVARTYPE;
        }
        const value = load(src, true);
        if (value === null)
        {
            return DISP_E_TYPEMISMATCH;
        }
        clear(dest);
        return store(dest, type, value, flags);
    };

    const typeLibraries = host.vtables ? createTypeLibraryObjects({
        readMemory: host.readMemory,
        writeMemory: host.writeMemory,
        // The task allocator's heap and the BSTR heap are one heap here, so
        // a descriptor is freed by the Release that matches it either way.
        heap: host.heap,
        publish: (object, id)=>host.vtables?.publish(object, id) ?? 0,
        call: (entry, args)=>(host.call
            ? host.call(entry, args)
            : Promise.reject(new Error('no way to call guest code'))),
        clearVariant: clear,
        readBstr,
        allocateBstr: text=>allocateBstr(encode(text)),
        freeBstr,
        divergence: report,
    }) : null;

    const errorInfos = host.vtables ? createErrorInfoObjects({
        readMemory: host.readMemory,
        writeMemory: host.writeMemory,
        publish: (object, id)=>host.vtables?.publish(object, id) ?? 0,
        allocateBstr: text=>allocateBstr(encode(text)),
        adapt: (state, interfaces)=>createAdapter(state, interfaces),
    }) : null;

    /**
     * Reads a file whole off the volume; null when it is not there. The bytes
     * may still be on their way, in which case the caller parks on them.
     *
     * @param {string} path
     * @returns {Uint8Array | Promise<Uint8Array> | null}
     */
    const fileBytes = path=>{
        const files = host.files;
        if (!files)
        {
            return null;
        }
        const entry = files.stat(path);
        if (!entry?.exists || entry.isDirectory)
        {
            return null;
        }
        const node = files.open(path, { read: true });
        if (!node)
        {
            return null;
        }
        const bytes = files.read(node, 0, entry.size);
        if (bytes instanceof Promise)
        {
            return bytes.finally(()=>files.close(node));
        }
        files.close(node);
        return bytes;
    };

    /** @param {number} address @returns {string} the OLESTR there, or '' for NULL */
    const wideAt = address=>{
        if (address === 0)
        {
            return '';
        }
        const units = lengthOfWide(address);
        const bytes = host.readMemory(address, units * 2);
        let text = '';
        for (let index = 0; index < units; index++)
        {
            text += String.fromCharCode(bytes[index * 2] | (bytes[index * 2 + 1] << 8));
        }
        return text;
    };

    /**
     * Loads a library and puts its ITypeLib where the caller asked.
     *
     * @param {number} pathAddress  An OLESTR.
     * @param {number} out
     * @returns {number | Promise<number>} an HRESULT
     */
    const loadTypeLib = (pathAddress, out)=>{
        if (pathAddress === 0 || out === 0)
        {
            return E_INVALIDARG;
        }
        writeU32(out, 0);
        const path = wideAt(pathAddress);
        const bytes = fileBytes(path);
        if (bytes === null || !typeLibraries)
        {
            report('LoadTypeLib', typeLibraries
                ? `"${path}" is not there`
                : 'this build has nowhere to put an ITypeLib');
            return TYPE_E_CANTLOADLIBRARY;
        }
        /** @param {Uint8Array} data */
        const publish = data=>{
            let library;
            try
            {
                library = parseTypeLib(data);
            }
            catch (e){
                report('LoadTypeLib', `"${path}": ${e instanceof Error ? e.message : String(e)}`);
                return TYPE_E_CANTLOADLIBRARY;
            }
            const pointer = typeLibraries.open(library, path);
            writeU32(out, pointer);
            return pointer === 0 ? E_OUTOFMEMORY : S_OK;
        };
        return bytes instanceof Promise
            ? bytes.then(publish, ()=>TYPE_E_CANTLOADLIBRARY)
            : publish(bytes);
    };

    /**
     * The registry spells a version in hex, "1.0" for 1.0 and "a.0" for 10.0.
     *
     * @param {number} major @param {number} minor
     */
    const versionKey = (major, minor)=>`${major.toString(16)}.${minor.toString(16)}`;

    /**
     * The key a library is registered under, made or found.
     *
     * @param {string} guid @param {number} major @param {number} minor
     * @param {boolean} create
     */
    const registrationKey = (guid, major, minor, create)=>{
        const hive = host.hive;
        const root = hive?.root(HKEY_CLASSES_ROOT);
        if (!hive || !root)
        {
            return null;
        }
        const path = `TypeLib\\${guid}\\${versionKey(major, minor)}`;
        return create ? hive.create(root, path).key : hive.open(root, path);
    };

    /** @param {string} text @returns {Uint8Array} ANSI bytes, terminated */
    const ansi = text=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        return bytes;
    };

    /** The registered string type. */
    const REG_SZ = 1;

    /**
     * VariantCopy: a reference is copied as a reference, a string is
     * duplicated, and an interface pointer is copied as it is.
     *
     * @param {number} dest @param {number} src
     * @returns {number} an HRESULT
     */
    const copyVariant = (dest, src)=>{
        if (dest === 0 || src === 0)
        {
            return E_INVALIDARG;
        }
        if (dest === src)
        {
            return S_OK;
        }
        const declared = readU16(src);
        const type = declared & VT_TYPEMASK;
        const byref = (declared & VT_BYREF) !== 0;
        clear(dest);
        if (!byref && type === VT_BSTR)
        {
            const source = readU32(src + VARIANT_VALUE);
            const copy = source === 0
                ? 0
                : allocateBstr(host.readMemory(source, byteLengthOf(source)).slice());
            if (source !== 0 && copy === 0)
            {
                return E_OUTOFMEMORY;
            }
            writeU16(dest, VT_BSTR);
            writeU32(dest + VARIANT_VALUE, copy);
            return S_OK;
        }
        if (!byref && (type === VT_DISPATCH || type === VT_UNKNOWN))
        {
            report('OLE Automation',
                'a variant carrying an interface is copied without an AddRef');
        }
        host.writeMemory(dest, host.readMemory(src, VARIANT_BYTES).slice());
        return S_OK;
    };

    /**
     * A SAFEARRAY descriptor: the dimension count, the feature bits, the
     * element size, the lock count, the data, and one bound per dimension
     * -- stored last dimension first.
     *
     * @param {number} psa
     */
    const safeArrayAt = psa=>{
        if (psa === 0)
        {
            return null;
        }
        const dims = readU16(psa);
        const bounds = [];
        for (let index = 0; index < dims; index++)
        {
            const at = psa + SAFEARRAY_BOUNDS + index * 8;
            bounds.push({ elements: readU32(at), lower: readU32(at + 4) | 0 });
        }
        return {
            dims,
            features: readU16(psa + 2),
            elementBytes: readU32(psa + 4),
            locks: readU32(psa + 8),
            data: readU32(psa + 12),
            bounds,
        };
    };

    const registerTypeLib = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([ptlib, fullPath, helpDir])=>{
            const loaded = typeLibraries?.libraryAt(ptlib >>> 0) ?? null;
            if (!loaded)
            {
                return E_INVALIDARG;
            }
            const { library } = loaded;
            const hive = host.hive;
            const key = library.guid === null
                ? null
                : registrationKey(library.guid, library.majorVersion, library.minorVersion, true);
            if (!key || !hive)
            {
                return TYPE_E_REGISTRYACCESS;
            }
            hive.setValue(key, '', REG_SZ, ansi(library.helpString ?? library.name));
            const path = wideAt(fullPath >>> 0) || loaded.path;
            hive.setValue(hive.create(key, '0\\win32').key, '', REG_SZ, ansi(path));
            hive.setValue(hive.create(key, 'FLAGS').key, '', REG_SZ, ansi(String(library.flags)));
            const help = wideAt(helpDir >>> 0) || path.slice(0, path.lastIndexOf('\\'));
            hive.setValue(hive.create(key, 'HELPDIR').key, '', REG_SZ, ansi(help));
            return S_OK;
        },
    };

    return {
        /** BSTR SysAllocString(const OLECHAR *psz) */
        SysAllocString: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([psz])=>{
                const source = psz >>> 0;
                // Documented, and relied on: a NULL string allocates nothing
                // and answers NULL rather than an empty string.
                if (source === 0)
                {
                    return 0;
                }
                return allocateFrom(source, lengthOfWide(source));
            },
        },

        /** BSTR SysAllocStringLen(const OLECHAR *strIn, UINT ui) */
        SysAllocStringLen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([strIn, ui])=>allocateFrom(strIn >>> 0, ui >>> 0),
        },

        /**
         * BSTR SysAllocStringByteLen(LPCSTR psz, UINT len)
         *
         * The one entry point whose length is bytes rather than characters:
         * it is how ANSI text and raw bytes are carried in a BSTR, so nothing
         * here interprets what it copies.
         */
        SysAllocStringByteLen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([psz, len])=>{
                const source = psz >>> 0;
                const bytes = len >>> 0;
                const data = source === 0
                    ? new Uint8Array(bytes)
                    : host.readMemory(source, bytes).slice();
                return allocateBstr(data);
            },
        },

        /** INT SysReAllocString(BSTR *pbstr, const OLECHAR *psz) */
        SysReAllocString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pbstr, psz])=>{
                const slot = pbstr >>> 0;
                if (slot === 0)
                {
                    return 0;
                }
                const source = psz >>> 0;
                const replacement = source === 0
                    ? 0
                    : allocateFrom(source, lengthOfWide(source));
                if (source !== 0 && replacement === 0)
                {
                    return 0;
                }
                freeBstr(readU32(slot));
                writeU32(slot, replacement);
                return 1;
            },
        },

        /** INT SysReAllocStringLen(BSTR *pbstr, const OLECHAR *psz, UINT len) */
        SysReAllocStringLen: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pbstr, psz, len])=>{
                const slot = pbstr >>> 0;
                if (slot === 0)
                {
                    return 0;
                }
                const replacement = allocateFrom(psz >>> 0, len >>> 0);
                if (replacement === 0)
                {
                    return 0;
                }
                freeBstr(readU32(slot));
                writeU32(slot, replacement);
                return 1;
            },
        },

        /** void SysFreeString(BSTR bstrString) */
        SysFreeString: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([bstr])=>{
                // Documented as a no-op for NULL, so wrappers pass it on.
                freeBstr(bstr >>> 0);
                return 0;
            },
        },

        /** UINT SysStringLen(BSTR pbstr) — in characters */
        SysStringLen: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([bstr])=>byteLengthOf(bstr >>> 0) >>> 1,
        },

        /** UINT SysStringByteLen(BSTR bstr) — in bytes */
        SysStringByteLen: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([bstr])=>byteLengthOf(bstr >>> 0),
        },

        /** void VariantInit(VARIANTARG *pvarg) */
        VariantInit: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pvarg])=>{
                const variant = pvarg >>> 0;
                if (variant !== 0)
                {
                    // Documented as setting only the type. The union is zeroed
                    // too, because nothing may legitimately read the value of a
                    // VT_EMPTY variant and leaving the stack's leftovers there
                    // makes a wrong read look like a plausible one.
                    host.writeMemory(variant, new Uint8Array(VARIANT_BYTES));
                }
                return 0;
            },
        },

        /** HRESULT VariantClear(VARIANTARG *pvarg) */
        VariantClear: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pvarg])=>{
                const variant = pvarg >>> 0;
                if (variant === 0)
                {
                    return E_INVALIDARG;
                }
                clear(variant);
                return S_OK;
            },
        },

        /**
         * HRESULT VariantCopy(VARIANTARG *pvargDest, const VARIANTARG *pvargSrc)
         *
         * A reference is copied as a reference: only VariantCopyInd follows it.
         */
        VariantCopy: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pvargDest, pvargSrc])=>copyVariant(pvargDest >>> 0, pvargSrc >>> 0),
        },

        /** HRESULT VariantCopyInd(VARIANT *pvarDest, const VARIANTARG *pvargSrc) */
        VariantCopyInd: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pvarDest, pvargSrc])=>{
                const dest = pvarDest >>> 0;
                const src = pvargSrc >>> 0;
                if (dest === 0 || src === 0)
                {
                    return E_INVALIDARG;
                }
                const value = load(src, true);
                if (value === null)
                {
                    return E_INVALIDARG;
                }
                if (dest !== src)
                {
                    clear(dest);
                }
                else
                {
                    host.writeMemory(dest, new Uint8Array(VARIANT_BYTES));
                }
                return store(dest, value.type, value, 0);
            },
        },

        /**
         * HRESULT VariantChangeType(VARIANTARG *pvargDest,
         *     const VARIANTARG *pvarSrc, USHORT wFlags, VARTYPE vt)
         */
        VariantChangeType: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pvargDest, pvarSrc, wFlags, vt])=>
                changeType(pvargDest >>> 0, pvarSrc >>> 0, wFlags & 0xffff, vt & 0xffff),
        },

        /**
         * HRESULT VariantChangeTypeEx(VARIANTARG *pvargDest,
         *     const VARIANTARG *pvarSrc, LCID lcid, USHORT wFlags, VARTYPE vt)
         *
         * The locale decides how a number is spelled, and this build spells one
         * way; a program that asked for another gets the invariant form.
         */
        VariantChangeTypeEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([pvargDest, pvarSrc, lcid, wFlags, vt])=>{
                if ((lcid >>> 0) !== 0)
                {
                    report('OLE Automation',
                        'VariantChangeTypeEx ignores the locale and converts invariantly');
                }
                return changeType(pvargDest >>> 0, pvarSrc >>> 0, wFlags & 0xffff, vt & 0xffff);
            },
        },

        /**
         * HRESULT SetErrorInfo(ULONG dwReserved, IErrorInfo *perrinfo)
         * HRESULT GetErrorInfo(ULONG dwReserved, IErrorInfo **pperrinfo)
         *
         * The one error-information slot, per thread on Windows and one for
         * the process here, where a single thread makes these calls. Getting
         * it hands the interface over and clears the slot, which is why a
         * caller that gets it twice finds nothing the second time; a call
         * with no reference held answers S_FALSE with a null, the documented
         * shape a caller checks before it dereferences.
         */
        SetErrorInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, errorInfo])=>{
                heldErrorInfo = errorInfo >>> 0;
                return S_OK;
            },
        },

        GetErrorInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                const held = heldErrorInfo;
                heldErrorInfo = 0;
                if ((out >>> 0) !== 0)
                {
                    writeU32(out >>> 0, held);
                }
                return held === 0 ? S_FALSE : S_OK;
            },
        },

        /**
         * HRESULT LoadTypeLib(LPCOLESTR szFile, ITypeLib **pptlib)
         * HRESULT LoadTypeLibEx(LPCOLESTR szFile, REGKIND regkind, ITypeLib **pptlib)
         *
         * The file is read off the volume and parsed whole; what the caller
         * gets is an ITypeLib over the description. LoadTypeLib registers
         * nothing: a library is registered by whoever calls RegisterTypeLib,
         * and the Ex form's REGKIND_REGISTER asks for exactly that.
         */
        LoadTypeLib: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([file, out])=>loadTypeLib(file >>> 0, out >>> 0),
        },
        LoadTypeLibEx: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([file, regKind, out])=>{
                const REGKIND_REGISTER = 1;
                const loaded = loadTypeLib(file >>> 0, out >>> 0);
                if ((regKind >>> 0) !== REGKIND_REGISTER)
                {
                    return loaded;
                }
                /** @param {number} result */
                const register = result=>(result === S_OK
                    ? registerTypeLib.handler([readU32(out >>> 0), file, 0])
                    : result);
                return loaded instanceof Promise ? loaded.then(register) : register(loaded);
            },
        },

        /**
         * HRESULT LoadRegTypeLib(REFGUID, WORD wVerMajor, WORD wVerMinor, LCID, ITypeLib **)
         *
         * The registered path of that version of the library, then LoadTypeLib
         * on it. Only the exact version is found: a newer compatible one is
         * what Windows would fall back to, and nothing here has registered
         * more than one.
         */
        LoadRegTypeLib: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([guid, major, minor, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, 0);
                const key = registrationKey(
                    readGuid(host, guid >>> 0), major & 0xffff, minor & 0xffff, false);
                const win32 = key && host.hive ? host.hive.open(key, '0\\win32') : null;
                const value = win32 && host.hive ? host.hive.getValue(win32, '') : null;
                if (!value)
                {
                    return TYPE_E_LIBNOTREGISTERED;
                }
                let path = '';
                for (const byte of value.data)
                {
                    if (byte === 0)
                    {
                        break;
                    }
                    path += String.fromCharCode(byte);
                }
                const bstr = allocateBstr(encode(path));
                if (bstr === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const loaded = loadTypeLib(bstr, out >>> 0);
                /** @param {number} result */
                const done = result=>{
                    freeBstr(bstr);
                    return result;
                };
                return loaded instanceof Promise ? loaded.then(done) : done(loaded);
            },
        },

        /**
         * HRESULT RegisterTypeLib(ITypeLib *ptlib, LPCOLESTR szFullPath, LPCOLESTR szHelpDir)
         *
         * Writes the keys LoadRegTypeLib reads: the library's name as the
         * version key's default, the path under 0\win32, the flags and the
         * help directory beside it. The ITypeLib has to be one this library
         * handed out, because the description behind it is what is written.
         */
        RegisterTypeLib: registerTypeLib,

        /**
         * HRESULT UnRegisterTypeLib(REFGUID, WORD wVerMajor, WORD wVerMinor,
         *                           LCID lcid, SYSKIND syskind)
         *
         * Removes what RegisterTypeLib wrote, leaves down to the library key.
         */
        UnRegisterTypeLib: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([guid, major, minor])=>{
                const hive = host.hive;
                const root = hive?.root(HKEY_CLASSES_ROOT);
                if (!hive || !root)
                {
                    return TYPE_E_REGISTRYACCESS;
                }
                const id = readGuid(host, guid >>> 0);
                const version = `TypeLib\\${id}\\${versionKey(major & 0xffff, minor & 0xffff)}`;
                if (!hive.open(root, version))
                {
                    return TYPE_E_LIBNOTREGISTERED;
                }
                for (const path of [`${version}\\0\\win32`, `${version}\\0`,
                    `${version}\\FLAGS`, `${version}\\HELPDIR`, version])
                {
                    hive.remove(root, path);
                }
                hive.remove(root, `TypeLib\\${id}`);
                return S_OK;
            },
        },

        /**
         * UINT SafeArrayGetDim(SAFEARRAY *psa)
         * UINT SafeArrayGetElemsize(SAFEARRAY *psa)
         * HRESULT SafeArrayGetUBound(SAFEARRAY *psa, UINT nDim, LONG *plUbound)
         * HRESULT SafeArrayGetLBound(SAFEARRAY *psa, UINT nDim, LONG *plLbound)
         *
         * Read straight off the descriptor. Dimensions are numbered from one,
         * and the bounds are stored with the last dimension first, which is
         * why dimension n is bound (cDims - n).
         */
        SafeArrayGetDim: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([psa])=>safeArrayAt(psa >>> 0)?.dims ?? 0,
        },
        SafeArrayGetElemsize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([psa])=>safeArrayAt(psa >>> 0)?.elementBytes ?? 0,
        },
        SafeArrayGetUBound: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([psa, nDim, out])=>{
                const array = safeArrayAt(psa >>> 0);
                const bound = array?.bounds[array.dims - (nDim >>> 0)];
                if (!array || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (!bound)
                {
                    return DISP_E_BADINDEX;
                }
                writeU32(out >>> 0, bound.lower + bound.elements - 1);
                return S_OK;
            },
        },
        SafeArrayGetLBound: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([psa, nDim, out])=>{
                const array = safeArrayAt(psa >>> 0);
                const bound = array?.bounds[array.dims - (nDim >>> 0)];
                if (!array || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (!bound)
                {
                    return DISP_E_BADINDEX;
                }
                writeU32(out >>> 0, bound.lower);
                return S_OK;
            },
        },

        /**
         * HRESULT SafeArrayLock(SAFEARRAY *psa)
         * HRESULT SafeArrayUnlock(SAFEARRAY *psa)
         *
         * The lock count is what keeps the data where it is while a program
         * holds a pointer into it; nothing here moves data, so the count is
         * kept for the program's sake -- an unlock below zero is its error.
         */
        SafeArrayLock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([psa])=>{
                const array = safeArrayAt(psa >>> 0);
                if (!array)
                {
                    return E_INVALIDARG;
                }
                writeU32((psa >>> 0) + 8, array.locks + 1);
                return S_OK;
            },
        },
        SafeArrayUnlock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([psa])=>{
                const array = safeArrayAt(psa >>> 0);
                if (!array)
                {
                    return E_INVALIDARG;
                }
                if (array.locks === 0)
                {
                    return E_UNEXPECTED;
                }
                writeU32((psa >>> 0) + 8, array.locks - 1);
                return S_OK;
            },
        },

        /**
         * HRESULT SafeArrayCopy(SAFEARRAY *psa, SAFEARRAY **ppsaOut)
         *
         * A new descriptor and new data, unlocked. Elements that own something
         * are copied the way their type is copied: a string is duplicated, a
         * variant goes through VariantCopy, and an interface pointer is
         * copied as it is -- the reference it should carry is not taken,
         * which is the divergence VariantCopy already reports.
         */
        SafeArrayCopy: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([psa, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, 0);
                const array = safeArrayAt(psa >>> 0);
                if (!array)
                {
                    return E_INVALIDARG;
                }
                const descriptorBytes = SAFEARRAY_BOUNDS + array.dims * 8;
                const elements = array.bounds.reduce((total, bound)=>total * bound.elements, 1);
                const dataBytes = elements * array.elementBytes;
                const descriptor = host.heap.allocate(descriptorBytes);
                const data = dataBytes === 0 ? 0 : host.heap.allocate(dataBytes);
                if (descriptor === 0 || (dataBytes !== 0 && data === 0))
                {
                    host.heap.free(descriptor);
                    host.heap.free(data);
                    return E_OUTOFMEMORY;
                }
                const header = host.readMemory(psa >>> 0, descriptorBytes).slice();
                host.writeMemory(descriptor, header);
                writeU32(descriptor + 8, 0);
                writeU32(descriptor + 12, data);
                if (dataBytes !== 0)
                {
                    if ((array.features & FADF_VARIANT) !== 0)
                    {
                        host.writeMemory(data, new Uint8Array(dataBytes));
                        for (let index = 0; index < elements; index++)
                        {
                            copyVariant(data + index * VARIANT_BYTES,
                                array.data + index * VARIANT_BYTES);
                        }
                    }
                    else
                    {
                        host.writeMemory(data, host.readMemory(array.data, dataBytes).slice());
                        if ((array.features & FADF_BSTR) !== 0)
                        {
                            for (let index = 0; index < elements; index++)
                            {
                                const source = readU32(array.data + index * 4);
                                const copy = source === 0 ? 0 : allocateBstr(
                                    host.readMemory(source, byteLengthOf(source)).slice());
                                writeU32(data + index * 4, copy);
                            }
                        }
                        else if ((array.features & (FADF_UNKNOWN | FADF_DISPATCH)) !== 0)
                        {
                            report('OLE Automation',
                                'an array of interfaces is copied without an AddRef');
                        }
                    }
                }
                writeU32(out >>> 0, descriptor);
                return S_OK;
            },
        },

        /**
         * HRESULT DispGetParam(DISPPARAMS *pdispparams, UINT position, VARTYPE vtTarg,
         *                      VARIANT *pvarResult, UINT *puArgErr)
         *
         * The positional argument, converted to the type asked for. Named
         * arguments are what the position counts past: the positional ones
         * sit after them, in reverse.
         */
        DispGetParam: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([pdispparams, position, vtTarg, pvarResult, puArgErr])=>{
                const params = pdispparams >>> 0;
                if (params === 0 || (pvarResult >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const args = readU32(params);
                const count = readU32(params + 8);
                const named = readU32(params + 12);
                const positional = count - named;
                if ((position >>> 0) >= positional)
                {
                    return DISP_E_PARAMNOTFOUND;
                }
                const source = args + (count - 1 - (position >>> 0)) * VARIANT_BYTES;
                const result = changeType(pvarResult >>> 0, source, 0, vtTarg & 0xffff);
                if (result !== S_OK && (puArgErr >>> 0) !== 0)
                {
                    writeU32(puArgErr >>> 0, position >>> 0);
                }
                return result;
            },
        },

        /**
         * HRESULT DispGetIDsOfNames(ITypeInfo *ptinfo, OLECHAR **rgszNames,
         *                           UINT cNames, DISPID *rgdispid)
         *
         * ITypeInfo::GetIDsOfNames on the type information given, which has
         * to be one this library handed out.
         */
        DispGetIDsOfNames: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([ptinfo, rgszNames, cNames, rgdispid])=>{
                const typeInfo = typeLibraries?.typeInfoAt(ptinfo >>> 0) ?? null;
                if (!typeInfo)
                {
                    return E_INVALIDARG;
                }
                return typeInfo.getIDsOfNames(rgszNames >>> 0, cNames >>> 0, rgdispid >>> 0);
            },
        },

        /**
         * HRESULT OleCreatePropertyFrame(HWND hwndOwner, UINT x, UINT y,
         *   LPCOLESTR lpszCaption, ULONG cObjects, IUnknown **ppUnk,
         *   ULONG cPages, LPCLSID pPageClsID, LCID lcid, DWORD dwReserved,
         *   LPVOID pvReserved)
         *
         * The modal property sheet an embedded control puts its own settings
         * on, which this build cannot put up: the pages are dialogs belonging to
         * the control, reached through interfaces nothing here implements.
         *
         * Declared all the same, for the reason every refusal here is declared
         * rather than left to the loader's stub for a name nobody claims: that
         * stub pops nothing and this call pushes forty-four bytes, so a program
         * that offered its settings once would come back with a corrupted stack
         * and fail somewhere else entirely. The refusal is a documented answer a
         * caller checks; a stack four dozen bytes short is not.
         */
        OleCreatePropertyFrame: {
            argBytes: 44,
            handler: ()=>{
                report('Automation', 'OleCreatePropertyFrame cannot show a property'
                    + ' sheet: the pages belong to the object and are not implemented,'
                    + ' so the settings it offers cannot be changed');
                return E_NOTIMPL;
            },
        },

        /**
         * HRESULT CreateErrorInfo(ICreateErrorInfo **pperrinfo)
         *
         * A fresh, empty error object with one reference, the caller's.
         */
        CreateErrorInfo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const pointer = errorInfos?.create() ?? 0;
                writeU32(out >>> 0, pointer);
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },
    };
}

/**
 * Which ordinal is which export.
 *
 * Read off a real oleaut32's export directory rather than recalled, because a
 * program of this era imports this library by number alone: a wrong entry binds
 * a call to a different function, and there is no name in the import table for
 * any diagnostic to notice the difference by.
 *
 * The numbers are not contiguous because the library is not: everything between
 * these is a SafeArray, a Var* conversion or a type-library entry point that
 * this build does not export, and an ordinal exported while pointing at nothing
 * is a call that binds and then jumps into nowhere.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const OLEAUT32_ORDINALS = Object.freeze({
    2: 'SysAllocString',
    3: 'SysReAllocString',
    4: 'SysAllocStringLen',
    5: 'SysReAllocStringLen',
    6: 'SysFreeString',
    7: 'SysStringLen',
    8: 'VariantInit',
    9: 'VariantClear',
    10: 'VariantCopy',
    11: 'VariantCopyInd',
    12: 'VariantChangeType',
    147: 'VariantChangeTypeEx',
    149: 'SysStringByteLen',
    150: 'SysAllocStringByteLen',
    15: 'SafeArrayGetDim',
    16: 'SafeArrayGetElemsize',
    17: 'SafeArrayGetUBound',
    18: 'SafeArrayGetLBound',
    19: 'SafeArrayLock',
    20: 'SafeArrayUnlock',
    25: 'SafeArrayCopy',
    26: 'DispGetParam',
    27: 'DispGetIDsOfNames',
    161: 'LoadTypeLib',
    162: 'LoadRegTypeLib',
    163: 'RegisterTypeLib',
    183: 'LoadTypeLibEx',
    186: 'UnRegisterTypeLib',
    200: 'GetErrorInfo',
    201: 'SetErrorInfo',
    202: 'CreateErrorInfo',
    417: 'OleCreatePropertyFrame',
});

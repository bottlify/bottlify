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
import { TKIND_DISPATCH, TKIND_INTERFACE } from './typelib.js';
import { parseTypeLibrary } from './sltg.js';
import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';
import { findResource } from '../../loader/internal/resources.js';
import { compareStrings, decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { dateOf, fieldsOf, rollYear } from './dates.js';
import {
    compareExact, decimalBytes, exactOf, fitDecimal, readDecimal, round, roundNumber, toNumber,
} from './varmath.js';
import {
    add, and, divide, integerDivide, isOperandType, modulo, multiply, nearest,
    coerce, negate, not, or, subtract, variantValue, xor,
} from './arithmetic.js';
import {
    boolOf, dateFromText, exactOfNumber, numberOf, parseNumber, textOfCurrency, textOfDate,
    textOfExact, textOfReal,
} from './vartext.js';
import {
    DISP_E_BADVARTYPE, DISP_E_OVERFLOW, DISP_E_TYPEMISMATCH, VARIANT_FALSE, VARIANT_TRUE,
    VT_ARRAY, VT_BOOL, VT_BSTR, VT_BYREF, VT_CLSID, VT_CY, VT_DATE, VT_DECIMAL, VT_DISPATCH,
    VT_EMPTY, VT_ERROR, VT_I1, VT_I2, VT_I4, VT_I8, VT_INT, VT_NULL, VT_R4, VT_R8, VT_RESERVED,
    VT_RECORD, VT_TYPEMASK, VT_UI1, VT_UI2, VT_UI4, VT_UI8, VT_UINT, VT_UNKNOWN, VT_VARIANT,
    VT_VECTOR,
} from './vartypes.js';

/** The prefix, in bytes, and where the caller's pointer sits relative to it. */
const PREFIX_BYTES = 4;

/** A marshaled BSTR's element count, byte count and element count again. */
const WIRE_BSTR_HEADER = 12;

/** TYPEFLAG_* bits that make an interface one the universal marshaler carries. */
const TYPEFLAG_FDUAL = 0x40;
const TYPEFLAG_FOLEAUTOMATION = 0x100;

/** The universal marshaler's proxies: for a vtable interface, and for a dispinterface. */
const PSOAINTERFACE = '{00020424-0000-0000-C000-000000000046}';
const PSDISPATCH = '{00020420-0000-0000-C000-000000000046}';

/** A VARIANT, and the offset of the union inside it. */
const VARIANT_BYTES = 16;
const VARIANT_VALUE = 8;

/**
 * A SAFEARRAY: where its bounds start, and the feature bits that say what
 * its elements own.
 */
const SAFEARRAY_BOUNDS = 16;
const FADF_BSTR = 0x100;
const FADF_UNKNOWN = 0x200;
const FADF_DISPATCH = 0x400;
const FADF_VARIANT = 0x800;
const DISP_E_ARRAYISLOCKED = 0x8002000d | 0;

/**
 * How many bytes one element of each array type takes.
 *
 * @type {Readonly<Record<number, number>>}
 */
const ELEMENT_BYTES = Object.freeze({
    [VT_I2]: 2, [VT_I4]: 4, [VT_R4]: 4, [VT_R8]: 8, [VT_BSTR]: 4, [VT_DISPATCH]: 4,
    [VT_ERROR]: 4, [VT_BOOL]: 2, [VT_VARIANT]: VARIANT_BYTES, [VT_UNKNOWN]: 4, [VT_I1]: 1,
    [VT_UI1]: 1, [VT_UI2]: 2, [VT_UI4]: 4, [VT_INT]: 4, [VT_UINT]: 4, [VT_CY]: 8, [VT_DATE]: 8,
    [VT_I8]: 8, [VT_UI8]: 8, [VT_DECIMAL]: 16,
});

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
const E_POINTER = 0x80004003;
const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;
const DISP_E_PARAMNOTFOUND = 0x80020004 | 0;
const DISP_E_BADINDEX = 0x8002000b | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const DISPID_VALUE = 0;
/** IRecordInfo::RecordClear's place in the vtable. */
const RECORDINFO_RECORDCLEAR = 4;
const DISPATCH_PROPERTYGET = 2;

/**
 * NUMPARSE's fields (six 32-bit words) and the NUMPRS_* flags this build
 * recognises. dwInFlags says which forms the caller allows; dwOutFlags which
 * the string actually used.
 */
const NUMPARSE_C_DIG = 0;
const NUMPARSE_IN_FLAGS = 4;
const NUMPARSE_OUT_FLAGS = 8;
const NUMPARSE_CCH_USED = 12;
const NUMPARSE_BASE_SHIFT = 16;
const NUMPARSE_PWR10 = 20;
const NUMPRS_LEADING_WHITE = 0x0001;
const NUMPRS_TRAILING_WHITE = 0x0002;
const NUMPRS_LEADING_PLUS = 0x0004;
const NUMPRS_TRAILING_PLUS = 0x0008;
const NUMPRS_LEADING_MINUS = 0x0010;
const NUMPRS_TRAILING_MINUS = 0x0020;
const NUMPRS_HEX_OCT = 0x0040;
const NUMPRS_PARENS = 0x0080;
const NUMPRS_DECIMAL = 0x0100;
const NUMPRS_THOUSANDS = 0x0200;
const NUMPRS_CURRENCY = 0x0400;
const NUMPRS_EXPONENT = 0x0800;
const NUMPRS_USE_ALL = 0x1000;
const NUMPRS_NEG = 0x10000;
const NUMPRS_INEXACT = 0x20000;

/** The forms a string can take that this parser does not pull apart. */
const NUMPRS_UNPARSED = NUMPRS_TRAILING_PLUS | NUMPRS_TRAILING_MINUS | NUMPRS_HEX_OCT
    | NUMPRS_PARENS | NUMPRS_CURRENCY;

/** VarCmp's and VarBstrCmp's answers: less, equal, greater -- and null. */
const VARCMP_LT = 0;
const VARCMP_EQ = 1;
const VARCMP_GT = 2;
const VARCMP_NULL = 3;
/** VarCmp's flag for a comparison of text without case. */

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
 * @property {(address: number, value: number, length: number) => void} fillMemory
 *     Sets a range to one byte value in place, with no host buffer holding
 *     the pattern: the lengths are the program's, and a clear of a megabyte
 *     through writeMemory costs an allocation and two extra passes.
 * @property {AutomationHeap} heap  Where a BSTR's block comes from.
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 *           Where "this call succeeded and did not do all of what it promises"
 *           goes. Said once per distinct difference by whoever receives it.
 * @property {AutomationFiles} [files]  Where LoadTypeLib reads from. Without
 *           it no library loads.
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 *           Puts an ITypeLib or ITypeInfo into guest memory.
 * @property {AutomationHive} [hive]  Where a library is registered.
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} [call]
 *           A stdcall into guest code, which is what ITypeInfo::Invoke is, and
 *           an interface's AddRef and Release are.
 * @property {() => unknown} [callerThread]  The thread whose call this is.
 * @property {Map<unknown, number>} [errorSlots]  Each thread's error information,
 *           shared with whoever else sets or takes it for a thread.
 * @property {() => number} [systemTimeMs]  The guest's wall clock, milliseconds
 *           since 1970: the year a date written without one is in. Without it
 *           such a date is refused, and said so.
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
 * The references a copy takes and a clear gives back. They are the object's
 * own code, so they are called once the variant is written, in this order.
 *
 * @typedef {Object} Owed
 * @property {number[]} addRef
 * @property {number[]} release
 * @property {[number, number][]} recordClear  IRecordInfo and the record it empties
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

    /**
     * The IErrorInfo each thread last set and has not yet collected, by the
     * thread: one thread's error is not another's to find. An installer's
     * script engine reads the slot after every call it makes into a library
     * and fails the call when something is there -- a slot shared with its
     * other threads failed calls that had succeeded.
     *
     * @type {Map<unknown, number>}
     */
    const heldErrorInfo = host.errorSlots ?? new Map();

    /** @param {number} low @param {number} high */
    const doubleOf = (low, high)=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, low >>> 0, true);
        view.setUint32(4, high >>> 0, true);
        return view.getFloat64(0, true);
    };

    /** @param {number} address @param {number} value */
    const writeDouble = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value, true);
        host.writeMemory(address, bytes);
    };

    /** Signed words, as SYSTEMTIME's fields are read. @param {number} address @param {number} count */
    const readWords = (address, count)=>{
        const view = peek(address, count * 2);
        return Array.from({ length: count }, (_, index)=>view.getInt16(index * 2, true));
    };

    /** @param {number} address @param {number[]} words */
    const writeWords = (address, words)=>{
        const bytes = new Uint8Array(words.length * 2);
        const view = new DataView(bytes.buffer);
        words.forEach((word, index)=>view.setUint16(index * 2, word & 0xffff, true));
        host.writeMemory(address, bytes);
    };

    /**
     * A UDATE: SYSTEMTIME's eight words, then the day of the year.
     *
     * @param {import('./dates.js').Fields} fields
     */
    const udateWords = fields=>[fields.year, fields.month, fields.dayOfWeek, fields.day,
        fields.hour, fields.minute, fields.second, fields.milliseconds, fields.dayOfYear];

    /**
     * @typedef {Object} Operand
     * @property {number} type
     * @property {number | null} number
     * @property {import('./varmath.js').Exact | null} exact  a CY or DECIMAL
     * @property {string | null} text
     */

    /**
     * A variant as an operand of the arithmetic calls, a reference followed;
     * null for a type they take no operand of.
     *
     * @param {number} pvar
     * @returns {Operand | null}
     */
    const operand = pvar=>{
        const declared = readU16(pvar);
        const type = declared & VT_TYPEMASK;
        if ((declared & ~(VT_TYPEMASK | VT_BYREF | VT_RESERVED)) !== 0)
        {
            return null;
        }
        const byref = (declared & VT_BYREF) !== 0;
        const at = byref ? readU32(pvar + VARIANT_VALUE) : pvar + VARIANT_VALUE;
        if (at === 0)
        {
            return null;
        }
        /** @type {Operand} */
        const none = { type, number: null, exact: null, text: null };
        switch (type)
        {
            case VT_BSTR:
                try
                {
                    return { ...none, text: readBstr(readU32(at)) };
                }
                catch {
                    // A string pointer into nothing: no text to act on.
                    return null;
                }
            case VT_EMPTY:
            case VT_NULL:
                return { ...none, number: 0 };
            case VT_DATE:
                return { ...none, number: peek(at, 8).getFloat64(0, true) };
            case VT_CY:
                return { ...none, exact: { value: peek(at, 8).getBigInt64(0, true), scale: 4 } };
            case VT_DECIMAL:
                // A DECIMAL fills the variant, its reserved word over the type.
                return { ...none, exact: readDecimal(host.readMemory(byref ? at : pvar, 16)) };
            case VT_DISPATCH:
            case VT_UNKNOWN:
            case VT_ERROR:
                return none;
            default: {
                const number = numberAt(type, at);
                return number === null && type !== VT_NULL ? null : { ...none, number };
            }
        }
    };

    /**
     * A variant written whole: its type, and the value's bytes after it.
     *
     * @param {number} pvar @param {number} type @param {Uint8Array} value
     */
    const writeVariant = (pvar, type, value)=>{
        const bytes = new Uint8Array(VARIANT_BYTES);
        new DataView(bytes.buffer).setUint16(0, type, true);
        bytes.set(value.subarray(0, 8), VARIANT_VALUE);
        host.writeMemory(pvar, bytes);
        return S_OK;
    };

    /** @param {number} pvar @param {Uint8Array} decimal  its fourteen bytes past the type */
    const writeDecimal = (pvar, decimal)=>{
        const bytes = new Uint8Array(VARIANT_BYTES);
        new DataView(bytes.buffer).setUint16(0, VT_DECIMAL, true);
        bytes.set(decimal, 2);
        host.writeMemory(pvar, bytes);
        return S_OK;
    };

    /** @param {(view: DataView) => void} fill */
    const valueBytes = fill=>{
        const bytes = new Uint8Array(8);
        fill(new DataView(bytes.buffer));
        return bytes;
    };

    /** @param {bigint} value */
    const cyBytes = value=>valueBytes(view=>view.setBigInt64(0, BigInt.asIntN(64, value), true));

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
     * Empties a variant, freeing whatever it owned: a string at once, an
     * array as SafeArrayDestroy does, an interface by the Release put in
     * `owed`. An array that is locked stays in its variant, which is the
     * answer's to say.
     *
     * @param {number} pvar @param {Owed} owed
     * @returns {number} an HRESULT
     */
    const clear = (pvar, owed)=>{
        const declared = readU16(pvar);
        const type = declared & VT_TYPEMASK;
        if ((declared & VT_BYREF) === 0)
        {
            if ((declared & VT_ARRAY) !== 0)
            {
                const locked = destroyArray(readU32(pvar + VARIANT_VALUE), owed);
                if (locked !== S_OK)
                {
                    return locked;
                }
            }
            else if (type === VT_BSTR)
            {
                freeBstr(readU32(pvar + VARIANT_VALUE));
            }
            else if (type === VT_DISPATCH || type === VT_UNKNOWN)
            {
                const pointer = readU32(pvar + VARIANT_VALUE);
                if (pointer !== 0)
                {
                    owed.release.push(pointer);
                }
            }
            else if (type === VT_RECORD)
            {
                // The record is emptied by its own IRecordInfo, whose
                // reference the variant held, and the variant lets go of it.
                const record = readU32(pvar + VARIANT_VALUE);
                const info = readU32(pvar + VARIANT_VALUE + 4);
                if (info !== 0)
                {
                    owed.recordClear.push([info, record]);
                    owed.release.push(info);
                }
                writeU32(pvar + VARIANT_VALUE, 0);
            }
        }
        // Only the type changes: what was in the union stays where it was.
        writeU16(pvar, VT_EMPTY);
        return S_OK;
    };

    /**
     * `then` of an answer that may still be on its way, at once when it is not.
     *
     * @param {number | Promise<number>} answer
     * @param {(hr: number) => number | Promise<number>} then
     * @returns {number | Promise<number>}
     */
    const whenAnswered = (answer, then)=>(typeof answer === 'number' ? then(answer)
        : answer.then(then));

    /** @returns {Owed} */
    const nothingOwed = ()=>({ addRef: [], release: [], recordClear: [] });

    /**
     * Takes and gives back the references a call owes, one call into the
     * program at a time, on the thread whose call this is, then answers `hr`.
     * Every AddRef comes before any Release, so an object a variant is
     * copied over with itself is never let go of in between.
     *
     * @param {Owed} owed @param {unknown} thread @param {number} hr
     * @returns {number | Promise<number>}
     */
    const settle = (owed, thread, hr)=>{
        // The object, its vtable slot and the arguments after it.
        const calls = /** @type {[number, number, number[]][]} */ ([...owed.addRef.map(object=>[object, 1, []]),
            ...owed.recordClear.map(([info, record])=>[info, RECORDINFO_RECORDCLEAR, [record]]),
            ...owed.release.map(object=>[object, 2, []])]);
        if (calls.length === 0)
        {
            return hr;
        }
        const call = host.call;
        if (!call)
        {
            report('OLE Automation', 'an interface a variant takes or gives up is not counted');
            return hr;
        }
        return calls.reduce((before, [object, slot, rest])=>before.then(()=>
            call(readU32(readU32(object) + slot * 4), [object, ...rest], thread)),
        Promise.resolve(0)).then(()=>hr);
    };

    /**
     * Writes a loaded value into a variant as the given type, converting.
     *
     * The destination is expected to have been cleared already. An interface
     * is the variant's own reference, taken by the AddRef put in `owed`.
     *
     * @param {number} pvar @param {number} type @param {LoadedVariant} value
     * @param {number} flags @param {Owed} owed
     * @returns {number} an HRESULT
     */
    const store = (pvar, type, value, flags, owed)=>{
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
            if (type !== value.type)
            {
                report('OLE Automation', 'an interface converted between IUnknown and IDispatch'
                    + ' keeps its pointer rather than asking QueryInterface for the other');
            }
            if (value.pointer !== 0)
            {
                owed.addRef.push(value.pointer);
            }
            writeU16(pvar, type);
            writeU32(at, value.pointer);
            return S_OK;
        }
        if (type === VT_BSTR)
        {
            const text = value.text;
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

        // A string becomes a boolean as VarBoolFromStr reads one, True and False
        // included, and anything else as VarR8FromStr reads a number.
        const number = value.text === null ? value.number
            : type === VT_BOOL ? boolOf(value.text) : parseText(value.text);
        if (number === null || !Number.isFinite(number))
        {
            return DISP_E_TYPEMISMATCH;
        }
        const bytes = new Uint8Array(8);
        const data = new DataView(bytes.buffer);
        switch (type)
        {
            case VT_I1: data.setInt8(0, nearest(number)); break;
            case VT_UI1: data.setUint8(0, nearest(number)); break;
            case VT_I2: data.setInt16(0, nearest(number), true); break;
            case VT_UI2: data.setUint16(0, nearest(number), true); break;
            case VT_BOOL:
                data.setInt16(0, number !== 0 ? VARIANT_TRUE : VARIANT_FALSE, true);
                break;
            case VT_I4:
            case VT_INT:
            case VT_ERROR: data.setInt32(0, nearest(number), true); break;
            case VT_UI4:
            case VT_UINT: data.setUint32(0, nearest(number) >>> 0, true); break;
            case VT_R4: data.setFloat32(0, number, true); break;
            case VT_R8: data.setFloat64(0, number, true); break;
            default:
                report('OLE Automation', `no conversion to VARTYPE ${type}`);
                return DISP_E_BADVARTYPE;
        }
        // An integral target rounds rather than truncates -- a half to the even
        // neighbour, as VarI4FromR8 rounds 2.5 to 2 -- and a value that will
        // not fit is an overflow rather than a silent wrap.
        if (type !== VT_R4 && type !== VT_R8 && type !== VT_BOOL
            && !fits(type, nearest(number)))
        {
            return DISP_E_OVERFLOW;
        }
        writeU16(pvar, type);
        host.writeMemory(at, bytes);
        return S_OK;
    };

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
     * A value as VariantChangeType and the VarBstrFrom* functions spell it in
     * English: a boolean as its number -- 1 when it holds 1 -- unless
     * VARIANT_ALPHABOOL asks for words, a float to seven digits and a double to fifteen, a CY and a
     * DECIMAL exactly, a date as VarBstrFromDate spells it, EMPTY as nothing.
     *
     * @param {import('./arithmetic.js').Value} value @param {number} flags
     * @param {number} dateFlags  VAR_TIMEVALUEONLY or VAR_DATEVALUEONLY
     * @returns {string | number} the text, or the HRESULT
     */
    const spelled = (value, flags, dateFlags = 0)=>{
        switch (value.type)
        {
            case VT_EMPTY:
                return '';
            case VT_BOOL:
                if ((flags & VARIANT_ALPHABOOL) !== 0)
                {
                    return value.integer !== 0n ? 'True' : 'False';
                }
                return String(value.integer);
            case VT_R4:
                return textOfReal(Number(value.real), 7);
            case VT_R8:
                return textOfReal(Number(value.real), 15);
            case VT_DATE:
                return textOfDate(Number(value.real), dateFlags) ?? E_INVALIDARG;
            case VT_CY:
            case VT_DECIMAL:
                return textOfExact(/** @type {import('./varmath.js').Exact} */ (value.exact));
            case VT_BSTR:
                return String(value.text);
            default:
                return value.integer === null ? DISP_E_TYPEMISMATCH : String(value.integer);
        }
    };

    /**
     * The number a string holds, read as VarR8FromStr reads it in English, or
     * null if it holds none -- an empty or blank string included.
     *
     * @param {string} text
     */
    const parseText = text=>{
        const parsed = parseNumber(text);
        return parsed === null ? null : numberOf(parsed);
    };

    /**
     * VariantChangeType and VariantChangeTypeEx, which differ only in taking a
     * locale this build has nothing to do with. A number, a boolean, a date, a
     * CY or a DECIMAL is made by the conversion the Var<to>From<from>
     * functions make, an object's default value read first; the destination
     * is touched only once the conversion has succeeded, so a failure leaves
     * it as it was. An object is converted to its default value only when it
     * cannot answer by itself, which is answered after the program's Invoke.
     *
     * @param {number} dest @param {number} src @param {number} flags @param {number} vt
     * @param {Owed} owed @param {number} [lcid] @param {unknown} [thread]
     * @returns {number | Promise<number>}
     */
    const changeType = (dest, src, flags, vt, owed, lcid = 0, thread = undefined)=>{
        if (dest === 0 || src === 0)
        {
            return E_INVALIDARG;
        }
        const type = vt & VT_TYPEMASK;
        if (!isOperandType(type) || (vt & ~(VT_TYPEMASK | VT_BYREF | VT_ARRAY)) !== 0)
        {
            return DISP_E_BADVARTYPE;
        }
        // A reference to nothing is refused before a reference is as a target.
        const value = load(src, true);
        if (value === null)
        {
            return DISP_E_TYPEMISMATCH;
        }
        if ((vt & VT_BYREF) !== 0)
        {
            return DISP_E_BADVARTYPE;
        }
        // An error code and a null convert to nothing but their own type.
        if (type === VT_VARIANT || type === VT_RECORD
            || (type === VT_ERROR || value.type === VT_ERROR || value.type === VT_NULL)
                && value.type !== type)
        {
            return DISP_E_TYPEMISMATCH;
        }
        if (!CONVERTED.has(type) && (type !== VT_BSTR || value.type === VT_BSTR
            || value.type === VT_NULL))
        {
            if (!isVariantType(readU16(dest)))
            {
                return DISP_E_BADVARTYPE;
            }
            clear(dest, owed);
            return store(dest, type, value, flags, owed);
        }
        /** @param {import('./arithmetic.js').Value} from */
        const convert = from=>{
            const outcome = type === VT_BSTR ? bstrOutcome(spelled(from, flags))
                : from.type === VT_BSTR && type === VT_DATE ? dateOutcome(String(from.text))
                    : coerce(SAME_WIDTH.get(from.type)?.has(type) ? reinterpreted(from, type)
                        : from, type);
            if (typeof outcome === 'number')
            {
                return outcome;
            }
            if (!isVariantType(readU16(dest)))
            {
                return DISP_E_BADVARTYPE;
            }
            clear(dest, owed);
            return writeOutcome(dest, outcome);
        };
        if (value.type === VT_DISPATCH)
        {
            return defaultValue(value.pointer, lcid, thread, convert);
        }
        const read = readOperand(src);
        return typeof read === 'number' ? read : convert(read);
    };

    /**
     * The integral types VariantChangeType moves a value between by its bits
     * rather than its number: a signed type and the unsigned one of its width,
     * so VT_I1 -1 becomes VT_UI1 255 and VT_UI4 0xffffffff becomes VT_I4 -1,
     * where VarUI1FromI1 and VarI4FromUI4 refuse with an overflow.
     */
    const SAME_WIDTH = new Map([[VT_I1, new Set([VT_UI1])], [VT_UI1, new Set([VT_I1])],
        [VT_I2, new Set([VT_UI2])], [VT_UI2, new Set([VT_I2])],
        [VT_I4, new Set([VT_UI4, VT_UINT])], [VT_INT, new Set([VT_UI4, VT_UINT])],
        [VT_UI4, new Set([VT_I4, VT_INT])], [VT_UINT, new Set([VT_I4, VT_INT])]]);

    /**
     * @param {import('./arithmetic.js').Value} value @param {number} type
     * @returns {import('./arithmetic.js').Value}
     */
    const reinterpreted = (value, type)=>{
        const bits = value.type === VT_I1 || value.type === VT_UI1 ? 8
            : value.type === VT_I2 || value.type === VT_UI2 ? 16 : 32;
        const integer = /** @type {bigint} */ (value.integer);
        const signed = type === VT_I1 || type === VT_I2 || type === VT_I4 || type === VT_INT;
        return variantValue(type, { integer: signed ? BigInt.asIntN(bits, integer)
            : BigInt.asUintN(bits, integer) });
    };

    /**
     * The types VarCmp will not compare, whatever is beside them: Windows
     * refuses these even where every other call converts them, and an INT
     * only on the right.
     */
    const UNCOMPARED = new Set([VT_I1, VT_UI2, VT_UI4, VT_UI8, VT_UINT, VT_DISPATCH, VT_UNKNOWN,
        VT_VARIANT, VT_RECORD, VT_CLSID]);

    /**
     * VarCmp of two values read: VARCMP_LT, VARCMP_EQ, VARCMP_GT or
     * VARCMP_NULL, or the HRESULT refusing them.
     *
     * Text beside a number is greater whatever it says, unless VT_RESERVED is
     * on exactly one side: on the text, the number is spelled and the two
     * compared as text; on the number, the text is read as a number -- and
     * is greater still when it holds none. On both sides, text that reads as
     * a negative number is less, any other greater: Wine's vartest records
     * Windows so for every string it tries. EMPTY beside text is "". Two
     * numbers compare exactly where either is a CY or a DECIMAL, a double
     * as a float beside a float.
     *
     * @param {import('./arithmetic.js').Value} left
     * @param {import('./arithmetic.js').Value} right
     * @param {boolean[]} reserved  whether each side carried VT_RESERVED
     * @param {number} lcid @param {number} flags
     * @returns {number}
     */
    const compareValues = (left, right, reserved, lcid, flags)=>{
        if (left.flags !== 0 || right.flags !== 0)
        {
            return (left.flags | right.flags) & ~VT_ARRAY & ~VT_BYREF ? DISP_E_BADVARTYPE
                : DISP_E_TYPEMISMATCH;
        }
        if (!isVariantType(left.type) || !isVariantType(right.type))
        {
            return DISP_E_BADVARTYPE;
        }
        if (UNCOMPARED.has(left.type) || UNCOMPARED.has(right.type) || right.type === VT_INT)
        {
            return DISP_E_TYPEMISMATCH;
        }
        if (left.type === VT_ERROR || right.type === VT_ERROR)
        {
            return left.type === right.type
                ? orderOf(Number(left.integer), Number(right.integer)) : DISP_E_TYPEMISMATCH;
        }
        if (left.type === VT_NULL || right.type === VT_NULL)
        {
            return VARCMP_NULL;
        }
        const text = [left, right].map(side=>side.type === VT_BSTR);
        if (text[0] || text[1])
        {
            /** @param {import('./arithmetic.js').Value} side */
            const spell = side=>(side.type === VT_EMPTY ? '' : spelled(side, 0));
            if (text[0] && text[1] || left.type === VT_EMPTY || right.type === VT_EMPTY
                || reserved[text[0] ? 0 : 1] && !reserved[text[0] ? 1 : 0])
            {
                const a = spell(left);
                const b = spell(right);
                return typeof a === 'number' || typeof b === 'number' ? DISP_E_TYPEMISMATCH
                    : compareTexts(a, b, lcid, flags);
            }
            const string = String((text[0] ? left : right).text);
            if (reserved[0] && reserved[1])
            {
                // With the flag on both sides the text is greater still --
                // unless it is a negative number, which is less.
                const negative = (parseText(string) ?? 0) < 0;
                return text[0] === negative ? VARCMP_LT : VARCMP_GT;
            }
            const number = reserved[text[0] ? 1 : 0] ? parseText(string) : null;
            if (number === null)
            {
                return text[0] ? VARCMP_GT : VARCMP_LT;
            }
            const parsed = parseNumber(string);
            const exact = parsed && exactOfNumber(parsed);
            const read = exact ? variantValue(VT_DECIMAL, { exact })
                : variantValue(VT_R8, { real: number });
            return compareNumbers(text[0] ? read : left, text[0] ? right : read);
        }
        return compareNumbers(left, right);
    };

    /** @param {number | bigint | string} a @param {number | bigint | string} b */
    const orderOf = (a, b)=>(a < b ? VARCMP_LT : a > b ? VARCMP_GT : VARCMP_EQ);

    /**
     * Two numbers' order: exactly when either is a CY or a DECIMAL and both
     * can be had exactly, as whole numbers when both are, and otherwise as
     * doubles -- a double rounded to a float beside a float first, so a float
     * 1 equals a double 1+1e-8.
     *
     * @param {import('./arithmetic.js').Value} left
     * @param {import('./arithmetic.js').Value} right
     */
    const compareNumbers = (left, right)=>{
        /** @param {import('./arithmetic.js').Value} side */
        const real = side=>(side.real ?? (side.exact
            ? Number(side.exact.value) / 10 ** side.exact.scale : Number(side.integer ?? 0n)));
        if (left.exact !== null || right.exact !== null)
        {
            /** @param {import('./arithmetic.js').Value} side */
            const exact = side=>side.exact ?? (side.real !== null ? exactOf(side.real)
                : { value: side.integer ?? 0n, scale: 0 });
            const a = exact(left);
            const b = exact(right);
            if (a && b)
            {
                return compareExact(a, b) + 1;
            }
        }
        else if (left.real === null && right.real === null)
        {
            return orderOf(left.integer ?? 0n, right.integer ?? 0n);
        }
        const float = left.type === VT_R4 || right.type === VT_R4;
        const [a, b] = [left, right].map(side=>(float && side.real !== null
            ? Math.fround(side.real) : real(side)));
        return orderOf(a, b);
    };

    /**
     * Two strings' order as VarBstrCmp gives it: none and empty alike and
     * below anything else, then by the locale's collation, or by code units
     * where there is no locale.
     *
     * @param {string} a @param {string} b @param {number} lcid @param {number} flags
     */
    const compareTexts = (a, b, lcid, flags)=>{
        if (a === '' || b === '')
        {
            return orderOf(a.length, b.length);
        }
        if (lcid !== 0)
        {
            return compareStrings(a, b, flags) - 1;
        }
        return orderOf(a, b);
    };

    /** The types VarCat spells and joins. */
    const CATENATED = new Set([VT_EMPTY, VT_NULL, VT_I2, VT_I4, VT_R4, VT_R8, VT_CY, VT_DATE,
        VT_BSTR, VT_BOOL, VT_DECIMAL, VT_I1, VT_UI1, VT_UI2, VT_UI4, VT_I8, VT_UI8, VT_INT,
        VT_UINT]);

    /**
     * Why VarCat refuses two values, or S_OK: by Windows' table, as Wine's
     * vartest records it type pair by type pair -- an error code, a variant
     * and an interface are mismatches beside what VarCat spells, a type no
     * variant holds a bad type, and which of the two is answered depends on
     * the side.
     *
     * @param {import('./arithmetic.js').Value} left
     * @param {import('./arithmetic.js').Value} right
     */
    const catRefusal = (left, right)=>{
        const l = left.type;
        const r = right.type;
        const odd = new Set([VT_ERROR, VT_DATE, VT_DECIMAL]);
        if (left.flags !== 0 || right.flags !== 0)
        {
            return DISP_E_BADVARTYPE;
        }
        if (CATENATED.has(l) && CATENATED.has(r))
        {
            return S_OK;
        }
        if ([VT_DISPATCH, VT_UNKNOWN, VT_RECORD].some(type=>type === l || type === r))
        {
            return DISP_E_TYPEMISMATCH;
        }
        if (l === VT_VARIANT && odd.has(r) || r === VT_ERROR && l < 24
            || l === VT_ERROR && odd.has(r))
        {
            return DISP_E_TYPEMISMATCH;
        }
        if (odd.has(r))
        {
            return DISP_E_BADVARTYPE;
        }
        return l === VT_ERROR || r === VT_ERROR || l === VT_VARIANT
            || r === VT_VARIANT && CATENATED.has(l) ? DISP_E_TYPEMISMATCH : DISP_E_BADVARTYPE;
    };

    /**
     * Whether a VARTYPE is one a variant can hold, so that whatever it holds
     * can be cleared out of it: a base type of VT_EMPTY to VT_UINT but 15,
     * VT_RECORD or VT_CLSID, by value, by reference or as an array -- but
     * not a reference to or an array of nothing. A variant that is not is
     * left alone by everything that would clear it.
     *
     * @param {number} declared
     */
    const isVariantType = declared=>{
        const type = declared & VT_TYPEMASK;
        const flags = declared & ~VT_TYPEMASK;
        return (isOperandType(type) || type === VT_CLSID)
            && (flags & ~(VT_BYREF | VT_ARRAY)) === 0 && (flags === 0 || type > VT_NULL);
    };

    /** The types VariantChangeType makes by the shared conversion. */
    const CONVERTED = new Set([VT_I1, VT_UI1, VT_I2, VT_UI2, VT_I4, VT_UI4, VT_INT, VT_UINT,
        VT_I8, VT_UI8, VT_R4, VT_R8, VT_DATE, VT_CY, VT_DECIMAL, VT_BOOL]);

    /**
     * @param {string | number} text
     * @returns {import('./arithmetic.js').Outcome}
     */
    const bstrOutcome = text=>(typeof text === 'number' ? text : variantValue(VT_BSTR, { text }));

    /**
     * A string read as a date, as VarDateFromStr reads it.
     *
     * @param {string} text
     * @returns {import('./arithmetic.js').Outcome}
     */
    const dateOutcome = text=>{
        const date = dateFromText(text, 0, thisYear);
        return date === null ? DISP_E_TYPEMISMATCH : variantValue(VT_DATE, { real: date });
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
        clearVariant: pvar=>{
            const owed = nothingOwed();
            clear(pvar, owed);
            if (owed.release.length !== 0)
            {
                report('ITypeInfo::Invoke',
                    'an interface already in the result variant is overwritten without a Release');
            }
        },
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
     * The TYPELIB resource of an image, as LoadTypeLib reads a library an
     * executable or a DLL carries inside itself.
     *
     * @param {Uint8Array} file @param {number} index
     * @returns {Uint8Array}
     */
    const typeLibResource = (file, index)=>{
        const image = parsePe(file);
        const found = findResource(file, image, 'TYPELIB', index);
        if (!found)
        {
            throw new Error(`the image has no TYPELIB resource ${index}`);
        }
        const at = rvaToFileOffset(image, found.rva);
        return file.subarray(at, at + found.size);
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
        const named = wideAt(pathAddress);
        // A library inside an image is named by the image's path, and one past
        // the first by the image's path and \N, its TYPELIB resource number.
        const indexed = /^(.*)\\(\d+)$/.exec(named);
        const path = indexed && fileBytes(named) === null ? indexed[1] : named;
        const index = indexed && path !== named ? Number(indexed[2]) : 1;
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
                library = parseTypeLibrary(data[0] === 0x4d && data[1] === 0x5a
                    ? typeLibResource(data, index) : data);
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
    const ansi = text=>encodeAnsi(`${text}\0`);

    /** The registered string type. */
    const REG_SZ = 1;

    /**
     * VariantCopy: a reference is copied as a reference, a string and an
     * array are duplicated, and an interface pointer is shared, the copy
     * holding a reference of its own.
     *
     * @param {number} dest @param {number} src @param {Owed} owed
     * @returns {number} an HRESULT
     */
    const copyVariant = (dest, src, owed)=>{
        if (dest === 0 || src === 0)
        {
            return E_INVALIDARG;
        }
        const declared = readU16(src);
        // A source that is no variant type, or a CLSID -- which a variant may
        // be cleared of but never copied -- is refused, and so is a target
        // that could not be cleared.
        if (!isVariantType(declared) || (declared & VT_TYPEMASK) === VT_CLSID)
        {
            return DISP_E_BADVARTYPE;
        }
        if (dest === src)
        {
            return S_OK;
        }
        if (!isVariantType(readU16(dest)))
        {
            return DISP_E_BADVARTYPE;
        }
        const type = declared & VT_TYPEMASK;
        const byref = (declared & VT_BYREF) !== 0;
        clear(dest, owed);
        if (!byref && (declared & VT_ARRAY) !== 0)
        {
            // Two variants holding one array would each destroy it: what a
            // program that is told it has its own copy changes or frees must
            // not reach the other.
            const source = readU32(src + VARIANT_VALUE);
            const copy = source === 0 ? { hr: S_OK, descriptor: 0 } : copyArray(source, owed);
            if (copy.hr !== S_OK)
            {
                return copy.hr;
            }
            writeU16(dest, declared);
            writeU32(dest + VARIANT_VALUE, copy.descriptor);
            return S_OK;
        }
        if (!byref && type === VT_BSTR)
        {
            // No string at all is copied as an empty one.
            const source = readU32(src + VARIANT_VALUE);
            const copy = allocateBstr(source === 0 ? new Uint8Array(0)
                : host.readMemory(source, byteLengthOf(source)).slice());
            if (copy === 0)
            {
                return E_OUTOFMEMORY;
            }
            writeU16(dest, VT_BSTR);
            writeU32(dest + VARIANT_VALUE, copy);
            return S_OK;
        }
        if (!byref && (type === VT_DISPATCH || type === VT_UNKNOWN))
        {
            const pointer = readU32(src + VARIANT_VALUE);
            if (pointer !== 0)
            {
                owed.addRef.push(pointer);
            }
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

    /**
     * Where one element lives. The indices name the leftmost dimension
     * first, and it is the leftmost that varies fastest in the data.
     *
     * @param {number} psa @param {number} rgIndices
     * @returns {{ array: NonNullable<ReturnType<typeof safeArrayAt>>, address: number }
     *           | { error: number }}
     */
    const elementAt = (psa, rgIndices)=>{
        const array = safeArrayAt(psa);
        if (!array || rgIndices === 0)
        {
            return { error: E_INVALIDARG };
        }
        let offset = 0;
        let stride = 1;
        for (let dim = 0; dim < array.dims; dim++)
        {
            const bound = array.bounds[array.dims - 1 - dim];
            const index = readU32(rgIndices + dim * 4) | 0;
            if (index < bound.lower || index >= bound.lower + bound.elements)
            {
                return { error: DISP_E_BADINDEX };
            }
            offset += (index - bound.lower) * stride;
            stride *= bound.elements;
        }
        return { array, address: array.data + offset * array.elementBytes };
    };

    /**
     * Frees what one element owns, as SafeArrayDestroy frees each: a string
     * at once, a variant as VariantClear clears it, an interface by the
     * Release put in `owed`.
     *
     * @param {number} features @param {number} address @param {Owed} owed
     */
    const releaseElement = (features, address, owed)=>{
        if ((features & FADF_BSTR) !== 0)
        {
            freeBstr(readU32(address));
        }
        else if ((features & FADF_VARIANT) !== 0)
        {
            clear(address, owed);
        }
        else if ((features & (FADF_UNKNOWN | FADF_DISPATCH)) !== 0 && readU32(address) !== 0)
        {
            owed.release.push(readU32(address));
        }
    };

    /**
     * Gives an array back, as SafeArrayDestroy does: what its elements own
     * first, then its data and its descriptor. A locked array is its locker's
     * still.
     *
     * @param {number} psa @param {Owed} owed
     * @returns {number} an HRESULT
     */
    const destroyArray = (psa, owed)=>{
        const array = safeArrayAt(psa);
        if (!array)
        {
            return S_OK;
        }
        if (array.locks !== 0)
        {
            return DISP_E_ARRAYISLOCKED;
        }
        const elements = array.bounds.reduce((total, bound)=>total * bound.elements, 1);
        if (array.data !== 0)
        {
            for (let index = 0; index < elements; index++)
            {
                releaseElement(array.features, array.data + index * array.elementBytes, owed);
            }
            host.heap.free(array.data);
        }
        host.heap.free(psa);
        return S_OK;
    };

    /**
     * A new descriptor and new data for an array, unlocked. Elements that own
     * something are copied the way their type is copied: a string is
     * duplicated, a variant goes through VariantCopy, and an interface takes
     * a reference of its own, put in `owed`.
     *
     * @param {number} psa @param {Owed} owed
     * @returns {{ hr: number, descriptor: number }}
     */
    const copyArray = (psa, owed)=>{
        const array = safeArrayAt(psa);
        if (!array)
        {
            return { hr: E_INVALIDARG, descriptor: 0 };
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
            return { hr: E_OUTOFMEMORY, descriptor: 0 };
        }
        const header = host.readMemory(psa, descriptorBytes).slice();
        host.writeMemory(descriptor, header);
        writeU32(descriptor + 8, 0);
        writeU32(descriptor + 12, data);
        if (dataBytes !== 0)
        {
            if ((array.features & FADF_VARIANT) !== 0)
            {
                host.fillMemory(data, 0, dataBytes);
                for (let index = 0; index < elements; index++)
                {
                    copyVariant(data + index * VARIANT_BYTES, array.data + index * VARIANT_BYTES,
                        owed);
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
                    for (let index = 0; index < elements; index++)
                    {
                        const pointer = readU32(array.data + index * 4);
                        if (pointer !== 0)
                        {
                            owed.addRef.push(pointer);
                        }
                    }
                }
            }
        }
        return { hr: S_OK, descriptor };
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
            // Every interface the universal marshaler can carry is registered
            // to it, with the library that describes it: that is how a proxy
            // for one is found when it crosses into another process.
            const root = hive.root(HKEY_CLASSES_ROOT);
            for (const type of library.typeInfos)
            {
                const dual = (type.flags & TYPEFLAG_FDUAL) !== 0;
                const carried = type.kind === TKIND_DISPATCH || (type.kind === TKIND_INTERFACE
                    && (type.flags & (TYPEFLAG_FOLEAUTOMATION | TYPEFLAG_FDUAL)) !== 0);
                if (!carried || type.guid === null)
                {
                    continue;
                }
                const entry = hive.create(root, `Interface\\${type.guid}`).key;
                hive.setValue(entry, '', REG_SZ, ansi(type.name));
                const proxy = ansi(type.kind === TKIND_DISPATCH && !dual
                    ? PSDISPATCH : PSOAINTERFACE);
                hive.setValue(hive.create(entry, 'ProxyStubClsid').key, '', REG_SZ, proxy);
                hive.setValue(hive.create(entry, 'ProxyStubClsid32').key, '', REG_SZ, proxy);
                const reference = hive.create(entry, 'TypeLib').key;
                hive.setValue(reference, '', REG_SZ, ansi(library.guid ?? ''));
                hive.setValue(reference, 'Version', REG_SZ,
                    ansi(versionKey(library.majorVersion, library.minorVersion)));
            }
            return S_OK;
        },
    };

    /**
     * Says so when a conversion is asked for in a locale other than English,
     * which it reads and spells as English all the same.
     *
     * @param {string} api @param {number} lcid
     */
    const english = (api, lcid)=>{
        const language = lcid & 0x3ff;
        if (language !== 0 && language !== 0x09 && language !== 0x7f)
        {
            report(api, `locale ${lcid >>> 0} is read and spelled as English`);
        }
    };

    /**
     * A Var*FromStr: the string read in English and made by `convert` into the
     * bytes written through the out pointer, or the HRESULT it failed with. A
     * missing string holds no number -- DISP_E_TYPEMISMATCH, as Windows
     * answers -- and a missing out pointer is an invalid argument.
     *
     * @param {string} api
     * @param {(text: string, flags: number) => Uint8Array | number} convert
     */
    const fromString = (api, convert)=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([strIn, lcid, flags, out])=>{
            if ((strIn >>> 0) === 0)
            {
                return DISP_E_TYPEMISMATCH;
            }
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            english(api, lcid);
            const answer = convert(wideAt(strIn >>> 0), flags >>> 0);
            if (typeof answer === 'number')
            {
                return answer;
            }
            host.writeMemory(out >>> 0, answer);
            return S_OK;
        },
    });

    /**
     * A VarBstrFrom*: the value `spell` spells, in a new BSTR through the last
     * argument, or the HRESULT spelling it failed with. The out pointer is
     * required, E_POINTER without it.
     *
     * @param {number} argBytes @param {(args: number[]) => string | number} spell
     */
    const toBstr = (argBytes, spell)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            const out = args[argBytes / 4 - 1] >>> 0;
            if (out === 0)
            {
                return E_POINTER;
            }
            const text = spell(args);
            if (typeof text === 'number')
            {
                return text;
            }
            const bstr = allocateBstr(encode(text));
            writeU32(out, bstr);
            return bstr === 0 ? E_OUTOFMEMORY : S_OK;
        },
    });

    /** The year it is on the guest's clock, for a date written without one. */
    const thisYear = ()=>{
        if (!host.systemTimeMs)
        {
            report('VarDateFromStr', 'there is no clock to read, so a date written'
                + ' without its year is refused');
            return null;
        }
        return new Date(host.systemTimeMs()).getUTCFullYear();
    };

    /**
     * A variant as the operators read it: a reference followed -- to a
     * variant, that variant, one level deep -- and every type a variant can
     * hold, whether or not an operator takes it. Flag bits that cannot be
     * settled, and a type no variant holds, are left on the value for the
     * operator to refuse, since each refuses them in its own order.
     *
     * A string is read to its terminator, as Var*FromStr reads an OLECHAR
     * string: Windows converts one so, whatever its length prefix says, and
     * only a NUL inside a string VarAdd joins to another is lost by it.
     *
     * @param {number} pvar
     * @param {number} [ignored]  flag bits read past, as VarCmp reads VT_RESERVED
     * @returns {import('./arithmetic.js').Value | number} the value, or an HRESULT
     */
    const readOperand = (pvar, ignored = 0)=>{
        const declared = readU16(pvar) & ~ignored;
        let type = declared & VT_TYPEMASK;
        let flags = declared & ~VT_TYPEMASK;
        // A reference to an empty or a null is no reference a variant holds.
        const reference = flags === VT_BYREF && type > VT_NULL;
        // Where a DECIMAL's sixteen bytes start, and where any other value is.
        let base = pvar;
        let at = pvar + VARIANT_VALUE;
        try
        {
            const target = reference ? readU32(pvar + VARIANT_VALUE) : 0;
            if (target !== 0)
            {
                flags = 0;
                base = target;
                at = target;
                if (type === VT_VARIANT)
                {
                    const inner = readU16(target);
                    type = inner & VT_TYPEMASK;
                    flags = inner & ~VT_TYPEMASK;
                    at = target + VARIANT_VALUE;
                }
            }
            if (flags !== 0 || !isOperandType(type))
            {
                return variantValue(type, { flags, reference });
            }
            const payload = payloadAt(type, at, base);
            return payload === null ? E_INVALIDARG : variantValue(type, { reference, ...payload });
        }
        catch {
            // A reference, or a string, into memory that is not there: no value
            // to act on, refused as a reference to nothing is.
            return variantValue(type, { flags: VT_BYREF, reference });
        }
    };

    /**
     * What a variant of a type an operator can take holds, read at `at` -- or,
     * for a DECIMAL, which fills the variant, at `base`. null for a DECIMAL
     * with more places than one can have.
     *
     * @param {number} type @param {number} at @param {number} base
     * @returns {Partial<import('./arithmetic.js').Value> | null}
     */
    const payloadAt = (type, at, base)=>{
        switch (type)
        {
            case VT_BSTR:
                return { text: wideAt(readU32(at)) };
            case VT_R4:
                return { real: peek(at, 4).getFloat32(0, true) };
            case VT_R8:
            case VT_DATE:
                return { real: peek(at, 8).getFloat64(0, true) };
            case VT_CY:
                return { exact: { value: peek(at, 8).getBigInt64(0, true), scale: 4 } };
            case VT_DECIMAL: {
                const exact = readDecimal(host.readMemory(base, 16));
                return exact.scale > 28 ? null : { exact };
            }
            case VT_I8:
                return { integer: peek(at, 8).getBigInt64(0, true) };
            case VT_UI8:
                return { integer: peek(at, 8).getBigUint64(0, true) };
            default: {
                const number = numberAt(type, at);
                return { integer: number === null ? null : BigInt(number) };
            }
        }
    };

    /** The bytes an integral type's value takes in a variant. */
    const INTEGER_BYTES = new Map([[VT_I1, 1], [VT_UI1, 1], [VT_I2, 2], [VT_UI2, 2],
        [VT_BOOL, 2], [VT_I8, 8], [VT_UI8, 8]]);

    /**
     * An operator's answer written whole over the result variant -- which is
     * an out parameter, so nothing it held is freed -- or, for a failure, only
     * its type set to VT_EMPTY: Windows leaves the rest of it as it was.
     *
     * @param {number} pvar @param {import('./arithmetic.js').Outcome} outcome
     * @returns {number} an HRESULT
     */
    const writeOutcome = (pvar, outcome)=>{
        if (typeof outcome === 'number')
        {
            writeU16(pvar, VT_EMPTY);
            return outcome;
        }
        const { type, integer, real, exact, text } = outcome;
        switch (type)
        {
            case VT_EMPTY:
            case VT_NULL:
                return writeVariant(pvar, type, new Uint8Array(0));
            case VT_BSTR: {
                const bstr = allocateBstr(encode(String(text)));
                return bstr === 0 ? writeOutcome(pvar, E_OUTOFMEMORY)
                    : writeVariant(pvar, type, valueBytes(view=>view.setUint32(0, bstr, true)));
            }
            case VT_DECIMAL: {
                const bytes = exact && decimalBytes(exact);
                return bytes ? writeDecimal(pvar, bytes) : writeOutcome(pvar, DISP_E_OVERFLOW);
            }
            case VT_CY:
                return writeVariant(pvar, type, cyBytes(exact?.value ?? 0n));
            case VT_R4:
                return writeVariant(pvar, type,
                    valueBytes(view=>view.setFloat32(0, Number(real), true)));
            case VT_R8:
            case VT_DATE:
                return writeVariant(pvar, type,
                    valueBytes(view=>view.setFloat64(0, Number(real), true)));
            default: {
                const bits = 8 * (INTEGER_BYTES.get(type) ?? 4);
                return writeVariant(pvar, type, valueBytes(view=>view.setBigUint64(0,
                    BigInt.asUintN(bits, integer ?? 0n), true)));
            }
        }
    };

    /**
     * VarAdd and the other operators of two variants: both read before the
     * result is written, since a program may name one of them as the result.
     *
     * @param {(left: import('./arithmetic.js').Value,
     *     right: import('./arithmetic.js').Value) => import('./arithmetic.js').Outcome} operation
     */
    const binary = operation=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([pleft, pright, presult])=>{
            if ((pleft >>> 0) === 0 || (pright >>> 0) === 0 || (presult >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const left = readOperand(pleft >>> 0);
            const right = readOperand(pright >>> 0);
            return writeOutcome(presult >>> 0, typeof left === 'number' ? left
                : typeof right === 'number' ? right : operation(left, right));
        },
    });

    /**
     * VarNeg and VarNot.
     *
     * @param {(operand: import('./arithmetic.js').Value) => import('./arithmetic.js').Outcome}
     *     operation
     */
    const unary = operation=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([pin, presult])=>{
            if ((pin >>> 0) === 0 || (presult >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const value = readOperand(pin >>> 0);
            return writeOutcome(presult >>> 0,
                typeof value === 'number' ? value : operation(value));
        },
    });

    /**
     * An NDR user-marshal routine for a type whose wire form is not
     * implemented -- nor is the NDR engine that would call it (rpcrt4's
     * NdrClientCall2), so nothing here marshals across apartments. A proxy a
     * program registers binds it all the same; called, it says so, and the
     * value goes as nothing and comes back empty.
     *
     * @param {string} name @param {(args: number[]) => number | Promise<number>} answer
     */
    const noWireForm = (name, answer)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: args=>{
            report('OLE Automation', `${name}: the wire form of this type is not implemented,`
                + ' so it is marshaled as nothing');
            return answer(args);
        },
    });

    /**
     * How each type a Var<to>From<from> takes arrives on the stack -- its
     * VARTYPE and the bytes it takes there -- and how many bytes each type
     * the answer can be is written as. A DECIMAL arrives by pointer and a
     * string as an OLECHAR pointer, a locale and flags.
     */
    const CONVERSION_SOURCES = Object.freeze({
        I1: [VT_I1, 4], UI1: [VT_UI1, 4], I2: [VT_I2, 4], UI2: [VT_UI2, 4], I4: [VT_I4, 4],
        UI4: [VT_UI4, 4], I8: [VT_I8, 8], UI8: [VT_UI8, 8], R4: [VT_R4, 4], R8: [VT_R8, 8],
        Date: [VT_DATE, 8], Cy: [VT_CY, 8], Bool: [VT_BOOL, 4], Dec: [VT_DECIMAL, 4],
        Str: [VT_BSTR, 12],
    });
    const CONVERSION_TARGETS = Object.freeze({
        I1: [VT_I1, 1], UI1: [VT_UI1, 1], I2: [VT_I2, 2], UI2: [VT_UI2, 2], I4: [VT_I4, 4],
        UI4: [VT_UI4, 4], I8: [VT_I8, 8], UI8: [VT_UI8, 8], R4: [VT_R4, 4], R8: [VT_R8, 8],
        Date: [VT_DATE, 8], Cy: [VT_CY, 8], Bool: [VT_BOOL, 2], Dec: [VT_DECIMAL, 14],
    });

    /**
     * A Var<to>From<from>'s argument as a value, read by its type's width
     * and sign; a DECIMAL whose scale or sign byte no DECIMAL has is an
     * invalid argument, and a missing string holds no number.
     *
     * @param {number} type @param {number[]} args
     * @returns {import('./arithmetic.js').Value | number}
     */
    const argumentValue = (type, args)=>{
        const words = valueBytes(view=>{
            view.setUint32(0, args[0] >>> 0, true);
            view.setUint32(4, (args[1] ?? 0) >>> 0, true);
        });
        const view = new DataView(words.buffer);
        switch (type)
        {
            case VT_I1: return variantValue(type, { integer: BigInt(view.getInt8(0)) });
            case VT_UI1: return variantValue(type, { integer: BigInt(view.getUint8(0)) });
            case VT_I2:
            case VT_BOOL: return variantValue(type, { integer: BigInt(view.getInt16(0, true)) });
            case VT_UI2: return variantValue(type, { integer: BigInt(view.getUint16(0, true)) });
            case VT_I4: return variantValue(type, { integer: BigInt(args[0] | 0) });
            case VT_UI4: return variantValue(type, { integer: BigInt(args[0] >>> 0) });
            case VT_I8: return variantValue(type, { integer: view.getBigInt64(0, true) });
            case VT_UI8: return variantValue(type, { integer: view.getBigUint64(0, true) });
            case VT_R4: return variantValue(type, { real: view.getFloat32(0, true) });
            case VT_CY:
                return variantValue(type,
                    { exact: { value: view.getBigInt64(0, true), scale: 4 } });
            case VT_DECIMAL: {
                const bytes = host.readMemory(args[0] >>> 0, 16);
                return bytes[2] > 28 || (bytes[3] & 0x7f) !== 0 ? E_INVALIDARG
                    : variantValue(type, { exact: readDecimal(bytes) });
            }
            case VT_BSTR:
                return (args[0] >>> 0) === 0 ? DISP_E_TYPEMISMATCH
                    : variantValue(type, { text: wideAt(args[0] >>> 0) });
            default: return variantValue(type, { real: view.getFloat64(0, true) });
        }
    };

    /**
     * A converted value's bytes as its type is stored: a DECIMAL as the
     * fourteen past its reserved word.
     *
     * @param {import('./arithmetic.js').Value} value
     * @returns {Uint8Array}
     */
    const valueBytesOf = value=>{
        switch (value.type)
        {
            case VT_DECIMAL: return /** @type {Uint8Array} */ (
                decimalBytes(/** @type {import('./varmath.js').Exact} */ (value.exact)));
            case VT_CY: return cyBytes(value.exact?.value ?? 0n);
            case VT_R4: return valueBytes(view=>view.setFloat32(0, Number(value.real), true));
            case VT_R8:
            case VT_DATE: return valueBytes(view=>view.setFloat64(0, Number(value.real), true));
            default: return valueBytes(view=>view.setBigUint64(0,
                BigInt.asUintN(64, value.integer ?? 0n), true));
        }
    };

    /**
     * Every Var<to>From<from> between the numeric types, the boolean, DATE,
     * CY, DECIMAL and a string read as a number, by one conversion: the
     * one VariantChangeType makes. A date from a string is read as a date,
     * by VarDateFromStr below.
     *
     * @type {Record<string, { argBytes: number,
     *     handler: (args: number[]) => number | Promise<number> }>}
     */
    const conversions = {};
    for (const [to, [target, size]] of Object.entries(CONVERSION_TARGETS))
    {
        for (const [from, [source, width]] of Object.entries(CONVERSION_SOURCES))
        {
            if (to === from)
            {
                continue;
            }
            const api = `Var${to}From${from}`;
            conversions[api] = {
                argBytes: width + 4,
                handler: args=>{
                    const out = args[width / 4] >>> 0;
                    const value = argumentValue(source, args);
                    if (typeof value === 'number')
                    {
                        return value;
                    }
                    if (out === 0)
                    {
                        return E_INVALIDARG;
                    }
                    if (source === VT_BSTR)
                    {
                        english(api, args[1]);
                    }
                    // VarDecFromBool makes any true -1, where VariantChangeType
                    // keeps a boolean's 1 as 1.
                    if (source === VT_BOOL && target === VT_DECIMAL)
                    {
                        value.integer = value.integer === 0n ? 0n : -1n;
                    }
                    const outcome = coerce(value, target);
                    if (typeof outcome === 'number')
                    {
                        return outcome;
                    }
                    host.writeMemory(out + (target === VT_DECIMAL ? 2 : 0),
                        valueBytesOf(outcome).subarray(0, size));
                    return S_OK;
                },
            };
        }
    }

    /**
     * An object's value, as every conversion from VT_DISPATCH reads it: its
     * default property, got by IDispatch::Invoke(DISPID_VALUE,
     * DISPATCH_PROPERTYGET) with no arguments, and then converted as `then`
     * converts it. An object that will not answer is a mismatch, whatever it
     * failed with.
     *
     * @param {number} dispatch @param {number} lcid @param {unknown} thread
     * @param {(value: import('./arithmetic.js').Value) => number} then
     * @returns {number | Promise<number>}
     */
    const defaultValue = (dispatch, lcid, thread, then)=>{
        const call = host.call;
        if (dispatch === 0 || !call)
        {
            return DISP_E_TYPEMISMATCH;
        }
        // The result variant, the empty DISPPARAMS and IID_NULL, zeroed.
        const block = host.heap.allocate(48);
        if (block === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(block, new Uint8Array(48));
        const invoke = readU32(readU32(dispatch) + 6 * 4);
        return call(invoke, [dispatch, DISPID_VALUE, block + 32, lcid >>> 0,
            DISPATCH_PROPERTYGET, block + 16, block, 0, 0], thread).then(hr=>{
            const value = (hr | 0) < 0 ? DISP_E_TYPEMISMATCH : readOperand(block);
            const answer = typeof value === 'number' ? value : then(value);
            const owed = nothingOwed();
            clear(block, owed);
            return settle(owed, thread, answer);
        }).finally(()=>host.heap.free(block));
    };

    for (const [to, [target, size]] of Object.entries(CONVERSION_TARGETS))
    {
        /** HRESULT Var<to>FromDisp(IDispatch *pdispIn, LCID lcid, <to> *pOut) */
        conversions[`Var${to}FromDisp`] = {
            argBytes: 12,
            handler: ([dispatch, lcid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                return defaultValue(dispatch >>> 0, lcid, host.callerThread?.(), value=>{
                    const outcome = coerce(value, target);
                    if (typeof outcome === 'number')
                    {
                        return outcome;
                    }
                    host.writeMemory((out >>> 0) + (target === VT_DECIMAL ? 2 : 0),
                        valueBytesOf(outcome).subarray(0, size));
                    return S_OK;
                });
            },
        };
    }

    /**
     * VarCy* and VarDec*: the operators over two CYs or two DECIMALs, an
     * answer of the same type, each argument arriving as Var<to>From<from>'s
     * do. An answer is written only when there is one.
     *
     * @param {number} type  VT_CY or VT_DECIMAL
     * @param {[number, number][]} widths  each operand's VARTYPE and stack bytes, in order
     * @param {(...operands: import('./arithmetic.js').Value[]) =>
     *     import('./arithmetic.js').Outcome} operation
     */
    const exactOperation = (type, widths, operation)=>{
        const argBytes = widths.reduce((sum, [, bytes])=>sum + bytes, 4);
        return {
            argBytes,
            /** @param {number[]} args */
            handler: args=>{
                const out = args[argBytes / 4 - 1] >>> 0;
                /** @type {import('./arithmetic.js').Value[]} */
                const operands = [];
                let at = 0;
                for (const [operandType, bytes] of widths)
                {
                    const value = operandType === VT_I4
                        ? variantValue(VT_I4, { integer: BigInt(args[at] | 0) })
                        : argumentValue(operandType, args.slice(at, at + bytes / 4));
                    if (typeof value === 'number')
                    {
                        return value;
                    }
                    operands.push(value);
                    at += bytes / 4;
                }
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                const answer = operation(...operands);
                const outcome = typeof answer === 'number' ? answer : coerce(answer, type);
                if (typeof outcome === 'number')
                {
                    return outcome;
                }
                host.writeMemory(out + (type === VT_DECIMAL ? 2 : 0),
                    valueBytesOf(outcome).subarray(0, type === VT_DECIMAL ? 14 : 8));
                return S_OK;
            },
        };
    };

    /**
     * A CY or a DECIMAL cut to a whole number: towards zero for Fix, down
     * for Int.
     *
     * @param {boolean} down
     * @returns {(value: import('./arithmetic.js').Value) => import('./arithmetic.js').Value}
     */
    const whole = down=>value=>{
        const { value: units, scale } = /** @type {import('./varmath.js').Exact} */ (value.exact);
        const unit = 10n ** BigInt(scale);
        const cut = units / unit - (down && units < 0n && units % unit !== 0n ? 1n : 0n);
        return variantValue(value.type, { exact: { value: cut, scale: 0 } });
    };

    /**
     * A CY or a DECIMAL rounded to `places`, a half to the even neighbour;
     * fewer than none is an invalid argument.
     *
     * @param {import('./arithmetic.js').Value} value @param {import('./arithmetic.js').Value} places
     * @returns {import('./arithmetic.js').Outcome}
     */
    const roundExact = (value, places)=>(Number(places.integer) < 0 ? E_INVALIDARG
        : variantValue(value.type, { exact: round(
            /** @type {import('./varmath.js').Exact} */ (value.exact), Number(places.integer)) }));

    /**
     * VarCyCmp, VarCyCmpR8, VarDecCmp and VarDecCmpR8: VARCMP_LT, VARCMP_EQ
     * or VARCMP_GT, a double first made the left side's type.
     *
     * @param {number} type @param {[number, number][]} widths
     */
    const exactComparison = (type, widths)=>{
        const argBytes = widths.reduce((sum, [, bytes])=>sum + bytes, 0);
        return {
            argBytes,
            /** @param {number[]} args */
            handler: args=>{
                const left = argumentValue(type, args.slice(0, widths[0][1] / 4));
                const read = argumentValue(widths[1][0], args.slice(widths[0][1] / 4));
                if (typeof left === 'number' || typeof read === 'number')
                {
                    return typeof left === 'number' ? left : read;
                }
                const right = coerce(read, type);
                if (typeof right === 'number')
                {
                    return right;
                }
                const order = compareExact(/** @type {import('./varmath.js').Exact} */ (left.exact),
                    /** @type {import('./varmath.js').Exact} */ (right.exact));
                return order < 0 ? VARCMP_LT : order > 0 ? VARCMP_GT : VARCMP_EQ;
            },
        };
    };

    /**
     * VarDecAbs and VarDecNeg: the DECIMAL copied with its sign byte changed,
     * nothing else checked -- a sign of 0x7f negates to 0xff, a scale of 29
     * stays -- and zero negated is a negative zero.
     *
     * @param {(sign: number) => number} change
     */
    const decimalSign = change=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([pin, pout])=>{
            if ((pin >>> 0) === 0 || (pout >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const bytes = host.readMemory(pin >>> 0, 16).slice();
            bytes[3] = change(bytes[3]);
            host.writeMemory((pout >>> 0) + 2, bytes.subarray(2));
            return S_OK;
        },
    });

    /**
     * VarDecFix, VarDecInt and VarDecRound: worked on the magnitude, the sign
     * kept as it was even where the answer is zero -- -0.1 rounds to -0.
     *
     * @param {number} argCount
     * @param {(magnitude: bigint, scale: number, negative: boolean, places: number) =>
     *     import('./varmath.js').Exact | number} operation
     */
    const decimalMagnitude = (argCount, operation)=>({
        argBytes: argCount * 4,
        /** @param {number[]} args */
        handler: args=>{
            const out = args[argCount - 1] >>> 0;
            const value = argumentValue(VT_DECIMAL, args);
            if (typeof value === 'number')
            {
                return value;
            }
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            const sign = host.readMemory(args[0] >>> 0, 4)[3];
            const exact = /** @type {import('./varmath.js').Exact} */ (value.exact);
            const magnitude = exact.value < 0n ? -exact.value : exact.value;
            const answer = operation(magnitude, exact.scale, sign !== 0, args[1] | 0);
            if (typeof answer === 'number')
            {
                return answer;
            }
            const bytes = decimalBytes(answer);
            if (!bytes)
            {
                return DISP_E_OVERFLOW;
            }
            bytes[1] = sign;
            host.writeMemory(out + 2, bytes);
            return S_OK;
        },
    });

    /** @type {[number, number]} */
    const CY = [VT_CY, 8];
    /** @type {[number, number]} */
    const DEC = [VT_DECIMAL, 4];
    /** @type {[number, number]} */
    const PLACES = [VT_I4, 4];
    /** @type {[number, number]} */
    const I8 = [VT_I8, 8];
    /** @type {[number, number]} */
    const R8 = [VT_R8, 8];
    Object.assign(conversions, {
        VarCyAdd: exactOperation(VT_CY, [CY, CY], add),
        VarCySub: exactOperation(VT_CY, [CY, CY], subtract),
        VarCyMul: exactOperation(VT_CY, [CY, CY], multiply),
        VarCyMulI4: exactOperation(VT_CY, [CY, PLACES], multiply),
        VarCyMulI8: exactOperation(VT_CY, [CY, I8], multiply),
        VarCyAbs: exactOperation(VT_CY, [CY], value=>(/** @type {import('./varmath.js').Exact} */
            (value.exact).value < 0n ? negate(value) : value)),
        VarCyNeg: exactOperation(VT_CY, [CY], negate),
        VarCyFix: exactOperation(VT_CY, [CY], whole(false)),
        VarCyInt: exactOperation(VT_CY, [CY], whole(true)),
        VarCyRound: exactOperation(VT_CY, [CY, PLACES], roundExact),
        VarCyCmp: exactComparison(VT_CY, [CY, CY]),
        VarCyCmpR8: exactComparison(VT_CY, [CY, R8]),
        VarDecAdd: exactOperation(VT_DECIMAL, [DEC, DEC], add),
        VarDecSub: exactOperation(VT_DECIMAL, [DEC, DEC], subtract),
        VarDecMul: exactOperation(VT_DECIMAL, [DEC, DEC], multiply),
        VarDecDiv: exactOperation(VT_DECIMAL, [DEC, DEC], divide),
        VarDecAbs: decimalSign(sign=>sign & 0x7f),
        VarDecNeg: decimalSign(sign=>sign ^ 0x80),
        VarDecFix: decimalMagnitude(2, (magnitude, scale)=>({
            value: magnitude / 10n ** BigInt(scale), scale: 0 })),
        VarDecInt: decimalMagnitude(2, (magnitude, scale, negative)=>{
            const unit = 10n ** BigInt(scale);
            return { value: magnitude / unit + (negative && magnitude % unit !== 0n ? 1n : 0n),
                scale: 0 };
        }),
        VarDecRound: decimalMagnitude(3, (magnitude, scale, negative, places)=>(
            places < 0 ? E_INVALIDARG : round({ value: magnitude, scale }, places))),
        VarDecCmp: exactComparison(VT_DECIMAL, [DEC, DEC]),
        VarDecCmpR8: exactComparison(VT_DECIMAL, [DEC, R8]),

        /** HRESULT VarR8Round(double dblIn, int nDig, double *pDblOut) */
        VarR8Round: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([low, high, places, out])=>{
                if ((places | 0) < 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeDouble(out >>> 0, roundNumber(doubleOf(low, high), places | 0));
                return S_OK;
            },
        },
    });

    /**
     * VarBstrFrom<from> for the types without a spelling of their own below:
     * the text VariantChangeType makes of the value.
     */
    for (const [from, [source, width]] of Object.entries(CONVERSION_SOURCES))
    {
        if (source !== VT_BSTR)
        {
            /** HRESULT VarBstrFrom<from>(<from> in, LCID lcid, ULONG dwFlags, BSTR *pbstrOut) */
            conversions[`VarBstrFrom${from}`] = toBstr(width + 12, args=>{
                english(`VarBstrFrom${from}`, args[width / 4]);
                const value = argumentValue(source, args);
                return typeof value === 'number' ? value : spelled(value, args[width / 4 + 1]);
            });
        }
    }

    const table = {
        ...conversions,

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
                // A length with the top bit set is no string on a 32-bit
                // system, refused before anything is read.
                if (bytes >= 0x80000000)
                {
                    return 0;
                }
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
                // A reallocation: without a source the characters already
                // there stay, and a string that is not growing keeps its
                // block, as the heap's realloc keeps one it can shrink in.
                const old = readU32(slot);
                const oldBytes = old === 0 ? 0 : readU32(old - PREFIX_BYTES);
                const bytes = (len >>> 0) * 2;
                const data = new Uint8Array(bytes);
                if ((psz >>> 0) !== 0)
                {
                    data.set(host.readMemory(psz >>> 0, bytes));
                }
                else if (old !== 0)
                {
                    data.set(host.readMemory(old, Math.min(oldBytes, bytes)));
                }
                if (old !== 0 && bytes <= oldBytes)
                {
                    const block = new Uint8Array(PREFIX_BYTES + bytes + 2);
                    new DataView(block.buffer).setUint32(0, bytes, true);
                    block.set(data, PREFIX_BYTES);
                    host.writeMemory(old - PREFIX_BYTES, block);
                    return 1;
                }
                const replacement = allocateBstr(data);
                if (replacement === 0)
                {
                    return 0;
                }
                freeBstr(old);
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

        /**
         * HRESULT VarBstrCat(BSTR bstrLeft, BSTR bstrRight, BSTR *pbstrResult)
         *
         * A NULL operand is the empty string. The lengths are added in bytes,
         * so an odd-length byte string stays as long as it was.
         */
        VarBstrCat: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, result])=>{
                if ((result >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const leftBytes = byteLengthOf(left >>> 0);
                const rightBytes = byteLengthOf(right >>> 0);
                const data = new Uint8Array(leftBytes + rightBytes);
                if (leftBytes)
                {
                    data.set(host.readMemory(left >>> 0, leftBytes));
                }
                if (rightBytes)
                {
                    data.set(host.readMemory(right >>> 0, rightBytes), leftBytes);
                }
                const bstr = allocateBstr(data);
                if (bstr === 0)
                {
                    return E_OUTOFMEMORY;
                }
                writeU32(result >>> 0, bstr);
                return S_OK;
            },
        },

        /**
         * HRESULT VarBstrCmp(BSTR bstrLeft, BSTR bstrRight, LCID lcid, ULONG dwFlags)
         *
         * VARCMP_LT, VARCMP_EQ or VARCMP_GT. A NULL or empty string is less
         * than any other and equal to another such. With no locale the strings
         * are compared as bytes, a shorter one before a longer one it begins;
         * with one, as CompareString compares text under the flags.
         */
        VarBstrCmp: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([left, right, lcid, flags])=>{
                const leftBytes = byteLengthOf(left >>> 0);
                const rightBytes = byteLengthOf(right >>> 0);
                // Empty is no string or no characters: a lone NUL is a
                // character, greater than nothing.
                const leftEmpty = leftBytes === 0;
                const rightEmpty = rightBytes === 0;
                if (leftEmpty || rightEmpty)
                {
                    return leftEmpty === rightEmpty ? VARCMP_EQ
                        : leftEmpty ? VARCMP_LT : VARCMP_GT;
                }
                const a = host.readMemory(left >>> 0, leftBytes);
                const b = host.readMemory(right >>> 0, rightBytes);
                if ((lcid >>> 0) !== 0)
                {
                    /** @param {Uint8Array} bytes */
                    const text = bytes=>String.fromCharCode(
                        ...new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 1));
                    return compareStrings(text(a.slice()), text(b.slice()), flags >>> 0) - 1;
                }
                for (let at = 0; at < Math.min(a.length, b.length); at++)
                {
                    if (a[at] !== b[at])
                    {
                        return a[at] < b[at] ? VARCMP_LT : VARCMP_GT;
                    }
                }
                return a.length === b.length ? VARCMP_EQ
                    : a.length < b.length ? VARCMP_LT : VARCMP_GT;
            },
        },

        /**
         * ULONG BSTR_UserSize(ULONG *pFlags, ULONG StartingSize, BSTR *pBstr)
         *
         * A BSTR on the wire is MS-OAUT's FLAGGED_WORD_BLOB as NDR lays a
         * conformant structure down, from a four-byte boundary: the element
         * count, the byte count, the element count again, then the elements --
         * an odd byte count rounded up to whole characters.
         */
        BSTR_UserSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, start, pbstr])=>{
                const units = (byteLengthOf(readU32(pbstr >>> 0)) + 1) >>> 1;
                return ((((start >>> 0) + 3) & ~3) + WIRE_BSTR_HEADER + units * 2) >>> 0;
            },
        },

        /**
         * unsigned char *BSTR_UserMarshal(ULONG *pFlags, unsigned char *pBuffer,
         *   BSTR *pBstr)
         *
         * A NULL BSTR goes as no elements and a byte count of all ones, which
         * is how the other side tells it from an empty one.
         */
        BSTR_UserMarshal: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, buffer, pbstr])=>{
                const from = buffer >>> 0;
                const pad = (4 - (from & 3)) & 3;
                const bstr = readU32(pbstr >>> 0);
                const bytes = byteLengthOf(bstr);
                const units = (bytes + 1) >>> 1;
                const wire = new Uint8Array(pad + WIRE_BSTR_HEADER + units * 2);
                const view = new DataView(wire.buffer);
                view.setUint32(pad, units, true);
                view.setUint32(pad + 4, bstr === 0 ? 0xffffffff : bytes, true);
                view.setUint32(pad + 8, units, true);
                if (units > 0)
                {
                    wire.set(host.readMemory(bstr, units * 2), pad + WIRE_BSTR_HEADER);
                }
                host.writeMemory(from, wire);
                return (from + wire.length) >>> 0;
            },
        },

        /**
         * unsigned char *BSTR_UserUnmarshal(ULONG *pFlags, unsigned char *pBuffer,
         *   BSTR *pBstr)
         *
         * The string the slot held is freed and a new one made from the wire.
         */
        BSTR_UserUnmarshal: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, buffer, pbstr])=>{
                const at = (((buffer >>> 0) + 3) & ~3) >>> 0;
                const bytes = readU32(at + 4);
                const units = readU32(at + 8);
                const slot = pbstr >>> 0;
                freeBstr(readU32(slot));
                writeU32(slot, bytes === 0xffffffff ? 0 : allocateBstr(host.readMemory(
                    at + WIRE_BSTR_HEADER, Math.min(bytes, units * 2)).slice()));
                return (at + WIRE_BSTR_HEADER + units * 2) >>> 0;
            },
        },

        /** void BSTR_UserFree(ULONG *pFlags, BSTR *pBstr) */
        BSTR_UserFree: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, pbstr])=>{
                const slot = pbstr >>> 0;
                freeBstr(readU32(slot));
                writeU32(slot, 0);
                return 0;
            },
        },

        /** ULONG VARIANT_UserSize(ULONG *pFlags, ULONG StartingSize, VARIANT *pVar) */
        VARIANT_UserSize: noWireForm('VARIANT_UserSize', ([, start])=>start >>> 0),

        /** unsigned char *VARIANT_UserMarshal(ULONG *pFlags, unsigned char *pBuffer, VARIANT *pVar) */
        VARIANT_UserMarshal: noWireForm('VARIANT_UserMarshal', ([, buffer])=>buffer >>> 0),

        /** unsigned char *VARIANT_UserUnmarshal(ULONG *pFlags, unsigned char *pBuffer, VARIANT *pVar) */
        VARIANT_UserUnmarshal: noWireForm('VARIANT_UserUnmarshal', ([, buffer, pvar])=>{
            const owed = nothingOwed();
            clear(pvar >>> 0, owed);
            return settle(owed, host.callerThread?.(), buffer >>> 0);
        }),

        /** void VARIANT_UserFree(ULONG *pFlags, VARIANT *pVar) -- its contents, as VariantClear */
        VARIANT_UserFree: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, pvar])=>{
                const owed = nothingOwed();
                clear(pvar >>> 0, owed);
                return settle(owed, host.callerThread?.(), 0);
            },
        },

        /** ULONG LPSAFEARRAY_UserSize(ULONG *pFlags, ULONG StartingSize, LPSAFEARRAY *ppsa) */
        LPSAFEARRAY_UserSize: noWireForm('LPSAFEARRAY_UserSize', ([, start])=>start >>> 0),

        /** unsigned char *LPSAFEARRAY_UserMarshal(ULONG *pFlags, unsigned char *pBuffer, LPSAFEARRAY *ppsa) */
        LPSAFEARRAY_UserMarshal: noWireForm('LPSAFEARRAY_UserMarshal', ([, buffer])=>buffer >>> 0),

        /** unsigned char *LPSAFEARRAY_UserUnmarshal(ULONG *pFlags, unsigned char *pBuffer, LPSAFEARRAY *ppsa) */
        LPSAFEARRAY_UserUnmarshal: noWireForm('LPSAFEARRAY_UserUnmarshal', ([, buffer, ppsa])=>{
            writeU32(ppsa >>> 0, 0);
            return buffer >>> 0;
        }),

        /** void LPSAFEARRAY_UserFree(ULONG *pFlags, LPSAFEARRAY *ppsa) -- the array, as SafeArrayDestroy */
        LPSAFEARRAY_UserFree: {
            argBytes: 8,
            /**
             * @param {number[]} args
             * @returns {number | Promise<number>}
             */
            handler: ([, ppsa])=>table.SafeArrayDestroy.handler([readU32(ppsa >>> 0)]),
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
                if (!isVariantType(readU16(variant)))
                {
                    return DISP_E_BADVARTYPE;
                }
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                const hr = clear(variant, owed);
                return hr !== S_OK ? hr : settle(owed, thread, S_OK);
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
            handler: ([pvargDest, pvargSrc])=>{
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                return settle(owed, thread, copyVariant(pvargDest >>> 0, pvargSrc >>> 0, owed));
            },
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
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                // What is not a reference is copied as VariantCopy copies it,
                // which leaves a variant copied onto itself as it was.
                if ((readU16(src) & VT_BYREF) === 0)
                {
                    return settle(owed, thread, copyVariant(dest, src, owed));
                }
                // A reference is followed to a value of a type a variant holds
                // by value -- an array included -- and that value copied as
                // VariantCopy copies it; a reference to anything else, or to
                // nothing, is an invalid argument.
                const declared = readU16(src);
                const type = declared & VT_TYPEMASK;
                const target = readU32(src + VARIANT_VALUE);
                if (type <= VT_NULL || type === 15 || type >= 24
                    || (declared & (VT_VECTOR | VT_RESERVED)) !== 0 || target === 0)
                {
                    return E_INVALIDARG;
                }
                if (dest !== src && !isVariantType(readU16(dest)))
                {
                    return DISP_E_BADVARTYPE;
                }
                /** @param {number} reference @param {number} at */
                const valueOf = (reference, at)=>{
                    const bytes = new Uint8Array(VARIANT_BYTES);
                    const size = (reference & VT_ARRAY) !== 0 ? 4
                        : ELEMENT_BYTES[reference & VT_TYPEMASK];
                    bytes.set(host.readMemory(at, size),
                        (reference & VT_TYPEMASK) === VT_DECIMAL && size === 16 ? 0
                            : VARIANT_VALUE);
                    new DataView(bytes.buffer).setUint16(0, reference & ~VT_BYREF, true);
                    return bytes;
                };
                let bytes;
                if (type === VT_VARIANT && (declared & VT_ARRAY) === 0)
                {
                    // A variant referred to is copied, and a reference it
                    // holds followed in turn -- unless that is to yet
                    // another variant.
                    bytes = host.readMemory(target, VARIANT_BYTES).slice();
                    const inner = readU16(target);
                    if ((inner & VT_BYREF) !== 0)
                    {
                        const at = readU32(target + VARIANT_VALUE);
                        if ((inner & VT_TYPEMASK) === VT_VARIANT || at === 0
                            || ELEMENT_BYTES[inner & VT_TYPEMASK] === undefined)
                        {
                            return E_INVALIDARG;
                        }
                        bytes = valueOf(inner, at);
                    }
                }
                else
                {
                    bytes = valueOf(declared, target);
                }
                const scratch = host.heap.allocate(VARIANT_BYTES);
                if (scratch === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(scratch, bytes);
                if (dest === src)
                {
                    host.writeMemory(dest, new Uint8Array(VARIANT_BYTES));
                }
                const hr = copyVariant(dest, scratch, owed);
                host.heap.free(scratch);
                return settle(owed, thread, hr);
            },
        },

        /**
         * HRESULT VariantChangeType(VARIANTARG *pvargDest,
         *     const VARIANTARG *pvarSrc, USHORT wFlags, VARTYPE vt)
         */
        VariantChangeType: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pvargDest, pvarSrc, wFlags, vt])=>{
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                return whenAnswered(changeType(pvargDest >>> 0, pvarSrc >>> 0,
                    wFlags & 0xffff, vt & 0xffff, owed, 0, thread), hr=>settle(owed, thread, hr));
            },
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
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                return whenAnswered(changeType(pvargDest >>> 0, pvarSrc >>> 0,
                    wFlags & 0xffff, vt & 0xffff, owed, lcid, thread),
                hr=>settle(owed, thread, hr));
            },
        },

        /**
         * HRESULT VarBstrFromBool(VARIANT_BOOL boolIn, LCID lcid, ULONG dwFlags,
         *                         BSTR *pbstrOut)
         *
         * The one spelling the English locale uses: "True" for VARIANT_TRUE and
         * "False" for VARIANT_FALSE, which is every nonzero against zero. The
         * locale and flags are accepted and ignored, since this build speaks
         * one language; the out pointer is required, E_POINTER without it.
         */
        VarBstrFromBool: toBstr(16, ([boolIn])=>(boolIn ? 'True' : 'False')),

        /**
         * HRESULT VarBstrFromCy(CY cyIn, LCID lcid, ULONG dwFlags, BSTR *pbstrOut)
         *
         * As many places as the value needs, '.' before them, no thousands
         * separators: 1.5, 0.0009, -922337203685477.5808.
         */
        VarBstrFromCy: toBstr(20, ([low, high, lcid])=>{
            english('VarBstrFromCy', lcid);
            return textOfCurrency(BigInt.asIntN(64, BigInt(high >>> 0) << 32n | BigInt(low >>> 0)));
        }),

        /**
         * HRESULT VarBstrFromDate(DATE dateIn, LCID lcid, ULONG dwFlags, BSTR *pbstrOut)
         *
         * M/D/YYYY h:mm:ss AM, as the English short date and time spell it: the
         * date alone at midnight, the time alone on day zero, or the half
         * VAR_TIMEVALUEONLY or VAR_DATEVALUEONLY asks for. A day no DATE can
         * name is an invalid argument.
         */
        VarBstrFromDate: toBstr(20, ([low, high, lcid, flags])=>{
            english('VarBstrFromDate', lcid);
            return textOfDate(doubleOf(low, high), flags >>> 0) ?? E_INVALIDARG;
        }),
        /** HRESULT VarRound(LPVARIANT pvarIn, int cDecimals, LPVARIANT pvarResult) */
        VarRound: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pin, places, pout])=>{
                if ((places | 0) < 0 || (pin >>> 0) === 0 || (pout >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const value = operand(pin >>> 0);
                if (value === null)
                {
                    return DISP_E_BADVARTYPE;
                }
                const out = pout >>> 0;
                const number = Number(value.number);
                switch (value.type)
                {
                    case VT_NULL:
                        return writeVariant(out, VT_NULL, new Uint8Array(0));
                    case VT_BSTR: {
                        // Read to its terminator, as a Var*FromStr reads one:
                        // a plain OLECHAR string passed as a BSTR is read too.
                        const read = readOperand(pin >>> 0);
                        const parsed = typeof read === 'number' ? null
                            : parseText(String(read.text));
                        return parsed === null ? DISP_E_TYPEMISMATCH
                            : writeVariant(out, VT_R8, valueBytes(view=>
                                view.setFloat64(0, roundNumber(parsed, places), true)));
                    }
                    case VT_CY: {
                        const rounded = round(/** @type {any} */ (value.exact), places);
                        return writeVariant(out, VT_CY,
                            cyBytes(rounded.value * 10n ** BigInt(4 - rounded.scale)));
                    }
                    case VT_DECIMAL: {
                        const bytes = decimalBytes(round(/** @type {any} */ (value.exact), places));
                        return bytes === null ? DISP_E_OVERFLOW : writeDecimal(out, bytes);
                    }
                    case VT_R4:
                        return writeVariant(out, VT_R4, valueBytes(view=>
                            view.setFloat32(0, roundNumber(number, places), true)));
                    case VT_R8:
                    case VT_DATE:
                        return writeVariant(out, value.type, valueBytes(view=>
                            view.setFloat64(0, roundNumber(number, places), true)));
                    case VT_EMPTY:
                    case VT_BOOL:
                        return writeVariant(out, VT_I2,
                            valueBytes(view=>view.setInt16(0, number, true)));
                    case VT_I1:
                    case VT_UI1:
                    case VT_I2:
                    case VT_UI2:
                    case VT_I4:
                    case VT_UI4:
                    case VT_INT:
                    case VT_UINT:
                        return writeVariant(out, value.type,
                            host.readMemory((pin >>> 0) + VARIANT_VALUE, 8).slice());
                    default:
                        return DISP_E_BADVARTYPE;
                }
            },
        },

        /**
         * HRESULT VarCmp(LPVARIANT pvarLeft, LPVARIANT pvarRight, LCID lcid, ULONG dwFlags)
         *
         * VARCMP_LT, EQ or GT, VARCMP_NULL when either side is null. A number
         * is below any text; empty is zero beside a number and "" beside text.
         */
        VarCmp: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pleft, pright, lcid, flags])=>{
                if ((pleft >>> 0) === 0 || (pright >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const reserved = [pleft, pright]
                    .map(pvar=>(readU16(pvar >>> 0) & VT_RESERVED) !== 0);
                // A string beside a number is not read unless the flags ask
                // for it, so one that points nowhere is still text.
                /** @param {number} pvar */
                const read = pvar=>{
                    const value = readOperand(pvar, VT_RESERVED);
                    return typeof value !== 'number' && value.type === VT_BSTR
                        && value.flags === VT_BYREF && (readU16(pvar) & VT_BYREF) === 0
                        ? variantValue(VT_BSTR, { text: '' }) : value;
                };
                const left = read(pleft >>> 0);
                const right = read(pright >>> 0);
                if (typeof left === 'number' || typeof right === 'number')
                {
                    return typeof left === 'number' ? left : /** @type {number} */ (right);
                }
                return compareValues(left, right, reserved, lcid >>> 0, flags >>> 0);
            },
        },

        /**
         * HRESULT VarCat(LPVARIANT left, LPVARIANT right, LPVARIANT out)
         *
         * Both sides as text, null and empty as nothing; null only when both
         * are null.
         */
        VarCat: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pleft, pright, pout])=>{
                const left = readOperand(pleft >>> 0);
                const right = readOperand(pright >>> 0);
                if (typeof left === 'number' || typeof right === 'number')
                {
                    return writeOutcome(pout >>> 0, typeof left === 'number' ? left
                        : /** @type {number} */ (right));
                }
                const refusal = catRefusal(left, right);
                if (refusal !== S_OK)
                {
                    return writeOutcome(pout >>> 0, refusal);
                }
                if (left.type === VT_NULL && right.type === VT_NULL)
                {
                    return writeOutcome(pout >>> 0, variantValue(VT_NULL));
                }
                /** @param {import('./arithmetic.js').Value} value */
                const text = value=>(value.type === VT_NULL ? ''
                    : spelled(value, VARIANT_ALPHABOOL));
                const a = text(left);
                const b = text(right);
                return writeOutcome(pout >>> 0, typeof a === 'number' ? a
                    : typeof b === 'number' ? b : variantValue(VT_BSTR, { text: a + b }));
            },
        },

        /**
         * HRESULT VarAdd(LPVARIANT pvarLeft, LPVARIANT pvarRight, LPVARIANT pvarResult)
         * HRESULT VarSub, VarMul, VarDiv, VarIdiv, VarMod, VarAnd, VarOr, VarXor
         *     (the same three)
         * HRESULT VarNeg(LPVARIANT pvarIn, LPVARIANT pvarResult), VarNot (the same)
         *
         * The operators of Visual Basic and of every language's variant type,
         * by the type tables arithmetic.js keeps. An interface is not asked for
         * its value property: beside anything but a null it is a mismatch.
         */
        VarAdd: binary(add),
        VarSub: binary(subtract),
        VarMul: binary(multiply),
        VarDiv: binary(divide),
        VarIdiv: binary(integerDivide),
        VarMod: binary(modulo),
        VarAnd: binary(and),
        VarOr: binary(or),
        VarXor: binary(xor),
        VarNeg: unary(negate),
        VarNot: unary(not),

        /**
         * HRESULT VarDateFromStr(OLECHAR *strIn, LCID lcid, ULONG dwFlags, DATE *pdateOut)
         *
         * A date in the English order -- month, day, year, then year, month,
         * day, then day, month, year, whichever the numbers allow -- or with a
         * month's name, and a time before it or after it; a two-digit year is
         * 1930 to 2029, and a date written without a year is in this one.
         * VAR_TIMEVALUEONLY and VAR_DATEVALUEONLY keep one half of the answer.
         */
        VarDateFromStr: fromString('VarDateFromStr', (text, flags)=>{
            const date = dateFromText(text, flags, thisYear);
            return date === null ? DISP_E_TYPEMISMATCH
                : valueBytes(view=>view.setFloat64(0, date, true));
        }),

        /** HRESULT VarUdateFromDate(DATE dateIn, ULONG dwFlags, UDATE *pudateOut) */
        VarUdateFromDate: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([low, high, , out])=>{
                const fields = fieldsOf(doubleOf(low, high));
                if (!fields)
                {
                    return E_INVALIDARG;
                }
                writeWords(out >>> 0, udateWords(fields));
                return S_OK;
            },
        },

        /** HRESULT VarDateFromUdate(UDATE *pudateIn, ULONG dwFlags, DATE *pdateOut) */
        VarDateFromUdate: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([udate, flags, out])=>{
                const words = readWords(udate >>> 0, 8);
                if (words[0] > 9999 || words[0] < -9999)
                {
                    return E_INVALIDARG;
                }
                const { year, month } = rollYear(words[0], words[1]);
                writeDouble(out >>> 0, dateOf({ year, month, day: words[3], hour: words[4],
                    minute: words[5], second: words[6] }, flags >>> 0));
                return S_OK;
            },
        },

        /**
         * INT SystemTimeToVariantTime(LPSYSTEMTIME, double *pvtime)
         *
         * Stricter than VarDateFromUdate: every field in its range, save a
         * day of zero, which is the last of the month before. A two-digit
         * year below 50 is this century.
         */
        SystemTimeToVariantTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([time, out])=>{
                const [year, month, , day, hour, minute, second] = readWords(time >>> 0, 8);
                if (year < 0 || year > 9999 || month < 1 || month > 12 || day > 31
                    || hour > 23 || minute > 59 || second > 59)
                {
                    return 0;
                }
                writeDouble(out >>> 0, dateOf({
                    year: year < 50 ? 2000 + year : year < 100 ? 1900 + year : year,
                    month, day, hour, minute, second }));
                return 1;
            },
        },

        /** INT VariantTimeToSystemTime(double vtime, LPSYSTEMTIME lpSystemTime) */
        VariantTimeToSystemTime: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([low, high, out])=>{
                const fields = fieldsOf(doubleOf(low, high));
                if (!fields)
                {
                    return 0;
                }
                writeWords(out >>> 0, udateWords(fields).slice(0, 8));
                return 1;
            },
        },

        /**
         * INT DosDateTimeToVariantTime(USHORT wDosDate, USHORT wDosTime, double *pvtime)
         *
         * The packed fields as they are, a day or month of zero rolling back
         * and a day past the month's end rolling on, up to the last DOS year.
         */
        DosDateTimeToVariantTime: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([date, time, out])=>{
                const year = 1980 + ((date >>> 9) & 0x7f);
                const month = (date >>> 5) & 0xf;
                const hour = (time >>> 11) & 0x1f;
                const minute = (time >>> 5) & 0x3f;
                const second = (time & 0x1f) * 2;
                if (year > 2099 || month > 12 || hour > 23 || minute > 59 || second > 59)
                {
                    return 0;
                }
                writeDouble(out >>> 0,
                    dateOf({ year, month, day: date & 0x1f, hour, minute, second }));
                return 1;
            },
        },

        /** INT VariantTimeToDosDateTime(double vtime, USHORT *pwDosDate, USHORT *pwDosTime) */
        VariantTimeToDosDateTime: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([low, high, dateOut, timeOut])=>{
                const fields = fieldsOf(doubleOf(low, high));
                if (!fields || fields.year < 1980 || fields.year > 2099)
                {
                    return 0;
                }
                writeWords(dateOut >>> 0, [fields.day | fields.month << 5
                    | (fields.year - 1980) << 9]);
                writeWords(timeOut >>> 0, [fields.second >>> 1 | fields.minute << 5
                    | fields.hour << 11]);
                return 1;
            },
        },

        /**
         * HRESULT VarParseNumFromStr(LPCOLESTR strIn, LCID lcid, ULONG dwFlags,
         *                            NUMPARSE *pnumprs, BYTE *rgbDig)
         *
         * cDig comes in as the digit buffer's size and goes out as the count
         * written; dwInFlags is only read. Nothing is written when the string
         * holds no number, or when NUMPRS_USE_ALL is set and some is left over.
         */
        VarParseNumFromStr: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([strIn, lcid, , pnumprs, rgbDig])=>{
                const numprs = pnumprs >>> 0;
                if ((strIn >>> 0) === 0 || numprs === 0 || (rgbDig >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                english('VarParseNumFromStr', lcid);
                const fields = peek(numprs, 24);
                const capacity = fields.getInt32(NUMPARSE_C_DIG, true);
                const allowed = fields.getUint32(NUMPARSE_IN_FLAGS, true);
                const text = wideAt(strIn >>> 0);
                const parsed = parseNumberText(text, allowed, capacity);
                const rest = parsed === null ? text : text.slice(parsed.used);
                if ((allowed & NUMPRS_UNPARSED) !== 0 && /^\s*[&()$+-]/.test(rest))
                {
                    report('VarParseNumFromStr',
                        'hex/octal, currency, parenthesised and trailing-sign forms are not read');
                }
                if (parsed === null
                    || ((allowed & NUMPRS_USE_ALL) !== 0 && parsed.used < text.length))
                {
                    return DISP_E_TYPEMISMATCH;
                }
                const out = new DataView(new ArrayBuffer(24));
                out.setInt32(NUMPARSE_C_DIG, parsed.digits.length, true);
                out.setUint32(NUMPARSE_IN_FLAGS, allowed, true);
                out.setUint32(NUMPARSE_OUT_FLAGS, parsed.flags, true);
                out.setInt32(NUMPARSE_CCH_USED, parsed.used, true);
                out.setInt32(NUMPARSE_BASE_SHIFT, 0, true);
                out.setInt32(NUMPARSE_PWR10, parsed.pwr10, true);
                host.writeMemory(numprs, new Uint8Array(out.buffer));
                host.writeMemory(rgbDig >>> 0, Uint8Array.from(parsed.digits));
                return S_OK;
            },
        },

        /**
         * HRESULT VarNumFromParseNum(NUMPARSE *pnumprs, BYTE *rgbDig,
         *                            ULONG dwVtBits, VARIANT *pvar)
         *
         * The parsed number as the smallest type the caller allows; an
         * overflow when none holds it.
         */
        VarNumFromParseNum: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pnumprs, rgbDig, vtBits, pvar])=>{
                const numprs = pnumprs >>> 0;
                if (numprs === 0 || (rgbDig >>> 0) === 0 || (pvar >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const fields = peek(numprs, 24);
                const count = Math.max(fields.getInt32(NUMPARSE_C_DIG, true), 0);
                const digits = [...host.readMemory(rgbDig >>> 0, count)];
                const negative = (fields.getUint32(NUMPARSE_OUT_FLAGS, true) & NUMPRS_NEG) !== 0;
                const made = numberVariant(digits, fields.getInt32(NUMPARSE_PWR10, true),
                    fields.getInt32(NUMPARSE_BASE_SHIFT, true), negative, vtBits >>> 0);
                if (made === null)
                {
                    return DISP_E_OVERFLOW;
                }
                const variant = new Uint8Array(VARIANT_BYTES);
                // A DECIMAL fills the variant from its third byte on.
                variant.set(made.bytes, made.type === VT_DECIMAL ? 0 : VARIANT_VALUE);
                variant[0] = made.type;
                host.writeMemory(pvar >>> 0, variant);
                return S_OK;
            },
        },

        /**
         * HRESULT SetErrorInfo(ULONG dwReserved, IErrorInfo *perrinfo)
         * HRESULT GetErrorInfo(ULONG dwReserved, IErrorInfo **pperrinfo)
         *
         * The error-information slot, one per thread as on Windows. Getting
         * it hands the interface over and clears the slot, which is why a
         * caller that gets it twice finds nothing the second time; a call
         * with no reference held answers S_FALSE with a null, the documented
         * shape a caller checks before it dereferences. The reserved word must be
         * zero, E_INVALIDARG otherwise, as ole32's errorinfo tests read it.
         *
         * The slot holds a reference of its own: Set adds one to the object it
         * is given and releases the one it held, and Get hands its reference
         * to the caller. A setter releases its own at once -- InstallShield's
         * kernel does -- and a slot that took no reference held an object
         * already gone, whose methods the next reader called.
         */
        SetErrorInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([reserved, errorInfo])=>{
                if ((reserved >>> 0) !== 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.callerThread?.() ?? null;
                const held = heldErrorInfo.get(thread) ?? 0;
                const given = errorInfo >>> 0;
                if (given === 0)
                {
                    heldErrorInfo.delete(thread);
                }
                else
                {
                    heldErrorInfo.set(thread, given);
                }
                return settle({ addRef: given !== 0 ? [given] : [],
                    release: held !== 0 ? [held] : [], recordClear: [] }, thread, S_OK);
            },
        },

        GetErrorInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([reserved, out])=>{
                if ((reserved >>> 0) !== 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.callerThread?.() ?? null;
                const held = heldErrorInfo.get(thread) ?? 0;
                heldErrorInfo.delete(thread);
                if ((out >>> 0) !== 0)
                {
                    writeU32(out >>> 0, held);
                }
                return held === 0 ? S_FALSE : S_OK;
            },
        },

        /**
         * HRESULT GetActiveObject(REFCLSID rclsid, void *pvReserved, IUnknown **ppunk)
         *
         * Looks a class up in the running object table, where another process
         * registers the object it serves. No other process registers one here,
         * so the answer is the one Windows gives for a class nobody is running:
         * MK_E_UNAVAILABLE with the out pointer cleared, which a caller reads as
         * "start your own instance" rather than a failure.
         */
        GetActiveObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                const MK_E_UNAVAILABLE = 0x800401e3;
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, 0);
                return MK_E_UNAVAILABLE;
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
                const end = value.data.indexOf(0);
                const path = decodeAnsi(value.data.subarray(0, end < 0 ? value.data.length : end));
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
         * SAFEARRAY *SafeArrayCreate(VARTYPE vt, UINT cDims, SAFEARRAYBOUND *rgsabound)
         *
         * A descriptor and zeroed data for the type and bounds asked for.
         * The caller's bounds name the leftmost dimension first; the
         * descriptor keeps them the other way round, which is the order the
         * bound readers below count from.
         */
        SafeArrayCreate: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([vt, cDims, rgsabound])=>{
                const type = vt & 0xffff;
                const dims = cDims >>> 0;
                const elementBytes = ELEMENT_BYTES[type];
                if (elementBytes === undefined || dims === 0 || (rgsabound >>> 0) === 0)
                {
                    return 0;
                }
                let elements = 1;
                for (let index = 0; index < dims; index++)
                {
                    elements *= readU32((rgsabound >>> 0) + index * 8);
                }
                const dataBytes = Math.max(1, elements * elementBytes);
                const descriptor = host.heap.allocate(SAFEARRAY_BOUNDS + dims * 8);
                const data = host.heap.allocate(dataBytes);
                if (descriptor === 0 || data === 0)
                {
                    host.heap.free(descriptor);
                    host.heap.free(data);
                    return 0;
                }
                const features = type === VT_BSTR ? FADF_BSTR
                    : type === VT_UNKNOWN ? FADF_UNKNOWN
                        : type === VT_DISPATCH ? FADF_DISPATCH
                            : type === VT_VARIANT ? FADF_VARIANT : 0;
                writeU16(descriptor, dims);
                writeU16(descriptor + 2, features);
                writeU32(descriptor + 4, elementBytes);
                writeU32(descriptor + 8, 0);
                writeU32(descriptor + 12, data);
                for (let index = 0; index < dims; index++)
                {
                    host.writeMemory(descriptor + SAFEARRAY_BOUNDS + (dims - 1 - index) * 8,
                        host.readMemory((rgsabound >>> 0) + index * 8, 8).slice());
                }
                host.fillMemory(data, 0, dataBytes);
                return descriptor;
            },
        },

        /**
         * HRESULT SafeArrayDestroy(SAFEARRAY *psa)
         *
         * The elements that own something are released first, as
         * VariantClear releases them; a locked array is the caller's still.
         */
        SafeArrayDestroy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([psa])=>{
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                const hr = destroyArray(psa >>> 0, owed);
                return hr !== S_OK ? hr : settle(owed, thread, S_OK);
            },
        },

        /**
         * HRESULT SafeArrayRedim(SAFEARRAY *psa, SAFEARRAYBOUND *psaboundNew)
         *
         * Changes the rightmost dimension, which is the slowest-varying and
         * so the one whose elements sit at the end of the data: growing
         * appends zeroed elements, shrinking drops the last ones, and what
         * they owned goes with them.
         */
        SafeArrayRedim: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([psa, psaboundNew])=>{
                const array = safeArrayAt(psa >>> 0);
                if (!array || (psaboundNew >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (array.locks !== 0)
                {
                    return DISP_E_ARRAYISLOCKED;
                }
                const inner = array.bounds.slice(1)
                    .reduce((total, bound)=>total * bound.elements, 1);
                const before = array.bounds[0].elements * inner;
                const elements = readU32(psaboundNew >>> 0);
                const after = elements * inner;
                const stride = array.elementBytes;
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                for (let index = after; index < before; index++)
                {
                    releaseElement(array.features, array.data + index * stride, owed);
                }
                if (after > before)
                {
                    const data = host.heap.allocate(after * stride);
                    if (data === 0)
                    {
                        return settle(owed, thread, E_OUTOFMEMORY);
                    }
                    host.fillMemory(data, 0, after * stride);
                    if (array.data !== 0)
                    {
                        host.writeMemory(data,
                            host.readMemory(array.data, before * stride).slice());
                        host.heap.free(array.data);
                    }
                    writeU32((psa >>> 0) + 12, data);
                }
                host.writeMemory((psa >>> 0) + SAFEARRAY_BOUNDS,
                    host.readMemory(psaboundNew >>> 0, 8).slice());
                return settle(owed, thread, S_OK);
            },
        },

        /**
         * HRESULT SafeArrayGetElement(SAFEARRAY *psa, LONG *rgIndices, void *pv)
         * HRESULT SafeArrayPutElement(SAFEARRAY *psa, LONG *rgIndices, void *pv)
         *
         * One element, copied the way its type is copied: a string is
         * duplicated, a variant goes through VariantCopy and an interface
         * takes a reference of its own, so what the caller gets is its own to
         * free, and what it put stays the array's.
         */
        SafeArrayGetElement: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([psa, rgIndices, pv])=>{
                const at = elementAt(psa >>> 0, rgIndices >>> 0);
                if ('error' in at)
                {
                    return at.error;
                }
                if ((pv >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const { features, elementBytes } = at.array;
                if ((features & FADF_BSTR) !== 0)
                {
                    const source = readU32(at.address);
                    const copy = source === 0 ? 0 : allocateBstr(
                        host.readMemory(source, byteLengthOf(source)).slice());
                    if (source !== 0 && copy === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    writeU32(pv >>> 0, copy);
                    return S_OK;
                }
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                if ((features & FADF_VARIANT) !== 0)
                {
                    host.writeMemory(pv >>> 0, new Uint8Array(VARIANT_BYTES));
                    return settle(owed, thread, copyVariant(pv >>> 0, at.address, owed));
                }
                if ((features & (FADF_UNKNOWN | FADF_DISPATCH)) !== 0 && readU32(at.address) !== 0)
                {
                    owed.addRef.push(readU32(at.address));
                }
                host.writeMemory(pv >>> 0, host.readMemory(at.address, elementBytes).slice());
                return settle(owed, thread, S_OK);
            },
        },
        SafeArrayPutElement: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([psa, rgIndices, pv])=>{
                const at = elementAt(psa >>> 0, rgIndices >>> 0);
                if ('error' in at)
                {
                    return at.error;
                }
                const { features, elementBytes } = at.array;
                if ((features & FADF_BSTR) !== 0)
                {
                    // The argument is the BSTR itself, not a pointer to one;
                    // NULL is the empty string, as SysStringByteLen reads it.
                    const source = pv >>> 0;
                    const copy = allocateBstr(source === 0 ? new Uint8Array(0)
                        : host.readMemory(source, byteLengthOf(source)).slice());
                    if (copy === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    freeBstr(readU32(at.address));
                    writeU32(at.address, copy);
                    return S_OK;
                }
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                if ((features & (FADF_UNKNOWN | FADF_DISPATCH)) !== 0)
                {
                    // Like the other types, the argument is the value itself;
                    // NULL empties the slot.
                    if ((pv >>> 0) !== 0)
                    {
                        owed.addRef.push(pv >>> 0);
                    }
                    releaseElement(features, at.address, owed);
                    writeU32(at.address, pv >>> 0);
                    return settle(owed, thread, S_OK);
                }
                if ((pv >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((features & FADF_VARIANT) !== 0)
                {
                    return settle(owed, thread, copyVariant(at.address, pv >>> 0, owed));
                }
                host.writeMemory(at.address, host.readMemory(pv >>> 0, elementBytes).slice());
                return S_OK;
            },
        },

        /**
         * HRESULT SafeArrayPtrOfIndex(SAFEARRAY *psa, LONG *rgIndices, void **ppvData)
         *
         * Where one element lives, not a copy of it. No lock is taken or asked
         * for: the caller is expected to hold one, and nothing here moves data.
         */
        SafeArrayPtrOfIndex: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([psa, rgIndices, ppvData])=>{
                if ((ppvData >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const at = elementAt(psa >>> 0, rgIndices >>> 0);
                if ('error' in at)
                {
                    return at.error;
                }
                writeU32(ppvData >>> 0, at.address);
                return S_OK;
            },
        },

        /**
         * HRESULT SafeArrayAccessData(SAFEARRAY *psa, void **ppvData)
         * HRESULT SafeArrayUnaccessData(SAFEARRAY *psa)
         *
         * A lock and the data pointer; nothing here moves data, so the
         * pointer is the one the descriptor already holds.
         */
        SafeArrayAccessData: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([psa, out])=>{
                const array = safeArrayAt(psa >>> 0);
                if (!array || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32((psa >>> 0) + 8, array.locks + 1);
                writeU32(out >>> 0, array.data);
                return S_OK;
            },
        },
        SafeArrayUnaccessData: {
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
         * variant goes through VariantCopy, and an interface takes a
         * reference of its own.
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
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                const copy = copyArray(psa >>> 0, owed);
                if (copy.hr !== S_OK)
                {
                    return copy.hr;
                }
                writeU32(out >>> 0, copy.descriptor);
                return settle(owed, thread, S_OK);
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
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                return whenAnswered(changeType(pvarResult >>> 0, source, 0, vtTarg & 0xffff,
                    owed, 0, thread), result=>{
                    if (result !== S_OK && (puArgErr >>> 0) !== 0)
                    {
                        writeU32(puArgErr >>> 0, position >>> 0);
                    }
                    return settle(owed, thread, result);
                });
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
         * HRESULT DispCallFunc(void *pvInstance, ULONG_PTR oVft, CALLCONV cc,
         *   VARTYPE vtReturn, UINT cActuals, VARTYPE *prgvt, VARIANTARG **prgpvarg,
         *   VARIANT *pvargResult)
         *
         * A call through a vtable slot (an instance given, oVft its byte
         * offset, the instance pushed first) or to oVft itself. Each argument
         * is pushed as its type occupies the stack: two dwords for the 64-bit
         * types, the whole sixteen-byte variant for VT_VARIANT, one otherwise.
         * The answer is EAX; a floating-point or 64-bit return comes back in
         * registers the guest call does not hand over, and is refused.
         */
        DispCallFunc: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([instance, offset, , returnType, count, types, values, result])=>{
                const wide64 = new Set([VT_R8, VT_CY, VT_DATE, VT_I8, VT_UI8]);
                const returned = returnType & 0xffff;
                if (!host.call || wide64.has(returned) || returned === VT_R4)
                {
                    report('OLE Automation', `DispCallFunc cannot return type ${returned}`
                        + (host.call ? '' : ' or call into the program at all'));
                    return DISP_E_BADVARTYPE;
                }
                /** @type {number[]} */
                const pushed = (instance >>> 0) === 0 ? [] : [instance >>> 0];
                for (let index = 0; index < (count >>> 0); index++)
                {
                    const type = readU16((types >>> 0) + index * 2);
                    const variant = readU32((values >>> 0) + index * 4);
                    const dwords = type === VT_VARIANT ? 4 : wide64.has(type) ? 2 : 1;
                    const from = type === VT_VARIANT ? variant : variant + VARIANT_VALUE;
                    for (let word = 0; word < dwords; word++)
                    {
                        pushed.push(readU32(from + word * 4));
                    }
                }
                const entry = (instance >>> 0) === 0
                    ? offset >>> 0
                    : readU32(readU32(instance >>> 0) + (offset >>> 0));
                return host.call(entry, pushed, host.callerThread?.()).then(answer=>{
                    if ((result >>> 0) !== 0)
                    {
                        host.fillMemory(result >>> 0, 0, 16);
                        writeU16(result >>> 0, returned);
                        writeU32((result >>> 0) + VARIANT_VALUE, answer >>> 0);
                    }
                    return S_OK;
                });
            },
        },

        /**
         * HRESULT OleCreateFontIndirect(LPFONTDESC lpFontDesc, REFIID riid,
         *   LPVOID *lplpvObj)
         *
         * An IFont nothing here implements; declared so its twelve bytes are
         * popped and the caller is told, rather than left with a short stack.
         */
        OleCreateFontIndirect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                report('OLE Automation', 'OleCreateFontIndirect: no IFont object is implemented');
                if ((out >>> 0) !== 0)
                {
                    writeU32(out >>> 0, 0);
                }
                return E_NOTIMPL;
            },
        },

        /**
         * HRESULT CreateErrorInfo(ICreateErrorInfo **pperrinfo)
         *
         * A fresh, empty error object with one reference, the caller's.
         */
        /**
         * void ClearCustData(CUSTDATA *pCustData)
         *
         * Each item's variant cleared, the items' block given back to the
         * task allocator it came from, and both fields zeroed.
         */
        ClearCustData: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pcust])=>{
                const custom = pcust >>> 0;
                if (custom === 0)
                {
                    return 0;
                }
                const count = readU32(custom);
                const items = readU32(custom + 4);
                const thread = host.callerThread?.();
                const owed = nothingOwed();
                if (items !== 0)
                {
                    for (let index = 0; index < count; index++)
                    {
                        clear(items + index * 32 + 16, owed);
                    }
                    host.heap.free(items);
                }
                host.writeMemory(custom, new Uint8Array(8));
                return settle(owed, thread, 0);
            },
        },

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
    return table;
}

/** @param {string} char */
const isWhite = char=>char === ' ' || char === '\t' || char === '\n' || char === '\r'
    || char === '\v' || char === '\f';

/**
 * A number string pulled apart the way VarParseNumFromStr does, in the
 * invariant spelling: sign, digits, thousands commas, a '.' and an exponent,
 * each only where `allowed` lets it in. The digits come back without leading
 * or trailing zeros (those move into the power of ten), at most `capacity` of
 * them, INEXACT set when a dropped one was not zero.
 *
 * @param {string} text @param {number} allowed @param {number} capacity
 * @returns {{ digits: number[], flags: number, used: number, pwr10: number } | null}
 *   null when the string holds no number at all.
 */
export function parseNumberText(text, allowed, capacity){
    let at = 0;
    let flags = 0;
    if ((allowed & NUMPRS_LEADING_WHITE) !== 0)
    {
        while (at < text.length && isWhite(text[at]))
        {
            at++;
            flags |= NUMPRS_LEADING_WHITE;
        }
    }
    if (text[at] === '+' && (allowed & NUMPRS_LEADING_PLUS) !== 0)
    {
        at++;
        flags |= NUMPRS_LEADING_PLUS;
    }
    else if (text[at] === '-' && (allowed & NUMPRS_LEADING_MINUS) !== 0)
    {
        at++;
        flags |= NUMPRS_LEADING_MINUS | NUMPRS_NEG;
    }
    let whole = '';
    let fraction = '';
    let inFraction = false;
    for (; at < text.length; at++)
    {
        const char = text[at];
        if (char >= '0' && char <= '9')
        {
            if (inFraction)
            {
                fraction += char;
            }
            else
            {
                whole += char;
            }
        }
        else if (char === '.' && !inFraction && (allowed & NUMPRS_DECIMAL) !== 0)
        {
            inFraction = true;
            flags |= NUMPRS_DECIMAL;
        }
        else if (char === ',' && !inFraction && (allowed & NUMPRS_THOUSANDS) !== 0)
        {
            flags |= NUMPRS_THOUSANDS;
        }
        else
        {
            break;
        }
    }
    if (whole === '' && fraction === '')
    {
        return null;
    }
    let exponent = 0;
    if ((text[at] === 'e' || text[at] === 'E') && (allowed & NUMPRS_EXPONENT) !== 0)
    {
        // An 'e' with no digits after it is not an exponent, and is left unread.
        const match = /^[eE]([+-]?)(\d+)/.exec(text.slice(at));
        if (match)
        {
            exponent = Number(match[2]) * (match[1] === '-' ? -1 : 1);
            at += match[0].length;
            flags |= NUMPRS_EXPONENT;
        }
    }
    if ((allowed & NUMPRS_TRAILING_WHITE) !== 0)
    {
        while (at < text.length && isWhite(text[at]))
        {
            at++;
            flags |= NUMPRS_TRAILING_WHITE;
        }
    }

    let all = (whole + fraction).replace(/^0+/, '');
    let pwr10 = exponent - fraction.length;
    const significant = all.replace(/0+$/, '');
    pwr10 += all.length - significant.length;
    all = significant;
    if (all === '')
    {
        return { digits: [0], flags, used: at, pwr10: 0 };
    }
    const kept = Math.max(capacity, 0);
    if (all.length > kept)
    {
        if (/[1-9]/.test(all.slice(kept)))
        {
            flags |= NUMPRS_INEXACT;
        }
        pwr10 += all.length - kept;
        all = all.slice(0, kept);
    }
    return { digits: [...all].map(Number), flags, used: at, pwr10 };
}

/**
 * The VARIANT VarNumFromParseNum makes of parsed digits: the first type in
 * `vtBits` (a mask of 1 << VT_*) that holds the value, integers smallest
 * first, then R4 for at most seven significant digits, R8, CY, DECIMAL. A
 * fraction given only integer types is rounded to one, a half to the even
 * neighbour. null when nothing holds it.
 *
 * @param {number[]} digits @param {number} pwr10 @param {number} baseShift
 * @param {boolean} negative @param {number} vtBits
 * @returns {{ type: number, bytes: Uint8Array } | null} the eight value bytes, or
 *     a DECIMAL's sixteen
 */
export function numberVariant(digits, pwr10, baseShift, negative, vtBits){
    const bytes = new Uint8Array(16);
    const data = new DataView(bytes.buffer);
    const allows = (/** @type {number} */ type)=>(vtBits & (1 << type)) !== 0;
    /** @type {[number, number, boolean][]} each integral type, its bits, whether signed */
    const integers = [[VT_I1, 8, true], [VT_UI1, 8, false], [VT_I2, 16, true],
        [VT_UI2, 16, false], [VT_I4, 32, true], [VT_UI4, 32, false], [VT_I8, 64, true],
        [VT_UI8, 64, false]];
    /** @param {number} type @param {number} width @param {boolean} signed @param {bigint} value */
    const integer = (type, width, signed, value)=>{
        if (signed)
        {
            data.setBigInt64(0, BigInt.asIntN(width, value), true);
        }
        else
        {
            data.setBigUint64(0, BigInt.asUintN(width, value), true);
        }
        return { type, bytes: bytes.subarray(0, 8) };
    };
    /** @type {import('./varmath.js').Exact} */
    let exact;
    if (baseShift !== 0)
    {
        // Hex and octal digits are bits: the first type wide enough holds
        // them as they are, so &H82 is the I1 -126 and &H7F the I1 127.
        const bits = digits.reduce((sum, digit)=>(sum << BigInt(baseShift)) + BigInt(digit), 0n);
        const fitting = integers.find(([type, width])=>allows(type) && bits < 1n << BigInt(width));
        if (fitting)
        {
            return integer(fitting[0], fitting[1], fitting[2], bits);
        }
        exact = { value: bits, scale: 0 };
    }
    else
    {
        const magnitude = BigInt(digits.join('') || '0');
        const signed = negative ? -magnitude : magnitude;
        exact = pwr10 >= 0 ? { value: signed * 10n ** BigInt(pwr10), scale: 0 }
            : { value: signed, scale: -pwr10 };
    }
    const fractional = exact.scale > 0 && round(exact, 0).value * 10n ** BigInt(exact.scale)
        !== exact.value;
    const keepsFraction = allows(VT_R4) || allows(VT_R8) || allows(VT_CY) || allows(VT_DECIMAL);
    // Rounding to a whole number happens only when no type could keep the fraction.
    if (!fractional || !keepsFraction)
    {
        const whole = round(exact, 0).value;
        const fitting = integers.find(([type, width, signed])=>allows(type)
            && (signed ? whole >= -(1n << BigInt(width - 1)) && whole < 1n << BigInt(width - 1)
                : whole >= 0n && whole < 1n << BigInt(width)));
        if (fitting)
        {
            return integer(fitting[0], fitting[1], fitting[2], whole);
        }
    }
    const value = toNumber(exact);
    if (allows(VT_R4) && digits.length <= 7 && Math.abs(value) <= 3.4028234663852886e38)
    {
        data.setFloat32(0, value, true);
        return { type: VT_R4, bytes: bytes.subarray(0, 8) };
    }
    if (allows(VT_R8) && Number.isFinite(value))
    {
        data.setFloat64(0, value, true);
        return { type: VT_R8, bytes: bytes.subarray(0, 8) };
    }
    const units = round(exact, 4);
    const cy = units.value * 10n ** BigInt(4 - units.scale);
    if (allows(VT_CY) && cy >= -(1n << 63n) && cy < 1n << 63n)
    {
        data.setBigInt64(0, cy, true);
        return { type: VT_CY, bytes: bytes.subarray(0, 8) };
    }
    const decimal = allows(VT_DECIMAL) ? fitDecimal(exact) : null;
    const fourteen = decimal && decimalBytes(decimal);
    if (fourteen)
    {
        bytes.set(fourteen, 2);
        return { type: VT_DECIMAL, bytes };
    }
    return null;
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
    13: 'VariantTimeToDosDateTime',
    14: 'DosDateTimeToVariantTime',
    15: 'SafeArrayCreate',
    16: 'SafeArrayDestroy',
    17: 'SafeArrayGetDim',
    18: 'SafeArrayGetElemsize',
    19: 'SafeArrayGetUBound',
    20: 'SafeArrayGetLBound',
    21: 'SafeArrayLock',
    22: 'SafeArrayUnlock',
    23: 'SafeArrayAccessData',
    24: 'SafeArrayUnaccessData',
    25: 'SafeArrayGetElement',
    26: 'SafeArrayPutElement',
    27: 'SafeArrayCopy',
    28: 'DispGetParam',
    29: 'DispGetIDsOfNames',
    35: 'GetActiveObject',
    40: 'SafeArrayRedim',
    46: 'VarParseNumFromStr',
    47: 'VarNumFromParseNum',
    48: 'VarI2FromUI1',
    49: 'VarI2FromI4',
    50: 'VarI2FromR4',
    51: 'VarI2FromR8',
    52: 'VarI2FromCy',
    53: 'VarI2FromDate',
    54: 'VarI2FromStr',
    56: 'VarI2FromBool',
    58: 'VarI4FromUI1',
    59: 'VarI4FromI2',
    60: 'VarI4FromR4',
    61: 'VarI4FromR8',
    62: 'VarI4FromCy',
    63: 'VarI4FromDate',
    64: 'VarI4FromStr',
    66: 'VarI4FromBool',
    68: 'VarR4FromUI1',
    69: 'VarR4FromI2',
    70: 'VarR4FromI4',
    71: 'VarR4FromR8',
    72: 'VarR4FromCy',
    73: 'VarR4FromDate',
    74: 'VarR4FromStr',
    76: 'VarR4FromBool',
    78: 'VarR8FromUI1',
    79: 'VarR8FromI2',
    80: 'VarR8FromI4',
    81: 'VarR8FromR4',
    82: 'VarR8FromCy',
    83: 'VarR8FromDate',
    84: 'VarR8FromStr',
    86: 'VarR8FromBool',
    88: 'VarDateFromUI1',
    89: 'VarDateFromI2',
    90: 'VarDateFromI4',
    91: 'VarDateFromR4',
    92: 'VarDateFromR8',
    93: 'VarDateFromCy',
    94: 'VarDateFromStr',
    96: 'VarDateFromBool',
    98: 'VarCyFromUI1',
    99: 'VarCyFromI2',
    100: 'VarCyFromI4',
    101: 'VarCyFromR4',
    102: 'VarCyFromR8',
    103: 'VarCyFromDate',
    104: 'VarCyFromStr',
    106: 'VarCyFromBool',
    113: 'VarBstrFromCy',
    114: 'VarBstrFromDate',
    116: 'VarBstrFromBool',
    118: 'VarBoolFromUI1',
    119: 'VarBoolFromI2',
    120: 'VarBoolFromI4',
    121: 'VarBoolFromR4',
    122: 'VarBoolFromR8',
    123: 'VarBoolFromDate',
    124: 'VarBoolFromCy',
    125: 'VarBoolFromStr',
    130: 'VarUI1FromI2',
    131: 'VarUI1FromI4',
    132: 'VarUI1FromR4',
    133: 'VarUI1FromR8',
    134: 'VarUI1FromCy',
    135: 'VarUI1FromDate',
    136: 'VarUI1FromStr',
    138: 'VarUI1FromBool',
    141: 'VarAdd',
    142: 'VarAnd',
    143: 'VarDiv',
    146: 'DispCallFunc',
    147: 'VariantChangeTypeEx',
    148: 'SafeArrayPtrOfIndex',
    149: 'SysStringByteLen',
    150: 'SysAllocStringByteLen',
    153: 'VarIdiv',
    155: 'VarMod',
    156: 'VarMul',
    157: 'VarOr',
    159: 'VarSub',
    161: 'LoadTypeLib',
    162: 'LoadRegTypeLib',
    163: 'RegisterTypeLib',
    167: 'VarXor',
    173: 'VarNeg',
    174: 'VarNot',
    175: 'VarRound',
    176: 'VarCmp',
    183: 'LoadTypeLibEx',
    184: 'SystemTimeToVariantTime',
    185: 'VariantTimeToSystemTime',
    186: 'UnRegisterTypeLib',
    190: 'VarDecFromUI1',
    191: 'VarDecFromI2',
    192: 'VarDecFromI4',
    193: 'VarDecFromR4',
    194: 'VarDecFromR8',
    195: 'VarDecFromDate',
    196: 'VarDecFromCy',
    197: 'VarDecFromStr',
    199: 'VarDecFromBool',
    200: 'GetErrorInfo',
    201: 'SetErrorInfo',
    202: 'CreateErrorInfo',
    205: 'VarI2FromI1',
    206: 'VarI2FromUI2',
    207: 'VarI2FromUI4',
    208: 'VarI2FromDec',
    209: 'VarI4FromI1',
    210: 'VarI4FromUI2',
    211: 'VarI4FromUI4',
    212: 'VarI4FromDec',
    213: 'VarR4FromI1',
    214: 'VarR4FromUI2',
    215: 'VarR4FromUI4',
    216: 'VarR4FromDec',
    217: 'VarR8FromI1',
    218: 'VarR8FromUI2',
    219: 'VarR8FromUI4',
    220: 'VarR8FromDec',
    221: 'VarDateFromI1',
    222: 'VarDateFromUI2',
    223: 'VarDateFromUI4',
    224: 'VarDateFromDec',
    225: 'VarCyFromI1',
    226: 'VarCyFromUI2',
    227: 'VarCyFromUI4',
    228: 'VarCyFromDec',
    233: 'VarBoolFromI1',
    234: 'VarBoolFromUI2',
    235: 'VarBoolFromUI4',
    236: 'VarBoolFromDec',
    237: 'VarUI1FromI1',
    238: 'VarUI1FromUI2',
    239: 'VarUI1FromUI4',
    240: 'VarUI1FromDec',
    241: 'VarDecFromI1',
    242: 'VarDecFromUI2',
    243: 'VarDecFromUI4',
    244: 'VarI1FromUI1',
    245: 'VarI1FromI2',
    246: 'VarI1FromI4',
    247: 'VarI1FromR4',
    248: 'VarI1FromR8',
    249: 'VarI1FromDate',
    250: 'VarI1FromCy',
    251: 'VarI1FromStr',
    253: 'VarI1FromBool',
    254: 'VarI1FromUI2',
    255: 'VarI1FromUI4',
    256: 'VarI1FromDec',
    257: 'VarUI2FromUI1',
    258: 'VarUI2FromI2',
    259: 'VarUI2FromI4',
    260: 'VarUI2FromR4',
    261: 'VarUI2FromR8',
    262: 'VarUI2FromDate',
    263: 'VarUI2FromCy',
    264: 'VarUI2FromStr',
    266: 'VarUI2FromBool',
    267: 'VarUI2FromI1',
    268: 'VarUI2FromUI4',
    269: 'VarUI2FromDec',
    270: 'VarUI4FromUI1',
    271: 'VarUI4FromI2',
    272: 'VarUI4FromI4',
    273: 'VarUI4FromR4',
    274: 'VarUI4FromR8',
    275: 'VarUI4FromDate',
    276: 'VarUI4FromCy',
    277: 'VarUI4FromStr',
    279: 'VarUI4FromBool',
    280: 'VarUI4FromI1',
    281: 'VarUI4FromUI2',
    282: 'VarUI4FromDec',
    283: 'BSTR_UserSize',
    284: 'BSTR_UserMarshal',
    285: 'BSTR_UserUnmarshal',
    286: 'BSTR_UserFree',
    287: 'VARIANT_UserSize',
    288: 'VARIANT_UserMarshal',
    289: 'VARIANT_UserUnmarshal',
    290: 'VARIANT_UserFree',
    291: 'LPSAFEARRAY_UserSize',
    292: 'LPSAFEARRAY_UserMarshal',
    293: 'LPSAFEARRAY_UserUnmarshal',
    294: 'LPSAFEARRAY_UserFree',
    313: 'VarBstrCat',
    314: 'VarBstrCmp',
    318: 'VarCat',
    330: 'VarDateFromUdate',
    331: 'VarUdateFromDate',
    417: 'OleCreatePropertyFrame',
    420: 'OleCreateFontIndirect',
});

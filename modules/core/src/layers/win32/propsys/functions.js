/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * propsys - the property system's PROPVARIANT helpers: a value read as a
 * number, a boolean or a string whatever type it was stored as, and the
 * small constructors (InitPropVariantFrom*, InitVariantFrom*).
 *
 * The contract is Wine's propsys test, which holds what Windows answers: a
 * number that does not fit the type asked for is
 * HRESULT_FROM_WIN32(ERROR_ARITHMETIC_OVERFLOW); VT_EMPTY reads as zero; a
 * string reads as a number when all of it is one (C's base-0 rules: 0x for
 * hex, a leading 0 for octal); a boolean is true only as VARIANT_TRUE, and
 * a string is one as "true"/"false" in any case or "#TRUE#"/"#FALSE#" in
 * capitals; a GUID as a string is its braced uppercase form.
 */

import { formatGuid, parseGuid } from '../ole32/guid.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_FAIL = 0x80004005 | 0;
const DISP_E_TYPEMISMATCH = 0x80020005 | 0;
/** HRESULT_FROM_WIN32(ERROR_ARITHMETIC_OVERFLOW). */
export const ARITHMETIC_OVERFLOW = 0x80070216 | 0;
/** STRSAFE_E_INSUFFICIENT_BUFFER. */
const INSUFFICIENT_BUFFER = 0x8007007a | 0;

const VT = Object.freeze({ EMPTY: 0, NULL: 1, I2: 2, I4: 3, R4: 4, R8: 5, DATE: 7, BSTR: 8,
    BOOL: 11,
    I1: 16, UI1: 17, UI2: 18, UI4: 19, I8: 20, UI8: 21, INT: 22, UINT: 23, LPSTR: 30, LPWSTR: 31,
    CLSID: 72, VECTOR: 0x1000, ARRAY: 0x2000 });
const VARIANT_TRUE = 0xffff;
/** PROPVAR_COMPARE_FLAGS that change an order here. */
const PVCF_TREATEMPTYASGREATERTHAN = 0x1;
const PVCF_USESTRCMP = 0x2;
const PVCF_USESTRCMPC = 0x4;

/** Each integer type's range, for the conversions to it. */
const RANGE = Object.freeze({
    I16: [-(1n << 15n), (1n << 15n) - 1n], U16: [0n, (1n << 16n) - 1n],
    I32: [-(1n << 31n), (1n << 31n) - 1n], U32: [0n, (1n << 32n) - 1n],
    I64: [-(1n << 63n), (1n << 63n) - 1n], U64: [0n, (1n << 64n) - 1n],
});

/**
 * A string read as a whole integer, as strtoll with base 0 reads one, or
 * null when any of it is not.
 *
 * @param {string} text
 * @returns {bigint | null}
 */
export function parseInteger(text){
    const match = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(text);
    if (!match)
    {
        return null;
    }
    const digits = match[2];
    const value = /^0[xX]/.test(digits) ? BigInt(digits)
        : digits.length > 1 && digits[0] === '0' ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits);
    return match[1] === '-' ? -value : value;
}

/**
 * A double rounded to an integer the way a VARIANT conversion rounds one:
 * half to even.
 *
 * @param {number} value
 */
function roundEven(value){
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0))
    {
        return floor + 1;
    }
    return floor;
}

/**
 * @typedef {Object} PropsysHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 *     The task allocator's heap: CoTaskMemFree and PropVariantClear free what is made in it.
 * @property {(text: string) => number | Promise<number>} [bstr]  a BSTR holding the text, or 0
 * @property {(bytes: Uint8Array) => number | Promise<number>} [byteArray]
 *     A one-dimensional SAFEARRAY of VT_UI1 from 0 holding the bytes, or 0.
 * @property {(fileTime: number) => number | null | Promise<number | null>} [fileTimeToDate]
 *     The DATE a FILETIME is, as FileTimeToSystemTime and SystemTimeToVariantTime make it,
 *     or null for one they refuse.
 */

/**
 * @param {PropsysHost} host
 */
export function createPropsysFunctions(host){
    /** @param {number} at */
    const u16 = at=>{
        const b = host.readMemory(at >>> 0, 2);
        return b[0] | b[1] << 8;
    };
    /** @param {number} at */
    const u32 = at=>{
        const b = host.readMemory(at >>> 0, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} at */
    const view = at=>{
        const bytes = host.readMemory(at >>> 0, 8).slice();
        return new DataView(bytes.buffer);
    };
    /** @param {number} at @param {Uint8Array} bytes */
    const put = (at, bytes)=>host.writeMemory(at >>> 0, bytes);
    /** @param {number} at @param {number[]} words */
    const putU32s = (at, words)=>put(at,
        new Uint8Array(Uint32Array.from(words.map(w=>w >>> 0)).buffer));
    /** A NUL-ended string, narrow or wide. @param {number} at @param {boolean} wide */
    const text = (at, wide)=>{
        const width = wide ? 2 : 1;
        let out = '';
        for (let address = at >>> 0; out.length < 32768;)
        {
            const bytes = host.readMemory(address, 0x1000 - (address & 0xfff));
            for (let i = 0; i + width <= bytes.length; i += width)
            {
                const unit = wide ? bytes[i] | bytes[i + 1] << 8 : bytes[i];
                if (unit === 0)
                {
                    return out;
                }
                out += String.fromCharCode(unit);
            }
            address += bytes.length;
        }
        return out;
    };
    /** @param {string} value */
    const wideBytes = value=>{
        const bytes = new Uint8Array((value.length + 1) * 2);
        for (let i = 0; i < value.length; i++)
        {
            bytes[i * 2] = value.charCodeAt(i) & 0xff;
            bytes[i * 2 + 1] = value.charCodeAt(i) >>> 8;
        }
        return bytes;
    };
    /** Task memory holding the bytes, or 0. @param {Uint8Array} bytes */
    const taskCopy = bytes=>{
        const at = host.heap.allocate(Math.max(bytes.length, 1)) >>> 0;
        if (at !== 0 && bytes.length > 0)
        {
            put(at, bytes);
        }
        return at;
    };
    /** A PROPVARIANT's (or VARIANT's) first 16 bytes. @param {number} vt @param {number[]} value */
    const record = (vt, value)=>{
        const bytes = new Uint8Array(16);
        const v = new DataView(bytes.buffer);
        v.setUint16(0, vt, true);
        value.forEach((word, i)=>v.setUint32(8 + i * 4, word >>> 0, true));
        return bytes;
    };

    /**
     * What a PROPVARIANT holds, as a number or a string to read one from:
     * null for a type that is neither.
     *
     * @param {number} at
     * @returns {{ integer: bigint } | { real: number } | { string: string | null } | null}
     */
    const valueOf = at=>{
        const vt = u16(at);
        const v = view(at + 8);
        switch (vt)
        {
            case VT.EMPTY:
                return { integer: 0n };
            case VT.I1:
                return { integer: BigInt(v.getInt8(0)) };
            case VT.UI1:
                return { integer: BigInt(v.getUint8(0)) };
            case VT.I2:
            case VT.BOOL:
                return { integer: BigInt(v.getInt16(0, true)) };
            case VT.UI2:
                return { integer: BigInt(v.getUint16(0, true)) };
            case VT.I4:
            case VT.INT:
                return { integer: BigInt(v.getInt32(0, true)) };
            case VT.UI4:
            case VT.UINT:
                return { integer: BigInt(v.getUint32(0, true)) };
            case VT.I8:
                return { integer: v.getBigInt64(0, true) };
            case VT.UI8:
                return { integer: v.getBigUint64(0, true) };
            case VT.R4:
                return { real: v.getFloat32(0, true) };
            case VT.R8:
                return { real: v.getFloat64(0, true) };
            case VT.LPWSTR:
            case VT.BSTR: {
                const pointer = v.getUint32(0, true);
                return { string: pointer === 0 ? null : text(pointer, true) };
            }
            case VT.LPSTR: {
                const pointer = v.getUint32(0, true);
                return { string: pointer === 0 ? null : text(pointer, false) };
            }
            default:
                return null;
        }
    };

    /**
     * A PROPVARIANT as an integer within a range.
     *
     * @param {number} at @param {bigint[]} range
     * @returns {{ hr: number, value: bigint }}
     */
    const integerOf = (at, [low, high])=>{
        const held = valueOf(at);
        /** @type {bigint | null} */
        let value = null;
        if (held && 'integer' in held)
        {
            value = held.integer;
        }
        else if (held && 'real' in held)
        {
            value = Number.isFinite(held.real) ? BigInt(roundEven(held.real)) : null;
            if (value === null)
            {
                return { hr: ARITHMETIC_OVERFLOW, value: 0n };
            }
        }
        else if (held && 'string' in held)
        {
            value = held.string === null ? null : parseInteger(held.string);
        }
        if (value === null)
        {
            return { hr: DISP_E_TYPEMISMATCH, value: 0n };
        }
        if (value < low || value > high)
        {
            return { hr: ARITHMETIC_OVERFLOW, value: 0n };
        }
        return { hr: S_OK, value };
    };

    /**
     * PropVariantTo<integer>(REFPROPVARIANT, <integer> *): the value written
     * only when it converts.
     *
     * @param {bigint[]} range @param {number} bytes
     */
    const toInteger = (range, bytes)=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([pv, out])=>{
            if ((pv >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { hr, value } = integerOf(pv, range);
            if (hr === S_OK)
            {
                const word = new Uint8Array(bytes);
                const v = new DataView(word.buffer);
                if (bytes === 8)
                {
                    v.setBigUint64(0, BigInt.asUintN(64, value), true);
                }
                else if (bytes === 4)
                {
                    v.setUint32(0, Number(BigInt.asUintN(32, value)), true);
                }
                else
                {
                    v.setUint16(0, Number(BigInt.asUintN(16, value)), true);
                }
                put(out, word);
            }
            return hr;
        },
    });

    /**
     * PropVariantTo<integer>WithDefault(REFPROPVARIANT, <integer>): the
     * default on any failure.
     *
     * @param {bigint[]} range
     */
    const withDefault = range=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([pv, fallback])=>{
            if ((pv >>> 0) === 0)
            {
                return fallback;
            }
            const { hr, value } = integerOf(pv, range);
            return hr === S_OK ? Number(BigInt.asUintN(32, value)) : fallback;
        },
    });

    /**
     * A PROPVARIANT as a boolean, or why not.
     *
     * @param {number} at
     * @returns {{ hr: number, value: boolean }}
     */
    const booleanOf = at=>{
        if (u16(at) === VT.BOOL)
        {
            return { hr: S_OK, value: u16(at + 8) === VARIANT_TRUE };
        }
        const held = valueOf(at);
        if (held && 'integer' in held)
        {
            return { hr: S_OK, value: held.integer !== 0n };
        }
        if (held && 'real' in held)
        {
            return { hr: S_OK, value: held.real !== 0 };
        }
        if (held && 'string' in held && held.string !== null)
        {
            const s = held.string;
            if (/^true$/i.test(s) || s === '#TRUE#')
            {
                return { hr: S_OK, value: true };
            }
            if (/^false$/i.test(s) || s === '#FALSE#')
            {
                return { hr: S_OK, value: false };
            }
            const number = parseInteger(s);
            if (number !== null)
            {
                return { hr: S_OK, value: number !== 0n };
            }
        }
        return { hr: DISP_E_TYPEMISMATCH, value: false };
    };

    /**
     * A PROPVARIANT as a string, or why not.
     *
     * @param {number} at
     * @returns {{ hr: number, value: string }}
     */
    const stringOf = at=>{
        const held = valueOf(at);
        if (held && 'string' in held)
        {
            return { hr: S_OK, value: held.string ?? '' };
        }
        if (held && 'integer' in held)
        {
            return { hr: S_OK, value: u16(at) === VT.EMPTY ? '' : held.integer.toString() };
        }
        return { hr: DISP_E_TYPEMISMATCH, value: '' };
    };

    /**
     * A record written once what it holds is made; E_OUTOFMEMORY when that
     * could not be.
     *
     * @param {number} out @param {number} vt @param {number | Promise<number>} made
     * @param {(at: number) => number[]} [words]
     */
    const recordOf = (out, vt, made, words = at=>[at])=>{
        /** @param {number} at */
        const write = at=>{
            if ((at >>> 0) === 0)
            {
                return E_OUTOFMEMORY;
            }
            put(out, record(vt, words(at)));
            return S_OK;
        };
        return typeof made === 'number' ? write(made) : made.then(write);
    };

    /** @param {number} at */
    const isEmpty = at=>{
        const vt = u16(at);
        if (vt === VT.EMPTY || vt === VT.NULL)
        {
            return true;
        }
        if (vt === VT.CLSID)
        {
            return u32(at + 8) === 0;
        }
        if ((vt & VT.VECTOR) !== 0)
        {
            return u32(at + 8) === 0;
        }
        if ((vt & VT.ARRAY) !== 0)
        {
            // SAFEARRAY: cDims, then rgsabound's element counts from 16 on.
            const array = u32(at + 8);
            if (array === 0)
            {
                return true;
            }
            const dims = u16(array);
            for (let i = 0; i < dims; i++)
            {
                if (u32(array + 16 + i * 8) === 0)
                {
                    return true;
                }
            }
            return false;
        }
        return false;
    };

    /** @param {number} a @param {number} b */
    const sign = (a, b)=>(a < b ? -1 : a > b ? 1 : 0);
    /** @param {Uint8Array} a @param {Uint8Array} b */
    const bytesOrder = (a, b)=>{
        for (let i = 0; i < Math.min(a.length, b.length); i++)
        {
            if (a[i] !== b[i])
            {
                return sign(a[i], b[i]);
            }
        }
        return sign(a.length, b.length);
    };
    /** @type {Map<number, bigint[]>} the range of each integer type, by VT */
    const RANGE_OF = new Map([[VT.I1, [-128n, 127n]], [VT.UI1, [0n, 255n]], [VT.I2, RANGE.I16],
        [VT.UI2, RANGE.U16], [VT.BOOL, RANGE.I16], [VT.I4, RANGE.I32], [VT.INT, RANGE.I32],
        [VT.UI4, RANGE.U32], [VT.UINT, RANGE.U32], [VT.I8, RANGE.I64], [VT.UI8, RANGE.U64]]);

    /**
     * PropVariantCompareEx's order: the second value taken as the first's
     * type, and -1 when it cannot be.
     *
     * @param {number} a @param {number} b @param {number} flags
     */
    const compare = (a, b, flags)=>{
        const emptyA = isEmpty(a);
        const emptyB = isEmpty(b);
        const greater = (flags & PVCF_TREATEMPTYASGREATERTHAN) !== 0;
        if (emptyA || emptyB)
        {
            return emptyA && emptyB ? 0 : emptyA === greater ? 1 : -1;
        }
        const vt = u16(a);
        const range = RANGE_OF.get(vt);
        if (range)
        {
            const left = integerOf(a, range);
            const right = integerOf(b, range);
            return right.hr !== S_OK ? -1 : left.value < right.value ? -1
                : left.value > right.value ? 1 : 0;
        }
        if (vt === VT.R4 || vt === VT.R8)
        {
            const left = valueOf(a);
            const right = valueOf(b);
            const real = (/** @type {any} */ held)=>(held && 'real' in held ? held.real
                : held && 'integer' in held ? Number(held.integer) : null);
            const l = real(left);
            const r = real(right);
            return l === null || r === null ? -1 : sign(l, r);
        }
        if (vt === VT.LPWSTR || vt === VT.LPSTR || vt === VT.BSTR)
        {
            const left = stringOf(a).value;
            const right = stringOf(b);
            if (right.hr !== S_OK)
            {
                return -1;
            }
            const exact = (flags & (PVCF_USESTRCMP | PVCF_USESTRCMPC)) !== 0;
            const l = exact ? left : left.toLowerCase();
            const r = exact ? right.value : right.value.toLowerCase();
            return l < r ? -1 : l > r ? 1 : 0;
        }
        if (vt === VT.CLSID)
        {
            const left = host.readMemory(u32(a + 8), 16);
            const held = valueOf(b);
            const right = u16(b) === VT.CLSID ? host.readMemory(u32(b + 8), 16)
                : held && 'string' in held && held.string !== null ? parseGuid(held.string) : null;
            return right ? bytesOrder(left, right) : -1;
        }
        if (vt === (VT.VECTOR | VT.UI1) && u16(b) === vt)
        {
            const bytesAt = (/** @type {number} */ at)=>(u32(at + 8) === 0 ? new Uint8Array(0)
                : host.readMemory(u32(at + 12), u32(at + 8)));
            return bytesOrder(bytesAt(a), bytesAt(b));
        }
        return -1;
    };

    return {
        /**
         * INT PropVariantCompareEx(REFPROPVARIANT, REFPROPVARIANT,
         *     PROPVAR_COMPARE_UNIT, PROPVAR_COMPARE_FLAGS)
         */
        PropVariantCompareEx: { argBytes: 16,
            handler: (/** @type {number[]} */ [a, b, , flags])=>compare(a >>> 0, b >>> 0, flags) },

        PropVariantToInt16: toInteger(RANGE.I16, 2),
        PropVariantToUInt16: toInteger(RANGE.U16, 2),
        PropVariantToInt32: toInteger(RANGE.I32, 4),
        PropVariantToUInt32: toInteger(RANGE.U32, 4),
        PropVariantToInt64: toInteger(RANGE.I64, 8),
        PropVariantToUInt64: toInteger(RANGE.U64, 8),
        PropVariantToInt32WithDefault: withDefault(RANGE.I32),
        PropVariantToUInt32WithDefault: withDefault(RANGE.U32),

        /** HRESULT PropVariantToDouble(REFPROPVARIANT, DOUBLE *) */
        PropVariantToDouble: { argBytes: 8, handler: (/** @type {number[]} */ [pv, out])=>{
            if ((pv >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const held = valueOf(pv);
            /** @type {number | null} */
            let value = null;
            if (held && 'integer' in held)
            {
                value = Number(held.integer);
            }
            else if (held && 'real' in held)
            {
                value = held.real;
            }
            else if (held && 'string' in held && held.string !== null
                && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(held.string))
            {
                value = Number(held.string);
            }
            if (value === null)
            {
                return DISP_E_TYPEMISMATCH;
            }
            const bytes = new Uint8Array(8);
            new DataView(bytes.buffer).setFloat64(0, value, true);
            put(out, bytes);
            return S_OK;
        } },

        /** HRESULT PropVariantToBoolean(REFPROPVARIANT, BOOL *): FALSE on any failure. */
        PropVariantToBoolean: { argBytes: 8, handler: (/** @type {number[]} */ [pv, out])=>{
            if ((pv >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { hr, value } = booleanOf(pv);
            putU32s(out, [value ? 1 : 0]);
            return hr;
        } },
        /** BOOL PropVariantToBooleanWithDefault(REFPROPVARIANT, BOOL) */
        PropVariantToBooleanWithDefault: { argBytes: 8,
            handler: (/** @type {number[]} */ [pv, fallback])=>{
                if ((pv >>> 0) === 0)
                {
                    return fallback;
                }
                const { hr, value } = booleanOf(pv);
                return hr === S_OK ? (value ? 1 : 0) : fallback;
            } },

        /**
         * HRESULT PropVariantToString(REFPROPVARIANT, PWSTR buffer, UINT cch):
         * a string that does not fit is cut to the buffer, NUL-ended, and
         * answered STRSAFE_E_INSUFFICIENT_BUFFER.
         */
        PropVariantToString: { argBytes: 12, handler: (/** @type {number[]} */ [pv, buffer, cch])=>{
            if ((pv >>> 0) === 0 || (buffer >>> 0) === 0 || (cch >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { hr, value } = stringOf(pv);
            if (hr !== S_OK)
            {
                put(buffer, new Uint8Array(2));
                return hr;
            }
            const fits = value.length < (cch >>> 0);
            put(buffer, wideBytes(fits ? value : value.slice(0, (cch >>> 0) - 1)));
            return fits ? S_OK : INSUFFICIENT_BUFFER;
        } },
        /** HRESULT PropVariantToStringAlloc(REFPROPVARIANT, PWSTR *) */
        PropVariantToStringAlloc: { argBytes: 8, handler: (/** @type {number[]} */ [pv, out])=>{
            if ((pv >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { hr, value } = stringOf(pv);
            if (hr !== S_OK)
            {
                putU32s(out, [0]);
                return hr;
            }
            const copy = taskCopy(wideBytes(value));
            putU32s(out, [copy]);
            return copy === 0 ? E_OUTOFMEMORY : S_OK;
        } },

        /** HRESULT InitPropVariantFromGUIDAsString(REFGUID, PROPVARIANT *) */
        InitPropVariantFromGUIDAsString: { argBytes: 8,
            handler: (/** @type {number[]} */ [guid, out])=>{
                if ((guid >>> 0) === 0)
                {
                    return E_FAIL;
                }
                return recordOf(out, VT.LPWSTR,
                    taskCopy(wideBytes(formatGuid(host.readMemory(guid >>> 0, 16)))));
            } },
        /** HRESULT InitVariantFromGUIDAsString(REFGUID, VARIANT *) */
        InitVariantFromGUIDAsString: { argBytes: 8,
            handler: (/** @type {number[]} */ [guid, out])=>{
                if ((guid >>> 0) === 0)
                {
                    return E_FAIL;
                }
                const made = host.bstr?.(formatGuid(host.readMemory(guid >>> 0, 16))) ?? 0;
                return recordOf(out, VT.BSTR, made);
            } },
        /** HRESULT InitPropVariantFromBuffer(const void *, UINT, PROPVARIANT *) */
        InitPropVariantFromBuffer: { argBytes: 12,
            handler: (/** @type {number[]} */ [data, size, out])=>{
                const bytes = (size >>> 0) === 0 ? new Uint8Array(0)
                    : host.readMemory(data >>> 0, size >>> 0).slice();
                return recordOf(out, VT.VECTOR | VT.UI1, taskCopy(bytes), at=>[bytes.length, at]);
            } },
        /** HRESULT InitVariantFromBuffer(const void *, UINT, VARIANT *) */
        InitVariantFromBuffer: { argBytes: 12,
            handler: (/** @type {number[]} */ [data, size, out])=>{
                const bytes = (size >>> 0) === 0 ? new Uint8Array(0)
                    : host.readMemory(data >>> 0, size >>> 0).slice();
                return recordOf(out, VT.ARRAY | VT.UI1, host.byteArray?.(bytes) ?? 0);
            } },
        /** HRESULT InitPropVariantFromCLSID(REFCLSID, PROPVARIANT *) */
        InitPropVariantFromCLSID: { argBytes: 8, handler: (/** @type {number[]} */ [clsid, out])=>
            recordOf(out, VT.CLSID, taskCopy(host.readMemory(clsid >>> 0, 16).slice())) },
        /**
         * HRESULT InitPropVariantFromStringVector(PCWSTR *strings, ULONG count, PROPVARIANT *):
         * each string copied, the vector a pointer even when it is empty.
         */
        InitPropVariantFromStringVector: { argBytes: 12,
            handler: (/** @type {number[]} */ [strings, count, out])=>{
                const n = count >>> 0;
                const vector = host.heap.allocate(Math.max(n * 4, 1)) >>> 0;
                if (vector === 0)
                {
                    return E_OUTOFMEMORY;
                }
                /** @type {number[]} */
                const copies = [];
                for (let i = 0; i < n; i++)
                {
                    const copy = taskCopy(wideBytes(text(u32((strings >>> 0) + i * 4), true)));
                    if (copy === 0)
                    {
                        copies.forEach(at=>host.heap.free(at));
                        host.heap.free(vector);
                        return E_OUTOFMEMORY;
                    }
                    copies.push(copy);
                }
                if (n > 0)
                {
                    putU32s(vector, copies);
                }
                put(out, record(VT.VECTOR | VT.LPWSTR, [n, vector]));
                return S_OK;
            } },
        /**
         * HRESULT InitVariantFromFileTime(const FILETIME *, VARIANT *): a
         * FILETIME with no date leaves the VARIANT empty, E_INVALIDARG.
         */
        InitVariantFromFileTime: { argBytes: 8, handler: (/** @type {number[]} */ [time, out])=>{
            /** @param {number | null} date */
            const write = date=>{
                if (date === null)
                {
                    put(out, new Uint8Array(16));
                    return E_INVALIDARG;
                }
                const bytes = record(VT.DATE, []);
                new DataView(bytes.buffer).setFloat64(8, date, true);
                put(out, bytes);
                return S_OK;
            };
            const date = host.fileTimeToDate?.(time >>> 0) ?? null;
            return date !== null && typeof date === 'object' ? date.then(write) : write(date);
        } },
    };
}

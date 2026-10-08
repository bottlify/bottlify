/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VARIANTs in guest memory, read as script values and written from them:
 * the layout of the 32-bit VARIANT, SAFEARRAY, BSTR and DECIMAL, and who
 * owns what each holds.
 *
 * Reading a VARIANT the guest handed over (`owned`) takes what it holds: a
 * BSTR is read and freed, a SAFEARRAY read and destroyed, an interface's
 * reference passed on to the object that wraps it. Reading one that is
 * only lent (an argument, an element of an array about to be destroyed)
 * copies what it holds and takes a reference of its own. Writing a value
 * gives the VARIANT whatever it holds -- a new BSTR, a new SAFEARRAY, an
 * interface with a reference -- for its receiver to clear with
 * VariantClear.
 *
 * Interfaces are not this file's: a dispatch pointer is turned into a value
 * and a value into a pointer by the {@link InterfaceCodec} it is given.
 *
 * @typedef {import('./values.js').Value} Value
 */

import {
    VT_ARRAY, VT_BOOL, VT_BSTR, VT_BYREF, VT_CY, VT_DATE, VT_DECIMAL, VT_DISPATCH, VT_EMPTY,
    VT_ERROR, VT_I1, VT_I2, VT_I4, VT_I8, VT_INT, VT_NULL, VT_R4, VT_R8, VT_TYPEMASK, VT_UI1,
    VT_UI2, VT_UI4, VT_UI8, VT_UINT, VT_UNKNOWN, VT_VARIANT,
} from '../oleaut32/vartypes.js';
import { ExternalError } from './external.js';
import { ForeignValue, NOTHING, arrayValue, dateValue, errorValue } from './values.js';

export const VARIANT_SIZE = 16;
const E_OUTOFMEMORY = 0x8007000e | 0;
const VARIANT_TRUE = 0xffff;

/**
 * What a script engine needs of the guest to reach its COM objects. The
 * embedder supplies it; nothing in the runtime calls the bridge itself.
 *
 * @typedef {Object} GuestCom
 * @property {(entry: number, args: number[], thread?: unknown) => number | Promise<number>} call
 *     Calls a guest stdcall function on a thread; a method takes its `this`
 *     first.
 * @property {() => unknown} [callerThread]  The thread whose call into the
 *     engine is being answered, read when the call arrives.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  Scratch memory the guest can
 *     read and write; 0 when there is none.
 * @property {(address: number) => void} free
 * @property {(name: string, args: number[]) => number | Promise<number>} oleaut32
 *     An OLEAUT32 export, called as the guest would: SysAllocStringLen,
 *     SysFreeString, VariantClear, SafeArrayCreate, SafeArrayDestroy.
 * @property {number} [lcid]  The locale a call is made in.
 */

/**
 * How interfaces cross: a pointer the guest gave becomes a value (`owned`
 * when the reference is the receiver's to keep), and a value that is an
 * object becomes a pointer carrying a reference for whoever receives it.
 *
 * @typedef {Object} InterfaceCodec
 * @property {(pointer: number, kind: 'dispatch' | 'unknown', owned: boolean)
 *     => Value | Promise<Value>} import
 * @property {(value: Value) => number | Promise<number>} export
 * @property {(value: Value) => Value} [prepare]  What a value is written as:
 *     a language's own wrapper of a VARIANT unwrapped, for one.
 * @property {(vt: number, value: Value) => Value} [adopt]  What a value read
 *     out of a VARIANT becomes, given its VARTYPE: a language that keeps a
 *     number's subtype wraps it (`values.js`), and one that tells Nothing
 *     from null says what a null interface pointer is. Not asked of an
 *     array, nor of an interface that points at something.
 */

/** Little-endian reads and writes of guest memory. @param {GuestCom} com */
export function guestMemory(com){
    /** @param {number} address @param {number} length */
    const view = (address, length)=>new DataView(com.readMemory(address >>> 0, length).slice()
        .buffer);
    /** @param {number} address @param {number} bytes @param {(v: DataView) => void} fill */
    const put = (address, bytes, fill)=>{
        const buffer = new Uint8Array(bytes);
        fill(new DataView(buffer.buffer));
        com.writeMemory(address >>> 0, buffer);
    };
    return {
        /** @param {number} a */
        u8: a=>view(a, 1).getUint8(0),
        /** @param {number} a */
        i8: a=>view(a, 1).getInt8(0),
        /** @param {number} a */
        u16: a=>view(a, 2).getUint16(0, true),
        /** @param {number} a */
        i16: a=>view(a, 2).getInt16(0, true),
        /** @param {number} a */
        u32: a=>view(a, 4).getUint32(0, true),
        /** @param {number} a */
        i32: a=>view(a, 4).getInt32(0, true),
        /** @param {number} a */
        f32: a=>view(a, 4).getFloat32(0, true),
        /** @param {number} a */
        f64: a=>view(a, 8).getFloat64(0, true),
        /** @param {number} a */
        i64: a=>view(a, 8).getBigInt64(0, true),
        /** @param {number} a */
        u64: a=>view(a, 8).getBigUint64(0, true),
        /** @param {number} a @param {number} v */
        writeU16: (a, v)=>put(a, 2, d=>d.setUint16(0, v, true)),
        /** @param {number} a @param {number} v */
        writeU32: (a, v)=>put(a, 4, d=>d.setUint32(0, v >>> 0, true)),
        /** @param {number} a @param {number} v */
        writeF64: (a, v)=>put(a, 8, d=>d.setFloat64(0, v, true)),
        /** @param {number} a @param {number} bytes */
        zero: (a, bytes)=>com.writeMemory(a >>> 0, new Uint8Array(bytes)),
        /**
         * UTF-16 text, `units` code units long.
         *
         * @param {number} a @param {number} units @returns {string}
         */
        readWide: (a, units)=>{
            const bytes = com.readMemory(a >>> 0, units * 2);
            let text = '';
            for (let i = 0; i + 1 < bytes.length; i += 2)
            {
                text += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
            }
            return text;
        },
        /**
         * UTF-16 text up to its terminator, as far as `max` units.
         *
         * @param {number} a @param {number} max @returns {string}
         */
        readWideString: (a, max)=>{
            const bytes = com.readMemory(a >>> 0, max * 2);
            let text = '';
            for (let i = 0; i + 1 < bytes.length; i += 2)
            {
                const unit = bytes[i] | (bytes[i + 1] << 8);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },
        /** @param {number} a @param {string} text @param {boolean} terminate */
        writeWide: (a, text, terminate)=>{
            const bytes = new Uint8Array(text.length * 2 + (terminate ? 2 : 0));
            for (let i = 0; i < text.length; i++)
            {
                const unit = text.charCodeAt(i);
                bytes[i * 2] = unit & 0xff;
                bytes[i * 2 + 1] = unit >> 8;
            }
            com.writeMemory(a >>> 0, bytes);
        },
    };
}

/** @typedef {ReturnType<typeof guestMemory>} GuestMemory */

/**
 * A DECIMAL's value (wReserved, scale, sign, Hi32, Lo64) as a number.
 *
 * @param {GuestMemory} memory @param {number} at @returns {number}
 */
function readDecimal(memory, at){
    const scale = memory.u8(at + 2);
    const negative = (memory.u8(at + 3) & 0x80) !== 0;
    const magnitude = (BigInt(memory.u32(at + 4)) << 64n) | memory.u64(at + 8);
    const value = Number(magnitude) / 10 ** scale;
    return negative ? -value : value;
}

/** @param {GuestCom} com @param {InterfaceCodec} interfaces */
export function createVariantCodec(com, interfaces){
    const memory = guestMemory(com);

    /** @param {number} bstr @returns {string} */
    const readBstr = bstr=>(bstr === 0 ? '' : memory.readWide(bstr, memory.u32(bstr - 4) >>> 1));

    /** @param {string} text @returns {Promise<number>} a new BSTR */
    const allocateBstr = async text=>{
        const bstr = (await com.oleaut32('SysAllocStringLen', [0, text.length])) >>> 0;
        if (bstr === 0)
        {
            throw new ExternalError(E_OUTOFMEMORY);
        }
        memory.writeWide(bstr, text, true);
        return bstr;
    };

    /**
     * A value of a type held at `at`; a DECIMAL by value fills the whole
     * VARIANT, so `variant` is where it starts.
     *
     * @param {number} vt @param {number} at @param {number} variant @param {boolean} owned
     * @returns {Promise<Value>}
     */
    const readTyped = async(vt, at, variant, owned)=>{
        const adopt = interfaces.adopt;
        if (adopt && (vt & VT_ARRAY) === 0
            && ((vt !== VT_DISPATCH && vt !== VT_UNKNOWN) || memory.u32(at) === 0))
        {
            return adopt(vt, await readScalar(vt, at, variant, owned));
        }
        return readScalar(vt, at, variant, owned);
    };

    /**
     * @param {number} vt @param {number} at @param {number} variant @param {boolean} owned
     * @returns {Promise<Value>}
     */
    const readScalar = async(vt, at, variant, owned)=>{
        if ((vt & VT_ARRAY) !== 0)
        {
            const array = memory.u32(at);
            if (array === 0)
            {
                return null;
            }
            const contents = await readSafeArray(array, vt & VT_TYPEMASK);
            if (owned)
            {
                await com.oleaut32('SafeArrayDestroy', [array]);
            }
            return arrayValue(contents);
        }
        switch (vt)
        {
            case VT_EMPTY: return undefined;
            case VT_NULL: return null;
            case VT_I1: return memory.i8(at);
            case VT_UI1: return memory.u8(at);
            case VT_I2: return memory.i16(at);
            case VT_UI2: return memory.u16(at);
            case VT_I4: case VT_INT: return memory.i32(at);
            case VT_UI4: case VT_UINT: return memory.u32(at);
            case VT_R4: return memory.f32(at);
            case VT_R8: return memory.f64(at);
            case VT_CY: return Number(memory.i64(at)) / 10000;
            case VT_DECIMAL: return readDecimal(memory, variant);
            case VT_BOOL: return memory.u16(at) !== 0;
            case VT_DATE: return dateValue(memory.f64(at));
            case VT_ERROR: return errorValue(memory.i32(at));
            case VT_I8: return new ForeignValue(VT_I8, Number(memory.i64(at)));
            case VT_UI8: return new ForeignValue(VT_UI8, Number(memory.u64(at)));
            case VT_BSTR:
            {
                const bstr = memory.u32(at);
                const text = readBstr(bstr);
                if (owned && bstr !== 0)
                {
                    await com.oleaut32('SysFreeString', [bstr]);
                }
                return text;
            }
            case VT_DISPATCH:
            case VT_UNKNOWN:
            {
                const pointer = memory.u32(at);
                if (pointer === 0)
                {
                    return null;
                }
                return interfaces.import(pointer, vt === VT_DISPATCH ? 'dispatch' : 'unknown',
                    owned);
            }
            default:
                return new ForeignValue(vt, undefined);
        }
    };

    /**
     * A SAFEARRAY's contents. The bounds are stored last dimension first.
     *
     * @param {number} array @param {number} elementType
     * @returns {Promise<import('./values.js').SafeArrayValue>}
     */
    const readSafeArray = async(array, elementType)=>{
        const dims = memory.u16(array);
        const elementBytes = memory.u32(array + 4);
        const data = memory.u32(array + 12);
        const bounds = [];
        let total = dims > 0 ? 1 : 0;
        for (let d = 0; d < dims; d++)
        {
            const entry = array + 16 + (dims - 1 - d) * 8;
            const count = memory.u32(entry);
            bounds.push({ lower: memory.i32(entry + 4), count });
            total *= count;
        }
        const items = [];
        for (let i = 0; i < total; i++)
        {
            const at = data + i * elementBytes;
            items.push(elementType === VT_VARIANT
                ? await read(at, false) : await readTyped(elementType, at, at, false));
        }
        return { elementType, bounds, items };
    };

    /**
     * A VARIANT at `address` as a value.
     *
     * @param {number} address @param {boolean} owned
     * @returns {Promise<Value>}
     */
    const read = async(address, owned)=>{
        const vt = memory.u16(address);
        if ((vt & VT_BYREF) !== 0)
        {
            const target = memory.u32(address + 8);
            const type = vt & ~VT_BYREF;
            if (target === 0)
            {
                return undefined;
            }
            return type === VT_VARIANT ? read(target, false)
                : readTyped(type, target, target, false);
        }
        return readTyped(vt, address + 8, address, owned);
    };

    /**
     * One element of an array, of the array's element type.
     *
     * @param {number} type @param {number} at @param {Value} value
     */
    const writeElement = async(type, at, value)=>{
        switch (type)
        {
            case VT_VARIANT:
                await write(at, value);
                return;
            case VT_BSTR:
                memory.writeU32(at, await allocateBstr(String(value ?? '')));
                return;
            case VT_I4: case VT_INT: case VT_UI4: case VT_UINT: case VT_ERROR:
                memory.writeU32(at, Number(value) | 0);
                return;
            case VT_I2: case VT_UI2:
                memory.writeU16(at, Number(value) & 0xffff);
                return;
            case VT_BOOL:
                memory.writeU16(at, value ? VARIANT_TRUE : 0);
                return;
            case VT_UI1: case VT_I1:
                com.writeMemory(at, Uint8Array.of(Number(value) & 0xff));
                return;
            case VT_R8: case VT_DATE:
                memory.writeF64(at, value instanceof ForeignValue ? value.value : Number(value));
                return;
            case VT_DISPATCH: case VT_UNKNOWN:
                memory.writeU32(at, value === null || value === undefined
                    ? 0 : await interfaces.export(value));
                return;
            default:
                return;
        }
    };

    /** @param {import('./values.js').SafeArrayValue} contents @returns {Promise<number>} */
    const writeSafeArray = async contents=>{
        const dims = contents.bounds.length;
        const bounds = com.allocate(dims * 8);
        if (bounds === 0)
        {
            throw new ExternalError(E_OUTOFMEMORY);
        }
        let array;
        try
        {
            contents.bounds.forEach(({ lower, count }, d)=>{
                memory.writeU32(bounds + d * 8, count);
                memory.writeU32(bounds + d * 8 + 4, lower);
            });
            array = (await com.oleaut32('SafeArrayCreate', [contents.elementType, dims,
                bounds])) >>> 0;
        }
        finally
        {
            com.free(bounds);
        }
        if (array === 0)
        {
            throw new ExternalError(E_OUTOFMEMORY);
        }
        const elementBytes = memory.u32(array + 4);
        const data = memory.u32(array + 12);
        for (let i = 0; i < contents.items.length; i++)
        {
            await writeElement(contents.elementType, data + i * elementBytes, contents.items[i]);
        }
        return array;
    };

    /**
     * Writes a value into the VARIANT at `address`, which holds nothing
     * that needs clearing.
     *
     * @param {number} address @param {Value} given
     */
    const write = async(address, given)=>{
        const value = interfaces.prepare ? interfaces.prepare(given) : given;
        memory.zero(address, VARIANT_SIZE);
        /** @param {number} vt */
        const type = vt=>memory.writeU16(address, vt);
        switch (typeof value)
        {
            case 'undefined':
                return;
            case 'boolean':
                type(VT_BOOL);
                memory.writeU16(address + 8, value ? VARIANT_TRUE : 0);
                return;
            case 'number':
                if ((value | 0) === value && !Object.is(value, -0))
                {
                    type(VT_I4);
                    memory.writeU32(address + 8, value);
                }
                else
                {
                    type(VT_R8);
                    memory.writeF64(address + 8, value);
                }
                return;
            case 'string':
                memory.writeU32(address + 8, await allocateBstr(value));
                type(VT_BSTR);
                return;
            default:
                break;
        }
        if (value === null)
        {
            type(VT_NULL);
            return;
        }
        if (value === NOTHING)
        {
            type(VT_DISPATCH);
            return;
        }
        if (value instanceof ForeignValue)
        {
            if (value.isArray)
            {
                memory.writeU32(address + 8, await writeSafeArray(value.value));
                type(value.vt);
                return;
            }
            switch (value.vt)
            {
                case VT_DATE:
                    memory.writeF64(address + 8, value.value);
                    break;
                case VT_ERROR:
                    memory.writeU32(address + 8, value.value);
                    break;
                case VT_I8: case VT_UI8:
                    memory.writeF64(address + 8, value.value);
                    type(VT_R8);
                    return;
                // A number held with its subtype is written as that type.
                case VT_I1: case VT_UI1:
                    com.writeMemory(address + 8, Uint8Array.of(value.value & 0xff));
                    break;
                case VT_I2: case VT_UI2:
                    memory.writeU16(address + 8, value.value & 0xffff);
                    break;
                case VT_I4: case VT_UI4: case VT_INT: case VT_UINT:
                    memory.writeU32(address + 8, value.value);
                    break;
                case VT_R4:
                    writeF32(address + 8, value.value);
                    break;
                case VT_R8:
                    memory.writeF64(address + 8, value.value);
                    break;
                case VT_CY:
                    writeI64(address + 8, BigInt(Math.round(value.value * 10000)));
                    break;
                case VT_DECIMAL:
                    writeDecimal(address, value.value);
                    return;
                case VT_UNKNOWN:
                    memory.writeU32(address + 8, await interfaces.export(value));
                    break;
                default:
                    return;
            }
            type(value.vt);
            return;
        }
        const pointer = await interfaces.export(value);
        memory.writeU32(address + 8, pointer);
        type(VT_DISPATCH);
    };

    /** @param {number} at @param {number} number */
    const writeF32 = (at, number)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setFloat32(0, number, true);
        com.writeMemory(at, bytes);
    };

    /** @param {number} at @param {bigint} whole */
    const writeI64 = (at, whole)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigInt64(0, whole, true);
        com.writeMemory(at, bytes);
    };

    /**
     * A number as the DECIMAL filling the VARIANT at `variant`, its vt
     * included: the digits a double spells, scaled to a whole number.
     *
     * @param {number} variant @param {number} number
     */
    const writeDecimal = (variant, number)=>{
        const [mantissa, exponent = '0'] = Math.abs(number).toPrecision(15).split('e');
        const [whole, fraction = ''] = mantissa.split('.');
        let digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
        let scale = fraction.length - Number(exponent);
        while (scale < 0)
        {
            digits += '0';
            scale++;
        }
        while (scale > 0 && digits.endsWith('0'))
        {
            digits = digits.slice(0, -1);
            scale--;
        }
        const magnitude = BigInt(digits || '0');
        const bytes = new Uint8Array(VARIANT_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, VT_DECIMAL, true);
        view.setUint8(2, Math.min(scale, 28));
        view.setUint8(3, number < 0 ? 0x80 : 0);
        view.setUint32(4, Number((magnitude >> 64n) & 0xffffffffn), true);
        view.setBigUint64(8, magnitude & 0xffffffffffffffffn, true);
        com.writeMemory(variant, bytes);
    };

    return { read, write, readBstr, allocateBstr, memory };
}

/** @typedef {ReturnType<typeof createVariantCodec>} VariantCodec */

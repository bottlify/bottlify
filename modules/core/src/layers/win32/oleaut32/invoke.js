/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ITypeInfo::Invoke: a call through a vtable, made from a description.
 *
 * This is how an automation object answers IDispatch::Invoke without writing
 * a dispatcher of its own: it hands its own interface pointer, the member and
 * the DISPPARAMS to the type information, which finds the method, lays the
 * arguments out the way the compiled method expects them on the stack, calls
 * it, and turns what came back into the result variant.
 *
 * The layout is the whole job. A DISPPARAMS lists its arguments last first;
 * a method takes them first first, each as its declared type rather than as
 * a variant -- a BSTR is one pointer, a VARIANT is four words, a double two,
 * an [out, retval] parameter a pointer to a slot the method fills and the
 * caller never sees. Get one of those wrong and the method reads its second
 * argument as its first, which is a fault somewhere in the program's own code
 * with nothing pointing back here.
 */

import {
    TKIND_ALIAS, TKIND_DISPATCH, TKIND_ENUM, TKIND_INTERFACE,
    VT_BOOL, VT_BSTR, VT_I2, VT_PTR, VT_R4, VT_R8, VT_UI2, VT_USERDEFINED,
    isImport, resolveReference,
} from './typelib.js';

/** Variant types this file lays out or reads back. */
const VT_EMPTY = 0;
const VT_NULL = 1;
const VT_I4 = 3;
const VT_CY = 6;
const VT_DATE = 7;
const VT_DISPATCH = 9;
const VT_ERROR = 10;
const VT_VARIANT = 12;
const VT_UNKNOWN = 13;
const VT_I1 = 16;
const VT_UI1 = 17;
const VT_UI4 = 19;
const VT_INT = 22;
const VT_UINT = 23;
const VT_HRESULT = 25;
const VT_BYREF = 0x4000;
const VT_TYPEMASK = 0xfff;

/** TYPEFLAG_FDISPATCHABLE: an interface reached through IDispatch. */
const TYPEFLAG_FDISPATCHABLE = 0x1000;

/** PARAMFLAG bits. */
const PARAMFLAG_FIN = 1;
const PARAMFLAG_FOUT = 2;
const PARAMFLAG_FRETVAL = 8;

/** DISPATCH_* flags, which INVOKEKIND values mirror bit for bit. */
const DISPATCH_PROPERTYPUT = 4;
const DISPATCH_PROPERTYPUTREF = 8;

/** The one named argument Invoke understands: the value of a property put. */
const DISPID_PROPERTYPUT = -3;

/** HRESULTs. */
const E_OUTOFMEMORY = 0x8007000e | 0;
const DISP_E_TYPEMISMATCH = 0x80020005 | 0;
const DISP_E_NONAMEDARGS = 0x80020007 | 0;
const DISP_E_EXCEPTION = 0x80020009 | 0;
const DISP_E_BADPARAMCOUNT = 0x8002000e | 0;

/** Structures, 32-bit. */
const VARIANT_BYTES = 16;
const VARIANT_VALUE = 8;
const EXCEPINFO_BYTES = 32;
const EXCEPINFO_SCODE = 28;
const WORD = 4;

/** Room for one slot a method fills: a VARIANT is the largest thing it can be. */
const SLOT_BYTES = VARIANT_BYTES;

/**
 * @typedef {import('./typelib.js').TypeLibrary} TypeLibrary
 * @typedef {import('./typelib.js').TypeInfoDescription} TypeInfoDescription
 * @typedef {import('./typelib.js').FunctionDescription} FunctionDescription
 * @typedef {import('./typelib.js').TypeDescription} TypeDescription
 */

/**
 * A variant's contents, read out of guest memory.
 *
 * @typedef {Object} VariantValue
 * @property {number} vt         The full VARTYPE, VT_BYREF included.
 * @property {number} reference  Where a VT_BYREF variant points; 0 otherwise.
 * @property {number} pointer    A string or an interface pointer, else 0.
 * @property {number | null} number
 * @property {string | null} text
 */

/**
 * @typedef {Object} InvokeHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => boolean }} heap
 * @property {(entry: number, args: number[]) => Promise<number>} call
 *           Calls a guest routine, stdcall, and resolves with EAX.
 * @property {(pvar: number) => void} clearVariant
 * @property {(bstr: number) => string} readBstr
 * @property {(text: string) => number} allocateBstr
 * @property {(bstr: number) => void} freeBstr
 * @property {(api: string, detail: string) => void} divergence
 */

/**
 * @param {Uint8Array} bytes
 * @returns {number[]} the bytes as little-endian words, padded to whole words
 */
function wordsOf(bytes){
    const words = [];
    for (let at = 0; at < bytes.length; at += WORD)
    {
        words.push((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
            | (bytes[at + 3] << 24)) >>> 0);
    }
    return words;
}

/**
 * Which VARTYPE a described type is passed and returned as. An alias is
 * what it stands for, an enum is a long, and an interface is a pointer that
 * is a dispatch pointer when the interface is reachable through IDispatch --
 * so a pointer to an interface is that same one word, not a pointer to it.
 *
 * @param {TypeLibrary} library @param {TypeDescription} type
 * @returns {number} a VARTYPE, or VT_USERDEFINED when nothing resolves it
 */
export function effectiveType(library, type){
    if (type.vt === VT_PTR && type.element)
    {
        const pointed = effectiveType(library, type.element);
        return pointed === VT_DISPATCH || pointed === VT_UNKNOWN ? pointed : VT_PTR;
    }
    if (type.vt !== VT_USERDEFINED)
    {
        return type.vt;
    }
    const reference = resolveReference(library, type.hreftype);
    if (!reference)
    {
        return VT_USERDEFINED;
    }
    if (isImport(reference))
    {
        return reference.kind === TKIND_INTERFACE ? VT_UNKNOWN : VT_USERDEFINED;
    }
    switch (reference.kind)
    {
        case TKIND_ENUM:
            return VT_I4;
        case TKIND_ALIAS:
            return reference.alias ? effectiveType(library, reference.alias) : VT_USERDEFINED;
        case TKIND_DISPATCH:
            return VT_DISPATCH;
        case TKIND_INTERFACE:
            return (reference.flags & TYPEFLAG_FDISPATCHABLE) !== 0 ? VT_DISPATCH : VT_UNKNOWN;
        default:
            return VT_USERDEFINED;
    }
}

/**
 * @param {number} vt
 * @returns {boolean} whether values of the type travel as a number in words
 */
const isNumeric = vt=>[VT_I2, VT_I4, VT_R4, VT_R8, VT_CY, VT_DATE, VT_BOOL, VT_ERROR,
    VT_I1, VT_UI1, VT_UI2, VT_UI4, VT_INT, VT_UINT, VT_HRESULT].includes(vt);

/**
 * A number as the words a method reads it from.
 *
 * @param {number} vt @param {number} number
 * @returns {number[]}
 */
function numberWords(vt, number){
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    switch (vt)
    {
        case VT_R4:
            view.setFloat32(0, number, true);
            return wordsOf(bytes.subarray(0, 4));
        case VT_R8:
        case VT_DATE:
            view.setFloat64(0, number, true);
            return wordsOf(bytes);
        case VT_CY:
            view.setBigInt64(0, BigInt(Math.round(number * 10000)), true);
            return wordsOf(bytes);
        case VT_BOOL:
            return [number !== 0 ? 0xffff : 0];
        default:
            return [Math.trunc(number) >>> 0];
    }
}

/**
 * A slot's contents as a variant of the given type.
 *
 * @param {Uint8Array} bytes @param {number} vt
 * @returns {{ vt: number, value: Uint8Array } | null} null for a type that
 *          cannot be a variant
 */
function variantOf(bytes, vt){
    const out = new Uint8Array(8);
    switch (vt)
    {
        case VT_BSTR:
        case VT_DISPATCH:
        case VT_UNKNOWN:
        case VT_I4:
        case VT_UI4:
        case VT_ERROR:
        case VT_R4:
            out.set(bytes.subarray(0, 4));
            return { vt, value: out };
        case VT_INT:
            out.set(bytes.subarray(0, 4));
            return { vt: VT_I4, value: out };
        case VT_UINT:
        case VT_HRESULT:
            out.set(bytes.subarray(0, 4));
            return { vt: VT_UI4, value: out };
        case VT_I2:
        case VT_UI2:
        case VT_BOOL:
            out.set(bytes.subarray(0, 2));
            return { vt, value: out };
        case VT_I1:
        case VT_UI1:
            out[0] = bytes[0];
            return { vt, value: out };
        case VT_R8:
        case VT_DATE:
        case VT_CY:
            out.set(bytes.subarray(0, 8));
            return { vt, value: out };
        case VT_VARIANT:
            return {
                vt: bytes[0] | (bytes[1] << 8),
                value: bytes.slice(VARIANT_VALUE, VARIANT_BYTES),
            };
        default:
            return null;
    }
}

/**
 * @param {InvokeHost} host
 */
export function createInvoker(host){
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
     * Reads a variant, and the value behind a reference.
     *
     * @param {number} pvar
     * @returns {VariantValue | null} null when a reference points nowhere
     */
    const loadVariant = pvar=>{
        const head = host.readMemory(pvar, 2);
        const declared = head[0] | (head[1] << 8);
        const vt = declared & VT_TYPEMASK;
        const byref = (declared & VT_BYREF) !== 0;
        const at = byref ? readU32(pvar + VARIANT_VALUE) : pvar + VARIANT_VALUE;
        if (byref && at === 0)
        {
            return null;
        }
        /** @type {VariantValue} */
        const value = {
            vt: declared, reference: byref ? at : 0, pointer: 0, number: null, text: null,
        };
        const data = host.readMemory(at, 8);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        switch (vt)
        {
            case VT_BSTR:
                value.pointer = view.getUint32(0, true);
                value.text = host.readBstr(value.pointer);
                break;
            case VT_DISPATCH:
            case VT_UNKNOWN:
                value.pointer = view.getUint32(0, true);
                break;
            case VT_EMPTY:
            case VT_NULL:
                value.number = 0;
                break;
            case VT_I1: value.number = view.getInt8(0); break;
            case VT_UI1: value.number = view.getUint8(0); break;
            case VT_I2:
            case VT_BOOL: value.number = view.getInt16(0, true); break;
            case VT_UI2: value.number = view.getUint16(0, true); break;
            case VT_I4:
            case VT_INT:
            case VT_ERROR:
            case VT_HRESULT: value.number = view.getInt32(0, true); break;
            case VT_UI4:
            case VT_UINT: value.number = view.getUint32(0, true); break;
            case VT_R4: value.number = view.getFloat32(0, true); break;
            case VT_R8:
            case VT_DATE: value.number = view.getFloat64(0, true); break;
            case VT_CY: value.number = Number(view.getBigInt64(0, true)) / 10000; break;
            default:
                break;
        }
        return value;
    };

    /**
     * Invokes `fn` on `instance` with the DISPPARAMS at `params`.
     *
     * @param {TypeLibrary} library
     * @param {TypeInfoDescription} type
     * @param {FunctionDescription} fn
     * @param {number} instance   The interface pointer the vtable hangs off.
     * @param {number} flags      DISPATCH_* flags.
     * @param {number} params     DISPPARAMS*.
     * @param {number} result     VARIANT*, or 0.
     * @param {number} excepInfo  EXCEPINFO*, or 0.
     * @param {number} argErr     UINT*, or 0.
     * @returns {number | Promise<number>} an HRESULT
     */
    const invoke = (library, type, fn, instance, flags, params, result, excepInfo, argErr)=>{
        const argsAt = readU32(params);
        const namedAt = readU32(params + 4);
        const count = readU32(params + 8);
        const named = readU32(params + 12);
        // The one named argument with a meaning here is a property's new
        // value, which sits first in the list -- where the last parameter is
        // found anyway.
        if (named > 1 || (named === 1
            && ((flags & (DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF)) === 0
                || (readU32(namedAt) | 0) !== DISPID_PROPERTYPUT)))
        {
            host.divergence('ITypeInfo::Invoke',
                `${type.name}.${fn.name}: named arguments are not matched by name`);
            return DISP_E_NONAMEDARGS;
        }
        const positional = fn.parameters.filter(
            parameter=>(parameter.flags & PARAMFLAG_FRETVAL) === 0);
        if (count !== positional.length)
        {
            return DISP_E_BADPARAMCOUNT;
        }

        /** Words pushed after the interface pointer, first parameter first. */
        /** @type {number[]} */
        const words = [];
        /** @type {number[]} */
        const temporaryStrings = [];
        /** @type {{ at: number, vt: number } | null} */
        let retval = null;
        // One block of slots: a slot per parameter passed by pointer to
        // something the method fills or reads.
        const slots = host.heap.allocate(SLOT_BYTES * Math.max(fn.parameters.length, 1));
        if (slots === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(slots, new Uint8Array(SLOT_BYTES * Math.max(fn.parameters.length, 1)));
        const giveUp = (/** @type {number} */ code, /** @type {number} */ index)=>{
            host.heap.free(slots);
            for (const bstr of temporaryStrings)
            {
                host.freeBstr(bstr);
            }
            if (argErr !== 0)
            {
                writeU32(argErr, index);
            }
            return code;
        };

        let next = 0;
        for (let index = 0; index < fn.parameters.length; index++)
        {
            const parameter = fn.parameters[index];
            const slot = slots + index * SLOT_BYTES;
            const declared = parameter.type;
            if ((parameter.flags & PARAMFLAG_FRETVAL) !== 0)
            {
                // Filled by the method, read after it returns.
                const element = declared.vt === VT_PTR && declared.element
                    ? effectiveType(library, declared.element)
                    : VT_USERDEFINED;
                retval = { at: slot, vt: element };
                words.push(slot);
                continue;
            }
            // Arguments are listed last first.
            const argument = argsAt + (count - 1 - next) * VARIANT_BYTES;
            const position = next;
            next++;
            const value = loadVariant(argument);
            if (value === null)
            {
                return giveUp(DISP_E_TYPEMISMATCH, position);
            }
            const byref = (value.vt & VT_BYREF) !== 0;
            const vt = value.vt & VT_TYPEMASK;
            const wanted = effectiveType(library, declared);

            if (wanted === VT_PTR && declared.element)
            {
                // A pointer parameter: to a variant, the argument itself; to
                // anything else, the argument's referent when it is one, else
                // a slot holding the value.
                const element = effectiveType(library, declared.element);
                if (element === VT_VARIANT)
                {
                    words.push(byref && vt === VT_VARIANT ? value.reference : argument);
                    continue;
                }
                if (byref)
                {
                    words.push(value.reference);
                    continue;
                }
                const direction = parameter.flags & (PARAMFLAG_FIN | PARAMFLAG_FOUT);
                if (direction === PARAMFLAG_FOUT)
                {
                    words.push(slot);
                    continue;
                }
                const laid = layOut(element, value, temporaryStrings);
                if (laid === null)
                {
                    return giveUp(DISP_E_TYPEMISMATCH, position);
                }
                const bytes = new Uint8Array(laid.length * WORD);
                const view = new DataView(bytes.buffer);
                laid.forEach((word, at)=>view.setUint32(at * WORD, word, true));
                host.writeMemory(slot, bytes);
                words.push(slot);
                continue;
            }

            if (wanted === VT_VARIANT)
            {
                words.push(...wordsOf(host.readMemory(argument, VARIANT_BYTES)));
                continue;
            }
            const laid = layOut(wanted, value, temporaryStrings);
            if (laid === null)
            {
                host.divergence('ITypeInfo::Invoke',
                    `${type.name}.${fn.name}: no conversion from VARTYPE ${value.vt} to ${wanted}`);
                return giveUp(DISP_E_TYPEMISMATCH, position);
            }
            words.push(...laid);
        }

        const vtable = readU32(instance);
        const entry = readU32(vtable + fn.vtableOffset);
        return host.call(entry, [instance, ...words]).then(returned=>{
            const hr = returned | 0;
            for (const bstr of temporaryStrings)
            {
                host.freeBstr(bstr);
            }
            if (hr < 0)
            {
                host.heap.free(slots);
                if (excepInfo === 0)
                {
                    return hr;
                }
                // A method that failed is reported as an exception carrying
                // its code, which is what a caller handing an EXCEPINFO asked
                // for.
                const info = new Uint8Array(EXCEPINFO_BYTES);
                new DataView(info.buffer).setInt32(EXCEPINFO_SCODE, hr, true);
                host.writeMemory(excepInfo, info);
                return DISP_E_EXCEPTION;
            }
            if (retval !== null)
            {
                const filled = variantOf(host.readMemory(retval.at, SLOT_BYTES), retval.vt);
                if (result !== 0 && filled !== null)
                {
                    host.clearVariant(result);
                    const variant = new Uint8Array(VARIANT_BYTES);
                    variant[0] = filled.vt & 0xff;
                    variant[1] = filled.vt >> 8;
                    variant.set(filled.value.subarray(0, 8), VARIANT_VALUE);
                    host.writeMemory(result, variant);
                }
                else if (filled === null)
                {
                    host.divergence('ITypeInfo::Invoke',
                        `${type.name}.${fn.name}: a result of VARTYPE ${retval.vt} is dropped`);
                }
                else
                {
                    host.divergence('ITypeInfo::Invoke',
                        `${type.name}.${fn.name}: a result nobody asked for is not released`);
                }
            }
            else if (result !== 0)
            {
                host.clearVariant(result);
            }
            host.heap.free(slots);
            return hr;
        });
    };

    /**
     * A variant's value as the words a parameter of type `vt` is passed in.
     *
     * @param {number} vt @param {VariantValue} value
     * @param {number[]} temporaryStrings  Where a BSTR made for the call is noted.
     * @returns {number[] | null} null when there is no conversion
     */
    const layOut = (vt, value, temporaryStrings)=>{
        const source = value.vt & VT_TYPEMASK;
        if (vt === VT_BSTR)
        {
            if (source === VT_BSTR)
            {
                return [value.pointer];
            }
            if (source === VT_EMPTY || source === VT_NULL)
            {
                return [0];
            }
            const text = value.text ?? (value.number === null ? null : String(value.number));
            if (text === null)
            {
                return null;
            }
            const bstr = host.allocateBstr(text);
            temporaryStrings.push(bstr);
            return [bstr];
        }
        if (vt === VT_DISPATCH || vt === VT_UNKNOWN)
        {
            if (source === VT_DISPATCH || source === VT_UNKNOWN)
            {
                return [value.pointer];
            }
            return source === VT_EMPTY || source === VT_NULL ? [0] : null;
        }
        if (isNumeric(vt))
        {
            const number = value.number ?? (value.text === null ? null : Number(value.text));
            if (number === null || Number.isNaN(number))
            {
                return null;
            }
            return numberWords(vt, number);
        }
        return null;
    };

    return {
        /**
         * The function that `memid` and `flags` name, or null.
         *
         * @param {FunctionDescription[]} functions
         * @param {number} memid @param {number} flags
         */
        find: (functions, memid, flags)=>functions.find(
            fn=>fn.memberId === memid && (fn.invokeKind & flags) !== 0) ?? null,
        invoke,
    };
}

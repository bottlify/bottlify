/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's values: everything is a Variant, and a Variant knows its
 * subtype. Literal 1 is an Integer, 32768 a Long, 1.5 a Double; 1 + 1 is an
 * Integer and 32767 + 1 a Long, because the operators are OLE Automation's
 * own -- VarAdd, VarSub, VarCmp and the rest -- with the type tables
 * `oleaut32/arithmetic.js` keeps. This file holds the values and runs the
 * operators over them.
 *
 * - Empty is undefined, Null null, a Boolean a boolean, a String a string.
 * - A Double is a plain number; every other number is a ForeignValue of its
 *   VARTYPE (`script/values.js`): Integer VT_I2, Long VT_I4, Byte VT_UI1,
 *   Single VT_R4, Currency VT_CY (the amount), Decimal VT_DECIMAL, and a Date
 *   is the runtime's automation date.
 * - Nothing is the runtime's NOTHING; an object is a {@link VBObject} (an
 *   instance of a script's class), a {@link FunctionRef} (GetRef's answer)
 *   or an external object.
 * - An array is a {@link VBArray}, which is a value: assigning one copies it.
 *
 * Integer, Long and Double sums, differences, products and comparisons are
 * worked out here without the operator tables, which is a second path beside
 * them: `fast-paths.itest.js` holds the two to the same answers.
 */

import {
    add as varAdd, and as varAnd, divide as varDiv, integerDivide as varIdiv, modulo as varMod,
    multiply as varMul, negate as varNeg, nearest, not as varNot, or as varOr,
    subtract as varSub, variantValue, xor as varXor,
} from '../oleaut32/arithmetic.js';
import { exactOf, toNumber as exactNumber } from '../oleaut32/varmath.js';
import {
    boolOf, dateFromText, numberOf, parseNumber, textOfCurrency, textOfDate,
} from '../oleaut32/vartext.js';
import {
    DISP_E_BADVARTYPE, DISP_E_DIVBYZERO, DISP_E_OVERFLOW, DISP_E_TYPEMISMATCH, VT_ARRAY,
    VT_BOOL, VT_BSTR, VT_CY, VT_DATE, VT_DECIMAL, VT_DISPATCH, VT_EMPTY, VT_ERROR, VT_I1, VT_I2,
    VT_I4, VT_I8, VT_INT, VT_NULL, VT_R4, VT_R8, VT_TYPEMASK, VT_UI1, VT_UI2, VT_UI4, VT_UI8,
    VT_UINT, VT_UNKNOWN, VT_VARIANT,
} from '../oleaut32/vartypes.js';
import { ExternalObject } from '../script/external.js';
import { ForeignValue, NOTHING, arrayValue, dateValue } from '../script/values.js';
import { VBRuntimeError } from './errors.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('../oleaut32/arithmetic.js').Value} Operand
 */

export { NOTHING };

/** The largest Single. */
const R4_MAX = 3.4028234663852886e38;
/** A Currency's range, in units. */
const CY_MAX = 922337203685477.6;
/** A Date's range: 1 January 100 to the last instant of 31 December 9999. */
const DATE_MIN = -657434;
const DATE_MAX = 2958465.99999;

/** Small Integers and Longs, made once: loop counters are mostly these. */
const CACHE_LOW = -256;
const CACHE_HIGH = 1024;
/** @type {ForeignValue[]} */
const INTEGERS = [];
/** @type {ForeignValue[]} */
const LONGS = [];
for (let n = CACHE_LOW; n < CACHE_HIGH; n++)
{
    INTEGERS.push(Object.freeze(new ForeignValue(VT_I2, n)));
    LONGS.push(Object.freeze(new ForeignValue(VT_I4, n)));
}

/** @param {number} n @returns {ForeignValue} an Integer */
export const integer = n=>(n >= CACHE_LOW && n < CACHE_HIGH ? INTEGERS[n - CACHE_LOW]
    : new ForeignValue(VT_I2, n));

/** @param {number} n @returns {ForeignValue} a Long */
export const long = n=>(n >= CACHE_LOW && n < CACHE_HIGH ? LONGS[n - CACHE_LOW]
    : new ForeignValue(VT_I4, n));

/** @param {number} n @returns {ForeignValue} a Byte */
export const byte = n=>new ForeignValue(VT_UI1, n);

/** @param {number} n @returns {ForeignValue} a Single */
export const single = n=>new ForeignValue(VT_R4, Math.fround(n));

/** @param {number} n @returns {ForeignValue} a Currency, the amount */
export const currency = n=>new ForeignValue(VT_CY, Math.round(n * 10000) / 10000);

/** @param {number} oleDate @returns {ForeignValue} a Date */
export const date = oleDate=>dateValue(oleDate);

/**
 * An Integer when the number is one, a Long when it is not and fits one,
 * a Double past both: the type a whole-number answer takes.
 *
 * @param {number} n @returns {Value}
 */
export const smallestInteger = n=>(n >= -32768 && n <= 32767 ? integer(n)
    : n >= -2147483648 && n <= 2147483647 ? long(n) : n);

/** A VBScript array: its bounds, first dimension first, and its elements, the first index fastest. */
export class VBArray
{
    /**
     * @param {{ lower: number, count: number }[]} bounds
     * @param {Value[]} items
     * @param {number} [elementType]  What the array holds, as a SAFEARRAY says.
     */
    constructor(bounds, items, elementType = VT_VARIANT){
        this.bounds = bounds;
        this.items = items;
        this.elementType = elementType;
        /** Declared with its size (Dim a(3)): ReDim refuses it. */
        this.fixed = false;
        /** Held by a For Each or a ByRef element: Erase and ReDim refuse it. */
        this.locked = 0;
    }

    /**
     * A new array of the given upper bounds, every element Empty.
     *
     * @param {number[]} uppers @returns {VBArray}
     */
    static sized(uppers){
        const bounds = uppers.map(upper=>({ lower: 0, count: upper + 1 }));
        const total = bounds.reduce((n, b)=>n * b.count, bounds.length === 0 ? 0 : 1);
        return new VBArray(bounds, new Array(total).fill(undefined));
    }

    /**
     * A one-dimensional array of the given elements.
     *
     * @param {Value[]} items @returns {VBArray}
     */
    static of(items){
        return new VBArray([{ lower: 0, count: items.length }], items);
    }

    /**
     * Where an element is, or a subscript out of range.
     *
     * @param {number[]} indices @returns {number}
     */
    offset(indices){
        if (indices.length !== this.bounds.length)
        {
            throw new VBRuntimeError(9);
        }
        let at = 0;
        let stride = 1;
        for (let d = 0; d < indices.length; d++)
        {
            const { lower, count } = this.bounds[d];
            const i = indices[d] - lower;
            if (!(i >= 0 && i < count))
            {
                throw new VBRuntimeError(9);
            }
            at += i * stride;
            stride *= count;
        }
        return at;
    }

    /** A copy, as an assignment makes one; arrays inside it are copied too. @returns {VBArray} */
    copy(){
        return new VBArray(this.bounds.map(b=>({ ...b })),
            this.items.map(item=>(item instanceof VBArray ? item.copy() : item)), this.elementType);
    }
}

/**
 * An instance of a script's class. Its fields are variables; `refs` counts
 * the variables, elements and fields that hold it, so that Class_Terminate
 * runs when the last lets go, and `pinned` says one the engine cannot see
 * holds it too -- a COM object or a host one -- which no count reaches.
 */
export class VBObject
{
    /** @param {any} cls  The class (the interpreter's ClassDef). */
    constructor(cls){
        this.cls = cls;
        /** @type {Map<string, { value: Value }>} */
        this.fields = new Map();
        this.refs = 0;
        this.terminated = false;
        this.pinned = false;
    }
}

/** GetRef's answer: a script procedure as an object, called through its default member. */
export class FunctionRef
{
    /** @param {any} proc */
    constructor(proc){
        this.proc = proc;
    }
}

/**
 * Whether a value is an object: Nothing included.
 *
 * @param {Value} value @returns {boolean}
 */
export const isObject = value=>value === NOTHING || value instanceof VBObject
    || value instanceof FunctionRef || value instanceof ExternalObject;

/** @param {Value} value @returns {boolean} whether a value is a number held as a Long or an Integer */
const isWhole = value=>value instanceof ForeignValue && (value.vt === VT_I2 || value.vt === VT_I4);

/**
 * A value's VARTYPE, as VarType answers it but for an object, whose default
 * value a caller reads first.
 *
 * @param {Value} value @returns {number}
 */
export function vtOf(value){
    switch (typeof value)
    {
        case 'undefined': return VT_EMPTY;
        case 'boolean': return VT_BOOL;
        case 'number': return VT_R8;
        case 'string': return VT_BSTR;
        default:
            if (value === null)
            {
                return VT_NULL;
            }
            if (value instanceof ForeignValue)
            {
                return value.vt;
            }
            if (value instanceof VBArray)
            {
                return VT_ARRAY | VT_VARIANT;
            }
            return VT_DISPATCH;
    }
}

const TYPE_NAMES = new Map([
    [VT_EMPTY, 'Empty'], [VT_NULL, 'Null'], [VT_I2, 'Integer'], [VT_I4, 'Long'],
    [VT_R4, 'Single'], [VT_R8, 'Double'], [VT_CY, 'Currency'], [VT_DATE, 'Date'],
    [VT_BSTR, 'String'], [VT_DISPATCH, 'Object'], [VT_ERROR, 'Error'], [VT_BOOL, 'Boolean'],
    [VT_VARIANT, 'Variant'], [VT_DECIMAL, 'Decimal'], [VT_UI1, 'Byte'],
]);

/**
 * TypeName: a subtype's name, an array as its elements' name with "()", a
 * class's instance by the class, an external object by what it calls
 * itself.
 *
 * @param {Value} value @returns {string}
 */
export function typeName(value){
    if (value === NOTHING)
    {
        return 'Nothing';
    }
    if (value instanceof VBObject)
    {
        return value.cls.name;
    }
    if (value instanceof ExternalObject)
    {
        return value.typeName;
    }
    if (value instanceof FunctionRef)
    {
        return 'Object';
    }
    if (value instanceof VBArray)
    {
        return `${TYPE_NAMES.get(value.elementType) ?? 'Unknown'}()`;
    }
    const vt = vtOf(value);
    if ((vt & VT_ARRAY) !== 0)
    {
        return `${TYPE_NAMES.get(vt & VT_TYPEMASK) ?? 'Unknown'}()`;
    }
    return TYPE_NAMES.get(vt) ?? 'Unknown';
}

/** What an operator's refusal is to a script. */
const HRESULT_ERRORS = new Map([
    [DISP_E_TYPEMISMATCH | 0, 13], [DISP_E_OVERFLOW | 0, 6], [DISP_E_DIVBYZERO | 0, 11],
    [DISP_E_BADVARTYPE | 0, 458],
]);

/** @param {number} hr @returns {VBRuntimeError} */
const operatorError = hr=>new VBRuntimeError(HRESULT_ERRORS.get(hr | 0) ?? 5);

/**
 * A value as the automation operators read one.
 *
 * @param {Value} value @returns {Operand}
 */
export function operandOf(value){
    switch (typeof value)
    {
        case 'undefined': return variantValue(VT_EMPTY);
        case 'boolean': return variantValue(VT_BOOL, { integer: value ? -1n : 0n });
        case 'number': return variantValue(VT_R8, { real: value });
        case 'string': return variantValue(VT_BSTR, { text: value });
        default:
            break;
    }
    if (value === null)
    {
        return variantValue(VT_NULL);
    }
    if (value instanceof VBArray)
    {
        return variantValue(VT_VARIANT, { flags: VT_ARRAY });
    }
    if (!(value instanceof ForeignValue))
    {
        return variantValue(VT_DISPATCH);
    }
    const vt = value.vt;
    if ((vt & VT_ARRAY) !== 0)
    {
        return variantValue(vt & VT_TYPEMASK, { flags: VT_ARRAY });
    }
    switch (vt)
    {
        case VT_R4: case VT_R8: case VT_DATE:
            return variantValue(vt, { real: value.value });
        case VT_CY:
            return variantValue(VT_CY, { exact: { value: BigInt(Math.round(value.value * 10000)),
                scale: 4 } });
        case VT_DECIMAL:
            return variantValue(VT_DECIMAL, { exact: exactOf(value.value)
                ?? { value: 0n, scale: 0 } });
        case VT_ERROR:
            return variantValue(VT_ERROR, { integer: BigInt(value.value | 0) });
        default:
            return Number.isFinite(value.value)
                ? variantValue(vt, { integer: BigInt(Math.trunc(value.value)) })
                : variantValue(vt);
    }
}

/**
 * An operator's answer as a value.
 *
 * @param {Operand | number} outcome  An HRESULT for a refusal.
 * @returns {Value}
 */
export function valueOf(outcome){
    if (typeof outcome === 'number')
    {
        throw operatorError(outcome);
    }
    switch (outcome.type)
    {
        case VT_EMPTY: return undefined;
        case VT_NULL: return null;
        case VT_BOOL: return outcome.integer !== 0n;
        case VT_I2: return integer(Number(outcome.integer));
        case VT_I4: return long(Number(outcome.integer));
        case VT_UI1: return byte(Number(outcome.integer));
        case VT_R4: return single(/** @type {number} */ (outcome.real));
        case VT_R8: return outcome.real;
        case VT_DATE: return date(/** @type {number} */ (outcome.real));
        case VT_CY:
            return currency(exactNumber(/** @type {any} */ (outcome.exact)));
        case VT_DECIMAL:
            return new ForeignValue(VT_DECIMAL, exactNumber(/** @type {any} */ (outcome.exact)));
        case VT_BSTR: return outcome.text;
        default:
            return new ForeignValue(outcome.type, Number(outcome.integer ?? outcome.real ?? 0));
    }
}

/**
 * @param {(a: Operand, b: Operand) => Operand | number} operator
 * @returns {(a: Value, b: Value) => Value}
 */
const binary = operator=>(a, b)=>valueOf(operator(operandOf(a), operandOf(b)));

/** The two-operand operators by the automation tables alone. */
const exactAdd = binary(varAdd);
const exactSub = binary(varSub);
const exactMul = binary(varMul);

/**
 * A whole-number answer of two Integers or Longs, in the narrower of them
 * that holds it and a Double past both, as VarAdd and VarMul widen.
 *
 * @param {ForeignValue} a @param {ForeignValue} b @param {number} n
 * @returns {Value}
 */
const wholeResult = (a, b, n)=>{
    if (a.vt === VT_I2 && b.vt === VT_I2 && n >= -32768 && n <= 32767)
    {
        return integer(n);
    }
    return n >= -2147483648 && n <= 2147483647 ? long(n) : n;
};

/**
 * The operators, by name: `exact` runs every operation through the
 * automation tables, `fast` answers the common Integer, Long and Double
 * cases first and leaves the rest to them.
 *
 * @typedef {Object} Operators
 * @property {(a: Value, b: Value) => Value} add
 * @property {(a: Value, b: Value) => Value} sub
 * @property {(a: Value, b: Value) => Value} mul
 * @property {(a: Value, b: Value) => number | null} compare  -1, 0 or 1; null beside Null.
 */

/** @type {Operators} */
export const EXACT = Object.freeze({
    add: exactAdd, sub: exactSub, mul: exactMul, compare: (a, b)=>compare(a, b, false),
});

/** @type {Operators} */
export const FAST = Object.freeze({
    add: (a, b)=>{
        if (typeof a === 'number' && typeof b === 'number')
        {
            const n = a + b;
            if (Number.isFinite(n))
            {
                return n;
            }
        }
        else if (isWhole(a) && isWhole(b))
        {
            return wholeResult(a, b, a.value + b.value);
        }
        return exactAdd(a, b);
    },
    sub: (a, b)=>{
        if (typeof a === 'number' && typeof b === 'number')
        {
            const n = a - b;
            if (Number.isFinite(n))
            {
                return n;
            }
        }
        else if (isWhole(a) && isWhole(b))
        {
            return wholeResult(a, b, a.value - b.value);
        }
        return exactSub(a, b);
    },
    mul: (a, b)=>{
        if (typeof a === 'number' && typeof b === 'number')
        {
            const n = a * b;
            if (Number.isFinite(n))
            {
                return n;
            }
        }
        else if (isWhole(a) && isWhole(b))
        {
            const n = a.value * b.value;
            // Past 2^53 a double product is not the exact one.
            if (Math.abs(n) <= Number.MAX_SAFE_INTEGER)
            {
                return wholeResult(a, b, n);
            }
        }
        return exactMul(a, b);
    },
    compare: (a, b)=>{
        if (typeof a === 'number' && typeof b === 'number')
        {
            return a < b ? -1 : a > b ? 1 : 0;
        }
        if (isWhole(a) && isWhole(b))
        {
            return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
        }
        return compare(a, b, false);
    },
});

export const div = binary(varDiv);
export const intDiv = binary(varIdiv);
export const mod = binary(varMod);
export const and = binary(varAnd);
export const or = binary(varOr);
export const xor = binary(varXor);

/** @param {Value} a @returns {Value} */
export const negate = a=>valueOf(varNeg(operandOf(a)));

/** @param {Value} a @returns {Value} */
export const not = a=>valueOf(varNot(operandOf(a)));

/**
 * Eqv: the complement of Xor, in Xor's type; Null beside anything is Null.
 *
 * @param {Value} a @param {Value} b @returns {Value}
 */
export const eqv = (a, b)=>not(xor(a, b));

/**
 * Imp: (Not a) Or b, Null going as Not and Or take it -- True Imp Null is
 * Null, False Imp Null True, Null Imp True True.
 *
 * @param {Value} a @param {Value} b @returns {Value}
 */
export const imp = (a, b)=>or(a === null ? null : not(a), b);

/**
 * ^: always a Double, Null beside anything Null.
 *
 * @param {Value} a @param {Value} b @returns {Value}
 */
export function power(a, b){
    if (a === null || b === null)
    {
        return null;
    }
    const base = toDouble(a);
    const exponent = toDouble(b);
    if (base === 0 && exponent < 0)
    {
        throw new VBRuntimeError(5);
    }
    const n = base ** exponent;
    if (Number.isNaN(n))
    {
        throw new VBRuntimeError(5);
    }
    if (!Number.isFinite(n))
    {
        throw new VBRuntimeError(6);
    }
    return n;
}

/**
 * &: both sides as text, Null and Empty as nothing; Null only when both are.
 *
 * @param {Value} a @param {Value} b @returns {Value}
 */
export function concat(a, b){
    if (a === null && b === null)
    {
        return null;
    }
    return `${a === null ? '' : toStr(a)}${b === null ? '' : toStr(b)}`;
}

/**
 * A numeric operand of a comparison: Empty as zero, a Boolean as -1 or 0.
 *
 * @param {Value} value @returns {number}
 */
const comparable = value=>{
    switch (typeof value)
    {
        case 'undefined': return 0;
        case 'boolean': return value ? -1 : 0;
        case 'number': return value;
        default:
            if (value instanceof ForeignValue && (value.vt & VT_ARRAY) === 0
                && value.vt !== VT_ERROR && Number.isFinite(value.value))
            {
                return value.value;
            }
            throw new VBRuntimeError(13);
    }
};

/**
 * VarCmp: -1, 0 or 1, or null when either side is Null. A number is below
 * any text, whatever the text says; Empty is zero beside a number and ""
 * beside text. `text` compares without case, as vbTextCompare does.
 *
 * @param {Value} a @param {Value} b @param {boolean} text
 * @returns {number | null}
 */
export function compare(a, b, text){
    const aText = typeof a === 'string';
    const bText = typeof b === 'string';
    if (aText || bText)
    {
        const other = aText ? b : a;
        if (!(aText && bText) && other !== undefined && other !== null)
        {
            comparable(other);
            return aText ? 1 : -1;
        }
    }
    if (a === null || b === null)
    {
        return null;
    }
    if (aText || bText)
    {
        let x = aText ? a : '';
        let y = bText ? b : '';
        if (text)
        {
            x = x.toLowerCase();
            y = y.toLowerCase();
        }
        return x < y ? -1 : x > y ? 1 : 0;
    }
    const x = comparable(a);
    const y = comparable(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A double spelled as VarBstrFromR8 spells it: `precision` significant
 * digits, fixed unless the exponent is below -4 or not below the precision,
 * and then 1.5E+20, the exponent two digits at least.
 *
 * @param {number} n @param {number} precision  15 for a Double, 7 for a Single.
 * @returns {string}
 */
export function formatReal(n, precision){
    if (n === 0)
    {
        return '0';
    }
    const [mantissa, written] = Math.abs(n).toExponential(precision - 1).split('e');
    const exponent = Number(written);
    const digits = mantissa.replace('.', '');
    const sign = n < 0 ? '-' : '';
    if (exponent < -4 || exponent >= precision)
    {
        const trimmed = digits.replace(/0+$/, '');
        const head = trimmed[0];
        const tail = trimmed.slice(1);
        return `${sign}${head}${tail === '' ? '' : `.${tail}`}E${exponent < 0 ? '-' : '+'}`
            + `${String(Math.abs(exponent)).padStart(2, '0')}`;
    }
    let whole;
    let fraction;
    if (exponent >= 0)
    {
        whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
        fraction = digits.slice(exponent + 1);
    }
    else
    {
        whole = '0';
        fraction = `${'0'.repeat(-exponent - 1)}${digits}`;
    }
    fraction = fraction.replace(/0+$/, '');
    return `${sign}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * CStr: a value as text. Null cannot be one.
 *
 * @param {Value} value @returns {string}
 */
export function toStr(value){
    switch (typeof value)
    {
        case 'string': return value;
        case 'undefined': return '';
        case 'boolean': return value ? 'True' : 'False';
        case 'number': return formatReal(value, 15);
        default:
            break;
    }
    if (value === null)
    {
        throw new VBRuntimeError(94);
    }
    if (value instanceof ForeignValue && (value.vt & VT_ARRAY) === 0)
    {
        switch (value.vt)
        {
            case VT_R4: return formatReal(value.value, 7);
            case VT_R8: return formatReal(value.value, 15);
            case VT_CY: return textOfCurrency(BigInt(Math.round(value.value * 10000)));
            case VT_DATE: {
                const text = textOfDate(value.value, 0);
                if (text === null)
                {
                    throw new VBRuntimeError(5);
                }
                return text;
            }
            case VT_ERROR: return `Error ${value.value}`;
            case VT_DECIMAL: return formatReal(value.value, 28);
            default:
                if (Number.isFinite(value.value))
                {
                    return String(value.value);
                }
                break;
        }
    }
    throw new VBRuntimeError(13);
}

/**
 * A number a string holds as VarR8FromStr reads one, or a type mismatch.
 *
 * @param {string} text @returns {number}
 */
export function parseDouble(text){
    const parsed = parseNumber(text);
    if (parsed === null)
    {
        throw new VBRuntimeError(13);
    }
    const n = numberOf(parsed);
    if (!Number.isFinite(n))
    {
        throw new VBRuntimeError(6);
    }
    return n;
}

/**
 * CDbl: a value as a double. Null cannot be one.
 *
 * @param {Value} value @returns {number}
 */
export function toDouble(value){
    switch (typeof value)
    {
        case 'number': return value;
        case 'undefined': return 0;
        case 'boolean': return value ? -1 : 0;
        case 'string': return parseDouble(value);
        default:
            break;
    }
    if (value === null)
    {
        throw new VBRuntimeError(94);
    }
    if (value instanceof ForeignValue && (value.vt & VT_ARRAY) === 0 && value.vt !== VT_ERROR
        && Number.isFinite(value.value))
    {
        return value.value;
    }
    throw new VBRuntimeError(13);
}

/**
 * A value rounded, a half to the even neighbour, to a whole number within
 * the bounds of an integral type, or an overflow.
 *
 * @param {Value} value @param {number} low @param {number} high @returns {number}
 */
export function toWhole(value, low, high){
    const n = nearest(toDouble(value));
    if (!(n >= low && n <= high))
    {
        throw new VBRuntimeError(6);
    }
    return n === 0 ? 0 : n;
}

/** @param {Value} value @returns {number} CLng's number */
export const toLong = value=>toWhole(value, -2147483648, 2147483647);

/** @param {Value} value @returns {number} CInt's number */
export const toInteger = value=>toWhole(value, -32768, 32767);

/**
 * CBool: Empty is False, text is True or False or a number, a number is
 * whether it is not zero. Null cannot be one.
 *
 * @param {Value} value @returns {boolean}
 */
export function toBool(value){
    switch (typeof value)
    {
        case 'boolean': return value;
        case 'undefined': return false;
        case 'number': return value !== 0;
        case 'string': {
            const truth = boolOf(value);
            if (truth === null)
            {
                throw new VBRuntimeError(13);
            }
            return truth !== 0;
        }
        default:
            break;
    }
    if (value === null)
    {
        throw new VBRuntimeError(94);
    }
    return toDouble(value) !== 0;
}

/**
 * CDate's day number: a Date as it is, text read as a date (or, failing
 * that, as a number), a number as the day it counts to. Null cannot be one.
 *
 * @param {Value} value @param {() => number | null} thisYear  For a date
 *     written without its year.
 * @returns {number}
 */
export function toDate(value, thisYear){
    if (value instanceof ForeignValue && value.vt === VT_DATE)
    {
        return value.value;
    }
    if (typeof value === 'string')
    {
        const parsed = dateFromText(value, 0, thisYear);
        if (parsed !== null)
        {
            return parsed;
        }
        const number = parseNumber(value);
        if (number === null)
        {
            throw new VBRuntimeError(13);
        }
        return checkedDate(numberOf(number));
    }
    return checkedDate(toDouble(value));
}

/**
 * A day number a Date can hold, or an overflow.
 *
 * @param {number} n @returns {number}
 */
export function checkedDate(n){
    if (!(n >= DATE_MIN - 1 && n <= DATE_MAX + 1))
    {
        throw new VBRuntimeError(6);
    }
    return n;
}

/**
 * A value converted to a subtype, as the C* functions convert: the number
 * rounded or checked against the type's range.
 *
 * @param {Value} value @param {number} vt  VT_I2, VT_I4, VT_UI1, VT_R4, VT_R8, VT_CY.
 * @returns {Value}
 */
export function convertNumber(value, vt){
    switch (vt)
    {
        case VT_I2: return integer(toInteger(value));
        case VT_I4: return long(toLong(value));
        case VT_UI1: return byte(toWhole(value, 0, 255));
        case VT_R4: {
            const n = toDouble(value);
            if (Math.abs(n) > R4_MAX)
            {
                throw new VBRuntimeError(6);
            }
            return single(n);
        }
        case VT_CY: {
            const n = toDouble(value);
            if (Math.abs(n) > CY_MAX)
            {
                throw new VBRuntimeError(6);
            }
            return currency(n);
        }
        default:
            return toDouble(value);
    }
}

/**
 * Whether a value is numeric, as IsNumeric answers: a number of any
 * subtype, a Boolean, Empty, or text that reads as a number -- not a Date.
 *
 * @param {Value} value @returns {boolean}
 */
export function isNumeric(value){
    switch (typeof value)
    {
        case 'undefined': case 'boolean': case 'number':
            return true;
        case 'string':
            return parseNumber(value) !== null;
        default:
            return value instanceof ForeignValue && (value.vt & VT_ARRAY) === 0
                && [VT_I2, VT_I4, VT_R4, VT_R8, VT_CY, VT_DECIMAL, VT_UI1, VT_I1, VT_UI2, VT_UI4,
                    VT_I8, VT_UI8, VT_INT, VT_UINT].includes(value.vt);
    }
}

/**
 * A value from outside the language -- a host object's answer, a guest
 * call's -- as a VBScript value: a whole number that fits one as a Long and
 * any other as a Double (a host's number has no subtype, and VT_I4 is what
 * it would be written as), a SAFEARRAY as an array, null as Null.
 *
 * @param {Value} value @returns {Value}
 */
export function fromHost(value){
    switch (typeof value)
    {
        case 'number':
            return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
                && !Object.is(value, -0) ? long(value) : value;
        case 'bigint':
            return Number(value);
        case 'undefined': case 'boolean': case 'string':
            return value;
        default:
            break;
    }
    if (value instanceof ForeignValue)
    {
        if (value.vt === VT_R8)
        {
            return value.value;
        }
        if (value.isArray)
        {
            const contents = value.value;
            return new VBArray(contents.bounds.map((/** @type {any} */ b)=>({ ...b })),
                contents.items.map(fromHost), contents.elementType);
        }
        return value;
    }
    if (Array.isArray(value))
    {
        return VBArray.of(value.map(fromHost));
    }
    return value;
}

/**
 * A value for outside the language, as an external object is handed one:
 * an array as the SAFEARRAY a VARIANT carries, everything else as it is --
 * a number keeps its subtype, which a host object reads past and a COM call
 * writes as its VARTYPE.
 *
 * @param {Value} value @returns {Value}
 */
export function toExternal(value){
    if (value instanceof VBArray)
    {
        return arrayValue({ elementType: value.elementType, bounds: value.bounds.map(b=>({ ...b })),
            items: value.items.map(value.elementType === VT_VARIANT ? toExternal : toHost) });
    }
    return value;
}

/**
 * A value as an embedder is handed one: a number of any subtype as a plain
 * number, an array as a SAFEARRAY's contents, Nothing as null.
 *
 * @param {Value} value @returns {Value}
 */
export function toHost(value){
    if (value instanceof ForeignValue && (value.vt & VT_ARRAY) === 0
        && value.vt !== VT_DATE && value.vt !== VT_ERROR)
    {
        return value.value;
    }
    if (value instanceof VBArray)
    {
        return arrayValue({ elementType: VT_VARIANT, bounds: value.bounds.map(b=>({ ...b })),
            items: value.items.map(toHost) });
    }
    return value === NOTHING ? null : value;
}

/**
 * What a VARIANT read out of guest memory is in VBScript: every number keeps
 * its subtype -- a Double too, held as a ForeignValue until {@link fromHost}
 * makes it a plain number -- and a null interface pointer is Nothing.
 *
 * @param {number} vt @param {Value} value @returns {Value}
 */
export function adoptVariant(vt, value){
    switch (vt)
    {
        case VT_I2: case VT_I4: case VT_UI1: case VT_R4: case VT_R8: case VT_CY:
        case VT_DECIMAL: case VT_I1: case VT_UI2: case VT_UI4: case VT_INT: case VT_UINT:
            return new ForeignValue(vt, value);
        case VT_DISPATCH: case VT_UNKNOWN:
            return value === null ? NOTHING : value;
        default:
            return value;
    }
}

/**
 * What a VBScript value is written into a VARIANT as: a Double as VT_R8 even
 * when it is whole, an array as a SAFEARRAY of VARIANTs.
 *
 * @param {Value} value @returns {Value}
 */
export function prepareVariant(value){
    if (typeof value === 'number')
    {
        return new ForeignValue(VT_R8, value);
    }
    if (value instanceof VBArray)
    {
        return arrayValue({ elementType: VT_VARIANT, bounds: value.bounds.map(b=>({ ...b })),
            items: value.items });
    }
    return value;
}

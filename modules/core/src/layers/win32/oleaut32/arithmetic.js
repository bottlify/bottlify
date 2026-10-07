/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The automation operators -- VarAdd, VarSub, VarMul, VarDiv, VarIdiv, VarMod,
 * VarAnd, VarOr, VarXor, VarNeg and VarNot -- over values already read out of
 * their variants.
 *
 * What a program can observe of them is mostly the type of the answer, and
 * each operator picks it by a table of its own rather than by one rule of
 * promotion: VarAdd keeps a DATE where VarMul makes it a double, VarDiv makes
 * two integers a double, VarIdiv makes two doubles an integer. The tables here
 * are the ones Windows answers by, as Wine's conformance tests (vartest.c)
 * record them, type pair by type pair.
 *
 * Every conversion to an integral type rounds a half to the even neighbour,
 * and an integer answer that does not fit its type moves up one -- UI1 to I2
 * to I4 to a double -- rather than wrapping.
 */

import { exactOf, fitDecimal, round, toNumber } from './varmath.js';
import { boolOf, exactOfNumber, numberOf, parseNumber } from './vartext.js';
import {
    DISP_E_BADVARTYPE, DISP_E_DIVBYZERO, DISP_E_OVERFLOW, DISP_E_TYPEMISMATCH, VT_ARRAY, VT_BOOL,
    VT_BSTR, VT_CY, VT_DATE, VT_DECIMAL, VT_DISPATCH, VT_EMPTY, VT_ERROR, VT_I1, VT_I2, VT_I4,
    VT_I8, VT_INT, VT_NULL, VT_R4, VT_R8, VT_RECORD, VT_RESERVED, VT_UI1, VT_UI2, VT_UI4,
    VT_UI8, VT_UINT, VT_UNKNOWN, VT_VARIANT, VT_VECTOR,
} from './vartypes.js';

/** @typedef {import('./varmath.js').Exact} Exact */

/**
 * A variant's value as the operators read it. `integer` for every integral
 * type -- VT_BOOL's -1 or 0 among them -- `real` for R4, R8 and DATE, `exact`
 * for CY (four places) and DECIMAL, `text` for a BSTR. `flags` are the bits of
 * the VARTYPE beside the type that reading could not settle -- an array, a
 * vector, the reserved bit, or a reference to nothing -- and a value that has
 * any, or a type no variant holds, carries nothing else: each operator refuses
 * it in its own order. `reference` says the variant held a reference to its
 * value, which reading followed.
 *
 * @typedef {Object} Value
 * @property {number} type
 * @property {number} flags
 * @property {boolean} reference
 * @property {bigint | null} integer
 * @property {number | null} real
 * @property {Exact | null} exact
 * @property {string | null} text
 */

/**
 * An operator's answer: the value, or the HRESULT it failed with.
 *
 * @typedef {Value | number} Outcome
 */

/**
 * @param {number} type @param {Partial<Value>} [fields]
 * @returns {Value}
 */
export const variantValue = (type, fields = {})=>
    ({ type, flags: 0, reference: false, integer: null, real: null, exact: null, text: null,
        ...fields });

/**
 * Whether a variant can hold this type at all: what VariantClear accepts, but
 * for VT_CLSID, which none of the operators takes either.
 *
 * @param {number} type
 */
export const isOperandType = type=>(type <= VT_UINT && type !== 15) || type === VT_RECORD;

/** What an operator throws to answer with a failure from deep in a conversion. */
class Refusal extends Error {
    /** @param {number} hr */
    constructor(hr){
        super(`HRESULT 0x${(hr >>> 0).toString(16)}`);
        this.hr = hr;
    }
}

/** @param {number} hr @returns {never} */
const refuse = hr=>{
    throw new Refusal(hr);
};

/**
 * Runs an operator, a refusal from inside it becoming its answer.
 *
 * @param {() => Value} body
 * @returns {Outcome}
 */
const attempt = body=>{
    try
    {
        return body();
    }
    catch (e){
        if (e instanceof Refusal)
        {
            return e.hr;
        }
        throw e;
    }
};

/** The range of each integral type, both ends included. */
const RANGES = new Map([
    [VT_I1, [-128n, 127n]], [VT_UI1, [0n, 255n]], [VT_I2, [-32768n, 32767n]],
    [VT_BOOL, [-32768n, 32767n]], [VT_UI2, [0n, 65535n]],
    [VT_I4, [-(1n << 31n), (1n << 31n) - 1n]], [VT_INT, [-(1n << 31n), (1n << 31n) - 1n]],
    [VT_UI4, [0n, (1n << 32n) - 1n]], [VT_UINT, [0n, (1n << 32n) - 1n]],
    [VT_I8, [-(1n << 63n), (1n << 63n) - 1n]], [VT_UI8, [0n, (1n << 64n) - 1n]],
]);

/** @param {number} type @param {bigint} value */
const fits = (type, value)=>{
    const range = /** @type {bigint[]} */ (RANGES.get(type));
    return value >= range[0] && value <= range[1];
};

/**
 * A double rounded to a whole number, a half to the even neighbour: what
 * every automation conversion to an integral type does, so 2.5 is 2 and
 * -1.5 is -2.
 *
 * @param {number} number
 */
export const nearest = number=>{
    const floor = Math.floor(number);
    const rest = number - floor;
    return rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
};

/** The largest float. */
const R4_MAX = 3.4028234663852886e38;

/** @param {string} text */
const parsed = text=>parseNumber(text) ?? refuse(DISP_E_TYPEMISMATCH);

/**
 * A value as a double, as VarR8From* reads it.
 *
 * @param {Value} value
 * @returns {number}
 */
const realOf = value=>{
    switch (value.type)
    {
        case VT_EMPTY:
            return 0;
        case VT_R4:
        case VT_R8:
        case VT_DATE:
            return /** @type {number} */ (value.real);
        case VT_CY:
        case VT_DECIMAL:
            return toNumber(/** @type {Exact} */ (value.exact));
        case VT_BSTR:
            return numberOf(parsed(String(value.text)));
        default:
            return value.integer === null ? refuse(DISP_E_TYPEMISMATCH) : Number(value.integer);
    }
};

/**
 * A value exactly, as the conversions to CY and DECIMAL read it: a double by
 * the fifteen digits it spells, a float by its seven.
 *
 * @param {Value} value
 * @returns {Exact}
 */
const exactIn = value=>{
    switch (value.type)
    {
        case VT_EMPTY:
            return { value: 0n, scale: 0 };
        case VT_CY:
        case VT_DECIMAL:
            return /** @type {Exact} */ (value.exact);
        case VT_R4:
        case VT_R8:
        case VT_DATE: {
            const real = /** @type {number} */ (value.real);
            return exactOf(value.type === VT_R4 ? Number(real.toPrecision(7)) : real)
                ?? refuse(DISP_E_OVERFLOW);
        }
        case VT_BSTR:
            return exactOfNumber(parsed(String(value.text))) ?? refuse(DISP_E_OVERFLOW);
        default:
            return value.integer === null ? refuse(DISP_E_TYPEMISMATCH)
                : { value: value.integer, scale: 0 };
    }
};

/**
 * A value as a whole number of the given integral type: rounded, and an
 * overflow when it does not fit.
 *
 * @param {Value} value @param {number} type
 * @returns {bigint}
 */
const integerIn = (value, type)=>{
    let whole;
    if (value.integer !== null)
    {
        whole = value.integer;
    }
    else if (value.type === VT_R4 || value.type === VT_R8 || value.type === VT_DATE)
    {
        const real = /** @type {number} */ (value.real);
        whole = Number.isFinite(real) ? BigInt(nearest(real)) : refuse(DISP_E_OVERFLOW);
    }
    else
    {
        whole = round(exactIn(value), 0).value;
    }
    return fits(type, whole) ? whole : refuse(DISP_E_OVERFLOW);
};

/** The bounds of a CY, in ten-thousandths. */
const CY_RANGE = RANGES.get(VT_I8) ?? [];

/**
 * A value as a CY's ten-thousandths, rounded to the fourth place.
 *
 * @param {Value} value
 */
const currencyOf = value=>currencyUnits(exactIn(value));

/**
 * An exact number as a CY's ten-thousandths, or an overflow.
 *
 * @param {Exact} exact
 */
const currencyUnits = exact=>{
    const rounded = round(exact, 4);
    const units = rounded.value * 10n ** BigInt(4 - rounded.scale);
    return units >= CY_RANGE[0] && units <= CY_RANGE[1] ? units : refuse(DISP_E_OVERFLOW);
};

/** @param {Exact} exact @returns {Value} */
const currencyResult = exact=>variantValue(VT_CY,
    { exact: { value: currencyUnits(exact), scale: 4 } });

/** @param {Exact} exact @returns {Value} */
const decimalResult = exact=>variantValue(VT_DECIMAL, { exact: fitDecimal(exact)
    ?? refuse(DISP_E_OVERFLOW) });

/** The days a DATE can name, 1 January 100 to 31 December 9999, whole. */
const FIRST_DAY = -657434;
const LAST_DAY = 2958465;

/**
 * A double answer of the type asked for. A float that overflows becomes a
 * double; a double that does, an error, as is a date past the calendar's ends.
 *
 * @param {number} type @param {number} number
 * @returns {Value}
 */
const realResult = (type, number)=>{
    if (!Number.isFinite(number)
        || (type === VT_DATE && (number <= FIRST_DAY - 1 || number >= LAST_DAY + 1)))
    {
        return refuse(DISP_E_OVERFLOW);
    }
    if (type === VT_R4)
    {
        return Math.abs(number) <= R4_MAX ? variantValue(VT_R4, { real: Math.fround(number) })
            : variantValue(VT_R8, { real: number });
    }
    return variantValue(type, { real: number });
};

/** The types an integer answer moves through when it does not fit the one before. */
const WIDER = [VT_UI1, VT_I2, VT_I4];

/**
 * An integer answer in the narrowest of `type` and the wider types after it
 * that holds it, and a double past them all.
 *
 * @param {number} type @param {bigint} whole
 * @returns {Value}
 */
const integerResult = (type, whole)=>{
    const candidates = type === VT_I8 ? [VT_I8] : WIDER.slice(WIDER.indexOf(type));
    const fitting = candidates.find(candidate=>fits(candidate, whole));
    return fitting === undefined ? realResult(VT_R8, Number(whole))
        : variantValue(fitting, { integer: whole });
};

/** @param {Exact} a @param {Exact} b @returns {[bigint, bigint, number]} */
const aligned = (a, b)=>{
    const scale = Math.max(a.scale, b.scale);
    return [a.value * 10n ** BigInt(scale - a.scale), b.value * 10n ** BigInt(scale - b.scale),
        scale];
};

/**
 * An exact quotient to as many places as a DECIMAL holds, the last one
 * rounded and the zeros after the last digit that is not one dropped.
 *
 * @param {Exact} a @param {Exact} b
 * @returns {Exact}
 */
const quotient = (a, b)=>{
    if (b.value === 0n)
    {
        return refuse(DISP_E_DIVBYZERO);
    }
    const places = 30;
    const negative = (a.value < 0n) !== (b.value < 0n);
    const dividend = (a.value < 0n ? -a.value : a.value) * 10n ** BigInt(places + b.scale);
    const divisor = (b.value < 0n ? -b.value : b.value) * 10n ** BigInt(a.scale);
    let whole = dividend / divisor;
    const twice = (dividend % divisor) * 2n;
    if (twice > divisor || (twice === divisor && (whole & 1n) === 1n))
    {
        whole++;
    }
    const fitted = fitDecimal({ value: negative ? -whole : whole, scale: places })
        ?? refuse(DISP_E_OVERFLOW);
    let { value, scale: kept } = fitted;
    while (kept > 0 && value % 10n === 0n)
    {
        value /= 10n;
        kept--;
    }
    return { value, scale: kept };
};

/**
 * @param {Value} left @param {Value} right
 * @returns {(type: number) => boolean}
 */
const either = (left, right)=>type=>left.type === type || right.type === type;

/**
 * The types VarAdd, VarSub, VarMul and VarDiv take no operand of, whatever the
 * other side: Windows answers DISP_E_BADVARTYPE for these, even the unsigned
 * and one-byte integers every conversion accepts.
 */
const NOT_ARITHMETIC = new Set([VT_I1, VT_UI2, VT_UI4, VT_UI8, VT_INT, VT_UINT, VT_UNKNOWN,
    VT_VARIANT]);

/**
 * What the four arithmetic operators refuse before they look at a value, and
 * whether the answer is null. An array either side is a mismatch, any other
 * flag no type at all -- a reference included, which VarAdd, VarSub and
 * VarMul do not follow; so is a type they take nothing from, save a record,
 * which is a mismatch on the right, and on the left beside a type up to a byte
 * or an eight-byte integer. Then an interface beside a null is null, and an
 * interface or an error code beside anything else a mismatch.
 *
 * @param {Value} left @param {Value} right
 * @param {boolean} [references]  whether a reference followed is taken, as VarDiv takes one
 * @returns {boolean} whether the answer is VT_NULL
 */
const screenArithmetic = (left, right, references = false)=>{
    const has = either(left, right);
    if (((left.flags | right.flags) & VT_ARRAY) !== 0)
    {
        return refuse(DISP_E_TYPEMISMATCH);
    }
    if ((left.flags | right.flags) !== 0 || (!references && (left.reference || right.reference)))
    {
        return refuse(DISP_E_BADVARTYPE);
    }
    /** @param {Value} side */
    const misfit = side=>!isOperandType(side.type) || NOT_ARITHMETIC.has(side.type)
        || side.type === VT_RECORD;
    if (misfit(left) || misfit(right))
    {
        const record = right.type === VT_RECORD
            || (left.type === VT_RECORD && (right.type <= VT_UI1 || right.type === VT_I8));
        return refuse(record ? DISP_E_TYPEMISMATCH : DISP_E_BADVARTYPE);
    }
    if ((has(VT_DISPATCH) && !has(VT_NULL)) || has(VT_ERROR))
    {
        return refuse(DISP_E_TYPEMISMATCH);
    }
    return has(VT_NULL);
};

/**
 * What the one-operand operators, and the bitwise ones for each side, refuse
 * first: a vector or the reserved bit, a type no variant holds, or a flag on
 * an empty or a null is no type at all; an array or a reference to nothing of
 * a type that is one, a mismatch.
 *
 * @param {Value} operand
 */
const screenOperand = operand=>{
    if ((operand.flags & (VT_VECTOR | VT_RESERVED)) !== 0 || !isOperandType(operand.type)
        || (operand.flags !== 0 && operand.type <= VT_NULL))
    {
        return refuse(DISP_E_BADVARTYPE);
    }
    if (operand.flags !== 0)
    {
        return refuse(DISP_E_TYPEMISMATCH);
    }
    return operand;
};

/**
 * The type VarAdd and VarSub answer in once neither side is null: the first
 * of DECIMAL, DATE, CY and R8 either side has, a string as a double, a float
 * beside a four- or eight-byte integer as a double, then the widest integer.
 *
 * @param {Value} left @param {Value} right
 */
const sumType = (left, right)=>{
    const has = either(left, right);
    if (has(VT_DECIMAL) || has(VT_DATE) || has(VT_CY))
    {
        return has(VT_DECIMAL) ? VT_DECIMAL : has(VT_DATE) ? VT_DATE : VT_CY;
    }
    if (has(VT_R8) || has(VT_BSTR))
    {
        return VT_R8;
    }
    if (has(VT_R4))
    {
        return has(VT_I4) || has(VT_I8) ? VT_R8 : VT_R4;
    }
    return integerType(left, right);
};

/**
 * The integer type two integral operands answer in: the wider of them, a
 * boolean and two empties as I2, and a byte only beside a byte or nothing.
 *
 * @param {Value} left @param {Value} right
 */
const integerType = (left, right)=>{
    const has = either(left, right);
    if (has(VT_I8) || has(VT_I4))
    {
        return has(VT_I8) ? VT_I8 : VT_I4;
    }
    return has(VT_I2) || has(VT_BOOL) || (left.type === VT_EMPTY && right.type === VT_EMPTY)
        ? VT_I2 : VT_UI1;
};

/**
 * Applies one arithmetic operation in the type chosen for it.
 *
 * @param {number} type @param {Value} left @param {Value} right
 * @param {{ exact: (a: Exact, b: Exact) => Exact, real: (a: number, b: number) => number,
 *     integer: (a: bigint, b: bigint) => bigint }} operation
 * @returns {Value}
 */
const compute = (type, left, right, operation)=>{
    switch (type)
    {
        case VT_DECIMAL:
            return decimalResult(operation.exact(exactIn(left), exactIn(right)));
        case VT_CY:
            return currencyResult(operation.exact({ value: currencyOf(left), scale: 4 },
                { value: currencyOf(right), scale: 4 }));
        case VT_R4:
        case VT_R8:
        case VT_DATE:
            return realResult(type, operation.real(realOf(left), realOf(right)));
        default:
            return integerResult(type, operation.integer(integerIn(left, VT_I8),
                integerIn(right, VT_I8)));
    }
};

const ADD = {
    /** @param {Exact} a @param {Exact} b */
    exact: (a, b)=>{
        const [x, y, scale] = aligned(a, b);
        return { value: x + y, scale };
    },
    /** @param {number} a @param {number} b */
    real: (a, b)=>a + b,
    /** @param {bigint} a @param {bigint} b */
    integer: (a, b)=>a + b,
};

const SUBTRACT = {
    /** @param {Exact} a @param {Exact} b */
    exact: (a, b)=>{
        const [x, y, scale] = aligned(a, b);
        return { value: x - y, scale };
    },
    /** @param {number} a @param {number} b */
    real: (a, b)=>a - b,
    /** @param {bigint} a @param {bigint} b */
    integer: (a, b)=>a - b,
};

const MULTIPLY = {
    /** @param {Exact} a @param {Exact} b */
    exact: (a, b)=>({ value: a.value * b.value, scale: a.scale + b.scale }),
    /** @param {number} a @param {number} b */
    real: (a, b)=>a * b,
    /** @param {bigint} a @param {bigint} b */
    integer: (a, b)=>a * b,
};

/**
 * VarAdd: two strings, or a string and an empty, are joined as VarCat joins
 * them; anything else is a sum.
 *
 * @param {Value} left @param {Value} right
 * @returns {Outcome}
 */
export const add = (left, right)=>attempt(()=>{
    if (screenArithmetic(left, right))
    {
        return variantValue(VT_NULL);
    }
    const has = either(left, right);
    if (has(VT_BSTR) && (left.type === right.type || has(VT_EMPTY)))
    {
        return variantValue(VT_BSTR, { text: `${left.text ?? ''}${right.text ?? ''}` });
    }
    return compute(sumType(left, right), left, right, ADD);
});

/**
 * VarSub: as VarAdd chooses its type, save that two strings, a string and an
 * empty, and two dates differ by a double.
 *
 * @param {Value} left @param {Value} right
 * @returns {Outcome}
 */
export const subtract = (left, right)=>attempt(()=>{
    if (screenArithmetic(left, right))
    {
        return variantValue(VT_NULL);
    }
    const has = either(left, right);
    const plain = (left.type === VT_DATE && right.type === VT_DATE)
        || (has(VT_BSTR) && (left.type === right.type || has(VT_EMPTY)));
    return compute(plain ? VT_R8 : sumType(left, right), left, right, SUBTRACT);
});

/**
 * VarMul: a DECIMAL either side keeps it; a double, a string or a date makes
 * a double, as does a float beside a four- or eight-byte integer or a CY;
 * then a float, a CY, the widest integer.
 *
 * @param {Value} left @param {Value} right
 * @returns {Outcome}
 */
export const multiply = (left, right)=>attempt(()=>{
    if (screenArithmetic(left, right))
    {
        return variantValue(VT_NULL);
    }
    const has = either(left, right);
    let type;
    if (has(VT_DECIMAL))
    {
        type = VT_DECIMAL;
    }
    else if (has(VT_R8) || has(VT_BSTR) || has(VT_DATE))
    {
        type = VT_R8;
    }
    else if (has(VT_R4))
    {
        type = has(VT_I4) || has(VT_I8) || has(VT_CY) ? VT_R8 : VT_R4;
    }
    else
    {
        type = has(VT_CY) ? VT_CY : integerType(left, right);
    }
    return compute(type, left, right, MULTIPLY);
});

/** The operands beside which a float quotient stays a float. */
const FLOAT_COMPANIONS = new Set([VT_R4, VT_UI1, VT_BOOL, VT_I2, VT_EMPTY]);

/**
 * VarDiv: a DECIMAL either side keeps it, a float beside a byte, a boolean, a
 * short or an empty stays a float, and everything else is a double -- two
 * integers and two currencies included. Dividing by zero is DISP_E_DIVBYZERO,
 * and zero by zero DISP_E_OVERFLOW, the indeterminate case.
 *
 * @param {Value} left @param {Value} right
 * @returns {Outcome}
 */
export const divide = (left, right)=>attempt(()=>{
    if (screenArithmetic(left, right, true))
    {
        return variantValue(VT_NULL);
    }
    if (right.type === VT_EMPTY)
    {
        return refuse(DISP_E_DIVBYZERO);
    }
    const has = either(left, right);
    if (has(VT_DECIMAL))
    {
        return decimalResult(quotient(exactIn(left), exactIn(right)));
    }
    const dividend = realOf(left);
    const divisor = realOf(right);
    if (divisor === 0)
    {
        return refuse(dividend === 0 ? DISP_E_OVERFLOW : DISP_E_DIVBYZERO);
    }
    const float = has(VT_R4) && FLOAT_COMPANIONS.has(left.type)
        && FLOAT_COMPANIONS.has(right.type);
    return realResult(float ? VT_R4 : VT_R8, dividend / divisor);
});

/** The operands the integer operators take nothing from but a mismatch. */
const NOT_INTEGRAL = new Set([VT_DISPATCH, VT_UNKNOWN, VT_ERROR, VT_VARIANT, VT_RECORD]);

/**
 * What VarIdiv and VarMod refuse, and whether the answer is null, in the
 * order Windows looks: any flag; an eight-byte integer beside an INT; the
 * dividend, if it is one of the kinds that holds no number or no type at all;
 * an empty divisor, which is a zero but beside a null dividend; the divisor,
 * as the dividend was; then a null either side.
 *
 * @param {Value} left @param {Value} right
 * @returns {boolean} whether the answer is VT_NULL
 */
const screenIntegral = (left, right)=>{
    const has = either(left, right);
    if ((left.flags | right.flags) !== 0)
    {
        return refuse(DISP_E_BADVARTYPE);
    }
    if (has(VT_I8) && has(VT_INT))
    {
        return refuse(DISP_E_TYPEMISMATCH);
    }
    for (const side of [left, right])
    {
        if (side === right && right.type === VT_EMPTY)
        {
            return left.type === VT_NULL ? true : refuse(DISP_E_DIVBYZERO);
        }
        if (NOT_INTEGRAL.has(side.type))
        {
            return refuse(DISP_E_TYPEMISMATCH);
        }
        if (!isOperandType(side.type))
        {
            return refuse(DISP_E_BADVARTYPE);
        }
    }
    return has(VT_NULL);
};

/** The operands that keep an integer quotient or remainder below four bytes. */
const SHORT = new Set([VT_UI1, VT_I2, VT_BOOL]);

/**
 * Divides two values made integers of the answer's type, the quotient
 * truncated or the remainder signed as the dividend.
 *
 * @param {number} type @param {Value} left @param {Value} right
 * @param {(a: bigint, b: bigint) => bigint} operation
 * @returns {Value}
 */
const integral = (type, left, right, operation)=>{
    const dividend = integerIn(left, type);
    const divisor = integerIn(right, type);
    if (divisor === 0n)
    {
        return refuse(DISP_E_DIVBYZERO);
    }
    const answer = operation(dividend, divisor);
    return fits(type, answer) ? variantValue(type, { integer: answer }) : refuse(DISP_E_OVERFLOW);
};

/**
 * VarIdiv: both sides rounded to integers and divided, the quotient truncated.
 * Eight bytes either side answer in I8, a byte by a byte in UI1, a short, a
 * boolean or an empty dividend in I2, and everything else in I4.
 *
 * @param {Value} left @param {Value} right
 * @returns {Outcome}
 */
export const integerDivide = (left, right)=>attempt(()=>{
    if (screenIntegral(left, right))
    {
        return variantValue(VT_NULL);
    }
    const has = either(left, right);
    const short = [left, right].every(side=>SHORT.has(side.type) || side === left
        && side.type === VT_EMPTY);
    const type = has(VT_I8) ? VT_I8
        : !short ? VT_I4 : left.type === VT_UI1 && right.type === VT_UI1 ? VT_UI1 : VT_I2;
    return integral(type, left, right, (a, b)=>a / b);
});

/**
 * VarMod: as VarIdiv, the remainder rather than the quotient, its sign the
 * dividend's -- save that an empty dividend answers in I4.
 *
 * @param {Value} left @param {Value} right
 * @returns {Outcome}
 */
export const modulo = (left, right)=>attempt(()=>{
    if (screenIntegral(left, right))
    {
        return variantValue(VT_NULL);
    }
    const has = either(left, right);
    const short = SHORT.has(left.type) && SHORT.has(right.type);
    const type = has(VT_I8) ? VT_I8
        : !short ? VT_I4 : left.type === VT_UI1 && right.type === VT_UI1 ? VT_UI1 : VT_I2;
    return integral(type, left, right, (a, b)=>a % b);
});

/**
 * An operand of the bitwise operators: its bits, and the type they count in.
 * A byte, a short, a boolean and an eight-byte integer keep their type; a
 * string is read as a boolean; an unsigned four bytes keeps its bits as a
 * signed one; everything else is rounded to I4.
 *
 * @param {Value} value
 * @returns {{ type: number, bits: bigint }}
 */
const bitwiseOperand = value=>{
    switch (value.type)
    {
        case VT_EMPTY:
        case VT_NULL:
            return { type: value.type, bits: 0n };
        case VT_UI1:
        case VT_I2:
        case VT_BOOL:
        case VT_I8:
            return { type: value.type, bits: /** @type {bigint} */ (value.integer) };
        case VT_BSTR: {
            const truth = boolOf(String(value.text));
            return truth === null ? refuse(DISP_E_TYPEMISMATCH)
                : { type: VT_BOOL, bits: BigInt(truth) };
        }
        case VT_UI4:
        case VT_UINT:
        case VT_UI8: {
            const whole = /** @type {bigint} */ (value.integer);
            return whole > 0xffffffffn ? refuse(DISP_E_OVERFLOW)
                : { type: VT_I4, bits: BigInt.asIntN(32, whole) };
        }
        case VT_I1:
        case VT_UI2:
        case VT_I4:
        case VT_INT:
        case VT_R4:
        case VT_R8:
        case VT_DATE:
        case VT_CY:
        case VT_DECIMAL:
            return { type: VT_I4, bits: integerIn(value, VT_I4) };
        default:
            return refuse(DISP_E_TYPEMISMATCH);
    }
};

/** @param {number} type @param {bigint} bits @returns {Value} */
const bitsResult = (type, bits)=>variantValue(type, { integer: type === VT_UI1
    ? BigInt.asUintN(8, bits)
    : BigInt.asIntN(type === VT_I8 ? 64 : type === VT_I4 ? 32 : 16, bits) });

/**
 * The type one bitwise operand answers in on its own, as it does beside a
 * null: an empty as I2, anything else as itself.
 *
 * @param {number} type
 */
const aloneType = type=>(type === VT_EMPTY ? VT_I2 : type);

/**
 * The bitwise operators share their types and differ in what a null does:
 * beside one, `withNull` answers given the other side's bits, or null.
 *
 * @param {(a: bigint, b: bigint) => bigint} operation
 * @param {(other: { type: number, bits: bigint }) => Value} withNull
 */
const bitwise = (operation, withNull)=>
    /**
     * @param {Value} left @param {Value} right
     * @returns {Outcome}
     */
    (left, right)=>attempt(()=>{
        const a = bitwiseOperand(screenOperand(left));
        const b = bitwiseOperand(screenOperand(right));
        if ((left.type === VT_I8 && right.type === VT_INT)
            || (left.type === VT_INT && right.type === VT_I8))
        {
            return refuse(DISP_E_TYPEMISMATCH);
        }
        if (a.type === VT_NULL || b.type === VT_NULL)
        {
            return a.type === VT_NULL && b.type === VT_NULL ? variantValue(VT_NULL)
                : withNull(a.type === VT_NULL ? b : a);
        }
        const types = [a.type, b.type];
        let type;
        if (types.includes(VT_I8) || types.includes(VT_I4))
        {
            type = types.includes(VT_I8) ? VT_I8 : VT_I4;
        }
        else
        {
            type = a.type === b.type && (a.type === VT_UI1 || a.type === VT_BOOL) ? a.type : VT_I2;
        }
        return bitsResult(type, operation(a.bits, b.bits));
    });

/**
 * VarAnd: a null beside zero is that zero, in the other side's type, and
 * beside anything else stays null -- false and unknown is false.
 */
export const and = bitwise((a, b)=>a & b, other=>(other.bits === 0n
    ? bitsResult(aloneType(other.type), 0n) : variantValue(VT_NULL)));

/**
 * VarOr: a null beside zero stays null, and beside anything else is that
 * value, in its own type -- true or unknown is true.
 */
export const or = bitwise((a, b)=>a | b, other=>(other.bits === 0n
    ? variantValue(VT_NULL) : bitsResult(aloneType(other.type), other.bits)));

/** VarXor: a null either side is null. */
export const xor = bitwise((a, b)=>a ^ b, ()=>variantValue(VT_NULL));

/**
 * VarNot: the complement, in the operand's own type for a byte, a short, a
 * boolean and an eight-byte integer, and in I4 for the rest. An empty is the
 * complement of a zero short; a string is a number if it reads as one and a
 * boolean if not.
 *
 * @param {Value} operand
 * @returns {Outcome}
 */
export const not = operand=>attempt(()=>{
    screenOperand(operand);
    if (operand.type === VT_BSTR && parseNumber(String(operand.text)) !== null)
    {
        return bitsResult(VT_I4, ~integerIn(operand, VT_I4));
    }
    const { type, bits } = bitwiseOperand(operand);
    return type === VT_NULL ? variantValue(VT_NULL) : bitsResult(aloneType(type), ~bits);
});

/**
 * VarNeg: the negation, a byte and a boolean as I2 and a string as a double; a
 * short or a long whose negation does not fit moves up as a sum would. The
 * unsigned and one-byte signed integers are refused, as Windows refuses them.
 *
 * @param {Value} operand
 * @returns {Outcome}
 */
export const negate = operand=>attempt(()=>{
    screenOperand(operand);
    const whole = operand.integer;
    switch (operand.type)
    {
        case VT_NULL:
            return variantValue(VT_NULL);
        case VT_EMPTY:
            return variantValue(VT_I2, { integer: 0n });
        case VT_UI1:
        case VT_BOOL:
        case VT_I2:
            return integerResult(VT_I2, -(/** @type {bigint} */ (whole)));
        case VT_I4:
        case VT_I8:
            return integerResult(operand.type, -(/** @type {bigint} */ (whole)));
        case VT_R4:
        case VT_R8:
        case VT_DATE:
            return variantValue(operand.type, { real: -(/** @type {number} */ (operand.real)) });
        case VT_BSTR:
            return realResult(VT_R8, -realOf(operand));
        case VT_CY:
        case VT_DECIMAL: {
            const exact = /** @type {Exact} */ (operand.exact);
            const negated = { value: -exact.value, scale: exact.scale };
            return operand.type === VT_CY ? currencyResult(negated)
                : variantValue(VT_DECIMAL, { exact: negated });
        }
        case VT_I1:
        case VT_UI2:
        case VT_UI4:
        case VT_UI8:
        case VT_INT:
        case VT_UINT:
            return refuse(DISP_E_BADVARTYPE);
        default:
            return refuse(DISP_E_TYPEMISMATCH);
    }
});

/**
 * A string as the CY VarCyFromStr makes of it: rounded to the fourth place,
 * an overflow past a CY's range.
 *
 * @param {string} text
 * @returns {bigint | number} the ten-thousandths, or the HRESULT
 */
export function currencyFromText(text){
    const outcome = attempt(()=>currencyResult(exactIn(variantValue(VT_BSTR, { text }))));
    return typeof outcome === 'number' ? outcome : /** @type {Exact} */ (outcome.exact).value;
}

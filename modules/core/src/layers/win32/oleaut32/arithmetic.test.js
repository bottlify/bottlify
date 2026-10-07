/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The answers here are the ones Windows gives, as Wine's conformance tests
 * (vartest.c) record them: the type of each answer for every pair of operand
 * types, and the values of the cases that test spells out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    add, and, divide, integerDivide, isOperandType, modulo, multiply, nearest, negate, not, or,
    subtract, variantValue, xor,
} from './arithmetic.js';
import {
    DISP_E_BADVARTYPE, DISP_E_DIVBYZERO, DISP_E_OVERFLOW, DISP_E_TYPEMISMATCH, VT_ARRAY, VT_BOOL,
    VT_BSTR, VT_BYREF, VT_RESERVED, VT_VECTOR,
    VT_CY, VT_DATE, VT_DECIMAL, VT_DISPATCH, VT_EMPTY, VT_ERROR, VT_I1, VT_I2, VT_I4, VT_I8,
    VT_INT, VT_NULL, VT_R4, VT_R8, VT_RECORD, VT_UI1, VT_UI2, VT_UI4, VT_UI8, VT_UINT,
    VT_UNKNOWN, VT_VARIANT,
} from './vartypes.js';

/** @typedef {import('./arithmetic.js').Value} Value */
/** @typedef {import('./arithmetic.js').Outcome} Outcome */

/**
 * An operand: a number for the numeric types (ten-thousandths for a CY), the
 * text for a BSTR, an exact value for a DECIMAL.
 *
 * @param {number} type @param {any} [x]
 * @returns {Value}
 */
const v = (type, x = 0)=>{
    switch (type)
    {
        case VT_R4:
            return variantValue(type, { real: Math.fround(x) });
        case VT_R8:
        case VT_DATE:
            return variantValue(type, { real: x });
        case VT_CY:
            return variantValue(type, { exact: { value: BigInt(x), scale: 4 } });
        case VT_DECIMAL:
            return variantValue(type, { exact: x });
        case VT_BSTR:
            return variantValue(type, { text: x });
        case VT_EMPTY:
        case VT_NULL:
        case VT_DISPATCH:
        case VT_UNKNOWN:
        case VT_ERROR:
        case VT_VARIANT:
        case VT_RECORD:
            return variantValue(type);
        default:
            return variantValue(type, { integer: BigInt(x) });
    }
};

/**
 * An outcome as [type, number], or the HRESULT; a CY and a DECIMAL as their
 * value, a BSTR as its text.
 *
 * @param {Outcome} outcome
 */
const seen = outcome=>{
    if (typeof outcome === 'number')
    {
        return outcome;
    }
    if (outcome.type === VT_BSTR)
    {
        return [outcome.type, outcome.text];
    }
    if (outcome.exact)
    {
        return [outcome.type, Number(outcome.exact.value) / 10 ** outcome.exact.scale];
    }
    return [outcome.type, outcome.real ?? (outcome.integer === null ? null
        : Number(outcome.integer))];
};

/** The type of an answer, or the HRESULT of a failure. @param {Outcome} outcome */
const typeIn = outcome=>(typeof outcome === 'number' ? outcome : outcome.type);

/** @param {Outcome} outcome @param {number} type @param {number} value */
const close = (outcome, type, value)=>{
    const [kind, number] = /** @type {[number, number]} */ (seen(outcome));
    assert.equal(kind, type);
    assert.ok(Math.abs(number - value) < 1e-6 * Math.max(1, Math.abs(value)),
        `${number} against ${value}`);
};

/**
 * Every operand type, with a value each test of a type pair can use.
 *
 * @type {Value[]}
 */
const SAMPLES = [
    v(VT_EMPTY), v(VT_NULL), v(VT_I2, 2), v(VT_I4, 2), v(VT_R4, 2), v(VT_R8, 2),
    v(VT_CY, 20000), v(VT_DATE, 2), v(VT_BSTR, '2'), v(VT_DISPATCH), v(VT_ERROR),
    v(VT_BOOL, -1), v(VT_VARIANT), v(VT_UNKNOWN), v(VT_DECIMAL, { value: 2n, scale: 0 }),
    v(VT_I1, 2), v(VT_UI1, 2), v(VT_UI2, 2), v(VT_UI4, 2), v(VT_I8, 2), v(VT_UI8, 2),
    v(VT_INT, 2), v(VT_UINT, 2), v(VT_RECORD),
];

/**
 * The same types, every value zero: what no difference of two of them overflows.
 *
 * @type {Value[]}
 */
const ZEROS = SAMPLES.map(sample=>(sample.text !== null ? v(VT_BSTR, '0')
    : sample.exact ? v(sample.type, sample.type === VT_CY ? 0 : { value: 0n, scale: 0 })
        : v(sample.type, 0)));

/**
 * Runs an operator over every pair of sample types against `expected`, which
 * answers the type of the result or the failure.
 *
 * @param {(a: Value, b: Value) => Outcome} operator
 * @param {(a: number, b: number) => number | 'fail'} expected
 * @param {Value[]} [samples]
 */
const everyPair = (operator, expected, samples = SAMPLES)=>{
    for (const left of samples)
    {
        for (const right of samples)
        {
            /** @type {number | 'fail'} */
            const want = expected(left.type, right.type);
            /** @type {Outcome} */
            const got = operator(left, right);
            /** @type {string} */
            const label = `${left.type} with ${right.type}`;
            if (want === 'fail')
            {
                assert.equal(typeof got, 'number', `${label} should fail`);
            }
            else
            {
                assert.equal(typeof got === 'number' ? `0x${(got >>> 0).toString(16)}` : got.type,
                    want, label);
            }
        }
    }
};

/** The operand types VarAdd, VarSub, VarMul and VarDiv refuse whatever the other is. */
const REFUSED = [VT_I1, VT_UI2, VT_UI4, VT_UI8, VT_INT, VT_UINT, VT_UNKNOWN, VT_VARIANT,
    VT_RECORD, VT_ERROR];

/**
 * The failures and nulls the four arithmetic operators share, or undefined
 * when the pair has a value.
 *
 * @param {number} a @param {number} b
 * @returns {number | 'fail' | undefined}
 */
const arithmeticScreen = (a, b)=>{
    const has = (/** @type {number} */ t)=>a === t || b === t;
    if (REFUSED.includes(a) || REFUSED.includes(b))
    {
        return 'fail';
    }
    if (has(VT_NULL))
    {
        return VT_NULL;
    }
    return has(VT_DISPATCH) ? 'fail' : undefined;
};

/**
 * The type VarAdd answers in for a pair of operand types.
 *
 * @param {number} a @param {number} b
 * @returns {number | 'fail'}
 */
const sumType = (a, b)=>{
    const has = (/** @type {number} */ t)=>a === t || b === t;
    const screened = arithmeticScreen(a, b);
    if (screened !== undefined)
    {
        return screened;
    }
    if (has(VT_DECIMAL) || has(VT_DATE) || has(VT_CY) || has(VT_R8))
    {
        return [VT_DECIMAL, VT_DATE, VT_CY, VT_R8].find(has) ?? 0;
    }
    if (has(VT_BSTR))
    {
        return a === b || has(VT_EMPTY) ? VT_BSTR : VT_R8;
    }
    if (has(VT_R4))
    {
        return has(VT_I4) || has(VT_I8) ? VT_R8 : VT_R4;
    }
    if (has(VT_I8) || has(VT_I4))
    {
        return has(VT_I8) ? VT_I8 : VT_I4;
    }
    return has(VT_I2) || has(VT_BOOL) || (a === VT_EMPTY && b === VT_EMPTY) ? VT_I2 : VT_UI1;
};

test('VarAdd answers in the type Windows does for every pair', ()=>{
    everyPair(add, sumType);
});

test('VarAdd adds, joins two strings, and widens an integer that overflows', ()=>{
    const twelve = v(VT_BSTR, '12');
    const cases = /** @type {[Value, Value, number, number][]} */ ([
        [v(VT_I4, 4), v(VT_I4, 2), VT_I4, 6],
        [v(VT_I2, 4), v(VT_I2, 2), VT_I2, 6],
        [v(VT_I2, -13), v(VT_I4, 5), VT_I4, -8],
        [v(VT_I2, 7), v(VT_R4, 0.5), VT_R4, 7.5],
        [v(VT_R4, 0.5), v(VT_I4, 5), VT_R8, 5.5],
        [v(VT_R8, 7.1), v(VT_BOOL, 0), VT_R8, 7.1],
        [twelve, v(VT_I2, 4), VT_R8, 16],
        [twelve, v(VT_BOOL, 1), VT_R8, 13],
        [twelve, v(VT_R4, 0.1), VT_R8, 12.1],
        [v(VT_DATE, 2.25), v(VT_I4, 7), VT_DATE, 9.25],
        [v(VT_DATE, 1.25), v(VT_R4, -1.7), VT_DATE, -0.45],
        [v(VT_UI1, 255), v(VT_UI1, 255), VT_I2, 510],
        [v(VT_I2, 32767), v(VT_I2, 32767), VT_I4, 65534],
        [v(VT_I2, 32767), v(VT_I2, -32768), VT_I2, -1],
        [v(VT_I4, 2147483647), v(VT_I4, -2147483648), VT_I4, -1],
        [v(VT_I4, 2147483647), v(VT_I4, 2147483647), VT_R8, 4294967294],
        [v(VT_R4, 3.4e38), v(VT_R4, 3.4e38), VT_R8, 6.8e38],
        [v(VT_CY, 47110000), v(VT_UI1, 9), VT_CY, 4720],
        [v(VT_I4, -11), v(VT_DECIMAL, { value: -42n, scale: 1 }), VT_DECIMAL, -15.2],
    ]);
    for (const [left, right, type, value] of cases)
    {
        close(add(left, right), type, value);
        close(add(right, left), type, value);
    }
    assert.deepEqual(seen(add(twelve, twelve)), [VT_BSTR, '1212']);
    assert.deepEqual(seen(add(v(VT_EMPTY), twelve)), [VT_BSTR, '12']);
    assert.equal(add(v(VT_R8, 1.7e308), v(VT_R8, 1.7e308)), DISP_E_OVERFLOW);
    assert.equal(add(v(VT_DATE, 2958465.5), v(VT_I4, 1)), DISP_E_OVERFLOW, 'past 9999');
    assert.equal(typeIn(add(twelve, v(VT_I2, 1))), VT_R8);
    assert.equal(add(v(VT_BSTR, 'twelve'), v(VT_I2, 1)), DISP_E_TYPEMISMATCH);
    assert.equal(add(v(VT_I1, 1), v(VT_I2, 1)), DISP_E_BADVARTYPE);
    assert.equal(add(v(VT_CY, 9223372036854775807n), v(VT_CY, 1)), DISP_E_OVERFLOW);
});

test('VarSub answers as VarAdd, save that strings and dates differ by a double', ()=>{
    everyPair(subtract, (a, b)=>{
        const has = (/** @type {number} */ t)=>a === t || b === t;
        const sum = sumType(a, b);
        return sum !== 'fail' && sum !== VT_NULL
            && ((has(VT_BSTR) && (a === b || has(VT_EMPTY))) || (a === VT_DATE && b === VT_DATE))
            ? VT_R8 : sum;
    }, ZEROS);
    const cases = /** @type {[Value, Value, number, number][]} */ ([
        [v(VT_I2, -13), v(VT_I4, 5), VT_I4, -18],
        [v(VT_R4, 0.5), v(VT_I4, 5), VT_R8, -4.5],
        [v(VT_BSTR, '12'), v(VT_BOOL, 1), VT_R8, 11],
        [v(VT_R4, 0.2), v(VT_BSTR, '12'), VT_R8, -11.8],
        [v(VT_DATE, 2.25), v(VT_I4, 7), VT_DATE, -4.75],
        [v(VT_DATE, 1.25), v(VT_R4, -1.7), VT_DATE, 2.95],
        [v(VT_UI1, 255), v(VT_UI1, 255), VT_UI1, 0],
        [v(VT_UI1, 0), v(VT_UI1, 1), VT_I2, -1],
        [v(VT_I4, -2147483648), v(VT_I4, -2147483648), VT_I4, 0],
        [v(VT_BSTR, '12'), v(VT_BSTR, '12'), VT_R8, 0],
        [v(VT_CY, 47110000), v(VT_UI1, 9), VT_CY, 4702],
        [v(VT_I4, -11), v(VT_DECIMAL, { value: -42n, scale: 1 }), VT_DECIMAL, -6.8],
    ]);
    for (const [left, right, type, value] of cases)
    {
        close(subtract(left, right), type, value);
    }
    assert.equal(typeIn(subtract(v(VT_DISPATCH), v(VT_NULL))), VT_NULL);
    assert.equal(subtract(v(VT_ERROR), v(VT_I2)), DISP_E_TYPEMISMATCH);
    assert.equal(subtract(v(VT_UNKNOWN), v(VT_NULL)), DISP_E_BADVARTYPE);
});

test('VarMul makes a double of a string or a date, and widens what overflows', ()=>{
    everyPair(multiply, (a, b)=>{
        const has = (/** @type {number} */ t)=>a === t || b === t;
        const screened = arithmeticScreen(a, b);
        if (screened !== undefined)
        {
            return screened;
        }
        if (has(VT_DECIMAL))
        {
            return VT_DECIMAL;
        }
        if (has(VT_R8) || has(VT_BSTR) || has(VT_DATE))
        {
            return VT_R8;
        }
        if (has(VT_R4))
        {
            return has(VT_I4) || has(VT_I8) || has(VT_CY) ? VT_R8 : VT_R4;
        }
        if (has(VT_CY) || has(VT_I8) || has(VT_I4))
        {
            return has(VT_CY) ? VT_CY : has(VT_I8) ? VT_I8 : VT_I4;
        }
        return has(VT_I2) || has(VT_BOOL) || (a === VT_EMPTY && b === VT_EMPTY) ? VT_I2 : VT_UI1;
    });
    const cases = /** @type {[Value, Value, number, number][]} */ ([
        [v(VT_I2, -13), v(VT_I4, 5), VT_I4, -65],
        [v(VT_I2, 7), v(VT_R4, 0.5), VT_R4, 3.5],
        [v(VT_R4, 0.5), v(VT_I4, 5), VT_R8, 2.5],
        [v(VT_BSTR, '12'), v(VT_BSTR, '12'), VT_R8, 144],
        [v(VT_DATE, 2.25), v(VT_I4, 7), VT_R8, 15.75],
        [v(VT_UI1, 255), v(VT_UI1, 255), VT_I4, 65025],
        [v(VT_I2, 32767), v(VT_I2, -32768), VT_I4, -1073709056],
        [v(VT_I4, 2147483647), v(VT_I4, 2147483647), VT_R8, 2147483647 * 2147483647],
        [v(VT_CY, 47110000), v(VT_UI1, 9), VT_CY, 42399],
        [v(VT_CY, 15000), v(VT_CY, 15000), VT_CY, 2.25],
        [v(VT_I4, -11), v(VT_DECIMAL, { value: -42n, scale: 1 }), VT_DECIMAL, 46.2],
    ]);
    for (const [left, right, type, value] of cases)
    {
        close(multiply(left, right), type, value);
        close(multiply(right, left), type, value);
    }
});

test('VarDiv makes a double of integers, keeps a float beside a short, and knows 0/0', ()=>{
    everyPair(divide, (a, b)=>{
        const has = (/** @type {number} */ t)=>a === t || b === t;
        const screened = arithmeticScreen(a, b);
        if (screened !== undefined)
        {
            return screened;
        }
        if (b === VT_EMPTY)
        {
            return 'fail';
        }
        if (has(VT_DECIMAL))
        {
            return VT_DECIMAL;
        }
        const floatFriendly = [VT_R4, VT_UI1, VT_BOOL, VT_I2, VT_EMPTY];
        return has(VT_R4) && floatFriendly.includes(a) && floatFriendly.includes(b)
            ? VT_R4 : VT_R8;
    });
    const cases = /** @type {[Value, Value, number, number][]} */ ([
        [v(VT_EMPTY), v(VT_I2, 2), VT_R8, 0],
        [v(VT_EMPTY), v(VT_R4, 2), VT_R4, 0],
        [v(VT_I2, 1), v(VT_I2, 2), VT_R8, 0.5],
        [v(VT_I2, 1), v(VT_R4, 2), VT_R4, 0.5],
        [v(VT_I4, 1), v(VT_R4, 2), VT_R8, 0.5],
        [v(VT_R4, 1), v(VT_BOOL, -1), VT_R4, -1],
        [v(VT_UI1, 1), v(VT_UI1, 2), VT_R8, 0.5],
        [v(VT_BSTR, '1'), v(VT_BSTR, '2'), VT_R8, 0.5],
        [v(VT_BOOL, -1), v(VT_BOOL, -1), VT_R8, 1],
        [v(VT_CY, 100000000), v(VT_CY, 100000000), VT_R8, 1],
        [v(VT_CY, 100000000), v(VT_UI1, 2), VT_R8, 5000],
        [v(VT_I4, 100), v(VT_CY, 100000000), VT_R8, 0.01],
        [v(VT_I4, 100), v(VT_DECIMAL, { value: 2n, scale: 0 }), VT_DECIMAL, 50],
        [v(VT_DECIMAL, { value: 2n, scale: 0 }), v(VT_UI1, 2), VT_DECIMAL, 1],
    ]);
    for (const [left, right, type, value] of cases)
    {
        close(divide(left, right), type, value);
    }
    assert.equal(typeIn(divide(v(VT_NULL), v(VT_EMPTY))), VT_NULL);
    assert.equal(divide(v(VT_I2, 1), v(VT_EMPTY)), DISP_E_DIVBYZERO);
    assert.equal(divide(v(VT_R8, 1), v(VT_R8, 0)), DISP_E_DIVBYZERO);
    assert.equal(divide(v(VT_R8, 0), v(VT_R8, 0)), DISP_E_OVERFLOW, 'zero by zero');
    assert.deepEqual(/** @type {Value} */ (divide(v(VT_DECIMAL, { value: 1n, scale: 0 }),
        v(VT_I4, 3))).exact, { value: 3333333333333333333333333333n, scale: 28 });
    assert.deepEqual(/** @type {Value} */ (divide(v(VT_DECIMAL, { value: 100n, scale: 0 }),
        v(VT_I4, 2))).exact, { value: 50n, scale: 0 }, 'no zeros past the last digit');
});

/**
 * The failures and nulls VarIdiv and VarMod share, or undefined when the pair
 * has a value.
 *
 * @param {number} a @param {number} b
 * @returns {number | 'fail' | undefined}
 */
const integralScreen = (a, b)=>{
    const has = (/** @type {number} */ t)=>a === t || b === t;
    if ([VT_DISPATCH, VT_UNKNOWN, VT_ERROR, VT_VARIANT, VT_RECORD].some(has)
        || (has(VT_I8) && has(VT_INT)))
    {
        return 'fail';
    }
    if (has(VT_NULL))
    {
        return VT_NULL;
    }
    return b === VT_EMPTY ? 'fail' : undefined;
};

test('VarIdiv rounds both sides to integers and keeps the narrowest type it can', ()=>{
    everyPair(integerDivide, (a, b)=>{
        const has = (/** @type {number} */ t)=>a === t || b === t;
        const screened = integralScreen(a, b);
        if (screened !== undefined)
        {
            return screened;
        }
        if (has(VT_I8))
        {
            return VT_I8;
        }
        const short = [VT_I2, VT_BOOL, VT_UI1];
        if ((short.includes(a) || a === VT_EMPTY) && short.includes(b))
        {
            return a === VT_UI1 && b === VT_UI1 ? VT_UI1 : VT_I2;
        }
        return VT_I4;
    });
    const cases = /** @type {[Value, Value, number, number][]} */ ([
        [v(VT_EMPTY), v(VT_I2, 1), VT_I2, 0],
        [v(VT_EMPTY), v(VT_UI1, 1), VT_I2, 0],
        [v(VT_EMPTY), v(VT_R4, 1), VT_I4, 0],
        [v(VT_I2, 2), v(VT_BOOL, -1), VT_I2, -2],
        [v(VT_R4, 2), v(VT_I8, 1), VT_I8, 2],
        [v(VT_BSTR, '2'), v(VT_BSTR, '1'), VT_I4, 2],
        [v(VT_I4, 7), v(VT_I4, -2), VT_I4, -3],
        [v(VT_R8, 7.5), v(VT_I4, 2), VT_I4, 4],
        [v(VT_CY, 10000), v(VT_CY, 10000), VT_I4, 1],
        [v(VT_CY, 100000000), v(VT_I8, 2), VT_I8, 5000],
        [v(VT_I4, 100), v(VT_DECIMAL, { value: 2n, scale: 0 }), VT_I4, 50],
    ]);
    for (const [left, right, type, value] of cases)
    {
        close(integerDivide(left, right), type, value);
    }
    assert.equal(integerDivide(v(VT_INT, 1), v(VT_INT, 0)), DISP_E_DIVBYZERO);
    assert.equal(integerDivide(v(VT_INT, 0), v(VT_INT, 0)), DISP_E_DIVBYZERO);
    assert.equal(integerDivide(v(VT_R8, 1e10), v(VT_I4, 1)), DISP_E_OVERFLOW);
});

test('VarMod answers the remainder, signed as the dividend', ()=>{
    everyPair(modulo, (a, b)=>{
        const has = (/** @type {number} */ t)=>a === t || b === t;
        const screened = integralScreen(a, b);
        if (screened !== undefined)
        {
            return screened;
        }
        if (has(VT_I8))
        {
            return VT_I8;
        }
        const short = [VT_I2, VT_BOOL, VT_UI1];
        if (short.includes(a) && short.includes(b))
        {
            return a === VT_UI1 && b === VT_UI1 ? VT_UI1 : VT_I2;
        }
        return VT_I4;
    });
    const cases = /** @type {[Value, Value, number, number][]} */ ([
        [v(VT_I1, 100), v(VT_BOOL, 10), VT_I4, 0],
        [v(VT_UI1, 100), v(VT_BOOL, 10), VT_I2, 0],
        [v(VT_UI1, 100), v(VT_UI1, 10), VT_UI1, 0],
        [v(VT_BOOL, 100), v(VT_DATE, 10), VT_I4, 0],
        [v(VT_BSTR, '125'), v(VT_BSTR, '10'), VT_I4, 5],
        [v(VT_I4, 125), v(VT_BSTR, '10'), VT_I4, 5],
        [v(VT_BSTR, '125'), v(VT_I8, 10), VT_I8, 5],
        [v(VT_I4, -1), v(VT_I4, -1), VT_I4, 0],
        [v(VT_EMPTY), v(VT_I4, 10), VT_I4, 0],
        [v(VT_I4, -7), v(VT_I4, 3), VT_I4, -1],
        [v(VT_I4, 7), v(VT_I4, -3), VT_I4, 1],
        [v(VT_CY, 100000), v(VT_CY, 100000), VT_I4, 0],
        [v(VT_UINT, 100), v(VT_I4, 10), VT_I4, 0],
        [v(VT_R8, 10.5), v(VT_I4, 4), VT_I4, 2],
    ]);
    for (const [left, right, type, value] of cases)
    {
        close(modulo(left, right), type, value);
    }
    assert.equal(modulo(v(VT_I4, 100), v(VT_I4, 0)), DISP_E_DIVBYZERO);
    assert.equal(modulo(v(VT_EMPTY), v(VT_EMPTY)), DISP_E_DIVBYZERO);
    assert.equal(typeIn(modulo(v(VT_EMPTY), v(VT_NULL))), VT_NULL);
    assert.equal(typeIn(modulo(v(VT_NULL), v(VT_EMPTY))), VT_NULL);
    assert.equal(modulo(v(VT_UNKNOWN), v(VT_EMPTY)), DISP_E_TYPEMISMATCH);
    assert.equal(modulo(v(VT_I8, 1), v(VT_INT, 1)), DISP_E_TYPEMISMATCH);
});

/** The type one bitwise operand counts in. @param {number} t */
const bitType = t=>([VT_UI1, VT_I2, VT_BOOL, VT_I8, VT_EMPTY, VT_NULL].includes(t) ? t
    : t === VT_BSTR ? VT_BOOL : VT_I4);

/**
 * The type VarAnd, VarOr and VarXor answer in for two operands neither of
 * which is null.
 *
 * @param {number} a @param {number} b
 * @returns {number | 'fail'}
 */
const bitwisePair = (a, b)=>{
    if ([VT_DISPATCH, VT_UNKNOWN, VT_ERROR, VT_VARIANT, VT_RECORD].includes(a)
        || [VT_DISPATCH, VT_UNKNOWN, VT_ERROR, VT_VARIANT, VT_RECORD].includes(b)
        || (a === VT_I8 && b === VT_INT) || (a === VT_INT && b === VT_I8))
    {
        return 'fail';
    }
    const [x, y] = [bitType(a), bitType(b)];
    if (x === VT_I8 || y === VT_I8 || x === VT_I4 || y === VT_I4)
    {
        return x === VT_I8 || y === VT_I8 ? VT_I8 : VT_I4;
    }
    return x === y && (x === VT_UI1 || x === VT_BOOL) ? x : VT_I2;
};

test('VarAnd, VarOr and VarXor share a type table, and differ only beside a null', ()=>{
    // The samples are all non-zero: beside one of them a null is null for
    // VarAnd and VarXor, and the other side for VarOr.
    for (const [operator, withNull] of /** @type {const} */ ([[and, 'null'], [or, 'other'],
        [xor, 'null']]))
    {
        everyPair(operator, (a, b)=>{
            const pair = bitwisePair(a === VT_NULL ? VT_I2 : a, b === VT_NULL ? VT_I2 : b);
            if (pair === 'fail' || (a !== VT_NULL && b !== VT_NULL))
            {
                return pair;
            }
            const other = a === VT_NULL ? b : a;
            if (other === VT_NULL || other === VT_EMPTY || withNull === 'null')
            {
                return other === VT_EMPTY && operator === and ? VT_I2 : VT_NULL;
            }
            return bitType(other);
        });
    }
});

test('the bitwise operators keep the bits Windows keeps', ()=>{
    const truth = v(VT_BSTR, '#TRUE#');
    const falsity = v(VT_BSTR, '#FALSE#');
    const cases = /** @type {[Function, Value, Value, number, number][]} */ ([
        [xor, v(VT_BOOL, -1), v(VT_BOOL, -1), VT_BOOL, 0],
        [xor, v(VT_BOOL, -1), v(VT_UI1, 255), VT_I2, -256],
        [xor, v(VT_BOOL, -1), v(VT_UI2, 65535), VT_I4, -65536],
        [xor, v(VT_BOOL, -1), v(VT_UI4, 0xffffffff), VT_I4, 0],
        [xor, v(VT_BOOL, -1), v(VT_R8, -1), VT_I4, 0],
        [xor, v(VT_BOOL, -1), truth, VT_BOOL, 0],
        [xor, v(VT_UI1, 255), truth, VT_I2, -256],
        [xor, v(VT_UI1, 255), v(VT_CY, 10000), VT_I4, 254],
        [xor, v(VT_R4, -1), v(VT_I8, -1), VT_I8, 0],
        [xor, falsity, v(VT_CY, 10000), VT_I4, 1],
        [xor, v(VT_EMPTY), v(VT_UI1, 1), VT_I2, 1],
        [or, v(VT_NULL), v(VT_UI1, 1), VT_UI1, 1],
        [or, v(VT_NULL), v(VT_I1, 1), VT_I4, 1],
        [or, v(VT_NULL), truth, VT_BOOL, -1],
        [or, v(VT_NULL), v(VT_CY, 10000), VT_I4, 1],
        [and, v(VT_NULL), v(VT_UI1, 0), VT_UI1, 0],
        [and, v(VT_NULL), v(VT_BOOL, 0), VT_BOOL, 0],
        [and, v(VT_NULL), falsity, VT_BOOL, 0],
        [and, v(VT_NULL), v(VT_EMPTY), VT_I2, 0],
        [and, v(VT_NULL), v(VT_CY, 0), VT_I4, 0],
        [and, v(VT_UI1, 255), truth, VT_I2, 255],
        [and, v(VT_UI2, 65535), truth, VT_I4, 65535],
        [and, v(VT_UI1, 255), v(VT_UI1, 15), VT_UI1, 15],
    ]);
    for (const [operator, left, right, type, value] of cases)
    {
        assert.deepEqual(seen(operator(left, right)), [type, value]);
        assert.deepEqual(seen(operator(right, left)), [type, value]);
    }
    assert.equal(typeIn(or(v(VT_NULL), v(VT_I4, 0))), VT_NULL, 'null or zero is null');
    assert.equal(typeIn(and(v(VT_NULL), truth)), VT_NULL, 'null and true is null');
    assert.equal(typeIn(xor(v(VT_NULL), falsity)), VT_NULL);
    assert.equal(and(v(VT_BSTR, 'maybe'), v(VT_I4, 1)), DISP_E_TYPEMISMATCH);
    assert.equal(and(v(VT_R8, 3e9), v(VT_I4, 1)), DISP_E_OVERFLOW);
});

test('VarNot complements in the operand\'s own type or in I4, a string as a number first', ()=>{
    const cases = /** @type {[Value, number, number][]} */ ([
        [v(VT_EMPTY), VT_I2, -1],
        [v(VT_BOOL, -1), VT_BOOL, 0],
        [v(VT_BOOL, 0), VT_BOOL, -1],
        [v(VT_I1, -1), VT_I4, 0],
        [v(VT_I2, 1), VT_I2, -2],
        [v(VT_UI1, 1), VT_UI1, 254],
        [v(VT_UI1, 0), VT_UI1, 255],
        [v(VT_UI2, 1), VT_I4, -2],
        [v(VT_UI4, 0), VT_I4, -1],
        [v(VT_INT, 1), VT_I4, -2],
        [v(VT_UINT, 0), VT_I4, -1],
        [v(VT_I8, 1), VT_I8, -2],
        [v(VT_UI8, 1), VT_I4, -2],
        [v(VT_R4, 1), VT_I4, -2],
        [v(VT_R8, 0), VT_I4, -1],
        [v(VT_DATE, 1), VT_I4, -2],
        [v(VT_BSTR, '0'), VT_I4, -1],
        [v(VT_BSTR, '1'), VT_I4, -2],
        [v(VT_BSTR, '#TRUE#'), VT_BOOL, 0],
        [v(VT_BSTR, '#FALSE#'), VT_BOOL, -1],
        [v(VT_DECIMAL, { value: -1n, scale: 0 }), VT_I4, 0],
        [v(VT_CY, 10000), VT_I4, -2],
        [v(VT_CY, 0), VT_I4, -1],
        [v(VT_CY, -1), VT_I4, -1],
    ]);
    for (const [operand, type, value] of cases)
    {
        assert.deepEqual(seen(not(operand)), [type, value], `${operand.type}`);
    }
    assert.equal(typeIn(not(v(VT_NULL))), VT_NULL);
    for (const type of [VT_UNKNOWN, VT_DISPATCH, VT_ERROR, VT_RECORD, VT_VARIANT])
    {
        assert.equal(not(v(type)), DISP_E_TYPEMISMATCH);
    }
    assert.equal(not(v(VT_BSTR, '')), DISP_E_TYPEMISMATCH, 'an empty string is neither');
});

test('VarNeg negates, a byte and a boolean as I2, and widens what does not fit', ()=>{
    const cases = /** @type {[Value, number, number][]} */ ([
        [v(VT_BOOL, -1), VT_I2, 1],
        [v(VT_BOOL, 0), VT_I2, 0],
        [v(VT_UI1, 254), VT_I2, -254],
        [v(VT_I2, -32768), VT_I4, 32768],
        [v(VT_I2, -1), VT_I2, 1],
        [v(VT_I4, -2147483648), VT_R8, 2147483648],
        [v(VT_I4, 1), VT_I4, -1],
        [v(VT_I8, -1), VT_I8, 1],
        [v(VT_R4, 1), VT_R4, -1],
        [v(VT_DATE, -1), VT_DATE, 1],
        [v(VT_R8, 1), VT_R8, -1],
        [v(VT_BSTR, '-1'), VT_R8, 1],
        [v(VT_EMPTY), VT_I2, 0],
        [v(VT_CY, -10000), VT_CY, 1],
        [v(VT_DECIMAL, { value: -1n, scale: 0 }), VT_DECIMAL, 1],
    ]);
    for (const [operand, type, value] of cases)
    {
        assert.deepEqual(seen(negate(operand)), [type, value], `${operand.type}`);
    }
    assert.equal(typeIn(negate(v(VT_NULL))), VT_NULL);
    for (const type of [VT_I1, VT_UI2, VT_UI4, VT_UI8, VT_INT, VT_UINT])
    {
        assert.equal(negate(v(type, 1)), DISP_E_BADVARTYPE, `${type}`);
    }
    for (const type of [VT_UNKNOWN, VT_DISPATCH, VT_ERROR, VT_RECORD])
    {
        assert.equal(negate(v(type)), DISP_E_TYPEMISMATCH, `${type}`);
    }
    assert.equal(negate(v(VT_CY, -9223372036854775808n)), DISP_E_OVERFLOW);
});

test('a conversion to an integer rounds a half to the even neighbour', ()=>{
    // VarI4FromR8 on Windows (vartype.c).
    assert.deepEqual([-1.5, -0.6, -0.5, -0.4, 0.4, 0.5, 0.6, 1.5, 2.5].map(nearest),
        [-2, -1, 0, 0, 0, 0, 1, 2, 2]);
    assert.deepEqual(seen(integerDivide(v(VT_R8, 2.5), v(VT_I4, 1))), [VT_I4, 2]);
    assert.deepEqual(seen(integerDivide(v(VT_R8, 3.5), v(VT_I4, 1))), [VT_I4, 4]);
});

test('a flag or a type no variant holds is refused in the order each operator looks', ()=>{
    /** @param {number} type @param {number} flags */
    const flagged = (type, flags)=>variantValue(type, { flags });
    const array = flagged(VT_I4, VT_ARRAY);
    const nowhere = flagged(VT_I4, VT_BYREF);
    const VT_VOID = 24;
    // VarSub: an array either side is a mismatch, any other flag no type.
    assert.equal(subtract(array, v(VT_I4, 1)), DISP_E_TYPEMISMATCH);
    assert.equal(subtract(flagged(VT_EMPTY, VT_ARRAY | VT_VECTOR), v(VT_I4, 1)),
        DISP_E_TYPEMISMATCH);
    assert.equal(subtract(nowhere, v(VT_I4, 1)), DISP_E_BADVARTYPE);
    assert.equal(subtract(flagged(VT_I4, VT_RESERVED), v(VT_I4, 1)), DISP_E_BADVARTYPE);
    // A record is a mismatch on the right whatever is on the left.
    assert.equal(subtract(v(VT_VARIANT), v(VT_RECORD)), DISP_E_TYPEMISMATCH);
    assert.equal(subtract(v(VT_VOID), v(VT_RECORD)), DISP_E_TYPEMISMATCH);
    assert.equal(subtract(v(VT_RECORD), v(VT_I2, 1)), DISP_E_TYPEMISMATCH);
    assert.equal(subtract(v(VT_RECORD), v(VT_UI2, 1)), DISP_E_BADVARTYPE);
    assert.equal(subtract(v(VT_VOID), v(VT_I2, 1)), DISP_E_BADVARTYPE);
    // VarMod: an error code as the dividend is a mismatch before the divisor's
    // type is looked at; any flag is no type.
    assert.equal(modulo(v(VT_ERROR), v(VT_VOID)), DISP_E_TYPEMISMATCH);
    assert.equal(modulo(v(VT_VOID), v(VT_ERROR)), DISP_E_BADVARTYPE);
    assert.equal(modulo(v(VT_I4, 1), v(VT_VOID)), DISP_E_BADVARTYPE);
    assert.equal(modulo(v(VT_NULL), v(VT_VOID)), DISP_E_BADVARTYPE);
    assert.equal(modulo(v(VT_EMPTY), v(VT_RECORD)), DISP_E_TYPEMISMATCH);
    assert.equal(modulo(flagged(VT_EMPTY, VT_ARRAY), v(VT_I4, 1)), DISP_E_BADVARTYPE);
    // VarNot: a flag on a type that is one is a mismatch, on one that is not
    // no type at all.
    assert.equal(not(array), DISP_E_TYPEMISMATCH);
    assert.equal(not(nowhere), DISP_E_TYPEMISMATCH);
    assert.equal(not(flagged(VT_VOID, VT_ARRAY)), DISP_E_BADVARTYPE);
    assert.equal(not(flagged(VT_EMPTY, VT_BYREF)), DISP_E_BADVARTYPE);
    assert.equal(not(flagged(VT_I4, VT_VECTOR)), DISP_E_BADVARTYPE);
    assert.equal(not(v(72)), DISP_E_BADVARTYPE, 'VT_CLSID');
    assert.equal(typeof xor(array, v(VT_I4, 1)), 'number');
    assert.deepEqual([0, 14, 15, 16, 23, 24, 31, 36, 72].map(isOperandType),
        [true, true, false, true, true, false, false, true, false]);
});

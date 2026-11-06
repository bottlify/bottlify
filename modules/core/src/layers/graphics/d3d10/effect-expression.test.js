/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotAnExpression, parseExpression, runExpression } from './effect-expression.js';
import { expressionBinary } from './effect-fixtures.js';

const LIT = 1;
const IN = 2;
const OUT = 4;
const TMP = 7;

/** @param {number} value */
const bitsOf = value=>new Uint32Array(Float32Array.of(value).buffer)[0];
/** @param {Uint32Array} words */
const floatsOf = words=>[...new Float32Array(words.buffer, 0, 4)];

/**
 * Runs an expression over named variables' words.
 *
 * @param {import('./effect-fixtures.js').FixtureExpression} spec
 * @param {Record<string, number[]>} values
 */
const run = (spec, values)=>runExpression(parseExpression(expressionBinary(spec)),
    (name, words)=>(values[name]
        ? Uint32Array.from({ length: words }, (_, index)=>values[name][index] ?? 0)
        : null));

test('an expression reads its variables by register and runs float operations', ()=>{
    // -a + b.x * 2 with a scalar first input broadcast, after
    // test_effect_value_expression's p0: inputs a at register 0, b at 1.
    const spec = {
        inputs: [{ name: 'a', register: 0 }, { name: 'b', register: 1 }],
        literals: [bitsOf(2)],
        /** @type {import('./effect-fixtures.js').FixtureExpression['code']} */
        code: [
            [0x101, 4, false, [[IN, 0]], [TMP, 0]],
            [0x205, 4, true, [[LIT, 0], [IN, 4]], [TMP, 4]],
            [0x204, 4, false, [[TMP, 0], [TMP, 4]], [OUT, 0]],
        ],
    };
    const result = run(spec, {
        a: [1, 2, 3, 4].map(bitsOf), b: [0.5, 9, 9, 9].map(bitsOf),
    });
    assert.deepEqual(floatsOf(result), [0, 16, 15, 14]);
    assert.deepEqual(floatsOf(run(spec, { b: [1, 1, 1, 1].map(bitsOf) })), [2, 2, 2, 2],
        'a name the effect does not have reads zero');
});

test('a conversion, floor and ceil give the first component to every one', ()=>{
    // Windows's ceil(float4) of (1.1, -2.3, 3.5, -4.5) is 2 four times.
    const one = (/** @type {number} */ op)=>({
        inputs: [{ name: 'v', register: 0 }],
        /** @type {import('./effect-fixtures.js').FixtureExpression['code']} */
        code: [[op, 4, false, [[IN, 0]], [OUT, 0]]],
    });
    const v = { v: [1.1, -2.3, 3.5, -4.5].map(bitsOf) };
    assert.deepEqual(floatsOf(run(one(0x13a), v)), [2, 2, 2, 2]);
    assert.deepEqual(floatsOf(run(one(0x139), v)), [1, 1, 1, 1]);
    assert.deepEqual([...run(one(0x133), v)].slice(0, 4), [1, 1, 1, 1]);
    assert.deepEqual(floatsOf(run(one(0x104), v)).map(x=>Math.fround(x)),
        [1.1, -2.3, 3.5, -4.5].map(x=>Math.fround(Math.fround(x) - Math.floor(x))),
        'frc runs over each component');
    const ints = { v: [0, 1, 2, 3] };
    assert.deepEqual([...run(one(0x121), ints)].slice(0, 4),
        [0xffffffff, 0xfffffffe, 0xfffffffd, 0xfffffffc], 'not runs over each component');
    assert.deepEqual(floatsOf(run(one(0x130), { v: [0xffffffff, 7, 7, 7] })), [-1, -1, -1, -1]);
    assert.deepEqual([...run(one(0x137), { v: [bitsOf(NaN), 0, 0, 0] })].slice(0, 4),
        [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], 'NaN is true');
});

test('a logarithm is of the magnitude, and zero for zero', ()=>{
    const spec = {
        inputs: [{ name: 'v', register: 0 }],
        /** @type {import('./effect-fixtures.js').FixtureExpression['code']} */
        code: [0, 1, 2, 3].map(index=>[0x106, 1, false, [[IN, index]], [OUT, index]]),
    };
    assert.deepEqual(floatsOf(run(spec, { v: [4, -2, 0, 0.5].map(bitsOf) })), [2, 1, 0, -1]);
});

test('integer operations read the words signed or not as they say', ()=>{
    const pair = (/** @type {number} */ op)=>({
        inputs: [{ name: 'a', register: 0 }, { name: 'b', register: 1 }],
        /** @type {import('./effect-fixtures.js').FixtureExpression['code']} */
        code: [[op, 1, false, [[IN, 0], [IN, 4]], [OUT, 0]]],
    });
    /** @param {number} op @param {number} a @param {number} b */
    const of = (op, a, b)=>run(pair(op), { a: [a >>> 0], b: [b >>> 0] })[0];
    assert.equal(of(0x21a, 7, 0), 0xffffffff, 'a division by zero is all ones');
    assert.equal(of(0x21a, 7, 2), 3);
    assert.equal(of(0x210, -1, 1), 0xffffffff, 'ilt is signed');
    assert.equal(of(0x215, -1, 1), 0, 'ult is not');
    assert.equal(of(0x21e, -4, -3), (-3) >>> 0);
    assert.equal(of(0x220, -4, 3), (-4) >>> 0);
    assert.equal(of(0x219, -3, 5), (-15) >>> 0);
    assert.equal(of(0x235, -16, 2), (-4) >>> 0, 'ishr keeps the sign');
    assert.equal(of(0x236, -16, 2), 0x3ffffffc);
    assert.equal(of(0x234, 3, 33), 6, 'a shift counts modulo 32');
    assert.equal(of(0x233, 0x0f, 0xff), 0xf0);
});

test('movc picks by its first input, dot sums products', ()=>{
    const inputs = [{ name: 'a', register: 0 }, { name: 'b', register: 1 }];
    const a = [0, 1, 2, 3].map(bitsOf);
    const b = [4, 5, 6, 7].map(bitsOf);
    const movc = run({ inputs, code: [[0x301, 2, false, [[IN, 0], [IN, 4], [IN, 6]],
        [OUT, 0]]] }, { a, b });
    assert.deepEqual([...movc].slice(0, 2), [b[2], b[1]]);
    const dot = run({ inputs, code: [[0x500, 3, false, [[IN, 0], [IN, 4]], [OUT, 0]]] },
        { a, b });
    assert.equal(floatsOf(dot)[0], 0 * 4 + 1 * 5 + 2 * 6);
    const swizzled = run({ inputs, code: [[0x70e, 1, false,
        [[IN, 3], [IN, 2], [IN, 4], [IN, 5]], [OUT, 0]]] }, { a, b });
    assert.equal(floatsOf(swizzled)[0], 3 * 4 + 2 * 5);
});

test('what this runtime cannot run is said, not guessed', ()=>{
    assert.throws(()=>run({ code: [[0x7ff, 1, false, [[IN, 0]], [OUT, 0]]] }, {}),
        NotAnExpression);
    assert.throws(()=>parseExpression(Uint8Array.of(1, 2, 3)), NotAnExpression);
    const indexed = expressionBinary({ code: [[0x100, 1, false, [[IN, 0]], [OUT, 0]]] });
    // The first operand's relative index made non-zero.
    const view = new DataView(indexed.buffer);
    const fxlc = [...indexed].findIndex((_, at)=>String.fromCharCode(...indexed.subarray(at,
        at + 4)) === 'FXLC');
    view.setUint32(fxlc + 8 + 12, 1, true);
    assert.throws(()=>parseExpression(indexed), NotAnExpression);
});

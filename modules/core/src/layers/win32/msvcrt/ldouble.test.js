/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToExtended, extendedBytes, STRINGTOLD } from './ldouble.js';
import { createConversionFunctions } from './convert.js';
import { fakeMemory } from './harness.test.js';

/** Ten bytes, the ones given first and zeros after. @param {number[]} bytes */
const ten = bytes=>[...bytes, ...new Array(10 - bytes.length).fill(0)];

test('a decimal is the extended nearest it, out of range said so', ()=>{
    /** @type {[string, number, number, number[]][]} */
    const cases = [
        ['0', 1, STRINGTOLD.OK, []],
        ['nan', 0, STRINGTOLD.NONE, []],
        ['inf', 0, STRINGTOLD.NONE, []],
        ['-0.0', 4, STRINGTOLD.OK, ten([0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80])],
        ['1e0', 3, STRINGTOLD.OK, [0, 0, 0, 0, 0, 0, 0, 0x80, 0xff, 0x3f]],
        ['1.7976931348623158e+308', 23, STRINGTOLD.OK,
            [0xaf, 0xfb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0x43]],
        ['1.7976931348623159e+308', 23, STRINGTOLD.OK,
            [0xb1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0x43]],
        ['3.65e-4951', 10, STRINGTOLD.OK, [1]],
        ['1.82e-4951', 10, STRINGTOLD.OK, []],
        ['1e-99999', 8, STRINGTOLD.UNDERFLOW, []],
        ['1.18e+4932', 10, STRINGTOLD.OK,
            [0x25, 0x75, 0x06, 0x68, 0x8a, 0xf1, 0xe7, 0xfd, 0xfe, 0x7f]],
        ['1.19e+4932', 10, STRINGTOLD.OVERFLOW, [0, 0, 0, 0, 0, 0, 0, 0x80, 0xff, 0x7f]],
        ['1e+99999', 8, STRINGTOLD.OVERFLOW, [0, 0, 0, 0, 0, 0, 0, 0x80, 0xff, 0x7f]],
        ['  +12.5d1x', 9, STRINGTOLD.OK, [0, 0, 0, 0, 0, 0, 0, 0xfa, 0x05, 0x40]],
    ];
    for (const [text, end, status, bytes] of cases)
    {
        const answer = decimalToExtended(text);
        assert.equal(answer.end, end, `${text}: where it stops`);
        assert.equal(answer.status, status, `${text}: status`);
        assert.deepEqual([...answer.bytes], ten(bytes), `${text}: bytes`);
    }
});

test('every double\'s exact decimal reads back as that double, widened', ()=>{
    // A double is m * 2^e, whose decimal expansion is finite: m * 5^-e
    // digits before the point moves -e places. Read back, it is exact.
    const view = new DataView(new ArrayBuffer(8));
    let seed = 12345;
    const next = ()=>(seed = seed * 1103515245 + 12345 >>> 0);
    for (let i = 0; i < 300; i++)
    {
        view.setUint32(0, next(), true);
        view.setUint32(4, next() & 0x7fefffff, true);
        const bits = view.getBigUint64(0, true);
        const field = Number(bits >> 52n & 0x7ffn);
        if (field === 0)
        {
            continue;
        }
        const significand = bits & (1n << 52n) - 1n | 1n << 52n;
        const power = field - 1075;
        const text = power >= 0 ? `${significand << BigInt(power)}`
            : `${significand * 5n ** BigInt(-power)}e${power}`;
        const expected = extendedBytes(false, field - 1023 + 16383, significand << 11n);
        assert.deepEqual([...decimalToExtended(text).bytes], [...expected], text);
    }
});

test('__STRINGTOLD writes the value and where the reading stopped, and leaves errno', ()=>{
    const memory = fakeMemory();
    let errno = 0;
    const table = /** @type {Record<string, any>} */ (createConversionFunctions({
        ...memory, allocate: memory.allocate, errno: code=>{
            errno = code;
        } }));
    const value = memory.allocate(10);
    const end = memory.allocate(4);
    const text = memory.put('1e0 rest');
    assert.equal(table.__STRINGTOLD.argBytes, 16);
    assert.equal(table.__STRINGTOLD.handler([value, end, text, 0]), 0);
    assert.deepEqual([...memory.bytes.subarray(value, value + 10)],
        [0, 0, 0, 0, 0, 0, 0, 0x80, 0xff, 0x3f]);
    assert.equal(memory.u32(end), text + 3);
    const none = memory.put('nan');
    assert.equal(table.__STRINGTOLD.handler([value, end, none, 0]), STRINGTOLD.NONE);
    assert.equal(memory.u32(end), none);
    assert.equal(table.__STRINGTOLD.handler([value, 0, memory.put('1e99999'), 0]),
        STRINGTOLD.OVERFLOW, 'no end is asked for');
    assert.equal(errno, 0);
});

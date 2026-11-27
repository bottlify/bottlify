/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitsFloat, floatBits, fromHalf, toHalf } from './floats.js';

test('floatBits is the nearest single\'s bits, signed zeros, infinities and subnormals kept', ()=>{
    assert.equal(floatBits(1), 0x3f800000);
    assert.equal(floatBits(-2.5), 0xc0200000);
    assert.equal(floatBits(0), 0);
    assert.equal(floatBits(-0), 0x80000000);
    assert.equal(floatBits(Infinity), 0x7f800000);
    assert.equal(floatBits(-Infinity), 0xff800000);
    assert.equal(floatBits(2 ** -149), 1);
    assert.equal(floatBits(0.1), 0x3dcccccd);
    assert.equal(floatBits(3.4028234663852886e38), 0x7f7fffff);
    assert.equal(floatBits(1e39), 0x7f800000);
});

test('every NaN is the one positive quiet NaN, whatever bits it came from', ()=>{
    assert.equal(floatBits(NaN), 0x7fc00000);
    assert.equal(floatBits(-NaN), 0x7fc00000);
    assert.equal(floatBits(bitsFloat(0xffc00001)), 0x7fc00000);
    assert.equal(floatBits(0 / 0), 0x7fc00000);
});

test('bitsFloat reads the bits back, signed zero and NaN included', ()=>{
    for (const bits of [0x3f800000, 0x80000000, 0x7f800000, 0x00000001, 0x7f7fffff])
    {
        assert.equal(floatBits(bitsFloat(bits)), bits);
    }
    assert.ok(Number.isNaN(bitsFloat(0x7fc00000)));
    assert.ok(Object.is(bitsFloat(0x80000000), -0));
    assert.equal(bitsFloat(0x1_3f800000), 1, 'only the low 32 bits');
});

test('toHalf: zeros, ones, the largest half and past it', ()=>{
    assert.equal(toHalf(0), 0);
    assert.equal(toHalf(-0), 0x8000);
    assert.equal(toHalf(1), 0x3c00);
    assert.equal(toHalf(-2), 0xc000);
    assert.equal(toHalf(65504), 0x7bff);
    assert.equal(toHalf(65519), 0x7bff, 'under the halfway to 65536 stays');
    assert.equal(toHalf(65520), 0x7c00, 'the halfway rounds to even: the infinity');
    assert.equal(toHalf(1e6), 0x7c00);
    assert.equal(toHalf(-Infinity), 0xfc00);
    assert.equal(toHalf(NaN), 0x7e00);
    assert.equal(toHalf(-NaN), 0x7e00);
});

test('toHalf rounds a tie to even, in normals and subnormals', ()=>{
    assert.equal(toHalf(1 + 2 ** -11), 0x3c00, 'halfway between 0x3c00 and 0x3c01');
    assert.equal(toHalf(1 + 3 * 2 ** -11), 0x3c02, 'halfway between 0x3c01 and 0x3c02');
    assert.equal(toHalf(1 + 2 ** -11 + 2 ** -20), 0x3c01, 'past halfway');
    assert.equal(toHalf(2 ** -24), 1, 'the smallest subnormal');
    assert.equal(toHalf(2 ** -25), 0, 'halfway to it: even');
    assert.equal(toHalf(3 * 2 ** -25), 2, 'halfway between 1 and 2: even');
    assert.equal(toHalf(-(2 ** -26)), 0x8000);
    assert.equal(toHalf(1023 * 2 ** -24 + 2 ** -25), 0x400,
        'the largest subnormal rounds into a normal');
});

test('toHalf counts every bit below the halfway, not only those of the first shift', ()=>{
    // 2^-25 (1 + 2^-15): just over halfway to the smallest subnormal. A
    // conversion that shifts the significand down before it rounds loses the
    // bit that says so and answers zero.
    assert.equal(toHalf(2 ** -25 * (1 + 2 ** -15)), 1);
    assert.equal(toHalf(3 * 2 ** -25 * (1 + 2 ** -20)), 2);
    assert.equal(toHalf(2 ** -16 * (1 + 2 ** -9 + 2 ** -22)), 0x0101);
});

test('fromHalf: every class of half', ()=>{
    assert.equal(fromHalf(0x3c00), 1);
    assert.equal(fromHalf(0xc000), -2);
    assert.equal(fromHalf(0x7bff), 65504);
    assert.equal(fromHalf(0x0001), 2 ** -24);
    assert.equal(fromHalf(0x03ff), 1023 * 2 ** -24);
    assert.equal(fromHalf(0x0400), 2 ** -14);
    assert.ok(Object.is(fromHalf(0x8000), -0));
    assert.equal(fromHalf(0x7c00), Infinity);
    assert.equal(fromHalf(0xfc00), -Infinity);
    assert.ok(Number.isNaN(fromHalf(0x7e00)));
    assert.ok(Number.isNaN(fromHalf(0xfc01)));
});

test('a half survives toHalf of fromHalf, every one of them', ()=>{
    for (let bits = 0; bits < 0x10000; bits++)
    {
        const back = toHalf(fromHalf(bits));
        if ((bits & 0x7c00) === 0x7c00 && (bits & 0x3ff) !== 0)
        {
            assert.equal(back, 0x7e00);
            continue;
        }
        if (back !== bits)
        {
            assert.fail(`0x${bits.toString(16)} came back as 0x${back.toString(16)}`);
        }
    }
});

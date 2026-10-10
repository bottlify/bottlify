/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHalf, halvesToStored, storedToHalves, toHalf } from './half.js';

test('a half holds what binary16 holds: the ends, the subnormals, and rounds to nearest', ()=>{
    /** @type {[number, number][]} */
    const exact = [[0, 0x0000], [1, 0x3c00], [-1, 0xbc00], [0.5, 0x3800], [65504, 0x7bff],
        [2 ** -14, 0x0400], [2 ** -24, 0x0001], [Infinity, 0x7c00], [-Infinity, 0xfc00]];
    for (const [value, bits] of exact)
    {
        assert.equal(toHalf(value), bits, String(value));
        assert.equal(fromHalf(bits), value, `0x${bits.toString(16)}`);
    }
    // Beyond the largest half: infinity. Below the smallest subnormal: zero.
    assert.equal(toHalf(1e6), 0x7c00);
    assert.equal(toHalf(1e-9), 0);
    // 0.1 is 0x2e66 to the nearest; a value between two halves goes to the nearer.
    assert.equal(toHalf(0.1), 0x2e66);
    assert.equal(toHalf(0.333), 0x3554);
    assert.ok(Number.isNaN(fromHalf(toHalf(NaN))));
});

/** @param {number[]} halves @returns {Uint8Array} */
const halfBytes = halves=>new Uint8Array(Uint16Array.from(halves).buffer);
/** @param {Uint8Array} bytes @returns {number[]} */
const asHalves = bytes=>[...new Uint16Array(bytes.slice().buffer)];

test('a wide format\'s channels become halves: as they lie, rounded, or as a fraction\'s value',
    ()=>{
        assert.deepEqual(asHalves(storedToHalves('half', halfBytes([0x3c00, 0xc000, 0x7bff]), 3)),
            [0x3c00, 0xc000, 0x7bff]);
        // At an odd offset in guest memory, as a level inside a larger block lies.
        const floats = new Uint8Array(1 + 16);
        new DataView(floats.buffer).setFloat32(1, 1, true);
        new DataView(floats.buffer).setFloat32(5, -2, true);
        new DataView(floats.buffer).setFloat32(9, 0.1, true);
        new DataView(floats.buffer).setFloat32(13, 1e6, true);
        assert.deepEqual(asHalves(storedToHalves('float', floats.subarray(1), 4)),
            [0x3c00, 0xc000, 0x2e66, 0x7c00]);
        const fractions = new Uint8Array(Uint16Array.from([0, 0xffff, 0x8000, 1]).buffer);
        assert.deepEqual(asHalves(storedToHalves('unorm16', fractions, 4)),
            [0, 0x3c00, toHalf(0x8000 / 0xffff), toHalf(1 / 0xffff)]);
    });

test('halves go back to a wide format\'s channels, a fraction clamped and NaN as zero', ()=>{
    assert.deepEqual(asHalves(halvesToStored('half', halfBytes([0x3c00, 0x8001]), 2)),
        [0x3c00, 0x8001]);
    const floats = halvesToStored('float', halfBytes([0x3c00, 0xc000, 0x7c00, 0x0001]), 4);
    assert.deepEqual([...new Float32Array(floats.buffer)], [1, -2, Infinity, 2 ** -24]);
    // 1, 0.5, 2, -1, NaN, and the largest half below one.
    const fractions = halvesToStored('unorm16',
        halfBytes([0x3c00, 0x3800, 0x4000, 0xbc00, 0x7e00, 0x3bff]), 6);
    assert.deepEqual([...new Uint16Array(fractions.buffer)],
        [0xffff, 0x8000, 0xffff, 0, 0, Math.round((1 - 2 ** -11) * 0xffff)]);
});

test('a 16-bit fraction through a half comes back within 1/4096, and exact below 1/64', ()=>{
    const every = Uint16Array.from({ length: 0x10000 }, (_, value)=>value);
    const back = new Uint16Array(halvesToStored('unorm16',
        storedToHalves('unorm16', new Uint8Array(every.buffer), every.length), every.length)
        .buffer);
    let worst = 0;
    for (let value = 0; value < every.length; value++)
    {
        const error = Math.abs(back[value] - value);
        worst = Math.max(worst, error);
        if (value < 1024)
        {
            assert.equal(error, 0, `fraction ${value} comes back as it went`);
        }
    }
    assert.ok(worst <= 16, `the worst fraction is ${worst} steps of 65535 away`);
    assert.ok(worst > 1, 'and above 1/64 a half is the coarser of the two');
});

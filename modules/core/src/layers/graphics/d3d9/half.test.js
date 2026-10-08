/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHalf, toHalf } from './half.js';

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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compareExact, decimalBytes, exactOf, fitDecimal, readDecimal, round, roundNumber, toNumber,
} from './varmath.js';

test('a double becomes the decimal its fifteen digits spell', ()=>{
    assert.deepEqual(exactOf(1.5), { value: 15n, scale: 1 });
    assert.deepEqual(exactOf(-0.1), { value: -1n, scale: 1 });
    assert.deepEqual(exactOf(1e20), { value: 100000000000000000000n, scale: 0 });
    assert.equal(exactOf(Infinity), null);
    assert.equal(toNumber({ value: -1449n, scale: 3 }), -1.449);
});

test('rounding takes a half to the even neighbour, on the decimal and not the binary', ()=>{
    assert.deepEqual(round({ value: 1451n, scale: 3 }, 1), { value: 15n, scale: 1 });
    assert.deepEqual(round({ value: 25n, scale: 1 }, 0), { value: 2n, scale: 0 });
    assert.deepEqual(round({ value: -35n, scale: 1 }, 0), { value: -4n, scale: 0 });
    assert.equal(roundNumber(1.23456, 3), 1.235);
    assert.equal(roundNumber(-1.449, 1), -1.4);
    assert.deepEqual(round({ value: 5n, scale: 0 }, 2), { value: 5n, scale: 0 }, 'nothing to cut');
});

test('a DECIMAL goes out and comes back through its sixteen bytes', ()=>{
    const exact = { value: -((1n << 70n) + 12345n), scale: 5 };
    const bytes = new Uint8Array(16);
    bytes.set(/** @type {Uint8Array} */ (decimalBytes(exact)), 2);
    assert.deepEqual(readDecimal(bytes), exact);
    assert.equal(decimalBytes({ value: 1n << 96n, scale: 0 }), null, 'past 96 bits');
    assert.equal(compareExact({ value: 15n, scale: 1 }, { value: 150n, scale: 2 }), 0);
    assert.equal(compareExact({ value: -1n, scale: 0 }, { value: 1n, scale: 4 }), -1);
});

test('a DECIMAL keeps 28 places at most, and gives up places before it overflows', ()=>{
    assert.deepEqual(fitDecimal({ value: 15n, scale: 1 }), { value: 15n, scale: 1 }, 'as it is');
    assert.deepEqual(fitDecimal({ value: 10n ** 30n + 5n, scale: 30 }),
        { value: 10n ** 28n, scale: 28 });
    // 79228162514264337593543950335 is the largest DECIMAL: a tenth more is
    // cut to it, and a half more rounds to the even neighbour past it.
    assert.deepEqual(fitDecimal({ value: 792281625142643375935439503354n, scale: 1 }),
        { value: 79228162514264337593543950335n, scale: 0 });
    assert.equal(fitDecimal({ value: 792281625142643375935439503355n, scale: 1 }), null);
    assert.equal(fitDecimal({ value: 1n << 96n, scale: 0 }), null, 'past 96 bits whole');
    assert.deepEqual(fitDecimal({ value: -25n, scale: 30 }), { value: 0n, scale: 28 },
        'rounded from the number, not from an earlier rounding');
});

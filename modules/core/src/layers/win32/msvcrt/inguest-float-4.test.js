/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The UCRT's classifiers in the guest (`_dclass`, `_fdclass`, `_dtest`,
 * `_fdtest`, `_dsign`, `_fdsign`): their x86 and x86-64 against their
 * JavaScript, and each class the one C names for the kind of value, over
 * zeros, denormals, normals, infinities and NaNs of both signs, signalling
 * ones among them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-float.x86.js';
import * as sources from './inguest-float.js';
import { DATA, doubleWords, equivalence } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

/** FP_INFINITE, FP_NAN, FP_NORMAL, FP_SUBNORMAL and FP_ZERO, as the short the caller reads. */
const INFINITE = 1;
const NAN = 2;
const NORMAL = 0xffff;
const SUBNORMAL = 0xfffe;
const ZERO = 0;

/** A double's dwords, high first, with the class C gives it. @type {[number, number, number][]} */
const DOUBLES = [
    [0, 0, ZERO], [0x80000000, 0, ZERO], [0, 1, SUBNORMAL], [0x800fffff, 0xffffffff, SUBNORMAL],
    [0x00100000, 0, NORMAL], [0x3ff00000, 0, NORMAL], [0xffefffff, 0xffffffff, NORMAL],
    [0x7ff00000, 0, INFINITE], [0xfff00000, 0, INFINITE], [0x7ff80000, 0, NAN],
    [0x7ff00000, 1, NAN], [0xfff40000, 0, NAN],
];

/** A float's bits with its class. @type {[number, number][]} */
const FLOATS = [
    [0, ZERO], [0x80000000, ZERO], [1, SUBNORMAL], [0x807fffff, SUBNORMAL], [0x00800000, NORMAL],
    [0x3f800000, NORMAL], [0xff7fffff, NORMAL], [0x7f800000, INFINITE], [0xff800000, INFINITE],
    [0x7fc00000, NAN], [0x7f800001, NAN], [0xffa00000, NAN],
];

test('_dclass, _dtest and _dsign: the class and the sign of every kind of double', ()=>{
    for (const [high, low, kind] of DOUBLES)
    {
        const memory = /** @type {[number, number[]][]} */ ([[DATA, [low, low >>> 8, low >>> 16,
            low >>> 24, high, high >>> 8, high >>> 16, high >>> 24].map(b=>b & 0xff)]]);
        const value = new DataView(Uint32Array.of(low, high).buffer).getFloat64(0, true);
        const stack = Number.isNaN(value) ? [low, high] : doubleWords(value);
        assert.equal(same('_dclass', { stack }).eax, kind, `_dclass of ${high.toString(16)}`);
        assert.equal(same('_dtest', { stack: [DATA], memory }).eax, kind);
        assert.equal(same('_dsign', { stack }).eax, high >>> 31 === 1 ? 0x8000 : 0);
    }
});

test('_fdclass, _fdtest and _fdsign: the class and the sign of every kind of float', ()=>{
    for (const [bits, kind] of FLOATS)
    {
        const memory = /** @type {[number, number[]][]} */ ([[DATA, [bits, bits >>> 8,
            bits >>> 16, bits >>> 24].map(b=>b & 0xff)]]);
        assert.equal(same('_fdclass', { stack: [bits] }).eax, kind,
            `_fdclass of ${bits.toString(16)}`);
        assert.equal(same('_fdtest', { stack: [DATA], memory }).eax, kind);
        assert.equal(same('_fdsign', { stack: [bits] }).eax, bits >>> 31 === 1 ? 0x8000 : 0);
    }
});

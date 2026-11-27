/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CORPUS_LAYOUT, diffCase, doubleBits, doublesOf, fillData, imageOfDouble, loadX86Corpus,
    statusAfter,
} from './x86-corpus.js';

test('an 80-bit value rounds to the double nearest it, and names the other at a tie', ()=>{
    for (const value of [1, -2.5, Math.PI, 2 ** -1074, -(2 ** -1030), 1e308, -0, Infinity])
    {
        const { nearest, tie } = doublesOf(imageOfDouble(doubleBits(value)));
        assert.equal(nearest, doubleBits(value), String(value));
        assert.equal(tie, null);
    }
    // 1 + 2^-53 lies halfway between 1 and the next double: even is 1.
    const half = 0x3fffn << 64n | 1n << 63n | 1n << 10n;
    assert.deepEqual(doublesOf(half), { nearest: doubleBits(1), tie: doubleBits(1 + 2 ** -52) });
    // A bit past halfway is past the tie.
    assert.deepEqual(doublesOf(half | 1n), { nearest: doubleBits(1 + 2 ** -52), tie: null });
    // Past a double's range: infinity.
    assert.equal(doublesOf(0x43ffn << 64n | 1n << 63n).nearest, doubleBits(Infinity));
    // A NaN keeps its sign and its payload's high bits, quiet or not.
    const signalling = 0xffffn << 64n | 1n << 63n | 0x2345n << 40n;
    assert.equal(doublesOf(signalling).nearest, 0xfff0000000000000n | 0x2345n << 29n);
});

test('the condition codes an instruction leaves undefined follow the SDM table', ()=>{
    assert.equal(statusAfter('fadd', 0), 0x4700, 'C1 a rounding direction, the rest undefined');
    assert.equal(statusAfter('fcom', 0x4700), 0, 'a compare defines all four');
    assert.equal(statusAfter('fld', 0x4700), 0x4500, 'a load defines C1');
    assert.equal(statusAfter('fsin', 0), 0x4300, 'C2 says whether the operand was in range');
    assert.equal(statusAfter('add', 0x100), 0x100, 'an integer instruction leaves them');
});

test('the buffer is the runner\'s xorshift32 of the seed', ()=>{
    // x = 1: x ^= x << 13, x ^= x >>> 17, x ^= x << 5 gives 0x42021, low byte 0x21; and on.
    assert.deepEqual([...fillData(1, 4)], [0x21, 0x01, 0xc5, 0x4f]);
    assert.equal(fillData(7).length, CORPUS_LAYOUT.DATA_SIZE);
    assert.notDeepEqual(fillData(7, 16), fillData(8, 16));
});

test('every case of the committed corpus compares equal with itself, and a change is seen', ()=>{
    const cases = loadX86Corpus();
    assert.ok(cases.length >= 10000, `${cases.length} cases`);
    const one = cases.find(each=>each.fault === null && each.kind === null);
    assert.ok(one);
    const { expected } = one;
    const outcome = {
        fault: null, halted: true, regs: expected.regs.slice(), eflags: expected.eflags,
        x87: { control: expected.x87.control, status: expected.x87.status, top: expected.x87.top,
            empty: expected.x87.empty, bits: expected.x87.st.map(image=>doublesOf(image).nearest),
            exact: Array(8).fill(null) },
        mxcsr: expected.mxcsr, xmm: expected.xmm.slice(), data: expected.data.slice(),
    };
    assert.deepEqual(diffCase(one, outcome), []);
    // A flag the case leaves undefined is not compared; any other is.
    const flipped = { ...outcome, eflags: outcome.eflags ^ 0x1 };
    assert.equal(diffCase(one, flipped).length, (one.undefinedFlags & 0x1) !== 0 ? 0 : 1);
    outcome.data[17] ^= 1;
    assert.equal(diffCase(one, outcome).filter(d=>d.name.startsWith('mem')).length, 1);
    assert.equal(diffCase({ ...one, ignored: [[17, 1]] }, outcome).length, 0);
});

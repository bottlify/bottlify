/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { SITE, formRegion, guestOf, inlineReturns, sited } from '../region.js';
import { blockState, interpret } from '../interp.js';
import { Exit, planStructure } from './region.js';

const CODE = 0x1000;
const STACK = 0x8000;

/**
 * mov ecx, 5; call F; L: call F; dec ecx; jnz L; hlt; F: inc eax; ret -- a
 * function called once before a loop and once inside it.
 */
const TWICE = [
    0xb9, 5, 0, 0, 0,           // 0  mov ecx, 5
    0xe8, 9, 0, 0, 0,           // 5  call F
    0xe8, 4, 0, 0, 0,           // 10 L: call F
    0x49,                       // 15 dec ecx
    0x75, 0xf8,                 // 16 jnz L
    0xf4,                       // 18 hlt
    0x40,                       // 19 F: inc eax
    0xc3,                       // 20 ret
];
const F = CODE + 19;
const LOOP = CODE + 10;

/** @param {number[]} bytes */
const reader = bytes=>(/** @type {number} */ address)=>bytes[address - CODE] ?? 0;

test('a callee formed in is copied for each call of it past the first, each copy returning to'
    + ' its own call', ()=>{
    const region = formRegion(reader(TWICE), CODE, {});
    assert.deepEqual(region.blocks.map(block=>block.start),
        [CODE, LOOP, CODE + 15, CODE + 18, F]);
    // Formed in once, the callee's ret goes to both return addresses.
    assert.deepEqual(inlineReturns(region), new Map([[F, [LOOP, CODE + 15]]]));
    const with2 = sited(region);
    assert.deepEqual(with2.blocks.map(block=>block.start),
        [CODE, LOOP, CODE + 15, CODE + 18, F, F + SITE]);
    assert.deepEqual(with2.blocks.map(block=>block.exit.targets),
        [[F], [F + SITE], [LOOP, CODE + 18], [], [], []]);
    assert.deepEqual(inlineReturns(with2), new Map([[F, [LOOP]], [F + SITE, [CODE + 15]]]));
    assert.equal(guestOf(F + SITE), F);
    assert.equal(with2.blocks[5].instructions, region.blocks[4].instructions);
    // The region as formed is not written.
    assert.deepEqual(region.blocks.map(block=>block.exit.targets),
        [[F], [F], [LOOP, CODE + 18], [], []]);
    // With no room for the copy the callee stays one for both.
    assert.equal(sited(region, 0), region);
});

test('a loop that calls a function called before it too is a loop of its own blocks: the'
    + ' callee\'s copy is inside it, and the first call\'s callee outside', ()=>{
    const region = formRegion(reader(TWICE), CODE, {});
    /** @param {import('../region.js').Region} of  its loops, each as its blocks in order */
    const loopsOf = of=>{
        const { order, loops } = planStructure(of, inlineReturns(of));
        return [...loops].map(([lo, hi])=>order.slice(lo, hi + 1).map(at=>of.blocks[at].start));
    };
    // One callee for both: the first call comes into the loop through the callee, which
    // is the loop's head for it, and the loop's own first block is inside.
    assert.deepEqual(loopsOf(region), [[F, CODE + 15, LOOP]]);
    assert.deepEqual(loopsOf(sited(region)), [[LOOP, F + SITE, CODE + 15]]);
});

test('a region with a callee\'s copies runs as the interpreter runs it, from every budget, and'
    + ' has no label for a copy', ()=>{
    const m = createTestMachine();
    m.write(CODE, TWICE);
    m.setReg('esp', STACK);
    const unit = m.translate(CODE);
    assert.deepEqual([...unit.translation.labels.keys()].sort((a, b)=>a - b),
        [CODE, LOOP, CODE + 15, CODE + 18, F]);
    const exit = unit.run(CODE, 1000);
    assert.equal(exit.kind, Exit.HALT);
    assert.equal(m.reg('eax'), 6);
    assert.equal(m.reg('ecx'), 0);
    assert.equal(m.reg('esp'), STACK);
    // mov, call + inc + ret, five turns of call + inc + ret + dec + jnz, hlt.
    assert.equal(m.counter(), 1 + 3 + 5 * 5 + 1);
    for (let budget = 1; budget <= 30; budget++)
    {
        const one = createTestMachine();
        one.write(CODE, TWICE);
        one.setReg('esp', STACK);
        const translated = one.translate(CODE);
        const left = translated.run(CODE, budget);
        const reference = createTestMachine();
        reference.write(CODE, TWICE);
        reference.setReg('esp', STACK);
        new DataView(reference.memory.buffer).setUint32(reference.layout.eip, CODE, true);
        const state = blockState({ memory: reference.memory, layout: reference.layout });
        state.syncIn();
        interpret(state, one.counter());
        state.syncOut();
        assert.deepEqual([one.eip(), one.reg('eax'), one.reg('ecx'), one.reg('esp')],
            [reference.eip(), reference.reg('eax'), reference.reg('ecx'), reference.reg('esp')],
            `budget ${budget}, left by ${left.kind} after ${one.counter()}`);
    }
});

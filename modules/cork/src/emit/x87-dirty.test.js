/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The registers a region writes back are the ones the way it took wrote: a
 * block marks what it writes in the dirty mask once, where it flushes what it
 * knows of the stack, so an exit inside the block -- before that flush -- must
 * still carry the block's marks, and a register only another way wrote keeps
 * the bytes the state block had.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { Exit } from './region.js';

const CODE = 0x1000;

/**
 * Runs `program` translated from CODE to its first exit, the x87 stack empty
 * but for register 7, which holds `sentinel` as an empty register's bytes.
 *
 * @param {number[]} program @param {number} eax @param {number} sentinel
 */
function run(program, eax, sentinel){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, 0xff);
    view.setUint16(m.layout.x87Control, 0x37f, true);
    view.setFloat64(m.layout.x87 + 7 * 16, sentinel, true);
    m.write(CODE, program);
    m.setReg('esp', 0x80000);
    m.setReg('eax', eax);
    const exit = m.translate(CODE).run(CODE, 1_000_000);
    return {
        exit,
        top: view.getUint8(m.layout.x87Top),
        empty: view.getUint8(m.layout.x87Empty),
        /** @param {number} k */
        register: k=>view.getFloat64(m.layout.x87 + k * 16, true),
    };
}

test('registers written in a block reach the state block at a fault inside that block', ()=>{
    // fld1; fld1; faddp; fadd st0, st0; xor ecx, ecx; div ecx -- the divide faults before
    // the block's end, where its marks would otherwise be written.
    const { exit, top, empty, register } = run([
        0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xc1, 0xd8, 0xc0, 0x31, 0xc9, 0xf7, 0xf1,
    ], 0, 0);
    assert.equal(exit.kind, Exit.FAULT);
    assert.equal(exit.vector, 0);
    assert.equal(top, 7);
    assert.equal(empty, 0x7f, 'register 7 held, the rest empty');
    assert.equal(register(7), 4, 'ST0: (1 + 1) doubled');
    assert.equal(register(6), 1, 'the popped register keeps its last value, as the processor');
});

test('a register only the other way wrote keeps the bytes the state block had', ()=>{
    // test eax, eax; jz skip; fld1; fstp st0; skip: xor ecx, ecx; div ecx
    const program = [
        0x85, 0xc0, 0x74, 0x04, 0xd9, 0xe8, 0xdd, 0xd8, 0x31, 0xc9, 0xf7, 0xf1,
    ];
    const skipped = run(program, 0, 1234.5);
    assert.equal(skipped.exit.kind, Exit.FAULT);
    assert.equal(skipped.empty, 0xff);
    assert.equal(skipped.register(7), 1234.5, 'not written on the way taken');
    const taken = run(program, 1, 1234.5);
    assert.equal(taken.exit.kind, Exit.FAULT);
    assert.equal(taken.empty, 0xff, 'pushed and popped');
    assert.equal(taken.register(7), 1, 'the pop leaves the value, as the processor');
});

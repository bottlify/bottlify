/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier on the integer set: the decoder of 2.1 and the
 * evaluator of 2.2 run one instruction at a time over a memory, a budget
 * bounding a run that does not halt, and the state block reached directly so
 * what a program leaves is what the translator would leave.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, blockState } from './interp.js';
import { createState } from './ir.js';
import { ownLayout, pagesFor, Tables } from './runtime/layout.js';

/** A little machine and a state over it. */
function machine(){
    const ram = new Uint8Array(0x10000);
    const view = new DataView(ram.buffer);
    const memory = {
        /** @param {number} address @param {number} size */
        read: (address, size)=>size === 1 ? ram[address]
            : size === 2 ? view.getUint16(address, true) : view.getUint32(address, true),
        /** @param {number} address @param {number} size @param {number} value */
        write: (address, size, value)=>{
            if (size === 1)
            {
                ram[address] = value;
            }
            else if (size === 2)
            {
                view.setUint16(address, value, true);
            }
            else
            {
                view.setUint32(address, value, true);
            }
        },
    };
    const state = createState(memory, { eip: 0x1000, esp: 0xf000 });
    return { ram, state };
}

test('the interpreter runs integer instructions and halts', ()=>{
    // mov eax, 5; add eax, 3; hlt
    const m = machine();
    m.ram.set([0xb8, 5, 0, 0, 0, 0x83, 0xc0, 0x03, 0xf4], 0x1000);
    const retired = interpret(m.state, 100);
    assert.equal(retired, 3);
    assert.equal(m.state.reg[0], 8);
    assert.equal(m.state.halted, true);
});

test('a budget bounds a loop', ()=>{
    // mov ecx, 4; L: dec ecx; jnz L; hlt
    const m = machine();
    m.ram.set([0xb9, 4, 0, 0, 0, 0x49, 0x75, 0xfd, 0xf4], 0x1000);
    const retired = interpret(m.state, 2);
    assert.equal(retired, 2, 'the budget stopped it mid-loop');
    assert.equal(m.state.reg[1], 3, 'after the first dec');
    const rest = interpret(m.state, 100);
    assert.equal(m.state.halted, true, 'and it finishes when given the budget');
    assert.equal(m.state.reg[1], 0);
    assert.equal(rest, 8, 'the three more turns and the hlt');
});

test('an instruction with no model throws Unsupported', ()=>{
    // A form the evaluator leaves to the other executor: fxsave.
    const m = machine();
    m.ram.set([0x0f, 0xae, 0x00], 0x1000); // fxsave [eax]
    // `evaluate` counts and advances before it decides it has no case; the
    // host answers the throw for the instruction, not for the count.
    assert.throws(()=>interpret(m.state, 1), /no model for/);
});

test('blockState runs over cork\'s own state block', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    // mov eax, 0x1234; inc eax; hlt
    ram.set([0xb8, 0x34, 0x12, 0, 0, 0x40, 0xf4], 0x1000);
    const state = blockState({ memory, layout });
    state.eip = 0x1000;
    const retired = interpret(state, 100);
    assert.equal(retired, 3);
    const reg32 = new Int32Array(memory.buffer, layout.regs, 8);
    assert.equal(reg32[0] >>> 0, 0x1235);
    const view = new DataView(memory.buffer);
    assert.equal(view.getUint32(layout.eip, true), 0x1007);
});

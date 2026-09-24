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
import { Fault, interpret, blockState } from './interp.js';
import { createState } from './ir.js';
import { ownLayout, pagesFor, Tables } from './runtime/layout.js';
import { PageFlag } from './runtime/pages.js';

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

test('code rewritten in place is decoded again, not answered from the cache', ()=>{
    // mov eax, 5; hlt -- run, then the immediate rewritten to 9 and run again.
    const m = machine();
    m.ram.set([0xb8, 5, 0, 0, 0, 0xf4], 0x1000);
    interpret(m.state, 100);
    assert.equal(m.state.reg[0], 5);
    m.ram[0x1001] = 9;
    m.state.eip = 0x1000;
    m.state.halted = false;
    interpret(m.state, 100);
    assert.equal(m.state.reg[0], 9);
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

test('onStep says which starts a jump reached, and a resumed run starts mid-block', ()=>{
    // mov ecx, 2; L: dec ecx; jnz L; hlt
    const m = machine();
    m.ram.set([0xb9, 2, 0, 0, 0, 0x49, 0x75, 0xfd, 0xf4], 0x1000);
    /** @type {string[]} */
    const seen = [];
    /** @param {number} at @param {boolean} jumped */
    const onStep = (at, jumped)=>seen.push(`${at.toString(16)}${jumped ? '*' : ''}`);
    interpret(m.state, 2, { onStep });
    interpret(m.state, 100, { onStep });
    // The second run begins at the jnz, where the first stopped: not a jump's
    // target; the loop's head is, the second time round.
    assert.deepEqual(seen, ['1000', '1005', '1006', '1005*', '1006', '1008']);
    /** @type {boolean[]} */
    const entered = [];
    m.state.eip = 0x1005;
    m.state.halted = false;
    interpret(m.state, 1, { onStep: (at, jumped)=>entered.push(jumped), entered: true });
    assert.deepEqual(entered, [true], 'a run entered at a jump target counts its first start');
});

test('xorps xors the two XMM operands and movd reaches a register', ()=>{
    // movd xmm0, eax; movd xmm1, ecx; xorps xmm0, xmm1; movd eax, xmm0; hlt
    const m = machine();
    m.ram.set([
        0x66, 0x0f, 0x6e, 0xc0, 0x66, 0x0f, 0x6e, 0xc9, 0x0f, 0x57, 0xc1, 0x66, 0x0f, 0x7e, 0xc0,
        0xf4,
    ], 0x1000);
    m.state.reg[0] = 0xf0f0f0f0;
    m.state.reg[1] = 0x0ff00ff0;
    const retired = interpret(m.state, 100);
    assert.equal(retired, 5);
    assert.equal(m.state.reg[0] >>> 0, 0xff00ff00, 'the xor, not the and, in the low lane');
    assert.equal(m.state.xmm[0] >>> 0, 0xff00ff00, 'the xor in the register word');
    assert.equal(m.state.xmm[1], 0, 'and the upper words clear');
});

test('force runs the first instruction whatever shouldStop answers', ()=>{
    // mov eax, 7; inc eax; hlt
    const m = machine();
    m.ram.set([0xb8, 7, 0, 0, 0, 0x40, 0xf4], 0x1000);
    // A stop before the first instruction: nothing runs.
    assert.equal(interpret(m.state, 100, { shouldStop: ()=>true }), 0);
    assert.equal(m.state.reg[0], 0);
    // Forced, the first instruction runs and the stop applies from then on:
    // the host's progress guarantee for a turn that would retire nothing.
    assert.equal(interpret(m.state, 100, { shouldStop: ()=>true, force: true }), 1);
    assert.equal(m.state.reg[0] >>> 0, 7);
    assert.equal(interpret(m.state, 100, { shouldStop: ()=>true, force: true }), 1);
    assert.equal(m.state.reg[0] >>> 0, 8);
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

test('blockState faults on an inaccessible page and reports a code write', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const flags = new Uint8Array(
        memory.buffer, layout.tables + Tables.PAGE_FLAGS, Tables.PAGE_FLAGS_SIZE);
    const ranges = new Uint8Array(memory.buffer, layout.tables + Tables.CODE_RANGES, 1 << 21);
    /** @type {[number, number][]} */
    const writes = [];
    const state = blockState({
        memory, layout, onCodeWrite: (address, size)=>writes.push([address, size]),
    });
    // A #GP before the instruction, at the instruction's own address rather
    // than the next one `evaluate` leaves in eip.
    flags[0x30] = PageFlag.INACCESSIBLE;
    state.faultEip = 0x30000;
    assert.throws(()=>state.memory.read(0x30000, 1),
        e=>e instanceof Fault && e.vector === 13 && e.eip === 0x30000);
    assert.throws(()=>state.memory.write(0x30000, 4, 0),
        e=>e instanceof Fault && e.vector === 13);
    // A write into a page holding translated code reports it, so the caller
    // can invalidate; a write outside the code's granules does not.
    flags[0x40] = PageFlag.HAS_CODE;
    ranges[0x40 * 2] = 0;
    ranges[0x40 * 2 + 1] = 2;
    state.memory.write(0x40000, 4, 0x11223344);
    assert.deepEqual(writes, [[0x40000, 4]]);
    state.memory.write(0x40f00, 1, 0);
    assert.deepEqual(writes, [[0x40000, 4]], 'beside the code, no report');
});

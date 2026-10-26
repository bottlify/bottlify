/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The long-mode interpreter over cork's 64-bit state block: a program runs
 * from the block's RIP, leaves its registers in the block, stops at the trap
 * port with the value it wrote, and a fault leaves RIP at the instruction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_BLOCK_SIZE_64, ownLayout, pagesFor, tablesSize } from './runtime/layout.js';
import { Fault } from './ir.js';
import { blockState64, interpret64 } from './interp64.js';

const TRAP_PORT = 0xb077;
const CODE = 0x400000;
const STACK = 0x200000;

/**
 *     movabs rax, 0x1122334455667788
 *     mov ecx, 5
 * 1:  add rax, rcx
 *     dec rcx
 *     jnz 1b
 *     push rax
 *     pop r9
 *     mov qword ptr [rip + data], rax
 *     mov r11, rdx               ; the host stub's way of keeping the second argument
 *     mov edx, 0xb077
 *     mov eax, 7
 *     out dx, eax
 *     hlt
 * data: .quad 0
 */
const PROGRAM = '48b88877665544332211b9050000004801c848ffc975f85041594889050f0000004989d3'
    + 'ba77b00000b807000000eff40000000000000000';
const DATA = CODE + PROGRAM.length / 2 - 8;

/** A machine of 16 MiB with the program at CODE and RSP at STACK. */
function machine(){
    const layout = ownLayout({ ramSize: 16 << 20, ramBase: 0, bits: 64 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = new Uint8Array(memory.buffer);
    bytes.set(Buffer.from(PROGRAM, 'hex'), CODE);
    const view = new DataView(memory.buffer);
    view.setBigUint64(layout.regs + 4 * 8, BigInt(STACK), true);
    view.setBigUint64(layout.regs + 2 * 8, 0xfeedfacecafebeefn, true);
    view.setBigUint64(layout.eip, BigInt(CODE), true);
    view.setUint32(layout.eflags, 0x202, true);
    view.setUint32(layout.mxcsr, 0x1f80, true);
    const state = blockState64({ memory, layout, ports: { trapPort: TRAP_PORT,
        read: ()=>0, write: ()=>{} } });
    return { layout, memory, view, state };
}

test('the 64-bit state block holds every field inside its 1024 bytes', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20, ramBase: 0, bits: 64 });
    assert.equal(layout.bits, 64);
    for (const name of /** @type {const} */ (['regs', 'eip', 'eflags', 'x87', 'xmm', 'mxcsr',
        'fsBase', 'gsBase', 'counter', 'origin']))
    {
        const at = /** @type {number} */ (layout[name]) - layout.regs;
        assert.ok(at >= 0 && at < STATE_BLOCK_SIZE_64, name);
    }
    // Quadword fields sit on quadword boundaries, as a BigUint64Array reads them.
    for (const name of /** @type {const} */ (['regs', 'eip', 'fsBase', 'gsBase']))
    {
        assert.equal(/** @type {number} */ (layout[name]) % 8, 0, name);
    }
    assert.equal(layout.xmm + 16 * 16 <= layout.mxcsr, true);
    assert.notEqual(layout.id, ownLayout({ ramSize: 1 << 20, ramBase: 0 }).id);
});

test('a long-mode program runs over the block and stops at the trap port', ()=>{
    const { layout, view, state } = machine();
    state.syncIn();
    const retired = interpret64(state, 1000);
    state.syncOut();
    assert.deepEqual(state.trapped, [7]);
    // mov, mov, five turns of three, push, pop, store, mov, mov, mov, out.
    assert.equal(retired, 2 + 15 + 7);
    const sum = 0x1122334455667788n + 5n + 4n + 3n + 2n + 1n;
    assert.equal(view.getBigUint64(layout.regs + 9 * 8, true), sum, 'r9 popped');
    assert.equal(view.getBigUint64(DATA, true), sum, 'stored RIP-relative');
    assert.equal(view.getBigUint64(layout.regs + 11 * 8, true), 0xfeedfacecafebeefn,
        'r11 kept rdx');
    // A dword write zero-extends: the upper half of the sum is gone from rax.
    assert.equal(view.getBigUint64(layout.regs, true), 7n);
    assert.equal(view.getBigUint64(layout.regs + 4 * 8, true), BigInt(STACK));
    assert.equal(view.getBigUint64(layout.eip, true), BigInt(CODE + PROGRAM.length / 2 - 9),
        'past the out, at the hlt');
});

test('a fault leaves RIP at the faulting instruction and the registers as they were', ()=>{
    const { layout, view, state } = machine();
    // mov rax, [rcx] with rcx past the window.
    new Uint8Array(view.buffer).set([0x48, 0x8b, 0x01], CODE);
    view.setBigUint64(layout.regs + 8, 1n << 40n, true);
    state.syncIn();
    assert.throws(()=>interpret64(state, 10), error=>error instanceof Fault && error.vector === 13);
    assert.equal(state.rip, BigInt(CODE));
    assert.equal(view.getBigUint64(layout.regs + 8, true), 1n << 40n);
});

test('a jump begins a run the host is asked about', ()=>{
    const { state } = machine();
    /** @type {[number, boolean][]} */
    const steps = [];
    let asked = 0;
    state.syncIn();
    interpret64(state, 1000, {
        shouldStop: ()=>++asked > 3,
        onStep: (at, jumped)=>{
            steps.push([at - CODE, jumped]);
        },
    });
    // The first run, then the loop's back edge taken twice before the host says stop.
    assert.deepEqual(steps, [[0, false], [15, true], [15, true]]);
});

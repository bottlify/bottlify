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
import v8 from 'node:v8';
import { Fault } from './ir.js';
import { memory64 } from './wasm/features.js';
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

for (const window of [2 ** 33, 2 ** 34])
{
    test(`a ${window / 2 ** 30} GiB window: code, stack and data past 4 GiB, RAM apart`, ()=>{
        v8.setFlagsFromString('--experimental-wasm-memory64');
        // Where a 64-bit image without relocations asks to be (0x140000000), the stack past it.
        const code = 0x140001000;
        const stack = 0x150000000;
        const data = code + PROGRAM.length / 2 - 8;
        const layout = ownLayout({ ramSize: window - 4096, ramBase: 0, bits: 64, window });
        const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
        const ram = memory64(window);
        new Uint8Array(ram.buffer).set(Buffer.from(PROGRAM, 'hex'), code);
        const view = new DataView(memory.buffer);
        view.setBigUint64(layout.regs + 4 * 8, BigInt(stack), true);
        view.setBigUint64(layout.eip, BigInt(code), true);
        view.setUint32(layout.eflags, 0x202, true);
        view.setUint32(layout.mxcsr, 0x1f80, true);
        // The window's last page is closed, as a host keeps it.
        new Uint8Array(memory.buffer, layout.pageFlags)[window / 4096 - 1] = 1;
        const state = blockState64({ memory, ram, layout, ports: { trapPort: TRAP_PORT,
            read: ()=>0, write: ()=>{} } });
        state.syncIn();
        assert.equal(interpret64(state, 1000), 2 + 15 + 7);
        state.syncOut();
        assert.deepEqual(state.trapped, [7]);
        const sum = 0x1122334455667788n + 5n + 4n + 3n + 2n + 1n;
        assert.equal(view.getBigUint64(layout.regs + 9 * 8, true), sum, 'pushed and popped');
        assert.equal(new DataView(ram.buffer).getBigUint64(data, true), sum, 'RIP-relative');
        assert.equal(new DataView(ram.buffer).getBigUint64(stack - 8, true), sum, 'the stack');
        for (const [at, why] of /** @type {[number, string][]} */ ([[window - 8, 'the closed last page'],
            [window, 'past the window']]))
        {
            // mov rax, [rcx]
            new Uint8Array(ram.buffer).set([0x48, 0x8b, 0x01], code);
            view.setBigUint64(layout.regs + 8, BigInt(at), true);
            view.setBigUint64(layout.eip, BigInt(code), true);
            state.syncIn();
            assert.throws(()=>interpret64(state, 10),
                error=>error instanceof Fault && error.vector === 13, why);
        }
    });
}

test('pcmpistri leaves its index in rcx, zero-extended, as a dword written in long mode', ()=>{
    const { layout, view, state } = machine();
    const set = 0x500000;
    const text = 0x500100;
    new Uint8Array(view.buffer).set(Buffer.from('b\0'), set);
    new Uint8Array(view.buffer).set(Buffer.from('aab\0'), text);
    // mov rcx, 0xdeadbeefffffffff; movdqu xmm0, [rdi]; pcmpistri xmm0, [rsi], 0 (equal
    // any, bytes): the first byte of [rsi] in xmm0's set is at 2; hlt
    new Uint8Array(view.buffer).set([0x48, 0xb9, 0xff, 0xff, 0xff, 0xff, 0xef, 0xbe, 0xad, 0xde,
        0xf3, 0x0f, 0x6f, 0x07, 0x66, 0x0f, 0x3a, 0x63, 0x06, 0x00, 0xf4], CODE);
    view.setBigUint64(layout.regs + 7 * 8, BigInt(set), true);
    view.setBigUint64(layout.regs + 6 * 8, BigInt(text), true);
    state.syncIn();
    interpret64(state, 10);
    state.syncOut();
    assert.equal(view.getBigUint64(layout.regs + 8, true), 2n);
});

test('crc32 over a quadword and a byte is CRC-32C: "123456789" checks to 0xE3069283', ()=>{
    const { layout, view, state } = machine();
    const data = 0x500000;
    new Uint8Array(view.buffer).set(Buffer.from('123456789'), data);
    // mov eax, -1; crc32 rax, qword [rsi]; crc32 eax, byte [rsi + 8]; not eax; hlt
    new Uint8Array(view.buffer).set([0xb8, 0xff, 0xff, 0xff, 0xff,
        0xf2, 0x48, 0x0f, 0x38, 0xf1, 0x06, 0xf2, 0x0f, 0x38, 0xf0, 0x46, 0x08,
        0xf7, 0xd0, 0xf4], CODE);
    view.setBigUint64(layout.regs + 6 * 8, BigInt(data), true);
    state.syncIn();
    interpret64(state, 10);
    state.syncOut();
    assert.equal(view.getBigUint64(layout.regs, true), 0xe3069283n);
});

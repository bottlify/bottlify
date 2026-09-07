/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The context record against a real emulator.
 *
 * The unit tests prove the record carries every field. These prove the two
 * things only a real CPU can: that the lazy arithmetic flags survive, and that
 * an x87 thread interrupted by MMX comes back to its own numbers. Both failures
 * are silent -- no fault, no exception, just a wrong value later.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV86Host } from './v86-host.js';
import { captureContext, restoreContext } from './context.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);
const TRAP_PORT = 0xb077;
const ENTRY_VECTOR = 0x7000;
const GUEST_CODE = 0x8000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** `mov dx, TRAP_PORT; out dx, eax; hlt` — hand control back with EAX as the payload. */
const TRAP_AND_HALT = [0x66, 0xba, TRAP_PORT & 0xff, (TRAP_PORT >>> 8) & 0xff, 0xef, 0xf4];

async function boot(){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    return createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: TRAP_PORT,
        entryVector: ENTRY_VECTOR,
        initialStack: 0x300000,
    });
}

/**
 * Runs a guest program and resolves with the value it traps back.
 *
 * @param {any} host
 * @param {number[]} code
 * @param {number} [at]
 */
function run(host, code, at = GUEST_CODE){
    host.writePhysical(at, new Uint8Array(code));

    if (host.instructionCount() === 0)
    {
        // First program: the ROM reads the entry vector, once, coming out of reset.
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(at)));
    }
    else
    {
        // Every one after that: the guest is sitting on the `hlt` that ended the
        // previous program, and reset is long past, so the vector would never be
        // read again. Point the CPU at the new code and take it out of halt --
        // which is what resuming a thread will do in the scheduler, too.
        const cpu = host.cpu();
        cpu.instruction_pointer[0] = at;
        cpu.in_hlt[0] = 0;
    }

    return new Promise((resolve, reject)=>{
        const deadline = setTimeout(()=>{
            host.stop();
            reject(new Error('guest never trapped'));
        }, 5000);
        host.onTrap((/** @type {number} */ value)=>{
            clearTimeout(deadline);
            host.stop();
            resolve(value >>> 0);
        });
        host.run();
    });
}

test('an x87 thread survives being interrupted by MMX', async()=>{
    const host = await boot();
    const cpu = host.cpu();

    // Thread A: load pi and 1.0, add them, and leave the result on the x87 stack.
    // This leaves the stack pointer and the tag word in a state that means
    // something -- which is exactly what MMX is about to destroy.
    await run(host, [
        0xd9, 0xeb,             // fldpi
        0xd9, 0xe8,             // fld1
        0xde, 0xc1,             // faddp st(1), st(0)
        0xb8, ...u32(0xa11),    // mov eax, marker
        ...TRAP_AND_HALT,
    ]);

    const threadA = captureContext(cpu);
    assert.notEqual(threadA.fpuStackEmpty, 0x00, 'thread A has a live x87 stack');

    // Thread B: MMX. Every one of these instructions zeroes the tag word and the
    // stack pointer, because MMX registers are the same storage as x87.
    await run(host, [
        0x0f, 0xef, 0xc0,       // pxor mm0, mm0
        0x0f, 0x7f, 0x05, ...u32(0x9000), // movq [0x9000], mm0
        0xb8, ...u32(0xb22),    // mov eax, marker
        ...TRAP_AND_HALT,
    ], GUEST_CODE + 0x200);

    const afterMmx = captureContext(cpu);
    assert.equal(afterMmx.fpuStackPtr, 0, 'MMX reset the x87 stack pointer');
    assert.equal(afterMmx.fpuStackEmpty, 0x00, 'MMX marked every register live');

    // A full restore brings thread A's x87 state back...
    restoreContext(cpu, threadA);
    assert.equal(captureContext(cpu).fpuStackPtr, threadA.fpuStackPtr);
    assert.equal(captureContext(cpu).fpuStackEmpty, threadA.fpuStackEmpty);

    // ...while a restore that carries the eight registers but drops the two
    // bytes describing them leaves the CPU believing thread B's layout. No
    // fault is raised; the thread simply resumes onto the wrong stack.
    restoreContext(cpu, { ...threadA, fpuStackPtr: 0, fpuStackEmpty: 0x00 });
    const damaged = captureContext(cpu);
    assert.equal(damaged.fpuStackPtr, 0);
    assert.notEqual(damaged.fpuStackEmpty, threadA.fpuStackEmpty,
        'dropping the tag word is silent, which is why it is asserted here');
});

test('pending arithmetic flags survive a switch', async()=>{
    const host = await boot();
    const cpu = host.cpu();

    // Leave an overflow pending and unmaterialised: 0x7fffffff + 1.
    await run(host, [
        0xb8, ...u32(0x7fffffff), // mov eax, 0x7fffffff
        0x83, 0xc0, 0x01,         // add eax, 1        -> OF set, flags lazy
        ...TRAP_AND_HALT,
    ]);

    const saved = captureContext(cpu);
    assert.notEqual(saved.flagsChanged, 0, 'the flags really are still lazy');

    // The raw word alone is not the answer: what makes the flags reconstructable
    // is the operands travelling with it.
    assert.equal(saved.lastOp1, 0x7fffffff | 0);
    assert.equal(saved.lastResult, -0x80000000);

    await run(host, [
        0x31, 0xc0,               // xor eax, eax      -> different flag state
        ...TRAP_AND_HALT,
    ], GUEST_CODE + 0x200);

    restoreContext(cpu, saved);
    const restored = captureContext(cpu);
    assert.equal(restored.flags, saved.flags);
    assert.equal(restored.flagsChanged, saved.flagsChanged);
    assert.equal(restored.lastOp1, saved.lastOp1);
    assert.equal(restored.lastResult, saved.lastResult);
    assert.equal(restored.lastOpSize, saved.lastOpSize);
});

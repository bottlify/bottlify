/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The thread contexts under hybrid: a thread's loop runs translated, and
 * what `captureContext`/`restoreContext` see is the same x87 block and the
 * same flags the emulator's own run leaves, because every translated exit
 * wrote them back. The programs are `context.itest.js`'s; here they run
 * with the translator attached and their loops translated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV86Host } from './v86-host.js';
import { createHybridHost } from './hybrid-host.js';
import { captureContext, restoreContext } from './context.js';
import { TABLES_RESERVE } from '../engine.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);
const ENGINE = new URL('../../../../../cork/src/index.js', import.meta.url).href;
const TRAP_PORT = 0xb077;
const ENTRY_VECTOR = 0x7000;
const GUEST_CODE = 0x8000;
/** @param {number} value */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
const TRAP_AND_HALT = [0x66, 0xba, TRAP_PORT & 0xff, (TRAP_PORT >>> 8) & 0xff, 0xef, 0xf4];

async function boot(){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const emulator = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: TRAP_PORT,
        entryVector: ENTRY_VECTOR,
        initialStack: 0x300000,
    });
    const { createEngine } = await import(ENGINE);
    const cork = createEngine({
        memory: emulator.wasmMemory(),
        layout: emulator.stateLayout(TABLES_RESERVE),
        config: {},
        read: emulator.readByte,
        imports: { trap: ()=>0, getEflags: emulator.getEflags, x87Read: ()=>0, rdtsc: ()=>0n },
    });
    return { host: createHybridHost({ emulator, cork }), emulator, cork };
}

/**
 * Runs a program through slices of the hybrid host until it traps; the
 * program's entry is translated first so the whole of it runs translated.
 *
 * @param {Awaited<ReturnType<typeof boot>>} machine @param {number[]} code @param {number} [at]
 */
async function run({ host, emulator, cork }, code, at = GUEST_CODE){
    if (emulator.instructionCount() === 0)
    {
        // The ROM's jump lands on a halt, so the emulator's own slice does
        // not run the program before it is translated (the handoff that would
        // let the translator take over mid-slice is a later step).
        host.writePhysical(at, new Uint8Array([0xf4]));
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(at)));
        host.runSlice(100);
    }
    host.writePhysical(at, new Uint8Array(code));
    const cpu = emulator.cpu();
    cpu.instruction_pointer[0] = at;
    cpu.in_hlt[0] = 0;
    cork.noteHot(at, emulator.x87Top());
    assert.ok(await cork.translatePending() >= 1, 'the program translated');
    let trapped = -1;
    host.onTrap((/** @type {number} */ value)=>{
        trapped = value >>> 0;
    });
    for (let i = 0; i < 100; i++)
    {
        if (trapped >= 0)
        {
            break;
        }
        host.runSlice(10_000);
    }
    assert.ok(trapped >= 0, 'the program trapped');
    return trapped;
}

test('an x87 thread survives being interrupted by MMX, its loop translated', async()=>{
    const machine = await boot();
    const cpu = machine.emulator.cpu();
    await run(machine, [
        0xd9, 0xeb,             // fldpi
        0xd9, 0xe8,             // fld1
        0xde, 0xc1,             // faddp st(1), st(0)
        0xb8, ...u32(0xa11),    // mov eax, marker
        ...TRAP_AND_HALT,
    ]);
    const threadA = captureContext(cpu);
    assert.notEqual(threadA.fpuStackEmpty, 0x00, 'thread A has a live x87 stack');
    assert.equal(threadA.fpuStackPtr, 7);
    assert.ok(machine.cork.diagnostics().regions >= 1);
    assert.ok(machine.cork.diagnostics().translatedShare > 0);

    await run(machine, [
        0x0f, 0xef, 0xc0,       // pxor mm0, mm0
        0x0f, 0x7f, 0x05, ...u32(0x9000), // movq [0x9000], mm0
        0xb8, ...u32(0xb22),    // mov eax, marker
        ...TRAP_AND_HALT,
    ], GUEST_CODE + 0x200);
    const afterMmx = captureContext(cpu);
    assert.equal(afterMmx.fpuStackPtr, 0, 'MMX reset the x87 stack pointer');
    assert.equal(afterMmx.fpuStackEmpty, 0x00, 'MMX marked every register live');

    restoreContext(cpu, threadA);
    assert.equal(captureContext(cpu).fpuStackPtr, threadA.fpuStackPtr);
    assert.equal(captureContext(cpu).fpuStackEmpty, threadA.fpuStackEmpty);
    // And the value thread A left is the one the emulator's own run leaves.
    const st0 = machine.emulator.x87State().registers[threadA.fpuStackPtr & 7];
    assert.equal(st0, Math.PI + 1);
});

test('pending arithmetic flags survive a switch out of translated code', async()=>{
    const machine = await boot();
    const cpu = machine.emulator.cpu();
    // add leaves CF and ZF; the trap follows at once, so the flags are what
    // the translated exit wrote back.
    await run(machine, [
        0xb8, ...u32(0xffffffff),   // mov eax, -1
        0x83, 0xc0, 0x01,           // add eax, 1        CF = 1, ZF = 1
        ...TRAP_AND_HALT,
    ]);
    const saved = captureContext(cpu);
    assert.equal(saved.flagsChanged, 0, 'the translated exit left the word whole');
    assert.equal(saved.flags & 1, 1, 'CF');
    assert.equal(saved.flags & 0x40, 0x40, 'ZF');
    await run(machine, [
        0xb8, ...u32(5),
        0x83, 0xc0, 0x01,           // add eax, 1        CF = 0, ZF = 0
        ...TRAP_AND_HALT,
    ], GUEST_CODE + 0x200);
    assert.equal(captureContext(cpu).flags & 0x41, 0);
    restoreContext(cpu, saved);
    assert.equal(captureContext(cpu).flags & 0x41, 0x41, 'the flags came back whole');
    assert.equal(machine.emulator.readReg32('eflags') & 0x41, 0x41);
});

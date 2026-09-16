/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a quantum actually costs, measured rather than declared.
 *
 * A declared quantum that is not delivered is the failure mode behind §12.2: a
 * thread that must run often gets the CPU too rarely, and because the overrun
 * is a property of how much compiled code runs per call, the symptom appears on
 * the *faster* machine. So the numbers below are asserted, not assumed, and they
 * are ceilings to be lowered rather than targets to be met.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV86Host } from './v86-host.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);

/** The JIT compiles a page at a time, so a slice rounds up to a page boundary. */
const PAGE = 4096;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * Boots a guest that never finishes, so slices can be measured against it.
 *
 * @param {Uint8Array} code
 * @param {number} at
 * @param {[number, Uint8Array][]} [also]  More bytes in place before the boot.
 */
async function runningGuest(code, at, also = []){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const host = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: 0x300000,
    });

    host.writePhysical(at, code);
    for (const [where, bytes] of also)
    {
        host.writePhysical(where, bytes);
    }
    host.writePhysical(0x7000, new Uint8Array(u32(at)));
    // One pass of the emulator's own loop carries the ROM through to the guest.
    host.cpu().main_loop();
    return host;
}

test('a slice is bounded by retired instructions, to a page', async()=>{
    // Straight-line code: 200k single-byte nops, then a jump back to the start.
    const code = new Uint8Array(200000 + 5);
    code.fill(0x90);
    code[200000] = 0xe9;
    code.set(u32(-(200000 + 5)), 200001);

    const host = await runningGuest(code, 0x10000);
    const cpu = host.cpu();

    assert.equal(typeof cpu.run_slice, 'function',
        'the fork exports run_slice; without it a quantum is wall-clock bound');

    for (const requested of [100, 1000, 5000, 20000])
    {
        const delivered = cpu.run_slice(requested);

        assert.ok(delivered >= Math.min(requested, PAGE),
            `asked ${requested}, got ${delivered}: a slice must make progress`);
        assert.ok(delivered < requested + PAGE,
            `asked ${requested}, got ${delivered}: overrun must stay within one page`);
    }

    host.stop();
});

test('a hot loop inside one block is bounded by the slice, compiled or not', async()=>{
    // `dec eax; jmp back` -- the whole loop fits in a single block, so the check
    // between blocks never gets a turn: the bound has to be honoured inside the
    // loop itself, by the interpreter while the page is cold and by the
    // generated code's own loop check once it is compiled.
    const host = await runningGuest(new Uint8Array([0x48, 0xeb, 0xfd]), 0x8000);
    const cpu = host.cpu();

    for (const requested of [1000, 5000, 100000])
    {
        const delivered = cpu.run_slice(requested);
        assert.ok(delivered >= requested,
            `asked ${requested}, got ${delivered}: a slice must make progress`);
        // One iteration of the loop is the most either path may run past the
        // bound before it looks again.
        assert.ok(delivered <= requested + 2,
            `asked ${requested}, got ${delivered}: a hot loop must stop at the bound`);
    }

    // Enough turns for the page to be compiled, then the same question.
    for (let i = 0; i < 10; i++)
    {
        cpu.run_slice(100000);
    }
    const delivered = cpu.run_slice(1000);
    assert.ok(delivered >= 1000 && delivered <= 1002,
        `asked 1000 of a hot page, got ${delivered}`);

    host.stop();
});

test('a slice can end between a stub\'s trap and its ret', async()=>{
    // The fact the kernel's parking contract rests on: the instruction after
    // the `out` is a separate step, and the bound can fall between the two.
    // A thread parked by the trap is then switched away with ESP still on
    // the return address the kernel overwrote, so its resume must set ESP
    // itself rather than trust what was saved.
    const STUB = 0x100000;
    const CODE = 0x10000;
    // push 1; push 1; call STUB; jmp back -- the stub is the real shape:
    // mov dx, port; mov eax, id; out dx, eax; ret 8.
    const caller = [0x6a, 0x01, 0x6a, 0x01, 0xe8, ...u32(STUB - (CODE + 9)), 0xeb, 0xf4];
    const stub = [0x66, 0xba, 0x77, 0xb0, 0xb8, ...u32(7), 0xef, 0xc2, 0x08, 0x00];
    const host = await runningGuest(new Uint8Array(caller), CODE,
        [[STUB, new Uint8Array(stub)]]);
    host.onTrap(()=>{});
    const cpu = host.cpu();

    const retAt = STUB + 10;
    let stoppedOnRet = 0;
    for (const size of [1, 2, 3, 5, 7, 11, 13, 17, 100, 101, 1000, 1003])
    {
        for (let i = 0; i < 40; i++)
        {
            cpu.run_slice(size);
            if (host.readReg32('eip') === retAt)
            {
                stoppedOnRet++;
            }
        }
    }
    assert.ok(stoppedOnRet > 0, 'no slice ended on the stub\'s ret; the contract is moot');

    host.stop();
});

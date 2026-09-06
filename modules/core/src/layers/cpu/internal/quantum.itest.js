/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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

/** The loop-safety check inside a compiled block still counts to this constant. */
const IN_BLOCK_CEILING = 100_003;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * Boots a guest that never finishes, so slices can be measured against it.
 *
 * @param {Uint8Array} code
 * @param {number} at
 */
async function runningGuest(code, at){
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

test('a hot loop inside one block still overruns, and by how much', async()=>{
    // `dec eax; jmp back` — the whole loop fits in a single compiled block, so
    // the check between blocks never gets a turn.
    const host = await runningGuest(new Uint8Array([0x48, 0xeb, 0xfd]), 0x8000);
    const cpu = host.cpu();

    const delivered = cpu.run_slice(1000);

    // This asserts today's limitation on purpose. The in-block check is compiled
    // against a constant, so no runtime bound can tighten it; making a small
    // quantum real means emitting a load from a global in generated code. When
    // that lands, this expectation should fall, and this test is what will
    // notice.
    assert.ok(delivered > 10_000,
        `expected the known overrun, got ${delivered} — if this now honours the `
        + 'request, the in-block check was fixed and this test should be tightened');
    assert.ok(delivered <= IN_BLOCK_CEILING + PAGE,
        `overrun ${delivered} exceeds even the in-block ceiling`);

    host.stop();
});

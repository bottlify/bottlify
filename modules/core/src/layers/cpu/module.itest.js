/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Integration test: what the layer publishes about a real machine.
 *
 * A frame's account of the interpreter can only be checked against an emulator
 * that actually has one, so this needs the prebuilt vendor artifacts -- run
 * `npm run fetch:v86`, then `npm run test:integration`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpuModule } from './module.js';
import { createMetrics } from '../log/internal/metrics.js';
import { readTable } from '../log/internal/table.js';

const PREBUILT = new URL('../../../vendor/prebuilt/', import.meta.url);
const GUEST_CODE = 0x8000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * The layer over a real emulator, with a guest that runs forever from `at`.
 *
 * @param {Uint8Array} code @param {number} at
 */
async function booted(code, at){
    const metrics = createMetrics({ shared: false });
    /** @type {string[]} */
    const words = [];
    const api = await cpuModule.create({}, /** @type {any} */ ({
        requireApi: ()=>({
            metrics,
            /** @param {string} text */
            intern: text=>{
                const found = words.indexOf(text);
                return found >= 0 ? found : words.push(text) - 1;
            },
        }),
        provide: ()=>{},
    }));
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    await api.boot({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    });
    api.writePhysical(at, code);
    api.writePhysical(0x7000, new Uint8Array(u32(at)));
    // The machine is left standing on the ROM's jump into guest code, so the
    // first slice is the one that takes it there. Spent here and its figures
    // dropped, so what follows is measured on guest code alone.
    api.runSlice(100);
    metrics.sample();
    const counters = ()=>readTable(metrics.describe().cpu.counters).row(0);
    return { api, metrics, counters };
}

test('a frame names where the interpreter ran, and starts again after it', async()=>{
    // A loop small enough to stay in one block: the interpreter runs it until
    // the page is hot enough to compile, which is exactly the stretch a stall
    // frame is made of.
    const { api, metrics, counters } = await booted(
        new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);

    // The first slices are the cold ones, and the whole point is that the
    // address they ran at is published rather than only their count.
    api.runSlice(20_000);
    metrics.sample();
    const cold = counters();
    assert.ok(cold['jit.interpretedSteps'] > 0,
        'a cold page is interpreted; without that this test proves nothing');
    assert.ok(cold.frameInterpreted > 0, 'the frame says how much of it was interpreted');
    // The loop is three bytes, and a slice stops on the bound wherever in it
    // that falls -- so the address names the loop rather than one instruction.
    assert.ok(cold.frameInterpretedAt >= GUEST_CODE && cold.frameInterpretedAt < GUEST_CODE + 3,
        `the heaviest interpreted slice began at 0x${cold.frameInterpretedAt.toString(16)},`
        + ` which is not the guest's loop`);

    // A frame in which no slice ran claims nothing, rather than repeating the
    // last frame's address -- which is what a figure that is not reset does.
    metrics.sample();
    const quiet = counters();
    assert.equal(quiet.frameInterpreted, 0);
    assert.equal(quiet.frameInterpretedAt, 0);
    assert.ok(quiet['jit.interpretedSteps'] >= cold['jit.interpretedSteps'],
        'the run total only grows; only the frame fields reset');

    // And the next frame with a slice in it names the code again.
    api.runSlice(20_000);
    metrics.sample();
    assert.ok(counters().frameInterpretedAt >= GUEST_CODE,
        'the account carries on after a frame that had nothing to say');

    api.stop();
    await cpuModule.dispose();
});

test('the account can be asked where the interpreter ran, exactly', async()=>{
    const { api } = await booted(new Uint8Array([0x48, 0xeb, 0xfd]), GUEST_CODE);
    assert.equal(api.profile.available(), true,
        'the fork keeps the address account in a release build; without it there is nothing here');

    // Keeping the warm code is what makes this an interpreter account rather
    // than a whole-guest one: only code compiled from now on counts itself, so
    // what lands in the table is the interpreter's instructions, one per hit.
    const before = api.interpretedSteps();
    assert.equal(api.profile.start({ keepCode: true }), true);
    for (let i = 0; i < 10; i++)
    {
        api.runSlice(20_000);
    }
    const ran = api.interpretedSteps() - before;
    /** @type {{ entries: { address: number, instructions: number, hits: number }[],
     *     dropped: number } | null} */
    const account = api.profile.read();
    assert.ok(account, 'the account answers');
    const interpreted = account.entries.filter(one=>one.instructions === one.hits);
    assert.ok(interpreted.length > 0, 'the interpreted addresses are named');
    const weight = interpreted.reduce((total, one)=>total + one.instructions, 0);
    assert.ok(weight > ran / 2,
        `the account holds ${weight} of the ${ran} instructions the interpreter ran`);
    for (const one of interpreted)
    {
        assert.ok(one.address >= GUEST_CODE && one.address < GUEST_CODE + 3,
            `0x${one.address.toString(16)} is not in the guest's loop`);
    }
    api.profile.stop();

    api.stop();
    await cpuModule.dispose();
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hybrid mode with the translator attached, on the real emulator: a hot
 * loop is found by the sampler, translated between frames, and run by the
 * translator for the rest of the program, with the result and the
 * instruction count of an emulator-only run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpuModule } from '../module.js';
import { createMetrics } from '../../log/internal/metrics.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);
const ENGINE = new URL('../../../../../cork/src/index.js', import.meta.url).href;
const GUEST_CODE = 0x8000;
/** @param {number} value */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
// mov ecx, 200000; L: dec ecx; jnz L; mov eax, 0x1234; hlt
const PROGRAM = new Uint8Array([
    0xb9, 0x40, 0x0d, 0x03, 0x00, 0x49, 0x75, 0xfd, 0xb8, 0x34, 0x12, 0, 0, 0xf4,
]);
const ITERATIONS = 200000;

/**
 * @param {Uint8Array} code @param {number} at @param {Record<string, unknown>} config
 */
async function booted(code, at, config){
    const metrics = createMetrics({ shared: false });
    /** @type {string[]} */
    const words = [];
    const api = await cpuModule.create(config, /** @type {any} */ ({
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
    api.runSlice(100); // the ROM's jump into guest code
    return { api, metrics };
}

/** The cpu module's diagnostics metrics, which exist once it is booted. */
const metricsOf = ()=>{
    const { metrics } = cpuModule.diagnostics();
    return /** @type {Record<string, any>} */ (metrics);
};

/** @param {{ api: any, metrics: any }} machine */
async function runToHalt({ api, metrics }){
    let slices = 0;
    // The program ends by putting a marker in eax and halting.
    while (api.readReg32('eax') !== 0x1234 && slices < 40)
    {
        api.runSlice(100_000);
        slices++;
        // A frame passes: the sampler's hot buckets become candidates and the
        // pending batch is instantiated before the next slice.
        metrics.sample();
        await new Promise(resolve=>setTimeout(resolve, 20));
    }
    return slices;
}

test('a hot loop is translated between frames and run by the translator', async()=>{
    const reference = await booted(PROGRAM, GUEST_CODE, { engine: 'emulator' });
    await runToHalt(reference);
    const expectedCount = reference.api.instructionCount();
    const expectedRegisters = ['eax', 'ecx', 'edx', 'esp'].map(name=>reference.api.readReg32(name));
    await cpuModule.dispose();

    const hybrid = await booted(PROGRAM, GUEST_CODE, { engine: 'hybrid', engineUrl: ENGINE });
    assert.equal(metricsOf().engine, 'hybrid');
    const slices = await runToHalt(hybrid);
    assert.equal(hybrid.api.readReg32('eax'), 0x1234,
        `the program did not finish in ${slices} slices`);
    const cork = metricsOf().cork;
    assert.ok(cork, 'the translator reports');
    assert.ok(cork.regions >= 1,
        `regions: ${cork.regions}, refused ${JSON.stringify(cork.refused)}`);
    assert.ok(cork.translatedShare > 0.5,
        `the loop is most of the program, translated share ${cork.translatedShare}`);
    assert.equal(cork.exits.halt, 1, 'the translator ran the hlt');
    assert.deepEqual(['eax', 'ecx', 'edx', 'esp'].map(name=>hybrid.api.readReg32(name)),
        expectedRegisters);
    assert.equal(hybrid.api.readReg32('eax'), 0x1234);
    assert.equal(hybrid.api.instructionCount(), expectedCount,
        'the count is identical to the instruction');
    assert.ok(expectedCount > 2 * ITERATIONS, 'the loop is most of the count');
    await cpuModule.dispose();
});

test('hybrid without an engine URL is the emulator under another name', async()=>{
    const hybrid = await booted(PROGRAM, GUEST_CODE, { engine: 'hybrid' });
    await runToHalt(hybrid);
    assert.equal(metricsOf().cork, null);
    assert.equal(hybrid.api.readReg32('eax'), 0x1234);
    await cpuModule.dispose();
});

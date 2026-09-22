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
import { CPU_COUNTERS, cpuModule } from '../module.js';
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
    /** @type {Float64Array} the cpu layer's frame counters, as it registered them */
    let counters = new Float64Array(0);
    /** @type {string[]} */
    const words = [];
    const api = await cpuModule.create(config, /** @type {any} */ ({
        requireApi: ()=>({
            metrics: {
                ...metrics,
                /** @param {string} layer @param {string[]} names */
                counters: (layer, names)=>{
                    counters = metrics.counters(layer, names);
                    return counters;
                },
            },
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
    return { api, metrics, counters: ()=>counters };
}

/** The cpu module's diagnostics metrics, which exist once it is booted. */
const metricsOf = ()=>{
    const { metrics } = cpuModule.diagnostics();
    return /** @type {Record<string, any>} */ (metrics);
};

/** @param {{ api: any, metrics: any }} machine @param {number} [most]  slices allowed */
async function runToHalt({ api, metrics }, most = 40){
    let slices = 0;
    // The program ends by putting a marker in eax and halting.
    while (api.readReg32('eax') !== 0x1234 && slices < most)
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
    // The frame's own columns: the last frame's share is the loop's, and
    // its leaves and translation time are numbers of its own.
    const counters = hybrid.counters();
    const column = (/** @type {string} */ name)=>counters[CPU_COUNTERS.indexOf(name)];
    assert.ok(column('cork.share') > 0.5, `share column ${column('cork.share')}`);
    assert.ok(column('cork.frameShare') >= 0 && column('cork.frameShare') <= 1);
    assert.ok(column('cork.frameTranslateMs') >= 0);
    assert.ok(column('cork.frameLeaves') >= 0);
    await cpuModule.dispose();
});

test('hybrid without an engine URL is the emulator under another name', async()=>{
    const hybrid = await booted(PROGRAM, GUEST_CODE, { engine: 'hybrid' });
    await runToHalt(hybrid);
    assert.equal(metricsOf().cork, null);
    assert.equal(hybrid.api.readReg32('eax'), 0x1234);
    await cpuModule.dispose();
});

test('with the handoff export the emulator returns at the translated loop mid-slice', async()=>{
    // The program starts at an untranslated address and reaches the loop:
    // without the handoff the emulator runs the loop through to its slice's
    // end and every such slice is a miss; with it, the emulator returns at
    // the loop's page and the translator takes nearly the whole program.
    const { createV86Host } = await import('./v86-host.js');
    const { createHybridHost } = await import('./hybrid-host.js');
    const { TABLES_RESERVE } = await import('../engine.js');
    const { createEngine } = await import(ENGINE);
    /** @param {boolean} exported */
    const run = async exported=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const machine = await createV86Host({
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            memorySize: 64 * 1024 * 1024,
            trapPort: 0xb077,
            entryVector: 0x7000,
            initialStack: 0x300000,
        });
        const emulator = exported ? machine : {
            ...machine, handoffAvailable: ()=>false, handoffPage: ()=>{}, handoffHash: ()=>{},
        };
        const cork = createEngine({
            memory: machine.wasmMemory(),
            layout: machine.stateLayout(TABLES_RESERVE),
            config: {},
            read: machine.readByte,
            imports: {
                trap: ()=>0, getEflags: machine.getEflags, x87Read: ()=>0, rdtsc: ()=>0n,
                handoffPage: emulator.handoffPage, handoffHash: emulator.handoffHash,
                dirtyCode: machine.dirtyCode,
            },
        });
        const host = createHybridHost({ emulator, cork });
        host.writePhysical(GUEST_CODE, new Uint8Array([0xf4]));
        host.writePhysical(0x7000, new Uint8Array(u32(GUEST_CODE)));
        host.runSlice(1000); // the ROM's jump, onto a halt
        host.writePhysical(GUEST_CODE, PROGRAM);
        machine.cpu().instruction_pointer[0] = GUEST_CODE;
        machine.cpu().in_hlt[0] = 0;
        cork.noteHot(GUEST_CODE + 5, 0); // the loop's dec, not the mov before it
        assert.equal(await cork.translatePending(), 1);
        assert.equal(cork.entryOf(GUEST_CODE, 8), -1, 'the start is untranslated');
        assert.ok(cork.entryOf(GUEST_CODE + 5, 8) >= 0);
        let slices = 0;
        while (machine.readReg32('eax') !== 0x1234 && slices < 400)
        {
            host.runSlice(2000);
            slices++;
        }
        assert.equal(machine.readReg32('eax'), 0x1234, `finished in ${slices} slices`);
        const result = {
            ecx: machine.readReg32('ecx'), count: machine.instructionCount(),
            ...host.corkDiagnostics(),
        };
        machine.stop();
        return result;
    };
    const without = await run(false);
    assert.ok(without.handoffMisses > 0, `misses ${without.handoffMisses}`);
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const probe = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: 0x300000,
    });
    const available = probe.handoffAvailable();
    probe.stop();
    if (!available)
    {
        return; // the pinned build predates the export
    }
    const withIt = await run(true);
    assert.equal(withIt.handoffMisses, 0);
    assert.ok(withIt.translatedShare > 0.95, `translated share ${withIt.translatedShare}`);
    assert.equal(withIt.count, without.count, 'the same instructions either way');
    assert.equal(withIt.ecx, without.ecx);
});

test('a call in the hot loop: the callee, the call and the return all stay in wasm', async()=>{
    // mov ecx, N; L: call F; dec ecx; jnz L; mov eax, 0x1234; hlt; F: inc edx; ret
    const N = 2_000_000;
    const program = new Uint8Array([
        0xb9, ...u32(N),
        0xe8, 0x09, 0, 0, 0,
        0x49, 0x75, 0xf8,
        0xb8, 0x34, 0x12, 0, 0,
        0xf4,
        0x42, 0xc3,
    ]);
    const reference = await booted(program, GUEST_CODE, { engine: 'emulator' });
    await runToHalt(reference, 120);
    const expected = {
        count: reference.api.instructionCount(),
        edx: reference.api.readReg32('edx'),
    };
    await cpuModule.dispose();
    assert.equal(expected.edx, N);

    const hybrid = await booted(program, GUEST_CODE, { engine: 'hybrid', engineUrl: ENGINE });
    const slices = await runToHalt(hybrid, 120);
    assert.equal(hybrid.api.readReg32('eax'), 0x1234, `finished in ${slices} slices`);
    assert.equal(hybrid.api.readReg32('edx'), N);
    assert.equal(hybrid.api.instructionCount(), expected.count);
    const cork = metricsOf().cork;
    assert.ok(cork.regions >= 1, `regions ${cork.regions}`);
    if (cork.entries > 0)
    {
        // Every call and return after the loop is translated transfers
        // through the hash: the untranslated exits are the few from before.
        assert.ok(cork.translatedShare > 0.95,
            `share ${cork.translatedShare}, exits ${JSON.stringify(cork.exits)}`);
        assert.ok(cork.exits.untranslated <= slices,
            `untranslated exits ${cork.exits.untranslated}`);
    }
    await cpuModule.dispose();
});

test('a second boot with the same store takes every region from it', async()=>{
    const { memoryTranslationStore } = await import('../../../../../cork/src/runtime/cache.js');
    const store = memoryTranslationStore();
    const config = { engine: 'hybrid', engineUrl: ENGINE, cork: { store, bundleId: 'itest' } };
    const first = await booted(PROGRAM, GUEST_CODE, config);
    await runToHalt(first);
    const before = metricsOf().cork;
    assert.ok(before.regions >= 1);
    assert.equal(before.cacheHits, 0);
    assert.equal(before.cacheMisses, before.regions);
    assert.ok(store.size() >= before.regions);
    const count = first.api.instructionCount();
    await cpuModule.dispose();

    const second = await booted(PROGRAM, GUEST_CODE, config);
    await runToHalt(second);
    const after = metricsOf().cork;
    assert.equal(second.api.readReg32('eax'), 0x1234);
    assert.equal(second.api.instructionCount(), count);
    assert.equal(after.cacheHits, after.regions, 'every region from the store');
    assert.equal(after.cacheMisses, 0);
    assert.ok(after.translateMs < before.translateMs, 'cheaper than emitting');
    await cpuModule.dispose();
});

test('with the translation worker the emitting leaves the engine thread', async()=>{
    // The same program as the first test, but emitting and encoding go to a
    // `translator.worker.js`; the engine thread keeps only forming, the store
    // and publication. In a process without a `Worker` the runtime reaches
    // the file through `worker_threads`, so this runs the worker for real.
    const config = { engine: 'hybrid', engineUrl: ENGINE };
    const inline = await booted(PROGRAM, GUEST_CODE, config);
    await runToHalt(inline);
    const inlineCork = metricsOf().cork;
    const expectedCount = inline.api.instructionCount();
    await cpuModule.dispose();

    const hybrid = await booted(PROGRAM, GUEST_CODE, { ...config, cork: { worker: true } });
    // Let the worker open before the first candidates are formed.
    await new Promise(resolve=>setTimeout(resolve, 50));
    const slices = await runToHalt(hybrid);
    assert.equal(hybrid.api.readReg32('eax'), 0x1234, `finished in ${slices} slices`);
    assert.equal(hybrid.api.instructionCount(), expectedCount);
    const cork = metricsOf().cork;
    assert.ok(cork.regions >= 1, `regions ${cork.regions}`);
    assert.ok(cork.translatedShare > 0.5,
        `the loop is most of the program, translated share ${cork.translatedShare}`);
    assert.ok(cork.workerMs > 0, `the worker emitted: ${JSON.stringify(cork)}`);
    assert.equal(cork.emitMs, 0, 'the engine thread emitted nothing');
    assert.equal(cork.encodeMs, 0, 'and encoded nothing');
    // The same work moved, not disappeared: the two translate splits add to
    // about the same, and the share the translator ran is unchanged.
    assert.equal(cork.translatedShare, inlineCork.translatedShare);
    console.log(`3e.1 tight loop: inline translateMs ${inlineCork.translateMs.toFixed(2)} ms`
        + ` (forming ${inlineCork.formingMs.toFixed(2)}, emit ${inlineCork.emitMs.toFixed(2)},`
        + ` encode ${inlineCork.encodeMs.toFixed(2)},`
        + ` instantiate ${inlineCork.instantiateMs.toFixed(2)}); worker: engine`
        + ` translateMs ${cork.translateMs.toFixed(2)} ms + worker`
        + ` ${cork.workerMs.toFixed(2)} ms`);
    await cpuModule.dispose();
});

/**
 * The origin's private file system in memory, with the shape the directory
 * store uses and a count of every `getFileHandle`: the probes the index
 * removes. A record file stores an ArrayBuffer; the index a text file.
 *
 * @param {{ probes: number }} counter
 */
function fakeRoot(counter){
    /** @param {Map<string, any>} entries */
    const node = entries=>({
        entries,
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getDirectoryHandle(name, options = {}){
            let child = entries.get(name);
            if (!child && options.create)
            {
                child = node(new Map());
                entries.set(name, child);
            }
            if (!child)
            {
                throw new Error('NotFoundError');
            }
            return child;
        },
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getFileHandle(name, options = {}){
            counter.probes++;
            let file = entries.get(name);
            if (!file && options.create)
            {
                file = {
                    bytes: new Uint8Array(0),
                    async getFile(){
                        const bytes = file.bytes;
                        return {
                            arrayBuffer: async()=>bytes.buffer.slice(
                                bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                        };
                    },
                    async createWritable(){
                        return {
                            /** @param {Uint8Array} b */
                            async write(b){
                                file.bytes = new Uint8Array(b);
                            },
                            async close(){},
                        };
                    },
                };
                entries.set(name, file);
            }
            if (!file)
            {
                throw new Error('NotFoundError');
            }
            return file;
        },
    });
    return node(new Map());
}

test('the directory store takes the second run from its index and records', async()=>{
    const { createDirectoryTranslationStore } = await import('./translation-store.js');
    const counter = { probes: 0 };
    const store = await createDirectoryTranslationStore(fakeRoot(counter), 'itest');
    const config = { engine: 'hybrid', engineUrl: ENGINE, cork: { store, bundleId: 'itest' } };
    const first = await booted(PROGRAM, GUEST_CODE, config);
    await runToHalt(first);
    const before = metricsOf().cork;
    assert.equal(before.cacheHits, 0);
    assert.equal(before.cacheMisses, before.regions);
    await cpuModule.dispose();

    const second = await booted(PROGRAM, GUEST_CODE, config);
    await runToHalt(second);
    const after = metricsOf().cork;
    assert.equal(second.api.readReg32('eax'), 0x1234);
    assert.equal(after.cacheHits, after.regions, 'every region from the store');
    assert.equal(after.cacheMisses, 0);
    assert.equal(after.emitMs, 0, 'a hit emits nothing');
    assert.ok(typeof after.lookupMs === 'number');
    assert.ok(after.lookupMs < after.translateMs, 'the lookups are part of the split');
    await cpuModule.dispose();
});

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

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CPU_COUNTERS, cpuModule } from '../module.js';
import { createMetrics } from '../../log/internal/metrics.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);
const ENGINE = new URL('../../../../../cork/src/index.js', import.meta.url).href;

// A test that fails before its own dispose would leave the translator's worker
// thread holding the process open, and the file would never end.
afterEach(()=>cpuModule.dispose());

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

test('a control word a region loaded is the emulator\'s at its next instruction', async()=>{
    // The region ends with fldcw (round toward zero) and leaves through an
    // indirect jump to code only the emulator runs: its fistp must round by
    // the new word, which the emulator also keeps decoded apart from the word.
    const { createV86Host } = await import('./v86-host.js');
    const { createHybridHost } = await import('./hybrid-host.js');
    const { TABLES_RESERVE } = await import('../engine.js');
    const { createEngine } = await import(ENGINE);
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const machine = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: 0x300000,
    });
    const cork = createEngine({
        memory: machine.wasmMemory(),
        layout: machine.stateLayout(TABLES_RESERVE),
        config: {},
        read: machine.readByte,
        imports: {
            trap: ()=>0, getEflags: machine.getEflags, x87Read: ()=>0, rdtsc: ()=>0n,
            handoffPage: machine.handoffPage, handoffHash: machine.handoffHash,
            dirtyCode: machine.dirtyCode,
        },
    });
    const host = createHybridHost({ emulator: machine, cork });
    host.writePhysical(GUEST_CODE, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(GUEST_CODE)));
    host.runSlice(1000); // the ROM's jump, onto a halt
    const program = new Uint8Array(0x2012);
    program.set([
        0xb9, 3, 0, 0, 0,                    // mov ecx, 3
        0x49, 0x75, 0xfd,                    // L: dec ecx; jnz L
        0xd9, 0x2d, 0x00, 0x90, 0, 0,        // fldcw [0x9000]
        0xb8, 0x00, 0xa0, 0, 0,              // mov eax, 0xa000
        0xff, 0xe0,                          // jmp eax
    ]);
    const data = new DataView(program.buffer, 0x1000);
    data.setUint16(0, 0x0f7f, true);         // every exception masked, round toward zero
    data.setFloat64(8, 2.7, true);
    program.set([
        0xdd, 0x05, 0x08, 0x90, 0, 0,        // fld qword [0x9008]
        0xdb, 0x1d, 0x10, 0x90, 0, 0,        // fistp dword [0x9010]
        0xb8, 0x34, 0x12, 0, 0, 0xf4,        // mov eax, 0x1234; hlt
    ], 0x2000);
    host.writePhysical(GUEST_CODE, program);
    machine.cpu().instruction_pointer[0] = GUEST_CODE;
    machine.cpu().in_hlt[0] = 0;
    cork.noteHot(GUEST_CODE + 5, 0);
    assert.equal(await cork.translatePending(), 1);
    assert.equal(cork.entryOf(0xa000, 8), -1, 'the fistp is the emulator\'s');
    for (let slices = 0; machine.readReg32('eax') !== 0x1234 && slices < 50; slices++)
    {
        host.runSlice(2000);
    }
    assert.equal(machine.readReg32('eax'), 0x1234);
    assert.ok(host.corkDiagnostics().regions >= 1);
    const result = new DataView(machine.wasmMemory().buffer).getInt32(
        machine.stateLayout(TABLES_RESERVE).ramBase + 0x9010, true);
    assert.equal(result, 2, 'rounded toward zero, as the word the region loaded says');
    machine.stop();
});

test('a join two x87 tops reach becomes a region for each, and its misses stop', async()=>{
    // The shape 3j names on real code. main: fninit; mov esi, N
    //   L: test esi, 1; jz A; fld1
    //   A: fninit; dec esi; jnz L; mov eax, 0x1234; hlt
    // A is reached from the `jz` with an empty stack and by the `fld1` with a
    // pushed one: two tops meet at the join, and a region formed there is
    // compiled for the top it was entered at, the other edge leaving. Not
    // doing so cut the region's own entry, published no entry at A, and the
    // miss repeated with every iteration.
    const N = 200_000;
    const A = GUEST_CODE + 0x11;
    const LOOP = GUEST_CODE + 7;
    const program = new Uint8Array([
        0xdb, 0xe3,                              // fninit
        0xbe, ...u32(N),                         // mov esi, N
        0xf7, 0xc6, 0x01, 0, 0, 0,               // L: test esi, 1
        0x74, 0x02,                              //    jz A
        0xd9, 0xe8,                              //    fld1
        0xdb, 0xe3,                              // A: fninit
        0x4e,                                    //    dec esi
        0x75, 0xf1,                              //    jnz L
        0xb8, 0x34, 0x12, 0, 0,                  //    mov eax, 0x1234
        0xf4,                                    //    hlt
    ]);
    const { createV86Host } = await import('./v86-host.js');
    const { createHybridHost } = await import('./hybrid-host.js');
    const { TABLES_RESERVE } = await import('../engine.js');
    const { createEngine } = await import(ENGINE);
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const machine = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: 0x300000,
    });
    const cork = createEngine({
        memory: machine.wasmMemory(),
        layout: machine.stateLayout(TABLES_RESERVE),
        config: {},
        read: machine.readByte,
        imports: {
            trap: ()=>0, getEflags: machine.getEflags, x87Read: ()=>0, rdtsc: ()=>0n,
            handoffPage: machine.handoffPage, handoffHash: machine.handoffHash,
            dirtyCode: machine.dirtyCode,
        },
    });
    const host = createHybridHost({ emulator: machine, cork });
    host.writePhysical(GUEST_CODE, new Uint8Array([0xf4]));
    host.writePhysical(0x7000, new Uint8Array(u32(GUEST_CODE)));
    host.runSlice(1000); // the ROM's jump, onto a halt
    host.writePhysical(GUEST_CODE, program);
    machine.cpu().instruction_pointer[0] = GUEST_CODE;
    machine.cpu().in_hlt[0] = 0;
    // The loop head is the sampler's candidate first, so the handoff bit is
    // set and the emulator returns to the translator inside the page.
    cork.noteHot(LOOP, 0);
    assert.equal(await cork.translatePending(), 1);
    const countAt = ()=>cork.diagnostics().exitsByTarget
        .find((/** @type {any} */ entry)=>entry.address === A)?.count ?? 0;
    let slices = 0;
    while (machine.readReg32('eax') !== 0x1234 && slices < 400)
    {
        host.runSlice(200_000);
        await cork.translatePending();
        slices++;
    }
    assert.equal(machine.readReg32('eax'), 0x1234, `finished in ${slices} slices`);
    // Both tops at the join are entries now: the region for the top the
    // machine had, and one formed for the other when its miss was counted.
    assert.ok(cork.entryOf(A, 0) >= 0, `top 0 entry at A: ${cork.entryOf(A, 0)}`);
    assert.ok(cork.entryOf(A, 7) >= 0, `top 7 entry at A: ${cork.entryOf(A, 7)}`);
    // And with both entries the miss at the join stops growing.
    const frozen = countAt();
    host.runSlice(200_000);
    await cork.translatePending();
    assert.equal(countAt(), frozen, 'the untranslated exits at the join stopped');
    // The counters 3j.4 reads: instructions the translator retired against
    // the emulator's, and the share they make. A share that falls while the
    // exits fall is the translator retiring less, not fewer misses.
    const report = cork.diagnostics();
    const total = machine.instructionCount();
    console.log('3j two-top join: share'
        + ` ${report.translatedShare.toFixed(3)}, translator ${report.retired} of`
        + ` ${total} (emulator ${total - report.retired}), exits`
        + ` ${JSON.stringify(report.exits)}`);
    machine.stop();
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
    const config = { engine: 'hybrid', engineUrl: ENGINE,
        cork: { store, bundleId: 'itest', timings: true } };
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

    const hybrid = await booted(PROGRAM, GUEST_CODE,
        { ...config, cork: { worker: true, timings: true } });
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
                /** @param {Uint8Array} bytes @returns {any} */
                const fileOf = bytes=>({
                    size: bytes.length,
                    arrayBuffer: async()=>bytes.buffer.slice(
                        bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                    /** @param {number} from @param {number} to */
                    slice: (from, to)=>fileOf(bytes.subarray(from, to)),
                });
                file = {
                    bytes: new Uint8Array(0),
                    async getFile(){
                        return fileOf(file.bytes);
                    },
                    /** @param {{ keepExistingData?: boolean }} [how] */
                    async createWritable(how = {}){
                        let draft = how.keepExistingData
                            ? new Uint8Array(file.bytes) : new Uint8Array(0);
                        return {
                            /** @param {any} b */
                            async write(b){
                                if (b instanceof Uint8Array)
                                {
                                    draft = new Uint8Array(b);
                                    return;
                                }
                                const grown = new Uint8Array(
                                    Math.max(draft.length, b.position + b.data.length));
                                grown.set(draft);
                                grown.set(b.data, b.position);
                                draft = grown;
                            },
                            async close(){
                                file.bytes = draft;
                            },
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
    const config = { engine: 'hybrid', engineUrl: ENGINE,
        cork: { store, bundleId: 'itest', timings: true } };
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
    // The lookup is the store read for a hit; it runs in the feed's own
    // fire-and-forget task, so it is not on the frame. The figure is the
    // stored second run's read wall time, against the first run's misses.
    console.log(`store second run: hits ${after.cacheHits}, misses ${after.cacheMisses},`
        + ` lookupMs ${after.lookupMs.toFixed(2)} of translateMs ${after.translateMs.toFixed(2)},`
        + ` first run lookupMs ${before.lookupMs.toFixed(2)} (misses ${before.cacheMisses})`);
    await cpuModule.dispose();
});

test('a slice never awaits the store: it runs on while a batch\'s bytes are out', async()=>{
    /** @type {() => void} */
    let releaseLookup = ()=>{};
    let lookups = 0;
    /** @type {any} */
    const store = {
        get(){
            lookups++;
            return new Promise(resolve=>{
                releaseLookup = ()=>resolve(null);
            });
        },
        async put(){},
    };
    const machine = await booted(PROGRAM, GUEST_CODE,
        { engine: 'hybrid', engineUrl: ENGINE, cork: { store, bundleId: 'itest' } });
    // A slice leaves untranslated exits; a frame requests the store's bytes.
    machine.api.runSlice(100_000);
    const before = machine.api.instructionCount();
    machine.metrics.sample();
    assert.ok(lookups >= 1, `the store was asked (${lookups})`);
    assert.equal(metricsOf().cork.regions, 0, 'nothing published while the bytes are out');
    // The guest runs on interpreted: the lookup is the batch's, not the slice's.
    machine.api.runSlice(100_000);
    assert.ok(machine.api.instructionCount() > before, 'the guest ran on');
    assert.equal(metricsOf().cork.regions, 0, 'still nothing published');
    // The bytes come back, and the next frame publishes them.
    releaseLookup();
    await new Promise(resolve=>setTimeout(resolve, 20));
    machine.metrics.sample();
    assert.ok(metricsOf().cork.regions >= 1, 'published once the store answered');
    await cpuModule.dispose();
});

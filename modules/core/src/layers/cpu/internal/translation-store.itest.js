/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A seed end to end on the cork host: a benchmark program (`tools/cork-bench`)
 * run once with a store, the store exported, a fresh store seeded from it, and
 * the program run again -- its first iteration takes its regions from the
 * seed and emits nothing. And a seed that does not fit -- made with other
 * features, another layout, another emitting setting, for another precision
 * control, or from other code bytes -- answers no lookup, and the program's
 * own checksum is what it is without one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCorkHost } from './cork-host.js';
import {
    createDirectoryTranslationStore, createMemoryDirectory, fileNameOf,
} from './translation-store.js';
import * as engine from '../../../../../cork/src/index.js';
import { seedRecords } from '../../../../../cork/src/runtime/cache.js';
import { features } from '../../../../../cork/src/wasm/features.js';

const IMAGES = new URL('../../../../../../tools/cork-bench/images/', import.meta.url);
const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;

/**
 * How a host is made beyond its image and store: the translator's settings,
 * the engine module, the guest's memory (which the layout's identity names).
 *
 * @typedef {{ cork?: Record<string, unknown>, module?: any, memorySize?: number }} HostOptions
 */

/**
 * A host over a benchmark image, as the benchmark makes one.
 *
 * @param {Uint8Array} image @param {any} store @param {HostOptions} [options]
 */
function hostFor(image, store, { cork = {}, module = engine, memorySize = 16 << 20 } = {}){
    const host = createCorkHost({
        engine: module, memorySize, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, cork: { store, bundleId: 'bench', timings: true, ...cork },
    });
    host.writePhysical(IMAGE_BASE, image);
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    return host;
}

/**
 * One call of the program's main, to its `hlt`, the event loop turning between
 * slices as the engine's frames let it: a store answers between them.
 *
 * @param {ReturnType<typeof hostFor>} host
 */
async function iteration(host){
    host.runSlice(100_000);
    while (!host.halted())
    {
        host.cork().translatePending().catch(()=>{});
        await new Promise(resolve=>setImmediate(resolve));
        host.runSlice(100_000);
    }
    return (host.readReg32('eax') >>> 0).toString(16);
}

/** @param {string} name */
const imageOf = name=>new Uint8Array(readFileSync(new URL(`${name}.bin`, IMAGES)));

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A program with x87 in every region it forms, run under the precision control
 * `control` loads: a hundred thousand rounds of fld1; faddp, the sum stored and
 * returned. The control word is data, not code, so two controls are the same
 * code bytes.
 *
 * @param {number} control
 */
function x87Program(control){
    const image = new Uint8Array(0x1008);
    image.set([
        0xd9, 0x2d, ...u32(0x402004), // fldcw [0x402004]
        0xb9, ...u32(100_000), // mov ecx, 100000
        0xd9, 0xee, // fldz
        0xd9, 0xe8, // fld1
        0xde, 0xc1, // faddp st1, st0
        0x49, // dec ecx
        0x75, 0xf9, // jnz back to the fld1
        0xdb, 0x1d, ...u32(0x402000), // fistp dword [0x402000]
        0xa1, ...u32(0x402000), // mov eax, [0x402000]
        0xf4, // hlt
    ]);
    new DataView(image.buffer).setUint16(0x1004, control, true);
    return image;
}

/**
 * A run of `iterations` with a fresh store, exported as a seed.
 *
 * @param {Uint8Array} image @param {HostOptions} [options]
 */
async function capture(image, options = {}, iterations = 3){
    const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'bench');
    const host = hostFor(image, store, options);
    for (let i = 0; i < iterations; i++)
    {
        await iteration(host);
    }
    await host.cork().flush();
    return store.exportSeed({ select: records=>seedRecords(records, fileNameOf) });
}

/**
 * The first iteration of a run on a fresh store, seeded when there is a seed.
 *
 * @param {Uint8Array} image @param {Uint8Array | null} seed @param {HostOptions} [options]
 */
async function firstIteration(image, seed, options = {}){
    const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'bench');
    if (seed !== null)
    {
        await store.seed(seed);
    }
    const host = hostFor(image, store, options);
    const eax = await iteration(host);
    return { eax, cork: host.cork().diagnostics() };
}

test('a seeded store gives a run\'s first iteration every region it formed, and no emit',
    { timeout: 60000 }, async()=>{
        const image = imageOf('load-x87');
        const cold = await firstIteration(image, null);
        assert.ok(cold.cork.emitMs > 0 && cold.cork.cacheMisses > 0, 'cold, the regions are made');
        const seed = await capture(image);
        const seeded = await firstIteration(image, seed);
        assert.equal(seeded.eax, cold.eax, 'the program\'s own checksum');
        // Which starts turn hot depends on where slices end, so the two runs
        // need not form the same regions; every one this run formed was there.
        assert.ok(seeded.cork.cacheHits > 1000, `hits: ${seeded.cork.cacheHits}`);
        assert.equal(seeded.cork.cacheMisses, 0, 'every region formed was in the seed');
        assert.equal(seeded.cork.emitMs, 0, 'nothing emitted');
    });

test('a seed made with other features, another layout or another emitting setting answers'
    + ' nothing', { timeout: 120000 }, async()=>{
    const image = imageOf('crc-x87');
    const cold = await firstIteration(image, null);
    const probed = features();
    /** The engine module, with the features it finds replaced. @param {object} changed */
    const withFeatures = changed=>({ ...engine,
        createEngine: (/** @type {any} */ env)=>engine.createEngine({ ...env,
            features: { ...probed, ...changed } }) });
    const same = await firstIteration(image, await capture(image));
    assert.ok(same.cork.cacheHits > 0, `the same settings: ${same.cork.cacheHits} hits`);
    for (const [what, made, run] of /** @type {[string, HostOptions, HostOptions][]} */ ([
        ['another default NaN',
            { module: withFeatures({ defaultNaNNegative: !probed.defaultNaNNegative }) }, {}],
        // Without tail calls there is no entry hash, and no tier resumed from it.
        ['no tail calls', { module: withFeatures({ tailCalls: false }) }, {}],
        ['another layout', { memorySize: 32 << 20 }, {}],
        ['structure off', { cork: { structure: false } }, {}],
        ['structure unset, against off', { cork: { structure: undefined } },
            { cork: { structure: false } }],
        ['precise', { cork: { precise: true } }, {}],
        ['another trap port', { cork: { trapPort: 0xb078 } }, {}],
    ]))
    {
        const seeded = await firstIteration(image, await capture(image, made), run);
        assert.equal(seeded.cork.cacheHits, 0, `${what}: no hit`);
        assert.ok(seeded.cork.cacheMisses > 0, `${what}: looked up`);
        assert.equal(seeded.eax, cold.eax, `${what}: the same checksum`);
    }
});

test('a seed made under another precision control answers no x87 region', { timeout: 60000 },
    async()=>{
        // Double extended (wide), single (narrow), and a test at every
        // rounding from the start (wideFirst off, mixed).
        const extended = x87Program(0x37f);
        const single = x87Program(0x07f);
        const same = await firstIteration(extended, await capture(extended));
        assert.equal(same.eax, (100_000).toString(16));
        assert.ok(same.cork.cacheHits > 0, 'the same control: from the seed');
        const mixed = { cork: { wideFirst: false } };
        for (const [what, from, made, to, run] of
            /** @type {[string, Uint8Array, HostOptions, Uint8Array, HostOptions][]} */ ([
                ['wide, against narrow', extended, {}, single, {}],
                ['narrow, against wide', single, {}, extended, {}],
                ['wide, against mixed', extended, {}, extended, mixed],
                ['narrow, against mixed', single, {}, single, mixed],
                ['mixed, against wide', extended, mixed, extended, {}],
            ]))
        {
            const seeded = await firstIteration(to, await capture(from, made), run);
            assert.equal(seeded.cork.cacheHits, 0, `${what}: no hit`);
            assert.ok(seeded.cork.cacheMisses > 0, `${what}: looked up`);
            assert.equal(seeded.eax, same.eax, `${what}: the same sum`);
        }
    });

test('a code byte changed since the seed was made is translated from the bytes it now holds',
    { timeout: 60000 }, async()=>{
        const image = imageOf('crc-x87');
        const seed = await capture(image);
        // The CRC's initial value, `mov eax, 0xffffffff` at 0x401101, becomes
        // 0xfffffffe: a region answered from the seed would compute the old sum.
        const changed = image.slice();
        assert.equal(changed[0x102], 0xff);
        changed[0x102] = 0xfe;
        const original = await firstIteration(image, seed);
        const expected = await firstIteration(changed, null);
        const seeded = await firstIteration(changed, seed);
        assert.notEqual(expected.eax, original.eax, 'the change changes the sum');
        assert.equal(seeded.eax, expected.eax, 'the changed code ran, not the seed\'s');
        assert.ok(seeded.cork.cacheMisses > 0, 'the changed region missed');
    });

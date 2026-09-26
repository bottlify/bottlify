/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A bundle carries its translations: a run's translation store exported as a
 * seed, packed into the bundle, and a first run of that bundle on a fresh
 * store starts from it -- through `createApp`, the bundle fetched by range as
 * a launch fetches it. A store that has taken the seed does not fetch it
 * again, an engine without the translator never fetches it, and a bundle
 * without one runs as it always did.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { cpuModule } from './layers/cpu/module.js';
import { openBundle, writeBundle } from './bundle-node.js';
import {
    createDirectoryTranslationStore, createMemoryDirectory, unpackSeed,
} from './layers/cpu/internal/translation-store.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const missing = ['v86.wasm', 'libv86.mjs']
    .filter((/** @type {string} */ name)=>!existsSync(new URL(name, PREBUILT)));
const BUNDLE_ID = 'seed-test';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A loop that calls lstrlenA("abc") a few hundred thousand times and exits with the sum. */
const LOOP = buildExe({
    imports: { 'KERNEL32.dll': ['lstrlenA', 'ExitProcess'] },
    data: { text: [0x61, 0x62, 0x63, 0] },
    codeSize: 0x40,
    code: ({ iat, at })=>[
        0xbe, ...u32(300_000),
        0x31, 0xff,
        0x68, ...u32(at('text')),
        0xff, 0x15, ...u32(iat('lstrlenA')),
        0x01, 0xc7,
        0x4e,
        0x75, 0xf0,
        0x81, 0xe7, ...u32(0xff),
        0x57,
        0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/**
 * A bundle of one small file, with a seed when given one, and a range fetcher
 * over it that remembers every range it was asked for.
 *
 * @param {Uint8Array} [translations]
 */
async function bundleOf(translations){
    const root = await mkdtemp(join(tmpdir(), 'seed-src-'));
    const out = await mkdtemp(join(tmpdir(), 'seed-out-'));
    await writeFile(join(root, 'readme.txt'), 'what the program never reads');
    const path = join(out, 'bundle.btl');
    const summary = await writeBundle({ root, output: path, blockSize: 64 * 1024, translations });
    // Where the seed's blocks sit in the container: what a fetch of it reaches.
    const written = await openBundle(path);
    const member = written.translations;
    const seedSpan = member === null ? null : [written.index.blocks[member.firstBlock].offset,
        written.index.blocks[member.firstBlock + member.blocks - 1].offset
        + written.index.blocks[member.firstBlock + member.blocks - 1].packed];
    await written.close();
    const handle = await open(path, 'r');
    /** @type {[number, number][]} */
    const ranges = [];
    return {
        summary,
        seedSpan,
        ranges,
        /** @param {number} offset @param {number} length */
        fetch: async(offset, length)=>{
            ranges.push([offset, length]);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            return new Uint8Array(buffer);
        },
        cleanup: async()=>{
            await handle.close();
            await rm(root, { recursive: true, force: true });
            await rm(out, { recursive: true, force: true });
        },
    };
}

/** A fresh store in memory, as the origin's file system would hold one. */
const freshStore = ()=>createDirectoryTranslationStore(createMemoryDirectory(), BUNDLE_ID);

/**
 * @param {'cork' | 'emulator' | undefined} engine  none: the default
 * @param {any} store
 * @param {Awaited<ReturnType<typeof bundleOf>>} source
 */
async function run(engine, store, source){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable: LOOP,
        engine,
        cork: { config: { feed: 'slice', timings: true, traceStore: true, store } },
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
        bundle: { fetch: source.fetch, prefix: '', id: BUNDLE_ID, store: null },
    });
    /** @type {any[]} */
    const seeded = [];
    app.on('bundle-translations', (/** @type {any} */ payload)=>seeded.push(payload));
    try
    {
        const code = await app.run({ timeoutMs: 30000 });
        const { metrics } = cpuModule.diagnostics();
        return { code, cork: /** @type {any} */ (metrics).cork, seeded,
            exported: await app.exportTranslations() };
    }
    finally
    {
        await app.dispose();
    }
}

test('a bundle\'s seed gives the first run on a fresh store the regions a run elsewhere made',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 120000 }, async t=>{
        // Elsewhere: a run of the bundle without a seed, its store exported.
        const plain = await bundleOf();
        t.after(()=>plain.cleanup());
        const elsewhere = await freshStore();
        const first = await run('cork', elsewhere, plain);
        assert.ok(first.cork.regions >= 1, 'the loop was translated');
        assert.equal(first.cork.cacheHits, 0);
        assert.deepEqual(first.seeded, [], 'a bundle without a seed seeds nothing');
        // The launch hands its translations out as the seed a bundle carries.
        const seed = /** @type {Uint8Array} */ (first.exported);
        assert.ok((unpackSeed(seed)?.length ?? 0) >= first.cork.regions + 1,
            'a region record each and the module they name');

        const carrying = await bundleOf(seed);
        t.after(()=>carrying.cleanup());
        const member = carrying.summary.translations;
        assert.equal(member.size, seed.length);

        // Here: a store that never saw the program, under a launch that names
        // no engine and so runs cork.
        const machine = createMemoryDirectory();
        const here = await createDirectoryTranslationStore(machine, BUNDLE_ID);
        const second = await run(undefined, here, carrying);
        assert.equal(second.code, first.code, 'the program ends as it did');
        // Which starts turn hot depends on where the run's slices end, so the
        // two runs need not form the same regions; none the first made and
        // stored is made again here.
        const madeThere = new Set(first.cork.storeTrace.put);
        assert.ok(second.cork.cacheHits >= 1, `hits: ${second.cork.cacheHits}`);
        assert.deepEqual(second.cork.storeTrace.missed.filter(
            (/** @type {string} */ key)=>madeThere.has(key)), []);
        assert.equal(second.seeded.length, 1);
        assert.ok(second.seeded[0].added > 0 && second.seeded[0].taken);
        assert.equal(await here.seededWith(), member.sha256);

        // A second launch on this machine opens the same store again, and
        // does not fetch the seed a second time.
        const [seedStart, seedEnd] = /** @type {number[]} */ (carrying.seedSpan);
        const reaches = (/** @type {[number, number][]} */ ranges)=>ranges.some(
            ([offset, length])=>offset < seedEnd && offset + length > seedStart);
        assert.ok(reaches(carrying.ranges), 'the first run fetched the seed');
        const before = carrying.ranges.length;
        const third = await run('cork',
            await createDirectoryTranslationStore(machine, BUNDLE_ID), carrying);
        assert.equal(third.code, first.code);
        assert.ok(third.cork.cacheHits >= 1);
        assert.ok(!reaches(carrying.ranges.slice(before)), 'the second did not');
        assert.deepEqual(third.seeded.map(one=>one.taken), [false]);
    });

test('an engine without the translator leaves the seed alone',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 60000 }, async t=>{
        const carrying = await bundleOf(new Uint8Array(4096).fill(1));
        t.after(()=>carrying.cleanup());
        const store = await freshStore();
        const done = await run('emulator', store, carrying);
        assert.deepEqual(done.seeded, []);
        assert.equal(await store.seededWith(), null);
        const [seedStart, seedEnd] = /** @type {number[]} */ (carrying.seedSpan);
        assert.ok(!carrying.ranges.some(([offset, length])=>offset < seedEnd
            && offset + length > seedStart), 'nothing fetched of it');
    });

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translation store keeps a region's module under `CACHE_VERSION`, and a
 * store written by an older emitter answers a newer one's lookups unless the
 * version moved -- by hand, which is easy to forget. This test is the reminder:
 * it emits a fixed set of regions (the benchmark's programs, integer, x87, SSE
 * and a switch table) under fixed host features and holds the bytes' digest to
 * the one recorded for the current version. A change to what the emitter emits
 * fails it until the version is bumped and the new digest recorded beside it;
 * a past version's digest never changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { formRegion } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { emitRegion, finishModule, prepareModule } from '../emit/region.js';
import { ownLayout, sharedLayout } from './layout.js';
import { CACHE_VERSION } from './cache.js';

/** The digest of the emitted set, by the cache version that emitted it. */
const EMITTED = {
    40: 'e17f16d74ecb4c98',
    41: 'c5230bdf119b527f',
    42: 'c5230bdf119b527f',
    44: '554b022d79a6d89f',
    45: '6484cc2a873ec56d',
    46: 'ab4be65a98ba9a5d',
    47: 'cafc8d6a7e3bb1dd',
    48: 'be8866386ec313a4',
    49: 'be8866386ec313a4',
    50: '9e0716ca01235740',
    51: '9e0716ca01235740',
    52: 'd1714e6d24c522cf',
    53: 'faa5e86638c6dcb1',
    54: '2a2fbc91848b4ca1',
    55: 'b1ac01abec5c15b8',
    56: 'b1ac01abec5c15b8',
    57: 'b1ac01abec5c15b8',
    58: 'b1ac01abec5c15b8',
    59: 'd6b1da6aa1900443',
    60: 'd6b1da6aa1900443',
    61: 'd6b1da6aa1900443',
    62: 'd6b1da6aa1900443',
    63: 'ef74597e733cadf8',
    64: '084c229541bf949f',
    65: '084c229541bf949f',
    66: '61248f6d7d176c75',
    67: '7e7d1e43509cf689',
    68: '8a43dbe66f04a042',
    69: '4b9bb89828ba6a0d',
    70: 'f4fb69e60a252195',
    71: 'c7182f7bf6fe0988',
    72: 'c7182f7bf6fe0988',
    73: 'b695d86ae96d0bc1',
    74: '30cdac2e6a80e999',
    75: '7515af9494d3d745',
    76: 'ec959179598ea60a',
    77: '30cdac2e6a80e999',
    78: '8c7265661448be1f',
    79: '9ebdc6fde6aeba97',
    80: '9ebdc6fde6aeba97',
    81: '501cc728d19eb39b',
    82: 'c151fd95bf630b39',
    83: '0c64d49d49b14315',
    84: '42f0f2f5d3d51fbe',
    85: 'bbc86e076a900b9f',
    86: 'eb6cfc99e139de77',
    87: '920c8f09ff12fb1b',
    88: '9fbd07aebb029be4',
    89: '92cab94d459b71f1',
    90: '92cab94d459b71f1',
    91: '45c665fef42076be',
    92: '18c624d5b1dedc26',
    93: 'c20886250a565df9',
    94: '2ebe93273ec924dd',
    95: '8ccfab65b1fe8ee0',
    96: '2d93d78aa3f4461b',
    97: '2d93d78aa3f4461b',
    98: '930ad71a5c370912',
    99: 'b502a528beab61b1',
    100: 'b502a528beab61b1',
    101: 'b502a528beab61b1',
    102: 'b502a528beab61b1',
    103: 'b502a528beab61b1',
    104: '774d6a5315dfa3d8',
    105: '774d6a5315dfa3d8',
    106: '774d6a5315dfa3d8',
};

/** Features fixed rather than probed, so every host emits the same bytes. */
const FEATURES = { simd: true, tailCalls: true, defaultNaNNegative: false };
const IMAGES = new URL('../../../../tools/cork-bench/images/', import.meta.url);
const BASE = 0x401000;
const ENTRIES = [0x401000, 0x401010];

/** Every region of the set, emitted in turn, into one digest. */
function digest(){
    const hash = createHash('sha256');
    const layout = ownLayout({ ramSize: 16 << 20 });
    for (const name of readdirSync(IMAGES).filter(file=>file.endsWith('.bin')).sort())
    {
        const image = readFileSync(new URL(name, IMAGES));
        const read = (/** @type {number} */ address)=>image[address - BASE] ?? 0;
        // Both ways a store through esp is translated (`looseStacks`).
        for (const [entry, looseStacks] of ENTRIES.flatMap(at=>[
            /** @type {const} */ ([at, false]), /** @type {const} */ ([at, true])]))
        {
            const region = formRegion(read, entry, {});
            const m = new ModuleBuilder();
            const context = prepareModule(m, layout, FEATURES, {}, { hash: true,
                trapPort: 0xb077, resume: true, callReturn: true, looseStacks });
            const translation = emitRegion(context, region, { entryTop: 0, checked: false });
            finishModule(context, [translation.functionIndex]);
            m.exportFunction('region', translation.functionIndex);
            hash.update(`${name}:${entry.toString(16)}:${looseStacks ? 's:' : ''}`)
                .update(m.toBytes());
        }
    }
    // An indirect call predicted to two callees and sampled past them (`callTargets`,
    // `profileCalls`), which no region of the images is: mov ecx, 16; L: mov eax, ecx;
    // and eax, 15; call [0x1100 + eax*4]; dec ecx; jnz L; hlt; F: add edx, 1; ret;
    // G: add edx, 3; ret.
    const code = [0xb9, 16, 0, 0, 0, 0x89, 0xc8, 0x83, 0xe0, 0x0f, 0xff, 0x14, 0x85, 0, 0x11, 0, 0,
        0x49, 0x75, 0xf1, 0xf4, 0x83, 0xc2, 0x01, 0xc3, 0x83, 0xc2, 0x03, 0xc3];
    const region = formRegion(address=>code[address - 0x1000] ?? 0, 0x1000,
        { callTargets: new Map([[0x100a, [0x1015, 0x1019]]]) });
    const m = new ModuleBuilder();
    const context = prepareModule(m, layout, FEATURES, {}, { hash: true, trapPort: 0xb077,
        resume: true, callReturn: true, profileCalls: true });
    const translation = emitRegion(context, region, { entryTop: 0, checked: false });
    finishModule(context, [translation.functionIndex]);
    m.exportFunction('region', translation.functionIndex);
    hash.update('predicted:').update(m.toBytes());
    // The same unpredicted, its call looking for an empty callee in place (`emptySites`).
    const plain = formRegion(address=>code[address - 0x1000] ?? 0, 0x1000, {});
    const sites = new ModuleBuilder();
    const sitesContext = prepareModule(sites, layout, FEATURES, {}, { hash: true,
        trapPort: 0xb077, resume: true, callReturn: true, emptySites: true });
    const atSites = emitRegion(sitesContext, plain, { entryTop: 0, checked: false });
    finishModule(sitesContext, [atSites.functionIndex]);
    sites.exportFunction('region', atSites.functionIndex);
    hash.update('empty sites:').update(sites.toBytes());
    // A call into the host from inside a region (`out dx, eax` to the trap port), the integer
    // registers alone and with x87 ones live: what the handler's answer does to the run --
    // EIP moved, the turn ended -- is emitted after the call. mov ebx, 1; mov dx, 0xb077;
    // mov eax, 7; out dx, eax; inc ebx; hlt, then the same after an fld1.
    const trapped = [0xbb, 1, 0, 0, 0, 0x66, 0xba, 0x77, 0xb0, 0xb8, 7, 0, 0, 0, 0xef, 0x43, 0xf4];
    for (const [name, bytes] of /** @type {const} */ ([['trap', trapped],
        ['trap x87', [0xd9, 0xe8, ...trapped]]]))
    {
        const call = formRegion(address=>bytes[address - 0x1000] ?? 0, 0x1000, {});
        const calls = new ModuleBuilder();
        const callsContext = prepareModule(calls, layout, FEATURES, {}, { hash: true,
            trapPort: 0xb077, resume: true, callReturn: true });
        const atCall = emitRegion(callsContext, call, { entryTop: 0, checked: false });
        finishModule(callsContext, [atCall.functionIndex]);
        calls.exportFunction('region', atCall.functionIndex);
        hash.update(`${name}:`).update(calls.toBytes());
    }
    // Single precision computed on floats (`floatSingles`): fmath's loop of sums of products,
    // and game's loop of distances entered with two floats held, whose code after an
    // indirect call tests the stack it needs.
    for (const [name, entry, entryTop] of /** @type {const} */ ([['fmath-pc24.bin', 0x401050, 0],
        ['game-pc24.bin', 0x4012e0, 6]]))
    {
        const image = readFileSync(new URL(name, IMAGES));
        const loop = formRegion(address=>image[address - BASE] ?? 0, entry, {});
        const floats = new ModuleBuilder();
        const floatsContext = prepareModule(floats, layout, FEATURES, {}, { hash: true,
            trapPort: 0xb077, resume: true, callReturn: true });
        const onFloats = emitRegion(floatsContext, loop, { entryTop, checked: false,
            precision: 'narrow', floats: true });
        finishModule(floatsContext, [onFloats.functionIndex]);
        floats.exportFunction('region', onFloats.functionIndex);
        hash.update(`floats:${name}:`).update(floats.toBytes());
    }
    // A loop of a process of several executors, whose back edge reads the interrupt word
    // (`spentTest`): on the first executor's layout and on the others' shared one, atomic.
    // mov ecx, 1000; L: dec ecx; jnz L; hlt
    const countdown = [0xb9, 0xe8, 0x03, 0, 0, 0x49, 0x75, 0xfd, 0xf4];
    const several = ownLayout({ ramSize: 16 << 20, processors: 2 });
    // And on the layout with guest RAM from the memory's start, a Windows process's.
    const low = ownLayout({ ramSize: 16 << 20, processors: 2, ramBase: 0 });
    for (const [name, at] of /** @type {const} */ ([['several', several],
        ['shared', sharedLayout(several)], ['low', low], ['low shared', sharedLayout(low)]]))
    {
        const loop = formRegion(address=>countdown[address - 0x1000] ?? 0, 0x1000, {});
        const loops = new ModuleBuilder();
        const loopsContext = prepareModule(loops, at, FEATURES, {}, { hash: true,
            trapPort: 0xb077, resume: true, callReturn: true, atomic: true });
        const atLoop = emitRegion(loopsContext, loop, { entryTop: 0, checked: false });
        finishModule(loopsContext, [atLoop.functionIndex]);
        loops.exportFunction('region', atLoop.functionIndex);
        hash.update(`${name}:`).update(loops.toBytes());
    }
    return hash.digest('hex').slice(0, 16);
}

test('what the emitter emits is the digest recorded for this cache version', ()=>{
    const now = digest();
    assert.equal(EMITTED[/** @type {keyof typeof EMITTED} */ (CACHE_VERSION)], now,
        `the emitted code is ${now}: if the emitter changed on purpose, bump CACHE_VERSION`
        + ' (runtime/cache.js) and record the digest under the new version');
});

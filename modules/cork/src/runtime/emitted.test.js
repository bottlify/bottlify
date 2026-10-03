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
import { ownLayout } from './layout.js';
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
    77: '30cdac2e6a80e999',
    78: '8c7265661448be1f',
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
    return hash.digest('hex').slice(0, 16);
}

test('what the emitter emits is the digest recorded for this cache version', ()=>{
    const now = digest();
    assert.equal(EMITTED[/** @type {keyof typeof EMITTED} */ (CACHE_VERSION)], now,
        `the emitted code is ${now}: if the emitter changed on purpose, bump CACHE_VERSION`
        + ' (runtime/cache.js) and record the digest under the new version');
});

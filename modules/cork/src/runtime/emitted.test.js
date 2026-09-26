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
import { emitRegion, prepareModule } from '../emit/region.js';
import { ownLayout } from './layout.js';
import { CACHE_VERSION } from './cache.js';

/** The digest of the emitted set, by the cache version that emitted it. */
const EMITTED = {
    40: 'e17f16d74ecb4c98',
    41: 'c5230bdf119b527f',
    42: 'c5230bdf119b527f',
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
        for (const entry of ENTRIES)
        {
            const region = formRegion(read, entry, {});
            const m = new ModuleBuilder();
            const context = prepareModule(m, layout, FEATURES, {},
                { hash: true, trapPort: 0xb077 });
            const translation = emitRegion(context, region, { entryTop: 0, checked: false });
            m.exportFunction('region', translation.functionIndex);
            hash.update(`${name}:${entry.toString(16)}:`).update(m.toBytes());
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

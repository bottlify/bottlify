/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPTIONAL_GPU_FEATURES, gpuFeaturesOf } from './features.js';

test('a device asks for the optional features its adapter has, and no others', ()=>{
    const adapter = { features: new Set(['clip-distances', 'shader-f16']) };
    assert.deepEqual(gpuFeaturesOf(adapter), ['clip-distances']);
    assert.deepEqual(gpuFeaturesOf({ features: new Set() }), []);
    assert.deepEqual(gpuFeaturesOf({ features: new Set(OPTIONAL_GPU_FEATURES) }),
        [...OPTIONAL_GPU_FEATURES]);
});

test('every place a device is made asks through the one list', ()=>{
    // A list written out twice drifted once: the page's device lacked
    // clip-distances, so a draw made there clipped by discard and one made in
    // the graphics worker by the rasteriser.
    for (const file of ['../remote/worker.js', '../../../host/serve.js'])
    {
        const text = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.match(text, /requestDevice\(\{ requiredFeatures: gpuFeaturesOf\(adapter\) \}\)/,
            file);
    }
});

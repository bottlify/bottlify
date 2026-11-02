/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPTIONAL_GPU_FEATURES, RAISED_GPU_LIMITS, gpuFeaturesOf, gpuLimitsOf }
    from './features.js';

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
    // The harness's page too: its own list of two drew the Wine tests' 32-bit
    // float targets at half precision, where the launcher keeps them whole.
    for (const file of ['../remote/worker.js', '../../../host/serve.js',
        '../../../../test/page/game/harness.js'])
    {
        const text = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.match(text, /requestDevice\(\{ requiredFeatures: gpuFeaturesOf\(adapter\),\s+requiredLimits: gpuLimitsOf\(adapter\) \}\)/,
            file);
    }
});

test('a target of R11G11B10_FLOAT is asked for, where the adapter draws into one', ()=>{
    // Not asked for, every frame drawn into the HDR target a Direct3D 10 or 11
    // program makes was refused.
    assert.ok(OPTIONAL_GPU_FEATURES.includes('rg11b10ufloat-renderable'));
    assert.deepEqual(gpuFeaturesOf({ features: new Set(['rg11b10ufloat-renderable']) }),
        ['rg11b10ufloat-renderable']);
});

test('a device asks for its adapter\'s limits, not WebGPU\'s defaults', ()=>{
    // WebGPU's defaults are 8192 a side and 16 sampled textures a stage;
    // Direct3D 11 promises 16384 and 128.
    const limits = { maxTextureDimension2D: 16384, maxSampledTexturesPerShaderStage: 128,
        minUniformBufferOffsetAlignment: 256 };
    assert.deepEqual(gpuLimitsOf({ limits }),
        { maxTextureDimension2D: 16384, maxSampledTexturesPerShaderStage: 128 });
    assert.deepEqual(gpuLimitsOf({}), {});
    // An alignment is a limit asked for at its least, never its most.
    assert.ok(RAISED_GPU_LIMITS.every(name=>name.startsWith('max')));
});

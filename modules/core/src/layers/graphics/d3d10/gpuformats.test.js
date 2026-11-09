/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3D10_BIND, DXGI_FORMAT } from './constants.js';
import { gpuRenderable, textureStorage } from './gpuformats.js';

test('the 16-bit normalised formats are themselves with texture-formats-tier1 and 32-bit floats'
    + ' without; the snorm and 11-11-10 targets are drawn only with their features', ()=>{
    /** @type {[number, string, string, string][]} */
    const cases = [
        [DXGI_FORMAT.R16G16B16A16_UNORM, 'rgba16unorm', 'rgba32float', 'rgba16unorm'],
        [DXGI_FORMAT.R16G16B16A16_SNORM, 'rgba16snorm', 'rgba32float', 'rgba16snorm'],
        [DXGI_FORMAT.R16G16_UNORM, 'rg16unorm', 'rg32float', 'rg16unorm'],
        [DXGI_FORMAT.R16_SNORM, 'r16snorm', 'r32float', 'r16snorm'],
        [DXGI_FORMAT.R16_UNORM, 'r16unorm', 'r32float', 'r16unorm']];
    for (const [format, own, standIn, conversion] of cases)
    {
        assert.equal(textureStorage(format, 0)?.format, own, `${format} with tier1`);
        assert.equal(textureStorage(format, 0)?.conversion, null);
        const kept = textureStorage(format, 0, { formatsTier1: false });
        assert.equal(kept?.format, standIn, `${format}`);
        assert.equal(kept?.conversion, conversion);
    }
    assert.equal(textureStorage(DXGI_FORMAT.R16_TYPELESS, D3D10_BIND.DEPTH_STENCIL,
        { formatsTier1: false })?.format, 'depth16unorm', 'a depth stays a depth');
    assert.equal(gpuRenderable('rgba8snorm', { formatsTier1: false }), false);
    assert.equal(gpuRenderable('rgba8snorm', { formatsTier1: true }), true);
    assert.equal(gpuRenderable('rg11b10ufloat', { rg11b10Renderable: false }), false);
    assert.equal(gpuRenderable('rg11b10ufloat',
        { rg11b10Renderable: false, formatsTier1: true }), true);
    assert.equal(gpuRenderable('rgba8unorm', { formatsTier1: false }), true);
});

test('a 32-bit depth with stencil keeps 24 bits on a device without the feature for 32', ()=>{
    const format = DXGI_FORMAT.D32_FLOAT_S8X24_UINT;
    assert.equal(textureStorage(format, D3D10_BIND.DEPTH_STENCIL)?.format,
        'depth32float-stencil8');
    assert.equal(textureStorage(format, D3D10_BIND.DEPTH_STENCIL,
        { depth32Stencil: false })?.format, 'depth24plus-stencil8');
    assert.equal(textureStorage(format, D3D10_BIND.DEPTH_STENCIL,
        { depth32Stencil: false })?.depth, true);
});

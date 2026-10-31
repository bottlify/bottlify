/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3D10_BIND, DXGI_FORMAT } from './constants.js';
import { textureStorage } from './gpuformats.js';

test('a 32-bit depth with stencil keeps 24 bits on a device without the feature for 32', ()=>{
    const format = DXGI_FORMAT.D32_FLOAT_S8X24_UINT;
    assert.equal(textureStorage(format, D3D10_BIND.DEPTH_STENCIL)?.format,
        'depth32float-stencil8');
    assert.equal(textureStorage(format, D3D10_BIND.DEPTH_STENCIL,
        { depth32Stencil: false })?.format, 'depth24plus-stencil8');
    assert.equal(textureStorage(format, D3D10_BIND.DEPTH_STENCIL,
        { depth32Stencil: false })?.depth, true);
});

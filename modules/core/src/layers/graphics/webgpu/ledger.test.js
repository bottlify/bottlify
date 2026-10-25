/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { textureBytes, trackDevice } from './ledger.js';

test('a texture weighs its texels at every level, a compressed one by whole blocks', ()=>{
    assert.equal(textureBytes({ size: [256, 256], format: 'rgba8unorm' }).bytes, 256 * 256 * 4);
    // 256 + 64 + 16 + 4 + 1 texels a side squared: every level.
    assert.equal(textureBytes({ size: { width: 16, height: 16 }, format: 'rgba8unorm',
        mipLevelCount: 5 }).bytes, (256 + 64 + 16 + 4 + 1) * 4);
    // BC1 at half a byte a texel, and a 1x1 level still a whole 4x4 block.
    assert.equal(textureBytes({ size: [4, 4], format: 'bc1-rgba-unorm', mipLevelCount: 3 }).bytes,
        3 * 16 * 0.5);
    assert.equal(textureBytes({ size: [8, 8, 6], format: 'r8unorm' }).bytes, 8 * 8 * 6,
        'six layers');
    assert.equal(textureBytes({ size: [8, 8], format: 'depth24plus', sampleCount: 4 }).bytes,
        8 * 8 * 4 * 4);
    assert.deepEqual(textureBytes({ size: [2, 2], format: 'r8-something' }),
        { bytes: 16, weighed: false }, 'an unknown format at four bytes, said so');
});

test('the ledger weighs what is made, takes off what is destroyed, and names the heaviest', ()=>{
    const device = {
        createBuffer: (/** @type {any} */ descriptor)=>({ descriptor, destroy(){} }),
        createTexture: (/** @type {any} */ descriptor)=>({ descriptor, destroy(){} }),
    };
    const ledger = trackDevice(device);
    const vertices = device.createBuffer({ label: 'vertices', size: 1 << 20, usage: 0x20 });
    device.createBuffer({ label: 'vertices', size: 1 << 20, usage: 0x20 });
    device.createBuffer({ size: 64, usage: 0x40 });
    const target = device.createTexture({ label: 'target', size: [1024, 1024],
        format: 'rgba8unorm' });
    let held = ledger.diagnostics();
    assert.deepEqual(held.buffers, { count: 3, bytes: 2 * (1 << 20) + 64 });
    assert.deepEqual(held.textures, { count: 1, bytes: 4 << 20 });
    assert.equal(held.heaviestBuffers[0], 'vertices: 2 2.0 MB');
    assert.equal(held.heaviestBuffers[1], 'usage 0x40: 1 0.0 MB', 'an unlabelled one by its usage');

    vertices.destroy();
    vertices.destroy();
    target.destroy();
    held = ledger.diagnostics();
    assert.deepEqual(held.buffers, { count: 2, bytes: (1 << 20) + 64 },
        'destroyed once, counted once');
    assert.deepEqual(held.textures, { count: 0, bytes: 0 });
    assert.deepEqual(held.made, { buffers: 3, textures: 1, unweighed: 0 });
});

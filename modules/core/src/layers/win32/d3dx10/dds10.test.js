/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dxgiLayout, halveTexels } from './dds10.js';

test('a DXGI format\'s rows: texels, 4x4 blocks, pairs and bits', ()=>{
    assert.deepEqual(dxgiLayout(61, 256, 1), { rowBytes: 256, rows: 1 }, 'R8_UNORM');
    assert.deepEqual(dxgiLayout(10, 4, 2), { rowBytes: 32, rows: 2 }, 'R16G16B16A16_FLOAT');
    assert.deepEqual(dxgiLayout(6, 3, 1), { rowBytes: 36, rows: 1 }, 'R32G32B32_FLOAT');
    assert.deepEqual(dxgiLayout(2, 1, 1), { rowBytes: 16, rows: 1 }, 'R32G32B32A32_FLOAT');
    assert.deepEqual(dxgiLayout(24, 2, 2), { rowBytes: 8, rows: 2 }, 'R10G10B10A2_UNORM');
    assert.deepEqual(dxgiLayout(49, 2, 2), { rowBytes: 4, rows: 2 }, 'R8G8_UNORM');
    assert.deepEqual(dxgiLayout(54, 3, 1), { rowBytes: 6, rows: 1 }, 'R16_FLOAT');
    assert.deepEqual(dxgiLayout(87, 2, 1), { rowBytes: 8, rows: 1 }, 'B8G8R8A8_UNORM');
    assert.deepEqual(dxgiLayout(71, 5, 5), { rowBytes: 16, rows: 2 }, 'BC1: 8 bytes a block');
    assert.deepEqual(dxgiLayout(83, 1, 1), { rowBytes: 16, rows: 1 }, 'BC5: 16 a block');
    assert.deepEqual(dxgiLayout(80, 8, 4), { rowBytes: 16, rows: 1 }, 'BC4: 8 a block');
    assert.deepEqual(dxgiLayout(98, 4, 4), { rowBytes: 16, rows: 1 }, 'BC7');
    assert.deepEqual(dxgiLayout(68, 3, 1), { rowBytes: 8, rows: 1 }, 'R8G8_B8G8: pairs');
    assert.deepEqual(dxgiLayout(66, 9, 2), { rowBytes: 2, rows: 2 }, 'R1_UNORM: bits');
    assert.equal(dxgiLayout(0, 1, 1), null, 'DXGI_FORMAT_UNKNOWN');
    assert.equal(dxgiLayout(103, 1, 1), null, 'a video format');
});

test('a level of byte channels halved: each byte the rounded average of the two by two', ()=>{
    const { data, width, height } = halveTexels(Uint8Array.of(0, 1, 4, 6, 10, 11, 14, 17), 4, 2,
        1, true);
    assert.deepEqual([width, height, ...data], [2, 1, 6, 10]);
    assert.deepEqual([...halveTexels(Uint8Array.of(9, 1, 1, 1), 2, 2, 1, false).data], [9],
        'or the top-left texel');
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DXGI_FORMAT } from './constants.js';
import { channelsOf, clearElement, clearTexel, halfBits, halfOf } from './uavclear.js';

const bitsOf = (/** @type {number} */ value)=>new Uint32Array(new Float32Array([value]).buffer)[0];

test('a format is read as its channels in memory order', ()=>{
    assert.deepEqual(channelsOf(DXGI_FORMAT.B8G8R8A8_UNORM)?.channels.map(c=>c.value),
        [2, 1, 0, 3]);
    assert.deepEqual(channelsOf(DXGI_FORMAT.R10G10B10A2_UINT)?.channels.map(c=>c.bits),
        [10, 10, 10, 2]);
    assert.equal(channelsOf(DXGI_FORMAT.R11G11B10_FLOAT), null);
    assert.equal(channelsOf(DXGI_FORMAT.BC1_UNORM), null);
});

test('a Uint clear copies the low bits, a Float clear converts, and on integers does nothing', ()=>{
    assert.deepEqual([...clearElement(DXGI_FORMAT.R8G8B8A8_UINT, [0x101, 2, 3, 0x1ff], false)
        ?? []], [1, 2, 3, 0xff]);
    assert.deepEqual([...clearElement(DXGI_FORMAT.R8G8B8A8_UNORM, [1, 0.5, 0, 2], true) ?? []],
        [255, 128, 0, 255]);
    assert.deepEqual([...clearElement(DXGI_FORMAT.R8G8B8A8_SNORM, [-1, 1, 0, 0], true) ?? []],
        [0x81, 0x7f, 0, 0]);
    assert.equal(clearElement(DXGI_FORMAT.R32_UINT, [1, 0, 0, 0], true), null);
    assert.deepEqual([...clearElement(DXGI_FORMAT.R16G16_FLOAT, [1, -2, 0, 0], true) ?? []],
        [0x00, 0x3c, 0x00, 0xc0]);
    assert.deepEqual([...clearElement(DXGI_FORMAT.R10G10B10A2_UINT, [0x3ff, 0, 0, 3], false)
        ?? []], [0xff, 0x03, 0x00, 0xc0]);
});

test('a texel is written as WGSL stores it', ()=>{
    assert.deepEqual([...clearTexel(DXGI_FORMAT.R8G8B8A8_UNORM, [255, 0, 0x180, 0], false)
        ?? []], [bitsOf(1), 0, bitsOf(128 / 255), 0]);
    assert.deepEqual([...clearTexel(DXGI_FORMAT.R32_SINT, [0xffffffff, 0, 0, 0], false) ?? []],
        [0xffffffff, 0, 0, 0]);
    assert.deepEqual([...clearTexel(DXGI_FORMAT.R16G16B16A16_SINT, [0xffff, 1, 0, 0], false)
        ?? []], [0xffffffff, 1, 0, 0]);
    assert.deepEqual([...clearTexel(DXGI_FORMAT.R32_FLOAT, [0.25, 0, 0, 0], true) ?? []],
        [bitsOf(0.25), 0, 0, 0]);
});

test('halves round to nearest and come back', ()=>{
    for (const value of [0, 1, -2, 0.5, 65504, 2 ** -24, 1 / 3])
    {
        assert.equal(halfOf(halfBits(value)), Math.fround(halfOf(halfBits(value))));
    }
    assert.equal(halfBits(1), 0x3c00);
    assert.equal(halfBits(70000), 0x7c00);
    assert.equal(halfBits(2 ** -24), 1);
    assert.equal(halfOf(0x3555), 0.333251953125);
    assert.equal(halfBits(1 / 3), 0x3555);
});

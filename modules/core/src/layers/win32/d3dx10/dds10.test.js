/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImageError } from '../d3dx9/images.js';
import { DIMENSION, dxgiLayout, isDxgiDds, readDxgiDds } from './dds10.js';
import { dds10 } from './dds10.fixture.js';

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

test('a DX10 DDS: the file\'s DXGI format, each level cut where the one before ends', ()=>{
    // R16G16B16A16_FLOAT 4x2, three levels: 64, 16 and 8 bytes.
    const file = dds10({ width: 4, height: 2, format: 10, mips: 3, bytes: 88 });
    assert.ok(isDxgiDds(file));
    const image = readDxgiDds(file);
    assert.equal(image.dxgi, 10);
    assert.equal(image.dimension, DIMENSION.TEXTURE2D);
    assert.deepEqual([image.width, image.height, image.mipLevels, image.arraySize],
        [4, 2, 3, 1]);
    assert.deepEqual(image.levels.map(level=>[level.width, level.height, level.data.length,
        level.data[0]]), [[4, 2, 64, 0], [2, 1, 16, 64], [1, 1, 8, 80]]);
    assert.equal(image.faces, undefined, 'one slice');
});

test('a DX10 DDS cube array is six faces a slice, each its chain; a volume each level\'s'
    + ' slices', ()=>{
    // Two cubes of R8_UNORM 2x2, two levels: 12 faces of 4 + 1 bytes.
    const cubes = readDxgiDds(dds10({ width: 2, height: 2, format: 61, misc: 0x4, arraySize: 2,
        mips: 2, bytes: 60 }));
    assert.equal(cubes.cube, true);
    assert.equal(cubes.arraySize, 12);
    assert.equal(cubes.faces?.length, 12);
    assert.deepEqual(cubes.faces?.map(chain=>chain[0].data[0]),
        Array.from({ length: 12 }, (_, face)=>face * 5));

    // A 4x4x2 volume of R8_UNORM, three levels: 2 slices of 16, 1 of 4, 1 of 1.
    const volume = readDxgiDds(dds10({ width: 4, height: 4, depth: 2, format: 61,
        dimension: DIMENSION.TEXTURE3D, mips: 3, bytes: 37 }));
    assert.equal(volume.depth, 2);
    const slices = volume.volume?.map(level=>level.map(slice=>[slice.width, slice.data.length,
        slice.data[0]]));
    assert.deepEqual(slices, [[[4, 16, 0], [4, 16, 16]], [[2, 4, 32]], [[1, 1, 36]]]);

    const line = readDxgiDds(dds10({ width: 8, height: 5, format: 61,
        dimension: DIMENSION.TEXTURE1D, bytes: 8 }));
    assert.equal(line.height, 1, 'a 1D texture is one row, whatever the header\'s height');
});

test('a DX10 DDS this loader cannot lay out, or cut short, is invalid data', ()=>{
    assert.throws(()=>readDxgiDds(dds10({ width: 2, format: 103, bytes: 8 })), ImageError);
    assert.throws(()=>readDxgiDds(dds10({ width: 2, format: 0, bytes: 8 })), ImageError);
    assert.throws(()=>readDxgiDds(dds10({ width: 4, height: 4, format: 61, mips: 2, bytes: 19 })),
        /cut short/);
    assert.throws(()=>readDxgiDds(dds10({ width: 2, format: 61, dimension: 5, bytes: 2 })),
        ImageError);
    const classic = dds10({ width: 2, format: 61, bytes: 2 });
    classic.set([0x44, 0x58, 0x54, 0x31], 84);
    assert.equal(isDxgiDds(classic), false, 'a classic FourCC is D3DX 9\'s reader\'s');
});

/**
 * A classic DDS (no DX10 extension) with a FourCC and caps2 of its own.
 *
 * @param {number | string} code @param {number} width @param {number} height
 * @param {number} mips @param {number} caps2 @param {number} bytes
 */
function classicDds(code, width, height, mips, caps2, bytes){
    const file = new Uint8Array(128 + bytes);
    const view = new DataView(file.buffer);
    file.set([0x44, 0x44, 0x53, 0x20]);
    view.setUint32(4, 124, true);
    view.setUint32(8, 0x20007, true);
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(28, mips, true);
    view.setUint32(76, 32, true);
    view.setUint32(80, 0x4, true);
    view.setUint32(84, typeof code === 'number' ? code
        : [...code].reduce((word, c, i)=>word | c.charCodeAt(0) << i * 8, 0) >>> 0, true);
    view.setUint32(112, caps2, true);
    // Texel bytes counting from 0 right after the classic header.
    for (let i = 128; i < file.length; i++)
    {
        file[i] = (i - 128) & 0xff;
    }
    return file;
}

test('a classic DDS whose FourCC names a DXGI format is read in it: ATI2 is BC5', ()=>{
    // 8x8 BC5, two levels: 4 blocks of 16, then 1.
    const file = classicDds('ATI2', 8, 8, 2, 0, 80);
    assert.ok(isDxgiDds(file));
    const image = readDxgiDds(file);
    assert.equal(image.dxgi, 83);
    assert.deepEqual(image.levels.map(level=>[level.width, level.data.length, level.data[0]]),
        [[8, 64, 0], [4, 16, 64]], 'the texels right after the classic header');

    // A cube of A16B16G16R16F (D3DFORMAT 113) 1x1: six faces of 8 bytes.
    const cube = readDxgiDds(classicDds(113, 1, 1, 1, 0xfe00, 48));
    assert.equal(cube.dxgi, 10, 'DXGI_FORMAT_R16G16B16A16_FLOAT');
    assert.equal(cube.cube, true);
    assert.deepEqual(cube.faces?.map(face=>face[0].data[0]), [0, 8, 16, 24, 32, 40]);
    assert.throws(()=>readDxgiDds(classicDds('ATI1', 4, 4, 1, 0x0600, 48)), /six faces/);
    assert.equal(isDxgiDds(classicDds('DXT1', 4, 4, 1, 0, 8)), false, 'D3DX 9\'s reader\'s');
});

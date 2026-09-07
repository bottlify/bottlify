/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COPY_BYTES_PER_ROW_ALIGNMENT,
    blockInfo,
    createTextureUploader,
    repackRows,
} from './textures.js';
import { createFakeDevice } from './fake-device.js';

/** @param {any} [options] */
function uploader(options = {}){
    const gpu = createFakeDevice();
    /** @type {any[]} */
    const copies = [];
    const upload = createTextureUploader({
        device: gpu.device,
        queue: gpu.queue,
        encodeCopy: (source, destination, size)=>copies.push({ source, destination, size }),
        ...options,
    });
    return { gpu, copies, upload };
}

test('a block-compressed format reports its block geometry, not four bytes a pixel', ()=>{
    assert.deepEqual(blockInfo('bc1-rgba-unorm'),
        { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8, compressed: true });
    assert.deepEqual(blockInfo('bc3-rgba-unorm'),
        { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16, compressed: true });
    assert.deepEqual(blockInfo('astc-8x5-unorm'),
        { blockWidth: 8, blockHeight: 5, bytesPerBlock: 16, compressed: true });
    assert.deepEqual(blockInfo('rgba8unorm'),
        { blockWidth: 1, blockHeight: 1, bytesPerBlock: 4, compressed: false });
});

test('rows are repacked to the copy alignment with the padding left zeroed', ()=>{
    const rows = 3;
    const bytesPerRow = 12;
    const source = new Uint8Array(rows * bytesPerRow);
    source.forEach((_value, index)=>{
        source[index] = index + 1;
    });

    const packed = repackRows(source, { rows, bytesPerRow, alignedBytesPerRow: 256 });

    assert.equal(packed.length, rows * 256);
    for (let row = 0; row < rows; row++){
        const at = row * 256;
        assert.deepEqual(Array.from(packed.slice(at, at + bytesPerRow)),
            Array.from(source.slice(row * bytesPerRow, (row + 1) * bytesPerRow)),
            `row ${row} arrived intact at its aligned offset`);
        assert.ok(packed.slice(at + bytesPerRow, at + 256).every(byte=>byte === 0),
            `row ${row} padding is zero, not the neighbouring row`);
    }
});

test('an already-aligned row pitch is repacked without moving anything', ()=>{
    const source = new Uint8Array(512).fill(7);
    const packed = repackRows(source, { rows: 2, bytesPerRow: 256, alignedBytesPerRow: 256 });
    assert.deepEqual(packed, source);
});

test('a compressed upload goes through a staging buffer, never a direct write', ()=>{
    const { gpu, copies, upload } = uploader();
    const texture = gpu.device.createTexture({ label: 'atlas' });
    // 16x16 BC1 is 4x4 blocks of 8 bytes: 32 bytes a row, four rows.
    const data = new Uint8Array(4 * 32).fill(0x5a);

    upload({ texture, format: 'bc1-rgba-unorm', width: 16, height: 16, data });

    assert.equal(gpu.count('writeTexture'), 0,
        'a spec-correct direct write can be dropped with no error raised');
    assert.equal(copies.length, 1, 'the copy was encoded, buffer to texture');

    const staged = gpu.of('writeBuffer');
    assert.equal(staged.length, 1);
    assert.equal(copies[0].source.bytesPerRow % COPY_BYTES_PER_ROW_ALIGNMENT, 0,
        'the row pitch the copy declares satisfies the alignment the API demands');
    assert.equal(copies[0].source.bytesPerRow, 256);
    assert.equal(copies[0].source.rowsPerImage, 4, 'rows of blocks, not rows of pixels');
    assert.equal(staged[0].size, 4 * 256);
    assert.equal(staged[0].bytes[0], 0x5a);
    assert.equal(staged[0].bytes[32], 0, 'the tail of the first row is padding');
    assert.equal(staged[0].bytes[256], 0x5a, 'the second row starts at the aligned offset');
});

test('an uncompressed upload takes the direct path unless staging is asked for', ()=>{
    const { gpu, copies, upload } = uploader();
    const texture = gpu.device.createTexture({ label: 'surface' });
    const data = new Uint8Array(8 * 8 * 4);

    upload({ texture, format: 'rgba8unorm', width: 8, height: 8, data });
    assert.equal(gpu.count('writeTexture'), 1);
    assert.equal(copies.length, 0);
    assert.equal(gpu.of('writeTexture')[0].layout.bytesPerRow, 32);

    upload({ texture, format: 'rgba8unorm', width: 8, height: 8, data, staging: true });
    assert.equal(copies.length, 1, 'the staging path stays available for any format');
});

test('a compressed upload may not be forced onto the direct path by accident', ()=>{
    const { gpu, upload } = uploader();
    const texture = gpu.device.createTexture({});
    const data = new Uint8Array(32);

    assert.throws(
        ()=>upload(
            { texture, format: 'bc1-rgba-unorm', width: 4, height: 4, data, staging: false }),
        /compressed/);
});

test('a partial upload carries its origin and mip level through to the copy', ()=>{
    const { gpu, copies, upload } = uploader();
    const texture = gpu.device.createTexture({});
    // 8x8 BC3 is 2x2 blocks of 16 bytes: 32 bytes a row, two rows.
    const data = new Uint8Array(2 * 32).fill(1);

    upload({
        texture,
        format: 'bc3-rgba-unorm',
        width: 8,
        height: 8,
        data,
        origin: { x: 16, y: 8 },
        mipLevel: 2,
    });

    assert.equal(copies[0].destination.mipLevel, 2);
    assert.deepEqual(copies[0].destination.origin, { x: 16, y: 8, z: 0 });
    assert.deepEqual(copies[0].size,
        { width: 8, height: 8, depthOrArrayLayers: 1 });
});

test('a size that does not match the data is refused before it reaches the driver', ()=>{
    const { gpu, upload } = uploader();
    const texture = gpu.device.createTexture({});

    assert.throws(
        ()=>upload({
            texture,
            format: 'bc1-rgba-unorm',
            width: 16,
            height: 16,
            data: new Uint8Array(16),
        }),
        /needs 128 bytes/);
});

test('an unknown format without an explicit pitch is an error, not a guess', ()=>{
    const { gpu, upload } = uploader();
    const texture = gpu.device.createTexture({});

    assert.throws(
        ()=>upload({ texture, format: 'r64unorm', width: 4, height: 4, data: new Uint8Array(64) }),
        /Unknown format/);
});

test('every upload is reported with its size, staged or direct', ()=>{
    /** @type {any[]} */
    const seen = [];
    const { gpu, upload } = uploader({ onUpload: (/** @type {any} */ record)=>seen.push(record) });
    const texture = gpu.device.createTexture({ label: 'atlas' });

    upload({ texture, format: 'rgba8unorm', width: 8, height: 8, data: new Uint8Array(256) });
    upload({
        texture,
        format: 'bc1-rgba-unorm',
        width: 16,
        height: 16,
        data: new Uint8Array(128),
    });

    assert.deepEqual(seen.map(record=>record.staged), [false, true]);
    assert.deepEqual(seen.map(record=>record.bytes), [256, 1024],
        'the staged upload costs the padded size, which is what actually travels');
});

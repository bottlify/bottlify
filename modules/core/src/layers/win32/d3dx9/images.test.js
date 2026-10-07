/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IFF, ImageError, readImage } from './images.js';
import { FMT } from './pixels.js';

/** @param {number[]} bytes @param {number} at @param {number} value @param {number} size */
function put(bytes, at, value, size){
    for (let k = 0; k < size; k++)
    {
        bytes[at + k] = value >>> (k * 8) & 0xff;
    }
}

/** A TGA header. @param {number} type @param {number} width @param {number} height
 * @param {number} depth @param {number} descriptor */
function tgaHeader(type, width, height, depth, descriptor){
    const h = new Array(18).fill(0);
    h[2] = type;
    put(h, 12, width, 2);
    put(h, 14, height, 2);
    h[16] = depth;
    h[17] = descriptor;
    return h;
}

test('a 24-bit TGA is read bottom row first, as its origin says', ()=>{
    // Bottom-left origin: the first row in the file is the bottom one.
    const file = Uint8Array.from([...tgaHeader(2, 2, 2, 24, 0),
        1, 2, 3, 4, 5, 6, // bottom: (b, g, r) pairs
        7, 8, 9, 10, 11, 12]); // top
    const image = readImage(file);
    assert.equal(image.fileFormat, IFF.TGA);
    assert.equal(image.format, FMT.R8G8B8);
    assert.deepEqual([...image.levels[0].data],
        [7, 8, 9, 255, 10, 11, 12, 255, 1, 2, 3, 255, 4, 5, 6, 255]);
});

test('a run-length TGA of 32 bits, top row first, keeps its alpha', ()=>{
    const file = Uint8Array.from([...tgaHeader(10, 3, 1, 32, 0x28),
        0x81, 1, 2, 3, 40, // a run of two
        0x00, 5, 6, 7, 80]); // one raw texel
    const image = readImage(file);
    assert.equal(image.format, FMT.A8R8G8B8);
    assert.deepEqual([...image.levels[0].data], [1, 2, 3, 40, 1, 2, 3, 40, 5, 6, 7, 80]);
});

test('a 24-bit bitmap is read bottom-up, each row padded to four bytes', ()=>{
    const width = 1;
    const height = 2;
    const header = new Array(54).fill(0);
    header[0] = 0x42;
    header[1] = 0x4d;
    put(header, 10, 54, 4);
    put(header, 14, 40, 4);
    put(header, 18, width, 4);
    put(header, 22, height, 4);
    put(header, 26, 1, 2);
    put(header, 28, 24, 2);
    const file = Uint8Array.from([...header, 1, 2, 3, 0, 4, 5, 6, 0]);
    const image = readImage(file);
    assert.equal(image.fileFormat, IFF.BMP);
    assert.equal(image.format, FMT.R8G8B8);
    assert.deepEqual([...image.levels[0].data], [4, 5, 6, 255, 1, 2, 3, 255]);
});

test('an 8-bit bitmap looks its texels up in the palette; a 565 one reads its bit fields', ()=>{
    const header = new Array(54).fill(0);
    header[0] = 0x42;
    header[1] = 0x4d;
    put(header, 10, 54 + 8, 4);
    put(header, 14, 40, 4);
    put(header, 18, 2, 4);
    put(header, 22, -1, 4); // top-down
    put(header, 28, 8, 2);
    put(header, 46, 2, 4);
    const paletted = Uint8Array.from([...header, 10, 20, 30, 0, 40, 50, 60, 0, 1, 0, 0, 0]);
    assert.deepEqual([...readImage(paletted).levels[0].data],
        [40, 50, 60, 255, 10, 20, 30, 255]);

    const fields = new Array(66).fill(0);
    fields[0] = 0x42;
    fields[1] = 0x4d;
    put(fields, 10, 66, 4);
    put(fields, 14, 40, 4);
    put(fields, 18, 1, 4);
    put(fields, 22, 1, 4);
    put(fields, 28, 16, 2);
    put(fields, 30, 3, 4);
    put(fields, 54, 0xf800, 4);
    put(fields, 58, 0x7e0, 4);
    put(fields, 62, 0x1f, 4);
    const image = readImage(Uint8Array.from([...fields, 0x00, 0xf8, 0, 0]));
    assert.equal(image.format, FMT.R5G6B5);
    assert.deepEqual([...image.levels[0].data], [0, 0, 255, 255]);
});

/** A DDS header. @param {Record<string, number>} fields */
function ddsHeader(fields){
    const h = new Array(128).fill(0);
    h[0] = 0x44; h[1] = 0x44; h[2] = 0x53; h[3] = 0x20;
    put(h, 4, 124, 4);
    put(h, 8, fields.flags ?? 0x1007, 4);
    put(h, 12, fields.height, 4);
    put(h, 16, fields.width, 4);
    put(h, 28, fields.mips ?? 0, 4);
    put(h, 76, 32, 4);
    put(h, 80, fields.pfFlags, 4);
    put(h, 84, fields.fourCC ?? 0, 4);
    put(h, 88, fields.bits ?? 0, 4);
    put(h, 92, fields.r ?? 0, 4);
    put(h, 96, fields.g ?? 0, 4);
    put(h, 100, fields.b ?? 0, 4);
    put(h, 104, fields.a ?? 0, 4);
    return h;
}

test('a DXT1 DDS keeps its blocks and every level it holds', ()=>{
    const header = ddsHeader({ flags: 0x21007, width: 8, height: 4, mips: 3, pfFlags: 0x4,
        fourCC: FMT.DXT1 });
    // Level 0 is two blocks, levels 1 and 2 one each.
    const blocks = Array.from({ length: 4 * 8 }, (_, i)=>i);
    const image = readImage(Uint8Array.from([...header, ...blocks]));
    assert.equal(image.fileFormat, IFF.DDS);
    assert.equal(image.format, FMT.DXT1);
    assert.equal(image.mipLevels, 3);
    assert.deepEqual(image.levels.map(l=>[l.width, l.height, l.format, l.data.length]),
        [[8, 4, FMT.DXT1, 16], [4, 2, FMT.DXT1, 8], [2, 1, FMT.DXT1, 8]]);
    assert.deepEqual([...image.levels[1].data], blocks.slice(16, 24));
});

test('an uncompressed DDS is named by its masks and read into texels', ()=>{
    const header = ddsHeader({ width: 1, height: 1, pfFlags: 0x41, bits: 32,
        r: 0xff0000, g: 0xff00, b: 0xff, a: 0xff000000 });
    const image = readImage(Uint8Array.from([...header, 1, 2, 3, 4]));
    assert.equal(image.format, FMT.A8R8G8B8);
    assert.deepEqual([...image.levels[0].data], [1, 2, 3, 4]);
    const luminance = ddsHeader({ width: 1, height: 1, pfFlags: 0x20000, bits: 8, r: 0xff });
    assert.equal(readImage(Uint8Array.from([...luminance, 9])).format, FMT.L8);
});

test('what the loader does not read is refused by name', ()=>{
    assert.throws(()=>readImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])),
        e=>e instanceof ImageError && /JPEG/.test(e.message));
    assert.throws(()=>readImage(Uint8Array.from([1, 2, 3])), ImageError);
    const cube = ddsHeader({ width: 4, height: 4, pfFlags: 0x4, fourCC: FMT.DXT1 });
    put(cube, 112, 0x200, 4);
    assert.throws(()=>readImage(Uint8Array.from([...cube, ...new Array(8).fill(0)])),
        /cube map/);
});

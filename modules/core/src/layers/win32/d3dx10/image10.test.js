/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Image files as D3DX 10 and 11 read them, by what Wine's d3dx10 and d3dx11
 * tests say Windows answers: the DXGI format of each classic DDS pixel
 * format, the header rules of classic and DX10 files, the formats refused,
 * and every other file made R8G8B8A8.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImageError } from '../d3dx9/images.js';
import { DIMENSION } from './dds10.js';
import { dds10 } from './dds10.fixture.js';
import { IFF10, NotRead, readImage10 } from './image10.js';
import { PICTURES } from '../../media/internal/pictures.fixture.js';

const PF = { ALPHA: 0x1, ALPHA_ONLY: 0x2, FOURCC: 0x4, INDEXED: 0x20, RGB: 0x40,
    LUMINANCE: 0x20000, BUMP_LUMINANCE: 0x40000, BUMP_DUDV: 0x80000 };
const DDS_DEPTH = 0x800000;
const MIPMAPCOUNT = 0x20000;

/** @param {string} text */
const fourCC = text=>[...text].reduce((word, c, i)=>word | c.charCodeAt(0) << i * 8, 0) >>> 0;

/**
 * A classic DDS file: its header's fields, its pixel format, and `texels`
 * bytes after the header (counting up from 0 unless given).
 *
 * @param {{ flags?: number, width?: number, height?: number, depth?: number, mips?: number,
 *     caps2?: number, pf: [number, number, number, number[]], texels?: number[] | number }} shape
 *     pf: flags, FourCC, bits, masks (red, green, blue, alpha)
 */
function classic(shape){
    const { flags = 0x1007, width = 4, height = 4, depth = 0, mips = 0, caps2 = 0, pf,
        texels = 0 } = shape;
    const body = typeof texels === 'number'
        ? Array.from({ length: texels }, (_, i)=>i & 0xff) : texels;
    const file = new Uint8Array(128 + body.length);
    const view = new DataView(file.buffer);
    view.setUint32(0, 0x20534444, true);
    view.setUint32(4, 124, true);
    view.setUint32(8, flags, true);
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(24, depth, true);
    view.setUint32(28, mips, true);
    view.setUint32(76, 32, true);
    view.setUint32(80, pf[0], true);
    view.setUint32(84, pf[1], true);
    view.setUint32(88, pf[2], true);
    pf[3].forEach((mask, i)=>view.setUint32(92 + i * 4, mask >>> 0, true));
    view.setUint32(108, 0x1000, true);
    view.setUint32(112, caps2, true);
    file.set(body, 128);
    return file;
}

/** @param {[number, number, number, number[]]} pf */
const formatOf = pf=>readImage10(classic({ pf }), { headerOnly: true }).dxgi;

test('a classic DDS pixel format is the DXGI format D3DX makes of it', ()=>{
    /** @type {[[number, number, number, number[]], number][]} */
    const cases = [
        [[PF.FOURCC, fourCC('DXT1'), 0, []], 71], [[PF.FOURCC, fourCC('DXT2'), 0, []], 74],
        [[PF.FOURCC, fourCC('DXT3'), 0, []], 74], [[PF.FOURCC, fourCC('DXT4'), 0, []], 77],
        [[PF.FOURCC, fourCC('DXT5'), 0, []], 77], [[PF.FOURCC, fourCC('RGBG'), 0, []], 68],
        [[PF.FOURCC, fourCC('GRGB'), 0, []], 69], [[PF.FOURCC, fourCC('BC4U'), 0, []], 80],
        [[PF.FOURCC, fourCC('BC4S'), 0, []], 81], [[PF.FOURCC, fourCC('BC5U'), 0, []], 83],
        [[PF.FOURCC, fourCC('BC5S'), 0, []], 84], [[PF.FOURCC, fourCC('ATI2'), 0, []], 83],
        [[PF.FOURCC, 0x24, 0, []], 11], [[PF.FOURCC, 0x6e, 0, []], 13],
        [[PF.FOURCC, 0x6f, 0, []], 54], [[PF.FOURCC, 0x70, 0, []], 34],
        [[PF.FOURCC, 0x71, 0, []], 10], [[PF.FOURCC, 0x72, 0, []], 41],
        [[PF.FOURCC, 0x73, 0, []], 16], [[PF.FOURCC, 0x74, 0, []], 2],
        [[PF.RGB, 0, 16, [0xf800, 0x7e0, 0x1f, 0]], 28],
        [[PF.RGB | PF.ALPHA, 0, 16, [0x7c00, 0x3e0, 0x1f, 0x8000]], 28],
        [[PF.RGB | PF.ALPHA, 0, 16, [0xf00, 0xf0, 0xf, 0xf000]], 28],
        [[PF.RGB, 0, 8, [0xe0, 0x1c, 0x3, 0]], 28],
        [[PF.ALPHA_ONLY, 0, 8, [0, 0, 0, 0xff]], 65],
        [[PF.RGB | PF.ALPHA, 0, 16, [0xe0, 0x1c, 0x3, 0xff00]], 28],
        [[PF.RGB, 0, 16, [0xf00, 0xf0, 0xf, 0]], 28],
        [[PF.RGB | PF.ALPHA, 0, 32, [0x3ff00000, 0xffc00, 0x3ff, 0xc0000000]], 24],
        [[PF.RGB | PF.ALPHA, 0, 32, [0x3ff, 0xffc00, 0x3ff00000, 0xc0000000]], 24],
        [[PF.RGB | PF.ALPHA, 0, 32, [0xff0000, 0xff00, 0xff, 0xff000000]], 28],
        [[PF.RGB | PF.ALPHA, 0, 32, [0xff, 0xff00, 0xff0000, 0xff000000]], 28],
        [[PF.RGB, 0, 32, [0xff0000, 0xff00, 0xff, 0]], 28],
        [[PF.RGB, 0, 32, [0xff, 0xff00, 0xff0000, 0]], 28],
        [[PF.RGB, 0, 24, [0xff0000, 0xff00, 0xff, 0]], 28],
        [[PF.RGB, 0, 32, [0xffff, 0xffff0000, 0, 0]], 35],
        [[PF.LUMINANCE, 0, 8, [0xff, 0, 0, 0]], 28], [[PF.LUMINANCE, 0, 16, [0xffff, 0, 0, 0]], 11],
        [[PF.LUMINANCE | PF.ALPHA, 0, 16, [0xff, 0, 0, 0xff00]], 28],
        [[PF.LUMINANCE | PF.ALPHA, 0, 8, [0xf, 0, 0, 0xf0]], 28],
        [[PF.INDEXED, 0, 8, [0, 0, 0, 0]], 28],
        [[PF.INDEXED | PF.ALPHA, 0, 16, [0, 0, 0, 0xff00]], 28],
        // The fields a flag does not make meaningful are not looked at.
        [[PF.RGB, 0xffffffff, 16, [0xf800, 0x7e0, 0x1f, 0xffffffff]], 28],
        [[PF.LUMINANCE, 0xffffffff, 16, [0xffff, 0xffffffff, 0xffffffff, 0xffffffff]], 11],
    ];
    for (const [pf, dxgi] of cases)
    {
        assert.equal(formatOf(pf), dxgi, `flags ${pf[0].toString(16)} ${pf[1].toString(16)}`);
    }
});

test('the formats D3DX 9 reads and D3DX 10 does not are refused', ()=>{
    for (const pf of /** @type {[number, number, number, number[]][]} */ ([
        [PF.FOURCC, 0x75, 0, []], [PF.FOURCC, fourCC('UYVY'), 0, []],
        [PF.FOURCC, fourCC('YUY2'), 0, []], [PF.FOURCC, fourCC('ATI1'), 0, []],
        [PF.BUMP_DUDV, 0, 16, [0xff, 0xff00, 0, 0]],
        [PF.BUMP_DUDV, 0, 32, [0xffff, 0xffff0000, 0, 0]],
        [PF.BUMP_LUMINANCE, 0, 32, [0xff, 0xff00, 0xff0000, 0]],
        [PF.RGB, 0, 32, [0xff00, 0xff0000, 0xff, 0]],
    ]))
    {
        assert.throws(()=>formatOf(pf), ImageError);
    }
    for (const format of [85, 86, 115])
    {
        assert.throws(()=>readImage10(dds10({ width: 4, height: 4, format, bytes: 32 })),
            /does not read/);
    }
    const bc7 = dds10({ width: 4, height: 4, format: 98, bytes: 16 });
    assert.throws(()=>readImage10(bc7), ImageError, 'BC7 is not D3DX 10\'s');
    assert.equal(readImage10(bc7, { bc6and7: true }).dxgi, 98, 'but D3DX 11\'s');
});

test('a classic header: DDS_DEPTH alone makes a volume, a cube has all six faces, the level'
    + ' count is read without its flag, and only the header\'s size is checked', ()=>{
    const pf = /** @type {[number, number, number, number[]]} */ ([PF.RGB, 0, 32,
        [0xff0000, 0xff00, 0xff, 0]]);
    /** @param {Parameters<typeof classic>[0]} shape */
    const info = shape=>{
        const image = readImage10(classic(shape), { headerOnly: true });
        return [image.width, image.height, image.depth, image.arraySize, image.mipLevels,
            image.cube, image.dimension];
    };
    assert.deepEqual(info({ pf, mips: 3 }), [4, 4, 1, 1, 3, false, DIMENSION.TEXTURE2D]);
    assert.deepEqual(info({ pf, mips: 3, depth: 4, caps2: 0x200000 }),
        [4, 4, 1, 1, 3, false, DIMENSION.TEXTURE2D], 'the volume caps are not looked at');
    assert.deepEqual(info({ pf, flags: 0x1007 | DDS_DEPTH, depth: 4 }),
        [4, 4, 4, 1, 1, false, DIMENSION.TEXTURE3D]);
    assert.deepEqual(info({ pf, flags: 0x1007 | DDS_DEPTH, depth: 0, caps2: 0xfe00 }),
        [4, 4, 1, 1, 1, false, DIMENSION.TEXTURE3D], 'DDS_DEPTH wins over the cube caps');
    assert.deepEqual(info({ pf, height: 5, caps2: 0xfe00 }),
        [4, 5, 1, 6, 1, true, DIMENSION.TEXTURE2D], 'a cube of unequal sides');
    assert.throws(()=>info({ pf, caps2: 0x600 }), /six faces/);
    assert.throws(()=>readImage10(classic({ pf }).subarray(0, 127)), ImageError);
    assert.throws(()=>readImage10(classic({ pf, texels: 63 })), /cut short/,
        'the texels are checked when they are read');
    assert.equal(readImage10(classic({ pf, flags: 0x1007 | MIPMAPCOUNT, mips: 3, texels: 84 }),
        { headerOnly: true }).extent, 128 + 84, 'where the texels end');
});

test('a DX10 header: misc_flags2 refused, only the cube flag kept, the dimension not checked,'
    + ' the depth only with DDS_DEPTH', ()=>{
    /** @param {Parameters<typeof dds10>[0]} shape */
    const info = shape=>{
        const image = readImage10(dds10(shape), { headerOnly: true });
        return [image.depth, image.arraySize, image.cube, image.dimension];
    };
    const file = dds10({ width: 4, height: 4, format: 28, bytes: 64 });
    new DataView(file.buffer).setUint32(144, 1, true);
    assert.throws(()=>readImage10(file), /misc_flags2/);
    assert.deepEqual(info({ width: 4, format: 28, misc: 0xfffffffb, bytes: 0 }),
        [1, 1, false, DIMENSION.TEXTURE2D]);
    assert.deepEqual(info({ width: 4, format: 28, dimension: 500, bytes: 0 }), [1, 1, false, 500]);
    assert.deepEqual(info({ width: 4, format: 28, depth: 2, bytes: 0 }),
        [2, 1, false, DIMENSION.TEXTURE2D], 'DDS_DEPTH, whatever the dimension');
    assert.deepEqual(info({ width: 4, format: 28, misc: 0x4, arraySize: 2, bytes: 0 }),
        [1, 12, true, DIMENSION.TEXTURE2D], 'six slices a cube');
});

test('a DX10 file\'s levels, slices and faces cut where each before ends', ()=>{
    const image = readImage10(dds10({ width: 4, height: 2, format: 10, mips: 3, bytes: 88 }));
    assert.deepEqual(image.levels.map(level=>[level.width, level.height, level.data.length,
        level.data[0]]), [[4, 2, 64, 0], [2, 1, 16, 64], [1, 1, 8, 80]]);
    const cubes = readImage10(dds10({ width: 2, height: 2, format: 61, misc: 0x4, arraySize: 2,
        mips: 2, bytes: 60 }));
    assert.deepEqual(cubes.faces?.map(chain=>chain[0].data[0]),
        Array.from({ length: 12 }, (_, face)=>face * 5));
    const volume = readImage10(dds10({ width: 4, height: 4, depth: 2, format: 61,
        dimension: DIMENSION.TEXTURE3D, mips: 3, bytes: 37 }));
    assert.deepEqual(volume.volume?.map(level=>level.map(slice=>[slice.width, slice.data[0]])),
        [[[4, 0], [4, 16]], [[2, 32]], [[1, 36]]]);
    const line = readImage10(dds10({ width: 8, height: 5, format: 61,
        dimension: DIMENSION.TEXTURE1D, bytes: 8 }));
    assert.equal(line.height, 1, 'a 1D texture is one row, whatever the header\'s height');
});

test('a classic file\'s texels are made its DXGI format\'s, channels widened by rounding', ()=>{
    /** @param {[number, number, number, number[]]} pf @param {number[]} texels */
    const top = (pf, texels)=>[...readImage10(classic({ pf, width: 1, height: 1, texels }))
        .levels[0].data];
    assert.deepEqual(top([PF.RGB, 0, 16, [0x7c00, 0x3e0, 0x1f, 0]], [0x0e, 0x42]),
        [132, 132, 115, 255], 'X1R5G5B5: 16 and 14 of 31');
    assert.deepEqual(top([PF.RGB | PF.ALPHA, 0, 32, [0xff0000, 0xff00, 0xff, 0xff000000]],
        [0x70, 0x81, 0x83, 0x40]), [0x83, 0x81, 0x70, 0x40], 'A8R8G8B8 to R8G8B8A8');
    assert.deepEqual(top([PF.RGB, 0, 24, [0xff0000, 0xff00, 0xff, 0]], [0x70, 0x81, 0x83]),
        [0x83, 0x81, 0x70, 255]);
    assert.deepEqual(top([PF.LUMINANCE, 0, 8, [0xff, 0, 0, 0]], [0x82]), [0x82, 0x82, 0x82, 255]);
    assert.deepEqual(top([PF.LUMINANCE | PF.ALPHA, 0, 8, [0xf, 0, 0, 0xf0]], [0x3c]),
        [0xcc, 0xcc, 0xcc, 0x33], 'A4L4');
    assert.deepEqual(top([PF.LUMINANCE, 0, 16, [0xffff, 0, 0, 0]], [0x34, 0x12]),
        [0x34, 0x12, 0x34, 0x12, 0x34, 0x12, 0xff, 0xff], 'L16 to R16G16B16A16');
    assert.deepEqual(top([PF.RGB | PF.ALPHA, 0, 32, [0x3ff00000, 0xffc00, 0x3ff, 0xc0000000]],
        [0x01, 0x00, 0x00, 0xc0]), [0x00, 0x00, 0x10, 0xc0], 'A2R10G10B10: red and blue swap');
    const palette = Array.from({ length: 1024 }, (_, i)=>(i >> 2) * 4 + (i & 3) & 0xff);
    assert.deepEqual(top([PF.INDEXED, 0, 8, [0, 0, 0, 0]], [...palette, 3]), [12, 13, 14, 15],
        'P8 through its palette, alpha in peFlags');
    assert.deepEqual(top([PF.INDEXED | PF.ALPHA, 0, 16, [0, 0, 0, 0xff00]], [...palette, 3, 0x99]),
        [12, 13, 14, 0x99]);
    const asIs = readImage10(classic({ pf: [PF.RGB | PF.ALPHA, 0, 32,
        [0xff, 0xff00, 0xff0000, 0xff000000]], width: 1, height: 1, texels: [1, 2, 3, 4] }));
    assert.equal(asIs.converted, false, 'A8B8G8R8 is R8G8B8A8 as it is');
});

test('every other file is R8G8B8A8: a bitmap\'s colours, GIF and TIFF; TGA and a cut bitmap'
    + ' refused; JPEG XR not read', ()=>{
    // A 2x1 24-bit bitmap: blue, then red.
    const bmp = Uint8Array.of(0x42, 0x4d, 62, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 2, 0,
        0, 0, 1, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0xff, 0, 0, 0, 0, 0xff, 0, 0);
    const image = readImage10(bmp);
    assert.deepEqual([image.fileFormat, image.dxgi, image.converted, ...image.levels[0].data],
        [IFF10.BMP, 28, true, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0xff]);
    assert.throws(()=>readImage10(bmp.subarray(0, 61)), /bitmap of 62 bytes/);
    const gif = readImage10(Uint8Array.from(Buffer.from(PICTURES.gif_plain.file, 'base64')));
    assert.deepEqual([gif.fileFormat, gif.dxgi, gif.width, [...gif.levels[0].data]],
        [IFF10.GIF, 28, 5, PICTURES.gif_plain.rgba]);
    const tiff = readImage10(Uint8Array.from(Buffer.from(PICTURES.tiff_rgb_raw.file, 'base64')));
    assert.deepEqual([tiff.fileFormat, [...tiff.levels[0].data]],
        [IFF10.TIFF, PICTURES.tiff_rgb_raw.rgba]);
    const tga = Uint8Array.of(0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0, 1, 2, 3);
    assert.throws(()=>readImage10(tga), ImageError);
    assert.throws(()=>readImage10(Uint8Array.of(0x49, 0x49, 0xbc, 1, 0, 0, 0, 0)), NotRead);
    assert.throws(()=>readImage10(Uint8Array.of(0xef, 0xbe, 0xad, 0xde)), ImageError);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DDS files in a DXGI format, as D3DX 10 reads them. One with the DX10 header
 * extension has, after the classic 124-byte header (pixel format FourCC
 * "DX10"), DDS_HEADER_DXT10 -- dxgiFormat, resourceDimension, miscFlag,
 * arraySize, miscFlags2; a classic one may name a DXGI format by its FourCC
 * (ATI2 is BC5). Then come the texels in that format, each array slice (six
 * faces a cube) its whole mip chain, a volume each level's slices one after
 * another. D3DX 10 keeps the file's DXGI format as it is.
 */

import { IFF, ImageError } from '../d3dx9/images.js';

const DDS_MAGIC = 0x20534444;
const FOURCC_DX10 = 0x30315844;
const DDPF_FOURCC = 0x4;
const HEADER_BYTES = 128;
const EXTENSION_BYTES = 20;

/** D3D10_RESOURCE_DIMENSION, and D3D10_RESOURCE_MISC_TEXTURECUBE. */
export const DIMENSION = Object.freeze({ TEXTURE1D: 2, TEXTURE2D: 3, TEXTURE3D: 4 });
const MISC_TEXTURECUBE = 0x4;

/**
 * Bytes a texel takes, by DXGI_FORMAT, for the formats D3D 10 and 10.1 know
 * as texels of a whole number of bytes: [first, last, bytes].
 */
const TEXEL_RANGES = [
    [1, 4, 16], [5, 8, 12], [9, 22, 8], [23, 47, 4], [48, 59, 2], [60, 65, 1], [67, 67, 4],
    [85, 86, 2], [87, 93, 4], [115, 115, 2],
];
/** The block-compressed formats, BC1 to BC7, as [first, last, bytes a 4x4 block]. */
const BLOCK_RANGES = [[70, 72, 8], [73, 78, 16], [79, 81, 8], [82, 84, 16], [94, 99, 16]];
/** R8G8_B8G8 and G8R8_G8B8: two texels in four bytes. */
const PAIRED = new Set([68, 69]);
const R1_UNORM = 66;

/** @param {number[][]} ranges @param {number} format */
const sizeIn = (ranges, format)=>ranges.find(([first, last])=>format >= first
    && format <= last)?.[2] ?? 0;

/**
 * A row's bytes and the rows of a level of a DXGI format, as its texels are
 * packed: blocks a row of four texel rows, pairs two texels to four bytes,
 * R1 a bit a texel. Null for a format with no packed layout here.
 *
 * @param {number} format @param {number} width @param {number} height
 * @returns {{ rowBytes: number, rows: number } | null}
 */
export function dxgiLayout(format, width, height){
    const block = sizeIn(BLOCK_RANGES, format);
    if (block)
    {
        return { rowBytes: Math.max(1, Math.ceil(width / 4)) * block,
            rows: Math.max(1, Math.ceil(height / 4)) };
    }
    if (PAIRED.has(format))
    {
        return { rowBytes: Math.ceil(width / 2) * 4, rows: height };
    }
    if (format === R1_UNORM)
    {
        return { rowBytes: Math.ceil(width / 8), rows: height };
    }
    const texel = sizeIn(TEXEL_RANGES, format);
    return texel ? { rowBytes: width * texel, rows: height } : null;
}

/**
 * Bytes a texel of a DXGI format takes, or 0 for one laid out in blocks,
 * pairs or bits, whose texels are not each their own bytes.
 *
 * @param {number} format
 */
export const texelBytesOf = format=>sizeIn(TEXEL_RANGES, format);

/**
 * The formats each of whose bytes is a channel of its own, unsigned and
 * normalised: averaging bytes averages the colours.
 */
const BYTE_CHANNELS = new Set([27, 28, 29, 30, 48, 49, 50, 60, 61, 62, 65, 87, 88, 90, 91, 92,
    93]);

/** Whether a format's levels are made by averaging bytes. @param {number} format */
export const averagesBytes = format=>BYTE_CHANNELS.has(format);

/**
 * A level stretched to another size, each texel the one its centre falls
 * on, `bytes` a texel.
 *
 * @param {Uint8Array} data @param {number} width @param {number} height
 * @param {number} toWidth @param {number} toHeight @param {number} bytes
 * @returns {Uint8Array}
 */
export function resampleTexels(data, width, height, toWidth, toHeight, bytes){
    const out = new Uint8Array(toWidth * toHeight * bytes);
    for (let y = 0; y < toHeight; y++)
    {
        const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / toHeight));
        for (let x = 0; x < toWidth; x++)
        {
            const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / toWidth));
            const from = (sy * width + sx) * bytes;
            out.set(data.subarray(from, from + bytes), (y * toWidth + x) * bytes);
        }
    }
    return out;
}

/**
 * The next smaller level, `bytes` a texel: each byte the average of the two
 * by two it covers when `average` (the edge repeated where a side is odd),
 * else the top-left texel of them.
 *
 * @param {Uint8Array} data @param {number} width @param {number} height
 * @param {number} bytes @param {boolean} average
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
export function halveTexels(data, width, height, bytes, average){
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    const out = new Uint8Array(w * h * bytes);
    for (let y = 0; y < h; y++)
    {
        const y0 = Math.min(height - 1, y * 2);
        const y1 = Math.min(height - 1, y * 2 + 1);
        for (let x = 0; x < w; x++)
        {
            const x0 = Math.min(width - 1, x * 2);
            const x1 = Math.min(width - 1, x * 2 + 1);
            const at = (y * w + x) * bytes;
            for (let b = 0; b < bytes; b++)
            {
                out[at + b] = average
                    ? (data[(y0 * width + x0) * bytes + b] + data[(y0 * width + x1) * bytes + b]
                        + data[(y1 * width + x0) * bytes + b]
                        + data[(y1 * width + x1) * bytes + b] + 2) >> 2
                    : data[(y0 * width + x0) * bytes + b];
            }
        }
    }
    return { data: out, width: w, height: h };
}

/**
 * @typedef {import('../d3dx9/images.js').Level & { dxgi: number }} DxgiLevel
 * @typedef {import('../d3dx9/images.js').Image & {
 *     dxgi: number, dimension: number, cube: boolean, arraySize: number,
 *     levels: DxgiLevel[], faces?: DxgiLevel[][], volume?: DxgiLevel[][] }} DxgiImage
 *   `faces` holds every array slice (a cube's six faces each slice) when
 *   there is more than one; `arraySize` counts them.
 */

/** A FourCC as a little-endian word. @param {string} text */
const fourCC = text=>[...text].reduce((word, c, i)=>word | c.charCodeAt(0) << i * 8, 0) >>> 0;

/**
 * Classic DDS FourCCs that name a DXGI format outright, as D3DX 10 reads
 * them: 3Dc's and BC4/BC5's codes, the packed pairs, and the D3DFORMAT
 * numbers of the deep and float formats.
 */
const LEGACY_FOURCC = new Map([[fourCC('ATI1'), 80], [fourCC('BC4U'), 80], [fourCC('BC4S'), 81],
    [fourCC('ATI2'), 83], [fourCC('BC5U'), 83], [fourCC('BC5S'), 84], [fourCC('RGBG'), 68],
    [fourCC('GRGB'), 69], [36, 11], [110, 13], [111, 54], [112, 34], [113, 10], [114, 41],
    [115, 16], [116, 2]]);

const DDSD_MIPMAPCOUNT = 0x20000;
const DDSCAPS2_CUBEMAP = 0x200;
const DDSCAPS2_ALL_FACES = 0xfc00;
const DDSCAPS2_VOLUME = 0x200000;

/** @param {Uint8Array} bytes */
const fourCCOf = bytes=>{
    if (bytes.length < HEADER_BYTES)
    {
        return 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(0, true) === DDS_MAGIC && (view.getUint32(80, true) & DDPF_FOURCC) !== 0
        ? view.getUint32(84, true) : 0;
};

/**
 * Whether a DDS file is read in a DXGI format of its own: one with the DX10
 * extension, or a classic one whose FourCC names a DXGI format.
 *
 * @param {Uint8Array} bytes
 */
export function isDxgiDds(bytes){
    const code = fourCCOf(bytes);
    return code === FOURCC_DX10 || LEGACY_FOURCC.has(code);
}

/**
 * Such a file's image, its levels in the file's DXGI format.
 *
 * @param {Uint8Array} bytes
 * @returns {DxgiImage}
 */
export function readDxgiDds(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const extended = fourCCOf(bytes) === FOURCC_DX10;
    if (bytes.length < HEADER_BYTES + (extended ? EXTENSION_BYTES : 0))
    {
        throw new ImageError('a DDS file shorter than its headers');
    }
    const caps2 = view.getUint32(112, true);
    let dxgi;
    let dimension;
    let cube;
    let slices = 1;
    if (extended)
    {
        let misc;
        [dxgi, dimension, misc, slices] = [0, 4, 8, 12].map(at=>view.getUint32(HEADER_BYTES + at,
            true));
        cube = (misc & MISC_TEXTURECUBE) !== 0;
    }
    else
    {
        dxgi = /** @type {number} */ (LEGACY_FOURCC.get(view.getUint32(84, true)));
        dimension = (caps2 & DDSCAPS2_VOLUME) ? DIMENSION.TEXTURE3D : DIMENSION.TEXTURE2D;
        cube = (caps2 & DDSCAPS2_CUBEMAP) !== 0;
        if (cube && (caps2 & DDSCAPS2_ALL_FACES) !== DDSCAPS2_ALL_FACES)
        {
            throw new ImageError('a cube map without all six faces');
        }
    }
    if (dimension < DIMENSION.TEXTURE1D || dimension > DIMENSION.TEXTURE3D)
    {
        throw new ImageError(`a DX10 DDS of resource dimension ${dimension}`);
    }
    if (!dxgiLayout(dxgi, 1, 1))
    {
        throw new ImageError(`a DX10 DDS of DXGI format ${dxgi}, which this loader does not`
            + ' lay out');
    }
    const width = Math.max(1, view.getUint32(16, true));
    const height = dimension === DIMENSION.TEXTURE1D ? 1 : Math.max(1, view.getUint32(12, true));
    const depth = dimension === DIMENSION.TEXTURE3D ? Math.max(1, view.getUint32(24, true)) : 1;
    // A DX10 file's count is read as written (its writers leave DDSD_MIPMAPCOUNT
    // off as often as on); a classic one's only with the flag, as D3DX 9 reads it.
    const counted = extended || (view.getUint32(8, true) & DDSD_MIPMAPCOUNT) !== 0;
    const mipLevels = counted ? Math.max(1, view.getUint32(28, true)) : 1;
    const arraySize = dimension === DIMENSION.TEXTURE3D ? 1
        : Math.max(1, slices) * (cube ? 6 : 1);
    if (cube && dimension !== DIMENSION.TEXTURE2D)
    {
        throw new ImageError('a DX10 DDS cube map that is not two-dimensional');
    }
    let at = HEADER_BYTES + (extended ? EXTENSION_BYTES : 0);
    /** @param {number} size */
    const take = size=>{
        if (at + size > bytes.length)
        {
            throw new ImageError('a DDS file cut short');
        }
        const data = bytes.subarray(at, at + size);
        at += size;
        return data;
    };
    /** @param {number} level */
    const sizeOf = level=>{
        const w = Math.max(1, width >> level);
        const h = Math.max(1, height >> level);
        const { rowBytes, rows } = /** @type {{ rowBytes: number, rows: number }} */ (
            dxgiLayout(dxgi, w, h));
        return { w, h, size: rowBytes * rows };
    };
    const base = { fileFormat: IFF.DDS, width, height, format: 0, mipLevels, dxgi, dimension,
        cube, arraySize };
    if (dimension === DIMENSION.TEXTURE3D)
    {
        /** @type {DxgiLevel[][]} */
        const volume = [];
        for (let level = 0; level < mipLevels; level++)
        {
            const { w, h, size } = sizeOf(level);
            const count = Math.max(1, depth >> level);
            volume.push(Array.from({ length: count }, ()=>({ width: w, height: h, format: 0, dxgi,
                data: take(size) })));
        }
        return { ...base, depth, levels: [], volume };
    }
    /** @type {DxgiLevel[][]} */
    const chains = [];
    for (let slice = 0; slice < arraySize; slice++)
    {
        /** @type {DxgiLevel[]} */
        const chain = [];
        for (let level = 0; level < mipLevels; level++)
        {
            const { w, h, size } = sizeOf(level);
            chain.push({ width: w, height: h, format: 0, dxgi, data: take(size) });
        }
        chains.push(chain);
    }
    return { ...base, levels: chains[0], ...(arraySize > 1 ? { faces: chains } : {}) };
}

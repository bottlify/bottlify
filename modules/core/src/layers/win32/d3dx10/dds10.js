/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DXGI formats as D3DX 10 lays their texels out: a row's bytes and the rows of
 * a level, and the halving of a level of whole-byte channels. The files
 * themselves are read by `image10.js`.
 */

/** D3D10_RESOURCE_DIMENSION. */
export const DIMENSION = Object.freeze({ TEXTURE1D: 2, TEXTURE2D: 3, TEXTURE3D: 4 });

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
 * The formats each of whose bytes is a channel of its own, unsigned and
 * normalised: averaging bytes averages the colours.
 */
const BYTE_CHANNELS = new Set([27, 28, 29, 30, 48, 49, 50, 60, 61, 62, 65, 87, 88, 90, 91, 92,
    93]);

/** Whether a format's levels are made by averaging bytes. @param {number} format */
export const averagesBytes = format=>BYTE_CHANNELS.has(format);

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
 *     levels: DxgiLevel[], faces?: DxgiLevel[][], volume?: DxgiLevel[][],
 *     converted?: boolean, extent?: number }} DxgiImage
 *   `faces` holds every array slice (a cube's six faces each slice) when
 *   there is more than one; `arraySize` counts them. `converted`: the file's
 *   texels were laid out otherwise and made the DXGI format's. `extent`, of a
 *   DDS file's headers read alone: where its texels end.
 */

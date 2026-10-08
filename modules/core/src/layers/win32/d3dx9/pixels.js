/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texels between the Direct3D 9 formats D3DX loads into and one working form:
 * eight bits each of blue, green, red and alpha, in that byte order (what
 * D3DFMT_A8R8G8B8 is in memory). A loader decodes a file into it, scales and
 * filters it, and encodes it into the format the texture was made in.
 *
 * The block-compressed formats are decoded as their specification describes
 * them (the DXTn layouts in the Direct3D 9 documentation) and encoded with a
 * range fit -- each block's colours between its two most distant ones -- which
 * is what a loader without a quality setting owes.
 */

/** D3DFORMAT values. */
export const FMT = Object.freeze({
    UNKNOWN: 0, R8G8B8: 20, A8R8G8B8: 21, X8R8G8B8: 22, R5G6B5: 23, X1R5G5B5: 24,
    A1R5G5B5: 25, A4R4G4B4: 26, A8: 28, X4R4G4B4: 30, A8B8G8R8: 32, X8B8G8R8: 33,
    P8: 41, L8: 50, A8L8: 51,
    DXT1: 0x31545844, DXT2: 0x32545844, DXT3: 0x33545844, DXT4: 0x34545844,
    DXT5: 0x35545844,
});

/** @param {number} format */
export const isCompressed = format=>format === FMT.DXT1 || format === FMT.DXT2
    || format === FMT.DXT3 || format === FMT.DXT4 || format === FMT.DXT5;

/** Bytes a texel takes, for the formats this module reads and writes uncompressed. */
/** @type {Map<number, number>} */
const TEXEL_BYTES = new Map([[FMT.R8G8B8, 3], [FMT.A8R8G8B8, 4], [FMT.X8R8G8B8, 4],
    [FMT.R5G6B5, 2], [FMT.X1R5G5B5, 2], [FMT.A1R5G5B5, 2], [FMT.A4R4G4B4, 2],
    [FMT.X4R4G4B4, 2], [FMT.A8, 1], [FMT.L8, 1], [FMT.A8L8, 2], [FMT.A8B8G8R8, 4],
    [FMT.X8B8G8R8, 4]]);

/** @param {number} format */
export const isSupported = format=>TEXEL_BYTES.has(format) || isCompressed(format);

/** @param {number} format */
const blockBytes = format=>(format === FMT.DXT1 ? 8 : 16);

/**
 * A row's bytes as the format packs it -- a row of 4x4 blocks for a compressed
 * one -- and how many such rows a level of that height has.
 *
 * @param {number} format @param {number} width @param {number} height
 */
export function layoutOf(format, width, height){
    if (isCompressed(format))
    {
        return { rowBytes: Math.max(1, Math.ceil(width / 4)) * blockBytes(format),
            rows: Math.max(1, Math.ceil(height / 4)) };
    }
    return { rowBytes: width * /** @type {number} */ (TEXEL_BYTES.get(format)), rows: height };
}

/** @param {number} value @param {number} bits */
const expand = (value, bits)=>Math.round(value * 255 / ((1 << bits) - 1));
/** @param {number} value @param {number} bits */
const reduce = (value, bits)=>Math.round(value * ((1 << bits) - 1) / 255);

/**
 * A level in the working form.
 *
 * @param {number} format @param {Uint8Array} data @param {number} width @param {number} height
 * @param {Uint8Array} [palette]  P8's 256 entries, PALETTEENTRY order (r, g, b, flags).
 * @returns {Uint8Array}
 */
export function decodeTexels(format, data, width, height, palette){
    const out = new Uint8Array(width * height * 4);
    if (isCompressed(format))
    {
        decodeBlocks(format, data, width, height, out);
        return out;
    }
    const bytes = format === FMT.P8 ? 1 : /** @type {number} */ (TEXEL_BYTES.get(format));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < width * height; i++)
    {
        const at = i * bytes;
        let b = 0;
        let g = 0;
        let r = 0;
        let a = 255;
        switch (format)
        {
            case FMT.A8R8G8B8: case FMT.X8R8G8B8: case FMT.R8G8B8:
                b = data[at];
                g = data[at + 1];
                r = data[at + 2];
                a = format === FMT.A8R8G8B8 ? data[at + 3] : 255;
                break;
            case FMT.A8B8G8R8: case FMT.X8B8G8R8:
                r = data[at];
                g = data[at + 1];
                b = data[at + 2];
                a = format === FMT.A8B8G8R8 ? data[at + 3] : 255;
                break;
            case FMT.R5G6B5: {
                const v = view.getUint16(at, true);
                r = expand(v >> 11, 5);
                g = expand(v >> 5 & 63, 6);
                b = expand(v & 31, 5);
                break;
            }
            case FMT.X1R5G5B5: case FMT.A1R5G5B5: {
                const v = view.getUint16(at, true);
                r = expand(v >> 10 & 31, 5);
                g = expand(v >> 5 & 31, 5);
                b = expand(v & 31, 5);
                a = format === FMT.A1R5G5B5 ? (v >> 15) * 255 : 255;
                break;
            }
            case FMT.A4R4G4B4: case FMT.X4R4G4B4: {
                const v = view.getUint16(at, true);
                r = expand(v >> 8 & 15, 4);
                g = expand(v >> 4 & 15, 4);
                b = expand(v & 15, 4);
                a = format === FMT.A4R4G4B4 ? expand(v >> 12, 4) : 255;
                break;
            }
            case FMT.A8:
                a = data[at];
                break;
            case FMT.L8:
                r = g = b = data[at];
                break;
            case FMT.A8L8:
                r = g = b = data[at];
                a = data[at + 1];
                break;
            case FMT.P8: {
                const entry = /** @type {Uint8Array} */ (palette).subarray(data[at] * 4);
                r = entry[0];
                g = entry[1];
                b = entry[2];
                break;
            }
            default:
                throw new Error(`no decoder for format ${format}`);
        }
        out[i * 4] = b;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = r;
        out[i * 4 + 3] = a;
    }
    return out;
}

/**
 * A level in the working form, encoded into `format`, rows packed.
 *
 * @param {number} format @param {Uint8Array} bgra @param {number} width @param {number} height
 * @returns {Uint8Array}
 */
export function encodeTexels(format, bgra, width, height){
    if (isCompressed(format))
    {
        return encodeBlocks(format, bgra, width, height);
    }
    const bytes = /** @type {number} */ (TEXEL_BYTES.get(format));
    const out = new Uint8Array(width * height * bytes);
    const view = new DataView(out.buffer);
    for (let i = 0; i < width * height; i++)
    {
        const b = bgra[i * 4];
        const g = bgra[i * 4 + 1];
        const r = bgra[i * 4 + 2];
        const a = bgra[i * 4 + 3];
        const at = i * bytes;
        switch (format)
        {
            case FMT.A8R8G8B8: case FMT.X8R8G8B8: case FMT.R8G8B8:
                out[at] = b;
                out[at + 1] = g;
                out[at + 2] = r;
                if (bytes === 4)
                {
                    out[at + 3] = format === FMT.A8R8G8B8 ? a : 255;
                }
                break;
            case FMT.A8B8G8R8: case FMT.X8B8G8R8:
                out[at] = r;
                out[at + 1] = g;
                out[at + 2] = b;
                out[at + 3] = format === FMT.A8B8G8R8 ? a : 255;
                break;
            case FMT.R5G6B5:
                view.setUint16(at, reduce(r, 5) << 11 | reduce(g, 6) << 5 | reduce(b, 5), true);
                break;
            case FMT.X1R5G5B5: case FMT.A1R5G5B5:
                view.setUint16(at, (format === FMT.A1R5G5B5 ? (a >= 128 ? 1 : 0) : 1) << 15
                    | reduce(r, 5) << 10 | reduce(g, 5) << 5 | reduce(b, 5), true);
                break;
            case FMT.A4R4G4B4: case FMT.X4R4G4B4:
                view.setUint16(at, (format === FMT.A4R4G4B4 ? reduce(a, 4) : 15) << 12
                    | reduce(r, 4) << 8 | reduce(g, 4) << 4 | reduce(b, 4), true);
                break;
            case FMT.A8:
                out[at] = a;
                break;
            case FMT.L8:
                out[at] = luminance(r, g, b);
                break;
            case FMT.A8L8:
                out[at] = luminance(r, g, b);
                out[at + 1] = a;
                break;
            default:
                throw new Error(`no encoder for format ${format}`);
        }
    }
    return out;
}

/** BT.709's weights, which D3DX converts colour to luminance with. */
const luminance = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b)=>
    Math.min(255, Math.round(r * 0.2125 + g * 0.7154 + b * 0.0721));

/** @param {number} c  A 565 colour. @returns {number[]} r, g, b */
const rgb565 = c=>[expand(c >> 11, 5), expand(c >> 5 & 63, 6), expand(c & 31, 5)];

/**
 * @param {number} format @param {Uint8Array} data @param {number} width @param {number} height
 * @param {Uint8Array} out
 */
function decodeBlocks(format, data, width, height, out){
    const size = blockBytes(format);
    const across = Math.max(1, Math.ceil(width / 4));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let by = 0; by < Math.ceil(height / 4); by++)
    {
        for (let bx = 0; bx < across; bx++)
        {
            const at = (by * across + bx) * size;
            const colourAt = format === FMT.DXT1 ? at : at + 8;
            const c0 = view.getUint16(colourAt, true);
            const c1 = view.getUint16(colourAt + 2, true);
            const p0 = rgb565(c0);
            const p1 = rgb565(c1);
            const four = format !== FMT.DXT1 || c0 > c1;
            const palette = [[...p0, 255], [...p1, 255],
                four ? [0, 1, 2].map(k=>Math.round((2 * p0[k] + p1[k]) / 3)).concat(255)
                    : [0, 1, 2].map(k=>Math.round((p0[k] + p1[k]) / 2)).concat(255),
                four ? [0, 1, 2].map(k=>Math.round((p0[k] + 2 * p1[k]) / 3)).concat(255)
                    : [0, 0, 0, 0]];
            const indices = view.getUint32(colourAt + 4, true);
            /** @type {number[]} */
            let alphas = [];
            if (format === FMT.DXT3 || format === FMT.DXT2)
            {
                for (let k = 0; k < 16; k++)
                {
                    alphas.push(expand(data[at + (k >> 1)] >> ((k & 1) * 4) & 15, 4));
                }
            }
            else if (format === FMT.DXT5 || format === FMT.DXT4)
            {
                const a0 = data[at];
                const a1 = data[at + 1];
                const levels = [a0, a1];
                for (let k = 1; k < (a0 > a1 ? 7 : 5); k++)
                {
                    levels.push(Math.round(a0 > a1 ? ((7 - k) * a0 + k * a1) / 7
                        : ((5 - k) * a0 + k * a1) / 5));
                }
                if (a0 <= a1)
                {
                    levels.push(0, 255);
                }
                let bits = 0n;
                for (let k = 5; k >= 0; k--)
                {
                    bits = bits << 8n | BigInt(data[at + 2 + k]);
                }
                alphas = Array.from({ length: 16 },
                    (_, k)=>levels[Number(bits >> BigInt(k * 3) & 7n)]);
            }
            for (let k = 0; k < 16; k++)
            {
                const x = bx * 4 + (k & 3);
                const y = by * 4 + (k >> 2);
                if (x >= width || y >= height)
                {
                    continue;
                }
                const texel = palette[indices >>> (k * 2) & 3];
                const o = (y * width + x) * 4;
                out[o] = texel[2];
                out[o + 1] = texel[1];
                out[o + 2] = texel[0];
                out[o + 3] = alphas.length > 0 ? alphas[k] : texel[3];
            }
        }
    }
}

/**
 * @param {number} format @param {Uint8Array} bgra @param {number} width @param {number} height
 * @returns {Uint8Array}
 */
function encodeBlocks(format, bgra, width, height){
    const size = blockBytes(format);
    const across = Math.max(1, Math.ceil(width / 4));
    const down = Math.max(1, Math.ceil(height / 4));
    const out = new Uint8Array(across * down * size);
    const view = new DataView(out.buffer);
    /** @param {number[]} p */
    const to565 = p=>reduce(p[0], 5) << 11 | reduce(p[1], 6) << 5 | reduce(p[2], 5);
    for (let by = 0; by < down; by++)
    {
        for (let bx = 0; bx < across; bx++)
        {
            /** @type {number[][]} r, g, b, a of the block's texels, edges repeated */
            const texels = [];
            for (let k = 0; k < 16; k++)
            {
                const x = Math.min(width - 1, bx * 4 + (k & 3));
                const y = Math.min(height - 1, by * 4 + (k >> 2));
                const o = (y * width + x) * 4;
                texels.push([bgra[o + 2], bgra[o + 1], bgra[o], bgra[o + 3]]);
            }
            const at = (by * across + bx) * size;
            const punch = format === FMT.DXT1 && texels.some(t=>t[3] < 128);
            const lit = texels.filter(t=>!punch || t[3] >= 128);
            // The two farthest apart: a bounding box's corners miss colours whose
            // channels run against each other.
            let ends = [lit[0] ?? [0, 0, 0], lit[0] ?? [0, 0, 0]];
            let spread = -1;
            for (const p of lit)
            {
                for (const q of lit)
                {
                    const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
                    if (d > spread)
                    {
                        spread = d;
                        ends = [p, q];
                    }
                }
            }
            let c0 = to565(ends[0]);
            let c1 = to565(ends[1]);
            // Four colours want c0 > c1, three and transparent c0 <= c1.
            if (punch ? c0 > c1 : c0 < c1)
            {
                [c0, c1] = [c1, c0];
            }
            if (!punch && c0 === c1 && c1 > 0)
            {
                c1--;
            }
            const p0 = rgb565(c0);
            const p1 = rgb565(c1);
            const palette = punch
                ? [p0, p1, [0, 1, 2].map(k=>(p0[k] + p1[k]) / 2)]
                : [p0, p1, [0, 1, 2].map(k=>(2 * p0[k] + p1[k]) / 3),
                    [0, 1, 2].map(k=>(p0[k] + 2 * p1[k]) / 3)];
            let indices = 0;
            texels.forEach((t, k)=>{
                let best = 0;
                if (punch && t[3] < 128)
                {
                    best = 3;
                }
                else
                {
                    let bestError = Infinity;
                    palette.forEach((p, i)=>{
                        const error = (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2 + (p[2] - t[2]) ** 2;
                        if (error < bestError)
                        {
                            bestError = error;
                            best = i;
                        }
                    });
                }
                indices |= best << (k * 2);
            });
            const colourAt = format === FMT.DXT1 ? at : at + 8;
            view.setUint16(colourAt, c0, true);
            view.setUint16(colourAt + 2, c1, true);
            view.setUint32(colourAt + 4, indices >>> 0, true);
            if (format === FMT.DXT3 || format === FMT.DXT2)
            {
                texels.forEach((t, k)=>{
                    out[at + (k >> 1)] |= reduce(t[3], 4) << ((k & 1) * 4);
                });
            }
            else if (format === FMT.DXT5 || format === FMT.DXT4)
            {
                const a0 = Math.max(...texels.map(t=>t[3]));
                const a1 = Math.min(...texels.map(t=>t[3]));
                out[at] = a0;
                out[at + 1] = a1;
                const levels = [a0, a1];
                for (let k = 1; k < 7; k++)
                {
                    levels.push(((7 - k) * a0 + k * a1) / 7);
                }
                let bits = 0n;
                texels.forEach((t, k)=>{
                    let best = 0;
                    if (a0 !== a1)
                    {
                        levels.forEach((l, i)=>{
                            if (Math.abs(l - t[3]) < Math.abs(levels[best] - t[3]))
                            {
                                best = i;
                            }
                        });
                    }
                    bits |= BigInt(best) << BigInt(k * 3);
                });
                for (let k = 0; k < 6; k++)
                {
                    out[at + 2 + k] = Number(bits >> BigInt(k * 8) & 0xffn);
                }
            }
        }
    }
    return out;
}

/**
 * The next smaller level: each texel the average of the two by two it covers,
 * the edge repeated where a side is odd (D3DX_FILTER_BOX).
 *
 * @param {Uint8Array} bgra @param {number} width @param {number} height
 * @returns {{ bgra: Uint8Array, width: number, height: number }}
 */
export function halve(bgra, width, height){
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
    {
        for (let x = 0; x < w; x++)
        {
            const x0 = Math.min(width - 1, x * 2);
            const x1 = Math.min(width - 1, x * 2 + 1);
            const y0 = Math.min(height - 1, y * 2);
            const y1 = Math.min(height - 1, y * 2 + 1);
            for (let c = 0; c < 4; c++)
            {
                out[(y * w + x) * 4 + c] = (bgra[(y0 * width + x0) * 4 + c]
                    + bgra[(y0 * width + x1) * 4 + c] + bgra[(y1 * width + x0) * 4 + c]
                    + bgra[(y1 * width + x1) * 4 + c] + 2) >> 2;
            }
        }
    }
    return { bgra: out, width: w, height: h };
}

/**
 * The level stretched to another size, each texel the one its centre falls on.
 *
 * @param {Uint8Array} bgra @param {number} width @param {number} height
 * @param {number} toWidth @param {number} toHeight
 * @returns {Uint8Array}
 */
export function resample(bgra, width, height, toWidth, toHeight){
    // ponytail: point sampling where D3DX filters (triangle by default); a filter
    // when a program's picture shows the difference.
    const out = new Uint8Array(toWidth * toHeight * 4);
    for (let y = 0; y < toHeight; y++)
    {
        const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / toHeight));
        for (let x = 0; x < toWidth; x++)
        {
            const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / toWidth));
            out.set(bgra.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4),
                (y * toWidth + x) * 4);
        }
    }
    return out;
}

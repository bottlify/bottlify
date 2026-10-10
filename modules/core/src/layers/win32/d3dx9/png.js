/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PNG files, read into B, G, R, A bytes the way D3DX's file loaders take every
 * image: the chunks of the W3C PNG specification -- IHDR, PLTE, tRNS and the
 * IDAT run, whose zlib stream the cabinet layer's deflate decoder inflates --
 * every colour type at every bit depth it allows, the five row filters, and
 * Adam7 interlacing.
 *
 * The format D3DXIMAGE_INFO names is the one the file's pixels hold as
 * Windows' imaging component decodes them, which is what D3DX reads a PNG
 * through: grey as L8, colour as R8G8B8, with alpha A8R8G8B8, a palette P8,
 * sixteen bits a channel A16B16G16R16.
 */

import { createInflater, InflateError } from '../cabinet/inflate.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Colour types, by the samples a pixel has. */
const SAMPLES = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
/** The bit depths each colour type allows. */
const DEPTHS = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]],
    [4, [8, 16]], [6, [8, 16]]]);

/** Adam7: each pass's first column and row and its steps across and down. */
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4],
    [1, 0, 2, 2], [0, 1, 1, 2]];

/** D3DFORMAT numbers this file names. */
const D3DFMT = Object.freeze({ R8G8B8: 20, A8R8G8B8: 21, A16B16G16R16: 36, P8: 41, L8: 50 });

export class PngError extends Error {}

/** @param {Uint8Array} bytes */
export const isPng = bytes=>bytes.length >= 8 && SIGNATURE.every((b, i)=>bytes[i] === b);

/**
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, format: number, bgra: Uint8Array }}
 */
export function readPng(bytes){
    if (!isPng(bytes))
    {
        throw new PngError('not a PNG file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /** @type {{ width: number, height: number, depth: number, colour: number, interlace: number } | null} */
    let header = null;
    /** @type {Uint8Array | null} */
    let palette = null;
    /** @type {Uint8Array | null} */
    let transparency = null;
    /** @type {Uint8Array[]} */
    const data = [];
    let at = 8;
    for (;;)
    {
        if (at + 8 > bytes.length)
        {
            throw new PngError('a PNG file cut short of its IEND');
        }
        const length = view.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const body = bytes.subarray(at + 8, at + 8 + length);
        if (body.length !== length)
        {
            throw new PngError(`a PNG ${type} chunk cut short`);
        }
        at += 12 + length;
        if (type === 'IHDR')
        {
            const chunk = new DataView(body.buffer, body.byteOffset, body.byteLength);
            header = { width: chunk.getUint32(0), height: chunk.getUint32(4), depth: body[8],
                colour: body[9], interlace: body[12] };
            if (header.width === 0 || header.height === 0
                || !(DEPTHS.get(header.colour) ?? []).includes(header.depth)
                || body[10] !== 0 || body[11] !== 0 || header.interlace > 1)
            {
                throw new PngError('a PNG header this specification does not allow');
            }
        }
        else if (type === 'PLTE')
        {
            palette = body;
        }
        else if (type === 'tRNS')
        {
            transparency = body;
        }
        else if (type === 'IDAT')
        {
            data.push(body);
        }
        else if (type === 'IEND')
        {
            break;
        }
    }
    if (!header || data.length === 0)
    {
        throw new PngError('a PNG file without its header or its image data');
    }
    if (header.colour === 3 && !palette)
    {
        throw new PngError('a palette PNG without its PLTE');
    }
    const { width, height, depth, colour } = header;
    const samples = /** @type {number} */ (SAMPLES.get(colour));
    const bitsPerPixel = samples * depth;
    const filterUnit = Math.max(1, bitsPerPixel >> 3);

    const passes = header.interlace
        ? ADAM7.map(([x0, y0, dx, dy])=>({ x0, y0, dx, dy,
            w: Math.ceil(Math.max(0, width - x0) / dx), h: Math.ceil(Math.max(0, height - y0) / dy) }))
        : [{ x0: 0, y0: 0, dx: 1, dy: 1, w: width, h: height }];
    const rowBytesOf = (/** @type {number} */ w)=>Math.ceil(w * bitsPerPixel / 8);
    const expected = passes.reduce((n, p)=>n + (p.w && p.h ? p.h * (1 + rowBytesOf(p.w)) : 0), 0);

    const zlib = concat(data);
    if (zlib.length < 2 || (zlib[0] & 0x0f) !== 8 || ((zlib[0] << 8) | zlib[1]) % 31 !== 0
        || (zlib[1] & 0x20) !== 0)
    {
        throw new PngError('a PNG whose image data is not a zlib stream of deflate');
    }
    let raw;
    try
    {
        raw = createInflater().inflate(zlib.subarray(2), expected);
    }
    catch (e){
        if (e instanceof InflateError)
        {
            throw new PngError(`a PNG whose image data does not inflate: ${e.message}`);
        }
        throw e;
    }
    if (raw.length < expected)
    {
        throw new PngError('a PNG whose image data is shorter than its rows');
    }

    const bgra = new Uint8Array(width * height * 4);
    const maximum = (1 << depth) - 1;
    /** One sample of a row, at a sample index. @param {Uint8Array} row @param {number} index */
    const sampleAt = (row, index)=>{
        if (depth === 16)
        {
            return (row[index * 2] << 8) | row[index * 2 + 1];
        }
        if (depth === 8)
        {
            return row[index];
        }
        const bit = index * depth;
        return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maximum;
    };
    /** A sample scaled to eight bits. @param {number} value */
    const eight = value=>(depth === 16 ? value >> 8 : depth === 8 ? value
        : Math.round(value * 255 / maximum));
    // The one colour tRNS makes transparent, for grey and truecolour, in samples.
    const key = transparency && colour === 0 && transparency.length >= 2
        ? [(transparency[0] << 8) | transparency[1]]
        : transparency && colour === 2 && transparency.length >= 6
            ? [0, 2, 4].map(i=>(/** @type {Uint8Array} */ (transparency)[i] << 8)
                | /** @type {Uint8Array} */ (transparency)[i + 1])
            : null;

    let offset = 0;
    for (const pass of passes)
    {
        if (pass.w === 0 || pass.h === 0)
        {
            continue;
        }
        const rowBytes = rowBytesOf(pass.w);
        let previous = new Uint8Array(rowBytes);
        for (let y = 0; y < pass.h; y++)
        {
            const filter = raw[offset];
            const row = raw.slice(offset + 1, offset + 1 + rowBytes);
            offset += 1 + rowBytes;
            unfilter(filter, row, previous, filterUnit);
            previous = row;
            for (let x = 0; x < pass.w; x++)
            {
                const px = pass.x0 + x * pass.dx;
                const py = pass.y0 + y * pass.dy;
                const out = (py * width + px) * 4;
                const s = (/** @type {number} */ k)=>sampleAt(row, x * samples + k);
                let r;
                let g;
                let b;
                let a = 255;
                if (colour === 3)
                {
                    const index = s(0);
                    const entries = /** @type {Uint8Array} */ (palette);
                    r = entries[index * 3] ?? 0;
                    g = entries[index * 3 + 1] ?? 0;
                    b = entries[index * 3 + 2] ?? 0;
                    a = transparency && index < transparency.length ? transparency[index] : 255;
                }
                else if (colour === 0 || colour === 4)
                {
                    r = g = b = eight(s(0));
                    if (colour === 4)
                    {
                        a = eight(s(1));
                    }
                    else if (key && s(0) === key[0])
                    {
                        a = 0;
                    }
                }
                else
                {
                    r = eight(s(0));
                    g = eight(s(1));
                    b = eight(s(2));
                    if (colour === 6)
                    {
                        a = eight(s(3));
                    }
                    else if (key && s(0) === key[0] && s(1) === key[1] && s(2) === key[2])
                    {
                        a = 0;
                    }
                }
                bgra[out] = b;
                bgra[out + 1] = g;
                bgra[out + 2] = r;
                bgra[out + 3] = a;
            }
        }
    }

    const format = depth === 16 ? D3DFMT.A16B16G16R16
        : colour === 3 ? D3DFMT.P8
            : colour === 0 ? (key ? D3DFMT.A8R8G8B8 : D3DFMT.L8)
                : colour === 2 ? (key ? D3DFMT.A8R8G8B8 : D3DFMT.R8G8B8)
                    : D3DFMT.A8R8G8B8;
    return { width, height, format, bgra };
}

/** @param {Uint8Array[]} parts */
function concat(parts){
    const out = new Uint8Array(parts.reduce((n, p)=>n + p.length, 0));
    let at = 0;
    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * Undoes one row's filter in place, against the row above as already undone.
 *
 * @param {number} filter @param {Uint8Array} row @param {Uint8Array} above
 * @param {number} unit  Bytes a pixel spans, at least one.
 */
function unfilter(filter, row, above, unit){
    switch (filter)
    {
        case 0:
            return;
        case 1:
            for (let i = unit; i < row.length; i++)
            {
                row[i] = (row[i] + row[i - unit]) & 0xff;
            }
            return;
        case 2:
            for (let i = 0; i < row.length; i++)
            {
                row[i] = (row[i] + above[i]) & 0xff;
            }
            return;
        case 3:
            for (let i = 0; i < row.length; i++)
            {
                const left = i >= unit ? row[i - unit] : 0;
                row[i] = (row[i] + ((left + above[i]) >> 1)) & 0xff;
            }
            return;
        case 4:
            for (let i = 0; i < row.length; i++)
            {
                const left = i >= unit ? row[i - unit] : 0;
                const up = above[i];
                const corner = i >= unit ? above[i - unit] : 0;
                const p = left + up - corner;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - corner);
                const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
                row[i] = (row[i] + predictor) & 0xff;
            }
            return;
        default:
            throw new PngError(`a PNG row filter ${filter}, which does not exist`);
    }
}

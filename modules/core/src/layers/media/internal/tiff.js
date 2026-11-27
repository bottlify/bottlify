/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A TIFF decoder for the baseline a texture is saved in: the first image of
 * the file, in strips, chunky (one plane), bilevel, grey, palette or RGB with
 * or without an extra alpha sample, 1, 2, 4, 8 or 16 bits a sample, stored
 * plain, PackBits or LZW, with or without horizontal differencing. Tiles,
 * planar storage, JPEG and deflate compression are refused, the refusal
 * naming which.
 */

/** A TIFF this decoder cannot read, with the reason. */
export class TiffError extends Error {}

/**
 * @typedef {Object} DecodedTiff
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} rgba  width * height texels, top-down
 */

/** @param {Uint8Array} bytes */
export const isTiff = bytes=>bytes.length >= 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49
    && bytes[2] === 0x2a && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d
    && bytes[2] === 0 && bytes[3] === 0x2a));

const TAG = Object.freeze({ WIDTH: 256, HEIGHT: 257, BITS: 258, COMPRESSION: 259,
    PHOTOMETRIC: 262, STRIP_OFFSETS: 273, SAMPLES: 277, ROWS_PER_STRIP: 278, STRIP_BYTES: 279,
    PLANAR: 284, PREDICTOR: 317, COLOUR_MAP: 320, TILE_WIDTH: 322, EXTRA_SAMPLES: 338 });

/** Bytes a value of each TIFF field type takes. */
const TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/**
 * A strip packed with PackBits.
 *
 * @param {Uint8Array} data @param {number} size  the bytes it unpacks to
 */
function unpackBits(data, size){
    const out = new Uint8Array(size);
    let to = 0;
    for (let at = 0; at < data.length && to < size;)
    {
        const n = (data[at++] << 24) >> 24;
        if (n >= 0)
        {
            const run = Math.min(n + 1, size - to, data.length - at);
            out.set(data.subarray(at, at + run), to);
            to += run;
            at += n + 1;
        }
        else if (n !== -128)
        {
            out.fill(data[at++], to, Math.min(size, to + 1 - n));
            to += 1 - n;
        }
    }
    return out;
}

/**
 * A strip packed with TIFF's LZW: codes most significant bit first, the code
 * size growing a code early.
 *
 * @param {Uint8Array} data @param {number} size
 */
function unpackLzw(data, size){
    const out = new Uint8Array(size);
    /** @type {Uint8Array[]} */
    let table = [];
    const reset = ()=>{
        table = Array.from({ length: 258 }, (_, i)=>Uint8Array.of(i));
    };
    reset();
    let to = 0;
    let bits = 9;
    let bit = 0;
    /** @type {Uint8Array | null} */
    let previous = null;
    /** @param {Uint8Array} run */
    const put = run=>{
        out.set(run.subarray(0, Math.max(0, size - to)), to);
        to += run.length;
    };
    for (;;)
    {
        if (to >= size || bit + bits > data.length * 8)
        {
            break;
        }
        let code = 0;
        for (let i = 0; i < bits; i++, bit++)
        {
            code = code << 1 | (data[bit >> 3] >> (7 - (bit & 7)) & 1);
        }
        if (code === 256)
        {
            reset();
            bits = 9;
            previous = null;
            continue;
        }
        if (code === 257)
        {
            break;
        }
        /** @type {Uint8Array} */
        let run;
        if (code < table.length)
        {
            run = table[code];
            if (previous)
            {
                table.push(Uint8Array.of(...previous, run[0]));
            }
        }
        else if (previous && code === table.length)
        {
            run = Uint8Array.of(...previous, previous[0]);
            table.push(run);
        }
        else
        {
            throw new TiffError(`a TIFF LZW code ${code} past the table's ${table.length}`);
        }
        put(run);
        previous = run;
        if (table.length + 1 >= 1 << bits && bits < 12)
        {
            bits++;
        }
    }
    return out;
}

/**
 * The first image of a TIFF file.
 *
 * @param {Uint8Array} bytes
 * @returns {DecodedTiff}
 */
export function decodeTiff(bytes){
    if (!isTiff(bytes))
    {
        throw new TiffError('not a TIFF file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[0] === 0x49;
    /** @param {number} at @param {number} n */
    const need = (at, n)=>{
        if (at < 0 || at + n > bytes.length)
        {
            throw new TiffError('a TIFF file cut short');
        }
    };
    /** @param {number} at */
    const u16 = at=>{
        need(at, 2);
        return view.getUint16(at, little);
    };
    /** @param {number} at */
    const u32 = at=>{
        need(at, 4);
        return view.getUint32(at, little);
    };
    const ifd = u32(4);
    /** @type {Map<number, number[]>} */
    const tags = new Map();
    const count = u16(ifd);
    for (let i = 0; i < count; i++)
    {
        const entry = ifd + 2 + i * 12;
        const [tag, type, n] = [u16(entry), u16(entry + 2), u32(entry + 4)];
        const size = TYPE_BYTES[type] ?? 0;
        if (size === 0 || n === 0)
        {
            continue;
        }
        const at = size * n <= 4 ? entry + 8 : u32(entry + 8);
        need(at, size * n);
        tags.set(tag, Array.from({ length: n }, (_, k)=>(size === 1 ? bytes[at + k]
            : size === 2 ? view.getUint16(at + k * 2, little) : view.getUint32(at + k * size,
                little))));
    }
    /** @param {number} tag @param {number} [fallback] */
    const one = (tag, fallback)=>{
        const value = tags.get(tag)?.[0] ?? fallback;
        if (value === undefined)
        {
            throw new TiffError(`a TIFF image without tag ${tag}`);
        }
        return value;
    };
    const width = one(TAG.WIDTH);
    const height = one(TAG.HEIGHT);
    const samples = one(TAG.SAMPLES, 1);
    const depth = one(TAG.BITS, 1);
    const compression = one(TAG.COMPRESSION, 1);
    const photometric = one(TAG.PHOTOMETRIC, samples >= 3 ? 2 : 1);
    if (tags.has(TAG.TILE_WIDTH))
    {
        throw new TiffError('a tiled TIFF image');
    }
    if (one(TAG.PLANAR, 1) !== 1 && samples > 1)
    {
        throw new TiffError('a TIFF image stored plane by plane');
    }
    if (![1, 2, 4, 8, 16].includes(depth))
    {
        throw new TiffError(`a TIFF image of ${depth} bits a sample`);
    }
    if (![0, 1, 2, 3].includes(photometric))
    {
        throw new TiffError(`a TIFF image of photometric interpretation ${photometric}`);
    }
    if (photometric === 2 ? samples < 3 : samples < 1)
    {
        throw new TiffError(`a TIFF image of ${samples} samples for its colours`);
    }
    if (![1, 5, 32773].includes(compression))
    {
        throw new TiffError(`a TIFF image of compression ${compression}`);
    }
    const rowBytes = Math.ceil(width * samples * depth / 8);
    const perStrip = Math.min(height, one(TAG.ROWS_PER_STRIP, height) || height);
    const offsets = tags.get(TAG.STRIP_OFFSETS) ?? [];
    const sizes = tags.get(TAG.STRIP_BYTES) ?? [];
    const pixels = new Uint8Array(rowBytes * height);
    offsets.forEach((offset, strip)=>{
        const first = strip * perStrip;
        if (first >= height)
        {
            return;
        }
        const size = rowBytes * Math.min(perStrip, height - first);
        const stored = sizes[strip] ?? (compression === 1 ? size : bytes.length - offset);
        need(offset, Math.min(stored, bytes.length - offset));
        const data = bytes.subarray(offset, offset + stored);
        const plain = compression === 5 ? unpackLzw(data, size)
            : compression === 32773 ? unpackBits(data, size) : data.subarray(0, size);
        pixels.set(plain.subarray(0, size), first * rowBytes);
    });
    if (one(TAG.PREDICTOR, 1) === 2)
    {
        if (depth !== 8)
        {
            throw new TiffError(`a TIFF image differenced at ${depth} bits a sample`);
        }
        for (let y = 0; y < height; y++)
        {
            for (let x = samples; x < width * samples; x++)
            {
                const at = y * rowBytes + x;
                pixels[at] = pixels[at] + pixels[at - samples] & 0xff;
            }
        }
    }
    /** Sample `s` of texel (x, y), scaled to 8 bits. @param {number} x @param {number} y @param {number} s */
    const sample = (x, y, s)=>{
        const index = x * samples + s;
        if (depth === 16)
        {
            return pixels[y * rowBytes + index * 2 + (little ? 1 : 0)];
        }
        if (depth === 8)
        {
            return pixels[y * rowBytes + index];
        }
        const bit = index * depth;
        const value = pixels[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))
            & ((1 << depth) - 1);
        return Math.round(value * 255 / ((1 << depth) - 1));
    };
    /** A palette index (raw, not scaled). @param {number} x @param {number} y */
    const index = (x, y)=>{
        if (depth === 8 || depth === 16)
        {
            const at = y * rowBytes + x * samples * (depth >> 3);
            return depth === 8 ? pixels[at]
                : little ? pixels[at] | pixels[at + 1] << 8 : pixels[at] << 8 | pixels[at + 1];
        }
        const bit = x * samples * depth;
        return pixels[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7)) & ((1 << depth) - 1);
    };
    const map = tags.get(TAG.COLOUR_MAP);
    if (photometric === 3 && (!map || map.length < 3 << depth))
    {
        throw new TiffError('a palette TIFF image without its colour map');
    }
    const colours = 1 << depth;
    const alpha = (photometric === 2 ? samples > 3 : samples > 1)
        && (tags.get(TAG.EXTRA_SAMPLES)?.[0] ?? 2) !== 0;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const to = (y * width + x) * 4;
            if (photometric === 2)
            {
                rgba[to] = sample(x, y, 0);
                rgba[to + 1] = sample(x, y, 1);
                rgba[to + 2] = sample(x, y, 2);
                rgba[to + 3] = alpha ? sample(x, y, 3) : 255;
            }
            else if (photometric === 3)
            {
                const i = Math.min(index(x, y), colours - 1);
                const entries = /** @type {number[]} */ (map);
                rgba[to] = entries[i] >> 8;
                rgba[to + 1] = entries[colours + i] >> 8;
                rgba[to + 2] = entries[colours * 2 + i] >> 8;
                rgba[to + 3] = 255;
            }
            else
            {
                const grey = photometric === 0 ? 255 - sample(x, y, 0) : sample(x, y, 0);
                rgba.fill(grey, to, to + 3);
                rgba[to + 3] = alpha ? sample(x, y, 1) : 255;
            }
        }
    }
    return { width, height, rgba };
}

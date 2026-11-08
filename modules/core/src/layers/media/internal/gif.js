/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A GIF decoder (87a and 89a): the first frame, as an imaging codec hands a
 * still picture over. Its own colour table or the file's, its interlaced
 * rows put back in order, the graphic control extension's transparent index
 * made alpha 0. The frame is its own size: the logical screen around it, and
 * the frames after it, are an animation's, not a texture's.
 */

/** A GIF this decoder cannot read, with the reason. */
export class GifError extends Error {}

/**
 * @typedef {Object} DecodedGif
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} rgba  width * height texels, top-down
 */

/** @param {Uint8Array} bytes */
export const isGif = bytes=>bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49
    && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39)
    && bytes[5] === 0x61;

/**
 * The LZW code stream of an image's data sub-blocks, decoded into `count`
 * colour indices (a short stream leaves the rest 0).
 *
 * @param {Uint8Array} data  the sub-blocks' bytes, joined
 * @param {number} minimum  the code size the image names, 2 to 8
 * @param {number} count
 * @returns {Uint8Array}
 */
function decodeLzw(data, minimum, count){
    const out = new Uint8Array(count);
    const clear = 1 << minimum;
    const end = clear + 1;
    /** Each code's first index, last index and the code before it: a string is a chain. */
    const prefix = new Int32Array(4096);
    const suffix = new Uint8Array(4096);
    const first = new Uint8Array(4096);
    const lengths = new Uint16Array(4096);
    for (let i = 0; i < clear; i++)
    {
        prefix[i] = -1;
        suffix[i] = i;
        first[i] = i;
        lengths[i] = 1;
    }
    let size = minimum + 1;
    let next = end + 1;
    let previous = -1;
    let written = 0;
    let bit = 0;
    const bits = data.length * 8;
    /** @param {number} code */
    const put = code=>{
        const length = lengths[code];
        let at = written + length - 1;
        for (let c = code; c >= 0 && at >= written; c = prefix[c], at--)
        {
            if (at < count)
            {
                out[at] = suffix[c];
            }
        }
        written += length;
    };
    for (;;)
    {
        if (written >= count || bit + size > bits)
        {
            break;
        }
        let code = 0;
        for (let i = 0; i < size; i++, bit++)
        {
            code |= (data[bit >> 3] >> (bit & 7) & 1) << i;
        }
        if (code === clear)
        {
            size = minimum + 1;
            next = end + 1;
            previous = -1;
            continue;
        }
        if (code === end)
        {
            break;
        }
        if (previous < 0)
        {
            if (code >= clear)
            {
                throw new GifError('a GIF whose first code is no colour');
            }
            put(code);
            previous = code;
            continue;
        }
        if (code > next || (code === next && next >= 4096))
        {
            throw new GifError(`a GIF code ${code} past the table's ${next}`);
        }
        if (next < 4096)
        {
            // The new string is the previous one and the first index of this
            // one, or, for the code being made, of the previous one.
            prefix[next] = previous;
            suffix[next] = code === next ? first[previous] : first[code];
            first[next] = first[previous];
            lengths[next] = lengths[previous] + 1;
            next++;
            if (next === 1 << size && size < 12)
            {
                size++;
            }
        }
        put(code);
        previous = code;
    }
    return out;
}

/**
 * The first frame of a GIF file.
 *
 * @param {Uint8Array} bytes
 * @returns {DecodedGif}
 */
export function decodeGif(bytes){
    if (!isGif(bytes) || bytes.length < 13)
    {
        throw new GifError('not a GIF file');
    }
    /** @param {number} at */
    const u16 = at=>{
        if (at + 2 > bytes.length)
        {
            throw new GifError('a GIF file cut short');
        }
        return bytes[at] | bytes[at + 1] << 8;
    };
    const packed = bytes[10];
    let at = 13;
    /** @type {Uint8Array | null} */
    let global = null;
    if (packed & 0x80)
    {
        const size = 3 << ((packed & 7) + 1);
        global = bytes.subarray(at, at + size);
        at += size;
    }
    let transparent = -1;
    /** The data sub-blocks from `at`, joined; `at` moved past their terminator. */
    const blocks = ()=>{
        /** @type {Uint8Array[]} */
        const parts = [];
        let total = 0;
        while (at < bytes.length && bytes[at] !== 0)
        {
            const length = bytes[at];
            parts.push(bytes.subarray(at + 1, at + 1 + length));
            total += length;
            at += 1 + length;
        }
        at++;
        const joined = new Uint8Array(total);
        let to = 0;
        for (const part of parts)
        {
            joined.set(part, to);
            to += part.length;
        }
        return joined;
    };
    while (at < bytes.length)
    {
        const kind = bytes[at++];
        if (kind === 0x3b)
        {
            break;
        }
        if (kind === 0x21)
        {
            const label = bytes[at++];
            const body = blocks();
            if (label === 0xf9 && body.length >= 4)
            {
                transparent = (body[0] & 1) ? body[3] : -1;
            }
            continue;
        }
        if (kind !== 0x2c)
        {
            throw new GifError(`a GIF block of kind 0x${kind.toString(16)}`);
        }
        const width = u16(at + 4);
        const height = u16(at + 6);
        const flags = bytes[at + 8];
        at += 9;
        let table = global;
        if (flags & 0x80)
        {
            const size = 3 << ((flags & 7) + 1);
            table = bytes.subarray(at, at + size);
            at += size;
        }
        if (!table)
        {
            throw new GifError('a GIF image with no colour table');
        }
        const minimum = bytes[at++];
        if (minimum < 2 || minimum > 8)
        {
            throw new GifError(`a GIF code size of ${minimum}`);
        }
        const indices = decodeLzw(blocks(), minimum, width * height);
        // Interlaced rows come every 8th from 0, every 8th from 4, every 4th
        // from 2, every other from 1.
        const rows = (flags & 0x40)
            ? [[0, 8], [4, 8], [2, 4], [1, 2]].flatMap(([start, step])=>
                Array.from({ length: Math.max(0, Math.ceil((height - start) / step)) },
                    (_, i)=>start + i * step))
            : Array.from({ length: height }, (_, i)=>i);
        const rgba = new Uint8Array(width * height * 4);
        const colours = table.length / 3;
        rows.forEach((y, line)=>{
            for (let x = 0; x < width; x++)
            {
                const index = indices[line * width + x];
                const to = (y * width + x) * 4;
                if (index === transparent || index >= colours)
                {
                    continue;
                }
                rgba[to] = table[index * 3];
                rgba[to + 1] = table[index * 3 + 1];
                rgba[to + 2] = table[index * 3 + 2];
                rgba[to + 3] = 255;
            }
        });
        return { width, height, rgba };
    }
    throw new GifError('a GIF file with no image');
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Cinepak (FOURCC cvid), the codec of most CD-ROM game cut-scenes, as Radius
 * laid out its frames:
 *
 * - a frame: a flags byte, a 24-bit size, width and height (16 bits each) and
 *   the number of strips, big-endian; bit 0 of the flags clear means each strip
 *   starts from the codebooks of the strip above it;
 * - a strip: an id byte, a 24-bit size, its rectangle (top, left, bottom,
 *   right; a top of zero places it under the strip before, its bottom then a
 *   height), and chunks, each an id byte and a 24-bit size;
 * - codebook chunks 0x20-0x27: 256 entries of a 2x2 block, four luma values
 *   and, unless bit 2 of the id says grey, a signed U and V; bit 0 says only
 *   the entries a 32-bit flag word marks are given; 0x2x with bit 1 clear fills
 *   the V4 book, with it set the V1 book;
 * - image chunks 0x30 (every block coded), 0x31 (a flag bit a block says
 *   whether it changed) and 0x32 (every block V1): a block is 4x4 pixels, V1 is
 *   one entry of the V1 book doubled in both directions, V4 four entries of the
 *   V4 book, one a 2x2 quarter; a flag bit set chooses V4.
 *
 * Colour is R = Y + 2V, G = Y - U/2 - V, B = Y + 2U, each clamped to a byte.
 */

/** One strip's two codebooks, 256 entries of four RGB pixels each. */
const newBooks = ()=>({ v4: new Uint8Array(256 * 12), v1: new Uint8Array(256 * 12) });

/**
 * @typedef {Object} CinepakState  what a stream's frames carry over: each
 *     strip's codebooks, which a later frame updates in part
 * @property {{ v4: Uint8Array, v1: Uint8Array }[]} strips
 */

/** @returns {CinepakState} */
export const newCinepakState = ()=>({ strips: [] });

const clamp = (/** @type {number} */ value)=>(value < 0 ? 0 : value > 255 ? 255 : value);
const big16 = (/** @type {Uint8Array} */ data, /** @type {number} */ at)=>
    (data[at] ?? 0) << 8 | (data[at + 1] ?? 0);
const big24 = (/** @type {Uint8Array} */ data, /** @type {number} */ at)=>
    (data[at] ?? 0) << 16 | (data[at + 1] ?? 0) << 8 | (data[at + 2] ?? 0);
const big32 = (/** @type {Uint8Array} */ data, /** @type {number} */ at)=>
    ((data[at] ?? 0) << 24 | (data[at + 1] ?? 0) << 16 | (data[at + 2] ?? 0) << 8 | (data[at +
        3] ?? 0)) >>> 0;

/**
 * @param {Uint8Array} book @param {number} id @param {Uint8Array} data
 * @param {number} at @param {number} end
 */
function readCodebook(book, id, data, at, end){
    const length = (id & 0x04) !== 0 ? 4 : 6;
    let flag = 0;
    let mask = 0;
    for (let entry = 0; entry < 256; entry++)
    {
        if ((id & 0x01) !== 0)
        {
            mask >>>= 1;
            if (mask === 0)
            {
                if (at + 4 > end)
                {
                    return;
                }
                flag = big32(data, at);
                at += 4;
                mask = 0x80000000;
            }
            if ((flag & mask) === 0)
            {
                continue;
            }
        }
        if (at + length > end)
        {
            return;
        }
        const base = entry * 12;
        const u = length === 6 ? (data[at + 4] << 24 >> 24) : 0;
        const v = length === 6 ? (data[at + 5] << 24 >> 24) : 0;
        for (let k = 0; k < 4; k++)
        {
            const y = data[at + k];
            book[base + k * 3] = clamp(y + v * 2);
            // U/2 truncates toward zero, as a C division does.
            book[base + k * 3 + 1] = clamp(y - Math.trunc(u / 2) - v);
            book[base + k * 3 + 2] = clamp(y + u * 2);
        }
        at += length;
    }
}

/**
 * Decodes one frame into `rgb` (width * height * 3, top row first), over the
 * frame before it: a block a later frame leaves unchanged keeps its pixels.
 *
 * @param {Uint8Array} data
 * @param {number} width @param {number} height
 * @param {Uint8Array} rgb
 * @param {CinepakState} state
 */
export function decodeCinepak(data, width, height, rgb, state){
    if (data.length < 10)
    {
        return;
    }
    const frameFlags = data[0];
    const strips = big16(data, 8);
    let at = 10;
    let top = 0;
    /**
     * @param {number} x @param {number} y @param {Uint8Array} book @param {number} entry @param
     *     {number} pixel
     */
    const put = (x, y, book, entry, pixel)=>{
        if (x < width && y < height)
        {
            const to = (y * width + x) * 3;
            const from = entry * 12 + pixel * 3;
            rgb[to] = book[from];
            rgb[to + 1] = book[from + 1];
            rgb[to + 2] = book[from + 2];
        }
    };
    for (let s = 0; s < strips && at + 12 <= data.length; s++)
    {
        const size = big24(data, at + 1);
        const end = Math.min(at + size, data.length);
        let y1 = big16(data, at + 4);
        const x1 = big16(data, at + 6);
        let y2 = big16(data, at + 8);
        const x2 = big16(data, at + 10);
        if (y1 === 0)
        {
            y1 = top;
            y2 = top + y2;
        }
        top = y2;
        if (!state.strips[s])
        {
            state.strips[s] = newBooks();
        }
        const books = state.strips[s];
        if (s > 0 && (frameFlags & 0x01) === 0)
        {
            books.v4.set(state.strips[s - 1].v4);
            books.v1.set(state.strips[s - 1].v1);
        }
        let chunk = at + 12;
        while (chunk + 4 <= end)
        {
            const id = data[chunk];
            const chunkEnd = Math.min(chunk + big24(data, chunk + 1), end);
            const body = chunk + 4;
            if (id >= 0x20 && id <= 0x27)
            {
                readCodebook((id & 0x02) !== 0 ? books.v1 : books.v4, id, data, body, chunkEnd);
            }
            else if (id >= 0x30 && id <= 0x32)
            {
                decodeVectors(id, data, body, chunkEnd, books, { x1, x2, y1, y2 }, put);
                break;
            }
            if (chunkEnd <= chunk)
            {
                break;
            }
            chunk = chunkEnd;
        }
        at = end > at ? end : data.length;
    }
}

/**
 * @param {number} id @param {Uint8Array} data @param {number} at @param {number} end
 * @param {{ v4: Uint8Array, v1: Uint8Array }} books
 * @param {{ x1: number, x2: number, y1: number, y2: number }} area
 * @param {(x: number, y: number, book: Uint8Array, entry: number, pixel: number) => void} put
 */
function decodeVectors(id, data, at, end, books, area, put){
    let flag = 0;
    let mask = 0;
    const nextBit = ()=>{
        mask >>>= 1;
        if (mask === 0)
        {
            if (at + 4 > end)
            {
                return null;
            }
            flag = big32(data, at);
            at += 4;
            mask = 0x80000000;
        }
        return (flag & mask) !== 0;
    };
    for (let y = area.y1; y < area.y2; y += 4)
    {
        for (let x = area.x1; x < area.x2; x += 4)
        {
            if ((id & 0x01) !== 0)
            {
                const changed = nextBit();
                if (changed === null)
                {
                    return;
                }
                if (!changed)
                {
                    continue;
                }
            }
            let v4 = false;
            if ((id & 0x02) === 0)
            {
                const bit = nextBit();
                if (bit === null)
                {
                    return;
                }
                v4 = bit;
            }
            if (!v4)
            {
                if (at >= end)
                {
                    return;
                }
                const entry = data[at++];
                for (let dy = 0; dy < 4; dy++)
                {
                    for (let dx = 0; dx < 4; dx++)
                    {
                        put(x + dx, y + dy, books.v1, entry, (dy >> 1) * 2 + (dx >> 1));
                    }
                }
                continue;
            }
            if (at + 4 > end)
            {
                return;
            }
            for (let quarter = 0; quarter < 4; quarter++)
            {
                const entry = data[at + quarter];
                const qx = x + (quarter & 1) * 2;
                const qy = y + (quarter >> 1) * 2;
                for (let pixel = 0; pixel < 4; pixel++)
                {
                    put(qx + (pixel & 1), qy + (pixel >> 1), books.v4, entry, pixel);
                }
            }
            at += 4;
        }
    }
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The picture a cursor or icon handle stands for, as the page is shown it:
 * four bytes a pixel, blue, green, red and alpha, top row first.
 *
 * A cursor is two masks: AND says where the screen shows through, XOR what is
 * drawn there. Where AND keeps the screen and XOR is not zero the screen is
 * inverted under the cursor -- a page cannot invert what lies beneath a
 * picture, so such a pixel is drawn opaque black. A 32-bit image with any
 * alpha in it is drawn by its alpha, and its AND mask is not read.
 */

/**
 * @typedef {Object} CursorPicture
 * @property {number} width
 * @property {number} height
 * @property {{ x: number, y: number }} hotSpot
 * @property {Uint8Array} bgra
 */

/** A DIB's header, and the only compression an icon or cursor image uses here. */
const BITMAPINFOHEADER_SIZE = 40;
const BI_RGB = 0;
/** No icon or cursor image is larger than this each way. */
const MAX_SIDE = 256;
/** A group directory's header and each of its entries. */
const GROUP_HEADER_SIZE = 6;
const GROUP_ENTRY_SIZE = 14;

/**
 * Writes one pixel from the two masks' answer and the colour XOR carries.
 *
 * @param {Uint8Array} out @param {number} at @param {boolean} screen  AND's bit
 * @param {number} b @param {number} g @param {number} r
 */
function putMasked(out, at, screen, b, g, r){
    if (!screen)
    {
        out.set([b, g, r, 255], at);
        return;
    }
    const inverts = (b | g | r) !== 0;
    out.set([0, 0, 0, inverts ? 255 : 0], at);
}

/**
 * A cursor made from two monochrome planes, as CreateCursor takes them: rows
 * top first, each padded to a WORD.
 *
 * @param {number} width @param {number} height
 * @param {Uint8Array} and @param {Uint8Array} xor
 * @returns {Uint8Array}
 */
export function planesToBgra(width, height, and, xor){
    const stride = ((width + 15) >>> 4) * 2;
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const at = y * stride + (x >>> 3);
            const bit = 7 - (x & 7);
            const white = ((xor[at] >>> bit) & 1) !== 0 ? 255 : 0;
            putMasked(out, (y * width + x) * 4, ((and[at] >>> bit) & 1) !== 0,
                white, white, white);
        }
    }
    return out;
}

/**
 * The image of one icon or cursor entry: a BITMAPINFOHEADER whose height
 * counts both masks, a colour table for 8 bits or fewer, the XOR bitmap and
 * the AND mask, both bottom row first. Null for a form it cannot read -- a
 * PNG-compressed entry, a compression, a depth -- which the page then shows
 * as its own cursor.
 *
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, bgra: Uint8Array } | null}
 */
export function dibToBgra(bytes){
    if (bytes.length < BITMAPINFOHEADER_SIZE)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint32(0, true);
    const width = view.getInt32(4, true);
    const height = view.getInt32(8, true) / 2;
    const depth = view.getUint16(14, true);
    if (headerSize < BITMAPINFOHEADER_SIZE || headerSize > bytes.length
        || view.getUint32(16, true) !== BI_RGB || ![1, 4, 8, 24, 32].includes(depth)
        || width <= 0 || width > MAX_SIDE || height <= 0 || height > MAX_SIDE
        || !Number.isInteger(height))
    {
        return null;
    }
    const colours = depth <= 8 ? view.getUint32(32, true) || 1 << depth : 0;
    const xorAt = headerSize + colours * 4;
    const xorStride = ((width * depth + 31) >>> 5) * 4;
    const andAt = xorAt + xorStride * height;
    const andStride = ((width + 31) >>> 5) * 4;
    if (andAt > bytes.length)
    {
        return null;
    }
    let alpha = false;
    if (depth === 32)
    {
        for (let at = xorAt + 3; at < andAt && !alpha; at += 4)
        {
            alpha = bytes[at] !== 0;
        }
    }
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        const row = xorAt + (height - 1 - y) * xorStride;
        const maskRow = andAt + (height - 1 - y) * andStride;
        for (let x = 0; x < width; x++)
        {
            const to = (y * width + x) * 4;
            const bit = x * depth;
            const colour = depth >= 24
                ? row + (bit >>> 3)
                : headerSize + Math.min((bytes[row + (bit >>> 3)] >>> (8 - depth - (bit & 7)))
                    & ((1 << depth) - 1), colours - 1) * 4;
            const [b, g, r] = [bytes[colour], bytes[colour + 1], bytes[colour + 2]];
            if (alpha)
            {
                out.set([b, g, r, bytes[colour + 3]], to);
                continue;
            }
            const mask = maskRow + (x >>> 3);
            const screen = mask < bytes.length && ((bytes[mask] >>> (7 - (x & 7))) & 1) !== 0;
            putMasked(out, to, screen, b, g, r);
        }
    }
    return { width, height, bgra: out };
}

/**
 * The id of the image a group directory (RT_GROUP_CURSOR or RT_GROUP_ICON)
 * offers at the size asked for -- the deepest of those -- or its first
 * image when none is that size; null for an empty or short directory.
 *
 * @param {Uint8Array} bytes @param {boolean} cursor @param {number} size
 * @returns {number | null}
 */
export function groupImageId(bytes, cursor, size){
    if (bytes.length < GROUP_HEADER_SIZE)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = Math.min(view.getUint16(4, true),
        Math.floor((bytes.length - GROUP_HEADER_SIZE) / GROUP_ENTRY_SIZE));
    /** @type {number | null} */
    let chosen = null;
    let chosenDepth = -1;
    for (let index = 0; index < count; index++)
    {
        const at = GROUP_HEADER_SIZE + index * GROUP_ENTRY_SIZE;
        // A cursor's entry names its width in a WORD; an icon's in a BYTE,
        // where 0 means 256.
        const width = cursor ? view.getUint16(at, true) : bytes[at] || MAX_SIDE;
        const depth = view.getUint16(at + 6, true);
        const id = view.getUint16(at + 12, true);
        if (index === 0)
        {
            chosen = id;
        }
        if (width === size && depth > chosenDepth)
        {
            chosen = id;
            chosenDepth = depth;
        }
    }
    return chosen;
}

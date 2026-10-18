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
 * drawn there. Where AND keeps the screen the screen is XORed with the colour
 * -- a page cannot XOR what lies beneath a picture, so such a pixel is drawn
 * black, as opaque as the colour changes the screen: XOR white, the inversion
 * an I-beam is drawn with, opaque; the near-black a colour cursor leaves
 * under its mask, clear. A 32-bit image with any alpha in it is drawn by its
 * alpha, and its AND mask is not read.
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
    // Opaque black for every non-zero colour put a box around a colour
    // cursor whose masked pixels hold a dark grey rather than black: Windows
    // draws those as the screen XOR (4, 4, 4), which is the screen.
    out.set([0, 0, 0, Math.max(b, g, r)], at);
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

/** The sixteen colours a four-bit device-dependent bitmap indexes, as r, g, b. */
const SIXTEEN_COLOURS = Object.freeze([
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128],
    [0, 128, 128], [192, 192, 192], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
    [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]);

/**
 * An icon made from a monochrome AND plane and an XOR bitmap of `depth`
 * bits, as CreateIcon takes them: device-dependent, rows top first, each
 * padded to a WORD. One bit is monochrome, four index the sixteen colours,
 * sixteen are 5-5-5, twenty-four and thirty-two are blue, green, red.
 *
 * @param {number} width @param {number} height @param {number} depth
 * @param {Uint8Array} and @param {Uint8Array} xor
 * @returns {Uint8Array}
 */
export function ddbToBgra(width, height, depth, and, xor){
    if (depth === 1)
    {
        return planesToBgra(width, height, and, xor);
    }
    const maskStride = ((width + 15) >>> 4) * 2;
    const stride = ((width * depth + 15) >>> 4) * 2;
    const out = new Uint8Array(width * height * 4);
    /** @param {number} row @param {number} x @returns {number[]} blue, green, red */
    const colourAt = (row, x)=>{
        if (depth >= 24)
        {
            const at = row + x * (depth >>> 3);
            return [xor[at], xor[at + 1], xor[at + 2]];
        }
        if (depth === 16)
        {
            const value = xor[row + x * 2] | xor[row + x * 2 + 1] << 8;
            return [(value & 31) << 3, (value >>> 5 & 31) << 3, (value >>> 10 & 31) << 3];
        }
        if (depth === 4)
        {
            const byte = xor[row + (x >>> 1)];
            const [r, g, b] = SIXTEEN_COLOURS[(x & 1) === 0 ? byte >>> 4 : byte & 15];
            return [b, g, r];
        }
        // ponytail: eight bits index the device's palette, read as grey here;
        // the system palette when a title draws one.
        return [xor[row + x], xor[row + x], xor[row + x]];
    };
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const [b, g, r] = colourAt(y * stride, x);
            const bit = 7 - (x & 7);
            putMasked(out, (y * width + x) * 4,
                ((and[y * maskStride + (x >>> 3)] >>> bit) & 1) !== 0, b, g, r);
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
 * The picture of a cursor file. A .cur file is a directory of entries, each
 * a hot spot and the offset of a cursor image (the layout of an icon file,
 * where the hot spot is the colour planes and bits a pixel); of the images
 * it offers, the deepest of the size asked for, else the first. A .ani file
 * is a RIFF list of frames, each of them a .cur file: the first frame stands
 * for it, the page showing no animation. Null for a file that is neither or
 * whose image this cannot read.
 *
 * @param {Uint8Array} bytes @param {number} size  The cursor size the system asks for.
 * @returns {CursorPicture | null}
 */
export function cursorFilePicture(bytes, size){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (/** @type {number} */ at)=>String.fromCharCode(...bytes.subarray(at, at + 4));
    if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'ACON')
    {
        const frame = firstFrame(bytes, 12, bytes.length, tag, view);
        return frame ? cursorFilePicture(frame, size) : null;
    }
    const ENTRY = 16;
    if (bytes.length < GROUP_HEADER_SIZE || view.getUint16(0, true) !== 0
        || view.getUint16(2, true) !== 2)
    {
        return null;
    }
    const count = Math.min(view.getUint16(4, true),
        Math.floor((bytes.length - GROUP_HEADER_SIZE) / ENTRY));
    let chosen = -1;
    let chosenDepth = -1;
    for (let index = 0; index < count; index++)
    {
        const at = GROUP_HEADER_SIZE + index * ENTRY;
        const width = bytes[at] || MAX_SIDE;
        const depth = view.getUint16(at + 6, true);
        if (chosen < 0)
        {
            chosen = at;
        }
        if (width === size && depth > chosenDepth)
        {
            chosen = at;
            chosenDepth = depth;
        }
    }
    if (chosen < 0)
    {
        return null;
    }
    const length = view.getUint32(chosen + 8, true);
    const offset = view.getUint32(chosen + 12, true);
    if (offset > bytes.length || length > bytes.length - offset)
    {
        return null;
    }
    const picture = dibToBgra(bytes.subarray(offset, offset + length));
    return picture
        ? { ...picture, hotSpot: { x: view.getUint16(chosen + 4, true),
            y: view.getUint16(chosen + 6, true) } }
        : null;
}

/**
 * The first 'icon' chunk of a RIFF animated cursor, looked for inside the
 * LIST chunks too.
 *
 * @param {Uint8Array} bytes @param {number} from @param {number} to
 * @param {(at: number) => string} tag @param {DataView} view
 * @returns {Uint8Array | null}
 */
function firstFrame(bytes, from, to, tag, view){
    for (let at = from; at + 8 <= to;)
    {
        const length = view.getUint32(at + 4, true);
        const end = Math.min(at + 8 + length, to);
        if (tag(at) === 'icon')
        {
            return bytes.subarray(at + 8, end);
        }
        if (tag(at) === 'LIST')
        {
            const inner = firstFrame(bytes, at + 12, end, tag, view);
            if (inner)
            {
                return inner;
            }
        }
        at = end + (length & 1);
    }
    return null;
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

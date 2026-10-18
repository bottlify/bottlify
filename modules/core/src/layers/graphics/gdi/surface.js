/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pixels a device context draws onto.
 *
 * A device context on its own has no pixels: the bookkeeping half tracks which
 * bitmap is selected and how wide it is, and stops there. This is the other
 * end -- an addressable rectangle of memory, with the two rules that decide
 * whether a byte offset lands on the pixel it was meant to.
 */

import { channelsOf, packPixel, unpackPixel } from './channels.js';

/**
 * The depth a surface has unless told otherwise, and the one every raster
 * operation is written for. A surface of any other depth converts at `read`
 * and `write`, so the operations still see this depth.
 */
export const SURFACE_BIT_COUNT = 32;

/** The two ways sixteen bits split into channels. */
export const RGB_565 = '565';
export const RGB_555 = '555';

/**
 * Widens a five- or six-bit channel by repeating its top bits into the low
 * ones, so full scale stays full scale: a shift alone leaves white at 0xf8.
 *
 * @param {number} value
 * @param {number} bits  5 or 6
 * @returns {number}
 */
function widen(value, bits){
    return ((value << (8 - bits)) | (value >>> (bits - (8 - bits)))) & 0xff;
}

/**
 * A sixteen-bit pixel as a 32-bit one. `RGB_555` is what a BI_RGB DIB means
 * by sixteen bits; `RGB_565` is what a DirectDraw display mode means.
 *
 * @param {number} value
 * @param {string} format  RGB_555 or RGB_565
 * @returns {number}
 */
export function expand16(value, format){
    if (format === RGB_565)
    {
        return ((widen(value >>> 11, 5) << 16)
            | (widen((value >>> 5) & 0x3f, 6) << 8)
            | widen(value & 0x1f, 5)) >>> 0;
    }
    return ((widen((value >>> 10) & 0x1f, 5) << 16)
        | (widen((value >>> 5) & 0x1f, 5) << 8)
        | widen(value & 0x1f, 5)) >>> 0;
}

/**
 * @param {number} pixel
 * @param {string} format
 * @returns {number} the sixteen-bit value, top bits of each channel kept
 */
export function narrow16(pixel, format){
    const red = (pixel >>> 16) & 0xff;
    const green = (pixel >>> 8) & 0xff;
    const blue = pixel & 0xff;
    if (format === RGB_565)
    {
        return ((red >>> 3) << 11) | ((green >>> 2) << 5) | (blue >>> 3);
    }
    return ((red >>> 3) << 10) | ((green >>> 3) << 5) | (blue >>> 3);
}

/** biCompression for a DIB whose channels are named by three masks. */
export const BI_BITFIELDS = 3;

/**
 * Which sixteen-bit layout a bitmap's pixels are in: the one it was given,
 * else 5-6-5 when its BI_BITFIELDS masks name that, else 5-5-5, which is what
 * a BI_RGB DIB means by sixteen bits. Masks that are neither are `masksOf`'s.
 *
 * @param {{ bitCount: number, format?: string, compression?: number,
 *           bitfields?: number[] }} attributes
 * @returns {string}
 */
export function formatOf(attributes){
    if (attributes.format)
    {
        return attributes.format;
    }
    const [red, green, blue] = (attributes.bitfields ?? []).map(mask=>mask >>> 0);
    return attributes.bitCount === 16 && attributes.compression === BI_BITFIELDS
        && red === 0xf800 && green === 0x07e0 && blue === 0x001f
        ? RGB_565
        : RGB_555;
}

/**
 * The masks a BI_BITFIELDS bitmap's pixels are drawn and read by, or null
 * when they are the layout its depth has natively -- 8-8-8 at thirty-two
 * bits, `formatOf`'s at sixteen -- or it has none.
 *
 * @param {{ bitCount: number, format?: string, compression?: number,
 *           bitfields?: number[] }} attributes
 * @returns {number[] | null}
 */
export function masksOf(attributes){
    const depth = attributes.bitCount;
    if (attributes.format || attributes.compression !== BI_BITFIELDS
        || (depth !== 16 && depth !== 32))
    {
        return null;
    }
    const masks = [0, 1, 2].map(index=>(attributes.bitfields?.[index] ?? 0) >>> 0);
    const native = depth === 32 ? [0xff0000, 0x00ff00, 0x0000ff]
        : formatOf(attributes) === RGB_565 ? [0xf800, 0x07e0, 0x001f]
            : [0x7c00, 0x03e0, 0x001f];
    return masks.every((mask, index)=>mask === native[index]) ? null : masks;
}

/**
 * Bytes per row for a DIB: each row starts on a four-byte boundary. A loop that
 * multiplies width by bytes-per-pixel instead is right at every width divisible
 * by four and shears the image by a pixel per row at the rest.
 *
 * @param {number} width
 * @param {number} bitCount
 * @returns {number}
 */
export function dibPitch(width, bitCount){
    return ((((width * bitCount) + 31) >>> 5) * 4) | 0;
}

/**
 * Bytes per row for a device-dependent bitmap, which pads to a *word*, not a
 * DWORD. The two rules agree at 32 bits per pixel and disagree at every depth
 * where the padding does anything, so a surface has to be told which one it
 * was built under rather than guessing from its dimensions.
 *
 * @param {number} width
 * @param {number} bitCount
 * @returns {number}
 */
export function ddbPitch(width, bitCount){
    return ((((width * bitCount) + 15) >>> 4) * 2) | 0;
}

/**
 * A COLORREF is 0x00bbggrr and a 32bpp pixel is 0x00rrggbb: the conversion is a
 * red/blue swap, not a copy, and getting it wrong is a bug whose only symptom
 * is that everything is the wrong colour in a plausible way.
 *
 * @param {number} color
 * @returns {number}
 */
export function colorToPixel(color){
    const value = color >>> 0;
    return (((value & 0xff) << 16) | (value & 0xff00) | ((value >>> 16) & 0xff)) >>> 0;
}

/**
 * The swap is its own inverse, so this is `colorToPixel` under the name that
 * says which direction the caller meant.
 *
 * @param {number} pixel
 * @returns {number} the COLORREF a program gets back from GetPixel
 */
export function pixelToColor(pixel){
    return colorToPixel(pixel);
}

/**
 * @typedef {Object} SurfaceOptions
 * @property {number} width
 * @property {number} height
 * @property {boolean} [topDown]   Default true: drawing coordinates are top-left based.
 * @property {number} [pitch]      Overrides the DIB rule for a surface someone else strided.
 * @property {Uint8Array} [bytes]  Existing memory to draw into, rather than fresh memory.
 * @property {number} [offset]     Where row zero starts inside `bytes`.
 * @property {number} [bitCount]   1, 4, 8, 16, 24 or 32; the operations still see 32.
 * @property {number[]} [palette]  What an index means, up to 8 bits: 32-bit pixels.
 * @property {string} [format]     RGB_555 (default) or RGB_565, for 16 bits.
 * @property {number[]} [masks]    Red, green and blue masks, for 16 or 32 bits,
 *                                 in place of the depth's own layout.
 * @property {boolean} [mono]      A monochrome device bitmap, not a DIB: see the contract.
 */

/** What a monochrome bitmap's two bit values mean: black, and white. */
export const MONOCHROME = Object.freeze([0x00000000, 0x00ffffff]);

/** The depths a surface can have. */
const DEPTHS = new Set([1, 4, 8, 16, 24, 32]);

/**
 * The entry of a colour table nearest a pixel, by squared distance in RGB:
 * the first that matches it exactly, else the closest.
 *
 * @param {number[]} entries  32-bit pixels, at most 256 of them consulted.
 * @param {number} pixel
 * @returns {{ index: number, exact: boolean }}
 */
export function nearestEntry(entries, pixel){
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < entries.length && index < 256; index++)
    {
        const entry = entries[index] >>> 0;
        if ((entry & 0xffffff) === (pixel & 0xffffff))
        {
            return { index, exact: true };
        }
        const dr = ((entry >>> 16) & 0xff) - ((pixel >>> 16) & 0xff);
        const dg = ((entry >>> 8) & 0xff) - ((pixel >>> 8) & 0xff);
        const db = (entry & 0xff) - (pixel & 0xff);
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance)
        {
            bestDistance = distance;
            best = index;
        }
    }
    return { index: best, exact: false };
}

/**
 * A surface that also says how deep it is. The operations need only the
 * contract's half; the depth is for whoever presents or re-reads the bytes.
 *
 * @typedef {import("./contract.js").Surface & {
 *     bitCount: number, palette: number[] | null, format: string, mono: boolean,
 *     nearest: (pixel: number) => number }} DepthSurface
 */

/**
 * @param {SurfaceOptions} options
 * @returns {DepthSurface}
 */
export function createSurface(options){
    const width = options.width | 0;
    const height = options.height | 0;
    if (width <= 0 || height <= 0)
    {
        throw new RangeError('A surface needs a positive width and height');
    }
    const bitCount = options.bitCount ?? SURFACE_BIT_COUNT;
    if (!DEPTHS.has(bitCount))
    {
        throw new RangeError(`A surface cannot be ${bitCount} bits deep`);
    }
    const palette = options.palette ?? null;
    if (bitCount <= 8 && !palette)
    {
        throw new RangeError('An indexed surface needs a palette');
    }
    const format = options.format ?? RGB_555;
    const channels = options.masks && (bitCount === 16 || bitCount === 32)
        ? channelsOf(options.masks)
        : null;
    const pitch = options.pitch ?? dibPitch(width, bitCount);
    const offset = options.offset ?? 0;
    const bytes = options.bytes ?? new Uint8Array(pitch * height);
    if (bytes.length < offset + (pitch * height))
    {
        throw new RangeError('A surface needs enough memory for every one of its rows');
    }
    // A 32-bit view is what makes a raster operation one instruction per pixel
    // rather than four, and it is only legal when both the pitch and the start
    // are DWORD-aligned -- which the DIB rule guarantees and an imported stride
    // does not.
    const aligned = bitCount === 32 && (pitch % 4) === 0
        && ((bytes.byteOffset + offset) % 4) === 0;
    const words = aligned
        ? new Uint32Array(bytes.buffer, bytes.byteOffset + offset, (pitch * height) / 4)
        : null;
    const topDown = options.topDown ?? true;

    /** @param {number} y @returns {number} byte offset of the row's first pixel */
    const rowOffset = y=>offset + ((topDown ? y : height - 1 - y) * pitch);

    /**
     * The palette entry nearest a pixel, by squared distance in RGB. A fill
     * asks the same question thousands of times, so the answer is remembered
     * per pixel value -- but only when it was an exact match, which is the
     * one answer that stays checkable: the palette is live, and a table held
     * by a palette-relative bitmap is refreshed *in place*, so an entry can
     * change value without this array changing identity or length. A
     * remembered index is therefore trusted only while its entry still holds
     * the asked-for colour, and a nearest-but-not-exact answer is recomputed
     * every time rather than cached against a table that may move under it.
     *
     * @type {Map<number, number>}
     */
    const nearest = new Map();
    /** @param {number} pixel @returns {number} */
    const indexOf = pixel=>{
        const entries = /** @type {number[]} */ (palette);
        const remembered = nearest.get(pixel);
        if (remembered !== undefined && (entries[remembered] >>> 0) === (pixel >>> 0))
        {
            return remembered;
        }
        const found = nearestEntry(entries, pixel);
        if (nearest.size >= 4096)
        {
            nearest.clear();
        }
        if (found.exact)
        {
            nearest.set(pixel, found.index);
        }
        else
        {
            nearest.delete(pixel);
        }
        return found.index;
    };

    return {
        width,
        height,
        pitch,
        topDown,
        bytes,
        offset,
        bitCount,
        palette,
        format,
        mono: options.mono === true,
        // Its pixels as words, a row `pitch / 4` apart from the first stored
        // one, where each word is the pixel itself: 32 bits deep, aligned and
        // with no channel masks to pack. Null otherwise. What lets a plain copy
        // between two such surfaces move rows instead of pixels.
        words: words && !channels ? words : null,

        /** @param {number} x @param {number} y */
        read(x, y){
            if (bitCount === 1)
            {
                // The leftmost pixel is the byte's top bit.
                const bit = (bytes[rowOffset(y) + (x >>> 3)] >>> (7 - (x & 7))) & 1;
                return (/** @type {number[]} */ (palette)[bit] ?? 0) >>> 0;
            }
            if (bitCount === 4)
            {
                // And of two pixels in a byte, the high nibble.
                const pair = bytes[rowOffset(y) + (x >>> 1)];
                const index = (x & 1) === 0 ? pair >>> 4 : pair & 0x0f;
                return (/** @type {number[]} */ (palette)[index] ?? 0) >>> 0;
            }
            if (bitCount === 8)
            {
                return (/** @type {number[]} */ (palette)[bytes[rowOffset(y) + x]] ?? 0) >>> 0;
            }
            if (bitCount === 16)
            {
                const at = rowOffset(y) + (x * 2);
                const value = bytes[at] | (bytes[at + 1] << 8);
                return channels ? unpackPixel(value, channels) : expand16(value, format);
            }
            if (bitCount === 24)
            {
                const at = rowOffset(y) + (x * 3);
                return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) >>> 0;
            }
            const at = rowOffset(y) + (x * 4);
            const value = words ? words[(at - offset) >>> 2]
                : bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
            return channels ? unpackPixel(value, channels) : value >>> 0;
        },

        /**
         * A run of a row's pixels, each as `read` answers it, into `into` from
         * `at`: what a blit from a source of any depth reads a row by, one loop
         * where `read` was a call a pixel -- a menu's eight-bit pictures copied
         * a pixel at a time took a millisecond a blit.
         *
         * @param {number} y @param {number} x @param {number} count
         * @param {Uint32Array} into @param {number} at
         */
        readRow(y, x, count, into, at){
            const row = rowOffset(y);
            if (bitCount === 8)
            {
                const entries = /** @type {number[]} */ (palette);
                for (let i = 0; i < count; i++)
                {
                    into[at + i] = (entries[bytes[row + x + i]] ?? 0) >>> 0;
                }
                return;
            }
            if (bitCount === 24)
            {
                for (let i = 0, p = row + x * 3; i < count; i++, p += 3)
                {
                    into[at + i] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) >>> 0;
                }
                return;
            }
            if (words && !channels)
            {
                const from = ((row - offset) >>> 2) + x;
                into.set(words.subarray(from, from + count), at);
                return;
            }
            for (let i = 0; i < count; i++)
            {
                into[at + i] = this.read(x + i, y);
            }
        },

        /** @param {number} x @param {number} y @param {number} pixel */
        write(x, y, pixel){
            if (bitCount === 1)
            {
                const at = rowOffset(y) + (x >>> 3);
                const mask = 0x80 >>> (x & 7);
                bytes[at] = (indexOf(pixel >>> 0) & 1) !== 0 ? bytes[at] | mask : bytes[at] & ~mask;
                return;
            }
            if (bitCount === 4)
            {
                const at = rowOffset(y) + (x >>> 1);
                const index = indexOf(pixel >>> 0) & 0x0f;
                bytes[at] = (x & 1) === 0
                    ? (bytes[at] & 0x0f) | (index << 4)
                    : (bytes[at] & 0xf0) | index;
                return;
            }
            if (bitCount === 8)
            {
                bytes[rowOffset(y) + x] = indexOf(pixel >>> 0);
                return;
            }
            if (bitCount === 16)
            {
                const at = rowOffset(y) + (x * 2);
                const value = channels
                    ? packPixel(pixel >>> 0, channels)
                    : narrow16(pixel >>> 0, format);
                bytes[at] = value & 0xff;
                bytes[at + 1] = (value >>> 8) & 0xff;
                return;
            }
            if (bitCount === 24)
            {
                const at = rowOffset(y) + (x * 3);
                bytes[at] = pixel & 0xff;
                bytes[at + 1] = (pixel >>> 8) & 0xff;
                bytes[at + 2] = (pixel >>> 16) & 0xff;
                return;
            }
            const at = rowOffset(y) + (x * 4);
            const value = channels ? packPixel(pixel >>> 0, channels) : pixel >>> 0;
            if (words)
            {
                words[(at - offset) >>> 2] = value;
                return;
            }
            bytes[at] = value & 0xff;
            bytes[at + 1] = (value >>> 8) & 0xff;
            bytes[at + 2] = (value >>> 16) & 0xff;
            bytes[at + 3] = (value >>> 24) & 0xff;
        },

        /**
         * The first pixel of a row is written as any is, and the rest of the
         * row are copies of its bytes; below a byte, where pixels share one,
         * each is written in turn.
         *
         * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
         * @param {number} pixel
         */
        fill(x0, y0, x1, y1, pixel){
            const fromX = Math.max(0, x0);
            const toX = Math.min(width, x1);
            const size = bitCount >>> 3;
            const toY = fromX < toX ? Math.min(height, y1) : 0;
            for (let y = Math.max(0, y0); y < toY; y++)
            {
                if (size === 0)
                {
                    for (let x = fromX; x < toX; x++)
                    {
                        this.write(x, y, pixel);
                    }
                    continue;
                }
                this.write(fromX, y, pixel);
                const start = rowOffset(y) + fromX * size;
                const end = rowOffset(y) + toX * size;
                for (let filled = size; start + filled < end; filled *= 2)
                {
                    bytes.copyWithin(start + filled, start,
                        start + Math.min(filled, end - start - filled));
                }
            }
        },

        /** @param {number} pixel @returns {number} what a write of it reads back as */
        nearest(pixel){
            if (bitCount <= 8)
            {
                return (/** @type {number[]} */ (palette)[indexOf(pixel >>> 0)] ?? 0) >>> 0;
            }
            if (channels)
            {
                return unpackPixel(packPixel(pixel >>> 0, channels), channels);
            }
            if (bitCount === 16)
            {
                return expand16(narrow16(pixel >>> 0, format), format);
            }
            return bitCount === 24 ? (pixel & 0xffffff) >>> 0 : pixel >>> 0;
        },
    };
}

/**
 * The pixels of a DIB section, as a surface.
 *
 * `CreateDIBSection` allocates the bits and records their shape on the bitmap
 * object; this is the other end of that -- the same memory, addressable. The
 * `topDown` flag is the one thing that cannot be recovered from the numbers,
 * which is why the bookkeeping half stores it rather than the signed height.
 *
 * One, four and eight bits need the colour table the indices mean -- a
 * one-bit section is two colours of its own, not a monochrome bitmap --
 * and sixteen and thirty-two bits are laid out as `formatOf` and `masksOf`
 * say.
 *
 * @param {{ width: number, height: number, bitCount: number, bits: number,
 *           topDown?: boolean, palette?: number[], format?: string,
 *           compression?: number, bitfields?: number[], pitch?: number }} attributes
 *        A bitmap object's own attributes; `pitch` when the rows are laid out
 *        at a stride of the program's choosing rather than a DIB's.
 * @param {Uint8Array} memory   Guest memory, or the window of it holding the bits.
 * @param {number} [base]       The guest address `memory` starts at.
 * @returns {import("./contract.js").Surface | null}
 */
export function surfaceForDibSection(attributes, memory, base = 0){
    const depth = attributes.bitCount;
    if (!DEPTHS.has(depth) || (attributes.bits >>> 0) === 0
        || (depth <= 8 && !attributes.palette))
    {
        return null;
    }
    return createSurface({
        width: attributes.width,
        height: attributes.height,
        topDown: attributes.topDown === true,
        // A section over memory the program laid out itself says its stride.
        pitch: attributes.pitch ?? dibPitch(attributes.width, depth),
        bytes: memory,
        offset: (attributes.bits >>> 0) - base,
        bitCount: depth,
        palette: attributes.palette,
        format: formatOf(attributes),
        masks: masksOf(attributes) ?? undefined,
    });
}

/**
 * The pixels of a device-dependent bitmap, as a surface.
 *
 * Its bits are not in guest memory: Windows keeps them where the program
 * cannot address them, and the bookkeeping half hands them over as bytes of
 * their own, in the layout GetBitmapBits exchanges -- rows top-down, each
 * padded to a WORD. One bit is monochrome, black and white, and blits to and
 * from other depths by the monochrome rules; sixteen is the 5-6-5 a display
 * mode of that depth has. A depth that needs a palette the bitmap does not
 * carry has no surface.
 *
 * @param {{ width: number, height: number, bitCount: number, pixels?: Uint8Array }} attributes
 * @returns {DepthSurface | null}
 */
export function surfaceForDdb(attributes){
    const depth = attributes.bitCount;
    if (!attributes.pixels || (depth !== 1 && depth !== 16 && depth !== 24 && depth !== 32))
    {
        return null;
    }
    return createSurface({
        width: attributes.width,
        height: attributes.height,
        topDown: true,
        pitch: ddbPitch(attributes.width, depth),
        bytes: attributes.pixels,
        bitCount: depth,
        palette: depth === 1 ? [...MONOCHROME] : undefined,
        format: RGB_565,
        mono: depth === 1,
    });
}

/**
 * The picture a pattern brush repeats, as a surface: the copy of its bitmap
 * the brush was made with, in the layout GetBitmapBits hands out -- rows
 * top-down, each padded to a WORD -- whichever kind of bitmap it came from.
 * A copy of a device-dependent bitmap reads as that bitmap does, a single bit
 * being monochrome; a copy of a DIB keeps the DIB's colours, or, where the
 * DIB's table was palette indices, takes them from `colors` -- the palette
 * of the DC being painted, an index past its end wrapping to its start.
 *
 * @param {{ width: number, height: number, bitCount: number, pixels: Uint8Array,
 *           dib?: boolean, palette?: number[], indices?: number[], format?: string,
 *           compression?: number, bitfields?: number[] }} pattern
 * @param {number[]} [colors]
 * @returns {DepthSurface | null}
 */
export function surfaceForPattern(pattern, colors = []){
    const depth = pattern.bitCount;
    if (!pattern.dib)
    {
        return surfaceForDdb(pattern);
    }
    const palette = pattern.indices
        ? Array.from({ length: 1 << depth }, (_, index)=>colors.length
            && index < /** @type {number[]} */ (pattern.indices).length
            ? colors[/** @type {number[]} */ (pattern.indices)[index] % colors.length]
            : 0)
        : pattern.palette;
    if (!DEPTHS.has(depth) || (depth <= 8 && !palette))
    {
        return null;
    }
    return createSurface({
        width: pattern.width,
        height: pattern.height,
        topDown: true,
        pitch: ddbPitch(pattern.width, depth),
        bytes: pattern.pixels,
        bitCount: depth,
        palette,
        format: formatOf(pattern),
        masks: masksOf(pattern) ?? undefined,
    });
}

/**
 * The whole surface as a rectangle, which is what a clip region defaults to.
 *
 * @param {import("./contract.js").Surface} surface
 * @returns {import("./contract.js").Rect}
 */
export function surfaceBounds(surface){
    return { left: 0, top: 0, right: surface.width, bottom: surface.height };
}

/**
 * @param {import("./contract.js").Rect} a
 * @param {import("./contract.js").Rect} b
 * @returns {import("./contract.js").Rect} the overlap, possibly empty
 */
export function intersectRect(a, b){
    return {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };
}

/**
 * @param {import("./contract.js").Rect} rect
 * @returns {boolean}
 */
export function isEmptyRect(rect){
    return rect.right <= rect.left || rect.bottom <= rect.top;
}

/**
 * Fills a whole surface with one pixel value, which is the only way a test can
 * tell "nothing was drawn here" from "zero was drawn here".
 *
 * @param {import("./contract.js").Surface} surface
 * @param {number} pixel
 */
export function clearSurface(surface, pixel){
    for (let y = 0; y < surface.height; y++)
    {
        for (let x = 0; x < surface.width; x++)
        {
            surface.write(x, y, pixel);
        }
    }
}

/**
 * A rectangle of another surface, as a surface of its own.
 *
 * A window's device context draws in the window's client coordinates and
 * lands on the display, so a view is what it is bound to: its origin is the
 * client's origin on the parent surface, and a pixel outside the parent -- a
 * window hanging off the edge of the screen -- reads as black and is not
 * written. The bytes are the parent's own, so a blit between a view and its
 * parent is recognised as the overlapping copy it is.
 *
 * @param {import("./contract.js").Surface} parent
 * @param {import("./contract.js").Rect} rect  Where the view lies on the parent.
 * @returns {import("./contract.js").Surface}
 */
export function viewOf(parent, rect){
    const left = rect.left | 0;
    const top = rect.top | 0;
    const width = Math.max(0, (rect.right | 0) - left);
    const height = Math.max(0, (rect.bottom | 0) - top);
    /** @param {number} x @param {number} y */
    const inside = (x, y)=>{
        const px = x + left;
        const py = y + top;
        return px >= 0 && py >= 0 && px < parent.width && py < parent.height;
    };
    // Wholly inside a top-down parent whose words are its pixels, the view's
    // rows are the parent's from its corner on, `pitch` apart as the parent's
    // are: the row paths of a blit take it as they take the parent -- a child
    // window's every blit went a pixel at a time, a menu's background a
    // millisecond each. A view past the parent's edge keeps the pixel path,
    // whose reads and writes stop at it.
    const within = left >= 0 && top >= 0 && left + width <= parent.width
        && top + height <= parent.height;
    const parentWords = within && parent.topDown ? parent.words ?? null : null;
    const words = parentWords ? parentWords.subarray(top * (parent.pitch >>> 2) + left) : null;
    const parentRow = within ? parent.readRow : undefined;
    return {
        width,
        height,
        pitch: parent.pitch,
        topDown: parent.topDown,
        bytes: parent.bytes,
        offset: parent.offset + (top * parent.pitch) + (left * 4),
        words,
        readRow: parentRow
            ? (/** @type {number} */ y, /** @type {number} */ x, /** @type {number} */ count,
                /** @type {Uint32Array} */ into, /** @type {number} */ at)=>
                parentRow.call(parent, y + top, x + left, count, into, at)
            : undefined,
        /** @param {number} x @param {number} y */
        read: (x, y)=>(inside(x, y) ? parent.read(x + left, y + top) : 0),
        /** @param {number} x @param {number} y @param {number} pixel */
        write(x, y, pixel){
            if (inside(x, y))
            {
                parent.write(x + left, y + top, pixel);
            }
        },
        /**
         * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
         * @param {number} pixel
         */
        fill(x0, y0, x1, y1, pixel){
            const fromX = Math.max(x0 + left, 0);
            const fromY = Math.max(y0 + top, 0);
            const toX = Math.min(x1 + left, parent.width);
            const toY = Math.min(y1 + top, parent.height);
            if (fromX >= toX || fromY >= toY)
            {
                return;
            }
            if (parent.fill)
            {
                parent.fill(fromX, fromY, toX, toY, pixel);
                return;
            }
            for (let y = fromY; y < toY; y++)
            {
                for (let x = fromX; x < toX; x++)
                {
                    parent.write(x, y, pixel);
                }
            }
        },
    };
}

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
 * else the one its BI_BITFIELDS masks name, else 5-5-5, which is what a
 * BI_RGB DIB means by sixteen bits. Null for masks that are neither of the
 * two, which no surface here draws by.
 *
 * @param {{ bitCount: number, format?: string, compression?: number,
 *           bitfields?: number[] }} attributes
 * @returns {string | null}
 */
export function formatOf(attributes){
    if (attributes.format)
    {
        return attributes.format;
    }
    if (attributes.bitCount !== 16 || attributes.compression !== BI_BITFIELDS)
    {
        return RGB_555;
    }
    const [red, green, blue] = (attributes.bitfields ?? []).map(mask=>mask >>> 0);
    if (red === 0xf800 && green === 0x07e0 && blue === 0x001f)
    {
        return RGB_565;
    }
    return red === 0x7c00 && green === 0x03e0 && blue === 0x001f ? RGB_555 : null;
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
 * @property {boolean} [mono]      A monochrome device bitmap, not a DIB: see the contract.
 */

/** What a monochrome bitmap's two bit values mean: black, and white. */
export const MONOCHROME = Object.freeze([0x00000000, 0x00ffffff]);

/** The depths a surface can have. */
const DEPTHS = new Set([1, 4, 8, 16, 24, 32]);

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
        let best = 0;
        let bestDistance = Infinity;
        let exact = false;
        for (let index = 0; index < entries.length && index < 256; index++)
        {
            const entry = entries[index] >>> 0;
            if ((entry & 0xffffff) === (pixel & 0xffffff))
            {
                best = index;
                exact = true;
                break;
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
        if (nearest.size >= 4096)
        {
            nearest.clear();
        }
        if (exact)
        {
            nearest.set(pixel, best);
        }
        else
        {
            nearest.delete(pixel);
        }
        return best;
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
                return expand16(bytes[at] | (bytes[at + 1] << 8), format);
            }
            if (bitCount === 24)
            {
                const at = rowOffset(y) + (x * 3);
                return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) >>> 0;
            }
            const at = rowOffset(y) + (x * 4);
            if (words)
            {
                return words[(at - offset) >>> 2] >>> 0;
            }
            return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
                | (bytes[at + 3] << 24)) >>> 0;
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
                const value = narrow16(pixel >>> 0, format);
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
            if (words)
            {
                words[(at - offset) >>> 2] = pixel >>> 0;
                return;
            }
            bytes[at] = pixel & 0xff;
            bytes[at + 1] = (pixel >>> 8) & 0xff;
            bytes[at + 2] = (pixel >>> 16) & 0xff;
            bytes[at + 3] = (pixel >>> 24) & 0xff;
        },

        /** @param {number} pixel @returns {number} what a write of it reads back as */
        nearest(pixel){
            if (bitCount <= 8)
            {
                return (/** @type {number[]} */ (palette)[indexOf(pixel >>> 0)] ?? 0) >>> 0;
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
 * and sixteen bits is laid out as `formatOf` says.
 *
 * @param {{ width: number, height: number, bitCount: number, bits: number,
 *           topDown?: boolean, palette?: number[], format?: string,
 *           compression?: number, bitfields?: number[] }} attributes
 *        A bitmap object's own attributes.
 * @param {Uint8Array} memory   Guest memory, or the window of it holding the bits.
 * @param {number} [base]       The guest address `memory` starts at.
 * @returns {import("./contract.js").Surface | null}
 */
export function surfaceForDibSection(attributes, memory, base = 0){
    const depth = attributes.bitCount;
    const format = formatOf(attributes);
    if (!DEPTHS.has(depth) || (attributes.bits >>> 0) === 0
        || (depth <= 8 && !attributes.palette) || format === null)
    {
        return null;
    }
    return createSurface({
        width: attributes.width,
        height: attributes.height,
        topDown: attributes.topDown === true,
        pitch: dibPitch(attributes.width, depth),
        bytes: memory,
        offset: (attributes.bits >>> 0) - base,
        bitCount: depth,
        palette: attributes.palette,
        format,
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
 * being monochrome; a copy of a DIB section keeps the section's colours.
 *
 * @param {{ width: number, height: number, bitCount: number, pixels: Uint8Array,
 *           dib?: boolean, palette?: number[], format?: string,
 *           compression?: number, bitfields?: number[] }} pattern
 * @returns {DepthSurface | null}
 */
export function surfaceForPattern(pattern){
    const depth = pattern.bitCount;
    if (!pattern.dib)
    {
        return surfaceForDdb(pattern);
    }
    const format = formatOf(pattern);
    if (!DEPTHS.has(depth) || (depth <= 8 && !pattern.palette) || format === null)
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
        palette: pattern.palette,
        format,
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
    return {
        width,
        height,
        pitch: parent.pitch,
        topDown: parent.topDown,
        bytes: parent.bytes,
        offset: parent.offset + (top * parent.pitch) + (left * 4),
        /** @param {number} x @param {number} y */
        read: (x, y)=>(inside(x, y) ? parent.read(x + left, y + top) : 0),
        /** @param {number} x @param {number} y @param {number} pixel */
        write(x, y, pixel){
            if (inside(x, y))
            {
                parent.write(x + left, y + top, pixel);
            }
        },
    };
}

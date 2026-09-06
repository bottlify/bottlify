/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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

/** Bit depth every surface has. See `contract.js` for why there is only one. */
export const SURFACE_BIT_COUNT = 32;

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
 */

/**
 * @param {SurfaceOptions} options
 * @returns {import("./contract.js").Surface}
 */
export function createSurface(options){
    const width = options.width | 0;
    const height = options.height | 0;
    if (width <= 0 || height <= 0)
    {
        throw new RangeError('A surface needs a positive width and height');
    }
    const pitch = options.pitch ?? dibPitch(width, SURFACE_BIT_COUNT);
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
    const aligned = (pitch % 4) === 0 && ((bytes.byteOffset + offset) % 4) === 0;
    const words = aligned
        ? new Uint32Array(bytes.buffer, bytes.byteOffset + offset, (pitch * height) / 4)
        : null;
    const topDown = options.topDown ?? true;

    /** @param {number} y @returns {number} byte offset of the row's first pixel */
    const rowOffset = y=>offset + ((topDown ? y : height - 1 - y) * pitch);

    return {
        width,
        height,
        pitch,
        topDown,
        bytes,
        offset,

        /** @param {number} x @param {number} y */
        read(x, y){
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
 * @param {{ width: number, height: number, bitCount: number, bits: number,
 *           topDown?: boolean }} attributes  A bitmap object's own attributes.
 * @param {Uint8Array} memory   Guest memory, or the window of it holding the bits.
 * @param {number} [base]       The guest address `memory` starts at.
 * @returns {import("./contract.js").Surface | null}
 */
export function surfaceForDibSection(attributes, memory, base = 0){
    if (attributes.bitCount !== SURFACE_BIT_COUNT || (attributes.bits >>> 0) === 0)
    {
        return null;
    }
    return createSurface({
        width: attributes.width,
        height: attributes.height,
        topDown: attributes.topDown === true,
        pitch: dibPitch(attributes.width, attributes.bitCount),
        bytes: memory,
        offset: (attributes.bits >>> 0) - base,
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

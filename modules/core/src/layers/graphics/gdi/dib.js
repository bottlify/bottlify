/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Device-independent bitmaps: the boundary where a program's own pixel format
 * becomes ours.
 *
 * Two facts about a DIB decide everything here, and both are sign errors
 * waiting to happen:
 *
 * - **A positive `biHeight` means bottom-up.** Row zero of the bits is the
 *   *last* row of the picture. A negative height means top-down and the rows
 *   are in the order they are drawn. Reading one as the other flips the image,
 *   which is obvious in a photograph and invisible in a symmetric icon until
 *   something depends on it.
 * - **Rows are padded to four bytes.** Not to the pixel size -- to four bytes,
 *   at every depth. See `dibPitch`.
 *
 * A colour table entry is an RGBQUAD, stored blue-green-red-reserved, so a
 * little-endian DWORD read of one is already the 32-bit pixel this layer uses.
 * Callers hand the table in as that array of pixels rather than as bytes.
 *
 * Every uncompressed depth is handled: 32, 24 and 16 bits by channel, and 8,
 * 4 and 1 by index into the colour table. Writing an indexed DIB needs a
 * table to index, and the caller chooses it; this layer never invents one.
 */

import { bitBlt, stretchBlt } from './blit.js';
import { channelsOf, packPixel, unpackPixel } from './channels.js';
import { SRCCOPY } from './rop.js';
import { BI_BITFIELDS, createSurface, dibPitch, nearestEntry } from './surface.js';

/** BI_RGB: uncompressed, with the channel layout the bit count implies. */
export const BI_RGB = 0;
export { BI_BITFIELDS };

/** The depths this layer converts. */
const SUPPORTED_DEPTHS = new Set([1, 4, 8, 16, 24, 32]);

/**
 * The masks a BI_RGB DIB's depth implies: X1R5G5B5 at sixteen bits and
 * X8R8G8B8 at thirty-two. A BI_BITFIELDS DIB names its own.
 *
 * @type {Record<number, number[]>}
 */
const RGB_MASKS = { 16: [0x7c00, 0x03e0, 0x001f], 32: [0x00ff0000, 0x0000ff00, 0x000000ff] };

/**
 * @typedef {Object} DibImage
 * @property {import("../../win32/gdi32/structs.js").BitmapInfoHeaderFields} header
 * @property {Uint8Array} bits
 * @property {number} [offset]     Where the first supplied row starts inside `bits`.
 * @property {number[]} [colors]   The colour table, as 32-bit pixels.
 * @property {number[]} [masks]    A BI_BITFIELDS DIB's red, green and blue masks.
 * @property {number} [startScan]  Which DIB row the supplied rows begin at.
 * @property {number} [scanLines]  How many rows are supplied; the whole image by default.
 */

/**
 * @param {DibImage} image
 * @returns {boolean} whether this layer can convert the format at all
 */
export function isConvertibleDib(image){
    const header = image.header;
    const masked = header.bitCount === 16 || header.bitCount === 32;
    return SUPPORTED_DEPTHS.has(header.bitCount)
        && (header.compression === BI_RGB || (header.compression === BI_BITFIELDS && masked))
        && header.width > 0 && header.height !== 0;
}

/**
 * How a sixteen- or thirty-two-bit DIB's pixels split into channels: by the
 * masks a BI_BITFIELDS DIB names, else by those its depth implies.
 *
 * @param {DibImage} image
 */
function channelsFor(image){
    return channelsOf(image.header.compression === BI_BITFIELDS
        ? image.masks ?? [0, 0, 0]
        : RGB_MASKS[image.header.bitCount]);
}

/**
 * The colour-table index a pixel of an indexed row holds: a byte at eight
 * bits, and below that the leftmost pixel in the byte's top bits.
 *
 * @param {Uint8Array} bits @param {number} row @param {number} x @param {number} bitCount
 */
function indexAt(bits, row, x, bitCount){
    if (bitCount === 8)
    {
        return bits[row + x];
    }
    if (bitCount === 4)
    {
        return (bits[row + (x >>> 1)] >>> ((x & 1) === 0 ? 4 : 0)) & 0x0f;
    }
    return (bits[row + (x >>> 3)] >>> (7 - (x & 7))) & 1;
}

/**
 * Decodes a DIB into a top-down 32-bit surface, which is the only pixel format
 * anything downstream of here knows about.
 *
 * Rows the caller did not supply -- everything outside `startScan` and
 * `scanLines` -- are left at zero, so a partial `SetDIBitsToDevice` cannot pick
 * up whatever the rest of the DIB would have been.
 *
 * @param {DibImage} image
 * @returns {import("./contract.js").Surface | null}
 */
export function decodeDib(image){
    if (!isConvertibleDib(image))
    {
        return null;
    }
    const header = image.header;
    const width = header.width;
    const height = Math.abs(header.height);
    const topDown = header.height < 0;
    const pitch = dibPitch(width, header.bitCount);
    const bits = image.bits;
    const base = image.offset ?? 0;
    const colors = image.colors ?? [];
    const startScan = image.startScan ?? 0;
    const scanLines = Math.min(image.scanLines ?? height, height - startScan);
    const out = createSurface({ width, height });
    const channels = header.bitCount === 16 || header.bitCount === 32 ? channelsFor(image) : [];

    for (let index = 0; index < scanLines; index++)
    {
        const dibRow = startScan + index;
        if (dibRow < 0)
        {
            // Supplied rows can begin above a top-down picture's first.
            continue;
        }
        // The one place the sign of biHeight is consulted: a bottom-up DIB's
        // row zero is the picture's last row.
        const y = topDown ? dibRow : height - 1 - dibRow;
        const row = base + (index * pitch);
        for (let x = 0; x < width; x++)
        {
            let pixel;
            if (header.bitCount === 32)
            {
                const at = row + (x * 4);
                pixel = unpackPixel(bits[at] | (bits[at + 1] << 8) | (bits[at + 2] << 16)
                    | (bits[at + 3] << 24), channels);
            }
            else if (header.bitCount === 24)
            {
                const at = row + (x * 3);
                pixel = ((bits[at + 2] << 16) | (bits[at + 1] << 8) | bits[at]) >>> 0;
            }
            else if (header.bitCount === 16)
            {
                const at = row + (x * 2);
                pixel = unpackPixel(bits[at] | (bits[at + 1] << 8), channels);
            }
            else
            {
                pixel = colors[indexAt(bits, row, x, header.bitCount)] ?? 0;
            }
            out.write(x, y, pixel);
        }
    }
    return out;
}

/**
 * Encodes a surface back into DIB rows, which is what GetDIBits does.
 *
 * @param {import("./contract.js").Surface} surface
 * @param {DibImage} image
 * @returns {number} how many scan lines were written
 */
export function encodeDib(surface, image){
    const table = image.colors ?? [];
    if (!isConvertibleDib(image) || (image.header.bitCount <= 8 && table.length === 0))
    {
        return 0;
    }
    const header = image.header;
    const width = Math.min(header.width, surface.width);
    const height = Math.abs(header.height);
    const topDown = header.height < 0;
    const pitch = dibPitch(header.width, header.bitCount);
    const bits = image.bits;
    const base = image.offset ?? 0;
    const startScan = image.startScan ?? 0;
    const scanLines = Math.min(image.scanLines ?? height, height - startScan);
    const channels = header.bitCount === 16 || header.bitCount === 32 ? channelsFor(image) : [];
    // The table is fixed for the whole call, so every answer can be kept.
    /** @type {Map<number, number>} */
    const indices = new Map();
    /** @param {number} pixel */
    const indexOf = pixel=>{
        let found = indices.get(pixel);
        if (found === undefined)
        {
            found = nearestEntry(table, pixel).index;
            indices.set(pixel, found);
        }
        return found;
    };

    let written = 0;
    for (let index = 0; index < scanLines; index++)
    {
        const dibRow = startScan + index;
        const y = topDown ? dibRow : height - 1 - dibRow;
        if (y >= surface.height)
        {
            continue;
        }
        const row = base + (index * pitch);
        if (header.bitCount < 8)
        {
            // Several pixels share a byte, and each is ORed into it.
            bits.fill(0, row, row + pitch);
        }
        for (let x = 0; x < width; x++)
        {
            const pixel = surface.read(x, y);
            if (header.bitCount <= 8)
            {
                const entry = indexOf(pixel);
                if (header.bitCount === 8)
                {
                    bits[row + x] = entry;
                }
                else if (header.bitCount === 4)
                {
                    bits[row + (x >>> 1)] |= (x & 1) === 0 ? (entry & 0x0f) << 4 : entry & 0x0f;
                }
                else if ((entry & 1) !== 0)
                {
                    bits[row + (x >>> 3)] |= 0x80 >>> (x & 7);
                }
            }
            else if (header.bitCount === 32)
            {
                const at = row + (x * 4);
                const value = packPixel(pixel, channels);
                bits[at] = value & 0xff;
                bits[at + 1] = (value >>> 8) & 0xff;
                bits[at + 2] = (value >>> 16) & 0xff;
                bits[at + 3] = (value >>> 24) & 0xff;
            }
            else if (header.bitCount === 24)
            {
                const at = row + (x * 3);
                bits[at] = pixel & 0xff;
                bits[at + 1] = (pixel >>> 8) & 0xff;
                bits[at + 2] = (pixel >>> 16) & 0xff;
            }
            else
            {
                const at = row + (x * 2);
                const value = packPixel(pixel, channels);
                bits[at] = value & 0xff;
                bits[at + 1] = (value >>> 8) & 0xff;
            }
        }
        written++;
    }
    return written;
}

/**
 * The top-down row a DIB source coordinate names.
 *
 * `SetDIBitsToDevice` and `StretchDIBits` both take the source origin in the
 * DIB's own coordinates, which for the usual bottom-up DIB means the *lower*
 * left corner. Converting that once, here, is what keeps the sign out of the
 * blit.
 *
 * @param {number} ySrc
 * @param {number} rows      Height of the source rectangle.
 * @param {number} height    Height of the whole DIB.
 * @param {boolean} topDown
 * @returns {number}
 */
function sourceTop(ySrc, rows, height, topDown){
    return topDown ? ySrc : height - ySrc - rows;
}

/**
 * @typedef {Object} SetDibOptions
 * @property {import("./contract.js").Surface} dest
 * @property {import("./contract.js").Rect} [clip]
 * @property {number} xDest
 * @property {number} yDest
 * @property {number} width
 * @property {number} height
 * @property {number} xSrc
 * @property {number} ySrc
 * @property {DibImage} image  Its bits hold the supplied scan lines only.
 * @property {number} [firstScan]  uStartScan: the first scan line supplied.
 * @property {number} [scans]      cLines: how many; the whole DIB by default.
 */

/**
 * SetDIBitsToDevice: the part of a DIB's source rectangle the caller supplied
 * scan lines for, onto the device, and nothing of the rest.
 *
 * Every row here is counted as the call counts it, which is from the
 * picture's bottom whichever way the DIB is stored: scan line zero is the
 * bottom row, ySrc is the bottom of the source rectangle, and the bits hold
 * scans firstScan onward -- bottom-up in a bottom-up DIB, top-down in a
 * top-down one. The answer counts differently by storage too (Wine's
 * test_SetDIBitsToDevice): a top-down DIB answers the lines it was handed, a
 * bottom-up one the supplied lines at or below the source rectangle's top.
 *
 * @param {SetDibOptions} options
 * @returns {number} the scan lines, as above, or zero on failure
 */
export function setDIBitsToDevice(options){
    const header = options.image.header;
    const height = Math.abs(header.height);
    const topDown = header.height < 0;
    const first = options.firstScan ?? 0;
    const scans = options.scans ?? height;
    const rows = options.height | 0;
    const ySrc = options.ySrc | 0;
    const source = decodeDib({
        ...options.image,
        startScan: topDown ? height - first - scans : first,
        scanLines: scans,
    });
    if (!source)
    {
        return 0;
    }
    // Both in picture rows, top-down: what was supplied, and what was asked for.
    const rectangleTop = height - ySrc - rows;
    const top = Math.max(height - first - scans, rectangleTop);
    const bottom = Math.min(height - first, height - ySrc);
    if (bottom > top && (options.width | 0) > 0)
    {
        bitBlt({
            dest: options.dest,
            clip: options.clip,
            x: options.xDest | 0,
            y: (options.yDest | 0) + (top - rectangleTop),
            width: options.width | 0,
            height: bottom - top,
            src: source,
            srcX: options.xSrc | 0,
            srcY: top,
            rop: SRCCOPY,
        });
    }
    return topDown ? scans : Math.max(0, Math.min(first + scans, ySrc + rows) - Math.max(first, 0));
}

/**
 * @typedef {Object} StretchDibOptions
 * @property {import("./contract.js").Surface} dest
 * @property {import("./contract.js").Rect} [clip]
 * @property {number} xDest
 * @property {number} yDest
 * @property {number} destWidth
 * @property {number} destHeight
 * @property {number} xSrc
 * @property {number} ySrc
 * @property {number} srcWidth
 * @property {number} srcHeight
 * @property {DibImage} image
 * @property {number} [rop]
 * @property {number} [mode]
 * @property {import("./contract.js").PatternSource} [pattern]
 */

/**
 * @param {StretchDibOptions} options
 * @returns {number} how many scan lines were transferred, or zero on failure
 */
export function stretchDIBits(options){
    const source = decodeDib(options.image);
    if (!source)
    {
        return 0;
    }
    const rows = Math.abs(options.srcHeight | 0);
    const top = sourceTop(options.ySrc | 0, rows,
        Math.abs(options.image.header.height), options.image.header.height < 0);
    // The source rectangle is handed on with its sign intact -- a negative
    // height still mirrors -- but anchored at the row the conversion above
    // worked out, so the flip and the bottom-up order do not cancel silently.
    const anchored = (options.srcHeight | 0) < 0 ? top + rows : top;
    const drawn = stretchBlt({
        dest: options.dest,
        clip: options.clip,
        x: options.xDest | 0,
        y: options.yDest | 0,
        width: options.destWidth | 0,
        height: options.destHeight | 0,
        src: source,
        srcX: options.xSrc | 0,
        srcY: anchored,
        srcWidth: options.srcWidth | 0,
        srcHeight: options.srcHeight | 0,
        rop: options.rop ?? SRCCOPY,
        mode: options.mode,
        pattern: options.pattern,
    });
    return drawn ? rows : 0;
}

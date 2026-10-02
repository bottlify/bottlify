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

import { COLORONCOLOR, bitBlt, stretchBlt, stretchTarget } from './blit.js';
import { channelsOf, packPixel, unpackPixel } from './channels.js';
import { SRCCOPY } from './rop.js';
import { BI_BITFIELDS, createSurface, dibPitch, isEmptyRect, nearestEntry } from './surface.js';

/** BI_RGB: uncompressed, with the channel layout the bit count implies. */
export const BI_RGB = 0;
export { BI_BITFIELDS };

/** Run-length encoded eight- and four-bit DIBs. */
export const BI_RLE8 = 1;
export const BI_RLE4 = 2;

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
    return (SUPPORTED_DEPTHS.has(header.bitCount)
        && (header.compression === BI_RGB || (header.compression === BI_BITFIELDS && masked))
        && header.width > 0 && header.height !== 0) || isRle(header);
}

/**
 * Whether a header is a run-length encoded DIB this layer decodes: RLE8 at
 * eight bits, RLE4 at four, bottom-up, which is the only way such a DIB can
 * be stored.
 *
 * @param {import("../../win32/gdi32/structs.js").BitmapInfoHeaderFields} header
 */
export function isRle(header){
    return ((header.compression === BI_RLE8 && header.bitCount === 8)
        || (header.compression === BI_RLE4 && header.bitCount === 4))
        && header.width > 0 && header.height > 0;
}

/**
 * A run-length encoded DIB's picture, and which of its pixels the runs
 * reached: a pixel no run reaches is not part of the picture, and whatever
 * it lands on is left as it was.
 *
 * The bits are pairs. A count and a value is a run: that many pixels of the
 * value, or at four bits of its two nibbles by turns. A zero count escapes:
 * 0 ends the line, 1 ends the picture, 2 moves right and up by the next two
 * bytes, and any more is that many pixels given one by one, padded to a
 * WORD. Rows count from the bottom; a pixel past the right edge is dropped
 * rather than carried to the next line.
 *
 * @param {DibImage} image
 * @returns {{ surface: import("./surface.js").DepthSurface, written: Uint8Array }}
 */
function decodeRle(image){
    const { width, height } = image.header;
    const four = image.header.compression === BI_RLE4;
    const bits = image.bits;
    const colors = image.colors ?? [];
    const surface = createSurface({ width, height });
    const written = new Uint8Array(width * height);
    let at = image.offset ?? 0;
    let x = 0;
    let row = 0;
    /** @param {number} index */
    const put = index=>{
        if (x < width && row < height)
        {
            const y = height - 1 - row;
            surface.write(x, y, colors[index] ?? 0);
            written[y * width + x] = 1;
        }
        x++;
    };
    while (at + 2 <= bits.length && row < height)
    {
        const count = bits[at];
        const value = bits[at + 1];
        at += 2;
        if (count > 0)
        {
            for (let index = 0; index < count; index++)
            {
                put(four ? ((index & 1) === 0 ? value >>> 4 : value & 0x0f) : value);
            }
        }
        else if (value === 0)
        {
            x = 0;
            row++;
        }
        else if (value === 1)
        {
            break;
        }
        else if (value === 2)
        {
            x += bits[at] ?? 0;
            row += bits[at + 1] ?? 0;
            at += 2;
        }
        else
        {
            const bytes = four ? (value + 1) >>> 1 : value;
            for (let index = 0; index < value && at + (four ? index >>> 1 : index) < bits.length;
                index++)
            {
                const byte = bits[at + (four ? index >>> 1 : index)];
                put(four ? ((index & 1) === 0 ? byte >>> 4 : byte & 0x0f) : byte);
            }
            at += (bytes + 1) & ~1;
        }
    }
    return { surface, written };
}

/**
 * A rectangle of a source copied onto a destination where `written` says the
 * source has a pixel, and nowhere else.
 *
 * @param {{ dest: import("./contract.js").Surface, clip?: import("./contract.js").Rect,
 *           x: number, y: number, width: number, height: number,
 *           src: import("./contract.js").Surface, srcX: number, srcY: number,
 *           written: Uint8Array }} options
 */
function copyWritten(options){
    const { dest, src, written } = options;
    const clip = options.clip ?? { left: 0, top: 0, right: dest.width, bottom: dest.height };
    const left = Math.max(options.x, clip.left, 0);
    const top = Math.max(options.y, clip.top, 0);
    const right = Math.min(options.x + options.width, clip.right, dest.width);
    const bottom = Math.min(options.y + options.height, clip.bottom, dest.height);
    for (let y = top; y < bottom; y++)
    {
        const sy = options.srcY + (y - options.y);
        for (let x = left; x < right; x++)
        {
            const sx = options.srcX + (x - options.x);
            if (sx >= 0 && sy >= 0 && sx < src.width && sy < src.height
                && written[sy * src.width + sx] === 1)
            {
                dest.write(x, y, src.read(sx, sy));
            }
        }
    }
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
    if (isRle(image.header))
    {
        return decodeRle(image).surface;
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
    // Nothing is ever written back run-length encoded.
    if (!isConvertibleDib(image) || isRle(image.header)
        || (image.header.bitCount <= 8 && table.length === 0))
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
 * The top-down row a DIB source rectangle is anchored at, for a blit that
 * takes its height signed.
 *
 * StretchDIBits takes the source origin in the DIB's own coordinates, which
 * count from the picture's bottom: rows ySrc up to ySrc + srcHeight, and with
 * a negative height the rows below ySrc, as a negative extent runs everywhere
 * else in GDI. A copy at its own size of a top-down DIB counts from the top
 * instead (Wine's test_StretchDIBits). Converting that once, here, is what
 * keeps the sign out of the blit.
 *
 * @param {number} ySrc
 * @param {number} srcHeight  Signed.
 * @param {number} height     Height of the whole DIB.
 * @param {boolean} fromTop
 * @returns {number}
 */
function sourceRow(ySrc, srcHeight, height, fromTop){
    return fromTop ? ySrc : height - ySrc - srcHeight;
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
    if (isRle(header))
    {
        // An RLE DIB is always whole: the scan lines asked for are ignored,
        // but for none at all, and the answer is its height (Wine's
        // test_SetDIBitsToDevice_RLE8).
        if (scans === 0)
        {
            return 0;
        }
        const { surface, written } = decodeRle(options.image);
        const rectangleTop = height - ySrc - rows;
        const top = Math.max(0, rectangleTop);
        const bottom = Math.min(height, height - ySrc);
        copyWritten({
            dest: options.dest,
            clip: options.clip,
            x: options.xDest | 0,
            y: (options.yDest | 0) + (top - rectangleTop),
            width: options.width | 0,
            height: bottom - top,
            src: surface,
            srcX: options.xSrc | 0,
            srcY: top,
            written,
        });
        return height;
    }
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
 * StretchDIBits, answering as Windows does (Wine's bitmap and dib tests).
 *
 * A copy at the source's own size under SRCCOPY is SetDIBitsToDevice's: a
 * top-down DIB's ySrc counts from its top, and the answer is the lines from
 * the DIB's first to the rectangle's far edge. Anything else is a stretch,
 * whose ySrc counts from the bottom whichever way the DIB is stored, and
 * which answers the DIB's height -- as signed in the header, so negative for
 * a top-down DIB, under any operation but SRCCOPY. A source rectangle that
 * begins before the DIB's first column or row draws nothing and answers 0.
 *
 * @param {StretchDibOptions} options
 * @returns {number}
 */
export function stretchDIBits(options){
    const header = options.image.header;
    if (!isConvertibleDib(options.image))
    {
        return 0;
    }
    const xSrc = options.xSrc | 0;
    const ySrc = options.ySrc | 0;
    const across = options.srcWidth | 0;
    const down = options.srcHeight | 0;
    if (Math.min(xSrc, xSrc + across) < 0 || Math.min(ySrc, ySrc + down) < 0)
    {
        return 0;
    }
    const rop = options.rop ?? SRCCOPY;
    const copy = rop === SRCCOPY && across > 0 && down > 0
        && (options.destWidth | 0) === across && (options.destHeight | 0) === down;
    const height = Math.abs(header.height);
    // A picture whose rectangle misses the clip is not decoded at all, and is
    // answered as a stretch answers one that draws nothing: a window that
    // repaints one bar of itself draws its whole picture into a clip that
    // leaves the picture out, after every block an installer copies.
    const reaches = !isEmptyRect(stretchTarget(options.dest, options.clip, options.xDest,
        options.yDest, options.destWidth, options.destHeight));
    const source = reaches && !isRle(header) ? decodeDib(options.image) : null;
    const drawn = !reaches || (!source ? stretchRle(options) : stretchBlt({
        dest: options.dest,
        clip: options.clip,
        x: options.xDest | 0,
        y: options.yDest | 0,
        width: options.destWidth | 0,
        height: options.destHeight | 0,
        src: source,
        srcX: xSrc,
        srcY: sourceRow(ySrc, down, height, copy && header.height < 0),
        srcWidth: across,
        srcHeight: down,
        rop,
        mode: options.mode,
        pattern: options.pattern,
    }));
    if (!drawn)
    {
        return 0;
    }
    if (copy)
    {
        return Math.min(height, ySrc + down);
    }
    return rop === SRCCOPY ? height : header.height;
}

/**
 * StretchDIBits of a run-length encoded DIB: the stretch runs as for any
 * other, into a copy of the destination's rectangle, and only the pixels a
 * run reached -- stretched the same way, a pixel at a time -- are put back.
 *
 * @param {StretchDibOptions} options
 * @returns {boolean} whether the source rectangle met the DIB
 */
function stretchRle(options){
    const { surface, written } = decodeRle(options.image);
    const header = options.image.header;
    const mask = createSurface({ width: header.width, height: header.height });
    for (let index = 0; index < written.length; index++)
    {
        if (written[index] === 1)
        {
            mask.write(index % header.width, Math.floor(index / header.width), 0xffffff);
        }
    }
    const dest = options.dest;
    const x = Math.min(options.xDest | 0, (options.xDest | 0) + (options.destWidth | 0));
    const y = Math.min(options.yDest | 0, (options.yDest | 0) + (options.destHeight | 0));
    const clip = options.clip ?? { left: 0, top: 0, right: dest.width, bottom: dest.height };
    const left = Math.max(x, clip.left, 0);
    const top = Math.max(y, clip.top, 0);
    const right = Math.min(x + Math.abs(options.destWidth | 0), clip.right, dest.width);
    const bottom = Math.min(y + Math.abs(options.destHeight | 0), clip.bottom, dest.height);
    if (right <= left || bottom <= top)
    {
        return true;
    }
    const scratch = createSurface({ width: right - left, height: bottom - top });
    const reached = createSurface({ width: right - left, height: bottom - top });
    for (let row = top; row < bottom; row++)
    {
        for (let column = left; column < right; column++)
        {
            scratch.write(column - left, row - top, dest.read(column, row));
        }
    }
    const pattern = options.pattern;
    const geometry = {
        x: (options.xDest | 0) - left,
        y: (options.yDest | 0) - top,
        width: options.destWidth | 0,
        height: options.destHeight | 0,
        srcX: options.xSrc | 0,
        srcY: sourceRow(options.ySrc | 0, options.srcHeight | 0, header.height, false),
        srcWidth: options.srcWidth | 0,
        srcHeight: options.srcHeight | 0,
    };
    const drawn = stretchBlt({
        ...geometry,
        dest: scratch,
        src: surface,
        rop: options.rop ?? SRCCOPY,
        mode: options.mode,
        pattern: pattern && ((px, py)=>pattern(px + left, py + top)),
    });
    if (!drawn)
    {
        return false;
    }
    stretchBlt({ ...geometry, dest: reached, src: mask, rop: SRCCOPY, mode: COLORONCOLOR });
    for (let row = top; row < bottom; row++)
    {
        for (let column = left; column < right; column++)
        {
            if (reached.read(column - left, row - top) !== 0)
            {
                dest.write(column, row, scratch.read(column - left, row - top));
            }
        }
    }
    return true;
}

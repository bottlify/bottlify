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
 * Depths handled: 32, 24, 16 and 8. Four and one bit per pixel are not, and a
 * call naming one fails rather than producing a plausible wrong picture.
 */

import { bitBlt, stretchBlt } from './blit.js';
import { SRCCOPY } from './rop.js';
import { BI_BITFIELDS, createSurface, dibPitch } from './surface.js';

/** BI_RGB: uncompressed, with the channel layout the bit count implies. */
export const BI_RGB = 0;
export { BI_BITFIELDS };

/** The depths this layer converts. */
const SUPPORTED_DEPTHS = new Set([8, 16, 24, 32]);

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
 * How a sixteen- or thirty-two-bit DIB's pixels split into channels: for
 * each of red, green and blue, its mask, where the mask starts and how many
 * bits wide it is. A mask is one run of bits, as the format requires; an
 * empty one is a channel that is always zero.
 *
 * @param {DibImage} image
 * @returns {{ mask: number, shift: number, bits: number }[]}
 */
function channelsOf(image){
    const masks = image.header.compression === BI_BITFIELDS
        ? image.masks ?? [0, 0, 0]
        : RGB_MASKS[image.header.bitCount];
    return masks.map(value=>{
        const mask = value >>> 0;
        let shift = 0;
        while (shift < 32 && ((mask >>> shift) & 1) === 0)
        {
            shift++;
        }
        let bits = 0;
        while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1)
        {
            bits++;
        }
        return { mask, shift, bits };
    });
}

/**
 * A channel `bits` wide, widened to eight by repeating its bits, so full
 * scale stays full scale: a shift alone leaves five-bit white at 0xf8.
 *
 * @param {number} value @param {number} bits
 */
function widenChannel(value, bits){
    if (bits === 0 || bits >= 8)
    {
        return bits === 0 ? 0 : (value >>> (bits - 8)) & 0xff;
    }
    let wide = value;
    let filled = bits;
    while (filled < 8)
    {
        wide = (wide << bits) | value;
        filled += bits;
    }
    return (wide >>> (filled - 8)) & 0xff;
}

/**
 * @param {number} value  A masked pixel.
 * @param {{ mask: number, shift: number, bits: number }[]} channels
 * @returns {number} 0x00RRGGBB
 */
function unpack(value, channels){
    const [red, green, blue] = channels.map(channel=>widenChannel(
        ((value & channel.mask) >>> 0) >>> channel.shift, channel.bits));
    return ((red << 16) | (green << 8) | blue) >>> 0;
}

/**
 * @param {number} pixel  0x00RRGGBB
 * @param {{ mask: number, shift: number, bits: number }[]} channels
 * @returns {number} the masked pixel, each channel's top bits kept
 */
function pack(pixel, channels){
    const eight = [(pixel >>> 16) & 0xff, (pixel >>> 8) & 0xff, pixel & 0xff];
    let value = 0;
    channels.forEach((channel, index)=>{
        const narrowed = channel.bits >= 8
            ? eight[index] * (2 ** (channel.bits - 8))
            : eight[index] >>> (8 - channel.bits);
        value |= channel.bits === 0 ? 0 : (narrowed * (2 ** channel.shift)) & channel.mask;
    });
    return value >>> 0;
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
    const channels = header.bitCount === 16 || header.bitCount === 32 ? channelsOf(image) : [];

    for (let index = 0; index < scanLines; index++)
    {
        const dibRow = startScan + index;
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
                pixel = unpack(bits[at] | (bits[at + 1] << 8) | (bits[at + 2] << 16)
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
                pixel = unpack(bits[at] | (bits[at + 1] << 8), channels);
            }
            else
            {
                pixel = colors[bits[row + x]] ?? 0;
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
    if (!isConvertibleDib(image) || image.header.bitCount === 8)
    {
        // Writing an eight-bit DIB back means choosing a palette entry for every
        // colour, which is a quantiser and not a format conversion.
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
    const channels = header.bitCount === 16 || header.bitCount === 32 ? channelsOf(image) : [];

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
        for (let x = 0; x < width; x++)
        {
            const pixel = surface.read(x, y);
            if (header.bitCount === 32)
            {
                const at = row + (x * 4);
                const value = pack(pixel, channels);
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
                const value = pack(pixel, channels);
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
 * @property {DibImage} image
 */

/**
 * @param {SetDibOptions} options
 * @returns {number} how many scan lines were transferred, or zero on failure
 */
export function setDIBitsToDevice(options){
    const source = decodeDib(options.image);
    if (!source)
    {
        return 0;
    }
    const top = sourceTop(options.ySrc | 0, options.height | 0,
        Math.abs(options.image.header.height), options.image.header.height < 0);
    const copied = bitBlt({
        dest: options.dest,
        clip: options.clip,
        x: options.xDest | 0,
        y: options.yDest | 0,
        width: options.width | 0,
        height: options.height | 0,
        src: source,
        srcX: options.xSrc | 0,
        srcY: top,
        rop: SRCCOPY,
    });
    return copied ? Math.abs(options.height | 0) : 0;
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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Blt and BltFast over surfaces that live in guest memory.
 *
 * A DirectDraw surface is bytes at an address with a pitch, and nothing here
 * assumes more: two surfaces may share an allocation or not, and a surface may
 * be blitted onto itself with the rectangles overlapping. The source rectangle
 * is therefore read in full before a single destination pixel is written,
 * which is the one traversal that is right whatever the overlap and whatever
 * the stretch -- a direction-chosen copy cannot cope with one source pixel
 * feeding several destination pixels.
 *
 * Stretching samples by flooring, `src + floor(index * srcExtent / destExtent)`,
 * the rule `graphics/gdi` uses; the two blitters must not disagree about which
 * texel a magnified pixel shows. Nothing converts between pixel widths: a
 * source and destination of different depth are refused rather than guessed
 * at.
 */

import {
    DDBLTFAST_DESTCOLORKEY, DDBLTFAST_SRCCOLORKEY, DDBLT_COLORFILL, DDBLT_DEPTHFILL, DDBLT_KEYDEST,
    DDBLT_KEYDESTOVERRIDE, DDBLT_KEYSRC, DDBLT_KEYSRCOVERRIDE, DDERR_INVALIDPARAMS,
    DDERR_INVALIDRECT, DDERR_UNSUPPORTED, DD_OK,
} from './constants.js';

/**
 * @typedef {Object} BlitSurface
 * @property {number} buffer          Guest address of row zero.
 * @property {number} pitch           Bytes per row.
 * @property {number} width
 * @property {number} height
 * @property {number} bytesPerPixel   1, 2 or 4.
 * @property {number} [keyMask]       The bits a colour key compares; the whole pixel if absent.
 * @property {boolean} [depth]        A depth buffer, which holds no colour to fill.
 * @property {number} [depthMask]     A depth buffer's depth bits; the whole pixel if absent.
 */

/**
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * @typedef {Object} ColorKey
 * @property {number} low
 * @property {number} high
 */

/**
 * @typedef {Object} BlitMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [windowMemory]
 *     The bytes themselves rather than a copy, valid until the guest runs:
 *     what a blit reads its rectangles through where the memory offers it.
 */

/** @param {BlitSurface} surface */
const pixelMask = surface=>(surface.bytesPerPixel === 4
    ? 0xffffffff
    : (1 << (surface.bytesPerPixel * 8)) - 1);

/** @param {Rect | null | undefined} rect @param {BlitSurface} surface @returns {Rect} */
const wholeOf = (rect, surface)=>rect
    ?? { left: 0, top: 0, right: surface.width, bottom: surface.height };

/** @param {Rect} rect @param {BlitSurface} surface */
const rectFits = (rect, surface)=>rect.left >= 0 && rect.top >= 0
    && rect.right <= surface.width && rect.bottom <= surface.height
    && rect.left < rect.right && rect.top < rect.bottom;

/**
 * @param {number} value @param {ColorKey | undefined} key
 * @param {BlitSurface} surface the one whose pixel the value is
 */
const keyed = (value, key, surface)=>{
    if (key === undefined)
    {
        return false;
    }
    const mask = surface.keyMask ?? 0xffffffff;
    const bits = (value & mask) >>> 0;
    return bits >= ((key.low & mask) >>> 0) && bits <= ((key.high & mask) >>> 0);
};

/** @param {Rect[] | undefined} clipList @param {number} x @param {number} y */
const clippedOut = (clipList, x, y)=>{
    if (clipList === undefined || clipList.length === 0)
    {
        return false;
    }
    for (let index = 0; index < clipList.length; index++)
    {
        const rect = clipList[index];
        if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)
        {
            return false;
        }
    }
    return true;
};

/**
 * A rectangle's rows of a surface, from the first byte of its top row to the
 * last of its bottom one, through a window where the memory has one.
 *
 * @param {BlitMemory} memory @param {BlitSurface} surface @param {Rect} rect
 */
const spanOf = (memory, surface, rect)=>{
    const bpp = surface.bytesPerPixel;
    const address = surface.buffer + rect.top * surface.pitch + rect.left * bpp;
    const length = (rect.bottom - rect.top - 1) * surface.pitch + (rect.right - rect.left) * bpp;
    return memory.windowMemory
        ? memory.windowMemory(address, length)
        : memory.readMemory(address, length);
};

/**
 * The pixel of `bpp` little-endian bytes at `at`.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} bpp
 */
const pixelAt = (bytes, at, bpp)=>{
    if (bpp === 4)
    {
        return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24))
            >>> 0;
    }
    return bpp === 2 ? bytes[at] | (bytes[at + 1] << 8) : bytes[at];
};

/**
 * Where a blit keeps the source rectangle and builds each destination row:
 * grown when a blit needs more, and kept, so a blit costs no allocation for
 * its rows -- a sprite is dozens of them and a screen hundreds.
 */
let snapshotBytes = new Uint8Array(1 << 16);
let rowBytes = new Uint8Array(1 << 12);
/** A view of `rowBytes`' first bytes, kept while blits write rows of that length. */
let rowView = rowBytes.subarray(0, 0);

/** @param {number} length */
const rowOf = length=>{
    if (length > rowBytes.length)
    {
        rowBytes = new Uint8Array(Math.max(length, rowBytes.length * 2));
        rowView = rowBytes.subarray(0, 0);
    }
    if (rowView.length !== length)
    {
        rowView = rowBytes.subarray(0, length);
    }
    return rowView;
};

/**
 * @param {BlitMemory} memory
 * @param {BlitSurface} surface
 * @param {number} y
 * @param {number} x
 * @param {number} count
 * @returns {Uint32Array} the pixel values, little-endian words of the surface's width
 */
export function readRow(memory, surface, y, x, count){
    const bpp = surface.bytesPerPixel;
    const bytes = memory.readMemory(surface.buffer + y * surface.pitch + x * bpp, count * bpp);
    const out = new Uint32Array(count);
    for (let index = 0; index < count; index++)
    {
        let value = 0;
        for (let byte = bpp - 1; byte >= 0; byte--)
        {
            value = (value << 8) | bytes[index * bpp + byte];
        }
        out[index] = value >>> 0;
    }
    return out;
}

/**
 * @param {BlitMemory} memory
 * @param {BlitSurface} surface
 * @param {number} y
 * @param {number} x
 * @param {Uint32Array} values
 */
export function writeRow(memory, surface, y, x, values){
    const bpp = surface.bytesPerPixel;
    const bytes = new Uint8Array(values.length * bpp);
    for (let index = 0; index < values.length; index++)
    {
        for (let byte = 0; byte < bpp; byte++)
        {
            bytes[index * bpp + byte] = (values[index] >>> (byte * 8)) & 0xff;
        }
    }
    memory.writeMemory(surface.buffer + y * surface.pitch + x * bpp, bytes);
}

/** @param {BlitMemory} memory @param {BlitSurface} surface @param {number} x @param {number} y */
export function readPixel(memory, surface, x, y){
    return readRow(memory, surface, y, x, 1)[0];
}

/**
 * @param {BlitMemory} memory @param {BlitSurface} surface
 * @param {number} x @param {number} y @param {number} value
 */
export function writePixel(memory, surface, x, y, value){
    writeRow(memory, surface, y, x, Uint32Array.of((value & pixelMask(surface)) >>> 0));
}

/**
 * The one loop every blit is: for each destination row, a source of pixels
 * (a row of the snapshot, or a constant), and the keys and clip deciding
 * which land. Each row is built whole -- a pixel that does not land keeps what
 * the destination held -- and written back in one piece.
 *
 * @param {Object} job
 * @param {BlitMemory} job.memory
 * @param {BlitSurface} job.dest
 * @param {Rect} job.destRect
 * @param {number} job.fill   The constant, where `src` is absent.
 * @param {BlitSurface} [job.src]  Whose pixels the snapshot holds, for the source key.
 * @param {Rect} [job.srcRect]     The snapshot's extent, which a stretch samples by.
 * @param {ColorKey} [job.srcColorKey]
 * @param {ColorKey} [job.destColorKey]
 * @param {Rect[]} [job.clipList]
 */
function transfer(job){
    const { memory, dest, destRect, src, srcColorKey, destColorKey, clipList } = job;
    if (destColorKey === undefined && (clipList === undefined || clipList.length === 0)
        && transferWhole(job))
    {
        return;
    }
    const bpp = dest.bytesPerPixel;
    const width = destRect.right - destRect.left;
    const height = destRect.bottom - destRect.top;
    const mask = pixelMask(dest);
    const current = spanOf(memory, dest, destRect);
    const row = rowOf(width * bpp);
    const srcRect = job.srcRect;
    const srcWidth = srcRect ? srcRect.right - srcRect.left : width;
    const srcHeight = srcRect ? srcRect.bottom - srcRect.top : height;
    const held = snapshotBytes;
    for (let r = 0; r < height; r++)
    {
        const y = destRect.top + r;
        const from = r * dest.pitch;
        const sampledRow = srcHeight === height ? r : Math.floor((r * srcHeight) / height);
        for (let column = 0; column < width; column++)
        {
            const at = from + column * bpp;
            let value = job.fill;
            if (src)
            {
                const sampledColumn = srcWidth === width
                    ? column
                    : Math.floor((column * srcWidth) / width);
                value = pixelAt(held, (sampledRow * srcWidth + sampledColumn) * bpp, bpp);
            }
            value = (value & mask) >>> 0;
            const out = column * bpp;
            if ((src && keyed(value, srcColorKey, src))
                || (destColorKey !== undefined
                    && !keyed(pixelAt(current, at, bpp), destColorKey, dest))
                || clippedOut(clipList, destRect.left + column, y))
            {
                for (let byte = 0; byte < bpp; byte++)
                {
                    row[out + byte] = current[at + byte];
                }
                continue;
            }
            for (let byte = 0; byte < bpp; byte++)
            {
                row[out + byte] = (value >>> (byte * 8)) & 0xff;
            }
        }
        memory.writeMemory(dest.buffer + y * dest.pitch + destRect.left * bpp, row);
    }
}

/**
 * `transfer` where every pixel of the rectangle is the destination's to
 * write -- no destination key, no clipper -- and nothing is stretched: a
 * fill, a copy, and a copy under a source key, a row at a time rather than a
 * byte at a time. The same bytes land as the general loop's, and a blit it
 * does not cover (three bytes a pixel, a stretch) is left to that loop.
 *
 * @param {Parameters<typeof transfer>[0]} job
 * @returns {boolean} whether it was done here
 */
function transferWhole(job){
    const { memory, dest, destRect, src, srcColorKey } = job;
    const bpp = dest.bytesPerPixel;
    const width = destRect.right - destRect.left;
    const height = destRect.bottom - destRect.top;
    const srcRect = job.srcRect;
    if (bpp === 3 || (src && srcRect && (srcRect.right - srcRect.left !== width
        || srcRect.bottom - srcRect.top !== height)))
    {
        return false;
    }
    const rowLength = width * bpp;
    const at = (/** @type {number} */ y)=>dest.buffer + y * dest.pitch + destRect.left * bpp;
    const row = rowOf(rowLength);
    if (!src)
    {
        const fill = (job.fill & pixelMask(dest)) >>> 0;
        for (let column = 0; column < rowLength; column += bpp)
        {
            for (let byte = 0; byte < bpp; byte++)
            {
                row[column + byte] = (fill >>> (byte * 8)) & 0xff;
            }
        }
        for (let y = destRect.top; y < destRect.bottom; y++)
        {
            memory.writeMemory(at(y), row);
        }
        return true;
    }
    const held = snapshotBytes;
    if (srcColorKey === undefined)
    {
        for (let r = 0; r < height; r++)
        {
            memory.writeMemory(at(destRect.top + r),
                held.subarray(r * rowLength, (r + 1) * rowLength));
        }
        return true;
    }
    // A pixel of the source key keeps what the destination held; the rest
    // of the row is the source's.
    const keyMask = src.keyMask ?? 0xffffffff;
    const low = (srcColorKey.low & keyMask) >>> 0;
    const high = (srcColorKey.high & keyMask) >>> 0;
    const current = spanOf(memory, dest, destRect);
    const words = bpp === 4 ? new Uint32Array(held.buffer, 0, held.length >>> 2)
        : bpp === 2 ? new Uint16Array(held.buffer, 0, held.length >>> 1) : held;
    const into = bpp === 4 ? new Uint32Array(row.buffer, row.byteOffset, width)
        : bpp === 2 ? new Uint16Array(row.buffer, row.byteOffset, width) : row;
    for (let r = 0; r < height; r++)
    {
        const from = r * dest.pitch;
        row.set(current.subarray(from, from + rowLength));
        const first = r * width;
        for (let column = 0; column < width; column++)
        {
            const value = words[first + column];
            const bits = (value & keyMask) >>> 0;
            if (bits < low || bits > high)
            {
                into[column] = value;
            }
        }
        memory.writeMemory(at(destRect.top + r), row);
    }
    return true;
}

/**
 * The source rectangle, read into `snapshotBytes` before anything is
 * written, row after row with no pitch between them. The snapshot is what
 * makes a self-overlapping blit and a stretched one the same loop.
 *
 * @param {BlitMemory} memory @param {BlitSurface} src @param {Rect} rect
 */
function snapshot(memory, src, rect){
    const bpp = src.bytesPerPixel;
    const rowLength = (rect.right - rect.left) * bpp;
    const rows = rect.bottom - rect.top;
    if (rowLength * rows > snapshotBytes.length)
    {
        snapshotBytes = new Uint8Array(Math.max(rowLength * rows, snapshotBytes.length * 2));
    }
    const span = spanOf(memory, src, rect);
    const into = snapshotBytes;
    for (let row = 0; row < rows; row++)
    {
        const from = row * src.pitch;
        into.set(span.subarray(from, from + rowLength), row * rowLength);
    }
}

/**
 * A depth buffer's depth bits, set to one value over a rectangle; the stencil
 * bits beside them keep what they held.
 *
 * @param {BlitMemory} memory @param {BlitSurface} dest @param {Rect} rect
 * @param {number} value @param {Rect[] | undefined} clipList
 * @returns {number} HRESULT
 */
function depthFill(memory, dest, rect, value, clipList){
    const mask = (dest.depthMask ?? pixelMask(dest)) >>> 0;
    const bpp = dest.bytesPerPixel;
    const width = rect.right - rect.left;
    const current = spanOf(memory, dest, rect);
    const row = rowOf(width * bpp);
    for (let y = rect.top; y < rect.bottom; y++)
    {
        const from = (y - rect.top) * dest.pitch;
        for (let column = 0; column < width; column++)
        {
            const at = from + column * bpp;
            let pixel = pixelAt(current, at, bpp);
            if (!clippedOut(clipList, rect.left + column, y))
            {
                pixel = ((pixel & ~mask) | (value & mask)) >>> 0;
            }
            for (let byte = 0; byte < bpp; byte++)
            {
                row[column * bpp + byte] = (pixel >>> (byte * 8)) & 0xff;
            }
        }
        memory.writeMemory(dest.buffer + y * dest.pitch + rect.left * bpp, row);
    }
    return DD_OK;
}

/**
 * IDirectDrawSurface::Blt.
 *
 * @param {Object} request
 * @param {BlitMemory} request.memory
 * @param {BlitSurface} request.dest
 * @param {Rect | null} [request.destRect]
 * @param {BlitSurface | null} [request.src]
 * @param {Rect | null} [request.srcRect]
 * @param {number} request.flags   DDBLT
 * @param {{ fillColor?: number, fillDepth?: number, srcColorKey?: ColorKey,
 *            destColorKey?: ColorKey }} [request.fx]
 * @param {Rect[]} [request.clipList]
 * @returns {number} HRESULT
 */
export function blt(request){
    const { memory, dest } = request;
    const flags = request.flags >>> 0;
    const fx = request.fx ?? {};
    const destRect = wholeOf(request.destRect, dest);
    if (!rectFits(destRect, dest))
    {
        return DDERR_INVALIDRECT;
    }
    const srcColorKey = (flags & (DDBLT_KEYSRC | DDBLT_KEYSRCOVERRIDE)) !== 0
        ? fx.srcColorKey
        : undefined;
    const destColorKey = (flags & (DDBLT_KEYDEST | DDBLT_KEYDESTOVERRIDE)) !== 0
        ? fx.destColorKey
        : undefined;
    const common = { memory, dest, destRect, destColorKey, clipList: request.clipList };

    if ((flags & DDBLT_DEPTHFILL) !== 0)
    {
        return dest.depth
            ? depthFill(memory, dest, destRect, fx.fillDepth ?? 0, request.clipList)
            : DDERR_INVALIDPARAMS;
    }
    if ((flags & DDBLT_COLORFILL) !== 0)
    {
        if (dest.depth)
        {
            return DDERR_INVALIDPARAMS;
        }
        transfer({ ...common, fill: (fx.fillColor ?? 0) >>> 0 });
        return DD_OK;
    }

    const src = request.src ?? null;
    if (!src)
    {
        return DDERR_INVALIDPARAMS;
    }
    if (src.bytesPerPixel !== dest.bytesPerPixel)
    {
        return DDERR_UNSUPPORTED;
    }
    const srcRect = wholeOf(request.srcRect, src);
    if (!rectFits(srcRect, src))
    {
        return DDERR_INVALIDRECT;
    }
    snapshot(memory, src, srcRect);
    transfer({ ...common, fill: 0, src, srcRect, srcColorKey });
    return DD_OK;
}

/**
 * IDirectDrawSurface::BltFast: a copy at an offset, no stretch, no clipper.
 *
 * @param {Object} request
 * @param {BlitMemory} request.memory
 * @param {BlitSurface} request.dest
 * @param {number} request.x
 * @param {number} request.y
 * @param {BlitSurface | null} [request.src]
 * @param {Rect | null} [request.srcRect]
 * @param {number} request.flags   DDBLTFAST
 * @param {ColorKey} [request.srcColorKey]
 * @param {ColorKey} [request.destColorKey]
 * @returns {number} HRESULT
 */
export function bltFast(request){
    const { memory, dest } = request;
    const src = request.src ?? null;
    if (!src)
    {
        return DDERR_INVALIDPARAMS;
    }
    if (src.bytesPerPixel !== dest.bytesPerPixel)
    {
        return DDERR_UNSUPPORTED;
    }
    const srcRect = wholeOf(request.srcRect, src);
    const destRect = {
        left: request.x,
        top: request.y,
        right: request.x + (srcRect.right - srcRect.left),
        bottom: request.y + (srcRect.bottom - srcRect.top),
    };
    if (!rectFits(srcRect, src) || !rectFits(destRect, dest))
    {
        return DDERR_INVALIDRECT;
    }
    const flags = request.flags >>> 0;
    snapshot(memory, src, srcRect);
    transfer({
        memory,
        dest,
        destRect,
        fill: 0,
        src,
        srcRect,
        srcColorKey: (flags & DDBLTFAST_SRCCOLORKEY) !== 0 ? request.srcColorKey : undefined,
        destColorKey: (flags & DDBLTFAST_DESTCOLORKEY) !== 0 ? request.destColorKey : undefined,
    });
    return DD_OK;
}

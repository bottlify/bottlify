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
    DDBLTFAST_DESTCOLORKEY, DDBLTFAST_SRCCOLORKEY, DDBLT_COLORFILL, DDBLT_KEYDEST,
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
const clippedOut = (clipList, x, y)=>clipList !== undefined && clipList.length > 0
    && !clipList.some(rect=>x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);

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
 * which land.
 *
 * @param {Object} job
 * @param {BlitMemory} job.memory
 * @param {BlitSurface} job.dest
 * @param {Rect} job.destRect
 * @param {(row: number, column: number) => number} job.sample
 * @param {BlitSurface} [job.src]  Whose pixels the samples are, for the source key.
 * @param {ColorKey} [job.srcColorKey]
 * @param {ColorKey} [job.destColorKey]
 * @param {Rect[]} [job.clipList]
 */
function transfer(job){
    const { destRect } = job;
    const width = destRect.right - destRect.left;
    const mask = pixelMask(job.dest);
    for (let row = 0; row < destRect.bottom - destRect.top; row++)
    {
        const y = destRect.top + row;
        const current = readRow(job.memory, job.dest, y, destRect.left, width);
        for (let column = 0; column < width; column++)
        {
            const value = (job.sample(row, column) & mask) >>> 0;
            if ((job.src && keyed(value, job.srcColorKey, job.src))
                || (job.destColorKey !== undefined
                    && !keyed(current[column], job.destColorKey, job.dest))
                || clippedOut(job.clipList, destRect.left + column, y))
            {
                continue;
            }
            current[column] = value;
        }
        writeRow(job.memory, job.dest, y, destRect.left, current);
    }
}

/**
 * The source rectangle, read before anything is written. The snapshot is what
 * makes a self-overlapping blit and a stretched one the same loop.
 *
 * @param {BlitMemory} memory @param {BlitSurface} src @param {Rect} rect
 * @returns {(row: number, column: number) => number} a sampler over the snapshot
 */
function snapshot(memory, src, rect){
    const width = rect.right - rect.left;
    /** @type {Uint32Array[]} */
    const rows = [];
    for (let y = rect.top; y < rect.bottom; y++)
    {
        rows.push(readRow(memory, src, y, rect.left, width));
    }
    return (row, column)=>rows[row][column];
}

/**
 * @param {Rect} destRect @param {Rect} srcRect
 * @param {(row: number, column: number) => number} sample
 * @returns {(row: number, column: number) => number} the same sampler in destination coordinates
 */
function stretched(destRect, srcRect, sample){
    const destWidth = destRect.right - destRect.left;
    const destHeight = destRect.bottom - destRect.top;
    const srcWidth = srcRect.right - srcRect.left;
    const srcHeight = srcRect.bottom - srcRect.top;
    if (destWidth === srcWidth && destHeight === srcHeight)
    {
        return sample;
    }
    return (row, column)=>sample(
        Math.floor((row * srcHeight) / destHeight),
        Math.floor((column * srcWidth) / destWidth));
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
 * @param {{ fillColor?: number, srcColorKey?: ColorKey, destColorKey?: ColorKey }} [request.fx]
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

    if ((flags & DDBLT_COLORFILL) !== 0)
    {
        if (dest.depth)
        {
            return DDERR_INVALIDPARAMS;
        }
        const fill = (fx.fillColor ?? 0) >>> 0;
        transfer({ ...common, sample: ()=>fill });
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
    transfer({
        ...common,
        src,
        srcColorKey,
        sample: stretched(destRect, srcRect, snapshot(memory, src, srcRect)),
    });
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
    transfer({
        memory,
        dest,
        destRect,
        sample: snapshot(memory, src, srcRect),
        src,
        srcColorKey: (flags & DDBLTFAST_SRCCOLORKEY) !== 0 ? request.srcColorKey : undefined,
        destColorKey: (flags & DDBLTFAST_DESTCOLORKEY) !== 0 ? request.destColorKey : undefined,
    });
    return DD_OK;
}

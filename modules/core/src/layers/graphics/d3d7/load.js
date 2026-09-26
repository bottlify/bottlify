/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IDirect3DDevice7::Load: a copy of part of one texture into another, level
 * by level down both mip chains, with the source's palette entries and
 * source colour key going along.
 *
 * The rectangle and the point are in the source's top-level coordinates.
 * The destination's top level is whichever source level is its width, so a
 * smaller destination starts further down the source's chain, and the
 * rectangle and point are halved once for each level they go down -- the
 * rectangle's far edges rounding up, so a level never loses its last texel.
 */

import { D3D_OK, DDERR_INVALIDPARAMS } from './constants.js';
import { DDCKEY_SRCBLT } from '../ddraw/constants.js';

/**
 * @typedef {Object} LoadMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 *
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 * @typedef {{ x: number, y: number }} Point
 */

/** @param {any} surface @returns {any[]} the surface and every level below it */
function chainOf(surface){
    const levels = [];
    for (let level = surface; level; level = level.mipNext)
    {
        levels.push(level);
    }
    return levels;
}

/** @param {Rect} rect @param {Point} point */
function halve(rect, point){
    return {
        rect: {
            left: rect.left >> 1,
            top: rect.top >> 1,
            right: (rect.right + 1) >> 1,
            bottom: (rect.bottom + 1) >> 1,
        },
        point: { x: point.x >> 1, y: point.y >> 1 },
    };
}

/**
 * @param {LoadMemory} memory
 * @param {any} dest  One level.
 * @param {Point} point
 * @param {any} src   One level.
 * @param {Rect} rect
 */
function copyLevel(memory, dest, point, src, rect){
    const bpp = dest.bytesPerPixel;
    const width = Math.min(rect.right, src.width) - rect.left;
    const height = Math.min(rect.bottom, src.height) - rect.top;
    const columns = Math.min(width, dest.width - point.x);
    const rows = Math.min(height, dest.height - point.y);
    for (let row = 0; row < rows; row++)
    {
        const bytes = memory.readMemory(
            src.buffer + (rect.top + row) * src.pitch + rect.left * bpp, columns * bpp);
        memory.writeMemory(dest.buffer + (point.y + row) * dest.pitch + point.x * bpp, bytes);
    }
    dest.changeUniquenessValue();
}

/**
 * @param {Object} request
 * @param {LoadMemory} request.memory
 * @param {any} request.dest        The destination texture's top level.
 * @param {Point | null} request.destPoint  Null for the corner.
 * @param {any} request.src         The source texture's top level.
 * @param {Rect | null} request.srcRect     Null for the whole source.
 * @param {boolean} [request.keepDestinationKey]  A source with no colour key
 *        leaves the destination's: IDirect3DTexture2::Load does, where
 *        IDirect3DDevice7::Load takes the key away (Wine's ddraw7.c
 *        test_texture_load_ckey, 1993-2002, against ddraw4.c's).
 * @returns {number} HRESULT
 */
export function loadTexture(request){
    const { memory, dest, src } = request;
    if (!dest || !src || dest.bytesPerPixel !== src.bytesPerPixel)
    {
        return DDERR_INVALIDPARAMS;
    }
    const sources = chainOf(src);
    const targets = chainOf(dest);
    let offset = 0;
    while (offset < sources.length && sources[offset].width > dest.width)
    {
        offset++;
    }
    // A destination that is no level of the source, or has more levels than
    // the source has left below that one, has nothing to be loaded from.
    const first = sources[offset];
    if (!first || first.width !== dest.width || first.height !== dest.height
        || sources.length - offset < targets.length)
    {
        return DDERR_INVALIDPARAMS;
    }

    let rect = request.srcRect
        ? { ...request.srcRect }
        : { left: 0, top: 0, right: src.width, bottom: src.height };
    let point = request.destPoint ? { ...request.destPoint } : { x: 0, y: 0 };
    if (rect.left < 0 || rect.top < 0 || rect.left >= rect.right || rect.top >= rect.bottom
        || rect.right > src.width || rect.bottom > src.height || point.x < 0 || point.y < 0)
    {
        return DDERR_INVALIDPARAMS;
    }
    for (let level = 0; level < offset; level++)
    {
        ({ rect, point } = halve(rect, point));
    }
    if (point.x + rect.right - rect.left > dest.width
        || point.y + rect.bottom - rect.top > dest.height)
    {
        return DDERR_INVALIDPARAMS;
    }

    targets.forEach((target, level)=>{
        copyLevel(memory, target, point, sources[offset + level], rect);
        ({ rect, point } = halve(rect, point));
    });

    if (src.palette && dest.palette)
    {
        dest.palette.setEntries(0, src.palette.entries.slice(0, dest.palette.entries.length));
    }
    const key = src.getColorKey(DDCKEY_SRCBLT).key;
    if (key || !request.keepDestinationKey)
    {
        dest.setColorKey(DDCKEY_SRCBLT, key);
    }
    return D3D_OK;
}

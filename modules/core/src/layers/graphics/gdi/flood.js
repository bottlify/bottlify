/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ExtFloodFill: the area connected to a point, painted with the brush.
 *
 * The area is found first and painted after. Painting as it spreads would let
 * the brush decide where the fill goes next -- a brush of the boundary's
 * colour would stop it, a hatch would let it leak through its gaps -- when
 * the area is a question about the picture as it was.
 *
 * It spreads to the four neighbours of a pixel, never across a corner, and
 * never out of the clip: a clip with a hole in it stops the fill at the hole
 * as a border would.
 */

import { fillRect } from './shapes.js';
import { isEmptyRect } from './surface.js';

/** ExtFloodFill's types: a fill up to a border of the colour, or over a surface of it. */
export const FLOODFILLBORDER = 0;
export const FLOODFILLSURFACE = 1;

/**
 * @param {import("./shapes.js").Painter} painter
 *        Draws the area found, under the context's raster operation; its clip
 *        holds every piece of `area`.
 * @param {import("./contract.js").Rect[]} area  The clip, as the pieces it is made of.
 * @param {number} x @param {number} y  Where the fill starts.
 * @param {number} pixel  The colour, as a pixel, that bounds the fill or that it covers.
 * @param {boolean} surface  FLOODFILLSURFACE: the fill covers pixels of the colour.
 *        Otherwise it covers every pixel up to ones of the colour.
 * @param {import("./contract.js").PatternSource} pattern  The brush.
 * @returns {boolean} false, painting nothing, when the start is outside the clip or
 *          is not a pixel the fill covers
 */
export function floodFill(painter, area, x, y, pixel, surface, pattern){
    const pieces = area.filter(piece=>!isEmptyRect(piece));
    /** @param {number} px @param {number} py */
    const inside = (px, py)=>pieces.some(piece=>px >= piece.left && px < piece.right
        && py >= piece.top && py < piece.bottom);
    if (!inside(x, y))
    {
        return false;
    }
    // The colour as this surface would store it: a 16-bit or indexed surface
    // cannot hold every COLORREF, and a pixel drawn in one reads back as the
    // nearest it can. The unused byte is not part of a colour.
    const pixels = painter.surface;
    const target = (pixels.nearest ? pixels.nearest(pixel) : pixel) & 0xffffff;
    /** @param {number} px @param {number} py */
    const covers = (px, py)=>((pixels.read(px, py) & 0xffffff) === target) === surface;
    if (!covers(x, y))
    {
        return false;
    }
    const bounds = painter.clip;
    const width = bounds.right - bounds.left;
    const seen = new Uint8Array(width * (bounds.bottom - bounds.top));
    /** @param {number} px @param {number} py */
    const open = (px, py)=>inside(px, py)
        && seen[(py - bounds.top) * width + (px - bounds.left)] === 0 && covers(px, py);
    /** Each run found, as its row and its two ends: y, left, right. @type {number[]} */
    const runs = [];
    const seeds = [x, y];
    while (seeds.length > 0)
    {
        const row = /** @type {number} */ (seeds.pop());
        const start = /** @type {number} */ (seeds.pop());
        if (!open(start, row))
        {
            continue;
        }
        let left = start;
        while (open(left - 1, row))
        {
            left--;
        }
        let right = start + 1;
        while (open(right, row))
        {
            right++;
        }
        seen.fill(1, (row - bounds.top) * width + (left - bounds.left),
            (row - bounds.top) * width + (right - bounds.left));
        runs.push(row, left, right);
        // A seed at the start of every open stretch above and below the run.
        for (const next of [row - 1, row + 1])
        {
            let opened = false;
            for (let px = left; px < right; px++)
            {
                const now = open(px, next);
                if (now && !opened)
                {
                    seeds.push(px, next);
                }
                opened = now;
            }
        }
    }
    for (let at = 0; at < runs.length; at += 3)
    {
        fillRect(painter, { left: runs[at + 1], top: runs[at], right: runs[at + 2],
            bottom: runs[at] + 1 }, pattern);
    }
    return true;
}

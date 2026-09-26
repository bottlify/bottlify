/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Turning a brush into the pixels it lays down.
 *
 * The brush itself belongs to the bookkeeping half: its style, colour and hatch
 * index were decided when the program created it, and they arrive here as the
 * `attributes` of an entry in that half's object table. What is decided here is
 * only what a given surface coordinate gets, which needs three things the brush
 * does not carry -- the background mode, the background colour, and the brush
 * origin the tile is aligned to.
 *
 * A pattern that leaves a pixel alone reports `TRANSPARENT_PIXEL` rather than a
 * colour, because a hatched brush in TRANSPARENT background mode genuinely
 * paints nothing between its lines, and painting the background there instead
 * is the difference between a hatch and a solid block.
 */

import { colorToPixel, surfaceForPattern } from './surface.js';

/** Brush styles, as wingdi.h numbers them. */
export const BS_SOLID = 0;
export const BS_NULL = 1;
export const BS_HATCHED = 2;
export const BS_PATTERN = 3;

/** Hatch styles. */
export const HS_HORIZONTAL = 0;
export const HS_VERTICAL = 1;
export const HS_FDIAGONAL = 2;
export const HS_BDIAGONAL = 3;
export const HS_CROSS = 4;
export const HS_DIAGCROSS = 5;

/** Background modes. */
export const TRANSPARENT = 1;
export const OPAQUE = 2;

/** A hatch repeats every eight pixels, which is the size of the tile Windows uses. */
const HATCH_PERIOD = 8;

/** What a pattern reports where it paints nothing at all. */
export const TRANSPARENT_PIXEL = -1;

/**
 * @param {number} style
 * @param {number} x
 * @param {number} y
 * @returns {boolean} whether the hatch's foreground covers this pixel
 */
function hatchCovers(style, x, y){
    const column = ((x % HATCH_PERIOD) + HATCH_PERIOD) % HATCH_PERIOD;
    const row = ((y % HATCH_PERIOD) + HATCH_PERIOD) % HATCH_PERIOD;
    switch (style | 0){
        case HS_HORIZONTAL:
            return row === 0;
        case HS_VERTICAL:
            return column === 0;
        case HS_FDIAGONAL:
            return column === row;
        case HS_BDIAGONAL:
            return ((column + row) % HATCH_PERIOD) === (HATCH_PERIOD - 1);
        case HS_CROSS:
            return row === 0 || column === 0;
        case HS_DIAGCROSS:
            return column === row || ((column + row) % HATCH_PERIOD) === (HATCH_PERIOD - 1);
        default:
            // An unknown hatch index is a solid brush rather than an empty one:
            // a shape that vanishes is harder to diagnose than one whose fill is
            // too dense.
            return true;
    }
}

/**
 * @typedef {Object} PatternOptions
 * @property {any} attributes                  The brush object's attributes.
 * @property {number} bkMode
 * @property {number} bkColor
 * @property {{ x: number, y: number }} origin The brush origin, in surface coordinates.
 * @property {number} [textColor]  What a monochrome pattern's 0 bits are drawn in.
 * @property {boolean} [mono]      Whether the destination is monochrome.
 */

/**
 * @param {PatternOptions} options
 * @returns {import("./contract.js").PatternSource}
 */
export function createPattern(options){
    const attributes = options.attributes ?? {};
    const style = attributes.style ?? BS_SOLID;
    const foreground = colorToPixel(attributes.color ?? 0);
    const background = options.bkMode === OPAQUE
        ? colorToPixel(options.bkColor)
        : TRANSPARENT_PIXEL;
    const originX = options.origin.x | 0;
    const originY = options.origin.y | 0;

    if (style === BS_NULL)
    {
        return ()=>TRANSPARENT_PIXEL;
    }
    if (style === BS_HATCHED)
    {
        return (x, y)=>hatchCovers(attributes.hatch ?? 0, x - originX, y - originY)
            ? foreground
            : background;
    }
    const tile = style === BS_PATTERN && attributes.pattern
        ? surfaceForPattern(attributes.pattern)
        : null;
    if (tile)
    {
        // A monochrome bitmap has no colours of its own: a 0 bit is the text
        // colour and a 1 bit the background colour, whatever the background
        // mode, and into a monochrome destination the bits go as they are.
        const colours = tile.mono && !options.mono
            ? [colorToPixel(options.textColor ?? 0), colorToPixel(options.bkColor)]
            : null;
        return (x, y)=>{
            const column = (((x - originX) % tile.width) + tile.width) % tile.width;
            const row = (((y - originY) % tile.height) + tile.height) % tile.height;
            const pixel = tile.read(column, row);
            return colours ? colours[(pixel & 0xffffff) === 0 ? 0 : 1] : pixel;
        };
    }
    return ()=>foreground;
}

/**
 * The pattern a solid colour makes, for the calls that fill with a colour
 * rather than with a brush.
 *
 * @param {number} color
 * @returns {import("./contract.js").PatternSource}
 */
export function solidPattern(color){
    const pixel = colorToPixel(color);
    return ()=>pixel;
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The three block transfers: BitBlt, StretchBlt and PatBlt.
 *
 * Three questions have one answer each here, and they are the ones that decide
 * whether a blit is right:
 *
 * - **Clipping shifts the source.** Cutting a destination rectangle down to the
 *   clip and then reading the source from where it originally started is the
 *   defect that slides an image by the width of the clipped strip. Both edges
 *   move together.
 * - **A source read outside the source surface writes nothing.** Windows leaves
 *   it undefined; leaving the destination alone is deterministic and cannot
 *   invent a colour.
 * - **Overlap is memmove, not memcpy.** When source and destination are the same
 *   memory, the traversal order is chosen from the sign of the displacement, so
 *   no pixel is read after it has been overwritten. StretchBlt takes a copy
 *   instead, because there is no traversal order that works when one source
 *   pixel feeds several destination pixels.
 */

import { applyRop, ropTable, ropUsesPattern, ropUsesSource } from './rop.js';
import { TRANSPARENT_PIXEL } from './brush.js';
import {
    MONOCHROME, colorToPixel, createSurface, intersectRect, isEmptyRect, surfaceBounds,
} from './surface.js';

/** SetStretchBltMode's modes. */
export const BLACKONWHITE = 1;
export const WHITEONBLACK = 2;
export const COLORONCOLOR = 3;
export const HALFTONE = 4;
export const STRETCH_MODES = Object.freeze([BLACKONWHITE, WHITEONBLACK, COLORONCOLOR, HALFTONE]);

/**
 * @typedef {Object} BlitOptions
 * @property {import("./contract.js").Surface} dest
 * @property {import("./contract.js").Rect} [clip]
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {import("./contract.js").Surface} [src]
 * @property {number} [srcX]
 * @property {number} [srcY]
 * @property {number} rop
 * @property {import("./contract.js").PatternSource} [pattern]
 * @property {((pixel: number) => number) | null} [convert]
 *           What a source pixel means on the destination, when that is not
 *           the pixel itself: see `sourceConversion`.
 */

/**
 * How a source pixel is read onto a destination of another kind, or null
 * when it is read as it is.
 *
 * Only a monochrome device bitmap on one side and not the other changes
 * anything, and it changes it by the device contexts' colours rather than by
 * nearest colour: to colour, a 0 bit is the destination's text colour and a 1
 * bit its background colour; to monochrome, a source pixel is 1 exactly when
 * it is the source's background colour -- compared as the source would store
 * that colour, so an indexed source matches the entry nearest it and a 32-bit
 * one only a pixel whose unused byte is zero as well.
 *
 * @param {{ src: import("./contract.js").Surface, dest: import("./contract.js").Surface,
 *     textColor: number, bkColor: number, srcBkColor: number }} options
 *        The two COLORREFs of the destination's context, and the background
 *        colour of the source's.
 * @returns {((pixel: number) => number) | null}
 */
export function sourceConversion({ src, dest, textColor, bkColor, srcBkColor }){
    if (src.mono === true && dest.mono !== true)
    {
        const zero = colorToPixel(textColor);
        const one = colorToPixel(bkColor);
        return pixel=>((pixel & 0xffffff) === 0 ? zero : one);
    }
    if (src.mono !== true && dest.mono === true)
    {
        const background = colorToPixel(srcBkColor);
        const match = src.nearest ? src.nearest(background) : background;
        return pixel=>((pixel >>> 0) === match ? MONOCHROME[1] : MONOCHROME[0]);
    }
    return null;
}

/**
 * @param {BlitOptions} options
 * @returns {boolean} what BitBlt reports
 */
export function bitBlt(options){
    const table = ropTable(options.rop);
    const width = options.width | 0;
    const height = options.height | 0;
    if (width < 0 || height < 0)
    {
        return false;
    }
    const src = options.src ?? null;
    if (ropUsesSource(table) && !src)
    {
        return false;
    }
    if (width === 0 || height === 0)
    {
        // Nothing is drawn, but nothing failed either: a zero-sized blit is how
        // a layout with an empty region asks for no work.
        return true;
    }

    const dest = options.dest;
    const clip = intersectRect(options.clip ?? surfaceBounds(dest), surfaceBounds(dest));
    const target = intersectRect(clip, {
        left: options.x | 0,
        top: options.y | 0,
        right: (options.x | 0) + width,
        bottom: (options.y | 0) + height,
    });
    if (isEmptyRect(target))
    {
        return true;
    }

    // The source moves with the clipped destination, so a pixel keeps the
    // source pixel it started with no matter how much of the rectangle survives.
    const shiftX = (options.srcX ?? 0) - (options.x | 0);
    const shiftY = (options.srcY ?? 0) - (options.y | 0);
    const area = src
        ? intersectRect(target, {
            left: -shiftX,
            top: -shiftY,
            right: src.width - shiftX,
            bottom: src.height - shiftY,
        })
        : target;
    if (isEmptyRect(area))
    {
        return true;
    }

    const usesPattern = ropUsesPattern(table);
    const pattern = options.pattern;
    const convert = options.convert ?? null;
    // Same memory means the copy can eat its own source, so the loops run away
    // from the displacement rather than towards it.
    const overlapping = !!src && src.bytes === dest.bytes;
    const backwardY = overlapping && shiftY < 0;
    const backwardX = overlapping && shiftY === 0 && shiftX < 0;

    for (let step = 0; step < area.bottom - area.top; step++)
    {
        const y = backwardY ? area.bottom - 1 - step : area.top + step;
        for (let column = 0; column < area.right - area.left; column++)
        {
            const x = backwardX ? area.right - 1 - column : area.left + column;
            const p = usesPattern && pattern ? pattern(x, y) : 0;
            if (p === TRANSPARENT_PIXEL)
            {
                continue;
            }
            const read = src ? src.read(x + shiftX, y + shiftY) : 0;
            const s = convert && src ? convert(read) : read;
            dest.write(x, y, applyRop(table, p, s, dest.read(x, y)));
        }
    }
    return true;
}

/**
 * PatBlt is BitBlt with no source, and an operation that would need one fails
 * rather than reading whatever happened to be there.
 *
 * @param {BlitOptions} options
 * @returns {boolean}
 */
export function patBlt(options){
    if (ropUsesSource(ropTable(options.rop)))
    {
        return false;
    }
    return bitBlt({ ...options, src: undefined });
}

/**
 * @typedef {Object} StretchOptions
 * @property {import("./contract.js").Surface} dest
 * @property {import("./contract.js").Rect} [clip]
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {import("./contract.js").Surface} src
 * @property {number} srcX
 * @property {number} srcY
 * @property {number} srcWidth
 * @property {number} srcHeight
 * @property {number} rop
 * @property {number} [mode]
 * @property {import("./contract.js").PatternSource} [pattern]
 * @property {((pixel: number) => number) | null} [convert]   As BitBlt's.
 */

/**
 * Combines the source pixels one destination pixel was stretched from. The four
 * modes differ only here, and only when shrinking: magnifying gives every
 * destination pixel a box of one, and all four agree on what to do with that.
 *
 * @param {import("./contract.js").Surface} src
 * @param {number} left
 * @param {number} top
 * @param {number} right
 * @param {number} bottom
 * @param {number} mode
 * @returns {number}
 */
function combine(src, left, top, right, bottom, mode){
    if (mode === COLORONCOLOR)
    {
        // The mode that drops pixels rather than folding them: the first one of
        // the box survives and the rest are simply not read.
        return src.read(left, top);
    }
    if (mode === HALFTONE)
    {
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;
        for (let y = top; y < bottom; y++)
        {
            for (let x = left; x < right; x++)
            {
                const pixel = src.read(x, y);
                red += (pixel >>> 16) & 0xff;
                green += (pixel >>> 8) & 0xff;
                blue += pixel & 0xff;
                count++;
            }
        }
        return ((Math.round(red / count) << 16) | (Math.round(green / count) << 8)
            | Math.round(blue / count)) >>> 0;
    }
    // BLACKONWHITE keeps a dark pixel by ANDing the box, WHITEONBLACK keeps a
    // light one by ORing it. Which of the two a program wants depends entirely
    // on which colour its content is drawn on.
    let value = mode === BLACKONWHITE ? 0xffffffff : 0;
    for (let y = top; y < bottom; y++)
    {
        for (let x = left; x < right; x++)
        {
            const pixel = src.read(x, y);
            value = mode === BLACKONWHITE ? (value & pixel) : (value | pixel);
        }
    }
    return value >>> 0;
}

/**
 * A copy of part of a surface, so that a stretch whose source and destination
 * are the same memory reads what was there before it started.
 *
 * @param {import("./contract.js").Surface} src
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 * @returns {import("./contract.js").Surface}
 */
function snapshot(src, left, top, width, height){
    const copy = createSurface({ width, height });
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            copy.write(x, y, src.read(left + x, top + y));
        }
    }
    return copy;
}

/**
 * @param {StretchOptions} options
 * @returns {boolean} what StretchBlt reports
 */
export function stretchBlt(options){
    const table = ropTable(options.rop);
    const mode = options.mode ?? BLACKONWHITE;
    // A negative extent mirrors on that axis. Both rectangles carry a sign and
    // the two cancel: mirroring the source and the destination together is the
    // same picture the right way round.
    const mirrorX = ((options.width | 0) < 0) !== ((options.srcWidth | 0) < 0);
    const mirrorY = ((options.height | 0) < 0) !== ((options.srcHeight | 0) < 0);
    const destWidth = Math.abs(options.width | 0);
    const destHeight = Math.abs(options.height | 0);
    const srcWidth = Math.abs(options.srcWidth | 0);
    const srcHeight = Math.abs(options.srcHeight | 0);
    if (destWidth === 0 || destHeight === 0 || srcWidth === 0 || srcHeight === 0)
    {
        return true;
    }
    const destLeft = Math.min(options.x | 0, (options.x | 0) + (options.width | 0));
    const destTop = Math.min(options.y | 0, (options.y | 0) + (options.height | 0));
    const srcLeft = Math.min(options.srcX | 0, (options.srcX | 0) + (options.srcWidth | 0));
    const srcTop = Math.min(options.srcY | 0, (options.srcY | 0) + (options.srcHeight | 0));

    const dest = options.dest;
    const clip = intersectRect(options.clip ?? surfaceBounds(dest), surfaceBounds(dest));
    const target = intersectRect(clip, {
        left: destLeft,
        top: destTop,
        right: destLeft + destWidth,
        bottom: destTop + destHeight,
    });
    if (isEmptyRect(target))
    {
        return true;
    }
    const visible = intersectRect(
        { left: srcLeft, top: srcTop, right: srcLeft + srcWidth, bottom: srcTop + srcHeight },
        surfaceBounds(options.src));
    if (isEmptyRect(visible))
    {
        return false;
    }
    const src = options.src.bytes === dest.bytes
        ? snapshot(options.src, visible.left, visible.top,
            visible.right - visible.left, visible.bottom - visible.top)
        : options.src;
    const readLeft = options.src === src ? 0 : visible.left;
    const readTop = options.src === src ? 0 : visible.top;

    const usesPattern = ropUsesPattern(table);
    const pattern = options.pattern;
    const convert = options.convert ?? null;
    for (let y = target.top; y < target.bottom; y++)
    {
        const row = mirrorY ? destHeight - 1 - (y - destTop) : y - destTop;
        const sourceTop = srcTop + Math.floor((row * srcHeight) / destHeight);
        const sourceBottom = Math.max(sourceTop + 1,
            srcTop + Math.floor(((row + 1) * srcHeight) / destHeight));
        for (let x = target.left; x < target.right; x++)
        {
            const column = mirrorX ? destWidth - 1 - (x - destLeft) : x - destLeft;
            const sourceLeft = srcLeft + Math.floor((column * srcWidth) / destWidth);
            const sourceRight = Math.max(sourceLeft + 1,
                srcLeft + Math.floor(((column + 1) * srcWidth) / destWidth));
            const box = intersectRect(
                { left: sourceLeft, top: sourceTop, right: sourceRight, bottom: sourceBottom },
                visible);
            if (isEmptyRect(box))
            {
                continue;
            }
            const p = usesPattern && pattern ? pattern(x, y) : 0;
            if (p === TRANSPARENT_PIXEL)
            {
                continue;
            }
            const combined = combine(src, box.left - readLeft, box.top - readTop,
                box.right - readLeft, box.bottom - readTop, mode);
            const s = convert ? convert(combined) : combined;
            dest.write(x, y, applyRop(table, p, s, dest.read(x, y)));
        }
    }
    return true;
}

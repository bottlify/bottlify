/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The block transfers: BitBlt, and MaskBlt, which is BitBlt with a second
 * raster operation where its mask is clear; StretchBlt, and AlphaBlend and
 * TransparentBlt, which stretch as it does and blend, or leave out a colour,
 * where it would combine; and PatBlt.
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

/** SRCCOPY's table: the source, whatever the destination and the pattern. */
const SRCCOPY_TABLE = 0xcc;

/**
 * How the copies went: by rows, or a pixel at a time and why. A copy whose
 * row path declined is the one that freezes a menu for most of a second, and
 * only this says which of its conditions it missed.
 */
export const blitPaths = {
    rows: 0,
    pixels: 0,
    /** @type {Record<string, number>} */
    why: {},
};

/** @param {string} reason */
const tookPixels = reason=>{
    blitPaths.pixels++;
    // Bounded, as a run draws thousands of shapes: past 64 reasons, a count.
    const key = reason in blitPaths.why || Object.keys(blitPaths.why).length < 64
        ? reason : 'other';
    blitPaths.why[key] = (blitPaths.why[key] ?? 0) + 1;
};

/**
 * A surface as a declined copy names it: its depth (a view has none), size,
 * row order, and whether it has words and reads rows.
 *
 * @param {any} surface
 */
const shapeOf = surface=>(surface
    ? `${surface.bitCount ?? 'view'} ${surface.width}x${surface.height}`
        + ` ${surface.topDown ? 'down' : 'up'} ${surface.words ? 'words' : 'no-words'}`
        + ` ${surface.readRow ? 'rows' : 'no-rows'}`
    : 'none');

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
 * @property {((x: number, y: number) => boolean) | null} [mask]
 *           MaskBlt's mask, by destination pixel: true where the operation
 *           `rop` names applies, false where the one in its high byte does --
 *           MAKEROP4's background operation. Absent, every pixel takes `rop`.
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
    const mask = options.mask ?? null;
    const background = mask ? (options.rop >>> 24) & 0xff : table;
    const width = options.width | 0;
    const height = options.height | 0;
    if (width < 0 || height < 0)
    {
        return false;
    }
    const src = options.src ?? null;
    if ((ropUsesSource(table) || ropUsesSource(background)) && !src)
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

    const usesPattern = ropUsesPattern(table) || ropUsesPattern(background);
    const pattern = options.pattern;
    const convert = options.convert ?? null;
    // Same memory means the copy can eat its own source, so the loops run away
    // from the displacement rather than towards it.
    const overlapping = !!src && src.bytes === dest.bytes;
    const backwardY = overlapping && shiftY < 0;
    const backwardX = overlapping && shiftY === 0 && shiftX < 0;

    // A plain copy between two surfaces whose words are their pixels moves
    // whole rows: a pixel at a time through the operation, a menu's button
    // cost a tenth of a millisecond to copy.
    const srcWords = src?.words;
    const destWords = dest.words;
    if (table === SRCCOPY_TABLE && !mask && !convert && !usesPattern && src && srcWords
        && destWords)
    {
        blitPaths.rows++;
        const run = area.right - area.left;
        /** @param {any} surface @param {number} y */
        const rowAt = (surface, y)=>(surface.topDown ? y : surface.height - 1 - y)
            * (surface.pitch >>> 2);
        for (let step = 0; step < area.bottom - area.top; step++)
        {
            const y = backwardY ? area.bottom - 1 - step : area.top + step;
            const to = rowAt(dest, y) + area.left;
            const from = rowAt(src, y + shiftY) + area.left + shiftX;
            if (overlapping && srcWords.buffer === destWords.buffer
                && srcWords.byteOffset === destWords.byteOffset)
            {
                destWords.copyWithin(to, from, from + run);
            }
            else
            {
                destWords.set(srcWords.subarray(from, from + run), to);
            }
        }
        return true;
    }
    // The same copy from a source of another depth: each row read out of it
    // whole, straight into the destination's words; and any operation that
    // takes no pattern -- a transparent picture's AND of its mask and OR of
    // its colours -- the source's row against the destination's word by word.
    if (!mask && !convert && !usesPattern && src && destWords && src.readRow && !overlapping)
    {
        blitPaths.rows++;
        const run = area.right - area.left;
        const pitchWords = dest.pitch >>> 2;
        const row = table === SRCCOPY_TABLE ? null : new Uint32Array(run);
        for (let y = area.top; y < area.bottom; y++)
        {
            const to = (dest.topDown ? y : dest.height - 1 - y) * pitchWords + area.left;
            if (!row)
            {
                src.readRow(y + shiftY, area.left + shiftX, run, destWords, to);
                continue;
            }
            src.readRow(y + shiftY, area.left + shiftX, run, row, 0);
            for (let i = 0; i < run; i++)
            {
                destWords[to + i] = applyRop(table, 0, row[i], destWords[to + i]);
            }
        }
        return true;
    }

    tookPixels(`copy rop ${table.toString(16)}: ${mask ? 'mask' : convert ? 'conversion'
        : usesPattern ? 'pattern' : !src ? 'no source' : !destWords ? 'destination has no words'
            : !src.readRow ? 'source reads no rows' : 'one memory'}`
        + `; to ${shapeOf(dest)}, from ${shapeOf(src)}`);
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
            const operation = mask && !mask(x, y) ? background : table;
            dest.write(x, y, applyRop(operation, p, s, dest.read(x, y)));
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
 * The part of a destination a stretch can reach: its rectangle, whichever way
 * the extents point, inside the clip and the surface.
 *
 * @param {import("./contract.js").Surface} dest
 * @param {import("./contract.js").Rect | undefined} clip
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {import("./contract.js").Rect}
 */
export function stretchTarget(dest, clip, x, y, width, height){
    const left = Math.min(x | 0, (x | 0) + (width | 0));
    const top = Math.min(y | 0, (y | 0) + (height | 0));
    return intersectRect(intersectRect(clip ?? surfaceBounds(dest), surfaceBounds(dest)), {
        left,
        top,
        right: left + Math.abs(width | 0),
        bottom: top + Math.abs(height | 0),
    });
}

/**
 * Where a stretch reads and writes: the two rectangles, each with its sign.
 *
 * @typedef {Pick<StretchOptions, 'dest' | 'clip' | 'x' | 'y' | 'width' | 'height' | 'src'
 *     | 'srcX' | 'srcY' | 'srcWidth' | 'srcHeight'>} StretchGeometry
 */

/**
 * Each destination pixel a stretch reaches, with the box of source pixels it
 * was stretched from. The box is in the coordinates of the surface handed
 * with it: the source, or -- when the source is the destination's own
 * memory -- a copy of the part read, taken before anything is written.
 *
 * @param {StretchGeometry} options
 * @param {(x: number, y: number, src: import("./contract.js").Surface, left: number,
 *     top: number, right: number, bottom: number) => void} visit
 * @returns {boolean} false when the source rectangle misses the source entirely
 */
function stretchEach(options, visit){
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
    const target = stretchTarget(dest, options.clip, options.x, options.y,
        options.width, options.height);
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
            visit(x, y, src, box.left - readLeft, box.top - readTop,
                box.right - readLeft, box.bottom - readTop);
        }
    }
    return true;
}

/**
 * A stretch copied a row at a time: the geometry `stretchEach` walks, each
 * destination pixel folding the box of source pixels it was stretched from as
 * the mode folds it (`combine`), the box's rows read once for the row of the
 * destination they make. Enlarging, every box is one pixel.
 *
 * @param {StretchGeometry} options
 * @param {number} mode  the stretch mode
 * @param {number} [table]  the operation's table, one that takes no pattern
 * @returns {boolean}
 */
function stretchRows(options, mode, table = SRCCOPY_TABLE){
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
    const src = /** @type {any} */ (options.src);
    const target = stretchTarget(dest, options.clip, options.x, options.y,
        options.width, options.height);
    if (isEmptyRect(target))
    {
        return true;
    }
    const visible = intersectRect(
        { left: srcLeft, top: srcTop, right: srcLeft + srcWidth, bottom: srcTop + srcHeight },
        surfaceBounds(src));
    if (isEmptyRect(visible))
    {
        return false;
    }
    // Each destination column's box within the visible row, [from, to); from
    // -1 where the box misses the source.
    const span = target.right - target.left;
    const fromX = new Int32Array(span);
    const toX = new Int32Array(span);
    for (let x = target.left; x < target.right; x++)
    {
        const column = mirrorX ? destWidth - 1 - (x - destLeft) : x - destLeft;
        const left = srcLeft + Math.floor((column * srcWidth) / destWidth);
        const right = Math.max(left + 1,
            srcLeft + Math.floor(((column + 1) * srcWidth) / destWidth));
        const from = Math.max(left, visible.left);
        const to = Math.min(right, visible.right);
        fromX[x - target.left] = from < to ? from - visible.left : -1;
        toX[x - target.left] = to - visible.left;
    }
    const width = visible.right - visible.left;
    /** @type {Uint32Array[]} */
    const rows = [];
    /** The source rows `rows` holds, from `loadedTop`. */
    let loadedTop = -1;
    let loadedCount = 0;
    const words = /** @type {Uint32Array} */ (dest.words);
    const pitchWords = dest.pitch >>> 2;
    for (let y = target.top; y < target.bottom; y++)
    {
        const line = mirrorY ? destHeight - 1 - (y - destTop) : y - destTop;
        const top = srcTop + Math.floor((line * srcHeight) / destHeight);
        const bottom = Math.max(top + 1,
            srcTop + Math.floor(((line + 1) * srcHeight) / destHeight));
        const fromY = Math.max(top, visible.top);
        const toY = Math.min(bottom, visible.bottom);
        if (fromY >= toY)
        {
            continue;
        }
        const count = toY - fromY;
        if (fromY !== loadedTop || count !== loadedCount)
        {
            for (let k = 0; k < count; k++)
            {
                rows[k] ??= new Uint32Array(width);
                src.readRow(fromY + k, visible.left, width, rows[k], 0);
            }
            loadedTop = fromY;
            loadedCount = count;
        }
        const base = (dest.topDown ? y : dest.height - 1 - y) * pitchWords + target.left;
        for (let i = 0; i < span; i++)
        {
            const from = fromX[i];
            if (from < 0)
            {
                continue;
            }
            const folded = foldBox(rows, count, from, toX[i], mode);
            words[base + i] = table === SRCCOPY_TABLE ? folded
                : applyRop(table, 0, folded, words[base + i]);
        }
    }
    return true;
}

/**
 * The pixels of a box of rows folded as `combine` folds them, from rows
 * already read: the first for COLORONCOLOR, the average for HALFTONE, AND
 * for BLACKONWHITE and OR for WHITEONBLACK.
 *
 * @param {Uint32Array[]} rows @param {number} count  the box's rows
 * @param {number} from @param {number} to  the box's columns in each row
 * @param {number} mode
 * @returns {number}
 */
function foldBox(rows, count, from, to, mode){
    if (mode === COLORONCOLOR || (count === 1 && to - from === 1 && mode !== HALFTONE))
    {
        return rows[0][from];
    }
    if (mode === HALFTONE)
    {
        let red = 0;
        let green = 0;
        let blue = 0;
        for (let k = 0; k < count; k++)
        {
            const row = rows[k];
            for (let x = from; x < to; x++)
            {
                const pixel = row[x];
                red += (pixel >>> 16) & 0xff;
                green += (pixel >>> 8) & 0xff;
                blue += pixel & 0xff;
            }
        }
        const pixels = count * (to - from);
        return ((Math.round(red / pixels) << 16) | (Math.round(green / pixels) << 8)
            | Math.round(blue / pixels)) >>> 0;
    }
    let value = mode === BLACKONWHITE ? 0xffffffff : 0;
    for (let k = 0; k < count; k++)
    {
        const row = rows[k];
        for (let x = from; x < to; x++)
        {
            value = mode === BLACKONWHITE ? (value & row[x]) : (value | row[x]);
        }
    }
    return value >>> 0;
}

/**
 * @param {StretchOptions} options
 * @returns {boolean} what StretchBlt reports
 */
export function stretchBlt(options){
    const table = ropTable(options.rop);
    const mode = options.mode ?? BLACKONWHITE;
    const usesPattern = ropUsesPattern(table);
    const pattern = options.pattern;
    const convert = options.convert ?? null;
    const dest = options.dest;
    // A copy of any scale, a row at a time: the source's rows into the
    // destination's words, each box folded from rows read once, not a box
    // read a pixel at a time -- a menu's background shrunk to its window took
    // a frame to itself.
    const declined = usesPattern ? 'pattern' : convert ? 'conversion'
        : !dest.words ? 'destination has no words'
            : !options.src?.readRow ? 'source reads no rows'
                : options.src.bytes === dest.bytes ? 'one memory' : null;
    if (declined === null)
    {
        blitPaths.rows++;
        return stretchRows(options, mode, table);
    }
    tookPixels(`stretch: ${declined}; to ${shapeOf(dest)}, from ${shapeOf(options.src)}`);
    return stretchEach(options, (x, y, src, left, top, right, bottom)=>{
        const p = usesPattern && pattern ? pattern(x, y) : 0;
        if (p === TRANSPARENT_PIXEL)
        {
            return;
        }
        const combined = combine(src, left, top, right, bottom, mode);
        const s = convert ? convert(combined) : combined;
        dest.write(x, y, applyRop(table, p, s, dest.read(x, y)));
    });
}

/**
 * @typedef {StretchGeometry & {
 *     key: number,
 *     convert?: ((pixel: number) => number) | null }} TransparentBltOptions
 *     `key` is the transparent colour as the source stores it, 0x00RRGGBB;
 *     `convert` is BitBlt's.
 */

/**
 * TransparentBlt: the source stretched over the destination, its pixels of
 * the key colour left out. Each destination pixel takes one source pixel --
 * folding a box of them together would make colours that are neither the key
 * nor the picture -- and only the colour's three bytes are compared: a 32-bit
 * source's unused byte is not part of it (Wine's test_GdiTransparentBlt).
 *
 * @param {TransparentBltOptions} options
 * @returns {boolean}
 */
export function transparentBlt(options){
    const key = (options.key & 0xffffff) >>> 0;
    const convert = options.convert ?? null;
    const dest = options.dest;
    return stretchEach(options, (x, y, src, left, top)=>{
        const read = src.read(left, top);
        if (((read & 0xffffff) >>> 0) !== key)
        {
            dest.write(x, y, convert ? convert(read) : read);
        }
    });
}

/**
 * A channel scaled by an alpha: `value * alpha / 255`, with the rounding
 * Windows answers with in Wine's test_32bit_ddb.
 *
 * @param {number} value @param {number} alpha
 * @returns {number}
 */
const scaled = (value, alpha)=>Math.floor((value * alpha + 127) / 255);

/**
 * One pixel of AlphaBlend, all four bytes of it, as MSDN gives the sums.
 *
 * Without a per-pixel alpha each byte is the source's and the destination's
 * weighted by the constant alpha. With one the source is premultiplied: its
 * bytes, its alpha among them, are first scaled by the constant alpha, and
 * the destination keeps what that alpha leaves of it. A sum past 255 -- a
 * source that was not premultiplied -- saturates rather than wrapping into
 * another colour.
 *
 * @param {number} source @param {number} destination  0xAARRGGBB.
 * @param {number} constant  SourceConstantAlpha, 0 to 255.
 * @param {boolean} perPixel  AC_SRC_ALPHA.
 * @returns {number}
 */
export function blendPixel(source, destination, constant, perPixel){
    const alpha = perPixel ? scaled(source >>> 24, constant) : constant;
    let out = 0;
    for (let shift = 0; shift < 32; shift += 8)
    {
        const s = (source >>> shift) & 0xff;
        const d = (destination >>> shift) & 0xff;
        out |= (perPixel
            ? Math.min(255, scaled(s, constant) + scaled(d, 255 - alpha))
            : Math.floor((s * constant + d * (255 - constant) + 127) / 255)) << shift;
    }
    return out >>> 0;
}

/**
 * @typedef {StretchGeometry & {
 *     constantAlpha: number,
 *     perPixel?: boolean,
 *     convert?: ((pixel: number) => number) | null }} AlphaBlendOptions
 *     `constantAlpha` and `perPixel` are the BLENDFUNCTION's SourceConstantAlpha
 *     and AC_SRC_ALPHA; `convert` is BitBlt's.
 */

/**
 * AlphaBlend: the source stretched over the destination and blended into it.
 * A stretch takes one source pixel per destination pixel whatever the
 * context's stretch mode, which MSDN says is COLORONCOLOR for this call.
 *
 * @param {AlphaBlendOptions} options
 * @returns {boolean}
 */
export function alphaBlend(options){
    const constant = options.constantAlpha & 0xff;
    const perPixel = options.perPixel === true;
    const convert = options.convert ?? null;
    const dest = options.dest;
    return stretchEach(options, (x, y, src, left, top)=>{
        const read = src.read(left, top);
        dest.write(x, y, blendPixel(convert ? convert(read) : read, dest.read(x, y), constant,
            perPixel));
    });
}

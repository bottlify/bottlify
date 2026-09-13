/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Text output, without a font engine behind it.
 *
 * **The glyph shapes are a stand-in and the positions are not.** Every
 * character is drawn from one five-by-seven pixel face, scaled by whole
 * numbers to the cell the metrics describe; a character the face has no
 * picture for is a solid block. What is real is where each one goes: the
 * alignment the program set, the origin it named, the advance widths it
 * supplied, the background it asked for and the colours it chose. A user
 * interface laid out against those numbers is usable, and replacing the face
 * with a rasterised font later moves nothing -- which is the whole reason to
 * separate the two now rather than wait for a rasteriser.
 *
 * The measurements arrive injected. The bookkeeping half is what a program asks
 * for its font metrics, and a second estimator here would be a second answer to
 * a question that already has one.
 */

import { OPAQUE } from './brush.js';
import { colorToPixel } from './surface.js';
import { fillRect } from './shapes.js';
import { GLYPH_COLUMNS, GLYPH_ROWS, glyphOf } from './glyphs.js';

/** SetTextAlign flags. The horizontal and vertical choices are separate fields. */
export const TA_NOUPDATECP = 0;
export const TA_UPDATECP = 1;
export const TA_LEFT = 0;
export const TA_RIGHT = 2;
export const TA_CENTER = 6;
export const TA_TOP = 0;
export const TA_BOTTOM = 8;
export const TA_BASELINE = 24;

const HORIZONTAL_MASK = 6;
const VERTICAL_MASK = 24;

/** ExtTextOut option flags. */
export const ETO_OPAQUE = 0x0002;
export const ETO_CLIPPED = 0x0004;

/**
 * @param {string} text
 * @param {import("./contract.js").TextMetrics} metrics
 * @param {number[]} [dx]   Per-character advances, as ExtTextOut takes them.
 * @returns {number} how wide the string is, in pixels
 */
export function textExtent(text, metrics, dx){
    if (!dx || dx.length === 0)
    {
        return text.length * metrics.cellWidth;
    }
    let total = 0;
    for (let index = 0; index < text.length; index++)
    {
        total += dx[index] ?? metrics.cellWidth;
    }
    return total;
}

/**
 * @typedef {Object} TextOptions
 * @property {number} x
 * @property {number} y
 * @property {string} text
 * @property {import("./contract.js").TextMetrics} metrics
 * @property {number} textColor
 * @property {number} bkColor
 * @property {number} bkMode
 * @property {number} [align]
 * @property {number} [flags]
 * @property {import("./contract.js").Rect} [rect]
 * @property {number[]} [dx]
 */

/**
 * @param {import("./shapes.js").Painter} painter
 * @param {TextOptions} options
 * @returns {{ ok: boolean, width: number }} the advance, for TA_UPDATECP
 */
export function extTextOut(painter, options){
    const align = options.align ?? 0;
    const flags = options.flags ?? 0;
    const metrics = options.metrics;
    const width = textExtent(options.text, metrics, options.dx);

    // The reference point names a different corner depending on the alignment,
    // so the box is derived from it rather than the other way round.
    const horizontal = align & HORIZONTAL_MASK;
    const left = horizontal === TA_RIGHT
        ? (options.x | 0) - width
        : (horizontal === TA_CENTER ? (options.x | 0) - Math.floor(width / 2) : options.x | 0);
    const vertical = align & VERTICAL_MASK;
    const top = vertical === TA_BOTTOM
        ? (options.y | 0) - metrics.cellHeight
        : (vertical === TA_BASELINE ? (options.y | 0) - metrics.ascent : options.y | 0);

    // ETO_CLIPPED narrows the clip for this call only; the painter's own clip
    // still applies, so the two intersect rather than one replacing the other.
    const clipped = (flags & ETO_CLIPPED) !== 0 && options.rect
        ? painter.narrow(options.rect)
        : painter;

    if ((flags & ETO_OPAQUE) !== 0 && options.rect)
    {
        // ETO_OPAQUE fills the caller's rectangle whatever the background mode
        // says: the flag is the request, and the mode is not consulted.
        fillRect(clipped, options.rect, ()=>colorToPixel(options.bkColor));
    }
    else if (options.bkMode === OPAQUE)
    {
        fillRect(clipped, {
            left,
            top,
            right: left + width,
            bottom: top + metrics.cellHeight,
        }, ()=>colorToPixel(options.bkColor));
    }

    const ink = colorToPixel(options.textColor);
    // The face is scaled by the largest whole number that keeps it inside
    // the cell, with a column and a row of the cell left bare so adjacent
    // characters stay apart, and its last row sits on the baseline.
    const scale = Math.max(1, Math.min(
        Math.floor((metrics.cellWidth - 1) / GLYPH_COLUMNS),
        Math.floor((metrics.ascent - 1) / GLYPH_ROWS)));
    const glyphTop = top + Math.max(1, metrics.ascent - GLYPH_ROWS * scale);
    const bodyWidth = Math.max(1, metrics.cellWidth - 1);
    const bodyHeight = Math.max(1, metrics.ascent - 1);
    let pen = left;
    for (let index = 0; index < options.text.length; index++)
    {
        const advance = options.dx?.[index] ?? metrics.cellWidth;
        const code = options.text.charCodeAt(index);
        const rows = glyphOf(code);
        if (rows)
        {
            for (let row = 0; row < GLYPH_ROWS; row++)
            {
                for (let column = 0; column < GLYPH_COLUMNS; column++)
                {
                    if ((rows[row] & (1 << (GLYPH_COLUMNS - 1 - column))) !== 0)
                    {
                        fillRect(clipped, {
                            left: pen + column * scale,
                            top: glyphTop + row * scale,
                            right: pen + (column + 1) * scale,
                            bottom: glyphTop + (row + 1) * scale,
                        }, ()=>ink);
                    }
                }
            }
        }
        else if (code !== 0x20)
        {
            fillRect(clipped, {
                left: pen,
                top: top + 1,
                right: pen + Math.min(bodyWidth, advance),
                bottom: top + 1 + bodyHeight,
            }, ()=>ink);
        }
        pen += advance;
    }
    return { ok: true, width };
}

/**
 * TextOutA is ExtTextOutA with no flags, no rectangle and no advance array.
 *
 * @param {import("./shapes.js").Painter} painter
 * @param {TextOptions} options
 * @returns {{ ok: boolean, width: number }}
 */
export function textOut(painter, options){
    return extTextOut(painter, { ...options, flags: 0, rect: undefined, dx: undefined });
}

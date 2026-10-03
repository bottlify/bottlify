/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Text output.
 *
 * The glyphs come from the font engine when the metrics carry one: each
 * character's coverage is composited in the text colour at its advance.
 * Without an engine every character is drawn from one five-by-seven pixel
 * face, scaled by whole numbers to the cell the metrics describe, and a
 * character the face has no picture for is a solid block. The positions are
 * the same either way: the alignment the program set, the origin it named,
 * the advance widths it supplied, the background it asked for and the
 * colours it chose -- which is why the two faces share everything but the
 * innermost loop.
 *
 * The measurements arrive injected. The bookkeeping half is what a program asks
 * for its font metrics, and a second estimator here would be a second answer to
 * a question that already has one.
 */

import { OPAQUE, solidPattern } from './brush.js';
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
    if ((!dx || dx.length === 0) && !metrics.glyphs)
    {
        return text.length * metrics.cellWidth;
    }
    let total = 0;
    for (let index = 0; index < text.length; index++)
    {
        total += dx?.[index] ?? advanceOf(text.charCodeAt(index), metrics);
    }
    return total;
}

/**
 * @param {number} code
 * @param {import("./contract.js").TextMetrics} metrics
 * @returns {number}
 */
function advanceOf(code, metrics){
    return metrics.glyphs?.(code)?.advance ?? metrics.cellWidth;
}

/**
 * A pixel of the text colour over what is there, by the glyph's coverage.
 * The unused byte of both is zero, so a channel-wise mix keeps it zero.
 *
 * @param {number} ink @param {number} under @param {number} alpha
 * @returns {number}
 */
function mix(ink, under, alpha){
    const inverse = 255 - alpha;
    let pixel = 0;
    for (let shift = 0; shift < 24; shift += 8)
    {
        const channel = ((ink >>> shift) & 0xff) * alpha + ((under >>> shift) & 0xff) * inverse;
        pixel |= (((channel + 127) / 255) | 0) << shift;
    }
    return pixel >>> 0;
}

/**
 * Composites one glyph's coverage at the pen. Fully covered pixels go
 * through the painter as any other ink does; partly covered ones are mixed
 * with what is under them first, which is what anti-aliasing is.
 *
 * @param {import("./shapes.js").Painter} painter
 * @param {import("./fonts.js").Glyph} glyph
 * @param {number} x   The pen.
 * @param {number} y   The top of the cell.
 * @param {number} ink
 */
function compositeGlyph(painter, glyph, x, y, ink){
    const { clip, surface } = painter;
    for (let row = 0; row < glyph.height; row++)
    {
        const at = y + glyph.top + row;
        if (at < clip.top || at >= clip.bottom)
        {
            continue;
        }
        for (let column = 0; column < glyph.width; column++)
        {
            const alpha = glyph.coverage[row * glyph.width + column];
            const across = x + glyph.left + column;
            if (alpha === 0 || across < clip.left || across >= clip.right)
            {
                continue;
            }
            painter.plot(across, at,
                alpha === 255 ? ink : mix(ink, surface.read(across, at), alpha));
        }
    }
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
        fillRect(clipped, options.rect, solidPattern(options.bkColor));
    }
    else if (options.bkMode === OPAQUE)
    {
        fillRect(clipped, {
            left,
            top,
            right: left + width,
            bottom: top + metrics.cellHeight,
        }, solidPattern(options.bkColor));
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
        const code = options.text.charCodeAt(index);
        const advance = options.dx?.[index] ?? advanceOf(code, metrics);
        const glyph = metrics.glyphs?.(code);
        const rows = glyph ? null : glyphOf(code);
        if (glyph)
        {
            compositeGlyph(clipped, glyph, pen, top, ink);
        }
        else if (rows)
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

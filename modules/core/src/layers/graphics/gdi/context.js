/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Giving a device context pixels, and the calls that then draw into them.
 *
 * The bookkeeping half already owns a device context record: which pen, brush
 * and font are selected, the text and background colours, the background mode,
 * the binary raster operation, the current position. That record is reachable
 * from an HDC through the process handle table, and it is passed in here rather
 * than copied -- two records for one device context is two answers to
 * "what colour is the text", and they diverge the first time one setter is
 * routed to only one of them.
 *
 * What this half adds is the part the other one has no place for: the pixels,
 * the clip, the stretch mode, the text alignment and the brush origin. None of
 * those mean anything until something draws.
 *
 * The clip is a rectangle, or a list of rectangles that never overlap when a
 * program has cut a hole in it: a draw is then made once inside each of them,
 * which touches every pixel of the region once and nothing outside it.
 *
 * A DirectDraw surface's `GetDC` is the same mechanism with a different owner:
 * DirectDraw mints the handle and this layer gives it the surface's own bytes.
 * There is no staging copy, so a drawing operation is visible to the surface's
 * own reads immediately and `ReleaseDC` has nothing to flush -- if a surface
 * that lives on the device ever needs one, `release` is the single place it
 * goes.
 */

import { BS_SOLID, OPAQUE, createPattern, solidPattern } from './brush.js';
import {
    BLACKONWHITE, STRETCH_MODES, alphaBlend, bitBlt, patBlt, sourceConversion, stretchBlt,
    transparentBlt,
} from './blit.js';
import { DSTINVERT, PATCOPY, PATINVERT, R2_COPYPEN } from './rop.js';
import {
    PS_SOLID, createPainter, ellipse, fillRect, frameRect, line, polyPolygon, polygon, rectangle,
} from './shapes.js';
import { MONOCHROME, colorToPixel, intersectRect, isEmptyRect, pixelToColor, surfaceBounds }
    from './surface.js';
import { encodeDib, setDIBitsToDevice, stretchDIBits } from './dib.js';
import { extTextOut, textExtent } from './text.js';
import { FLOODFILLSURFACE, floodFill } from './flood.js';
import { gradientFill } from './gradient.js';
import { paletteEntryToPixel } from '../../win32/gdi32/structs.js';

/** What a call that should have returned a COLORREF says when it failed. */
export const CLR_INVALID = 0xffffffff;

/** The white a device context starts its background at. */
const WHITE = 0x00ffffff;

/** Metrics for a context nobody told about a font. */
const FALLBACK_METRICS = Object.freeze({ cellWidth: 8, cellHeight: 16, ascent: 12 });

/** What a context draws with when the object table has no entry for the handle. */
const DEFAULT_PEN = Object.freeze({ style: PS_SOLID, width: 1, color: 0 });
const DEFAULT_BRUSH = Object.freeze({ style: BS_SOLID, color: WHITE, hatch: 0 });

/**
 * The drawing state of a device context that has none of its own -- a surface
 * bound outside the win32 half, which is what a DirectDraw GetDC is.
 *
 * @returns {any}
 */
function defaultState(){
    return {
        pen: 0,
        brush: 0,
        font: 0,
        textColor: 0,
        bkColor: WHITE,
        bkMode: OPAQUE,
        rop2: R2_COPYPEN,
        textAlign: 0,
        position: { x: 0, y: 0 },
    };
}

/**
 * @typedef {Object} GdiObjectTable
 * @property {(handle: number) => import("../../win32/gdi32/objects.js").GdiObject | null} get
 */

/**
 * @typedef {Object} DrawingOptions
 * @property {GdiObjectTable} [objects]
 *           The bookkeeping half's object table, so a pen handle resolves to
 *           the pen the program created rather than to a second copy of it.
 * @property {(font: number) => import("./contract.js").TextMetrics} [metrics]
 *           What the bookkeeping half reports for the selected font.
 * @property {import("./fonts.js").FontEngine} [fonts]
 *           Where glyphs come from. Without one, or with one that has no
 *           canvas, text is drawn from the built-in pixel face.
 */

/**
 * @param {DrawingOptions} [options]
 */
export function createGdiDrawing(options = {}){
    const objects = options.objects ?? { get: ()=>null };
    const measure = options.metrics ?? (()=>FALLBACK_METRICS);
    const fonts = options.fonts?.available ? options.fonts : null;
    /** @type {Map<number, any>} */
    const contexts = new Map();

    /** @param {number} hdc @returns {any | null} */
    const contextOf = hdc=>contexts.get(hdc >>> 0) ?? null;

    /** @param {any} context @returns {import("./shapes.js").Painter} */
    const painterOf = context=>createPainter(context.surface, context.clip, context.state.rop2);

    /**
     * Makes a draw under a context's clip: once, or once inside each piece of
     * a clip that is a region, `context.clip` that piece meanwhile. The answer
     * is the largest any piece gave -- a draw that landed in one piece landed.
     * A blit from the same pixels it writes reads its source before any
     * piece's write could have reached it when the pieces are taken in the
     * direction the picture moves, a scroll down from the bottom piece up.
     *
     * @template T
     * @param {any} context
     * @param {() => T} draw
     * @param {{ x: number, y: number }} [moving]  How far a blit moves its source.
     * @returns {T}
     */
    const clipped = (context, draw, moving)=>{
        const pieces = context.clipRects;
        if (pieces === null)
        {
            return draw();
        }
        const ordered = moving && (moving.x > 0 || moving.y > 0)
            ? [...pieces].sort((a, b)=>(moving.y > 0 ? b.top - a.top : a.top - b.top)
                || (moving.x > 0 ? b.left - a.left : a.left - b.left))
            : pieces;
        const whole = context.clip;
        /** @type {any} */
        let answer;
        try
        {
            ordered.forEach((/** @type {any} */ piece, /** @type {number} */ index)=>{
                context.clip = piece;
                const result = draw();
                if (index === 0 || result > answer)
                {
                    answer = result;
                }
            });
        }
        finally
        {
            context.clip = whole;
        }
        return answer;
    };

    /**
     * A COLORREF as the plain colour it names on this context. PALETTEINDEX
     * is an entry of the logical palette selected into the DC, an index
     * past its end the first; DIBINDEX is an entry of the colour table of
     * the bitmap being drawn on, one it does not have black (Wine's bitmap.c
     * test_dibsections and palette.c test_DIB_PAL_COLORS); the PALETTERGB
     * flag only asks for the nearest colour, which every colour gets.
     *
     * @param {any} context @param {number} color
     * @returns {number} a COLORREF with nothing in its top byte
     */
    const resolveColor = (context, color)=>{
        const value = color >>> 0;
        if ((value & 0xffff0000) >>> 0 === 0x10ff0000)
        {
            const table = context.surface.palette;
            const pixel = table ? table[value & 0xffff] : undefined;
            return pixel === undefined ? 0 : pixelToColor(pixel);
        }
        if (value >>> 24 === 0x01)
        {
            const record = objects.get(context.state.palette ?? 0);
            const entries = record && record.type === 'palette' ? record.attributes.entries : [];
            return ((entries[value & 0xffff] ?? entries[0] ?? 0) & 0x00ffffff) >>> 0;
        }
        return value & 0x00ffffff;
    };

    /** @param {any} context @returns {import("./shapes.js").Pen} */
    const penOf = context=>{
        const record = objects.get(context.state.pen);
        const pen = record && record.type === 'pen' ? record.attributes : DEFAULT_PEN;
        const color = resolveColor(context, pen.color);
        return { ...pen,
            color: context.surface.mono === true ? monoPenColor(context, color) : color };
    };

    /**
     * A pen's colour on a monochrome device bitmap is not its nearest one.
     * With the DC's text colour black or its background white, the pen is
     * black unless it is exactly white or exactly the background; with
     * both the other way, it is black only when it is black or the
     * background (Wine's bitmap.c test_mono_bitmap, is_black_pen).
     *
     * @param {any} context @param {number} color  A plain COLORREF.
     */
    const monoPenColor = (context, color)=>{
        const text = resolveColor(context, context.state.textColor);
        const background = resolveColor(context, context.state.bkColor);
        const black = text === 0 || background === WHITE
            ? color !== WHITE && color !== background
            : color === 0 || color === background;
        return black ? 0 : WHITE;
    };

    /**
     * @param {any} context
     * @param {number} [handle]   A brush the call named, rather than the selected one.
     * @returns {import("./contract.js").PatternSource}
     */
    const patternOf = (context, handle)=>{
        const record = objects.get(handle ?? context.state.brush);
        const attributes = record && record.type === 'brush' ? record.attributes : DEFAULT_BRUSH;
        return createPattern({
            attributes: attributes.color === undefined ? attributes
                : { ...attributes, color: resolveColor(context, attributes.color) },
            bkMode: context.state.bkMode,
            bkColor: resolveColor(context, context.state.bkColor),
            textColor: resolveColor(context, context.state.textColor),
            mono: context.surface.mono === true,
            origin: context.brushOrigin,
            paletteColors: ()=>{
                const palette = objects.get(context.state.palette ?? 0);
                return palette && palette.type === 'palette'
                    ? palette.attributes.entries.map(paletteEntryToPixel)
                    : [];
            },
        });
    };

    /**
     * @param {any} context  The destination.
     * @param {any} from     The source.
     */
    const conversionOf = (context, from)=>sourceConversion({
        src: from.surface,
        dest: context.surface,
        textColor: resolveColor(context, context.state.textColor),
        bkColor: resolveColor(context, context.state.bkColor),
        srcBkColor: resolveColor(from, from.state.bkColor),
    });

    /**
     * The stretch mode is the device context's, kept on its record with the
     * rest of what SaveDC remembers: a copy on the drawing context would be
     * lost when a bitmap selected rebinds the pixels.
     *
     * @param {any} context
     */
    const stretchModeOf = context=>context.state.stretchMode ?? BLACKONWHITE;

    /** @param {any} context @returns {import("./contract.js").TextMetrics} */
    const metricsOf = context=>{
        const cell = measure(context.state.font);
        if (!fonts)
        {
            return cell;
        }
        // The engine is asked for the font the program selected; a context
        // with no font record -- one bound outside win32 -- gets its default.
        const record = objects.get(context.state.font);
        const font = record && record.type === 'font' ? record.attributes : null;
        return { ...cell, glyphs: code=>fonts.glyph(code, font) };
    };

    return {
        /**
         * Gives a device context handle the pixels it draws into.
         *
         * @param {number} hdc
         * @param {import("./contract.js").Surface} surface
         * @param {any} [state]   The bookkeeping half's own record for this HDC.
         * @returns {any} the drawing context
         */
        bind(hdc, surface, state){
            const context = {
                hdc: hdc >>> 0,
                surface,
                state: state ?? defaultState(),
                clip: surfaceBounds(surface),
                /** The pieces of a clip that is not one rectangle; null when it is. */
                clipRects: null,
                brushOrigin: { x: 0, y: 0 },
            };
            contexts.set(context.hdc, context);
            return context;
        },

        /**
         * @param {number} hdc
         * @returns {import("./contract.js").Surface | null} the surface it had
         */
        release(hdc){
            const context = contextOf(hdc);
            contexts.delete(hdc >>> 0);
            return context ? context.surface : null;
        },

        contextOf,

        /** @returns {number} how many contexts have pixels, for diagnostics */
        count: ()=>contexts.size,

        /**
         * Clips to one rectangle: a DirectDraw clipper, the client area of a
         * window, the part of it a paint is limited to.
         *
         * @param {number} hdc
         * @param {import("./contract.js").Rect} rect
         * @returns {boolean}
         */
        setClipRect(hdc, rect){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            context.clip = intersectRect(rect, surfaceBounds(context.surface));
            context.clipRects = null;
            return true;
        },

        /**
         * Clips to a region, given as rectangles that do not overlap: what is
         * left of a clip a program cut a hole in with ExcludeClipRect.
         *
         * @param {number} hdc
         * @param {import("./contract.js").Rect[]} rects
         * @returns {boolean}
         */
        setClipRegion(hdc, rects){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const bounds = surfaceBounds(context.surface);
            const pieces = rects.map(rect=>intersectRect(rect, bounds))
                .filter(rect=>!isEmptyRect(rect));
            if (pieces.length <= 1)
            {
                return this.setClipRect(hdc, pieces[0] ?? { left: 0, top: 0, right: 0, bottom: 0 });
            }
            context.clip = pieces.reduce((box, piece)=>({
                left: Math.min(box.left, piece.left),
                top: Math.min(box.top, piece.top),
                right: Math.max(box.right, piece.right),
                bottom: Math.max(box.bottom, piece.bottom),
            }));
            context.clipRects = pieces;
            return true;
        },

        /** @param {number} hdc @param {number} mode @returns {number} the previous mode */
        setStretchBltMode(hdc, mode){
            const context = contextOf(hdc);
            if (!context || !STRETCH_MODES.includes(mode | 0))
            {
                return 0;
            }
            const previous = stretchModeOf(context);
            context.state.stretchMode = mode | 0;
            return previous;
        },

        /** @param {number} hdc @returns {number} */
        getStretchBltMode(hdc){
            const context = contextOf(hdc);
            return context ? stretchModeOf(context) : 0;
        },

        /** @param {number} hdc @param {number} align @returns {number} the previous value */
        setTextAlign(hdc, align){
            const context = contextOf(hdc);
            if (!context)
            {
                return CLR_INVALID;
            }
            const previous = context.state.textAlign;
            context.state.textAlign = align >>> 0;
            return previous;
        },

        /** @param {number} hdc @returns {number} */
        getTextAlign(hdc){
            return contextOf(hdc)?.state.textAlign ?? CLR_INVALID;
        },

        /**
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @returns {boolean}
         */
        setBrushOrgEx(hdc, x, y){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            context.brushOrigin = { x: x | 0, y: y | 0 };
            return true;
        },

        /**
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @param {number} color
         * @returns {number} the colour actually set, or CLR_INVALID
         */
        setPixel(hdc, x, y, color){
            const context = contextOf(hdc);
            const point = { left: x | 0, top: y | 0, right: (x | 0) + 1, bottom: (y | 0) + 1 };
            if (!context || (context.clipRects ?? [context.clip])
                .every((/** @type {any} */ piece)=>isEmptyRect(intersectRect(piece, point))))
            {
                return CLR_INVALID;
            }
            // SetPixel is not subject to the binary raster operation: it names
            // the colour it wants and gets it.
            context.surface.write(x | 0, y | 0, colorToPixel(resolveColor(context, color)));
            // The colour the pixel became, which on a palette or a
            // monochrome bitmap is the nearest one it has.
            return pixelToColor(context.surface.read(x | 0, y | 0));
        },

        /**
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @returns {number} a COLORREF, or CLR_INVALID outside the surface
         */
        getPixel(hdc, x, y){
            const context = contextOf(hdc);
            if (!context || x < 0 || y < 0
                || x >= context.surface.width || y >= context.surface.height)
            {
                return CLR_INVALID;
            }
            return pixelToColor(context.surface.read(x | 0, y | 0));
        },

        /**
         * @param {number} hdc
         * @param {number} color
         * @returns {number} the COLORREF a SetPixel of `color` would read back
         *          as, or CLR_INVALID for a context there is not
         */
        nearestColor(hdc, color){
            const context = contextOf(hdc);
            if (!context)
            {
                return CLR_INVALID;
            }
            const pixel = colorToPixel(resolveColor(context, color));
            return pixelToColor(context.surface.nearest ? context.surface.nearest(pixel) : pixel);
        },

        /**
         * BOOL BitBlt(HDC, int, int, int, int, HDC, int, int, DWORD)
         *
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         * @param {number} source     The source HDC, or zero for a pattern-only operation.
         * @param {number} srcX
         * @param {number} srcY
         * @param {number} rop
         * @returns {boolean}
         */
        bitBlt(hdc, x, y, width, height, source, srcX, srcY, rop){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const from = contextOf(source);
            return clipped(context, ()=>bitBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                src: from ? from.surface : undefined,
                srcX, srcY,
                rop,
                pattern: patternOf(context),
                convert: from ? conversionOf(context, from) : null,
            }), { x: x - srcX, y: y - srcY });
        },

        /**
         * BOOL StretchBlt(HDC, int, int, int, int, HDC, int, int, int, int, DWORD)
         *
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         * @param {number} source
         * @param {number} srcX
         * @param {number} srcY
         * @param {number} srcWidth
         * @param {number} srcHeight
         * @param {number} rop
         * @returns {boolean}
         */
        stretchBlt(hdc, x, y, width, height, source, srcX, srcY, srcWidth, srcHeight, rop){
            const context = contextOf(hdc);
            const from = contextOf(source);
            if (!context || !from)
            {
                return false;
            }
            return clipped(context, ()=>stretchBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                src: from.surface,
                srcX, srcY, srcWidth, srcHeight,
                rop,
                mode: stretchModeOf(context),
                pattern: patternOf(context),
                convert: conversionOf(context, from),
            }), { x: x - srcX, y: y - srcY });
        },

        /**
         * BOOL MaskBlt(HDC, int, int, int, int, HDC, int, int, HBITMAP, int, int, DWORD)
         *
         * BitBlt with two raster operations, chosen pixel by pixel by a
         * monochrome bitmap laid over the destination from the mask's own
         * corner: a set bit takes the operation `rop` names, a clear one the
         * background operation in its high byte. A pixel past the mask's edge
         * has no bit, and takes the background operation.
         *
         * @param {number} hdc @param {number} x @param {number} y
         * @param {number} width @param {number} height
         * @param {number} source  The source HDC, or zero when neither operation reads one.
         * @param {number} srcX @param {number} srcY
         * @param {number} mask  A context with the mask bitmap's pixels.
         * @param {number} maskX @param {number} maskY
         * @param {number} rop  MAKEROP4 of the two.
         * @returns {boolean}
         */
        maskBlt(hdc, x, y, width, height, source, srcX, srcY, mask, maskX, maskY, rop){
            const context = contextOf(hdc);
            const bits = contextOf(mask);
            if (!context || !bits)
            {
                return false;
            }
            const from = contextOf(source);
            const picture = /** @type {any} */ (bits.surface);
            // A bit is set where the pixel is the colour a 1 means: white in a
            // monochrome bitmap, the second entry of a one-bit section's table.
            const one = ((picture.palette?.[1] ?? MONOCHROME[1]) & 0xffffff) >>> 0;
            const shiftX = (maskX | 0) - (x | 0);
            const shiftY = (maskY | 0) - (y | 0);
            /** @param {number} px @param {number} py */
            const set = (px, py)=>{
                const mx = px + shiftX;
                const my = py + shiftY;
                return mx >= 0 && my >= 0 && mx < picture.width && my < picture.height
                    && ((picture.read(mx, my) & 0xffffff) >>> 0) === one;
            };
            return clipped(context, ()=>bitBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                src: from ? from.surface : undefined,
                srcX, srcY,
                rop,
                pattern: patternOf(context),
                convert: from ? conversionOf(context, from) : null,
                mask: set,
            }), { x: x - srcX, y: y - srcY });
        },

        /**
         * BOOL GdiAlphaBlend(HDC, int, int, int, int, HDC, int, int, int, int, BLENDFUNCTION)
         *
         * The rectangles are the device's, each extent with its sign; the
         * caller has checked them against the source.
         *
         * @param {number} hdc @param {number} x @param {number} y
         * @param {number} width @param {number} height
         * @param {number} source
         * @param {number} srcX @param {number} srcY
         * @param {number} srcWidth @param {number} srcHeight
         * @param {{ constantAlpha: number, perPixel: boolean }} blend
         * @returns {boolean}
         */
        alphaBlend(hdc, x, y, width, height, source, srcX, srcY, srcWidth, srcHeight, blend){
            const context = contextOf(hdc);
            const from = contextOf(source);
            if (!context || !from)
            {
                return false;
            }
            return clipped(context, ()=>alphaBlend({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                src: from.surface,
                srcX, srcY, srcWidth, srcHeight,
                constantAlpha: blend.constantAlpha,
                perPixel: blend.perPixel,
                convert: conversionOf(context, from),
            }));
        },

        /**
         * BOOL GdiTransparentBlt(HDC, int, int, int, int, HDC, int, int, int, int, UINT)
         *
         * The rectangles are the device's, as AlphaBlend's are. The key is a
         * COLORREF, compared as the source would store it: a 16-bit or
         * indexed source cannot hold every colour, and its pixels of the key
         * hold the nearest one it can.
         *
         * @param {number} hdc @param {number} x @param {number} y
         * @param {number} width @param {number} height
         * @param {number} source
         * @param {number} srcX @param {number} srcY
         * @param {number} srcWidth @param {number} srcHeight
         * @param {number} color  The transparent colour.
         * @returns {boolean}
         */
        transparentBlt(hdc, x, y, width, height, source, srcX, srcY, srcWidth, srcHeight, color){
            const context = contextOf(hdc);
            const from = contextOf(source);
            if (!context || !from)
            {
                return false;
            }
            const pixel = colorToPixel(resolveColor(from, color));
            const key = from.surface.nearest ? from.surface.nearest(pixel) : pixel;
            return clipped(context, ()=>transparentBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                src: from.surface,
                srcX, srcY, srcWidth, srcHeight,
                key,
                convert: conversionOf(context, from),
            }));
        },

        /**
         * BOOL PlgBlt(HDC, const POINT *, HDC, int, int, int, int, HBITMAP, int, int)
         *
         * The source rectangle copied onto a parallelogram: its top left
         * corner to the first point, its top right to the second, its bottom
         * left to the third, every pixel between carried along. Each
         * destination pixel whose centre the parallelogram holds takes the
         * source pixel its centre maps back to -- and, with a mask, only
         * where the mask's bit for that source pixel is set. The points and
         * the rectangle are the devices'.
         *
         * @param {number} hdc
         * @param {{ x: number, y: number }[]} corners  Three.
         * @param {number} source
         * @param {{ x: number, y: number, width: number, height: number }} from
         * @param {number} [mask]  A context with the monochrome mask's pixels.
         * @param {{ x: number, y: number }} [maskAt]  The mask's corner for the rectangle's.
         * @returns {boolean}
         */
        plgBlt(hdc, corners, source, from, mask, maskAt = { x: 0, y: 0 }){
            const context = contextOf(hdc);
            const origin = contextOf(source);
            const bits = mask ? contextOf(mask) : null;
            if (!context || !origin || (mask && !bits) || corners.length < 3)
            {
                return false;
            }
            const [p0, p1, p2] = corners;
            const ax = p1.x - p0.x;
            const ay = p1.y - p0.y;
            const bx = p2.x - p0.x;
            const by = p2.y - p0.y;
            const det = ax * by - ay * bx;
            if (det === 0 || from.width === 0 || from.height === 0)
            {
                return false;
            }
            const convert = conversionOf(context, origin) ?? (pixel=>pixel);
            const picture = /** @type {any} */ (bits?.surface ?? null);
            const one = ((picture?.palette?.[1] ?? MONOCHROME[1]) & 0xffffff) >>> 0;
            const xs = [p0.x, p1.x, p2.x, p1.x + bx];
            const ys = [p0.y, p1.y, p2.y, p1.y + by];
            const box = {
                left: Math.min(...xs), top: Math.min(...ys),
                right: Math.max(...xs) + 1, bottom: Math.max(...ys) + 1,
            };
            clipped(context, ()=>{
                const area = intersectRect(intersectRect(box, context.clip),
                    surfaceBounds(context.surface));
                for (let y = area.top; y < area.bottom; y++)
                {
                    for (let x = area.left; x < area.right; x++)
                    {
                        // Where the pixel's centre is across the source and
                        // down it, each from 0 to 1 inside.
                        const dx = x + 0.5 - p0.x;
                        const dy = y + 0.5 - p0.y;
                        const across = (dx * by - dy * bx) / det;
                        const down = (ax * dy - ay * dx) / det;
                        if (across < 0 || across >= 1 || down < 0 || down >= 1)
                        {
                            continue;
                        }
                        const u = Math.floor(across * Math.abs(from.width));
                        const v = Math.floor(down * Math.abs(from.height));
                        const sx = from.width < 0 ? from.x - 1 - u : from.x + u;
                        const sy = from.height < 0 ? from.y - 1 - v : from.y + v;
                        if (sx < 0 || sy < 0 || sx >= origin.surface.width
                            || sy >= origin.surface.height)
                        {
                            continue;
                        }
                        if (picture)
                        {
                            const mx = maskAt.x + u;
                            const my = maskAt.y + v;
                            if (mx < 0 || my < 0 || mx >= picture.width || my >= picture.height
                                || ((picture.read(mx, my) & 0xffffff) >>> 0) !== one)
                            {
                                continue;
                            }
                        }
                        context.surface.write(x, y, convert(origin.surface.read(sx, sy)));
                    }
                }
            });
            return true;
        },

        /**
         * BOOL GdiGradientFill(HDC, PTRIVERTEX, ULONG, PVOID, ULONG, ULONG)
         *
         * The vertices are in device coordinates and the mesh's indices are
         * the caller's to have checked. The pixels are written, not combined:
         * the binary raster operation does not apply.
         *
         * @param {number} hdc
         * @param {import("./gradient.js").Vertex[]} vertices
         * @param {number[][]} mesh
         * @param {number} mode
         * @returns {boolean}
         */
        gradientFill(hdc, vertices, mesh, mode){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            clipped(context, ()=>gradientFill(createPainter(context.surface, context.clip),
                vertices, mesh, mode));
            return true;
        },

        /**
         * BOOL ExtFloodFill(HDC, int, int, COLORREF, UINT)
         *
         * Fills with the selected brush, under the binary raster operation as
         * any brush fill is.
         *
         * @param {number} hdc @param {number} x @param {number} y
         * @param {number} color
         * @param {number} type  FLOODFILLBORDER or FLOODFILLSURFACE.
         * @returns {boolean} false when the fill could not start
         */
        floodFill(hdc, x, y, color, type){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            return floodFill(painterOf(context), context.clipRects ?? [context.clip], x | 0,
                y | 0, colorToPixel(resolveColor(context, color)), type === FLOODFILLSURFACE,
                patternOf(context));
        },

        /**
         * BOOL PatBlt(HDC, int, int, int, int, DWORD)
         *
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         * @param {number} rop
         * @returns {boolean}
         */
        patBlt(hdc, x, y, width, height, rop){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            return clipped(context, ()=>patBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                rop,
                pattern: patternOf(context),
            }));
        },

        /**
         * int FillRect(HDC, const RECT *, HBRUSH)
         *
         * The brush is the caller's, not the one selected into the context.
         *
         * @param {number} hdc
         * @param {import("./contract.js").Rect} rect
         * @param {number} brush
         * @returns {boolean}
         */
        fillRect(hdc, rect, brush){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const pattern = patternOf(context, brush);
            clipped(context, ()=>fillRect(painterOf(context), rect, pattern));
            return true;
        },

        /**
         * int FrameRect(HDC, const RECT *, HBRUSH)
         *
         * @param {number} hdc
         * @param {import("./contract.js").Rect} rect
         * @param {number} brush
         * @returns {boolean}
         */
        frameRect(hdc, rect, brush){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const pattern = patternOf(context, brush);
            clipped(context, ()=>frameRect(painterOf(context), rect, pattern));
            return true;
        },

        /**
         * BOOL InvertRect(HDC, const RECT *)
         *
         * Which is exactly a PatBlt with DSTINVERT, so it is one. Halftone, it
         * is the PatBlt with PATINVERT and the system's gray brush that
         * DrawFocusRect paints with: every other pixel inverted, a
         * checkerboard from the brush origin, so a focus rectangle shows
         * dotted over any picture and drawing it again still takes it away.
         *
         * @param {number} hdc
         * @param {import("./contract.js").Rect} rect
         * @param {boolean} [halftone]
         * @returns {boolean}
         */
        invertRect(hdc, rect, halftone = false){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const origin = context.brushOrigin;
            return clipped(context, ()=>patBlt({
                dest: context.surface,
                clip: context.clip,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                rop: halftone ? PATINVERT : DSTINVERT,
                // The gray brush's bitmap is 0x55 over 0xAA: its set bits,
                // the background white that inverts, where x + y is odd.
                pattern: halftone
                    ? (x, y)=>((x - origin.x + y - origin.y) & 1 ? 0xffffffff : 0)
                    : undefined,
            }));
        },

        /**
         * BOOL Rectangle(HDC, int, int, int, int)
         *
         * @param {number} hdc
         * @param {number} left
         * @param {number} top
         * @param {number} right
         * @param {number} bottom
         * @returns {boolean}
         */
        rectangle(hdc, left, top, right, bottom){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const pen = penOf(context);
            const pattern = patternOf(context);
            clipped(context, ()=>rectangle(painterOf(context), { left, top, right, bottom },
                pen, pattern));
            return true;
        },

        /**
         * BOOL Ellipse(HDC, int, int, int, int)
         *
         * @param {number} hdc
         * @param {number} left
         * @param {number} top
         * @param {number} right
         * @param {number} bottom
         * @returns {boolean}
         */
        ellipse(hdc, left, top, right, bottom){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const pen = penOf(context);
            const pattern = patternOf(context);
            clipped(context, ()=>ellipse(painterOf(context), { left, top, right, bottom },
                pen, pattern));
            return true;
        },

        /**
         * BOOL Polygon(HDC, const POINT *, int)
         *
         * @param {number} hdc
         * @param {import("./shapes.js").Point[]} points
         * @param {number} [fillMode]
         * @returns {boolean}
         */
        polygon(hdc, points, fillMode){
            const context = contextOf(hdc);
            if (!context || points.length < 2)
            {
                return false;
            }
            const pen = penOf(context);
            const pattern = patternOf(context);
            clipped(context, ()=>polygon(painterOf(context), points, pen, pattern, fillMode));
            return true;
        },

        /**
         * BOOL PolyPolygon(HDC, const POINT *, const INT *, int), and the
         * paths FillPath and StrokeAndFillPath draw: the polygons filled
         * together with the brush, so one inside another can be a hole, and
         * each outlined with the pen -- or only one of the two.
         *
         * @param {number} hdc
         * @param {import("./shapes.js").Point[][]} rings
         * @param {number} [fillMode]
         * @param {{ fill?: boolean, stroke?: boolean }} [parts]
         * @returns {boolean}
         */
        polyPolygon(hdc, rings, fillMode, parts){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const pen = penOf(context);
            const pattern = patternOf(context);
            clipped(context, ()=>polyPolygon(painterOf(context), rings, pen, pattern, fillMode,
                parts));
            return true;
        },

        /**
         * BOOL MoveToEx(HDC, int, int, LPPOINT)
         *
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @returns {{ x: number, y: number } | null} the previous position
         */
        moveToEx(hdc, x, y){
            const context = contextOf(hdc);
            if (!context)
            {
                return null;
            }
            const previous = context.state.position;
            context.state.position = { x: x | 0, y: y | 0 };
            return previous;
        },

        /**
         * BOOL LineTo(HDC, int, int)
         *
         * The endpoint is not painted, and becomes the new current position --
         * so the next LineTo starts by painting it.
         *
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @returns {boolean}
         */
        lineTo(hdc, x, y){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            const from = context.state.position;
            const pen = penOf(context);
            clipped(context, ()=>line(painterOf(context), from.x, from.y, x | 0, y | 0, pen));
            context.state.position = { x: x | 0, y: y | 0 };
            return true;
        },

        /**
         * BOOL TextOutA(HDC, int, int, LPCSTR, int)
         *
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @param {string} text
         * @returns {boolean}
         */
        textOutA(hdc, x, y, text){
            return this.extTextOutA(hdc, x, y, 0, null, text, undefined);
        },

        /**
         * BOOL ExtTextOutA(HDC, int, int, UINT, const RECT *, LPCSTR, UINT, const INT *)
         *
         * @param {number} hdc
         * @param {number} x
         * @param {number} y
         * @param {number} flags
         * @param {import("./contract.js").Rect | null} rect
         * @param {string} text
         * @param {number[]} [dx]
         * @returns {boolean}
         */
        extTextOutA(hdc, x, y, flags, rect, text, dx){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            // With TA_UPDATECP the coordinates the call carries are ignored and
            // the current position is the origin, which is the whole point of
            // the flag.
            const updating = (context.state.textAlign & 1) !== 0;
            const origin = updating ? context.state.position : { x: x | 0, y: y | 0 };
            const metrics = metricsOf(context);
            const result = { ok: false, width: 0 };
            clipped(context, ()=>{
                const drawn = extTextOut(painterOf(context), {
                    x: origin.x,
                    y: origin.y,
                    text,
                    metrics,
                    textColor: resolveColor(context, context.state.textColor),
                    bkColor: resolveColor(context, context.state.bkColor),
                    bkMode: context.state.bkMode,
                    align: context.state.textAlign,
                    flags,
                    rect: rect ?? undefined,
                    dx,
                });
                result.ok ||= drawn.ok;
                result.width = drawn.width;
                return 0;
            });
            if (updating)
            {
                context.state.position = { x: origin.x + result.width, y: origin.y };
            }
            return result.ok;
        },

        /**
         * How wide a string is with the context's current font, which is what a
         * caller needs before it can align anything.
         *
         * @param {number} hdc
         * @param {string} text
         * @returns {{ cx: number, cy: number } | null}
         */
        textExtent(hdc, text){
            const context = contextOf(hdc);
            if (!context)
            {
                return null;
            }
            const metrics = metricsOf(context);
            return { cx: textExtent(text, metrics), cy: metrics.cellHeight };
        },

        /**
         * int SetDIBitsToDevice(...)
         *
         * @param {number} hdc
         * @param {Omit<import("./dib.js").SetDibOptions, "dest" | "clip">} request
         * @returns {number}
         */
        setDIBitsToDevice(hdc, request){
            const context = contextOf(hdc);
            if (!context)
            {
                return 0;
            }
            return clipped(context, ()=>setDIBitsToDevice({
                ...request,
                dest: context.surface,
                clip: context.clip,
            }));
        },

        /**
         * int StretchDIBits(...)
         *
         * @param {number} hdc
         * @param {Omit<import("./dib.js").StretchDibOptions, "dest" | "clip">} request
         * @returns {number}
         */
        stretchDIBits(hdc, request){
            const context = contextOf(hdc);
            if (!context)
            {
                return 0;
            }
            const pattern = patternOf(context);
            return clipped(context, ()=>stretchDIBits({
                mode: stretchModeOf(context),
                pattern,
                ...request,
                dest: context.surface,
                clip: context.clip,
            }));
        },

        /**
         * A picture of four bytes a pixel -- blue, green, red, alpha, top row
         * first, as an icon is decoded -- drawn at a point, scaled to the size
         * asked for: a pixel of no alpha leaves what is under it, one of some
         * is blended over it. What DrawIcon and DrawIconEx put down.
         *
         * @param {number} hdc @param {number} x @param {number} y
         * @param {{ width: number, height: number, bgra: Uint8Array }} picture
         * @param {number} [width] @param {number} [height]
         * @returns {boolean}
         */
        drawPicture(hdc, x, y, picture, width = picture.width, height = picture.height){
            const context = contextOf(hdc);
            if (!context || width <= 0 || height <= 0)
            {
                return false;
            }
            const surface = context.surface;
            const { bgra } = picture;
            clipped(context, ()=>{
                const clip = context.clip;
                const top = Math.max(0, clip.top - y);
                for (let row = top; row < height && y + row < clip.bottom; row++)
                {
                    const from = Math.floor(row * picture.height / height) * picture.width;
                    for (let column = Math.max(0, clip.left - x);
                        column < width && x + column < clip.right; column++)
                    {
                        const at = (from + Math.floor(column * picture.width / width)) * 4;
                        const alpha = bgra[at + 3];
                        if (alpha === 0)
                        {
                            continue;
                        }
                        let pixel = (bgra[at + 2] << 16) | (bgra[at + 1] << 8) | bgra[at];
                        if (alpha !== 255)
                        {
                            const under = surface.read(x + column, y + row);
                            pixel = 0;
                            for (let shift = 0; shift <= 16; shift += 8)
                            {
                                const over = bgra[at + (shift >>> 3)];
                                const back = (under >>> shift) & 0xff;
                                pixel |= Math.round(back + (over - back) * alpha / 255) << shift;
                            }
                        }
                        surface.write(x + column, y + row, pixel);
                    }
                }
                return true;
            });
            return true;
        },

        /**
         * int GetDIBits(...): the context's pixels, back out in the caller's
         * own format.
         *
         * @param {number} hdc
         * @param {import("./dib.js").DibImage} image
         * @returns {number} how many scan lines were written
         */
        getDIBits(hdc, image){
            const context = contextOf(hdc);
            if (!context)
            {
                return 0;
            }
            return encodeDib(context.surface, image);
        },

        /**
         * Fills a whole context with one colour, which is what a clear is and
         * what every test needs before it can tell "untouched" from "black".
         *
         * @param {number} hdc
         * @param {number} color
         * @returns {boolean}
         */
        clear(hdc, color){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            return clipped(context, ()=>patBlt({
                dest: context.surface,
                clip: context.clip,
                x: 0,
                y: 0,
                width: context.surface.width,
                height: context.surface.height,
                rop: PATCOPY,
                pattern: solidPattern(resolveColor(context, color)),
            }));
        },
    };
}

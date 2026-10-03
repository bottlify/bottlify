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
    BLACKONWHITE, STRETCH_MODES, bitBlt, patBlt, sourceConversion, stretchBlt,
} from './blit.js';
import { DSTINVERT, PATCOPY, R2_COPYPEN } from './rop.js';
import { PS_SOLID, createPainter, ellipse, fillRect, frameRect, line, polygon, rectangle }
    from './shapes.js';
import { colorToPixel, intersectRect, isEmptyRect, pixelToColor, surfaceBounds }
    from './surface.js';
import { encodeDib, setDIBitsToDevice, stretchDIBits } from './dib.js';
import { extTextOut, textExtent } from './text.js';
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

    /** @param {any} context @returns {import("./shapes.js").Pen} */
    const penOf = context=>{
        const record = objects.get(context.state.pen);
        return record && record.type === 'pen' ? record.attributes : DEFAULT_PEN;
    };

    /**
     * @param {any} context
     * @param {number} [handle]   A brush the call named, rather than the selected one.
     * @returns {import("./contract.js").PatternSource}
     */
    const patternOf = (context, handle)=>{
        const record = objects.get(handle ?? context.state.brush);
        return createPattern({
            attributes: record && record.type === 'brush' ? record.attributes : DEFAULT_BRUSH,
            bkMode: context.state.bkMode,
            bkColor: context.state.bkColor,
            textColor: context.state.textColor,
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
        textColor: context.state.textColor,
        bkColor: context.state.bkColor,
        srcBkColor: from.state.bkColor,
    });

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
                stretchMode: BLACKONWHITE,
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
            const previous = context.stretchMode;
            context.stretchMode = mode | 0;
            return previous;
        },

        /** @param {number} hdc @returns {number} */
        getStretchBltMode(hdc){
            return contextOf(hdc)?.stretchMode ?? 0;
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
            context.surface.write(x | 0, y | 0, colorToPixel(color));
            return color >>> 0;
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
            const pixel = colorToPixel(color);
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
                mode: context.stretchMode,
                pattern: patternOf(context),
                convert: conversionOf(context, from),
            }), { x: x - srcX, y: y - srcY });
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
         * Which is exactly a PatBlt with DSTINVERT, so it is one.
         *
         * @param {number} hdc
         * @param {import("./contract.js").Rect} rect
         * @returns {boolean}
         */
        invertRect(hdc, rect){
            const context = contextOf(hdc);
            if (!context)
            {
                return false;
            }
            return clipped(context, ()=>patBlt({
                dest: context.surface,
                clip: context.clip,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                rop: DSTINVERT,
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
                    textColor: context.state.textColor,
                    bkColor: context.state.bkColor,
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
                mode: context.stretchMode,
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
                pattern: solidPattern(color),
            }));
        },
    };
}

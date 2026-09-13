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
 * the clip rectangle, the stretch mode, the text alignment and the brush
 * origin. None of those mean anything until something draws.
 *
 * A DirectDraw surface's `GetDC` is the same mechanism with a different owner:
 * DirectDraw mints the handle and this layer gives it the surface's own bytes.
 * There is no staging copy, so a drawing operation is visible to the surface's
 * own reads immediately and `ReleaseDC` has nothing to flush -- if a surface
 * that lives on the device ever needs one, `release` is the single place it
 * goes.
 */

import { BS_SOLID, OPAQUE, createPattern, solidPattern } from './brush.js';
import { BLACKONWHITE, STRETCH_MODES, bitBlt, patBlt, stretchBlt } from './blit.js';
import { DSTINVERT, PATCOPY, R2_COPYPEN } from './rop.js';
import { PS_SOLID, createPainter, ellipse, fillRect, frameRect, line, polygon, rectangle }
    from './shapes.js';
import { colorToPixel, intersectRect, isEmptyRect, pixelToColor, surfaceBounds }
    from './surface.js';
import { encodeDib, setDIBitsToDevice, stretchDIBits } from './dib.js';
import { extTextOut, textExtent } from './text.js';

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
            origin: context.brushOrigin,
        });
    };

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
                textAlign: 0,
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
         * Clipping is one rectangle: enough for a DirectDraw clipper and for
         * the client area of a window, and short of a region.
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
            const previous = context.textAlign;
            context.textAlign = align >>> 0;
            return previous;
        },

        /** @param {number} hdc @returns {number} */
        getTextAlign(hdc){
            return contextOf(hdc)?.textAlign ?? CLR_INVALID;
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
            if (!context || isEmptyRect(intersectRect(context.clip,
                { left: x | 0, top: y | 0, right: (x | 0) + 1, bottom: (y | 0) + 1 })))
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
            return bitBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                src: from ? from.surface : undefined,
                srcX, srcY,
                rop,
                pattern: patternOf(context),
            });
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
            return stretchBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                src: from.surface,
                srcX, srcY, srcWidth, srcHeight,
                rop,
                mode: context.stretchMode,
                pattern: patternOf(context),
            });
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
            return patBlt({
                dest: context.surface,
                clip: context.clip,
                x, y, width, height,
                rop,
                pattern: patternOf(context),
            });
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
            fillRect(painterOf(context), rect, patternOf(context, brush));
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
            frameRect(painterOf(context), rect, patternOf(context, brush));
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
            return patBlt({
                dest: context.surface,
                clip: context.clip,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                rop: DSTINVERT,
            });
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
            rectangle(painterOf(context), { left, top, right, bottom },
                penOf(context), patternOf(context));
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
            ellipse(painterOf(context), { left, top, right, bottom },
                penOf(context), patternOf(context));
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
            polygon(painterOf(context), points, penOf(context), patternOf(context), fillMode);
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
            line(painterOf(context), from.x, from.y, x | 0, y | 0, penOf(context));
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
            const updating = (context.textAlign & 1) !== 0;
            const origin = updating ? context.state.position : { x: x | 0, y: y | 0 };
            const result = extTextOut(painterOf(context), {
                x: origin.x,
                y: origin.y,
                text,
                metrics: metricsOf(context),
                textColor: context.state.textColor,
                bkColor: context.state.bkColor,
                bkMode: context.state.bkMode,
                align: context.textAlign,
                flags,
                rect: rect ?? undefined,
                dx,
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
            return setDIBitsToDevice({
                ...request,
                dest: context.surface,
                clip: context.clip,
            });
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
            return stretchDIBits({
                mode: context.stretchMode,
                pattern: patternOf(context),
                ...request,
                dest: context.surface,
                clip: context.clip,
            });
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
            return patBlt({
                dest: context.surface,
                clip: context.clip,
                x: 0,
                y: 0,
                width: context.surface.width,
                height: context.surface.height,
                rop: PATCOPY,
                pattern: solidPattern(color),
            });
        },
    };
}

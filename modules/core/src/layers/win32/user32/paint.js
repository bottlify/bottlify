/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Painting, and the device contexts a window is painted through.
 *
 * The update region is the whole of why these calls exist as a set rather than
 * as convenience wrappers. A window becomes dirty, WM_PAINT is delivered
 * because it is dirty, and BeginPaint is what makes it clean again. A program
 * that never reaches BeginPaint, or one whose BeginPaint does not clear the
 * region, gets WM_PAINT for as long as it runs -- the loop looks like a hang
 * and has nothing to do with drawing.
 *
 * A region is kept here as one rectangle rather than as a real region. That is
 * a deliberate simplification with a known ceiling: a program that invalidates
 * two far-apart strips repaints the span between them, which is slower and
 * never wrong. Real regions belong with the drawing, not with the bookkeeping.
 *
 * Where the pixels go is not decided here. A DC comes from whoever owns them,
 * handed in as a service, because this layer may not reach the graphics layer:
 * `graphics` declares `win32` in its requires, so an import the other way would
 * close a cycle the boundary check refuses. Without that service a DC cannot be
 * made, and these calls say so by failing rather than by handing back a handle
 * that draws nowhere.
 */

import { PAINTSTRUCT, RECT, readRect, writeRect, writeU32s } from './structs.js';

/** DrawText's flags, of which only the ones that change the geometry matter. */
const DT_CALCRECT = 0x0400;
const DT_SINGLELINE = 0x0020;

/** What a character cell measures when nothing better is known. */
const ESTIMATED_CHAR_WIDTH = 8;
const ESTIMATED_LINE_HEIGHT = 16;

/**
 * @typedef {Object} PaintHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {() => any} [dc]
 *           The device-context service, when the build has one: `get(hwnd)`
 *           makes a DC for a window, `release(hwnd, hdc)` gives it back. Absent
 *           in a build that cannot draw.
 */

/** The rectangle covering a whole window's client area. @param {any} record */
const clientRect = record=>({
    left: 0,
    top: 0,
    right: Math.max(record.width, 0),
    bottom: Math.max(record.height, 0),
});

/** @param {any} a @param {any} b */
const union = (a, b)=>({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
});

/** @param {any} rect */
const isEmpty = rect=>rect.right <= rect.left || rect.bottom <= rect.top;

/**
 * Builds the painting half of user32, over the window records the bookkeeping
 * half already keeps.
 *
 * @param {Object} options
 * @param {PaintHost} options.host
 * @param {(hwnd: number) => any | null} options.live  A window, if it still is one.
 * @param {any} options.queue
 * @param {number} options.WM_PAINT
 */
export function createPaintFunctions({ host, live, queue, WM_PAINT }){
    /** @param {any} record @param {any} rect */
    const invalidate = (record, rect)=>{
        if (isEmpty(rect))
        {
            return;
        }
        record.updateRect = record.updateRect ? union(record.updateRect, rect) : rect;
    };

    /** The DC service, or null in a build that cannot make one. */
    const contexts = ()=>host.dc?.() ?? null;

    return {
        /** HDC GetDC(HWND hWnd) */
        GetDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>contexts()?.get(hwnd >>> 0) ?? 0,
        },

        /** int ReleaseDC(HWND hWnd, HDC hDC) */
        ReleaseDC: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, hdc])=>contexts()?.release(hwnd >>> 0, hdc >>> 0) ?? 0,
        },

        /**
         * HDC BeginPaint(HWND hWnd, LPPAINTSTRUCT lpPaint)
         *
         * Clearing the update region is the load-bearing part, not the DC.
         */
        BeginPaint: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, paintStruct])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const dirty = record.updateRect ?? clientRect(record);
                const hdc = contexts()?.get(hwnd >>> 0) ?? 0;

                // Cleared before the guest paints, not after: a program that
                // invalidates from inside its own WM_PAINT expects that request
                // to survive, and clearing afterwards would swallow it.
                record.updateRect = null;
                record.painting = hdc;

                writeU32s(host, paintStruct + PAINTSTRUCT.hdc, [hdc, record.erase ? 1 : 0]);
                writeRect(host, paintStruct + PAINTSTRUCT.rcPaint, dirty);
                writeU32s(host, paintStruct + PAINTSTRUCT.fRestore, [0, 0]);
                record.erase = false;
                return hdc;
            },
        },

        /** BOOL EndPaint(HWND hWnd, const PAINTSTRUCT *lpPaint) */
        EndPaint: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, paintStruct])=>{
                const record = live(hwnd);
                const hdc = host.readMemory(paintStruct + PAINTSTRUCT.hdc, 4);
                const handle = (hdc[0] | hdc[1] << 8 | hdc[2] << 16 | hdc[3] << 24) >>> 0;
                if (handle !== 0)
                {
                    contexts()?.release(hwnd >>> 0, handle);
                }
                if (record)
                {
                    record.painting = 0;
                }
                return 1;
            },
        },

        /**
         * BOOL InvalidateRect(HWND hWnd, const RECT *lpRect, BOOL bErase)
         *
         * A null rectangle means the whole client area, which is not the same as
         * an empty one: the first repaints everything and the second nothing.
         */
        InvalidateRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, rect, erase])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                invalidate(record,
                    (rect >>> 0) === 0 ? clientRect(record) : readRect(host, rect));
                record.erase = record.erase || (erase >>> 0) !== 0;
                return 1;
            },
        },

        /**
         * BOOL UpdateWindow(HWND hWnd)
         *
         * Windows *sends* WM_PAINT here, which means running the window
         * procedure before this returns. Posting it keeps the order a program
         * observes and reaches the same procedure one turn of its own loop
         * later; a program that calls UpdateWindow and then pumps sees no
         * difference. A program that calls it and then blocks would, and that is
         * the ceiling on this.
         */
        UpdateWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                if (!record || !record.updateRect)
                {
                    return record ? 1 : 0;
                }
                queue.post({ hwnd: record.hwnd, message: WM_PAINT, wParam: 0, lParam: 0 });
                return 1;
            },
        },

        /**
         * BOOL GetUpdateRect(HWND hWnd, LPRECT lpRect, BOOL bErase)
         *
         * Answers whether there is anything to paint, which is what a program
         * checks before deciding to.
         */
        GetUpdateRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, rect])=>{
                const record = live(hwnd);
                const dirty = record?.updateRect ?? null;
                if ((rect >>> 0) !== 0)
                {
                    writeRect(host, rect,
                        dirty ?? { left: 0, top: 0, right: 0, bottom: 0 });
                }
                return dirty ? 1 : 0;
            },
        },

        /**
         * int DrawTextA(HDC hdc, LPCSTR lpchText, int cchText, LPRECT lprc, UINT format)
         *
         * DT_CALCRECT measures instead of drawing and writes the rectangle back,
         * which is what a program uses to lay itself out -- so this has to answer
         * even in a build with nothing to draw on. The metrics are estimates and
         * the code says so; a program that lays out against them is consistent
         * with itself, which is what matters until real font metrics exist.
         */
        DrawTextA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([hdc, text, count, rect, format])=>{
                const limit = (count | 0) < 0 ? 0x10000 : count | 0;
                const string = (text >>> 0) === 0
                    ? ''
                    : host.readCString(text, limit).slice(0, limit === 0 ? 0 : undefined);
                const lines = (format & DT_SINGLELINE) !== 0 ? [string] : string.split('\n');
                const widest = lines.reduce((most, line)=>Math.max(most, line.length), 0);
                const height = Math.max(lines.length, 1) * ESTIMATED_LINE_HEIGHT;

                if ((format & DT_CALCRECT) !== 0 && (rect >>> 0) !== 0)
                {
                    const bounds = readRect(host, rect);
                    writeRect(host, rect, {
                        left: bounds.left,
                        top: bounds.top,
                        right: bounds.left + widest * ESTIMATED_CHAR_WIDTH,
                        bottom: bounds.top + height,
                    });
                }
                return (hdc >>> 0) === 0 && (format & DT_CALCRECT) === 0 ? 0 : height;
            },
        },

        /**
         * int FillRect(HDC hDC, const RECT *lprc, HBRUSH hbr)
         *
         * The three rectangle fills answer honestly rather than pretending: with
         * nowhere to draw they report failure, so a program is not told a fill
         * happened that did not.
         */
        FillRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, rect, brush])=>
                contexts()?.fillRect?.(hdc >>> 0, readRect(host, rect), brush >>> 0) ?? 0,
        },

        /** BOOL InvertRect(HDC hDC, const RECT *lprc) */
        InvertRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, rect])=>
                contexts()?.invertRect?.(hdc >>> 0, readRect(host, rect)) ?? 0,
        },

        /** BOOL FrameRect(HDC hDC, const RECT *lprc, HBRUSH hbr) */
        FrameRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, rect, brush])=>
                contexts()?.frameRect?.(hdc >>> 0, readRect(host, rect), brush >>> 0) ?? 0,
        },

        /** BOOL ValidateRect(HWND hWnd, const RECT *lpRect) */
        ValidateRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, rect])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                // Only the whole-window case is honoured exactly. Subtracting one
                // rectangle from another needs a real region, and reporting a
                // partial validation as complete would lose a repaint.
                if ((rect >>> 0) === 0 || !record.updateRect)
                {
                    record.updateRect = null;
                }
                return 1;
            },
        },
    };
}

/** The offsets a test asserts against, so a change to the layout is visible. */
export const PAINT_LAYOUT = Object.freeze({ PAINTSTRUCT, RECT });

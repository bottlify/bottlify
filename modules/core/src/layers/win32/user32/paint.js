/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
import { decodeAnsi } from '../kernel32/locale.js';
import { readText } from './unicode.js';

/** DrawText's flags. */
const DT_CENTER = 0x0001;
const DT_RIGHT = 0x0002;
const DT_VCENTER = 0x0004;
const DT_BOTTOM = 0x0008;
const DT_WORDBREAK = 0x0010;
const DT_SINGLELINE = 0x0020;
const DT_CALCRECT = 0x0400;
const DT_NOPREFIX = 0x0800;

/** RedrawWindow's flags, the ones with an effect on an update rectangle. */
const RDW_ALLCHILDREN = 0x0080;
const RDW_INVALIDATE = 0x0001;
const RDW_ERASE = 0x0004;
const RDW_VALIDATE = 0x0008;
const RDW_UPDATENOW = 0x0100;
const RDW_FRAME = 0x0400;

/** What BeginPaint sends before the program draws. */
const WM_NCPAINT = 0x0085;
const WM_ERASEBKGND = 0x0014;

/** What a character cell measures when nothing better is known. */
const ESTIMATED_CHAR_WIDTH = 8;
const ESTIMATED_LINE_HEIGHT = 16;

/**
 * @typedef {Object} PaintHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(region: number) => Rect | null} [regionBox]
 *           The rectangle a region object holds, null for a handle that is not
 *           one: gdi32's, reached the same way `setRegion` is.
 * @property {(region: number, rect: any) => void} [setRegion]
 *           Fills in a region object the caller owns. It belongs to gdi32's
 *           table, which this layer cannot reach, so it arrives as a service or
 *           not at all.
 * @property {() => any} [dc]
 *           The device-context service, when the build has one: `get(hwnd,
 *           bounds)` makes a DC for a window over the screen rectangle given,
 *           `release(hwnd, hdc)` gives it back. Absent in a build that cannot draw.
 * @property {any} [draw]
 *           The window manager's own drawing, over a DC: fills, text and the
 *           measure of the selected font. Absent with `dc`.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that answers other than Windows would says so.
 * @property {() => unknown} [callerThread]
 *           Whose call is being handled, read before anything is awaited.
 * @property {(handle: number) => import('./cursors.js').CursorPicture | null} [picture]
 *           The picture an icon handle stands for, or null for one that has
 *           none this build can read.
 */

/**
 * The cell text is laid out on, and the measure of a string in the same
 * font when the build has one: without it every character is one cell.
 *
 * @typedef {Object} TextCell
 * @property {number} cellWidth
 * @property {number} cellHeight
 * @property {(text: string) => number} [width]
 */

/**
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * @typedef {Object} LaidOutLine
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number | null} underline   The character to underline, for a mnemonic.
 */

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
 * Where DrawText puts each line of a string.
 *
 * The mnemonic prefix is taken out unless DT_NOPREFIX: `&x` is `x` with an
 * underline to draw, `&&` is one ampersand. Lines break at a line feed, and
 * with DT_WORDBREAK at the last space that fits; DT_SINGLELINE takes the
 * whole string as one line, which is also the only case the vertical flags
 * apply to, as documented. A string is as wide as the metrics measure it,
 * or one cell per character when they cannot.
 *
 * @param {string} text
 * @param {Rect} rect
 * @param {number} format
 * @param {TextCell} metrics
 * @returns {LaidOutLine[]}
 */
export function layoutText(text, rect, format, metrics){
    const widthOf = metrics.width ?? ((/** @type {string} */ piece)=>piece.length * metrics.cellWidth);
    /** @type {number | null} */
    let mnemonic = null;
    let plain = text;
    if ((format & DT_NOPREFIX) === 0)
    {
        plain = '';
        for (let index = 0; index < text.length; index++)
        {
            if (text[index] === '&' && index + 1 < text.length)
            {
                index++;
                if (text[index] !== '&' && mnemonic === null)
                {
                    mnemonic = plain.length;
                }
            }
            plain += text[index];
        }
    }
    const width = rect.right - rect.left;
    /**
     * The end of the longest piece from `from` that fits the width, and at
     * least one character, so a rectangle narrower than a glyph still moves
     * on. Bisected, because a measure is a sum of cached advances and the
     * pieces are short.
     *
     * @param {string} paragraph @param {number} from
     */
    const fitting = (paragraph, from)=>{
        let low = from + 1;
        let high = paragraph.length;
        while (low < high)
        {
            const middle = (low + high + 1) >> 1;
            if (widthOf(paragraph.slice(from, middle)) <= width)
            {
                low = middle;
            }
            else
            {
                high = middle - 1;
            }
        }
        return low;
    };
    /** @type {{ text: string, start: number }[]} */
    const lines = [];
    if ((format & DT_SINGLELINE) !== 0)
    {
        lines.push({ text: plain.replace(/\r?\n/g, ' '), start: 0 });
    }
    else
    {
        let at = 0;
        for (const paragraph of plain.split(/\r\n|\n|\r/))
        {
            const start = at;
            at += paragraph.length + 1;
            if ((format & DT_WORDBREAK) === 0 || widthOf(paragraph) <= width)
            {
                lines.push({ text: paragraph, start });
                continue;
            }
            let from = 0;
            while (widthOf(paragraph.slice(from)) > width)
            {
                const end = fitting(paragraph, from);
                let cut = paragraph.lastIndexOf(' ', end);
                cut = cut <= from ? end : cut + 1;
                lines.push({ text: paragraph.slice(from, cut), start: start + from });
                from = cut;
            }
            // A cut that took the whole paragraph leaves no line to add; an
            // empty paragraph is still one line.
            if (from < paragraph.length || from === 0)
            {
                lines.push({ text: paragraph.slice(from), start: start + from });
            }
        }
    }
    const height = lines.length * metrics.cellHeight;
    let top = rect.top;
    if ((format & DT_SINGLELINE) !== 0)
    {
        if ((format & DT_VCENTER) !== 0)
        {
            top = rect.top + Math.floor((rect.bottom - rect.top - height) / 2);
        }
        else if ((format & DT_BOTTOM) !== 0)
        {
            top = rect.bottom - height;
        }
    }
    return lines.map((line, index)=>{
        const lineWidth = widthOf(line.text);
        const x = (format & DT_CENTER) !== 0
            ? rect.left + Math.floor((width - lineWidth) / 2)
            : (format & DT_RIGHT) !== 0 ? rect.right - lineWidth : rect.left;
        const underline = mnemonic !== null && mnemonic >= line.start
            && mnemonic < line.start + line.text.length
            ? mnemonic - line.start
            : null;
        return { text: line.text, x, y: top + index * metrics.cellHeight, underline };
    });
}

/**
 * Builds the painting half of user32, over the window records the bookkeeping
 * half already keeps.
 *
 * @param {Object} options
 * @param {PaintHost} options.host
 * @param {(hwnd: number) => any | null} options.live  A window, if it still is one.
 * @param {number} options.WM_PAINT
 * @param {{ clientSize: (record: any) => { width: number, height: number },
 *     clientRect: (record: any) => Rect, windowRect: (record: any) => Rect,
 *     visibleClientRect: (record: any) => Rect,
 *     visibleWindowRect: (record: any) => Rect }} options.geometry
 * @param {(hwnd: number, message: number, wParam: number, lParam: number,
 *     thread?: unknown) => number | Promise<number>} options.send
 * @param {(record: any) => void} options.invalidated
 *        A window's update area grew. Whoever keeps the others in order
 *        marks the ones that now have to repaint after it.
 * @param {() => void} options.painted   Something reached the screen.
 * @param {(record: any) => any[]} [options.descendants]
 *        A window's descendants, parents before their children: the order
 *        RDW_ALLCHILDREN paints them in.
 * @param {(record: any) => boolean} [options.shown]
 *        Whether a window is on the screen: it and every parent WS_VISIBLE.
 */
export function createPaintFunctions(options){
    const { host, live, WM_PAINT, geometry, send, invalidated, painted, descendants } = options;
    const shown = options.shown ?? (()=>true);
    /** Where a window that is not on the screen draws: nowhere. */
    const NOWHERE = { left: 0, top: 0, right: 0, bottom: 0 };
    let iconDivergenceSaid = false;

    /** @param {any} record @returns {Rect} */
    const clientArea = record=>{
        const size = geometry.clientSize(record);
        return { left: 0, top: 0, right: size.width, bottom: size.height };
    };

    /** The window LockWindowUpdate holds, or 0. */
    let lockedWindow = 0;

    /** @param {any} record @param {any} rect @param {boolean} [erase] */
    const invalidate = (record, rect, erase = false)=>{
        if (isEmpty(rect))
        {
            return;
        }
        record.updateRect = record.updateRect ? union(record.updateRect, rect) : rect;
        record.erase = record.erase || erase;
        invalidated(record);
    };

    /**
     * What is left of an update rectangle once `taken` is validated out of
     * it. Exact when the result is still a rectangle -- nothing left, or a
     * band cut off one side; when the cut would leave an L or a hole, the
     * rectangle is kept whole, because repainting more than asked is a cost
     * and repainting less is a hole.
     *
     * @param {Rect} dirty @param {Rect} taken
     * @returns {Rect | null}
     */
    const subtract = (dirty, taken)=>{
        const coversX = taken.left <= dirty.left && taken.right >= dirty.right;
        const coversY = taken.top <= dirty.top && taken.bottom >= dirty.bottom;
        if (coversX && coversY)
        {
            return null;
        }
        if (coversX && taken.top <= dirty.top && taken.bottom > dirty.top)
        {
            return { ...dirty, top: taken.bottom };
        }
        if (coversX && taken.bottom >= dirty.bottom && taken.top < dirty.bottom)
        {
            return { ...dirty, bottom: taken.top };
        }
        if (coversY && taken.left <= dirty.left && taken.right > dirty.left)
        {
            return { ...dirty, left: taken.right };
        }
        if (coversY && taken.right >= dirty.right && taken.left < dirty.right)
        {
            return { ...dirty, right: taken.left };
        }
        return dirty;
    };

    /**
     * Takes an area out of a window's update rectangle; the whole of it when
     * no area is named.
     *
     * @param {any} record @param {Rect | null} area
     */
    const validate = (record, area)=>{
        record.updateRect = record.updateRect && area ? subtract(record.updateRect, area) : null;
    };

    /**
     * The area a region names, in the window's client coordinates: its
     * rectangle, or the whole client area for no region -- or for one that
     * cannot be read, since repainting more than asked is the safe side.
     *
     * @param {any} record @param {number} region
     */
    const regionArea = (record, region)=>((region >>> 0) === 0
        ? clientArea(record)
        : host.regionBox?.(region >>> 0) ?? clientArea(record));

    /**
     * WM_PAINT sent now, the window procedure run before the caller goes on,
     * when the window has anything to paint: what UpdateWindow and
     * RDW_UPDATENOW do. A procedure that paints clears the area through
     * BeginPaint; one that does not is sent it once, not in a loop.
     *
     * @param {any} record
     * @returns {number | Promise<number>}
     */
    const paintNow = record=>(record.updateRect
        ? after(send(record.hwnd, WM_PAINT, 0, 0, host.callerThread?.()), ()=>1)
        : 1);

    /** The DC service, or null in a build that cannot make one. */
    const contexts = ()=>host.dc?.() ?? null;

    /**
     * A device context on a window's client area, or on the whole window:
     * its origin at the area's corner, and clipped to the part of it that
     * is on the screen and inside every ancestor.
     *
     * @param {any} record @param {boolean} [whole]
     * @returns {number} the handle, or zero
     */
    const contextOn = (record, whole = false)=>{
        const area = whole ? geometry.windowRect(record) : geometry.clientRect(record);
        const hdc = contexts()?.get(record.hwnd, area) ?? 0;
        if (hdc !== 0)
        {
            // A window that is hidden, or inside one that is, has no part on
            // the screen, and what it draws reaches none: its visible region
            // is empty, not the rectangle it would have if it were shown.
            const visible = whole
                ? geometry.visibleWindowRect(record) : geometry.visibleClientRect(record);
            host.draw?.clip?.(hdc, shown(record) ? {
                left: visible.left - area.left, top: visible.top - area.top,
                right: visible.right - area.left, bottom: visible.bottom - area.top,
            } : NOWHERE);
        }
        return hdc;
    };

    /** @param {any} value @param {(answer: any) => any} then */
    const after = (value, then)=>(typeof value?.then === 'function'
        ? value.then(then)
        : then(value));

    /**
     * A device context on a window's client area, the update area cleared
     * and, in that order, the frame and the background painted through the
     * window's own procedure -- which is what makes BeginPaint the moment a
     * window's frame appears. Only measuring leaves the update area alone.
     *
     * @param {any} record @param {boolean} [measuring]
     * @returns {{ hdc: number, rect: Rect } | Promise<{ hdc: number, rect: Rect }>}
     */
    const beginPaint = (record, measuring = false)=>{
        const hdc = contextOn(record);
        if (measuring)
        {
            return { hdc, rect: clientArea(record) };
        }
        const dirty = record.updateRect ?? clientArea(record);
        // Cleared before the guest paints, not after: a program that
        // invalidates from inside its own WM_PAINT expects that request to
        // survive, and clearing afterwards would swallow it.
        record.updateRect = null;
        record.painting = hdc;
        const erase = record.erase === true;
        record.erase = false;
        const frame = record.ncDirty === true;
        record.ncDirty = false;
        if (hdc !== 0)
        {
            const visible = geometry.visibleClientRect(record);
            const origin = geometry.clientRect(record);
            host.draw?.clip?.(hdc, shown(record) ? {
                left: Math.max(dirty.left, visible.left - origin.left),
                top: Math.max(dirty.top, visible.top - origin.top),
                right: Math.min(dirty.right, visible.right - origin.left),
                bottom: Math.min(dirty.bottom, visible.bottom - origin.top),
            } : NOWHERE);
        }
        const result = { hdc, rect: dirty };
        if (hdc === 0)
        {
            return result;
        }
        // Named before the first send: the second one may follow an await,
        // after which the thread on the processor may be another.
        const thread = host.callerThread?.();
        return after(frame ? send(record.hwnd, WM_NCPAINT, 1, 0, thread) : 0,
            ()=>after(erase ? send(record.hwnd, WM_ERASEBKGND, hdc, 0, thread) : 0, ()=>result));
    };

    /** @param {any} record @param {number} hdc */
    const endPaint = (record, hdc)=>{
        if (hdc !== 0)
        {
            contexts()?.release(record.hwnd, hdc);
            painted();
        }
        if (record.painting === hdc)
        {
            record.painting = 0;
        }
    };

    /**
     * An icon's picture drawn at a point, at its own size for a width of 0;
     * one that cannot be drawn is said once and left out.
     *
     * @param {number} hdc @param {number} x @param {number} y @param {number} icon
     * @param {number} width @param {number} height
     */
    const drawIcon = (hdc, x, y, icon, width, height)=>{
        const picture = host.picture?.(icon >>> 0) ?? null;
        if (picture && host.draw?.picture?.(hdc >>> 0, x | 0, y | 0, picture,
            width || picture.width, height || picture.height))
        {
            return;
        }
        if (!iconDivergenceSaid)
        {
            iconDivergenceSaid = true;
            host.divergence?.('DrawIcon', 'an icon without a picture this build can read is'
                + ' left out; the call succeeds');
        }
    };

    /**
     * The character cell of a context's font, for laying text out, and the
     * measure of a string in it; the estimate when the build cannot measure.
     *
     * @param {number} hdc
     * @returns {TextCell & { ascent: number }}
     */
    const cellOf = hdc=>{
        const draw = host.draw;
        const measured = (hdc >>> 0) !== 0 ? draw?.measure?.(hdc >>> 0, 'M') : null;
        return measured && draw
            ? { cellWidth: measured.width, cellHeight: measured.height, ascent: measured.ascent,
                width: text=>draw.measure(hdc >>> 0, text).width }
            : { cellWidth: ESTIMATED_CHAR_WIDTH, cellHeight: ESTIMATED_LINE_HEIGHT,
                ascent: ESTIMATED_LINE_HEIGHT - 4 };
    };

    /**
     * DrawText and DrawTextEx without its parameter block, of either kind of
     * text. DT_CALCRECT measures and writes the rectangle back; anything else
     * draws each line where the layout put it, in the context's own colour and
     * mode.
     *
     * @param {number[]} args @param {boolean} [wide]  UTF-16 text, as the W calls take.
     */
    const drawText = ([hdc, text, count, rect, format], wide = false)=>{
        // A count of -1 means a terminated string; any other count is the
        // string's length, and the text need not be terminated at all -- a
        // caller drawing part of a buffer passes exactly that part.
        const string = (text >>> 0) === 0 || (count | 0) === 0
            ? ''
            : (count | 0) < 0
                ? readText(host, text >>> 0, wide, 0x10000)
                : wide
                    ? String.fromCharCode(...new Uint16Array(
                        host.readMemory(text >>> 0, (count | 0) * 2).slice().buffer))
                    : decodeAnsi(host.readMemory(text >>> 0, count | 0));
        const bounds = (rect >>> 0) === 0
            ? { left: 0, top: 0, right: 0x7fff, bottom: 0x7fff }
            : readRect(host, rect);
        const cell = cellOf(hdc);
        // Measured against an unbounded width when the rectangle is empty,
        // which is how a program asks how wide a string would be.
        const lines = layoutText(string, (format & DT_CALCRECT) !== 0 && isEmpty(bounds)
            ? { ...bounds, right: bounds.left + 0x7fff }
            : bounds, format, cell);
        const widthOf = cell.width ?? ((/** @type {string} */ piece)=>piece.length * cell.cellWidth);
        const widest = lines.reduce((most, line)=>Math.max(most, widthOf(line.text)), 0);
        const height = Math.max(lines.length, 1) * cell.cellHeight;

        if ((format & DT_CALCRECT) !== 0)
        {
            if ((rect >>> 0) !== 0)
            {
                writeRect(host, rect, {
                    left: bounds.left,
                    top: bounds.top,
                    right: (format & DT_WORDBREAK) !== 0 && !isEmpty(bounds)
                        ? bounds.right
                        : bounds.left + widest,
                    bottom: bounds.top + height,
                });
            }
            return height;
        }
        if ((hdc >>> 0) === 0 || !host.draw)
        {
            return 0;
        }
        for (const line of lines)
        {
            host.draw.text(hdc >>> 0, line.x, line.y, line.text, {
                clip: (rect >>> 0) === 0 ? null : bounds, transparent: false,
            });
            if (line.underline !== null)
            {
                const at = line.x + widthOf(line.text.slice(0, line.underline));
                host.draw.fill(hdc >>> 0, { left: at, top: line.y + cell.ascent,
                    right: at + widthOf(line.text[line.underline]),
                    bottom: line.y + cell.ascent + 1 },
                host.draw.textColor?.(hdc >>> 0) ?? 0);
            }
        }
        return height;
    };

    const table = {
        /** HDC GetDC(HWND hWnd) */
        GetDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                return record ? contextOn(record) : contexts()?.get(hwnd >>> 0, null) ?? 0;
            },
        },

        /** int ReleaseDC(HWND hWnd, HDC hDC) */
        ReleaseDC: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, hdc])=>{
                const released = contexts()?.release(hwnd >>> 0, hdc >>> 0) ?? 0;
                if (released)
                {
                    painted();
                }
                return released;
            },
        },

        /**
         * HDC BeginPaint(HWND hWnd, LPPAINTSTRUCT lpPaint)
         *
         * Clearing the update region is the load-bearing part, not the DC.
         * The frame and the background go through the window procedure
         * first, which means guest code may run before this returns.
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
                const erase = record.erase === true;
                return after(beginPaint(record), ({ hdc, rect })=>{
                    writeU32s(host, paintStruct + PAINTSTRUCT.hdc, [hdc, erase ? 1 : 0]);
                    writeRect(host, paintStruct + PAINTSTRUCT.rcPaint, rect);
                    writeU32s(host, paintStruct + PAINTSTRUCT.fRestore, [0, 0]);
                    return hdc;
                });
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
                if (record)
                {
                    endPaint(record, handle);
                }
                else if (handle !== 0)
                {
                    contexts()?.release(hwnd >>> 0, handle);
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
                    (rect >>> 0) === 0 ? clientArea(record) : readRect(host, rect),
                    (erase >>> 0) !== 0);
                return 1;
            },
        },

        /**
         * BOOL InvalidateRgn(HWND hWnd, HRGN hRgn, BOOL bErase)
         *
         * This build's update area is a rectangle, so a region invalidates
         * its bounding rectangle -- all of what it covers, and at most a
         * little more. A null region is the whole client area.
         */
        InvalidateRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, region, erase])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                invalidate(record, regionArea(record, region), (erase >>> 0) !== 0);
                return 1;
            },
        },

        /**
         * BOOL RedrawWindow(HWND hWnd, const RECT *lprcUpdate, HRGN hrgnUpdate,
         *                   UINT flags)
         *
         * The two halves a program combines: RDW_INVALIDATE is InvalidateRect
         * or InvalidateRgn, RDW_VALIDATE is ValidateRect or ValidateRgn, and
         * RDW_UPDATENOW is UpdateWindow -- the window's own, and with
         * RDW_ALLCHILDREN its descendants' after it. RDW_ERASE marks the
         * background for erasing, as bErase does, and RDW_FRAME the frame.
         */
        RedrawWindow: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, rect, region, flags])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const named = (region >>> 0) !== 0 || (rect >>> 0) === 0;
                const area = named ? regionArea(record, region) : readRect(host, rect);
                if ((flags & RDW_INVALIDATE) !== 0)
                {
                    invalidate(record, area, (flags & RDW_ERASE) !== 0);
                    record.ncDirty = record.ncDirty || (flags & RDW_FRAME) !== 0;
                }
                else if ((flags & RDW_VALIDATE) !== 0)
                {
                    validate(record, (rect >>> 0) === 0 && (region >>> 0) === 0 ? null : area);
                }
                if ((flags & RDW_UPDATENOW) === 0)
                {
                    return 1;
                }
                // The window first, then its descendants in order, each sent
                // its WM_PAINT before the next: a parent paints under its
                // children, as the screen shows them.
                const order = (flags & RDW_ALLCHILDREN) !== 0
                    ? [record, ...(descendants?.(record) ?? [])]
                    : [record];
                /** @param {number} index @returns {number | Promise<number>} */
                const next = index=>(index >= order.length
                    ? 1
                    : after(paintNow(order[index]), ()=>next(index + 1)));
                return next(0);
            },
        },

        /**
         * BOOL UpdateWindow(HWND hWnd)
         *
         * WM_PAINT is sent, not posted: the window procedure has painted by
         * the time this returns. A program that creates its window, calls
         * UpdateWindow and then goes straight to drawing its first frame --
         * or to a long load with no pump -- relies on it: a posted paint
         * lands after the frame, over it, or not until the load is done.
         * Nothing to paint is success with nothing sent.
         */
        UpdateWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                return record ? paintNow(record) : 0;
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
         * even in a build with nothing to draw on.
         */
        DrawTextA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>drawText(args),
        },

        /**
         * int DrawTextExA(HDC, LPSTR, int, LPRECT, UINT, LPDRAWTEXTPARAMS)
         *
         * DrawTextA with a parameter block on the end -- margins and a tab
         * width -- which the layout above does not use.
         */
        DrawTextExA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>drawText(args.slice(0, 5)),
        },

        /**
         * int DrawTextW(HDC, LPCWSTR, int cchText, LPRECT, UINT)
         * int DrawTextExW(HDC, LPWSTR, int cchText, LPRECT, UINT, LPDRAWTEXTPARAMS)
         *
         * The same in UTF-16, the count in characters.
         */
        DrawTextW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>drawText(args, true),
        },

        DrawTextExW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>drawText(args.slice(0, 5), true),
        },

        /**
         * int FillRect(HDC hDC, const RECT *lprc, HBRUSH hbr)
         *
         * The brush is a handle the program owns, or a system colour plus
         * one, which is the convention a class background uses too. With
         * nowhere to draw the three rectangle fills report failure, so a
         * program is not told a fill happened that did not.
         */
        FillRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, rect, brush])=>{
                const draw = host.draw;
                if (!draw)
                {
                    return 0;
                }
                const handle = brush >>> 0;
                const area = readRect(host, rect);
                if (handle >= 1 && handle <= SYS_COLOR_BRUSH_LIMIT)
                {
                    return draw.fill(hdc >>> 0, area, draw.sysColor(handle - 1)) ? 1 : 0;
                }
                return draw.fillWith(hdc >>> 0, area, handle) ? 1 : 0;
            },
        },

        /** BOOL InvertRect(HDC hDC, const RECT *lprc) */
        InvertRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, rect])=>(host.draw?.invert(hdc >>> 0, readRect(host, rect)) ? 1 : 0),
        },

        /** BOOL FrameRect(HDC hDC, const RECT *lprc, HBRUSH hbr) */
        FrameRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, rect, brush])=>(host.draw?.frame(hdc >>> 0, readRect(host, rect),
                brush >>> 0) ? 1 : 0),
        },

        /**
         * HDC GetDCEx(HWND hWnd, HRGN hrgnClip, DWORD flags)
         *
         * The flags select a clip region and whether the non-client area is
         * included; DCX_WINDOW is honoured, so a program that paints its own
         * frame draws on it. The region handle is the caller's to destroy
         * either way, which is why nothing is done with it.
         */
        GetDCEx: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, , flags])=>{
                const DCX_WINDOW = 0x1;
                const record = live(hwnd);
                if (!record)
                {
                    return contexts()?.get(hwnd >>> 0, null) ?? 0;
                }
                return contextOn(record, (flags & DCX_WINDOW) !== 0);
            },
        },

        /**
         * HDC GetWindowDC(HWND hWnd)
         *
         * The whole window, frame included: what a program that paints its
         * own caption draws on. The origin is the window's corner.
         */
        GetWindowDC: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const record = live(hwnd);
                return record ? contextOn(record, true) : contexts()?.get(hwnd >>> 0, null) ?? 0;
            },
        },

        /**
         * int GetUpdateRgn(HWND hWnd, HRGN hRgn, BOOL bErase)
         *
         * The caller supplies the region and this fills it in, which needs the
         * object table those regions live in -- gdi32's, which user32 cannot
         * reach. Without the service that bridges them the honest answer is
         * ERROR: reporting a complexity for a region left holding whatever it
         * held before would have the caller clip to the wrong shape.
         */
        GetUpdateRgn: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, region])=>{
                const ERROR = 0;
                const NULLREGION = 1;
                const SIMPLEREGION = 2;
                const record = live(hwnd);
                if (!record || !host.setRegion)
                {
                    return ERROR;
                }
                const dirty = record.updateRect;
                host.setRegion(region >>> 0,
                    dirty ?? { left: 0, top: 0, right: 0, bottom: 0 });
                return dirty ? SIMPLEREGION : NULLREGION;
            },
        },

        /**
         * BOOL DrawEdge(HDC hdc, LPRECT qrc, UINT edge, UINT grfFlags)
         *
         * The four edge styles are two rings of shaded lines each; the
         * border flags choose which sides, and BF_ADJUST shrinks the
         * rectangle by what was drawn, for a caller laying content inside.
         */
        DrawEdge: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hdc, rect, edge, flags])=>{
                const draw = host.draw;
                if (!draw || (rect >>> 0) === 0)
                {
                    return 0;
                }
                const BDR_RAISEDOUTER = 0x1;
                const BDR_SUNKENOUTER = 0x2;
                const BDR_RAISEDINNER = 0x4;
                const BDR_SUNKENINNER = 0x8;
                const BF_LEFT = 0x1;
                const BF_TOP = 0x2;
                const BF_RIGHT = 0x4;
                const BF_BOTTOM = 0x8;
                const BF_MIDDLE = 0x800;
                const BF_ADJUST = 0x2000;
                const COLOR_3DFACE = 15;
                const COLOR_3DSHADOW = 16;
                const COLOR_3DHILIGHT = 20;
                const COLOR_3DDKSHADOW = 21;
                let area = readRect(host, rect);
                /** @param {number} topLeft @param {number} bottomRight */
                const ring = (topLeft, bottomRight)=>{
                    const h = hdc >>> 0;
                    if ((flags & BF_TOP) !== 0)
                    {
                        draw.fill(h, { ...area, bottom: area.top + 1, right: area.right - 1 },
                            draw.sysColor(topLeft));
                    }
                    if ((flags & BF_LEFT) !== 0)
                    {
                        draw.fill(h, { ...area, right: area.left + 1, bottom: area.bottom - 1 },
                            draw.sysColor(topLeft));
                    }
                    if ((flags & BF_BOTTOM) !== 0)
                    {
                        draw.fill(h, { ...area, top: area.bottom - 1 }, draw.sysColor(bottomRight));
                    }
                    if ((flags & BF_RIGHT) !== 0)
                    {
                        draw.fill(h, { ...area, left: area.right - 1 }, draw.sysColor(bottomRight));
                    }
                    area = {
                        left: area.left + ((flags & BF_LEFT) !== 0 ? 1 : 0),
                        top: area.top + ((flags & BF_TOP) !== 0 ? 1 : 0),
                        right: area.right - ((flags & BF_RIGHT) !== 0 ? 1 : 0),
                        bottom: area.bottom - ((flags & BF_BOTTOM) !== 0 ? 1 : 0),
                    };
                };
                if ((edge & BDR_RAISEDOUTER) !== 0)
                {
                    ring(COLOR_3DHILIGHT, COLOR_3DDKSHADOW);
                }
                else if ((edge & BDR_SUNKENOUTER) !== 0)
                {
                    ring(COLOR_3DSHADOW, COLOR_3DHILIGHT);
                }
                if ((edge & BDR_RAISEDINNER) !== 0)
                {
                    ring(COLOR_3DFACE, COLOR_3DSHADOW);
                }
                else if ((edge & BDR_SUNKENINNER) !== 0)
                {
                    ring(COLOR_3DDKSHADOW, COLOR_3DFACE);
                }
                if ((flags & BF_MIDDLE) !== 0)
                {
                    draw.fill(hdc >>> 0, area, draw.sysColor(COLOR_3DFACE));
                }
                if ((flags & BF_ADJUST) !== 0)
                {
                    writeRect(host, rect, area);
                }
                return 1;
            },
        },

        /**
         * BOOL DrawIcon(HDC hDC, int X, int Y, HICON hIcon)
         *
         * The icon at its own size, its transparent pixels leaving what is
         * under them. One whose picture cannot be read -- a standard icon, a
         * form the decoder does not take -- is left out and the call still
         * succeeds, because a program draws an icon for decoration and stops
         * for nothing if the decoration is refused. Said once per run, since a
         * progress display draws its icon on every tick.
         */
        DrawIcon: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hdc, x, y, icon])=>{
                drawIcon(hdc, x, y, icon, 0, 0);
                return 1;
            },
        },

        /**
         * BOOL DrawIconEx(HDC hdc, int xLeft, int yTop, HICON hIcon, int cxWidth,
         *   int cyWidth, UINT istepIfAniCur, HBRUSH hbrFlickerFreeDraw, UINT diFlags)
         *
         * DrawIcon at the size asked for: a width or height of zero is the
         * icon's own, or the system's icon size with DI_DEFAULTSIZE. A brush
         * fills the rectangle first, as the flicker-free form draws over it;
         * flags asking for neither the image nor the mask draw nothing.
         */
        DrawIconEx: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([hdc, x, y, icon, width, height, step, brush, flags])=>{
                void step;
                const DI_NORMAL = 0x0003;
                const DI_DEFAULTSIZE = 0x0008;
                const SYSTEM_ICON = 32;
                if ((flags & DI_NORMAL) === 0)
                {
                    return 0;
                }
                const size = (/** @type {number} */ asked, /** @type {number} */ own)=>((asked | 0) > 0
                    ? asked | 0 : (flags & DI_DEFAULTSIZE) !== 0 ? SYSTEM_ICON : own);
                const picture = host.picture?.(icon >>> 0) ?? null;
                const w = size(width, picture?.width ?? SYSTEM_ICON);
                const h = size(height, picture?.height ?? SYSTEM_ICON);
                if ((brush >>> 0) !== 0)
                {
                    host.draw?.fillWith?.(hdc >>> 0,
                        { left: x | 0, top: y | 0, right: (x | 0) + w, bottom: (y | 0) + h },
                        brush >>> 0);
                }
                drawIcon(hdc, x, y, icon, w, h);
                return 1;
            },
        },

        /**
         * BOOL DrawFocusRect(HDC hDC, const RECT *lprc)
         *
         * The focus rectangle is drawn by inverting, which is what makes
         * drawing it twice erase it. Without somewhere to invert, failing is
         * the only answer that does not leave a program believing it has a
         * rectangle it must later remove.
         */
        DrawFocusRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, rect])=>{
                const draw = host.draw;
                if (!draw)
                {
                    return 0;
                }
                const area = readRect(host, rect);
                const h = hdc >>> 0;
                return draw.invert(h, { ...area, bottom: area.top + 1 })
                    && draw.invert(h, { ...area, top: area.bottom - 1 })
                    && draw.invert(h, { ...area, top: area.top + 1, bottom: area.bottom - 1,
                        right: area.left + 1 })
                    && draw.invert(h, { ...area, top: area.top + 1, bottom: area.bottom - 1,
                        left: area.right - 1 }) ? 1 : 0;
            },
        },

        /**
         * BOOL ValidateRect(HWND hWnd, const RECT *lpRect)
         *
         * A null rectangle validates everything. Otherwise the rectangle is
         * taken out of the update area as far as what is left is still a
         * rectangle -- see `subtract` -- so a program that paints a strip
         * itself and validates it is not sent a WM_PAINT for that strip.
         */
        ValidateRect: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, rect])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                validate(record, (rect >>> 0) === 0 ? null : readRect(host, rect));
                return 1;
            },
        },

        /**
         * BOOL LockWindowUpdate(HWND hWndLock)
         *
         * One window at a time: while one is locked, locking any fails, and a
         * null window unlocks. Drawing into the locked window is not held
         * back -- a program locks one against flicker while it changes it, and
         * the picture it ends with is the same.
         */
        LockWindowUpdate: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const window = hwnd >>> 0;
                if (window === 0)
                {
                    lockedWindow = 0;
                    return 1;
                }
                if (lockedWindow !== 0 || !live(window))
                {
                    return 0;
                }
                lockedWindow = window;
                host.divergence?.('LockWindowUpdate', 'drawing is not held back while locked');
                return 1;
            },
        },

        /** BOOL ValidateRgn(HWND hWnd, HRGN hRgn) */
        ValidateRgn: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, region])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                validate(record, (region >>> 0) === 0
                    ? null
                    : host.regionBox?.(region >>> 0) ?? null);
                return 1;
            },
        },
    };

    return { table, beginPaint, endPaint, invalidate, clientArea, cellOf, contextOn };
}

/** A brush argument up to this is a system colour index plus one. */
const SYS_COLOR_BRUSH_LIMIT = 31;

/** The offsets a test asserts against, so a change to the layout is visible. */
export const PAINT_LAYOUT = Object.freeze({ PAINTSTRUCT, RECT });

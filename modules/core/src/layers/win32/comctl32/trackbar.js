/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The trackbar, `msctls_trackbar32`.
 *
 * A range, a position in it, and a thumb on a channel that a person drags or
 * steps with the keys. Unlike a scroll bar the control moves its own
 * position and then tells the parent -- WM_HSCROLL, or WM_VSCROLL for a
 * TBS_VERT one, the control's window in lParam -- so a parent that ignores
 * the message still reads the new position with TBM_GETPOS.
 *
 * What a program meets first is not the picture but the class itself: a
 * window toolkit that superclasses every control it uses asks for the class
 * by name with GetClassInfoEx before it creates anything, and a class that
 * does not exist is an assertion, not a missing slider.
 *
 * Defaults are the ones Windows answers (Wine's conformance tests): a range
 * of 0..100, position 0, a line of 1, a page of a fifth of the range until
 * one is set, a tic every 1. The thumb is placed when the position is set
 * with a redraw, the range changes with one, the tic frequency changes, the
 * window is sized or a person moves it; a TBM_SETPOS without a redraw moves
 * the position and leaves the thumb where it was (Wine's trackbar test,
 * test_position and test_tic_settings).
 */

import {
    WM_PAINT, WM_ERASEBKGND, WM_GETDLGCODE, WM_KEYDOWN, WM_KEYUP,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_CAPTURECHANGED, WM_HSCROLL, WM_VSCROLL,
    WM_CTLCOLORSTATIC, COLOR_3DFACE, COLOR_3DSHADOW, COLOR_3DHILIGHT, COLOR_HIGHLIGHT,
    COLOR_BTNTEXT, after,
} from '../user32/controls.js';
import { notifyWindow } from './notify.js';

/** The class name a program creates the control by. */
export const TRACKBAR_CLASS = 'msctls_trackbar32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const TRACKBAR_ATOM = 0x8015;

/** Styles. */
export const TBS_AUTOTICKS = 0x0001;
export const TBS_VERT = 0x0002;
export const TBS_NOTICKS = 0x0010;
export const TBS_ENABLESELRANGE = 0x0020;
export const TBS_FIXEDLENGTH = 0x0040;
const TBS_NOTHUMB = 0x0080;

/** Messages, numbered off WM_USER as the header numbers them. */
const WM_USER = 0x0400;
export const TBM_GETPOS = WM_USER;
export const TBM_GETRANGEMIN = WM_USER + 1;
export const TBM_GETRANGEMAX = WM_USER + 2;
export const TBM_GETTIC = WM_USER + 3;
export const TBM_SETTIC = WM_USER + 4;
export const TBM_SETPOS = WM_USER + 5;
export const TBM_SETRANGE = WM_USER + 6;
export const TBM_SETRANGEMIN = WM_USER + 7;
export const TBM_SETRANGEMAX = WM_USER + 8;
export const TBM_CLEARTICS = WM_USER + 9;
export const TBM_SETSEL = WM_USER + 10;
export const TBM_SETSELSTART = WM_USER + 11;
export const TBM_SETSELEND = WM_USER + 12;
export const TBM_GETPTICS = WM_USER + 14;
export const TBM_GETTICPOS = WM_USER + 15;
export const TBM_GETNUMTICS = WM_USER + 16;
export const TBM_GETSELSTART = WM_USER + 17;
export const TBM_GETSELEND = WM_USER + 18;
export const TBM_CLEARSEL = WM_USER + 19;
export const TBM_SETTICFREQ = WM_USER + 20;
export const TBM_SETPAGESIZE = WM_USER + 21;
export const TBM_GETPAGESIZE = WM_USER + 22;
export const TBM_SETLINESIZE = WM_USER + 23;
export const TBM_GETLINESIZE = WM_USER + 24;
export const TBM_GETTHUMBRECT = WM_USER + 25;
export const TBM_GETCHANNELRECT = WM_USER + 26;
export const TBM_SETTHUMBLENGTH = WM_USER + 27;
export const TBM_GETTHUMBLENGTH = WM_USER + 28;
const TBM_SETTOOLTIPS = WM_USER + 29;
const TBM_GETTOOLTIPS = WM_USER + 30;
const TBM_SETTIPSIDE = WM_USER + 31;
export const TBM_SETBUDDY = WM_USER + 32;
export const TBM_GETBUDDY = WM_USER + 33;
const TBM_SETUNICODEFORMAT = 0x2005;
const TBM_GETUNICODEFORMAT = 0x2006;
const WM_SIZE = 0x0005;
/** The page TBM_SETPAGESIZE sets to have a fifth of the range again. */
const PAGE_DEFAULT = -1;

/** The codes a WM_HSCROLL from a trackbar carries in its low word. */
export const TB_LINEUP = 0;
export const TB_LINEDOWN = 1;
const TB_PAGEUP = 2;
export const TB_PAGEDOWN = 3;
export const TB_THUMBPOSITION = 4;
export const TB_THUMBTRACK = 5;
export const TB_TOP = 6;
export const TB_BOTTOM = 7;
export const TB_ENDTRACK = 8;

const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;
const VK_END = 0x23;
const VK_HOME = 0x24;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const DLGC_WANTARROWS = 0x0001;

/** The classic look: a thumb this long across the channel, this wide along it. */
const THUMB_LENGTH = 21;
const THUMB_WIDTH = 11;
/** The channel's breadth, its sunken edge included. */
const CHANNEL_BREADTH = 4;
const TIC_LENGTH = 3;

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 */

/**
 * Builds the window procedure of a trackbar.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createTrackbarProcedure(host, tk){
    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        held.min ??= 0;
        held.max ??= 100;
        held.pos ??= 0;
        held.line ??= 1;
        held.page ??= PAGE_DEFAULT;
        held.freq ??= 1;
        held.selStart ??= 0;
        held.selEnd ??= 0;
        held.thumbLength ??= THUMB_LENGTH;
        /** @type {number[]} */
        held.tics ??= [];
        held.dragging ??= false;
        /** @type {Rect | null} where the thumb was last placed */
        held.thumb ??= null;
        held.buddies ??= { left: 0, right: 0 };
        held.tooltips ??= 0;
        held.tipSide ??= 0;
        held.unicode ??= false;
        return held;
    };

    /** The page a PgUp or PgDn moves by. @param {any} held */
    const pageOf = held=>(held.page === PAGE_DEFAULT ? Math.trunc((held.max - held.min) / 5)
        : held.page);

    /**
     * An auto-ticked bar's tics are one every `freq` strictly inside the
     * range, made again when the range or the frequency changes and not
     * before (Wine's trackbar test_TBS_AUTOTICKS: a new bar counts only its
     * two ends).
     *
     * @param {any} record
     */
    const autoTics = record=>{
        const held = state(record);
        if ((record.style & TBS_AUTOTICKS) === 0)
        {
            return;
        }
        held.tics = [];
        for (let pos = held.min + held.freq; held.freq > 0 && pos < held.max; pos += held.freq)
        {
            held.tics.push(pos);
        }
    };

    /**
     * A range set: the position follows it, the tics too, and the thumb
     * with a redraw.
     *
     * @param {any} record @param {number} redraw
     */
    const ranged = (record, redraw)=>{
        const held = state(record);
        held.pos = clamp(held, held.pos);
        autoTics(record);
        if (redraw !== 0)
        {
            held.thumb = null;
            host.invalidate(record);
        }
    };

    /** Whether the bar keeps a selection at all. @param {any} record */
    const selects = record=>(record.style & TBS_ENABLESELRANGE) !== 0;

    /** @param {any} held @param {number} pos */
    const clamp = (held, pos)=>Math.min(Math.max(pos, held.min), Math.max(held.min, held.max));

    /** @param {any} record */
    const vertical = record=>(record.style & TBS_VERT) !== 0;

    /**
     * The channel and the thumb in client pixels. The channel runs between
     * the points the thumb's centre can reach, half a thumb in from each end.
     *
     * @param {any} record
     * @returns {{ channel: Rect, thumb: Rect, along: (pos: number) => number,
     *     at: (pixel: number) => number }}
     */
    const layout = record=>{
        const held = state(record);
        const client = tk.clientRect(record);
        const turned = vertical(record);
        const length = turned ? client.bottom : client.right;
        const breadth = turned ? client.right : client.bottom;
        const thumbLength = Math.max(1, Math.min(held.thumbLength, breadth - 4));
        const from = Math.ceil(THUMB_WIDTH / 2) + 2;
        const to = Math.max(from, length - from);
        const across = Math.max(0, Math.floor((breadth - thumbLength) / 2));
        const middle = across + Math.floor(thumbLength / 2);
        const range = held.max - held.min;
        /** @param {number} pos */
        const along = pos=>(range <= 0 ? from
            : from + Math.round((pos - held.min) * (to - from) / range));
        /** @param {number} pixel */
        const at = pixel=>(to <= from ? held.min
            : clamp(held, held.min + Math.round((pixel - from) * range / (to - from))));
        const centre = along(held.pos);
        const half = Math.floor(THUMB_WIDTH / 2);
        /** @param {number} a0 @param {number} a1 @param {number} b0 @param {number} b1 */
        const box = (a0, a1, b0, b1)=>(turned
            ? { left: b0, top: a0, right: b1, bottom: a1 }
            : { left: a0, top: b0, right: a1, bottom: b1 });
        held.thumb ??= box(centre - half, centre + half + 1, across, across + thumbLength);
        const channelFrom = middle - Math.floor(CHANNEL_BREADTH / 2);
        return {
            channel: box(from - 2, to + 2, channelFrom, channelFrom + CHANNEL_BREADTH),
            thumb: /** @type {Rect} */ (held.thumb),
            along,
            at,
        };
    };

    /**
     * Tells the parent the position moved, the way the real control does:
     * after it has moved it.
     *
     * @param {any} record @param {number} code @param {unknown} thread
     */
    const tell = (record, code, thread)=>{
        if (!notifyWindow(record))
        {
            return 0;
        }
        const wParam = code === TB_THUMBTRACK || code === TB_THUMBPOSITION
            ? ((state(record).pos & 0xffff) << 16 | code) >>> 0
            : code;
        return host.send(notifyWindow(record), vertical(record) ? WM_VSCROLL : WM_HSCROLL,
            wParam, record.hwnd, thread);
    };

    /**
     * Moves the position and, if it moved, repaints and tells the parent.
     *
     * @param {any} record @param {number} pos @param {number} code @param {unknown} thread
     */
    const step = (record, pos, code, thread)=>{
        const held = state(record);
        const previous = held.pos;
        held.pos = clamp(held, pos);
        if (held.pos === previous)
        {
            return 0;
        }
        held.thumb = null;
        host.invalidate(record);
        return tell(record, code, thread);
    };

    /** @param {any} record @param {number} hdc @param {number} brush */
    const paintTrackbar = (record, hdc, brush)=>{
        const draw = /** @type {any} */ (host.draw);
        const held = state(record);
        const turned = vertical(record);
        const { channel, thumb, along } = layout(record);
        tk.background(hdc, tk.clientRect(record), brush, COLOR_3DFACE);
        tk.edge(hdc, channel, tk.color(COLOR_3DSHADOW), tk.color(COLOR_3DHILIGHT));
        if ((record.style & TBS_ENABLESELRANGE) !== 0 && held.selEnd > held.selStart)
        {
            const a = along(held.selStart);
            const b = along(held.selEnd);
            draw.fill(hdc, turned
                ? { left: channel.left + 1, top: a, right: channel.right - 1, bottom: b }
                : { left: a, top: channel.top + 1, right: b, bottom: channel.bottom - 1 },
            tk.color(COLOR_HIGHLIGHT));
        }
        if ((record.style & TBS_NOTICKS) === 0)
        {
            const marks = new Set([held.min, held.max, ...held.tics]);
            const base = turned ? thumb.right + 1 : thumb.bottom + 1;
            for (const pos of marks)
            {
                const x = along(pos);
                draw.fill(hdc, turned
                    ? { left: base, top: x, right: base + TIC_LENGTH, bottom: x + 1 }
                    : { left: x, top: base, right: x + 1, bottom: base + TIC_LENGTH },
                tk.color(COLOR_BTNTEXT));
            }
        }
        if ((record.style & TBS_NOTHUMB) === 0)
        {
            draw.fill(hdc, tk.shrink(thumb, 1), tk.color(COLOR_3DFACE));
            tk.buttonEdge(hdc, thumb, false);
        }
    };

    /** @param {number} lParam */
    const pointOf = lParam=>({ x: (lParam << 16) >> 16, y: lParam >> 16 });

    /** @param {Rect} rect @param {{ x: number, y: number }} point */
    const inside = (rect, point)=>point.x >= rect.left && point.x < rect.right
        && point.y >= rect.top && point.y < rect.bottom;

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        switch (message.message){
            case WM_PAINT:
                // The background is the parent's to choose, as a static's is.
                return tk.painting(record, (/** @type {number} */ hdc)=>after(
                    tk.controlColor(record, WM_CTLCOLORSTATIC, hdc, thread),
                    (/** @type {number} */ brush)=>{
                        paintTrackbar(record, hdc, brush);
                        return 0;
                    }));
            case WM_ERASEBKGND:
                return 1;
            case WM_SIZE:
                held.thumb = null;
                return tk.common(record, message, thread);
            case WM_GETDLGCODE:
                return DLGC_WANTARROWS;
            case WM_KEYDOWN: {
                const key = message.wParam >>> 0;
                switch (key){
                    case VK_LEFT: case VK_UP:
                        return step(record, held.pos - held.line, TB_LINEUP, thread);
                    case VK_RIGHT: case VK_DOWN:
                        return step(record, held.pos + held.line, TB_LINEDOWN, thread);
                    case VK_PRIOR:
                        return step(record, held.pos - pageOf(held), TB_PAGEUP, thread);
                    case VK_NEXT:
                        return step(record, held.pos + pageOf(held), TB_PAGEDOWN, thread);
                    case VK_HOME:
                        return step(record, held.min, TB_TOP, thread);
                    case VK_END:
                        return step(record, held.max, TB_BOTTOM, thread);
                    default:
                        return tk.common(record, message, thread);
                }
            }
            case WM_KEYUP: {
                const key = message.wParam >>> 0;
                return key >= VK_PRIOR && key <= VK_DOWN
                    ? tell(record, TB_ENDTRACK, thread)
                    : tk.common(record, message, thread);
            }
            case WM_LBUTTONDOWN: {
                const point = pointOf(message.lParam);
                const { thumb, along } = layout(record);
                return after(host.setFocus(record.hwnd, thread), ()=>{
                    host.setCapture(record.hwnd);
                    if (inside(thumb, point) && (record.style & TBS_NOTHUMB) === 0)
                    {
                        held.dragging = true;
                        return 0;
                    }
                    held.paging = true;
                    const pixel = vertical(record) ? point.y : point.x;
                    return pixel < along(held.pos)
                        ? step(record, held.pos - pageOf(held), TB_PAGEUP, thread)
                        : step(record, held.pos + pageOf(held), TB_PAGEDOWN, thread);
                });
            }
            case WM_MOUSEMOVE: {
                if (!held.dragging)
                {
                    return 0;
                }
                const point = pointOf(message.lParam);
                return step(record, layout(record).at(vertical(record) ? point.y : point.x),
                    TB_THUMBTRACK, thread);
            }
            case WM_LBUTTONUP: {
                const dragged = held.dragging;
                const paged = held.paging;
                held.dragging = false;
                held.paging = false;
                if (host.capture() === record.hwnd)
                {
                    host.releaseCapture();
                }
                if (!dragged && !paged)
                {
                    return 0;
                }
                return after(dragged ? tell(record, TB_THUMBPOSITION, thread) : 0,
                    ()=>tell(record, TB_ENDTRACK, thread));
            }
            case WM_CAPTURECHANGED:
                held.dragging = false;
                held.paging = false;
                return 0;
            case TBM_GETPOS:
                return held.pos;
            case TBM_GETRANGEMIN:
                return held.min;
            case TBM_GETRANGEMAX:
                return held.max;
            case TBM_SETPOS: {
                const previous = held.pos;
                held.pos = clamp(held, message.lParam | 0);
                if ((message.wParam >>> 0) !== 0 && held.pos !== previous)
                {
                    held.thumb = null;
                    host.invalidate(record);
                }
                return 0;
            }
            case TBM_SETRANGE:
                // Two signed words, as the header's MAKELONG of two shorts.
                held.min = (message.lParam << 16) >> 16;
                held.max = message.lParam >> 16;
                ranged(record, message.wParam);
                return 0;
            case TBM_SETRANGEMIN:
                held.min = message.lParam | 0;
                ranged(record, message.wParam);
                return 0;
            case TBM_SETRANGEMAX:
                held.max = message.lParam | 0;
                ranged(record, message.wParam);
                return 0;
            case TBM_SETPAGESIZE: {
                // The answer is the page in effect; -1 has the fifth back.
                const previous = pageOf(held);
                held.page = message.lParam | 0;
                return previous;
            }
            case TBM_GETPAGESIZE:
                return pageOf(held);
            case TBM_SETLINESIZE: {
                const previous = held.line;
                held.line = message.lParam | 0;
                return previous;
            }
            case TBM_GETLINESIZE:
                return held.line;
            case TBM_SETTICFREQ:
                held.freq = message.wParam | 0;
                autoTics(record);
                held.thumb = null;
                host.invalidate(record);
                return 0;
            case TBM_SETTIC: {
                // A tic outside the range is refused; the two ends have
                // theirs already.
                const pos = message.lParam | 0;
                if (pos < held.min || pos > held.max)
                {
                    return 0;
                }
                held.tics.push(pos);
                held.tics.sort((/** @type {number} */ a, /** @type {number} */ b)=>a - b);
                host.invalidate(record);
                return 1;
            }
            case TBM_GETTIC: {
                const index = message.wParam | 0;
                return index >= 0 && index < held.tics.length ? held.tics[index] : -1;
            }
            case TBM_GETTICPOS: {
                const index = message.wParam | 0;
                return index >= 0 && index < held.tics.length
                    ? layout(record).along(held.tics[index]) : -1;
            }
            case TBM_GETPTICS: {
                // The array is the bar's, good until the tics change; a new
                // one is taken when they outgrow it.
                if (held.tics.length === 0)
                {
                    return 0;
                }
                if (!held.ticArray || held.ticArray.capacity < held.tics.length)
                {
                    const capacity = Math.max(16, held.tics.length);
                    const address = host.allocate?.(capacity * 4) ?? 0;
                    if (address === 0)
                    {
                        host.divergence?.('TBM_GETPTICS', 'no memory for the tics: NULL');
                        return 0;
                    }
                    held.ticArray = { address, capacity };
                }
                held.tics.forEach((/** @type {number} */ pos, /** @type {number} */ at)=>
                    host.guest.set32(held.ticArray.address + at * 4, pos));
                return held.ticArray.address;
            }
            case TBM_CLEARTICS:
                held.tics = [];
                host.invalidate(record);
                return 0;
            case TBM_GETNUMTICS:
                // The ends count, beside every tic set on the way.
                return (record.style & TBS_NOTICKS) !== 0 ? 0 : held.tics.length + 2;
            // A selection is kept only with TBS_ENABLESELRANGE; SETSEL keeps
            // both ends in the range, SETSELSTART only the start above the
            // bottom and SETSELEND only the end below the top (Wine's
            // trackbar test_selection and test_ignore_selection).
            case TBM_SETSEL:
                if (selects(record))
                {
                    held.selStart = clamp(held, (message.lParam << 16) >> 16);
                    held.selEnd = clamp(held, message.lParam >> 16);
                    host.invalidate(record);
                }
                return 0;
            case TBM_SETSELSTART:
                if (selects(record))
                {
                    held.selStart = Math.max(held.min, message.lParam | 0);
                    host.invalidate(record);
                }
                return 0;
            case TBM_SETSELEND:
                if (selects(record))
                {
                    held.selEnd = Math.min(held.max, message.lParam | 0);
                    host.invalidate(record);
                }
                return 0;
            case TBM_GETSELSTART:
                return held.selStart;
            case TBM_GETSELEND:
                return held.selEnd;
            case TBM_CLEARSEL:
                held.selStart = 0;
                held.selEnd = 0;
                host.invalidate(record);
                return 0;
            case TBM_GETTHUMBRECT:
            case TBM_GETCHANNELRECT: {
                const out = message.lParam >>> 0;
                if (out !== 0)
                {
                    const { channel, thumb } = layout(record);
                    const rect = message.message === TBM_GETTHUMBRECT ? thumb : channel;
                    host.guest.set32(out, rect.left);
                    host.guest.set32(out + 4, rect.top);
                    host.guest.set32(out + 8, rect.right);
                    host.guest.set32(out + 12, rect.bottom);
                }
                return 0;
            }
            case TBM_SETTHUMBLENGTH:
                // Only a fixed-length thumb takes a length of the program's.
                if ((record.style & TBS_FIXEDLENGTH) !== 0)
                {
                    held.thumbLength = message.wParam >>> 0;
                    held.thumb = null;
                    host.invalidate(record);
                }
                return 0;
            case TBM_GETTHUMBLENGTH:
                return held.thumbLength;
            case TBM_SETTOOLTIPS:
                held.tooltips = message.wParam >>> 0;
                return 0;
            case TBM_GETTOOLTIPS:
                return held.tooltips;
            case TBM_SETTIPSIDE: {
                const previous = held.tipSide;
                held.tipSide = message.wParam | 0;
                return previous;
            }
            case TBM_SETBUDDY: {
                // TRUE is the buddy at the left or top, FALSE the other end.
                const side = message.wParam !== 0 ? 'left' : 'right';
                const previous = held.buddies[side];
                held.buddies[side] = message.lParam >>> 0;
                if (held.buddies[side] !== 0)
                {
                    host.divergence?.('TBM_SETBUDDY',
                        'the buddy is kept, not moved beside the bar');
                }
                return previous;
            }
            case TBM_GETBUDDY:
                return held.buddies[message.wParam !== 0 ? 'left' : 'right'];
            case TBM_SETUNICODEFORMAT: {
                const previous = held.unicode ? 1 : 0;
                held.unicode = message.wParam !== 0;
                return previous;
            }
            case TBM_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            default:
                return tk.common(record, message, thread);
        }
    };
}

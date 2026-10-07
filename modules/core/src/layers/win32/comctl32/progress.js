/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The progress bar, `msctls_progress32`.
 *
 * A range, a position in it and a step, and a rectangle that shows how far
 * along the position is. That is the whole of it: nothing is typed into it,
 * nothing is selected, and the only thing a program reads back is what it put
 * in. What makes it worth being a control at all is the look -- the sunken
 * track and the fill that grows -- because a copy that reports its progress
 * only in numbers is a copy a person cannot watch.
 *
 * The fill is drawn two ways and a style chooses: the default lays it down as
 * blocks with a gap between them, PBS_SMOOTH as one rectangle. A vertical bar
 * (PBS_VERTICAL) is the same picture turned a quarter turn, filling from the
 * bottom. The colours are the system's until PBM_SETBARCOLOR or
 * PBM_SETBKCOLOR replaces one with a colour of the program's own.
 *
 * The classic look, which Wine's control draws the same: the bar takes a
 * static edge in place of any client or window edge it was created with --
 * the thin sunken line around it, part of its frame -- and inside it one
 * pixel of track all round. A block is two thirds of the track's breadth,
 * two pixels apart, and the fill ends on a whole block: a position a pixel
 * into one shows all of it.
 */

import {
    WM_CREATE, WM_PAINT, WM_ERASEBKGND,
    COLOR_3DFACE, COLOR_HIGHLIGHT, after,
} from '../user32/controls.js';
import { mulDiv } from '../kernel32/system.js';

const WS_EX_WINDOWEDGE = 0x00000100;
const WS_EX_CLIENTEDGE = 0x00000200;
const WS_EX_STATICEDGE = 0x00020000;

/** The class name a program creates the control by. */
export const PROGRESS_CLASS = 'msctls_progress32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const PROGRESS_ATOM = 0x8010;

/** Styles. */
export const PBS_SMOOTH = 0x01;
export const PBS_VERTICAL = 0x04;

/** Messages, numbered off WM_USER as the header numbers them. */
const WM_USER = 0x0400;
export const PBM_SETRANGE = WM_USER + 1;
export const PBM_SETPOS = WM_USER + 2;
export const PBM_DELTAPOS = WM_USER + 3;
export const PBM_SETSTEP = WM_USER + 4;
export const PBM_STEPIT = WM_USER + 5;
export const PBM_SETRANGE32 = WM_USER + 6;
export const PBM_GETRANGE = WM_USER + 7;
export const PBM_GETPOS = WM_USER + 8;
export const PBM_SETBARCOLOR = WM_USER + 9;
/** The background colour travels under the common-controls message number. */
export const PBM_SETBKCOLOR = 0x2001;

/** PBRANGE, what PBM_GETRANGE fills in. */
const PBRANGE = Object.freeze({ iLow: 0, iHigh: 4, SIZE: 8 });

/** The gap between blocks. */
const BLOCK_GAP = 2;

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 */

/**
 * Builds the window procedure of a progress bar.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createProgressProcedure(host, tk){
    /** @param {any} record */
    const state = record=>{
        const held = tk.stateOf(record);
        held.min ??= 0;
        held.max ??= 100;
        held.pos ??= 0;
        held.step ??= 10;
        return held;
    };

    /** @param {any} record @param {number} pos */
    const clamp = (record, pos)=>Math.min(Math.max(pos, state(record).min), state(record).max);

    /**
     * A new position shown at once: the real control updates its window when
     * the position moves, and a copy loop that never looks at its queue has
     * a bar that grows. A position that did not move paints nothing, as there
     * -- a setup copying a kilobyte at a time sets the same position after
     * every one. Answers what the message answers.
     *
     * @param {any} record @param {number} previous
     */
    const moved = (record, previous)=>{
        if (state(record).pos === previous)
        {
            return previous;
        }
        host.invalidate(record);
        return after(host.update?.(record) ?? 1, ()=>previous);
    };

    /**
     * The track, the fill along it from the start to `end` pixels -- block,
     * gap, block, the last cut off at the end -- and nothing past it.
     *
     * @param {number} hdc @param {Rect} track @param {boolean} vertical
     * @param {number} end @param {number} block  Zero for one rectangle.
     * @param {number} rgb
     */
    const fill = (hdc, track, vertical, end, block, rgb)=>{
        const draw = /** @type {any} */ (host.draw);
        /** @param {number} from @param {number} to pixels along the track */
        const span = (from, to)=>(vertical
            ? { ...track, top: track.bottom - to, bottom: track.bottom - from }
            : { ...track, left: track.left + from, right: track.left + to });
        const length = block > 0 ? block : end;
        for (let at = 0; at < end; at += length + BLOCK_GAP)
        {
            draw.fill(hdc, span(at, Math.min(at + length, end)), rgb);
        }
    };

    /**
     * @param {any} record @param {number} hdc @param {Rect} rect
     */
    const paintProgress = (record, hdc, rect)=>{
        const draw = /** @type {any} */ (host.draw);
        const held = state(record);
        const vertical = (record.style & PBS_VERTICAL) !== 0;
        const smooth = (record.style & PBS_SMOOTH) !== 0;
        draw.fill(hdc, rect, held.bkColor ?? tk.color(COLOR_3DFACE));
        const track = tk.shrink(rect, 1);
        const size = vertical ? track.bottom - track.top : track.right - track.left;
        const breadth = vertical ? track.right - track.left : track.bottom - track.top;
        const range = held.max - held.min;
        let end = range <= 0 || size <= 0 ? 0
            : mulDiv(held.pos - held.min, size, range) | 0;
        const block = smooth ? 0 : Math.max(1, mulDiv(breadth, 2, 3) | 0);
        if (!smooth)
        {
            const pitch = block + BLOCK_GAP;
            end = Math.min(Math.ceil(end / pitch) * pitch, size);
        }
        fill(hdc, track, vertical, end, block, held.barColor ?? tk.color(COLOR_HIGHLIGHT));
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        switch (message.message){
            case WM_CREATE:
                record.exStyle = ((record.exStyle & ~(WS_EX_CLIENTEDGE | WS_EX_WINDOWEDGE))
                    | WS_EX_STATICEDGE) >>> 0;
                return tk.common(record, message, thread);
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    paintProgress(record, hdc, tk.clientRect(record));
                    return 0;
                });
            case WM_ERASEBKGND:
                // The paint covers the whole client area, track and fill
                // together, so there is no background to erase first.
                return 1;
            case PBM_SETRANGE: {
                const previous = ((held.max & 0xffff) << 16 | held.min & 0xffff) >>> 0;
                held.min = message.lParam << 16 >> 16;
                held.max = message.lParam >> 16;
                held.pos = clamp(record, held.pos);
                host.invalidate(record);
                return previous;
            }
            case PBM_SETRANGE32: {
                const previous = held.min;
                held.min = message.wParam | 0;
                held.max = message.lParam | 0;
                held.pos = clamp(record, held.pos);
                host.invalidate(record);
                return previous;
            }
            case PBM_SETPOS: {
                const previous = held.pos;
                held.pos = clamp(record, message.wParam | 0);
                return moved(record, previous);
            }
            case PBM_DELTAPOS: {
                const previous = held.pos;
                held.pos = clamp(record, held.pos + (message.wParam | 0));
                return moved(record, previous);
            }
            case PBM_SETSTEP: {
                const previous = held.step;
                held.step = message.wParam | 0;
                return previous;
            }
            case PBM_STEPIT: {
                const previous = held.pos;
                const span = held.max - held.min;
                let next = held.pos + held.step;
                // A step past the top comes back around at the bottom, which
                // is what a loop that steps once a pass expects.
                if (span > 0 && next > held.max)
                {
                    next = held.min + (next - held.max - 1) % (span + 1);
                }
                held.pos = clamp(record, next);
                return moved(record, previous);
            }
            case PBM_GETPOS:
                return held.pos;
            case PBM_GETRANGE: {
                const out = message.lParam >>> 0;
                if (out !== 0)
                {
                    tk.writeU32(out + PBRANGE.iLow, held.min);
                    tk.writeU32(out + PBRANGE.iHigh, held.max);
                }
                return held.pos;
            }
            case PBM_SETBARCOLOR: {
                const previous = held.barColor ?? tk.color(COLOR_HIGHLIGHT);
                held.barColor = message.wParam >>> 0;
                host.invalidate(record);
                return previous;
            }
            case PBM_SETBKCOLOR: {
                const previous = held.bkColor ?? tk.color(COLOR_3DFACE);
                held.bkColor = message.wParam >>> 0;
                host.invalidate(record);
                return previous;
            }
            default:
                return tk.common(record, message, thread);
        }
    };
}

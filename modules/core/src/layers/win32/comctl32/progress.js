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
 */

import {
    WM_PAINT, WM_ERASEBKGND,
    COLOR_3DFACE, COLOR_HIGHLIGHT, after,
} from '../user32/controls.js';

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

/** The gap between blocks, and the share of the cross-size a block takes. */
const BLOCK_GAP = 2;
const BLOCK_SHARE = 2 / 3;

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
     * a bar that grows. Answers what the message answers.
     *
     * @param {any} record @param {number} previous
     */
    const moved = (record, previous)=>{
        host.invalidate(record);
        return after(host.update?.(record) ?? 1, ()=>previous);
    };

    /**
     * The track the fill sits in: the client area less the sunken edge that
     * bounds it.
     *
     * @param {Rect} rect
     * @returns {Rect}
     */
    const trackOf = rect=>tk.shrink(rect, 2);

    /**
     * The fill, laid down as blocks or as one rectangle, along or up the
     * track according to the orientation.
     *
     * @param {number} hdc @param {Rect} track @param {boolean} vertical
     * @param {number} fraction  How much of the track is filled, 0..1.
     * @param {number} cross  The track's size across the fill direction.
     * @param {number} rgb @param {boolean} smooth
     */
    const fill = (hdc, track, vertical, fraction, cross, rgb, smooth)=>{
        const draw = /** @type {any} */ (host.draw);
        const along = vertical ? track.bottom - track.top : track.right - track.left;
        const filled = Math.round(along * fraction);
        if (smooth)
        {
            const bar = vertical
                ? { ...track, top: track.bottom - filled }
                : { ...track, right: track.left + filled };
            if (filled > 0)
            {
                draw.fill(hdc, bar, rgb);
            }
            return;
        }
        const block = Math.max(1, Math.floor(cross * BLOCK_SHARE));
        const pitch = block + BLOCK_GAP;
        for (let at = 0; at + block <= filled; at += pitch)
        {
            const bar = vertical
                ? { ...track, top: track.bottom - at - block, bottom: track.bottom - at }
                : { ...track, left: track.left + at, right: track.left + at + block };
            draw.fill(hdc, bar, rgb);
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
        tk.sunkenEdge(hdc, rect);
        const track = trackOf(rect);
        const span = held.max - held.min;
        const fraction = span <= 0 ? 0 : Math.min(1, Math.max(0,
            (held.pos - held.min) / span));
        const cross = vertical ? track.right - track.left : track.bottom - track.top;
        fill(hdc, track, vertical, fraction, cross,
            held.barColor ?? tk.color(COLOR_HIGHLIGHT), smooth);
    };

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        switch (message.message){
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

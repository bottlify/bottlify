/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where the display's beam is, by the clock.
 *
 * Nothing here scans a frame out, yet a program can ask where the raster is --
 * DirectDraw's vertical-blank status and scan line, Direct3D's raster status
 * -- and can wait for the blank. A constant answer is a display that never
 * moves, and a program polling for the blank waits on it for ever. So the
 * position is the clock's: a frame every 1/rate seconds at the rate the
 * display reports, whose lines past the visible ones are the blanking
 * interval.
 *
 * The share of a frame that is blank is VGA's 640x480 timing, 45 of every 525
 * lines, kept for every height: a program reads the blank's existence and
 * roughly its length, and no mode this build sets has other timings to report.
 */

/** Visible lines of a frame, over all of its lines. */
const VISIBLE_SHARE = 480 / 525;

/**
 * How far past a boundary a wait lands, in milliseconds, so that the line
 * computed at the moment it lands is on the far side of the boundary and not
 * a rounding error short of it.
 */
const LANDING = 1e-3;

/**
 * @typedef {Object} RasterPosition
 * @property {number} line     0 at the top of the visible frame, past the last
 *                             visible line while the blank lasts
 * @property {boolean} inBlank
 */

/**
 * @param {Object} deps
 * @param {() => number} deps.now      the clock, in milliseconds
 * @param {() => number} deps.refresh  the display's rate, in hertz
 * @param {() => number} deps.height   the display's visible lines
 */
export function createRaster({ now, refresh, height }){
    const frame = ()=>{
        const visible = Math.max(1, Math.floor(height()));
        return {
            period: 1000 / Math.max(1, refresh()),
            visible,
            total: Math.max(visible + 1, Math.round(visible / VISIBLE_SHARE)),
        };
    };

    /** @param {number} period @returns {number} milliseconds into the current frame */
    const into = period=>{
        const t = now() % period;
        return t < 0 ? t + period : t;
    };

    return {
        /** @returns {RasterPosition} */
        position(){
            const { period, visible, total } = frame();
            const line = Math.min(total - 1, Math.floor(into(period) / period * total));
            return { line, inBlank: line >= visible };
        },

        /**
         * How long until the blank next begins, or next ends -- the end being
         * the top of the next frame. A wait from exactly on the edge is a
         * whole frame: the edge it names is the next one.
         *
         * @param {'begin' | 'end'} edge
         * @returns {number} milliseconds
         */
        untilBlank(edge){
            const { period, visible, total } = frame();
            const at = edge === 'begin' ? visible / total * period : period;
            let wait = at - into(period);
            if (wait <= 0)
            {
                wait += period;
            }
            return wait + LANDING;
        },

        /**
         * When the first blank at or after `at` begins, on the same clock: a
         * moment on the edge is that blank.
         *
         * @param {number} at
         * @returns {number} milliseconds
         */
        blankAt(at){
            const { period, visible, total } = frame();
            const begins = visible / total * period;
            return begins + Math.ceil((at - begins) / period - 1e-9) * period;
        },

        /** @returns {number} a frame, in milliseconds */
        period: ()=>frame().period,
    };
}

/**
 * Direct3D's D3DRASTER_STATUS of a raster: in the blank the scan line is
 * zero, which the documentation says a program is to ignore.
 *
 * @param {{ position: () => RasterPosition }} raster
 * @returns {{ InVBlank: number, ScanLine: number }}
 */
export function rasterStatus(raster){
    const { line, inBlank } = raster.position();
    return { InVBlank: inBlank ? 1 : 0, ScanLine: inBlank ? 0 : line };
}

/** D3DPRESENT_INTERVAL_IMMEDIATE: present at once, never at a blank. */
const PRESENT_INTERVAL_IMMEDIATE = 0x80000000;

/**
 * How many frames presented and not yet shown a Present lets wait for their
 * blanks before it stops the program's thread: Direct3D 9's frame latency,
 * three unless an Ex device is told otherwise (Wine's d3d9ex.c
 * test_frame_latency).
 * ponytail: an Ex device's SetMaximumFrameLatency is not followed here; follow it
 * when a program that sets one is measured.
 */
export const FRAMES_AHEAD = 3;

/**
 * The frames a device presented, each shown at a blank its presentation
 * interval names -- DEFAULT (0) and ONE the first after the frame before it,
 * TWO, THREE and FOUR (2, 4, 8) that many blanks on, IMMEDIATE at once -- as
 * a flip chain shows them: a Present queues its frame and answers, and stops
 * the thread only while `FRAMES_AHEAD` frames already wait to be shown,
 * until the oldest of them is. A program that steps its world once a frame
 * is held to the display's rate and no faster; one slower than the display
 * runs at its own rate. Stopped until the next blank at every Present, the
 * second was held to half the display's rate whenever a frame took longer
 * than one.
 *
 * @param {{ blankAt: (at: number) => number, period: () => number }} raster
 */
export function createPresentQueue(raster){
    /** The blanks the frames not yet shown are shown at, the oldest first. @type {number[]} */
    const waiting = [];
    /** The blank the last frame is shown at. */
    let last = -Infinity;
    return {
        /**
         * A frame presented now: how long the Present stops its thread.
         *
         * @param {number} at  the clock, in milliseconds
         * @param {number} interval  the device's D3DPRESENT_INTERVAL_ value
         * @returns {number} milliseconds; zero for no wait
         */
        present(at, interval){
            const value = interval >>> 0;
            if (value === PRESENT_INTERVAL_IMMEDIATE)
            {
                waiting.length = 0;
                last = -Infinity;
                return 0;
            }
            while (waiting.length > 0 && waiting[0] <= at)
            {
                waiting.shift();
            }
            const blanks = value === 2 ? 2 : value === 4 ? 3 : value === 8 ? 4 : 1;
            last = raster.blankAt(Math.max(at, last + blanks * raster.period()));
            waiting.push(last);
            return waiting.length > FRAMES_AHEAD
                ? waiting[waiting.length - 1 - FRAMES_AHEAD] - at + LANDING : 0;
        },
    };
}

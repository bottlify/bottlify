/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * When a frame a program produced is actually shown, and how evenly.
 *
 * A guest presents whenever its own loop happens to finish; the display
 * refreshes on its own schedule. Handing every present straight to the screen
 * delivers them in bursts, which reads as stutter even while the average frame
 * rate looks healthy. This decides the moment instead: a request is remembered,
 * one tick of the caller's scheduler is armed, and the newest request is the one
 * shown when that tick fires. Everything before it in the same window is
 * superseded rather than drawn.
 *
 * Two properties are the whole point:
 *
 * - **Nothing here ever makes its caller wait.** `request` records and returns.
 *   A guest thread held for the length of a frame costs more than any number of
 *   frames drawn, so a design in which a present blocks until the display is
 *   ready would be the wrong one no matter what it bought. Held time is spent by
 *   the scheduler between ticks, where no guest thread is standing in it.
 * - **The clock and the scheduler are arguments.** Nothing here reaches for
 *   `performance.now` or `requestAnimationFrame`, so the whole model runs
 *   headless against a clock a test advances by hand.
 *
 * The interval history lives here rather than in the frame profiler, and the
 * two are not interchangeable. The profiler times a frame the backend opened:
 * when work was submitted, and how long our own share of it took. This times the
 * gap between one delivery and the next, which is the rhythm a viewer perceives
 * -- and a present of a surface an owner shows never opens a backend frame at
 * all, so the profiler's ring would not even have a row for it. Reading a
 * stutter out of the submit clock measures something else.
 */

/**
 * @typedef {Object} PacerOptions
 * @property {() => number} now         Monotonic milliseconds.
 * @property {(tick: () => void) => void} schedule
 *        Runs `tick` at the display's next opportunity -- whatever the caller
 *        uses in place of a frame callback. Armed once per delivery, not kept
 *        running, so an idle program costs nothing.
 * @property {number} [targetFps]       Shapes the buckets. 60 by default.
 * @property {number} [floorFps]        Below this an interval counts as slow. 30.
 * @property {number} [minIntervalMs]
 *        Never deliver two frames closer together than this. Zero by default,
 *        which trusts the scheduler's own rhythm; the knob exists for a caller
 *        whose scheduler fires faster or less evenly than the display.
 * @property {number} [history]         Intervals kept for the distribution. 240.
 */

/**
 * @typedef {Object} IntervalReport
 * @property {number} count         Intervals seen, all-time; one fewer than deliveries.
 * @property {number} minMs         All-time.
 * @property {number} maxMs         All-time; the worst single stall.
 * @property {number} slow          All-time count at or past the floor period.
 * @property {number} meanMs        Over the recent window.
 * @property {number} deviationMs   Over the recent window; the stutter itself.
 * @property {number} p50Ms
 * @property {number} p95Ms
 * @property {number} p99Ms
 * @property {number} fps           Implied by the recent mean.
 * @property {number} periodMs      What one target refresh is worth.
 * @property {number} floorMs
 * @property {Record<string, number>} periods
 *        How many refreshes each interval took, all-time: `1` is a frame that
 *        made its slot, anything else is one that did not.
 */

/**
 * @typedef {Object} PacerReport
 * @property {number} requests
 * @property {number} delivered
 * @property {number} coalesced   Superseded before their turn came.
 * @property {number} idleTicks   A tick that found nothing to show.
 * @property {number} heldTicks   A tick refused for arriving too soon.
 * @property {boolean} waiting
 * @property {IntervalReport} intervals
 */

/**
 * @param {number[]} sorted   Ascending.
 * @param {number} p
 * @returns {number}
 */
function percentile(sorted, p){
    if (sorted.length === 0)
    {
        return 0;
    }
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/**
 * @param {PacerOptions} options
 * @returns {{ request: (show: () => void) => void, flush: () => void,
 *             diagnostics: () => PacerReport }}
 */
export function createPacer(options){
    const periodMs = 1000 / (options.targetFps ?? 60);
    const floorMs = 1000 / (options.floorFps ?? 30);
    const minIntervalMs = options.minIntervalMs ?? 0;
    const historySize = options.history ?? 240;

    /** @type {(() => void) | null} what the next tick will show */
    let waiting = null;
    let armed = false;
    let lastAt = 0;
    let hasShown = false;
    /** @type {number[]} the recent window, oldest first */
    const recent = [];
    const counters = { requests: 0, delivered: 0, coalesced: 0, idleTicks: 0, heldTicks: 0 };
    let intervals = 0;
    let slow = 0;
    let minMs = 0;
    let maxMs = 0;
    /** @type {Record<string, number>} */
    const periods = { 1: 0, 2: 0, 3: 0, '4+': 0 };

    /** @param {number} interval */
    const record = interval=>{
        recent.push(interval);
        while (recent.length > historySize)
        {
            recent.shift();
        }
        minMs = intervals === 0 ? interval : Math.min(minMs, interval);
        maxMs = Math.max(maxMs, interval);
        intervals++;
        if (interval >= floorMs)
        {
            slow++;
        }
        const refreshes = Math.max(1, Math.round(interval / periodMs));
        periods[refreshes >= 4 ? '4+' : String(refreshes)]++;
    };

    /** @param {number} at @returns {boolean} whether anything was shown */
    const deliver = at=>{
        const show = waiting;
        waiting = null;
        if (!show)
        {
            return false;
        }
        // The interval is closed before the frame is shown: this measures the
        // rhythm of delivery, not how long showing one took.
        if (hasShown)
        {
            record(at - lastAt);
        }
        hasShown = true;
        lastAt = at;
        counters.delivered++;
        show();
        return true;
    };

    const tick = ()=>{
        armed = false;
        if (waiting && hasShown && options.now() - lastAt < minIntervalMs)
        {
            counters.heldTicks++;
            // Re-armed rather than delivered: the wait is spent in the
            // scheduler, never in a caller.
            arm();
            return;
        }
        if (!deliver(options.now()))
        {
            counters.idleTicks++;
        }
    };

    const arm = ()=>{
        if (armed)
        {
            return;
        }
        armed = true;
        options.schedule(tick);
    };

    return {
        /**
         * Show this at the display's rhythm. Returns immediately; a request made
         * while another is still waiting replaces it, and the replaced one is
         * never shown.
         *
         * @param {() => void} show
         */
        request(show){
            counters.requests++;
            if (waiting)
            {
                counters.coalesced++;
            }
            waiting = show;
            arm();
        },

        /** Shows what is waiting now rather than at the next tick. */
        flush(){
            deliver(options.now());
        },

        /** @returns {PacerReport} */
        diagnostics(){
            const sorted = [...recent].sort((a, b)=>a - b);
            const total = sorted.reduce((sum, value)=>sum + value, 0);
            const meanMs = sorted.length ? total / sorted.length : 0;
            const spread = sorted.length
                ? sorted.reduce((sum, value)=>sum + (value - meanMs) ** 2, 0) / sorted.length
                : 0;
            return {
                ...counters,
                waiting: waiting !== null,
                intervals: {
                    count: intervals,
                    minMs,
                    maxMs,
                    slow,
                    meanMs,
                    deviationMs: Math.sqrt(spread),
                    p50Ms: percentile(sorted, 50),
                    p95Ms: percentile(sorted, 95),
                    p99Ms: percentile(sorted, 99),
                    fps: meanMs > 0 ? 1000 / meanMs : 0,
                    periodMs,
                    floorMs,
                    periods: { ...periods },
                },
            };
        },
    };
}

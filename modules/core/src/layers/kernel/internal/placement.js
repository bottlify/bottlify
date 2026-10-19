/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a process with executors of its own runs its threads, moved one at a
 * time on a signal that has built up, never tried and never measured back.
 *
 * A thread runs on an executor of its own unless it gains by taking turns on
 * the process's (`in`), and comes off it again when it waits there for a turn
 * it could have had elsewhere (`out`); a pinned thread's processor is played by
 * the process's executor where that saves more waiting than it adds (`trade`,
 * `untrade`). The scheduler says, each window of `windowMs`, what each such
 * move would gain as a share of the window -- worked out from what its threads
 * did in it: their own work, their waits for the process's answers, their
 * waits for a turn, their calls -- and the gains build up, leaking with a
 * half-life of `halfMs`; a move is made once its sum reaches `threshold`
 * milliseconds. A load's burst of a few hundred milliseconds stays under it.
 *
 * A move is not checked against the program's speed after it: a frame rate
 * read over a second or two is the scene as much as the placement, and a
 * comparison that undoes a move holds the program the slower way for the
 * length of the comparison, the slow frames a player sees. A move that was
 * wrong shows in the same reckoning that made it: the threads' waits after it
 * build the gain of the move back. So that two moves whose gains answer each
 * other do not alternate, the move back from one just made needs twice the
 * threshold the move itself needed, coming down to one with a half-life of
 * `holdMs`: a pair that keeps answering is made at ever longer gaps. The
 * window a move falls in, the threads moving, adds nothing to any sum.
 *
 * One move at a time, and a thread at a time, so a change is as small as it
 * can be: concentrating a program is its threads coming in one after another
 * while each gains.
 */

export const Placement = Object.freeze({ SPREAD: 'spread', CONCENTRATE: 'concentrate',
    AUTO: 'auto' });

/**
 * @typedef {Object} PlacementOptions
 * @property {() => number} now  wall milliseconds
 * @property {(key: string) => void} apply  makes a move
 * @property {(key: string) => string | null} [opposite]  the move that takes `key` back
 * @property {number} [windowMs]  how often the gains are read
 * @property {number} [halfMs]  how fast a sum leaks
 * @property {number} [threshold]  the sum, in ms, a move is made at
 * @property {number} [holdMs]  how fast the raised threshold of a move back comes down
 * @property {number} [churnMs]  for a gate only: a move every so often, gains or not
 */

/** @param {PlacementOptions} options */
export function createPlacement(options){
    const { now, apply } = options;
    const opposite = options.opposite ?? (()=>null);
    const windowMs = options.windowMs ?? 250;
    const halfMs = options.halfMs ?? 2000;
    const threshold = options.threshold ?? 300;
    const holdMs = options.holdMs ?? 30_000;
    const churnMs = options.churnMs ?? 0;

    /** Each move's built-up gain, ms. @type {Map<string, number>} */
    const sums = new Map();
    /** Each move's raised threshold factor, and when it was raised. @type {Map<string, { factor: number, at: number }>} */
    const raised = new Map();
    let windowFrom = now();
    /** Until when the threads are moving and their gains count for nothing. */
    let movingUntil = -Infinity;
    let lastChurn = windowFrom;
    const counted = { moves: 0, last: '' };

    /** The factor a move's threshold stands at now. @param {string} key @param {number} at */
    const factorOf = (key, at)=>{
        const one = raised.get(key);
        return one === undefined ? 1 : 1 + (one.factor - 1) * 0.5 ** ((at - one.at) / holdMs);
    };

    return {
        /**
         * Called every turn: once a window has passed, reads each move's gain,
         * builds the sums, and makes a move whose sum has reached its threshold.
         *
         * @param {() => Map<string, number>} gains  each possible move's gain, a share of
         *     the window
         */
        tick(gains){
            const at = now();
            const ms = at - windowFrom;
            if (ms < windowMs)
            {
                return;
            }
            windowFrom = at;
            const offered = gains();
            if (at <= movingUntil)
            {
                return;
            }
            const leak = 0.5 ** (ms / halfMs);
            for (const key of new Set([...sums.keys(), ...offered.keys()]))
            {
                const sum = Math.max(0,
                    (sums.get(key) ?? 0) * leak + (offered.get(key) ?? 0) * ms);
                if (sum > 0)
                {
                    sums.set(key, sum);
                }
                else
                {
                    sums.delete(key);
                }
            }
            let best = null;
            let bestOver = 1;
            for (const [key, sum] of sums)
            {
                const over = sum / (threshold * factorOf(key, at));
                if (over >= bestOver)
                {
                    best = key;
                    bestOver = over;
                }
            }
            if (best === null && churnMs > 0 && at - lastChurn >= churnMs && offered.size > 0)
            {
                best = [...offered.keys()][Math.floor(at / churnMs) % offered.size];
            }
            if (best === null)
            {
                return;
            }
            lastChurn = at;
            counted.moves++;
            counted.last = `${best} at ${Math.round(sums.get(best) ?? 0)} ms`;
            sums.clear();
            const back = opposite(best);
            if (back !== null)
            {
                raised.set(back, { factor: 2 * factorOf(best, at), at });
            }
            apply(best);
            movingUntil = at + windowMs;
        },

        /** The moves made, the last, and the sums building now. */
        diagnostics: ()=>({ ...counted,
            building: [...sums].map(([key, sum])=>`${key} ${Math.round(sum)}`).join(', ') }),
    };
}

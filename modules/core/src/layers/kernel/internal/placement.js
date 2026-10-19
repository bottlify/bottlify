/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a process with executors of its own runs its threads, moved one at a
 * time on a signal that has built up, never tried.
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
 * It replaced trials that ran the program each way in turn for a window and
 * kept the faster: the slower way's window was a second of slow frames a
 * player saw -- Call of Duty 4 drew a frame every 64 ms concentrated and every
 * 131 traded against 28 and 30 -- and a trial that fell on a load kept the
 * wrong way through the play (a frame every 51 ms where spread drew 20).
 *
 * One move at a time, and a thread at a time, so a change is as small as it
 * can be: concentrating a program is its threads coming in one after another
 * while each gains. Each move is checked after it, the program's speed over
 * `verifyMs` against the same before (frames a millisecond where it presents
 * them, instructions retired where not): a move that left it slower by
 * `margin` is undone, and its threshold made four times as high, coming back
 * down with a half-life of `forgiveMs`, so a move the sums keep proposing and
 * the program keeps refusing is made seldom.
 */

export const Placement = Object.freeze({ SPREAD: 'spread', CONCENTRATE: 'concentrate',
    AUTO: 'auto' });

/**
 * @typedef {Object} PlacementOptions
 * @property {() => number} now  wall milliseconds
 * @property {(key: string) => void} apply  makes a move
 * @property {(key: string) => void} undo  takes it back
 * @property {number} [windowMs]  how often the gains are read
 * @property {number} [halfMs]  how fast a sum leaks
 * @property {number} [threshold]  the sum, in ms, a move is made at
 * @property {number} [verifyMs]  how long the speed is weighed before and after a move
 * @property {number} [margin]  by how much slower a move must leave the program to be undone
 * @property {number} [forgiveMs]  how fast a refused move's raised threshold comes back down
 * @property {number} [churnMs]  for a gate only: a move every so often, gains or not
 */

/** @param {PlacementOptions} options */
export function createPlacement(options){
    const { now, apply, undo } = options;
    const windowMs = options.windowMs ?? 250;
    const halfMs = options.halfMs ?? 2000;
    const threshold = options.threshold ?? 300;
    const verifyMs = options.verifyMs ?? 1500;
    const margin = options.margin ?? 0.1;
    const forgiveMs = options.forgiveMs ?? 60_000;
    const churnMs = options.churnMs ?? 0;

    /** Each move's built-up gain, ms. @type {Map<string, number>} */
    const sums = new Map();
    /** Each refused move's threshold factor, and when it was set. @type {Map<string, { factor: number, at: number }>} */
    const raised = new Map();
    /** The windows' speeds, newest last: their length and what the program did in them. */
    const history = /** @type {{ ms: number, frames: number, retired: number }[]} */ ([]);
    let windowFrom = now();
    let windowFrames = 0;
    let windowRetired = -1;
    /** The move being weighed: what it was, the speed before it, from when its after counts. */
    let checking = /** @type {{ key: string, before: { ms: number, frames: number, retired: number }, from: number } | null} */ (null);
    let lastChurn = windowFrom;
    const counted = { moves: 0, undone: 0, last: '' };

    /** The factor a move's threshold stands at now. @param {string} key @param {number} at */
    const factorOf = (key, at)=>{
        const one = raised.get(key);
        return one === undefined ? 1 : 1 + (one.factor - 1) * 0.5 ** ((at - one.at) / forgiveMs);
    };

    /** The windows since `from`, summed. @param {number} span */
    const lastWindows = span=>{
        const sum = { ms: 0, frames: 0, retired: 0 };
        for (let i = history.length - 1; i >= 0 && sum.ms < span; i--)
        {
            sum.ms += history[i].ms;
            sum.frames += history[i].frames;
            sum.retired += history[i].retired;
        }
        return sum;
    };

    /**
     * How fast the program went over a span: frames a millisecond where it
     * presented a few in both spans, else instructions retired.
     *
     * @param {{ ms: number, frames: number, retired: number }} a
     * @param {{ ms: number, frames: number, retired: number }} b
     */
    const slower = (a, b)=>{
        const byFrames = a.frames >= 3 && b.frames >= 3;
        const rate = (/** @type {{ ms: number, frames: number, retired: number }} */ one)=>
            (byFrames ? one.frames : one.retired) / Math.max(one.ms, 1);
        return rate(b) < rate(a) * (1 - margin);
    };

    return {
        /** A frame the program presented, now. */
        frame(){
            windowFrames++;
        },

        /** Whether a move is being weighed now. */
        checking: ()=>checking !== null,

        /**
         * Called every turn: once a window has passed, reads each move's gain,
         * builds the sums, and makes or checks a move.
         *
         * @param {number} retired  what every executor has retired so far
         * @param {() => Map<string, number>} gains  each possible move's gain, a share of
         *     the window
         */
        tick(retired, gains){
            const at = now();
            if (windowRetired < 0)
            {
                windowRetired = retired;
            }
            const ms = at - windowFrom;
            if (ms < windowMs)
            {
                return;
            }
            history.push({ ms, frames: windowFrames, retired: retired - windowRetired });
            if (history.length > 64)
            {
                history.shift();
            }
            windowFrom = at;
            windowFrames = 0;
            windowRetired = retired;
            if (checking !== null)
            {
                if (at - checking.from < verifyMs)
                {
                    return;
                }
                const after = lastWindows(verifyMs);
                if (slower(checking.before, after))
                {
                    undo(checking.key);
                    counted.undone++;
                    counted.last = `undid ${checking.key}`;
                    raised.set(checking.key, { factor: 4 * factorOf(checking.key, at), at });
                }
                checking = null;
                sums.clear();
                return;
            }
            const leak = 0.5 ** (ms / halfMs);
            const offered = gains();
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
            const before = lastWindows(verifyMs);
            counted.moves++;
            counted.last = `${best} at ${Math.round(sums.get(best) ?? 0)} ms`;
            sums.clear();
            apply(best);
            // The window the move falls in is the threads moving: the after starts past it.
            checking = { key: best, before, from: at + windowMs };
        },

        /** The moves made and undone, the last, and the sums building now. */
        diagnostics: ()=>({ ...counted,
            building: [...sums].map(([key, sum])=>`${key} ${Math.round(sum)}`).join(', ') }),
    };
}

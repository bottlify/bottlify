/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a process with executors of its own runs its threads: spread over
 * them, each ready thread on an executor of its own, or concentrated on the
 * process's own executor, taking turns there as on one processor -- chosen by
 * what the program gets done in each, measured, not guessed.
 *
 * Spreading pays where threads compute apart: a compressor's workers, a
 * mixer's DSP. It costs where they hand work to each other every frame: a
 * game's main thread waiting on its job and physics threads paid a wake, a
 * slice started elsewhere and every one of their calls into the host answered
 * by the process's executor, and on a four-core machine the Crysis demo's
 * timedemo ran 172-188 ms a frame spread and 129 concentrated (116-124 on
 * one executor). Which one a program is, and on which machine, only the
 * program says: so the scheduler tries both now and then in short windows, in
 * turn, and keeps the one that went faster -- frames presented a millisecond
 * where the program presents them (a game's thread spinning on its jobs
 * retires instructions that are no progress), instructions retired on every
 * executor where it does not. Spreading must win by `margin` to be kept:
 * concentrated is the safer of the two. A trial's windows begin `settleMs`
 * after the switch, which moves the threads. A program that begins or stops
 * presenting frames -- a game's load decided by what it retired, then its
 * play -- is tried again once it has done so for `changeMs`, not after the
 * winner's hold, which by then may be minutes.
 */

export const Placement = Object.freeze({ SPREAD: 'spread', CONCENTRATE: 'concentrate' });

/**
 * @typedef {Object} PlacementOptions
 * @property {() => number} now  wall milliseconds
 * @property {'spread' | 'concentrate' | null} [fixed]  one way only, never tried
 * @property {number} [firstTrialMs]  how long after the start the first trial begins
 * @property {number} [windowMs]  a window's least length after its settling
 * @property {number} [maxWindowMs]  a window's most, frames or not
 * @property {number} [settleMs]  how long after a switch a window starts counting
 * @property {number} [rounds]  windows of each way in a trial
 * @property {number} [holdMs]  how long the winner is kept before the next trial
 * @property {number} [maxHoldMs]  the longest a winner the trials keep choosing is kept
 * @property {number} [margin]  by how much spreading must win
 * @property {number} [minFrames]  frames a window needs for frames to be its measure
 * @property {number} [changeMs]  how long a program must have begun or stopped presenting
 *     frames, against the last trial's measure, for the next trial to begin
 */

/**
 * @typedef {Object} Window
 * @property {'spread' | 'concentrate'} mode
 * @property {number} ms
 * @property {number} frames  intervals between the frames presented in it
 * @property {number} framesMs  the time those intervals span
 * @property {number} retired
 */

/** @param {PlacementOptions} options */
export function createPlacement(options){
    const { now, fixed = null } = options;
    const firstTrialMs = options.firstTrialMs ?? 2000;
    const windowMs = options.windowMs ?? 800;
    const maxWindowMs = options.maxWindowMs ?? 3000;
    const settleMs = options.settleMs ?? 200;
    const rounds = options.rounds ?? 2;
    const holdMs = options.holdMs ?? 30_000;
    const maxHoldMs = options.maxHoldMs ?? 240_000;
    const margin = options.margin ?? 0.05;
    const minFrames = options.minFrames ?? 6;
    const changeMs = options.changeMs ?? 3000;

    /** @type {'spread' | 'concentrate'} */
    let mode = fixed ?? Placement.SPREAD;
    /** The trial's ways, in the order their windows run: in turn, concentrated first. */
    const order = Array.from({ length: 2 * rounds },
        (_, i)=>(i % 2 === 0 ? Placement.CONCENTRATE : Placement.SPREAD));
    /** @type {Window[]} */
    let windows = [];
    /** The window being measured, once its settling is over; null while it settles. */
    let open = /** @type {{ from: number, retired: number, frames: number, firstFrame: number,
        lastFrame: number } | null} */ (null);
    let switchedAt = now();
    /** When the next trial begins; Infinity while one runs. */
    let nextTrial = switchedAt + firstTrialMs;
    let trialAt = -1;
    let hold = holdMs;
    /** @type {'spread' | 'concentrate' | null} */
    let lastWinner = null;
    let lastFrameAt = -1;
    /** The last `minFrames` frames' times, oldest first once full. @type {number[]} */
    const recent = [];
    /** Whether the last trial measured by frames; null before the first. @type {boolean | null} */
    let lastByFrames = null;
    /** Since when the program has presented otherwise than the last trial measured, or -1. */
    let changedSince = -1;
    const counted = { trials: 0, spread: 0, concentrate: 0, byFrames: 0, last: '' };

    /** @param {'spread' | 'concentrate'} next @param {number} at */
    const switchTo = (next, at)=>{
        if (next !== mode)
        {
            mode = next;
            switchedAt = at;
        }
    };

    /** @param {Window[]} done @returns {'spread' | 'concentrate'} */
    const decide = done=>{
        const byFrames = done.every(one=>one.frames >= minFrames - 1 && one.framesMs > 0);
        /** @param {'spread' | 'concentrate'} way */
        const rate = way=>{
            const of = done.filter(one=>one.mode === way);
            /** @param {(one: Window) => number} field */
            const total = field=>of.reduce((sum, one)=>sum + field(one), 0);
            return byFrames ? total(one=>one.frames) / total(one=>one.framesMs)
                : total(one=>one.retired) / total(one=>one.ms);
        };
        const spread = rate(Placement.SPREAD);
        const concentrated = rate(Placement.CONCENTRATE);
        const winner = spread > concentrated * (1 + margin)
            ? Placement.SPREAD : Placement.CONCENTRATE;
        counted.trials++;
        counted[winner]++;
        counted.byFrames += byFrames ? 1 : 0;
        lastByFrames = byFrames;
        counted.last = `${winner} ${byFrames ? 'frames' : 'retired'}`
            + ` spread ${spread.toPrecision(3)} concentrated ${concentrated.toPrecision(3)}`;
        return winner;
    };

    return {
        /** The way threads go now. @returns {'spread' | 'concentrate'} */
        mode: ()=>mode,

        /**
         * A frame the program presented, now.
         */
        frame(){
            const at = now();
            if (open !== null)
            {
                open.firstFrame = open.firstFrame < 0 ? at : open.firstFrame;
                open.lastFrame = at;
                open.frames++;
            }
            lastFrameAt = at;
            recent.push(at);
            if (recent.length > minFrames)
            {
                recent.shift();
            }
        },

        /**
         * Called every turn with the instructions retired on every executor so
         * far: closes a window that has run its length, and moves to the next
         * way of the trial or to the trial's winner.
         *
         * @param {number} retired
         */
        tick(retired){
            if (fixed !== null)
            {
                return;
            }
            const at = now();
            if (trialAt < 0)
            {
                // Presenting: `minFrames` frames within a window's longest.
                const presenting = recent.length === minFrames && at - recent[0] <= maxWindowMs;
                changedSince = lastByFrames === null || presenting === lastByFrames ? -1
                    : changedSince < 0 ? at : changedSince;
                if (at < nextTrial && (changedSince < 0 || at - changedSince < changeMs))
                {
                    return;
                }
                changedSince = -1;
                trialAt = at;
                windows = [];
                open = null;
                switchTo(order[0], at);
                // A window already that way starts at once.
                switchedAt = Math.min(switchedAt, at);
            }
            if (open === null)
            {
                if (at - switchedAt >= settleMs)
                {
                    open = { from: at, retired, frames: 0, firstFrame: -1, lastFrame: -1 };
                }
                return;
            }
            const ms = at - open.from;
            if (ms < windowMs || ms < maxWindowMs && open.frames < minFrames && lastFrameAt >= 0)
            {
                return;
            }
            windows.push({ mode, ms, retired: retired - open.retired,
                frames: Math.max(0, open.frames - 1), framesMs: open.lastFrame - open.firstFrame });
            open = null;
            if (windows.length < order.length)
            {
                switchTo(order[windows.length], at);
                return;
            }
            const byFramesBefore = lastByFrames;
            const winner = decide(windows);
            // A winner the trials keep choosing, by the same measure, is tried less often.
            hold = winner === lastWinner && lastByFrames === byFramesBefore
                ? Math.min(maxHoldMs, hold * 2) : holdMs;
            lastWinner = winner;
            switchTo(winner, at);
            trialAt = -1;
            nextTrial = at + hold;
        },

        diagnostics: ()=>({ mode, fixed, ...counted, holdMs: hold }),
    };
}

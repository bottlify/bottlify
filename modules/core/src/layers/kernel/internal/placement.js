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
 * program says: so the scheduler tries both in short windows, in turn, and
 * keeps the one that went faster -- frames presented a millisecond
 * where the program presents them (a game's thread spinning on its jobs
 * retires instructions that are no progress), instructions retired on every
 * executor where it does not. Spreading must win by `margin` to be kept:
 * concentrated is the safer of the two. A trial's windows begin `settleMs`
 * after the switch, which moves the threads; one way ahead of the other by
 * `clear` after a window of each ends the trial there, the second round's
 * windows of the slower way spared: in the Crysis demo's timedemo a spread
 * window ran 400 to 580 ms a frame against 80 to 130 concentrated, and two
 * trials in its half minute cost it a third.
 *
 * A trial runs the program the slower way for its windows, which a player sees:
 * Call of Duty 4 drew a frame every 64 ms in a concentrated window and every
 * 131 in a traded one, against 28 and 30, and a trial again every half minute
 * to four minutes, while nothing in the game changed, was a second of that
 * each time.
 * So a winner is kept for as long as what it was measured on lasts, and tried
 * again only once the program changes: it begins or stops presenting frames
 * (a game's load decided by what it retired, then its play) for `changeMs`, or
 * the share each of its threads retires moves from the one it had after the
 * trial -- half the summed difference of the shares at least `shift` -- or the
 * winner's own speed, by the trial's measure, lies `drift` times off what the
 * trial measured for it, each over `lasting` windows of `profileMs` in a row,
 * so that a load's burst of a few seconds is not one; and never sooner than
 * `holdMs` after the last trial. The speed is the second sign because a trial
 * can fall on a moment that is not the program's: Call of Duty 4's level,
 * restarted, was tried across its load, concentrated drawing a frame every
 * 6.7 ms of the loading screen against 66 spread, and kept concentrated into
 * its play at 51 ms a frame, 20 a second where spread drew 50, its threads'
 * shares moved by 0.17.
 *
 * Frames that come as fast either way -- a program held to the display's rate
 * -- say nothing of what each way costs, and such a tie went to the safer way:
 * a game at 62.5 frames a second both ways was concentrated, its threads taking
 * turns on the process's executor, and its next load there held the main
 * thread three seconds behind a thread of higher priority while six executors
 * idled. A tie is weighed by how busy each way kept the process's executor
 * instead: the way that leaves it room by `margin` is kept.
 */

export const Placement = Object.freeze({ SPREAD: 'spread', CONCENTRATE: 'concentrate' });

/**
 * The same trial weighs other pairs of ways: whether the process's executor
 * plays a pinned thread's processor (`playPinned` in the scheduler), with
 * `ways`, `initial` and `mayBegin`, the one trial at a time.
 *
 * @typedef {Object} PlacementOptions
 * @property {() => number} now  wall milliseconds
 * @property {[string, string]} [ways]  the two ways, the safer first: concentrate, spread
 * @property {string} [initial]  the way before the first trial: the riskier one
 * @property {() => boolean} [mayBegin]  whether a trial due may begin now: not while
 *     another trial measures the same program
 * @property {string | null} [fixed]  one way only, never tried
 * @property {number} [firstTrialMs]  how long after the start the first trial begins
 * @property {number} [windowMs]  a window's least length after its settling
 * @property {number} [maxWindowMs]  a window's most, frames or not
 * @property {number} [settleMs]  how long after a switch a window starts counting
 * @property {number} [rounds]  windows of each way in a trial
 * @property {number} [holdMs]  the least time from a trial's end to the next one's begin
 * @property {() => Map<string, number>} [work]  what each thread has retired so far, by
 *     name: whether the program's work has moved between its threads since the last trial
 * @property {number} [profileMs]  how long a window of the threads' work is
 * @property {number} [shift]  how far a window's shares must lie from those after the trial,
 *     half their summed difference, to count as moved: 0 every window, 1 none
 * @property {number} [drift]  by what factor, either way, the winner's speed in a window must
 *     lie off the trial's measure of it to count as moved
 * @property {number} [lasting]  windows in a row the work must have moved for a trial
 * @property {number} [margin]  by how much spreading must win
 * @property {number} [clear]  by how much one way ahead after a window of each ends the trial
 * @property {number} [minFrames]  frames a window waits for, up to `maxWindowMs`
 * @property {number} [changeMs]  how long a program must have begun or stopped presenting
 *     frames, against the last trial's measure, for the next trial to begin
 */

/**
 * @typedef {Object} Window
 * @property {string} mode
 * @property {number} ms
 * @property {number} presented  frames presented in it
 * @property {number} frames  intervals between them
 * @property {number} framesMs  the time those intervals span
 * @property {number} retired
 * @property {number | null} busy  how long the process's executor ran in it; null unknown
 */

/** @param {PlacementOptions} options */
export function createPlacement(options){
    const { now, fixed = null, mayBegin = ()=>true } = options;
    const [safe, risky] = options.ways ?? [Placement.CONCENTRATE, Placement.SPREAD];
    const firstTrialMs = options.firstTrialMs ?? 2000;
    const windowMs = options.windowMs ?? 800;
    const maxWindowMs = options.maxWindowMs ?? 2500;
    const settleMs = options.settleMs ?? 200;
    const rounds = options.rounds ?? 2;
    const holdMs = options.holdMs ?? 30_000;
    const work = options.work ?? null;
    const profileMs = options.profileMs ?? 5000;
    const shift = options.shift ?? 0.25;
    const lasting = options.lasting ?? 2;
    const drift = options.drift ?? 2;
    const margin = options.margin ?? 0.05;
    const clear = options.clear ?? 0.25;
    const minFrames = options.minFrames ?? 3;
    const changeMs = options.changeMs ?? 3000;

    /**
     * Spread until the first trial: a program that computes on all its threads
     * from the start has them at once, and a game's first seconds are its load.
     */
    let mode = fixed ?? options.initial ?? risky;
    /** The trial's ways, in the order their windows run: in turn, the safer first. */
    const order = Array.from({ length: 2 * rounds }, (_, i)=>(i % 2 === 0 ? safe : risky));
    /** @type {Window[]} */
    let windows = [];
    /** The window being measured, once its settling is over; null while it settles. */
    let open = /** @type {{ from: number, retired: number, frames: number, firstFrame: number,
        lastFrame: number, busy: number | null } | null} */ (null);
    let switchedAt = now();
    /** When the first trial begins, then the soonest the next one may. */
    let nextTrial = switchedAt + firstTrialMs;
    let trialAt = -1;
    /**
     * What each thread retired in the first window of the threads' work after
     * the last trial, as shares of the whole: what the trial was measured on.
     * Null until that window has passed.
     * @type {Map<string, number> | null}
     */
    let measuredOn = null;
    /**
     * The window of the threads' work under way: since when, what each had
     * retired then, and the program's frames and instructions then.
     */
    let profile = /** @type {{ from: number, work: Map<string, number>, frames: number,
        retired: number } | null} */ (null);
    /** The winner's speed as the last trial measured it, and by which measure. */
    let measuredRate = 0;
    let measuredByFrames = false;
    /** Frames the program has presented, every one. */
    let framesSeen = 0;
    /** The last window's speed against `measuredRate`. */
    let lastDrift = 1;
    /** When the first window after a trial begins: once the threads have moved to the winner. */
    let profileFrom = Infinity;
    /** The last window's distance from `measuredOn`, and how many in a row reached `shift`. */
    let moved = 0;
    let movedWindows = 0;
    /** The last three frames' times, oldest first: presenting while they lie within a
     * window's longest, a window then measured by frames. @type {number[]} */
    const recent = [];
    /** Whether the last trial measured by frames; null before the first. @type {boolean | null} */
    let lastByFrames = null;
    /** Since when the program has presented otherwise than the last trial measured, or -1. */
    let changedSince = -1;
    /**
     * Trials, each way's wins by its name, those decided by frames, those begun
     * because the threads' work moved, the last.
     *
     * @type {Record<string, any>}
     */
    const counted = { trials: 0, [safe]: 0, [risky]: 0, byFrames: 0, byWork: 0, last: '' };
    /** Whether the program presents now: its last three frames within a window's longest. */
    const presenting = (/** @type {number} */ at)=>recent.length === 3
        && at - recent[0] <= maxWindowMs;

    /** @param {string} next @param {number} at */
    const switchTo = (next, at)=>{
        if (next !== mode)
        {
            mode = next;
            switchedAt = at;
        }
    };

    /**
     * Each way's rate over the windows done: by frames where the program
     * presented in any of them -- a way whose window drew next to none is
     * rated by the frames its windows' whole time held -- else by what was
     * retired.
     *
     * @param {Window[]} done
     */
    const rates = done=>{
        const byFrames = done.some(one=>one.frames >= 2);
        /** @param {string} way */
        const rate = way=>{
            const of = done.filter(one=>one.mode === way);
            /** @param {(one: Window) => number} field */
            const total = field=>of.reduce((sum, one)=>sum + field(one), 0);
            if (!byFrames)
            {
                return total(one=>one.retired) / total(one=>one.ms);
            }
            return of.every(one=>one.frames >= 1 && one.framesMs > 0)
                ? total(one=>one.frames) / total(one=>one.framesMs)
                : total(one=>one.presented) / total(one=>one.ms);
        };
        /** The process's executor's busy share in a way's windows; null where unknown. @param {string} way */
        const busy = way=>{
            const of = done.filter(one=>one.mode === way);
            return of.length > 0 && of.every(one=>one.busy !== null)
                ? of.reduce((sum, one)=>sum + /** @type {number} */ (one.busy), 0)
                    / of.reduce((sum, one)=>sum + one.ms, 0)
                : null;
        };
        return { byFrames, risky: rate(risky), safe: rate(safe), riskyBusy: busy(risky),
            safeBusy: busy(safe) };
    };

    /** @param {Window[]} done @returns {string} */
    const decide = done=>{
        const rated = rates(done);
        const tie = rated.byFrames && Math.abs(rated.risky - rated.safe) <= margin * rated.safe;
        const roomier = tie && rated.riskyBusy !== null && rated.safeBusy !== null
            && rated.riskyBusy < rated.safeBusy * (1 - margin);
        const winner = rated.risky > rated.safe * (1 + margin) || roomier ? risky : safe;
        counted.trials++;
        counted[winner]++;
        counted.byFrames += rated.byFrames ? 1 : 0;
        measuredRate = winner === risky ? rated.risky : rated.safe;
        measuredByFrames = rated.byFrames;
        lastByFrames = rated.byFrames;
        counted.last = `${winner} ${rated.byFrames ? 'frames' : 'retired'}`
            + ` ${risky} ${rated.risky.toPrecision(3)} ${safe} ${rated.safe.toPrecision(3)}`
            + (tie && rated.riskyBusy !== null && rated.safeBusy !== null
                ? `, a tie: busy ${rated.riskyBusy.toFixed(2)} and ${rated.safeBusy.toFixed(2)}`
                : '');
        return winner;
    };

    /**
     * Each thread's share of what all of them retired between two readings;
     * null where none retired anything.
     *
     * @param {Map<string, number>} from @param {Map<string, number>} to
     */
    const sharesOf = (from, to)=>{
        /** @type {Map<string, number>} */
        const shares = new Map();
        let total = 0;
        for (const [name, retired] of to)
        {
            const did = retired - (from.get(name) ?? 0);
            if (did > 0)
            {
                shares.set(name, did);
                total += did;
            }
        }
        if (total === 0)
        {
            return null;
        }
        for (const [name, did] of shares)
        {
            shares.set(name, did / total);
        }
        return shares;
    };

    /**
     * Half the summed difference of two sets of shares: 0 where each thread
     * did the same part of the work, 1 where no thread did any of both.
     *
     * @param {Map<string, number>} a @param {Map<string, number>} b
     */
    const distance = (a, b)=>{
        let sum = 0;
        for (const [name, share] of a)
        {
            sum += Math.abs(share - (b.get(name) ?? 0));
        }
        for (const [name, share] of b)
        {
            sum += a.has(name) ? 0 : share;
        }
        return sum / 2;
    };

    /**
     * Closes a window of the threads' work once it has run `profileMs`: the
     * first after a trial is what the trial was measured on, each later one
     * weighed against it.
     *
     * @param {number} at @param {number} retired
     */
    const watchWork = (at, retired)=>{
        if (work === null || at < profileFrom)
        {
            return;
        }
        if (profile === null)
        {
            profile = { from: at, work: work(), frames: framesSeen, retired };
            return;
        }
        const ms = at - profile.from;
        if (ms < profileMs)
        {
            return;
        }
        const done = work();
        const shares = sharesOf(profile.work, done);
        // By the trial's own measure: frames a millisecond, or instructions.
        const rate = (measuredByFrames ? framesSeen - profile.frames
            : retired - profile.retired) / ms;
        profile = { from: at, work: done, frames: framesSeen, retired };
        if (shares === null)
        {
            return;
        }
        if (measuredOn === null)
        {
            measuredOn = shares;
            return;
        }
        moved = distance(measuredOn, shares);
        lastDrift = measuredRate > 0 ? rate / measuredRate : 1;
        const off = lastDrift > drift || lastDrift * drift < 1;
        movedWindows = moved >= shift || off ? movedWindows + 1 : 0;
    };

    return {
        /** The way threads go now. @returns {string} */
        mode: ()=>mode,

        /** Whether a trial is measuring the program now. */
        trialing: ()=>trialAt >= 0,

        /**
         * A frame the program presented, now.
         */
        frame(){
            const at = now();
            framesSeen++;
            if (open !== null)
            {
                open.firstFrame = open.firstFrame < 0 ? at : open.firstFrame;
                open.lastFrame = at;
                open.frames++;
            }
            recent.push(at);
            if (recent.length > 3)
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
         * @param {number | null} [busyMs]  how long the process's executor has run so far
         */
        tick(retired, busyMs = null){
            if (fixed !== null)
            {
                return;
            }
            const at = now();
            if (trialAt < 0)
            {
                changedSince = lastByFrames === null || presenting(at) === lastByFrames ? -1
                    : changedSince < 0 ? at : changedSince;
                watchWork(at, retired);
                const first = lastByFrames === null && at >= nextTrial;
                const presentsOtherwise = changedSince >= 0 && at - changedSince >= changeMs;
                const workMoved = movedWindows >= lasting && at >= nextTrial;
                if (!(first || presentsOtherwise || workMoved) || !mayBegin())
                {
                    return;
                }
                counted.byWork += workMoved && !presentsOtherwise ? 1 : 0;
                changedSince = -1;
                measuredOn = null;
                profile = null;
                profileFrom = Infinity;
                movedWindows = 0;
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
                    open = { from: at, retired, frames: 0, firstFrame: -1, lastFrame: -1,
                        busy: busyMs };
                }
                return;
            }
            const ms = at - open.from;
            if (ms < windowMs || ms < maxWindowMs && open.frames < minFrames && presenting(at))
            {
                return;
            }
            windows.push({ mode, ms, retired: retired - open.retired, presented: open.frames,
                frames: Math.max(0, open.frames - 1), framesMs: open.lastFrame - open.firstFrame,
                busy: busyMs !== null && open.busy !== null ? busyMs - open.busy : null });
            open = null;
            const sofar = windows.length === 2 ? rates(windows) : null;
            const settled = sofar !== null && (sofar.risky > sofar.safe * (1 + clear)
                || sofar.safe > sofar.risky * (1 + clear));
            if (windows.length < order.length && !settled)
            {
                switchTo(order[windows.length], at);
                return;
            }
            const winner = decide(windows);
            switchTo(winner, at);
            trialAt = -1;
            nextTrial = at + holdMs;
            // The work the winner is kept for is read once the threads are its way.
            profileFrom = at + settleMs;
        },

        /**
         * The way now, the trials' account, how far the threads' last window of
         * work lay from the one after the last trial, and its speed against the
         * trial's measure of the winner.
         * @returns {Record<string, any>}
         */
        diagnostics: ()=>({ mode, fixed, ...counted, moved: Number(moved.toFixed(2)),
            speed: Number(lastDrift.toFixed(2)) }),
    };
}

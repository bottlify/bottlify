/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pool's driver (roadmap/v2, stage 2, "The rule"): from what each
 * process's translation workers did in the last window, which of them a
 * worker joins and which one leaves. A pure function of its state and the
 * sample, so the same decisions are taken in the engine and in a test that
 * replays a recorded load through it.
 *
 * With n processes running: each has its first worker from its start to its
 * exit, never let go. More join a process one at a time when the median load
 * of the workers already working for it -- the share of the window each was
 * busy -- comes to `joinAt`: the median says the work is spread over them and
 * each is near full, so one more takes a share; two at 90 % and 10 % have a
 * median of 50 %, the work does not split, and a third would sit as idle as
 * the second. At most `perProcess` work for one process (the host's
 * concurrency), and at most `perProcess` × n in the pool. A joined worker
 * leaves at once when the process's workers were all idle for a window -- it
 * stopped translating to wait -- and otherwise after `leaveAfterMs` of its
 * median below `leaveBelow`: joining quick, leaving slow, so the pool does
 * not swing.
 *
 * Busy workers are not yet workers that help: on a machine with no core to
 * spare -- four cores, a game loading, the engine's thread, its translator and
 * the browser's own threads taking all of them -- one more worker takes a
 * core from the others, and every region costs more (roadmap/
 * negative-results.md, 2026-10-07). So each join is a trial: the regions the
 * process's workers emit a second over the `trialWindows` after it are
 * weighed against the rate before it, and unless they rose by `yieldShare` of
 * what one more worker would add at best, the worker leaves and the process
 * keeps that many as its ceiling for the run.
 */

/**
 * @typedef {Object} DriverSettings
 * @property {number} perProcess  workers at most for one process (`hardwareConcurrency`)
 * @property {number} [joinAt]    the median share at which one more joins
 * @property {number} [leaveBelow]  the median share under which one leaves, in time
 * @property {number} [leaveAfterMs]  how long the median stays under it first
 * @property {number} [idleBelow]  a share this low counts as idle (a process that waits)
 * @property {number} [trialWindows]  windows with work a join is weighed over
 * @property {number} [trialLimit]  windows a join waits for that many; past them it leaves, no
 *     ceiling kept: the work does not last long enough to need it
 * @property {number} [restMs]  after such a join, how long no other is tried
 * @property {number} [yieldShare]  of the gain one more worker brings at best, the share a
 *     join must bring to stay
 */

/**
 * @typedef {Object} ProcessSample  One process, over the last window.
 * @property {number} id
 * @property {number[]} shares  each of its workers' busy share of the window, its first first
 * @property {number} [rate]  regions its workers emitted a second over the window
 */

/**
 * @typedef {{ kind: 'join', process: number } | { kind: 'leave', process: number }} Decision
 *     leave: the process's least busy joined worker (never its first)
 */

/**
 * @typedef {Object} DriverState
 * @property {Map<number, number>} lowSince  by process: when its median went under
 *     `leaveBelow`, while it stays there
 * @property {Map<number, number[]>} rates  by process: its rates over the last windows
 * @property {Map<number, { workers: number, before: number, rates: number[],
 *     windows: number }>} trials
 *     by process: a join being weighed -- how many worked before it, at what rate, the rates
 *     of the windows with work since, and every window since
 * @property {Map<number, number>} ceilings  by process: the workers a trial found it
 *     gains nothing past
 * @property {Map<number, number>} restUntil  by process: no join is tried before then
 */

/** @returns {DriverState} */
export function createDriverState(){
    return { lowSince: new Map(), rates: new Map(), trials: new Map(), ceilings: new Map(),
        restUntil: new Map() };
}

/** @param {number[]} values */
export function median(values){
    if (values.length === 0)
    {
        return 0;
    }
    const sorted = [...values].sort((a, b)=>a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The decisions for one window. A process gains or loses one worker at most
 * per window; the pool's ceiling is `perProcess` × the processes sampled.
 *
 * @param {DriverState} state
 * @param {ProcessSample[]} processes
 * @param {number} now  the window's end, in milliseconds
 * @param {DriverSettings} settings
 * @returns {Decision[]}
 */
export function decide(state, processes, now, settings){
    const joinAt = settings.joinAt ?? 0.8;
    const leaveBelow = settings.leaveBelow ?? 0.4;
    const leaveAfterMs = settings.leaveAfterMs ?? 3000;
    const idleBelow = settings.idleBelow ?? 0.02;
    const trialWindows = settings.trialWindows ?? 4;
    const trialLimit = settings.trialLimit ?? 8;
    const restMs = settings.restMs ?? 10000;
    const yieldShare = settings.yieldShare ?? 0.5;
    const perProcess = Math.max(1, settings.perProcess);
    const ceiling = perProcess * processes.length;
    let working = processes.reduce((sum, one)=>sum + one.shares.length, 0);
    /** @type {Decision[]} */
    const decisions = [];
    const sampled = new Set(processes.map(one=>one.id));
    for (const kept of [state.lowSince, state.rates, state.trials, state.ceilings,
        state.restUntil])
    {
        for (const id of kept.keys())
        {
            if (!sampled.has(id))
            {
                kept.delete(id);
            }
        }
    }
    for (const { id, shares, rate = 0 } of processes)
    {
        const middle = median(shares);
        const joined = shares.length - 1;
        // The rate before a join is the mean of the last windows': regions
        // are counted as each batch ends, and one window is lumpy.
        const recent = state.rates.get(id) ?? [];
        const before = recent.length === 0 ? rate
            : recent.reduce((sum, one)=>sum + one, 0) / recent.length;
        recent.push(rate);
        if (recent.length > trialWindows)
        {
            recent.shift();
        }
        state.rates.set(id, recent);
        const trial = state.trials.get(id);
        if (trial !== undefined)
        {
            trial.windows++;
        }
        if (trial !== undefined && trial.windows > trialLimit
            && trial.rates.length < trialWindows)
        {
            // Too few windows with work to weigh it: the work does not last
            // long enough to need it, which says nothing of a ceiling.
            state.trials.delete(id);
            state.restUntil.set(id, now + restMs);
            decisions.push({ kind: 'leave', process: id });
            working--;
            continue;
        }
        // A trial is weighed only over windows the work lasts: workers that
        // ran out of it say nothing of what one more is worth. Meanwhile it
        // goes by the rules below, and no other joins.
        if (trial !== undefined && middle >= joinAt)
        {
            trial.rates.push(rate);
            if (trial.rates.length < trialWindows)
            {
                continue;
            }
            state.trials.delete(id);
            const after = trial.rates.reduce((sum, one)=>sum + one, 0) / trial.rates.length;
            if (after < trial.before * (1 + yieldShare / trial.workers))
            {
                decisions.push({ kind: 'leave', process: id });
                working--;
                state.ceilings.set(id, trial.workers);
            }
            continue;
        }
        if (joined > 0 && shares.every(share=>share < idleBelow))
        {
            // It stopped translating to wait: every joined worker goes now.
            for (let n = 0; n < joined; n++)
            {
                decisions.push({ kind: 'leave', process: id });
            }
            working -= joined;
            state.lowSince.delete(id);
            state.trials.delete(id);
            continue;
        }
        if (middle >= joinAt)
        {
            state.lowSince.delete(id);
            if (trial === undefined && now >= (state.restUntil.get(id) ?? 0)
                && shares.length < Math.min(perProcess, state.ceilings.get(id) ?? perProcess)
                && working < ceiling)
            {
                decisions.push({ kind: 'join', process: id });
                working++;
                state.trials.set(id, { workers: shares.length, before: Math.max(before, rate),
                    rates: [], windows: 0 });
            }
            continue;
        }
        if (joined === 0 || middle >= leaveBelow)
        {
            state.lowSince.delete(id);
            continue;
        }
        const since = state.lowSince.get(id);
        if (since === undefined)
        {
            state.lowSince.set(id, now);
        }
        else if (now - since >= leaveAfterMs)
        {
            decisions.push({ kind: 'leave', process: id });
            working--;
            state.trials.delete(id);
            // The next one goes after as long again.
            state.lowSince.set(id, now);
        }
    }
    return decisions;
}

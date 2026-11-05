/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Frame drops, each told why: how evenly the frames came (the mean, the
 * slowest 1% and 0.1% as frame rates, the worst frames), and for every frame
 * that took over twice the median, what it spent its extra time on.
 *
 * A drop is read against the median frame rather than against a budget: what
 * the frame did beyond what an ordinary frame of the same run did is its
 * cause. Each part of the frame record is compared -- the guest's time, ours,
 * the machine parked on something that had not answered, and what the
 * record does not account for at all -- and the part that grew the most
 * names the drop:
 *
 * - `translation`: the guest's time grew in a frame the translator
 *   instantiated more modules in than an ordinary one, or ran more of its
 *   instructions interpreted:
 *   new code, met for the first time.
 * - `guest work`: the guest's time grew with its instructions: the program
 *   did more that frame (a load, a spawn), and nothing of ours was slower.
 * - `guest slower`: the guest's time grew and its instructions did not: the
 *   same work ran slower in the translator.
 * - `host <phase>`: our own time grew, named by the frame's longest phase.
 * - `waiting` / `fetch`: the machine was parked on a host call, a message
 *   queue or data arriving from outside.
 * - `outside the engine`: wall time no phase accounts for, which is the
 *   browser's -- a garbage collection when the heap shrank in the frame,
 *   otherwise the page's other work or the system's scheduling.
 *
 * The GPU's own time and the wait to present are not in the frame record; a
 * drop they caused falls in `outside the engine`, and `gpu` says so as "not
 * measured" until a record carries it.
 *
 * @typedef {{ ms: number, byKind: Record<string, number>, idleMs?: number,
 *     waits?: number, compiles?: number, instructions?: number,
 *     notes?: Record<string, number>, longest?: { name: string, ms: number },
 *     index?: number }} FrameLike
 *
 * @typedef {{ index: number, ms: number, cause: string, excessMs: number,
 *     parts: Record<string, number> }} Drop
 *
 * @typedef {{ frames: number, fps: number, medianMs: number, low1: number,
 *     low01: number, worstMs: number[], drops: Drop[],
 *     byCause: Record<string, number>, gpu: string }} DropReport
 */

/** @param {number[]} sorted @param {number} share */
const quantile = (sorted, share)=>sorted[Math.min(sorted.length - 1,
    Math.floor(sorted.length * share))];

/**
 * The frame rate of the slowest share of the frames: their mean frame time
 * as a rate, at least one frame. What a player calls "1% low".
 *
 * @param {number[]} descending  Frame times, slowest first.
 * @param {number} share
 */
const lowRate = (descending, share)=>{
    const slowest = descending.slice(0, Math.max(1, Math.round(descending.length * share)));
    const mean = slowest.reduce((sum, ms)=>sum + ms, 0) / slowest.length;
    return mean > 0 ? 1000 / mean : 0;
};

/**
 * What a frame's wall time was made of, as the parts a drop is told apart by.
 *
 * @param {FrameLike} frame
 */
const partsOf = frame=>{
    const guest = frame.byKind.guest ?? 0;
    const host = frame.byKind.host ?? 0;
    const idle = frame.idleMs ?? 0;
    const accounted = guest + host + (frame.byKind.gpu ?? 0) + (frame.byKind.present ?? 0) + idle;
    return { guest, host, idle, outside: Math.max(0, frame.ms - accounted) };
};

/**
 * @param {FrameLike[]} frames  Oldest first, as `app.log.frames` answers them.
 * @param {{ gpuMeasured?: boolean }} [options]
 * @returns {DropReport}
 */
export function frameDrops(frames, options = {}){
    const gpu = options.gpuMeasured ? 'measured' : 'not measured';
    const timed = frames.filter(frame=>frame.ms > 0);
    if (timed.length === 0)
    {
        return { frames: 0, fps: 0, medianMs: 0, low1: 0, low01: 0, worstMs: [], drops: [],
            byCause: {}, gpu };
    }
    const ascending = timed.map(frame=>frame.ms).sort((one, two)=>one - two);
    const descending = [...ascending].reverse();
    const medianMs = quantile(ascending, 0.5);
    const totalMs = ascending.reduce((sum, ms)=>sum + ms, 0);
    /** @param {(frame: FrameLike) => number} pick */
    const median = pick=>quantile(timed.map(pick).sort((one, two)=>one - two), 0.5);
    const ordinary = {
        guest: median(frame=>partsOf(frame).guest),
        host: median(frame=>partsOf(frame).host),
        idle: median(frame=>partsOf(frame).idle),
        outside: median(frame=>partsOf(frame).outside),
        instructions: median(frame=>frame.instructions ?? 0),
        interpreted: median(frame=>frame.notes?.interpreted ?? 0),
        compiles: median(frame=>frame.compiles ?? 0),
    };

    /** @type {Drop[]} */
    const drops = [];
    /** @type {Record<string, number>} */
    const byCause = {};
    for (const frame of timed)
    {
        if (frame.ms <= 2 * medianMs)
        {
            continue;
        }
        const parts = partsOf(frame);
        const grew = /** @type {[keyof typeof parts, number][]} */ (
            Object.entries(parts).map(([part, ms])=>[part,
                ms - ordinary[/** @type {keyof typeof parts} */ (part)]]))
            .sort((one, two)=>two[1] - one[1]);
        const [part] = grew[0];
        const cause = causeOf(part, frame, ordinary);
        byCause[cause] = (byCause[cause] ?? 0) + 1;
        drops.push({ index: frame.index ?? -1, ms: frame.ms, cause,
            excessMs: frame.ms - medianMs, parts });
    }
    return {
        frames: timed.length,
        fps: 1000 * timed.length / totalMs,
        medianMs,
        low1: lowRate(descending, 0.01),
        low01: lowRate(descending, 0.001),
        worstMs: descending.slice(0, 5),
        drops,
        byCause,
        gpu,
    };
}

/**
 * The name of what a drop spent its extra time on, from the part that grew
 * most and what else the frame says about it.
 *
 * @param {string} part
 * @param {FrameLike} frame
 * @param {{ instructions: number, interpreted: number, compiles: number }} ordinary
 */
function causeOf(part, frame, ordinary){
    if (part === 'guest')
    {
        if ((frame.compiles ?? 0) > ordinary.compiles
            || (frame.notes?.interpreted ?? 0) > Math.max(1, 2 * ordinary.interpreted))
        {
            return 'translation';
        }
        return (frame.instructions ?? 0) > 1.5 * ordinary.instructions
            ? 'guest work' : 'guest slower';
    }
    if (part === 'host')
    {
        return frame.longest?.name ? `host ${frame.longest.name}` : 'host';
    }
    if (part === 'idle')
    {
        return (frame.waits ?? 0) > 0 ? 'fetch' : 'waiting';
    }
    return (frame.notes?.heapDelta ?? 0) < 0 ? 'outside the engine: garbage collection'
        : 'outside the engine';
}

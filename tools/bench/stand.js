/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translator's stand, shared by the page (`index.html`, in a worker) and
 * the command line (`stand.mjs`): cork's micro workloads (flat images loaded at
 * 0x401000, one call of `main` an iteration to its `hlt`, 32-bit and x86-64)
 * run on the guest's own clock (`clock: 'virtual'`, a million instructions
 * retired is one millisecond), so every machine translates and runs the same
 * code however busy it is. Two answers a workload:
 *
 *   work  what the run did, to the unit: instructions retired, the program's
 *         checksum, regions, and each way between regions (`blockProfile`'s
 *         mechanisms). The same on every machine and browser; a difference
 *         from `expected.json` is the code's, never the machine's.
 *   time  the machine's milliseconds for each window of guest work, the arms
 *         (builds) interleaved round by round: each arm's median, each arm's
 *         ratio to the first in the same round (a drift of the machine reaches
 *         both), and how far the first arm's own rounds part -- the noise floor
 *         a ratio has to clear.
 *
 * No Node and no DOM here: an arm is `{ createCorkHost, engine }`, an image is
 * its bytes.
 */

const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;
/** Guest instructions in one virtual millisecond (`VIRTUAL_INSTRUCTIONS_PER_MS`). */
const PER_MS = 1e6;

/**
 * @typedef {{ createCorkHost: (options: any) => any, engine: any, label?: string }} Arm
 * @typedef {{ name: string, bits: 32 | 64, image: Uint8Array }} Workload
 * @typedef {{ retired: number, eax: string, regions: number,
 *     mechanisms: Record<string, number> }} Work
 */

/**
 * A host running one workload on the guest's clock. `profile` counts the ways
 * between regions (a build of its own: the counts are code).
 *
 * @param {Arm} arm @param {Workload} workload @param {boolean} profile
 */
function hostOf(arm, workload, profile){
    const host = arm.createCorkHost({
        engine: arm.engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, ...workload.bits === 64 ? { bits: 64 } : {},
        // The wasm interpreter from the first instruction: its start is the
        // process's, which a page or a second host would otherwise move.
        cork: { clock: 'virtual', wasmInterpreterAfter: 0,
            ...profile ? { blockProfile: true } : {} },
    });
    host.writePhysical(IMAGE_BASE, workload.image);
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    let retired = 0;
    return {
        host,
        /** One call of main to its `hlt`, translation between the slices. */
        async iteration(){
            retired += host.runSlice(100_000);
            while (!host.halted())
            {
                await host.cork().translatePending();
                retired += host.runSlice(100_000);
            }
        },
        retired: ()=>retired,
        /** What the run has translated: a change means an iteration still formed. */
        formed(){
            const d = host.cork().diagnostics();
            return `${d.regions ?? 0}/${d.reforms ?? 0}/${d.copied ?? 0}`;
        },
    };
}

/**
 * What `warm` iterations do, to the unit.
 *
 * @param {Arm} arm @param {Workload} workload @param {number} warm
 * @returns {Promise<Work>}
 */
export async function workOf(arm, workload, warm){
    const run = hostOf(arm, workload, true);
    for (let i = 0; i < warm; i++)
    {
        await run.iteration();
    }
    const d = run.host.cork().diagnostics();
    const mechanisms = Object.fromEntries(Object.entries(d.mechanisms ?? {})
        .filter(([, count])=>count !== 0).sort(([a], [b])=>(a < b ? -1 : a > b ? 1 : 0)));
    return { retired: run.retired(), eax: (run.host.readReg32('eax') >>> 0).toString(16),
        regions: d.regions ?? 0, mechanisms };
}

/** @param {number[]} values @param {number} at  the share, 0..1 */
export function quantile(values, at){
    const sorted = [...values].sort((a, b)=>a - b);
    const x = at * (sorted.length - 1);
    const lo = Math.floor(x);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (x - lo);
}

/** @param {Work} a @param {Work} b */
export const sameWork = (a, b)=>JSON.stringify(a) === JSON.stringify(b);

/**
 * The arms' time on one workload: each warmed until an iteration forms nothing
 * (and at least `warm` iterations), then `rounds` rounds, each arm in turn (the
 * order turned round every round) running iterations until `windowMs` virtual
 * milliseconds of guest work. A round's figure is the machine's milliseconds a
 * virtual one.
 *
 * @param {Arm[]} arms @param {Workload} workload
 * @param {{ warm: number, warmMs: number, rounds: number, windowMs: number,
 *     now: () => number }} options
 */
export async function timeOf(arms, workload, { warm, warmMs, rounds, windowMs, now }){
    const runs = arms.map(arm=>hostOf(arm, workload, false));
    for (const run of runs)
    {
        for (let i = 0, last = ''; i < warm || i < 8 * warm && run.formed() !== last; i++)
        {
            last = run.formed();
            await run.iteration();
        }
        // Then `warmMs` of guest work more: the engine still optimises the
        // regions' functions after the translator is done (calls512-order's
        // rounds parted by 70 % without it, in Chromium 153).
        const settled = run.retired();
        while (run.retired() - settled < warmMs * PER_MS)
        {
            await run.iteration();
        }
    }
    /** @type {number[][]} */
    const perVirtualMs = runs.map(()=>[]);
    for (let round = 0; round < rounds; round++)
    {
        const order = runs.map((_, at)=>at);
        for (const at of round % 2 ? order.reverse() : order)
        {
            const run = runs[at];
            const from = run.retired();
            const startedAt = now();
            while (run.retired() - from < windowMs * PER_MS)
            {
                await run.iteration();
            }
            perVirtualMs[at].push((now() - startedAt) / ((run.retired() - from) / PER_MS));
        }
    }
    const medians = perVirtualMs.map(values=>quantile(values, 0.5));
    const paired = perVirtualMs.map(values=>values
        .map((value, round)=>value / perVirtualMs[0][round]));
    return {
        // Real milliseconds a virtual one; its inverse is millions of guest
        // instructions a second.
        msPerVirtualMs: medians,
        mips: medians.map(ms=>1000 / ms),
        ratio: paired.map(values=>quantile(values, 0.5)),
        // How far the first arm's own rounds part, half the interquartile range
        // over the median: a ratio inside it is no change this machine shows.
        noise: (quantile(perVirtualMs[0], 0.75) - quantile(perVirtualMs[0], 0.25)) / 2 / medians[0],
        rounds: perVirtualMs,
    };
}

/**
 * The stand over `workloads`: each workload's work in every arm (unless
 * `work` is false: a repeated run needs it once), compared with `expected` (by
 * workload name) where given, then its time (unless `timed` is false).
 *
 * @param {Arm[]} arms @param {Workload[]} workloads
 * @param {{ warm?: number, warmMs?: number, rounds?: number, windowMs?: number,
 *     now: () => number,
 *     expected?: Record<string, { work: Work }>, timed?: boolean, work?: boolean,
 *     onRow?: (row: any) => void }} options
 */
export async function runStand(arms, workloads, options){
    const { warm = 20, warmMs = 200, rounds = 7, windowMs = 30, now, expected, timed = true,
        work: counted = true, onRow } = options;
    const rows = [];
    for (const workload of workloads)
    {
        /** @type {Work[]} */
        const work = [];
        for (const arm of counted ? arms : [])
        {
            work.push(await workOf(arm, workload, warm));
        }
        const reference = expected?.[workload.name]?.work;
        const row = {
            name: workload.name, bits: workload.bits, work: counted ? work : null,
            // Every arm's work as the first's; and the last's as recorded (the
            // record is made from the newest checkout, the last arm).
            same: counted ? work.every(one=>sameWork(one, work[0])) : null,
            expected: !counted || reference === undefined ? null
                : sameWork(work[work.length - 1], reference),
            ...timed ? await timeOf(arms, workload, { warm, warmMs, rounds, windowMs, now }) : {},
        };
        rows.push(row);
        onRow?.(row);
    }
    return rows;
}

/** The geometric mean of the arms' MIPS over rows of one width. @param {any[]} rows */
export function geomean(rows){
    if (rows.length === 0 || rows[0].mips === undefined)
    {
        return null;
    }
    return rows[0].mips.map((/** @type {number} */ unused, /** @type {number} */ arm)=>Math.exp(
        rows.reduce((sum, row)=>sum + Math.log(row.mips[arm]), 0) / rows.length));
}

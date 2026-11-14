/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The region-shape gate: how the translated micro workloads move between their
 * regions, counted (`blockProfile`'s mechanisms), against the counts recorded in
 * `testing/region-shapes.json`. The corpus gates judge what a program observes,
 * which a worse region does not change: a callee cut by the caps in its middle
 * still computes the right answer through the entry hash, four times as often
 * (2dfa4a83a). These counts are what such a change moves.
 *
 * Each workload of the 32-bit images and of their x86-64 twins runs a few
 * iterations on the cork host, the translator's work awaited between slices,
 * and is counted over as many more: the shape once warm. The first iterations
 * are when translations land, which the run's timing decides -- a call to a
 * callee not yet translated comes back from outside, into its loop's copy.
 * The counts still move a little from run to run (what a batch of forming
 * takes in before its time is up), so each key is compared as a smoothed ratio
 * within the workload's own factor, measured when the counts were recorded.
 * A workload whose counts the run's timing decides outright is listed in
 * `unstable` with its cause and skipped, never passed.
 *
 * After a change that moves shapes on purpose, record them again:
 *
 *     CORK_SHAPES_WRITE=5 node --test modules/cork/src/region-shapes.itest.js
 *
 * runs every workload five times and writes the medians and factors; a
 * workload whose runs part by more than UNSTABLE_SPREAD needs its cause in
 * `CAUSES` below, or the recording fails, and one named there is unstable
 * whatever its five runs did.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createCorkHost } from '../../core/src/layers/cpu/internal/cork-host.js';
import * as engine from './index.js';

/** The ways between regions that say how a workload's regions are formed. */
const KEYS = ['TRANSFER', 'RET_LEFT', 'CALL_LEFT', 'CALL_LINKED', 'CALL_FORMED', 'RET_FORMED',
    'RET_TO_CALL', 'JUMP_DISPATCH', 'APART_FULL', 'APART_NESTED', 'APART_BLOCKS',
    'APART_UNPREDICTED'];
const ITERATIONS = 4;
/** Added to both counts of a ratio, so that 2 against 4 is no change. */
const SMOOTHING = 64;
/** The least factor a key may move by: the run-to-run spread seen, with room. */
const LEAST_FACTOR = 2;
/** Runs parting by more than this are the run's timing, not the code's shape. */
const UNSTABLE_SPREAD = 2;
/** Why a workload's counts are the run's timing (`unstable`), by workload. */
const CAUSES = {
    'vcall-x87': 'which callees an indirect call is predicted to depends on when its samples'
        + ' fall due (a region formed again at most three times; board card c3)',
    'vcall-x64': 'as vcall-x87 (board card c3)',
    'calls8-order-x87': 'the indirect calls\' prediction falls due by timing (board card c3)',
    'calls8-scatter-x87': 'as calls8-order-x87 (board card c3)',
    'calls8-order-x64': 'as calls8-order-x87 (board card c3)',
    'calls8-scatter-x64': 'as calls8-order-x87 (board card c3)',
    'calls512-order-x87': 'how many of its calls through the table find their callee linked'
        + ' in the hash depends on when each callee was published: its transfers part 2x'
        + ' between orders of runs',
    'calls512-scatter-x87': 'as calls512-order-x87',
    'calls4096-order-x87': 'as calls512-order-x87',
    'calls4096-scatter-x87': 'as calls512-order-x87',
    'calls512-order-x64': 'as calls512-order-x87',
    'calls512-scatter-x64': 'as calls512-order-x87',
    'calls4096-order-x64': 'as calls512-order-x87',
    'calls4096-scatter-x64': 'as calls512-order-x87',
    'patch-x87': 'when a write to its own code drops the region and it is formed again is a'
        + ' matter of the slice the write lands in',
    'patch-x64': 'as patch-x87',
};

const RECORD = new URL('./testing/region-shapes.json', import.meta.url);
const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;

/** @param {32 | 64} bits */
const imagesOf = bits=>new URL(bits === 64 ? '../bench/micro/images64/' : '../bench/micro/images/',
    import.meta.url);

/**
 * One workload's counts over ITERATIONS calls of its main, after as many
 * that warmed it.
 *
 * @param {32 | 64} bits @param {string} name
 * @returns {Promise<Record<string, number>>}
 */
async function countsOf(bits, name){
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, cork: { blockProfile: true }, ...(bits === 64 ? { bits } : {}),
    });
    host.writePhysical(IMAGE_BASE, readFileSync(new URL(`${name}.bin`, imagesOf(bits))));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    const counted = ()=>{
        const { mechanisms } = host.cork().diagnostics();
        return Object.fromEntries(KEYS.map(key=>[key, Number(mechanisms[key] ?? 0)]));
    };
    /** @type {Record<string, number>} */
    let warm = {};
    for (let i = 0; i < 2 * ITERATIONS; i++)
    {
        if (i === ITERATIONS)
        {
            warm = counted();
        }
        host.runSlice(100_000);
        while (!host.halted())
        {
            await host.cork().translatePending();
            host.runSlice(100_000);
        }
    }
    const all = counted();
    return Object.fromEntries(KEYS.map(key=>[key, all[key] - warm[key]]));
}

/** @param {number} a @param {number} b */
const ratio = (a, b)=>Math.max((a + SMOOTHING) / (b + SMOOTHING), (b + SMOOTHING) / (a + SMOOTHING));

/** @param {32 | 64} bits */
const namesOf = bits=>readdirSync(imagesOf(bits)).filter(file=>file.endsWith('.bin'))
    .map(file=>file.slice(0, -4)).sort();

/**
 * @typedef {{ workloads: Record<string, { counts: Record<string, number>, factor: number }>,
 *     unstable: Record<string, string> }} Shapes
 */

const writing = Number(process.env.CORK_SHAPES_WRITE ?? 0);

if (writing > 0)
{
    test('the region shapes recorded again', { timeout: 3_600_000 }, async()=>{
        /** @type {Shapes} */
        const record = { workloads: {}, unstable: {} };
        for (const bits of /** @type {(32 | 64)[]} */ ([32, 64]))
        {
            for (const name of namesOf(bits))
            {
                /** @type {Record<string, number>[]} */
                const runs = [];
                for (let run = 0; run < writing; run++)
                {
                    runs.push(await countsOf(bits, name));
                }
                const counts = Object.fromEntries(KEYS.map(key=>{
                    const sorted = runs.map(one=>one[key]).sort((a, b)=>a - b);
                    return [key, sorted[sorted.length >> 1]];
                }));
                const spread = Math.max(1, ...KEYS.flatMap(key=>runs.map(one=>ratio(one[key],
                    counts[key]))));
                const cause = CAUSES[/** @type {keyof typeof CAUSES} */ (name)];
                // A workload with a known cause stays unstable though five runs agreed: it was
                // seen to part in other orders of runs.
                if (spread > UNSTABLE_SPREAD || cause !== undefined)
                {
                    assert.ok(cause, `${name} (${bits}-bit) parts ${spread.toFixed(2)}x from run to`
                        + ' run: name its cause in CAUSES');
                    record.unstable[`${bits}/${name}`] = cause;
                    continue;
                }
                record.workloads[`${bits}/${name}`] = {
                    counts, factor: Number(Math.max(LEAST_FACTOR, spread ** 1.5).toFixed(2)),
                };
            }
        }
        writeFileSync(RECORD, `${JSON.stringify(record, null, 1)}\n`);
    });
}
else
{
    /** @type {Shapes} */
    const record = JSON.parse(readFileSync(RECORD, 'utf8'));
    for (const bits of /** @type {(32 | 64)[]} */ ([32, 64]))
    {
        for (const name of namesOf(bits))
        {
            const key = `${bits}/${name}`;
            const unstable = record.unstable[key];
            const recorded = record.workloads[key];
            test(`${key} moves between its regions as recorded`, { timeout: 600_000 }, async t=>{
                if (unstable !== undefined)
                {
                    t.skip(`its counts are the run's timing: ${unstable}`);
                    return;
                }
                assert.ok(recorded, `${key} has no recorded shape: record them again`
                    + ' (CORK_SHAPES_WRITE=5)');
                const counts = await countsOf(bits, name);
                const off = KEYS.filter(one=>ratio(counts[one], recorded.counts[one])
                    > recorded.factor).map(one=>`${one} ${counts[one]} (recorded ${
                    recorded.counts[one]})`);
                assert.deepEqual(off, [], `${key} moves otherwise than recorded, beyond x${
                    recorded.factor}`);
            });
        }
    }
}

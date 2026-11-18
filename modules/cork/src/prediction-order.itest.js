/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The prediction gate: the callees an indirect call has formed into its region
 * are the program's and not the run's. A call's callees are taken from samples
 * of where it went (`runtime/relink.js`, `calleesWorth`), and which samples a
 * reading holds is a matter of where the slices of the run fell; named in the
 * order of their counts, three methods called as often as one another came
 * out in any of their six orders, each a region of its own that V8 compiled
 * several per cent apart from the others.
 *
 * Each workload with such calls runs on the cork host with the guest's own
 * clock, in slices of several lengths - the run's timing, made on purpose -
 * and what its calls came to have formed in is compared between them: for
 * each call the list of the region that has the most of its callees, since
 * a region the program left early keeps what the first samples gave it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCorkHost } from '../../core/src/layers/cpu/internal/cork-host.js';
import * as engine from './index.js';
import { allowMemory64, ifRoom } from './testing/memory64.js';

const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;
const ITERATIONS = 300;
/** Instructions a slice: the stand's, a prime, one that cuts an iteration many times, and
 * one longer than an iteration. */
const SLICES = [100_000, 37_003, 5_000, 777_777];
const WORKLOADS = ['vcall', 'calls8-order', 'calls8-scatter'];

/**
 * By call, the callees the region with the most of them has formed in, in the
 * order the call compares them.
 *
 * @param {32 | 64} bits @param {string} name @param {number} slice
 * @param {{ iterations?: number, window?: number }} [how]  `window`: a wide window's bytes
 * @returns {Promise<Map<number, number[]>>}
 */
async function predictionOf(bits, name, slice, { iterations = ITERATIONS, window } = {}){
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, cork: { clock: 'virtual', worker: false, sliceMs: Infinity },
        ...(bits === 64 ? { bits } : {}), ...(window === undefined ? {} : { window }),
    });
    host.writePhysical(IMAGE_BASE, readFileSync(new URL(bits === 64
        ? `../bench/micro/images64/${name}-x64.bin` : `../bench/micro/images/${name}-x87.bin`,
    import.meta.url)));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    for (let i = 0; i < iterations; i++)
    {
        host.runSlice(slice);
        while (!host.halted())
        {
            await host.cork().translatePending();
            host.runSlice(slice);
        }
        await host.cork().translatePending();
    }
    /** @type {Map<number, number[]>} */
    const most = new Map();
    for (const { site, callees } of host.cork().diagnostics().prediction.formed)
    {
        if (callees.length > (most.get(site)?.length ?? 0))
        {
            most.set(site, callees);
        }
    }
    return most;
}

for (const bits of /** @type {const} */ ([32, 64]))
{
    for (const name of WORKLOADS)
    {
        test(`${name} at ${bits} bits: its calls have the same callees formed in, named in the`
            + ' same order, however the run is sliced', async()=>{
            const [first, ...rest] = await Promise.all(SLICES.map(slice=>
                predictionOf(bits, name, slice)));
            assert.ok(first.size > 0 && [...first.values()].every(callees=>callees.length > 1),
                'the workload has calls with several callees formed in');
            const shown = (/** @type {Map<number, number[]>} */ one)=>[...one]
                .sort((a, b)=>a[0] - b[0]).map(([site, callees])=>
                    `${site.toString(16)}: ${callees.map(callee=>callee.toString(16)).join(' ')}`);
            rest.forEach((other, i)=>assert.deepEqual(shown(other), shown(first),
                `slices of ${SLICES[i + 1]} against ${SLICES[0]} instructions`));
        });
    }
}

/**
 * A call spread evenly over hundreds of callees has none worth its compares
 * (`calleesWorth`), however the run is sliced: with the profile's count begun
 * again at each reading, the calls a reading kept were the same ones every
 * time a slice began at the same place in the program - a program that does
 * the same work every iteration, a frame - and a few dozen of four thousand
 * callees, sampled eight times each, looked like all of them: they were
 * formed in and every other call left the region through the transfer.
 */
for (const [bits, name, window] of /** @type {const} */ ([[32, 'calls512-order'],
    [64, 'calls512-order'], [32, 'calls4096-order'], [64, 'calls4096-order'],
    [64, 'calls4096-order', 2 ** 33]]))
{
    test(`${name} at ${bits} bits${window ? ', a wide window' : ''}: a call spread over hundreds`
        + ' of callees has none formed in, however the run is sliced', ifRoom(async()=>{
        if (window)
        {
            allowMemory64();
        }
        for (const slice of SLICES)
        {
            const formed = await predictionOf(bits, name, slice, { iterations: 40, window });
            assert.deepEqual([...formed].map(([site, callees])=>
                `${site.toString(16)}: ${callees.length} callees`), [], `slices of ${slice}`);
        }
    }));
}

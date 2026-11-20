/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One run of the page's stand, in a worker of its own: the page stays
 * answerable while a window runs, and each run starts in an engine nothing has
 * optimised yet. The arms are modules the page names (`arm.js` in a checkout,
 * `arm-<name>.js` in what `build.mjs` made); the workloads are
 * `workloads.json` where `build.mjs` packed them, else the record and the micro
 * benchmark's images of the checkout. Each row is posted as it is done.
 */

import { recordFor, runStand } from './stand.js';
import { withoutFaultingTailCalls } from '../../modules/core/src/tail-calls.js';
import { gcNudgeOf, startGcNudge } from '../../modules/core/src/layers/cpu/internal/gc-nudge.js';

const IMAGES = { 32: '../../modules/cork/bench/micro/images/',
    64: '../../modules/cork/bench/micro/images64/' };

/** @param {string} path */
const here = path=>new URL(path, import.meta.url);

/** @param {string} base64 */
const bytesOf = base64=>Uint8Array.from(atob(base64), char=>char.charCodeAt(0));

/**
 * The record and every workload's bytes: packed, or the checkout's files.
 *
 * @returns {Promise<{ warm: number, workloads: Record<string, any>,
 *     images: (name: string, bits: 32 | 64) => Promise<Uint8Array> }>}
 */
async function recordOf(){
    const packed = await fetch(here('workloads.json'));
    if (packed.ok)
    {
        const record = await packed.json();
        return { ...record, images: async name=>bytesOf(record.workloads[name].image) };
    }
    const record = await (await fetch(here('expected.json'))).json();
    return {
        ...record,
        images: async(name, bits)=>{
            const url = here(`${IMAGES[bits]}${name}.bin`);
            const response = await fetch(url);
            if (!response.ok)
            {
                throw new Error(`${url}: ${response.status}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        },
    };
}

self.onmessage = async(/** @type {MessageEvent} */ event)=>{
    const { arms: named, only = [], bits = [32, 64], rounds = 7, windowMs = 30, timed = true,
        work = true, warmMs = 200 } = event.data;
    try
    {
        // What a run of the product asks of cork in this browser, every arm alike:
        // on an iPhone a wasm tail call into another instance kills the page.
        const cork = withoutFaultingTailCalls({ cork: { config: {} } }).cork?.config ?? {};
        // On JavaScriptCore the hosts each workload makes are collected late
        // unless nudged, as the engine's thread is.
        const nudging = gcNudgeOf(undefined, navigator.userAgent, 16 << 20);
        const nudge = nudging === null ? null : startGcNudge(nudging);
        self.postMessage({ settings: { cork, nudge: nudging } });
        const arms = [];
        for (const arm of named)
        {
            const module = await import(here(arm.url).href);
            arms.push({ createCorkHost: module.createCorkHost, engine: module.engine,
                label: arm.name, cork, tick: nudge === null ? undefined : nudge.poke,
                window: arm.window });
        }
        const record = await recordOf();
        const workloads = [];
        for (const [name, one] of Object.entries(record.workloads))
        {
            if (bits.includes(one.bits)
                && (only.length === 0
                    || only.some((/** @type {string} */ prefix)=>name.startsWith(prefix))))
            {
                const image = await record.images(name, one.bits);
                workloads.push({ name, bits: one.bits, image });
            }
        }
        self.postMessage({ total: workloads.length });
        let saidAt = 0;
        const rows = await runStand(arms, workloads, {
            warm: record.warm, warmMs, rounds, windowMs, timed, work, now: ()=>performance.now(),
            expected: recordFor(record, cork), onRow: row=>self.postMessage({ row }),
            // Where a run is, a few times a second: a phone takes minutes on one
            // workload (calls4096's 4100 regions are as many modules to compile).
            onProgress: (name, step)=>{
                if (performance.now() - saidAt > 250)
                {
                    saidAt = performance.now();
                    self.postMessage({ progress: `${name}: ${step}` });
                }
            },
        });
        self.postMessage({ done: rows.length });
    }
    catch (e){
        self.postMessage({ error: String(/** @type {any} */ (e)?.stack ?? e) });
    }
};

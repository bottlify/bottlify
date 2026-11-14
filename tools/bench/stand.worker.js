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

import { runStand } from './stand.js';

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
        work = true } = event.data;
    try
    {
        const arms = [];
        for (const arm of named)
        {
            const module = await import(here(arm.url).href);
            arms.push({ createCorkHost: module.createCorkHost, engine: module.engine,
                label: arm.name });
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
        const rows = await runStand(arms, workloads, {
            warm: record.warm, rounds, windowMs, timed, work, now: ()=>performance.now(),
            expected: record.workloads, onRow: row=>self.postMessage({ row }),
        });
        self.postMessage({ done: rows.length });
    }
    catch (e){
        self.postMessage({ error: String(/** @type {any} */ (e)?.stack ?? e) });
    }
};

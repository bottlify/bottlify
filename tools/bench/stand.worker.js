/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page's stand in a worker of its own, so the page stays answerable while a
 * window runs: the checkout's cork host and translator loaded as the sources
 * they are (no build), the workloads `expected.json` names fetched from the
 * micro benchmark's images, each row posted as it is done.
 */

import { createCorkHost } from '../../modules/core/src/layers/cpu/internal/cork-host.js';
import * as engine from '../../modules/cork/src/index.js';
import { runStand } from './stand.js';

const IMAGES = { 32: '../../modules/cork/bench/micro/images/', 64: '../../modules/cork/bench/micro/images64/' };

self.onmessage = async(/** @type {MessageEvent} */ event)=>{
    const { only = [], bits = [32, 64], rounds = 7, windowMs = 30, timed = true } = event.data;
    try
    {
        const expected = await (await fetch(new URL('expected.json', import.meta.url))).json();
        const names = Object.entries(expected.workloads)
            .filter(([name, one])=>bits.includes(one.bits)
                && (only.length === 0 || only.some((/** @type {string} */ prefix)=>name.startsWith(prefix))));
        const workloads = [];
        for (const [name, one] of names)
        {
            const url = new URL(`${IMAGES[/** @type {32 | 64} */ (one.bits)]}${name}.bin`, import.meta.url);
            const response = await fetch(url);
            if (!response.ok)
            {
                throw new Error(`${url}: ${response.status}`);
            }
            const image = new Uint8Array(await response.arrayBuffer());
            workloads.push({ name, bits: one.bits, image });
        }
        self.postMessage({ total: workloads.length });
        const rows = await runStand([{ createCorkHost, engine }], workloads, {
            warm: expected.warm, rounds, windowMs, timed, now: ()=>performance.now(),
            expected: expected.workloads, onRow: row=>self.postMessage({ row }),
        });
        self.postMessage({ done: rows.length });
    }
    catch (e){
        self.postMessage({ error: String(/** @type {any} */ (e)?.stack ?? e) });
    }
};

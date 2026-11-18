/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An executor's worker that goes the first time the process hands it a slice
 * while it sleeps between slices, as one a crash or the tab's memory takes:
 * the executor worker as it is, ended by `process.exit` when its sleep on the
 * channel (`Atomics.waitAsync`) wakes to a `RUN` turn. The process then holds
 * a slice out on a worker that is gone, its thread on it.
 *
 * For the gates of a lost executor (node's worker_threads only).
 */

import { Turn } from './executor-channel.js';

const waitAsync = /** @type {any} */ (Atomics).waitAsync.bind(Atomics);
/**
 * @param {Int32Array} word @param {number} index @param {number} value @param {number} ms
 */
const waitOrGo = (word, index, value, ms)=>{
    const waiting = waitAsync(word, index, value, ms);
    if (!waiting.async)
    {
        return waiting;
    }
    return { async: true, value: waiting.value.then((/** @type {string} */ how)=>{
        if (index === 0 && Atomics.load(word, 0) === Turn.RUN)
        {
            process.exit(7);
        }
        return how;
    }) };
};
/** @type {any} */ (Atomics).waitAsync = waitOrGo;
await import('./executor.worker.js');

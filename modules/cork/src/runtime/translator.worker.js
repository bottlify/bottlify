/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translation worker: the runtime forms regions on the engine thread and
 * sends the ones the store did not hold here, so the emitting and encoding
 * happen off the frame thread. The engine thread never waits: it posts a
 * batch and publishes the answer when it arrives, between frames.
 *
 * The worker holds no machine state -- it reads the region the runtime
 * formed, the layout and the host's features out of the message and runs
 * `emitBuilt`, the same function the runtime uses when no worker is
 * attached. A region whose emission throws is answered as a failure, so the
 * engine names it in `refused` rather than losing it.
 *
 * The same file runs under a page's `Worker` and Node's `worker_threads`,
 * which differ only in how the scope receives and sends messages.
 */

import { emitBuilt } from './emit-built.js';

/**
 * @param {{ id: number, jobs: { region: any, entryTop: number }[], layout: any,
 *     features: any, options: any }} data
 * @param {(message: any, transfer: any[]) => void} send
 */
function handle(data, send){
    const { id, jobs, layout, features, options } = data;
    /** @type {ArrayBufferLike[]} */
    const transfer = [];
    const results = jobs.map(job=>{
        const began = performance.now();
        try
        {
            const built = emitBuilt(job.region, job.entryTop, layout, features, options);
            // Compiled here too: a WebAssembly.Module travels in the message
            // (structured clone shares the compiled code), so the engine
            // thread only instantiates -- the compile was most of its
            // per-region cost on a loading phase.
            let compiled = null;
            try
            {
                compiled = new WebAssembly.Module(
                    /** @type {Uint8Array<ArrayBuffer>} */ (built.module));
            }
            catch {
                compiled = null;
            }
            transfer.push(built.module.buffer);
            return { ok: true, built, compiled };
        }
        catch (e){
            const message = e instanceof Error ? e.message : String(e);
            return { ok: false, message: message.slice(0, 160),
                ms: performance.now() - began };
        }
    });
    send({ id, results }, transfer);
}

if (typeof self !== 'undefined' && typeof (/** @type {any} */ (self)).postMessage === 'function')
{
    const scope = /** @type {any} */ (self);
    scope.onmessage = (/** @type {{ data: any }} */ event)=>handle(event.data,
        (message, transfer)=>scope.postMessage(message, transfer));
}
else
{
    const { parentPort } = await import('node:worker_threads');
    parentPort?.on('message', (/** @type {any} */ data)=>handle(data, (message, transfer)=>
        /** @type {any} */ (parentPort).postMessage(message, transfer)));
}

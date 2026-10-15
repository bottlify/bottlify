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
 * `emitBatch`, the same function the runtime uses when no worker is
 * attached: the whole batch in one module. A region whose emission throws is
 * answered as a failure, so the engine names it in `refused` rather than
 * losing it.
 *
 * The same file runs under a page's `Worker` and Node's `worker_threads`,
 * which differ only in how the scope receives and sends messages.
 */

import { moduleDigest, packRegion } from './cache.js';
import { arenaEmitCache, createEmitCache, emitBatch, relinkBatch } from './emit-built.js';

/**
 * Where this worker adds the time it works, in tenths of a millisecond (a
 * word holds 59 hours of them), and next to it the
 * regions it emits and when the batch it is on began, when a pool lends it:
 * the pool's driver reads from these how busy each of its workers was, and how
 * much they got through. The batch under way counts as it goes: a batch of
 * hundreds of regions outlasts the driver's window, and counted only once done
 * it showed a worker idle for a window and then busy for two.
 * @type {{ cells: Int32Array, at: number, epoch: number } | null}
 */
let busyCell = null;
/** Milliseconds since the pool's epoch, on the clock every thread shares. */
const sinceEpoch = (/** @type {number} */ epoch)=>
    Math.max(1, Math.round(performance.timeOrigin + performance.now() - epoch));

/**
 * One runtime this worker serves: the worker's own scope, when a runtime
 * opened it, or a port a pool handed it, when the pool lends it to a process.
 * Each keeps what its runtime gave: the functions emitted before (the
 * process's arena, or a cache of the connection's own where the runtime has
 * none), whose layout, features and options key them, and the doorbell to
 * ring once an answer is posted -- an engine thread that is never handed its
 * event loop on a timer hears the answer by it at its next turn, rather than
 * at its next yield.
 *
 * @param {(message: any, transfer: any[]) => void} send
 */
function connection(send){
    /** @type {import('./emit-built.js').EmitCache} */
    let cache = createEmitCache();
    /** @type {{ posted: Int32Array, postedAt: number, bell: Int32Array, bellAt: number } | null} */
    let doorbell = null;
    /** Rings the engine's doorbell, after the answer is posted. */
    const ring = ()=>{
        if (doorbell)
        {
            Atomics.add(doorbell.posted, doorbell.postedAt, 1);
            Atomics.add(doorbell.bell, doorbell.bellAt, 1);
            Atomics.notify(doorbell.bell, doorbell.bellAt);
        }
    };
    /**
     * A batch of formed regions (`jobs`), or a relink of running ones (`relink`:
     * formed here again from a copy of their pages); with `storeVersion`, the
     * module is to be stored, and is answered digested and packed for it.
     *
     * @param {{ id: number, jobs?: { region: any, entryTop: number }[], relink?: any,
     *     layout: any, features: any, options: any, ready?: boolean, doorbell?: any,
     *     arena?: SharedArrayBuffer | null, storeVersion?: number }} data
     */
    return data=>{
        if (data?.ready === true)
        {
            const given = data.doorbell;
            // A worker of a page that is not cross-origin isolated has no
            // SharedArrayBuffer to name: there is no arena there either.
            if (typeof SharedArrayBuffer === 'function' && data.arena instanceof SharedArrayBuffer)
            {
                cache = arenaEmitCache(data.arena);
            }
            doorbell = given ? {
                posted: new Int32Array(given.posted.buffer), postedAt: given.posted.index,
                bell: new Int32Array(given.bell.buffer), bellAt: given.bell.index,
            } : null;
            // Loaded: the runtime sends batches from here on.
            send({ ready: true }, []);
            ring();
            return;
        }
        const { id, jobs, relink, layout, features, options, storeVersion } = data;
        // The whole of what the batch held this worker for, forming a relink and
        // compiling included: how busy the worker is, which its parts do not say.
        const started = performance.now();
        if (busyCell !== null)
        {
            Atomics.store(busyCell.cells, busyCell.at + 2, sinceEpoch(busyCell.epoch));
        }
        try
        {
            const batch = relink
                ? relinkBatch(relink, layout, features, options, cache)
                : emitBatch(jobs ?? [], layout, features, options, cache);
            // Compiled here too: a WebAssembly.Module travels in the message
            // (structured clone shares the compiled code), so the engine thread
            // only instantiates -- the compile was most of its cost on a loading
            // phase.
            let compiled = null;
            try
            {
                compiled = new WebAssembly.Module(
                    /** @type {Uint8Array<ArrayBuffer>} */ (batch.module));
            }
            catch {
                compiled = null;
            }
            // What the engine stores the module under, and as: hashing and
            // copying its megabytes there held the thread a few milliseconds
            // an answer.
            if (typeof storeVersion === 'number')
            {
                batch.digest = moduleDigest(batch.module);
                batch.packed = packRegion({ module: batch.module, labels: [], cut: [],
                    entryTop: 0, instructions: 0 }, storeVersion);
            }
            const busyMs = performance.now() - started;
            if (busyCell !== null)
            {
                Atomics.add(busyCell.cells, busyCell.at, Math.round(busyMs * 10));
                Atomics.add(busyCell.cells, busyCell.at + 1, batch.results.length);
                Atomics.store(busyCell.cells, busyCell.at + 2, 0);
            }
            send({ id, batch, compiled, busyMs }, [batch.module.buffer,
                ...batch.packed === undefined ? [] : [batch.packed.buffer]]);
        }
        catch (e){
            if (busyCell !== null)
            {
                Atomics.add(busyCell.cells, busyCell.at,
                    Math.round((performance.now() - started) * 10));
                Atomics.store(busyCell.cells, busyCell.at + 2, 0);
            }
            const message = e instanceof Error ? e.message : String(e);
            send({ id, batch: null, message: message.slice(0, 160) }, []);
        }
        ring();
    };
}

/**
 * What reaches the worker's own scope: a runtime's messages, when the runtime
 * opened it; when a pool did, the pool's -- where to count the time worked
 * (`busy`), and a port of a process to serve (`serve`) until its runtime says
 * it is done with it (`done`, over the port).
 *
 * @param {(message: any, transfer: any[]) => void} send
 */
function scopeHandler(send){
    const own = connection(send);
    return (/** @type {any} */ data)=>{
        if (data?.busy !== undefined)
        {
            busyCell = { cells: new Int32Array(data.busy.buffer), at: data.busy.index,
                epoch: data.busy.epoch };
            return;
        }
        if (data?.serve !== undefined)
        {
            /** @type {MessagePort} */
            const port = data.serve;
            const serve = connection((message, transfer)=>port.postMessage(message, transfer));
            /** @param {any} message */
            const onMessage = message=>{
                if (message?.done === true)
                {
                    port.close();
                    return;
                }
                serve(message);
            };
            if (typeof port.addEventListener === 'function' && !('on' in port))
            {
                port.onmessage = event=>onMessage(event.data);
            }
            else
            {
                /** @type {any} */ (port).on('message', onMessage);
            }
            port.start?.();
            return;
        }
        own(data);
    };
}

if (typeof self !== 'undefined' && typeof (/** @type {any} */ (self)).postMessage === 'function')
{
    const scope = /** @type {any} */ (self);
    const handle = scopeHandler((message, transfer)=>scope.postMessage(message, transfer));
    scope.onmessage = (/** @type {{ data: any }} */ event)=>handle(event.data);
}
else
{
    const { parentPort } = await import('node:worker_threads');
    const handle = scopeHandler((message, transfer)=>
        /** @type {any} */ (parentPort).postMessage(message, transfer));
    parentPort?.on('message', handle);
}

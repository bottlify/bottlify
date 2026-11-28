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

import { createReader } from '@bottlify/cellar';
import { moduleDigest, packRegion } from './cache.js';
import { emitBatch, relinkBatch } from './emit-built.js';
import { keptEmitCache, readingSpace } from './kept.js';

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
 * Each keeps what its runtime gave: the functions emitted before (the run's
 * cache, and none where the runtime has none),
 * whose layout, features and options key them, and the doorbell to ring once
 * an answer is posted -- an engine thread that is never handed its
 * event loop on a timer hears the answer by it at its next turn, rather than
 * at its next yield.
 *
 * @param {(message: any, transfer: any[]) => void} send
 */
function connection(send){
    /** @type {import('./emit-built.js').EmitCache | undefined} */
    let cache;
    /**
     * The run's cache as this worker reads it, where its runtime joined it:
     * the functions every thread of the run kept, read in place; what this
     * worker keeps goes back with its answer (`readingSpace`).
     * @type {{ reader: import('@bottlify/cellar').Reader,
     *     space: ReturnType<typeof readingSpace> } | null}
     */
    let kept = null;
    /** @type {{ posted: Int32Array, postedAt: number, bell: Int32Array, bellAt: number } | null} */
    let doorbell = null;
    /**
     * Rings the engine's doorbell, after the answer is posted: its count, and a
     * notify only when the word after it says the engine thread sleeps on it
     * (the host's doorbell keeps its sleepers there).
     */
    const ring = ()=>{
        if (doorbell)
        {
            Atomics.add(doorbell.posted, doorbell.postedAt, 1);
            Atomics.add(doorbell.bell, doorbell.bellAt, 1);
            if (Atomics.load(doorbell.bell, doorbell.bellAt + 1) !== 0)
            {
                Atomics.notify(doorbell.bell, doorbell.bellAt);
            }
        }
    };
    /**
     * A batch of formed regions (`jobs`), or a relink of running ones (`relink`:
     * formed here again from a copy of their pages); with `storeVersion`, the
     * module is to be stored, and is answered digested and packed for it.
     *
     * @param {{ id: number, jobs?: { region: any, entryTop: number }[], relink?: any,
     *     layout: any, features: any, options: any, ready?: boolean, doorbell?: any,
     *     storeVersion?: number,
     *     kept?: { shared: any, segments: (SharedArrayBuffer | null)[], prefix: string } | null,
     *     cache?: any }} data
     */
    return data=>{
        if (data?.ready === true)
        {
            const given = data.doorbell;
            // Joined to the run's cache where its runtime keeps its functions there.
            if (data.kept)
            {
                const { shared, segments, prefix } = data.kept;
                // A reader that asks the keeper nothing: it reads, and its
                // runtime's thread writes.
                const reader = createReader({ shared, segments,
                    keeper: { reserve: ()=>false, raise: ()=>false, raiseLater(){}, drop(){} } });
                const space = readingSpace((name, read)=>reader.with(prefix + name, read));
                kept = { reader, space };
                cache = keptEmitCache(space);
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
        // A segment of the run's cache made or let go, or a larger index.
        if (data?.cache !== undefined)
        {
            kept?.reader.adopt(data.cache);
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
        // A word before each region: the runtime gives up a batch only when its
        // worker has said nothing for long, and knows the region it stopped at.
        const telling = { ...options, progress: (/** @type {number} */ index)=>
            send({ id, alive: index }, []) };
        const hitsBefore = cache?.hits ?? 0;
        try
        {
            const batch = relink
                ? relinkBatch(relink, layout, features, telling, cache)
                : emitBatch(jobs ?? [], layout, features, telling, cache);
            // Compiled here too: a WebAssembly.Module travels in the message
            // (structured clone shares the compiled code), so the engine thread
            // only instantiates -- the compile was most of its cost on a loading
            // phase.
            let compiled = null;
            const compileAt = performance.now();
            try
            {
                compiled = new WebAssembly.Module(
                    /** @type {Uint8Array<ArrayBuffer>} */ (batch.module));
            }
            catch {
                compiled = null;
            }
            const packAt = performance.now();
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
            // The parts of `busyMs` the batch does not time itself (its emitting
            // and encoding are `emitMs` and `encodeMs`).
            const compileMs = packAt - compileAt;
            const packMs = started + busyMs - packAt;
            if (busyCell !== null)
            {
                Atomics.add(busyCell.cells, busyCell.at, Math.round(busyMs * 10));
                Atomics.add(busyCell.cells, busyCell.at + 1, batch.results.length);
                Atomics.store(busyCell.cells, busyCell.at + 2, 0);
            }
            // The functions this batch emitted, for the runtime's thread to keep.
            const handed = kept?.space.taken() ?? [];
            send({ id, batch, compiled, busyMs, compileMs, packMs,
                keptHits: (cache?.hits ?? 0) - hitsBefore,
                ...handed.length > 0 ? { kept: handed } : {} }, [batch.module.buffer,
                ...batch.packed === undefined ? [] : [batch.packed.buffer],
                ...handed.map(one=>one.bytes.buffer)]);
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
    /** The ports served for a pool, each until its runtime is done with it. @type {Set<MessagePort>} */
    const served = new Set();
    return (/** @type {any} */ data)=>{
        // The pool's word that the process it served is gone, whose runtime
        // never said it was done: what was served it goes.
        if (data?.forget === true)
        {
            for (const port of served)
            {
                port.close();
            }
            served.clear();
            return;
        }
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
                    served.delete(port);
                    port.close();
                    return;
                }
                serve(message);
            };
            served.add(port);
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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process in a worker of its own (roadmap/v2, stage 2): its machine, its
 * memory and its translator here, and the run's system half -- registry,
 * volume, windows, ids -- asked across a link to the thread that started it.
 *
 * The thread is the process's alone, so it waits by blocking: on the link's
 * doorbell when it has nothing to run, and in every call it makes to the
 * system, answering what it is asked meanwhile. Its pacing is the workers
 * mode's, read from the link rather than from a page's ring.
 *
 * The same file runs under a page's `Worker` and Node's `worker_threads`. It
 * is told `{ type: 'start', end, options, run }` -- its side of the link, the
 * process as `createApp` takes it, how long it may run -- and answers
 * `{ type: 'exited', code }`, or `{ type: 'failed', message }`.
 */

import { createApp, createMacrotask } from '../app.js';
import { openLink } from '../system/link.js';
import { remoteSystem } from '../system-link.js';
import { ringPacing } from './ring-pacing.js';

/** How often a process with work to do gives its event loop a turn, as the engine's worker does. */
const YIELD_MS = 4;

/**
 * Runs one process to its end.
 *
 * @param {{ end: import('../system/link.js').LinkEnd, options: any, run?: any }} start
 * @returns {Promise<number>} its exit code
 */
export async function serveProcess({ end, options, run }){
    /** @type {Record<string, Record<string, (...args: any[]) => any>>} */
    const handlers = {};
    const link = openLink(end, handlers);
    /** @param {string} target @param {string} method @param {any[]} args */
    const ask = (target, method, args)=>link.callWaiting(target, method, args);
    const system = remoteSystem(ask, handlers, (target, method, args)=>
        link.call(target, method, args));
    // A wait on another process's object ended there: its word comes in
    // with whatever else the link carries, at a turn's end or while idle.
    handlers.kernel = { wake: (/** @type {number} */ token, /** @type {number} */ result)=>
        system.objects.deliver(token, result) };
    const app = await createApp({
        ...options,
        system,
        pacing: ringPacing({ inbound: { bell: link.bell, drain: link.pump },
            macrotask: createMacrotask(), now: ()=>performance.now(), intervalMs: YIELD_MS }),
    });
    app.attachLog((/** @type {number} */ handle, /** @type {string} */ text)=>
        ask('process', 'output', [handle, text]));
    try
    {
        return await app.run(run ?? {});
    }
    finally
    {
        await app.dispose();
    }
}

/**
 * @param {(handler: (data: any) => void) => void} listen
 * @param {(message: any) => void} send
 */
const bind = (listen, send)=>listen(data=>{
    if (data?.type !== 'start')
    {
        return;
    }
    serveProcess(data).then(code=>send({ type: 'exited', code }),
        (/** @type {any} */ e)=>send({ type: 'failed', message: String(e?.stack ?? e) }));
});

if (typeof self !== 'undefined' && typeof (/** @type {any} */ (self)).postMessage === 'function')
{
    const scope = /** @type {any} */ (self);
    bind(handler=>{
        scope.onmessage = (/** @type {{ data: any }} */ event)=>handler(event.data);
    }, message=>scope.postMessage(message));
}
else
{
    const { parentPort, isMainThread } = await import('node:worker_threads');
    if (!isMainThread && parentPort)
    {
        bind(handler=>parentPort.on('message', handler),
            message=>parentPort.postMessage(message));
    }
}

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
 * is told `{ type: 'start', end, graphics, display, options, run }` -- its side
 * of the link, its way in to the run's graphics worker and the port its
 * surfaces' pictures go out on (or null), the process as
 * `createApp` takes it, how long it may run -- and answers
 * `{ type: 'exited', code, diagnostics }`, or `{ type: 'failed', message }`.
 */

import { createApp, createMacrotask } from '../app.js';
import { openLink } from '../system/link.js';
import { remoteSystem } from '../system-link.js';
import { ringPacing } from './ring-pacing.js';
import { portEnd } from '../layers/graphics/remote/connect.js';

/** How often a process with work to do gives its event loop a turn, as the engine's worker does. */
const YIELD_MS = 4;

/**
 * The pictures of this process's surfaces, sent on `port` as the graphics
 * worker sends its frames, for the thread with the GPU to show. What it says
 * back once one is shown is not waited on: this thread blocks while it idles,
 * and a picture painted just before would wait with it.
 *
 * @param {MessagePort} port
 */
const sendFrames = port=>{
    port.onmessage = ()=>{};
    let frameIndex = 0;
    return (/** @type {{ pixels: Uint8Array }} */ frame)=>port.postMessage(
        { type: 'frame', ...frame, frameIndex: ++frameIndex }, [frame.pixels.buffer]);
};

/**
 * The files the parent handed this process as its output and error: named by
 * path, at the position the parent's open file holds, which a write here
 * reads and moves across the link.
 *
 * @param {Record<string, { path: string }> | undefined} named
 * @param {(target: string, method: string, args: any[]) => any} ask
 */
const standardFilesOf = (named, ask)=>named && Object.fromEntries(Object.entries(named)
    .map(([which, { path }])=>[which, {
        path,
        get position(){
            return ask('standard', 'position', [which]);
        },
        set position(at){
            ask('standard', 'setPosition', [which, at]);
        },
    }]));

/**
 * What a report reads, as data that crosses to another thread: null where it
 * holds something that does not.
 *
 * @param {() => any} read
 */
const plainOf = read=>{
    try
    {
        return JSON.parse(JSON.stringify(read()));
    }
    catch {
        return null;
    }
};

/**
 * Runs one process to its end.
 *
 * @param {{ end: import('../system/link.js').LinkEnd, graphics?: MessagePort | null,
 *     display?: MessagePort | null, options: any, run?: any }} start
 * @returns {Promise<{ code: number, diagnostics: any }>} its exit code, and its
 *     layers' diagnostics as it ended, as plain data, or null
 */
export async function serveProcess({ end, graphics, display, options, run }){
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
    /** @type {any} */
    let app = null;
    // The page's input, while this process stands, and the run's report.
    handlers.input = { send: (/** @type {any} */ event)=>app?.input.send(event) };
    handlers.report = { diagnostics: ()=>(app ? plainOf(()=>app.diagnostics()) : null) };
    app = await createApp({
        ...options,
        standardFiles: standardFilesOf(options.standardFiles, ask),
        graphics: { ...options.graphics, worker: graphics ? portEnd(graphics) : undefined,
            display: display ? sendFrames(display) : undefined },
        system,
        pacing: ringPacing({ inbound: { bell: link.bell, drain: link.pump },
            macrotask: createMacrotask(), now: ()=>performance.now(), intervalMs: YIELD_MS }),
    });
    app.attachLog((/** @type {number} */ handle, /** @type {string} */ text)=>
        ask('process', 'output', [handle, text]));
    try
    {
        const code = await app.run(run ?? {});
        return { code, diagnostics: plainOf(()=>app.diagnostics()) };
    }
    finally
    {
        await app.dispose();
        graphics?.postMessage({ type: 'close' });
        graphics?.close();
        display?.close();
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
    serveProcess(data).then(({ code, diagnostics })=>send({ type: 'exited', code, diagnostics }),
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

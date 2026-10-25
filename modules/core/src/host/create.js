/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `createApp`, as the package exports it: a program, its canvas, and the
 * thread it runs on, wired together.
 *
 * The engine itself is `../app.js`; this decides where it runs. In a page it
 * runs in a worker of its own, so that a browser composing frames or
 * collecting garbage on the page's thread never holds the guest, and a click
 * is answered whatever the guest is doing. Where there is no worker to be had
 * -- a test, a headless run -- or where one is asked not to be used, the same
 * engine runs on the calling thread behind the same port protocol, so a
 * consumer holds one controller shape either way: the reads that cross a
 * thread boundary answer with promises in both.
 *
 * A canvas transfers its control once. So the host a canvas was handed to is
 * kept for as long as the canvas is, and a second program in the same canvas
 * starts in the same worker; disposing the program leaves the worker ready.
 * Once its program is disposed, a canvas out of the page for `DETACHED_MS`
 * takes its worker with it: a player closed and its canvas dropped kept a
 * whole engine's memory alive. Nothing watches while a program runs.
 */

import { createRemoteApp } from './remote.js';

/**
 * @typedef {import('./messages.js').StartOptions & {
 *     host?: 'worker' | 'thread',
 *     canvas?: any,
 *     container?: any,
 *     transfer?: any[],
 *     workerUrl?: string | URL,
 *     on?: Record<string, (payload: any) => void>,
 * }} CreateAppOptions
 *
 * `host` is where the engine runs: `worker` (the default wherever `Worker`
 * exists) or `thread`, the calling thread. `canvas` is adopted as the
 * viewport; `container` gets a canvas of its own made for it; neither means
 * a run without a display, which is what a headless test wants. `transfer`
 * names buffers in the options to hand over rather than copy. `workerUrl`
 * overrides where the engine's worker is loaded from, for a bundler that
 * moves it.
 */

/**
 * Where a program runs: its worker, or a port to the engine on this thread.
 * `closed` once its canvas left the page and took it; `unwatch` stops the
 * watch on that canvas, which runs only while no program does. `ready`
 * settles once the engine on this thread is loaded and serving its port.
 *
 * @typedef {{ worker: any, close: () => void, closed?: boolean,
 *     unwatch?: () => void, ready?: Promise<void> }} Host
 */

/**
 * The hosts canvases have been handed to, by canvas.
 *
 * @type {WeakMap<object, Host>}
 */
const hosts = new WeakMap();

/** How long a canvas may be out of the page before its host is closed. */
export const DETACHED_MS = 10_000;

/**
 * Calls `gone` once a canvas has been out of the page for `wait` ms on end;
 * back in the page in between starts the wait again. Looked at lazily: every
 * `every` ms at most, and then only when the page's thread is idle
 * (`requestIdleCallback`), so a page busy drawing pays nothing for it. Nothing
 * is watched for a canvas that cannot say (an OffscreenCanvas, a test's
 * stand-in).
 *
 * @param {any} canvas @param {() => void} gone
 * @param {{ wait?: number, every?: number, now?: () => number,
 *     later?: (then: () => void, ms: number) => any, cancel?: (timer: any) => void,
 *     idle?: (then: () => void) => void }} [using]
 * @returns {() => void} stops watching
 */
export function whenDetached(canvas, gone, using = {}){
    if (typeof canvas?.isConnected !== 'boolean')
    {
        return ()=>{};
    }
    const wait = using.wait ?? DETACHED_MS;
    const every = using.every ?? 5000;
    const now = using.now ?? (()=>Date.now());
    const later = using.later ?? ((then, ms)=>setTimeout(then, ms));
    const cancel = using.cancel ?? (timer=>clearTimeout(timer));
    const idle = using.idle ?? (typeof requestIdleCallback === 'function'
        ? (/** @type {() => void} */ then)=>void requestIdleCallback(then, { timeout: every })
        : (/** @type {() => void} */ then)=>then());
    let since = -1;
    let stopped = false;
    /** @type {any} */
    let timer = null;
    const look = ()=>{
        if (stopped)
        {
            return;
        }
        if (canvas.isConnected)
        {
            since = -1;
        }
        else
        {
            since = since < 0 ? now() : since;
            if (now() - since >= wait)
            {
                stopped = true;
                gone();
                return;
            }
        }
        timer = later(()=>idle(look), every);
    };
    timer = later(()=>idle(look), every);
    return ()=>{
        stopped = true;
        cancel(timer);
    };
}

/**
 * @param {'worker' | 'thread'} mode
 * @param {string | URL | undefined} workerUrl
 * @returns {Host}
 */
function openHost(mode, workerUrl){
    if (mode === 'worker')
    {
        const worker = new Worker(workerUrl ?? new URL('./engine.worker.js', import.meta.url),
            { type: 'module' });
        return { worker, close: ()=>worker.terminate() };
    }
    // The engine is loaded only where it runs on this thread: a page whose
    // engine runs in a worker holds none of it (in WebKit 26 the bundled
    // engine imported on a page held 66 MB more than the page did without it).
    // What the page posts before the engine listens waits in the port.
    const channel = new MessageChannel();
    /** @type {{ close: () => void } | null} */
    let serving = null;
    let closed = false;
    const ready = Promise.all([import('../app.js'), import('./serve.js')])
        .then(([engine, serve])=>{
            if (!closed)
            {
                serving = serve.serveEngine(channel.port2, { createApp: engine.createApp });
            }
        });
    return {
        worker: channel.port1,
        ready,
        close(){
            closed = true;
            serving?.close();
            channel.port1.close();
            channel.port2.close();
        },
    };
}

/**
 * @param {CreateAppOptions} options
 * @returns {Promise<any>} the controller
 */
export async function createApp(options){
    // `on`: events the engine tells while it starts, subscribed before it does.
    const { host, canvas, container, transfer, workerUrl, on, ...start } = options;
    const mode = host ?? (typeof Worker === 'function' ? 'worker' : 'thread');
    const viewport = canvas ?? (container
        ? container.appendChild(container.ownerDocument.createElement('canvas'))
        : null);

    const kept = viewport ? hosts.get(viewport) ?? null : null;
    const opened = kept ?? openHost(mode, workerUrl);
    if (viewport && !kept)
    {
        hosts.set(viewport, opened);
    }
    // A program starting on a kept host: its canvas is in use again.
    opened.unwatch?.();
    opened.unwatch = undefined;

    /** @type {any} */
    let app;
    try
    {
        await opened.ready;
        app = await createRemoteApp({
            worker: opened.worker,
            // Transferred the first time; the host keeps it after that.
            canvas: kept ? null : viewport,
            options: start,
            transfer,
            on,
        });
    }
    catch (e){
        if (!kept)
        {
            opened.close();
            if (viewport)
            {
                hosts.delete(viewport);
            }
        }
        throw e;
    }

    const disposeApp = app.dispose;
    /** A host with no canvas has nothing to keep it for once the program is gone. */
    app.dispose = async()=>{
        // A host closed with its canvas answers nothing more.
        if (opened.closed)
        {
            return;
        }
        try
        {
            await disposeApp();
        }
        finally
        {
            if (!viewport)
            {
                opened.close();
            }
            else
            {
                opened.unwatch = whenDetached(viewport, ()=>{
                    hosts.delete(viewport);
                    opened.closed = true;
                    opened.close();
                });
            }
        }
    };
    app.canvas = viewport;
    app.host = mode;
    return app;
}

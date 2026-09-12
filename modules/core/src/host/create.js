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
 */

import { createApp as createEngine } from '../app.js';
import { createRemoteApp } from './remote.js';
import { serveEngine } from './serve.js';

/**
 * @typedef {import('./messages.js').StartOptions & {
 *     host?: 'worker' | 'thread',
 *     canvas?: any,
 *     container?: any,
 *     transfer?: any[],
 *     workerUrl?: string | URL,
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
 * The hosts canvases have been handed to, by canvas.
 *
 * @type {WeakMap<object, { worker: any, close: () => void }>}
 */
const hosts = new WeakMap();

/**
 * @param {'worker' | 'thread'} mode
 * @param {string | URL | undefined} workerUrl
 * @returns {{ worker: any, close: () => void }}
 */
function openHost(mode, workerUrl){
    if (mode === 'worker')
    {
        const worker = new Worker(workerUrl ?? new URL('./engine.worker.js', import.meta.url),
            { type: 'module' });
        return { worker, close: ()=>worker.terminate() };
    }
    const channel = new MessageChannel();
    const serving = serveEngine(channel.port2, { createApp: createEngine });
    return {
        worker: channel.port1,
        close(){
            serving.close();
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
    const { host, canvas, container, transfer, workerUrl, ...start } = options;
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

    /** @type {any} */
    let app;
    try
    {
        app = await createRemoteApp({
            worker: opened.worker,
            // Transferred the first time; the host keeps it after that.
            canvas: kept ? null : viewport,
            options: start,
            transfer,
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
        }
    };
    app.canvas = viewport;
    app.host = mode;
    return app;
}

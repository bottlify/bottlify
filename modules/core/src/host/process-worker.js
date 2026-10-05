/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The connection to a process worker (`process.worker.js`): a page's own
 * `Worker`, or the same file through Node's `worker_threads` where there is
 * none, carrying the same messages either way.
 *
 * @typedef {Object} ProcessWorker
 * @property {(message: any) => void} post
 * @property {(handler: (data: any) => void) => void} onMessage
 * @property {(handler: (reason: string) => void) => void} onLost
 * @property {() => void} terminate
 */

/**
 * @param {URL | string} [url]  the `process.worker.js` URL: the one beside
 *     this file, which a bundle keeps beside it too
 * @returns {Promise<ProcessWorker>}
 */
export async function openProcessWorker(url = new URL('./process.worker.js', import.meta.url)){
    if (typeof globalThis.Worker === 'function')
    {
        const worker = new globalThis.Worker(url, { type: 'module' });
        return {
            post: message=>worker.postMessage(message),
            onMessage: handler=>worker.addEventListener('message',
                (/** @type {any} */ event)=>handler(event.data)),
            onLost: handler=>worker.addEventListener('error',
                (/** @type {any} */ event)=>handler(event?.message || 'the worker failed')),
            terminate: ()=>worker.terminate(),
        };
    }
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(typeof url === 'string' ? new URL(url) : url);
    return {
        post: message=>worker.postMessage(message),
        onMessage: handler=>worker.on('message', handler),
        onLost: handler=>{
            worker.on('error', error=>handler(error?.message ?? String(error)));
            worker.on('exit', code=>handler(`the worker exited (${code})`));
        },
        terminate: ()=>void worker.terminate(),
    };
}

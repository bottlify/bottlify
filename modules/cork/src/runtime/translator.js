/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The connection to the translation worker.
 *
 * A browser reaches it through the page's own `Worker`; a process without
 * one (a test, a headless run) reaches the same worker file through Node's
 * `worker_threads`. Both carry the same messages, so `translator.worker.js`
 * does not know which opened it. Where neither exists -- or the URL cannot
 * be reached -- this answers null and the runtime emits inline, which is the
 * behaviour every run had before the worker.
 *
 * @typedef {Object} WorkerAdapter
 * @property {(message: any, transfer: any[]) => void} post
 * @property {(handler: (data: any) => void) => void} onMessage
 * @property {() => void} terminate
 */

/**
 * @param {string} url  The `translator.worker.js` URL, absolute or a file URL.
 * @returns {Promise<WorkerAdapter | null>}
 */
export async function openTranslationWorker(url){
    if (typeof globalThis.Worker === 'function')
    {
        try
        {
            const worker = new globalThis.Worker(url, { type: 'module' });
            return {
                post: (message, transfer)=>worker.postMessage(message, transfer),
                onMessage: handler=>{
                    worker.onmessage = event=>handler(event.data);
                },
                terminate: ()=>worker.terminate(),
            };
        }
        catch {
            return null;
        }
    }
    try
    {
        const { Worker } = await import('node:worker_threads');
        /** A file URL for the worker file, or the string Node would take. */
        let source;
        try
        {
            source = new URL(url);
        }
        catch {
            source = url;
        }
        const worker = new Worker(source);
        return {
            post: (message, transfer)=>worker.postMessage(message, transfer),
            onMessage: handler=>worker.on('message', handler),
            terminate: ()=>worker.terminate(),
        };
    }
    catch {
        return null;
    }
}

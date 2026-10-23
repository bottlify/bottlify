/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Opens the graphics worker (`graphics.worker.js`) and waits for its GPU
 * device: a worker that has none is no worker to draw in, and the devices
 * then draw where the engine does.
 */

/**
 * @param {{ url?: URL | string, timeoutMs?: number, frames?: string, capture?: boolean,
 *     make?: (url: URL | string) => any }} [options]
 *     `frames` is how the worker sends a presented frame back (`worker.js`);
 *     `capture` has it write down everything it is sent (`remote/capture.js`)
 * @returns {Promise<{ worker: any, adapter: any } | { worker: null, reason: string }>}
 */
export async function openGraphicsWorker(options = {}){
    const url = options.url ?? new URL('./graphics.worker.js', import.meta.url);
    const make = options.make ?? ((/** @type {URL | string} */ at)=>
        new Worker(at, { type: 'module' }));
    /** @type {any} */
    let worker;
    try
    {
        worker = make(url);
    }
    catch (e){
        return { worker: null, reason: String(/** @type {any} */ (e)?.message ?? e) };
    }
    /** @type {{ worker: any, adapter: any } | { worker: null, reason: string }} */
    const answer = await new Promise(resolve=>{
        const timer = setTimeout(()=>finish({ worker: null,
            reason: 'the graphics worker did not open a device in time' }),
        options.timeoutMs ?? 10000);
        /** @param {any} result */
        const finish = result=>{
            clearTimeout(timer);
            worker.removeEventListener('message', listen);
            worker.removeEventListener('error', fail);
            resolve(result);
        };
        /** @param {{ data: any }} event */
        const listen = ({ data })=>{
            if (data?.type === 'opened')
            {
                finish({ worker, adapter: data.adapter });
            }
            else if (data?.type === 'failed')
            {
                finish({ worker: null, reason: String(data.message) });
            }
        };
        /** @param {any} event */
        const fail = event=>finish({ worker: null,
            reason: String(event?.message ?? 'the graphics worker failed to load') });
        worker.addEventListener('message', listen);
        worker.addEventListener('error', fail);
        worker.postMessage({ type: 'open', frames: options.frames ?? 'bitmap',
            ...options.capture === true ? { capture: true } : {} });
    });
    if (!answer.worker)
    {
        worker.terminate?.();
    }
    return answer;
}

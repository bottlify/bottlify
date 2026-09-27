/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Starts the film decoder's thread, where there are threads to start. Here
 * rather than in the media layer because the worker is found by URL beside
 * this file, in the source and in the bundle alike.
 *
 * @param {BufferSource} wasm  The decoder binary; copied to the new thread.
 * @returns {import('../layers/media/internal/remote-clip.js').RemotePort | null}
 */
export function spawnMediaWorker(wasm){
    if (typeof Worker === 'undefined')
    {
        return null;
    }
    const worker = new Worker(new URL('./media.worker.js', import.meta.url), { type: 'module' });
    const bytes = ArrayBuffer.isView(wasm)
        ? new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength).slice()
        : new Uint8Array(/** @type {ArrayBuffer} */ (wasm)).slice();
    worker.postMessage({ type: 'init', wasm: bytes }, [bytes.buffer]);
    return {
        post: (message, transfer)=>worker.postMessage(message, transfer ?? []),
        listen: handler=>{
            worker.onmessage = event=>handler(event.data);
        },
        close: ()=>worker.terminate(),
    };
}

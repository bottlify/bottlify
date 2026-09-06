/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { createApp } from '../modules/core/src/app.js';

/**
 * The engine runs here, not on the page: a guest quantum is a blocking stretch
 * of wasm, and on the main thread it would freeze the document it is supposed
 * to be reporting into.
 *
 * The vendor artifacts are fetched on this side rather than passed in, so the
 * 2 MB wasm blob never crosses a message boundary.
 */

const PREBUILT = new URL('../modules/core/vendor/prebuilt/', import.meta.url);

/** @param {any} message */
const post = message=>self.postMessage(message);

/**
 * @param {Uint8Array} executable
 * @param {number} timeoutMs
 */
async function run(executable, timeoutMs){
    const wasmBytes = await (await fetch(new URL('v86.wasm', PREBUILT))).arrayBuffer();

    const app = await createApp({
        executable,
        v86: { moduleUrl: new URL('libv86.mjs', PREBUILT).href, wasmBytes },
    });

    app.attachLog((/** @type {number} */ handle, /** @type {string} */ text)=>
        post({ type: 'output', handle, text }));

    // Reported before the run: an import nothing implements is not fatal at load
    // time, so without this it would only surface as a fault much later.
    post({ type: 'loaded', image: { ...app.image } });

    try {
        const exitCode = await app.run({ timeoutMs });
        post({ type: 'exited', exitCode, diagnostics: app.diagnostics() });
    } catch (e){
        // Still worth a snapshot: a guest that never exited is exactly when the
        // module states and the region layout are worth looking at.
        post({ type: 'failed', message: e.message, diagnostics: app.diagnostics() });
    } finally {
        await app.dispose();
    }
}

self.onmessage = async event=>{
    const { executable, timeoutMs } = event.data;
    try {
        await run(new Uint8Array(executable), timeoutMs ?? 8000);
    } catch (e){
        post({ type: 'failed', message: e.message, diagnostics: [] });
    }
};

self.onerror = (/** @type {any} */ e)=>post({ type: 'failed', message: String(e.message ?? e) });

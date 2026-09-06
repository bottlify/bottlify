/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

const out = document.querySelector('#out');

/**
 * Unified diagnostics namespace on the window, owned by the probe page.
 * The CDP driver reads both `probe` and `errors` from here.
 */
window.__bottlify__ = window.__bottlify__ ?? { errors: [] };

window.addEventListener('error', event=>{
    window.__bottlify__.errors.push(`page:${event.message}`);
});
window.addEventListener('unhandledrejection', event=>{
    const reason = event.reason;
    window.__bottlify__.errors.push(
        `unhandled:${reason && reason.message ? reason.message : String(reason)}`);
});

/**
 * Boots the core inside a worker and exposes the probe result on the window
 * for the CDP driver under `window.__bottlifyProbe`.
 */
const probe = new Promise((resolve, reject)=>{
    let worker;
    try {
        worker = new Worker(new URL('./boot.worker.js', import.meta.url), { type: 'module' });
    } catch (e){
        window.__bottlify__.errors.push(`worker-creation:${e.message}`);
        reject(new Error(`worker creation failed: ${e.message}`));
        return;
    }

    const started = performance.now();
    const timer = setTimeout(()=>{
        window.__bottlify__.errors.push('ping-timeout');
        reject(new Error('ping timeout (10s)'));
    }, 10000);

    worker.onmessage = event=>{
        const message = event.data;
        if (message && message.peer === 'bottlify-probe' && message.verb === 'pong')
        {
            clearTimeout(timer);
            resolve({
                ok: true,
                pingMs: Math.round(performance.now() - started),
                modules: message.modules,
                coreVersion: message.coreVersion,
            });
        }
    };
    worker.onerror = event=>{
        clearTimeout(timer);
        window.__bottlify__.errors.push(
            `worker:${event.message} (${event.filename}:${event.lineno})`);
        reject(new Error(`worker error: ${event.message} (${event.filename}:${event.lineno})`));
    };

    worker.postMessage({ peer: 'bottlify-probe', verb: 'ping' });
});

/** @type {Promise<any>} */
window.__bottlify__.probe = probe;

probe
    .then(result=>{
        out.textContent = `ready: ${JSON.stringify(result, null, 2)}`;
    })
    .catch(error=>{
        out.textContent = `failed: ${error.message}`;
    });

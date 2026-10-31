/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The content script: GameHub in the page's tab (tab.js), where the stores'
 * protocols run at the tab's priority over sockets the page opens -- a socket
 * the page opens is one Chrome's request rules give Steam's Origin. The
 * sessions are the service worker's. Chrome loads a content script as a
 * classic script; its modules come in by import().
 */

(()=>{
    // The hosts this build answers on beyond what its manifest matches; the
    // build writes the dev build's (manifest.js HOSTS), null answers anywhere.
    const HOSTS = /** @type {RegExp | null} */ (null);
    if (HOSTS && !HOSTS.test(location.hostname))
    {
        return;
    }
    const { chrome } = /** @type {any} */ (globalThis);
    const version = chrome.runtime.getManifest().version;
    // Before any of the page's scripts runs: a page that does not find it
    // knows at once there is no GameHub, without waiting for an answer.
    document.documentElement.dataset.bottlifyBridge = version;

    const TO = 'bottlify-bridge';

    /**
     * What the site switches on (its `config.json`'s `bridge`), for the worker
     * to apply to its rulesets and its stores.
     *
     * @returns {Promise<Record<string, unknown>>}
     */
    async function platforms(){
        /** @type {{ bridge?: unknown }} */
        const config = await fetch('/config.json', { cache: 'no-store' })
            .then(answer=>(answer.ok ? answer.json() : {})).catch(()=>({}));
        const wanted = config?.bridge;
        return typeof wanted === 'object' && wanted !== null ? /** @type {any} */ (wanted) : {};
    }

    const tab = Promise.all([import(chrome.runtime.getURL('bridge/src/tab.js')), platforms()])
        .then(([{ startTab }, switched])=>startTab({
            version,
            origin: new URL(chrome.runtime.getURL('')).origin,
            connect: ()=>chrome.runtime.connect({ name: 'gamehub' }),
            socket: (/** @type {string} */ url)=>/** @type {any} */ (new WebSocket(url)),
            toPage: (/** @type {Record<string, any>} */ answer)=>window.postMessage(answer, location.origin),
            platforms: switched,
        }));

    window.addEventListener('message', async event=>{
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin
            || typeof data !== 'object' || data === null || data.to !== TO
            || !Number.isSafeInteger(data.id))
        {
            return;
        }
        (await tab).request({ to: TO, id: data.id, op: data.op, args: data.args });
    });
})();

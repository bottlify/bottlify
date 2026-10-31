/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The content script: that GameHub is here, and nothing secret. It marks the
 * page before the page's scripts run, hands the site's switches (its
 * `config.json`'s `gamehub`) to the service worker for the rulesets, and
 * answers `hello` -- the stores, which the site has on, and the extension's
 * origin, where each store's pages are: `<store>/session.html`, the frame that
 * speaks the store's protocol and that the page asks every other op of, and
 * `<store>/signin.html`. It waits on nothing of the worker's, loads no module
 * and holds no session. Chrome loads a content script as a classic script.
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
    document.documentElement.dataset.bottlifyGamehub = version;

    /** The stores, as a person knows them. */
    const STORES = { steam: 'Steam' };
    const PEER = 'bottlify-gamehub';
    const origin = new URL(chrome.runtime.getURL('')).origin;

    /** What the site switches: a store it leaves out is on. @type {Promise<Record<string, unknown>>} */
    const wanted = fetch('/config.json', { cache: 'no-store' })
        .then(answer=>(answer.ok ? answer.json() : {})).catch(()=>({}))
        .then((/** @type {any} */ config)=>(typeof config?.gamehub === 'object'
            && config.gamehub !== null ? config.gamehub : {}));
    // For the rulesets, which only the worker and the extension's pages may
    // switch; a worker Chrome has just stopped misses the first message.
    wanted.then(switches=>chrome.runtime.sendMessage({ switch: switches })
        .catch(()=>setTimeout(()=>chrome.runtime.sendMessage({ switch: switches })
            .catch(()=>{}), 500)));

    /** @param {Record<string, any>} answer */
    const reply = answer=>window.postMessage({ from: PEER, ...answer }, location.origin);

    window.addEventListener('message', async event=>{
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin
            || typeof data !== 'object' || data === null || data.to !== PEER
            || !Number.isSafeInteger(data.id))
        {
            return;
        }
        if (data.op !== 'hello')
        {
            reply({ id: data.id, error: `${String(data.op)} is asked of a store's frame` });
            return;
        }
        const switches = await wanted;
        reply({ id: data.id, result: { version, origin, stores: Object.entries(STORES)
            .map(([id, name])=>({ id, name, on: switches[id] !== false })) } });
    });
})();

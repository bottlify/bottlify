/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The content script: the page's end of the bridge, in the isolated world.
 *
 * Here and not in the service worker because Chrome's request rules change
 * what a page's requests carry, and this script's requests are the page's --
 * its Origin, rewritten for Steam's connection managers, and its CORS, opened
 * for the content servers -- while the worker's own socket keeps the
 * extension's Origin, which Steam refuses. Chrome loads a content script as a
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
    const url = (/** @type {string} */ path)=>chrome.runtime.getURL(path);
    const version = chrome.runtime.getManifest().version;
    // Before any of the page's scripts runs: a page that does not find it
    // knows at once there is no bridge, without waiting for an answer.
    document.documentElement.dataset.bottlifyBridge = version;

    /**
     * What the site switches on (its `config.json`'s `bridge`), applied to the
     * rulesets by the worker, which alone may switch them: the platforms on.
     *
     * @returns {Promise<Record<string, boolean>>}
     */
    async function platforms(){
        /** @type {{ bridge?: unknown }} */
        const config = await fetch('/config.json', { cache: 'no-store' })
            .then(answer=>(answer.ok ? answer.json() : {})).catch(()=>({}));
        const wanted = config?.bridge;
        return chrome.runtime.sendMessage(
            { platforms: typeof wanted === 'object' && wanted !== null ? wanted : {} });
    }

    /** Steam's connection managers, port 443 first: the one a firewall least often closes. */
    async function managers(){
        const directory = await (await fetch('https://api.steampowered.com/ISteamDirectory/'
            + 'GetCMListForConnect/v1/?cellid=0&cmtype=websockets')).json();
        /** @type {string[]} */
        const list = directory.response.serverlist
            .map((/** @type {any} */ server)=>server.endpoint);
        return list.sort((a, b)=>Number(!a.endsWith(':443')) - Number(!b.endsWith(':443')));
    }

    /** The session, in the extension's storage: no page's code can read it. */
    const store = {
        get: async()=>(await chrome.storage.local.get('steam')).steam ?? null,
        set: async(/** @type {object | null} */ session)=>(session
            ? chrome.storage.local.set({ steam: session }) : chrome.storage.local.remove('steam')),
    };

    const protocol = import(url('protocol.js'));
    const modules = [import(url('bridge.js')), import(url('steam/index.js'))];
    const ready = Promise.all([...modules, platforms()])
        .then(([{ createBridge }, steam, switched])=>createBridge(
            { steam, store, managers, version, platforms: switched }));

    window.addEventListener('message', async event=>{
        if (event.source !== window || event.origin !== location.origin)
        {
            return;
        }
        const { readRequest, FROM } = await protocol;
        const request = readRequest(event.data);
        if (!request)
        {
            return;
        }
        const reply = (/** @type {object} */ body)=>window.postMessage(
            { from: FROM, id: request.id, ...body }, location.origin);
        if ('error' in request)
        {
            reply({ error: request.error });
            return;
        }
        try
        {
            const bridge = await ready;
            const emit = (/** @type {string} */ name, /** @type {object} */ data)=>reply(
                { event: name, data });
            reply({ result: await bridge.handle(request, emit) });
        }
        catch (e){
            reply({ error: String(/** @type {Error} */ (e)?.message ?? e) });
        }
    });
})();

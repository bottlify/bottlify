/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GameHub's service worker: the stores' sessions, kept in the extension
 * origin's IndexedDB, sealed (vault.js), their sign-ins, over HTTPS, and
 * their rulesets. A store's sign-in page (`<store>/signin.html`, in a frame
 * of the launcher's) asks it to sign in; GameHub in each tab (tab.js) speaks
 * the stores' protocols and asks it who is signed in, what to log on with,
 * and to fetch what the ruleset does not open to a page (serve.js). Chrome
 * keeps an extension's worker at a low priority: nothing here takes long.
 *
 * It also switches each store's ruleset as the asking site's configuration
 * says, so a store that asks us to stop is stopped for everyone from the site
 * without a new release of the extension (roadmap/decisions.md, A66).
 */

import { serveSignIn, serveTab } from './serve.js';
import { vaultFor } from './vault.js';
import { signInWithCredentials, signInWithQr } from './stores/steam/auth.js';
import { webApi } from './stores/steam/webapi.js';

const { chrome } = /** @type {any} */ (globalThis);

/**
 * @param {Record<string, unknown>} wanted  A store left out is on: a site
 *     that says nothing of one has not asked to stop.
 * @returns {Promise<Record<string, boolean>>}  What is on now.
 */
async function switchRulesets(wanted){
    /** @type {string[]} */
    const ids = chrome.runtime.getManifest().declarative_net_request.rule_resources
        .map((/** @type {{ id: string }} */ ruleset)=>ruleset.id);
    const off = ids.filter(id=>wanted[id] === false);
    await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: ids.filter(id=>!off.includes(id)), disableRulesetIds: off });
    /** @type {string[]} */
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    return Object.fromEntries(ids.map(id=>[id, enabled.includes(id)]));
}

/**
 * Valve's client files kept in the extension's cache: a package's name carries
 * its hash, so a kept one is the one the manifest names.
 *
 * @param {string} url
 */
async function cachedFetch(url){
    if (!url.endsWith('.zip'))
    {
        return fetch(url);
    }
    const cache = await caches.open('steam-client');
    const kept = await cache.match(url);
    if (kept)
    {
        return kept;
    }
    const fresh = await fetch(url);
    if (fresh.ok)
    {
        await cache.put(url, fresh.clone());
    }
    return fresh;
}

// Over HTTPS, not a CM socket: a socket is a tab's, and the token a sign-in
// ends in would cross it.
const steamApi = async()=>/** @type {any} */ (webApi());

/** @type {Record<string, import('./serve.js').Kept>} */
const stores = {
    steam: {
        vault: vaultFor('steam'),
        qr: options=>signInWithQr(steamApi, options),
        credentials: options=>signInWithCredentials(steamApi, options),
    },
};

chrome.runtime.onConnect.addListener((/** @type {any} */ port)=>{
    const sender = port.sender ?? {};
    const own = sender.id === chrome.runtime.id;
    const page = /^\/([a-z][a-z0-9]{0,31})\/signin\.html$/.exec(
        sender.url?.startsWith(chrome.runtime.getURL('')) ? new URL(sender.url).pathname : '');
    // A store's sign-in page, which only the extension serves.
    if (own && port.name === 'signin' && page)
    {
        serveSignIn(port, { store: page[1], stores });
    }
    // GameHub's own content script, in a tab: a page cannot connect.
    else if (own && port.name === 'gamehub' && sender.tab && !page)
    {
        serveTab(port, { switch: switchRulesets, stores, fetch: /** @type {any} */ (cachedFetch) });
    }
    else
    {
        port.disconnect();
    }
});

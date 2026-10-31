/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GameHub's service worker: the stores' sessions, kept in the extension
 * origin's IndexedDB (vault.js), and their rulesets. GameHub in each tab
 * (tab.js) speaks the stores' protocols and asks the worker here for who is
 * signed in, for a token when it logs on, to keep a sign-in's session and to
 * fetch what the ruleset does not open to a page (serve.js). Nothing it does
 * takes long: Chrome keeps an extension's worker at a low priority.
 *
 * It also switches each store's ruleset as the asking site's configuration
 * says, so a store that asks us to stop is stopped for everyone from the site
 * without a new release of the extension (roadmap/decisions.md, A66).
 */

import { serveTab } from './serve.js';
import { vaultFor } from './vault.js';

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

const vaults = { steam: vaultFor('steam') };

chrome.runtime.onConnect.addListener((/** @type {any} */ port)=>{
    // Only GameHub's own content script, in a tab: a page cannot connect.
    if (port.name !== 'gamehub' || port.sender?.id !== chrome.runtime.id || !port.sender?.tab)
    {
        port.disconnect();
        return;
    }
    serveTab(port, { switch: switchRulesets, vaults, fetch: /** @type {any} */ (cachedFetch) });
});

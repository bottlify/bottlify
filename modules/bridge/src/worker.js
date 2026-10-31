/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GameHub's service worker: the stores' accounts, their sessions and their
 * protocols. Each launcher page connects a port (its content script, pipe.js)
 * and is served on it (serve.js); a store's socket is opened by that page and
 * lives with it. The port's traffic -- the CM heartbeat every few seconds --
 * keeps the worker awake while the page is open; stopped, it closes the
 * page's sockets, and the page's next request connects again and logs on
 * again with the kept session.
 *
 * It also switches each store's ruleset as the asking site's configuration
 * says, so a store that asks us to stop is stopped for everyone from the site
 * without a new release of the extension (roadmap/decisions.md, A66).
 */

import { servePort } from './serve.js';
import { vaultFor } from './vault.js';
import { steamStore } from './stores/steam/store.js';

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

const steamVault = vaultFor('steam');

chrome.runtime.onConnect.addListener((/** @type {any} */ port)=>{
    if (port.name !== 'gamehub' || port.sender?.id !== chrome.runtime.id || !port.sender?.tab)
    {
        port.disconnect();
        return;
    }
    servePort(port, {
        version: chrome.runtime.getManifest().version,
        switch: switchRulesets,
        stores: socket=>({ steam: steamStore({ vault: steamVault, socket }) }),
    });
});

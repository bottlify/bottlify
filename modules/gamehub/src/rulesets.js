/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Each store's ruleset, switched as the site's configuration says (its
 * `config.json`'s `gamehub`), so a store that asks us to stop is stopped for
 * everyone from the site without a new release of the extension
 * (roadmap/decisions.md, A66). Switched by the service worker when a page of
 * the site loads, and by a store's session frame before it speaks the store's
 * protocol, which therefore never waits on the worker.
 */

/**
 * What a site's configuration switches: a store it leaves out is on, a site
 * that says nothing of one has not asked to stop.
 *
 * @param {unknown} config  Its `config.json`.
 * @returns {Record<string, unknown>}
 */
export function wantedBy(config){
    const wanted = /** @type {any} */ (config)?.gamehub;
    return typeof wanted === 'object' && wanted !== null ? wanted : {};
}

/**
 * A site's configuration, or none for one that cannot be read.
 *
 * @param {string} origin  The site's.
 * @returns {Promise<unknown>}
 */
export const configOf = origin=>fetch(`${origin}/config.json`, { cache: 'no-store' })
    .then(answer=>(answer.ok ? answer.json() : {})).catch(()=>({}));

/**
 * @param {any} chrome
 * @param {Record<string, unknown>} wanted
 * @returns {Promise<string[]>}  The stores whose rulesets are on now.
 */
export async function switchRulesets(chrome, wanted){
    /** @type {string[]} */
    const ids = chrome.runtime.getManifest().declarative_net_request.rule_resources
        .map((/** @type {{ id: string }} */ ruleset)=>ruleset.id);
    const off = ids.filter(id=>wanted[id] === false);
    await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: ids.filter(id=>!off.includes(id)), disableRulesetIds: off });
    return chrome.declarativeNetRequest.getEnabledRulesets();
}

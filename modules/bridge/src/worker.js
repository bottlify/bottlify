/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The service worker, there only because a content script may not switch a
 * ruleset: each platform's is switched as the asking site's configuration
 * says, so a platform that asks us to stop is stopped for everyone from the
 * site, without a new release of the extension (roadmap/decisions.md).
 */

const { chrome } = /** @type {any} */ (globalThis);

/**
 * @param {Record<string, unknown>} wanted  A platform left out is on: a site
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
 * @param {any} message @param {any} sender
 * @param {(answer: object) => void} reply
 */
function heard(message, sender, reply){
    if (sender.id !== chrome.runtime.id || typeof message?.platforms !== 'object'
        || message.platforms === null)
    {
        return false;
    }
    // A switch that failed leaves every platform reported off: the bridge
    // then refuses rather than talk past a rule that may not hold.
    switchRulesets(message.platforms).then(reply, ()=>reply({}));
    return true;
}

chrome.runtime.onMessage.addListener(heard);

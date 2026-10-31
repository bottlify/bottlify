/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GameHub's service worker: when a page of a site loads, its content script
 * hands the site's switches here, and each store's ruleset is switched as
 * they say (rulesets.js, A66). It keeps no session and speaks no store's
 * protocol, and nothing waits on it: Chrome keeps an extension's worker at a
 * low priority and stops it when idle. A store's sign-in page and session
 * frame, the extension's own pages, do the rest (signin-flow.js, frame.js).
 */

import { switchRulesets } from './rulesets.js';

const { chrome } = /** @type {any} */ (globalThis);

chrome.runtime.onMessage.addListener((/** @type {any} */ message, /** @type {any} */ sender)=>{
    if (sender.id === chrome.runtime.id && sender.tab
        && !sender.url?.startsWith(chrome.runtime.getURL('')) && message?.switch)
    {
        switchRulesets(chrome, typeof message.switch === 'object' ? message.switch : {})
            .catch(()=>{});
    }
    return false;
});

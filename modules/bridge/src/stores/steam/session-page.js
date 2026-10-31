/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam's session frame (`steam/session.html`), which the launcher embeds:
 * Steam's protocol over a CM socket this frame opens -- an extension page's
 * socket, which Steam's ruleset gives Steam's Origin -- and Steam's directory
 * and Valve's client files asked from here, the extension reaching their hosts
 * (frame.js).
 */

import { runFrame } from '../../frame.js';
import { steamStore } from './store.js';

/**
 * Valve's client files kept in the extension's cache: a package's name carries
 * its hash, so a kept one is the one the manifest names.
 *
 * @param {string | URL | Request} url
 */
async function cachedFetch(url){
    if (!String(url).endsWith('.zip'))
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

runFrame('steam', vault=>steamStore({ vault, fetch: cachedFetch }));

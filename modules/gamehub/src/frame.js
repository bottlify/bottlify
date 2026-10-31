/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A store's session frame (`<store>/session.html`), the extension's own page
 * that the launcher embeds: the page's requests read (protocol.js) and
 * answered by the hub and the store, which speaks its protocol over sockets
 * this frame opens -- a frame of the extension's, in its own process, at the
 * priority of the tab it is shown in. The session is read from the
 * extension's own database (vault.js) for a logon and goes into the logon;
 * the page's tab never holds it, and the service worker, which Chrome keeps
 * at a low priority and stops when idle, is not asked for it.
 *
 * The page asks by `postMessage` to this frame, `{ to: 'bottlify-gamehub', id,
 * op, args }`, and is answered as protocol.js says; the frame says
 * `{ from: 'bottlify-gamehub', ready: true }` first. It hears its parent alone,
 * from the parent's origin, and answers that origin alone.
 */

import { createHub } from './hub.js';
import { FROM, readRequest } from './protocol.js';
import { vaultFor } from './vault.js';
import { configOf, switchRulesets, wantedBy } from './rulesets.js';

/** @typedef {import('./stores/steam/store.js').Vault} Vault */

/**
 * @param {Object} options
 * @param {string} options.store  Whose frame it is.
 * @param {(vault: Vault) => import('./hub.js').Store} options.make  The store.
 * @param {{ get(): Promise<any>, set(session: any): Promise<void> }} options.kept  Its session.
 * @param {() => Promise<string[]>} options.enabled  The rulesets on, the site's switches
 *     applied: a store the site has switched off has its ruleset off.
 * @param {(answer: Record<string, any>) => void} options.toPage  Posts to the page.
 * @param {string} [options.version]
 */
export function startFrame({ store, make, kept, enabled, toPage, version = '' }){
    /** @type {Vault} */
    const vault = {
        get: async()=>{
            const session = await kept.get();
            return session ? { accountName: session.accountName, id: session.id } : null;
        },
        token: ()=>kept.get(),
        signOut: ()=>kept.set(null),
    };

    // One that cannot be read leaves the store off.
    /** @type {Promise<ReturnType<typeof createHub>> | null} */
    let made = null;
    const hub = ()=>(made ??= enabled().catch(()=>/** @type {string[]} */ ([])).then(on=>createHub({ version,
        stores: { [store]: make(vault) }, platforms: { [store]: on.includes(store) } })));

    /** @param {Record<string, any>} reply */
    const answer = reply=>toPage({ from: FROM, ...reply });

    return {
        /** The frame is listening. */
        ready(){
            answer({ ready: true });
        },

        /**
         * A message the page posted.
         *
         * @param {unknown} data
         */
        async request(data){
            const request = readRequest(data);
            if (!request)
            {
                return;
            }
            if ('error' in request)
            {
                answer(request);
                return;
            }
            try
            {
                const result = await (await hub()).handle(request,
                    (event, body)=>answer({ id: request.id, event, data: body }));
                answer({ id: request.id, result: result ?? null });
            }
            catch (e){
                answer({ id: request.id, error: String(/** @type {Error} */ (e)?.message ?? e) });
            }
        },

        /** The page went: what the store held goes too. */
        close(){
            made?.then(one=>one.close());
        },
    };
}

/**
 * Runs a store's session frame in the extension page it is loaded in.
 *
 * @param {string} store
 * @param {(vault: Vault) => import('./hub.js').Store} make
 */
export function runFrame(store, make){
    // The hosts this build answers on beyond what its manifest lets frame this
    // page; the build writes the dev build's (manifest.js HOSTS), null answers anywhere.
    const HOSTS = /** @type {RegExp | null} */ (null);
    const parentOrigin = location.ancestorOrigins?.[0] ?? null;
    if (!parentOrigin || parent === window
        || (HOSTS && !HOSTS.test(new URL(parentOrigin).hostname)))
    {
        return;
    }
    const { chrome } = /** @type {any} */ (globalThis);
    const frame = startFrame({ store, make, kept: vaultFor(store),
        version: chrome.runtime.getManifest().version,
        // The site's switches applied here, before the store is spoken to:
        // this frame does not wait on the worker for them.
        enabled: async()=>switchRulesets(chrome, wantedBy(await configOf(parentOrigin))),
        toPage: answer=>parent.postMessage(answer, parentOrigin) });
    addEventListener('message', event=>{
        if (event.source === parent && event.origin === parentOrigin)
        {
            frame.request(event.data);
        }
    });
    addEventListener('pagehide', ()=>frame.close());
    frame.ready();
}

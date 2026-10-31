/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One tab's port, at the service worker's end: what GameHub in the tab
 * (tab.js) asks of the worker, answered. The worker keeps the stores'
 * sessions and switches their rulesets; it speaks no store's protocol, so a
 * worker Chrome keeps at a low priority answers in the time an IndexedDB read
 * takes. Each ask is `{ ask: { id, op, args } }`, answered `{ answer: { id,
 * result } }` or `{ answer: { id, error } }`, over the wire (wire.js).
 *
 * The ops:
 * - `switch { platforms }` -> what is on: the site's switches applied (A66).
 * - `session { store }` -> `{ accountName, id }` or null: who is signed in.
 * - `token { store }` -> the whole session, for a logon.
 * - `keep { store, session }` -> `{}`: a sign-in's session, kept; null forgets it.
 * - `fetch { url }` -> `{ status, body }`: a request the ruleset does not open
 *   to a page (`FETCHED`).
 */

import { createWire } from './wire.js';

/** @typedef {import('./tab.js').Port} Port */
/** @typedef {{ get(): Promise<any>, set(session: any): Promise<void> }} Kept */

/** What `fetch` asks: Steam's directory and Valve's client distribution. */
export const FETCHED = Object.freeze([
    'https://api.steampowered.com/ISteamDirectory/',
    'https://client-update.akamai.steamstatic.com/',
]);

/**
 * @param {Port} port
 * @param {Object} options
 * @param {(wanted: Record<string, unknown>) => Promise<Record<string, boolean>>} options.switch
 *     Applies the site's switches to the rulesets; answers what is on.
 * @param {Record<string, Kept>} options.vaults  Each store's session, kept.
 * @param {typeof fetch} options.fetch
 */
export function serveTab(port, { switch: switchRulesets, vaults, fetch: get }){
    const wire = createWire(raw=>port.postMessage(raw));
    /** @param {unknown} store */
    const vault = store=>{
        const kept = typeof store === 'string' && Object.hasOwn(vaults, store)
            ? vaults[store] : null;
        if (!kept)
        {
            throw new Error(`GameHub has no store ${String(store)}`);
        }
        return kept;
    };
    /** @type {Record<string, (args: Record<string, any>) => Promise<any>>} */
    const ops = {
        switch: async({ platforms })=>switchRulesets(
            typeof platforms === 'object' && platforms !== null ? platforms : {}),
        session: async({ store })=>{
            const kept = await vault(store).get();
            return kept ? { accountName: kept.accountName, id: kept.id } : null;
        },
        token: async({ store })=>vault(store).get(),
        keep: async({ store, session })=>{
            await vault(store).set(session
                ? { accountName: String(session.accountName),
                    refreshToken: String(session.refreshToken), id: crypto.randomUUID() }
                : null);
            return {};
        },
        fetch: async({ url })=>{
            if (typeof url !== 'string' || !FETCHED.some(prefix=>url.startsWith(prefix)))
            {
                throw new Error(`GameHub does not fetch ${String(url)}`);
            }
            const answer = await get(url);
            return { status: answer.status, body: new Uint8Array(await answer.arrayBuffer()) };
        },
    };
    port.onMessage.addListener(async raw=>{
        const ask = wire.receive(raw)?.ask;
        if (!ask)
        {
            return;
        }
        try
        {
            const op = Object.hasOwn(ops, ask.op) ? ops[ask.op] : null;
            if (!op)
            {
                throw new Error(`no op ${String(ask.op)}`);
            }
            wire.send({ answer: { id: ask.id, result: (await op(ask.args ?? {})) ?? null } });
        }
        catch (e){
            wire.send({ answer: { id: ask.id, error: String(/** @type {Error} */ (e)?.message ?? e) } });
        }
    });
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One tab's port, at the service worker's end: what GameHub in the tab
 * (tab.js) asks of the worker, answered. The worker keeps the stores'
 * sessions: it signs in over HTTPS, so the refresh token comes to it alone,
 * and keeps the token sealed (vault.js). It speaks no store's protocol to a
 * CM, so a worker Chrome keeps at a low priority has little to do. Each ask is
 * `{ ask: { id, op, args } }`, answered `{ answer: { id, result } }` or
 * `{ answer: { id, error } }`, an op that goes on sending `{ answer: { id,
 * event, data } }` first, over the wire (wire.js).
 *
 * The ops:
 * - `switch { platforms }` -> what is on: the site's switches applied (A66).
 * - `session { store }` -> `{ accountName, id }` or null: who is signed in.
 * - `token { store }` -> what a logon is made with.
 * - `signIn { store }` -> `{ accountName, id }`; events `challenge { url }`, `scanned`.
 * - `signOut { store }` -> `{}`.
 * - `cancel { target }` -> `{}`: stops the ask asked as `target` (a sign-in).
 * - `fetch { url }` -> `{ status, body }`: a request the ruleset does not open
 *   to a page (`FETCHED`).
 */

import { createWire } from './wire.js';

/** @typedef {import('./tab.js').Port} Port */
/**
 * A store as the worker keeps it: its session and its sign-in.
 *
 * @typedef {Object} Kept
 * @property {{ get(): Promise<any>, set(session: any): Promise<void> }} vault
 * @property {(options: { onChallenge: (url: string) => void, onScanned: () => void,
 *     signal: AbortSignal }) => Promise<{ accountName: string, refreshToken: string }>} signIn
 */

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
 * @param {Record<string, Kept>} options.stores
 * @param {typeof fetch} options.fetch
 */
export function serveTab(port, { switch: switchRulesets, stores, fetch: get }){
    const wire = createWire(raw=>port.postMessage(raw));
    /** Asks going on, by id. @type {Map<number, AbortController>} */
    const going = new Map();
    /** @param {unknown} store */
    const storeOf = store=>{
        const one = typeof store === 'string' && Object.hasOwn(stores, store)
            ? stores[store] : null;
        if (!one)
        {
            throw new Error(`GameHub has no store ${String(store)}`);
        }
        return one;
    };
    /** @param {unknown} store */
    const vault = store=>storeOf(store).vault;
    /**
     * @type {Record<string, (args: Record<string, any>,
     *     emit: (event: string, data: object) => void, signal: AbortSignal) => Promise<any>>}
     */
    const ops = {
        switch: async({ platforms })=>switchRulesets(
            typeof platforms === 'object' && platforms !== null ? platforms : {}),
        session: async({ store })=>{
            const kept = await vault(store).get();
            return kept ? { accountName: kept.accountName, id: kept.id } : null;
        },
        // The refresh token itself until a CM logon is shown to take an access
        // token minted from it (tools/steam-access-logon.mjs).
        token: async({ store })=>vault(store).get(),
        signIn: async({ store }, emit, signal)=>{
            const { accountName, refreshToken } = await storeOf(store).signIn({ signal,
                onChallenge: url=>emit('challenge', { url }), onScanned: ()=>emit('scanned', {}) });
            const id = crypto.randomUUID();
            await vault(store).set({ accountName, refreshToken, id });
            return { accountName, id };
        },
        signOut: async({ store })=>{
            await vault(store).set(null);
            return {};
        },
        cancel: async({ target })=>{
            going.get(target)?.abort(new Error('cancelled by the page'));
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
        const stop = new AbortController();
        going.set(ask.id, stop);
        try
        {
            const op = Object.hasOwn(ops, ask.op) ? ops[ask.op] : null;
            if (!op)
            {
                throw new Error(`no op ${String(ask.op)}`);
            }
            const result = await op(ask.args ?? {},
                (event, data)=>wire.send({ answer: { id: ask.id, event, data } }), stop.signal);
            wire.send({ answer: { id: ask.id, result: result ?? null } });
        }
        catch (e){
            wire.send({ answer: { id: ask.id, error: String(/** @type {Error} */ (e)?.message ?? e) } });
        }
        finally
        {
            going.delete(ask.id);
        }
    });
    port.onDisconnect.addListener(()=>{
        for (const stop of going.values())
        {
            stop.abort(new Error('the tab went'));
        }
    });
}

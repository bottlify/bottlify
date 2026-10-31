/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The service worker's two kinds of port.
 *
 * A tab's (`serveTab`): what GameHub in the tab (tab.js) asks of the worker.
 * Each ask is `{ ask: { id, op, args } }`, answered `{ answer: { id, result } }`
 * or `{ answer: { id, error } }` over the wire (wire.js). The ops:
 * - `switch { platforms }` -> what is on: the site's switches applied (A66).
 * - `session { store }` -> `{ accountName, id }` or null: who is signed in.
 * - `token { store }` -> the session a CM logon is made with: a CM takes the
 *   refresh token alone, not an access token minted from it.
 * - `signOut { store }` -> `{}`.
 * - `fetch { url }` -> `{ status, body }`: a request the ruleset does not open
 *   to a page (`FETCHED`).
 *
 * A store's sign-in page's (`serveSignIn`, `<store>/signin.html`, which the
 * launcher shows in a frame): the sign-in itself, over HTTPS from the worker,
 * so the password goes from that page to the worker and on to Steam sealed,
 * and the token Steam answers comes to the worker alone. The page sends
 * `{ start: 'qr' }` or `{ start: 'credentials', accountName, password }`, and
 * `{ code, type }` when Steam Guard asks for one; it is sent `{ event:
 * 'challenge', url }`, `{ event: 'scanned' }`, `{ event: 'guard', types, hint }`,
 * `{ event: 'wrongCode' }`, then `{ done: { name } }` or `{ error }`. A new
 * start ends the sign-in going on; the port's dropping ends it too.
 */

import { createWire } from './wire.js';

/** @typedef {import('./tab.js').Port} Port */
/** @typedef {import('./stores/steam/auth.js').SignedIn} SignedIn */

/**
 * A store as the worker keeps it: its session and its sign-ins.
 *
 * @typedef {Object} Kept
 * @property {{ get(): Promise<any>, set(session: any): Promise<void> }} vault
 * @property {(options: { onChallenge: (url: string) => void, onScanned: () => void,
 *     signal: AbortSignal }) => Promise<SignedIn>} qr
 * @property {(options: { accountName: string, password: string,
 *     onGuard: (asked: { types: number[], hint: string }) => void,
 *     takeCode: (signal: AbortSignal) => Promise<{ code: string, type: number }>,
 *     onWrongCode: () => void, signal: AbortSignal }) => Promise<SignedIn>} credentials
 */

/** What `fetch` asks: Steam's directory and Valve's client distribution. */
export const FETCHED = Object.freeze([
    'https://api.steampowered.com/ISteamDirectory/',
    'https://client-update.akamai.steamstatic.com/',
]);

/**
 * @param {Record<string, Kept>} stores @param {unknown} store
 * @returns {Kept}
 */
const storeOf = (stores, store)=>{
    const one = typeof store === 'string' && Object.hasOwn(stores, store) ? stores[store] : null;
    if (!one)
    {
        throw new Error(`GameHub has no store ${String(store)}`);
    }
    return one;
};

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
    /** @param {unknown} store */
    const vault = store=>storeOf(stores, store).vault;
    /** @type {Record<string, (args: Record<string, any>) => Promise<any>>} */
    const ops = {
        switch: async({ platforms })=>switchRulesets(
            typeof platforms === 'object' && platforms !== null ? platforms : {}),
        session: async({ store })=>{
            const kept = await vault(store).get();
            return kept ? { accountName: kept.accountName, id: kept.id } : null;
        },
        token: async({ store })=>vault(store).get(),
        signOut: async({ store })=>{
            await vault(store).set(null);
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

/**
 * @param {Port} port  A sign-in page's.
 * @param {Object} options
 * @param {string} options.store  Whose page it is.
 * @param {Record<string, Kept>} options.stores
 */
export function serveSignIn(port, { store, stores }){
    /** @type {AbortController | null} */
    let going = null;
    /** Codes given and not taken yet, and a sign-in waiting for one. */
    const codes = /** @type {Array<{ code: string, type: number }>} */ ([]);
    /** @type {((code: { code: string, type: number }) => void) | null} */
    let waiting = null;
    /** @param {Record<string, any>} message */
    const send = message=>{
        try
        {
            port.postMessage(message);
        }
        catch {
            // The page went; its sign-in is stopped by the port's dropping.
        }
    };
    /** @param {AbortSignal} signal */
    const takeCode = signal=>new Promise((resolve, reject)=>{
        const given = codes.shift();
        if (given)
        {
            resolve(given);
            return;
        }
        waiting = resolve;
        signal.addEventListener('abort', ()=>reject(signal.reason), { once: true });
    });

    port.onMessage.addListener(async message=>{
        if (typeof message?.code === 'string' && Number.isInteger(message.type))
        {
            const code = { code: message.code.trim(), type: message.type };
            if (waiting)
            {
                const take = waiting;
                waiting = null;
                take(code);
            }
            else
            {
                codes.push(code);
            }
            return;
        }
        if (message?.start !== 'qr' && message?.start !== 'credentials')
        {
            return;
        }
        going?.abort(new Error('a new sign-in began'));
        const stop = new AbortController();
        going = stop;
        codes.length = 0;
        waiting = null;
        try
        {
            const kept = storeOf(stores, store);
            const { signal } = stop;
            const signedIn = message.start === 'qr'
                ? await kept.qr({ signal, onChallenge: url=>send({ event: 'challenge', url }),
                    onScanned: ()=>send({ event: 'scanned' }) })
                : await kept.credentials({ signal,
                    accountName: String(message.accountName ?? ''),
                    password: String(message.password ?? ''),
                    onGuard: ({ types, hint })=>send({ event: 'guard', types, hint }),
                    takeCode, onWrongCode: ()=>send({ event: 'wrongCode' }) });
            await kept.vault.set({ accountName: signedIn.accountName,
                refreshToken: signedIn.refreshToken, id: crypto.randomUUID() });
            send({ done: { name: signedIn.accountName } });
        }
        catch (e){
            if (going === stop)
            {
                send({ error: String(/** @type {Error} */ (e)?.message ?? e) });
            }
        }
        finally
        {
            if (going === stop)
            {
                going = null;
            }
        }
    });
    port.onDisconnect.addListener(()=>going?.abort(new Error('the sign-in page went')));
}

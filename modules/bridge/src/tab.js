/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GameHub in the page's tab, run by its content script: the page's requests
 * read (protocol.js) and answered by the hub and its stores, each store
 * speaking its protocol over sockets this tab opens -- at the tab's priority.
 * An extension's service worker is kept at a low one, and on a busy machine
 * (a game running) its work waited tens of seconds (roadmap/gamehub.md).
 *
 * The worker keeps the sessions (serve.js): a store asks it who is signed in,
 * the token for a logon, and keeps a sign-in's token there; nothing of it is
 * kept here. The port to the worker is made at the first ask and made again
 * after it drops (the worker stopped); an ask it had not answered fails.
 */

import { createHub } from './hub.js';
import { createWire } from './wire.js';
import { FROM, readRequest } from './protocol.js';
import { steamStore } from './stores/steam/store.js';

/**
 * @typedef {Object} Port  A runtime port, as GameHub uses one.
 * @property {(message: any) => void} postMessage
 * @property {{ addListener(listener: (message: any) => void): void }} onMessage
 * @property {{ addListener(listener: () => void): void }} onDisconnect
 */

/**
 * @param {Object} options
 * @param {string} options.version
 * @param {() => Port} options.connect  A new port to the worker.
 * @param {(url: string) => import('./stores/steam/connection.js').CmSocket} options.socket
 *     A socket the page opens.
 * @param {(answer: Record<string, any>) => void} options.toPage  Posts to the page.
 * @param {Record<string, unknown>} options.platforms  What the site switches on.
 * @param {Record<string, any>} [options.steam]  Steam's protocol, for a test.
 */
export function startTab({ version, connect, socket, toPage, platforms, steam }){
    /** @type {{ wire: ReturnType<typeof createWire> } | null} */
    let link = null;
    let next = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (e: Error) => void }>} */
    const waiting = new Map();

    const open = ()=>{
        if (link)
        {
            return link;
        }
        const port = connect();
        const now = { wire: createWire(raw=>port.postMessage(raw)) };
        link = now;
        port.onMessage.addListener(raw=>{
            const answer = now.wire.receive(raw)?.answer;
            const asked = answer && waiting.get(answer.id);
            if (asked)
            {
                waiting.delete(answer.id);
                if ('error' in answer)
                {
                    asked.reject(new Error(answer.error));
                }
                else
                {
                    asked.resolve(answer.result);
                }
            }
        });
        port.onDisconnect.addListener(()=>{
            if (link === now)
            {
                link = null;
            }
            for (const [id, asked] of waiting)
            {
                waiting.delete(id);
                asked.reject(new Error('GameHub was restarted; ask again'));
            }
        });
        return now;
    };

    /** @param {string} op @param {Record<string, any>} [args] @returns {Promise<any>} */
    const ask = (op, args = {})=>new Promise((resolve, reject)=>{
        const id = ++next;
        waiting.set(id, { resolve, reject });
        open().wire.send({ ask: { id, op, args } });
    });

    /** @param {string} store */
    const vault = store=>({
        get: ()=>ask('session', { store }),
        token: ()=>ask('token', { store }),
        set: (/** @type {any} */ session)=>ask('keep', { store, session }).then(()=>{}),
    });

    /** @type {typeof fetch} */
    const fetched = async url=>{
        const { status, body } = await ask('fetch', { url: String(url) });
        return new Response(status === 204 || status === 304 ? null : body, { status });
    };

    // A switch that failed leaves every store off: GameHub then refuses rather
    // than talk past a rule that may not hold.
    /** @type {Promise<ReturnType<typeof createHub>> | null} */
    let made = null;
    const hub = ()=>(made ??= ask('switch', { platforms }).catch(()=>({})).then(on=>{
        const stores = { steam: steamStore({ vault: vault('steam'), socket, fetch: fetched,
            ...steam ? { steam } : {} }) };
        return createHub({ version, stores, platforms: Object.fromEntries(
            Object.keys(stores).map(id=>[id, on?.[id] === true])) });
    }));

    /** @param {Record<string, any>} reply */
    const answer = reply=>toPage({ from: FROM, ...reply });

    return {
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

        /** The page went: what the stores held goes too. */
        close(){
            made?.then(one=>one.close());
        },
    };
}

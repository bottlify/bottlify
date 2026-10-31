/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GameHub's answers to one page (protocol.js), in the service worker: `hello`
 * and `cancel`, and every other op handed to the store it names -- a store the
 * site has switched off is not spoken to at all (A66). A store is a module of
 * the same ops (stores/steam/store.js); another is added beside it, and
 * nothing here changes for it.
 */

/** @typedef {import('./protocol.js').Request} Request */

/**
 * A store's answers to the page's ops: each given its checked arguments, a way
 * to send events before its answer, and a signal the page's `cancel` aborts.
 *
 * @typedef {Object} Store
 * @property {string} name  As a person knows it.
 * @property {Record<string, (args: Record<string, any>,
 *     emit: (event: string, data: object) => void, signal: AbortSignal) => Promise<any>>} ops
 * @property {() => void} close  The page went: what it held goes too.
 */

/**
 * @param {Object} options
 * @param {string} options.version
 * @param {Record<string, unknown>} options.platforms  What the site switches on: a store
 *     it does not name is on, one it sets false is off.
 * @param {Record<string, Store>} options.stores
 */
export function createHub({ version, platforms, stores }){
    /** Requests going on, by the id they were asked with. @type {Map<number, AbortController>} */
    const going = new Map();
    /** @param {string} id */
    const on = id=>platforms[id] !== false;
    return {
        /**
         * Answers a request; `emit` sends an op's events before its answer.
         *
         * @param {Request} request
         * @param {(event: string, data: object) => void} emit
         */
        async handle({ id, op, args }, emit){
            if (op === 'hello')
            {
                return { version, stores: Object.entries(stores)
                    .map(([store, { name }])=>({ id: store, name, on: on(store) })) };
            }
            if (op === 'cancel')
            {
                going.get(args.target)?.abort(new Error('cancelled by the page'));
                return {};
            }
            const store = stores[args.store];
            if (!store)
            {
                throw new Error(`GameHub has no store ${args.store}`);
            }
            // Switched off, a store is not spoken to at all: the site's
            // configuration is how a store's request to stop is honoured.
            if (!on(args.store))
            {
                throw new Error(`${store.name} is switched off for this site`);
            }
            const stop = new AbortController();
            going.set(id, stop);
            try
            {
                return await store.ops[op](args, emit, stop.signal);
            }
            finally
            {
                going.delete(id);
            }
        },

        /** The page went. */
        close(){
            for (const stop of going.values())
            {
                stop.abort(new Error('the page went'));
            }
            for (const store of Object.values(stores))
            {
                store.close();
            }
        },
    };
}

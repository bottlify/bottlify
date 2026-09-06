/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The event registry a consumer hooks into.
 *
 * Everything interesting a running program does crosses our boundary: it writes
 * to a console, it traces, it reports a failure, it ends. A consumer embedding
 * the engine needs to see those without reading our diagnostics and without us
 * deciding in advance what it will want to do about them.
 *
 * Handlers are interceptors, not just observers. They run in registration order
 * and the first one to return anything other than `undefined` decides the
 * outcome and stops the rest -- so a consumer can watch an event, answer it, or
 * swallow it, and the three are the same mechanism. A handler that returns
 * nothing has not intervened, which is what watching should mean.
 *
 * The set of names is deliberately not fixed here: what can happen grows with
 * what the engine implements, and a registry that had to be edited for each new
 * event would be edited late and inconsistently.
 */

/**
 * @typedef {(payload: any) => any} EventHandler
 */

export function createEvents(){
    /** @type {Map<string, EventHandler[]>} */
    const handlers = new Map();
    /** @type {Record<string, number>} */
    const counts = {};

    /** @param {string} name */
    const listeners = name=>{
        let list = handlers.get(name);
        if (!list)
        {
            list = [];
            handlers.set(name, list);
        }
        return list;
    };

    return {
        /**
         * @param {string} name
         * @param {EventHandler} handler
         * @returns {() => void} stops this handler; calling it twice is harmless
         */
        on(name, handler){
            listeners(name).push(handler);
            return ()=>this.off(name, handler);
        },

        /**
         * @param {string} name
         * @param {EventHandler} handler
         */
        off(name, handler){
            const list = listeners(name);
            const at = list.indexOf(handler);
            if (at !== -1)
            {
                list.splice(at, 1);
            }
        },

        /**
         * @param {string} name
         * @param {any} payload
         * @returns {any} what the first handler to answer decided, or undefined
         */
        emit(name, payload){
            counts[name] = (counts[name] ?? 0) + 1;
            for (const handler of [...listeners(name)])
            {
                const answer = handler(payload);
                if (answer !== undefined)
                {
                    return answer;
                }
            }
            return undefined;
        },

        /** @param {string} name */
        listening: name=>listeners(name).length > 0,

        diagnostics: ()=>({
            events: Object.fromEntries(
                [...handlers].map(([name, list])=>[name, list.length])),
            emitted: { ...counts },
        }),
    };
}

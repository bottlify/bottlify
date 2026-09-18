/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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

/**
 * How many past emissions of a name are kept for a subscriber that has not
 * arrived yet.
 *
 * `emit` has no way to know when "construction" ends, so what it keeps is
 * bounded by count rather than by a window closing at some later moment --
 * enough for the handful of one-shot events `buildApp` fires before a
 * consumer's first `on()` can run (`hooks-bound`, `libraries`, `bundle`,
 * `process-create`...), and never unbounded for a name that keeps firing and
 * that nobody ever subscribes to.
 */
export const REPLAY_LIMIT = 32;

export function createEvents(){
    /** @type {Map<string, EventHandler[]>} */
    const handlers = new Map();
    /** @type {Record<string, number>} */
    const counts = {};
    /** Watchers of every event, in the order they were added. */
    /** @type {((name: string, payload: any) => void)[]} */
    const watchers = [];
    /**
     * Payloads emitted for a name nobody has subscribed to yet, so its first
     * subscriber sees what it missed. Cleared, and never refilled, the moment
     * a name gets that first subscriber: a later subscriber to the same name
     * sees only what is live from then on.
     *
     * @type {Map<string, any[]>}
     */
    const unheard = new Map();
    /** Names that have had at least one subscriber, ever. @type {Set<string>} */
    const heard = new Set();

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
            if (!heard.has(name))
            {
                heard.add(name);
                const missed = unheard.get(name);
                unheard.delete(name);
                for (const payload of missed ?? [])
                {
                    handler(payload);
                }
            }
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
         * Watches every event, whatever its name.
         *
         * For a reader that wants the whole story rather than one part of it --
         * the journal, and whatever renders it. An observer never decides
         * anything: its answer is ignored, so adding one cannot change what a
         * named handler would have replied, and a watcher that throws is the
         * watcher's problem and not the emitter's.
         *
         * @param {(name: string, payload: any) => void} handler
         * @returns {() => void} stops it
         */
        onAny(handler){
            watchers.push(handler);
            return ()=>{
                const at = watchers.indexOf(handler);
                if (at !== -1)
                {
                    watchers.splice(at, 1);
                }
            };
        },

        /**
         * @param {string} name
         * @param {any} payload
         * @returns {any} what the first handler to answer decided, or undefined
         */
        emit(name, payload){
            counts[name] = (counts[name] ?? 0) + 1;
            for (const watcher of watchers)
            {
                try
                {
                    watcher(name, payload);
                }
                catch (e){
                    void e;
                }
            }
            if (!heard.has(name))
            {
                const kept = unheard.get(name) ?? [];
                kept.push(payload);
                if (kept.length > REPLAY_LIMIT)
                {
                    kept.shift();
                }
                unheard.set(name, kept);
            }
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

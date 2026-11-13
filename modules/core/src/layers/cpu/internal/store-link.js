/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's translation store, across a link: one store
 * for every process of the run, kept by the system's thread, and asked from a
 * process in a worker of its own.
 *
 * It is one because it cannot be several: a directory store holds its records
 * file through a synchronous handle, and a second handle on the same file is
 * refused while the first is open. A process that opened none of its own
 * translated everything on every run, its first one included where every
 * process runs in a worker.
 *
 * A lookup blocks for its answer, as the store's own synchronous read does in
 * the thread that holds it: the translator publishes a batch in the call that
 * formed it when every lookup is answered at once (`getNow`), and a batch's
 * lookups cross together (`getManyNow`), one wait for the batch. A record
 * crosses as it is put and is not waited on.
 *
 * A batch's compiled module crosses too, as a message (`hold`): the store's
 * thread keeps it alive for the run (`withHeldModules`), so a process in
 * another worker that compiles the same bytes from the store is handed the
 * code the first one compiled and tiered up: the wasm engine keeps one
 * compiled module for the bytes of any module alive in its process. Without
 * it each process of the run, ngen's `mscorsvw.exe` once an assembly, ran its
 * hot code in the baseline tier again until it tiered up anew. Only where the
 * engine is V8: JavaScriptCore is not known to hand a module compiled in one
 * worker to another by its bytes, and there the modules kept would cost up to
 * their cap and pay nothing.
 *
 * The proxy is made for one process (`alone`): cork keeps no formed regions or
 * compiled modules beside it for other runtimes of its thread
 * (`sharedFormed`, `sharedModuleBytes`) until a child runs beside the process
 * in its worker, which the run starts there only when it has no room for
 * another worker: kept for the process alone, they are heap and wasm no one
 * takes.
 */

import { runsJavaScriptCore } from './gc-nudge.js';

/** @typedef {import('../engine.js').TranslationStore} TranslationStore */

/**
 * The link's handlers that answer for the run's store.
 *
 * @param {TranslationStore} store
 */
export function storeHandlers(store){
    return {
        store: {
            /**
             * Every record named, in order: its bytes, or null for none. At
             * once where the store answers so, which a directory store
             * opened and holding its records file does.
             *
             * @param {string[]} keys
             * @returns {(Uint8Array | null)[] | Promise<(Uint8Array | null)[]>}
             */
            getMany(keys){
                const now = keys.map(key=>store.getNow?.(key));
                if (now.every(answer=>answer !== undefined))
                {
                    return /** @type {(Uint8Array | null)[]} */ (now);
                }
                return Promise.all(keys.map((key, i)=>(now[i] === undefined
                    ? store.get(key) : /** @type {Uint8Array | null} */ (now[i]))));
            },
            /** @param {string} key */
            get: key=>store.get(key),
            /** @param {string} key @param {Uint8Array} bytes @param {{ needs?: string }} [options] */
            put: (key, bytes, options)=>store.put(key, bytes, options),
            /** @param {string} key */
            touch: key=>store.touch?.(key),
        },
    };
}

/** Wasm bytes of batch modules the store's thread keeps alive, as cork's `sharedModuleBytes`. */
export const SHARED_MODULE_BYTES = 256 << 20;

/**
 * Whether a module kept alive in one thread hands its compiled code to another
 * thread compiling the same bytes: V8 keeps one compiled module for the bytes
 * of any module alive in its process; JavaScriptCore is not known to.
 *
 * @param {string} [agent]  the thread's agent string
 */
export function keepsCodeByBytes(agent = globalThis.navigator?.userAgent ?? ''){
    return !runsJavaScriptCore(agent);
}

/**
 * The run's store, its batch modules kept alive for the run by the thread
 * that holds it, up to `cap` bytes of wasm: those used longest ago go first,
 * a module held again counts as used. The store as it is where the engine
 * hands no code by bytes (`keepsCodeByBytes`), or with a cap of 0.
 *
 * @template {TranslationStore} T
 * @param {T} store @param {number} cap @param {string} [agent]  the thread's agent string
 * @returns {T | (T & { hold: NonNullable<TranslationStore['hold']> })}
 */
export function withHeldModules(store, cap, agent = undefined){
    if (!(cap > 0) || !keepsCodeByBytes(agent))
    {
        return store;
    }
    /** @type {Map<string, { module: WebAssembly.Module, bytes: number }>} */
    const held = new Map();
    let bytes = 0;
    let added = 0;
    let again = 0;
    let dropped = 0;
    // The store's own methods reached through it, whatever made them.
    return Object.assign(Object.create(store), {
        /** @type {NonNullable<TranslationStore['hold']>} */
        hold(key, module, size){
            const known = held.get(key);
            if (known !== undefined)
            {
                held.delete(key);
                held.set(key, known);
                again++;
                return;
            }
            if (!(size <= cap))
            {
                return;
            }
            held.set(key, { module, bytes: size });
            bytes += size;
            added++;
            for (const [oldest, one] of held)
            {
                if (bytes <= cap)
                {
                    break;
                }
                held.delete(oldest);
                bytes -= one.bytes;
                dropped++;
            }
        },
        stats(){
            const own = store.stats?.();
            const modules = { held: held.size, bytes, added, again, dropped };
            return own && typeof own === 'object' ? { ...own, heldModules: modules }
                : { heldModules: modules };
        },
    });
}

/**
 * The run's store as a process across a link sees it: made for it (`alone`),
 * and for the children it runs beside itself. It sends the store's thread the
 * modules it compiles only where that thread keeps them for others
 * (`keepsCodeByBytes`).
 *
 * @param {{ ask: (method: string, args: any[]) => any,
 *     call: (method: string, args: any[]) => Promise<any>,
 *     post?: (message: { type: 'module', key: string, module: WebAssembly.Module,
 *         bytes: number }) => void }} link
 *     `ask` blocks for `storeHandlers`' answer, `call` does not; `post` sends a message to the
 *     store's thread, which can carry a compiled module
 * @param {string} [agent]  the thread's agent string
 * @returns {TranslationStore & {
 *     getManyNow: (keys: string[]) => (Uint8Array | null)[] | undefined }}
 */
export function remoteStore(link, agent = undefined){
    const post = keepsCodeByBytes(agent) ? link.post : undefined;
    /**
     * @param {string[]} keys
     * @returns {(Uint8Array | null)[] | undefined} undefined where the link cannot answer, and
     *     the translator asks `get`
     */
    const getManyNow = keys=>{
        try
        {
            return link.ask('getMany', [keys]);
        }
        catch {
            return undefined;
        }
    };
    return {
        alone: true,
        getManyNow,
        /** @param {string} key */
        getNow: key=>getManyNow([key])?.[0],
        /** @param {string} key */
        get: key=>link.call('get', [key]).catch(()=>null),
        /** @param {string} key @param {Uint8Array} bytes @param {{ needs?: string }} [options] */
        put: async(key, bytes, options)=>{
            link.call('put', options === undefined ? [key, bytes] : [key, bytes, options])
                .catch(()=>{});
        },
        /** @param {string} key */
        touch: key=>{
            link.call('touch', [key]).catch(()=>{});
        },
        ...post ? { hold: (/** @type {string} */ key, /** @type {WebAssembly.Module} */
            module, /** @type {number} */ bytes)=>post({ type: 'module', key, module, bytes }) }
            : {},
    };
}

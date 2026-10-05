/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How much of the engine rides on shared memory. `isolated`: the guest's memory
 * is a SharedArrayBuffer, which the graphics worker reads unlocked bytes from
 * and writes read-backs into in place. `compatible`: the guest's memory is the
 * engine thread's own, and everything that crosses to another thread is
 * copied there. A page that is not cross-origin isolated has no
 * SharedArrayBuffer, so `isolated` cannot run on it; `auto` -- the default --
 * takes `isolated` where it can and `compatible` where it cannot.
 *
 * `concurrency` is how many processes run at once (roadmap/v2): 1, the default,
 * is one at a time -- a child takes its parent's place until it exits; 2 or 4
 * is that many side by side, each child in a worker of its own. More than one
 * shares memory between threads, so it runs only `isolated`. Where that cannot
 * be had -- `compatible` asked for, or a page that is not cross-origin
 * isolated -- the run falls back to one process at a time in `compatible`
 * mode, and says so (`fallback`) rather than not starting.
 *
 * @typedef {'auto' | 'compatible' | 'isolated'} RunMode
 * @typedef {1 | 2 | 4} Concurrency
 */

export const RUN_MODES = Object.freeze(['auto', 'compatible', 'isolated']);

/** How many processes may run at once. */
export const CONCURRENCY = Object.freeze([1, 2, 4]);

/** Whether this thread can share memory with another. */
export function canShareMemory(){
    return typeof SharedArrayBuffer === 'function'
        && /** @type {any} */ (globalThis).crossOriginIsolated !== false;
}

/**
 * The mode a run takes: the one asked for, or for `auto` the one this
 * thread's environment allows. `isolated` where shared memory is not to be had is
 * refused before anything is built, not quietly run as `compatible`.
 *
 * @param {RunMode | undefined | null} asked
 * @param {boolean} [shareable]
 * @returns {'compatible' | 'isolated'}
 */
export function runModeOf(asked, shareable = canShareMemory()){
    const mode = asked ?? 'auto';
    if (!RUN_MODES.includes(mode))
    {
        throw new Error(`unknown mode ${JSON.stringify(asked)}: the modes are`
            + ` ${RUN_MODES.join(', ')}`);
    }
    if (mode === 'isolated' && !shareable)
    {
        throw new Error(`mode "${mode}" needs shared memory, and this page has none: it is not`
            + ' cross-origin isolated (Cross-Origin-Opener-Policy: same-origin,'
            + ' Cross-Origin-Embedder-Policy: require-corp). "compatible" or "auto" runs here.');
    }
    return mode === 'auto' ? (shareable ? 'isolated' : 'compatible') : mode;
}

/**
 * The options a run is built from, with its mode and concurrency settled: in
 * `compatible` mode the guest's memory is not shared and nothing is lent from
 * it, whatever the caller's cork and graphics settings say; in `isolated` those
 * settings stand. Processes side by side are `isolated`; asked for where they
 * cannot be, the run is one process at a time in `compatible` mode, and
 * `fallback` says what was asked and why it was not had.
 *
 * @template {{ mode?: RunMode, concurrency?: Concurrency, cork?: any, graphics?: any }} T
 * @param {T} options
 * @param {boolean} [shareable]
 * @returns {T & { mode: 'compatible' | 'isolated', concurrency: Concurrency,
 *     fallback: { asked: { mode?: RunMode, concurrency: Concurrency }, detail: string } | null }}
 */
export function withRunMode(options, shareable = canShareMemory()){
    const asked = options.concurrency ?? 1;
    if (!CONCURRENCY.includes(asked))
    {
        throw new Error(`unknown concurrency ${JSON.stringify(options.concurrency)}:`
            + ' concurrency is 1, 2 or 4 processes at once');
    }
    const fallback = asked > 1 && (options.mode === 'compatible' || !shareable)
        ? { asked: { mode: options.mode, concurrency: asked },
            detail: `concurrency ${asked} is not allowed here: it needs memory shared between`
                + ' threads, and '
                + (options.mode === 'compatible' ? 'the run asked for "compatible"'
                    : 'the page is not cross-origin isolated (Cross-Origin-Opener-Policy:'
                    + ' same-origin, Cross-Origin-Embedder-Policy: require-corp)')
                + '; running "compatible", one process at a time' }
        : null;
    const concurrency = fallback ? 1 : asked;
    const mode = fallback ? 'compatible' : runModeOf(options.mode, shareable);
    if (mode !== 'compatible')
    {
        return { ...options, mode, concurrency, fallback };
    }
    return {
        ...options,
        mode,
        concurrency,
        fallback,
        cork: { ...options.cork, config: { ...options.cork?.config, sharedMemory: false } },
        graphics: { ...options.graphics, lendMemory: false },
    };
}

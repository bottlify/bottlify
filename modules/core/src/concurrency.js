/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a run needs of where it runs, and how many processes it runs at once.
 *
 * The engine runs over shared memory and only there: the guest's memory is a
 * SharedArrayBuffer every thread of the run reads in place - the executors,
 * the graphics worker, the sound worklet, the run's cache. A page that is not
 * cross-origin isolated has no SharedArrayBuffer, and a run is refused there
 * before anything is built (`roadmap/decisions.md`: the engine needs shared
 * memory).
 *
 * `concurrency` is how many processes run at once: 1, the default, is one at
 * a time - a child takes its parent's place until it exits; 2 or 4 is that
 * many side by side, each child in a worker of its own.
 *
 * @typedef {1 | 2 | 4} Concurrency
 */

/** How many processes may run at once. */
const CONCURRENCY = Object.freeze([1, 2, 4]);

/** Whether this thread can share memory with another. */
function canShareMemory(){
    return typeof SharedArrayBuffer === 'function'
        && /** @type {any} */ (globalThis).crossOriginIsolated !== false;
}

/** What a page that cannot share memory is told it needs. */
const NEEDS_SHARED_MEMORY = 'the engine needs shared memory (SharedArrayBuffer), and this'
    + ' page has none: it is not cross-origin isolated. Serve the page with the headers'
    + ' Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp'
    + ' (or credentialless)';

/**
 * The options a run is built from, with its concurrency settled. Refused
 * before anything is built: a page without shared memory, a concurrency that
 * is not 1, 2 or 4, and the `mode` option, which is gone (the engine has one
 * mode: shared memory).
 *
 * @template {{ concurrency?: Concurrency }} T
 * @param {T} options
 * @param {boolean} [shareable]
 * @returns {T & { concurrency: Concurrency }}
 */
export function withConcurrency(options, shareable = canShareMemory()){
    if (!shareable)
    {
        throw new Error(NEEDS_SHARED_MEMORY);
    }
    const mode = /** @type {any} */ (options).mode;
    if (mode !== undefined)
    {
        throw new Error(`unknown option mode ${JSON.stringify(mode)}: it was removed - the engine`
            + ' runs only over shared memory');
    }
    const concurrency = options.concurrency ?? 1;
    if (!CONCURRENCY.includes(concurrency))
    {
        throw new Error(`unknown concurrency ${JSON.stringify(options.concurrency)}:`
            + ' concurrency is 1, 2 or 4 processes at once');
    }
    return { ...options, concurrency };
}

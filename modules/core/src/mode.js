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
 * `workers` is `isolated` with the engine's thread fed through shared memory
 * rather than its event loop (roadmap/v2): what the page sends while a
 * program runs is read between two turns, and an idle engine sleeps on a
 * word rather than looking again on a timer. `auto` never takes it.
 *
 * @typedef {'auto' | 'compatible' | 'isolated' | 'workers'} RunMode
 */

export const RUN_MODES = Object.freeze(['auto', 'compatible', 'isolated', 'workers']);

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
 * @returns {'compatible' | 'isolated' | 'workers'}
 */
export function runModeOf(asked, shareable = canShareMemory()){
    const mode = asked ?? 'auto';
    if (!RUN_MODES.includes(mode))
    {
        throw new Error(`unknown mode ${JSON.stringify(asked)}: the modes are`
            + ` ${RUN_MODES.join(', ')}`);
    }
    if ((mode === 'isolated' || mode === 'workers') && !shareable)
    {
        throw new Error(`mode "${mode}" needs shared memory, and this page has none: it is not`
            + ' cross-origin isolated (Cross-Origin-Opener-Policy: same-origin,'
            + ' Cross-Origin-Embedder-Policy: require-corp). "compatible" or "auto" runs here.');
    }
    return mode === 'auto' ? (shareable ? 'isolated' : 'compatible') : mode;
}

/**
 * The options a run is built from, with its mode settled: in `compatible` mode the
 * guest's memory is not shared and nothing is lent from it, whatever the
 * caller's cork and graphics settings say; in `isolated` and `workers` those settings stand.
 *
 * @template {{ mode?: RunMode, cork?: any, graphics?: any }} T
 * @param {T} options
 * @param {boolean} [shareable]
 * @returns {T & { mode: 'compatible' | 'isolated' | 'workers' }}
 */
export function withRunMode(options, shareable = canShareMemory()){
    const mode = runModeOf(options.mode, shareable);
    if (mode !== 'compatible')
    {
        return { ...options, mode };
    }
    return {
        ...options,
        mode,
        cork: { ...options.cork, config: { ...options.cork?.config, sharedMemory: false } },
        graphics: { ...options.graphics, lendMemory: false },
    };
}

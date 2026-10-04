/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How much of the engine rides on shared memory. `full`: the guest's memory
 * is a SharedArrayBuffer, which the graphics worker reads unlocked bytes from
 * and writes read-backs into in place. `safe`: the guest's memory is the
 * engine thread's own, and everything that crosses to another thread is
 * copied there. A page that is not cross-origin isolated has no
 * SharedArrayBuffer, so `full` cannot run on it; `auto` -- the default --
 * takes `full` where it can and `safe` where it cannot.
 *
 * @typedef {'auto' | 'safe' | 'full'} RunMode
 */

export const RUN_MODES = Object.freeze(['auto', 'safe', 'full']);

/** Whether this thread can share memory with another. */
export function canShareMemory(){
    return typeof SharedArrayBuffer === 'function'
        && /** @type {any} */ (globalThis).crossOriginIsolated !== false;
}

/**
 * The mode a run takes: the one asked for, or for `auto` the one this
 * thread's environment allows. `full` where shared memory is not to be had is
 * refused before anything is built, not quietly run as `safe`.
 *
 * @param {RunMode | undefined | null} asked
 * @param {boolean} [shareable]
 * @returns {'safe' | 'full'}
 */
export function runModeOf(asked, shareable = canShareMemory()){
    const mode = asked ?? 'auto';
    if (!RUN_MODES.includes(mode))
    {
        throw new Error(`unknown mode ${JSON.stringify(asked)}: the modes are`
            + ` ${RUN_MODES.join(', ')}`);
    }
    if (mode === 'full' && !shareable)
    {
        throw new Error('mode "full" needs shared memory, and this page has none: it is not'
            + ' cross-origin isolated (Cross-Origin-Opener-Policy: same-origin,'
            + ' Cross-Origin-Embedder-Policy: require-corp). "safe" or "auto" runs here.');
    }
    return mode === 'auto' ? (shareable ? 'full' : 'safe') : mode;
}

/**
 * The options a run is built from, with its mode settled: in `safe` mode the
 * guest's memory is not shared and nothing is lent from it, whatever the
 * caller's cork and graphics settings say; in `full` mode those settings stand.
 *
 * @template {{ mode?: RunMode, cork?: any, graphics?: any }} T
 * @param {T} options
 * @param {boolean} [shareable]
 * @returns {T & { mode: 'safe' | 'full' }}
 */
export function withRunMode(options, shareable = canShareMemory()){
    const mode = runModeOf(options.mode, shareable);
    if (mode === 'full')
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

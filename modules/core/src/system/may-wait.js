/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether this thread may block on a shared word. A worker may; a browser's
 * window may not, even cross-origin isolated, where it has SharedArrayBuffer:
 * `Atomics.wait` throws there. What would make the thread wait on another (a
 * graphics lend, the process's executor waiting on the others) is not set up
 * on a thread that may not.
 *
 * @returns {boolean}
 */
export function mayWait(){
    if (typeof SharedArrayBuffer !== 'function')
    {
        return false;
    }
    try
    {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
        return true;
    }
    catch {
        return false;
    }
}

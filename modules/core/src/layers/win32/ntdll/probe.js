/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A native call is a system call: the kernel probes the pointers it is handed
 * and answers one it cannot reach with STATUS_ACCESS_VIOLATION, where the same
 * pointer handed to a user-mode function faults. One wrapper for every native
 * call, whichever library's table carries it (ntdll's own, kernel32's, the
 * registry's in advapi32).
 */

import { STATUS } from './status.js';

/** @param {unknown} error */
const unreachable = error=>/** @type {{ code?: string }} */ (error)?.code === 'GUEST_ACCESS';

/**
 * A native call's handler, a guest pointer it could not reach answered as the
 * kernel answers it: STATUS_ACCESS_VIOLATION, the call returning.
 *
 * @param {Function} handler
 * @returns {Function}
 */
export function probed(handler){
    return (/** @type {any[]} */ ...args)=>{
        try
        {
            const answer = handler(...args);
            return typeof answer?.then === 'function'
                ? answer.catch((/** @type {unknown} */ error)=>{
                    if (unreachable(error))
                    {
                        return STATUS.ACCESS_VIOLATION;
                    }
                    throw error;
                })
                : answer;
        }
        catch (e){
            if (unreachable(e))
            {
                return STATUS.ACCESS_VIOLATION;
            }
            throw e;
        }
    };
}

/**
 * A table's native calls (its Nt* entries) probed where the table is made,
 * the user-mode Rtl ones beside them left to fault: for a table another
 * library owns and ntdll publishes as it is.
 *
 * @template {Record<string, any>} T
 * @param {T} entries
 * @returns {T}
 */
export const probedNatives = entries=>/** @type {T} */ (Object.fromEntries(
    Object.entries(entries).map(([name, entry])=>[name,
        name.startsWith('Nt') && typeof entry?.handler === 'function'
            ? { ...entry, handler: probed(entry.handler) } : entry])));

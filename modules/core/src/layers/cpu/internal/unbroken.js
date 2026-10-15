/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The routines of the host's that no slice ends inside (the kernel's
 * `atomicCode`), as every executor of a process reads them. A thread taken off
 * an executor in the middle of one -- a command record reserved and not yet
 * finished -- holds back every record after it until it runs again, for good
 * if it is suspended there; so an executor that ends a thread's run inside one
 * runs it on to the routine's end first, as the process's own does.
 *
 * One writer, the process's thread, appends; the executors read. A range is
 * written before the count that shows it.
 */

/** Ranges the table holds: a routine block per device and per library, and room to spare. */
export const UNBROKEN_RANGES = 4096;

/**
 * How a run that ended inside one goes on: a step at a time, each ending at the
 * first place translated code looks at its budget -- a back edge, a region's
 * exit -- so it stops at the routine's `ret` rather than run past it into the
 * next call to one, a program's setters coming one after another (a step of
 * hundreds, and even of 32 past a routine with a loop, ended inside the next);
 * as many steps as the longest such routine's loop takes, a bound should one
 * ever wait.
 */
export const UNBROKEN_STEP = 1;
export const UNBROKEN_STEPS = 4096;

/**
 * The table over `buffer`, or over a new one: shared where the executors can
 * be handed it.
 *
 * @param {SharedArrayBuffer | ArrayBuffer} [buffer]
 */
export function unbrokenTable(buffer = typeof SharedArrayBuffer === 'function'
    ? new SharedArrayBuffer((1 + UNBROKEN_RANGES * 2) * 4)
    : new ArrayBuffer((1 + UNBROKEN_RANGES * 2) * 4))
{
    // [count, start, end, start, end, ...], unsigned addresses.
    const words = new Uint32Array(buffer);
    const shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
    const count = ()=>(shared ? Atomics.load(words, 0) : words[0]);
    return {
        buffer,
        /**
         * @param {number} address @param {number} length
         * @returns {boolean} false once the table is full: the range is then
         *     the process's own executor's alone
         */
        add(address, length){
            const at = count();
            if (at >= UNBROKEN_RANGES)
            {
                return false;
            }
            words[1 + at * 2] = address >>> 0;
            words[2 + at * 2] = (address >>> 0) + (length >>> 0);
            if (shared)
            {
                Atomics.store(words, 0, at + 1);
            }
            else
            {
                words[0] = at + 1;
            }
            return true;
        },
        /** @param {number} address */
        inside(address){
            const eip = address >>> 0;
            const ranges = count();
            for (let at = 0; at < ranges; at++)
            {
                if (eip >= words[1 + at * 2] && eip < words[2 + at * 2])
                {
                    return true;
                }
            }
            return false;
        },
        /** How many ranges it holds. */
        size: count,
    };
}

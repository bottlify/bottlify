/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { calleeCleanup, readArguments } from './conventions.js';
import { isParkedCall } from './parking.js';

/**
 * A trap becomes a host call.
 *
 * The guest's side of the channel is a stub that raises a trap and then returns;
 * everything between those two instructions is here. The cpu layer knows that
 * trap id N fired and nothing about what N means -- the table of meanings is
 * this one, because what an import is called and how its arguments are laid out
 * is a contract, not a machine detail.
 */

/**
 * @typedef {Object} HostFunction
 * @property {string} name
 * @property {string} convention
 * @property {number} argBytes
 * @property {Function} handler
 */

/**
 * How many call names the ring keeps. Enough that a failure report shows the
 * shape of what led to it, small enough that it is a rounding error in memory.
 */
const CALL_RING = 4096;

/**
 * @param {Object} deps
 * @param {any} deps.cpu       For the registers a call frame is read from.
 * @param {any} deps.memory    For the stack itself, so a wild ESP is caught here.
 * @param {any} deps.parking   Brackets each handler and issues the parked token.
 * @param {(answer: Promise<number>, frame: any) => void} [deps.suspend]
 *        What to do with a handler that has not finished; wired by the module.
 */
export function createDispatcher({ cpu, memory, parking, suspend }){
    /** @type {Map<number, HostFunction>} */
    const functions = new Map();
    /**
     * The names of recent calls, as a ring.
     *
     * Bounded, and that is the whole point of it. This is diagnostics: a
     * failure report wants the last handful of calls, and nothing wants the
     * millionth. Kept as a growing list it is a leak that scales with how well
     * the engine works -- a program that runs for an hour makes hundreds of
     * millions of calls, and the array eventually refuses to grow at all,
     * failing inside the dispatcher with a message about array length that says
     * nothing about the guest.
     *
     * @type {string[]}
     */
    const called = new Array(CALL_RING);
    let ringAt = 0;

    /**
     * The most-called names in the ring, with their counts, commonest first.
     *
     * @param {number} count
     * @returns {[string, number][]}
     */
    const hot = count=>{
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const name of history(CALL_RING))
        {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return [...counts].sort((left, right)=>right[1] - left[1]).slice(0, count);
    };

    /**
     * The last `count` calls, oldest first.
     *
     * @param {number} count
     * @returns {string[]}
     */
    const history = count=>{
        const kept = Math.min(count, ringAt, CALL_RING);
        /** @type {string[]} */
        const out = [];
        for (let back = kept; back > 0; back--)
        {
            out.push(called[(ringAt - back) % CALL_RING]);
        }
        return out;
    };
    /** Guest address of each stub, so a return address can be given a name. */
    /** @type {Map<number, string>} */
    const byAddress = new Map();
    let calls = 0;

    return {
        /**
         * @param {number} id
         * @param {HostFunction} fn
         */
        register(id, fn){
            if (functions.has(id))
            {
                throw new Error(`bridge: trap ${id} is already implemented by ${fn.name}`);
            }
            functions.set(id, fn);
        },

        /** @param {number} id */
        lookup: id=>functions.get(id) ?? null,

        /**
         * What lives at a guest address, when it is one of our stubs.
         *
         * @param {number} address
         * @returns {string | null}
         */
        symbolize: address=>byAddress.get(address >>> 0) ?? null,

        /**
         * @param {number} address
         * @param {string} name
         */
        placed(address, name){
            byAddress.set(address >>> 0, name);
        },

        /**
         * Handles one trap: marshal, invoke, place the result.
         *
         * @param {number} id
         */
        dispatch(id){
            const fn = functions.get(id);
            if (!fn)
            {
                throw new Error(`bridge: trap ${id} has no implementation`);
            }

            const esp = cpu.readReg32('esp');
            const args = readArguments(fn.convention, fn.argBytes, {
                esp,
                ecx: cpu.readReg32('ecx'),
                read32: (/** @type {number} */ address)=>memory.readU32(address),
            });

            calls++;
            called[ringAt++ % CALL_RING] = fn.name;

            // Everything the handler might need about where it was called from,
            // read before it runs: a handler that calls the guest back writes
            // into the stack, and by then some of this is no longer there to
            // read. `freeStack` is what is safe to write below *now*, while the
            // return address at ESP is still live; `restingStack` is where the
            // stack will be once the stub has returned.
            const frame = {
                name: fn.name,
                freeStack: esp,
                restingStack: esp + 4 + calleeCleanup(fn.convention, fn.argBytes),
                hostReturn: memory.readU32(esp),
            };

            parking.beginCall(frame);
            let result;
            try
            {
                result = fn.handler(args);
            }
            finally
            {
                parking.endCall();
            }

            // A parked call's EAX belongs to whatever wakes the thread, and it
            // carries the wait's own result. Writing a placeholder here would
            // overwrite the answer before the guest ever sees it.
            if (isParkedCall(result))
            {
                return;
            }
            if (typeof result?.then === 'function')
            {
                if (!suspend)
                {
                    throw new Error(
                        `bridge: ${fn.name} answered asynchronously with nowhere to wait`);
                }
                suspend(result, frame);
                return;
            }
            cpu.writeReg32('eax', result >>> 0);
        },

        diagnostics: ()=>({
            implemented: functions.size,
            calls,
            lastCall: ringAt === 0 ? null : called[(ringAt - 1) % CALL_RING],
            // What the guest has been doing, rather than the one thing it did
            // last. A program stuck in a loop says so here in a line; a stack
            // trace only shows where the loop was when it was interrupted.
            hot: hot(12),
        }),

        /**
         * The calls the guest has made, oldest first -- as many as the ring
         * still holds, which is every one of them until it wraps.
         */
        calls: ()=>history(ringAt),

        /** @param {number} count @returns {string[]} the last few, oldest first */
        recent: count=>history(Math.min(count, CALL_RING)),
    };
}

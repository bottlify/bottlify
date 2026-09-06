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
    /** @type {string[]} */
    const called = [];
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
            called.push(fn.name);

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
                    throw new Error(`bridge: ${fn.name} answered asynchronously with nowhere to wait`);
                }
                suspend(result, frame);
                return;
            }
            cpu.writeReg32('eax', result >>> 0);
        },

        diagnostics: ()=>({
            implemented: functions.size,
            calls,
            lastCall: called.length > 0 ? called[called.length - 1] : null,
        }),

        /** Which imports the guest has actually called, in order. */
        calls: ()=>[...called],
    };
}

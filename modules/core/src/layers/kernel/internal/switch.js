/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one place a thread switch happens.
 *
 * There is exactly one of these on purpose. Two switch primitives drift apart:
 * one of them learns about some piece of state and the other does not, and then
 * a thread resumes correctly along one path and wrongly along another, depending
 * on which route the scheduler happened to take. Every path that moves the CPU
 * from one thread to another goes through `switchTo` -- if a new path appears,
 * it calls this rather than repeating it.
 *
 * The TEB base is not a separate step a caller could forget: restoring a thread
 * takes its TEB address, so a resume that leaves FS pointing at another thread's
 * TEB cannot be written (§12.5).
 *
 * Redirecting a thread -- putting it back somewhere other than where it stopped,
 * which is how a blocked wait and a guest callback both resume -- is part of the
 * switch for the same reason. Rewriting a saved context outside this function
 * would work only for a thread that had been switched away from, and silently do
 * nothing for the thread already on the CPU.
 */

/**
 * @param {Object} options
 * @param {any} options.cpu  The cpu layer's API.
 */
export function createSwitcher({ cpu }){
    let switches = 0;
    let selfSwitches = 0;

    return {
        /**
         * Moves the CPU from one thread to another, optionally putting the
         * incoming one back somewhere other than where it stopped.
         *
         * @param {any} outgoing  The thread currently on the CPU, or null at start-up.
         * @param {any} incoming  The thread to run.
         * @param {Object | null} [resume]  Where it continues, if not where it stopped.
         * @returns {boolean} whether the CPU actually moved
         */
        switchTo(outgoing, incoming, resume = null){
            if (!incoming)
            {
                throw new Error('switchTo requires a thread to run');
            }
            if (outgoing === incoming && !resume)
            {
                // Nothing to do, and doing it anyway would be wrong: saving and
                // restoring the same thread round-trips state for no reason and
                // would hide a bug in that round trip rather than exposing it.
                selfSwitches++;
                return false;
            }

            // The outgoing thread's own state is the truth, even when it is the
            // thread coming back: what it saved last time it was switched away
            // is older than what it has done since.
            if (outgoing)
            {
                outgoing.context = cpu.captureContext();
            }
            if (resume)
            {
                cpu.resumeContextAt(incoming.context, resume);
            }
            cpu.restoreContext(incoming.context, incoming.tebAddress);
            switches++;
            return true;
        },

        diagnostics(){
            return { switches, selfSwitches };
        },
    };
}

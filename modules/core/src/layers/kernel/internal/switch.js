/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
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
         * Moves the CPU from one thread to another.
         *
         * @param {any} outgoing  The thread currently on the CPU, or null at start-up.
         * @param {any} incoming  The thread to run.
         * @returns {boolean} whether the CPU actually moved
         */
        switchTo(outgoing, incoming){
            if (!incoming)
            {
                throw new Error('switchTo requires a thread to run');
            }
            if (outgoing === incoming)
            {
                // Nothing to do, and doing it anyway would be wrong: saving and
                // restoring the same thread round-trips state for no reason and
                // would hide a bug in that round trip rather than exposing it.
                selfSwitches++;
                return false;
            }

            if (outgoing)
            {
                outgoing.context = cpu.captureContext();
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

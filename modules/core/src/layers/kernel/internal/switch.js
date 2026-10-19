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
 * @param {any} [options.memory]  Guest memory (`readU8`, `readU16`, `readU32`, `writeU32`),
 *     for a call parked in its stub; without it such a call resumes past the stub.
 */
export function createSwitcher({ cpu, memory = null }){
    let switches = 0;
    let selfSwitches = 0;
    /** The last resumes applied at a switch, newest last: which thread went where.
     * @type {string[]} */
    const applied = [];

    /**
     * A call parked before its stub's `ret` ran returns through that `ret`:
     * the return address put back where the park loop's stood, and the thread
     * at the `ret` itself. The thread retires the `ret` as a call answered at
     * once does, so what a thread retires does not depend on whether its call
     * waited -- which on several executors is the executors' timing. A stub
     * whose `ret` has run, or a resume elsewhere, goes where it says.
     *
     * @param {any} context @param {any} resume
     */
    const throughStub = (context, { inStub = false, ...resume })=>{
        if (!inStub || memory === null || typeof context?.eip !== 'number')
        {
            return resume;
        }
        const at = context.eip >>> 0;
        const esp = context.reg32[4] >>> 0;
        const op = memory.readU8(at);
        const pops = op === 0xc3 ? 0 : op === 0xc2 ? memory.readU16(at + 1) : -1;
        if (pops < 0 || memory.readU32(esp) !== cpu.parkAddress?.()
            || (resume.esp !== null && resume.esp !== undefined
                && esp + 4 + pops !== resume.esp >>> 0))
        {
            return resume;
        }
        memory.writeU32(esp, resume.eip);
        return { ...resume, eip: at, esp };
    };

    return {
        /**
         * Moves the CPU from one thread to another, optionally putting the
         * incoming one back somewhere other than where it stopped.
         *
         * @param {any} outgoing  The thread currently on the CPU, or null at start-up.
         * @param {any} incoming  The thread to run.
         * @param {{ eip: number, esp?: number | null, returnValue?: number,
         *     inStub?: boolean } | null} [resume]
         *     Where it continues, if not where it stopped. `inStub`: a call parked
         *     in the stub that made it (`parkThread`).
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
                outgoing.context = cpu.captureContext(outgoing.context);
            }
            if (resume)
            {
                const where = throughStub(incoming.context, resume);
                cpu.resumeContextAt(incoming.context, where);
                applied.push(`${incoming.name}<-0x${(where.eip >>> 0).toString(16)}`
                    + (where.esp !== null && where.esp !== undefined
                        ? `/0x${(where.esp >>> 0).toString(16)}` : ''));
                if (applied.length > 16)
                {
                    applied.shift();
                }
            }
            cpu.restoreContext(incoming.context, incoming.tebAddress);
            switches++;
            return true;
        },

        diagnostics(){
            return { switches, selfSwitches, recentResumes: applied.slice() };
        },
    };
}

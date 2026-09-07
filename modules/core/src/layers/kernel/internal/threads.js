/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Threads and the queue they take turns in.
 *
 * A thread is its saved CPU state, its stack, its TEB, and where it is in the
 * lifecycle. The scheduler here is round-robin over the ready threads, with the
 * quantum counted in retired guest instructions -- so the point at which one
 * thread yields to another is a function of what the guest did, not of how fast
 * the host happens to be.
 */

/** @enum {string} */
export const ThreadState = {
    /** Runnable, waiting for a turn. */
    READY: 'ready',
    /** On the CPU right now. */
    RUNNING: 'running',
    /** Waiting for something; not a candidate until woken. */
    BLOCKED: 'blocked',
    /** Finished. Its handle may outlive it. */
    TERMINATED: 'terminated',
};

/**
 * @param {Object} options
 * @param {any} options.cpu        The cpu layer's API.
 * @param {any} options.switcher   The single switch primitive.
 * @param {number} [options.quantum]  Retired instructions per turn.
 */
export function createScheduler({ cpu, switcher, quantum = 100_000 }){
    /** @type {any[]} */
    const threads = [];
    /** @type {any} */
    let current = null;
    let nextId = 1;
    let turns = 0;

    const ready = ()=>threads.filter(thread=>thread.state === ThreadState.READY);

    return {
        /**
         * Creates a thread. It does not run yet, and creating it does not move
         * the CPU: the creator has not necessarily finished setting up whatever
         * the new thread is about to read (§12.4).
         *
         * @param {Object} options
         * @param {number} options.entry
         * @param {number} options.stackTop
         * @param {number} options.tebAddress
         * @param {string} [options.name]
         * @returns {any} the thread
         */
        create({ entry, stackTop, tebAddress, name }){
            const thread = {
                id: nextId++,
                name: name ?? `thread-${nextId - 1}`,
                state: ThreadState.READY,
                tebAddress,
                stackTop,
                entry,
                context: cpu.newContext({ entry, stackTop }),
                instructions: 0,
                exitCode: null,
                /** What it is waiting for, when blocked; for diagnostics. */
                waitingOn: null,
            };
            threads.push(thread);
            return thread;
        },

        /** @returns {any} the thread on the CPU, or null */
        current: ()=>current,

        /** @returns {any[]} */
        all: ()=>[...threads],

        /**
         * Gives the CPU to the next ready thread and lets it run a quantum.
         *
         * Returns what happened, so a caller driving the machine can tell the
         * difference between progress, an idle system and a finished one --
         * three states that look identical if all you get back is a number.
         *
         * @returns {{ ran: any | null, instructions: number, switched: boolean }}
         */
        runOnce(){
            const candidates = ready();
            if (candidates.length === 0)
            {
                return { ran: null, instructions: 0, switched: false };
            }

            // Round-robin: the queue order is creation order, and a thread that
            // has just run goes behind the others by being moved to the back.
            const next = candidates[0];

            // A thread that parked was stopped mid-call: put it back where it
            // belongs, carrying whatever its wait produced. Deciding that here
            // and applying it inside the switch means it happens exactly once,
            // after the thread's own state has been saved -- which matters most
            // when the thread coming back is the one already on the CPU.
            let resume = null;
            if (next.parkedReturn !== null && next.parkedReturn !== undefined)
            {
                resume = {
                    eip: next.parkedReturn,
                    esp: next.resumeStack ?? null,
                    returnValue: next.waitResult ?? 0,
                };
                next.parkedReturn = null;
                next.resumeStack = null;
                next.waitResult = null;
            }
            // Whatever `current` is, it is the thread whose state is on the CPU,
            // and it has to be saved before another one takes over -- including,
            // especially, a thread that has just blocked. Saving only threads
            // still marked RUNNING loses the state of every thread that parked
            // itself in a wait, which then resumes from wherever it first began.
            const switched = switcher.switchTo(current, next, resume);

            if (current && current.state === ThreadState.RUNNING)
            {
                current.state = ThreadState.READY;
            }
            current = next;
            next.state = ThreadState.RUNNING;

            const instructions = cpu.runSlice(quantum);
            next.instructions += instructions;
            turns++;

            if (next.state === ThreadState.RUNNING)
            {
                next.state = ThreadState.READY;
                // To the back of the queue, so the next call picks someone else.
                threads.splice(threads.indexOf(next), 1);
                threads.push(next);
            }

            return { ran: next, instructions, switched };
        },

        /**
         * @param {any} thread
         * @param {string} [reason]  What it is waiting for, for diagnostics.
         */
        block(thread, reason){
            thread.state = ThreadState.BLOCKED;
            thread.waitingOn = reason ?? null;
        },

        /** @param {any} thread */
        wake(thread){
            if (thread.state !== ThreadState.BLOCKED)
            {
                return false;
            }
            thread.state = ThreadState.READY;
            thread.waitingOn = null;
            return true;
        },

        /** @param {any} thread @param {number} exitCode */
        terminate(thread, exitCode){
            thread.state = ThreadState.TERMINATED;
            thread.exitCode = exitCode;
            if (current === thread)
            {
                current = null;
            }
        },

        diagnostics(){
            /** @type {Record<string, number>} */
            const byState = {};
            for (const thread of threads)
            {
                byState[thread.state] = (byState[thread.state] ?? 0) + 1;
            }
            return {
                quantum,
                turns,
                threads: threads.length,
                byState,
                current: current ? current.name : null,
                // A thread that has been waiting on the same thing for a long
                // time is the shape of a deadlock, so name what each is waiting on.
                waiting: threads
                    .filter(thread=>thread.state === ThreadState.BLOCKED)
                    .map(thread=>`${thread.name}: ${thread.waitingOn ?? 'unknown'}`),
            };
        },
    };
}

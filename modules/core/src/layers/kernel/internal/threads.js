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
 * @param {() => number} [options.now]  The guest's clock, for timed waits.
 * @param {(deadline: number) => number} [options.skipTo]
 *        Moves the guest's clock to a deadline when every thread is waiting on
 *        one, and answers how far it actually moved -- which is nothing once the
 *        clock has caught up with the host's.
 */
export function createScheduler(options){
    const { cpu, switcher, quantum = 100_000, now = ()=>0, skipTo = ()=>0 } = options;
    /** @type {any[]} */
    const threads = [];
    /** @type {any} */
    let current = null;
    let nextId = 1;
    let turns = 0;
    let expiries = 0;
    /** @type {((thread: any) => void)[]} */
    const onExpiry = [];

    // A thread parked on a host call that has not answered is not a candidate.
    // It is stopped on `hlt` with nothing of its own to run, and counting it as
    // ready is what kept `soonest()` below out of reach: with one such thread
    // the scheduler always had someone to give a turn to, so it never moved the
    // clock to the next deadline and every timed wait in the guest expired in
    // host time instead of guest time.
    const ready = ()=>threads.filter(thread=>
        thread.state === ThreadState.READY && !thread.awaitingHost);

    /** The soonest deadline any blocked thread is waiting on, or null. */
    const soonest = ()=>threads.reduce((best, thread)=>(
        thread.state === ThreadState.BLOCKED && thread.deadline !== null
        && thread.deadline !== undefined && (best === null || thread.deadline < best)
            ? thread.deadline
            : best), /** @type {number | null} */ (null));

    /**
     * Wakes every thread whose deadline has passed.
     *
     * A timed wait that expires is not a failure: the thread runs again and its
     * call answers that the time ran out, which is a result a program acts on
     * rather than an error it reports. Whoever put the thread on a waiter list
     * is told, so the list does not keep a thread that has stopped waiting.
     */
    const expire = ()=>{
        const at = now();
        for (const thread of threads)
        {
            if (thread.state !== ThreadState.BLOCKED
                || thread.deadline === null || thread.deadline === undefined
                || thread.deadline > at)
            {
                continue;
            }
            thread.deadline = null;
            thread.waitResult = thread.timeoutResult ?? 0;
            thread.state = ThreadState.READY;
            thread.waitingOn = null;
            expiries++;
            for (const told of onExpiry)
            {
                told(thread);
            }
        }
    };

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
                /**
                 * Set while a host call this thread made has not answered. Such
                 * a thread is ready in every other sense and has nothing to run.
                 */
                awaitingHost: false,
                // A thread is a waitable object in its own right: a program
                // joins one by waiting on its handle, and it becomes signalled
                // when it ends and stays that way. Carried here rather than in
                // a parallel table so that the thing a handle resolves to is
                // the thing a wait examines.
                kind: 'thread',
                /** @type {any[]} */
                waiters: [],
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
            expire();
            let candidates = ready();
            if (candidates.length === 0)
            {
                // Nothing can run, but something is waiting for a time rather
                // than for another thread. Idling in wall clock would be a real
                // pause for no reason -- the guest's clock is ours to move, and
                // moving it to the soonest deadline is exactly what a machine
                // with nothing to do does.
                const deadline = soonest();
                if (deadline === null)
                {
                    return { ran: null, instructions: 0, switched: false };
                }
                // Nothing to gain from sitting through a wait in real time --
                // and nothing to be had by moving past real time either, which
                // is why the clock, not this, decides how far it goes. When it
                // answers zero the machine really does have to wait.
                if (skipTo(deadline) === 0)
                {
                    return { ran: null, instructions: 0, switched: false };
                }
                expire();
                candidates = ready();
                if (candidates.length === 0)
                {
                    return { ran: null, instructions: 0, switched: false };
                }
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
         * @param {Object} [timed]
         * @param {number} [timed.deadline]  Guest time after which it wakes anyway.
         * @param {number} [timed.result]    What the call answers when it does.
         */
        block(thread, reason, timed){
            thread.state = ThreadState.BLOCKED;
            thread.waitingOn = reason ?? null;
            thread.deadline = timed?.deadline ?? null;
            thread.timeoutResult = timed?.result ?? 0;
        },

        /** @param {any} thread */
        wake(thread){
            if (thread.state !== ThreadState.BLOCKED)
            {
                return false;
            }
            thread.state = ThreadState.READY;
            thread.waitingOn = null;
            thread.deadline = null;
            return true;
        },

        /**
         * Told when a thread's wait ran out of time, so whoever queued it can
         * take it off whatever it was queued on.
         *
         * @param {(thread: any) => void} handler
         */
        onTimeout(handler){
            onExpiry.push(handler);
        },

        /** Whether any thread is waiting on a time rather than on another thread. */
        nextDeadline: ()=>soonest(),

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
                // Timed waits that ran out rather than being satisfied.
                expiries,
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

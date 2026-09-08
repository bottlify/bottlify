/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Synchronisation objects: events, mutexes, semaphores, and waiting on them.
 *
 * Behaviour follows the documented Win32 contract rather than what is
 * convenient, because a program's correctness depends on the details: which
 * waiter is released, whether a wait consumes the signal, what an abandoned
 * mutex reports. Getting one of those subtly wrong produces a program that
 * mostly works, which is the worst kind.
 */

/** What a wait returns. The numeric values are the ones the guest expects. */
export const WaitResult = {
    OBJECT_0: 0x00000000,
    ABANDONED: 0x00000080,
    TIMEOUT: 0x00000102,
    FAILED: 0xffffffff,
};

/** Objects the kernel knows how to wait on. */
export const SyncKind = {
    EVENT: 'event',
    MUTEX: 'mutex',
    SEMAPHORE: 'semaphore',
    // Not created here and never taken: a thread becomes signalled when it
    // ends and stays so for ever. It is in this list because a program joins a
    // thread by waiting on its handle, and a wait that did not know about it
    // would fail on the one object every program waits on.
    THREAD: 'thread',
};

/**
 * @param {Object} options
 * @param {any} options.scheduler  Used to block and wake threads.
 */
export function createSyncObjects({ scheduler }){
    /** @type {any[]} */
    const objects = [];

    // A thread whose wait ran out of time has stopped waiting, and a queue that
    // still holds it would hand it the object later -- signalling something
    // nobody is waiting for, and losing the signal for whoever was.
    scheduler.onTimeout?.((/** @type {any} */ thread)=>{
        for (const object of objects)
        {
            const at = object.waiters.indexOf(thread);
            if (at >= 0)
            {
                object.waiters.splice(at, 1);
            }
        }
    });

    /**
     * Waiters in arrival order. Windows does not promise FIFO, but choosing an
     * order and keeping it makes a multithreaded program reproducible, which is
     * worth more here than matching an unspecified detail.
     *
     * @param {any} object
     */
    const nextWaiter = object=>object.waiters.shift() ?? null;

    /** @param {any} object */
    const isSignalled = object=>{
        switch (object.kind)
        {
            case SyncKind.EVENT:
                return object.signalled;
            case SyncKind.MUTEX:
                return object.owner === null;
            case SyncKind.SEMAPHORE:
                return object.count > 0;
            case SyncKind.THREAD:
                return object.exitCode !== null;
            default:
                throw new Error(`Unknown sync object: ${object.kind}`);
        }
    };

    /**
     * Takes the object on behalf of a thread. Only called once the object is
     * known to be signalled, so this is where the state change lives.
     *
     * When the thread was waiting, the result is recorded on it: a thread woken
     * onto an abandoned mutex has to learn that it was abandoned, and there is
     * nowhere else for that to live between the wake and the thread's next turn.
     * Dropping it would silently turn "the state you are about to read was left
     * half-written" into "you got the mutex, carry on".
     *
     * @param {any} object
     * @param {any} thread
     * @returns {number} the wait result
     */
    const acquire = (object, thread)=>{
        switch (object.kind)
        {
            case SyncKind.EVENT:
            // An auto-reset event releases exactly one waiter and goes back to
            // unsignalled; a manual-reset one stays open until someone resets it.
                if (!object.manualReset)
                {
                    object.signalled = false;
                }
                return WaitResult.OBJECT_0;

            case SyncKind.MUTEX: {
                const abandoned = object.abandoned;
                object.owner = thread;
                object.recursion = 1;
                object.abandoned = false;
                // A mutex whose owner died still hands over ownership, but says so:
                // whatever it was protecting was left in an unknown state.
                return abandoned ? WaitResult.ABANDONED : WaitResult.OBJECT_0;
            }

            case SyncKind.SEMAPHORE:
                object.count--;
                return WaitResult.OBJECT_0;

            // Nothing is taken from a thread. It ended, it stays ended, and
            // every waiter is entitled to see that -- taking it would make a
            // second join on the same thread wait for ever.
            case SyncKind.THREAD:
                return WaitResult.OBJECT_0;

            default:
                throw new Error(`Unknown sync object: ${object.kind}`);
        }
    };

    const api = {
        /**
         * Wakes everything waiting on an object that has just become signalled
         * for good -- a thread that ended. Unlike a set event there is nothing
         * to take and nothing to reset, so every waiter goes at once.
         *
         * @param {any} object
         */
        releaseAll(object){
            for (const waiter of object.waiters ?? [])
            {
                // On the thread rather than through the scheduler: the scheduler
                // this layer holds wakes and nothing more, so a result handed to
                // it is dropped and the waiter resumes with whatever it had.
                waiter.waitResult = WaitResult.OBJECT_0;
                scheduler.wake(waiter);
            }
            if (object.waiters)
            {
                object.waiters.length = 0;
            }
        },

        /**
         * @param {Object} options
         * @param {boolean} [options.manualReset]
         * @param {boolean} [options.signalled]
         * @param {string} [options.name]
         */
        createEvent({ manualReset = false, signalled = false, name } = {}){
            const object = {
                kind: SyncKind.EVENT, name: name ?? 'event',
                manualReset, signalled, waiters: [],
            };
            objects.push(object);
            return object;
        },

        /** @param {Object} [options] @param {string} [options.name] */
        createMutex({ name } = {}){
            const object = {
                kind: SyncKind.MUTEX, name: name ?? 'mutex',
                owner: null, recursion: 0, abandoned: false, waiters: [],
            };
            objects.push(object);
            return object;
        },

        /**
         * @param {Object} options
         * @param {number} options.initial
         * @param {number} options.maximum
         * @param {string} [options.name]
         */
        createSemaphore({ initial, maximum, name }){
            if (initial < 0 || initial > maximum)
            {
                throw new Error('Semaphore initial count must be within [0, maximum]');
            }
            const object = {
                kind: SyncKind.SEMAPHORE, name: name ?? 'semaphore',
                count: initial, maximum, waiters: [],
            };
            objects.push(object);
            return object;
        },

        /**
         * Waits for one object.
         *
         * Returns immediately when the object is available. Otherwise the thread
         * is blocked and the result is delivered when it is woken -- so a caller
         * gets `null` meaning "not yet", not a value it might mistake for success.
         *
         * @param {any} object
         * @param {any} thread
         * @param {Object} [timed]
         * @param {number} [timed.deadline]  Guest time after which it gives up.
         * @param {number} [timed.result]    What the call answers when it does.
         * @returns {number | null} the wait result, or null if the thread blocked
         */
        wait(object, thread, timed){
            // A thread that already owns a mutex takes it again without waiting;
            // a recursive acquisition is not a deadlock, it is a counter.
            if (object.kind === SyncKind.MUTEX && object.owner === thread)
            {
                object.recursion++;
                return WaitResult.OBJECT_0;
            }

            if (isSignalled(object))
            {
                return acquire(object, thread);
            }

            object.waiters.push(thread);
            scheduler.block(thread, `${object.kind} "${object.name}"`, timed);
            return null;
        },

        /**
         * Waits for all of several objects.
         *
         * Nothing is taken until everything is available. Acquiring what is ready
         * and waiting for the rest is how two threads take the same pair in
         * opposite orders and deadlock.
         *
         * @param {any[]} objects_
         * @param {any} thread
         * @param {{ deadline?: number, result?: number }} [timed]
         * @returns {number | null}
         */
        waitAll(objects_, thread, timed){
            const ready = objects_.every(object=>
                isSignalled(object) || (object.kind === SyncKind.MUTEX && object.owner === thread));
            if (!ready)
            {
                for (const object of objects_)
                {
                    if (!object.waiters.includes(thread))
                    {
                        object.waiters.push(thread);
                    }
                }
                scheduler.block(thread, `all of ${objects_.length} objects`, timed);
                return null;
            }

            let result = WaitResult.OBJECT_0;
            for (const object of objects_)
            {
                const one = api.wait(object, thread);
                if (one === WaitResult.ABANDONED)
                {
                    result = WaitResult.ABANDONED;
                }
            }
            return result;
        },

        /**
         * Waits for any one of several objects.
         *
         * @param {any[]} objects_
         * @param {any} thread
         * @param {{ deadline?: number, result?: number }} [timed]
         * @returns {{ index: number, result: number } | null}
         */
        waitAny(objects_, thread, timed){
            for (let i = 0; i < objects_.length; i++)
            {
                const object = objects_[i];
                const mine = object.kind === SyncKind.MUTEX && object.owner === thread;
                if (isSignalled(object) || mine)
                {
                    return { index: i, result: /** @type {number} */ (api.wait(object, thread)) };
                }
            }
            for (const object of objects_)
            {
                object.waiters.push(thread);
            }
            scheduler.block(thread, `any of ${objects_.length} objects`, timed);
            return null;
        },

        /**
         * Signals an event. A manual-reset event releases everyone waiting; an
         * auto-reset one releases a single waiter and closes again.
         *
         * @param {any} object
         * @returns {any[]} threads woken
         */
        setEvent(object){
            object.signalled = true;
            const woken = [];
            if (object.manualReset)
            {
                while (object.waiters.length > 0)
                {
                    const thread = nextWaiter(object);
                    thread.waitResult = acquire(object, thread);
                    scheduler.wake(thread);
                    woken.push(thread);
                }
            }
            else if (object.waiters.length > 0)
            {
                const thread = nextWaiter(object);
                thread.waitResult = acquire(object, thread);
                scheduler.wake(thread);
                woken.push(thread);
            }
            return woken;
        },

        /** @param {any} object */
        resetEvent(object){
            object.signalled = false;
        },

        /**
         * Releases a mutex. Only the owner may, and only the outermost
         * acquisition actually frees it.
         *
         * @param {any} object
         * @param {any} thread
         * @returns {boolean} whether it was released
         */
        releaseMutex(object, thread){
            if (object.owner !== thread)
            {
                return false;
            }
            object.recursion--;
            if (object.recursion > 0)
            {
                return true;
            }
            object.owner = null;
            const next = nextWaiter(object);
            if (next)
            {
                next.waitResult = acquire(object, next);
                scheduler.wake(next);
            }
            return true;
        },

        /**
         * The owner died without releasing. The next waiter gets it, and is told
         * that what it protects may be inconsistent.
         *
         * @param {any} thread
         */
        abandonMutexesOwnedBy(thread){
            for (const object of objects)
            {
                if (object.kind === SyncKind.MUTEX && object.owner === thread)
                {
                    object.owner = null;
                    object.recursion = 0;
                    object.abandoned = true;
                    const next = nextWaiter(object);
                    if (next)
                    {
                        next.waitResult = acquire(object, next);
                        scheduler.wake(next);
                    }
                }
            }
        },

        /**
         * @param {any} object
         * @param {number} [count]
         * @returns {number} the previous count
         */
        releaseSemaphore(object, count = 1){
            if (object.count + count > object.maximum)
            {
                throw new Error('Semaphore released past its maximum');
            }
            const previous = object.count;
            object.count += count;
            while (object.count > 0 && object.waiters.length > 0)
            {
                const thread = nextWaiter(object);
                thread.waitResult = acquire(object, thread);
                scheduler.wake(thread);
            }
            return previous;
        },

        diagnostics(){
            return objects.map(object=>({
                kind: object.kind,
                name: object.name,
                waiters: object.waiters.length,
                state: object.kind === SyncKind.MUTEX
                    ? (object.owner ? `held by ${object.owner.name}` : 'free')
                    : object.kind === SyncKind.SEMAPHORE
                        ? `${object.count}/${object.maximum}`
                        : (object.signalled ? 'signalled' : 'unsignalled'),
            }));
        },
    };

    return api;
}

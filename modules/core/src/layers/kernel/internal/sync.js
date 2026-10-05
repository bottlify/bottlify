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
    // A waitable timer: an object whose signalled state the clock sets when
    // its due time arrives, with no thread having to be present. It carries
    // the due time and period; the scheduler holds the clock entry that
    // releases the waiters.
    TIMER: 'timer',
};

/**
 * The run's named objects as a process across a link reaches them: the
 * operations of `system-objects.js`, each a blocking call.
 *
 * @typedef {Object} RemoteObjects
 * @property {(id: number, threadId: number, token: number) => number | null} wait
 * @property {(token: number) => number | null} cancel
 * @property {(id: number, threadId: number) => number | null} poll
 * @property {(id: number) => void} set
 * @property {(id: number) => void} reset
 * @property {(id: number, count: number) => number} release
 * @property {(id: number, threadId: number) => boolean} releaseMutex
 */

/**
 * Whether a wait on the object would be satisfied now.
 *
 * @param {any} object
 * @returns {boolean}
 */
export function signalledNow(object){
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
        case SyncKind.TIMER:
            return object.signalled === true;
        default:
            throw new Error(`Unknown sync object: ${object.kind}`);
    }
}

/**
 * @param {Object} options
 * @param {any} options.scheduler  Used to block and wake threads.
 * @param {RemoteObjects | null} [options.remote]
 *     The run's named objects, where this process reaches them across a link
 *     (`system-objects.js`): an object of this table that names one of those
 *     by `remote` is a stand-in, and every change and wait on it is asked there.
 */
export function createSyncObjects({ scheduler, remote = null }){
    /** @type {any[]} */
    const objects = [];
    /** How many of each kind were ever made; the cheap answer about the table. */
    const created = {
        [SyncKind.EVENT]: 0, [SyncKind.MUTEX]: 0, [SyncKind.SEMAPHORE]: 0, [SyncKind.TIMER]: 0,
    };

    // A thread whose wait ran out of time has stopped waiting, and a queue that
    // still holds it would hand it the object later -- signalling something
    // nobody is waiting for, and losing the signal for whoever was.
    // Only the queues it stood in are searched: a thread remembers them when
    // it is queued, and a scan of every object for every expiry was a cost
    // paid tens of thousands of times a second by a program that polls.
    /** Waits on another process's object, queued there, by their token. @type {Map<number, any>} */
    const remoteWaits = new Map();
    let nextToken = 1;
    /**
     * The wait being asked for across the link now, and the word that it
     * ended if that came first: the link answers what it is asked while it
     * waits for an answer of its own, so the wake can arrive before the
     * answer that the wait was queued.
     *
     * @type {{ token: number, result: number | null } | null}
     */
    let asking = null;
    /** @param {any} thread */
    const stopWaiting = thread=>{
        if (thread.remoteWait && remote)
        {
            // Taken off the queue there -- unless it was handed the object
            // already, in which case it has it, whatever its clock said.
            const token = thread.remoteWait;
            remoteWaits.delete(token);
            thread.remoteWait = null;
            const granted = remote.cancel(token);
            if (granted !== null)
            {
                thread.waitResult = granted;
            }
        }
        for (const object of thread.queuedOn ?? objects)
        {
            const at = object.waiters.indexOf(thread);
            if (at >= 0)
            {
                object.waiters.splice(at, 1);
            }
        }
        thread.queuedOn = null;
        thread.waitSet = null;
    };
    scheduler.onTimeout?.(stopWaiting);

    const isSignalled = signalledNow;

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

            // A synchronisation timer is reset by the wait that takes it, a
            // manual-reset one stays signalled until it is armed again.
            case SyncKind.TIMER:
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

    /** @param {any} object @param {any} thread */
    const owns = (object, thread)=>
        object.kind === SyncKind.MUTEX && object.owner === thread;

    /** @param {any} thread @param {any} object  What woke it, when it waited alone. */
    const leaveQueues = (thread, object)=>{
        for (const one of thread.waitSet?.objects ?? [object])
        {
            const at = one.waiters.indexOf(thread);
            if (at >= 0)
            {
                one.waiters.splice(at, 1);
            }
        }
        thread.waitSet = null;
    };

    /**
     * Hands a signalled object to the first waiter that can take it.
     *
     * Two things a queue of single waiters does not have to think about, and a
     * thread waiting on a set does:
     *
     * - **Which object released it is half the answer.** A wait on several
     *   objects reports the index of the one that came, and a thread told the
     *   first every time takes whatever branch belongs to whatever happens to
     *   be listed first -- which is how a program's own service thread reads a
     *   mutex it was handed as its shutdown signal and exits.
     * - **A thread waiting for *all* of a set cannot take one of them.**
     *   Nothing is taken until everything is available, so such a waiter is
     *   passed over and the object goes to whoever can use it.
     *
     * And whoever is released leaves the queues of the rest of its set: a queue
     * that still holds a thread that has stopped waiting hands the object to it
     * later, and whoever is still waiting never gets it.
     *
     * @param {any} object
     * @returns {any | null} the thread woken, if any
     */
    const releaseTo = object=>{
        // Arrival order. Windows does not promise FIFO, but choosing an order
        // and keeping it makes a multithreaded program reproducible, which is
        // worth more here than matching an unspecified detail. Over a copy,
        // because whoever takes it leaves the queue as it goes.
        for (const thread of [...object.waiters])
        {
            // A suspended waiter is not waiting while it is suspended: what it
            // took it could not use, and whoever else waits would starve for
            // as long as it stays suspended. It stays queued, and `retry`
            // looks again when it is resumed.
            if (thread.suspendCount > 0)
            {
                continue;
            }
            const set = thread.waitSet;
            const all = set?.all === true;
            if (all && !set.objects.every(
                (/** @type {any} */ one)=>isSignalled(one) || owns(one, thread)))
            {
                continue;
            }
            hand(thread, object);
            return thread;
        }
        return null;
    };

    /**
     * Ends a queued thread's wait with the object that satisfied it.
     *
     * @param {any} thread @param {any} object
     */
    const hand = (thread, object)=>{
        const set = thread.waitSet;
        leaveQueues(thread, object);
        if (set?.all === true)
        {
            let result = WaitResult.OBJECT_0;
            for (const one of set.objects)
            {
                if (api.wait(one, thread) === WaitResult.ABANDONED)
                {
                    result = WaitResult.ABANDONED;
                }
            }
            thread.waitResult = result;
        }
        else
        {
            // The base is what acquiring said -- OBJECT_0, or ABANDONED for
            // a mutex whose owner died -- and the index is added to it,
            // which is what makes both of them bases rather than values.
            const index = set ? set.objects.indexOf(object) : 0;
            thread.waitResult = (acquire(object, thread) + index) >>> 0;
        }
        // The thread's own scheduler, which is not this one's when the
        // object is a named one another process of the run made: a process
        // that signals it wakes a thread its own scheduler does not hold.
        (thread.scheduler ?? scheduler).wake(thread);
    };

    /** @param {any[]} objects_ */
    const describeSet = objects_=>objects_
        .map(object=>`${object.kind} "${object.name}"`).join(', ');

    /**
     * A wait on a set holding another process's object is not carried across
     * a link yet: said, rather than answered as though the object were here.
     *
     * @param {any[]} set
     */
    const refuseRemoteSet = set=>{
        if (remote && set.some(object=>object.remote))
        {
            throw new Error('a wait on a set of objects one of which is another process\'s,'
                + ' across a link, is not carried yet');
        }
    };

    const api = {
        /**
         * One of this process's waits on another process's object ended
         * there: the thread has the object, and runs on with the result.
         *
         * @param {number} token @param {number} result
         */
        wakeRemote(token, result){
            const thread = remoteWaits.get(token);
            if (!thread)
            {
                if (asking?.token === token)
                {
                    asking.result = result;
                }
                return;
            }
            remoteWaits.delete(token);
            thread.remoteWait = null;
            thread.waitResult = result;
            (thread.scheduler ?? scheduler).wake(thread);
        },

        /**
         * Wakes everything waiting on an object that has just become signalled
         * for good -- a thread that ended. Unlike a set event there is nothing
         * to take and nothing to reset, so every waiter goes at once.
         *
         * @param {any} object
         */
        releaseAll(object){
            // Everyone who can take it. A thread waiting for all of a set is
            // not released by this one alone, so it stays queued rather than
            // being woken with a wait it has not finished.
            while (releaseTo(object))
            {
                // Each release takes its thread out of the queue, so this ends.
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
            created[SyncKind.EVENT]++;
            return object;
        },

        /** @param {Object} [options] @param {string} [options.name] */
        createMutex({ name } = {}){
            const object = {
                kind: SyncKind.MUTEX, name: name ?? 'mutex',
                owner: null, recursion: 0, abandoned: false, waiters: [],
            };
            objects.push(object);
            created[SyncKind.MUTEX]++;
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
            created[SyncKind.SEMAPHORE]++;
            return object;
        },

        /**
         * A waitable timer. Its signalled state is set by the clock, not by a
         * wait: arming registers the due time with the scheduler, which
         * signals the object when it comes round whether or not anyone is
         * waiting, and re-arms a periodic one on the same clock.
         *
         * @param {Object} [options]
         * @param {boolean} [options.manualReset]
         * @param {string} [options.name]
         */
        createTimer({ manualReset = false, name } = {}){
            const object = {
                kind: SyncKind.TIMER, name: name ?? 'timer',
                manualReset, signalled: false, waiters: [],
                due: null, period: 0, token: null,
                /** @type {((at: number) => void) | null} */
                fired: null,
            };
            objects.push(object);
            created[SyncKind.TIMER]++;
            return object;
        },

        /**
         * Sets when a timer comes due, replacing any due time it already had.
         * The signal belongs to the object and the clock from here: a waiter
         * that parked before this call is released at the due time just as one
         * that arrives after it.
         *
         * @param {any} object @param {number} due @param {number} period
         * @param {((at: number) => void) | null} [fired]  Told each time it
         *        comes due, with the guest time it came due at -- how a
         *        completion routine is queued, one call per expiry.
         */
        armTimer(object, due, period, fired = null){
            if (object.token !== null && object.token !== undefined)
            {
                scheduler.removeTimer(object.token);
            }
            object.signalled = false;
            object.due = due;
            object.period = Math.max(0, period);
            object.token = scheduler.addTimer(due, object.period, (/** @type {number} */ next)=>{
                // A periodic timer moves on to its next boundary; a one-shot
                // has fired for the last time.
                const at = object.due;
                object.due = object.period > 0 ? next : null;
                api.setEvent(object);
                object.fired?.(at);
            });
            object.fired = fired;
            return true;
        },

        /**
         * Disarms a timer without signalling it. What is signalled stays
         * signalled; a waiter that is parked stays parked.
         *
         * @param {any} object
         */
        cancelTimer(object){
            if (object.token !== null && object.token !== undefined)
            {
                scheduler.removeTimer(object.token);
            }
            object.token = null;
            object.due = null;
            object.period = 0;
            object.fired = null;
        },

        /**
         * Takes a blocked thread off every queue it stands in, for a wait that
         * ends for a reason none of its objects gave -- an APC, here.
         *
         * @param {any} thread
         */
        stopWaiting,

        /**
         * Looks again at the wait a thread is queued in, for a thread that
         * could not be handed anything while it was suspended: an object
         * signalled in that time, and still signalled, ends the wait now, as
         * it would have had the thread been there to take it.
         *
         * @param {any} thread
         * @returns {boolean} whether the wait ended
         */
        retry(thread){
            if (thread.state !== 'blocked' || thread.suspendCount > 0)
            {
                return false;
            }
            // Only the queues it still stands in: a thread whose last wait was
            // answered keeps the list of what it was queued on, and a later
            // block of another kind must not be ended by an object from it.
            const queued = (thread.queuedOn ?? []).filter(
                (/** @type {any} */ one)=>one.waiters.includes(thread));
            if (queued.length === 0)
            {
                return false;
            }
            const set = thread.waitSet;
            /** @param {any} one */
            const takeable = one=>isSignalled(one) || owns(one, thread);
            if (set?.all === true)
            {
                if (!set.objects.every(takeable))
                {
                    return false;
                }
                hand(thread, set.objects[0]);
                return true;
            }
            // The first in the caller's order, which is the index it is told.
            const object = (set ? set.objects : queued).find(takeable);
            if (!object)
            {
                return false;
            }
            hand(thread, object);
            return true;
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
            if (object.remote && remote)
            {
                const token = nextToken++;
                asking = { token, result: null };
                let now;
                try
                {
                    now = remote.wait(object.remote, thread.id, token) ?? asking.result;
                }
                finally
                {
                    asking = null;
                }
                if (now !== null)
                {
                    return now;
                }
                thread.waitSet = null;
                thread.queuedOn = [];
                thread.remoteWait = token;
                remoteWaits.set(token, thread);
                scheduler.block(thread, `${object.kind} "${object.name}"`, timed);
                return null;
            }
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

            thread.waitSet = null;
            thread.queuedOn = [object];
            object.waiters.push(thread);
            scheduler.block(thread, `${object.kind} "${object.name}"`, timed);
            return null;
        },

        /**
         * Asks whether an object is available now, taking it if it is, and
         * never queues the thread.
         *
         * Not a wait with a zero deadline. That queued the thread and answered
         * at once, and the entry outlived the question: the thread went on to
         * wait on something else, the polled object was signalled to nobody in
         * particular, and the stale entry handed it the thread -- woken with an
         * answer that named the wrong object, which a program reads as its
         * shutdown signal.
         *
         * @param {any} object
         * @param {any} thread
         * @returns {number | null} the wait result, or null if it is not ready
         */
        poll(object, thread){
            if (object.remote && remote)
            {
                return remote.poll(object.remote, thread.id);
            }
            if (object.kind === SyncKind.MUTEX && object.owner === thread)
            {
                object.recursion++;
                return WaitResult.OBJECT_0;
            }
            return isSignalled(object) ? acquire(object, thread) : null;
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
            refuseRemoteSet(objects_);
            const ready = objects_.every(object=>
                isSignalled(object) || (object.kind === SyncKind.MUTEX && object.owner === thread));
            if (!ready)
            {
                thread.waitSet = { objects: objects_, all: true };
                thread.queuedOn = objects_;
                for (const object of objects_)
                {
                    if (!object.waiters.includes(thread))
                    {
                        object.waiters.push(thread);
                    }
                }
                // Named rather than counted: "all of 2 objects" is the one thing
                // a report of a stalled thread cannot be read without.
                scheduler.block(thread, `all of ${describeSet(objects_)}`, timed);
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
            refuseRemoteSet(objects_);
            for (let i = 0; i < objects_.length; i++)
            {
                const object = objects_[i];
                const mine = object.kind === SyncKind.MUTEX && object.owner === thread;
                if (isSignalled(object) || mine)
                {
                    return { index: i, result: /** @type {number} */ (api.wait(object, thread)) };
                }
            }
            // Kept on the thread, because the answer to a wait on a set is the
            // index of the object that came -- and by the time one does, the
            // call that named the set has long since returned.
            thread.waitSet = { objects: objects_, all: false };
            thread.queuedOn = objects_;
            for (const object of objects_)
            {
                object.waiters.push(thread);
            }
            scheduler.block(thread, `any of ${describeSet(objects_)}`, timed);
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
            if (object.remote && remote)
            {
                remote.set(object.remote);
                return [];
            }
            object.signalled = true;
            const woken = [];
            if (object.manualReset)
            {
                for (let thread = releaseTo(object); thread; thread = releaseTo(object))
                {
                    woken.push(thread);
                }
            }
            else
            {
                const thread = releaseTo(object);
                if (thread)
                {
                    woken.push(thread);
                }
            }
            return woken;
        },

        /** @param {any} object */
        resetEvent(object){
            if (object.remote && remote)
            {
                remote.reset(object.remote);
                return;
            }
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
            if (object.remote && remote)
            {
                return remote.releaseMutex(object.remote, thread.id);
            }
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
            releaseTo(object);
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
                    releaseTo(object);
                }
            }
        },

        /**
         * @param {any} object
         * @param {number} [count]
         * @returns {number} the previous count
         */
        releaseSemaphore(object, count = 1){
            if (object.remote && remote)
            {
                return remote.release(object.remote, count);
            }
            if (object.count + count > object.maximum)
            {
                throw new Error('Semaphore released past its maximum');
            }
            const previous = object.count;
            object.count += count;
            while (object.count > 0 && releaseTo(object))
            {
                // Each release takes one count and one waiter, so this ends.
            }
            return previous;
        },

        /** The counts alone: what a snapshot taken often can afford. */
        summary(){
            return { objects: objects.length, ...created };
        },

        /**
         * One row per object ever created. A program makes thousands of these
         * and never lets one go, so this is asked for on purpose, not carried
         * in every snapshot.
         */
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

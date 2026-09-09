/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The async-call contract, as a value rather than a comment (§12.3).
 *
 * A host function that cannot answer yet -- it is waiting, or it has ended the
 * thread that called it -- must not return a number: the guest would take that
 * number as the answer. It has to park the caller instead, and the dispatcher
 * has to be told that it did.
 *
 * The token below is the telling. It is module-private and the only thing that
 * hands one out is `park()`, which parks for real before it does. So "returned
 * an asynchronous result without parking" is not something a handler can say --
 * not because a rule forbids it, but because there is no value to say it with.
 *
 * The same object also holds what is known about the call currently in flight,
 * because both parking and calling the guest back need it and neither should
 * have to be told twice.
 */

/** The one instance. Compared by identity, never by shape. */
const PARKED = Object.freeze({ parked: true });

/**
 * @param {any} value
 * @returns {boolean} whether a handler's return means "parked, no value yet"
 */
export function isParkedCall(value){
    return value === PARKED;
}

/**
 * @typedef {Object} CallFrame
 * @property {string} name
 * @property {number} freeStack     Below this is free to write while the stub still holds ESP.
 * @property {number} restingStack  Where the stack will be once the stub has returned.
 * @property {number} hostReturn    Where the stub was going to return to.
 * @property {any} [thread]        Whose call this is. Stamped when it begins.
 */

/**
 * @param {Object} deps
 * @param {any} deps.kernel  The kernel layer's API.
 */
export function createParking({ kernel }){
    // Depth rather than a flag: a guest callback can trap into another host
    // function, and that one is as much in flight as its caller.
    /** @type {CallFrame[]} */
    const inFlight = [];
    let parked = 0;

    return {
        /** @param {CallFrame} frame */
        beginCall(frame){
            // Whose stack this frame describes. Without it the frame is a
            // stack address with no owner, and a reader of `current()` cannot
            // tell its own thread's stack from somebody else's.
            frame.thread = kernel.currentThread();
            inFlight.push(frame);
        },
        endCall(){
            inFlight.pop();
        },

        /** @returns {CallFrame | null} the call being handled right now */
        current: ()=>inFlight.length > 0 ? inFlight[inFlight.length - 1] : null,

        /**
         * Where it is safe to write below, on a given thread's stack -- and
         * nothing at all when the call in flight is not that thread's.
         *
         * The distinction is the whole reason this exists. A handler that
         * awaits anything has already had its call ended, the loop has turned,
         * and the frame standing here belongs to whichever thread trapped
         * next. Its `freeStack` points into that thread's stack, and building a
         * callback frame there writes over another thread's live locals. The
         * damage is silent: the callback runs, returns, and the thread it
         * trampled fails much later at an address that holds no code.
         *
         * @param {any} thread
         * @returns {number | undefined}
         */
        freeStackFor(thread){
            const frame = inFlight.length > 0 ? inFlight[inFlight.length - 1] : null;
            return frame && frame.thread === thread ? frame.freeStack : undefined;
        },

        /** @returns {string[]} every call being handled, outermost first */
        chain: ()=>inFlight.map(frame=>frame.name),

        /**
         * Parks a thread and returns the token that says so.
         *
         * @param {any} [thread]  Defaults to the thread that is running.
         * @returns {Readonly<{ parked: true }>}
         */
        park(thread){
            if (inFlight.length === 0)
            {
                throw new Error(
                    'bridge: park() is only meaningful while a guest call is in flight');
            }
            kernel.parkThread(thread ?? kernel.currentThread());
            parked++;
            return PARKED;
        },

        diagnostics: ()=>({ parked }),
    };
}

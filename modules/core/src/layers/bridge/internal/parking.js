/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
 * @param {Object} deps
 * @param {any} deps.kernel  The kernel layer's API.
 */
export function createParking({ kernel }){
    // Parking rewrites the return address on the stack, which is only where the
    // parker thinks it is while a stub's trap is being handled. Depth rather
    // than a flag, because a handler may end up dispatching another call.
    let depth = 0;
    let parked = 0;

    return {
        beginCall(){
            depth++;
        },
        endCall(){
            depth--;
        },

        /**
         * Parks a thread and returns the token that says so.
         *
         * @param {any} [thread]  Defaults to the thread that is running.
         * @returns {Readonly<{ parked: true }>}
         */
        park(thread){
            if (depth === 0)
            {
                throw new Error('bridge: park() is only meaningful while a guest call is in flight');
            }
            kernel.parkThread(thread ?? kernel.currentThread());
            parked++;
            return PARKED;
        },

        diagnostics: ()=>({ parked }),
    };
}

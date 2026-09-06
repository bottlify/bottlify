/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { Convention, calleeCleanup } from './internal/conventions.js';
import { createParking } from './internal/parking.js';
import { createDispatcher } from './internal/dispatch.js';
import { createCallbacks } from './internal/callback.js';

/**
 * bridge — the boundary a call crosses in either direction.
 *
 * Above it, a host function is an ordinary function of numbers. Below it, a call
 * is a stub, a trap, a stack frame and a register that has to end up holding the
 * answer. Neither side is allowed to know the other's shape, which is the whole
 * point: `win32` describes what a function is without knowing how a guest
 * reaches it, and `cpu` emits the stub without knowing what it implements.
 */

/** @type {any} */
let dispatcher = null;
/** @type {any} */
let parking = null;
/** @type {any} */
let callbacks = null;
/** @type {Error | null} */
let failure = null;

export const bridgeModule = {
    name: 'bridge',
    version: '0.1.0',
    // memory as well as cpu: a call frame is read through the guest's own stack
    // pointer, and a wild ESP should fail against the region map rather than
    // quietly marshal whatever bytes happen to live there.
    requires: /** @type {readonly string[]} */ (['cpu', 'kernel', 'memory', 'log']),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const cpu = host.requireApi('cpu');
        const kernel = host.requireApi('kernel');
        const memory = host.requireApi('memory');

        failure = null;
        parking = createParking({ kernel });

        /**
         * @param {string} name
         * @param {number} popBytes
         * @param {object} [options]
         */
        const reserveTrap = (name, popBytes, options)=>
            cpu.registerTrap(name, popBytes, options);

        callbacks = createCallbacks({ cpu, kernel, memory, reserveTrap });

        /**
         * A handler that has not finished: the thread is stopped, and told where
         * to pick up its own code once the answer arrives.
         *
         * @param {Promise<number>} answer
         * @param {any} frame
         */
        const suspend = (answer, frame)=>{
            const thread = kernel.currentThread();
            // Where it returns to was read before the handler ran: a handler
            // that called the guest back has since written over that part of
            // the stack, so reading it now would find an argument.
            kernel.holdThread();
            callbacks.suspended(thread, {
                name: frame.name,
                restingStack: frame.restingStack,
                hostReturn: frame.hostReturn,
            });
            answer.then(
                value=>callbacks.finish(thread, value | 0),
                // Nothing above is waiting on this promise, so a handler that
                // throws would otherwise vanish and leave the guest parked
                // forever. Whoever is driving the machine asks for this.
                (/** @type {Error} */ error)=>{
                    failure ??= error;
                });
        };

        dispatcher = createDispatcher({ cpu, memory, parking, suspend });

        // Claimed here rather than by whoever assembles the process: a trap that
        // reached anything but the bridge would be a call nobody marshalled.
        cpu.onTrap((/** @type {number} */ id)=>{
            if (id === callbacks.sentinel())
            {
                // A guest callback has returned. Stop the thread before reading
                // its answer: the sentinel stub is about to `ret` into whatever
                // the callback left on the stack, which is not code.
                kernel.holdThread();
                callbacks.returned(kernel.currentThread());
                return;
            }
            dispatcher.dispatch(id);
        });

        return {
            Convention,

            /**
             * Makes a host function callable from guest code.
             *
             * @param {string} name        Which import this is, for diagnostics.
             * @param {Object} fn
             * @param {string} [fn.convention]
             * @param {number} fn.argBytes
             * @param {Function} fn.handler
             * @returns {number} the guest address that calls it
             */
            register(name, { convention = Convention.STDCALL, argBytes, handler }){
                // Before the first import, so the slot a callback returns to is
                // in the table that gets written into guest memory.
                callbacks.reserve();
                const { id, address } = cpu.registerTrap(
                    name, calleeCleanup(convention, argBytes));
                dispatcher.register(id, { name, convention, argBytes, handler });
                dispatcher.placed(address, name);
                return address;
            },

            /**
             * Parks the calling thread and returns the only value a handler may
             * return in place of an answer.
             *
             * @param {any} [thread]
             */
            park: thread=>parking.park(thread),

            /**
             * Calls a guest routine and resolves with what it returned.
             *
             * Only legal while a guest call is in flight: a thread has to be
             * stopped somewhere known before a frame can be built below it.
             * A handler that awaits this must return the promise, so the
             * dispatcher knows there is no answer yet.
             *
             * @param {Object} call
             * @param {number} call.entry
             * @param {number[]} [call.args]
             * @returns {Promise<number>}
             */
            callGuest({ entry, args = [] }){
                const frame = parking.current();
                return callbacks.call({
                    thread: kernel.currentThread(),
                    entry,
                    args,
                    stackAtRest: frame ? frame.freeStack : undefined,
                });
            },

            /**
             * An error thrown by a suspended handler, which nothing above was
             * waiting on. Null unless one happened.
             */
            failure: ()=>failure,

            /**
             * What is on our side of the boundary right now, for a failure
             * report: which host calls are in flight, what the guest has been
             * calling, and what name -- if any -- a guest address belongs to.
             */
            chain: ()=>[
                // Suspended first: a call waiting on a callback is the reason
                // the one running right now is running at all.
                ...callbacks.waiting(kernel.currentThread()),
                ...parking.chain(),
            ],
            /** @param {number} [count] */
            recent: (count = 12)=>dispatcher.recent(count),
            /** @param {number} address */
            symbolize: address=>dispatcher.symbolize(address),

            /** @param {number} id */
            dispatch: id=>dispatcher.dispatch(id),
            calls: ()=>dispatcher.calls(),
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'bridge',
            version: '0.1.0',
            status: dispatcher ? 'ready' : 'created',
            metrics: dispatcher
                ? {
                    ...dispatcher.diagnostics(),
                    ...parking.diagnostics(),
                    ...callbacks.diagnostics(),
                    failure: failure ? failure.message : null,
                }
                : {},
        };
    },

    async dispose(){
        dispatcher = null;
        parking = null;
        callbacks = null;
        failure = null;
    },
};

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { Convention, calleeCleanup } from './internal/conventions.js';
import { createParking } from './internal/parking.js';
import { createDispatcher } from './internal/dispatch.js';

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

        parking = createParking({ kernel });
        dispatcher = createDispatcher({ cpu, memory, parking });

        // Claimed here rather than by whoever assembles the process: a trap that
        // reached anything but the bridge would be a call nobody marshalled.
        cpu.onTrap((/** @type {number} */ id)=>dispatcher.dispatch(id));

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
                const { id, address } = cpu.registerTrap(
                    name, calleeCleanup(convention, argBytes));
                dispatcher.register(id, { name, convention, argBytes, handler });
                return address;
            },

            /**
             * Parks the calling thread and returns the only value a handler may
             * return in place of an answer.
             *
             * @param {any} [thread]
             */
            park: thread=>parking.park(thread),

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
                ? { ...dispatcher.diagnostics(), ...parking.diagnostics() }
                : {},
        };
    },

    async dispose(){
        dispatcher = null;
        parking = null;
    },
};

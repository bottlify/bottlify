/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createDirectInput, GUID_SysKeyboard, GUID_SysMouse } from './dinput/seam.js';

/**
 * input — the devices a program reads, and the one way events get in.
 *
 * There are two entirely separate paths a Win32 program can read input
 * through, and this layer owns one of them: DirectInput, which a program polls
 * or drains rather than waiting for. The other is the message queue, which
 * lives in `win32` because that is where `GetMessage` is. A program commonly
 * uses both -- the mouse through one, the keyboard through the other -- so
 * whoever is driving the machine feeds the same event to both, and neither
 * knows about the other.
 *
 * `post` is the whole input side of this module. Nothing here listens to a
 * browser, opens a device, or knows what a KeyboardEvent is: that belongs to
 * whoever assembled the process, and injecting it is what makes this testable
 * without one.
 */

/** @type {any} */
let current = null;

export const inputModule = {
    name: 'input',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['win32', 'bridge', 'memory']),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const memory = host.requireApi('memory');

        const dinput = createDirectInput({
            memory: {
                /** @param {number} address @param {number} length */
                readMemory: (address, length)=>memory.readBytes(address, length),
                /** @param {number} address @param {Uint8Array} bytes */
                writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
            },
            // The guest's clock, for the same reason the sound layer takes one:
            // an event timestamped from a second clock is one a program can
            // order wrongly against everything else it knows the time of.
            now: config?.now ?? (()=>Date.now()),
            publishInterface: config?.publishInterface ?? (()=>0),
            signal: config?.signal,
        });

        current = {
            /**
             * The libraries, keyed as an import descriptor names them. The
             * assembling caller merges these with win32's and hands the lot to
             * the loader.
             */
            libraries: ()=>dinput.libraries,

            /**
             * Feeds one event in. Returns false when nothing took it -- no
             * device created, or one that is not acquired -- which is a fact
             * worth having rather than a failure: it says the program is not
             * reading this device right now.
             *
             * @param {import('./dinput/devices.js').InputEvent} event
             */
            post: event=>dinput.post(event),

            /** @param {string} guid */
            device: guid=>dinput.device(guid),

            dinput: ()=>dinput,
        };
        return current;
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'input',
            version: '0.1.0',
            status: current ? 'ready' : 'created',
            metrics: {
                libraries: current ? Object.keys(current.libraries()) : [],
                ...(current ? current.dinput().diagnostics() : {}),
            },
        };
    },

    async dispose(){
        current = null;
    },
};

export { GUID_SysKeyboard, GUID_SysMouse };

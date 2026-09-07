/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDirectInput, GUID_SysKeyboard, GUID_SysMouse } from './dinput/seam.js';
import { createInputRouter } from './router.js';
import { createDomInput } from './dom.js';

/**
 * input -- the devices a program reads, and the one way events get in.
 *
 * There are two entirely separate paths a Win32 program can read input
 * through, and a program commonly uses both at once: the message queue, which
 * lives in `win32` because that is where `GetMessage` is, and DirectInput,
 * which a program polls or drains rather than waiting for. This layer owns the
 * second and posts into the first, so that one event reaches a program both
 * ways and the two readings cannot disagree.
 *
 * `send` is the whole input side of this module. What it takes is a normalised
 * event -- a physical key, a pointer motion, a button, a focus change -- and
 * nothing about it is a browser's: a page produces those events through
 * `attach`, a test produces them directly, and neither can tell the difference.
 */

/** @type {any} */
let current = null;

export const inputModule = {
    name: 'input',
    version: '0.2.0',
    requires: /** @type {readonly string[]} */ (['win32', 'bridge', 'memory']),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const memory = host.requireApi('memory');
        const win32 = host.requireApi('win32');

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

        // The queue is win32's, and this is the seam it exists for: a keystroke
        // is not a window operation, so it arrives from outside and is posted
        // like any other message.
        //
        // Asked for inside a guard because a build can be assembled without
        // win32, in which case this api is a stub whose every call throws. That
        // build has no windows to post to, so input degrades to DirectInput
        // alone -- which is what "degraded but not broken" means here.
        const queue = (()=>{
            try
            {
                return win32.queue();
            }
            catch {
                return null;
            }
        })();

        const router = createInputRouter({
            /** @param {any} message */
            post: message=>queue?.post(message),
            /** @param {import('./dinput/devices.js').InputEvent} event */
            device: event=>dinput.post(event),
            now: config?.now ?? (()=>Date.now()),
            // Which window input is for. Handed down because only whoever
            // assembled the process knows which one a person is looking at.
            target: config?.foreground ?? (()=>0),
            bounds: config?.bounds ?? null,
        });

        /** @type {ReturnType<typeof createDomInput> | null} */
        let attached = null;

        current = {
            /**
             * The libraries, keyed as an import descriptor names them. The
             * assembling caller merges these with win32's and hands the lot to
             * the loader.
             */
            libraries: ()=>dinput.libraries,

            /**
             * Feeds one host event in: it becomes a window message and a change
             * of DirectInput state, both or neither.
             *
             * @param {import('./router.js').HostInputEvent} event
             */
            send: event=>router.send(event),

            /**
             * Feeds one event straight to a DirectInput device, in that
             * device's own codes. Returns false when nothing took it -- no
             * device created, or one that is not acquired -- which is a fact
             * worth having rather than a failure: it says the program is not
             * reading this device right now.
             *
             * @param {import('./dinput/devices.js').InputEvent} event
             */
            post: event=>dinput.post(event),

            /**
             * Listens to a canvas. Only one at a time: two viewports feeding
             * one guest is two people playing one keyboard.
             *
             * @param {any} canvas
             * @param {{ pointerLock?: boolean }} [options]
             */
            attach(canvas, options){
                attached?.detach();
                attached = createDomInput({
                    canvas,
                    /** @param {import('./router.js').HostInputEvent} event */
                    send: event=>router.send(event),
                    pointerLock: options?.pointerLock ?? false,
                });
                return attached;
            },
            detach(){
                attached?.detach();
                attached = null;
            },

            /**
             * Reads whatever has no events of its own. A gamepad is a snapshot
             * API, so somebody has to ask; this is that call, and it does
             * nothing when no canvas is attached.
             */
            poll(){
                attached?.poll();
            },

            /** @param {number} vk */
            keyState: vk=>router.keyState(vk),
            cursor: ()=>router.cursor(),
            pad: ()=>router.pad(),

            /** @param {string} guid */
            device: guid=>dinput.device(guid),

            dinput: ()=>dinput,
            router: ()=>router,
        };
        return current;
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'input',
            version: '0.2.0',
            status: current ? 'ready' : 'created',
            metrics: {
                libraries: current ? Object.keys(current.libraries()) : [],
                ...(current ? current.dinput().diagnostics() : {}),
                ...(current ? current.router().diagnostics() : {}),
            },
        };
    },

    async dispose(){
        current?.detach();
        current = null;
    },
};

export { GUID_SysKeyboard, GUID_SysMouse };

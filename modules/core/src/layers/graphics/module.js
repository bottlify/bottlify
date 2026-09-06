/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createBackend } from './webgpu/backend.js';
import { createDirectDraw } from './ddraw/objects.js';
import { createDirect3D9 } from './d3d9/device.js';

/**
 * graphics — every drawing API a program might have been written against, over
 * one backend.
 *
 * The shape of this module follows from a fact about the work rather than a
 * preference: DirectDraw, Direct3D and OpenGL are separate APIs a program picks
 * between, and each is large. So each lives in its own directory, and this file
 * is only the place they are handed what they share -- the backend, the address
 * space, and the way a guest call reaches us. Nothing here implements anything.
 *
 * The backend is not created until someone asks for it. Building the module
 * graph must stay cheap and must not require a GPU: a build that never draws --
 * a console program, a test, an inspection of the configuration -- should not
 * pay for a device, and on a machine with no WebGPU at all it must still come
 * up rather than fail at assembly time.
 */

/** @type {any} */
let backend = null;
/** @type {any} */
let factories = null;
/** @type {string[]} */
let created = [];

export const graphicsModule = {
    name: 'graphics',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['win32', 'bridge', 'memory']),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const memory = host.requireApi('memory');
        backend = null;
        created = [];

        /**
         * The GPU, when there is one.
         *
         * Injected rather than discovered, for the same reason the filesystem's
         * stores are: this layer should be testable without a browser, and what
         * device to draw on is the assembling caller's decision, not ours.
         */
        const device = config?.device ?? null;

        /** Everything an API needs from outside itself, in one place. */
        const services = {
            /** @param {number} address @param {number} length */
            readMemory: (address, length)=>memory.readBytes(address, length),
            /** @param {number} address @param {Uint8Array} bytes */
            writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
            /** How many bytes a surface of this size needs. */
            allocate: (/** @type {number} */ bytes)=>new Uint8Array(bytes),
            screen: config?.screen ?? { width: 640, height: 480, bitsPerPixel: 32 },
        };

        factories = {
            /** @returns {any} */
            ddraw: (/** @type {any} */ options)=>createDirectDraw({
                ...services,
                screenWidth: services.screen.width,
                screenHeight: services.screen.height,
                ...options,
            }),
            /** @returns {any} */
            d3d9: (/** @type {any} */ caps)=>createDirect3D9(caps),
        };

        return {
            /**
             * The backend, built on first use.
             *
             * Throws rather than returning null when there is no device: a
             * caller that has got this far is about to draw, and a null here
             * would fail somewhere further away with less to say.
             */
            backend(){
                if (!backend)
                {
                    if (!device)
                    {
                        throw new Error(
                            'graphics: no GPU device was supplied to this build');
                    }
                    backend = createBackend({
                        device: device.device,
                        queue: device.queue,
                        presentTo: device.presentTo,
                    });
                }
                return backend;
            },

            /** Whether this build can draw at all. */
            available: ()=>device !== null,

            /**
             * Makes one of the APIs a program may have been written against.
             * Named rather than exported directly, so that adding one does not
             * change this module's shape.
             *
             * @param {string} api
             * @param {any} [options]
             */
            create(api, options){
                const factory = factories[api];
                if (!factory)
                {
                    throw new Error(`graphics: no such API "${api}"`);
                }
                created.push(api);
                return factory(options);
            },

            /** Which APIs this build can hand out. */
            apis: ()=>Object.keys(factories),
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'graphics',
            version: '0.1.0',
            status: factories ? 'ready' : 'created',
            metrics: {
                apis: factories ? Object.keys(factories) : [],
                // What a program actually asked for says more about a run than
                // what the build could have offered.
                created,
                backend: backend ? backend.diagnostics() : null,
            },
        };
    },

    async dispose(){
        if (backend)
        {
            backend.dispose();
        }
        backend = null;
        factories = null;
        created = [];
    },
};

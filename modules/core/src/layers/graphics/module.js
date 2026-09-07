/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createBackend } from './webgpu/backend.js';
import { createDirectDraw } from './ddraw/objects.js';
import { createDirect3D8 } from './d3d8/device.js';
import { createDirect3D9 } from './d3d9/device.js';
import { createGraphicsLibraries } from './seam/exports.js';

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
/** @type {any} */
let seam = null;

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
            // The backend draws but does not make samplers, so the device it
            // draws through is the one that hands it that ability. Asking for
            // the backend here is what builds it: a program reaching this call
            // is about to draw.
            /** @returns {any} */
            d3d8: (/** @type {any} */ caps)=>createDirect3D8({
                ...caps,
                backend: api.backend(),
                readMemory: services.readMemory,
                createSampler: (/** @type {any} */ descriptor)=>
                    device.device.createSampler(descriptor),
            }),
            /** @returns {any} */
            d3d9: (/** @type {any} */ caps)=>createDirect3D9(caps),
        };

        /**
         * The libraries a program links against to reach any of this.
         *
         * Built here rather than in the seam because it needs both halves: the
         * factories above, and the bridge's vtable publisher. Nothing is
         * created until a program calls one of these -- the tables are entry
         * points, not objects.
         */
        const api = {
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
             * @param {string} name
             * @param {any} [options]
             */
            create(name, options){
                const factory = factories[name];
                if (!factory)
                {
                    throw new Error(`graphics: no such API "${name}"`);
                }
                created.push(name);
                return factory(options);
            },

            /** Which APIs this build can hand out. */
            apis: ()=>Object.keys(factories),
        };

        seam = createGraphicsLibraries({
            graphics: api,
            memory: services,
            // Absent in a build with no bridge behind it -- a test, an
            // inspection -- which then gets tables that refuse rather than
            // tables that publish into nowhere.
            publishInterface: config?.publishInterface ?? (()=>0),
            screen: ()=>services.screen,
        });

        return {
            ...api,

            /**
             * The libraries, keyed as an import descriptor names them. The
             * assembling caller merges these with win32's and hands the lot to
             * the loader; nothing here needs a special case.
             */
            libraries: ()=>seam.libraries,
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
                // Which libraries a program can reach this layer through. It
                // exports its own, and anything counting what is synthesised
                // into guest memory has to include them.
                libraries: seam ? Object.keys(seam.libraries) : [],
                // What a program actually asked for says more about a run than
                // what the build could have offered.
                created,
                seam: seam ? seam.diagnostics() : null,
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
        seam = null;
        created = [];
    },
};

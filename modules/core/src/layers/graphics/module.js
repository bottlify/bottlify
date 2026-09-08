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
import { createPacer } from './webgpu/internal/pacer.js';
import { createPresenter } from './webgpu/internal/presenter.js';

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
/** @type {any} */
let presenter = null;
/** @type {any} */
let pacer = null;

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
        const win32 = host.requireApi('win32');
        const bridge = host.requireApi('bridge');
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
                // Where a locked surface or buffer's bytes live. It has to be
                // memory the guest can write through, because the unlock reads
                // back exactly what it wrote.
                allocate: config?.allocate,
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

        // Frames are paced only when the assembling caller has something to
        // pace them against: a clock and a way to be called at display rate.
        // A worker has no display of its own, so both arrive from whoever owns
        // the page, and a headless build keeps delivering on a microtask.
        //
        // What this buys is not throughput. A guest presents whenever its own
        // loop happens to finish, the display refreshes on its own schedule,
        // and without pacing the result stutters visibly while the average
        // frame rate looks healthy.
        pacer = config?.schedule && config?.now
            ? createPacer({ now: config.now, schedule: config.schedule })
            : null;

        // The backend is asked for on the first present rather than now, so a
        // build that never shows one of these surfaces never builds a GPU.
        presenter = createPresenter({
            backend: ()=>api.backend(),
            readMemory: services.readMemory,
            // The presenter still coalesces a burst of blits onto one flush;
            // the pacer only decides when that flush happens.
            schedule: pacer ? (/** @type {() => void} */ flush)=>pacer.request(flush) : undefined,
        });

        seam = createGraphicsLibraries({
            graphics: api,
            memory: services,
            // Absent in a build with no bridge behind it -- a test, an
            // inspection -- which then gets tables that refuse rather than
            // tables that publish into nowhere.
            publishInterface: config?.publishInterface ?? (()=>0),
            screen: ()=>services.screen,
            // What makes GetDC on a surface mean anything: gdi32 hands back a
            // context whose bitmap addresses the surface's own bytes, so a
            // program that gets a context and draws with GDI is drawing into
            // the surface rather than into a copy of it. Without this the
            // handle is one nothing else recognises.
            // Reached when a program asks rather than now: a build assembled
            // without win32 gets a stub, and a stub refuses -- which is the
            // right answer to GetDC and the wrong answer to starting up.
            gdi: {
                /** @param {any} attributes */
                createSurfaceDc: attributes=>win32.gdi().createSurfaceDc(attributes),
                /** @param {number} handle */
                deleteSurfaceDc: handle=>win32.gdi().deleteSurfaceDc(handle),
            },

            /** @param {any} surface */
            present: surface=>presenter.present(surface),

            // What a Direct3D 7 device draws with. Reached when a program
            // first asks its DirectDraw object for Direct3D, not now, so a
            // build that never gets there never builds a GPU.
            //
            // The presenter goes with it rather than only its `present`
            // function: a surface the GPU rendered into has nothing worth
            // reading in guest memory, so the device claims that address and
            // the presenter shows the texture instead of the stale bytes.
            render: ()=>({
                backend: device ? api.backend() : undefined,
                readMemory: services.readMemory,
                createSampler: device
                    ? (/** @type {any} */ descriptor)=>device.device.createSampler(descriptor)
                    : undefined,
                presenter,
            }),

            // Enumeration is the one thing here that runs guest code: the
            // program passes a function and expects to be called back once per
            // mode or surface, with a descriptor it can read for the duration
            // of the call.
            /** @param {any} call */
            callGuest: call=>bridge.callGuest(call),
            scratch: {
                /** @param {number} bytes */
                allocate: bytes=>win32.heap().allocate(bytes),
            },
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
                // Counted separately from the backend's own: a surface shown
                // through DirectDraw never enters a drawing pass, so nothing
                // in those numbers says whether anything reached the screen.
                presenter: presenter ? presenter.diagnostics() : null,
                // Absent in a build with no display to pace against.
                pacing: pacer ? pacer.diagnostics() : null,
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

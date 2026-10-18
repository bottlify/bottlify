/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What OpenGL's contexts are made by and swapped through, as one object: the
 * root a recording wraps when a context draws in the graphics worker
 * (`remote/opengl.js`), and what the exports use either way.
 *
 * Every context of a root draws through one renderer: `gpu.js` on a device,
 * the model (`gpu-model.js`) on the side whose twin draws, or none, and then
 * the processor draws.
 */

import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createModelRenderer } from './gpu-model.js';

/**
 * @typedef {Object} OpenglRootServices
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, length: number) => Uint8Array} [windowMemory]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {(bytes: number) => number} [allocate]  guest memory a mapped buffer is put in
 * @property {() => any} [backend]  with `createSampler`, a device every context draws on
 * @property {(descriptor: any) => any} [createSampler]
 * @property {boolean} [model]  the renderer only keeps state: a twin elsewhere draws
 * @property {import('../webgpu/internal/latency.js').FrameQueued} [frameQueued]
 * @property {(detail: string) => void} [divergence]
 * @property {boolean} [raster]
 * @property {boolean} [keepPrimitives]
 * @property {boolean} [compressedTextures]
 * @property {boolean} [dumpDraws]
 * @property {number} [maxDraws]
 * @property {string | null} [skipTexture]
 * @property {string | null} [probeTexture]
 * @property {import('./gpu.js').GpuServices['liveDump']} [liveDump]
 */

/**
 * @param {OpenglRootServices} services
 */
export function createOpenglRoot(services){
    /** @type {import('./kernel.js').ContextMemory | undefined} */
    const memory = services.readMemory && services.writeMemory
        ? {
            read: services.readMemory,
            window: services.windowMemory,
            write: services.writeMemory,
            allocate: services.allocate,
        }
        : undefined;

    /**
     * The renderer, made when the first context is: a program that never
     * makes one never builds a GPU.
     *
     * @type {any}
     */
    let gpu;
    const renderer = ()=>{
        if (gpu === undefined)
        {
            if (services.model)
            {
                gpu = createModelRenderer();
            }
            else if (services.backend && services.createSampler)
            {
                gpu = createGpuRenderer({
                    backend: services.backend(),
                    createSampler: services.createSampler,
                    divergence: services.divergence,
                    dumpDraws: services.dumpDraws,
                    maxDraws: services.maxDraws,
                    skipTexture: services.skipTexture,
                    probeTexture: services.probeTexture,
                    compressedTextures: services.compressedTextures,
                    liveDump: services.liveDump,
                });
            }
            else
            {
                gpu = null;
            }
        }
        return gpu;
    };

    return {
        /**
         * @param {{ extensions?: readonly string[] }} options
         */
        CreateContext(options){
            return createGlContext({
                extensions: options.extensions,
                memory,
                divergence: services.divergence,
                gpu: renderer() ?? undefined,
                raster: services.raster,
                keepPrimitives: services.keepPrimitives,
            });
        },

        /**
         * The frame drawn since the context's last swap is shown, and the
         * next one is drawn into the other buffer.
         *
         * @param {any} context
         * @returns {{ width: number, height: number } | null}  the frame's size, or
         *     null when the context has no drawable on a device
         */
        Swap(context){
            return renderer()?.present(context) ?? null;
        },

        /**
         * What a swap waits on before it answers the program: the frames
         * queued so far, as `frameQueued` paces them. Asked after `Swap`.
         *
         * @returns {Promise<void> | null}
         */
        Present(){
            const settled = renderer()?.settled();
            return settled ? services.frameQueued?.(settled) ?? null : null;
        },

        diagnostics: ()=>renderer()?.diagnostics() ?? null,
    };
}

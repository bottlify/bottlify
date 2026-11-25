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

/** Swaps between two looks for texels no draw has needed (`spill`): about a second at 60. */
const SPILL_SWAPS = 60;

/**
 * @typedef {Object} OpenglRootServices
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, length: number) => Uint8Array} [windowMemory]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {(bytes: number) => number} [allocate]  guest memory a mapped buffer is put in
 * @property {(address: number) => void} [free]  gives a mapped buffer's memory back
 * @property {() => any} [backend]  with `createSampler`, a device every context draws on
 * @property {(descriptor: any) => any} [createSampler]
 * @property {boolean} [model]  the renderer only keeps state: a twin elsewhere draws
 * @property {import('../webgpu/internal/latency.js').FrameQueued} [frameQueued]
 * @property {(detail: string, severity?: 'loss') => void} [divergence]
 * @property {boolean} [raster]
 * @property {boolean} [keepPrimitives]
 * @property {boolean} [compressedTextures]
 * @property {boolean} [astcTextures]
 * @property {import('./gpu.js').GpuServices['texelCache']} [texelCache]
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
            free: services.free,
        }
        : undefined;

    /**
     * The renderer, made when the first context is: a program that never
     * makes one never builds a GPU.
     *
     * @type {any}
     */
    let gpu;
    /** The share groups of the contexts made here, whose textures the diagnostics count. */
    const groups = new Set();
    let swaps = 0;
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
                    astcTextures: services.astcTextures,
                    liveDump: services.liveDump,
                    texelCache: services.texelCache,
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
         * @param {{ extensions?: readonly string[], processor?: boolean,
         *     version?: import('./version.js').ContextVersion }} options
         *     `processor`: the context draws on the processor whatever the
         *     root has, as the generic renderer of a memory DC does.
         */
        CreateContext(options){
            const context = createGlContext({
                extensions: options.extensions,
                version: options.version,
                memory,
                divergence: services.divergence,
                gpu: options.processor ? undefined : renderer() ?? undefined,
                // A model's twin draws, and is sent each level's data with
                // the call that gives it: kept here as well, every texture a
                // program loaded was held twice (the Doom 3 demo's first
                // level: 161 MB of texels and 47 MB of blocks on the engine's
                // thread).
                keepTexels: !services.model,
                raster: services.raster,
                keepPrimitives: services.keepPrimitives,
            });
            groups.add(context.shareGroup);
            return context;
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
            const shown = renderer()?.present(context) ?? null;
            // Now and then, what the contexts' textures hold that no draw has
            // needed goes to the run's cache (`spill`).
            if (++swaps % SPILL_SWAPS === 0 && typeof gpu?.spill === 'function')
            {
                gpu.spill([...groups].flatMap(group=>[...group.textures.objects.values()]));
            }
            return shown;
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

        diagnostics: ()=>{
            const figures = renderer()?.diagnostics() ?? null;
            if (figures === null || typeof gpu?.heldTexels !== 'function')
            {
                return figures;
            }
            // What the contexts' textures still hold beside the device's copy.
            const all = [...groups].flatMap(group=>[...group.textures.objects.values()]);
            return { ...figures, heldTexels: gpu.heldTexels(all) };
        },
    };
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { LockFlags, createDynamicBuffer } from './internal/buffers.js';
import { createBindingCache, createUniformPool } from './internal/bindings.js';
import { createProfiler } from './internal/profiler.js';
import { createShaderCache } from './internal/shaders.js';
import { createTextureUploader } from './internal/textures.js';
import { fullTarget, viewportState } from './internal/viewport.js';
import { createPipelineCache, pipelineDescriptor } from './internal/pipeline.js';
import { generateFixedFunction } from './internal/fixedfunction.js';
import { decodeFvf } from './internal/vertexformat.js';

/**
 * The rendering backend every guest-facing graphics API sits on.
 *
 * The device and the queue arrive injected and nothing here reads a global, so
 * the whole thing runs in a test against a recording double. See `contract.js`
 * for the semantics; the shapes of the failures each part guards against are
 * documented where the guard lives.
 *
 * The frame is the important structure. A frame owns the only command encoder,
 * and ending it is the only path to `queue.submit` -- there is no submit on the
 * backend, on the frame, or on a pass, so submitting twice in a frame is not
 * something a caller can express by mistake. Switching render targets opens a
 * new pass on that same encoder.
 */

/** WebGPU's `GPUBufferUsage` bits, spelled out so nothing here reads a global. */
const BufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
};

/** `GPUTextureUsage` bits, likewise. */
const TextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
};

/**
 * Clearing a render-target chain to a transparent black loses contribution on
 * every hop when the result is alpha-blended again on sampling, and the blend
 * arithmetic stays perfectly correct while the image fades to nothing. Opaque
 * is therefore the default; a transparent clear has to be asked for by name.
 */
const OPAQUE_BLACK = { r: 0, g: 0, b: 0, a: 1 };

/**
 * @param {import('./contract.js').BackendOptions} options
 * @returns {any}
 */
export function createBackend(options){
    const { device, queue, presentTo } = options;
    const now = options.now === undefined ? ()=>performance.now() : options.now;
    const profiler = createProfiler({ now, frameHistory: options.frameHistory });
    const shaders = createShaderCache({ device });
    const uniforms = createUniformPool({
        device,
        queue,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });

    /**
     * A pipeline per distinct state, built once.
     *
     * The layout is explicit and shared: every fixed-function shader declares
     * the same uniform block at binding zero and its textures from binding one
     * upward, so a layout per stage count is all that is needed, and an
     * automatic layout -- which drops a binding the generated shader happened
     * not to use -- is never reached.
     */
    /** @type {Map<number, any>} */
    const fixedFunctionLayouts = new Map();

    /** @param {number} stageCount */
    const layoutForStages = stageCount=>{
        const existing = fixedFunctionLayouts.get(stageCount);
        if (existing)
        {
            return existing;
        }
        /** @type {any[]} */
        const entries = [
            { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
        ];
        for (let index = 0; index < stageCount; index++)
        {
            entries.push({ binding: 1 + index * 2, visibility: 2, texture: {} });
            entries.push({ binding: 2 + index * 2, visibility: 2, sampler: {} });
        }
        const group = device.createBindGroupLayout({
            label: `fixed-function:${stageCount}`,
            entries,
        });
        const made = {
            group,
            pipeline: device.createPipelineLayout({
                label: `fixed-function:${stageCount}`,
                bindGroupLayouts: [group],
            }),
        };
        fixedFunctionLayouts.set(stageCount, made);
        return made;
    };

    const pipelines = createPipelineCache({
        build: async state=>{
            // A vertex shader means the caller owns the module; fixed function
            // means this builds one from the state, which is the only reason
            // the vertex format has to be decoded here at all.
            if (state.vertexShader !== 0)
            {
                throw new Error(
                    'A bound vertex shader must be translated before it reaches the backend');
            }
            const layout = decodeFvf(state.fvf);
            const generated = generateFixedFunction(state, layout);
            const module = await shaders.build(generated);
            const descriptor = pipelineDescriptor(state, layout);
            const layouts = layoutForStages(state.stages.length);

            return {
                bindGroupLayout: layouts.group,
                vertexLayout: layout,
                gpu: device.createRenderPipeline({
                    label: generated.label,
                    layout: layouts.pipeline,
                    vertex: {
                        module,
                        entryPoint: 'vertexMain',
                        buffers: [descriptor.vertexLayout],
                    },
                    fragment: {
                        module,
                        entryPoint: 'fragmentMain',
                        targets: [descriptor.target],
                    },
                    primitive: descriptor.primitive,
                    depthStencil: descriptor.depthStencil,
                    multisample: descriptor.multisample,
                }),
            };
        },
    });

    /** @type {any[]} */
    const dynamicBuffers = [];
    /** @type {any[]} */
    const pendingCopies = [];
    /** @type {any} */
    let openFrame = null;
    /** @type {any} */
    let lastPresented = null;
    let frameIndex = 0;

    const uploadTexture = createTextureUploader({
        device,
        queue,
        stagingUsage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
        onUpload: record=>profiler.textureUpload(record),
        // A copy needs an encoder, and there is only ever the frame's. An upload
        // issued while a frame is open joins it; one issued between frames waits
        // for the next encoder rather than opening a second one.
        encodeCopy: (source, destination, size)=>{
            if (openFrame && !openFrame.ended)
            {
                openFrame.encodeCopy(source, destination, size);
                return;
            }
            pendingCopies.push({ source, destination, size });
        },
    });

    /**
     * @param {any} descriptor
     * @returns {import('./contract.js').Surface}
     */
    const createSurface = descriptor=>{
        const label = descriptor.label === undefined ? 'surface' : descriptor.label;
        const texture = device.createTexture({
            label,
            size: {
                width: descriptor.width,
                height: descriptor.height,
                depthOrArrayLayers: 1,
            },
            format: descriptor.format,
            usage: descriptor.usage === undefined
                ? TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                    | TextureUsage.COPY_SRC
                : descriptor.usage,
        });
        profiler.count('surfacesCreated');
        return {
            texture,
            view: texture.createView({ label }),
            width: descriptor.width,
            height: descriptor.height,
            format: descriptor.format,
            label,
        };
    };

    /**
     * @param {any} encoder
     * @param {any} descriptor
     * @returns {any}
     */
    function beginPass(encoder, descriptor){
        const target = descriptor.target;
        const attachment = {
            view: target.view,
            loadOp: descriptor.clear ? 'clear' : 'load',
            storeOp: 'store',
            clearValue: descriptor.clearValue === undefined ? OPAQUE_BLACK : descriptor.clearValue,
        };
        const raw = encoder.beginRenderPass({
            label: descriptor.label === undefined ? `pass:${target.label}` : descriptor.label,
            colorAttachments: [attachment],
            depthStencilAttachment: descriptor.depthStencilAttachment,
        });
        // Fresh per pass, and unreachable afterwards: a group cached in one pass
        // and rebound in the next silently stops drawing, with no error raised.
        const cache = createBindingCache({ device });
        profiler.count('passes');

        /** @type {any} */
        let viewport = null;
        /** @type {any} */
        let pipeline = null;

        const pass = {
            target,
            get viewport(){
                return viewport;
            },

            /** @param {import('./contract.js').ViewportRect} rect */
            setViewport(rect){
                viewport = viewportState(rect);
                raw.setViewport(viewport.rect.x, viewport.rect.y,
                    viewport.rect.width, viewport.rect.height,
                    viewport.rect.minDepth, viewport.rect.maxDepth);
                raw.setScissorRect(viewport.rect.x, viewport.rect.y,
                    viewport.rect.width, viewport.rect.height);
                return viewport;
            },

            /** @param {{ x: number, y: number, width: number, height: number }} rect */
            setScissor(rect){
                raw.setScissorRect(rect.x, rect.y, rect.width, rect.height);
            },

            /** @param {any} next */
            setPipeline(next){
                if (next === pipeline)
                {
                    return;
                }
                pipeline = next;
                raw.setPipeline(next);
            },

            /**
             * @param {number} index
             * @param {any} layout an explicit bind-group layout
             * @param {any[]} entries
             * @param {string} [label]
             */
            setBindings(index, layout, entries, label){
                const before = cache.stats();
                const group = cache.get(layout, entries, label);
                const after = cache.stats();
                profiler.count(after.created > before.created
                    ? 'bindGroupsCreated'
                    : 'bindGroupsReused');
                raw.setBindGroup(index, group);
                return group;
            },

            /**
             * A uniform block for one draw. Each call gets its own buffer: one
             * buffer rewritten between draws shows every draw in the pass the
             * last write, and the draws render, with the wrong values.
             *
             * @param {ArrayBufferView} block
             */
            uniforms(block){
                profiler.count('uniformBlocks');
                return uniforms.allocate(block);
            },

            /** @param {number} slot @param {any} buffer @param {number} [offset] */
            setVertexBuffer(slot, buffer, offset = 0){
                raw.setVertexBuffer(slot, buffer.gpu === undefined ? buffer : buffer.gpu, offset);
            },

            /** @param {any} buffer @param {string} format @param {number} [offset] */
            setIndexBuffer(buffer, format, offset = 0){
                raw.setIndexBuffer(buffer.gpu === undefined ? buffer : buffer.gpu, format, offset);
            },

            /** @param {number[]} args */
            draw(...args){
                profiler.count('draws');
                raw.draw(...args);
            },

            /** @param {number[]} args */
            drawIndexed(...args){
                profiler.count('draws');
                raw.drawIndexed(...args);
            },

            end(){
                raw.end();
            },
        };

        // A successful target change resets both halves of the viewport to the
        // new target, so a small viewport left over from a downscale pass cannot
        // stay latched on the passes that follow it.
        pass.setViewport(fullTarget(target).rect);
        return pass;
    }

    return {
        LockFlags,
        BufferUsage,
        TextureUsage,
        createSurface,

        /**
         * @param {any} descriptor
         * @returns {any}
         */
        createSwapChain(descriptor){
            const count = descriptor.count === undefined ? 2 : descriptor.count;
            /** @type {import('./contract.js').Surface[]} */
            const surfaces = [];
            for (let index = 0; index < count; index++)
            {
                surfaces.push(createSurface({
                    ...descriptor,
                    label: `${descriptor.label === undefined ? 'swapchain' : descriptor.label}`
                        + `[${index}]`,
                }));
            }
            let next = 0;
            return {
                surfaces,
                acquire(){
                    const surface = surfaces[next];
                    next = (next + 1) % surfaces.length;
                    return surface;
                },
            };
        },

        /**
         * @param {any} descriptor
         * @returns {any}
         */
        createDynamicBuffer(descriptor){
            const buffer = createDynamicBuffer({
                device,
                queue,
                ...descriptor,
                onUpload: (label, bytes)=>profiler.bufferUpload(label, bytes),
            });
            dynamicBuffers.push(buffer);
            return buffer;
        },

        /** @param {any} descriptor */
        createBindGroupLayout(descriptor){
            return device.createBindGroupLayout(descriptor);
        },

        /** @param {any} descriptor */
        createPipelineLayout(descriptor){
            return device.createPipelineLayout(descriptor);
        },

        /**
         * An automatic layout drops a binding the generated shader did not use;
         * the group then fails validation and every draw that needed it silently
         * disappears. The layout is required, and 'auto' is refused by name.
         *
         * @param {any} descriptor
         */
        createRenderPipeline(descriptor){
            if (!descriptor.layout || typeof descriptor.layout !== 'object')
            {
                throw new Error('A render pipeline needs an explicit pipeline layout');
            }
            return device.createRenderPipeline(descriptor);
        },

        /** @param {{ code: string, label?: string }} request */
        createShaderModule(request){
            return shaders.build(request);
        },

        /**
         * The pipeline a draw's state describes, built once per distinct state.
         *
         * Asynchronous because compiling the shader is, and a caller has to
         * await it before the draw -- which is the one place the cost of this
         * design shows. Two draws with the same state in one frame share the
         * promise rather than compiling twice.
         *
         * @param {import('./internal/pipeline.js').PipelineState} state
         * @returns {Promise<any>}
         */
        pipelineFor(state){
            return pipelines.get(state);
        },

        uploadTexture,

        /**
         * @returns {any} the frame, which owns the only encoder there will be
         */
        beginFrame(){
            if (openFrame && !openFrame.ended)
            {
                throw new Error('A frame is already open');
            }
            profiler.beginFrame();
            const encoder = device.createCommandEncoder({ label: `frame#${frameIndex}` });
            /** @type {any} */
            let currentPass = null;
            /** @type {any} */
            let presenting = null;
            const index = frameIndex++;

            const endUploads = profiler.phase('uploads');
            while (pendingCopies.length > 0)
            {
                const copy = pendingCopies.shift();
                encoder.copyBufferToTexture(copy.source, copy.destination, copy.size);
            }
            endUploads();

            const closeCurrentPass = ()=>{
                if (!currentPass)
                {
                    return;
                }
                currentPass.end();
                currentPass = null;
            };

            const frame = {
                index,
                ended: false,

                /** @param {any} source @param {any} destination @param {any} size */
                encodeCopy(source, destination, size){
                    // A copy cannot be recorded inside a render pass, and the
                    // encoder is shared, so an upload mid-frame closes the pass
                    // it interrupted rather than corrupting the recording.
                    closeCurrentPass();
                    encoder.copyBufferToTexture(source, destination, size);
                },

                /** @param {any} descriptor @returns {any} */
                beginPass(descriptor){
                    if (frame.ended)
                    {
                        throw new Error('This frame has already ended');
                    }
                    closeCurrentPass();
                    const endPhase = profiler.phase('passes');
                    currentPass = beginPass(encoder, descriptor);
                    endPhase();
                    return currentPass;
                },

                /** @param {import('./contract.js').Surface} surface */
                present(surface){
                    if (frame.ended)
                    {
                        throw new Error('This frame has already ended');
                    }
                    presenting = surface;
                },

                /**
                 * The one path to the queue. Everything dirty is uploaded, the
                 * encoder is finished, and the result is submitted exactly once.
                 */
                end(){
                    if (frame.ended)
                    {
                        throw new Error('This frame has already ended');
                    }
                    frame.ended = true;
                    closeCurrentPass();

                    const endUpload = profiler.phase('uploads');
                    for (const buffer of dynamicBuffers)
                    {
                        buffer.flush();
                    }
                    endUpload();

                    const endSubmit = profiler.phase('submit');
                    queue.submit([encoder.finish()]);
                    profiler.count('submits');
                    endSubmit();

                    for (const buffer of dynamicBuffers)
                    {
                        buffer.endFrame();
                    }
                    uniforms.endFrame();

                    if (presenting)
                    {
                        const endPresent = profiler.phase('present');
                        lastPresented = { surface: presenting, frameIndex: index };
                        profiler.count('presents');
                        presentTo(lastPresented);
                        endPresent();
                    }
                    profiler.endFrame();
                    openFrame = null;
                },
            };

            openFrame = frame;
            return frame;
        },

        /**
         * Exactly the object the last frame handed to `presentTo`. A diagnostic
         * read-back that copies a render target directly bypasses the
         * composition the user actually sees and can report a black frame while
         * the canvas shows a correct one, so there is one frame to read and this
         * is it.
         *
         * @returns {import('./contract.js').PresentedFrame | null}
         */
        lastPresented(){
            return lastPresented;
        },

        /** @returns {any} */
        diagnostics(){
            const snapshot = profiler.snapshot();
            return {
                ...snapshot,
                shaders: shaders.stats(),
                shaderMessages: shaders.messages(),
                pipelines: pipelines.stats(),
                uniforms: uniforms.stats(),
                buffers: dynamicBuffers.map(buffer=>buffer.diagnostics()),
                frameOpen: !!(openFrame && !openFrame.ended),
                pendingTextureCopies: pendingCopies.length,
            };
        },

        dispose(){
            dynamicBuffers.length = 0;
            pendingCopies.length = 0;
            pipelines.clear();
            fixedFunctionLayouts.clear();
            openFrame = null;
            lastPresented = null;
        },
    };
}

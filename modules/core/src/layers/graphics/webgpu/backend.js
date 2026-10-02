/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { LockFlags, carriedRanges, createDynamicBuffer } from './internal/buffers.js';
import { createBindingCache, createUniformPool, dynamicOffsetsOf } from './internal/bindings.js';
import { ABSENT_PROFILER, createProfiler } from './internal/profiler.js';
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
    QUERY_RESOLVE: 0x0200,
};

/** The most occlusion queries a frame counts: WebGPU's own limit on one set. */
const OCCLUSION_CAPACITY = 4096;

/** `GPUMapMode` bits, likewise. */
const MapMode = {
    READ: 0x0001,
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
 * Whether a group's dynamic offsets are the ones it is bound at.
 *
 * @param {number[]} held @param {number[] | undefined} offsets
 */
function sameOffsets(held, offsets){
    if (!offsets)
    {
        return held.length === 0;
    }
    if (held.length !== offsets.length)
    {
        return false;
    }
    for (let at = 0; at < held.length; at++)
    {
        if (held[at] !== offsets[at])
        {
            return false;
        }
    }
    return true;
}

/**
 * @param {import('./contract.js').BackendOptions} options
 * @returns {any}
 */
export function createBackend(options){
    const { device, queue, presentTo } = options;
    const now = import.meta.BOTTLIFY_DIAGNOSTICS === false ? ()=>0
        : options.now === undefined ? ()=>performance.now() : options.now;
    // A measurement nothing draws by, left out of a production bundle.
    const profiler = import.meta.BOTTLIFY_DIAGNOSTICS !== false
        ? createProfiler({ now, frameHistory: options.frameHistory }) : ABSENT_PROFILER;
    const shaders = createShaderCache({ device });
    const uniforms = createUniformPool({
        device,
        queue,
        // Readable back, so a frame's dump can compare the block a draw was
        // shaded with against the one recorded for it; the flag costs nothing.
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    });
    // For the backend's life: a group names a layout, a texture view, a
    // sampler and the uniform ring, none of which changes per draw, so the
    // same group serves the same draw in every frame. A group per draw per
    // frame was a descriptor churn the device did not always keep up with.
    const cache = createBindingCache({ device });
    /** The dynamic offsets of the group being bound, handed on at once. @type {number[]} */
    const bindOffsets = [];

    /**
     * A pipeline per distinct state, built once.
     *
     * The layout is explicit and shared: every fixed-function shader declares
     * the same uniform block at binding zero and its textures from binding one
     * upward, so a layout per stage count is all that is needed, and an
     * automatic layout -- which drops a binding the generated shader happened
     * not to use -- is never reached.
     */
    /** @type {Map<string, any>} */
    const fixedFunctionLayouts = new Map();

    /**
     * @param {readonly string[]} dimensions  Each stage's texture: '2d', 'cube' or '3d'.
     *     A binding of one kind does not take a view of another.
     */
    const layoutForStages = dimensions=>{
        const key = dimensions.join(',');
        const stageCount = dimensions.length;
        const existing = fixedFunctionLayouts.get(key);
        if (existing)
        {
            return existing;
        }
        /** @type {any[]} */
        const entries = [
            // The block is bound at a dynamic offset into the uniform ring,
            // so the group that carries it never names a per-draw buffer.
            { binding: 0, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } },
        ];
        for (let index = 0; index < stageCount; index++)
        {
            entries.push({ binding: 1 + index * 2, visibility: 2,
                texture: dimensions[index] === '2d' ? {} : { viewDimension: dimensions[index] } });
            entries.push({ binding: 2 + index * 2, visibility: 2, sampler: {} });
        }
        const group = device.createBindGroupLayout({
            label: `fixed-function:${key}`,
            entries,
        });
        const made = {
            group,
            pipeline: device.createPipelineLayout({
                label: `fixed-function:${key}`,
                bindGroupLayouts: [group],
            }),
        };
        fixedFunctionLayouts.set(key, made);
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
            const layout = state.vertexLayout ?? decodeFvf(state.fvf);
            const generated = generateFixedFunction(state, layout);
            const module = await shaders.build(generated);
            const descriptor = pipelineDescriptor(state, layout);
            const layouts = layoutForStages(
                state.stages.map(stage=>stage.dimension ?? '2d'));

            return {
                bindGroupLayout: layouts.group,
                vertexLayout: layout,
                gpu: await device.createRenderPipelineAsync({
                    label: generated.label,
                    layout: layouts.pipeline,
                    vertex: {
                        module,
                        entryPoint: 'vertexMain',
                        buffers: descriptor.vertexBuffers,
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

    /** @type {Set<any>} */
    const dynamicBuffers = new Set();
    /** Backings of released buffers, each destroyed once its frame is submitted.
     * @type {{ gpu: any, at: number }[]} */
    const dying = [];
    // The frames presented and submitted, one count for every dynamic buffer,
    // and the buffers with work at the frame's end: a run makes a buffer for
    // every buffer object it ever creates, and a frame that visited them all
    // three times at its end -- to flush, to count the present, to free the
    // backings retired -- spent its time on buffers it never touched.
    const frameCounts = { presents: 0, submits: 0 };
    /** @type {Set<any>} */
    const touchedBuffers = new Set();
    const touched = (/** @type {any} */ buffer)=>{
        touchedBuffers.add(buffer);
    };
    /** Renames' carries waiting for the frame's end. @type {import('./internal/buffers.js').Carry[]} */
    const carries = [];
    /** @type {any[]} */
    const pendingCopies = [];
    /**
     * When each surface was last written, and when each frame was presented.
     *
     * A presented surface is not copied by the page instantly, and the frame
     * after it draws into the same texture -- with one back buffer, literally
     * the same one. If a write to that surface is submitted before the page has
     * copied it, what reaches the canvas is the next frame's cleared target
     * rather than the frame that was presented, which is a dark frame with a
     * perfectly correct draw record. Nothing else in this layer can see that,
     * because everything else is right.
     *
     * @type {{ index: number, label: string, at: number }[]}
     */
    const surfaceWrites = [];
    /** @type {{ index: number, label: string, at: number }[]} */
    const presentLog = [];
    const RING = 600;
    /** @param {{ index: number, label: string, at: number }[]} ring @param {any} entry */
    const remember = (ring, entry)=>{
        ring.push(entry);
        if (ring.length > RING)
        {
            ring.shift();
        }
    };
    /** @type {any} */
    let openFrame = null;
    /** @type {any} */
    let lastPresented = null;
    let frameIndex = 0;
    /**
     * The staging buffer of the last snapshot to finish, kept for the next
     * one of the same size. A program that reads its target back every frame
     * would otherwise allocate and free a surface's worth of mappable memory
     * every frame; a second snapshot in flight while this one is busy gets a
     * buffer of its own, and whichever finishes second gives its buffer up.
     *
     * @type {{ buffer: any, size: number } | null}
     */
    let spareStaging = null;
    // Read by a snapshot that is still in flight when `dispose()` runs: its
    // buffer must be destroyed on arrival rather than parked into
    // `spareStaging`, which nothing will ever drain again.
    let disposed = false;

    const uploadTexture = createTextureUploader({
        device,
        queue,
        stagingUsage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
        onUpload: record=>profiler.textureUpload(record),
        // A copy needs an encoder, and there is only ever the frame's. An upload
        // issued while a frame is open joins it; one issued between frames waits
        // for the next encoder rather than opening a second one. Either way the
        // staging buffer the copy reads from is only safe to destroy once the
        // frame that encoded the copy has been submitted, so it is tracked on
        // that frame (`frame.stagingBuffers`) rather than here.
        encodeCopy: (source, destination, size)=>{
            if (openFrame && !openFrame.ended)
            {
                openFrame.encodeCopy(source, destination, size);
                openFrame.stagingBuffers.push(source.buffer);
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
        const mipLevelCount = descriptor.mipLevelCount === undefined ? 1 : descriptor.mipLevelCount;
        // A cube map is six layers of one texture and a view that says so; a
        // sampler given a plain 2D view of it reads one face and the shader
        // that declared a cube fails to bind. A volume is a texture of three
        // dimensions, its depth where the layers would be.
        const volume = descriptor.dimension === '3d';
        const layers = volume
            ? descriptor.depth ?? 1
            : descriptor.layers === undefined ? 1 : descriptor.layers;
        const texture = device.createTexture({
            label,
            ...(volume ? { dimension: '3d' } : {}),
            size: {
                width: descriptor.width,
                height: descriptor.height,
                depthOrArrayLayers: layers,
            },
            // The whole chain a program supplies, so a sampler can filter
            // between levels: a far surface sampled from its top level alone
            // aliases, and aliasing moves with every fraction of a texel the
            // camera moves.
            mipLevelCount,
            format: descriptor.format,
            usage: descriptor.usage === undefined
                ? TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                    | TextureUsage.COPY_SRC
                : descriptor.usage,
        });
        profiler.count('surfacesCreated');
        return {
            texture,
            view: texture.createView(descriptor.dimension === undefined
                ? { label }
                : { label, dimension: descriptor.dimension }),
            width: descriptor.width,
            height: descriptor.height,
            format: descriptor.format,
            mipLevelCount,
            layers,
            label,
        };
    };

    /**
     * The colour attachments a pass descriptor names. One `target` is the
     * common case; `targets` lists several by location, a null leaving that
     * location empty, with `clearValues` saying per target whether it is
     * cleared, and to what. A pass with no colour target at all draws depth
     * alone and takes its size from `depthTarget`.
     *
     * @param {any} descriptor
     * @returns {{ sizing: any, attachments: any[] }}
     */
    const colourAttachmentsOf = descriptor=>{
        /** @type {any[]} */
        const targets = descriptor.targets ?? [descriptor.target];
        const present = targets.filter(target=>target);
        const sizing = present[0] ?? descriptor.depthTarget;
        if (!sizing)
        {
            throw new Error('A pass with no target cannot be sized');
        }
        if (present.some(target=>target.width !== sizing.width
            || target.height !== sizing.height))
        {
            throw new Error('The colour targets of one pass must be one size');
        }
        const attachments = targets.map((target, index)=>{
            if (!target)
            {
                return null;
            }
            const clearValue = descriptor.targets
                ? descriptor.clearValues?.[index] ?? null
                : descriptor.clear
                    ? descriptor.clearValue ?? OPAQUE_BLACK
                    : null;
            return {
                view: target.view,
                loadOp: clearValue ? 'clear' : 'load',
                storeOp: 'store',
                clearValue: clearValue ?? descriptor.clearValue ?? OPAQUE_BLACK,
            };
        });
        return { sizing, attachments };
    };

    /**
     * @param {any} encoder
     * @param {any} descriptor
     * @param {{ set: any, used: number } | null} [occlusion]  The frame's query
     *     set, for a pass opened with `occlusion: true`.
     * @returns {any}
     */
    function beginPass(encoder, descriptor, occlusion = null){
        const { sizing: target, attachments } = colourAttachmentsOf(descriptor);
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
        {
            for (const written of descriptor.targets ?? [descriptor.target])
            {
                if (written)
                {
                    remember(surfaceWrites,
                        { index: frameIndex, label: written.label ?? 'surface', at: now() });
                }
            }
        }
        const raw = encoder.beginRenderPass({
            label: descriptor.label === undefined ? `pass:${target.label}` : descriptor.label,
            colorAttachments: attachments,
            depthStencilAttachment: descriptor.depthStencilAttachment,
            ...(occlusion ? { occlusionQuerySet: occlusion.set } : {}),
        });
        profiler.count('passes');

        /** @type {any} */
        let viewport = null;
        /** @type {any} */
        let pipeline = null;
        // What each slot and group of the pass holds now. The same set again
        // is a call into the browser for nothing, and draws that share a
        // buffer or a texture make one a draw; the state lasts the pass, which
        // is this closure's life.
        /** @type {any[]} */
        const vertexBound = [];
        /** @type {number[]} */
        const vertexOffsets = [];
        /** @type {any} */
        let indexBound = null;
        let indexFormat = '';
        let indexOffset = -1;
        /** @type {any[]} */
        const groupsBound = [];
        /** @type {number[][]} */
        const groupOffsets = [];

        /**
         * A scissor rectangle kept on the attachment. The viewport may reach
         * past the target, the scissor may not: one past it invalidates the
         * encoder, and a negative origin is refused before it gets there --
         * either way the frame is lost rather than the part off the target.
         *
         * @param {{ x: number, y: number, width: number, height: number }} rect
         */
        const scissor = rect=>{
            const x0 = Math.min(Math.max(Math.floor(rect.x), 0), target.width);
            const y0 = Math.min(Math.max(Math.floor(rect.y), 0), target.height);
            const x1 = Math.min(Math.max(Math.ceil(rect.x + rect.width), x0), target.width);
            const y1 = Math.min(Math.max(Math.ceil(rect.y + rect.height), y0), target.height);
            raw.setScissorRect(x0, y0, x1 - x0, y1 - y0);
        };

        const pass = {
            target,
            get viewport(){
                return viewport;
            },

            /** @param {import('./contract.js').ViewportRect} rect */
            setViewport(rect){
                viewport = viewportState(rect);
                // WebGPU refuses a depth range outside 0..1, and the refusal
                // takes the frame's whole command buffer with it. Direct3D
                // takes a MaxZ past one and the depth buffer clamps what it
                // writes, which the range held to 0..1 writes too.
                const depth = (/** @type {number} */ value)=>Math.min(1, Math.max(0, value));
                raw.setViewport(viewport.rect.x, viewport.rect.y,
                    viewport.rect.width, viewport.rect.height,
                    depth(viewport.rect.minDepth), depth(viewport.rect.maxDepth));
                scissor(viewport.rect);
                return viewport;
            },

            /** @param {{ x: number, y: number, width: number, height: number }} rect */
            setScissor(rect){
                scissor(rect);
            },

            /**
             * The value a stencil test compares against and a replace writes.
             * Dynamic state rather than part of the pipeline, which is what
             * lets a shadow pass count up and down without a pipeline each.
             *
             * @param {number} reference
             */
            setStencilReference(reference){
                raw.setStencilReference(reference);
            },

            /**
             * The colour a pipeline's constant blend factor stands for. Dynamic
             * state like the stencil reference, and black at the start of
             * every pass until set.
             *
             * @param {{ r: number, g: number, b: number, a: number }} color
             */
            setBlendConstant(color){
                raw.setBlendConstant(color);
            },

            /**
             * Starts counting the samples that pass the depth and stencil
             * tests, in the next slot of the frame's set. Queries do not nest
             * and cannot span passes; a frame that has used every slot counts
             * no more, and says so with null.
             *
             * @returns {number | null} the slot, for `frame.occlusionResults`
             */
            beginOcclusionQuery(){
                if (!occlusion)
                {
                    throw new Error('This pass was not opened for occlusion queries');
                }
                if (occlusion.used >= OCCLUSION_CAPACITY)
                {
                    return null;
                }
                const index = occlusion.used++;
                raw.beginOcclusionQuery(index);
                return index;
            },

            endOcclusionQuery(){
                raw.endOcclusionQuery();
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
                const before = cache.created();
                const group = cache.get(layout, entries, label);
                profiler.count(cache.created() > before
                    ? 'bindGroupsCreated'
                    : 'bindGroupsReused');
                // setBindGroup copies the offsets it is handed.
                const offsets = dynamicOffsetsOf(entries, bindOffsets);
                const held = groupOffsets[index] ??= [];
                if (groupsBound[index] === group && sameOffsets(held, offsets))
                {
                    return group;
                }
                groupsBound[index] = group;
                held.length = 0;
                if (offsets)
                {
                    for (let at = 0; at < offsets.length; at++)
                    {
                        held.push(offsets[at]);
                    }
                    raw.setBindGroup(index, group, offsets);
                }
                else
                {
                    raw.setBindGroup(index, group);
                }
                return group;
            },

            /**
             * A uniform block for one draw, at its own offset in the ring: one
             * buffer rewritten between draws would show every draw in the pass
             * the last write, and the draws would render, with the wrong values.
             *
             * @param {ArrayBufferView} block
             * @param {{ buffer: any, offset: number, size: number, dynamicOffset: number }} [into]
             *     Where the slot is written, for a caller that binds it at
             *     once and keeps nothing; an object of its own otherwise.
             */
            uniforms(block, into){
                profiler.count('uniformBlocks');
                return uniforms.allocate(block, into);
            },

            /** @param {number} slot @param {any} buffer @param {number} [offset] */
            setVertexBuffer(slot, buffer, offset = 0){
                // A dynamic buffer answers its live backing, so a rename is
                // another object and binds again.
                const gpu = buffer.gpu === undefined ? buffer : buffer.gpu;
                if (vertexBound[slot] === gpu && vertexOffsets[slot] === offset)
                {
                    return;
                }
                vertexBound[slot] = gpu;
                vertexOffsets[slot] = offset;
                raw.setVertexBuffer(slot, gpu, offset);
            },

            /** @param {any} buffer @param {string} format @param {number} [offset] */
            setIndexBuffer(buffer, format, offset = 0){
                const gpu = buffer.gpu === undefined ? buffer : buffer.gpu;
                if (indexBound === gpu && indexFormat === format && indexOffset === offset)
                {
                    return;
                }
                indexBound = gpu;
                indexFormat = format;
                indexOffset = offset;
                raw.setIndexBuffer(gpu, format, offset);
            },

            /**
             * The arguments as they were given, as many as there were: the
             * API's own defaults stand for any left out. Without a rest
             * parameter, which is an array for every draw.
             *
             * @param {number} count @param {number} [instances] @param {number} [first]
             * @param {number} [firstInstance]
             */
            draw(count, instances, first, firstInstance){
                profiler.count('draws');
                switch (arguments.length)
                {
                    case 1: raw.draw(count); break;
                    case 2: raw.draw(count, instances); break;
                    case 3: raw.draw(count, instances, first); break;
                    default: raw.draw(count, instances, first, firstInstance);
                }
            },

            /**
             * As `draw` passes its arguments.
             *
             * @param {number} count @param {number} [instances] @param {number} [first]
             * @param {number} [baseVertex] @param {number} [firstInstance]
             */
            drawIndexed(count, instances, first, baseVertex, firstInstance){
                profiler.count('draws');
                switch (arguments.length)
                {
                    case 1: raw.drawIndexed(count); break;
                    case 2: raw.drawIndexed(count, instances); break;
                    case 3: raw.drawIndexed(count, instances, first); break;
                    case 4: raw.drawIndexed(count, instances, first, baseVertex); break;
                    default: raw.drawIndexed(count, instances, first, baseVertex, firstInstance);
                }
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

    /**
     * Gives a surface's memory back to the GPU now. A texture nothing refers
     * to goes when the collector gets to it, and the GPU's memory is not what
     * the collector watches: a device reset a few times a second, each
     * leaving a screen-sized target and depth behind, is out of it long
     * before then.
     *
     * @param {import('./contract.js').Surface} surface
     */
    const destroySurface = surface=>{
        surface.texture.destroy?.();
        profiler.count('surfacesDestroyed');
    };

    return {
        LockFlags,
        BufferUsage,
        TextureUsage,
        createSurface,
        destroySurface,

        /**
         * What has been recorded so far is cut off and queued for replay as
         * one frame -- at a present, or at a flush or read-back that sends
         * the recording before one. Renames after this retire backings that
         * belong to the next cut, so every dynamic buffer counts it.
         *
         * @returns {number} the cut, which the frame that replays it names
         *     to `beginFrame`
         */
        markPresent(){
            return frameCounts.presents++;
        },

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
                onUpload: (/** @type {string} */ label, /** @type {number} */ bytes)=>
                    profiler.bufferUpload(label, bytes),
                carry: (/** @type {import('./internal/buffers.js').Carry} */ carry)=>
                    carries.push(carry),
                frames: frameCounts,
                touched,
            });
            dynamicBuffers.add(buffer);
            return buffer;
        },

        /**
         * A dynamic buffer its owner is done with -- a buffer object deleted or
         * given another size, a ring outgrown: its GPU memory goes back once
         * the frames that read it are submitted, where it was held for the
         * rest of the run.
         *
         * @param {any} buffer
         */
        releaseDynamicBuffer(buffer){
            if (!dynamicBuffers.delete(buffer))
            {
                return;
            }
            touchedBuffers.delete(buffer);
            dying.push(...buffer.release());
            profiler.count('buffersReleased');
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

        /**
         * The same, resolved once the pipeline is valid and rejected with the
         * validation message when it is not: a pipeline returned invalid
         * fails every command buffer it is set on, and with it every frame.
         *
         * @param {any} descriptor
         */
        createRenderPipelineAsync(descriptor){
            if (!descriptor.layout || typeof descriptor.layout !== 'object')
            {
                return Promise.reject(
                    new Error('A render pipeline needs an explicit pipeline layout'));
            }
            return device.createRenderPipelineAsync(descriptor);
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
         * @param {{ cut?: number | null }} [options]  The cut (`markPresent`)
         *     whose recording this frame replays: once it is submitted, the
         *     backings retired while it was recorded are free. Null for a
         *     frame that replays no recording (a read of what is shown).
         *     Absent for a caller that records into the frame directly, so
         *     that every cut marked before it is on the queue when it ends.
         * @returns {any} the frame, which owns the only encoder there will be
         */
        beginFrame({ cut } = {}){
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

            // Staging buffers for copies issued between frames: encoded into
            // this frame's encoder now, so it is this frame's submit that
            // frees them.
            const stagingBuffers = [];
            /**
             * The frame's occlusion queries: one set, made by the first pass
             * that counts, its slots handed out in order across passes.
             *
             * @type {{ set: any, used: number, readback: any } | null}
             */
            let occlusion = null;
            let occlusionWanted = false;
            const endUploads = profiler.phase('uploads');
            while (pendingCopies.length > 0)
            {
                const copy = pendingCopies.shift();
                encoder.copyBufferToTexture(copy.source, copy.destination, copy.size);
                stagingBuffers.push(copy.source.buffer);
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
                stagingBuffers,

                /** @param {any} source @param {any} destination @param {any} size */
                encodeCopy(source, destination, size){
                    // A copy cannot be recorded inside a render pass, and the
                    // encoder is shared, so an upload mid-frame closes the pass
                    // it interrupted rather than corrupting the recording.
                    closeCurrentPass();
                    encoder.copyBufferToTexture(source, destination, size);
                },

                /**
                 * A region of one texture into another, outside any pass.
                 * The two must share a format; the copy is what a program
                 * that reads its own render target back into a texture asks
                 * for, and a draw between the two would see the old texels.
                 *
                 * @param {any} source @param {any} destination @param {any} size
                 */
                copyTexture(source, destination, size){
                    closeCurrentPass();
                    encoder.copyTextureToTexture(source, destination, size);
                },

                /**
                 * One buffer range into another, outside any pass.
                 *
                 * @param {any} source @param {number} sourceOffset
                 * @param {any} destination @param {number} destinationOffset
                 * @param {number} size
                 */
                copyBuffer(source, sourceOffset, destination, destinationOffset, size){
                    closeCurrentPass();
                    encoder.copyBufferToBuffer(source, sourceOffset, destination,
                        destinationOffset, size);
                },

                /**
                 * Ranges of buffers, brought back to the processor once this
                 * frame has been submitted.
                 *
                 * What a draw read is what the GPU holds, and that is not
                 * necessarily what the program wrote: the bytes travel through
                 * a shadow, a rename and a flush, and a gap in any of them is
                 * invisible from the recorded command. This is the one way to
                 * put the two side by side. Diagnostic only -- it closes the
                 * pass in progress, and every range of a frame shares one
                 * staging buffer and one map, because a map per range costs a
                 * round trip each.
                 *
                 * @param {{ buffer: any, offset: number, size: number }[]} ranges
                 * @returns {() => Promise<Uint8Array[]>} to call after `end`
                 */
                copyOut(ranges){
                    closeCurrentPass();
                    // Copies are in whole words at word offsets; each read takes
                    // in the bytes around its range and hands back the range.
                    let total = 0;
                    const placed = ranges.map(range=>{
                        const from = range.offset & ~3;
                        const length = (range.offset + range.size - from + 3) & ~3;
                        const at = total;
                        total += length;
                        return { ...range, from, length, at };
                    });
                    const staging = device.createBuffer({
                        label: 'copy-out',
                        size: Math.max(total, 4),
                        usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
                    });
                    for (const range of placed)
                    {
                        encoder.copyBufferToBuffer(
                            range.buffer, range.from, staging, range.at, range.length);
                    }
                    return async()=>{
                        await staging.mapAsync(MapMode.READ);
                        const mapped = new Uint8Array(staging.getMappedRange());
                        const results = placed.map(range=>mapped.slice(
                            range.at + range.offset - range.from,
                            range.at + range.offset - range.from + range.size));
                        staging.unmap();
                        staging.destroy();
                        return results;
                    };
                },

                /** @param {any} descriptor @returns {any} */
                beginPass(descriptor){
                    if (frame.ended)
                    {
                        throw new Error('This frame has already ended');
                    }
                    closeCurrentPass();
                    const endPhase = profiler.phase('passes');
                    if (descriptor.occlusion && !occlusion)
                    {
                        occlusion = {
                            set: device.createQuerySet({ label: `occlusion#${index}`,
                                type: 'occlusion', count: OCCLUSION_CAPACITY }),
                            used: 0,
                            readback: null,
                        };
                    }
                    currentPass = beginPass(encoder, descriptor,
                        descriptor.occlusion ? occlusion : null);
                    endPhase();
                    return currentPass;
                },

                /**
                 * What every occlusion query of the frame counted, by slot, for
                 * a reader after `end`: the set is resolved and copied out as
                 * the frame's last commands.
                 *
                 * @returns {() => Promise<number[]>}
                 */
                occlusionResults(){
                    occlusionWanted = true;
                    return async()=>{
                        const readback = occlusion?.readback;
                        if (!readback)
                        {
                            return [];
                        }
                        await readback.buffer.mapAsync(MapMode.READ);
                        const counts = new BigUint64Array(
                            readback.buffer.getMappedRange().slice(0, readback.count * 8));
                        readback.buffer.unmap();
                        readback.buffer.destroy();
                        return [...counts].map(Number);
                    };
                },

                /**
                 * The target's pixels as they are at this point of the frame,
                 * for a reader after `end`. The pass is closed for the copy;
                 * the caller reopens one that loads what is there. The level
                 * and layer are the surface's; its texels are four bytes
                 * unless it says otherwise.
                 *
                 * @param {import('./contract.js').Surface & { bytesPerTexel?: number }} surface
                 * @returns {() => Promise<{ width: number, height: number, data: Uint8Array }>}
                 */
                snapshot(surface){
                    closeCurrentPass();
                    const texel = surface.bytesPerTexel ?? 4;
                    const bytesPerRow = Math.ceil(surface.width * texel / 256) * 256;
                    const size = bytesPerRow * surface.height;
                    let staging;
                    if (spareStaging && spareStaging.size === size)
                    {
                        staging = spareStaging.buffer;
                        spareStaging = null;
                    }
                    else
                    {
                        staging = device.createBuffer({
                            label: 'snapshot',
                            size,
                            usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
                        });
                    }
                    encoder.copyTextureToBuffer(
                        { texture: surface.texture, mipLevel: surface.mipLevel ?? 0,
                            origin: { x: 0, y: 0, z: surface.layer ?? 0 } },
                        { buffer: staging, bytesPerRow, rowsPerImage: surface.height },
                        { width: surface.width, height: surface.height, depthOrArrayLayers: 1 });
                    return async()=>{
                        await staging.mapAsync(MapMode.READ);
                        const mapped = new Uint8Array(staging.getMappedRange());
                        const rowBytes = surface.width * texel;
                        const data = new Uint8Array(rowBytes * surface.height);
                        for (let row = 0; row < surface.height; row++)
                        {
                            data.set(mapped.subarray(row * bytesPerRow,
                                row * bytesPerRow + rowBytes), row * rowBytes);
                        }
                        staging.unmap();
                        // A snapshot that was in flight when `dispose()` ran has
                        // nowhere left to park a buffer: `spareStaging` will never
                        // be drained again once this instance is closed.
                        if (disposed || spareStaging)
                        {
                            staging.destroy();
                        }
                        else
                        {
                            spareStaging = { buffer: staging, size };
                        }
                        return { width: surface.width, height: surface.height, data };
                    };
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

                    /** @type {any} */
                    let resolved = null;
                    if (occlusion && occlusion.used > 0 && occlusionWanted)
                    {
                        const size = occlusion.used * 8;
                        resolved = device.createBuffer({ label: 'occlusion-resolve', size,
                            usage: BufferUsage.QUERY_RESOLVE | BufferUsage.COPY_SRC });
                        const readback = device.createBuffer({ label: 'occlusion', size,
                            usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
                        encoder.resolveQuerySet(occlusion.set, 0, occlusion.used, resolved, 0);
                        encoder.copyBufferToBuffer(resolved, 0, readback, 0, size);
                        occlusion.readback = { buffer: readback, count: occlusion.used };
                    }

                    const endUpload = profiler.phase('uploads');
                    for (const buffer of touchedBuffers)
                    {
                        buffer.flush();
                    }
                    uniforms.flush();
                    // The contents renames kept, copied old backing to new on
                    // the GPU, ahead of the frame's draws and after the
                    // uploads above, which the copies leave alone.
                    /** @type {any[]} */
                    const commands = [];
                    if (carries.length > 0)
                    {
                        const copier = device.createCommandEncoder({ label: 'carries' });
                        for (const carry of carries.splice(0))
                        {
                            for (const range of carriedRanges(carry))
                            {
                                copier.copyBufferToBuffer(carry.from, range.start, carry.to,
                                    range.start, range.end - range.start);
                            }
                        }
                        commands.push(copier.finish());
                    }
                    endUpload();

                    const endSubmit = profiler.phase('submit');
                    queue.submit([...commands, encoder.finish()]);
                    profiler.count('submits');
                    endSubmit();

                    // Safe once the copies that read them are submitted, not
                    // before: a draw of a later frame never touches these, so
                    // there is no reader left to wait on.
                    for (const staging of frame.stagingBuffers)
                    {
                        staging.destroy();
                    }
                    resolved?.destroy();
                    occlusion?.set.destroy();

                    // Counted by the cut and not by the submit: a frame that
                    // replays no recording, or one sent ahead of its present,
                    // would otherwise count as a frame its recording has not
                    // reached, and hand back a backing a later frame's draws
                    // still read. Cuts are replayed in the order they are made.
                    if (typeof cut === 'number')
                    {
                        frameCounts.submits = Math.max(frameCounts.submits, cut + 1);
                    }
                    else if (cut === undefined)
                    {
                        frameCounts.submits = frameCounts.presents;
                    }
                    for (let i = dying.length - 1; i >= 0; i--)
                    {
                        if (dying[i].at < frameCounts.submits)
                        {
                            dying[i].gpu.destroy?.();
                            dying.splice(i, 1);
                        }
                    }
                    for (const buffer of touchedBuffers)
                    {
                        buffer.endFrame();
                        if (!buffer.retiring)
                        {
                            touchedBuffers.delete(buffer);
                        }
                    }
                    uniforms.endFrame();

                    if (presenting)
                    {
                        const endPresent = profiler.phase('present');
                        lastPresented = { surface: presenting, frameIndex: index };
                        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                        {
                            remember(presentLog, { index,
                                label: presenting.label ?? 'surface', at: now() });
                        }
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
                buffers: [...dynamicBuffers].map(buffer=>buffer.diagnostics()),
                frameOpen: !!(openFrame && !openFrame.ended),
                pendingTextureCopies: pendingCopies.length,
                // Read against the page's own record of when it copied each
                // frame: a write to a surface timed before that copy is the
                // ordering violation, and it can be named frame by frame.
                surfaceWrites: surfaceWrites.slice(),
                presents: presentLog.slice(),
            };
        },

        dispose(){
            disposed = true;
            dynamicBuffers.clear();
            touchedBuffers.clear();
            // Staged between frames but never encoded: their buffers are not on
            // any frame's list, so dropping the queue without destroying them
            // first would leak one per queued copy.
            for (const copy of pendingCopies)
            {
                copy.source.buffer.destroy();
            }
            pendingCopies.length = 0;
            spareStaging?.buffer.destroy();
            spareStaging = null;
            pipelines.clear();
            fixedFunctionLayouts.clear();
            // A frame opened and never ended -- a fault mid-frame, the machine
            // rebuilt -- already has its copies' staging buffers on its list;
            // `end()` is what normally destroys them, so an ended-less frame
            // has to have this do it instead.
            if (openFrame && !openFrame.ended)
            {
                for (const staging of openFrame.stagingBuffers)
                {
                    staging.destroy();
                }
            }
            openFrame = null;
            lastPresented = null;
        },
    };
}

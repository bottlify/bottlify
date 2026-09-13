/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GL context's draws, on the GPU.
 *
 * A context records state and hands each draw here with the `Scene` the
 * processor pipeline would have drawn from; this turns it into a backend
 * draw. The frame is recorded as the program draws and replayed when it
 * swaps, because a pipeline compiles asynchronously and a draw cannot wait
 * for one; the replay awaits every pipeline the frame needs and then encodes
 * the whole frame at once, the way the Direct3D renderers do.
 *
 * What is decided here and nowhere else:
 *
 * - **A buffer object is a dynamic backend buffer, and a write into it picks
 *   its own lock flag.** GL promises nothing about a write's relation to the
 *   draws before it, so this tracks which byte ranges each unflushed frame's
 *   draws read: a write that touches none of them travels as a range under
 *   NOOVERWRITE, and one that does renames the buffer so the recorded draws
 *   keep what they read. A rename per write would send the whole buffer per
 *   write, which is the cost this bookkeeping exists to avoid.
 * - **Arrays go to the GPU as they lie when they can.** A vertex buffer's
 *   interleaved vertex is bound as slots and attributes and never read on
 *   the processor; only the index list is, to find the vertex range and to
 *   widen it to a format the GPU takes. Arrays in client memory are copied
 *   by that range into a ring; a vertex assembled on the processor (immediate
 *   mode, a lit draw, a type the GPU cannot read) is packed into the canonical
 *   layout and takes the same road.
 * - **A clear is a draw.** A pass's load operation ignores the scissor, the
 *   colour mask and the depth mask; GL's clear honours all three, and a
 *   triangle over the viewport does too.
 * - **The frame shown is an opaque copy of the back buffer**, alternating
 *   between two surfaces across swaps: a program's destination alpha is its
 *   own scratch and must not decide what the page shows through, and a copy
 *   is never drawn into while the page is still reading it.
 * - **Textures are uploaded from the texels the context decoded**, in one
 *   uncompressed format, when a draw first samples them or after the context
 *   marks them written. What a level holds on the GPU is what the context
 *   holds, except after a copy from the framebuffer, which lives only here.
 */

import { GL } from './constants.js';
import { multiply } from './matrix.js';
import { normalMatrix } from './lighting.js';
import { FACE_STRIDE, levelKey } from './objects.js';
import {
    CANONICAL_LAYOUT, expandIndices, isList, packVertices, planLayout, scanIndices, topologyOf,
} from './gpu-layout.js';
import {
    CLEAR_UNIFORM_FLOATS, UNIFORM, UNITS, clearDescriptor, clearKey, drawDescriptor, drawKey,
    generateClear, generateDraw, generateShow, showDescriptor, showKey,
} from './wgsl.js';

/** The formats every drawable is backed by. */
const COLOUR_FORMAT = 'bgra8unorm';
const DEPTH_FORMAT = 'depth24plus-stencil8';
const TEXTURE_FORMAT = 'rgba8unorm';

/** GPUShaderStage bits. */
const VERTEX_STAGE = 1;
const FRAGMENT_STAGE = 2;

/**
 * GL filter → the sampler's filters.
 *
 * @type {Readonly<Record<number, { filter: string, mip: string | null }>>}
 */
const FILTERS = Object.freeze({
    [GL.NEAREST]: { filter: 'nearest', mip: null },
    [GL.LINEAR]: { filter: 'linear', mip: null },
    [GL.NEAREST_MIPMAP_NEAREST]: { filter: 'nearest', mip: 'nearest' },
    [GL.LINEAR_MIPMAP_NEAREST]: { filter: 'linear', mip: 'nearest' },
    [GL.NEAREST_MIPMAP_LINEAR]: { filter: 'nearest', mip: 'linear' },
    [GL.LINEAR_MIPMAP_LINEAR]: { filter: 'linear', mip: 'linear' },
});

/**
 * GL wrap → the sampler's address mode. A border clamp has no counterpart
 * and clamps to the edge, which differs by the border colour along one texel.
 *
 * @type {Readonly<Record<number, string>>}
 */
const WRAPS = Object.freeze({
    [GL.REPEAT]: 'repeat',
    [GL.CLAMP]: 'clamp-to-edge',
    [GL.CLAMP_TO_EDGE]: 'clamp-to-edge',
    [GL.CLAMP_TO_BORDER]: 'clamp-to-edge',
    [GL.MIRRORED_REPEAT]: 'mirror-repeat',
});

/** @param {number} value */
const alignUp = value=>(value + 3) & ~3;

/**
 * @typedef {Object} GpuServices
 * @property {any} backend
 * @property {(descriptor: any) => any} createSampler
 * @property {(detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} DrawRequest
 *     A draw by arrays, as the context holds it.
 * @property {number} mode
 * @property {number} first
 * @property {number} count
 * @property {{ bytes: Uint8Array, type: number } | null} indices
 * @property {readonly import('./gpu-layout.js').ArrayRequest[]} arrays
 * @property {(address: number, length: number) => Uint8Array} read   client memory
 * @property {(name: number) => import('./objects.js').BufferObject | undefined} bufferObject
 */

/**
 * @typedef {Object} ClearRequest
 * @property {number} mask
 * @property {readonly number[]} colour    0..1
 * @property {number} depth
 * @property {number} stencil
 * @property {readonly boolean[]} colourMask
 * @property {boolean} depthMask
 * @property {number} stencilMask
 * @property {import('./raster.js').Box} scissor
 */

/**
 * @param {GpuServices} services
 */
export function createGpuRenderer(services){
    const { backend, createSampler } = services;
    const BufferUsage = backend.BufferUsage;
    const TextureUsage = backend.TextureUsage;
    /** @type {Set<string>} */
    const diverged = new Set();
    /** @param {string} detail */
    const diverge = detail=>{
        if (!diverged.has(detail))
        {
            diverged.add(detail);
            services.divergence?.(detail);
        }
    };

    /**
     * @typedef {Object} DrawableSurfaces
     * @property {any} colour     the back buffer every draw lands in
     * @property {any[]} shown    two opaque copies, alternating across swaps
     * @property {number} current
     * @property {any} depth
     * @property {number} width
     * @property {number} height
     */
    /** @type {WeakMap<object, DrawableSurfaces>} context -> its drawable's surfaces */
    const drawables = new WeakMap();

    /**
     * @typedef {Object} Recording
     * @property {any[]} commands
     * @property {Promise<any>[]} pipelines
     * @property {number} id
     */
    /** @type {WeakMap<object, Recording>} */
    const recordings = new WeakMap();
    let nextFrame = 1;
    /** Frames recorded and not yet flushed: what a buffer write may still collide with. */
    /** @type {Set<number>} */
    const unflushed = new Set();

    /** @type {Map<string, { group: any, pipeline: any }>} by the units' cube flags */
    const layouts = new Map();
    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    /** @type {Map<string, any>} */
    const samplers = new Map();
    const stats = { pipelines: 0, draws: 0, clears: 0, fallbacks: 0, uploads: 0, renames: 0 };

    /**
     * @typedef {Object} BufferRecord
     * @property {any} gpu    the dynamic buffer
     * @property {number} size
     * @property {{ frame: number, start: number, end: number }[]} reads
     */
    /** @type {WeakMap<import('./objects.js').BufferObject, BufferRecord>} */
    const buffers = new WeakMap();

    /**
     * @typedef {Object} TextureRecord
     * @property {any} gpu    a backend surface
     * @property {number} width
     * @property {number} height
     * @property {number} levels
     * @property {boolean} cube
     */
    /** @type {WeakMap<import('./objects.js').TextureObject, TextureRecord>} */
    const textures = new WeakMap();

    /**
     * A ring over one dynamic buffer for bytes that exist for one draw. Writes
     * go in under NOOVERWRITE until the ring wraps, and the wrap is a DISCARD.
     *
     * @param {string} label @param {number} usage @param {number} size
     */
    const ring = (label, usage, size)=>{
        let buffer = backend.createDynamicBuffer({ size, usage, label });
        let cursor = 0;
        let fresh = true;
        return {
            /** @param {ArrayBufferView} view @returns {{ gpu: any, offset: number }} */
            write(view){
                const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
                const aligned = alignUp(bytes.byteLength);
                if (aligned > buffer.size)
                {
                    buffer = backend.createDynamicBuffer({ size: aligned * 2, usage, label });
                    cursor = 0;
                    fresh = true;
                }
                if (cursor + aligned > buffer.size)
                {
                    cursor = 0;
                }
                const lock = buffer.lock(cursor, bytes.byteLength,
                    cursor === 0 && !fresh ? backend.LockFlags.DISCARD
                        : backend.LockFlags.NOOVERWRITE);
                fresh = false;
                lock.data.set(bytes);
                buffer.unlock(lock);
                const offset = cursor;
                cursor += aligned;
                return { gpu: buffer.gpu, offset };
            },
        };
    };
    const scratchVertices = ring('gl-scratch-vertices',
        BufferUsage.VERTEX | BufferUsage.COPY_DST, 1 << 20);
    const scratchIndices = ring('gl-scratch-indices',
        BufferUsage.INDEX | BufferUsage.COPY_DST, 1 << 18);

    /** @param {string} cubes one character per unit: 'c' for a cube, '2' otherwise */
    const layoutFor = cubes=>{
        const existing = layouts.get(cubes);
        if (existing)
        {
            return existing;
        }
        /** @type {any[]} */
        const entries = [{
            binding: 0,
            visibility: VERTEX_STAGE | FRAGMENT_STAGE,
            buffer: { type: 'uniform', hasDynamicOffset: true },
        }];
        [...cubes].forEach((kind, index)=>{
            entries.push({
                binding: 1 + index * 2,
                visibility: FRAGMENT_STAGE,
                texture: kind === 'c' ? { viewDimension: 'cube' } : {},
            });
            entries.push({ binding: 2 + index * 2, visibility: FRAGMENT_STAGE, sampler: {} });
        });
        const group = backend.createBindGroupLayout({ label: `gl:${cubes}`, entries });
        const made = {
            group,
            pipeline: backend.createPipelineLayout(
                { label: `gl:${cubes}`, bindGroupLayouts: [group] }),
        };
        layouts.set(cubes, made);
        return made;
    };

    /**
     * @param {string} key
     * @param {{ code: string, label: string }} source
     * @param {any} descriptor
     * @param {string} cubes
     */
    const pipelineFor = (key, source, descriptor, cubes)=>{
        const existing = pipelines.get(key);
        if (existing)
        {
            return existing;
        }
        stats.pipelines++;
        const layout = layoutFor(cubes);
        const building = (async()=>{
            const module = await backend.createShaderModule(source);
            return {
                layout: layout.group,
                gpu: backend.createRenderPipeline({
                    label: source.label,
                    layout: layout.pipeline,
                    vertex: { module, entryPoint: 'vertexMain', buffers: descriptor.vertexBuffers },
                    fragment: { module, entryPoint: 'fragmentMain', targets: [descriptor.target] },
                    primitive: descriptor.primitive,
                    depthStencil: descriptor.depthStencil,
                    multisample: descriptor.multisample,
                }),
            };
        })();
        pipelines.set(key, building);
        return building;
    };

    /** The sampler the shown copy is read through: one texel to one pixel. */
    let showSampler = /** @type {any} */ (null);
    const showSamplerFor = ()=>{
        if (!showSampler)
        {
            showSampler = createSampler({
                label: 'gl-show', magFilter: 'nearest', minFilter: 'nearest',
            });
        }
        return showSampler;
    };

    /** @param {import('./objects.js').TextureObject} texture */
    const samplerFor = texture=>{
        const parameters = texture.parameters;
        const mag = FILTERS[parameters.get(GL.TEXTURE_MAG_FILTER) ?? GL.LINEAR]
            ?? FILTERS[GL.LINEAR];
        const min = FILTERS[parameters.get(GL.TEXTURE_MIN_FILTER) ?? GL.NEAREST_MIPMAP_LINEAR]
            ?? FILTERS[GL.LINEAR];
        const wrap = (/** @type {number} */ query)=>
            WRAPS[parameters.get(query) ?? GL.REPEAT] ?? 'repeat';
        const descriptor = {
            magFilter: mag.filter,
            minFilter: min.filter,
            mipmapFilter: min.mip ?? 'nearest',
            // A filter without a mipmap reads the base level only.
            lodMaxClamp: min.mip === null ? 0 : 32,
            addressModeU: wrap(GL.TEXTURE_WRAP_S),
            addressModeV: wrap(GL.TEXTURE_WRAP_T),
            addressModeW: wrap(GL.TEXTURE_WRAP_R),
        };
        const key = JSON.stringify(descriptor);
        const existing = samplers.get(key);
        if (existing)
        {
            return existing;
        }
        const made = createSampler({ label: `gl-sampler:${key}`, ...descriptor });
        samplers.set(key, made);
        return made;
    };

    /**
     * The GPU copy of a texture, uploaded or brought up to date.
     *
     * @param {import('./objects.js').TextureObject} texture
     * @returns {TextureRecord}
     */
    const textureFor = texture=>{
        const cube = texture.target === GL.TEXTURE_CUBE_MAP;
        const base = /** @type {import('./objects.js').TextureLevel} */ (
            texture.levels.get(levelKey(0)));
        let levels = 0;
        while (texture.levels.has(levelKey(levels)))
        {
            levels++;
        }
        let record = textures.get(texture);
        if (record && (record.width !== base.width || record.height !== base.height
            || record.levels !== levels || record.cube !== cube))
        {
            record = undefined;
        }
        if (!record)
        {
            record = {
                gpu: backend.createSurface({
                    width: base.width,
                    height: base.height,
                    format: TEXTURE_FORMAT,
                    mipLevelCount: levels,
                    layers: cube ? 6 : 1,
                    dimension: cube ? 'cube' : undefined,
                    label: `gl-texture:${texture.name}`,
                    usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                        | TextureUsage.COPY_SRC,
                }),
                width: base.width,
                height: base.height,
                levels,
                cube,
            };
            textures.set(texture, record);
            // A fresh copy has every level to receive.
            for (const key of texture.levels.keys())
            {
                texture.dirty.add(key);
            }
        }
        for (const key of texture.dirty)
        {
            const level = key % FACE_STRIDE;
            const face = (key - level) / FACE_STRIDE;
            const image = texture.levels.get(key);
            if (!image || level >= levels || face >= (cube ? 6 : 1))
            {
                continue;
            }
            stats.uploads++;
            backend.uploadTexture({
                texture: record.gpu.texture,
                format: TEXTURE_FORMAT,
                mipLevel: level,
                width: image.width,
                height: image.height,
                origin: { x: 0, y: 0, z: face },
                data: image.texels ?? new Uint8Array(image.width * image.height * 4),
            });
        }
        texture.dirty.clear();
        return record;
    };

    /**
     * The GPU copy of a buffer object, with what the program wrote since the
     * last draw brought across under the flag its hazards allow.
     *
     * @param {import('./objects.js').BufferObject} buffer
     * @returns {BufferRecord}
     */
    const bufferFor = buffer=>{
        let record = buffers.get(buffer);
        if (record && record.size !== buffer.size)
        {
            record = undefined;
        }
        if (!record)
        {
            record = {
                gpu: backend.createDynamicBuffer({
                    size: Math.max(4, alignUp(buffer.size)),
                    usage: BufferUsage.VERTEX | BufferUsage.INDEX | BufferUsage.COPY_DST,
                    label: `gl-buffer:${buffer.name}`,
                }),
                size: buffer.size,
                reads: [],
            };
            buffers.set(buffer, record);
            // A fresh backing has the whole store to receive.
            buffer.written = buffer.size > 0 ? { start: 0, end: buffer.size } : null;
        }
        const written = buffer.written;
        if (!written)
        {
            return record;
        }
        buffer.written = null;
        record.reads = record.reads.filter(read=>unflushed.has(read.frame));
        const collides = record.reads.some(read=>
            read.start < written.end && written.start < read.end);
        if (collides)
        {
            stats.renames++;
            record.reads = [];
        }
        const lock = record.gpu.lock(written.start, written.end - written.start,
            collides ? backend.LockFlags.NONE : backend.LockFlags.NOOVERWRITE);
        lock.data.set(buffer.data.subarray(written.start, written.end));
        record.gpu.unlock(lock);
        return record;
    };

    /** @param {object} context */
    const recordingOf = context=>{
        let recording = recordings.get(context);
        if (!recording)
        {
            recording = { commands: [], pipelines: [], id: nextFrame++ };
            unflushed.add(recording.id);
            recordings.set(context, recording);
        }
        return recording;
    };

    /**
     * The scene's viewport and scissor as target rectangles: GL measures both
     * from the bottom-left corner and the target from the top-left.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @param {DrawableSurfaces} target
     */
    const rectangles = (scene, target)=>{
        const [x, y, width, height] = scene.viewport;
        const viewport = clampRect({
            x, y: target.height - y - height, width, height,
        }, target);
        const box = scene.scissor;
        const scissor = clampRect({
            x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0,
        }, target);
        return {
            viewport: { ...viewport, minDepth: scene.depthRange[0], maxDepth: scene.depthRange[1] },
            scissor,
        };
    };

    /**
     * @param {{ x: number, y: number, width: number, height: number }} rect
     * @param {{ width: number, height: number }} target
     */
    const clampRect = (rect, target)=>{
        const x0 = Math.max(0, Math.min(target.width, rect.x));
        const y0 = Math.max(0, Math.min(target.height, rect.y));
        const x1 = Math.max(x0, Math.min(target.width, rect.x + rect.width));
        const y1 = Math.max(y0, Math.min(target.height, rect.y + rect.height));
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    };

    /**
     * @param {import('./pipeline.js').Scene} scene
     * @param {import('./gpu-layout.js').DrawLayout} layout
     * @param {'point-list' | 'line-list' | 'triangle-list'} topology
     * @returns {import('./wgsl.js').DrawState}
     */
    const drawStateOf = (scene, layout, topology)=>{
        const units = scene.units.slice(0, UNITS).map(unit=>{
            const format = unit.baseFormat;
            return {
                index: unit.index,
                cube: unit.cube,
                mode: unit.env.mode,
                combine: unit.env.combine,
                hasColour: format !== GL.ALPHA,
                hasAlpha: format === GL.RGBA || format === GL.LUMINANCE_ALPHA
                    || format === GL.ALPHA || format === GL.INTENSITY,
                intensity: format === GL.INTENSITY,
                rgbOnly: format === GL.RGB,
                generation: unit.generation ? unit.generation.modes : [null, null, null, null],
            };
        });
        const operations = scene.operations;
        const mask = operations.colourMask;
        const cullMode = scene.cull ? scene.cull.mode : undefined;
        return {
            attributes: layout.attributes,
            strides: layout.slots.map(slot=>slot.stride),
            topology,
            targetFormat: COLOUR_FORMAT,
            depthFormat: DEPTH_FORMAT,
            units,
            colourSum: scene.colourSum,
            fog: scene.fog
                ? { mode: scene.fog.mode, fromCoordinate: scene.fog.fromCoordinate }
                : null,
            alphaFunc: scene.alphaTest ? scene.alphaTest.func : null,
            flat: scene.flat,
            blend: scene.blend,
            depth: {
                test: operations.depthTest !== undefined,
                func: operations.depthFunc ?? GL.LESS,
                write: operations.depthWrite,
            },
            stencil: scene.stencil,
            cull: cullMode === undefined ? 'none' : cullMode === GL.FRONT ? 'front' : 'back',
            frontIsCcw: scene.frontIsCcw,
            colourMask: (mask[0] ? 1 : 0) | (mask[1] ? 2 : 0) | (mask[2] ? 4 : 0)
                | (mask[3] ? 8 : 0),
            polygonOffset: scene.polygonOffset,
        };
    };

    /**
     * The uniform block of a draw: the matrices, the current values and the
     * per-unit constants, in the layout the shader declares.
     *
     * @param {import('./pipeline.js').Scene} scene
     */
    const uniformsOf = scene=>{
        const block = new Float32Array(UNIFORM.floats);
        block.set(multiply(scene.projection, scene.modelview), UNIFORM.modelViewProjection);
        block.set(scene.modelview, UNIFORM.modelView);
        const nm = normalMatrix(scene.modelview);
        block.set([
            nm[0], nm[1], nm[2], 0, nm[3], nm[4], nm[5], 0, nm[6], nm[7], nm[8], 0, 0, 0, 0, 1,
        ], UNIFORM.normalMatrix);
        for (const unit of scene.units)
        {
            if (unit.index >= UNITS)
            {
                continue;
            }
            block.set(unit.matrix, UNIFORM.textureMatrix + unit.index * 16);
            block.set(unit.env.colour, UNIFORM.envColor + unit.index * 4);
            if (unit.generation)
            {
                unit.generation.modes.forEach((mode, k)=>{
                    const plane = mode === GL.OBJECT_LINEAR
                        ? unit.generation?.objectPlanes[k]
                        : mode === GL.EYE_LINEAR ? unit.generation?.eyePlanes[k] : null;
                    if (plane)
                    {
                        block.set(plane, UNIFORM.planes + (unit.index * 4 + k) * 4);
                    }
                });
            }
        }
        const current = scene.current;
        block.set(current.color, UNIFORM.color);
        block.set(current.secondary, UNIFORM.secondary);
        block.set([current.normal[0], current.normal[1], current.normal[2], 0], UNIFORM.normal);
        current.texCoords.slice(0, UNITS).forEach((coords, unit)=>{
            block.set([coords[0], coords[1] ?? 0, coords[2] ?? 0, coords[3] ?? 1],
                UNIFORM.texCoord + unit * 4);
        });
        if (scene.fog)
        {
            block.set(scene.fog.colour, UNIFORM.fogColor);
            block.set([scene.fog.density, scene.fog.start, scene.fog.end, current.fogCoord],
                UNIFORM.fogParams);
        }
        block[UNIFORM.misc] = scene.alphaTest ? scene.alphaTest.reference : 0;
        return block;
    };

    /**
     * Records one draw of a laid-out vertex stream.
     *
     * @param {object} context
     * @param {import('./pipeline.js').Scene} scene
     * @param {import('./gpu-layout.js').DrawLayout} layout
     * @param {{ gpu: any, offset: number }[]} slots
     * @param {{ gpu: any, offset: number, format: string, count: number } | null} indices
     * @param {number} count
     * @param {number} first
     * @param {number} baseVertex
     * @param {'point-list' | 'line-list' | 'triangle-list'} topology
     */
    const record = (context, scene, layout, slots, indices, count, first, baseVertex, topology)=>{
        const target = drawables.get(context);
        if (!target)
        {
            return;
        }
        if (scene.cull && scene.cull.mode === GL.FRONT_AND_BACK && topology === 'triangle-list')
        {
            return;
        }
        if (scene.operations.logicOp)
        {
            diverge('a colour logic operation was enabled and the fragments were written as'
                + ' they are: the GPU path has no logic operations');
        }
        const state = drawStateOf(scene, layout, topology);
        const cubes = state.units.map(unit=>(unit.cube ? 'c' : '2')).join('');
        const key = drawKey(state);
        const recording = recordingOf(context);
        const pipeline = pipelineFor(key, generateDraw(state), drawDescriptor(state), cubes);
        const bindings = state.units.map((unit, index)=>{
            const texture = scene.units[index].texture;
            return { view: textureFor(texture).gpu.view, sampler: samplerFor(texture) };
        });
        stats.draws++;
        recording.pipelines.push(pipeline);
        recording.commands.push({
            kind: 'draw',
            pipeline: recording.pipelines.length - 1,
            uniforms: uniformsOf(scene),
            slots,
            indices,
            count,
            first,
            baseVertex,
            bindings,
            ...rectangles(scene, target),
            stencilReference: scene.stencil ? scene.stencil.reference : 0,
        });
    };

    /**
     * Draws vertices assembled on the processor, packed into the canonical
     * layout.
     *
     * @param {object} context
     * @param {import('./pipeline.js').Scene} scene
     * @param {number} mode
     * @param {readonly import('./pipeline.js').PipelineVertex[]} vertices
     */
    const drawPacked = (context, scene, mode, vertices)=>{
        if (vertices.length === 0)
        {
            return;
        }
        const packed = scratchVertices.write(packVertices(vertices));
        const expanded = expandIndices(mode, null, vertices.length);
        const indices = expanded
            ? { ...scratchIndices.write(expanded), format: 'uint32', count: expanded.length }
            : null;
        record(context, scene, CANONICAL_LAYOUT, [packed], indices,
            indices ? indices.count : vertices.length, 0, 0, topologyOf(mode));
    };

    /**
     * @param {object} context
     * @param {DrawRequest} request
     * @param {import('./pipeline.js').Scene} scene
     */
    const drawArrays = (context, request, scene)=>{
        if (scene.lighting || !drawables.has(context))
        {
            return false;
        }
        const layout = planLayout(request.arrays);
        if (!layout)
        {
            stats.fallbacks++;
            return false;
        }
        const scanned = request.indices
            ? scanIndices(request.indices.bytes, request.indices.type, request.count)
            : null;
        if (request.count === 0)
        {
            return true;
        }
        const min = scanned ? scanned.min : request.first;
        const max = scanned ? scanned.max : request.first + request.count - 1;
        const allClient = layout.slots.every(slot=>slot.buffer === 0);
        // Client-memory slots are copied from the first vertex the draw reaches
        // when every slot is one, and from vertex zero when a buffer object
        // shares the draw, so that one index numbers every slot alike.
        const from = allClient ? min : 0;
        const slots = layout.slots.map(slot=>{
            if (slot.buffer !== 0)
            {
                const object = request.bufferObject(slot.buffer);
                if (!object)
                {
                    return null;
                }
                const gpuBuffer = bufferFor(object);
                const recording = recordingOf(context);
                gpuBuffer.reads.push({
                    frame: recording.id,
                    start: slot.base + min * slot.stride,
                    end: slot.base + (max + 1) * slot.stride,
                });
                return { gpu: gpuBuffer.gpu.gpu, offset: slot.base };
            }
            const bytes = request.read(slot.base + from * slot.stride,
                (max + 1 - from) * slot.stride);
            return scratchVertices.write(bytes);
        });
        if (slots.some(slot=>slot === null))
        {
            return false;
        }
        const list = isList(request.mode);
        /** @type {{ gpu: any, offset: number, format: string, count: number } | null} */
        let indices = null;
        if (scanned && list)
        {
            indices = { ...scratchIndices.write(scanned.indices), format: scanned.format,
                count: scanned.indices.length };
        }
        else if (!list)
        {
            const expanded = /** @type {Uint32Array} */ (expandIndices(request.mode,
                scanned ? scanned.indices : null, request.count));
            if (!scanned)
            {
                for (let i = 0; i < expanded.length; i++)
                {
                    expanded[i] += request.first;
                }
            }
            indices = {
                ...scratchIndices.write(expanded), format: 'uint32', count: expanded.length,
            };
        }
        record(context, scene, layout, /** @type {{ gpu: any, offset: number }[]} */ (slots),
            indices, indices ? indices.count : request.count,
            indices ? 0 : request.first - from, 0 - from, topologyOf(request.mode));
        return true;
    };

    /**
     * @param {object} context
     * @param {ClearRequest} request
     */
    const clear = (context, request)=>{
        const target = drawables.get(context);
        if (!target)
        {
            return;
        }
        const mask = request.mask;
        const colourMask = mask & GL.COLOR_BUFFER_BIT
            ? (request.colourMask[0] ? 1 : 0) | (request.colourMask[1] ? 2 : 0)
                | (request.colourMask[2] ? 4 : 0) | (request.colourMask[3] ? 8 : 0)
            : 0;
        const depth = (mask & GL.DEPTH_BUFFER_BIT) !== 0 && request.depthMask;
        const stencilMask = mask & GL.STENCIL_BUFFER_BIT ? request.stencilMask & 0xff : 0;
        if (colourMask === 0 && !depth && stencilMask === 0)
        {
            return;
        }
        const state = { targetFormat: COLOUR_FORMAT, depthFormat: DEPTH_FORMAT, colourMask, depth,
            stencilMask };
        const recording = recordingOf(context);
        const pipeline = pipelineFor(clearKey(state), generateClear(), clearDescriptor(state), '');
        const uniforms = new Float32Array(CLEAR_UNIFORM_FLOATS);
        uniforms.set(request.colour.slice(0, 4), 0);
        uniforms[4] = Math.min(1, Math.max(0, request.depth));
        const box = request.scissor;
        stats.clears++;
        recording.pipelines.push(pipeline);
        recording.commands.push({
            kind: 'draw',
            pipeline: recording.pipelines.length - 1,
            uniforms,
            slots: [],
            indices: null,
            count: 3,
            first: 0,
            baseVertex: 0,
            bindings: [],
            viewport: {
                x: 0, y: 0, width: target.width, height: target.height, minDepth: 0, maxDepth: 1,
            },
            scissor: clampRect(
                { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }, target),
            stencilReference: request.stencil & 0xff,
        });
    };

    /** @type {Promise<void>} replays run one after another, in swap order */
    let chain = Promise.resolve();
    /** @type {string[]} */
    const failures = [];

    /**
     * @param {Recording} recording
     * @param {DrawableSurfaces} target
     * @param {any} shown   the opaque copy this frame is shown through
     */
    const replay = async(recording, target, shown)=>{
        const show = pipelineFor(showKey(COLOUR_FORMAT), generateShow(),
            showDescriptor(COLOUR_FORMAT), '2');
        const built = await Promise.allSettled([...recording.pipelines, show]);
        const frame = backend.beginFrame();
        try
        {
            let pass = frame.beginPass({
                target: target.colour,
                clear: false,
                depthStencilAttachment: {
                    view: target.depth.view,
                    depthLoadOp: 'load',
                    depthStoreOp: 'store',
                    stencilLoadOp: 'load',
                    stencilStoreOp: 'store',
                },
            });
            /** @type {any} */
            let viewport = null;
            /** @type {any} */
            let scissor = null;
            let stencilReference = -1;
            for (const command of recording.commands)
            {
                const outcome = built[command.pipeline];
                if (outcome.status === 'rejected')
                {
                    if (failures.length < 16)
                    {
                        failures.push(String(outcome.reason?.message ?? outcome.reason));
                    }
                    continue;
                }
                const pipeline = outcome.value;
                pass.setPipeline(pipeline.gpu);
                if (!sameRect(viewport, command.viewport))
                {
                    viewport = command.viewport;
                    pass.setViewport(viewport);
                    scissor = null;
                }
                if (!sameRect(scissor, command.scissor))
                {
                    scissor = command.scissor;
                    pass.setScissor(scissor);
                }
                if (stencilReference !== command.stencilReference)
                {
                    stencilReference = command.stencilReference;
                    pass.setStencilReference(stencilReference);
                }
                const entries = [{ binding: 0, resource: pass.uniforms(command.uniforms) }];
                command.bindings.forEach((/** @type {any} */ bound, /** @type {number} */ i)=>{
                    entries.push({ binding: 1 + i * 2, resource: bound.view },
                        { binding: 2 + i * 2, resource: bound.sampler });
                });
                pass.setBindings(0, pipeline.layout, entries);
                command.slots.forEach((/** @type {any} */ slot, /** @type {number} */ index)=>{
                    pass.setVertexBuffer(index, slot.gpu, slot.offset);
                });
                if (command.indices)
                {
                    pass.setIndexBuffer(command.indices.gpu, command.indices.format,
                        command.indices.offset);
                    pass.drawIndexed(command.count, 1, command.first, command.baseVertex);
                }
                else
                {
                    pass.draw(command.count, 1, command.first);
                }
            }
            const shownBy = built[built.length - 1];
            if (shownBy.status === 'fulfilled')
            {
                pass = frame.beginPass({ target: shown, clear: false });
                pass.setPipeline(shownBy.value.gpu);
                pass.setBindings(0, shownBy.value.layout, [
                    { binding: 0, resource: pass.uniforms(new Float32Array(4)) },
                    { binding: 1, resource: target.colour.view },
                    { binding: 2, resource: showSamplerFor() },
                ]);
                pass.draw(3, 1, 0);
                frame.present(shown);
            }
            else if (failures.length < 16)
            {
                failures.push(String(shownBy.reason?.message ?? shownBy.reason));
            }
        }
        finally
        {
            // Ended whatever happened, or every later frame fails at beginFrame.
            frame.end();
            unflushed.delete(recording.id);
        }
    };

    /** @param {any} a @param {any} b */
    const sameRect = (a, b)=>a !== null && a.x === b.x && a.y === b.y && a.width === b.width
        && a.height === b.height && a.minDepth === b.minDepth && a.maxDepth === b.maxDepth;

    return {
        /**
         * Backs a context's drawable with a colour pair and a depth-stencil
         * surface of its size.
         *
         * @param {object} context
         * @param {{ width: number, height: number }} drawable
         */
        attach(context, drawable){
            const width = Math.max(1, drawable.width);
            const height = Math.max(1, drawable.height);
            const usage = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                | TextureUsage.COPY_SRC;
            drawables.set(context, {
                colour: backend.createSurface({
                    width, height, format: COLOUR_FORMAT, label: 'gl-colour', usage,
                }),
                shown: [0, 1].map(index=>backend.createSurface({
                    width, height, format: COLOUR_FORMAT, label: `gl-shown[${index}]`, usage,
                })),
                current: 0,
                depth: backend.createSurface({
                    width, height, format: DEPTH_FORMAT, label: 'gl-depth',
                    usage: TextureUsage.RENDER_ATTACHMENT,
                }),
                width,
                height,
            });
        },

        /** @param {object} context */
        attached: context=>drawables.has(context),

        clear,
        drawArrays,
        draw: drawPacked,

        /**
         * The frame recorded since the last swap is replayed and shown; the
         * next one draws into the other colour surface.
         *
         * @param {object} context
         * @returns {{ width: number, height: number } | null}
         */
        present(context){
            const target = drawables.get(context);
            if (!target)
            {
                return null;
            }
            const recording = recordings.get(context) ?? recordingOf(context);
            recordings.delete(context);
            const shown = target.shown[target.current];
            target.current ^= 1;
            backend.markPresent();
            chain = chain
                .then(()=>replay(recording, target, shown))
                .catch(error=>{
                    unflushed.delete(recording.id);
                    if (failures.length < 16)
                    {
                        failures.push(error instanceof Error ? error.message : String(error));
                    }
                });
            return { width: target.width, height: target.height };
        },

        /** Every replay queued so far has run. */
        settled: ()=>chain,

        diagnostics: ()=>({
            ...stats,
            resident: pipelines.size,
            samplers: samplers.size,
            unflushed: unflushed.size,
            failures: [...failures],
        }),
    };
}

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
import { identity, invert, multiply, transpose } from './matrix.js';
import { normalMatrix } from './lighting.js';
import { FACE_STRIDE, createTextureObject, levelKey } from './objects.js';
import {
    CANONICAL_LAYOUT, expandIndices, isList, packVertices, planLayout, scanIndices, topologyOf,
} from './gpu-layout.js';
import {
    FRAGMENT_PROGRAM_BINDING, FRAGMENT_PROGRAM_GROUP, VARYING_TEXCOORDS,
    VERTEX_PROGRAM_BINDING,
} from './arb-wgsl.js';
import {
    CLEAR_UNIFORM_FLOATS, COPY_UNIFORM_FLOATS, UNIFORM, UNITS, clearDescriptor, clearKey,
    copyKey, drawDescriptor, drawKey, generateClear, generateCopy, generateDraw, generateShow,
    showDescriptor, showKey,
} from './wgsl.js';

/** The formats every drawable is backed by. */
const COLOUR_FORMAT = 'bgra8unorm';
const DEPTH_FORMAT = 'depth24plus-stencil8';
const TEXTURE_FORMAT = 'rgba8unorm';

/** What a state matrix binding reads when there is no matrix behind it. */
const IDENTITY = identity();
const ZERO_MATRIX = new Float64Array(16);

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
 * @property {boolean} [dumpDraws]  describe every draw of the last frame
 * @property {number} [maxDraws]    stop a frame after this many draws
 * @property {string | null} [skipTexture]  drop draws sampling these ids
 * @property {string | null} [probeTexture]  read the target around its draws
 */

/**
 * One draw's line in a dump: the state it ran under, what it sampled and
 * what its uniform blocks carried. Hex for the GL enumerants, so a line can
 * be read against a call log; decimal for everything a picture depends on
 * the value of.
 */

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

/**
 * @param {{ x: number, y: number, width: number, height: number,
 *           minDepth?: number, maxDepth?: number }} rect
 */
const describeRect = rect=>`[${rect.x},${rect.y} ${rect.width}x${rect.height}`
    + `${rect.minDepth === undefined ? '' : ` d${rect.minDepth}..${rect.maxDepth}`}]`;

/**
 * A uniform block as floats, rounded, with the run of zeroes it ends in
 * dropped: what a program bound is at the front of its block, and the tail
 * of a fixed one is fog and padding nobody reads.
 *
 * @param {ArrayBufferView | null} block
 */
function describeBlock(block){
    if (!block)
    {
        return '-';
    }
    /** @type {number[]} */
    const values = [];
    const floats = /** @type {Float32Array} */ (block);
    for (let i = 0; i < floats.length; i++)
    {
        values.push(Number.isFinite(floats[i]) ? Number(floats[i].toFixed(4)) : floats[i]);
    }
    while (values.length > 0 && values[values.length - 1] === 0)
    {
        values.pop();
    }
    return `[${values.join(' ')}]`;
}

/**
 * How many draws of one frame a probe reads around: each is two full-target
 * read-backs, and a texture every light samples is in hundreds of draws.
 */
const PROBE_LIMIT = 4;

/**
 * Where a snapshot of the target is read: a spread of points across the
 * rectangle the draw was scissored to, and a coarse grid over it for how
 * much variety the whole holds -- a draw's own region, because most draws
 * touch a corner of the frame and fixed screen points would read pixels
 * they never had. A draw that painted nothing has the same points before
 * and after and one colour across the grid; one that painted a lit surface
 * has neither.
 *
 * @param {{ width: number, height: number, data: Uint8Array }} shot
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
function describeSnapshot(shot, rect){
    /** @param {number} x @param {number} y */
    const at = (x, y)=>{
        const px = Math.min(shot.width - 1, rect.x + Math.floor(x * Math.max(1, rect.width)));
        const py = Math.min(shot.height - 1, rect.y + Math.floor(y * Math.max(1, rect.height)));
        const index = (py * shot.width + px) * 4;
        return `${shot.data[index + 2]}/${shot.data[index + 1]}/${shot.data[index]}`;
    };
    const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
        [0.5, 0.125], [0.125, 0.5]];
    /** @type {Set<string>} */
    const seen = new Set();
    for (let y = 0.05; y < 0.95; y += 0.06)
    {
        for (let x = 0.05; x < 0.95; x += 0.06)
        {
            seen.add(at(x, y));
        }
    }
    return `${points.map(([x, y])=>at(x, y)).join(',')} distinct=${seen.size}`;
}

/**
 * What a texture a probed draw samples actually holds: target, size, format
 * and the count of distinct texels of level 0, per face for a cube. A light
 * whose normalisation cube or falloff image arrived empty multiplies every
 * fragment by zero, and only the texels themselves can say so; a census on
 * the draw's own line says it without another run.
 *
 * @param {import('./objects.js').TextureObject} texture
 */
function describeCensus(texture){
    const cube = texture.target === GL.TEXTURE_CUBE_MAP;
    const faces = cube ? 6 : 1;
    const base = texture.levels.get(levelKey(0));
    const shape = base ? `${base.width}x${base.height}` : '?';
    const format = base ? hex(base.internalFormat) : '-';
    /** @type {string[]} */
    const distinct = [];
    for (let face = 0; face < faces; face++)
    {
        const level = texture.levels.get(levelKey(0, face));
        if (!level)
        {
            distinct.push('missing');
            continue;
        }
        if (!level.texels)
        {
            distinct.push('gpu-only');
            continue;
        }
        const words = new Uint32Array(level.texels.buffer, level.texels.byteOffset,
            level.texels.byteLength >> 2);
        // A census is a diagnostic, not a second upload path: past a megapixel
        // it samples every fourth texel and says so with a tilde.
        const step = words.length > (1 << 20) ? 4 : 1;
        /** @type {Set<number>} */
        const seen = new Set();
        for (let i = 0; i < words.length; i += step)
        {
            seen.add(words[i]);
        }
        distinct.push(`${seen.size}${step > 1 ? '~' : ''}`);
    }
    return `t${texture.name}${cube ? 'c' : ''}:${shape}:${format}:`
        + `distinct=${distinct.join('/')}`;
}

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
    const dumpDraws = services.dumpDraws === true;
    const maxDraws = services.maxDraws === undefined ? -1 : services.maxDraws;
    /** @type {Set<string>} */
    const skipTextures = new Set((services.skipTexture ?? '').split(',').filter(Boolean));
    /**
     * Which draws a probe reads around: a texture id, optionally followed by
     * `@N` or `@A-B` naming the draw numbers of the frame to read -- a light's
     * draws that no depth or stencil test can kill are a handful of a frame's
     * hundreds, and only reaching those says whether the tests or the
     * arithmetic contribute nothing. Without a window the last four draws
     * sampling the texture are read.
     */
    const probeSpec = (()=>{
        const text = services.probeTexture ?? '';
        if (text === '')
        {
            return null;
        }
        const [id, window] = text.split('@');
        if (window === undefined)
        {
            return { id, from: null, to: null };
        }
        const [a, b] = window.split('-');
        const from = Number(a);
        return { id, from, to: b === undefined ? from : Number(b) };
    })();
    /** The last presented frame's dump; empty unless the build asked for one. */
    /** @type {string[]} */
    let lastDump = [];
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
     * @property {string[]} dump     the frame's lines, when one was asked for
     * @property {Set<string>} dumped  the program texts the dump already holds
     * @property {{ draws: number, clears: number, copies: number, refused: number,
     *               skipped: number, cut: number }} counts
     */
    /** @type {WeakMap<object, Recording>} */
    const recordings = new WeakMap();
    let nextFrame = 1;
    /** Frames recorded and not yet flushed: what a buffer write may still collide with. */
    /** @type {Set<number>} */
    const unflushed = new Set();

    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    /** @type {Map<string, any>} */
    const samplers = new Map();
    const stats = {
        frames: 0, pipelines: 0, draws: 0, clears: 0, fallbacks: 0, uploads: 0, renames: 0,
        refused: 0, skipped: 0, cut: 0,
    };

    /**
     * @typedef {Object} BindPlan
     *     The bind group layout a generated module declares: the fixed
     *     uniform block, a texture pair per unit the fragment stage samples,
     *     and a uniform block per program stage.
     * @property {string} key
     * @property {{ binding: number, cube: boolean, unit: number }[]} textures
     * @property {boolean} vertexBlock
     * @property {boolean} fragmentBlock
     */
    /** @type {BindPlan} */
    const NO_TEXTURE_PLAN = { key: '|', textures: [], vertexBlock: false, fragmentBlock: false };
    /** @type {BindPlan} */
    const SINGLE_TEXTURE_PLAN = {
        key: '12|', textures: [{ binding: 1, cube: false, unit: 0 }],
        vertexBlock: false, fragmentBlock: false,
    };

    /**
     * @param {import('./wgsl.js').DrawState} state
     * @param {import('./wgsl.js').ProgramStages | null} programs
     * @returns {BindPlan}
     */
    const bindPlanOf = (state, programs)=>{
        /** @type {{ binding: number, cube: boolean, unit: number }[]} */
        const textures = [];
        if (programs?.fragment)
        {
            // A fragment program samples by unit number, and a unit's enable
            // state does not enter into it.
            for (const texture of programs.fragment.textures)
            {
                textures.push({
                    binding: 1 + texture.unit * 2, cube: texture.target === 'CUBE',
                    unit: texture.unit,
                });
            }
        }
        else
        {
            state.units.forEach((unit, position)=>textures.push(
                { binding: 1 + position * 2, cube: unit.cube, unit: unit.index }));
        }
        textures.sort((a, b)=>a.binding - b.binding);
        const vertexBlock = programs?.vertex != null;
        const fragmentBlock = programs?.fragment != null;
        const key = `${textures.map(t=>`${t.binding}${t.cube ? 'c' : '2'}`).join(',')}|`
            + `${vertexBlock ? 'v' : ''}${fragmentBlock ? 'f' : ''}`;
        return { key, textures, vertexBlock, fragmentBlock };
    };

    /** @type {Map<string, { groups: any[], pipeline: any }>} */
    const layouts = new Map();
    /** @param {BindPlan} plan */
    const layoutFor = plan=>{
        const existing = layouts.get(plan.key);
        if (existing)
        {
            return existing;
        }
        // The fixed block, the sampled textures and the vertex program block
        // share group 0. The vertex stage reads no dynamic uniform block
        // outside group 0, and a stage that reads only some of a group's
        // dynamic uniform bindings is handed zero for its own; the fixed
        // binding is visible to the vertex stage, so it reads group 0 whole.
        // The fragment program block gets a group of its own, which the
        // fragment stage reads alone.
        /** @type {any[]} */
        const fixedEntries = [{
            binding: 0,
            visibility: VERTEX_STAGE | FRAGMENT_STAGE,
            buffer: { type: 'uniform', hasDynamicOffset: true },
        }];
        for (const texture of plan.textures)
        {
            fixedEntries.push({
                binding: texture.binding,
                visibility: FRAGMENT_STAGE,
                texture: texture.cube ? { viewDimension: 'cube' } : {},
            });
            fixedEntries.push({
                binding: texture.binding + 1, visibility: FRAGMENT_STAGE, sampler: {},
            });
        }
        if (plan.vertexBlock)
        {
            fixedEntries.push({
                binding: VERTEX_PROGRAM_BINDING,
                visibility: VERTEX_STAGE,
                buffer: { type: 'uniform', hasDynamicOffset: true },
            });
        }
        /** @type {any[]} */
        const groups = [backend.createBindGroupLayout(
            { label: `gl:${plan.key}#fixed`, entries: fixedEntries })];
        if (plan.fragmentBlock)
        {
            groups.push(backend.createBindGroupLayout({
                label: `gl:${plan.key}#fragment`,
                entries: [{
                    binding: FRAGMENT_PROGRAM_BINDING,
                    visibility: FRAGMENT_STAGE,
                    buffer: { type: 'uniform', hasDynamicOffset: true },
                }],
            }));
        }
        const made = {
            groups,
            pipeline: backend.createPipelineLayout(
                { label: `gl:${plan.key}`, bindGroupLayouts: groups }),
        };
        layouts.set(plan.key, made);
        return made;
    };

    /**
     * @param {string} key
     * @param {{ code: string, label: string }} source
     * @param {any} descriptor
     * @param {BindPlan} plan
     */
    const pipelineFor = (key, source, descriptor, plan)=>{
        const existing = pipelines.get(key);
        if (existing)
        {
            return existing;
        }
        stats.pipelines++;
        const layout = layoutFor(plan);
        const building = (async()=>{
            const module = await backend.createShaderModule(source);
            return {
                layout: layout.groups[0],
                groups: layout.groups,
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
     * @property {Map<number, any>} views   a level as a target, by level key, once drawn into
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
     * The texture a sampled unit reads with nothing complete bound: the
     * incomplete texture's value, one black opaque texel.
     *
     * @type {Map<boolean, import('./objects.js').TextureObject>}
     */
    const incompleteTextures = new Map();
    /** @param {boolean} cube */
    const incompleteTexture = cube=>{
        let texture = incompleteTextures.get(cube);
        if (!texture)
        {
            texture = createTextureObject(0, cube ? GL.TEXTURE_CUBE_MAP : GL.TEXTURE_2D);
            for (let face = 0; face < (cube ? 6 : 1); face++)
            {
                texture.levels.set(levelKey(0, face), {
                    width: 1, height: 1, internalFormat: GL.RGBA8, border: 0,
                    baseFormat: GL.RGBA, texels: new Uint8Array([0, 0, 0, 255]),
                });
            }
            incompleteTextures.set(cube, texture);
        }
        return texture;
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
                    // A target too: a program copies its framebuffer into a
                    // level, and that copy is a draw into it.
                    usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                        | TextureUsage.COPY_SRC | TextureUsage.RENDER_ATTACHMENT,
                }),
                width: base.width,
                height: base.height,
                levels,
                cube,
                views: new Map(),
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
            recording = {
                commands: [], pipelines: [], id: nextFrame++, dump: [], dumped: new Set(),
                counts: {
                    draws: 0, clears: 0, copies: 0, refused: 0, skipped: 0, cut: 0,
                },
            };
            unflushed.add(recording.id);
            recordings.set(context, recording);
        }
        return recording;
    };

    /**
     * The programs a draw runs, as the dump names them, with the text of each
     * one the frame has not already printed: a line says which program drew
     * what, and the text is what identifies it against the program's own.
     *
     * @param {Recording} recording
     * @param {import('./wgsl.js').DrawState} state
     * @returns {string}
     */
    const dumpPrograms = (recording, state)=>{
        /** @type {string[]} */
        const names = [];
        for (const [kind, program] of /** @type {[string, any][]} */ ([
            ['vp', state.vertexProgram], ['fp', state.fragmentProgram]]))
        {
            if (!program)
            {
                continue;
            }
            names.push(`${kind}=p${program.name}.${program.version}`);
            const key = `${kind}${program.name}.${program.version}`;
            if (!recording.dumped.has(key))
            {
                recording.dumped.add(key);
                recording.dump.push(`== ${key} ${program.ir.kind} program ==\n${program.text}`);
            }
        }
        return names.length > 0 ? ` ${names.join(' ')}` : '';
    };

    /**
     * What every unit has bound, whether or not it is enabled: the textures a
     * fragment program would sample, which is what a refused draw has to be
     * recognised by.
     *
     * @param {import('./pipeline.js').Scene} scene
     */
    const dumpBound = scene=>scene.boundTextures.length === 0 ? '' : ` bound=[${
        scene.boundTextures.map((bound, unit)=>
            `${unit}:${bound?.twoD ? `t${bound.twoD.name}` : '-'}`
            + `${bound?.cube ? `c t${bound.cube.name}` : ''}`).join(' ')}]`;

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
            viewportHeight: scene.framebuffer.height,
            colourMask: (mask[0] ? 1 : 0) | (mask[1] ? 2 : 0) | (mask[2] ? 4 : 0)
                | (mask[3] ? 8 : 0),
            polygonOffset: scene.polygonOffset,
            vertexProgram: scene.programs.vertex,
            fragmentProgram: scene.programs.fragment,
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
        current.texCoords.slice(0, VARYING_TEXCOORDS).forEach((coords, unit)=>{
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
     * One row of one state matrix, at draw time: the base matrix from the
     * scene's stacks, through the binding's modifier, down to the row it
     * names. A singular inverse reads as zeros, which is as good an undefined
     * as the specification offers.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @param {import('./arb-wgsl.js').ParamSlot} slot
     * @returns {number[]}
     */
    const stateMatrixRow = (scene, slot)=>{
        let m;
        switch (slot.matrix)
        {
            case 'modelview':
                m = slot.number === 0 ? scene.modelview : IDENTITY;
                break;
            case 'projection':
                m = scene.projection;
                break;
            case 'mvp':
                m = multiply(scene.projection, scene.modelview);
                break;
            default:
                m = scene.textureMatrices[slot.number ?? 0] ?? IDENTITY;
                break;
        }
        if (slot.modifier === 'inverse' || slot.modifier === 'invtrans')
        {
            m = invert(m) ?? ZERO_MATRIX;
        }
        if (slot.modifier === 'transpose' || slot.modifier === 'invtrans')
        {
            m = transpose(m);
        }
        const row = slot.row ?? 0;
        return [m[row], m[4 + row], m[8 + row], m[12 + row]];
    };

    /**
     * A program stage's uniform block: its materialised parameters in slot
     * order, then the current values of the generic attributes that have no
     * array behind them.
     *
     * @param {import('./arb-wgsl.js').StageNeeds} needs
     * @param {import('./pipeline.js').SceneProgram} program
     * @param {import('./pipeline.js').Scene} scene
     * @returns {Float32Array}
     */
    const programUniforms = (needs, program, scene)=>{
        const parameterCount = Math.max(1, needs.params.length);
        const block = new Float32Array((parameterCount + needs.genericFallbacks.length) * 4);
        needs.params.forEach((slot, index)=>{
            const at = (/** @type {number} */ (slot.index)) * 4;
            switch (slot.source)
            {
                case 'local':
                    block.set(program.local.subarray(at, at + 4), index * 4);
                    break;
                case 'env':
                    block.set(program.env.subarray(at, at + 4), index * 4);
                    break;
                case 'constant':
                    block.set(/** @type {readonly number[]} */ (slot.values), index * 4);
                    break;
                case 'matrix':
                    block.set(stateMatrixRow(scene, slot), index * 4);
                    break;
                default:
                    break;
            }
        });
        needs.genericFallbacks.forEach((attrib, k)=>{
            const value = scene.genericAttribs[attrib];
            if (value)
            {
                block.set(value, (parameterCount + k) * 4);
            }
        });
        return block;
    };

    /**
     * @typedef {Object} RecordedBinding
     * @property {number} binding   the texture's binding; the sampler is the next
     * @property {any} view
     * @property {any} sampler
     * @property {import('./objects.js').TextureObject} texture
     */

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
        const key = drawKey(state);
        const generated = generateDraw(state);
        const recording = recordingOf(context);
        if (generated.programs?.error)
        {
            diverge(`a program draw was refused and drew nothing: ${generated.programs.error}`);
            stats.refused++;
            if (dumpDraws)
            {
                recording.counts.refused++;
                recording.dump.push(`refused: ${generated.programs.error}`
                    + `${dumpPrograms(recording, state)}${dumpBound(scene)}`);
            }
            return;
        }
        const plan = bindPlanOf(state, generated.programs);
        const sampled = plan.textures.map(entry=>({
            entry,
            texture: textureForBinding(scene, entry, plan.fragmentBlock),
        }));
        const ids = sampled.map(({ entry, texture })=>
            `t${texture.name}${entry.cube ? 'c' : ''}`);
        if (skipTextures.size > 0 && ids.some(id=>skipTextures.has(id)))
        {
            stats.skipped++;
            recording.counts.skipped++;
            return;
        }
        if (maxDraws >= 0 && recording.counts.draws >= maxDraws)
        {
            stats.cut++;
            recording.counts.cut++;
            return;
        }
        /** @type {RecordedBinding[]} */
        const bindings = sampled.map(({ entry, texture })=>({
            binding: entry.binding,
            view: textureFor(texture).gpu.view,
            sampler: samplerFor(texture),
            texture,
        }));
        const pipeline = pipelineFor(key, generated, drawDescriptor(state), plan);
        const uniforms = uniformsOf(scene);
        const vertexUniforms = generated.programs?.vertex && state.vertexProgram
            ? programUniforms(generated.programs.vertex, state.vertexProgram, scene)
            : null;
        const fragmentUniforms = generated.programs?.fragment && state.fragmentProgram
            ? programUniforms(generated.programs.fragment, state.fragmentProgram, scene)
            : null;
        stats.draws++;
        recording.counts.draws++;
        const rects = rectangles(scene, target);
        let probe = -1;
        if (dumpDraws)
        {
            recording.dump.push(`draw ${recording.counts.draws - 1}: ${topology}`
                + ` count=${count} first=${first} base=${baseVertex}`
                + ` blend=${state.blend
                    ? `${hex(state.blend.src)},${hex(state.blend.dst)}` : 'off'}`
                + ` depth=${state.depth.test ? hex(state.depth.func) : 'off'}`
                + `${state.depth.write ? '+write' : ''}`
                + ` stencil=${state.stencil
                    ? `${hex(state.stencil.func)},ref${scene.stencil?.reference ?? 0},`
                        + `rm${hex(state.stencil.readMask)},wm${hex(state.stencil.writeMask)},`
                        + `${hex(state.stencil.fail)},${hex(state.stencil.zfail)},`
                        + `${hex(state.stencil.zpass)}`
                    : 'off'}`
                + ` cull=${state.cull}${state.frontIsCcw ? '/ccw' : '/cw'}`
                + ` mask=${hex(state.colourMask)}`
                + ` offset=${state.polygonOffset
                    ? `${state.polygonOffset.factor},${state.polygonOffset.units}` : '-'}`
                + ` fog=${state.fog ? hex(state.fog.mode) : 'off'}`
                + ` alpha=${state.alphaFunc === null ? 'off' : hex(state.alphaFunc)}`
                + ` vp=${describeRect(rects.viewport)} sc=${describeRect(rects.scissor)}`
                + ` attrs=[${state.attributes.map(a=>`${a.name}@${a.slot}+${a.offset}:${a.format}`)
                    .join(' ')}]`
                + ` units=[${state.units.map(unit=>`${unit.index}${unit.cube ? 'c' : ''}`
                    + `:env${hex(unit.mode)}`
                    + `${unit.mode === GL.COMBINE
                        ? `:c${hex(unit.combine.rgb)}/${hex(unit.combine.alpha)}`
                            + `(${unit.combine.sourceRgb.join('.')}`
                            + `${unit.combine.operandRgb.join('.')})`
                        : ''}`
                    + `:gen[${unit.generation
                        .map(g=>(g === null ? '-' : hex(g))).join('.')}]`).join(' ')}]`
                + ` tex=[${sampled.map(({ entry }, i)=>`${entry.binding}:${ids[i]}`).join(' ')}]`
                + dumpPrograms(recording, state)
                + dumpBound(scene)
                + ` uni=${describeBlock(uniforms)}`
                + ` vuni=${describeBlock(vertexUniforms)}`
                + ` funi=${describeBlock(fragmentUniforms)}`);
            // After the push: the program texts a first sight of a program
            // adds are entries of their own, ahead of this line. Every draw
            // sampling the probed texture is a candidate; which of them the
            // replay reads around is decided there, where the frame is whole.
            probe = probeSpec !== null && ids.includes(probeSpec.id)
                ? recording.dump.length - 1 : -1;
        }
        recording.pipelines.push(pipeline);
        recording.commands.push({
            kind: 'draw',
            pipeline: recording.pipelines.length - 1,
            uniforms,
            vertexUniforms,
            fragmentUniforms,
            slots,
            indices,
            count,
            first,
            baseVertex,
            bindings,
            ...rects,
            stencilReference: scene.stencil ? scene.stencil.reference : 0,
            probe,
            probeDraw: recording.counts.draws - 1,
        });
    };

    /**
     * The texture one binding samples: under a fragment program, what the
     * unit has bound for the target the instruction named, complete or not,
     * because a program's sample of a unit with nothing there reads the
     * incomplete texture's value; on the fixed path, the unit the scene
     * enabled at that position.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @param {{ binding: number, cube: boolean, unit: number }} entry
     * @param {boolean} programFragment
     * @returns {import('./objects.js').TextureObject}
     */
    const textureForBinding = (scene, entry, programFragment)=>{
        if (programFragment)
        {
            const bound = scene.boundTextures[entry.unit];
            const texture = entry.cube ? bound?.cube : bound?.twoD;
            return texture ?? incompleteTexture(entry.cube);
        }
        const position = (entry.binding - 1) / 2;
        return scene.units[position]?.texture ?? incompleteTexture(entry.cube);
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
        // A vertex program replaces the fixed lighting, so a lit scene only
        // takes the processor path when the position comes from the fixed
        // pipeline.
        if ((scene.lighting && !scene.programs.vertex) || !drawables.has(context))
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
     * A copy of a framebuffer rectangle into a texture level, recorded as a
     * draw into that level; the level's texels on the processor are left as
     * they were, and are not what the GPU holds from here on.
     *
     * @param {object} context
     * @param {import('./objects.js').TextureObject} texture
     * @param {number} level @param {number} face
     * @param {number} xoffset @param {number} yoffset
     * @param {number} x @param {number} y
     * @param {number} width @param {number} height
     */
    const copyToTexture = (context, texture, level, face, xoffset, yoffset, x, y, width, height)=>{
        const target = drawables.get(context);
        if (!target || width <= 0 || height <= 0)
        {
            return;
        }
        const textureRecord = textureFor(texture);
        const key = levelKey(level, face);
        let view = textureRecord.views.get(key);
        if (!view)
        {
            const image = texture.levels.get(key);
            if (!image)
            {
                return;
            }
            view = {
                texture: textureRecord.gpu.texture,
                view: textureRecord.gpu.texture.createView({
                    label: `gl-texture:${texture.name}:${key}`,
                    dimension: '2d',
                    baseMipLevel: level,
                    mipLevelCount: 1,
                    baseArrayLayer: face,
                    arrayLayerCount: 1,
                }),
                width: image.width,
                height: image.height,
                format: TEXTURE_FORMAT,
                label: `gl-texture:${texture.name}:${key}`,
            };
            textureRecord.views.set(key, view);
        }
        const recording = recordingOf(context);
        const pipeline = pipelineFor(copyKey(TEXTURE_FORMAT), generateCopy(),
            showDescriptor(TEXTURE_FORMAT), SINGLE_TEXTURE_PLAN);
        const uniforms = new Float32Array(COPY_UNIFORM_FLOATS);
        uniforms.set([x, y, xoffset, yoffset, target.width, target.height], 0);
        recording.counts.copies++;
        if (dumpDraws)
        {
            recording.dump.push(`copy ${recording.counts.copies - 1}:`
                + ` framebuffer[${x},${y} ${width}x${height}]`
                + ` -> t${texture.name} level ${level} face ${face} at [${xoffset},${yoffset}]`);
        }
        recording.pipelines.push(pipeline);
        recording.commands.push({
            kind: 'copy',
            pipeline: recording.pipelines.length - 1,
            uniforms,
            target: view,
            scissor: clampRect({ x: xoffset, y: yoffset, width, height }, view),
        });
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
        const pipeline = pipelineFor(clearKey(state), generateClear(), clearDescriptor(state),
            NO_TEXTURE_PLAN);
        const uniforms = new Float32Array(CLEAR_UNIFORM_FLOATS);
        uniforms.set(request.colour.slice(0, 4), 0);
        uniforms[4] = Math.min(1, Math.max(0, request.depth));
        const box = request.scissor;
        stats.clears++;
        recording.counts.clears++;
        if (dumpDraws)
        {
            recording.dump.push(`clear ${recording.counts.clears - 1}:`
                + ` colour=[${request.colour.map(v=>Number(v.toFixed(4))).join(' ')}]`
                + ` depth=${request.depth} stencil=${request.stencil}`
                + ` mask=${hex(colourMask)}${depth ? '+depth' : ''}`
                + ` smask=${hex(stencilMask)}`
                + ` sc=${describeRect(clampRect(
                    { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 },
                    target))}`);
        }
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
    /**
     * The recording most recently presented. A probe is two read-backs a
     * replay waits for, and a replay that has fallen behind the recording
     * must not queue more waiting per frame than the guest -- so probes run
     * only while the frame being replayed is still the newest one, which is
     * also the frame whose dump the report reads.
     */
    /** @type {Recording | null} */
    let newest = null;
    /** @type {string[]} */
    const failures = [];

    /**
     * @param {Recording} recording
     * @param {DrawableSurfaces} target
     * @param {any} shown   the opaque copy this frame is shown through
     */
    const replay = async(recording, target, shown)=>{
        const show = pipelineFor(showKey(COLOUR_FORMAT), generateShow(),
            showDescriptor(COLOUR_FORMAT), SINGLE_TEXTURE_PLAN);
        const built = await Promise.allSettled([...recording.pipelines, show]);
        const frame = backend.beginFrame();
        const probing = recording === newest;
        // Which candidates the read-backs go to: the window the probe named,
        // or the frame's last draws sampling the texture. Chosen here, where
        // the frame is whole, rather than at record time, where its end is
        // not known yet.
        /** @type {Set<number>} */
        const probeAt = new Set();
        if (probing && probeSpec !== null)
        {
            /** @type {number[]} */
            const candidates = [];
            recording.commands.forEach((command, at)=>{
                if (command.probe >= 0 && (probeSpec.from === null
                    || (command.probeDraw >= probeSpec.from
                        && command.probeDraw <= probeSpec.to)))
                {
                    candidates.push(at);
                }
            });
            const chosen = probeSpec.from === null
                ? candidates.slice(-PROBE_LIMIT)
                : candidates.slice(0, PROBE_LIMIT);
            for (const at of chosen)
            {
                probeAt.add(at);
            }
        }
        /**
         * The probed draws' read-backs: what the target held before the draw
         * and after it, resolved once the frame has been submitted.
         *
         * @type {{ dump: number,
         *           rect: { x: number, y: number, width: number, height: number },
         *           command: any,
         *           before: () => Promise<any>,
         *           after: (() => Promise<any>) | null }[]}
         */
        const probes = [];
        try
        {
            /** @type {any} */
            let pass = null;
            /** @type {any} */
            let viewport = null;
            /** @type {any} */
            let scissor = null;
            let stencilReference = -1;
            const drawing = ()=>{
                if (pass)
                {
                    return pass;
                }
                pass = frame.beginPass({
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
                viewport = null;
                scissor = null;
                stencilReference = -1;
                return pass;
            };
            for (let at = 0; at < recording.commands.length; at++)
            {
                const command = recording.commands[at];
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
                if (command.kind === 'copy')
                {
                    // Into the level, reading the back buffer: its own pass,
                    // after which the drawing pass is reopened over what it
                    // holds.
                    const into = frame.beginPass({ target: command.target, clear: false });
                    into.setScissor(command.scissor);
                    into.setPipeline(pipeline.gpu);
                    into.setBindings(0, pipeline.layout, [
                        { binding: 0, resource: into.uniforms(command.uniforms) },
                        { binding: 1, resource: target.colour.view },
                        { binding: 2, resource: showSamplerFor() },
                    ]);
                    into.draw(3, 1, 0);
                    pass = null;
                    continue;
                }
                if (probeAt.has(at))
                {
                    // A snapshot closes the pass, so the drawing pass is
                    // reopened over what the target holds.
                    probes.push({ dump: command.probe, rect: command.scissor, command,
                        before: frame.snapshot(target.colour), after: null });
                    pass = null;
                }
                drawing();
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
                command.bindings.forEach((/** @type {any} */ bound)=>{
                    entries.push({ binding: bound.binding, resource: bound.view },
                        { binding: bound.binding + 1, resource: bound.sampler });
                });
                if (command.vertexUniforms)
                {
                    entries.push({
                        binding: VERTEX_PROGRAM_BINDING,
                        resource: pass.uniforms(command.vertexUniforms),
                    });
                }
                pass.setBindings(0, pipeline.groups[0], entries);
                if (command.fragmentUniforms)
                {
                    pass.setBindings(FRAGMENT_PROGRAM_GROUP,
                        pipeline.groups[FRAGMENT_PROGRAM_GROUP], [{
                            binding: FRAGMENT_PROGRAM_BINDING,
                            resource: pass.uniforms(command.fragmentUniforms),
                        }]);
                }
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
                if (probeAt.has(at))
                {
                    probes[probes.length - 1].after = frame.snapshot(target.colour);
                    pass = null;
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
        // The frame is submitted, so the probe read-backs resolve; each one
        // lands on its own dump line, which the report reads long after.
        for (const probe of probes)
        {
            const before = await probe.before();
            const after = probe.after ? await probe.after() : null;
            recording.dump[probe.dump] += ` before=${describeSnapshot(before, probe.rect)}`
                + (after ? ` after=${describeSnapshot(after, probe.rect)}` : '')
                + ` census=[${probe.command.bindings
                    .map((/** @type {RecordedBinding} */ b)=>describeCensus(b.texture))
                    .join(' ')}]`;
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
        copyToTexture,

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
            newest = recording;
            stats.frames++;
            if (dumpDraws)
            {
                const c = recording.counts;
                recording.dump.push(`frame ${stats.frames - 1}: draws=${c.draws}`
                    + ` clears=${c.clears} copies=${c.copies} refused=${c.refused}`
                    + ` skipped=${c.skipped} cut=${c.cut}`
                    + (maxDraws >= 0 ? ` (max-draws ${maxDraws})` : ''));
                lastDump = recording.dump;
            }
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
            // Empty unless the build asked for a dump; the probe texts of the
            // frame's draws land on its lines as the replay resolves them.
            lastDump,
        }),
    };
}

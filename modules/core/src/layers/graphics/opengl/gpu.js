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
import { createBufferReads } from './buffer-reads.js';
import { identity, invert, multiply, transpose } from './matrix.js';
import { normalMatrix } from './lighting.js';
import {
    FACE_STRIDE, attachmentImage, createTextureObject, isTextureComplete, levelKey,
} from './objects.js';
import { dxt1ToAstc, dxt1Transcodes } from '../webgpu/internal/astc.js';
import {
    CANONICAL_LAYOUT, clientReads, expandIndices, isList, lockedFor, packVertices, planLayout,
    scanIndices, topologyOf,
} from './gpu-layout.js';
import {
    FRAGMENT_PROGRAM_BINDING, FRAGMENT_PROGRAM_GROUP, VARYING_TEXCOORDS,
    VERTEX_PROGRAM_BINDING,
} from './arb-wgsl.js';
import {
    BLIT_UNIFORM_FLOATS, CLEAR_UNIFORM_FLOATS, CLIP_PLANES, COPY_UNIFORM_FLOATS, UNIFORM, UNITS,
    blitKey, clearDescriptor, clearKey, copyKey, drawDescriptor, drawKey, generateBlit,
    generateClear, generateCopy, generateDraw, generateShow, lightingStateOf, sameKeyInputs,
    showDescriptor, showKey, writeLighting,
} from './wgsl.js';
import { MATRIX_STATE as MATRIX_ONLY, packState } from './glsl-state.js';

/**
 * A framebuffer object is drawn upside down -- its first row GL's bottom
 * one, the row a texture made from it holds first -- and the window's back
 * buffer the right way up: `DrawTarget.flipped` says which a target is, and
 * the vertex stage (`uniforms.misc.z`), the viewport and scissor, the front
 * face and every copy between the two follow it.
 */

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

/** The base formats with an alpha of their own. @type {Set<number>} */
const HAS_ALPHA = new Set([GL.RGBA, GL.ALPHA, GL.LUMINANCE_ALPHA, GL.INTENSITY]);

/**
 * Where draws land: the window's back buffer, or a framebuffer object's
 * attachments, as views a pass opens on.
 *
 * @typedef {Object} DrawTarget
 * @property {string} key
 * @property {number} width
 * @property {number} height
 * @property {boolean} flipped  rows run up from GL's bottom one: a framebuffer object
 * @property {(any | null)[]} colours  per draw buffer, a view to write or null
 * @property {string[]} formats  per draw buffer, '' where none
 * @property {number[]} masks  per draw buffer, the channels it has (an RGB one no alpha)
 * @property {any | null} depth  the depth-stencil view, or none
 * @property {string} depthFormat  '' where there is none
 * @property {Set<object>} attached  the textures it draws into
 */

/**
 * The S3TC format a program uploaded → the block-compressed format a device
 * that has `texture-compression-bc` samples it as. Both DXT1 variants are the
 * same block layout; WebGPU has one BC1 format for either.
 *
 * @type {Readonly<Record<number, string>>}
 */
const BC_FORMATS = Object.freeze({
    [GL.COMPRESSED_RGB_S3TC_DXT1_EXT]: 'bc1-rgba-unorm',
    [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT]: 'bc1-rgba-unorm',
    [GL.COMPRESSED_RGBA_S3TC_DXT3_EXT]: 'bc2-rgba-unorm',
    [GL.COMPRESSED_RGBA_S3TC_DXT5_EXT]: 'bc3-rgba-unorm',
});

/** The format a DXT1 texture travels as where it is transcoded. */
const ASTC_FROM_DXT1 = 'astc-4x4-unorm';

/**
 * What a device with ASTC and no BC takes an S3TC format as: DXT1 only.
 * DXT3's and DXT5's alpha (sixteen explicit values, or eight steps between
 * two) would need a second plane of weights ASTC 4x4 has no room for at
 * their precision, and stays decoded.
 *
 * @type {Readonly<Record<number, string>>}
 */
const ASTC_FORMATS = Object.freeze({
    [GL.COMPRESSED_RGB_S3TC_DXT1_EXT]: ASTC_FROM_DXT1,
    [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT]: ASTC_FROM_DXT1,
});

/**
 * @typedef {Object} GpuServices
 * @property {any} backend
 * @property {(descriptor: any) => any} createSampler
 * @property {(detail: string) => void} [divergence]
 * @property {boolean} [dumpDraws]  describe every draw of the last frame
 * @property {number} [maxDraws]    stop a frame after this many draws
 * @property {string | null} [skipTexture]  drop draws sampling these ids
 * @property {{ dumpFrames: number, skipTexture?: string,
 *     written?: (lines: string[], frame: number) => void } | null} [liveDump]
 *           the graphics worker's switches a running program's page sets
 *           (`app.debug.dumpFrames`, `app.debug.skipTexture`), read at each
 *           frame's end for the next
 * @property {string | null} [probeTexture]  read the target around its draws
 * @property {boolean} [compressedTextures]  the device has `texture-compression-bc`:
 *           an S3TC texture whose every level kept its blocks travels as
 *           blocks instead of the texels the context decoded them into
 * @property {boolean} [astcTextures]  the device has `texture-compression-astc` and
 *           no BC: a DXT1 texture whose every level kept its blocks, none of
 *           them with a texel of the fourth colour, travels as ASTC 4x4 blocks
 *           (`webgpu/internal/astc.js`), a byte a texel where decoded it is four
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
export function describeSnapshot(shot, rect){
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
        const texels = level.texels;
        if (!texels)
        {
            distinct.push('gpu-only');
            continue;
        }
        const words = new Uint32Array(texels.buffer, texels.byteOffset, texels.byteLength >> 2);
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
 * @property {{ bytes: Uint8Array, type: number,
 *              buffer: import('./objects.js').BufferObject | null, offset: number } | null} indices
 * @property {readonly import('./gpu-layout.js').ArrayRequest[]} arrays
 * @property {(address: number, length: number) => Uint8Array} read   client memory
 * @property {(name: number) => import('./objects.js').BufferObject | undefined} bufferObject
 * @property {{ first: number, count: number, epoch: number } | null} [lock]
 *     GL_EXT_compiled_vertex_array's locked range, while the arrays are locked
 */

/**
 * @typedef {Object} ClearRequest
 * @property {{ fbo: any, width: number, height: number } | null} [target]  the framebuffer
 *     object cleared, or the window
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
 * Whether a stencil face's own test or write ever consults its reference:
 * `GL_ALWAYS` and `GL_NEVER` decide the test without it, and only `GL_REPLACE`
 * among the ops writes it into the buffer. A face for which this is false can
 * be given WebGPU's one shared reference in place of its own without
 * changing a pixel.
 *
 * @param {{ func: number, fail: number, zfail: number, zpass: number }} face
 * @returns {boolean}
 */
function readsStencilReference(face){
    return (face.func !== GL.ALWAYS && face.func !== GL.NEVER)
        || face.fail === GL.REPLACE || face.zfail === GL.REPLACE || face.zpass === GL.REPLACE;
}

/**
 * @param {GpuServices} services
 */
export function createGpuRenderer(services){
    const { backend, createSampler } = services;
    const BufferUsage = backend.BufferUsage;
    const TextureUsage = backend.TextureUsage;
    const liveDump = services.liveDump ?? null;
    // Whether this frame is written down, and which textures' draws it drops:
    // what the run asked at its start, or what a page asked of the running
    // program since -- changed at a frame's end, never in the middle of one.
    const fixedDump = services.dumpDraws === true;
    /** @type {Set<string>} */
    const fixedSkips = new Set((services.skipTexture ?? '').split(',').filter(Boolean));
    const liveSwitches = ()=>({
        dumping: fixedDump || (liveDump?.dumpFrames ?? 0) > 0,
        skips: liveDump?.skipTexture
            ? new Set(liveDump.skipTexture.split(',').filter(Boolean)) : fixedSkips,
    });
    let { dumping: dumpDraws, skips: skipTextures } = liveSwitches();
    const maxDraws = services.maxDraws === undefined ? -1 : services.maxDraws;
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
     * @property {DrawTarget} target  the back buffer as a target
     */
    /** @type {WeakMap<object, DrawableSurfaces>} context -> its drawable's surfaces */
    const drawables = new WeakMap();

    /**
     * @typedef {Object} Recording
     * @property {any[]} commands
     * @property {Promise<any>[]} pipelines  each distinct pipeline the frame uses, once
     * @property {Map<Promise<any>, number>} slots  a pipeline's place in `pipelines`
     * @property {number} id
     * @property {string[]} dump     the frame's lines, when one was asked for
     * @property {Set<string>} dumped  the program texts the dump already holds
     * @property {Map<string, any>} locked  the locked ranges this frame copied
     *     (`lockedFor`), by epoch, slot base and stride
     * @property {{ draws: number, clears: number, copies: number, refused: number,
     *               skipped: number, cut: number, merged: number }} counts
     */
    /** @type {WeakMap<object, Recording>} */
    const recordings = new WeakMap();
    let nextFrame = 1;
    /** Frames recorded and not yet flushed: what a buffer write may still collide with. */
    /** @type {Set<number>} */
    const unflushed = new Set();
    /** @param {number} frame */
    const isUnflushed = frame=>unflushed.has(frame);

    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    /**
     * A draw's generated source, by the same key its pipeline is cached under.
     * The pipeline is built from the source once; without this the source was
     * still built for every draw, which is per-draw work for identical state.
     *
     * @type {Map<string, ReturnType<typeof generateDraw>>}
     */
    const generatedDraws = new Map();
    /**
     * A draw's bind plan by the same key: the units it samples and its program
     * stages are folded into the key, so the plan is the key's as the source is.
     *
     * @type {Map<string, BindPlan>}
     */
    const plans = new Map();
    /** @type {Map<string, any>} */
    const samplers = new Map();
    const stats = {
        frames: 0, pipelines: 0, draws: 0, clears: 0, fallbacks: 0, uploads: 0, renames: 0,
        refused: 0, skipped: 0, cut: 0,
        // Texels let go once on the device, in bytes, and levels carried from
        // a texture's old copy to the one that replaced it (`textureFor`).
        letGo: 0, carried: 0,
        // Compressed levels a device without their blocks took decoded: the
        // blocks' bytes and the texels' they were uploaded as.
        decoded: { levels: 0, blockBytes: 0, texelBytes: 0 },
        // DXT1 levels a device with ASTC and no BC took as ASTC blocks.
        transcoded: { levels: 0, blockBytes: 0, astcBytes: 0 },
        // Draws a context assembled vertex by vertex rather than handed over
        // as arrays, and their vertices, by why (`noteAssembled`): each one
        // is processor work on the program's thread and again in a worker.
        assembled: { draws: 0, vertices: 0, byReason: /** @type {Record<string, number>} */ ({}) },
        // A draw's source is generated once per distinct state and reused after
        // that, the same shape the Direct3D 8 path counts: a frame of identical
        // shadow-volume draws is one generation, not one per draw.
        prepared: 0, preparedReused: 0,
        // The fixed and per-program-stage uniform blocks, counted the same
        // way: built fresh, or the previous draw's block handed back because
        // nothing it depends on has moved.
        uniformsBuilt: 0, uniformsReused: 0,
        programUniformsBuilt: 0, programUniformsReused: 0,
        glslUniformsBuilt: 0, glslUniformsReused: 0,
        // Blits between framebuffers, and mipmap levels made on the device.
        blits: 0, mipmaps: 0,
        // An index list's (min, max) scan and widened copy: built fresh, or
        // reused because the buffer it came from has not been written since.
        indexScansBuilt: 0, indexScansReused: 0,
        // Two draws joined into the one draw call their combined range reads
        // exactly as.
        merged: 0,
    };

    /**
     * @typedef {Object} BindPlan
     *     The bind group layout a generated module declares: the fixed
     *     uniform block, a texture pair per unit the fragment stage samples,
     *     and a uniform block per program stage.
     * @property {string} key
     * @property {{ binding: number, cube: boolean, unit: number, sampler?: number }[]} textures
     *     `sampler`: a GLSL program's sampler, whose unit is its uniform's value
     * @property {boolean} vertexBlock
     * @property {boolean} fragmentBlock
     * @property {boolean} [glsl]  the textures are visible to the vertex stage too
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
     * @param {import('./wgsl.js').GlslStages | null} [glsl]
     * @returns {BindPlan}
     */
    const bindPlanOf = (state, programs, glsl = null)=>{
        if (glsl && state.glsl)
        {
            const program = state.glsl.program;
            const textures = glsl.samplers.map(index=>({ binding: 1 + index * 2,
                cube: program.samplers[index].dim === 'Cube', unit: -1, sampler: index }))
                .sort((a, b)=>a.binding - b.binding);
            const vertexBlock = glsl.vertex !== null;
            const fragmentBlock = glsl.fragment !== null;
            const key = `g${textures.map(t=>`${t.binding}${t.cube ? 'c' : '2'}`).join(',')}|`
                + `${vertexBlock ? 'v' : ''}${fragmentBlock ? 'f' : ''}`;
            return { key, textures, vertexBlock, fragmentBlock, glsl: true };
        }
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
        // Built the same way drawKey is (see wgsl.js): a plain loop rather
        // than `.map().join()`, since this runs on every draw whether or not
        // the plan it names is already in `layouts`.
        let textureKey = '';
        for (let i = 0; i < textures.length; i++)
        {
            if (i > 0)
            {
                textureKey += ',';
            }
            textureKey += `${textures[i].binding}${textures[i].cube ? 'c' : '2'}`;
        }
        const key = `${textureKey}|${vertexBlock ? 'v' : ''}${fragmentBlock ? 'f' : ''}`;
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
            const visibility = plan.glsl ? VERTEX_STAGE | FRAGMENT_STAGE : FRAGMENT_STAGE;
            fixedEntries.push({
                binding: texture.binding,
                visibility,
                texture: texture.cube ? { viewDimension: 'cube' } : {},
            });
            fixedEntries.push({
                binding: texture.binding + 1, visibility, sampler: {},
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
                    fragment: { module, entryPoint: 'fragmentMain',
                        targets: descriptor.targets ?? [descriptor.target] },
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
     * The generated source of a draw, by the key its pipeline is cached under.
     *
     * A state that repeats -- and a shadow-volume frame repeats one state a
     * hundred times -- must not re-emit its WGSL a hundred times: the source
     * depends on the state alone, and the pipeline already reuses by the same
     * key. A refusal is cached too, so a program that cannot be generated says
     * so once rather than on every draw.
     *
     * @param {string} key
     * @param {import('./wgsl.js').DrawState} state
     * @returns {ReturnType<typeof generateDraw>}
     */
    const generatedFor = (key, state)=>{
        const existing = generatedDraws.get(key);
        if (existing !== undefined)
        {
            stats.preparedReused++;
            return existing;
        }
        const made = generateDraw(state);
        generatedDraws.set(key, made);
        stats.prepared++;
        return made;
    };

    /**
     * @typedef {Object} BufferRecord
     * @property {any} gpu    the dynamic buffer
     * @property {number} size
     * @property {ReturnType<typeof createBufferReads>} reads
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
     * @property {string} format   the surface's own format: `TEXTURE_FORMAT`,
     *           or a BC format when every level travels as blocks
     * @property {Map<number, any>} views   a level as a target, by level key, once drawn into
     * @property {number} [usedIn]  the last frame whose commands sample or write it
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
        // Each draw reads only what it wrote, so a wrap keeps nothing.
        let buffer = backend.createDynamicBuffer({ size, usage, label, keep: false });
        let cursor = 0;
        let fresh = true;
        return {
            /** @param {ArrayBufferView} view @returns {{ gpu: any, offset: number }} */
            write(view){
                const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
                const aligned = alignUp(bytes.byteLength);
                if (aligned > buffer.size)
                {
                    backend.releaseDynamicBuffer?.(buffer);
                    buffer = backend.createDynamicBuffer({ size: aligned * 2, usage, label,
                        keep: false });
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

    /**
     * The sampler a texture's filter and wrap parameters describe, read off
     * the texture itself while its parameters version has not moved since
     * the last draw that asked -- a descriptor object and its `JSON.stringify`
     * key are only built again when `glTexParameter*` actually changed
     * something, not once per unit per draw.
     *
     * @type {WeakMap<import('./objects.js').TextureObject, { version: number, sampler: any }>}
     */
    const samplerByTexture = new WeakMap();
    /** @param {import('./objects.js').TextureObject} texture */
    const samplerFor = texture=>{
        const cached = samplerByTexture.get(texture);
        if (cached && cached.version === texture.parametersVersion)
        {
            return cached.sampler;
        }
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
        let sampler = samplers.get(key);
        if (!sampler)
        {
            sampler = createSampler({ label: `gl-sampler:${key}`, ...descriptor });
            samplers.set(key, sampler);
        }
        samplerByTexture.set(texture, { version: texture.parametersVersion, sampler });
        return sampler;
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
     * The block format every level of a texture travels as, when the device
     * can sample it and every level still holds the blocks it arrived in --
     * one level rewritten by `glTexSubImage2D` (decoded, never re-compressed)
     * falls the whole texture back to `null`, the uncompressed path.
     *
     * @param {import('./objects.js').TextureObject} texture
     * @param {number} levels
     * @param {boolean} cube
     * @returns {string | null}
     */
    const bcFormatOf = (texture, levels, cube)=>{
        if (!services.compressedTextures && !services.astcTextures)
        {
            return null;
        }
        const formats = services.compressedTextures ? BC_FORMATS : ASTC_FORMATS;
        let format = null;
        for (let level = 0; level < levels; level++)
        {
            for (let face = 0; face < (cube ? 6 : 1); face++)
            {
                const image = texture.levels.get(levelKey(level, face));
                const mapped = image?.compressed ? formats[image.compressed.format] : undefined;
                if (!mapped || (format !== null && format !== mapped)
                    || (mapped === ASTC_FROM_DXT1 && !transcodable(/** @type {any} */ (image))))
                {
                    return null;
                }
                // WebGPU validates a compressed texture's own (base level's)
                // size against the block size -- unlike a copy's, a mip
                // smaller than a block does not round up here; faces of a
                // cube share the base's size, so this rules the whole texture.
                if (level === 0 && image && (image.width % 4 !== 0 || image.height % 4 !== 0))
                {
                    return null;
                }
                format = mapped;
            }
        }
        return format;
    };

    /**
     * Whether a DXT1 level's blocks transcode to ASTC, asked of its blocks
     * once: a texture's format is settled at each use.
     *
     * @type {WeakMap<Uint8Array, boolean>}
     */
    const transcodes = new WeakMap();
    /** @param {{ compressed: { bytes: Uint8Array }, width: number, height: number }} image */
    const transcodable = image=>{
        const { bytes } = image.compressed;
        let known = transcodes.get(bytes);
        if (known === undefined)
        {
            known = dxt1Transcodes(bytes, image.width, image.height);
            transcodes.set(bytes, known);
        }
        return known;
    };

    /** The levels whose texels were let go once on the device (`textureFor`). */
    /** @type {WeakSet<object>} */
    const releasedLevels = new WeakSet();

    /**
     * The bytes of one rectangle of a level's decoded texels, packed with no
     * gap between rows -- what an upload of just that rectangle needs, since
     * the level itself is a full-width buffer.
     *
     * @param {import('./objects.js').TextureLevel} image
     * @param {import('./objects.js').DirtyRect} rect
     * @returns {Uint8Array}
     */
    const sliceRect = (image, rect)=>{
        // Read once: a compressed level on a device decodes at each read.
        const texels = image.texels;
        if (!texels)
        {
            // A level given a shape and no data -- what a framebuffer object
            // draws into -- holds black, opaque where its format has no
            // alpha, which reads as one.
            const blank = new Uint8Array(rect.width * rect.height * 4);
            if (!HAS_ALPHA.has(image.baseFormat))
            {
                for (let at = 3; at < blank.length; at += 4)
                {
                    blank[at] = 255;
                }
            }
            return blank;
        }
        if (rect.x === 0 && rect.width === image.width)
        {
            return texels.subarray(rect.y * image.width * 4,
                (rect.y + rect.height) * image.width * 4);
        }
        const packed = new Uint8Array(rect.width * rect.height * 4);
        for (let row = 0; row < rect.height; row++)
        {
            const from = ((rect.y + row) * image.width + rect.x) * 4;
            packed.set(texels.subarray(from, from + rect.width * 4), row * rect.width * 4);
        }
        return packed;
    };

    /**
     * The GPU copy of a texture, uploaded or brought up to date for a command
     * of `recording`.
     *
     * @param {import('./objects.js').TextureObject} texture
     * @param {Recording} recording
     * @returns {TextureRecord}
     */
    const textureFor = (texture, recording)=>{
        const cube = texture.target === GL.TEXTURE_CUBE_MAP;
        const base = /** @type {import('./objects.js').TextureLevel} */ (
            texture.levels.get(levelKey(0)));
        // The mip chain the base level defines, as GL's completeness reads it:
        // each level half the one above, down to 1x1 and no further. A level
        // past that, or one of another size, is not in the chain -- three 1x1
        // levels on a 1x1 texture are one level -- and a surface given it is
        // refused, and with it every frame that samples the texture.
        const chain = Math.floor(Math.log2(Math.max(1, base.width, base.height))) + 1;
        let levels = 0;
        while (levels < chain)
        {
            const level = texture.levels.get(levelKey(levels));
            if (!level || level.width !== Math.max(1, base.width >> levels)
                || level.height !== Math.max(1, base.height >> levels))
            {
                break;
            }
            levels++;
        }
        const bcFormat = bcFormatOf(texture, levels, cube);
        const format = bcFormat ?? TEXTURE_FORMAT;
        let record = textures.get(texture);
        /** The copy a changed shape replaces: what it holds of a let-go level is carried over. */
        let previous = null;
        if (record && (record.width !== base.width || record.height !== base.height
            || record.levels !== levels || record.cube !== cube || record.format !== format))
        {
            previous = record;
            record = undefined;
        }
        /** Whether a level was carried over on the device, which the uploads must follow. */
        let carried = false;
        if (!record)
        {
            record = {
                gpu: backend.createSurface({
                    width: base.width,
                    height: base.height,
                    format,
                    mipLevelCount: levels,
                    layers: cube ? 6 : 1,
                    dimension: cube ? 'cube' : undefined,
                    label: `gl-texture:${texture.name}`,
                    // A target too: a program copies its framebuffer into a
                    // level, and that copy is a draw into it -- except a BC
                    // surface, which WebGPU refuses a render attachment usage
                    // on, and which this level shape never needs one for: a
                    // copy target is never compressed.
                    usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                        | TextureUsage.COPY_SRC
                        | (bcFormat ? 0 : TextureUsage.RENDER_ATTACHMENT),
                }),
                width: base.width,
                height: base.height,
                levels,
                cube,
                format,
                views: new Map(),
            };
            textures.set(texture, record);
            // A fresh copy has every level to receive: from the texels kept
            // here, or, for a level whose texels were let go, from the copy
            // it replaces, on the device -- and then a rectangle written
            // since goes up after it.
            for (const [key, image] of texture.levels)
            {
                if (!releasedLevels.has(image))
                {
                    texture.dirty.set(key, null);
                    continue;
                }
                const level = key % FACE_STRIDE;
                const face = (key - level) / FACE_STRIDE;
                if (previous !== null && previous.format === format && level < previous.levels
                    && level < levels && face < (previous.cube ? 6 : 1)
                    && image.width === Math.max(1, previous.width >> level)
                    && image.height === Math.max(1, previous.height >> level))
                {
                    recording.commands.push({ kind: 'carry', from: previous.gpu.texture,
                        to: record.gpu.texture, level, face, width: image.width,
                        height: image.height });
                    stats.carried++;
                    carried = true;
                    continue;
                }
                texture.dirty.set(key, null);
                diverge('a texture was made again on the device in a shape its old copy does'
                    + ' not hold, after its texels were let go: those levels upload as black');
            }
        }
        // The queue runs a direct write before every frame not yet flushed,
        // so one whose commands already use the texture would see texels
        // written after them; the upload then takes its place among the
        // commands of the frame being recorded.
        const ordered = carried
            || (record.usedIn !== undefined && unflushed.has(record.usedIn));
        /** @param {any} request */
        const upload = request=>{
            if (ordered)
            {
                recording.commands.push({ kind: 'upload', upload: { ...request, staging: true } });
                return;
            }
            backend.uploadTexture(request);
        };
        for (const [key, rect] of texture.dirty)
        {
            const level = key % FACE_STRIDE;
            const face = (key - level) / FACE_STRIDE;
            const image = texture.levels.get(key);
            if (!image || level >= levels || face >= (cube ? 6 : 1))
            {
                continue;
            }
            stats.uploads++;
            if (bcFormat)
            {
                const compressed = /** @type {NonNullable<typeof image.compressed>} */ (
                    image.compressed);
                // Transcoded, the blocks are bytes of their own already.
                const astc = bcFormat === ASTC_FROM_DXT1
                    ? /** @type {Uint8Array} */ (dxt1ToAstc(compressed.bytes, image.width,
                        image.height))
                    : null;
                if (astc)
                {
                    stats.transcoded.levels++;
                    stats.transcoded.blockBytes += compressed.bytes.byteLength;
                    stats.transcoded.astcBytes += astc.byteLength;
                }
                upload({
                    texture: record.gpu.texture,
                    format: bcFormat,
                    mipLevel: level,
                    width: image.width,
                    height: image.height,
                    origin: { x: 0, y: 0, z: face },
                    data: astc ?? (ordered ? compressed.bytes.slice() : compressed.bytes),
                });
                continue;
            }
            const area = rect ?? { x: 0, y: 0, width: image.width, height: image.height };
            if (image.compressed && rect === null)
            {
                stats.decoded.levels++;
                stats.decoded.blockBytes += image.compressed.bytes.byteLength;
                stats.decoded.texelBytes += image.width * image.height * 4;
            }
            upload({
                texture: record.gpu.texture,
                format: TEXTURE_FORMAT,
                mipLevel: level,
                width: area.width,
                height: area.height,
                origin: { x: area.x, y: area.y, z: face },
                // A command keeps bytes of its own: the slice may be a view
                // of the level the program goes on writing.
                data: ordered ? sliceRect(image, area).slice() : sliceRect(image, area),
            });
        }
        texture.dirty.clear();
        record.usedIn = recording.id;
        // Uploaded, a level's texels are the device's; kept here as well,
        // every texture a program loaded was held twice in this worker (the
        // Doom 3 demo's first level: 161 MB of them). They are let go: a
        // rectangle written later goes up alone, from texels made for it, and
        // a copy made again in another shape takes the level from the one it
        // replaces. A level past the chain was never uploaded and keeps its
        // own; one decoded from blocks never held any. A run that dumps or
        // probes its draws from its start keeps them for the dump's census.
        if (!bcFormat && !fixedDump && probeSpec === null)
        {
            for (const [key, image] of texture.levels)
            {
                const level = key % FACE_STRIDE;
                const texels = Object.getOwnPropertyDescriptor(image, 'texels')?.value;
                if (level < levels && texels)
                {
                    stats.letGo += texels.byteLength;
                    image.texels = null;
                    releasedLevels.add(image);
                }
            }
        }
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
        /** @type {number} */
        let capacity = Math.max(4, alignUp(buffer.size));
        if (record && record.size !== buffer.size)
        {
            if (buffer.size <= record.gpu.size)
            {
                // Given another size that still fits: the same backing takes
                // the new contents, which the store marked written.
                record.size = buffer.size;
            }
            else
            {
                // Outgrown: the old backing goes, and the new one has room to
                // grow again -- a program that keeps respecifying a buffer at
                // other sizes made a backing for every size, each kept.
                backend.releaseDynamicBuffer?.(record.gpu);
                capacity = Math.max(4, 2 ** Math.ceil(Math.log2(alignUp(buffer.size))));
                record = undefined;
            }
        }
        if (!record)
        {
            record = {
                gpu: backend.createDynamicBuffer({
                    size: capacity,
                    usage: BufferUsage.VERTEX | BufferUsage.INDEX | BufferUsage.COPY_DST,
                    label: `gl-buffer:${buffer.name}`,
                }),
                size: buffer.size,
                reads: createBufferReads(isUnflushed),
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
        const collides = record.reads.overlaps(written.start, written.end);
        if (collides)
        {
            stats.renames++;
            record.reads.clear();
        }
        const lock = record.gpu.lock(written.start, written.end - written.start,
            collides ? backend.LockFlags.RENAME : backend.LockFlags.NOOVERWRITE);
        lock.data.set(buffer.data.subarray(written.start, written.end));
        record.gpu.unlock(lock);
        return record;
    };

    /**
     * A pipeline's place in the frame's list, the replay awaiting each
     * distinct pipeline once rather than once per draw that uses it.
     *
     * @param {Recording} recording @param {Promise<any>} pipeline
     */
    const pipelineSlot = (recording, pipeline)=>{
        let slot = recording.slots.get(pipeline);
        if (slot === undefined)
        {
            slot = recording.pipelines.length;
            recording.pipelines.push(pipeline);
            recording.slots.set(pipeline, slot);
        }
        return slot;
    };

    /** @param {object} context */
    const recordingOf = context=>{
        let recording = recordings.get(context);
        if (!recording)
        {
            recording = {
                commands: [], pipelines: [], slots: new Map(), id: nextFrame++, dump: [],
                // The locked ranges this frame copied, by epoch, slot base and stride.
                /** @type {Map<string, any>} */
                locked: new Map(),
                dumped: new Set(),
                counts: {
                    draws: 0, clears: 0, copies: 0, refused: 0, skipped: 0, cut: 0, merged: 0,
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
    // A bound texture GL leaves out of the draw -- incomplete, so the unit is
    // off -- marked `!`: what a surface meant to be textured is drawn without.
    const dumpBound = scene=>scene.boundTextures.length === 0 ? '' : ` bound=[${
        scene.boundTextures.map((bound, unit)=>
            `${unit}:${bound?.twoD
                ? `t${bound.twoD.name}${isTextureComplete(bound.twoD) ? '' : '!'}` : '-'}`
            + `${bound?.cube ? `c t${bound.cube.name}` : ''}`).join(' ')}]`;

    /**
     * The scene's viewport and scissor as target rectangles: GL measures both
     * from the bottom-left corner and the target from the top-left.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @param {{ width: number, height: number, flipped?: boolean }} target
     */
    const rectangles = (scene, target)=>{
        const [x, y, width, height] = scene.viewport;
        const viewport = clampRect({
            x, y: target.flipped ? y : target.height - y - height, width, height,
        }, target);
        const box = scene.scissor;
        const scissor = clampRect({
            x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0,
        }, target);
        const [near, far] = scene.depthRange;
        return {
            viewport: { ...viewport, minDepth: Math.min(near, far), maxDepth: Math.max(near, far) },
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
     * @param {DrawTarget} target
     * @returns {import('./wgsl.js').DrawState}
     */
    const drawStateOf = (scene, layout, topology, target)=>{
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
        const colourMask = (mask[0] ? 1 : 0) | (mask[1] ? 2 : 0) | (mask[2] ? 4 : 0)
            | (mask[3] ? 8 : 0);
        const glsl = scene.programs.glsl;
        const vertexShader = glsl?.linked.vertex != null;
        return {
            attributes: layout.attributes,
            strides: layout.slots.map(slot=>slot.stride),
            topology,
            targetFormat: target.formats[0] || COLOUR_FORMAT,
            depthFormat: target.depthFormat,
            targets: target.flipped
                ? target.formats.map((/** @type {string} */ format, /** @type {number} */ k)=>
                    ({ format, mask: colourMask & target.masks[k] }))
                : undefined,
            glsl: glsl ? { id: glsl.id, program: glsl.linked } : null,
            twoSide: glsl ? scene.twoSide : false,
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
                // The depth buffer is not updated while the test is disabled,
                // whatever the mask; WebGPU would write under 'always'.
                write: operations.depthTest !== undefined && operations.depthWrite,
            },
            stencil: scene.stencil,
            stencilBack: scene.stencilBack,
            cull: cullMode === undefined ? 'none' : cullMode === GL.FRONT ? 'front' : 'back',
            // Drawn upside down, a framebuffer object's triangles turn the
            // other way round.
            frontIsCcw: target.flipped ? !scene.frontIsCcw : scene.frontIsCcw,
            viewportHeight: target.height,
            colourMask,
            polygonOffset: scene.polygonOffset,
            vertexProgram: scene.programs.vertex,
            fragmentProgram: scene.programs.fragment,
            // A vertex program takes the place of the fixed stage, lighting and all.
            lighting: scene.programs.vertex || vertexShader ? null
                : lightingStateOf(scene.lighting),
            clip: vertexShader ? null : clipStateOf(scene),
        };
    };

    /** Whether the device clips by the distances a vertex stage writes. */
    const clipDistances = backend.hasFeature?.('clip-distances') === true;

    /**
     * The user clip planes a draw is clipped by: the fixed vertex stage
     * writes a distance to each enabled one, which the device clips by where
     * it can, and which the fragment stage discards by otherwise. A vertex
     * program clips by nothing here (the specification has it write its own
     * clip coordinates only under ARB_position_invariant), and a fragment
     * program leaves no place to discard in: there the planes need the device.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @returns {{ count: number, distances: boolean } | null}
     */
    const clipStateOf = scene=>{
        const count = Math.min(scene.clipPlanes.length, CLIP_PLANES);
        if (count === 0 || scene.programs.vertex)
        {
            return null;
        }
        if (!clipDistances && scene.programs.fragment)
        {
            diverge('user clip planes were enabled under a fragment program on a device'
                + ' without clip-distances, and nothing was clipped');
            return null;
        }
        return { count, distances: clipDistances };
    };

    /**
     * The projection-times-modelview product, recomputed only when either
     * factor has actually moved since the context's last draw. Both stacks
     * replace `.current` with a fresh matrix on every push, pop or multiply
     * (`matrix.js` never mutates one in place), so the identity of the two
     * factors is already a value comparison, not a call-was-made one: a
     * light re-drawn with the view and object it had last time reads the
     * very Float64Arrays it read then.
     *
     * @type {WeakMap<object, { modelview: any, projection: any, mvp: Float64Array }>}
     */
    const mvpCache = new WeakMap();
    /**
     * @param {object} context
     * @param {import('./pipeline.js').Scene} scene
     * @returns {Float64Array}
     */
    const mvpFor = (context, scene)=>{
        const cached = mvpCache.get(context);
        if (cached && cached.modelview === scene.modelview
            && cached.projection === scene.projection)
        {
            return cached.mvp;
        }
        const mvp = multiply(scene.projection, scene.modelview);
        mvpCache.set(context, { modelview: scene.modelview, projection: scene.projection, mvp });
        return mvp;
    };

    /** @param {readonly number[]} a @param {readonly number[]} b */
    const sameNumbers = (a, b)=>{
        if (a.length !== b.length)
        {
            return false;
        }
        for (let i = 0; i < a.length; i++)
        {
            if (a[i] !== b[i])
            {
                return false;
            }
        }
        return true;
    };

    /**
     * Whether two scenes' active units read the same into the fixed block:
     * the same units, in the same order, each with the same matrix and
     * environment colour reference -- both replaced wholesale on an actual
     * change (`matrix.js`'s stacks; `env.colour = [...]` in
     * `context-textures.js`), never mutated in place, so identity already
     * means "unchanged". A unit with texture-coordinate generation active is
     * always read as changed: the plane arrays are stable but the generated
     * `modes` array is rebuilt fresh every `scene()` call, and the feature is
     * rare enough that comparing it is not worth its own tracking here.
     *
     * @param {readonly import('./pipeline.js').SceneUnit[]} a
     * @param {readonly import('./pipeline.js').SceneUnit[]} b
     */
    const sameUnits = (a, b)=>{
        if (a.length !== b.length)
        {
            return false;
        }
        for (let i = 0; i < a.length; i++)
        {
            const ua = a[i];
            const ub = b[i];
            if (ua.index !== ub.index || ua.matrix !== ub.matrix
                || ua.env.colour !== ub.env.colour || ua.generation !== null
                || ub.generation !== null)
            {
                return false;
            }
        }
        return true;
    };

    /**
     * @param {import('./pipeline.js').Scene['current']} a
     * @param {import('./pipeline.js').Scene['current']} b
     */
    const sameCurrent = (a, b)=>{
        if (a === b)
        {
            return true;
        }
        if (!sameNumbers(a.color, b.color) || !sameNumbers(a.secondary, b.secondary)
            || !sameNumbers(a.normal, b.normal) || a.fogCoord !== b.fogCoord
            || a.texCoords.length !== b.texCoords.length)
        {
            return false;
        }
        for (let i = 0; i < a.texCoords.length; i++)
        {
            if (!sameNumbers(a.texCoords[i], b.texCoords[i]))
            {
                return false;
            }
        }
        return true;
    };

    /**
     * @param {readonly (readonly number[])[]} a @param {readonly (readonly number[])[]} b
     */
    const sameClipPlanes = (a, b)=>a.length === b.length
        && a.every((plane, i)=>plane[0] === b[i][0] && plane[1] === b[i][1]
            && plane[2] === b[i][2] && plane[3] === b[i][3]);

    /**
     * @param {import('./pipeline.js').Scene['fog']} a
     * @param {import('./pipeline.js').Scene['fog']} b
     */
    const sameFog = (a, b)=>{
        if (a === b)
        {
            return true;
        }
        if (a === null || b === null)
        {
            return false;
        }
        return a.mode === b.mode && a.density === b.density && a.start === b.start
            && a.end === b.end && a.fromCoordinate === b.fromCoordinate && a.colour === b.colour;
    };

    /**
     * GL lets the near value be the greater, and maps depth backwards; a
     * WebGPU viewport's range only runs forwards. So the viewport takes the
     * range in order, and the vertex stage turns the depth round in it.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @returns {number} 1, or -1 for a range run backwards
     */
    const depthDirectionOf = scene=>(scene.depthRange[0] > scene.depthRange[1] ? -1 : 1);

    /**
     * @param {import('./pipeline.js').Scene['alphaTest']} a
     * @param {import('./pipeline.js').Scene['alphaTest']} b
     */
    const sameAlphaTest = (a, b)=>{
        if (a === b)
        {
            return true;
        }
        if (a === null || b === null)
        {
            return false;
        }
        return a.func === b.func && a.reference === b.reference;
    };

    /**
     * The fixed uniform block of the last draw a context recorded, kept only
     * to be reused when nothing it was built from has moved.
     *
     * @type {WeakMap<object, { mvp: Float64Array,
     *           units: readonly import('./pipeline.js').SceneUnit[],
     *           current: import('./pipeline.js').Scene['current'],
     *           fog: import('./pipeline.js').Scene['fog'],
     *           alphaTest: import('./pipeline.js').Scene['alphaTest'],
     *           depthDirection: number, ySign: number, height: number,
     *           modelview: ArrayLike<number>,
     *           block: Float32Array, lit: boolean,
     *           clipPlanes: readonly (readonly number[])[] }>}
     */
    const fixedUniformsCache = new WeakMap();

    /**
     * Sixteen numbers compared as numbers: a matrix a program reloads with
     * the same values is a new array on the stack and the same matrix here.
     *
     * @param {ArrayLike<number>} a @param {ArrayLike<number>} b
     */
    const sameMatrix = (a, b)=>{
        if (a === b)
        {
            return true;
        }
        if (a.length !== b.length)
        {
            return false;
        }
        for (let i = 0; i < a.length; i++)
        {
            if (a[i] !== b[i])
            {
                return false;
            }
        }
        return true;
    };

    /**
     * The uniform block of a draw: the matrices, the current values and the
     * per-unit constants, in the layout the shader declares.
     *
     * A program may set a dozen environment parameters before every draw,
     * but most repeat between consecutive draws, and this block depends on
     * none of them directly -- it is the matrices, the per-unit texture
     * environment and the current vertex attributes that move, and every one
     * of those is compared by value (see `sameMatrix`, `sameUnits`,
     * `sameCurrent`, `sameFog`, `sameAlphaTest`): a `glLoadMatrixf` of the
     * same sixteen numbers, which a program drawing a screen's text does
     * once per glyph, is not a change. A draw that repeats every one of them
     * gets back the very block the previous draw built, with no
     * `normalMatrix` call and no allocation -- and `joinLastDraw` can then
     * fold it into the draw before it.
     *
     * @param {object} context
     * @param {import('./pipeline.js').Scene} scene
     * @param {Float64Array} mvp   the projection-times-modelview product, the
     *          draw's own so it is not multiplied out a second time for a
     *          program stage that reads the same matrix (see `stateMatrixRow`)
     * @param {{ flipped: boolean, height: number }} target
     */
    const uniformsOf = (context, scene, mvp, target)=>{
        const ySign = target.flipped ? -1 : 1;
        const cached = fixedUniformsCache.get(context);
        // ponytail: a lit draw's block is built anew -- the scene's lighting is
        // a fresh record each draw; compare its values if lit draws ever
        // need to join one another.
        if (cached && !scene.lighting && !cached.lit
            && sameClipPlanes(cached.clipPlanes, scene.clipPlanes) && sameMatrix(cached.mvp, mvp)
            && sameMatrix(cached.modelview, scene.modelview)
            && sameUnits(cached.units, scene.units)
            && sameCurrent(cached.current, scene.current) && sameFog(cached.fog, scene.fog)
            && sameAlphaTest(cached.alphaTest, scene.alphaTest)
            && cached.depthDirection === depthDirectionOf(scene) && cached.ySign === ySign
            && cached.height === target.height)
        {
            stats.uniformsReused++;
            return cached.block;
        }
        stats.uniformsBuilt++;
        const block = new Float32Array(UNIFORM.floats);
        block.set(mvp, UNIFORM.modelViewProjection);
        block.set(scene.modelview, UNIFORM.modelView);
        const nm = normalMatrix(scene.modelview);
        const nmAt = UNIFORM.normalMatrix;
        block[nmAt] = nm[0];
        block[nmAt + 1] = nm[1];
        block[nmAt + 2] = nm[2];
        block[nmAt + 4] = nm[3];
        block[nmAt + 5] = nm[4];
        block[nmAt + 6] = nm[5];
        block[nmAt + 8] = nm[6];
        block[nmAt + 9] = nm[7];
        block[nmAt + 10] = nm[8];
        block[nmAt + 15] = 1;
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
        const normalAt = UNIFORM.normal;
        block[normalAt] = current.normal[0];
        block[normalAt + 1] = current.normal[1];
        block[normalAt + 2] = current.normal[2];
        const texCoords = current.texCoords;
        const texCoordCount = Math.min(texCoords.length, VARYING_TEXCOORDS);
        for (let unit = 0; unit < texCoordCount; unit++)
        {
            const coords = texCoords[unit];
            const tcAt = UNIFORM.texCoord + unit * 4;
            block[tcAt] = coords[0];
            block[tcAt + 1] = coords[1] ?? 0;
            block[tcAt + 2] = coords[2] ?? 0;
            block[tcAt + 3] = coords[3] ?? 1;
        }
        if (scene.fog)
        {
            block.set(scene.fog.colour, UNIFORM.fogColor);
            const fogAt = UNIFORM.fogParams;
            block[fogAt] = scene.fog.density;
            block[fogAt + 1] = scene.fog.start;
            block[fogAt + 2] = scene.fog.end;
            block[fogAt + 3] = current.fogCoord;
        }
        block[UNIFORM.misc] = scene.alphaTest ? scene.alphaTest.reference : 0;
        const depthDirection = depthDirectionOf(scene);
        block[UNIFORM.misc + 1] = depthDirection;
        block[UNIFORM.misc + 2] = ySign;
        block[UNIFORM.misc + 3] = target.height;
        if (scene.lighting)
        {
            writeLighting(block, scene.lighting);
        }
        const clipCount = Math.min(scene.clipPlanes.length, CLIP_PLANES);
        for (let plane = 0; plane < clipCount; plane++)
        {
            block.set(scene.clipPlanes[plane], UNIFORM.clipPlanes + plane * 4);
        }
        fixedUniformsCache.set(context, {
            mvp, modelview: scene.modelview, units: scene.units, current: scene.current,
            fog: scene.fog, alphaTest: scene.alphaTest, depthDirection, block,
            lit: scene.lighting !== null, clipPlanes: scene.clipPlanes, ySign,
            height: target.height,
        });
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
     * @param {Float64Array} mvp   the draw's own projection-times-modelview product
     * @returns {number[]}
     */
    const stateMatrixRow = (scene, slot, mvp)=>{
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
                m = mvp;
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
     * The state matrix a `'matrix'`-sourced slot reads, before its modifier:
     * the same selection `stateMatrixRow` makes, kept separate so a cache can
     * ask "is the input the same" without inverting or transposing it.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @param {import('./arb-wgsl.js').ParamSlot} slot
     * @param {Float64Array} mvp
     * @returns {ArrayLike<number>}
     */
    const matrixRefFor = (scene, slot, mvp)=>{
        switch (slot.matrix)
        {
            case 'modelview':
                return slot.number === 0 ? scene.modelview : IDENTITY;
            case 'projection':
                return scene.projection;
            case 'mvp':
                return mvp;
            default:
                return scene.textureMatrices[slot.number ?? 0] ?? IDENTITY;
        }
    };

    /**
     * A stage's uniform block, kept per `needs` object -- itself already
     * cached per generated draw state (`generatedFor`), so the same `needs`
     * comes back for every draw that shares a pipeline. Reused when the
     * program is the same load, its local and environment files have not
     * changed value since (`localVersion`/`envVersion`, bumped only on an
     * actual write -- see `context-programs.js`), every `'matrix'`-sourced
     * slot reads the same matrix reference as last time, and every generic
     * attribute fallback still reads the same four floats.
     *
     * @type {WeakMap<import('./arb-wgsl.js').StageNeeds, { programName: number,
     *           programVersion: number, envVersion: number, localVersion: number,
     *           matrixRefs: (ArrayLike<number> | undefined)[],
     *           generic: (readonly number[] | null)[], block: Float32Array }>}
     */
    const programUniformsCache = new WeakMap();

    /**
     * A program stage's uniform block: its materialised parameters in slot
     * order, then the current values of the generic attributes that have no
     * array behind them.
     *
     * @param {import('./arb-wgsl.js').StageNeeds} needs
     * @param {import('./pipeline.js').SceneProgram} program
     * @param {import('./pipeline.js').Scene} scene
     * @param {Float64Array} mvp   the draw's own projection-times-modelview product
     * @returns {Float32Array}
     */
    const programUniforms = (needs, program, scene, mvp)=>{
        const cached = programUniformsCache.get(needs);
        if (cached && cached.programName === program.name
            && cached.programVersion === program.version
            && cached.envVersion === program.envVersion
            && cached.localVersion === program.localVersion)
        {
            let same = true;
            for (let i = 0; same && i < needs.params.length; i++)
            {
                const slot = needs.params[i];
                if (slot.source === 'matrix'
                    && matrixRefFor(scene, slot, mvp) !== cached.matrixRefs[i])
                {
                    same = false;
                }
            }
            for (let i = 0; same && i < needs.genericFallbacks.length; i++)
            {
                const value = scene.genericAttribs[needs.genericFallbacks[i]];
                const previous = cached.generic[i];
                if ((value ?? null) === null && previous === null)
                {
                    continue;
                }
                if (!value || !previous || !sameNumbers(value, previous))
                {
                    same = false;
                }
            }
            if (same)
            {
                stats.programUniformsReused++;
                return cached.block;
            }
        }
        stats.programUniformsBuilt++;
        const parameterCount = Math.max(1, needs.params.length);
        const block = new Float32Array((parameterCount + needs.genericFallbacks.length) * 4);
        /** @type {(ArrayLike<number> | undefined)[]} */
        const matrixRefs = new Array(needs.params.length);
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
                case 'matrix': {
                    const ref = matrixRefFor(scene, slot, mvp);
                    matrixRefs[index] = ref;
                    block.set(stateMatrixRow(scene, slot, mvp), index * 4);
                    break;
                }
                default:
                    break;
            }
        });
        /** @type {(readonly number[] | null)[]} */
        const generic = needs.genericFallbacks.map(attrib=>{
            const value = scene.genericAttribs[attrib];
            return value ? [...value] : null;
        });
        needs.genericFallbacks.forEach((attrib, k)=>{
            const value = scene.genericAttribs[attrib];
            if (value)
            {
                block.set(value, (parameterCount + k) * 4);
            }
        });
        programUniformsCache.set(needs, {
            programName: program.name, programVersion: program.version,
            envVersion: program.envVersion, localVersion: program.localVersion,
            matrixRefs, generic, block,
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

    /** @param {string} format */
    const indexBytes = format=>(format === 'uint32' ? 4 : 2);

    /**
     * @param {readonly { gpu: any, offset: number }[]} a
     * @param {readonly { gpu: any, offset: number }[]} b
     */
    const sameSlots = (a, b)=>a.length === b.length
        && a.every((slot, i)=>slot.gpu === b[i].gpu && slot.offset === b[i].offset);

    /**
     * @param {readonly RecordedBinding[]} a
     * @param {readonly RecordedBinding[]} b
     */
    const sameBindings = (a, b)=>a.length === b.length
        && a.every((entry, i)=>entry.binding === b[i].binding && entry.view === b[i].view
            && entry.sampler === b[i].sampler);

    /**
     * @param {{ x: number, y: number, width: number, height: number }} a
     * @param {{ x: number, y: number, width: number, height: number }} b
     */
    const matchRect = (a, b)=>a.x === b.x && a.y === b.y && a.width === b.width
        && a.height === b.height;

    /**
     * @param {any} a @param {any} b
     */
    const shareEveryDependency = (a, b)=>a.mergeKey === b.mergeKey && a.first === 0
        && b.first === 0 && a.baseVertex === b.baseVertex
        && a.indices.format === b.indices.format && a.indices.gpu === b.indices.gpu
        && a.uniforms === b.uniforms && a.vertexUniforms === b.vertexUniforms
        && a.fragmentUniforms === b.fragmentUniforms && sameSlots(a.slots, b.slots)
        && sameBindings(a.bindings, b.bindings) && matchRect(a.viewport, b.viewport)
        && matchRect(a.scissor, b.scissor) && a.stencilReference === b.stencilReference
        && a.target === b.target && sameColour(a.blendConstant, b.blendConstant);

    /** @param {any} a @param {any} b */
    const sameColour = (a, b)=>a === b || (!!a && !!b && a.r === b.r && a.g === b.g
        && a.b === b.b && a.a === b.a);

    /**
     * Joins the draw just pushed into the one before it in the same
     * recording, when the join is provably picture-identical: the same
     * pipeline, bindings and uniform blocks -- the state-version cache above
     * already makes "unchanged" the identical array, not merely an equal
     * one, so this is reference equality, not a byte compare -- the same
     * vertex slots and base vertex, and an index range whose bytes the
     * earlier draw's own are immediately followed by in the scratch ring,
     * with no alignment gap between them, so one draw covering both ranges
     * reads exactly what the two separate ones would, in the same order,
     * touching every pixel exactly as many times as the two draws together
     * would have -- which is what keeps this safe under any blend, stencil
     * or logic-op state, accumulating or not, unlike dropping an exact
     * repeat of the same range outright would be (see `report-perdraw-2.md`,
     * "what did not pay"). Only two indexed draws are considered: every draw
     * this layer's own title issues is `glDrawElements`, and a non-indexed
     * draw carries no such byte adjacency to prove the join safe.
     *
     * @param {Recording} recording
     */
    const joinLastDraw = recording=>{
        const commands = recording.commands;
        if (commands.length < 2)
        {
            return;
        }
        const b = commands[commands.length - 1];
        const a = commands[commands.length - 2];
        if (a.kind !== 'draw' || b.kind !== 'draw' || !a.indices || !b.indices
            || !shareEveryDependency(a, b)
            || b.indices.offset !== a.indices.offset + a.count * indexBytes(a.indices.format))
        {
            return;
        }
        a.count += b.count;
        commands.pop();
        stats.draws--;
        recording.counts.draws--;
        stats.merged++;
        recording.counts.merged++;
    };

    /**
     * The state and key of the draw before: most draws keep both, and the key
     * is a long string to build.
     *
     * @type {{ state: import('./wgsl.js').DrawState, key: string } | null}
     */
    let lastDraw = null;

    /**
     * The first vertex of an immediate-mode draw, for the dump line: what the
     * program handed over, before any of it reached the device.
     *
     * @type {any}
     */
    let packedSample = null;

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
        const surfaces = drawables.get(context);
        if (!surfaces)
        {
            return;
        }
        const target = targetOf(surfaces, scene.target ?? null, recordingOf(context));
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
        if (scene.stencilBack && scene.stencil
            && (scene.stencilBack.readMask !== scene.stencil.readMask
                || scene.stencilBack.writeMask !== scene.stencil.writeMask
                || (scene.stencilBack.reference !== scene.stencil.reference
                    && readsStencilReference(scene.stencilBack))))
        {
            diverge('GL_EXT_stencil_two_side set a different reference or mask on each face:'
                + ' WebGPU has one stencil reference and one read and write mask shared by'
                + ' both, so the front face\'s were applied to the back face\'s test too');
        }
        const state = drawStateOf(scene, layout, topology, target);
        const key = lastDraw !== null && sameKeyInputs(state, lastDraw.state)
            ? lastDraw.key : drawKey(state);
        lastDraw = { state, key };
        const generated = generatedFor(key, state);
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
        let plan = plans.get(key);
        if (plan === undefined)
        {
            plan = bindPlanOf(state, generated.programs, generated.glsl ?? null);
            plans.set(key, plan);
        }
        const executable = scene.programs.glsl;
        const sampled = plan.textures.map(entry=>{
            let texture = entry.sampler !== undefined && executable
                ? textureForSampler(scene, executable, entry)
                : textureForBinding(scene, entry, plan.fragmentBlock);
            // Sampled while it is drawn into: GL leaves it undefined, and
            // WebGPU refuses the pass.
            if (target.attached.has(texture))
            {
                diverge('a draw sampled a texture its framebuffer draws into, and sampled'
                    + ' black instead');
                texture = incompleteTexture(entry.cube);
            }
            return { entry, texture };
        });
        // The id strings are read only by the skip filter and the dump; a
        // frame that asks for neither never needs to build one, per draw.
        const ids = skipTextures.size > 0 || dumpDraws
            ? sampled.map(({ entry, texture })=>`t${texture.name}${entry.cube ? 'c' : ''}`)
            : null;
        if (ids && skipTextures.size > 0 && ids.some(id=>skipTextures.has(id)))
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
            view: textureFor(texture, recording).gpu.view,
            sampler: samplerFor(texture),
            texture,
        }));
        // The descriptor only when the key has no pipeline yet: it is a dozen
        // objects a draw, for a state that repeats all frame.
        const pipeline = pipelines.get(key)
            ?? pipelineFor(key, generated, drawDescriptor(state), plan);
        // One draw, one MVP: shared with any program stage that reads the
        // same state matrix, instead of each reader multiplying it out again
        // -- and, when the view and the object are both what the previous
        // draw had, the one that draw already computed.
        const mvp = mvpFor(context, scene);
        const uniforms = uniformsOf(context, scene, mvp, target);
        const glslStages = generated.glsl ?? null;
        const vertexUniforms = glslStages && executable
            ? glslStages.vertex && glslUniforms(glslStages.vertex, executable, scene, mvp)
            : generated.programs?.vertex && state.vertexProgram
                ? programUniforms(generated.programs.vertex, state.vertexProgram, scene, mvp)
                : null;
        const fragmentUniforms = glslStages && executable
            ? glslStages.fragment && glslUniforms(glslStages.fragment, executable, scene, mvp)
            : generated.programs?.fragment && state.fragmentProgram
                ? programUniforms(generated.programs.fragment, state.fragmentProgram, scene, mvp)
                : null;
        stats.draws++;
        recording.counts.draws++;
        const rects = rectangles(scene, target);
        let probe = -1;
        if (dumpDraws)
        {
            // Reaching here means `dumpDraws` was true above, so `ids` was built.
            const dumpIds = /** @type {string[]} */ (ids);
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
                        + (state.stencilBack && (state.stencilBack.func !== state.stencil.func
                            || state.stencilBack.fail !== state.stencil.fail
                            || state.stencilBack.zfail !== state.stencil.zfail
                            || state.stencilBack.zpass !== state.stencil.zpass)
                            ? `/back:${hex(state.stencilBack.func)},`
                                + `${hex(state.stencilBack.fail)},${hex(state.stencilBack.zfail)},`
                                + `${hex(state.stencilBack.zpass)}`
                            : '')
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
                + ` tex=[${sampled.map(({ entry, texture }, i)=>{
                    const copy = textures.get(texture);
                    const base = texture.levels.get(levelKey(0));
                    return `${entry.binding}:${dumpIds[i]}`
                        + (copy ? `:${copy.width}x${copy.height}/${copy.levels}` : '')
                        + (base ? `:if${hex(base.internalFormat)}/${hex(base.baseFormat)}` : '')
                        + `:min${hex(texture.parameters.get(GL.TEXTURE_MIN_FILTER) ?? 0)}`;
                }).join(' ')}]`
                + dumpPrograms(recording, state)
                + dumpBound(scene)
                + (packedSample
                    ? ` v0=[colour ${packedSample.color?.map((/** @type {number} */ v)=>
                        v.toFixed(3)).join(' ')} tc0 ${packedSample.texCoords?.[0]?.map(
                        (/** @type {number} */ v)=>v.toFixed(3)).join(' ')}]`
                    : '')
                + ` uni=${describeBlock(uniforms)}`
                + ` vuni=${describeBlock(vertexUniforms)}`
                + ` funi=${describeBlock(fragmentUniforms)}`);
            // After the push: the program texts a first sight of a program
            // adds are entries of their own, ahead of this line. Every draw
            // sampling the probed texture is a candidate; which of them the
            // replay reads around is decided there, where the frame is whole.
            probe = probeSpec !== null && dumpIds.includes(probeSpec.id)
                ? recording.dump.length - 1 : -1;
        }
        recording.commands.push({
            kind: 'draw',
            pipeline: pipelineSlot(recording, pipeline),
            mergeKey: key,
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
            target,
            blendConstant: blendConstantOf(scene.blend, scene.blendColor ?? [0, 0, 0, 0]),
            probe,
            probeDraw: recording.counts.draws - 1,
        });
        // A dump or a probe addresses a frame's draws by number to find a
        // specific painter or a specific moment; joining two of them into
        // one would take away exactly the resolution that mode exists for.
        // The picture is identical either way, so only the diagnostic loses
        // anything, and only while it is asked for.
        if (!dumpDraws)
        {
            joinLastDraw(recording);
        }
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
     * The texture a GLSL program's sampler reads: what its uniform's unit
     * has bound for the sampler's target, the incomplete texture's value
     * when nothing complete is.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @param {any} executable
     * @param {{ cube: boolean, sampler?: number }} entry
     * @returns {import('./objects.js').TextureObject}
     */
    const textureForSampler = (scene, executable, entry)=>{
        const sampler = executable.linked.samplers[/** @type {number} */ (entry.sampler)];
        const unit = executable.ints[sampler.leaf.offset + sampler.element];
        const bound = scene.boundTextures[unit];
        const texture = sampler.dim === 'Cube' ? bound?.cube
            : sampler.dim === '1D' ? bound?.oneD : bound?.twoD;
        return texture && isTextureComplete(texture) ? texture : incompleteTexture(entry.cube);
    };

    /**
     * The constant colour a draw's blend reads: GL's, or for constant-alpha
     * factors alone its alpha in every channel, which is how WebGPU's one
     * constant stands for them (`wgsl.js` BLEND_FACTOR). Null when the blend
     * reads none.
     *
     * @param {any} blend @param {readonly number[]} colour
     * @returns {{ r: number, g: number, b: number, a: number } | null}
     */
    const blendConstantOf = (blend, colour)=>{
        if (!blend)
        {
            return null;
        }
        const factors = [blend.src, blend.dst, blend.srcAlpha ?? blend.src,
            blend.dstAlpha ?? blend.dst];
        const colours = factors.some(f=>f === GL.CONSTANT_COLOR
            || f === GL.ONE_MINUS_CONSTANT_COLOR);
        const alphas = factors.some(f=>f === GL.CONSTANT_ALPHA
            || f === GL.ONE_MINUS_CONSTANT_ALPHA);
        if (!colours && !alphas)
        {
            return null;
        }
        if (colours && alphas)
        {
            diverge('a blend read both the constant colour and the constant alpha: WebGPU has'
                + ' one constant, and the colour was used for both');
        }
        const [r, g, b, a] = colour;
        return colours ? { r, g, b, a } : { r: a, g: a, b: a, a };
    };

    /**
     * A GLSL stage's uniform block: the program's uniform values where the
     * plan copies them, the state uniforms it reads, and the current values
     * of attributes the draw has no array for. Kept per plan while the
     * program's values, the matrices the state reads and the attributes'
     * values stay what they were.
     *
     * @type {WeakMap<object, { id: number, version: number, refs: any[],
     *     values: number[], block: Float32Array }>}
     */
    const glslBlocks = new WeakMap();
    /**
     * @param {import('./glsl-wgsl.js').BlockPlan} plan @param {any} executable
     * @param {import('./pipeline.js').Scene} scene @param {Float64Array} mvp
     * @returns {Float32Array}
     */
    const glslUniforms = (plan, executable, scene, mvp)=>{
        const matricesOnly = plan.state.every(s=>MATRIX_ONLY.test(s.name));
        const refs = plan.state.length === 0 ? [] : [scene.modelview, scene.projection, mvp];
        /** @type {number[]} */
        const values = [];
        for (const attrib of plan.attribs)
        {
            values.push(...currentValueOf(scene, attrib));
        }
        if (plan.state.some(s=>s.name === 'gl_DepthRange'))
        {
            values.push(...scene.depthRange);
        }
        const cached = glslBlocks.get(plan);
        if (cached && cached.id === executable.id && cached.version === executable.version
            && matricesOnly && cached.refs.every((ref, k)=>ref === refs[k])
            && sameNumbers(cached.values, values))
        {
            stats.glslUniformsReused++;
            return cached.block;
        }
        stats.glslUniformsBuilt++;
        const block = new Float32Array(plan.words);
        const words = new Uint32Array(block.buffer);
        const store = new Uint32Array(executable.store);
        const copies = plan.copies;
        for (let k = 0; k < copies.length; k += 3)
        {
            words.set(store.subarray(copies[k], copies[k] + copies[k + 2]), copies[k + 1]);
        }
        for (const entry of plan.state)
        {
            packState(entry.name, /** @type {any} */ (scene), mvp, block, entry.offset);
        }
        for (const attrib of plan.attribs)
        {
            block.set(currentValueOf(scene, attrib), attrib.offset);
        }
        glslBlocks.set(plan, { id: executable.id, version: executable.version, refs, values,
            block });
        return block;
    };

    /**
     * An attribute's current value: a generic one's, or a conventional
     * attribute's current colour, normal, coordinates or fog coordinate.
     *
     * @param {import('./pipeline.js').Scene} scene
     * @param {{ location: number, builtin: string | null }} attrib
     * @returns {readonly number[]}
     */
    const currentValueOf = (scene, attrib)=>{
        const current = scene.current;
        switch (attrib.builtin)
        {
            case 'gl_Color':
                return current.color;
            case 'gl_SecondaryColor':
                return current.secondary;
            case 'gl_Normal':
                return [current.normal[0], current.normal[1], current.normal[2], 0];
            case 'gl_FogCoord':
                return [current.fogCoord, 0, 0, 1];
            case null:
                return scene.genericAttribs[attrib.location] ?? [0, 0, 0, 1];
            default: {
                const unit = Number(attrib.builtin.slice('gl_MultiTexCoord'.length));
                return current.texCoords[unit] ?? [0, 0, 0, 1];
            }
        }
    };

    /**
     * The views a framebuffer object draws into, as a target: one for each
     * draw buffer and its depth-stencil attachment, kept while the object
     * and the GPU copies of what it holds stay the same.
     *
     * @type {WeakMap<object, { version: number, records: any[], target: DrawTarget }>}
     */
    const fboTargets = new WeakMap();
    /**
     * @param {DrawableSurfaces} surfaces
     * @param {{ fbo: any, width: number, height: number } | null} bound
     * @param {Recording} recording
     * @returns {DrawTarget | null}
     */
    const targetOf = (surfaces, bound, recording)=>{
        if (!bound)
        {
            return surfaces.target;
        }
        const fbo = bound.fbo;
        /** @type {any[]} */
        const records = [];
        const views = fbo.drawBuffers.map((/** @type {number} */ buffer)=>{
            const attachment = buffer === GL.NONE ? undefined : fbo.attachments.get(buffer);
            const view = attachment ? attachmentView(attachment, recording, false) : null;
            records.push(view);
            return view;
        });
        const depthAttachment = fbo.attachments.get(GL.DEPTH_ATTACHMENT)
            ?? fbo.attachments.get(GL.STENCIL_ATTACHMENT);
        const depth = depthAttachment ? attachmentView(depthAttachment, recording, true) : null;
        records.push(depth);
        const cached = fboTargets.get(fbo);
        if (cached && cached.version === fbo.version
            && cached.records.every((held, k)=>held === records[k]))
        {
            return cached.target;
        }
        while (views.length > 1 && views[views.length - 1] === null)
        {
            views.pop();
        }
        if (views.every((/** @type {any} */ v)=>v === null) && !depth)
        {
            return null;
        }
        /** @type {Set<object>} */
        const attached = new Set();
        for (const attachment of fbo.attachments.values())
        {
            if (attachment.kind === 'texture')
            {
                attached.add(attachment.texture);
            }
        }
        /** @type {DrawTarget} */
        const target = {
            key: `fbo${fbo.name}.${fbo.version}`,
            width: bound.width, height: bound.height, flipped: true,
            colours: views,
            formats: views.map((/** @type {any} */ v)=>(v ? TEXTURE_FORMAT : '')),
            masks: fbo.drawBuffers.slice(0, views.length).map((/** @type {number} */ buffer)=>{
                const attachment = fbo.attachments.get(buffer);
                const image = attachment ? attachmentImage(attachment) : null;
                const base = image ? baseFormatOfImage(attachment) : GL.RGBA;
                return HAS_ALPHA.has(base) ? 0xf : 0x7;
            }),
            depth, depthFormat: depth ? DEPTH_FORMAT : '', attached,
        };
        fboTargets.set(fbo, { version: fbo.version, records, target });
        return target;
    };

    /** @param {any} attachment @returns {number} */
    const baseFormatOfImage = attachment=>{
        if (attachment.kind === 'texture')
        {
            return attachment.texture.levels.get(levelKey(attachment.level, attachment.face))
                ?.baseFormat ?? GL.RGBA;
        }
        const format = attachment.renderbuffer.internalFormat;
        return format === GL.RGB || format === GL.RGB8 || format === GL.RGB565
            || format === GL.RGB16 ? GL.RGB : GL.RGBA;
    };

    /** A renderbuffer's GPU surface, made again when its storage is. */
    /** @type {WeakMap<object, { version: number, surface: any }>} */
    const renderbufferSurfaces = new WeakMap();

    /**
     * The view one attachment is drawn into: a texture level's, or a
     * renderbuffer's surface. A texture level drawn into is the device's
     * from then on, as a level copied from the framebuffer is: when the
     * texture is made again in another shape, it is carried over rather than
     * uploaded blank.
     *
     * @param {any} attachment @param {Recording} recording @param {boolean} depth
     * @returns {any}
     */
    const attachmentView = (attachment, recording, depth)=>{
        if (attachment.kind === 'renderbuffer')
        {
            const rb = attachment.renderbuffer;
            let made = renderbufferSurfaces.get(rb);
            if (!made || made.version !== rb.version)
            {
                made = {
                    version: rb.version,
                    surface: backend.createSurface({
                        width: Math.max(1, rb.width), height: Math.max(1, rb.height),
                        format: depth ? DEPTH_FORMAT : TEXTURE_FORMAT,
                        label: `gl-renderbuffer:${rb.name}`,
                        usage: depth ? TextureUsage.RENDER_ATTACHMENT
                            : TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                                | TextureUsage.COPY_SRC,
                    }),
                };
                renderbufferSurfaces.set(rb, made);
            }
            return made.surface;
        }
        return levelView(attachment.texture, attachment.level, attachment.face, recording);
    };

    /**
     * A texture level as a target and a source: a view of it alone.
     *
     * @param {import('./objects.js').TextureObject} texture
     * @param {number} level @param {number} face @param {Recording} recording
     * @returns {any}
     */
    const levelView = (texture, level, face, recording)=>{
        const textureRecord = textureFor(texture, recording);
        const key = levelKey(level, face);
        const image = texture.levels.get(key);
        if (image)
        {
            releasedLevels.add(image);
        }
        let view = textureRecord.views.get(key);
        if (!view)
        {
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
                width: image?.width ?? 1,
                height: image?.height ?? 1,
                format: TEXTURE_FORMAT,
                label: `gl-texture:${texture.name}:${key}`,
            };
            textureRecord.views.set(key, view);
        }
        return view;
    };

    /**
     * Draws vertices assembled on the processor, packed into the canonical
     * layout.
     *
     * @param {object} context
     * @param {() => import('./pipeline.js').Scene} scene  built when the draw is recorded
     * @param {number} mode
     * @param {readonly import('./pipeline.js').PipelineVertex[]} vertices
     */
    const drawPacked = (context, scene, mode, vertices)=>{
        if (vertices.length === 0)
        {
            return;
        }
        const expanded = expandIndices(mode, null, vertices.length);
        if (expanded?.length === 0)
        {
            // A fan, a strip or a polygon too short for a triangle draws nothing.
            return;
        }
        packedSample = dumpDraws ? vertices[0] : null;
        const packed = scratchVertices.write(packVertices(vertices));
        const indices = expanded
            ? { ...scratchIndices.write(expanded), format: 'uint32', count: expanded.length }
            : null;
        record(context, scene(), CANONICAL_LAYOUT, [packed], indices,
            indices ? indices.count : vertices.length, 0, 0, topologyOf(mode));
    };

    /**
     * The `(min, max)` an index list reaches and its GPU-ready widened copy,
     * kept per index buffer object so a static mesh redrawn under several
     * lights -- the census found interaction draws sharing one mesh across
     * up to five -- is scanned once, not once per light. Only an index list
     * that lives in a bound `ELEMENT_ARRAY_BUFFER` is cacheable this way:
     * `buffer.version` (raised on every `glBufferDataARB`, `glBufferSubDataARB`
     * or write-back unmap) is what tells a rewritten buffer from the one
     * already scanned. An index list read from client memory, or one a seam
     * call already dereferenced into its own scratch bytes, carries no such
     * object and is scanned fresh every draw, the way it always was.
     *
     * @type {WeakMap<import('./objects.js').BufferObject, { version: number,
     *           type: number, offset: number, count: number,
     *           scanned: import('./gpu-layout.js').ScannedIndices }>}
     */
    const indexScanCache = new WeakMap();
    /**
     * @param {NonNullable<DrawRequest['indices']>} indices
     * @param {number} count
     * @returns {import('./gpu-layout.js').ScannedIndices}
     */
    const scannedIndicesFor = (indices, count)=>{
        if (!indices.buffer)
        {
            return scanIndices(indices.bytes, indices.type, count);
        }
        const cached = indexScanCache.get(indices.buffer);
        if (cached && cached.version === indices.buffer.version && cached.type === indices.type
            && cached.offset === indices.offset && cached.count === count)
        {
            stats.indexScansReused++;
            return cached.scanned;
        }
        stats.indexScansBuilt++;
        const scanned = scanIndices(indices.bytes, indices.type, count);
        indexScanCache.set(indices.buffer, {
            version: indices.buffer.version, type: indices.type, offset: indices.offset,
            count, scanned,
        });
        return scanned;
    };

    /**
     * @param {object} context
     * @param {DrawRequest} request
     * @param {() => import('./pipeline.js').Scene} scene  built when the draw is recorded
     */
    const drawArrays = (context, request, scene)=>{
        if (!drawables.has(context))
        {
            return false;
        }
        const layout = planLayout(request.arrays);
        if (!layout)
        {
            stats.fallbacks++;
            return false;
        }
        const scanned = request.indices ? scannedIndicesFor(request.indices, request.count) : null;
        if (request.count === 0)
        {
            return true;
        }
        if (layout.slots.some(slot=>slot.buffer !== 0 && !request.bufferObject(slot.buffer)))
        {
            return false;
        }
        const list = isList(request.mode);
        const expanded = list ? null : /** @type {Uint32Array} */ (expandIndices(request.mode,
            scanned ? scanned.indices : null, request.count));
        if (expanded?.length === 0)
        {
            // Too few vertices for one of its primitives: nothing is drawn.
            return true;
        }
        const min = scanned ? scanned.min : request.first;
        const max = scanned ? scanned.max : request.first + request.count - 1;
        // A draw inside a locked range reads the whole range, once an epoch
        // and frame: the passes of a surface drawn from it bind that copy.
        const lock = lockedFor(request, min, max);
        const { from, reads } = lock
            ? clientReads(layout.slots, lock.first, lock.first + lock.count - 1)
            : clientReads(layout.slots, min, max);
        const slots = layout.slots.map((slot, index)=>{
            const read = reads[index];
            if (read && lock)
            {
                const copies = recordingOf(context).locked;
                const key = `${lock.epoch}:${slot.base}:${slot.stride}`;
                const kept = copies.get(key);
                if (kept)
                {
                    return kept;
                }
                const copy = scratchVertices.write(request.read(read.at, read.length));
                copies.set(key, copy);
                return copy;
            }
            if (read)
            {
                return scratchVertices.write(request.read(read.at, read.length));
            }
            const gpuBuffer = bufferFor(/** @type {any} */ (request.bufferObject(slot.buffer)));
            const recording = recordingOf(context);
            gpuBuffer.reads.note(recording.id, slot.base + min * slot.stride,
                slot.base + (max + 1) * slot.stride);
            return { gpu: gpuBuffer.gpu.gpu, offset: slot.base };
        });
        /** @type {{ gpu: any, offset: number, format: string, count: number } | null} */
        let indices = null;
        if (scanned && list)
        {
            indices = { ...scratchIndices.write(scanned.indices), format: scanned.format,
                count: scanned.indices.length };
        }
        else if (expanded)
        {
            // A range drawn through its mode's order starts at `first`: the
            // base vertex says so, and the order -- shared, cached by mode and
            // count (`expandMode`) -- is not written.
            indices = {
                ...scratchIndices.write(expanded), format: 'uint32', count: expanded.length,
            };
        }
        packedSample = null;
        record(context, scene(), layout, slots,
            indices, indices ? indices.count : request.count,
            indices ? 0 : request.first - from,
            (expanded && !scanned ? request.first : 0) - from, topologyOf(request.mode));
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
    const copyToTexture = (context, texture, level, face, xoffset, yoffset, x, y, width,
        height, readFbo = null)=>
    {
        const surfaces = drawables.get(context);
        if (!surfaces || width <= 0 || height <= 0 || !texture.levels.get(levelKey(level, face)))
        {
            return;
        }
        const recording = recordingOf(context);
        const source = sourceOf(surfaces, readFbo, recording);
        if (!source)
        {
            return;
        }
        const view = levelView(texture, level, face, recording);
        if (source.view === view)
        {
            diverge('a texture level was copied from the framebuffer it is attached to, and'
                + ' nothing was copied');
            return;
        }
        const pipeline = pipelineFor(copyKey(TEXTURE_FORMAT), generateCopy(),
            showDescriptor(TEXTURE_FORMAT), SINGLE_TEXTURE_PLAN);
        const uniforms = new Float32Array(COPY_UNIFORM_FLOATS);
        uniforms.set([x, y, xoffset, yoffset, source.width, source.height,
            source.flipped ? -1 : 1], 0);
        recording.counts.copies++;
        if (dumpDraws)
        {
            recording.dump.push(`copy ${recording.counts.copies - 1}:`
                + ` framebuffer[${x},${y} ${width}x${height}]`
                + ` -> t${texture.name} level ${level} face ${face} at [${xoffset},${yoffset}]`);
        }
        recording.commands.push({
            kind: 'copy',
            pipeline: pipelineSlot(recording, pipeline),
            uniforms,
            target: view,
            source: source.view,
            sampler: showSamplerFor(),
            scissor: clampRect({ x: xoffset, y: yoffset, width, height }, view),
        });
    };

    /**
     * What a read of the framebuffer reads: the read framebuffer's read
     * buffer, or the window's back buffer.
     *
     * @param {DrawableSurfaces} surfaces @param {any} readFbo @param {Recording} recording
     * @returns {{ view: any, width: number, height: number, flipped: boolean } | null}
     */
    const sourceOf = (surfaces, readFbo, recording)=>{
        if (!readFbo)
        {
            return { view: surfaces.colour, width: surfaces.width, height: surfaces.height,
                flipped: false };
        }
        const attachment = readFbo.attachments.get(readFbo.readBuffer);
        const image = attachment ? attachmentImage(attachment) : null;
        if (!attachment || !image || image.holds !== 'colour')
        {
            return null;
        }
        return { view: attachmentView(attachment, recording, false), width: image.width,
            height: image.height, flipped: true };
    };

    /**
     * glBlitFramebuffer's colour: the read framebuffer's rectangle drawn into
     * each of the draw framebuffer's draw buffers' one, scaled and filtered,
     * either one mirrored by its corners' order.
     *
     * @param {object} context
     * @param {{ srcX0: number, srcY0: number, srcX1: number, srcY1: number, dstX0: number,
     *     dstY0: number, dstX1: number, dstY1: number, linear: boolean }} request
     * @param {import('./pipeline.js').Scene} scene  the draw target's, and the read one's
     */
    const blit = (context, request, scene)=>{
        const surfaces = drawables.get(context);
        if (!surfaces)
        {
            return;
        }
        const recording = recordingOf(context);
        const source = sourceOf(surfaces, scene.readFramebuffer ?? null, recording);
        const target = targetOf(surfaces, scene.target ?? null, recording);
        if (!source || !target)
        {
            return;
        }
        const uniforms = new Float32Array(BLIT_UNIFORM_FLOATS);
        uniforms.set([request.srcX0, request.srcY0, request.srcX1, request.srcY1,
            request.dstX0, request.dstY0, request.dstX1, request.dstY1,
            source.width, source.height, source.flipped ? -1 : 1, 0,
            target.width, target.height, target.flipped ? -1 : 1, 0], 0);
        const x0 = Math.min(request.dstX0, request.dstX1);
        const x1 = Math.max(request.dstX0, request.dstX1);
        const y0 = Math.min(request.dstY0, request.dstY1);
        const y1 = Math.max(request.dstY0, request.dstY1);
        const scissor = clampRect({ x: x0, y: target.flipped ? y0 : target.height - y1,
            width: x1 - x0, height: y1 - y0 }, target);
        target.colours.forEach((view, k)=>{
            if (!view || view === source.view)
            {
                return;
            }
            const format = target.formats[k];
            const pipeline = pipelineFor(blitKey(format), generateBlit(), showDescriptor(format),
                SINGLE_TEXTURE_PLAN);
            stats.blits++;
            recording.commands.push({
                kind: 'copy', pipeline: pipelineSlot(recording, pipeline), uniforms,
                target: view, source: source.view, scissor,
                sampler: request.linear ? linearSamplerFor() : showSamplerFor(),
            });
        });
    };

    /**
     * glGenerateMipmap on the device: each level drawn from the one above
     * it, filtered, once the texture's copy holds them all.
     *
     * @param {object} context @param {import('./objects.js').TextureObject} texture
     */
    const generateMipmap = (context, texture)=>{
        if (!drawables.has(context))
        {
            return;
        }
        const recording = recordingOf(context);
        const copy = textureFor(texture, recording);
        const faces = copy.cube ? 6 : 1;
        const pipeline = pipelineFor(blitKey(copy.format), generateBlit(),
            showDescriptor(copy.format), SINGLE_TEXTURE_PLAN);
        for (let face = 0; face < faces; face++)
        {
            for (let level = 1; level < copy.levels; level++)
            {
                const from = levelView(texture, level - 1, face, recording);
                const to = levelView(texture, level, face, recording);
                const uniforms = new Float32Array(BLIT_UNIFORM_FLOATS);
                uniforms.set([0, 0, from.width, from.height, 0, 0, to.width, to.height,
                    from.width, from.height, -1, 0, to.width, to.height, -1, 0], 0);
                stats.mipmaps++;
                recording.commands.push({
                    kind: 'copy', pipeline: pipelineSlot(recording, pipeline), uniforms,
                    target: to, source: from, sampler: linearSamplerFor(),
                    scissor: { x: 0, y: 0, width: to.width, height: to.height },
                });
            }
        }
    };

    /** The sampler a filtered blit and a mipmap level read through. */
    let linearSampler = /** @type {any} */ (null);
    const linearSamplerFor = ()=>{
        if (!linearSampler)
        {
            linearSampler = createSampler({ label: 'gl-blit-linear', magFilter: 'linear',
                minFilter: 'linear' });
        }
        return linearSampler;
    };

    /**
     * @param {object} context
     * @param {ClearRequest} request
     */
    const clear = (context, request)=>{
        const surfaces = drawables.get(context);
        if (!surfaces)
        {
            return;
        }
        const recording = recordingOf(context);
        const target = targetOf(surfaces, request.target ?? null, recording);
        if (!target)
        {
            return;
        }
        const mask = request.mask;
        const colourMask = mask & GL.COLOR_BUFFER_BIT
            ? (request.colourMask[0] ? 1 : 0) | (request.colourMask[1] ? 2 : 0)
                | (request.colourMask[2] ? 4 : 0) | (request.colourMask[3] ? 8 : 0)
            : 0;
        const hasDepth = target.depthFormat !== '';
        const depth = (mask & GL.DEPTH_BUFFER_BIT) !== 0 && request.depthMask && hasDepth;
        const stencilMask = mask & GL.STENCIL_BUFFER_BIT && hasDepth
            ? request.stencilMask & 0xff : 0;
        if (colourMask === 0 && !depth && stencilMask === 0)
        {
            return;
        }
        const state = { targetFormat: target.formats[0] || COLOUR_FORMAT,
            depthFormat: target.depthFormat, colourMask, depth, stencilMask,
            targets: target.flipped ? target.formats.map((format, k)=>({ format,
                mask: colourMask & target.masks[k] })) : undefined };
        const pipeline = pipelineFor(clearKey(state), generateClear(state.targets?.length ?? 1),
            clearDescriptor(state), NO_TEXTURE_PLAN);
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
        recording.commands.push({
            kind: 'draw',
            pipeline: pipelineSlot(recording, pipeline),
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
                { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 },
                target),
            stencilReference: request.stencil & 0xff,
            target,
            blendConstant: null,
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
     * @param {number} cut   the backend's cut this recording was queued as
     */
    const replay = async(recording, target, shown, cut)=>{
        const show = pipelineFor(showKey(COLOUR_FORMAT), generateShow(),
            showDescriptor(COLOUR_FORMAT), SINGLE_TEXTURE_PLAN);
        const built = await Promise.allSettled([...recording.pipelines, show]);
        const frame = backend.beginFrame({ cut });
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
            /** @type {DrawTarget | null} */
            let passTarget = null;
            /** @type {any} */
            let viewport = null;
            /** @type {any} */
            let scissor = null;
            let stencilReference = -1;
            /** @type {any} */
            let blendConstant = null;
            /** @param {DrawTarget} drawn */
            const drawing = drawn=>{
                if (pass && passTarget === drawn)
                {
                    return pass;
                }
                passTarget = drawn;
                pass = frame.beginPass({
                    targets: drawn.colours,
                    clear: false,
                    depthTarget: drawn.depth ?? undefined,
                    depthStencilAttachment: drawn.depth
                        ? {
                            view: drawn.depth.view,
                            depthLoadOp: 'load',
                            depthStoreOp: 'store',
                            stencilLoadOp: 'load',
                            stencilStoreOp: 'store',
                        }
                        : undefined,
                });
                viewport = null;
                scissor = null;
                stencilReference = -1;
                blendConstant = null;
                return pass;
            };
            for (let at = 0; at < recording.commands.length; at++)
            {
                const command = recording.commands[at];
                if (command.kind === 'upload')
                {
                    // A staged copy closes the pass it lands in.
                    backend.uploadTexture(command.upload);
                    pass = null;
                    continue;
                }
                if (command.kind === 'carry')
                {
                    frame.copyTexture(
                        { texture: command.from, mipLevel: command.level,
                            origin: { x: 0, y: 0, z: command.face } },
                        { texture: command.to, mipLevel: command.level,
                            origin: { x: 0, y: 0, z: command.face } },
                        { width: command.width, height: command.height, depthOrArrayLayers: 1 });
                    pass = null;
                    continue;
                }
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
                    // Into the level, reading the framebuffer: its own pass,
                    // after which the drawing pass is reopened over what it
                    // holds.
                    const into = frame.beginPass({ target: command.target, clear: false });
                    into.setScissor(command.scissor);
                    into.setPipeline(pipeline.gpu);
                    into.setBindings(0, pipeline.layout, [
                        { binding: 0, resource: into.uniforms(command.uniforms) },
                        { binding: 1, resource: command.source.view },
                        { binding: 2, resource: command.sampler },
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
                drawing(command.target);
                pass.setPipeline(pipeline.gpu);
                if (command.blendConstant && !sameBlendConstant(blendConstant,
                    command.blendConstant))
                {
                    blendConstant = command.blendConstant;
                    pass.setBlendConstant(blendConstant);
                }
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
    const sameBlendConstant = (a, b)=>a !== null && a.r === b.r && a.g === b.g && a.b === b.b
        && a.a === b.a;

    /** @param {any} a @param {any} b */
    const sameRect = (a, b)=>a !== null && a.x === b.x && a.y === b.y && a.width === b.width
        && a.height === b.height && a.minDepth === b.minDepth && a.maxDepth === b.maxDepth;

    return {
        /**
         * A buffer object the program deleted: its GPU copy goes back once the
         * frames that drew from it are submitted.
         *
         * @param {import('./objects.js').BufferObject} buffer
         */
        releaseBuffer(buffer){
            const held = buffers.get(buffer);
            if (held)
            {
                buffers.delete(buffer);
                backend.releaseDynamicBuffer?.(held.gpu);
            }
            indexScanCache.delete(buffer);
        },

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
                target: /** @type {any} */ (null),
            });
            const surfaces = /** @type {DrawableSurfaces} */ (drawables.get(context));
            surfaces.target = {
                key: 'window', width, height, flipped: false, colours: [surfaces.colour],
                formats: [COLOUR_FORMAT], masks: [0xf], depth: surfaces.depth,
                depthFormat: DEPTH_FORMAT, attached: new Set(),
            };
        },

        /** @param {object} context */
        attached: context=>drawables.has(context),

        clear,
        blit,
        generateMipmap,
        drawArrays,
        /** @param {string} why @param {number} vertices */
        noteAssembled(why, vertices){
            stats.assembled.draws++;
            stats.assembled.vertices += vertices;
            stats.assembled.byReason[why] = (stats.assembled.byReason[why] ?? 0) + 1;
        },
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
                if (liveDump !== null && liveDump.dumpFrames > 0)
                {
                    liveDump.dumpFrames--;
                    if (liveDump.dumpFrames === 0)
                    {
                        liveDump.written?.(recording.dump, stats.frames - 1);
                    }
                }
            }
            ({ dumping: dumpDraws, skips: skipTextures } = liveSwitches());
            const shown = target.shown[target.current];
            target.current ^= 1;
            const cut = backend.markPresent();
            chain = chain
                .then(()=>replay(recording, target, shown, cut))
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

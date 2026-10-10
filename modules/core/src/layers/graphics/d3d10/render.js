/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Direct3D 10 device draws with.
 *
 * The device in `device.js` decides what is legal; this decides what the GPU
 * is told. Between the two is a record: every clear and draw is written down
 * with the whole state it depends on, and a present -- or a flush, which shows
 * nothing -- replays the record onto one backend frame once every pipeline it
 * needs has been built. The replay is
 * where the backend's rules are honoured -- one encoder, one submit, a pass per
 * change of target -- and the record is what a test reads back to know what was
 * drawn.
 *
 * Every resource keeps a host copy of its bytes. That is what a map hands out
 * and an unmap reads back, what a copy between resources moves, and what an
 * upload sends. A resource the GPU wrote -- a render target, or one the GPU
 * copied or filtered into -- has no host copy worth reading, so a copy out of
 * one is recorded for the GPU to make in its turn, and one into a staging
 * resource is read back after the frame that holds it is submitted.
 *
 * What this cut does not do is stated where it is decided, each as a divergence
 * that names the call: wireframe fill, geometry shaders, stream output,
 * predication, and multisampling.
 */

import {
    D3D10_BIND, D3D10_BLEND, D3D10_BLEND_OP, D3D10_CLEAR, D3D10_COMPARISON, D3D10_CULL_MODE,
    D3D10_DEPTH_WRITE_MASK, D3D10_FILL_MODE, D3D10_FILTER, D3D10_FILTER_ANISOTROPIC_BIT,
    D3D10_FILTER_COMPARISON_BIT, D3D10_INPUT_CLASSIFICATION, D3D10_PRIMITIVE_TOPOLOGY,
    D3D10_RESOURCE_DIMENSION, D3D10_STENCIL_OP, D3D10_TEXTURE_ADDRESS, D3D10_USAGE,
    D3D10_APPEND_ALIGNED_ELEMENT, DXGI_FORMAT, FORMAT_INFO, formatPitch,
} from './constants.js';
import { convertTexels, convertedTexelBytes } from './blocks.js';
import {
    INDEX_FORMAT, TEXEL_BYTES, VERTEX_FORMAT, VERTEX_FORMAT_BYTES, copyCompatible,
    isDepthFormat, resolvable, textureStorage, viewFormatOf,
} from './gpuformats.js';
import { levelExtent } from './validity.js';
import { passedSamples, reachableArea } from '../webgpu/internal/occlusion.js';
import {
    BINDING, BUFFER_VIEW_FORMATS, NO_PIXEL_SHADER, STAGE, linkProgram, translateShader,
} from './wgsl.js';
import { LockFlags } from '../webgpu/internal/buffers.js';
import { RESOURCE_DIMENSION } from './sm4.js';

/**
 * @typedef {Object} RenderServices
 * @property {any} backend  The WebGPU backend (`webgpu/backend.js`), or null to keep
 *                          every resource's bytes without a GPU behind them.
 * @property {(descriptor: object) => any} createSampler
 * @property {(descriptor: object) => any} createTexture
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {boolean} [compressedTextures]  Whether the GPU samples BC blocks as they are;
 *                                          without it they are decoded on the processor.
 * @property {boolean} [depthClipControl]  Whether the GPU device was made with
 *     depth-clip-control, which leaving depth unclipped needs.
 */

/** @type {Readonly<Record<number, string>>} */
const TOPOLOGY = Object.freeze({
    [D3D10_PRIMITIVE_TOPOLOGY.POINTLIST]: 'point-list',
    [D3D10_PRIMITIVE_TOPOLOGY.LINELIST]: 'line-list',
    [D3D10_PRIMITIVE_TOPOLOGY.LINESTRIP]: 'line-strip',
    [D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST]: 'triangle-list',
    [D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP]: 'triangle-strip',
});

/** @type {Readonly<Record<number, string>>} */
const COMPARE = Object.freeze({
    [D3D10_COMPARISON.NEVER]: 'never',
    [D3D10_COMPARISON.LESS]: 'less',
    [D3D10_COMPARISON.EQUAL]: 'equal',
    [D3D10_COMPARISON.LESS_EQUAL]: 'less-equal',
    [D3D10_COMPARISON.GREATER]: 'greater',
    [D3D10_COMPARISON.NOT_EQUAL]: 'not-equal',
    [D3D10_COMPARISON.GREATER_EQUAL]: 'greater-equal',
    [D3D10_COMPARISON.ALWAYS]: 'always',
});

/** @type {Readonly<Record<number, string>>} */
const STENCIL_OP = Object.freeze({
    [D3D10_STENCIL_OP.KEEP]: 'keep',
    [D3D10_STENCIL_OP.ZERO]: 'zero',
    [D3D10_STENCIL_OP.REPLACE]: 'replace',
    [D3D10_STENCIL_OP.INCR_SAT]: 'increment-clamp',
    [D3D10_STENCIL_OP.DECR_SAT]: 'decrement-clamp',
    [D3D10_STENCIL_OP.INVERT]: 'invert',
    [D3D10_STENCIL_OP.INCR]: 'increment-wrap',
    [D3D10_STENCIL_OP.DECR]: 'decrement-wrap',
});

/**
 * The dual-source factors have no counterpart and are absent; a state that
 * names one is refused at draw time by name.
 *
 * @type {Readonly<Record<number, string>>}
 */
const BLEND_FACTOR = Object.freeze({
    [D3D10_BLEND.ZERO]: 'zero',
    [D3D10_BLEND.ONE]: 'one',
    [D3D10_BLEND.SRC_COLOR]: 'src',
    [D3D10_BLEND.INV_SRC_COLOR]: 'one-minus-src',
    [D3D10_BLEND.SRC_ALPHA]: 'src-alpha',
    [D3D10_BLEND.INV_SRC_ALPHA]: 'one-minus-src-alpha',
    [D3D10_BLEND.DEST_ALPHA]: 'dst-alpha',
    [D3D10_BLEND.INV_DEST_ALPHA]: 'one-minus-dst-alpha',
    [D3D10_BLEND.DEST_COLOR]: 'dst',
    [D3D10_BLEND.INV_DEST_COLOR]: 'one-minus-dst',
    [D3D10_BLEND.SRC_ALPHA_SAT]: 'src-alpha-saturated',
    [D3D10_BLEND.BLEND_FACTOR]: 'constant',
    [D3D10_BLEND.INV_BLEND_FACTOR]: 'one-minus-constant',
});

/** @type {Readonly<Record<number, string>>} */
const BLEND_OP = Object.freeze({
    [D3D10_BLEND_OP.ADD]: 'add',
    [D3D10_BLEND_OP.SUBTRACT]: 'subtract',
    [D3D10_BLEND_OP.REV_SUBTRACT]: 'reverse-subtract',
    [D3D10_BLEND_OP.MIN]: 'min',
    [D3D10_BLEND_OP.MAX]: 'max',
});

/** @type {Readonly<Record<number, string>>} */
const CULL = Object.freeze({
    [D3D10_CULL_MODE.NONE]: 'none',
    [D3D10_CULL_MODE.FRONT]: 'front',
    [D3D10_CULL_MODE.BACK]: 'back',
});

/** @type {Readonly<Record<number, string>>} */
const ADDRESS = Object.freeze({
    [D3D10_TEXTURE_ADDRESS.WRAP]: 'repeat',
    [D3D10_TEXTURE_ADDRESS.MIRROR]: 'mirror-repeat',
    [D3D10_TEXTURE_ADDRESS.CLAMP]: 'clamp-to-edge',
    // Border and mirror-once have no counterpart; the nearest is clamping.
    [D3D10_TEXTURE_ADDRESS.BORDER]: 'clamp-to-edge',
    [D3D10_TEXTURE_ADDRESS.MIRROR_ONCE]: 'clamp-to-edge',
});

/**
 * Formats WebGPU blends. An integer target is never blended (Direct3D skips
 * blending for one too), and a 32-bit float one only with a device feature
 * this build does not ask for, which CheckFormatSupport says by not claiming
 * it blendable.
 *
 * @param {string} format
 */
const blendable = format=>!/int$/.test(format) && !/32float$/.test(format);

/** The state a null rasterizer, depth-stencil or blend state stands for. */
/** What a draw with no input layout bound is fed by: nothing. */
const NO_INPUT_LAYOUT = Object.freeze({ elements: Object.freeze([]) });

const DEFAULT_RASTERIZER = Object.freeze({
    FillMode: D3D10_FILL_MODE.SOLID,
    CullMode: D3D10_CULL_MODE.BACK,
    FrontCounterClockwise: false,
    DepthBias: 0,
    DepthBiasClamp: 0,
    SlopeScaledDepthBias: 0,
    DepthClipEnable: true,
    ScissorEnable: false,
    MultisampleEnable: false,
    AntialiasedLineEnable: false,
});

const DEFAULT_STENCIL_FACE = Object.freeze({
    StencilFailOp: D3D10_STENCIL_OP.KEEP,
    StencilDepthFailOp: D3D10_STENCIL_OP.KEEP,
    StencilPassOp: D3D10_STENCIL_OP.KEEP,
    StencilFunc: D3D10_COMPARISON.ALWAYS,
});

const DEFAULT_DEPTH_STENCIL = Object.freeze({
    DepthEnable: true,
    DepthWriteMask: D3D10_DEPTH_WRITE_MASK.ALL,
    DepthFunc: D3D10_COMPARISON.LESS,
    StencilEnable: false,
    StencilReadMask: 0xff,
    StencilWriteMask: 0xff,
    FrontFace: DEFAULT_STENCIL_FACE,
    BackFace: DEFAULT_STENCIL_FACE,
});

const DEFAULT_BLEND = Object.freeze({
    AlphaToCoverageEnable: false,
    BlendEnable: Object.freeze([false, false, false, false, false, false, false, false]),
    SrcBlend: D3D10_BLEND.ONE,
    DestBlend: D3D10_BLEND.ZERO,
    BlendOp: D3D10_BLEND_OP.ADD,
    SrcBlendAlpha: D3D10_BLEND.ONE,
    DestBlendAlpha: D3D10_BLEND.ZERO,
    BlendOpAlpha: D3D10_BLEND_OP.ADD,
    RenderTargetWriteMask: Object.freeze([0xf, 0xf, 0xf, 0xf, 0xf, 0xf, 0xf, 0xf]),
});

/**
 * D3D10_SUBRESOURCE_DATA: the bytes a resource starts with, one per subresource.
 *
 * @typedef {Object} SubresourceData
 * @property {Uint8Array | null} pSysMem
 * @property {number} [SysMemPitch]
 * @property {number} [SysMemSlicePitch]
 */

/**
 * D3D10_BOX: half-open on every axis.
 *
 * @typedef {Object} Box
 * @property {number} left
 * @property {number} top
 * @property {number} front
 * @property {number} right
 * @property {number} bottom
 * @property {number} back
 */

/**
 * @typedef {Object} StageBindings
 * @property {any} shader
 * @property {any[]} constantBuffers
 * @property {any[]} shaderResources
 * @property {any[]} samplers
 */

/**
 * The whole pipeline as a draw sees it, with every binding that has since
 * been released already read as nothing.
 *
 * @typedef {Object} PipelineSnapshot
 * @property {{ vs: StageBindings, gs: StageBindings, ps: StageBindings }} stages
 * @property {any} inputLayout
 * @property {any[]} vertexBuffers
 * @property {number[]} vertexStrides
 * @property {number[]} vertexOffsets
 * @property {any} indexBuffer
 * @property {number} indexFormat
 * @property {number} indexOffset
 * @property {number} topology
 * @property {any[]} renderTargets
 * @property {any} depthStencilView
 * @property {any} blendState
 * @property {number[]} blendFactor
 * @property {number} sampleMask
 * @property {any} depthStencilState
 * @property {number} stencilRef
 * @property {any} rasterizerState
 * @property {any[]} viewports
 * @property {any[]} scissorRects
 */

/** A per-draw account of what the backend was asked, for a test to evaluate. */
/**
 * @typedef {Object} DrawRecord
 * @property {'draw'} kind
 * @property {number} vertexCount
 * @property {number} startVertex
 * @property {number} instanceCount
 * @property {number} startInstance
 * @property {number} stencilRef
 * @property {number | null} indexCount   Null for a non-indexed draw.
 * @property {number} startIndex
 * @property {number} baseVertex
 * @property {{ gpu: any, offset: number, stride: number }[]} vertexBuffers
 * @property {{ gpu: any, format: string, offset: number } | null} indexBuffer
 * @property {readonly object[]} layout   The input elements.
 * @property {{ x: number, y: number, width: number, height: number,
 *              minDepth: number, maxDepth: number }} viewport
 * @property {string} topology
 */

/**
 * @typedef {Object} ClearRecord
 * @property {'clear'} kind
 * @property {number[]} color
 */

/** The formats a level is drawn into and filtered from when the GPU makes mips. */
const FILTERED_TARGET = /^(rgba8unorm|bgra8unorm|rgba16float|rg16float|r16float|rgb10a2unorm|rg8unorm|r8unorm)/;

/**
 * A triangle over the whole target, sampling the level above at the middle of
 * each target texel.
 */
const MIP_SHADER = [
    '@group(0) @binding(0) var source: texture_2d<f32>;',
    '@group(0) @binding(1) var linear: sampler;',
    'struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };',
    '@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Out {',
    '    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));',
    '    var out: Out;',
    '    out.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);',
    '    out.uv = uv;',
    '    return out;',
    '}',
    '@fragment fn fragmentMain(in: Out) -> @location(0) vec4<f32> {',
    '    return textureSampleLevel(source, linear, in.uv, 0.0);',
    '}',
].join('\n');

/**
 * A resolve: every pixel the average of its four samples, read through a view
 * in the format the resolve names -- an sRGB one decodes each sample before
 * the average and encodes the result, as Direct3D resolves in that format's
 * space -- and drawn into the one-sample destination.
 */
const RESOLVE_SHADER = [
    '@group(0) @binding(0) var source: texture_multisampled_2d<f32>;',
    '@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {',
    '    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));',
    '    return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);',
    '}',
    '@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {',
    '    let at = vec2<i32>(position.xy);',
    '    return (textureLoad(source, at, 0) + textureLoad(source, at, 1)',
    '        + textureLoad(source, at, 2) + textureLoad(source, at, 3)) * 0.25;',
    '}',
].join('\n');

/**
 * @param {number} a
 * @param {number} b
 * @returns {number} `a` rounded up to a multiple of `b`
 */
const roundUp = (a, b)=>Math.ceil(a / b) * b;

/**
 * @param {RenderServices} services
 */
export function createRenderer(services){
    const { backend, createSampler, createTexture } = services;
    const divergence = services.divergence ?? null;
    const BufferUsage = backend ? backend.BufferUsage : null;
    const TextureUsage = backend ? backend.TextureUsage : null;
    const compressed = services.compressedTextures ?? false;

    /** Said once per distinct detail, so a loop of draws does not flood. */
    const reported = new Set();
    /** @param {string} detail */
    const diverge = detail=>{
        if (!divergence || reported.has(detail))
        {
            return;
        }
        reported.add(detail);
        divergence('Direct3D 10', detail);
    };

    /** @type {WeakMap<object, any>} resource -> backing */
    const backings = new WeakMap();
    /** @type {WeakMap<object, any>} view -> GPU texture view */
    const views = new WeakMap();
    /** @type {WeakMap<object, any>} buffer view -> the uniform describing it */
    const bufferViews = new WeakMap();
    /** @type {WeakMap<object, any>} sampler state -> GPU sampler */
    const samplers = new WeakMap();
    /** @type {WeakMap<object, any>} shader -> translation */
    const translations = new WeakMap();
    /** @type {WeakMap<object, Map<string, any>>} shader -> its multisampled variants */
    const multisampledTranslations = new WeakMap();
    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    /** @type {Map<string, any>} */
    const layouts = new Map();
    /** @type {any} */
    let placeholders = null;

    /**
     * Occlusion counters: what an occlusion query of the device counts into.
     * A draw recorded while any is open is counted on the GPU, into every one
     * open; a counter is settled once it has ended and every submission that
     * holds its draws has delivered its counts.
     *
     * @typedef {{ samples: number, outstanding: number, ended: boolean,
     *             settled: boolean, failed: boolean }} OcclusionCounter
     */
    /** @type {Set<OcclusionCounter>} */
    const occluding = new Set();
    /** @type {Set<OcclusionCounter>} the counters the recording's draws count into */
    let recordingCounters = new Set();
    /** @param {OcclusionCounter} counter */
    const settle = counter=>{
        counter.settled = counter.ended && counter.outstanding === 0;
    };

    /** @type {any[]} commands recorded since the last present */
    let recording = [];
    /**
     * Commands ever recorded, and how many of those have been handed to the
     * GPU: what a query ended after some of them waits on.
     */
    let recordedCount = 0;
    let handedOver = 0;
    /** @param {any} command */
    const record = command=>{
        recording.push(command);
        recordedCount++;
    };
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    /** @type {any[]} */
    let lastFrame = [];
    /** Whether a count the GPU gave only as some or none has been reported. */
    let assumedCountReported = false;
    /**
     * A clear that has not yet met a pass: WebGPU clears an attachment as a
     * pass begins, so a clear waits for the next pass on its target, and a
     * frame that only clears opens a pass for it at the end.
     *
     * @type {Map<any, any>}
     */
    const pendingClears = new Map();

    const counters = {
        frames: 0,
        draws: 0,
        clears: 0,
        skipped: {
            noViewport: 0,
            noTarget: 0,
            noShader: 0,
            untranslatable: 0,
            pipeline: 0,
        },
        /** @type {string[]} */
        failures: [],
    };

    // --- resources ---

    /**
     * @typedef {Object} LevelGeometry
     * @property {number} offset      Into the slice, in bytes.
     * @property {number} rowPitch    Bytes per row of blocks.
     * @property {number} depthPitch
     * @property {number} width       Texels.
     * @property {number} height
     * @property {number} depth
     * @property {number} rows        Rows of blocks.
     */

    /**
     * @typedef {Object} ResourceLayout
     * @property {string | null} format  The GPU texture's format, or null for a buffer.
     * @property {import('./gpuformats.js').TextureStorage | null} storage
     * @property {number} texelBytes     Bytes per block: per texel, but for a compressed format.
     * @property {number} blockEdge      Texels along a block's side.
     * @property {LevelGeometry[]} levels
     * @property {number} sliceBytes     One array slice, every level of it.
     * @property {number} slices
     */

    /**
     * How a resource's bytes are laid out on the host: in the program's own
     * format, rows of blocks, every level of a slice back to back and then the
     * next slice, as the subresource numbering counts. That is the layout a
     * map hands out, whatever the GPU keeps.
     *
     * @param {any} resource
     * @returns {ResourceLayout}
     */
    const layoutOf = resource=>{
        const desc = resource.desc;
        if (resource.dimension === D3D10_RESOURCE_DIMENSION.BUFFER)
        {
            return {
                format: null,
                storage: null,
                texelBytes: 1,
                blockEdge: 1,
                levels: [{
                    offset: 0, rowPitch: desc.ByteWidth, depthPitch: desc.ByteWidth,
                    width: desc.ByteWidth, height: 1, depth: 1, rows: 1,
                }],
                sliceBytes: desc.ByteWidth,
                slices: 1,
            };
        }
        const storage = textureStorage(desc.Format, desc.BindFlags, { compressed });
        const info = FORMAT_INFO[desc.Format];
        const levels = [];
        let offset = 0;
        for (let level = 0; level < desc.MipLevels; level++)
        {
            const width = levelExtent(desc.Width, level);
            const height = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D
                ? 1
                : levelExtent(desc.Height, level);
            const depth = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? levelExtent(desc.Depth, level)
                : 1;
            const { rowPitch, rows } = formatPitch(desc.Format, width, height);
            const depthPitch = rowPitch * rows;
            levels.push({ offset, rowPitch, depthPitch, width, height, depth, rows });
            offset += depthPitch * depth;
        }
        return {
            format: storage ? storage.format : null,
            storage,
            texelBytes: info ? info.bytesPerPixel : 4,
            blockEdge: info ? info.blockEdge : 1,
            levels,
            sliceBytes: offset,
            slices: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? 1
                : desc.ArraySize,
        };
    };

    let nextBacking = 1;

    /** @param {any} resource */
    const backingOf = resource=>{
        let backing = backings.get(resource);
        if (backing)
        {
            return backing;
        }
        const desc = resource.desc;
        const layout = layoutOf(resource);
        const bytes = new Uint8Array(layout.sliceBytes * layout.slices);
        backing = {
            id: nextBacking++, layout, bytes, gpu: null, texture: null, surface: null,
            sampleCount: desc.SampleDesc ? desc.SampleDesc.Count : 1,
        };
        if (!backend)
        {
            backings.set(resource, backing);
            return backing;
        }
        if (resource.dimension === D3D10_RESOURCE_DIMENSION.BUFFER)
        {
            if (desc.Usage !== D3D10_USAGE.STAGING)
            {
                backing.gpu = backend.createDynamicBuffer({
                    label: `d3d10:buffer#${desc.ByteWidth}`,
                    size: desc.ByteWidth,
                    usage: BufferUsage.VERTEX | BufferUsage.INDEX | BufferUsage.UNIFORM
                        | BufferUsage.COPY_DST | BufferUsage.COPY_SRC
                        | ((desc.BindFlags & D3D10_BIND.SHADER_RESOURCE) !== 0
                            ? BufferUsage.STORAGE
                            : 0),
                });
            }
        }
        else if (layout.format && desc.Usage !== D3D10_USAGE.STAGING)
        {
            let usage = TextureUsage.COPY_DST | TextureUsage.COPY_SRC;
            // WebGPU makes a multisampled texture only as something to draw
            // into, whatever else the program binds it as.
            if ((desc.BindFlags & (D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL)) !== 0
                || backing.sampleCount > 1)
            {
                usage |= TextureUsage.RENDER_ATTACHMENT;
            }
            if ((desc.BindFlags & D3D10_BIND.SHADER_RESOURCE) !== 0)
            {
                usage |= TextureUsage.TEXTURE_BINDING;
            }
            const size = {
                width: desc.Width,
                height: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D
                    ? 1
                    : desc.Height,
                depthOrArrayLayers: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                    ? desc.Depth
                    : desc.ArraySize,
            };
            const viewFormats = layout.storage ? layout.storage.viewFormats : [];
            backing.texture = createTexture({
                label: `d3d10:texture${resource.dimension - 1}d:${layout.format}`,
                size,
                mipLevelCount: desc.MipLevels,
                sampleCount: desc.SampleDesc.Count,
                // A one-dimensional texture is one row of a two-dimensional
                // one: WebGPU's own has neither mip levels nor array layers.
                dimension: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                    ? '3d'
                    : '2d',
                format: layout.format,
                ...(viewFormats.length > 0 ? { viewFormats } : {}),
                usage,
            });
            // The surface a swap chain shows: the whole of level zero.
            backing.surface = {
                texture: backing.texture,
                view: backing.texture.createView({ label: 'd3d10:target' }),
                width: size.width,
                height: size.height,
                format: layout.format,
                mipLevelCount: desc.MipLevels,
                label: `d3d10:${layout.format}`,
            };
        }
        else if (desc.Usage !== D3D10_USAGE.STAGING)
        {
            diverge(`a texture in format ${desc.Format} cannot be backed on this device;`
                + ' it is kept in memory and never drawn with');
        }
        backings.set(resource, backing);
        return backing;
    };

    /**
     * @param {any} resource
     * @param {number} subresource
     * @returns {{ level: number, slice: number }}
     */
    const subresourceOf = (resource, subresource)=>{
        const levels = resource.desc.MipLevels;
        return { level: subresource % levels, slice: Math.floor(subresource / levels) };
    };

    /**
     * @param {any} resource
     * @param {number} subresource
     * @returns {{ bytes: Uint8Array, rowPitch: number, depthPitch: number,
     *             level: LevelGeometry }}
     */
    const subresourceBytes = (resource, subresource)=>{
        const backing = backingOf(resource);
        const { level, slice } = subresourceOf(resource, subresource);
        const geometry = backing.layout.levels[level];
        const at = slice * backing.layout.sliceBytes + geometry.offset;
        return {
            bytes: backing.bytes.subarray(at, at + geometry.depthPitch * geometry.depth),
            rowPitch: geometry.rowPitch,
            depthPitch: geometry.depthPitch,
            level: geometry,
        };
    };

    /**
     * A box in texels as the host layout counts it: whole blocks, a row in
     * bytes, and clipped to the level it lies in.
     *
     * @param {ResourceLayout} layout
     * @param {LevelGeometry} geometry
     * @param {Box} box
     */
    const blocksOf = (layout, geometry, box)=>{
        const edge = layout.blockEdge;
        const left = Math.floor(box.left / edge);
        const top = Math.floor(box.top / edge);
        const columns = Math.ceil(Math.min(box.right, geometry.width) / edge) - left;
        return {
            left: left * layout.texelBytes,
            top,
            front: box.front,
            rowBytes: Math.max(0, columns) * layout.texelBytes,
            rows: Math.max(0, Math.ceil(Math.min(box.bottom, geometry.height) / edge) - top),
            depth: Math.max(0, Math.min(box.back, geometry.depth) - box.front),
        };
    };

    /**
     * A subresource's host bytes as the GPU texture holds them: as they are,
     * or converted where the texture keeps another format.
     *
     * @param {ResourceLayout} layout
     * @param {LevelGeometry} geometry
     * @param {Uint8Array} bytes
     * @returns {{ data: Uint8Array, bytesPerRow: number } | null}
     */
    const texelsForGpu = (layout, geometry, bytes)=>{
        const conversion = layout.storage ? layout.storage.conversion : null;
        if (!conversion)
        {
            return { data: bytes, bytesPerRow: geometry.rowPitch };
        }
        const slices = [];
        for (let z = 0; z < geometry.depth; z++)
        {
            const converted = convertTexels(conversion,
                bytes.subarray(z * geometry.depthPitch, (z + 1) * geometry.depthPitch),
                geometry.width, geometry.height);
            if (!converted)
            {
                return null;
            }
            slices.push(converted);
        }
        const texel = convertedTexelBytes(conversion);
        const data = new Uint8Array(slices.reduce((total, slice)=>total + slice.length, 0));
        slices.reduce((at, slice)=>{
            data.set(slice, at);
            return at + slice.length;
        }, 0);
        return { data, bytesPerRow: geometry.width * texel };
    };

    /**
     * Sends a subresource's host bytes to the GPU: all of them, or the box a
     * program wrote -- the rest of a level the GPU drew into is newer on the
     * GPU than on the host, and must not be overwritten with it.
     *
     * @param {any} resource
     * @param {number} subresource
     * @param {number} [flags]  A LockFlags value for a buffer.
     * @param {Box | null} [box]
     */
    const upload = (resource, subresource, flags = LockFlags.NONE, box = null)=>{
        const backing = backingOf(resource);
        if (backing.gpu)
        {
            const lock = backing.gpu.lock(0, backing.bytes.length, flags);
            lock.data.set(backing.bytes);
            backing.gpu.unlock(lock);
            return;
        }
        if (!backing.texture)
        {
            return;
        }
        if (backing.sampleCount > 1)
        {
            diverge('bytes a program gives a multisampled texture are kept but not uploaded:'
                + ' WebGPU writes one only by drawing');
            return;
        }
        if (backing.layout.storage.depth)
        {
            // WebGPU copies into no depth format with a stencil, and a depth
            // texture is written by drawing: bytes a program hands one stay on
            // the host.
            diverge('bytes a program gives a depth texture are kept but not uploaded: the'
                + ' GPU copy of a depth texture is written only by drawing and clearing');
            return;
        }
        const { level, slice } = subresourceOf(resource, subresource);
        const geometry = backing.layout.levels[level];
        const held = subresourceBytes(resource, subresource);
        const layout = backing.layout;
        const is3D = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D;
        let texels;
        let area = { x: 0, y: 0, z: 0, width: geometry.width, height: geometry.height,
            depth: geometry.depth };
        if (box && !layout.storage.conversion)
        {
            const region = blocksOf(layout, geometry, box);
            const edge = layout.blockEdge;
            const x = Math.floor(box.left / edge) * edge;
            const y = Math.floor(box.top / edge) * edge;
            area = {
                x, y, z: region.front,
                width: Math.min(box.right, geometry.width) - x,
                height: Math.min(box.bottom, geometry.height) - y,
                depth: region.depth,
            };
            const data = new Uint8Array(region.rowBytes * region.rows * region.depth);
            for (let z = 0; z < region.depth; z++)
            {
                for (let row = 0; row < region.rows; row++)
                {
                    const from = (region.front + z) * held.depthPitch
                        + (region.top + row) * held.rowPitch + region.left;
                    data.set(held.bytes.subarray(from, from + region.rowBytes),
                        (z * region.rows + row) * region.rowBytes);
                }
            }
            texels = { data, bytesPerRow: region.rowBytes };
        }
        else
        {
            texels = texelsForGpu(layout, geometry, held.bytes);
        }
        if (!texels || area.width <= 0 || area.height <= 0 || area.depth <= 0)
        {
            return;
        }
        const compressedBlocks = layout.blockEdge > 1 && !layout.storage.conversion;
        try
        {
            backend.uploadTexture({
                texture: backing.texture,
                format: layout.format,
                width: area.width,
                height: area.height,
                depthOrArrayLayers: area.depth,
                mipLevel: level,
                origin: { x: area.x, y: area.y, z: is3D ? area.z : slice },
                bytesPerRow: texels.bytesPerRow,
                data: texels.data,
                // Blocks go through a staging buffer, the path they arrive by.
                staging: compressedBlocks,
            });
        }
        catch (e){
            diverge(`a ${backing.layout.format} texture is not uploaded:`
                + ` ${e && /** @type {any} */ (e).message || e}`);
        }
    };

    /**
     * Whether the GPU's copy of a resource may be newer than the host's: one
     * a draw can write, and one the GPU copied or filtered into.
     *
     * @param {any} resource
     */
    const gpuWritten = resource=>(resource.desc.BindFlags
        & (D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL)) !== 0
        || backingOf(resource).gpuDirty === true;

    /**
     * Whether a level of this texture can be read back as it is: texels the
     * GPU keeps in the program's own layout, one sample each. A depth format
     * or one converted on the way to the GPU cannot be.
     *
     * @param {any} backing
     */
    const readable = backing=>{
        const storage = backing.layout.storage;
        return !!storage && !storage.conversion && !storage.depth
            && TEXEL_BYTES[storage.format] > 0 && backing.sampleCount === 1;
    };

    /**
     * @param {any} view
     * @returns {any} the GPU view a shader or a pass sees the resource through
     */
    const viewOf = view=>{
        let gpu = views.get(view);
        if (gpu)
        {
            return gpu;
        }
        /** @type {{ resource?: any }} */
        const held = {};
        view.GetResource(held);
        const resource = held.resource;
        resource.release();
        const backing = backingOf(resource);
        if (!backing.texture)
        {
            return null;
        }
        /** @type {{ desc?: any }} */
        const described = {};
        view.GetDesc(described);
        const desc = described.desc;
        const shape = view.dimensionName ?? '';
        const isCube = shape === 'TEXTURECUBE';
        const array = shape.endsWith('ARRAY') || isCube;
        const chosen = viewFormatOf(backing.layout.storage, desc.Format, { compressed });
        if (chosen.reinterpreted)
        {
            diverge(`a view of a typeless texture as format ${desc.Format} reads it as`
                + ` ${chosen.format}: WebGPU does not reinterpret one type as another`);
        }
        const dimension = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
            ? '3d'
            : isCube ? 'cube' : array ? '2d-array' : '2d';
        const created = backing.texture.createView({
            label: `d3d10:view:${chosen.format ?? chosen.aspect}`,
            ...(chosen.format ? { format: chosen.format } : {}),
            ...(chosen.aspect ? { aspect: chosen.aspect } : {}),
            dimension,
            baseMipLevel: view.range.mip,
            mipLevelCount: view.range.levels,
            baseArrayLayer: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? 0
                : view.range.first,
            arrayLayerCount: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? 1
                : view.range.count,
        });
        gpu = { view: created, sampleType: sampleTypeOf(chosen.format, chosen.aspect), dimension,
            multisampled: backing.sampleCount > 1 };
        views.set(view, gpu);
        return gpu;
    };

    /** @param {any} state a sampler state object */
    const isComparisonSampler = state=>(stateDesc(state).Filter
        & D3D10_FILTER_COMPARISON_BIT) !== 0;

    /** @param {any} state a sampler state object */
    const samplerOf = state=>{
        let gpu = samplers.get(state);
        if (gpu)
        {
            return gpu;
        }
        /** @type {{ desc?: any }} */
        const held = {};
        state.GetDesc(held);
        const desc = held.desc;
        const filter = desc.Filter;
        const anisotropic = (filter & D3D10_FILTER_ANISOTROPIC_BIT) !== 0;
        const comparison = (filter & D3D10_FILTER_COMPARISON_BIT) !== 0;
        // The filter word is three bits: mip in bit 0, magnification in bit 2,
        // minification in bit 4; anisotropy implies linear on all three.
        const linear = (/** @type {number} */ bit)=>(anisotropic || (filter & bit) !== 0
            ? 'linear'
            : 'nearest');
        gpu = createSampler({
            label: `d3d10:sampler:${filter.toString(16)}`,
            addressModeU: ADDRESS[desc.AddressU] ?? 'repeat',
            addressModeV: ADDRESS[desc.AddressV] ?? 'repeat',
            addressModeW: ADDRESS[desc.AddressW] ?? 'repeat',
            magFilter: linear(0x4),
            minFilter: linear(0x10),
            mipmapFilter: linear(0x1),
            lodMinClamp: Math.max(0, desc.MinLOD),
            lodMaxClamp: Math.min(32, desc.MaxLOD),
            maxAnisotropy: anisotropic ? Math.max(1, desc.MaxAnisotropy) : 1,
            ...(comparison ? { compare: COMPARE[desc.ComparisonFunc] ?? 'never' } : {}),
        });
        if (filter === D3D10_FILTER.TEXT_1BIT)
        {
            diverge('a text-filtering sampler is used as a point sampler');
        }
        samplers.set(state, gpu);
        return gpu;
    };

    /**
     * What an unbound slot reads as: zeros, black, and a point sampler -- a
     * texture of the type and shape the shader declared, because WebGPU binds
     * nothing else there.
     */
    const placeholdersOf = ()=>{
        if (placeholders)
        {
            return placeholders;
        }
        const buffer = backend.createDynamicBuffer({
            label: 'd3d10:unbound-constants',
            size: 16,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
        // An unbound buffer view: its zeroed uniform above says no elements.
        const storage = backend.createDynamicBuffer({
            label: 'd3d10:unbound-buffer-view',
            size: 16,
            usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        });
        /** @type {Map<string, any>} */
        const textures = new Map();
        /** @type {Record<string, string>} */
        const formats = {
            float: 'rgba8unorm', 'unfilterable-float': 'rgba8unorm', depth: 'depth32float',
            uint: 'rgba8uint', sint: 'rgba8sint',
        };
        placeholders = {
            buffer,
            storage,
            /** @param {{ sampleType: string, viewDimension: string }} kind */
            view(kind){
                const key = `${kind.sampleType}:${kind.viewDimension}`;
                let view = textures.get(key);
                if (!view)
                {
                    const cube = kind.viewDimension.startsWith('cube');
                    const texture = createTexture({
                        label: `d3d10:unbound-texture:${key}`,
                        size: { width: 1, height: 1, depthOrArrayLayers: cube ? 6 : 1 },
                        dimension: kind.viewDimension === '1d' || kind.viewDimension === '3d'
                            ? kind.viewDimension
                            : '2d',
                        format: formats[kind.sampleType] ?? 'rgba8unorm',
                        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
                    });
                    view = texture.createView({
                        label: `d3d10:unbound-texture:${key}`, dimension: kind.viewDimension,
                    });
                    textures.set(key, view);
                }
                return view;
            },
            sampler: createSampler({ label: 'd3d10:unbound-sampler' }),
            comparison: createSampler({ label: 'd3d10:unbound-comparison', compare: 'never' }),
        };
        return placeholders;
    };

    /**
     * A buffer bound through a shader resource view: its bytes as storage at
     * the view's texture binding, and at its view binding a uniform of the
     * view's format, first element, element count and element size, which the
     * shader decodes the element with.
     *
     * @param {any} stage
     * @param {import('./wgsl.js').BindGroupLayoutEntry} entry
     * @param {any} fallback
     */
    const bufferViewBinding = (stage, entry, fallback)=>{
        const isView = entry.binding >= BINDING.BUFFER_VIEW;
        const slot = entry.binding - (isView ? BINDING.BUFFER_VIEW : BINDING.TEXTURE);
        const view = stage.shaderResources[slot] ?? null;
        /** @type {{ resource?: any }} */
        const held = {};
        view?.GetResource(held);
        held.resource?.release();
        const backing = view?.dimensionName === 'BUFFER' && held.resource
            ? backingOf(held.resource)
            : null;
        /** @type {{ desc?: any }} */
        const described = {};
        view?.GetDesc(described);
        const format = described.desc?.Format ?? 0;
        const decodable = backing?.gpu && BUFFER_VIEW_FORMATS.has(format);
        if (!isView && view && !decodable)
        {
            diverge(backing?.gpu
                ? `a buffer view of format ${format} is read as zeros: no decoding is kept for it`
                : 'a texture view bound where the shader reads a buffer is read as zeros');
        }
        if (!decodable)
        {
            return {
                binding: entry.binding,
                resource: { buffer: (isView ? fallback.buffer : fallback.storage).gpu,
                    offset: 0, size: 16 },
            };
        }
        if (!isView)
        {
            backing.gpu.markRead();
            return {
                binding: entry.binding,
                resource: { buffer: backing.gpu.gpu, offset: 0,
                    size: Math.ceil(held.resource.desc.ByteWidth / 4) * 4 },
            };
        }
        let uniform = bufferViews.get(view);
        if (!uniform)
        {
            uniform = backend.createDynamicBuffer({
                label: 'd3d10:buffer-view',
                size: 16,
                usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
            });
            const lock = uniform.lock(0, 16, LockFlags.NONE);
            const words = new DataView(lock.data.buffer, lock.data.byteOffset, 16);
            words.setUint32(0, format, true);
            words.setUint32(4, described.desc.ElementOffset ?? 0, true);
            words.setUint32(8, described.desc.ElementWidth ?? 0, true);
            words.setUint32(12, FORMAT_INFO[format].bytesPerPixel, true);
            uniform.unlock(lock);
            bufferViews.set(view, uniform);
        }
        return { binding: entry.binding, resource: { buffer: uniform.gpu, offset: 0, size: 16 } };
    };

    /**
     * The sample type a view of this format binds as.
     *
     * @param {string | undefined} format
     * @param {string | undefined} aspect
     * @returns {string}
     */
    const sampleTypeOf = (format, aspect)=>{
        if (aspect === 'depth-only' || (format && isDepthFormat(format)))
        {
            return 'depth';
        }
        if (aspect === 'stencil-only' || /uint$/.test(format ?? ''))
        {
            return 'uint';
        }
        if (/sint$/.test(format ?? ''))
        {
            return 'sint';
        }
        return /32float/.test(format ?? '') ? 'unfilterable-float' : 'float';
    };

    /** @type {Record<string, string[]>} what each layout sample type accepts */
    const ACCEPTS = {
        float: ['float'],
        'unfilterable-float': ['float', 'unfilterable-float', 'depth'],
        depth: ['depth'],
        uint: ['uint'],
        sint: ['sint'],
    };

    // --- shaders and pipelines ---

    /**
     * @param {any} shader a shader object holding a parsed container, or null
     *     for the pixel stage of a draw that binds none
     * @param {string} [multisampled]  The slots read by sample, as a key.
     */
    const translationOf = (shader, multisampled = '')=>{
        if (!shader)
        {
            return NO_PIXEL_SHADER;
        }
        if (multisampled)
        {
            let variants = multisampledTranslations.get(shader);
            if (!variants)
            {
                variants = new Map();
                multisampledTranslations.set(shader, variants);
            }
            let variant = variants.get(multisampled);
            if (!variant)
            {
                variant = translateShader(shader.container,
                    { multisampled: multisampled.split(',').map(Number) });
                variants.set(multisampled, variant);
            }
            return variant;
        }
        let translation = translations.get(shader);
        if (!translation)
        {
            translation = translateShader(shader.container);
            translations.set(shader, translation);
        }
        return translation;
    };

    /**
     * The slots, as a key, where a stage's shader declares a multisampled
     * texture and the view bound there is of one with several samples: what
     * its translation has to read by sample. Empty for nearly every draw, and
     * found from the few textures the shader declares.
     *
     * @param {any} stage
     * @returns {string}
     */
    const multisampledSlotsOf = stage=>{
        if (!stage.shader)
        {
            return '';
        }
        let slots = '';
        for (const texture of translationOf(stage.shader).textures)
        {
            const view = texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMS
                ? stage.shaderResources[texture.slot]
                : null;
            if (view && viewOf(view)?.multisampled)
            {
                slots += `${slots ? ',' : ''}${texture.slot}`;
            }
        }
        return slots;
    };

    /** @param {import('./wgsl.js').BindGroupLayoutEntry[]} entries @param {string} label */
    const layoutFor = (entries, label)=>{
        const key = JSON.stringify(entries);
        let layout = layouts.get(key);
        if (!layout)
        {
            layout = backend.createBindGroupLayout({ label, entries });
            layouts.set(key, layout);
        }
        return layout;
    };

    /**
     * The vertex buffer layouts an input layout describes at the strides a
     * draw binds, matched by semantic to the shader's attributes.
     *
     * @param {any} inputLayout
     * @param {import('./wgsl.js').LinkedProgram} program
     * @param {number[]} strides
     * @returns {{ buffers: object[], slots: number[] } | string}
     */
    const vertexLayouts = (inputLayout, program, strides)=>{
        /** @type {Map<number, { arrayStride: number, stepMode: string, attributes: object[] }>} */
        const bySlot = new Map();
        /** @type {Map<number, number>} the next append-aligned offset per slot */
        const cursor = new Map();
        for (const element of inputLayout.elements)
        {
            const format = VERTEX_FORMAT[element.Format];
            if (!format)
            {
                return `input element format ${element.Format} has no vertex spelling`;
            }
            const slot = element.InputSlot;
            const offset = element.AlignedByteOffset === D3D10_APPEND_ALIGNED_ELEMENT
                ? roundUp(cursor.get(slot) ?? 0, 4)
                : element.AlignedByteOffset;
            cursor.set(slot, offset + VERTEX_FORMAT_BYTES[format]);
            const attribute = program.attributes.find(candidate=>
                candidate.semantic.toUpperCase() === element.SemanticName.toUpperCase()
                && candidate.index === (element.SemanticIndex ?? 0));
            if (!attribute)
            {
                // The shader never reads it; a vertex format is still consumed
                // from the stream, which the cursor above accounts for.
                continue;
            }
            let buffer = bySlot.get(slot);
            if (!buffer)
            {
                const perInstance = element.InputSlotClass
                    === D3D10_INPUT_CLASSIFICATION.PER_INSTANCE_DATA;
                const stepRate = perInstance ? element.InstanceDataStepRate ?? 1 : 1;
                if (stepRate > 1)
                {
                    diverge('per-instance data stepping once every several instances steps'
                        + ' every instance: WebGPU steps an instance buffer by one');
                }
                buffer = {
                    // A rate of zero feeds every instance the same element,
                    // which a stride of zero is.
                    arrayStride: stepRate === 0 ? 0 : strides[slot] ?? 0,
                    stepMode: perInstance ? 'instance' : 'vertex',
                    attributes: [],
                };
                bySlot.set(slot, buffer);
            }
            buffer.attributes.push({ shaderLocation: attribute.location, offset, format });
        }
        for (const attribute of program.attributes)
        {
            const bound = [...bySlot.values()].some(buffer=>buffer.attributes.some(
                (/** @type {any} */ entry)=>entry.shaderLocation === attribute.location));
            if (!bound)
            {
                return 'the input layout has no element for'
                    + ` ${attribute.semantic}${attribute.index}`;
            }
        }
        const slots = [...bySlot.keys()].sort((a, b)=>a - b);
        return {
            buffers: slots.map(slot=>bySlot.get(slot) ?? { attributes: [] }),
            slots,
        };
    };

    /**
     * @param {any} state the draw's captured state
     * @returns {string} the pipeline the state needs
     */
    const pipelineKey = state=>{
        const key = [
            idOf(state.vertexShader), idOf(state.pixelShader), idOf(state.inputLayout),
            idOf(state.blendState), idOf(state.depthStencilState), idOf(state.rasterizerState),
            state.topology, state.targetFormats.join(','), state.targetWriteMasks.join(','),
            state.depthFormat ?? '-',
            state.sampleMask >>> 0,
            state.sampleCount, state.strides.join(','), state.indexFormat ?? '-',
        ].join('|');
        // Only a draw that reads a multisampled texture by sample says so.
        return state.vsMultisampled || state.psMultisampled
            ? `${key}|ms:${state.vsMultisampled}/${state.psMultisampled}`
            : key;
    };

    /** @type {WeakMap<object, number>} */
    const ids = new WeakMap();
    let nextId = 1;
    /** @param {any} object */
    const idOf = object=>{
        if (!object)
        {
            return 0;
        }
        let id = ids.get(object);
        if (!id)
        {
            id = nextId++;
            ids.set(object, id);
        }
        return id;
    };

    /** @param {any} state @returns {any} */
    const stateDesc = state=>{
        /** @type {{ desc?: any }} */
        const held = {};
        state.GetDesc(held);
        return held.desc;
    };

    /**
     * Every target's blend, from a blend state of either version: a 10.0 one
     * shares its factors among targets, a 10.1 one may not.
     *
     * @param {any} state
     * @returns {{ alphaToCoverage: boolean, targets: any[] }}
     */
    const blendTargetsOf = state=>{
        if (!state)
        {
            return {
                alphaToCoverage: false,
                targets: DEFAULT_BLEND.BlendEnable.map((_, index)=>({
                    ...DEFAULT_BLEND, BlendEnable: false,
                    RenderTargetWriteMask: DEFAULT_BLEND.RenderTargetWriteMask[index],
                })),
            };
        }
        /** @type {{ desc?: any }} */
        const held = {};
        state.GetDesc1(held);
        return {
            alphaToCoverage: held.desc.AlphaToCoverageEnable, targets: held.desc.RenderTarget,
        };
    };

    /**
     * @param {any} state the draw's captured state
     * @returns {Promise<any>}
     */
    const buildPipeline = async state=>{
        const vs = translationOf(state.vertexShader, state.vsMultisampled);
        const ps = translationOf(state.pixelShader, state.psMultisampled);
        /** @type {(string | null)[]} */
        const formats = state.targetFormats;
        const bound = formats.flatMap((format, index)=>(format ? [index] : []));
        const program = linkProgram(vs, ps, { targets: bound });
        if (program.unsupported.length > 0)
        {
            throw Object.assign(new Error('the shaders cannot be translated:'
                + ` ${program.unsupported.join('; ')}`), { untranslatable: true });
        }
        const layout = vertexLayouts(state.inputLayout, program, state.strides);
        if (typeof layout === 'string')
        {
            throw new Error(layout);
        }
        const rasterizer = state.rasterizerState
            ? stateDesc(state.rasterizerState)
            : DEFAULT_RASTERIZER;
        const depthStencil = state.depthStencilState
            ? stateDesc(state.depthStencilState)
            : DEFAULT_DEPTH_STENCIL;
        const blend = blendTargetsOf(state.blendState);
        if (rasterizer.FillMode === D3D10_FILL_MODE.WIREFRAME)
        {
            diverge('wireframe fill is drawn solid: the backend has no line rasterisation'
                + ' of a triangle');
        }
        // With clipping off Direct3D 10 clamps depth to the viewport's range,
        // which WebGPU does whether or not it clips.
        const unclipped = !rasterizer.DepthClipEnable && services.depthClipControl === true;
        if (!rasterizer.DepthClipEnable && !unclipped)
        {
            diverge('depth clipping stays on: turning it off needs a GPU device made with'
                + ' depth-clip-control, which this one was not');
        }
        /**
         * @param {string | null} format
         * @param {number} index
         * @returns {object | null}
         */
        const colourTarget = (format, index)=>{
            if (!format)
            {
                return null;
            }
            const target = blend.targets[index];
            for (const factor of [target.SrcBlend, target.DestBlend, target.SrcBlendAlpha,
                target.DestBlendAlpha])
            {
                if (target.BlendEnable && !BLEND_FACTOR[factor])
                {
                    throw new Error(`blend factor ${factor} has no counterpart`);
                }
            }
            if (target.BlendEnable && !blendable(format) && !/int$/.test(format))
            {
                diverge(`a ${format} target is drawn unblended: WebGPU blends one only with a`
                    + ' device feature');
            }
            return {
                format,
                // A target the shader does not write keeps what it holds.
                writeMask: program.targets.includes(index)
                    ? target.RenderTargetWriteMask & state.targetWriteMasks[index]
                    : 0,
                ...(target.BlendEnable && blendable(format)
                    ? {
                        blend: {
                            color: {
                                srcFactor: BLEND_FACTOR[target.SrcBlend],
                                dstFactor: BLEND_FACTOR[target.DestBlend],
                                operation: BLEND_OP[target.BlendOp],
                            },
                            alpha: {
                                srcFactor: BLEND_FACTOR[target.SrcBlendAlpha],
                                dstFactor: BLEND_FACTOR[target.DestBlendAlpha],
                                operation: BLEND_OP[target.BlendOpAlpha],
                            },
                        },
                    }
                    : {}),
            };
        };
        const colourTargets = formats.map(colourTarget);

        const [vertexModule, fragmentModule] = await Promise.all([
            backend.createShaderModule({ code: program.vertex, label: `d3d10:vs#${idOf(vs)}` }),
            backend.createShaderModule({ code: program.fragment, label: `d3d10:ps#${idOf(ps)}` }),
        ]);
        const groupLayouts = program.groups.map((entries, index)=>
            layoutFor(entries, `d3d10:${index === 0 ? 'vs' : 'ps'}`));
        const pipelineLayout = backend.createPipelineLayout({
            label: 'd3d10', bindGroupLayouts: groupLayouts,
        });

        /** @param {string} which */
        const face = which=>({
            compare: COMPARE[depthStencil[which].StencilFunc],
            failOp: STENCIL_OP[depthStencil[which].StencilFailOp],
            depthFailOp: STENCIL_OP[depthStencil[which].StencilDepthFailOp],
            passOp: STENCIL_OP[depthStencil[which].StencilPassOp],
        });
        const depthEnabled = depthStencil.DepthEnable;
        const gpu = backend.createRenderPipeline({
            label: `d3d10:${pipelineKey(state)}`,
            layout: pipelineLayout,
            vertex: { module: vertexModule, entryPoint: 'vertexMain', buffers: layout.buffers },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fragmentMain',
                targets: colourTargets,
            },
            primitive: {
                topology: state.topology,
                cullMode: CULL[rasterizer.CullMode],
                frontFace: rasterizer.FrontCounterClockwise ? 'ccw' : 'cw',
                ...(unclipped ? { unclippedDepth: true } : {}),
                ...(state.topology.endsWith('strip') && state.indexFormat
                    ? { stripIndexFormat: state.indexFormat }
                    : {}),
            },
            ...(state.depthFormat
                ? {
                    depthStencil: {
                        format: state.depthFormat,
                        depthWriteEnabled: depthEnabled
                            && depthStencil.DepthWriteMask === D3D10_DEPTH_WRITE_MASK.ALL,
                        depthCompare: depthEnabled ? COMPARE[depthStencil.DepthFunc] : 'always',
                        ...(depthStencil.StencilEnable
                            ? {
                                stencilFront: face('FrontFace'),
                                stencilBack: face('BackFace'),
                                stencilReadMask: depthStencil.StencilReadMask,
                                stencilWriteMask: depthStencil.StencilWriteMask,
                            }
                            : {}),
                        depthBias: rasterizer.DepthBias,
                        depthBiasSlopeScale: rasterizer.SlopeScaledDepthBias,
                        depthBiasClamp: rasterizer.DepthBiasClamp,
                    },
                }
                : {}),
            multisample: {
                count: state.sampleCount,
                mask: state.sampleMask >>> 0,
                alphaToCoverageEnabled: !!blend.alphaToCoverage,
            },
        });
        return {
            gpu, program, groupLayouts, slots: layout.slots,
            steps: layout.buffers.map((/** @type {any} */ buffer)=>buffer.stepMode),
        };
    };

    /** @param {any} state */
    const pipelineFor = state=>{
        const key = pipelineKey(state);
        let promise = pipelines.get(key);
        if (!promise)
        {
            promise = buildPipeline(state);
            pipelines.set(key, promise);
        }
        return promise;
    };

    // --- recording ---

    /** @type {WeakMap<object, any>} render target or depth stencil view -> target */
    const targets = new WeakMap();

    /**
     * What a pass draws into through a render target or depth stencil view:
     * the one level and slice the view names, as a surface of its own. Two
     * views of one subresource share its key, which is what a clear through
     * one and a draw through the other agree on.
     *
     * @param {any} view a render target or depth stencil view
     * @returns {any | null}
     */
    const targetOf = view=>{
        if (!view)
        {
            return null;
        }
        let target = targets.get(view);
        if (target)
        {
            return target;
        }
        /** @type {{ resource?: any }} */
        const held = {};
        view.GetResource(held);
        held.resource.release();
        const backing = backingOf(held.resource);
        if (!backing.texture)
        {
            return null;
        }
        /** @type {{ desc?: any }} */
        const described = {};
        view.GetDesc(described);
        const desc = described.desc;
        const mip = view.range.mip;
        const layer = view.range.first;
        if (held.resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D)
        {
            diverge('a view into a slice of a 3D texture draws into its first slice');
        }
        const chosen = viewFormatOf(backing.layout.storage, desc.Format, { compressed });
        const format = chosen.format ?? backing.layout.format;
        const width = levelExtent(held.resource.desc.Width, mip);
        const height = held.resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D
            ? 1
            : levelExtent(held.resource.desc.Height, mip);
        target = {
            key: `${backing.id}:${mip}:${held.resource.dimension
                === D3D10_RESOURCE_DIMENSION.TEXTURE3D ? 0 : layer}`,
            backing,
            texture: backing.texture,
            format,
            sampleCount: backing.sampleCount,
            // What a draw writes, when the format keeps less than the texture does.
            writeMask: desc.Format === DXGI_FORMAT.A8_UNORM ? 0x8 : 0xf,
            surface: {
                texture: backing.texture,
                view: backing.texture.createView({
                    label: `d3d10:target:${format}`,
                    format,
                    dimension: '2d',
                    baseMipLevel: mip,
                    mipLevelCount: 1,
                    baseArrayLayer: held.resource.dimension
                        === D3D10_RESOURCE_DIMENSION.TEXTURE3D ? 0 : layer,
                    arrayLayerCount: 1,
                }),
                width,
                height,
                format,
                mipLevel: mip,
                label: `d3d10:${format}`,
            },
        };
        targets.set(view, target);
        return target;
    };

    /**
     * The bind group entries of one stage, from what the device has bound.
     *
     * @param {any} stage  The device's per-stage bindings.
     * @param {import('./wgsl.js').BindGroupLayoutEntry[]} entries
     * @returns {object[]}
     */
    const bindingsFor = (stage, entries)=>{
        const fallback = placeholdersOf();
        return entries.map(entry=>{
            if (entry.buffer && entry.binding >= BINDING.TEXTURE)
            {
                return bufferViewBinding(stage, entry, fallback);
            }
            if (entry.buffer)
            {
                const buffer = stage.constantBuffers[entry.binding] ?? null;
                const backing = buffer ? backingOf(buffer) : null;
                return {
                    binding: entry.binding,
                    resource: backing && backing.gpu
                        ? { buffer: backing.gpu.gpu, offset: 0, size: buffer.desc.ByteWidth }
                        : { buffer: fallback.buffer.gpu, offset: 0, size: 16 },
                };
            }
            if (entry.texture)
            {
                const view = stage.shaderResources[entry.binding - BINDING.TEXTURE];
                const gpu = view ? viewOf(view) : null;
                if (view && !gpu)
                {
                    diverge('a shader resource view over a buffer, or over a texture this'
                        + ' device could not back, is read as an empty texture');
                }
                if (gpu && !(ACCEPTS[entry.texture.sampleType] ?? []).includes(gpu.sampleType))
                {
                    diverge(`a ${gpu.sampleType} texture bound where the shader reads a`
                        + ` ${entry.texture.sampleType} one is read as an empty texture`);
                    return { binding: entry.binding, resource: fallback.view(entry.texture) };
                }
                // WebGPU refuses the whole bind group over a view of another
                // shape, where Direct3D leaves only that read undefined.
                if (gpu && gpu.multisampled !== (entry.texture.multisampled === true))
                {
                    diverge(`a ${gpu.multisampled ? 'multisampled' : 'one-sample'} texture bound`
                        + ' where the shader reads the other kind is read as an empty texture');
                    return { binding: entry.binding, resource: fallback.view(entry.texture) };
                }
                if (gpu && gpu.dimension !== entry.texture.viewDimension)
                {
                    diverge(`a ${gpu.dimension} view bound where the shader reads a`
                        + ` ${entry.texture.viewDimension} one is read as an empty texture`);
                    return { binding: entry.binding, resource: fallback.view(entry.texture) };
                }
                return {
                    binding: entry.binding,
                    resource: gpu ? gpu.view : fallback.view(entry.texture),
                };
            }
            const sampler = stage.samplers[entry.binding - BINDING.SAMPLER];
            const comparison = entry.sampler?.type === 'comparison';
            if (sampler && comparison !== isComparisonSampler(sampler))
            {
                diverge('a sampler bound where the shader declares the other kind, comparison'
                    + ' or not, is replaced by a point sampler of the declared kind');
            }
            return {
                binding: entry.binding,
                resource: sampler && comparison === isComparisonSampler(sampler)
                    ? samplerOf(sampler)
                    : comparison ? fallback.comparison : fallback.sampler,
            };
        });
    };

    /**
     * A copy made by the GPU, recorded in its turn: see copySubresourceRegion.
     *
     * @param {any} destination
     * @param {number} destinationSubresource
     * @param {{ x: number, y: number, z: number }} at
     * @param {any} source
     * @param {number} sourceSubresource
     * @param {Box | null} box
     * @returns {boolean} whether the GPU makes it
     */
    const gpuCopy = (destination, destinationSubresource, at, source, sourceSubresource, box)=>{
        const from = backingOf(source);
        const to = backingOf(destination);
        // A multisampled texture is copied only whole, into another of its
        // sample count: there is no reading one back.
        if (!from.texture || from.layout.storage.depth
            || (from.sampleCount !== 1 && (box || at.x !== 0 || at.y !== 0
                || to.sampleCount !== from.sampleCount)))
        {
            return false;
        }
        const is3D = source.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D;
        const src = subresourceOf(source, sourceSubresource);
        const dst = subresourceOf(destination, destinationSubresource);
        const fromLevel = from.layout.levels[src.level];
        const toLevel = to.layout.levels[dst.level];
        const region = box ?? {
            left: 0, top: 0, front: 0,
            right: fromLevel.width, bottom: fromLevel.height, back: fromLevel.depth,
        };
        const size = {
            width: Math.min(region.right, fromLevel.width) - region.left,
            height: Math.min(region.bottom, fromLevel.height) - region.top,
            depthOrArrayLayers: Math.min(region.back, fromLevel.depth) - region.front,
        };
        size.width = Math.min(size.width, toLevel.width - at.x);
        size.height = Math.min(size.height, toLevel.height - at.y);
        size.depthOrArrayLayers = Math.min(size.depthOrArrayLayers, toLevel.depth - at.z);
        if (size.width <= 0 || size.height <= 0 || size.depthOrArrayLayers <= 0)
        {
            return true;
        }
        if (to.texture)
        {
            if (!copyCompatible(from.layout.format, to.layout.format)
                || to.layout.storage.depth || to.sampleCount !== from.sampleCount)
            {
                return false;
            }
            record({
                kind: 'copyTexture',
                sourceId: from.id,
                destinationId: to.id,
                source: {
                    texture: from.texture, mipLevel: src.level,
                    origin: { x: region.left, y: region.top, z: is3D ? region.front : src.slice },
                },
                destination: {
                    texture: to.texture, mipLevel: dst.level,
                    origin: { x: at.x, y: at.y, z: is3D ? at.z : dst.slice },
                },
                size,
            });
            to.gpuDirty = true;
            return true;
        }
        // A staging resource: the level comes back whole, and the box is
        // placed where the program asked.
        if (destination.desc.Usage !== D3D10_USAGE.STAGING || !readable(from) || is3D)
        {
            return false;
        }
        const texel = TEXEL_BYTES[from.layout.storage.format];
        /** @type {(value?: any) => void} */
        let resolve = ()=>{};
        const promise = new Promise(done=>{
            resolve = done;
        });
        const waiting = { promise, sequence: recordedCount + 1 };
        let delivered = false;
        record({
            kind: 'readback',
            sourceId: from.id,
            surface: {
                texture: from.texture, mipLevel: src.level, layer: src.slice,
                width: fromLevel.width, height: fromLevel.height, bytesPerTexel: texel,
            },
            /** @param {{ width: number, height: number, data: Uint8Array } | null} image */
            deliver(image){
                if (delivered)
                {
                    return;
                }
                delivered = true;
                if (image)
                {
                    const into = subresourceBytes(destination, destinationSubresource);
                    for (let row = 0; row < size.height; row++)
                    {
                        const start = ((region.top + row) * image.width + region.left) * texel;
                        into.bytes.set(image.data.subarray(start, start + size.width * texel),
                            (at.y + row) * into.rowPitch + at.x * texel);
                    }
                }
                else
                {
                    diverge('a read back that did not arrive leaves the staging resource as it'
                        + ' was');
                }
                if (to.readback === waiting)
                {
                    to.readback = null;
                }
                resolve();
            },
        });
        to.readback = waiting;
        return true;
    };

    /** @type {Map<string, Promise<any>>} format -> the pipeline that draws a level from above */
    const mipPipelines = new Map();

    /** @param {string} format */
    const mipPipelineFor = format=>{
        let built = mipPipelines.get(format);
        if (!built)
        {
            built = (async()=>{
                const module = await backend.createShaderModule({
                    code: MIP_SHADER, label: 'd3d10:mips',
                });
                const layout = layoutFor([
                    { binding: 0, visibility: STAGE.FRAGMENT,
                        texture: { sampleType: 'float', viewDimension: '2d' } },
                    { binding: 1, visibility: STAGE.FRAGMENT, sampler: { type: 'filtering' } },
                ], 'd3d10:mips');
                const gpu = backend.createRenderPipeline({
                    label: `d3d10:mips:${format}`,
                    layout: backend.createPipelineLayout({
                        label: 'd3d10:mips', bindGroupLayouts: [layout],
                    }),
                    vertex: { module, entryPoint: 'vertexMain', buffers: [] },
                    fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
                    primitive: { topology: 'triangle-list' },
                });
                return { gpu, layout };
            })();
            mipPipelines.set(format, built);
        }
        return built;
    };

    /** @type {any} */
    let mipSampler = null;

    /**
     * Every level below the top drawn from the one above by the GPU, one
     * slice at a time: a linear sample at the middle of each two-by-two
     * block is its average.
     *
     * @param {any} resource
     * @param {any} backing
     */
    const recordMips = (resource, backing)=>{
        mipSampler = mipSampler ?? createSampler({
            label: 'd3d10:mips', magFilter: 'linear', minFilter: 'linear',
        });
        const format = backing.layout.format;
        const steps = [];
        for (let slice = 0; slice < backing.layout.slices; slice++)
        {
            for (let level = 1; level < backing.layout.levels.length; level++)
            {
                /** @param {number} mip @param {string} label */
                const view = (mip, label)=>backing.texture.createView({
                    label, format, dimension: '2d', baseMipLevel: mip, mipLevelCount: 1,
                    baseArrayLayer: slice, arrayLayerCount: 1,
                });
                const geometry = backing.layout.levels[level];
                steps.push({
                    surface: {
                        texture: backing.texture,
                        view: view(level, 'd3d10:mips:target'),
                        width: geometry.width,
                        height: geometry.height,
                        format,
                        label: `d3d10:mips:${level}`,
                    },
                    entries: [
                        { binding: 0, resource: view(level - 1, 'd3d10:mips:source') },
                        { binding: 1, resource: mipSampler },
                    ],
                });
            }
        }
        record({ kind: 'blit', ids: [backing.id], what: 'mips were not generated',
            pipeline: mipPipelineFor(format), steps });
        backing.gpuDirty = true;
    };

    /** @type {Map<string, Promise<any>>} format -> the pipeline that resolves into it */
    const resolvePipelines = new Map();

    /** @param {string} format */
    const resolvePipelineFor = format=>{
        let built = resolvePipelines.get(format);
        if (!built)
        {
            built = (async()=>{
                const module = await backend.createShaderModule({
                    code: RESOLVE_SHADER, label: 'd3d10:resolve',
                });
                const layout = layoutFor([
                    { binding: 0, visibility: STAGE.FRAGMENT, texture: {
                        sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: true,
                    } },
                ], 'd3d10:resolve');
                const gpu = backend.createRenderPipeline({
                    label: `d3d10:resolve:${format}`,
                    layout: backend.createPipelineLayout({
                        label: 'd3d10:resolve', bindGroupLayouts: [layout],
                    }),
                    vertex: { module, entryPoint: 'vertexMain', buffers: [] },
                    fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
                    primitive: { topology: 'triangle-list' },
                });
                return { gpu, layout };
            })();
            resolvePipelines.set(format, built);
        }
        return built;
    };

    /**
     * Records a multisampled level's resolve into one level and slice of a
     * one-sample texture, both read in the format the resolve names.
     *
     * @param {any} from          The multisampled backing.
     * @param {any} to            The one-sample backing.
     * @param {number} level
     * @param {number} slice
     * @param {string} format     A WebGPU format both are viewed in.
     */
    const recordResolve = (from, to, level, slice, format)=>{
        const geometry = to.layout.levels[level];
        record({
            kind: 'blit',
            ids: [from.id, to.id],
            what: 'a multisampled texture was not resolved',
            pipeline: resolvePipelineFor(format),
            steps: [{
                surface: {
                    texture: to.texture,
                    view: to.texture.createView({
                        label: 'd3d10:resolve:target', format, dimension: '2d',
                        baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: slice,
                        arrayLayerCount: 1,
                    }),
                    width: geometry.width,
                    height: geometry.height,
                    format,
                    label: 'd3d10:resolve',
                },
                entries: [{ binding: 0, resource: from.texture.createView({
                    label: 'd3d10:resolve:source', format, dimension: '2d',
                }) }],
            }],
        });
        to.gpuDirty = true;
    };

    /**
     * What a multisampled back buffer is shown as: a one-sample texture of
     * its format, resolved into before each present.
     *
     * @param {any} backing
     */
    const presentedOf = backing=>{
        if (!backing.presented)
        {
            const texture = createTexture({
                label: `d3d10:presented:${backing.layout.format}`,
                size: { width: backing.surface.width, height: backing.surface.height,
                    depthOrArrayLayers: 1 },
                format: backing.layout.format,
                usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                    | TextureUsage.COPY_SRC,
            });
            backing.presented = {
                id: nextBacking++,
                texture,
                layout: { levels: [{ width: backing.surface.width,
                    height: backing.surface.height }] },
                surface: { ...backing.surface, texture,
                    view: texture.createView({ label: 'd3d10:presented' }) },
            };
        }
        return backing.presented;
    };

    return {
        /**
         * @param {any} resource
         * @param {SubresourceData[] | null} initialData
         */
        resourceCreated(resource, initialData){
            const backing = backingOf(resource);
            if (!initialData)
            {
                return;
            }
            const levels = resource.desc.MipLevels ?? 1;
            const slices = backing.layout.slices;
            for (let index = 0; index < levels * slices && index < initialData.length; index++)
            {
                const source = initialData[index];
                if (!source || !source.pSysMem)
                {
                    continue;
                }
                const held = subresourceBytes(resource, index);
                const geometry = held.level;
                const pitch = source.SysMemPitch || held.rowPitch;
                const slicePitch = source.SysMemSlicePitch || pitch * geometry.rows;
                for (let z = 0; z < geometry.depth; z++)
                {
                    for (let row = 0; row < geometry.rows; row++)
                    {
                        const from = z * slicePitch + row * pitch;
                        held.bytes.set(
                            source.pSysMem.subarray(from, from + held.rowPitch),
                            z * held.depthPitch + row * held.rowPitch);
                    }
                }
                upload(resource, index, LockFlags.DISCARD);
            }
        },

        /**
         * @param {any} resource
         * @param {number} subresource
         * @returns {{ data: Uint8Array, rowPitch: number, depthPitch: number }}
         */
        map(resource, subresource){
            const held = subresourceBytes(resource, subresource);
            return { data: held.bytes, rowPitch: held.rowPitch, depthPitch: held.depthPitch };
        },

        /**
         * @param {any} resource
         * @param {number} subresource
         * @param {boolean} discard   The program gave the old contents up.
         * @param {boolean} noOverwrite  The program promises it touched nothing in flight.
         */
        unmap(resource, subresource, discard, noOverwrite){
            upload(resource, subresource,
                discard ? LockFlags.DISCARD : noOverwrite ? LockFlags.NOOVERWRITE : LockFlags.NONE);
        },

        /**
         * @param {any} resource
         * @param {number} subresource
         * @param {Box | null} box
         * @param {Uint8Array} data
         * @param {number} rowPitch
         * @param {number} depthPitch
         */
        updateSubresource(resource, subresource, box, data, rowPitch, depthPitch){
            const held = subresourceBytes(resource, subresource);
            const geometry = held.level;
            const region = blocksOf(backingOf(resource).layout, geometry, box ?? {
                left: 0, top: 0, front: 0,
                right: geometry.width, bottom: geometry.height, back: geometry.depth,
            });
            const pitch = rowPitch || region.rowBytes;
            const slicePitch = depthPitch || pitch * region.rows;
            for (let z = 0; z < region.depth; z++)
            {
                for (let row = 0; row < region.rows; row++)
                {
                    const from = z * slicePitch + row * pitch;
                    const to = (region.front + z) * held.depthPitch
                        + (region.top + row) * held.rowPitch + region.left;
                    held.bytes.set(data.subarray(from, from + region.rowBytes), to);
                }
            }
            upload(resource, subresource, LockFlags.NONE, box);
        },

        /**
         * A copy out of what the GPU may have written is made by the GPU, in
         * its turn among the draws: into a texture it keeps, as a texture
         * copy; into a staging resource, as a read back once the frame that
         * holds it has been submitted, which a map of that resource waits
         * for. Anything else moves the host bytes the program wrote.
         *
         * @param {any} destination
         * @param {number} destinationSubresource
         * @param {{ x: number, y: number, z: number }} at
         * @param {any} source
         * @param {number} sourceSubresource
         * @param {Box | null} box
         */
        copySubresourceRegion(destination, destinationSubresource, at, source, sourceSubresource,
            box)
        {
            if (backend && gpuWritten(source))
            {
                if (gpuCopy(destination, destinationSubresource, at, source, sourceSubresource,
                    box))
                {
                    return;
                }
                diverge('a copy out of a render target the GPU cannot copy or read back moves'
                    + ' the bytes the program last wrote, not what the GPU drew');
            }
            const from = subresourceBytes(source, sourceSubresource);
            const to = subresourceBytes(destination, destinationSubresource);
            const layout = backingOf(source).layout;
            const region = blocksOf(layout, from.level, box ?? {
                left: 0, top: 0, front: 0,
                right: from.level.width, bottom: from.level.height, back: from.level.depth,
            });
            const place = blocksOf(layout, to.level, {
                left: at.x, top: at.y, front: at.z,
                right: to.level.width, bottom: to.level.height, back: to.level.depth,
            });
            const rowBytes = Math.min(region.rowBytes, place.rowBytes);
            const rows = Math.min(region.rows, place.rows);
            const depth = Math.min(region.depth, place.depth);
            for (let z = 0; z < depth; z++)
            {
                for (let row = 0; row < rows; row++)
                {
                    const start = (region.front + z) * from.depthPitch
                        + (region.top + row) * from.rowPitch + region.left;
                    to.bytes.set(from.bytes.subarray(start, start + rowBytes),
                        (place.front + z) * to.depthPitch + (place.top + row) * to.rowPitch
                            + place.left);
                }
            }
            upload(destination, destinationSubresource, LockFlags.NONE, {
                left: at.x, top: at.y, front: at.z,
                right: at.x + (box ? box.right - box.left : from.level.width),
                bottom: at.y + (box ? box.bottom - box.top : from.level.height),
                back: at.z + (box ? box.back - box.front : from.level.depth),
            });
        },

        /**
         * @param {any} destination
         * @param {any} source
         */
        copyResource(destination, source){
            const count = (source.desc.MipLevels ?? 1) * backingOf(source).layout.slices;
            if (backend && gpuWritten(source) && source.dimension
                !== D3D10_RESOURCE_DIMENSION.BUFFER)
            {
                for (let index = 0; index < count; index++)
                {
                    this.copySubresourceRegion(destination, index, { x: 0, y: 0, z: 0 },
                        source, index, null);
                }
                return;
            }
            const from = backingOf(source);
            const to = backingOf(destination);
            to.bytes.set(from.bytes.subarray(0, Math.min(from.bytes.length, to.bytes.length)));
            for (let index = 0; index < count; index++)
            {
                upload(destination, index);
            }
        },

        /**
         * A box filter down the chain, on the host, for the formats whose texels
         * are four bytes of eight bits each.
         *
         * @param {any} resource
         * @returns {boolean} whether the levels were generated
         */
        generateMips(resource){
            const backing = backingOf(resource);
            const format = backing.layout.format ?? '';
            if (backend && backing.texture && gpuWritten(resource)
                && resource.dimension !== D3D10_RESOURCE_DIMENSION.TEXTURE1D
                && resource.dimension !== D3D10_RESOURCE_DIMENSION.TEXTURE3D
                && FILTERED_TARGET.test(format) && backing.sampleCount === 1)
            {
                recordMips(resource, backing);
                return true;
            }
            if (backing.layout.texelBytes !== 4 || backing.layout.storage?.conversion
                || !(format.startsWith('rgba8') || format.startsWith('bgra8')))
            {
                diverge(`GenerateMips on a ${backing.layout.format} texture is not generated:`
                    + ' only eight-bit four-channel formats are filtered');
                return false;
            }
            if (gpuWritten(resource))
            {
                diverge('GenerateMips filters the bytes the program last wrote into level zero,'
                    + ' not what the GPU drew there');
            }
            for (let slice = 0; slice < backing.layout.slices; slice++)
            {
                for (let level = 1; level < backing.layout.levels.length; level++)
                {
                    const first = slice * resource.desc.MipLevels;
                    const upper = subresourceBytes(resource, first + level - 1);
                    const lower = subresourceBytes(resource, first + level);
                    for (let y = 0; y < lower.level.height; y++)
                    {
                        for (let x = 0; x < lower.level.width; x++)
                        {
                            for (let channel = 0; channel < 4; channel++)
                            {
                                let sum = 0;
                                for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]])
                                {
                                    const sx = Math.min(upper.level.width - 1, x * 2 + dx);
                                    const sy = Math.min(upper.level.height - 1, y * 2 + dy);
                                    sum += upper.bytes[sy * upper.rowPitch + sx * 4 + channel];
                                }
                                lower.bytes[y * lower.rowPitch + x * 4 + channel] = (sum + 2) >> 2;
                            }
                        }
                    }
                    upload(resource, slice * resource.desc.MipLevels + level);
                }
            }
            return true;
        },

        /**
         * @param {any} view a render target view
         * @param {number[]} color
         */
        clearRenderTargetView(view, color){
            if (!backend)
            {
                return;
            }
            const target = targetOf(view);
            if (!target)
            {
                counters.skipped.noTarget++;
                return;
            }
            counters.clears++;
            record({ kind: 'clear', target, color: [...color] });
        },

        /**
         * @param {any} view a depth stencil view
         * @param {number} flags
         * @param {number} depth
         * @param {number} stencil
         */
        clearDepthStencilView(view, flags, depth, stencil){
            if (!backend)
            {
                return;
            }
            const target = targetOf(view);
            if (!target)
            {
                counters.skipped.noTarget++;
                return;
            }
            counters.clears++;
            record({ kind: 'clearDepth', target, flags, depth, stencil });
        },

        /**
         * @param {PipelineSnapshot} pipeline
         * @param {{ vertexCount: number, startVertex: number, instanceCount?: number,
         *           indexCount?: number, startIndex?: number, baseVertex?: number,
         *           startInstance?: number }} draw
         */
        draw(pipeline, draw){
            if (!backend)
            {
                return;
            }
            // Every bound render target, by slot, and the depth target: the
            // first of them sizes the pass, and a draw with a depth target and
            // no colour one draws depth alone.
            const depth = targetOf(pipeline.depthStencilView);
            const bound = pipeline.renderTargets.map(view=>targetOf(view));
            const sizing = bound.find(entry=>entry) ?? depth;
            if (!sizing)
            {
                counters.skipped.noTarget++;
                return;
            }
            const colour = bound.map(entry=>(entry
                && (entry.surface.width !== sizing.surface.width
                    || entry.surface.height !== sizing.surface.height)
                ? null
                : entry));
            if (colour.some((entry, index)=>entry !== bound[index]))
            {
                diverge('a render target of another size than the first is not drawn into:'
                    + ' the targets of a pass are one size');
            }
            while (colour.length > 0 && !colour[colour.length - 1])
            {
                colour.pop();
            }
            const target = colour.find(entry=>entry) ?? null;
            const viewport = pipeline.viewports[0];
            if (!viewport || !(viewport.Width > 0) || !(viewport.Height > 0))
            {
                counters.skipped.noViewport++;
                return;
            }
            // Without a pixel shader the draw still runs: it writes depth and
            // stencil and no render target, as a depth-only pass expects.
            if (!pipeline.stages.vs.shader)
            {
                counters.skipped.noShader++;
                return;
            }
            const topology = TOPOLOGY[pipeline.topology];
            if (!topology)
            {
                diverge(`primitive topology ${pipeline.topology} cannot be drawn`);
                return;
            }
            const indexFormat = INDEX_FORMAT[pipeline.indexFormat] ?? null;
            const state = {
                vertexShader: pipeline.stages.vs.shader,
                pixelShader: pipeline.stages.ps.shader,
                // No layout feeds no attribute: the draw runs on what the
                // vertex shader makes of its system values alone.
                inputLayout: pipeline.inputLayout ?? NO_INPUT_LAYOUT,
                blendState: pipeline.blendState,
                depthStencilState: pipeline.depthStencilState,
                rasterizerState: pipeline.rasterizerState,
                topology,
                targetFormats: colour.map(entry=>(entry ? entry.format : null)),
                targetWriteMasks: colour.map(entry=>(entry ? entry.writeMask : 0)),
                depthFormat: depth ? depth.format : null,
                sampleMask: pipeline.sampleMask,
                sampleCount: sizing.sampleCount,
                strides: pipeline.vertexStrides.slice(),
                indexFormat: draw.indexCount === undefined ? null : indexFormat,
                vsMultisampled: multisampledSlotsOf(pipeline.stages.vs),
                psMultisampled: multisampledSlotsOf(pipeline.stages.ps),
            };
            const rasterizer = pipeline.rasterizerState
                ? stateDesc(pipeline.rasterizerState)
                : DEFAULT_RASTERIZER;
            const scissor = rasterizer.ScissorEnable && pipeline.scissorRects[0]
                ? pipeline.scissorRects[0]
                : null;
            const program = linkProgram(translationOf(state.vertexShader, state.vsMultisampled),
                translationOf(state.pixelShader, state.psMultisampled));
            const vertexBuffers = pipeline.vertexBuffers.map((buffer, slot)=>{
                const backing = buffer ? backingOf(buffer) : null;
                if (!backing || !backing.gpu)
                {
                    return null;
                }
                // The bytes this draw reads have to survive a later write into
                // the same buffer, which is what makes such a write rename.
                backing.gpu.markRead();
                return { gpu: backing.gpu.gpu, offset: pipeline.vertexOffsets[slot],
                    stride: pipeline.vertexStrides[slot] };
            });
            const indexBacking = pipeline.indexBuffer ? backingOf(pipeline.indexBuffer) : null;
            if (indexBacking && indexBacking.gpu && pipeline.indexBuffer)
            {
                indexBacking.gpu.markRead();
            }
            counters.draws++;
            for (const counter of occluding)
            {
                if (!recordingCounters.has(counter))
                {
                    recordingCounters.add(counter);
                    counter.outstanding++;
                }
            }
            record({
                kind: 'draw',
                pipeline: pipelineFor(state),
                target,
                targets: colour,
                depth,
                groups: [
                    bindingsFor(pipeline.stages.vs, program.groups[0]),
                    bindingsFor(pipeline.stages.ps, program.groups[1]),
                ],
                vertexBuffers,
                indexBuffer: indexBacking && indexBacking.gpu && indexFormat
                    ? { gpu: indexBacking.gpu.gpu, format: indexFormat,
                        offset: pipeline.indexOffset }
                    : null,
                layout: state.inputLayout.elements,
                viewport: {
                    x: viewport.TopLeftX,
                    y: viewport.TopLeftY,
                    width: viewport.Width,
                    height: viewport.Height,
                    minDepth: viewport.MinDepth,
                    maxDepth: viewport.MaxDepth,
                },
                scissor: scissor
                    ? { x: scissor.left, y: scissor.top, width: scissor.right - scissor.left,
                        height: scissor.bottom - scissor.top }
                    : null,
                topology,
                vertexCount: draw.vertexCount,
                startVertex: draw.startVertex,
                instanceCount: draw.instanceCount ?? 1,
                startInstance: draw.startInstance ?? 0,
                stencilRef: pipeline.stencilRef,
                blendFactor: [...pipeline.blendFactor],
                occlusion: occluding.size > 0 ? [...occluding] : null,
                indexCount: draw.indexCount ?? null,
                startIndex: draw.startIndex ?? 0,
                baseVertex: draw.baseVertex ?? 0,
            });
        },

        /**
         * Replays what was recorded onto one frame and shows the back buffer.
         *
         * @param {any} backBuffer the swap chain's buffer zero
         * @returns {Promise<void>} settled when the frame has been submitted
         */
        present(backBuffer){
            if (!backend)
            {
                counters.frames++;
                return chain;
            }
            counters.frames++;
            const backing = backingOf(backBuffer);
            if (backing.sampleCount > 1 && backing.texture)
            {
                const shown = presentedOf(backing);
                recordResolve(backing, shown, 0, 0, backing.layout.format);
                return submit(shown.surface);
            }
            return submit(backing.surface);
        },

        /**
         * The resolve of a multisampled subresource into a one-sample one,
         * in the format given, which both resources have to be viewable as.
         *
         * @param {any} destination
         * @param {number} destinationSubresource
         * @param {any} source
         * @param {number} sourceSubresource
         * @param {number} format  The DXGI format the samples are averaged in.
         */
        resolve(destination, destinationSubresource, source, sourceSubresource, format){
            if (!backend)
            {
                return;
            }
            void sourceSubresource;
            const from = backingOf(source);
            const to = backingOf(destination);
            if (!from.texture || !to.texture)
            {
                return;
            }
            const read = viewFormatOf(from.layout.storage, format, { compressed });
            const written = viewFormatOf(to.layout.storage, format, { compressed });
            if (!read.format || read.reinterpreted || written.reinterpreted
                || read.format !== written.format || !resolvable(read.format))
            {
                diverge(`a resolve in format ${format} is not made: the GPU views the two`
                    + ` textures as ${read.format ?? read.aspect} and`
                    + ` ${written.format ?? written.aspect}`);
                return;
            }
            const { level, slice } = subresourceOf(destination, destinationSubresource);
            recordResolve(from, to, level, slice, read.format);
        },

        /**
         * A counter the draws recorded from now on count their samples into,
         * or null without a GPU to count them.
         *
         * @returns {OcclusionCounter | null}
         */
        beginOcclusion(){
            if (!backend)
            {
                return null;
            }
            /** @type {OcclusionCounter} */
            const counter = {
                samples: 0, outstanding: 0, ended: false, settled: false, failed: false,
            };
            occluding.add(counter);
            return counter;
        },

        /** @param {OcclusionCounter} counter */
        endOcclusion(counter){
            occluding.delete(counter);
            counter.ended = true;
            settle(counter);
        },

        /**
         * Hands what has been recorded to the GPU without showing anything:
         * the next present starts from what is left, which is nothing.
         *
         * @returns {Promise<void>} settled when it has been submitted
         */
        flush(){
            if (!backend || recording.length === 0)
            {
                handedOver = recordedCount;
                return chain;
            }
            return submit(null);
        },

        /**
         * The read back a map of this resource has to wait for, sent to the
         * GPU if it has not been: null when there is none.
         *
         * @param {any} resource
         * @returns {Promise<void> | null}
         */
        pendingReadback(resource){
            const waiting = backings.get(resource)?.readback ?? null;
            if (!waiting)
            {
                return null;
            }
            if (waiting.sequence > handedOver)
            {
                this.flush();
            }
            return waiting.promise;
        },

        /** @returns {number} commands recorded so far */
        recorded: ()=>recordedCount,

        /** @returns {number} commands handed to the GPU so far */
        submitted: ()=>handedOver,

        idle: ()=>chain,

        /** @returns {any} */
        diagnostics(){
            // lastFrame is not enumerable: its commands hold live resources,
            // and a table posted to the page must not walk the device.
            return Object.defineProperty({
                frames: counters.frames,
                draws: counters.draws,
                clears: counters.clears,
                skipped: { ...counters.skipped },
                failures: [...counters.failures],
                pipelines: pipelines.size,
            }, 'lastFrame', { value: lastFrame });
        },
    };

    /**
     * The recording so far, onto one backend frame in its turn.
     *
     * @param {any} surface  What the frame shows, or null for a flush.
     * @returns {Promise<void>}
     */
    function submit(surface){
        const recorded = recording;
        recording = [];
        handedOver = recordedCount;
        const counting = recordingCounters;
        recordingCounters = new Set();
        const cut = backend.markPresent();
        chain = chain.then(()=>replay(recorded, surface, cut)).catch(failure=>{
            counters.failures.push(String(failure && failure.message || failure));
            diverge(`a frame could not be replayed: ${failure && failure.message || failure}`);
            for (const counter of counting)
            {
                counter.failed = true;
            }
        }).then(()=>{
            for (const counter of counting)
            {
                counter.outstanding--;
                settle(counter);
            }
            // A read back that never arrived leaves the host bytes as they
            // were, rather than a map waiting for ever.
            for (const command of recorded)
            {
                if (command.kind === 'readback')
                {
                    command.deliver(null);
                }
            }
        });
        return chain;
    }

    /**
     * @param {any[]} recorded
     * @param {any} surface
     * @param {number} cut   the backend's cut the recording was queued as
     */
    async function replay(recorded, surface, cut){
        const pipelinesNeeded = await Promise.allSettled(
            recorded.map(command=>command.pipeline ?? null));
        const frame = backend.beginFrame({ cut });
        /** @type {{ read: () => Promise<any>, command: any }[]} */
        const readers = [];
        const counting = recorded.some(command=>command.occlusion);
        /** @type {{ slot: number, counters: OcclusionCounter[], area: number }[]} */
        const counted = [];
        /** @type {(() => Promise<number[]>) | null} */
        let readCounts = null;
        /** @type {any} */
        let pass = null;
        /** @type {string | null} */
        let passTargets = null;
        /** @type {any} */
        let passDepth = null;
        let passStencil = 0;
        let passBlend = '';

        const closePass = ()=>{
            pass = null;
            passTargets = null;
            passDepth = null;
        };

        /**
         * A pass over these colour targets, by slot, and this depth target;
         * the one open already when it is the same. A clear still waiting on
         * any of them is made by the pass's load.
         *
         * @param {any[]} targetList
         * @param {any} depth
         */
        const passFor = (targetList, depth)=>{
            const key = targetList.map(entry=>(entry ? entry.key : '-')).join('|');
            if (pass && passTargets === key && passDepth === depth)
            {
                return pass;
            }
            const clearValues = targetList.map(entry=>{
                const clear = entry ? pendingClears.get(entry.key) ?? null : null;
                if (!clear || !clear.color)
                {
                    return null;
                }
                pendingClears.delete(entry.key);
                return { r: clear.color[0], g: clear.color[1], b: clear.color[2],
                    a: clear.color[3] };
            });
            const depthClear = depth ? pendingClears.get(depth.key) ?? null : null;
            if (depth)
            {
                pendingClears.delete(depth.key);
            }
            pass = frame.beginPass({
                targets: targetList.map(entry=>(entry ? entry.surface : null)),
                clearValues,
                ...(depth ? { depthTarget: depth.surface } : {}),
                occlusion: counting,
                ...(depth
                    ? {
                        depthStencilAttachment: {
                            view: depth.surface.view,
                            depthLoadOp: depthClear && (depthClear.flags & D3D10_CLEAR.DEPTH)
                                ? 'clear'
                                : 'load',
                            depthStoreOp: 'store',
                            depthClearValue: depthClear ? depthClear.depth : 1,
                            ...(depth.format.endsWith('stencil8')
                                ? {
                                    stencilLoadOp: depthClear
                                        && (depthClear.flags & D3D10_CLEAR.STENCIL)
                                        ? 'clear'
                                        : 'load',
                                    stencilStoreOp: 'store',
                                    stencilClearValue: depthClear ? depthClear.stencil : 0,
                                }
                                : {}),
                        },
                    }
                    : {}),
            });
            passTargets = key;
            passDepth = depth;
            // What a new pass compares against, and blends by, until a draw
            // says otherwise.
            passStencil = 0;
            passBlend = '0,0,0,0';
            return pass;
        };

        /**
         * A clear still waiting for a pass on a texture a copy is about to
         * read or write happens first, in a pass of its own.
         *
         * @param {number} id  The backing's.
         */
        const settleClears = id=>{
            for (const [key, clear] of [...pendingClears])
            {
                if (clear.color && key.startsWith(`${id}:`))
                {
                    closePass();
                    passFor([clear.target], null);
                }
            }
            closePass();
        };

        try
        {
            for (const [position, command] of recorded.entries())
            {
                if (command.kind === 'clear')
                {
                    closePass();
                    pendingClears.set(command.target.key,
                        { color: command.color, target: command.target });
                    continue;
                }
                if (command.kind === 'copyTexture')
                {
                    settleClears(command.sourceId);
                    settleClears(command.destinationId);
                    frame.copyTexture(command.source, command.destination, command.size);
                    continue;
                }
                if (command.kind === 'readback')
                {
                    settleClears(command.sourceId);
                    readers.push({ read: frame.snapshot(command.surface), command });
                    continue;
                }
                if (command.kind === 'blit')
                {
                    command.ids.forEach(settleClears);
                    const built = pipelinesNeeded[position];
                    if (built.status === 'rejected')
                    {
                        diverge(`${command.what}: ${built.reason && built.reason.message
                            || built.reason}`);
                        continue;
                    }
                    for (const step of command.steps)
                    {
                        const blitPass = frame.beginPass({ target: step.surface });
                        blitPass.setPipeline(built.value.gpu);
                        blitPass.setBindings(0, built.value.layout, step.entries,
                            step.surface.label);
                        blitPass.draw(3, 1, 0, 0);
                    }
                    closePass();
                    continue;
                }
                if (command.kind === 'clearDepth')
                {
                    closePass();
                    const previous = pendingClears.get(command.target.key);
                    // Two clears of one half each add up; a later clear of a
                    // half replaces the earlier value of that half.
                    pendingClears.set(command.target.key, {
                        flags: (previous ? previous.flags : 0) | command.flags,
                        depth: (command.flags & D3D10_CLEAR.DEPTH)
                            ? command.depth
                            : previous ? previous.depth : 1,
                        stencil: (command.flags & D3D10_CLEAR.STENCIL)
                            ? command.stencil
                            : previous ? previous.stencil : 0,
                    });
                    continue;
                }
                const settled = pipelinesNeeded[position];
                if (settled.status === 'rejected')
                {
                    counters.skipped[settled.reason?.untranslatable
                        ? 'untranslatable'
                        : 'pipeline']++;
                    diverge(`a draw was skipped: ${settled.reason && settled.reason.message
                        || settled.reason}`);
                    continue;
                }
                const pipeline = settled.value;
                const current = passFor(command.targets, command.depth);
                current.setPipeline(pipeline.gpu);
                current.setViewport(command.viewport);
                if (command.scissor)
                {
                    current.setScissor(command.scissor);
                }
                pipeline.groupLayouts.forEach(
                    (/** @type {any} */ layout, /** @type {number} */ index)=>{
                        current.setBindings(index, layout, command.groups[index],
                            `d3d10:${index === 0 ? 'vs' : 'ps'}`);
                    });
                if (passStencil !== command.stencilRef)
                {
                    current.setStencilReference(command.stencilRef);
                    passStencil = command.stencilRef;
                }
                const blendFactor = command.blendFactor.join(',');
                if (passBlend !== blendFactor)
                {
                    const [r, g, b, a] = command.blendFactor;
                    current.setBlendConstant({ r, g, b, a });
                    passBlend = blendFactor;
                }
                pipeline.slots.forEach((/** @type {number} */ slot, /** @type {number} */ index)=>{
                    const buffer = command.vertexBuffers[slot];
                    if (buffer)
                    {
                        // SV_InstanceID counts from zero whatever the first
                        // instance, where WebGPU's instance index counts from
                        // it: the per-instance streams start there instead.
                        const skipped = pipeline.steps[index] === 'instance'
                            ? command.startInstance * buffer.stride
                            : 0;
                        current.setVertexBuffer(index, buffer.gpu, buffer.offset + skipped);
                    }
                });
                if (command.indexCount !== null)
                {
                    if (!command.indexBuffer)
                    {
                        diverge('an indexed draw with no index buffer is skipped');
                        continue;
                    }
                    current.setIndexBuffer(command.indexBuffer.gpu, command.indexBuffer.format,
                        command.indexBuffer.offset);
                }
                const slot = command.occlusion ? current.beginOcclusionQuery() : null;
                if (command.indexCount !== null)
                {
                    current.drawIndexed(command.indexCount, command.instanceCount,
                        command.startIndex, command.baseVertex, 0);
                }
                else
                {
                    current.draw(command.vertexCount, command.instanceCount,
                        command.startVertex, 0);
                }
                if (slot !== null)
                {
                    current.endOcclusionQuery();
                    counted.push({ slot, counters: command.occlusion,
                        area: reachableArea(command.viewport, command.scissor ?? null) });
                }
                else if (command.occlusion)
                {
                    // Every slot of the frame's set is spent: this draw's
                    // samples go uncounted, and its queries cannot answer.
                    for (const counter of command.occlusion)
                    {
                        counter.failed = true;
                    }
                }
            }
            // A clear that met no draw still has to happen before the frame
            // is shown: a program that only clears expects to see the colour.
            for (const [key, clear] of [...pendingClears])
            {
                if (!clear.color)
                {
                    continue;
                }
                const target = recorded.find(command=>command.kind === 'clear'
                    && command.target.key === key);
                if (target)
                {
                    closePass();
                    passFor([target.target], null);
                }
            }
            if (surface)
            {
                frame.present(surface);
            }
            if (counting)
            {
                readCounts = frame.occlusionResults();
            }
        }
        finally
        {
            // One object owns the encoder and one call releases it; a throw
            // above must not leave the frame open for every present after.
            frame.end();
        }
        for (const reader of readers)
        {
            reader.command.deliver(await reader.read());
        }
        if (readCounts)
        {
            const values = await readCounts();
            for (const { slot, counters: into, area } of counted)
            {
                const { samples, assumed } = passedSamples(values[slot] ?? 0, area);
                if (assumed && !assumedCountReported)
                {
                    assumedCountReported = true;
                    diverge('an occlusion query counts every pixel its draws could cover:'
                        + ' the GPU said only that some sample passed, not how many');
                }
                for (const counter of into)
                {
                    counter.samples += samples;
                }
            }
        }
        // The record a test reads, without the promise a draw carried.
        lastFrame = recorded.map(command=>{
            if (!command.pipeline)
            {
                return command;
            }
            const copy = { ...command };
            delete copy.pipeline;
            return copy;
        });
    }
}

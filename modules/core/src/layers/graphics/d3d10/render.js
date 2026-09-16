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
 * with the whole state it depends on, and a present replays the record onto
 * one backend frame once every pipeline it needs has been built. The replay is
 * where the backend's rules are honoured -- one encoder, one submit, a pass per
 * change of target -- and the record is what a test reads back to know what was
 * drawn.
 *
 * Every resource keeps a host copy of its bytes. That is what a map hands out
 * and an unmap reads back, what a copy between resources moves, and what an
 * upload sends. It is also the honest limit of this cut: a resource the GPU
 * wrote -- a render target -- has no host copy worth reading, and a copy out of
 * one says so rather than copying stale bytes quietly.
 *
 * What this cut does not do is stated where it is decided, each as a divergence
 * that names the call: several render targets at once, a blend factor or a
 * stencil reference that is not the default, wireframe fill, geometry shaders,
 * stream output, predication, and multisampling.
 */

import {
    D3D10_BIND, D3D10_BLEND, D3D10_BLEND_OP, D3D10_CLEAR, D3D10_COMPARISON, D3D10_CULL_MODE,
    D3D10_DEPTH_WRITE_MASK, D3D10_FILL_MODE, D3D10_FILTER, D3D10_FILTER_ANISOTROPIC_BIT,
    D3D10_FILTER_COMPARISON_BIT, D3D10_INPUT_CLASSIFICATION, D3D10_PRIMITIVE_TOPOLOGY,
    D3D10_RESOURCE_DIMENSION, D3D10_STENCIL_OP, D3D10_TEXTURE_ADDRESS, D3D10_USAGE,
    D3D10_APPEND_ALIGNED_ELEMENT,
} from './constants.js';
import {
    INDEX_FORMAT, TEXEL_BYTES, TEXTURE_FORMAT, VERTEX_FORMAT, VERTEX_FORMAT_BYTES,
} from './gpuformats.js';
import { levelExtent } from './validity.js';
import { BINDING, linkProgram, translateShader } from './wgsl.js';
import { LockFlags } from '../webgpu/internal/buffers.js';

/**
 * @typedef {Object} RenderServices
 * @property {any} backend  The WebGPU backend (`webgpu/backend.js`), or null to keep
 *                          every resource's bytes without a GPU behind them.
 * @property {(descriptor: object) => any} createSampler
 * @property {(descriptor: object) => any} createTexture
 * @property {(api: string, detail: string) => void} [divergence]
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

/** The state a null rasterizer, depth-stencil or blend state stands for. */
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
    /** @type {WeakMap<object, any>} sampler state -> GPU sampler */
    const samplers = new WeakMap();
    /** @type {WeakMap<object, any>} shader -> translation */
    const translations = new WeakMap();
    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    /** @type {Map<string, any>} */
    const layouts = new Map();
    /** @type {any} */
    let placeholders = null;

    /** @type {any[]} commands recorded since the last present */
    let recording = [];
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    /** @type {any[]} */
    let lastFrame = [];
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
     * @property {number} rowPitch
     * @property {number} depthPitch
     * @property {number} width
     * @property {number} height
     * @property {number} depth
     */

    /**
     * @typedef {Object} ResourceLayout
     * @property {string | null} format  The GPU spelling, or null for a buffer.
     * @property {number} texelBytes
     * @property {LevelGeometry[]} levels
     * @property {number} sliceBytes     One array slice, every level of it.
     * @property {number} slices
     */

    /**
     * How a resource's bytes are laid out on the host: every level of a slice
     * back to back, then the next slice, as the subresource numbering counts.
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
                texelBytes: 1,
                levels: [{
                    offset: 0, rowPitch: desc.ByteWidth, depthPitch: desc.ByteWidth,
                    width: desc.ByteWidth, height: 1, depth: 1,
                }],
                sliceBytes: desc.ByteWidth,
                slices: 1,
            };
        }
        const format = TEXTURE_FORMAT[desc.Format] ?? null;
        const texelBytes = format ? TEXEL_BYTES[format] : 4;
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
            const rowPitch = width * texelBytes;
            const depthPitch = rowPitch * height;
            levels.push({ offset, rowPitch, depthPitch, width, height, depth });
            offset += depthPitch * depth;
        }
        return {
            format,
            texelBytes,
            levels,
            sliceBytes: offset,
            slices: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? 1
                : desc.ArraySize,
        };
    };

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
            layout, bytes, gpu: null, texture: null, surface: null,
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
                        | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
                });
            }
        }
        else if (layout.format && desc.Usage !== D3D10_USAGE.STAGING)
        {
            let usage = TextureUsage.COPY_DST | TextureUsage.COPY_SRC;
            if ((desc.BindFlags & (D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL)) !== 0)
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
            backing.texture = createTexture({
                label: `d3d10:texture${resource.dimension - 1}d:${layout.format}`,
                size,
                mipLevelCount: desc.MipLevels,
                sampleCount: desc.SampleDesc.Count,
                dimension: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                    ? '3d'
                    : resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D ? '1d' : '2d',
                format: layout.format,
                usage,
            });
            // The surface the backend attaches passes to: the whole of level
            // zero, which is what a swap chain's buffer is.
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
     * @returns {{ bytes: Uint8Array, rowPitch: number, depthPitch: number, level: any }}
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
     * Sends a subresource's host bytes to the GPU.
     *
     * @param {any} resource
     * @param {number} subresource
     * @param {number} [flags]  A LockFlags value for a buffer.
     */
    const upload = (resource, subresource, flags = LockFlags.NONE)=>{
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
        const { level, slice } = subresourceOf(resource, subresource);
        const geometry = backing.layout.levels[level];
        const held = subresourceBytes(resource, subresource);
        backend.uploadTexture({
            texture: backing.texture,
            format: backing.layout.format,
            width: geometry.width,
            height: geometry.height,
            depthOrArrayLayers: geometry.depth,
            mipLevel: level,
            origin: { x: 0, y: 0, z: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? 0
                : slice },
            bytesPerRow: geometry.rowPitch,
            data: held.bytes,
            staging: false,
        });
    };

    /** @param {any} resource */
    const gpuWritten = resource=>(resource.desc.BindFlags
        & (D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL)) !== 0;

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
        const format = TEXTURE_FORMAT[desc.Format] ?? backing.layout.format;
        gpu = backing.texture.createView({
            label: `d3d10:view:${format}`,
            format,
            dimension: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? '3d'
                : resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D
                    ? '1d'
                    : isCube ? 'cube' : array ? '2d-array' : '2d',
            baseMipLevel: desc.MostDetailedMip ?? desc.MipSlice ?? 0,
            mipLevelCount: desc.MipLevels ?? 1,
            baseArrayLayer: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? 0
                : desc.FirstArraySlice ?? 0,
            arrayLayerCount: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? 1
                : desc.ArraySize ?? 1,
        });
        views.set(view, gpu);
        return gpu;
    };

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

    /** What an unbound slot reads as: zeros, black, and a point sampler. */
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
        const texture = createTexture({
            label: 'd3d10:unbound-texture',
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
        });
        placeholders = {
            buffer,
            view: texture.createView({ label: 'd3d10:unbound-texture' }),
            sampler: createSampler({ label: 'd3d10:unbound-sampler' }),
        };
        return placeholders;
    };

    // --- shaders and pipelines ---

    /** @param {any} shader a shader object holding a parsed container */
    const translationOf = shader=>{
        let translation = translations.get(shader);
        if (!translation)
        {
            translation = translateShader(shader.container);
            translations.set(shader, translation);
        }
        return translation;
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
                buffer = {
                    arrayStride: strides[slot] ?? 0,
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
    const pipelineKey = state=>[
        idOf(state.vertexShader), idOf(state.pixelShader), idOf(state.inputLayout),
        idOf(state.blendState), idOf(state.depthStencilState), idOf(state.rasterizerState),
        state.topology, state.targetFormat, state.depthFormat ?? '-', state.sampleMask >>> 0,
        state.sampleCount, state.strides.join(','), state.indexFormat ?? '-',
    ].join('|');

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
     * @param {any} state the draw's captured state
     * @returns {Promise<any>}
     */
    const buildPipeline = async state=>{
        const vs = translationOf(state.vertexShader);
        const ps = translationOf(state.pixelShader);
        const program = linkProgram(vs, ps);
        if (program.unsupported.length > 0)
        {
            throw new Error(`the shaders cannot be translated: ${program.unsupported.join('; ')}`);
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
        const blend = state.blendState ? stateDesc(state.blendState) : DEFAULT_BLEND;
        if (rasterizer.FillMode === D3D10_FILL_MODE.WIREFRAME)
        {
            diverge('wireframe fill is drawn solid: the backend has no line rasterisation'
                + ' of a triangle');
        }
        if (!rasterizer.DepthClipEnable)
        {
            diverge('depth clipping stays on: turning it off needs a device feature this'
                + ' build does not ask for');
        }
        for (const factor of [blend.SrcBlend, blend.DestBlend, blend.SrcBlendAlpha,
            blend.DestBlendAlpha])
        {
            if (blend.BlendEnable[0] && !BLEND_FACTOR[factor])
            {
                throw new Error(`blend factor ${factor} has no counterpart`);
            }
        }

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
                targets: [{
                    format: state.targetFormat,
                    writeMask: blend.RenderTargetWriteMask[0],
                    ...(blend.BlendEnable[0]
                        ? {
                            blend: {
                                color: {
                                    srcFactor: BLEND_FACTOR[blend.SrcBlend],
                                    dstFactor: BLEND_FACTOR[blend.DestBlend],
                                    operation: BLEND_OP[blend.BlendOp],
                                },
                                alpha: {
                                    srcFactor: BLEND_FACTOR[blend.SrcBlendAlpha],
                                    dstFactor: BLEND_FACTOR[blend.DestBlendAlpha],
                                    operation: BLEND_OP[blend.BlendOpAlpha],
                                },
                            },
                        }
                        : {}),
                }],
            },
            primitive: {
                topology: state.topology,
                cullMode: CULL[rasterizer.CullMode],
                frontFace: rasterizer.FrontCounterClockwise ? 'ccw' : 'cw',
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
                alphaToCoverageEnabled: !!blend.AlphaToCoverageEnable,
            },
        });
        return { gpu, program, groupLayouts, slots: layout.slots };
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

    /**
     * @param {any} view a render target view
     * @returns {any | null} the backing of the texture it looks at
     */
    const targetOf = view=>{
        if (!view)
        {
            return null;
        }
        /** @type {{ resource?: any }} */
        const held = {};
        view.GetResource(held);
        held.resource.release();
        const backing = backingOf(held.resource);
        return backing.texture ? backing : null;
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
                return { binding: entry.binding, resource: gpu ?? fallback.view };
            }
            const sampler = stage.samplers[entry.binding - BINDING.SAMPLER];
            return {
                binding: entry.binding,
                resource: sampler ? samplerOf(sampler) : fallback.sampler,
            };
        });
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
                const pitch = source.SysMemPitch || held.rowPitch;
                const slicePitch = source.SysMemSlicePitch || held.depthPitch;
                const geometry = held.level;
                for (let z = 0; z < geometry.depth; z++)
                {
                    for (let row = 0; row < geometry.height; row++)
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
            const texel = backingOf(resource).layout.texelBytes;
            const region = box ?? {
                left: 0, top: 0, front: 0,
                right: geometry.width, bottom: geometry.height, back: geometry.depth,
            };
            const width = Math.max(0, Math.min(region.right, geometry.width) - region.left);
            const rows = Math.max(0, Math.min(region.bottom, geometry.height) - region.top);
            const depth = Math.max(0, Math.min(region.back, geometry.depth) - region.front);
            const pitch = rowPitch || width * texel;
            const slicePitch = depthPitch || pitch * rows;
            for (let z = 0; z < depth; z++)
            {
                for (let row = 0; row < rows; row++)
                {
                    const from = z * slicePitch + row * pitch;
                    const to = (region.front + z) * held.depthPitch
                        + (region.top + row) * held.rowPitch + region.left * texel;
                    held.bytes.set(data.subarray(from, from + width * texel), to);
                }
            }
            upload(resource, subresource);
        },

        /**
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
            if (gpuWritten(source))
            {
                diverge('a copy out of a render target reads the bytes the program last wrote,'
                    + ' not what the GPU drew');
            }
            const from = subresourceBytes(source, sourceSubresource);
            const to = subresourceBytes(destination, destinationSubresource);
            const texel = backingOf(source).layout.texelBytes;
            const region = box ?? {
                left: 0, top: 0, front: 0,
                right: from.level.width, bottom: from.level.height, back: from.level.depth,
            };
            const width = Math.min(region.right - region.left, to.level.width - at.x);
            const rows = Math.min(region.bottom - region.top, to.level.height - at.y);
            const depth = Math.min(region.back - region.front, to.level.depth - at.z);
            for (let z = 0; z < depth; z++)
            {
                for (let row = 0; row < rows; row++)
                {
                    const start = (region.front + z) * from.depthPitch
                        + (region.top + row) * from.rowPitch + region.left * texel;
                    to.bytes.set(from.bytes.subarray(start, start + width * texel),
                        (at.z + z) * to.depthPitch + (at.y + row) * to.rowPitch + at.x * texel);
                }
            }
            upload(destination, destinationSubresource);
        },

        /**
         * @param {any} destination
         * @param {any} source
         */
        copyResource(destination, source){
            if (gpuWritten(source))
            {
                diverge('a copy out of a render target reads the bytes the program last wrote,'
                    + ' not what the GPU drew');
            }
            const from = backingOf(source);
            const to = backingOf(destination);
            to.bytes.set(from.bytes.subarray(0, Math.min(from.bytes.length, to.bytes.length)));
            const count = (destination.desc.MipLevels ?? 1) * to.layout.slices;
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
            if (backing.layout.texelBytes !== 4
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
            recording.push({ kind: 'clear', target, color: [...color] });
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
            recording.push({ kind: 'clearDepth', target, flags, depth, stencil });
        },

        /**
         * @param {PipelineSnapshot} pipeline
         * @param {{ vertexCount: number, startVertex: number, instanceCount?: number,
         *           indexCount?: number, startIndex?: number, baseVertex?: number }} draw
         */
        draw(pipeline, draw){
            if (!backend)
            {
                return;
            }
            const target = targetOf(pipeline.renderTargets[0]);
            if (!target)
            {
                counters.skipped.noTarget++;
                return;
            }
            if (pipeline.renderTargets.slice(1).some(view=>view))
            {
                diverge('only the first render target is drawn into: several at once are not'
                    + ' bound');
            }
            const viewport = pipeline.viewports[0];
            if (!viewport || !(viewport.Width > 0) || !(viewport.Height > 0))
            {
                counters.skipped.noViewport++;
                return;
            }
            if (!pipeline.stages.vs.shader || !pipeline.stages.ps.shader)
            {
                counters.skipped.noShader++;
                return;
            }
            if (pipeline.stages.gs.shader)
            {
                diverge('a geometry shader is bound and ignored: the draw runs without one');
            }
            const topology = TOPOLOGY[pipeline.topology];
            if (!topology)
            {
                diverge(`primitive topology ${pipeline.topology} cannot be drawn`);
                return;
            }
            const depth = targetOf(pipeline.depthStencilView);
            const indexFormat = INDEX_FORMAT[pipeline.indexFormat] ?? null;
            const state = {
                vertexShader: pipeline.stages.vs.shader,
                pixelShader: pipeline.stages.ps.shader,
                inputLayout: pipeline.inputLayout,
                blendState: pipeline.blendState,
                depthStencilState: pipeline.depthStencilState,
                rasterizerState: pipeline.rasterizerState,
                topology,
                targetFormat: target.layout.format,
                depthFormat: depth ? depth.layout.format : null,
                sampleMask: pipeline.sampleMask,
                sampleCount: target.sampleCount,
                strides: pipeline.vertexStrides.slice(),
                indexFormat: draw.indexCount === undefined ? null : indexFormat,
            };
            if (!state.inputLayout)
            {
                diverge('a draw with no input layout is skipped');
                return;
            }
            if (pipeline.blendFactor.some((/** @type {number} */ value)=>value !== 1))
            {
                diverge('a blend factor other than white is not applied: the backend'
                    + ' exposes no blend constant');
            }
            if (pipeline.stencilRef !== 0)
            {
                diverge('a stencil reference other than zero is not applied: the backend'
                    + ' exposes no stencil reference');
            }
            const rasterizer = pipeline.rasterizerState
                ? stateDesc(pipeline.rasterizerState)
                : DEFAULT_RASTERIZER;
            const scissor = rasterizer.ScissorEnable && pipeline.scissorRects[0]
                ? pipeline.scissorRects[0]
                : null;
            const program = linkProgram(translationOf(state.vertexShader),
                translationOf(state.pixelShader));
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
            recording.push({
                kind: 'draw',
                pipeline: pipelineFor(state),
                target,
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
            const recorded = recording;
            recording = [];
            backend.markPresent();
            const surface = backingOf(backBuffer).surface;
            counters.frames++;
            chain = chain.then(()=>replay(recorded, surface)).catch(failure=>{
                counters.failures.push(String(failure && failure.message || failure));
                diverge(`a frame could not be replayed: ${failure && failure.message || failure}`);
            });
            return chain;
        },

        idle: ()=>chain,

        /** @returns {any} */
        diagnostics(){
            return {
                frames: counters.frames,
                draws: counters.draws,
                clears: counters.clears,
                skipped: { ...counters.skipped },
                failures: [...counters.failures],
                pipelines: pipelines.size,
                lastFrame,
            };
        },
    };

    /**
     * @param {any[]} recorded
     * @param {any} surface
     */
    async function replay(recorded, surface){
        const pipelinesNeeded = await Promise.allSettled(
            recorded.filter(command=>command.kind === 'draw').map(command=>command.pipeline));
        const frame = backend.beginFrame();
        /** @type {any} */
        let pass = null;
        /** @type {any} */
        let passTarget = null;
        /** @type {any} */
        let passDepth = null;
        let built = 0;

        const closePass = ()=>{
            pass = null;
            passTarget = null;
            passDepth = null;
        };

        /**
         * @param {any} target
         * @param {any} depth
         */
        const passFor = (target, depth)=>{
            if (pass && passTarget === target && passDepth === depth)
            {
                return pass;
            }
            const clear = pendingClears.get(target.texture) ?? null;
            const depthClear = depth ? pendingClears.get(depth.texture) ?? null : null;
            pendingClears.delete(target.texture);
            if (depth)
            {
                pendingClears.delete(depth.texture);
            }
            pass = frame.beginPass({
                target: target.surface,
                clear: !!clear,
                clearValue: clear
                    ? { r: clear.color[0], g: clear.color[1], b: clear.color[2], a: clear.color[3] }
                    : undefined,
                ...(depth
                    ? {
                        depthStencilAttachment: {
                            view: depth.surface.view,
                            depthLoadOp: depthClear && (depthClear.flags & D3D10_CLEAR.DEPTH)
                                ? 'clear'
                                : 'load',
                            depthStoreOp: 'store',
                            depthClearValue: depthClear ? depthClear.depth : 1,
                            ...(depth.layout.format.endsWith('stencil8')
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
            passTarget = target;
            passDepth = depth;
            return pass;
        };

        try
        {
            for (const command of recorded)
            {
                if (command.kind === 'clear')
                {
                    closePass();
                    pendingClears.set(command.target.texture, { color: command.color });
                    continue;
                }
                if (command.kind === 'clearDepth')
                {
                    closePass();
                    const previous = pendingClears.get(command.target.texture);
                    // Two clears of one half each add up; a later clear of a
                    // half replaces the earlier value of that half.
                    pendingClears.set(command.target.texture, {
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
                const settled = pipelinesNeeded[built++];
                if (settled.status === 'rejected')
                {
                    counters.skipped.pipeline++;
                    diverge(`a draw was skipped: ${settled.reason && settled.reason.message
                        || settled.reason}`);
                    continue;
                }
                const pipeline = settled.value;
                const current = passFor(command.target, command.depth);
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
                pipeline.slots.forEach((/** @type {number} */ slot, /** @type {number} */ index)=>{
                    const buffer = command.vertexBuffers[slot];
                    if (buffer)
                    {
                        current.setVertexBuffer(index, buffer.gpu, buffer.offset);
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
                    current.drawIndexed(command.indexCount, command.instanceCount,
                        command.startIndex, command.baseVertex, 0);
                }
                else
                {
                    current.draw(command.vertexCount, command.instanceCount,
                        command.startVertex, 0);
                }
            }
            // A clear that met no draw still has to happen before the frame
            // is shown: a program that only clears expects to see the colour.
            for (const [texture, clear] of [...pendingClears])
            {
                if (!clear.color)
                {
                    continue;
                }
                const target = recorded.find(command=>command.kind === 'clear'
                    && command.target.texture === texture);
                if (target)
                {
                    closePass();
                    passFor(target.target, null);
                }
            }
            frame.present(surface);
        }
        finally
        {
            // One object owns the encoder and one call releases it; a throw
            // above must not leave the frame open for every present after.
            frame.end();
        }
        // The record a test reads, without the promise a draw carried.
        lastFrame = recorded.map(command=>{
            if (command.kind !== 'draw')
            {
                return command;
            }
            const copy = { ...command };
            delete copy.pipeline;
            return copy;
        });
    }
}

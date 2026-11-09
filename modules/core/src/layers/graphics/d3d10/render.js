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
    D3D10_APPEND_ALIGNED_ELEMENT, D3D11_BIND_UNORDERED_ACCESS, D3D11_BUFFER_UAV_FLAG,
    D3D11_DSV_FLAG, D3D11_RESOURCE_MISC, D3D_FEATURE_LEVEL, DXGI_FORMAT, FORMAT_INFO, formatPitch,
} from './constants.js';
import { channelsOf, clearElement, clearTexel } from './uavclear.js';
import { SO_NO_RASTERIZED_STREAM } from './streamout.js';

/** The most bytes a constant buffer has: 4096 registers of sixteen. */
const MOST_CONSTANT_BYTES = 65536;

/** A stage that writes through no views. @type {readonly any[]} */
const NO_VIEWS = Object.freeze([]);

/**
 * The most bytes an input element reads past its slot's stride: a 32-bit
 * four-component element at the largest aligned offset an element may have.
 */
const UNBOUND_ATTRIBUTE_BYTES = 2048 + 16;
import { convertTexels, convertedTexelBytes } from './blocks.js';
import {
    INDEX_FORMAT, PULLED_VERTEX_FORMAT, TEXEL_BYTES, VERTEX_FORMAT, VERTEX_FORMAT_BYTES,
    copyCompatible,
    MIPS_GENERATED, gpuRenderable, isDepthFormat, resolvable, textureStorage, viewFormatOf,
} from './gpuformats.js';
import { levelExtent } from './validity.js';
import { passedSamples, reachableArea } from '../webgpu/internal/occlusion.js';
import {
    BINDING, BUFFER_VIEW_FORMATS, NO_PIXEL_SHADER, STAGE, STORAGE_TEXTURE_FORMAT, linkCompute,
    linkDomain, linkGeometryDraw, linkProgram, translateShader,
} from './wgsl.js';
import { DOMAIN_ENTRIES, FIRST_PATCH_LIST, createTessellation } from './tessellation.js';
import { GEOMETRY_DRAW_ENTRIES, createGeometry } from './geometry.js';
import { LockFlags } from '../webgpu/internal/buffers.js';
import { pageMarksOf, writtenSpans } from '../webgpu/internal/changed.js';
import { RESOURCE_DIMENSION, RETURN_TYPE } from './sm4.js';
import { SYSTEM_VALUE } from './dxbc.js';

/**
 * The shapes WGSL has a depth texture of, which a float texture over a depth
 * buffer is declared as (`variantOf`): two-dimensional, an array of them, a
 * cube and an array of cubes.
 */
const DEPTH_DIMENSIONS = new Set([RESOURCE_DIMENSION.TEXTURE2D, RESOURCE_DIMENSION.TEXTURE2DARRAY,
    RESOURCE_DIMENSION.TEXTURECUBE, RESOURCE_DIMENSION.TEXTURECUBEARRAY]);

/**
 * @typedef {Object} RenderServices
 * @property {any} backend  The WebGPU backend (`webgpu/backend.js`), or null to keep
 *                          every resource's bytes without a GPU behind them.
 * @property {(descriptor: object) => any} createSampler
 * @property {(descriptor: object) => any} createTexture
 * @property {(api: string, detail: string, severity?: 'loss') => void} [divergence]
 * @property {boolean} [compressedTextures]  Whether the GPU samples BC blocks as they are;
 *                                          without it they are decoded on the processor.
 * @property {boolean} [depthClipControl]  Whether the GPU device was made with
 *     depth-clip-control, which leaving depth unclipped needs.
 * @property {boolean} [formatsTier1]  Without a backend: whether the GPU behind the
 *     device has texture-formats-tier1 (with one, the backend says).
 * @property {boolean} [rg11b10Renderable]  Likewise, rg11b10ufloat-renderable.
 * @property {GuestStorage} [guest]  Where a resource the program maps keeps the bytes a
 *     map hands out: guest memory, so a map is an address and no copy.
 * @property {number} [featureLevel]  The device's D3D_FEATURE_LEVEL (10_0 without one).
 */

/**
 * Guest memory for the bytes of the resources a program maps, and how they
 * are read and written: the program's own memory, or the copy of it a
 * played device keeps of what it was sent (`remote/replay.js`).
 *
 * @typedef {Object} GuestStorage
 * @property {(bytes: number) => number} allocate  an address, 0 when there is no room
 * @property {(address: number) => void} [free]
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => ({ take: (address: number,
 *     length: number) => number[] } | null)} [watchWrites]
 *     the pages of a range written since the last look, where the engine says
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

/** The formats whose fourth byte is unused, kept on the GPU as an alpha of one. */
const X8_FORMATS = new Set([DXGI_FORMAT.B8G8R8X8_UNORM, DXGI_FORMAT.B8G8R8X8_UNORM_SRGB,
    DXGI_FORMAT.B8G8R8X8_TYPELESS]);

/** The most vec4 registers a constant buffer binds (D3D11_REQ_CONSTANT_BUFFER_ELEMENT_COUNT). */
const MAX_CONSTANTS = 4096;

/** The WGSL operator a fragment's depth passes a test by, against the buffer's. */
const COMPARE_OPERATOR = Object.freeze(/** @type {Record<number, string>} */ ({
    [D3D10_COMPARISON.LESS]: '<',
    [D3D10_COMPARISON.EQUAL]: '==',
    [D3D10_COMPARISON.LESS_EQUAL]: '<=',
    [D3D10_COMPARISON.GREATER]: '>',
    [D3D10_COMPARISON.NOT_EQUAL]: '!=',
    [D3D10_COMPARISON.GREATER_EQUAL]: '>=',
}));

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
 * The dual-source factors blend by the pixel shader's second output, which
 * a device has only with its dual-source-blending feature; without it a
 * state that names one is refused at draw time by name.
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
    [D3D10_BLEND.SRC1_COLOR]: 'src1',
    [D3D10_BLEND.INV_SRC1_COLOR]: 'one-minus-src1',
    [D3D10_BLEND.SRC1_ALPHA]: 'src1-alpha',
    [D3D10_BLEND.INV_SRC1_ALPHA]: 'one-minus-src1-alpha',
});

/** The factors that blend by the pixel shader's second output. */
const DUAL_SOURCE = new Set([D3D10_BLEND.SRC1_COLOR, D3D10_BLEND.INV_SRC1_COLOR,
    D3D10_BLEND.SRC1_ALPHA, D3D10_BLEND.INV_SRC1_ALPHA]);

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
 * @property {{ vs: StageBindings, hs: StageBindings, ds: StageBindings, gs: StageBindings,
 *     ps: StageBindings, cs: StageBindings }} stages
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
 * @property {any[]} [pixelViews]    what a pixel shader writes through, by slot
 * @property {any[]} [computeViews]  what a compute shader writes through, by slot
 * @property {any} blendState
 * @property {number[]} blendFactor
 * @property {number} sampleMask
 * @property {any} depthStencilState
 * @property {number} stencilRef
 * @property {any} rasterizerState
 * @property {any[]} viewports
 * @property {any[]} scissorRects
 * @property {any[]} [streamOutput]  The stream-output buffers, by slot.
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

/** A texture's top level drawn into a target of another format, texel for texel. */
const COPY_SHADER = [
    '@group(0) @binding(0) var source: texture_2d<f32>;',
    '@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {',
    '    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));',
    '    return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);',
    '}',
    '@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {',
    '    return textureLoad(source, vec2<i32>(position.xy), 0);',
    '}',
].join('\n');

/**
 * The formats a canvas is configured in, by the format a back buffer is kept
 * in: its own where a canvas takes it, the linear twin of an sRGB one -- the
 * same bytes, shown as they are -- and half floats for ten bits a channel.
 *
 * @type {Readonly<Record<string, string>>}
 */
const CANVAS_FORMAT = Object.freeze({
    rgba8unorm: 'rgba8unorm',
    bgra8unorm: 'bgra8unorm',
    rgba16float: 'rgba16float',
    'rgba8unorm-srgb': 'rgba8unorm',
    'bgra8unorm-srgb': 'bgra8unorm',
    rgb10a2unorm: 'rgba16float',
});

/**
 * @param {number} a
 * @param {number} b
 * @returns {number} `a` rounded up to a multiple of `b`
 */
const roundUp = (a, b)=>Math.ceil(a / b) * b;

/** The normalised depth formats and their bits: a constant depth bias is steps of 2^-bits. */
const UNORM_DEPTH_BITS = Object.freeze(/** @type {Record<string, number>} */ ({
    depth16unorm: 16, depth24plus: 24, 'depth24plus-stencil8': 24,
}));

/**
 * The depth formats read back by a compute pass (`depthReadback`), and
 * whether each keeps a stencil beside its depth.
 *
 * @type {Readonly<Record<string, { stencil: boolean }>>}
 */
const DEPTH_READBACK = Object.freeze({
    depth32float: { stencil: false },
    depth16unorm: { stencil: false },
    'depth24plus-stencil8': { stencil: true },
    'depth32float-stencil8': { stencil: true },
});

/**
 * The draw that writes a depth texture from the words Direct3D keeps for its
 * format (the layouts `depthReadbackShader` writes), word 0 the level's
 * width: `depthMain` writes each texel's depth, `stencilMain` (with the
 * override `bit`) is kept where that bit of the texel's stencil is set.
 *
 * @param {string} format
 * @returns {string}
 */
const depthWriteShader = format=>{
    const depth = {
        depth32float: 'bitcast<f32>(words[1u + i])',
        depth16unorm: 'f32(extractBits(words[1u + i / 2u], (i & 1u) * 16u, 16u)) / 65535.0',
        'depth24plus-stencil8': 'f32(words[1u + i] & 0xffffffu) / 16777215.0',
        'depth32float-stencil8': 'bitcast<f32>(words[1u + 2u * i])',
    }[format];
    const stencil = {
        'depth24plus-stencil8': 'words[1u + i] >> 24u',
        'depth32float-stencil8': 'words[2u + 2u * i] & 0xffu',
    }[/** @type {string} */ (format)] ?? '0u';
    return [
        '@group(0) @binding(0) var<storage, read> words: array<u32>;',
        'override bit: u32 = 0u;',
        '@vertex fn vertexMain(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> {',
        '    let xy = vec2<f32>(f32((v << 1u) & 2u), f32(v & 2u));',
        '    return vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);',
        '}',
        'fn texelOf(position: vec4<f32>) -> u32 {',
        '    return u32(position.y) * words[0] + u32(position.x);',
        '}',
        '@fragment fn depthMain(@builtin(position) position: vec4<f32>)'
            + ' -> @builtin(frag_depth) f32 {',
        '    let i = texelOf(position);',
        `    return ${depth};`,
        '}',
        '@fragment fn stencilMain(@builtin(position) position: vec4<f32>) {',
        '    let i = texelOf(position);',
        `    if (((${stencil}) & (1u << bit)) == 0u) { discard; }`,
        '}',
    ].join('\n');
};

/**
 * The pass that writes a depth texture's texels as the words Direct3D keeps
 * them in, one invocation a word: D32_FLOAT the float; D16_UNORM two texels
 * of 16 bits; D24_UNORM_S8_UINT the depth in the low 24 bits and the stencil
 * in the high 8; D32_FLOAT_S8X24_UINT the float, then the stencil in the
 * next word's low 8 bits.
 *
 * @param {string} format
 * @returns {string}
 */
const depthReadbackShader = format=>{
    const stencil = DEPTH_READBACK[format]?.stencil === true;
    const word = {
        depth32float: 'words[w] = bitcast<u32>(depthAt(w));',
        depth16unorm: ['let low = u32(round(depthAt(2u * w) * 65535.0));',
            'var high = 0u;',
            'if (2u * w + 1u < texels) { high = u32(round(depthAt(2u * w + 1u) * 65535.0)); }',
            'words[w] = low | (high << 16u);'].join('\n    '),
        'depth24plus-stencil8': 'words[w] = (u32(round(depthAt(w) * 16777215.0)) & 0xffffffu)'
            + ' | (stencilAt(w) << 24u);',
        'depth32float-stencil8': 'words[w] = select(bitcast<u32>(depthAt(w / 2u)),'
            + ' stencilAt(w / 2u), (w & 1u) == 1u);',
    }[format];
    return [
        '@group(0) @binding(0) var depthTexture: texture_depth_2d;',
        ...(stencil ? ['@group(0) @binding(1) var stencilTexture: texture_2d<u32>;'] : []),
        '@group(0) @binding(2) var<storage, read_write> words: array<u32>;',
        'fn depthAt(i: u32) -> f32 {',
        '    let size = textureDimensions(depthTexture);',
        '    return textureLoad(depthTexture, vec2u(i % size.x, i / size.x), 0);',
        '}',
        ...(stencil ? ['fn stencilAt(i: u32) -> u32 {',
            '    let size = textureDimensions(stencilTexture);',
            '    return textureLoad(stencilTexture, vec2u(i % size.x, i / size.x), 0).x & 0xffu;',
            '}'] : []),
        '@compute @workgroup_size(64)',
        'fn computeMain(@builtin(global_invocation_id) id: vec3u) {',
        '    let size = textureDimensions(depthTexture);',
        '    let texels = size.x * size.y;',
        '    let w = id.x;',
        '    if (w >= arrayLength(&words)) { return; }',
        `    let bound = ${format === 'depth16unorm' ? '2u * w' : format === 'depth32float-stencil8'
            ? 'w / 2u' : 'w'};`,
        '    if (bound >= texels) { return; }',
        `    ${word}`,
        '}',
    ].join('\n');
};

/**
 * @param {RenderServices} services
 */
export function createRenderer(services){
    const { backend, createSampler, createTexture } = services;
    const divergence = services.divergence ?? null;
    const BufferUsage = backend ? backend.BufferUsage : null;
    const TextureUsage = backend ? backend.TextureUsage : null;
    const compressed = services.compressedTextures ?? false;
    // From level 11_0 a viewport's corner left or above the target is
    // floored to a whole pixel, which moves its far corner with it
    // (test_negative_viewports).
    const flooredCorners = (services.featureLevel ?? D3D_FEATURE_LEVEL.LEVEL_10_0)
        >= D3D_FEATURE_LEVEL.LEVEL_11_0;
    /** @param {number} corner */
    const cornerOf = corner=>(flooredCorners && corner < 0 ? Math.floor(corner) : corner);
    /** What a texture's GPU format is chosen with: the device's block and depth features. */
    const formatOptions = { compressed,
        depth32Stencil: backend ? backend.hasFeature?.('depth32float-stencil8') === true : true,
        formatsTier1: backend ? backend.hasFeature?.('texture-formats-tier1') === true
            : services.formatsTier1 ?? true,
        rg11b10Renderable: backend ? backend.hasFeature?.('rg11b10ufloat-renderable') === true
            : services.rg11b10Renderable ?? true };

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
    /**
     * What a program made that is not drawn, uploaded or made: a loss, said
     * each time (the journal counts the repeats).
     *
     * @param {string} detail
     */
    const lose = detail=>divergence?.('Direct3D 10', `lost: ${detail}`, 'loss');

    /** @type {WeakMap<object, any>} resource -> backing */
    const backings = new WeakMap();
    /** @type {WeakMap<object, any>} view -> GPU texture view */
    const views = new WeakMap();
    /** @type {WeakMap<object, any>} buffer view -> the uniform describing it */
    const bufferViews = new WeakMap();
    /** @type {WeakMap<object, any>} sampler state -> GPU sampler */
    const samplers = new WeakMap();
    /** The same states as point samplers, for the depth a shader reads. @type {WeakMap<object, any>} */
    const pointSamplers = new WeakMap();
    /** @type {WeakMap<object, any>} shader -> translation */
    const translations = new WeakMap();
    /** @type {WeakMap<object, Map<string, any>>} shader -> its variants, by `variantOf` */
    const variantTranslations = new WeakMap();
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
        dispatches: 0,
        skipped: {
            noViewport: 0,
            noTarget: 0,
            noShader: 0,
            untranslatable: 0,
            pipeline: 0,
            /**
             * A draw with a geometry shader bound, or one through the
             * tessellator Direct3D would not draw or that cannot be drawn.
             */
            stage: 0,
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
     * @property {boolean} [opaque]  A format whose fourth byte is unused (B8G8R8X8): the
     *     GPU keeps it as an alpha of one, which sampling and blending read.
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
        const storage = textureStorage(desc.Format, desc.BindFlags, formatOptions);
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
            ...(X8_FORMATS.has(desc.Format) ? { opaque: true } : {}),
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

    /**
     * The guest memory a resource the program may map keeps the bytes a map
     * hands out in -- a dynamic or staging resource with CPU access -- and the
     * watch over the program's writes there; null for any other, or where
     * there is no guest memory to have.
     *
     * A dynamic buffer may be given more storages (`addStorage`), which the
     * guest's map moves it between for a DISCARD while the ring holds the
     * unmap of the one before (`seam/d3d10-inguest.js`): `base` and `tracked`
     * are the storage it is on.
     *
     * @param {any} desc @param {number} length
     * @returns {{ base: number, length: number, tracked: any,
     *     storages: { base: number, tracked: any }[] } | null}
     */
    const guestStorageOf = (desc, length)=>{
        if (!services.guest || (desc.CPUAccessFlags ?? 0) === 0 || length === 0
            || (desc.Usage !== D3D10_USAGE.DYNAMIC && desc.Usage !== D3D10_USAGE.STAGING))
        {
            return null;
        }
        const storage = storageOf(length);
        if (!storage)
        {
            return null;
        }
        services.guest.writeMemory(storage.base, new Uint8Array(length));
        return { ...storage, length, storages: [storage] };
    };

    /**
     * A span of guest memory for a resource's bytes, and the watch over the
     * program's writes there.
     *
     * @param {number} length
     * @returns {{ base: number, tracked: any } | null}
     */
    const storageOf = length=>{
        const guest = /** @type {GuestStorage} */ (services.guest);
        const base = guest.allocate(length);
        if (!base)
        {
            return null;
        }
        const watch = guest.watchWrites?.(base, length) ?? null;
        return { base, tracked: watch ? { watch, dirty: pageMarksOf(base, length) } : null };
    };

    /**
     * What a map of a guest-backed subresource hands out: its address, after
     * the host's newer bytes, if any, are written there.
     *
     * @param {any} backing @param {number} at  the subresource's offset in the resource
     */
    const guestMapped = (backing, at)=>{
        const guest = /** @type {GuestStorage} */ (services.guest);
        if (backing.hostNewer)
        {
            backing.hostNewer = false;
            guest.writeMemory(backing.guest.base, backing.bytes);
            // What was just written is the host's, not the program's.
            if (backing.guest.tracked)
            {
                writtenSpans(backing.guest.tracked, backing.guest.base, backing.guest.length, 0,
                    backing.guest.length);
            }
        }
        return backing.guest.base + at;
    };

    /**
     * The bytes the program wrote into a guest-backed subresource taken into
     * the host's: the pages written since the last look where the engine
     * watches, all of the subresource otherwise.
     *
     * @param {any} backing
     * @param {number} at @param {number} length  the subresource, in the resource
     * @returns {{ start: number, end: number } | null}  what changed, in the resource
     */
    const guestWritten = (backing, at, length)=>{
        const guest = /** @type {GuestStorage} */ (services.guest);
        const { base, tracked } = backing.guest;
        const spans = tracked
            ? writtenSpans(tracked, base, backing.guest.length, at, at + length)
            : [at, at + length];
        if (spans.length === 0)
        {
            return null;
        }
        for (let index = 0; index < spans.length; index += 2)
        {
            const span = spans[index + 1] - spans[index];
            backing.bytes.set(guest.readMemory(base + spans[index], span), spans[index]);
        }
        return { start: spans[0], end: spans[spans.length - 1] };
    };

    /**
     * What a buffer's GPU copy may be used as: everything a binding may make it.
     *
     * @param {any} desc
     */
    const bufferUsageOf = desc=>{
        const usage = /** @type {any} */ (BufferUsage);
        // Storage for every buffer: a draw through the tessellator reads its
        // vertex and index buffers as words, in a compute pass.
        return usage.VERTEX | usage.INDEX | usage.UNIFORM | usage.COPY_DST | usage.COPY_SRC
            | usage.STORAGE
            | ((desc.MiscFlags11 ?? 0) & D3D11_RESOURCE_MISC.DRAWINDIRECT_ARGS ? usage.INDIRECT
                : 0);
    };

    /**
     * A GPU texture, or null where the device refuses the description on
     * the spot - a format a feature it lacks gates - which is said and the
     * texture kept in memory, as one of a format with no GPU counterpart.
     *
     * @param {any} descriptor
     */
    const madeTexture = descriptor=>{
        try
        {
            return createTexture(descriptor);
        }
        catch (e){
            lose(`a ${descriptor.format} texture cannot be made on this device: ${
                /** @type {any} */ (e)?.message ?? e}; it is kept in memory and never drawn with`);
            return null;
        }
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
            id: nextBacking++, layout, bytes, gpu: null, texture: null, surface: null,
            sampleCount: desc.SampleDesc ? desc.SampleDesc.Count : 1,
            guest: guestStorageOf(desc, bytes.length),
            // Whether the host bytes hold what the guest's do not: written here
            // since the guest's were, so a map writes them there first.
            hostNewer: false,
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
                    usage: bufferUsageOf(desc),
                });
            }
        }
        else if (layout.format && desc.Usage !== D3D10_USAGE.STAGING)
        {
            let usage = TextureUsage.COPY_DST | TextureUsage.COPY_SRC;
            // WebGPU makes a multisampled texture only as something to draw
            // into, whatever else the program binds it as.
            // A format this GPU does not draw into is made without it, so it can
            // still be sampled and copied, and a draw into it is lost.
            backing.drawable = gpuRenderable(layout.format, formatOptions);
            // A view written through that WebGPU cannot store into is cleared
            // by drawing.
            const unstorable = (desc.BindFlags & D3D11_BIND_UNORDERED_ACCESS) !== 0
                && !storableFormats().has(layout.format);
            if (((desc.BindFlags & (D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL)) !== 0
                || backing.sampleCount > 1 || unstorable) && backing.drawable)
            {
                usage |= TextureUsage.RENDER_ATTACHMENT;
            }
            // A depth texture is read by a shader to be read back
            // (`depthReadback`): WebGPU copies none with stencil out.
            // A multisampled texture is read by the shader that resolves it
            // (ResolveSubresource), whatever the program binds it as.
            if ((desc.BindFlags & D3D10_BIND.SHADER_RESOURCE) !== 0
                || (layout.storage?.depth && backing.sampleCount === 1)
                || backing.sampleCount > 1)
            {
                usage |= TextureUsage.TEXTURE_BINDING;
            }
            // A view a shader writes through is a storage texture, of a
            // format WebGPU stores into and of one sample.
            backing.storable = (desc.BindFlags & D3D11_BIND_UNORDERED_ACCESS) !== 0
                && backing.sampleCount === 1 && storableFormats().has(layout.format);
            if (backing.storable)
            {
                usage |= TextureUsage.STORAGE_BINDING;
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
            backing.made = { size, mipLevelCount: desc.MipLevels,
                dimension: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D ? '3d' : '2d',
                layers: resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                    ? 1 : desc.ArraySize };
            backing.texture = madeTexture({
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
            if (!backing.texture)
            {
                backing.storable = false;
                backings.set(resource, backing);
                return backing;
            }
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
            lose(`a texture in format ${desc.Format} cannot be backed on this device;`
                + ' it is kept in memory and never drawn with');
        }
        backings.set(resource, backing);
        return backing;
    };

    /**
     * A texture of a typeless family in another format of it with texels of
     * the same size: Direct3D reads and writes one memory through views of
     * any format in the family, WebGPU views a texture only as its own
     * format or its sRGB twin. A view of another type (an R32_UINT render
     * target over a texture an R32_FLOAT one also draws into) goes through
     * a twin texture of its format, given the texture's bytes before an
     * operation through it and giving them back after (`twinUses`), so the
     * texture itself always holds what the program last wrote.
     *
     * @param {any} backing @param {number} viewFormat  the view's DXGI format
     * @returns {any | null}  null where the view's format is the texture's own,
     *     or the bytes cannot be carried between the two
     */
    const twinOf = (backing, viewFormat)=>{
        const own = textureStorage(viewFormat, 0, formatOptions);
        const format = own?.format;
        const storage = backing.layout.storage;
        if (!format || !backing.texture || !backing.made || format === backing.layout.format
            || storage?.viewFormats.includes(format) || backing.sampleCount !== 1
            || storage?.depth || storage?.conversion || own.conversion
            || !(TEXEL_BYTES[format] > 0) || TEXEL_BYTES[format] !== TEXEL_BYTES[storage.format])
        {
            return null;
        }
        backing.twins ??= new Map();
        let twin = backing.twins.get(format);
        if (!twin)
        {
            const drawable = gpuRenderable(format, formatOptions);
            const storable = storableFormats().has(format);
            const texture = madeTexture({
                label: `d3d10:twin:${format}`,
                size: backing.made.size,
                mipLevelCount: backing.made.mipLevelCount,
                dimension: backing.made.dimension,
                format,
                usage: TextureUsage.COPY_DST | TextureUsage.COPY_SRC
                    | TextureUsage.TEXTURE_BINDING
                    | (drawable ? TextureUsage.RENDER_ATTACHMENT : 0)
                    | (storable ? TextureUsage.STORAGE_BINDING : 0),
            });
            if (!texture)
            {
                return null;
            }
            twin = { id: nextBacking++, texture, format, drawable, storable,
                texelBytes: TEXEL_BYTES[format] };
            backing.twins.set(format, twin);
        }
        return twin;
    };

    /**
     * The twins an operation being recorded goes through: given the
     * texture's bytes before it, and those it writes giving them back after.
     *
     * @type {Map<string, { backing: any, twin: any, mip: number, levels: number,
     *     first: number, count: number, written: boolean, whole: boolean }>}
     */
    let twinUses = new Map();

    /**
     * @param {any} backing @param {any} twin
     * @param {{ mip: number, levels: number, first: number, count: number }} range
     * @param {boolean} written
     * @param {boolean} [whole]  the operation writes every texel of the range,
     *     so the twin need not be given the texture's bytes first
     */
    const useTwin = (backing, twin, range, written, whole = false)=>{
        const key = `${twin.id}:${range.mip}:${range.levels}:${range.first}:${range.count}`;
        const known = twinUses.get(key);
        twinUses.set(key, { backing, twin, mip: range.mip, levels: range.levels,
            first: range.first, count: range.count, written: written || !!known?.written,
            whole: whole && (!known || known.whole) });
    };

    /**
     * The copies between a texture and its twins over the levels and slices
     * of each use, one way.
     *
     * @param {boolean} back  from the twins into the textures
     */
    const syncTwins = back=>{
        for (const use of twinUses.values())
        {
            if (back ? !use.written : use.whole)
            {
                continue;
            }
            const { backing, twin } = use;
            if (twin.words)
            {
                const level = backing.layout.levels[use.mip];
                record({ kind: 'texelWords', ids: [backing.id], toBuffer: !back,
                    texture: { texture: backing.texture, mipLevel: use.mip,
                        origin: { x: 0, y: 0, z: use.first } },
                    buffer: { buffer: twin.words.gpu, bytesPerRow: twin.rowWords * 4,
                        rowsPerImage: level.height },
                    size: { width: level.width, height: level.height,
                        depthOrArrayLayers: use.count } });
                if (back)
                {
                    backing.gpuDirty = true;
                }
                continue;
            }
            for (let mip = use.mip; mip < use.mip + use.levels; mip++)
            {
                const level = backing.layout.levels[mip];
                const is3D = backing.made.dimension === '3d';
                const home = { texture: backing.texture, mipLevel: mip,
                    origin: { x: 0, y: 0, z: is3D ? 0 : use.first } };
                const away = { texture: twin.texture, mipLevel: mip,
                    origin: { x: 0, y: 0, z: is3D ? 0 : use.first } };
                record({ kind: 'reinterpret', ids: [backing.id, twin.id],
                    source: back ? away : home, destination: back ? home : away,
                    size: { width: level.width, height: level.height,
                        depthOrArrayLayers: is3D ? level.depth : use.count },
                    texelBytes: twin.texelBytes });
            }
            if (back)
            {
                backing.gpuDirty = true;
            }
        }
    };

    /**
     * Records `operation` with the twins it goes through given the texture's
     * bytes before it and giving them back after.
     *
     * @template T
     * @param {() => T} resolve  what finds the views, and so the twins
     * @param {(resolved: T) => void} operation  what records the operation
     */
    const throughTwins = (resolve, operation)=>{
        twinUses = new Map();
        const resolved = resolve();
        const uses = twinUses;
        syncTwins(false);
        operation(resolved);
        twinUses = uses;
        syncTwins(true);
        twinUses = new Map();
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
     * Every texel of a level's slices in a texture's own bytes set to one
     * texel's bytes: an array's layers, or a volume's depth slices.
     *
     * @param {any} resource
     * @param {{ mip: number, first: number, count: number }} range
     * @param {Uint8Array} element
     */
    const clearHeld = (resource, range, element)=>{
        const { layout, bytes } = backingOf(resource);
        const geometry = layout.levels[range.mip];
        const volume = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D;
        for (let slice = range.first; slice < range.first + range.count; slice++)
        {
            const base = volume ? geometry.offset + slice * geometry.depthPitch
                : slice * layout.sliceBytes + geometry.offset;
            for (let row = 0; row < geometry.height; row++)
            {
                const start = base + row * geometry.rowPitch;
                for (let x = 0; x < geometry.width; x++)
                {
                    bytes.set(element, start + x * element.length);
                }
            }
        }
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
        if (!conversion && layout.opaque)
        {
            const data = bytes.slice();
            for (let at = 3; at < data.length; at += 4)
            {
                data[at] = 0xff;
            }
            return { data, bytesPerRow: geometry.rowPitch };
        }
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
     * A buffer sends the range given, or the box's, or all of it.
     *
     * @param {any} resource
     * @param {number} subresource
     * @param {number} [flags]  A LockFlags value for a buffer.
     * @param {Box | null} [box]
     * @param {{ start: number, end: number } | null} [range]  a buffer's bytes that changed
     * @param {boolean} [fromGuest]  the bytes were just taken from the guest's: the two agree
     */
    const upload = (resource, subresource, flags = LockFlags.NONE, box = null,
        range = /** @type {{ start: number, end: number } | null} */ (null), fromGuest = false)=>
    {
        const backing = backingOf(resource);
        if (backing.guest && !fromGuest)
        {
            backing.hostNewer = true;
        }
        if (backing.gpu)
        {
            const start = range ? range.start : box ? Math.max(0, box.left) : 0;
            const end = range ? range.end
                : box ? Math.min(backing.bytes.length, box.right) : backing.bytes.length;
            if (end <= start)
            {
                return;
            }
            if (gpuWritten(resource))
            {
                orderedWrite(backing, start, end);
                return;
            }
            const lock = backing.gpu.lock(start, end - start, flags);
            lock.data.set(backing.bytes.subarray(start, end));
            backing.gpu.unlock(lock);
            return;
        }
        if (!backing.texture)
        {
            return;
        }
        if (backing.sampleCount > 1)
        {
            lose('bytes a program gives a multisampled texture are kept but not uploaded:'
                + ' WebGPU writes one only by drawing');
            return;
        }
        if (backing.layout.storage.depth)
        {
            // WebGPU copies into no depth format with a stencil, nor into a
            // 32-bit float depth: the texture is written by drawing.
            depthUpload(resource, subresource);
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
            lose(`a ${backing.layout.format} texture is not uploaded:`
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
        & (D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL | D3D11_BIND_UNORDERED_ACCESS
            | D3D10_BIND.STREAM_OUTPUT)) !== 0
        || backingOf(resource).gpuDirty === true;

    /**
     * Bytes the program gave a buffer the GPU writes, sent in their turn
     * among the GPU's own work: through a buffer of their own and a copy
     * recorded where the write was made. Written in place before the frame,
     * as other buffers are, they would land under what earlier dispatches
     * and copies of the same frame write; renamed, the rename's copy of the
     * rest would be taken before those ran.
     *
     * ponytail: whole words; the bytes around an unaligned range are the
     * host's, which may be older than the GPU's.
     *
     * @param {any} backing @param {number} start @param {number} end
     */
    const orderedWrite = (backing, start, end)=>{
        const from = start & ~3;
        const size = Math.min(backing.gpu.size, Math.ceil(end / 4) * 4) - from;
        if (size <= 0)
        {
            return;
        }
        const staged = backend.createDynamicBuffer({
            label: 'd3d10:ordered-write', size, usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
            keep: false,
        });
        const lock = staged.lock(0, size, LockFlags.DISCARD);
        lock.data.set(backing.bytes.subarray(from, from + size));
        staged.unlock(lock);
        staged.markRead();
        record({ kind: 'copyBuffer', source: staged.gpu, sourceOffset: 0,
            destination: backing.gpu.gpu, destinationOffset: from, size, release: staged });
    };

    /**
     * Whether a level of this texture can be read back as it is: texels the
     * GPU keeps in the program's own layout, one sample each. A depth format
     * or one converted on the way to the GPU cannot be.
     *
     * @param {any} backing
     */
    const readable = backing=>{
        const storage = backing.layout.storage;
        return !!storage && (!storage.conversion || storage.conversion === 'a8') && !storage.depth
            && TEXEL_BYTES[storage.format] > 0 && backing.sampleCount === 1;
    };

    /**
     * The bytes a texel of a texture that can be read back comes back as to
     * the program: its own, or A8's one, the alpha of the RGBA it is kept as.
     *
     * @param {any} backing
     */
    const programTexel = backing=>(backing.layout.storage.conversion === 'a8' ? 1
        : TEXEL_BYTES[backing.layout.storage.format]);

    /**
     * A read back's delivery given the image as the program's texels.
     *
     * @param {any} backing
     * @param {(image: { width: number, height: number, data: Uint8Array } | null) => void} deliver
     * @returns {(image: { width: number, height: number, data: Uint8Array } | null) => void}
     */
    const asProgramTexels = (backing, deliver)=>{
        if (backing.layout.storage.conversion !== 'a8')
        {
            return deliver;
        }
        return image=>{
            if (!image)
            {
                deliver(null);
                return;
            }
            const data = new Uint8Array(image.data.length >> 2);
            for (let at = 0; at < data.length; at++)
            {
                data[at] = image.data[at * 4 + 3];
            }
            deliver({ ...image, data });
        };
    };

    /**
     * @param {any} view
     * @returns {any} the GPU view a shader or a pass sees the resource through
     */
    const viewOf = view=>{
        let gpu = views.get(view);
        if (gpu)
        {
            if (gpu.twin)
            {
                useTwin(gpu.backing, gpu.twin, view.range, false);
            }
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
        let chosen = viewFormatOf(backing.layout.storage, desc.Format, formatOptions);
        const twin = chosen.reinterpreted ? twinOf(backing, desc.Format) : null;
        if (twin)
        {
            chosen = { format: twin.format, reinterpreted: false };
        }
        else if (chosen.reinterpreted)
        {
            diverge(`a view of a typeless texture as format ${desc.Format} reads it as`
                + ` ${chosen.format}: its bytes cannot be carried into a texture of that format`);
        }
        const dimension = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
            ? '3d'
            : isCube ? 'cube' : shape === 'TEXTURECUBEARRAY' ? 'cube-array'
                : array ? '2d-array' : '2d';
        const created = (twin ? twin.texture : backing.texture).createView({
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
            multisampled: backing.sampleCount > 1, backing, twin,
            stencil: chosen.aspect === 'stencil-only' };
        views.set(view, gpu);
        if (twin)
        {
            useTwin(backing, twin, view.range, false);
        }
        return gpu;
    };

    /** @param {any} state a sampler state object */
    const isComparisonSampler = state=>(stateDesc(state).Filter
        & D3D10_FILTER_COMPARISON_BIT) !== 0;

    /** @param {any} state a sampler state object */
    const samplerOf = (state, nearest = false)=>{
        const kept = nearest ? pointSamplers : samplers;
        let gpu = kept.get(state);
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
        const linear = (/** @type {number} */ bit)=>(!nearest && (anisotropic || (filter & bit)
            !== 0) ? 'linear' : 'nearest');
        if (nearest && (anisotropic || (filter & 0x15) !== 0))
        {
            diverge('a depth texture read through a filtering sampler is read at its nearest'
                + ' texel: WebGPU filters depth only when it compares it');
        }
        gpu = createSampler({
            label: `d3d10:sampler:${filter.toString(16)}`,
            addressModeU: ADDRESS[desc.AddressU] ?? 'repeat',
            addressModeV: ADDRESS[desc.AddressV] ?? 'repeat',
            addressModeW: ADDRESS[desc.AddressW] ?? 'repeat',
            magFilter: linear(0x4),
            minFilter: linear(0x10),
            mipmapFilter: linear(0x1),
            // Direct3D takes a MaxLOD under the MinLOD; WebGPU refuses it.
            lodMinClamp: Math.min(32, Math.max(0, desc.MinLOD)),
            lodMaxClamp: Math.max(Math.min(32, Math.max(0, desc.MinLOD)),
                Math.min(32, desc.MaxLOD)),
            maxAnisotropy: anisotropic && !nearest ? Math.max(1, desc.MaxAnisotropy) : 1,
            ...(comparison ? { compare: COMPARE[desc.ComparisonFunc] ?? 'never' } : {}),
        });
        if (filter === D3D10_FILTER.TEXT_1BIT)
        {
            diverge('a text-filtering sampler is used as a point sampler');
        }
        kept.set(state, gpu);
        return gpu;
    };

    /** Zeros a slot with nothing bound is read from, grown as draws need more. @type {any} */
    let zeros = null;
    /**
     * At least `bytes` of zeros as a vertex buffer. WebGPU creates a buffer
     * zeroed, and nothing ever writes this one.
     *
     * @param {number} bytes
     */
    const zeroVertices = bytes=>{
        if (!zeros || zeros.size < bytes)
        {
            zeros = backend.createDynamicBuffer({
                label: 'd3d10:unbound-vertices',
                size: Math.max(bytes, 4096),
                usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
            });
        }
        return zeros.gpu;
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
        // As many constants as a buffer can hold, so that any declaration
        // reads zeros where nothing is bound.
        const buffer = backend.createDynamicBuffer({
            label: 'd3d10:unbound-constants',
            size: MOST_CONSTANT_BYTES,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
        // An unbound buffer view: its zeroed uniform above says no elements.
        const storage = backend.createDynamicBuffer({
            label: 'd3d10:unbound-buffer-view',
            size: 16,
            usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        });
        // What a dispatch writes through where no view is bound: apart from
        // the buffer above, which a dispatch may read in the same pass.
        const writable = backend.createDynamicBuffer({
            label: 'd3d10:unbound-uav',
            size: 16,
            usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        });
        /** @type {Map<string, any>} */
        const storageTextures = new Map();
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
            writable,
            /** @param {{ format: string, viewDimension: string }} kind */
            storageTexture(kind){
                const key = `${kind.format}:${kind.viewDimension}`;
                let view = storageTextures.get(key);
                if (!view)
                {
                    view = createTexture({
                        label: `d3d10:unbound-uav:${key}`,
                        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                        dimension: kind.viewDimension === '3d' ? '3d' : '2d',
                        format: kind.format,
                        usage: TextureUsage.STORAGE_BINDING,
                    }).createView({ label: `d3d10:unbound-uav:${key}`,
                        dimension: kind.viewDimension });
                    storageTextures.set(key, view);
                }
                return view;
            },
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
        // A raw or structured view is read by words, whatever its format says.
        const decodable = backing?.gpu && (BUFFER_VIEW_FORMATS.has(format)
            || format === DXGI_FORMAT.UNKNOWN || format === DXGI_FORMAT.R32_TYPELESS);
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
        return { binding: entry.binding,
            resource: { buffer: viewUniformOf(view, described.desc), offset: 0, size: 16 } };
    };

    /**
     * The uniform a shader reads a buffer view through: its format, first
     * element, element count and element size.
     *
     * @param {any} view @param {any} desc
     */
    const viewUniformOf = (view, desc)=>{
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
            words.setUint32(0, desc.Format, true);
            words.setUint32(4, desc.ElementOffset ?? 0, true);
            words.setUint32(8, desc.ElementWidth ?? 0, true);
            words.setUint32(12, desc.elementBytes ?? FORMAT_INFO[desc.Format]?.bytesPerPixel ?? 4,
                true);
            uniform.unlock(lock);
            bufferViews.set(view, uniform);
        }
        return uniform.gpu;
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
        // A 32-bit float is filtered only on a device with the feature for it.
        return /32float/.test(format ?? '') && backend?.hasFeature?.('float32-filterable') !== true
            ? 'unfilterable-float' : 'float';
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
     * @param {string} [variant]  What the textures bound make of it (`variantOf`).
     */
    const translationOf = (shader, variant = '')=>{
        if (!shader)
        {
            return NO_PIXEL_SHADER;
        }
        if (variant)
        {
            let variants = variantTranslations.get(shader);
            if (!variants)
            {
                variants = new Map();
                variantTranslations.set(shader, variants);
            }
            let made = variants.get(variant);
            if (!made)
            {
                const [multisampled, depth, biases, stored, stencil, sizes] = variant.split('|');
                /** @param {string} slots */
                const list = slots=>(slots ? slots.split(',').map(Number) : []);
                made = translateShader(shader.container, {
                    multisampled: list(multisampled), depth: list(depth), stencil: list(stencil),
                    samplerBias: Object.fromEntries((biases ?? '').split(',').filter(Boolean)
                        .map(pair=>pair.split(':').map(Number))),
                    uavFormats: Object.fromEntries((stored ?? '').split(',').filter(Boolean)
                        .map(pair=>pair.split(':')).map(([slot, format])=>[Number(slot), format])),
                    constantSizes: Object.fromEntries((sizes ?? '').split(',').filter(Boolean)
                        .map(pair=>pair.split(':').map(Number))),
                });
                variants.set(variant, made);
            }
            return made;
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
     * What the views a stage binds make of its shader's translation, as a
     * key: the slots where it declares a multisampled texture and the view is
     * of one with several samples, read by sample; and, after a bar, the
     * slots where it declares a float texture and the view is of a depth
     * buffer, declared as a depth texture -- a shadow map, a depth read back
     * -- which a float texture's binding does not take. Empty for nearly
     * every draw, and found from the few textures the shader declares.
     *
     * @param {any} stage
     * @returns {string}
     */
    const variantOf = (stage, written = NO_VIEWS)=>{
        if (!stage.shader)
        {
            return '';
        }
        /** @type {number[]} */
        const multisampled = [];
        /** @type {number[]} */
        const depth = [];
        /** @type {number[]} */
        const stencil = [];
        for (const texture of translationOf(stage.shader).textures)
        {
            const view = stage.shaderResources[texture.slot];
            const gpu = view ? viewOf(view) : null;
            if (!gpu)
            {
                continue;
            }
            if (texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMS && gpu.multisampled)
            {
                multisampled.push(texture.slot);
            }
            else if (gpu.sampleType === 'depth' && !gpu.multisampled
                && texture.returnType !== RETURN_TYPE.UINT
                && texture.returnType !== RETURN_TYPE.SINT
                && DEPTH_DIMENSIONS.has(texture.dimension))
            {
                depth.push(texture.slot);
            }
            else if (gpu.stencil)
            {
                stencil.push(texture.slot);
            }
        }
        // A sampler with a MipLODBias: WebGPU's have none, so the shader adds it.
        /** @type {string[]} */
        const biases = [];
        for (const sampler of translationOf(stage.shader).samplers)
        {
            const state = stage.samplers[sampler.slot];
            const bias = state ? stateDesc(state).MipLODBias ?? 0 : 0;
            if (bias)
            {
                biases.push(`${sampler.slot}:${Math.fround(bias)}`);
            }
        }
        // The formats of the views a pixel shader writes through, which its
        // storage textures are declared as.
        const stored = translationOf(stage.shader).uavs.length > 0
            ? Object.entries(uavFormatsOf(written)).map(([slot, format])=>`${slot}:${format}`)
            : [];
        // A constant buffer read at a computed register reaches as far as
        // the buffer bound, past what the shader declares (test_cb_relative_addressing).
        /** @type {string[]} */
        const sizes = [];
        for (const declared of translationOf(stage.shader).constantBuffers)
        {
            const buffer = declared.indexed ? stage.constantBuffers[declared.slot] : null;
            const registers = buffer ? Math.min(MAX_CONSTANTS,
                Math.ceil(buffer.desc.ByteWidth / 16)) : 0;
            if (registers > declared.size)
            {
                sizes.push(`${declared.slot}:${registers}`);
            }
        }
        return multisampled.length === 0 && depth.length === 0 && biases.length === 0
            && stored.length === 0 && stencil.length === 0 && sizes.length === 0 ? ''
            : `${multisampled.join(',')}|${depth.join(',')}|${biases.join(',')}`
                + `|${stored.join(',')}|${stencil.join(',')}|${sizes.join(',')}`;
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
     * A vertex format's spelling: WebGPU's, or one the vertex stage reads
     * itself (`PULLED_VERTEX_FORMAT`), whose slot is always pulled.
     *
     * @param {number} format
     * @returns {string | undefined}
     */
    const vertexFormatOf = format=>VERTEX_FORMAT[format] ?? PULLED_VERTEX_FORMAT[format];

    /**
     * The streams of an input layout the vertex stage reads from storage
     * itself (`VertexPull`): those WebGPU does not fetch as vertex buffers -
     * a stride or an element offset it does not align (Direct3D steps a
     * stream of bytes one by one), or per-instance data stepping once every
     * several instances, or any per-instance data of an indirect draw, whose
     * first instance only the GPU knows. Null where every stream is a vertex
     * buffer.
     *
     * A vertex shader that reads its vertex ID reads the draw's first or
     * base vertex beside them (`vertexBase`).
     *
     * @param {any} inputLayout @param {number[]} strides @param {boolean} indirect
     * @param {any} shader  the vertex shader
     * @returns {{ pull: import('./wgsl.js').VertexPull, slots: number[] } | null}
     */
    const vertexPullOf = (inputLayout, strides, indirect, shader)=>{
        const vertexBase = (shader?.container?.inputs ?? []).some((/** @type {any} */ element)=>
            element.systemValue === SYSTEM_VALUE.VERTEX_ID);
        /** @type {Map<number, number>} */
        const cursor = new Map();
        const placed = inputLayout.elements.map((/** @type {any} */ element)=>{
            const format = vertexFormatOf(element.Format);
            const slot = element.InputSlot;
            const offset = element.AlignedByteOffset === D3D10_APPEND_ALIGNED_ELEMENT
                ? roundUp(cursor.get(slot) ?? 0, 4)
                : element.AlignedByteOffset;
            cursor.set(slot, offset + (format ? VERTEX_FORMAT_BYTES[format] : 0));
            const perInstance = element.InputSlotClass
                === D3D10_INPUT_CLASSIFICATION.PER_INSTANCE_DATA;
            return { element, format, slot, offset, perInstance,
                rate: perInstance ? element.InstanceDataStepRate ?? 1 : 1 };
        });
        /** @type {number[]} */
        const slots = [];
        for (const { element, format, slot, offset, rate, perInstance } of placed)
        {
            const bytes = VERTEX_FORMAT_BYTES[format] ?? 4;
            if (format && !slots.includes(slot) && ((strides[slot] ?? 0) % 4 !== 0
                || offset % Math.min(4, bytes) !== 0 || rate > 1 || (indirect && perInstance)
                || PULLED_VERTEX_FORMAT[element.Format]))
            {
                slots.push(slot);
            }
        }
        if (slots.length === 0 && !vertexBase)
        {
            return null;
        }
        slots.sort((a, b)=>a - b);
        const streams = slots.map(slot=>{
            const first = placed.find((/** @type {any} */ one)=>one.slot === slot);
            return { stepMode: /** @type {'vertex' | 'instance'} */ (first.perInstance
                ? 'instance' : 'vertex'), rate: first.rate };
        });
        const attributes = placed.filter((/** @type {any} */ one)=>slots.includes(one.slot))
            .map((/** @type {any} */ one)=>({ semantic: one.element.SemanticName,
                index: one.element.SemanticIndex ?? 0, stream: slots.indexOf(one.slot),
                offset: one.offset, format: one.format }));
        return { pull: { streams, attributes, ...(vertexBase ? { vertexBase } : {}) }, slots };
    };

    /**
     * The vertex buffer layouts an input layout describes at the strides a
     * draw binds, matched by semantic to the shader's attributes.
     *
     * @param {any} inputLayout
     * @param {import('./wgsl.js').LinkedProgram} program
     * @param {number[]} strides
     * @param {readonly number[]} [pulled]  slots the vertex stage reads itself
     * @returns {{ buffers: object[], slots: number[] } | string}
     */
    const vertexLayouts = (inputLayout, program, strides, pulled = [])=>{
        /** @type {Map<number, { arrayStride: number, stepMode: string, attributes: object[] }>} */
        const bySlot = new Map();
        /** @type {Map<number, number>} the next append-aligned offset per slot */
        const cursor = new Map();
        for (const element of inputLayout.elements)
        {
            const format = vertexFormatOf(element.Format);
            if (!format)
            {
                return `input element format ${element.Format} has no vertex spelling`;
            }
            const slot = element.InputSlot;
            const offset = element.AlignedByteOffset === D3D10_APPEND_ALIGNED_ELEMENT
                ? roundUp(cursor.get(slot) ?? 0, 4)
                : element.AlignedByteOffset;
            cursor.set(slot, offset + VERTEX_FORMAT_BYTES[format]);
            if (pulled.includes(slot))
            {
                continue;
            }
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
            state.depthFormat ?? '-', state.depthReadOnly ?? 0,
            state.sampleMask >>> 0,
            state.sampleCount, state.strides.join(','), state.indexFormat ?? '-',
            state.indirect ? 'indirect' : '', state.layerPass ?? '', state.viewportPass ?? '',
            state.earlyDepth ?? '',
        ].join('|');
        const keyed = state.hullShader ? `${key}|hs:${idOf(state.hullShader)}`
            : state.geometry ? `${key}|gs:${idOf(state.geometry.shader)}:${state.geometry.stream}`
                : key;
        // Only a draw whose views make a variant of a shader says so.
        return state.vsVariant || state.psVariant
            ? `${keyed}|v:${state.vsVariant}/${state.psVariant}`
            : keyed;
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
        const vs = translationOf(state.vertexShader, state.vsVariant);
        const ps = translationOf(state.pixelShader, state.psVariant);
        /** @type {(string | null)[]} */
        const formats = state.targetFormats;
        const bound = formats.flatMap((format, index)=>(format ? [index] : []));
        const rasterizer = state.rasterizerState
            ? stateDesc(state.rasterizerState)
            : DEFAULT_RASTERIZER;
        // A constant bias on a normalised depth is n-bit steps in Direct3D;
        // WebGPU leaves its step to the implementation (a 24-bit depth kept as
        // a float steps by the depth's exponent), so the fragment stage adds
        // the whole bias itself.
        const unormBits = UNORM_DEPTH_BITS[state.depthFormat ?? ''] ?? 0;
        const emulatedBias = unormBits && rasterizer.DepthBias
            ? { units: rasterizer.DepthBias * 2 ** -unormBits,
                slope: rasterizer.SlopeScaledDepthBias, clamp: rasterizer.DepthBiasClamp }
            : undefined;
        const pulling = state.hullShader || state.geometry ? null
            : vertexPullOf(state.inputLayout, state.strides, state.indirect, state.vertexShader);
        const [layerIndex, layerCount] = (state.layerPass || '').split('/').map(Number);
        // The first target blended by the shader's second output: both
        // outputs go to it (`dualSource` in `linkProgram`).
        const firstBlend = blendTargetsOf(state.blendState).targets[0];
        const dualSource = backend.hasFeature?.('dual-source-blending') === true
            && !!firstBlend?.BlendEnable && [firstBlend.SrcBlend, firstBlend.DestBlend,
            firstBlend.SrcBlendAlpha, firstBlend.DestBlendAlpha].some(factor=>
            DUAL_SOURCE.has(factor));
        // Each target's scalar, which its output is whatever the shader says.
        const targetScalars = Object.fromEntries(bound.map(index=>[index,
            /uint$/.test(formats[index] ?? '') ? 'u32'
                : /sint$/.test(formats[index] ?? '') ? 'i32' : 'f32']));
        const linking = { targets: bound, targetScalars, depthBias: emulatedBias,
            sampleCount: state.sampleCount,
            alphaCoverage: !!blendTargetsOf(state.blendState).alphaToCoverage
                && state.sampleCount === 1,
            clipDistances: backend.hasFeature?.('clip-distances') === true,
            ...(state.layerPass ? { layerPass: { index: layerIndex, count: layerCount } } : {}),
            ...(state.viewportPass ? { viewportPass: { index: Number(state.viewportPass
                .split('/')[0]), count: Number(state.viewportPass.split('/')[1]) } } : {}),
            ...(pulling ? { vertexPull: pulling.pull } : {}),
            ...(dualSource ? { dualSource } : {}),
            ...(state.earlyDepth ? { earlyDepth: {
                compare: state.earlyDepth.split(':')[0],
                multisampled: state.earlyDepth.endsWith(':ms') } } : {}) };
        const program = state.hullShader
            ? linkDomain(vs, state.vertexShader.container, ps, state.hullShader.container,
                tessellationOf().hullOf(state.hullShader).stage, linking)
            : state.geometry
                ? linkGeometryDraw(state.geometry.gs, state.geometry.stage, state.geometry.stream,
                    ps, linking)
                : linkProgram(vs, ps, linking);
        if (program.unsupported.length > 0)
        {
            throw Object.assign(new Error('the shaders cannot be translated:'
                + ` ${program.unsupported.join('; ')}`), { untranslatable: true });
        }
        // A domain or geometry shader's vertices come from storage, not from buffers.
        const layout = state.hullShader || state.geometry ? { buffers: [], slots: [] }
            : vertexLayouts(state.inputLayout, program, state.strides, pulling?.slots);
        if (typeof layout === 'string')
        {
            throw new Error(layout);
        }
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
                if (target.BlendEnable && (!BLEND_FACTOR[factor]
                    || (DUAL_SOURCE.has(factor) && !dualSource)))
                {
                    throw new Error(`blend factor ${factor} has no counterpart`
                        + `${DUAL_SOURCE.has(factor) ? ' without dual-source-blending' : ''}`);
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
        const groupLayouts = [...program.groups,
            ...(state.hullShader ? [/** @type {any[]} */(DOMAIN_ENTRIES)]
                : state.geometry ? [/** @type {any[]} */(GEOMETRY_DRAW_ENTRIES)] : [])]
            .map((entries, index)=>layoutFor(entries, `d3d10:${['vs', 'ps', 'ds'][index]}`));
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
                        // A pass over a read-only aspect takes no pipeline
                        // that writes it; Direct3D writes nothing there either.
                        depthWriteEnabled: depthEnabled
                            && depthStencil.DepthWriteMask === D3D10_DEPTH_WRITE_MASK.ALL
                            && (state.depthReadOnly & D3D11_DSV_FLAG.READ_ONLY_DEPTH) === 0,
                        depthCompare: depthEnabled ? COMPARE[depthStencil.DepthFunc] : 'always',
                        // A format with no stencil makes the stencil test a
                        // no-op in Direct3D; WebGPU refuses the pipeline instead.
                        ...(depthStencil.StencilEnable && state.depthFormat.includes('stencil')
                            ? {
                                stencilFront: face('FrontFace'),
                                stencilBack: face('BackFace'),
                                stencilReadMask: depthStencil.StencilReadMask,
                                stencilWriteMask: (state.depthReadOnly
                                    & D3D11_DSV_FLAG.READ_ONLY_STENCIL) !== 0
                                    ? 0 : depthStencil.StencilWriteMask,
                            }
                            : {}),
                        depthBias: emulatedBias ? 0 : rasterizer.DepthBias,
                        depthBiasSlopeScale: emulatedBias ? 0 : rasterizer.SlopeScaledDepthBias,
                        depthBiasClamp: emulatedBias ? 0 : rasterizer.DepthBiasClamp,
                    },
                }
                : {}),
            multisample: {
                count: state.sampleCount,
                mask: state.sampleMask >>> 0,
                // One sample covers by alpha in the fragment stage
                // (`linkProgram`'s `alphaCoverage`).
                alphaToCoverageEnabled: !!blend.alphaToCoverage && state.sampleCount > 1,
            },
        });
        return {
            gpu, program, groupLayouts, slots: layout.slots,
            steps: layout.buffers.map((/** @type {any} */ buffer)=>buffer.stepMode),
            strides: layout.buffers.map((/** @type {any} */ buffer)=>buffer.arrayStride ?? 0),
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
        if (!target)
        {
            /** @type {{ resource?: any }} */
            const held = {};
            view.GetResource(held);
            held.resource.release();
            /** @type {{ desc?: any }} */
            const described = {};
            view.GetDesc(described);
            target = layerTarget(held.resource, described.desc, view.range.mip,
                view.range.first);
            if (target)
            {
                targets.set(view, target);
            }
        }
        if (target?.twin)
        {
            useTwin(target.backing, target.twin, { mip: target.mipLevel, levels: 1,
                first: target.layer, count: 1 }, true);
        }
        return target;
    };

    /** A view's targets past its first layer, by layer. @type {WeakMap<object, Map<number, any>>} */
    const layerTargets = new WeakMap();
    /**
     * A render target or depth stencil view's layer `layer` of those it
     * names, as a surface a pass draws into; null past them.
     *
     * @param {any} view @param {number} layer
     */
    const targetAtLayer = (view, layer)=>{
        if (!view || layer === 0)
        {
            return targetOf(view);
        }
        if (!view.range || layer >= view.range.count)
        {
            return null;
        }
        let byLayer = layerTargets.get(view);
        if (!byLayer)
        {
            byLayer = new Map();
            layerTargets.set(view, byLayer);
        }
        let target = byLayer.get(layer);
        if (target === undefined)
        {
            /** @type {{ resource?: any }} */
            const held = {};
            view.GetResource(held);
            held.resource.release();
            /** @type {{ desc?: any }} */
            const described = {};
            view.GetDesc(described);
            target = layerTarget(held.resource, described.desc, view.range.mip,
                view.range.first + layer);
            byLayer.set(layer, target);
        }
        if (target?.twin)
        {
            useTwin(target.backing, target.twin, { mip: target.mipLevel, levels: 1,
                first: target.layer, count: 1 }, true);
        }
        return target;
    };

    /**
     * How many layers a draw's targets have to send primitives to: the
     * most any bound array view names; a volume's view names W slices.
     *
     * @param {PipelineSnapshot} pipeline
     */
    const layersOf = pipeline=>Math.max(1, ...[...pipeline.renderTargets,
        pipeline.depthStencilView].map(view=>view?.range?.count ?? 1));

    /**
     * One level and slice of a texture as a surface a pass draws into, by
     * the format a view names: a render target's or depth stencil view's,
     * or a slice an unordered-access clear draws its value into.
     *
     * @param {any} resource @param {any} desc  the view's description
     * @param {number} mip @param {number} layer
     * @returns {any | null}
     */
    const layerTarget = (resource, desc, mip, layer)=>{
        const held = { resource };
        const backing = backingOf(held.resource);
        if (!backing.texture)
        {
            return null;
        }
        if (!backing.drawable)
        {
            lose(`a draw into a ${backing.layout.format} target: this GPU draws into none`
                + ' (texture-formats-tier1 or rg11b10ufloat-renderable missing)');
            return null;
        }
        // A slice of a volume is drawn into through a view of the volume
        // whole, the attachment naming the slice (WebGPU's depthSlice).
        const volume = held.resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D;
        const chosen = viewFormatOf(backing.layout.storage, desc.Format, formatOptions);
        const twin = chosen.reinterpreted ? twinOf(backing, desc.Format) : null;
        if (twin && !twin.drawable)
        {
            lose(`a draw into a ${twin.format} view: this GPU draws into none`);
            return null;
        }
        const format = twin ? twin.format : chosen.format ?? backing.layout.format;
        const texture = twin ? twin.texture : backing.texture;
        const width = levelExtent(held.resource.desc.Width, mip);
        const height = held.resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D
            ? 1
            : levelExtent(held.resource.desc.Height, mip);
        return {
            key: `${twin ? twin.id : backing.id}:${mip}:${layer}`,
            layer,
            mipLevel: mip,
            backing,
            twin,
            texture,
            format,
            sampleCount: backing.sampleCount,
            // What a draw writes, when the format keeps less than the texture
            // does: B8G8R8X8's unused byte stays the alpha of one it reads as.
            writeMask: desc.Format === DXGI_FORMAT.A8_UNORM ? 0x8
                : X8_FORMATS.has(desc.Format) ? 0x7 : 0xf,
            // A depth view's D3D11_DSV_FLAG bits: the aspects it leaves unwritten.
            readOnly: (desc.Flags ?? 0)
                & (D3D11_DSV_FLAG.READ_ONLY_DEPTH | D3D11_DSV_FLAG.READ_ONLY_STENCIL),
            surface: {
                texture,
                view: texture.createView({
                    label: `d3d10:target:${format}`,
                    format,
                    dimension: volume ? '3d' : '2d',
                    baseMipLevel: mip,
                    mipLevelCount: 1,
                    ...(volume ? {} : { baseArrayLayer: layer, arrayLayerCount: 1 }),
                }),
                ...(volume ? { depthSlice: layer } : {}),
                width,
                height,
                format,
                mipLevel: mip,
                label: `d3d10:${format}`,
            },
        };
    };

    /**
     * Early depth tests for a draw whose pixel shader asks for them and writes
     * through views (`[earlydepthstencil]`): WebGPU has none to ask for and
     * runs the shader before tests it may make after, so the shader tests
     * itself against the depth buffer, attached read-only and bound to it
     * (`earlyDepth` in `linkProgram`). Exact while the draw writes no depth,
     * which is how a pass that collects fragments draws; one that writes
     * depth tests after the shader. Null where the shader tests nothing.
     *
     * @param {any} state @param {any} depth @param {PipelineSnapshot} pipeline
     * @returns {{ target: any, view: any, key: string } | null}
     */
    const earlyDepthOf = (state, depth, pipeline)=>{
        const ps = state.pixelShader ? translationOf(state.pixelShader, state.psVariant) : null;
        if (!ps?.earlyDepth || ps.uavs.length === 0)
        {
            return null;
        }
        const tests = pipeline.depthStencilState ? stateDesc(pipeline.depthStencilState)
            : DEFAULT_DEPTH_STENCIL;
        const compare = COMPARE_OPERATOR[tests.DepthFunc];
        if (!tests.DepthEnable || !compare)
        {
            return null;
        }
        const sampled = depth.texture && (depth.texture.usage === undefined
            || (depth.texture.usage & TextureUsage.TEXTURE_BINDING) !== 0);
        if (tests.DepthWriteMask !== 0 && (depth.readOnly & D3D11_DSV_FLAG.READ_ONLY_DEPTH) === 0
            || !sampled)
        {
            diverge('a pixel shader that asks for early depth tests is tested after it runs:'
                + ' what it writes through views is written by fragments the test rejects');
            return null;
        }
        depth.early ??= {
            target: { ...depth, readOnly: depth.readOnly | D3D11_DSV_FLAG.READ_ONLY_DEPTH },
            view: depth.texture.createView({ label: 'd3d10:early-depth', aspect: 'depth-only',
                dimension: '2d', baseMipLevel: depth.mipLevel, mipLevelCount: 1,
                baseArrayLayer: depth.layer, arrayLayerCount: 1 }),
        };
        return { ...depth.early, key: `${compare}:${depth.sampleCount > 1 ? 'ms' : '1'}` };
    };

    /** @type {Map<string, any>} extent -> a target nothing reads */
    const blindTargets = new Map();
    /**
     * A target for a draw that has none: Direct3D rasterizes a pass with no
     * render target and no depth buffer for what its pixel shader writes
     * through views, over the viewport; WebGPU draws into at least one
     * attachment, so it draws into this one, written by no channel.
     *
     * @param {number} width @param {number} height
     */
    const blindTarget = (width, height)=>{
        const key = `${width}x${height}`;
        let target = blindTargets.get(key);
        if (!target)
        {
            const texture = createTexture({ label: `d3d10:blind:${key}`,
                size: { width, height, depthOrArrayLayers: 1 }, format: 'r8unorm',
                usage: TextureUsage.RENDER_ATTACHMENT });
            target = {
                key: `blind:${key}`, layer: 0, texture, format: 'r8unorm', sampleCount: 1,
                writeMask: 0, readOnly: 0,
                surface: { texture, view: texture.createView({ label: 'd3d10:blind' }),
                    width, height, format: 'r8unorm', mipLevel: 0, label: 'd3d10:blind' },
            };
            blindTargets.set(key, target);
        }
        return target;
    };

    /** Where each stream a vertex stage reads itself starts, by draw. @type {any} */
    let pullParams = null;
    /**
     * The words of the last draw's stream parameters an indirect draw's
     * arguments go into, and the byte of the arguments each takes.
     * @type {{ buffer: any, offset: number, from: number }[]}
     */
    let pulledFirst = [];
    /** @type {{ args: any, zero: any } | null} */
    let indirectScratch = null;
    /**
     * An indirect draw's arguments as WebGPU draws them: copied, the first
     * instance zero - Direct3D's instance ID counts from zero, and a device
     * draws from another first instance only with indirect-first-instance -
     * and the first instance copied into the streams the vertex stage reads
     * itself, which count from it.
     *
     * @param {{ gpu: any, offset: number }} indirect  the program's arguments
     * @param {boolean} indexed
     * @returns {{ gpu: any, offset: number }}  the arguments drawn with
     */
    const indirectOf = (indirect, indexed)=>{
        indirectScratch ??= {
            args: backend.createDynamicBuffer({ label: 'd3d10:indirect-args', size: 20,
                usage: BufferUsage.INDIRECT | BufferUsage.COPY_DST, gpuOnly: true }),
            zero: backend.createDynamicBuffer({ label: 'd3d10:zero-word', size: 4,
                usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST, gpuOnly: true }),
        };
        const words = indexed ? 5 : 4;
        const first = (words - 1) * 4;
        const args = indirectScratch.args.gpu;
        record({ kind: 'copyBuffer', source: indirect.gpu, sourceOffset: indirect.offset,
            destination: args, destinationOffset: 0, size: words * 4 });
        record({ kind: 'copyBuffer', source: indirectScratch.zero.gpu, sourceOffset: 0,
            destination: args, destinationOffset: first, size: 4 });
        for (const word of pulledFirst)
        {
            record({ kind: 'copyBuffer', source: indirect.gpu,
                sourceOffset: indirect.offset + word.from, destination: word.buffer,
                destinationOffset: word.offset, size: 4 });
        }
        return { gpu: args, offset: 0 };
    };
    /**
     * The bindings of the streams a draw's vertex stage reads itself: each
     * vertex buffer whole, and where its elements start (a per-instance
     * stream's from the first instance, which the instance index does not
     * count), its stride and its length.
     *
     * @param {{ pull: import('./wgsl.js').VertexPull, slots: number[] }} pulling
     * @param {PipelineSnapshot} pipeline @param {any} draw
     * @returns {object[]}
     */
    const pulledBindings = (pulling, pipeline, draw)=>{
        const streams = pulling.slots.length;
        const bytes = 16 * Math.max(1, streams + (pulling.pull.vertexBase ? 1 : 0));
        pullParams ??= backend.createDynamicBuffer({ label: 'd3d10:vertex-pull',
            size: 16 * 32, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST, keep: false });
        const lock = pullParams.lock(0, bytes, LockFlags.DISCARD);
        const words = new Uint32Array(bytes / 4);
        /** @type {object[]} */
        const entries = [];
        pulling.slots.forEach((slot, k)=>{
            const resource = pipeline.vertexBuffers[slot];
            const backing = resource ? backingOf(resource) : null;
            const binding = BINDING.VERTEX_PULL + k;
            if (!backing?.gpu)
            {
                entries.push({ binding, resource: { buffer: placeholdersOf().storage.gpu,
                    offset: 0, size: 16 } });
                return;
            }
            backing.gpu.markRead();
            // An indirect draw's first instance is copied in from its
            // arguments (`indirectOf`).
            words.set([pipeline.vertexOffsets[slot], pipeline.vertexStrides[slot] ?? 0,
                resource.desc.ByteWidth, draw.indirect ? 0 : draw.startInstance ?? 0], k * 4);
            entries.push({ binding, resource: { buffer: backing.gpu.gpu } });
        });
        const indexed = draw.indexCount !== undefined;
        if (pulling.pull.vertexBase && !draw.indirect)
        {
            words[streams * 4] = (indexed ? draw.baseVertex ?? 0 : draw.startVertex ?? 0) >>> 0;
        }
        lock.data.set(new Uint8Array(words.buffer));
        pullParams.unlock(lock);
        pullParams.markRead();
        // What an indirect draw's arguments put there: each per-instance
        // stream's first instance, and the first or base vertex.
        const first = indexed ? 16 : 12;
        pulledFirst = [...pulling.pull.streams.flatMap((stream, k)=>(stream.stepMode
            === 'instance' ? [{ buffer: pullParams.gpu, offset: k * 16 + 12, from: first }] : [])),
        ...(pulling.pull.vertexBase ? [{ buffer: pullParams.gpu, offset: streams * 16,
            from: indexed ? 12 : 8 }] : [])];
        entries.push({ binding: BINDING.VERTEX_PULL_PARAMS,
            resource: { buffer: pullParams.gpu, offset: 0, size: bytes } });
        return entries;
    };

    /** @type {ReturnType<typeof createGeometry> | null} */
    let geometryPasses = null;
    /** What draws through a geometry shader and stream output are recorded with. */
    const geometryOf = ()=>{
        geometryPasses ??= createGeometry({
            backend, BufferUsage, lose, layoutFor, idOf, translationOf,
            bindingsFor: (stage, entries, uavs)=>bindingsFor(stage, entries, uavs),
            vertexLayouts: (inputLayout, program, strides)=>
                vertexLayouts(inputLayout, program, strides),
            backingOf: resource=>backingOf(resource),
            pipelines,
            placeholder: ()=>placeholdersOf().storage,
        });
        return geometryPasses;
    };

    /** @type {ReturnType<typeof createTessellation> | null} */
    let tessellation = null;
    /** What draws through the tessellator are recorded with, made at the first. */
    const tessellationOf = ()=>{
        tessellation ??= createTessellation({
            backend, BufferUsage, lose, layoutFor, idOf, translationOf,
            bindingsFor: (stage, entries, uavs)=>bindingsFor(stage, entries, uavs),
            vertexLayouts: (inputLayout, program, strides)=>
                vertexLayouts(inputLayout, program, strides),
            backingOf: resource=>backingOf(resource),
            pipelines,
            placeholder: ()=>placeholdersOf().storage,
        });
        return tessellation;
    };

    /**
     * What a shader reads as an empty texture says of the view bound: a
     * buffer's, where the shader declares a texture, or a texture's in a
     * format or shape the device did not make.
     *
     * @param {any} view
     */
    const unbackedView = view=>{
        /** @type {{ resource?: any }} */
        const held = {};
        view.GetResource(held);
        const resource = held.resource;
        resource?.release();
        /** @type {{ desc?: any }} */
        const described = {};
        view.GetDesc(described);
        const format = described.desc?.Format ?? 'unknown';
        return resource?.dimension === D3D10_RESOURCE_DIMENSION.BUFFER
            ? `a buffer's view (format ${format}) bound where the shader reads a texture is read`
                + ' as an empty texture'
            : `a texture this device did not make (view format ${format},`
                + ` ${view.dimensionName ?? 'unknown shape'}) is read as an empty texture`;
    };

    /**
     * The bind group entries of one stage, from what the device has bound.
     *
     * @param {any} stage  The device's per-stage bindings.
     * @param {import('./wgsl.js').BindGroupLayoutEntry[]} entries
     * @param {readonly any[]} [uavs]  What the stage writes through, by slot.
     * @returns {object[]}
     */
    const bindingsFor = (stage, entries, uavs = NO_VIEWS)=>{
        const fallback = placeholdersOf();
        return entries.map(entry=>{
            if (entry.binding >= BINDING.UAV)
            {
                return uavBinding(uavs, entry, fallback);
            }
            if (entry.buffer && entry.binding >= BINDING.TEXTURE)
            {
                return bufferViewBinding(stage, entry, fallback);
            }
            if (entry.buffer)
            {
                const buffer = stage.constantBuffers[entry.binding] ?? null;
                const backing = buffer ? backingOf(buffer) : null;
                const declared = entry.buffer.minBindingSize ?? 16;
                if (backing?.gpu && backing.gpu.size < declared)
                {
                    roomFor(buffer, backing, declared);
                }
                // A write before the frame is submitted renames what this draw
                // reads (UpdateSubresource between draws), as a vertex
                // buffer's does.
                backing?.gpu?.markRead();
                return {
                    binding: entry.binding,
                    resource: backing && backing.gpu
                        ? { buffer: backing.gpu.gpu, offset: 0,
                            size: Math.max(buffer.desc.ByteWidth, declared) }
                        : { buffer: fallback.buffer.gpu, offset: 0, size: declared },
                };
            }
            if (entry.texture)
            {
                const view = stage.shaderResources[entry.binding - BINDING.TEXTURE];
                const gpu = view ? viewOf(view) : null;
                if (view && !gpu)
                {
                    diverge(unbackedView(view));
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
                if (gpu)
                {
                    reads.add(gpu.backing.id);
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
            const nearest = entry.sampler?.type === 'non-filtering';
            return {
                binding: entry.binding,
                resource: sampler && comparison === isComparisonSampler(sampler)
                    ? samplerOf(sampler, nearest)
                    : comparison ? fallback.comparison : fallback.sampler,
            };
        });
    };

    /**
     * A constant buffer bound where a shader declares more constants than it
     * holds: Direct3D reads zeros past its end, and WebGPU binds no fewer
     * bytes than the declaration reads, refusing the whole frame otherwise.
     * Its GPU copy grows to the declaration's size, the bytes past the
     * buffer's zeros, once; later draws bind it as it is.
     *
     * @param {any} buffer @param {any} backing @param {number} declared
     */
    const roomFor = (buffer, backing, declared)=>{
        backing.gpu = backend.createDynamicBuffer({
            label: `d3d10:buffer#${buffer.desc.ByteWidth}+`,
            size: declared,
            usage: bufferUsageOf(buffer.desc),
        });
        upload(buffer, 0);
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
        if (source.dimension === D3D10_RESOURCE_DIMENSION.BUFFER)
        {
            return gpuBufferCopy(destination, to, at.x, from, box);
        }
        // One depth texture into another of its format: WebGPU copies a depth
        // subresource whole, which is the only copy Direct3D makes of one.
        if (from.texture && from.layout.storage.depth && to.texture
            && to.layout.storage?.format === from.layout.storage.format
            && to.sampleCount === from.sampleCount && !box && !at.x && !at.y && !at.z)
        {
            const src = subresourceOf(source, sourceSubresource);
            const dst = subresourceOf(destination, destinationSubresource);
            const level = from.layout.levels[src.level];
            record({
                kind: 'copyTexture',
                sourceId: from.id,
                destinationId: to.id,
                source: { texture: from.texture, mipLevel: src.level,
                    origin: { x: 0, y: 0, z: src.slice } },
                destination: { texture: to.texture, mipLevel: dst.level,
                    origin: { x: 0, y: 0, z: dst.slice } },
                size: { width: level.width, height: level.height, depthOrArrayLayers: 1 },
            });
            to.gpuDirty = true;
            return true;
        }
        if (from.texture && from.layout.storage.depth && from.sampleCount === 1
            && destination.desc.Usage === D3D10_USAGE.STAGING
            && source.dimension !== D3D10_RESOURCE_DIMENSION.TEXTURE3D)
        {
            return depthReadback(destination, destinationSubresource, at, source,
                sourceSubresource, box);
        }
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
                    origin: { x: at.x, y: at.y,
                        z: destination.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D ? at.z
                            : dst.slice },
                },
                size,
            });
            to.gpuDirty = true;
            return true;
        }
        // A staging resource: the level comes back whole, and the box is
        // placed where the program asked.
        if (destination.desc.Usage !== D3D10_USAGE.STAGING || !readable(from))
        {
            return false;
        }
        const texel = programTexel(from);
        const gpuTexel = TEXEL_BYTES[from.layout.storage.format];
        // A volume comes back a depth slice at a time.
        if (is3D)
        {
            for (let z = 0; z < size.depthOrArrayLayers; z++)
            {
                record({
                    kind: 'readback',
                    sourceId: from.id,
                    surface: {
                        texture: from.texture, mipLevel: src.level, layer: region.front + z,
                        width: fromLevel.width, height: fromLevel.height, bytesPerTexel: gpuTexel,
                    },
                    deliver: asProgramTexels(from, stagingDelivery(destination,
                        destinationSubresource, at, region, size, texel, at.z + z)),
                });
            }
            return true;
        }
        record({
            kind: 'readback',
            sourceId: from.id,
            surface: {
                texture: from.texture, mipLevel: src.level, layer: src.slice,
                width: fromLevel.width, height: fromLevel.height, bytesPerTexel: gpuTexel,
            },
            deliver: asProgramTexels(from, stagingDelivery(destination, destinationSubresource,
                at, region, size, texel)),
        });
        return true;
    };

    /**
     * What a read back into a staging resource does when its image arrives:
     * the box placed where the program asked, and a map that waits for it
     * let go.
     *
     * @param {any} destination @param {number} destinationSubresource
     * @param {{ x: number, y: number }} at @param {{ left: number, top: number }} region
     * @param {{ width: number, height: number }} size @param {number} texel
     * @returns {(image: { width: number, height: number, data: Uint8Array } | null) => void}
     */
    const stagingDelivery = (destination, destinationSubresource, at, region, size, texel,
        slice = 0)=>
    {
        const to = backingOf(destination);
        /** @type {(value?: any) => void} */
        let resolve = ()=>{};
        const promise = new Promise(done=>{
            resolve = done;
        });
        const waiting = { promise, sequence: recordedCount + 1 };
        let delivered = false;
        to.readback = waiting;
        return image=>{
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
                        slice * into.depthPitch + (at.y + row) * into.rowPitch + at.x * texel);
                }
            }
            else
            {
                diverge('a read back that did not arrive leaves the staging resource as it'
                    + ' was');
            }
            if (to.guest)
            {
                to.hostNewer = true;
            }
            if (to.readback === waiting)
            {
                to.readback = null;
            }
            resolve();
        };
    };

    /**
     * A depth texture's level and slice read back into a staging resource:
     * WebGPU copies no depth with stencil, and no 24-bit depth, out of a
     * texture, so a compute pass loads every texel and writes the words
     * Direct3D keeps for its format (`DEPTH_READBACK`), which come back as a
     * read back's image does.
     *
     * @param {any} destination @param {number} destinationSubresource
     * @param {{ x: number, y: number, z: number }} at
     * @param {any} source @param {number} sourceSubresource @param {Box | null} box
     * @returns {boolean}
     */
    const depthReadback = (destination, destinationSubresource, at, source,
        sourceSubresource, box)=>
    {
        const from = backingOf(source);
        const format = from.layout.storage.format;
        const shape = DEPTH_READBACK[format];
        if (!shape)
        {
            return false;
        }
        const src = subresourceOf(source, sourceSubresource);
        const dst = subresourceOf(destination, destinationSubresource);
        const level = from.layout.levels[src.level];
        const toLevel = backingOf(destination).layout.levels[dst.level];
        const region = box ?? { left: 0, top: 0, right: level.width, bottom: level.height };
        const size = {
            width: Math.min(Math.min(region.right, level.width) - region.left,
                toLevel.width - at.x),
            height: Math.min(Math.min(region.bottom, level.height) - region.top,
                toLevel.height - at.y),
        };
        if (size.width <= 0 || size.height <= 0)
        {
            return true;
        }
        const texel = TEXEL_BYTES[format];
        const bytes = Math.ceil((level.width * level.height * texel) / 4) * 4;
        const out = backend.createDynamicBuffer({ label: 'd3d10:depth-readback',
            size: Math.max(16, bytes),
            usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC, keep: false, gpuOnly: true });
        out.markRead();
        /** @param {string} aspect */
        const view = aspect=>from.texture.createView({ label: `d3d10:depth-readback:${aspect}`,
            dimension: '2d', aspect, baseMipLevel: src.level, mipLevelCount: 1,
            baseArrayLayer: src.slice, arrayLayerCount: 1 });
        const entries = [{ binding: 0, resource: view('depth-only') },
            ...(shape.stencil ? [{ binding: 1, resource: view('stencil-only') }] : []),
            { binding: 2, resource: { buffer: out.gpu, offset: 0, size: Math.max(16, bytes) } }];
        record({
            kind: 'dispatch',
            what: 'a depth texture\'s read back was skipped',
            ids: [from.id],
            pipeline: computePipelineFor(`depth-readback:${format}`, depthReadbackShader(format),
                [{ binding: 0, visibility: STAGE.COMPUTE,
                    texture: { sampleType: 'depth', viewDimension: '2d' } },
                ...(shape.stencil ? [{ binding: 1, visibility: STAGE.COMPUTE,
                    texture: { sampleType: 'uint', viewDimension: '2d' } }] : []),
                { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }],
                'd3d10:depth-readback'),
            entries,
            grid: [Math.ceil(bytes / 4 / 64), 1, 1],
        });
        const deliver = stagingDelivery(destination, destinationSubresource, at, region, size,
            texel);
        record({
            kind: 'readbackBuffer',
            ranges: [{ buffer: out.gpu, offset: 0, size: bytes }],
            /** @param {Uint8Array[] | null} results */
            deliver(results){
                deliver(results ? { width: level.width, height: level.height,
                    data: results[0] } : null);
            },
        });
        backend.releaseDynamicBuffer(out);
        return true;
    };

    /**
     * Bytes a program gives a depth texture's level and slice, drawn into it:
     * a pass over the depth alone in which a triangle over the whole level
     * writes each texel's depth from the words Direct3D keeps for the format
     * (`depthWriteShader`), and, for a format with a stencil, eight more draws
     * that each write one bit of the stencil where it is set, the stencil
     * cleared to zero first. WebGPU copies into no depth with a stencil and
     * into no 32-bit float depth.
     *
     * @param {any} resource @param {number} subresource
     */
    const depthUpload = (resource, subresource)=>{
        const backing = backingOf(resource);
        const format = backing.layout.storage.format;
        if (!DEPTH_READBACK[format] || !backing.texture || backing.sampleCount !== 1)
        {
            lose(`bytes a program gives a ${format} texture are kept but not uploaded`);
            return;
        }
        const { level, slice } = subresourceOf(resource, subresource);
        const geometry = backing.layout.levels[level];
        const held = subresourceBytes(resource, subresource);
        const texel = TEXEL_BYTES[format];
        // Word 0 is the level's width; the texels follow, packed by rows.
        const words = new Uint32Array(1 + Math.ceil((geometry.width * geometry.height * texel)
            / 4));
        const packed = new Uint8Array(words.buffer, 4);
        for (let row = 0; row < geometry.height; row++)
        {
            packed.set(held.bytes.subarray(row * held.rowPitch,
                row * held.rowPitch + geometry.width * texel), row * geometry.width * texel);
        }
        words[0] = geometry.width;
        const buffer = backend.createDynamicBuffer({ label: 'd3d10:depth-upload',
            size: words.byteLength, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
            keep: false });
        const lock = buffer.lock(0, words.byteLength, LockFlags.NONE);
        lock.data.set(new Uint8Array(words.buffer));
        buffer.unlock(lock);
        buffer.markRead();
        const stencil = DEPTH_READBACK[format].stencil;
        record({
            kind: 'depthWrite',
            what: 'bytes a program gave a depth texture were not drawn into it',
            ids: [backing.id],
            pipeline: depthWritePipelines(format),
            stencil,
            view: backing.texture.createView({ label: 'd3d10:depth-upload', dimension: '2d',
                baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: slice,
                arrayLayerCount: 1 }),
            surface: { width: geometry.width, height: geometry.height, format,
                label: 'd3d10:depth-upload' },
            entries: [{ binding: 0, resource: { buffer: buffer.gpu, offset: 0,
                size: words.byteLength } }],
        });
        backend.releaseDynamicBuffer(buffer);
    };

    /**
     * The pipelines a depth upload draws with, built once a format: the depth
     * one, then for a format with a stencil one for each of its eight bits.
     *
     * @param {string} format
     * @returns {Promise<{ depth: any, bits: any[], layout: any }>}
     */
    const depthWritePipelines = format=>{
        const key = `depth-write:${format}`;
        let promise = pipelines.get(key);
        if (!promise)
        {
            promise = (async()=>{
                const label = `d3d10:depth-write:${format}`;
                const module = await backend.createShaderModule({
                    code: depthWriteShader(format), label });
                const layout = layoutFor([{ binding: 0, visibility: STAGE.FRAGMENT,
                    buffer: { type: 'read-only-storage' } }], label);
                const pipelineLayout = backend.createPipelineLayout({ label,
                    bindGroupLayouts: [layout] });
                const stencil = DEPTH_READBACK[format].stencil;
                const face = { compare: 'always', failOp: 'keep', depthFailOp: 'keep',
                    passOp: 'replace' };
                /** @param {string} entryPoint @param {number} bit -1 for the depth */
                const make = (entryPoint, bit)=>backend.createRenderPipeline({
                    label: `${label}:${bit}`,
                    layout: pipelineLayout,
                    vertex: { module, entryPoint: 'vertexMain' },
                    fragment: { module, entryPoint, targets: [],
                        ...(bit >= 0 ? { constants: { bit } } : {}) },
                    primitive: { topology: 'triangle-list' },
                    depthStencil: {
                        format,
                        depthWriteEnabled: bit < 0,
                        depthCompare: 'always',
                        ...(stencil ? { stencilFront: face, stencilBack: face,
                            stencilReadMask: 0xff, stencilWriteMask: bit < 0 ? 0 : 1 << bit }
                            : {}),
                    },
                });
                return {
                    depth: await make('depthMain', -1),
                    bits: stencil ? await Promise.all(Array.from({ length: 8 },
                        (_, bit)=>make('stencilMain', bit))) : [],
                    layout,
                };
            })();
            pipelines.set(key, promise);
        }
        return promise;
    };

    /**
     * A copy out of a buffer the GPU may have written: into one it keeps,
     * by the GPU, in whole words; into a staging one, as a read back that
     * a map of it waits for.
     *
     * @param {any} destination @param {any} to @param {number} offset
     * @param {any} from @param {Box | null} box
     * @returns {boolean} whether the GPU makes it
     */
    const gpuBufferCopy = (destination, to, offset, from, box)=>{
        const left = box ? box.left : 0;
        const size = Math.min((box ? box.right : from.bytes.length) - left,
            to.bytes.length - offset, from.bytes.length - left);
        if (!from.gpu)
        {
            return false;
        }
        if (size <= 0)
        {
            return true;
        }
        if (to.gpu)
        {
            if (((left | offset | size) & 3) !== 0)
            {
                return false;
            }
            from.gpu.markRead();
            record({ kind: 'copyBuffer', source: from.gpu.gpu, sourceOffset: left,
                destination: to.gpu.gpu, destinationOffset: offset, size });
            to.gpuDirty = true;
            return true;
        }
        if (destination.desc.Usage !== D3D10_USAGE.STAGING)
        {
            return false;
        }
        /** @type {(value?: any) => void} */
        let resolve = ()=>{};
        const promise = new Promise(done=>{
            resolve = done;
        });
        const waiting = { promise, sequence: recordedCount + 1 };
        let delivered = false;
        from.gpu.markRead();
        record({
            kind: 'readbackBuffer',
            ranges: [{ buffer: from.gpu.gpu, offset: left, size }],
            /** @param {Uint8Array[] | null} results */
            deliver(results){
                if (delivered)
                {
                    return;
                }
                delivered = true;
                if (results)
                {
                    to.bytes.set(results[0], offset);
                }
                else
                {
                    diverge('a read back that did not arrive leaves the staging buffer as it was');
                }
                if (to.guest)
                {
                    to.hostNewer = true;
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
     * @param {{ mip: number, levels: number, first: number, count: number }} range  the
     *     view's levels and slices
     */
    const recordMips = (resource, backing, range)=>{
        mipSampler = mipSampler ?? createSampler({
            label: 'd3d10:mips', magFilter: 'linear', minFilter: 'linear',
        });
        const format = backing.layout.format;
        const steps = [];
        for (let slice = range.first; slice < range.first + range.count; slice++)
        {
            for (let level = range.mip + 1; level < range.mip + range.levels; level++)
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

    /** @type {Map<string, Promise<any>>} kind and format -> the pipeline that draws it */
    const blitPipelines = new Map();

    /**
     * The pipeline that draws a whole texture into a target of `format`: by
     * averaging its four samples, or by reading its one.
     *
     * @param {'resolve' | 'copy'} kind
     * @param {string} format
     */
    const blitPipelineFor = (kind, format)=>{
        const key = `${kind}:${format}`;
        let built = blitPipelines.get(key);
        if (!built)
        {
            built = (async()=>{
                const module = await backend.createShaderModule({
                    code: kind === 'resolve' ? RESOLVE_SHADER : COPY_SHADER,
                    label: `d3d10:${kind}`,
                });
                const layout = layoutFor([
                    { binding: 0, visibility: STAGE.FRAGMENT, texture: kind === 'resolve'
                        ? { sampleType: 'unfilterable-float', viewDimension: '2d',
                            multisampled: true }
                        : { sampleType: 'unfilterable-float', viewDimension: '2d' } },
                ], `d3d10:${kind}`);
                const gpu = backend.createRenderPipeline({
                    label: `d3d10:${kind}:${format}`,
                    layout: backend.createPipelineLayout({
                        label: `d3d10:${kind}`, bindGroupLayouts: [layout],
                    }),
                    vertex: { module, entryPoint: 'vertexMain', buffers: [] },
                    fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
                    primitive: { topology: 'triangle-list' },
                });
                return { gpu, layout };
            })();
            blitPipelines.set(key, built);
        }
        return built;
    };

    /**
     * Records the top level of a texture drawn into one level and slice of
     * another: a multisampled one resolved, a one-sample one copied through
     * the shader where the two formats are not ones the GPU copies between.
     *
     * @param {any} from          The backing drawn from.
     * @param {any} to            The one-sample backing drawn into.
     * @param {number} level
     * @param {number} slice
     * @param {string} format     The WebGPU format the source is read in.
     * @param {string} [written]  The one the target is written in; the same by default.
     */
    const recordBlit = (from, to, level, slice, format, written = format)=>{
        const kind = from.sampleCount > 1 ? 'resolve' : 'copy';
        const geometry = to.layout.levels[level];
        record({
            kind: 'blit',
            ids: [from.id, to.id],
            what: kind === 'resolve'
                ? 'a multisampled texture was not resolved'
                : 'a texture was not drawn into another',
            pipeline: blitPipelineFor(kind, written),
            steps: [{
                surface: {
                    texture: to.texture,
                    view: to.texture.createView({
                        label: `d3d10:${kind}:target`, format: written, dimension: '2d',
                        baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: slice,
                        arrayLayerCount: 1,
                    }),
                    width: geometry.width,
                    height: geometry.height,
                    format: written,
                    label: `d3d10:${kind}`,
                },
                entries: [{ binding: 0, resource: from.texture.createView({
                    label: `d3d10:${kind}:source`, format, dimension: '2d', baseMipLevel: 0,
                    mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1,
                }) }],
            }],
        });
        to.gpuDirty = true;
    };

    /**
     * What a back buffer is shown as when it cannot be shown as it is: a
     * one-sample texture in a format a canvas takes, filled before each
     * present. Its own format is kept where the two differ only by sRGB, so
     * the bytes shown are the bytes drawn.
     *
     * @param {any} backing
     * @param {string} shown  The canvas format.
     */
    const presentedOf = (backing, shown)=>{
        if (!backing.presented)
        {
            const own = backing.layout.format;
            const twin = own !== shown && copyCompatible(own, shown);
            const texture = createTexture({
                label: `d3d10:presented:${shown}`,
                size: { width: backing.surface.width, height: backing.surface.height,
                    depthOrArrayLayers: 1 },
                format: shown,
                ...(twin ? { viewFormats: [own] } : {}),
                usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                    | TextureUsage.COPY_SRC | TextureUsage.COPY_DST,
            });
            backing.presented = {
                id: nextBacking++,
                texture,
                written: twin || own === shown ? own : shown,
                layout: { levels: [{ width: backing.surface.width,
                    height: backing.surface.height }] },
                surface: { ...backing.surface, texture, format: shown,
                    view: texture.createView({ label: 'd3d10:presented' }) },
            };
        }
        return backing.presented;
    };

    // --- targets and depth buffers of different sizes ---

    /** @type {Map<string, any>} format, slot and size -> a colour target's stand-in */
    const standInTextures = new Map();
    /** The copies back out of the stand-ins the last draw recorded, which the next may drop. */
    let lastStandIns = /** @type {{ copies: any[], key: string } | null} */ (null);

    /**
     * A colour target of the depth buffer's size that a draw renders into in
     * a target's place.
     *
     * @param {any} entry @param {number} slot @param {any} depth
     */
    const standInOf = (entry, slot, depth)=>{
        const key = `${entry.format}:${slot}:${depth.surface.width}x${depth.surface.height}`;
        let standIn = standInTextures.get(key);
        if (!standIn)
        {
            const texture = createTexture({
                label: `d3d10:stand-in:${key}`,
                size: { width: depth.surface.width, height: depth.surface.height,
                    depthOrArrayLayers: 1 },
                format: entry.format,
                usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC
                    | TextureUsage.COPY_DST,
            });
            standIn = {
                key: `stand-in:${key}`,
                backing: { id: nextBacking++ },
                layer: 0,
                texture,
                format: entry.format,
                sampleCount: 1,
                writeMask: entry.writeMask,
                surface: {
                    texture,
                    view: texture.createView({ label: `d3d10:stand-in:${key}` }),
                    width: depth.surface.width,
                    height: depth.surface.height,
                    format: entry.format,
                    mipLevel: 0,
                    label: `d3d10:stand-in:${entry.format}`,
                },
            };
            standInTextures.set(key, standIn);
        }
        return standIn;
    };

    /**
     * Records the copies of the targets' overlap with the depth buffer into
     * their stand-ins -- none where the draw before used the same and its
     * copies back are the last thing recorded, which are dropped instead --
     * and returns the copies back out, for after the draw.
     *
     * @param {any[]} colour @param {any[]} standing @param {any} depth
     */
    const standInsIn = (colour, standing, depth)=>{
        /** @param {any} from @param {any} to @param {any} entry */
        const copy = (from, to, entry)=>({
            kind: 'copyTexture',
            key: `${entry.key}>${standing[colour.indexOf(entry)].key}`,
            sourceId: from.backing.id,
            destinationId: to.backing.id,
            source: { texture: from.texture, mipLevel: from.surface.mipLevel ?? 0,
                origin: { x: 0, y: 0, z: from.layer ?? 0 } },
            destination: { texture: to.texture, mipLevel: to.surface.mipLevel ?? 0,
                origin: { x: 0, y: 0, z: to.layer ?? 0 } },
            size: { width: Math.min(entry.surface.width, depth.surface.width),
                height: Math.min(entry.surface.height, depth.surface.height),
                depthOrArrayLayers: 1 },
        });
        const present = colour.filter(entry=>entry);
        const out = present.map(entry=>copy(standing[colour.indexOf(entry)], entry, entry));
        const key = out.map(one=>one.key).join('|');
        const last = lastStandIns;
        if (last && last.key === key && recording.length >= last.copies.length
            && last.copies.every((one, index)=>recording[recording.length
                - last.copies.length + index] === one))
        {
            recording.length -= last.copies.length;
            recordedCount -= last.copies.length;
        }
        else
        {
            present.forEach(entry=>record(copy(entry, standing[colour.indexOf(entry)], entry)));
        }
        return out;
    };

    // --- compute and unordered access ---

    /** @type {Set<string> | null} */
    let storable = null;
    /** The texture formats a storage texture may be made in on this device. */
    const storableFormats = ()=>{
        storable ??= new Set(Object.values(STORAGE_TEXTURE_FORMAT).filter(format=>
            format !== 'bgra8unorm' || backend?.hasFeature?.('bgra8unorm-storage')));
        return storable;
    };

    /** @param {any} view @returns {any} the resource a view looks at, no reference kept */
    const resourceOf = view=>{
        /** @type {{ resource?: any }} */
        const held = {};
        view.GetResource(held);
        held.resource.release();
        return held.resource;
    };

    /** @type {WeakMap<object, Map<string, any>>} compute shader -> translation, by its views' formats */
    const computeTranslations = new WeakMap();
    /** @type {WeakMap<object, any>} translation -> its linked module */
    const linkedComputes = new WeakMap();
    /** @type {WeakMap<object, Map<string, any>>} unordered-access view -> storage texture views */
    const storageViews = new WeakMap();
    /** @type {WeakMap<object, any>} unordered-access view -> its counter's buffer */
    const counterBuffers = new WeakMap();

    /**
     * The storage format each typed view over a texture writes in, by slot:
     * what a compute shader's translation declares its storage textures as.
     *
     * @param {readonly any[]} bound
     * @returns {Record<number, string>}
     */
    const uavFormatsOf = bound=>{
        /** @type {Record<number, string>} */
        const formats = {};
        bound.forEach((view, slot)=>{
            if (view && view.dimensionName !== 'BUFFER')
            {
                const format = /** @type {Record<number, string>} */ (STORAGE_TEXTURE_FORMAT)[
                    stateDesc(view).Format];
                if (format)
                {
                    formats[slot] = format;
                }
            }
        });
        return formats;
    };

    /**
     * @param {any} shader @param {Record<number, string>} formats @param {string} key
     * @returns {{ translation: any, linked: { code: string, entries: any[],
     *     unsupported: string[] } }}
     */
    const computeOf = (shader, formats, key)=>{
        let variants = computeTranslations.get(shader);
        if (!variants)
        {
            variants = new Map();
            computeTranslations.set(shader, variants);
        }
        let translation = variants.get(key);
        if (!translation)
        {
            translation = translateShader(shader.container, { uavFormats: formats });
            variants.set(key, translation);
        }
        let linked = linkedComputes.get(translation);
        if (!linked)
        {
            linked = linkCompute(translation);
            linkedComputes.set(translation, linked);
        }
        return { translation, linked };
    };

    /**
     * A compute pipeline over one group laid out as `entries` declare.
     *
     * @param {string} key @param {string} code @param {any[]} entries @param {string} label
     * @param {string[]} [unsupported]
     * @returns {Promise<{ gpu: any, layout: any }>}
     */
    const computePipelineFor = (key, code, entries, label, unsupported = [])=>{
        let promise = pipelines.get(key);
        if (!promise)
        {
            promise = (async()=>{
                if (unsupported.length > 0)
                {
                    throw Object.assign(new Error('the compute shader cannot be translated:'
                        + ` ${unsupported.join('; ')}`), { untranslatable: true });
                }
                const module = await backend.createShaderModule({ code, label });
                const layout = layoutFor(entries, label);
                const gpu = await backend.createComputePipelineAsync({
                    label,
                    layout: backend.createPipelineLayout({ label, bindGroupLayouts: [layout] }),
                    compute: { module, entryPoint: 'computeMain' },
                });
                return { gpu, layout };
            })();
            pipelines.set(key, promise);
        }
        return promise;
    };

    /**
     * A storage texture view of the level and slices an unordered-access
     * view names, in the shape the shader declared; null where the texture
     * is not stored into in that format.
     *
     * @param {any} view @param {{ format: string, viewDimension: string }} kind
     */
    const storageViewOf = (view, kind)=>{
        const resource = resourceOf(view);
        const backing = backingOf(resource);
        const twin = backing.layout.format !== kind.format
            ? twinOf(backing, stateDesc(view).Format) : null;
        if (twin ? twin.format !== kind.format || !twin.storable
            : !backing.storable || backing.layout.format !== kind.format)
        {
            return null;
        }
        if (twin)
        {
            useTwin(backing, twin, { mip: view.range.mip, levels: 1, first: view.range.first,
                count: view.range.count }, true);
        }
        const key = `${kind.format}:${kind.viewDimension}`;
        let shapes = storageViews.get(view);
        if (!shapes)
        {
            shapes = new Map();
            storageViews.set(view, shapes);
        }
        let gpu = shapes.get(key);
        if (!gpu)
        {
            const is3D = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D;
            gpu = (twin ? twin.texture : backing.texture).createView({
                label: `d3d10:uav:${kind.format}`,
                format: kind.format,
                dimension: kind.viewDimension,
                baseMipLevel: view.range.mip,
                mipLevelCount: 1,
                ...(is3D ? {} : { baseArrayLayer: view.range.first,
                    arrayLayerCount: kind.viewDimension === '2d' ? 1 : view.range.count }),
            });
            shapes.set(key, gpu);
        }
        return { gpu, backing };
    };

    /**
     * The buffer an append or counter view's hidden count is kept in on the
     * GPU, the count a binding gave it written there first. The write
     * renames the buffer, so dispatches recorded before it count on the
     * one they were given.
     *
     * @param {any} view
     */
    const counterOf = view=>{
        let counter = counterBuffers.get(view);
        if (!counter)
        {
            counter = backend.createDynamicBuffer({
                label: 'd3d10:uav-counter', size: 4,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
            });
            counterBuffers.set(view, counter);
            view.counterSet = true;
        }
        if (view.counterSet)
        {
            view.counterSet = false;
            const lock = counter.lock(0, 4, LockFlags.DISCARD);
            new DataView(lock.data.buffer, lock.data.byteOffset, 4)
                .setUint32(0, view.counter >>> 0, true);
            counter.unlock(lock);
        }
        counter.markRead();
        return counter.gpu;
    };

    /**
     * A typed texture view a shader makes atomics on, as the words of its
     * texels in a buffer, rows padded as a copy lays them out (`words` in the
     * translator: WebGPU has no atomics on a storage texture). It is a twin:
     * given the texels before the operation and giving them back after.
     * Null where a texel is not one word.
     *
     * @param {any} view
     * @returns {{ words: any, uniform: any, rowWords: number } | null}
     */
    const wordsOf = view=>{
        const backing = backingOf(resourceOf(view));
        const level = backing.layout.levels[view.range.mip];
        if (!backing.texture || backing.sampleCount !== 1 || !level
            || TEXEL_BYTES[backing.layout.format] !== 4 || backing.layout.storage?.conversion)
        {
            return null;
        }
        const { mip, first, count } = view.range;
        backing.mirrors ??= new Map();
        const key = `${mip}:${first}:${count}`;
        let mirror = backing.mirrors.get(key);
        if (!mirror)
        {
            const rowWords = Math.ceil(level.width / 64) * 64;
            const words = backend.createDynamicBuffer({ label: 'd3d10:uav-words',
                size: rowWords * 4 * level.height * count,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
            const uniform = backend.createDynamicBuffer({ label: 'd3d10:uav-words-view', size: 16,
                usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
            const lock = uniform.lock(0, 16, LockFlags.DISCARD);
            lock.data.set(new Uint8Array(new Uint32Array([rowWords, level.height, level.width,
                count]).buffer));
            uniform.unlock(lock);
            mirror = { id: nextBacking++, words, uniform, rowWords };
            backing.mirrors.set(key, mirror);
        }
        useTwin(backing, mirror, { mip, levels: 1, first, count }, true);
        mirror.words.markRead();
        mirror.uniform.markRead();
        backing.gpuDirty = true;
        writes.add(backing.id);
        return mirror;
    };

    /** The backings the bindings being made write, by id. @type {Set<number>} */
    let writes = new Set();
    /**
     * The textures the bindings being made read through views, by backing
     * id: a clear still waiting for a pass on one is made before the read.
     * @type {Set<number>}
     */
    let reads = new Set();

    /**
     * A binding of what a shader writes through: the view's buffer or
     * storage texture, the uniform describing a buffer view, or its counter.
     * Nothing bound reads as zeros and drops what is written.
     *
     * @param {readonly any[]} bound @param {any} entry @param {any} fallback
     */
    const uavBinding = (bound, entry, fallback)=>{
        if (entry.binding >= BINDING.UAV_COUNTER)
        {
            const view = bound[entry.binding - BINDING.UAV_COUNTER];
            return { binding: entry.binding, resource: view
                ? { buffer: counterOf(view), offset: 0, size: 4 }
                : { buffer: fallback.writable.gpu, offset: 0, size: 4 } };
        }
        if (entry.binding >= BINDING.UAV_VIEW)
        {
            const view = bound[entry.binding - BINDING.UAV_VIEW];
            const mirror = view && view.dimensionName !== 'BUFFER' ? wordsOf(view) : null;
            return { binding: entry.binding, resource: view?.dimensionName === 'BUFFER'
                ? { buffer: viewUniformOf(view, stateDesc(view)), offset: 0, size: 16 }
                : { buffer: mirror ? mirror.uniform.gpu : fallback.buffer.gpu, offset: 0,
                    size: 16 } };
        }
        const view = bound[entry.binding - BINDING.UAV] ?? null;
        if (entry.storageTexture)
        {
            const made = view && view.dimensionName !== 'BUFFER'
                ? storageViewOf(view, entry.storageTexture)
                : null;
            if (view && !made)
            {
                diverge('a texture a shader writes in a format WebGPU does not store, or views'
                    + ' in another, is written into nothing');
            }
            if (made)
            {
                made.backing.gpuDirty = true;
                writes.add(made.backing.id);
            }
            return { binding: entry.binding,
                resource: made ? made.gpu : fallback.storageTexture(entry.storageTexture) };
        }
        const mirror = view && view.dimensionName !== 'BUFFER' ? wordsOf(view) : null;
        if (mirror)
        {
            return { binding: entry.binding, resource: { buffer: mirror.words.gpu, offset: 0,
                size: mirror.words.size } };
        }
        const resource = view?.dimensionName === 'BUFFER' ? resourceOf(view) : null;
        const backing = resource ? backingOf(resource) : null;
        if (!backing?.gpu)
        {
            if (view)
            {
                diverge('a texture bound where the shader writes a buffer is written into'
                    + ' nothing');
            }
            return { binding: entry.binding,
                resource: { buffer: fallback.writable.gpu, offset: 0, size: 16 } };
        }
        backing.gpu.markRead();
        backing.gpuDirty = true;
        writes.add(backing.id);
        return { binding: entry.binding, resource: { buffer: backing.gpu.gpu, offset: 0,
            size: Math.ceil(resource.desc.ByteWidth / 4) * 4 } };
    };

    /** The WGSL a storage texture of this format and shape is cleared with. */
    const CLEAR_SHADER = (/** @type {string} */ format, /** @type {string} */ shape)=>{
        const scalar = /uint$/.test(format) ? 'u32' : /sint$/.test(format) ? 'i32' : 'f32';
        const flat = shape === '3d';
        return [
            `@group(0) @binding(0) var cleared: texture_storage_${shape.replace('-', '_')}`
                + `<${format}, write>;`,
            '@group(0) @binding(1) var<uniform> value: vec4<u32>;',
            '@compute @workgroup_size(8, 8, 1)',
            'fn computeMain(@builtin(global_invocation_id) id: vec3<u32>) {',
            '    let size = textureDimensions(cleared);',
            `    if (id.x >= size.x || id.y >= size.y${flat ? ' || id.z >= size.z' : ''})`
                + ' { return; }',
            `    textureStore(cleared, ${flat ? 'id' : 'id.xy, id.z'},`
                + ` bitcast<vec4<${scalar}>>(value));`,
            '}',
        ].join('\n');
    };

    /**
     * A clear of a storage texture's level and slices, as a dispatch over
     * it in its turn.
     *
     * @param {any} view @param {any} resource @param {any} backing
     * @param {Uint32Array} texel
     */
    const clearStorage = (view, resource, backing, texel)=>{
        const is3D = resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D;
        const shape = is3D ? '3d' : '2d-array';
        const format = backing.layout.format;
        const made = storageViewOf(view, { format, viewDimension: shape });
        if (!made)
        {
            return false;
        }
        const entries = [
            { binding: 0, visibility: STAGE.COMPUTE,
                storageTexture: { access: 'write-only', format, viewDimension: shape } },
            { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } },
        ];
        const uniform = backend.createDynamicBuffer({
            label: 'd3d10:uav-clear', size: 16,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST, keep: false,
        });
        const lock = uniform.lock(0, 16, LockFlags.DISCARD);
        lock.data.set(new Uint8Array(texel.buffer));
        uniform.unlock(lock);
        uniform.markRead();
        const level = backing.layout.levels[view.range.mip];
        backing.gpuDirty = true;
        record({
            kind: 'dispatch',
            what: 'an unordered-access view was not cleared',
            ids: [backing.id],
            pipeline: computePipelineFor(`clear:${format}:${shape}`, CLEAR_SHADER(format, shape),
                entries, `d3d10:uav-clear:${format}`),
            entries: [{ binding: 0, resource: made.gpu },
                { binding: 1, resource: { buffer: uniform.gpu, offset: 0, size: 16 } }],
            grid: [Math.ceil(level.width / 8), Math.ceil(level.height / 8),
                is3D ? level.depth : view.range.count],
            release: uniform,
        });
        return true;
    };

    return {
        /**
         * The storage a resource made shared keeps, for another device's
         * renderer to take as its object's own (`sharing.js`).
         *
         * @param {any} resource
         */
        shareBacking(resource){
            return backingOf(resource);
        },

        /**
         * A resource opened over a share: its storage is the share's, bytes,
         * GPU texture and what the guest maps alike.
         *
         * @param {any} resource @param {any} backing
         */
        adoptBacking(resource, backing){
            backings.set(resource, backing);
        },

        /**
         * The program's last reference to a resource is gone: its guest
         * memory goes back. A view still holding it keeps what the GPU has;
         * one that hands it out again (GetResource) maps it into new memory.
         *
         * @param {any} resource
         */
        resourceReleased(resource){
            const backing = backings.get(resource);
            if (backing?.guest)
            {
                for (const storage of backing.guest.storages)
                {
                    services.guest?.free?.(storage.base);
                }
                backing.guest = null;
                backing.guestReleased = true;
            }
        },

        /**
         * Where a resource keeps the bytes a map hands out in guest memory.
         *
         * @param {any} resource
         * @returns {{ base: number, length: number } | null}
         */
        guestOf(resource){
            return backings.get(resource)?.guest ?? null;
        },

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
            const backing = backingOf(resource);
            if (backing.guestReleased && !backing.guest)
            {
                backing.guest = guestStorageOf(resource.desc, backing.bytes.length);
                backing.hostNewer = backing.guest !== null;
            }
            return { data: held.bytes, rowPitch: held.rowPitch, depthPitch: held.depthPitch,
                ...(backing.guest ? { address: guestMapped(backing, held.bytes.byteOffset),
                    bytes: held.bytes.length } : {}) };
        },

        /**
         * @param {any} resource
         * @param {number} subresource
         * @param {boolean} discard   The program gave the old contents up.
         * @param {boolean} noOverwrite  The program promises it touched nothing in flight.
         */
        unmap(resource, subresource, discard, noOverwrite){
            const flags = discard ? LockFlags.DISCARD
                : noOverwrite ? LockFlags.NOOVERWRITE : LockFlags.NONE;
            const backing = backingOf(resource);
            if (!backing.guest)
            {
                upload(resource, subresource, flags);
                return;
            }
            const held = subresourceBytes(resource, subresource);
            const changed = guestWritten(backing, held.bytes.byteOffset, held.bytes.length);
            if (changed)
            {
                upload(resource, subresource, flags, null,
                    resource.dimension === D3D10_RESOURCE_DIMENSION.BUFFER ? changed : null, true);
            }
        },

        /**
         * Another storage for a guest-backed buffer, which the guest's map
         * may move it onto for a DISCARD (`seam/d3d10-inguest.js`).
         *
         * @param {any} resource
         * @returns {number} its address, or 0 for none
         */
        addStorage(resource){
            const backing = backingOf(resource);
            // Only with a watch: an unmap from a storage the buffer moved onto
            // sends the pages written there, and the GPU keeps the rest as a
            // DISCARD's rename carries it. Without one it would send all of a
            // storage that holds only what was written since the move.
            const storage = backing.guest?.tracked ? storageOf(backing.guest.length) : null;
            if (!storage)
            {
                return 0;
            }
            backing.guest.storages.push(storage);
            return storage.base;
        },

        /**
         * An unmap the guest made of a buffer on one of its storages: the
         * buffer is on that storage from here on, and what the program wrote
         * there goes to the GPU as an unmap's would.
         *
         * @param {any} resource
         * @param {number} base  the storage
         * @param {boolean} discard @param {boolean} noOverwrite
         */
        unmapStorage(resource, base, discard, noOverwrite){
            const backing = backingOf(resource);
            const storage = backing.guest?.storages.find(
                (/** @type {{ base: number }} */ one)=>one.base === base);
            if (!storage)
            {
                return;
            }
            backing.guest.base = storage.base;
            backing.guest.tracked = storage.tracked;
            this.unmap(resource, 0, discard, noOverwrite);
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
            // A pitch is the program's to the byte: zero reads every row,
            // or slice, from the same bytes, as Direct3D does
            // (test_copy_subresource_region's UpdateSubresource1).
            const pitch = rowPitch;
            const slicePitch = depthPitch;
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
                diverge('a copy out of a resource the GPU wrote that the GPU cannot copy or'
                    + ' read back moves the bytes the program last wrote, not what the GPU made');
            }
            const from = subresourceBytes(source, sourceSubresource);
            const to = subresourceBytes(destination, destinationSubresource);
            const layout = backingOf(source).layout;
            const region = blocksOf(layout, from.level, box ?? {
                left: 0, top: 0, front: 0,
                right: from.level.width, bottom: from.level.height, back: from.level.depth,
            });
            // Blocks of a compressed format and texels of an uncompressed one
            // as big move one for one: each side is counted in its own.
            const toLayout = backingOf(destination).layout;
            const place = blocksOf(toLayout, to.level, {
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
            const edge = toLayout.blockEdge;
            upload(destination, destinationSubresource, LockFlags.NONE, {
                left: at.x, top: at.y, front: at.z,
                right: (place.left / toLayout.texelBytes + rowBytes / layout.texelBytes) * edge,
                bottom: (place.top + rows) * edge,
                back: at.z + depth,
            });
        },

        /**
         * @param {any} destination
         * @param {any} source
         */
        copyResource(destination, source){
            const count = (source.desc.MipLevels ?? 1) * backingOf(source).layout.slices;
            if (backend && gpuWritten(source))
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
         * @param {{ mip: number, levels: number, first: number, count: number } | null}
         *     [range]  the view's levels and slices; the whole resource for none
         * @returns {boolean} whether the levels were generated
         */
        generateMips(resource, range = null){
            const backing = backingOf(resource);
            // The view's levels and slices: from its most detailed level down.
            const span = range ?? { mip: 0, levels: backing.layout.levels.length, first: 0,
                count: backing.layout.slices };
            const format = backing.layout.format ?? '';
            if (backend && backing.texture && gpuWritten(resource)
                && resource.dimension !== D3D10_RESOURCE_DIMENSION.TEXTURE1D
                && resource.dimension !== D3D10_RESOURCE_DIMENSION.TEXTURE3D
                && MIPS_GENERATED.test(format) && backing.sampleCount === 1)
            {
                recordMips(resource, backing, span);
                return true;
            }
            if (backing.layout.texelBytes !== 4 || backing.layout.storage?.conversion
                || !(format.startsWith('rgba8') || format.startsWith('bgra8')))
            {
                diverge(`GenerateMips on a ${backing.layout.format} texture is not generated:`
                    + ' only eight-bit four-channel formats are filtered');
                return false;
            }
            // What the host holds is what the GPU holds until a draw or a copy
            // there has written the resource.
            if (gpuWritten(resource) && backing.gpuDirty)
            {
                diverge('GenerateMips filters the bytes the program last wrote into level zero,'
                    + ' not what the GPU drew there');
            }
            for (let slice = span.first; slice < span.first + span.count; slice++)
            {
                for (let level = span.mip + 1; level < span.mip + span.levels; level++)
                {
                    const first = slice * resource.desc.MipLevels;
                    const upper = subresourceBytes(resource, first + level - 1);
                    const lower = subresourceBytes(resource, first + level);
                    // A volume's level halves its depth as well: a 2x2x2 box.
                    const deep = (upper.level.depth ?? 1) > 1;
                    const corners = deep
                        ? [0, 1].flatMap(dz=>[[0, 0, dz], [1, 0, dz], [0, 1, dz], [1, 1, dz]])
                        : [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
                    for (let z = 0; z < (lower.level.depth ?? 1); z++)
                    {
                        for (let y = 0; y < lower.level.height; y++)
                        {
                            for (let x = 0; x < lower.level.width; x++)
                            {
                                for (let channel = 0; channel < 4; channel++)
                                {
                                    let sum = 0;
                                    for (const [dx, dy, dz] of corners)
                                    {
                                        const sx = Math.min(upper.level.width - 1, x * 2 + dx);
                                        const sy = Math.min(upper.level.height - 1, y * 2 + dy);
                                        const sz = Math.min((upper.level.depth ?? 1) - 1,
                                            z * 2 + dz);
                                        sum += upper.bytes[sz * upper.depthPitch
                                            + sy * upper.rowPitch + sx * 4 + channel];
                                    }
                                    lower.bytes[z * lower.depthPitch + y * lower.rowPitch + x * 4
                                        + channel] = Math.floor((sum + corners.length / 2)
                                        / corners.length);
                                }
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
            throughTwins(()=>{
                // A clear writes every texel of every slice the view names.
                const count = view?.range?.count ?? 1;
                const slices = [];
                for (let layer = 0; layer < count; layer++)
                {
                    slices.push(targetAtLayer(view, layer));
                }
                twinUses = new Map();
                for (const target of slices)
                {
                    if (target?.twin)
                    {
                        useTwin(target.backing, target.twin, { mip: target.mipLevel,
                            levels: 1, first: target.layer, count: 1 }, true, true);
                    }
                }
                return slices;
            }, slices=>{
                if (!slices[0])
                {
                    counters.skipped.noTarget++;
                    return;
                }
                counters.clears++;
                for (const target of slices)
                {
                    target.backing.gpuDirty = true;
                    record({ kind: 'clear', target, color: (target.writeMask & 0x8) === 0
                        && target.writeMask !== 0 ? [color[0], color[1], color[2], 1]
                        : [...color] });
                }
            });
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
            target.backing.gpuDirty = true;
            record({ kind: 'clearDepth', target, flags, depth, stencil });
        },

        /**
         * Whether the GPU may have written a buffer's bytes since the host's:
         * an indirect call's arguments then come from the GPU's copy.
         *
         * @param {any} resource
         */
        gpuArguments(resource){
            return !!backend && gpuWritten(resource) && !!backingOf(resource).gpu;
        },

        /**
         * The bytes the device keeps of a buffer, as the processor last made
         * them: what an indirect call's arguments are read from.
         *
         * @param {any} resource
         * @returns {Uint8Array}
         */
        bufferBytes(resource){
            const backing = backingOf(resource);
            if (backing.guest)
            {
                guestWritten(backing, 0, backing.bytes.length);
            }
            return backing.bytes;
        },

        /**
         * A compute shader's run over a grid of groups, or over the grid a
         * buffer holds at an offset, which the GPU reads.
         *
         * @param {PipelineSnapshot} pipeline
         * @param {{ x: number, y: number, z: number } | { buffer: any, offset: number }} groups
         */
        dispatch(pipeline, groups){
            if (!backend)
            {
                return;
            }
            const shader = pipeline.stages.cs.shader;
            if (!shader)
            {
                counters.skipped.noShader++;
                return;
            }
            const written = pipeline.computeViews ?? NO_VIEWS;
            const formats = uavFormatsOf(written);
            const key = Object.entries(formats).map(entry=>entry.join(':')).join(',');
            const { linked } = computeOf(shader, formats, key);
            writes = new Set();
            reads = new Set();
            twinUses = new Map();
            const entries = bindingsFor(pipeline.stages.cs, linked.entries, written);
            const indirect = 'buffer' in groups ? backingOf(groups.buffer) : null;
            indirect?.gpu.markRead();
            counters.dispatches++;
            syncTwins(false);
            record({
                kind: 'dispatch',
                what: 'a dispatch was skipped',
                ids: [...writes, ...reads],
                pipeline: computePipelineFor(`cs:${idOf(shader)}|${key}`, linked.code,
                    linked.entries, `d3d10:cs#${idOf(shader)}`, linked.unsupported),
                entries,
                grid: indirect
                    ? { buffer: indirect.gpu.gpu, offset: /** @type {any} */ (groups).offset }
                    : ['x', 'y', 'z'].map(axis=>/** @type {any} */ (groups)[axis]),
            });
            syncTwins(true);
            twinUses = new Map();
        },

        /**
         * A clear of everything an unordered-access view reaches, in its
         * turn: a buffer's elements written as the bytes the clear makes of
         * the values, a texture's by a dispatch over it.
         *
         * @param {any} view an unordered-access view
         * @param {number[]} values @param {boolean} float
         */
        clearUnorderedAccessView(view, values, float){
            const resource = resourceOf(view);
            const backing = backingOf(resource);
            const desc = stateDesc(view);
            if (view.dimensionName !== 'BUFFER' && !backing.texture)
            {
                // A texture the GPU cannot keep lives in its bytes alone, so
                // that is where it is cleared (test_clear_image_unordered_access_view).
                const element = clearElement(desc.Format, values, float);
                if (element && element.length === backing.layout.texelBytes)
                {
                    clearHeld(resource, view.range, element);
                }
                else
                {
                    diverge(`a ${float ? 'Float' : 'Uint'} clear of a texture view in format`
                        + ` ${desc.Format} writes nothing`);
                }
                return;
            }
            if (!backend)
            {
                return;
            }
            if (view.dimensionName === 'BUFFER')
            {
                const words = (desc.Flags & D3D11_BUFFER_UAV_FLAG.RAW) !== 0
                    || desc.Format === DXGI_FORMAT.UNKNOWN;
                const element = words
                    ? float ? null : new Uint8Array(new Uint32Array([values[0] >>> 0]).buffer)
                    : clearElement(desc.Format, values, float);
                if (!element)
                {
                    diverge(`a ${float ? 'Float' : 'Uint'} clear of a buffer view in format`
                        + ` ${desc.Format} writes nothing`);
                    return;
                }
                const start = desc.FirstElement * desc.elementBytes;
                const end = start + desc.NumElements * desc.elementBytes;
                for (let at = start; at < end; at += element.length)
                {
                    backing.bytes.set(element.subarray(0, Math.min(element.length, end - at)), at);
                }
                upload(resource, 0, LockFlags.NONE, null, { start, end });
                return;
            }
            const texel = clearTexel(desc.Format, values, float);
            if (texel && backing.texture && !backing.storable && backing.drawable
                && resource.dimension !== D3D10_RESOURCE_DIMENSION.TEXTURE3D)
            {
                // Cleared as a render target is: each slice by a pass's clear,
                // the value as the texel's floats or integers.
                const type = channelsOf(desc.Format)?.type;
                const integer = type === 'UINT' || type === 'SINT';
                const colour = [...texel].map(bits=>(integer ? bits | 0
                    : new Float32Array(new Uint32Array([bits]).buffer)[0]));
                for (let layer = view.range.first; layer < view.range.first + view.range.count;
                    layer++)
                {
                    throughTwins(()=>{
                        const target = layerTarget(resource, desc, view.range.mip, layer);
                        if (target?.twin)
                        {
                            useTwin(backing, target.twin, { mip: view.range.mip, levels: 1,
                                first: layer, count: 1 }, true, true);
                        }
                        return target;
                    }, target=>{
                        if (target)
                        {
                            backing.gpuDirty = true;
                            record({ kind: 'clear', target, color: colour });
                        }
                    });
                }
                return;
            }
            // Neither stored into nor drawn into here: the texel's bytes copied
            // into each slice, in their turn.
            const element = clearElement(desc.Format, values, float);
            if (element && backing.texture && !backing.storable
                && !backing.layout.storage?.conversion
                && element.length === TEXEL_BYTES[backing.layout.format])
            {
                const level = backing.layout.levels[view.range.mip];
                const bytesPerRow = roundUp(level.width * element.length, 256);
                const size = bytesPerRow * level.height;
                const staged = backend.createDynamicBuffer({ label: 'd3d10:uav-clear-texels',
                    size, usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST, keep: false });
                const lock = staged.lock(0, size, LockFlags.DISCARD);
                for (let row = 0; row < level.height; row++)
                {
                    for (let x = 0; x < level.width; x++)
                    {
                        lock.data.set(element, row * bytesPerRow + x * element.length);
                    }
                }
                staged.unlock(lock);
                staged.markRead();
                backing.gpuDirty = true;
                const last = view.range.first + view.range.count - 1;
                for (let layer = view.range.first; layer <= last; layer++)
                {
                    record({ kind: 'copyBufferToTexture', ids: [backing.id],
                        source: { buffer: staged.gpu, bytesPerRow, rowsPerImage: level.height },
                        destination: { texture: backing.texture, mipLevel: view.range.mip,
                            origin: { x: 0, y: 0, z: layer } },
                        size: { width: level.width, height: level.height, depthOrArrayLayers: 1 },
                        ...(layer === last ? { release: staged } : {}) });
                }
                return;
            }
            if (!texel || !backing.texture || !clearStorage(view, resource, backing, texel))
            {
                diverge(`a ${float ? 'Float' : 'Uint'} clear of a texture view in format`
                    + ` ${desc.Format} writes nothing`);
            }
        },

        /**
         * An append or counter view's hidden count, copied by the GPU into a
         * buffer at an offset.
         *
         * @param {any} destination @param {number} offset @param {any} view
         */
        copyStructureCount(destination, offset, view){
            if (!backend)
            {
                return;
            }
            // The count is a buffer of one word on the GPU, copied as any
            // buffer the GPU wrote is: into a buffer it keeps, or read back
            // into a staging one.
            const counted = { gpu: { gpu: counterOf(view), markRead(){} },
                bytes: new Uint8Array(4) };
            if (!gpuBufferCopy(destination, backingOf(destination), offset, counted, null))
            {
                diverge('a structure count copied to an unaligned offset is not copied');
            }
        },

        /**
         * @param {PipelineSnapshot} pipeline
         * @param {{ vertexCount: number, startVertex: number, instanceCount?: number,
         *           indexCount?: number, startIndex?: number, baseVertex?: number,
         *           startInstance?: number, indirect?: { buffer: any, offset: number },
         *           auto?: { gpu: any, offset: number } }} draw  `auto`: the arguments
         *     `DrawAuto` counted on the GPU
         */
        draw(pipeline, draw){
            if (!backend)
            {
                return;
            }
            twinUses = new Map();
            // A geometry shader runs, and streams out, whether or not the draw
            // then rasterizes anything (`geometry.js`); a vertex shader's
            // bytecode made one to stream out draws as if none were bound.
            const geometryShader = pipeline.stages.gs?.shader ?? null;
            /** @type {any} */
            let geometry = null;
            if (geometryShader)
            {
                // After the tessellator the geometry shader takes what the
                // domain shader makes of each index it wrote (`geometry.js`).
                const tessellated = pipeline.stages.hs?.shader || pipeline.stages.ds?.shader
                    || pipeline.topology >= FIRST_PATCH_LIST
                    ? tessellationOf().prepare(pipeline, draw) : undefined;
                if (tessellated === null)
                {
                    counters.skipped.stage++;
                    return;
                }
                geometry = geometryOf().prepare(pipeline, draw, tessellated);
                syncTwins(false);
                if (geometry)
                {
                    tessellated?.commands.forEach(record);
                }
                geometry?.commands.forEach(record);
                if (geometryShader.passThrough
                    ? geometryShader.rasterizedStream === SO_NO_RASTERIZED_STREAM
                    : !geometry?.drawn)
                {
                    return;
                }
            }
            const drawnGeometry = geometryShader && !geometryShader.passThrough
                ? geometry.drawn : null;
            /**
             * The draw into the targets' layer `layerPass` names, or into
             * their first where its primitives name none.
             *
             * Through the viewport `viewportPass` names where its primitives
             * name one, keeping theirs.
             *
             * @param {{ index: number, count: number } | null} layerPass
             * @param {{ index: number, count: number } | null} [viewportPass]
             */
            const rasterize = (layerPass, viewportPass = null)=>{
                // Every bound render target, by slot, and the depth target: the
                // first of them sizes the pass, and a draw with a depth target and
                // no colour one draws depth alone.
                let depth = targetAtLayer(pipeline.depthStencilView, layerPass?.index ?? 0);
                const bound = pipeline.renderTargets.map(view=>targetAtLayer(view,
                    layerPass?.index ?? 0));
                // With neither, a pixel shader that writes through views draws over
                // the viewport alone.
                const field = pipeline.viewports[0];
                if (!bound.some(entry=>entry) && !depth && field && field.Width > 0
                    && field.Height > 0 && (pipeline.pixelViews ?? []).some(view=>view))
                {
                    bound[0] = blindTarget(Math.min(16384, Math.ceil(field.TopLeftX + field.Width)),
                        Math.min(16384, Math.ceil(field.TopLeftY + field.Height)));
                }
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
                    lose('a render target of another size than the first is not drawn into:'
                        + ' the targets of a pass are one size');
                }
                while (colour.length > 0 && !colour[colour.length - 1])
                {
                    colour.pop();
                }
                // Direct3D draws where the targets and the depth buffer overlap,
                // whatever their sizes; WebGPU takes attachments of one size. A
                // depth buffer the draw neither tests nor writes is left out; one
                // it does is drawn with stand-ins of the depth buffer's size for
                // the colour targets, their overlap copied in and back out.
                /** @type {any[] | null} */
                let standIns = null;
                const first = colour.find(entry=>entry) ?? null;
                if (depth && first && (depth.surface.width !== first.surface.width
                    || depth.surface.height !== first.surface.height))
                {
                    const tests = pipeline.depthStencilState
                        ? stateDesc(pipeline.depthStencilState)
                        : DEFAULT_DEPTH_STENCIL;
                    if (!tests.DepthEnable && !tests.StencilEnable)
                    {
                        depth = null;
                    }
                    else if (first.sampleCount > 1)
                    {
                        lose('a multisampled draw with a depth buffer of another size than its'
                            + ' targets is skipped');
                        return;
                    }
                    else
                    {
                        standIns = colour.map((entry, slot)=>entry && standInOf(entry, slot,
                            /** @type {any} */ (depth)));
                    }
                }
                const target = (standIns ?? colour).find(entry=>entry) ?? null;
                const viewport = pipeline.viewports[viewportPass?.index ?? 0];
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
                // Through the tessellator: compute passes, then a draw of the
                // domain shader over what they made (`tessellation.js`).
                const tessellating = !drawnGeometry && (pipeline.stages.hs?.shader
                    || pipeline.stages.ds?.shader || pipeline.topology >= FIRST_PATCH_LIST);
                const tessellated = tessellating ? tessellationOf().prepare(pipeline, draw) : null;
                if (tessellating && !tessellated)
                {
                    counters.skipped.stage++;
                    return;
                }
                const topology = drawnGeometry ? drawnGeometry.topology
                    : tessellated ? tessellated.topology : TOPOLOGY[pipeline.topology];
                if (!topology)
                {
                    diverge(`primitive topology ${pipeline.topology} cannot be drawn`);
                    return;
                }
                const indexFormat = INDEX_FORMAT[pipeline.indexFormat] ?? null;
                const state = {
                    vertexShader: tessellated ? pipeline.stages.ds.shader
                        : pipeline.stages.vs.shader,
                    hullShader: tessellated ? pipeline.stages.hs.shader : null,
                    pixelShader: pipeline.stages.ps.shader,
                    // No layout feeds no attribute: the draw runs on what the
                    // vertex shader makes of its system values alone.
                    inputLayout: tessellated || drawnGeometry ? NO_INPUT_LAYOUT
                        : pipeline.inputLayout ?? NO_INPUT_LAYOUT,
                    blendState: pipeline.blendState,
                    depthStencilState: pipeline.depthStencilState,
                    rasterizerState: pipeline.rasterizerState,
                    topology,
                    targetFormats: colour.map(entry=>(entry ? entry.format : null)),
                    targetWriteMasks: colour.map(entry=>(entry ? entry.writeMask : 0)),
                    depthFormat: depth ? depth.format : null,
                    depthReadOnly: depth ? depth.readOnly : 0,
                    sampleMask: pipeline.sampleMask,
                    sampleCount: sizing.sampleCount,
                    strides: tessellated || drawnGeometry ? [] : pipeline.vertexStrides.slice(),
                    indexFormat: draw.indexCount === undefined || tessellated || drawnGeometry
                        ? null : indexFormat,
                    layerPass: layerPass ? `${layerPass.index}/${layerPass.count}` : '',
                    viewportPass: viewportPass
                        ? `${viewportPass.index}/${viewportPass.count}` : '',
                    // An indirect draw's first instance is on the GPU: its
                    // per-instance streams are read by the vertex stage from there.
                    indirect: !!draw.indirect && !tessellated && !drawnGeometry,
                    geometry: drawnGeometry ? { shader: geometryShader, gs: geometry.gs,
                        stage: geometry.stage, stream: drawnGeometry.stream } : null,
                    vsVariant: variantOf(tessellated ? pipeline.stages.ds : pipeline.stages.vs),
                    psVariant: variantOf(pipeline.stages.ps, pipeline.pixelViews ?? NO_VIEWS),
                    earlyDepth: '',
                };
                const early = !tessellated && !drawnGeometry && depth
                    ? earlyDepthOf(state, depth, pipeline) : null;
                if (early)
                {
                    depth = early.target;
                    state.depthReadOnly = early.target.readOnly;
                    state.earlyDepth = early.key;
                }
                const rasterizer = pipeline.rasterizerState
                    ? stateDesc(pipeline.rasterizerState)
                    : DEFAULT_RASTERIZER;
                const scissorRect = pipeline.scissorRects[viewportPass?.index ?? 0];
                // A viewport past the scissor rectangles set has an empty one.
                if (rasterizer.ScissorEnable && viewportPass && !scissorRect)
                {
                    return;
                }
                let scissor = rasterizer.ScissorEnable && scissorRect ? scissorRect : null;
                if (standIns && first && depth)
                {
                    // Nothing is drawn past the overlap, which is what is copied back.
                    const right = Math.min(first.surface.width, depth.surface.width);
                    const bottom = Math.min(first.surface.height, depth.surface.height);
                    scissor = scissor
                        ? { left: scissor.left, top: scissor.top,
                            right: Math.min(scissor.right, right),
                            bottom: Math.min(scissor.bottom, bottom) }
                        : { left: 0, top: 0, right, bottom };
                }
                const pulling = tessellated || drawnGeometry ? null
                    : vertexPullOf(state.inputLayout, state.strides, state.indirect,
                        state.vertexShader);
                const program = tessellated
                    ? linkDomain(translationOf(state.vertexShader, state.vsVariant),
                        state.vertexShader.container,
                        translationOf(state.pixelShader, state.psVariant),
                        pipeline.stages.hs.shader.container, tessellated.hull.stage)
                    : drawnGeometry
                        ? linkGeometryDraw(geometry.gs, geometry.stage, drawnGeometry.stream,
                            translationOf(state.pixelShader, state.psVariant))
                        : linkProgram(translationOf(state.vertexShader, state.vsVariant),
                            translationOf(state.pixelShader, state.psVariant),
                            pulling ? { vertexPull: pulling.pull } : {});
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
                // Counts the GPU reads from a buffer it wrote: the instances then
                // start where the arguments say, which needs the device feature
                // that lets them.
                const argumentBuffer = draw.indirect ? backingOf(draw.indirect.buffer) : null;
                argumentBuffer?.gpu.markRead();
                const asked = argumentBuffer
                    ? { gpu: argumentBuffer.gpu.gpu, offset: /** @type {any} */ (draw.indirect).offset }
                    : null;
                counters.draws++;
                for (const counter of occluding)
                {
                    if (!recordingCounters.has(counter))
                    {
                        recordingCounters.add(counter);
                        counter.outstanding++;
                    }
                }
                const copiedOut = standIns ? standInsIn(colour, standIns,
                    /** @type {any} */ (depth)) : null;
                // What the GPU draws into is newer there than the host's bytes.
                for (const drawn of [...colour, depth])
                {
                    if (drawn?.backing)
                    {
                        drawn.backing.gpuDirty = true;
                    }
                }
                const drawStage = tessellated ? pipeline.stages.ds : pipeline.stages.vs;
                reads = new Set();
                const groups = [
                    pulling
                        ? [...bindingsFor(drawStage, program.groups[0].filter(entry=>
                            entry.binding < BINDING.VERTEX_PULL)),
                        ...pulledBindings(pulling, pipeline, draw)]
                        : bindingsFor(drawStage, program.groups[0]),
                    [...bindingsFor(pipeline.stages.ps, program.groups[1],
                        pipeline.pixelViews ?? NO_VIEWS),
                    ...(early ? [{ binding: BINDING.EARLY_DEPTH, resource: early.view }] : [])],
                    ...(tessellated ? [tessellated.group] : []),
                    ...(drawnGeometry ? [drawnGeometry.group] : []),
                ];
                syncTwins(false);
                tessellated?.commands.forEach(record);
                if (!pulling)
                {
                    pulledFirst = [];
                }
                const indirect = asked && state.indirect
                    ? indirectOf(asked, draw.indexCount !== undefined) : asked ?? draw.auto ?? null;
                record({
                    kind: 'draw',
                    // Not drawn when a pass before it could not be built: its
                    // arguments would be whatever the buffer last held.
                    pipeline: tessellated || drawnGeometry
                        ? Promise.all([pipelineFor(state),
                            ...(tessellated ?? geometry).waits]).then(([one])=>one)
                        : pipelineFor(state),
                    target,
                    targets: standIns ?? colour,
                    depth,
                    groups,
                    reads: [...reads],
                    vertexBuffers: drawnGeometry ? [] : vertexBuffers,
                    indexBuffer: drawnGeometry ? drawnGeometry.indexBuffer
                        : indexBacking && indexBacking.gpu && indexFormat
                            ? { gpu: indexBacking.gpu.gpu, format: indexFormat,
                                offset: pipeline.indexOffset }
                            : null,
                    layout: state.inputLayout.elements,
                    viewport: {
                        x: cornerOf(viewport.TopLeftX),
                        y: cornerOf(viewport.TopLeftY),
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
                    vertexCount: tessellated || drawnGeometry ? 0 : draw.vertexCount,
                    startVertex: tessellated || drawnGeometry ? 0 : draw.startVertex,
                    instanceCount: tessellated || drawnGeometry ? 1 : draw.instanceCount ?? 1,
                    startInstance: tessellated || drawnGeometry ? 0 : draw.startInstance ?? 0,
                    stencilRef: pipeline.stencilRef,
                    blendFactor: [...pipeline.blendFactor],
                    occlusion: occluding.size > 0 ? [...occluding] : null,
                    indexCount: drawnGeometry ? 0 : tessellated ? null : draw.indexCount ?? null,
                    startIndex: drawnGeometry ? 0 : draw.startIndex ?? 0,
                    baseVertex: drawnGeometry ? 0 : draw.baseVertex ?? 0,
                    indirect: drawnGeometry ? drawnGeometry.args : tessellated ? tessellated.args
                        : indirect,
                });
                if (copiedOut)
                {
                    copiedOut.forEach(record);
                    lastStandIns = { copies: copiedOut,
                        key: copiedOut.map(copy=>copy.key).join('|') };
                }
                syncTwins(true);
                twinUses = new Map();
            };
            // Primitives a shader sends to layers of array targets are drawn
            // once a layer, each keeping its own (`linkProgram`'s `layerPass`).
            const rasterOutputs = (drawnGeometry ? geometryShader : pipeline.stages.ds?.shader
                ?? pipeline.stages.vs.shader)?.container?.outputs ?? [];
            const layers = rasterOutputs.some((/** @type {any} */ element)=>element.systemValue
                === SYSTEM_VALUE.RENDER_TARGET_ARRAY_INDEX) ? layersOf(pipeline) : 1;
            // And those it sends to viewports, once a viewport.
            const routed = rasterOutputs.some((/** @type {any} */ element)=>
                element.systemValue === SYSTEM_VALUE.VIEWPORT_ARRAY_INDEX);
            const viewports = routed ? Math.max(1, pipeline.viewports.length) : 1;
            for (let layer = 0; layer < layers; layer++)
            {
                for (let index = 0; index < viewports; index++)
                {
                    rasterize(layers > 1 ? { index: layer, count: layers } : null,
                        routed ? { index, count: viewports } : null);
                }
            }
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
            geometryPasses?.endFrame();
            const room = tessellation?.endFrame();
            if (room)
            {
                record(room);
            }
            const backing = backingOf(backBuffer);
            const own = backing.layout.format;
            const shown = CANVAS_FORMAT[own] ?? own;
            if (!backing.texture || (backing.sampleCount === 1 && shown === own))
            {
                return submit(backing.surface);
            }
            // A canvas takes no sRGB, ten-bit or multisampled frame: the back
            // buffer is resolved, copied or drawn into one it takes.
            const presented = presentedOf(backing, shown);
            if (backing.sampleCount === 1 && copyCompatible(own, shown))
            {
                record({
                    kind: 'copyTexture',
                    sourceId: backing.id,
                    destinationId: presented.id,
                    source: { texture: backing.texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
                    destination: { texture: presented.texture, mipLevel: 0,
                        origin: { x: 0, y: 0, z: 0 } },
                    size: { width: backing.surface.width, height: backing.surface.height,
                        depthOrArrayLayers: 1 },
                });
            }
            else
            {
                recordBlit(backing, presented, 0, 0, own, presented.written);
            }
            return submit(presented.surface);
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
            const read = viewFormatOf(from.layout.storage, format, formatOptions);
            const written = viewFormatOf(to.layout.storage, format, formatOptions);
            if (!read.format || read.reinterpreted || written.reinterpreted
                || read.format !== written.format || !resolvable(read.format))
            {
                lose(`a resolve in format ${format} is not made: the GPU views the two`
                    + ` textures as ${read.format ?? read.aspect} and`
                    + ` ${written.format ?? written.aspect}`);
                return;
            }
            const { level, slice } = subresourceOf(destination, destinationSubresource);
            recordBlit(from, to, level, slice, read.format);
        },

        /**
         * A counter the draws recorded from now on count their samples into,
         * or null without a GPU to count them.
         *
         * @returns {OcclusionCounter | null}
         */
        /**
         * Stream-output buffers are bound: each given an offset is filled to
         * it from here on, among the GPU's work in its turn.
         *
         * @param {readonly any[]} buffers @param {readonly number[]} offsets
         */
        streamTargets(buffers, offsets){
            if (!backend)
            {
                return;
            }
            const command = geometryOf().bind(buffers, offsets);
            if (command)
            {
                record(command);
            }
        },

        /**
         * `DrawAuto`: a draw of the vertices stream output last left in the
         * buffer at the first vertex slot, counted on the GPU.
         *
         * @param {any} pipeline the device's state
         */
        drawAuto(pipeline){
            if (!backend)
            {
                return;
            }
            const buffer = pipeline.vertexBuffers[0] ?? null;
            const made = buffer && pipeline.vertexStrides[0]
                ? geometryOf().autoArgs(buffer, pipeline.vertexStrides[0],
                    pipeline.vertexOffsets[0] ?? 0)
                : null;
            if (!made)
            {
                return;
            }
            record(made.command);
            this.draw(pipeline, { vertexCount: 0, startVertex: 0, auto: made.args });
        },

        /**
         * A read-back of the streams' statistics where this is recorded, for a
         * stream-output query: its `words` once the frame holding it is back,
         * null without a GPU.
         *
         * @returns {{ words: Uint32Array | null, failed: boolean } | null}
         */
        streamStatistics(){
            if (!backend)
            {
                return null;
            }
            const made = geometryOf().statistics();
            record(made.command);
            return made.mark;
        },

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

        /**
         * The GPU's copy of a texture's first subresource read back into its
         * own host bytes, for a caller that hands those bytes to the
         * processor: sent to the GPU now, and settled when the bytes are
         * there. Null when the host bytes are already what the GPU holds, or
         * the texture is one that cannot be read back.
         *
         * @param {any} resource
         * @returns {Promise<void> | null}
         */
        readBack(resource){
            if (!backend || !gpuWritten(resource))
            {
                return null;
            }
            const backing = backingOf(resource);
            if (!backing.texture || !readable(backing))
            {
                return null;
            }
            const level = backing.layout.levels[0];
            const texel = programTexel(backing);
            /** @type {() => void} */
            let arrive = ()=>{};
            const arrived = new Promise(done=>{
                arrive = ()=>done(undefined);
            });
            let delivered = false;
            record({
                kind: 'readback',
                sourceId: backing.id,
                surface: {
                    texture: backing.texture, mipLevel: 0, layer: 0,
                    width: level.width, height: level.height,
                    bytesPerTexel: TEXEL_BYTES[backing.layout.storage.format],
                },
                deliver: asProgramTexels(backing, image=>{
                    if (delivered)
                    {
                        return;
                    }
                    delivered = true;
                    if (image)
                    {
                        const into = subresourceBytes(resource, 0);
                        for (let row = 0; row < level.height; row++)
                        {
                            const start = row * image.width * texel;
                            into.bytes.set(image.data.subarray(start, start + level.width * texel),
                                row * into.rowPitch);
                        }
                    }
                    else
                    {
                        diverge('a read back that did not arrive leaves the pixels a device'
                            + ' context is opened over as they were');
                    }
                    arrive();
                }),
            });
            this.flush();
            return arrived;
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
                dispatches: counters.dispatches,
                skipped: { ...counters.skipped },
                failures: [...counters.failures],
                pipelines: pipelines.size,
                tessellation: tessellation ? tessellation.diagnostics() : null,
                geometry: geometryPasses ? geometryPasses.diagnostics() : null,
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
            divergence?.('Direct3D 10', `lost a frame: ${failure && failure.message || failure}`,
                'loss');
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
                if (command.kind === 'readback' || command.kind === 'readbackBuffer')
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
            // A clear still waiting for a depth buffer this pass attaches
            // read-only is made first, by a pass of the depth buffer alone.
            const waiting = depth?.readOnly ? pendingClears.get(depth.key) : undefined;
            if (waiting?.target && !waiting.color && !waiting.target.readOnly)
            {
                closePass();
                passFor([], waiting.target);
                closePass();
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
            // A read-only aspect is attached as one, which WebGPU gives no
            // load or store: a clear still waiting for it cannot be made.
            const readOnlyDepth = depth ? (depth.readOnly & D3D11_DSV_FLAG.READ_ONLY_DEPTH) !== 0
                : false;
            const readOnlyStencil = depth
                ? (depth.readOnly & D3D11_DSV_FLAG.READ_ONLY_STENCIL) !== 0 : false;
            if (depthClear && ((readOnlyDepth && (depthClear.flags & D3D10_CLEAR.DEPTH))
                || (readOnlyStencil && (depthClear.flags & D3D10_CLEAR.STENCIL))))
            {
                lose('a clear of a depth buffer drawn through a read-only view is not made');
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
                            ...(readOnlyDepth ? { depthReadOnly: true } : {
                                depthLoadOp: depthClear && (depthClear.flags & D3D10_CLEAR.DEPTH)
                                    ? 'clear'
                                    : 'load',
                                depthStoreOp: 'store',
                                depthClearValue: depthClear ? depthClear.depth : 1,
                            }),
                            ...(depth.format.endsWith('stencil8') && readOnlyStencil
                                ? { stencilReadOnly: true } : {}),
                            ...(depth.format.endsWith('stencil8') && !readOnlyStencil
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
                if (key.startsWith(`${id}:`) && clear.target)
                {
                    // A depth clear is made by a pass over the depth alone.
                    closePass();
                    passFor(clear.color ? [clear.target] : [], clear.color ? null : clear.target);
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
                if (command.kind === 'readbackBuffer')
                {
                    closePass();
                    readers.push({ read: frame.copyOut(command.ranges), command });
                    continue;
                }
                if (command.kind === 'reinterpret')
                {
                    command.ids.forEach(settleClears);
                    frame.copyThroughBuffer(command.source, command.destination, command.size,
                        command.texelBytes);
                    continue;
                }
                if (command.kind === 'texelWords')
                {
                    command.ids.forEach(settleClears);
                    if (command.toBuffer)
                    {
                        frame.copyTextureToBuffer(command.texture, command.buffer, command.size);
                    }
                    else
                    {
                        frame.encodeCopy(command.buffer, command.texture, command.size);
                    }
                    continue;
                }
                if (command.kind === 'copyBufferToTexture')
                {
                    command.ids.forEach(settleClears);
                    frame.encodeCopy(command.source, command.destination, command.size);
                    continue;
                }
                if (command.kind === 'copyBuffer')
                {
                    closePass();
                    frame.copyBuffer(command.source, command.sourceOffset, command.destination,
                        command.destinationOffset, command.size);
                    continue;
                }
                if (command.kind === 'dispatch')
                {
                    command.ids.forEach(settleClears);
                    // The backend ends the open render pass for the compute
                    // one: the next draw opens another.
                    closePass();
                    const built = pipelinesNeeded[position];
                    if (built.status === 'rejected')
                    {
                        counters.skipped[built.reason?.untranslatable ? 'untranslatable'
                            : 'pipeline']++;
                        lose(`${command.what}: ${built.reason && built.reason.message
                            || built.reason}`);
                        continue;
                    }
                    frame.dispatch(command.groups
                        ? { pipeline: built.value.gpu, grid: command.grid, label: command.label,
                            groups: built.value.layouts.map((/** @type {any} */ layout,
                                /** @type {number} */ index)=>({ layout,
                                entries: command.groups[index] })) }
                        : { pipeline: built.value.gpu, layout: built.value.layout,
                            entries: command.entries, grid: command.grid, label: 'd3d10:cs' });
                    continue;
                }
                if (command.kind === 'depthWrite')
                {
                    command.ids.forEach(settleClears);
                    const built = pipelinesNeeded[position];
                    if (built.status === 'rejected')
                    {
                        lose(`${command.what}: ${built.reason && built.reason.message
                            || built.reason}`);
                        continue;
                    }
                    const drawn = frame.beginPass({ targets: [], clearValues: [],
                        depthTarget: command.surface,
                        depthStencilAttachment: {
                            view: command.view, depthLoadOp: 'load', depthStoreOp: 'store',
                            ...(command.stencil ? { stencilLoadOp: 'clear', stencilStoreOp: 'store',
                                stencilClearValue: 0 } : {}),
                        } });
                    drawn.setPipeline(built.value.depth);
                    drawn.setBindings(0, built.value.layout, command.entries, 'd3d10:depth-write');
                    drawn.draw(3, 1, 0, 0);
                    if (built.value.bits.length > 0)
                    {
                        drawn.setStencilReference(0xff);
                        for (const pipeline of built.value.bits)
                        {
                            drawn.setPipeline(pipeline);
                            drawn.setBindings(0, built.value.layout, command.entries,
                                'd3d10:depth-write');
                            drawn.draw(3, 1, 0, 0);
                        }
                    }
                    closePass();
                    continue;
                }
                if (command.kind === 'blit')
                {
                    command.ids.forEach(settleClears);
                    const built = pipelinesNeeded[position];
                    if (built.status === 'rejected')
                    {
                        lose(`${command.what}: ${built.reason && built.reason.message
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
                        target: command.target,
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
                // A texture the draw reads that a clear still waits on is
                // cleared first: the clear meets no pass of the draw's.
                for (const id of command.reads ?? [])
                {
                    if ([...pendingClears.keys()].some(key=>key.startsWith(`${id}:`)))
                    {
                        settleClears(id);
                    }
                }
                const settled = pipelinesNeeded[position];
                if (settled.status === 'rejected')
                {
                    counters.skipped[settled.reason?.untranslatable
                        ? 'untranslatable'
                        : 'pipeline']++;
                    lose(`a draw was skipped: ${settled.reason && settled.reason.message
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
                            `d3d10:${['vs', 'ps', 'ds'][index]}`);
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
                    const instanced = pipeline.steps[index] === 'instance';
                    if (buffer)
                    {
                        // SV_InstanceID counts from zero whatever the first
                        // instance, where WebGPU's instance index counts from
                        // it: the per-instance streams start there instead.
                        const skipped = instanced ? command.startInstance * buffer.stride : 0;
                        current.setVertexBuffer(index, buffer.gpu, buffer.offset + skipped);
                        return;
                    }
                    // A slot the layout reads and nothing is bound to reads
                    // zeros in Direct3D; WebGPU refuses the frame over a slot
                    // left empty, so zeros enough for every element the draw
                    // reads are bound there.
                    const stride = pipeline.strides[index] ?? 0;
                    const elements = instanced ? command.instanceCount
                        : command.indexCount === null ? command.startVertex + command.vertexCount
                            : 0;
                    current.setVertexBuffer(index,
                        zeroVertices(stride * elements + UNBOUND_ATTRIBUTE_BYTES), 0);
                });
                if (command.indexCount !== null)
                {
                    if (!command.indexBuffer)
                    {
                        lose('an indexed draw with no index buffer is skipped');
                        continue;
                    }
                    current.setIndexBuffer(command.indexBuffer.gpu, command.indexBuffer.format,
                        command.indexBuffer.offset);
                }
                const slot = command.occlusion ? current.beginOcclusionQuery() : null;
                if (command.indirect)
                {
                    current.drawIndirect(command.indirect.gpu, command.indirect.offset,
                        command.indexCount !== null);
                }
                else if (command.indexCount !== null)
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
            for (const command of recorded)
            {
                if (command.release)
                {
                    backend.releaseDynamicBuffer(command.release);
                }
            }
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

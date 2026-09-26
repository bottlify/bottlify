/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DXGI formats as the GPU backend spells them.
 *
 * Two tables, because a format means two different things: what a texture's
 * texels are, and what a vertex attribute's bytes are. WebGPU names the two
 * differently and supports different subsets of each, so a DXGI format can be
 * a texture format with no vertex spelling (block-compressed) or a vertex
 * format with no texture spelling (three-component floats). A format absent
 * from a table is one this backend cannot honour in that role, and the caller
 * says so rather than picking a neighbour.
 */

import { DXGI_FORMAT } from './constants.js';

/**
 * The formats a texture can be kept in as it is. A block-compressed format is
 * here only through `COMPRESSED_FORMAT`, because whether the GPU samples it is
 * the adapter's to say.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const TEXTURE_FORMAT = Object.freeze({
    [DXGI_FORMAT.R32G32B32A32_FLOAT]: 'rgba32float',
    [DXGI_FORMAT.R32G32B32A32_UINT]: 'rgba32uint',
    [DXGI_FORMAT.R32G32B32A32_SINT]: 'rgba32sint',
    [DXGI_FORMAT.R16G16B16A16_FLOAT]: 'rgba16float',
    [DXGI_FORMAT.R16G16B16A16_UNORM]: 'rgba16unorm',
    [DXGI_FORMAT.R16G16B16A16_UINT]: 'rgba16uint',
    [DXGI_FORMAT.R16G16B16A16_SINT]: 'rgba16sint',
    [DXGI_FORMAT.R32G32_FLOAT]: 'rg32float',
    [DXGI_FORMAT.R32G32_UINT]: 'rg32uint',
    [DXGI_FORMAT.R32G32_SINT]: 'rg32sint',
    [DXGI_FORMAT.R10G10B10A2_UNORM]: 'rgb10a2unorm',
    [DXGI_FORMAT.R10G10B10A2_UINT]: 'rgb10a2uint',
    [DXGI_FORMAT.R11G11B10_FLOAT]: 'rg11b10ufloat',
    [DXGI_FORMAT.R8G8B8A8_UNORM]: 'rgba8unorm',
    [DXGI_FORMAT.R8G8B8A8_UNORM_SRGB]: 'rgba8unorm-srgb',
    [DXGI_FORMAT.R8G8B8A8_UINT]: 'rgba8uint',
    [DXGI_FORMAT.R8G8B8A8_SNORM]: 'rgba8snorm',
    [DXGI_FORMAT.R8G8B8A8_SINT]: 'rgba8sint',
    [DXGI_FORMAT.R16G16_FLOAT]: 'rg16float',
    [DXGI_FORMAT.R16G16_UNORM]: 'rg16unorm',
    [DXGI_FORMAT.R16G16_UINT]: 'rg16uint',
    [DXGI_FORMAT.R16G16_SNORM]: 'rg16snorm',
    [DXGI_FORMAT.R16G16_SINT]: 'rg16sint',
    [DXGI_FORMAT.D32_FLOAT]: 'depth32float',
    [DXGI_FORMAT.R32_FLOAT]: 'r32float',
    [DXGI_FORMAT.R32_UINT]: 'r32uint',
    [DXGI_FORMAT.R32_SINT]: 'r32sint',
    [DXGI_FORMAT.D24_UNORM_S8_UINT]: 'depth24plus-stencil8',
    [DXGI_FORMAT.D32_FLOAT_S8X24_UINT]: 'depth32float-stencil8',
    [DXGI_FORMAT.R8G8_UNORM]: 'rg8unorm',
    [DXGI_FORMAT.R8G8_UINT]: 'rg8uint',
    [DXGI_FORMAT.R8G8_SNORM]: 'rg8snorm',
    [DXGI_FORMAT.R8G8_SINT]: 'rg8sint',
    [DXGI_FORMAT.R16_FLOAT]: 'r16float',
    [DXGI_FORMAT.D16_UNORM]: 'depth16unorm',
    [DXGI_FORMAT.R16_UNORM]: 'r16unorm',
    [DXGI_FORMAT.R16_UINT]: 'r16uint',
    [DXGI_FORMAT.R16_SINT]: 'r16sint',
    [DXGI_FORMAT.R8_UNORM]: 'r8unorm',
    [DXGI_FORMAT.R8_UINT]: 'r8uint',
    [DXGI_FORMAT.R8_SNORM]: 'r8snorm',
    [DXGI_FORMAT.R8_SINT]: 'r8sint',
    [DXGI_FORMAT.R9G9B9E5_SHAREDEXP]: 'rgb9e5ufloat',
    [DXGI_FORMAT.B8G8R8A8_UNORM]: 'bgra8unorm',
    [DXGI_FORMAT.B8G8R8A8_UNORM_SRGB]: 'bgra8unorm-srgb',
    [DXGI_FORMAT.B8G8R8X8_UNORM]: 'bgra8unorm',
    [DXGI_FORMAT.B8G8R8X8_UNORM_SRGB]: 'bgra8unorm-srgb',
});

/**
 * The block-compressed formats as a GPU with BC sampling keeps them, and what
 * one without it is sent instead: the blocks decoded on the processor.
 *
 * @type {Readonly<Record<number, { format: string, decoded: string,
 *     conversion: import('./blocks.js').Conversion }>>}
 */
export const COMPRESSED_FORMAT = Object.freeze({
    [DXGI_FORMAT.BC1_UNORM]: { format: 'bc1-rgba-unorm', decoded: 'rgba8unorm', conversion: 'bc1' },
    [DXGI_FORMAT.BC1_UNORM_SRGB]: {
        format: 'bc1-rgba-unorm-srgb', decoded: 'rgba8unorm-srgb', conversion: 'bc1',
    },
    [DXGI_FORMAT.BC2_UNORM]: { format: 'bc2-rgba-unorm', decoded: 'rgba8unorm', conversion: 'bc2' },
    [DXGI_FORMAT.BC2_UNORM_SRGB]: {
        format: 'bc2-rgba-unorm-srgb', decoded: 'rgba8unorm-srgb', conversion: 'bc2',
    },
    [DXGI_FORMAT.BC3_UNORM]: { format: 'bc3-rgba-unorm', decoded: 'rgba8unorm', conversion: 'bc3' },
    [DXGI_FORMAT.BC3_UNORM_SRGB]: {
        format: 'bc3-rgba-unorm-srgb', decoded: 'rgba8unorm-srgb', conversion: 'bc3',
    },
    [DXGI_FORMAT.BC4_UNORM]: { format: 'bc4-r-unorm', decoded: 'r8unorm', conversion: 'bc4u' },
    [DXGI_FORMAT.BC4_SNORM]: { format: 'bc4-r-snorm', decoded: 'r8snorm', conversion: 'bc4s' },
    [DXGI_FORMAT.BC5_UNORM]: { format: 'bc5-rg-unorm', decoded: 'rg8unorm', conversion: 'bc5u' },
    [DXGI_FORMAT.BC5_SNORM]: { format: 'bc5-rg-snorm', decoded: 'rg8snorm', conversion: 'bc5s' },
});

/**
 * Bytes per texel of the uncompressed texture formats above.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const TEXEL_BYTES = Object.freeze({
    rgba32float: 16,
    rgba32uint: 16,
    rgba32sint: 16,
    rgba16float: 8,
    rgba16unorm: 8,
    rgba16uint: 8,
    rgba16sint: 8,
    rg32float: 8,
    rg32uint: 8,
    rg32sint: 8,
    rgb10a2unorm: 4,
    rgb10a2uint: 4,
    rg11b10ufloat: 4,
    rgb9e5ufloat: 4,
    rgba8unorm: 4,
    'rgba8unorm-srgb': 4,
    rgba8uint: 4,
    rgba8snorm: 4,
    rgba8sint: 4,
    rg16float: 4,
    rg16unorm: 4,
    rg16uint: 4,
    rg16snorm: 4,
    rg16sint: 4,
    depth32float: 4,
    r32float: 4,
    r32uint: 4,
    r32sint: 4,
    'depth24plus-stencil8': 4,
    'depth32float-stencil8': 8,
    rg8unorm: 2,
    rg8uint: 2,
    rg8snorm: 2,
    rg8sint: 2,
    r16float: 2,
    depth16unorm: 2,
    r16unorm: 2,
    r16uint: 2,
    r16sint: 2,
    r8unorm: 1,
    r8uint: 1,
    r8snorm: 1,
    r8sint: 1,
    bgra8unorm: 4,
    'bgra8unorm-srgb': 4,
});

/**
 * The format a family keeps its typeless resources in when nothing binds them
 * as a depth stencil: the member a view most often names, so the view that
 * has to reinterpret is the rare one.
 *
 * @type {Readonly<Record<number, number>>}
 */
const TYPELESS_STORAGE = Object.freeze({
    [DXGI_FORMAT.R32G32B32A32_TYPELESS]: DXGI_FORMAT.R32G32B32A32_FLOAT,
    [DXGI_FORMAT.R16G16B16A16_TYPELESS]: DXGI_FORMAT.R16G16B16A16_FLOAT,
    [DXGI_FORMAT.R32G32_TYPELESS]: DXGI_FORMAT.R32G32_FLOAT,
    [DXGI_FORMAT.R10G10B10A2_TYPELESS]: DXGI_FORMAT.R10G10B10A2_UNORM,
    [DXGI_FORMAT.R8G8B8A8_TYPELESS]: DXGI_FORMAT.R8G8B8A8_UNORM,
    [DXGI_FORMAT.R16G16_TYPELESS]: DXGI_FORMAT.R16G16_FLOAT,
    [DXGI_FORMAT.R32_TYPELESS]: DXGI_FORMAT.R32_FLOAT,
    [DXGI_FORMAT.R8G8_TYPELESS]: DXGI_FORMAT.R8G8_UNORM,
    [DXGI_FORMAT.R16_TYPELESS]: DXGI_FORMAT.R16_FLOAT,
    [DXGI_FORMAT.R8_TYPELESS]: DXGI_FORMAT.R8_UNORM,
    [DXGI_FORMAT.BC1_TYPELESS]: DXGI_FORMAT.BC1_UNORM,
    [DXGI_FORMAT.BC2_TYPELESS]: DXGI_FORMAT.BC2_UNORM,
    [DXGI_FORMAT.BC3_TYPELESS]: DXGI_FORMAT.BC3_UNORM,
    [DXGI_FORMAT.BC4_TYPELESS]: DXGI_FORMAT.BC4_UNORM,
    [DXGI_FORMAT.BC5_TYPELESS]: DXGI_FORMAT.BC5_UNORM,
    [DXGI_FORMAT.B8G8R8A8_TYPELESS]: DXGI_FORMAT.B8G8R8A8_UNORM,
    [DXGI_FORMAT.B8G8R8X8_TYPELESS]: DXGI_FORMAT.B8G8R8X8_UNORM,
});

/**
 * The depth format each depth-capable family is stored in when bound as one.
 *
 * @type {Readonly<Record<number, number>>}
 */
const DEPTH_STORAGE = Object.freeze({
    [DXGI_FORMAT.R32G8X24_TYPELESS]: DXGI_FORMAT.D32_FLOAT_S8X24_UINT,
    [DXGI_FORMAT.R32_TYPELESS]: DXGI_FORMAT.D32_FLOAT,
    [DXGI_FORMAT.R24G8_TYPELESS]: DXGI_FORMAT.D24_UNORM_S8_UINT,
    [DXGI_FORMAT.R16_TYPELESS]: DXGI_FORMAT.D16_UNORM,
});

/**
 * The views of a depth format that read its depth, and those that read its
 * stencil.
 *
 * @type {Readonly<Record<number, string>>}
 */
const DEPTH_ASPECT = Object.freeze({
    [DXGI_FORMAT.R32_FLOAT_X8X24_TYPELESS]: 'depth-only',
    [DXGI_FORMAT.X32_TYPELESS_G8X24_UINT]: 'stencil-only',
    [DXGI_FORMAT.R32_FLOAT]: 'depth-only',
    [DXGI_FORMAT.R24_UNORM_X8_TYPELESS]: 'depth-only',
    [DXGI_FORMAT.X24_TYPELESS_G8_UINT]: 'stencil-only',
    [DXGI_FORMAT.R16_UNORM]: 'depth-only',
});

/** D3D10_BIND_DEPTH_STENCIL, the one bind flag that changes how a texture is kept. */
const BIND_DEPTH_STENCIL = 0x40;

/**
 * @typedef {Object} TextureStorage
 * @property {string} format          What the GPU texture is.
 * @property {string[]} viewFormats   What else a view of it may be.
 * @property {import('./blocks.js').Conversion | null} conversion
 *           How the program's bytes become the texture's, or null for as they are.
 * @property {boolean} depth          A depth format: a draw writes it, an upload cannot.
 */

/**
 * @param {string} format
 * @returns {string | null} the format's sRGB twin, or its linear one
 */
function srgbTwin(format){
    const suffix = '-srgb';
    if (format.endsWith(suffix))
    {
        return format.slice(0, format.length - suffix.length);
    }
    return TEXEL_BYTES[format + suffix] || format.startsWith('bc') ? format + suffix : null;
}

/**
 * What a resource of this format is kept in on the GPU.
 *
 * A typed format is kept as itself. A typeless one is kept as the member of
 * its family a view most often names, or as the family's depth format when it
 * is bound as a depth stencil -- which is what lets a shadow map be written
 * through one view and sampled through another. A typeless texture whose
 * storage has an sRGB twin may be viewed as either, the one cast WebGPU
 * allows.
 *
 * @param {number} dxgiFormat
 * @param {number} bindFlags
 * @param {{ compressed?: boolean }} [options]  Whether the GPU samples BC blocks.
 * @returns {TextureStorage | null} null for a format the GPU has no way to hold
 */
export function textureStorage(dxgiFormat, bindFlags, options = {}){
    const depthFormat = (bindFlags & BIND_DEPTH_STENCIL) !== 0
        ? DEPTH_STORAGE[dxgiFormat]
        : undefined;
    const typed = depthFormat ?? TYPELESS_STORAGE[dxgiFormat] ?? dxgiFormat;
    /**
     * @param {string} format
     * @param {import('./blocks.js').Conversion | null} conversion
     * @returns {TextureStorage}
     */
    const kept = (format, conversion)=>{
        const twin = typed !== dxgiFormat && !isDepthFormat(format) ? srgbTwin(format) : null;
        return {
            format,
            viewFormats: twin ? [twin] : [],
            conversion,
            depth: isDepthFormat(format),
        };
    };
    if (typed === DXGI_FORMAT.A8_UNORM)
    {
        return kept('rgba8unorm', 'a8');
    }
    const compressed = COMPRESSED_FORMAT[typed];
    if (compressed)
    {
        return options.compressed
            ? kept(compressed.format, null)
            : kept(compressed.decoded, compressed.conversion);
    }
    const format = TEXTURE_FORMAT[typed];
    return format ? kept(format, null) : null;
}

/**
 * Whether WebGPU copies texels between textures of these two formats: the
 * same format, or the two halves of an sRGB pair.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function copyCompatible(a, b){
    const linear = (/** @type {string} */ format)=>format.replace(/-srgb$/, '');
    return linear(a) === linear(b);
}

/**
 * The GPU view a Direct3D view of a resource kept in `storage` is: its
 * format, or the aspect of a depth format it reads. A view the GPU cannot
 * express -- a cast between types WebGPU does not alias -- is the storage's
 * own format, and says so.
 *
 * @param {TextureStorage} storage
 * @param {number} viewFormat  The DXGI format the view names.
 * @param {{ compressed?: boolean }} [options]
 * @returns {{ format?: string, aspect?: string, reinterpreted: boolean }}
 */
export function viewFormatOf(storage, viewFormat, options = {}){
    if (storage.depth)
    {
        const aspect = DEPTH_ASPECT[viewFormat];
        return aspect
            ? { aspect, reinterpreted: false }
            : { format: storage.format, reinterpreted: false };
    }
    const own = textureStorage(viewFormat, 0, options);
    if (own && (own.format === storage.format || storage.viewFormats.includes(own.format)))
    {
        return { format: own.format, reinterpreted: false };
    }
    return { format: storage.format, reinterpreted: true };
}

/** @param {string} format @returns {boolean} whether the format is a depth one */
export const isDepthFormat = format=>format.startsWith('depth');

/** @type {Readonly<Record<number, string>>} */
export const VERTEX_FORMAT = Object.freeze({
    [DXGI_FORMAT.R32G32B32A32_FLOAT]: 'float32x4',
    [DXGI_FORMAT.R32G32B32A32_UINT]: 'uint32x4',
    [DXGI_FORMAT.R32G32B32A32_SINT]: 'sint32x4',
    [DXGI_FORMAT.R32G32B32_FLOAT]: 'float32x3',
    [DXGI_FORMAT.R32G32B32_UINT]: 'uint32x3',
    [DXGI_FORMAT.R32G32B32_SINT]: 'sint32x3',
    [DXGI_FORMAT.R16G16B16A16_FLOAT]: 'float16x4',
    [DXGI_FORMAT.R16G16B16A16_UNORM]: 'unorm16x4',
    [DXGI_FORMAT.R16G16B16A16_UINT]: 'uint16x4',
    [DXGI_FORMAT.R16G16B16A16_SNORM]: 'snorm16x4',
    [DXGI_FORMAT.R16G16B16A16_SINT]: 'sint16x4',
    [DXGI_FORMAT.R32G32_FLOAT]: 'float32x2',
    [DXGI_FORMAT.R32G32_UINT]: 'uint32x2',
    [DXGI_FORMAT.R32G32_SINT]: 'sint32x2',
    [DXGI_FORMAT.R8G8B8A8_UNORM]: 'unorm8x4',
    [DXGI_FORMAT.R8G8B8A8_UINT]: 'uint8x4',
    [DXGI_FORMAT.R8G8B8A8_SNORM]: 'snorm8x4',
    [DXGI_FORMAT.R8G8B8A8_SINT]: 'sint8x4',
    [DXGI_FORMAT.R16G16_FLOAT]: 'float16x2',
    [DXGI_FORMAT.R16G16_UNORM]: 'unorm16x2',
    [DXGI_FORMAT.R16G16_UINT]: 'uint16x2',
    [DXGI_FORMAT.R16G16_SNORM]: 'snorm16x2',
    [DXGI_FORMAT.R16G16_SINT]: 'sint16x2',
    [DXGI_FORMAT.R32_FLOAT]: 'float32',
    [DXGI_FORMAT.R32_UINT]: 'uint32',
    [DXGI_FORMAT.R32_SINT]: 'sint32',
    [DXGI_FORMAT.R8G8_UNORM]: 'unorm8x2',
    [DXGI_FORMAT.R8G8_UINT]: 'uint8x2',
    [DXGI_FORMAT.R8G8_SNORM]: 'snorm8x2',
    [DXGI_FORMAT.R8G8_SINT]: 'sint8x2',
    [DXGI_FORMAT.R10G10B10A2_UNORM]: 'unorm10-10-10-2',
    [DXGI_FORMAT.R16_FLOAT]: 'float16',
    [DXGI_FORMAT.R16_UNORM]: 'unorm16',
    [DXGI_FORMAT.R16_UINT]: 'uint16',
    [DXGI_FORMAT.R16_SNORM]: 'snorm16',
    [DXGI_FORMAT.R16_SINT]: 'sint16',
    [DXGI_FORMAT.R8_UNORM]: 'unorm8',
    [DXGI_FORMAT.R8_UINT]: 'uint8',
    [DXGI_FORMAT.R8_SNORM]: 'snorm8',
    [DXGI_FORMAT.R8_SINT]: 'sint8',
    [DXGI_FORMAT.B8G8R8A8_UNORM]: 'unorm8x4-bgra',
});

/**
 * How many bytes a vertex attribute of each format occupies, for the
 * append-aligned offset rule.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const VERTEX_FORMAT_BYTES = Object.freeze({
    float32x4: 16,
    uint32x4: 16,
    sint32x4: 16,
    float32x3: 12,
    uint32x3: 12,
    sint32x3: 12,
    float16x4: 8,
    unorm16x4: 8,
    uint16x4: 8,
    snorm16x4: 8,
    sint16x4: 8,
    float32x2: 8,
    uint32x2: 8,
    sint32x2: 8,
    unorm8x4: 4,
    uint8x4: 4,
    snorm8x4: 4,
    sint8x4: 4,
    float16x2: 4,
    unorm16x2: 4,
    uint16x2: 4,
    snorm16x2: 4,
    sint16x2: 4,
    float32: 4,
    uint32: 4,
    sint32: 4,
    unorm8x2: 2,
    uint8x2: 2,
    snorm8x2: 2,
    sint8x2: 2,
    'unorm10-10-10-2': 4,
    float16: 2,
    unorm16: 2,
    uint16: 2,
    snorm16: 2,
    sint16: 2,
    unorm8: 1,
    uint8: 1,
    snorm8: 1,
    sint8: 1,
    'unorm8x4-bgra': 4,
});

/** @type {Readonly<Record<number, string>>} */
export const INDEX_FORMAT = Object.freeze({
    [DXGI_FORMAT.R16_UINT]: 'uint16',
    [DXGI_FORMAT.R32_UINT]: 'uint32',
});

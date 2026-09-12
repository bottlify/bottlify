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

/** @type {Readonly<Record<number, string>>} */
export const TEXTURE_FORMAT = Object.freeze({
    [DXGI_FORMAT.R32G32B32A32_FLOAT]: 'rgba32float',
    [DXGI_FORMAT.R32G32B32A32_UINT]: 'rgba32uint',
    [DXGI_FORMAT.R32G32B32A32_SINT]: 'rgba32sint',
    [DXGI_FORMAT.R16G16B16A16_FLOAT]: 'rgba16float',
    [DXGI_FORMAT.R16G16B16A16_UNORM]: 'rgba16unorm',
    [DXGI_FORMAT.R10G10B10A2_UNORM]: 'rgb10a2unorm',
    [DXGI_FORMAT.R8G8B8A8_UNORM]: 'rgba8unorm',
    [DXGI_FORMAT.R8G8B8A8_UNORM_SRGB]: 'rgba8unorm-srgb',
    [DXGI_FORMAT.R8G8B8A8_UINT]: 'rgba8uint',
    [DXGI_FORMAT.R8G8B8A8_SNORM]: 'rgba8snorm',
    [DXGI_FORMAT.R8G8B8A8_SINT]: 'rgba8sint',
    [DXGI_FORMAT.R16G16_UNORM]: 'rg16unorm',
    [DXGI_FORMAT.R16G16_SNORM]: 'rg16snorm',
    [DXGI_FORMAT.D32_FLOAT]: 'depth32float',
    [DXGI_FORMAT.R32_FLOAT]: 'r32float',
    [DXGI_FORMAT.R32_UINT]: 'r32uint',
    [DXGI_FORMAT.R32_SINT]: 'r32sint',
    [DXGI_FORMAT.D24_UNORM_S8_UINT]: 'depth24plus-stencil8',
    [DXGI_FORMAT.D32_FLOAT_S8X24_UINT]: 'depth32float-stencil8',
    [DXGI_FORMAT.R8G8_UNORM]: 'rg8unorm',
    [DXGI_FORMAT.R8G8_SNORM]: 'rg8snorm',
    [DXGI_FORMAT.R16_FLOAT]: 'r16float',
    [DXGI_FORMAT.D16_UNORM]: 'depth16unorm',
    [DXGI_FORMAT.R16_UNORM]: 'r16unorm',
    [DXGI_FORMAT.R16_UINT]: 'r16uint',
    [DXGI_FORMAT.R16_SINT]: 'r16sint',
    [DXGI_FORMAT.R8_UNORM]: 'r8unorm',
    [DXGI_FORMAT.B8G8R8A8_UNORM]: 'bgra8unorm',
    [DXGI_FORMAT.B8G8R8X8_UNORM]: 'bgra8unorm',
});

/**
 * Bytes per texel of the texture formats above, for laying a subresource out.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const TEXEL_BYTES = Object.freeze({
    rgba32float: 16,
    rgba32uint: 16,
    rgba32sint: 16,
    rgba16float: 8,
    rgba16unorm: 8,
    rgb10a2unorm: 4,
    rgba8unorm: 4,
    'rgba8unorm-srgb': 4,
    rgba8uint: 4,
    rgba8snorm: 4,
    rgba8sint: 4,
    rg16unorm: 4,
    rg16snorm: 4,
    depth32float: 4,
    r32float: 4,
    r32uint: 4,
    r32sint: 4,
    'depth24plus-stencil8': 4,
    'depth32float-stencil8': 8,
    rg8unorm: 2,
    rg8snorm: 2,
    r16float: 2,
    depth16unorm: 2,
    r16unorm: 2,
    r16uint: 2,
    r16sint: 2,
    r8unorm: 1,
    bgra8unorm: 4,
});

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
});

/** @type {Readonly<Record<number, string>>} */
export const INDEX_FORMAT = Object.freeze({
    [DXGI_FORMAT.R16_UINT]: 'uint16',
    [DXGI_FORMAT.R32_UINT]: 'uint32',
});

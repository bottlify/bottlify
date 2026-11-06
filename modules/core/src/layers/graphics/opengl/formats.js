/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The internal formats a texture is kept in as itself (OpenGL 4.6 section
 * 8.5.1, tables 8.12 to 8.14), and the enumerants of the pixel transfer they
 * bring.
 *
 * Each sized format names what it is -- its base format, the kind of its
 * components and their bits -- and the DXGI format with the same bytes, which
 * `../d3d10/gpuformats.js` turns into the WebGPU format, its renderability and
 * its filtering: one table of what the GPU holds, for both APIs. A format with
 * three components is kept as the four-component one, its alpha one, where
 * WebGPU has no three-component texture. A depth format with no stencil and 24
 * bits has no DXGI twin and names its WebGPU format itself.
 *
 * The unsized and legacy formats (`GL_RGBA`, `GL_LUMINANCE8`, `GL_RGB5`, the
 * numbers 1 to 4) are not here: they stay RGBA bytes (`texture.js`), which is
 * the precision a fixed-function program of their era draws with.
 */

import { DXGI_FORMAT as F } from '../d3d10/constants.js';
import { COMPRESSED_FORMAT, TEXEL_BYTES, gpuRenderable, textureStorage }
    from '../d3d10/gpuformats.js';
import { formatTraits } from '../webgpu/internal/textures.js';
import { GL } from './constants.js';

/** The enumerants of OpenGL 3.0 to 4.6 texture formats and pixel transfer. */
export const TEX = Object.freeze({
    RG: 0x8227, RG_INTEGER: 0x8228, RED_INTEGER: 0x8d94, GREEN_INTEGER: 0x8d95,
    BLUE_INTEGER: 0x8d96, RGB_INTEGER: 0x8d98, RGBA_INTEGER: 0x8d99, BGR_INTEGER: 0x8d9a,
    BGRA_INTEGER: 0x8d9b,
    HALF_FLOAT: 0x140b, UNSIGNED_BYTE_2_3_3_REV: 0x8362, UNSIGNED_INT_10F_11F_11F_REV: 0x8c3b,
    UNSIGNED_INT_5_9_9_9_REV: 0x8c3e, FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8dad,
    R8: 0x8229, R16: 0x822a, RG8: 0x822b, RG16: 0x822c, R16F: 0x822d, R32F: 0x822e,
    RG16F: 0x822f, RG32F: 0x8230, R8I: 0x8231, R8UI: 0x8232, R16I: 0x8233, R16UI: 0x8234,
    R32I: 0x8235, R32UI: 0x8236, RG8I: 0x8237, RG8UI: 0x8238, RG16I: 0x8239, RG16UI: 0x823a,
    RG32I: 0x823b, RG32UI: 0x823c,
    RGBA32F: 0x8814, RGB32F: 0x8815, RGBA16F: 0x881a, RGB16F: 0x881b,
    RGBA32UI: 0x8d70, RGB32UI: 0x8d71, RGBA16UI: 0x8d76, RGB16UI: 0x8d77, RGBA8UI: 0x8d7c,
    RGB8UI: 0x8d7d, RGBA32I: 0x8d82, RGB32I: 0x8d83, RGBA16I: 0x8d88, RGB16I: 0x8d89,
    RGBA8I: 0x8d8e, RGB8I: 0x8d8f,
    R8_SNORM: 0x8f94, RG8_SNORM: 0x8f95, RGB8_SNORM: 0x8f96, RGBA8_SNORM: 0x8f97,
    R16_SNORM: 0x8f98, RG16_SNORM: 0x8f99, RGB16_SNORM: 0x8f9a, RGBA16_SNORM: 0x8f9b,
    R11F_G11F_B10F: 0x8c3a, RGB9_E5: 0x8c3d, RGB10_A2UI: 0x906f,
    SRGB: 0x8c40, SRGB8: 0x8c41, SRGB_ALPHA: 0x8c42, SRGB8_ALPHA8: 0x8c43,
    DEPTH_COMPONENT16: 0x81a5, DEPTH_COMPONENT24: 0x81a6, DEPTH_COMPONENT32: 0x81a7,
    DEPTH_COMPONENT32F: 0x8cac, DEPTH32F_STENCIL8: 0x8cad, DEPTH24_STENCIL8: 0x88f0,
    STENCIL_INDEX8: 0x8d48,
    COMPRESSED_RED: 0x8225, COMPRESSED_RG: 0x8226,
    COMPRESSED_RED_RGTC1: 0x8dbb, COMPRESSED_SIGNED_RED_RGTC1: 0x8dbc,
    COMPRESSED_RG_RGTC2: 0x8dbd, COMPRESSED_SIGNED_RG_RGTC2: 0x8dbe,
    COMPRESSED_RGBA_BPTC_UNORM: 0x8e8c, COMPRESSED_SRGB_ALPHA_BPTC_UNORM: 0x8e8d,
    COMPRESSED_RGB_BPTC_SIGNED_FLOAT: 0x8e8e, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT: 0x8e8f,
    COMPRESSED_SRGB_S3TC_DXT1: 0x8c4c, COMPRESSED_SRGB_ALPHA_S3TC_DXT1: 0x8c4d,
    COMPRESSED_SRGB_ALPHA_S3TC_DXT3: 0x8c4e, COMPRESSED_SRGB_ALPHA_S3TC_DXT5: 0x8c4f,
    TEXTURE_1D_ARRAY: 0x8c18, PROXY_TEXTURE_1D_ARRAY: 0x8c19, TEXTURE_2D_ARRAY: 0x8c1a,
    PROXY_TEXTURE_2D_ARRAY: 0x8c1b, TEXTURE_BINDING_1D_ARRAY: 0x8c1c,
    TEXTURE_BINDING_2D_ARRAY: 0x8c1d, TEXTURE_BINDING_3D: 0x806a,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    TEXTURE_RED_TYPE: 0x8c10, TEXTURE_GREEN_TYPE: 0x8c11, TEXTURE_BLUE_TYPE: 0x8c12,
    TEXTURE_ALPHA_TYPE: 0x8c13, TEXTURE_LUMINANCE_TYPE: 0x8c14, TEXTURE_INTENSITY_TYPE: 0x8c15,
    TEXTURE_DEPTH_TYPE: 0x8c16, TEXTURE_LUMINANCE_SIZE: 0x8060, TEXTURE_INTENSITY_SIZE: 0x8061,
    TEXTURE_SHARED_SIZE: 0x8c3f, TEXTURE_STENCIL_SIZE: 0x88f1,
    TEXTURE_DEPTH_SIZE: 0x884a, TEXTURE_DEPTH: 0x8071, TEXTURE_WRAP_R: 0x8072,
    TEXTURE_COMPARE_MODE: 0x884c, TEXTURE_COMPARE_FUNC: 0x884d, COMPARE_REF_TO_TEXTURE: 0x884e,
    DEPTH_TEXTURE_MODE: 0x884b, SIGNED_NORMALIZED: 0x8f9c,
    FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: 0x8210, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: 0x8211,
    PACK_SKIP_IMAGES: 0x806b, PACK_IMAGE_HEIGHT: 0x806c, UNPACK_SKIP_IMAGES: 0x806d,
    UNPACK_IMAGE_HEIGHT: 0x806e,
});

/**
 * What a component of a format is: normalised unsigned or signed, a float,
 * an integer of either sign, or depth and stencil.
 *
 * @typedef {'unorm' | 'snorm' | 'float' | 'int' | 'uint' | 'depth' | 'stencil'} ComponentKind
 */

/**
 * @typedef {Object} SizedFormat
 * @property {number} internal   the enumerant
 * @property {string} name
 * @property {number} base       its base internal format (RED, RG, RGB, RGBA,
 *     DEPTH_COMPONENT, DEPTH_STENCIL, STENCIL_INDEX)
 * @property {ComponentKind} kind
 * @property {number[]} bits     red, green, blue and alpha, zero where absent
 * @property {number} depth      its depth bits
 * @property {number} stencil    its stencil bits
 * @property {number} shared     the shared exponent's bits (RGB9_E5)
 * @property {boolean} srgb
 * @property {number | null} dxgi   the DXGI format with its bytes, null where
 *     `gpu` names the WebGPU one
 * @property {string | null} gpu
 * @property {'r11g11b10' | 'rgb9e5' | 'rgb10a2' | 'd24s8' | 'd32fs8' | null} packing
 *     a layout whose components share a word
 * @property {boolean} compressed
 */

/** @param {Partial<SizedFormat> & { internal: number, name: string, base: number, kind: ComponentKind }} f */
const sized = f=>/** @type {SizedFormat} */ ({ bits: [0, 0, 0, 0], depth: 0, stencil: 0, shared: 0,
    srgb: false, dxgi: null, gpu: null, packing: null, compressed: false, ...f });

const { RED, RGB, RGBA, DEPTH_COMPONENT, DEPTH_STENCIL, STENCIL_INDEX } = GL;
const RG = TEX.RG;

/**
 * A family of one bit width and kind in one, two, three and four components.
 *
 * @param {string} suffix @param {ComponentKind} kind @param {number} width
 * @param {[number, number, number, number]} internals  R, RG, RGB, RGBA
 * @param {[number, number, number]} dxgis  R, RG, RGBA (RGB is kept as RGBA)
 * @returns {SizedFormat[]}
 */
const family = (suffix, kind, width, internals, dxgis)=>[RED, RG, RGB, RGBA].map((base, n)=>
    sized({
        internal: internals[n], name: `${['R', 'RG', 'RGB', 'RGBA'][n]}${suffix}`, base, kind,
        bits: [width, n >= 1 ? width : 0, n >= 2 ? width : 0, n === 3 ? width : 0],
        dxgi: dxgis[n === 3 ? 2 : n === 2 ? 2 : n],
    }));

/** @type {SizedFormat[]} */
const LIST = [
    ...family('8', 'unorm', 8, [TEX.R8, TEX.RG8, GL.RGB8, GL.RGBA8],
        [F.R8_UNORM, F.R8G8_UNORM, F.R8G8B8A8_UNORM]),
    ...family('8_SNORM', 'snorm', 8, [TEX.R8_SNORM, TEX.RG8_SNORM, TEX.RGB8_SNORM,
        TEX.RGBA8_SNORM], [F.R8_SNORM, F.R8G8_SNORM, F.R8G8B8A8_SNORM]),
    ...family('16', 'unorm', 16, [TEX.R16, TEX.RG16, GL.RGB16, GL.RGBA16],
        [F.R16_UNORM, F.R16G16_UNORM, F.R16G16B16A16_UNORM]),
    ...family('16_SNORM', 'snorm', 16, [TEX.R16_SNORM, TEX.RG16_SNORM, TEX.RGB16_SNORM,
        TEX.RGBA16_SNORM], [F.R16_SNORM, F.R16G16_SNORM, F.R16G16B16A16_SNORM]),
    ...family('16F', 'float', 16, [TEX.R16F, TEX.RG16F, TEX.RGB16F, TEX.RGBA16F],
        [F.R16_FLOAT, F.R16G16_FLOAT, F.R16G16B16A16_FLOAT]),
    ...family('32F', 'float', 32, [TEX.R32F, TEX.RG32F, TEX.RGB32F, TEX.RGBA32F],
        [F.R32_FLOAT, F.R32G32_FLOAT, F.R32G32B32A32_FLOAT]),
    ...family('8I', 'int', 8, [TEX.R8I, TEX.RG8I, TEX.RGB8I, TEX.RGBA8I],
        [F.R8_SINT, F.R8G8_SINT, F.R8G8B8A8_SINT]),
    ...family('8UI', 'uint', 8, [TEX.R8UI, TEX.RG8UI, TEX.RGB8UI, TEX.RGBA8UI],
        [F.R8_UINT, F.R8G8_UINT, F.R8G8B8A8_UINT]),
    ...family('16I', 'int', 16, [TEX.R16I, TEX.RG16I, TEX.RGB16I, TEX.RGBA16I],
        [F.R16_SINT, F.R16G16_SINT, F.R16G16B16A16_SINT]),
    ...family('16UI', 'uint', 16, [TEX.R16UI, TEX.RG16UI, TEX.RGB16UI, TEX.RGBA16UI],
        [F.R16_UINT, F.R16G16_UINT, F.R16G16B16A16_UINT]),
    ...family('32I', 'int', 32, [TEX.R32I, TEX.RG32I, TEX.RGB32I, TEX.RGBA32I],
        [F.R32_SINT, F.R32G32_SINT, F.R32G32B32A32_SINT]),
    ...family('32UI', 'uint', 32, [TEX.R32UI, TEX.RG32UI, TEX.RGB32UI, TEX.RGBA32UI],
        [F.R32_UINT, F.R32G32_UINT, F.R32G32B32A32_UINT]),
    sized({ internal: GL.RGB10_A2, name: 'RGB10_A2', base: RGBA, kind: 'unorm',
        bits: [10, 10, 10, 2], dxgi: F.R10G10B10A2_UNORM, packing: 'rgb10a2' }),
    sized({ internal: TEX.RGB10_A2UI, name: 'RGB10_A2UI', base: RGBA, kind: 'uint',
        bits: [10, 10, 10, 2], dxgi: F.R10G10B10A2_UINT, packing: 'rgb10a2' }),
    sized({ internal: TEX.R11F_G11F_B10F, name: 'R11F_G11F_B10F', base: RGB, kind: 'float',
        bits: [11, 11, 10, 0], dxgi: F.R11G11B10_FLOAT, packing: 'r11g11b10' }),
    sized({ internal: TEX.RGB9_E5, name: 'RGB9_E5', base: RGB, kind: 'float', bits: [9, 9, 9, 0],
        shared: 5, dxgi: F.R9G9B9E5_SHAREDEXP, packing: 'rgb9e5' }),
    sized({ internal: TEX.SRGB8, name: 'SRGB8', base: RGB, kind: 'unorm', bits: [8, 8, 8, 0],
        srgb: true, dxgi: F.R8G8B8A8_UNORM_SRGB }),
    sized({ internal: TEX.SRGB8_ALPHA8, name: 'SRGB8_ALPHA8', base: RGBA, kind: 'unorm',
        bits: [8, 8, 8, 8], srgb: true, dxgi: F.R8G8B8A8_UNORM_SRGB }),
    sized({ internal: TEX.SRGB, name: 'SRGB', base: RGB, kind: 'unorm', bits: [8, 8, 8, 0],
        srgb: true, dxgi: F.R8G8B8A8_UNORM_SRGB }),
    sized({ internal: TEX.SRGB_ALPHA, name: 'SRGB_ALPHA', base: RGBA, kind: 'unorm',
        bits: [8, 8, 8, 8], srgb: true, dxgi: F.R8G8B8A8_UNORM_SRGB }),
    sized({ internal: DEPTH_COMPONENT, name: 'DEPTH_COMPONENT', base: DEPTH_COMPONENT,
        kind: 'depth', depth: 24, gpu: 'depth24plus' }),
    sized({ internal: TEX.DEPTH_COMPONENT16, name: 'DEPTH_COMPONENT16', base: DEPTH_COMPONENT,
        kind: 'depth', depth: 16, dxgi: F.D16_UNORM }),
    sized({ internal: TEX.DEPTH_COMPONENT24, name: 'DEPTH_COMPONENT24', base: DEPTH_COMPONENT,
        kind: 'depth', depth: 24, gpu: 'depth24plus' }),
    sized({ internal: TEX.DEPTH_COMPONENT32, name: 'DEPTH_COMPONENT32', base: DEPTH_COMPONENT,
        kind: 'depth', depth: 32, dxgi: F.D32_FLOAT }),
    sized({ internal: TEX.DEPTH_COMPONENT32F, name: 'DEPTH_COMPONENT32F', base: DEPTH_COMPONENT,
        kind: 'depth', depth: 32, dxgi: F.D32_FLOAT }),
    sized({ internal: DEPTH_STENCIL, name: 'DEPTH_STENCIL', base: DEPTH_STENCIL, kind: 'depth',
        depth: 24, stencil: 8, dxgi: F.D24_UNORM_S8_UINT, packing: 'd24s8' }),
    sized({ internal: TEX.DEPTH24_STENCIL8, name: 'DEPTH24_STENCIL8', base: DEPTH_STENCIL,
        kind: 'depth', depth: 24, stencil: 8, dxgi: F.D24_UNORM_S8_UINT, packing: 'd24s8' }),
    sized({ internal: TEX.DEPTH32F_STENCIL8, name: 'DEPTH32F_STENCIL8', base: DEPTH_STENCIL,
        kind: 'depth', depth: 32, stencil: 8, dxgi: F.D32_FLOAT_S8X24_UINT, packing: 'd32fs8' }),
    sized({ internal: TEX.STENCIL_INDEX8, name: 'STENCIL_INDEX8', base: STENCIL_INDEX,
        kind: 'stencil', stencil: 8, gpu: 'stencil8' }),
    ...[
        [TEX.COMPRESSED_RED_RGTC1, 'COMPRESSED_RED_RGTC1', RED, 'unorm', F.BC4_UNORM, false],
        [TEX.COMPRESSED_SIGNED_RED_RGTC1, 'COMPRESSED_SIGNED_RED_RGTC1', RED, 'snorm',
            F.BC4_SNORM, false],
        [TEX.COMPRESSED_RG_RGTC2, 'COMPRESSED_RG_RGTC2', RG, 'unorm', F.BC5_UNORM, false],
        [TEX.COMPRESSED_SIGNED_RG_RGTC2, 'COMPRESSED_SIGNED_RG_RGTC2', RG, 'snorm', F.BC5_SNORM,
            false],
        [TEX.COMPRESSED_RGBA_BPTC_UNORM, 'COMPRESSED_RGBA_BPTC_UNORM', RGBA, 'unorm', F.BC7_UNORM,
            false],
        [TEX.COMPRESSED_SRGB_ALPHA_BPTC_UNORM, 'COMPRESSED_SRGB_ALPHA_BPTC_UNORM', RGBA, 'unorm',
            F.BC7_UNORM_SRGB, true],
        [TEX.COMPRESSED_RGB_BPTC_SIGNED_FLOAT, 'COMPRESSED_RGB_BPTC_SIGNED_FLOAT', RGB, 'float',
            F.BC6H_SF16, false],
        [TEX.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT, 'COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT', RGB,
            'float', F.BC6H_UF16, false],
        [TEX.COMPRESSED_SRGB_S3TC_DXT1, 'COMPRESSED_SRGB_S3TC_DXT1', RGB, 'unorm',
            F.BC1_UNORM_SRGB, true],
        [TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT1, 'COMPRESSED_SRGB_ALPHA_S3TC_DXT1', RGBA, 'unorm',
            F.BC1_UNORM_SRGB, true],
        [TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT3, 'COMPRESSED_SRGB_ALPHA_S3TC_DXT3', RGBA, 'unorm',
            F.BC2_UNORM_SRGB, true],
        [TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT5, 'COMPRESSED_SRGB_ALPHA_S3TC_DXT5', RGBA, 'unorm',
            F.BC3_UNORM_SRGB, true],
    ].map(([internal, name, base, kind, dxgi, srgb])=>sized({
        internal: /** @type {number} */ (internal), name: /** @type {string} */ (name),
        base: /** @type {number} */ (base), kind: /** @type {ComponentKind} */ (kind),
        dxgi: /** @type {number} */ (dxgi), srgb: /** @type {boolean} */ (srgb),
        compressed: true,
        bits: base === RED ? [8, 0, 0, 0] : base === RG ? [8, 8, 0, 0]
            : base === RGB ? [8, 8, 8, 0] : [8, 8, 8, 8],
    })),
];

// The generic compressed RED and RG formats may be kept uncompressed (OpenGL
// 4.6 section 8.5): they are R8 and RG8 under their own enumerant.
LIST.push(...[[TEX.COMPRESSED_RED, TEX.R8], [TEX.COMPRESSED_RG, TEX.RG8]].map(([internal, as])=>
    ({ .../** @type {SizedFormat} */ (LIST.find(format=>format.internal === as)), internal })));

/**
 * The sized formats by their enumerant.
 *
 * @type {ReadonlyMap<number, SizedFormat>}
 */
export const SIZED_FORMATS = new Map(LIST.map(format=>[format.internal, format]));

/**
 * The formats `texture.js` keeps as RGBA bytes though they are sized: what a
 * program of OpenGL 1.x asked for and draws as eight bits a component.
 */
/** @type {ReadonlySet<number>} */
const LEGACY_SIZED = new Set([GL.RGB8, GL.RGBA8, GL.RGB16, GL.RGBA16, GL.RGB10_A2]);

/**
 * The format a level is kept in as itself, or null for one kept as RGBA bytes
 * (an unsized, legacy or eight-bit RGB(A) format: `texture.js`'s
 * `baseFormatOf` knows those).
 *
 * @param {number} internal
 * @returns {SizedFormat | null}
 */
export function sizedFormatOf(internal){
    return LEGACY_SIZED.has(internal) ? null : SIZED_FORMATS.get(internal) ?? null;
}

/** Whether a format's components are integers a sampler returns unconverted. */
/** @param {SizedFormat} format */
export const isIntegerFormat = format=>format.kind === 'int' || format.kind === 'uint';

/**
 * The integer client formats (table 8.3), each with the colour one it is the
 * integer twin of.
 *
 * @type {ReadonlyMap<number, number>}
 */
export const INTEGER_CLIENT_FORMATS = new Map([
    [TEX.RED_INTEGER, RED], [TEX.GREEN_INTEGER, GL.GREEN], [TEX.BLUE_INTEGER, GL.BLUE],
    [TEX.RG_INTEGER, RG], [TEX.RGB_INTEGER, RGB], [TEX.BGR_INTEGER, GL.BGR],
    [TEX.RGBA_INTEGER, RGBA], [TEX.BGRA_INTEGER, GL.BGRA],
]);

/**
 * What a device can do, as `textureStorage` reads it.
 *
 * @typedef {import('../d3d10/gpuformats.js').GpuFormatOptions & {
 *     float32Filterable?: boolean }} DeviceFormats
 */

/**
 * @typedef {Object} GpuStorage
 * @property {string} format       the WebGPU format
 * @property {number} bytes        a texel's bytes there (a block's, compressed)
 * @property {boolean} renderable
 * @property {boolean} filterable  whether a filtering sampler may read it
 * @property {'float' | 'unfilterable-float' | 'sint' | 'uint' | 'depth'} sampleType
 * @property {boolean} depth
 * @property {boolean} stencil
 * @property {'unorm16-as-float' | 'decode' | null} conversion  what the
 *     model's bytes become on the way up: 16-bit normalised components as
 *     half floats where the device has no 16-bit normalised textures, the
 *     blocks decoded where it samples none
 */

/**
 * Where a sized format lives on the GPU, as `gpuformats.js` decides it for
 * the DXGI format of the same bytes.
 *
 * @param {SizedFormat} format
 * @param {DeviceFormats} [device]
 * @returns {GpuStorage | null} null where the device has no way to hold it
 */
export function gpuStorageOf(format, device = {}){
    /** @type {string} */
    let gpu;
    /** @type {GpuStorage['conversion']} */
    let conversion = null;
    if (format.kind === 'depth' || format.kind === 'stencil')
    {
        // Every depth and stencil format is kept with both aspects: a texture
        // a framebuffer draws into is its depth-stencil attachment, whose
        // pipelines have a stencil state, and WebGPU refuses one on a format
        // without a stencil. A float depth keeps its floats where the device
        // has depth32float-stencil8.
        const float = format.depth === 32 && device.depth32Stencil === true;
        gpu = float ? 'depth32float-stencil8' : 'depth24plus-stencil8';
    }
    else if (format.gpu)
    {
        gpu = format.gpu;
    }
    else if (format.compressed)
    {
        const compressed = COMPRESSED_FORMAT[/** @type {number} */ (format.dxgi)];
        gpu = device.compressed ? compressed.format : compressed.decoded;
        conversion = device.compressed ? null : 'decode';
    }
    else
    {
        const kept = textureStorage(/** @type {number} */ (format.dxgi), 0, device);
        if (!kept)
        {
            // No 16-bit normalised textures: the values as half floats,
            // ten bits of mantissa for sixteen of fraction.
            const half = format.bits.filter(bits=>bits > 0).length;
            gpu = ['r16float', 'rg16float', 'rgba16float', 'rgba16float'][half - 1];
            conversion = 'unorm16-as-float';
        }
        else
        {
            gpu = kept.format;
        }
    }
    const depth = format.kind === 'depth';
    const stencil = format.stencil > 0;
    const integer = isIntegerFormat(format) || format.kind === 'stencil';
    const filterable = depth || integer ? false
        : FILTERED_BESIDES.has(gpu) || formatTraits(gpu).filterable
            || (/^r(g|gba)?32float$/.test(gpu) && device.float32Filterable === true);
    return {
        format: gpu,
        bytes: TEXEL_BYTES[gpu] ?? (depth || format.kind === 'stencil'
            ? DEPTH_BYTES[gpu] : 0),
        renderable: format.compressed || gpu === 'rgb9e5ufloat' ? false
            : gpuRenderable(gpu, device),
        filterable,
        sampleType: depth ? 'depth' : format.kind === 'stencil' || format.kind === 'uint' ? 'uint'
            : format.kind === 'int' ? 'sint' : filterable ? 'float' : 'unfilterable-float',
        depth,
        stencil,
        conversion,
    };
}

/**
 * Formats WebGPU filters that `formatTraits` does not list, since Direct3D
 * never asked: the shared-exponent one, and the 16-bit normalised ones of
 * texture-formats-tier1 (a device without it never keeps them).
 */
const FILTERED_BESIDES = new Set(['rgb9e5ufloat', 'r16unorm', 'rg16unorm', 'rgba16unorm',
    'r16snorm', 'rg16snorm', 'rgba16snorm']);

/** The bytes of a depth or stencil texel, as an upload or read sees its aspect. */
const DEPTH_BYTES = /** @type {Readonly<Record<string, number>>} */ (Object.freeze({
    depth16unorm: 2, depth24plus: 4, depth32float: 4, 'depth24plus-stencil8': 4,
    'depth32float-stencil8': 8, stencil8: 1,
}));

/**
 * The bytes a texel of a sized format takes as the model keeps it: the
 * format's own layout, four components where WebGPU has no three, a depth of
 * 24 bits in the low bits of a word with its stencil in the high byte, and a
 * float depth with stencil as two words (FLOAT_32_UNSIGNED_INT_24_8_REV's).
 *
 * @param {SizedFormat} format
 * @returns {number} zero for a compressed format
 */
export function modelTexelBytes(format){
    if (format.compressed)
    {
        return 0;
    }
    if (format.packing === 'd32fs8')
    {
        return 8;
    }
    if (format.packing)
    {
        return 4;
    }
    if (format.kind === 'depth')
    {
        return format.depth === 16 ? 2 : 4;
    }
    if (format.kind === 'stencil')
    {
        return 1;
    }
    const width = format.bits[0];
    const components = format.base === RED ? 1 : format.base === RG ? 2 : 4;
    return components * width / 8;
}

/**
 * The type a level's component answers for TEXTURE_*_TYPE (OpenGL 3.0 table
 * 6.17): NONE where it has none.
 *
 * @param {SizedFormat} format @param {'colour' | 'depth'} which
 * @returns {number}
 */
export function componentTypeOf(format, which){
    if (which === 'depth')
    {
        return format.depth === 0 ? GL.NONE
            : format.internal === TEX.DEPTH_COMPONENT32F
                || format.internal === TEX.DEPTH32F_STENCIL8 ? GL.FLOAT
                : GL.UNSIGNED_NORMALIZED;
    }
    switch (format.kind)
    {
        case 'unorm':
            return GL.UNSIGNED_NORMALIZED;
        case 'snorm':
            return TEX.SIGNED_NORMALIZED;
        case 'float':
            return GL.FLOAT;
        case 'int':
            return GL.INT;
        case 'uint':
            return GL.UNSIGNED_INT;
        default:
            return GL.NONE;
    }
}

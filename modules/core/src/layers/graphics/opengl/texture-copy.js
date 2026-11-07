/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The rules of the copies and fills a level takes whole texels at a time:
 * glCopyImageSubData (OpenGL 4.6 section 18.3.3, GL_ARB_copy_image), which
 * moves raw texel bits between two images of compatible formats, and the
 * internal formats glTexStorage takes (section 8.19).
 *
 * A copy moves bits, not values: an RGBA8 texel copied into an R32F level
 * is the float those four bytes spell. What is moved is a format's own
 * bytes, a texel's or a 4x4 block's -- not the bytes a level is kept in
 * where those differ (an RGB format is kept with a fourth component, a
 * legacy level as RGBA bytes), so the raw form is its own step here.
 */

import { GL } from './constants.js';
import { SIZED_FORMATS, TEX, modelTexelBytes } from './formats.js';

/**
 * @typedef {import('./formats.js').SizedFormat} SizedFormat
 *
 * @typedef {Object} CopyFormat
 * @property {number} internal
 * @property {boolean} compressed
 * @property {number} bytes  a texel's bits in bytes, or a block's
 * @property {string | null} viewClass  what a copy across formats matches on; null:
 *     copied only to its own format (depth and stencil, the formats of OpenGL 1.x the
 *     view classes do not list)
 */

/** The S3TC formats of GL_EXT_texture_compression_s3tc, and their blocks' bytes. */
/** @type {ReadonlyMap<number, number>} */
export const S3TC_BLOCK_BYTES = new Map([
    [GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 8], [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, 8],
    [GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, 16], [GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 16],
]);

/**
 * The view classes of the compressed formats (table 8.27): a copy between
 * two compressed formats stays within one.
 *
 * @type {ReadonlyMap<number, string>}
 */
const COMPRESSED_CLASSES = new Map([
    [GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 'dxt1-rgb'], [TEX.COMPRESSED_SRGB_S3TC_DXT1, 'dxt1-rgb'],
    [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, 'dxt1-rgba'],
    [TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT1, 'dxt1-rgba'],
    [GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, 'dxt3'], [TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT3, 'dxt3'],
    [GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 'dxt5'], [TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT5, 'dxt5'],
    [TEX.COMPRESSED_RED_RGTC1, 'rgtc1'], [TEX.COMPRESSED_SIGNED_RED_RGTC1, 'rgtc1'],
    [TEX.COMPRESSED_RG_RGTC2, 'rgtc2'], [TEX.COMPRESSED_SIGNED_RG_RGTC2, 'rgtc2'],
    [TEX.COMPRESSED_RGBA_BPTC_UNORM, 'bptc-unorm'],
    [TEX.COMPRESSED_SRGB_ALPHA_BPTC_UNORM, 'bptc-unorm'],
    [TEX.COMPRESSED_RGB_BPTC_SIGNED_FLOAT, 'bptc-float'],
    [TEX.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT, 'bptc-float'],
]);

/**
 * The internal formats that name no size: glTexStorage refuses every one
 * (section 8.19), and a copy reaches them only from their own format.
 *
 * @type {ReadonlySet<number>}
 */
export const UNSIZED_FORMATS = new Set([
    1, 2, 3, 4, GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.INTENSITY, GL.RED, TEX.RG,
    GL.RGB, GL.RGBA, GL.DEPTH_COMPONENT, GL.DEPTH_STENCIL, GL.STENCIL_INDEX, TEX.SRGB,
    TEX.SRGB_ALPHA, 0x8c44, 0x8c46, GL.COMPRESSED_ALPHA, GL.COMPRESSED_LUMINANCE,
    GL.COMPRESSED_LUMINANCE_ALPHA, GL.COMPRESSED_INTENSITY, 0x84ed, 0x84ee, TEX.COMPRESSED_RED,
    TEX.COMPRESSED_RG, 0x8c48, 0x8c49, 0x8c4a, 0x8c4b,
]);

/**
 * The bytes of one texel of a format as a copy moves it: its components'
 * bits, without the fourth component an RGB format is kept with.
 *
 * @param {SizedFormat} sized
 * @returns {number}
 */
export function rawTexelBytes(sized){
    if (sized.base === GL.RGB && !sized.packing)
    {
        return 3 * sized.bits[0] / 8;
    }
    return modelTexelBytes(sized);
}

/**
 * What a copy knows of an internal format, or null for one no level has.
 *
 * @param {number} internal
 * @returns {CopyFormat | null}
 */
export function copyFormatOf(internal){
    const blocks = S3TC_BLOCK_BYTES.get(internal);
    if (blocks !== undefined)
    {
        return { internal, compressed: true, bytes: blocks,
            viewClass: /** @type {string} */ (COMPRESSED_CLASSES.get(internal)) };
    }
    const sized = SIZED_FORMATS.get(internal);
    if (!sized || UNSIZED_FORMATS.has(internal))
    {
        return { internal, compressed: false, bytes: 4, viewClass: null };
    }
    if (sized.compressed)
    {
        const bytes = sized.base === GL.RED || sized.internal === TEX.COMPRESSED_SRGB_S3TC_DXT1
            || sized.internal === TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT1 ? 8 : 16;
        return { internal, compressed: true, bytes,
            viewClass: COMPRESSED_CLASSES.get(internal) ?? null };
    }
    const exact = sized.kind === 'depth' || sized.kind === 'stencil';
    const bytes = rawTexelBytes(sized);
    return { internal, compressed: false, bytes, viewClass: exact ? null : `bits:${bytes * 8}` };
}

/**
 * Whether glCopyImageSubData copies between two formats (section 18.3.3):
 * the same format; two uncompressed ones of one view class, which is their
 * texel size; two compressed ones of one class; or a compressed one and an
 * uncompressed one whose texel is the other's block.
 *
 * @param {CopyFormat} a @param {CopyFormat} b
 * @returns {boolean}
 */
export function copyCompatible(a, b){
    if (a.internal === b.internal)
    {
        return true;
    }
    if (a.viewClass === null || b.viewClass === null)
    {
        return false;
    }
    if (a.compressed && b.compressed)
    {
        return a.viewClass === b.viewClass;
    }
    return a.bytes === b.bytes;
}

/**
 * Raw texels from a box of a level kept as `sized`, given in that layout: a
 * kept texel cut down to the bytes a copy moves.
 *
 * @param {Uint8Array} kept  the box tightly packed as the level keeps it
 * @param {SizedFormat} sized
 * @returns {Uint8Array}
 */
export function rawFromKept(kept, sized){
    const stride = modelTexelBytes(sized);
    const unit = rawTexelBytes(sized);
    if (sized.compressed || stride === unit)
    {
        return kept;
    }
    const count = kept.length / stride;
    const out = new Uint8Array(count * unit);
    for (let i = 0; i < count; i++)
    {
        out.set(kept.subarray(i * stride, i * stride + unit), i * unit);
    }
    return out;
}

/**
 * The other way: raw texels written over a box kept as `sized`, the bytes a
 * copy does not move (an RGB format's fourth) left as `kept` holds them.
 *
 * @param {Uint8Array} raw @param {Uint8Array} kept  written in place
 * @param {SizedFormat} sized
 * @returns {Uint8Array} `kept`
 */
export function rawIntoKept(raw, kept, sized){
    const stride = modelTexelBytes(sized);
    const unit = rawTexelBytes(sized);
    if (sized.compressed || stride === unit)
    {
        kept.set(raw.subarray(0, kept.length));
        return kept;
    }
    const count = kept.length / stride;
    for (let i = 0; i < count; i++)
    {
        kept.set(raw.subarray(i * unit, (i + 1) * unit), i * stride);
    }
    return kept;
}

/**
 * The most levels a texture of these dimensions has (section 8.19): one
 * more than the base 2 logarithm of its largest.
 *
 * @param {...number} sizes
 * @returns {number}
 */
export const mipLevels = (...sizes)=>Math.floor(Math.log2(Math.max(1, ...sizes))) + 1;

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The levels of a sized format: kept as the format's own bytes
 * (`formats.js` `modelTexelBytes` a texel, images of a 3D texture or layers
 * of an array one after another), written and read a box at a time, answered
 * for by the level queries, and turned into what something else reads -- the
 * RGBA bytes the processor's rasteriser samples, and the bytes a device
 * takes.
 *
 * A compressed format is kept as its blocks, four by four texels a block.
 */

import { COMPRESSED_FORMAT } from '../d3d10/gpuformats.js';
import { convertTexels } from '../d3d10/blocks.js';
import { GL } from './constants.js';
import { SIZED_FORMATS, TEX, componentTypeOf, modelTexelBytes } from './formats.js';
import { decodeStorage, encodeStorage, toHalf } from './texture-transfer.js';

/**
 * @typedef {import('./formats.js').SizedFormat} SizedFormat
 * @typedef {{ x: number, y: number, z: number, width: number, height: number,
 *     depth: number }} Box
 */

/**
 * What a glTexImage of a compressed format keeps: the uncompressed format
 * of the same components (OpenGL 4.6 section 8.5 lets an implementation keep
 * any internal format at least as precise as the one asked for). Itself for
 * every other format.
 *
 * @param {SizedFormat} sized
 * @returns {SizedFormat}
 */
export function uncompressedTwin(sized){
    if (!sized.compressed)
    {
        return sized;
    }
    const signed = sized.kind === 'snorm';
    const twin = sized.srgb ? TEX.SRGB8_ALPHA8
        : sized.kind === 'float' ? TEX.RGBA16F
            : sized.base === GL.RED ? (signed ? TEX.R8_SNORM : TEX.R8)
                : sized.base === TEX.RG ? (signed ? TEX.RG8_SNORM : TEX.RG8)
                    : GL.RGBA8;
    return /** @type {SizedFormat} */ (SIZED_FORMATS.get(twin));
}

/**
 * The bytes of a box of a level in its own layout: texels for an
 * uncompressed format, blocks for a compressed one.
 *
 * @param {SizedFormat} sized
 * @param {number} width @param {number} height @param {number} [depth]
 * @returns {number}
 */
export function storageBytes(sized, width, height, depth = 1){
    if (sized.compressed)
    {
        const blockBytes = sized.base === GL.RED || sized.internal === TEX.COMPRESSED_SRGB_S3TC_DXT1
            || sized.internal === TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT1 ? 8 : 16;
        return Math.ceil(width / 4) * Math.ceil(height / 4) * depth * blockBytes;
    }
    return width * height * depth * modelTexelBytes(sized);
}

/**
 * A level given a shape and no data: zero in every component the format
 * has, and an alpha of one where it has none (the values GL leaves
 * undefined, pinned to the ones a test can check).
 *
 * @param {SizedFormat} sized
 * @param {number} width @param {number} height @param {number} depth
 * @returns {Uint8Array}
 */
export function blankStorage(sized, width, height, depth){
    if (sized.compressed || sized.base !== GL.RGB)
    {
        return new Uint8Array(storageBytes(sized, width, height, depth));
    }
    const texels = new Float64Array(width * height * depth * 4);
    for (let at = 3; at < texels.length; at += 4)
    {
        texels[at] = 1;
    }
    return encodeStorage(texels, sized);
}

/**
 * Copies a box of bytes into a level, or out of one: `into` a level of
 * `levelWidth` by `levelHeight` texels a slice, the box tightly packed on the
 * other side.
 *
 * @param {Uint8Array} level @param {SizedFormat} sized
 * @param {number} levelWidth @param {number} levelHeight
 * @param {Box} box @param {Uint8Array} packed
 * @param {'write' | 'read'} direction
 */
export function copyBox(level, sized, levelWidth, levelHeight, box, packed, direction){
    const unit = sized.compressed ? 4 : 1;
    const texel = sized.compressed ? storageBytes(sized, 4, 4) : modelTexelBytes(sized);
    const columns = Math.ceil(levelWidth / unit);
    const rows = Math.ceil(levelHeight / unit);
    const boxColumns = Math.ceil(box.width / unit);
    const boxRows = Math.ceil(box.height / unit);
    const row = boxColumns * texel;
    for (let z = 0; z < box.depth; z++)
    {
        for (let y = 0; y < boxRows; y++)
        {
            const at = (((box.z + z) * rows + box.y / unit + y) * columns + box.x / unit) * texel;
            const from = (z * boxRows + y) * row;
            if (direction === 'write')
            {
                level.set(packed.subarray(from, from + row), at);
            }
            else
            {
                packed.set(level.subarray(at, at + row), from);
            }
        }
    }
}

/**
 * A level's texels as RGBA bytes, the form the processor's rasteriser and
 * the legacy readers take: a normalised or float value clamped to [0, 1],
 * an integer one clamped to [0, 255], a depth as luminance
 * (GL_DEPTH_TEXTURE_MODE's default) and a stencil the same.
 *
 * @param {Uint8Array} data @param {SizedFormat} sized
 * @param {number} width @param {number} height @param {number} depth
 * @returns {Uint8Array | null} null for blocks this build cannot decode
 */
export function rgbaOf(data, sized, width, height, depth){
    if (sized.compressed)
    {
        const conversion = COMPRESSED_FORMAT[/** @type {number} */ (sized.dxgi)]?.conversion;
        const decoded = conversion ? convertTexels(/** @type {any} */ (conversion), data, width,
            height * depth) : null;
        return decoded ? decodedToRgba(decoded, conversion, width * height * depth) : null;
    }
    const values = decodeStorage(data, sized);
    const out = new Uint8Array(values.length);
    const integer = sized.kind === 'int' || sized.kind === 'uint';
    const depthLike = sized.kind === 'depth' || sized.kind === 'stencil';
    for (let at = 0; at < values.length; at += 4)
    {
        for (let k = 0; k < 4; k++)
        {
            let v = depthLike ? (k === 3 ? 1 : values[at + (sized.kind === 'stencil' ? 1 : 0)])
                : values[at + k];
            if (depthLike && sized.kind === 'stencil' && k < 3)
            {
                v /= 255;
            }
            out[at + k] = integer && k < 3 ? Math.min(255, Math.max(0, v))
                : Math.round(Math.min(1, Math.max(0, Number.isNaN(v) ? 0 : v)) * 255);
        }
    }
    return out;
}

/**
 * The decoded form of a block conversion as RGBA bytes.
 *
 * @param {Uint8Array} decoded @param {string} conversion @param {number} count
 * @returns {Uint8Array}
 */
function decodedToRgba(decoded, conversion, count){
    const out = new Uint8Array(count * 4);
    const signed = conversion === 'bc4s' || conversion === 'bc5s';
    /** @param {number} byte */
    const unit = byte=>(signed ? Math.round(Math.max(0, (byte << 24 >> 24) / 127) * 255) : byte);
    for (let i = 0; i < count; i++)
    {
        const o = i * 4;
        if (conversion === 'bc4u' || conversion === 'bc4s')
        {
            out.set([unit(decoded[i]), 0, 0, 255], o);
        }
        else if (conversion === 'bc5u' || conversion === 'bc5s')
        {
            out.set([unit(decoded[i * 2]), unit(decoded[i * 2 + 1]), 0, 255], o);
        }
        else if (conversion === 'bc6hu' || conversion === 'bc6hs')
        {
            const view = new DataView(decoded.buffer, decoded.byteOffset + i * 8, 8);
            for (let k = 0; k < 3; k++)
            {
                const half = view.getUint16(k * 2, true);
                out[o + k] = Math.round(Math.min(1, Math.max(0, halfValue(half))) * 255);
            }
            out[o + 3] = 255;
        }
        else
        {
            out.set(decoded.subarray(o, o + 4), o);
        }
    }
    return out;
}

/** @param {number} bits */
function halfValue(bits){
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    const value = exponent === 0 ? mantissa * 2 ** -24
        : exponent === 0x1f ? (mantissa ? NaN : Infinity)
            : (1 + mantissa / 1024) * 2 ** (exponent - 15);
    return bits & 0x8000 ? -value : value;
}

/**
 * The bytes a device takes for a level kept as `sized`, in the format
 * `formats.js` chose for it: the same bytes, or 16-bit normalised components
 * as half floats where the device has no 16-bit normalised textures, or the
 * blocks decoded where it samples none.
 *
 * @param {Uint8Array} data @param {SizedFormat} sized
 * @param {import('./formats.js').GpuStorage} storage
 * @param {number} width @param {number} height @param {number} depth
 * @returns {Uint8Array | null}
 */
export function deviceBytes(data, sized, storage, width, height, depth){
    if (storage.conversion === 'decode')
    {
        const conversion = COMPRESSED_FORMAT[/** @type {number} */ (sized.dxgi)]?.conversion;
        return conversion ? convertTexels(/** @type {any} */ (conversion), data, width,
            height * depth) : null;
    }
    if (storage.conversion === 'unorm16-as-float')
    {
        const words = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
        const out = new Uint16Array(words.length);
        const signed = sized.kind === 'snorm';
        for (let i = 0; i < words.length; i++)
        {
            out[i] = toHalf(signed ? Math.max((words[i] << 16 >> 16) / 32767, -1)
                : words[i] / 65535);
        }
        return new Uint8Array(out.buffer);
    }
    return data;
}

/**
 * A depth level's depths and stencils, one slice of it, as the device's
 * depth write takes them (`webgpu/internal/depth.js` `depthWriteWords`): the
 * depths as floats clamped to [0, 1] (a depth attachment holds no other), and
 * the stencils, zero for a format without any.
 *
 * @param {Uint8Array} data @param {SizedFormat} sized
 * @param {number} texels  a slice's texels @param {number} slice
 * @returns {{ depths: Float32Array, stencils: Uint8Array }}
 */
export function depthSlice(data, sized, texels, slice){
    const bytes = modelTexelBytes(sized);
    const values = decodeStorage(data.subarray(slice * texels * bytes,
        (slice + 1) * texels * bytes), sized);
    const depths = new Float32Array(texels);
    const stencils = new Uint8Array(texels);
    for (let i = 0; i < texels; i++)
    {
        const depth = sized.kind === 'stencil' ? 0 : values[i * 4];
        depths[i] = Number.isNaN(depth) ? 0 : Math.min(1, Math.max(0, depth));
        stencils[i] = values[i * 4 + 1];
    }
    return { depths, stencils };
}

/**
 * The answer of glGetTexLevelParameter for a level kept as a sized format
 * (OpenGL 4.6 table 23.10), or undefined for a query this does not answer.
 *
 * @param {SizedFormat} sized  the format the level was asked for
 * @param {number} parameter
 * @returns {number | undefined}
 */
export function sizedLevelAnswer(sized, parameter){
    const [r, g, b, a] = sized.bits;
    const compressed = sized.compressed;
    switch (parameter)
    {
        case GL.TEXTURE_RED_SIZE:
            return compressed ? 0 : r;
        case GL.TEXTURE_GREEN_SIZE:
            return compressed ? 0 : g;
        case GL.TEXTURE_BLUE_SIZE:
            return compressed ? 0 : b;
        case GL.TEXTURE_ALPHA_SIZE:
            return compressed ? 0 : a;
        case TEX.TEXTURE_LUMINANCE_SIZE:
        case TEX.TEXTURE_INTENSITY_SIZE:
            return 0;
        case TEX.TEXTURE_DEPTH_SIZE:
            return sized.depth;
        case TEX.TEXTURE_STENCIL_SIZE:
            return sized.stencil;
        case TEX.TEXTURE_SHARED_SIZE:
            return sized.shared;
        case TEX.TEXTURE_RED_TYPE:
            return r || compressed ? componentTypeOf(sized, 'colour') : GL.NONE;
        case TEX.TEXTURE_GREEN_TYPE:
            return g ? componentTypeOf(sized, 'colour') : GL.NONE;
        case TEX.TEXTURE_BLUE_TYPE:
            return b ? componentTypeOf(sized, 'colour') : GL.NONE;
        case TEX.TEXTURE_ALPHA_TYPE:
            return a ? componentTypeOf(sized, 'colour') : GL.NONE;
        case TEX.TEXTURE_LUMINANCE_TYPE:
        case TEX.TEXTURE_INTENSITY_TYPE:
            return GL.NONE;
        case TEX.TEXTURE_DEPTH_TYPE:
            return componentTypeOf(sized, 'depth');
        case GL.TEXTURE_COMPRESSED:
            return compressed ? 1 : 0;
        default:
            return undefined;
    }
}

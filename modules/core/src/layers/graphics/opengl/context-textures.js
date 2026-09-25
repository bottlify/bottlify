/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texture objects, images, the texture environment and the texture units.
 *
 * A texture unit owns its enables, its bindings, its environment, its
 * coordinate generation and its own copy of the texture matrix stack. What
 * the flat state table holds for these queries is only a default: the
 * answer comes from the active unit, which is why `unitValue` exists and why
 * the core routes the per-unit enumerants through it before looking in the
 * table.
 *
 * Images are read out of guest memory at the call, through the unpack state
 * then current, and kept as RGBA texels. A level given a shape and a null
 * pointer exists with no data, and a texture with such a level is complete
 * and samples as black -- which is the specification's "undefined" pinned to
 * the one value a test can check.
 */

import { GL } from './constants.js';
import { createTextureObject, isTextureComplete, levelKey, markDirty } from './objects.js';
import { createMatrixStacks } from './matrix.js';
import { CONVENTIONAL_UNITS, TEXTURE_UNITS } from './state.js';
import {
    baseFormatOf, compressedBytes, conformTexels, createTextureEnvironment, decodeS3tc,
    imageBytes, unpackImage,
} from './texture.js';


/**
 * A digest of every compressed block a program has handed over, in order. A
 * program that loads the same images the same way hands over the same bytes,
 * so two runs whose digests differ were given different data -- which puts a
 * corrupt texture on the side that produced it, not on the side that drew it.
 */
export const compressedDigest = { count: 0, bytes: 0, hash: 0x811c9dc5 };

/**
 * The same for the uncompressed images, one entry an upload in order --
 * `target:level:widthxheight:hash` -- up to a few thousand: the images a
 * program computes for itself (a normalisation cube, a lookup table) are
 * among them, and one that differs between two engines names itself.
 * @type {string[]}
 */
export const imageDigests = [];

/** @param {Uint8Array} bytes */
const hashOf = bytes=>{
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++)
    {
        hash = Math.imul(hash ^ bytes[i], 16777619);
    }
    return (hash >>> 0).toString(16);
};

/** @param {Uint8Array} bytes */
function digestBlocks(bytes){
    let hash = compressedDigest.hash;
    for (let i = 0; i < bytes.length; i++)
    {
        hash = Math.imul(hash ^ bytes[i], 16777619);
    }
    compressedDigest.hash = hash >>> 0;
    compressedDigest.count++;
    compressedDigest.bytes += bytes.length;
}

/** The targets a unit can have textures bound to, lowest priority first. */
const TARGETS = [GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_CUBE_MAP];

const BINDING_QUERY = Object.freeze({
    [GL.TEXTURE_1D]: GL.TEXTURE_BINDING_1D,
    [GL.TEXTURE_2D]: GL.TEXTURE_BINDING_2D,
    [GL.TEXTURE_CUBE_MAP]: GL.TEXTURE_BINDING_CUBE_MAP,
});

const GEN_COORDS = Object.freeze({
    [GL.TEXTURE_GEN_S]: 0, [GL.TEXTURE_GEN_T]: 1, [GL.TEXTURE_GEN_R]: 2, [GL.TEXTURE_GEN_Q]: 3,
});
const GEN_COORD_OF = Object.freeze({ [GL.S]: 0, [GL.T]: 1, [GL.R]: 2, [GL.Q]: 3 });

const CUBE_FACES = [
    GL.TEXTURE_CUBE_MAP_POSITIVE_X, GL.TEXTURE_CUBE_MAP_NEGATIVE_X,
    GL.TEXTURE_CUBE_MAP_POSITIVE_Y, GL.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    GL.TEXTURE_CUBE_MAP_POSITIVE_Z, GL.TEXTURE_CUBE_MAP_NEGATIVE_Z,
];

/** @type {Set<number>} */
const FILTERS = new Set([
    GL.NEAREST, GL.LINEAR, GL.NEAREST_MIPMAP_NEAREST, GL.LINEAR_MIPMAP_NEAREST,
    GL.NEAREST_MIPMAP_LINEAR, GL.LINEAR_MIPMAP_LINEAR,
]);
/** @type {Set<number>} */
const WRAPS = new Set([
    GL.CLAMP, GL.REPEAT, GL.CLAMP_TO_EDGE, GL.CLAMP_TO_BORDER, GL.MIRRORED_REPEAT,
]);

/** @type {Set<number>} */
const PIXEL_FORMATS = new Set([
    GL.COLOR_INDEX, GL.STENCIL_INDEX, GL.DEPTH_COMPONENT, GL.RED, GL.GREEN, GL.BLUE, GL.ALPHA,
    GL.RGB, GL.RGBA, GL.BGR, GL.BGRA, GL.LUMINANCE, GL.LUMINANCE_ALPHA,
]);

/** @type {Set<number>} */
const PIXEL_TYPES = new Set([
    GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT, GL.UNSIGNED_INT, GL.FLOAT,
    GL.BITMAP, GL.UNSIGNED_BYTE_3_3_2, GL.UNSIGNED_SHORT_4_4_4_4, GL.UNSIGNED_SHORT_5_5_5_1,
    GL.UNSIGNED_INT_8_8_8_8, GL.UNSIGNED_INT_10_10_10_2, GL.UNSIGNED_SHORT_5_6_5,
    GL.UNSIGNED_SHORT_5_6_5_REV, GL.UNSIGNED_SHORT_4_4_4_4_REV, GL.UNSIGNED_SHORT_1_5_5_5_REV,
    GL.UNSIGNED_INT_8_8_8_8_REV, GL.UNSIGNED_INT_2_10_10_10_REV,
]);

/**
 * Packed types, and the formats whose component count they can carry.
 *
 * @type {Map<number, number[]>}
 */
const PACKED_TYPE_FORMATS = new Map([
    [GL.UNSIGNED_BYTE_3_3_2, [GL.RGB]],
    [GL.UNSIGNED_SHORT_5_6_5, [GL.RGB]],
    [GL.UNSIGNED_SHORT_5_6_5_REV, [GL.RGB]],
    [GL.UNSIGNED_SHORT_4_4_4_4, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_SHORT_4_4_4_4_REV, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_SHORT_5_5_5_1, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_SHORT_1_5_5_5_REV, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_INT_8_8_8_8, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_INT_8_8_8_8_REV, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_INT_10_10_10_2, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_INT_2_10_10_10_REV, [GL.RGBA, GL.BGRA]],
]);

/** @type {Set<number>} */
const ENV_MODES = new Set([GL.MODULATE, GL.DECAL, GL.REPLACE, GL.BLEND, GL.ADD, GL.COMBINE]);
/** @type {Set<number>} */
const COMBINE_RGB = new Set([
    GL.REPLACE, GL.MODULATE, GL.ADD, GL.ADD_SIGNED, GL.INTERPOLATE, GL.SUBTRACT, GL.DOT3_RGB,
    GL.DOT3_RGBA,
]);
/** @type {Set<number>} */
const COMBINE_ALPHA = new Set([
    GL.REPLACE, GL.MODULATE, GL.ADD, GL.ADD_SIGNED, GL.INTERPOLATE, GL.SUBTRACT,
]);
/** @type {Set<number>} */
const COMBINE_SOURCES = new Set([GL.TEXTURE, GL.CONSTANT, GL.PRIMARY_COLOR, GL.PREVIOUS]);
/** @type {Set<number>} */
const OPERANDS_RGB = new Set([
    GL.SRC_COLOR, GL.ONE_MINUS_SRC_COLOR, GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA,
]);
/** @type {Set<number>} */
const OPERANDS_ALPHA = new Set([GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA]);

/** @type {Set<number>} */
const S3TC_FORMATS = new Set([
    GL.COMPRESSED_RGB_S3TC_DXT1_EXT, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT,
    GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT,
]);

/**
 * @typedef {Object} TextureUnit
 * @property {Map<number, number>} enabled   target -> 0 or 1
 * @property {Map<number, number>} bindings  target -> texture name
 * @property {Map<number, import('./objects.js').TextureObject>} defaults
 * @property {import('./texture.js').TextureEnvironment} env
 * @property {number[]} genEnabled  per coordinate
 * @property {number[]} genModes
 * @property {number[][]} objectPlanes
 * @property {number[][]} eyePlanes
 * @property {import('./matrix.js').MatrixStack} stack
 */

/** @returns {TextureUnit} */
function createUnit(){
    return {
        enabled: new Map(TARGETS.map(target=>[target, 0])),
        bindings: new Map(TARGETS.map(target=>[target, 0])),
        defaults: new Map(TARGETS.map(target=>[target, createTextureObject(0, target)])),
        env: createTextureEnvironment(),
        genEnabled: [0, 0, 0, 0],
        genModes: [GL.EYE_LINEAR, GL.EYE_LINEAR, GL.EYE_LINEAR, GL.EYE_LINEAR],
        objectPlanes: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        eyePlanes: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        stack: createMatrixStacks().texture,
    };
}

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installTextureCalls(context, kernel){
    const { enter, setError, record, setState, diverge } = kernel;

    /** @type {TextureUnit[]} */
    const units = Array.from({ length: TEXTURE_UNITS }, createUnit);
    let active = 0;
    /** @type {number[][]} the current texture coordinates, per unit */
    const texCoords = Array.from({ length: TEXTURE_UNITS }, ()=>[0, 0, 0, 1]);

    Object.assign(kernel.side, {
        units,
        texCoords,
        activeUnit: ()=>active,
        textureStack: ()=>units[active].stack,

        /**
         * @param {number} query
         * @returns {number[] | null} the active unit's answer, or null when
         *          the query is not per unit
         */
        unitValue(query){
            const unit = units[active];
            if (unit.enabled.has(query))
            {
                const enabled = /** @type {number} */ (unit.enabled.get(query));
                return [enabled];
            }
            const coordinate = /** @type {any} */ (GEN_COORDS)[query];
            if (coordinate !== undefined)
            {
                return [unit.genEnabled[coordinate]];
            }
            for (const target of TARGETS)
            {
                if (/** @type {any} */ (BINDING_QUERY)[target] === query)
                {
                    const bound = /** @type {number} */ (unit.bindings.get(target));
                    return [bound];
                }
            }
            if (query === GL.CURRENT_TEXTURE_COORDS)
            {
                return [...texCoords[active]];
            }
            if (query === GL.ACTIVE_TEXTURE)
            {
                return [GL.TEXTURE0 + active];
            }
            return null;
        },

        /**
         * @param {number} cap
         * @param {number} value
         * @returns {boolean} whether the capability was a unit's
         */
        setUnitEnable(cap, value){
            const unit = units[active];
            if (unit.enabled.has(cap))
            {
                unit.enabled.set(cap, value);
                return true;
            }
            const coordinate = /** @type {any} */ (GEN_COORDS)[cap];
            if (coordinate !== undefined)
            {
                unit.genEnabled[coordinate] = value;
                return true;
            }
            return false;
        },

        /**
         * The units a draw samples: each enabled unit whose highest enabled
         * target has a complete texture bound, of the conventional four --
         * the fixed pipeline combines no more, and a program samples by unit
         * number from the bindings instead. An incomplete one is skipped,
         * which is the specification's "as if disabled".
         *
         * @returns {{ index: number, texture: import('./objects.js').TextureObject,
         *             unit: TextureUnit }[]}
         */
        activeTextures(){
            /** @type {{ index: number, texture: import('./objects.js').TextureObject,
             *           unit: TextureUnit }[]} */
            const out = [];
            units.forEach((unit, index)=>{
                if (index >= CONVENTIONAL_UNITS)
                {
                    return;
                }
                for (const target of [...TARGETS].reverse())
                {
                    if (unit.enabled.get(target) !== 1)
                    {
                        continue;
                    }
                    const texture = textureBound(index, target);
                    if (texture && isTextureComplete(texture))
                    {
                        out.push({ index, texture, unit });
                    }
                    break;
                }
            });
            return out;
        },

        /**
         * The texture actually bound to a unit's target, or null. Unlike the
         * internal reader this never falls back to the unit's default: a
         * fragment program sampling a unit with nothing bound has to be told
         * so, and answers the incomplete-texture value.
         *
         * @param {number} unitIndex
         * @param {number} target
         */
        textureBoundAt(unitIndex, target){
            const unit = units[unitIndex];
            if (!unit || !unit.bindings.has(target))
            {
                return null;
            }
            const name = unit.bindings.get(target) ?? 0;
            return name === 0 ? null : kernel.shareGroup().textures.objects.get(name) ?? null;
        },

        /** @param {number} mask @returns {any} */
        saveServerTextures(mask){
            if ((mask & (GL.TEXTURE_BIT | GL.ENABLE_BIT)) === 0)
            {
                return null;
            }
            return {
                active,
                units: units.map(unit=>({
                    enabled: new Map(unit.enabled),
                    bindings: new Map(unit.bindings),
                    env: structuredClone(unit.env),
                    genEnabled: [...unit.genEnabled],
                    genModes: [...unit.genModes],
                    objectPlanes: unit.objectPlanes.map(plane=>[...plane]),
                    eyePlanes: unit.eyePlanes.map(plane=>[...plane]),
                })),
            };
        },

        /** @param {number} mask @param {any} saved */
        restoreServerTextures(mask, saved){
            if (!saved)
            {
                return;
            }
            units.forEach((unit, index)=>{
                const was = saved.units[index];
                unit.enabled = new Map(was.enabled);
                unit.genEnabled = [...was.genEnabled];
                if (mask & GL.TEXTURE_BIT)
                {
                    unit.bindings = new Map(was.bindings);
                    unit.env = structuredClone(was.env);
                    unit.genModes = [...was.genModes];
                    unit.objectPlanes = was.objectPlanes.map((/** @type {number[]} */ p)=>[...p]);
                    unit.eyePlanes = was.eyePlanes.map((/** @type {number[]} */ p)=>[...p]);
                }
            });
            if (mask & GL.TEXTURE_BIT)
            {
                active = saved.active;
            }
        },
    });

    /**
     * @param {number} unitIndex
     * @param {number} target
     * @returns {import('./objects.js').TextureObject | null}
     */
    function textureBound(unitIndex, target){
        const unit = units[unitIndex];
        if (!unit.bindings.has(target))
        {
            return null;
        }
        const name = unit.bindings.get(target) ?? 0;
        if (name === 0)
        {
            return /** @type {any} */ (unit.defaults.get(target));
        }
        return kernel.shareGroup().textures.objects.get(name) ?? null;
    }

    /**
     * The texture a level-setting call addresses: a face target names the
     * cube map bound, everything else names itself.
     *
     * @param {number} target
     * @returns {{ texture: import('./objects.js').TextureObject, face: number,
     *             cube: boolean } | null}
     */
    function imageTarget(target){
        const face = CUBE_FACES.findIndex(candidate=>candidate === target);
        if (face >= 0)
        {
            const texture = textureBound(active, GL.TEXTURE_CUBE_MAP);
            return texture ? { texture, face, cube: true } : null;
        }
        if (target === GL.TEXTURE_2D || target === GL.TEXTURE_1D)
        {
            const texture = textureBound(active, target);
            return texture ? { texture, face: 0, cube: false } : null;
        }
        return null;
    }

    /**
     * Reads a program's pixels into RGBA, or reports why they cannot be.
     *
     * @param {number | Uint8Array | null} pixels
     * @param {number} width
     * @param {number} height
     * @param {number} format
     * @param {number} type
     * @returns {Uint8Array | null | 'refused'}
     */
    function readPixels(pixels, width, height, format, type){
        if (pixels === null || pixels === 0 || width === 0 || height === 0)
        {
            return null;
        }
        const unpack = {
            alignment: record(GL.UNPACK_ALIGNMENT).values[0],
            rowLength: record(GL.UNPACK_ROW_LENGTH).values[0],
            skipRows: record(GL.UNPACK_SKIP_ROWS).values[0],
            skipPixels: record(GL.UNPACK_SKIP_PIXELS).values[0],
            swapBytes: record(GL.UNPACK_SWAP_BYTES).values[0] !== 0,
        };
        const needed = imageBytes(width, height, format, type, unpack);
        if (needed === 0)
        {
            return 'refused';
        }
        const bytes = guestBytes(pixels, needed);
        if (!bytes)
        {
            return null;
        }
        const texels = unpackImage(bytes, width, height, format, type, unpack);
        return texels ?? 'refused';
    }

    /**
     * The checks glTexImage2D and glTexSubImage2D share, in the order the
     * specification lists them.
     *
     * @param {number} format
     * @param {number} type
     * @returns {boolean}
     */
    function checkPixelFormat(format, type){
        if (!PIXEL_FORMATS.has(format) || !PIXEL_TYPES.has(type))
        {
            setError(GL.INVALID_ENUM);
            return false;
        }
        if ((type === GL.BITMAP) !== (format === GL.COLOR_INDEX))
        {
            setError(GL.INVALID_ENUM);
            return false;
        }
        const packed = PACKED_TYPE_FORMATS.get(type);
        if (packed && !packed.includes(format))
        {
            setError(GL.INVALID_OPERATION);
            return false;
        }
        return true;
    }

    /**
     * Bytes a program handed over, whether as an address or as the bytes
     * themselves.
     *
     * @param {number | Uint8Array | null} data
     * @param {number} length
     * @returns {Uint8Array | null}
     */
    function guestBytes(data, length){
        if (data instanceof Uint8Array)
        {
            return data;
        }
        const memory = kernel.memory();
        return data && memory ? memory.read(data, length) : null;
    }

    /**
     * @param {string} name
     * @param {number} target
     * @param {number} level
     * @param {number} internal  the internal format
     * @param {number} width
     * @param {number} height
     * @param {number} border
     * @param {number} format
     * @param {number} type
     * @param {number | Uint8Array | null} pixels
     */
    function texImage(name, target, level, internal, width, height, border, format, type, pixels){
        const args = [target, level, internal, width, height, border, format, type];
        const isProxy = target === GL.PROXY_TEXTURE_2D || target === GL.PROXY_TEXTURE_1D;
        if (!isProxy && !imageTarget(target))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (!checkPixelFormat(format, type))
        {
            return;
        }
        const baseFormat = baseFormatOf(internal);
        if (baseFormat === null)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const maxSize = record(GL.MAX_TEXTURE_SIZE).values[0];
        if (level < 0 || border < 0 || border > 1
            || width < 0 || height < 0 || width > maxSize || height > maxSize)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (isProxy)
        {
            return;
        }
        // The data is read before the list decides anything: a compiled
        // glTexImage2D holds the pixels as they were, not the pointer.
        const texels = readPixels(pixels, width, height, format, type);
        if (texels instanceof Uint8Array && imageDigests.length < 4000)
        {
            imageDigests.push(
                `${target.toString(16)}:${level}:${width}x${height}:${hashOf(texels)}`);
        }
        if (texels === 'refused')
        {
            diverge(`glTexImage2D with format ${format} and type ${type} was accepted and`
                + ' uploaded nothing: this implementation does not read that layout');
        }
        if (!enter(name, [...args, texels === 'refused' ? null : texels]))
        {
            return;
        }
        const image = /** @type {NonNullable<ReturnType<typeof imageTarget>>} */ (
            imageTarget(target));
        if (texels instanceof Uint8Array)
        {
            conformTexels(texels, baseFormat);
        }
        image.texture.levels.set(levelKey(level, image.face), {
            width, height, internalFormat: internal, border, baseFormat,
            texels: texels instanceof Uint8Array ? texels : null,
            compressed: null,
        });
        markDirty(image.texture, levelKey(level, image.face), null);
        kernel.shareGroup().used = true;
    }

    /**
     * @param {string} name
     * @param {number} target
     * @param {number} level
     * @param {number} x0
     * @param {number} y0
     * @param {number} width
     * @param {number} height
     * @param {number} format
     * @param {number} type
     * @param {number | Uint8Array | null} pixels
     */
    function texSubImage(name, target, level, x0, y0, width, height, format, type, pixels){
        const args = [target, level, x0, y0, width, height, format, type];
        const image = imageTarget(target);
        if (!image)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (!checkPixelFormat(format, type))
        {
            return;
        }
        const existing = image.texture.levels.get(levelKey(level, image.face));
        if (!existing)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (level < 0 || width < 0 || height < 0 || x0 < 0 || y0 < 0
            || x0 + width > existing.width || y0 + height > existing.height)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const texels = readPixels(pixels, width, height, format, type);
        if (texels === 'refused')
        {
            diverge(`glTexSubImage2D with format ${format} and type ${type} was accepted and`
                + ' uploaded nothing: this implementation does not read that layout');
        }
        if (!enter(name, [...args, texels === 'refused' ? null : texels]))
        {
            return;
        }
        if (texels instanceof Uint8Array)
        {
            conformTexels(texels, existing.baseFormat);
            writeSubImage(existing, x0, y0, width, height, texels);
            // A rewritten rectangle of a level that arrived compressed no
            // longer matches its kept blocks; the decoded texels are still
            // right, so the level falls back to them rather than the stale
            // compressed bytes.
            existing.compressed = null;
            markDirty(image.texture, levelKey(level, image.face), { x: x0, y: y0, width, height });
        }
    }

    /**
     * @param {import('./objects.js').TextureLevel} level
     * @param {number} xoffset
     * @param {number} yoffset
     * @param {number} width
     * @param {number} height
     * @param {Uint8Array} texels
     */
    function writeSubImage(level, xoffset, yoffset, width, height, texels){
        if (!level.texels)
        {
            level.texels = new Uint8Array(level.width * level.height * 4);
        }
        for (let y = 0; y < height; y++)
        {
            level.texels.set(
                texels.subarray(y * width * 4, (y + 1) * width * 4),
                ((yoffset + y) * level.width + xoffset) * 4);
        }
    }

    /**
     * A rectangle of the processor's framebuffer as RGBA texels, y measured
     * from the bottom as GL measures it. The device path copies on the GPU
     * instead and never reads these bytes.
     *
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @returns {Uint8Array}
     */
    function framebufferTexels(x, y, width, height){
        const frame = kernel.framebuffer();
        const out = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row++)
        {
            const fy = frame.height - 1 - (y + row);
            for (let column = 0; column < width; column++)
            {
                const fx = x + column;
                const at = (row * width + column) * 4;
                if (fx < 0 || fx >= frame.width || fy < 0 || fy >= frame.height)
                {
                    continue;
                }
                const from = (fy * frame.width + fx) * 4;
                out[at] = frame.bytes[from + 2];
                out[at + 1] = frame.bytes[from + 1];
                out[at + 2] = frame.bytes[from];
                out[at + 3] = frame.bytes[from + 3];
            }
        }
        return out;
    }

    /**
     * @param {string} name
     * @param {number} target
     * @param {number} parameter
     * @param {number[]} values
     */
    function texParameter(name, target, parameter, values){
        if (!enter(name, [target, parameter, values]))
        {
            return;
        }
        const texture = TARGETS.some(t=>t === target) ? textureBound(active, target) : null;
        if (!texture)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const value = values[0];
        if (parameter === GL.TEXTURE_BORDER_COLOR)
        {
            texture.borderColour = [0, 1, 2, 3].map(k=>Math.min(1, Math.max(0, values[k] ?? 0)));
            return;
        }
        if (!texture.parameters.has(parameter))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (parameter === GL.TEXTURE_MIN_FILTER && !FILTERS.has(value)
            || parameter === GL.TEXTURE_MAG_FILTER && value !== GL.NEAREST && value !== GL.LINEAR
            || (parameter === GL.TEXTURE_WRAP_S || parameter === GL.TEXTURE_WRAP_T
                || parameter === GL.TEXTURE_WRAP_R) && !WRAPS.has(value))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if ((parameter === GL.TEXTURE_BASE_LEVEL || parameter === GL.TEXTURE_MAX_LEVEL)
            && value < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        texture.parameters.set(parameter, value);
        texture.parametersVersion++;
    }

    /**
     * @param {string} name
     * @param {number} target
     * @param {number} parameter
     * @returns {number[] | null}
     */
    function getTexParameter(name, target, parameter){
        if (!enter(name, [target, parameter]))
        {
            return null;
        }
        const texture = TARGETS.some(t=>t === target) ? textureBound(active, target) : null;
        if (!texture)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        if (parameter === GL.TEXTURE_BORDER_COLOR)
        {
            return [...texture.borderColour];
        }
        if (parameter === GL.TEXTURE_RESIDENT)
        {
            return [1];
        }
        if (!texture.parameters.has(parameter))
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        const value = /** @type {number} */ (texture.parameters.get(parameter));
        return [value];
    }

    /**
     * @param {string} name
     * @param {number} target
     * @param {number} parameter
     * @param {number[]} values
     */
    function texEnv(name, target, parameter, values){
        if (!enter(name, [target, parameter, values]))
        {
            return;
        }
        if (target !== GL.TEXTURE_ENV)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const env = units[active].env;
        const value = values[0];
        const combine = env.combine;
        /** @type {Record<number, [number[], number, Set<number>]>} */
        const slots = {
            [GL.SOURCE0_RGB]: [combine.sourceRgb, 0, COMBINE_SOURCES],
            [GL.SOURCE1_RGB]: [combine.sourceRgb, 1, COMBINE_SOURCES],
            [GL.SOURCE2_RGB]: [combine.sourceRgb, 2, COMBINE_SOURCES],
            [GL.SOURCE0_ALPHA]: [combine.sourceAlpha, 0, COMBINE_SOURCES],
            [GL.SOURCE1_ALPHA]: [combine.sourceAlpha, 1, COMBINE_SOURCES],
            [GL.SOURCE2_ALPHA]: [combine.sourceAlpha, 2, COMBINE_SOURCES],
            [GL.OPERAND0_RGB]: [combine.operandRgb, 0, OPERANDS_RGB],
            [GL.OPERAND1_RGB]: [combine.operandRgb, 1, OPERANDS_RGB],
            [GL.OPERAND2_RGB]: [combine.operandRgb, 2, OPERANDS_RGB],
            [GL.OPERAND0_ALPHA]: [combine.operandAlpha, 0, OPERANDS_ALPHA],
            [GL.OPERAND1_ALPHA]: [combine.operandAlpha, 1, OPERANDS_ALPHA],
            [GL.OPERAND2_ALPHA]: [combine.operandAlpha, 2, OPERANDS_ALPHA],
        };
        switch (parameter)
        {
            case GL.TEXTURE_ENV_MODE:
                if (!ENV_MODES.has(value))
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                env.mode = value;
                return;
            case GL.TEXTURE_ENV_COLOR:
                env.colour = [0, 1, 2, 3].map(k=>Math.min(1, Math.max(0, values[k] ?? 0)));
                return;
            case GL.COMBINE_RGB:
            case GL.COMBINE_ALPHA:
                if (!(parameter === GL.COMBINE_RGB ? COMBINE_RGB : COMBINE_ALPHA).has(value))
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                combine[parameter === GL.COMBINE_RGB ? 'rgb' : 'alpha'] = value;
                return;
            case GL.RGB_SCALE:
            case GL.ALPHA_SCALE:
                if (value !== 1 && value !== 2 && value !== 4)
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
                combine[parameter === GL.RGB_SCALE ? 'rgbScale' : 'alphaScale'] = value;
                return;
            default:
            {
                const slot = slots[parameter];
                if (!slot || !slot[2].has(value))
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                slot[0][slot[1]] = value;
            }
        }
    }

    /**
     * @param {string} name
     * @param {number} target
     * @param {number} parameter
     * @returns {number[] | null}
     */
    function getTexEnv(name, target, parameter){
        if (!enter(name, [target, parameter]))
        {
            return null;
        }
        if (target !== GL.TEXTURE_ENV)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        const env = units[active].env;
        const c = env.combine;
        /** @type {Record<number, number[]>} */
        const answers = {
            [GL.TEXTURE_ENV_MODE]: [env.mode],
            [GL.TEXTURE_ENV_COLOR]: [...env.colour],
            [GL.COMBINE_RGB]: [c.rgb],
            [GL.COMBINE_ALPHA]: [c.alpha],
            [GL.RGB_SCALE]: [c.rgbScale],
            [GL.ALPHA_SCALE]: [c.alphaScale],
            [GL.SOURCE0_RGB]: [c.sourceRgb[0]],
            [GL.SOURCE1_RGB]: [c.sourceRgb[1]],
            [GL.SOURCE2_RGB]: [c.sourceRgb[2]],
            [GL.SOURCE0_ALPHA]: [c.sourceAlpha[0]],
            [GL.SOURCE1_ALPHA]: [c.sourceAlpha[1]],
            [GL.SOURCE2_ALPHA]: [c.sourceAlpha[2]],
            [GL.OPERAND0_RGB]: [c.operandRgb[0]],
            [GL.OPERAND1_RGB]: [c.operandRgb[1]],
            [GL.OPERAND2_RGB]: [c.operandRgb[2]],
            [GL.OPERAND0_ALPHA]: [c.operandAlpha[0]],
            [GL.OPERAND1_ALPHA]: [c.operandAlpha[1]],
            [GL.OPERAND2_ALPHA]: [c.operandAlpha[2]],
        };
        const answer = answers[parameter];
        if (!answer)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        return answer;
    }

    /**
     * @param {string} name
     * @param {number} coord
     * @param {number} parameter
     * @param {number[]} values
     */
    function texGen(name, coord, parameter, values){
        if (!enter(name, [coord, parameter, values]))
        {
            return;
        }
        const k = /** @type {any} */ (GEN_COORD_OF)[coord];
        if (k === undefined)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const unit = units[active];
        if (parameter === GL.TEXTURE_GEN_MODE)
        {
            const modes = [GL.OBJECT_LINEAR, GL.EYE_LINEAR, GL.SPHERE_MAP, GL.REFLECTION_MAP,
                GL.NORMAL_MAP];
            if (!modes.some(mode=>mode === values[0])
                || values[0] === GL.SPHERE_MAP && k > 1
                || (values[0] === GL.REFLECTION_MAP || values[0] === GL.NORMAL_MAP) && k > 2)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            unit.genModes[k] = values[0];
            return;
        }
        if (parameter === GL.OBJECT_PLANE)
        {
            unit.objectPlanes[k] = [0, 1, 2, 3].map(i=>values[i] ?? 0);
            return;
        }
        if (parameter === GL.EYE_PLANE)
        {
            // Fixed in eye space by the modelview current now, like a light.
            const inverse = inverseTransposeOf(kernel.stacks.modelview.current);
            const plane = [0, 1, 2, 3].map(i=>values[i] ?? 0);
            unit.eyePlanes[k] = [0, 1, 2, 3].map(row=>plane[0] * inverse[row]
                + plane[1] * inverse[4 + row] + plane[2] * inverse[8 + row]
                + plane[3] * inverse[12 + row]);
            return;
        }
        setError(GL.INVALID_ENUM);
    }

    /**
     * @param {string} name
     * @param {number} coord
     * @param {number} parameter
     * @returns {number[] | null}
     */
    function getTexGen(name, coord, parameter){
        if (!enter(name, [coord, parameter]))
        {
            return null;
        }
        const k = /** @type {any} */ (GEN_COORD_OF)[coord];
        const unit = units[active];
        if (k === undefined)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        switch (parameter)
        {
            case GL.TEXTURE_GEN_MODE:
                return [unit.genModes[k]];
            case GL.OBJECT_PLANE:
                return [...unit.objectPlanes[k]];
            case GL.EYE_PLANE:
                return [...unit.eyePlanes[k]];
            default:
                setError(GL.INVALID_ENUM);
                return null;
        }
    }

    /**
     * @param {string} name
     * @param {number} target
     * @param {number} level
     * @param {number} internal  the internal format
     * @param {number} width
     * @param {number} height
     * @param {number} border
     * @param {number} size  the compressed bytes the program says it passed
     * @param {number | Uint8Array | null} data
     */
    function compressedTexImage(name, target, level, internal, width, height, border, size, data){
        const image = imageTarget(target);
        if (!image)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (!S3TC_FORMATS.has(internal))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const maxSize = record(GL.MAX_TEXTURE_SIZE).values[0];
        if (level < 0 || border !== 0 || width < 0 || height < 0 || width > maxSize
            || height > maxSize || size !== compressedBytes(internal, width, height))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const bytes = guestBytes(data, size);
        if (bytes)
        {
            digestBlocks(bytes);
        }
        const texels = bytes && width > 0 && height > 0
            ? decodeS3tc(bytes, internal, width, height)
            : null;
        const args = [target, level, internal, width, height, border, size, texels];
        if (!enter(name, args))
        {
            return;
        }
        image.texture.levels.set(levelKey(level, image.face), {
            width, height, internalFormat: internal, border,
            baseFormat: /** @type {number} */ (baseFormatOf(internal)),
            texels,
            compressedFormat: internal,
            compressedBytes: size,
            compressed: bytes ? { format: internal, bytes } : null,
        });
        markDirty(image.texture, levelKey(level, image.face), null);
        kernel.shareGroup().used = true;
    }

    Object.assign(context, {
        /** @param {number} count @returns {number[]} */
        glGenTextures(count){
            if (!enter('glGenTextures', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            return kernel.shareGroup().textures.reserve(count);
        },

        /** @param {number} target @param {number} name */
        glBindTexture(target, name){
            if (!enter('glBindTexture', [target, name]))
            {
                return;
            }
            const unit = units[active];
            if (!unit.bindings.has(target))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (name === 0)
            {
                unit.bindings.set(target, 0);
                return;
            }
            const group = kernel.shareGroup();
            const existing = group.textures.objects.get(name);
            if (existing && existing.target !== target)
            {
                // A name belongs to the target it was first bound to, for life.
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (!existing)
            {
                group.textures.define(name, createTextureObject(name, target));
                group.used = true;
            }
            unit.bindings.set(target, name);
        },

        /** @param {number[]} names */
        glDeleteTextures(names){
            if (!enter('glDeleteTextures', [names]))
            {
                return;
            }
            const group = kernel.shareGroup();
            for (const name of names)
            {
                if (name === 0)
                {
                    // Silently ignored, not an error: programs delete arrays
                    // they only partly filled.
                    continue;
                }
                const texture = group.textures.objects.get(name);
                group.textures.remove(name);
                if (!texture)
                {
                    continue;
                }
                // Deleting a bound texture rebinds the default object, in
                // every unit that had it.
                for (const unit of units)
                {
                    if (unit.bindings.get(texture.target) === name)
                    {
                        unit.bindings.set(texture.target, 0);
                    }
                }
            }
        },

        /** @param {number} name @returns {number} */
        glIsTexture(name){
            if (!enter('glIsTexture', [name]))
            {
                return GL.FALSE;
            }
            // A generated name is not a texture until it has been bound, and
            // asking about a name that was never generated is not an error.
            return kernel.shareGroup().textures.objects.has(name) ? GL.TRUE : GL.FALSE;
        },

        /**
         * @param {number[]} names
         * @returns {number} GL_TRUE: everything here is always resident
         */
        glAreTexturesResident(names){
            if (!enter('glAreTexturesResident', [names]))
            {
                return GL.FALSE;
            }
            const group = kernel.shareGroup();
            if (names.some(name=>name === 0 || !group.textures.objects.has(name)))
            {
                setError(GL.INVALID_VALUE);
                return GL.FALSE;
            }
            return GL.TRUE;
        },

        /** @param {number[]} names @param {number[]} priorities */
        glPrioritizeTextures(names, priorities){
            if (!enter('glPrioritizeTextures', [names, priorities]))
            {
                return;
            }
            const group = kernel.shareGroup();
            names.forEach((name, index)=>{
                group.textures.objects.get(name)?.parameters.set(
                    GL.TEXTURE_PRIORITY, Math.min(1, Math.max(0, priorities[index] ?? 0)));
            });
        },

        /** @param {number} target @param {number} parameter @param {number} value */
        glTexParameteri(target, parameter, value){
            texParameter('glTexParameteri', target, parameter, [value]);
        },

        /** @param {number} target @param {number} parameter @param {number} value */
        glTexParameterf(target, parameter, value){
            texParameter('glTexParameterf', target, parameter, [value]);
        },

        /** @param {number} target @param {number} parameter @param {number[]} values */
        glTexParameterfv(target, parameter, values){
            texParameter('glTexParameterfv', target, parameter, values);
        },

        /** @param {number} target @param {number} parameter @returns {number[] | null} */
        glGetTexParameteriv(target, parameter){
            return getTexParameter('glGetTexParameteriv', target, parameter);
        },

        /** @param {number} target @param {number} parameter @returns {number[] | null} */
        glGetTexParameterfv(target, parameter){
            return getTexParameter('glGetTexParameterfv', target, parameter);
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} parameter
         * @returns {number[] | null}
         */
        glGetTexLevelParameteriv(target, level, parameter){
            if (!enter('glGetTexLevelParameteriv', [target, level, parameter]))
            {
                return null;
            }
            const image = imageTarget(target);
            if (!image || level < 0)
            {
                setError(image ? GL.INVALID_VALUE : GL.INVALID_ENUM);
                return null;
            }
            const stored = image.texture.levels.get(levelKey(level, image.face));
            const width = stored?.width ?? 0;
            const height = stored?.height ?? 0;
            const base = stored?.baseFormat ?? GL.RGBA;
            const hasAlpha = base === GL.RGBA || base === GL.LUMINANCE_ALPHA || base === GL.ALPHA
                || base === GL.INTENSITY;
            const hasColour = base !== GL.ALPHA;
            switch (parameter)
            {
                case GL.TEXTURE_WIDTH:
                    return [width];
                case GL.TEXTURE_HEIGHT:
                    return [height];
                case GL.TEXTURE_INTERNAL_FORMAT:
                    return [stored?.internalFormat ?? 1];
                case GL.TEXTURE_RED_SIZE:
                case GL.TEXTURE_GREEN_SIZE:
                case GL.TEXTURE_BLUE_SIZE:
                    return [stored && hasColour ? 8 : 0];
                case GL.TEXTURE_ALPHA_SIZE:
                    return [stored && hasAlpha ? 8 : 0];
                case GL.TEXTURE_COMPRESSED:
                    return [stored?.compressedFormat ? 1 : 0];
                case GL.TEXTURE_COMPRESSED_IMAGE_SIZE:
                    if (!stored?.compressedFormat)
                    {
                        setError(GL.INVALID_OPERATION);
                        return null;
                    }
                    return [stored.compressedBytes ?? 0];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} internal  the internal format
         * @param {number} width
         * @param {number} height
         * @param {number} border
         * @param {number} format
         * @param {number} type
         * @param {number | Uint8Array | null} [pixels]
         */
        glTexImage2D(target, level, internal, width, height, border, format, type, pixels){
            if (target === GL.TEXTURE_1D || target === GL.PROXY_TEXTURE_1D)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texImage('glTexImage2D', target, level, internal, width, height, border,
                format, type, pixels ?? null);
        },

        /**
         * A one-dimensional image is a row: the same object with a height of
         * one, sampled along s alone.
         *
         * @param {number} target
         * @param {number} level
         * @param {number} internalFormat
         * @param {number} width
         * @param {number} border
         * @param {number} format
         * @param {number} type
         * @param {number | Uint8Array | null} [pixels]
         */
        glTexImage1D(target, level, internalFormat, width, border, format, type, pixels = null){
            if (target !== GL.TEXTURE_1D && target !== GL.PROXY_TEXTURE_1D)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texImage('glTexImage1D', target, level, internalFormat, width, 1, border, format,
                type, pixels);
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} x0
         * @param {number} y0
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {number} type
         * @param {number | Uint8Array | null} [pixels]
         */
        glTexSubImage2D(target, level, x0, y0, width, height, format, type, pixels){
            if (target === GL.TEXTURE_1D)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texSubImage('glTexSubImage2D', target, level, x0, y0, width, height, format, type,
                pixels ?? null);
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} xoffset
         * @param {number} width
         * @param {number} format
         * @param {number} type
         * @param {number | Uint8Array | null} [pixels]
         */
        glTexSubImage1D(target, level, xoffset, width, format, type, pixels = null){
            if (target !== GL.TEXTURE_1D)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texSubImage('glTexSubImage1D', target, level, xoffset, 0, width, 1, format, type,
                pixels);
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} internalFormat
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         * @param {number} border
         */
        glCopyTexImage2D(target, level, internalFormat, x, y, width, height, border){
            const args = [target, level, internalFormat, x, y, width, height, border];
            const image = imageTarget(target);
            const baseFormat = baseFormatOf(internalFormat);
            if (!image)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (baseFormat === null || level < 0 || border < 0 || border > 1 || width < 0
                || height < 0 || width > record(GL.MAX_TEXTURE_SIZE).values[0])
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (kernel.gpuBacked())
            {
                // The level's pixels live on the device, so it is given a shape
                // with no texels and copied there. Marking it dirty would have
                // the next draw upload these absent texels over the copy.
                if (!enter('glCopyTexImage2D', [...args, null]))
                {
                    return;
                }
                image.texture.levels.set(levelKey(level, image.face),
                    { width, height, internalFormat, border, baseFormat, texels: null });
                kernel.copyToTexture?.(image.texture, level, image.face, 0, 0, x, y, width, height);
                kernel.shareGroup().used = true;
                return;
            }
            const texels = framebufferTexels(x, y, width, height);
            if (!enter('glCopyTexImage2D', [...args, texels]))
            {
                return;
            }
            conformTexels(texels, baseFormat);
            image.texture.levels.set(levelKey(level, image.face),
                { width, height, internalFormat, border, baseFormat, texels, compressed: null });
            markDirty(image.texture, levelKey(level, image.face), null);
            kernel.shareGroup().used = true;
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} xoffset
         * @param {number} yoffset
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         */
        glCopyTexSubImage2D(target, level, xoffset, yoffset, x, y, width, height){
            const args = [target, level, xoffset, yoffset, x, y, width, height];
            const image = imageTarget(target);
            if (!image)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const existing = image.texture.levels.get(levelKey(level, image.face));
            if (!existing)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (width < 0 || height < 0 || xoffset < 0 || yoffset < 0
                || xoffset + width > existing.width || yoffset + height > existing.height)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (kernel.gpuBacked())
            {
                // The copy lands on the device, into the level as it already
                // stands there. Not marked dirty, or the next draw would upload
                // the processor's texels over what the copy wrote.
                if (!enter('glCopyTexSubImage2D', [...args, null]))
                {
                    return;
                }
                kernel.copyToTexture?.(image.texture, level, image.face, xoffset, yoffset, x, y,
                    width, height);
                return;
            }
            const texels = framebufferTexels(x, y, width, height);
            if (!enter('glCopyTexSubImage2D', [...args, texels]))
            {
                return;
            }
            conformTexels(texels, existing.baseFormat);
            writeSubImage(existing, xoffset, yoffset, width, height, texels);
            existing.compressed = null;
            markDirty(image.texture, levelKey(level, image.face), { x: xoffset, y: yoffset,
                width, height });
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} format
         * @param {number} type
         * @returns {Uint8Array | null} the level's texels as RGBA bytes; the
         *          caller packs them into the format asked for
         */
        glGetTexImage(target, level, format, type){
            if (!enter('glGetTexImage', [target, level, format, type]))
            {
                return null;
            }
            const image = imageTarget(target);
            if (!image || !checkPixelFormat(format, type))
            {
                if (!image)
                {
                    setError(GL.INVALID_ENUM);
                }
                return null;
            }
            const stored = image.texture.levels.get(levelKey(level, image.face));
            if (!stored)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return stored.texels ?? new Uint8Array(stored.width * stored.height * 4);
        },

        /** @param {number} target @param {number} parameter @param {number} value */
        glTexEnvi(target, parameter, value){
            texEnv('glTexEnvi', target, parameter, [value]);
        },

        /** @param {number} target @param {number} parameter @param {number} value */
        glTexEnvf(target, parameter, value){
            texEnv('glTexEnvf', target, parameter, [value]);
        },

        /** @param {number} target @param {number} parameter @param {number[]} values */
        glTexEnvfv(target, parameter, values){
            texEnv('glTexEnvfv', target, parameter, values);
        },

        /** @param {number} target @param {number} parameter @returns {number[] | null} */
        glGetTexEnviv(target, parameter){
            return getTexEnv('glGetTexEnviv', target, parameter);
        },

        /** @param {number} target @param {number} parameter @returns {number[] | null} */
        glGetTexEnvfv(target, parameter){
            return getTexEnv('glGetTexEnvfv', target, parameter);
        },

        /** @param {number} coord @param {number} parameter @param {number} value */
        glTexGeni(coord, parameter, value){
            texGen('glTexGeni', coord, parameter, [value]);
        },

        /** @param {number} coord @param {number} parameter @param {number[]} values */
        glTexGenfv(coord, parameter, values){
            texGen('glTexGenfv', coord, parameter, values);
        },

        /** @param {number} coord @param {number} parameter @returns {number[] | null} */
        glGetTexGenfv(coord, parameter){
            return getTexGen('glGetTexGenfv', coord, parameter);
        },

        /** @param {number} target @returns {boolean} */
        isTextureComplete(target){
            const texture = textureBound(active, target);
            return !!texture && isTextureComplete(texture);
        },

        // --- GL_ARB_multitexture ---

        /** @param {number} unit */
        glActiveTextureARB(unit){
            if (!enter('glActiveTextureARB', [unit]))
            {
                return;
            }
            if (unit < GL.TEXTURE0 || unit >= GL.TEXTURE0 + TEXTURE_UNITS)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            active = unit - GL.TEXTURE0;
            setState(GL.ACTIVE_TEXTURE, [unit]);
        },

        /**
         * @param {number} unit
         * @param {number} s
         * @param {number} t
         * @param {number} r
         * @param {number} q
         */
        glMultiTexCoord4fARB(unit, s, t, r, q){
            if (!enter('glMultiTexCoord4fARB', [unit, s, t, r, q]))
            {
                return;
            }
            if (unit < GL.TEXTURE0 || unit >= GL.TEXTURE0 + TEXTURE_UNITS)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texCoords[unit - GL.TEXTURE0] = [s, t, r, q];
        },

        // --- GL_ARB_texture_compression ---

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} internal  the internal format
         * @param {number} width
         * @param {number} height
         * @param {number} border
         * @param {number} size
         * @param {number | Uint8Array | null} [data]
         */
        glCompressedTexImage2DARB(target, level, internal, width, height, border, size, data){
            compressedTexImage('glCompressedTexImage2DARB', target, level, internal, width,
                height, border, size, data ?? null);
        },

        /**
         * Rewrites a rectangle of an S3TC level. The decoded texels are
         * written into the RGBA image, which is what sampling reads.
         *
         * @param {number} target
         * @param {number} level
         * @param {number} x0
         * @param {number} y0
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {number} size
         * @param {number | Uint8Array | null} [data]
         */
        glCompressedTexSubImage2DARB(target, level, x0, y0, width, height, format, size, data){
            const image = imageTarget(target);
            if (!image || !S3TC_FORMATS.has(format))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const existing = image.texture.levels.get(levelKey(level, image.face));
            if (!existing || existing.compressedFormat !== format)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (x0 % 4 !== 0 || y0 % 4 !== 0 || x0 + width > existing.width
                || y0 + height > existing.height || size !== compressedBytes(format, width, height))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const bytes = guestBytes(data ?? null, size);
            const texels = bytes ? decodeS3tc(bytes, format, width, height) : null;
            const args = [target, level, x0, y0, width, height, format, size, texels];
            if (!enter('glCompressedTexSubImage2DARB', args))
            {
                return;
            }
            if (texels)
            {
                writeSubImage(existing, x0, y0, width, height, texels);
                // The rectangle arrived decoded, so the level's kept blocks no
                // longer match it: the whole texture falls back to the
                // decoded path rather than travel as blocks with a hole in them.
                existing.compressed = null;
                markDirty(image.texture, levelKey(level, image.face), { x: x0, y: y0,
                    width, height });
            }
        },

        /**
         * The compressed bytes are not kept, only their decoding, so there is
         * nothing to hand back: an operation error, and a divergence, because
         * the real driver would have answered.
         *
         * @param {number} target
         * @param {number} level
         * @returns {null}
         */
        glGetCompressedTexImageARB(target, level){
            if (!enter('glGetCompressedTexImageARB', [target, level]))
            {
                return null;
            }
            diverge('glGetCompressedTexImage was refused: compressed levels are kept decoded'
                + ' and the original blocks are gone');
            setError(GL.INVALID_OPERATION);
            return null;
        },

        /**
         * The one-dimensional and three-dimensional compressed forms name
         * targets this implementation has no images for.
         *
         * @param {number} target
         */
        glCompressedTexImage1DARB(target){
            enter('glCompressedTexImage1DARB', [target]);
            setError(GL.INVALID_ENUM);
        },

        /** @param {number} target */
        glCompressedTexImage3DARB(target){
            enter('glCompressedTexImage3DARB', [target]);
            setError(GL.INVALID_ENUM);
        },

        /** @param {number} target */
        glCompressedTexSubImage1DARB(target){
            enter('glCompressedTexSubImage1DARB', [target]);
            setError(GL.INVALID_ENUM);
        },

        /** @param {number} target */
        glCompressedTexSubImage3DARB(target){
            enter('glCompressedTexSubImage3DARB', [target]);
            setError(GL.INVALID_ENUM);
        },
    });
}

/**
 * The inverse transpose of a 4x4 matrix, for carrying a plane into eye
 * space. Gauss-Jordan on a small matrix; singular ones give the identity.
 *
 * @param {ArrayLike<number>} m  column major
 * @returns {number[]} column major
 */
export function inverseTransposeOf(m){
    const a = Array.from({ length: 4 }, (unused, row)=>[
        m[row], m[4 + row], m[8 + row], m[12 + row],
        row === 0 ? 1 : 0, row === 1 ? 1 : 0, row === 2 ? 1 : 0, row === 3 ? 1 : 0,
    ]);
    for (let column = 0; column < 4; column++)
    {
        let pivot = column;
        for (let row = column + 1; row < 4; row++)
        {
            if (Math.abs(a[row][column]) > Math.abs(a[pivot][column]))
            {
                pivot = row;
            }
        }
        if (a[pivot][column] === 0)
        {
            return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        }
        [a[column], a[pivot]] = [a[pivot], a[column]];
        const scale = a[column][column];
        for (let k = 0; k < 8; k++)
        {
            a[column][k] /= scale;
        }
        for (let row = 0; row < 4; row++)
        {
            if (row === column)
            {
                continue;
            }
            const factor = a[row][column];
            for (let k = 0; k < 8; k++)
            {
                a[row][k] -= factor * a[column][k];
            }
        }
    }
    // The inverse's row r, column c is a[r][4 + c]; its transpose in column
    // major order puts that at index r * 4 + c.
    const out = [];
    for (let r = 0; r < 4; r++)
    {
        for (let c = 0; c < 4; c++)
        {
            out.push(a[r][4 + c]);
        }
    }
    return out;
}

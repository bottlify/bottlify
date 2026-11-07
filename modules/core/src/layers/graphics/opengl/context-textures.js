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
import {
    BUFFER_ROW, createTextureObject, isTextureComplete, levelKey, markDirty,
} from './objects.js';
import { createMatrixStacks } from './matrix.js';
import { CONVENTIONAL_UNITS, TEXTURE_UNITS } from './state.js';
import {
    baseFormatOf, compressedBytes, conformTexels, createTextureEnvironment, decodeS3tc,
    imageBytes, unpackImage,
} from './texture.js';
import { SIZED_FORMATS, TEX, modelTexelBytes, sizedFormatOf } from './formats.js';
import {
    clientBytes, decodeClient, decodeStorage, encodeStorage, packFromStorage, transferError,
    unpackToStorage,
} from './texture-transfer.js';
import {
    blankStorage, copyBox, rgbaOf, sizedLevelAnswer, storageBytes, uncompressedTwin,
} from './texture-levels.js';
import {
    S3TC_BLOCK_BYTES, UNSIZED_FORMATS, copyCompatible, copyFormatOf, mipLevels, rawFromKept,
    rawIntoKept,
} from './texture-copy.js';

/** glGetTexParameter's names for what glTexStorage makes (OpenGL 4.2, GL_ARB_texture_storage). */
export const TEXTURE_IMMUTABLE_FORMAT = 0x912f;
export const TEXTURE_IMMUTABLE_LEVELS = 0x82df;

/**
 * The levels glTexStorage gave a texture, which no image call may change the
 * shape of from then on (section 8.19). Kept beside the object rather than in
 * its parameters, which glTexParameter writes. Shared by every context of a
 * share group, as the textures are.
 *
 * @type {WeakMap<import('./objects.js').TextureObject, number>}
 */
const immutableLevels = new WeakMap();

/**
 * The calls of the texture storage, copy, clear and read-back extensions a
 * display list does not record: they run as they are reached. Each names
 * its texture or its images itself, and a list replayed later would find
 * other objects under those names.
 */
export const TEXTURE_CALLS_NOT_COMPILED = Object.freeze([
    'glTexStorage1D', 'glTexStorage2D', 'glTexStorage3D', 'glCopyImageSubData',
    'glClearTexImage', 'glClearTexSubImage', 'glGetTextureSubImage',
    'glGetCompressedTextureSubImage', 'glTexBuffer', 'glTexBufferRange',
]);


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

/** When each of `imageDigests` was uploaded, in epoch ms, as the harness times presents. @type {number[]} */
export const imageTimes = [];

/**
 * The texels of chosen uploads, by their index in `imageDigests`: which ones
 * a run asked for, and those it got. A digest says two images differ; this
 * is what shows how.
 * @type {{ at: Set<number>,
 *     images: { index: number, width: number, height: number, texels: Uint8Array }[] }}
 */
export const keptImages = { at: new Set(), images: [] };

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
const TARGETS = [GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_RECTANGLE, GL.TEXTURE_CUBE_MAP];
/** The targets from the highest precedence down, as a unit's enabled target is chosen. */
const TARGETS_HIGHEST_FIRST = [...TARGETS].reverse();
/**
 * Every target a unit binds a texture to: the enabled ones, and those only a
 * program samples -- 3D textures and the arrays of OpenGL 3.0.
 */
const BIND_TARGETS = [...TARGETS, GL.TEXTURE_3D, TEX.TEXTURE_1D_ARRAY, TEX.TEXTURE_2D_ARRAY,
    GL.TEXTURE_BUFFER];

/**
 * The formats a buffer texture's texels are in (3.1 table 3.15, 4.3 table
 * 8.16): each its components' own bytes, one after another.
 *
 * @type {ReadonlySet<number>}
 */
const BUFFER_FORMATS = new Set([
    TEX.R8, TEX.R16, TEX.R16F, TEX.R32F, TEX.R8I, TEX.R16I, TEX.R32I, TEX.R8UI, TEX.R16UI,
    TEX.R32UI, TEX.RG8, TEX.RG16, TEX.RG16F, TEX.RG32F, TEX.RG8I, TEX.RG16I, TEX.RG32I,
    TEX.RG8UI, TEX.RG16UI, TEX.RG32UI, TEX.RGB32F, TEX.RGB32I, TEX.RGB32UI, GL.RGBA8,
    GL.RGBA16, TEX.RGBA16F, TEX.RGBA32F, TEX.RGBA8I, TEX.RGBA16I, TEX.RGBA32I, TEX.RGBA8UI,
    TEX.RGBA16UI, TEX.RGBA32UI,
]);

/**
 * A buffer texture's texel in its buffer: its components' bytes, three where
 * the format has three.
 *
 * @param {import('./formats.js').SizedFormat} sized
 */
const bufferTexelBytes = sized=>(sized.base === GL.RED ? 1 : sized.base === TEX.RG ? 2
    : sized.base === GL.RGB ? 3 : 4) * sized.bits[0] / 8;


const BINDING_QUERY = Object.freeze({
    [GL.TEXTURE_1D]: GL.TEXTURE_BINDING_1D,
    [GL.TEXTURE_2D]: GL.TEXTURE_BINDING_2D,
    [GL.TEXTURE_RECTANGLE]: GL.TEXTURE_BINDING_RECTANGLE,
    [GL.TEXTURE_CUBE_MAP]: GL.TEXTURE_BINDING_CUBE_MAP,
    [GL.TEXTURE_3D]: TEX.TEXTURE_BINDING_3D,
    [TEX.TEXTURE_1D_ARRAY]: TEX.TEXTURE_BINDING_1D_ARRAY,
    [TEX.TEXTURE_2D_ARRAY]: TEX.TEXTURE_BINDING_2D_ARRAY,
    [GL.TEXTURE_BUFFER]: GL.TEXTURE_BINDING_BUFFER,
});

/**
 * The targets each image call names, proxies included (OpenGL 4.6 section 8.5).
 *
 * @type {Record<1 | 2 | 3, ReadonlySet<number>>}
 */
const IMAGE_TARGETS = {
    1: new Set([GL.TEXTURE_1D, GL.PROXY_TEXTURE_1D]),
    2: new Set([GL.TEXTURE_2D, GL.PROXY_TEXTURE_2D, TEX.TEXTURE_1D_ARRAY,
        TEX.PROXY_TEXTURE_1D_ARRAY, GL.PROXY_TEXTURE_CUBE_MAP, 0x8515, 0x8516, 0x8517, 0x8518,
        0x8519, 0x851a, GL.TEXTURE_RECTANGLE, GL.PROXY_TEXTURE_RECTANGLE]),
    3: new Set([GL.TEXTURE_3D, GL.PROXY_TEXTURE_3D, TEX.TEXTURE_2D_ARRAY,
        TEX.PROXY_TEXTURE_2D_ARRAY]),
};
/** @type {ReadonlySet<number>} */
const PROXIES = new Set([GL.PROXY_TEXTURE_1D, GL.PROXY_TEXTURE_2D, GL.PROXY_TEXTURE_3D,
    GL.PROXY_TEXTURE_CUBE_MAP, TEX.PROXY_TEXTURE_1D_ARRAY, TEX.PROXY_TEXTURE_2D_ARRAY,
    GL.PROXY_TEXTURE_RECTANGLE]);

/** The rectangle targets (3.1), whose one level is level zero. @type {ReadonlySet<number>} */
const RECTANGLES = new Set([GL.TEXTURE_RECTANGLE, GL.PROXY_TEXTURE_RECTANGLE]);

/** The filters a rectangle texture takes: none reads a mipmap. @type {ReadonlySet<number>} */
const RECTANGLE_FILTERS = new Set([GL.NEAREST, GL.LINEAR]);
/** The targets whose third dimension is a layer, not a depth. @type {ReadonlySet<number>} */
const ARRAYS = new Set([TEX.TEXTURE_1D_ARRAY, TEX.TEXTURE_2D_ARRAY]);

/** @type {ReadonlySet<number>} */
const COMPARE_FUNCS = new Set([0x200, 0x201, 0x202, 0x203, 0x204, 0x205, 0x206, 0x207]);
/** @type {ReadonlySet<number>} */
const DEPTH_TEXTURE_MODES = new Set([GL.LUMINANCE, GL.INTENSITY, GL.ALPHA, GL.RED]);

/**
 * What a level kept as a sized format reduces to for the fixed pipeline's
 * texture environment, which knows the formats of OpenGL 1.x: red and
 * red-green textures combine as RGB (their missing components read zero and
 * alpha one, OpenGL 3.0 table 3.20), depth and stencil keep their own.
 *
 * @param {import('./formats.js').SizedFormat} sized
 * @returns {number}
 */
const environmentBase = sized=>(sized.base === GL.RED || sized.base === TEX.RG
    ? GL.RGB : sized.base);

/** The RGBA bytes made from a sized level's data, while that data is unchanged. */
/** @type {WeakMap<object, Uint8Array | null>} */
const rgbaCache = new WeakMap();

/**
 * Pixels a list holds already in the level's own layout: replayed, they are
 * stored as they are rather than read again through the unpack state.
 *
 * @typedef {{ stored: Uint8Array }} StoredPixels
 */

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

/** The swizzle parameters (3.3), red to alpha, and what each may take. */
/** @type {readonly number[]} */
const SWIZZLE_PARAMETERS = [GL.TEXTURE_SWIZZLE_R, GL.TEXTURE_SWIZZLE_G, GL.TEXTURE_SWIZZLE_B,
    GL.TEXTURE_SWIZZLE_A];
/** @type {ReadonlySet<number>} */
const SWIZZLE_SOURCES = new Set([GL.RED, GL.GREEN, GL.BLUE, GL.ALPHA, GL.ZERO, GL.ONE]);

/**
 * Whether a value is one a sampling parameter takes: the filters, the wraps
 * and the comparison, which a texture and a sampler object (3.3) share.
 * Zero when it is, GL_INVALID_ENUM when it is not; any other parameter is not
 * this function's to judge.
 *
 * @param {number} parameter @param {number} value
 * @returns {number}
 */
export function samplingRefusal(parameter, value){
    return parameter === GL.TEXTURE_MIN_FILTER && !FILTERS.has(value)
        || parameter === GL.TEXTURE_MAG_FILTER && value !== GL.NEAREST && value !== GL.LINEAR
        || (parameter === GL.TEXTURE_WRAP_S || parameter === GL.TEXTURE_WRAP_T
            || parameter === GL.TEXTURE_WRAP_R) && !WRAPS.has(value)
        || parameter === TEX.TEXTURE_COMPARE_MODE && value !== GL.NONE
            && value !== TEX.COMPARE_REF_TO_TEXTURE
        || parameter === TEX.TEXTURE_COMPARE_FUNC && !COMPARE_FUNCS.has(value)
        || SWIZZLE_PARAMETERS.includes(parameter) && !SWIZZLE_SOURCES.has(value)
        ? GL.INVALID_ENUM
        : parameter === GL.TEXTURE_MAX_ANISOTROPY && !(value >= 1) ? GL.INVALID_VALUE : 0;
}

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

/**
 * The combiner's per-argument parameters glTexEnv sets: which array of the
 * unit's combine state, the argument's place in it, and the values it takes.
 *
 * @type {Map<number, ['sourceRgb' | 'sourceAlpha' | 'operandRgb' | 'operandAlpha', number,
 *     Set<number>]>}
 */
const COMBINE_SLOTS = new Map([
    [GL.SOURCE0_RGB, ['sourceRgb', 0, COMBINE_SOURCES]],
    [GL.SOURCE1_RGB, ['sourceRgb', 1, COMBINE_SOURCES]],
    [GL.SOURCE2_RGB, ['sourceRgb', 2, COMBINE_SOURCES]],
    [GL.SOURCE0_ALPHA, ['sourceAlpha', 0, COMBINE_SOURCES]],
    [GL.SOURCE1_ALPHA, ['sourceAlpha', 1, COMBINE_SOURCES]],
    [GL.SOURCE2_ALPHA, ['sourceAlpha', 2, COMBINE_SOURCES]],
    [GL.OPERAND0_RGB, ['operandRgb', 0, OPERANDS_RGB]],
    [GL.OPERAND1_RGB, ['operandRgb', 1, OPERANDS_RGB]],
    [GL.OPERAND2_RGB, ['operandRgb', 2, OPERANDS_RGB]],
    [GL.OPERAND0_ALPHA, ['operandAlpha', 0, OPERANDS_ALPHA]],
    [GL.OPERAND1_ALPHA, ['operandAlpha', 1, OPERANDS_ALPHA]],
    [GL.OPERAND2_ALPHA, ['operandAlpha', 2, OPERANDS_ALPHA]],
]);

/** @type {Set<number>} */
const S3TC_FORMATS = new Set([
    GL.COMPRESSED_RGB_S3TC_DXT1_EXT, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT,
    GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT,
]);

/** The sized entry of RGBA8, the layout of a legacy level's RGBA bytes. */
const RGBA8 = /** @type {import('./formats.js').SizedFormat} */ (SIZED_FORMATS.get(GL.RGBA8));

/**
 * The targets each glTexStorage call names, proxies included (section 8.19).
 *
 * @type {Record<1 | 2 | 3, ReadonlySet<number>>}
 */
const STORAGE_TARGETS = {
    1: new Set([GL.TEXTURE_1D, GL.PROXY_TEXTURE_1D]),
    2: new Set([GL.TEXTURE_2D, GL.PROXY_TEXTURE_2D, TEX.TEXTURE_1D_ARRAY,
        TEX.PROXY_TEXTURE_1D_ARRAY, GL.TEXTURE_CUBE_MAP, GL.PROXY_TEXTURE_CUBE_MAP,
        GL.TEXTURE_RECTANGLE, GL.PROXY_TEXTURE_RECTANGLE]),
    3: new Set([GL.TEXTURE_3D, GL.PROXY_TEXTURE_3D, TEX.TEXTURE_2D_ARRAY,
        TEX.PROXY_TEXTURE_2D_ARRAY]),
};

/** The target each proxy stands for. @type {ReadonlyMap<number, number>} */
const PROXY_TARGETS = new Map([
    [GL.PROXY_TEXTURE_1D, GL.TEXTURE_1D], [GL.PROXY_TEXTURE_2D, GL.TEXTURE_2D],
    [GL.PROXY_TEXTURE_3D, GL.TEXTURE_3D], [GL.PROXY_TEXTURE_CUBE_MAP, GL.TEXTURE_CUBE_MAP],
    [TEX.PROXY_TEXTURE_1D_ARRAY, TEX.TEXTURE_1D_ARRAY],
    [TEX.PROXY_TEXTURE_2D_ARRAY, TEX.TEXTURE_2D_ARRAY],
    [GL.PROXY_TEXTURE_RECTANGLE, GL.TEXTURE_RECTANGLE],
]);

/**
 * The targets glCopyImageSubData names an image by (section 18.3.3): a
 * renderbuffer, or a texture target that is no proxy, no buffer and no
 * cube's face. The rectangle, cube array and multisample targets are among
 * them though no texture here is ever one: a name given with them is no
 * object of theirs.
 *
 * @type {ReadonlySet<number>}
 */
const COPY_TARGETS = new Set([GL.RENDERBUFFER, GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D,
    TEX.TEXTURE_1D_ARRAY, TEX.TEXTURE_2D_ARRAY, GL.TEXTURE_CUBE_MAP, 0x84f5, 0x9009, 0x9100,
    0x9102]);

/**
 * One image glCopyImageSubData reads or writes: a renderbuffer, or a level
 * of a texture, with its extent as the call addresses it (a 1D array's
 * layers its height, a cube's faces and an array's layers its depth).
 *
 * @typedef {{ texture?: import('./objects.js').TextureObject,
 *     renderbuffer?: import('./objects.js').RenderbufferObject, level: number,
 *     cube: boolean, format: import('./texture-copy.js').CopyFormat, width: number,
 *     height: number, depth: number, samples: number }} CopyImage
 *
 * @typedef {{ texture: import('./objects.js').TextureObject,
 *     first: import('./objects.js').TextureLevel, width: number, height: number,
 *     depth: number, cube: boolean }} NamedLevel
 */

/**
 * A stand-in sized format for an S3TC format's blocks, which `copyBox` and
 * `storageBytes` measure by their bytes alone.
 *
 * @param {number} internal
 * @returns {import('./formats.js').SizedFormat}
 */
const blockFormat = internal=>/** @type {import('./formats.js').SizedFormat} */ ({
    ...RGBA8, internal: 0, compressed: true,
    base: S3TC_BLOCK_BYTES.get(internal) === 8 ? GL.RED : GL.RGBA });

/**
 * The sized format whose bits a legacy level's RGBA bytes stand for, where
 * the two differ (RGB8, RGB16, RGBA16, RGB10_A2): what a copy moves of it.
 * Null for RGBA8, which is its own bytes, and for a format of OpenGL 1.x the
 * view classes do not list, copied only to its own format and so as bytes.
 *
 * @param {number} internal
 * @returns {import('./formats.js').SizedFormat | null}
 */
const legacyRaw = internal=>{
    const as = SIZED_FORMATS.get(internal);
    return as && as !== RGBA8 && !as.compressed && !UNSIZED_FORMATS.has(internal) ? as : null;
};

/**
 * A client image in any layout the transfer reads, as RGBA bytes: what a
 * legacy level keeps. Values outside [0, 1] are clamped as the conversion to
 * an unsigned normalised format clamps them.
 *
 * @param {Uint8Array} bytes @param {number} width @param {number} height @param {number} depth
 * @param {number} format @param {number} type
 * @param {import('./texture-transfer.js').TransferState} state
 * @returns {Uint8Array | null}
 */
function rgbaFromClient(bytes, width, height, depth, format, type, state){
    const values = decodeClient(bytes, width, height, depth, format, type, state);
    return values ? encodeStorage(values, RGBA8) : null;
}

/**
 * @typedef {Object} TextureUnit
 * @property {Map<number, number>} enabled   target -> 0 or 1
 * @property {Map<number, number>} bindings  target -> texture name
 * @property {Map<number, import('./objects.js').TextureObject>} defaults  one map, every unit's
 * @property {import('./texture.js').TextureEnvironment} env
 * @property {number[]} genEnabled  per coordinate
 * @property {number[]} genModes
 * @property {number[][]} objectPlanes
 * @property {number[][]} eyePlanes
 * @property {import('./matrix.js').MatrixStack} stack
 */

/**
 * @param {Map<number, import('./objects.js').TextureObject>} defaults  the
 *        context's texture 0 per target: the initial objects belong to the
 *        name space, which every unit shares, not to a unit
 * @returns {TextureUnit}
 */
function createUnit(defaults){
    return {
        enabled: new Map(TARGETS.map(target=>[target, 0])),
        bindings: new Map(BIND_TARGETS.map(target=>[target, 0])),
        defaults,
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
    const { enter, setError, record, setState, diverge, lose } = kernel;

    /** @type {Map<number, import('./objects.js').TextureObject>} */
    const defaults = new Map(BIND_TARGETS.map(target=>[target,
        createTextureObject(0, target)]));
    /** @type {TextureUnit[]} */
    const units = Array.from({ length: TEXTURE_UNITS }, ()=>createUnit(defaults));
    let active = 0;
    /** @type {number[][]} the current texture coordinates, per unit */
    const texCoords = Array.from({ length: TEXTURE_UNITS }, ()=>[0, 0, 0, 1]);
    /**
     * The texture a call of direct state access names, standing in for the
     * one bound to its target on the active unit while the bound form's code
     * does the work: nothing a program can see is rebound.
     *
     * @type {import('./objects.js').TextureObject | null}
     */
    let named = null;

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
            for (const target of BIND_TARGETS)
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
                for (const target of TARGETS_HIGHEST_FIRST)
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
            if (named !== null && unitIndex === active && named.target === target)
            {
                return named;
            }
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
        if (named !== null && unitIndex === active && named.target === target)
        {
            return named;
        }
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
        return imageOf(target);
    }

    /**
     * A buffer texture's level query (3.1, 4.3 table 23.15): what it is
     * attached to, and its level zero as the texels of that range.
     *
     * @param {number} level @param {number} parameter
     * @returns {number[] | null}
     */
    function bufferLevelParameter(level, parameter){
        const texture = textureBound(active, GL.TEXTURE_BUFFER);
        if (level !== 0)
        {
            setError(GL.INVALID_VALUE);
            return null;
        }
        const store = texture?.store ?? null;
        const buffer = store ? kernel.shareGroup().buffers.objects.get(store.buffer) : null;
        const size = store && buffer ? store.size ?? Math.max(0, buffer.size - store.offset) : 0;
        const sized = store ? SIZED_FORMATS.get(store.internal) : undefined;
        switch (parameter)
        {
            case GL.TEXTURE_BUFFER_DATA_STORE_BINDING:
                return [store?.buffer ?? 0];
            case GL.TEXTURE_BUFFER_OFFSET:
                return [store?.offset ?? 0];
            case GL.TEXTURE_BUFFER_SIZE:
                return [size];
            case GL.TEXTURE_INTERNAL_FORMAT:
                return [store?.internal ?? GL.RGBA8];
            case GL.TEXTURE_WIDTH:
                return [sized ? Math.floor(size / bufferTexelBytes(sized)) : 0];
            case GL.TEXTURE_HEIGHT:
            case TEX.TEXTURE_DEPTH:
                return [store ? 1 : 0];
            default: {
                const answer = sized ? sizedLevelAnswer(sized, parameter) : undefined;
                if (answer !== undefined)
                {
                    return [answer];
                }
                setError(GL.INVALID_ENUM);
                return null;
            }
        }
    }

    /**
     * glTexBuffer and glTexBufferRange (3.1, 4.3): the buffer object whose
     * bytes the bound buffer texture's texels are, in `internal`, over a
     * range or to the end; zero detaches it.
     *
     * @param {string} name @param {number} target @param {number} internal
     * @param {number} buffer @param {number | null} offset  null: the whole store
     * @param {number} size
     */
    function texBuffer(name, target, internal, buffer, offset, size){
        if (!enter(name, [target, internal, buffer, offset, size]))
        {
            return;
        }
        if (target !== GL.TEXTURE_BUFFER || !BUFFER_FORMATS.has(internal))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const object = buffer === 0 ? null : kernel.shareGroup().buffers.objects.get(buffer);
        if (buffer !== 0 && !object)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const alignment = record(GL.TEXTURE_BUFFER_OFFSET_ALIGNMENT).values[0];
        if (offset !== null && object && (offset < 0 || size <= 0
            || offset + size > object.size || offset % alignment !== 0))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const texture = /** @type {import('./objects.js').TextureObject} */ (
            textureBound(active, GL.TEXTURE_BUFFER));
        texture.levels.clear();
        texture.store = object ? { buffer, internal, offset: offset ?? 0,
            size: offset === null ? null : size, version: -1 } : undefined;
        texture.parametersVersion++;
    }

    /**
     * A buffer texture's level zero, made again from its buffer's bytes when
     * they changed: `BUFFER_ROW` texels a row, in the format's model layout
     * (a three-component texel widened to four, its fourth one).
     *
     * @param {import('./objects.js').TextureObject} texture
     */
    function refreshBufferLevel(texture){
        const store = texture.store;
        const buffer = store ? kernel.shareGroup().buffers.objects.get(store.buffer) : null;
        if (!store || !buffer)
        {
            texture.levels.clear();
            return;
        }
        if (store.version === buffer.version && texture.levels.has(levelKey(0)))
        {
            return;
        }
        store.version = buffer.version;
        const sized = /** @type {import('./formats.js').SizedFormat} */ (
            SIZED_FORMATS.get(store.internal));
        const size = Math.max(0, Math.min(store.size ?? Infinity, buffer.size - store.offset));
        const texel = bufferTexelBytes(sized);
        const count = Math.min(Math.floor(size / texel),
            record(GL.MAX_TEXTURE_BUFFER_SIZE).values[0]);
        if (count === 0)
        {
            texture.levels.clear();
            return;
        }
        const width = Math.min(count, BUFFER_ROW);
        const height = Math.ceil(count / BUFFER_ROW);
        const model = modelTexelBytes(sized);
        const data = new Uint8Array(width * height * model);
        const bytes = buffer.data.subarray(store.offset, store.offset + count * texel);
        if (model === texel)
        {
            data.set(bytes);
        }
        else
        {
            // RGB32F, RGB32I and RGB32UI: a fourth component of one.
            const one = new Uint8Array(new (sized.kind === 'float' ? Float32Array : Uint32Array)(
                [1]).buffer);
            for (let k = 0; k < count; k++)
            {
                data.set(bytes.subarray(k * texel, k * texel + texel), k * model);
                data.set(one, k * model + texel);
            }
        }
        texture.levels.set(levelKey(0), {
            width, height, internalFormat: store.internal, border: 0,
            baseFormat: environmentBase(sized), texels: null, sized, data,
        });
        texture.dirty.set(levelKey(0), null);
    }

    /**
     * Whether a call names a level a rectangle (3.1) does not have: its one
     * level is zero, any other GL_INVALID_VALUE.
     *
     * @param {string} name @param {number} target @param {number} level
     * @returns {boolean} whether it was refused
     */
    function levelRefused(name, target, level){
        if (!RECTANGLES.has(target) || level === 0)
        {
            return false;
        }
        if (enter(name, [target, level]))
        {
            setError(GL.INVALID_VALUE);
        }
        return true;
    }

    /**
     * @param {number} target
     * @returns {{ texture: import('./objects.js').TextureObject, face: number,
     *     cube: boolean } | null}
     */
    function imageOf(target){
        const face = CUBE_FACES.findIndex(candidate=>candidate === target);
        if (face >= 0)
        {
            const texture = textureBound(active, GL.TEXTURE_CUBE_MAP);
            return texture ? { texture, face, cube: true } : null;
        }
        if (target === GL.TEXTURE_2D || target === GL.TEXTURE_1D || target === GL.TEXTURE_3D
            || target === GL.TEXTURE_RECTANGLE || ARRAYS.has(target))
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
        // With a buffer bound for unpacking (OpenGL 2.1), the pointer is an
        // offset into it.
        const unpack = record(GL.PIXEL_UNPACK_BUFFER_BINDING).values[0];
        if (unpack !== 0 && data !== null)
        {
            const buffer = kernel.shareGroup().buffers.objects.get(unpack);
            return buffer ? buffer.data.subarray(data, data + length) : null;
        }
        const memory = kernel.memory();
        return data && memory ? memory.read(data, length) : null;
    }

    /**
     * The pixel store state of one direction, the 3D parameters included.
     *
     * @param {boolean} pack
     * @returns {import('./texture-transfer.js').TransferState}
     */
    function transferState(pack){
        const value = (/** @type {number} */ query)=>record(query)?.values[0] ?? 0;
        return pack ? {
            alignment: value(GL.PACK_ALIGNMENT), rowLength: value(GL.PACK_ROW_LENGTH),
            skipRows: value(GL.PACK_SKIP_ROWS), skipPixels: value(GL.PACK_SKIP_PIXELS),
            imageHeight: value(TEX.PACK_IMAGE_HEIGHT), skipImages: value(TEX.PACK_SKIP_IMAGES),
            swapBytes: value(GL.PACK_SWAP_BYTES) !== 0,
        } : {
            alignment: value(GL.UNPACK_ALIGNMENT), rowLength: value(GL.UNPACK_ROW_LENGTH),
            skipRows: value(GL.UNPACK_SKIP_ROWS), skipPixels: value(GL.UNPACK_SKIP_PIXELS),
            imageHeight: value(TEX.UNPACK_IMAGE_HEIGHT), skipImages: value(TEX.UNPACK_SKIP_IMAGES),
            swapBytes: value(GL.UNPACK_SWAP_BYTES) !== 0,
        };
    }

    /**
     * The format a level is kept in: its own when it is sized, RGBA8 for a
     * legacy format given to a 3D or array target (whose images are kept
     * the sized way, as bytes with a depth), or null for the legacy path.
     *
     * @param {number} internal @param {number} target @param {number} depth
     * @returns {{ kept: import('./formats.js').SizedFormat, legacyBase: number | null } | null}
     */
    function keptFormatOf(internal, target, depth){
        const sized = sizedFormatOf(internal);
        if (sized)
        {
            return { kept: uncompressedTwin(sized), legacyBase: null };
        }
        const base = baseFormatOf(internal);
        if (base !== null && (depth > 1 || IMAGE_TARGETS[3].has(target)
            || target === TEX.TEXTURE_1D_ARRAY || target === TEX.PROXY_TEXTURE_1D_ARRAY))
        {
            return { kept: /** @type {import('./formats.js').SizedFormat} */ (
                SIZED_FORMATS.get(GL.RGBA8)), legacyBase: base };
        }
        return null;
    }

    /**
     * A client image as the bytes of the format a level keeps, or null where
     * there is none to read.
     *
     * @param {number | Uint8Array | StoredPixels | null} pixels
     * @param {number} width @param {number} height @param {number} depth
     * @param {number} format @param {number} type
     * @param {import('./formats.js').SizedFormat} kept
     * @param {number | null} legacyBase  the legacy format whose components are kept
     * @returns {Uint8Array | null}
     */
    function readStored(pixels, width, height, depth, format, type, kept, legacyBase){
        if (pixels !== null && typeof pixels === 'object' && 'stored' in pixels)
        {
            return pixels.stored;
        }
        if (pixels === null || pixels === 0 || width === 0 || height === 0 || depth === 0)
        {
            return null;
        }
        const unpack = transferState(false);
        const bytes = guestBytes(pixels, clientBytes(width, height, depth, format, type, unpack));
        if (!bytes)
        {
            return null;
        }
        if (legacyBase === null)
        {
            return unpackToStorage(bytes, width, height, depth, format, type, unpack, kept);
        }
        const texels = rgbaFromClient(bytes, width, height, depth, format, type, unpack);
        if (texels)
        {
            conformTexels(texels, legacyBase);
        }
        return texels;
    }

    /**
     * The checks every image call of a sized level makes on its client
     * layout: the formats and types this implementation reads at all, then
     * the pairings the specification refuses.
     *
     * @param {import('./formats.js').SizedFormat} kept
     * @param {number} format @param {number} type
     * @returns {boolean}
     */
    function checkTransfer(kept, format, type){
        const error = transferError(kept, format, type);
        if (error !== 0)
        {
            setError(error);
            return false;
        }
        return true;
    }

    /**
     * glTexImage1D, 2D and 3D, for every target.
     *
     * @param {string} name
     * @param {number} target
     * @param {number} level
     * @param {number} internal  the internal format
     * @param {number} width
     * @param {number} height
     * @param {number} depth
     * @param {number} border
     * @param {number} format
     * @param {number} type
     * @param {number | Uint8Array | StoredPixels | null} pixels
     */
    function texImage(name, target, level, internal, width, height, depth, border, format, type,
        pixels)
    {
        const isProxy = PROXIES.has(target);
        const bound = isProxy ? null : imageTarget(target);
        if (!isProxy && !bound)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (bound && immutable(bound.texture))
        {
            return;
        }
        const keeping = keptFormatOf(internal, target, depth);
        if (keeping)
        {
            sizedImage(name, target, level, internal, keeping.kept, keeping.legacyBase, width,
                height, depth, border, format, type, pixels);
            return;
        }
        const args = [target, level, internal, width, height, border, format, type];
        const legacyLayout = PIXEL_FORMATS.has(format) && PIXEL_TYPES.has(type);
        if (legacyLayout ? !checkPixelFormat(format, type)
            : !checkTransfer(RGBA8, format, type))
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
        const texels = pixels !== null && typeof pixels === 'object' && 'stored' in pixels
            ? pixels.stored
            : legacyLayout ? readPixels(pixels, width, height, format, type)
                : readNewLayout(pixels, width, height, format, type);
        if (texels instanceof Uint8Array && imageDigests.length < 20000)
        {
            if (keptImages.at.has(imageDigests.length))
            {
                keptImages.images.push({ index: imageDigests.length, width, height,
                    texels: texels.slice() });
            }
            imageDigests.push(
                `${target.toString(16)}:${level}:${width}x${height}:${hashOf(texels)}`);
            imageTimes.push(Math.round(performance.timeOrigin + performance.now()));
        }
        if (texels === 'refused')
        {
            diverge(`glTexImage2D with format ${format} and type ${type} was accepted and`
                + ' uploaded nothing: this implementation does not read that layout');
        }
        if (!enter(name, [...args, texels === 'refused' ? null : legacyLayout ? texels
            : texels && { stored: texels }]))
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
            texels: texels instanceof Uint8Array && kernel.keepTexels ? texels : null,
            compressed: null,
        });
        markDirty(image.texture, levelKey(level, image.face), null);
        kernel.shareGroup().used = true;
    }

    /**
     * A client layout the legacy reader does not know -- RG, a half float,
     * a packed float -- read into RGBA bytes for a legacy level.
     *
     * @param {number | Uint8Array | null} pixels
     * @param {number} width @param {number} height
     * @param {number} format @param {number} type
     * @returns {Uint8Array | null}
     */
    function readNewLayout(pixels, width, height, format, type){
        if (pixels === null || pixels === 0 || width === 0 || height === 0)
        {
            return null;
        }
        const unpack = transferState(false);
        const bytes = guestBytes(pixels, clientBytes(width, height, 1, format, type, unpack));
        return bytes ? rgbaFromClient(bytes, width, height, 1, format, type, unpack) : null;
    }

    /**
     * An image of a sized format, or of a legacy one kept the sized way.
     *
     * @param {string} name @param {number} target @param {number} level
     * @param {number} internal  the format asked for
     * @param {import('./formats.js').SizedFormat} kept  the format kept
     * @param {number | null} legacyBase
     * @param {number} width @param {number} height @param {number} depth
     * @param {number} border @param {number} format @param {number} type
     * @param {number | Uint8Array | StoredPixels | null} pixels
     */
    function sizedImage(name, target, level, internal, kept, legacyBase, width, height, depth,
        border, format, type, pixels)
    {
        if (!checkTransfer(kept, format, type))
        {
            return;
        }
        const three = IMAGE_TARGETS[3].has(target);
        const size3d = record(GL.MAX_3D_TEXTURE_SIZE).values[0];
        const layers = record(TEX.MAX_ARRAY_TEXTURE_LAYERS)?.values[0] ?? 256;
        const max = record(GL.MAX_TEXTURE_SIZE).values[0];
        const solid = target === GL.TEXTURE_3D || target === GL.PROXY_TEXTURE_3D;
        const maxWidth = solid ? size3d : max;
        const maxHeight = solid ? size3d
            : target === TEX.TEXTURE_1D_ARRAY || target === TEX.PROXY_TEXTURE_1D_ARRAY
                ? layers : max;
        const maxDepth = solid ? size3d : three ? layers : 1;
        if (level < 0 || border !== 0 || width < 0 || height < 0 || depth < 0
            || width > maxWidth || height > maxHeight || depth > maxDepth)
        {
            // A border is OpenGL 1.x's alone: the sized formats of 3.0 refuse
            // one, and so does every image kept here as bytes.
            setError(GL.INVALID_VALUE);
            return;
        }
        if ((kept.kind === 'depth' || kept.kind === 'stencil') && solid)
        {
            // A depth format is for 1D, 2D, cube maps and their arrays.
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (PROXIES.has(target))
        {
            return;
        }
        const stored = readStored(pixels, width, height, depth, format, type, kept, legacyBase);
        if (pixels !== null && pixels !== 0 && !stored && width > 0 && height > 0 && depth > 0)
        {
            lose(`${name} of ${kept.name} read no pixels: the client image was out of reach`);
        }
        if (stored && imageDigests.length < 20000)
        {
            imageDigests.push(`${target.toString(16)}:${level}:${width}x${height}x${depth}:`
                + `${hashOf(stored)}`);
            imageTimes.push(Math.round(performance.timeOrigin + performance.now()));
        }
        if (!enter(name, [target, level, internal, width, height, ...(three ? [depth] : []),
            border, format, type, stored && { stored }]))
        {
            return;
        }
        const image = /** @type {NonNullable<ReturnType<typeof imageTarget>>} */ (
            imageTarget(target));
        image.texture.levels.set(levelKey(level, image.face), sizedLevel(internal, kept,
            width, height, depth, stored && kernel.keepTexels ? stored : null, legacyBase));
        markDirty(image.texture, levelKey(level, image.face), null);
        kernel.shareGroup().used = true;
    }

    /**
     * A level kept as a sized format's bytes. Its `texels` are the RGBA bytes
     * the processor's rasteriser and the legacy readers take, made from the
     * data when asked and kept while it is unchanged.
     *
     * @param {number} internal @param {import('./formats.js').SizedFormat} kept
     * @param {number} width @param {number} height @param {number} depth
     * @param {Uint8Array | null} data
     * @param {number | null} legacyBase
     * @param {boolean} [blank]  whether a level given no data holds zeros here
     * @returns {import('./objects.js').TextureLevel}
     */
    function sizedLevel(internal, kept, width, height, depth, data, legacyBase, blank = true){
        /** @type {import('./objects.js').TextureLevel} */
        const level = {
            width, height, depth, internalFormat: internal, border: 0,
            baseFormat: legacyBase ?? environmentBase(kept),
            sized: kept,
            data: data ?? (kernel.keepTexels && blank
                ? blankStorage(kept, width, height, depth) : null),
            compressed: null,
            get texels(){
                const cached = rgbaCache.get(level);
                if (cached !== undefined)
                {
                    return cached;
                }
                const made = level.data ? rgbaOf(level.data, kept, width, height, depth) : null;
                rgbaCache.set(level, made);
                return made;
            },
            set texels(value){
                rgbaCache.set(level, value);
            },
        };
        return level;
    }

    /**
     * Writes a box of a sized level from bytes in its own layout, and says
     * the device copy must follow.
     *
     * @param {import('./objects.js').TextureObject} texture @param {number} key
     * @param {import('./objects.js').TextureLevel} level
     * @param {import('./texture-levels.js').Box} box @param {Uint8Array} stored
     */
    function writeSizedBox(texture, key, level, box, stored){
        const sized = /** @type {import('./formats.js').SizedFormat} */ (level.sized);
        if (kernel.keepTexels)
        {
            // A level the device holds alone (let go after its upload) gets
            // bytes again here: the box is written into them, and only the
            // box goes up.
            level.data ??= blankStorage(sized, level.width, level.height, level.depth ?? 1);
            copyBox(level.data, sized, level.width, level.height, box, stored, 'write');
            rgbaCache.delete(level);
        }
        level.compressed = null;
        markDirty(texture, key, box.depth === (level.depth ?? 1) && box.z === 0
            ? { x: box.x, y: box.y, width: box.width, height: box.height } : null);
    }

    /**
     * glTexSubImage1D, 2D and 3D. A 1D or 2D call addresses the slice z0 = 0
     * of depth one.
     *
     * @param {string} name
     * @param {number} target
     * @param {number} level
     * @param {number} x0
     * @param {number} y0
     * @param {number} z0
     * @param {number} width
     * @param {number} height
     * @param {number} depth
     * @param {number} format
     * @param {number} type
     * @param {number | Uint8Array | StoredPixels | null} pixels
     */
    function texSubImage(name, target, level, x0, y0, z0, width, height, depth, format, type,
        pixels)
    {
        const image = imageTarget(target);
        if (!image)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const existing = image.texture.levels.get(levelKey(level, image.face));
        if (existing?.sized)
        {
            sizedSubImage(name, target, level, image, existing, { x: x0, y: y0, z: z0, width,
                height, depth }, format, type, pixels);
            return;
        }
        const args = [target, level, x0, y0, width, height, format, type];
        const legacyLayout = PIXEL_FORMATS.has(format) && PIXEL_TYPES.has(type);
        if (legacyLayout ? !checkPixelFormat(format, type) : !checkTransfer(RGBA8, format, type))
        {
            return;
        }
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
        const texels = pixels !== null && typeof pixels === 'object' && 'stored' in pixels
            ? pixels.stored
            : legacyLayout ? readPixels(pixels, width, height, format, type)
                : readNewLayout(pixels, width, height, format, type);
        if (texels === 'refused')
        {
            diverge(`glTexSubImage2D with format ${format} and type ${type} was accepted and`
                + ' uploaded nothing: this implementation does not read that layout');
        }
        if (!enter(name, [...args, texels === 'refused' ? null : legacyLayout ? texels
            : texels && { stored: texels }]))
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
     * A box of a sized level, from a client image.
     *
     * @param {string} name @param {number} target @param {number} level
     * @param {NonNullable<ReturnType<typeof imageTarget>>} image
     * @param {import('./objects.js').TextureLevel} existing
     * @param {import('./texture-levels.js').Box} box
     * @param {number} format @param {number} type
     * @param {number | Uint8Array | StoredPixels | null} pixels
     */
    function sizedSubImage(name, target, level, image, existing, box, format, type, pixels){
        const sized = /** @type {import('./formats.js').SizedFormat} */ (existing.sized);
        if (!checkTransfer(sized, format, type))
        {
            return;
        }
        const layersOf = existing.depth ?? 1;
        if (level < 0 || box.width < 0 || box.height < 0 || box.depth < 0 || box.x < 0
            || box.y < 0 || box.z < 0 || box.x + box.width > existing.width
            || box.y + box.height > existing.height || box.z + box.depth > layersOf)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        // A legacy format kept as bytes (a 3D or array level) keeps its own
        // components, as its 2D levels do.
        const legacyBase = sized === RGBA8 && !sizedFormatOf(existing.internalFormat)
            ? existing.baseFormat : null;
        const stored = readStored(pixels, box.width, box.height, box.depth, format, type, sized,
            legacyBase);
        const three = IMAGE_TARGETS[3].has(target);
        const args = three
            ? [target, level, box.x, box.y, box.z, box.width, box.height, box.depth, format, type]
            : target === GL.TEXTURE_1D ? [target, level, box.x, box.width, format, type]
                : [target, level, box.x, box.y, box.width, box.height, format, type];
        if (!enter(name, [...args, stored && { stored }]))
        {
            return;
        }
        if (stored)
        {
            writeSizedBox(image.texture, levelKey(level, image.face), existing, box, stored);
        }
    }

    /**
     * A sized level's box as a client image (glGetTexImage), or the error.
     *
     * @param {import('./objects.js').TextureLevel} stored
     * @param {number} format @param {number} type
     * @returns {Uint8Array | null}
     */
    function packSized(stored, format, type){
        const sized = /** @type {import('./formats.js').SizedFormat} */ (stored.sized);
        const depth = stored.depth ?? 1;
        if (sized.compressed)
        {
            // Decoded, then read back as the eight-bit components it decodes to.
            if (!checkTransfer(RGBA8, format, type))
            {
                return null;
            }
            const texels = stored.texels
                ?? new Uint8Array(stored.width * stored.height * depth * 4);
            return packFromStorage(texels, stored.width, stored.height, depth, format, type,
                transferState(true), RGBA8);
        }
        if (!checkTransfer(sized, format, type))
        {
            return null;
        }
        const data = stored.data ?? blankStorage(sized, stored.width, stored.height, depth);
        return packFromStorage(data, stored.width, stored.height, depth, format, type,
            transferState(true), sized);
    }

    /**
     * A rectangle of the processor's framebuffer written into a sized level's
     * slice: read as RGBA bytes, then kept as the level's format keeps them.
     *
     * @param {import('./objects.js').TextureObject} texture @param {number} key
     * @param {import('./objects.js').TextureLevel} level
     * @param {import('./texture-levels.js').Box} box
     * @param {number} x @param {number} y
     */
    function copyIntoSized(texture, key, level, box, x, y){
        const sized = /** @type {import('./formats.js').SizedFormat} */ (level.sized);
        const texels = framebufferTexels(x, y, box.width, box.height);
        const values = decodeClient(texels, box.width, box.height, 1, GL.RGBA, GL.UNSIGNED_BYTE,
            { alignment: 1, rowLength: 0, skipRows: 0, skipPixels: 0, swapBytes: false });
        if (values)
        {
            writeSizedBox(texture, key, level, box, encodeStorage(values, sized));
        }
    }

    /**
     * glCopyTexImage1D and 2D into a sized format: the level made in that
     * format, and the framebuffer's rectangle copied into it -- on the
     * device as a draw into the level, on the processor through RGBA bytes.
     *
     * @param {any[]} args
     * @param {NonNullable<ReturnType<typeof imageTarget>>} image
     * @param {number} level @param {number} internal
     * @param {import('./formats.js').SizedFormat} kept
     * @param {number} x @param {number} y @param {number} width @param {number} height
     * @param {number} border
     */
    function copySizedImage(args, image, level, internal, kept, x, y, width, height, border){
        const max = record(GL.MAX_TEXTURE_SIZE).values[0];
        if (level < 0 || border !== 0 || width < 0 || height < 0 || width > max
            || height > max)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (kept.kind === 'int' || kept.kind === 'uint')
        {
            // The framebuffer's colour is normalised: an integer level takes
            // a copy only from an integer one (OpenGL 4.6 section 8.6).
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (!enter('glCopyTexImage2D', [...args, null]))
        {
            return;
        }
        const key = levelKey(level, image.face);
        const gpu = kernel.gpuBacked();
        // On the device the level's pixels are the copy's, made there; its
        // data here would be uploaded over them.
        const made = sizedLevel(internal, kept, width, height, 1, null, null, !gpu);
        image.texture.levels.set(key, made);
        kernel.shareGroup().used = true;
        copyRectangle(image.texture, level, image.face, made, { x: 0, y: 0, z: 0, width, height,
            depth: 1 }, x, y);
    }

    /**
     * glCopyTexSubImage2D and 3D into a sized level.
     *
     * @param {string} name @param {any[]} args
     * @param {NonNullable<ReturnType<typeof imageTarget>>} image
     * @param {number} level @param {import('./objects.js').TextureLevel} existing
     * @param {import('./texture-levels.js').Box} box
     * @param {number} x @param {number} y
     */
    function copySubImage(name, args, image, level, existing, box, x, y){
        const sized = /** @type {import('./formats.js').SizedFormat} */ (existing.sized);
        if (box.width < 0 || box.height < 0 || box.x < 0 || box.y < 0 || box.z < 0
            || box.x + box.width > existing.width || box.y + box.height > existing.height
            || box.z >= (existing.depth ?? 1))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (sized.kind === 'int' || sized.kind === 'uint')
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (!enter(name, [...args, null]))
        {
            return;
        }
        copyRectangle(image.texture, level, image.face, existing, box, x, y);
    }

    /**
     * The copy itself, once the level is in place.
     *
     * @param {import('./objects.js').TextureObject} texture
     * @param {number} level @param {number} face
     * @param {import('./objects.js').TextureLevel} into
     * @param {import('./texture-levels.js').Box} box
     * @param {number} x @param {number} y
     */
    function copyRectangle(texture, level, face, into, box, x, y){
        const sized = /** @type {import('./formats.js').SizedFormat} */ (into.sized);
        if (sized.kind === 'depth' || sized.kind === 'stencil')
        {
            // The depth buffer is not read back into a texture here: the
            // device copies colour by drawing it, and a depth copy is a
            // different draw this renderer does not have.
            lose('a copy of the framebuffer\'s depth into a depth texture: the level keeps'
                + ' what it held');
            return;
        }
        if (kernel.gpuBacked())
        {
            if (texture.target === GL.TEXTURE_3D)
            {
                lose('a copy of the framebuffer into a slice of a 3D texture: the device draws'
                    + ' into one slice of a 3D texture through no view here');
                return;
            }
            // A layer of an array is addressed where a cube's face is.
            kernel.copyToTexture?.(texture, level, ARRAYS.has(texture.target) ? box.z : face,
                box.x, box.y, x, y, box.width, box.height);
            return;
        }
        copyIntoSized(texture, levelKey(level, face), into, box, x, y);
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
        if (!kernel.keepTexels)
        {
            return;
        }
        // Read once: a compressed level decodes at each read on a device, and
        // from this write on the level is the texels it holds, not its blocks.
        const into = level.texels ?? new Uint8Array(level.width * level.height * 4);
        for (let y = 0; y < height; y++)
        {
            into.set(
                texels.subarray(y * width * 4, (y + 1) * width * 4),
                ((yoffset + y) * level.width + xoffset) * 4);
        }
        Object.defineProperty(level, 'texels',
            { value: into, writable: true, configurable: true, enumerable: true });
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
        const texture = BIND_TARGETS.some(t=>t === target) ? textureBound(active, target) : null;
        if (!texture)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (texture.target === GL.TEXTURE_BUFFER)
        {
            // A buffer texture has no sampling state (3.1 section 3.8.5).
            setError(GL.INVALID_ENUM);
            return;
        }
        const value = values[0];
        if (parameter === GL.TEXTURE_BORDER_COLOR)
        {
            if (values.length < 4)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texture.borderColour = [0, 1, 2, 3].map(k=>Math.min(1, Math.max(0, values[k])));
            return;
        }
        if (parameter === GL.TEXTURE_SWIZZLE_RGBA)
        {
            // Four at once: a scalar form gives one, and is refused.
            if (values.length < 4
                || values.slice(0, 4).some(v=>!SWIZZLE_SOURCES.has(v)))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            SWIZZLE_PARAMETERS.forEach((query, k)=>texture.parameters.set(query, values[k]));
            texture.parametersVersion++;
            return;
        }
        if (!texture.parameters.has(parameter))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const refusal = samplingRefusal(parameter, value);
        if (refusal)
        {
            setError(refusal);
            return;
        }
        if (texture.target === GL.TEXTURE_RECTANGLE)
        {
            // One level, read in place (3.1 section 3.8.4): no mipmap
            // filter, no repeat, no other base level.
            if ((parameter === GL.TEXTURE_MIN_FILTER && !RECTANGLE_FILTERS.has(value))
                || ((parameter === GL.TEXTURE_WRAP_S || parameter === GL.TEXTURE_WRAP_T
                    || parameter === GL.TEXTURE_WRAP_R)
                    && (value === GL.REPEAT || value === GL.MIRRORED_REPEAT)))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (parameter === GL.TEXTURE_BASE_LEVEL && value !== 0)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
        }
        if ((parameter === GL.TEXTURE_BASE_LEVEL || parameter === GL.TEXTURE_MAX_LEVEL)
            && value < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (parameter === TEX.DEPTH_TEXTURE_MODE && !DEPTH_TEXTURE_MODES.has(value))
        {
            setError(GL.INVALID_ENUM);
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
        const texture = BIND_TARGETS.some(t=>t === target) ? textureBound(active, target) : null;
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
        if (parameter === TEXTURE_IMMUTABLE_FORMAT)
        {
            return [immutableLevels.has(texture) ? GL.TRUE : GL.FALSE];
        }
        if (parameter === GL.TEXTURE_SWIZZLE_RGBA)
        {
            return SWIZZLE_PARAMETERS.map(query=>/** @type {number} */ (
                texture.parameters.get(query)));
        }
        if (parameter === TEXTURE_IMMUTABLE_LEVELS)
        {
            return [immutableLevels.get(texture) ?? 0];
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
                if (values.length < 4)
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                env.colour = [0, 1, 2, 3].map(k=>Math.min(1, Math.max(0, values[k])));
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
                const slot = COMBINE_SLOTS.get(parameter);
                if (!slot || !slot[2].has(value))
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                combine[slot[0]][slot[1]] = value;
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
        if ((parameter === GL.OBJECT_PLANE || parameter === GL.EYE_PLANE) && values.length < 4)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (parameter === GL.OBJECT_PLANE)
        {
            unit.objectPlanes[k] = [values[0], values[1], values[2], values[3]];
            return;
        }
        if (parameter === GL.EYE_PLANE)
        {
            // Fixed in eye space by the modelview current now, like a light.
            const inverse = inverseTransposeOf(kernel.stacks.modelview.current);
            const plane = [values[0], values[1], values[2], values[3]];
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
        const sized = sizedFormatOf(internal);
        if (sized?.compressed)
        {
            compressedSized(name, target, level, internal, sized, width, height, 1, border, size,
                data);
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
        // A list keeps the blocks, which its replay hands back to this call.
        const args = [target, level, internal, width, height, border, size, bytes];
        if (!enter(name, args))
        {
            return;
        }
        if (immutable(image.texture))
        {
            return;
        }
        image.texture.levels.set(levelKey(level, image.face),
            s3tcLevel(internal, width, height, border, kernel.keepTexels ? bytes : null));
        markDirty(image.texture, levelKey(level, image.face), null);
        kernel.shareGroup().used = true;
    }

    /**
     * A level of an S3TC format, kept as its blocks.
     *
     * @param {number} internal @param {number} width @param {number} height
     * @param {number} border @param {Uint8Array | null} kept  the blocks, null for none
     * @returns {import('./objects.js').TextureLevel}
     */
    function s3tcLevel(internal, width, height, border, kept){
        // Decoded when something reads them -- the processor's rasteriser, a
        // read-back, a device that takes no blocks -- and not otherwise: a
        // device that samples the blocks never asks, and the decode was the
        // whole upload's cost on both the program's thread and the worker's.
        // On a device the texels are read once, to upload them where the
        // device takes no blocks, and not kept: decoded, a level holds four to
        // eight times its blocks for as long as the texture lives (the Doom 3
        // demo's first level, 47 MB of blocks). A processor's rasteriser reads
        // them every draw and keeps them.
        /** @type {Uint8Array | null | undefined} */
        let decoded;
        const decode = ()=>(kept && width > 0 && height > 0
            ? decodeS3tc(kept, internal, width, height) : null);
        return {
            width, height, internalFormat: internal, border,
            baseFormat: /** @type {number} */ (baseFormatOf(internal)),
            get texels(){
                if (kernel.gpuBacked())
                {
                    return decoded ?? decode();
                }
                decoded ??= decode();
                return decoded;
            },
            compressedFormat: internal,
            compressedBytes: compressedBytes(internal, width, height),
            compressed: kept ? { format: internal, bytes: kept } : null,
        };
    }

    /**
     * A compressed image of a sized format (RGTC, BPTC, the sRGB S3TC ones),
     * kept as its blocks.
     *
     * @param {string} name @param {number} target @param {number} level
     * @param {number} internal @param {import('./formats.js').SizedFormat} sized
     * @param {number} width @param {number} height @param {number} depth
     * @param {number} border @param {number} size
     * @param {number | Uint8Array | null} data
     */
    function compressedSized(name, target, level, internal, sized, width, height, depth, border,
        size, data)
    {
        if (target === GL.TEXTURE_1D || target === GL.TEXTURE_3D)
        {
            // Blocks are four by four texels: OpenGL 4.6 table 8.17 keeps
            // these formats to 2D images, cube maps and 2D arrays.
            setError(GL.INVALID_OPERATION);
            return;
        }
        const max = record(GL.MAX_TEXTURE_SIZE).values[0];
        const layers = record(TEX.MAX_ARRAY_TEXTURE_LAYERS)?.values[0] ?? 256;
        if (level < 0 || border !== 0 || width < 0 || height < 0 || depth < 0 || width > max
            || height > max || depth > layers || size !== storageBytes(sized, width, height, depth))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const bytes = guestBytes(data, size);
        if (bytes)
        {
            digestBlocks(bytes);
        }
        const three = IMAGE_TARGETS[3].has(target);
        if (!enter(name, [target, level, internal, width, height, ...(three ? [depth] : []),
            border, size, bytes]))
        {
            return;
        }
        const image = /** @type {NonNullable<ReturnType<typeof imageTarget>>} */ (
            imageTarget(target));
        if (immutable(image.texture))
        {
            return;
        }
        image.texture.levels.set(levelKey(level, image.face), sizedLevel(internal, sized, width,
            height, depth, bytes && kernel.keepTexels ? bytes.slice() : null, null));
        markDirty(image.texture, levelKey(level, image.face), null);
        kernel.shareGroup().used = true;
    }

    /**
     * Blocks written into a box of a compressed sized level: whole blocks,
     * or the level's edge (section 8.7).
     *
     * @param {string} name @param {any[]} args
     * @param {NonNullable<ReturnType<typeof imageTarget>>} image @param {number} level
     * @param {import('./objects.js').TextureLevel} existing
     * @param {import('./texture-levels.js').Box} box
     * @param {number} format @param {number} size @param {number | Uint8Array | null} data
     */
    function compressedSizedSub(name, args, image, level, existing, box, format, size, data){
        const sized = /** @type {import('./formats.js').SizedFormat} */ (existing.sized);
        if (format !== existing.internalFormat)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const edge = (/** @type {number} */ at, /** @type {number} */ extent,
            /** @type {number} */ whole)=>at % 4 === 0 && (extent % 4 === 0 || at + extent === whole);
        if (box.x < 0 || box.y < 0 || box.z < 0 || box.width < 0 || box.height < 0
            || box.x + box.width > existing.width || box.y + box.height > existing.height
            || box.z + box.depth > (existing.depth ?? 1))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (!edge(box.x, box.width, existing.width) || !edge(box.y, box.height, existing.height)
            || size !== storageBytes(sized, box.width, box.height, box.depth))
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const bytes = guestBytes(data, size);
        if (!enter(name, [...args, bytes]))
        {
            return;
        }
        if (bytes)
        {
            writeSizedBox(image.texture, levelKey(level, image.face), existing, box, bytes);
        }
    }

    /**
     * Whether a texture's levels were fixed by glTexStorage, which makes a
     * call that would define them again GL_INVALID_OPERATION.
     *
     * @param {import('./objects.js').TextureObject} texture
     * @returns {boolean}
     */
    function immutable(texture){
        if (!immutableLevels.has(texture))
        {
            return false;
        }
        setError(GL.INVALID_OPERATION);
        return true;
    }

    /**
     * A level with a shape and nothing in it, in the format glTexStorage
     * gives every level: kept as an image call with no pixels would keep it.
     *
     * @param {number} internal @param {number} target
     * @param {number} width @param {number} height @param {number} depth
     * @returns {import('./objects.js').TextureLevel}
     */
    function blankLevel(internal, target, width, height, depth){
        const sized = sizedFormatOf(internal);
        // On a device a level's pixels are its copy's there; bytes here would
        // only be held twice.
        const blank = !kernel.gpuBacked();
        if (sized?.compressed)
        {
            return sizedLevel(internal, sized, width, height, depth, null, null, blank);
        }
        if (S3TC_BLOCK_BYTES.has(internal) && !ARRAYS.has(target))
        {
            return s3tcLevel(internal, width, height, 0, null);
        }
        const keeping = keptFormatOf(internal, target, depth);
        if (keeping)
        {
            return sizedLevel(internal, keeping.kept, width, height, depth, null,
                keeping.legacyBase, blank);
        }
        return { width, height, internalFormat: internal, border: 0,
            baseFormat: /** @type {number} */ (baseFormatOf(internal)), texels: null,
            compressed: null };
    }

    /**
     * glTexStorage1D, 2D and 3D (OpenGL 4.6 section 8.19): every level of the
     * texture bound to `target` defined at once, each half the one above, and
     * the texture immutable from then on.
     *
     * @param {string} name @param {1 | 2 | 3} dimensions @param {number} target
     * @param {number} levels @param {number} internal
     * @param {number} width @param {number} height @param {number} depth
     */
    function texStorage(name, dimensions, target, levels, internal, width, height, depth){
        if (!enter(name, [target, levels, internal, width, height, depth]))
        {
            return;
        }
        if (!STORAGE_TARGETS[dimensions].has(target))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (UNSIZED_FORMATS.has(internal)
            || (!SIZED_FORMATS.has(internal) && baseFormatOf(internal) === null))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (levels < 1 || width < 1 || height < 1 || depth < 1)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const real = PROXY_TARGETS.get(target) ?? target;
        const solid = real === GL.TEXTURE_3D;
        const oneArray = real === TEX.TEXTURE_1D_ARRAY;
        const cube = real === GL.TEXTURE_CUBE_MAP;
        const flat = dimensions === 1 || oneArray;
        if (levels > mipLevels(width, flat ? 1 : height, solid ? depth : 1))
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const max = record(cube ? GL.MAX_CUBE_MAP_TEXTURE_SIZE : GL.MAX_TEXTURE_SIZE).values[0];
        const size3d = record(GL.MAX_3D_TEXTURE_SIZE).values[0];
        const layers = record(TEX.MAX_ARRAY_TEXTURE_LAYERS)?.values[0] ?? 256;
        const fits = solid ? width <= size3d && height <= size3d && depth <= size3d
            : width <= max && (oneArray ? height <= layers : height <= max)
                && (dimensions === 3 ? depth <= layers : true);
        if (!fits || (cube && width !== height))
        {
            // A proxy answers by what it leaves, not by an error.
            if (!PROXIES.has(target))
            {
                setError(GL.INVALID_VALUE);
            }
            return;
        }
        const sized = sizedFormatOf(internal);
        const blocks = sized?.compressed || S3TC_BLOCK_BYTES.has(internal);
        if ((blocks && (flat || solid))
            || (solid && (sized?.kind === 'depth' || sized?.kind === 'stencil')))
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (PROXIES.has(target))
        {
            return;
        }
        const texture = textureBound(active, target);
        if (!texture || texture.name === 0)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (immutable(texture))
        {
            return;
        }
        texture.levels.clear();
        texture.dirty.clear();
        for (let level = 0; level < levels; level++)
        {
            const w = Math.max(1, width >> level);
            const h = dimensions === 1 ? 1 : oneArray ? height : Math.max(1, height >> level);
            const d = solid ? Math.max(1, depth >> level) : dimensions === 3 ? depth : 1;
            for (let face = 0; face < (cube ? 6 : 1); face++)
            {
                texture.levels.set(levelKey(level, face), blankLevel(internal, real, w, h, d));
                markDirty(texture, levelKey(level, face), null);
            }
        }
        immutableLevels.set(texture, levels);
        kernel.shareGroup().used = true;
    }

    /**
     * One image of glCopyImageSubData's, or the error naming it raises.
     *
     * @param {number} name @param {number} target @param {number} level
     * @returns {CopyImage | number}
     */
    function copyImageOf(name, target, level){
        if (target === GL.RENDERBUFFER)
        {
            const renderbuffer = name === 0 ? undefined
                : kernel.shareGroup().renderbuffers.objects.get(name);
            if (!renderbuffer || level !== 0)
            {
                return GL.INVALID_VALUE;
            }
            return { renderbuffer, level, cube: false,
                format: /** @type {import('./texture-copy.js').CopyFormat} */ (
                    copyFormatOf(renderbuffer.internalFormat)),
                width: renderbuffer.width, height: renderbuffer.height, depth: 1,
                samples: Math.max(1, renderbuffer.samples) };
        }
        const texture = name === 0 ? undefined : kernel.shareGroup().textures.objects.get(name);
        const base = texture?.levels.get(levelKey(level));
        if (!texture || texture.target !== target || level < 0 || !base)
        {
            return GL.INVALID_VALUE;
        }
        const cube = target === GL.TEXTURE_CUBE_MAP;
        // A cube's faces must be one image each of the same size; past the
        // base level, the texture complete (Mesa's reading of 18.3.3, which
        // asks only the base level of a level-zero copy).
        if ((cube && [1, 2, 3, 4, 5].some(face=>{
            const other = texture.levels.get(levelKey(level, face));
            return !other || other.width !== base.width || other.height !== base.height;
        })) || (level > 0 && !immutableLevels.has(texture) && !isTextureComplete(texture)))
        {
            return GL.INVALID_OPERATION;
        }
        return { texture, level, cube,
            format: /** @type {import('./texture-copy.js').CopyFormat} */ (
                copyFormatOf(base.internalFormat)),
            width: base.width, height: target === GL.TEXTURE_1D ? 1 : base.height,
            depth: cube ? 6 : target === GL.TEXTURE_3D || target === TEX.TEXTURE_2D_ARRAY
                ? base.depth ?? 1 : 1,
            samples: 1 };
    }

    /**
     * Whether a box lies in an image, its corners on a compressed format's
     * blocks except at the image's edges (section 18.3.3).
     *
     * @param {CopyImage} image @param {import('./texture-levels.js').Box} box
     * @returns {boolean}
     */
    function boxFits(image, box){
        if (box.x < 0 || box.y < 0 || box.z < 0 || box.width < 0 || box.height < 0
            || box.depth < 0 || box.x + box.width > image.width
            || box.y + box.height > image.height || box.z + box.depth > image.depth)
        {
            return false;
        }
        const onBlocks = (/** @type {number} */ at, /** @type {number} */ extent,
            /** @type {number} */ whole)=>at % 4 === 0 && (extent % 4 === 0 || at + extent === whole);
        return !image.format.compressed || (onBlocks(box.x, box.width, image.width)
            && onBlocks(box.y, box.height, image.height));
    }

    /**
     * The level one slice of an image is (a cube's face, or the texture's
     * level with the slice as its z), or null for a renderbuffer.
     *
     * @param {{ texture?: import('./objects.js').TextureObject, level: number,
     *     cube: boolean }} image
     * @param {number} z
     * @returns {{ key: number, level: import('./objects.js').TextureLevel, z: number } | null}
     */
    function sliceOf(image, z){
        if (!image.texture)
        {
            return null;
        }
        const key = levelKey(image.level, image.cube ? z : 0);
        const level = /** @type {import('./objects.js').TextureLevel} */ (
            image.texture.levels.get(key));
        return { key, level, z: image.cube ? 0 : z };
    }

    /**
     * The raw texels or blocks of a box of one level, packed in the box's
     * order, or null where this side holds none of them (a level whose pixels
     * the device holds alone).
     *
     * @param {import('./objects.js').TextureLevel} level
     * @param {import('./texture-levels.js').Box} box
     * @returns {Uint8Array | null}
     */
    function readRaw(level, box){
        if (level.sized)
        {
            if (!level.data)
            {
                return null;
            }
            const kept = new Uint8Array(storageBytes(level.sized, box.width, box.height,
                box.depth));
            copyBox(level.data, level.sized, level.width, level.height, box, kept, 'read');
            return rawFromKept(kept, level.sized);
        }
        if (level.compressedFormat !== undefined)
        {
            const bytes = level.compressed?.bytes;
            if (!bytes)
            {
                return null;
            }
            const blocks = blockFormat(level.compressedFormat);
            const out = new Uint8Array(storageBytes(blocks, box.width, box.height));
            copyBox(bytes, blocks, level.width, level.height, box, out, 'read');
            return out;
        }
        const texels = level.texels;
        if (!texels)
        {
            return null;
        }
        const rgba = new Uint8Array(box.width * box.height * 4);
        copyBox(texels, RGBA8, level.width, level.height, box, rgba, 'read');
        const as = legacyRaw(level.internalFormat);
        return as ? rawFromKept(encodeStorage(decodeStorage(rgba, RGBA8), as), as) : rgba;
    }

    /**
     * Raw texels or blocks written over a box of one level; marked for the
     * device unless the device made the same copy itself.
     *
     * @param {import('./objects.js').TextureObject} texture @param {number} key
     * @param {import('./objects.js').TextureLevel} level
     * @param {import('./texture-levels.js').Box} box @param {Uint8Array} raw
     * @param {boolean} mark
     */
    function writeRaw(texture, key, level, box, raw, mark){
        const sized = level.sized;
        if (sized)
        {
            const kept = new Uint8Array(storageBytes(sized, box.width, box.height, box.depth));
            if (level.data)
            {
                copyBox(level.data, sized, level.width, level.height, box, kept, 'read');
            }
            rawIntoKept(raw, kept, sized);
            if (mark)
            {
                writeSizedBox(texture, key, level, box, kept);
            }
            else if (level.data)
            {
                copyBox(level.data, sized, level.width, level.height, box, kept, 'write');
                rgbaCache.delete(level);
            }
            return;
        }
        if (level.compressedFormat !== undefined)
        {
            const format = level.compressedFormat;
            const blocks = blockFormat(format);
            const bytes = level.compressed?.bytes.slice()
                ?? new Uint8Array(storageBytes(blocks, level.width, level.height));
            copyBox(bytes, blocks, level.width, level.height, box, raw, 'write');
            texture.levels.set(key, s3tcLevel(format, level.width, level.height, level.border,
                kernel.keepTexels ? bytes : null));
            if (mark)
            {
                markDirty(texture, key, null);
            }
            return;
        }
        const as = legacyRaw(level.internalFormat);
        let rgba = raw;
        if (as)
        {
            const kept = rawIntoKept(raw, blankStorage(as, box.width, box.height, 1), as);
            rgba = encodeStorage(decodeStorage(kept, as), RGBA8);
        }
        conformTexels(rgba, level.baseFormat);
        writeSubImage(level, box.x, box.y, box.width, box.height, rgba);
        level.compressed = null;
        if (mark)
        {
            markDirty(texture, key, { x: box.x, y: box.y, width: box.width,
                height: box.height });
        }
    }

    /**
     * glCopyImageSubData (OpenGL 4.3, GL_ARB_copy_image): a box of texels
     * from one image into another, bits as they are. On a device the copy is
     * the device's when both images live there in one format; otherwise it is
     * made here, from the bytes this side holds, and the box goes up.
     *
     * @param {number[]} args  the call's fifteen arguments
     */
    function copyImageSubData(args){
        if (!enter('glCopyImageSubData', args))
        {
            return;
        }
        const [srcName, srcTarget, srcLevel, srcX, srcY, srcZ, dstName, dstTarget, dstLevel,
            dstX, dstY, dstZ, width, height, depth] = args;
        if (!COPY_TARGETS.has(srcTarget) || !COPY_TARGETS.has(dstTarget))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const source = copyImageOf(srcName, srcTarget, srcLevel);
        const destination = typeof source === 'number' ? source
            : copyImageOf(dstName, dstTarget, dstLevel);
        if (typeof source === 'number' || typeof destination === 'number')
        {
            setError(/** @type {number} */ (typeof source === 'number' ? source : destination));
            return;
        }
        // A box of blocks is as many texels of an uncompressed format as it
        // has blocks, and the other way round.
        const scale = source.format.compressed === destination.format.compressed ? 1
            : source.format.compressed ? 1 / 4 : 4;
        const across = (/** @type {number} */ extent)=>(scale < 1 ? Math.ceil(extent / 4)
            : extent * scale);
        const from = { x: srcX, y: srcY, z: srcZ, width, height, depth };
        const into = { x: dstX, y: dstY, z: dstZ, width: across(width), height: across(height),
            depth };
        if (destination.format.compressed && !source.format.compressed)
        {
            // Blocks written at the image's edge stop at it.
            into.width = Math.min(into.width, destination.width - dstX);
            into.height = Math.min(into.height, destination.height - dstY);
        }
        if (!boxFits(source, from) || !boxFits(destination, into))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (!copyCompatible(source.format, destination.format)
            || source.samples !== destination.samples)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (width === 0 || height === 0 || depth === 0)
        {
            return;
        }
        const device = kernel.gpuBacked() && kernel.copyImage?.(
            { texture: source.texture, renderbuffer: source.renderbuffer, level: srcLevel,
                x: srcX, y: srcY, z: srcZ },
            { texture: destination.texture, renderbuffer: destination.renderbuffer,
                level: dstLevel, x: dstX, y: dstY, z: dstZ },
            { width, height, depth }) === true;
        let lost = false;
        for (let k = 0; k < depth; k++)
        {
            const read = sliceOf(source, srcZ + k);
            const written = sliceOf(destination, dstZ + k);
            const raw = read ? readRaw(read.level, { ...from, z: read.z, depth: 1 }) : null;
            if (!written || !raw)
            {
                lost ||= !device && kernel.keepTexels;
                continue;
            }
            const holds = written.level.sized ? written.level.data
                : written.level.compressedFormat !== undefined
                    ? written.level.compressed?.bytes : written.level.texels;
            if (device && !holds)
            {
                continue;
            }
            writeRaw(/** @type {import('./objects.js').TextureObject} */ (destination.texture),
                written.key, written.level, { ...into, z: written.z, depth: 1 }, raw, !device);
        }
        if (lost)
        {
            lose('glCopyImageSubData copied nothing: '
                + (source.renderbuffer || destination.renderbuffer
                    ? 'a renderbuffer\'s pixels live on the device alone'
                    : 'the source\'s pixels live on the device, in another format'));
        }
    }

    /**
     * A fill or read-back's level: the texture by its name and the level,
     * with its extent as the calls address it, or the error.
     *
     * @param {number} textureName @param {number} level @param {number} missing
     *     the error for a name that is no texture
     * @returns {NamedLevel | number | null} null: no image at that level
     */
    function namedLevel(textureName, level, missing){
        const texture = textureName === 0 ? undefined
            : kernel.shareGroup().textures.objects.get(textureName);
        if (!texture)
        {
            return missing;
        }
        if (level < 0 || level >= mipLevels(record(GL.MAX_TEXTURE_SIZE).values[0]))
        {
            return GL.INVALID_VALUE;
        }
        const first = texture.levels.get(levelKey(level));
        if (!first)
        {
            return null;
        }
        const cube = texture.target === GL.TEXTURE_CUBE_MAP;
        return { texture, first, cube, width: first.width,
            height: texture.target === GL.TEXTURE_1D ? 1 : first.height,
            depth: cube ? 6 : first.depth ?? 1 };
    }

    /**
     * glClearTexImage and glClearTexSubImage (OpenGL 4.4, GL_ARB_clear_texture):
     * a box of a level filled with one texel, given as one pixel of `format`
     * and `type` and converted as an image's would be; zeros where none is.
     * The pixel is read whole from the program's memory: the unpack state
     * and buffer do not apply to it.
     *
     * @param {string} name @param {number} textureName @param {number} level
     * @param {import('./texture-levels.js').Box | null} box  null: the whole level
     * @param {number} format @param {number} type @param {number | Uint8Array | null} data
     */
    function clearTexImage(name, textureName, level, box, format, type, data){
        const memory = kernel.memory();
        const tight = { alignment: 1, rowLength: 0, skipRows: 0, skipPixels: 0,
            swapBytes: false };
        // Read before a list or a twin decides anything, as an image is.
        const pixel = data instanceof Uint8Array ? data
            : data && memory && transferError(RGBA8, format, type) !== GL.INVALID_ENUM
                ? memory.read(data, clientBytes(1, 1, 1, format, type, tight)) : null;
        if (!enter(name, [textureName, level, box, format, type, pixel]))
        {
            return;
        }
        const found = namedLevel(textureName, level, GL.INVALID_OPERATION);
        if (found === null || typeof found === 'number')
        {
            setError(found ?? GL.INVALID_OPERATION);
            return;
        }
        const { texture, first } = found;
        if (first.sized?.compressed || first.compressedFormat !== undefined)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const kept = first.sized ?? RGBA8;
        if (!checkTransfer(kept, format, type))
        {
            return;
        }
        const whole = box ?? { x: 0, y: 0, z: 0, width: found.width, height: found.height,
            depth: found.depth };
        if (whole.width < 0 || whole.height < 0 || whole.depth < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (whole.x < 0 || whole.y < 0 || whole.z < 0 || whole.x + whole.width > found.width
            || whole.y + whole.height > found.height || whole.z + whole.depth > found.depth)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const values = pixel ? decodeClient(pixel, 1, 1, 1, format, type, tight)
            : new Float64Array(4);
        if (!values)
        {
            lose(`${name} with format ${format} and type ${type} wrote nothing: this`
                + ' implementation does not read that layout');
            return;
        }
        const texel = encodeStorage(values, kept);
        if (!first.sized)
        {
            conformTexels(texel, first.baseFormat);
        }
        if (whole.width === 0 || whole.height === 0 || whole.depth === 0)
        {
            return;
        }
        const image = { texture, level, cube: found.cube };
        for (let k = 0; k < (found.cube ? whole.depth : 1); k++)
        {
            const slice = /** @type {NonNullable<ReturnType<typeof sliceOf>>} */ (
                sliceOf(image, whole.z + k));
            const target = { ...whole, z: slice.z, depth: found.cube ? 1 : whole.depth };
            const fill = new Uint8Array(target.width * target.height * target.depth
                * texel.length);
            for (let at = 0; at < fill.length; at += texel.length)
            {
                fill.set(texel, at);
            }
            if (slice.level.sized)
            {
                writeSizedBox(texture, slice.key, slice.level, target, fill);
                continue;
            }
            writeSubImage(slice.level, target.x, target.y, target.width, target.height, fill);
            slice.level.compressed = null;
            markDirty(texture, slice.key, { x: target.x, y: target.y, width: target.width,
                height: target.height });
        }
    }

    /**
     * glGetTextureSubImage (OpenGL 4.5, GL_ARB_get_texture_sub_image): a box
     * of a level as a client image, packed by the pack state. A cube map's
     * faces are its z, packed as the images of a 3D one.
     *
     * @param {string} name @param {number} textureName @param {number} level
     * @param {import('./texture-levels.js').Box | null} box  null: the whole level
     * @param {number} format @param {number} type @param {number} bufSize
     * @param {number} [missing]  the error for a name that is no texture
     * @returns {Uint8Array | null}
     */
    function getTextureSubImage(name, textureName, level, box, format, type, bufSize,
        missing = GL.INVALID_VALUE)
    {
        if (!enter(name, [textureName, level, box, format, type, bufSize]))
        {
            return null;
        }
        const found = namedLevel(textureName, level, missing);
        if (found === null || typeof found === 'number')
        {
            // A level with no image packs nothing, and is no error.
            if (found !== null)
            {
                setError(found);
            }
            return null;
        }
        const { first } = found;
        // Blocks are read back as the eight-bit components they decode to.
        const kept = first.sized && !first.sized.compressed ? first.sized : RGBA8;
        if (!checkTransfer(kept, format, type))
        {
            return null;
        }
        const whole = box ?? { x: 0, y: 0, z: 0, width: found.width, height: found.height,
            depth: found.depth };
        if (whole.x < 0 || whole.y < 0 || whole.z < 0 || whole.width < 0 || whole.height < 0
            || whole.depth < 0 || whole.x + whole.width > found.width
            || whole.y + whole.height > found.height || whole.z + whole.depth > found.depth)
        {
            setError(GL.INVALID_VALUE);
            return null;
        }
        const state = transferState(true);
        if (clientBytes(whole.width, whole.height, whole.depth, format, type, state) > bufSize)
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        if (!kernel.keepTexels)
        {
            diverge(`${name} was accepted and read zeros: the texels live with the context`
                + ' that draws, in the graphics worker, and are not read back');
        }
        const image = { texture: found.texture, level, cube: found.cube };
        const slices = found.cube ? whole.depth : 1;
        const depth = found.cube ? 1 : whole.depth;
        const sliceBytes = storageBytes(kept, whole.width, whole.height, depth);
        const stored = new Uint8Array(sliceBytes * slices);
        for (let k = 0; k < slices; k++)
        {
            const slice = /** @type {NonNullable<ReturnType<typeof sliceOf>>} */ (
                sliceOf(image, whole.z + k));
            const source = kept === slice.level.sized ? slice.level.data : slice.level.texels;
            const into = stored.subarray(k * sliceBytes, (k + 1) * sliceBytes);
            if (source)
            {
                copyBox(source, kept, slice.level.width, slice.level.height,
                    { ...whole, z: slice.z, depth }, into, 'read');
            }
            else
            {
                into.set(blankStorage(kept, whole.width, whole.height, depth));
            }
        }
        return packFromStorage(stored, whole.width, whole.height, whole.depth, format, type,
            state, kept);
    }

    /**
     * glGetCompressedTextureSubImage (OpenGL 4.5): a box of a compressed
     * level's blocks, as the program gave them.
     *
     * @param {string} name @param {number} textureName @param {number} level
     * @param {import('./texture-levels.js').Box | null} box  null: the whole level
     * @param {number} bufSize
     * @param {number} [missing]  the error for a name that is no texture
     * @returns {Uint8Array | null}
     */
    function getCompressedTextureSubImage(name, textureName, level, box, bufSize,
        missing = GL.INVALID_VALUE)
    {
        if (!enter(name, [textureName, level, box, bufSize]))
        {
            return null;
        }
        const found = namedLevel(textureName, level, missing);
        if (found === null || typeof found === 'number')
        {
            setError(found ?? GL.INVALID_OPERATION);
            return null;
        }
        const { first } = found;
        const blocks = first.sized?.compressed ? first.sized
            : first.compressedFormat !== undefined ? blockFormat(first.compressedFormat) : null;
        if (!blocks)
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        const whole = box ?? { x: 0, y: 0, z: 0, width: found.width, height: found.height,
            depth: found.depth };
        const image = { texture: found.texture, level, cube: found.cube, width: found.width,
            height: found.height, depth: found.depth, samples: 1,
            format: { internal: first.internalFormat, compressed: true, bytes: 16,
                viewClass: null } };
        if (!boxFits(image, whole))
        {
            setError(GL.INVALID_VALUE);
            return null;
        }
        const slices = found.cube ? whole.depth : 1;
        const depth = found.cube ? 1 : whole.depth;
        const sliceBytes = storageBytes(blocks, whole.width, whole.height, depth);
        if (sliceBytes * slices > bufSize)
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        const out = new Uint8Array(sliceBytes * slices);
        for (let k = 0; k < slices; k++)
        {
            const slice = /** @type {NonNullable<ReturnType<typeof sliceOf>>} */ (
                sliceOf(image, whole.z + k));
            const source = slice.level.sized ? slice.level.data : slice.level.compressed?.bytes;
            if (source)
            {
                copyBox(source, blocks, slice.level.width, slice.level.height,
                    { ...whole, z: slice.z, depth }, out.subarray(k * sliceBytes), 'read');
            }
            else if (kernel.keepTexels)
            {
                diverge(`${name} read zeros: the level's blocks are not held on this side`);
            }
        }
        return out;
    }

    /**
     * @param {string} name  the call, as a list and the errors know it
     * @param {number} target
     * @param {number} level
     * @param {number} parameter
     * @returns {number[] | null}
     */
    function getTexLevelParameter(name, target, level, parameter){
        if (!enter(name, [target, level, parameter]))
        {
            return null;
        }
        if (target === GL.TEXTURE_BUFFER)
        {
            return bufferLevelParameter(level, parameter);
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
        if (parameter === TEX.TEXTURE_DEPTH)
        {
            return [stored ? stored.depth ?? 1 : 0];
        }
        if (stored?.sized && parameter !== GL.TEXTURE_INTERNAL_FORMAT
            && parameter !== GL.TEXTURE_COMPRESSED_IMAGE_SIZE)
        {
            const answer = sizedLevelAnswer(stored.sized, parameter);
            if (answer !== undefined)
            {
                return [answer];
            }
        }
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
            case TEX.TEXTURE_LUMINANCE_SIZE:
                return [stored && (base === GL.LUMINANCE || base === GL.LUMINANCE_ALPHA)
                    ? 8 : 0];
            case TEX.TEXTURE_INTENSITY_SIZE:
                return [stored && base === GL.INTENSITY ? 8 : 0];
            case TEX.TEXTURE_DEPTH_SIZE:
            case TEX.TEXTURE_STENCIL_SIZE:
            case TEX.TEXTURE_SHARED_SIZE:
                return [0];
            case TEX.TEXTURE_RED_TYPE:
            case TEX.TEXTURE_GREEN_TYPE:
            case TEX.TEXTURE_BLUE_TYPE:
                return [stored && hasColour && base !== GL.LUMINANCE
                    && base !== GL.LUMINANCE_ALPHA && base !== GL.INTENSITY
                    ? GL.UNSIGNED_NORMALIZED : GL.NONE];
            case TEX.TEXTURE_ALPHA_TYPE:
                return [stored && hasAlpha && base !== GL.INTENSITY
                    ? GL.UNSIGNED_NORMALIZED : GL.NONE];
            case TEX.TEXTURE_LUMINANCE_TYPE:
                return [stored && (base === GL.LUMINANCE || base === GL.LUMINANCE_ALPHA)
                    ? GL.UNSIGNED_NORMALIZED : GL.NONE];
            case TEX.TEXTURE_INTENSITY_TYPE:
                return [stored && base === GL.INTENSITY ? GL.UNSIGNED_NORMALIZED : GL.NONE];
            case TEX.TEXTURE_DEPTH_TYPE:
                return [GL.NONE];
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
    }

    /**
     * @param {string} name  the call, as a list and the errors know it
     * @param {number} target
     * @param {number} level
     * @param {number} xoffset
     * @param {number} yoffset
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     */
    function copyTexSubImage2D(name, target, level, xoffset, yoffset, x, y, width, height){
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
        if (existing.sized)
        {
            copySubImage(name, args, image, level, existing, { x: xoffset,
                y: yoffset, z: 0, width, height, depth: 1 }, x, y);
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
            if (!enter(name, [...args, null]))
            {
                return;
            }
            kernel.copyToTexture?.(image.texture, level, image.face, xoffset, yoffset, x, y,
                width, height);
            return;
        }
        const texels = framebufferTexels(x, y, width, height);
        if (!enter(name, [...args, texels]))
        {
            return;
        }
        conformTexels(texels, existing.baseFormat);
        writeSubImage(existing, xoffset, yoffset, width, height, texels);
        existing.compressed = null;
        markDirty(image.texture, levelKey(level, image.face), { x: xoffset, y: yoffset,
            width, height });
    }

    /**
     * A rectangle of the framebuffer into one slice of a 3D texture or
     * one layer of an array.
     *
     * @param {string} name  the call, as a list and the errors know it
     * @param {number} target @param {number} level
     * @param {number} xoffset @param {number} yoffset @param {number} zoffset
     * @param {number} x @param {number} y @param {number} width @param {number} height
     */
    function copyTexSubImage3D(name, target, level, xoffset, yoffset, zoffset, x, y, width,
        height)
    {
        const args = [target, level, xoffset, yoffset, zoffset, x, y, width, height];
        const image = IMAGE_TARGETS[3].has(target) && !PROXIES.has(target)
            ? imageTarget(target) : null;
        if (!image)
        {
            enter(name, args);
            setError(GL.INVALID_ENUM);
            return;
        }
        const existing = image.texture.levels.get(levelKey(level, image.face));
        if (!existing?.sized)
        {
            enter(name, args);
            setError(GL.INVALID_OPERATION);
            return;
        }
        copySubImage(name, args, image, level, existing, { x: xoffset,
            y: yoffset, z: zoffset, width, height, depth: 1 }, x, y);
    }

    /**
     * Rewrites a rectangle of an S3TC level. The decoded texels are
     * written into the RGBA image, which is what sampling reads.
     *
     * @param {string} name  the call, as a list and the errors know it
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
    function compressedTexSubImage2D(name, target, level, x0, y0, width, height, format, size,
        data)
    {
        const image = imageTarget(target);
        if (!image || !S3TC_FORMATS.has(format) && !sizedFormatOf(format)?.compressed)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        const existing = image.texture.levels.get(levelKey(level, image.face));
        if (existing?.sized?.compressed)
        {
            compressedSizedSub(name,
                [target, level, x0, y0, width, height, format, size], image, level, existing,
                { x: x0, y: y0, z: 0, width, height, depth: 1 }, format, size, data ?? null);
            return;
        }
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
        if (!enter(name, args))
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
    }

    /**
     * @param {string} name  the call, as a list and the errors know it
     * @param {number} target @param {number} level
     * @param {number} x0 @param {number} y0 @param {number} z0
     * @param {number} width @param {number} height @param {number} depth
     * @param {number} format @param {number} size
     * @param {number | Uint8Array | null} [data]
     */
    function compressedTexSubImage3D(name, target, level, x0, y0, z0, width, height, depth,
        format, size, data)
    {
        const image = target === TEX.TEXTURE_2D_ARRAY ? imageTarget(target) : null;
        const existing = image?.texture.levels.get(levelKey(level, image.face));
        if (!image || !existing?.sized?.compressed)
        {
            enter(name, [target]);
            setError(image ? GL.INVALID_OPERATION : GL.INVALID_ENUM);
            return;
        }
        compressedSizedSub(name,
            [target, level, x0, y0, z0, width, height, depth, format, size], image, level,
            existing, { x: x0, y: y0, z: z0, width, height, depth }, format, size,
            data ?? null);
    }

    /**
     * glTexParameterIiv and glTexParameterIuiv (3.0): what glTexParameteriv
     * sets, the border colour kept as the integers given.
     *
     * @param {string} name  the call, as a list and the errors know it
     * @param {number} target @param {number} parameter @param {number[]} values
     */
    function texParameterI(name, target, parameter, values){
        if (parameter !== GL.TEXTURE_BORDER_COLOR)
        {
            texParameter(name, target, parameter, values);
            return;
        }
        if (!enter(name, [target, parameter, values]))
        {
            return;
        }
        const texture = BIND_TARGETS.some(t=>t === target) ? textureBound(active, target)
            : null;
        if (!texture || values.length < 4)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        texture.borderColour = values.slice(0, 4);
        texture.parametersVersion++;
    }

    Object.assign(kernel.side, {
        /**
         * The bound forms' work for a call that names its texture (OpenGL
         * 4.5 direct state access, `context-dsa.js`): `body` runs with
         * `texture` standing in for the one bound to its target on the
         * active unit, and every call it makes takes the name it is given,
         * which is what a list and the errors know it by.
         *
         * @template T
         * @param {import('./objects.js').TextureObject} texture @param {() => T} body
         * @returns {T}
         */
        withTexture(texture, body){
            const was = named;
            named = texture;
            try
            {
                return body();
            }
            finally
            {
                named = was;
            }
        },
        textureCalls: Object.freeze({
            texSubImage, texParameter, getTexParameter, texParameterI, getTexLevelParameter,
            copyTexSubImage2D, copyTexSubImage3D, compressedTexSubImage2D,
            compressedTexSubImage3D, texStorage, getTextureSubImage,
            getCompressedTextureSubImage, clearTexImage,
        }),
        /** @param {import('./objects.js').TextureObject} texture */
        immutableLevels: texture=>immutableLevels.get(texture) ?? 0,
    });

    Object.assign(kernel.side, {
        /**
         * The buffer texture a unit has bound, its level made from the
         * buffer's bytes as they are now (3.1); null for none.
         *
         * @param {number} unitIndex
         * @returns {import('./objects.js').TextureObject | null}
         */
        bufferTextureAt(unitIndex){
            const texture = kernel.side.textureBoundAt(unitIndex, GL.TEXTURE_BUFFER);
            if (texture)
            {
                refreshBufferLevel(texture);
            }
            return texture;
        },
    });

    Object.assign(context, {
        /**
         * @param {number} target @param {number} internal @param {number} buffer
         */
        glTexBuffer(target, internal, buffer){
            texBuffer('glTexBuffer', target, internal, buffer, null, 0);
        },

        /**
         * @param {number} target @param {number} internal @param {number} buffer
         * @param {number} offset @param {number} size
         */
        glTexBufferRange(target, internal, buffer, offset, size){
            texBuffer('glTexBufferRange', target, internal, buffer, offset, size);
        },

        // --- GL_ARB_texture_storage (4.2) ---

        /**
         * @param {number} target @param {number} levels @param {number} internal
         * @param {number} width
         */
        glTexStorage1D(target, levels, internal, width){
            texStorage('glTexStorage1D', 1, target, levels, internal, width, 1, 1);
        },

        /**
         * @param {number} target @param {number} levels @param {number} internal
         * @param {number} width @param {number} height
         */
        glTexStorage2D(target, levels, internal, width, height){
            if (RECTANGLES.has(target) && levels !== 1)
            {
                enter('glTexStorage2D', [target]);
                setError(GL.INVALID_VALUE);
                return;
            }
            texStorage('glTexStorage2D', 2, target, levels, internal, width, height, 1);
        },

        /**
         * @param {number} target @param {number} levels @param {number} internal
         * @param {number} width @param {number} height @param {number} depth
         */
        glTexStorage3D(target, levels, internal, width, height, depth){
            texStorage('glTexStorage3D', 3, target, levels, internal, width, height, depth);
        },

        // --- GL_ARB_copy_image (4.3) ---

        /**
         * @param {number} srcName @param {number} srcTarget @param {number} srcLevel
         * @param {number} srcX @param {number} srcY @param {number} srcZ
         * @param {number} dstName @param {number} dstTarget @param {number} dstLevel
         * @param {number} dstX @param {number} dstY @param {number} dstZ
         * @param {number} width @param {number} height @param {number} depth
         */
        glCopyImageSubData(srcName, srcTarget, srcLevel, srcX, srcY, srcZ, dstName, dstTarget,
            dstLevel, dstX, dstY, dstZ, width, height, depth)
        {
            copyImageSubData([srcName, srcTarget, srcLevel, srcX, srcY, srcZ, dstName,
                dstTarget, dstLevel, dstX, dstY, dstZ, width, height, depth]);
        },

        // --- GL_ARB_clear_texture (4.4) ---

        /**
         * glClearTexImage and glClearTexSubImage: `box` null fills the whole level.
         *
         * @param {string} name @param {number} texture @param {number} level
         * @param {import('./texture-levels.js').Box | null} box
         * @param {number} format @param {number} type @param {number | Uint8Array | null} data
         */
        clearTexImage(name, texture, level, box, format, type, data){
            clearTexImage(name === 'glClearTexImage' ? name : 'glClearTexSubImage', texture,
                level, box, format, type, data);
        },

        // --- GL_ARB_get_texture_sub_image (4.5) ---

        /**
         * @param {number} texture @param {number} level
         * @param {import('./texture-levels.js').Box} box
         * @param {number} format @param {number} type @param {number} bufSize
         * @returns {Uint8Array | null} the client image
         */
        glGetTextureSubImage(texture, level, box, format, type, bufSize){
            return getTextureSubImage('glGetTextureSubImage', texture, level, box, format, type,
                bufSize);
        },

        /**
         * @param {number} texture @param {number} level
         * @param {import('./texture-levels.js').Box} box @param {number} bufSize
         * @returns {Uint8Array | null} the blocks
         */
        glGetCompressedTextureSubImage(texture, level, box, bufSize){
            return getCompressedTextureSubImage('glGetCompressedTextureSubImage', texture, level,
                box, bufSize);
        },

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
                // And detaches it from the framebuffers bound.
                kernel.side.textureDeleted?.(texture);
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

        /**
         * glTexParameterIiv and glTexParameterIuiv (3.0): what glTexParameteriv
         * sets, the border colour kept as the integers given.
         *
         * @param {number} target @param {number} parameter @param {number[]} values
         */
        texParameterI(target, parameter, values){
            return texParameterI('texParameterI', target, parameter, values);
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
            return getTexLevelParameter('glGetTexLevelParameteriv', target, level, parameter);
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
            if (!IMAGE_TARGETS[2].has(target))
            {
                enter('glTexImage2D', [target]);
                setError(GL.INVALID_ENUM);
                return;
            }
            if (levelRefused('glTexImage2D', target, level))
            {
                return;
            }
            texImage('glTexImage2D', target, level, internal, width, height, 1, border,
                format, type, pixels ?? null);
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} internal  the internal format
         * @param {number} width
         * @param {number} height
         * @param {number} depth
         * @param {number} border
         * @param {number} format
         * @param {number} type
         * @param {number | Uint8Array | StoredPixels | null} [pixels]
         */
        glTexImage3D(target, level, internal, width, height, depth, border, format, type,
            pixels)
        {
            if (!IMAGE_TARGETS[3].has(target))
            {
                enter('glTexImage3D', [target]);
                setError(GL.INVALID_ENUM);
                return;
            }
            texImage('glTexImage3D', target, level, internal, width, height, depth, border,
                format, type, pixels ?? null);
        },

        /**
         * @param {number} target @param {number} level
         * @param {number} x0 @param {number} y0 @param {number} z0
         * @param {number} width @param {number} height @param {number} depth
         * @param {number} format @param {number} type
         * @param {number | Uint8Array | StoredPixels | null} [pixels]
         */
        glTexSubImage3D(target, level, x0, y0, z0, width, height, depth, format, type, pixels){
            if (!IMAGE_TARGETS[3].has(target) || PROXIES.has(target))
            {
                enter('glTexSubImage3D', [target]);
                setError(GL.INVALID_ENUM);
                return;
            }
            texSubImage('glTexSubImage3D', target, level, x0, y0, z0, width, height, depth,
                format, type, pixels ?? null);
        },

        /**
         * A rectangle of the framebuffer into one slice of a 3D texture or
         * one layer of an array.
         *
         * @param {number} target @param {number} level
         * @param {number} xoffset @param {number} yoffset @param {number} zoffset
         * @param {number} x @param {number} y @param {number} width @param {number} height
         */
        glCopyTexSubImage3D(target, level, xoffset, yoffset, zoffset, x, y, width, height){
            return copyTexSubImage3D('glCopyTexSubImage3D', target, level, xoffset, yoffset,
                zoffset, x, y, width, height);
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
            texImage('glTexImage1D', target, level, internalFormat, width, 1, 1, border, format,
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
            if (!IMAGE_TARGETS[2].has(target) || PROXIES.has(target))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (levelRefused('glTexSubImage2D', target, level))
            {
                return;
            }
            texSubImage('glTexSubImage2D', target, level, x0, y0, 0, width, height, 1, format,
                type, pixels ?? null);
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
            texSubImage('glTexSubImage1D', target, level, xoffset, 0, 0, width, 1, 1, format, type,
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
            if (levelRefused('glCopyTexImage2D', target, level))
            {
                return;
            }
            const args = [target, level, internalFormat, x, y, width, height, border];
            const image = IMAGE_TARGETS[3].has(target) ? null : imageTarget(target);
            const baseFormat = baseFormatOf(internalFormat);
            if (!image)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (immutable(image.texture))
            {
                return;
            }
            const sized = sizedFormatOf(internalFormat);
            if (sized)
            {
                copySizedImage(args, image, level, internalFormat, uncompressedTwin(sized), x, y,
                    width, height, border);
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
            if (levelRefused('glCopyTexSubImage2D', target, level))
            {
                return undefined;
            }
            return copyTexSubImage2D('glCopyTexSubImage2D', target, level, xoffset, yoffset, x,
                y, width, height);
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} format
         * @param {number} type
         * @returns {Uint8Array | { packed: Uint8Array } | null} the level's texels
         *          as RGBA bytes, which the caller packs into the format asked
         *          for; or, for a level kept as a sized format, the client
         *          image itself, packed here from the format's own values
         */
        glGetTexImage(target, level, format, type){
            if (!enter('glGetTexImage', [target, level, format, type]))
            {
                return null;
            }
            const image = PROXIES.has(target) ? null : imageTarget(target);
            if (!image)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const stored = image.texture.levels.get(levelKey(level, image.face));
            if (stored?.sized || (stored && !(PIXEL_FORMATS.has(format) && PIXEL_TYPES.has(type))))
            {
                if (!kernel.keepTexels)
                {
                    diverge('glGetTexImage was accepted and read zeros: the texels live with'
                        + ' the context that draws, in the graphics worker, and are not read back');
                }
                const packed = stored.sized ? packSized(stored, format, type)
                    : checkTransfer(RGBA8, format, type)
                        ? packFromStorage(stored.texels
                            ?? new Uint8Array(stored.width * stored.height * 4), stored.width,
                        stored.height, 1, format, type, transferState(true), RGBA8)
                        : null;
                return packed ? { packed } : null;
            }
            if (!checkPixelFormat(format, type))
            {
                return null;
            }
            if (!stored)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            if (!kernel.keepTexels)
            {
                diverge('glGetTexImage was accepted and read black: the texels live with'
                    + ' the context that draws, in the graphics worker, and are not read back');
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
            if (RECTANGLES.has(target))
            {
                // No compressed format is a rectangle's (3.1 section 3.8.3).
                enter('glCompressedTexImage2DARB', [target]);
                setError(GL.INVALID_ENUM);
                return;
            }
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
            return compressedTexSubImage2D('glCompressedTexSubImage2DARB', target, level, x0, y0,
                width, height, format, size, data);
        },

        /**
         * A level of a compressed sized format hands back its blocks. An S3TC
         * level's are not kept here, only their decoding, so there is nothing
         * to hand back: an operation error, and a divergence, because the
         * real driver would have answered.
         *
         * @param {number} target
         * @param {number} level
         * @returns {Uint8Array | null}
         */
        glGetCompressedTexImageARB(target, level){
            if (!enter('glGetCompressedTexImageARB', [target, level]))
            {
                return null;
            }
            const image = imageTarget(target);
            const stored = image?.texture.levels.get(levelKey(level, image.face));
            if (stored?.sized?.compressed)
            {
                const sized = stored.sized;
                return stored.data?.slice() ?? new Uint8Array(storageBytes(sized, stored.width,
                    stored.height, stored.depth ?? 1));
            }
            if (stored && !stored.compressedFormat)
            {
                // Not a compressed level at all (OpenGL 4.6 section 8.11).
                setError(GL.INVALID_OPERATION);
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

        /**
         * A 2D array of a compressed sized format (S3TC's own formats are kept
         * as decoded 2D images and are not taken here).
         *
         * @param {number} target @param {number} level @param {number} internal
         * @param {number} width @param {number} height @param {number} depth
         * @param {number} border @param {number} size
         * @param {number | Uint8Array | null} [data]
         */
        glCompressedTexImage3DARB(target, level, internal, width, height, depth, border, size,
            data)
        {
            const sized = sizedFormatOf(internal);
            if (target !== TEX.TEXTURE_2D_ARRAY || !sized?.compressed)
            {
                enter('glCompressedTexImage3DARB', [target]);
                setError(target === TEX.TEXTURE_2D_ARRAY || target === GL.TEXTURE_3D
                    ? GL.INVALID_OPERATION : GL.INVALID_ENUM);
                return;
            }
            compressedSized('glCompressedTexImage3DARB', target, level, internal, sized, width,
                height, depth, border, size, data ?? null);
        },

        /** @param {number} target */
        glCompressedTexSubImage1DARB(target){
            enter('glCompressedTexSubImage1DARB', [target]);
            setError(GL.INVALID_ENUM);
        },

        /**
         * @param {number} target @param {number} level
         * @param {number} x0 @param {number} y0 @param {number} z0
         * @param {number} width @param {number} height @param {number} depth
         * @param {number} format @param {number} size
         * @param {number | Uint8Array | null} [data]
         */
        glCompressedTexSubImage3DARB(target, level, x0, y0, z0, width, height, depth, format,
            size, data)
        {
            return compressedTexSubImage3D('glCompressedTexSubImage3DARB', target, level, x0, y0,
                z0, width, height, depth, format, size, data);
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

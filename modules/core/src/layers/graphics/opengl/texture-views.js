/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texture views (OpenGL 4.3 section 8.18, ARB_texture_view): a texture whose
 * levels are a range of another's immutable storage, under a target and an
 * internal format of the same class.
 *
 * - **A view keeps no texels of its own.** Its `levels` and `dirty` are the
 *   original's, read through the view's range (`ViewLevels`, `ViewDirty`):
 *   a level the view names whole is the original's very level object, so a
 *   write through either is the other's; a range of an array's layers is a
 *   level reading and writing the original's bytes in place (`sliceLevel`).
 * - **A view of a view is a view of the first original** (`root`), its range
 *   counted within the range it was made from.
 * - **On the device a view is a view of the original's surface** (`gpu.js`):
 *   its levels, layers and dimension as a GPUTextureView's subresource range.
 */

import { GL } from './constants.js';
import { SIZED_FORMATS, TEX } from './formats.js';
import { FACE_STRIDE, levelKey } from './objects.js';
import { blankStorage, rgbaOf, storageBytes, uncompressedTwin } from './texture-levels.js';

/**
 * What a view is of: its original's root, and the range of that root it
 * covers, in the root's own levels and layers (a cube map's faces counted
 * as layers).
 *
 * @typedef {Object} ViewRange
 * @property {import('./objects.js').TextureObject} root
 * @property {number} minLevel @property {number} numLevels
 * @property {number} minLayer @property {number} numLayers
 * @property {number} internal  the view's internal format
 */

/**
 * The view targets each original target takes (4.3 table 8.21), the
 * original's own first.
 *
 * @type {ReadonlyMap<number, readonly number[]>}
 */
export const VIEW_TARGETS = new Map([
    [GL.TEXTURE_1D, [GL.TEXTURE_1D, TEX.TEXTURE_1D_ARRAY]],
    [GL.TEXTURE_2D, [GL.TEXTURE_2D, TEX.TEXTURE_2D_ARRAY]],
    [GL.TEXTURE_3D, [GL.TEXTURE_3D]],
    [GL.TEXTURE_CUBE_MAP, [GL.TEXTURE_CUBE_MAP, GL.TEXTURE_2D, TEX.TEXTURE_2D_ARRAY,
        TEX.TEXTURE_CUBE_MAP_ARRAY]],
    [GL.TEXTURE_RECTANGLE, [GL.TEXTURE_RECTANGLE]],
    [TEX.TEXTURE_1D_ARRAY, [GL.TEXTURE_1D, TEX.TEXTURE_1D_ARRAY]],
    [TEX.TEXTURE_2D_ARRAY, [GL.TEXTURE_2D, TEX.TEXTURE_2D_ARRAY, GL.TEXTURE_CUBE_MAP,
        TEX.TEXTURE_CUBE_MAP_ARRAY]],
    [TEX.TEXTURE_CUBE_MAP_ARRAY, [GL.TEXTURE_CUBE_MAP, GL.TEXTURE_2D, TEX.TEXTURE_2D_ARRAY,
        TEX.TEXTURE_CUBE_MAP_ARRAY]],
    [GL.TEXTURE_2D_MULTISAMPLE, [GL.TEXTURE_2D_MULTISAMPLE, GL.TEXTURE_2D_MULTISAMPLE_ARRAY]],
    [GL.TEXTURE_2D_MULTISAMPLE_ARRAY, [GL.TEXTURE_2D_MULTISAMPLE,
        GL.TEXTURE_2D_MULTISAMPLE_ARRAY]],
]);

/**
 * The view classes (4.3 table 8.22 and the S3TC classes of
 * EXT_texture_compression_s3tc's interaction): a view may take another
 * format of its original's class; a format of no class only itself.
 *
 * @type {readonly (readonly number[])[]}
 */
const VIEW_CLASSES = [
    [TEX.RGBA32F, TEX.RGBA32UI, TEX.RGBA32I],
    [TEX.RGB32F, TEX.RGB32UI, TEX.RGB32I],
    [TEX.RGBA16F, TEX.RG32F, TEX.RGBA16UI, TEX.RG32UI, TEX.RGBA16I, TEX.RG32I, GL.RGBA16,
        TEX.RGBA16_SNORM],
    [GL.RGB16, TEX.RGB16_SNORM, TEX.RGB16F, TEX.RGB16UI, TEX.RGB16I],
    [TEX.RG16F, TEX.R11F_G11F_B10F, TEX.R32F, TEX.RGB10_A2UI, TEX.RGBA8UI, TEX.RG16UI,
        TEX.R32UI, TEX.RGBA8I, TEX.RG16I, TEX.R32I, GL.RGB10_A2, GL.RGBA8, TEX.RG16,
        TEX.RGBA8_SNORM, TEX.RG16_SNORM, TEX.SRGB8_ALPHA8, TEX.RGB9_E5],
    [GL.RGB8, TEX.RGB8_SNORM, TEX.SRGB8, TEX.RGB8UI, TEX.RGB8I],
    [TEX.R16F, TEX.RG8UI, TEX.R16UI, TEX.RG8I, TEX.R16I, TEX.RG8, TEX.R16, TEX.RG8_SNORM,
        TEX.R16_SNORM],
    [TEX.R8UI, TEX.R8I, TEX.R8, TEX.R8_SNORM],
    [TEX.COMPRESSED_RED_RGTC1, TEX.COMPRESSED_SIGNED_RED_RGTC1],
    [TEX.COMPRESSED_RG_RGTC2, TEX.COMPRESSED_SIGNED_RG_RGTC2],
    [TEX.COMPRESSED_RGBA_BPTC_UNORM, TEX.COMPRESSED_SRGB_ALPHA_BPTC_UNORM],
    [TEX.COMPRESSED_RGB_BPTC_SIGNED_FLOAT, TEX.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT],
    [GL.COMPRESSED_RGB_S3TC_DXT1_EXT, TEX.COMPRESSED_SRGB_S3TC_DXT1],
    [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT1],
    [GL.COMPRESSED_RGBA_S3TC_DXT3_EXT, TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT3],
    [GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, TEX.COMPRESSED_SRGB_ALPHA_S3TC_DXT5],
];

/**
 * Whether a view of a texture in `original` may be in `internal`.
 *
 * @param {number} original @param {number} internal
 */
export function viewCompatible(original, internal){
    if (original === internal)
    {
        return true;
    }
    return VIEW_CLASSES.some(group=>group.includes(original) && group.includes(internal));
}

/**
 * How a target keeps its layers: a cube map's faces as levels of their own,
 * a 1D array's as its levels' rows, the other arrays' as their depth, and a
 * texture of one layer.
 *
 * @param {number} target @returns {'faces' | 'rows' | 'slices' | 'single'}
 */
export function layersKept(target){
    if (target === GL.TEXTURE_CUBE_MAP)
    {
        return 'faces';
    }
    if (target === TEX.TEXTURE_1D_ARRAY)
    {
        return 'rows';
    }
    return target === TEX.TEXTURE_2D_ARRAY || target === TEX.TEXTURE_CUBE_MAP_ARRAY
        || target === GL.TEXTURE_2D_MULTISAMPLE_ARRAY ? 'slices' : 'single';
}

/**
 * How many layers a texture's base level holds, as a view counts them.
 *
 * @param {import('./objects.js').TextureObject} texture
 */
export function layerCount(texture){
    const kept = layersKept(texture.target);
    const base = texture.levels.get(levelKey(0));
    return kept === 'faces' ? 6 : kept === 'rows' ? base?.height ?? 1
        : kept === 'slices' ? base?.depth ?? 1 : 1;
}

/**
 * A range of an array level's layers as a level of its own: its bytes are
 * the original's, read and written in place, so a write through either is
 * the other's.
 *
 * @param {import('./objects.js').TextureLevel} source
 * @param {number} from @param {number} count
 * @param {boolean} rows  a 1D array's layers, which are its rows
 * @returns {import('./objects.js').TextureLevel}
 */
export function sliceLevel(source, from, count, rows){
    const width = source.width;
    const height = rows ? count : source.height;
    const depth = rows ? 1 : count;
    const sized = source.sized ?? null;
    // The bytes of one layer: a 1D array's is a row of the level.
    const layerBytes = sized ? storageBytes(sized, width, rows ? 1 : source.height, 1) : 0;
    const rgbaBytes = width * (rows ? 1 : source.height) * 4;
    /** @type {import('./objects.js').TextureLevel} */
    const level = {
        width, height, depth, border: 0, internalFormat: source.internalFormat,
        baseFormat: source.baseFormat, sized, compressed: null, source,
        get data(){
            return source.data
                ? source.data.subarray(from * layerBytes, (from + count) * layerBytes) : null;
        },
        set data(value){
            if (!sized || !value)
            {
                return;
            }
            // The original keeps no bytes yet (they were left with the
            // device): the whole level is made, and this range written.
            source.data ??= blankStorage(sized, source.width, source.height,
                source.depth ?? 1);
            source.data.set(value.subarray(0, count * layerBytes), from * layerBytes);
        },
        get texels(){
            const all = source.texels;
            return all ? all.subarray(from * rgbaBytes, (from + count) * rgbaBytes) : null;
        },
        set texels(value){
            if (value && source.texels)
            {
                source.texels.set(value.subarray(0, count * rgbaBytes), from * rgbaBytes);
            }
        },
    };
    return level;
}

/**
 * A level read in another format of its class: the same bytes, under the
 * view's format, where the level keeps its own format's bits (a sized
 * level's bytes, or a legacy RGBA8 level's texels); null where it keeps
 * them in another format (a legacy format's RGBA8 in an array), which the
 * processor then holds no level of.
 *
 * @param {import('./objects.js').TextureLevel} source @param {number} internal
 * @returns {import('./objects.js').TextureLevel | null}
 */
export function reformatLevel(source, internal){
    if (source.internalFormat === internal)
    {
        return source;
    }
    const asked = SIZED_FORMATS.get(internal);
    const from = source.sized ?? (source.internalFormat === GL.RGBA8 && !source.compressed
        ? /** @type {import('./formats.js').SizedFormat} */ (SIZED_FORMATS.get(GL.RGBA8)) : null);
    if (!asked || !from)
    {
        return null;
    }
    const sized = from.compressed ? asked : uncompressedTwin(asked);
    // Bytes kept in another format than the level's own (a legacy format's
    // RGBA8 in an array) are not its format's bits, which a view reinterprets.
    if (from.internal !== source.internalFormat && !from.compressed)
    {
        return null;
    }
    // A class's formats have as many bits a texel, so formats kept as
    // themselves keep a texel in as many bytes.
    if (sized.compressed !== from.compressed)
    {
        return null;
    }
    const depth = source.depth ?? 1;
    /** @type {import('./objects.js').TextureLevel} */
    const level = {
        width: source.width, height: source.height, depth, border: 0, internalFormat: internal,
        baseFormat: sized.base, sized, compressed: null, source,
        get data(){
            return source.sized ? source.data ?? null : source.texels;
        },
        set data(value){
            if (source.sized)
            {
                source.data = value;
            }
            else
            {
                source.texels = value;
            }
        },
        get texels(){
            const data = level.data;
            return data ? rgbaOf(data, sized, source.width, source.height, depth) : null;
        },
        set texels(value){
            // The level keeps bytes in its own format; RGBA is only read from them.
            void value;
        },
    };
    return level;
}

/**
 * Where a view's level key lies in its root: the root's key, and the range
 * of that root level's layers it reads (null: the root level whole).
 *
 * @param {number} target  the view's target
 * @param {ViewRange} range @param {number} key
 * @returns {{ key: number, slice: { from: number, count: number, rows: boolean } | null }
 *     | null}
 */
export function rootKeyOf(target, range, key){
    const level = key % FACE_STRIDE;
    const face = (key - level) / FACE_STRIDE;
    const view = layersKept(target);
    if (level >= range.numLevels || (view !== 'faces' && face !== 0) || face >= 6)
    {
        return null;
    }
    const rootLevel = range.minLevel + level;
    const root = layersKept(range.root.target);
    if (root === 'faces')
    {
        // A cube map's faces are levels of their own: a view takes one face,
        // or all six, never a gathering of them.
        if (view === 'faces' || view === 'single')
        {
            return { key: levelKey(rootLevel, range.minLayer + face), slice: null };
        }
        return null;
    }
    if (root === 'single')
    {
        return face === 0 ? { key: levelKey(rootLevel), slice: null } : null;
    }
    const all = layerCount(range.root);
    const from = range.minLayer + (view === 'faces' ? face : 0);
    const count = view === 'faces' || view === 'single' ? 1 : range.numLayers;
    return { key: levelKey(rootLevel),
        slice: from === 0 && count === all && view !== 'single' && view !== 'faces' ? null
            : { from, count, rows: root === 'rows' } };
}

/**
 * Whether a view's levels can be read through its root at all: a gathering
 * of a cube map's separate faces into an array cannot.
 *
 * @param {number} target @param {ViewRange} range
 */
export function viewReadable(target, range){
    return layersKept(range.root.target) !== 'faces'
        || layersKept(target) === 'faces' || layersKept(target) === 'single';
}

/**
 * The levels of a view: its root's, through `rootKeyOf`. A level the view
 * holds whole is the root's own object, a range of layers a `sliceLevel` of
 * it. A level set through the view is the root's; a range of layers set
 * writes its bytes into the root's level.
 */
export class ViewLevels
{
    /** @param {number} target @param {ViewRange} range */
    constructor(target, range){
        this.target = target;
        this.range = range;
        /** @type {WeakMap<object, Map<string, import('./objects.js').TextureLevel>>} */
        this.slices = new WeakMap();
        /** @type {WeakMap<object, import('./objects.js').TextureLevel | null>} */
        this.formats = new WeakMap();
    }

    /** @param {number} key @returns {import('./objects.js').TextureLevel | undefined} */
    get(key){
        const at = rootKeyOf(this.target, this.range, key);
        const source = at ? this.range.root.levels.get(at.key) : undefined;
        if (!at || !source)
        {
            return undefined;
        }
        const level = at.slice ? this.sliceOf(source, at.slice) : source;
        if (level.internalFormat === this.range.internal)
        {
            return level;
        }
        let made = this.formats.get(level);
        if (made === undefined)
        {
            made = reformatLevel(level, this.range.internal);
            this.formats.set(level, made);
        }
        return made ?? undefined;
    }

    /**
     * One slice object per root level and range, so a cache keyed on a level
     * (`gpu.js` releasedLevels, the reformatted levels) sees the same level.
     *
     * @param {import('./objects.js').TextureLevel} source
     * @param {{ from: number, count: number, rows: boolean }} slice
     * @returns {import('./objects.js').TextureLevel}
     */
    sliceOf(source, slice){
        let kept = this.slices.get(source);
        if (!kept)
        {
            kept = new Map();
            this.slices.set(source, kept);
        }
        const name = `${slice.from}:${slice.count}`;
        let made = kept.get(name);
        if (!made)
        {
            made = sliceLevel(source, slice.from, slice.count, slice.rows);
            kept.set(name, made);
        }
        return made;
    }

    /** @param {number} key */
    has(key){
        return this.get(key) !== undefined;
    }

    /**
     * @param {number} key @param {import('./objects.js').TextureLevel} level
     * @returns {this}
     */
    set(key, level){
        const at = rootKeyOf(this.target, this.range, key);
        if (!at)
        {
            return this;
        }
        if (!at.slice)
        {
            this.range.root.levels.set(at.key, level);
            return this;
        }
        const slice = this.get(key);
        if (slice && level.data)
        {
            slice.data = level.data;
        }
        return this;
    }

    /** A view's levels are its root's: nothing a view does takes them away. */
    delete(){
        return false;
    }

    clear(){}

    /** @returns {number[]} the view's level keys that hold a level */
    keys(){
        /** @type {number[]} */
        const keys = [];
        const faces = layersKept(this.target) === 'faces' ? 6 : 1;
        for (let level = 0; level < this.range.numLevels; level++)
        {
            for (let face = 0; face < faces; face++)
            {
                if (this.has(levelKey(level, face)))
                {
                    keys.push(levelKey(level, face));
                }
            }
        }
        return keys;
    }

    get size(){
        return this.keys().length;
    }

    /** @returns {IterableIterator<[number, import('./objects.js').TextureLevel]>} */
    *entries(){
        for (const key of this.keys())
        {
            yield [key, /** @type {import('./objects.js').TextureLevel} */ (this.get(key))];
        }
    }

    *values(){
        for (const [, level] of this.entries())
        {
            yield level;
        }
    }

    [Symbol.iterator](){
        return this.entries();
    }

    /** @param {(level: import('./objects.js').TextureLevel, key: number) => void} each */
    forEach(each){
        for (const [key, level] of this.entries())
        {
            each(level, key);
        }
    }
}

/**
 * What a view writes is its root's to send to the device: a key marked
 * here marks the root's level, a range of layers the root's level whole.
 */
export class ViewDirty
{
    /** @param {number} target @param {ViewRange} range */
    constructor(target, range){
        this.target = target;
        this.range = range;
    }

    /** @param {number} key */
    get(key){
        const at = rootKeyOf(this.target, this.range, key);
        return at ? this.range.root.dirty.get(at.key) : undefined;
    }

    /** @param {number} key */
    has(key){
        return this.get(key) !== undefined;
    }

    /**
     * @param {number} key @param {import('./objects.js').DirtyRect | null} rect
     * @returns {this}
     */
    set(key, rect){
        const at = rootKeyOf(this.target, this.range, key);
        if (at)
        {
            // A rectangle of some layers is not one of the level's own.
            this.range.root.dirty.set(at.key, at.slice ? null : rect);
        }
        return this;
    }

    delete(){
        return false;
    }

    /** The root's marks are cleared by whoever sends its levels. */
    clear(){}

    get size(){
        return 0;
    }

    *[Symbol.iterator](){
        // A view's marks are its root's, sent with the root's levels.
    }
}

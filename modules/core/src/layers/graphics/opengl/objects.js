/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The objects a context owns, and the group that owns them jointly.
 *
 * Objects do not belong to a context; they belong to a **share group**, and a
 * context names one. That is the whole content of `wglShareLists`, and getting
 * it wrong is invisible until a program creates a texture in one context and
 * draws it from another.
 *
 * Four properties of the group are contract and were established by
 * measurement:
 *
 * - **Namespaces are per object type.** Texture 1 and display list 1 are
 *   different things and both exist at once. Asking whether a texture name is
 *   a list is not an error; the answer is simply no.
 * - **Names are the lowest unused ones**, starting at one. Zero is never
 *   generated: it is the default object of each texture target.
 * - **A generated texture name is not yet a texture.** `glIsTexture` says no
 *   until the name has been bound, because binding is what brings the object
 *   into existence. Display lists are the opposite -- `glGenLists` creates
 *   them empty, and they answer yes immediately.
 * - **A group that has ever held an object can never be replaced.** Sharing
 *   into it fails, and it goes on failing after every object in it has been
 *   deleted, so the flag is "was ever used" and not "is empty now".
 *
 * The objects survive the context that created them for as long as any context
 * in the group is alive.
 */

import { GL } from './constants.js';

/**
 * An incomplete texture -- one whose minification filter wants mipmaps it
 * does not have -- is not an error and is not reported anywhere. Its unit
 * draws as if texturing were off, which is why an unfiltered upload shows up
 * as untextured white rather than as black or as a fault.
 */

/**
 * The four minification filters that need a complete mipmap pyramid. The
 * default, GL_NEAREST_MIPMAP_LINEAR, is one of them, which is why a texture
 * that was given a single level and no parameters samples black.
 */
/** @type {Set<number>} */
const MIPMAP_FILTERS = new Set([
    GL.NEAREST_MIPMAP_NEAREST,
    GL.LINEAR_MIPMAP_NEAREST,
    GL.NEAREST_MIPMAP_LINEAR,
    GL.LINEAR_MIPMAP_LINEAR,
]);

/**
 * @typedef {Object} TextureLevel
 * @property {number} width
 * @property {number} height
 * @property {number} internalFormat
 * @property {number} border
 * @property {number} baseFormat   what the internal format reduces to
 * @property {Uint8Array | null} texels   RGBA, or null when the level was
 *           given a shape and no data
 * @property {number} [compressedFormat]  the S3TC format the data arrived in
 * @property {number} [compressedBytes]   and how many bytes it took
 */

/**
 * @typedef {Object} TextureObject
 * @property {number} name
 * @property {number} target
 * @property {Map<number, number>} parameters
 * @property {number[]} borderColour
 * @property {Map<number, TextureLevel>} levels  keyed by `levelKey`
 * @property {Set<number>} dirty   the level keys written since a copy kept
 *           elsewhere last read them
 */

/**
 * @typedef {Object} BufferObject
 * @property {number} name
 * @property {number} size
 * @property {number} usage
 * @property {number} access
 * @property {Uint8Array} data
 * @property {number} mapped  the guest address it is mapped at, or zero
 * @property {{ start: number, end: number } | null} written   the bytes the
 *           program has rewritten since a copy kept elsewhere last read them
 */

/** Cube map levels are kept in one map, six faces apart. */
export const FACE_STRIDE = 32;

/**
 * @param {number} level
 * @param {number} [face]  0..5 for a cube map
 * @returns {number}
 */
export function levelKey(level, face = 0){
    return face * FACE_STRIDE + level;
}

/**
 * @typedef {Object} ProgramObject
 * @property {number} name
 * @property {number} target   the target it belongs to; zero until first bound
 * @property {number} format   the format its string was given in; zero unloaded
 * @property {string} text     the program string as it was given
 * @property {import('./arb-program.js').ParsedProgram | null} parsed
 * @property {Float32Array} local   the local parameters, four floats each
 */

/**
 * A program object: empty and targetless until it is bound, its string the
 * last one that loaded -- a failed load leaves what was there before.
 *
 * @param {number} name
 * @param {number} target
 * @param {number} localParameters
 * @returns {ProgramObject}
 */
export function createProgramObject(name, target, localParameters){
    return {
        name,
        target,
        format: 0,
        text: '',
        parsed: null,
        local: new Float32Array(localParameters * 4),
    };
}

/**
 * @typedef {Object} DisplayList
 * @property {number} name
 * @property {{ call: string, args: any[] }[]} commands
 */

/**
 * Per-object-type parameter defaults. GL_TEXTURE_MIN_FILTER is the one that
 * matters far more than the others.
 *
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const DEFAULT_TEXTURE_PARAMETERS = Object.freeze([
    [GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_LINEAR],
    [GL.TEXTURE_MAG_FILTER, GL.LINEAR],
    [GL.TEXTURE_WRAP_S, GL.REPEAT],
    [GL.TEXTURE_WRAP_T, GL.REPEAT],
    [GL.TEXTURE_WRAP_R, GL.REPEAT],
    [GL.TEXTURE_BASE_LEVEL, 0],
    [GL.TEXTURE_MAX_LEVEL, 1000],
    [GL.TEXTURE_MIN_LOD, -1000],
    [GL.TEXTURE_MAX_LOD, 1000],
    [GL.TEXTURE_PRIORITY, 1],
    [GL.GENERATE_MIPMAP, 0],
]);

/**
 * @param {number} name
 * @param {number} target
 * @returns {TextureObject}
 */
export function createTextureObject(name, target){
    return {
        name,
        target,
        parameters: new Map(DEFAULT_TEXTURE_PARAMETERS),
        borderColour: [0, 0, 0, 0],
        levels: new Map(),
        dirty: new Set(),
    };
}

/**
 * @param {number} name
 * @returns {BufferObject}
 */
export function createBufferObject(name){
    return { name, size: 0, usage: GL.STATIC_DRAW, access: GL.READ_WRITE, data: new Uint8Array(0),
        mapped: 0, written: null };
}

/**
 * Whether a texture can be sampled at all. Only the mipmap chain is checked
 * here: a level whose dimensions do not halve, or whose format differs, is the
 * same kind of defect and the same answer.
 *
 * @param {TextureObject} texture
 * @returns {boolean}
 */
export function isTextureComplete(texture){
    const faces = texture.target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
    const base = texture.levels.get(levelKey(0));
    if (!base || base.width === 0 || base.height === 0)
    {
        return false;
    }
    for (let face = 0; face < faces; face++)
    {
        const first = texture.levels.get(levelKey(0, face));
        // A cube map's faces have to be square and all the same size, or
        // there is no cube to sample.
        if (!first || first.width !== base.width || first.height !== base.height
            || (faces > 1 && first.width !== first.height))
        {
            return false;
        }
        if (!MIPMAP_FILTERS.has(texture.parameters.get(GL.TEXTURE_MIN_FILTER) ?? 0))
        {
            continue;
        }
        let width = base.width;
        let height = base.height;
        let level = 0;
        while (width > 1 || height > 1)
        {
            level++;
            width = Math.max(1, width >> 1);
            height = Math.max(1, height >> 1);
            const image = texture.levels.get(levelKey(level, face));
            if (!image || image.width !== width || image.height !== height
                || image.internalFormat !== base.internalFormat)
            {
                return false;
            }
        }
    }
    return true;
}

/**
 * A namespace of names, handing out the lowest unused one. `reserved` holds
 * names that have been generated but do not name an object yet, which is the
 * state a texture name is in between glGenTextures and its first glBindTexture.
 */
function createNamespace(){
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @type {Set<number>} */
    const reserved = new Set();

    /** @returns {number} */
    const lowestUnused = ()=>{
        let name = 1;
        while (objects.has(name) || reserved.has(name))
        {
            name++;
        }
        return name;
    };

    return {
        objects,
        reserved,

        /** @param {number} count @returns {number[]} */
        reserve(count){
            /** @type {number[]} */
            const names = [];
            for (let i = 0; i < count; i++)
            {
                const name = lowestUnused();
                reserved.add(name);
                names.push(name);
            }
            return names;
        },

        /**
         * A contiguous run, which is what glGenLists promises and what a
         * program relies on when it adds a character code to the first name.
         *
         * @param {number} count
         * @returns {number}
         */
        reserveRange(count){
            let first = 1;
            for (;;)
            {
                let free = true;
                for (let i = 0; i < count; i++)
                {
                    if (objects.has(first + i) || reserved.has(first + i))
                    {
                        free = false;
                        break;
                    }
                }
                if (free)
                {
                    return first;
                }
                first++;
            }
        },

        /** @param {number} name @param {any} object */
        define(name, object){
            reserved.delete(name);
            objects.set(name, object);
        },

        /** @param {number} name */
        remove(name){
            objects.delete(name);
            reserved.delete(name);
        },
    };
}

/**
 * @typedef {ReturnType<typeof createShareGroup>} ShareGroup
 */

/**
 * @returns {{ textures: ReturnType<typeof createNamespace>,
 *             lists: ReturnType<typeof createNamespace>,
 *             buffers: ReturnType<typeof createNamespace>,
 *             programs: ReturnType<typeof createNamespace>,
 *             contexts: number, used: boolean }}
 */
export function createShareGroup(){
    return {
        textures: createNamespace(),
        lists: createNamespace(),
        buffers: createNamespace(),
        programs: createNamespace(),
        /** How many contexts name this group. The objects outlive all but the last. */
        contexts: 0,
        /**
         * Sticky: set the first time anything is created here, and never
         * cleared. wglShareLists refuses a destination whose group is used,
         * and goes on refusing after the objects are gone.
         */
        used: false,
    };
}

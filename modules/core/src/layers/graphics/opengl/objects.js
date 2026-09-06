/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
 * The colour an incomplete texture samples as. A texture whose minification
 * filter wants mipmaps and has none is incomplete, which is not an error and
 * is not reported anywhere -- it just draws black, opaque, everywhere.
 */
export const INCOMPLETE_TEXTURE_SAMPLE = Object.freeze([0, 0, 0, 1]);

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
 */

/**
 * @typedef {Object} TextureObject
 * @property {number} name
 * @property {number} target
 * @property {Map<number, number>} parameters
 * @property {Map<number, TextureLevel>} levels
 */

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
    [GL.TEXTURE_BASE_LEVEL, 0],
    [GL.TEXTURE_MAX_LEVEL, 1000],
]);

/**
 * @param {number} name
 * @param {number} target
 * @returns {TextureObject}
 */
export function createTextureObject(name, target){
    return { name, target, parameters: new Map(DEFAULT_TEXTURE_PARAMETERS), levels: new Map() };
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
    const base = texture.levels.get(0);
    if (!base)
    {
        return false;
    }
    if (!MIPMAP_FILTERS.has(texture.parameters.get(GL.TEXTURE_MIN_FILTER) ?? 0))
    {
        return true;
    }
    let width = base.width;
    let height = base.height;
    let level = 0;
    while (width > 1 || height > 1)
    {
        level++;
        width = Math.max(1, width >> 1);
        height = Math.max(1, height >> 1);
        const image = texture.levels.get(level);
        if (!image || image.width !== width || image.height !== height
            || image.internalFormat !== base.internalFormat)
        {
            return false;
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
 *             contexts: number, used: boolean }}
 */
export function createShareGroup(){
    return {
        textures: createNamespace(),
        lists: createNamespace(),
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

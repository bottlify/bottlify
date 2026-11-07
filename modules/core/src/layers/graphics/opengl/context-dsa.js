/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct state access (OpenGL 4.5 chapter 6, 8 and 9, GL_ARB_direct_state_access):
 * the calls that name the object they work on instead of reaching it through
 * a binding, and the glCreate* calls that make objects at once.
 *
 * - **A named call does what its bound form does**, with the same checks and
 *   the same errors, and leaves every binding as it found it. A texture is
 *   passed into the bound form's code (`context-textures.js` withTexture),
 *   which then works on it in place of the bound one. A buffer, a
 *   framebuffer or a renderbuffer is bound for the call and the binding put
 *   back after it: what a program can read of the bindings is the same before
 *   and after, the draw and read buffers of the window included.
 * - **A name that is no object is GL_INVALID_OPERATION** (sections 6.1, 8.1,
 *   9.2.1): a name generated and never bound is none yet. glGetTextureSubImage
 *   is the one exception, GL_INVALID_VALUE (section 8.11.4,
 *   `context-textures.js`).
 * - **A call whose target the texture is not is GL_INVALID_OPERATION**: the
 *   target is the texture's, so a mismatch is the object's, not the enum's.
 *   A cube map's faces are a 3D call's z.
 * - **Every named call runs as it is reached**, a display list open or not:
 *   it names its objects, which a list replayed later would find others
 *   under. The few that go through a bound form a list records (the draw and
 *   read buffers, the clears) say so when a list is open.
 * - Left out: the vertex arrays' and transform feedback's named calls,
 *   buffer storage and its clears (glNamedBufferStorage, glClearNamedBufferData,
 *   whose bound forms of 4.3 and 4.4 are not here), buffer and multisample
 *   textures, query objects made at once (glCreateQueries) and their results
 *   into a buffer, and program pipelines.
 */

import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createBufferObject, createTextureObject } from './objects.js';
import { clientLayout } from './texture-transfer.js';

/** A cube map's faces, in the order a 3D call's z counts them. */
const CUBE_FACES = [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a];

/**
 * The targets glCreateTextures makes a texture of here, and those it is
 * given that name textures this implementation has none of.
 *
 * @type {ReadonlySet<number>}
 */
const CREATE_TARGETS = new Set([GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D,
    GL.TEXTURE_CUBE_MAP, TEX.TEXTURE_1D_ARRAY, TEX.TEXTURE_2D_ARRAY, GL.TEXTURE_RECTANGLE,
    GL.TEXTURE_BUFFER]);
/** @type {ReadonlyMap<number, string>} */
const ABSENT_TARGETS = new Map([
    [0x9009, 'cube map array'], [0x9100, 'multisample'], [0x9102, 'multisample array']]);

/** The texture targets each dimension's calls take (sections 8.6 and 8.19). */
/** @type {Record<1 | 2 | 3, ReadonlySet<number>>} */
const DIMENSION_TARGETS = {
    1: new Set([GL.TEXTURE_1D]),
    2: new Set([GL.TEXTURE_2D, TEX.TEXTURE_1D_ARRAY, GL.TEXTURE_CUBE_MAP,
        GL.TEXTURE_RECTANGLE]),
    3: new Set([GL.TEXTURE_3D, TEX.TEXTURE_2D_ARRAY, GL.TEXTURE_CUBE_MAP]),
};

/** The attachments glInvalidateNamedFramebufferData names on the default framebuffer. */
/** @type {ReadonlySet<number>} */
const DEFAULT_ATTACHMENTS = new Set([GL.FRONT_LEFT, GL.FRONT_RIGHT, GL.BACK_LEFT,
    GL.BACK_RIGHT, GL.COLOR, GL.DEPTH, GL.STENCIL]);

/** Every call of this file: none is compiled into a display list. */
export const DSA_CALLS_NOT_COMPILED = Object.freeze([
    'glCreateTextures', 'glTextureStorage1D', 'glTextureStorage2D', 'glTextureStorage3D',
    'glTextureSubImage1D', 'glTextureSubImage2D', 'glTextureSubImage3D',
    'glCompressedTextureSubImage1D', 'glCompressedTextureSubImage2D',
    'glCompressedTextureSubImage3D', 'glCopyTextureSubImage1D', 'glCopyTextureSubImage2D',
    'glCopyTextureSubImage3D', 'textureParameter', 'textureParameterI', 'getTextureParameter',
    'glGetTextureLevelParameter', 'glGenerateTextureMipmap', 'glBindTextureUnit',
    'glGetTextureImage', 'glGetCompressedTextureImage', 'glCreateBuffers', 'namedBuffer',
    'glCopyNamedBufferSubData', 'namedFramebuffer', 'namedFramebufferTexture',
    'glBlitNamedFramebuffer',
    'glCheckNamedFramebufferStatus', 'glInvalidateNamedFramebuffer', 'namedRenderbuffer',
    'glCreateSamplers',
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installDirectStateCalls(context, kernel){
    const { enter, setError, record, setState, diverge } = kernel;
    const side = kernel.side;

    /** The texture calls' own work, installed before this file. */
    const textures = ()=>side.textureCalls;

    /** Whether a display list is being compiled, which the bound forms of some calls join. */
    const listOpen = ()=>record(GL.LIST_INDEX).values[0] !== 0;

    /** @param {string} call */
    const throughList = call=>{
        if (listOpen())
        {
            diverge(`${call} was made while a display list was compiled: it ran through its`
                + ' bound form, which the list recorded as well');
        }
    };

    /**
     * The texture a call names, or null with the error raised.
     *
     * @param {number} name @param {number} [error]
     * @returns {import('./objects.js').TextureObject | null}
     */
    const textureNamed = (name, error = GL.INVALID_OPERATION)=>{
        const texture = name === 0 ? undefined : kernel.shareGroup().textures.objects.get(name);
        if (!texture)
        {
            setError(error);
            return null;
        }
        return texture;
    };

    /**
     * Runs `body` on the texture a call names, the call's target checked
     * against the texture's.
     *
     * @template T
     * @param {string} call @param {any[]} args @param {number} name
     * @param {ReadonlySet<number> | null} targets  null: any
     * @param {(texture: import('./objects.js').TextureObject) => T} body
     * @returns {T | null}
     */
    const onTexture = (call, args, name, targets, body)=>{
        if (!enter(call, args))
        {
            return null;
        }
        const texture = textureNamed(name);
        if (!texture)
        {
            return null;
        }
        if (targets && !targets.has(texture.target))
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        return side.withTexture(texture, ()=>body(texture));
    };

    /**
     * The unpack state's bytes from one image of a client image to the next,
     * for a cube map's faces given as a 3D call's slices.
     *
     * @param {number} width @param {number} height @param {number} format @param {number} type
     * @returns {number}
     */
    const imageStride = (width, height, format, type)=>{
        const value = (/** @type {number} */ query)=>record(query)?.values[0] ?? 0;
        return clientLayout(width, height, format, type, {
            alignment: value(GL.UNPACK_ALIGNMENT), rowLength: value(GL.UNPACK_ROW_LENGTH),
            skipRows: 0, skipPixels: 0, imageHeight: value(TEX.UNPACK_IMAGE_HEIGHT),
            skipImages: 0, swapBytes: false,
        })?.imageStride ?? 0;
    };

    /**
     * Binds an object for the length of `body` and puts the binding back:
     * the buffer to `target`, as glBindBuffer would.
     *
     * @template T
     * @param {number} target @param {number} name @param {() => T} body
     * @returns {T}
     */
    const boundBuffer = (target, name, body)=>{
        const was = record(target).values[0];
        setState(target, [name]);
        try
        {
            return body();
        }
        finally
        {
            setState(target, [was]);
        }
    };

    /**
     * The same for a framebuffer, on the draw binding, the read one or both.
     * Binding the window's framebuffer for reading sets its read buffer back
     * to the default; the one the program chose is put back too.
     *
     * @template T
     * @param {{ draw?: number, read?: number }} names @param {() => T} body
     * @returns {T}
     */
    const boundFramebuffers = (names, body)=>{
        const draw = record(GL.FRAMEBUFFER_BINDING).values[0];
        const read = record(GL.READ_FRAMEBUFFER_BINDING).values[0];
        const windowRead = record(GL.READ_BUFFER).values[0];
        if (names.draw !== undefined)
        {
            context.bindFramebuffer(GL.DRAW_FRAMEBUFFER, names.draw, false);
        }
        if (names.read !== undefined)
        {
            context.bindFramebuffer(GL.READ_FRAMEBUFFER, names.read, false);
        }
        try
        {
            return body();
        }
        finally
        {
            context.bindFramebuffer(GL.DRAW_FRAMEBUFFER, draw, false);
            context.bindFramebuffer(GL.READ_FRAMEBUFFER, read, false);
            if (read === 0)
            {
                setState(GL.READ_BUFFER, [windowRead]);
            }
        }
    };

    /** @param {number} name @returns {boolean} whether it names a framebuffer, zero the window's */
    const framebufferKnown = name=>context.framebufferNamed(name) !== undefined;

    Object.assign(context, {
        // --- textures ---

        /**
         * @param {number} target @param {number} count
         * @returns {number[]} names that are textures of `target` at once
         */
        glCreateTextures(target, count){
            if (!enter('glCreateTextures', [target, count]))
            {
                return [];
            }
            if (!CREATE_TARGETS.has(target))
            {
                if (ABSENT_TARGETS.has(target))
                {
                    diverge(`glCreateTextures of a ${ABSENT_TARGETS.get(target)} texture was`
                        + ' refused: this implementation has none');
                }
                setError(GL.INVALID_ENUM);
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            const group = kernel.shareGroup();
            const names = group.textures.reserve(count);
            for (const name of names)
            {
                group.textures.define(name, createTextureObject(name, target));
            }
            group.used = names.length > 0 || group.used;
            return names;
        },

        /**
         * glTextureStorage1D, 2D and 3D.
         *
         * @param {1 | 2 | 3} dimensions @param {number} name @param {number} levels
         * @param {number} internal @param {number} width @param {number} height
         * @param {number} depth
         */
        textureStorage(dimensions, name, levels, internal, width, height, depth){
            const call = `glTextureStorage${dimensions}D`;
            onTexture(call, [dimensions, name, levels, internal, width, height, depth], name,
                DIMENSION_TARGETS[dimensions], texture=>textures().texStorage(call, dimensions,
                    texture.target, levels, internal, width, height, depth));
        },

        /**
         * glTextureSubImage1D, 2D and 3D: a box, a 2D call's depth one and a
         * 1D call's height. A cube map takes the 3D call, its faces the box's z.
         *
         * @param {1 | 2 | 3} dimensions @param {number} name @param {number} level
         * @param {import('./texture-levels.js').Box} box
         * @param {number} format @param {number} type @param {number | Uint8Array | null} pixels
         */
        textureSubImage(dimensions, name, level, box, format, type, pixels){
            const call = `glTextureSubImage${dimensions}D`;
            const targets = dimensions === 2 ? new Set([GL.TEXTURE_2D, TEX.TEXTURE_1D_ARRAY])
                : DIMENSION_TARGETS[dimensions];
            onTexture(call, [dimensions, name, level, box, format, type, pixels], name, targets,
                texture=>{
                    if (texture.target !== GL.TEXTURE_CUBE_MAP)
                    {
                        textures().texSubImage(call, texture.target, level, box.x, box.y, box.z,
                            box.width, box.height, box.depth, format, type, pixels);
                        return;
                    }
                    if (box.z < 0 || box.depth < 0 || box.z + box.depth > 6)
                    {
                        setError(GL.INVALID_VALUE);
                        return;
                    }
                    const stride = imageStride(box.width, box.height, format, type);
                    for (let k = 0; k < box.depth; k++)
                    {
                        const at = typeof pixels === 'number' && pixels !== 0
                            ? pixels + k * stride : pixels;
                        textures().texSubImage(call, CUBE_FACES[box.z + k], level, box.x, box.y,
                            0, box.width, box.height, 1, format, type,
                            at instanceof Uint8Array ? at.subarray(k * stride) : at);
                    }
                });
        },

        /**
         * glCompressedTextureSubImage1D, 2D and 3D. A cube map's faces are
         * the 3D call's z, their blocks one after another.
         *
         * @param {1 | 2 | 3} dimensions @param {number} name @param {number} level
         * @param {import('./texture-levels.js').Box} box
         * @param {number} format @param {number} size @param {number | Uint8Array | null} data
         */
        compressedTextureSubImage(dimensions, name, level, box, format, size, data){
            const call = `glCompressedTextureSubImage${dimensions}D`;
            const targets = dimensions === 1 ? new Set()
                : dimensions === 2 ? new Set([GL.TEXTURE_2D])
                    : new Set([TEX.TEXTURE_2D_ARRAY, GL.TEXTURE_CUBE_MAP, GL.TEXTURE_3D]);
            onTexture(call, [dimensions, name, level, box, format, size, data], name, targets,
                texture=>{
                    const calls = textures();
                    if (dimensions === 2)
                    {
                        calls.compressedTexSubImage2D(call, texture.target, level, box.x, box.y,
                            box.width, box.height, format, size, data);
                        return;
                    }
                    if (texture.target !== GL.TEXTURE_CUBE_MAP)
                    {
                        calls.compressedTexSubImage3D(call, texture.target, level, box.x, box.y,
                            box.z, box.width, box.height, box.depth, format, size, data);
                        return;
                    }
                    if (box.z < 0 || box.depth < 1 || box.z + box.depth > 6
                        || size % box.depth !== 0)
                    {
                        setError(box.depth > 0 && size % box.depth !== 0 ? GL.INVALID_OPERATION
                            : GL.INVALID_VALUE);
                        return;
                    }
                    const face = size / box.depth;
                    for (let k = 0; k < box.depth; k++)
                    {
                        calls.compressedTexSubImage2D(call, CUBE_FACES[box.z + k], level, box.x,
                            box.y, box.width, box.height, format, face,
                            data instanceof Uint8Array ? data.subarray(k * face)
                                : data ? data + k * face : data);
                    }
                });
        },

        /**
         * glCopyTextureSubImage1D, 2D and 3D: a rectangle of the read
         * framebuffer into a level, a cube map's face being the 3D call's z.
         *
         * @param {1 | 2 | 3} dimensions @param {number} name @param {number} level
         * @param {number} xoffset @param {number} yoffset @param {number} zoffset
         * @param {number} x @param {number} y @param {number} width @param {number} height
         */
        copyTextureSubImage(dimensions, name, level, xoffset, yoffset, zoffset, x, y, width,
            height)
        {
            const call = `glCopyTextureSubImage${dimensions}D`;
            const targets = dimensions === 2 ? new Set([GL.TEXTURE_2D, TEX.TEXTURE_1D_ARRAY])
                : DIMENSION_TARGETS[dimensions];
            onTexture(call, [dimensions, name, level, xoffset, yoffset, zoffset, x, y, width,
                height], name, targets, texture=>{
                const calls = textures();
                if (dimensions < 3)
                {
                    calls.copyTexSubImage2D(call, texture.target, level, xoffset, yoffset, x, y,
                        width, height);
                    return;
                }
                if (texture.target !== GL.TEXTURE_CUBE_MAP)
                {
                    calls.copyTexSubImage3D(call, texture.target, level, xoffset, yoffset,
                        zoffset, x, y, width, height);
                    return;
                }
                if (zoffset < 0 || zoffset > 5)
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
                calls.copyTexSubImage2D(call, CUBE_FACES[zoffset], level, xoffset, yoffset, x, y,
                    width, height);
            });
        },

        /**
         * glTextureParameter{i,f}{,v}.
         *
         * @param {number} name @param {number} pname @param {number[]} values
         */
        textureParameter(name, pname, values){
            onTexture('textureParameter', [name, pname, values], name, null, texture=>
                textures().texParameter('textureParameter', texture.target, pname, values));
        },

        /**
         * glTextureParameterIiv and glTextureParameterIuiv.
         *
         * @param {number} name @param {number} pname @param {number[]} values
         */
        textureParameterI(name, pname, values){
            onTexture('textureParameterI', [name, pname, values], name, null, texture=>
                textures().texParameterI('textureParameterI', texture.target, pname, values));
        },

        /**
         * glGetTextureParameter{iv,fv,Iiv,Iuiv}.
         *
         * @param {number} name @param {number} pname
         * @returns {number[] | null}
         */
        getTextureParameter(name, pname){
            return onTexture('getTextureParameter', [name, pname], name, null, texture=>
                textures().getTexParameter('getTextureParameter', texture.target, pname));
        },

        /**
         * glGetTextureLevelParameter{iv,fv}: a cube map answers for its first face.
         *
         * @param {number} name @param {number} level @param {number} pname
         * @returns {number[] | null}
         */
        glGetTextureLevelParameter(name, level, pname){
            return onTexture('glGetTextureLevelParameter', [name, level, pname], name, null,
                texture=>textures().getTexLevelParameter('glGetTextureLevelParameter',
                    texture.target === GL.TEXTURE_CUBE_MAP ? CUBE_FACES[0] : texture.target,
                    level, pname));
        },

        /** @param {number} name */
        glGenerateTextureMipmap(name){
            onTexture('glGenerateTextureMipmap', [name], name, null, texture=>
                context.glGenerateMipmap(texture.target));
        },

        /**
         * Binds a texture to a unit on the target it was made for; zero
         * unbinds every target of the unit.
         *
         * @param {number} unit @param {number} name
         */
        glBindTextureUnit(unit, name){
            if (!enter('glBindTextureUnit', [unit, name]))
            {
                return;
            }
            const held = side.units[unit];
            if (!held)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (name === 0)
            {
                for (const target of held.bindings.keys())
                {
                    held.bindings.set(target, 0);
                }
                return;
            }
            const texture = textureNamed(name);
            if (texture)
            {
                held.bindings.set(texture.target, name);
            }
        },

        /**
         * @param {number} name @param {number} level @param {number} format
         * @param {number} type @param {number} bufSize
         * @returns {Uint8Array | null} the client image
         */
        glGetTextureImage(name, level, format, type, bufSize){
            if (!enter('glGetTextureImage', [name, level, format, type, bufSize]))
            {
                return null;
            }
            return textures().getTextureSubImage('glGetTextureImage', name, level, null, format,
                type, bufSize, GL.INVALID_OPERATION);
        },

        /**
         * @param {number} name @param {number} level @param {number} bufSize
         * @returns {Uint8Array | null} the blocks
         */
        glGetCompressedTextureImage(name, level, bufSize){
            if (!enter('glGetCompressedTextureImage', [name, level, bufSize]))
            {
                return null;
            }
            return textures().getCompressedTextureSubImage('glGetCompressedTextureImage', name,
                level, null, bufSize, GL.INVALID_OPERATION);
        },

        // --- buffers ---

        /** @param {number} count @returns {number[]} names that are buffers at once */
        glCreateBuffers(count){
            if (!enter('glCreateBuffers', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            const group = kernel.shareGroup();
            const names = group.buffers.reserve(count);
            for (const name of names)
            {
                group.buffers.define(name, createBufferObject(name));
            }
            group.used = names.length > 0 || group.used;
            return names;
        },

        /**
         * A named buffer call: the bound form `call` of the context made on
         * the buffer, its target argument first.
         *
         * @param {string} call  the bound form's name on the context
         * @param {number} name @param {any[]} rest  the bound form's arguments after its target
         * @returns {any}
         */
        namedBuffer(call, name, rest){
            if (!enter('namedBuffer', [call, name, rest]))
            {
                return null;
            }
            if (name === 0 || !kernel.shareGroup().buffers.objects.has(name))
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            return boundBuffer(GL.COPY_WRITE_BUFFER, name, ()=>
                context[call](GL.COPY_WRITE_BUFFER, ...rest));
        },

        /**
         * @param {number} read @param {number} write @param {number} readOffset
         * @param {number} writeOffset @param {number} size
         */
        glCopyNamedBufferSubData(read, write, readOffset, writeOffset, size){
            if (!enter('glCopyNamedBufferSubData', [read, write, readOffset, writeOffset, size]))
            {
                return;
            }
            const objects = kernel.shareGroup().buffers.objects;
            if (read === 0 || write === 0 || !objects.has(read) || !objects.has(write))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            boundBuffer(GL.COPY_READ_BUFFER, read, ()=>boundBuffer(GL.COPY_WRITE_BUFFER, write,
                ()=>context.glCopyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_WRITE_BUFFER,
                    readOffset, writeOffset, size)));
        },

        // --- framebuffers ---

        /**
         * A named framebuffer call: the bound form `call` made with the
         * framebuffer bound to the draw binding (or the read one), with that
         * binding as its target argument where it takes one.
         *
         * @param {string} call  the bound form's name on the context
         * @param {number} name @param {boolean} read  the read binding, not the draw one
         * @param {boolean} targeted  whether the bound form takes a target first
         * @param {any[]} rest  the bound form's arguments after its target
         * @returns {any}
         */
        namedFramebuffer(call, name, read, targeted, rest){
            if (!enter('namedFramebuffer', [call, name, read, targeted, rest]))
            {
                return null;
            }
            if (!framebufferKnown(name))
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            if (call === 'glDrawBuffer' || call === 'glDrawBuffers' || call === 'glReadBuffer'
                || call === 'clearBuffer' || call === 'glClearBufferfi')
            {
                throughList(call);
            }
            return boundFramebuffers(read ? { read: name } : { draw: name }, ()=>(targeted
                ? context[call](read ? GL.READ_FRAMEBUFFER : GL.DRAW_FRAMEBUFFER, ...rest)
                : context[call](...rest)));
        },

        /**
         * glNamedFramebufferTexture and glNamedFramebufferTextureLayer: a
         * level of the texture named, its target the texture's. A cube map
         * attached whole is drawn into its first face: a draw here reaches
         * one layer of a layered attachment, the first, as it does without a
         * geometry shader choosing another.
         *
         * @param {number} name @param {number} attachment @param {number} texture
         * @param {number} level @param {number | null} layer  null: the whole texture
         */
        namedFramebufferTexture(name, attachment, texture, level, layer){
            if (!enter('namedFramebufferTexture', [name, attachment, texture, level, layer]))
            {
                return;
            }
            if (!framebufferKnown(name))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const object = texture === 0 ? null : textureNamed(texture);
            if (texture !== 0 && !object)
            {
                return;
            }
            /** @type {number} */
            let textarget = object?.target === GL.TEXTURE_1D ? GL.TEXTURE_1D : GL.TEXTURE_2D;
            if (object?.target === GL.TEXTURE_CUBE_MAP)
            {
                if (layer === null)
                {
                    diverge('a cube map attached whole is drawn into its first face alone');
                }
                else if (layer < 0 || layer > 5)
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
                textarget = CUBE_FACES[layer ?? 0];
            }
            else if (object && object.target !== GL.TEXTURE_1D && object.target !== GL.TEXTURE_2D)
            {
                // A layer of a 3D texture or an array, as glFramebufferTextureLayer
                // takes it: none is attached here.
                textarget = GL.TEXTURE_3D;
            }
            else if (object && layer !== null)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            boundFramebuffers({ draw: name }, ()=>context.framebufferTexture(GL.DRAW_FRAMEBUFFER,
                attachment, textarget, texture, level));
        },

        /**
         * @param {number} read @param {number} draw
         * @param {number[]} rest  glBlitFramebuffer's ten arguments
         */
        glBlitNamedFramebuffer(read, draw, rest){
            if (!enter('glBlitNamedFramebuffer', [read, draw, rest]))
            {
                return;
            }
            if (!framebufferKnown(read) || !framebufferKnown(draw))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            boundFramebuffers({ read, draw }, ()=>context.glBlitFramebuffer(...rest));
        },

        /**
         * @param {number} name @param {number} target  the binding it would be checked for
         * @returns {number}
         */
        glCheckNamedFramebufferStatus(name, target){
            if (!enter('glCheckNamedFramebufferStatus', [name, target]))
            {
                return 0;
            }
            if (target !== GL.FRAMEBUFFER && target !== GL.DRAW_FRAMEBUFFER
                && target !== GL.READ_FRAMEBUFFER)
            {
                setError(GL.INVALID_ENUM);
                return 0;
            }
            if (!framebufferKnown(name))
            {
                setError(GL.INVALID_OPERATION);
                return 0;
            }
            const read = target === GL.READ_FRAMEBUFFER;
            return boundFramebuffers(read ? { read: name } : { draw: name },
                ()=>context.glCheckFramebufferStatus(read ? GL.READ_FRAMEBUFFER
                    : GL.DRAW_FRAMEBUFFER));
        },

        /**
         * glInvalidateNamedFramebufferData and SubData: the attachments' contents
         * may be dropped. Nothing here drops them: what they hold is one of the
         * undefined contents the call allows, and the checks are made.
         *
         * @param {number} name @param {number} count  the attachments the program says
         * @param {readonly number[]} attachments
         * @param {{ width: number, height: number } | null} box  null: the whole
         */
        glInvalidateNamedFramebuffer(name, count, attachments, box){
            if (!enter('glInvalidateNamedFramebuffer', [name, count, attachments, box]))
            {
                return;
            }
            const fbo = context.framebufferNamed(name);
            if (fbo === undefined)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (count < 0 || (box && (box.width < 0 || box.height < 0)))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const colours = record(GL.MAX_COLOR_ATTACHMENTS)?.values[0] ?? 8;
            for (const attachment of attachments)
            {
                const colour = attachment - GL.COLOR_ATTACHMENT0;
                const known = fbo === null ? DEFAULT_ATTACHMENTS.has(attachment)
                    : (colour >= 0 && colour < 32) || attachment === GL.DEPTH_ATTACHMENT
                        || attachment === GL.STENCIL_ATTACHMENT
                        || attachment === GL.DEPTH_STENCIL_ATTACHMENT;
                if (!known)
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                if (fbo !== null && colour >= colours && colour < 32)
                {
                    setError(GL.INVALID_OPERATION);
                    return;
                }
            }
        },

        // --- renderbuffers ---

        /**
         * A named renderbuffer call: the bound form `call` made with the
         * renderbuffer bound, its target argument GL_RENDERBUFFER.
         *
         * @param {string} call @param {number} name @param {any[]} rest
         * @returns {any}
         */
        namedRenderbuffer(call, name, rest){
            if (!enter('namedRenderbuffer', [call, name, rest]))
            {
                return null;
            }
            if (name === 0 || !kernel.shareGroup().renderbuffers.objects.has(name))
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            const was = record(GL.RENDERBUFFER_BINDING).values[0];
            context.bindRenderbuffer(GL.RENDERBUFFER, name, false);
            try
            {
                return context[call](GL.RENDERBUFFER, ...rest);
            }
            finally
            {
                context.bindRenderbuffer(GL.RENDERBUFFER, was, false);
            }
        },

        // --- samplers ---

        /** @param {number} count @returns {number[]} names that are samplers at once */
        glCreateSamplers(count){
            if (!enter('glCreateSamplers', [count]))
            {
                return [];
            }
            // A sampler here is an object from the name's making.
            return context.glGenSamplers(count);
        },
    });
}

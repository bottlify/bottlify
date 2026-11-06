/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The uniform buffer binding points (OpenGL 3.1 section 2.11.4,
 * GL_ARB_uniform_buffer_object): an indexed binding of a buffer object, or
 * a range of one, that a program's uniform blocks read through the point
 * glUniformBlockBinding gave each of them.
 *
 * The rules, as the specification states them:
 *
 * - **A point holds a buffer and a range**: glBindBufferBase the whole
 *   buffer (start and size answer 0), glBindBufferRange from an offset that
 *   is a multiple of UNIFORM_BUFFER_OFFSET_ALIGNMENT, of a positive size.
 *   Both also bind the buffer to the target's general binding, which
 *   glBindBuffer, glBufferData and the rest address.
 * - **A deleted buffer leaves the points that held it**, in the context that
 *   deleted it; a name made again later is another buffer.
 * - **The points are the context's**, not the share group's, and none of
 *   these calls is compiled into a display list.
 */

import { GL } from './constants.js';
import { createBufferObject } from './objects.js';
import { BLOCK_LIMITS } from './glsl-link.js';

/** UNIFORM_BUFFER_OFFSET_ALIGNMENT: WebGPU's alignment of a uniform binding's offset. */
export const UNIFORM_BUFFER_OFFSET_ALIGNMENT = 256;

/** The calls of this file a display list does not record. */
export const UNIFORM_BUFFER_CALLS_NOT_COMPILED = Object.freeze([
    'glBindBufferBase', 'glBindBufferRange', 'glGetIntegeri_v',
]);

/**
 * @typedef {{ name: number, buffer: import('./objects.js').BufferObject, offset: number,
 *     size: number }} UniformBinding  `size` 0 for a whole buffer (glBindBufferBase)
 */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installUniformBufferCalls(context, kernel){
    const { enter, setError, setState } = kernel;
    /** @type {(UniformBinding | null)[]} */
    const points = new Array(BLOCK_LIMITS.bindings).fill(null);

    /**
     * A point's binding, or null where its buffer has been deleted since.
     *
     * @param {number} index @returns {UniformBinding | null}
     */
    const live = index=>{
        const point = points[index];
        if (point && kernel.shareGroup().buffers.objects.get(point.name) !== point.buffer)
        {
            points[index] = null;
            return null;
        }
        return point;
    };

    /**
     * glBindBufferBase and glBindBufferRange: `size` null for the whole buffer.
     *
     * @param {string} call @param {number} target @param {number} index @param {number} name
     * @param {number} offset @param {number | null} size
     */
    const bind = (call, target, index, name, offset, size)=>{
        if (!enter(call, size === null ? [target, index, name] : [target, index, name, offset,
            size]))
        {
            return;
        }
        if (target !== GL.UNIFORM_BUFFER)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (index < 0 || index >= points.length)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (name !== 0 && size !== null && (size <= 0 || offset < 0
            || offset % UNIFORM_BUFFER_OFFSET_ALIGNMENT !== 0))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const group = kernel.shareGroup();
        let buffer = name === 0 ? undefined : group.buffers.objects.get(name);
        if (name !== 0 && !buffer)
        {
            // A name glBindBuffer would have made an object of, as it does.
            buffer = createBufferObject(name);
            group.buffers.define(name, buffer);
            group.used = true;
        }
        points[index] = buffer ? { name, buffer, offset: size === null ? 0 : offset,
            size: size ?? 0 } : null;
        setState(GL.UNIFORM_BUFFER_BINDING, [name]);
    };

    Object.assign(kernel.side, {
        /**
         * What each point holds for a draw: the buffer, and the range a
         * block reads from (a whole buffer from 0).
         *
         * @returns {({ buffer: import('./objects.js').BufferObject, offset: number,
         *     size: number } | null)[]}
         */
        uniformBuffers: ()=>points.map((unused, index)=>{
            const point = live(index);
            return point ? { buffer: point.buffer, offset: point.offset,
                size: point.size === 0 ? point.buffer.size : point.size } : null;
        }),
    });

    Object.assign(context, {
        /** @param {number} target @param {number} index @param {number} name */
        glBindBufferBase(target, index, name){
            bind('glBindBufferBase', target, index, name, 0, null);
        },

        /**
         * @param {number} target @param {number} index @param {number} name
         * @param {number} offset @param {number} size
         */
        glBindBufferRange(target, index, name, offset, size){
            bind('glBindBufferRange', target, index, name, offset, size);
        },

        /**
         * The indexed queries of the uniform buffer points.
         *
         * @param {number} pname @param {number} index @returns {number[] | null}
         */
        glGetIntegeri_v(pname, index){
            if (!enter('glGetIntegeri_v', [pname, index]))
            {
                return null;
            }
            if (pname !== GL.UNIFORM_BUFFER_BINDING && pname !== GL.UNIFORM_BUFFER_START
                && pname !== GL.UNIFORM_BUFFER_SIZE)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (index < 0 || index >= points.length)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const point = live(index);
            return [pname === GL.UNIFORM_BUFFER_BINDING ? point?.name ?? 0
                : pname === GL.UNIFORM_BUFFER_START ? point?.offset ?? 0 : point?.size ?? 0];
        },
    });
}

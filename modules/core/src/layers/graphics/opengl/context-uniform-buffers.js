/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The indexed buffer binding points (OpenGL 3.0 section 2.15 and 3.1
 * section 2.11.4): glBindBufferBase and glBindBufferRange bind a buffer
 * object, or a range of one, to a numbered point of a target, from which a
 * program's uniform blocks read (UNIFORM_BUFFER, GL_ARB_uniform_buffer_object)
 * and into which transform feedback writes. A target is a row of its own
 * here (`TARGETS`): its number of points, its offset alignment and the
 * queries that answer it; adding one is adding a row.
 *
 * The rules, as the specification states them:
 *
 * - **A point holds a buffer and a range**: glBindBufferBase the whole
 *   buffer (start and size answer 0), glBindBufferRange from an offset that
 *   is a multiple of the target's alignment, of a positive size. Both also
 *   bind the buffer to the target's general binding, which glBindBuffer,
 *   glBufferData and the rest address.
 * - **A deleted buffer leaves the points that held it**, in the context that
 *   deleted it; a name made again later is another buffer.
 * - **The points are the context's**, not the share group's, and neither
 *   call is compiled into a display list.
 *
 * The indexed queries (glGetIntegeri_v and the rest) answer through
 * `kernel.side.indexed`, by the query's enum.
 */

import { GL } from './constants.js';
import { createBufferObject } from './objects.js';
import { BLOCK_LIMITS, FEEDBACK_LIMITS } from './glsl-link.js';
import { COUNTER_LIMITS, STORAGE_BUFFER_OFFSET_ALIGNMENT, STORAGE_LIMITS }
    from './glsl-storage.js';

/** UNIFORM_BUFFER_OFFSET_ALIGNMENT: WebGPU's alignment of a uniform binding's offset. */
export const UNIFORM_BUFFER_OFFSET_ALIGNMENT = 256;

/** The calls of this file a display list does not record. */
export const UNIFORM_BUFFER_CALLS_NOT_COMPILED = Object.freeze([
    'glBindBufferBase', 'glBindBufferRange',
]);

/**
 * The indexed targets: how many points each has, the alignment of a range's
 * offset, the general binding glBindBufferBase sets too, and the indexed
 * queries of a point's buffer, start and size.
 *
 * @type {ReadonlyMap<number, { points: number, alignment: number, general: number,
 *     binding: number, start: number, size: number }>}
 */
const TARGETS = new Map([
    [GL.UNIFORM_BUFFER, { points: BLOCK_LIMITS.bindings, alignment: UNIFORM_BUFFER_OFFSET_ALIGNMENT,
        general: GL.UNIFORM_BUFFER_BINDING, binding: GL.UNIFORM_BUFFER_BINDING,
        start: GL.UNIFORM_BUFFER_START, size: GL.UNIFORM_BUFFER_SIZE }],
    // A range's offset and size are words (OpenGL 3.0 section 2.15).
    [GL.TRANSFORM_FEEDBACK_BUFFER, { points: FEEDBACK_LIMITS.buffers, alignment: 4,
        general: GL.TRANSFORM_FEEDBACK_BUFFER_BINDING,
        binding: GL.TRANSFORM_FEEDBACK_BUFFER_BINDING, start: GL.TRANSFORM_FEEDBACK_BUFFER_START,
        size: GL.TRANSFORM_FEEDBACK_BUFFER_SIZE }],
    [GL.SHADER_STORAGE_BUFFER, { points: STORAGE_LIMITS.bindings,
        alignment: STORAGE_BUFFER_OFFSET_ALIGNMENT, general: GL.SHADER_STORAGE_BUFFER_BINDING,
        binding: GL.SHADER_STORAGE_BUFFER_BINDING, start: GL.SHADER_STORAGE_BUFFER_START,
        size: GL.SHADER_STORAGE_BUFFER_SIZE }],
    // GL holds a counter range's offset to words (4.2 section 6.7.1).
    [GL.ATOMIC_COUNTER_BUFFER, { points: COUNTER_LIMITS.bindings, alignment: 4,
        general: GL.ATOMIC_COUNTER_BUFFER_BINDING, binding: GL.ATOMIC_COUNTER_BUFFER_BINDING,
        start: GL.ATOMIC_COUNTER_BUFFER_START, size: GL.ATOMIC_COUNTER_BUFFER_SIZE }],
]);

/**
 * @typedef {{ name: number, buffer: import('./objects.js').BufferObject, offset: number,
 *     size: number }} BufferBinding  `size` 0 for a whole buffer (glBindBufferBase)
 */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installUniformBufferCalls(context, kernel){
    const { enter, setError, setState } = kernel;
    /** @type {Map<number, (BufferBinding | null)[]>} */
    const tables = new Map([...TARGETS].map(([target, row])=>[target,
        new Array(row.points).fill(null)]));

    /**
     * A point's binding, or null where its buffer has been deleted since.
     *
     * @param {number} target @param {number} index @returns {BufferBinding | null}
     */
    const live = (target, index)=>{
        const points = /** @type {(BufferBinding | null)[]} */ (tables.get(target));
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
        const row = TARGETS.get(target);
        const points = tables.get(target);
        if (!row || !points)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (index < 0 || index >= points.length)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        // What transform feedback writes stays bound while it does.
        if (target === GL.TRANSFORM_FEEDBACK_BUFFER && kernel.side.feedbackActive?.())
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (target === GL.TRANSFORM_FEEDBACK_BUFFER && size !== null && size % 4 !== 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (name !== 0 && size !== null && (size <= 0 || offset < 0
            || offset % row.alignment !== 0))
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
        setState(row.general, [name]);
    };

    // The indexed queries, through the table the context's glGet*i_v reads.
    const indexed = /** @type {Map<number, (index: number) => ({ kind: string,
     *     values: number[] } | null)>} */ (kernel.side.indexed ??= new Map());
    for (const [target, row] of TARGETS)
    {
        /** @param {(point: BufferBinding | null) => number} read */
        const query = read=>(/** @type {number} */ index)=>(index < 0 || index >= row.points
            ? null : { kind: 'int', values: [read(live(target, index))] });
        indexed.set(row.binding, query(point=>point?.name ?? 0));
        indexed.set(row.start, query(point=>point?.offset ?? 0));
        indexed.set(row.size, query(point=>point?.size ?? 0));
    }

    /**
     * @param {number} target
     * @returns {({ buffer: import('./objects.js').BufferObject, offset: number,
     *     size: number } | null)[]}
     */
    const ranges = target=>(tables.get(target) ?? []).map((unused, index)=>{
        const point = live(target, index);
        return point ? { buffer: point.buffer, offset: point.offset,
            size: point.size === 0 ? point.buffer.size - point.offset : point.size } : null;
    });

    Object.assign(kernel.side, {
        /** What each transform feedback point holds: what a capture writes into. */
        feedbackBuffers: ()=>ranges(GL.TRANSFORM_FEEDBACK_BUFFER),
        /** What each shader storage point holds (4.3). */
        storageBuffers: ()=>ranges(GL.SHADER_STORAGE_BUFFER),
        /** What each atomic counter buffer point holds (4.2). */
        counterBuffers: ()=>ranges(GL.ATOMIC_COUNTER_BUFFER),
        /**
         * What each uniform buffer point holds for a draw: the buffer, and
         * the range a block reads from (a whole buffer from 0).
         *
         * @returns {({ buffer: import('./objects.js').BufferObject, offset: number,
         *     size: number } | null)[]}
         */
        uniformBuffers: ()=>(tables.get(GL.UNIFORM_BUFFER) ?? []).map((unused, index)=>{
            const point = live(GL.UNIFORM_BUFFER, index);
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
    });
}

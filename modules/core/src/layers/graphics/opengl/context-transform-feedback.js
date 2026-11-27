/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Transform feedback (OpenGL 3.0 section 2.15; transform feedback objects,
 * pause and resume, GL_ARB_transform_feedback2 and 4.0 section 2.14).
 *
 * - **Begin captures what the program in use names** (glTransformFeedbackVaryings
 *   at its last link, `glsl-link.js` feedbackOf) into the buffers bound to
 *   GL_TRANSFORM_FEEDBACK_BUFFER's points, each written from the start of its
 *   range on, primitive by primitive, whole primitives only: the first that
 *   does not fit any buffer is written to none, nor any after it.
 * - **The device writes them** (`gpu.js`, `gpu-geometry.js` capture): stream
 *   output after the vertex pass or the geometry shader, as Direct3D 11's.
 * - **While active** a draw's mode must make the primitive begin named (the
 *   geometry shader's output where there is one), and the program in use,
 *   the buffers bound and the program's link stay as they are:
 *   GL_INVALID_OPERATION otherwise. Paused, draws capture nothing and the
 *   program may change.
 * - **Objects** (glGenTransformFeedbacks, glBindTransformFeedback) hold
 *   whether capture is active and paused, and the buffers bound to their
 *   points (4.0); object 0 is the default one. The 4.5 calls name an object
 *   instead of binding it.
 * - **A draw of what was captured** (glDrawTransformFeedback, 4.0) draws as
 *   many vertices as the object's last capture wrote into its first buffer:
 *   a number only the device knows, so the device counts it
 *   (`gpu-geometry.js` capturedArgs), up to the most the capture's draws
 *   could have written, which is what the draw is laid out for here.
 */

import { GL } from './constants.js';

/** The calls of this file a display list does not record. */
export const FEEDBACK_CALLS_NOT_COMPILED = Object.freeze([
    'glBeginTransformFeedback', 'glEndTransformFeedback', 'glPauseTransformFeedback',
    'glResumeTransformFeedback', 'glGenTransformFeedbacks', 'glDeleteTransformFeedbacks',
    'glIsTransformFeedback', 'glBindTransformFeedback', 'glTransformFeedbackVaryings',
    'glGetTransformFeedbackVarying', 'glCreateTransformFeedbacks',
    'glTransformFeedbackBufferBase', 'glTransformFeedbackBufferRange',
    'glGetTransformFeedbackiv', 'glGetTransformFeedbacki_v', 'glGetTransformFeedbacki64_v',
]);

/** MAX_VERTEX_STREAMS (4.0): the streams a capture names; only stream 0 is ever written. */
const VERTEX_STREAMS = 4;

/**
 * The modes each primitive glBeginTransformFeedback names takes (table 2.10 of 3.0).
 *
 * @type {Map<number, number[]>}
 */
const FEEDBACK_MODES = new Map([
    [GL.POINTS, [GL.POINTS]],
    [GL.LINES, [GL.LINES, GL.LINE_LOOP, GL.LINE_STRIP]],
    [GL.TRIANGLES, [GL.TRIANGLES, GL.TRIANGLE_STRIP, GL.TRIANGLE_FAN]],
]);

/** What a geometry shader's output primitive is captured as. */
const GEOMETRY_CAPTURED = Object.freeze(/** @type {Record<string, number>} */ ({
    points: GL.POINTS, line_strip: GL.LINES, triangle_strip: GL.TRIANGLES,
}));

/**
 * A transform feedback object.
 *
 * @typedef {Object} FeedbackObject
 * @property {number} name
 * @property {boolean} bound  ever bound, which is what makes the name an object
 * @property {boolean} active
 * @property {boolean} paused
 * @property {number} primitive  what glBeginTransformFeedback named
 * @property {FeedbackSession | null} session  what its capture writes, while active
 * @property {any[]} points  its transform feedback buffer points
 * @property {Captured | null} captured  what its last capture wrote, once one has ended
 * @property {boolean} ended  a capture has ended while it was bound
 */

/**
 * What a capture that ended wrote, for a draw of it: the vertices in the
 * first buffer from `offset` on, `stride` bytes each, at most `most`.
 *
 * @typedef {Object} Captured
 * @property {import('./objects.js').BufferObject} buffer
 * @property {number} offset @property {number} stride @property {number} most
 */

/**
 * What a capture writes: the program's captured values into these buffers,
 * each from the start of the range bound (`gpu.js` begins it).
 *
 * @typedef {Object} FeedbackSession
 * @property {number} primitive  GL_POINTS, GL_LINES or GL_TRIANGLES
 * @property {import('./glsl-link.js').Feedback} feedback
 * @property {({ buffer: import('./objects.js').BufferObject, offset: number,
 *     size: number } | null)[]} buffers  `size` the range's bytes, the whole
 *     buffer's past the offset for glBindBufferBase
 * @property {number} most  the vertices its draws may have captured, as the
 *     renderer counts them (Infinity where it cannot)
 */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installTransformFeedbackCalls(context, kernel){
    const { enter, setError, setState, diverge } = kernel;
    /** The points every object's are made by: the uniform buffer calls own the targets. */
    const pointsOf = ()=>kernel.side.feedbackPoints;
    /** @type {FeedbackObject} */
    const fallback = { name: 0, bound: true, active: false, paused: false, primitive: 0,
        session: null, points: pointsOf()?.current() ?? [], captured: null, ended: false };
    /**
     * A new object: a name generated and now bound, or made by glCreate.
     *
     * @param {number} name @returns {FeedbackObject}
     */
    const made = name=>({ name, bound: true, active: false, paused: false, primitive: 0,
        session: null, points: pointsOf()?.make() ?? [], captured: null, ended: false });
    /** @type {Map<number, FeedbackObject | null>} names, null until first bound */
    const objects = new Map([[0, fallback]]);
    let current = fallback;

    const publish = ()=>{
        setState(GL.TRANSFORM_FEEDBACK_BINDING, [current.name]);
        setState(GL.TRANSFORM_FEEDBACK_ACTIVE, [current.active ? 1 : 0]);
        setState(GL.TRANSFORM_FEEDBACK_PAUSED, [current.paused ? 1 : 0]);
    };

    Object.assign(kernel.side, {
        /** Whether capture is active and not paused: what fixes the program and buffers. */
        feedbackActive: ()=>current.active && !current.paused,
        /** What a draw captures into now, or null. */
        feedbackSession: ()=>(current.active && !current.paused ? current.session : null),
        /**
         * Whether a draw's mode makes the primitive capture takes (the
         * geometry shader's output where the program has one).
         *
         * @param {number} mode
         * @param {import('./glsl-link.js').GeometryLayout | null} geometry
         */
        feedbackTakes: (mode, geometry)=>{
            if (!current.active || current.paused)
            {
                return true;
            }
            return geometry ? GEOMETRY_CAPTURED[geometry.output] === current.primitive
                : (FEEDBACK_MODES.get(current.primitive) ?? []).includes(mode);
        },
    });

    Object.assign(context, {
        /** @param {number} primitive */
        glBeginTransformFeedback(primitive){
            if (!enter('glBeginTransformFeedback', [primitive]))
            {
                return;
            }
            if (!FEEDBACK_MODES.has(primitive))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const executable = kernel.side.glslExecutable?.() ?? null;
            /** @type {import('./glsl-link.js').Feedback | null} */
            const feedback = executable?.linked.feedback ?? null;
            const points = kernel.side.feedbackBuffers?.() ?? [];
            // Every buffer something is captured into is bound (4.4's xfb
            // qualifiers may leave one between them unused).
            if (current.active || !feedback
                || feedback.strides.some((words, slot)=>words > 0 && !points[slot]))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            current.active = true;
            current.paused = false;
            current.primitive = primitive;
            current.session = { primitive, feedback,
                buffers: points.slice(0, feedback.strides.length), most: 0 };
            for (const bound of current.session.buffers)
            {
                if (bound)
                {
                    bound.buffer.captured = true;
                }
            }
            if (kernel.feedback)
            {
                kernel.feedback.begin(current.session);
            }
            else
            {
                diverge('transform feedback began where nothing draws on a device: nothing'
                    + ' is captured');
            }
            publish();
        },

        glEndTransformFeedback(){
            if (!enter('glEndTransformFeedback', []))
            {
                return;
            }
            if (!current.active)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const session = /** @type {FeedbackSession} */ (current.session);
            const first = session.buffers[0];
            const stride = session.feedback.strides[0] * 4;
            current.captured = first && stride > 0 ? { buffer: first.buffer,
                offset: first.offset, stride,
                most: Math.min(Math.floor(first.size / stride), session.most) } : null;
            current.ended = true;
            current.active = false;
            current.paused = false;
            current.session = null;
            publish();
        },

        glPauseTransformFeedback(){
            if (!enter('glPauseTransformFeedback', []))
            {
                return;
            }
            if (!current.active || current.paused)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            current.paused = true;
            publish();
        },

        glResumeTransformFeedback(){
            if (!enter('glResumeTransformFeedback', []))
            {
                return;
            }
            if (!current.active || !current.paused)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            current.paused = false;
            publish();
        },

        /** @param {number} count @returns {number[]} */
        glGenTransformFeedbacks(count){
            if (!enter('glGenTransformFeedbacks', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            /** @type {number[]} */
            const names = [];
            for (let name = 1; names.length < count; name++)
            {
                if (!objects.has(name))
                {
                    objects.set(name, null);
                    names.push(name);
                }
            }
            return names;
        },

        /** @param {readonly number[]} names */
        glDeleteTransformFeedbacks(names){
            if (!enter('glDeleteTransformFeedbacks', [names]))
            {
                return;
            }
            if (names.some(name=>objects.get(name)?.active))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            for (const name of names)
            {
                if (name === 0)
                {
                    continue;
                }
                if (current.name === name)
                {
                    current = fallback;
                    pointsOf()?.use(fallback.points);
                }
                objects.delete(name);
            }
            publish();
        },

        /** @param {number} name @returns {number} */
        glIsTransformFeedback(name){
            if (!enter('glIsTransformFeedback', [name]))
            {
                return GL.FALSE;
            }
            return name !== 0 && objects.get(name) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} target @param {number} name */
        glBindTransformFeedback(target, name){
            if (!enter('glBindTransformFeedback', [target, name]))
            {
                return;
            }
            if (target !== GL.TRANSFORM_FEEDBACK)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!objects.has(name) || (current.active && !current.paused))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            let object = objects.get(name);
            if (!object)
            {
                object = made(name);
                objects.set(name, object);
            }
            current = object;
            pointsOf()?.use(current.points);
            publish();
        },

        // --- objects named rather than bound (4.5) ---

        /** @param {number} count @returns {number[]} */
        glCreateTransformFeedbacks(count){
            if (!enter('glCreateTransformFeedbacks', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            /** @type {number[]} */
            const names = [];
            for (let name = 1; names.length < count; name++)
            {
                if (!objects.has(name))
                {
                    objects.set(name, made(name));
                    names.push(name);
                }
            }
            return names;
        },

        /**
         * glTransformFeedbackBufferBase (`size` null) and Range.
         *
         * @param {number} name @param {number} index @param {number} buffer
         * @param {number} offset @param {number | null} size
         */
        transformFeedbackBuffer(name, index, buffer, offset, size){
            const call = size === null ? 'glTransformFeedbackBufferBase'
                : 'glTransformFeedbackBufferRange';
            if (!enter(call, size === null ? [name, index, buffer]
                : [name, index, buffer, offset, size]))
            {
                return;
            }
            const object = objects.get(name);
            if (!object || object.active)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            pointsOf()?.put(object.points, index, buffer, offset, size);
        },

        /**
         * glGetTransformFeedbackiv: whether the object captures, and is paused.
         *
         * @param {number} name @param {number} pname @returns {number[] | null}
         */
        glGetTransformFeedbackiv(name, pname){
            if (!enter('glGetTransformFeedbackiv', [name, pname]))
            {
                return null;
            }
            const object = objects.get(name);
            if (!object)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            if (pname === GL.TRANSFORM_FEEDBACK_ACTIVE)
            {
                return [object.active ? 1 : 0];
            }
            if (pname === GL.TRANSFORM_FEEDBACK_PAUSED)
            {
                return [object.paused ? 1 : 0];
            }
            setError(GL.INVALID_ENUM);
            return null;
        },

        /**
         * glGetTransformFeedbacki_v (the buffer at a point) and _i64_v (its
         * range's start and size).
         *
         * @param {number} name @param {number} pname @param {number} index
         * @param {boolean} wide  the 64-bit form
         * @returns {number[] | null}
         */
        transformFeedbackIndexed(name, pname, index, wide){
            if (!enter(wide ? 'glGetTransformFeedbacki64_v' : 'glGetTransformFeedbacki_v',
                [name, pname, index]))
            {
                return null;
            }
            const object = objects.get(name);
            if (!object)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            /** @type {number[]} */
            const asked = wide ? [GL.TRANSFORM_FEEDBACK_BUFFER_START,
                GL.TRANSFORM_FEEDBACK_BUFFER_SIZE] : [GL.TRANSFORM_FEEDBACK_BUFFER_BINDING];
            if (!asked.includes(pname))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (index < 0 || index >= object.points.length)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const point = pointsOf()?.read(object.points, index) ?? null;
            return [pname === GL.TRANSFORM_FEEDBACK_BUFFER_BINDING ? point?.name ?? 0
                : pname === GL.TRANSFORM_FEEDBACK_BUFFER_START ? point?.offset ?? 0
                    : point?.size ?? 0];
        },
    });

    Object.assign(kernel.side, {
        /**
         * What a draw of a capture draws (glDrawTransformFeedback): the
         * object's last capture of `stream`, or the error why it cannot.
         *
         * @param {number} name @param {number} stream
         * @returns {{ captured: Captured | null } | { error: number }}
         */
        feedbackCaptured: (name, stream)=>{
            const object = objects.get(name);
            if (!object || stream < 0 || stream >= VERTEX_STREAMS)
            {
                return { error: GL.INVALID_VALUE };
            }
            if (!object.ended)
            {
                return { error: GL.INVALID_OPERATION };
            }
            // Only stream 0 is ever captured into.
            return { captured: stream === 0 ? object.captured : null };
        },
    });
}

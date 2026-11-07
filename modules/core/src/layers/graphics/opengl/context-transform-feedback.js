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
 *   whether capture is active and paused; object 0 is the default one.
 */

import { GL } from './constants.js';

/** The calls of this file a display list does not record. */
export const FEEDBACK_CALLS_NOT_COMPILED = Object.freeze([
    'glBeginTransformFeedback', 'glEndTransformFeedback', 'glPauseTransformFeedback',
    'glResumeTransformFeedback', 'glGenTransformFeedbacks', 'glDeleteTransformFeedbacks',
    'glIsTransformFeedback', 'glBindTransformFeedback', 'glTransformFeedbackVaryings',
    'glGetTransformFeedbackVarying',
]);

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
 */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installTransformFeedbackCalls(context, kernel){
    const { enter, setError, setState, diverge } = kernel;
    /** @type {FeedbackObject} */
    const fallback = { name: 0, bound: true, active: false, paused: false, primitive: 0,
        session: null };
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
            if (current.active || !feedback
                || feedback.strides.some((_, slot)=>!points[slot]))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            current.active = true;
            current.paused = false;
            current.primitive = primitive;
            current.session = { primitive, feedback,
                buffers: points.slice(0, feedback.strides.length) };
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
                object = { name, bound: true, active: false, paused: false, primitive: 0,
                    session: null };
                objects.set(name, object);
            }
            current = object;
            publish();
        },
    });
}

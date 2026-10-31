/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The state calls OpenGL 1.2 to 2.1 added to the core, beyond what the
 * extensions this layer already had brought (those are answered under
 * their core names too, in `exports.js`): separate blending and its
 * equations and constant colour, separate stencil faces, several draw
 * buffers, point parameters, sample coverage, transposed matrices, window
 * raster positions, occlusion queries, and the 3D texture calls.
 *
 * What is accepted and not drawn is said so through the divergence report:
 * point sprites and sizes (WebGPU draws one-pixel points), sample coverage
 * (one sample), 3D textures (none are sampled), and the occlusion queries,
 * whose count is the viewport's area rather than what passed.
 */

import { GL } from './constants.js';
import { transpose } from './matrix.js';

/**
 * The blend factors OpenGL 1.4 takes, constant colours among them.
 *
 * @type {Set<number>}
 */
export const BLEND_FACTORS = new Set([
    GL.ZERO, GL.ONE, GL.SRC_COLOR, GL.ONE_MINUS_SRC_COLOR, GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA,
    GL.DST_ALPHA, GL.ONE_MINUS_DST_ALPHA, GL.DST_COLOR, GL.ONE_MINUS_DST_COLOR,
    GL.SRC_ALPHA_SATURATE, GL.CONSTANT_COLOR, GL.ONE_MINUS_CONSTANT_COLOR, GL.CONSTANT_ALPHA,
    GL.ONE_MINUS_CONSTANT_ALPHA,
]);

/** @type {Set<number>} */
const COMPARE_FUNCTIONS = new Set([
    GL.NEVER, GL.LESS, GL.EQUAL, GL.LEQUAL, GL.GREATER, GL.NOTEQUAL, GL.GEQUAL, GL.ALWAYS,
]);

/** The blend equations. @type {Set<number>} */
const EQUATIONS = new Set([GL.FUNC_ADD, GL.FUNC_SUBTRACT, GL.FUNC_REVERSE_SUBTRACT, GL.MIN,
    GL.MAX]);

/** @type {Set<number>} */
const STENCIL_OPS = new Set([
    GL.KEEP, GL.ZERO, GL.REPLACE, GL.INCR, GL.DECR, GL.INVERT, GL.INCR_WRAP, GL.DECR_WRAP,
]);

/**
 * @typedef {{ func: number, ref: number, mask: number, fail: number, zfail: number,
 *     zpass: number, write: number }} StencilQueries
 */

/** What each face's stencil queries are. @type {StencilQueries} */
const FRONT = { func: GL.STENCIL_FUNC, ref: GL.STENCIL_REF, mask: GL.STENCIL_VALUE_MASK,
    fail: GL.STENCIL_FAIL, zfail: GL.STENCIL_PASS_DEPTH_FAIL, zpass: GL.STENCIL_PASS_DEPTH_PASS,
    write: GL.STENCIL_WRITEMASK };
/** @type {StencilQueries} */
const BACK = { func: GL.STENCIL_BACK_FUNC, ref: GL.STENCIL_BACK_REF,
    mask: GL.STENCIL_BACK_VALUE_MASK, fail: GL.STENCIL_BACK_FAIL,
    zfail: GL.STENCIL_BACK_PASS_DEPTH_FAIL, zpass: GL.STENCIL_BACK_PASS_DEPTH_PASS,
    write: GL.STENCIL_BACK_WRITEMASK };

/** The buffers glDrawBuffers takes for the window. @type {Set<number>} */
const WINDOW_BUFFERS = new Set([GL.NONE, GL.FRONT_LEFT, GL.FRONT_RIGHT, GL.BACK_LEFT,
    GL.BACK_RIGHT, GL.AUX0]);

/**
 * The calls of this file a display list does not record: the query objects'.
 */
export const CORE_CALLS_NOT_COMPILED = Object.freeze([
    'glGenQueries', 'glDeleteQueries', 'glIsQuery', 'glGetQueryiv', 'glGetQueryObject',
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installCoreCalls(context, kernel){
    const { enter, setError, setState, record, diverge } = kernel;

    /** @param {number} face @returns {StencilQueries[] | null} */
    const facesOf = face=>(face === GL.FRONT ? [FRONT] : face === GL.BACK ? [BACK]
        : face === GL.FRONT_AND_BACK ? [FRONT, BACK] : null);

    /** The query objects: names, and the one active. */
    /** @type {Map<number, { result: number } | null>} */
    const queries = new Map();
    /** @type {{ name: number } | null} */
    let activeQuery = null;

    /** @param {number} value */
    const clamp01 = value=>(value < 0 ? 0 : value > 1 ? 1 : value);

    /**
     * The back face set by OpenGL 2.0's calls is the one every draw reads,
     * whatever GL_EXT_stencil_two_side's enable says.
     *
     * @param {StencilQueries[]} faces
     */
    const backIsCore = faces=>{
        if (faces.includes(BACK))
        {
            kernel.side.stencilBackFromSelector = false;
        }
    };

    Object.assign(context, {
        // --- blending ---

        /** @param {number} r @param {number} g @param {number} b @param {number} a */
        glBlendColor(r, g, b, a){
            if (enter('glBlendColor', [r, g, b, a]))
            {
                setState(GL.BLEND_COLOR, [r, g, b, a].map(clamp01));
            }
        },

        /** @param {number} mode */
        glBlendEquation(mode){
            context.glBlendEquationSeparate(mode, mode);
        },

        /** @param {number} rgb @param {number} alpha */
        glBlendEquationSeparate(rgb, alpha){
            if (!enter('glBlendEquationSeparate', [rgb, alpha]))
            {
                return;
            }
            if (!EQUATIONS.has(rgb) || !EQUATIONS.has(alpha))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.BLEND_EQUATION_RGB, [rgb]);
            setState(GL.BLEND_EQUATION_ALPHA, [alpha]);
        },

        /**
         * @param {number} srcRgb @param {number} dstRgb @param {number} srcAlpha
         * @param {number} dstAlpha
         */
        glBlendFuncSeparate(srcRgb, dstRgb, srcAlpha, dstAlpha){
            if (!enter('glBlendFuncSeparate', [srcRgb, dstRgb, srcAlpha, dstAlpha]))
            {
                return;
            }
            if (![srcRgb, dstRgb, srcAlpha, dstAlpha].every(f=>BLEND_FACTORS.has(f))
                || dstRgb === GL.SRC_ALPHA_SATURATE || dstAlpha === GL.SRC_ALPHA_SATURATE)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.BLEND_SRC, [srcRgb]);
            setState(GL.BLEND_DST, [dstRgb]);
            setState(GL.BLEND_SRC_RGB, [srcRgb]);
            setState(GL.BLEND_DST_RGB, [dstRgb]);
            setState(GL.BLEND_SRC_ALPHA, [srcAlpha]);
            setState(GL.BLEND_DST_ALPHA, [dstAlpha]);
        },

        // --- stencil, face by face ---

        /** @param {number} face @param {number} func @param {number} ref @param {number} mask */
        glStencilFuncSeparate(face, func, ref, mask){
            if (!enter('glStencilFuncSeparate', [face, func, ref, mask]))
            {
                return;
            }
            const faces = facesOf(face);
            if (!faces || !COMPARE_FUNCTIONS.has(func))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            for (const q of faces)
            {
                setState(q.func, [func]);
                setState(q.ref, [ref | 0]);
                setState(q.mask, [mask >>> 0]);
            }
            backIsCore(faces);
        },

        /**
         * @param {number} face @param {number} fail @param {number} zfail
         * @param {number} zpass
         */
        glStencilOpSeparate(face, fail, zfail, zpass){
            if (!enter('glStencilOpSeparate', [face, fail, zfail, zpass]))
            {
                return;
            }
            const faces = facesOf(face);
            if (!faces || ![fail, zfail, zpass].every(op=>STENCIL_OPS.has(op)))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            for (const q of faces)
            {
                setState(q.fail, [fail]);
                setState(q.zfail, [zfail]);
                setState(q.zpass, [zpass]);
            }
            backIsCore(faces);
        },

        /** @param {number} face @param {number} mask */
        glStencilMaskSeparate(face, mask){
            if (!enter('glStencilMaskSeparate', [face, mask]))
            {
                return;
            }
            const faces = facesOf(face);
            if (!faces)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            for (const q of faces)
            {
                setState(q.write, [mask >>> 0]);
            }
            backIsCore(faces);
        },

        // --- draw buffers ---

        /** @param {readonly number[]} buffers */
        glDrawBuffers(buffers){
            if (!enter('glDrawBuffers', [buffers]))
            {
                return;
            }
            if (buffers.length < 0 || buffers.length > record(GL.MAX_DRAW_BUFFERS).values[0])
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!kernel.side.drawTarget?.())
            {
                // The window's buffers, each one buffer (table 4.5 of the 2.1
                // specification has no FRONT or BACK) and none twice.
                if (buffers.some(b=>!WINDOW_BUFFERS.has(b)))
                {
                    setError(GL.INVALID_ENUM);
                    return;
                }
                const double = record(GL.DOUBLEBUFFER).values[0] !== 0;
                if (buffers.some((b, k)=>(b !== GL.NONE && buffers.indexOf(b) !== k)
                    || b === GL.AUX0 || b === GL.FRONT_RIGHT || b === GL.BACK_RIGHT
                    || (b === GL.BACK_LEFT && !double)))
                {
                    setError(GL.INVALID_OPERATION);
                    return;
                }
            }
            kernel.side.setDrawBuffers?.([...buffers]);
        },

        // --- points and samples ---

        /** @param {number} pname @param {readonly number[]} values */
        glPointParameterfv(pname, values){
            if (!enter('glPointParameterfv', [pname, values]))
            {
                return;
            }
            switch (pname)
            {
                case GL.POINT_SIZE_MIN:
                case GL.POINT_SIZE_MAX:
                case GL.POINT_FADE_THRESHOLD_SIZE:
                    if (!(values[0] >= 0))
                    {
                        setError(GL.INVALID_VALUE);
                        return;
                    }
                    setState(pname, [values[0]]);
                    return;
                case GL.POINT_DISTANCE_ATTENUATION:
                    setState(pname, [values[0], values[1], values[2]]);
                    return;
                case GL.POINT_SPRITE_COORD_ORIGIN:
                    if (values[0] !== GL.LOWER_LEFT && values[0] !== GL.UPPER_LEFT)
                    {
                        setError(GL.INVALID_ENUM);
                        return;
                    }
                    setState(pname, [values[0]]);
                    return;
                default:
                    setError(GL.INVALID_ENUM);
            }
        },

        /** @param {number} value @param {number} invert */
        glSampleCoverage(value, invert){
            if (enter('glSampleCoverage', [value, invert]))
            {
                setState(GL.SAMPLE_COVERAGE_VALUE, [clamp01(value)]);
                setState(GL.SAMPLE_COVERAGE_INVERT, [invert ? 1 : 0]);
            }
        },

        // --- transposed matrices ---

        /** @param {ArrayLike<number>} m  row by row */
        glLoadTransposeMatrixf(m){
            context.glLoadMatrixf(transpose(m));
        },

        /** @param {ArrayLike<number>} m */
        glMultTransposeMatrixf(m){
            context.glMultMatrixf(transpose(m));
        },

        // --- the raster position in window coordinates ---

        /** @param {number} x @param {number} y @param {number} z */
        glWindowPos3f(x, y, z){
            if (!enter('glWindowPos3f', [x, y, z]))
            {
                return;
            }
            const [near, far] = record(GL.DEPTH_RANGE).values;
            const current = kernel.currentAttributes();
            setState(GL.CURRENT_RASTER_POSITION, [x, y, near + clamp01(z) * (far - near), 1]);
            setState(GL.CURRENT_RASTER_POSITION_VALID, [1]);
            setState(GL.CURRENT_RASTER_COLOR, [...current.color]);
            setState(GL.CURRENT_RASTER_TEXTURE_COORDS, [...current.texCoords[0]]);
            setState(GL.CURRENT_RASTER_DISTANCE, [current.fogCoord]);
        },

        // --- occlusion queries ---

        /** @param {number} count @returns {number[]} */
        glGenQueries(count){
            if (!enter('glGenQueries', [count]))
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
                if (!queries.has(name))
                {
                    queries.set(name, null);
                    names.push(name);
                }
            }
            return names;
        },

        /** @param {readonly number[]} names */
        glDeleteQueries(names){
            if (!enter('glDeleteQueries', [names]))
            {
                return;
            }
            for (const name of names)
            {
                if (activeQuery?.name === name)
                {
                    activeQuery = null;
                }
                queries.delete(name);
            }
        },

        /** @param {number} name @returns {number} */
        glIsQuery(name){
            if (!enter('glIsQuery', [name]))
            {
                return GL.FALSE;
            }
            return queries.get(name) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} target @param {number} name */
        glBeginQuery(target, name){
            if (!enter('glBeginQuery', [target, name]))
            {
                return;
            }
            if (target !== GL.SAMPLES_PASSED)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (name === 0 || activeQuery)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            activeQuery = { name };
            queries.set(name, { result: 0 });
        },

        /** @param {number} target */
        glEndQuery(target){
            if (!enter('glEndQuery', [target]))
            {
                return;
            }
            if (target !== GL.SAMPLES_PASSED)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!activeQuery)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            diverge('an occlusion query was answered with the viewport\'s area, not the samples'
                + ' that passed: a program culling by it draws everything');
            const [, , width, height] = record(GL.VIEWPORT).values;
            queries.set(activeQuery.name, { result: Math.max(1, width * height) });
            activeQuery = null;
        },

        /** @param {number} target @param {number} pname @returns {number[] | null} */
        glGetQueryiv(target, pname){
            if (!enter('glGetQueryiv', [target, pname]))
            {
                return null;
            }
            if (target !== GL.SAMPLES_PASSED)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (pname === GL.QUERY_COUNTER_BITS)
            {
                return [32];
            }
            if (pname === GL.CURRENT_QUERY)
            {
                return [activeQuery?.name ?? 0];
            }
            setError(GL.INVALID_ENUM);
            return null;
        },

        /** @param {number} name @param {number} pname @returns {number[] | null} */
        glGetQueryObject(name, pname){
            if (!enter('glGetQueryObject', [name, pname]))
            {
                return null;
            }
            const query = queries.get(name);
            if (!query || activeQuery?.name === name)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            if (pname === GL.QUERY_RESULT_AVAILABLE)
            {
                return [1];
            }
            if (pname === GL.QUERY_RESULT)
            {
                return [query.result];
            }
            setError(GL.INVALID_ENUM);
            return null;
        },

        // --- 3D textures ---

        /**
         * glTexImage3D and glTexSubImage3D, by their target and size alone:
         * GL_MAX_3D_TEXTURE_SIZE is the specification's minimum of 16, and
         * what fits is accepted and not kept.
         *
         * @param {string} call @param {number} target @param {number} level
         * @param {number} width @param {number} height @param {number} depth
         */
        texImage3D(call, target, level, width, height, depth){
            if (!enter('texImage3D', [call, target, level, width, height, depth]))
            {
                return;
            }
            if (target !== GL.TEXTURE_3D && target !== GL.PROXY_TEXTURE_3D)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const max = record(GL.MAX_3D_TEXTURE_SIZE).values[0];
            if (level < 0 || width < 0 || height < 0 || depth < 0 || width > max || height > max
                || depth > max)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (target === GL.TEXTURE_3D)
            {
                diverge(`${call} was accepted and kept nothing: there are no 3D textures here`);
            }
        },
    });
}

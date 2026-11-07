/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * State with an index (OpenGL 3.0 sections 4.1.8, 4.2.2, 6.1.1) and the clears
 * of one buffer (section 4.2.3).
 *
 * - **Blending and the colour mask are per draw buffer.** glEnablei, glDisablei
 *   and glColorMaski set one buffer's, and glBlendFunci, glBlendEquationi and
 *   their separate forms (4.0) its factors and equations; glEnable(GL_BLEND),
 *   glColorMask, glBlendFunc and glBlendEquation set every buffer's, and the
 *   unindexed queries answer the first's. A scene
 *   whose buffers all agree carries nothing more, so a program that never
 *   indexes draws as before.
 * - **An indexed query names its target and an index** (glGetIntegeri_v,
 *   glGetBooleani_v, glGetInteger64i_v): each installer that keeps indexed
 *   state registers its targets in `kernel.side.indexed`, an index past the
 *   target's count being GL_INVALID_VALUE and an unknown target
 *   GL_INVALID_ENUM. GL_COLOR_WRITEMASK and GL_BLEND are this file's.
 * - **glClearBuffer clears one buffer**: a colour draw buffer, under its own
 *   mask, or the depth and stencil buffers, under theirs, within the scissor
 *   box, with the value given rather than the clear values.
 */

import { GL } from './constants.js';
import { BLEND_FACTORS, EQUATIONS } from './context-core.js';
import { GLSL_LIMITS } from './glsl-builtins.js';

/** The draw buffers indexed state covers. */
const BUFFERS = GLSL_LIMITS.drawBuffers;

/** The calls of this file a display list does not record: the queries. */
export const INDEXED_CALLS_NOT_COMPILED = Object.freeze([
    'glGetIntegeri_v', 'glGetBooleani_v', 'glGetInteger64i_v', 'glGetInteger64v',
    'glIsEnabledi',
]);

/**
 * @typedef {(index: number) => { kind: 'int' | 'bool' | 'int64', values: number[] } | null}
 *     IndexedQuery
 */

/** @typedef {import('./pipeline.js').PerBuffer} PerBuffer */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installIndexedCalls(context, kernel){
    const { enter, setError, setState, record } = kernel;

    /** Each draw buffer's blending, the first mirrored in GL_BLEND. */
    const blend = new Array(BUFFERS).fill(false);
    /** Each draw buffer's colour mask as four flags, the first mirrored in GL_COLOR_WRITEMASK. */
    const masks = Array.from({ length: BUFFERS }, ()=>[1, 1, 1, 1]);
    /**
     * Each draw buffer's factors (source and destination colour, then
     * alpha) and equations (colour, alpha) where glBlendFunci or
     * glBlendEquationi set them apart; null where it follows the unindexed
     * state, which is the first buffer's.
     *
     * @type {{ factors: number[] | null, equations: number[] | null }[]}
     */
    const apart = Array.from({ length: BUFFERS }, ()=>({ factors: null, equations: null }));
    /** @returns {number[]} the unindexed factors */
    const factorsNow = ()=>[GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA,
        GL.BLEND_DST_ALPHA].map(q=>record(q).values[0]);
    /** @returns {number[]} the unindexed equations */
    const equationsNow = ()=>[GL.BLEND_EQUATION_RGB, GL.BLEND_EQUATION_ALPHA]
        .map(q=>record(q).values[0]);
    /** @param {number} index @returns {{ factors: number[], equations: number[] }} */
    const functionsOf = index=>({ factors: apart[index].factors ?? factorsNow(),
        equations: apart[index].equations ?? equationsNow() });

    /**
     * Every installer's indexed targets, whichever installs first.
     *
     * @type {Map<number, IndexedQuery>}
     */
    const indexed = kernel.side.indexed ??= new Map();
    indexed.set(GL.BLEND, index=>(index < BUFFERS
        ? { kind: 'bool', values: [blend[index] ? 1 : 0] } : null));
    indexed.set(GL.COLOR_WRITEMASK, index=>(index < BUFFERS
        ? { kind: 'bool', values: masks[index] } : null));
    [GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA]
        .forEach((query, k)=>indexed.set(query, index=>(index < BUFFERS
            ? { kind: 'int', values: [functionsOf(index).factors[k]] } : null)));
    [GL.BLEND_EQUATION_RGB, GL.BLEND_EQUATION_ALPHA]
        .forEach((query, k)=>indexed.set(query, index=>(index < BUFFERS
            ? { kind: 'int', values: [functionsOf(index).equations[k]] } : null)));

    /**
     * The first buffer's from the unindexed state, which is its own: what
     * glPopAttrib put back reaches it there.
     */
    const settle = ()=>{
        blend[0] = record(GL.BLEND).values[0] !== 0;
        masks[0].splice(0, 4, ...record(GL.COLOR_WRITEMASK).values);
    };

    /** @param {number[]} mask */
    const bits = mask=>(mask[0] ? 1 : 0) | (mask[1] ? 2 : 0) | (mask[2] ? 4 : 0)
        | (mask[3] ? 8 : 0);

    Object.assign(kernel.side, {
        /**
         * glEnable, glDisable and glColorMask set every buffer's: told after
         * the unindexed state has taken the value.
         *
         * @param {number} cap @param {number[]} values
         */
        allBuffers(cap, values){
            if (cap === GL.BLEND)
            {
                blend.fill(values[0] !== 0);
            }
            else if (cap === GL.COLOR_WRITEMASK)
            {
                for (const mask of masks)
                {
                    mask.splice(0, 4, ...values);
                }
            }
            else if (cap === GL.BLEND_SRC_RGB)
            {
                apart.forEach(one=>{
                    one.factors = null;
                });
            }
            else if (cap === GL.BLEND_EQUATION_RGB)
            {
                apart.forEach(one=>{
                    one.equations = null;
                });
            }
        },
        /** @returns {PerBuffer} */
        perBuffer(){
            settle();
            const first = bits(masks[0]);
            const functions = apart.some(one=>one.factors || one.equations);
            if (blend.every(on=>on === blend[0]) && masks.every(mask=>bits(mask) === first)
                && !functions)
            {
                return null;
            }
            const kept = { blend: [...blend], masks: masks.map(bits) };
            return !functions ? kept : { ...kept, functions: apart.map((_, index)=>{
                const { factors: [src, dst, srcAlpha, dstAlpha],
                    equations: [equation, equationAlpha] } = functionsOf(index);
                return { src, dst, srcAlpha, dstAlpha, equation, equationAlpha };
            }) };
        },
    });

    /** @param {number} index @returns {boolean} whether it is a draw buffer's */
    const bufferIndex = index=>{
        if (index < 0 || index >= BUFFERS)
        {
            setError(GL.INVALID_VALUE);
            return false;
        }
        return true;
    };

    /**
     * @param {string} name @param {number} target @param {number} index
     * @returns {{ kind: string, values: number[] } | null}
     */
    const lookUp = (name, target, index)=>{
        if (!enter(name, [target, index]))
        {
            return null;
        }
        settle();
        const query = indexed.get(target);
        if (!query)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        const answer = query(index >>> 0);
        if (!answer)
        {
            setError(GL.INVALID_VALUE);
            return null;
        }
        return answer;
    };

    /** @param {number} cap @param {number} index @param {boolean} on */
    const enableAt = (cap, index, on)=>{
        if (cap !== GL.BLEND)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (!bufferIndex(index))
        {
            return;
        }
        blend[index] = on;
        if (index === 0)
        {
            setState(GL.BLEND, [on ? 1 : 0]);
        }
    };

    Object.assign(context, {
        /** @param {number} cap @param {number} index */
        glEnablei(cap, index){
            if (enter('glEnablei', [cap, index]))
            {
                enableAt(cap, index, true);
            }
        },

        /** @param {number} cap @param {number} index */
        glDisablei(cap, index){
            if (enter('glDisablei', [cap, index]))
            {
                enableAt(cap, index, false);
            }
        },

        /** @param {number} cap @param {number} index @returns {number} */
        glIsEnabledi(cap, index){
            if (!enter('glIsEnabledi', [cap, index]))
            {
                return GL.FALSE;
            }
            if (cap !== GL.BLEND)
            {
                setError(GL.INVALID_ENUM);
                return GL.FALSE;
            }
            if (!bufferIndex(index))
            {
                return GL.FALSE;
            }
            settle();
            return blend[index] ? GL.TRUE : GL.FALSE;
        },

        /**
         * @param {number} index
         * @param {number} red @param {number} green @param {number} blue @param {number} alpha
         */
        glColorMaski(index, red, green, blue, alpha){
            if (!enter('glColorMaski', [index, red, green, blue, alpha]))
            {
                return;
            }
            if (!bufferIndex(index))
            {
                return;
            }
            const values = [red, green, blue, alpha].map(v=>(v ? 1 : 0));
            masks[index].splice(0, 4, ...values);
            if (index === 0)
            {
                setState(GL.COLOR_WRITEMASK, values);
            }
        },

        /**
         * glBlendFuncSeparatei and glBlendFunci (4.0): one draw buffer's
         * factors. The first buffer's are the unindexed state; set, the
         * others that followed it keep what they had.
         *
         * @param {number} buffer @param {number} srcRgb @param {number} dstRgb
         * @param {number} srcAlpha @param {number} dstAlpha
         */
        glBlendFuncSeparatei(buffer, srcRgb, dstRgb, srcAlpha, dstAlpha){
            if (!enter('glBlendFuncSeparatei', [buffer, srcRgb, dstRgb, srcAlpha, dstAlpha]))
            {
                return;
            }
            if (!bufferIndex(buffer))
            {
                return;
            }
            if (![srcRgb, dstRgb, srcAlpha, dstAlpha].every(f=>BLEND_FACTORS.has(f))
                || dstRgb === GL.SRC_ALPHA_SATURATE || dstAlpha === GL.SRC_ALPHA_SATURATE)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const values = [srcRgb, dstRgb, srcAlpha, dstAlpha];
            if (buffer === 0)
            {
                const now = factorsNow();
                apart.forEach((one, index)=>{
                    if (index > 0 && !one.factors)
                    {
                        one.factors = now;
                    }
                });
                [GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA]
                    .forEach((query, k)=>setState(query, [values[k]]));
                setState(GL.BLEND_SRC, [srcRgb]);
                setState(GL.BLEND_DST, [dstRgb]);
                return;
            }
            apart[buffer].factors = values;
        },

        /**
         * glBlendEquationSeparatei and glBlendEquationi (4.0): one draw
         * buffer's equations, the first's the unindexed state.
         *
         * @param {number} buffer @param {number} rgb @param {number} alpha
         */
        glBlendEquationSeparatei(buffer, rgb, alpha){
            if (!enter('glBlendEquationSeparatei', [buffer, rgb, alpha]))
            {
                return;
            }
            if (!bufferIndex(buffer))
            {
                return;
            }
            if (!EQUATIONS.has(rgb) || !EQUATIONS.has(alpha))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (buffer === 0)
            {
                const now = equationsNow();
                apart.forEach((one, index)=>{
                    if (index > 0 && !one.equations)
                    {
                        one.equations = now;
                    }
                });
                setState(GL.BLEND_EQUATION_RGB, [rgb]);
                setState(GL.BLEND_EQUATION_ALPHA, [alpha]);
                return;
            }
            apart[buffer].equations = [rgb, alpha];
        },

        /** @param {number} target @param {number} index @returns {number[] | null} */
        glGetIntegeri_v(target, index){
            const answer = lookUp('glGetIntegeri_v', target, index);
            return answer ? answer.values.map(v=>(answer.kind === 'int64' ? Number(v) : v)) : null;
        },

        /** @param {number} target @param {number} index @returns {number[] | null} */
        glGetBooleani_v(target, index){
            const answer = lookUp('glGetBooleani_v', target, index);
            return answer ? answer.values.map(v=>(v !== 0 ? GL.TRUE : GL.FALSE)) : null;
        },

        /** @param {number} target @param {number} index @returns {number[] | null} */
        glGetInteger64i_v(target, index){
            const answer = lookUp('glGetInteger64i_v', target, index);
            return answer ? [...answer.values] : null;
        },

        /**
         * glGetInteger64v: what glGetIntegerv answers, as 64-bit values, and
         * the 64-bit state only it reaches (`kernel.side.int64`).
         *
         * @param {number} query @returns {number[] | null}
         */
        glGetInteger64v(query){
            const wide = kernel.side.int64?.get(query);
            if (wide)
            {
                return enter('glGetInteger64v', [query]) ? wide() : null;
            }
            return context.glGetIntegerv(query);
        },

        /**
         * glClearBufferiv, glClearBufferuiv and glClearBufferfv: one colour
         * draw buffer, or the depth or stencil buffer, to the value given.
         *
         * @param {number} buffer @param {number} drawBuffer
         * @param {readonly number[]} value  four for a colour, one for depth or stencil
         * @param {'int' | 'uint' | 'float'} kind
         */
        clearBuffer(buffer, drawBuffer, value, kind){
            if (!enter('clearBuffer', [buffer, drawBuffer, value, kind]))
            {
                return;
            }
            const depth = buffer === GL.DEPTH && kind === 'float';
            const stencil = buffer === GL.STENCIL && kind === 'int';
            if (buffer !== GL.COLOR && !depth && !stencil)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (buffer === GL.COLOR ? drawBuffer < 0 || drawBuffer >= BUFFERS : drawBuffer !== 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            clearOne(buffer === GL.COLOR ? drawBuffer : -1, depth, stencil, value);
        },

        /**
         * glClearBufferfi: the depth and stencil buffers at once.
         *
         * @param {number} buffer @param {number} drawBuffer
         * @param {number} depth @param {number} stencil
         */
        glClearBufferfi(buffer, drawBuffer, depth, stencil){
            if (!enter('glClearBufferfi', [buffer, drawBuffer, depth, stencil]))
            {
                return;
            }
            if (buffer !== GL.DEPTH_STENCIL)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (drawBuffer !== 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            clearOne(-1, true, true, [depth, stencil]);
        },
    });

    /**
     * @param {number} drawBuffer  the colour draw buffer, or -1 for depth and stencil
     * @param {boolean} depth @param {boolean} stencil
     * @param {readonly number[]} value  a colour, or depth then stencil
     */
    const clearOne = (drawBuffer, depth, stencil, value)=>{
        if (!kernel.side.drawComplete())
        {
            setError(GL.INVALID_FRAMEBUFFER_OPERATION);
            return;
        }
        /** @type {number[]} */
        const only = new Array(BUFFERS).fill(0);
        if (drawBuffer >= 0)
        {
            only[drawBuffer] = bits(masks[drawBuffer]);
        }
        kernel.clearWith({
            mask: (drawBuffer >= 0 ? GL.COLOR_BUFFER_BIT : 0)
                | (depth ? GL.DEPTH_BUFFER_BIT : 0) | (stencil ? GL.STENCIL_BUFFER_BIT : 0),
            colour: drawBuffer >= 0 ? [...value].slice(0, 4)
                : record(GL.COLOR_CLEAR_VALUE).values,
            depth: depth ? value[0] : record(GL.DEPTH_CLEAR_VALUE).values[0],
            stencil: stencil ? value[depth ? 1 : 0] : record(GL.STENCIL_CLEAR_VALUE).values[0],
            masks: only,
        });
    };
}

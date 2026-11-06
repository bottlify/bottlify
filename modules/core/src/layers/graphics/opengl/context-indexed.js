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
 *   and glColorMaski set one buffer's; glEnable(GL_BLEND) and glColorMask set
 *   every buffer's, and the unindexed queries answer the first's. A scene
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

/**
 * What a scene draws with when its draw buffers do not agree: each buffer's
 * blending and colour mask (red 1, green 2, blue 4, alpha 8). Null when they do.
 *
 * @typedef {{ blend: boolean[], masks: number[] } | null} PerBuffer
 */

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

    /** @type {Map<number, IndexedQuery>} */
    const indexed = new Map([
        [GL.BLEND, index=>(index < BUFFERS ? { kind: 'bool', values: [blend[index] ? 1 : 0] }
            : null)],
        [GL.COLOR_WRITEMASK, index=>(index < BUFFERS ? { kind: 'bool', values: masks[index] }
            : null)],
    ]);

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
        indexed,
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
        },
        /** @returns {PerBuffer} */
        perBuffer(){
            settle();
            const first = bits(masks[0]);
            if (blend.every(on=>on === blend[0]) && masks.every(mask=>bits(mask) === first))
            {
                return null;
            }
            return { blend: [...blend], masks: masks.map(bits) };
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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Viewport arrays (OpenGL 4.1 sections 13.6.1 and 14.9.2,
 * GL_ARB_viewport_array): sixteen viewports, each with its own rectangle,
 * depth range, scissor box and scissor test.
 *
 * - **The first is the unindexed state.** glViewport, glDepthRange,
 *   glScissor and glEnable(GL_SCISSOR_TEST) set every viewport's, and the
 *   unindexed queries answer the first's; the indexed calls set one. A
 *   viewport not set apart follows the first, so a program that never
 *   indexes keeps one set of records.
 * - **Primitives are drawn through the first.** Choosing another is a
 *   geometry shader's gl_ViewportIndex, which the GLSL front end does not
 *   take yet: no program here reaches another viewport.
 * - Every viewport's state is saved with its attribute group: the
 *   rectangles and depth ranges with GL_VIEWPORT_BIT, the scissor boxes with
 *   GL_SCISSOR_BIT, the tests with it and with GL_ENABLE_BIT.
 */

import { GL } from './constants.js';

/** How many viewports there are (GL_MAX_VIEWPORTS). */
const COUNT = 16;

/** Each kind of per-viewport state and its unindexed record. */
const KINDS = Object.freeze({
    viewport: GL.VIEWPORT,
    depth: GL.DEPTH_RANGE,
    scissor: GL.SCISSOR_BOX,
    test: GL.SCISSOR_TEST,
});

/** @typedef {keyof typeof KINDS} Kind */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installViewportCalls(context, kernel){
    const { enter, setError, setState, record } = kernel;

    /**
     * Each viewport's state where it was set apart; null where it follows
     * the first's, which is the unindexed record.
     *
     * @type {Record<Kind, (number[] | null)[]>}
     */
    const apart = {
        viewport: new Array(COUNT).fill(null),
        depth: new Array(COUNT).fill(null),
        scissor: new Array(COUNT).fill(null),
        test: new Array(COUNT).fill(null),
    };

    /** @param {Kind} kind @param {number} index @returns {number[]} */
    const valueOf = (kind, index)=>apart[kind][index] ?? [...record(KINDS[kind]).values];

    /**
     * One viewport's state; the first's is the record, and the others that
     * followed it keep what they had.
     *
     * @param {Kind} kind @param {number} index @param {number[]} values
     */
    const setAt = (kind, index, values)=>{
        if (index !== 0)
        {
            apart[kind][index] = values;
            return;
        }
        const now = [...record(KINDS[kind]).values];
        apart[kind].forEach((held, k)=>{
            if (k > 0 && !held)
            {
                apart[kind][k] = now;
            }
        });
        setState(KINDS[kind], values);
    };

    const indexed = kernel.side.indexed ??= new Map();
    indexed.set(GL.VIEWPORT, (/** @type {number} */ index)=>(index < COUNT
        ? { kind: 'float', values: valueOf('viewport', index) } : null));
    indexed.set(GL.DEPTH_RANGE, (/** @type {number} */ index)=>(index < COUNT
        ? { kind: 'float', values: valueOf('depth', index) } : null));
    indexed.set(GL.SCISSOR_BOX, (/** @type {number} */ index)=>(index < COUNT
        ? { kind: 'int', values: valueOf('scissor', index) } : null));
    indexed.set(GL.SCISSOR_TEST, (/** @type {number} */ index)=>(index < COUNT
        ? { kind: 'bool', values: valueOf('test', index) } : null));

    const enables = kernel.side.indexedEnables ??= new Map();
    enables.set(GL.SCISSOR_TEST, {
        count: COUNT,
        set: (/** @type {number} */ index, /** @type {boolean} */ on)=>
            setAt('test', index, [on ? 1 : 0]),
        get: (/** @type {number} */ index)=>valueOf('test', index)[0] !== 0,
    });

    /** @type {Map<number, Kind>} */
    const kindOf = new Map(/** @type {[Kind, number][]} */ (Object.entries(KINDS))
        .map(([kind, query])=>[query, kind]));

    // glEnable and glDisable of the scissor test set every viewport's.
    const before = kernel.side.allBuffers;
    Object.assign(kernel.side, {
        /** @param {number} cap @param {number[]} values */
        allBuffers(cap, values){
            before?.(cap, values);
            if (cap === GL.SCISSOR_TEST)
            {
                apart.test.fill(null);
            }
        },

        /**
         * glViewport, glDepthRange and glScissor set every viewport's: told
         * after the unindexed state has taken the value.
         *
         * @param {number} query
         */
        allViewports(query){
            apart[/** @type {Kind} */ (kindOf.get(query))].fill(null);
        },
    });

    /** The groups each kind is saved with. */
    const GROUPS = Object.freeze({
        viewport: GL.VIEWPORT_BIT,
        depth: GL.VIEWPORT_BIT,
        scissor: GL.SCISSOR_BIT,
        test: GL.SCISSOR_BIT | GL.ENABLE_BIT,
    });
    (kernel.side.attribSavers ??= []).push({
        /** @param {number} mask */
        save: mask=>Object.fromEntries(Object.entries(apart)
            .filter(([kind])=>(mask & GROUPS[/** @type {Kind} */ (kind)]) !== 0)
            .map(([kind, held])=>[kind, held.map(values=>values && [...values])])),
        /** @param {Partial<Record<Kind, (number[] | null)[]>>} kept */
        restore: kept=>{
            for (const [kind, held] of Object.entries(kept))
            {
                apart[/** @type {Kind} */ (kind)] = held;
            }
        },
    });

    /**
     * @param {number} first @param {number} count
     * @returns {boolean} whether the range is of viewports there are
     */
    const inRange = (first, count)=>{
        if (first < 0 || count < 0 || first + count > COUNT)
        {
            setError(GL.INVALID_VALUE);
            return false;
        }
        return true;
    };

    /**
     * Rectangles of `values`, four apiece, refused whole when one has a
     * negative size.
     *
     * @param {number} count @param {readonly number[]} values
     * @returns {number[][] | null}
     */
    const boxes = (count, values)=>{
        const list = Array.from({ length: count }, (_, k)=>[...values.slice(k * 4, k * 4 + 4)]);
        if (list.some(([, , width, height])=>width < 0 || height < 0))
        {
            setError(GL.INVALID_VALUE);
            return null;
        }
        return list;
    };

    const [low, high] = record(GL.VIEWPORT_BOUNDS_RANGE).values;
    const [widest, tallest] = record(GL.MAX_VIEWPORT_DIMS).values;
    /**
     * A rectangle within the bounds and dimensions, at whole pixels: there
     * are no subpixel bits (GL_VIEWPORT_SUBPIXEL_BITS).
     *
     * @param {number[]} box @returns {number[]}
     */
    const bounded = ([x, y, width, height])=>[Math.min(high, Math.max(low, Math.round(x))),
        Math.min(high, Math.max(low, Math.round(y))), Math.min(widest, Math.round(width)),
        Math.min(tallest, Math.round(height))];

    Object.assign(context, {
        /**
         * glViewportArrayv, and glViewportIndexedf(v) as a range of one.
         *
         * @param {number} first @param {number} count @param {readonly number[]} values
         */
        glViewportArrayv(first, count, values){
            if (!enter('glViewportArrayv', [first, count, [...values]]) || !inRange(first, count))
            {
                return;
            }
            boxes(count, values)?.forEach((box, k)=>setAt('viewport', first + k, bounded(box)));
        },

        /**
         * glScissorArrayv, and glScissorIndexed(v) as a range of one.
         *
         * @param {number} first @param {number} count @param {readonly number[]} values
         */
        glScissorArrayv(first, count, values){
            if (!enter('glScissorArrayv', [first, count, [...values]]) || !inRange(first, count))
            {
                return;
            }
            boxes(count, values)?.forEach((box, k)=>setAt('scissor', first + k, box));
        },

        /**
         * glDepthRangeArrayv, and glDepthRangeIndexed as a range of one.
         *
         * @param {number} first @param {number} count @param {readonly number[]} values
         */
        glDepthRangeArrayv(first, count, values){
            if (!enter('glDepthRangeArrayv', [first, count, [...values]])
                || !inRange(first, count))
            {
                return;
            }
            const clamp = (/** @type {number} */ v)=>Math.min(1, Math.max(0, v));
            for (let k = 0; k < count; k++)
            {
                setAt('depth', first + k, [clamp(values[k * 2]), clamp(values[k * 2 + 1])]);
            }
        },
    });
}

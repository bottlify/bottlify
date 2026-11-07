/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Query objects (OpenGL 3.3 section 2.14, 4.1.7) and conditional rendering
 * (OpenGL 3.0 section 2.18).
 *
 * - **An occlusion query counts what the device drew.** On a device the draws
 *   recorded while one is active count their passing samples (`gpu.js`
 *   beginQuery); its result is available once the recording that ended it has
 *   been replayed and counted. GL_SAMPLES_PASSED answers the count,
 *   GL_ANY_SAMPLES_PASSED and its conservative form whether it is not zero.
 *   Without a device nothing counts samples, and the query answers the
 *   viewport's area, which is reported.
 * - **Asking for a result not available waits for it**: what the context
 *   recorded is replayed then rather than at the next swap, and the call
 *   answers once it is counted.
 * - **Time is the processor's** (GL_TIME_ELAPSED, GL_TIMESTAMP): nanoseconds
 *   of the page's clock between the begin and the end, or at the counter, as
 *   the calls are made; the device's own timestamps are not read.
 * - **Conditional rendering decides on the device** (`gpu.js` conditioned):
 *   the draws and clears between glBeginConditionalRender and its end are
 *   recorded with the query, and replayed only if it counted something. A
 *   query ended in the recording still open is flushed first, so its count
 *   is known when they replay; every mode is exact, the waits included.
 *   Without a device everything is drawn.
 */

import { GL } from './constants.js';

export const QUERY = Object.freeze({
    SAMPLES_PASSED: 0x8914,
    ANY_SAMPLES_PASSED: 0x8c2f,
    ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
    TIME_ELAPSED: 0x88bf,
    PRIMITIVES_GENERATED: 0x8c87,
    TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN: 0x8c88,
    TIMESTAMP: 0x8e28,
    QUERY_COUNTER_BITS: 0x8864,
    CURRENT_QUERY: 0x8865,
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT_NO_WAIT: 0x9194,
    QUERY_WAIT: 0x8e13,
    QUERY_NO_WAIT: 0x8e14,
    QUERY_BY_REGION_WAIT: 0x8e15,
    QUERY_BY_REGION_NO_WAIT: 0x8e16,
    QUERY_WAIT_INVERTED: 0x8e17,
    QUERY_NO_WAIT_INVERTED: 0x8e18,
    QUERY_BY_REGION_WAIT_INVERTED: 0x8e19,
    QUERY_BY_REGION_NO_WAIT_INVERTED: 0x8e1a,
});

/** The calls of this file a display list does not record (section 5.5). */
export const QUERY_CALLS_NOT_COMPILED = Object.freeze([
    'glGenQueries', 'glDeleteQueries', 'glIsQuery', 'glGetQueryiv', 'glGetQueryObject',
    'glBeginQuery', 'glEndQuery', 'glQueryCounter', 'glBeginConditionalRender',
    'glEndConditionalRender', 'glBeginQueryIndexed', 'glEndQueryIndexed', 'glGetQueryIndexediv',
    'glCreateQueries', 'queryIntoBuffer',
]);

/** GL_MAX_VERTEX_STREAMS (4.0): the streams a primitive query may count. */
export const MAX_VERTEX_STREAMS = 4;

/** GL_QUERY_BUFFER and its binding (4.4). */
export const QUERY_BUFFER = 0x9192;
export const QUERY_BUFFER_BINDING = 0x9193;

/** The targets glBeginQuery takes, and how wide each one's counter is. */
/** @type {Map<number, number>} */
const COUNTER_BITS = new Map([
    [QUERY.SAMPLES_PASSED, 64],
    [QUERY.ANY_SAMPLES_PASSED, 1],
    [QUERY.ANY_SAMPLES_PASSED_CONSERVATIVE, 1],
    [QUERY.TIME_ELAPSED, 64],
    [QUERY.PRIMITIVES_GENERATED, 64],
    [QUERY.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN, 64],
]);

/**
 * The targets that count primitives (OpenGL 3.0 section 2.15): what the
 * vertex or geometry shader made, and what transform feedback wrote.
 *
 * @type {Set<number>}
 */
const PRIMITIVE_COUNTS = new Set([QUERY.PRIMITIVES_GENERATED,
    QUERY.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN]);

/** The occlusion targets, which count samples and condition rendering. */
/** @type {Set<number>} */
const OCCLUSION = new Set([QUERY.SAMPLES_PASSED, QUERY.ANY_SAMPLES_PASSED,
    QUERY.ANY_SAMPLES_PASSED_CONSERVATIVE]);

/** The modes glBeginConditionalRender takes; the inverted ones are 4.5's. */
/** @type {Set<number>} */
const CONDITION_MODES = new Set(Object.entries(QUERY)
    .filter(([name])=>/^QUERY_(BY_REGION_)?(NO_)?WAIT(_INVERTED)?$/.test(name))
    .map(([, value])=>value));

/**
 * A query object: what it counts, what it has counted, and whether that is
 * known yet. `done` settles once it is.
 *
 * @typedef {{ name: number, target: number, samples: number, available: boolean,
 *     result: number, started: number, done: Promise<void>, finish: () => void }} QueryObject
 */

/** @returns {number} the page's clock in nanoseconds */
const now = ()=>Math.round(performance.now() * 1e6);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installQueryCalls(context, kernel){
    const { enter, setError, record, diverge } = kernel;

    /** @type {Map<number, QueryObject | null>} names, null until first begun */
    const queries = new Map();
    /** @type {Map<number, QueryObject>} the active query of each target */
    const active = new Map();
    /** @type {QueryObject | null} the query rendering is conditional on */
    let condition = null;

    /**
     * A new count for `name`: begun, not finished.
     *
     * @param {number} name @param {number} target @returns {QueryObject}
     */
    const begin = (name, target)=>{
        /** @type {() => void} */
        let settle = ()=>{};
        /** @type {QueryObject} */
        const query = {
            name, target, samples: 0, available: false, result: 0, started: now(),
            done: new Promise(resolve=>{
                settle = ()=>resolve(undefined);
            }),
            finish: ()=>{
                if (query.available)
                {
                    return;
                }
                query.result = target === QUERY.SAMPLES_PASSED || PRIMITIVE_COUNTS.has(target)
                    ? query.samples
                    : OCCLUSION.has(target) ? (query.samples > 0 ? 1 : 0) : query.result;
                query.available = true;
                settle();
            },
        };
        return query;
    };

    Object.assign(kernel.side, {
        /** The query rendering is conditional on, for the renderer's draws and clears. */
        condition: ()=>condition,
    });

    /**
     * Queries of a stream past the first (4.0): no shader here emits to one
     * (a geometry shader's other streams are refused when it is compiled), so
     * each counts nothing, exactly.
     *
     * @type {Map<string, QueryObject>}
     */
    const streams = new Map();

    /**
     * Whether a query names its stream as its target allows: any of
     * GL_MAX_VERTEX_STREAMS for the primitive counts, the first for the rest.
     *
     * @param {number} target @param {number} index @returns {boolean}
     */
    const indexAllowed = (target, index)=>{
        if (!COUNTER_BITS.has(target))
        {
            setError(GL.INVALID_ENUM);
            return false;
        }
        if (index < 0 || index >= (PRIMITIVE_COUNTS.has(target) ? MAX_VERTEX_STREAMS : 1))
        {
            setError(GL.INVALID_VALUE);
            return false;
        }
        return true;
    };

    /**
     * A query's answer as the bytes a query buffer takes: a 32-bit form
     * clamped to its range, a 64-bit one whole.
     *
     * @param {number} value @param {boolean} wide @param {boolean} signed
     * @returns {Uint8Array}
     */
    const resultBytes = (value, wide, signed)=>{
        const bytes = new Uint8Array(wide ? 8 : 4);
        const view = new DataView(bytes.buffer);
        if (wide)
        {
            view.setBigUint64(0, BigInt.asUintN(64, BigInt(Math.trunc(value))), true);
        }
        else
        {
            view.setUint32(0, Math.min(value, signed ? 0x7fffffff : 0xffffffff) >>> 0, true);
        }
        return bytes;
    };

    Object.assign(context, {
        /**
         * glBeginQueryIndexed (4.0): stream zero is glBeginQuery's.
         *
         * @param {number} target @param {number} index @param {number} name
         */
        glBeginQueryIndexed(target, index, name){
            if (!enter('glBeginQueryIndexed', [target, index, name])
                || !indexAllowed(target, index))
            {
                return;
            }
            if (index === 0)
            {
                context.glBeginQuery(target, name);
                return;
            }
            const key = `${target}/${index}`;
            const held = queries.get(name);
            const busy = [...active.values(), ...streams.values()].some(q=>q.name === name);
            if (name === 0 || streams.has(key) || busy || (held && held.target !== target))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const query = begin(name, target);
            queries.set(name, query);
            streams.set(key, query);
        },

        /** @param {number} target @param {number} index */
        glEndQueryIndexed(target, index){
            if (!enter('glEndQueryIndexed', [target, index]) || !indexAllowed(target, index))
            {
                return;
            }
            if (index === 0)
            {
                context.glEndQuery(target);
                return;
            }
            const key = `${target}/${index}`;
            const query = streams.get(key);
            if (!query)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            streams.delete(key);
            query.finish();
        },

        /**
         * @param {number} target @param {number} index @param {number} pname
         * @returns {number[] | null}
         */
        glGetQueryIndexediv(target, index, pname){
            if (!enter('glGetQueryIndexediv', [target, index, pname])
                || !indexAllowed(target, index))
            {
                return null;
            }
            if (index === 0 || pname !== QUERY.CURRENT_QUERY)
            {
                return context.glGetQueryiv(target, pname);
            }
            return [streams.get(`${target}/${index}`)?.name ?? 0];
        },

        /**
         * glCreateQueries (4.5): names that are objects of `target` at once,
         * each with its result zero and available.
         *
         * @param {number} target @param {number} count @returns {number[]}
         */
        glCreateQueries(target, count){
            if (!enter('glCreateQueries', [target, count]))
            {
                return [];
            }
            if (!COUNTER_BITS.has(target) && target !== QUERY.TIMESTAMP)
            {
                setError(GL.INVALID_ENUM);
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
                    const query = begin(name, target);
                    query.finish();
                    query.result = 0;
                    queries.set(name, query);
                    names.push(name);
                }
            }
            return names;
        },

        /**
         * A query's answer written into a buffer (4.4's query buffer, 4.5's
         * glGetQueryBufferObject): at once when it is known or only its
         * availability is asked, when it is counted otherwise; a result
         * asked without waiting and not yet known leaves the bytes alone.
         *
         * @param {number} name @param {number} pname @param {number} offset
         * @param {boolean} wide @param {boolean} signed
         * @param {number | null} bufferName  null: the bound GL_QUERY_BUFFER
         */
        queryIntoBuffer(name, pname, offset, wide, signed, bufferName){
            if (!enter('queryIntoBuffer', [name, pname, offset, wide, signed, bufferName]))
            {
                return;
            }
            const query = queries.get(name);
            if (!query || [...active.values(), ...streams.values()].includes(query))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const which = bufferName ?? record(QUERY_BUFFER_BINDING).values[0];
            const buffer = which === 0 ? undefined
                : kernel.shareGroup().buffers.objects.get(which);
            if (!buffer)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const size = wide ? 8 : 4;
            if (offset < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (offset + size > buffer.size)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (pname !== QUERY.QUERY_RESULT && pname !== QUERY.QUERY_RESULT_AVAILABLE
                && pname !== QUERY.QUERY_RESULT_NO_WAIT)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            /** @param {number} value */
            const put = value=>{
                buffer.data.set(resultBytes(value, wide, signed), offset);
                buffer.written = buffer.written
                    ? { start: Math.min(buffer.written.start, offset),
                        end: Math.max(buffer.written.end, offset + size) }
                    : { start: offset, end: offset + size };
                buffer.version++;
            };
            if (pname === QUERY.QUERY_RESULT_AVAILABLE)
            {
                put(query.available ? 1 : 0);
            }
            else if (query.available)
            {
                put(query.result);
            }
            else if (pname === QUERY.QUERY_RESULT)
            {
                kernel.queries?.flush();
                query.done.then(()=>put(query.result));
            }
        },

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
                for (const [target, query] of active)
                {
                    if (query.name === name)
                    {
                        // Deleting an active query ends it, as glEndQuery would.
                        context.glEndQuery(target);
                    }
                }
                for (const [key, query] of streams)
                {
                    if (query.name === name)
                    {
                        streams.delete(key);
                        query.finish();
                    }
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
            if (!COUNTER_BITS.has(target))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const held = queries.get(name);
            const busy = [...active.values()].some(query=>query.name === name);
            if (name === 0 || active.has(target) || busy || (held && held.target !== target
                && !(OCCLUSION.has(held.target) && OCCLUSION.has(target))))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const query = begin(name, target);
            queries.set(name, query);
            active.set(target, query);
            if (PRIMITIVE_COUNTS.has(target))
            {
                if (kernel.feedback)
                {
                    kernel.feedback.count(target, query);
                }
                else
                {
                    diverge('a query counting primitives on the processor counts none: it'
                        + ' answers 0');
                }
            }
            if (OCCLUSION.has(target))
            {
                if (kernel.queries)
                {
                    kernel.queries.begin(query);
                }
                else
                {
                    diverge('an occlusion query on the processor counts no samples: it'
                        + ' answers the viewport\'s area');
                }
            }
        },

        /** @param {number} target */
        glEndQuery(target){
            if (!enter('glEndQuery', [target]))
            {
                return;
            }
            if (!COUNTER_BITS.has(target))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const query = active.get(target);
            if (!query)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            active.delete(target);
            if (PRIMITIVE_COUNTS.has(target))
            {
                if (kernel.feedback)
                {
                    kernel.feedback.count(target, null);
                    kernel.feedback.ended(query);
                }
                else
                {
                    query.finish();
                }
            }
            else if (target === QUERY.TIME_ELAPSED)
            {
                query.result = now() - query.started;
                query.finish();
            }
            else if (kernel.queries)
            {
                kernel.queries.end(query);
            }
            else
            {
                const [, , width, height] = record(GL.VIEWPORT).values;
                query.samples = Math.max(1, width * height);
                query.finish();
            }
        },

        /** @param {number} name @param {number} target */
        glQueryCounter(name, target){
            if (!enter('glQueryCounter', [name, target]))
            {
                return;
            }
            if (target !== QUERY.TIMESTAMP)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const held = queries.get(name);
            if (!queries.has(name) || [...active.values()].some(query=>query.name === name)
                || (held && held.target !== QUERY.TIMESTAMP))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const query = begin(name, QUERY.TIMESTAMP);
            query.result = query.started;
            query.finish();
            queries.set(name, query);
        },

        /** @param {number} target @param {number} pname @returns {number[] | null} */
        glGetQueryiv(target, pname){
            if (!enter('glGetQueryiv', [target, pname]))
            {
                return null;
            }
            const timestamp = target === QUERY.TIMESTAMP;
            if (!COUNTER_BITS.has(target) && !timestamp)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (pname === QUERY.QUERY_COUNTER_BITS)
            {
                return [timestamp ? 64 : /** @type {number} */ (COUNTER_BITS.get(target))];
            }
            if (pname === QUERY.CURRENT_QUERY && !timestamp)
            {
                return [active.get(target)?.name ?? 0];
            }
            setError(GL.INVALID_ENUM);
            return null;
        },

        /**
         * glGetQueryObject{iv,uiv,i64v,ui64v}: a result not yet known is
         * waited for, its recording replayed now.
         *
         * @param {number} name @param {number} pname
         * @returns {number[] | Promise<number[]> | null}
         */
        glGetQueryObject(name, pname){
            if (!enter('glGetQueryObject', [name, pname]))
            {
                return null;
            }
            const query = queries.get(name);
            if (!query || [...active.values()].includes(query))
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            switch (pname)
            {
                case QUERY.QUERY_RESULT_AVAILABLE:
                    return [query.available ? GL.TRUE : GL.FALSE];
                case QUERY.QUERY_RESULT_NO_WAIT:
                    return query.available ? [query.result] : null;
                case QUERY.QUERY_RESULT:
                    if (query.available)
                    {
                        return [query.result];
                    }
                    kernel.queries?.flush();
                    return query.done.then(()=>[query.result]);
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /** @param {number} name @param {number} mode */
        glBeginConditionalRender(name, mode){
            if (!enter('glBeginConditionalRender', [name, mode]))
            {
                return;
            }
            if (!CONDITION_MODES.has(mode))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const query = queries.get(name);
            if (!query || !OCCLUSION.has(query.target))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (condition || [...active.values()].includes(query))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            condition = query;
            kernel.queries?.condition(query, mode >= QUERY.QUERY_WAIT_INVERTED);
        },

        glEndConditionalRender(){
            if (!enter('glEndConditionalRender', []))
            {
                return;
            }
            if (!condition)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            condition = null;
            kernel.queries?.condition(null, false);
        },
    });
}

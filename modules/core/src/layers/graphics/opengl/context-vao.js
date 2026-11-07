/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex array objects (OpenGL 3.0 section 2.10, GL_ARB_vertex_array_object).
 *
 * A vertex array object is the vertex array state as a whole: every array's
 * pointer, type, stride and enable, the generic attributes', and the element
 * array buffer binding. The context's own state is the bound object's, so
 * binding one keeps the state it leaves with the object it was, and makes the
 * new object's the context's (`vertexArrayState`, `useVertexArrayState` in
 * `context-arrays.js`); object zero is the context's default. Names are the
 * context's own, never shared with another context, and a name is an object
 * only once it has been bound (glIsVertexArray), or glCreateVertexArrays (4.5)
 * made it. None of these calls is compiled into a display list.
 *
 * The named calls (4.5's direct state access) bind the object for the call
 * and put the binding back after: what they set is what the bound call sets,
 * and object zero is the default one, which the compatibility profile names.
 */

import { GL } from './constants.js';

/** The calls of this file a display list does not record (section 5.4). */
export const VERTEX_ARRAY_CALLS_NOT_COMPILED = Object.freeze([
    'glGenVertexArrays', 'glDeleteVertexArrays', 'glBindVertexArray', 'glIsVertexArray',
    'glCreateVertexArrays', 'namedVertexArray', 'glVertexArrayElementBuffer',
    'getVertexArray', 'getVertexArrayIndexed',
]);

/**
 * What glGetVertexArrayIndexediv answers of an attribute (4.5 table 23.4).
 *
 * @type {ReadonlySet<number>}
 */
const ATTRIBUTE_QUERIES = new Set([
    GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB, GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB,
    GL.VERTEX_ATTRIB_ARRAY_STRIDE_ARB, GL.VERTEX_ATTRIB_ARRAY_TYPE_ARB,
    GL.VERTEX_ATTRIB_ARRAY_NORMALIZED_ARB, GL.VERTEX_ATTRIB_ARRAY_INTEGER,
    GL.VERTEX_ATTRIB_ARRAY_LONG, GL.VERTEX_ATTRIB_ARRAY_DIVISOR,
    GL.VERTEX_ATTRIB_RELATIVE_OFFSET,
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installVertexArrayCalls(context, kernel){
    const { enter, setError, setState } = kernel;

    /** A new object's state: the context's as it was made, before any call. */
    const initial = kernel.side.vertexArrayState();
    /**
     * The objects by name: null for a name generated and not yet bound, the
     * state it holds while it is not the bound one.
     *
     * @type {Map<number, any>}
     */
    const objects = new Map();
    /** The default object's state while another is bound. */
    /** @type {any} */
    let defaultState = null;
    let bound = 0;

    /** @param {number} name */
    const bind = name=>{
        if (name === bound)
        {
            return;
        }
        const leaving = kernel.side.vertexArrayState();
        if (bound === 0)
        {
            defaultState = leaving;
        }
        else if (objects.has(bound))
        {
            objects.set(bound, leaving);
        }
        const state = name === 0 ? defaultState : objects.get(name);
        kernel.side.useVertexArrayState(state ?? structuredClone(initial));
        if (name !== 0)
        {
            // Bound once, the name is an object; what it holds is the context's now.
            objects.set(name, null);
        }
        bound = name;
        setState(GL.VERTEX_ARRAY_BINDING, [name]);
    };

    Object.assign(context, {
        /** @param {number} count @returns {number[]} */
        glGenVertexArrays(count){
            if (!enter('glGenVertexArrays', [count]))
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
            for (let next = 1; names.length < count; next++)
            {
                if (!objects.has(next))
                {
                    objects.set(next, undefined);
                    names.push(next);
                }
            }
            return names;
        },

        /** @param {number} name */
        glBindVertexArray(name){
            if (!enter('glBindVertexArray', [name]))
            {
                return;
            }
            if (name !== 0 && !objects.has(name))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            bind(name);
        },

        /** @param {number[]} names */
        glDeleteVertexArrays(names){
            if (!enter('glDeleteVertexArrays', [names]))
            {
                return;
            }
            for (const name of names)
            {
                if (name === 0 || !objects.has(name))
                {
                    continue;
                }
                // The bound object deleted leaves the default one bound.
                if (name === bound)
                {
                    bind(0);
                }
                objects.delete(name);
            }
        },

        /**
         * glCreateVertexArrays (4.5): names that are objects already, each
         * with a new object's state, none bound.
         *
         * @param {number} count @returns {number[]}
         */
        glCreateVertexArrays(count){
            if (!enter('glCreateVertexArrays', [count]))
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
            for (let next = 1; names.length < count; next++)
            {
                if (!objects.has(next))
                {
                    objects.set(next, structuredClone(initial));
                    names.push(next);
                }
            }
            return names;
        },

        /**
         * A named call (4.5): the bound form `call` made with `name` bound,
         * the binding put back after. A name that is not an object is
         * GL_INVALID_OPERATION.
         *
         * @param {string} call  the bound form's name on the context
         * @param {number} name @param {any[]} args
         * @returns {any}
         */
        namedVertexArray(call, name, args){
            if (!enter('namedVertexArray', [call, name, args]))
            {
                return null;
            }
            if (name !== 0 && (!objects.has(name) || objects.get(name) === undefined))
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            const was = bound;
            bind(name);
            try
            {
                return context[call](...args);
            }
            finally
            {
                bind(was);
            }
        },

        /**
         * glVertexArrayElementBuffer (4.5): the object's element array
         * buffer, zero or a buffer object there is.
         *
         * @param {number} name @param {number} buffer
         */
        glVertexArrayElementBuffer(name, buffer){
            if (!enter('glVertexArrayElementBuffer', [name, buffer]))
            {
                return;
            }
            if (buffer !== 0 && !kernel.shareGroup().buffers.objects.has(buffer))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            context.namedVertexArray('glBindBufferARB', name,
                [GL.ELEMENT_ARRAY_BUFFER, buffer]);
        },

        /**
         * glGetVertexArrayiv (4.5): the element array buffer, the one thing
         * it answers.
         *
         * @param {number} name @param {number} pname @returns {number[] | null}
         */
        getVertexArray(name, pname){
            if (!enter('getVertexArray', [name, pname]))
            {
                return null;
            }
            if (pname !== GL.ELEMENT_ARRAY_BUFFER_BINDING)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return context.namedVertexArray('glGetIntegerv', name, [pname]);
        },

        /**
         * glGetVertexArrayIndexediv and glGetVertexArrayIndexed64iv (4.5): an
         * attribute's state, or with the 64-bit form a binding point's offset.
         *
         * @param {number} name @param {number} index @param {number} pname
         * @param {boolean} wide  the 64-bit form
         * @returns {number[] | null}
         */
        getVertexArrayIndexed(name, index, pname, wide){
            if (!enter('getVertexArrayIndexed', [name, index, pname, wide]))
            {
                return null;
            }
            if (wide ? pname !== GL.VERTEX_BINDING_OFFSET : !ATTRIBUTE_QUERIES.has(pname))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return wide
                ? context.namedVertexArray('glGetInteger64i_v', name, [pname, index])
                : context.namedVertexArray('glGetVertexAttribfvARB', name, [index, pname]);
        },

        /** @param {number} name @returns {number} */
        glIsVertexArray(name){
            if (!enter('glIsVertexArray', [name]))
            {
                return GL.FALSE;
            }
            return name !== 0 && objects.has(name) && objects.get(name) !== undefined
                ? GL.TRUE : GL.FALSE;
        },
    });
}

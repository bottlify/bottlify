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
 * only once it has been bound (glIsVertexArray). None of these calls is
 * compiled into a display list.
 */

import { GL } from './constants.js';

/** The calls of this file a display list does not record (section 5.4). */
export const VERTEX_ARRAY_CALLS_NOT_COMPILED = Object.freeze([
    'glGenVertexArrays', 'glDeleteVertexArrays', 'glBindVertexArray', 'glIsVertexArray',
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

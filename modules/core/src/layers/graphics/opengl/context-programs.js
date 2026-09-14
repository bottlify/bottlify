/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * ARB vertex and fragment programs: the program objects, their parameters,
 * and the generic vertex attributes.
 *
 * The object model is the texture one, which is what the specification
 * resolves it to: glGenProgramsARB marks names used, glBindProgramARB brings
 * an object into existence, and a generated name that was never bound is not
 * a program -- glIsProgramARB says no until it is. Deleting a bound program
 * rebinds the target's default, the way deleting a bound texture does.
 *
 * Three ownership rules run through the state here:
 *
 * - **The binding is per target and per context; the object is shared.** A
 *   program lives in the share group, so two contexts of one group load and
 *   bind the same object; which one is bound is this context's own state.
 * - **Environment parameters are per target, local parameters per object.**
 *   An env parameter set for the vertex target is seen by every vertex
 *   program bound afterwards; a local parameter travels with its object.
 * - **A load changes only the object.** The string and the parse land on the
 *   bound program object; nothing else about the target moves.
 *
 * The generic vertex attributes are the second front of ARB_vertex_program:
 * sixteen current values any program reads through `vertex.attrib[n]`, and
 * sixteen client arrays that override them per vertex. The arrays are client
 * state and the current values are current state, and the attribute stacks
 * save them under those bits.
 */

import { GL } from './constants.js';
import { PROGRAM_LIMITS, canonicalAttribName } from './arb-program.js';
import { createProgramObject } from './objects.js';

/** How many generic vertex attributes the specification's minimum requires. */
export const GENERIC_ATTRIBS = 16;


/**
 * @typedef {Object} GenericAttribArray
 * @property {number} enabled
 * @property {number} size
 * @property {number} type
 * @property {number} normalised
 * @property {number} stride
 * @property {number} pointer
 * @property {number} buffer  the ARRAY_BUFFER bound when the pointer was set
 */

/** @returns {GenericAttribArray} */
const createAttribArray = ()=>({
    enabled: 0, size: 4, type: GL.FLOAT, normalised: 0, stride: 0, pointer: 0, buffer: 0,
});

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installProgramCalls(context, kernel){
    /** @type {Map<number, number>} target -> the bound program's name */
    const bindings = new Map([[GL.VERTEX_PROGRAM_ARB, 0], [GL.FRAGMENT_PROGRAM_ARB, 0]]);
    /** @type {Map<number, Float32Array>} target -> the environment parameters */
    const env = new Map([
        [GL.VERTEX_PROGRAM_ARB, new Float32Array(PROGRAM_LIMITS.vertex.envParameters * 4)],
        [GL.FRAGMENT_PROGRAM_ARB, new Float32Array(PROGRAM_LIMITS.fragment.envParameters * 4)],
    ]);
    /** The default object of each target: what a binding of zero draws with. */
    /** @type {Map<number, import('./objects.js').ProgramObject>} */
    const defaults = new Map([
        [GL.VERTEX_PROGRAM_ARB,
            createProgramObject(0, GL.VERTEX_PROGRAM_ARB, PROGRAM_LIMITS.vertex.localParameters)],
        [GL.FRAGMENT_PROGRAM_ARB,
            createProgramObject(0, GL.FRAGMENT_PROGRAM_ARB,
                PROGRAM_LIMITS.fragment.localParameters)],
    ]);
    /** The program error string; empty while no load can fail. */
    let errorString = '';

    /** @type {number[][]} the current generic vertex attributes */
    const attribValues = Array.from({ length: GENERIC_ATTRIBS }, ()=>[0, 0, 0, 1]);
    /** @type {GenericAttribArray[]} */
    const attribArrays = Array.from({ length: GENERIC_ATTRIBS }, createAttribArray);

    /**
     * The program object a target draws from: the bound one, or the target's
     * default when the binding is zero.
     *
     * @param {number} target
     * @returns {import('./objects.js').ProgramObject | undefined}
     */
    const boundProgram = target=>{
        const name = bindings.get(target) ?? 0;
        return name === 0
            ? defaults.get(target)
            : kernel.shareGroup().programs.objects.get(name) ?? defaults.get(target);
    };

    Object.assign(kernel.side, {
        programs: {
            bindings,
            boundProgram,
            env,
            attribValues,
            attribArrays,

            /**
             * The generic attribute arrays a draw reads, as the named arrays
             * are read: enabled ones only, each under the canonical attribute
             * name its index aliases to.
             *
             * @returns {{ index: number, name: string, normalised: boolean,
             *             pointer: import('./arrays.js').ArrayPointer }[]}
             */
            genericArrays(){
                /** @type {{ index: number, name: string, normalised: boolean,
                 *           pointer: import('./arrays.js').ArrayPointer }[]} */
                const out = [];
                attribArrays.forEach((array, index)=>{
                    if (array.enabled === 0)
                    {
                        return;
                    }
                    out.push({
                        index,
                        name: canonicalAttribName(index),
                        normalised: array.normalised !== 0,
                        pointer: {
                            size: array.size, type: array.type, stride: array.stride,
                            pointer: array.pointer, buffer: array.buffer,
                        },
                    });
                });
                return out;
            },
        },
        programErrorString: ()=>errorString,

        /** @param {number} mask @returns {any} */
        saveServerPrograms(mask){
            return {
                values: (mask & GL.CURRENT_BIT) !== 0
                    ? attribValues.map(value=>[...value])
                    : null,
                bindings: (mask & GL.TRANSFORM_BIT) !== 0 ? new Map(bindings) : null,
            };
        },

        /** @param {any} saved */
        restoreServerPrograms(saved){
            if (saved.values)
            {
                saved.values.forEach((/** @type {number[]} */ value, /** @type {number} */ i)=>{
                    attribValues[i] = value;
                });
            }
            if (saved.bindings)
            {
                for (const [target, name] of saved.bindings)
                {
                    bindings.set(target, name);
                }
            }
        },

        /** @param {number} mask @returns {any} */
        saveClientPrograms(mask){
            return (mask & GL.CLIENT_VERTEX_ARRAY_BIT) === 0
                ? null
                : attribArrays.map(array=>({ ...array }));
        },

        /** @param {any} saved */
        restoreClientPrograms(saved){
            if (!saved)
            {
                return;
            }
            saved.forEach((/** @type {GenericAttribArray} */ array, /** @type {number} */ i)=>{
                Object.assign(attribArrays[i], array);
            });
        },
    });
}

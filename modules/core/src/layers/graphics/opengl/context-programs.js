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
 * - **A failed load changes nothing.** The string, the parse and the binding
 *   survive a glProgramStringARB that is refused; only the error position
 *   and the error string move, because those are the report of the failure.
 *
 * The generic vertex attributes are the second front of ARB_vertex_program:
 * sixteen current values any program reads through `vertex.attrib[n]`, and
 * sixteen client arrays that override them per vertex. The arrays are client
 * state and the current values are current state, and the attribute stacks
 * save them under those bits.
 */

import { GL } from './constants.js';
import { PROGRAM_LIMITS, canonicalAttribName, parseProgram } from './arb-program.js';
import { createProgramObject } from './objects.js';

/** How many generic vertex attributes the specification's minimum requires. */
export const GENERIC_ATTRIBS = 16;

/** The program targets, and the program kind each one loads. */
/** @type {Map<number, 'vertex' | 'fragment'>} */
const TARGETS = new Map([
    [GL.VERTEX_PROGRAM_ARB, 'vertex'],
    [GL.FRAGMENT_PROGRAM_ARB, 'fragment'],
]);

/** @type {Set<number>} */
const ATTRIB_TYPES = new Set([
    GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT, GL.UNSIGNED_INT, GL.FLOAT,
    GL.DOUBLE,
]);

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
    const { enter, setError, record, setState } = kernel;

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
    /** The error string the last glProgramStringARB left. */
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

    /**
     * A parameter setter's shared half: the target and index a four-float
     * write is refused at.
     *
     * @param {string} call
     * @param {any[]} args  the full argument list, which is what a display
     *        list replays
     * @param {number} index
     * @param {Float32Array | undefined} file
     * @returns {boolean}
     */
    const checkIndex = (call, args, index, file)=>{
        if (!enter(call, args))
        {
            return false;
        }
        if (!file)
        {
            setError(GL.INVALID_ENUM);
            return false;
        }
        if (!(index >= 0) || index * 4 >= file.length)
        {
            setError(GL.INVALID_VALUE);
            return false;
        }
        return true;
    };

    /**
     * @param {string} call
     * @param {any[]} args
     * @param {number} index
     * @returns {boolean}
     */
    const checkAttrib = (call, args, index)=>{
        if (!enter(call, args))
        {
            return false;
        }
        if (!(index >= 0) || index >= GENERIC_ATTRIBS)
        {
            setError(GL.INVALID_VALUE);
            return false;
        }
        return true;
    };

    Object.assign(context, {
        // --- the program objects ---

        /** @param {number} count @returns {number[]} */
        glGenProgramsARB(count){
            if (!enter('glGenProgramsARB', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            return kernel.shareGroup().programs.reserve(count);
        },

        /** @param {number[]} names */
        glDeleteProgramsARB(names){
            if (!enter('glDeleteProgramsARB', [names]))
            {
                return;
            }
            const group = kernel.shareGroup();
            for (const name of names)
            {
                if (name === 0)
                {
                    continue;
                }
                group.programs.remove(name);
                for (const [target, bound] of bindings)
                {
                    if (bound === name)
                    {
                        bindings.set(target, 0);
                    }
                }
            }
        },

        /** @param {number} name @returns {number} */
        glIsProgramARB(name){
            if (!enter('glIsProgramARB', [name]))
            {
                return GL.FALSE;
            }
            return kernel.shareGroup().programs.objects.has(name) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} target @param {number} name */
        glBindProgramARB(target, name){
            if (!enter('glBindProgramARB', [target, name]))
            {
                return;
            }
            const kind = TARGETS.get(target);
            if (!kind)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const group = kernel.shareGroup();
            const existing = name === 0 ? undefined : group.programs.objects.get(name);
            if (existing && existing.target !== 0 && existing.target !== target)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (name !== 0 && !existing)
            {
                group.programs.define(name,
                    createProgramObject(name, target, PROGRAM_LIMITS[kind].localParameters));
                group.used = true;
            }
            bindings.set(target, name);
        },

        /**
         * @param {number} target
         * @param {number} format
         * @param {number} length
         * @param {number} address
         */
        glProgramStringARB(target, format, length, address){
            if (!enter('glProgramStringARB', [target, format, length, address]))
            {
                return;
            }
            const kind = TARGETS.get(target);
            if (!kind)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (format !== GL.PROGRAM_FORMAT_ASCII_ARB)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (length < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const memory = kernel.memory();
            if (!memory)
            {
                kernel.diverge('glProgramStringARB was called with no way to read the program'
                    + ' text, and the program was not loaded');
                setError(GL.INVALID_OPERATION);
                return;
            }
            // Decoded one byte per character so that the error position the
            // parser reports is the byte offset the query promises.
            const text = new TextDecoder('latin1')
                .decode(memory.read(address >>> 0, length).subarray(0, length));
            const parsed = parseProgram(text);
            if (!('error' in parsed) && parsed.kind !== kind)
            {
                errorString = `the program is a ${parsed.kind} program and the target takes`
                    + ` ${kind} programs`;
                setState(GL.PROGRAM_ERROR_POSITION_ARB, [0]);
                setError(GL.INVALID_OPERATION);
                return;
            }
            if ('error' in parsed)
            {
                errorString = parsed.error.message;
                setState(GL.PROGRAM_ERROR_POSITION_ARB,
                    [Math.min(parsed.error.position, length)]);
                setError(GL.INVALID_OPERATION);
                return;
            }
            const program = boundProgram(target);
            if (!program)
            {
                return;
            }
            errorString = '';
            setState(GL.PROGRAM_ERROR_POSITION_ARB, [-1]);
            program.text = text;
            program.parsed = parsed;
            program.format = format;
            program.version++;
        },

        // --- the parameters ---

        /**
         * @param {number} target
         * @param {number} index
         * @param {readonly number[]} values
         */
        glProgramEnvParameter4fARB(target, index, values){
            if (checkIndex('glProgramEnvParameter4fARB', [target, index, values], index,
                env.get(target)))
            {
                /** @type {Float32Array} */ (env.get(target)).set(values.slice(0, 4), index * 4);
            }
        },

        /**
         * @param {number} target
         * @param {number} index
         * @param {readonly number[]} values
         */
        glProgramLocalParameter4fARB(target, index, values){
            const program = TARGETS.has(target) ? boundProgram(target) : undefined;
            if (checkIndex('glProgramLocalParameter4fARB', [target, index, values], index,
                program?.local))
            {
                /** @type {import('./objects.js').ProgramObject} */ (program).local
                    .set(values.slice(0, 4), index * 4);
            }
        },

        /**
         * @param {number} target
         * @param {number} index
         * @returns {number[] | null}
         */
        glGetProgramEnvParameterfvARB(target, index){
            if (!enter('glGetProgramEnvParameterfvARB', [target, index]))
            {
                return null;
            }
            const file = env.get(target);
            if (!file)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (!(index >= 0) || index * 4 >= file.length)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return [...file.subarray(index * 4, index * 4 + 4)];
        },

        /**
         * @param {number} target
         * @param {number} index
         * @returns {number[] | null}
         */
        glGetProgramLocalParameterfvARB(target, index){
            if (!enter('glGetProgramLocalParameterfvARB', [target, index]))
            {
                return null;
            }
            const program = TARGETS.has(target) ? boundProgram(target) : null;
            if (!program)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (!(index >= 0) || index * 4 >= program.local.length)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return [...program.local.subarray(index * 4, index * 4 + 4)];
        },

        /**
         * @param {number} target
         * @param {number} pname
         * @returns {number[] | null}
         */
        glGetProgramivARB(target, pname){
            if (!enter('glGetProgramivARB', [target, pname]))
            {
                return null;
            }
            const kind = TARGETS.get(target);
            if (!kind)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const program = boundProgram(target);
            const counts = program?.parsed?.counts;
            const vertexLimits = PROGRAM_LIMITS.vertex;
            const fragmentLimits = PROGRAM_LIMITS.fragment;
            const limits = kind === 'vertex' ? vertexLimits : fragmentLimits;
            const zero = [0];
            switch (pname)
            {
                case GL.PROGRAM_LENGTH_ARB:
                    return [program?.text.length ?? 0];
                case GL.PROGRAM_FORMAT_ARB:
                    return [program?.format ?? 0];
                case GL.PROGRAM_BINDING_ARB:
                    return [bindings.get(target) ?? 0];
                case GL.PROGRAM_INSTRUCTIONS_ARB:
                case GL.PROGRAM_NATIVE_INSTRUCTIONS_ARB:
                    return counts ? [counts.instructions] : zero;
                case GL.MAX_PROGRAM_INSTRUCTIONS_ARB:
                    return [limits.instructions];
                case GL.MAX_PROGRAM_NATIVE_INSTRUCTIONS_ARB:
                    return [limits.nativeInstructions];
                case GL.PROGRAM_TEMPORARIES_ARB:
                case GL.PROGRAM_NATIVE_TEMPORARIES_ARB:
                    return counts ? [counts.temporaries] : zero;
                case GL.MAX_PROGRAM_TEMPORARIES_ARB:
                    return [limits.temporaries];
                case GL.MAX_PROGRAM_NATIVE_TEMPORARIES_ARB:
                    return [limits.nativeTemporaries];
                case GL.PROGRAM_PARAMETERS_ARB:
                case GL.PROGRAM_NATIVE_PARAMETERS_ARB:
                    return counts ? [counts.parameters] : zero;
                case GL.MAX_PROGRAM_PARAMETERS_ARB:
                    return [limits.parameters];
                case GL.MAX_PROGRAM_NATIVE_PARAMETERS_ARB:
                    return [limits.nativeParameters];
                case GL.PROGRAM_ATTRIBS_ARB:
                case GL.PROGRAM_NATIVE_ATTRIBS_ARB:
                    return counts ? [counts.attribs] : zero;
                case GL.MAX_PROGRAM_ATTRIBS_ARB:
                    return [limits.attribs];
                case GL.MAX_PROGRAM_NATIVE_ATTRIBS_ARB:
                    return [limits.nativeAttribs];
                case GL.PROGRAM_ADDRESS_REGISTERS_ARB:
                case GL.PROGRAM_NATIVE_ADDRESS_REGISTERS_ARB:
                    return counts ? [counts.addressRegisters] : zero;
                case GL.MAX_PROGRAM_ADDRESS_REGISTERS_ARB:
                    return [kind === 'vertex' ? vertexLimits.addressRegisters : 0];
                case GL.MAX_PROGRAM_NATIVE_ADDRESS_REGISTERS_ARB:
                    return [kind === 'vertex' ? vertexLimits.nativeAddressRegisters : 0];
                case GL.PROGRAM_ALU_INSTRUCTIONS_ARB:
                case GL.PROGRAM_NATIVE_ALU_INSTRUCTIONS_ARB:
                    return counts ? [counts.alu] : zero;
                case GL.MAX_PROGRAM_ALU_INSTRUCTIONS_ARB:
                    return [fragmentLimits.aluInstructions];
                case GL.MAX_PROGRAM_NATIVE_ALU_INSTRUCTIONS_ARB:
                    return [fragmentLimits.nativeAluInstructions];
                case GL.PROGRAM_TEX_INSTRUCTIONS_ARB:
                case GL.PROGRAM_NATIVE_TEX_INSTRUCTIONS_ARB:
                    return counts ? [counts.tex] : zero;
                case GL.MAX_PROGRAM_TEX_INSTRUCTIONS_ARB:
                    return [fragmentLimits.texInstructions];
                case GL.MAX_PROGRAM_NATIVE_TEX_INSTRUCTIONS_ARB:
                    return [fragmentLimits.nativeTexInstructions];
                case GL.PROGRAM_TEX_INDIRECTIONS_ARB:
                case GL.PROGRAM_NATIVE_TEX_INDIRECTIONS_ARB:
                    return counts ? [counts.tex] : zero;
                case GL.MAX_PROGRAM_TEX_INDIRECTIONS_ARB:
                    return [fragmentLimits.texIndirections];
                case GL.MAX_PROGRAM_NATIVE_TEX_INDIRECTIONS_ARB:
                    return [fragmentLimits.nativeTexIndirections];
                case GL.MAX_PROGRAM_LOCAL_PARAMETERS_ARB:
                    return [limits.localParameters];
                case GL.MAX_PROGRAM_ENV_PARAMETERS_ARB:
                    return [limits.envParameters];
                case GL.PROGRAM_UNDER_NATIVE_LIMITS_ARB:
                    // A program that loaded is within the native limits by
                    // construction: the parser refuses one that is not.
                    return [1];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * @param {number} target
         * @param {number} pname
         * @returns {Uint8Array | null} the program string, for the caller to write out
         */
        glGetProgramStringARB(target, pname){
            if (!enter('glGetProgramStringARB', [target, pname]))
            {
                return null;
            }
            if (!TARGETS.has(target))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (pname !== GL.PROGRAM_STRING_ARB)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return new TextEncoder().encode(boundProgram(target)?.text ?? '');
        },

        // --- the generic vertex attributes ---

        /**
         * @param {number} index
         * @param {number} x @param {number} y @param {number} z @param {number} w
         */
        glVertexAttrib4fARB(index, x, y, z, w){
            if (checkAttrib('glVertexAttrib4fARB', [index, x, y, z, w], index))
            {
                attribValues[index] = [x, y, z, w];
            }
        },

        /**
         * @param {number} index
         * @param {number} size
         * @param {number} type
         * @param {number} normalised
         * @param {number} stride
         * @param {number} pointer
         */
        glVertexAttribPointerARB(index, size, type, normalised, stride, pointer){
            if (!enter('glVertexAttribPointerARB',
                [index, size, type, normalised, stride, pointer]))
            {
                return;
            }
            if (!(index >= 0) || index >= GENERIC_ATTRIBS || size < 1 || size > 4 || stride < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!ATTRIB_TYPES.has(type))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const array = attribArrays[index];
            array.size = size;
            array.type = type;
            array.normalised = normalised ? 1 : 0;
            array.stride = stride;
            array.pointer = pointer;
            array.buffer = record(GL.ARRAY_BUFFER_BINDING).values[0];
        },

        /** @param {number} index */
        glEnableVertexAttribArrayARB(index){
            setAttribEnable('glEnableVertexAttribArrayARB', index, 1);
        },

        /** @param {number} index */
        glDisableVertexAttribArrayARB(index){
            setAttribEnable('glDisableVertexAttribArrayARB', index, 0);
        },

        /**
         * @param {number} index
         * @param {number} pname
         * @returns {number[] | null}
         */
        glGetVertexAttribfvARB(index, pname){
            if (!enter('glGetVertexAttribfvARB', [index, pname]))
            {
                return null;
            }
            if (!(index >= 0) || index >= GENERIC_ATTRIBS)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const array = attribArrays[index];
            switch (pname)
            {
                case GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB:
                    return [array.enabled];
                case GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB:
                    return [array.size];
                case GL.VERTEX_ATTRIB_ARRAY_STRIDE_ARB:
                    return [array.stride];
                case GL.VERTEX_ATTRIB_ARRAY_TYPE_ARB:
                    return [array.type];
                case GL.VERTEX_ATTRIB_ARRAY_NORMALIZED_ARB:
                    return [array.normalised];
                case GL.CURRENT_VERTEX_ATTRIB_ARB:
                    return [...attribValues[index]];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * @param {number} index
         * @param {number} pname
         * @returns {number[] | null} the pointer, as an address
         */
        glGetVertexAttribPointervARB(index, pname){
            if (!enter('glGetVertexAttribPointervARB', [index, pname]))
            {
                return null;
            }
            if (!(index >= 0) || index >= GENERIC_ATTRIBS)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            if (pname !== GL.VERTEX_ATTRIB_ARRAY_POINTER_ARB)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return [attribArrays[index].pointer];
        },
    });

    /**
     * @param {string} call
     * @param {number} index
     * @param {number} value
     */
    function setAttribEnable(call, index, value){
        if (!enter(call, [index]))
        {
            return;
        }
        if (!(index >= 0) || index >= GENERIC_ATTRIBS)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        attribArrays[index].enabled = value;
    }
}

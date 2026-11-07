/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL ES 2.0's calls on the desktop (OpenGL 4.1, GL_ARB_ES2_compatibility).
 *
 * - **Shaders are compiled from source only**: no binary format is known,
 *   so glShaderBinary refuses every one, and the compiler is never released.
 * - **Every precision is the desktop's**: a float of any qualifier holds
 *   IEEE single precision (range 2^127 either way, 23 bits of mantissa), an
 *   integer 32 bits, as section 7.13 of 4.1 has a desktop answer.
 * - glDepthRangef and glClearDepthf are glDepthRange's and glClearDepth's,
 *   which the exports call with the float widened.
 */

import { GL } from './constants.js';

/** The calls of this file a display list does not record: all of them (section 5.5). */
export const ES2_CALLS_NOT_COMPILED = Object.freeze([
    'glReleaseShaderCompiler', 'glShaderBinary', 'glGetShaderPrecisionFormat',
]);

/**
 * What a precision qualifier holds: the range's two log2 bounds and the bits
 * of precision.
 *
 * @type {Map<number, { range: [number, number], precision: number }>}
 */
const PRECISIONS = new Map([
    ...[GL.LOW_FLOAT, GL.MEDIUM_FLOAT, GL.HIGH_FLOAT]
        .map(type=>/** @type {[number, { range: [number, number], precision: number }]} */ (
            [type, { range: [127, 127], precision: 23 }])),
    ...[GL.LOW_INT, GL.MEDIUM_INT, GL.HIGH_INT]
        .map(type=>/** @type {[number, { range: [number, number], precision: number }]} */ (
            [type, { range: [31, 30], precision: 0 }])),
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installEs2Calls(context, kernel){
    const { enter, setError } = kernel;

    Object.assign(context, {
        glReleaseShaderCompiler(){
            enter('glReleaseShaderCompiler', []);
        },

        /**
         * @param {readonly number[]} shaders @param {number} format
         * @param {number} length  the binary's bytes
         */
        glShaderBinary(shaders, format, length){
            if (!enter('glShaderBinary', [shaders, format, length]))
            {
                return;
            }
            // No format is known (GL_NUM_SHADER_BINARY_FORMATS is zero).
            setError(length < 0 ? GL.INVALID_VALUE : GL.INVALID_ENUM);
        },

        /**
         * @param {number} shaderType @param {number} precisionType
         * @returns {{ range: [number, number], precision: number } | null}
         */
        glGetShaderPrecisionFormat(shaderType, precisionType){
            if (!enter('glGetShaderPrecisionFormat', [shaderType, precisionType]))
            {
                return null;
            }
            const answer = PRECISIONS.get(precisionType);
            if (!answer || (shaderType !== GL.VERTEX_SHADER && shaderType !== GL.FRAGMENT_SHADER))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return { range: [...answer.range], precision: answer.precision };
        },
    });
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shaders from SPIR-V modules (OpenGL 4.6 sections 7.2 and 7.2.1,
 * GL_ARB_gl_spirv).
 *
 * - **glShaderBinary takes SHADER_BINARY_FORMAT_SPIR_V**: the module is read
 *   at the call (a word stream that is not one is INVALID_VALUE, section
 *   7.2's "data does not match the format") and associated with each shader
 *   named, which loses its source and its compile; any other format is the
 *   ES 2.0 calls' to refuse.
 * - **glSpecializeShader is the compile**: it chooses the entry point of the
 *   shader's stage and the specialization constants' values, and writes
 *   that entry point as GLSL 4.60 (`spirv-glsl.js`), which the GLSL front
 *   end compiles as any shader's source. A module this does not take fails
 *   the specialization, its reason the shader's log; a lifted shader the
 *   front end refuses is a fault here, said in the log the same way.
 * - **A program is SPIR-V whole or not at all**: glLinkProgram's check is
 *   `context-glsl.js`'s, which asks `spirvBinary` of each shader.
 * - **No SPIR-V extension is taken**: GL_NUM_SPIR_V_EXTENSIONS is zero and
 *   glGetStringi(GL_SPIR_V_EXTENSIONS, i) has no index to answer.
 */

import { GL } from './constants.js';
import { readSpirv } from './spirv-module.js';
import { EXECUTION_MODELS, liftSpirv, specIdsOf } from './spirv-glsl.js';
import { compileShader } from './context-glsl.js';
import { TESS } from './context-tessellation.js';

/** The calls of this file a display list does not record (section 5.5). */
export const SPIRV_CALLS_NOT_COMPILED = Object.freeze(['glSpecializeShader']);

/** A shader type's stage, as `spirv-glsl.js` names it. @type {Map<number, keyof typeof EXECUTION_MODELS>} */
const STAGES = new Map([[GL.VERTEX_SHADER, 'vertex'], [GL.FRAGMENT_SHADER, 'fragment'],
    [GL.GEOMETRY_SHADER, 'geometry'], [TESS.TESS_CONTROL_SHADER, 'tessControl'],
    [TESS.TESS_EVALUATION_SHADER, 'tessEvaluation'], [GL.COMPUTE_SHADER, 'compute']]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installSpirvCalls(context, kernel){
    const { enter, setError } = kernel;
    const otherBinary = context.glShaderBinary;

    Object.assign(context, {
        /**
         * @param {readonly number[]} shaders @param {number} format
         * @param {number} length  the binary's bytes
         * @param {Uint8Array | null} [binary]  the bytes, for a format that reads them
         */
        glShaderBinary(shaders, format, length, binary = null){
            if (format !== GL.SHADER_BINARY_FORMAT_SPIR_V)
            {
                otherBinary.call(context, shaders, format, length);
                return;
            }
            if (!enter('glShaderBinary', [shaders, format, length]))
            {
                return;
            }
            if (length < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            /** @type {any[]} */
            const objects = [];
            for (const name of shaders)
            {
                const shader = kernel.side.shaderObject(name);
                if (!shader)
                {
                    return;
                }
                objects.push(shader);
            }
            const read = readSpirv(binary ?? new Uint8Array(0));
            if ('error' in read)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            for (const shader of objects)
            {
                shader.spirv = read.module;
                shader.specialized = false;
                shader.sources = null;
                shader.compiled = false;
                shader.log = '';
                shader.unit = null;
            }
        },

        /**
         * @param {number} name @param {string} entryPoint
         * @param {readonly number[]} indices  the SpecIds to set
         * @param {readonly number[]} values  each one's 32 bits
         */
        glSpecializeShader(name, entryPoint, indices, values){
            if (!enter('glSpecializeShader', [name, entryPoint, indices, values]))
            {
                return;
            }
            const shader = kernel.side.shaderObject(name);
            if (!shader)
            {
                return;
            }
            const module = /** @type {import('./spirv-module.js').SpirvModule | null | undefined} */ (
                shader.spirv);
            if (!module || shader.specialized)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const stage = /** @type {keyof typeof EXECUTION_MODELS} */ (STAGES.get(shader.type));
            const named = module.entryPoints.filter(e=>e.name === entryPoint);
            if (named.length === 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!named.some(e=>e.model === EXECUTION_MODELS[stage]))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const known = specIdsOf(module);
            if (indices.some(index=>!known.has(index >>> 0)))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            /** @type {Map<number, number>} */
            const constants = new Map(indices.map((index, k)=>[index >>> 0, values[k] >>> 0]));
            const lifted = liftSpirv(module, { entry: entryPoint, stage, constants });
            if (!lifted.ok)
            {
                shader.compiled = false;
                shader.log = lifted.log;
                shader.unit = null;
                return;
            }
            const result = compileShader([lifted.source], stage);
            if (!result.ok)
            {
                // The module was taken and its GLSL was not: this side's fault, said.
                shader.compiled = false;
                shader.log = `ERROR: SPIR-V: the shader written from the module did not compile:\n`
                    + `${result.log}`;
                shader.unit = null;
                return;
            }
            shader.compiled = true;
            shader.specialized = true;
            shader.log = '';
            shader.unit = result.unit;
        },
    });
}

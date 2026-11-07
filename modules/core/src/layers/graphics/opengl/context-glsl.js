/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL 2.0's shader and program objects (section 2.15 of the 2.1
 * specification): compiling GLSL, linking it, the program in use, and its
 * uniforms and attributes.
 *
 * The object rules, as the specification states them:
 *
 * - **Shaders and programs share one namespace**, in the share group, and a
 *   name of one is not a name of the other: passing a shader where a program
 *   is wanted is GL_INVALID_OPERATION, passing a name that is neither is
 *   GL_INVALID_VALUE.
 * - **Deleting is deferred while something holds the object.** A shader
 *   attached to a program, or a program in use by a context, is flagged
 *   (DELETE_STATUS) and goes when the last holder lets it go.
 * - **A program draws with what its last successful link made.** Linking
 *   again replaces the uniforms with their defaults; a link that fails
 *   leaves the program unusable for glUseProgram, and a context already
 *   using it goes on drawing with the executable it had.
 * - **glUniform* writes the program in use**, typed: a float form into an
 *   int, a size other than the uniform's, a count past one into a non-array,
 *   are GL_INVALID_OPERATION; location -1 is quietly nothing.
 *
 * A shader's source compiles once per text: the parse and the check are
 * kept by the text, so a program that compiles the same shader for every
 * material, and the second context of a recording that replays the first's
 * calls, pay for it once.
 */

import { GL } from './constants.js';
import { compileFront } from './glsl-front.js';
import { GLSL_EXTENSIONS } from './glsl-versions.js';
import { GLSL_CONSTANTS } from './glsl-library.js';
import { BLOCK_LIMITS, FEEDBACK_LIMITS, linkProgram } from './glsl-link.js';
import { BUILTIN_VARIABLES, GLSL_LIMITS } from './glsl-builtins.js';
import { componentsOf } from './glsl-types.js';

/**
 * The GLSL versions a shader may name: those the WGSL emitter writes whole
 * (`glsl-wgsl.js`). A later one fails to compile with the specification's
 * message for a version the implementation does not support.
 */
export const EMITTED_VERSIONS = Object.freeze([110, 120, 130, 140, 150, 330]);

/**
 * The built-in constants of 1.30 and later as this implementation answers
 * them: the limits 1.10 and 1.20 already report (`GLSL_LIMITS`) and the
 * specification's minimums for the rest, so that a shader sizing an array by
 * gl_MaxDrawBuffers and a program asking GL_MAX_DRAW_BUFFERS agree.
 */
export const CONTEXT_CONSTANTS = Object.freeze({
    ...GLSL_CONSTANTS,
    gl_MaxVertexAttribs: GLSL_LIMITS.vertexAttribs,
    gl_MaxVertexUniformComponents: GLSL_LIMITS.vertexUniformComponents,
    gl_MaxFragmentUniformComponents: GLSL_LIMITS.fragmentUniformComponents,
    gl_MaxVaryingFloats: GLSL_LIMITS.varyingFloats,
    gl_MaxVaryingComponents: GLSL_LIMITS.varyingFloats,
    gl_MaxVertexTextureImageUnits: GLSL_LIMITS.vertexTextureImageUnits,
    gl_MaxCombinedTextureImageUnits: GLSL_LIMITS.combinedTextureImageUnits,
    gl_MaxTextureImageUnits: GLSL_LIMITS.textureImageUnits,
    gl_MaxGeometryTextureImageUnits: GLSL_LIMITS.textureImageUnits,
    gl_MaxDrawBuffers: GLSL_LIMITS.drawBuffers,
    gl_MaxTextureUnits: GLSL_LIMITS.textureUnits,
    gl_MaxTextureCoords: GLSL_LIMITS.textureCoords,
    gl_MaxClipPlanes: GLSL_LIMITS.clipPlanes,
    gl_MaxLights: GLSL_LIMITS.lights,
});

// GL_ARB_shader_objects' own enums; its other queries are the 2.0 ones.
const PROGRAM_OBJECT_ARB = 0x8b40;
const SHADER_OBJECT_ARB = 0x8b48;
const OBJECT_TYPE_ARB = 0x8b4e;
const OBJECT_SUBTYPE_ARB = 0x8b4f;
/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-check.js').ShaderUnit} ShaderUnit
 * @typedef {import('./glsl-link.js').LinkedProgram} LinkedProgram
 */

/**
 * @typedef {Object} ShaderObject
 * @property {'shader'} kind
 * @property {number} name
 * @property {number} type  GL_VERTEX_SHADER or GL_FRAGMENT_SHADER
 * @property {string[] | null} sources
 * @property {boolean} compiled
 * @property {string} log
 * @property {ShaderUnit | null} unit
 * @property {boolean} deleted
 * @property {number} attachments  how many programs hold it
 */

/** @typedef {import('./glsl-link.js').Executable} Executable */

/**
 * @typedef {Object} ProgramObject
 * @property {'program'} kind
 * @property {number} name
 * @property {ShaderObject[]} shaders  attached, in order
 * @property {boolean} deleted
 * @property {boolean} linked  LINK_STATUS
 * @property {boolean} validated
 * @property {string} log
 * @property {Map<string, number>} bindings  glBindAttribLocation's, for the next link
 * @property {Map<string, { location: number, index: number }>} fragData
 *     glBindFragDataLocation's, for the next link
 * @property {{ names: string[], mode: 'interleaved' | 'separate' } | null} feedback
 *     glTransformFeedbackVaryings', for the next link
 * @property {Executable | null} executable
 * @property {number} users  the contexts it is current in
 * @property {boolean} [retrievable]  PROGRAM_BINARY_RETRIEVABLE_HINT (4.1)
 * @property {boolean} [separable]  PROGRAM_SEPARABLE (4.1)
 */

/** The shader types. @type {Map<number, 'vertex' | 'geometry' | 'fragment'>} */
const SHADER_TYPES = new Map([[GL.VERTEX_SHADER, 'vertex'], [GL.GEOMETRY_SHADER, 'geometry'],
    [GL.FRAGMENT_SHADER, 'fragment']]);

/** What GEOMETRY_INPUT_TYPE and GEOMETRY_OUTPUT_TYPE answer, by the layout's word. */
const GEOMETRY_PRIMITIVES = Object.freeze(/** @type {Record<string, number>} */ ({
    points: GL.POINTS, lines: GL.LINES, lines_adjacency: GL.LINES_ADJACENCY,
    triangles: GL.TRIANGLES, triangles_adjacency: GL.TRIANGLES_ADJACENCY,
    line_strip: GL.LINE_STRIP, triangle_strip: GL.TRIANGLE_STRIP,
}));

let executables = 0;

/**
 * Compiled shaders by their text, the most recent first to be kept.
 *
 * @type {Map<string, { ok: boolean, log: string, unit: ShaderUnit | null }>}
 */
const COMPILED = new Map();
const COMPILED_KEPT = 256;
/** The extensions a shader's #extension may enable: what the front end has of each. */
const SHADER_EXTENSIONS = Object.keys(GLSL_EXTENSIONS);

/**
 * @param {readonly string[]} sources @param {'vertex' | 'geometry' | 'fragment'} stage
 * @returns {{ ok: boolean, log: string, unit: ShaderUnit | null }}
 */
export function compileShader(sources, stage){
    const key = `${stage}\u0000${sources.join('\u0001')}`;
    const known = COMPILED.get(key);
    if (known)
    {
        COMPILED.delete(key);
        COMPILED.set(key, known);
        return known;
    }
    const result = compileFront(sources, stage, { versions: EMITTED_VERSIONS,
        constants: CONTEXT_CONSTANTS, extensions: SHADER_EXTENSIONS });
    COMPILED.set(key, result);
    if (COMPILED.size > COMPILED_KEPT)
    {
        COMPILED.delete(/** @type {string} */ (COMPILED.keys().next().value));
    }
    return result;
}

/**
 * The GL type enumerant of a GLSL type, as glGetActiveUniform and
 * glGetActiveAttrib answer it.
 *
 * @param {GlslType} type
 * @returns {number}
 */
export function glTypeOf(type){
    switch (type.kind)
    {
        case 'scalar':
            return type.base === 'float' ? GL.FLOAT : type.base === 'int' ? GL.INT
                : type.base === 'uint' ? GL.UNSIGNED_INT : GL.BOOL;
        case 'vector': {
            const at = type.size - 2;
            return type.base === 'float' ? GL.FLOAT_VEC2 + at
                : type.base === 'int' ? GL.INT_VEC2 + at
                    : type.base === 'uint' ? GL.UNSIGNED_INT_VEC2 + at : GL.BOOL_VEC2 + at;
        }
        case 'matrix':
            if (type.cols === type.rows)
            {
                return GL.FLOAT_MAT2 + type.cols - 2;
            }
            return /** @type {Record<string, number>} */ ({
                '2x3': GL.FLOAT_MAT2x3, '2x4': GL.FLOAT_MAT2x4, '3x2': GL.FLOAT_MAT3x2,
                '3x4': GL.FLOAT_MAT3x4, '4x2': GL.FLOAT_MAT4x2, '4x3': GL.FLOAT_MAT4x3,
            })[`${type.cols}x${type.rows}`];
        case 'sampler':
            return SAMPLER_TYPES[`${type.sampled === 'float' ? '' : type.sampled}${type.dim}`
                + `${type.ms ? 'MS' : ''}${type.array ? 'Array' : ''}`
                + `${type.shadow ? 'Shadow' : ''}`] ?? 0;
        default:
            return 0;
    }
}

/** The GL type of each shape of sampler, by its GLSL name past `sampler`. */
const SAMPLER_TYPES = /** @type {Record<string, number>} */ ({
    '1D': GL.SAMPLER_1D, '2D': GL.SAMPLER_2D, '3D': GL.SAMPLER_3D, Cube: GL.SAMPLER_CUBE,
    '1DShadow': GL.SAMPLER_1D_SHADOW, '2DShadow': GL.SAMPLER_2D_SHADOW,
    '1DArray': GL.SAMPLER_1D_ARRAY, '2DArray': GL.SAMPLER_2D_ARRAY,
    '1DArrayShadow': GL.SAMPLER_1D_ARRAY_SHADOW, '2DArrayShadow': GL.SAMPLER_2D_ARRAY_SHADOW,
    CubeShadow: GL.SAMPLER_CUBE_SHADOW, '2DRect': GL.SAMPLER_2D_RECT,
    '2DRectShadow': GL.SAMPLER_2D_RECT_SHADOW, Buffer: GL.SAMPLER_BUFFER,
    '2DMS': GL.SAMPLER_2D_MULTISAMPLE, '2DMSArray': GL.SAMPLER_2D_MULTISAMPLE_ARRAY,
    int1D: GL.INT_SAMPLER_1D, int2D: GL.INT_SAMPLER_2D, int3D: GL.INT_SAMPLER_3D,
    intCube: GL.INT_SAMPLER_CUBE, int2DRect: GL.INT_SAMPLER_2D_RECT,
    int1DArray: GL.INT_SAMPLER_1D_ARRAY, int2DArray: GL.INT_SAMPLER_2D_ARRAY,
    intBuffer: GL.INT_SAMPLER_BUFFER, int2DMS: GL.INT_SAMPLER_2D_MULTISAMPLE,
    int2DMSArray: GL.INT_SAMPLER_2D_MULTISAMPLE_ARRAY,
    uint1D: GL.UNSIGNED_INT_SAMPLER_1D, uint2D: GL.UNSIGNED_INT_SAMPLER_2D,
    uint3D: GL.UNSIGNED_INT_SAMPLER_3D, uintCube: GL.UNSIGNED_INT_SAMPLER_CUBE,
    uint2DRect: GL.UNSIGNED_INT_SAMPLER_2D_RECT, uint1DArray: GL.UNSIGNED_INT_SAMPLER_1D_ARRAY,
    uint2DArray: GL.UNSIGNED_INT_SAMPLER_2D_ARRAY, uintBuffer: GL.UNSIGNED_INT_SAMPLER_BUFFER,
    uint2DMS: GL.UNSIGNED_INT_SAMPLER_2D_MULTISAMPLE,
    uint2DMSArray: GL.UNSIGNED_INT_SAMPLER_2D_MULTISAMPLE_ARRAY,
});

/**
 * The uniforms a program lists (section 2.11.4 of 3.1): its default block's
 * leaves, then its named blocks' variables.
 *
 * @param {LinkedProgram} linked
 * @returns {{ name: string, size: number, type: GlslType, block: number, offset: number,
 *     arrayStride: number, matrixStride: number, rowMajor: boolean }[]}
 */
function activeUniforms(linked){
    return [
        ...linked.uniforms.map(u=>({ name: u.name, size: u.size, type: u.type, block: -1,
            offset: -1, arrayStride: -1, matrixStride: -1, rowMajor: false })),
        ...(linked.blockUniforms ?? []),
    ];
}

/**
 * A name glGetUniformLocation is given: the leaf's path and an element.
 *
 * @param {string} name
 * @returns {{ base: string, element: number, indexed: boolean } | null}
 */
function parseUniformName(name){
    const match = /^(.*?)(?:\[(\d+)\])?$/.exec(name);
    if (!match || match[1] === '')
    {
        return null;
    }
    return { base: match[1], element: match[2] === undefined ? 0 : Number(match[2]),
        indexed: match[2] !== undefined };
}

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installShaderCalls(context, kernel){
    const { enter, setError } = kernel;

    /** The program in use: its name, and the object, which outlives its name. */
    let currentName = 0;
    /** @type {ProgramObject | null} */
    let currentProgram = null;

    const namespace = ()=>kernel.shareGroup().glsl;

    /**
     * The object a name names, or the error it deserves: GL_INVALID_VALUE
     * for a name that is not one, GL_INVALID_OPERATION for one of the other
     * kind.
     *
     * @template {'shader' | 'program'} K
     * @param {number} name @param {K} kind
     * @returns {(K extends 'shader' ? ShaderObject : ProgramObject) | null}
     */
    const objectOf = (name, kind)=>{
        const object = namespace().objects.get(name);
        if (!object)
        {
            setError(GL.INVALID_VALUE);
            return null;
        }
        if (object.kind !== kind)
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        return object;
    };

    /** @param {ShaderObject} shader */
    const releaseShader = shader=>{
        if (shader.deleted && shader.attachments === 0)
        {
            namespace().remove(shader.name);
        }
    };

    /** @param {ProgramObject} program */
    const releaseProgram = program=>{
        if (!program.deleted || program.users > 0)
        {
            return;
        }
        for (const shader of program.shaders)
        {
            shader.attachments--;
            releaseShader(shader);
        }
        program.shaders = [];
        namespace().remove(program.name);
    };

    /** @param {ProgramObject | null} program */
    const makeCurrent = program=>{
        const previous = currentProgram;
        currentProgram = program;
        currentName = program ? program.name : 0;
        if (program)
        {
            program.users++;
        }
        if (previous)
        {
            previous.users--;
            releaseProgram(previous);
        }
        kernel.setState(GL.CURRENT_PROGRAM, [currentName]);
    };

    /**
     * The executable a uniform call writes, and the element a location
     * names, or null with the error set.
     *
     * @param {string} call @param {number} location
     * @param {ProgramObject | null} [program]  glProgramUniform's (4.1), the current
     *     one's otherwise, whose executable stays in use through a failed relink
     * @returns {{ executable: Executable,
     *     leaf: import('./glsl-link.js').UniformLeaf, element: number } | null}
     */
    const uniformAt = (call, location, program)=>{
        const executable = program === undefined ? currentProgram?.executable
            : program?.linked ? program.executable : null;
        if (!executable)
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        if (location === -1)
        {
            return null;
        }
        const found = executable.linked.locations.get(location);
        if (!found)
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        return { executable, ...found };
    };

    /**
     * Writes `count` elements of `components` values from `values` into a
     * uniform, from the location's element on, checking the call's type and
     * size against the uniform's.
     *
     * @param {string} call  for a message
     * @param {number} location
     * @param {number} count
     * @param {ArrayLike<number>} values
     * @param {'f' | 'i' | 'u'} kind
     * @param {number} components  per element, or a matrix's columns times rows
     * @param {{ cols: number, rows: number, transpose: boolean } | null} matrix
     * @param {ProgramObject} [program]  glProgramUniform's (4.1), the current one's otherwise
     */
    const writeUniform = (call, location, count, values, kind, components, matrix, program)=>{
        if (count < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const target = uniformAt(call, location, program);
        if (!target)
        {
            return;
        }
        const { executable, leaf, element } = target;
        const type = leaf.type;
        if (type.kind === 'sampler')
        {
            if (kind !== 'i' || components !== 1 || matrix)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
        }
        else if (matrix)
        {
            if (type.kind !== 'matrix' || type.cols !== matrix.cols || type.rows !== matrix.rows)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
        }
        else
        {
            const base = type.kind === 'scalar' || type.kind === 'vector' ? type.base : null;
            if (base === null || componentsOf(type) !== components
                || (base === 'float' && kind !== 'f') || (base === 'int' && kind !== 'i')
                || (base === 'uint' && kind !== 'u'))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
        }
        if (count > 1 && leaf.size === 1)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (type.kind === 'sampler')
        {
            for (let k = 0; k < count; k++)
            {
                const unit = values[k];
                if (unit < 0 || unit >= GLSL_LIMITS.combinedTextureImageUnits)
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
            }
        }
        const elements = Math.min(count, leaf.size - element);
        const stored = type.kind === 'scalar' || type.kind === 'vector' ? type.base
            : type.kind === 'sampler' ? 'int' : 'float';
        const { floats, ints } = executable;
        let changed = false;
        for (let e = 0; e < elements; e++)
        {
            const at = leaf.offset + (element + e) * leaf.words;
            for (let k = 0; k < leaf.words; k++)
            {
                let source = e * components + k;
                if (matrix && matrix.transpose)
                {
                    // Given row by row: the k-th stored value (column c, row r)
                    // is the given value at row r, column c.
                    const c = Math.floor(k / matrix.rows);
                    const r = k % matrix.rows;
                    source = e * components + r * matrix.cols + c;
                }
                const value = values[source];
                if (stored === 'float')
                {
                    const next = Math.fround(value);
                    if (floats[at + k] !== next && !(Number.isNaN(next)
                        && Number.isNaN(floats[at + k])))
                    {
                        floats[at + k] = next;
                        changed = true;
                    }
                }
                else
                {
                    // A bool is set false by 0 and 0.0, true by anything else.
                    const next = stored === 'bool' ? (value !== 0 ? 1 : 0) : value | 0;
                    if (ints[at + k] !== next)
                    {
                        ints[at + k] = next;
                        changed = true;
                    }
                }
            }
        }
        if (changed)
        {
            executable.version++;
        }
    };

    /**
     * A program's linked block of an index, or null with the error set:
     * GL_INVALID_VALUE for an index past its blocks.
     *
     * @param {number} programName @param {number} index
     * @returns {{ linked: LinkedProgram, executable: Executable } | null}
     */
    const blockOf = (programName, index)=>{
        const program = objectOf(programName, 'program');
        if (!program)
        {
            return null;
        }
        const executable = program.executable;
        if (!executable || index < 0 || index >= executable.linked.blocks.length)
        {
            setError(GL.INVALID_VALUE);
            return null;
        }
        return { linked: executable.linked, executable };
    };

    Object.assign(kernel.side, {
        /**
         * The program in use, for a draw: what it runs and the uniform values
         * it runs with, or null for the fixed pipeline.
         *
         * @returns {Executable | null}
         */
        glslExecutable: ()=>currentProgram?.executable ?? null,
    });

    Object.assign(context, {
        // --- shader objects ---

        /** @param {number} type @returns {number} */
        glCreateShader(type){
            if (!enter('glCreateShader', [type]))
            {
                return 0;
            }
            if (!SHADER_TYPES.has(type))
            {
                setError(GL.INVALID_ENUM);
                return 0;
            }
            const [name] = namespace().reserve(1);
            /** @type {ShaderObject} */
            const shader = { kind: 'shader', name, type, sources: null, compiled: false, log: '',
                unit: null, deleted: false, attachments: 0 };
            namespace().define(name, shader);
            kernel.shareGroup().used = true;
            return name;
        },

        /** @param {number} name @param {readonly string[] | null} sources  null for a count below zero */
        glShaderSource(name, sources){
            if (!enter('glShaderSource', [name, sources]))
            {
                return;
            }
            if (!sources)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const shader = objectOf(name, 'shader');
            if (shader)
            {
                shader.sources = [...sources];
            }
        },

        /** @param {number} name */
        glCompileShader(name){
            if (!enter('glCompileShader', [name]))
            {
                return;
            }
            const shader = objectOf(name, 'shader');
            if (!shader)
            {
                return;
            }
            const stage = /** @type {'vertex' | 'geometry' | 'fragment'} */ (
                SHADER_TYPES.get(shader.type));
            const result = compileShader(shader.sources ?? [], stage);
            shader.compiled = result.ok;
            shader.log = result.log;
            shader.unit = result.unit;
        },

        /** @param {number} name */
        glDeleteShader(name){
            if (!enter('glDeleteShader', [name]) || name === 0)
            {
                return;
            }
            const shader = objectOf(name, 'shader');
            if (shader)
            {
                shader.deleted = true;
                releaseShader(shader);
            }
        },

        /** @param {number} name @returns {number} */
        glIsShader(name){
            if (!enter('glIsShader', [name]))
            {
                return GL.FALSE;
            }
            return namespace().objects.get(name)?.kind === 'shader' ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} name @param {number} pname @returns {number[] | null} */
        glGetShaderiv(name, pname){
            if (!enter('glGetShaderiv', [name, pname]))
            {
                return null;
            }
            const shader = objectOf(name, 'shader');
            if (!shader)
            {
                return null;
            }
            switch (pname)
            {
                case GL.SHADER_TYPE:
                    return [shader.type];
                case GL.DELETE_STATUS:
                    return [shader.deleted ? 1 : 0];
                case GL.COMPILE_STATUS:
                    return [shader.compiled ? 1 : 0];
                case GL.INFO_LOG_LENGTH:
                    return [shader.log.length > 0 ? shader.log.length + 1 : 0];
                case GL.SHADER_SOURCE_LENGTH: {
                    const length = shader.sources ? shader.sources.join('').length : 0;
                    return [length > 0 ? length + 1 : 0];
                }
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /** @param {number} name @returns {string | null} */
        glGetShaderInfoLog(name){
            if (!enter('glGetShaderInfoLog', [name]))
            {
                return null;
            }
            return objectOf(name, 'shader')?.log ?? null;
        },

        /** @param {number} name @returns {string | null} */
        glGetShaderSource(name){
            if (!enter('glGetShaderSource', [name]))
            {
                return null;
            }
            const shader = objectOf(name, 'shader');
            return shader ? (shader.sources ?? []).join('') : null;
        },

        // --- program objects ---

        /** @returns {number} */
        glCreateProgram(){
            if (!enter('glCreateProgram', []))
            {
                return 0;
            }
            const [name] = namespace().reserve(1);
            /** @type {ProgramObject} */
            const program = { kind: 'program', name, shaders: [], deleted: false, linked: false,
                validated: false, log: '', bindings: new Map(), fragData: new Map(),
                feedback: null, executable: null, users: 0 };
            namespace().define(name, program);
            kernel.shareGroup().used = true;
            return name;
        },

        /** @param {number} programName @param {number} shaderName */
        glAttachShader(programName, shaderName){
            if (!enter('glAttachShader', [programName, shaderName]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            const shader = program && objectOf(shaderName, 'shader');
            if (!program || !shader)
            {
                return;
            }
            if (program.shaders.includes(shader))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            program.shaders.push(shader);
            shader.attachments++;
        },

        /** @param {number} programName @param {number} shaderName */
        glDetachShader(programName, shaderName){
            if (!enter('glDetachShader', [programName, shaderName]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            const shader = program && objectOf(shaderName, 'shader');
            if (!program || !shader)
            {
                return;
            }
            const at = program.shaders.indexOf(shader);
            if (at < 0)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            program.shaders.splice(at, 1);
            shader.attachments--;
            releaseShader(shader);
        },

        /** @param {number} programName @param {number} index @param {string} name */
        glBindAttribLocation(programName, index, name){
            if (!enter('glBindAttribLocation', [programName, index, name]))
            {
                return;
            }
            if (index < 0 || index >= GLSL_LIMITS.vertexAttribs)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            if (name.startsWith('gl_'))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            program.bindings.set(name, index);
        },

        /** @param {number} programName */
        glLinkProgram(programName){
            if (!enter('glLinkProgram', [programName]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            if (kernel.side.feedbackActive?.() && program === currentProgram)
            {
                // Transform feedback is capturing what it runs (section 2.15).
                setError(GL.INVALID_OPERATION);
                return;
            }
            program.validated = false;
            const notCompiled = program.shaders.filter(shader=>!shader.compiled);
            if (notCompiled.length > 0)
            {
                program.linked = false;
                program.log = `${notCompiled.map(shader=>`ERROR: shader ${shader.name} is`
                    + ' not compiled').join('\n')}\n`;
                return;
            }
            /** @param {number} type */
            const units = type=>program.shaders.filter(shader=>shader.type === type)
                .map(shader=>/** @type {ShaderUnit} */ (shader.unit));
            const result = linkProgram({
                vertex: units(GL.VERTEX_SHADER),
                geometry: units(GL.GEOMETRY_SHADER),
                fragment: units(GL.FRAGMENT_SHADER),
                feedback: program.feedback ?? undefined,
                attribBindings: program.bindings,
                fragDataBindings: program.fragData,
            });
            program.linked = result.ok;
            program.log = result.log;
            if (!result.ok)
            {
                return;
            }
            const store = result.program.defaults.slice(0);
            program.executable = {
                id: ++executables,
                linked: result.program,
                store,
                floats: new Float32Array(store),
                ints: new Int32Array(store),
                version: 0,
                blockBindings: Int32Array.from(result.program.blocks, block=>block.binding),
            };
        },

        /** @param {number} programName */
        glUseProgram(programName){
            if (!enter('glUseProgram', [programName]))
            {
                return;
            }
            if (kernel.side.feedbackActive?.())
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (programName === 0)
            {
                makeCurrent(null);
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            if (!program.linked)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (program !== currentProgram)
            {
                makeCurrent(program);
            }
        },

        /** @param {number} programName */
        glValidateProgram(programName){
            if (!enter('glValidateProgram', [programName]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            const executable = program.executable;
            if (!program.linked || !executable)
            {
                program.validated = false;
                program.log = 'ERROR: the program is not linked\n';
                return;
            }
            // Two samplers of different types on one unit is the one thing
            // the state can make invalid (section 2.15.4).
            /** @type {Map<number, string>} */
            const units = new Map();
            let valid = true;
            for (const sampler of executable.linked.samplers)
            {
                const unit = executable.ints[sampler.leaf.offset + sampler.element];
                const kind = `${sampler.dim}${sampler.shadow ? 's' : ''}`;
                if (units.has(unit) && units.get(unit) !== kind)
                {
                    valid = false;
                }
                units.set(unit, kind);
            }
            program.validated = valid;
            program.log = valid ? '' : 'ERROR: two samplers of different types use one'
                + ' texture unit\n';
        },

        /** @param {number} programName */
        glDeleteProgram(programName){
            if (!enter('glDeleteProgram', [programName]) || programName === 0)
            {
                return;
            }
            const program = objectOf(programName, 'program');
            if (program)
            {
                program.deleted = true;
                releaseProgram(program);
            }
        },

        /** @param {number} name @returns {number} */
        glIsProgram(name){
            if (!enter('glIsProgram', [name]))
            {
                return GL.FALSE;
            }
            return namespace().objects.get(name)?.kind === 'program' ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} programName @param {number} pname @returns {number[] | null} */
        glGetProgramiv(programName, pname){
            if (!enter('glGetProgramiv', [programName, pname]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const linked = program.executable?.linked;
            switch (pname)
            {
                case GL.DELETE_STATUS:
                    return [program.deleted ? 1 : 0];
                case GL.LINK_STATUS:
                    return [program.linked ? 1 : 0];
                case GL.VALIDATE_STATUS:
                    return [program.validated ? 1 : 0];
                case GL.INFO_LOG_LENGTH:
                    return [program.log.length > 0 ? program.log.length + 1 : 0];
                case GL.ATTACHED_SHADERS:
                    return [program.shaders.length];
                case GL.ACTIVE_ATTRIBUTES:
                    return [linked ? activeAttributes(linked).length : 0];
                case GL.ACTIVE_ATTRIBUTE_MAX_LENGTH:
                    return [linked ? Math.max(0, ...activeAttributes(linked)
                        .map(a=>a.name.length + 1)) : 0];
                case GL.ACTIVE_UNIFORMS:
                    return [linked ? activeUniforms(linked).length : 0];
                case GL.ACTIVE_UNIFORM_MAX_LENGTH:
                    return [linked ? Math.max(0, ...activeUniforms(linked)
                        .map(u=>u.name.length + 1)) : 0];
                case GL.ACTIVE_UNIFORM_BLOCKS:
                    return [linked ? linked.blocks.length : 0];
                case GL.ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH:
                    return [linked ? Math.max(0, ...linked.blocks
                        .map(b=>b.name.length + 1)) : 0];
                case GL.TRANSFORM_FEEDBACK_BUFFER_MODE:
                    return [linked?.feedback?.mode === 'separate' ? GL.SEPARATE_ATTRIBS
                        : GL.INTERLEAVED_ATTRIBS];
                case GL.TRANSFORM_FEEDBACK_VARYINGS:
                    return [linked?.feedback?.varyings.length ?? 0];
                case GL.TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH:
                    return [Math.max(0, ...(linked?.feedback?.varyings ?? [])
                        .map(v=>v.name.length + 1))];
                // A program linked with a geometry shader answers these, any
                // other INVALID_OPERATION (OpenGL 3.2 section 6.1.16).
                case GL.GEOMETRY_VERTICES_OUT:
                case GL.GEOMETRY_INPUT_TYPE:
                case GL.GEOMETRY_OUTPUT_TYPE: {
                    const layout = program.linked ? linked?.geometryLayout : null;
                    if (!layout)
                    {
                        setError(GL.INVALID_OPERATION);
                        return null;
                    }
                    return [pname === GL.GEOMETRY_VERTICES_OUT ? layout.maxVertices
                        : GEOMETRY_PRIMITIVES[pname === GL.GEOMETRY_INPUT_TYPE ? layout.input
                            : layout.output]];
                }
                // OpenGL 4.1's program binaries, of which no format is known.
                case GL.PROGRAM_BINARY_LENGTH:
                    return [0];
                case GL.PROGRAM_BINARY_RETRIEVABLE_HINT:
                    return [program.retrievable ? 1 : 0];
                case GL.PROGRAM_SEPARABLE:
                    return [program.separable ? 1 : 0];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * glProgramParameteri (4.1): the hint that a binary will be asked
         * for, and whether the program may be bound to a pipeline stage.
         *
         * @param {number} programName @param {number} pname @param {number} value
         */
        glProgramParameteri(programName, pname, value){
            if (!enter('glProgramParameteri', [programName, pname, value]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            if (pname !== GL.PROGRAM_BINARY_RETRIEVABLE_HINT && pname !== GL.PROGRAM_SEPARABLE)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (value !== GL.TRUE && value !== GL.FALSE)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            program[pname === GL.PROGRAM_SEPARABLE ? 'separable' : 'retrievable'] =
                value === GL.TRUE;
        },

        /**
         * glGetProgramBinary (4.1): no binary format is known
         * (GL_NUM_PROGRAM_BINARY_FORMATS is zero), so none is written.
         *
         * @param {number} programName
         */
        glGetProgramBinary(programName){
            if (!enter('glGetProgramBinary', [programName]))
            {
                return;
            }
            if (objectOf(programName, 'program'))
            {
                setError(GL.INVALID_OPERATION);
            }
        },

        /**
         * glProgramBinary (4.1): every format is one this renderer does
         * not know, and the program is left as it was.
         *
         * @param {number} programName @param {number} format
         */
        glProgramBinary(programName, format){
            if (!enter('glProgramBinary', [programName, format]))
            {
                return;
            }
            if (objectOf(programName, 'program'))
            {
                setError(GL.INVALID_ENUM);
            }
        },

        /** @param {number} programName @returns {string | null} */
        glGetProgramInfoLog(programName){
            if (!enter('glGetProgramInfoLog', [programName]))
            {
                return null;
            }
            return objectOf(programName, 'program')?.log ?? null;
        },

        /** @param {number} programName @returns {number[] | null} */
        glGetAttachedShaders(programName){
            if (!enter('glGetAttachedShaders', [programName]))
            {
                return null;
            }
            return objectOf(programName, 'program')?.shaders.map(shader=>shader.name) ?? null;
        },

        // --- GL_ARB_shader_objects: the same objects, by handle ---

        /**
         * glGetObjectParameter{if}vARB. A handle is the object's name, and
         * both kinds answer the type; the other queries are the object
         * kind's own (glGetShaderiv, glGetProgramiv), the subtype a shader's.
         *
         * @param {number} name @param {number} pname @returns {number[] | null}
         */
        getObjectParameterARB(name, pname){
            if (!enter('glGetObjectParameterivARB', [name, pname]))
            {
                return null;
            }
            const kind = namespace().objects.get(name)?.kind;
            if (kind !== 'shader' && kind !== 'program')
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            if (pname === OBJECT_TYPE_ARB)
            {
                return [kind === 'program' ? PROGRAM_OBJECT_ARB : SHADER_OBJECT_ARB];
            }
            if (pname === OBJECT_SUBTYPE_ARB)
            {
                if (kind === 'program')
                {
                    setError(GL.INVALID_OPERATION);
                    return null;
                }
                return context.glGetShaderiv(name, GL.SHADER_TYPE);
            }
            return kind === 'program' ? context.glGetProgramiv(name, pname)
                : context.glGetShaderiv(name, pname);
        },

        /** @param {number} pname @returns {number} glGetHandleARB */
        getHandleARB(pname){
            if (!enter('glGetHandleARB', [pname]))
            {
                return 0;
            }
            if (pname !== PROGRAM_OBJECT_ARB)
            {
                setError(GL.INVALID_ENUM);
                return 0;
            }
            return currentName;
        },

        /** @param {number} name glDeleteObjectARB: either kind, by its handle */
        deleteObjectARB(name){
            if (!enter('glDeleteObjectARB', [name]) || name === 0)
            {
                return;
            }
            const kind = namespace().objects.get(name)?.kind;
            if (kind === 'program')
            {
                context.glDeleteProgram(name);
            }
            else if (kind === 'shader')
            {
                context.glDeleteShader(name);
            }
            else
            {
                setError(GL.INVALID_VALUE);
            }
        },

        /** @param {number} name @returns {string | null} glGetInfoLogARB */
        getInfoLogARB(name){
            if (!enter('glGetInfoLogARB', [name]))
            {
                return null;
            }
            const kind = namespace().objects.get(name)?.kind;
            if (kind !== 'shader' && kind !== 'program')
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return kind === 'program' ? context.glGetProgramInfoLog(name)
                : context.glGetShaderInfoLog(name);
        },

        // --- attributes ---

        /** @param {number} programName @param {string} name @returns {number} */
        glGetAttribLocation(programName, name){
            if (!enter('glGetAttribLocation', [programName, name]))
            {
                return -1;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return -1;
            }
            if (!program.linked || !program.executable)
            {
                setError(GL.INVALID_OPERATION);
                return -1;
            }
            return program.executable.linked.attributes.find(a=>a.name === name)?.location ?? -1;
        },

        /**
         * @param {number} programName @param {number} index
         * @returns {{ name: string, size: number, type: number } | null}
         */
        glGetActiveAttrib(programName, index){
            if (!enter('glGetActiveAttrib', [programName, index]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const list = program.executable ? activeAttributes(program.executable.linked) : [];
            const entry = list[index];
            if (!entry)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return { name: entry.name, size: 1, type: glTypeOf(entry.type) };
        },

        /**
         * glTransformFeedbackVaryings: what the next link captures.
         *
         * @param {number} programName @param {readonly string[]} names @param {number} mode
         */
        glTransformFeedbackVaryings(programName, names, mode){
            if (!enter('glTransformFeedbackVaryings', [programName, names, mode]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            if (mode !== GL.INTERLEAVED_ATTRIBS && mode !== GL.SEPARATE_ATTRIBS)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (mode === GL.SEPARATE_ATTRIBS && names.length > FEEDBACK_LIMITS.separateAttribs)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            program.feedback = { names: [...names],
                mode: mode === GL.SEPARATE_ATTRIBS ? 'separate' : 'interleaved' };
        },

        /**
         * @param {number} programName @param {number} index
         * @returns {{ name: string, size: number, type: number } | null}
         */
        glGetTransformFeedbackVarying(programName, index){
            if (!enter('glGetTransformFeedbackVarying', [programName, index]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const varying = program.executable?.linked.feedback?.varyings[index];
            if (!varying)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const type = varying.type?.kind === 'array' ? varying.type.element : varying.type;
            // A gap answers GL_NONE and the components it skips (4.0).
            return { name: varying.name, size: varying.size, type: type ? glTypeOf(type) : 0 };
        },

        // --- uniforms ---

        /** @param {number} programName @param {string} name @returns {number} */
        glGetUniformLocation(programName, name){
            if (!enter('glGetUniformLocation', [programName, name]))
            {
                return -1;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return -1;
            }
            if (!program.linked || !program.executable)
            {
                setError(GL.INVALID_OPERATION);
                return -1;
            }
            const parsed = parseUniformName(name);
            if (!parsed)
            {
                return -1;
            }
            const leaf = program.executable.linked.uniforms.find(u=>u.base === parsed.base);
            if (!leaf || parsed.element >= leaf.size)
            {
                return -1;
            }
            // `a[1]` of a non-array is no name at all.
            if (parsed.indexed && !leaf.name.endsWith('[0]'))
            {
                return -1;
            }
            return leaf.location + parsed.element;
        },

        /**
         * @param {number} programName @param {number} index
         * @returns {{ name: string, size: number, type: number } | null}
         */
        glGetActiveUniform(programName, index){
            if (!enter('glGetActiveUniform', [programName, index]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const linked = program.executable?.linked;
            const leaf = linked ? activeUniforms(linked)[index] : undefined;
            if (!leaf)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return { name: leaf.name, size: leaf.size, type: glTypeOf(leaf.type) };
        },

        // --- fragment outputs (OpenGL 3.0 section 3.9.2, 3.3's dual source) ---

        /**
         * glBindFragDataLocation and its indexed form, for the next link.
         *
         * @param {number} programName @param {number} location @param {number} index
         * @param {string} name
         */
        bindFragData(programName, location, index, name){
            if (!enter('bindFragData', [programName, location, index, name]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            if (location < 0 || location >= GLSL_LIMITS.drawBuffers || index < 0 || index > 1
                || (index === 1 && location >= MAX_DUAL_SOURCE_DRAW_BUFFERS))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (name.startsWith('gl_'))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            program.fragData.set(name, { location, index });
        },

        /**
         * glGetFragDataLocation and glGetFragDataIndex: what the last link
         * gave an output, -1 for a name that is none.
         *
         * @param {number} programName @param {string} name @param {'location' | 'index'} what
         * @returns {number}
         */
        fragData(programName, name, what){
            if (!enter('fragData', [programName, name, what]))
            {
                return -1;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return -1;
            }
            if (!program.linked || !program.executable)
            {
                setError(GL.INVALID_OPERATION);
                return -1;
            }
            const parsed = parseUniformName(name);
            const output = parsed ? program.executable.linked.outputs.find(o=>o.name
                === parsed.base) : undefined;
            if (!output || !parsed)
            {
                return -1;
            }
            const length = output.type.kind === 'array' ? output.type.length : 0;
            if ((parsed.indexed && length === 0) || parsed.element >= Math.max(length, 1))
            {
                return -1;
            }
            return what === 'index' ? output.index : output.location + parsed.element;
        },

        // --- uniform blocks (OpenGL 3.1 section 2.11.4) ---

        /** @param {number} programName @param {string} name @returns {number} */
        glGetUniformBlockIndex(programName, name){
            if (!enter('glGetUniformBlockIndex', [programName, name]))
            {
                return GL.INVALID_INDEX;
            }
            const program = objectOf(programName, 'program');
            const blocks = program?.executable?.linked.blocks;
            if (!blocks || !program?.linked)
            {
                return GL.INVALID_INDEX;
            }
            const index = blocks.findIndex(b=>b.name === name
                || (b.element === 0 && b.name === `${name}[0]`));
            return index < 0 ? GL.INVALID_INDEX : index;
        },

        /**
         * @param {number} programName @param {number} index @param {number} pname
         * @returns {number[] | null}
         */
        glGetActiveUniformBlockiv(programName, index, pname){
            if (!enter('glGetActiveUniformBlockiv', [programName, index, pname]))
            {
                return null;
            }
            const block = blockOf(programName, index);
            if (!block)
            {
                return null;
            }
            const { linked, executable } = block;
            const own = linked.blocks[index];
            /** @type {number[]} */
            const members = [];
            activeUniforms(linked).forEach((u, k)=>{
                if (u.block === index || (u.block >= 0
                    && linked.blocks[u.block].blockName === own.blockName))
                {
                    members.push(k);
                }
            });
            switch (pname)
            {
                case GL.UNIFORM_BLOCK_BINDING:
                    return [executable.blockBindings[index]];
                case GL.UNIFORM_BLOCK_DATA_SIZE:
                    return [own.size];
                case GL.UNIFORM_BLOCK_NAME_LENGTH:
                    return [own.name.length + 1];
                case GL.UNIFORM_BLOCK_ACTIVE_UNIFORMS:
                    return [members.length];
                case GL.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES:
                    return members;
                case GL.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER:
                    return [own.stages.vertex ? 1 : 0];
                case GL.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER:
                    return [own.stages.fragment ? 1 : 0];
                case GL.UNIFORM_BLOCK_REFERENCED_BY_GEOMETRY_SHADER:
                    return [own.stages.geometry ? 1 : 0];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /** @param {number} programName @param {number} index @returns {string | null} */
        glGetActiveUniformBlockName(programName, index){
            if (!enter('glGetActiveUniformBlockName', [programName, index]))
            {
                return null;
            }
            return blockOf(programName, index)?.linked.blocks[index].name ?? null;
        },

        /**
         * @param {number} programName @param {number} index @param {number} binding
         */
        glUniformBlockBinding(programName, index, binding){
            if (!enter('glUniformBlockBinding', [programName, index, binding]))
            {
                return;
            }
            const block = blockOf(programName, index);
            if (!block)
            {
                return;
            }
            if (binding < 0 || binding >= BLOCK_LIMITS.bindings)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            block.executable.blockBindings[index] = binding;
        },

        /**
         * @param {number} programName @param {readonly string[]} names
         * @returns {number[] | null}  each name's index in the active uniforms, or
         *     INVALID_INDEX
         */
        glGetUniformIndices(programName, names){
            if (!enter('glGetUniformIndices', [programName, names]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const linked = program.linked ? program.executable?.linked : undefined;
            const list = linked ? activeUniforms(linked) : [];
            return names.map(name=>{
                const at = list.findIndex(u=>u.name === name || u.name === `${name}[0]`);
                return at < 0 ? GL.INVALID_INDEX : at;
            });
        },

        /**
         * @param {number} programName @param {readonly number[]} indices @param {number} pname
         * @returns {number[] | null}
         */
        glGetActiveUniformsiv(programName, indices, pname){
            if (!enter('glGetActiveUniformsiv', [programName, indices, pname]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const linked = program.executable?.linked;
            const list = linked ? activeUniforms(linked) : [];
            if (indices.some(index=>index < 0 || index >= list.length))
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            /** @type {Record<number, (u: (typeof list)[number]) => number>} */
            const read = {
                [GL.UNIFORM_TYPE]: u=>glTypeOf(u.type),
                [GL.UNIFORM_SIZE]: u=>u.size,
                [GL.UNIFORM_NAME_LENGTH]: u=>u.name.length + 1,
                [GL.UNIFORM_BLOCK_INDEX]: u=>u.block,
                [GL.UNIFORM_OFFSET]: u=>u.offset,
                [GL.UNIFORM_ARRAY_STRIDE]: u=>(u.block < 0 ? -1 : u.size > 1 || u.arrayStride > 0
                    ? u.arrayStride : 0),
                [GL.UNIFORM_MATRIX_STRIDE]: u=>(u.block < 0 ? -1 : u.matrixStride),
                [GL.UNIFORM_IS_ROW_MAJOR]: u=>(u.rowMajor ? 1 : 0),
            };
            const answer = read[pname];
            if (!answer)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return indices.map(index=>answer(list[index]));
        },

        /** @param {number} programName @param {number} index @returns {string | null} */
        glGetActiveUniformName(programName, index){
            if (!enter('glGetActiveUniformName', [programName, index]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const linked = program.executable?.linked;
            const uniform = linked ? activeUniforms(linked)[index] : undefined;
            if (!uniform)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return uniform.name;
        },

        /**
         * glUniform{1234}{f,i,ui}[v]: `components` values an element, `count`
         * elements.
         *
         * @param {number} location @param {number} count @param {ArrayLike<number>} values
         * @param {'f' | 'i' | 'u'} kind @param {number} components
         */
        uniform(location, count, values, kind, components){
            // A list replays the values, not the program's memory they came from.
            if (enter('uniform', [location, count, Array.from(values), kind, components]))
            {
                writeUniform(`glUniform${components}${kind}`, location, count, values, kind,
                    components, null);
            }
        },

        /**
         * glUniformMatrix{234}[x{234}]fv.
         *
         * @param {number} location @param {number} count @param {number} transpose
         * @param {ArrayLike<number>} values @param {number} cols @param {number} rows
         */
        uniformMatrix(location, count, transpose, values, cols, rows){
            if (enter('uniformMatrix', [location, count, transpose, Array.from(values), cols,
                rows]))
            {
                writeUniform(`glUniformMatrix${cols}x${rows}fv`, location, count, values, 'f',
                    cols * rows, { cols, rows, transpose: transpose !== 0 });
            }
        },

        /**
         * glProgramUniform{1234}{f,i,ui}[v] and glProgramUniformMatrix*fv
         * (4.1): a uniform of `programName`, current or not; `matrix` the
         * columns, rows and transposition of a matrix's.
         *
         * @param {number} programName @param {number} location @param {number} count
         * @param {ArrayLike<number>} values @param {'f' | 'i' | 'u'} kind
         * @param {number} components
         * @param {{ cols: number, rows: number, transpose: boolean } | null} matrix
         */
        programUniform(programName, location, count, values, kind, components, matrix){
            if (!enter('programUniform', [programName, location, count, Array.from(values), kind,
                components, matrix]))
            {
                return;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return;
            }
            writeUniform(matrix ? `glProgramUniformMatrix${matrix.cols}x${matrix.rows}fv`
                : `glProgramUniform${components}${kind}`, location, count, values, kind,
            components, matrix, program);
        },

        /**
         * glGetnUniform{f,i,ui}v (4.5, KHR_robustness): getUniform's answer,
         * refused when its values would not fit `size` bytes.
         *
         * @param {number} programName @param {number} location @param {number} size
         * @returns {{ values: number[], float: boolean, unsigned?: boolean } | null}
         */
        getnUniform(programName, location, size){
            if (!enter('getnUniform', [programName, location, size]))
            {
                return null;
            }
            const answered = context.getUniform(programName, location);
            if (answered && answered.values.length * 4 > size)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            return answered;
        },

        /**
         * @param {number} programName @param {number} location
         * @returns {{ values: number[], float: boolean, unsigned?: boolean } | null}
         *     the element's values, and whether it holds floats or unsigned integers
         */
        getUniform(programName, location){
            if (!enter('getUniform', [programName, location]))
            {
                return null;
            }
            const program = objectOf(programName, 'program');
            if (!program)
            {
                return null;
            }
            const executable = program.executable;
            const found = program.linked ? executable?.linked.locations.get(location) : undefined;
            if (!executable || !found)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            const { leaf, element } = found;
            const at = leaf.offset + element * leaf.words;
            const type = leaf.type;
            const float = type.kind === 'matrix'
                || ((type.kind === 'scalar' || type.kind === 'vector') && type.base === 'float');
            const source = float ? executable.floats : executable.ints;
            const values = Array.from(source.subarray(at, at + leaf.words));
            const unsigned = (type.kind === 'scalar' || type.kind === 'vector')
                && type.base === 'uint';
            return unsigned ? { values: values.map(v=>v >>> 0), float, unsigned }
                : { values, float };
        },
    });
}

/**
 * The attributes glGetActiveAttrib lists: the program's own, then the
 * conventional ones its vertex shader reads, which have no location.
 *
 * @param {LinkedProgram} linked
 * @returns {{ name: string, type: GlslType }[]}
 */
function activeAttributes(linked){
    return [
        ...linked.attributes,
        ...linked.builtinAttributes.map(name=>({ name,
            type: /** @type {GlslType} */ (BUILTIN_ATTRIBUTE_TYPES.get(name)) })),
    ];
}

/** The conventional attributes' types. */
const BUILTIN_ATTRIBUTE_TYPES = new Map(Object.entries(BUILTIN_VARIABLES.vertex)
    .filter(([, builtin])=>builtin.role === 'attribute')
    .map(([name, builtin])=>[name, builtin.type]));

/** MAX_DUAL_SOURCE_DRAW_BUFFERS (OpenGL 3.3): the outputs of index 1 there may be. */
export const MAX_DUAL_SOURCE_DRAW_BUFFERS = 1;

/**
 * The calls of this file a display list does not record (section 5.4): the
 * object calls and the queries. glUseProgram and the uniform calls are
 * recorded.
 */
export const SHADER_CALLS_NOT_COMPILED = Object.freeze([
    'glCreateShader', 'glShaderSource', 'glCompileShader', 'glDeleteShader', 'glIsShader',
    'glGetShaderiv', 'glGetShaderInfoLog', 'glGetShaderSource', 'glCreateProgram',
    'glAttachShader', 'glDetachShader', 'glBindAttribLocation', 'glLinkProgram',
    'glValidateProgram', 'glDeleteProgram', 'glIsProgram', 'glGetProgramiv',
    'glGetProgramInfoLog', 'glGetAttachedShaders', 'glGetAttribLocation', 'glGetActiveAttrib',
    'glGetUniformLocation', 'glGetActiveUniform', 'getUniform', 'bindFragData', 'fragData',
    'glGetUniformBlockIndex', 'glGetActiveUniformBlockiv', 'glGetActiveUniformBlockName',
    'glGetUniformIndices', 'glGetActiveUniformsiv', 'glGetActiveUniformName',
    'glProgramParameteri', 'glGetProgramBinary', 'glProgramBinary', 'programUniform',
    'getnUniform',
]);

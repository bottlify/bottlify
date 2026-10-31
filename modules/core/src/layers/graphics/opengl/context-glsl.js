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
import { preprocess } from './glsl-preprocess.js';
import { GlslSyntaxError, parse } from './glsl-parse.js';
import { GlslCompileError, checkShader } from './glsl-check.js';
import { linkProgram } from './glsl-link.js';
import { BUILTIN_VARIABLES, GLSL_LIMITS } from './glsl-builtins.js';
import { componentsOf } from './glsl-types.js';

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
 * @property {Executable | null} executable
 * @property {number} users  the contexts it is current in
 */

/** The shader types. @type {Map<number, 'vertex' | 'fragment'>} */
const SHADER_TYPES = new Map([[GL.VERTEX_SHADER, 'vertex'], [GL.FRAGMENT_SHADER, 'fragment']]);

let executables = 0;

/**
 * Compiled shaders by their text, the most recent first to be kept.
 *
 * @type {Map<string, { ok: boolean, log: string, unit: ShaderUnit | null }>}
 */
const COMPILED = new Map();
const COMPILED_KEPT = 256;

/**
 * @param {readonly string[]} sources @param {'vertex' | 'fragment'} stage
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
    const pre = preprocess(sources);
    const lines = pre.diagnostics.map(d=>`${d.severity === 'error' ? 'ERROR' : 'WARNING'}:`
        + ` ${d.string}:${d.line}: ${d.message}`);
    /** @type {{ ok: boolean, log: string, unit: ShaderUnit | null }} */
    let result;
    if (pre.diagnostics.some(d=>d.severity === 'error'))
    {
        result = { ok: false, log: `${lines.join('\n')}\n`, unit: null };
    }
    else
    {
        try
        {
            const unit = checkShader(parse(pre.tokens), { stage, version: pre.version });
            result = { ok: true, log: lines.length > 0 ? `${lines.join('\n')}\n` : '', unit };
        }
        catch (e){
            if (!(e instanceof GlslSyntaxError) && !(e instanceof GlslCompileError))
            {
                throw e;
            }
            const at = e.at;
            lines.push(`ERROR: ${at.string}:${at.line}: ${e.message}`);
            result = { ok: false, log: `${lines.join('\n')}\n`, unit: null };
        }
    }
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
            return type.base === 'float' ? GL.FLOAT : type.base === 'int' ? GL.INT : GL.BOOL;
        case 'vector': {
            const at = type.size - 2;
            return type.base === 'float' ? GL.FLOAT_VEC2 + at
                : type.base === 'int' ? GL.INT_VEC2 + at : GL.BOOL_VEC2 + at;
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
            return type.shadow ? (type.dim === '1D' ? GL.SAMPLER_1D_SHADOW : GL.SAMPLER_2D_SHADOW)
                : /** @type {Record<string, number>} */ ({ '1D': GL.SAMPLER_1D,
                    '2D': GL.SAMPLER_2D, '3D': GL.SAMPLER_3D, Cube: GL.SAMPLER_CUBE })[type.dim];
        default:
            return 0;
    }
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
     * @returns {{ executable: Executable,
     *     leaf: import('./glsl-link.js').UniformLeaf, element: number } | null}
     */
    const uniformAt = (call, location)=>{
        const executable = currentProgram?.executable;
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
     * @param {'f' | 'i'} kind
     * @param {number} components  per element, or a matrix's columns times rows
     * @param {{ cols: number, rows: number, transpose: boolean } | null} matrix
     */
    const writeUniform = (call, location, count, values, kind, components, matrix)=>{
        if (count < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const target = uniformAt(call, location);
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
                || (base === 'float' && kind !== 'f') || (base === 'int' && kind !== 'i'))
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
            const stage = /** @type {'vertex' | 'fragment'} */ (SHADER_TYPES.get(shader.type));
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
                validated: false, log: '', bindings: new Map(), executable: null, users: 0 };
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
                fragment: units(GL.FRAGMENT_SHADER),
                attribBindings: program.bindings,
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
            };
        },

        /** @param {number} programName */
        glUseProgram(programName){
            if (!enter('glUseProgram', [programName]))
            {
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
                    return [linked ? linked.uniforms.length : 0];
                case GL.ACTIVE_UNIFORM_MAX_LENGTH:
                    return [linked ? Math.max(0, ...linked.uniforms
                        .map(u=>u.name.length + 1)) : 0];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
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
            const leaf = program.executable?.linked.uniforms[index];
            if (!leaf)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return { name: leaf.name, size: leaf.size, type: glTypeOf(leaf.type) };
        },

        /**
         * glUniform{1234}{fi}[v]: `components` values an element, `count`
         * elements.
         *
         * @param {number} location @param {number} count @param {ArrayLike<number>} values
         * @param {'f' | 'i'} kind @param {number} components
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
         * @param {number} programName @param {number} location
         * @returns {{ values: number[], float: boolean } | null}  the element's
         *     values, and whether it holds floats
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
            return { values: Array.from(source.subarray(at, at + leaf.words)), float };
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
    'glGetUniformLocation', 'glGetActiveUniform', 'getUniform',
]);

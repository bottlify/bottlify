/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Linking a program's shaders (OpenGL 2.1, section 2.15.2, and the language
 * specification's section 7): each stage's shader objects merged into one, a
 * `main` found and every function it reaches defined, the interface between
 * the stages matched by name, and what the program actually uses laid out --
 * which is what a program sees as its active attributes and uniforms.
 *
 * What the GL leaves to the implementation, decided here:
 *
 * - **What is active is what `main` reaches.** A uniform or attribute named
 *   only by a function nothing calls is not active, has no location and is not
 *   listed.
 * - **Attribute locations** an application did not bind go, in the order the
 *   shader declares them, to the lowest locations free, the first to 0 when
 *   the shader does not read gl_Vertex (generic attribute 0 is the vertex,
 *   section 2.7). A location a conventional attribute the shader also reads
 *   aliases (`canonicalAttribName`) is passed over, so that the two do not
 *   read one array.
 * - **Uniform locations** count from 0, one per element of an array of a basic
 *   type and one per member of a struct, so `a[i]`'s location is `a[0]`'s plus
 *   i, as programs assume.
 * - **The uniform store** is one buffer of 32-bit words, each element's
 *   components in a row of their own (a matrix column by column), what
 *   glUniform* writes and glGetUniform* reads; each stage's block is copied
 *   out of it by the plan made here.
 */

import { atomicCountersOf, storageBlocksOf } from './glsl-storage.js';
import { BUILTIN_ATTRIBUTES, GLSL_LIMITS } from './glsl-builtins.js';
import { baseOf, componentsOf, glslName, innermost } from './glsl-types.js';
import { blockLayout, blockVariables } from './glsl-layout.js';
import { canonicalAttribName } from './arb-program.js';

/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-check.js').ShaderUnit} ShaderUnit
 * @typedef {import('./glsl-check.js').UserFunction} UserFunction
 * @typedef {import('./glsl-check.js').VariableSymbol} VariableSymbol
 */

/**
 * One stage of a linked program, merged from its shader objects.
 *
 * @typedef {Object} LinkedStage
 * @property {'vertex' | 'geometry' | 'fragment' | 'compute'} stage
 * @property {UserFunction} main
 * @property {UserFunction[]} functions  the definitions main reaches, callees first
 * @property {VariableSymbol[]} globals  every global the stage's shaders declare
 * @property {Set<string>} uses  the names of the globals and built-ins main reaches
 * @property {Map<string, VariableSymbol>} builtins  the built-in variables its
 *     shaders name, with the types this version gives them
 * @property {import('./glsl-types.js').StructType[]} structs  one per name
 * @property {number} version
 */

/**
 * A value the vertex stage passes the fragment stage (section 4.3.4 of 1.30,
 * "Inputs", and 7.4.1 of the 3.3 API: matched by name, a member of a block by
 * the block's name and its own).
 *
 * @typedef {Object} Varying
 * @property {string} name     `x`, or `Block.x` for a block member
 * @property {GlslType} type
 * @property {string} vertexPath  the WGSL the stage before the fragment stage
 *     (the geometry shader where there is one, else the vertex shader) writes
 *     it through, past the stage's prefix: `g_x`, or `g_instance.m_x`
 * @property {string} fragmentPath  what the fragment stage reads it into
 * @property {'smooth' | 'flat' | 'noperspective'} interpolation
 * @property {boolean} centroid
 */

/**
 * A fragment shader's own output (section 4.3.6 of 1.30, and 3.0's
 * glBindFragDataLocation): the colour number it is written to.
 *
 * @typedef {Object} FragmentOutput
 * @property {string} name
 * @property {GlslType} type
 * @property {number} location  the first; an array takes one a element
 * @property {number} index  0, or 1 for the second source of dual-source blending
 */

/**
 * A uniform block a program uses (OpenGL 3.1 section 2.11.4): where its
 * members lie in the buffer the application binds, and which stages read it.
 *
 * @typedef {Object} UniformBlock
 * @property {string} name  as glGetUniformBlockIndex takes it: `B`, or `B[2]`
 *     for an element of an array of blocks
 * @property {string} blockName  the block's name, without an element
 * @property {number} element  the element of an array of blocks, or 0
 * @property {string | null} instance
 * @property {number} size  UNIFORM_BLOCK_DATA_SIZE, in bytes
 * @property {'std140' | 'std430'} packing
 * @property {import('./glsl-layout.js').MemberLayout[]} members
 * @property {{ vertex: boolean, geometry: boolean, fragment: boolean,
 *     compute?: boolean }} stages
 * @property {number} binding  the binding point a link leaves it at: the
 *     shader's `layout(binding)` (4.20), else 0
 */

/**
 * An active uniform of a named block, as glGetActiveUniform lists it after
 * the default block's.
 *
 * @typedef {Object} BlockUniform
 * @property {string} name
 * @property {GlslType} type
 * @property {number} size
 * @property {number} block  the block's index
 * @property {number} offset
 * @property {number} arrayStride
 * @property {number} matrixStride
 * @property {boolean} rowMajor
 */

/**
 * An active uniform's leaf: a basic type or a sampler, maybe an array.
 *
 * @typedef {Object} UniformLeaf
 * @property {string} name      as glGetActiveUniform names it, `a[0]` for an array
 * @property {string} base      the name without its array suffix: `s.f`, `a`
 * @property {string} root      the top-level variable it belongs to
 * @property {string[]} path    how to reach it from the root: members and indices
 * @property {GlslType} type    the element's type
 * @property {number} size      elements; 1 for a non-array
 * @property {number} location  the first element's
 * @property {number} offset    the first element's first word in the store
 * @property {number} words     words per element
 * @property {number[]} [samplerBindings]  each element's sampler, for a sampler
 */

/**
 * A value the vertex stage passes the geometry stage, which reads it a
 * vertex of its primitive at a time (section 4.3.4 of 1.50: an input of a
 * geometry shader is an array, a block's instance an array of blocks).
 *
 * @typedef {Object} GeometryInput
 * @property {string} name
 * @property {GlslType} type  a vertex's: the input's element type
 * @property {string} vertexPath  what the vertex stage writes it through
 * @property {string} geometryPath  what the geometry stage reads it into, `[]`
 *     standing for the vertex: `g_x[]`, or `g_instance[].m_x`
 */

/**
 * What a geometry shader's layout declarations say (section 4.3.8.1 and
 * 4.3.8.2 of 1.50), merged over its shader objects.
 *
 * @typedef {Object} GeometryLayout
 * @property {'points' | 'lines' | 'lines_adjacency' | 'triangles'
 *     | 'triangles_adjacency'} input
 * @property {number} inputVertices  1, 2, 4, 3 or 6
 * @property {'points' | 'line_strip' | 'triangle_strip'} output
 * @property {number} outputVertices  a primitive's: 1, 2 or 3
 * @property {number} maxVertices  what one invocation emits at the most
 */

/**
 * A value transform feedback captures (OpenGL 3.0 section 2.15, 4.0's
 * gl_SkipComponents and gl_NextBuffer): an output of the stage before the
 * rasterizer, an element of one, or a gap.
 *
 * @typedef {Object} FeedbackVarying
 * @property {string} name  as glGetTransformFeedbackVarying answers it
 * @property {GlslType | null} type  null for a gap (gl_SkipComponents, gl_NextBuffer)
 * @property {number} size  an array's elements, 1 for anything else; a gap's components
 * @property {string | null} path  what the stage writes it through, past its
 *     prefix (`g_x`, `g_b.m_x`, `g_a[2]`, `gl_Position`); null for a gap
 * @property {number} buffer  the buffer it is written to
 * @property {number} word  its first word within a vertex there
 */

/**
 * @typedef {Object} Feedback
 * @property {'interleaved' | 'separate'} mode
 * @property {FeedbackVarying[]} varyings  in the order they were named
 * @property {number[]} strides  each buffer's words a vertex
 */

/** Transform feedback's limits (OpenGL 3.0's minimums; 4.0's buffers). */
export const FEEDBACK_LIMITS = Object.freeze({
    interleavedComponents: 64, separateAttribs: 4, separateComponents: 4, buffers: 4,
});

/**
 * @typedef {Object} LinkedProgram
 * @property {LinkedStage | null} vertex
 * @property {LinkedStage | null} geometry
 * @property {GeometryInput[]} geometryInputs  what the geometry stage reads of
 *     the vertex stage's, by name
 * @property {GeometryLayout | null} geometryLayout
 * @property {Feedback | null} feedback  what transform feedback captures, where
 *     glTransformFeedbackVaryings named anything
 * @property {LinkedStage | null} fragment
 * @property {{ name: string, type: GlslType, location: number }[]} attributes  active
 * @property {string[]} builtinAttributes  the conventional ones the vertex stage reads
 * @property {UniformLeaf[]} uniforms  active, in the order glGetActiveUniform lists them
 * @property {Map<number, { leaf: UniformLeaf, element: number }>} locations
 * @property {number} storeWords
 * @property {ArrayBuffer} defaults  the store as linking leaves it
 * @property {Varying[]} varyings  what the stages pass, by name
 * @property {{ leaf: UniformLeaf, element: number, dim: string, shadow: boolean,
 *     type: import('./glsl-types.js').SamplerType }[]} samplers  in binding order
 * @property {boolean} writesData  the fragment stage writes gl_FragData
 * @property {number} fragmentOutputs  how many colour outputs it writes at most
 * @property {FragmentOutput[]} outputs  the fragment shader's own outputs
 * @property {UniformBlock[]} blocks  the active uniform blocks, by index
 * @property {BlockUniform[]} blockUniforms  their active uniforms
 * @property {import('./glsl-storage.js').StorageBlock[]} [storageBlocks]  the active
 *     shader storage blocks, by index (4.3)
 * @property {import('./glsl-storage.js').AtomicCounter[]} [counters]  the active atomic
 *     counters (4.2), which are not among `uniforms`
 * @property {LinkedStage | null} [compute]  a compute program's one stage (4.3)
 * @property {[number, number, number]} [localSize]  its work group's size
 */

/** The uniform blocks a stage may read, and all its stages together (OpenGL 3.1). */
export const BLOCK_LIMITS = Object.freeze({
    perStage: 10, combined: 20, bindings: 24, size: 16384,
});

/**
 * A compute dispatch's limits (OpenGL 4.3 table 23.53): WebGPU's own
 * defaults where they are under GL's minimums - a work group of at most 256
 * invocations, 256 by 256 by 64, and 16 KiB of shared memory against GL's
 * 1024, 1024 by 1024 by 64 and 32 KiB (decision A171) - and GL's minimum
 * where WebGPU allows as much: 65535 groups along each axis.
 */
export const COMPUTE_LIMITS = Object.freeze({
    count: Object.freeze([65535, 65535, 65535]),
    size: Object.freeze([256, 256, 64]),
    invocations: 256,
    sharedBytes: 16384,
});

/** @param {GlslType} type */
const wordsOf = type=>(type.kind === 'sampler' ? 1 : componentsOf(type));

/**
 * The leaves of a uniform: each basic or sampler element reachable through
 * members and array indices, arrays of a basic type as one leaf.
 *
 * @param {string} name @param {GlslType} type @param {string[]} path
 * @returns {{ base: string, path: string[], type: GlslType, size: number,
 *     array: boolean }[]}
 */
function leavesOf(name, type, path){
    if (type.kind === 'struct')
    {
        return type.fields.flatMap(field=>leavesOf(`${name}.${field.name}`, field.type,
            [...path, `.${field.name}`]));
    }
    if (type.kind === 'array')
    {
        const element = type.element;
        if (element.kind === 'struct')
        {
            return Array.from({ length: type.length }, (_, k)=>leavesOf(`${name}[${k}]`,
                element, [...path, `[${k}]`])).flat();
        }
        return [{ base: name, path, type: element, size: type.length, array: true }];
    }
    return [{ base: name, path, type, size: 1, array: false }];
}

/** The input primitives of a geometry shader, with their vertices. */
const GEOMETRY_INPUTS = new Map([['points', 1], ['lines', 2], ['lines_adjacency', 4],
    ['triangles', 3], ['triangles_adjacency', 6]]);
/** The output primitives, with a primitive's vertices. */
const GEOMETRY_OUTPUTS = new Map([['points', 1], ['line_strip', 2], ['triangle_strip', 3]]);

/**
 * @param {{ vertex: ShaderUnit[], geometry?: ShaderUnit[], fragment: ShaderUnit[],
 *     compute?: ShaderUnit[],
 *     feedback?: { names: readonly string[], mode: 'interleaved' | 'separate' },
 *     attribBindings: Map<string, number>,
 *     fragDataBindings?: Map<string, { location: number, index: number }> }} given
 * @returns {{ ok: true, log: string, program: LinkedProgram }
 *     | { ok: false, log: string }}
 */
export function linkProgram(given){
    const { vertex, fragment, attribBindings } = given;
    const geometry = given.geometry ?? [];
    const compute = given.compute ?? [];
    const fragDataBindings = given.fragDataBindings ?? new Map();
    /** @type {string[]} */
    const errors = [];
    /** @param {string} message */
    const error = message=>{
        errors.push(`ERROR: ${message}`);
    };

    if (vertex.length === 0 && fragment.length === 0 && geometry.length === 0
        && compute.length === 0)
    {
        return { ok: false, log: 'ERROR: no shaders are attached\n' };
    }

    /**
     * @param {'vertex' | 'geometry' | 'fragment' | 'compute'} stage
     * @param {ShaderUnit[]} units
     * @returns {LinkedStage | null}
     */
    const mergeStage = (stage, units)=>{
        if (units.length === 0)
        {
            return null;
        }
        /** @type {Map<string, UserFunction>} */
        const defined = new Map();
        for (const unit of units)
        {
            for (const fn of unit.functions)
            {
                if (!fn.body)
                {
                    continue;
                }
                if (defined.has(fn.key))
                {
                    error(`${stage} shader: function '${fn.key}' is defined more than once`);
                    continue;
                }
                defined.set(fn.key, fn);
            }
        }
        const main = defined.get('main()');
        if (!main)
        {
            error(`${stage} shader: no 'main' function is defined`);
            return null;
        }
        /** @type {Map<string, VariableSymbol>} */
        const globals = new Map();
        for (const unit of units)
        {
            for (const symbol of unit.globals.values())
            {
                const other = globals.get(symbol.name);
                if (other && (other.type !== symbol.type && glslName(other.type)
                    !== glslName(symbol.type) || other.storage !== symbol.storage))
                {
                    error(`${stage} shader: '${symbol.name}' is declared differently in two`
                        + ' shaders');
                    continue;
                }
                if (!other)
                {
                    globals.set(symbol.name, symbol);
                }
            }
        }
        /** @type {Map<string, import('./glsl-types.js').StructType>} */
        const structs = new Map();
        for (const unit of units)
        {
            for (const struct of unit.structs)
            {
                const other = structs.get(struct.name);
                if (other && other !== struct && describe(other) !== describe(struct))
                {
                    error(`${stage} shader: struct '${struct.name}' is declared differently`
                        + ' in two shaders');
                }
                if (!other)
                {
                    structs.set(struct.name, struct);
                }
            }
        }
        // What main reaches, callees before callers, with a cycle an error.
        /** @type {UserFunction[]} */
        const ordered = [];
        /** @type {Map<string, 'visiting' | 'done'>} */
        const state = new Map();
        /** @type {Set<string>} */
        const uses = new Set();
        /** @param {string} key */
        const visit = key=>{
            const fn = defined.get(key);
            if (!fn)
            {
                error(`${stage} shader: function '${key}' is called and not defined`);
                return;
            }
            const seen = state.get(key);
            if (seen === 'done')
            {
                return;
            }
            if (seen === 'visiting')
            {
                error(`${stage} shader: recursion is not allowed ('${key}')`);
                return;
            }
            state.set(key, 'visiting');
            for (const callee of fn.calls)
            {
                visit(callee);
            }
            for (const symbol of fn.uses)
            {
                uses.add(symbol.name);
            }
            state.set(key, 'done');
            ordered.push(fn);
        };
        for (const unit of units)
        {
            for (const key of unit.initCalls)
            {
                visit(key);
            }
            for (const symbol of unit.initUses)
            {
                uses.add(symbol.name);
            }
        }
        visit('main()');
        /** @type {Map<string, VariableSymbol>} */
        const builtins = new Map();
        for (const unit of units)
        {
            for (const [name, symbol] of unit.builtins ?? [])
            {
                if (!builtins.has(name))
                {
                    builtins.set(name, symbol);
                }
            }
        }
        return {
            stage, main, functions: ordered, globals: [...globals.values()], uses, builtins,
            structs: [...structs.values()],
            version: Math.max(...units.map(unit=>unit.version)),
        };
    };

    const vs = mergeStage('vertex', vertex);
    const gs = mergeStage('geometry', geometry);
    const fs = mergeStage('fragment', fragment);
    const cs = mergeStage('compute', compute);
    const geometryLayout = gs ? geometryLayoutOf(geometry, error) : null;
    if (cs && (vs || gs || fs))
    {
        // OpenGL 4.3 section 7.3: a program with a compute shader has no
        // other stage.
        error('a compute shader is linked with shaders of other stages');
    }
    const localSize = cs ? localSizeOf(compute, error) : null;
    if (gs && !vs)
    {
        // OpenGL 3.2 section 2.12: a geometry shader takes what a vertex
        // shader made.
        error('a geometry shader is attached with no vertex shader');
    }
    if (errors.length > 0)
    {
        return { ok: false, log: `${errors.join('\n')}\n` };
    }

    /** @param {LinkedStage | null} stage @param {string} storage */
    const usedOf = (stage, storage)=>(stage
        ? stage.globals.filter(symbol=>symbol.storage === storage && stage.uses.has(symbol.name))
        : []);

    // --- what the geometry stage reads of the vertex stage's outputs ---
    /** @type {GeometryInput[]} */
    const geometryInputs = [];
    if (vs && gs)
    {
        const outputs = new Map(interfaceOf(vs, 'out', error).map(entry=>[entry.name, entry]));
        for (const input of interfaceOf(gs, 'in', error, true))
        {
            if (!input.used)
            {
                continue;
            }
            const from = outputs.get(input.name);
            if (!from)
            {
                error(`geometry shader input '${input.name}' is not declared in the vertex`
                    + ' shader');
                continue;
            }
            if (glslName(from.type) !== glslName(input.type))
            {
                error(`input '${input.name}' has type ${glslName(from.type)} in the vertex`
                    + ` shader and ${glslName(input.type)}[] in the geometry shader`);
                continue;
            }
            geometryInputs.push({ name: input.name, type: input.type, vertexPath: from.path,
                geometryPath: input.path });
        }
    }

    // --- varyings: the last stage's outputs the fragment stage reads ---
    /** @type {Varying[]} */
    const varyings = [];
    // What the fragment stage reads is the geometry stage's where there is one.
    const before = gs ?? vs;
    if (before && fs)
    {
        const outputs = new Map(interfaceOf(before, 'out', error).map(entry=>[entry.name, entry]));
        const late = Math.min(before.version, fs.version) >= 430;
        for (const input of interfaceOf(fs, 'in', error))
        {
            if (!input.used)
            {
                continue;
            }
            const word = input.legacy ? 'varying' : 'input';
            const from = outputs.get(input.name);
            if (!from)
            {
                error(`fragment shader ${word} '${input.name}' is not declared in the`
                    + ` ${before.stage} shader`);
                continue;
            }
            if (glslName(from.type) !== glslName(input.type))
            {
                error(`${word} '${input.name}' has type ${glslName(from.type)} in the`
                    + ` ${before.stage} shader and ${glslName(input.type)} in the fragment shader`);
                continue;
            }
            // Before 4.30 both stages say the same interpolation (section
            // 4.3.9 of 1.30 to 4.20); from it the fragment stage's decides.
            if (!late && (from.interpolation ?? 'smooth') !== (input.interpolation ?? 'smooth'))
            {
                error(`${word} '${input.name}' is interpolated`
                    + ` ${from.interpolation ?? 'smooth'} in the ${before.stage} shader and`
                    + ` ${input.interpolation ?? 'smooth'} in the fragment shader`);
                continue;
            }
            const integer = /^(int|uint|double)$/.test(String(baseOf(innermost(input.type))));
            varyings.push({
                name: input.name, type: input.type, vertexPath: from.path,
                fragmentPath: input.path,
                interpolation: integer ? 'flat' : input.interpolation ?? from.interpolation
                    ?? 'smooth',
                centroid: input.centroid,
            });
        }
    }

    // --- what transform feedback captures ---
    const feedback = given.feedback && given.feedback.names.length > 0 && before
        ? feedbackOf(before, given.feedback, error) : null;

    // --- attributes ---
    /** @type {{ name: string, type: GlslType, location: number }[]} */
    const attributes = [];
    const builtinAttributes = vs ? Object.keys(BUILTIN_ATTRIBUTES).filter(name=>vs.uses.has(name))
        : [];
    if (vs)
    {
        const active = [...usedOf(vs, 'attribute'), ...usedOf(vs, 'in')];
        /**
         * Where an attribute is bound: the shader's `layout(location)`, which
         * wins over glBindAttribLocation's (section 2.11.3 of 3.3), else that.
         *
         * @param {VariableSymbol} symbol @returns {number | undefined}
         */
        const boundAt = symbol=>{
            const explicit = symbol.qualifiers?.layout.location;
            return typeof explicit === 'number' ? explicit : attribBindings.get(symbol.name);
        };
        /** @param {GlslType} type */
        const slotsOf = type=>(type.kind === 'matrix' ? type.cols : 1);
        /** @type {Set<number>} */
        const taken = new Set();
        // Locations a conventional attribute the shader reads aliases.
        /** @type {Set<number>} */
        const aliased = new Set();
        for (let location = 0; location < GLSL_LIMITS.vertexAttribs; location++)
        {
            const name = canonicalAttribName(location);
            const builtin = builtinAttributes.find(b=>/** @type {any} */ (BUILTIN_ATTRIBUTES)[b]
                === name);
            if (builtin)
            {
                aliased.add(location);
            }
        }
        for (const symbol of active)
        {
            const bound = boundAt(symbol);
            if (bound === undefined)
            {
                continue;
            }
            const slots = slotsOf(symbol.type);
            if (bound + slots > GLSL_LIMITS.vertexAttribs)
            {
                error(`attribute '${symbol.name}' is bound past the last location`);
                continue;
            }
            for (let k = 0; k < slots; k++)
            {
                if (taken.has(bound + k) && typeof symbol.qualifiers?.layout.location === 'number')
                {
                    error(`attribute '${symbol.name}' is given location ${bound + k}, which`
                        + ' another attribute has in the shader too');
                }
                taken.add(bound + k);
            }
            attributes.push({ name: symbol.name, type: symbol.type, location: bound });
        }
        let first = true;
        for (const symbol of active)
        {
            if (boundAt(symbol) !== undefined)
            {
                continue;
            }
            const slots = slotsOf(symbol.type);
            const fits = (/** @type {number} */ at)=>{
                for (let k = 0; k < slots; k++)
                {
                    if (at + k >= GLSL_LIMITS.vertexAttribs || taken.has(at + k)
                        || aliased.has(at + k))
                    {
                        return false;
                    }
                }
                return true;
            };
            let location = -1;
            if (first && !builtinAttributes.includes('gl_Vertex') && fits(0))
            {
                location = 0;
            }
            else
            {
                for (let at = 1; at < GLSL_LIMITS.vertexAttribs; at++)
                {
                    if (fits(at))
                    {
                        location = at;
                        break;
                    }
                }
            }
            first = false;
            if (location < 0)
            {
                error(`too many vertex attributes: '${symbol.name}' has no location left`);
                continue;
            }
            for (let k = 0; k < slots; k++)
            {
                taken.add(location + k);
            }
            attributes.push({ name: symbol.name, type: symbol.type, location });
        }
    }

    // --- uniforms ---
    /** @type {Map<string, VariableSymbol>} */
    const uniformRoots = new Map();
    for (const stage of [vs, gs, fs, cs])
    {
        for (const symbol of usedOf(stage, 'uniform'))
        {
            // An atomic counter is a place in a buffer, not a value in the
            // store (`glsl-storage.js`).
            if (symbol.block || (symbol.type.kind === 'array' ? symbol.type.element
                : symbol.type).kind === 'atomic')
            {
                continue;
            }
            const other = uniformRoots.get(symbol.name);
            if (other && glslName(other.type) !== glslName(symbol.type))
            {
                error(`uniform '${symbol.name}' has a different type in the two shaders`);
                continue;
            }
            if (!other)
            {
                uniformRoots.set(symbol.name, symbol);
            }
        }
    }
    /** @type {UniformLeaf[]} */
    const uniforms = [];
    /** @type {Map<number, { leaf: UniformLeaf, element: number }>} */
    const locations = new Map();
    /** @type {LinkedProgram["samplers"]} */
    const samplers = [];
    let nextLocation = 0;
    let storeWords = 0;
    for (const [rootName, symbol] of uniformRoots)
    {
        for (const leaf of leavesOf(rootName, symbol.type, []))
        {
            /** @type {UniformLeaf} */
            const entry = {
                name: leaf.array ? `${leaf.base}[0]` : leaf.base,
                base: leaf.base, root: rootName, path: leaf.path, type: leaf.type,
                size: leaf.size, location: nextLocation, offset: storeWords,
                words: wordsOf(leaf.type),
            };
            if (leaf.type.kind === 'sampler')
            {
                entry.samplerBindings = [];
                for (let k = 0; k < leaf.size; k++)
                {
                    entry.samplerBindings.push(samplers.length);
                    samplers.push({ leaf: entry, element: k, dim: leaf.type.dim,
                        shadow: leaf.type.shadow, type: leaf.type });
                }
            }
            for (let k = 0; k < leaf.size; k++)
            {
                locations.set(nextLocation + k, { leaf: entry, element: k });
            }
            nextLocation += leaf.size;
            storeWords += entry.words * leaf.size;
            uniforms.push(entry);
        }
    }
    if (samplers.length > GLSL_LIMITS.combinedTextureImageUnits)
    {
        error(`too many samplers: ${samplers.length}, at most`
            + ` ${GLSL_LIMITS.combinedTextureImageUnits}`);
    }
    const defaults = new ArrayBuffer(Math.max(4, storeWords * 4));
    {
        const floats = new Float32Array(defaults);
        const ints = new Int32Array(defaults);
        for (const leaf of uniforms)
        {
            const symbol = /** @type {VariableSymbol} */ (uniformRoots.get(leaf.root));
            const constant = symbol.initializer?.constant;
            if (!constant || leaf.path.length > 0)
            {
                continue;
            }
            const base = leaf.type.kind === 'sampler' ? 'int'
                : /** @type {any} */ (leaf.type).base ?? 'float';
            constant.forEach((/** @type {number} */ value, /** @type {number} */ k)=>{
                if (k < leaf.words * leaf.size)
                {
                    if (base === 'float')
                    {
                        floats[leaf.offset + k] = value;
                    }
                    else
                    {
                        ints[leaf.offset + k] = value;
                    }
                }
            });
        }
    }

    // --- fragment outputs ---
    let writesData = false;
    let fragmentOutputs = 1;
    if (fs)
    {
        const colour = fs.uses.has('gl_FragColor');
        writesData = fs.uses.has('gl_FragData');
        if (colour && writesData)
        {
            error('fragment shader writes both gl_FragColor and gl_FragData');
        }
        fragmentOutputs = writesData ? GLSL_LIMITS.drawBuffers : 1;
    }
    const outputs = fs ? fragmentOutputsOf(fs, fragDataBindings, error) : [];
    if (outputs.length > 0)
    {
        fragmentOutputs = Math.max(...outputs.map(o=>o.location
            + (o.type.kind === 'array' ? o.type.length : 1)));
    }

    // --- uniform blocks ---
    const { blocks, blockUniforms } = uniformBlocksOf(vs, gs, fs, error, cs);
    const linkedStages = { vertex: vs, geometry: gs, fragment: fs, compute: cs };
    const storageBlocks = storageBlocksOf(linkedStages, error);
    const counters = atomicCountersOf(linkedStages, error);

    if (errors.length > 0)
    {
        return { ok: false, log: `${errors.join('\n')}\n` };
    }
    return {
        ok: true,
        log: '',
        program: {
            vertex: vs, geometry: gs, geometryInputs, geometryLayout, feedback, fragment: fs,
            attributes, builtinAttributes, uniforms, locations,
            storeWords, defaults, varyings, samplers, writesData, fragmentOutputs, outputs,
            blocks, blockUniforms, storageBlocks, counters,
            ...cs ? { compute: cs, localSize: /** @type {[number, number, number]} */ (
                localSize) } : {},
        },
    };
}

/**
 * A compute shader's work group size (section 4.4.1.4 of the 4.30
 * language): declared in at least one of its shader objects, the same in
 * every one that declares it.
 *
 * @param {ShaderUnit[]} units @param {(message: string) => void} error
 * @returns {[number, number, number]}
 */
function localSizeOf(units, error){
    /** @type {[number, number, number] | null} */
    let size = null;
    for (const unit of units)
    {
        const layout = /** @type {Record<string, any>} */ (unit.layouts.input);
        const said = ['local_size_x', 'local_size_y', 'local_size_z'].map(k=>layout[k]);
        if (said.every(v=>typeof v !== 'number'))
        {
            continue;
        }
        const here = /** @type {[number, number, number]} */ (said.map(v=>(
            typeof v === 'number' ? v : 1)));
        if (size && size.some((v, k)=>v !== here[k]))
        {
            error('compute shader: the local size is declared differently in two shaders');
        }
        size = here;
    }
    if (!size)
    {
        error('compute shader: no local size is declared');
        return [1, 1, 1];
    }
    if (size[0] * size[1] * size[2] > COMPUTE_LIMITS.invocations)
    {
        error(`compute shader: a work group of ${size.join(' by ')} is more than`
            + ` GL_MAX_COMPUTE_WORK_GROUP_INVOCATIONS (${COMPUTE_LIMITS.invocations})`);
    }
    return size;
}

/**
 * A fragment shader's own outputs and their colour numbers (section 3.9.2 of
 * 3.0, 4.4.2 of the 3.30 language): `layout(location)` first, then
 * glBindFragDataLocation's, then the lowest free numbers in declaration order.
 *
 * @param {LinkedStage} fs
 * @param {Map<string, { location: number, index: number }>} bindings
 * @param {(message: string) => void} error
 * @returns {FragmentOutput[]}
 */
function fragmentOutputsOf(fs, bindings, error){
    const declared = fs.globals.filter(s=>s.storage === 'out' && !s.block);
    /** @type {FragmentOutput[]} */
    const outputs = [];
    /** @type {Set<string>} taken `location:index` pairs */
    const taken = new Set();
    /** @param {GlslType} type */
    const slots = type=>(type.kind === 'array' ? type.length : 1);
    /** @param {VariableSymbol} symbol @param {number} location @param {number} index */
    const place = (symbol, location, index)=>{
        if (location < 0 || location + slots(symbol.type) > GLSL_LIMITS.drawBuffers
            || index < 0 || index > 1 || (index === 1 && location + slots(symbol.type) > 1))
        {
            error(`fragment output '${symbol.name}' is at location ${location} index ${index},`
                + ` past the ${GLSL_LIMITS.drawBuffers} draw buffers`);
            return;
        }
        for (let k = 0; k < slots(symbol.type); k++)
        {
            const key = `${location + k}:${index}`;
            if (taken.has(key))
            {
                error(`fragment output '${symbol.name}' is at location ${location + k}, which`
                    + ' another output has');
                return;
            }
            taken.add(key);
        }
        outputs.push({ name: symbol.name, type: symbol.type, location, index });
    };
    /** @type {VariableSymbol[]} */
    const later = [];
    for (const symbol of declared)
    {
        const layout = symbol.qualifiers?.layout ?? {};
        const bound = bindings.get(symbol.name);
        if (typeof layout.location === 'number')
        {
            place(symbol, layout.location, typeof layout.index === 'number' ? layout.index : 0);
        }
        else if (bound)
        {
            place(symbol, bound.location, bound.index);
        }
        else
        {
            later.push(symbol);
        }
    }
    for (const symbol of later)
    {
        let location = 0;
        while (location < GLSL_LIMITS.drawBuffers && Array.from({ length: slots(symbol.type) },
            (_, k)=>taken.has(`${location + k}:0`)).some(Boolean))
        {
            location++;
        }
        place(symbol, location, 0);
    }
    return outputs;
}

/**
 * The uniform blocks the stages read (OpenGL 3.1 section 2.11.4), the
 * vertex stage's first, each by its index; a block several stages declare
 * is one block and is declared alike in each. A shared or packed block is
 * laid out as a std140 one: where it lies is the implementation's to say,
 * and the program asks.
 *
 * @param {LinkedStage | null} vs @param {LinkedStage | null} gs
 * @param {LinkedStage | null} fs
 * @param {(message: string) => void} error
 * @param {LinkedStage | null} [cs]
 * @returns {{ blocks: UniformBlock[], blockUniforms: BlockUniform[] }}
 */
function uniformBlocksOf(vs, gs, fs, error, cs = null){
    /** @type {UniformBlock[]} */
    const blocks = [];
    /** @type {BlockUniform[]} */
    const blockUniforms = [];
    /** @type {Map<string, { info: import('./glsl-check.js').InterfaceBlock, first: number }>} */
    const byName = new Map();
    for (const stage of [vs, gs, fs, cs])
    {
        if (!stage)
        {
            continue;
        }
        /** @type {Set<import('./glsl-check.js').InterfaceBlock>} */
        const used = new Set();
        /** @type {import('./glsl-check.js').InterfaceBlock[]} */
        const order = [];
        for (const symbol of stage.globals)
        {
            const info = symbol.block;
            if (symbol.storage !== 'uniform' || !info)
            {
                continue;
            }
            if (!order.includes(info))
            {
                order.push(info);
            }
            if (stage.uses.has(symbol.name))
            {
                used.add(info);
            }
        }
        const read = order.filter(info=>used.has(info));
        if (read.reduce((n, info)=>n + (info.arrays[0] ?? 1), 0) > BLOCK_LIMITS.perStage)
        {
            error(`${stage.stage} shader: more than ${BLOCK_LIMITS.perStage} uniform blocks`);
        }
        for (const info of read)
        {
            const known = byName.get(info.name);
            if (known)
            {
                if (shapeOf(known.info) !== shapeOf(info))
                {
                    error(`uniform block '${info.name}' is declared differently in two`
                        + ' shaders');
                    continue;
                }
                const count = known.info.arrays[0] ?? 1;
                for (let k = 0; k < count; k++)
                {
                    blocks[known.first + k].stages[stage.stage] = true;
                }
                continue;
            }
            /** @type {'std140' | 'std430'} */
            const packing = info.layout.std430 ? 'std430' : 'std140';
            const laid = info.laid ?? blockLayout(info.members.map(m=>({ name: m.name,
                type: m.type, rowMajor: !!m.layout.row_major })), 'std140');
            if (laid.size > BLOCK_LIMITS.size)
            {
                error(`uniform block '${info.name}' takes ${laid.size} bytes, more than`
                    + ` ${BLOCK_LIMITS.size}`);
                continue;
            }
            const first = blocks.length;
            byName.set(info.name, { info, first });
            const count = info.arrays[0] ?? 1;
            const binding = typeof info.layout.binding === 'number' ? info.layout.binding : 0;
            for (let k = 0; k < count; k++)
            {
                blocks.push({
                    name: info.arrays.length > 0 ? `${info.name}[${k}]` : info.name,
                    blockName: info.name, element: k, instance: info.instance,
                    size: laid.size, packing, members: laid.members,
                    stages: { vertex: stage === vs, geometry: stage === gs,
                        fragment: stage === fs, compute: stage === cs },
                    binding: typeof info.layout.binding === 'number' ? binding + k : 0,
                });
            }
            const prefix = info.instance ? `${info.name}.` : '';
            for (const variable of blockVariables(laid, packing))
            {
                blockUniforms.push({ name: `${prefix}${variable.name}`, type: variable.type,
                    size: variable.arraySize, block: first, offset: variable.offset,
                    arrayStride: variable.arrayStride, matrixStride: variable.matrixStride,
                    rowMajor: variable.rowMajor });
            }
        }
    }
    if (blocks.length > BLOCK_LIMITS.combined)
    {
        error(`more than ${BLOCK_LIMITS.combined} uniform blocks`);
    }
    return { blocks, blockUniforms };
}

/** @param {import('./glsl-check.js').InterfaceBlock} info @returns {string} */
function shapeOf(info){
    return `${info.arrays.join(',')}|${Object.keys(info.layout).sort().join(',')}|`
        + info.members.map(m=>`${glslName(m.type)} ${m.name}${m.layout.row_major ? ' r' : ''}`)
            .join(';');
}

/**
 * A stage's inputs or outputs between stages, by the name the other stage
 * matches: a variable's own, a block member's `Block.member`.
 *
 * @param {LinkedStage} stage @param {'in' | 'out'} direction
 * @param {(message: string) => void} error
 * @param {boolean} [arrayed]  a geometry shader's inputs: each an array a
 *     vertex, matched by its element (a path's `[]` the vertex)
 * @returns {{ name: string, type: GlslType, path: string, used: boolean, legacy: boolean,
 *     interpolation: 'smooth' | 'flat' | 'noperspective' | null, centroid: boolean }[]}
 */
function interfaceOf(stage, direction, error, arrayed = false){
    /** @type {ReturnType<typeof interfaceOf>} */
    const entries = [];
    for (const symbol of stage.globals)
    {
        if (symbol.storage !== direction && symbol.storage !== 'varying')
        {
            continue;
        }
        const used = stage.uses.has(symbol.name);
        const own = symbol.qualifiers;
        const block = symbol.block;
        const vertexed = arrayed && symbol.type.kind === 'array';
        const each = vertexed ? '[]' : '';
        if (block && block.instance === symbol.name)
        {
            if (symbol.type.kind === 'array' && !arrayed)
            {
                error(`${stage.stage} shader: an array of blocks '${block.name}' is passed`
                    + ' between stages, which this implementation does not do');
                continue;
            }
            for (const member of block.members)
            {
                entries.push({ name: `${block.name}.${member.name}`, type: member.type,
                    path: `g_${symbol.name}${each}.m_${member.name}`, used, legacy: false,
                    interpolation: member.qualifiers.interpolation ?? own?.interpolation ?? null,
                    centroid: member.qualifiers.centroid || !!own?.centroid });
            }
            continue;
        }
        entries.push({ name: block ? `${block.name}.${symbol.name}` : symbol.name,
            type: vertexed ? /** @type {any} */ (symbol.type).element : symbol.type,
            path: `g_${symbol.name}${each}`, used,
            legacy: symbol.storage === 'varying', interpolation: own?.interpolation ?? null,
            centroid: !!own?.centroid });
    }
    return entries;
}

/**
 * What transform feedback captures, each name an output of the stage before
 * the rasterizer (a block member as `Block.member`), an element of an array
 * one (`a[2]`), gl_Position or gl_PointSize, or a gap: gl_SkipComponents1 to
 * 4 leave words unwritten, gl_NextBuffer moves to the next buffer (OpenGL
 * 3.0 section 2.15, 4.0 section 2.14). A name no output has, or one named
 * twice, is a link error, as are more components than a buffer takes.
 *
 * @param {LinkedStage} stage
 * @param {{ names: readonly string[], mode: 'interleaved' | 'separate' }} given
 * @param {(message: string) => void} error
 * @returns {Feedback}
 */
function feedbackOf(stage, given, error){
    const outputs = new Map(interfaceOf(stage, 'out', ()=>{}).map(entry=>[entry.name, entry]));
    /** @type {Record<string, GlslType>} */
    const builtins = {};
    for (const name of ['gl_Position', 'gl_PointSize'])
    {
        const symbol = stage.builtins.get(name);
        if (symbol)
        {
            builtins[name] = symbol.type;
        }
    }
    const separate = given.mode === 'separate';
    /** @type {FeedbackVarying[]} */
    const varyings = [];
    /** @type {number[]} */
    const strides = [0];
    let buffer = 0;
    /** @type {Set<string>} */
    const named = new Set();
    for (const name of given.names)
    {
        const skip = /^gl_SkipComponents([1-4])$/.exec(name);
        if (skip || name === 'gl_NextBuffer')
        {
            if (separate)
            {
                error(`transform feedback varying '${name}' is named for separate buffers`);
                continue;
            }
            if (skip)
            {
                varyings.push({ name, type: null, size: Number(skip[1]), path: null, buffer,
                    word: strides[buffer] });
                strides[buffer] += Number(skip[1]);
            }
            else
            {
                varyings.push({ name, type: null, size: 0, path: null, buffer, word: 0 });
                buffer++;
                strides[buffer] = 0;
            }
            continue;
        }
        if (named.has(name))
        {
            error(`transform feedback varying '${name}' is named twice`);
            continue;
        }
        named.add(name);
        const parts = /^(.*?)(?:\[(\d+)\])?$/.exec(name) ?? [name, name, undefined];
        const base = parts[1];
        const element = parts[2] === undefined ? null : Number(parts[2]);
        const output = outputs.get(base);
        let type = output?.type ?? builtins[base];
        let path = output ? output.path : builtins[base] ? base : null;
        if (!type || path === null)
        {
            error(`transform feedback varying '${name}' is not an output of the ${stage.stage}`
                + ' shader');
            continue;
        }
        if (element !== null)
        {
            if (type.kind !== 'array' || element >= type.length)
            {
                error(`transform feedback varying '${name}' is past its array`);
                continue;
            }
            type = type.element;
            path = `${path}[${element}]`;
        }
        if (separate)
        {
            buffer = varyings.length;
            strides[buffer] = 0;
        }
        const words = wordsOf(type.kind === 'array' ? type.element : type)
            * (type.kind === 'array' ? type.length : 1);
        varyings.push({ name, type, size: type.kind === 'array' ? type.length : 1, path,
            buffer, word: strides[buffer] });
        strides[buffer] += words;
    }
    const most = separate ? FEEDBACK_LIMITS.separateComponents
        : FEEDBACK_LIMITS.interleavedComponents;
    if (strides.length > (separate ? FEEDBACK_LIMITS.separateAttribs : FEEDBACK_LIMITS.buffers))
    {
        error('transform feedback writes more buffers than there are');
    }
    if (strides.some(words=>words > most))
    {
        error(`transform feedback writes more than ${most} components to a buffer`);
    }
    return { mode: given.mode, varyings, strides };
}

/**
 * A geometry shader's primitives and its most vertices: each said by at
 * least one of its shader objects, and the same by every one that says it
 * (section 4.3.8 of 1.50, and OpenGL 3.2's link errors).
 *
 * @param {ShaderUnit[]} units @param {(message: string) => void} error
 * @returns {GeometryLayout | null}
 */
function geometryLayoutOf(units, error){
    /**
     * @param {'input' | 'output'} side @param {(name: string) => boolean} named
     * @returns {string | number | null}
     */
    const said = (side, named)=>{
        /** @type {string | number | null} */
        let value = null;
        for (const unit of units)
        {
            const layout = /** @type {Record<string, any>} */ (unit.layouts[side]);
            for (const [name, given] of Object.entries(layout))
            {
                if (!named(name))
                {
                    continue;
                }
                const mine = typeof given === 'number' ? given : name;
                if (value !== null && value !== mine)
                {
                    error(`geometry shader: two shaders declare different ${side} layouts`);
                }
                value = mine;
            }
        }
        return value;
    };
    const input = said('input', name=>GEOMETRY_INPUTS.has(name));
    const output = said('output', name=>GEOMETRY_OUTPUTS.has(name));
    const most = said('output', name=>name === 'max_vertices');
    if (input === null)
    {
        error('geometry shader: no input primitive is declared');
    }
    if (output === null)
    {
        error('geometry shader: no output primitive is declared');
    }
    if (most === null)
    {
        error('geometry shader: max_vertices is not declared');
    }
    if (input === null || output === null || most === null)
    {
        return null;
    }
    return {
        input: /** @type {GeometryLayout['input']} */ (input),
        inputVertices: /** @type {number} */ (GEOMETRY_INPUTS.get(String(input))),
        output: /** @type {GeometryLayout['output']} */ (output),
        outputVertices: /** @type {number} */ (GEOMETRY_OUTPUTS.get(String(output))),
        maxVertices: Number(most),
    };
}

/** @param {import('./glsl-types.js').StructType} struct @returns {string} */
function describe(struct){
    return struct.fields.map(field=>`${glslName(field.type)} ${field.name}`).join(';');
}

/**
 * What a program draws with: its last successful link, and the uniform
 * values that belong to it.
 *
 * @typedef {Object} Executable
 * @property {number} id  unique to the link, for a cache keyed by what a draw runs
 * @property {LinkedProgram} linked
 * @property {ArrayBuffer} store
 * @property {Float32Array} floats
 * @property {Int32Array} ints
 * @property {number} version  raised on every glUniform* that changes a value
 * @property {Int32Array} blockBindings  the binding point each uniform block
 *     reads (glUniformBlockBinding), by block index
 * @property {Int32Array} [storageBindings]  the binding point each shader storage
 *     block reads and writes (glShaderStorageBlockBinding), by block index
 */

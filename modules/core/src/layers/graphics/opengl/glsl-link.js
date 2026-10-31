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

import { BUILTIN_ATTRIBUTES, GLSL_LIMITS } from './glsl-builtins.js';
import { componentsOf, glslName } from './glsl-types.js';
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
 * @property {'vertex' | 'fragment'} stage
 * @property {UserFunction} main
 * @property {UserFunction[]} functions  the definitions main reaches, callees first
 * @property {VariableSymbol[]} globals  every global the stage's shaders declare
 * @property {Set<string>} uses  the names of the globals and built-ins main reaches
 * @property {import('./glsl-types.js').StructType[]} structs  one per name
 * @property {number} version
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
 * @typedef {Object} LinkedProgram
 * @property {LinkedStage | null} vertex
 * @property {LinkedStage | null} fragment
 * @property {{ name: string, type: GlslType, location: number }[]} attributes  active
 * @property {string[]} builtinAttributes  the conventional ones the vertex stage reads
 * @property {UniformLeaf[]} uniforms  active, in the order glGetActiveUniform lists them
 * @property {Map<number, { leaf: UniformLeaf, element: number }>} locations
 * @property {number} storeWords
 * @property {ArrayBuffer} defaults  the store as linking leaves it
 * @property {{ name: string, type: GlslType }[]} varyings  what the stages pass, by name
 * @property {{ leaf: UniformLeaf, element: number, dim: string, shadow: boolean }[]} samplers
 *     in binding order
 * @property {boolean} writesData  the fragment stage writes gl_FragData
 * @property {number} fragmentOutputs  how many colour outputs it writes at most
 */

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

/**
 * @param {{ vertex: ShaderUnit[], fragment: ShaderUnit[],
 *     attribBindings: Map<string, number> }} input
 * @returns {{ ok: true, log: string, program: LinkedProgram }
 *     | { ok: false, log: string }}
 */
export function linkProgram({ vertex, fragment, attribBindings }){
    /** @type {string[]} */
    const errors = [];
    /** @param {string} message */
    const error = message=>{
        errors.push(`ERROR: ${message}`);
    };

    if (vertex.length === 0 && fragment.length === 0)
    {
        return { ok: false, log: 'ERROR: no shaders are attached\n' };
    }

    /**
     * @param {'vertex' | 'fragment'} stage @param {ShaderUnit[]} units
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
        return {
            stage, main, functions: ordered, globals: [...globals.values()], uses,
            structs: [...structs.values()],
            version: Math.max(...units.map(unit=>unit.version)),
        };
    };

    const vs = mergeStage('vertex', vertex);
    const fs = mergeStage('fragment', fragment);
    if (errors.length > 0)
    {
        return { ok: false, log: `${errors.join('\n')}\n` };
    }

    /** @param {LinkedStage | null} stage @param {string} storage */
    const usedOf = (stage, storage)=>(stage
        ? stage.globals.filter(symbol=>symbol.storage === storage && stage.uses.has(symbol.name))
        : []);

    // --- varyings ---
    /** @type {{ name: string, type: GlslType }[]} */
    const varyings = [];
    if (vs && fs)
    {
        const declared = new Map(vs.globals.filter(s=>s.storage === 'varying')
            .map(s=>[s.name, s]));
        for (const symbol of usedOf(fs, 'varying'))
        {
            const from = declared.get(symbol.name);
            if (!from)
            {
                error(`fragment shader varying '${symbol.name}' is not declared in the vertex`
                    + ' shader');
                continue;
            }
            if (glslName(from.type) !== glslName(symbol.type))
            {
                error(`varying '${symbol.name}' has type ${glslName(from.type)} in the vertex`
                    + ` shader and ${glslName(symbol.type)} in the fragment shader`);
                continue;
            }
            varyings.push({ name: symbol.name, type: symbol.type });
        }
    }

    // --- attributes ---
    /** @type {{ name: string, type: GlslType, location: number }[]} */
    const attributes = [];
    const builtinAttributes = vs ? Object.keys(BUILTIN_ATTRIBUTES).filter(name=>vs.uses.has(name))
        : [];
    if (vs)
    {
        const active = usedOf(vs, 'attribute');
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
            const bound = attribBindings.get(symbol.name);
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
                taken.add(bound + k);
            }
            attributes.push({ name: symbol.name, type: symbol.type, location: bound });
        }
        let first = true;
        for (const symbol of active)
        {
            if (attribBindings.has(symbol.name))
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
    for (const stage of [vs, fs])
    {
        for (const symbol of usedOf(stage, 'uniform'))
        {
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
    /** @type {{ leaf: UniformLeaf, element: number, dim: string, shadow: boolean }[]} */
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
                        shadow: leaf.type.shadow });
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
    if (samplers.some(s=>s.dim === '3D'))
    {
        error('a 3D sampler is used, and this implementation has no 3D textures');
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

    if (errors.length > 0)
    {
        return { ok: false, log: `${errors.join('\n')}\n` };
    }
    return {
        ok: true,
        log: '',
        program: {
            vertex: vs, fragment: fs, attributes, builtinAttributes, uniforms, locations,
            storeWords, defaults, varyings, samplers, writesData, fragmentOutputs,
        },
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
 */

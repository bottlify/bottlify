/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A linked GLSL program as WGSL: each stage's declarations, functions and
 * entry point, written from the checked tree with every GLSL construct WGSL
 * lacks spelled out in what it has.
 *
 * What is decided here and is the contract with the renderer (`wgsl.js`,
 * `gpu.js`):
 *
 * - **Everything the shader declares is renamed**, by stage: `vg_x` a vertex
 *   global, `fl12_x` a fragment local, `vf3_f` a function. No GLSL name can
 *   then collide with a WGSL keyword or with the renderer's own names.
 * - **Uniforms are a block per stage**, the vertex stage's at group 0
 *   binding 17 and the fragment stage's at group 1 binding 18 (the ARB
 *   program blocks' places, `arb-wgsl.js`), every value in whole vec4 slots:
 *   a scalar or a vector one, a matrix one per column, an array or a struct
 *   the sum of its parts. Read, a slot becomes the value it holds; the plan
 *   (`BlockPlan`) says where each piece of the uniform store, each state
 *   value and each attribute's current value goes.
 * - **A sampler is a texture and a sampler binding pair** at group 0, from
 *   binding 1, two bindings per sampler of the program, visible to both
 *   stages; which unit's texture is bound there is the sampler uniform's
 *   value at the draw.
 * - **Attributes, varyings and the built-in variables are private
 *   variables**, filled from the entry point's inputs before `main` runs and
 *   read into its outputs after, so every function reaches them as GLSL
 *   does.
 * - **Window coordinates follow the target**: `uniforms.misc.z` is 1 where
 *   the target's rows run down from the top (the drawable's back buffer) and
 *   -1 where they run up (a framebuffer object's, drawn upside down so a
 *   texture holds its first row at t = 0), and `uniforms.misc.w` is its
 *   height. gl_Position's y, gl_FragCoord's y and dFdy's sign follow it.
 *
 * GLSL statements that are expressions in WGSL's eyes -- an assignment, an
 * increment, a call with `out` arguments inside a larger expression -- are
 * hoisted into statements before the one that holds them; `&&`, `||` and
 * `?:` whose right side would then run unconditionally become `if`s.
 */

import { FLOAT, baseOf, componentsOf, glslName, innermost, vectorOf } from './glsl-types.js';
import { BUILTIN_ATTRIBUTES, BUILTIN_VARIABLES } from './glsl-builtins.js';
import { canonicalAttribName } from './arb-program.js';
import { membersLayout, typeLayout } from './glsl-layout.js';

/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-types.js').StructType} StructType
 * @typedef {import('./glsl-link.js').LinkedProgram} LinkedProgram
 * @typedef {import('./glsl-link.js').LinkedStage} LinkedStage
 * @typedef {import('./glsl-check.js').VariableSymbol} VariableSymbol
 */

/** Where the stages' uniform blocks are bound. */
export const GLSL_VERTEX_BINDING = 17;
export const GLSL_FRAGMENT_BINDING = 18;
export const GLSL_FRAGMENT_GROUP = 1;

/** Where a program's uniform blocks are bound: group 0, from this binding on. */
export const GLSL_BLOCK_BINDING = 32;

/**
 * The declaration of a uniform block a stage reads: its bytes as words, read
 * where the layout puts each value (`readBlock`).
 *
 * @param {LinkedProgram} program @param {number} index
 * @returns {string}
 */
export function blockDeclaration(program, index){
    const size = Math.max(16, Math.ceil(program.blocks[index].size / 16) * 16);
    return `@group(0) @binding(${GLSL_BLOCK_BINDING + index}) var<uniform> glb${index}:`
        + ` array<vec4u, ${size / 16}>;`;
}

/** A sampler's texture binding; its sampler is the next one. @param {number} index */
export const samplerBinding = index=>1 + index * 2;

/**
 * The WGSL texture a sampler of a type reads: a 1D texture is a 2D one a
 * texel high (`texture.js`), a rectangle a 2D one, a depth texture compared
 * a float one (`textureCall`).
 *
 * @param {import('./glsl-types.js').SamplerType} type
 * @returns {string}
 */
export function textureTypeOf(type){
    const scalar = type.shadow ? 'f32' : SCALARS[type.sampled ?? 'float'];
    if (type.ms)
    {
        return `texture_multisampled_2d<${scalar}>`;
    }
    switch (type.dim)
    {
        case '3D':
            return `texture_3d<${scalar}>`;
        case 'Cube':
            return type.array ? `texture_cube_array<${scalar}>` : `texture_cube<${scalar}>`;
        case 'Buffer':
            throw new Error('a buffer texture is sampled, and this implementation has none');
        default:
            return type.array ? `texture_2d_array<${scalar}>` : `texture_2d<${scalar}>`;
    }
}

/**
 * What a bind group layout says of a sampler's texture: the view's
 * dimension and the sample type its shader reads.
 *
 * @param {import('./glsl-types.js').SamplerType} type
 * @returns {{ viewDimension: string, sampleType: string, multisampled: boolean }}
 */
export function textureLayoutOf(type){
    const sampleType = type.shadow || (type.sampled ?? 'float') === 'float' ? 'float'
        : type.sampled === 'int' ? 'sint' : 'uint';
    const viewDimension = type.dim === '3D' ? '3d' : type.dim === 'Cube'
        ? type.array ? 'cube-array' : 'cube' : type.array ? '2d-array' : '2d';
    return { viewDimension, sampleType, multisampled: !!type.ms };
}

/**
 * What a stage's uniform block holds and where, in 32-bit words.
 *
 * @typedef {Object} BlockPlan
 * @property {number} words  the block's size
 * @property {Int32Array} copies  triples: a store offset, a block offset, a count
 * @property {{ name: string, offset: number }[]} state  built-in state uniforms
 *     (`gl_ModelViewMatrix`, `gl_LightSource`, ...), each at its first slot
 * @property {{ location: number, builtin: string | null, offset: number,
 *     integer?: 'i32' | 'u32' }[]} attribs
 *     the current value of each attribute the draw has no array for, a slot each,
 *     an integer input's as integers
 * @property {number} [idBias]  where the draw's first vertex goes, which
 *     gl_VertexID counts from (`vertexIndex` + it)
 */

/**
 * @typedef {Object} StageOptions
 * @property {readonly import('./gpu-layout.js').DrawAttribute[]} attributes  the
 *     draw's arrays, at the locations their order gives
 * @property {boolean} flat  GL_FLAT: the colours are the provoking vertex's
 * @property {boolean} twoSide  GL_VERTEX_PROGRAM_TWO_SIDE: back faces read the
 *     back colours
 * @property {number | null} alphaFunc  the alpha test, which still follows a
 *     fragment shader
 * @property {number} targets  the colour targets the fragment stage writes
 * @property {string[]} [targetScalars]  each target's scalar, `f32` by default:
 *     `i32` or `u32` for an integer format
 * @property {(func: number, value: string, reference: string) => string} compare
 *     `wgsl.js`'s comparison, for the alpha test
 * @property {FixedVaryings} [fixed]  what the fixed fragment stage reads, when it is
 *     the vertex shader's partner
 */

/**
 * @typedef {Object} FixedVaryings
 * @property {number[]} texcoords  the coordinate sets the fixed fragment stage samples
 * @property {string | null} fog  the fog factor of the coordinate `c`, when fog is on
 */

/**
 * The fields of the struct the two stages pass, each a location of its own.
 *
 * @typedef {{ field: string, type: string, flat: boolean, source: string,
 *     interpolate?: string }[]} Interface
 */

/**
 * The attribute a field the stages pass is declared with: GLSL's
 * interpolation and centroid, as WGSL spells them.
 *
 * @param {import('./glsl-link.js').Varying} varying
 * @returns {string}
 */
function interpolateOf(varying){
    if (varying.interpolation === 'flat')
    {
        return '@interpolate(flat) ';
    }
    const kind = varying.interpolation === 'noperspective' ? 'linear' : 'perspective';
    if (varying.centroid)
    {
        return `@interpolate(${kind}, centroid) `;
    }
    return kind === 'linear' ? '@interpolate(linear) ' : '';
}

/** @param {number} value @returns {string} a WGSL f32 literal */
export function floatLiteral(value){
    const v = Math.fround(value);
    if (Number.isNaN(v))
    {
        return 'bitcast<f32>(0x7fc00000u)';
    }
    if (!Number.isFinite(v))
    {
        return v > 0 ? 'bitcast<f32>(0x7f800000u)' : 'bitcast<f32>(0xff800000u)';
    }
    let text = String(v);
    if (!/[.eE]/.test(text))
    {
        text += '.0';
    }
    return `${text}f`;
}

/** @param {number} value @returns {string} a WGSL i32 literal */
export function intLiteral(value){
    const v = value | 0;
    if (v === -2147483648)
    {
        return '(-2147483647i - 1i)';
    }
    return v < 0 ? `(${v}i)` : `${v}i`;
}

/**
 * The struct the stages pass when both are the program's: the position, and
 * a location for each field the vertex stage chose, the colours flat under
 * GL_FLAT.
 *
 * @param {Interface} fields
 * @returns {string}
 */
export function interfaceStruct(fields){
    return `struct VertexOut {
    @builtin(position) @invariant position: vec4f,
${fields.map((f, k)=>`    @location(${k}) ${f.interpolate ?? (f.flat
        ? '@interpolate(flat) ' : '')}${f.field}: ${f.type},`).join('\n')}
};`;
}

/** How many vec4 slots a value takes in a block. @param {GlslType} type @returns {number} */
export function slotsOf(type){
    switch (type.kind)
    {
        case 'matrix':
            return type.cols;
        case 'array':
            return type.length * slotsOf(type.element);
        case 'struct':
            return type.fields.reduce((sum, field)=>sum + slotsOf(field.type), 0);
        default:
            return 1;
    }
}

/**
 * The struct each stage's emitter names structs under, and the padded form
 * each uniform struct is read from.
 *
 * @param {string} prefix
 */
const namer = prefix=>({
    /** @param {StructType} struct */
    value: struct=>`${prefix}s_${struct.name}`,
    /** @param {StructType} struct */
    padded: struct=>`${prefix}su_${struct.name}`,
});

/**
 * The WGSL type a value is held in, in a uniform block.
 *
 * @param {GlslType} type @param {(s: StructType) => string} padded
 * @returns {string}
 */
function paddedType(type, padded){
    switch (type.kind)
    {
        case 'scalar':
        case 'vector':
            return type.base === 'float' ? 'vec4f' : type.base === 'uint' ? 'vec4u' : 'vec4i';
        case 'matrix':
            return type.rows === 2 ? `array<vec4f, ${type.cols}>` : `mat${type.cols}x${type.rows}f`;
        case 'array':
            return `array<${paddedType(type.element, padded)}, ${type.length}>`;
        case 'struct':
            return padded(type);
        default:
            return 'vec4i';
    }
}

/**
 * @param {GlslType} type @param {(s: StructType) => string} structName
 * @returns {string}
 */
function wgslType(type, structName){
    switch (type.kind)
    {
        case 'scalar':
            if (type.base === 'double')
            {
                throw new Error('glsl: a double has no WGSL type, and this implementation'
                    + ' carries none');
            }
            return SCALARS[type.base];
        case 'vector':
            if (type.base === 'double')
            {
                throw new Error('glsl: a double has no WGSL type, and this implementation'
                    + ' carries none');
            }
            return type.base === 'bool' ? `vec${type.size}<bool>`
                : `vec${type.size}${suffixOf(SCALARS[type.base])}`;
        case 'matrix':
            if (type.base === 'double')
            {
                throw new Error('glsl: a double has no WGSL type, and this implementation'
                    + ' carries none');
            }
            return `mat${type.cols}x${type.rows}f`;
        case 'struct':
            return structName(type);
        case 'array':
            return `array<${wgslType(type.element, structName)}, ${type.length}>`;
        default:
            throw new Error(`glsl: a ${glslName(type)} has no WGSL value type`);
    }
}

/**
 * Whether reading a padded value needs more than its expression: a type
 * whose block form is its value form needs nothing.
 *
 * @param {GlslType} type
 * @returns {boolean}
 */
function paddedIsValue(type){
    switch (type.kind)
    {
        case 'vector':
            return type.size === 4 && type.base !== 'bool';
        case 'matrix':
            return type.rows !== 2;
        case 'array':
            return paddedIsValue(type.element);
        default:
            return false;
    }
}

/** The swizzle letters. */
const XYZW = 'xyzw';

/** The WGSL scalar of each GLSL one. */
const SCALARS = /** @type {Record<string, string>} */ ({ float: 'f32', int: 'i32', uint: 'u32',
    bool: 'bool' });

/** The vector suffix of each WGSL scalar. @param {string} scalar */
const suffixOf = scalar=>(scalar === 'f32' ? 'f' : scalar === 'i32' ? 'i' : 'u');

/** An expression read twice as cheaply as once: a name, a member, a literal. */
const SIMPLE = /^([A-Za-z_][A-Za-z0-9_.]*|[0-9][0-9.e+]*[fi]?)$/;

/**
 * @param {LinkedProgram} program
 * @param {'vertex' | 'fragment'} which
 * @param {StageOptions} options
 * @param {Interface | null} given  the interface the other stage chose, for
 *     the fragment stage; null for the vertex stage, which chooses it
 * @param {'glsl' | 'fixed'} partner  whether the other stage is the
 *     program's or the fixed pipeline's
 */
export function emitStage(program, which, options, given, partner){
    const linked = /** @type {LinkedStage} */ (program[which]);
    const vertex = which === 'vertex';
    const p = vertex ? 'v' : 'f';
    const names = namer(p);
    /** @param {StructType} s */
    const structName = s=>names.value(s);
    /** @param {GlslType} t */
    const typeOf = t=>wgslType(t, structName);
    /**
     * A built-in variable's type as this stage's version gives it, or
     * undefined for a name that is not a built-in.
     *
     * @param {string} name @returns {GlslType | undefined}
     */
    const builtinTypeOf = name=>{
        const symbol = linked.builtins?.get(name);
        if (symbol)
        {
            return symbol.builtin?.role === 'const' ? undefined : symbol.type;
        }
        return BUILTIN_VARIABLE_TYPES[which][name];
    };

    /** @type {string[]} */
    const declarations = [];
    /** @type {Set<StructType>} */
    const declaredStructs = new Set();
    /** @type {Set<StructType>} */
    const paddedStructs = new Set();
    /** @type {string[]} */
    const loaders = [];

    /** @param {GlslType} type */
    const declareStructs = type=>{
        if (type.kind === 'array')
        {
            declareStructs(type.element);
            return;
        }
        if (type.kind !== 'struct' || declaredStructs.has(type))
        {
            return;
        }
        for (const field of type.fields)
        {
            declareStructs(field.type);
        }
        declaredStructs.add(type);
        declarations.push(`struct ${structName(type)} {\n${type.fields.map(field=>
            `    m_${field.name}: ${typeOf(field.type)},`).join('\n')}\n};`);
    };
    /** @param {GlslType} type */
    const declarePadded = type=>{
        if (type.kind === 'array')
        {
            declarePadded(type.element);
            return;
        }
        if (type.kind !== 'struct' || paddedStructs.has(type))
        {
            return;
        }
        declareStructs(type);
        for (const field of type.fields)
        {
            declarePadded(field.type);
        }
        paddedStructs.add(type);
        declarations.push(`struct ${names.padded(type)} {\n${type.fields.map(field=>
            `    m_${field.name}: ${paddedType(field.type, names.padded)},`).join('\n')}\n};`);
        // A whole struct read out of a block becomes its value form here.
        const fields = type.fields.map(field=>readPadded(`u.m_${field.name}`, field.type));
        loaders.push(`fn ${p}load_${type.name}(u: ${names.padded(type)}) -> ${structName(type)} {
    return ${structName(type)}(${fields.join(', ')});
}`);
    };

    /**
     * A padded value read as the value it holds.
     *
     * @param {string} code @param {GlslType} type
     * @returns {string}
     */
    function readPadded(code, type){
        switch (type.kind)
        {
            case 'scalar':
                return type.base === 'bool' ? `(${code}.x != 0i)` : `${code}.x`;
            case 'vector': {
                const swizzle = type.size === 4 ? '' : `.${XYZW.slice(0, type.size)}`;
                return type.base === 'bool'
                    ? `(${code}${swizzle} != vec${type.size}i(0i))` : `${code}${swizzle}`;
            }
            case 'matrix':
                return type.rows === 2
                    ? `mat${type.cols}x2f(${Array.from({ length: type.cols }, (_, c)=>
                        `${code}[${c}].xy`).join(', ')})`
                    : code;
            case 'struct':
                return `${p}load_${type.name}(${code})`;
            case 'array':
                if (paddedIsValue(type))
                {
                    return code;
                }
                return `${typeOf(type)}(${Array.from({ length: type.length }, (_, k)=>
                    readPadded(`${code}[${k}]`, type.element)).join(', ')})`;
            default:
                return code;
        }
    }

    // --- the block ---

    /** @type {BlockPlan} */
    const plan = { words: 0, copies: new Int32Array(0), state: [], attribs: [] };
    /** @type {string[]} */
    const blockMembers = [];
    let slot = 0;
    /** @type {number[]} */
    const copies = [];
    /** The block member each uniform root is read through, by name. */
    /** @type {Map<string, string>} */
    const uniformMember = new Map();
    /** @type {Map<string, string>} */
    const stateMember = new Map();
    /** @type {Map<number, string>} */
    const attribMember = new Map();

    /**
     * The copies that put a leaf's store words at its slots.
     *
     * @param {GlslType} type @param {number} at  the slot @param {number} from  the word
     * @param {number} count  elements
     */
    const planLeaf = (type, at, from, count)=>{
        for (let element = 0; element < count; element++)
        {
            const base = at + element * slotsOf(type);
            const words = componentsOf(type) || 1;
            if (type.kind === 'matrix')
            {
                for (let c = 0; c < type.cols; c++)
                {
                    copies.push(from + element * words + c * type.rows, (base + c) * 4,
                        type.rows);
                }
            }
            else
            {
                copies.push(from + element * words, base * 4, words);
            }
        }
    };

    for (const symbol of linked.globals)
    {
        if (symbol.storage !== 'uniform' || !linked.uses.has(symbol.name) || symbol.block
            || symbol.subroutine || symbol.type.kind === 'sampler'
            || (symbol.type.kind === 'array' && symbol.type.element.kind === 'sampler'))
        {
            continue;
        }
        declarePadded(symbol.type);
        const member = `u_${symbol.name}`;
        blockMembers.push(`    ${member}: ${paddedType(symbol.type, names.padded)},`);
        uniformMember.set(symbol.name, `${p}u.${member}`);
        for (const leaf of program.uniforms.filter(l=>l.root === symbol.name))
        {
            planLeaf(leaf.type, slot + slotOffset(symbol.type, leaf.path), leaf.offset,
                leaf.size);
        }
        slot += slotsOf(symbol.type);
    }
    // The built-in state uniforms the stage reads.
    for (const name of linked.uses)
    {
        const builtin = STATE_UNIFORMS.get(name);
        if (!builtin)
        {
            continue;
        }
        declarePadded(builtin);
        const member = `s_${name}`;
        blockMembers.push(`    ${member}: ${paddedType(builtin, names.padded)},`);
        stateMember.set(name, `${p}u.${member}`);
        plan.state.push({ name, offset: slot * 4 });
        slot += slotsOf(builtin);
    }

    /**
     * The slot within a root a leaf's path reaches.
     *
     * @param {GlslType} type @param {string[]} path
     * @returns {number}
     */
    function slotOffset(type, path){
        let at = 0;
        let current = type;
        for (const step of path)
        {
            if (step.startsWith('.'))
            {
                const struct = /** @type {StructType} */ (current);
                const name = step.slice(1);
                for (const field of struct.fields)
                {
                    if (field.name === name)
                    {
                        current = field.type;
                        break;
                    }
                    at += slotsOf(field.type);
                }
            }
            else
            {
                const array = /** @type {import('./glsl-types.js').ArrayType} */ (current);
                at += Number(step.slice(1, -1)) * slotsOf(array.element);
                current = array.element;
            }
        }
        return at;
    }

    // --- the vertex inputs ---

    /** @type {string[]} */
    const prologue = [];
    /** @type {string[]} */
    const privates = [];

    const layoutNames = options.attributes.map(a=>a.name);

    /**
     * An array's value widened to `components` floats, as GL fills them.
     *
     * @param {import('./gpu-layout.js').DrawAttribute} attribute @param {number} components
     */
    const attributeValue = (attribute, components, scalar = 'f32')=>{
        const source = `vertex.${attribute.name}`;
        const n = attribute.components;
        const v = suffixOf(scalar);
        // An integer input reads its array's integers (glVertexAttribIPointer);
        // a float array read as integers is the specification's undefined.
        const converted = attribute.scalar === scalar ? source
            : n === 1 ? `${scalar}(${source})` : `vec${n}${v}(${source})`;
        const [zero, one] = scalar === 'f32' ? ['0.0', '1.0'] : [`0${v}`, `1${v}`];
        const four = n === 4 ? converted
            : n === 1 ? `vec4${v}(${converted}, ${zero}, ${zero}, ${one})`
                : n === 2 ? `vec4${v}(${converted}, ${zero}, ${one})`
                    : `vec4${v}(${converted}, ${one})`;
        return components === 4 ? four : components === 1 ? `${four}.x`
            : `${four}.${XYZW.slice(0, components)}`;
    };

    /**
     * The block slot an attribute's current value is read from when the draw
     * has no array for it.
     *
     * @param {number} location @param {string | null} builtin
     */
    const currentSlot = (location, builtin, scalar = 'f32')=>{
        const existing = attribMember.get(location);
        if (existing)
        {
            return existing;
        }
        const member = `a_${location}`;
        blockMembers.push(`    ${member}: vec4${suffixOf(scalar)},`);
        plan.attribs.push({ location, builtin, offset: slot * 4,
            ...scalar === 'f32' ? {} : { integer: /** @type {'i32' | 'u32'} */ (scalar) } });
        slot++;
        const read = `${p}u.${member}`;
        attribMember.set(location, read);
        return read;
    };

    if (vertex)
    {
        for (const attribute of program.attributes)
        {
            const type = attribute.type;
            const columns = type.kind === 'matrix' ? type.cols : 1;
            const rows = type.kind === 'matrix' ? type.rows : componentsOf(type);
            const scalar = SCALARS[baseOf(type) ?? 'float'];
            /** @type {string[]} */
            const parts = [];
            for (let c = 0; c < columns; c++)
            {
                const location = attribute.location + c;
                const name = canonicalAttribName(location);
                const index = layoutNames.indexOf(name);
                const four = index >= 0 ? attributeValue(options.attributes[index], 4, scalar)
                    : currentSlot(location, null, scalar);
                parts.push(rows === 4 ? four : rows === 1 ? `${four}.x`
                    : `${four}.${XYZW.slice(0, rows)}`);
            }
            const value = type.kind === 'matrix' ? `${typeOf(type)}(${parts.join(', ')})`
                : parts[0];
            prologue.push(`    ${p}g_${attribute.name} = ${value};`);
        }
        for (const name of program.builtinAttributes)
        {
            const layoutName = /** @type {any} */ (BUILTIN_ATTRIBUTES)[name];
            const builtin = /** @type {GlslType} */ (builtinTypeOf(name));
            const components = componentsOf(builtin);
            const index = layoutNames.indexOf(layoutName);
            const location = locationOfCanonical(layoutName);
            const value = index >= 0 ? attributeValue(options.attributes[index], components)
                : name === 'gl_Vertex' ? 'vec4f(0.0, 0.0, 0.0, 1.0)'
                    : (()=>{
                        const four = currentSlot(location, name);
                        return components === 4 ? four : components === 1 ? `${four}.x`
                            : `${four}.${XYZW.slice(0, components)}`;
                    })();
            prologue.push(`    ${p}${name} = ${value};`);
        }
    }

    // --- private variables: globals, built-ins, and the interface ---

    for (const symbol of linked.globals)
    {
        if (symbol.storage === 'uniform' || symbol.storage === 'buffer')
        {
            continue;
        }
        declareStructs(symbol.type);
        privates.push(`var<private> ${p}g_${symbol.name}: ${typeOf(symbol.type)};`);
    }
    for (const name of linked.uses)
    {
        const type = builtinTypeOf(name);
        if (!type || STATE_UNIFORMS.has(name) || CONSTANTS.has(name)
            || (linked.builtins?.get(name)?.builtin?.role === 'uniform'))
        {
            continue;
        }
        privates.push(`var<private> ${p}${name}: ${typeOf(type)};`);
    }
    // What the entry point reads whether or not main wrote it.
    const read = vertex ? [['gl_Position', 'vec4f']]
        : [[program.writesData ? 'gl_FragData' : 'gl_FragColor',
            program.writesData ? 'array<vec4f, 4>' : 'vec4f']];
    for (const [name, type] of read)
    {
        if (!linked.uses.has(name))
        {
            privates.push(`var<private> ${p}${name}: ${type};`);
        }
    }

    // --- functions ---

    let temps = 0;
    /** @type {Map<string, string>} */
    const functionNames = new Map();
    linked.functions.forEach((fn, k)=>{
        functionNames.set(fn.key, fn.name === 'main' ? `${p}main` : `${p}f${k}_${fn.name}`);
    });
    /** The texture and sampler a sampler uniform is bound to, by name. */
    /** @type {Map<string, number>} */
    const samplerOf = new Map(program.samplers.map((s, k)=>[`${s.leaf.base}#${s.element}`, k]));
    /** @type {Set<number>} */
    const usedSamplers = new Set();
    /** The sizes of matrix the stage inverts. @type {Set<number>} */
    const usedInverses = new Set();

    /**
     * @typedef {Object} Emit
     * @property {string[]} pre  the statements an expression hoisted, in order
     */

    /** @param {Emit} out @param {string} code @param {string} type */
    const temp = (out, code, type)=>{
        const name = `t${temps++}`;
        out.pre.push(`let ${name}: ${type} = ${code};`);
        return name;
    };
    /** @param {Emit} out @param {string} code @param {GlslType} type */
    const once = (out, code, type)=>(SIMPLE.test(code) ? code : temp(out, code, typeOf(type)));

    /** @param {number[]} constant @param {GlslType} type @returns {string} */
    const constantCode = (constant, type)=>{
        const base = baseOf(type);
        /** @param {number} v */
        const scalar = v=>(base === 'float' ? floatLiteral(v) : base === 'int' ? intLiteral(v)
            : base === 'uint' ? `${v >>> 0}u` : v ? 'true' : 'false');
        if (type.kind === 'scalar')
        {
            return scalar(constant[0]);
        }
        return `${typeOf(type)}(${constant.map(scalar).join(', ')})`;
    };

    /**
     * Whether evaluating a node can change anything: an assignment, an
     * increment, or a call of the program's own functions.
     *
     * @param {any} node
     * @returns {boolean}
     */
    const effects = node=>{
        if (!node || typeof node !== 'object')
        {
            return false;
        }
        if (node.node === 'assign' || node.node === 'postfix'
            || (node.node === 'unary' && (node.op === '++' || node.op === '--'))
            || (node.node === 'call' && node.user))
        {
            return true;
        }
        for (const key of ['object', 'index', 'operand', 'left', 'right', 'test', 'then',
            'otherwise', 'value', 'target'])
        {
            if (effects(node[key]))
            {
                return true;
            }
        }
        return (node.args ?? node.expressions ?? []).some(effects);
    };


    // --- uniform blocks: read word by word where the layout puts each value ---

    /** The blocks the stage reads, by index. @type {Set<number>} */
    const usedBlocks = new Set();
    /** The blocks a dynamic offset reads, which need a word reader. @type {Set<number>} */
    const dynamicBlocks = new Set();

    /**
     * A place in a block: its index, a byte offset known now (`at`) plus one
     * computed (`plus`, a u32 expression or null), the type there, and how
     * that type lies: a vector's components `step` bytes apart, a matrix's
     * columns or rows `matrixStride`, an array's elements `arrayStride`.
     *
     * @typedef {Object} BlockPlace
     * @property {number} block
     * @property {number} at
     * @property {string | null} plus
     * @property {GlslType} type
     * @property {number} step
     * @property {number} arrayStride
     * @property {number} matrixStride
     * @property {boolean} rowMajor
     * @property {'std140' | 'std430'} packing
     */

    /**
     * The block a uniform block's declaration names, for an element of an
     * array of blocks.
     *
     * @param {import('./glsl-check.js').InterfaceBlock} info @param {number} element
     * @returns {number}
     */
    const blockIndex = (info, element)=>{
        const index = (program.blocks ?? []).findIndex(b=>b.blockName === info.name
            && b.element === element);
        if (index < 0)
        {
            throw new Error(`glsl: the uniform block '${info.name}' is not active`);
        }
        return index;
    };

    /**
     * Where a type lies when it is placed at a place's offset.
     *
     * @param {number} block @param {number} at @param {string | null} plus
     * @param {GlslType} type @param {boolean} rowMajor @param {'std140' | 'std430'} packing
     * @returns {BlockPlace}
     */
    const placeOf = (block, at, plus, type, rowMajor, packing)=>{
        const laid = typeLayout(type, packing, rowMajor);
        return { block, at, plus, type, step: 4, arrayStride: laid.arrayStride ?? 0,
            matrixStride: laid.matrixStride ?? 0, rowMajor, packing };
    };

    /**
     * The place an expression reads in a uniform block, or null for anything
     * not in one; an instance name alone is `{ instance }`.
     *
     * @param {any} node @param {Emit} out
     * @returns {BlockPlace | { instance: import('./glsl-check.js').InterfaceBlock,
     *     element: number, type: GlslType } | null}
     */
    function blockPlace(node, out){
        if (node.node === 'name')
        {
            const symbol = /** @type {VariableSymbol} */ (node.symbol);
            const info = symbol.block;
            if (symbol.storage !== 'uniform' || !info)
            {
                return null;
            }
            if (info.instance === symbol.name)
            {
                return { instance: info, element: 0, type: symbol.type };
            }
            const index = blockIndex(info, 0);
            const member = /** @type {import('./glsl-link.js').UniformBlock[]} */ (program.blocks)
                [index].members.find(m=>m.name === symbol.name);
            if (!member)
            {
                throw new Error(`glsl: '${symbol.name}' is not in its block's layout`);
            }
            usedBlocks.add(index);
            return placeOf(index, member.offset, null, member.type, !!member.rowMajor,
                program.blocks[index].packing);
        }
        if (node.node === 'field' && node.member)
        {
            const inner = blockPlace(node.object, out);
            if (!inner)
            {
                return null;
            }
            if ('instance' in inner)
            {
                const index = blockIndex(inner.instance, inner.element);
                const member = program.blocks[index].members.find(m=>m.name === node.member);
                if (!member)
                {
                    throw new Error(`glsl: '${node.member}' is not in its block's layout`);
                }
                usedBlocks.add(index);
                return placeOf(index, member.offset, null, member.type, !!member.rowMajor,
                    program.blocks[index].packing);
            }
            const struct = /** @type {StructType} */ (inner.type);
            const laid = membersLayout(struct.fields.map(f=>({ name: f.name, type: f.type,
                rowMajor: inner.rowMajor })), inner.packing);
            const member = /** @type {import('./glsl-layout.js').MemberLayout} */ (laid.find(m=>
                m.name === node.member));
            return placeOf(inner.block, inner.at + member.offset, inner.plus, member.type,
                inner.rowMajor, inner.packing);
        }
        if (node.node === 'index')
        {
            const inner = blockPlace(node.object, out);
            if (!inner)
            {
                return null;
            }
            if ('instance' in inner)
            {
                if (!node.index.constant)
                {
                    throw new Error('an array of uniform blocks is indexed by a constant only');
                }
                const array = /** @type {import('./glsl-types.js').ArrayType} */ (inner.type);
                return { instance: inner.instance, element: node.index.constant[0],
                    type: array.element };
            }
            const type = inner.type;
            const constant = node.index.constant ? node.index.constant[0] : null;
            /** @param {number} stride */
            const moved = stride=>(constant !== null
                ? { at: inner.at + constant * stride, plus: inner.plus }
                : { at: inner.at, plus: `${inner.plus === null ? '' : `${inner.plus} + `}`
                    + `u32(${expr(node.index, out)}) * ${stride}u` });
            if (type.kind === 'array')
            {
                const { at, plus } = moved(inner.arrayStride);
                return placeOf(inner.block, at, plus, type.element, inner.rowMajor,
                    inner.packing);
            }
            if (type.kind === 'matrix')
            {
                // A column: a vector of a column-major matrix, the column's
                // components of each row of a row-major one.
                const { at, plus } = moved(inner.rowMajor ? 4 : inner.matrixStride);
                return { ...placeOf(inner.block, at, plus, vectorOf('float', type.rows), false,
                    inner.packing), step: inner.rowMajor ? inner.matrixStride : 4 };
            }
            const { at, plus } = moved(inner.step);
            return placeOf(inner.block, at, plus, vectorOf(
                /** @type {any} */ (baseOf(type)), 1), false, inner.packing);
        }
        return null;
    }

    /**
     * The 32-bit word at a byte offset of a block.
     *
     * @param {number} block @param {number} at @param {string | null} plus
     */
    const blockWord = (block, at, plus)=>{
        if (plus === null)
        {
            return `glb${block}[${at >> 4}].${XYZW[(at >> 2) & 3]}`;
        }
        dynamicBlocks.add(block);
        return `${p}ubw${block}(${plus}${at === 0 ? '' : ` + ${at}u`})`;
    };

    /**
     * A block's value at a place, built from its words.
     *
     * @param {BlockPlace} place
     * @returns {string}
     */
    function readBlock(place){
        const { block, at, plus, type } = place;
        switch (type.kind)
        {
            case 'scalar': {
                const word = blockWord(block, at, plus);
                return type.base === 'uint' ? word : type.base === 'bool' ? `(${word} != 0u)`
                    : `bitcast<${SCALARS[type.base]}>(${word})`;
            }
            case 'vector': {
                const n = type.size;
                const first = (at >> 2) & 3;
                const words = plus === null && place.step === 4 && first + n <= 4
                    ? `glb${block}[${at >> 4}].${XYZW.slice(first, first + n)}`
                    : `vec${n}u(${Array.from({ length: n }, (_, k)=>blockWord(block,
                        at + k * place.step, plus)).join(', ')})`;
                return type.base === 'uint' ? words : type.base === 'bool'
                    ? `(${words} != vec${n}u(0u))` : `bitcast<${typeOf(type)}>(${words})`;
            }
            case 'matrix': {
                const columns = Array.from({ length: type.cols }, (_, c)=>readBlock({
                    ...place, type: vectorOf('float', type.rows),
                    at: at + c * (place.rowMajor ? 4 : place.matrixStride),
                    step: place.rowMajor ? place.matrixStride : 4 }));
                return `${typeOf(type)}(${columns.join(', ')})`;
            }
            case 'array': {
                const elements = Array.from({ length: type.length }, (_, k)=>readBlock(placeOf(
                    block, at + k * place.arrayStride, plus, type.element, place.rowMajor,
                    place.packing)));
                return `${typeOf(type)}(${elements.join(', ')})`;
            }
            case 'struct': {
                declareStructs(type);
                const laid = membersLayout(type.fields.map(f=>({ name: f.name, type: f.type,
                    rowMajor: place.rowMajor })), place.packing);
                return `${typeOf(type)}(${laid.map(m=>readBlock(placeOf(block, at + m.offset,
                    plus, m.type, place.rowMajor, place.packing))).join(', ')})`;
            }
            default:
                throw new Error(`glsl: a ${glslName(type)} cannot be read from a block`);
        }
    }

    /**
     * An expression's value when it reads a uniform block, or null.
     *
     * @param {any} node @param {Emit} out
     * @returns {string | null}
     */
    const fromBlock = (node, out)=>{
        const place = blockPlace(node, out);
        if (!place)
        {
            return null;
        }
        if ('instance' in place)
        {
            throw new Error('a uniform block instance is read whole, which GLSL does not let'
                + ' a program do');
        }
        return readBlock(place);
    };

    /**
     * A uniform reached through members and indices, still in its block
     * form, or null for anything else.
     *
     * @param {any} node @param {Emit} out
     * @returns {{ code: string, type: GlslType } | null}
     */
    function padded(node, out){
        if (node.node === 'name')
        {
            const symbol = /** @type {VariableSymbol} */ (node.symbol);
            if (symbol.storage === 'uniform' && symbol.type.kind !== 'sampler')
            {
                const member = uniformMember.get(symbol.name);
                return member ? { code: member, type: symbol.type } : null;
            }
            const state = stateMember.get(symbol.name);
            return state ? { code: state, type: symbol.type } : null;
        }
        if (node.node === 'field' && node.member)
        {
            const inner = padded(node.object, out);
            return inner ? { code: `${inner.code}.m_${node.member}`, type: node.type } : null;
        }
        if (node.node === 'index' && node.object.type.kind === 'array')
        {
            const inner = padded(node.object, out);
            return inner ? { code: `${inner.code}[${expr(node.index, out)}]`, type: node.type }
                : null;
        }
        return null;
    }

    /**
     * The sampler a texture call's first argument names: a uniform's pair,
     * or a parameter's.
     *
     * @param {any} node
     * @returns {string}  `texture, sampler`
     */
    const samplerPair = node=>{
        if (node.node === 'name' && node.symbol.storage === 'param')
        {
            const id = node.symbol.id;
            return `pt${id}_${node.symbol.name}, ps${id}_${node.symbol.name}`;
        }
        let base = null;
        let element = 0;
        if (node.node === 'name')
        {
            base = node.symbol.name;
        }
        else if (node.node === 'index' && node.object.node === 'name' && node.index.constant)
        {
            base = node.object.symbol.name;
            element = node.index.constant[0];
        }
        else if (node.node === 'field')
        {
            base = describePath(node);
        }
        const index = base === null ? undefined : samplerOf.get(`${base}#${element}`);
        if (index === undefined)
        {
            throw new Error('a sampler must be named by a uniform, a parameter, or an array'
                + ' element with a constant index');
        }
        usedSamplers.add(index);
        return `glt${index}, gls${index}`;
    };

    /** @param {any} node @returns {string} */
    function describePath(node){
        if (node.node === 'name')
        {
            return node.symbol.name;
        }
        if (node.node === 'field')
        {
            return `${describePath(node.object)}.${node.name}`;
        }
        return `${describePath(node.object)}[${node.index.constant?.[0] ?? '?'}]`;
    }

    /**
     * A variable's WGSL name, as a reference.
     *
     * @param {VariableSymbol} symbol
     * @returns {string}
     */
    const variableName = symbol=>{
        switch (symbol.storage)
        {
            case 'builtin':
                return `${p}${symbol.name}`;
            case 'param':
                return symbol.direction === 'in' ? `l${symbol.id}_${symbol.name}`
                    : `(*pp${symbol.id}_${symbol.name})`;
            case 'local':
            case 'const':
                return symbol.global ? `${p}g_${symbol.name}` : `l${symbol.id}_${symbol.name}`;
            default:
                return `${p}g_${symbol.name}`;
        }
    };

    /**
     * An expression as WGSL, its hoisted statements added to `out.pre`.
     *
     * @param {any} node @param {Emit} out
     * @returns {string}
     */
    function expr(node, out){
        if (node.constant && (node.type.kind === 'scalar' || node.type.kind === 'vector'
            || node.type.kind === 'matrix') && !effects(node))
        {
            return constantCode(node.constant, node.type);
        }
        switch (node.node)
        {
            case 'name': {
                const symbol = /** @type {VariableSymbol} */ (node.symbol);
                const inBlock = fromBlock(node, out);
                if (inBlock !== null)
                {
                    return inBlock;
                }
                if (symbol.builtin?.role === 'const')
                {
                    return constantCode(/** @type {number[]} */ (symbol.constant), symbol.type);
                }
                const block = padded(node, out);
                if (block)
                {
                    return readPadded(block.code, block.type);
                }
                return variableName(symbol);
            }
            case 'field': {
                const inBlock = fromBlock(node, out);
                if (inBlock !== null)
                {
                    return inBlock;
                }
                const block = padded(node, out);
                if (block)
                {
                    return readPadded(block.code, block.type);
                }
                return `${expr(node.object, out)}.m_${node.member}`;
            }
            case 'swizzle': {
                const object = expr(node.object, out);
                const letters = node.indices.map((/** @type {number} */ k)=>XYZW[k]).join('');
                if (node.object.type.kind === 'scalar')
                {
                    return node.indices.length === 1 ? object
                        : `${typeOf(node.type)}(${object})`;
                }
                return `${object}.${letters}`;
            }
            case 'index': {
                const inBlock = fromBlock(node, out);
                if (inBlock !== null)
                {
                    return inBlock;
                }
                const block = padded(node, out);
                if (block)
                {
                    return readPadded(block.code, block.type);
                }
                const objectType = node.object.type;
                if (objectType.kind === 'matrix')
                {
                    const inner = padded(node.object, out);
                    if (inner && objectType.rows === 2)
                    {
                        return `${inner.code}[${expr(node.index, out)}].xy`;
                    }
                }
                return `${expr(node.object, out)}[${expr(node.index, out)}]`;
            }
            case 'convert':
                return `${typeOf(node.type)}(${expr(node.operand, out)})`;
            case 'unary':
                return unary(node, out);
            case 'postfix': {
                const target = lvalue(node.operand, out);
                const old = temp(out, target, typeOf(node.type));
                out.pre.push(`${target} = ${old} ${node.op === '++' ? '+' : '-'}`
                    + ` ${one(node.type)};`);
                return old;
            }
            case 'binary':
                return binary(node, out);
            case 'assign':
                assign(node, out);
                return lvalue(node.target, out);
            case 'conditional':
                return conditional(node, out);
            case 'sequence': {
                const parts = node.expressions.map((/** @type {any} */ e)=>expr(e, out));
                for (const part of parts.slice(0, -1))
                {
                    discardValue(part, out);
                }
                return parts[parts.length - 1];
            }
            case 'construct':
                return construct(node, out);
            case 'call':
                return node.user ? userCall(node, out) : builtinCall(node, out);
            case 'literal':
                return constantCode(node.constant, node.type);
            case 'condition': {
                // `while (bool b = ...)`: a variable of the loop's scope.
                const value = expr(node.value, out);
                const name = variableName(node.symbol);
                out.pre.push(`var ${name}: bool = ${value};`);
                return name;
            }
            default:
                throw new Error(`glsl: cannot emit a ${node.node}`);
        }
    }

    /** A value of one, for an increment. @param {GlslType} type */
    const one = type=>{
        const base = baseOf(type);
        const scalar = base === 'int' ? '1i' : base === 'uint' ? '1u' : '1.0f';
        return type.kind === 'scalar' ? scalar : type.kind === 'vector'
            ? `${typeOf(type)}(${scalar})`
            : `${typeOf(type)}(${new Array(componentsOf(type)).fill('1.0f').join(', ')})`;
    };

    /** Evaluates and drops a value. @param {string} code @param {Emit} out */
    const discardValue = (code, out)=>{
        if (!/^[A-Za-z_][A-Za-z0-9_.()*]*$/.test(code) || code.includes('('))
        {
            out.pre.push(`_ = ${code};`);
        }
    };

    /**
     * A writable expression's reference.
     *
     * @param {any} node @param {Emit} out
     * @returns {string}
     */
    function lvalue(node, out){
        switch (node.node)
        {
            case 'name':
                return variableName(node.symbol);
            case 'field':
                return `${lvalue(node.object, out)}.m_${node.member}`;
            case 'index':
                return `${lvalue(node.object, out)}[${expr(node.index, out)}]`;
            case 'swizzle':
                if (node.indices.length !== 1)
                {
                    throw new Error('glsl: a swizzle of several components is written'
                        + ' through assign');
                }
                return node.object.type.kind === 'scalar' ? lvalue(node.object, out)
                    : `${lvalue(node.object, out)}.${XYZW[node.indices[0]]}`;
            default:
                throw new Error(`glsl: cannot write a ${node.node}`);
        }
    }

    /**
     * Writes `value` to `target`, a swizzle of several components one
     * component at a time.
     *
     * @param {any} target @param {string} value @param {Emit} out
     */
    function store(target, value, out){
        if (target.node === 'swizzle' && target.indices.length > 1)
        {
            const from = once(out, value, target.type);
            const base = lvalue(target.object, out);
            target.indices.forEach((/** @type {number} */ index, /** @type {number} */ k)=>{
                out.pre.push(`${base}.${XYZW[index]} = ${from}.${XYZW[k]};`);
            });
            return;
        }
        out.pre.push(`${lvalue(target, out)} = ${value};`);
    }

    /** @param {any} node @param {Emit} out */
    function assign(node, out){
        if (node.op === '=')
        {
            store(node.target, expr(node.value, out), out);
            return;
        }
        const op = node.op.slice(0, -1);
        const current = expr(node.target, out);
        const given = expr(node.value, out);
        const value = op === '<<' || op === '>>'
            ? shift(op, current, node.target.type, given, node.value.type)
            : op === '&' || op === '|' || op === '^'
                ? bitwise(op, current, node.target.type, given, node.value.type)
                : arithmetic(op, current, node.target.type, given, node.value.type, node.type,
                    out);
        store(node.target, value, out);
    }

    /** @param {any} node @param {Emit} out @returns {string} */
    function unary(node, out){
        switch (node.op)
        {
            case '-': {
                const operand = expr(node.operand, out);
                if (baseOf(node.type) === 'uint')
                {
                    // WGSL negates no unsigned value; GLSL's wraps.
                    return `(${zeroOf(node.type)} - ${operand})`;
                }
                return node.type.kind === 'matrix' ? `(${operand} * -1.0f)` : `(-${operand})`;
            }
            case '~':
                return `(~${expr(node.operand, out)})`;
            case '+':
                return expr(node.operand, out);
            case '!':
                return `(!${expr(node.operand, out)})`;
            default: {
                const target = lvalue(node.operand, out);
                out.pre.push(`${target} = ${target} ${node.op === '++' ? '+' : '-'}`
                    + ` ${one(node.type)};`);
                return target;
            }
        }
    }

    /**
     * An arithmetic result, with the forms WGSL lacks -- a matrix with a
     * scalar or another matrix component by component -- column by column.
     *
     * @param {string} op @param {string} a @param {GlslType} at @param {string} b
     * @param {GlslType} bt @param {GlslType} type @param {Emit} out
     * @returns {string}
     */
    function arithmetic(op, a, at, b, bt, type, out){
        if (type.kind === 'matrix')
        {
            const native = op === '*' || ((op === '+' || op === '-') && at === bt);
            if (native)
            {
                return `(${a} ${op} ${b})`;
            }
            if (op === '/' && bt.kind === 'scalar')
            {
                return `(${a} * (1.0f / ${b}))`;
            }
            const left = once(out, a, at);
            const right = once(out, b, bt);
            const columns = Array.from({ length: type.cols }, (_, c)=>{
                const l = at.kind === 'matrix' ? `${left}[${c}]` : left;
                const r = bt.kind === 'matrix' ? `${right}[${c}]` : right;
                return `(${l} ${op} ${r})`;
            });
            return `${typeOf(type)}(${columns.join(', ')})`;
        }
        return `(${a} ${op} ${b})`;
    }

    /**
     * Two values compared whole: a vector by all its components, a matrix by
     * its columns, a struct or an array member by member.
     *
     * @param {string} a @param {string} b @param {GlslType} type @param {Emit} out
     * @returns {string}
     */
    function equal(a, b, type, out){
        switch (type.kind)
        {
            case 'scalar':
                return `(${a} == ${b})`;
            case 'vector':
                return `all(${a} == ${b})`;
            case 'matrix': {
                const l = once(out, a, type);
                const r = once(out, b, type);
                return `(${Array.from({ length: type.cols }, (_, c)=>
                    `all(${l}[${c}] == ${r}[${c}])`).join(' && ')})`;
            }
            case 'struct': {
                const l = once(out, a, type);
                const r = once(out, b, type);
                return `(${type.fields.map(field=>equal(`${l}.m_${field.name}`,
                    `${r}.m_${field.name}`, field.type, out)).join(' && ')})`;
            }
            case 'array': {
                const l = once(out, a, type);
                const r = once(out, b, type);
                return `(${Array.from({ length: type.length }, (_, k)=>equal(`${l}[${k}]`,
                    `${r}[${k}]`, type.element, out)).join(' && ')})`;
            }
            default:
                return 'false';
        }
    }

    /** @param {any} node @param {Emit} out @returns {string} */
    function binary(node, out){
        const op = node.op;
        if (op === '&&' || op === '||')
        {
            const left = expr(node.left, out);
            /** @type {Emit} */
            const inner = { pre: [] };
            const right = expr(node.right, inner);
            if (inner.pre.length === 0)
            {
                return `(${left} ${op} ${right})`;
            }
            const name = `t${temps++}`;
            out.pre.push(`var ${name}: bool = ${left};`,
                `if (${op === '&&' ? name : `!${name}`}) {`, ...inner.pre.map(line=>`    ${line}`),
                `    ${name} = ${right};`, '}');
            return name;
        }
        const left = expr(node.left, out);
        const right = expr(node.right, out);
        if (op === '^^')
        {
            return `(${left} != ${right})`;
        }
        if (op === '==' || op === '!=')
        {
            const same = equal(left, right, node.left.type, out);
            return op === '==' ? same : `(!${same})`;
        }
        if (op === '<' || op === '>' || op === '<=' || op === '>=')
        {
            return `(${left} ${op} ${right})`;
        }
        if (op === '<<' || op === '>>')
        {
            return shift(op, left, node.left.type, right, node.right.type);
        }
        if (op === '&' || op === '|' || op === '^')
        {
            return bitwise(op, left, node.left.type, right, node.right.type);
        }
        return arithmetic(op, left, node.left.type, right, node.right.type, node.type, out);
    }

    /**
     * A shift: WGSL's count is unsigned and of the value's shape, GLSL's
     * either signedness and a scalar for a vector too (section 5.9).
     *
     * @param {string} op @param {string} a @param {GlslType} at @param {string} b
     * @param {GlslType} bt
     */
    function shift(op, a, at, b, bt){
        const size = at.kind === 'vector' ? at.size : 1;
        const count = baseOf(bt) === 'uint' && (bt.kind === 'vector' || size === 1) ? b
            : size === 1 ? `u32(${b})` : `vec${size}u(${b})`;
        return `(${a} ${op} ${count})`;
    }

    /**
     * A bitwise operator, a scalar beside a vector made one (WGSL takes no
     * mixed shapes here).
     *
     * @param {string} op @param {string} a @param {GlslType} at @param {string} b
     * @param {GlslType} bt
     */
    function bitwise(op, a, at, b, bt){
        const left = at.kind === 'scalar' && bt.kind === 'vector' ? `${typeOf(bt)}(${a})` : a;
        const right = bt.kind === 'scalar' && at.kind === 'vector' ? `${typeOf(at)}(${b})` : b;
        return `(${left} ${op} ${right})`;
    }

    /** A zero of a type. @param {GlslType} type */
    function zeroOf(type){
        return `${typeOf(type)}()`;
    }

    /** @param {any} node @param {Emit} out @returns {string} */
    function conditional(node, out){
        const test = expr(node.test, out);
        /** @type {Emit} */
        const thenOut = { pre: [] };
        /** @type {Emit} */
        const elseOut = { pre: [] };
        const then = expr(node.then, thenOut);
        const otherwise = expr(node.otherwise, elseOut);
        const simple = thenOut.pre.length === 0 && elseOut.pre.length === 0
            && !effects(node.then) && !effects(node.otherwise)
            && (node.type.kind === 'scalar' || node.type.kind === 'vector');
        if (simple)
        {
            return `select(${otherwise}, ${then}, ${test})`;
        }
        const name = `t${temps++}`;
        out.pre.push(`var ${name}: ${typeOf(node.type)};`, `if (${test}) {`,
            ...thenOut.pre.map(line=>`    ${line}`), `    ${name} = ${then};`, '} else {',
            ...elseOut.pre.map(line=>`    ${line}`), `    ${name} = ${otherwise};`, '}');
        return name;
    }

    /**
     * The scalars of a value, in order: a vector's components, a matrix's
     * column by column.
     *
     * @param {string} code @param {GlslType} type @param {Emit} out
     * @returns {string[]}
     */
    const scalarsOf = (code, type, out)=>{
        if (type.kind === 'scalar')
        {
            return [code];
        }
        const value = once(out, code, type);
        if (type.kind === 'vector')
        {
            return Array.from({ length: type.size }, (_, k)=>`${value}.${XYZW[k]}`);
        }
        const matrix = /** @type {import('./glsl-types.js').MatrixType} */ (type);
        return Array.from({ length: matrix.cols * matrix.rows }, (_, k)=>
            `${value}[${Math.floor(k / matrix.rows)}].${XYZW[k % matrix.rows]}`);
    };

    /** @param {string} code @param {string} from @param {string} to */
    const castScalar = (code, from, to)=>(from === to ? code : `${SCALARS[to]}(${code})`);

    /** @param {any} node @param {Emit} out @returns {string} */
    function construct(node, out){
        const type = node.type;
        const args = node.args.map((/** @type {any} */ a)=>expr(a, out));
        if (type.kind === 'struct' || type.kind === 'array')
        {
            if (type.kind === 'struct')
            {
                declareStructs(type);
            }
            return `${typeOf(type)}(${args.join(', ')})`;
        }
        const base = /** @type {'float' | 'int' | 'uint' | 'bool'} */ (baseOf(type));
        const argTypes = node.args.map((/** @type {any} */ a)=>a.type);
        if (type.kind === 'scalar')
        {
            const from = argTypes[0];
            const first = from.kind === 'scalar' ? args[0]
                : from.kind === 'vector' ? `${args[0]}.x` : `${args[0]}[0].x`;
            return castScalar(first, /** @type {any} */ (baseOf(from)), base);
        }
        if (args.length === 1 && argTypes[0].kind === 'scalar')
        {
            const scalar = castScalar(args[0], /** @type {any} */ (baseOf(argTypes[0])), base);
            if (type.kind === 'vector')
            {
                return `${typeOf(type)}(${scalar})`;
            }
            const s = once(out, scalar, FLOAT);
            return `${typeOf(type)}(${Array.from({ length: type.cols * type.rows }, (_, k)=>
                (Math.floor(k / type.rows) === k % type.rows ? s : '0.0f')).join(', ')})`;
        }
        if (type.kind === 'matrix' && argTypes[0].kind === 'matrix')
        {
            const from = argTypes[0];
            const m = once(out, args[0], from);
            const columns = Array.from({ length: type.cols }, (_, c)=>{
                const parts = Array.from({ length: type.rows }, (unused, r)=>(c < from.cols
                    && r < from.rows ? `${m}[${c}].${XYZW[r]}` : c === r ? '1.0f' : '0.0f'));
                return `vec${type.rows}f(${parts.join(', ')})`;
            });
            return `${typeOf(type)}(${columns.join(', ')})`;
        }
        const size = componentsOf(type);
        // Whole vectors of the right scalar where they fit, scalars otherwise.
        /** @type {string[]} */
        const pieces = [];
        let count = 0;
        const asColumns = type.kind === 'matrix';
        node.args.forEach((/** @type {any} */ arg, /** @type {number} */ k)=>{
            const t = arg.type;
            const n = componentsOf(t);
            const fromBase = /** @type {any} */ (baseOf(t));
            const wanted = Math.min(n, size - count);
            if (!asColumns && t.kind === 'vector' && wanted === n)
            {
                pieces.push(fromBase === base ? args[k]
                    : `${typeOf(vectorOf(base, n))}(${args[k]})`);
            }
            else if (!asColumns && t.kind === 'vector' && wanted > 1)
            {
                const swizzled = `${args[k]}.${XYZW.slice(0, wanted)}`;
                pieces.push(fromBase === base ? swizzled
                    : `${typeOf(vectorOf(base, wanted))}(${swizzled})`);
            }
            else
            {
                for (const scalar of scalarsOf(args[k], t, out).slice(0, wanted))
                {
                    pieces.push(castScalar(scalar, fromBase, base));
                }
            }
            count += wanted;
        });
        return `${typeOf(type)}(${pieces.join(', ')})`;
    }

    /** @param {any} node @param {Emit} out @returns {string} */
    function userCall(node, out){
        const fn = node.user;
        /** @type {string[]} */
        const args = [];
        /** @type {[any, string][]} */
        const writeBack = [];
        fn.params.forEach((/** @type {any} */ param, /** @type {number} */ k)=>{
            const arg = node.args[k];
            if (param.type.kind === 'sampler')
            {
                args.push(samplerPair(arg));
                return;
            }
            if (param.direction === 'in')
            {
                args.push(expr(arg, out));
                return;
            }
            const name = `t${temps++}`;
            out.pre.push(param.direction === 'inout'
                ? `var ${name}: ${typeOf(param.type)} = ${expr(arg, out)};`
                : `var ${name}: ${typeOf(param.type)};`);
            args.push(`&${name}`);
            writeBack.push([arg, name]);
        });
        const name = functionNames.get(fn.key);
        if (!name)
        {
            throw new Error(`glsl: '${fn.key}' is not defined`);
        }
        const call = `${name}(${args.join(', ')})`;
        if (writeBack.length === 0)
        {
            return call;
        }
        let result = '';
        if (node.type.kind === 'void')
        {
            out.pre.push(`${call};`);
        }
        else
        {
            result = temp(out, call, typeOf(node.type));
        }
        for (const [arg, from] of writeBack)
        {
            store(arg, from, out);
        }
        return result;
    }

    /**
     * A built-in's arguments, a scalar where the overload's genType is a
     * vector splatted to it, as WGSL's own overloads want.
     *
     * @param {any} node @param {Emit} out
     */
    const splatArgs = (node, out)=>{
        const size = node.type.kind === 'vector' ? node.type.size
            : Math.max(1, ...node.args.map((/** @type {any} */ a)=>(a.type.kind === 'vector'
                ? a.type.size : 1)));
        return node.args.map((/** @type {any} */ a)=>{
            const code = expr(a, out);
            return a.type.kind === 'scalar' && size > 1 && a.type.base !== 'bool'
                ? `${typeOf(vectorOf(a.type.base, size))}(${code})` : code;
        });
    };

    /** @param {any} node @param {Emit} out @returns {string} */
    function builtinCall(node, out){
        const name = node.name;
        const type = node.type;
        if (name.startsWith('texture') || name.startsWith('shadow'))
        {
            return textureCall(node, out);
        }
        /** @type {Record<string, string>} */
        const renamed = {
            inversesqrt: 'inverseSqrt', faceforward: 'faceForward', dFdx: 'dpdx',
            fwidth: 'fwidth', roundEven: 'round', dFdxCoarse: 'dpdxCoarse',
            dFdxFine: 'dpdxFine', bitfieldReverse: 'reverseBits', bitCount: 'countOneBits',
            packUnorm2x16: 'pack2x16unorm', packSnorm2x16: 'pack2x16snorm',
            packUnorm4x8: 'pack4x8unorm', packSnorm4x8: 'pack4x8snorm',
            packHalf2x16: 'pack2x16float', unpackUnorm2x16: 'unpack2x16unorm',
            unpackSnorm2x16: 'unpack2x16snorm', unpackUnorm4x8: 'unpack4x8unorm',
            unpackSnorm4x8: 'unpack4x8snorm', unpackHalf2x16: 'unpack2x16float',
        };
        const direct = ['radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'exp', 'log',
            'exp2', 'log2', 'sqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'pow', 'length',
            'distance', 'cross', 'transpose', 'any', 'all', 'inversesqrt', 'fwidth', 'dFdx',
            'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'trunc', 'round', 'roundEven',
            'determinant', 'fma', 'dFdxCoarse', 'dFdxFine', 'fwidthCoarse', 'fwidthFine',
            'bitfieldReverse', 'packUnorm2x16', 'packSnorm2x16', 'packUnorm4x8',
            'packSnorm4x8', 'packHalf2x16', 'unpackUnorm2x16', 'unpackSnorm2x16',
            'unpackUnorm4x8', 'unpackSnorm4x8', 'unpackHalf2x16'];
        if (direct.includes(name))
        {
            const args = node.args.map((/** @type {any} */ a)=>expr(a, out));
            return `${renamed[name] ?? name}(${args.join(', ')})`;
        }
        switch (name)
        {
            case 'atan': {
                const args = node.args.map((/** @type {any} */ a)=>expr(a, out));
                return args.length === 2 ? `atan2(${args[0]}, ${args[1]})` : `atan(${args[0]})`;
            }
            case 'dFdy':
            case 'dFdyCoarse':
            case 'dFdyFine':
                return `(${name.replace('dFdy', 'dpdy')}(${expr(node.args[0], out)})`
                    + ' * -uniforms.misc.z)';
            case 'bitCount':
                return `${typeOf(type)}(countOneBits(${expr(node.args[0], out)}))`;
            case 'floatBitsToInt':
            case 'floatBitsToUint':
            case 'intBitsToFloat':
            case 'uintBitsToFloat':
                return `bitcast<${typeOf(type)}>(${expr(node.args[0], out)})`;
            case 'isnan':
            case 'isinf': {
                // By the bits: WGSL lets a compiler assume no value is a NaN
                // or an infinity, so a comparison could be folded away.
                const arg = node.args[0];
                const size = arg.type.kind === 'vector' ? arg.type.size : 1;
                const u = size === 1 ? 'u32' : `vec${size}u`;
                const bits = `(bitcast<${u}>(${expr(arg, out)}) & ${u}(0x7fffffffu))`;
                return name === 'isnan' ? `(${bits} > ${u}(0x7f800000u))`
                    : `(${bits} == ${u}(0x7f800000u))`;
            }
            case 'modf': {
                const parts = temp(out, `modf(${expr(node.args[0], out)})`,
                    `__modf_result${type.kind === 'vector' ? `_vec${type.size}` : ''}_f32`);
                store(node.args[1], `${parts}.whole`, out);
                return `${parts}.fract`;
            }
            case 'inverse': {
                usedInverses.add(type.cols);
                return `${p}inverse${type.cols}(${expr(node.args[0], out)})`;
            }
            case 'findLSB':
            case 'findMSB': {
                const wgsl = name === 'findLSB' ? 'firstTrailingBit' : 'firstLeadingBit';
                const found = `${wgsl}(${expr(node.args[0], out)})`;
                return baseOf(node.args[0].type) === 'uint' ? `${typeOf(type)}(${found})` : found;
            }
            case 'normalize': {
                const arg = expr(node.args[0], out);
                return type.kind === 'scalar' ? `sign(${arg})` : `normalize(${arg})`;
            }
            case 'dot': {
                const [a, b] = node.args.map((/** @type {any} */ x)=>expr(x, out));
                return node.args[0].type.kind === 'scalar' ? `(${a} * ${b})` : `dot(${a}, ${b})`;
            }
            case 'mod': {
                const [x, y] = splatArgs(node, out);
                const a = once(out, x, type);
                const b = once(out, y, type);
                return `(${a} - ${b} * floor(${a} / ${b}))`;
            }
            case 'mix':
                if (baseOf(node.args[2].type) === 'bool')
                {
                    // The selecting mix of 1.30: y where a is true.
                    const [x, y, a] = node.args.map((/** @type {any} */ v)=>expr(v, out));
                    return `select(${x}, ${y}, ${a})`;
                }
                return `${name}(${splatArgs(node, out).join(', ')})`;
            case 'min':
            case 'max':
            case 'clamp':
            case 'step':
            case 'smoothstep':
                return `${name}(${splatArgs(node, out).join(', ')})`;
            case 'faceforward':
            case 'reflect':
            case 'refract': {
                const args = node.args.map((/** @type {any} */ a)=>expr(a, out));
                const wgsl = name === 'faceforward' ? 'faceForward' : name;
                if (type.kind === 'scalar')
                {
                    // WGSL takes these of vectors only: a scalar is a vector's x.
                    const lifted = args.map((/** @type {string} */ a, /** @type {number} */ k)=>
                        (name === 'refract' && k === 2 ? a : `vec2f(${a}, 0.0f)`));
                    return `${wgsl}(${lifted.join(', ')}).x`;
                }
                return `${wgsl}(${args.join(', ')})`;
            }
            case 'matrixCompMult': {
                const [a, b] = node.args.map((/** @type {any} */ x)=>once(out, expr(x, out), type));
                return `${typeOf(type)}(${Array.from({ length: type.cols }, (_, c)=>
                    `${a}[${c}] * ${b}[${c}]`).join(', ')})`;
            }
            case 'outerProduct': {
                const c = once(out, expr(node.args[0], out), node.args[0].type);
                const r = once(out, expr(node.args[1], out), node.args[1].type);
                return `${typeOf(type)}(${Array.from({ length: type.cols }, (_, k)=>
                    `${c} * ${r}.${XYZW[k]}`).join(', ')})`;
            }
            case 'lessThan':
            case 'lessThanEqual':
            case 'greaterThan':
            case 'greaterThanEqual':
            case 'equal':
            case 'notEqual': {
                const op = /** @type {Record<string, string>} */ ({ lessThan: '<',
                    lessThanEqual: '<=', greaterThan: '>', greaterThanEqual: '>=', equal: '==',
                    notEqual: '!=' })[name];
                const [a, b] = node.args.map((/** @type {any} */ x)=>expr(x, out));
                return `(${a} ${op} ${b})`;
            }
            case 'not':
                return `(!${expr(node.args[0], out)})`;
            case 'noise1':
            case 'noise2':
            case 'noise3':
            case 'noise4':
                for (const arg of node.args)
                {
                    discardValue(expr(arg, out), out);
                }
                return type.kind === 'scalar' ? '0.0f' : `${typeOf(type)}()`;
            case 'ftransform':
                return `(uniforms.modelViewProjection * ${p}gl_Vertex)`;
            default:
                throw new Error(`glsl: the built-in '${name}' has no translation`);
        }
    }

    /**
     * A lookup, 1.10's names and 1.30's alike (section 8.7 of 1.30 to 3.30):
     * what the name says it does -- projected, at a level, with gradients, at
     * an offset, a texel fetched, a size asked -- spelled in what the sampler's
     * WGSL texture takes. A 1D texture is a 2D one a texel high; a depth
     * comparison is a sample compared, LEQUAL; an integer texture, which WGSL
     * only loads, is loaded at the texel the coordinates fall in.
     *
     * @param {any} node @param {Emit} out @returns {string}
     */
    function textureCall(node, out){
        const name = node.name;
        const type = /** @type {import('./glsl-types.js').SamplerType} */ (node.args[0].type);
        const [tex, smp] = samplerPair(node.args[0]).split(', ');
        const rest = node.args.slice(1);
        const dim = type.dim;
        const oneD = dim === '1D';
        const c = oneD ? 1 : dim === '3D' || dim === 'Cube' ? 3 : 2;
        if (dim === 'Buffer')
        {
            throw new Error('a buffer texture is sampled, and this implementation has none');
        }
        if (name === 'textureSize')
        {
            const lod = rest[0] ? `, u32(${expr(rest[0], out)})` : '';
            const d = temp(out, `textureDimensions(${tex}${type.ms ? '' : lod})`,
                dim === '3D' ? 'vec3u' : 'vec2u');
            const layers = `i32(textureNumLayers(${tex}))`;
            if (oneD)
            {
                return type.array ? `vec2i(i32(${d}.x), ${layers})` : `i32(${d}.x)`;
            }
            if (dim === '3D')
            {
                return `vec3i(${d})`;
            }
            return type.array ? `vec3i(vec2i(${d}), ${layers})` : `vec2i(${d})`;
        }
        if (name.startsWith('textureGather') || name.startsWith('textureQuery')
            || name === 'textureSamples')
        {
            throw new Error(`glsl: the built-in '${name}' has no translation`);
        }
        const P = once(out, expr(rest[0], out), rest[0].type);
        const pSize = rest[0].type.kind === 'vector' ? rest[0].type.size : 1;
        /** @param {number} k */
        const part = k=>(pSize === 1 ? P : `${P}.${XYZW[k]}`);
        if (name.startsWith('texelFetch'))
        {
            const offset = name.endsWith('Offset') ? expr(rest[dim === '2DRect' ? 1 : 2], out)
                : null;
            /** @param {string} at */
            const moved = at=>(offset === null ? at : `(${at} + ${offset})`);
            const coords = oneD ? `vec2i(${moved(part(0))}, 0)`
                : moved(pSize === c ? P : `${P}.${XYZW.slice(0, c)}`);
            const layer = type.array ? `, ${part(c)}` : '';
            const level = dim === '2DRect' ? ', 0' : `, ${expr(rest[1], out)}`;
            return `textureLoad(${tex}, ${coords}${layer}${level})`;
        }
        const proj = name.includes('Proj');
        const grad = name.includes('Grad');
        let at = 1;
        const level = name.includes('Lod') ? expr(rest[at++], out) : null;
        const gradients = grad ? [expr(rest[at++], out), expr(rest[at++], out)] : null;
        const offset = name.endsWith('Offset') ? expr(rest[at++], out) : null;
        const bias = rest[at] ? expr(rest[at], out) : null;
        // The coordinates, divided by the last component when projected.
        const q = proj ? part(pSize - 1) : null;
        /** @param {number} k */
        const coord = k=>(q ? `(${part(k)} / ${q})` : part(k));
        const point = c === 1 ? coord(0)
            : q ? `(${P}.${XYZW.slice(0, c)} / ${q})`
                : pSize === c ? P : `${P}.${XYZW.slice(0, c)}`;
        let coords = oneD ? `vec2f(${point}, 0.5f)` : point;
        if (dim === '2DRect')
        {
            coords = `(${coords} / vec2f(textureDimensions(${tex})))`;
        }
        const layer = type.array ? `, i32(floor(${part(c)} + 0.5f))` : '';
        // A comparison's reference follows the coordinates and the layer; a
        // 1D shadow's is the third component, past an unused second.
        const reference = type.shadow
            ? coord(oneD && !type.array ? 2 : c + (type.array ? 1 : 0)) : null;
        const offsetCode = offset === null ? '' : `, ${oneD ? `vec2i(${offset}, 0)` : offset}`;
        if (type.sampled !== 'float' && !type.shadow)
        {
            if (dim === 'Cube')
            {
                throw new Error('an integer cube map is sampled, which this implementation'
                    + ' does not do');
            }
            const lodCode = level === null ? '0' : `i32(${level})`;
            const ivec = dim === '3D' ? 'vec3i' : 'vec2i';
            const fvec = dim === '3D' ? 'vec3f' : 'vec2f';
            const size = temp(out, `${ivec}(textureDimensions(${tex}, ${lodCode}))`, ivec);
            const shifted = offset === null ? '' : ` + ${oneD ? `vec2i(${offset}, 0)` : offset}`;
            const texel = `clamp(${ivec}(floor(${coords} * ${fvec}(${size})))${shifted},`
                + ` ${ivec}(0), ${size} - ${ivec}(1))`;
            return `textureLoad(${tex}, ${texel}${layer}, ${lodCode})`;
        }
        const head = `${tex}, ${smp}, ${coords}${layer}`;
        let sample;
        if (gradients)
        {
            const [dx, dy] = oneD ? gradients.map(g=>`vec2f(${g}, 0.0f)`) : gradients;
            sample = `textureSampleGrad(${head}, ${dx}, ${dy}${offsetCode})`;
        }
        else if (level !== null)
        {
            sample = `textureSampleLevel(${head}, ${level}${offsetCode})`;
        }
        else if (vertex)
        {
            sample = `textureSampleLevel(${head}, 0.0f${offsetCode})`;
        }
        else if (bias !== null)
        {
            sample = `textureSampleBias(${head}, ${bias}${offsetCode})`;
        }
        else
        {
            sample = `textureSample(${head}${offsetCode})`;
        }
        if (reference !== null)
        {
            const passed = `select(0.0f, 1.0f, ${reference} <= ${sample}.x)`;
            return node.type.kind === 'scalar' ? passed : `vec4f(${passed})`;
        }
        return sample;
    }

    // --- statements ---

    /**
     * @param {any} node @param {string} indent
     * @returns {string[]}
     */
    function statement(node, indent){
        /** @type {Emit} */
        const out = { pre: [] };
        /** @param {string[]} lines */
        const finish = lines=>[...out.pre.map(line=>`${indent}${line}`), ...lines];
        switch (node.node)
        {
            case 'block':
                return [`${indent}{`, ...node.body.flatMap((/** @type {any} */ s)=>
                    statement(s, `${indent}    `)), `${indent}}`];
            case 'declaration': {
                /** @type {string[]} */
                const lines = [];
                for (const { symbol, initializer } of node.declarators)
                {
                    declareStructs(symbol.type);
                    const value = initializer ? expr(initializer, out) : null;
                    lines.push(...out.pre.map(line=>`${indent}${line}`));
                    out.pre = [];
                    lines.push(`${indent}var ${variableName(symbol)}: ${typeOf(symbol.type)}`
                        + `${value === null ? '' : ` = ${value}`};`);
                }
                return lines;
            }
            case 'expression':
                expressionStatement(node.expr, out);
                return finish([]);
            case 'if': {
                const test = expr(node.test, out);
                return finish([
                    `${indent}if (${test}) {`, ...statement(node.then, `${indent}    `),
                    ...(node.otherwise
                        ? [`${indent}} else {`, ...statement(node.otherwise, `${indent}    `)]
                        : []),
                    `${indent}}`,
                ]);
            }
            case 'while': {
                /** @type {Emit} */
                const loopOut = { pre: [] };
                const test = expr(node.test, loopOut);
                return [`${indent}loop {`, ...loopOut.pre.map(line=>`${indent}    ${line}`),
                    `${indent}    if (!(${test})) { break; }`,
                    ...statement(node.body, `${indent}    `), `${indent}}`];
            }
            case 'do': {
                /** @type {Emit} */
                const loopOut = { pre: [] };
                const test = expr(node.test, loopOut);
                return [`${indent}loop {`, ...statement(node.body, `${indent}    `),
                    `${indent}    continuing {`,
                    ...loopOut.pre.map(line=>`${indent}        ${line}`),
                    `${indent}        break if !(${test});`, `${indent}    }`, `${indent}}`];
            }
            case 'for': {
                const init = node.init.node === 'empty' ? []
                    : statement(node.init, `${indent}    `);
                /** @type {Emit} */
                const testOut = { pre: [] };
                const test = node.test ? expr(node.test, testOut) : null;
                /** @type {Emit} */
                const updateOut = { pre: [] };
                if (node.update)
                {
                    expressionStatement(node.update, updateOut);
                }
                return [`${indent}{`, ...init, `${indent}    loop {`,
                    ...testOut.pre.map(line=>`${indent}        ${line}`),
                    ...(test === null ? [] : [`${indent}        if (!(${test})) { break; }`]),
                    ...statement(node.body, `${indent}        `),
                    ...(updateOut.pre.length > 0
                        ? [`${indent}        continuing {`,
                            ...updateOut.pre.map(line=>`${indent}            ${line}`),
                            `${indent}        }`]
                        : []),
                    `${indent}    }`, `${indent}}`];
            }
            case 'return':
                if (!node.value)
                {
                    return [`${indent}return;`];
                }
                return finish([`${indent}return ${expr(node.value, out)};`]);
            case 'break':
                return [`${indent}break;`];
            case 'continue':
                return [`${indent}continue;`];
            case 'discard':
                return [`${indent}discard;`];
            case 'switch':
                return switchStatement(node, indent);
            default:
                return [];
        }
    }

    /** The statements after which control does not go on to the next one. */
    const LEAVES = new Set(['break', 'continue', 'return', 'discard']);

    /**
     * A GLSL switch as WGSL's, which has no fall-through: each label's clause
     * is its own statements and those of the labels it falls into, up to one
     * that leaves. A declaration is the whole switch body's in GLSL, which a
     * label may jump past, so each is declared before the switch and
     * initialized where it stood.
     *
     * @param {any} node @param {string} indent
     * @returns {string[]}
     */
    function switchStatement(node, indent){
        /** @type {Emit} */
        const out = { pre: [] };
        const test = expr(node.test, out);
        /** @type {string[]} */
        const declared = [];
        /** @type {{ labels: string[], statements: any[] }[]} */
        const groups = [];
        /** @type {{ labels: string[], statements: any[] } | null} */
        let group = null;
        for (const item of node.body)
        {
            if (item.node === 'case' || item.node === 'default')
            {
                if (!group || group.statements.length > 0)
                {
                    group = { labels: [], statements: [] };
                    groups.push(group);
                }
                group.labels.push(item.node === 'default' ? 'default'
                    : constantCode(item.value.constant, node.test.type));
                continue;
            }
            const into = /** @type {{ labels: string[], statements: any[] }} */ (group);
            if (item.node === 'declaration')
            {
                for (const { symbol, initializer } of item.declarators)
                {
                    declareStructs(symbol.type);
                    declared.push(`${indent}var ${variableName(symbol)}: ${typeOf(symbol.type)};`);
                    if (initializer)
                    {
                        into.statements.push({ node: 'expression', expr: { node: 'assign',
                            op: '=', type: symbol.type, value: initializer,
                            target: { node: 'name', symbol, type: symbol.type } } });
                    }
                }
                continue;
            }
            into.statements.push(item);
        }
        if (groups.length === 0)
        {
            discardValue(test, out);
            return out.pre.map(line=>`${indent}${line}`);
        }
        /** @type {string[]} */
        const clauses = [];
        groups.forEach((g, k)=>{
            /** @type {any[]} */
            const body = [];
            for (let at = k; at < groups.length; at++)
            {
                body.push(...groups[at].statements);
                const last = groups[at].statements[groups[at].statements.length - 1];
                if (last && LEAVES.has(last.node))
                {
                    break;
                }
            }
            clauses.push(`${indent}    case ${g.labels.join(', ')}: {`,
                ...body.flatMap(statementNode=>statement(statementNode, `${indent}        `)),
                `${indent}    }`);
        });
        if (!groups.some(g=>g.labels.includes('default')))
        {
            clauses.push(`${indent}    default: {}`);
        }
        return [...declared, ...out.pre.map(line=>`${indent}${line}`),
            `${indent}switch (${test}) {`, ...clauses, `${indent}}`];
    }

    /**
     * An expression evaluated for what it does: an assignment or an
     * increment as the statement it is, a call called, anything else
     * evaluated and dropped.
     *
     * @param {any} node @param {Emit} out
     */
    function expressionStatement(node, out){
        switch (node.node)
        {
            case 'assign':
                assign(node, out);
                return;
            case 'postfix':
            case 'unary':
                if (node.op === '++' || node.op === '--')
                {
                    const target = lvalue(node.operand, out);
                    out.pre.push(`${target} = ${target} ${node.op === '++' ? '+' : '-'}`
                        + ` ${one(node.type)};`);
                    return;
                }
                break;
            case 'sequence':
                for (const part of node.expressions)
                {
                    expressionStatement(part, out);
                }
                return;
            case 'call':
                if (node.user)
                {
                    const code = expr(node, out);
                    if (code !== '')
                    {
                        out.pre.push(node.type.kind === 'void' ? `${code};` : `_ = ${code};`);
                    }
                    return;
                }
                break;
            default:
                break;
        }
        if (effects(node))
        {
            discardValue(expr(node, out), out);
        }
    }

    // --- the functions ---

    /** @type {string[]} */
    const functions = [];
    for (const fn of linked.functions)
    {
        temps = 0;
        /** @type {string[]} */
        const params = [];
        /** @type {string[]} */
        const copiesIn = [];
        for (const param of fn.params)
        {
            const symbol = param.symbol;
            const id = symbol?.id ?? temps++;
            const name = param.name ?? `unnamed${id}`;
            declareStructs(param.type);
            if (param.type.kind === 'sampler')
            {
                params.push(`pt${id}_${name}: ${textureTypeOf(param.type)}`,
                    `ps${id}_${name}: sampler`);
                continue;
            }
            if (param.direction === 'in')
            {
                params.push(`a${id}_${name}: ${typeOf(param.type)}`);
                copiesIn.push(`    var l${id}_${name}: ${typeOf(param.type)} = a${id}_${name};`);
                continue;
            }
            params.push(`pp${id}_${name}: ptr<function, ${typeOf(param.type)}>`);
        }
        declareStructs(fn.returns);
        const returns = fn.returns.kind === 'void' ? '' : ` -> ${typeOf(fn.returns)}`;
        const body = fn.body.body.flatMap((/** @type {any} */ s)=>statement(s, '    '));
        const fallback = fn.returns.kind === 'void' ? []
            : [`    return ${typeOf(fn.returns)}();`];
        functions.push(`fn ${functionNames.get(fn.key)}(${params.join(', ')})${returns} {
${[...copiesIn, ...body, ...fallback].join('\n')}
}`);
    }

    // Global initializers, in declaration order, before main.
    temps = 0;
    /** @type {string[]} */
    const initial = [];
    for (const symbol of linked.globals)
    {
        if (symbol.storage === 'uniform' || !symbol.initializer)
        {
            continue;
        }
        /** @type {Emit} */
        const out = { pre: [] };
        const value = expr(symbol.initializer, out);
        initial.push(...out.pre.map(line=>`    ${line}`), `    ${p}g_${symbol.name} = ${value};`);
    }

    // --- the interface and the entry point ---

    /** @type {Interface} */
    const fields = [];
    let entry;
    if (vertex)
    {
        if (partner === 'glsl')
        {
            /**
             * @param {string} source @param {GlslType} type @param {boolean} flat
             * @param {string} [interpolate]
             */
            const pass = (source, type, flat, interpolate)=>{
                if (type.kind === 'array')
                {
                    for (let k = 0; k < type.length; k++)
                    {
                        pass(`${source}[${k}]`, type.element, flat, interpolate);
                    }
                    return;
                }
                if (type.kind === 'matrix')
                {
                    for (let c = 0; c < type.cols; c++)
                    {
                        pass(`${source}[${c}]`, vectorOf('float', type.rows), flat, interpolate);
                    }
                    return;
                }
                if (type.kind === 'struct')
                {
                    for (const member of type.fields)
                    {
                        pass(`${source}.m_${member.name}`, member.type, flat, interpolate);
                    }
                    return;
                }
                fields.push({ field: `i${fields.length}`, type: typeOf(type), flat, source,
                    ...interpolate === undefined ? {} : { interpolate } });
            };
            for (const varying of program.varyings)
            {
                pass(`${p}${varying.vertexPath ?? `g_${varying.name}`}`, varying.type,
                    varying.interpolation === 'flat', interpolateOf(varying));
            }
            const fsUses = program.fragment?.uses ?? new Set();
            const colours = [['gl_Color', 'gl_FrontColor', 'gl_BackColor'],
                ['gl_SecondaryColor', 'gl_FrontSecondaryColor', 'gl_BackSecondaryColor']];
            for (const [colour, front, back] of colours)
            {
                if (!fsUses.has(colour))
                {
                    continue;
                }
                pass(linked.uses.has(front) ? `${p}${front}` : 'vec4f(0.0f)', BUILTIN_TYPES.vec4,
                    options.flat);
                if (options.twoSide)
                {
                    pass(linked.uses.has(back) ? `${p}${back}` : 'vec4f(0.0f)',
                        BUILTIN_TYPES.vec4, options.flat);
                }
            }
            if (fsUses.has('gl_TexCoord'))
            {
                for (let k = 0; k < 8; k++)
                {
                    pass(linked.uses.has('gl_TexCoord') ? `${p}gl_TexCoord[${k}]` : 'vec4f(0.0f)',
                        BUILTIN_TYPES.vec4, false);
                }
            }
            if (fsUses.has('gl_FogFragCoord'))
            {
                pass(linked.uses.has('gl_FogFragCoord') ? `${p}gl_FogFragCoord` : '0.0f', FLOAT,
                    false);
            }
        }
        const out = partner === 'glsl'
            ? fields.map(f=>`    out.${f.field} = ${f.source};`)
            : fixedOutputs(linked, p, /** @type {FixedVaryings} */ (options.fixed));
        /** @type {string[]} */
        const inputs = options.attributes.length > 0 ? ['vertex: VertexIn'] : [];
        if (linked.uses.has('gl_VertexID'))
        {
            // WebGPU's index counts from where the draw put its arrays; GL's
            // from the program's own first vertex (`plan.idBias`).
            inputs.push('@builtin(vertex_index) vertexIndex: u32');
            blockMembers.push('    id_bias: vec4i,');
            plan.idBias = slot * 4;
            slot++;
            prologue.push(`    ${p}gl_VertexID = i32(vertexIndex) + ${p}u.id_bias.x;`);
        }
        if (linked.uses.has('gl_InstanceID'))
        {
            // The draw starts every instanced draw at instance zero.
            inputs.push('@builtin(instance_index) instanceIndex: u32');
            prologue.push(`    ${p}gl_InstanceID = i32(instanceIndex);`);
        }
        entry = `@vertex
fn vertexMain(${inputs.join(', ')}) -> VertexOut {
${[...prologue, ...initial, `    ${p}main();`, '    var out: VertexOut;',
        `    let clip = ${p}gl_Position;`,
        '    out.position = vec4f(clip.x, clip.y * uniforms.misc.z,'
            + ' (clip.z * uniforms.misc.y + clip.w) * 0.5, clip.w);',
        ...out, '    return out;'].join('\n')}
}`;
    }
    else
    {
        const interfaceFields = given ?? [];
        /** @type {string[]} */
        const inputs = [];
        let at = 0;
        /** @param {string} target @param {GlslType} type */
        const take = (target, type)=>{
            if (type.kind === 'array')
            {
                for (let k = 0; k < type.length; k++)
                {
                    take(`${target}[${k}]`, type.element);
                }
                return;
            }
            if (type.kind === 'matrix')
            {
                for (let c = 0; c < type.cols; c++)
                {
                    take(`${target}[${c}]`, vectorOf('float', type.rows));
                }
                return;
            }
            if (type.kind === 'struct')
            {
                for (const member of type.fields)
                {
                    take(`${target}.m_${member.name}`, member.type);
                }
                return;
            }
            const field = interfaceFields[at++];
            if (field)
            {
                inputs.push(`    ${target} = input.${field.field};`);
            }
        };
        if (partner === 'glsl')
        {
            for (const varying of program.varyings)
            {
                take(`${p}${varying.fragmentPath ?? `g_${varying.name}`}`, varying.type);
            }
            for (const colour of ['gl_Color', 'gl_SecondaryColor'])
            {
                if (!linked.uses.has(colour))
                {
                    continue;
                }
                const front = interfaceFields[at++];
                if (options.twoSide)
                {
                    const back = interfaceFields[at++];
                    inputs.push(`    ${p}${colour} = select(input.${back.field},`
                        + ` input.${front.field}, facing);`);
                }
                else
                {
                    inputs.push(`    ${p}${colour} = input.${front.field};`);
                }
            }
            if (linked.uses.has('gl_TexCoord'))
            {
                take(`${p}gl_TexCoord`, BUILTIN_VARIABLE_TYPES.fragment.gl_TexCoord);
            }
            if (linked.uses.has('gl_FogFragCoord'))
            {
                take(`${p}gl_FogFragCoord`, FLOAT);
            }
        }
        else
        {
            // From the fixed vertex stage's struct (`wgsl.js` vertexOutStruct).
            const fixed = /** @type {Record<string, string>} */ ({
                gl_Color: 'input.color', gl_SecondaryColor: 'input.secondary',
                gl_FogFragCoord: 'input.fogCoord',
            });
            for (const [name, from] of Object.entries(fixed))
            {
                if (linked.uses.has(name))
                {
                    inputs.push(`    ${p}${name} = ${from};`);
                }
            }
            if (linked.uses.has('gl_TexCoord'))
            {
                for (let k = 0; k < 8; k++)
                {
                    inputs.push(`    ${p}gl_TexCoord[${k}] = input.tc${k};`);
                }
            }
        }
        if (linked.uses.has('gl_FragCoord'))
        {
            inputs.push(`    ${p}gl_FragCoord = vec4f(input.position.x, select(input.position.y,`
                + ' uniforms.misc.w - input.position.y, uniforms.misc.z > 0.0f),'
                + ' input.position.z, input.position.w);');
        }
        if (linked.uses.has('gl_FrontFacing'))
        {
            inputs.push(`    ${p}gl_FrontFacing = facing;`);
        }
        if (linked.uses.has('gl_PointCoord'))
        {
            inputs.push(`    ${p}gl_PointCoord = vec2f(0.5f);`);
        }
        const own = (program.outputs ?? []).filter(o=>o.index === 0);
        /**
         * What target k is written: the fragment shader's own output at
         * location k, or gl_FragData[k], or gl_FragColor in every target.
         *
         * @param {number} k @returns {{ code: string, type: GlslType }}
         */
        const written = k=>{
            if (own.length > 0 || (program.outputs ?? []).length > 0)
            {
                const output = own.find(o=>k >= o.location && k < o.location
                    + (o.type.kind === 'array' ? o.type.length : 1));
                if (!output)
                {
                    return { code: 'vec4f(0.0f)', type: BUILTIN_TYPES.vec4 };
                }
                return output.type.kind === 'array'
                    ? { code: `${p}g_${output.name}[${k - output.location}]`,
                        type: output.type.element }
                    : { code: `${p}g_${output.name}`, type: output.type };
            }
            return { code: program.writesData ? `${p}gl_FragData[${k}]` : `${p}gl_FragColor`,
                type: BUILTIN_TYPES.vec4 };
        };
        const colour = (/** @type {number} */ k)=>written(k).code;
        const writesDepth = linked.uses.has('gl_FragDepth');
        /** @type {string[]} */
        const outputs = [];
        /** @type {string[]} */
        const scalars = [];
        for (let k = 0; k < options.targets; k++)
        {
            const scalar = options.targetScalars?.[k] ?? 'f32';
            scalars.push(scalar);
            const { code, type } = written(k);
            outputs.push(`    out.c${k} = ${asTarget(code, type, scalar)};`);
        }
        if (writesDepth)
        {
            outputs.push(`    out.depth = clamp(${p}gl_FragDepth, 0.0f, 1.0f);`);
        }
        const alpha = options.alphaFunc === null ? []
            : [`    if (!(${options.compare(options.alphaFunc, `${colour(0)}.a`,
                'uniforms.misc.x')})) {`, '        discard;', '    }'];
        declarations.push(`struct FragmentOut {\n${scalars.map((scalar, k)=>
            `    @location(${k}) c${k}: vec4${suffixOf(scalar)},`).join('\n')}${writesDepth
            ? '\n    @builtin(frag_depth) depth: f32,' : ''}\n};`);
        entry = `@fragment
fn fragmentMain(input: VertexOut, @builtin(front_facing) facing: bool) -> FragmentOut {
${[...inputs, ...initial, `    ${p}main();`, ...alpha, '    var out: FragmentOut;', ...outputs,
        '    return out;'].join('\n')}
}`;
    }

    // --- the block's declaration ---

    plan.words = Math.max(4, slot * 4);
    // Runs that lie end to end in both the store and the block are one copy.
    /** @type {number[]} */
    const merged = [];
    for (let k = 0; k < copies.length; k += 3)
    {
        const last = merged.length - 3;
        if (last >= 0 && merged[last] + merged[last + 2] === copies[k]
            && merged[last + 1] + merged[last + 2] === copies[k + 1])
        {
            merged[last + 2] += copies[k + 2];
            continue;
        }
        merged.push(copies[k], copies[k + 1], copies[k + 2]);
    }
    plan.copies = Int32Array.from(merged);
    const blockName = vertex ? 'VertexBlock' : 'FragmentBlock';
    const group = vertex ? 0 : GLSL_FRAGMENT_GROUP;
    const binding = vertex ? GLSL_VERTEX_BINDING : GLSL_FRAGMENT_BINDING;
    const blockCode = blockMembers.length > 0
        ? `struct ${blockName} {\n${blockMembers.join('\n')}\n};
@group(${group}) @binding(${binding}) var<uniform> ${p}u: ${blockName};`
        : '';

    const samplerDeclarations = [...usedSamplers].sort((a, b)=>a - b).map(index=>{
        const sampler = program.samplers[index];
        const kind = textureTypeOf(samplerTypeOf(sampler));
        return `@group(0) @binding(${samplerBinding(index)}) var glt${index}: ${kind};
@group(0) @binding(${samplerBinding(index) + 1}) var gls${index}: sampler;`;
    });

    return {
        code: [...declarations, blockCode, ...privates, ...loaders,
            ...[...usedInverses].sort().map(n=>inverseFunction(p, n)),
            ...[...dynamicBlocks].sort((a, b)=>a - b).map(b=>`fn ${p}ubw${b}(o: u32) -> u32 {
    return glb${b}[o >> 4u][(o >> 2u) & 3u];
}`), ...functions, entry]
            .filter(Boolean).join('\n\n'),
        samplers: samplerDeclarations,
        usedSamplers: [...usedSamplers],
        usedBlocks: [...usedBlocks],
        plan: blockMembers.length > 0 ? plan : null,
        fields,
    };
}

/**
 * What the fixed fragment stage reads, from a vertex shader's built-in
 * outputs: the fields `wgsl.js` vertexOutStruct declares for it.
 *
 * @param {LinkedStage} linked @param {string} p
 * @param {FixedVaryings} fixed
 * @returns {string[]}
 */
function fixedOutputs(linked, p, fixed){
    /** @param {string} name @param {string} fallback */
    const from = (name, fallback)=>(linked.uses.has(name) ? `${p}${name}` : fallback);
    /** @type {string[]} */
    const lines = [
        `    out.color = ${from('gl_FrontColor', 'vec4f(1.0f)')};`,
        `    out.secondary = ${from('gl_FrontSecondaryColor', 'vec4f(0.0f)')};`,
        fixed.fog === null ? '    out.fog = 1.0f;'
            : `    let c = ${from('gl_FogFragCoord', '0.0f')};\n    out.fog = clamp(${fixed.fog},`
                + ' 0.0f, 1.0f);',
    ];
    for (const set of fixed.texcoords)
    {
        lines.push(`    out.tc${set} = ${linked.uses.has('gl_TexCoord') ? `${p}gl_TexCoord[${set}]`
            : 'vec4f(0.0f, 0.0f, 0.0f, 1.0f)'};`);
    }
    return lines;
}

/**
 * GLSL 1.50's inverse(), which WGSL lacks: the adjugate over the determinant.
 *
 * @param {string} p  the stage's prefix @param {number} n  the matrix's size
 * @returns {string}
 */
function inverseFunction(p, n){
    if (n === 2)
    {
        return `fn ${p}inverse2(m: mat2x2f) -> mat2x2f {
    return mat2x2f(m[1][1], -m[0][1], -m[1][0], m[0][0]) * (1.0f / determinant(m));
}`;
    }
    if (n === 3)
    {
        return `fn ${p}inverse3(m: mat3x3f) -> mat3x3f {
    return transpose(mat3x3f(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1])))
        * (1.0f / determinant(m));
}`;
    }
    // a<column><row>; the cofactors by 2x2 minors of the column pairs.
    const names = [];
    for (let col = 0; col < 4; col++)
    {
        for (let row = 0; row < 4; row++)
        {
            names.push(`    let a${col}${row} = m[${col}][${row}];`);
        }
    }
    return `fn ${p}inverse4(m: mat4x4f) -> mat4x4f {
${names.join('\n')}
    let b00 = a00 * a11 - a01 * a10;
    let b01 = a00 * a12 - a02 * a10;
    let b02 = a00 * a13 - a03 * a10;
    let b03 = a01 * a12 - a02 * a11;
    let b04 = a01 * a13 - a03 * a11;
    let b05 = a02 * a13 - a03 * a12;
    let b06 = a20 * a31 - a21 * a30;
    let b07 = a20 * a32 - a22 * a30;
    let b08 = a20 * a33 - a23 * a30;
    let b09 = a21 * a32 - a22 * a31;
    let b10 = a21 * a33 - a23 * a31;
    let b11 = a22 * a33 - a23 * a32;
    let d = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    return mat4x4f(
        a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09,
        a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03,
        a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07,
        a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01,
        a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06,
        a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00,
        a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06,
        a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00) * (1.0f / d);
}`;
}

/**
 * A linked sampler's type: its own, or for a program linked before the
 * linker kept it, the shape it recorded.
 *
 * @param {{ dim: string, shadow: boolean, type?: import('./glsl-types.js').SamplerType }} sampler
 * @returns {import('./glsl-types.js').SamplerType}
 */
export function samplerTypeOf(sampler){
    return sampler.type ?? /** @type {any} */ ({ kind: 'sampler', dim: sampler.dim,
        shadow: sampler.shadow, array: false, ms: false, sampled: 'float' });
}

/**
 * A colour written to a target of a scalar type: widened to four components,
 * GL's missing ones being undefined and written here as 0, 0 and 1, and
 * converted when the output's type is not the target's (also undefined).
 *
 * @param {string} code @param {GlslType} type @param {string} scalar
 * @returns {string}
 */
function asTarget(code, type, scalar){
    const from = SCALARS[baseOf(type) ?? 'float'];
    const n = componentsOf(type);
    const v = suffixOf(from);
    const [zero, one] = from === 'f32' ? ['0.0f', '1.0f'] : [`0${v}`, `1${v}`];
    const four = n === 4 ? code : n === 1 ? `vec4${v}(${code}, ${zero}, ${zero}, ${one})`
        : n === 2 ? `vec4${v}(${code}, ${zero}, ${one})` : `vec4${v}(${code}, ${one})`;
    return from === scalar ? four : `vec4${suffixOf(scalar)}(${four})`;
}

/** The location a conventional attribute's name aliases. @param {string} name */
function locationOfCanonical(name){
    for (let location = 0; location < 16; location++)
    {
        if (canonicalAttribName(location) === name)
        {
            return location;
        }
    }
    return 0;
}

const BUILTIN_TYPES = { vec4: vectorOf('float', 4) };

/** The built-in variables' types, by stage. */
const BUILTIN_VARIABLE_TYPES = (()=>{
    /** @type {{ vertex: Record<string, GlslType>, fragment: Record<string, GlslType> }} */
    const types = { vertex: {}, fragment: {} };
    for (const stage of /** @type {const} */ (['vertex', 'fragment']))
    {
        for (const [name, builtin] of Object.entries(BUILTIN_VARIABLES[stage]))
        {
            types[stage][name] = builtin.type;
        }
    }
    return types;
})();

/** The built-in constants, which are written as their values. */
const CONSTANTS = new Set(Object.entries(BUILTIN_VARIABLES.vertex)
    .filter(([, builtin])=>builtin.role === 'const').map(([name])=>name));

/**
 * The built-in state uniforms, by name: what the renderer fills from the
 * context's state at the draw (`plan.state`). Both stages have the same.
 *
 * @type {Map<string, GlslType>}
 */
export const STATE_UNIFORMS = new Map(Object.entries(BUILTIN_VARIABLES.vertex)
    .filter(([, builtin])=>builtin.role === 'uniform').map(([name, builtin])=>[name,
        builtin.type]));

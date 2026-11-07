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
 *   height. gl_FragCoord's y and dFdy's sign follow it; gl_Position's y
 *   follows it and glClipControl's origin (`CLIP_REMAP`).
 *
 * GLSL statements that are expressions in WGSL's eyes -- an assignment, an
 * increment, a call with `out` arguments inside a larger expression -- are
 * hoisted into statements before the one that holds them; `&&`, `||` and
 * `?:` whose right side would then run unconditionally become `if`s.
 */

import {
    FLOAT, INT, baseOf as declaredBase, columnSlots, componentsOf, glslName, vectorOf,
} from './glsl-types.js';
import { vertexFetch } from '../d3d10/wgsl.js';
import { BUILTIN_ATTRIBUTES, BUILTIN_VARIABLES } from './glsl-builtins.js';
import { canonicalAttribName } from './arb-program.js';
import { CLIP_REMAP, samplerBinding } from './arb-wgsl.js';
import { membersLayout, typeLayout } from './glsl-layout.js';
import { IMAGE_FORMATS } from './glsl-storage.js';
import { BUFFER_ROW } from './objects.js';

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
export const GLSL_GEOMETRY_BINDING = 19;
/** Where a compute shader's own uniforms are bound (4.3), in group 0 of its pass. */
export const GLSL_COMPUTE_BINDING = 20;

/**
 * Group 1 of the vertex shader run as a compute pass before a geometry
 * shader: the draw's indices, what it writes a position of the draw, its
 * parameters, and the draw's arrays from `slots` on, a binding each.
 */
export const GLSL_VERTEX_PASS_BINDING = Object.freeze({ indices: 0, out: 1, params: 2, slots: 3 });

/**
 * Group 1 of the geometry shader's pass: what the vertex pass wrote, the
 * vertices it emits and where its strips start, and each invocation's counts
 * (`../d3d10/geometry-wgsl.js` reads these as Direct3D's shader writes them).
 */
export const GLSL_GEOMETRY_PASS_BINDING = Object.freeze({
    inputs: 0, vertices: 1, starts: 2, counts: 3, params: 4,
    // After tessellation: the tessellator's arguments, whose first word is
    // how many indices it wrote.
    limit: 5,
});

/** The group a draw of what a geometry shader made reads its vertices from, at binding 0. */
export const GLSL_GEOMETRY_DRAW_GROUP = 2;

/**
 * The registers a value takes between the passes, one a leaf: a scalar or a
 * vector, a matrix's column, an array's element, a struct's member.
 *
 * @param {GlslType} type @returns {number}
 */
export function registersOf(type){
    switch (type.kind)
    {
        case 'array':
            return type.length * registersOf(type.element);
        case 'matrix':
            return type.cols;
        case 'struct':
            return type.fields.reduce((n, field)=>n + registersOf(field.type), 0);
        default:
            return 1;
    }
}

/**
 * The components of each register a value takes, in order (`registersOf`).
 *
 * @param {GlslType} type @returns {number[]}
 */
function leafSizes(type){
    switch (type.kind)
    {
        case 'array':
            return Array.from({ length: type.length }, ()=>leafSizes(type.element)).flat();
        case 'matrix':
            return new Array(type.cols).fill(type.rows);
        case 'struct':
            return type.fields.flatMap(field=>leafSizes(field.type));
        default:
            return [componentsOf(type) || 1];
    }
}

/**
 * What transform feedback captures that takes registers of its own after a
 * pass's others: every captured value but gl_Position (register 0), and in
 * the vertex pass gl_PointSize (register 1).
 *
 * @param {LinkedProgram} program @param {boolean} vertexPass
 * @returns {{ path: string, type: GlslType }[]}
 */
export function feedbackLeaves(program, vertexPass){
    return (program.feedback?.varyings ?? []).filter(v=>v.type && v.path !== null
        && v.path !== 'gl_Position' && !(vertexPass && v.path === 'gl_PointSize'))
        .map(v=>({ path: /** @type {string} */ (v.path), type: /** @type {GlslType} */ (v.type) }));
}

/**
 * Where stream output finds each captured word: the register and component
 * of a vertex the pass wrote, by the buffer and word it goes to
 * (`../d3d10/geometry-wgsl.js` streamOutWgsl's writes).
 *
 * @param {LinkedProgram} program
 * @param {number} first  the first register the captured values take
 * @param {boolean} vertexPass  the vertex pass's registers, not the geometry pass's
 * @returns {import('../d3d10/geometry-wgsl.js').StreamOutWrite[]}
 */
export function feedbackWrites(program, first, vertexPass){
    /** @type {Map<number, import('../d3d10/geometry-wgsl.js').StreamOutWrite>} */
    const bySlot = new Map();
    let register = first;
    for (const varying of program.feedback?.varyings ?? [])
    {
        if (!varying.type)
        {
            continue;
        }
        let write = bySlot.get(varying.buffer);
        if (!write)
        {
            write = { slot: varying.buffer, stream: 0, words: [] };
            bySlot.set(varying.buffer, write);
        }
        let word = varying.word;
        if (varying.path === 'gl_Position')
        {
            for (let c = 0; c < 4; c++)
            {
                write.words.push({ register: 0, component: c, word: word++ });
            }
            continue;
        }
        if (vertexPass && varying.path === 'gl_PointSize')
        {
            write.words.push({ register: 1, component: 0, word });
            continue;
        }
        for (const size of leafSizes(varying.type))
        {
            for (let c = 0; c < size; c++)
            {
                write.words.push({ register, component: c, word: word++ });
            }
            register++;
        }
    }
    return [...bySlot.values()];
}

/**
 * The registers a vertex the vertex pass writes takes: gl_Position,
 * gl_PointSize, then each input the geometry shader reads, or without one
 * what transform feedback captures.
 *
 * @param {LinkedProgram} program @returns {number}
 */
export const geometryInputRegisters = program=>2 + (program.geometry
    ? program.geometryInputs.reduce((n, input)=>n + registersOf(input.type), 0)
    : program.tessEvaluation ? tessellationInputs(program)
        .reduce((n, input)=>n + registersOf(input.type), 0)
        : feedbackLeaves(program, true).reduce((n, leaf)=>n + registersOf(leaf.type), 0));

/**
 * The registers the vertex pass writes a position: what the tessellation
 * shaders read where there are some, ahead of a geometry shader after them,
 * else what the geometry shader reads (`geometryInputRegisters`).
 *
 * @param {LinkedProgram} program
 * @returns {number}
 */
export const vertexPassRegisters = program=>(program.tessEvaluation
    ? 2 + tessellationInputs(program).reduce((n, input)=>n + registersOf(input.type), 0)
    : geometryInputRegisters(program));

/**
 * What the vertex pass keeps of a control point after gl_Position and
 * gl_PointSize: what the control shader reads, or without one what the
 * evaluation shader reads (`glsl-link-tess.js`).
 *
 * @param {LinkedProgram} program
 * @returns {{ path: string, type: GlslType }[]}
 */
export const tessellationInputs = program=>((program.tessControl ? program.controlInputs
    : program.evaluationInputs) ?? []).map(input=>({ path: input.fromPath, type: input.type }));

/**
 * A value of a type the stages pass as the four words of a register, and
 * the value back.
 *
 * @param {string} code @param {string} type  `f32`, `vec3i` and the like
 */
export function toRegister(code, type){
    const vector = /^vec([234])[fiu]$/.exec(type);
    if (!vector)
    {
        return `vec4u(bitcast<u32>(${code}), 0u, 0u, 0u)`;
    }
    const n = Number(vector[1]);
    const bits = `bitcast<vec${n}u>(${code})`;
    return n === 4 ? bits : `vec4u(${bits}${', 0u'.repeat(4 - n)})`;
}

/** @param {string} code a register @param {string} type */
export function fromRegister(code, type){
    const vector = /^vec([234])[fiu]$/.exec(type);
    if (!vector)
    {
        return `bitcast<${type}>(${code}.x)`;
    }
    const n = Number(vector[1]);
    return `bitcast<${type}>(${code}${n === 4 ? '' : `.${XYZW.slice(0, n)}`})`;
}

/**
 * The vertex stage of a draw of what a geometry shader made: each vertex
 * the index list names read out of its registers (`gsVertices`) into what
 * the fragment stage takes, the position first.
 *
 * @param {Interface} fields  the geometry stage's (`emitStage`)
 * @param {number} registers  a vertex's, captured values included
 * @returns {string}
 */
export function geometryDrawStage(fields, registers){
    // A draw repeated for each viewport or layer (`uniforms.route`: its own
    // viewport in x, layer in y, negative where it is not one of several)
    // keeps the primitives the shader sent there: the others' vertices all
    // land on one point outside the clip volume, so nothing of them is drawn.
    const elsewhere = fields.map((f, k)=>(f.route
        ? `    if (uniforms.route.${f.route} >= 0.0 && bitcast<i32>(gsVertices[base + ${k + 1}u].x)`
            + ` != i32(uniforms.route.${f.route})) { out.position = vec4f(2.0, 2.0, 2.0, 1.0); }\n`
        : '')).join('');
    return `@group(${GLSL_GEOMETRY_DRAW_GROUP}) @binding(0) var<storage, read> gsVertices:`
        + ` array<vec4u>;

@vertex
fn vertexMain(@builtin(vertex_index) gsVertex: u32) -> VertexOut {
    let base = gsVertex * ${registers}u;
    var out: VertexOut;
    let clip = bitcast<vec4f>(gsVertices[base]);
    out.position = ${CLIP_REMAP};
${fields.map((f, k)=>`    out.${f.field} = `
        + `${fromRegister(`gsVertices[base + ${k + 1}u]`, f.type)};`).join('\n')}
${elsewhere}    return out;
}`;
}

/** Where a program's uniform blocks are bound: group 0, from this binding on. */
export const GLSL_BLOCK_BINDING = 32;

/**
 * Where what a stage writes is bound, in group 0 as well: its shader storage
 * blocks by index, its atomic counter buffers by binding, its images by unit
 * (4.2, 4.3).
 */
export const GLSL_STORAGE_BINDING = 64;
export const GLSL_COUNTER_BINDING = 80;
export const GLSL_IMAGE_BINDING = 96;

/** The atomic functions of 4.30 (section 8.11), by name. */
const ATOMIC_OPS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
    atomicAdd: 'atomicAdd', atomicMin: 'atomicMin', atomicMax: 'atomicMax',
    atomicAnd: 'atomicAnd', atomicOr: 'atomicOr', atomicXor: 'atomicXor',
    atomicExchange: 'atomicExchange', atomicCompSwap: '',
}));

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

/**
 * A vector's components remapped by a swizzle code (`objects.js`
 * swizzleCode): each a component of `value`, which is a name read as many
 * times as the code says, or a constant.
 *
 * @param {string} value @param {string} code @param {string} scalar
 * @returns {string}
 */
export function swizzledTexel(value, code, scalar){
    return `vec4<${scalar}>(${[...code].map(letter=>(letter === '0' ? `${scalar}(0)`
        : letter === '1' ? `${scalar}(1)` : `${value}.${letter}`)).join(', ')})`;
}


/**
 * The WGSL texture a sampler of a type reads: a 1D texture is a 2D one a
 * texel high (`texture.js`), a rectangle a 2D one, a depth texture compared
 * a float one (`textureCall`).
 *
 * @param {import('./glsl-types.js').SamplerType} type
 * @returns {string}
 */
export function textureTypeOf(type){
    if (type.shadow)
    {
        // A comparison reads a depth texture (`textureCall`).
        return type.dim === 'Cube' ? type.array ? 'texture_depth_cube_array'
            : 'texture_depth_cube' : type.array ? 'texture_depth_2d_array' : 'texture_depth_2d';
    }
    const scalar = SCALARS[type.sampled ?? 'float'];
    // A multisample texture is kept with one sample a texel (3.2): a plain
    // one, its every sample that texel.
    switch (type.dim)
    {
        case '3D':
            return `texture_3d<${scalar}>`;
        case 'Cube':
            return type.array ? `texture_cube_array<${scalar}>` : `texture_cube<${scalar}>`;
        // A buffer texture's texels (3.1) are a 2D texture's, `BUFFER_ROW` a row.
        case 'Buffer':
        default:
            return type.array ? `texture_2d_array<${scalar}>` : `texture_2d<${scalar}>`;
    }
}

/**
 * The WGSL sampler a sampler of a type pairs its texture with: a comparison
 * sampler for a shadow one.
 *
 * @param {import('./glsl-types.js').SamplerType} type
 * @returns {string}
 */
export const samplerVarTypeOf = type=>(type.shadow ? 'sampler_comparison' : 'sampler');

/**
 * What a bind group layout says of a sampler's texture: the view's
 * dimension and the sample type its shader reads.
 *
 * @param {import('./glsl-types.js').SamplerType} type
 * @returns {{ viewDimension: string, sampleType: string, multisampled: boolean }}
 */
export function textureLayoutOf(type){
    const sampleType = type.shadow ? 'depth' : (type.sampled ?? 'float') === 'float' ? 'float'
        : type.sampled === 'int' ? 'sint' : 'uint';
    const viewDimension = type.dim === '3D' ? '3d' : type.dim === 'Cube'
        ? type.array ? 'cube-array' : 'cube' : type.array ? '2d-array' : '2d';
    return { viewDimension, sampleType, multisampled: false };
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
 * @property {readonly { stride?: number }[]} [slots]  the draw's arrays, for a
 *     vertex stage run as a compute pass, which reads them as words
 * @property {boolean} [compute]  the vertex stage runs as a compute pass, for the
 *     geometry shader after it (`vertexCompute`)
 * @property {boolean} [limited]  the geometry shader reads what the tessellator
 *     made, as many primitives as the first word of `gsLimit` has indices for
 * @property {Map<string, Map<string, string>>} [subroutines]  by stage, the function
 *     (its key) each subroutine uniform names (4.0), where the program chose one
 * @property {Map<number, string>} [swizzles]  the swizzle (3.3) of the texture each
 *     sampler reads, where it is not the identity (`objects.js` swizzleCode)
 * @property {(context: TessEntryContext) => string} [entry]
 *     a tessellation stage's entry point (`glsl-wgsl-tess.js`)
 */

/**
 * What a tessellation stage's entry point is made of: `emitStage`'s, for the stage.
 *
 * @typedef {Object} TessEntryContext
 * @property {LinkedProgram} program
 * @property {LinkedStage} linked
 * @property {string} p  the stage's prefix
 * @property {(source: string, type: GlslType) => { code: string, type: string }[]} leavesOf
 * @property {string[]} initial  the globals' initializers
 * @property {string[]} declarations
 * @property {string[]} out  the draw's outputs written from the stage's (`VertexOut`)
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
 *     interpolate?: string, route?: 'x' | 'y' }[]} Interface
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
    if (varying.sample)
    {
        return `@interpolate(${kind}, sample) `;
    }
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
            return type.base === 'float' || type.base === 'double' ? 'vec4f'
                : type.base === 'uint' ? 'vec4u' : 'vec4i';
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
            return SCALARS[type.base];
        case 'vector':
            return type.base === 'bool' ? `vec${type.size}<bool>`
                : `vec${type.size}${suffixOf(SCALARS[type.base])}`;
        case 'matrix':
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

/** The built-in functions that write memory: atomics, image stores, counters. */
const WRITING_CALLS = /^(atomic|imageStore|imageAtomic)/;

/**
 * GLSL's barriers (4.30 language section 8.16) as WGSL's: an invocation's
 * control barrier, which also orders the work group's memory, and the
 * memory barriers of what a work group shares and of what lives in storage.
 *
 * @type {Readonly<Record<string, string>>}
 */
const BARRIERS = Object.freeze({
    barrier: 'workgroupBarrier', memoryBarrierShared: 'workgroupBarrier',
    groupMemoryBarrier: 'workgroupBarrier', memoryBarrier: 'storageBarrier',
    memoryBarrierBuffer: 'storageBarrier', memoryBarrierImage: 'storageBarrier',
    memoryBarrierAtomicCounter: 'storageBarrier',
});

/**
 * The variable a chain of members, indices and swizzles starts from.
 *
 * @param {any} node @returns {any}
 */
const rootOf = node=>{
    let at = node;
    while (at && (at.node === 'field' || at.node === 'index' || at.node === 'swizzle'))
    {
        at = at.object;
    }
    return at?.node === 'name' ? at.symbol : null;
};

/**
 * A shared integer, or an array of them, as WGSL's atomic type.
 *
 * @param {any} type @returns {string}
 */
const atomicTypeOf = type=>(type.kind === 'array'
    ? `array<${atomicTypeOf(type.element)}, ${type.length}>`
    : `atomic<${type.base === 'int' ? 'i32' : 'u32'}>`);

/**
 * An image a stage loads or stores: its binding's access, texel format and
 * view, as the bind group layout declares it.
 *
 * @typedef {{ index: number, access: 'read-only' | 'write-only' | 'read-write',
 *     format: string, viewDimension: '1d' | '2d' | '2d-array' | '3d' }} UsedImage
 */

/**
 * @param {import('./glsl-storage.js').ImageUniform} image @param {number} index
 * @param {Set<string>} ways  'read', 'write'
 * @returns {UsedImage}
 */
const imageUse = (image, index, ways)=>{
    const layered = image.type.array || image.type.dim === 'Cube';
    return { index,
        access: ways.has('read') && ways.has('write') ? 'read-write'
            : ways.has('read') ? 'read-only' : 'write-only',
        format: IMAGE_FORMATS.find(([name])=>name === image.format)?.[2] ?? '',
        viewDimension: image.type.dim === '3D' ? '3d' : image.type.dim === '1D' ? '1d'
            : layered ? '2d-array' : '2d' };
};

/** The WGSL scalar of each GLSL one. */
/**
 * The WGSL scalar of each GLSL base type. A double is carried as an f32
 * (decision A178): WGSL has no 64-bit float.
 */
const SCALARS = /** @type {Record<string, string>} */ ({ float: 'f32', int: 'i32', uint: 'u32',
    bool: 'bool', double: 'f32' });

/**
 * A type's base as the emitter writes it: a double's is a float's, the value
 * being carried as one (decision A178); only a block's words see the double.
 *
 * @param {GlslType} type @returns {import('./glsl-types.js').ScalarBase | null}
 */
const baseOf = type=>{
    const base = declaredBase(type);
    return base === 'double' ? 'float' : base;
};

/** The vector suffix of each WGSL scalar. @param {string} scalar */
const suffixOf = scalar=>(scalar === 'f32' ? 'f' : scalar === 'i32' ? 'i' : 'u');

/** An expression read twice as cheaply as once: a name, a member, a literal. */
const SIMPLE = /^([A-Za-z_][A-Za-z0-9_.]*|[0-9][0-9.e+]*[fi]?)$/;

/**
 * @param {LinkedProgram} program
 * @param {'vertex' | 'tessControl' | 'tessEvaluation' | 'geometry' | 'fragment' | 'compute'}
 *     which
 * @param {StageOptions} options
 * @param {Interface | null} given  the interface the other stage chose, for
 *     the fragment stage; null for the vertex stage, which chooses it
 * @param {'glsl' | 'fixed'} partner  whether the other stage is the
 *     program's or the fixed pipeline's
 */
export function emitStage(program, which, options, given, partner){
    const linked = /** @type {LinkedStage} */ (program[which]);
    const vertex = which === 'vertex';
    const geometry = which === 'geometry';
    const fragment = which === 'fragment';
    const tessControl = which === 'tessControl';
    const tessEvaluation = which === 'tessEvaluation';
    const computing = which === 'compute';
    // A compute shader links alone, so it never shares a module with a control shader.
    const p = vertex ? 'v' : geometry ? 'y' : tessControl || computing ? 'c'
        : tessEvaluation ? 'e' : 'f';
    /**
     * A control shader's outputs are its workgroup's: one invocation reads
     * what another wrote after barrier() (`glsl-wgsl-tess.js`).
     *
     * @param {boolean} shared
     */
    const space = shared=>(shared ? 'workgroup' : 'private');
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
        return BUILTIN_VARIABLE_TYPES[which === 'fragment' ? 'fragment' : 'vertex'][name];
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
            || symbol.type.kind === 'image'
            || (symbol.type.kind === 'array' && (symbol.type.element.kind === 'sampler'
                || symbol.type.element.kind === 'image')))
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
                const location = attribute.location + c * columnSlots(type);
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

    // --- what the stage changes atomically: found before anything is declared ---

    /** The storage blocks, by block name, an atomic function names a member of. */
    const atomicStorage = new Set();
    /** The shared variables an atomic function names. */
    const atomicShared = new Set();
    {
        /** @type {Set<object>} */
        const seen = new Set();
        /** @param {any} node */
        const visit = node=>{
            if (!node || typeof node !== 'object' || seen.has(node))
            {
                return;
            }
            seen.add(node);
            if (Array.isArray(node))
            {
                node.forEach(visit);
                return;
            }
            if (node.node === 'call' && !node.user && node.name in ATOMIC_OPS)
            {
                const root = rootOf(node.args[0]);
                if (root?.storage === 'buffer' && root.block)
                {
                    atomicStorage.add(root.block.name);
                }
                else if (root?.storage === 'shared')
                {
                    atomicShared.add(root.name);
                }
            }
            for (const key of Object.keys(node))
            {
                if (key !== 'type' && key !== 'symbol' && key !== 'at' && key !== 'constant'
                    && key !== 'fn')
                {
                    visit(node[key]);
                }
            }
        };
        linked.functions.forEach(fn=>visit(/** @type {any} */ (fn).body));
    }

    // --- private variables: globals, built-ins, and the interface ---

    for (const symbol of linked.globals)
    {
        if (symbol.storage === 'uniform' || symbol.storage === 'buffer')
        {
            continue;
        }
        declareStructs(symbol.type);
        // A compute shader's shared variables are its work group's (4.3);
        // one an atomic function names is WGSL's atomic type throughout.
        privates.push(`var<${space(symbol.storage === 'shared'
            || (tessControl && symbol.storage === 'out'))}>`
            + ` ${p}g_${symbol.name}: ${atomicShared.has(symbol.name)
                ? atomicTypeOf(symbol.type) : typeOf(symbol.type)};`);
    }
    for (const name of linked.uses)
    {
        const type = builtinTypeOf(name);
        if (!type || STATE_UNIFORMS.has(name) || CONSTANTS.has(name)
            || (linked.builtins?.get(name)?.builtin?.role === 'uniform'))
        {
            continue;
        }
        declareStructs(type);
        privates.push(`var<${space(tessControl && (name === 'gl_out'
            || name === 'gl_TessLevelOuter' || name === 'gl_TessLevelInner'))}>`
            + ` ${p}${name}: ${typeOf(type)};`);
    }
    // What the entry point reads whether or not main wrote it.
    const read = vertex || tessEvaluation ? [['gl_Position', 'vec4f']]
        : geometry ? [['gl_Position', 'vec4f'], ['gl_PrimitiveID', 'i32'],
            ...program.feedback?.varyings.some(v=>v.path === 'gl_PointSize')
                ? [['gl_PointSize', 'f32']] : []]
            : tessControl || computing ? []
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
    /** An image uniform's element, by name: its index in the program's images. */
    /** @type {Map<string, number>} */
    const imageOf = new Map((program.images ?? []).map((image, k)=>
        [`${image.leaf.base}#${image.element}`, k]));
    /** The images the stage reads and writes, by index: how. @type {Map<number, Set<string>>} */
    const usedImages = new Map();
    /** @type {Set<number>} */
    const usedSamplers = new Set();
    /** The sizes of matrix the stage inverts. @type {Set<number>} */
    const usedInverses = new Set();
    /** @type {Set<string>} the unsigned types a 32-by-32 multiply's high word is asked of */
    const usedWideMultiplies = new Set();
    /** Whether a double's two words are turned into an f32 or back (`doubleBitsFunctions`). */
    let usedDoubleBits = false;

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
            || (node.node === 'call' && (node.user || WRITING_CALLS.test(node.name))))
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
    /** The storage blocks it reads or writes, by index. @type {Set<number>} */
    const usedStorage = new Set();
    /** The atomic counter buffers it changes, by binding. @type {Set<number>} */
    const usedCounters = new Set();
    /** The storage blocks it writes, by index. @type {Set<number>} */
    const writtenStorage = new Set();
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
        // A storage block's index is told from a uniform block's by its
        // sign: -1 the first (`storageOf`).
        const storage = info.storage === 'buffer';
        const index = ((storage ? program.storageBlocks : program.blocks) ?? []).findIndex(b=>
            b.blockName === info.name && b.element === element);
        if (index < 0)
        {
            throw new Error(`glsl: the block '${info.name}' is not active`);
        }
        return storage ? -index - 1 : index;
    };

    /** @param {number} block @returns {number} a storage block's own index */
    const storageOf = block=>-block - 1;

    /**
     * A block by the index `blockIndex` gives it, marked read.
     *
     * @param {number} block
     * @returns {{ members: import('./glsl-layout.js').MemberLayout[],
     *     packing: 'std140' | 'std430' }}
     */
    const useBlock = block=>{
        if (block < 0)
        {
            usedStorage.add(storageOf(block));
            return /** @type {any} */ (program.storageBlocks)[storageOf(block)];
        }
        usedBlocks.add(block);
        return /** @type {any} */ (program.blocks)[block];
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
            if ((symbol.storage !== 'uniform' && symbol.storage !== 'buffer') || !info)
            {
                return null;
            }
            if (info.instance === symbol.name)
            {
                return { instance: info, element: 0, type: symbol.type };
            }
            const index = blockIndex(info, 0);
            const block = useBlock(index);
            const member = block.members.find(m=>m.name === symbol.name);
            if (!member)
            {
                throw new Error(`glsl: '${symbol.name}' is not in its block's layout`);
            }
            return placeOf(index, member.offset, null, member.type, !!member.rowMajor,
                block.packing);
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
                const block = useBlock(index);
                const member = block.members.find(m=>m.name === node.member);
                if (!member)
                {
                    throw new Error(`glsl: '${node.member}' is not in its block's layout`);
                }
                return placeOf(index, member.offset, null, member.type, !!member.rowMajor,
                    block.packing);
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
                : { at: inner.at, plus: temp(out, `${inner.plus === null ? ''
                    : `${inner.plus} + `}u32(${expr(node.index, out)}) * ${stride}u`, 'u32') });
            if (type.kind === 'array')
            {
                const { at, plus } = moved(inner.arrayStride);
                return placeOf(inner.block, at, plus, type.element, inner.rowMajor,
                    inner.packing);
            }
            // A double's component is eight bytes, the f32 carrying it read
            // from them (decision A178).
            const double = /** @type {any} */ (type).base === 'double';
            const element = double ? 8 : 4;
            if (type.kind === 'matrix')
            {
                // A column: a vector of a column-major matrix, the column's
                // components of each row of a row-major one.
                const { at, plus } = moved(inner.rowMajor ? element : inner.matrixStride);
                return { ...placeOf(inner.block, at, plus, vectorOf(type.base, type.rows), false,
                    inner.packing), step: inner.rowMajor ? inner.matrixStride : element };
            }
            const { at, plus } = moved(double && inner.step === 4 ? 8 : inner.step);
            return placeOf(inner.block, at, plus, vectorOf(
                /** @type {any} */ (declaredBase(type)), 1), false, inner.packing);
        }
        return null;
    }

    /**
     * The 32-bit word at a byte offset of a block.
     *
     * @param {number} block @param {number} at @param {string | null} plus
     */
    const blockWord = (block, at, plus)=>{
        if (block < 0)
        {
            const ref = storageWord(block, at, plus);
            return atomicStorage.has(storageName(block)) ? `atomicLoad(&${ref})` : ref;
        }
        if (plus === null)
        {
            return `glb${block}[${at >> 4}].${XYZW[(at >> 2) & 3]}`;
        }
        dynamicBlocks.add(block);
        return `${p}ubw${block}(${plus}${at === 0 ? '' : ` + ${at}u`})`;
    };

    /** @param {number} block @returns {string} a storage block's block name */
    const storageName = block=>/** @type {any} */ (program.storageBlocks)[storageOf(block)]
        .blockName;

    /**
     * A storage block's word at a byte offset, as a reference.
     *
     * @param {number} block @param {number} at @param {string | null} plus
     */
    const storageWord = (block, at, plus)=>{
        const index = storageOf(block);
        usedStorage.add(index);
        return plus === null ? `gss${index}[${at >> 2}u]`
            : `gss${index}[(${plus}${at === 0 ? '' : ` + ${at}u`}) >> 2u]`;
    };

    /**
     * A value as the word a storage block holds it in.
     *
     * @param {string} code @param {GlslType} type  a scalar
     */
    const asWord = (code, type)=>{
        const base = baseOf(type);
        return base === 'uint' ? code : base === 'bool' ? `select(0u, 1u, ${code})`
            : `bitcast<u32>(${code})`;
    };

    /**
     * Writes a value into a storage block at a place, word by word, as the
     * layout puts each (`readBlock` read backwards).
     *
     * @param {BlockPlace} place @param {string} value @param {Emit} out
     */
    function writeBlock(place, value, out){
        const { block, at, plus, type } = place;
        switch (type.kind)
        {
            case 'scalar': {
                if (/** @type {any} */ (type).base === 'double')
                {
                    usedDoubleBits = true;
                    const bits = once(out, `${p}floatToDouble(${value})`, vectorOf('uint', 2));
                    for (const [k, part] of [[0, 'x'], [4, 'y']])
                    {
                        writeBlock({ ...place, at: at + Number(k), type: vectorOf('uint', 1) },
                            `${bits}.${part}`, out);
                    }
                    return;
                }
                const ref = storageWord(block, at, plus);
                writtenStorage.add(storageOf(block));
                const word = asWord(value, type);
                out.pre.push(atomicStorage.has(storageName(block))
                    ? `atomicStore(&${ref}, ${word});` : `${ref} = ${word};`);
                return;
            }
            case 'vector': {
                const from = once(out, value, type);
                const step = /** @type {any} */ (type).base === 'double' && place.step === 4 ? 8
                    : place.step;
                for (let k = 0; k < type.size; k++)
                {
                    writeBlock({ ...place, at: at + k * step,
                        type: vectorOf(/** @type {any} */ (type).base, 1) },
                    `${from}.${XYZW[k]}`, out);
                }
                return;
            }
            case 'matrix': {
                const from = once(out, value, type);
                const element = /** @type {any} */ (type).base === 'double' ? 8 : 4;
                for (let c = 0; c < type.cols; c++)
                {
                    writeBlock({ ...place, type: vectorOf(/** @type {any} */ (type).base, type.rows),
                        at: at + c * (place.rowMajor ? element : place.matrixStride),
                        step: place.rowMajor ? place.matrixStride : element }, `${from}[${c}]`,
                    out);
                }
                return;
            }
            case 'array': {
                const from = once(out, value, type);
                for (let k = 0; k < type.length; k++)
                {
                    writeBlock(placeOf(block, at + k * place.arrayStride, plus, type.element,
                        place.rowMajor, place.packing), `${from}[${k}]`, out);
                }
                return;
            }
            case 'struct': {
                const from = once(out, value, type);
                const laid = membersLayout(type.fields.map(f=>({ name: f.name, type: f.type,
                    rowMajor: place.rowMajor })), place.packing);
                for (const m of laid)
                {
                    writeBlock(placeOf(block, at + m.offset, plus, m.type, place.rowMajor,
                        place.packing), `${from}.m_${m.name}`, out);
                }
                return;
            }
            default:
                throw new Error(`glsl: a ${glslName(type)} cannot be written to a block`);
        }
    }

    /**
     * The shared variable an expression starts from, by name, or null.
     *
     * @param {any} node @returns {string | null}
     */
    const sharedRoot = node=>{
        const root = rootOf(node);
        return root?.storage === 'shared' ? root.name : null;
    };

    /**
     * Whether a written expression lies in a storage block or in a shared
     * atomic: written through `store`, never as a WGSL reference.
     *
     * @param {any} node @returns {boolean}
     */
    const inMemory = node=>rootOf(node)?.storage === 'buffer'
        || atomicShared.has(sharedRoot(node));

    /**
     * The place an expression writes in a storage block, or null for one
     * outside every storage block.
     *
     * @param {any} node @param {Emit} out @returns {BlockPlace | null}
     */
    const storagePlace = (node, out)=>{
        if (rootOf(node)?.storage !== 'buffer')
        {
            return null;
        }
        const place = blockPlace(node, out);
        if (!place || 'instance' in place)
        {
            throw new Error('a storage block instance is written whole, which GLSL does not'
                + ' let a program do');
        }
        return place;
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
                if (type.base === 'double')
                {
                    usedDoubleBits = true;
                    return `${p}doubleToFloat(${word}, ${blockWord(block, at + 4, plus)})`;
                }
                return type.base === 'uint' ? word : type.base === 'bool' ? `(${word} != 0u)`
                    : `bitcast<${SCALARS[type.base]}>(${word})`;
            }
            case 'vector': {
                const n = type.size;
                if (type.base === 'double')
                {
                    // Eight bytes a component, or the row's stride in a row-major matrix.
                    const step = place.step === 4 ? 8 : place.step;
                    return `${typeOf(type)}(${Array.from({ length: n }, (_, k)=>readBlock({
                        ...place, at: at + k * step, type: vectorOf('double', 1) })).join(', ')})`;
                }
                const first = (at >> 2) & 3;
                const words = block >= 0 && plus === null && place.step === 4
                    && first + n <= 4 ? `glb${block}[${at >> 4}].${XYZW.slice(first, first + n)}`
                    : `vec${n}u(${Array.from({ length: n }, (_, k)=>blockWord(block,
                        at + k * place.step, plus)).join(', ')})`;
                return type.base === 'uint' ? words : type.base === 'bool'
                    ? `(${words} != vec${n}u(0u))` : `bitcast<${typeOf(type)}>(${words})`;
            }
            case 'matrix': {
                const element = type.base === 'double' ? 8 : 4;
                const columns = Array.from({ length: type.cols }, (_, c)=>readBlock({
                    ...place, type: vectorOf(type.base, type.rows),
                    at: at + c * (place.rowMajor ? element : place.matrixStride),
                    step: place.rowMajor ? place.matrixStride : element }));
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
        if ((node.node === 'name' || node.node === 'index') && node.type.kind === 'scalar'
            && atomicShared.has(sharedRoot(node)))
        {
            return `atomicLoad(&${lvalue(node, out)})`;
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
                if (inMemory(node.operand))
                {
                    const old = temp(out, expr(node.operand, out), typeOf(node.type));
                    store(node.operand, `(${old} ${node.op === '++' ? '+' : '-'}`
                        + ` ${one(node.type)})`, out);
                    return old;
                }
                const target = lvalue(node.operand, out);
                const old = temp(out, target, typeOf(node.type));
                out.pre.push(`${target} = ${old} ${node.op === '++' ? '+' : '-'}`
                    + ` ${one(node.type)};`);
                return old;
            }
            case 'length': {
                // A storage block's last member sized at run time: what the
                // buffer bound to it holds past the members before it.
                const place = blockPlace(node.object, out);
                if (!place || 'instance' in place || place.block >= 0)
                {
                    throw new Error('glsl: length() of an array sized at run time outside a'
                        + ' storage block');
                }
                const index = storageOf(place.block);
                usedStorage.add(index);
                return `i32((arrayLength(&gss${index}) * 4u - ${place.at}u)`
                    + ` / ${place.arrayStride}u)`;
            }
            case 'binary':
                return binary(node, out);
            case 'assign':
                assign(node, out);
                return inMemory(node.target) ? expr(node.target, out) : lvalue(node.target, out);
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
                if (node.subroutine)
                {
                    return subroutineCall(node, out);
                }
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
        // A store into an image has no value at all.
        if (code !== '' && (!/^[A-Za-z_][A-Za-z0-9_.()*]*$/.test(code) || code.includes('(')))
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
        const place = storagePlace(target.node === 'swizzle' ? target.object : target, out);
        if (place)
        {
            if (target.node !== 'swizzle')
            {
                writeBlock(place, value, out);
                return;
            }
            const from = once(out, value, target.type);
            const scalar = vectorOf(/** @type {any} */ (baseOf(target.type)), 1);
            target.indices.forEach((/** @type {number} */ index, /** @type {number} */ k)=>{
                writeBlock({ ...place, at: place.at + index * place.step, type: scalar },
                    target.indices.length === 1 ? from : `${from}.${XYZW[k]}`, out);
            });
            return;
        }
        if (target.type.kind === 'scalar' && atomicShared.has(sharedRoot(target)))
        {
            out.pre.push(`atomicStore(&${lvalue(target, out)}, ${value});`);
            return;
        }
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
        const operand = expr(node.value, out);
        const value = op === '<<' || op === '>>'
            ? shift(op, current, node.target.type, operand, node.value.type)
            : op === '&' || op === '|' || op === '^'
                ? bitwise(op, current, node.target.type, operand, node.value.type)
                : arithmetic(op, current, node.target.type, operand, node.value.type, node.type,
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
                if (inMemory(node.operand))
                {
                    const value = temp(out, `(${expr(node.operand, out)}`
                        + ` ${node.op === '++' ? '+' : '-'} ${one(node.type)})`, typeOf(node.type));
                    store(node.operand, value, out);
                    return value;
                }
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

    /**
     * A call through a subroutine uniform (4.0 section 6.1.2): a call of the
     * function the uniform names for this draw (`options.subroutines`, which
     * the program's module is made for), or of the first of its type where
     * none was chosen, as GL leaves that undefined.
     *
     * @param {any} node @param {Emit} out @returns {string}
     */
    function subroutineCall(node, out){
        const uniform = program.subroutines?.[which]?.uniforms.find(u=>u.name
            === node.subroutine.name);
        const functions = program.subroutines?.[which]?.functions ?? [];
        const chosen = options.subroutines?.get(which)?.get(node.subroutine.name)
            ?? functions.find(f=>f.index === uniform?.compatible[0])?.key;
        const fn = linked.functions.find(f=>f.key === chosen);
        if (!fn)
        {
            // A type no function has: nothing to call.
            for (const arg of node.args)
            {
                discardValue(expr(arg, out), out);
            }
            return node.type.kind === 'void' ? '' : `${typeOf(node.type)}()`;
        }
        return userCall({ ...node, user: fn }, out);
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

    /**
     * An atomic function of 4.30 on a storage block's member or a shared
     * variable. A storage block's words are atomic<u32>, so a signed
     * minimum or maximum there is a compare-and-swap loop; GLSL's
     * atomicCompSwap is strong and WGSL's exchange weak, so it loops until
     * it either swaps or sees another value.
     *
     * @param {any} node @param {Emit} out @returns {string}
     */
    function atomicCall(node, out){
        const [memory, ...rest] = node.args;
        const root = rootOf(memory);
        const signed = baseOf(memory.type) === 'int';
        const scalar = signed ? 'i32' : 'u32';
        let ref;
        let words = false;
        if (root?.storage === 'buffer')
        {
            const place = /** @type {BlockPlace} */ (blockPlace(memory, out));
            ref = storageWord(place.block, place.at, place.plus);
            writtenStorage.add(storageOf(place.block));
            words = true;
        }
        else if (root?.storage === 'shared')
        {
            ref = lvalue(memory, out);
        }
        else
        {
            throw new Error(`glsl: '${node.name}' changes neither a storage block's member nor a`
                + ' shared variable');
        }
        /** @param {string} code */
        const toStored = code=>(words && signed ? `bitcast<u32>(${code})` : code);
        /** @param {string} code */
        const fromStored = code=>(words && signed ? `bitcast<i32>(${code})` : code);
        const values = rest.map((/** @type {any} */ a)=>temp(out, expr(a, out), scalar));
        const stored = words ? 'u32' : scalar;
        if (node.name === 'atomicCompSwap')
        {
            const result = `t${temps++}`;
            out.pre.push(`var ${result}: ${stored};`, 'loop {',
                `    let ${result}r = atomicCompareExchangeWeak(&${ref}, ${toStored(values[0])},`
                + ` ${toStored(values[1])});`,
                `    if (${result}r.exchanged || ${result}r.old_value != ${toStored(values[0])})`
                + ` { ${result} = ${result}r.old_value; break; }`, '}');
            return fromStored(result);
        }
        if ((node.name === 'atomicMin' || node.name === 'atomicMax') && signed && words)
        {
            const result = `t${temps++}`;
            out.pre.push(`var ${result}: u32;`, 'loop {',
                `    let ${result}o = atomicLoad(&${ref});`,
                `    let ${result}r = atomicCompareExchangeWeak(&${ref}, ${result}o, bitcast<u32>(`
                + `${node.name === 'atomicMin' ? 'min' : 'max'}(bitcast<i32>(${result}o),`
                + ` ${values[0]})));`,
                `    if (${result}r.exchanged) { ${result} = ${result}o; break; }`, '}');
            return `bitcast<i32>(${result})`;
        }
        return fromStored(temp(out, `${ATOMIC_OPS[node.name]}(&${ref}, ${toStored(values[0])})`,
            stored));
    }

    /**
     * An atomic counter's function (4.20 section 8.10): an atomic on the
     * counter's word of the buffer at its binding.
     *
     * @param {any} node @param {Emit} out @returns {string}
     */
    function counterCall(node, out){
        const counter = node.args[0];
        const root = rootOf(counter);
        const known = (program.counters ?? []).find(c=>c.name === root?.name);
        if (!known)
        {
            throw new Error(`glsl: '${node.name}' names no active atomic counter`);
        }
        const word = known.offset >> 2;
        const index = counter.node !== 'index' ? `${word}u`
            : counter.index.constant ? `${word + counter.index.constant[0]}u`
                : `(${word}u + u32(${expr(counter.index, out)}))`;
        usedCounters.add(known.binding);
        const ref = `gac${known.binding}[${index}]`;
        switch (node.name)
        {
            case 'atomicCounterIncrement':
                return temp(out, `atomicAdd(&${ref}, 1u)`, 'u32');
            case 'atomicCounterDecrement':
                return temp(out, `atomicSub(&${ref}, 1u) - 1u`, 'u32');
            case 'atomicCounter':
                return temp(out, `atomicLoad(&${ref})`, 'u32');
            default:
                throw new Error(`glsl: the built-in '${node.name}' has no translation`);
        }
    }

    /**
     * An image's load, store or size (4.20 section 8.12) on the storage
     * texture its unit binds. The atomics on images have no WGSL form and
     * are refused (decision A174).
     *
     * @param {any} node @param {Emit} out @returns {string}
     */
    function imageCall(node, out){
        const image = node.args[0];
        const base = image.node === 'name' ? image.symbol.name
            : image.node === 'index' && image.object.node === 'name' && image.index.constant
                ? image.object.symbol.name : null;
        const element = image.node === 'index' ? image.index.constant[0] : 0;
        const index = base === null ? undefined : imageOf.get(`${base}#${element}`);
        if (index === undefined)
        {
            throw new Error('an image must be named by a uniform or an array element with a'
                + ' constant index');
        }
        const known = /** @type {any} */ (program.images)[index];
        const type = known.type;
        if (type.ms || (type.dim !== '1D' && type.dim !== '2D' && type.dim !== '3D'
            && type.dim !== 'Cube'))
        {
            throw new Error(`glsl: an image of ${type.dim}${type.ms ? ' multisampled' : ''} has`
                + ' no WebGPU storage texture');
        }
        const ways = usedImages.get(index) ?? new Set();
        usedImages.set(index, ways);
        const texture = `gim${index}`;
        const layered = type.array || type.dim === 'Cube';
        if (node.name === 'imageSize')
        {
            if (layered)
            {
                return `vec3i(vec3u(textureDimensions(${texture}), textureNumLayers(${texture})))`;
            }
            return type.dim === '1D' ? `i32(textureDimensions(${texture}))`
                : `vec${type.dim === '3D' ? 3 : 2}i(textureDimensions(${texture}))`;
        }
        const at = once(out, expr(node.args[1], out), node.args[1].type);
        const where = !layered ? at : type.dim === '1D' ? `${at}.x, ${at}.y`
            : `${at}.xy, ${at}.z`;
        if (node.name === 'imageLoad')
        {
            ways.add('read');
            return `textureLoad(${texture}, ${where})`;
        }
        ways.add('write');
        out.pre.push(`textureStore(${texture}, ${where}, ${expr(node.args[2], out)});`);
        return '';
    }

    /** @param {any} node @param {Emit} out @returns {string} */
    function builtinCall(node, out){
        const name = node.name;
        const type = node.type;
        if (name.startsWith('texture') || name.startsWith('shadow')
            || name.startsWith('texelFetch'))
        {
            return textureCall(node, out);
        }
        if (name in ATOMIC_OPS)
        {
            return atomicCall(node, out);
        }
        if (name === 'imageLoad' || name === 'imageStore' || name === 'imageSize')
        {
            return imageCall(node, out);
        }
        if (name.startsWith('atomicCounter'))
        {
            return counterCall(node, out);
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
                // WGSL's result struct has no name a declaration may write.
                const parts = `t${temps++}`;
                out.pre.push(`let ${parts} = modf(${expr(node.args[0], out)});`);
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
            case 'uaddCarry':
            case 'usubBorrow': {
                const T = typeOf(type);
                const a = once(out, expr(node.args[0], out), type);
                const b = once(out, expr(node.args[1], out), type);
                const add = name === 'uaddCarry';
                const result = temp(out, `${a} ${add ? '+' : '-'} ${b}`, T);
                // A sum wrapped is below either operand; a difference wrapped
                // had the larger subtracted.
                store(node.args[2], `select(${T}(0u), ${T}(1u), ${add ? `${result} < ${a}`
                    : `${a} < ${b}`})`, out);
                return result;
            }
            case 'umulExtended':
            case 'imulExtended': {
                const argType = node.args[0].type;
                const T = typeOf(argType);
                const size = argType.kind === 'vector' ? argType.size : 1;
                const U = size === 1 ? 'u32' : `vec${size}u`;
                usedWideMultiplies.add(U);
                const a = once(out, expr(node.args[0], out), argType);
                const b = once(out, expr(node.args[1], out), argType);
                const signed = name === 'imulExtended';
                const ua = signed ? temp(out, `bitcast<${U}>(${a})`, U) : a;
                const ub = signed ? temp(out, `bitcast<${U}>(${b})`, U) : b;
                let high = `${p}mulHigh_${U.replace(/[<>]/g, '')}(${ua}, ${ub})`;
                if (signed)
                {
                    // Two's complement: each negative operand took the other
                    // 2^32 times too many into the unsigned high word.
                    const zero = `${T}(0)`;
                    high = `(${high} - select(${U}(0u), ${ub}, ${a} < ${zero})`
                        + ` - select(${U}(0u), ${ua}, ${b} < ${zero}))`;
                }
                store(node.args[2], signed ? `bitcast<${T}>(${high})` : high, out);
                store(node.args[3], `${a} * ${b}`, out);
                return '';
            }
            case 'bitfieldExtract': {
                const [v, offset, bits] = node.args.map((/** @type {any} */ a)=>expr(a, out));
                return `extractBits(${v}, u32(${offset}), u32(${bits}))`;
            }
            case 'bitfieldInsert': {
                const [base, insert, offset, bits] = node.args.map((/** @type {any} */ a)=>
                    expr(a, out));
                return `insertBits(${base}, ${insert}, u32(${offset}), u32(${bits}))`;
            }
            case 'frexp': {
                const parts = `t${temps++}`;
                out.pre.push(`let ${parts} = frexp(${expr(node.args[0], out)});`);
                store(node.args[1], `${parts}.exp`, out);
                return `${parts}.fract`;
            }
            case 'ldexp':
                return `ldexp(${expr(node.args[0], out)}, ${expr(node.args[1], out)})`;
            case 'interpolateAtCentroid':
            case 'interpolateAtSample': {
                // Every target here is drawn with one sample a pixel (decisions
                // A85, A150): its centroid and its samples are its centre,
                // where the input already is.
                if (node.args[1])
                {
                    discardValue(expr(node.args[1], out), out);
                }
                return expr(node.args[0], out);
            }
            case 'interpolateAtOffset': {
                // The input moved along its derivatives, GL's y up (decision A177).
                const v = once(out, expr(node.args[0], out), type);
                const at = once(out, expr(node.args[1], out), node.args[1].type);
                return `(${v} + dpdx(${v}) * ${at}.x + dpdy(${v}) * (${at}.y * -uniforms.misc.z))`;
            }
            case 'packDouble2x32': {
                usedDoubleBits = true;
                const words = once(out, expr(node.args[0], out), node.args[0].type);
                return `${p}doubleToFloat(${words}.x, ${words}.y)`;
            }
            case 'unpackDouble2x32':
                usedDoubleBits = true;
                return `${p}floatToDouble(${expr(node.args[0], out)})`;
            case 'anyInvocation':
            case 'allInvocations':
                // A group of one invocation, which the specification leaves
                // the implementation to choose (4.60 section 8.18).
                return expr(node.args[0], out);
            case 'allInvocationsEqual':
                discardValue(expr(node.args[0], out), out);
                return 'true';
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
        const sampler = node.args[0];
        if (sampler.node === 'index' && sampler.object.node === 'name'
            && sampler.object.symbol.storage !== 'param' && !sampler.index.constant)
        {
            return chosenSampler(node, out);
        }
        const value = lookup(node, out);
        const [tex] = samplerPair(node.args[0]).split(', ');
        const type = /** @type {import('./glsl-types.js').SamplerType} */ (node.args[0].type);
        const code = options.swizzles?.get(Number(/^glt(\d+)$/.exec(tex)?.[1] ?? -1));
        // A swizzle (3.3) remaps what a lookup returns, a comparison's and a
        // size's aside, which are not a texel's components.
        if (!code || type.shadow || node.name.startsWith('textureSize')
            || node.type.kind !== 'vector' || node.type.size !== 4)
        {
            return value;
        }
        const scalar = SCALARS[type.sampled ?? 'float'];
        return swizzledTexel(temp(out, value, `vec4<${scalar}>`), code, scalar);
    }

    /**
     * A lookup through an element of a sampler array that an expression
     * picks (4.00: an expression dynamically uniform): each element is a
     * binding of its own, so a switch makes the lookup through the one the
     * index names; out of range it is the last's, as GL leaves such an
     * index undefined.
     *
     * @param {any} node @param {Emit} out @returns {string}
     */
    function chosenSampler(node, out){
        const sampler = node.args[0];
        const length = sampler.object.type.length;
        const index = temp(out, `i32(${expr(sampler.index, out)})`, 'i32');
        const result = `t${temps++}`;
        out.pre.push(`var ${result}: ${typeOf(node.type)};`, `switch (${index}) {`);
        for (let k = 0; k < length; k++)
        {
            /** @type {Emit} */
            const caseOut = { pre: [] };
            const element = { ...sampler, index: { ...sampler.index, constant: [k] } };
            const value = textureCall({ ...node, args: [element, ...node.args.slice(1)] },
                caseOut);
            out.pre.push(`    ${k === length - 1 ? 'default' : `case ${k}`}: {`,
                ...caseOut.pre.map(line=>`        ${line}`), `        ${result} = ${value};`,
                '    }');
        }
        out.pre.push('}');
        return result;
    }

    /**
     * The lookup itself, before any swizzle.
     *
     * @param {any} node @param {Emit} out @returns {string}
     */
    function lookup(node, out){
        const name = node.name;
        const type = /** @type {import('./glsl-types.js').SamplerType} */ (node.args[0].type);
        const [tex, smp] = samplerPair(node.args[0]).split(', ');
        const rest = node.args.slice(1);
        const dim = type.dim;
        const oneD = dim === '1D';
        const c = oneD ? 1 : dim === '3D' || dim === 'Cube' ? 3 : 2;
        if (dim === 'Buffer')
        {
            // Texel n of a buffer texture is at (n mod BUFFER_ROW, n / BUFFER_ROW);
            // its size is its rows', whole past the first (`context-textures.js`).
            if (name === 'textureSize')
            {
                const d = temp(out, `textureDimensions(${tex})`, 'vec2u');
                return `i32(${d}.x * ${d}.y)`;
            }
            if (name !== 'texelFetch')
            {
                throw new Error(`glsl: the built-in '${name}' takes no buffer texture`);
            }
            const at = temp(out, expr(rest[0], out), 'i32');
            return `textureLoad(${tex}, vec2i(${at} % ${BUFFER_ROW}, ${at} / ${BUFFER_ROW}), 0)`;
        }
        if (name === 'textureSize')
        {
            const lod = rest[0] ? `, u32(${expr(rest[0], out)})` : '';
            const d = temp(out, `textureDimensions(${tex}${lod})`,
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
        if (name === 'textureQueryLevels')
        {
            return `i32(textureNumLevels(${tex}))`;
        }
        if (name === 'textureSamples')
        {
            // A multisample texture is kept with one sample a texel (decision A150).
            return '1i';
        }
        if (name === 'textureQueryLod')
        {
            return queryLod(tex, rest[0], dim, type, out);
        }
        if (name.startsWith('textureGather'))
        {
            return gather(node, tex, smp, out);
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
            if (type.ms)
            {
                // The sample asked of a texel kept as one sample.
                discardValue(expr(rest[1], out), out);
            }
            const level = dim === '2DRect' || type.ms ? ', 0' : `, ${expr(rest[1], out)}`;
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
        if (reference !== null)
        {
            // A depth texture compared by the sampler, with the function the
            // texture's TEXTURE_COMPARE_FUNC gives it. WGSL compares at an
            // implicit level in the fragment stage only, and otherwise at the
            // base level: a level, gradients or a bias asked of a comparison
            // read the base level or the implicit one.
            const compareHead = `${tex}, ${smp}, ${coords}${layer}, ${reference}`;
            const compared = fragment && level === null && !gradients
                ? `textureSampleCompare(${compareHead}${offsetCode})`
                : `textureSampleCompareLevel(${compareHead}${offsetCode})`;
            // 1.10's shadow lookups answer a luminance: (r, r, r, 1).
            return node.type.kind === 'scalar' ? compared
                : `vec4f(vec3f(${compared}), 1.0f)`;
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
        else if (!fragment)
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
        return sample;
    }

    /**
     * textureQueryLod (4.00 section 8.9.1): the level the lookup's
     * derivatives choose, x clamped to the texture's levels and y not, worked
     * out from the coordinates' derivatives scaled by the base level's size
     * as the specification's lambda is (a cube map's on its major axis'
     * face); WGSL has no query of the level the hardware takes (decision
     * A176).
     *
     * @param {string} tex @param {any} coordinate @param {string} dim
     * @param {import('./glsl-types.js').SamplerType} type @param {Emit} out
     * @returns {string}
     */
    function queryLod(tex, coordinate, dim, type, out){
        const P = once(out, expr(coordinate, out), coordinate.type);
        const size = `vec2f(textureDimensions(${tex}))`;
        let du;
        let dv;
        if (dim === 'Cube')
        {
            const at = temp(out, `${P}.xyz`, 'vec3f');
            const major = temp(out, `max(abs(${at}.x), max(abs(${at}.y), abs(${at}.z)))`, 'f32');
            const scale = temp(out, `${size}.x * 0.5f / ${major}`, 'f32');
            du = `(dpdx(${at}) * ${scale})`;
            dv = `(dpdy(${at}) * ${scale})`;
        }
        else if (dim === '3D')
        {
            const scale = `vec3f(textureDimensions(${tex}))`;
            du = `(dpdx(${P}.xyz) * ${scale})`;
            dv = `(dpdy(${P}.xyz) * ${scale})`;
        }
        else if (dim === '1D')
        {
            const at = coordinate.type.kind === 'vector' ? `${P}.x` : P;
            du = `vec2f(dpdx(${at}) * ${size}.x, 0.0f)`;
            dv = `vec2f(dpdy(${at}) * ${size}.x, 0.0f)`;
        }
        else
        {
            du = `(dpdx(${P}.xy) * ${size})`;
            dv = `(dpdy(${P}.xy) * ${size})`;
        }
        const lambda = temp(out, `0.5f * log2(max(max(dot(${du}, ${du}), dot(${dv}, ${dv})),`
            + ' 1e-30f))', 'f32');
        const most = `f32(textureNumLevels(${tex}) - 1u)`;
        return `vec2f(clamp(${lambda}, 0.0f, ${most}), ${lambda})`;
    }

    /**
     * textureGather and its offset forms (4.00 section 8.9.4): WGSL's gather
     * of one component, or of the comparisons for a shadow sampler, in GL's
     * order of the four texels (i0j1, i1j1, i1j0, i0j0). textureGatherOffsets
     * gathers once an offset and keeps each footprint's i0j0 texel.
     *
     * @param {any} node @param {string} tex @param {string} smp @param {Emit} out
     * @returns {string}
     */
    function gather(node, tex, smp, out){
        const name = node.name;
        const type = /** @type {import('./glsl-types.js').SamplerType} */ (node.args[0].type);
        const rest = node.args.slice(1);
        const P = once(out, expr(rest[0], out), rest[0].type);
        const c = type.dim === 'Cube' ? 3 : 2;
        const pSize = rest[0].type.kind === 'vector' ? rest[0].type.size : 1;
        let coords = pSize === c ? P : `${P}.${XYZW.slice(0, c)}`;
        if (type.dim === '2DRect')
        {
            coords = `(${coords} / vec2f(textureDimensions(${tex})))`;
        }
        const layer = type.array ? `, i32(floor(${P}.${XYZW[c]} + 0.5f))` : '';
        let at = 1;
        const reference = type.shadow ? expr(rest[at++], out) : null;
        const offsets = name === 'textureGatherOffsets' ? rest[at++]
            : name === 'textureGatherOffset' ? rest[at++] : null;
        const component = !type.shadow && rest[at] ? expr(rest[at], out) : '0';
        /** @param {string | null} offset */
        const gatherOnce = offset=>{
            const tail = offset === null ? '' : `, ${offset}`;
            return reference !== null
                ? `textureGatherCompare(${tex}, ${smp}, ${coords}${layer}, ${reference}${tail})`
                : `textureGather(${component}, ${tex}, ${smp}, ${coords}${layer}${tail})`;
        };
        if (name !== 'textureGatherOffsets')
        {
            return gatherOnce(offsets === null ? null : expr(offsets, out));
        }
        const list = expr(/** @type {any} */ (offsets), out);
        const scalar = type.shadow ? 'f32' : SCALARS[type.sampled ?? 'float'];
        return `vec4<${scalar}>(${[0, 1, 2, 3].map(k=>`${gatherOnce(`${list}[${k}]`)}.w`)
            .join(', ')})`;
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
     * Whether control never goes on past a statement: one that leaves, a
     * block whose last statement does, an if both of whose branches do.
     *
     * @param {any} node @returns {boolean}
     */
    const leaves = node=>{
        if (!node)
        {
            return false;
        }
        if (LEAVES.has(node.node))
        {
            return true;
        }
        if (node.node === 'block')
        {
            return leaves(node.body[node.body.length - 1]);
        }
        return node.node === 'if' && !!node.otherwise && leaves(node.then)
            && leaves(node.otherwise);
    };

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
                if (leaves(groups[at].statements[groups[at].statements.length - 1]))
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
                if ((node.op === '++' || node.op === '--') && !inMemory(node.operand))
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
                // A geometry shader's vertex, stored with every output it has
                // now, and the end of its strip.
                if (!node.user && (node.name === 'EmitVertex' || node.name === 'EndPrimitive'))
                {
                    out.pre.push(node.name === 'EmitVertex' ? `${p}emit();` : `${p}cut();`);
                    return;
                }
                // Stream 0 is the one rasterised; a vertex emitted to another
                // reaches only transform feedback, which the link refused (A182).
                if (!node.user && (node.name === 'EmitStreamVertex'
                    || node.name === 'EndStreamPrimitive'))
                {
                    if (node.args[0].constant[0] === 0)
                    {
                        out.pre.push(node.name === 'EmitStreamVertex' ? `${p}emit();`
                            : `${p}cut();`);
                    }
                    return;
                }
                // Outside a compute stage an invocation's own accesses are in
                // its order already, and WGSL has these barriers in compute alone;
                // a control shader's invocations meet at barrier() (4.00 language
                // section 8.15), which stands only in main, outside control flow.
                if (!node.user && BARRIERS[node.name])
                {
                    if (computing || (tessControl && node.name === 'barrier'))
                    {
                        out.pre.push(`${BARRIERS[node.name]}();`);
                    }
                    return;
                }
                if (!node.user && node.type.kind === 'void')
                {
                    // A built-in of no value (umulExtended) writes its out
                    // parameters as it is translated.
                    discardValue(expr(node, out), out);
                    return;
                }
                if (node.user || node.subroutine)
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
                    `ps${id}_${name}: ${samplerVarTypeOf(param.type)}`);
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

    // --- the passes before a geometry shader's draw ---

    /**
     * A value's leaves as the registers between the passes take them
     * (`registersOf`), in order.
     *
     * @param {string} source @param {GlslType} type
     * @returns {{ code: string, type: string }[]}
     */
    function leavesOf(source, type){
        switch (type.kind)
        {
            case 'array':
                return Array.from({ length: type.length }, (_, k)=>
                    leavesOf(`${source}[${k}]`, type.element)).flat();
            case 'matrix':
                return Array.from({ length: type.cols }, (_, c)=>
                    leavesOf(`${source}[${c}]`, vectorOf('float', type.rows))).flat();
            case 'struct':
                return type.fields.flatMap(field=>leavesOf(`${source}.m_${field.name}`,
                    field.type));
            default:
                return [{ code: source, type: typeOf(type) }];
        }
    }

    /**
     * The vertex stage as a compute pass, one invocation a position of the
     * draw and instance: the position's vertex found as the draw finds it
     * (its index, or the first vertex counted on), each array's element read
     * out of the array's words (an element past the end of its buffer reads
     * zero), the shader run, and what the geometry shader reads of it stored
     * a register a leaf (`geometryInputRegisters`): gl_Position, gl_PointSize,
     * then the inputs by name.
     *
     * `vsParams`: the positions, the positions an instance, the index size
     * in bytes (0 for none), the index buffer's byte offset, the first index
     * or vertex, the base vertex; then, an array each, its byte offset, its
     * stride and whether it steps by instance.
     *
     * @returns {string}
     */
    function vertexComputeEntry(){
        const slots = Math.max(1, ...options.attributes.map(a=>a.slot + 1));
        const b = GLSL_VERTEX_PASS_BINDING;
        declarations.push([
            'struct VsParams { count: u32, perInstance: u32, indexBytes: u32, indexOffset: u32,',
            '    first: u32, baseVertex: i32, pad0: u32, pad1: u32,',
            `    slots: array<vec4u, ${slots}>, }`,
            `@group(1) @binding(${b.indices}) var<storage, read> vsIndices: array<u32>;`,
            `@group(1) @binding(${b.out}) var<storage, read_write> vsOut: array<vec4u>;`,
            `@group(1) @binding(${b.params}) var<uniform> vsParams: VsParams;`,
            ...Array.from({ length: slots }, (_, k)=>`@group(1) @binding(${b.slots + k})`
                + ` var<storage, read> vsSlot${k}: array<u32>;`),
            ...Array.from({ length: slots }, (_, k)=>[
                `fn vsWord${k}(at: u32) -> u32 {`,
                '    let w = at >> 2u;',
                `    let n = arrayLength(&vsSlot${k});`,
                '    if (w >= n) { return 0u; }',
                '    let s = (at & 3u) * 8u;',
                `    let lo = vsSlot${k}[w];`,
                '    if (s == 0u) { return lo; }',
                `    let hi = select(0u, vsSlot${k}[min(w + 1u, n - 1u)], w + 1u < n);`,
                '    return (lo >> s) | (hi << (32u - s));',
                '}'].join('\n')),
            'fn vsIndex(i: u32) -> u32 {',
            '    let at = vsParams.indexOffset + i * vsParams.indexBytes;',
            '    if ((at >> 2u) >= arrayLength(&vsIndices)) { return 0u; }',
            '    let word = vsIndices[at >> 2u];',
            '    if (vsParams.indexBytes == 2u) { return extractBits(word, (at & 2u) * 8u, 16u); }',
            '    return word;',
            '}'].join('\n'));
        /** @type {string[]} */
        const fetch = options.attributes.length > 0 ? ['    var vertex: VertexIn;'] : [];
        const used = new Set(options.attributes.map(a=>a.slot));
        for (const k of used)
        {
            fetch.push(`    let vsAt${k} = vsParams.slots[${k}].x + select(vertexIndex,`
                + ` instanceIndex, vsParams.slots[${k}].z != 0u) * vsParams.slots[${k}].y;`);
        }
        for (const attribute of options.attributes)
        {
            const decoder = vertexFetch(attribute.format);
            if (!decoder)
            {
                throw new Error(`an array of format ${attribute.format} is read before a`
                    + ' geometry shader, which this implementation does not do');
            }
            const at = `vsAt${attribute.slot} + ${attribute.offset}u`;
            const words = Array.from({ length: Math.ceil(decoder.bytes / 4) },
                (_, index)=>`vsWord${attribute.slot}(${at} + ${index * 4}u)`);
            const register = decoder.register(words);
            const four = attribute.scalar === 'f32' ? `bitcast<vec4f>(${register})`
                : attribute.scalar === 'i32' ? `bitcast<vec4i>(${register})` : register;
            const n = attribute.components;
            fetch.push(`    if (${at} + ${decoder.bytes}u <= arrayLength(&vsSlot${attribute.slot})`
                + ' * 4u) {',
            `        vertex.${attribute.name} = ${n === 4 ? four : n === 1 ? `${four}.x`
                : `${four}.${XYZW.slice(0, n)}`};`, '    }');
        }
        const registers = vertexPassRegisters(program);
        /** @type {string[]} */
        const stores = [`    vsOut[base] = bitcast<vec4u>(${p}gl_Position);`,
            `    vsOut[base + 1u] = vec4u(bitcast<u32>(${linked.uses.has('gl_PointSize')
                ? `${p}gl_PointSize` : '1.0f'}), 0u, 0u, 0u);`];
        let at = 2;
        const kept = program.tessEvaluation ? tessellationInputs(program)
            : program.geometry ? program.geometryInputs.map(input=>({
                path: input.vertexPath, type: input.type }))
                : feedbackLeaves(program, true);
        for (const value of kept)
        {
            for (const leaf of leavesOf(`${p}${value.path}`, value.type))
            {
                stores.push(`    vsOut[base + ${at++}u] = ${toRegister(leaf.code, leaf.type)};`);
            }
        }
        return `@compute @workgroup_size(64)
fn vertexCompute(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= vsParams.count) { return; }
    let instanceIndex = id.x / max(1u, vsParams.perInstance);
    let point = id.x % max(1u, vsParams.perInstance);
    var vertexIndex = vsParams.first + point;
    if (vsParams.indexBytes != 0u) {
        vertexIndex = bitcast<u32>(bitcast<i32>(vsIndex(vsParams.first + point))`
            + ` + vsParams.baseVertex);
    }
${[...fetch, ...prologue, ...initial, `    ${p}main();`,
        `    let base = id.x * ${registers}u;`, ...stores].join('\n')}
}`;
    }

    /**
     * The geometry shader as a compute pass, one invocation a primitive and
     * instance of the draw (Direct3D's `linkGeometry`, for GLSL): its
     * vertices read out of what the vertex pass wrote, the shader run, each
     * vertex it emits stored with every output it has then (`gl_Position`,
     * then the fields the fragment stage reads) at its invocation's next
     * place, with whether it starts a strip; each invocation's primitives and
     * vertices counted where the sums read them (stream 0's).
     *
     * `gsParams`: the invocations, the primitives an instance.
     *
     * @returns {string}
     */
    function geometryEntry(){
        const layout = /** @type {import('./glsl-link.js').GeometryLayout} */ (
            program.geometryLayout);
        const vertices = layout.inputVertices;
        const most = Math.max(1, layout.maxVertices);
        // A primitive's invocations run one after another (4.0's instancing):
        // the n-th of them reads primitive n / invocations.
        const runs = Math.max(1, layout.invocations ?? 1);
        const inputs = geometryInputRegisters(program);
        // What transform feedback captures, after what the fragment stage reads.
        const captured = feedbackLeaves(program, false).flatMap(leaf=>leavesOf(`${p}${leaf.path}`,
            leaf.type));
        const outputs = 1 + fields.length + captured.length;
        const b = GLSL_GEOMETRY_PASS_BINDING;
        declarations.push([
            'struct GsParams { invocations: u32, prims: u32, pad0: u32, pad1: u32, }',
            `@group(1) @binding(${b.inputs}) var<storage, read> gsIn: array<vec4u>;`,
            `@group(1) @binding(${b.vertices}) var<storage, read_write> gsVertices: array<vec4u>;`,
            `@group(1) @binding(${b.starts}) var<storage, read_write> gsStarts: array<u32>;`,
            `@group(1) @binding(${b.counts}) var<storage, read_write> gsCounts: array<vec4u>;`,
            `@group(1) @binding(${b.params}) var<uniform> gsParams: GsParams;`,
            'var<private> gsInvocation: u32;',
            'var<private> gsEmitted: u32;',
            'var<private> gsMade: u32;',
            'var<private> gsStrip: u32;',
            `fn ${p}emit() {`,
            `    if (gsEmitted >= ${most}u) { return; }`,
            `    let at = gsInvocation * ${most}u + gsEmitted;`,
            `    gsVertices[at * ${outputs}u] = bitcast<vec4u>(${p}gl_Position);`,
            ...fields.map((f, k)=>`    gsVertices[at * ${outputs}u + ${k + 1}u] = `
                + `${toRegister(f.source, f.type)};`),
            ...captured.map((leaf, k)=>`    gsVertices[at * ${outputs}u + `
                + `${k + 1 + fields.length}u] = ${toRegister(leaf.code, leaf.type)};`),
            '    gsStarts[at] = select(0u, 1u, gsStrip == 0u);',
            '    gsEmitted += 1u;',
            '    gsStrip += 1u;',
            `    if (gsStrip >= ${layout.outputVertices}u) { gsMade += 1u; }`,
            '}',
            `fn ${p}cut() {`,
            '    gsStrip = 0u;',
            '}'].join('\n'));
        /** @type {string[]} */
        const loads = [];
        for (let j = 0; j < vertices; j++)
        {
            loads.push(`    let in${j} = (primitive * ${vertices}u + ${j}u) * ${inputs}u;`);
            if (linked.uses.has('gl_in'))
            {
                loads.push(`    ${p}gl_in[${j}].m_gl_Position = bitcast<vec4f>(gsIn[in${j}]);`,
                    `    ${p}gl_in[${j}].m_gl_PointSize = bitcast<f32>(gsIn[in${j} + 1u].x);`);
            }
            let at = 2;
            for (const input of program.geometryInputs)
            {
                const path = `${p}${input.geometryPath.replace('[]', `[${j}]`)}`;
                for (const leaf of leavesOf(path, input.type))
                {
                    loads.push(`    ${leaf.code} = ${fromRegister(`gsIn[in${j} + ${at++}u]`,
                        leaf.type)};`);
                }
            }
        }
        // After tessellation the passes are sized by the most the tessellator
        // may make: an invocation past what it made makes nothing.
        const limit = options.limited ? [
            `    if ((primitive + 1u) * ${vertices}u > gsLimit[0]) {`,
            '        gsCounts[id.x * 2u] = vec4u(0u);',
            '        gsCounts[id.x * 2u + 1u] = vec4u(0u);',
            '        return;',
            '    }'] : [];
        if (options.limited)
        {
            declarations.push(`@group(1) @binding(${b.limit}) var<storage, read> gsLimit:`
                + ' array<u32>;');
        }
        return `@compute @workgroup_size(64)
fn geometryMain(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= gsParams.invocations) { return; }
    gsInvocation = id.x;
    let primitive = id.x / ${runs}u;
${[...limit, ...linked.uses.has('gl_PrimitiveIDIn')
        ? [`    ${p}gl_PrimitiveIDIn = i32(primitive % max(1u, gsParams.prims));`] : [],
    ...linked.uses.has('gl_InvocationID')
        ? [`    ${p}gl_InvocationID = i32(id.x % ${runs}u);`] : [],
    ...loads, ...initial, `    ${p}main();`,
    '    gsCounts[id.x * 2u] = vec4u(gsMade, 0u, 0u, 0u);',
    '    gsCounts[id.x * 2u + 1u] = vec4u(gsEmitted, 0u, 0u, 0u);'].join('\n')}
}`;
    }

    // --- a compute shader's entry point (4.3) ---

    /**
     * The work group's invocations, each the built-ins it reads set from
     * WGSL's own, then main.
     *
     * @returns {string}
     */
    function computeEntry(){
        const [x, y, z] = /** @type {[number, number, number]} */ (program.localSize);
        /** @type {[string, string, string][]} */
        const builtins = [
            ['gl_GlobalInvocationID', 'global_invocation_id', 'vec3u'],
            ['gl_LocalInvocationID', 'local_invocation_id', 'vec3u'],
            ['gl_WorkGroupID', 'workgroup_id', 'vec3u'],
            ['gl_NumWorkGroups', 'num_workgroups', 'vec3u'],
            ['gl_LocalInvocationIndex', 'local_invocation_index', 'u32'],
        ];
        const used = builtins.filter(([name])=>linked.uses.has(name));
        return `@compute @workgroup_size(${x}, ${y}, ${z})
fn computeMain(${used.map(([name, builtin, type])=>`@builtin(${builtin}) ${name}In: ${type}`)
        .join(', ')}) {
${[...used.map(([name])=>`    ${p}${name} = ${name}In;`), ...prologue, ...initial,
        `    ${p}main();`].join('\n')}
}`;
    }

    // --- the interface and the entry point ---

    /** @type {Interface} */
    const fields = [];
    let entry;
    /** @param {string[]} out @returns {TessEntryContext} */
    const entryContext = out=>({ program, linked, p, leavesOf, initial, declarations, out });
    if (computing)
    {
        entry = computeEntry();
    }
    else if (tessControl)
    {
        entry = /** @type {NonNullable<StageOptions['entry']>} */ (options.entry)(
            entryContext([]));
    }
    else if (vertex || geometry || tessEvaluation)
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
        // A geometry shader passes its primitive's number on by a field of
        // its own, flat: WGSL has no fragment input for it.
        if (geometry && program.fragment?.uses.has('gl_PrimitiveID'))
        {
            fields.push({ field: `i${fields.length}`, type: 'i32', flat: true,
                source: `${p}gl_PrimitiveID`, interpolate: '@interpolate(flat) ' });
        }
        // The viewport a primitive is drawn through (4.1) and the layer it is
        // drawn into (3.2), flat too: the draw of what the shader made is
        // repeated for each viewport and layer, and a vertex of another one is
        // put out of the clip volume (`geometryDrawStage`).
        for (const [name, route] of /** @type {const} */ ([['gl_ViewportIndex', 'x'],
            ['gl_Layer', 'y']]))
        {
            if (geometry && linked.uses.has(name))
            {
                fields.push({ field: `i${fields.length}`, type: 'i32', flat: true, route,
                    source: `${p}${name}`, interpolate: '@interpolate(flat) ' });
            }
        }
        const out = partner === 'glsl'
            ? fields.map(f=>`    out.${f.field} = ${f.source};`)
            : fixedOutputs(linked, p, /** @type {FixedVaryings} */ (options.fixed));
        /** @type {string[]} */
        const inputs = options.attributes.length > 0 ? ['vertex: VertexIn'] : [];
        // The draw's own numbers (`plan.idBias`): what gl_VertexID adds to
        // WebGPU's index, which counts from where the draw put its arrays,
        // and 4.60's base vertex, base instance and draw index.
        const drawNumbers = /** @type {const} */ ([['gl_VertexID', 'x'], ['gl_BaseVertex', 'y'],
            ['gl_BaseInstance', 'z'], ['gl_DrawID', 'w']]).filter(([name])=>vertex
            && linked.uses.has(name));
        if (drawNumbers.length > 0)
        {
            blockMembers.push('    id_bias: vec4i,');
            plan.idBias = slot * 4;
            slot++;
        }
        for (const [name, part] of drawNumbers)
        {
            if (name === 'gl_VertexID')
            {
                inputs.push('@builtin(vertex_index) vertexIndex: u32');
                prologue.push(`    ${p}gl_VertexID = i32(vertexIndex) + ${p}u.id_bias.x;`);
            }
            else
            {
                prologue.push(`    ${p}${name} = ${p}u.id_bias.${part};`);
            }
        }
        if (vertex && linked.uses.has('gl_InstanceID'))
        {
            // The draw starts every instanced draw at instance zero.
            inputs.push('@builtin(instance_index) instanceIndex: u32');
            prologue.push(`    ${p}gl_InstanceID = i32(instanceIndex);`);
        }
        entry = geometry ? geometryEntry()
            : tessEvaluation ? /** @type {NonNullable<StageOptions['entry']>} */ (options.entry)(
                entryContext(out))
                : options.compute ? vertexComputeEntry() : `@vertex
fn vertexMain(${inputs.join(', ')}) -> VertexOut {
${[...prologue, ...initial, `    ${p}main();`, '    var out: VertexOut;',
        `    let clip = ${p}gl_Position;`,
        `    out.position = ${CLIP_REMAP};`,
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
            if (program.geometry && linked.uses.has('gl_PrimitiveID'))
            {
                take(`${p}gl_PrimitiveID`, INT);
            }
            // The geometry shader's viewport and layer, the last fields, found
            // by what they route: the shader writes them whether or not this
            // stage reads them.
            for (const [name, route] of [['gl_ViewportIndex', 'x'], ['gl_Layer', 'y']])
            {
                const field = interfaceFields.find(f=>f.route === route);
                if (field && linked.uses.has(name))
                {
                    inputs.push(`    ${p}${name} = input.${field.field};`);
                }
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
        // 4.0's samples: WGSL's own index and mask; a sample's place is
        // where WebGPU puts the position when the stage runs a sample at a
        // time, which naming the index makes it do; GL's y runs up.
        const perSample = ['gl_SampleID', 'gl_SamplePosition'].some(name=>linked.uses.has(name));
        const maskIn = linked.uses.has('gl_SampleMaskIn');
        if (linked.uses.has('gl_SampleID'))
        {
            inputs.push(`    ${p}gl_SampleID = i32(sampleIndex);`);
        }
        if (linked.uses.has('gl_SamplePosition'))
        {
            inputs.push(`    ${p}gl_SamplePosition = vec2f(fract(input.position.x), select(`
                + 'fract(input.position.y), 1.0f - fract(input.position.y),'
                + ' uniforms.misc.z > 0.0f));');
        }
        if (maskIn)
        {
            inputs.push(`    ${p}gl_SampleMaskIn[0] = bitcast<i32>(sampleMaskIn);`);
        }
        const writesMask = linked.uses.has('gl_SampleMask');
        if (writesMask)
        {
            // A path that does not write it keeps every sample.
            inputs.push(`    ${p}gl_SampleMask[0] = -1i;`);
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
        if (writesMask)
        {
            outputs.push(`    out.mask = bitcast<u32>(${p}gl_SampleMask[0]);`);
        }
        const alpha = options.alphaFunc === null ? []
            : [`    if (!(${options.compare(options.alphaFunc, `${colour(0)}.a`,
                'uniforms.misc.x')})) {`, '        discard;', '    }'];
        declarations.push(`struct FragmentOut {\n${scalars.map((scalar, k)=>
            `    @location(${k}) c${k}: vec4${suffixOf(scalar)},`).join('\n')}${writesDepth
            ? '\n    @builtin(frag_depth) depth: f32,' : ''}${writesMask
            ? '\n    @builtin(sample_mask) mask: u32,' : ''}\n};`);
        const sampleInputs = `${perSample ? ', @builtin(sample_index) sampleIndex: u32' : ''}${
            maskIn ? ', @builtin(sample_mask) sampleMaskIn: u32' : ''}`;
        entry = `@fragment
fn fragmentMain(input: VertexOut, @builtin(front_facing) facing: bool${sampleInputs})`
            + ` -> FragmentOut {
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
    const blockName = vertex ? 'VertexBlock' : geometry ? 'GeometryBlock'
        : tessControl ? 'ControlBlock' : tessEvaluation ? 'EvaluationBlock'
            : computing ? 'ComputeBlock' : 'FragmentBlock';
    const group = fragment ? GLSL_FRAGMENT_GROUP : 0;
    // The evaluation shader is the draw's vertex stage; the control shader a
    // compute pass, whose block takes the binding a geometry shader's would.
    const binding = vertex || tessEvaluation ? GLSL_VERTEX_BINDING
        : geometry || tessControl ? GLSL_GEOMETRY_BINDING
            : computing ? GLSL_COMPUTE_BINDING : GLSL_FRAGMENT_BINDING;
    const blockCode = blockMembers.length > 0
        ? `struct ${blockName} {\n${blockMembers.join('\n')}\n};
@group(${group}) @binding(${binding}) var<uniform> ${p}u: ${blockName};`
        : '';

    const samplerDeclarations = [...usedSamplers].sort((a, b)=>a - b).map(index=>{
        const sampler = program.samplers[index];
        const kind = textureTypeOf(samplerTypeOf(sampler));
        return `@group(0) @binding(${samplerBinding(index)}) var glt${index}: ${kind};
@group(0) @binding(${samplerBinding(index) + 1}) var gls${index}:`
            + ` ${samplerVarTypeOf(samplerTypeOf(sampler))};`;
    });

    const memoryDeclarations = [
        ...[...usedStorage].sort((a, b)=>a - b).map(index=>`@group(0) @binding(`
            + `${GLSL_STORAGE_BINDING + index}) var<storage, read_write> gss${index}: array<`
            + `${atomicStorage.has(/** @type {any} */ (program.storageBlocks)[index].blockName)
                ? 'atomic<u32>' : 'u32'}>;`),
        ...[...usedImages].sort(([a], [b])=>a - b).map(([index, ways])=>{
            const image = /** @type {any} */ (program.images)[index];
            const format = IMAGE_FORMATS.find(([name])=>name === image.format)?.[2];
            if (!format)
            {
                throw new Error(`glsl: image '${image.leaf.base}' is of format`
                    + ` '${image.format || 'none'}', which WebGPU does not store into`);
            }
            const layered = image.type.array || image.type.dim === 'Cube';
            const shape = image.type.dim === '3D' ? '3d' : image.type.dim === '1D' ? '1d'
                : layered ? '2d_array' : '2d';
            const access = ways.has('read') && ways.has('write') ? 'read_write'
                : ways.has('read') ? 'read' : 'write';
            return `@group(0) @binding(${GLSL_IMAGE_BINDING + index}) var gim${index}:`
                + ` texture_storage_${shape}<${format}, ${access}>;`;
        }),
        ...[...usedCounters].sort((a, b)=>a - b).map(point=>`@group(0) @binding(`
            + `${GLSL_COUNTER_BINDING + point}) var<storage, read_write> gac${point}:`
            + ' array<atomic<u32>>;'),
    ];
    return {
        code: [...memoryDeclarations, ...declarations, blockCode, ...privates, ...loaders,
            ...[...usedInverses].sort().map(n=>inverseFunction(p, n)),
            ...[...usedWideMultiplies].sort().map(U=>mulHighFunction(p, U)),
            usedDoubleBits ? doubleBitsFunctions(p) : '',
            ...[...dynamicBlocks].sort((a, b)=>a - b).map(b=>`fn ${p}ubw${b}(o: u32) -> u32 {
    return glb${b}[o >> 4u][(o >> 2u) & 3u];
}`), ...functions, entry]
            .filter(Boolean).join('\n\n'),
        samplers: samplerDeclarations,
        usedSamplers: [...usedSamplers],
        usedBlocks: [...usedBlocks],
        usedStorage: [...usedStorage],
        usedImages: [...usedImages].map(([index, ways])=>imageUse(
            /** @type {any} */ (program.images)[index], index, ways)),
        writtenStorage: [...writtenStorage],
        usedCounters: [...usedCounters],
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
 * A double's words as the f32 that carries it, and an f32 as a double's
 * words (decision A178): exponent and fraction moved between the two
 * layouts, rounded to nearest where the double has more than an f32 holds;
 * a double past an f32's range is its infinity, below it its zero.
 *
 * @param {string} p  the stage's prefix
 * @returns {string}
 */
function doubleBitsFunctions(p){
    return `fn ${p}doubleToFloat(lo: u32, hi: u32) -> f32 {
    let sign = hi & 0x80000000u;
    let exponent = i32((hi >> 20u) & 0x7ffu);
    if (exponent == 0x7ff) {
        let nan = (hi & 0xfffffu) != 0u || lo != 0u;
        return bitcast<f32>(sign | select(0x7f800000u, 0x7fc00000u, nan));
    }
    let e = exponent - 1023 + 127;
    if (exponent == 0 || e < -23) {
        return bitcast<f32>(sign);
    }
    if (e >= 255) {
        return bitcast<f32>(sign | 0x7f800000u);
    }
    // 52 fraction bits to 23, the 29 dropped rounding to nearest, ties to even.
    var fraction = ((hi & 0xfffffu) << 3u) | (lo >> 29u);
    let dropped = lo & 0x1fffffffu;
    if (e <= 0) {
        // Below an f32's normal range: its subnormal, the implicit bit shown.
        let value = ldexp(1.0f + f32(fraction) / 8388608.0f, exponent - 1023);
        return bitcast<f32>(sign | bitcast<u32>(value));
    }
    var bits = (u32(e) << 23u) | fraction;
    if (dropped > 0x10000000u || (dropped == 0x10000000u && (bits & 1u) == 1u)) {
        bits = bits + 1u;
    }
    return bitcast<f32>(sign | bits);
}

fn ${p}floatToDouble(v: f32) -> vec2u {
    let bits = bitcast<u32>(v);
    let sign = bits & 0x80000000u;
    let exponent = (bits >> 23u) & 0xffu;
    var fraction = bits & 0x7fffffu;
    if (exponent == 0xffu) {
        return vec2u(fraction << 29u, sign | 0x7ff00000u | (fraction >> 3u));
    }
    if (exponent == 0u) {
        if (fraction == 0u) {
            return vec2u(0u, sign);
        }
        // A subnormal f32 is a normal double: its leading bit made implicit.
        let lead = firstLeadingBit(fraction);
        let shift = 23u - lead;
        fraction = (fraction << shift) & 0x7fffffu;
        let e = u32(1023 - 126) - shift;
        return vec2u(fraction << 29u, sign | (e << 20u) | (fraction >> 3u));
    }
    let e = exponent - 127u + 1023u;
    return vec2u(fraction << 29u, sign | (e << 20u) | (fraction >> 3u));
}`;
}

/**
 * The high word of a 32-by-32-bit unsigned product, which WGSL has no
 * 64-bit integer for (umulExtended, imulExtended): the product of 16-bit
 * halves, their carries gathered, component by component.
 *
 * @param {string} p  the stage's prefix @param {string} U  u32 or vecNu
 * @returns {string}
 */
function mulHighFunction(p, U){
    return `fn ${p}mulHigh_${U}(a: ${U}, b: ${U}) -> ${U} {
    let m = ${U}(0xffffu);
    let s = ${U}(16u);
    let al = a & m; let ah = a >> s; let bl = b & m; let bh = b >> s;
    let low = al * bl; let cross1 = al * bh; let cross2 = ah * bl;
    let middle = (low >> s) + (cross1 & m) + (cross2 & m);
    return ah * bh + (cross1 >> s) + (cross2 >> s) + (middle >> s);
}`;
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

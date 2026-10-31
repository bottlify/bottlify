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

import { FLOAT, baseOf, componentsOf, glslName, vectorOf } from './glsl-types.js';
import { BUILTIN_ATTRIBUTES, BUILTIN_VARIABLES } from './glsl-builtins.js';
import { canonicalAttribName } from './arb-program.js';

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

/** A sampler's texture binding; its sampler is the next one. @param {number} index */
export const samplerBinding = index=>1 + index * 2;

/**
 * What a stage's uniform block holds and where, in 32-bit words.
 *
 * @typedef {Object} BlockPlan
 * @property {number} words  the block's size
 * @property {Int32Array} copies  triples: a store offset, a block offset, a count
 * @property {{ name: string, offset: number }[]} state  built-in state uniforms
 *     (`gl_ModelViewMatrix`, `gl_LightSource`, ...), each at its first slot
 * @property {{ location: number, builtin: string | null, offset: number }[]} attribs
 *     the current value of each attribute the draw has no array for, a slot each
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
 * @typedef {{ field: string, type: string, flat: boolean, source: string }[]} Interface
 */

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
${fields.map((f, k)=>`    @location(${k}) ${f.flat ? '@interpolate(flat) ' : ''}`
        + `${f.field}: ${f.type},`).join('\n')}
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
            return type.base === 'float' ? 'vec4f' : 'vec4i';
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
            return type.base === 'float' ? 'f32' : type.base === 'int' ? 'i32' : 'bool';
        case 'vector':
            return type.base === 'float' ? `vec${type.size}f`
                : type.base === 'int' ? `vec${type.size}i` : `vec${type.size}<bool>`;
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
        if (symbol.storage !== 'uniform' || !linked.uses.has(symbol.name)
            || symbol.type.kind === 'sampler'
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
    const attributeValue = (attribute, components)=>{
        const source = `vertex.${attribute.name}`;
        const asFloat = attribute.scalar === 'f32' ? source
            : attribute.components === 1 ? `f32(${source})`
                : `vec${attribute.components}f(${source})`;
        const four = attribute.components === 4 ? asFloat
            : attribute.components === 1 ? `vec4f(${asFloat}, 0.0, 0.0, 1.0)`
                : attribute.components === 2 ? `vec4f(${asFloat}, 0.0, 1.0)`
                    : `vec4f(${asFloat}, 1.0)`;
        return components === 4 ? four : components === 1 ? `${four}.x`
            : `${four}.${XYZW.slice(0, components)}`;
    };

    /**
     * The block slot an attribute's current value is read from when the draw
     * has no array for it.
     *
     * @param {number} location @param {string | null} builtin
     */
    const currentSlot = (location, builtin)=>{
        const existing = attribMember.get(location);
        if (existing)
        {
            return existing;
        }
        const member = `a_${location}`;
        blockMembers.push(`    ${member}: vec4f,`);
        plan.attribs.push({ location, builtin, offset: slot * 4 });
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
            /** @type {string[]} */
            const parts = [];
            for (let c = 0; c < columns; c++)
            {
                const location = attribute.location + c;
                const name = canonicalAttribName(location);
                const index = layoutNames.indexOf(name);
                const four = index >= 0 ? attributeValue(options.attributes[index], 4)
                    : currentSlot(location, null);
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
            const builtin = BUILTIN_VARIABLE_TYPES.vertex[name];
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
        if (symbol.storage === 'uniform')
        {
            continue;
        }
        declareStructs(symbol.type);
        privates.push(`var<private> ${p}g_${symbol.name}: ${typeOf(symbol.type)};`);
    }
    for (const name of linked.uses)
    {
        const type = BUILTIN_VARIABLE_TYPES[which][name];
        if (!type || STATE_UNIFORMS.has(name) || CONSTANTS.has(name))
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
            : v ? 'true' : 'false');
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
            default:
                throw new Error(`glsl: cannot emit a ${node.node}`);
        }
    }

    /** A value of one, for an increment. @param {GlslType} type */
    const one = type=>{
        const base = baseOf(type);
        const scalar = base === 'int' ? '1i' : '1.0f';
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
        const value = arithmetic(op, current, node.target.type, expr(node.value, out),
            node.value.type, node.type, out);
        store(node.target, value, out);
    }

    /** @param {any} node @param {Emit} out @returns {string} */
    function unary(node, out){
        switch (node.op)
        {
            case '-': {
                const operand = expr(node.operand, out);
                return node.type.kind === 'matrix' ? `(${operand} * -1.0f)` : `(-${operand})`;
            }
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
        return arithmetic(op, left, node.left.type, right, node.right.type, node.type, out);
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

    /** @param {string} code @param {'float' | 'int' | 'bool'} from @param {'float' | 'int' | 'bool'} to */
    const castScalar = (code, from, to)=>(from === to ? code
        : `${to === 'float' ? 'f32' : to === 'int' ? 'i32' : 'bool'}(${code})`);

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
        const base = /** @type {'float' | 'int' | 'bool'} */ (baseOf(type));
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
            return a.type.kind === 'scalar' && size > 1 && a.type.base === 'float'
                ? `vec${size}f(${code})` : code;
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
            fwidth: 'fwidth',
        };
        const direct = ['radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'exp', 'log',
            'exp2', 'log2', 'sqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'pow', 'length',
            'distance', 'cross', 'transpose', 'any', 'all', 'inversesqrt', 'fwidth', 'dFdx'];
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
                return `(dpdy(${expr(node.args[0], out)}) * -uniforms.misc.z)`;
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
            case 'min':
            case 'max':
            case 'clamp':
            case 'mix':
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

    /** @param {any} node @param {Emit} out @returns {string} */
    function textureCall(node, out){
        const name = node.name;
        const pair = samplerPair(node.args[0]);
        const coord = expr(node.args[1], out);
        const coordType = node.args[1].type;
        const extra = node.args[2] ? expr(node.args[2], out) : null;
        const lod = name.endsWith('Lod');
        const proj = name.includes('Proj');
        const dim = node.args[0].type.dim;
        const shadow = node.args[0].type.shadow;
        // The coordinates WGSL samples at, the projective forms divided.
        let at = coord;
        let reference = null;
        if (proj)
        {
            const c = once(out, coord, coordType);
            const size = coordType.size;
            const q = `${c}.${XYZW[size - 1]}`;
            if (shadow)
            {
                reference = `(${c}.z / ${q})`;
                at = dim === '1D' ? `vec2f(${c}.x / ${q}, 0.5f)` : `(${c}.xy / ${q})`;
            }
            else
            {
                at = dim === '1D' ? `vec2f(${c}.x / ${q}, 0.5f)` : `(${c}.xy / ${q})`;
            }
        }
        else if (shadow)
        {
            const c = once(out, coord, coordType);
            reference = `${c}.z`;
            at = dim === '1D' ? `vec2f(${c}.x, 0.5f)` : `${c}.xy`;
        }
        else if (dim === '1D')
        {
            at = `vec2f(${coord}, 0.5f)`;
        }
        let sample;
        if (lod)
        {
            sample = `textureSampleLevel(${pair}, ${at}, ${extra})`;
        }
        else if (!vertex && extra !== null)
        {
            sample = `textureSampleBias(${pair}, ${at}, ${extra})`;
        }
        else if (vertex)
        {
            sample = `textureSampleLevel(${pair}, ${at}, 0.0f)`;
        }
        else
        {
            sample = `textureSample(${pair}, ${at})`;
        }
        if (shadow)
        {
            return `vec4f(select(0.0f, 1.0f, ${reference} <= ${sample}.x))`;
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
            default:
                return [];
        }
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
                const kind = param.type.dim === 'Cube' ? 'texture_cube<f32>' : 'texture_2d<f32>';
                params.push(`pt${id}_${name}: ${kind}`, `ps${id}_${name}: sampler`);
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
            /** @param {string} source @param {GlslType} type @param {boolean} flat */
            const pass = (source, type, flat)=>{
                if (type.kind === 'array')
                {
                    for (let k = 0; k < type.length; k++)
                    {
                        pass(`${source}[${k}]`, type.element, flat);
                    }
                    return;
                }
                if (type.kind === 'matrix')
                {
                    for (let c = 0; c < type.cols; c++)
                    {
                        pass(`${source}[${c}]`, vectorOf('float', type.rows), flat);
                    }
                    return;
                }
                fields.push({ field: `i${fields.length}`, type: typeOf(type), flat, source });
            };
            for (const varying of program.varyings)
            {
                pass(`${p}g_${varying.name}`, varying.type, false);
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
        entry = `@vertex
fn vertexMain(vertex: VertexIn) -> VertexOut {
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
                take(`${p}g_${varying.name}`, varying.type);
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
        const colour = program.writesData ? (/** @type {number} */ k)=>`${p}gl_FragData[${k}]`
            : ()=>`${p}gl_FragColor`;
        const writesDepth = linked.uses.has('gl_FragDepth');
        /** @type {string[]} */
        const outputs = [];
        for (let k = 0; k < options.targets; k++)
        {
            outputs.push(`    out.c${k} = ${colour(k)};`);
        }
        if (writesDepth)
        {
            outputs.push(`    out.depth = clamp(${p}gl_FragDepth, 0.0f, 1.0f);`);
        }
        const alpha = options.alphaFunc === null ? []
            : [`    if (!(${options.compare(options.alphaFunc, `${colour(0)}.a`,
                'uniforms.misc.x')})) {`, '        discard;', '    }'];
        declarations.push(`struct FragmentOut {\n${Array.from({ length: options.targets },
            (_, k)=>`    @location(${k}) c${k}: vec4f,`).join('\n')}${writesDepth
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
        const kind = sampler.dim === 'Cube' ? 'texture_cube<f32>' : 'texture_2d<f32>';
        return `@group(0) @binding(${samplerBinding(index)}) var glt${index}: ${kind};
@group(0) @binding(${samplerBinding(index) + 1}) var gls${index}: sampler;`;
    });

    return {
        code: [...declarations, blockCode, ...privates, ...loaders, ...functions, entry]
            .filter(Boolean).join('\n\n'),
        samplers: samplerDeclarations,
        usedSamplers: [...usedSamplers],
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

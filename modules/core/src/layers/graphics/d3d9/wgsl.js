/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader bytecode to WGSL: one Direct3D instruction at a time.
 *
 * The translation is deliberately literal. Every Direct3D register becomes a
 * WGSL variable of four floats, every instruction a statement that reads its
 * sources through their swizzles and modifiers and writes its destination
 * through its mask, and the structured flow control maps onto WGSL's own.
 * Nothing is optimised, because a translator that reorders is a translator
 * whose mistakes are invisible: a literal one can be read next to the
 * disassembly and checked line by line.
 *
 * What the translation promises whoever binds it, and is the contract the
 * renderer has to meet:
 *
 * - **Inputs arrive by location.** A vertex shader's `dcl` registers are
 *   numbered in the order declared, and `inputs` says which usage each
 *   location carries, so the caller lays the vertex buffer out to match. A
 *   pixel shader's inputs are the vertex shader's outputs, at the locations
 *   `varyingLocation` gives a usage -- one table for both stages, so they
 *   agree without seeing each other.
 * - **Constants are three uniform arrays** at group 0, bindings 0 to 2: the
 *   floats, the integers, the booleans. Their sizes are the stage's register
 *   files, and the caller uploads the device's files as they stand at the
 *   draw.
 * - **Samplers are texture and sampler pairs** at group 1, two bindings per
 *   sampler register, in the order `samplers` lists them.
 *
 * Three things are not translated and say so: the texture-addressing
 * instructions of the 1.x pixel shaders, which are a different machine with
 * six-way modes of their own; predicated execution; and subroutines, whose
 * body would need the entry point's registers. A shader using any of them is
 * reported as untranslatable rather than translated wrong.
 */

import { OPCODE, REGISTER, SHADER_KIND } from './shader.js';
import { D3DDECLUSAGE } from './declaration.js';

/** D3DSPSM, the source modifiers. */
const MODIFIER = Object.freeze({
    NONE: 0, NEG: 1, BIAS: 2, BIASNEG: 3, SIGN: 4, SIGNNEG: 5, COMP: 6, X2: 7, X2NEG: 8,
    DZ: 9, DW: 10, ABS: 11, ABSNEG: 12, NOT: 13,
});

/** D3DSPDM_SATURATE, in the destination's result modifier. */
const SATURATE = 0x1;

/**
 * D3DSHADER_COMPARISON, in the control bits of ifc, breakc and setp.
 *
 * @type {Readonly<Record<number, string>>}
 */
const COMPARISON = Object.freeze({ 1: '>', 2: '==', 3: '>=', 4: '<', 5: '!=', 6: '<=' });

/**
 * The sampler types a `dcl` names, and the WGSL texture each is.
 *
 * @type {Readonly<Record<number, string>>}
 */
const SAMPLER_TYPE = Object.freeze({
    2: 'texture_2d<f32>',
    3: 'texture_cube<f32>',
    4: 'texture_3d<f32>',
});

/** The components, by swizzle code. */
const COMPONENT = 'xyzw';

/**
 * Where a varying of a given usage travels between the two stages. One table
 * for both, so a vertex shader and a pixel shader that never see each other
 * agree: colours first, then the coordinate sets, then everything else.
 *
 * @param {number} usage  D3DDECLUSAGE
 * @param {number} index
 */
export function varyingLocation(usage, index){
    switch (usage)
    {
        case D3DDECLUSAGE.COLOR:
            return index;
        case D3DDECLUSAGE.TEXCOORD:
            return 2 + index;
        case D3DDECLUSAGE.FOG:
            return 10;
        case D3DDECLUSAGE.PSIZE:
            return 11;
        default:
            return 12 + usage * 2 + Math.min(index, 1);
    }
}

/**
 * @typedef {Object} ShaderInput
 * @property {number} location
 * @property {number} usage       D3DDECLUSAGE
 * @property {number} usageIndex
 * @property {number} register    The v# it arrives in.
 */

/**
 * @typedef {Object} TranslatedShader
 * @property {string} wgsl
 * @property {string} entry       The entry point's name.
 * @property {ShaderInput[]} inputs
 * @property {{ index: number, type: string }[]} samplers
 * @property {string | null} error
 */

/**
 * @param {import('./shader.js').Operand} operand
 * @returns {string} the four-component swizzle, e.g. ".xyzw"
 */
function swizzleOf(operand){
    let text = '';
    for (let component = 0; component < 4; component++)
    {
        text += COMPONENT[(operand.swizzle >>> (component * 2)) & 3];
    }
    return text === 'xyzw' ? '' : `.${text}`;
}

/**
 * The statement that writes a value into a destination through its mask,
 * saturating first when asked. A mask of all four is a plain assignment;
 * anything less rebuilds the vector from the old and new components, since
 * WGSL has no assignment through a swizzle.
 *
 * @param {string} target   The WGSL variable.
 * @param {import('./shader.js').Operand} dest
 * @param {string} value    A vec4f expression.
 */
function writeMasked(target, dest, value){
    const saturated = (dest.resultModifier & SATURATE) !== 0
        ? `clamp(${value}, vec4f(0.0), vec4f(1.0))`
        : value;
    if (dest.writeMask === 0xf)
    {
        return `${target} = ${saturated};`;
    }
    const parts = [];
    for (let component = 0; component < 4; component++)
    {
        const letter = COMPONENT[component];
        parts.push((dest.writeMask & (1 << component)) !== 0
            ? `_t.${letter}`
            : `${target}.${letter}`);
    }
    return `{ let _t = ${saturated}; ${target} = vec4f(${parts.join(', ')}); }`;
}

/**
 * Translates one shader.
 *
 * @param {import('./shader.js').ParsedShader} parsed
 * @returns {TranslatedShader}
 */
export function translateShader(parsed){
    const kind = parsed.version.kind;
    const vertex = kind === SHADER_KIND.VERTEX;
    const major = parsed.version.major;
    /** @type {ShaderInput[]} */
    const inputs = [];
    /** @type {{ index: number, type: string }[]} */
    const samplers = [];
    /**
     * The semantic each numbered register was declared with: a vertex
     * shader's o# outputs, a pixel shader's v# inputs, in model 3.
     *
     * @type {Map<number, { usage: number, usageIndex: number }>}
     */
    const semantics = new Map();
    /** @type {Map<number, string>} def'd constants, as WGSL literals */
    const defined = new Map();
    /** @type {Map<number, string>} */
    const definedInts = new Map();
    /** @type {Map<number, string>} */
    const definedBools = new Map();
    /** @type {Set<string>} every variable the body names, for declaration */
    const used = new Set();
    /** @type {string[]} */
    const body = [];
    /** @type {string | null} */
    let error = null;
    let indent = 1;
    /**
     * The open blocks, innermost last, so that the one closing instruction
     * shared by three openers knows what it closes.
     *
     * @type {{ kind: 'if' | 'rep' | 'loop', step?: string }[]}
     */
    const blocks = [];

    /** @param {string} line */
    const emit = line=>{
        body.push(`${'    '.repeat(indent)}${line}`);
    };

    /** @param {string} why */
    const fail = why=>{
        if (!error)
        {
            error = why;
        }
    };

    /** @type {Set<number>} the v# a pixel shader reads */
    const pixelInputs = new Set();
    /** @type {Set<number>} the t# coordinate sets a pixel shader reads */
    const pixelCoordinates = new Set();
    /** @type {Set<number>} the oC# a pixel shader writes, and -1 for depth */
    const pixelOutputs = new Set();
    /** @type {Set<number>} */
    const vertexOutputs = new Set();

    /**
     * The WGSL name of a register, declaring what needs declaring as a side
     * effect: the caller sees `r3` and this notes that `r3` exists.
     *
     * @param {import('./shader.js').Operand} operand
     * @param {boolean} writing
     * @returns {string}
     */
    const registerName = (operand, writing)=>{
        const index = operand.index;
        const relative = operand.relative
            ? ` + i32(${registerName(operand.relative, false)}${swizzleOf(operand.relative)}.x)`
            : '';
        switch (operand.type)
        {
            case REGISTER.TEMP:
                used.add(`r${index}`);
                return `r${index}`;
            case REGISTER.INPUT:
                if (vertex)
                {
                    return `in.v${index}`;
                }
                pixelInputs.add(index);
                return `in.v${index}`;
            case REGISTER.CONST:
                if (defined.has(index) && !relative)
                {
                    return `k${index}`;
                }
                return `c[${index}${relative}]`;
            case REGISTER.CONSTINT:
                if (definedInts.has(index) && !relative)
                {
                    return `ki${index}`;
                }
                return `ci[${index}${relative}]`;
            case REGISTER.CONSTBOOL:
                if (definedBools.has(index))
                {
                    return `kb${index}`;
                }
                return `(cb[${index >>> 2}][${index & 3}] != 0u)`;
            case REGISTER.ADDR:
                // The address register in a vertex shader; a texture
                // coordinate in a pixel shader -- and in a 1.x pixel shader
                // the register that `tex` fills, read as the texel from then on.
                if (vertex)
                {
                    used.add('a0');
                    return 'a0';
                }
                if (major < 2 && !writing)
                {
                    used.add(`t${index}`);
                    return `t${index}`;
                }
                pixelCoordinates.add(index);
                return `in.t${index}`;
            case REGISTER.RASTOUT:
                vertexOutputs.add(index);
                return ['out.oPos', 'out.oFog', 'out.oPts'][index] ?? 'out.oPos';
            case REGISTER.ATTROUT:
                vertexOutputs.add(100 + index);
                return `out.oD${index}`;
            case REGISTER.OUTPUT:
                if (vertex && major >= 3)
                {
                    // The output declared as the position is the position.
                    return semantics.get(index)?.usage === D3DDECLUSAGE.POSITION
                        ? 'out.oPos'
                        : `out.o${index}`;
                }
                vertexOutputs.add(200 + index);
                return `out.oT${index}`;
            case REGISTER.COLOROUT:
                pixelOutputs.add(index);
                return `oC${index}`;
            case REGISTER.DEPTHOUT:
                pixelOutputs.add(-1);
                return 'oDepth';
            case REGISTER.LOOP:
                used.add('aL');
                return 'aL';
            case REGISTER.MISCTYPE:
                return index === 0
                    ? 'vec4f(in.vPos.xy, 0.0, 1.0)'
                    : 'vec4f(select(-1.0, 1.0, in.vFace))';
            case REGISTER.PREDICATE:
                fail('predicated execution is not translated');
                return 'r0';
            case REGISTER.LABEL:
                fail('subroutines are not translated');
                return 'r0';
            case REGISTER.SAMPLER:
                return `s${index}`;
            default:
                fail(`register type ${operand.type} is not translated`);
                return writing ? 'r0' : 'vec4f(0.0)';
        }
    };

    /**
     * A source, read through its swizzle and modifier, as a vec4f expression.
     *
     * @param {import('./shader.js').Operand} operand
     */
    const source = operand=>{
        const raw = `${registerName(operand, false)}${swizzleOf(operand)}`;
        switch (operand.modifier)
        {
            case MODIFIER.NONE:
                return raw;
            case MODIFIER.NEG:
                return `(-${raw})`;
            case MODIFIER.BIAS:
                return `(${raw} - vec4f(0.5))`;
            case MODIFIER.BIASNEG:
                return `(vec4f(0.5) - ${raw})`;
            case MODIFIER.SIGN:
                return `(${raw} * 2.0 - vec4f(1.0))`;
            case MODIFIER.SIGNNEG:
                return `(vec4f(1.0) - ${raw} * 2.0)`;
            case MODIFIER.COMP:
                return `(vec4f(1.0) - ${raw})`;
            case MODIFIER.X2:
                return `(${raw} * 2.0)`;
            case MODIFIER.X2NEG:
                return `(${raw} * -2.0)`;
            case MODIFIER.DZ:
                return `(${raw} / ${raw}.z)`;
            case MODIFIER.DW:
                return `(${raw} / ${raw}.w)`;
            case MODIFIER.ABS:
                return `abs(${raw})`;
            case MODIFIER.ABSNEG:
                return `(-abs(${raw}))`;
            case MODIFIER.NOT:
                return `(!${raw})`;
            default:
                fail(`source modifier ${operand.modifier} is not translated`);
                return raw;
        }
    };

    /**
     * A boolean source, for the flow control that reads one.
     *
     * @param {import('./shader.js').Operand} operand
     */
    const condition = operand=>{
        const raw = registerName(operand, false);
        return operand.modifier === MODIFIER.NOT ? `(!${raw})` : raw;
    };

    /**
     * An integer source's component, for the loops.
     *
     * @param {import('./shader.js').Operand} operand @param {string} component
     */
    const integer = (operand, component)=>`${registerName(operand, false)}.${component}`;

    /**
     * @param {import('./shader.js').Instruction} instruction
     * @param {string} value  A vec4f expression.
     */
    const write = (instruction, value)=>{
        const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
        emit(writeMasked(registerName(dest, true), dest, value));
    };

    /** @param {import('./shader.js').Instruction} instruction @param {number} at */
    const src = (instruction, at)=>source(instruction.sources[at]);

    /**
     * The row dot products the matrix instructions unroll into: `rows` of
     * them, each against the constant register `columns` after the first.
     *
     * @param {import('./shader.js').Instruction} instruction
     * @param {number} rows @param {number} columns
     */
    const matrix = (instruction, rows, columns)=>{
        const vector = src(instruction, 0);
        const first = instruction.sources[1];
        const parts = [];
        for (let row = 0; row < rows; row++)
        {
            const register = { ...first, index: first.index + row };
            const operand = `${registerName(register, false)}${swizzleOf(register)}`;
            parts.push(columns === 4
                ? `dot(${vector}, ${operand})`
                : `dot(${vector}.xyz, ${operand}.xyz)`);
        }
        while (parts.length < 4)
        {
            parts.push('0.0');
        }
        return `vec4f(${parts.join(', ')})`;
    };

    /**
     * A texture read: the coordinate through the sampler's texture, of
     * whichever dimension the sampler was declared with.
     *
     * @param {import('./shader.js').Instruction} instruction
     * @param {string} how   'sample', 'level' or 'grad'.
     */
    const sample = (instruction, how)=>{
        const samplerOperand = instruction.sources[1];
        const entry = samplers.find(one=>one.index === samplerOperand.index);
        if (!entry)
        {
            fail(`sampler s${samplerOperand.index} is read without a declaration`);
            return 'vec4f(0.0)';
        }
        const coordinates = entry.type === 'texture_2d<f32>' ? 'xy' : 'xyz';
        const project = (instruction.control & 0x1) !== 0;
        const bias = (instruction.control & 0x2) !== 0;
        const at = project
            ? `(${src(instruction, 0)}.${coordinates} / ${src(instruction, 0)}.w)`
            : `${src(instruction, 0)}.${coordinates}`;
        const pair = `tex${entry.index}, samp${entry.index}`;
        if (how === 'level')
        {
            return `textureSampleLevel(${pair}, ${at}, ${src(instruction, 0)}.w)`;
        }
        if (how === 'grad')
        {
            const derivatives = entry.type === 'texture_2d<f32>' ? 'xy' : 'xyz';
            return `textureSampleGrad(${pair}, ${at}, ${src(instruction, 2)}.${derivatives},`
                + ` ${src(instruction, 3)}.${derivatives})`;
        }
        if (bias)
        {
            return `textureSampleBias(${pair}, ${at}, ${src(instruction, 0)}.w)`;
        }
        return `textureSample(${pair}, ${at})`;
    };

    /** @param {import('./shader.js').Instruction} instruction */
    const comparison = instruction=>COMPARISON[instruction.control & 0x7] ?? '==';

    for (const instruction of parsed.instructions)
    {
        if (instruction.predicated)
        {
            fail('predicated execution is not translated');
        }
        switch (instruction.opcode)
        {
            case OPCODE.NOP:
                break;
            case OPCODE.DCL: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                const declaration = /** @type {any} */ (instruction.declaration);
                if (dest.type === REGISTER.SAMPLER)
                {
                    const type = SAMPLER_TYPE[declaration.samplerType];
                    if (!type)
                    {
                        fail(`sampler type ${declaration.samplerType} is not translated`);
                    }
                    samplers.push({ index: dest.index, type: type ?? 'texture_2d<f32>' });
                }
                else if (dest.type === REGISTER.INPUT && vertex)
                {
                    inputs.push({
                        location: inputs.length,
                        usage: declaration.usage,
                        usageIndex: declaration.usageIndex,
                        register: dest.index,
                    });
                }
                else if (dest.type === REGISTER.INPUT)
                {
                    pixelInputs.add(dest.index);
                    semantics.set(dest.index, declaration);
                }
                else if (dest.type === REGISTER.OUTPUT && vertex)
                {
                    semantics.set(dest.index, declaration);
                }
                else if (dest.type === REGISTER.ADDR && !vertex)
                {
                    pixelCoordinates.add(dest.index);
                }
                break;
            }
            case OPCODE.DEF: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                const floats = new Float32Array(
                    Uint32Array.from(instruction.literals ?? []).buffer);
                defined.set(dest.index, `vec4f(${[...floats].map(literal).join(', ')})`);
                break;
            }
            case OPCODE.DEFI: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                const ints = new Int32Array(Uint32Array.from(instruction.literals ?? []).buffer);
                definedInts.set(dest.index, `vec4i(${[...ints].join(', ')})`);
                break;
            }
            case OPCODE.DEFB: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                definedBools.set(dest.index, (instruction.literals ?? [0])[0] ? 'true' : 'false');
                break;
            }
            case OPCODE.MOV:
                write(instruction, src(instruction, 0));
                break;
            case OPCODE.MOVA:
                write(instruction, `round(${src(instruction, 0)})`);
                break;
            case OPCODE.ADD:
                write(instruction, `(${src(instruction, 0)} + ${src(instruction, 1)})`);
                break;
            case OPCODE.SUB:
                write(instruction, `(${src(instruction, 0)} - ${src(instruction, 1)})`);
                break;
            case OPCODE.MUL:
                write(instruction, `(${src(instruction, 0)} * ${src(instruction, 1)})`);
                break;
            case OPCODE.MAD:
                write(instruction,
                    `(${src(instruction, 0)} * ${src(instruction, 1)} + ${src(instruction, 2)})`);
                break;
            case OPCODE.MIN:
                write(instruction, `min(${src(instruction, 0)}, ${src(instruction, 1)})`);
                break;
            case OPCODE.MAX:
                write(instruction, `max(${src(instruction, 0)}, ${src(instruction, 1)})`);
                break;
            case OPCODE.RCP:
                write(instruction, `vec4f(1.0 / ${src(instruction, 0)}.x)`);
                break;
            case OPCODE.RSQ:
                write(instruction, `vec4f(inverseSqrt(abs(${src(instruction, 0)}.x)))`);
                break;
            case OPCODE.EXP:
            case OPCODE.EXPP:
                write(instruction, `vec4f(exp2(${src(instruction, 0)}.x))`);
                break;
            case OPCODE.LOG:
            case OPCODE.LOGP:
                write(instruction, `vec4f(log2(abs(${src(instruction, 0)}.x)))`);
                break;
            case OPCODE.FRC:
                write(instruction, `fract(${src(instruction, 0)})`);
                break;
            case OPCODE.DP3:
                write(instruction,
                    `vec4f(dot(${src(instruction, 0)}.xyz, ${src(instruction, 1)}.xyz))`);
                break;
            case OPCODE.DP4:
                write(instruction, `vec4f(dot(${src(instruction, 0)}, ${src(instruction, 1)}))`);
                break;
            case OPCODE.DP2ADD:
                write(instruction, `vec4f(dot(${src(instruction, 0)}.xy, ${src(instruction, 1)}.xy)`
                    + ` + ${src(instruction, 2)}.x)`);
                break;
            case OPCODE.SLT:
                write(instruction,
                    `select(vec4f(0.0), vec4f(1.0), ${src(instruction, 0)}`
                    + ` < ${src(instruction, 1)})`);
                break;
            case OPCODE.SGE:
                write(instruction,
                    `select(vec4f(0.0), vec4f(1.0), ${src(instruction, 0)}`
                    + ` >= ${src(instruction, 1)})`);
                break;
            case OPCODE.LIT: {
                const s = src(instruction, 0);
                write(instruction, `vec4f(1.0, max(${s}.x, 0.0), select(0.0, pow(max(${s}.y, 0.0),`
                    + ` clamp(${s}.w, -128.0, 128.0)), ${s}.x > 0.0), 1.0)`);
                break;
            }
            case OPCODE.DST: {
                const a = src(instruction, 0);
                const b = src(instruction, 1);
                write(instruction, `vec4f(1.0, ${a}.y * ${b}.y, ${a}.z, ${b}.w)`);
                break;
            }
            case OPCODE.LRP:
                write(instruction,
                    `mix(${src(instruction, 2)}, ${src(instruction, 1)}, ${src(instruction, 0)})`);
                break;
            case OPCODE.M4x4:
                write(instruction, matrix(instruction, 4, 4));
                break;
            case OPCODE.M4x3:
                write(instruction, matrix(instruction, 3, 4));
                break;
            case OPCODE.M3x4:
                write(instruction, matrix(instruction, 4, 3));
                break;
            case OPCODE.M3x3:
                write(instruction, matrix(instruction, 3, 3));
                break;
            case OPCODE.M3x2:
                write(instruction, matrix(instruction, 2, 3));
                break;
            case OPCODE.POW:
                write(instruction,
                    `vec4f(pow(abs(${src(instruction, 0)}.x), ${src(instruction, 1)}.x))`);
                break;
            case OPCODE.CRS:
                write(instruction,
                    `vec4f(cross(${src(instruction, 0)}.xyz, ${src(instruction, 1)}.xyz), 0.0)`);
                break;
            case OPCODE.SGN:
                write(instruction, `sign(${src(instruction, 0)})`);
                break;
            case OPCODE.ABS:
                write(instruction, `abs(${src(instruction, 0)})`);
                break;
            case OPCODE.NRM:
                write(instruction, `vec4f(normalize(${src(instruction, 0)}.xyz), 0.0)`);
                break;
            case OPCODE.SINCOS: {
                const s = src(instruction, 0);
                write(instruction, `vec4f(cos(${s}.x), sin(${s}.x), 0.0, 0.0)`);
                break;
            }
            case OPCODE.CMP:
                write(instruction, `select(${src(instruction, 2)}, ${src(instruction, 1)},`
                    + ` ${src(instruction, 0)} >= vec4f(0.0))`);
                break;
            case OPCODE.CND:
                write(instruction, `select(${src(instruction, 2)}, ${src(instruction, 1)},`
                    + ` ${src(instruction, 0)} > vec4f(0.5))`);
                break;
            case OPCODE.DSX:
                write(instruction, `dpdx(${src(instruction, 0)})`);
                break;
            case OPCODE.DSY:
                write(instruction, `dpdy(${src(instruction, 0)})`);
                break;
            case OPCODE.TEXKILL: {
                // The register named is read, not written; in a 1.x shader it
                // is the coordinate set itself.
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                const read = dest.type === REGISTER.ADDR && major < 2
                    ? registerName(dest, true)
                    : registerName(dest, false);
                emit(`if (any(${read}.xyz < vec3f(0.0))) { discard; }`);
                break;
            }
            case OPCODE.TEX:
                if (major < 2)
                {
                    // ps_1_x: `tex tN` samples texture N with coordinate set N.
                    const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                    if (!samplers.some(one=>one.index === dest.index))
                    {
                        samplers.push({ index: dest.index, type: 'texture_2d<f32>' });
                    }
                    pixelCoordinates.add(dest.index);
                    used.add(`t${dest.index}`);
                    emit(`t${dest.index} = textureSample(tex${dest.index}, samp${dest.index},`
                        + ` in.t${dest.index}.xy);`);
                    break;
                }
                write(instruction, sample(instruction, 'sample'));
                break;
            case OPCODE.TEXLDL:
                write(instruction, sample(instruction, 'level'));
                break;
            case OPCODE.TEXLDD:
                write(instruction, sample(instruction, 'grad'));
                break;
            case OPCODE.TEXCOORD: {
                const dest = /** @type {import('./shader.js').Operand} */ (instruction.dest);
                pixelCoordinates.add(dest.index);
                used.add(`t${dest.index}`);
                emit(`t${dest.index} = in.t${dest.index};`);
                break;
            }
            case OPCODE.IF:
                emit(`if (${condition(instruction.sources[0])}) {`);
                blocks.push({ kind: 'if' });
                indent++;
                break;
            case OPCODE.IFC:
                emit(`if (${src(instruction, 0)}.x ${comparison(instruction)}`
                    + ` ${src(instruction, 1)}.x) {`);
                blocks.push({ kind: 'if' });
                indent++;
                break;
            case OPCODE.ELSE:
                indent--;
                emit('} else {');
                indent++;
                break;
            case OPCODE.ENDIF:
            case OPCODE.ENDREP:
            case OPCODE.ENDLOOP: {
                const block = blocks.pop();
                if (!block)
                {
                    fail(`${instruction.name} closes nothing`);
                    break;
                }
                if (block.step)
                {
                    emit(block.step);
                }
                indent--;
                emit('}');
                break;
            }
            case OPCODE.REP:
                emit(`for (var _rep${blocks.length} = 0;`
                    + ` _rep${blocks.length} < ${integer(instruction.sources[0], 'x')};`
                    + ` _rep${blocks.length}++) {`);
                blocks.push({ kind: 'rep' });
                indent++;
                break;
            case OPCODE.LOOP: {
                // loop aL, i#: i.x passes, aL from i.y, stepping by i.z each pass.
                const counter = instruction.sources[1];
                used.add('aL');
                emit(`aL = ${integer(counter, 'y')};`);
                emit(`for (var _loop${blocks.length} = 0;`
                    + ` _loop${blocks.length} < ${integer(counter, 'x')};`
                    + ` _loop${blocks.length}++) {`);
                blocks.push({ kind: 'loop', step: `aL += ${integer(counter, 'z')};` });
                indent++;
                break;
            }
            case OPCODE.BREAK:
                emit('break;');
                break;
            case OPCODE.BREAKC:
                emit(`if (${src(instruction, 0)}.x ${comparison(instruction)}`
                    + ` ${src(instruction, 1)}.x) { break; }`);
                break;
            case OPCODE.RET:
                if (blocks.length === 0)
                {
                    emit('return out;');
                }
                else
                {
                    fail('a return inside a block is not translated');
                }
                break;
            case OPCODE.LABEL:
            case OPCODE.CALL:
            case OPCODE.CALLNZ:
                fail('subroutines are not translated');
                break;
            case OPCODE.SETP:
            case OPCODE.BREAKP:
                fail('predicated execution is not translated');
                break;
            case OPCODE.TEXBEM:
            case OPCODE.TEXBEML:
            case OPCODE.TEXREG2AR:
            case OPCODE.TEXREG2GB:
            case OPCODE.TEXM3x2PAD:
            case OPCODE.TEXM3x2TEX:
            case OPCODE.TEXM3x3PAD:
            case OPCODE.TEXM3x3TEX:
            case OPCODE.TEXM3x3SPEC:
            case OPCODE.TEXM3x3VSPEC:
            case OPCODE.TEXREG2RGB:
            case OPCODE.TEXDP3TEX:
            case OPCODE.TEXM3x2DEPTH:
            case OPCODE.TEXDP3:
            case OPCODE.TEXM3x3:
            case OPCODE.TEXDEPTH:
            case OPCODE.BEM:
                fail(`the 1.x texture instruction ${instruction.name} is not translated`);
                break;
            default:
                fail(`${instruction.name} is not translated`);
        }
    }

    if (blocks.length > 0)
    {
        fail('a block is left open at the end of the shader');
    }
    if (!vertex && major < 2)
    {
        // A 1.x pixel shader has no colour output register: what r0 holds
        // at the end is the pixel.
        used.add('r0');
        pixelOutputs.add(0);
        body.push('    oC0 = r0;');
    }
    // The immediates a shader defines shadow the register file for its own
    // reads; a constant set from outside does not reach them.
    /** @type {string[]} */
    const immediates = [];
    for (const [index, value] of defined)
    {
        immediates.push(`    let k${index} = ${value};`);
    }
    for (const [index, value] of definedInts)
    {
        immediates.push(`    let ki${index} = ${value};`);
    }
    for (const [index, value] of definedBools)
    {
        immediates.push(`    let kb${index} = ${value};`);
    }

    /** @type {string[]} */
    const header = [];
    /** @type {string[]} */
    const declarations = [];
    for (const name of [...used].sort())
    {
        if (name === 'aL')
        {
            declarations.push('    var aL: i32 = 0;');
        }
        else
        {
            declarations.push(`    var ${name}: vec4f = vec4f(0.0);`);
        }
    }
    const fileCounts = vertex ? { floats: 256 } : { floats: 224 };
    header.push(`@group(0) @binding(0) var<uniform> c: array<vec4f, ${fileCounts.floats}>;`);
    header.push('@group(0) @binding(1) var<uniform> ci: array<vec4i, 16>;');
    header.push('@group(0) @binding(2) var<uniform> cb: array<vec4u, 4>;');
    samplers.sort((left, right)=>left.index - right.index);
    samplers.forEach((entry, at)=>{
        header.push(`@group(1) @binding(${at * 2}) var tex${entry.index}: ${entry.type};`);
        header.push(`@group(1) @binding(${at * 2 + 1}) var samp${entry.index}: sampler;`);
    });

    let entry;
    if (vertex)
    {
        header.push('struct VsIn {');
        for (const input of inputs)
        {
            header.push(`    @location(${input.location}) v${input.register}: vec4f,`);
        }
        header.push('}');
        header.push('struct VsOut {');
        header.push('    @builtin(position) oPos: vec4f,');
        if (major >= 3)
        {
            for (const [index, declaration] of semantics)
            {
                if (declaration.usage === D3DDECLUSAGE.POSITION)
                {
                    continue;
                }
                header.push(`    @location(${varyingLocation(declaration.usage,
                    declaration.usageIndex)}) o${index}: vec4f,`);
            }
        }
        else
        {
            for (const output of [...vertexOutputs].sort((a, b)=>a - b))
            {
                if (output >= 200)
                {
                    header.push(`    @location(${varyingLocation(D3DDECLUSAGE.TEXCOORD,
                        output - 200)}) oT${output - 200}: vec4f,`);
                }
                else if (output >= 100)
                {
                    header.push(`    @location(${varyingLocation(D3DDECLUSAGE.COLOR,
                        output - 100)}) oD${output - 100}: vec4f,`);
                }
                else if (output === 1)
                {
                    header.push(`    @location(${varyingLocation(D3DDECLUSAGE.FOG, 0)})`
                        + ' oFog: vec4f,');
                }
                else if (output === 2)
                {
                    header.push(`    @location(${varyingLocation(D3DDECLUSAGE.PSIZE, 0)})`
                        + ' oPts: vec4f,');
                }
            }
        }
        header.push('}');
        entry = 'vs_main';
        header.push('@vertex');
        header.push(`fn ${entry}(in: VsIn) -> VsOut {`);
        header.push('    var out: VsOut;');
    }
    else
    {
        header.push('struct PsIn {');
        header.push('    @builtin(position) vPos: vec4f,');
        header.push('    @builtin(front_facing) vFace: bool,');
        for (const set of [...pixelCoordinates].sort((a, b)=>a - b))
        {
            header.push(`    @location(${varyingLocation(D3DDECLUSAGE.TEXCOORD, set)})`
                + ` t${set}: vec4f,`);
        }
        for (const input of [...pixelInputs].sort((a, b)=>a - b))
        {
            const declaration = major >= 3 ? semantics.get(input) : undefined;
            header.push(`    @location(${declaration
                ? varyingLocation(declaration.usage, declaration.usageIndex)
                : varyingLocation(D3DDECLUSAGE.COLOR, input)}) v${input}: vec4f,`);
        }
        header.push('}');
        header.push('struct PsOut {');
        for (const output of [...pixelOutputs].sort((a, b)=>a - b))
        {
            header.push(output < 0
                ? '    @builtin(frag_depth) oDepth: f32,'
                : `    @location(${output}) oC${output}: vec4f,`);
        }
        header.push('}');
        entry = 'ps_main';
        header.push('@fragment');
        header.push(`fn ${entry}(in: PsIn) -> PsOut {`);
        header.push('    var out: PsOut;');
        for (const output of pixelOutputs)
        {
            declarations.push(output < 0
                ? '    var oDepth: vec4f = vec4f(0.0);'
                : `    var oC${output}: vec4f = vec4f(0.0);`);
        }
        for (const output of pixelOutputs)
        {
            body.push(output < 0
                ? '    out.oDepth = oDepth.x;'
                : `    out.oC${output} = oC${output};`);
        }
    }

    const wgsl = [
        ...header,
        ...declarations,
        ...immediates,
        ...body,
        '    return out;',
        '}',
    ].join('\n');

    return { wgsl, entry, inputs, samplers, error };
}

/** @param {number} value @returns {string} a WGSL float literal */
function literal(value){
    if (!Number.isFinite(value))
    {
        return '0.0';
    }
    const text = String(value);
    return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

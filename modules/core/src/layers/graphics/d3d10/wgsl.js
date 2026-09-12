/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader Model 4 to WGSL.
 *
 * The translation keeps the shader's own register model rather than inventing
 * a nicer one: every register is a `vec4<u32>` of bit patterns, and each
 * instruction reinterprets what it reads as the type the instruction is
 * defined over. That is not a stylistic choice. A Shader Model 4 register is
 * untyped by definition -- a program moves an integer comparison result into a
 * register and multiplies it as a float three instructions later -- and a
 * translator that assigns registers a type has to guess, and guesses wrong on
 * exactly the shaders that do interesting things. Bit patterns are kept in an
 * unsigned register because a float register can lose them: a comparison
 * result is all ones, all ones is a NaN when read as a float, and a NaN
 * stored in a float is not required to keep its payload.
 *
 * The other decision worth stating is how a vertex shader meets a pixel
 * shader. Direct3D links the two by semantic name, never by register: `COLOR0`
 * in one is `COLOR0` in the other whatever register each compiler chose. So a
 * shader is translated to a body that reads and writes named registers, and the
 * entry point around it -- the struct with the `@location` attributes -- is
 * written when a pair is linked, giving both halves the same numbering. The
 * body is the shader's; the interface is the pair's.
 *
 * What a first cut does not carry is listed rather than approximated: an
 * instruction this file has no translation for makes the whole shader
 * untranslatable, and the draw that would have used it is refused by name. A
 * plausible substitute would render a picture that is wrong in a way nothing
 * reports, which is the most expensive kind of wrong there is.
 */

import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE } from './dxbc.js';
import {
    CUSTOMDATA, MODIFIER, OPCODE, OPERAND, RESOURCE_DIMENSION, RETURN_TYPE, SAMPLER_MODE,
    decodeSm4,
} from './sm4.js';

/** Where each kind of resource is bound within a stage's group. */
export const BINDING = Object.freeze({
    CONSTANT_BUFFER: 0,
    TEXTURE: 16,
    SAMPLER: 144,
});

/** WebGPU's `GPUShaderStage` bits, spelled out so nothing here reads a global. */
export const STAGE = Object.freeze({ VERTEX: 1, FRAGMENT: 2 });

/** Every register file is thirty-two bit patterns, four to a register. */
const REG = 'vec4<u32>';

const COMPONENT = ['x', 'y', 'z', 'w'];

/**
 * @typedef {Object} ConstantBufferDecl
 * @property {number} slot
 * @property {number} size   In vec4 registers.
 */

/**
 * @typedef {Object} TextureDecl
 * @property {number} slot
 * @property {number} dimension    A RESOURCE_DIMENSION.
 * @property {number} returnType   A RETURN_TYPE.
 * @property {boolean} comparison  Read by a compare-sample, so declared as depth.
 */

/**
 * @typedef {Object} SamplerDecl
 * @property {number} slot
 * @property {boolean} comparison
 */

/**
 * @typedef {Object} TranslatedShader
 * @property {number} kind                       A SHADER_KIND.
 * @property {import('./dxbc.js').SignatureElement[]} inputs
 * @property {import('./dxbc.js').SignatureElement[]} outputs
 * @property {ConstantBufferDecl[]} constantBuffers
 * @property {TextureDecl[]} textures
 * @property {SamplerDecl[]} samplers
 * @property {number} temps
 * @property {{ index: number, size: number }[]} indexableTemps
 * @property {number[][]} immediateConstants       The icb, one vec4 per row.
 * @property {(string | { ret: true })[]} body     Statements; `ret` is filled at link.
 * @property {number} inputRegisters               How many `v` registers the body reads.
 * @property {number} outputRegisters              How many `o` registers the body writes.
 * @property {boolean} writesDepth
 * @property {string[]} unsupported                Opcode names with no translation.
 */

/** @param {number} mask @returns {string} the components a mask names */
function maskComponents(mask){
    return COMPONENT.filter((_, index)=>(mask & (1 << index)) !== 0).join('');
}

/** @param {readonly number[]} swizzle */
function swizzleText(swizzle){
    return swizzle.map(index=>COMPONENT[index]).join('');
}

/** @param {number} dword @returns {string} a WGSL u32 literal */
const u32Literal = dword=>`${dword >>> 0}u`;

/**
 * Translates one shader's instruction stream. The entry point is not written
 * here -- see `linkProgram` -- because its `@location` numbering belongs to the
 * pair, not to the shader.
 *
 * @param {import('./dxbc.js').DxbcContainer} container
 * @returns {TranslatedShader}
 */
export function translateShader(container){
    const program = /** @type {import('./dxbc.js').ShaderProgram} */ (container.shader);
    const instructions = decodeSm4(program.tokens);
    const isPixel = program.kind === SHADER_KIND.PIXEL;

    /** @type {TranslatedShader} */
    const result = {
        kind: program.kind,
        inputs: container.inputs,
        outputs: container.outputs,
        constantBuffers: [],
        textures: [],
        samplers: [],
        temps: 0,
        indexableTemps: [],
        immediateConstants: [],
        body: [],
        inputRegisters: 0,
        outputRegisters: 0,
        writesDepth: false,
        unsupported: [],
    };
    let nextTemp = 0;
    let depth = 1;

    /** @param {string} line */
    const emit = line=>{
        result.body.push(`${'    '.repeat(depth)}${line}`);
    };

    /** @param {number} slot */
    const textureOf = slot=>result.textures.find(texture=>texture.slot === slot) ?? null;

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {number} at  Which of the operand's indices.
     * @returns {string} an index expression, resolving a relative part
     */
    const indexExpression = (operand, at)=>{
        const index = operand.indices[at];
        if (!index)
        {
            return '0u';
        }
        if (!index.relative)
        {
            return u32Literal(index.value);
        }
        const relative = `${untyped(index.relative)}.${COMPONENT[index.relative.swizzle[0]]}`;
        return index.value === 0 ? relative : `(${u32Literal(index.value)} + ${relative})`;
    };

    /**
     * The bit patterns an operand names, swizzled, before any type is put on
     * them.
     *
     * @param {import('./sm4.js').Operand} operand
     * @returns {string}
     */
    const untyped = operand=>{
        const swizzle = swizzleText(operand.swizzle);
        switch (operand.type)
        {
            case OPERAND.TEMP:
                return `r${operand.indices[0].value}.${swizzle}`;
            case OPERAND.INPUT:
                return `v${operand.indices[0].value}.${swizzle}`;
            case OPERAND.OUTPUT:
                return `o${operand.indices[0].value}.${swizzle}`;
            case OPERAND.INDEXABLE_TEMP:
                return `x${operand.indices[0].value}[${indexExpression(operand, 1)}].${swizzle}`;
            case OPERAND.CONSTANT_BUFFER:
                return `cb${operand.indices[0].value}[${indexExpression(operand, 1)}].${swizzle}`;
            case OPERAND.IMMEDIATE_CONSTANT_BUFFER:
                return `icb[${indexExpression(operand, 0)}].${swizzle}`;
            case OPERAND.IMMEDIATE32:
                if (operand.immediate.length === 1)
                {
                    return `${REG}(${u32Literal(operand.immediate[0])})`;
                }
                return `${REG}(${operand.immediate.map(u32Literal).join(', ')})`;
            default:
                result.unsupported.push(`operand type ${operand.type}`);
                return `${REG}(0u)`;
        }
    };

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {'f' | 'i' | 'u'} type
     * @returns {string} the operand read as that type, with its modifier applied
     */
    const typed = (operand, type)=>{
        const bits = untyped(operand);
        let value = type === 'u' ? bits : `bitcast<vec4<${type}32>>(${bits})`;
        if (operand.modifier === MODIFIER.ABS || operand.modifier === MODIFIER.ABSNEG)
        {
            value = `abs(${value})`;
        }
        if (operand.modifier === MODIFIER.NEG || operand.modifier === MODIFIER.ABSNEG)
        {
            value = `(-${value})`;
        }
        return value;
    };

    /** @param {import('./sm4.js').Operand} operand */
    const f = operand=>typed(operand, 'f');
    /** @param {import('./sm4.js').Operand} operand */
    const i = operand=>typed(operand, 'i');
    /** @param {import('./sm4.js').Operand} operand */
    const u = operand=>typed(operand, 'u');

    /**
     * Stores four bit patterns into a destination through its write mask. The
     * value is evaluated once into a `let`, because a swap like
     * `mov r0.xy, r0.yx` reads what it is about to overwrite.
     *
     * @param {import('./sm4.js').Operand} dest
     * @param {string} value  A `vec4<u32>` expression.
     */
    const store = (dest, value)=>{
        if (dest.type === OPERAND.NULL)
        {
            return;
        }
        if (dest.type === OPERAND.OUTPUT_DEPTH)
        {
            result.writesDepth = true;
            emit(`oDepth = bitcast<f32>((${value}).x);`);
            return;
        }
        const target = untyped({ ...dest, swizzle: [0, 1, 2, 3] }).replace(/\.xyzw$/, '');
        if (dest.type === OPERAND.OUTPUT)
        {
            result.outputRegisters = Math.max(result.outputRegisters, dest.indices[0].value + 1);
        }
        if (dest.mask === 0xf)
        {
            emit(`${target} = ${value};`);
            return;
        }
        const temp = `t${nextTemp++}`;
        emit(`let ${temp} = ${value};`);
        for (const component of maskComponents(dest.mask))
        {
            emit(`${target}.${component} = ${temp}.${component};`);
        }
    };

    /** @param {string} value a `vec4<f32>` expression @param {boolean} saturate */
    const fromFloat = (value, saturate)=>`bitcast<${REG}>(${saturate
        ? `clamp(${value}, vec4<f32>(0.0), vec4<f32>(1.0))`
        : value})`;
    /** @param {string} value a `vec4<i32>` expression */
    const fromInt = value=>`bitcast<${REG}>(${value})`;
    /** @param {string} condition a `vec4<bool>` expression */
    const fromBool = condition=>`select(${REG}(0u), ${REG}(0xffffffffu), ${condition})`;
    /** @param {string} scalar an `f32` expression */
    const splat = scalar=>`vec4<f32>(${scalar})`;

    /**
     * @param {import('./sm4.js').Operand} operand
     * @param {number} count
     * @returns {string} the first `count` components of a float read
     */
    const floats = (operand, count)=>`${f(operand)}.${'xyzw'.slice(0, count)}`;

    /**
     * The coordinate a texture instruction samples at, sized to the texture,
     * and the array index when it has one.
     *
     * @param {TextureDecl} texture
     * @param {string} coordinate a vec4<f32> or vec4<i32> expression
     * @returns {{ coordinate: string, layer: string | null } | null}
     */
    const coordinateFor = (texture, coordinate)=>{
        switch (texture.dimension)
        {
            case RESOURCE_DIMENSION.TEXTURE1D:
                return { coordinate: `${coordinate}.x`, layer: null };
            case RESOURCE_DIMENSION.TEXTURE2D:
            case RESOURCE_DIMENSION.TEXTURE2DMS:
                return { coordinate: `${coordinate}.xy`, layer: null };
            case RESOURCE_DIMENSION.TEXTURE3D:
            case RESOURCE_DIMENSION.TEXTURECUBE:
                return { coordinate: `${coordinate}.xyz`, layer: null };
            case RESOURCE_DIMENSION.TEXTURE1DARRAY:
                return { coordinate: `${coordinate}.x`, layer: `${coordinate}.y` };
            case RESOURCE_DIMENSION.TEXTURE2DARRAY:
                return { coordinate: `${coordinate}.xy`, layer: `${coordinate}.z` };
            case RESOURCE_DIMENSION.TEXTURECUBEARRAY:
                return { coordinate: `${coordinate}.xyz`, layer: `${coordinate}.w` };
            default:
                return null;
        }
    };

    /**
     * A sampled result, as the register file holds it: the texture's swizzle
     * applied, then the bits kept as they are for an integer texture and
     * reinterpreted for a float one.
     *
     * @param {TextureDecl} texture
     * @param {import('./sm4.js').Operand} operand  The `t#` operand, for its swizzle.
     * @param {string} sampled
     */
    const sampledBits = (texture, operand, sampled)=>{
        const swizzled = `(${sampled}).${swizzleText(operand.swizzle)}`;
        if (texture.returnType === RETURN_TYPE.UINT)
        {
            return swizzled;
        }
        return `bitcast<${REG}>(${swizzled})`;
    };

    /**
     * @param {import('./sm4.js').Instruction} instruction
     * @param {(texture: TextureDecl, coordinate: { coordinate: string, layer: string | null },
     *          sampler: string) => string} call
     */
    const sampleWith = (instruction, call)=>{
        const [dest, coordinate, resource, sampler] = instruction.operands;
        const texture = textureOf(resource.indices[0].value);
        const shaped = texture ? coordinateFor(texture, f(coordinate)) : null;
        if (!texture || !shaped)
        {
            result.unsupported.push(`${instruction.name} on an undeclared or unsupported texture`);
            return;
        }
        if (shaped.layer !== null)
        {
            shaped.layer = `i32(${shaped.layer})`;
        }
        const samplerName = sampler ? `s${sampler.indices[0].value}` : '';
        store(dest, sampledBits(texture, resource, call(texture, shaped, samplerName)));
    };

    /** @param {string} name */
    const unsupported = name=>{
        result.unsupported.push(name);
    };

    /**
     * Two-destination integer multiplies and divides: the destination that is
     * `null` is simply not stored.
     *
     * @param {import('./sm4.js').Instruction} instruction
     * @param {string} high
     * @param {string} low
     */
    const storePair = (instruction, high, low)=>{
        store(instruction.operands[0], high);
        store(instruction.operands[1], low);
    };

    for (const instruction of instructions)
    {
        const [dest, a, b, c] = instruction.operands;
        const sat = instruction.saturate;
        switch (instruction.opcode)
        {
            // --- declarations ---
            case OPCODE.DCL_GLOBAL_FLAGS:
            case OPCODE.DCL_INPUT_SGV:
            case OPCODE.DCL_INPUT_PS_SGV:
            case OPCODE.DCL_OUTPUT_SGV:
            case OPCODE.NOP:
                break;
            case OPCODE.DCL_TEMPS:
                result.temps = instruction.extra[0] ?? 0;
                break;
            case OPCODE.DCL_INDEXABLE_TEMP:
                result.indexableTemps.push({
                    index: instruction.extra[0], size: instruction.extra[1],
                });
                break;
            case OPCODE.DCL_CONSTANT_BUFFER:
                result.constantBuffers.push({
                    slot: dest.indices[0].value,
                    size: dest.indices[1] ? dest.indices[1].value : 0,
                });
                break;
            case OPCODE.DCL_SAMPLER:
                result.samplers.push({
                    slot: dest.indices[0].value,
                    comparison: (instruction.control & 0xf) === SAMPLER_MODE.COMPARISON,
                });
                break;
            case OPCODE.DCL_RESOURCE:
                result.textures.push({
                    slot: dest.indices[0].value,
                    dimension: instruction.control & 0x1f,
                    returnType: (instruction.extra[0] ?? 0) & 0xf,
                    comparison: false,
                });
                break;
            case OPCODE.DCL_INPUT:
            case OPCODE.DCL_INPUT_SIV:
            case OPCODE.DCL_INPUT_PS:
            case OPCODE.DCL_INPUT_PS_SIV:
                if (dest.type === OPERAND.INPUT)
                {
                    result.inputRegisters = Math.max(result.inputRegisters,
                        dest.indices[0].value + 1);
                }
                break;
            case OPCODE.DCL_OUTPUT:
            case OPCODE.DCL_OUTPUT_SIV:
                if (dest.type === OPERAND.OUTPUT)
                {
                    result.outputRegisters = Math.max(result.outputRegisters,
                        dest.indices[0].value + 1);
                }
                break;
            case OPCODE.CUSTOMDATA:
                if (instruction.control === CUSTOMDATA.IMMEDIATE_CONSTANT_BUFFER)
                {
                    const data = instruction.customData ?? [];
                    for (let row = 0; row + 4 <= data.length; row += 4)
                    {
                        result.immediateConstants.push(data.slice(row, row + 4));
                    }
                }
                break;

            // --- moves ---
            case OPCODE.MOV:
                store(dest, sat ? fromFloat(f(a), true) : u(a));
                break;
            case OPCODE.MOVC:
                store(dest, `select(${u(c)}, ${u(b)}, ${u(a)} != ${REG}(0u))`);
                break;

            // --- float arithmetic ---
            case OPCODE.ADD:
                store(dest, fromFloat(`(${f(a)} + ${f(b)})`, sat));
                break;
            case OPCODE.MUL:
                store(dest, fromFloat(`(${f(a)} * ${f(b)})`, sat));
                break;
            case OPCODE.DIV:
                store(dest, fromFloat(`(${f(a)} / ${f(b)})`, sat));
                break;
            case OPCODE.MAD:
                store(dest, fromFloat(`(${f(a)} * ${f(b)} + ${f(c)})`, sat));
                break;
            case OPCODE.MIN:
                store(dest, fromFloat(`min(${f(a)}, ${f(b)})`, sat));
                break;
            case OPCODE.MAX:
                store(dest, fromFloat(`max(${f(a)}, ${f(b)})`, sat));
                break;
            case OPCODE.DP2:
                store(dest, fromFloat(splat(`dot(${floats(a, 2)}, ${floats(b, 2)})`), sat));
                break;
            case OPCODE.DP3:
                store(dest, fromFloat(splat(`dot(${floats(a, 3)}, ${floats(b, 3)})`), sat));
                break;
            case OPCODE.DP4:
                store(dest, fromFloat(splat(`dot(${f(a)}, ${f(b)})`), sat));
                break;
            case OPCODE.EXP:
                store(dest, fromFloat(`exp2(${f(a)})`, sat));
                break;
            case OPCODE.LOG:
                store(dest, fromFloat(`log2(${f(a)})`, sat));
                break;
            case OPCODE.RSQ:
                store(dest, fromFloat(`inverseSqrt(${f(a)})`, sat));
                break;
            case OPCODE.SQRT:
                store(dest, fromFloat(`sqrt(${f(a)})`, sat));
                break;
            case OPCODE.FRC:
                store(dest, fromFloat(`fract(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_NE:
                store(dest, fromFloat(`round(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_NI:
                store(dest, fromFloat(`floor(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_PI:
                store(dest, fromFloat(`ceil(${f(a)})`, sat));
                break;
            case OPCODE.ROUND_Z:
                store(dest, fromFloat(`trunc(${f(a)})`, sat));
                break;
            case OPCODE.SINCOS:
                storePair(instruction, fromFloat(`sin(${f(b)})`, sat),
                    fromFloat(`cos(${f(b)})`, sat));
                break;
            case OPCODE.DERIV_RTX:
                store(dest, fromFloat(`dpdx(${f(a)})`, sat));
                break;
            case OPCODE.DERIV_RTY:
                store(dest, fromFloat(`dpdy(${f(a)})`, sat));
                break;

            // --- float comparisons: all ones or all zeros, per component ---
            case OPCODE.LT:
                store(dest, fromBool(`(${f(a)} < ${f(b)})`));
                break;
            case OPCODE.GE:
                store(dest, fromBool(`(${f(a)} >= ${f(b)})`));
                break;
            case OPCODE.EQ:
                store(dest, fromBool(`(${f(a)} == ${f(b)})`));
                break;
            case OPCODE.NE:
                store(dest, fromBool(`(${f(a)} != ${f(b)})`));
                break;

            // --- integer arithmetic ---
            case OPCODE.IADD:
                store(dest, fromInt(`(${i(a)} + ${i(b)})`));
                break;
            case OPCODE.IMAD:
                store(dest, fromInt(`(${i(a)} * ${i(b)} + ${i(c)})`));
                break;
            case OPCODE.UMAD:
                store(dest, `(${u(a)} * ${u(b)} + ${u(c)})`);
                break;
            case OPCODE.IMUL:
                // The high half of a 32x32 product is not something WGSL can
                // ask for; only the low half is honoured, and a shader that
                // reads the high half is refused rather than fed zeros.
                if (dest.type !== OPERAND.NULL)
                {
                    unsupported('imul with a high destination');
                }
                store(a, fromInt(`(${i(b)} * ${i(c)})`));
                break;
            case OPCODE.UMUL:
                if (dest.type !== OPERAND.NULL)
                {
                    unsupported('umul with a high destination');
                }
                store(a, `(${u(b)} * ${u(c)})`);
                break;
            case OPCODE.UDIV:
                storePair(instruction, `(${u(b)} / ${u(c)})`, `(${u(b)} % ${u(c)})`);
                break;
            case OPCODE.IMAX:
                store(dest, fromInt(`max(${i(a)}, ${i(b)})`));
                break;
            case OPCODE.IMIN:
                store(dest, fromInt(`min(${i(a)}, ${i(b)})`));
                break;
            case OPCODE.UMAX:
                store(dest, `max(${u(a)}, ${u(b)})`);
                break;
            case OPCODE.UMIN:
                store(dest, `min(${u(a)}, ${u(b)})`);
                break;
            case OPCODE.INEG:
                store(dest, fromInt(`(-${i(a)})`));
                break;
            case OPCODE.ISHL:
                store(dest, `(${u(a)} << (${u(b)} & ${REG}(31u)))`);
                break;
            case OPCODE.ISHR:
                store(dest, fromInt(`(${i(a)} >> (${u(b)} & ${REG}(31u)))`));
                break;
            case OPCODE.USHR:
                store(dest, `(${u(a)} >> (${u(b)} & ${REG}(31u)))`);
                break;
            case OPCODE.AND:
                store(dest, `(${u(a)} & ${u(b)})`);
                break;
            case OPCODE.OR:
                store(dest, `(${u(a)} | ${u(b)})`);
                break;
            case OPCODE.XOR:
                store(dest, `(${u(a)} ^ ${u(b)})`);
                break;
            case OPCODE.NOT:
                store(dest, `(~${u(a)})`);
                break;
            case OPCODE.IEQ:
                store(dest, fromBool(`(${i(a)} == ${i(b)})`));
                break;
            case OPCODE.INE:
                store(dest, fromBool(`(${i(a)} != ${i(b)})`));
                break;
            case OPCODE.IGE:
                store(dest, fromBool(`(${i(a)} >= ${i(b)})`));
                break;
            case OPCODE.ILT:
                store(dest, fromBool(`(${i(a)} < ${i(b)})`));
                break;
            case OPCODE.UGE:
                store(dest, fromBool(`(${u(a)} >= ${u(b)})`));
                break;
            case OPCODE.ULT:
                store(dest, fromBool(`(${u(a)} < ${u(b)})`));
                break;

            // --- conversions ---
            case OPCODE.ITOF:
                store(dest, fromFloat(`vec4<f32>(${i(a)})`, sat));
                break;
            case OPCODE.UTOF:
                store(dest, fromFloat(`vec4<f32>(${u(a)})`, sat));
                break;
            case OPCODE.FTOI:
                store(dest, fromInt(`vec4<i32>(${f(a)})`));
                break;
            case OPCODE.FTOU:
                store(dest, `${REG}(${f(a)})`);
                break;

            // --- flow control ---
            case OPCODE.IF:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) {`);
                depth++;
                break;
            case OPCODE.ELSE:
                depth--;
                emit('} else {');
                depth++;
                break;
            case OPCODE.ENDIF:
                depth--;
                emit('}');
                break;
            case OPCODE.LOOP:
                emit('loop {');
                depth++;
                break;
            case OPCODE.ENDLOOP:
                depth--;
                emit('}');
                break;
            case OPCODE.BREAK:
                emit('break;');
                break;
            case OPCODE.BREAKC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { break; }`);
                break;
            case OPCODE.CONTINUE:
                emit('continue;');
                break;
            case OPCODE.CONTINUEC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { continue; }`);
                break;
            case OPCODE.DISCARD:
                if (!isPixel)
                {
                    unsupported('discard outside a pixel shader');
                    break;
                }
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) { discard; }`);
                break;
            case OPCODE.RET:
                result.body.push({ ret: true });
                break;
            case OPCODE.RETC:
                emit(`if (${u(dest)}.x ${instruction.testNonZero ? '!=' : '=='} 0u) {`);
                depth++;
                result.body.push({ ret: true });
                depth--;
                emit('}');
                break;

            // --- textures ---
            case OPCODE.SAMPLE:
                if (!isPixel)
                {
                    unsupported('sample outside a pixel shader');
                    break;
                }
                sampleWith(instruction, (texture, shaped, sampler)=>
                    `textureSample(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`})`);
                break;
            case OPCODE.SAMPLE_L:
                sampleWith(instruction, (texture, shaped, sampler)=>
                    `textureSampleLevel(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `, ${f(instruction.operands[4])}.x)`);
                break;
            case OPCODE.SAMPLE_B:
                if (!isPixel)
                {
                    unsupported('sample_b outside a pixel shader');
                    break;
                }
                sampleWith(instruction, (texture, shaped, sampler)=>
                    `textureSampleBias(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `, ${f(instruction.operands[4])}.x)`);
                break;
            case OPCODE.SAMPLE_D:
                sampleWith(instruction, (texture, shaped, sampler)=>{
                    const width = shaped.coordinate.endsWith('.x')
                        ? 1
                        : shaped.coordinate.endsWith('.xy') ? 2 : 3;
                    return `textureSampleGrad(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                        + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                        + `, ${floats(instruction.operands[4], width)}`
                        + `, ${floats(instruction.operands[5], width)})`;
                });
                break;
            case OPCODE.SAMPLE_C:
            case OPCODE.SAMPLE_C_LZ: {
                const compareTexture = textureOf(instruction.operands[2].indices[0].value);
                if (compareTexture)
                {
                    compareTexture.comparison = true;
                }
                const level = instruction.opcode === OPCODE.SAMPLE_C_LZ;
                if (!level && !isPixel)
                {
                    unsupported('sample_c outside a pixel shader');
                    break;
                }
                // A compare-sample answers one float; the register file wants
                // four, and the texture's swizzle picks among them.
                sampleWith(instruction, (texture, shaped, sampler)=>
                    `vec4<f32>(${level ? 'textureSampleCompareLevel' : 'textureSampleCompare'}`
                    + `(t${texture.slot}, ${sampler}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}`
                    + `, ${f(instruction.operands[4])}.x))`);
                break;
            }
            case OPCODE.LD: {
                const [target, address, resource] = instruction.operands;
                const texture = textureOf(resource.indices[0].value);
                const shaped = texture ? coordinateFor(texture, i(address)) : null;
                if (!texture || !shaped
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURECUBE
                    || texture.dimension === RESOURCE_DIMENSION.TEXTURECUBEARRAY)
                {
                    unsupported('ld on an undeclared or unsupported texture');
                    break;
                }
                const level = texture.dimension === RESOURCE_DIMENSION.TEXTURE2DMS
                    ? ''
                    : `, ${i(address)}.w`;
                store(target, sampledBits(texture, resource,
                    `textureLoad(t${texture.slot}, ${shaped.coordinate}`
                    + `${shaped.layer === null ? '' : `, ${shaped.layer}`}${level})`));
                break;
            }
            case OPCODE.RESINFO: {
                const [target, level, resource] = instruction.operands;
                const texture = textureOf(resource.indices[0].value);
                if (!texture || texture.dimension !== RESOURCE_DIMENSION.TEXTURE2D)
                {
                    unsupported('resinfo on anything but a 2D texture');
                    break;
                }
                const name = `t${texture.slot}`;
                const size = `textureDimensions(${name}, ${u(level)}.x)`;
                const levels = `textureNumLevels(${name})`;
                const asUint = (instruction.control & 0x3) === 2;
                const value = `${REG}(${size}.x, ${size}.y, 0u, ${levels})`;
                store(target, asUint ? value : `bitcast<${REG}>(vec4<f32>(${value}))`);
                break;
            }

            default:
                unsupported(instruction.name);
                break;
        }
    }

    return result;
}

/**
 * @param {TextureDecl} texture
 * @returns {{ type: string, sampleType: string, viewDimension: string } | null}
 */
function textureType(texture){
    const sampled = texture.returnType === RETURN_TYPE.UINT
        ? { scalar: 'u32', sampleType: 'uint' }
        : texture.returnType === RETURN_TYPE.SINT
            ? { scalar: 'i32', sampleType: 'sint' }
            : { scalar: 'f32', sampleType: 'float' };
    /** @type {Record<number, [string, string]>} */
    const shapes = {
        [RESOURCE_DIMENSION.TEXTURE1D]: ['1d', '1d'],
        [RESOURCE_DIMENSION.TEXTURE2D]: ['2d', '2d'],
        [RESOURCE_DIMENSION.TEXTURE3D]: ['3d', '3d'],
        [RESOURCE_DIMENSION.TEXTURECUBE]: ['cube', 'cube'],
        [RESOURCE_DIMENSION.TEXTURE2DARRAY]: ['2d_array', '2d-array'],
        [RESOURCE_DIMENSION.TEXTURECUBEARRAY]: ['cube_array', 'cube-array'],
    };
    const shape = shapes[texture.dimension];
    if (!shape)
    {
        return null;
    }
    if (texture.comparison)
    {
        return {
            type: `texture_depth_${shape[0]}`, sampleType: 'depth', viewDimension: shape[1],
        };
    }
    return {
        type: `texture_${shape[0]}<${sampled.scalar}>`,
        sampleType: sampled.sampleType,
        viewDimension: shape[1],
    };
}

/**
 * @typedef {Object} BindGroupLayoutEntry
 * @property {number} binding
 * @property {number} visibility
 * @property {{ type: string }} [buffer]
 * @property {{ sampleType: string, viewDimension: string }} [texture]
 * @property {{ type: string }} [sampler]
 */

/**
 * The module-scope declarations of one stage: its bindings and its immediate
 * constants.
 *
 * @param {TranslatedShader} shader
 * @param {number} group
 * @param {number} visibility
 * @returns {{ text: string[], entries: BindGroupLayoutEntry[], unsupported: string[] }}
 */
function declarations(shader, group, visibility){
    /** @type {string[]} */
    const text = [];
    /** @type {BindGroupLayoutEntry[]} */
    const entries = [];
    /** @type {string[]} */
    const problems = [];
    for (const buffer of shader.constantBuffers)
    {
        const binding = BINDING.CONSTANT_BUFFER + buffer.slot;
        text.push(`@group(${group}) @binding(${binding}) var<uniform> cb${buffer.slot}: `
            + `array<${REG}, ${Math.max(1, buffer.size)}>;`);
        entries.push({ binding, visibility, buffer: { type: 'uniform' } });
    }
    for (const texture of shader.textures)
    {
        const type = textureType(texture);
        if (!type)
        {
            problems.push(`texture dimension ${texture.dimension}`);
            continue;
        }
        const binding = BINDING.TEXTURE + texture.slot;
        text.push(`@group(${group}) @binding(${binding}) var t${texture.slot}: ${type.type};`);
        entries.push({
            binding,
            visibility,
            texture: { sampleType: type.sampleType, viewDimension: type.viewDimension },
        });
    }
    for (const sampler of shader.samplers)
    {
        const binding = BINDING.SAMPLER + sampler.slot;
        text.push(`@group(${group}) @binding(${binding}) var s${sampler.slot}: `
            + `${sampler.comparison ? 'sampler_comparison' : 'sampler'};`);
        entries.push({
            binding, visibility, sampler: { type: sampler.comparison ? 'comparison' : 'filtering' },
        });
    }
    if (shader.immediateConstants.length > 0)
    {
        const rows = shader.immediateConstants
            .map(row=>`${REG}(${row.map(u32Literal).join(', ')})`);
        text.push(`const icb = array<${REG}, ${rows.length}>(${rows.join(', ')});`);
    }
    return { text, entries, unsupported: problems };
}

/** @param {number} componentType @returns {string} */
function scalarOf(componentType){
    return componentType === COMPONENT_TYPE.UINT
        ? 'u32'
        : componentType === COMPONENT_TYPE.SINT ? 'i32' : 'f32';
}

/**
 * The registers a body declares and the `let`s that fill them, shared by both
 * entry points.
 *
 * @param {TranslatedShader} shader
 * @returns {string[]}
 */
function registerDeclarations(shader){
    /** @type {string[]} */
    const lines = [];
    for (let index = 0; index < shader.temps; index++)
    {
        lines.push(`    var r${index}: ${REG};`);
    }
    for (const temp of shader.indexableTemps)
    {
        lines.push(`    var x${temp.index}: array<${REG}, ${temp.size}>;`);
    }
    for (let index = 0; index < shader.outputRegisters; index++)
    {
        lines.push(`    var o${index}: ${REG};`);
    }
    return lines;
}

/**
 * @param {TranslatedShader} shader
 * @param {string} returnExpression
 * @returns {string[]}
 */
function bodyText(shader, returnExpression){
    return shader.body.map(line=>(typeof line === 'string'
        ? line
        : `    return ${returnExpression};`));
}

/** @param {import('./dxbc.js').SignatureElement} element */
const semanticKey = element=>`${element.name.toUpperCase()}${element.index}`;

/**
 * @typedef {Object} LinkedProgram
 * @property {string} vertex        WGSL, entry point `vertexMain`.
 * @property {string} fragment      WGSL, entry point `fragmentMain`.
 * @property {BindGroupLayoutEntry[][]} groups  One entry list per stage: vertex, then fragment.
 * @property {{ location: number, semantic: string, index: number, componentType: number }[]}
 *           attributes  The vertex inputs, for the input layout to match against.
 * @property {number[]} targets     The render targets the pixel shader writes.
 * @property {string[]} unsupported Why the pair cannot be built, if it cannot.
 */

/**
 * Writes the two entry points around a vertex and a pixel shader body, with the
 * interface between them numbered once for both.
 *
 * @param {TranslatedShader} vs
 * @param {TranslatedShader} ps
 * @returns {LinkedProgram}
 */
export function linkProgram(vs, ps){
    /** @type {string[]} */
    const unsupported = [...vs.unsupported, ...ps.unsupported];
    const vsDecl = declarations(vs, 0, STAGE.VERTEX);
    const psDecl = declarations(ps, 1, STAGE.FRAGMENT);
    unsupported.push(...vsDecl.unsupported, ...psDecl.unsupported);

    // --- the vertex stage's inputs ---
    /** @type {string[]} */
    const vsIn = [];
    /** @type {string[]} */
    const vsLoad = [];
    /** @type {LinkedProgram['attributes']} */
    const attributes = [];
    for (let index = 0; index < vs.inputRegisters; index++)
    {
        vsLoad.push(`    var v${index}: ${REG} = ${REG}(0u);`);
    }
    for (const element of vs.inputs)
    {
        if (element.register >= vs.inputRegisters)
        {
            continue;
        }
        const scalar = scalarOf(element.componentType);
        if (element.systemValue === SYSTEM_VALUE.VERTEX_ID)
        {
            vsIn.push(`    @builtin(vertex_index) v${element.register}: u32,`);
            vsLoad.push(`    v${element.register}.x = in.v${element.register};`);
        }
        else if (element.systemValue === SYSTEM_VALUE.INSTANCE_ID)
        {
            vsIn.push(`    @builtin(instance_index) v${element.register}: u32,`);
            vsLoad.push(`    v${element.register}.x = in.v${element.register};`);
        }
        else if (element.systemValue === SYSTEM_VALUE.UNDEFINED)
        {
            vsIn.push(`    @location(${element.register}) v${element.register}: vec4<${scalar}>,`);
            vsLoad.push(`    v${element.register} = ${scalar === 'u32'
                ? `in.v${element.register}`
                : `bitcast<${REG}>(in.v${element.register})`};`);
            attributes.push({
                location: element.register,
                semantic: element.name,
                index: element.index,
                componentType: element.componentType,
            });
        }
        else
        {
            unsupported.push(`vertex input system value ${element.systemValue}`);
        }
    }

    // --- the interface between the stages, numbered by the vertex outputs ---
    /** @type {Map<string, { location: number, scalar: string }>} */
    const varyings = new Map();
    /** @type {string[]} */
    const vsOut = [];
    /** @type {string[]} */
    const vsReturn = [];
    let position = false;
    for (const element of vs.outputs)
    {
        const register = `o${element.register}`;
        const value = element.register < vs.outputRegisters ? register : `${REG}(0u)`;
        if (element.systemValue === SYSTEM_VALUE.POSITION)
        {
            position = true;
            vsOut.push('    @builtin(position) position: vec4<f32>,');
            vsReturn.push(`bitcast<vec4<f32>>(${value})`);
            continue;
        }
        if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`vertex output system value ${element.systemValue}`);
            continue;
        }
        const key = semanticKey(element);
        if (varyings.has(key))
        {
            continue;
        }
        const scalar = scalarOf(element.componentType);
        const location = varyings.size;
        varyings.set(key, { location, scalar });
        // An integer varying cannot be interpolated and WGSL says so; a
        // float one is interpolated the way the rasteriser always did.
        const interpolate = scalar === 'f32' ? '' : ' @interpolate(flat)';
        vsOut.push(`    @location(${location})${interpolate} ${register}: vec4<${scalar}>,`);
        vsReturn.push(scalar === 'u32' ? value : `bitcast<vec4<${scalar}>>(${value})`);
    }
    if (!position)
    {
        unsupported.push('a vertex shader that writes no SV_Position');
    }

    // --- the pixel stage's inputs, found by semantic among the vertex outputs ---
    /** @type {string[]} */
    const psIn = [];
    /** @type {string[]} */
    const psLoad = [];
    for (let index = 0; index < ps.inputRegisters; index++)
    {
        psLoad.push(`    var v${index}: ${REG} = ${REG}(0u);`);
    }
    for (const element of ps.inputs)
    {
        if (element.register >= ps.inputRegisters)
        {
            continue;
        }
        const name = `v${element.register}`;
        if (element.systemValue === SYSTEM_VALUE.POSITION)
        {
            psIn.push(`    @builtin(position) ${name}: vec4<f32>,`);
            psLoad.push(`    ${name} = bitcast<${REG}>(in.${name});`);
            continue;
        }
        if (element.systemValue === SYSTEM_VALUE.IS_FRONT_FACE)
        {
            psIn.push(`    @builtin(front_facing) ${name}: bool,`);
            psLoad.push(`    ${name}.x = select(0u, 0xffffffffu, in.${name});`);
            continue;
        }
        if (element.systemValue !== SYSTEM_VALUE.UNDEFINED)
        {
            unsupported.push(`pixel input system value ${element.systemValue}`);
            continue;
        }
        const varying = varyings.get(semanticKey(element));
        if (!varying)
        {
            // The vertex shader wrote nothing under this name, which Direct3D
            // refuses at draw time; here the register reads as zero and the
            // pair says why.
            unsupported.push(`pixel input ${semanticKey(element)} has no vertex output`);
            continue;
        }
        const interpolate = varying.scalar === 'f32' ? '' : ' @interpolate(flat)';
        psIn.push(`    @location(${varying.location})${interpolate} ${name}: `
            + `vec4<${varying.scalar}>,`);
        psLoad.push(`    ${name} = ${varying.scalar === 'u32'
            ? `in.${name}`
            : `bitcast<${REG}>(in.${name})`};`);
    }

    // --- the pixel stage's outputs ---
    /** @type {string[]} */
    const psOut = [];
    /** @type {string[]} */
    const psReturn = [];
    /** @type {number[]} */
    const targets = [];
    for (const element of ps.outputs)
    {
        const value = element.register < ps.outputRegisters
            ? `o${element.register}`
            : `${REG}(0u)`;
        if (element.systemValue === SYSTEM_VALUE.TARGET)
        {
            const scalar = scalarOf(element.componentType);
            psOut.push(`    @location(${element.index}) target${element.index}: vec4<${scalar}>,`);
            psReturn.push(scalar === 'u32' ? value : `bitcast<vec4<${scalar}>>(${value})`);
            targets.push(element.index);
            continue;
        }
        if (element.systemValue === SYSTEM_VALUE.DEPTH)
        {
            psOut.push('    @builtin(frag_depth) depth: f32,');
            psReturn.push('oDepth');
            continue;
        }
        unsupported.push(`pixel output system value ${element.systemValue}`);
    }

    // WGSL has no empty struct, so a stage that reads nothing takes nothing.
    const vertex = [
        ...vsDecl.text,
        ...(vsIn.length > 0 ? ['struct VertexIn {', ...vsIn, '};'] : []),
        'struct VertexOut {',
        ...vsOut,
        '};',
        `@vertex fn vertexMain(${vsIn.length > 0 ? 'in: VertexIn' : ''}) -> VertexOut {`,
        ...vsLoad,
        ...registerDeclarations(vs),
        ...bodyText(vs, `VertexOut(${vsReturn.join(', ')})`),
        '}',
    ].join('\n');

    const fragment = [
        ...psDecl.text,
        ...(psIn.length > 0 ? ['struct FragmentIn {', ...psIn, '};'] : []),
        'struct FragmentOut {',
        ...psOut,
        '};',
        `@fragment fn fragmentMain(${psIn.length > 0 ? 'in: FragmentIn' : ''}) -> FragmentOut {`,
        ...psLoad,
        ...registerDeclarations(ps),
        ...(ps.writesDepth ? ['    var oDepth: f32 = 0.0;'] : []),
        ...bodyText(ps, `FragmentOut(${psReturn.join(', ')})`),
        '}',
    ].join('\n');

    return {
        vertex,
        fragment,
        groups: [vsDecl.entries, psDecl.entries],
        attributes,
        targets,
        unsupported,
    };
}

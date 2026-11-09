/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Shader Model 4 assembler for tests.
 *
 * A test of the translator needs bytecode, and bytecode from a compiler is
 * opaque: a reader cannot see which instruction a test is about, and changing
 * one operand means recompiling. So the tests build their programs here,
 * instruction by instruction, from the token format itself -- the same format
 * `sm4.js` decodes, written the other way round. The two are checked against
 * each other in `sm4.test.js`, and one of them against a blob a real compiler
 * produced, which is what keeps this from being a closed loop.
 *
 * Nothing in this file is reached by the product; it is a fixture.
 */

import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE, parseDxbc } from './dxbc.js';
import { MODIFIER, OPCODE, OPERAND, SELECTION } from './sm4.js';

const COMPONENT_INDEX = { x: 0, y: 1, z: 2, w: 3 };

/**
 * @typedef {Object} AsmOperand
 * @property {number} type
 * @property {number[]} indices
 * @property {number} [mask]         A write mask, for a destination.
 * @property {string} [swizzle]      Up to four of xyzw, for a source.
 * @property {number[]} [immediate]  Dwords, for an immediate.
 * @property {number} [modifier]
 * @property {AsmOperand} [relative] Added to the last index.
 */

/** @param {string} components @returns {number} */
function maskOf(components){
    let mask = 0;
    for (const component of components)
    {
        mask |= 1 << COMPONENT_INDEX[/** @type {'x'|'y'|'z'|'w'} */ (component)];
    }
    return mask;
}

/**
 * @param {number} type
 * @param {number[]} indices
 * @param {string} [components]  A mask for a destination, a swizzle for a source.
 * @returns {AsmOperand}
 */
function register(type, indices, components = 'xyzw'){
    return { type, indices, mask: maskOf(components), swizzle: components };
}

/** @param {number} index @param {string} [components] */
export const r = (index, components)=>register(OPERAND.TEMP, [index], components);
/** @param {number} index @param {string} [components] */
export const v = (index, components)=>register(OPERAND.INPUT, [index], components);
/** @param {number} index @param {string} [components] */
export const o = (index, components)=>register(OPERAND.OUTPUT, [index], components);
/** A hull or domain shader's input control point. @param {number} point @param {number} index
 *  @param {string} [components] */
export const vicp = (point, index, components)=>
    register(OPERAND.INPUT_CONTROL_POINT, [point, index], components);
/** A hull shader's input control point as its control point phase names it: v[point][index].
 *  @param {number} point @param {number} index @param {string} [components] */
export const vPoint = (point, index, components)=>
    register(OPERAND.INPUT, [point, index], components);
/** A hull shader's output control point, as a later phase reads it.
 *  @param {number} point @param {number} index @param {string} [components] */
export const vocp = (point, index, components)=>
    register(OPERAND.OUTPUT_CONTROL_POINT, [point, index], components);
/** A patch constant, as a join phase or a domain shader reads it.
 *  @param {number} index @param {string} [components] */
export const vpc = (index, components)=>register(OPERAND.INPUT_PATCH_CONSTANT, [index], components);
/** @param {string} [components] */
export const vOutputControlPointID = components=>
    register(OPERAND.OUTPUT_CONTROL_POINT_ID, [], components);
/** @param {string} [components] */
export const vForkInstanceID = components=>
    register(OPERAND.INPUT_FORK_INSTANCE_ID, [], components);
/** @param {string} [components] */
export const vDomain = components=>register(OPERAND.INPUT_DOMAIN_POINT, [], components);
/** @param {string} [components] */
export const vPrim = components=>register(OPERAND.INPUT_PRIMITIVE_ID, [], components);
/** @param {number} slot @param {number} index @param {string} [components] */
export const cb = (slot, index, components)=>
    register(OPERAND.CONSTANT_BUFFER, [slot, index], components);
/** @param {number} slot @param {string} [components] */
export const t = (slot, components)=>register(OPERAND.RESOURCE, [slot], components);
/** @param {number} slot */
export const s = slot=>({ type: OPERAND.SAMPLER, indices: [slot] });
export const nullDest = ()=>({ type: OPERAND.NULL, indices: [] });
export const oDepth = ()=>({ type: OPERAND.OUTPUT_DEPTH, indices: [] });
export const oMask = ()=>({ type: OPERAND.OUTPUT_COVERAGE_MASK, indices: [] });
/** @param {string} [components] */
export const vCoverage = components=>register(OPERAND.INPUT_COVERAGE_MASK, [], components);

/**
 * @param {AsmOperand} operand
 * @param {number} modifier
 * @returns {AsmOperand}
 */
export const modified = (operand, modifier)=>({ ...operand, modifier });

/**
 * @param {AsmOperand} operand
 * @param {AsmOperand} relative
 * @returns {AsmOperand}
 */
export const indexedBy = (operand, relative)=>({ ...operand, relative });

const scratch = new DataView(new ArrayBuffer(4));

/** @param {number} value */
function floatBits(value){
    scratch.setFloat32(0, value, true);
    return scratch.getUint32(0, true);
}

/** @param {number[]} values floats @returns {AsmOperand} */
export const l = (...values)=>({
    type: OPERAND.IMMEDIATE32,
    indices: [],
    immediate: values.map(floatBits),
});

/** @param {number[]} values dwords @returns {AsmOperand} */
export const lu = (...values)=>({
    type: OPERAND.IMMEDIATE32,
    indices: [],
    immediate: values.map(value=>value >>> 0),
});

/** @param {number[]} values one or two doubles @returns {AsmOperand} */
export const dl = (...values)=>({
    type: OPERAND.IMMEDIATE64,
    indices: [],
    immediate: values.flatMap(value=>{
        const words = new DataView(new ArrayBuffer(8));
        words.setFloat64(0, value, true);
        return [words.getUint32(0, true), words.getUint32(4, true)];
    }),
});

/** @param {AsmOperand} operand @param {boolean} destination */
function encodeOperand(operand, destination){
    /** @type {number[]} */
    const words = [];
    const isImmediate = operand.type === OPERAND.IMMEDIATE32
        || operand.type === OPERAND.IMMEDIATE64;
    let token = 0;
    if (isImmediate)
    {
        // A dword or a double is one component; four dwords or two doubles four.
        const count = /** @type {number[]} */ (operand.immediate).length;
        token |= count === (operand.type === OPERAND.IMMEDIATE64 ? 2 : 1) ? 1 : 2;
    }
    else if (operand.type === OPERAND.SAMPLER && operand.swizzle)
    {
        // A gather's sampler selects the channel it gathers.
        token |= 2 | (SELECTION.SELECT1 << 2)
            | (COMPONENT_INDEX[/** @type {'x'|'y'|'z'|'w'} */ (operand.swizzle[0])] << 4);
    }
    else if (operand.type === OPERAND.NULL || operand.type === OPERAND.SAMPLER
        || operand.type === OPERAND.LABEL || operand.type === OPERAND.FUNCTION_BODY
        || operand.type === OPERAND.INTERFACE)
    {
        // None names a component: a sampler or a label is one thing and null
        // is nothing.
        token |= 0;
    }
    else if (operand.type === OPERAND.OUTPUT_DEPTH)
    {
        token |= 1;
    }
    else
    {
        token |= 2;
        if (destination)
        {
            token |= SELECTION.MASK << 2;
            token |= (operand.mask ?? 0xf) << 4;
        }
        else
        {
            const swizzle = operand.swizzle ?? 'xyzw';
            const padded = swizzle.padEnd(4, swizzle[swizzle.length - 1]);
            let field = 0;
            for (let index = 0; index < 4; index++)
            {
                field |= COMPONENT_INDEX[/** @type {'x'|'y'|'z'|'w'} */ (padded[index])]
                    << (index * 2);
            }
            token |= SELECTION.SWIZZLE << 2;
            token |= field << 4;
        }
    }
    token |= operand.type << 12;
    token |= operand.indices.length << 20;
    if (operand.relative && operand.indices.length > 0)
    {
        // The last index is immediate plus a register: representation 3.
        token |= 3 << (22 + (operand.indices.length - 1) * 3);
    }
    const modifier = operand.modifier ?? 0;
    if (modifier !== 0)
    {
        token |= 0x80000000;
    }
    words.push(token >>> 0);
    if (modifier !== 0)
    {
        words.push((1 | (modifier << 6)) >>> 0);
    }
    if (isImmediate)
    {
        words.push(.../** @type {number[]} */ (operand.immediate));
    }
    operand.indices.forEach((index, at)=>{
        words.push(index >>> 0);
        if (operand.relative && at === operand.indices.length - 1)
        {
            words.push(...encodeOperand(operand.relative, false));
        }
    });
    return words;
}

/**
 * @typedef {Object} AsmInstruction
 * @property {number} opcode
 * @property {AsmOperand[]} [operands]
 * @property {number[]} [extra]        Trailing dwords: a system value, a return type.
 * @property {number[]} [leading]      Dwords before the operands: `fcall`'s call site.
 * @property {number} [control]        Bits 11..23 of the opcode token.
 * @property {boolean} [saturate]
 * @property {boolean} [nonZero]
 * @property {number} [destinations]   How many leading operands are destinations; one by default.
 * @property {number[]} [offset]       An immediate texel offset (`aoffimmi`), u, v, w.
 */

/**
 * @param {AsmInstruction} instruction
 * @returns {number[]}
 */
function encodeInstruction(instruction){
    const operands = instruction.operands ?? [];
    const destinations = instruction.destinations ?? 1;
    /** @type {number[]} */
    const words = [];
    words.push(...(instruction.leading ?? []));
    operands.forEach((operand, index)=>{
        words.push(...encodeOperand(operand, index < destinations));
    });
    words.push(...(instruction.extra ?? []));
    let token = instruction.opcode & 0x7ff;
    token |= ((instruction.control ?? 0) & 0x1fff) << 11;
    if (instruction.saturate)
    {
        token |= 0x2000;
    }
    if (instruction.nonZero)
    {
        token |= 0x40000;
    }
    // An immediate texel offset is an extended token of sample controls.
    const extended = instruction.offset
        ? [(1 | ((instruction.offset[0] & 0xf) << 9) | ((instruction.offset[1] & 0xf) << 13)
            | ((instruction.offset[2] & 0xf) << 17)) >>> 0]
        : [];
    if (extended.length > 0)
    {
        token |= 0x80000000;
    }
    token |= (words.length + extended.length + 1) << 24;
    return [token >>> 0, ...extended, ...words];
}

// --- the instructions, as a test spells them ---

/** @param {number} opcode @param {AsmOperand[]} operands @param {Partial<AsmInstruction>} [more] */
const op = (opcode, operands, more = {})=>({ opcode, operands, ...more });

/** @param {number} opcode */
const arithmetic = opcode=>
    (/** @type {AsmOperand} */ dest, /** @type {AsmOperand[]} */ ...sources)=>
        op(opcode, [dest, ...sources]);

export const mov = arithmetic(OPCODE.MOV);
/** The rasterizer, which `sampleinfo` and `samplepos` read the sample count of. */
export const rasterizer = ()=>register(OPERAND.RASTERIZER, [], 'xyzw');
/**
 * @param {AsmOperand} dest @param {AsmOperand} resource  a texture or the rasterizer
 * @param {boolean} [integer]  `_uint`
 */
export const sampleInfo = (dest, resource, integer = false)=>
    op(OPCODE.SAMPLE_INFO, [dest, resource], integer ? { control: 1 } : {});
/** @param {AsmOperand} dest @param {AsmOperand} resource @param {AsmOperand} index */
export const samplePos = (dest, resource, index)=>op(OPCODE.SAMPLE_POS, [dest, resource, index]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} texture
 * @param {AsmOperand} sampler
 */
export const lod = (dest, coordinate, texture, sampler)=>
    op(OPCODE.LOD, [dest, coordinate, texture, sampler]);
/** @param {AsmOperand} dest @param {AsmOperand} input */
export const evalCentroid = (dest, input)=>op(OPCODE.EVAL_CENTROID, [dest, input]);
/** @param {AsmOperand} dest @param {AsmOperand} input @param {AsmOperand} index */
export const evalSampleIndex = (dest, input, index)=>
    op(OPCODE.EVAL_SAMPLE_INDEX, [dest, input, index]);
/** @param {AsmOperand} dest @param {AsmOperand} input @param {AsmOperand} offset */
export const evalSnapped = (dest, input, offset)=>op(OPCODE.EVAL_SNAPPED, [dest, input, offset]);
export const movc = arithmetic(OPCODE.MOVC);
export const add = arithmetic(OPCODE.ADD);
export const mul = arithmetic(OPCODE.MUL);
export const mad = arithmetic(OPCODE.MAD);
export const div = arithmetic(OPCODE.DIV);
export const dp2 = arithmetic(OPCODE.DP2);
export const dp3 = arithmetic(OPCODE.DP3);
export const dp4 = arithmetic(OPCODE.DP4);
export const min = arithmetic(OPCODE.MIN);
export const max = arithmetic(OPCODE.MAX);
export const rsq = arithmetic(OPCODE.RSQ);
export const sqrt = arithmetic(OPCODE.SQRT);
export const frc = arithmetic(OPCODE.FRC);
export const exp = arithmetic(OPCODE.EXP);
export const log = arithmetic(OPCODE.LOG);
export const lt = arithmetic(OPCODE.LT);
export const ge = arithmetic(OPCODE.GE);
export const eq = arithmetic(OPCODE.EQ);
export const ne = arithmetic(OPCODE.NE);
export const iadd = arithmetic(OPCODE.IADD);
export const imad = arithmetic(OPCODE.IMAD);
export const ineg = arithmetic(OPCODE.INEG);
export const ishl = arithmetic(OPCODE.ISHL);
export const ishr = arithmetic(OPCODE.ISHR);
export const ushr = arithmetic(OPCODE.USHR);
export const and = arithmetic(OPCODE.AND);
export const or = arithmetic(OPCODE.OR);
export const xor = arithmetic(OPCODE.XOR);
export const not = arithmetic(OPCODE.NOT);
export const ieq = arithmetic(OPCODE.IEQ);
export const ilt = arithmetic(OPCODE.ILT);
export const ige = arithmetic(OPCODE.IGE);
export const ult = arithmetic(OPCODE.ULT);
export const itof = arithmetic(OPCODE.ITOF);
export const utof = arithmetic(OPCODE.UTOF);
export const ftoi = arithmetic(OPCODE.FTOI);
export const ftou = arithmetic(OPCODE.FTOU);
export const roundNe = arithmetic(OPCODE.ROUND_NE);
export const roundNi = arithmetic(OPCODE.ROUND_NI);
export const umin = arithmetic(OPCODE.UMIN);
export const dadd = arithmetic(OPCODE.DADD);
export const dmul = arithmetic(OPCODE.DMUL);
export const ddiv = arithmetic(OPCODE.DDIV);
export const drcp = arithmetic(OPCODE.DRCP);
export const dfma = arithmetic(OPCODE.DFMA);
export const dmin = arithmetic(OPCODE.DMIN);
export const dmax = arithmetic(OPCODE.DMAX);
export const dmov = arithmetic(OPCODE.DMOV);
export const dmovc = arithmetic(OPCODE.DMOVC);
export const deq = arithmetic(OPCODE.DEQ);
export const dne = arithmetic(OPCODE.DNE);
export const dlt = arithmetic(OPCODE.DLT);
export const dge = arithmetic(OPCODE.DGE);
export const dtof = arithmetic(OPCODE.DTOF);
export const dtoi = arithmetic(OPCODE.DTOI);
export const dtou = arithmetic(OPCODE.DTOU);
export const ftod = arithmetic(OPCODE.FTOD);
export const itod = arithmetic(OPCODE.ITOD);
export const utod = arithmetic(OPCODE.UTOD);
export const umax = arithmetic(OPCODE.UMAX);

/** @param {AsmOperand} dest @param {AsmOperand[]} sources */
export const addSat = (dest, ...sources)=>op(OPCODE.ADD, [dest, ...sources], { saturate: true });

/** @param {AsmOperand} sin @param {AsmOperand} cos @param {AsmOperand} source */
export const sincos = (sin, cos, source)=>
    op(OPCODE.SINCOS, [sin, cos, source], { destinations: 2 });
/**
 * @param {AsmOperand} high @param {AsmOperand} low
 * @param {AsmOperand} a @param {AsmOperand} b
 */
export const imul = (high, low, a, b)=>op(OPCODE.IMUL, [high, low, a, b], { destinations: 2 });
/**
 * @param {AsmOperand} quotient @param {AsmOperand} remainder
 * @param {AsmOperand} a @param {AsmOperand} b
 */
export const udiv = (quotient, remainder, a, b)=>
    op(OPCODE.UDIV, [quotient, remainder, a, b], { destinations: 2 });
/**
 * @param {AsmOperand} high @param {AsmOperand} low
 * @param {AsmOperand} a @param {AsmOperand} b
 */
export const umul = (high, low, a, b)=>op(OPCODE.UMUL, [high, low, a, b], { destinations: 2 });

/** @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} texture @param {AsmOperand} sampler */
export const sample = (dest, coordinate, texture, sampler)=>
    op(OPCODE.SAMPLE, [dest, coordinate, texture, sampler]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} texture
 * @param {AsmOperand} sampler @param {AsmOperand} level
 */
export const sampleL = (dest, coordinate, texture, sampler, level)=>
    op(OPCODE.SAMPLE_L, [dest, coordinate, texture, sampler, level]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} texture
 * @param {AsmOperand} sampler @param {AsmOperand} reference
 */
export const sampleCLz = (dest, coordinate, texture, sampler, reference)=>
    op(OPCODE.SAMPLE_C_LZ, [dest, coordinate, texture, sampler, reference]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} texture
 * @param {AsmOperand} sampler @param {AsmOperand} ddx @param {AsmOperand} ddy
 */
export const sampleD = (dest, coordinate, texture, sampler, ddx, ddy)=>
    op(OPCODE.SAMPLE_D, [dest, coordinate, texture, sampler, ddx, ddy]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} texture
 * @param {AsmOperand} sampler
 */
export const gather4 = (dest, coordinate, texture, sampler)=>
    op(OPCODE.GATHER4, [dest, coordinate, texture, sampler]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} texture
 * @param {AsmOperand} sampler @param {AsmOperand} reference
 */
export const gather4C = (dest, coordinate, texture, sampler, reference)=>
    op(OPCODE.GATHER4_C, [dest, coordinate, texture, sampler, reference]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} coordinate @param {AsmOperand} offset
 * @param {AsmOperand} texture @param {AsmOperand} sampler
 */
export const gather4Po = (dest, coordinate, offset, texture, sampler)=>
    op(OPCODE.GATHER4_PO, [dest, coordinate, offset, texture, sampler]);
/** @param {AsmOperand} dest @param {AsmOperand} address @param {AsmOperand} texture */
export const ld = (dest, address, texture)=>op(OPCODE.LD, [dest, address, texture]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} address @param {AsmOperand} texture
 * @param {AsmOperand} sampleIndex
 */
export const ldMs = (dest, address, texture, sampleIndex)=>
    op(OPCODE.LD_MS, [dest, address, texture, sampleIndex]);
/** @param {AsmOperand} dest @param {AsmOperand} level @param {AsmOperand} texture @param {boolean} [asUint] */
export const resinfo = (dest, level, texture, asUint = false)=>
    op(OPCODE.RESINFO, [dest, level, texture], { control: asUint ? 2 : 0 });
/** @param {AsmOperand} dest @param {AsmOperand} level @param {AsmOperand} texture */
export const resinfoRcp = (dest, level, texture)=>
    op(OPCODE.RESINFO, [dest, level, texture], { control: 1 });

/** @param {AsmOperand} condition */
export const ifNz = condition=>op(OPCODE.IF, [condition], { nonZero: true, destinations: 0 });
/** @param {AsmOperand} condition */
export const ifZ = condition=>op(OPCODE.IF, [condition], { destinations: 0 });
export const elseBranch = ()=>op(OPCODE.ELSE, []);
export const endif = ()=>op(OPCODE.ENDIF, []);
export const loop = ()=>op(OPCODE.LOOP, []);
export const endloop = ()=>op(OPCODE.ENDLOOP, []);
export const breakOut = ()=>op(OPCODE.BREAK, []);
/** @param {AsmOperand} condition */
export const breakcNz = condition=>
    op(OPCODE.BREAKC, [condition], { nonZero: true, destinations: 0 });
/** @param {AsmOperand} condition */
export const discardNz = condition=>
    op(OPCODE.DISCARD, [condition], { nonZero: true, destinations: 0 });
export const ret = ()=>op(OPCODE.RET, []);
/** @param {number} index @returns {AsmOperand} */
const labelOperand = index=>({ type: OPERAND.LABEL, indices: [index] });
/** @param {number} index  Where subroutine `index` begins. */
export const label = index=>op(OPCODE.LABEL, [labelOperand(index)], { destinations: 0 });
/** @param {number} index */
export const call = index=>op(OPCODE.CALL, [labelOperand(index)], { destinations: 0 });
/** @param {number} index  Where function body `index` begins: `label fb#`. */
export const functionBody = index=>op(OPCODE.LABEL,
    [{ type: OPERAND.FUNCTION_BODY, indices: [index] }], { destinations: 0 });
/** @param {number} index */
export const dclFunctionBody = index=>op(OPCODE.DCL_FUNCTION_BODY, [], { extra: [index] });
/** @param {number} index @param {number[]} bodies  One for each call site. */
export const dclFunctionTable = (index, bodies)=>op(OPCODE.DCL_FUNCTION_TABLE, [],
    { extra: [index, bodies.length, ...bodies] });
/**
 * `dcl_interface fp#[size][sites] = { tables }`.
 *
 * @param {number} index @param {number} size @param {number} sites @param {number[]} tables
 */
export const dclInterface = (index, size, sites, tables)=>op(OPCODE.DCL_INTERFACE, [],
    { extra: [index, sites, ((size << 16) | tables.length) >>> 0, ...tables] });
/**
 * `fcall fp#[element][site]`.
 *
 * @param {number} site @param {number} pointer @param {number} element
 * @param {AsmOperand} [relative]  Added to the element.
 */
export const fcall = (site, pointer, element, relative)=>op(OPCODE.INTERFACE_CALL,
    [{ type: OPERAND.INTERFACE, indices: [pointer, element], ...(relative ? { relative } : {}) }],
    { destinations: 0, leading: [site] });
/** @param {number} index @param {string} [components] */
export const thisPointer = (index, components)=>
    register(OPERAND.THIS_POINTER, [index], components);
/** @param {AsmOperand} condition @param {number} index */
export const callcNz =(condition, index)=>op(OPCODE.CALLC, [condition, labelOperand(index)],
    { nonZero: true, destinations: 0 });
/** @param {AsmOperand} selector */
export const switchOn = selector=>op(OPCODE.SWITCH, [selector], { destinations: 0 });
/** @param {number} value */
export const caseOf = value=>op(OPCODE.CASE, [lu(value)], { destinations: 0 });
export const defaultCase = ()=>op(OPCODE.DEFAULT, []);
export const endswitch = ()=>op(OPCODE.ENDSWITCH, []);
/** @param {AsmOperand} condition */
export const retcNz = condition=>op(OPCODE.RETC, [condition], { nonZero: true, destinations: 0 });

/** @param {number} count */
export const dclTemps = count=>op(OPCODE.DCL_TEMPS, [], { extra: [count] });
/** @param {number} index @param {number} count */
export const dclIndexableTemp = (index, count)=>
    op(OPCODE.DCL_INDEXABLE_TEMP, [], { extra: [index, count, 4] });
/** @param {AsmOperand} input */
export const dclInput = input=>op(OPCODE.DCL_INPUT, [input]);
/** @param {AsmOperand} input @param {number} systemValue */
export const dclInputSiv = (input, systemValue)=>
    op(OPCODE.DCL_INPUT_SIV, [input], { extra: [systemValue] });
/** @param {AsmOperand} input @param {number} [interpolation] */
export const dclInputPs = (input, interpolation = 2)=>
    op(OPCODE.DCL_INPUT_PS, [input], { control: interpolation });
/** @param {AsmOperand} input @param {number} systemValue */
export const dclInputPsSiv = (input, systemValue)=>
    op(OPCODE.DCL_INPUT_PS_SIV, [input], { control: 2, extra: [systemValue] });
/** @param {AsmOperand} input @param {number} systemValue */
export const dclInputPsSgv = (input, systemValue)=>
    op(OPCODE.DCL_INPUT_PS_SGV, [input], { extra: [systemValue] });
/** @param {AsmOperand} output */
export const dclOutput = output=>op(OPCODE.DCL_OUTPUT, [output]);
/** @param {AsmOperand} output @param {number} systemValue */
export const dclOutputSiv = (output, systemValue)=>
    op(OPCODE.DCL_OUTPUT_SIV, [output], { extra: [systemValue] });
/** @param {number} slot @param {number} size in vec4s */
export const dclConstantBuffer = (slot, size)=>
    op(OPCODE.DCL_CONSTANT_BUFFER, [cb(slot, size)]);
/** @param {number} slot @param {number} dimension @param {number} returnType */
export const dclResource = (slot, dimension, returnType)=>op(OPCODE.DCL_RESOURCE, [t(slot)], {
    control: dimension,
    extra: [returnType | (returnType << 4) | (returnType << 8) | (returnType << 12)],
});
/** @param {number} slot @param {number} [mode] */
export const dclSampler = (slot, mode = 0)=>op(OPCODE.DCL_SAMPLER, [s(slot)], { control: mode });
/** @param {AsmOperand} first @param {number} count */
export const dclIndexRange = (first, count)=>
    op(OPCODE.DCL_INDEX_RANGE, [first], { extra: [count] });
/** @param {number} [flags]  D3D10_SB_GLOBAL_FLAGS: 1 refactoring allowed, 4 early depth tests. */
export const dclGlobalFlags = (flags = 1)=>op(OPCODE.DCL_GLOBAL_FLAGS, [], { control: flags });

/** @param {number[][]} rows */
export const immediateConstantBuffer = rows=>({ customData: rows.flat() });

// --- Shader Model 5 ---

/** @param {number} slot @param {string} [components] */
export const u = (slot, components)=>register(OPERAND.UNORDERED_ACCESS_VIEW, [slot], components);
/** @param {number} slot @param {string} [components] */
export const g = (slot, components)=>
    register(OPERAND.THREAD_GROUP_SHARED_MEMORY, [slot], components);
/** SV_DispatchThreadID. @param {string} [components] */
export const vThreadID = components=>register(OPERAND.INPUT_THREAD_ID, [], components);
/** SV_GroupIndex. @param {string} [components] */
export const vThreadIDInGroupFlattened = components=>
    register(OPERAND.INPUT_THREAD_ID_IN_GROUP_FLATTENED, [], components);
/** @param {number} x @param {number} y @param {number} z */
export const dclThreadGroup = (x, y, z)=>op(OPCODE.DCL_THREAD_GROUP, [], { extra: [x, y, z] });
// A hull shader's phases and what it declares of the stage: the counts and
// the tessellator's domain (1 isoline, 2 tri, 3 quad), partitioning (1
// integer, 2 pow2, 3 fractional odd, 4 fractional even) and output (1 point,
// 2 line, 3 triangle cw, 4 triangle ccw), as the token numbers them.
export const hsDecls = ()=>op(OPCODE.HS_DECLS, []);
export const hsControlPointPhase = ()=>op(OPCODE.HS_CONTROL_POINT_PHASE, []);
export const hsForkPhase = ()=>op(OPCODE.HS_FORK_PHASE, []);
export const hsJoinPhase = ()=>op(OPCODE.HS_JOIN_PHASE, []);
/** @param {number} count */
export const dclInputControlPointCount = count=>
    op(OPCODE.DCL_INPUT_CONTROL_POINT_COUNT, [], { control: count });
/** @param {number} count */
export const dclOutputControlPointCount = count=>
    op(OPCODE.DCL_OUTPUT_CONTROL_POINT_COUNT, [], { control: count });
/** @param {number} domain */
export const dclTessDomain = domain=>op(OPCODE.DCL_TESS_DOMAIN, [], { control: domain });
/** @param {number} partitioning */
export const dclTessPartitioning = partitioning=>
    op(OPCODE.DCL_TESS_PARTITIONING, [], { control: partitioning });
/** @param {number} output */
export const dclTessOutputPrimitive = output=>
    op(OPCODE.DCL_TESS_OUTPUT_PRIMITIVE, [], { control: output });
// A geometry shader's: its input primitive (1 point, 2 line, 3 triangle, 6 line
// with adjacency, 7 triangle with adjacency), output topology (1 point list, 3
// line strip, 5 triangle strip), vertices it may emit, and its vertices.
/** @param {number} primitive */
export const dclGsInputPrimitive = primitive=>
    op(OPCODE.DCL_GS_INPUT_PRIMITIVE, [], { control: primitive });
/** @param {number} topology */
export const dclGsOutputTopology = topology=>
    op(OPCODE.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY, [], { control: topology });
/** @param {number} count */
export const dclMaxOutputVertexCount = count=>
    op(OPCODE.DCL_MAX_OUTPUT_VERTEX_COUNT, [], { extra: [count] });
/** A geometry shader's input: a register of one vertex of its primitive.
 *  @param {number} vertex @param {number} index @param {string} [components] */
export const vgs = (vertex, index, components)=>
    register(OPERAND.INPUT, [vertex, index], components);
export const emit = ()=>op(OPCODE.EMIT, []);
export const cut = ()=>op(OPCODE.CUT, []);
/** @param {number} count */
export const dclHsForkPhaseInstanceCount = count=>
    op(OPCODE.DCL_HS_FORK_PHASE_INSTANCE_COUNT, [], { extra: [count] });
/** @param {number} slot */
export const dclUavRaw = slot=>op(OPCODE.DCL_UAV_RAW, [u(slot)]);
/** @param {number} slot @param {number} stride @param {boolean} [counter] */
export const dclUavStructured = (slot, stride, counter = false)=>op(OPCODE.DCL_UAV_STRUCTURED,
    [u(slot)], { extra: [stride], control: counter ? 1 << 12 : 0 });
/** @param {number} slot @param {number} dimension @param {number} returnType */
export const dclUavTyped = (slot, dimension, returnType)=>op(OPCODE.DCL_UAV_TYPED, [u(slot)], {
    control: dimension,
    extra: [returnType | (returnType << 4) | (returnType << 8) | (returnType << 12)],
});
/** @param {number} slot @param {number} bytes */
export const dclTgsmRaw = (slot, bytes)=>op(OPCODE.DCL_TGSM_RAW, [g(slot)], { extra: [bytes] });
/** @param {number} slot */
export const dclResourceRaw = slot=>op(OPCODE.DCL_RESOURCE_RAW, [t(slot)]);
/** @param {number} slot @param {number} stride */
export const dclResourceStructured = (slot, stride)=>
    op(OPCODE.DCL_RESOURCE_STRUCTURED, [t(slot)], { extra: [stride] });
/** @param {AsmOperand} dest @param {AsmOperand} address @param {AsmOperand} memory */
export const ldRaw = (dest, address, memory)=>op(OPCODE.LD_RAW, [dest, address, memory]);
/** @param {AsmOperand} memory @param {AsmOperand} address @param {AsmOperand} value */
export const storeRaw = (memory, address, value)=>op(OPCODE.STORE_RAW, [memory, address, value]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} index @param {AsmOperand} offset
 * @param {AsmOperand} memory
 */
export const ldStructured = (dest, index, offset, memory)=>
    op(OPCODE.LD_STRUCTURED, [dest, index, offset, memory]);
/**
 * @param {AsmOperand} memory @param {AsmOperand} index @param {AsmOperand} offset
 * @param {AsmOperand} value
 */
export const storeStructured = (memory, index, offset, value)=>
    op(OPCODE.STORE_STRUCTURED, [memory, index, offset, value]);
/** @param {AsmOperand} memory @param {AsmOperand} address @param {AsmOperand} value */
export const storeUavTyped = (memory, address, value)=>
    op(OPCODE.STORE_UAV_TYPED, [memory, address, value]);
/** @param {AsmOperand} dest @param {AsmOperand} address @param {AsmOperand} memory */
export const ldUavTyped = (dest, address, memory)=>
    op(OPCODE.LD_UAV_TYPED, [dest, address, memory]);
/** @param {AsmOperand} memory @param {AsmOperand} address @param {AsmOperand} value */
export const atomicIadd = (memory, address, value)=>
    op(OPCODE.ATOMIC_IADD, [memory, address, value]);
/**
 * @param {AsmOperand} dest @param {AsmOperand} memory @param {AsmOperand} address
 * @param {AsmOperand} value
 */
export const immAtomicImax = (dest, memory, address, value)=>
    op(OPCODE.IMM_ATOMIC_IMAX, [dest, memory, address, value], { destinations: 2 });
/** @param {AsmOperand} dest @param {AsmOperand} memory */
export const immAtomicAlloc = (dest, memory)=>
    op(OPCODE.IMM_ATOMIC_ALLOC, [dest, memory], { destinations: 2 });
/** @param {number} flags */
export const sync = flags=>op(OPCODE.SYNC, [], { control: flags, destinations: 0 });
/** @param {AsmOperand} dest @param {AsmOperand} memory */
export const bufinfo = (dest, memory)=>op(OPCODE.BUFINFO, [dest, memory]);

// --- the container ---

/**
 * @typedef {Object} AsmSignatureElement
 * @property {string} name
 * @property {number} [index]
 * @property {number} [systemValue]
 * @property {number} [componentType]
 * @property {number} register
 * @property {number} [mask]
 * @property {number} [readWriteMask]
 */

/**
 * @param {AsmSignatureElement[]} elements
 * @param {number} readWriteDefault  Read mask for an input; for an output, the
 *     components left *unwritten*, which is why a fully written one says zero.
 * @returns {Uint8Array}
 */
function encodeSignature(elements, readWriteDefault){
    const rows = 8 + elements.length * 24;
    /** @type {number[]} */
    const names = [];
    let namesLength = 0;
    for (const element of elements)
    {
        names.push(rows + namesLength);
        namesLength += element.name.length + 1;
    }
    const total = (rows + namesLength + 3) & ~3;
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, elements.length, true);
    view.setUint32(4, 8, true);
    elements.forEach((element, index)=>{
        const at = 8 + index * 24;
        view.setUint32(at, names[index], true);
        view.setUint32(at + 4, element.index ?? 0, true);
        view.setUint32(at + 8, element.systemValue ?? SYSTEM_VALUE.UNDEFINED, true);
        view.setUint32(at + 12, element.componentType ?? COMPONENT_TYPE.FLOAT, true);
        view.setUint32(at + 16, element.register, true);
        view.setUint32(at + 20,
            (element.mask ?? 0xf) | ((element.readWriteMask ?? readWriteDefault) << 8), true);
        for (let char = 0; char < element.name.length; char++)
        {
            bytes[names[index] + char] = element.name.charCodeAt(char);
        }
    });
    return bytes;
}

/**
 * @param {number} kind
 * @param {(AsmInstruction | { customData: number[] })[]} instructions
 * @returns {Uint8Array}
 */
function encodeProgram(kind, instructions, major = 4){
    /** @type {number[]} */
    const words = [];
    for (const instruction of instructions)
    {
        if ('customData' in instruction)
        {
            const payload = instruction.customData;
            words.push((OPCODE.CUSTOMDATA | (3 << 11)) >>> 0, payload.length + 2, ...payload);
            continue;
        }
        words.push(...encodeInstruction(instruction));
    }
    const bytes = new Uint8Array((words.length + 2) * 4);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, ((kind << 16) | (major << 4)) >>> 0, true);
    view.setUint32(4, words.length + 2, true);
    words.forEach((word, index)=>view.setUint32(8 + index * 4, word, true));
    return bytes;
}

/**
 * @param {{ name: string, bytes: Uint8Array }[]} chunks
 * @returns {Uint8Array}
 */
export function container(chunks){
    const headerSize = 32 + chunks.length * 4;
    let total = headerSize;
    /** @type {number[]} */
    const offsets = [];
    for (const chunk of chunks)
    {
        offsets.push(total);
        total += 8 + chunk.bytes.length;
    }
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    bytes.set([0x44, 0x58, 0x42, 0x43], 0);
    view.setUint32(20, 1, true);
    view.setUint32(24, total, true);
    view.setUint32(28, chunks.length, true);
    chunks.forEach((chunk, index)=>{
        const at = offsets[index];
        view.setUint32(32 + index * 4, at, true);
        for (let char = 0; char < 4; char++)
        {
            bytes[at + char] = chunk.name.charCodeAt(char);
        }
        view.setUint32(at + 4, chunk.bytes.length, true);
        bytes.set(chunk.bytes, at + 8);
    });
    return bytes;
}

/**
 * @typedef {Object} AsmShader
 * @property {number} kind
 * @property {AsmSignatureElement[]} [inputs]
 * @property {AsmSignatureElement[]} [outputs]
 * @property {AsmSignatureElement[]} [patchConstants]  A hull or domain shader's PCSG.
 * @property {(AsmInstruction | { customData: number[] })[]} instructions
 * @property {number} [major]  The shader model: 4, or 5 for what only 5 has.
 */

/**
 * @param {AsmShader} shader
 * @returns {Uint8Array} a DXBC container
 */
export function assemble(shader){
    return container([
        { name: 'ISGN', bytes: encodeSignature(shader.inputs ?? [], 0xf) },
        { name: 'OSGN', bytes: encodeSignature(shader.outputs ?? [], 0) },
        ...(shader.patchConstants
            ? [{ name: 'PCSG', bytes: encodeSignature(shader.patchConstants, 0) }] : []),
        { name: shader.major === 5 ? 'SHEX' : 'SHDR',
            bytes: encodeProgram(shader.kind, shader.instructions, shader.major) },
    ]);
}

// --- the programs the render tests draw with ---

/** The position element of an input signature, at register zero. */
export const POSITION_IN = Object.freeze({ name: 'POSITION', register: 0 });

/**
 * A vertex shader that passes its position straight through, and a pixel
 * shader that paints one colour.
 */
export function passThroughVertexShader(){
    return assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [POSITION_IN],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [
            dclInput(v(0)),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            mov(o(0), v(0)),
            ret(),
        ],
    });
}

/**
 * A geometry shader that passes each triangle on as a strip of its three
 * vertices: SV_POSITION in and out.
 */
export function triangleGeometryShader(){
    const position = { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 };
    return assemble({
        kind: SHADER_KIND.GEOMETRY,
        inputs: [position],
        outputs: [position],
        instructions: [
            dclGsInputPrimitive(3),
            dclGsOutputTopology(5),
            dclMaxOutputVertexCount(3),
            dclInputSiv(vgs(3, 0), SYSTEM_VALUE.POSITION),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            mov(o(0), vgs(0, 0)), emit(),
            mov(o(0), vgs(1, 0)), emit(),
            mov(o(0), vgs(2, 0)), emit(),
            cut(),
            ret(),
        ],
    });
}

/** @param {number[]} rgba */
export function solidPixelShader(rgba){
    return assemble({
        kind: SHADER_KIND.PIXEL,
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [
            dclOutput(o(0)),
            mov(o(0), l(...rgba)),
            ret(),
        ],
    });
}

/**
 * A vertex shader that carries a colour beside the position, and a pixel
 * shader that paints it.
 */
export function colouredVertexShader(){
    return assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [POSITION_IN, { name: 'COLOR', register: 1 }],
        outputs: [
            { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'COLOR', register: 1 },
        ],
        instructions: [
            dclInput(v(0)),
            dclInput(v(1)),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutput(o(1)),
            mov(o(0), v(0)),
            mov(o(1), v(1)),
            ret(),
        ],
    });
}

export function colouredPixelShader(){
    return assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [
            { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'COLOR', register: 1 },
        ],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [
            dclInputPs(v(1)),
            dclOutput(o(0)),
            mov(o(0), v(1)),
            ret(),
        ],
    });
}

// --- what a compiler records beside the program ---

/**
 * @typedef {Object} FixtureBinding
 * @property {string} name
 * @property {number} type
 * @property {number} [returnType]
 * @property {number} [dimension]
 * @property {number} [samples]
 * @property {number} bindPoint
 * @property {number} [bindCount]
 * @property {number} [flags]
 */

/**
 * @typedef {Object} FixtureType
 * @property {number} class
 * @property {number} type
 * @property {number} [rows]
 * @property {number} [columns]
 * @property {number} [elements]
 * @property {{ name: string, offset: number, type: FixtureType }[]} [members]
 */

/**
 * @typedef {Object} FixtureVariable
 * @property {string} name
 * @property {number} offset
 * @property {number} size
 * @property {number} [flags]
 * @property {number[]} [defaultValue]  Dwords.
 * @property {FixtureType} type
 */

/**
 * @typedef {Object} FixtureBuffer
 * @property {string} name
 * @property {number | FixtureVariable[]} variables  A count alone lays out no entries.
 * @property {number} size
 * @property {number} [flags]
 * @property {number} [type]
 */

/**
 * A resource-definition chunk laid out as a compiler lays it out: seven
 * dwords of header (constant buffer count and offset, binding count and
 * offset, target, flags, creator offset), the bindings at 32 bytes, the
 * constant buffers at 24, their variables at 24, the types at 16 and the
 * structures' members at 12, default values, then the strings. A type used
 * twice is laid out once, as a compiler shares one. `model5` adds the header
 * a Shader Model 5 compiler writes, tagged RD11, and lengthens variables to
 * 40 bytes and types to 36, the added fields zero.
 *
 * @param {{ buffers?: FixtureBuffer[], bindings?: FixtureBinding[], target: number,
 *           flags: number, creator?: string, model5?: boolean }} spec
 * @returns {Uint8Array}
 */
export function resourceDefinitions(spec){
    const buffers = spec.buffers ?? [];
    const bindings = spec.bindings ?? [];
    const sizes = spec.model5 ? { variable: 40, type: 36 } : { variable: 24, type: 16 };
    /** @param {FixtureBuffer} buffer */
    const listOf = buffer=>(Array.isArray(buffer.variables) ? buffer.variables : []);
    const bindingsAt = spec.model5 ? 60 : 28;
    const buffersAt = bindingsAt + bindings.length * 32;
    let at = buffersAt + buffers.length * 24;
    const variablesAt = buffers.map(buffer=>{
        const here = listOf(buffer).length ? at : 0;
        at += listOf(buffer).length * sizes.variable;
        return here;
    });
    /** @type {FixtureType[]} */
    const types = [];
    /** @param {FixtureType} type */
    const visit = type=>{
        if (!types.includes(type))
        {
            types.push(type);
            (type.members ?? []).forEach(member=>visit(member.type));
        }
    };
    buffers.forEach(buffer=>listOf(buffer).forEach(variable=>visit(variable.type)));
    const typesAt = at;
    at += types.length * sizes.type;
    const membersAt = types.map(type=>{
        const count = (type.members ?? []).length;
        const here = count ? at : 0;
        at += count * 12;
        return here;
    });
    /** @type {Map<FixtureVariable, number>} */
    const defaults = new Map();
    for (const variable of buffers.flatMap(listOf))
    {
        if (variable.defaultValue)
        {
            defaults.set(variable, at);
            at += variable.defaultValue.length * 4;
        }
    }

    let stringsAt = at;
    /** @type {Map<string, number>} */
    const strings = new Map();
    /** @param {string} text */
    const stringAt = text=>{
        if (!strings.has(text))
        {
            strings.set(text, stringsAt);
            stringsAt += text.length + 1;
        }
        return /** @type {number} */ (strings.get(text));
    };
    /** @param {FixtureType} type */
    const typeAt = type=>typesAt + types.indexOf(type) * sizes.type;
    /** @type {number[]} */
    const bytes = [];
    /** @param {number[]} words */
    const put = words=>{
        for (const word of words)
        {
            bytes.push(word & 0xff, word >>> 8 & 0xff, word >>> 16 & 0xff, word >>> 24 & 0xff);
        }
    };
    /** @param {number} count */
    const zeros = count=>put(new Array(count / 4).fill(0));

    const creator = spec.creator === undefined ? 0 : stringAt(spec.creator);
    put([buffers.length, buffers.length ? buffersAt : 0, bindings.length, bindingsAt, spec.target,
        spec.flags, creator]);
    if (spec.model5)
    {
        put([0x31314452, 60, 24, 32, sizes.variable, sizes.type, 12, 0]);
    }
    for (const entry of bindings)
    {
        put([stringAt(entry.name), entry.type, entry.returnType ?? 0, entry.dimension ?? 0,
            entry.samples ?? 0, entry.bindPoint, entry.bindCount ?? 1, entry.flags ?? 0]);
    }
    buffers.forEach((buffer, index)=>{
        put([stringAt(buffer.name), listOf(buffer).length || Number(buffer.variables),
            variablesAt[index], buffer.size, buffer.flags ?? 0, buffer.type ?? 0]);
    });
    for (const variable of buffers.flatMap(listOf))
    {
        put([stringAt(variable.name), variable.offset, variable.size, variable.flags ?? 0,
            typeAt(variable.type), defaults.get(variable) ?? 0]);
        zeros(sizes.variable - 24);
    }
    types.forEach((type, index)=>{
        put([type.class | (type.type << 16), (type.rows ?? 1) | ((type.columns ?? 1) << 16),
            (type.elements ?? 0) | ((type.members ?? []).length << 16), membersAt[index]]);
        zeros(sizes.type - 16);
    });
    for (const member of types.flatMap(type=>type.members ?? []))
    {
        put([stringAt(member.name), typeAt(member.type), member.offset]);
    }
    for (const words of defaults.keys())
    {
        put(/** @type {number[]} */ (words.defaultValue));
    }
    for (const text of strings.keys())
    {
        bytes.push(...[...text].map(char=>char.charCodeAt(0)), 0);
    }
    while (bytes.length % 4 !== 0)
    {
        bytes.push(0xab);
    }
    return Uint8Array.from(bytes);
}

/**
 * A compiled program's own chunks with the tools' chunks put back around
 * them.
 *
 * @param {Uint8Array} program  A container from the assembler.
 * @param {{ name: string, bytes: Uint8Array }[]} before
 * @param {{ name: string, bytes: Uint8Array }[]} [after]
 */
export function withChunks(program, before, after = []){
    const parsed = parseDxbc(program);
    if (!parsed)
    {
        throw new Error('not a container');
    }
    const own = ['ISGN', 'OSGN', 'SHDR'].map(name=>({
        name, bytes: /** @type {Uint8Array} */ (parsed.chunks.get(name)),
    }));
    return container([...before, ...own, ...after]);
}

/** D3D10_SHADER_VARIABLE_CLASS and D3D10_SHADER_VARIABLE_TYPE, as far as the tests go. */
export const SVC = Object.freeze({ SCALAR: 0, STRUCT: 5 });
export const SVT = Object.freeze({ VOID: 0, BOOL: 1, INT: 2, FLOAT: 3 });

/**
 * The constant buffers of the ps_4_0 program in Wine's d3dcompiler
 * test_reflection_constant_buffer: a structure in $Globals, and in c1 a
 * float, an array of two, an int and a structure of two floats, whose members
 * share one type as that compiler laid them out.
 *
 * @returns {FixtureBuffer[]}
 */
function wineConstantBuffers(){
    const float = { class: SVC.SCALAR, type: SVT.FLOAT };
    const flag = { class: SVC.SCALAR, type: SVT.BOOL };
    return [
        { name: '$Globals', size: 16, variables: [
            { name: 'g_Test', offset: 0, size: 4, flags: 2, type: { class: SVC.STRUCT,
                type: SVT.VOID, members: [{ name: 'm_on', offset: 0, type: flag }] } },
        ] },
        { name: 'c1', size: 64, variables: [
            { name: 'a', offset: 0, size: 4, type: { class: SVC.SCALAR, type: SVT.FLOAT } },
            { name: 'b', offset: 16, size: 20,
                type: { class: SVC.SCALAR, type: SVT.FLOAT, elements: 2 } },
            { name: 'i', offset: 36, size: 4, type: { class: SVC.SCALAR, type: SVT.INT } },
            { name: 't', offset: 48, size: 8, flags: 2, type: { class: SVC.STRUCT,
                type: SVT.VOID, columns: 2, members: [
                    { name: 'a', offset: 0, type: float }, { name: 'b', offset: 4, type: float },
                ] } },
        ] },
    ];
}

/** That program's pixel shader with those buffers recorded beside it. */
export const constantBufferShader = ()=>withChunks(solidPixelShader([0, 0, 0, 1]), [{
    name: 'RDEF',
    bytes: resourceDefinitions({
        target: 0xffff0400, flags: 0x100, buffers: wineConstantBuffers(),
    }),
}]);

/**
 * A row of the immediate constant buffer, indexed by a register's component.
 *
 * @param {AsmOperand} relative  one component selected
 * @param {string} [components]
 * @returns {AsmOperand}
 */
export const icbAt = (relative, components)=>({
    ...register(OPERAND.IMMEDIATE_CONSTANT_BUFFER, [0], components), relative });

/**
 * A hull shader of a quad domain, written as fxc writes the one of Wine's
 * and vkd3d's tessellation tests whose patch-constant function loops: one
 * input control point; a control point phase that places four output points
 * about it from an immediate constant buffer, by vOutputControlPointID; two
 * instanced fork phases that write the edge and inside factors (1.0) through
 * a register index; and a fork phase that writes the four output points'
 * mean (CENTER) from the output control points. Integer partitioning,
 * clockwise triangles.
 *
 * @returns {Uint8Array}
 */
export function forkPhaseHullShader(){
    const corners = [[0, 0, 0, 1], [0, 2, 0, 1], [2, 0, 0, 1], [2, 2, 0, 1]]
        .map(row=>row.map(floatBits));
    return assemble({
        kind: SHADER_KIND.HULL,
        major: 5,
        inputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        outputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        patchConstants: [
            ...[0, 1, 2, 3].map(index=>({ name: 'SV_TessFactor', index,
                systemValue: SYSTEM_VALUE.QUAD_EDGE_TESSFACTOR, register: index, mask: 1 })),
            ...[0, 1].map(index=>({ name: 'SV_InsideTessFactor', index,
                systemValue: SYSTEM_VALUE.QUAD_INSIDE_TESSFACTOR, register: 4 + index, mask: 1 })),
            { name: 'CENTER', register: 6, mask: 7 },
        ],
        instructions: [
            hsDecls(),
            dclInputControlPointCount(1),
            dclOutputControlPointCount(4),
            dclTessDomain(3),
            dclTessPartitioning(1),
            dclTessOutputPrimitive(3),
            hsControlPointPhase(),
            dclOutput(o(0)),
            dclTemps(1),
            immediateConstantBuffer(corners),
            mov(r(0, 'x'), vOutputControlPointID('x')),
            add(o(0), vicp(0, 0), icbAt(r(0, 'x'))),
            ret(),
            hsForkPhase(),
            dclHsForkPhaseInstanceCount(4),
            dclTemps(1),
            mov(r(0, 'x'), vForkInstanceID('x')),
            mov(indexedBy(o(0, 'x'), r(0, 'x')), l(1)),
            ret(),
            hsForkPhase(),
            dclHsForkPhaseInstanceCount(2),
            dclTemps(1),
            mov(r(0, 'x'), vForkInstanceID('x')),
            mov(indexedBy(o(4, 'x'), r(0, 'x')), l(1)),
            ret(),
            hsForkPhase(),
            dclTemps(1),
            add(r(0, 'xyz'), vocp(0, 0, 'xyz'), vocp(1, 0, 'xyz')),
            add(r(0, 'xyz'), r(0, 'xyz'), vocp(2, 0, 'xyz')),
            add(r(0, 'xyz'), r(0, 'xyz'), vocp(3, 0, 'xyz')),
            mul(o(6, 'xyz'), r(0, 'xyz'), l(0.25, 0.25, 0.25, 0.25)),
            ret(),
        ],
    });
}

/** A quad's tess factors, as a quad hull shader writes them and its domain shader reads them. */
const QUAD_FACTORS = Object.freeze([
    ...[0, 1, 2, 3].map(index=>({ name: 'SV_TessFactor', index,
        systemValue: SYSTEM_VALUE.QUAD_EDGE_TESSFACTOR, register: index, mask: 1 })),
    ...[0, 1].map(index=>({ name: 'SV_InsideTessFactor', index,
        systemValue: SYSTEM_VALUE.QUAD_INSIDE_TESSFACTOR, register: 4 + index, mask: 1 })),
]);

/**
 * A hull shader that makes a quad patch of one input point: four corners at
 * the point plus `corners` (in the order of the domain's u, v: (0, 0),
 * (0, 1), (1, 0), (1, 1)), every factor `factor`, the given partitioning and
 * output primitive as the declarations number them (one past Direct3D's).
 *
 * @param {{ factor?: number, partitioning?: number, output?: number,
 *     corners?: number[][] }} [options]
 */
export function quadHullShader(options = {}){
    const corners = (options.corners ?? [[0, 0], [0, 2], [2, 0], [2, 2]])
        .map(([x, y])=>[x, y, 0, 0].map(floatBits));
    return assemble({
        kind: SHADER_KIND.HULL,
        major: 5,
        inputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        outputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        patchConstants: [...QUAD_FACTORS],
        instructions: [
            hsDecls(),
            dclInputControlPointCount(1),
            dclOutputControlPointCount(4),
            dclTessDomain(3),
            dclTessPartitioning(options.partitioning ?? 1),
            dclTessOutputPrimitive(options.output ?? 3),
            hsControlPointPhase(),
            dclOutput(o(0)),
            dclTemps(1),
            immediateConstantBuffer(corners),
            mov(r(0, 'x'), vOutputControlPointID('x')),
            add(o(0), vicp(0, 0), icbAt(r(0, 'x'))),
            ret(),
            hsForkPhase(),
            dclHsForkPhaseInstanceCount(6),
            dclTemps(1),
            mov(r(0, 'x'), vForkInstanceID('x')),
            mov(indexedBy(o(0, 'x'), r(0, 'x')), l(options.factor ?? 1)),
            ret(),
        ],
    });
}

/**
 * A domain shader over `quadHullShader`'s patches: the position the domain
 * point makes of the corners (point 0, plus u along point 2, plus v along
 * point 1), and a colour of u, v, the primitive's id and 1.
 */
export function quadDomainShader(){
    return assemble({
        kind: SHADER_KIND.DOMAIN,
        major: 5,
        inputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        patchConstants: [...QUAD_FACTORS],
        outputs: [
            { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'COLOR', register: 1 },
        ],
        instructions: [
            dclTessDomain(3),
            dclInput(vDomain('xy')),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutput(o(1)),
            dclTemps(1),
            add(r(0, 'x'), vicp(2, 0, 'x'), modified(vicp(0, 0, 'x'), MODIFIER.NEG)),
            add(r(0, 'y'), vicp(1, 0, 'y'), modified(vicp(0, 0, 'y'), MODIFIER.NEG)),
            mad(o(0, 'xy'), r(0, 'xy'), vDomain('xy'), vicp(0, 0, 'xy')),
            mov(o(0, 'zw'), l(0, 0, 0, 1)),
            mov(o(1, 'xy'), vDomain('xy')),
            utof(o(1, 'z'), vPrim('x')),
            mov(o(1, 'w'), l(1)),
            ret(),
        ],
    });
}

/**
 * A hull shader that passes four input points through as a quad patch (no
 * control point phase), its six factors `factors` (four edges, two inside),
 * integer partitioning and the given output primitive as the declaration
 * numbers it: 3 triangles clockwise, 4 counter-clockwise.
 *
 * @param {{ factors: number[], output: number }} options
 */
export function passQuadHullShader(options){
    return assemble({
        kind: SHADER_KIND.HULL,
        major: 5,
        inputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        outputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        patchConstants: [...QUAD_FACTORS],
        instructions: [
            hsDecls(),
            dclInputControlPointCount(4),
            dclOutputControlPointCount(4),
            dclTessDomain(3),
            dclTessPartitioning(1),
            dclTessOutputPrimitive(options.output),
            hsForkPhase(),
            dclHsForkPhaseInstanceCount(6),
            dclTemps(1),
            immediateConstantBuffer(options.factors.map(factor=>[floatBits(factor), 0, 0, 0])),
            mov(r(0, 'x'), vForkInstanceID('x')),
            mov(indexedBy(o(0, 'x'), r(0, 'x')), icbAt(r(0, 'x'), 'x')),
            ret(),
        ],
    });
}

/**
 * A domain shader that places a quad's point as Wine's quad tessellation
 * test does: lerp(lerp(p0, p1, u), lerp(p2, p3, u), v), and paints it green.
 */
export function lerpQuadDomainShader(){
    return assemble({
        kind: SHADER_KIND.DOMAIN,
        major: 5,
        inputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        patchConstants: [...QUAD_FACTORS],
        outputs: [
            { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'COLOR', register: 1 },
        ],
        instructions: [
            dclTessDomain(3),
            dclInput(vDomain('xy')),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutput(o(1)),
            dclTemps(2),
            add(r(0), vicp(1, 0), modified(vicp(0, 0), MODIFIER.NEG)),
            mad(r(0), vDomain('xxxx'), r(0), vicp(0, 0)),
            add(r(1), vicp(3, 0), modified(vicp(2, 0), MODIFIER.NEG)),
            mad(r(1), vDomain('xxxx'), r(1), vicp(2, 0)),
            add(r(1), r(1), modified(r(0), MODIFIER.NEG)),
            mad(o(0), vDomain('yyyy'), r(1), r(0)),
            mov(o(1), l(0, 1, 0, 1)),
            ret(),
        ],
    });
}

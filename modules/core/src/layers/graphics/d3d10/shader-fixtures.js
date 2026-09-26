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
import { OPCODE, OPERAND, SELECTION } from './sm4.js';

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
/** @param {number} slot @param {number} index @param {string} [components] */
export const cb = (slot, index, components)=>
    register(OPERAND.CONSTANT_BUFFER, [slot, index], components);
/** @param {number} slot @param {string} [components] */
export const t = (slot, components)=>register(OPERAND.RESOURCE, [slot], components);
/** @param {number} slot */
export const s = slot=>({ type: OPERAND.SAMPLER, indices: [slot] });
export const nullDest = ()=>({ type: OPERAND.NULL, indices: [] });
export const oDepth = ()=>({ type: OPERAND.OUTPUT_DEPTH, indices: [] });

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

/** @param {AsmOperand} operand @param {boolean} destination */
function encodeOperand(operand, destination){
    /** @type {number[]} */
    const words = [];
    const isImmediate = operand.type === OPERAND.IMMEDIATE32;
    let token = 0;
    if (isImmediate)
    {
        const count = /** @type {number[]} */ (operand.immediate).length;
        token |= count === 1 ? 1 : 2;
    }
    else if (operand.type === OPERAND.NULL || operand.type === OPERAND.SAMPLER
        || operand.type === OPERAND.LABEL)
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
 * @property {number} [control]        Bits 11..23 of the opcode token.
 * @property {boolean} [saturate]
 * @property {boolean} [nonZero]
 * @property {number} [destinations]   How many leading operands are destinations; one by default.
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
    token |= (words.length + 1) << 24;
    return [token >>> 0, ...words];
}

// --- the instructions, as a test spells them ---

/** @param {number} opcode @param {AsmOperand[]} operands @param {Partial<AsmInstruction>} [more] */
const op = (opcode, operands, more = {})=>({ opcode, operands, ...more });

/** @param {number} opcode */
const arithmetic = opcode=>
    (/** @type {AsmOperand} */ dest, /** @type {AsmOperand[]} */ ...sources)=>
        op(opcode, [dest, ...sources]);

export const mov = arithmetic(OPCODE.MOV);
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
/** @param {AsmOperand} condition @param {number} index */
export const callcNz = (condition, index)=>op(OPCODE.CALLC, [condition, labelOperand(index)],
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
export const dclGlobalFlags = ()=>op(OPCODE.DCL_GLOBAL_FLAGS, [], { control: 1 });

/** @param {number[][]} rows */
export const immediateConstantBuffer = rows=>({ customData: rows.flat() });

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
function encodeProgram(kind, instructions){
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
    view.setUint32(0, ((kind << 16) | (4 << 4)) >>> 0, true);
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
 * @property {(AsmInstruction | { customData: number[] })[]} instructions
 */

/**
 * @param {AsmShader} shader
 * @returns {Uint8Array} a DXBC container
 */
export function assemble(shader){
    return container([
        { name: 'ISGN', bytes: encodeSignature(shader.inputs ?? [], 0xf) },
        { name: 'OSGN', bytes: encodeSignature(shader.outputs ?? [], 0) },
        { name: 'SHDR', bytes: encodeProgram(shader.kind, shader.instructions) },
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

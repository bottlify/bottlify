/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The expressions an fx_4 effect computes when a pass is applied: a state's
 * value (`SetBlendState(NULL, -g_var + 0.1f, 0)`) or the index into an array
 * a pass picks from (`SetPixelShader(ps_array[g_var.z])`).
 *
 * fxc writes each as a container of its own with three chunks: CTAB, the
 * effect variables the expression reads and the registers they are read
 * into (Direct3D 9's constant table); CLI4, its literals, 32-bit floats; and
 * FXLC, its instructions. An instruction is a token (the operation in bits
 * 20-30, the components it runs over in the low bits, and bit 31 when its
 * first input is one component for all of them), the count of its inputs,
 * and that many operands and one more for the result, each three words: a
 * relative index (zero, none), the table and the component offset in it.
 * The tables are the literals (1), the inputs (2), the result (4) and the
 * temporaries (7). The operations were read off fxc's output for each HLSL
 * operator, and their results are what Windows answers (Wine's d3d10
 * test_effect_value_expression and test_effect_index_expression).
 *
 * Values are 32-bit words: what an operation reads them as (float, int or
 * uint) is the operation's.
 */

import { parseDxbc } from './dxbc.js';

/** The tables an operand names. */
const TABLE = Object.freeze({ LITERAL: 1, INPUT: 2, RESULT: 4, TEMPORARY: 7 });

/**
 * @typedef {Object} Operand
 * @property {number} table
 * @property {number} offset  In components.
 */

/**
 * @typedef {Object} Instruction
 * @property {number} op
 * @property {number} count     Components it runs over.
 * @property {boolean} scalar   Its first input is one component for all.
 * @property {Operand[]} inputs
 * @property {Operand} output
 */

/**
 * @typedef {Object} Expression
 * @property {Instruction[]} code
 * @property {Uint32Array} literals  As words.
 * @property {{ name: string, register: number, registers: number }[]} inputs
 *     The effect variables read, each into four components a register from
 *     `register`.
 */

/** A reason the bytes are not an expression this runtime reads. */
export class NotAnExpression extends Error {}

/**
 * @param {Uint8Array} bytes  The container fxc wrote.
 * @returns {Expression}
 */
export function parseExpression(bytes){
    const container = parseDxbc(bytes);
    const code = container?.chunks.get('FXLC');
    if (!code)
    {
        throw new NotAnExpression('an expression with no FXLC chunk');
    }
    const view = (/** @type {Uint8Array} */ chunk)=>new DataView(chunk.buffer, chunk.byteOffset,
        chunk.byteLength);

    const literalChunk = container?.chunks.get('CLI4');
    /** @type {number[]} */
    const literalWords = [];
    if (literalChunk && literalChunk.length >= 4)
    {
        const words = view(literalChunk);
        const count = words.getUint32(0, true);
        for (let index = 0; index < count && 8 + index * 4 <= literalChunk.length; index++)
        {
            literalWords.push(words.getUint32(4 + index * 4, true));
        }
    }

    /** @type {Expression['inputs']} */
    const inputs = [];
    const table = container?.chunks.get('CTAB');
    if (table && table.length >= 28)
    {
        const words = view(table);
        const count = words.getUint32(12, true);
        const infoAt = words.getUint32(16, true);
        for (let index = 0; index < count; index++)
        {
            const at = infoAt + index * 20;
            if (at + 20 > table.length)
            {
                throw new NotAnExpression('a constant table cut short');
            }
            const nameAt = words.getUint32(at, true);
            let end = nameAt;
            while (end < table.length && table[end] !== 0)
            {
                end++;
            }
            inputs.push({
                name: String.fromCharCode(...table.subarray(nameAt, end)),
                register: words.getUint16(at + 6, true),
                registers: words.getUint16(at + 8, true),
            });
        }
    }

    const words = view(code);
    let at = 0;
    const next = ()=>{
        if (at + 4 > code.length)
        {
            throw new NotAnExpression('instructions cut short');
        }
        const value = words.getUint32(at, true);
        at += 4;
        return value;
    };
    /** @returns {Operand} */
    const operand = ()=>{
        if (next() !== 0)
        {
            throw new NotAnExpression('an operand indexed by a register');
        }
        return { table: next(), offset: next() };
    };
    /** @type {Instruction[]} */
    const instructions = [];
    const total = next();
    for (let index = 0; index < total; index++)
    {
        const token = next();
        const inputCount = next();
        const ins = Array.from({ length: inputCount }, operand);
        instructions.push({
            op: (token >>> 20) & 0x7ff,
            count: token & 0xffff,
            scalar: (token & 0x80000000) !== 0,
            inputs: ins,
            output: operand(),
        });
    }
    return { code: instructions, literals: Uint32Array.from(literalWords), inputs };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const i32 = new Int32Array(f32.buffer);
/** @param {number} word */
const asFloat = word=>{
    u32[0] = word;
    return f32[0];
};
/** @param {number} value */
const fromFloat = value=>{
    f32[0] = value;
    return u32[0];
};
/** @param {number} word */
const asInt = word=>{
    u32[0] = word;
    return i32[0];
};
const TRUE = 0xffffffff;

/**
 * A float operation of one input.
 *
 * @type {Readonly<Record<number, (x: number) => number>>}
 */
const FLOAT_UNARY = Object.freeze({
    0x101: x=>-x,
    0x103: x=>1 / x,
    0x104: x=>x - Math.floor(x),
    0x105: x=>2 ** x,
    // The logarithm of the magnitude, and zero for zero: what Windows
    // answers for log(0) and log(-2) (test_effect_value_expression).
    0x106: x=>(x === 0 ? 0 : Math.log2(Math.abs(x))),
    0x107: x=>1 / Math.sqrt(x),
    0x108: Math.sin,
    0x109: Math.cos,
    0x10a: Math.asin,
    0x10b: Math.acos,
    0x10c: Math.atan,
    0x112: Math.sqrt,
    0x139: Math.floor,
    0x13a: Math.ceil,
});

/**
 * A float operation of two.
 *
 * @type {Readonly<Record<number, (a: number, b: number) => number>>}
 */
const FLOAT_BINARY = Object.freeze({
    0x200: Math.min,
    0x201: Math.max,
    0x204: (a, b)=>a + b,
    0x205: (a, b)=>a * b,
    0x206: Math.atan2,
    0x208: (a, b)=>a / b,
});

/**
 * An integer operation of two, on the words: signed or not as it says.
 *
 * @type {Readonly<Record<number, (a: number, b: number) => number>>}
 */
const INTEGER_BINARY = Object.freeze({
    0x210: (a, b)=>(asInt(a) < asInt(b) ? TRUE : 0),
    0x211: (a, b)=>(asInt(a) >= asInt(b) ? TRUE : 0),
    0x212: (a, b)=>(a === b ? TRUE : 0),
    0x213: (a, b)=>(a !== b ? TRUE : 0),
    0x214: (a, b)=>(a >= b ? TRUE : 0),
    0x215: (a, b)=>(a < b ? TRUE : 0),
    0x216: (a, b)=>(a + b) >>> 0,
    0x219: (a, b)=>Math.imul(a, b) >>> 0,
    0x21a: (a, b)=>(b === 0 ? TRUE : Math.floor(a / b) >>> 0),
    0x21d: (a, b)=>(asInt(a) < asInt(b) ? a : b),
    0x21e: (a, b)=>(asInt(a) > asInt(b) ? a : b),
    0x21f: (a, b)=>Math.min(a, b),
    0x220: (a, b)=>Math.max(a, b),
    0x230: (a, b)=>(a & b) >>> 0,
    0x231: (a, b)=>(a | b) >>> 0,
    0x233: (a, b)=>(a ^ b) >>> 0,
    0x234: (a, b)=>(a << (b & 31)) >>> 0,
    0x235: (a, b)=>(asInt(a) >> (b & 31)) >>> 0,
    0x236: (a, b)=>a >>> (b & 31),
});

/** A float to a signed integer, truncated and held to its range. @param {number} x */
const toSigned = x=>(Number.isNaN(x) ? 0 : x <= -2147483648 ? 0x80000000
    : x >= 2147483647 ? 0x7fffffff : Math.trunc(x) >>> 0);

/** A float to an unsigned integer, truncated and held to its range. @param {number} x */
const toUnsigned = x=>(Number.isNaN(x) || x <= 0 ? 0 : x >= 4294967295 ? 4294967295
    : Math.trunc(x));

/**
 * An operation of one input on the words.
 *
 * @type {Readonly<Record<number, (word: number) => number>>}
 */
const WORD_UNARY = Object.freeze({
    0x100: word=>word,
    0x120: word=>(-asInt(word)) >>> 0,
    0x121: word=>(~word) >>> 0,
    0x130: word=>fromFloat(asInt(word)),
    0x131: word=>fromFloat(word),
    0x132: word=>toSigned(asFloat(word)),
    0x133: word=>toUnsigned(asFloat(word)),
    0x137: word=>(asFloat(word) !== 0 ? TRUE : 0),
});

const FIRST_CONVERSION = 0x130;
const LAST_CONVERSION = 0x13a;
const MOVC = 0x301;
const DOT = 0x500;
const DOT_SWIZZLED = 0x70e;

/**
 * Runs an expression over the values its inputs hold now.
 *
 * @param {Expression} expression
 * @param {(name: string, words: number) => Uint32Array | null} read
 *     An effect variable's current value, as words, `words` of them; null
 *     for a name the effect does not have, which reads as zero.
 * @returns {Uint32Array}  The result's components.
 */
export function runExpression(expression, read){
    const registers = expression.inputs.reduce((most, input)=>
        Math.max(most, input.register + input.registers), 0);
    const inputs = new Uint32Array(registers * 4);
    for (const input of expression.inputs)
    {
        const value = read(input.name, input.registers * 4);
        if (value)
        {
            inputs.set(value.subarray(0, input.registers * 4), input.register * 4);
        }
    }
    const temporaries = new Uint32Array(64);
    const result = new Uint32Array(16);
    /** @param {Operand} operand @param {number} component */
    const load = (operand, component)=>{
        const at = operand.offset + component;
        switch (operand.table)
        {
            case TABLE.LITERAL:
                return expression.literals[at] ?? 0;
            case TABLE.INPUT:
                return inputs[at] ?? 0;
            case TABLE.TEMPORARY:
                return temporaries[at] ?? 0;
            case TABLE.RESULT:
                return result[at] ?? 0;
            default:
                throw new NotAnExpression(`an operand of table ${operand.table}`);
        }
    };
    /** @param {Operand} operand @param {number} component @param {number} word */
    const store = (operand, component, word)=>{
        const target = operand.table === TABLE.RESULT ? result
            : operand.table === TABLE.TEMPORARY ? temporaries : null;
        if (!target)
        {
            throw new NotAnExpression(`a result into table ${operand.table}`);
        }
        const at = operand.offset + component;
        if (at < target.length)
        {
            target[at] = word >>> 0;
        }
    };
    for (const instruction of expression.code)
    {
        const { op, count, scalar, inputs: ins, output } = instruction;
        // A conversion, floor or ceil reads only its input's first
        // component and gives it to every one: Windows's ceil(float4)
        // and (float)~int4 come to the x's answer four times
        // (test_effect_value_expression).
        const first = op >= FIRST_CONVERSION && op <= LAST_CONVERSION;
        /** @param {number} input @param {number} component */
        const arg = (input, component)=>load(ins[input],
            first || (scalar && input === 0 && ins.length > 1) ? 0 : component);
        if (op === DOT)
        {
            let sum = 0;
            for (let component = 0; component < count; component++)
            {
                sum = Math.fround(sum + Math.fround(asFloat(arg(0, component))
                    * asFloat(arg(1, component))));
            }
            store(output, 0, fromFloat(sum));
            continue;
        }
        if (op === DOT_SWIZZLED)
        {
            const half = ins.length / 2;
            let sum = 0;
            for (let component = 0; component < half; component++)
            {
                sum = Math.fround(sum + Math.fround(asFloat(load(ins[component], 0))
                    * asFloat(load(ins[half + component], 0))));
            }
            store(output, 0, fromFloat(sum));
            continue;
        }
        for (let component = 0; component < count; component++)
        {
            let word;
            if (op === MOVC)
            {
                word = arg(0, component) !== 0 ? arg(1, component) : arg(2, component);
            }
            else if (FLOAT_UNARY[op])
            {
                word = fromFloat(FLOAT_UNARY[op](asFloat(arg(0, component))));
            }
            else if (FLOAT_BINARY[op])
            {
                word = fromFloat(FLOAT_BINARY[op](asFloat(arg(0, component)),
                    asFloat(arg(1, component))));
            }
            else if (INTEGER_BINARY[op])
            {
                word = INTEGER_BINARY[op](arg(0, component), arg(1, component));
            }
            else if (WORD_UNARY[op])
            {
                word = WORD_UNARY[op](arg(0, component));
            }
            else
            {
                throw new NotAnExpression(`an operation 0x${op.toString(16)}`);
            }
            store(output, component, word);
        }
    }
    return result;
}

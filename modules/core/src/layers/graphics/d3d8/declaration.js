/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D 8 vertex shader declaration: a token stream, not an array of
 * elements. A stream token opens a stream, a data token loads a vertex
 * register from it at the running offset -- or skips dwords -- and a constant
 * token carries values the shader's constant registers take when it is set.
 *
 * What the rest of the engine reads is Direct3D 9's shape, so each loaded
 * register becomes an element of the usage its register names in
 * d3d8types.h's D3DVSDE_ list, and a vs_1_x function is read with every
 * input register declared as that usage: in this version the declaration
 * binds a shader's inputs by register number and by nothing else.
 */

import { D3DDECLMETHOD, D3DDECLTYPE, D3DDECLUSAGE, DECLTYPE_BYTES } from '../d3d9/declaration.js';
import { OPCODE, REGISTER } from '../d3d9/shader.js';

/** D3DVSD_TOKENTYPE, in bits 29-31 of every token. */
const TOKEN = Object.freeze({
    NOP: 0, STREAM: 1, STREAMDATA: 2, TESSELLATOR: 3, CONSTMEM: 4, EXT: 5, END: 7,
});

/** D3DVSD_END(). */
export const DECLARATION_END = 0xffffffff;

/** Past this many tokens a declaration with no end token is not one. */
const MAX_DECLARATION_TOKENS = 4096;

/** A vertex shader's input registers, v0 to v15. */
const INPUT_REGISTERS = 16;

/**
 * The usage each D3DVSDE register stands for: its name in d3d8types.h, and
 * what the fixed-function stage reads it as.
 *
 * @type {readonly [number, number][]}
 */
const REGISTER_USAGE = Object.freeze([
    [D3DDECLUSAGE.POSITION, 0], [D3DDECLUSAGE.BLENDWEIGHT, 0], [D3DDECLUSAGE.BLENDINDICES, 0],
    [D3DDECLUSAGE.NORMAL, 0], [D3DDECLUSAGE.PSIZE, 0], [D3DDECLUSAGE.COLOR, 0],
    [D3DDECLUSAGE.COLOR, 1], [D3DDECLUSAGE.TEXCOORD, 0], [D3DDECLUSAGE.TEXCOORD, 1],
    [D3DDECLUSAGE.TEXCOORD, 2], [D3DDECLUSAGE.TEXCOORD, 3], [D3DDECLUSAGE.TEXCOORD, 4],
    [D3DDECLUSAGE.TEXCOORD, 5], [D3DDECLUSAGE.TEXCOORD, 6], [D3DDECLUSAGE.TEXCOORD, 7],
    [D3DDECLUSAGE.POSITION, 1], [D3DDECLUSAGE.NORMAL, 1],
]);

/**
 * D3DVSDT, which names the same eight types with the same numbers
 * D3DDECLTYPE starts with.
 */
const LAST_DATA_TYPE = D3DDECLTYPE.SHORT4;

/**
 * How many tokens past this one belong to it: a constant token's values,
 * which may hold any bits -- the end token's among them -- and an extension
 * token's dwords.
 *
 * @param {number} token
 */
const payloadOf = token=>{
    switch (token >>> 29)
    {
        case TOKEN.CONSTMEM:
            return ((token >>> 25) & 0xf) * 4;
        case TOKEN.EXT:
            return (token >>> 24) & 0x1f;
        default:
            return 0;
    }
};

/**
 * How many tokens a declaration runs to, its end token included, reading
 * one at a time: the stream carries no length. -1 when no end comes.
 *
 * @param {(index: number) => number} tokenAt
 */
export function declarationLength(tokenAt){
    for (let at = 0; at < MAX_DECLARATION_TOKENS; at++)
    {
        const token = tokenAt(at) >>> 0;
        if (token === DECLARATION_END)
        {
            return at + 1;
        }
        at += payloadOf(token);
    }
    return -1;
}

/**
 * @typedef {Object} Declaration8
 * @property {Uint32Array} tokens  As the program gave them, the end token included.
 * @property {import('../d3d9/declaration.js').VertexElement[]} elements
 *           Each register loaded, as Direct3D 9's element of its usage.
 * @property {{ register: number, values: Float32Array }[]} constants
 *           What the declaration loads into constant registers.
 * @property {string | null} error  Why the declaration is not one, if it is not.
 */

/**
 * The declaration a token stream spells, read to its end token.
 *
 * @param {ArrayLike<number>} tokens
 * @returns {Declaration8}
 */
export function parseDeclaration(tokens){
    /** @type {Declaration8['elements']} */
    const elements = [];
    /** @type {Declaration8['constants']} */
    const constants = [];
    let stream = -1;
    let offset = 0;
    let at = 0;
    /** @param {string | null} error */
    const ended = error=>({
        tokens: Uint32Array.from(Array.from(tokens).slice(0, at + 1)), elements, constants, error,
    });
    for (; at < tokens.length; at++)
    {
        const token = tokens[at] >>> 0;
        if (token === DECLARATION_END)
        {
            return ended(null);
        }
        const type = token >>> 29;
        switch (type)
        {
            case TOKEN.NOP:
                break;
            case TOKEN.STREAM:
                if ((token & 0x10000000) !== 0)
                {
                    return ended('a tessellator stream');
                }
                stream = token & 0xf;
                offset = 0;
                break;
            case TOKEN.STREAMDATA: {
                if (stream < 0)
                {
                    return ended('data before any stream');
                }
                if ((token & 0x10000000) !== 0)
                {
                    offset += ((token >>> 16) & 0xf) * 4;
                    break;
                }
                const register = token & 0x1f;
                const dataType = (token >>> 16) & 0xf;
                if (dataType > LAST_DATA_TYPE || register >= REGISTER_USAGE.length
                    || elements.some(element=>registerOf(element) === register))
                {
                    return ended(`register v${register} loaded as type ${dataType}`);
                }
                const [usage, usageIndex] = REGISTER_USAGE[register];
                elements.push({
                    Stream: stream, Offset: offset, Type: dataType, Method: D3DDECLMETHOD.DEFAULT,
                    Usage: usage, UsageIndex: usageIndex,
                });
                offset += DECLTYPE_BYTES[dataType];
                break;
            }
            case TOKEN.CONSTMEM: {
                const count = payloadOf(token);
                if (at + count >= tokens.length)
                {
                    return ended('constants past the end');
                }
                const words = Uint32Array.from(Array.from(tokens).slice(at + 1, at + 1 + count));
                constants.push({ register: token & 0x7f, values: new Float32Array(words.buffer) });
                at += count;
                break;
            }
            case TOKEN.EXT:
                at += payloadOf(token);
                break;
            default:
                return ended(`a token of type ${type}`);
        }
    }
    return ended('no end token');
}

/**
 * The register an element of a Direct3D 8 declaration loads.
 *
 * @param {import('../d3d9/declaration.js').VertexElement} element
 */
export function registerOf(element){
    return REGISTER_USAGE.findIndex(([usage, index])=>
        usage === element.Usage && index === element.UsageIndex);
}

/**
 * Whether a declaration with no function is one the runtime makes a shader
 * of: its normal in the three floats the fixed-function stage reads one as
 * (Wine's d3d8 test_shader has two, four and a D3DCOLOR refused there and
 * accepted beside a function). Anything else the stage cannot read is a
 * draw reported rather than a create refused.
 *
 * @param {Declaration8} declaration
 */
export function readableByFixedFunction(declaration){
    return declaration.elements.every(element=>element.Usage !== D3DDECLUSAGE.NORMAL
        || element.UsageIndex !== 0 || element.Type === D3DDECLTYPE.FLOAT3);
}

/**
 * A vs_1_x shader as the translator reads one: each input register
 * declared, ahead of the body, as the usage its register stands for -- and a
 * declaration of the shader's own for an input left out, since the
 * declaration, not the function, says what a register holds.
 *
 * @param {import('../d3d9/shader.js').ParsedShader} parsed
 * @returns {import('../d3d9/shader.js').ParsedShader}
 */
export function declaredShader(parsed){
    /** @type {import('../d3d9/shader.js').Instruction[]} */
    const inputs = REGISTER_USAGE.slice(0, INPUT_REGISTERS).map(([usage, usageIndex], index)=>({
        opcode: OPCODE.DCL, name: 'dcl', control: 0, predicated: false, coissue: false,
        dest: {
            type: REGISTER.INPUT, index, relative: null, writeMask: 0xf, swizzle: 0x0f,
            modifier: 0, resultModifier: 0, shift: 0,
        },
        sources: [],
        declaration: { usage, usageIndex },
    }));
    return {
        ...parsed,
        instructions: [...inputs, ...parsed.instructions.filter(instruction=>
            instruction.opcode !== OPCODE.DCL || instruction.dest?.type !== REGISTER.INPUT)],
    };
}

/**
 * Whether every constant register a shader names directly, and every one it
 * defines, is below `count`: a register past the device's file refuses the
 * create (Wine's d3d8 test_unsupported_shaders: c255 is made on a device of 256
 * and c256 is not).
 *
 * @param {import('../d3d9/shader.js').ParsedShader} parsed
 * @param {number} count
 */
export function constantsWithin(parsed, count){
    return parsed.instructions.every(instruction=>
        [instruction.dest, ...instruction.sources].every(operand=>!operand
            || operand.type !== REGISTER.CONST || operand.index < count));
}

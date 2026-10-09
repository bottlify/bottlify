/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Physical instructions as the Direct3D 9 token stream.
 *
 * An instruction is an opcode token -- the opcode in the low 16 bits, a
 * control field above it, from shader model 2 the count of tokens that follow
 * in bits 24 to 27 -- then a destination parameter, then the sources. A
 * parameter token has the top bit set; its register number takes bits 0 to 10,
 * the register type is split between bits 28 to 30 (low three) and bits 11 to
 * 12 (high two), a relative-addressing flag is bit 13, a destination's write
 * mask is bits 16 to 19 with its result modifiers above, and a source's
 * swizzle is bits 16 to 23 (two bits a component, x first) with its modifier
 * in bits 24 to 27.
 */

import { versionTokenOf } from './hlsl-ir.js';
import { float32Bits } from './hlsl-math.js';

/** D3DSPR, the register types. */
export const REG = Object.freeze({
    TEMP: 0, INPUT: 1, CONST: 2, ADDR: 3, TEXTURE: 3, RASTOUT: 4, ATTROUT: 5, TEXCRDOUT: 6,
    OUTPUT: 6, CONSTINT: 7, COLOROUT: 8, DEPTHOUT: 9, SAMPLER: 10, CONSTBOOL: 14, LOOP: 15,
    MISC: 17,
});

/** D3DSPSM, the source modifiers this compiler writes. */
export const MOD = Object.freeze({
    NONE: 0, NEG: 1, BIAS: 2, BIASNEG: 3, SIGN: 4, SIGNNEG: 5, COMP: 6, X2: 7, X2NEG: 8,
    ABS: 11, ABSNEG: 12,
});

/** D3DSIO: opcode, how the operands are laid out, and how many sources. */
export const OPCODES = Object.freeze({
    mov: { code: 1, cls: 'comp', srcs: 1 },
    add: { code: 2, cls: 'comp', srcs: 2 },
    sub: { code: 3, cls: 'comp', srcs: 2 },
    mad: { code: 4, cls: 'comp', srcs: 3 },
    mul: { code: 5, cls: 'comp', srcs: 2 },
    rcp: { code: 6, cls: 'scalar', srcs: 1 },
    rsq: { code: 7, cls: 'scalar', srcs: 1 },
    dp3: { code: 8, cls: 'lanes', srcs: 2 },
    dp4: { code: 9, cls: 'lanes', srcs: 2 },
    min: { code: 10, cls: 'comp', srcs: 2 },
    max: { code: 11, cls: 'comp', srcs: 2 },
    slt: { code: 12, cls: 'comp', srcs: 2 },
    sge: { code: 13, cls: 'comp', srcs: 2 },
    exp: { code: 14, cls: 'scalar', srcs: 1 },
    log: { code: 15, cls: 'scalar', srcs: 1 },
    lrp: { code: 18, cls: 'comp', srcs: 3 },
    frc: { code: 19, cls: 'comp', srcs: 1 },
    pow: { code: 32, cls: 'scalar', srcs: 2 },
    abs: { code: 35, cls: 'comp', srcs: 1 },
    sincos: { code: 37, cls: 'scalar', srcs: 1 },
    mova: { code: 46, cls: 'scalar', srcs: 1 },
    texkill: { code: 65, cls: 'kill', srcs: 1 },
    texld: { code: 66, cls: 'texture', srcs: 2 },
    cmp: { code: 88, cls: 'comp', srcs: 3 },
    cnd: { code: 80, cls: 'comp', srcs: 3 },
    nop: { code: 0, cls: 'none', srcs: 0 },
    tex: { code: 66, cls: 'texture', srcs: 0 },
    texcoord: { code: 64, cls: 'texture', srcs: 0 },
    texcrd: { code: 64, cls: 'texture', srcs: 1 },
    phase: { code: 0xfffd, cls: 'none', srcs: 0 },
    dp2add: { code: 90, cls: 'lanes', srcs: 3 },
    dsx: { code: 91, cls: 'comp', srcs: 1 },
    dsy: { code: 92, cls: 'comp', srcs: 1 },
    texldd: { code: 93, cls: 'texture', srcs: 4 },
    texldl: { code: 95, cls: 'texture', srcs: 2 },
    rep: { code: 38, cls: 'control', srcs: 1 },
    endrep: { code: 39, cls: 'control', srcs: 0 },
    ifc: { code: 41, cls: 'control', srcs: 2 },
    endif: { code: 43, cls: 'control', srcs: 0 },
    break: { code: 44, cls: 'control', srcs: 0 },
    breakc: { code: 45, cls: 'control', srcs: 2 },
});

/** D3DSHADER_COMPARISON, the control field of ifc and breakc. */
export const COMPARISON = Object.freeze({ gt: 1, eq: 2, ge: 3, lt: 4, ne: 5, le: 6 });

const OP_DCL = 31;
const OP_DEF = 81;
const OP_DEFI = 48;
const OP_COMMENT = 0xfffe;
const END = 0x0000ffff;

/**
 * @typedef {Object} PhysOperand
 * @property {number} type        REG.
 * @property {number} index
 * @property {number} [mask]      A destination's write mask, x as bit 0.
 * @property {number[]} [swz]     A source's four component selectors.
 * @property {number} [mod]       MOD.
 * @property {boolean} [relative] Addressed by a0.x as well.
 * @property {boolean} [sat]
 * @property {boolean} [pp]
 * @property {number} [shift]     A destination's scale as the token holds it: 1 to 3 for x2 to x8,
 *                                15 to 13 for d2 to d8.
 */

/**
 * @typedef {Object} PhysInstr
 * @property {string} op          A key of OPCODES.
 * @property {PhysOperand | null} dest
 * @property {PhysOperand[]} srcs
 * @property {number} [control]   Bits 16 to 23 of the opcode token.
 * @property {boolean} [coissue]  Issued with the instruction before it (a `+` in assembly).
 */

/**
 * @typedef {Object} PhysDcl
 * @property {number} [usage]       For an input or output of a vertex shader or model 3.
 * @property {number} [usageIndex]
 * @property {number} [samplerType] D3DSAMPLER_TEXTURE_TYPE, already shifted: 2 << 27 for 2D.
 * @property {PhysOperand} dest
 */

/**
 * @typedef {Object} PhysProgram
 * @property {import('./hlsl-ir.js').Profile} profile
 * @property {PhysDcl[]} decls
 * @property {{ index: number, values: number[] }[]} defs
 * @property {{ index: number, values: number[] }[]} [intDefs]   defi: an integer register.
 * @property {PhysInstr[]} instrs
 * @property {number[]} [comment]   Whole comment tokens, written before the declarations.
 */

/** @param {PhysOperand} operand */
function registerBits(operand){
    return ((0x80000000 | (operand.type & 7) << 28 | (operand.type & 0x18) << 8
        | (operand.index & 0x7ff)) >>> 0);
}

/** @param {PhysOperand} operand @returns {number} */
function destToken(operand){
    return (registerBits(operand) | ((operand.mask ?? 0xf) & 0xf) << 16
        | (operand.sat ? 1 << 20 : 0) | (operand.pp ? 2 << 20 : 0)
        | ((operand.shift ?? 0) & 0xf) << 24) >>> 0;
}

/** @param {number[]} swz */
const swizzleBits = swz=>(swz[0] & 3) | (swz[1] & 3) << 2 | (swz[2] & 3) << 4 | (swz[3] & 3) << 6;

/**
 * A source's tokens: the parameter and, from model 2, the address register's
 * parameter after it when addressing is relative.
 *
 * @param {PhysOperand} operand @param {boolean} modelTwo @returns {number[]}
 */
function sourceTokens(operand, modelTwo){
    const swz = operand.swz ?? [0, 1, 2, 3];
    const token = (registerBits(operand) | (operand.relative ? 1 << 13 : 0)
        | swizzleBits(swz) << 16 | (operand.mod ?? 0) << 24) >>> 0;
    if (operand.relative && modelTwo)
    {
        // a0, read through its x component.
        return [token, (0x80000000 | REG.ADDR << 28) >>> 0];
    }
    return [token];
}

/**
 * The token stream of a program, version token first and end token last.
 *
 * @param {PhysProgram} program
 * @returns {Uint32Array}
 */
export function encodeProgram(program){
    const { profile } = program;
    const modelTwo = profile.major >= 2;
    /** @type {number[]} */
    const tokens = [versionTokenOf(profile)];
    if (program.comment)
    {
        tokens.push(...program.comment);
    }
    /**
     * @param {number} opcode @param {number} control @param {number[]} operands
     */
    const instruction = (opcode, control, operands)=>{
        const length = modelTwo ? operands.length : 0;
        tokens.push((opcode | control << 16 | length << 24) >>> 0, ...operands);
    };

    for (const def of program.defs)
    {
        instruction(OP_DEF, 0, [destToken({ type: REG.CONST, index: def.index, mask: 0xf }),
            ...def.values.map(float32Bits)]);
    }
    for (const def of program.intDefs ?? [])
    {
        instruction(OP_DEFI, 0, [destToken({ type: REG.CONSTINT, index: def.index, mask: 0xf }),
            ...def.values.map(v=>v >>> 0)]);
    }
    for (const dcl of program.decls)
    {
        const what = dcl.samplerType !== undefined
            ? dcl.samplerType
            : (dcl.usage ?? 0) | (dcl.usageIndex ?? 0) << 16;
        instruction(OP_DCL, 0, [(0x80000000 | what) >>> 0, destToken(dcl.dest)]);
    }
    for (const one of program.instrs)
    {
        const info = /** @type {Record<string, { code: number, cls: string }>} */ (OPCODES)[one.op];
        if (!info)
        {
            throw new Error(`no opcode for '${one.op}'`);
        }
        /** @type {number[]} */
        const operands = [];
        if (one.dest)
        {
            operands.push(destToken(one.dest));
        }
        for (const source of one.srcs)
        {
            operands.push(...sourceTokens(source, modelTwo));
        }
        if (one.op === 'phase')
        {
            tokens.push(info.code);
            continue;
        }
        instruction(info.code | (one.coissue ? 0x40000000 : 0), one.control ?? 0, operands);
    }
    tokens.push(END);
    return Uint32Array.from(tokens);
}

/** The comment token and its payload words. @param {number[]} words @returns {number[]} */
export function commentTokens(words){
    return [(OP_COMMENT | words.length << 16) >>> 0, ...words];
}

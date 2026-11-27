/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Shader Model 4 machine for tests: one invocation of a compiled program, run from its
 * container through the decoder of `graphics/d3d10/sm4.js`, with its registers as bits.
 *
 * It knows the instructions of the language as the Direct3D 10 specification defines them --
 * a float operand's `-` and `|x|` are a float's, an integer's `-` is a two's complement, a
 * comparison writes all ones, a shift takes the low five bits of its count, a division by
 * zero gives all ones - and nothing of how this repository's compiler writes them, so a
 * program the compiler got wrong comes out wrong here. A texture read and a derivative are
 * the test's to answer; a temporary read before anything wrote it throws.
 *
 * Nothing in the product reaches this file.
 */

import { parseDxbc } from '../d3d10/dxbc.js';
import { MODIFIER, OPCODE, OPERAND, decodeSm4 } from '../d3d10/sm4.js';

const f32 = Math.fround;
const view = new DataView(new ArrayBuffer(4));
/** @param {number} bits */
export const asFloat = bits=>{
    view.setUint32(0, bits >>> 0, true);
    return view.getFloat32(0, true);
};
/** @param {number} x */
export const asBits = x=>{
    view.setFloat32(0, x, true);
    return view.getUint32(0, true);
};
const TRUE = 0xffffffff;

/**
 * @typedef {Object} MachineEnv
 * @property {Map<number, number[]>} [inputs]     v# as four dwords.
 * @property {Map<number, Uint32Array>} [buffers]  cb# as dwords.
 * @property {(op: string, resource: number, sampler: number | null, args: number[][],
 *     offset: number[]) => number[]} [texture]   Four dwords.
 * @property {(axis: 'x' | 'y', bits: number) => number} [derivative]   Of one float's bits.
 * @property {number} [maxSteps]
 */

/**
 * @typedef {Object} MachineResult
 * @property {Map<number, number[]>} outputs   o# as four dwords; a component never written is
 *     undefined.
 * @property {number | undefined} depth
 * @property {boolean} killed
 * @property {number} steps
 */

/** The kind of the operands of each opcode: how its modifiers read. */
const INTEGER = new Set([OPCODE.IADD, OPCODE.IMAD, OPCODE.IMAX, OPCODE.IMIN, OPCODE.IMUL,
    OPCODE.INEG, OPCODE.ISHL, OPCODE.ISHR, OPCODE.IEQ, OPCODE.INE, OPCODE.ILT, OPCODE.IGE,
    OPCODE.ULT, OPCODE.UGE, OPCODE.UDIV, OPCODE.UMUL, OPCODE.UMAD, OPCODE.UMAX, OPCODE.UMIN,
    OPCODE.USHR, OPCODE.AND, OPCODE.OR, OPCODE.XOR, OPCODE.NOT, OPCODE.ITOF, OPCODE.UTOF,
    OPCODE.LD, OPCODE.LD_MS, OPCODE.RESINFO, OPCODE.MOVC, 130 + 1, 134, 135, 136, 137, 141]);

/** min and max of the specification: a NaN operand gives the other. @param {number} a @param {number} b */
const fmin = (a, b)=>(Number.isNaN(a) ? b : Number.isNaN(b) ? a : a < b ? a : b);
/** @param {number} a @param {number} b */
const fmax = (a, b)=>(Number.isNaN(a) ? b : Number.isNaN(b) ? a : a > b ? a : b);

/** ftoi and ftou: toward zero, NaN to zero, out of range to the end. @param {number} x */
const ftoi = x=>(Number.isNaN(x) ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648
    ? -2147483648 : Math.trunc(x) | 0);
/** @param {number} x */
const ftou = x=>(Number.isNaN(x) || x <= 0 ? 0 : x >= 4294967295 ? 4294967295
    : Math.trunc(x) >>> 0);

/**
 * Runs one invocation.
 *
 * @param {Uint8Array} bytes   A container.
 * @param {MachineEnv} env
 * @returns {MachineResult}
 */
export function runSm4(bytes, env){
    const container = parseDxbc(bytes);
    if (!container?.shader)
    {
        throw new Error('not a program');
    }
    const code = decodeSm4(container.shader.tokens);
    /** @type {(Array<number | undefined>)[]} */
    const temps = [];
    /** @type {Map<number, number[]>} */
    const outputs = new Map();
    /** @type {number | undefined} */
    let depth;
    let killed = false;

    /**
     * The four dwords an operand names, swizzled and modified.
     * @param {import('../d3d10/sm4.js').Operand} op @param {boolean} integer
     * @returns {number[]}
     */
    const read = (op, integer)=>{
        /** @type {number[]} */
        let raw;
        switch (op.type)
        {
            case OPERAND.IMMEDIATE32:
                raw = op.immediate.length === 1 ? [0, 0, 0, 0].map(()=>op.immediate[0])
                    : op.immediate.slice(0, 4);
                break;
            case OPERAND.TEMP: {
                const reg = temps[op.indices[0].value] ?? [];
                raw = [0, 1, 2, 3].map(c=>reg[c] ?? NaN);
                break;
            }
            case OPERAND.INPUT: {
                const reg = env.inputs?.get(op.indices[0].value);
                if (!reg)
                {
                    throw new Error(`v${op.indices[0].value} has no value`);
                }
                raw = reg.slice(0, 4);
                break;
            }
            case OPERAND.CONSTANT_BUFFER: {
                const [slot, row] = op.indices;
                let at = row.value;
                if (row.relative)
                {
                    at += read(row.relative, true)[0] | 0;
                }
                const data = env.buffers?.get(slot.value) ?? new Uint32Array(0);
                raw = [0, 1, 2, 3].map(c=>data[at * 4 + c] ?? 0);
                break;
            }
            default:
                throw new Error(`an operand of type ${op.type} cannot be read`);
        }
        let lanes = op.type === OPERAND.IMMEDIATE32 && op.immediate.length === 1 ? raw
            : op.swizzle.map(c=>raw[c]);
        if (op.type === OPERAND.TEMP && op.componentCount === 4)
        {
            // Only the components the instruction reads must hold something.
            lanes = lanes.map(x=>x);
        }
        if (op.modifier !== MODIFIER.NONE)
        {
            lanes = lanes.map(bits=>{
                if (Number.isNaN(bits))
                {
                    return bits;
                }
                if (integer)
                {
                    const negated = (op.modifier & MODIFIER.NEG) !== 0;
                    return negated ? (-bits) >>> 0 : bits;
                }
                let x = asFloat(bits);
                if (op.modifier & MODIFIER.ABS)
                {
                    x = Math.abs(x);
                }
                if (op.modifier & MODIFIER.NEG)
                {
                    x = -x;
                }
                return asBits(x);
            });
        }
        return lanes;
    };

    /** Throws on a lane read before it was written. @param {number[]} lanes @param {number[]} used */
    const defined = (lanes, used)=>{
        for (const c of used)
        {
            if (Number.isNaN(lanes[c]))
            {
                throw new Error('a temporary read before it was written');
            }
        }
        return lanes;
    };

    /**
     * Writes the components of `values` a destination's mask names.
     * @param {import('../d3d10/sm4.js').Operand} op @param {number[]} values
     * @param {boolean} sat
     */
    const write = (op, values, sat)=>{
        const lanes = sat ? values.map(bits=>{
            const x = asFloat(bits);
            return asBits(Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x)));
        }) : values;
        if (op.type === OPERAND.NULL)
        {
            return;
        }
        if (op.type === OPERAND.OUTPUT_DEPTH)
        {
            depth = lanes[0] >>> 0;
            return;
        }
        const index = op.indices[0].value;
        const file = op.type === OPERAND.TEMP ? temps : null;
        /** @type {Array<number | undefined>} */
        let reg;
        if (file)
        {
            reg = file[index] ??= [];
        }
        else if (op.type === OPERAND.OUTPUT)
        {
            reg = outputs.get(index) ?? [];
            outputs.set(index, /** @type {number[]} */ (reg));
        }
        else
        {
            throw new Error(`an operand of type ${op.type} cannot be written`);
        }
        for (let c = 0; c < 4; c++)
        {
            if (op.mask & (1 << c))
            {
                reg[c] = lanes[c] >>> 0;
            }
        }
    };

    /** The components a destination writes. @param {import('../d3d10/sm4.js').Operand} op */
    const maskOf = op=>[0, 1, 2, 3].filter(c=>op.type !== OPERAND.TEMP && op.type !== OPERAND.OUTPUT
        || (op.mask & (1 << c)));

    /** Where each loop and if ends and where its else is. */
    /** @type {Map<number, number>} */
    const match = new Map();
    {
        /** @type {number[]} */
        const stack = [];
        code.forEach((ins, at)=>{
            if (ins.opcode === OPCODE.LOOP || ins.opcode === OPCODE.IF)
            {
                stack.push(at);
            }
            else if (ins.opcode === OPCODE.ELSE)
            {
                match.set(/** @type {number} */ (stack.at(-1)), at);
                stack.push(/** @type {number} */ (stack.pop()));
                match.set(at, -1);
            }
            else if (ins.opcode === OPCODE.ENDLOOP || ins.opcode === OPCODE.ENDIF)
            {
                const open = /** @type {number} */ (stack.pop());
                if (ins.opcode === OPCODE.ENDLOOP)
                {
                    match.set(open, at);
                    match.set(at, open);
                }
                else
                {
                    const otherwise = match.get(open);
                    if (otherwise !== undefined)
                    {
                        match.set(otherwise, at);
                    }
                    else
                    {
                        match.set(open, at);
                    }
                }
            }
        });
    }
    /** @type {number[]} */
    const loops = [];
    let steps = 0;
    const maxSteps = env.maxSteps ?? 1000000;
    for (let pc = 0; pc < code.length; pc++)
    {
        if (++steps > maxSteps)
        {
            throw new Error('the program ran too long');
        }
        const ins = code[pc];
        const op = ins.opcode;
        const integer = INTEGER.has(op);
        const ops = ins.operands;
        /** @param {number} i */
        const src = i=>read(ops[i], integer);
        /** @param {number} i */
        const f = i=>src(i).map(asFloat);
        /** @param {number} i */
        const u = i=>src(i).map(x=>x >>> 0);
        /** @param {number} i */
        const s = i=>src(i).map(x=>x | 0);
        const dest = ops[0];
        const used = dest ? maskOf(dest) : [];
        /** @param {number[]} values floats */
        const putF = values=>write(dest, values.map(x=>asBits(f32(x))), ins.saturate);
        /** @param {number[]} values */
        const putU = values=>write(dest, values.map(x=>x >>> 0), false);
        /** @param {(...x: number[]) => number} fn @param {number} n */
        const floats = (fn, n)=>{
            const args = Array.from({ length: n }, (_, i)=>defined(f(i + 1), used));
            putF([0, 1, 2, 3].map(c=>fn(...args.map(a=>a[c]))));
        };
        /** @param {(...x: number[]) => number} fn @param {number} n @param {boolean} signed */
        const ints = (fn, n, signed)=>{
            const args = Array.from({ length: n }, (_, i)=>defined(signed ? s(i + 1) : u(i + 1),
                used));
            putU([0, 1, 2, 3].map(c=>fn(...args.map(a=>a[c]))));
        };
        /** @param {(a: number, b: number) => boolean} fn */
        const compareF = fn=>{
            const a = defined(f(1), used);
            const b = defined(f(2), used);
            putU([0, 1, 2, 3].map(c=>(fn(a[c], b[c]) ? TRUE : 0)));
        };
        /** @param {(a: number, b: number) => boolean} fn @param {boolean} signed */
        const compareI = (fn, signed)=>{
            const a = defined(signed ? s(1) : u(1), used);
            const b = defined(signed ? s(2) : u(2), used);
            putU([0, 1, 2, 3].map(c=>(fn(a[c], b[c]) ? TRUE : 0)));
        };
        /** @param {number} n */
        const dot = n=>{
            const a = defined(f(1), [0, 1, 2, 3].slice(0, n));
            const b = defined(f(2), [0, 1, 2, 3].slice(0, n));
            let acc = 0;
            for (let c = 0; c < n; c++)
            {
                acc = f32(acc + f32(a[c] * b[c]));
            }
            putF([acc, acc, acc, acc]);
        };
        /** A texture read: the coordinate and the rest as dwords, the offset immediate. */
        const texture = (/** @type {string} */ name, /** @type {number[]} */ rest)=>{
            if (!env.texture)
            {
                throw new Error('the test answers no texture read');
            }
            const control = ins.extra.find(x=>(x & 0x3f) === 1) ?? 0;
            /** @param {number} shift */
            const nibble = shift=>((control >>> shift) & 0xf) << 28 >> 28;
            const offset = [nibble(9), nibble(13), nibble(17)];
            const coordinate = read(ops[1], false);
            const resource = ops[2].indices[0].value;
            const sampler = ops[3]?.type === OPERAND.SAMPLER ? ops[3].indices[0].value : null;
            const texel = env.texture(name, resource, sampler, [coordinate,
                ...rest.map(i=>read(ops[i], false))], offset);
            const swizzled = ops[2].swizzle.map(c=>texel[c]);
            write(dest, swizzled, ins.saturate);
        };
        switch (op)
        {
            case OPCODE.MOV: write(dest, defined(src(1), used), ins.saturate); break;
            case OPCODE.MOVC: {
                const test = defined(src(1), used);
                const a = src(2);
                const b = src(3);
                const pick = [0, 1, 2, 3].map(c=>(test[c] !== 0 ? a[c] : b[c]));
                write(dest, defined(pick, used), ins.saturate);
                break;
            }
            case OPCODE.ADD: floats((a, b)=>a + b, 2); break;
            case OPCODE.MUL: floats((a, b)=>a * b, 2); break;
            case OPCODE.MAD: floats((a, b, c)=>f32(f32(a * b) + c), 3); break;
            case OPCODE.DIV: floats((a, b)=>a / b, 2); break;
            case OPCODE.MIN: floats(fmin, 2); break;
            case OPCODE.MAX: floats(fmax, 2); break;
            case OPCODE.FRC: floats(a=>a - Math.floor(a), 1); break;
            case OPCODE.ROUND_NE: floats(a=>(Math.abs(a % 1) === 0.5
                ? 2 * Math.round(a / 2) : Math.round(a)), 1); break;
            case OPCODE.ROUND_NI: floats(Math.floor, 1); break;
            case OPCODE.ROUND_PI: floats(Math.ceil, 1); break;
            case OPCODE.ROUND_Z: floats(Math.trunc, 1); break;
            case OPCODE.EXP: floats(a=>2 ** a, 1); break;
            case OPCODE.LOG: floats(Math.log2, 1); break;
            case OPCODE.RSQ: floats(a=>1 / Math.sqrt(a), 1); break;
            case OPCODE.SQRT: floats(Math.sqrt, 1); break;
            case OPCODE.SINCOS: {
                const x = f(2);
                if (ops[0].type !== OPERAND.NULL)
                {
                    write(ops[0], defined(x, maskOf(ops[0])).map(v=>asBits(f32(Math.sin(v)))),
                        ins.saturate);
                }
                if (ops[1].type !== OPERAND.NULL)
                {
                    write(ops[1], defined(x, maskOf(ops[1])).map(v=>asBits(f32(Math.cos(v)))),
                        ins.saturate);
                }
                break;
            }
            case OPCODE.DP2: dot(2); break;
            case OPCODE.DP3: dot(3); break;
            case OPCODE.DP4: dot(4); break;
            case OPCODE.LT: compareF((a, b)=>a < b); break;
            case OPCODE.GE: compareF((a, b)=>a >= b); break;
            case OPCODE.EQ: compareF((a, b)=>a === b); break;
            case OPCODE.NE: compareF((a, b)=>a !== b); break;
            case OPCODE.ILT: compareI((a, b)=>a < b, true); break;
            case OPCODE.IGE: compareI((a, b)=>a >= b, true); break;
            case OPCODE.IEQ: compareI((a, b)=>a === b, true); break;
            case OPCODE.INE: compareI((a, b)=>a !== b, true); break;
            case OPCODE.ULT: compareI((a, b)=>a < b, false); break;
            case OPCODE.UGE: compareI((a, b)=>a >= b, false); break;
            case OPCODE.IADD: ints((a, b)=>a + b, 2, true); break;
            case OPCODE.IMAD: ints((a, b, c)=>Math.imul(a, b) + c, 3, true); break;
            case OPCODE.UMAD: ints((a, b, c)=>Math.imul(a, b) + c, 3, false); break;
            case OPCODE.IMIN: ints(Math.min, 2, true); break;
            case OPCODE.IMAX: ints(Math.max, 2, true); break;
            case OPCODE.UMIN: ints(Math.min, 2, false); break;
            case OPCODE.UMAX: ints(Math.max, 2, false); break;
            case OPCODE.INEG: ints(a=>-a, 1, true); break;
            case OPCODE.ISHL: ints((a, b)=>a << (b & 31), 2, true); break;
            case OPCODE.ISHR: ints((a, b)=>a >> (b & 31), 2, true); break;
            case OPCODE.USHR: ints((a, b)=>a >>> (b & 31), 2, false); break;
            case OPCODE.AND: ints((a, b)=>a & b, 2, false); break;
            case OPCODE.OR: ints((a, b)=>a | b, 2, false); break;
            case OPCODE.XOR: ints((a, b)=>a ^ b, 2, false); break;
            case OPCODE.NOT: ints(a=>~a, 1, false); break;
            case OPCODE.ITOF: { const a = defined(s(1), used); putF(a.map(x=>x)); break; }
            case OPCODE.UTOF: { const a = defined(u(1), used); putF(a.map(x=>x)); break; }
            case OPCODE.FTOI: { const a = defined(f(1), used); putU(a.map(ftoi)); break; }
            case OPCODE.FTOU: { const a = defined(f(1), used); putU(a.map(ftou)); break; }
            case OPCODE.IMUL:
            case OPCODE.UMUL: {
                const signed = op === OPCODE.IMUL;
                const a = signed ? s(2) : u(2);
                const b = signed ? s(3) : u(3);
                const product = [0, 1, 2, 3].map(c=>(signed ? BigInt(a[c] | 0) * BigInt(b[c] | 0)
                    : BigInt(a[c] >>> 0) * BigInt(b[c] >>> 0)));
                if (ops[0].type !== OPERAND.NULL)
                {
                    write(ops[0], product.map(p=>Number(BigInt.asUintN(32, p >> 32n))), false);
                }
                if (ops[1].type !== OPERAND.NULL)
                {
                    write(ops[1], defined(product.map(p=>Number(BigInt.asUintN(32, p))),
                        maskOf(ops[1])), false);
                }
                break;
            }
            case OPCODE.UDIV: {
                const a = u(2);
                const b = u(3);
                if (ops[0].type !== OPERAND.NULL)
                {
                    write(ops[0], [0, 1, 2, 3].map(c=>(b[c] === 0 ? TRUE
                        : Math.floor(a[c] / b[c]))), false);
                }
                if (ops[1].type !== OPERAND.NULL)
                {
                    write(ops[1], [0, 1, 2, 3].map(c=>(b[c] === 0 ? TRUE : a[c] % b[c])), false);
                }
                break;
            }
            case OPCODE.DERIV_RTX:
            case OPCODE.DERIV_RTY: {
                if (!env.derivative)
                {
                    throw new Error('the test answers no derivative');
                }
                const axis = op === OPCODE.DERIV_RTX ? 'x' : 'y';
                const derive = env.derivative;
                write(dest, defined(src(1), used).map(bits=>derive(axis, bits)), ins.saturate);
                break;
            }
            case OPCODE.SAMPLE: texture('sample', []); break;
            case OPCODE.SAMPLE_L: texture('sample_l', [4]); break;
            case OPCODE.SAMPLE_B: texture('sample_b', [4]); break;
            case OPCODE.SAMPLE_D: texture('sample_d', [4, 5]); break;
            case OPCODE.SAMPLE_C: texture('sample_c', [4]); break;
            case OPCODE.SAMPLE_C_LZ: texture('sample_c_lz', [4]); break;
            case OPCODE.GATHER4: texture('gather4', []); break;
            case OPCODE.LD: texture('ld', []); break;
            case OPCODE.LD_MS: texture('ld_ms', [3]); break;
            case OPCODE.RESINFO: {
                if (!env.texture)
                {
                    throw new Error('the test answers no texture read');
                }
                const level = read(ops[1], true);
                const info = env.texture(['resinfo', 'resinfo_rcp', 'resinfo_uint'][
                    ins.control & 3], ops[2].indices[0].value, null, [level], [0, 0, 0]);
                write(dest, ops[2].swizzle.map(c=>info[c]), false);
                break;
            }
            case OPCODE.DISCARD: {
                const test = read(ops[0], true)[0];
                if ((test !== 0) === ins.testNonZero)
                {
                    killed = true;
                }
                break;
            }
            case OPCODE.LOOP: loops.push(pc); break;
            case OPCODE.ENDLOOP: pc = /** @type {number} */ (match.get(pc)); break;
            case OPCODE.BREAK:
            case OPCODE.BREAKC: {
                const go = op === OPCODE.BREAK || ((read(ops[0], true)[0] !== 0)
                    === ins.testNonZero);
                if (go)
                {
                    const open = /** @type {number} */ (loops.pop());
                    pc = /** @type {number} */ (match.get(open));
                }
                break;
            }
            case OPCODE.IF: {
                const taken = (read(ops[0], true)[0] !== 0) === ins.testNonZero;
                if (!taken)
                {
                    pc = /** @type {number} */ (match.get(pc));
                }
                break;
            }
            case OPCODE.ELSE: pc = /** @type {number} */ (match.get(pc)); break;
            case OPCODE.ENDIF: break;
            case OPCODE.RET: pc = code.length; break;
            default:
                if (op >= OPCODE.DCL_RESOURCE && op <= OPCODE.DCL_GLOBAL_FLAGS)
                {
                    break;
                }
                switch (op)
                {
                    case 134: ints(a=>{
                        let n = 0;
                        for (let v = a >>> 0; v; v &= v - 1)
                        {
                            n++;
                        }
                        return n;
                    }, 1, false); break;
                    case 141: ints(a=>{
                        let r = 0;
                        for (let i = 0; i < 32; i++)
                        {
                            r = (r << 1) | ((a >>> i) & 1);
                        }
                        return r;
                    }, 1, false); break;
                    case 135: ints(a=>(a === 0 ? TRUE : Math.clz32(a)), 1, false); break;
                    case 137: ints(a=>{
                        const v = a < 0 ? ~a >>> 0 : a >>> 0;
                        return v === 0 ? TRUE : Math.clz32(v);
                    }, 1, true); break;
                    case 136: ints(a=>(a === 0 ? TRUE : 31 - Math.clz32(a & -a)), 1, false); break;
                    default:
                        throw new Error(`opcode ${ins.name} is not run here`);
                }
        }
    }
    return { outputs, depth, killed, steps };
}

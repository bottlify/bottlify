/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MMX and SSE in the evaluator (plan step 5.2, the family order of
 * `emit/simd.js`): the moves and the bitwise family first, which every corpus
 * preamble and teardown needs; the arithmetic, compares, shuffles and
 * conversions follow.
 *
 * An XMM register is four words on the state; an MMX register is the low
 * sixty-four bits of a physical x87 register (`state.f80bits`), so the two
 * views stay one machine. An instruction with an `mm` operand leaves the stack
 * in the MMX state (top zero, every register held), which the caller applies
 * after the operation.
 */

import { CF, PF, ZF } from './decode/table.js';

/** @param {import('./decode/decoder.js').Instruction} instruction */
export function isSimdOp(instruction){
    return instruction.op === 'emms'
        || instruction.operands.some(operand=>operand.kind === 'xmm' || operand.kind === 'mm');
}

/** @param {import('./ir.js').EvalState} state */
export function mmxState(state){
    state.top = 0;
    state.empty = 0;
}

/**
 * Reads an XMM, MMX or memory operand, `width` bytes.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} operand @param {number} width
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @returns {Uint8Array}
 */
function readVector(state, operand, width, address){
    const out = new Uint8Array(16);
    if (operand.kind === 'xmm')
    {
        const base = /** @type {number} */ (operand.reg) * 4;
        for (let i = 0; i < width; i++)
        {
            out[i] = state.xmm[base + (i >> 2)] >>> ((i & 3) * 8) & 0xff;
        }
    }
    else if (operand.kind === 'mm')
    {
        const word = state.f80bits[/** @type {number} */ (operand.reg)];
        for (let i = 0; i < width; i++)
        {
            out[i] = Number(word >> BigInt(i * 8) & 0xffn);
        }
    }
    else if (operand.kind === 'reg')
    {
        const word = state.reg[/** @type {number} */ (operand.reg)];
        for (let i = 0; i < width && i < 4; i++)
        {
            out[i] = word >>> (i * 8) & 0xff;
        }
    }
    else
    {
        const at = address(operand);
        for (let i = 0; i < width; i++)
        {
            out[i] = state.memory.read(at + i, 1) & 0xff;
        }
    }
    return out;
}

/**
 * Writes `width` bytes to an XMM, MMX or memory operand.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} operand @param {number} width
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @param {Uint8Array} value
 */
function writeVector(state, operand, width, address, value){
    if (operand.kind === 'xmm')
    {
        const base = /** @type {number} */ (operand.reg) * 4;
        for (let i = 0; i < width; i++)
        {
            const word = base + (i >> 2);
            const shift = (i & 3) * 8;
            state.xmm[word] = (state.xmm[word] & ~(0xff << shift)
                | (value[i] & 0xff) << shift) >>> 0;
        }
        return;
    }
    if (operand.kind === 'mm')
    {
        let word = 0n;
        for (let i = width - 1; i >= 0; i--)
        {
            word = word << 8n | BigInt(value[i] & 0xff);
        }
        state.f80bits[/** @type {number} */ (operand.reg)] = BigInt.asIntN(64, word);
        return;
    }
    if (operand.kind === 'reg')
    {
        const size = operand.size || 4;
        const index = /** @type {number} */ (operand.reg);
        if (size === 1)
        {
            state.reg[index] = (state.reg[index] & 0xffffff00 | value[0] & 0xff) >>> 0;
        }
        else if (size === 2)
        {
            state.reg[index] = (state.reg[index] & 0xffff0000
                | (value[0] | value[1] << 8) & 0xffff) >>> 0;
        }
        else
        {
            state.reg[index] = (value[0] | value[1] << 8 | value[2] << 16 | value[3] << 24) >>> 0;
        }
        return;
    }
    const at = address(operand);
    for (let i = 0; i < width; i++)
    {
        state.memory.write(at + i, 1, value[i] & 0xff);
    }
}

// --- lane access ---

const scratch = new DataView(new ArrayBuffer(8));

/** @param {Uint8Array} bytes @param {number} at */
function f32At(bytes, at){
    scratch.setUint8(0, bytes[at]); scratch.setUint8(1, bytes[at + 1]);
    scratch.setUint8(2, bytes[at + 2]); scratch.setUint8(3, bytes[at + 3]);
    return scratch.getFloat32(0, true);
}
/** @param {Uint8Array} bytes @param {number} at @param {number} value */
function putF32(bytes, at, value){
    scratch.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++)
    {
        bytes[at + i] = scratch.getUint8(i);
    }
}
/** @param {Uint8Array} bytes @param {number} at */
function f64At(bytes, at){
    for (let i = 0; i < 8; i++)
    {
        scratch.setUint8(i, bytes[at + i]);
    }
    return scratch.getFloat64(0, true);
}
/** @param {Uint8Array} bytes @param {number} at @param {number} value */
function putF64(bytes, at, value){
    scratch.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++)
    {
        bytes[at + i] = scratch.getUint8(i);
    }
}
/** The processor's negative quiet NaN, per width. */
const F32_INDEFINITE = 0xffc00000;
const F64_INDEFINITE = 0xfff8000000000000n;

/** @param {number} value */
const f32Bits = value=>{
    scratch.setFloat32(0, value, true);
    return scratch.getUint32(0, true);
};
/** @param {number} word */
const f32FromBits = word=>{
    scratch.setUint32(0, word >>> 0, true);
    return scratch.getFloat32(0, true);
};
/** @param {number} value */
const f64Bits = value=>{
    scratch.setFloat64(0, value, true);
    return scratch.getBigUint64(0, true);
};
/** @param {bigint} word */
const f64FromBits = word=>{
    scratch.setBigUint64(0, BigInt.asUintN(64, word), true);
    return scratch.getFloat64(0, true);
};

/**
 * An f32 result with the processor's NaN rule: a NaN whose inputs were all
 * numeric is an invalid operation and becomes the indefinite; a NaN input
 * propagates, quieted.
 *
 * @param {number} value @param {number[]} inputs
 */
function f32Value(value, inputs){
    if (!Number.isNaN(value))
    {
        return value;
    }
    for (const input of inputs)
    {
        if (Number.isNaN(input))
        {
            return f32FromBits(f32Bits(input) | 0x00400000);
        }
    }
    return f32FromBits(F32_INDEFINITE);
}
/** @param {number} value @param {number[]} inputs */
function f64Value(value, inputs){
    if (!Number.isNaN(value))
    {
        return value;
    }
    for (const input of inputs)
    {
        if (Number.isNaN(input))
        {
            return f64FromBits(f64Bits(input) | 0x0008000000000000n);
        }
    }
    return f64FromBits(F64_INDEFINITE);
}

/** @param {number[]} dwords @returns {number[]} */
const byteShuffleOfDwords = dwords=>dwords.flatMap(d=>[d * 4, d * 4 + 1, d * 4 + 2, d * 4 + 3]);

/**
 * dst = op(dst, src) on float lanes; the scalar forms leave dst's upper lanes
 * be. Memory's bytes are addressed through `address`.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} dst
 * @param {import('./decode/decoder.js').Operand} src
 * @param {boolean} scalar @param {boolean} double
 * @param {(a: number, b: number) => number} operation
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 */
function floatBinary(state, dst, src, scalar, double, operation, address){
    const a = readVector(state, dst, 16, address);
    const b = readVector(state, src, scalar ? (double ? 8 : 4) : 16, address);
    const out = new Uint8Array(a);
    const size = double ? 8 : 4;
    const count = scalar ? 1 : double ? 2 : 4;
    for (let i = 0; i < count; i++)
    {
        const x = double ? f64At(a, i * size) : f32At(a, i * size);
        const y = double ? f64At(b, i * size) : f32At(b, i * size);
        const value = operation(x, y);
        if (double)
        {
            putF64(out, i * size, f64Value(value, [x, y]));
        }
        else
        {
            putF32(out, i * size, f32Value(Math.fround(value), [x, y]));
        }
    }
    writeVector(state, dst, 16, address, out);
}

/**
 * dst = op(src) on float lanes; the scalar forms leave dst's upper lanes be.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} dst
 * @param {import('./decode/decoder.js').Operand} src
 * @param {boolean} scalar @param {boolean} double
 * @param {(x: number) => number} operation
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 */
function floatUnary(state, dst, src, scalar, double, operation, address){
    const source = readVector(state, src, scalar ? (double ? 8 : 4) : 16, address);
    const out = new Uint8Array(readVector(state, dst, 16, address));
    const size = double ? 8 : 4;
    const count = scalar ? 1 : double ? 2 : 4;
    for (let i = 0; i < count; i++)
    {
        const x = double ? f64At(source, i * size) : f32At(source, i * size);
        const value = operation(x);
        if (double)
        {
            putF64(out, i * size, f64Value(value, [x]));
        }
        else
        {
            putF32(out, i * size, f32Value(Math.fround(value), [x]));
        }
    }
    writeVector(state, dst, 16, address, out);
}

/**
 * The eight `cmpps` predicates: all ones in a lane when true. Predicates 3
 * and 7 are the unordered and ordered tests; the rest are the compares the
 * host's own NaN rules give.
 *
 * @param {number} predicate @param {number} a @param {number} b
 */
function comparePredicate(predicate, a, b){
    const unordered = Number.isNaN(a) || Number.isNaN(b);
    switch (predicate)
    {
        case 0: return a === b;
        case 1: return a < b;
        case 2: return a <= b;
        case 3: return unordered;
        case 4: return a !== b;
        case 5: return !(a < b);
        case 6: return !(a <= b);
        default: return !unordered;
    }
}

/**
 * A byte shuffle over the two sixteen-byte operands concatenated (`dst`
 * first), as the emitter's wasm shuffle sees them.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} dst
 * @param {import('./decode/decoder.js').Operand} src
 * @param {number[]} pattern
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 */
function shuffleBytes(state, dst, src, pattern, address){
    const both = new Uint8Array(32);
    both.set(readVector(state, dst, 16, address), 0);
    both.set(readVector(state, src, 16, address), 16);
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++)
    {
        out[i] = both[pattern[i]];
    }
    writeVector(state, dst, 16, address, out);
}

/**
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {import('./ir.js').EvalState} state
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @returns {boolean}
 */
export function evaluateSimd(instruction, state, address){
    const { op, operands } = instruction;
    const [dst, src, imm] = operands;
    const width = dst?.kind === 'mm' || src?.kind === 'mm' ? 8 : 16;
    const a = new Uint8Array(16);
    const b = new Uint8Array(16);

    switch (op)
    {
        case 'emms':
            state.empty = 0xff;
            return true;
        case 'movaps': case 'movups': case 'movapd': case 'movupd': case 'movdqa': case 'movdqu':
        case 'lddqu': case 'movntps': case 'movntpd': case 'movntdq':
            writeVector(state, dst, 16, address, readVector(state, src, 16, address));
            return true;
        case 'movss': case 'movsd':
        {
            const lane = op === 'movss' ? 4 : 8;
            if (dst.kind === 'xmm' && src.kind === 'xmm')
            {
                a.set(readVector(state, dst, 16, address));
                b.set(readVector(state, src, 16, address));
                a.set(b.subarray(0, lane), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            if (dst.kind === 'xmm')
            {
                a.fill(0);
                a.set(readVector(state, src, lane, address).subarray(0, lane), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            writeVector(state, dst, lane, address, readVector(state, src, 16, address));
            return true;
        }
        case 'movlps': case 'movlpd': case 'movhps': case 'movhpd':
        {
            const high = op.startsWith('movh');
            if (dst.kind === 'mem')
            {
                a.set(readVector(state, src, 16, address));
                writeVector(state, dst, 8, address, a.subarray(high ? 8 : 0, high ? 16 : 8));
                return true;
            }
            if (src.kind === 'mem')
            {
                a.set(readVector(state, dst, 16, address));
                b.set(readVector(state, src, 8, address));
                a.set(b.subarray(0, 8), high ? 8 : 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            a.set(readVector(state, dst, 16, address));
            b.set(readVector(state, src, 16, address));
            if (high)
            {
                a.set(b.subarray(0, 8), 8);
            }
            else
            {
                a.set(b.subarray(8, 16), 0);
            }
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'movd':
            if (dst.kind === 'xmm')
            {
                a.fill(0);
                a.set(readVector(state, src, 4, address).subarray(0, 4), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            if (dst.kind === 'mm')
            {
                a.fill(0);
                a.set(readVector(state, src, 4, address).subarray(0, 4), 0);
                writeVector(state, dst, 8, address, a);
                return true;
            }
            if (src.kind === 'xmm')
            {
                a.set(readVector(state, src, 16, address));
                writeVector(state, dst, dst.kind === 'mem' ? 4 : 4, address, a.subarray(0, 4));
            }
            else
            {
                a.set(readVector(state, src, 8, address));
                writeVector(state, dst, 4, address, a.subarray(0, 4));
            }
            return true;
        case 'movntq':
            writeVector(state, dst, 8, address, readVector(state, src, 8, address));
            return true;
        case 'movddup':
        {
            a.set(readVector(state, src, src.kind === 'mem' ? 8 : 16, address));
            a.set(a.subarray(0, 8), 8);
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'movsldup': case 'movshdup':
        {
            b.set(readVector(state, src, 16, address));
            const lane = op === 'movsldup' ? 0 : 1;
            a.set(b.subarray(lane * 4, lane * 4 + 4), 0);
            a.set(b.subarray(lane * 4, lane * 4 + 4), 4);
            a.set(b.subarray((2 + lane) * 4, (2 + lane) * 4 + 4), 8);
            a.set(b.subarray((2 + lane) * 4, (2 + lane) * 4 + 4), 12);
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'stmxcsr':
            address(dst);
            state.memory.write(address(dst), 4, state.mxcsr >>> 0);
            return true;
        case 'ldmxcsr':
            state.mxcsr = state.memory.read(address(dst), 4) >>> 0;
            return true;
        case 'movq':
            if (dst.kind === 'mm' || (dst.kind === 'mem' && src.kind === 'mm'))
            {
                writeVector(state, dst, 8, address, readVector(state, src, 8, address));
                return true;
            }
            if (dst.kind === 'xmm')
            {
                a.fill(0);
                a.set(readVector(state, src, 8, address).subarray(0, 8), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            writeVector(state, dst, 8, address, readVector(state, src, 16, address));
            return true;
        case 'movq2dq':
        {
            a.fill(0);
            a.set(readVector(state, src, 8, address).subarray(0, 8), 0);
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'movdq2q':
        {
            a.set(readVector(state, src, 16, address));
            writeVector(state, dst, 8, address, a.subarray(0, 8));
            return true;
        }
        case 'andps': case 'andpd': case 'pand':
        case 'orps': case 'orpd': case 'por':
        case 'xorps': case 'xorpd': case 'pxor':
        case 'andnps': case 'andnpd': case 'pandn':
        {
            a.set(readVector(state, dst, width, address));
            b.set(readVector(state, src, width, address));
            const mode = op.startsWith('andn') || op === 'pandn' ? 'andn'
                : op.startsWith('or') || op === 'por' ? 'or'
                    : op.startsWith('xor') || op === 'pxor' ? 'xor' : 'and';
            for (let i = 0; i < width; i++)
            {
                a[i] = mode === 'and' ? a[i] & b[i]
                    : mode === 'or' ? a[i] | b[i]
                        : mode === 'xor' ? a[i] ^ b[i] : ~a[i] & b[i];
            }
            writeVector(state, dst, width, address, a);
            return true;
        }

        // --- packed and scalar float arithmetic ---
        case 'addps': case 'subps': case 'mulps': case 'divps':
        case 'addpd': case 'subpd': case 'mulpd': case 'divpd':
        case 'addss': case 'subss': case 'mulss': case 'divss':
        case 'addsd': case 'subsd': case 'mulsd': case 'divsd':
        {
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            const base = op.slice(0, 3);
            /** @type {(p: number, q: number) => number} */
            const operation = base === 'add' ? (p, q)=>p + q
                : base === 'sub' ? (p, q)=>p - q
                    : base === 'mul' ? (p, q)=>p * q : (p, q)=>p / q;
            floatBinary(state, dst, src, scalar, double, operation, address);
            return true;
        }
        case 'sqrtps': case 'sqrtpd': case 'sqrtss': case 'sqrtsd':
        {
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            floatUnary(state, dst, src, scalar, double, Math.sqrt, address);
            return true;
        }
        case 'rsqrtps': case 'rsqrtss': case 'rcpps': case 'rcpss':
        {
            const inverseRoot = op.startsWith('rsqrt');
            /** @type {(x: number) => number} */
            const operation = inverseRoot ? x=>1 / Math.sqrt(x) : x=>1 / x;
            floatUnary(state, dst, src, op.endsWith('ss'), false, operation, address);
            return true;
        }
        case 'minps': case 'maxps': case 'minss': case 'maxss':
        case 'minpd': case 'maxpd': case 'minsd': case 'maxsd':
        {
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            const minimum = op.startsWith('min');
            const left = readVector(state, dst, 16, address);
            const right = readVector(state, src, scalar ? (double ? 8 : 4) : 16, address);
            const out = new Uint8Array(left);
            const size = double ? 8 : 4;
            const count = scalar ? 1 : double ? 2 : 4;
            for (let i = 0; i < count; i++)
            {
                const x = double ? f64At(left, i * size) : f32At(left, i * size);
                const y = double ? f64At(right, i * size) : f32At(right, i * size);
                const value = minimum ? (x < y ? x : y) : (x > y ? x : y);
                if (double)
                {
                    putF64(out, i * size, value);
                }
                else
                {
                    putF32(out, i * size, value);
                }
            }
            writeVector(state, dst, 16, address, out);
            return true;
        }
        case 'haddps': case 'hsubps': case 'haddpd': case 'hsubpd':
        {
            const double = op.endsWith('pd');
            const subtract = op.startsWith('hsub');
            const left = readVector(state, dst, 16, address);
            const right = readVector(state, src, 16, address);
            const out = new Uint8Array(16);
            const size = double ? 8 : 4;
            const lanes = double ? 2 : 4;
            const half = lanes / 2;
            for (let i = 0; i < lanes; i++)
            {
                const pair = i < half ? left : right;
                const base = i % half * 2;
                const x = double ? f64At(pair, base * size) : f32At(pair, base * size);
                const y = double ? f64At(pair, (base + 1) * size)
                    : f32At(pair, (base + 1) * size);
                const value = subtract ? x - y : x + y;
                if (double)
                {
                    putF64(out, i * size, f64Value(value, [x, y]));
                }
                else
                {
                    putF32(out, i * size, f32Value(Math.fround(value), [x, y]));
                }
            }
            writeVector(state, dst, 16, address, out);
            return true;
        }
        case 'cmpps': case 'cmppd': case 'cmpss': case 'cmpsd':
        {
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            const predicate = /** @type {number} */ (imm.value) & 7;
            const left = readVector(state, dst, 16, address);
            const right = readVector(state, src, scalar ? (double ? 8 : 4) : 16, address);
            const out = new Uint8Array(left);
            const size = double ? 8 : 4;
            const count = scalar ? 1 : double ? 2 : 4;
            for (let i = 0; i < count; i++)
            {
                const x = double ? f64At(left, i * size) : f32At(left, i * size);
                const y = double ? f64At(right, i * size) : f32At(right, i * size);
                const true_ = comparePredicate(predicate, x, y);
                for (let k = 0; k < size; k++)
                {
                    out[i * size + k] = true_ ? 0xff : 0;
                }
            }
            writeVector(state, dst, 16, address, out);
            return true;
        }
        case 'comiss': case 'ucomiss': case 'comisd': case 'ucomisd':
        {
            const double = op.endsWith('sd');
            const left = readVector(state, dst, 16, address);
            const right = readVector(state, src, double ? 8 : 4, address);
            const x = double ? f64At(left, 0) : f32At(left, 0);
            const y = double ? f64At(right, 0) : f32At(right, 0);
            const unordered = Number.isNaN(x) || Number.isNaN(y);
            const flags = (unordered ? ZF | PF | CF : 0)
                | (!unordered && x === y ? ZF : 0)
                | (!unordered && x < y ? CF : 0);
            const written = instruction.flagsWritten & ~instruction.flagsUndefined;
            state.eflags = (state.eflags & ~written | flags & written) >>> 0;
            return true;
        }
        case 'shufps':
        {
            const s = /** @type {number} */ (imm.value);
            shuffleBytes(state, dst, src,
                byteShuffleOfDwords([s & 3, s >> 2 & 3, 4 + (s >> 4 & 3), 4 + (s >> 6 & 3)]),
                address);
            return true;
        }
        case 'shufpd':
        {
            const s = /** @type {number} */ (imm.value);
            shuffleBytes(state, dst, src, byteShuffleOfDwords([
                (s & 1) * 2, (s & 1) * 2 + 1, 4 + (s >> 1 & 1) * 2, 5 + (s >> 1 & 1) * 2,
            ]), address);
            return true;
        }
        case 'unpcklps': case 'unpckhps': case 'unpcklpd': case 'unpckhpd':
        {
            const high = op.startsWith('unpckh');
            const double = op.endsWith('pd');
            shuffleBytes(state, dst, src, byteShuffleOfDwords(double
                ? (high ? [2, 3, 6, 7] : [0, 1, 4, 5])
                : (high ? [2, 6, 3, 7] : [0, 4, 1, 5])), address);
            return true;
        }
        case 'movmskps': case 'movmskpd':
        {
            const vector = readVector(state, src, 16, address);
            let mask = 0;
            if (op === 'movmskpd')
            {
                for (let i = 0; i < 2; i++)
                {
                    mask |= (vector[i * 8 + 7] >> 7 & 1) << i;
                }
            }
            else
            {
                for (let i = 0; i < 4; i++)
                {
                    mask |= (vector[i * 4 + 3] >> 7 & 1) << i;
                }
            }
            state.reg[/** @type {number} */ (dst.reg)] = mask >>> 0;
            return true;
        }

        default:
            return false;
    }
}

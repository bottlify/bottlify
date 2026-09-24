/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 in the evaluator (plan step 5.2, the family order of `emit/x87.js`):
 * the eight physical registers as doubles on the state, the top and the
 * empty mask as the block's words, every rule the emitter follows -- the
 * indefinite, the stack faults and C1, precision control, the tag word, the
 * condition bits. Where the emitter keeps a compile-time permutation of the
 * locals, the evaluator addresses `ST(i)` as physical `(top + i) & 7`: the
 * two are the same machine.
 */

/** Status word bits. */
const Status = Object.freeze({
    IE: 0x1, ZE: 0x4, UE: 0x10, SF: 0x40, C0: 0x100, C1: 0x200, C2: 0x400, C3: 0x4000,
    CONDITION: 0x100 | 0x200 | 0x400 | 0x4000,
});

/** The default control word `fninit` leaves. */
const DEFAULT_CONTROL = 0x37f;

/** The arithmetic flags a condition code selects, as `fcmov` needs. @param {number} cc @param {number} eflags */
function condition(cc, eflags){
    const cf = (eflags & 0x1) !== 0;
    const pf = (eflags & 0x4) !== 0;
    const zf = (eflags & 0x40) !== 0;
    const sf = (eflags & 0x80) !== 0;
    const of = (eflags & 0x800) !== 0;
    return [
        of, !of, cf, !cf,
        zf, !zf, cf || zf, !cf && !zf,
        sf, !sf, pf, !pf, sf !== of, sf === of, zf || sf !== of, !(zf || sf !== of),
    ][cc] ?? false;
}
/** The eight escape bytes and the wait. */
const X87_OPCODE = /^(9b$|d[89a-f] )/;

/** @param {import('./decode/decoder.js').Instruction} instruction */
export function isX87Op(instruction){
    return X87_OPCODE.test(instruction.opcode);
}

const scratch = new ArrayBuffer(8);
const scratchF = new Float64Array(scratch);
const scratchI = new BigInt64Array(scratch);
const scratchF32 = new Float32Array(scratch);
const scratchU32 = new Uint32Array(scratch);
/** @param {number} value */
const bits = value=>{
    scratchF[0] = value;
    return scratchI[0];
};
/** @param {bigint} value */
const fromBits = value=>{
    scratchI[0] = BigInt.asIntN(64, value);
    return scratchF[0];
};
/** The processor's negative quiet NaN. */
const INDEFINITE = fromBits(0xfff8000000000000n);

/** Pushes the indefinite when the guard fired. @param {number} value @param {number} t1 */
const orIndefinite = (value, t1)=>t1 !== 0 ? INDEFINITE : value;

/**
 * The stack-fault check: t1 is set when a source ST(i) is empty or a push
 * finds its register held, and IE and SF are raised. A push that overflowed
 * also sets C1.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {number[]} sources @param {boolean} pushes
 * @returns {number}
 */
function guard(state, sources, pushes){
    let read = 0;
    for (const i of sources)
    {
        read |= 1 << ((state.top + i) & 7);
    }
    let t1 = read !== 0 && (state.empty & read) !== 0 ? 1 : 0;
    if (pushes && ((state.empty >>> ((state.top - 1) & 7)) & 1) === 0)
    {
        t1 = 1;
    }
    if (t1)
    {
        state.status |= Status.IE | Status.SF;
    }
    if (pushes)
    {
        if (((state.empty >>> ((state.top - 1) & 7)) & 1) === 0)
        {
            state.status |= Status.C1;
        }
        else
        {
            state.status &= ~Status.C1;
        }
    }
    return t1;
}

/**
 * Rounds the f64 to a float when precision control says single (PC = 00):
 * the processor's 24-bit results, in the double's own bits so the exponent
 * range stays extended.
 *
 * @param {number} value @param {import('./ir.js').EvalState} state
 */
function byPrecision(value, state){
    if ((state.control & 0x300) !== 0)
    {
        return value;
    }
    // Round to nearest even at bit 29 of the double's bits, as two words: the
    // low word's sum carries into the high one.
    scratchF[0] = value;
    if ((scratchU32[1] & 0x7ff00000) === 0x7ff00000)
    {
        return value;
    }
    const sum = scratchU32[0] + ((scratchU32[0] >>> 29) & 1) + 0x0fffffff;
    scratchU32[0] = sum & 0xe0000000;
    scratchU32[1] += sum >= 4294967296 ? 1 : 0;
    return scratchF[0];
}

/** @param {number} value @param {number} control */
function roundBy(value, control){
    if (Number.isNaN(value) || !Number.isFinite(value) || value === 0)
    {
        return value;
    }
    const mode = (control >>> 10) & 3;
    if (mode === 1)
    {
        return Math.floor(value);
    }
    if (mode === 2)
    {
        return Math.ceil(value);
    }
    if (mode === 3)
    {
        return Math.trunc(value);
    }
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff < 0.5)
    {
        return floor;
    }
    if (diff > 0.5)
    {
        return floor + 1;
    }
    return floor % 2 === 0 ? floor : floor + 1;
}

/** @param {number} value @param {number[]} inputs */
function hostNaN(value, inputs){
    if (!Number.isNaN(value) || inputs.some(input=>Number.isNaN(input)))
    {
        return value;
    }
    return fromBits(bits(value) | -0x8000000000000000n);
}

/** @param {number} value */
function signalling(value){
    return Number.isNaN(value) && (bits(value) & (1n << 51n)) === 0n;
}

/** @param {import('./ir.js').EvalState} state @param {number} address @param {number} size */
function readMem(state, address, size){
    if (size === 8)
    {
        const low = state.memory.read(address, 4);
        return BigInt(state.memory.read(address + 4, 4)) << 32n | BigInt(low);
    }
    return BigInt(state.memory.read(address, size));
}

/**
 * A memory operand's low and high words as numbers, for the loads that need no
 * BigInt: a double's bits are two words.
 *
 * @param {import('./ir.js').EvalState} state @param {number} address
 */
function readWords(state, address){
    scratchU32[0] = state.memory.read(address, 4);
    scratchU32[1] = state.memory.read(address + 4, 4);
}

/**
 * Writes the scratch's two words: a store of a double, or of a quadword the
 * scratch holds.
 *
 * @param {import('./ir.js').EvalState} state @param {number} address
 */
function writeWords(state, address){
    state.memory.write(address, 4, scratchU32[0]);
    state.memory.write(address + 4, 4, scratchU32[1]);
}

/** @param {import('./ir.js').EvalState} state @param {number} address @param {number} size @param {number | bigint} value */
function writeMem(state, address, size, value){
    const word = BigInt.asUintN(64, BigInt(value));
    if (size === 8)
    {
        state.memory.write(address, 4, Number(word & 0xffffffffn));
        state.memory.write(address + 4, 4, Number(word >> 32n));
        return;
    }
    state.memory.write(address, size, Number(BigInt.asUintN(size * 8, word)));
}

/**
 * Writes an integer-valued double as a quadword, two's complement, without a
 * BigInt: the high word is the floor of a division by 2^32, and what is left
 * is exact.
 *
 * @param {import('./ir.js').EvalState} state @param {number} address @param {number} value
 */
function writeQuad(state, address, value){
    const high = Math.floor(value / 4294967296);
    state.memory.write(address, 4, (value - high * 4294967296) >>> 0);
    state.memory.write(address + 4, 4, high >>> 0);
}

/**
 * The ten-byte extended value `low` (mantissa) and `high` (sign and exponent)
 * as a double.
 *
 * @param {bigint} low @param {number} high
 */
function f80ToF64(low, high){
    if ((high & 0x7fff) === 0x7fff)
    {
        return low << 1n === 0n ? Infinity : NaN;
    }
    if (low === 0n)
    {
        return 0;
    }
    let value = Number(BigInt.asUintN(64, low));
    let e = (high & 0x7fff) - 16446;
    for (let pass = 0; pass < 2; pass++)
    {
        const k = Math.max(-1022, Math.min(1023, e));
        value *= 2 ** k;
        e -= k;
    }
    return (high & 0x8000) !== 0 ? -value : value;
}

/** @param {import('./ir.js').EvalState} state @param {number} at @param {number} value */
function writeF80(state, at, value){
    const word = BigInt.asUintN(64, bits(value));
    const fraction = word & 0x000fffffffffffffn;
    const rawExponent = Number(word >> 52n & 0x7ffn);
    let signExponent = Number(word >> 63n & 1n) << 15;
    let mantissa;
    if (rawExponent === 0x7ff)
    {
        mantissa = fraction << 11n | -0x8000000000000000n;
        signExponent |= 0x7fff;
    }
    else if (rawExponent === 0 && fraction === 0n)
    {
        mantissa = 0n;
    }
    else if (rawExponent === 0)
    {
        let count = 64;
        for (let probe = fraction; probe !== 0n; probe >>= 1n)
        {
            count--;
        }
        mantissa = fraction << BigInt(count);
        signExponent |= 15372 - count;
    }
    else
    {
        mantissa = fraction << 11n | -0x8000000000000000n;
        signExponent |= rawExponent + 15360;
    }
    writeMem(state, at, 8, mantissa);
    state.memory.write(at + 8, 2, signExponent & 0xffff);
}

/** The tag word, two bits per physical register. @param {import('./ir.js').EvalState} state */
function tagWord(state){
    let word = 0;
    for (let k = 0; k < 8; k++)
    {
        const value = state.f80[k];
        const tag = (state.empty >>> k & 1) !== 0 ? 3
            : Number.isNaN(value) ? 2 : value === 0 ? 1 : 0;
        word |= tag << (2 * k);
    }
    return word & 0xffff;
}

/** The status word with the top folded into bits 11..13. @param {import('./ir.js').EvalState} state */
function statusWord(state){
    return (state.status & ~0x3800 | state.top << 11) & 0xffff;
}

/** @param {import('./ir.js').EvalState} state @param {number} address @param {number} size */
function loadFloat(state, address, size){
    if (size === 10)
    {
        const high = state.memory.read(address + 8, 2);
        const low = BigInt.asUintN(64, readMem(state, address, 8));
        if ((high & 0x7fff) === 0x7fff && (low & 0x7fffffffffffffffn) > 0x4000000000000000n)
        {
            state.status |= Status.IE;
        }
        return f80ToF64(low, high);
    }
    // A signalling NaN raises IE and loads quieted.
    if (size === 4)
    {
        let word = state.memory.read(address, 4);
        if ((word & 0x7fffffff) > 0x7f800000 && (word & 0x400000) === 0)
        {
            state.status |= Status.IE;
            word |= 0x400000;
        }
        scratchU32[0] = word;
        return scratchF32[0];
    }
    readWords(state, address);
    const high = scratchU32[1] & 0x7fffffff;
    if ((high > 0x7ff00000 || (high === 0x7ff00000 && scratchU32[0] !== 0))
        && (high & 0x80000) === 0)
    {
        state.status |= Status.IE;
        scratchU32[1] |= 0x80000;
    }
    return scratchF[0];
}

/** @param {import('./ir.js').EvalState} state @param {number} address @param {number} size @param {number} value */
function storeFloat(state, address, size, value){
    if (size === 10)
    {
        writeF80(state, address, value);
        return;
    }
    if (size === 4)
    {
        if (Math.abs(value) < 2 ** -126 && value !== 0)
        {
            state.status |= Status.UE;
        }
        scratchF32[0] = Math.fround(value);
        state.memory.write(address, 4, scratchU32[0]);
        return;
    }
    scratchF[0] = value;
    writeWords(state, address);
}

/**
 * Stores the value as an integer of the operand's width, rounded to nearest
 * (or truncated); a NaN or a value out of range stores the integer indefinite
 * and raises IE.
 *
 * @param {import('./ir.js').EvalState} state @param {number} address @param {number} size
 * @param {number} value @param {boolean} truncate
 */
function storeInt(state, address, size, value, truncate){
    const rounded = truncate ? Math.trunc(value) : roundBy(value, state.control);
    const limit = size === 2 ? 32768 : size === 4 ? 2147483648 : 2 ** 63;
    if (!(rounded >= -limit && rounded < limit))
    {
        state.status |= Status.IE;
        if (size === 8)
        {
            writeMem(state, address, 8, -0x8000000000000000n);
        }
        else
        {
            writeMem(state, address, size, size === 2 ? 0x8000n : 0x80000000n);
        }
        return;
    }
    if (size === 8)
    {
        writeQuad(state, address, Math.trunc(rounded));
    }
    else
    {
        state.memory.write(address, size, (Math.trunc(rounded) & (size === 2 ? 0xffff : -1)) >>> 0);
    }
}

/**
 * Compares `a` and `c` into C3 C2 C0; C1 is cleared. Ordered (fcom) raises IE
 * on any NaN, unordered (fucom) on a signalling one.
 *
 * @param {import('./ir.js').EvalState} state @param {number} a @param {number} c
 * @param {boolean} ordered @param {number} t1
 */
function conditionBits(state, a, c, ordered, t1){
    state.status &= ~Status.CONDITION;
    if (Number.isNaN(a) || Number.isNaN(c) || t1 !== 0)
    {
        state.status |= Status.C3 | Status.C2 | Status.C0;
        if (ordered || signalling(a) || signalling(c))
        {
            state.status |= Status.IE;
        }
    }
    else
    {
        if (a === c)
        {
            state.status |= Status.C3;
        }
        if (a < c)
        {
            state.status |= Status.C0;
        }
    }
}

/**
 * The x87 instruction, or false when the evaluator has no case for it.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {import('./ir.js').EvalState} state
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @returns {boolean}
 */
export function evaluateX87(instruction, state, address){
    const { op, operands } = instruction;
    /** ST(i). @param {number} i */
    const st = i=>state.f80[(state.top + i) & 7];
    /** @param {number} i @param {number} value */
    const setSt = (i, value)=>{
        state.f80[(state.top + i) & 7] = value;
    };
    const [dst, src] = operands;
    /** @param {number} times */
    const popN = times=>{
        for (let n = 0; n < times; n++)
        {
            state.empty |= 1 << state.top;
            state.top = (state.top + 1) & 7;
        }
    };
    /** @param {number} value */
    const pushValue = value=>{
        const top = (state.top - 1) & 7;
        state.f80[top] = value;
        state.empty &= ~(1 << top);
        state.top = top;
    };
    /** @param {import('./decode/decoder.js').Operand} operand */
    const at = operand=>address(operand);

    switch (op)
    {
        case 'fwait': case 'fnop':
            return true;
        case 'fnclex':
            state.status &= 0x7f00;
            return true;
        case 'fninit':
            state.top = 0;
            state.empty = 0xff;
            state.status = 0;
            state.control = DEFAULT_CONTROL;
            return true;
        case 'fld':
            if (src.kind === 'x87')
            {
                pushValue(orIndefinite(st(Number(src.reg)), guard(state, [Number(src.reg)], true)));
            }
            else
            {
                const value = loadFloat(state, at(src), src.size);
                pushValue(orIndefinite(value, guard(state, [], true)));
            }
            return true;
        case 'fild':
        {
            const value = readMem(state, at(src), src.size);
            const signed = src.size === 2 ? Number(BigInt.asIntN(16, value))
                : src.size === 4 ? Number(BigInt.asIntN(32, value))
                    : Number(BigInt.asIntN(64, value));
            pushValue(orIndefinite(signed, guard(state, [], true)));
            return true;
        }
        case 'fld1': case 'fldz': case 'fldpi': case 'fldl2e': case 'fldln2': case 'fldlg2':
        case 'fldl2t':
        {
            const value = {
                fld1: 1, fldz: 0, fldpi: Math.PI, fldl2e: Math.LOG2E, fldln2: Math.LN2,
                fldlg2: Math.log10(2), fldl2t: Math.log2(10),
            }[op] ?? 0;
            pushValue(orIndefinite(value, guard(state, [], true)));
            return true;
        }
        case 'fst': case 'fstp':
        {
            const value = orIndefinite(st(0), guard(state, [0], false));
            if (dst.kind === 'x87')
            {
                setSt(Number(dst.reg), value);
                state.empty &= ~(1 << ((state.top + Number(dst.reg)) & 7));
            }
            else
            {
                storeFloat(state, at(dst), dst.size, value);
            }
            if (op === 'fstp')
            {
                popN(1);
            }
            return true;
        }
        case 'fist': case 'fistp': case 'fisttp':
        {
            const value = orIndefinite(st(0), guard(state, [0], false));
            storeInt(state, at(dst), dst.size, value, op === 'fisttp');
            if (op !== 'fist')
            {
                popN(1);
            }
            return true;
        }
        case 'fxch':
        {
            const i = Number(src.reg);
            guard(state, [0, i], false);
            const a = state.top;
            const c = (state.top + i) & 7;
            const swap = state.f80[a];
            state.f80[a] = state.f80[c];
            state.f80[c] = swap;
            return true;
        }
        case 'ffree': case 'ffreep':
            state.empty |= 1 << ((state.top + Number(dst.reg)) & 7);
            if (op === 'ffreep')
            {
                popN(1);
            }
            return true;
        case 'fincstp':
            state.top = (state.top + 1) & 7;
            return true;
        case 'fdecstp':
            state.top = (state.top - 1) & 7;
            return true;
        case 'fchs':
            setSt(0, orIndefinite(-st(0), guard(state, [0], false)));
            return true;
        case 'fabs':
            setSt(0, orIndefinite(Math.abs(st(0)), guard(state, [0], false)));
            return true;
        case 'fsqrt':
        {
            const t1 = guard(state, [0], false);
            if (st(0) < 0)
            {
                state.status |= Status.IE;
            }
            setSt(0, orIndefinite(byPrecision(hostNaN(Math.sqrt(st(0)), [st(0)]), state), t1));
            return true;
        }
        case 'fldcw':
            state.control = state.memory.read(at(src ?? dst), 2) & 0xffff;
            return true;
        case 'frndint':
            setSt(0, orIndefinite(roundBy(st(0), state.control), guard(state, [0], false)));
            return true;
        case 'fscale':
        {
            const t1 = guard(state, [0, 1], false);
            let count = Math.trunc(st(1));
            count = Math.max(-2100, Math.min(2100, Number.isNaN(count) ? 0 : count));
            let value = st(0);
            for (let pass = 0; pass < 2; pass++)
            {
                const k = Math.max(-1022, Math.min(1023, count));
                value *= 2 ** k;
                count -= k;
            }
            setSt(0, orIndefinite(value, t1));
            return true;
        }
        case 'fxtract':
        {
            const t1 = guard(state, [0], true);
            const original = st(0);
            let value = original;
            let exponent = 0;
            let significand;
            if (value === 0)
            {
                state.status |= Status.ZE;
                exponent = -Infinity;
                significand = original;
            }
            else
            {
                if (Math.abs(value) < 2 ** -1022)
                {
                    value *= 2 ** 54;
                    exponent = -54;
                }
                const word = bits(value);
                exponent += Number(word >> 52n & 0x7ffn) - 1023;
                significand = fromBits(word & -0x7ff0000000000001n | 0x3ff0000000000000n);
            }
            if (Number.isNaN(value) || Math.abs(value) === Infinity)
            {
                setSt(0, orIndefinite(original, t1));
                pushValue(orIndefinite(original, t1));
                return true;
            }
            setSt(0, orIndefinite(exponent, t1));
            pushValue(orIndefinite(significand, t1));
            return true;
        }
        case 'fsin': case 'fcos': case 'fsincos': case 'fptan':
        {
            const t1 = guard(state, [0], op === 'fsincos' || op === 'fptan');
            state.status &= ~Status.C2;
            const value = st(0);
            if (Math.abs(value) < 2 ** 63 && !Number.isNaN(value) && t1 === 0)
            {
                if (op === 'fsincos')
                {
                    setSt(0, Math.sin(value));
                    pushValue(Math.cos(value));
                }
                else if (op === 'fptan')
                {
                    setSt(0, Math.tan(value));
                    pushValue(1);
                }
                else
                {
                    setSt(0, op === 'fsin' ? Math.sin(value) : Math.cos(value));
                }
            }
            else if (Number.isNaN(value) || t1 !== 0)
            {
                setSt(0, INDEFINITE);
                if (op === 'fsincos' || op === 'fptan')
                {
                    pushValue(INDEFINITE);
                }
            }
            else
            {
                state.status |= Status.C2;
            }
            return true;
        }
        case 'fpatan':
            setSt(1, orIndefinite(Math.atan2(st(1), st(0)), guard(state, [0, 1], false)));
            popN(1);
            return true;
        case 'f2xm1':
            setSt(0, orIndefinite(Math.expm1(st(0) * Math.LN2), guard(state, [0], false)));
            return true;
        case 'fyl2x': case 'fyl2xp1':
        {
            const t1 = guard(state, [0, 1], false);
            let result;
            if (op === 'fyl2x')
            {
                if (st(0) === 0 && Math.abs(st(1)) < Infinity && st(1) !== 0)
                {
                    state.status |= Status.ZE;
                }
                if (st(0) < 0)
                {
                    state.status |= Status.IE;
                }
                result = st(1) * Math.log2(st(0));
            }
            else
            {
                if (st(0) < -1)
                {
                    state.status |= Status.IE;
                }
                result = st(1) * (Math.log1p(st(0)) / Math.LN2);
            }
            setSt(1, orIndefinite(result, t1));
            popN(1);
            return true;
        }
        case 'fprem': case 'fprem1':
        {
            const t1 = guard(state, [0, 1], false);
            const a = st(0);
            const c = st(1);
            if (Number.isNaN(a) || Number.isNaN(c) || Math.abs(a) === Infinity
                || c === 0 || t1 !== 0)
            {
                state.status |= Status.IE;
                setSt(0, INDEFINITE);
                return true;
            }
            state.status &= ~(Status.C2 | Status.C0 | Status.C3 | Status.C1);
            let q = a / c;
            if (Math.abs(q) < 2 ** 63)
            {
                q = op === 'fprem' ? Math.trunc(q) : roundBy(q, 0);
                setSt(0, a - q * c);
                const low = BigInt.asIntN(32, BigInt(Math.trunc(Math.abs(q))));
                if ((low & 4n) !== 0n)
                {
                    state.status |= Status.C0;
                }
                if ((low & 2n) !== 0n)
                {
                    state.status |= Status.C3;
                }
                if ((low & 1n) !== 0n)
                {
                    state.status |= Status.C1;
                }
            }
            else
            {
                setSt(0, a - Math.trunc(q * 2 ** -32) * 2 ** 32 * c);
                state.status |= Status.C2;
            }
            return true;
        }
        case 'fadd': case 'fsub': case 'fsubr': case 'fmul': case 'fdiv': case 'fdivr':
        case 'faddp': case 'fsubp': case 'fsubrp': case 'fmulp': case 'fdivp': case 'fdivrp':
        case 'fiadd': case 'fisub': case 'fisubr': case 'fimul': case 'fidiv': case 'fidivr':
        {
            const base = op.replace(/^fi/, 'f').replace(/p$/, '');
            const reversed = base.endsWith('r');
            const kind = reversed ? base.slice(0, -1) : base;
            const target = dst.kind === 'x87' ? Number(dst.reg) : 0;
            const t1 = guard(state, src.kind === 'x87' ? [target, Number(src.reg)] : [target],
                false);
            const a0 = st(target);
            let c0;
            if (src.kind === 'x87')
            {
                c0 = st(Number(src.reg));
            }
            else if (op.startsWith('fi'))
            {
                const raw = readMem(state, at(src), src.size);
                c0 = src.size === 2 ? Number(BigInt.asIntN(16, raw))
                    : Number(BigInt.asIntN(32, raw));
            }
            else
            {
                c0 = loadFloat(state, at(src), src.size);
            }
            const [a, c] = reversed ? [c0, a0] : [a0, c0];
            let result;
            if (kind === 'fadd')
            {
                result = a + c;
            }
            else if (kind === 'fsub')
            {
                result = a - c;
            }
            else if (kind === 'fmul')
            {
                result = a * c;
            }
            else
            {
                result = a / c;
            }
            result = hostNaN(byPrecision(result, state), [a0, c0]);
            setSt(target, orIndefinite(result, t1));
            if (t1 === 0)
            {
                if (kind === 'fdiv' && c === 0 && a !== 0 && Math.abs(a) < Infinity)
                {
                    state.status |= Status.ZE;
                }
                if (Number.isNaN(result) && !Number.isNaN(a0) && !Number.isNaN(c0))
                {
                    state.status |= Status.IE;
                }
            }
            if (op.endsWith('p'))
            {
                popN(1);
            }
            return true;
        }
        case 'fcom': case 'fcomp': case 'fcompp': case 'fucom': case 'fucomp': case 'fucompp':
        case 'ftst': case 'ficom': case 'ficomp':
        {
            let t1;
            let c0;
            if (op === 'ficom' || op === 'ficomp')
            {
                t1 = guard(state, [0], false);
                const raw = readMem(state, at(src), src.size);
                c0 = src.size === 2 ? Number(BigInt.asIntN(16, raw))
                    : Number(BigInt.asIntN(32, raw));
            }
            else if (op === 'ftst')
            {
                t1 = guard(state, [0], false);
                c0 = 0;
            }
            else if (op === 'fcompp' || op === 'fucompp')
            {
                t1 = guard(state, [0, 1], false);
                c0 = st(1);
            }
            else if (src.kind === 'x87')
            {
                t1 = guard(state, [0, Number(src.reg)], false);
                c0 = st(Number(src.reg));
            }
            else
            {
                t1 = guard(state, [0], false);
                c0 = loadFloat(state, at(src), src.size);
            }
            conditionBits(state, st(0), c0, !op.startsWith('fu'), t1);
            popN(op.endsWith('pp') ? 2 : op.endsWith('p') ? 1 : 0);
            return true;
        }
        case 'fcomi': case 'fcomip': case 'fucomi': case 'fucomip':
        {
            const empty = guard(state, [0, Number(src.reg)], false);
            const a = st(0);
            const c = st(Number(src.reg));
            const t1 = empty !== 0 || Number.isNaN(a) || Number.isNaN(c) ? 1 : 0;
            state.eflags &= ~(0x40 | 0x04 | 0x01 | 0x10 | 0x80 | 0x800);
            if (t1)
            {
                state.eflags |= 0x40 | 0x04 | 0x01;
            }
            if (t1 || a === c)
            {
                state.eflags |= 0x40;
            }
            if (t1 || a < c)
            {
                state.eflags |= 0x01;
            }
            if (t1 && (!op.startsWith('fu') || signalling(a) || signalling(c)))
            {
                state.status |= Status.IE;
            }
            state.status &= ~Status.C1;
            popN(op.endsWith('p') ? 1 : 0);
            return true;
        }
        case 'fcmovb': case 'fcmove': case 'fcmovbe': case 'fcmovu':
        case 'fcmovnb': case 'fcmovne': case 'fcmovnbe': case 'fcmovnu':
            guard(state, [0, Number(src.reg)], false);
            if (condition(/** @type {number} */ (instruction.cc), state.eflags))
            {
                setSt(0, st(Number(src.reg)));
            }
            return true;
        case 'fxam':
        {
            const value = st(0);
            state.status &= ~Status.CONDITION;
            state.status &= ~Status.C1;
            if (bits(value) < 0n)
            {
                state.status |= Status.C1;
            }
            if (((state.empty >>> state.top) & 1) !== 0)
            {
                state.status |= Status.C3 | Status.C0;
            }
            else if (Number.isNaN(value))
            {
                state.status |= Status.C0;
            }
            else if (Math.abs(value) === Infinity)
            {
                state.status |= Status.C2 | Status.C0;
            }
            else if (value === 0)
            {
                state.status |= Status.C3;
            }
            else
            {
                state.status |= Status.C2;
            }
            return true;
        }
        case 'fnstsw':
        {
            const word = statusWord(state);
            if (dst.kind === 'reg')
            {
                state.reg[0] = (state.reg[0] & 0xffff0000 | word) >>> 0;
            }
            else
            {
                state.memory.write(at(dst), 2, word);
            }
            return true;
        }
        case 'fnstcw':
            state.memory.write(at(dst), 2, state.control);
            return true;
        case 'fnstenv': case 'fnsave':
        {
            const save = op === 'fnsave';
            const where = at(dst);
            state.memory.write(where, 4, (state.control | 0xffff0000) >>> 0);
            state.memory.write(where + 4, 4, (statusWord(state) | 0xffff0000) >>> 0);
            state.memory.write(where + 8, 4, (tagWord(state) | 0xffff0000) >>> 0);
            state.memory.write(where + 12, 4, 0);
            state.memory.write(where + 16, 4, 0);
            state.memory.write(where + 20, 4, 0);
            state.memory.write(where + 24, 4, 0xffff0000);
            if (save)
            {
                for (let i = 0; i < 8; i++)
                {
                    writeF80(state, where + 28 + 10 * i, st(i));
                }
                state.top = 0;
                state.empty = 0xff;
                state.status = 0;
                state.control = DEFAULT_CONTROL;
            }
            return true;
        }
        case 'fldenv': case 'frstor':
        {
            const restore = op === 'frstor';
            const where = at(src ?? dst);
            state.control = state.memory.read(where, 2);
            const word = state.memory.read(where + 4, 2);
            state.status = word & ~0x3800;
            state.top = (word >>> 11) & 7;
            const tags = state.memory.read(where + 8, 2);
            state.empty = 0;
            for (let k = 0; k < 8; k++)
            {
                if (((tags >>> (2 * k)) & 3) === 3)
                {
                    state.empty |= 1 << k;
                }
            }
            if (restore)
            {
                for (let k = 0; k < 8; k++)
                {
                    const index = (k - state.top) & 7;
                    const low = readMem(state, where + 28 + 10 * index, 8);
                    const high = state.memory.read(where + 28 + 10 * index + 8, 2);
                    state.f80[k] = f80ToF64(BigInt.asUintN(64, low), high);
                }
            }
            return true;
        }
        case 'fbstp':
        {
            // ST(0) as an 18-digit packed BCD integer, rounded by the control
            // word, ten bytes least significant first with the sign last; a
            // NaN or a value past 999 999 999 999 999 999 stores the 80-bit
            // integer indefinite, as the processor does.
            const value = orIndefinite(st(0), guard(state, [0], false));
            const where = address(dst);
            const rounded = roundBy(value, state.control);
            const magnitude = Math.abs(rounded);
            if (!(magnitude < 1e18))
            {
                state.status |= Status.IE;
                for (let i = 0; i < 9; i++)
                {
                    state.memory.write(where + i, 1, i === 7 ? 0xc0 : i === 8 ? 0xff : 0);
                }
                state.memory.write(where + 9, 1, 0xff);
            }
            else
            {
                let rest = Math.trunc(magnitude);
                const bytes = new Uint8Array(10);
                for (let i = 0; i < 18; i++)
                {
                    const digit = rest % 10;
                    rest = Math.floor(rest / 10);
                    bytes[i >> 1] |= digit << ((i & 1) * 4);
                }
                bytes[9] = (bits(value) >> 63n) !== 0n ? 0x80 : 0;
                for (let i = 0; i < 10; i++)
                {
                    state.memory.write(where + i, 1, bytes[i]);
                }
            }
            popN(1);
            return true;
        }
        case 'fxsave': case 'fxrstor': case 'fbld':
            return false;
        default:
            return false;
    }
}

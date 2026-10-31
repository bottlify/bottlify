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

/** The forms that write no register: what a quadword `fild` left stays exact across them. */
const KEEPS_EXACT = new Set([
    'fwait', 'fnop', 'fnclex', 'fldcw', 'fnstsw', 'fnstcw', 'fnstenv', 'fxch', 'fcom', 'fucom',
    'ftst', 'ficom', 'fxam', 'fcomi', 'fucomi', 'fist',
]);
/** The forms that write no register and pop ST(0), or ST(0) and ST(1). */
const POPS_EXACT = new Set([
    'fcomp', 'fucomp', 'ficomp', 'fcomip', 'fucomip', 'fistp', 'fisttp', 'fcompp', 'fucompp',
]);
/** The forms that push and write nothing else. */
const PUSHES_EXACT = new Set([
    'fld', 'fild', 'fld1', 'fldz', 'fldpi', 'fldl2e', 'fldln2', 'fldlg2', 'fldl2t',
]);
/** The arithmetic, which writes its destination and pops in its `p` forms. */
const ARITHMETIC = new Set([
    'fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr', 'faddp', 'fsubp', 'fsubrp', 'fmulp',
    'fdivp', 'fdivrp', 'fiadd', 'fisub', 'fisubr', 'fimul', 'fidiv', 'fidivr',
]);

/**
 * What an x87 instruction does to the registers holding an exact quadword
 * (`fild m64`, whose 64 bits a double does not keep): the registers it writes
 * and the ones it pops, as masks of `slot`'s entries for ST(i) at `top` -- the
 * translator's locals, or the physical registers with `slot` the identity.
 * Null for any form not listed, after which none is exact. A quadword `fistp`
 * or `fisttp` of an exact register stores the quadword; everything else reads
 * the double as before. An exchange writes nothing here: the translator's
 * tracker swaps which locals are the two places, and the evaluator moves the
 * mark with the value it swaps.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {number} top @param {readonly number[]} slot
 * @returns {{ written: number, popped: number } | null}
 */
export function exactWrites(instruction, top, slot){
    const { op, operands } = instruction;
    const [dst] = operands;
    /** @param {number} i */
    const bit = i=>1 << slot[(top + i) & 7];
    if (KEEPS_EXACT.has(op) || op === 'fst' && dst.kind !== 'x87')
    {
        return { written: 0, popped: 0 };
    }
    if (POPS_EXACT.has(op) || op === 'fstp' && dst.kind !== 'x87')
    {
        return { written: 0, popped: op.endsWith('pp') ? bit(0) | bit(1) : bit(0) };
    }
    if (PUSHES_EXACT.has(op))
    {
        return { written: bit(-1), popped: 0 };
    }
    if (op === 'fst' || op === 'fstp')
    {
        return { written: bit(Number(dst.reg)), popped: op === 'fstp' ? bit(0) : 0 };
    }
    if (ARITHMETIC.has(op))
    {
        return {
            written: bit(dst.kind === 'x87' ? Number(dst.reg) : 0),
            popped: op.endsWith('p') ? bit(0) : 0,
        };
    }
    return null;
}

/** The physical registers as their own slots. */
const IDENTITY = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);

/** The registers the instruction being evaluated made exact: a quadword load, or a copy. */
let made = 0;

// The stack's accessors, as functions of the state rather than closures made
// again for every instruction: a C library's `long double` routine runs a few
// x87 instructions at a time through here, and the closures were most of what
// an instruction cost.

/** ST(i). @param {import('./ir.js').EvalState} state @param {number} i */
const stOf = (state, i)=>state.f80[(state.top + i) & 7];

/** @param {import('./ir.js').EvalState} state @param {number} i @param {number} value */
const setStOf = (state, i, value)=>{
    // Held after it: an instruction whose source was empty writes the
    // indefinite there, and the processor tags the register valid.
    state.f80[(state.top + i) & 7] = value;
    state.empty &= ~(1 << ((state.top + i) & 7));
};

/** @param {import('./ir.js').EvalState} state @param {number} times */
const popOf = (state, times)=>{
    for (let n = 0; n < times; n++)
    {
        state.empty |= 1 << state.top;
        state.top = (state.top + 1) & 7;
    }
};

/** @param {import('./ir.js').EvalState} state @param {number} value */
const pushOf = (state, value)=>{
    const top = (state.top - 1) & 7;
    state.f80[top] = value;
    state.empty &= ~(1 << top);
    state.top = top;
};

/**
 * Carries an exact quadword with its value, between physical registers.
 *
 * @param {import('./ir.js').EvalState} state @param {number} from @param {number} to
 */
const copyExactOf = (state, from, to)=>{
    if ((state.x87Exact >>> from & 1) !== 0)
    {
        state.x87Shadow[to] = state.x87Shadow[from];
        made |= 1 << to;
    }
};

/** The sources `guard` is given, made once: none, ST(i), and ST(i) with ST(j). */
const NO_SOURCE = Object.freeze(/** @type {number[]} */ ([]));
const ONE_SOURCE = Object.freeze(Array.from({ length: 8 }, (_, i)=>Object.freeze([i])));
const TWO_SOURCES = Object.freeze(Array.from({ length: 8 }, (_, i)=>
    Object.freeze(Array.from({ length: 8 }, (__, j)=>Object.freeze([i, j])))));

/** What each constant load pushes. @type {Readonly<Record<string, number>>} */
const CONSTANTS = Object.freeze({
    fld1: 1, fldz: 0, fldpi: Math.PI, fldl2e: Math.LOG2E, fldln2: Math.LN2,
    fldlg2: Math.log10(2), fldl2t: Math.log2(10),
});

/**
 * Each arithmetic form: its operation, whether its operands are reversed,
 * whether its memory operand is an integer, and whether it pops.
 *
 * @type {ReadonlyMap<string, { kind: string, reversed: boolean, integer: boolean,
 *     pops: boolean }>}
 */
const ARITHMETIC_FORMS = new Map([...ARITHMETIC].map(op=>{
    const base = op.replace(/^fi/, 'f').replace(/p$/, '');
    const reversed = base.endsWith('r');
    return [op, Object.freeze({ kind: reversed ? base.slice(0, -1) : base, reversed,
        integer: op.startsWith('fi'), pops: op.endsWith('p') })];
}));

/**
 * The stack-fault check: t1 is set when a source ST(i) is empty or a push
 * finds its register held, and IE and SF are raised. A push that overflowed
 * also sets C1; an underflow otherwise clears it.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {readonly number[]} sources @param {boolean} pushes
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
        state.status &= ~Status.C1;
    }
    if (pushes)
    {
        // An underflow of the source comes first: C1 says nothing of the push then.
        if (((state.empty >>> ((state.top - 1) & 7)) & 1) === 0 && (state.empty & read) === 0)
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
    const rounded = diff < 0.5 ? floor : diff > 0.5 || floor % 2 !== 0 ? floor + 1 : floor;
    // A negative rounded to zero is -0, as the processor's is; -1 + 1 is +0.
    return value < 0 && rounded === 0 ? -0 : rounded;
}

/**
 * The exponent of a finite nonzero double as the 80-bit format has it, a
 * subnormal's normalised.
 *
 * @param {number} value
 * @returns {number}
 */
function exponentOf(value){
    scratchF[0] = value;
    const field = scratchU32[1] >>> 20 & 0x7ff;
    return field !== 0 ? field - 1023 : exponentOf(value * 2 ** 64) - 64;
}

/** The condition bits of the last `remainder`. */
let remainderBits = 0;

/**
 * `fprem` (`nearest` false) and `fprem1` on doubles, exactly, for a finite
 * `a` and a nonzero `c` that is not a NaN: the remainder, and in
 * `remainderBits` C2 and the quotient's low three bits in C0, C3 and C1.
 *
 * JS's `%` is the IEEE fmod, exact: the remainder of a quotient truncated
 * toward zero, which `fprem`'s is. `fprem1` rounds the quotient to nearest,
 * even on a tie, which moves the remainder by `c` exactly where it is past
 * half of `c` -- the two lie within a factor of two of each other, so the
 * difference is exact. The quotient's low bits come from the remainder of
 * `8c`, which the quotient mod 8 times `c` separates from the one of `c`.
 * Past an exponent difference of 63 the processor reduces partially: C2 set,
 * and the exponent brought down by 32 to 63, here 32 plus the difference mod
 * 32 -- a multiple of `c` by a power of two, so a loop of them ends at the
 * exact remainder.
 *
 * @param {number} a @param {number} c @param {boolean} nearest
 * @returns {number}
 */
function remainder(a, c, nearest){
    if (a === 0 || !Number.isFinite(c))
    {
        remainderBits = 0;
        return a;
    }
    const d = exponentOf(a) - exponentOf(c);
    if (d >= 64)
    {
        // c scaled by 2^(d - n) in steps a double holds; it stays below a.
        let scaled = c;
        for (let k = d - 32 - d % 32; k > 0; k -= 1000)
        {
            scaled *= 2 ** Math.min(k, 1000);
        }
        remainderBits = Status.C2;
        return a % scaled;
    }
    const r = a % c;
    // The quotient is below 8 where 8c overflows.
    const c8 = c * 8;
    let low = Math.round(Math.abs((Number.isFinite(c8) ? a % c8 - r : a - r) / c));
    let value = r;
    if (nearest)
    {
        const twice = Math.abs(r) * 2;
        const magnitude = Math.abs(c);
        if (twice > magnitude || (twice === magnitude && (low & 1) !== 0))
        {
            value = r > 0 ? r - magnitude : r + magnitude;
            low = (low + 1) & 7;
        }
    }
    remainderBits = ((low & 4) !== 0 ? Status.C0 : 0) | ((low & 2) !== 0 ? Status.C3 : 0)
        | ((low & 1) !== 0 ? Status.C1 : 0);
    return value;
}

/**
 * `remainder` as the reference the translator's and the wasm tier's integer
 * forms are held to: `fprem` for `nearest` 0, `fprem1` otherwise, and the
 * status bits by `fpremStatus`.
 *
 * @param {number} a @param {number} c @param {number} nearest
 */
export function fpremValue(a, c, nearest){
    return remainder(a, c, nearest !== 0);
}

/** @param {number} a @param {number} c @param {number} nearest */
export function fpremStatus(a, c, nearest){
    remainder(a, c, nearest !== 0);
    return remainderBits;
}

/**
 * A NaN the host made of operands none of which was one, given the sign the
 * processor's indefinite has.
 *
 * @param {number} value @param {number} a @param {number} c  the operands
 */
function hostNaN(value, a, c){
    if (!Number.isNaN(value) || Number.isNaN(a) || Number.isNaN(c))
    {
        return value;
    }
    scratchF[0] = value;
    scratchU32[1] |= 0x80000000;
    return scratchF[0];
}

/**
 * A double's two words, into `scratchU32`. A NaN's bits are taken from its value
 * this way before anything asks whether it is one: once the optimizer knows a
 * value is a NaN it may use the canonical NaN in its place, and the payload is
 * lost -- the same instruction then gave another result once its code was
 * optimized.
 *
 * @param {number} value
 * @returns {boolean} whether it is a NaN
 */
function nanWords(value){
    scratchF[0] = value;
    return (scratchU32[1] & 0x7ff00000) === 0x7ff00000
        && ((scratchU32[1] & 0xfffff) !== 0 || scratchU32[0] !== 0);
}

/** @param {number} value */
function signalling(value){
    return nanWords(value) && (scratchU32[1] & 0x80000) === 0;
}

/**
 * A NaN the host's `Math` made, quieted: its log2 and log1p of a negative NaN
 * are signalling ones, which come back quieted when wasm calls the same
 * function, and the processor makes none.
 *
 * @param {number} value
 */
function quiet(value){
    if (!nanWords(value))
    {
        return value;
    }
    scratchU32[1] |= 0x80000;
    return scratchF[0];
}

/**
 * The NaN an operation of two NaN operands gives, chosen as the x87 chooses it:
 * a quiet one over a signalling one, then the larger significand, then the
 * positive, quieted. The host's own operation returns the one its compiler
 * happened to put first, which is not the same from one compiled version of
 * this code to the next.
 *
 * @param {number} value the operation's result @param {number} a @param {number} c
 */
function twoNaN(value, a, c){
    if (!nanWords(a))
    {
        return value;
    }
    const aHigh = scratchU32[1];
    const aLow = scratchU32[0];
    if (!nanWords(c))
    {
        return value;
    }
    const cHigh = scratchU32[1];
    const cLow = scratchU32[0];
    const aQuiet = (aHigh & 0x80000) !== 0;
    const cQuiet = (cHigh & 0x80000) !== 0;
    const aFraction = (aHigh & 0xfffff) * 4294967296 + aLow;
    const cFraction = (cHigh & 0xfffff) * 4294967296 + cLow;
    const pickA = aQuiet !== cQuiet ? aQuiet
        : aFraction !== cFraction ? aFraction > cFraction : (aHigh & 0x80000000) === 0;
    scratchU32[1] = (pickA ? aHigh : cHigh) | 0x80000;
    scratchU32[0] = pickA ? aLow : cLow;
    return scratchF[0];
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
 * A word or doubleword integer operand, signed, as a number.
 *
 * @param {import('./ir.js').EvalState} state @param {number} address @param {number} size  2 or 4
 */
function readInt(state, address, size){
    const raw = state.memory.read(address, size);
    return size === 2 ? raw << 16 >> 16 : raw | 0;
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
 * The ten-byte extended value as a double: the mantissa's low and high words
 * and the sign and exponent. The mantissa's two words make one double by a
 * single rounding, as the 64-bit integer they are would round.
 *
 * @param {number} lowWord @param {number} highWord @param {number} high
 */
function f80ToF64(lowWord, highWord, high){
    const lo = lowWord >>> 0;
    const hi = highWord >>> 0;
    if ((high & 0x7fff) === 0x7fff)
    {
        // The fraction without the integer bit tells an infinity from a NaN,
        // and either keeps the sign -- as the translator's reader has them. A
        // NaN keeps its payload's top 52 bits, the quiet bit among them, as
        // a store of it to a double keeps them; one whose payload lies all
        // below them stays a NaN by its lowest bit. It is made from its bits:
        // a negated NaN the optimizer may make the canonical one.
        if ((hi & 0x7fffffff) === 0 && lo === 0)
        {
            return (high & 0x8000) !== 0 ? -Infinity : Infinity;
        }
        scratchU32[1] = ((high & 0x8000) !== 0 ? 0x80000000 : 0) | 0x7ff00000 | hi >>> 11 & 0xfffff;
        scratchU32[0] = (hi << 21 | lo >>> 11) >>> 0;
        if ((scratchU32[1] & 0xfffff) === 0 && scratchU32[0] === 0)
        {
            scratchU32[0] = 1;
        }
        return scratchF[0];
    }
    if (hi === 0 && lo === 0)
    {
        return (high & 0x8000) !== 0 ? -0 : 0;
    }
    let value = hi * 4294967296 + lo;
    let e = (high & 0x7fff) - 16446;
    for (let pass = 0; pass < 2; pass++)
    {
        const k = Math.max(-1022, Math.min(1023, e));
        value *= 2 ** k;
        e -= k;
    }
    return (high & 0x8000) !== 0 ? -value : value;
}

/**
 * The double as the ten-byte extended value, in words: a denormal's fraction
 * shifted up until the integer bit is set.
 *
 * @param {import('./ir.js').EvalState} state @param {number} at @param {number} value
 */
function writeF80(state, at, value){
    scratchF[0] = value;
    const hi = scratchU32[1];
    const lo = scratchU32[0];
    const rawExponent = hi >>> 20 & 0x7ff;
    const fraction = hi & 0xfffff;
    let signExponent = (hi >>> 31) << 15;
    let mantissaHigh = 0;
    let mantissaLow = 0;
    if (rawExponent !== 0)
    {
        mantissaHigh = (0x80000000 | fraction << 11 | lo >>> 21) >>> 0;
        mantissaLow = (lo << 11) >>> 0;
        signExponent |= rawExponent === 0x7ff ? 0x7fff : rawExponent + 15360;
    }
    else if (fraction !== 0 || lo !== 0)
    {
        const length = fraction !== 0 ? 64 - Math.clz32(fraction) : 32 - Math.clz32(lo);
        const count = 64 - length;
        if (count >= 32)
        {
            mantissaHigh = (lo << (count - 32)) >>> 0;
        }
        else
        {
            mantissaHigh = (fraction << count | lo >>> (32 - count)) >>> 0;
            mantissaLow = (lo << count) >>> 0;
        }
        signExponent |= 15372 - count;
    }
    state.memory.write(at, 4, mantissaLow);
    state.memory.write(at + 4, 4, mantissaHigh);
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
        // No IE for a signalling NaN in this format: the SDM's FLD raises it
        // for the narrower ones alone, and the NaN goes on as it is.
        const high = state.memory.read(address + 8, 2);
        const lo = state.memory.read(address, 4) >>> 0;
        const hi = state.memory.read(address + 4, 4) >>> 0;
        return f80ToF64(lo, hi, high);
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
    // A signalling NaN stored to a single or a double raises IE and goes out
    // quiet (the SDM's FST); the extended format takes it as it is.
    if (nanWords(value) && (scratchU32[1] & 0x80000) === 0)
    {
        state.status |= Status.IE;
        scratchU32[1] |= 0x80000;
        value = scratchF[0];
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
 * `fxsave`: the 512-byte x87/SSE image -- control and status words, the
 * abridged tag byte (a bit per physical register, set when it holds a value),
 * MXCSR and its mask, ST(0)..ST(7) in 16-byte slots and XMM0..XMM7. The
 * instruction and operand pointers are zero, as the rest of the model keeps
 * none, and the reserved tail is left as it was. The mask leaves out DAZ
 * (0xffbf), which the SSE model does not implement, so a program that tests it
 * before setting it does not.
 *
 * @param {import('./ir.js').EvalState} state @param {number} where
 */
export function fxsave(state, where){
    /** @param {number} offset @param {number} size @param {number} value */
    const put = (offset, size, value)=>state.memory.write(where + offset, size, value >>> 0);
    put(0, 2, state.control);
    put(2, 2, statusWord(state));
    put(4, 2, ~state.empty & 0xff);
    put(6, 2, 0);
    for (let offset = 8; offset < 24; offset += 4)
    {
        put(offset, 4, 0);
    }
    put(24, 4, state.mxcsr);
    put(28, 4, 0xffbf);
    for (let i = 0; i < 8; i++)
    {
        writeF80(state, where + 32 + 16 * i, state.f80[(state.top + i) & 7]);
        put(32 + 16 * i + 10, 2, 0);
        put(32 + 16 * i + 12, 4, 0);
        for (let j = 0; j < 4; j++)
        {
            put(160 + 16 * i + 4 * j, 4, state.xmm[i * 4 + j]);
        }
    }
}

/**
 * `fxrstor`: the image `fxsave` writes, read back.
 *
 * @param {import('./ir.js').EvalState} state @param {number} where
 */
export function fxrstor(state, where){
    state.control = state.memory.read(where, 2);
    const word = state.memory.read(where + 2, 2);
    state.status = word & ~0x3800;
    state.top = (word >>> 11) & 7;
    state.empty = ~state.memory.read(where + 4, 1) & 0xff;
    state.mxcsr = state.memory.read(where + 24, 4) >>> 0;
    state.x87Exact = 0;
    for (let i = 0; i < 8; i++)
    {
        const at = where + 32 + 16 * i;
        const lo = state.memory.read(at, 4);
        const hi = state.memory.read(at + 4, 4);
        state.f80[(state.top + i) & 7] = f80ToF64(lo, hi, state.memory.read(at + 8, 2));
        for (let j = 0; j < 4; j++)
        {
            state.xmm[i * 4 + j] = state.memory.read(where + 160 + 16 * i + 4 * j, 4) >>> 0;
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
    if (state.x87Exact === 0 && (op !== 'fild' || operands[1].size !== 8))
    {
        return stepX87(instruction, state, address);
    }
    // The exact quadwords (`exactWrites`): kept where the step writes no
    // register, and what it made itself added.
    const top = state.top;
    made = 0;
    const done = stepX87(instruction, state, address);
    const writes = exactWrites(instruction, top, IDENTITY);
    state.x87Exact = writes === null ? 0
        : ((state.x87Exact & ~writes.written) | made) & ~writes.popped;
    return done;
}

/**
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {import('./ir.js').EvalState} state
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @returns {boolean}
 */
function stepX87(instruction, state, address){
    const { op, operands } = instruction;
    const dst = operands[0];
    const src = operands[1];

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
                const from = (state.top + Number(src.reg)) & 7;
                const t1 = guard(state, ONE_SOURCE[Number(src.reg)], true);
                pushOf(state, orIndefinite(stOf(state, Number(src.reg)), t1));
                if (t1 === 0)
                {
                    copyExactOf(state, from, state.top);
                }
            }
            else
            {
                const value = loadFloat(state, address(src), src.size);
                pushOf(state, orIndefinite(value, guard(state, NO_SOURCE, true)));
            }
            return true;
        case 'fild':
        {
            if (src.size !== 8)
            {
                pushOf(state, orIndefinite(readInt(state, address(src), src.size),
                    guard(state, NO_SOURCE, true)));
                return true;
            }
            const value = readMem(state, address(src), 8);
            const t1 = guard(state, NO_SOURCE, true);
            pushOf(state, orIndefinite(Number(BigInt.asIntN(64, value)), t1));
            if (t1 === 0)
            {
                // The quadword beside the double it rounds to, for a quadword
                // store of it to copy the eight bytes the processor keeps.
                state.x87Shadow[state.top] = BigInt.asIntN(64, value);
                made = 1 << state.top;
            }
            return true;
        }
        case 'fld1': case 'fldz': case 'fldpi': case 'fldl2e': case 'fldln2': case 'fldlg2':
        case 'fldl2t':
            pushOf(state, orIndefinite(CONSTANTS[op] ?? 0, guard(state, NO_SOURCE, true)));
            return true;
        case 'fst': case 'fstp':
        {
            const t1 = guard(state, ONE_SOURCE[0], false);
            const value = orIndefinite(stOf(state, 0), t1);
            if (dst.kind === 'x87')
            {
                setStOf(state, Number(dst.reg), value);
                if (t1 === 0)
                {
                    copyExactOf(state, state.top, (state.top + Number(dst.reg)) & 7);
                }
            }
            else
            {
                storeFloat(state, address(dst), dst.size, value);
            }
            if (op === 'fstp')
            {
                popOf(state, 1);
            }
            return true;
        }
        case 'fist': case 'fistp': case 'fisttp':
        {
            const t1 = guard(state, ONE_SOURCE[0], false);
            const value = orIndefinite(stOf(state, 0), t1);
            const k = state.top;
            // A quadword `fild` loaded ST0 and nothing has written it: the
            // quadword itself, which needs no rounding and is in range. The
            // compare is a second guard on what the marks promise.
            if (dst.size === 8 && t1 === 0 && (state.x87Exact >>> k & 1) !== 0
                && value === Number(state.x87Shadow[k]))
            {
                writeMem(state, address(dst), 8, state.x87Shadow[k]);
            }
            else
            {
                storeInt(state, address(dst), dst.size, value, op === 'fisttp');
            }
            if (op !== 'fist')
            {
                popOf(state, 1);
            }
            return true;
        }
        case 'fxch':
        {
            const i = Number(src.reg);
            const t1 = guard(state, TWO_SOURCES[0][i], false);
            const a = state.top;
            const c = (state.top + i) & 7;
            // An empty one becomes the indefinite before the exchange, and both
            // are held after it, as the processor answers the stack fault.
            for (const k of t1 !== 0 ? [a, c] : [])
            {
                if ((state.empty >>> k & 1) !== 0)
                {
                    state.f80[k] = INDEFINITE;
                    state.empty &= ~(1 << k);
                }
            }
            const swap = state.f80[a];
            state.f80[a] = state.f80[c];
            state.f80[c] = swap;
            // The SDM's FXCH, FINCSTP, FDECSTP, FCHS and FABS clear C1.
            state.status &= ~Status.C1;
            // An exact quadword's mark and shadow go with its value.
            const exact = state.x87Exact;
            if (((exact >>> a | exact >>> c) & 1) !== 0)
            {
                const shadow = state.x87Shadow[a];
                state.x87Shadow[a] = state.x87Shadow[c];
                state.x87Shadow[c] = shadow;
                if (((exact >>> a ^ exact >>> c) & 1) !== 0)
                {
                    state.x87Exact = exact ^ (1 << a | 1 << c);
                }
            }
            return true;
        }
        case 'ffree': case 'ffreep':
            state.empty |= 1 << ((state.top + Number(dst.reg)) & 7);
            if (op === 'ffreep')
            {
                popOf(state, 1);
            }
            return true;
        case 'fincstp':
            state.top = (state.top + 1) & 7;
            state.status &= ~Status.C1;
            return true;
        case 'fdecstp':
            state.top = (state.top - 1) & 7;
            state.status &= ~Status.C1;
            return true;
        case 'fchs':
            setStOf(state, 0, orIndefinite(-stOf(state, 0), guard(state, ONE_SOURCE[0], false)));
            state.status &= ~Status.C1;
            return true;
        case 'fabs':
        {
            const t1 = guard(state, ONE_SOURCE[0], false);
            setStOf(state, 0, orIndefinite(Math.abs(stOf(state, 0)), t1));
            state.status &= ~Status.C1;
            return true;
        }
        case 'fsqrt':
        {
            const t1 = guard(state, ONE_SOURCE[0], false);
            if (stOf(state, 0) < 0 && t1 === 0)
            {
                state.status |= Status.IE;
            }
            const value = stOf(state, 0);
            setStOf(state, 0, orIndefinite(byPrecision(hostNaN(Math.sqrt(value), value, value),
                state), t1));
            return true;
        }
        case 'fldcw':
            state.control = state.memory.read(address(src ?? dst), 2) & 0xffff;
            return true;
        case 'frndint':
        {
            const t1 = guard(state, ONE_SOURCE[0], false);
            setStOf(state, 0, orIndefinite(roundBy(stOf(state, 0), state.control), t1));
            return true;
        }
        case 'fscale':
        {
            const t1 = guard(state, TWO_SOURCES[0][1], false);
            let count = Math.trunc(stOf(state, 1));
            count = Math.max(-2100, Math.min(2100, Number.isNaN(count) ? 0 : count));
            let value = stOf(state, 0);
            for (let pass = 0; pass < 2; pass++)
            {
                const k = Math.max(-1022, Math.min(1023, count));
                value *= 2 ** k;
                count -= k;
            }
            setStOf(state, 0, orIndefinite(value, t1));
            return true;
        }
        case 'fxtract':
        {
            const t1 = guard(state, ONE_SOURCE[0], true);
            const original = stOf(state, 0);
            // An infinity is its own significand with an exponent of +inf, a
            // NaN both (its bits as it came, taken before it is asked about).
            const nan = nanWords(original);
            if (nan || Math.abs(original) === Infinity)
            {
                const same = nan ? scratchF[0] : original;
                setStOf(state, 0, orIndefinite(nan ? same : Infinity, t1));
                pushOf(state, orIndefinite(same, t1));
                return true;
            }
            let value = original;
            let exponent = 0;
            let significand;
            if (value === 0)
            {
                // A stack fault is the invalid operation alone.
                if (t1 === 0)
                {
                    state.status |= Status.ZE;
                }
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
            setStOf(state, 0, orIndefinite(exponent, t1));
            pushOf(state, orIndefinite(significand, t1));
            return true;
        }
        case 'fsin': case 'fcos': case 'fsincos': case 'fptan':
        {
            const t1 = guard(state, ONE_SOURCE[0], op === 'fsincos' || op === 'fptan');
            state.status &= ~Status.C2;
            const value = stOf(state, 0);
            if (Math.abs(value) < 2 ** 63 && !Number.isNaN(value) && t1 === 0)
            {
                if (op === 'fsincos')
                {
                    setStOf(state, 0, Math.sin(value));
                    pushOf(state, Math.cos(value));
                }
                else if (op === 'fptan')
                {
                    setStOf(state, 0, Math.tan(value));
                    pushOf(state, 1);
                }
                else
                {
                    setStOf(state, 0, op === 'fsin' ? Math.sin(value) : Math.cos(value));
                }
            }
            else if (Number.isNaN(value) || t1 !== 0)
            {
                setStOf(state, 0, INDEFINITE);
                if (op === 'fsincos' || op === 'fptan')
                {
                    pushOf(state, INDEFINITE);
                }
            }
            else
            {
                state.status |= Status.C2;
            }
            return true;
        }
        case 'fpatan':
        {
            const t1 = guard(state, TWO_SOURCES[0][1], false);
            setStOf(state, 1, orIndefinite(Math.atan2(stOf(state, 1), stOf(state, 0)), t1));
            popOf(state, 1);
            return true;
        }
        case 'f2xm1':
        {
            const t1 = guard(state, ONE_SOURCE[0], false);
            setStOf(state, 0, orIndefinite(Math.expm1(stOf(state, 0) * Math.LN2), t1));
            return true;
        }
        case 'fyl2x': case 'fyl2xp1':
        {
            const t1 = guard(state, TWO_SOURCES[0][1], false);
            let result;
            if (op === 'fyl2x')
            {
                const y = stOf(state, 1);
                if (stOf(state, 0) === 0 && Math.abs(y) < Infinity && y !== 0 && t1 === 0)
                {
                    state.status |= Status.ZE;
                }
                if (stOf(state, 0) < 0)
                {
                    state.status |= Status.IE;
                }
                // A negative argument's logarithm is the invalid operation's
                // indefinite, not the host's NaN, and a NaN's is itself: the
                // host's logarithm keeps no NaN's bits.
                const x = stOf(state, 0);
                const log = Number.isNaN(x) ? x : x < 0 ? INDEFINITE : quiet(Math.log2(x));
                result = twoNaN(stOf(state, 1) * log, stOf(state, 1), log);
            }
            else
            {
                if (stOf(state, 0) < -1)
                {
                    state.status |= Status.IE;
                }
                const x = stOf(state, 0);
                const log = Number.isNaN(x) ? x
                    : x < -1 ? INDEFINITE : quiet(Math.log1p(x)) / Math.LN2;
                result = twoNaN(stOf(state, 1) * log, stOf(state, 1), log);
            }
            setStOf(state, 1, orIndefinite(result, t1));
            popOf(state, 1);
            return true;
        }
        case 'fprem': case 'fprem1':
        {
            const t1 = guard(state, TWO_SOURCES[0][1], false);
            const a = stOf(state, 0);
            const c = stOf(state, 1);
            if (Number.isNaN(a) || Number.isNaN(c) || Math.abs(a) === Infinity
                || c === 0 || t1 !== 0)
            {
                // No reduction: C1 and C2 cleared, C0 and C3 as they were. A NaN
                // operand goes on quiet (of two, the x87's choice), raising IE
                // only if it signals; anything else is the indefinite and IE.
                state.status &= ~(Status.C1 | Status.C2);
                if (t1 === 0 && (Number.isNaN(a) || Number.isNaN(c)))
                {
                    if (signalling(a) || signalling(c))
                    {
                        state.status |= Status.IE;
                    }
                    setStOf(state, 0, twoNaN(quiet(Number.isNaN(a) ? a : c), a, c));
                    return true;
                }
                state.status |= Status.IE;
                setStOf(state, 0, INDEFINITE);
                return true;
            }
            state.status &= ~(Status.C2 | Status.C0 | Status.C3 | Status.C1);
            setStOf(state, 0, remainder(a, c, op === 'fprem1'));
            state.status |= remainderBits;
            return true;
        }
        case 'fadd': case 'fsub': case 'fsubr': case 'fmul': case 'fdiv': case 'fdivr':
        case 'faddp': case 'fsubp': case 'fsubrp': case 'fmulp': case 'fdivp': case 'fdivrp':
        case 'fiadd': case 'fisub': case 'fisubr': case 'fimul': case 'fidiv': case 'fidivr':
        {
            const form = /** @type {{ kind: string, reversed: boolean, integer: boolean,
                pops: boolean }} */ (ARITHMETIC_FORMS.get(op));
            const { kind, reversed, integer, pops } = form;
            const target = dst.kind === 'x87' ? Number(dst.reg) : 0;
            const t1 = guard(state, src.kind === 'x87'
                ? TWO_SOURCES[target][Number(src.reg)] : ONE_SOURCE[target], false);
            const a0 = stOf(state, target);
            let c0;
            if (src.kind === 'x87')
            {
                c0 = stOf(state, Number(src.reg));
            }
            else if (integer)
            {
                c0 = readInt(state, address(src), src.size);
            }
            else
            {
                c0 = loadFloat(state, address(src), src.size);
            }
            const a = reversed ? c0 : a0;
            const c = reversed ? a0 : c0;
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
            result = twoNaN(hostNaN(byPrecision(result, state), a0, c0), a0, c0);
            setStOf(state, target, orIndefinite(result, t1));
            if (t1 === 0)
            {
                if (kind === 'fdiv' && c === 0 && a !== 0 && Math.abs(a) < Infinity)
                {
                    state.status |= Status.ZE;
                }
                // A NaN made of operands that were not, or a register that held
                // a signalling one (a memory operand's raised IE as it loaded).
                if (Number.isNaN(result) && (!Number.isNaN(a0) && !Number.isNaN(c0)
                    || signalling(a0) || signalling(c0)))
                {
                    state.status |= Status.IE;
                }
            }
            if (pops)
            {
                popOf(state, 1);
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
                t1 = guard(state, ONE_SOURCE[0], false);
                c0 = readInt(state, address(src), src.size);
            }
            else if (op === 'ftst')
            {
                t1 = guard(state, ONE_SOURCE[0], false);
                c0 = 0;
            }
            else if (op === 'fcompp' || op === 'fucompp')
            {
                t1 = guard(state, TWO_SOURCES[0][1], false);
                c0 = stOf(state, 1);
            }
            else if (src.kind === 'x87')
            {
                t1 = guard(state, TWO_SOURCES[0][Number(src.reg)], false);
                c0 = stOf(state, Number(src.reg));
            }
            else
            {
                t1 = guard(state, ONE_SOURCE[0], false);
                c0 = loadFloat(state, address(src), src.size);
            }
            conditionBits(state, stOf(state, 0), c0, !op.startsWith('fu'), t1);
            popOf(state, op.endsWith('pp') ? 2 : op.endsWith('p') ? 1 : 0);
            return true;
        }
        case 'fcomi': case 'fcomip': case 'fucomi': case 'fucomip':
        {
            const empty = guard(state, TWO_SOURCES[0][Number(src.reg)], false);
            const a = stOf(state, 0);
            const c = stOf(state, Number(src.reg));
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
            popOf(state, op.endsWith('p') ? 1 : 0);
            return true;
        }
        case 'fcmovb': case 'fcmove': case 'fcmovbe': case 'fcmovu':
        case 'fcmovnb': case 'fcmovne': case 'fcmovnbe': case 'fcmovnu':
            // A stack fault leaves the indefinite in ST0, held, whatever the
            // condition, as the processor answers it.
            if (guard(state, TWO_SOURCES[0][Number(src.reg)], false) !== 0)
            {
                setStOf(state, 0, INDEFINITE);
            }
            else if (condition(/** @type {number} */ (instruction.cc), state.eflags))
            {
                setStOf(state, 0, stOf(state, Number(src.reg)));
            }
            return true;
        case 'fxam':
        {
            const value = stOf(state, 0);
            state.status &= ~Status.CONDITION;
            state.status &= ~Status.C1;
            scratchF[0] = value;
            // The sign of what the register holds, empty or not.
            if ((scratchU32[1] & 0x80000000) !== 0)
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
                state.memory.write(address(dst), 2, word);
            }
            return true;
        }
        case 'fnstcw':
            state.memory.write(address(dst), 2, state.control);
            return true;
        case 'fnstenv': case 'fnsave':
        {
            // As the translator's: the control word stays after fnstenv,
            // where the processor masks every exception (`emit/x87.js`).
            const save = op === 'fnsave';
            const where = address(dst);
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
                    writeF80(state, where + 28 + 10 * i, stOf(state, i));
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
            const where = address(src ?? dst);
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
                    const at = where + 28 + 10 * index;
                    const lo = state.memory.read(at, 4);
                    const hi = state.memory.read(at + 4, 4);
                    state.f80[k] = f80ToF64(lo, hi, state.memory.read(at + 8, 2));
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
            const value = orIndefinite(stOf(state, 0), guard(state, ONE_SOURCE[0], false));
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
            popOf(state, 1);
            return true;
        }
        case 'fbld':
        {
            // Eighteen packed BCD digits, least significant byte first, the
            // sign in the tenth byte's top bit; pushed as the double nearest.
            // The integer is summed exactly: past 2^53 a double rounds it once.
            const where = address(src);
            let digits = 0n;
            for (let i = 8; i >= 0; i--)
            {
                const pair = state.memory.read(where + i, 1);
                digits = digits * 100n + BigInt((pair >>> 4) * 10 + (pair & 0xf));
            }
            const value = Number(digits);
            const negative = (state.memory.read(where + 9, 1) & 0x80) !== 0;
            pushOf(state, orIndefinite(negative ? -value : value, guard(state, NO_SOURCE, true)));
            return true;
        }
        case 'fxsave': case 'fxrstor':
            return false;
        default:
            return false;
    }
}

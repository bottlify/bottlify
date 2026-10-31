/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 32-bit hardware corpus as test data (`../x86-corpus.json.gz`, made by
 * `tools/x86-corpus.mjs` on the processor itself).
 *
 * Each case is a few instructions at CODE_AT followed by `hlt`, the state they
 * start from -- the eight registers, EFLAGS, the x87 stack with its control,
 * status and tag words, MXCSR, the XMM registers, an 8 KiB buffer at DATA_AT
 * filled from a seed -- and what the processor left: the same state, the
 * buffer's changed bytes, or the fault it raised (its vector and address,
 * with the registers as they stood before the faulting instruction). This
 * module places a case in cork's state block, reads an outcome back, and says
 * what differs, under the rules below; nothing else is left out of the
 * comparison.
 *
 * - EFLAGS: the status flags and DF, less those the case's instructions
 *   leave undefined (the generator decodes what the processor ran).
 * - The x87 condition codes the instructions leave undefined (the SDM's
 *   "FPU Flags Affected") are not compared, nor DE, OE, UE and PE, which the
 *   model keeps not at all or (UE) only for a store to a float.
 * - The x87 registers are doubles in cork, by design: a held register is
 *   compared with the processor's 80-bit value rounded to a double, to
 *   nearest. Where that value lies exactly halfway between two doubles, the
 *   bits below the processor's 64 decide which a double model reaches, and
 *   either is taken. A register an exact `fild` quadword holds is compared
 *   with that integer exactly. An empty register's contents are not compared;
 *   that it is empty is.
 * - A case that ran a transcendental instruction (f2xm1, fyl2x, fyl2xp1,
 *   fsin, fcos, fsincos, fptan, fpatan) has its x87 registers compared to
 *   within TRANSCENDENTAL_ULPS units in the last place of the double: the
 *   processor's results are within an ulp of the 80-bit value, cork's come
 *   from the host's math library, which is not correctly rounded either. The
 *   corpus stores no such result to memory.
 * - An MMX case's registers are compared by their 64 bits.
 * - MXCSR's exception flags are not compared: the model keeps none.
 *
 * Test support only: nothing in the product reads a corpus.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { eflagsOf, setEflags } from '../emit/flags.js';
import { judged } from './x86-known.js';

/** Where a case's code and its buffer lie, as the runner maps them. */
export const CORPUS_LAYOUT = Object.freeze({
    CODE_AT: 0x80000, DATA_AT: 0x100000, DATA_SIZE: 0x2000,
});

/** The vectors a case can end with, by name. */
export const VECTOR_NAMES = Object.freeze({ 0: 'DE', 6: 'UD', 13: 'GP', 14: 'PF' });

const C0 = 0x100;
const C1 = 0x200;
const C2 = 0x400;
const C3 = 0x4000;
const CONDITION = C0 | C1 | C2 | C3;

/** CF PF AF ZF SF OF and DF: the flags a case is compared on. */
export const COMPARED_FLAGS = 0x1 | 0x4 | 0x10 | 0x40 | 0x80 | 0x800 | 0x400;
/** The x87 exceptions the model does not keep: denormal operand, overflow, underflow, precision. */
export const UNMODELLED_STATUS = 0x2 | 0x8 | 0x10 | 0x20;
/** MXCSR's control bits; the six exception flags below them are not kept. */
export const MXCSR_CONTROL = 0xffc0;
/** How far from the processor's a transcendental result may be, in units in the last place. */
export const TRANSCENDENTAL_ULPS = 2;

/**
 * What each x87 instruction leaves of the condition codes, from the SDM's
 * "FPU Flags Affected" of each: the codes it sets to a defined value and the
 * ones it leaves undefined; any code in neither it leaves as it was, as every
 * instruction not listed does. Where the SDM has C1 say which way a result was
 * rounded, C1 counts as undefined too: like the precision exception it goes
 * with, the rounding direction is not something the model keeps (its registers
 * are doubles).
 *
 * @type {Readonly<Record<string, { defines: number, undefines: number }>>}
 */
export const X87_STATUS = Object.freeze(Object.fromEntries([
    // C1 the stack fault; C0, C2 and C3 undefined.
    ...['fld', 'fild', 'fbld', 'fld1', 'fldz', 'fldpi', 'fldl2e', 'fldl2t', 'fldlg2', 'fldln2',
        'fxtract', 'fabs', 'fchs', 'fxch', 'fdecstp', 'fincstp']
        .map(op=>[op, { defines: C1, undefines: C0 | C2 | C3 }]),
    // C1 cleared by an underflow, as it was otherwise; C0, C2 and C3 undefined.
    ...['fcmovb', 'fcmove', 'fcmovbe', 'fcmovu', 'fcmovnb', 'fcmovne', 'fcmovnbe', 'fcmovnu']
        .map(op=>[op, { defines: 0, undefines: C0 | C2 | C3 }]),
    // C1 the stack fault or the rounding direction; C0, C2 and C3 undefined.
    ...['fst', 'fstp', 'fist', 'fistp', 'fisttp', 'fbstp', 'fadd', 'faddp', 'fiadd', 'fsub',
        'fsubp', 'fisub', 'fsubr', 'fsubrp', 'fisubr', 'fmul', 'fmulp', 'fimul', 'fdiv', 'fdivp',
        'fidiv', 'fdivr', 'fdivrp', 'fidivr', 'fsqrt', 'fscale', 'frndint', 'f2xm1', 'fyl2x',
        'fyl2xp1', 'fpatan']
        .map(op=>[op, { defines: 0, undefines: CONDITION }]),
    // C2 whether the operand was out of range as well.
    ...['fsin', 'fcos', 'fsincos', 'fptan'].map(op=>[op, { defines: C2, undefines: C0 | C1 | C3 }]),
    // Every code a result: compares, classes, remainders, and the loads of a whole state.
    ...['fprem', 'fprem1', 'fxam', 'fcom', 'fcomp', 'fcompp', 'fucom', 'fucomp', 'fucompp',
        'ficom', 'ficomp', 'ftst', 'fninit', 'fnsave', 'frstor', 'fldenv', 'fxrstor']
        .map(op=>[op, { defines: CONDITION, undefines: 0 }]),
    // EFLAGS for the compare, the rest as they were but C1, which the SDM has
    // cleared and the processor that made the corpus leaves as it was.
    ...['fcomi', 'fcomip', 'fucomi', 'fucomip'].map(op=>[op, { defines: 0, undefines: C1 }]),
    ...['ffree', 'ffreep', 'fnclex', 'fldcw', 'fnstcw', 'fnstsw', 'fnstenv', 'fnop', 'fwait']
        .map(op=>[op, { defines: 0, undefines: CONDITION }]),
]));

/**
 * The condition codes left undefined after an instruction, from those before it.
 *
 * @param {string} op @param {number} undefinedCodes
 */
export function statusAfter(op, undefinedCodes){
    const rule = X87_STATUS[op];
    return rule === undefined ? undefinedCodes : undefinedCodes & ~rule.defines | rule.undefines;
}

/**
 * A case's buffer, as the runner fills it: xorshift32 from the seed, the low
 * byte of each step.
 *
 * @param {number} seed @param {number} [size]
 */
export function fillData(seed, size = CORPUS_LAYOUT.DATA_SIZE){
    const data = new Uint8Array(size);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < size; i++)
    {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        data[i] = x & 0xff;
    }
    return data;
}

/**
 * @typedef {Object} X87State
 * @property {number} control
 * @property {number} status   without the top
 * @property {number} top
 * @property {number} empty    bit k for physical register k
 * @property {bigint[]} st     the physical registers' 80-bit images
 */

/**
 * @typedef {Object} CaseState
 * @property {Uint32Array} regs    eax..edi
 * @property {number} eflags
 * @property {X87State} x87
 * @property {number} mxcsr
 * @property {Uint32Array} xmm     32 words
 * @property {Uint8Array} data     the buffer
 */

/**
 * @typedef {Object} X86Case
 * @property {number} index
 * @property {string} name      its number and its text
 * @property {Uint8Array} code  the case's bytes, `hlt` after them
 * @property {'x87' | 'mmx' | 'sse' | null} kind
 * @property {CaseState} start
 * @property {CaseState} expected
 * @property {{ vector: number, eip: number } | null} fault
 * @property {number} undefinedFlags   EFLAGS bits the case leaves undefined
 * @property {number} undefinedStatus  x87 condition codes it leaves undefined
 * @property {[number, number][]} ignored  buffer spans whose bytes the model does not keep
 * @property {boolean} transcendental  whether it ran a transcendental instruction
 */

/** @param {string} hex */
const bytesOf = hex=>Uint8Array.from(Buffer.from(hex, 'hex'));

/** @param {string[]} [registers] @returns {Uint32Array} */
function xmmOf(registers){
    const words = new Uint32Array(32);
    if (registers)
    {
        registers.forEach((hex, i)=>{
            const bytes = bytesOf(hex);
            words.set(new Uint32Array(bytes.buffer, bytes.byteOffset, 4), i * 4);
        });
    }
    return words;
}

/**
 * The corpus, gunzipped and expanded into cases.
 *
 * @param {Uint8Array} [packed]  the document's bytes; the committed corpus by default
 * @returns {X86Case[]}
 */
export function loadX86Corpus(
    packed = readFileSync(new URL('../x86-corpus.json.gz', import.meta.url)))
{
    const document = JSON.parse(new TextDecoder().decode(gunzipSync(packed)));
    if (document.codeAt !== CORPUS_LAYOUT.CODE_AT || document.dataAt !== CORPUS_LAYOUT.DATA_AT
        || document.dataSize !== CORPUS_LAYOUT.DATA_SIZE)
    {
        throw new Error('x86 corpus: made for another layout');
    }
    return document.cases.map((/** @type {any} */ one, /** @type {number} */ index)=>{
        const code = new Uint8Array(one.code.length / 2 + 1);
        code.set(bytesOf(one.code));
        code[code.length - 1] = 0xf4;
        const data = fillData(one.seed);
        const x87 = one.x87 ?? { cw: 0x37f, sw: 0, tw: 0, st: Array(8).fill('0') };
        /** @type {CaseState} */
        const start = {
            regs: Uint32Array.from(one.regs),
            eflags: one.flags,
            x87: {
                control: x87.cw, status: x87.sw & ~0x3800, top: x87.sw >>> 11 & 7,
                empty: ~x87.tw & 0xff, st: x87.st.map((/** @type {string} */ hex)=>BigInt(`0x${hex}`)),
            },
            mxcsr: one.mxcsr ?? 0x1f80,
            xmm: xmmOf(one.xmm),
            data,
        };
        const out = one.out;
        const after = data.slice();
        for (const [offset, value] of out.writes)
        {
            after[offset] = value;
        }
        const xmm = start.xmm.slice();
        for (const [i, hex] of Object.entries(out.xmm ?? {}))
        {
            xmm.set(xmmOf([hex]).subarray(0, 4), Number(i) * 4);
        }
        /** @type {X87State} */
        const x87After = out.x87 ? {
            control: out.x87.cw, status: out.x87.sw & ~0x3800, top: out.x87.sw >>> 11 & 7,
            empty: emptyOfTag(out.x87.tag), st: out.x87.st.map((/** @type {string} */ hex)=>BigInt(`0x${hex}`)),
        } : start.x87;
        return {
            index,
            name: `#${index} ${one.text}`,
            code,
            kind: one.kind ?? null,
            start,
            expected: { regs: Uint32Array.from(out.regs), eflags: out.flags, x87: x87After,
                mxcsr: out.mxcsr ?? start.mxcsr, xmm, data: after },
            fault: out.vector === undefined ? null
                : { vector: out.vector, eip: CORPUS_LAYOUT.CODE_AT + out.at },
            undefinedFlags: out.undefinedFlags ?? 0,
            undefinedStatus: out.undefinedStatus ?? 0,
            ignored: out.ignored ?? [],
            transcendental: out.transcendental ?? false,
        };
    });
}

/** The registers a full tag word marks empty. @param {number} tag */
function emptyOfTag(tag){
    let empty = 0;
    for (let k = 0; k < 8; k++)
    {
        if ((tag >>> (2 * k) & 3) === 3)
        {
            empty |= 1 << k;
        }
    }
    return empty;
}

const scratch = new DataView(new ArrayBuffer(8));

/** @param {number} value */
export function doubleBits(value){
    scratch.setFloat64(0, value, true);
    return scratch.getBigUint64(0, true);
}

/** @param {bigint} bits */
function doubleOf(bits){
    scratch.setBigUint64(0, bits, true);
    return scratch.getFloat64(0, true);
}

/**
 * An 80-bit value as the doubles nearest it: the one rounding to nearest
 * (even) gives, and where the value lies exactly halfway, the other one too.
 * A NaN keeps its sign and its high 52 fraction bits, as `fst m64` keeps
 * them, without quieting.
 *
 * @param {bigint} image
 * @returns {{ nearest: bigint, tie: bigint | null }}  double bits
 */
export function doublesOf(image){
    const sign = image >> 79n & 1n;
    const exponent = Number(image >> 64n & 0x7fffn);
    const mantissa = image & 0xffffffffffffffffn;
    const signed = (/** @type {number} */ magnitude)=>doubleBits(sign === 1n ? -magnitude : magnitude);
    if (exponent === 0x7fff)
    {
        if ((mantissa & 0x7fffffffffffffffn) === 0n)
        {
            return { nearest: signed(Infinity), tie: null };
        }
        const fraction = mantissa >> 11n & 0xfffffffffffffn;
        return { nearest: sign << 63n | 0x7ffn << 52n | fraction, tie: null };
    }
    if (mantissa === 0n)
    {
        return { nearest: signed(0), tie: null };
    }
    // value = mantissa * 2^(e - 63); its leading bit's weight 2^lead.
    const e = (exponent === 0 ? 1 : exponent) - 16383;
    const lead = e - 63 + mantissa.toString(2).length - 1;
    // The weight of a double's last bit there, a subnormal's below 2^-1022.
    const quantum = Math.max(lead - 52, -1074);
    const drop = quantum - (e - 63);
    if (drop <= 0)
    {
        return { nearest: signed(Number(mantissa) * 2 ** (e - 63)), tie: null };
    }
    const kept = mantissa >> BigInt(drop);
    const rest = mantissa & (1n << BigInt(drop)) - 1n;
    const half = 1n << BigInt(drop - 1);
    const up = rest > half || rest === half && (kept & 1n) === 1n;
    const rounded = up ? kept + 1n : kept;
    const value = (/** @type {bigint} */ units)=>signed(Number(units) * 2 ** quantum);
    return { nearest: value(rounded), tie: rest === half ? value(up ? kept : kept + 1n) : null };
}

/**
 * The 80-bit value as an integer, or null when it is not one.
 *
 * @param {bigint} image
 */
function integerOf(image){
    const exponent = Number(image >> 64n & 0x7fffn);
    const mantissa = image & 0xffffffffffffffffn;
    if (exponent === 0x7fff)
    {
        return null;
    }
    const shift = exponent - 16383 - 63;
    const sign = (image >> 79n & 1n) === 1n ? -1n : 1n;
    if (shift >= 0)
    {
        return sign * (mantissa << BigInt(shift));
    }
    if (shift < -64 || (mantissa & (1n << BigInt(-shift)) - 1n) !== 0n)
    {
        return mantissa === 0n ? 0n : null;
    }
    return sign * (mantissa >> BigInt(-shift));
}

/** The 80-bit image of a double, exactly. @param {bigint} bits */
export function imageOfDouble(bits){
    const sign = bits >> 63n;
    const exponent = Number(bits >> 52n & 0x7ffn);
    let fraction = bits & 0xfffffffffffffn;
    if (exponent === 0x7ff)
    {
        return sign << 79n | 0x7fffn << 64n | 1n << 63n | fraction << 11n;
    }
    if (exponent === 0)
    {
        if (fraction === 0n)
        {
            return sign << 79n;
        }
        let e = -1022;
        while ((fraction & 1n << 52n) === 0n)
        {
            fraction <<= 1n;
            e--;
        }
        return sign << 79n | BigInt(e + 16383) << 64n | fraction << 11n;
    }
    return sign << 79n | BigInt(exponent - 1023 + 16383) << 64n | 1n << 63n | fraction << 11n;
}

/**
 * How many doubles lie between two, for two finite ones of the same sign; the
 * largest number otherwise.
 *
 * @param {bigint} a @param {bigint} c  double bits
 */
function ulpsApart(a, c){
    const finite = (/** @type {bigint} */ bits)=>(bits >> 52n & 0x7ffn) !== 0x7ffn;
    if (a >> 63n !== c >> 63n || !finite(a) || !finite(c))
    {
        return Number.MAX_SAFE_INTEGER;
    }
    return Number(a > c ? a - c : c - a);
}

/** The low 64 bits of an image, an MMX register's. @param {bigint} image */
const low64 = image=>image & 0xffffffffffffffffn;

/**
 * Places a case in a cork layout's memory: the code (with its `hlt`) and the
 * buffer in RAM, every register of the state block. RAM is assumed clear.
 *
 * @param {DataView} view @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {X86Case} one
 */
export function placeCase(view, layout, one){
    const ram = new Uint8Array(view.buffer, view.byteOffset + layout.ramBase);
    ram.set(one.code, CORPUS_LAYOUT.CODE_AT);
    ram.set(one.start.data, CORPUS_LAYOUT.DATA_AT);
    const { start } = one;
    for (let r = 0; r < 8; r++)
    {
        view.setUint32(layout.regs + r * 4, start.regs[r], true);
    }
    setEflags(view, layout, start.eflags);
    view.setUint32(layout.eip, CORPUS_LAYOUT.CODE_AT, true);
    const x87 = start.x87;
    for (let k = 0; k < 8; k++)
    {
        // An MMX case's registers are their 64 bits; any other's hold doubles exactly.
        const image = x87.st[k];
        view.setBigUint64(layout.x87 + k * 16,
            one.kind === 'mmx' ? low64(image) : doublesOf(image).nearest, true);
        view.setBigUint64(layout.x87 + k * 16 + 8, 0n, true);
    }
    view.setUint8(layout.x87Top, x87.top);
    view.setUint8(layout.x87Empty, x87.empty);
    view.setUint16(layout.x87Control, x87.control, true);
    view.setUint16(layout.x87Status, x87.status, true);
    if ((layout.x87Exact ?? -1) >= 0)
    {
        view.setUint8(/** @type {number} */ (layout.x87Exact), 0);
    }
    for (let word = 0; word < 32; word++)
    {
        view.setUint32(layout.xmm + word * 4, start.xmm[word], true);
    }
    view.setUint32(layout.mxcsr, start.mxcsr, true);
}

/**
 * What a run left, read from the state block.
 *
 * @typedef {Object} Outcome
 * @property {{ vector: number, eip: number } | null} fault
 * @property {boolean} halted   false when the case ran out of its budget
 * @property {Uint32Array} regs
 * @property {number} eflags
 * @property {{ control: number, status: number, top: number, empty: number,
 *     bits: bigint[], exact: (bigint | null)[] }} x87  each register's eight bytes,
 *     and the quadword an exact `fild` left where one did
 * @property {number} mxcsr
 * @property {Uint32Array} xmm
 * @property {Uint8Array} data
 */

/**
 * @param {DataView} view @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ fault: { vector: number, eip: number } | null, halted: boolean }} end
 * @returns {Outcome}
 */
export function outcomeOf(view, layout, { fault, halted }){
    const exactAt = layout.x87Exact ?? -1;
    const exact = exactAt >= 0 ? view.getUint8(exactAt) : 0;
    const start = view.byteOffset + layout.ramBase + CORPUS_LAYOUT.DATA_AT;
    return {
        fault,
        halted,
        regs: Uint32Array.from({ length: 8 }, (_, r)=>view.getUint32(layout.regs + r * 4, true)),
        eflags: eflagsOf(view, layout) >>> 0,
        x87: {
            control: view.getUint16(layout.x87Control, true),
            status: view.getUint16(layout.x87Status, true) & ~0x3800,
            top: view.getUint8(layout.x87Top) & 7,
            empty: view.getUint8(layout.x87Empty),
            bits: Array.from({ length: 8 }, (_, k)=>view.getBigUint64(layout.x87 + k * 16, true)),
            exact: Array.from({ length: 8 }, (_, k)=>(exact >>> k & 1) !== 0
                ? view.getBigInt64(layout.x87 + k * 16 + 8, true) : null),
        },
        mxcsr: view.getUint32(layout.mxcsr, true),
        xmm: Uint32Array.from({ length: 32 },
            (_, word)=>view.getUint32(layout.xmm + word * 4, true)),
        data: new Uint8Array(view.buffer.slice(start, start + CORPUS_LAYOUT.DATA_SIZE)),
    };
}

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

/**
 * What differs between the processor's outcome and a run's, by the rules in
 * this module's head.
 *
 * @param {X86Case} one @param {Outcome} actual
 * @returns {{ name: string, expected: string, actual: string }[]}
 */
export function diffCase(one, actual){
    /** @type {{ name: string, expected: string, actual: string }[]} */
    const out = [];
    /** @param {string} name @param {string | number} want @param {string | number} got */
    const differ = (name, want, got)=>{
        if (want !== got)
        {
            out.push({ name, expected: String(want), actual: String(got) });
        }
    };
    const fault = (/** @type {{ vector: number, eip: number } | null} */ f)=>f === null ? 'none'
        : `#${/** @type {Record<number, string>} */ (VECTOR_NAMES)[f.vector] ?? f.vector} at ${hex(f.eip)}`;
    differ('fault', fault(one.fault), fault(actual.fault));
    if (one.fault === null && actual.fault === null && !actual.halted)
    {
        out.push({ name: 'halted', expected: 'halted', actual: 'still running at the budget' });
    }
    const { expected } = one;
    ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'].forEach((name, r)=>{
        differ(name, hex(expected.regs[r]), hex(actual.regs[r]));
    });
    const flags = COMPARED_FLAGS & ~one.undefinedFlags;
    differ('eflags', hex(expected.eflags & flags), hex(actual.eflags & flags));
    const want = expected.x87;
    const got = actual.x87;
    differ('x87 top', want.top, got.top);
    differ('x87 empty', hex(want.empty), hex(got.empty));
    differ('x87 control', hex(want.control), hex(got.control));
    const status = 0xffff & ~0x3800 & ~UNMODELLED_STATUS & ~one.undefinedStatus;
    differ('x87 status', hex(want.status & status), hex(got.status & status));
    for (let k = 0; k < 8; k++)
    {
        if ((want.empty >>> k & 1) !== 0)
        {
            continue;
        }
        const image = want.st[k];
        if (one.kind === 'mmx')
        {
            differ(`mm${k}`, low64(image).toString(16), got.bits[k].toString(16));
            continue;
        }
        const exact = got.exact[k];
        if (exact !== null)
        {
            differ(`st phys ${k} (exact)`, String(integerOf(image)), String(exact));
            continue;
        }
        const { nearest, tie } = doublesOf(image);
        if (got.bits[k] !== nearest && got.bits[k] !== tie
            && !(one.transcendental && ulpsApart(got.bits[k], nearest) <= TRANSCENDENTAL_ULPS))
        {
            out.push({ name: `st phys ${k}`,
                expected: `${image.toString(16)} (${doubleOf(nearest)})`,
                actual: `${got.bits[k].toString(16)} (${doubleOf(got.bits[k])})` });
        }
    }
    differ('mxcsr', hex(expected.mxcsr & MXCSR_CONTROL), hex(actual.mxcsr & MXCSR_CONTROL));
    for (let word = 0; word < 32; word++)
    {
        differ(`xmm${word >> 2}[${word & 3}]`, hex(expected.xmm[word]), hex(actual.xmm[word]));
    }
    const ignored = new Uint8Array(CORPUS_LAYOUT.DATA_SIZE);
    for (const [from, length] of one.ignored)
    {
        ignored.fill(1, from, from + length);
    }
    let shown = 0;
    for (let i = 0; i < CORPUS_LAYOUT.DATA_SIZE; i++)
    {
        if (ignored[i] === 0 && expected.data[i] !== actual.data[i] && shown++ < 8)
        {
            out.push({ name: `mem[${hex(CORPUS_LAYOUT.DATA_AT + i)}]`,
                expected: hex(expected.data[i]), actual: hex(actual.data[i]) });
        }
    }
    return out;
}

/** One line for a failing case. @param {X86Case} one @param {ReturnType<typeof diffCase>} divergences */
export function describe(one, divergences){
    const bytes = Buffer.from(one.code.subarray(0, -1)).toString('hex');
    return `${one.name} [${bytes}]: ${divergences.slice(0, 6)
        .map(d=>`${d.name} expected ${d.expected} got ${d.actual}`).join('; ')}`;
}

/**
 * What one engine made of one case: an outcome to judge; or the decoder's or
 * the model's refusal of an instruction at an address, with the state as it
 * stood (an engine's gap, unless the processor raised #UD right there); or,
 * for translated code, the instructions the emitter left out, by opcode,
 * which another tier runs.
 *
 * @typedef {{ outcome: Outcome } | { unsupported: string, eip: number, outcome: Outcome }
 *     | { leftOut: Map<string, number> }} Ran
 */

/**
 * Runs every case on an engine and judges it, with the known failures' list
 * for that tier (`x86-known.js`).
 *
 * A refusal at the address where the processor raised #UD is that same
 * invalid encoding: the decoder knows some encodings to be invalid and only
 * does not know others, and either way the program stops there. It is judged
 * as the #UD, registers and all.
 *
 * @param {X86Case[]} cases @param {'interpreter' | 'wasm' | 'translated'} tier
 * @param {(one: X86Case) => Ran} run
 */
export function judgeAll(cases, tier, run){
    /** @type {string[]} */
    const failures = [];
    /** @type {string[]} */
    const stale = [];
    /** @type {Map<string, number>} */
    const leftOut = new Map();
    let known = 0;
    let faulted = 0;
    let judgedCount = 0;
    for (const one of cases)
    {
        const ran = run(one);
        if ('leftOut' in ran)
        {
            for (const [opcode, count] of ran.leftOut)
            {
                leftOut.set(opcode, (leftOut.get(opcode) ?? 0) + count);
            }
            continue;
        }
        judgedCount++;
        /** @type {ReturnType<typeof diffCase>} */
        let divergences;
        if ('unsupported' in ran)
        {
            divergences = one.fault?.vector === 6 && one.fault.eip === ran.eip
                ? diffCase(one, { ...ran.outcome, fault: { vector: 6, eip: ran.eip } })
                : [{ name: 'model', expected: 'an instruction',
                    actual: `no model for ${ran.unsupported} at ${hex(ran.eip)}` }];
            faulted++;
        }
        else
        {
            divergences = diffCase(one, ran.outcome);
            faulted += ran.outcome.fault ? 1 : 0;
        }
        const verdict = judged(one, divergences, tier);
        if (verdict === 'known')
        {
            known++;
        }
        else if (verdict === 'stale')
        {
            stale.push(one.name);
        }
        else if (divergences.length > 0)
        {
            failures.push(describe(one, divergences));
        }
    }
    const top = [...leftOut].sort((a, b)=>b[1] - a[1]).slice(0, 24)
        .map(([opcode, count])=>`${opcode}×${count}`).join(' ');
    return { failures, stale, known, judged: judgedCount, leftOut, summary:
        `${judgedCount} of ${cases.length} cases judged (${faulted} faulted), ${failures.length}`
        + ` diverged, ${known} known failures, ${stale.length} stale`
        + `${leftOut.size > 0 ? `; left to another tier: ${top}` : ''}` };
}

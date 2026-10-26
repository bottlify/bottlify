/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SSE to SSE2 and MMX in a long-mode region: the sixteen XMM registers as
 * `v128` locals, each instruction what `ir-simd.js` (through `ir64.js`)
 * computes. An MMX register is the eight bytes of its x87 register in the
 * state block, as the interpreter keeps it: an operation loads it into a
 * `v128`'s low lane, the high one zero, runs the SSE form of the operation
 * where the low lane's result is MMX's, and stores the low lane back; then
 * the unit is in the MMX state (top zero, every register held), as `ir.js`
 * leaves it, and a register written holds no quadword integer for the x87.
 *
 * Integer forms are one or a few wasm SIMD operations. Float arithmetic is
 * wasm's, which rounds as the model does (to nearest, denormals kept). A NaN
 * operand propagates as the engine propagates it, which on an x86 host is the
 * processor's own choice (the destination's NaN quietened, else the
 * source's); an invalid operation's NaN is made the processor's default one
 * on a host whose own is positive, as the 32-bit translator does it
 * (`defaultNaN`). `min` and `max` are a compare and a
 * select, the source winning ties and NaNs. What depends on MXCSR's rounding
 * control rounds to nearest and leaves for the interpreter under any other
 * mode; a conversion between float widths leaves it a NaN, whose payload the
 * model carries through a number. Memory operands go through the emitter's
 * `place`, a 16-byte one of an instruction that needs it aligned leaving for
 * the interpreter (which raises #GP) where it is not.
 */

import { CF, PF, ZF } from '../decode/table.js';
import { SIMD } from '../wasm/simd.js';

/** The first XMM local; the next sixteen are the registers, three scratch ones past them. */
export const XMM = 37;
const V0 = XMM + 16;
const V1 = XMM + 17;
const V2 = XMM + 18;
/** Scratch scalars of the emitter's. */
const T0 = 25;
const U = 33;

/** The SIMD opcodes this file uses beyond `SIMD`'s, by name. */
const S = Object.freeze({
    ...SIMD,
    i8x16Shl: 107, i8x16ShrU: 109, i8x16MinS: 118, i8x16MaxS: 120,
    i16x8MinU: 151, i16x8MaxU: 153, i16x8ExtractLaneS: 24,
    i64x2ShrS: 204, i64x2Bitmask: 196, i8x16ExtractLaneS: 21,
});

/** Wasm scalar opcodes, by name. */
const W = Object.freeze({
    i32eqz: 0x45, i32ne: 0x47, i32and: 0x71, i32or: 0x72, i32shl: 0x74, i32geu: 0x4f,
    i64ne: 0x52, i64gtu: 0x56, i64and: 0x83, i64extendu: 0xad, i32wrap: 0xa7,
    f32ne: 0x5c, f32eq: 0x5b, f32lt: 0x5d, f32ge: 0x60, f64ne: 0x62, f64eq: 0x61, f64lt: 0x63,
    f64ge: 0x66, f32nearest: 0x90, f64nearest: 0x9e,
    f32converti32s: 0xb2, f32converti64s: 0xb4, f64converti32s: 0xb7, f64converti64s: 0xb9,
    select: 0x1b,
});

/** The 16-byte moves whose memory operand need not be aligned. */
const UNALIGNED = new Set(['movups', 'movupd', 'movdqu', 'lddqu']);

/**
 * Dwords [a, b, c, d] of two operands (0..3 the first, 4..7 the second) as a
 * byte shuffle.
 *
 * @param {number[]} picked
 */
const dwords = picked=>picked.flatMap(d=>[d * 4, d * 4 + 1, d * 4 + 2, d * 4 + 3]);
/** The same for words (0..7, 8..15). @param {number[]} picked */
const words = picked=>picked.flatMap(w=>[w * 2, w * 2 + 1]);
/** The same for qwords (0..1, 2..3). @param {number[]} picked */
const qwords = picked=>picked.flatMap(q=>[...Array(8).keys()].map(i=>q * 8 + i));

/** The packed integer operations, one wasm SIMD operation each. */
const PACKED = Object.freeze({
    paddb: S.i8x16Add, paddw: S.i16x8Add, paddd: S.i32x4Add, paddq: S.i64x2Add,
    psubb: S.i8x16Sub, psubw: S.i16x8Sub, psubd: S.i32x4Sub, psubq: S.i64x2Sub,
    paddsb: S.i8x16AddSatS, paddsw: S.i16x8AddSatS, paddusb: S.i8x16AddSatU,
    paddusw: S.i16x8AddSatU, psubsb: S.i8x16SubSatS, psubsw: S.i16x8SubSatS,
    psubusb: S.i8x16SubSatU, psubusw: S.i16x8SubSatU,
    pcmpeqb: S.i8x16Eq, pcmpeqw: S.i16x8Eq, pcmpeqd: S.i32x4Eq,
    pcmpgtb: S.i8x16GtS, pcmpgtw: S.i16x8GtS, pcmpgtd: S.i32x4GtS,
    pmullw: S.i16x8Mul, pminub: S.i8x16MinU, pmaxub: S.i8x16MaxU, pminsw: S.i16x8MinS,
    pmaxsw: S.i16x8MaxS, pavgb: S.i8x16AvgrU, pavgw: S.i16x8AvgrU, pmaddwd: S.i32x4DotI16x8S,
    packsswb: S.i8x16NarrowI16x8S, packssdw: S.i16x8NarrowI32x4S,
    packuswb: S.i8x16NarrowI16x8U,
    pand: S.and, por: S.or, pxor: S.xor, andps: S.and, andpd: S.and, orps: S.or, orpd: S.or,
    xorps: S.xor, xorpd: S.xor,
});
/** The unpacks, as shuffles of the two operands. */
const UNPACK = Object.freeze({
    punpcklbw: [0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23],
    punpckhbw: [8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31],
    punpcklwd: words([0, 8, 1, 9, 2, 10, 3, 11]), punpckhwd: words([4, 12, 5, 13, 6, 14, 7, 15]),
    punpckldq: dwords([0, 4, 1, 5]), punpckhdq: dwords([2, 6, 3, 7]),
    punpcklqdq: qwords([0, 2]), punpckhqdq: qwords([1, 3]),
    unpcklps: dwords([0, 4, 1, 5]), unpckhps: dwords([2, 6, 3, 7]),
    unpcklpd: qwords([0, 2]), unpckhpd: qwords([1, 3]),
    movlhps: qwords([0, 2]), movhlps: qwords([3, 1]),
});
/** The shifts: lane width in bits and the wasm shift. */
const SHIFTS = Object.freeze({
    psllw: [16, S.i16x8Shl], pslld: [32, S.i32x4Shl], psllq: [64, S.i64x2Shl],
    psrlw: [16, S.i16x8ShrU], psrld: [32, S.i32x4ShrU], psrlq: [64, S.i64x2ShrU],
    psraw: [16, S.i16x8ShrS], psrad: [32, S.i32x4ShrS],
});
/** Float arithmetic: f32x4 and f64x2 operations. */
const ARITH = Object.freeze({
    add: [S.f32x4Add, S.f64x2Add], sub: [S.f32x4Sub, S.f64x2Sub],
    mul: [S.f32x4Mul, S.f64x2Mul], div: [S.f32x4Div, S.f64x2Div],
});
/** The moves of a whole register or 16 bytes of memory. */
const MOVES = new Set(['movaps', 'movups', 'movapd', 'movupd', 'movdqa', 'movdqu', 'lddqu',
    'movntps', 'movntpd', 'movntdq']);

/**
 * Whether this file translates the instruction.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
export function translatesSimd(instruction){
    const { op, operands } = instruction;
    if (op === 'emms' || operands.some(operand=>operand.kind === 'mm'))
    {
        return translatesMmx(instruction);
    }
    if (MOVES.has(op) || op in PACKED || op in UNPACK || op in SHIFTS)
    {
        return true;
    }
    if (/^(add|sub|mul|div|sqrt|min|max)(ss|sd|ps|pd)$/.test(op) || /^cmp(ss|sd|ps|pd)$/.test(op))
    {
        // A compare's predicate beyond 7 is AVX's.
        return !op.startsWith('cmp') || /** @type {number} */ (operands[2].value) < 8;
    }
    switch (op)
    {
        case 'movss': case 'movsd': case 'movd': case 'movq': case 'movlps': case 'movlpd':
        case 'movhps': case 'movhpd': case 'pandn': case 'andnps': case 'andnpd':
        case 'pmulhw': case 'pmulhuw': case 'pmuludq': case 'psadbw': case 'pmovmskb':
        case 'movmskps': case 'movmskpd': case 'pshufd': case 'pshuflw': case 'pshufhw':
        case 'shufps': case 'shufpd': case 'pslldq': case 'psrldq': case 'pextrw': case 'pinsrw':
        case 'comiss': case 'ucomiss': case 'comisd': case 'ucomisd':
        case 'cvtsi2ss': case 'cvtsi2sd': case 'cvttss2si': case 'cvttsd2si': case 'cvtss2si':
        case 'cvtsd2si': case 'cvtdq2ps': case 'cvttps2dq': case 'cvtps2dq': case 'cvtdq2pd':
        case 'cvttpd2dq': case 'cvtpd2dq': case 'cvtss2sd': case 'cvtsd2ss': case 'cvtps2pd':
        case 'cvtpd2ps': case 'rcpps': case 'rcpss': case 'rsqrtps': case 'rsqrtss':
            return true;
        default:
            return false;
    }
}

/** The MMX forms beyond the packed operations, the unpacks and the shifts. */
const MMX = new Set(['movd', 'movq', 'movntq', 'pandn', 'pmulhw', 'pmulhuw', 'pmuludq', 'psadbw',
    'pmovmskb', 'pshufw', 'pextrw', 'pinsrw', 'emms']);
/** The unpacks of an MMX register's high half, whose SSE forms take the high quadword's. */
const MMX_UNPACK_HIGH = Object.freeze({
    punpckhbw: [4, 20, 5, 21, 6, 22, 7, 23, 8, 24, 9, 25, 10, 26, 11, 27],
    punpckhwd: words([2, 10, 3, 11, 4, 12, 5, 13]), punpckhdq: dwords([1, 5, 2, 6]),
});

/**
 * Whether an MMX instruction is one this file translates: of those between
 * an MMX and an XMM register the two moves alone, not the conversions; not
 * `maskmovq`, which writes through rdi.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
function translatesMmx(instruction){
    const { op, operands } = instruction;
    if (op === 'movq2dq' || op === 'movdq2q')
    {
        return true;
    }
    if (operands.some(operand=>operand.kind === 'xmm'))
    {
        return false;
    }
    return MMX.has(op) || op in SHIFTS || /^punpck[lh](bw|wd|dq)$/.test(op)
        || op in PACKED && !/ps$|pd$/.test(op);
}

/**
 * Emits an instruction `translatesSimd` takes.
 *
 * @param {any} e  the region's BlockEmitter
 * @param {import('../decode/decoder.js').Instruction} instruction
 * @param {number} index @param {number} at
 */
export function emitSimd(e, instruction, index, at){
    operation(e, instruction, index, at);
    const { b } = e;
    if (instruction.op === 'emms')
    {
        b.i32const(0).i32const(0xff).store('i32_8', { offset: e.layout.x87Empty, align: 0 });
    }
    else if (instruction.operands.some(operand=>operand.kind === 'mm'))
    {
        // Top zero and every register held: the two bytes side by side.
        b.i32const(0).i32const(0).store('i32_16', { offset: e.layout.x87Top, align: 0 });
    }
}

/**
 * The instruction's own work, which `emitSimd` follows with the unit's state.
 *
 * @param {any} e @param {import('../decode/decoder.js').Instruction} instruction
 * @param {number} index @param {number} at
 */
function operation(e, instruction, index, at){
    const { b } = e;
    const { op, operands } = instruction;
    const [dst, src, imm] = operands;
    const offset = e.layout.ramBase;
    const defined = instruction.flagsWritten & ~instruction.flagsUndefined;
    const memory = operands.find(operand=>operand.kind === 'mem');
    // Every access is checked before anything is written; a 16-byte one aligned where it must be.
    if (memory !== undefined)
    {
        e.place(memory, memory === dst, index, at);
        if (memory.size === 16 && !UNALIGNED.has(op))
        {
            b.localGet(e.A).i32const(15).op(W.i32and);
            e.exitIf(index, at);
        }
    }
    /** An XMM or memory operand's 16 bytes (a narrower memory one zero-extended). @param {any} operand */
    const vector = operand=>{
        if (operand.kind === 'xmm')
        {
            b.localGet(XMM + operand.reg);
        }
        else if (operand.kind === 'mm')
        {
            b.i32const(0).simdMem(S.load64Zero, { align: 0, offset: mmAt(e, operand.reg) });
        }
        else if (operand.size === 16)
        {
            b.localGet(e.A).loadV128({ offset, align: 0 });
        }
        else
        {
            b.localGet(e.A).simdMem(operand.size === 8 ? S.load64Zero : S.load32Zero,
                { align: 0, offset });
        }
    };
    /** The v128 on the stack into an XMM register, or 16 bytes of memory. @param {any} operand */
    const put = operand=>{
        if (operand.kind === 'xmm')
        {
            b.localSet(XMM + operand.reg);
            return;
        }
        if (operand.kind === 'mm')
        {
            b.localSet(V2).i32const(0).localGet(V2)
                .simdMem(S.store64Lane, { align: 0, offset: mmAt(e, operand.reg), lane: 0 });
            heldNoQuadword(e, operand.reg);
            return;
        }
        b.localSet(V2).localGet(e.A).localGet(V2);
        if (operand.size === 16)
        {
            b.storeV128({ offset, align: 0 });
        }
        else
        {
            b.simdMem(operand.size === 8 ? S.store64Lane : S.store32Lane,
                { align: 0, offset, lane: 0 });
        }
    };
    /** a op b (dst, src) on the stack. @param {number} code */
    const binary = code=>{
        vector(dst);
        vector(src);
        b.simd(code);
        put(dst);
    };
    /** A shuffle of dst (0..15) and src (16..31) into dst. @param {number[]} lanes */
    const shuffle = lanes=>{
        vector(dst);
        vector(src);
        b.simd(S.shuffle).op(lanes[0], lanes.slice(1));
        put(dst);
    };
    /** The low lane of `value` (a v128 on the stack), the rest of dst. @param {boolean} double */
    const mergeLow = double=>{
        b.localSet(V0);
        vector(dst);
        b.localGet(V0).simd(S.shuffle);
        const lanes = double ? [16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11, 12, 13, 14, 15]
            : [16, 17, 18, 19, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        b.op(lanes[0], lanes.slice(1));
        put(dst);
    };
    if ((op === 'emms' || operands.some(operand=>operand.kind === 'mm'))
        && mmx(e, instruction, vector, put, shuffle))
    {
        return;
    }
    if (MOVES.has(op))
    {
        vector(src);
        put(dst);
        return;
    }
    if (op in PACKED)
    {
        binary(PACKED[/** @type {keyof typeof PACKED} */ (op)]);
        return;
    }
    if (op in UNPACK)
    {
        shuffle(UNPACK[/** @type {keyof typeof UNPACK} */ (op)]);
        return;
    }
    if (op in SHIFTS)
    {
        shift(e, op, dst, src, vector, put);
        return;
    }
    const arith = /^(add|sub|mul|div)(ss|sd|ps|pd)$/.exec(op);
    if (arith !== null)
    {
        const double = arith[2].endsWith('d');
        const scalar = arith[2].startsWith('s');
        vector(dst);
        b.localTee(V0);
        vector(src);
        b.localTee(V1).simd(ARITH[/** @type {keyof typeof ARITH} */ (arith[1])][double ? 1 : 0]);
        defaultNaN(e, double, 2);
        if (scalar)
        {
            mergeLow(double);
        }
        else
        {
            put(dst);
        }
        return;
    }
    const unary = /^sqrt(ss|sd|ps|pd)$/.exec(op);
    if (unary !== null)
    {
        const double = unary[1].endsWith('d');
        vector(src);
        b.localTee(V0).simd(double ? S.f64x2Sqrt : S.f32x4Sqrt);
        defaultNaN(e, double, 1);
        if (unary[1].startsWith('s'))
        {
            mergeLow(double);
        }
        else
        {
            put(dst);
        }
        return;
    }
    const extreme = /^(min|max)(ss|sd|ps|pd)$/.exec(op);
    if (extreme !== null)
    {
        // dst where it wins strictly, else src as it is (NaNs and ties included).
        const double = extreme[2].endsWith('d');
        vector(dst);
        vector(src);
        vector(dst);
        vector(src);
        b.simd(extreme[1] === 'min' ? (double ? S.f64x2Lt : S.f32x4Lt)
            : (double ? S.f64x2Gt : S.f32x4Gt)).simd(S.bitselect);
        if (extreme[2].startsWith('s'))
        {
            mergeLow(double);
        }
        else
        {
            put(dst);
        }
        return;
    }
    const compare = /^cmp(ss|sd|ps|pd)$/.exec(op);
    if (compare !== null)
    {
        const double = compare[1].endsWith('d');
        predicate(e, double, /** @type {number} */ (imm.value), ()=>vector(dst), ()=>vector(src));
        if (compare[1].startsWith('s'))
        {
            mergeLow(double);
        }
        else
        {
            put(dst);
        }
        return;
    }
    switch (op)
    {
        case 'movss': case 'movsd':
        {
            const double = op === 'movsd';
            if (dst.kind === 'xmm' && src.kind === 'xmm')
            {
                vector(src);
                mergeLow(double);
                return;
            }
            // A load clears the rest; a store writes the low lane alone.
            vector(src);
            put(dst);
            return;
        }
        case 'movd': case 'movq':
            if (dst.kind === 'xmm')
            {
                if (src.kind === 'reg')
                {
                    e.readReg(src.reg, src.size);
                    b.simd(S.i64x2Splat).v128const(qwordMask(true)).simd(S.and);
                }
                else if (src.kind === 'xmm')
                {
                    // movq xmm, xmm: the low quadword, the rest cleared.
                    vector(src);
                    b.v128const(qwordMask(true)).simd(S.and);
                }
                else
                {
                    vector(src);
                }
                put(dst);
                return;
            }
            vector(src);
            if (dst.kind === 'reg')
            {
                b.simd(S.i64x2ExtractLane).op(0);
                if (dst.size === 4)
                {
                    b.i64const(0xffffffffn).op(W.i64and);
                }
                e.writeReg(dst.reg, 8);
                return;
            }
            put(dst);
            return;
        case 'movlps': case 'movlpd': case 'movhps': case 'movhpd':
        {
            const high = op.startsWith('movh');
            if (src.kind === 'xmm' && dst.kind === 'xmm')
            {
                // The register forms are movhlps and movlhps.
                shuffle(high ? qwords([0, 2]) : qwords([3, 1]));
                return;
            }
            if (dst.kind === 'xmm')
            {
                // Eight bytes into one half; the other half stays.
                b.localGet(e.A);
                vector(dst);
                b.simdMem(S.load64Lane, { align: 0, offset, lane: high ? 1 : 0 });
                put(dst);
                return;
            }
            b.localGet(e.A);
            vector(src);
            b.simdMem(S.store64Lane, { align: 0, offset, lane: high ? 1 : 0 });
            return;
        }
        case 'pandn': case 'andnps': case 'andnpd':
            // dst = ~dst & src: wasm's andnot is a & ~b.
            vector(src);
            vector(dst);
            b.simd(S.andnot);
            put(dst);
            return;
        case 'pmulhw': case 'pmulhuw':
        {
            const signed = op === 'pmulhw';
            for (const half of [0, 1])
            {
                vector(dst);
                vector(src);
                b.simd(signed ? (half ? S.i32x4ExtmulHighI16x8S : S.i32x4ExtmulLowI16x8S)
                    : (half ? S.i32x4ExtmulHighI16x8U : S.i32x4ExtmulLowI16x8U))
                    .i32const(16).simd(signed ? S.i32x4ShrS : S.i32x4ShrU);
            }
            // The high halves fit: a narrowing that cannot saturate.
            b.simd(signed ? S.i16x8NarrowI32x4S : S.i16x8NarrowI32x4U);
            put(dst);
            return;
        }
        case 'pmuludq':
            for (const operand of [dst, src])
            {
                vector(operand);
                vector(operand);
                b.simd(S.shuffle).op(0, [1, 2, 3, 8, 9, 10, 11, 0, 1, 2, 3, 8, 9, 10, 11]);
            }
            b.simd(S.i64x2ExtmulLowI32x4U);
            put(dst);
            return;
        case 'psadbw':
            // |a - b| a byte, summed in each half into its low word.
            vector(dst);
            vector(src);
            b.simd(S.i8x16SubSatU);
            vector(src);
            vector(dst);
            b.simd(S.i8x16SubSatU).simd(S.or).simd(S.i16x8ExtaddPairwiseI8x16U)
                .simd(S.i32x4ExtaddPairwiseI16x8U).localTee(V0).localGet(V0).localGet(V0)
                .simd(S.shuffle).op(4, [5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11])
                .simd(S.i32x4Add).v128const([0xff, 0xff, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0,
                    0, 0, 0]).simd(S.and);
            put(dst);
            return;
        case 'pmovmskb': case 'movmskps': case 'movmskpd':
            vector(src);
            b.simd(op === 'pmovmskb' ? S.i8x16Bitmask : op === 'movmskps' ? S.i32x4Bitmask
                : S.i64x2Bitmask).op(W.i64extendu);
            e.writeReg(dst.reg, 8);
            return;
        case 'pshufd':
        {
            const s = /** @type {number} */ (imm.value);
            vector(src);
            b.localTee(V0).localGet(V0);
            const lanes = dwords([s & 3, s >> 2 & 3, s >> 4 & 3, s >> 6 & 3]);
            b.simd(S.shuffle).op(lanes[0], lanes.slice(1));
            put(dst);
            return;
        }
        case 'pshuflw': case 'pshufhw':
        {
            const s = /** @type {number} */ (imm.value);
            const picked = [s & 3, s >> 2 & 3, s >> 4 & 3, s >> 6 & 3];
            const lanes = op === 'pshuflw' ? words([...picked, 4, 5, 6, 7])
                : words([0, 1, 2, 3, ...picked.map(w=>w + 4)]);
            vector(src);
            b.localTee(V0).localGet(V0).simd(S.shuffle).op(lanes[0], lanes.slice(1));
            put(dst);
            return;
        }
        case 'shufps':
        {
            const s = /** @type {number} */ (imm.value);
            shuffle(dwords([s & 3, s >> 2 & 3, 4 + (s >> 4 & 3), 4 + (s >> 6 & 3)]));
            return;
        }
        case 'shufpd':
        {
            const s = /** @type {number} */ (imm.value);
            shuffle(qwords([s & 1, 2 + (s >> 1 & 1)]));
            return;
        }
        case 'pslldq': case 'psrldq':
        {
            // Whole bytes, zeros shifted in; sixteen or more clears the register.
            const n = Math.min(/** @type {number} */ (src.value), 16);
            vector(dst);
            b.v128const(new Array(16).fill(0));
            const lanes = op === 'pslldq'
                ? [...Array(16).keys()].map(i=>(i < n ? 16 : i - n))
                : [...Array(16).keys()].map(i=>(i + n < 16 ? i + n : 16));
            b.simd(S.shuffle).op(lanes[0], lanes.slice(1));
            put(dst);
            return;
        }
        case 'pextrw':
            vector(src);
            b.simd(S.i16x8ExtractLaneU).op(/** @type {number} */ (imm.value) & 7)
                .op(W.i64extendu);
            e.writeReg(dst.reg, 8);
            return;
        case 'pinsrw':
            vector(dst);
            if (src.kind === 'reg')
            {
                e.readReg(src.reg, 4);
                b.op(W.i32wrap);
            }
            else
            {
                b.localGet(e.A).load('i32_16u', { offset, align: 0 });
            }
            b.simd(S.i16x8ReplaceLane).op(/** @type {number} */ (imm.value) & 7);
            put(dst);
            return;
        case 'comiss': case 'ucomiss': case 'comisd': case 'ucomisd':
        {
            // Unordered ZF PF CF, equal ZF, below CF.
            const double = op.endsWith('sd');
            const extract = ()=>b.simd(double ? S.f64x2ExtractLane : S.f32x4ExtractLane).op(0);
            vector(dst);
            extract();
            b.localSet(double ? e.F64 : e.F32);
            vector(src);
            extract();
            b.localSet(double ? e.G64 : e.G32);
            const [x, y] = double ? [e.F64, e.G64] : [e.F32, e.G32];
            const [ne, eq, lt] = double ? [W.f64ne, W.f64eq, W.f64lt] : [W.f32ne, W.f32eq, W.f32lt];
            b.localGet(x).localGet(x).op(ne).localGet(y).localGet(y).op(ne).op(W.i32or)
                .localSet(U);
            b.i32const(ZF | PF | CF).i32const(0).localGet(U).op(W.select);
            b.i32const(ZF).i32const(0).localGet(x).localGet(y).op(eq).op(W.select).op(W.i32or);
            b.i32const(CF).i32const(0).localGet(x).localGet(y).op(lt).op(W.select).op(W.i32or);
            e.setFlags(defined);
            return;
        }
        case 'cvtsi2ss': case 'cvtsi2sd':
        {
            const double = op === 'cvtsi2sd';
            const wide = src.size === 8;
            if (wide)
            {
                // A quadword rounds by MXCSR: nearest here, any other mode the interpreter's.
                roundingIsNearest(e, index, at);
            }
            vector(dst);
            if (src.kind === 'reg')
            {
                e.readReg(src.reg, src.size);
            }
            else
            {
                b.localGet(e.A).load(wide ? 'i64' : 'i64_32u', { offset, align: 0 });
            }
            if (!wide)
            {
                b.op(W.i32wrap);
            }
            b.op(double ? (wide ? W.f64converti64s : W.f64converti32s)
                : (wide ? W.f32converti64s : W.f32converti32s));
            b.simd(double ? S.f64x2ReplaceLane : S.f32x4ReplaceLane).op(0);
            put(dst);
            return;
        }
        case 'cvttss2si': case 'cvttsd2si': case 'cvtss2si': case 'cvtsd2si':
        {
            const double = op.endsWith('sd2si');
            const truncate = op.startsWith('cvtt');
            if (!truncate)
            {
                roundingIsNearest(e, index, at);
            }
            vector(src);
            b.simd(double ? S.f64x2ExtractLane : S.f32x4ExtractLane).op(0);
            if (!truncate)
            {
                b.op(double ? W.f64nearest : W.f32nearest);
            }
            toInteger(e, double, dst.size === 8);
            e.writeReg(dst.reg, 8);
            return;
        }
        case 'cvtdq2ps':
            vector(src);
            b.simd(S.f32x4ConvertI32x4S);
            put(dst);
            return;
        case 'cvtdq2pd':
            vector(src);
            b.simd(S.f64x2ConvertLowI32x4S);
            put(dst);
            return;
        case 'cvttps2dq': case 'cvtps2dq': case 'cvttpd2dq': case 'cvtpd2dq':
        {
            const double = op.includes('pd');
            if (!op.startsWith('cvtt'))
            {
                roundingIsNearest(e, index, at);
            }
            vector(src);
            if (!op.startsWith('cvtt'))
            {
                b.simd(double ? S.f64x2Nearest : S.f32x4Nearest);
            }
            packedToIntegers(e, double);
            put(dst);
            return;
        }
        case 'rcpps': case 'rcpss': case 'rsqrtps': case 'rsqrtss':
        {
            // As the model computes them, exactly: 1 / x, or 1 / sqrt(x), each
            // lane widened to a double, worked there and rounded back once --
            // a float's own division would round the root first.
            const root = op.startsWith('rsqrt');
            vector(src);
            b.localSet(V0);
            for (const high of [false, true])
            {
                b.f64const(1).simd(S.f64x2Splat).localGet(V0);
                if (high)
                {
                    b.localGet(V0).simd(S.shuffle).op(8, [9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11,
                        12, 13, 14, 15]);
                }
                b.simd(S.f64x2PromoteLowF32x4);
                if (root)
                {
                    b.simd(S.f64x2Sqrt);
                }
                b.simd(S.f64x2Div).simd(S.f32x4DemoteF64x2Zero);
            }
            b.simd(S.shuffle).op(0, dwords([0, 1, 4, 5]).slice(1));
            defaultNaN(e, false, 1);
            if (op.endsWith('ss'))
            {
                mergeLow(false);
            }
            else
            {
                put(dst);
            }
            return;
        }
        case 'cvtss2sd': case 'cvtsd2ss': case 'cvtps2pd': case 'cvtpd2ps':
        {
            // A NaN in goes to the interpreter, which carries its payload as the model does.
            const narrowing = op === 'cvtsd2ss' || op === 'cvtpd2ps';
            const scalar = op.startsWith('cvts');
            vector(src);
            b.localTee(V0).localGet(V0).simd(narrowing ? S.f64x2Ne : S.f32x4Ne)
                .simd(narrowing ? S.i64x2Bitmask : S.i32x4Bitmask)
                .i32const(scalar ? 1 : 3).op(W.i32and);
            e.exitIf(index, at);
            b.localGet(V0).simd(narrowing ? S.f32x4DemoteF64x2Zero : S.f64x2PromoteLowF32x4);
            if (scalar)
            {
                mergeLow(!narrowing);
            }
            else
            {
                put(dst);
            }
            return;
        }
        default:
            throw new Error(`long emit: no SIMD form for ${op}`);
    }
}

/** Where an MMX register's eight bytes lie in the state block. @param {any} e @param {number} reg */
function mmAt(e, reg){
    return e.layout.x87 + reg * 16;
}

/**
 * An MMX register written: the x87 no longer finds in it the quadword
 * integer a `fild` left (`x87Exact`), as `ir-simd.js` clears its bit.
 *
 * @param {any} e @param {number} reg
 */
function heldNoQuadword(e, reg){
    const { b } = e;
    const offset = /** @type {number} */ (e.layout.x87Exact);
    b.i32const(0).i32const(0).load('i32_8u', { offset, align: 0 }).i32const(~(1 << reg) & 0xff)
        .op(W.i32and).store('i32_8', { offset, align: 0 });
}

/**
 * The MMX forms whose SSE form would not leave MMX's result in the low lane,
 * or that SSE does not have; answers false for the rest, which the SSE forms
 * emit on the low lanes.
 *
 * @param {any} e @param {import('../decode/decoder.js').Instruction} instruction
 * @param {(operand: any) => void} vector @param {(operand: any) => void} put
 * @param {(lanes: number[]) => void} shuffle
 */
function mmx(e, instruction, vector, put, shuffle){
    const { b } = e;
    const { op, operands } = instruction;
    const [dst, src, imm] = operands;
    const offset = e.layout.ramBase;
    switch (op)
    {
        case 'emms':
            return true;
        case 'movd': case 'movq':
        {
            if (dst.kind !== 'mm' || src.kind !== 'reg')
            {
                return false;
            }
            // A doubleword zero-extended, a quadword whole.
            const reg = /** @type {number} */ (dst.reg);
            e.readReg(src.reg, src.size);
            b.localSet(T0).i32const(0).localGet(T0)
                .store('i64', { offset: mmAt(e, reg), align: 0 });
            heldNoQuadword(e, reg);
            return true;
        }
        case 'movntq': case 'movq2dq': case 'movdq2q':
            // A quadword as it is: into an XMM register's low half, the high
            // one cleared, or out of it.
            vector(src);
            put(dst);
            return true;
        case 'pshufw':
        {
            const s = /** @type {number} */ (imm.value);
            const lanes = words([s & 3, s >> 2 & 3, s >> 4 & 3, s >> 6 & 3, 4, 5, 6, 7]);
            vector(src);
            b.localTee(V0).localGet(V0).simd(S.shuffle).op(lanes[0], lanes.slice(1));
            put(dst);
            return true;
        }
        case 'pextrw':
            vector(src);
            b.simd(S.i16x8ExtractLaneU).op(/** @type {number} */ (imm.value) & 3).op(W.i64extendu);
            e.writeReg(dst.reg, 8);
            return true;
        case 'pinsrw':
            vector(dst);
            if (src.kind === 'reg')
            {
                e.readReg(src.reg, 4);
                b.op(W.i32wrap);
            }
            else
            {
                b.localGet(e.A).load('i32_16u', { offset, align: 0 });
            }
            b.simd(S.i16x8ReplaceLane).op(/** @type {number} */ (imm.value) & 3);
            put(dst);
            return true;
        case 'packsswb': case 'packssdw': case 'packuswb':
            // Both operands' four (or two) lanes in one vector, narrowed: its low half.
            vector(dst);
            vector(src);
            b.simd(S.shuffle).op(0, qwords([0, 2]).slice(1)).localTee(V0).localGet(V0)
                .simd(PACKED[op]);
            put(dst);
            return true;
        default:
            if (op in MMX_UNPACK_HIGH)
            {
                shuffle(MMX_UNPACK_HIGH[/** @type {keyof typeof MMX_UNPACK_HIGH} */ (op)]);
                return true;
            }
            return false;
    }
}

/** A mask of the low quadword's bytes (`low`) or the high one's. @param {boolean} low */
function qwordMask(low){
    return [...new Array(8).fill(low ? 0xff : 0), ...new Array(8).fill(low ? 0 : 0xff)];
}

/**
 * A packed shift by an immediate or by an XMM register's (or memory's) low
 * quadword: past the lane width a logical shift clears and an arithmetic one
 * fills with the sign; wasm takes the count modulo the width, so it is
 * clamped first.
 *
 * @param {any} e @param {string} op @param {any} dst @param {any} src
 * @param {(operand: any) => void} vector @param {(operand: any) => void} put
 */
function shift(e, op, dst, src, vector, put){
    const { b } = e;
    const [bits, code] = SHIFTS[/** @type {keyof typeof SHIFTS} */ (op)];
    const arithmetic = op.startsWith('psra');
    if (src.kind === 'imm')
    {
        const count = /** @type {number} */ (src.value) & 0xff;
        vector(dst);
        if (count >= bits && !arithmetic)
        {
            b.drop();
            b.v128const(new Array(16).fill(0));
        }
        else
        {
            b.i32const(Math.min(count, bits - 1)).simd(code);
        }
        put(dst);
        return;
    }
    // The count: the whole low quadword, unsigned. Past the width, a logical
    // shift goes once more by one, which clears the lane; an arithmetic one
    // stops at the sign.
    vector(src);
    b.simd(S.i64x2ExtractLane).op(0).localTee(T0).i64const(BigInt(bits - 1)).op(W.i64gtu)
        .localSet(U);
    vector(dst);
    b.i32const(bits - 1).localGet(T0).op(W.i32wrap).localGet(U).op(W.select).simd(code);
    if (!arithmetic)
    {
        b.localGet(U).simd(code);
    }
    put(dst);
}

/**
 * The result on the stack (its operands in V0 and, for two, V1), each lane
 * that is a NaN while no operand's lane was -- an invalid operation: 0/0,
 * inf - inf, the root of a negative -- made the processor's default NaN, sign
 * set, as the 32-bit translator's `defaultNaN` does; nothing on a host whose
 * own default NaN is x86's. A NaN operand propagates as the engine
 * propagates it, its own bits quietened, as on the processor.
 *
 * @param {any} e @param {boolean} double @param {1 | 2} operands
 */
function defaultNaN(e, double, operands){
    if (e.defaultNaNNegative)
    {
        return;
    }
    const { b } = e;
    const [eq, ne] = double ? [S.f64x2Eq, S.f64x2Ne] : [S.f32x4Eq, S.f32x4Ne];
    const indefinite = double ? [0, 0, 0, 0, 0, 0, 0xf8, 0xff, 0, 0, 0, 0, 0, 0, 0xf8, 0xff]
        : [0, 0, 0xc0, 0xff, 0, 0, 0xc0, 0xff, 0, 0, 0xc0, 0xff, 0, 0, 0xc0, 0xff];
    b.localSet(V2).v128const(indefinite).localGet(V2).localGet(V2).localGet(V2).simd(ne)
        .localGet(V0).localGet(V0).simd(eq).simd(S.and);
    if (operands === 2)
    {
        b.localGet(V1).localGet(V1).simd(eq).simd(S.and);
    }
    b.simd(S.bitselect);
}

/**
 * The `cmpps` predicates 0 to 7 of the two operands' lanes: all ones where
 * one holds.
 *
 * @param {any} e @param {boolean} double @param {number} which
 * @param {() => void} a @param {() => void} b
 */
function predicate(e, double, which, a, b){
    const w = e.b;
    const [eq, ne, lt, le] = double ? [S.f64x2Eq, S.f64x2Ne, S.f64x2Lt, S.f64x2Le]
        : [S.f32x4Eq, S.f32x4Ne, S.f32x4Lt, S.f32x4Le];
    /** Either lane a NaN. */
    const unordered = ()=>{
        a();
        a();
        w.simd(ne);
        b();
        b();
        w.simd(ne).simd(S.or);
    };
    switch (which)
    {
        case 0: a(); b(); w.simd(eq); return;
        case 1: a(); b(); w.simd(lt); return;
        case 2: a(); b(); w.simd(le); return;
        case 3: unordered(); return;
        case 4: a(); b(); w.simd(ne); return;
        case 5: a(); b(); w.simd(lt).simd(S.not); return;
        case 6: a(); b(); w.simd(le).simd(S.not); return;
        default: unordered(); w.simd(S.not);
    }
}

/** Leaves for the interpreter unless MXCSR rounds to nearest. @param {any} e @param {number} index @param {number} at */
function roundingIsNearest(e, index, at){
    e.b.i32const(0).load('i32', { offset: e.layout.mxcsr }).i32const(0x6000).op(W.i32and);
    e.exitIf(index, at);
}

/**
 * The float on the stack, already rounded, to an integer by the processor's
 * rule: a NaN or a value out of range is the integer indefinite (the most
 * negative), which wasm's saturating truncation gives below the range only.
 * Leaves the result as an i64 (a dword zero-extended).
 *
 * @param {any} e @param {boolean} double @param {boolean} wide
 */
function toInteger(e, double, wide){
    const { b } = e;
    const value = double ? e.F64 : e.F32;
    const top = wide ? 2 ** 63 : 2 ** 31;
    b.localSet(value);
    if (wide)
    {
        b.i64const(-(1n << 63n));
    }
    else
    {
        b.i32const(-0x80000000);
    }
    // The saturating truncations, 0xfc 0 (i32 from f32), 2 (from f64), 4 and 6 (i64).
    b.localGet(value).op(0xfc).u32((wide ? 4 : 0) + (double ? 2 : 0));
    // The indefinite where the value is NaN or at least 2^31 (2^63).
    b.localGet(value).localGet(value).op(double ? W.f64ne : W.f32ne).localGet(value);
    if (double)
    {
        b.f64const(top);
    }
    else
    {
        b.f32const(top);
    }
    b.op(double ? W.f64ge : W.f32ge).op(W.i32or).op(W.select);
    if (!wide)
    {
        b.op(W.i64extendu);
    }
}

/**
 * Each float lane of the v128 on the stack, already rounded, to an i32 by
 * the processor's rule: NaN and out of range the integer indefinite. Two
 * doubles give the low two lanes, the rest zero.
 *
 * @param {any} e @param {boolean} double
 */
function packedToIntegers(e, double){
    const { b } = e;
    b.localTee(V0).simd(double ? S.i32x4TruncSatF64x2SZero : S.i32x4TruncSatF32x4S).localSet(V1);
    b.v128const([0, 0, 0, 0x80, 0, 0, 0, 0x80, 0, 0, 0, 0x80, 0, 0, 0, 0x80]).localGet(V1);
    // The lanes that are NaN or at least 2^31.
    b.localGet(V0).localGet(V0).simd(double ? S.f64x2Ne : S.f32x4Ne).localGet(V0);
    if (double)
    {
        b.f64const(2 ** 31).simd(S.f64x2Splat).simd(S.f64x2Ge).simd(S.or);
        // Each double's mask in the dword its integer went to.
        b.v128const(new Array(16).fill(0)).simd(S.shuffle)
            .op(0, [1, 2, 3, 8, 9, 10, 11, 16, 16, 16, 16, 16, 16, 16, 16]);
    }
    else
    {
        b.f32const(2 ** 31).simd(S.f32x4Splat).simd(S.f32x4Ge).simd(S.or);
    }
    b.simd(S.bitselect);
}

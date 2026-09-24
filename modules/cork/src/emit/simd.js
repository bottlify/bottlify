/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SSE and MMX: the XMM registers as `v128` locals, the MMX registers as
 * `i64` locals that alias the x87 registers' low eight bytes.
 *
 * Most instructions are one wasm SIMD operation. Where the two differ the
 * difference is spelled out: `minps`/`maxps` return their second operand
 * when either lane is a NaN or both are zero (a compare and a select, not
 * wasm's min); a float-to-integer conversion answers the "integer
 * indefinite" 0x80000000 for a NaN or a value out of range (a saturating
 * conversion and a fix-up); `rsqrtps` and `rcpps` are computed exactly, as
 * the emulator does, so results stay bit-identical to what the library's
 * programs already run against. MMX operations run in the low lane of a
 * `v128` and come back as an `i64`; an MMX instruction also marks the x87
 * stack as it does on the processor (top at zero, every register held),
 * which the region's exit writes out when one ran.
 */

import { CF, OF, PF, SF, ZF, AF } from '../decode/table.js';
import { EMPTY, ValType } from '../wasm/encoder.js';
import { SIMD } from '../wasm/simd.js';
import { I32 } from './flags.js';
import { Local, MMX_HELD, MMX_TOP } from './region.js';
import { emitAddress, readOp, writeOp, writeReg } from './integer.js';
import { checkAccess, noteStore } from './memory.js';
import { x87FromMmx } from './x87.js';

const F32 = Object.freeze({
    eq: 0x5b, ne: 0x5c, lt: 0x5d, gt: 0x5e, le: 0x5f, ge: 0x60, add: 0x92, sub: 0x93, mul: 0x94,
    div: 0x95, sqrt: 0x91, nearest: 0x90, trunc: 0x8f, ceil: 0x8d, floor: 0x8e,
    convertI32S: 0xb2, demoteF64: 0xb6,
    truncSatI32S: 0xfc00, reinterpretI32: 0xbe,
});
const F64 = Object.freeze({
    add: 0xa0, sub: 0xa1, mul: 0xa2, div: 0xa3, sqrt: 0x9f, nearest: 0x9e, trunc: 0x9d,
    ceil: 0x9b, floor: 0x9c, convertI32S: 0xb7, promoteF32: 0xbb, truncSatI32S: 0xfc02,
});

/**
 * @typedef {import('./region.js').RegionEmitter} E
 * @typedef {import('../decode/decoder.js').Instruction} Instruction
 * @typedef {import('../decode/decoder.js').Operand} Operand
 */

/** A lane-0 mask: the low four bytes set. */
/** The processor's default NaN in every lane: sign set, quiet bit set. */
const DEFAULT_NAN_32 = [0, 0, 0xc0, 0xff, 0, 0, 0xc0, 0xff, 0, 0, 0xc0, 0xff, 0, 0, 0xc0, 0xff];
const DEFAULT_NAN_64 = [0, 0, 0, 0, 0, 0, 0xf8, 0xff, 0, 0, 0, 0, 0, 0, 0xf8, 0xff];
const LANE0_32 = [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/** A lane-0 mask: the low eight bytes set. */
const LANE0_64 = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0];

/** @param {number[]} bytes @returns {number[]} a 16-byte pattern */
const pattern = bytes=>bytes;

/** The shuffle that picks dwords `[a, b, c, d]` out of two operands (0..3 first, 4..7 second). @param {number[]} dwords */
const dwordShuffle = dwords=>dwords.flatMap(d=>[d * 4, d * 4 + 1, d * 4 + 2, d * 4 + 3]);
/** The same for words (0..7 first, 8..15 second). @param {number[]} words */
const wordShuffle = words=>words.flatMap(w=>[w * 2, w * 2 + 1]);

/**
 * Emits an SSE or MMX instruction. Answers false when it is not one this
 * file translates.
 *
 * An MMX instruction -- one with an mm operand, whichever end the register
 * is at, a read or a store into memory included -- puts the x87 stack in the
 * MMX state, as on the processor: the top at zero and every register held,
 * which the region's exit writes out. The rule sits here, where every form
 * passes through, rather than in the forms' own lowering, so a form added
 * later cannot forget it and a form the file refuses cannot claim it.
 *
 * @param {E} e
 * @param {Instruction} instruction
 * @param {boolean} flagsLive
 * @returns {boolean}
 */
export function emitSimd(e, instruction, flagsLive){
    const done = emitForm(e, instruction, flagsLive);
    if (done && instruction.operands.some(operand=>operand.kind === 'mm'))
    {
        if (e.x87.active)
        {
            // The region keeps the x87 stack in its own locals, so the MMX state
            // goes there rather than into the exit's mark: the top at zero and
            // every register held, as the processor leaves it and as the x87
            // after this instruction is compiled (the tracker's top) and run
            // (the empty mask) for. The registers' values and forms were
            // reconciled by the write's own lowering (`x87FromMmx`).
            e.b.i32const(0).localSet(Local.x87Top);
            e.b.i32const(0).localSet(Local.x87Empty);
            if (e.x87.current !== null)
            {
                e.x87.current = { top: 0, slot: [...e.x87.current.slot] };
            }
        }
        else
        {
            markMmx(e);
        }
    }
    return done;
}


/**
 * One form's lowering.
 *
 * @param {E} e
 * @param {Instruction} instruction
 * @param {boolean} flagsLive
 * @returns {boolean}
 */
function emitForm(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands } = instruction;
    const [dst, src, imm] = operands;
    if (!e.context.features.simd)
    {
        return false;
    }
    /** @param {number} opcode */
    const simd = opcode=>b.simd(opcode);
    /** A v128 constant of sixteen bytes. @param {number[]} bytes */
    const constant = bytes=>b.v128const(bytes);
    /** @param {number[]} bytes */
    const shuffle = bytes=>b.op(0xfd, [SIMD.shuffle, ...bytes]);

    const isMm = dst?.kind === 'mm' || src?.kind === 'mm';

    switch (op)
    {
        // --- moves ---
        case 'movaps': case 'movups': case 'movapd': case 'movupd': case 'movdqa': case 'movdqu':
        case 'lddqu': case 'movntps': case 'movntpd': case 'movntdq':
            writeV(e, dst, ()=>readV(e, src, 16));
            return true;
        case 'movss': case 'movsd':
        {
            const width = op === 'movss' ? 4 : 8;
            if (dst.kind === 'xmm' && src.kind === 'xmm')
            {
                // The low lane from the source, the rest kept.
                readV(e, src, 16);
                readV(e, dst, 16);
                constant(width === 4 ? LANE0_32 : LANE0_64);
                simd(SIMD.bitselect);
                writeV(e, dst, null);
                return true;
            }
            if (dst.kind === 'xmm')
            {
                // A load clears the upper lanes.
                writeV(e, dst, ()=>readV(e, src, width));
                return true;
            }
            writeV(e, dst, ()=>readV(e, src, 16), width);
            return true;
        }
        case 'movlps': case 'movlpd': case 'movhps': case 'movhpd':
        {
            const high = op === 'movhps' || op === 'movhpd';
            if (dst.kind === 'mem')
            {
                prepareAddress(e, dst);
                noteStore(e, 8);
                b.localGet(Local.addr);
                readV(e, src, 16);
                b.simdMem(SIMD.store64Lane,
                    { align: 3, offset: e.layout.ramBase, lane: high ? 1 : 0 });
                return true;
            }
            if (src.kind === 'mem')
            {
                prepareAddress(e, src);
                b.localGet(Local.addr);
                readV(e, dst, 16);
                b.simdMem(SIMD.load64Lane,
                    { align: 3, offset: e.layout.ramBase, lane: high ? 1 : 0 });
                writeV(e, dst, null);
                return true;
            }
            // Register forms: movhlps (0f 12) and movlhps (0f 16).
            readV(e, dst, 16);
            readV(e, src, 16);
            // movlhps: the high half from the source's low; movhlps: the low
            // half from the source's high.
            shuffle(high
                ? [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]
                : [24, 25, 26, 27, 28, 29, 30, 31, 8, 9, 10, 11, 12, 13, 14, 15]);
            writeV(e, dst, null);
            return true;
        }
        case 'movd':
            prepareAddress(e, src);
            if (dst.kind === 'xmm')
            {
                constant(new Array(16).fill(0));
                readOp(e, src);
                b.op(0xfd, [SIMD.i32x4ReplaceLane, 0]);
                writeV(e, dst, null);
                return true;
            }
            if (dst.kind === 'mm')
            {
                readOp(e, src);
                b.op(0xad); // i64.extend_i32_u
                writeM(e, dst, null);
                return true;
            }
            // r/m32 <- the low dword of an xmm or mm.
            prepareAddress(e, dst);
            writeOp(e, dst, ()=>{
                if (src.kind === 'xmm')
                {
                    readV(e, src, 16);
                    b.op(0xfd, [SIMD.i32x4ExtractLane, 0]);
                }
                else
                {
                    readM(e, src);
                    b.op(0xa7); // i64.wrap
                }
            });
            return true;
        case 'movntq':
            writeM(e, dst, ()=>readM(e, src));
            return true;
        case 'movddup':
            // Both lanes from the source's low qword.
            writeV(e, dst, ()=>{
                readV(e, src, src.kind === 'mem' ? 8 : 16);
                b.localTee(vecTemp(e)).localGet(vecTemp(e));
                shuffle([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
            });
            return true;
        case 'movsldup': case 'movshdup':
            writeV(e, dst, ()=>{
                readV(e, src, 16);
                b.localTee(vecTemp(e)).localGet(vecTemp(e));
                shuffle(dwordShuffle(op === 'movsldup' ? [0, 0, 2, 2] : [1, 1, 3, 3]));
            });
            return true;
        case 'haddps': case 'hsubps': case 'haddpd': case 'hsubpd':
        {
            // Pairs within each operand: the even lanes gathered against the
            // odd ones, destination first.
            const double = op.endsWith('pd');
            const add = op.startsWith('hadd');
            readV(e, dst, 16);
            b.localSet(vecTemp(e));
            readV(e, src, 16);
            b.localSet(vecTemp2(e));
            b.localGet(vecTemp(e)).localGet(vecTemp2(e));
            shuffle(dwordShuffle(double ? [0, 1, 4, 5] : [0, 2, 4, 6]));
            b.localGet(vecTemp(e)).localGet(vecTemp2(e));
            shuffle(dwordShuffle(double ? [2, 3, 6, 7] : [1, 3, 5, 7]));
            simd(double
                ? (add ? SIMD.f64x2Add : SIMD.f64x2Sub)
                : (add ? SIMD.f32x4Add : SIMD.f32x4Sub));
            writeV(e, dst, null);
            return true;
        }
        case 'addsubps': case 'addsubpd':
        {
            // Alternating subtract and add: the even lanes from a - b, the
            // odd from a + b, picked out of the two results by a shuffle.
            const double = op.endsWith('pd');
            const difference = e.vecTempLocal(2);
            readV(e, dst, 16);
            b.localSet(vecTemp(e));
            readV(e, src, 16);
            b.localSet(vecTemp2(e));
            b.localGet(vecTemp(e)).localGet(vecTemp2(e));
            simd(double ? SIMD.f64x2Sub : SIMD.f32x4Sub).localSet(difference);
            b.localGet(vecTemp(e)).localGet(vecTemp2(e));
            simd(double ? SIMD.f64x2Add : SIMD.f32x4Add).localSet(vecTemp2(e));
            b.localGet(difference).localGet(vecTemp2(e));
            shuffle(double
                ? [0, 1, 2, 3, 4, 5, 6, 7, 24, 25, 26, 27, 28, 29, 30, 31]
                : [0, 1, 2, 3, 20, 21, 22, 23, 8, 9, 10, 11, 28, 29, 30, 31]);
            writeV(e, dst, null);
            return true;
        }
        case 'cvtpd2pi': case 'cvttpd2pi':
        {
            // Two doubles to two dwords in an MMX register, each through the
            // scalar conversion with its indefinite.
            prepareAddress(e, src);
            readV(e, src, 16);
            b.localSet(vecTemp(e));
            for (const lane of [0, 1])
            {
                b.localGet(vecTemp(e));
                b.op(0xfd, [SIMD.f64x2ExtractLane, lane]);
                b.localSet(Local.d0);
                if (op === 'cvtpd2pi')
                {
                    roundByMxcsr(e, Local.d0, F64_ROUND, false);
                }
                scalarToInt(e, true);
                b.localSet(lane === 0 ? Local.t1 : Local.t2);
            }
            writeM(e, dst, ()=>{
                b.localGet(Local.t2).op(0xad); // i64.extend_i32_u
                b.i64const(32n).op(0x86);      // i64.shl
                b.localGet(Local.t1).op(0xad);
                b.op(0x84);                     // i64.or
            });
            return true;
        }
        case 'stmxcsr':
            prepareAddress(e, dst);
            noteStore(e, 4);
            b.localGet(Local.addr);
            b.i32const(0).load('i32', { offset: e.layout.mxcsr });
            b.store('i32', { offset: e.layout.ramBase });
            return true;
        case 'ldmxcsr':
            prepareAddress(e, dst);
            b.i32const(0);
            b.localGet(Local.addr).load('i32', { offset: e.layout.ramBase });
            b.store('i32', { offset: e.layout.mxcsr });
            return true;
        case 'movq':
            if (dst.kind === 'mm' || (dst.kind === 'mem' && src.kind === 'mm'))
            {
                writeM(e, dst, ()=>readM(e, src));
                return true;
            }
            if (dst.kind === 'xmm')
            {
                // Zero-extended from a memory qword or an xmm's low lane.
                writeV(e, dst, ()=>{
                    if (src.kind === 'xmm')
                    {
                        readV(e, src, 16);
                        constant(LANE0_64);
                        simd(SIMD.and);
                    }
                    else
                    {
                        readV(e, src, 8);
                    }
                });
                return true;
            }
            writeV(e, dst, ()=>readV(e, src, 16), 8);
            return true;
        case 'movq2dq':
            writeV(e, dst, ()=>{
                readM(e, src);
                simd(SIMD.i64x2Splat);
                constant(LANE0_64);
                simd(SIMD.and);
            });
            return true;
        case 'movdq2q':
            readV(e, src, 16);
            b.op(0xfd, [SIMD.i64x2ExtractLane, 0]);
            writeM(e, dst, null);
            return true;
        case 'maskmovq': case 'maskmovdqu':
        {
            // Bytes of the first operand whose mask byte has its sign set are
            // stored at [edi]; the rest of the line is left as it was, which a
            // read of the line, a bitselect and a store of the line achieves.
            if (instruction.prefixes.segment >= 0)
            {
                return false;
            }
            const whole = op === 'maskmovdqu';
            b.localGet(Local.reg + 7).localSet(Local.addr);
            checkAccess(e, whole ? 16 : 8);
            noteStore(e, whole ? 16 : 8);
            b.localGet(Local.addr);
            readV(e, dst, 16);
            b.localGet(Local.addr);
            if (whole)
            {
                b.simdMem(SIMD.load, { align: 4, offset: e.layout.ramBase });
            }
            else
            {
                b.simdMem(SIMD.load64Zero, { align: 3, offset: e.layout.ramBase });
            }
            readV(e, src, 16);
            b.i32const(7);
            simd(SIMD.i8x16ShrS);
            simd(SIMD.bitselect);
            if (whole)
            {
                b.simdMem(SIMD.store, { align: 4, offset: e.layout.ramBase });
            }
            else
            {
                b.simdMem(SIMD.store64Lane, { align: 3, offset: e.layout.ramBase, lane: 0 });
            }
            return true;
        }
        case 'emms':
            // Every register empty again -- into the empty mask the region
            // keeps when the x87 registers are in its own locals, since its
            // exit writes that mask back over anything written straight into
            // the state block, and into the state block otherwise. The
            // run's hold is released too, or the exit would hold every
            // register right after. The top is left alone: an MMX instruction
            // of this run put it at zero and leaving the MMX state does not
            // put it back, and a run with none leaves the machine's own.
            if (e.x87.active)
            {
                b.i32const(0xff).localSet(Local.x87Empty);
            }
            else
            {
                b.i32const(0).i32const(0xff).store('i32_8',
                    { offset: e.layout.x87Empty });
            }
            b.localGet(e.mmxTouchedLocal()).i32const(~MMX_HELD).op(I32.and)
                .localSet(e.mmxTouchedLocal());
            // What the block's x87 knew was held is empty now: the next x87
            // instruction tests the mask again rather than skip the test.
            /** @type {any} */ (e.x87).known = undefined;
            return true;

        // --- packed and scalar float arithmetic ---
        case 'addps': case 'subps': case 'mulps': case 'divps':
        case 'addpd': case 'subpd': case 'mulpd': case 'divpd':
        case 'addss': case 'subss': case 'mulss': case 'divss':
        case 'addsd': case 'subsd': case 'mulsd': case 'divsd':
        {
            const base = op.slice(0, 3);
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            const opcode = double
                ? { add: SIMD.f64x2Add, sub: SIMD.f64x2Sub, mul: SIMD.f64x2Mul,
                    div: SIMD.f64x2Div }[base]
                : { add: SIMD.f32x4Add, sub: SIMD.f32x4Sub, mul: SIMD.f32x4Mul,
                    div: SIMD.f32x4Div }[base];
            binary(e, dst, src, ()=>simd(/** @type {number} */ (opcode)), scalar ? (double ? 8 : 4) : 0,
                double ? 8 : 4);
            return true;
        }
        case 'sqrtps': case 'sqrtpd': case 'sqrtss': case 'sqrtsd':
        {
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            unary(e, dst, src, ()=>simd(double ? SIMD.f64x2Sqrt : SIMD.f32x4Sqrt),
                scalar ? (double ? 8 : 4) : 0, double ? 8 : 4);
            return true;
        }
        case 'rsqrtps': case 'rsqrtss': case 'rcpps': case 'rcpss':
            unary(e, dst, src, ()=>{
                // 1 / sqrt(x) and 1 / x, exactly.
                b.localSet(vecTemp2(e));
                b.f32const(1);
                simd(SIMD.f32x4Splat);
                b.localGet(vecTemp2(e));
                if (op.startsWith('rsqrt'))
                {
                    simd(SIMD.f32x4Sqrt);
                }
                simd(SIMD.f32x4Div);
            }, op.endsWith('ss') ? 4 : 0, 4);
            return true;
        case 'minps': case 'maxps': case 'minss': case 'maxss':
        case 'minpd': case 'maxpd': case 'minsd': case 'maxsd':
        {
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            const min = op.startsWith('min');
            // (a < b) ? a : b for min, (a > b) ? a : b for max: the second
            // operand whenever the compare is false, NaN and zeros included.
            binary(e, dst, src, ()=>{
                // stack: a b
                b.localSet(vecTemp(e));   // b
                b.localSet(vecTemp2(e));  // a
                b.localGet(vecTemp2(e)).localGet(vecTemp(e));
                b.localGet(vecTemp2(e)).localGet(vecTemp(e));
                simd(double
                    ? (min ? SIMD.f64x2Lt : SIMD.f64x2Gt)
                    : (min ? SIMD.f32x4Lt : SIMD.f32x4Gt));
                simd(SIMD.bitselect);
            }, scalar ? (double ? 8 : 4) : 0);
            return true;
        }
        case 'andps': case 'andpd': case 'pand':
            bitwise(e, dst, src, isMm, SIMD.and);
            return true;
        case 'orps': case 'orpd': case 'por':
            bitwise(e, dst, src, isMm, SIMD.or);
            return true;
        case 'xorps': case 'xorpd': case 'pxor':
            bitwise(e, dst, src, isMm, SIMD.xor);
            return true;
        case 'andnps': case 'andnpd': case 'pandn':
            // ~dst & src: wasm's andnot is x & ~y, so the operands swap.
            if (isMm)
            {
                return andnotMm(e, dst, src);
            }
            readV(e, src, 16);
            readV(e, dst, 16);
            simd(SIMD.andnot);
            writeV(e, dst, null);
            return true;
        case 'cmpps': case 'cmppd': case 'cmpss': case 'cmpsd':
        {
            const double = op.endsWith('pd') || op.endsWith('sd');
            const scalar = op.endsWith('ss') || op.endsWith('sd');
            const predicate = /** @type {number} */ (imm.value) & 7;
            binary(e, dst, src, ()=>compare(e, predicate, double), scalar ? (double ? 8 : 4) : 0);
            return true;
        }
        case 'comiss': case 'ucomiss': case 'comisd': case 'ucomisd':
            comparison(e, dst, src, op.endsWith('sd'), flagsLive);
            return true;
        case 'shufps':
        {
            const s = /** @type {number} */ (imm.value);
            readV(e, dst, 16);
            readV(e, src, 16);
            shuffle(dwordShuffle([s & 3, s >> 2 & 3, 4 + (s >> 4 & 3), 4 + (s >> 6 & 3)]));
            writeV(e, dst, null);
            return true;
        }
        case 'shufpd':
        {
            const s = /** @type {number} */ (imm.value);
            readV(e, dst, 16);
            readV(e, src, 16);
            shuffle(dwordShuffle([
                (s & 1) * 2, (s & 1) * 2 + 1, 4 + (s >> 1 & 1) * 2, 5 + (s >> 1 & 1) * 2,
            ]));
            writeV(e, dst, null);
            return true;
        }
        case 'unpcklps': case 'unpckhps': case 'unpcklpd': case 'unpckhpd':
        {
            const high = op.startsWith('unpckh');
            const double = op.endsWith('pd');
            readV(e, dst, 16);
            readV(e, src, 16);
            if (double)
            {
                shuffle(dwordShuffle(high ? [2, 3, 6, 7] : [0, 1, 4, 5]));
            }
            else
            {
                shuffle(dwordShuffle(high ? [2, 6, 3, 7] : [0, 4, 1, 5]));
            }
            writeV(e, dst, null);
            return true;
        }
        case 'movmskps': case 'movmskpd':
            readV(e, src, 16);
            if (op === 'movmskpd')
            {
                // The two sign bits, as bits 0 and 1: move them into lanes 0 and 1.
                b.localTee(vecTemp(e)).localGet(vecTemp(e));
                shuffle(dwordShuffle([1, 3, 1, 3]));
                simd(SIMD.i32x4Bitmask);
                b.i32const(3).op(I32.and);
            }
            else
            {
                simd(SIMD.i32x4Bitmask);
            }
            writeReg(e, /** @type {number} */ (dst.reg), 4, false);
            return true;

        // --- conversions ---
        case 'cvtsi2ss': case 'cvtsi2sd':
        {
            const double = op === 'cvtsi2sd';
            prepareAddress(e, src);
            readV(e, dst, 16);
            readOp(e, src);
            b.op(double ? F64.convertI32S : F32.convertI32S);
            b.op(0xfd, [double ? SIMD.f64x2ReplaceLane : SIMD.f32x4ReplaceLane, 0]);
            writeV(e, dst, null);
            return true;
        }
        case 'cvttss2si': case 'cvtss2si': case 'cvttsd2si': case 'cvtsd2si':
        {
            const double = op.endsWith('sd2si');
            const truncate = op.startsWith('cvtt');
            prepareAddress(e, src);
            readV(e, src, double ? 8 : 4);
            b.op(0xfd, [double ? SIMD.f64x2ExtractLane : SIMD.f32x4ExtractLane, 0]);
            b.localSet(double ? Local.d0 : Local.f0);
            if (!truncate)
            {
                roundByMxcsr(e, double ? Local.d0 : Local.f0, double ? F64_ROUND : F32_ROUND,
                    false);
            }
            scalarToInt(e, double);
            writeReg(e, /** @type {number} */ (dst.reg), 4, false);
            return true;
        }
        case 'cvtdq2ps':
            unary(e, dst, src, ()=>simd(SIMD.f32x4ConvertI32x4S), 0);
            return true;
        case 'cvttps2dq': case 'cvtps2dq':
            unary(e, dst, src, ()=>{
                if (op === 'cvtps2dq')
                {
                    b.localSet(vecTemp2(e));
                    roundByMxcsr(e, vecTemp2(e), F32X4_ROUND, true);
                    b.localGet(vecTemp2(e));
                }
                packedToInt(e);
            }, 0);
            return true;
        case 'cvtps2pd':
            unary(e, dst, src, ()=>simd(SIMD.f64x2PromoteLowF32x4), 0);
            return true;
        case 'cvtpd2ps':
            unary(e, dst, src, ()=>simd(SIMD.f32x4DemoteF64x2Zero), 0);
            return true;
        case 'cvtss2sd':
            readV(e, dst, 16);
            prepareAddress(e, src);
            readV(e, src, 4);
            b.op(0xfd, [SIMD.f32x4ExtractLane, 0]);
            b.op(F64.promoteF32);
            b.op(0xfd, [SIMD.f64x2ReplaceLane, 0]);
            writeV(e, dst, null);
            return true;
        case 'cvtsd2ss':
            readV(e, dst, 16);
            prepareAddress(e, src);
            readV(e, src, 8);
            b.op(0xfd, [SIMD.f64x2ExtractLane, 0]);
            b.op(F32.demoteF64);
            b.op(0xfd, [SIMD.f32x4ReplaceLane, 0]);
            writeV(e, dst, null);
            return true;
        case 'cvtdq2pd':
            unary(e, dst, src, ()=>simd(SIMD.f64x2ConvertLowI32x4S), 0);
            return true;
        case 'cvttpd2dq': case 'cvtpd2dq':
            unary(e, dst, src, ()=>{
                b.localSet(vecTemp(e));
                if (op === 'cvtpd2dq')
                {
                    roundByMxcsr(e, vecTemp(e), F64X2_ROUND, true);
                }
                // The bad lanes -- NaN or out of range -- as f64-wide masks, then
                // their low dwords brought into lanes 0 and 1 (zeros elsewhere).
                b.localGet(vecTemp(e)).localGet(vecTemp(e));
                simd(SIMD.f64x2Ne);
                b.localGet(vecTemp(e));
                b.f64const(2147483648);
                simd(SIMD.f64x2Splat);
                simd(SIMD.f64x2Ge);
                simd(SIMD.or);
                b.localGet(vecTemp(e));
                b.f64const(-2147483649);
                simd(SIMD.f64x2Splat);
                simd(SIMD.f64x2Le);
                simd(SIMD.or);
                constant(new Array(16).fill(0));
                shuffle(dwordShuffle([0, 2, 4, 4]));
                b.localSet(vecTemp2(e));
                b.i32const(-0x80000000);
                simd(SIMD.i32x4Splat);
                b.localGet(vecTemp(e));
                simd(SIMD.i32x4TruncSatF64x2SZero);
                b.localGet(vecTemp2(e));
                simd(SIMD.bitselect);
            }, 0);
            return true;
        case 'cvtpi2ps': case 'cvtpi2pd':
        {
            const double = op === 'cvtpi2pd';
            readM(e, src);
            simd(SIMD.i64x2Splat);
            if (double)
            {
                simd(SIMD.f64x2ConvertLowI32x4S);
                writeV(e, dst, null);
                return true;
            }
            simd(SIMD.f32x4ConvertI32x4S);
            // The low two lanes from the conversion, the high two kept.
            readV(e, dst, 16);
            constant(LANE0_64);
            simd(SIMD.bitselect);
            writeV(e, dst, null);
            return true;
        }
        case 'cvttps2pi': case 'cvtps2pi':
            prepareAddress(e, src);
            readV(e, src, 8);
            if (op === 'cvtps2pi')
            {
                b.localSet(vecTemp2(e));
                roundByMxcsr(e, vecTemp2(e), F32X4_ROUND, true);
                b.localGet(vecTemp2(e));
            }
            packedToInt(e);
            b.op(0xfd, [SIMD.i64x2ExtractLane, 0]);
            writeM(e, dst, null);
            return true;

        // --- packed integer ---
        case 'paddb': case 'paddw': case 'paddd': case 'paddq': case 'paddsb': case 'paddsw':
        case 'paddusb': case 'paddusw': case 'psubb': case 'psubw': case 'psubd': case 'psubq':
        case 'psubsb': case 'psubsw': case 'psubusb': case 'psubusw':
        case 'pcmpeqb': case 'pcmpeqw': case 'pcmpeqd':
        case 'pcmpgtb': case 'pcmpgtw': case 'pcmpgtd':
        case 'pmullw': case 'pminub': case 'pmaxub': case 'pminsw': case 'pmaxsw':
        case 'pavgb': case 'pavgw':
        case 'pmaddwd':
        {
            const opcode = /** @type {Record<string, number>} */ ({
                paddb: SIMD.i8x16Add, paddw: SIMD.i16x8Add, paddd: SIMD.i32x4Add,
                paddq: SIMD.i64x2Add,
                paddsb: SIMD.i8x16AddSatS, paddsw: SIMD.i16x8AddSatS,
                paddusb: SIMD.i8x16AddSatU, paddusw: SIMD.i16x8AddSatU,
                psubb: SIMD.i8x16Sub, psubw: SIMD.i16x8Sub, psubd: SIMD.i32x4Sub,
                psubq: SIMD.i64x2Sub,
                psubsb: SIMD.i8x16SubSatS, psubsw: SIMD.i16x8SubSatS,
                psubusb: SIMD.i8x16SubSatU, psubusw: SIMD.i16x8SubSatU,
                pcmpeqb: SIMD.i8x16Eq, pcmpeqw: SIMD.i16x8Eq, pcmpeqd: SIMD.i32x4Eq,
                pcmpgtb: SIMD.i8x16GtS, pcmpgtw: SIMD.i16x8GtS, pcmpgtd: SIMD.i32x4GtS,
                pmullw: SIMD.i16x8Mul, pminub: SIMD.i8x16MinU, pmaxub: SIMD.i8x16MaxU,
                pminsw: SIMD.i16x8MinS, pmaxsw: SIMD.i16x8MaxS, pavgb: SIMD.i8x16AvgrU,
                pavgw: SIMD.i16x8AvgrU, pmaddwd: SIMD.i32x4DotI16x8S,
            })[op];
            packedBinary(e, dst, src, isMm, ()=>simd(opcode));
            return true;
        }
        case 'pmulhw': case 'pmulhuw':
            packedBinary(e, dst, src, isMm, ()=>{
                // The high halves of the sixteen-bit products: widen, shift, narrow.
                b.localSet(vecTemp(e));
                b.localSet(vecTemp2(e));
                b.localGet(vecTemp2(e)).localGet(vecTemp(e));
                simd(op === 'pmulhw' ? SIMD.i32x4ExtmulLowI16x8S : SIMD.i32x4ExtmulLowI16x8U);
                b.i32const(16);
                simd(SIMD.i32x4ShrS);
                b.localGet(vecTemp2(e)).localGet(vecTemp(e));
                simd(op === 'pmulhw' ? SIMD.i32x4ExtmulHighI16x8S : SIMD.i32x4ExtmulHighI16x8U);
                b.i32const(16);
                simd(SIMD.i32x4ShrS);
                simd(SIMD.i16x8NarrowI32x4S);
            });
            return true;
        case 'pmuludq':
            packedBinary(e, dst, src, isMm, ()=>{
                // Lanes 0 and 2 as unsigned dwords, multiplied to qwords.
                b.localSet(vecTemp(e));
                b.localSet(vecTemp2(e));
                b.localGet(vecTemp2(e)).localGet(vecTemp2(e));
                shuffle(dwordShuffle([0, 2, 0, 2]));
                b.localGet(vecTemp(e)).localGet(vecTemp(e));
                shuffle(dwordShuffle([0, 2, 0, 2]));
                simd(SIMD.i64x2ExtmulLowI32x4U);
            });
            return true;
        case 'psadbw':
            packedBinary(e, dst, src, isMm, ()=>{
                // |a - b| per byte as max - min, summed per eight bytes.
                b.localSet(vecTemp(e));
                b.localSet(vecTemp2(e));
                b.localGet(vecTemp2(e)).localGet(vecTemp(e));
                simd(SIMD.i8x16MaxU);
                b.localGet(vecTemp2(e)).localGet(vecTemp(e));
                simd(SIMD.i8x16MinU);
                simd(SIMD.i8x16Sub);
                simd(SIMD.i16x8ExtaddPairwiseI8x16U);
                simd(SIMD.i32x4ExtaddPairwiseI16x8U);
                b.localSet(vecTemp(e));
                // Sum lanes 0+1 into lane 0 and 2+3 into lane 2, zeros in 1 and 3.
                b.localGet(vecTemp(e));
                b.localGet(vecTemp(e));
                constant(new Array(16).fill(0));
                shuffle(dwordShuffle([1, 4, 3, 4]));
                simd(SIMD.i32x4Add);
                constant([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
                simd(SIMD.and);
            });
            return true;
        case 'punpcklbw': case 'punpcklwd': case 'punpckldq': case 'punpcklqdq':
        case 'punpckhbw': case 'punpckhwd': case 'punpckhdq': case 'punpckhqdq':
            packedBinary(e, dst, src, isMm, ()=>shuffle(unpackPattern(op, isMm)));
            return true;
        case 'packsswb': case 'packuswb': case 'packssdw':
            packedBinary(e, dst, src, isMm, ()=>{
                if (isMm)
                {
                    // Each MMX operand's four (or two) lanes sit in the low half;
                    // the narrow of the two low halves interleaved is what MMX
                    // gives: [a-lanes, b-lanes] = narrow(a, b) then compact.
                    b.localSet(vecTemp(e));
                    b.localSet(vecTemp2(e));
                    b.localGet(vecTemp2(e)).localGet(vecTemp(e));
                    simd(op === 'packsswb' ? SIMD.i8x16NarrowI16x8S
                        : op === 'packuswb' ? SIMD.i8x16NarrowI16x8U : SIMD.i16x8NarrowI32x4S);
                    // a's lanes are bytes 0..3 (or words 0..1), b's at 8..11 (4..5):
                    // compact them, shuffling the result against itself.
                    b.localTee(vecTemp(e)).localGet(vecTemp(e));
                    if (op === 'packssdw')
                    {
                        shuffle(wordShuffle([0, 1, 4, 5, 0, 0, 0, 0]));
                    }
                    else
                    {
                        shuffle(pattern([0, 1, 2, 3, 8, 9, 10, 11, 0, 0, 0, 0, 0, 0, 0, 0]));
                    }
                }
                else
                {
                    simd(op === 'packsswb' ? SIMD.i8x16NarrowI16x8S
                        : op === 'packuswb' ? SIMD.i8x16NarrowI16x8U : SIMD.i16x8NarrowI32x4S);
                }
            });
            return true;
        case 'psllw': case 'pslld': case 'psllq': case 'psrlw': case 'psrld': case 'psrlq':
        case 'psraw': case 'psrad':
            return packedShift(e, instruction, isMm);
        case 'pslldq': case 'psrldq':
        {
            const n = Math.min(/** @type {number} */ (src.value), 16);
            readV(e, dst, 16);
            constant(new Array(16).fill(0));
            shuffle(op === 'pslldq'
                ? Array.from({ length: 16 }, (_, i)=>(i < n ? 16 : i - n))
                : Array.from({ length: 16 }, (_, i)=>(i + n < 16 ? i + n : 16)));
            writeV(e, dst, null);
            return true;
        }
        case 'pmovmskb':
            if (isMm)
            {
                readM(e, src);
                simd(SIMD.i64x2Splat);
                simd(SIMD.i8x16Bitmask);
                b.i32const(0xff).op(I32.and);
            }
            else
            {
                readV(e, src, 16);
                simd(SIMD.i8x16Bitmask);
            }
            writeReg(e, /** @type {number} */ (dst.reg), 4, false);
            return true;
        case 'pextrw':
        {
            const lane = /** @type {number} */ (imm.value) & (isMm ? 3 : 7);
            if (isMm)
            {
                readM(e, src);
                simd(SIMD.i64x2Splat);
            }
            else
            {
                readV(e, src, 16);
            }
            b.op(0xfd, [SIMD.i16x8ExtractLaneU, lane]);
            writeReg(e, /** @type {number} */ (dst.reg), 4, false);
            return true;
        }
        case 'pinsrw':
        {
            const lane = /** @type {number} */ (imm.value) & (isMm ? 3 : 7);
            prepareAddress(e, src);
            if (isMm)
            {
                readM(e, dst);
                simd(SIMD.i64x2Splat);
                readOp(e, src);
                b.op(0xfd, [SIMD.i16x8ReplaceLane, lane]);
                b.op(0xfd, [SIMD.i64x2ExtractLane, 0]);
                writeM(e, dst, null);
                return true;
            }
            readV(e, dst, 16);
            readOp(e, src);
            b.op(0xfd, [SIMD.i16x8ReplaceLane, lane]);
            writeV(e, dst, null);
            return true;
        }
        case 'pshufw':
        {
            const s = /** @type {number} */ (imm.value);
            readM(e, src);
            simd(SIMD.i64x2Splat);
            b.localSet(vecTemp(e));
            b.localGet(vecTemp(e)).localGet(vecTemp(e));
            shuffle(wordShuffle([s & 3, s >> 2 & 3, s >> 4 & 3, s >> 6 & 3, 0, 0, 0, 0]));
            b.op(0xfd, [SIMD.i64x2ExtractLane, 0]);
            writeM(e, dst, null);
            return true;
        }
        case 'pshufd':
        {
            const s = /** @type {number} */ (imm.value);
            readV(e, src, 16);
            b.localSet(vecTemp(e));
            b.localGet(vecTemp(e)).localGet(vecTemp(e));
            shuffle(dwordShuffle([s & 3, s >> 2 & 3, s >> 4 & 3, s >> 6 & 3]));
            writeV(e, dst, null);
            return true;
        }
        case 'pshuflw': case 'pshufhw':
        {
            const s = /** @type {number} */ (imm.value);
            const base = op === 'pshuflw' ? 0 : 4;
            const words = [0, 1, 2, 3, 4, 5, 6, 7];
            for (let i = 0; i < 4; i++)
            {
                words[base + i] = base + (s >> (i * 2) & 3);
            }
            readV(e, src, 16);
            b.localSet(vecTemp(e));
            b.localGet(vecTemp(e)).localGet(vecTemp(e));
            shuffle(wordShuffle(words));
            writeV(e, dst, null);
            return true;
        }
        default:
            return false;
    }
}

// --- operand access ---

/**
 * Computes a memory operand's address into `addr`; nothing for a register.
 *
 * @param {E} e @param {Operand} operand
 */
function prepareAddress(e, operand){
    if (operand.kind === 'mem')
    {
        emitAddress(e, operand, true);
        e.b.localSet(Local.addr);
        checkAccess(e, operand.size);
    }
}

/**
 * Pushes an xmm operand as a v128: the register's local, or `width` bytes
 * from memory zero-extended (16 for the whole register).
 *
 * @param {E} e @param {Operand} operand @param {number} width
 */
function readV(e, operand, width){
    const { b } = e;
    if (operand.kind === 'xmm')
    {
        b.localGet(e.xmmLocal(/** @type {number} */ (operand.reg)));
        return;
    }
    if (operand.kind === 'mm')
    {
        readM(e, operand);
        b.simd(SIMD.i64x2Splat);
        return;
    }
    prepareAddress(e, operand);
    b.localGet(Local.addr);
    if (width === 16)
    {
        b.simdMem(SIMD.load, { align: 4, offset: e.layout.ramBase });
    }
    else if (width === 8)
    {
        b.simdMem(SIMD.load64Zero, { align: 3, offset: e.layout.ramBase });
    }
    else
    {
        b.simdMem(SIMD.load32Zero, { align: 2, offset: e.layout.ramBase });
    }
}

/**
 * Writes an xmm operand: the v128 pushed by `pushValue` (or already on the
 * stack when null). To memory, `width` bytes of it.
 *
 * @param {E} e @param {Operand} operand @param {(() => void) | null} pushValue
 * @param {number} [width]
 */
function writeV(e, operand, pushValue, width = 16){
    const { b } = e;
    if (operand.kind === 'xmm')
    {
        pushValue?.();
        b.localSet(e.xmmLocal(/** @type {number} */ (operand.reg), true));
        return;
    }
    if (pushValue !== null)
    {
        prepareAddress(e, operand);
        noteStore(e, width);
        b.localGet(Local.addr);
        pushValue();
    }
    else
    {
        b.localSet(vecTemp(e));
        prepareAddress(e, operand);
        noteStore(e, width);
        b.localGet(Local.addr);
        b.localGet(vecTemp(e));
    }
    if (width === 16)
    {
        b.simdMem(SIMD.store, { align: 4, offset: e.layout.ramBase });
    }
    else if (width === 8)
    {
        b.simdMem(SIMD.store64Lane, { align: 3, offset: e.layout.ramBase, lane: 0 });
    }
    else
    {
        b.simdMem(SIMD.store32Lane, { align: 2, offset: e.layout.ramBase, lane: 0 });
    }
}

/** Pushes an MMX operand as an i64. @param {E} e @param {Operand} operand */
function readM(e, operand){
    const { b } = e;
    if (operand.kind === 'mm')
    {
        b.localGet(e.mmLocal(/** @type {number} */ (operand.reg)));
        return;
    }
    prepareAddress(e, operand);
    b.localGet(Local.addr).load('i64', { offset: e.layout.ramBase });
}

/**
 * Writes an MMX operand from the i64 pushed by `pushValue` (or on the stack).
 *
 * @param {E} e @param {Operand} operand @param {(() => void) | null} pushValue
 */
function writeM(e, operand, pushValue){
    const { b } = e;
    if (operand.kind === 'mm')
    {
        const physical = /** @type {number} */ (operand.reg);
        const mm = e.mmLocal(physical, true);
        pushValue?.();
        b.localSet(mm);
        // The register's x87 view follows its MMX view, so the two agree where
        // they meet again later in the region (see `x87FromMmx`).
        x87FromMmx(e, physical, mm);
        return;
    }
    if (pushValue !== null)
    {
        prepareAddress(e, operand);
        noteStore(e, 8);
        b.localGet(Local.addr);
        pushValue();
    }
    else
    {
        b.localSet(Local.t64);
        prepareAddress(e, operand);
        noteStore(e, 8);
        b.localGet(Local.addr);
        b.localGet(Local.t64);
    }
    b.store('i64', { offset: e.layout.ramBase });
}

/**
 * An MMX instruction ran: the region's exit puts the x87 stack in the MMX
 * state, the top at zero and every register held. Both bits, and not a set
 * of the hold alone: an `emms` later in the run releases the hold, and the
 * top is then still the zero this instruction put there.
 *
 * @param {E} e
 */
function markMmx(e){
    e.b.localGet(e.mmxTouchedLocal()).i32const(MMX_HELD | MMX_TOP).op(I32.or)
        .localSet(e.mmxTouchedLocal());
}

/** A v128 scratch local. @param {E} e */
const vecTemp = e=>e.vecTempLocal(0);
/** A second one. @param {E} e */
const vecTemp2 = e=>e.vecTempLocal(1);

/**
 * Rounds the value held in a local by the SSE control word's rounding
 * control: nearest, down, up or toward zero. The conversions that round
 * (the ones without the extra t) read it at run time, as the processor
 * does; a program that sets the mode with `ldmxcsr` gets the mode.
 *
 * @param {E} e @param {number} local
 * @param {{ nearest: number, floor: number, ceil: number, trunc: number }} ops
 * @param {boolean} vector  the ops are v128 ones
 */
function roundByMxcsr(e, local, ops, vector){
    const { b } = e;
    const apply = (/** @type {number} */ opcode)=>{
        b.localGet(local);
        if (vector)
        {
            b.simd(opcode);
        }
        else
        {
            b.op(opcode);
        }
        b.localSet(local);
    };
    // The mode in `count`, a local no conversion holds anything in.
    b.i32const(0).load('i32', { offset: e.layout.mxcsr }).i32const(13).op(I32.shrU)
        .i32const(3).op(I32.and).localSet(Local.count);
    b.localGet(Local.count).op(I32.eqz);
    e.openIf('nearest', EMPTY);
    apply(ops.nearest);
    b.op(0x05);
    b.localGet(Local.count).i32const(1).op(I32.eq);
    e.openIf('down', EMPTY);
    apply(ops.floor);
    b.op(0x05);
    b.localGet(Local.count).i32const(2).op(I32.eq);
    e.openIf('up', EMPTY);
    apply(ops.ceil);
    b.op(0x05);
    apply(ops.trunc);
    e.close();
    e.close();
    e.close();
}

const F32_ROUND = { nearest: F32.nearest, floor: F32.floor, ceil: F32.ceil, trunc: F32.trunc };
const F64_ROUND = { nearest: F64.nearest, floor: F64.floor, ceil: F64.ceil, trunc: F64.trunc };
const F32X4_ROUND = {
    nearest: SIMD.f32x4Nearest, floor: SIMD.f32x4Floor, ceil: SIMD.f32x4Ceil,
    trunc: SIMD.f32x4Trunc,
};
const F64X2_ROUND = {
    nearest: SIMD.f64x2Nearest, floor: SIMD.f64x2Floor, ceil: SIMD.f64x2Ceil,
    trunc: SIMD.f64x2Trunc,
};

// --- forms ---

/**
 * dst = op(dst, src) on v128, with the result merged into the low `scalar`
 * bytes only when the form is scalar.
 *
 * @param {E} e @param {Operand} dst @param {Operand} src @param {() => void} operation
 * @param {number} scalar  0, 4 or 8
 */
function binary(e, dst, src, operation, scalar, floatWidth = 0){
    const { b } = e;
    readV(e, dst, 16);
    readV(e, src, scalar || 16);
    const fix = floatWidth !== 0 && !e.context.features.defaultNaNNegative;
    if (fix)
    {
        b.localSet(vecTemp2(e));
        b.localTee(vecTemp(e));
        b.localGet(vecTemp2(e));
    }
    operation();
    if (fix)
    {
        defaultNaN(e, floatWidth === 8, 2);
    }
    if (scalar)
    {
        readV(e, dst, 16);
        b.v128const(scalar === 4 ? LANE0_32 : LANE0_64);
        b.simd(SIMD.bitselect);
    }
    writeV(e, dst, null);
}

/**
 * dst = op(src) on v128, merged into the low lane for a scalar form.
 *
 * @param {E} e @param {Operand} dst @param {Operand} src @param {() => void} operation
 * @param {number} scalar
 */
function unary(e, dst, src, operation, scalar, floatWidth = 0){
    const { b } = e;
    readV(e, src, scalar || 16);
    const fix = floatWidth !== 0 && !e.context.features.defaultNaNNegative;
    if (fix)
    {
        b.localTee(vecTemp(e));
    }
    operation();
    if (fix)
    {
        defaultNaN(e, floatWidth === 8, 1);
    }
    if (scalar)
    {
        readV(e, dst, 16);
        b.v128const(scalar === 4 ? LANE0_32 : LANE0_64);
        b.simd(SIMD.bitselect);
    }
    writeV(e, dst, null);
}

/**
 * The result on the stack, with every lane that is a NaN while no input
 * lane was (an invalid operation: 0/0, inf - inf, sqrt of a negative)
 * replaced by the processor's default NaN, whose sign is set. Emitted only
 * on a host whose own default NaN is positive; an x86 host leaves the bits
 * the instruction leaves. A NaN input propagates as the engine propagates
 * it, which is the input's own bits quieted, as on the processor.
 *
 * @param {E} e @param {boolean} double @param {1 | 2} inputs  in vecTemp (and vecTemp2)
 */
function defaultNaN(e, double, inputs){
    const { b } = e;
    const result = e.vecTempLocal(2);
    const eq = double ? SIMD.f64x2Eq : SIMD.f32x4Eq;
    b.localSet(result);
    b.v128const(double ? DEFAULT_NAN_64 : DEFAULT_NAN_32);
    b.localGet(result);
    b.localGet(result).localGet(result).simd(double ? SIMD.f64x2Ne : SIMD.f32x4Ne);
    b.localGet(vecTemp(e)).localGet(vecTemp(e)).simd(eq).simd(SIMD.and);
    if (inputs === 2)
    {
        b.localGet(vecTemp2(e)).localGet(vecTemp2(e)).simd(eq).simd(SIMD.and);
    }
    b.simd(SIMD.bitselect);
}

/**
 * A bitwise operation on xmm or mm operands.
 *
 * @param {E} e @param {Operand} dst @param {Operand} src @param {boolean} mm @param {number} opcode
 */
function bitwise(e, dst, src, mm, opcode){
    const { b } = e;
    if (mm)
    {
        writeM(e, dst, ()=>{
            readM(e, dst);
            readM(e, src);
            b.op(opcode === SIMD.and ? 0x83 : opcode === SIMD.or ? 0x84 : 0x85);
        });
        return;
    }
    readV(e, dst, 16);
    readV(e, src, 16);
    b.simd(opcode);
    writeV(e, dst, null);
}

/** pandn on mm: ~dst & src. @param {E} e @param {Operand} dst @param {Operand} src */
function andnotMm(e, dst, src){
    const { b } = e;
    writeM(e, dst, ()=>{
        readM(e, dst);
        b.i64const(-1n).op(0x85);
        readM(e, src);
        b.op(0x83);
    });
    return true;
}

/**
 * A packed integer operation: both operands as v128 (an mm operand in the
 * low lane), the result back into dst.
 *
 * @param {E} e @param {Operand} dst @param {Operand} src @param {boolean} mm
 * @param {() => void} operation
 */
function packedBinary(e, dst, src, mm, operation){
    const { b } = e;
    if (mm)
    {
        readM(e, dst);
        b.simd(SIMD.i64x2Splat);
        readM(e, src);
        b.simd(SIMD.i64x2Splat);
        operation();
        b.op(0xfd, [SIMD.i64x2ExtractLane, 0]);
        writeM(e, dst, null);
        return;
    }
    readV(e, dst, 16);
    readV(e, src, 16);
    operation();
    writeV(e, dst, null);
}

/**
 * The unpack shuffles: interleave the low (or high) halves of the two
 * operands at the element width. For MMX the halves are the low 32 bits.
 *
 * @param {string} op @param {boolean} mm
 */
function unpackPattern(op, mm){
    const width = op.endsWith('bw') ? 1 : op.endsWith('wd') ? 2 : op.endsWith('qdq') ? 8 : 4;
    const high = op.startsWith('punpckh');
    const elements = (mm ? 8 : 16) / width;
    const half = elements / 2;
    const bytes = [];
    for (let i = 0; i < half; i++)
    {
        const a = (high ? half + i : i) * width;
        const b = 16 + a;
        for (let k = 0; k < width; k++)
        {
            bytes.push(a + k);
        }
        for (let k = 0; k < width; k++)
        {
            bytes.push(b + k);
        }
    }
    while (bytes.length < 16)
    {
        bytes.push(0);
    }
    return bytes;
}

/**
 * psll/psrl/psra by an immediate or by the count in the source register: a
 * count at or beyond the element width shifts everything out (or, for an
 * arithmetic shift, fills with the sign).
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} mm
 */
function packedShift(e, instruction, mm){
    const { b } = e;
    const { op, operands } = instruction;
    const [dst, count] = operands;
    const width = op.endsWith('w') ? 16 : op.endsWith('d') ? 32 : 64;
    const arithmetic = op.startsWith('psra');
    const left = op.startsWith('psll');
    const opcode = width === 16
        ? (left ? SIMD.i16x8Shl : arithmetic ? SIMD.i16x8ShrS : SIMD.i16x8ShrU)
        : width === 32 ? (left ? SIMD.i32x4Shl : arithmetic ? SIMD.i32x4ShrS : SIMD.i32x4ShrU)
            : (left ? SIMD.i64x2Shl : SIMD.i64x2ShrU);
    // The count, clamped: anything past the width behaves as the width itself
    // would if the shift did not wrap -- everything out, or all sign bits.
    const limit = arithmetic ? width - 1 : width;
    if (count.kind === 'imm')
    {
        b.i32const(Math.min(/** @type {number} */ (count.value), limit));
    }
    else
    {
        // The count is the source's low qword; anything past the limit is the limit.
        if (count.kind === 'xmm')
        {
            readV(e, count, 16);
            b.op(0xfd, [SIMD.i64x2ExtractLane, 0]);
        }
        else
        {
            readM(e, count);
        }
        b.localSet(Local.t64);
        b.localGet(Local.t64);
        b.i64const(BigInt(limit));
        b.localGet(Local.t64).i64const(BigInt(limit)).op(0x54); // i64.lt_u
        b.op(0x1b);
        b.op(0xa7); // i64.wrap
    }
    b.localSet(Local.count);
    if (mm)
    {
        readM(e, dst);
        b.simd(SIMD.i64x2Splat);
    }
    else
    {
        readV(e, dst, 16);
    }
    b.localGet(Local.count);
    b.simd(opcode);
    if (!arithmetic)
    {
        // A wasm shift takes its count modulo the width, so a count equal to
        // the width would shift by nothing: mask the result to zero then.
        b.i32const(0);
        b.localGet(Local.count).i32const(width).op(I32.ltU);
        b.op(I32.sub); // 0 - (count < width): all ones to keep, zero to clear
        b.simd(SIMD.i32x4Splat);
        b.simd(SIMD.and);
    }
    if (mm)
    {
        b.op(0xfd, [SIMD.i64x2ExtractLane, 0]);
        writeM(e, dst, null);
    }
    else
    {
        writeV(e, dst, null);
    }
    return true;
}

/**
 * cmpps's eight predicates on the two v128 on the stack.
 *
 * @param {E} e @param {number} predicate @param {boolean} double
 */
function compare(e, predicate, double){
    const { b } = e;
    const eq = double ? SIMD.f64x2Eq : SIMD.f32x4Eq;
    const lt = double ? SIMD.f64x2Lt : SIMD.f32x4Lt;
    const le = double ? SIMD.f64x2Le : SIMD.f32x4Le;
    const ne = double ? SIMD.f64x2Ne : SIMD.f32x4Ne;
    switch (predicate)
    {
        case 0: b.simd(eq); return;
        case 1: b.simd(lt); return;
        case 2: b.simd(le); return;
        case 4: b.simd(ne); return;
        case 5: b.simd(lt); b.simd(SIMD.not); return;
        case 6: b.simd(le); b.simd(SIMD.not); return;
        default:
        {
            // unord (3): either is a NaN; ord (7): neither.
            b.localSet(vecTemp(e));
            b.localSet(vecTemp2(e));
            b.localGet(vecTemp2(e)).localGet(vecTemp2(e));
            b.simd(ne);
            b.localGet(vecTemp(e)).localGet(vecTemp(e));
            b.simd(ne);
            b.simd(SIMD.or);
            if (predicate === 7)
            {
                b.simd(SIMD.not);
            }
        }
    }
}

/**
 * comiss/ucomiss: ZF, PF and CF from the low lanes' compare, OF SF AF clear.
 *
 * @param {E} e @param {Operand} dst @param {Operand} src @param {boolean} double
 * @param {boolean} flagsLive
 */
function comparison(e, dst, src, double, flagsLive){
    const { b } = e;
    prepareAddress(e, src);
    readV(e, dst, 16);
    b.op(0xfd, [double ? SIMD.f64x2ExtractLane : SIMD.f32x4ExtractLane, 0]);
    b.localSet(double ? Local.d0 : Local.f0);
    readV(e, src, double ? 8 : 4);
    b.op(0xfd, [double ? SIMD.f64x2ExtractLane : SIMD.f32x4ExtractLane, 0]);
    b.localSet(double ? Local.d1 : Local.f1);
    if (!flagsLive)
    {
        return;
    }
    const a = double ? Local.d0 : Local.f0;
    const c = double ? Local.d1 : Local.f1;
    const [feq, flt, fne] = double ? [0x61, 0x63, 0x62] : [F32.eq, F32.lt, F32.ne];
    e.eagerWrite(CF | PF | AF | ZF | SF | OF);
    // unordered: ZF = PF = CF = 1
    b.localGet(a).localGet(a).op(fne);
    b.localGet(c).localGet(c).op(fne);
    b.op(I32.or);
    b.localSet(Local.t1);
    b.localGet(Local.t1);
    e.orFlag(PF);
    b.localGet(Local.t1).localGet(a).localGet(c).op(feq).op(I32.or);
    e.orFlag(ZF);
    b.localGet(Local.t1).localGet(a).localGet(c).op(flt).op(I32.or);
    e.orFlag(CF);
}

/**
 * The scalar in f0 (or d0) to an i32 with the processor's rule: NaN and
 * out of range give the indefinite integer. Pushes the i32.
 *
 * @param {E} e @param {boolean} double
 */
function scalarToInt(e, double){
    const { b } = e;
    const local = double ? Local.d0 : Local.f0;
    // trunc_sat, then the indefinite where the value is a NaN or >= 2^31 or <= -2^31 - 1.
    b.i32const(-0x80000000);
    b.localGet(local);
    b.op(0xfc, [double ? 0x02 : 0x00]); // i32.trunc_sat_f64_s / f32_s
    b.localGet(local).localGet(local).op(double ? 0x62 : F32.ne);
    b.localGet(local);
    if (double)
    {
        b.f64const(2147483648).op(0x66); // f64.ge
    }
    else
    {
        b.f32const(2147483648).op(F32.ge);
    }
    b.op(I32.or);
    b.localGet(local);
    if (double)
    {
        b.f64const(-2147483649).op(0x65); // f64.le
    }
    else
    {
        b.f32const(-2147483904).op(F32.le); // the f32 below -2^31
    }
    b.op(I32.or);
    b.op(0x1b); // select(indefinite, sat, bad)
}

/**
 * The four f32 lanes on the stack to i32 lanes with the processor's rule.
 *
 * @param {E} e
 */
function packedToInt(e){
    const { b } = e;
    b.localSet(vecTemp(e));
    // bad lanes: NaN, or >= 2^31, or < -2^31 (as f32, -2^31 itself is exact and fine)
    b.localGet(vecTemp(e)).localGet(vecTemp(e));
    b.simd(SIMD.f32x4Ne);
    b.localGet(vecTemp(e));
    b.f32const(2147483648);
    b.simd(SIMD.f32x4Splat);
    b.simd(SIMD.f32x4Ge);
    b.simd(SIMD.or);
    b.localGet(vecTemp(e));
    b.f32const(-2147483904);
    b.simd(SIMD.f32x4Splat);
    b.simd(SIMD.f32x4Le);
    b.simd(SIMD.or);
    b.localSet(vecTemp2(e));
    b.i32const(-0x80000000);
    b.simd(SIMD.i32x4Splat);
    b.localGet(vecTemp(e));
    b.simd(SIMD.i32x4TruncSatF32x4S);
    b.localGet(vecTemp2(e));
    b.simd(SIMD.bitselect);
}

export { EMPTY, ValType, F32, F64 };

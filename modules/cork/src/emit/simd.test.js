/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { features } from '../wasm/features.js';
import { CF, PF, ZF } from '../decode/table.js';

const CODE = 0x1000;
const DATA = 0x2000;
const skip = !features().simd && 'no simd';

/**
 * Runs a program with xmm0 and xmm1 loaded from DATA and DATA+16, and
 * answers the machine with the state written back.
 *
 * @param {number[]} bytes
 * @param {{ xmm0?: number[], xmm1?: number[], data?: number[],
 *   regs?: Record<string, number> }} [start]
 */
function run(bytes, { xmm0 = [], xmm1 = [], data = [], regs = {} } = {}){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    xmm0.forEach((lane, i)=>view.setFloat32(m.layout.xmm + i * 4, lane, true));
    xmm1.forEach((lane, i)=>view.setFloat32(m.layout.xmm + 16 + i * 4, lane, true));
    m.write(DATA, data);
    m.write(CODE, [...bytes, 0xf4]);
    m.setReg('esp', 0x80000);
    for (const [name, value] of Object.entries(regs))
    {
        m.setReg(name, value);
    }
    m.setEflags(2);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3,
        `halted (exit ${JSON.stringify(exit)}, left out ${[...exit.unsupported]})`);
    return m;
}

/** The four f32 lanes of an xmm register. @param {ReturnType<typeof createTestMachine>} m @param {number} index */
function lanes(m, index){
    const view = new DataView(m.memory.buffer);
    return [0, 1, 2, 3].map(i=>view.getFloat32(m.layout.xmm + index * 16 + i * 4, true));
}

/** The four u32 lanes. @param {ReturnType<typeof createTestMachine>} m @param {number} index */
function words(m, index){
    const view = new DataView(m.memory.buffer);
    return [0, 1, 2, 3].map(i=>view.getUint32(m.layout.xmm + index * 16 + i * 4, true));
}

/** An mm register as two u32 words. @param {ReturnType<typeof createTestMachine>} m @param {number} index */
function mm(m, index){
    const view = new DataView(m.memory.buffer);
    const at = m.layout.x87 + index * 16;
    return [view.getUint32(at, true), view.getUint32(at + 4, true)];
}

test('packed float arithmetic, lane by lane', { skip }, ()=>{
    // addps
    const m = run([0x0f, 0x58, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [0.5, 0.25, 0.125, 0.0625] });
    assert.deepEqual(lanes(m, 0), [1.5, 2.25, 3.125, 4.0625]);
    const mul = run([0x0f, 0x59, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [2, 2, 2, 2] });
    assert.deepEqual(lanes(mul, 0), [2, 4, 6, 8]);
    const div = run([0x0f, 0x5e, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [2, 4, 0, -0] });
    assert.deepEqual(lanes(div, 0), [0.5, 0.5, Infinity, -Infinity]);
    const sqrt = run([0x0f, 0x51, 0xc1], { xmm1: [4, 9, 2, -1] });
    const roots = lanes(sqrt, 0);
    assert.deepEqual(roots.slice(0, 2), [2, 3]);
    assert.equal(roots[2], Math.fround(Math.SQRT2));
    assert.ok(Number.isNaN(roots[3]));
    assert.equal(words(sqrt, 0)[3], 0xffc00000, 'the default NaN, sign set');
});

test('an invalid operation leaves the default NaN; a NaN input keeps its own', { skip }, ()=>{
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    // xmm0 = [0, inf, inf, +NaN 0x7fc00001], xmm1 = [0, inf, 0, 1]
    [0, Infinity, Infinity].forEach((v, i)=>view.setFloat32(m.layout.xmm + i * 4, v, true));
    view.setUint32(m.layout.xmm + 12, 0x7fc00001, true);
    [0, Infinity, 0, 1].forEach((v, i)=>view.setFloat32(m.layout.xmm + 16 + i * 4, v, true));
    m.write(CODE, [
        0x0f, 0x28, 0xd0,        // movaps xmm2, xmm0
        0x0f, 0x5e, 0xd1,        // divps xmm2, xmm1     0/0, inf/inf, inf/0, NaN/1
        0x0f, 0x28, 0xd8,        // movaps xmm3, xmm0
        0x0f, 0x5c, 0xd9,        // subps xmm3, xmm1     0-0, inf-inf, inf-0, NaN-1
        0x0f, 0x28, 0xe0,        // movaps xmm4, xmm0
        0x0f, 0x59, 0xe1,        // mulps xmm4, xmm1     0*0, inf*inf, inf*0, NaN*1
        0xf3, 0x0f, 0x5e, 0xe9,  // divss xmm5, xmm1     0/0 in the low lane only
        0xf4,
    ]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3);
    assert.deepEqual(words(m, 2), [0xffc00000, 0xffc00000, 0x7f800000, 0x7fc00001]);
    assert.deepEqual(words(m, 3), [0, 0xffc00000, 0x7f800000, 0x7fc00001]);
    assert.deepEqual(words(m, 4), [0, 0x7f800000, 0xffc00000, 0x7fc00001]);
    assert.deepEqual(words(m, 5), [0xffc00000, 0, 0, 0]);
});

test('scalar forms touch the low lane and keep the rest', { skip }, ()=>{
    // addss
    const m = run([0xf3, 0x0f, 0x58, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [10, 20, 30, 40] });
    assert.deepEqual(lanes(m, 0), [11, 2, 3, 4]);
    const sqrt = run([0xf3, 0x0f, 0x51, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [16, 0, 0, 0] });
    assert.deepEqual(lanes(sqrt, 0), [4, 2, 3, 4]);
});

test('minps and maxps return the second operand for a NaN or two zeros', { skip }, ()=>{
    const m = run([0x0f, 0x5d, 0xc1], { xmm0: [1, NaN, 0, 5], xmm1: [2, 3, -0, NaN] }); // minps
    const got = lanes(m, 0);
    assert.equal(got[0], 1);
    assert.equal(got[1], 3, 'NaN in the first: the second');
    assert.ok(Object.is(got[2], -0), 'both zero: the second (-0)');
    assert.ok(Number.isNaN(got[3]), 'NaN in the second: the second');
    const max = run([0x0f, 0x5f, 0xc1], { xmm0: [1, NaN, 0, 5], xmm1: [2, 3, -0, 4] });
    assert.deepEqual(lanes(max, 0), [2, 3, -0, 5]);
});

test('cmpps predicates produce all-ones or all-zero lanes', { skip }, ()=>{
    /** @param {number} predicate */
    const masks = predicate=>words(run([0x0f, 0xc2, 0xc1, predicate],
        { xmm0: [1, 2, NaN, 4], xmm1: [1, 3, 1, 3] }), 0);
    assert.deepEqual(masks(0), [0xffffffff, 0, 0, 0], 'eq');
    assert.deepEqual(masks(1), [0, 0xffffffff, 0, 0], 'lt');
    assert.deepEqual(masks(2), [0xffffffff, 0xffffffff, 0, 0], 'le');
    assert.deepEqual(masks(3), [0, 0, 0xffffffff, 0], 'unord');
    assert.deepEqual(masks(4), [0, 0xffffffff, 0xffffffff, 0xffffffff], 'neq (unordered counts)');
    assert.deepEqual(masks(5), [0xffffffff, 0, 0xffffffff, 0xffffffff], 'nlt (unordered counts)');
    assert.deepEqual(masks(6), [0, 0, 0xffffffff, 0xffffffff], 'nle');
    assert.deepEqual(masks(7), [0xffffffff, 0xffffffff, 0, 0xffffffff], 'ord');
});

test('shufps, unpack and the moves between lanes', { skip }, ()=>{
    const shuf = run([0x0f, 0xc6, 0xc1, 0x1b], { xmm0: [1, 2, 3, 4], xmm1: [5, 6, 7, 8] }); // 0x1b
    assert.deepEqual(lanes(shuf, 0), [4, 3, 6, 5]);
    const lo = run([0x0f, 0x14, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [5, 6, 7, 8] }); // unpcklps
    assert.deepEqual(lanes(lo, 0), [1, 5, 2, 6]);
    const hi = run([0x0f, 0x15, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [5, 6, 7, 8] }); // unpckhps
    assert.deepEqual(lanes(hi, 0), [3, 7, 4, 8]);
    const movss = run([0xf3, 0x0f, 0x10, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [5, 6, 7, 8] });
    assert.deepEqual(lanes(movss, 0), [5, 2, 3, 4]);
    const movlhps = run([0x0f, 0x16, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [5, 6, 7, 8] });
    assert.deepEqual(lanes(movlhps, 0), [1, 2, 5, 6]);
    const movhlps = run([0x0f, 0x12, 0xc1], { xmm0: [1, 2, 3, 4], xmm1: [5, 6, 7, 8] });
    assert.deepEqual(lanes(movhlps, 0), [7, 8, 3, 4]);
    const pair = { xmm0: [1, 2, 3, 4], xmm1: [5, 6, 7, 8] };
    const lqdq = run([0x66, 0x0f, 0x6c, 0xc1], pair); // punpcklqdq
    assert.deepEqual(lanes(lqdq, 0), [1, 2, 5, 6]);
    const hqdq = run([0x66, 0x0f, 0x6d, 0xc1], pair); // punpckhqdq
    assert.deepEqual(lanes(hqdq, 0), [3, 4, 7, 8]);
    const ldq = run([0x66, 0x0f, 0x62, 0xc1], pair); // punpckldq
    assert.deepEqual(lanes(ldq, 0), [1, 5, 2, 6]);
    const pshufd = run([0x66, 0x0f, 0x70, 0xc1, 0x1b], { xmm1: [5, 6, 7, 8] });
    assert.deepEqual(lanes(pshufd, 0), [8, 7, 6, 5]);
});

test('loads and stores: whole, low qword, low dword, high qword, and movd', { skip }, ()=>{
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const movups = run([0x0f, 0x10, 0x05, 0x00, 0x20, 0, 0, 0x0f, 0x11, 0x05, 0x10, 0x20, 0, 0],
        { data });
    assert.deepEqual([...movups.read(DATA + 16, 16)], data);
    // movq xmm0, m64
    const movq = run([0xf3, 0x0f, 0x7e, 0x05, 0x00, 0x20, 0, 0], { data, xmm0: [9, 9, 9, 9] });
    assert.deepEqual([...new Uint8Array(movq.memory.buffer, movq.layout.xmm, 16)],
        [1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
    const movss = run([0xf3, 0x0f, 0x10, 0x05, 0x00, 0x20, 0, 0], { data, xmm0: [9, 9, 9, 9] });
    assert.deepEqual([...new Uint8Array(movss.memory.buffer, movss.layout.xmm, 16)],
        [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const movhps = run([0x0f, 0x16, 0x05, 0x00, 0x20, 0, 0], { data, xmm0: [1, 2, 3, 4] });
    assert.deepEqual(lanes(movhps, 0).slice(0, 2), [1, 2]);
    assert.deepEqual([...new Uint8Array(movhps.memory.buffer, movhps.layout.xmm + 8, 8)],
        data.slice(0, 8));
    const movd = run([0x66, 0x0f, 0x6e, 0xc0, 0x66, 0x0f, 0x7e, 0xc3],
        { regs: { eax: 0x12345678 } });
    assert.deepEqual(words(movd, 0), [0x12345678, 0, 0, 0]);
    assert.equal(movd.reg('ebx'), 0x12345678);
    const movdMem = run([0x66, 0x0f, 0x6e, 0x0d, 0x04, 0x20, 0, 0,   // movd xmm1, [DATA+4]
        0x0f, 0x6e, 0x15, 0x08, 0x20, 0, 0,                        // movd mm2, [DATA+8]
        0x66, 0x0f, 0xf4, 0xc9], { data });                        // pmuludq xmm1, xmm1
    const square = 0x08070605n * 0x08070605n;
    assert.deepEqual(words(movdMem, 1),
        [Number(square & 0xffffffffn), Number(square >> 32n), 0, 0]);
    assert.deepEqual(mm(movdMem, 2), [0x0c0b0a09, 0]);
});

test('the conversions, with the indefinite integer where the processor gives it', { skip }, ()=>{
    const m = run([0xf3, 0x0f, 0x5b, 0xc1], { xmm1: [1.7, -1.7, 3e9, NaN] }); // cvttps2dq
    assert.deepEqual(words(m, 0), [1, 0xffffffff, 0x80000000, 0x80000000]);
    const round = run([0x66, 0x0f, 0x5b, 0xc1], { xmm1: [2.5, 3.5, -2.5, 0.49] }); // cvtps2dq
    assert.deepEqual(words(round, 0), [2, 4, 0xfffffffe, 0]);
    const toFloat = run([0x0f, 0x5b, 0xc1], { xmm1: [] }); // cvtdq2ps of [0,0,0,0]
    assert.deepEqual(lanes(toFloat, 0), [0, 0, 0, 0]);
    const scalar = run([0xf3, 0x0f, 0x2c, 0xc1, 0xf3, 0x0f, 0x2d, 0xd1], { xmm1: [-7.9, 0, 0, 0] });
    assert.equal(scalar.reg('eax') | 0, -7, 'cvttss2si truncates');
    assert.equal(scalar.reg('edx') | 0, -8, 'cvtss2si rounds to nearest');
    const big = run([0xf3, 0x0f, 0x2c, 0xc1], { xmm1: [1e10, 0, 0, 0] });
    assert.equal(big.reg('eax'), 0x80000000);
    // cvtsi2ss
    const fromInt = run([0xf3, 0x0f, 0x2a, 0xc0], { regs: { eax: 16777217 }, xmm0: [0, 5, 6, 7] });
    assert.deepEqual(lanes(fromInt, 0), [16777216, 5, 6, 7], '2^24 + 1 rounds to 2^24');
});

test('comiss sets ZF PF CF as the compare says', { skip }, ()=>{
    /** @param {number} a @param {number} b */
    const flags = (a, b)=>run([0x0f, 0x2f, 0xc1, 0x9c, 0x58], { xmm0: [a], xmm1: [b] }).reg('eax');
    assert.equal(flags(1, 2) & (ZF | PF | CF), CF);
    assert.equal(flags(2, 1) & (ZF | PF | CF), 0);
    assert.equal(flags(2, 2) & (ZF | PF | CF), ZF);
    assert.equal(flags(NaN, 2) & (ZF | PF | CF), ZF | PF | CF);
});

test('packed integer arithmetic: saturation, shifts, packs, the mask extract', { skip }, ()=>{
    /** @param {number[]} bytes @param {number[]} a @param {number[]} b */
    const ints = (bytes, a, b)=>{
        const m = createTestMachine();
        new Uint8Array(m.memory.buffer, m.layout.xmm, 16).set(a);
        new Uint8Array(m.memory.buffer, m.layout.xmm + 16, 16).set(b);
        m.write(CODE, [...bytes, 0xf4]);
        m.setReg('esp', 0x80000);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, `left out ${[...exit.unsupported]}`);
        return m;
    };
    const paddb = ints([0x66, 0x0f, 0xfc, 0xc1], [250, 1, 2, 3], [10, 1, 1, 1]);
    assert.deepEqual([...new Uint8Array(paddb.memory.buffer, paddb.layout.xmm, 4)], [4, 2, 3, 4]);
    const paddusb = ints([0x66, 0x0f, 0xdc, 0xc1], [250, 1], [10, 1]);
    assert.deepEqual([...new Uint8Array(paddusb.memory.buffer, paddusb.layout.xmm, 2)], [255, 2]);
    const packuswb = ints([0x66, 0x0f, 0x67, 0xc1], [0x34, 0x12, 0xff, 0xff, 0x80, 0x00],
        [0x01, 0x00]);
    assert.deepEqual([...new Uint8Array(packuswb.memory.buffer, packuswb.layout.xmm, 3)],
        [0xff, 0x00, 0x80],
        '0x1234 saturates to 0xff, -1 to 0');
    const psrad = ints([0x66, 0x0f, 0x72, 0xe0, 0x20], [0, 0, 0, 0x80], []); // psrad xmm0, 32
    assert.deepEqual(words(psrad, 0)[0], 0xffffffff, 'a count of the width fills with the sign');
    const psrld = ints([0x66, 0x0f, 0x72, 0xd0, 0x20], [0xff, 0xff, 0xff, 0xff], []);
    assert.equal(words(psrld, 0)[0], 0, 'a logical shift by the width clears');
    const pmovmskb = ints([0x66, 0x0f, 0xd7, 0xc0], [0x80, 0x00, 0x80, 0x00, 0x80, 0, 0x80, 0], []);
    assert.equal(pmovmskb.reg('eax'), 0x55);
    const pmulhw = ints([0x66, 0x0f, 0xe5, 0xc1], [0x00, 0x40, 0x00, 0x80],
        [0x00, 0x40, 0x02, 0x00]);
    // 0x4000 * 0x4000 = 0x10000000 -> high 0x1000; -32768 * 2 = -65536 -> high 0xffff
    assert.deepEqual([...new Uint16Array(pmulhw.memory.buffer, pmulhw.layout.xmm, 2)],
        [0x1000, 0xffff]);
    const pmaddwd = ints([0x66, 0x0f, 0xf5, 0xc1], [1, 0, 2, 0], [3, 0, 4, 0]); // 1*3 + 2*4
    assert.equal(words(pmaddwd, 0)[0], 11);
    const psadbw = ints([0x66, 0x0f, 0xf6, 0xc1], [10, 0, 0, 0, 0, 0, 0, 0, 5],
        [0, 3, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(words(psadbw, 0), [13, 0, 5, 0]);
});

test('the masked stores write only the bytes whose mask byte has its sign set', { skip }, ()=>{
    const m = createTestMachine();
    const data = Array.from({ length: 16 }, (_, i)=>0x10 + i);
    m.write(DATA, data);
    m.write(DATA + 32, Array.from({ length: 16 }, (_, i)=>0xa0 + i));    // the line at edi
    m.write(DATA + 48, [0x80, 0x00, 0xff, 0x7f, 0x80, 0x00, 0x00, 0x80,    // the mask
        0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80]);
    m.write(CODE, [
        0x0f, 0x10, 0x05, 0x00, 0x20, 0, 0,          // movups xmm0, [DATA]
        0x0f, 0x10, 0x0d, 0x30, 0x20, 0, 0,          // movups xmm1, [DATA+48]
        0xbf, 0x20, 0x20, 0, 0,                      // mov edi, DATA+32
        0x66, 0x0f, 0xf7, 0xc1,                      // maskmovdqu xmm0, xmm1
        0x0f, 0x6f, 0x15, 0x00, 0x20, 0, 0,          // movq mm2, [DATA]
        0x0f, 0x6f, 0x1d, 0x30, 0x20, 0, 0,          // movq mm3, [DATA+48]
        0xbf, 0x40, 0x20, 0, 0,                      // mov edi, DATA+64
        0x0f, 0xf7, 0xd3,                            // maskmovq mm2, mm3
        0xf4,
    ]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, `left out ${[...exit.unsupported]}`);
    assert.deepEqual([...m.read(DATA + 32, 16)], [
        0x10, 0xa1, 0x12, 0xa3, 0x14, 0xa5, 0xa6, 0x17,
        0xa8, 0x19, 0xaa, 0xab, 0xac, 0xad, 0xae, 0x1f,
    ]);
    assert.deepEqual([...m.read(DATA + 64, 16)], [
        0x10, 0, 0x12, 0, 0x14, 0, 0, 0x17, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
});

test('MMX runs in the low lane and leaves the x87 stack held with its top at zero', { skip }, ()=>{
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Top, 5);
    view.setUint8(m.layout.x87Empty, 0xff);
    m.write(DATA, [1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 30, 40, 50, 60, 70, 80]);
    m.write(CODE, [
        0x0f, 0x6f, 0x05, 0x00, 0x20, 0, 0,   // movq mm0, [DATA]
        0x0f, 0x6f, 0x0d, 0x08, 0x20, 0, 0,   // movq mm1, [DATA+8]
        0x0f, 0xfc, 0xc1,                     // paddb mm0, mm1
        0x0f, 0x7f, 0x05, 0x10, 0x20, 0, 0,   // movq [DATA+16], mm0
        0x0f, 0x70, 0xd0, 0x1b,               // pshufw mm2, mm0, 0x1b
        0xf4,
    ]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, `left out ${[...exit.unsupported]}`);
    assert.deepEqual([...m.read(DATA + 16, 8)], [11, 22, 33, 44, 55, 66, 77, 88]);
    assert.deepEqual(mm(m, 0), [0x2c21160b, 0x584d4237]);
    assert.deepEqual(mm(m, 2), [0x4237584d, 0x160b2c21], 'words reversed');
    assert.equal(view.getUint8(m.layout.x87Top), 0);
    assert.equal(view.getUint8(m.layout.x87Empty), 0, 'every register held');

    const emms = createTestMachine();
    emms.write(CODE, [0x0f, 0x77, 0xf4]);
    emms.setReg('esp', 0x80000);
    emms.runProgram(CODE);
    assert.equal(new DataView(emms.memory.buffer).getUint8(emms.layout.x87Empty), 0xff);
    // MMX used and emms in one run: the stack is empty at the end, the
    // epilogue's hold for MMX use undone by the emms that followed it (a
    // program checking its stack is empty at the end of a frame found it
    // held after every MMX copy).
    const after = createTestMachine();
    // movq mm0, [m]; emms; hlt
    after.write(CODE, [0x0f, 0x6f, 0x05, DATA & 255, DATA >> 8 & 255, 0, 0, 0x0f, 0x77, 0xf4]);
    after.setReg('esp', 0x80000);
    assert.equal(after.runProgram(CODE).kind, 3);
    assert.equal(new DataView(after.memory.buffer).getUint8(after.layout.x87Empty), 0xff,
        'empty after emms');
});

test('an MMX form that only reads an mm register still holds the x87 stack', { skip }, ()=>{
    // A store into memory, a read into an xmm, a read into a general
    // register: none of them writes an mm register, and each is an MMX
    // instruction all the same, so the processor puts the x87 stack in the
    // MMX state for it. The sequence corpus found the three of them leaving
    // the stack as the machine had it, so the next x87 instruction pushed
    // onto a register the stack said was free.
    /**
     * The x87 top and empty mask a program leaves, from a stack with its top
     * at five and every register empty.
     *
     * @param {number[]} bytes
     */
    const stack = bytes=>{
        const m = createTestMachine();
        const view = new DataView(m.memory.buffer);
        view.setUint8(m.layout.x87Top, 5);
        view.setUint8(m.layout.x87Empty, 0xff);
        m.write(DATA, [1, 2, 3, 4, 5, 6, 7, 8]);
        m.write(CODE, [...bytes, 0xf4]);
        m.setReg('esp', 0x80000);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3,
            `halted (exit ${JSON.stringify(exit)}, left out ${[...exit.unsupported]})`);
        return [view.getUint8(m.layout.x87Top), view.getUint8(m.layout.x87Empty)];
    };
    // movq [DATA], mm1
    assert.deepEqual(stack([0x0f, 0x7f, 0x0d, DATA & 255, DATA >> 8 & 255, 0, 0]), [0, 0]);
    // movq2dq xmm1, mm1
    assert.deepEqual(stack([0xf3, 0x0f, 0xd6, 0xc9]), [0, 0]);
    // cvtpi2ps xmm0, mm0
    assert.deepEqual(stack([0x0f, 0x2a, 0xc0]), [0, 0]);
    // pextrw eax, mm1, 1
    assert.deepEqual(stack([0x0f, 0xc5, 0xc1, 0x01]), [0, 0]);
});

test('emms after an MMX instruction leaves the top at the zero it set', { skip }, ()=>{
    // From a stack whose top is not zero: the MMX instruction put the top at
    // zero and held every register, and leaving the MMX state empties them
    // again without putting the top back. The sequence corpus's pair found
    // the run's mark clearing both, so the region's exit wrote neither and
    // the machine kept the top it had come in with.
    /** @param {number[]} bytes */
    const stack = bytes=>{
        const m = createTestMachine();
        const view = new DataView(m.memory.buffer);
        view.setUint8(m.layout.x87Top, 5);
        view.setUint8(m.layout.x87Empty, 0xff);
        m.write(CODE, [...bytes, 0xf4]);
        m.setReg('esp', 0x80000);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, `halted (exit ${JSON.stringify(exit)},`
            + ` left out ${[...exit.unsupported]})`);
        return [view.getUint8(m.layout.x87Top), view.getUint8(m.layout.x87Empty)];
    };
    const PXOR = [0x0f, 0xef, 0xc9];        // pxor mm1, mm1
    const EMMS = [0x0f, 0x77];
    assert.deepEqual(stack([...PXOR, ...EMMS]), [0, 0xff], 'the hold goes, the top stays');
    assert.deepEqual(stack([...EMMS, ...PXOR]), [0, 0], 'an MMX instruction after it holds');
    assert.deepEqual(stack([...PXOR, ...EMMS, ...PXOR]), [0, 0]);
});

test('an emms in a region holding the x87 registers empties its own mask', { skip }, ()=>{
    // A region with x87 instructions in it keeps the eight registers, the
    // top and the empty mask in locals and writes them back at its exit, so
    // an emms that wrote the state block's mask was overwritten by that
    // exit and the stack stayed held. The sequence corpus's pair was
    // fld qword [m]; emms, which left ST(7) holding what the load put there.
    /** @param {number[]} bytes */
    const stack = bytes=>{
        const m = createTestMachine();
        const view = new DataView(m.memory.buffer);
        m.write(DATA, [0, 0, 0, 0, 0, 0, 0x0a, 0x40]);     // 3.25
        m.write(CODE, [...bytes, 0xf4]);
        m.setReg('esp', 0x80000);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, `halted (exit ${JSON.stringify(exit)},`
            + ` left out ${[...exit.unsupported]})`);
        return {
            top: view.getUint8(m.layout.x87Top),
            empty: view.getUint8(m.layout.x87Empty),
            status: view.getUint16(m.layout.x87Status, true),
        };
    };
    const FLD = [0xdd, 0x05, DATA & 255, DATA >> 8 & 255, 0, 0];  // fld qword [DATA]
    const FLD1 = [0xd9, 0xe8];
    const EMMS = [0x0f, 0x77];
    assert.deepEqual(stack([...FLD, ...EMMS]),
        { top: 7, empty: 0xff, status: 0 }, 'the register the load held is free again');
    // And the mask is the one the instructions after the emms read: the push
    // is onto a free register, so it raises no stack fault.
    assert.deepEqual(stack([...FLD1, ...FLD1, ...EMMS, ...FLD1]),
        { top: 5, empty: 0xdf, status: 0 });
});

test('x87 and MMX translate in one region: an x87 write is the mm mantissa', { skip }, ()=>{
    // A region with both classes is no longer cut at its first x87 instruction:
    // the eight registers are one set with two views kept equal at every write,
    // so an x87 push leaves the mm view the double's bits and an MMX store of
    // that register reads them. Without the representation the region is cut at
    // the fld1, which retires nothing, and runProgram answers -2 (stuck) -- so
    // this proves both the crossover and that it is one region. Cork's own f64
    // layout holds the value as the mantissa's bits, so the crossing is the
    // identity here; the emulator's tagged form, which the sequence corpus
    // judges, decodes the MMX form to the indefinite instead.
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    m.write(DATA, new Array(8).fill(0));
    m.write(CODE, [
        0xd9, 0xe8,                                              // fld1   R7 = 1.0, top 7
        0x0f, 0x7f, 0x3d, DATA & 255, DATA >> 8 & 255, 0, 0,     // movq [DATA], mm7
        0xf4,
    ]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3,
        `halted (exit ${JSON.stringify(exit)}, left out ${[...exit.unsupported]})`);
    assert.equal(exit.regions, 1, 'one region: the crossover is translated, not cut');
    assert.equal(view.getBigUint64(m.layout.ramBase + DATA, true), 0x3ff0000000000000n,
        'the MMX store read the 1.0 the x87 push left in R7');
    assert.equal(view.getUint8(m.layout.x87Top), 0, 'the MMX instruction held the stack, top zero');
    assert.equal(view.getUint8(m.layout.x87Empty), 0, 'and every register');
});

test('x87 and MMX translate in one region: an MMX write is the x87 value', { skip }, ()=>{
    // The other direction: an MMX load writes R0's mantissa and puts the top at
    // zero, and an x87 store of ST0 (R0) reads it back -- in cork's own f64
    // layout, the mantissa's bits as a double. Without the representation the
    // region is cut at the fstp, so it runs as two regions.
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    m.write(DATA, [0, 0, 0, 0, 0, 0, 0x0a, 0x40]);      // 3.25's bits
    m.write(DATA + 8, new Array(8).fill(0));
    m.write(CODE, [
        0x0f, 0x6f, 0x05, DATA & 255, DATA >> 8 & 255, 0, 0,        // movq mm0, [DATA]
        0xdd, 0x1d, (DATA + 8) & 255, (DATA + 8) >> 8 & 255, 0, 0,  // fstp qword [DATA+8]
        0xf4,
    ]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3,
        `halted (exit ${JSON.stringify(exit)}, left out ${[...exit.unsupported]})`);
    assert.equal(exit.regions, 1, 'one region: the crossover is translated, not cut');
    assert.equal(view.getFloat64(m.layout.ramBase + DATA + 8, true), 3.25,
        'the x87 store read R0 as the double its mantissa is');
});

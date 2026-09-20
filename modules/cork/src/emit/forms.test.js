/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The forms the corpus found left out after the main sets: bit strings,
 * cmpxchg8b, arpl, the decimal adjustments, the non-temporal stores, the
 * SSE3 duplicating moves and horizontal arithmetic, the packed-double to
 * MMX conversions, the SSE control word and fnclex.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { CF, AF, ZF, PF, SF } from '../decode/table.js';

const CODE = 0x1000;
const DATA = 0x2000;
/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {number} value */
const f32 = value=>{
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    return [...b];
};
/** @param {number} value */
const f64 = value=>{
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    return [...b];
};

/**
 * @param {number[]} bytes @param {{ regs?: Record<string, number>, data?: number[],
 *     eflags?: number }} [start]
 */
function run(bytes, { regs = {}, data = [], eflags = 2 } = {}){
    const m = createTestMachine();
    m.write(CODE, [...bytes, 0xf4]);
    m.write(DATA, data);
    m.setReg('esp', 0x80000);
    m.setEflags(eflags);
    for (const [name, value] of Object.entries(regs))
    {
        m.setReg(name, value);
    }
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, `halted; left out ${[...exit.unsupported]}`);
    return m;
}

test('movnti stores like mov; movntq stores an MMX register', ()=>{
    const m = run([0xb8, ...u32(0x12345678), 0x0f, 0xc3, 0x05, ...u32(DATA)]); // movnti [DATA], eax
    assert.equal(m.readU32(DATA), 0x12345678);
    // movq mm0, [DATA]; movntq [DATA+8], mm0
    const q = run([0x0f, 0x6f, 0x05, ...u32(DATA), 0x0f, 0xe7, 0x05, ...u32(DATA + 8)],
        { data: [1, 2, 3, 4, 5, 6, 7, 8] });
    assert.deepEqual([...q.read(DATA + 8, 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a bit string: btr and btc with a register offset reach past the dword', ()=>{
    // mov eax, 40; btr [DATA], eax    -> bit 8 of the dword at DATA+4
    const m = run([0xb8, ...u32(40), 0x0f, 0xb3, 0x05, ...u32(DATA)],
        { data: [0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0, 0] });
    assert.equal(m.readU32(DATA + 4), 0x000000ff);
    assert.equal(m.eflags() & CF, CF, 'the bit was set');
    // mov eax, -1; btc [DATA+4], eax  -> bit 31 of the dword at DATA
    const n = run([0xb8, ...u32(0xffffffff), 0x0f, 0xbb, 0x05, ...u32(DATA + 4)],
        { data: [0, 0, 0, 0, 0, 0, 0, 0] });
    assert.equal(n.readU32(DATA), 0x80000000);
    assert.equal(n.eflags() & CF, 0);
    // bts word [DATA], ax with ax = 17 -> bit 1 of the word at DATA+2
    const w = run([0x66, 0xb8, 17, 0, 0x66, 0x0f, 0xab, 0x05, ...u32(DATA)],
        { data: [0, 0, 0, 0] });
    assert.equal(w.readU32(DATA), 0x00020000);
});

test('cmpxchg8b stores ecx:ebx when edx:eax matches, and loads otherwise', ()=>{
    const code = [0x0f, 0xc7, 0x0d, ...u32(DATA)]; // cmpxchg8b [DATA]
    const hit = run(code, {
        regs: { eax: 0x11111111, edx: 0x22222222, ebx: 0x33333333, ecx: 0x44444444 },
        data: [...u32(0x11111111), ...u32(0x22222222)],
    });
    assert.equal(hit.readU32(DATA), 0x33333333);
    assert.equal(hit.readU32(DATA + 4), 0x44444444);
    assert.equal(hit.eflags() & ZF, ZF);
    const miss = run(code, {
        regs: { eax: 0x11111111, edx: 0x22222222, ebx: 0x33333333, ecx: 0x44444444 },
        data: [...u32(0xaaaaaaaa), ...u32(0x22222222)],
    });
    assert.equal(miss.readU32(DATA), 0xaaaaaaaa, 'unchanged');
    assert.equal(miss.reg('eax'), 0xaaaaaaaa);
    assert.equal(miss.reg('edx'), 0x22222222);
    assert.equal(miss.eflags() & ZF, 0);
});

test('arpl raises the RPL and sets ZF, or leaves both', ()=>{
    // mov ax, 0x0010; mov cx, 0x0003; arpl ax, cx
    const raised = run([0x66, 0xb8, 0x10, 0, 0x66, 0xb9, 0x03, 0, 0x63, 0xc8]);
    assert.equal(raised.reg('eax') & 0xffff, 0x0013);
    assert.equal(raised.eflags() & ZF, ZF);
    const kept = run([0x66, 0xb8, 0x13, 0, 0x66, 0xb9, 0x01, 0, 0x63, 0xc8]);
    assert.equal(kept.reg('eax') & 0xffff, 0x0013);
    assert.equal(kept.eflags() & ZF, 0);
});

test('daa, das, aaa, aas, aam and aad', ()=>{
    const daa = run([0xb0, 0x9a, 0x27]);              // mov al, 0x9a; daa -> 0x00, CF AF
    assert.equal(daa.reg('eax') & 0xff, 0x00);
    assert.equal(daa.eflags() & (CF | AF | ZF), CF | AF | ZF);
    const daa2 = run([0xb0, 0x15, 0x27]);             // 0x15 -> 0x15, no flags
    assert.equal(daa2.reg('eax') & 0xff, 0x15);
    assert.equal(daa2.eflags() & (CF | AF | ZF | SF), 0);
    assert.equal(daa2.eflags() & PF, 0, '0x15 has odd parity');
    const das = run([0xb0, 0x03, 0x2f], { eflags: 2 | AF }); // 0x03 with AF -> 0xfd, CF AF
    assert.equal(das.reg('eax') & 0xff, 0xfd);
    assert.equal(das.eflags() & (CF | AF | SF), CF | AF | SF);
    const aaa = run([0x66, 0xb8, 0x0f, 0x00, 0x37]);   // ax = 0x000f; aaa -> 0x0105, AF CF
    assert.equal(aaa.reg('eax') & 0xffff, 0x0105);
    assert.equal(aaa.eflags() & (CF | AF), CF | AF);
    const aas = run([0x66, 0xb8, 0x0a, 0x01, 0x3f]);   // ax = 0x010a; aas -> 0x0004, AF CF
    assert.equal(aas.reg('eax') & 0xffff, 0x0004);
    assert.equal(aas.eflags() & (CF | AF), CF | AF);
    const aam = run([0xb0, 44, 0xd4, 10]);            // al = 44; aam -> ah 4, al 4
    assert.equal(aam.reg('eax') & 0xffff, 0x0404);
    assert.equal(aam.eflags() & (CF | AF | ZF), 0);
    const aad = run([0x66, 0xb8, 0x04, 0x04, 0xd5, 10]); // ax = 0x0404; aad -> al 44, ah 0
    assert.equal(aad.reg('eax') & 0xffff, 44);
    assert.equal(aad.eflags() & PF, 0, '44 = 101100b has odd parity');
    const zero = createTestMachine();
    zero.write(CODE, [0xd4, 0x00, 0xf4]);               // aam 0: #DE
    zero.setReg('esp', 0x80000);
    const exit = zero.runProgram(CODE);
    assert.deepEqual([exit.kind, exit.vector, exit.eip], [4, 0, CODE]);
});

test('movddup, movsldup and movshdup duplicate lanes', ()=>{
    // movddup xmm0, [DATA]; movups [DATA+16], xmm0
    const dd = run([0xf2, 0x0f, 0x12, 0x05, ...u32(DATA), 0x0f, 0x11, 0x05, ...u32(DATA + 16)],
        { data: [...f64(1.5), ...f64(9)] });
    assert.deepEqual([...dd.read(DATA + 16, 16)], [...f64(1.5), ...f64(1.5)]);
    // movups xmm0, [DATA]; movsldup xmm1, xmm0; movups [DATA+16], xmm1
    const sl = run([0x0f, 0x10, 0x05, ...u32(DATA), 0xf3, 0x0f, 0x12, 0xc8,
        0x0f, 0x11, 0x0d, ...u32(DATA + 16)],
    { data: [...f32(1), ...f32(2), ...f32(3), ...f32(4)] });
    assert.deepEqual([...sl.read(DATA + 16, 16)], [...f32(1), ...f32(1), ...f32(3), ...f32(3)]);
    const sh = run([0x0f, 0x10, 0x05, ...u32(DATA), 0xf3, 0x0f, 0x16, 0xc8,
        0x0f, 0x11, 0x0d, ...u32(DATA + 16)],
    { data: [...f32(1), ...f32(2), ...f32(3), ...f32(4)] });
    assert.deepEqual([...sh.read(DATA + 16, 16)], [...f32(2), ...f32(2), ...f32(4), ...f32(4)]);
});

test('haddps, hsubps and haddpd pair the lanes, destination first', ()=>{
    // movups xmm0, [DATA]; movups xmm1, [DATA+16]; <op> xmm0, xmm1; movups [DATA+32], xmm0
    const code = (/** @type {number[]} */ op)=>[
        0x0f, 0x10, 0x05, ...u32(DATA), 0x0f, 0x10, 0x0d, ...u32(DATA + 16),
        ...op, 0x0f, 0x11, 0x05, ...u32(DATA + 32),
    ];
    const data = [...f32(1), ...f32(2), ...f32(3), ...f32(4), ...f32(10), ...f32(20), ...f32(30),
        ...f32(40)];
    const hadd = run(code([0xf2, 0x0f, 0x7c, 0xc1]), { data });
    assert.deepEqual([...hadd.read(DATA + 32, 16)], [...f32(3), ...f32(7), ...f32(30), ...f32(70)]);
    const hsub = run(code([0xf2, 0x0f, 0x7d, 0xc1]), { data });
    assert.deepEqual([...hsub.read(DATA + 32, 16)],
        [...f32(-1), ...f32(-1), ...f32(-10), ...f32(-10)]);
    const pd = run(code([0x66, 0x0f, 0x7c, 0xc1]),
        { data: [...f64(1), ...f64(2), ...f64(10), ...f64(20)] });
    assert.deepEqual([...pd.read(DATA + 32, 16)], [...f64(3), ...f64(30)]);
});

test('cvtpd2pi rounds two doubles into an MMX register; cvttpd2pi truncates', ()=>{
    // cvtpd2pi mm0, [DATA]; movq [DATA+16], mm0
    const r = run([0x66, 0x0f, 0x2d, 0x05, ...u32(DATA), 0x0f, 0x7f, 0x05, ...u32(DATA + 16)],
        { data: [...f64(2.5), ...f64(-3.7)] });
    assert.deepEqual([...r.read(DATA + 16, 8)], [...u32(2), ...u32(-4 >>> 0)]);
    const t = run([0x66, 0x0f, 0x2c, 0x05, ...u32(DATA), 0x0f, 0x7f, 0x05, ...u32(DATA + 16)],
        { data: [...f64(2.5), ...f64(-3.7)] });
    assert.deepEqual([...t.read(DATA + 16, 8)], [...u32(2), ...u32(-3 >>> 0)]);
    const big = run([0x66, 0x0f, 0x2c, 0x05, ...u32(DATA), 0x0f, 0x7f, 0x05, ...u32(DATA + 16)],
        { data: [...f64(1e12), ...f64(NaN)] });
    assert.deepEqual([...big.read(DATA + 16, 8)], [...u32(0x80000000), ...u32(0x80000000)],
        'the indefinite');
});

test('stmxcsr and ldmxcsr move the SSE control word', ()=>{
    const m = run([0x0f, 0xae, 0x1d, ...u32(DATA)]); // stmxcsr [DATA]
    assert.equal(m.readU32(DATA), new DataView(m.memory.buffer).getUint32(m.layout.mxcsr, true));
    const l = run([0x0f, 0xae, 0x15, ...u32(DATA)], { data: u32(0x1f80 | 0x6000) }); // ldmxcsr
    assert.equal(new DataView(l.memory.buffer).getUint32(l.layout.mxcsr, true), 0x7f80);
});

test('fnclex clears the exception bits and keeps the condition bits', ()=>{
    // fldz; fldz; fdivp (zero divide: ZE); fnclex; fnstsw ax
    const m = run([0xd9, 0xee, 0xd9, 0xee, 0xde, 0xf9, 0xdb, 0xe2, 0xdf, 0xe0]);
    assert.equal(m.reg('eax') & 0x80ff, 0, 'no exception bits, no summary');
});

test('the conversions round by the SSE control word; an x87 NaN carries the processor sign',
    ()=>{
        // ldmxcsr with round-down, then cvtps2pi of 12345.678 and 1234.5
        const down = run([0x0f, 0xae, 0x15, ...u32(DATA + 16), 0x0f, 0x2d, 0x05, ...u32(DATA),
            0x0f, 0x7f, 0x05, ...u32(DATA + 32)],
        { data: [...f32(12345.678), ...f32(1234.5), 0, 0, 0, 0, 0, 0, 0, 0,
            ...u32(0x1f80 | 0x2000)] });
        assert.deepEqual([...down.read(DATA + 32, 8)], [...u32(12345), ...u32(1234)]);
        const up = run([0x0f, 0xae, 0x15, ...u32(DATA + 16), 0x0f, 0x2d, 0x05, ...u32(DATA),
            0x0f, 0x7f, 0x05, ...u32(DATA + 32)],
        { data: [...f32(12345.678), ...f32(1234.5), 0, 0, 0, 0, 0, 0, 0, 0,
            ...u32(0x1f80 | 0x4000)] });
        assert.deepEqual([...up.read(DATA + 32, 8)], [...u32(12346), ...u32(1235)]);
        // cvtsd2si with round toward zero
        const trunc = run(
            [0x0f, 0xae, 0x15, ...u32(DATA + 16), 0xf2, 0x0f, 0x2d, 0x05, ...u32(DATA)],
            { data: [...f64(-2.7), 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0x1f80 | 0x6000)] });
        assert.equal(trunc.reg('eax') | 0, -2);
        // fldz; fldz; fdivp: the indefinite, stored as a single, is negative.
        const nan = run([0xd9, 0xee, 0xd9, 0xee, 0xde, 0xf9, 0xd9, 0x1d, ...u32(DATA)]);
        assert.equal(nan.readU32(DATA), 0xffc00000);
        // fldz; fchs; fsqrt of -0 is -0; fld1; fchs; fsqrt of -1 is the indefinite.
        const sq = run([0xd9, 0xe8, 0xd9, 0xe0, 0xd9, 0xfa, 0xdd, 0x1d, ...u32(DATA)]);
        assert.equal(sq.readU32(DATA + 4), 0xfff80000, 'negative quiet NaN, high dword');
    });

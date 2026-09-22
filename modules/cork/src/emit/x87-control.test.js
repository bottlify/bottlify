/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';

const CODE = 0x1000;
const DATA = 0x2000;

/** @param {number} value */
function f64bytes(value){
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    return [...b];
}

/**
 * Runs a program: the control word at DATA + 0x100, doubles at DATA.
 *
 * @param {number[]} bytes @param {{ data?: number[], control?: number }} [start]
 */
function run(bytes, { data = [], control = 0x37f } = {}){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    m.write(DATA, data);
    m.write(DATA + 0x100, [control & 0xff, control >> 8]);
    m.write(CODE, [0xd9, 0x2d, 0x00, 0x21, 0, 0, ...bytes, 0xf4]); // fldcw [DATA+0x100] first
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    return {
        m, exit,
        status: ()=>view.getUint16(m.layout.x87Status, true),
        control: ()=>view.getUint16(m.layout.x87Control, true),
        /** @param {number} address */
        f64: address=>view.getFloat64(m.layout.ramBase + address, true),
        /** @param {number} address */
        u32: address=>view.getUint32(m.layout.ramBase + address, true),
        /** @param {number} address */
        u16: address=>view.getUint16(m.layout.ramBase + address, true),
        /** ST(i) as f64. @param {number} i */
        st: i=>view.getFloat64(
            m.layout.x87 + (((view.getUint8(m.layout.x87Top) + i) & 7) * 16), true),
    };
}

const RC = { nearest: 0, down: 0x400, up: 0x800, trunc: 0xc00 };
// fld qword [DATA]; fistp dword [DATA+8]
const FISTP_M32 = [0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdb, 0x1d, 0x08, 0x20, 0, 0];

test('fistp rounds by the control word: nearest, down, up, toward zero', ()=>{
    /** @param {number} value @param {number} rc */
    const stored = (value, rc)=>run(FISTP_M32,
        { data: f64bytes(value), control: 0x37f & ~0xc00 | rc }).u32(DATA + 8) | 0;
    assert.deepEqual([RC.nearest, RC.trunc, RC.up, RC.down].map(rc=>stored(2.5, rc)), [2, 2, 3, 2]);
    assert.deepEqual([RC.nearest, RC.trunc, RC.up, RC.down].map(rc=>stored(-2.5, rc)),
        [-2, -2, -2, -3]);
    assert.deepEqual([RC.nearest, RC.trunc, RC.up, RC.down].map(rc=>stored(3.5, rc)), [4, 3, 4, 3]);
    const r = run(FISTP_M32, { data: f64bytes(1e19) });
    assert.equal(r.u32(DATA + 8), 0x80000000, 'the integer indefinite');
    assert.equal(r.status() & 1, 1, 'invalid');
    const word = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdf, 0x1d, 0x08, 0x20, 0, 0],
        { data: f64bytes(40000) });
    assert.equal(word.u16(DATA + 8), 0x8000);
    // fisttp truncates whatever the rounding control says.
    const tt = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdb, 0x0d, 0x08, 0x20, 0, 0],
        { data: f64bytes(2.9), control: 0x37f | RC.up });
    assert.equal(tt.u32(DATA + 8), 2);
    assert.equal(tt.control(), 0x37f | RC.up, 'the control word came through fldcw');
});

test('the truncation idiom of the era stays in one region and truncates', ()=>{
    // fnstcw [ebp-2]; or word [ebp-2], 0xc00; fldcw [ebp-2]; fistp [ebp-8]; fldcw [DATA+0x100]
    const program = [
        0xdd, 0x05, 0x00, 0x20, 0, 0,                // fld qword [DATA]
        0xd9, 0x7d, 0xfe,                            // fnstcw [ebp-2]
        0x66, 0x81, 0x4d, 0xfe, 0x00, 0x0c,          // or word [ebp-2], 0xc00
        0xd9, 0x6d, 0xfe,                            // fldcw [ebp-2]
        0xdb, 0x5d, 0xf8,                            // fistp dword [ebp-8]
        0xd9, 0x2d, 0x00, 0x21, 0, 0,                // fldcw [DATA+0x100]
    ];
    for (const [value, expected] of [[3.9, 3], [-3.9, -3]])
    {
        const m = createTestMachine();
        m.write(DATA, f64bytes(value));
        m.write(DATA + 0x100, [0x7f, 0x03]);
        m.write(CODE, [...program, 0xf4]);
        m.setReg('esp', 0x80000);
        m.setReg('ebp', 0x3000);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3);
        assert.equal(exit.regions, 1, 'one region');
        assert.equal(m.readU32(0x3000 - 8) | 0, expected);
        assert.equal(new DataView(m.memory.buffer).getUint16(m.layout.x87Control, true), 0x37f,
            'the control word restored');
    }
});

test('precision control at single rounds every arithmetic result to a float', ()=>{
    // fld m64 (1/3); fadd st0, st0; fstp m64
    const program = [0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd8, 0xc0, 0xdd, 0x1d, 0x08, 0x20, 0, 0];
    const single = run(program, { data: f64bytes(1 / 3), control: 0x37f & ~0x300 });
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, single.f64(DATA + 8), true);
    assert.equal(Number(bits.getBigUint64(0, true) & ((1n << 29n) - 1n)), 0,
        'the low 29 bits are zero');
    assert.equal(single.f64(DATA + 8), Math.fround(2 / 3));
    const double = run(program, { data: f64bytes(1 / 3) });
    assert.equal(double.f64(DATA + 8), 2 / 3, 'the exact double under PC = 53');
    const extended = run(program, { data: f64bytes(1 / 3), control: 0x37f | 0x300 });
    assert.equal(extended.f64(DATA + 8), 2 / 3, 'extended treated as double');
});

test('frndint rounds by the control word; fscale scales by a power of two', ()=>{
    /** @param {number} value @param {number} rc */
    const rounded = (value, rc)=>run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd9, 0xfc],
        { data: f64bytes(value), control: 0x37f | rc }).st(0);
    const modes = [RC.nearest, RC.down, RC.up, RC.trunc];
    assert.deepEqual(modes.map(rc=>rounded(2.5, rc)), [2, 2, 3, 2]);
    assert.deepEqual(modes.map(rc=>rounded(-1.5, rc)), [-2, -2, -1, -1]);
    // fscale scales ST0 by 2^trunc(ST1):
    // fld 3 (st1); fld 5 (st0); fscale -> 5 * 2^3 = 40
    const s = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xfd],
        { data: [...f64bytes(3), ...f64bytes(5)] });
    assert.equal(s.st(0), 40);
    assert.equal(s.st(1), 3);
    const wide = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xfd],
        { data: [...f64bytes(-1074), ...f64bytes(1)] });
    assert.equal(wide.st(0), 5e-324, 'a power past the double\'s range in one step still lands');
    const neg = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xfd],
        { data: [...f64bytes(-2.7), ...f64bytes(8)] });
    assert.equal(neg.st(0), 2, 'the scale is truncated toward zero: 8 * 2^-2');
    // A scale past the double's range saturates rather than wrapping: the
    // clamped two-step power still reaches the ends.
    const huge = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xfd],
        { data: [...f64bytes(2000), ...f64bytes(1)] });
    assert.equal(huge.st(0), Infinity, '2^2000');
    const tiny = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xfd],
        { data: [...f64bytes(-2000), ...f64bytes(1)] });
    assert.equal(tiny.st(0), 0, '2^-2000 underflows to zero');
});

test('fxtract splits a value; of zero it gives -inf and the zero-divide flag', ()=>{
    const r = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd9, 0xf4], { data: f64bytes(-12) });
    assert.equal(r.st(0), -1.5, 'the significand');
    assert.equal(r.st(1), 3, 'the exponent');
    const zero = run([0xd9, 0xee, 0xd9, 0xf4]);
    assert.equal(zero.st(0), 0);
    assert.equal(zero.st(1), -Infinity);
    assert.equal(zero.status() & 4, 4, 'ZE');
    const tiny = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd9, 0xf4], { data: f64bytes(5e-324) });
    assert.equal(tiny.st(0), 1);
    assert.equal(tiny.st(1), -1074);
});

test('fprem: the remainder with the quotient bits in C0 C3 C1, and the invalid case', ()=>{
    const r = run([0xd9, 0xe8, 0xd9, 0xeb, 0xd9, 0xf8]); // fld1; fldpi; fprem -> pi mod 1
    assert.ok(Math.abs(r.st(0) - (Math.PI - 3)) < 1e-15);
    assert.equal(r.status() & 0x4500, 0x4000,
        'quotient 3: C3 (bit 1) set, C0 (bit 2) clear, C2 clear');
    assert.equal(r.status() & 0x200, 0x200, 'C1 is bit 0 of the quotient');
    const ten = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xf8],
        { data: [...f64bytes(3), ...f64bytes(10)] });
    assert.equal(ten.st(0), 1, '10 mod 3');
    assert.equal(ten.status() & 0x400, 0, 'C2 clear: the reduction is complete');
    const one = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xf5],
        { data: [...f64bytes(3), ...f64bytes(10)] });
    assert.equal(one.st(0), 1, 'fprem1 rounds the quotient to nearest: 10 - 3*3');
    const invalid = run([0xd9, 0xee, 0xd9, 0xee, 0xd9, 0xf8]); // fldz; fldz; fprem
    assert.ok(Number.isNaN(invalid.st(0)));
    assert.equal(invalid.status() & 1, 1);
    const partial = run([0xd9, 0xe8, 0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd9, 0xf8],
        { data: f64bytes(2 ** 70) });
    assert.equal(partial.status() & 0x400, 0x400, 'C2: a quotient past 64 bits is reduced in part');
});

test('a spread of doubles through fistp under every rounding mode agrees with JS', ()=>{
    let seed = 12345;
    const random = ()=>{
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const modes = /** @type {[number, (v: number) => number][]} */ ([
        [RC.nearest, v=>{
            const r = Math.round(v);
            return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r;
        }],
        [RC.down, Math.floor], [RC.up, Math.ceil], [RC.trunc, Math.trunc],
    ]);
    for (let i = 0; i < 50; i++)
    {
        const value = (random() - 0.5) * 2000 * (i % 5 === 0 ? 1 : random());
        for (const [rc, expect] of modes)
        {
            const r = run(FISTP_M32, { data: f64bytes(value), control: 0x37f | rc });
            assert.equal(r.u32(DATA + 8) | 0, expect(value) | 0, `${value} under ${rc}`);
        }
    }
});

test('fprem1 puts the rounded quotient\'s low bits in C0, C3 and C1', ()=>{
    // fld qword [DATA]; fld qword [DATA+8]; fprem1; fnstsw ax
    const FREM1 = [0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0,
        0xd9, 0xf5, 0xdf, 0xe0];
    /** @param {number} divisor @param {number} dividend @param {number} bits */
    const q = (divisor, dividend, bits)=>{
        const r = run(FREM1, { data: [...f64bytes(divisor), ...f64bytes(dividend)] });
        assert.equal(r.m.reg('eax') & 0x4700, bits, `${dividend} mod ${divisor}`);
    };
    q(3, 10, 0x4200);   // 10/3 rounds to 3 = 011b: C3 (Q1) and C1 (Q0)
    q(3, 4, 0x0200);    // 4/3 rounds to 1 = 001b: C1
    q(4, 10, 0x4000);   // 10/4 rounds to even 2 = 010b: C3
});

test('precision control at single rounds the memory and reversed arithmetic forms too', ()=>{
    // fld qword [DATA]; fsubr qword [DATA+8]; fstp qword [DATA+16]
    const subr = [0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdc, 0x2d, 0x08, 0x20, 0, 0,
        0xdd, 0x1d, 0x10, 0x20, 0, 0];
    const data = [...f64bytes(1 / 3), ...f64bytes(2 / 3)];
    const single = run(subr, { data, control: 0x37f & ~0x300 });
    assert.equal(single.f64(DATA + 16), Math.fround(2 / 3 - 1 / 3),
        '2/3 - 1/3 rounded to a float');
    const exact = run(subr, { data });
    assert.equal(exact.f64(DATA + 16), 2 / 3 - 1 / 3, 'the double under PC = 53');
    // fld qword [DATA]; fmul qword [DATA+8]; fstp qword [DATA+16]
    const mul = [0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdc, 0x0d, 0x08, 0x20, 0, 0,
        0xdd, 0x1d, 0x10, 0x20, 0, 0];
    const product = run(mul, { data, control: 0x37f & ~0x300 });
    assert.equal(product.f64(DATA + 16), Math.fround(1 / 3 * (2 / 3)));
});

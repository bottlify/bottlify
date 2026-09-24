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

/** @param {number[]} bytes @param {number[]} [data] */
function run(bytes, data = []){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    m.write(DATA, data);
    m.write(CODE, [...bytes, 0xf4]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    return {
        m, exit,
        status: ()=>view.getUint16(m.layout.x87Status, true),
        top: ()=>view.getUint8(m.layout.x87Top),
        /** ST(i) as f64. @param {number} i */
        st: i=>view.getFloat64(
            m.layout.x87 + (((view.getUint8(m.layout.x87Top) + i) & 7) * 16), true),
    };
}

test('fsin of pi is the f64 sine of the f64 pi; fcos and fsincos as Math gives them', ()=>{
    const r = run([0xd9, 0xeb, 0xd9, 0xfe]); // fldpi; fsin
    assert.equal(r.exit.kind, 3, `left out ${[...r.exit.unsupported]}`);
    assert.equal(r.st(0), 1.2246467991473532e-16);
    assert.equal(r.status() & 0x400, 0, 'C2 clear: reduced');
    const c = run([0xd9, 0xeb, 0xd9, 0xff]); // fldpi; fcos
    assert.equal(c.st(0), -1);
    const both = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd9, 0xfb], f64bytes(0.5)); // fld 0.5; fsincos
    assert.equal(both.st(0), Math.cos(0.5), 'the cosine on top');
    assert.equal(both.st(1), Math.sin(0.5));
    assert.equal(both.top(), 6, 'two lower than empty');
    const far = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd9, 0xfe], f64bytes(2 ** 64)); // out of range
    assert.equal(far.st(0), 2 ** 64, 'left as it was');
    assert.equal(far.status() & 0x400, 0x400, 'C2 set');
});

test('fptan pushes 1 after the tangent; fpatan takes two and leaves one', ()=>{
    const t = run([0xd9, 0xee, 0xd9, 0xf2]); // fldz; fptan
    assert.equal(t.st(0), 1);
    assert.equal(t.st(1), 0);
    assert.equal(t.top(), 6);
    const a = run([0xd9, 0xe8, 0xd9, 0xe8, 0xd9, 0xf3]); // fld1; fld1; fpatan -> atan2(1, 1)
    assert.equal(a.st(0), Math.PI / 4);
    assert.equal(a.top(), 7);
});

test('f2xm1, fyl2x and fyl2xp1, with the zero-divide of a zero argument', ()=>{
    const e = run([0xd9, 0xe8, 0xd9, 0xf0]); // fld1; f2xm1 -> 1
    assert.equal(e.st(0), 1);
    const half = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd9, 0xf0], f64bytes(0.5));
    assert.ok(Math.abs(half.st(0) - (Math.SQRT2 - 1)) < 1e-15, `${half.st(0)}`);
    const y = run([0xd9, 0xe8, 0xd9, 0xe8, 0xd9, 0xf1]); // fld1; fld1; fyl2x -> 1 * log2(1) = 0
    assert.equal(y.st(0), 0);
    assert.equal(y.top(), 7);
    const eight = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x05, 0x08, 0x20, 0, 0, 0xd9, 0xf1],
        [...f64bytes(3), ...f64bytes(8)]); // 3 * log2(8) = 9
    assert.equal(eight.st(0), 9);
    const zero = run([0xd9, 0xe8, 0xd9, 0xee, 0xd9, 0xf1]); // fld1; fldz; fyl2x -> 1 * log2(0)
    assert.equal(zero.st(0), -Infinity);
    assert.equal(zero.status() & 4, 4, 'ZE');
    // fld1; fld1; fchs; fyl2x
    const negative = run([0xd9, 0xe8, 0xd9, 0xe8, 0xd9, 0xe0, 0xd9, 0xf1]);
    assert.ok(Number.isNaN(negative.st(0)));
    assert.equal(negative.status() & 1, 1, 'IE');
    const p1 = run([0xd9, 0xe8, 0xd9, 0xe8, 0xd9, 0xf9]); // fld1; fld1; fyl2xp1 -> log2(2) = 1
    assert.equal(p1.st(0), 1);
});

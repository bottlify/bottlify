/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * X87's JavaScript is what the translator computes for each instruction,
 * bit for bit: each run on cork's test machine over edges and random
 * doubles and held to the function of the same name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../cork/src/testing/machine.js';
import { X87 } from './x87.js';

const CODE = 0x1000;
const HALT = 0x0f00;
const STACK = 0x7fff0;

/**
 * Runs `code` with the doubles as its stack arguments, under the control
 * word, and answers the double it leaves in ST0.
 *
 * @param {ReturnType<typeof createTestMachine>} m @param {number[]} args
 * @param {number} [control]
 */
function run(m, args, control = 0x27f){
    const view = new DataView(m.memory.buffer);
    m.writeU32(STACK, HALT);
    args.forEach((value, i)=>{
        const bits = new DataView(new ArrayBuffer(8));
        bits.setFloat64(0, value, true);
        m.writeU32(STACK + 4 + i * 8, bits.getUint32(0, true));
        m.writeU32(STACK + 8 + i * 8, bits.getUint32(4, true));
    });
    m.setReg('esp', STACK);
    view.setUint16(m.layout.x87Control, control, true);
    view.setUint8(m.layout.x87Top, 0);
    view.setUint8(m.layout.x87Empty, 0xff);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, JSON.stringify(exit));
    const top = view.getUint8(m.layout.x87Top);
    assert.equal(view.getUint8(m.layout.x87Empty), 0xff & ~(1 << top), 'one double left');
    return view.getFloat64(m.layout.x87 + top * 16, true);
}

/** @param {number[]} code */
function machine(code){
    const m = createTestMachine();
    m.write(CODE, code);
    m.write(HALT, [0xf4]);
    return m;
}

/** Edges and random doubles, NaN among them once. */
function values(){
    let state = 7;
    const next = ()=>{
        state = Math.imul(state ^ state >>> 15, 0x2c1b3c6d) + 0x297a2d39 | 0;
        return state >>> 0;
    };
    const out = [0, -0, 1, -1, 0.5, -0.5, 1.5, 2.5, -2.5, 1e-310, -5e-324, 2 ** -1022, 1e300,
        -1e300, 2 ** 52 + 0.5, 3.5, Infinity, -Infinity, NaN, Math.PI];
    for (let i = 0; i < 200; i++)
    {
        out.push((next() - 2 ** 31) / 2 ** (next() % 60) * (next() % 2 === 0 ? 1 : 2 ** 900));
    }
    return out;
}

/** @param {number} a @param {number} b */
const same = (a, b)=>Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b);

test('the constants are what fldl2e and its kin load', ()=>{
    for (const [name, op] of /** @type {const} */ ([['L2T', 0xe9], ['L2E', 0xea], ['PI', 0xeb],
        ['LG2', 0xec], ['LN2', 0xed]]))
    {
        assert.ok(same(run(machine([0xd9, op, 0xc3]), []), X87[name]), name);
    }
});

test('rint, f2xm1, exponent and significand are frndint, f2xm1 and a finite fxtract', ()=>{
    // fld qword [esp+4]; op; ret
    const load = [0xdd, 0x44, 0x24, 0x04];
    const rint = machine([...load, 0xd9, 0xfc, 0xc3]);
    const f2xm1 = machine([...load, 0xd9, 0xf0, 0xc3]);
    const exponent = machine([...load, 0xd9, 0xf4, 0xdd, 0xd8, 0xc3]);
    const significand = machine([...load, 0xd9, 0xf4, 0xdd, 0xd9, 0xc3]);
    for (const x of values())
    {
        assert.ok(same(run(rint, [x]), X87.rint(x)), `rint(${x})`);
        const small = x - Math.trunc(x);
        assert.ok(same(run(f2xm1, [small]), X87.f2xm1(small)), `f2xm1(${small})`);
        if (Number.isFinite(x))
        {
            assert.ok(same(run(exponent, [x]), X87.exponent(x)), `exponent(${x})`);
            assert.ok(same(run(significand, [x]), X87.significand(x)), `significand(${x})`);
        }
    }
});

test('yl2x and scale are fyl2x and fscale, whatever the count', ()=>{
    // fld qword [esp+4]; fld qword [esp+12]; fyl2x; ret
    const yl2x = machine([0xdd, 0x44, 0x24, 0x04, 0xdd, 0x44, 0x24, 0x0c, 0xd9, 0xf1, 0xc3]);
    // fld qword [esp+12]; fld qword [esp+4]; fscale; fstp st1; ret
    const scale = machine([0xdd, 0x44, 0x24, 0x0c, 0xdd, 0x44, 0x24, 0x04, 0xd9, 0xfd, 0xdd,
        0xd9, 0xc3]);
    const all = values();
    const counts = [0, 1, -1, 1023, -1022, -1074, 1500, -1500, 2099.5, -2200, 5000, NaN, Infinity,
        -Infinity, 0.75, -0.75];
    for (const x of all)
    {
        for (const y of [all[all.indexOf(x) * 7 % all.length], 3, -0.5])
        {
            assert.ok(same(run(yl2x, [y, x]), X87.yl2x(y, x)), `yl2x(${y}, ${x})`);
        }
        for (const n of counts)
        {
            assert.ok(same(run(scale, [x, n]), X87.scale(x, n)), `scale(${x}, ${n})`);
        }
    }
});

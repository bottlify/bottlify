/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMathFunctions } from './math.js';
import { COMPILED } from './inguest.x86.js';
import { COMPILED as MATH_CODE } from './inguest-math.x86.js';
import { EDOM, ERANGE } from './globals.js';
import { fakeMemory, fakeFpu, doubleSlots } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    const fpu = fakeFpu();
    /** @type {number[]} */
    const errors = [];
    return {
        memory,
        fpu,
        errors,
        table: /** @type {Record<string, any>} */ (createMathFunctions({
            readMemory: memory.readMemory, writeMemory: memory.writeMemory, fpu,
            errno: code=>void errors.push(code),
        })),
    };
};

test('a double argument arrives as two slots, low half first', ()=>{
    const { fpu, table } = build();
    table.sqrt.handler(doubleSlots(2));
    assert.equal(fpu.result, Math.SQRT2);
    assert.equal(table.sqrt.argBytes, 8, 'one double is eight bytes of arguments');
});

test('the result goes to the FPU rather than to EAX', ()=>{
    const { fpu, table } = build();
    assert.equal(table.sin.handler(doubleSlots(0)), 0, 'EAX means nothing here');
    assert.equal(fpu.result, 0);
    table.cos.handler(doubleSlots(0));
    assert.equal(fpu.result, 1);
});

test('a two-argument function reads four slots in order', ()=>{
    const { fpu, table } = build();
    table.pow.handler([...doubleSlots(2), ...doubleSlots(10)]);
    assert.equal(fpu.result, 1024);
    assert.equal(table.pow.argBytes, 16);
});

test('fmod keeps the sign of the dividend', ()=>{
    const { fpu, table } = build();
    table.fmod.handler([...doubleSlots(-7), ...doubleSlots(3)]);
    assert.equal(fpu.result, -1);
});

test('the _CI form takes its argument off the FPU stack and consumes it', ()=>{
    const { fpu, table } = build();
    fpu.load([4]);
    table._CIsqrt.handler([]);
    assert.equal(fpu.result, 2);
    assert.equal(fpu.stack.length, 1, 'the argument was replaced, not stacked on');
    assert.equal(table._CIsqrt.argBytes, 0, 'nothing is on the caller\'s stack');
});

test('the _CI form of a binary function reads ST(1) as the left operand', ()=>{
    const { fpu, table } = build();
    // pow(2, 10): 2 was pushed first, so it is ST(1).
    fpu.load([10, 2]);
    table._CIpow.handler([]);
    assert.equal(fpu.result, 1024, 'reversed operands would answer 100');
    assert.equal(fpu.stack.length, 1);
});

test('_ftol and its two other names are one body of guest code, into EDX:EAX', ()=>{
    // What it answers is held in inguest.test.js and crt-inguest.itest.js.
    const { table } = build();
    assert.deepEqual(table._ftol.code(), COMPILED._ftol.code);
    assert.equal(table._ftol2, table._ftol);
    assert.equal(table._ftol2_sse, table._ftol);
    assert.equal('handler' in table._ftol, false, 'no EDX to answer in: the x86 alone');
});

test('_ftol\'s handler, where EDX can be set, pops ST0 and answers both halves', ()=>{
    const fpu = fakeFpu();
    /** @type {Record<string, number>} */
    const registers = {};
    const memory = fakeMemory();
    const table = /** @type {Record<string, any>} */ (createMathFunctions({
        readMemory: memory.readMemory, writeMemory: memory.writeMemory, fpu,
        setRegisters: values=>Object.assign(registers, values),
    }));
    fpu.load([-(2 ** 40) - 0.5]);
    assert.equal(table._ftol.handler([]) >>> 0, 0);
    assert.equal(registers.edx >>> 0, 0xffffff00);
    assert.equal(fpu.stack.length, 0, 'the argument popped');
});

test('ldexp scales by a power of two given as a plain integer slot', ()=>{
    const { fpu, table } = build();
    table.ldexp.handler([...doubleSlots(1.5), 4]);
    assert.equal(fpu.result, 24);
});

test('frexp splits into a mantissa in [0.5, 1) and an exponent', ()=>{
    const { memory, fpu, table } = build();
    const exponent = memory.allocate(4);
    table.frexp.handler([...doubleSlots(24), exponent]);
    assert.equal(fpu.result, 0.75);
    assert.equal(memory.i32(exponent), 5);
});

test('frexp answers zero for both halves at zero', ()=>{
    const { memory, fpu, table } = build();
    const exponent = memory.allocate(4);
    memory.setU32(exponent, 0xffffffff);
    table.frexp.handler([...doubleSlots(0), exponent]);
    assert.equal(fpu.result, 0);
    assert.equal(memory.i32(exponent), 0);
});

test('modf gives both halves the sign of the original', ()=>{
    const { memory, fpu, table } = build();
    const whole = memory.allocate(8);
    table.modf.handler([...doubleSlots(-1.5), whole]);
    assert.equal(fpu.result, -0.5);
    assert.equal(new DataView(memory.bytes.buffer).getFloat64(whole, true), -1);
});

test('every function is code in the guest, hypot the same as _hypot', ()=>{
    const { table } = build();
    for (const name of ['sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log',
        'log10', 'pow', 'fmod', 'sinh', 'cosh', 'tanh', '_hypot', 'ldexp', 'frexp', 'modf',
        '_CIsqrt', '_CIsin', '_CIpow', '_CIatan2', '_CIfmod', '_CIfloor', '_CIceil', '_CIfabs'])
    {
        const code = typeof table[name].code === 'function' ? table[name].code({
            register: ()=>0x1000, jump: ()=>{},
        }) : null;
        assert.deepEqual(code, MATH_CODE[/** @type {keyof typeof MATH_CODE} */ (name)].code, name);
    }
    assert.deepEqual(table.hypot.code({ register: ()=>0, jump: ()=>{} }), MATH_CODE._hypot.code);
});

test('errno as msvcrt sets it: EDOM for a NaN of arguments that were none, ERANGE for an '
    + 'infinity of finite ones, nothing for an underflow', ()=>{
    /** @type {[string, number[], number | null][]} */
    const cases = [
        ['sqrt', [-1], EDOM], ['sqrt', [-Infinity], EDOM], ['sqrt', [NaN], null],
        ['log', [0], ERANGE], ['log', [-1], EDOM], ['log10', [-0], ERANGE],
        ['sin', [Infinity], EDOM], ['cos', [-Infinity], EDOM], ['tan', [NaN], null],
        ['asin', [2], EDOM], ['acos', [-Infinity], EDOM],
        ['exp', [1000], ERANGE], ['exp', [-1000], null], ['exp', [Infinity], null],
        ['pow', [0, -1], ERANGE], ['pow', [-1, 1.5], EDOM], ['pow', [2, 1e100], ERANGE],
        ['pow', [2, -1e100], null], ['pow', [Infinity, 2], null], ['pow', [1e200, 2], ERANGE],
        ['cosh', [1000], ERANGE], ['sinh', [-Infinity], null],
        ['_hypot', [1.5e308, 1.5e308], ERANGE],
        ['ldexp', [1, 5000], ERANGE], ['ldexp', [1, -5000], null], ['ldexp', [Infinity, 1], null],
    ];
    for (const [name, args, code] of cases)
    {
        const { table, errors } = build();
        const slots = name === 'ldexp' ? [...doubleSlots(args[0]), args[1]]
            : args.flatMap(doubleSlots);
        table[name].handler(slots);
        assert.deepEqual(errors, code === null ? [] : [code], `${name}(${args})`);
    }
});

test('ldexp reaches what a double holds from a power of two a double does not', ()=>{
    const { fpu, table } = build();
    table.ldexp.handler([...doubleSlots(1e300), -1100 >>> 0]);
    assert.equal(fpu.result, 1e300 * 2 ** -1000 * 2 ** -100, 'not 1e300 times 2^-1100, zero');
    table.ldexp.handler([...doubleSlots(2 ** -1070), 2000]);
    assert.equal(fpu.result, 2 ** 930);
});

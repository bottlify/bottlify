/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMathFunctions } from './math.js';
import { fakeMemory, fakeFpu, doubleSlots } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    const fpu = fakeFpu();
    return {
        memory,
        fpu,
        table: /** @type {Record<string, any>} */ (
            createMathFunctions({ writeMemory: memory.writeMemory, fpu })),
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

test('_ftol truncates towards zero rather than rounding', ()=>{
    const { fpu, table } = build();
    fpu.load([2.9]);
    assert.equal(table._ftol.handler([]), 2);
    fpu.load([-2.9]);
    assert.equal(table._ftol.handler([]), -2, 'not -3');
    assert.equal(table._ftol2, table._ftol, 'the same function under both names');
});

test('_ftol answers an __int64, the high half in EDX, under all three names', ()=>{
    const memory = fakeMemory();
    const fpu = fakeFpu();
    /** @type {Record<string, number>[]} */
    const registers = [];
    const table = /** @type {Record<string, any>} */ (createMathFunctions({
        writeMemory: memory.writeMemory, fpu, setRegisters: values=>registers.push(values),
    }));
    /** @param {string} name @param {number} value */
    const convert = (name, value)=>{
        fpu.load([value]);
        const eax = table[name].handler([]) >>> 0;
        return [eax, registers.at(-1)?.edx];
    };
    assert.deepEqual(convert('_ftol', 0x100000007 + 0.5), [7, 1]);
    assert.deepEqual(convert('_ftol2', -1.5), [0xffffffff, 0xffffffff], 'sign-extended');
    assert.deepEqual(convert('_ftol2_sse', -0x100000000), [0, 0xffffffff]);
    // Past the range of an __int64, and NaN, x87's FISTP stores the integer
    // indefinite rather than any part of the value.
    assert.deepEqual(convert('_ftol', 1e20), [0, 0x80000000]);
    assert.deepEqual(convert('_ftol', -1e20), [0, 0x80000000]);
    assert.deepEqual(convert('_ftol', NaN), [0, 0x80000000]);
    assert.deepEqual(convert('_ftol', -(2 ** 63)), [0, 0x80000000], 'the one in range');
});

test('_ftol consumes its argument', ()=>{
    const { fpu, table } = build();
    fpu.load([1.5, 9]);
    table._ftol.handler([]);
    assert.deepEqual(fpu.stack, [9]);
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

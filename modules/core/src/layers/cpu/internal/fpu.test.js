/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFpu, encodeExtended, decodeExtended } from './fpu.js';

/** Linear memory with an empty stack, as the emulator leaves it after a reset. */
function machine(){
    const buffer = new ArrayBuffer(0x1000);
    const view = new DataView(buffer);
    view.setUint8(816, 0xff);
    view.setUint8(1032, 0);
    view.setUint16(1036, 0x37f, true);
    return { view, cpu: { wasm_memory: { buffer } } };
}

const VALUES = [
    0, -0, 1, -1, 0.5, 2, 3.14159265358979, 1e300, -1e300, 1e-300,
    Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, 5e-324, 2.2250738585072014e-308,
    Infinity, -Infinity,
];

test('a double survives the trip through extended precision unchanged', ()=>{
    // Every one of these goes out to a program as the result of a maths call
    // and comes back as its argument. A conversion that is close rather than
    // exact accumulates over a frame and moves geometry a pixel at a time.
    for (const value of VALUES)
    {
        const { low, high, signExponent } = encodeExtended(value);
        assert.equal(decodeExtended(low, high, signExponent), value, `${value}`);
    }
    assert.ok(Number.isNaN(decodeExtended(0, 0xc0000000, 0xffff)), 'and a NaN stays a NaN');
});

test('negative zero keeps its sign, which is a fact a program can branch on', ()=>{
    const { low, high, signExponent } = encodeExtended(-0);
    assert.equal(signExponent, 0x8000);
    assert.equal(low | high, 0);
    assert.equal(Object.is(decodeExtended(low, high, signExponent), -0), true);
});

test('the leading bit is explicit here, where a double leaves it implied', ()=>{
    // An extended value without it is not the number that was meant: the
    // processor reads the shape as invalid rather than as one point zero.
    assert.deepEqual(encodeExtended(1), { low: 0, high: 0x80000000, signExponent: 0x3fff });
    assert.deepEqual(encodeExtended(Infinity), { low: 0, high: 0x80000000, signExponent: 0x7fff });
});

test('a result is left on the stack, not merely written near it', ()=>{
    // The caller's next instruction stores from the top of the stack. Writing
    // a register without moving the pointer stores whatever was there before.
    const { view, cpu } = machine();
    const fpu = createFpu(cpu);

    fpu.setResult(2.5);

    assert.equal(view.getUint8(1032), 7, 'the top moved down, as a push does');
    assert.equal(view.getUint8(816) >>> 7 & 1, 0, 'and the register it moved to holds a value');
    assert.equal(fpu.get(0), 2.5);
    assert.equal(fpu.depth(), 1);
});

test('pushes stack up, and a pop uncovers the one beneath', ()=>{
    const { cpu } = machine();
    const fpu = createFpu(cpu);

    fpu.setResult(1.5);
    fpu.setResult(4.25);

    assert.equal(fpu.get(0), 4.25, 'the last one pushed is the top');
    assert.equal(fpu.get(1), 1.5);
    assert.equal(fpu.depth(), 2);

    fpu.pop();
    assert.equal(fpu.get(0), 1.5);
    assert.equal(fpu.depth(), 1);
});

test('a ninth push does not overwrite a register that still holds something', ()=>{
    // Eight registers is all there are. A guest that has filled them has lost
    // track of its own pushes, and quietly replacing one of its values turns a
    // fault it could have been told about into arithmetic that stays wrong.
    const { cpu } = machine();
    const fpu = createFpu(cpu);

    for (let index = 0; index < 8; index++)
    {
        fpu.setResult(index + 1);
    }
    assert.equal(fpu.depth(), 8);

    fpu.setResult(99);

    assert.equal(fpu.depth(), 8, 'still eight: the stack wrapped onto itself');
    assert.ok(Number.isNaN(fpu.get(0)), 'and the top says so rather than reading as a number');
});

test('the view is taken again each time, because the memory can be replaced', ()=>{
    // The emulator grows its own linear memory, and a DataView held over the
    // old buffer keeps answering from memory nothing else is using.
    const { cpu } = machine();
    const fpu = createFpu(cpu);
    fpu.setResult(7.5);

    const grown = new ArrayBuffer(0x2000);
    new Uint8Array(grown).set(new Uint8Array(cpu.wasm_memory.buffer));
    cpu.wasm_memory = { buffer: grown };

    assert.equal(fpu.get(0), 7.5);
    fpu.setResult(8.5);
    assert.equal(fpu.get(0), 8.5);
    assert.equal(new DataView(grown).getUint8(1032), 6, 'and it wrote to the new memory');
});

test('a register the compiler tagged as a double reads back as that double', ()=>{
    // Most x87 registers are left in the double's own bits with a tag in the
    // exponent word rather than in extended form, which is cheaper to produce
    // and what the emulator's own readers expect. Read as an extended value the
    // same bits are an astronomically large number that truncates to zero, so
    // every runtime maths call taking its argument off the stack would answer
    // for zero -- and a program would go on to divide by it.
    const { view, cpu } = machine();
    const fpu = createFpu(cpu);
    const bits = new DataView(new ArrayBuffer(8));

    /** Leaves ST(index) holding `value` the way the compiler's inline path does.
     * @param {number} index @param {number} value */
    const tagged = (index, value)=>{
        bits.setFloat64(0, value, true);
        view.setUint32(1152 + index * 16, bits.getUint32(0, true), true);
        view.setUint32(1152 + index * 16 + 4, bits.getUint32(4, true), true);
        view.setUint16(1152 + index * 16 + 8, 0x7ffe, true);
        view.setUint8(816, view.getUint8(816) & ~(1 << index));
    };

    for (const value of [0, 1, 640, 480, -2.5, 3.14159265358979, 1e300, 5e-324])
    {
        tagged(7, value);
        view.setUint8(1032, 7);
        assert.equal(fpu.get(0), value, `${value}`);
    }

    tagged(6, 4.25);
    view.setUint8(1032, 6);
    assert.equal(fpu.get(0), 4.25, 'the top, wherever it is');
    assert.equal(fpu.get(1), 5e-324, 'and a tagged register below it, as another operand');
});

test('the control word is readable, because rounding is part of an answer', ()=>{
    const { cpu } = machine();
    assert.equal(createFpu(cpu).controlWord(), 0x37f);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87 environment forms: fnstenv and fnsave write the protected-mode
 * environment (and the eight registers), fldenv and frstor read it back and
 * leave for the next block, since the top they set is known only then.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';

const CODE = 0x1000;
const DATA = 0x2000;
/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** @param {number[]} bytes */
function run(bytes){
    const m = createTestMachine();
    m.write(CODE, [...bytes, 0xf4]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, `halted; left out ${[...exit.unsupported]}`);
    return { m, exit };
}

test('fnstenv writes control, status with the top, the tag word and zero pointers', ()=>{
    // fldz; fld1; fnstenv [DATA]
    const { m } = run([0xd9, 0xee, 0xd9, 0xe8, 0xd9, 0x35, ...u32(DATA)]);
    assert.equal(m.readU32(DATA), 0xffff037f, 'the control word, high half all ones');
    assert.equal(m.readU32(DATA + 4) & 0x3800, 6 << 11, 'top 6');
    // Physical 6 holds 1.0 (valid 00), physical 7 holds zero (01), the rest empty (11).
    assert.equal(m.readU32(DATA + 8), 0xffff4fff);
    assert.equal(m.readU32(DATA + 12), 0);
    assert.equal(m.readU32(DATA + 16), 0);
    assert.equal(m.readU32(DATA + 20), 0);
    assert.equal(m.readU32(DATA + 24), 0xffff0000);
});

test('fnsave writes the registers in stack order and resets the unit; frstor brings it back', ()=>{
    // fldz; fld1; fnsave [DATA]; fnstsw ax; frstor [DATA];
    // fstp qword [DATA+120]; fstp qword [DATA+128]
    const { m, exit } = run([
        0xd9, 0xee, 0xd9, 0xe8,
        0xdd, 0x35, ...u32(DATA),
        0xdf, 0xe0,
        0xdd, 0x25, ...u32(DATA),
        0xdd, 0x1d, ...u32(DATA + 120),
        0xdd, 0x1d, ...u32(DATA + 128),
    ]);
    assert.equal(m.readU32(DATA + 8), 0xffff4fff, 'the tag word before the reset');
    // ST(0) = 1.0 as ten bytes: mantissa 0x8000000000000000, sign/exponent 0x3fff.
    assert.deepEqual([...m.read(DATA + 28, 10)], [0, 0, 0, 0, 0, 0, 0, 0x80, 0xff, 0x3f]);
    assert.deepEqual([...m.read(DATA + 38, 10)], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'ST(1) = 0');
    assert.equal(m.reg('eax') & 0xffff, 0, 'after fnsave the unit is as fninit leaves it');
    const view = new DataView(m.memory.buffer);
    assert.equal(view.getFloat64(m.layout.ramBase + DATA + 120, true), 1, 'ST(0) restored');
    assert.equal(view.getFloat64(m.layout.ramBase + DATA + 128, true), 0, 'ST(1) restored');
    assert.equal(view.getUint8(m.layout.x87Empty), 0xff, 'both popped again');
    assert.ok(exit.regions >= 2, 'frstor left for the next block');
});

test('fldenv loads the words alone: a top and a tag word the code was not compiled for', ()=>{
    // fld1; fld1; fld1 (top 5, three held); fnstenv [DATA]; fninit; fldenv [DATA]; fnstsw ax
    const { m } = run([
        0xd9, 0xe8, 0xd9, 0xe8, 0xd9, 0xe8,
        0xd9, 0x35, ...u32(DATA),
        0xdb, 0xe3,
        0xd9, 0x25, ...u32(DATA),
        0xdf, 0xe0,
    ]);
    assert.equal((m.reg('eax') >>> 11) & 7, 5, 'the top from the environment');
    assert.equal(new DataView(m.memory.buffer).getUint8(m.layout.x87Empty), 0x1f,
        'registers 5, 6 and 7 held by the tag word');
});

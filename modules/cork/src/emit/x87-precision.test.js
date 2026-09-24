/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Precision control under the `wide` translation: x87 regions compiled for
 * double and extended precision, a block testing the control word once, and
 * single precision seen leaving so the machine translates with the rounding.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';

const CODE = 0x1000;
const DATA = 0x2000;
/** @param {number} a */
const at = a=>[a & 255, a >> 8 & 255, 0, 0];

/**
 * Divides 1 by 3 from memory into [DATA+8] under a control word, the code
 * given around the division.
 *
 * @param {number} control @param {boolean} wide @param {number[]} [code]
 */
function divide(control, wide, code){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, 0xff);
    view.setUint16(m.layout.x87Control, control, true);
    // 1.0f, 3.0f, the result, and a single-precision control word at +16.
    m.write(DATA, [0, 0, 0x80, 0x3f, 0, 0, 0x40, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f, 0x00]);
    // fld dword [DATA]; fdiv dword [DATA+4]; fstp qword [DATA+8]; hlt
    m.write(CODE, code ?? [0xd9, 0x05, ...at(DATA), 0xd8, 0x35, ...at(DATA + 4),
        0xdd, 0x1d, ...at(DATA + 8), 0xf4]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE, { wide });
    return { exit, result: view.getFloat64(m.layout.ramBase + DATA + 8, true) };
}

for (const wide of [true, false])
{
    test(`single precision rounds the arithmetic${wide ? ', found at a wide region\'s block' : ''}`,
        ()=>{
            const { exit, result } = divide(0x07f, wide);
            assert.equal(exit.kind, 3, 'the hlt');
            assert.equal(result, Math.fround(1 / 3));
            // A wide region leaves before the division and is translated again.
            assert.equal(exit.regions, wide ? 2 : 1);
        });
}

test('a wide region runs double precision with no rounding and one translation', ()=>{
    const { exit, result } = divide(0x27f, true);
    assert.equal(exit.kind, 3);
    assert.equal(result, 1 / 3);
    assert.equal(exit.regions, 1);
});

test('a wide region tests precision again after its own fldcw', ()=>{
    // fld dword [DATA]; fdiv dword [DATA+4]; fldcw [DATA+16]; fld dword [DATA];
    // fdiv dword [DATA+4]; fstp qword [DATA+8]; fstp st0; hlt -- the second under PC = 24.
    const { exit, result } = divide(0x27f, true, [
        0xd9, 0x05, ...at(DATA), 0xd8, 0x35, ...at(DATA + 4), 0xd9, 0x2d, ...at(DATA + 16),
        0xd9, 0x05, ...at(DATA), 0xd8, 0x35, ...at(DATA + 4), 0xdd, 0x1d, ...at(DATA + 8),
        0xdd, 0xd8, 0xf4]);
    assert.equal(exit.kind, 3);
    assert.equal(result, Math.fround(1 / 3));
});

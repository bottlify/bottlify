/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { Exit } from './region.js';

const CODE = 0x1000;

/** mov ecx, 10; L: dec ecx; jnz L; mov eax, 42; hlt */
const COUNTDOWN = [0xb9, 10, 0, 0, 0, 0x49, 0x75, 0xfd, 0xb8, 42, 0, 0, 0, 0xf4];

test('a countdown loop runs to its halt and retires exactly its instructions', ()=>{
    const m = createTestMachine();
    m.write(CODE, COUNTDOWN);
    const unit = m.translate(CODE);
    assert.deepEqual([...unit.translation.labels.keys()], [CODE, CODE + 5, CODE + 8]);
    const exit = unit.run(CODE, 1000);
    assert.equal(exit.kind, Exit.HALT);
    assert.equal(m.reg('eax'), 42);
    assert.equal(m.reg('ecx'), 0);
    assert.equal(m.eip(), CODE + 14);
    // One mov, ten dec/jnz pairs, one mov, one hlt.
    assert.equal(m.counter(), 1 + 20 + 1 + 1);
});

test('a budget that runs out inside the loop leaves at the loop head with the count charged', ()=>{
    const m = createTestMachine();
    m.write(CODE, COUNTDOWN);
    const unit = m.translate(CODE);
    const exit = unit.run(CODE, 7);
    assert.equal(exit.kind, Exit.BUDGET);
    assert.equal(m.eip(), CODE + 5, 'on the loop head');
    // Charged at every jump: 1 (mov) + 2 + 2 + 2 = 7, three iterations done.
    assert.equal(m.counter(), 7);
    assert.equal(m.reg('ecx'), 7);
    // Carrying on from the head with the rest of the budget finishes it.
    const rest = unit.run(CODE + 5, 1000);
    assert.equal(rest.kind, Exit.HALT);
    assert.equal(m.counter(), 23);
    assert.equal(m.reg('eax'), 42);
});

test('a block reached from two others reads the record either left', ()=>{
    // 1000: test eax, eax
    // 1002: jz 1009
    // 1004: cmp ebx, 5
    // 1007: jmp 1009
    // 1009: setl cl        <- from the jz (test's flags) or from the jmp (cmp's flags)
    // 100c: hlt
    const program = [0x85, 0xc0, 0x74, 0x05, 0x83, 0xfb, 0x05, 0xeb, 0x00, 0x0f, 0x9c, 0xc1, 0xf4];
    const viaTest = createTestMachine();
    viaTest.write(CODE, program);
    viaTest.setReg('eax', 0);
    viaTest.setReg('eax', 0);
    viaTest.translate(CODE).run(CODE);
    assert.equal(viaTest.reg('ecx') & 0xff, 0, 'test of zero: SF = OF = 0, so not less');

    const viaCmp = createTestMachine();
    viaCmp.write(CODE, program);
    viaCmp.setReg('eax', 1);
    viaCmp.setReg('ebx', 3);
    viaCmp.translate(CODE).run(CODE);
    assert.equal(viaCmp.reg('ecx') & 0xff, 1, '3 < 5');
});

test('an exit writes every register, the flags word and eip back; nothing is kept outside', ()=>{
    const m = createTestMachine();
    // Every register touched: mov eax..edi, 1..8 (esp last, so the stack is not used),
    // then jmp eax.
    m.write(CODE, [
        0xb8, 1, 0, 0, 0, 0xb9, 2, 0, 0, 0, 0xba, 3, 0, 0, 0, 0xbb, 4, 0, 0, 0,
        0xbd, 6, 0, 0, 0, 0xbe, 7, 0, 0, 0, 0xbf, 8, 0, 0, 0, 0xbc, 5, 0, 0, 0,
        0xf9,       // stc
        0xff, 0xe0, // jmp eax
    ]);
    const exit = m.translate(CODE).run(CODE);
    assert.equal(exit.kind, Exit.UNTRANSLATED);
    const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
    assert.deepEqual(names.map(name=>m.reg(name)), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(m.eflags() & 1, 1, 'CF from stc is in the word');
    assert.equal(m.eip(), 1, 'the indirect target');
    assert.equal(m.counter(), 10);
});

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

test('a block branching to its own start is a loop of its own, with the budget still looked at',
    ()=>{
        // mov ecx, 1000; L: dec ecx; jnz L; hlt -- the loop block is one wasm
        // loop, and a budget spent inside it still leaves at the head.
        const m = createTestMachine();
        m.write(CODE, [0xb9, 0xe8, 0x03, 0, 0, 0x49, 0x75, 0xfd, 0xf4]);
        m.setReg('esp', 0x80000);
        const unit = m.translate(CODE);
        assert.equal(unit.translation.loops, 1, 'the loop block');
        assert.deepEqual(unit.run(CODE, 101), { kind: 1, vector: 0 }, 'budget');
        assert.equal(m.eip(), CODE + 5, 'at the loop head');
        assert.equal(m.counter(), 101);
        assert.deepEqual(unit.run(CODE + 5, 1_000_000), { kind: 3, vector: 0 });
        assert.equal(m.reg('ecx'), 0);
        assert.equal(m.counter(), 1 + 2 * 1000 + 1);
        // A budget spent on the very round the loop ends: the decision the
        // round took is not taken again after the leave (found by a bench
        // whose loop counted past zero and never halted).
        for (const budget of [3, 4, 5, 7, 8])
        {
            const n = createTestMachine();
            n.write(CODE, [0xb9, 0x0a, 0, 0, 0, 0x49, 0x75, 0xfd, 0xf4]); // ten rounds
            n.setReg('esp', 0x80000);
            const u = n.translate(CODE);
            let eip = CODE;
            let runs = 0;
            let exit = u.run(eip, budget);
            while (exit.kind === 1 && runs < 50)
            {
                runs++;
                eip = n.eip();
                exit = u.run(eip, budget);
            }
            assert.deepEqual(exit, { kind: 3, vector: 0 }, `budget ${budget}: halted`);
            assert.equal(n.reg('ecx'), 0, `budget ${budget}`);
            assert.equal(n.counter(), 22, `budget ${budget}: every instruction once`);
        }
        // With x87 in the loop and the stack as it started each round, still
        // a loop; with an exchange left in it, the dispatcher's edge instead.
        const same = createTestMachine();
        same.write(CODE, [0xd9, 0xe8, 0xb9, 0x0a, 0, 0, 0,     // fld1; mov ecx, 10
            0xd8, 0xc0, 0x49, 0x75, 0xfb, 0xf4]);                // L: fadd st0, st0; dec; jnz L
        same.setReg('esp', 0x80000);
        const s = same.translate(CODE);
        assert.equal(s.translation.loops, 1);
        assert.deepEqual(s.run(CODE), { kind: 3, vector: 0 });
        const swapped = createTestMachine();
        swapped.write(CODE, [0xd9, 0xe8, 0xd9, 0xee, 0xb9, 0x0a, 0, 0, 0, // fld1; fldz; mov ecx
            0xd9, 0xc9, 0x49, 0x75, 0xfb, 0xf4]);                          // L: fxch; dec; jnz L
        swapped.setReg('esp', 0x80000);
        const w = swapped.translate(CODE);
        assert.equal(w.translation.loops, 0, 'the exchange changes the state each round');
        assert.deepEqual(w.run(CODE), { kind: 3, vector: 0 });
    });

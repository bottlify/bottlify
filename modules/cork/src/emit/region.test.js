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
const DATA = 0x3000;
/** @param {number} v */
const u32 = v=>[v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];

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

test('a class left out by configuration is left to the other executor', ()=>{
    // fld1; movq mm0, [m]; hlt -- with x87 left out the region leaves before
    // the fld1; with MMX left out it runs the fld1 and leaves before the movq.
    const program = [0xd9, 0xe8, 0x0f, 0x6f, 0x05, ...u32(DATA), 0xf4];
    const fp = createTestMachine({ leaveOut: ['x87'] });
    fp.write(CODE, program);
    fp.setReg('esp', 0x80000);
    const f = fp.translate(CODE);
    assert.deepEqual(f.run(CODE), { kind: 0, vector: 0 });
    assert.equal(fp.eip(), CODE, 'before the fld1');
    assert.deepEqual([...f.translation.unsupported.keys()], ['d9 e8'], 'the fld1 left out');
    const mm = createTestMachine({ leaveOut: ['mmx'] });
    mm.write(CODE, program);
    mm.setReg('esp', 0x80000);
    const g = mm.translate(CODE);
    assert.deepEqual(g.run(CODE), { kind: 0, vector: 0 });
    assert.equal(mm.eip(), CODE + 2, 'before the movq');
    assert.equal(new DataView(mm.memory.buffer).getUint8(mm.layout.x87Top), 7, 'the fld1 ran');
});

test('a block compiled for the stack in another shape than the entry gets no entry', ()=>{
    // fld1; test eax, eax; jnz B; nop; B: fld1; hlt -- B is compiled for
    // top 7, the entry for top 0. Entered from outside with the stack as
    // the entry's, B would push onto slot 6 and write top 6 back for a
    // machine whose top was 0, the shape a program later finds wrong.
    const m = createTestMachine();
    const B = CODE + 7;
    m.write(CODE, [0xd9, 0xe8, 0x85, 0xc0, 0x75, 0x01, 0x90, 0xd9, 0xe8, 0xf4]);
    m.setReg('esp', 0x80000);
    const u = m.translate(CODE);
    const view = new DataView(m.memory.buffer);
    assert.ok(u.translation.labels.has(B), 'B is a block');
    assert.ok(u.translation.cut.has(/** @type {number} */ (u.translation.labels.get(B))),
        'no entry at B');
    assert.deepEqual(u.run(CODE), { kind: 3, vector: 0 });
    assert.equal(view.getUint8(m.layout.x87Top), 6, 'two pushes from the entry');
    assert.equal(view.getUint8(m.layout.x87Empty), 0x3f);
    // A block the tracking does not reach with a known shape (past an
    // instruction left to the emulator) keeps the machine's own top when
    // entered: fbld [m]; jmp C; C: fld1; hlt, entered at C with top 5.
    const n = createTestMachine();
    const C = CODE + 8;
    n.write(CODE, [0xdf, 0x25, ...u32(DATA), 0xeb, 0x00, 0xd9, 0xe8, 0xf4]);
    n.setReg('esp', 0x80000);
    const t = n.translate(CODE);
    const nview = new DataView(n.memory.buffer);
    nview.setUint8(n.layout.x87Top, 5);
    assert.ok(t.translation.labels.has(C), 'C is a block');
    assert.deepEqual(t.run(C), { kind: 0, vector: 0 }, 'leaves before the fld1');
    assert.equal(n.eip(), C);
    assert.equal(nview.getUint8(n.layout.x87Top), 5, 'the top as the machine had it');
});

test('a left-out x87 instruction names why and the shape of its block', ()=>{
    // fbld [m]; jmp C; C: fld1; hlt -- the tracker cannot follow fbld, so C is
    // reached with no known state: its fld1 is left out as `no-known-state`.
    const m = createTestMachine();
    m.write(CODE, [0xdf, 0x25, ...u32(DATA), 0xeb, 0x00, 0xd9, 0xe8, 0xf4]);
    m.setReg('esp', 0x80000);
    const t = m.translate(CODE);
    assert.deepEqual([...t.translation.refusals.keys()],
        ['df 25 (step-null; region-entry; entry-known)',
            'd9 e8 (no-known-state; branch-target; entry-known)'],
        JSON.stringify([...t.translation.refusals.keys()]));
    // fld1; test; jnz B; fldz; B: fld1; hlt -- B is reached with top 7 (the
    // branch) and top 6 (the fall-through): cut for a second top.
    const n = createTestMachine();
    n.write(CODE, [0xd9, 0xe8, 0x85, 0xc0, 0x75, 0x02, 0xd9, 0xee, 0xd9, 0xe8, 0xf4]);
    n.setReg('esp', 0x80000);
    const u = n.translate(CODE);
    assert.deepEqual([...u.translation.refusals.keys()],
        ['d9 e8 (cut-second-top; fall-through+branch-target; entry-known)'],
        JSON.stringify([...u.translation.refusals.keys()]));
});

test('a call return is named and gets no entry of its own', ()=>{
    // fninit; call F (elsewhere); RA: fld dword [esp]; fstp st0; hlt -- the
    // callee decides the stack at RA, so the tracker does not know it: the
    // forms are named and the block is cut, leaving the runtime to compile a
    // region for it at the top the machine has.
    const m = createTestMachine();
    const RA = CODE + 7;
    m.write(CODE, [0xdb, 0xe3, 0xe8, 0x39, 0, 0, 0, 0xd9, 0x04, 0x24, 0xdd, 0xd8, 0xf4]);
    m.setReg('esp', 0x80000);
    const t = m.translate(CODE);
    const label = /** @type {number} */ (t.translation.labels.get(RA));
    assert.ok(t.translation.cut.has(label), 'no entry at the return block');
    assert.deepEqual([...t.translation.refusals.keys()],
        ['d9 04 (no-known-state; call-return; entry-known)'],
        JSON.stringify([...t.translation.refusals.keys()]));
});


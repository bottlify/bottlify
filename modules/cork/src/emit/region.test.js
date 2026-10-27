/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { formRegion, inlineReturns } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { ownLayout } from '../runtime/layout.js';
import {
    Exit, RegionEmitter, deadFlagPass, emitRegion, liveFlagsOut, planStructure, prepareModule,
} from './region.js';

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

test('a left-out x87 instruction names why, and the blocks past it are compiled for a top', ()=>{
    // fbld [m]; jmp C; C: fld1; hlt -- the tracker cannot follow fbld, which
    // is left out as `step-null`; C, reached with no known state, is compiled
    // for a top it tests rather than left out.
    const m = createTestMachine();
    m.write(CODE, [0xdf, 0x25, ...u32(DATA), 0xeb, 0x00, 0xd9, 0xe8, 0xf4]);
    m.setReg('esp', 0x80000);
    const t = m.translate(CODE);
    assert.deepEqual([...t.translation.refusals.keys()],
        ['df 25 (step-null; region-entry; entry-known)'],
        JSON.stringify([...t.translation.refusals.keys()]));
    // fld1; test; jnz B; fldz; B: fld1; hlt -- B is reached with top 7 (the
    // branch) and top 6 (the fall-through): compiled for one of them.
    const n = createTestMachine();
    n.write(CODE, [0xd9, 0xe8, 0x85, 0xc0, 0x75, 0x02, 0xd9, 0xee, 0xd9, 0xe8, 0xf4]);
    n.setReg('esp', 0x80000);
    const u = n.translate(CODE);
    assert.deepEqual([...u.translation.refusals.keys()], [],
        JSON.stringify([...u.translation.refusals.keys()]));
});

test('a join two agreeing predecessors reach takes their state, not a cut', ()=>{
    // The shapes 3d names: an if/else that does no x87 on either arm and a
    // `fld` at the join; a loop head entered from before the loop and from a
    // balanced back edge; a switch whose cases all fall to one join. Each
    // predecessor leaves the same top, so the join is compiled, not refused.
    /** @type {[string, number[], number][]} */
    const shapes = [
        ['if/else join', [
            0xd9, 0xe8, 0x85, 0xc0, 0x74, 0x04, 0x90, 0x90, 0xeb, 0x02, 0x90, 0x90,
            0xd9, 0xe8, 0xf4,
        ], 6],
        ['balanced loop head', [
            0x31, 0xc9, 0xd9, 0xe8, 0xd9, 0xe8, 0xdd, 0xd8, 0x41,
            0x83, 0xf9, 0x03, 0x72, 0xf6, 0xdd, 0xd8, 0xf4,
        ], 0],
        ['switch to one join', [
            0xd9, 0xe8, 0x83, 0xf9, 0x00, 0x74, 0x07, 0x83, 0xf9, 0x01,
            0x74, 0x03, 0xeb, 0x02, 0x90, 0x90, 0x90,
            0xd9, 0x44, 0x24, 0x04, 0xf4,
        ], 6],
    ];
    for (const [name, bytes, top] of shapes)
    {
        const m = createTestMachine();
        m.write(CODE, bytes);
        m.setReg('esp', 0x80000);
        const t = m.translate(CODE);
        assert.deepEqual([...t.translation.refusals.keys()], [],
            `${name}: ${JSON.stringify([...t.translation.refusals.keys()])}`);
        assert.equal(t.run(CODE).kind, Exit.HALT, `${name} ran to its halt`);
        const view = new DataView(m.memory.buffer);
        assert.equal(view.getUint8(m.layout.x87Top), top, `${name}: top after the run`);
    }
});

test('a region formed at a two-top join compiles its entry for its own top', ()=>{
    // The loop head 0x100d is reached by fall-through from the 0x100b `fstp`
    // (one top) and by the branch out of the head 0x1006 (the other): the
    // join is the only place the two tops meet. A region formed there is
    // compiled for the top it was entered at -- the fall-through edge that
    // arrives with the other top leaves -- rather than having its own entry
    // cut and publishing no entry at all.
    // xor ecx, ecx; fld1; fld1
    // 0x1006 L: cmp ecx, 0; jne J; fstp st0
    // 0x100d J: inc ecx; cmp ecx, 3; jb L; fstp st0; fstp st0; hlt
    const J = CODE + 0xd;
    const program = [
        0x31, 0xc9, 0xd9, 0xe8, 0xd9, 0xe8,
        0x83, 0xf9, 0x00, 0x75, 0x02, 0xdd, 0xd8,
        0x41, 0x83, 0xf9, 0x03, 0x72, 0xf3, 0xdd, 0xd8, 0xdd, 0xd8, 0xf4,
    ];
    for (const top of [0, 7])
    {
        const m = createTestMachine();
        m.write(CODE, program);
        m.setReg('esp', 0x80000);
        const t = m.translate(J, { entryTop: top });
        const entryLabel = /** @type {number} */ (t.translation.labels.get(J));
        assert.ok(!t.translation.cut.has(entryLabel),
            `top ${top}: the entry is not cut (${JSON.stringify([...t.translation.cut])})`);
        assert.deepEqual([...t.translation.refusals.keys()], [], `top ${top}`);
        assert.equal(t.run(J).kind, Exit.HALT, `top ${top}: runs from the entry to its halt`);
    }
});

test('a call return is compiled for the top the call is taken to leave, and tests it', ()=>{
    // fninit; call F (elsewhere); RA: fld dword [esp]; fstp st0; hlt -- the
    // callee decides the stack at RA: the block is compiled for the top the
    // call is taken to leave (the call's, since RA pushes before it reads),
    // and the machine's top is tested at its start.
    const m = createTestMachine();
    const RA = CODE + 7;
    m.write(CODE, [0xdb, 0xe3, 0xe8, 0x39, 0, 0, 0, 0xd9, 0x04, 0x24, 0xdd, 0xd8, 0xf4]);
    m.setReg('esp', 0x80000);
    const t = m.translate(CODE);
    assert.deepEqual([...t.translation.refusals.keys()], [],
        JSON.stringify([...t.translation.refusals.keys()]));
    const label = /** @type {number} */ (t.translation.labels.get(RA));
    assert.ok(!t.translation.cut.has(label), 'an entry at the return block, at the entry\'s top');
    const view = new DataView(m.memory.buffer);
    // Entered with the top it was compiled for: it runs to the halt.
    assert.equal(t.run(RA).kind, Exit.HALT);
    assert.equal(view.getUint8(m.layout.x87Top), 0);
    assert.equal(view.getUint8(m.layout.x87Empty), 0xff);
    // With another: it leaves at its start, the stack as it found it.
    view.setUint8(m.layout.x87Top, 5);
    assert.deepEqual(t.run(RA), { kind: Exit.UNTRANSLATED, vector: 0 });
    assert.equal(m.eip(), RA);
    assert.equal(view.getUint8(m.layout.x87Top), 5);
    assert.equal(view.getUint8(m.layout.x87Empty), 0xff);
});


/**
 * mov ecx, 5; L: add eax, 2; cmp eax, 6; jl S; inc edx; S: dec ecx; jnz L; hlt -- a
 * loop of three blocks, its back edge a branch to the loop and its jl one forward.
 */
const LOOP = [0xb9, 5, 0, 0, 0, 0x83, 0xc0, 0x02, 0x83, 0xf8, 0x06, 0x7c, 0x01, 0x42, 0x49,
    0x75, 0xf4, 0xf4];
const HEAD = CODE + 5;
const S = CODE + 0x0e;

test('a loop of several blocks runs as a wasm loop to its halt', ()=>{
    const m = createTestMachine();
    m.write(CODE, LOOP);
    const exit = m.translate(CODE).run(CODE, 1000);
    assert.equal(exit.kind, Exit.HALT);
    assert.equal(m.reg('eax'), 10);
    assert.equal(m.reg('edx'), 3, 'inc edx once eax is 6 or more: at 6, 8 and 10');
    assert.equal(m.reg('ecx'), 0);
    // The mov, two turns of five (the jl taken), three of six, the hlt.
    assert.equal(m.counter(), 1 + 5 + 5 + 6 + 6 + 6 + 1);
});

test('under the flat dispatch a block in the middle of a loop is entered by its label', ()=>{
    const m = createTestMachine({ structure: false });
    m.write(CODE, LOOP);
    m.setReg('ecx', 1);
    const exit = m.translate(CODE).run(S, 1000);
    assert.equal(exit.kind, Exit.HALT);
    assert.equal(m.reg('ecx'), 0);
    assert.equal(m.counter(), 3, 'dec, jnz not taken, hlt');
});

test('a spent budget leaves on the back edge of a loop at its head, and the rest carries on', ()=>{
    const m = createTestMachine();
    m.write(CODE, LOOP);
    const unit = m.translate(CODE);
    const exit = unit.run(CODE, 8);
    assert.equal(exit.kind, Exit.BUDGET);
    assert.equal(m.eip(), HEAD);
    // The mov and two turns of five: the first turn leaves budget, the second spends it.
    assert.equal(m.counter(), 11);
    const rest = unit.run(HEAD, 1000);
    assert.equal(rest.kind, Exit.HALT);
    assert.equal(m.counter(), 30);
    assert.equal(m.reg('eax'), 10);
    assert.equal(m.reg('edx'), 3);
});

test('inc keeps the carry for an adc in the next block', ()=>{
    // stc; jmp +0; inc eax; adc ebx, 0; hlt
    const m = createTestMachine();
    m.write(CODE, [0xf9, 0xeb, 0x00, 0x40, 0x83, 0xd3, 0x00, 0xf4]);
    m.translate(CODE).run(CODE, 1000);
    assert.equal(m.reg('eax'), 1);
    assert.equal(m.reg('ebx'), 1, 'the carry stc set, through the inc');
});

test('a record no later block reads is not folded, with the backward jumps through the dispatch',
    ()=>{
        // mov ecx, 5; L: add eax, 3; stc; jmp M; M: sub ecx, 1; jnz L; hlt -- the sub
        // writes every flag before anything reads one, so neither the stc nor the add
        // before it is computed, and the stc's partial write folds nothing.
        const program = [0xb9, 5, 0, 0, 0, 0x83, 0xc0, 0x03, 0xf9, 0xeb, 0x00,
            0x83, 0xe9, 0x01, 0x75, 0xf5, 0xf4];
        for (const precise of [false, true])
        {
            const m = createTestMachine({ precise });
            m.write(CODE, program);
            const unit = m.translate(CODE);
            assert.equal(unit.translation.folds, 0, `no fold (precise: ${precise})`);
            assert.equal(unit.run(CODE, 1000).kind, Exit.HALT);
            assert.equal(m.reg('eax'), 15);
            assert.equal(m.reg('ecx'), 0);
        }
    });

test('a divide that faults hands over the flags the instruction before it wrote', ()=>{
    // add eax, 1; div ecx; cmp eax, eax; hlt -- the cmp overwrites every flag the add
    // writes, but with ecx zero the divide faults first: the add's flags are the
    // fault's, which the handler reads in the context.
    for (const precise of [false, true])
    {
        const m = createTestMachine({ precise });
        m.write(CODE, [0x83, 0xc0, 0x01, 0xf7, 0xf1, 0x39, 0xc0, 0xf4]);
        m.setReg('eax', 0xffffffff);
        m.setReg('ecx', 0);
        m.setEflags(0x202);
        const exit = m.translate(CODE).run(CODE, 1000);
        assert.equal(exit.kind, Exit.FAULT);
        // 0xffffffff + 1: zero, carry out, auxiliary carry, even parity.
        assert.equal(m.eflags() & 0x8d5, 0x55, `flags (precise: ${precise})`);
    }
});

test('a shift by cl whose flags nothing reads folds no record, whatever the count', ()=>{
    // add ebx, 1; sar eax, cl; shld esi, edi, cl; test al, 2; setz dl; hlt -- the test
    // writes every flag the shifts would (its undefined AF too, outside `precise`), so
    // neither folds the add's record first.
    for (const count of [0, 3])
    {
        const m = createTestMachine({ precise: false });
        m.write(CODE, [0x83, 0xc3, 0x01, 0xd3, 0xf8, 0x0f, 0xa5, 0xfe, 0xa8, 0x02,
            0x0f, 0x94, 0xc2, 0xf4]);
        m.setReg('eax', 0x80000010);
        m.setReg('ecx', count);
        m.setReg('esi', 0x1);
        m.setReg('edi', 0xf0000000);
        const unit = m.translate(CODE);
        assert.equal(unit.translation.folds, 0);
        assert.equal(unit.run(CODE, 1000).kind, Exit.HALT);
        assert.equal(m.reg('eax'), count === 0 ? 0x80000010 : 0xf0000002);
        assert.equal(m.reg('esi'), count === 0 ? 0x1 : 0xf);
        assert.equal(m.reg('edx') & 0xff, count === 0 ? 1 : 0, 'ZF of the test');
    }
});

test('a loop head reads the flags its latch left, and those it is entered with', ()=>{
    // A tree's find: mov eax, DATA; mov edx, key; jmp C; B: mov edi, [eax];
    // cmovae edi, [eax+4]; test edi, edi; mov eax, edi; je out; C: cmp edx, [eax+8];
    // jne B; out: hlt -- the head's cmovae reads the CF of the latch's cmp, the record
    // it expects there; entered at the head from outside, it reads whatever came in.
    const program = [0xb8, ...u32(DATA), 0xba, ...u32(0), 0xeb, 0x0c,
        0x8b, 0x38, 0x0f, 0x43, 0x78, 0x04, 0x85, 0xff, 0x89, 0xf8, 0x74, 0x05,
        0x3b, 0x50, 0x08, 0x75, 0xef, 0xf4];
    const B = CODE + 0x0c;
    /** Nodes of {left, right, key}: 0 is 50 over 1 (20) and 2 (80); 3 (90) right of 2. */
    const nodes = [[1, 2, 50], [-1, -1, 20], [-1, 3, 80], [-1, -1, 90]];
    const machine = ()=>{
        const m = createTestMachine();
        m.write(CODE, program);
        nodes.forEach(([left, right, key], i)=>{
            m.writeU32(DATA + i * 16, left < 0 ? 0 : DATA + left * 16);
            m.writeU32(DATA + i * 16 + 4, right < 0 ? 0 : DATA + right * 16);
            m.writeU32(DATA + i * 16 + 8, key);
        });
        return m;
    };
    for (const [key, found] of [[50, 0], [20, 1], [90, 3], [85, -1], [10, -1]])
    {
        const m = machine();
        m.write(CODE + 6, u32(key));
        assert.equal(m.translate(CODE).run(CODE, 1000).kind, Exit.HALT);
        assert.equal(m.reg('eax'), found < 0 ? 0 : DATA + found * 16, `key ${key}`);
    }
    for (const carry of [0, 1])
    {
        // At the head from outside, with CF in the flags word: left when set, right when not.
        const m = machine();
        m.setReg('eax', DATA);
        m.setReg('edx', 20);
        m.setEflags(2 | carry);
        m.translate(CODE).run(B, 3);
        assert.equal(m.reg('edi'), DATA + (carry ? 1 : 2) * 16, `entered with CF ${carry}`);
    }
});

test('the count is what a run took off its budget: across transfers, a host call and a budget',
    ()=>{
        // CODE: mov ecx, 4; L: mov eax, 0x2000; jmp eax -- at 0x2000: mov dx, PORT; out dx, eax;
        // dec ecx; jz D; mov eax, L; jmp eax; D: hlt. Three regions, which transfer to each
        // other through the hash; the out calls the host from inside the one at 0x2000.
        const PORT = 0xb077;
        const L = CODE + 5;
        const far = [0x66, 0xba, PORT & 0xff, PORT >> 8, 0xef, 0x49, 0x74, 0x07,
            0xb8, ...u32(L), 0xff, 0xe0, 0xf4];
        for (const budget of [1_000_000, 1, 3, 6, 7, 13, 20])
        {
            /** @type {number[]} */
            const seen = [];
            const m = createTestMachine({ trapPort: PORT, trap: ()=>{
                seen.push(m.counter());
                return 0;
            } });
            m.write(CODE, [0xb9, ...u32(4), 0xb8, ...u32(0x2000), 0xff, 0xe0]);
            m.write(0x2000, far);
            m.setReg('esp', 0x80000);
            let eip = CODE;
            let total = 0;
            let exit = null;
            for (let runs = 0; runs < 100; runs++)
            {
                const before = m.counter();
                exit = m.runProgram(eip, { budget });
                assert.equal(m.counter() - before, exit.retired, `budget ${budget}`);
                total += exit.retired;
                eip = m.eip();
                if (exit.kind === Exit.HALT)
                {
                    break;
                }
            }
            assert.equal(exit?.kind, Exit.HALT, `budget ${budget}`);
            // 1 + three turns of 8 + a last one of 6 + the hlt; the host sees the count at
            // each out, the out itself charged.
            assert.equal(total, 32, `budget ${budget}`);
            assert.deepEqual(seen, [5, 13, 21, 29], `budget ${budget}`);
        }
    });

test('a spent budget is looked at on the next jump back: a run goes past it by one pass at most',
    ()=>{
        // mov ecx, 3; L: inc eax, fifty times; dec ecx; jnz L; hlt -- whatever the budget
        // left, the body runs to its jump back before the run leaves, at the loop's head.
        const program = [0xb9, 3, 0, 0, 0, ...new Array(50).fill(0x40), 0x49, 0x75, 0xcb, 0xf4];
        // The mov and whole turns of 52, as many as it takes to spend the budget.
        for (const [budget, retired] of [[1, 53], [2, 53], [53, 53], [54, 105], [105, 105]])
        {
            const m = createTestMachine();
            m.write(CODE, program);
            const exit = m.translate(CODE).run(CODE, budget);
            assert.equal(exit.kind, Exit.BUDGET, `budget ${budget}`);
            assert.equal(m.eip(), CODE + 5, `budget ${budget}: at the head`);
            assert.equal(m.counter(), retired, `budget ${budget}`);
        }
        const m = createTestMachine();
        m.write(CODE, program);
        assert.equal(m.translate(CODE).run(CODE, 1_000_000).kind, Exit.HALT);
        assert.equal(m.counter(), 1 + 3 * 52 + 1);
    });

test('a spent budget on a jump back leaves the flags its target reads', ()=>{
    // mov ecx, 6; clc; H: jnc S; add eax, 100; S: add eax, 1; cmp ecx, 4; dec ecx;
    // jnz H; hlt -- the head reads the CF the cmp left through the dec, across the
    // jump back, which leaves there whenever the budget is spent.
    const program = [0xb9, 6, 0, 0, 0, 0xf8, 0x73, 0x03, 0x83, 0xc0, 0x64, 0x83, 0xc0, 0x01,
        0x83, 0xf9, 0x04, 0x49, 0x75, 0xf2, 0xf4];
    for (const precise of [false, true])
    {
        for (let budget = 1; budget <= 30; budget++)
        {
            const m = createTestMachine({ precise });
            m.write(CODE, program);
            const unit = m.translate(CODE);
            let exit = unit.run(CODE, budget);
            for (let runs = 0; exit.kind === Exit.BUDGET && runs < 100; runs++)
            {
                exit = unit.run(m.eip(), budget);
            }
            assert.equal(exit.kind, Exit.HALT);
            assert.equal(m.reg('eax'), 206, `budget ${budget} (precise: ${precise})`);
            assert.equal(m.counter(), 35);
        }
    }
});

test('the fast default leaves an undefined flag as the cheapest code does, and every defined one',
    ()=>{
        // An FNV-1a loop: L: inc edx; xor ecx, eax; movzx eax, byte [edx];
        // imul ecx, ecx, 0x1000193; test al, al; jnz L; hlt. The imul leaves SF, ZF, AF
        // and PF undefined and the test does not define AF: exactly, the xor's record
        // stays alive through both and the imul folds it every turn; in the fast default
        // nothing reads a flag the two define, and no record is folded.
        const loop = [0xba, ...u32(DATA - 1), 0xb9, ...u32(0x811c9dc5), 0x31, 0xc0,
            0x42, 0x31, 0xc1, 0x0f, 0xb6, 0x02, 0x69, 0xc9, ...u32(0x1000193), 0x84, 0xc0,
            0x75, 0xf0, 0xf4];
        /** @param {boolean} precise */
        const hashOf = precise=>{
            const m = createTestMachine({ precise });
            m.write(CODE, loop);
            m.write(DATA, [...'textures/wall_7919'].map(c=>c.charCodeAt(0)).concat([0]));
            const unit = m.translate(CODE);
            assert.equal(unit.run(CODE, 10_000).kind, Exit.HALT);
            // test al, al of a zero: ZF and PF set, CF, OF and SF clear.
            assert.equal(m.eflags() & 0x8c5, 0x44,
                `the flags the test defines (precise: ${precise})`);
            return { hash: m.reg('ecx'), folds: unit.translation.folds };
        };
        const fast = hashOf(false);
        const exact = hashOf(true);
        assert.equal(fast.hash, exact.hash);
        assert.equal(fast.folds, 0);
        assert.ok(exact.folds > 0, 'the precise loop folds the xor for the imul');

        // cmp eax, eax; bt ebx, 0; setz cl; mov eax, 0x40000000; imul eax, eax, 4;
        // seto dl; setc dh; hlt -- bt leaves ZF alone and defines CF, imul defines CF
        // and OF: the fast default keeps all three.
        const m = createTestMachine();
        m.write(CODE, [0x39, 0xc0, 0x0f, 0xa3, 0xc3, 0x0f, 0x94, 0xc1,
            0xb8, ...u32(0x40000000), 0x6b, 0xc0, 0x04, 0x0f, 0x90, 0xc2, 0x0f, 0x92, 0xc6, 0xf4]);
        m.setReg('ebx', 0);
        assert.equal(m.translate(CODE).run(CODE, 1000).kind, Exit.HALT);
        assert.equal(m.reg('ecx') & 0xff, 1, 'ZF of the cmp, through the bt');
        assert.equal(m.reg('edx') & 0xffff, 0x0101, 'OF and CF of the imul');

        // imul eax, eax, 3; pushf; pop edx; hlt -- the pushf reads the flags the imul
        // left undefined, which the translation counts outside `precise`.
        for (const precise of [false, true])
        {
            const n = createTestMachine({ precise });
            n.write(CODE, [0x6b, 0xc0, 0x03, 0x9c, 0x5a, 0xf4]);
            n.setReg('esp', 0x80000);
            const unit = n.translate(CODE);
            assert.deepEqual([...unit.translation.relaxedReads.keys()], precise ? [] : ['9c']);
        }
    });

/**
 * The opcode at each branch a module's branch-hint section names, in its one
 * defined function's body.
 *
 * @param {Uint8Array} bytes
 */
function hintedOpcodes(bytes){
    let at = 8;
    const leb = ()=>{
        let value = 0;
        for (let shift = 0; ; shift += 7)
        {
            const byte = bytes[at++];
            value |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0)
            {
                return value >>> 0;
            }
        }
    };
    /** @type {number[]} */
    let offsets = [];
    /** @type {Uint8Array} */
    let body = new Uint8Array(0);
    while (at < bytes.length)
    {
        const id = bytes[at++];
        const size = leb();
        const end = at + size;
        if (id === 0)
        {
            const length = leb();
            const title = new TextDecoder().decode(bytes.subarray(at, at + length));
            at += length;
            if (title === 'metadata.code.branch_hint')
            {
                leb(); // one function
                leb(); // its index
                offsets = Array.from({ length: leb() }, ()=>{
                    const offset = leb();
                    at += 2; // size 1, the hint
                    return offset;
                });
            }
        }
        else if (id === 10)
        {
            leb(); // one function
            const length = leb();
            body = bytes.subarray(at, at + length);
        }
        at = end;
    }
    return offsets.map(offset=>body[offset]);
}

test('the ways out a loop rarely takes are branches hinted unlikely', ()=>{
    // mov ecx, 1000; L: add eax, [DATA]; dec ecx; jnz L; hlt -- the page test of the
    // load, the budget on the back edge: every hint names an `if` or a `br_if`.
    const m = createTestMachine();
    m.write(CODE, [0xb9, ...u32(1000), 0x03, 0x05, ...u32(DATA), 0x49, 0x75, 0xf7, 0xf4]);
    m.writeU32(DATA, 3);
    const unit = m.translate(CODE);
    const opcodes = hintedOpcodes(unit.bytes);
    assert.ok(opcodes.length >= 2, `hinted: ${opcodes.length}`);
    assert.ok(opcodes.every(opcode=>opcode === 0x04 || opcode === 0x0d),
        opcodes.map(opcode=>opcode.toString(16)).join(' '));
    assert.equal(unit.run(CODE, 1_000_000).kind, Exit.HALT);
    assert.equal(m.reg('eax'), 3000);
});

test('the flag liveness over a region is the walk of every instruction to a fixed point', ()=>{
    // Each block's kills and early reads are taken once; the answer is the one a
    // walk of every instruction on every round gives, `deadFlagPass`'s own: with
    // a nop put first, what it finds live after that nop is the block's live-in.
    const nop = { op: 'nop', operands: [], flagsWritten: 0, flagsUndefined: 0, flagsRead: 0 };
    /** @param {import('../region.js').Block[]} blocks @param {boolean} precise */
    const walked = (blocks, precise)=>{
        const labels = new Map(blocks.map((block, i)=>[block.start, i]));
        const liveIn = blocks.map(()=>0);
        const out = blocks.map(()=>0);
        for (let changed = true; changed;)
        {
            changed = false;
            for (let i = blocks.length - 1; i >= 0; i--)
            {
                const { kind, targets, next } = blocks[i].exit;
                const edges = kind === 'jump' ? targets
                    : ['jcc', 'loop', 'fallthrough'].includes(kind) ? [...targets, next] : null;
                // A way out of the region reads every arithmetic flag and DF.
                out[i] = edges === null || edges.some(t=>!labels.has(t)) ? 0xcd5
                    : edges.reduce((f, t)=>f | liveIn[/** @type {number} */ (labels.get(t))], 0);
                /** @type {number[]} */
                const after = [];
                deadFlagPass(/** @type {any} */ ({ ...blocks[i],
                    instructions: [nop, ...blocks[i].instructions] }), out[i], after, precise);
                if (after[0] !== liveIn[i])
                {
                    liveIn[i] = after[0];
                    changed = true;
                }
            }
        }
        return out;
    };
    const hash = [0xba, ...u32(DATA - 1), 0xb9, ...u32(0x811c9dc5), 0x31, 0xc0, 0x42, 0x31, 0xc1,
        0x0f, 0xb6, 0x02, 0x69, 0xc9, ...u32(0x1000193), 0x84, 0xc0, 0x75, 0xf0, 0xf4];
    for (const program of [LOOP, hash])
    {
        const m = createTestMachine();
        m.write(CODE, program);
        const { region } = m.translate(CODE);
        const labels = new Map(region.blocks.map((block, i)=>[block.start, i]));
        for (const precise of [false, true])
        {
            assert.deepEqual(liveFlagsOut(region.blocks, labels, precise),
                walked(region.blocks, precise));
        }
    }
});

/**
 * A hand-made block: its start and its exit, which is all the structure reads.
 * @param {number} start @param {string} kind @param {number[]} targets @param {number} next
 * @param {object} [more]
 */
const shaped = (start, kind, targets, next, more = {})=>/** @type {any} */ ({
    start, end: start + 1, instructions: [],
    exit: { kind, targets, next, backEdge: false, ...more },
});
/** @param {any[]} blocks */
const regionOf = blocks=>/** @type {import('../region.js').Region} */ (/** @type {any} */ (
    { entry: blocks[0].start, blocks }));

test('a loop is the control flow\'s, not the layout\'s: cases laid after the latch are in it', ()=>{
    // 0: the head's switch to 3 or 4; 1: the latch, back to 0; 2: hlt; 3, 4: cases, each a
    // jump back to the latch -- as address ranges, a loop [1, 4] across [0, 1].
    const { order, loops } = planStructure(regionOf([
        shaped(0, 'indirect', [3, 4], 1, { table: { index: 0, address: 0x100, entries: [3, 4] } }),
        shaped(1, 'jcc', [0, 2], 2), shaped(2, 'hlt', [], 3), shaped(3, 'jump', [1], 4),
        shaped(4, 'jump', [1], 5)]), new Map());
    assert.deepEqual(order, [0, 3, 4, 1, 2], 'the cases before the latch they go on to');
    assert.deepEqual([...loops], [[0, 3]], 'one loop, from the head to the latch');
});

test('a loop entered at its test at the bottom has the test for its head', ()=>{
    // 0: jump 2; 1: the body; 2: jcc 1 else 3; 3: hlt
    const { order, loops } = planStructure(regionOf([shaped(0, 'jump', [2], 1),
        shaped(1, 'fallthrough', [2], 2), shaped(2, 'jcc', [1, 3], 3), shaped(3, 'hlt', [], 4)]),
    new Map());
    assert.deepEqual(order, [0, 2, 1, 3]);
    assert.deepEqual([...loops], [[1, 2]]);
});

test('a loop a call leaves from is entered in its middle by the return, and is no wasm loop', ()=>{
    // 0: jcc 2 else 1; 1: call out, back at 2; 2: jcc 0 else 3; 3: hlt
    const blocks = [shaped(0, 'jcc', [2, 1], 1), shaped(1, 'call', [0x9000], 2),
        shaped(2, 'jcc', [0, 3], 3), shaped(3, 'hlt', [], 4)];
    assert.deepEqual([...planStructure(regionOf(blocks), new Map()).loops], []);
    // Formed in, the callee's return is a jump: the loop is the head's.
    blocks[1] = shaped(1, 'call', [4], 2);
    blocks.push(shaped(4, 'ret', [], 5));
    const { loops } = planStructure(regionOf(blocks), new Map([[4, [2]]]));
    assert.equal(loops.size, 1);
});

test('with callReturn a call whose callee is formed in adds no way on: a region no call leaves'
    + ' has the structure it has without', ()=>{
    // An edge from such a call to its return address made the callee's first block a
    // block inside a loop, with no entry: every caller from another region missed there,
    // and the region was formed again with copies of its loops.
    const images = new URL('../../../../tools/cork-bench/images/', import.meta.url);
    const base = 0x401000;
    let compared = 0;
    for (const name of readdirSync(images).filter(file=>file.endsWith('.bin')).sort())
    {
        const image = readFileSync(new URL(name, images));
        const read = (/** @type {number} */ address)=>image[address - base] ?? 0;
        // Every direct call's target in the image.
        const starts = new Set([base]);
        for (let i = 0; i + 5 <= image.length; i++)
        {
            const target = base + i + 5 + image.readInt32LE(i + 1);
            if (image[i] === 0xe8 && target >= base && target < base + image.length)
            {
                starts.add(target);
            }
        }
        for (const start of starts)
        {
            const region = formRegion(read, start, {});
            const blocks = new Set(region.blocks.map(block=>block.start));
            const calls = region.blocks.filter(block=>block.exit.kind === 'call'
                || block.exit.kind === 'indirect');
            if (calls.length === 0 || calls.some(block=>!blocks.has(block.exit.targets[0])))
            {
                continue;
            }
            const returns = inlineReturns(region);
            const plain = planStructure(region, returns);
            const called = planStructure(region, returns, true);
            assert.deepEqual([called.order, [...called.loops], called.reentered],
                [plain.order, [...plain.loops], plain.reentered],
                `${name} at ${start.toString(16)}`);
            compared++;
        }
    }
    assert.ok(compared >= 5, `${compared} regions whose every call is formed in`);
});

test('a region formed in the middle of a loop has the loop the code has, its entry inside it', ()=>{
    // 0: jump 3 (the outer loop's way into the inner one's test); 1: the entry, falling
    // into 2; 2: jcc 5 else 3; 3: the inner test, jcc 1 else 4; 4: jump 2; 5: jcc 0 else 6;
    // 6: ret. From 1, a loop at 1 around one at 2, both of one loop of the code.
    const blocks = [shaped(0, 'jump', [3], 1), shaped(1, 'fallthrough', [2], 2),
        shaped(2, 'jcc', [5, 3], 3), shaped(3, 'jcc', [1, 4], 4), shaped(4, 'jump', [2], 5),
        shaped(5, 'jcc', [0, 6], 6), shaped(6, 'ret', [], 7)];
    const region = /** @type {import('../region.js').Region} */ (/** @type {any} */ (
        { entry: 1, blocks }));
    const { order, loops } = planStructure(region, new Map());
    assert.deepEqual(order, [2, 5, 0, 3, 4, 1, 6]);
    assert.deepEqual([...loops], [[0, 5]], 'one loop, the entry a block of it');
});

/**
 * mov ecx, 3; O: mov edx, 4; I: add eax, 1; test al, 1; jz K; add ebx, 1; K: dec edx;
 * jnz I; dec ecx; jnz O; hlt -- a loop of three blocks inside another.
 */
const NESTED = [0xb9, 3, 0, 0, 0, 0xba, 4, 0, 0, 0, 0x83, 0xc0, 0x01, 0xa8, 0x01, 0x74, 0x03,
    0x83, 0xc3, 0x01, 0x4a, 0x75, 0xf3, 0x49, 0x75, 0xeb, 0xf4];

test('a structured region runs its nested loops to the end from any budget, each resumed where'
    + ' it was left', ()=>{
    for (let budget = 1; budget <= 80; budget++)
    {
        const m = createTestMachine({ structure: true });
        m.write(CODE, NESTED);
        const unit = m.translate(CODE);
        let exit = unit.run(CODE, budget);
        for (let runs = 0; exit.kind === Exit.BUDGET && runs < 200; runs++)
        {
            exit = unit.run(m.eip(), budget);
        }
        assert.equal(exit.kind, Exit.HALT, `budget ${budget}`);
        assert.deepEqual([m.reg('eax'), m.reg('ebx'), m.reg('ecx'), m.reg('edx')], [12, 6, 0, 0],
            `budget ${budget}`);
        // mov ecx; three turns of mov edx, four inner turns (two of six, two of five),
        // dec ecx and jnz; hlt.
        assert.equal(m.counter(), 1 + 3 * (1 + 22 + 2) + 1, `budget ${budget}`);
    }
});

test('a block inside a loop is entered by its copy, which goes on into the loop at its head',
    ()=>{
        const m = createTestMachine({ structure: true });
        m.write(CODE, LOOP);
        // The copy leaves at the head through the entry hash, as any transfer does.
        const unit = m.translate(CODE, { hash: true });
        const count = unit.region.blocks.length;
        assert.ok(/** @type {number} */ (unit.translation.labels.get(S)) >= 2 * count,
            'the copy\'s label');
        assert.ok(/** @type {number} */ (unit.translation.labels.get(HEAD)) < count,
            'the head\'s own');
        // From S with ecx 3: dec, jnz; add, cmp, jl taken; twice; then dec, jnz not taken, hlt.
        m.setReg('ecx', 3);
        assert.equal(unit.run(S, 1000).kind, Exit.HALT);
        assert.deepEqual([m.reg('eax'), m.reg('ecx'), m.reg('edx')], [4, 0, 0]);
        assert.equal(m.counter(), 2 + 3 + 2 + 3 + 2 + 1);
    });

test('without its copies, a block inside a loop has no entry, and the region runs the same', ()=>{
    const m = createTestMachine({ structure: true });
    m.write(CODE, LOOP);
    const unit = m.translate(CODE, { copies: false });
    assert.equal(unit.translation.copiesIndex, -1, 'no function of copies');
    assert.deepEqual([...unit.translation.closed].sort(), [CODE + 0x0d, S]);
    assert.ok(unit.translation.cut.has(/** @type {number} */ (unit.translation.labels.get(S))));
    assert.ok(!unit.translation.cut.has(/** @type {number} */ (unit.translation.labels.get(HEAD))));
    assert.equal(unit.run(CODE, 1000).kind, Exit.HALT);
    assert.deepEqual([m.reg('eax'), m.reg('ecx'), m.reg('edx')], [10, 0, 3]);
});

test('a loop onto itself inside another loop has an entry, through the head around it', ()=>{
    // mov ecx, 3; O: mov edx, 4; I: add eax, 1; dec edx; jnz I; dec ecx; jnz O; hlt
    const SELF = [0xb9, 3, 0, 0, 0, 0xba, 4, 0, 0, 0, 0x83, 0xc0, 0x01, 0x4a, 0x75, 0xfa,
        0x49, 0x75, 0xf2, 0xf4];
    const I = CODE + 10;
    const region = regionOf([
        shaped(CODE, 'fallthrough', [CODE + 5], CODE + 5),
        shaped(CODE + 5, 'fallthrough', [I], I),
        shaped(I, 'jcc', [I, CODE + 16], CODE + 16),
        shaped(CODE + 16, 'jcc', [CODE + 5, CODE + 19], CODE + 19),
        shaped(CODE + 19, 'hlt', [], CODE + 20),
    ]);
    const { order, loops } = planStructure(region, new Map());
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
    assert.deepEqual([...loops].sort((a, b)=>a[0] - b[0]), [[1, 3], [2, 2]]);
    const m = createTestMachine({ structure: true });
    m.write(CODE, SELF);
    const unit = m.translate(CODE, { copies: false });
    assert.deepEqual([...unit.translation.closed], [CODE + 16], 'only the outer loop\'s latch');
    // Entered in its second outer turn, with two inner turns left.
    m.setReg('ecx', 2);
    m.setReg('edx', 2);
    assert.equal(unit.run(I, 1000).kind, Exit.HALT);
    assert.deepEqual([m.reg('eax'), m.reg('ecx'), m.reg('edx')], [6, 0, 0]);
});

test('the function of a region\'s copies, planned from the region\'s own planning, is the one'
    + ' planned afresh', ()=>{
    const layout = ownLayout({ ramSize: 1 << 22, hashSlots: 1 << 16 });
    const features = { simd: true, tailCalls: true, defaultNaNNegative: false };
    // mov ecx, 5; L: fld1; fstp st0; test cl, 1; jz S; inc edx; S: dec ecx; jnz L; hlt
    const X87_LOOP = [0xb9, 5, 0, 0, 0, 0xd9, 0xe8, 0xdd, 0xd8, 0xf6, 0xc1, 0x01, 0x74, 0x01,
        0x42, 0x49, 0x75, 0xf3, 0xf4];
    for (const program of [LOOP, NESTED, X87_LOOP])
    {
        const region = formRegion(address=>program[address - CODE] ?? 0xf4, CODE);
        /** @param {(context: ReturnType<typeof prepareModule>) => number} emit */
        const functionOf = emit=>{
            const m = new ModuleBuilder();
            const index = emit(prepareModule(m, layout, features, {},
                { hash: true, resume: true }));
            const { locals, body, hints } = m.functions[index - m.importedFunctions];
            return { locals, body: [...body], hints };
        };
        const shared = functionOf(context=>emitRegion(context, region,
            { entryTop: 0, checked: false }).copiesIndex);
        const fresh = functionOf(context=>new RegionEmitter(context, region,
            { entryTop: 0, checked: false, copyFunction: true }).emit().functionIndex);
        assert.ok(fresh.body.length > 0);
        assert.deepEqual(shared, fresh, `the copies of ${program.length} bytes of code`);
    }
});

test('a nested loop\'s head is entered through the head of the loop around it', ()=>{
    const I = CODE + 10;
    const m = createTestMachine({ structure: true });
    m.write(CODE, NESTED);
    m.setReg('ecx', 2);
    m.setReg('edx', 3);
    const unit = m.translate(CODE);
    assert.ok(/** @type {number} */ (unit.translation.labels.get(I)) < unit.region.blocks.length);
    assert.equal(unit.run(I, 1000).kind, Exit.HALT);
    // Three inner turns, then one more outer turn of four.
    assert.deepEqual([m.reg('eax'), m.reg('ecx'), m.reg('edx')], [7, 0, 0]);
});

test('every block start of a structured region runs as the flat dispatch runs it', ()=>{
    // mov ecx, 4; L: call F; dec ecx; jnz L; hlt; F: add eax, 3; ret -- a formed-in callee
    // whose return jumps back into the loop.
    const CALLS = [0xb9, 4, 0, 0, 0, 0xe8, 4, 0, 0, 0, 0x49, 0x75, 0xf8, 0xf4, 0x83, 0xc0, 0x03,
        0xc3];
    // mov ecx, 3; O: mov edx, 4; jmp T; B: add eax, 1; test al, 1; jz K; add ebx, 1;
    // K: dec edx; T: test edx, edx; jnz B; dec ecx; jnz O; hlt -- an inner loop entered at
    // its test, which a region formed at B sees begin at B.
    const BOTTOM = [0xb9, 3, 0, 0, 0, 0xba, 4, 0, 0, 0, 0xeb, 0x0b, 0x83, 0xc0, 0x01, 0xa8, 0x01,
        0x74, 0x03, 0x83, 0xc3, 0x01, 0x4a, 0x85, 0xd2, 0x75, 0xf1, 0x49, 0x75, 0xe7, 0xf4];
    for (const program of [LOOP, NESTED, CALLS, BOTTOM])
    {
        const machine = createTestMachine();
        machine.write(CODE, program);
        const starts = machine.translate(CODE).region.blocks.map(block=>block.start);
        // Each region formed at a block start, entered at each of its own.
        for (const entry of starts)
        {
            for (const start of starts)
            {
                /** @type {number[][]} */
                const ends = [];
                for (const structure of [true, false])
                {
                    const m = createTestMachine({ structure });
                    m.write(CODE, program);
                    // A return with nothing called comes back to the hlt of CALLS.
                    m.setReg('esp', 0x80000);
                    m.writeU32(0x80000, CODE + 0x0d);
                    m.setReg('ecx', 2);
                    m.setReg('edx', 1);
                    const unit = m.translate(entry, { hash: true });
                    if (!unit.translation.labels.has(start))
                    {
                        break;
                    }
                    const exit = unit.run(start, 10_000);
                    ends.push([exit.kind, m.eip(), m.counter(),
                        ...['eax', 'ecx', 'edx', 'ebx', 'esp'].map(name=>m.reg(name))]);
                }
                assert.deepEqual(ends[0], ends[1], `${program.length}-byte program, region at `
                    + `${entry.toString(16)}, from ${start.toString(16)}`);
            }
        }
    }
});

test('a call made as a wasm call has its rare ways out hinted unlikely', ()=>{
    // mov ecx, 5; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret -- with callReturn the
    // call leaves only past the depth of waiting calls or on a spent budget, and goes up
    // only when the callee left for the host: both ways hinted, beside the loop's own.
    const layout = ownLayout({ ramSize: 1 << 22, hashSlots: 1 << 16 });
    const features = { simd: true, tailCalls: true, defaultNaNNegative: false };
    const program = [0xb9, 5, 0, 0, 0, 0xe8, 0x04, 0, 0, 0, 0x49, 0x75, 0xf8, 0xf4, 0x42, 0xc3];
    const region = formRegion(address=>program[address - CODE] ?? 0xf4, CODE, { leafCalls: false });
    /** @param {boolean} callReturn */
    const hinted = callReturn=>{
        const m = new ModuleBuilder();
        const index = emitRegion(prepareModule(m, layout, features, {},
            { hash: true, callReturn }), region, { entryTop: 0, checked: false }).functionIndex;
        const { body, hints } = m.functions[index - m.importedFunctions];
        assert.ok(hints.every(at=>body[at] === 0x04 || body[at] === 0x0d), 'every hint an if');
        return hints.length;
    };
    assert.ok(hinted(true) >= hinted(false) + 2, `${hinted(true)} hints, ${hinted(false)} without`);
});

test('a 64-bit state block without a flag record or SIMD is refused, not run as 32-bit', ()=>{
    const host = { simd: true, tailCalls: true, defaultNaNNegative: false };
    const layout = ownLayout({ ramSize: 1 << 24, bits: 64 });
    assert.throws(()=>prepareModule(new ModuleBuilder(), { ...layout, flagRecord: -1 }, host, {}),
        /needs a flag record/);
    assert.throws(()=>prepareModule(new ModuleBuilder(), layout, { ...host, simd: false }, {}),
        /needs a flag record and SIMD/);
    prepareModule(new ModuleBuilder(), layout, host, {});
});

test('a region writes back as MMX only the mm registers the path it ran wrote', ()=>{
    // test eax, eax; jz L; movq mm1, mm0; L: hlt -- with eax zero the movq is
    // jumped over: register 1 keeps its x87 view, the mark of the exact quadword
    // a fild left there included; with eax one the movq writes it as MMX.
    for (const eax of [0, 1])
    {
        const m = createTestMachine();
        m.write(CODE, [0x85, 0xc0, 0x74, 0x03, 0x0f, 0x6f, 0xc8, 0xf4]);
        m.setReg('eax', eax);
        const exact = /** @type {number} */ (m.layout.x87Exact);
        new Uint8Array(m.memory.buffer)[exact] = 0b10;
        assert.equal(m.translate(CODE).run(CODE, 1000).kind, Exit.HALT);
        assert.equal(new Uint8Array(m.memory.buffer)[exact], eax === 0 ? 0b10 : 0,
            `exact marks with eax ${eax}`);
    }
});

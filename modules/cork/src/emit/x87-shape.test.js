/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87 stack's shape tested at a region's entries (`planStack`): a region
 * entered with its registers held and empty as its blocks need runs with no
 * stack-fault check inside; one entered otherwise leaves before the block for
 * the host, whose interpreter raises the fault the checked translation would;
 * and a region whose entry keeps finding another shape is translated again
 * checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { blockState, interpret } from '../interp.js';
import { createCorkRuntime } from '../runtime/runtime.js';
import { Tables, ownLayout, pagesFor } from '../runtime/layout.js';
import { Exit } from './region.js';
import { SHAPE } from './x87.js';

const CODE = 0x1000;
const DATA = 0x2000;
const IE = 0x1;
const SF = 0x40;
const C1 = 0x200;

/** @param {number} a */
const at = a=>[a & 255, a >> 8 & 255, 0, 0];

/**
 * mov ecx, turns; fld dword [DATA]; L: fld dword [DATA+4]; fmul st0, st1;
 * fstp dword [DATA+8]; dec ecx; jnz L; fstp st0; hlt -- a loop over a value
 * the block before it pushed, the shape compiled code has.
 *
 * @param {number} turns
 */
const loop = turns=>[0xb9, turns, 0, 0, 0, 0xd9, 0x05, ...at(DATA), 0xd9, 0x05, ...at(DATA + 4),
    0xd8, 0xc9, 0xd9, 0x1d, ...at(DATA + 8), 0x49, 0x75, 0xef, 0xdd, 0xd8, 0xf4];
// fld1; fadd st0, st2; fstp dword [DATA+8]; hlt -- reads a register nothing pushed.
const UNDERFLOW = [0xd9, 0xe8, 0xd8, 0xc2, 0xd9, 0x1d, ...at(DATA + 8), 0xf4];

/**
 * A machine with the program, 1.5 and 3 at DATA, and the x87 stack's words as given.
 *
 * @param {number[]} code @param {{ empty?: number, status?: number }} [x87]
 */
function machine(code, { empty = 0xff, status = 0 } = {}){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, empty);
    view.setUint16(m.layout.x87Status, status, true);
    view.setFloat32(m.layout.ramBase + DATA, 1.5, true);
    view.setFloat32(m.layout.ramBase + DATA + 4, 3, true);
    m.write(CODE, code);
    m.setReg('esp', 0x80000);
    view.setUint32(m.layout.eip, CODE, true);
    return m;
}

/** What a program can read of the machine afterwards. @param {ReturnType<typeof machine>} m */
function outcome(m){
    const view = new DataView(m.memory.buffer);
    return {
        eip: m.eip(), ecx: m.reg('ecx'),
        top: view.getUint8(m.layout.x87Top), empty: view.getUint8(m.layout.x87Empty),
        status: view.getUint16(m.layout.x87Status, true),
        registers: Array.from({ length: 8 }, (_, k)=>view.getFloat64(m.layout.x87 + k * 16, true)),
        stored: view.getFloat32(m.layout.ramBase + DATA + 8, true),
    };
}

/**
 * Runs the translation from CODE to its halt; with `speculate`, a `SHAPE`
 * exit hands the rest to the interpreter, as the host does.
 *
 * @param {ReturnType<typeof machine>} m @param {boolean} speculate
 */
function runHost(m, speculate){
    const unit = m.translate(CODE, { speculate });
    const before = m.counter();
    const exit = unit.run(CODE);
    const left = { exit, retired: m.counter() - before };
    if (exit.kind === Exit.UNTRANSLATED && exit.vector === SHAPE)
    {
        const state = blockState({ memory: m.memory, layout: m.layout });
        state.syncIn();
        state.eip = m.eip();
        interpret(state, 1000);
        state.syncOut();
    }
    return { ...left, unit };
}

test('a region entered in the shape its blocks need runs with no stack-fault check', ()=>{
    const speculative = machine(loop(5), { status: C1 });
    const { exit, unit } = runHost(speculative, true);
    assert.equal(exit.kind, Exit.HALT);
    assert.equal(unit.translation.x87Guards, 0,
        'the entry tests the empty registers the pushes take once, and nothing is checked after');
    const checked = machine(loop(5), { status: C1 });
    const other = runHost(checked, false);
    assert.equal(other.exit.kind, Exit.HALT);
    assert.ok(other.unit.translation.x87Guards > 0,
        'the checked translation checks the loop\'s push');
    assert.deepEqual(outcome(speculative), outcome(checked));
    const { status, stored, empty } = outcome(speculative);
    assert.equal(status & (IE | SF | C1), 0, 'no fault, and the first push cleared C1');
    assert.equal(stored, 4.5);
    assert.equal(empty, 0xff);
});

test('an entry that finds a register held where its block pushes leaves for the host, whose'
    + ' interpreter raises the overflow as the checked translation does', ()=>{
    // Register 6 held: the loop's push overflows on its one turn.
    const speculative = machine(loop(1), { empty: 0xff & ~0x40 });
    const { exit, retired } = runHost(speculative, true);
    assert.equal(exit.kind, Exit.UNTRANSLATED);
    assert.equal(exit.vector, SHAPE);
    assert.equal(retired, 0, 'before the block, nothing run');
    const checked = machine(loop(1), { empty: 0xff & ~0x40 });
    assert.equal(runHost(checked, false).exit.kind, Exit.HALT);
    const after = outcome(speculative);
    assert.deepEqual(after, outcome(checked));
    assert.equal(after.status & (IE | SF | C1), IE | SF | C1, 'a stack overflow');
    assert.equal(after.eip, CODE + loop(1).length);
});

test('an entry that finds a register empty where its block reads leaves for the host, whose'
    + ' interpreter raises the underflow as the checked translation does', ()=>{
    const speculative = machine(UNDERFLOW, { status: C1 });
    const { exit, retired } = runHost(speculative, true);
    assert.equal(exit.vector, SHAPE);
    assert.equal(retired, 0);
    const checked = machine(UNDERFLOW, { status: C1 });
    assert.equal(runHost(checked, false).exit.kind, Exit.HALT);
    const after = outcome(speculative);
    assert.deepEqual(after, outcome(checked));
    assert.equal(after.status & (IE | SF | C1), IE | SF, 'a stack underflow: C1 clear');
    assert.ok(Number.isNaN(after.stored), 'the indefinite stored');
});

test('a region whose entry keeps finding another shape is translated again checked', async()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const view = new DataView(memory.buffer);
    view.setUint8(layout.x87Empty, 0xff);
    view.setUint16(layout.x87Control, 0x37f, true);
    new Uint8Array(memory.buffer).set(UNDERFLOW, layout.ramBase + CODE);
    const runtime = createCorkRuntime({
        memory, layout, config: {},
        read: address=>new Uint8Array(memory.buffer)[layout.ramBase + address],
        imports: { trap: ()=>0, getEflags: ()=>view.getUint32(layout.eflags, true),
            x87Read: ()=>0, rdtsc: ()=>0n },
    });
    runtime.noteHot(CODE, 0);
    assert.equal(await runtime.translatePending(), 1);
    for (let turn = 1; turn <= 4; turn++)
    {
        view.setUint32(layout.eip, CODE, true);
        const entry = runtime.entryOf(CODE, 0);
        assert.ok(entry >= 0, `turn ${turn}: the speculative region stands`);
        const exit = runtime.run(entry, 100);
        assert.equal(exit.kind, 'untranslated');
        assert.equal(exit.vector, SHAPE);
        assert.equal(exit.retired, 0);
    }
    const diagnostics = runtime.diagnostics();
    assert.equal(diagnostics.shapeMisses, 4);
    assert.equal(diagnostics.shapeChecked, 1, 'the fourth miss dropped it');
    assert.equal(runtime.entryOf(CODE, 0), -1);
    assert.equal(await runtime.translatePending(), 1, 'formed again at once, checked');
    view.setUint32(layout.eip, CODE, true);
    assert.equal(runtime.run(runtime.entryOf(CODE, 0), 100).kind, 'halt');
    assert.equal(view.getUint16(layout.x87Status, true) & (IE | SF), IE | SF,
        'the checks inside raise the fault');
    assert.equal(runtime.diagnostics().shapeMisses, 4, 'and it enters with no test');
});

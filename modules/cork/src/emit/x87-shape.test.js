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
import { ownLayout, pagesFor, tablesSize } from '../runtime/layout.js';
import { Exit } from './region.js';
import { SHAPE, analyseX87 } from './x87.js';
import { formRegion } from '../region.js';

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
    const layout = ownLayout({ ramSize: 1 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
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

/**
 * Runs from CODE with ST(6) and ST(7) held, top 6: translated where a region can be made
 * (calls made as wasm calls), or on the interpreter alone.
 *
 * @param {number[]} code @param {number[]} callee  at 0x1100 @param {boolean} translated
 */
async function heldAtSix(code, callee, translated){
    const layout = ownLayout({ ramSize: 1 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    view.setUint8(layout.x87Top, 6);
    view.setUint8(layout.x87Empty, 0x3f);
    view.setFloat64(layout.x87 + 6 * 16, 2, true);
    view.setFloat64(layout.x87 + 7 * 16, 5, true);
    view.setUint16(layout.x87Control, 0x37f, true);
    view.setFloat32(layout.ramBase + DATA, 1.5, true);
    view.setFloat32(layout.ramBase + DATA + 4, 3, true);
    view.setUint32(layout.ramBase + DATA + 16, 0x1100, true);
    bytes.set(code, layout.ramBase + CODE);
    bytes.set(callee, layout.ramBase + 0x1100);
    view.setUint32(layout.regs + 4, 2, true); // ecx
    view.setUint32(layout.regs + 8, 3, true); // edx
    view.setUint32(layout.regs + 16, 0x80000, true);
    view.setUint32(layout.eip, CODE, true);
    let shapeMisses = 0;
    if (translated)
    {
        const runtime = createCorkRuntime({
            memory, layout, config: { callReturn: true, leafCalls: false },
            read: address=>bytes[layout.ramBase + address],
            imports: { trap: ()=>0, getEflags: ()=>view.getUint32(layout.eflags, true),
                x87Read: ()=>0, rdtsc: ()=>0n },
        });
        for (let turn = 0; turn < 1000; turn++)
        {
            const eip = view.getUint32(layout.eip, true);
            const top = view.getUint8(layout.x87Top);
            if (runtime.entryOf(eip, top) < 0)
            {
                runtime.noteHot(eip, top);
                await runtime.translatePending();
            }
            const entry = runtime.entryOf(eip, top);
            if (entry >= 0)
            {
                if (runtime.run(entry, 10_000).kind === 'halt')
                {
                    break;
                }
                continue;
            }
            const state = blockState({ memory, layout });
            state.syncIn();
            interpret(state, 1, { force: true });
            state.syncOut();
            if (state.halted)
            {
                break;
            }
        }
        shapeMisses = runtime.diagnostics().shapeMisses ?? 0;
    }
    else
    {
        const state = blockState({ memory, layout });
        state.syncIn();
        interpret(state, 10_000);
        state.syncOut();
        assert.ok(state.halted);
    }
    return {
        shapeMisses,
        seen: {
            eip: view.getUint32(layout.eip, true),
            top: view.getUint8(layout.x87Top), empty: view.getUint8(layout.x87Empty),
            // C0 C2 C3 and the top: C1 and the flags are kept only when `precise`.
            status: view.getUint16(layout.x87Status, true) & 0x7d00,
            registers: Array.from({ length: 8 }, (_, k)=>view.getFloat64(layout.x87 + k * 16,
                true)),
            stored: [8, 12].map(offset=>view.getFloat32(layout.ramBase + DATA + offset, true)),
        },
    };
}

test('code a call returns to tests the stack it needs, whatever top its region was entered at,'
    + ' and what follows runs with no stack-fault check', async()=>{
    // Entered at L with two registers held (top 6), as a loop over a pair is:
    // L: fld dword [DATA]; fstp dword [DATA+8]; dec ecx; jnz L; fstp st0; fstp st0;
    //    call [DATA+16]; fld dword [DATA]; fld dword [DATA+4]; fstp dword [DATA+12];
    //    fld dword [DATA+4]; mov ecx, 2; dec edx; jnz L; fstp st0; fstp st0; hlt
    // The code after the call is at top 0, another state than the entry's: it pushes into
    // ST(7) and ST(6) and the loop into ST(5), which the call's return now tests empty.
    const code = [0xd9, 0x05, ...at(DATA), 0xd9, 0x1d, ...at(DATA + 8), 0x49, 0x75, 0xf1,
        0xdd, 0xd8, 0xdd, 0xd8, 0xff, 0x15, ...at(DATA + 16),
        0xd9, 0x05, ...at(DATA), 0xd9, 0x05, ...at(DATA + 4), 0xd9, 0x1d, ...at(DATA + 12),
        0xd9, 0x05, ...at(DATA + 4), 0xb9, 2, 0, 0, 0, 0x4a, 0x75, 0xc7,
        0xdd, 0xd8, 0xdd, 0xd8, 0xf4];
    const region = formRegion(address=>code[address - CODE] ?? 0xf4, CODE, {});
    const analysis = /** @type {NonNullable<ReturnType<typeof analyseX87>>} */ (
        analyseX87(region, new Set(), 6, false, true));
    const index = (/** @type {number} */ address)=>region.blocks.findIndex(block=>
        block.start === address);
    assert.deepEqual(analysis.needs[index(CODE + 0x19)], { held: 0, empty: 0xe0, c1: false },
        'the return tests ST(5) to ST(7) empty');
    assert.equal(analysis.shapes[0].empty & 0x20, 0x20,
        'the loop knows its push\'s register empty');
    // ret, and a callee that leaves ST(7) held at the same top: fld1; fincstp; ret.
    for (const [callee, misses] of /** @type {[number[], number][]} */ ([[[0xc3], 0],
        [[0xd9, 0xe8, 0xd9, 0xf7, 0xc3], 1]]))
    {
        const expected = await heldAtSix(code, callee, false);
        const got = await heldAtSix(code, callee, true);
        assert.deepEqual(got.seen, expected.seen);
        assert.equal(got.shapeMisses > 0, misses > 0, `${callee.length}: left at the return`);
    }
});

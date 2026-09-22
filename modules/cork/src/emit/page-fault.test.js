/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page-fault fixture: the same program on translated code and on the
 * interpreter, over memory whose pages the test marks inaccessible, compared
 * at the fault. Everywhere else a case is judged against the emulator or a
 * hardware recording; the page-flag table is cork's own, so the translator's
 * peer here is the interpreter, which consults the same table through
 * `blockState`.
 *
 * The queue's item 6 asks for the cases the flat test memory cannot hold: a
 * `rep` that faults with its progress in ecx, esi and edi and restarts from
 * there; a `cmps` element straddling a page with the source read before the
 * destination; and an MMX instruction whose memory operand faults leaving the
 * register it would have written as it was. Each runs both executors from one
 * state and asserts they agree on the fault, the registers and the bytes the
 * progress wrote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { blockState, interpret } from '../interp.js';
import { PageFlag } from '../runtime/pages.js';
import { Exit } from './region.js';

const CODE = 0x1000;
const STACK = 0x80000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/**
 * Runs a program on translated code and on the interpreter from the same
 * start, over memory a test marks, and answers both states.
 *
 * @param {number[]} bytes
 * @param {{ regs?: Record<string, number>, eflags?: number,
 *     memory?: [number, number[]][], mark?: [number, number, number][] }} [start]
 */
function both(bytes, { regs = {}, eflags = 2, memory = [], mark = [] } = {}){
    /** @param {ReturnType<typeof createTestMachine>} m */
    const setup = m=>{
        m.write(CODE, bytes);
        m.setReg('esp', STACK);
        for (const [address, data] of memory)
        {
            m.write(address, data);
        }
        for (const [name, value] of Object.entries(regs))
        {
            m.setReg(name, value);
        }
        m.setEflags(eflags);
        for (const [address, length, flag] of mark)
        {
            if (flag === PageFlag.HAS_CODE)
            {
                m.pages.markCode(address, length);
            }
            else
            {
                m.pages.markRange(address, length, flag);
            }
        }
    };
    const machine = createTestMachine();
    setup(machine);
    const exit = machine.runProgram(CODE);

    const model = createTestMachine();
    setup(model);
    const state = blockState({ memory: model.memory, layout: model.layout });
    state.eip = CODE;
    state.syncIn();
    /** @type {import('../ir.js').Fault | null} */
    let fault = null;
    try
    {
        interpret(state, 100_000);
    }
    catch (e){
        fault = /** @type {import('../ir.js').Fault} */ (e);
    }
    return { machine, exit, model, state, fault };
}

/**
 * The registers, eflags and eip the two executors left, asserted equal.
 * @param {ReturnType<typeof both>} r
 */
function agree(r){
    for (let i = 0; i < 8; i++)
    {
        assert.equal(r.machine.reg(REGISTERS[i]), r.state.reg[i], `${REGISTERS[i]} differs`);
    }
    assert.equal(r.machine.eflags() >>> 0, r.state.eflags >>> 0, 'eflags differ');
    assert.ok(r.fault !== null, 'the interpreter faulted too');
    assert.equal(r.fault.vector, 13, 'the interpreter raised #GP');
    assert.equal(r.fault.eip, r.exit.eip, 'the fault names the same address');
}

/**
 * The machine and the model left the same bytes over `[address, address + length)`.
 * @param {ReturnType<typeof both>} r @param {number} address @param {number} length
 */
function sameBytes(r, address, length){
    const model = new Uint8Array(r.model.memory.buffer);
    for (let i = 0; i < length; i++)
    {
        assert.equal(r.machine.read(address + i, 1)[0],
            model[r.model.layout.ramBase + address + i],
            `the byte at 0x${(address + i).toString(16)}`);
    }
}

test('a rep movsb faults into an inaccessible page with ecx, esi and edi as far as it got', ()=>{
    const source = Array.from({ length: 8 }, (_, i)=>i + 1);
    const r = both([
        0xbe, 0x00, 0x20, 0, 0,             // mov esi, 0x2000
        0xbf, 0xfc, 0x4f, 0, 0,             // mov edi, 0x4ffc
        0xb9, 0x08, 0, 0, 0,                // mov ecx, 8
        0xf3, 0xa4,                         // rep movsb
        0xf4,
    ], { memory: [[0x2000, source]], mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
    assert.equal(r.exit.kind, Exit.FAULT);
    assert.equal(r.exit.vector, 13);
    assert.equal(r.exit.eip, CODE + 15, 'at the rep, not past it');
    assert.equal(r.machine.reg('ecx'), 4, 'four of eight moved');
    assert.equal(r.machine.reg('edi'), 0x5000, 'the destination stands in the bad page');
    assert.equal(r.machine.reg('esi'), 0x2004);
    assert.equal(r.exit.retired, 3 + 4, 'the completed iterations are counted');
    agree(r);
    sameBytes(r, 0x4ffc, 4);
});

test('a repe cmpsb whose destination page faults leaves the flags of the compare before it', ()=>{
    // The start flags carry a value the compare would have changed: ZF is set,
    // and the unequal bytes would clear it. The fault must leave it set.
    const r = both([
        0xbe, 0x00, 0x20, 0, 0,             // mov esi, 0x2000
        0xbf, 0x00, 0x50, 0, 0,             // mov edi, 0x5000
        0xb9, 0x04, 0, 0, 0,                // mov ecx, 4
        0xf3, 0xa6,                         // repe cmpsb
        0xf4,
    ], { memory: [[0x2000, [1, 2, 3, 4]]],
        mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]],
        eflags: 2 | 0x40 });
    assert.equal(r.exit.kind, Exit.FAULT);
    assert.equal(r.exit.eip, CODE + 15);
    assert.equal(r.machine.reg('ecx'), 4, 'no iteration completed');
    assert.equal(r.machine.reg('esi'), 0x2000, 'the source pointer did not move');
    assert.equal(r.machine.reg('edi'), 0x5000, 'nor the destination');
    assert.equal(r.machine.eflags() >>> 6 & 1, 1, 'the compare did not touch ZF');
    agree(r);
});

test('a cmpsd element straddling a page faults before the compare, source read first', ()=>{
    // The source starts a word before the inaccessible page 3: its last two
    // bytes land in it. The destination is clean, so the source is what
    // faults, and the order source-then-destination is what leaves the
    // pointers and the flags untouched.
    const r = both([
        0xbe, 0xfe, 0x2f, 0, 0,             // mov esi, 0x2ffe
        0xbf, 0x00, 0x60, 0, 0,             // mov edi, 0x6000
        0xb9, 0x01, 0, 0, 0,                // mov ecx, 1
        0xf3, 0xa7,                         // repe cmpsd
        0xf4,
    ], { mark: [[0x3000, 0x1000, PageFlag.INACCESSIBLE]], eflags: 2 | 0x40 });
    assert.equal(r.exit.kind, Exit.FAULT);
    assert.equal(r.exit.eip, CODE + 15);
    assert.equal(r.machine.reg('ecx'), 1);
    assert.equal(r.machine.reg('esi'), 0x2ffe);
    assert.equal(r.machine.reg('edi'), 0x6000);
    assert.equal(r.machine.eflags() >>> 6 & 1, 1, 'the flags are the start\'s');
    agree(r);
});

test('a restart after the fault runs the rep from the partial counts to the end', ()=>{
    const source = Array.from({ length: 8 }, (_, i)=>i + 1);
    const program = [
        0xbe, 0x00, 0x20, 0, 0,             // mov esi, 0x2000
        0xbf, 0xfc, 0x4f, 0, 0,             // mov edi, 0x4ffc
        0xb9, 0x08, 0, 0, 0,                // mov ecx, 8
        0xf3, 0xa4,                         // rep movsb
        0xf4,
    ];
    const faulted = both(program, { memory: [[0x2000, source]],
        mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
    assert.equal(faulted.exit.kind, Exit.FAULT);
    // The page comes back and the machine resumes at the faulting rep, which
    // is where the fault left EIP: the registers already hold the progress.
    faulted.machine.pages.clear(5, PageFlag.INACCESSIBLE);
    const rest = faulted.machine.runProgram(faulted.exit.eip);
    assert.equal(rest.kind, Exit.HALT);
    assert.equal(faulted.machine.reg('ecx'), 0, 'the count finished');
    assert.equal(faulted.machine.reg('edi'), 0x5004);
    assert.equal(faulted.machine.reg('esi'), 0x2008);

    const clean = createTestMachine();
    clean.write(CODE, program);
    clean.setReg('esp', STACK);
    clean.write(0x2000, source);
    assert.equal(clean.runProgram(CODE).kind, Exit.HALT);
    assert.deepEqual([...faulted.machine.read(0x4ffc, 8)], [...clean.read(0x4ffc, 8)],
        'the restarted copy is the clean one');
});

test('an MMX instruction whose memory operand faults leaves its register as before', ()=>{
    const program = [
        0x0f, 0x6f, 0x05, 0x00, 0x20, 0, 0, // movq mm0, [0x2000]
        0x0f, 0xc4, 0x05, 0x00, 0x50, 0, 0, 0x01, // pinsrw mm0, [0x5000], 1
        0x0f, 0x7f, 0x05, 0x00, 0x30, 0, 0, // movq [0x3000], mm0
        0xf4,
    ];
    const data = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    const faulted = both(program, { memory: [[0x2000, data]],
        mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
    assert.equal(faulted.exit.kind, Exit.FAULT);
    assert.equal(faulted.exit.eip, CODE + 7, 'at the pinsrw');
    agree(faulted);
    // The pinsrw must not have touched mm0: both executors hold the movq's
    // value, as the short program that stopped after it leaves it.
    const afterMovq = both([0x0f, 0x6f, 0x05, 0x00, 0x20, 0, 0, 0xf4],
        { memory: [[0x2000, data]] });
    assert.deepEqual(mm(faulted.machine, 0), mm(afterMovq.machine, 0));
    assert.equal(faulted.state.f80bits[0], afterMovq.state.f80bits[0],
        'the interpreter left the mantissa too');
    // The page comes back and the restart completes what the fault stopped.
    faulted.machine.pages.clear(5, PageFlag.INACCESSIBLE);
    const rest = faulted.machine.runProgram(faulted.exit.eip);
    assert.equal(rest.kind, Exit.HALT);
    const clean = createTestMachine();
    clean.write(CODE, program);
    clean.setReg('esp', STACK);
    clean.write(0x2000, data);
    assert.equal(clean.runProgram(CODE).kind, Exit.HALT);
    assert.deepEqual([...faulted.machine.read(0x3000, 8)], [...clean.read(0x3000, 8)],
        'the restarted pinsrw found the register the movq left');
});

test('an x87 memory form faults with the stack as before, and a restart completes it', ()=>{
    const value = new Uint8Array(8);
    new DataView(value.buffer).setFloat64(0, 2.5, true);
    const program = [
        0xd9, 0xe8,                         // fld1
        0xdc, 0x05, 0x00, 0x50, 0, 0,       // fadd qword [0x5000]
        0xdd, 0x1d, 0x00, 0x30, 0, 0,       // fstp qword [0x3000]
        0xf4,
    ];
    const faulted = both(program, { mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
    assert.equal(faulted.exit.kind, Exit.FAULT);
    assert.equal(faulted.exit.eip, CODE + 2, 'at the fadd');
    assert.equal(st0(faulted.machine), 1, 'st0 is the fld1 value');
    assert.equal(empty(faulted.machine), 0x7f, 'one register held');
    agree(faulted);

    const clean = createTestMachine();
    clean.write(CODE, program);
    clean.setReg('esp', STACK);
    clean.write(0x5000, value);
    assert.equal(clean.runProgram(CODE).kind, Exit.HALT);
    faulted.machine.write(0x5000, value);
    faulted.machine.pages.clear(5, PageFlag.INACCESSIBLE);
    assert.equal(faulted.machine.runProgram(faulted.exit.eip).kind, Exit.HALT);
    assert.deepEqual([...faulted.machine.read(0x3000, 8)], [...clean.read(0x3000, 8)],
        'the restart added 1 + 2.5');
});

/** The f64 in ST(0), the register the machine's top names. @param {ReturnType<typeof createTestMachine>} m */
function st0(m){
    const view = new DataView(m.memory.buffer);
    const top = view.getUint8(m.layout.x87Top);
    return view.getFloat64(m.layout.x87 + top * 16, true);
}

/** The machine's x87 empty mask. @param {ReturnType<typeof createTestMachine>} m */
function empty(m){
    return new DataView(m.memory.buffer).getUint8(m.layout.x87Empty);
}

/** An mm register as two u32 words. @param {ReturnType<typeof createTestMachine>} m @param {number} index */
function mm(m, index){
    const view = new DataView(m.memory.buffer);
    const at = m.layout.x87 + index * 16;
    return [view.getUint32(at, true), view.getUint32(at + 4, true)];
}

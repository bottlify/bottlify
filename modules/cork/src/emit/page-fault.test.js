/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page-fault fixture: the same program on translated code and on the
 * interpreter, over memory whose pages the test marks inaccessible, compared
 * at the fault. Everywhere else a case is judged against a hardware
 * recording; the page-flag table is cork's own, so the translator's peer here
 * is the interpreter, which consults the same table through `blockState`.
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
import { Fault, blockState, interpret } from '../interp.js';
import { WASM_INTERPRETER_AREA, WASM_INTERPRETER_STATICS_AT, WasmExit, createWasmInterpreter }
    from '../interp-wasm.js';
import { PageFlag, createPageTable } from '../runtime/pages.js';
import { ownLayout, pagesFor, tablesSize } from '../runtime/layout.js';
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
    assert.equal(r.exit.retired, 3 + 1, 'the completed iterations are counted, four bytes in bulk');
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

test('a repne cmpsb whose destination faults after a compare leaves that compare\'s flags, '
    + 'whatever the source\'s next element', ()=>{
    // The first pair, 0x10 against 0x01, leaves CF clear and AF set; the
    // second's source byte, 0x00, is read before its destination faults, and
    // folded with the first's record it would leave CF set and AF clear.
    const r = both([
        0xbe, 0x00, 0x20, 0, 0,             // mov esi, 0x2000
        0xbf, 0xff, 0x4f, 0, 0,             // mov edi, 0x4fff
        0xb9, 0x04, 0, 0, 0,                // mov ecx, 4
        0xf2, 0xa6,                         // repne cmpsb
        0xf4,
    ], { memory: [[0x2000, [0x10, 0x00]], [0x4fff, [0x01]]],
        mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
    assert.equal(r.exit.kind, Exit.FAULT);
    assert.equal(r.exit.eip, CODE + 15);
    assert.equal(r.machine.reg('ecx'), 3, 'one compare completed');
    assert.equal(r.machine.reg('edi'), 0x5000);
    assert.equal(r.machine.eflags() & 0x51, 0x10, 'CF and ZF clear, AF set: 0x10 - 0x01');
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

/**
 * Both executors ran to the hlt and left the same registers and bytes.
 * @param {ReturnType<typeof both>} r @param {number} address @param {number} length
 */
function agreeHalted(r, address, length){
    assert.equal(r.exit.kind, Exit.HALT, 'the translated run reached the hlt');
    assert.equal(r.fault, null, 'the interpreter did not fault');
    for (let i = 0; i < 8; i++)
    {
        assert.equal(r.machine.reg(REGISTERS[i]), r.state.reg[i], `${REGISTERS[i]} differs`);
    }
    sameBytes(r, address, length);
}

test('a rep movsd whose destination lies one word ahead repeats the source', ()=>{
    const r = both([
        0xbe, 0x00, 0x20, 0, 0,             // mov esi, 0x2000
        0xbf, 0x04, 0x20, 0, 0,             // mov edi, 0x2004
        0xb9, 0x00, 0x05, 0, 0,             // mov ecx, 0x500 -- across a page
        0xf3, 0xa5,                         // rep movsd
        0xf4,
    ], { memory: [[0x2000, [1, 2, 3, 4, 5, 6, 7, 8]]] });
    agreeHalted(r, 0x2000, 0x1500);
    assert.deepEqual([...r.machine.read(0x3400, 4)], [1, 2, 3, 4], 'the first word, repeated');
});

test('a rep movsd with the source ahead, and one run backwards, copy as element by element', ()=>{
    const source = Array.from({ length: 64 }, (_, i)=>i * 3 & 255);
    const ahead = both([
        0xbe, 0x10, 0x20, 0, 0,             // mov esi, 0x2010
        0xbf, 0x00, 0x20, 0, 0,             // mov edi, 0x2000
        0xb9, 0x0c, 0, 0, 0,                // mov ecx, 12
        0xf3, 0xa5, 0xf4,                   // rep movsd; hlt
    ], { memory: [[0x2000, source]] });
    agreeHalted(ahead, 0x2000, 64);
    const backwards = both([
        0xfd,                               // std
        0xbe, 0x3c, 0x20, 0, 0,             // mov esi, 0x203c
        0xbf, 0xfc, 0x30, 0, 0,             // mov edi, 0x30fc
        0xb9, 0x10, 0, 0, 0,                // mov ecx, 16
        0xf3, 0xa5, 0xf4,                   // rep movsd; hlt
    ], { memory: [[0x2000, source]] });
    agreeHalted(backwards, 0x3000, 0x100);
});

test('a rep stosd of a word across a page, of zero, and of bytes into code', ()=>{
    const word = both([
        0xb8, 0x44, 0x33, 0x22, 0x11,       // mov eax, 0x11223344
        0xbf, 0xfe, 0x2f, 0, 0,             // mov edi, 0x2ffe -- its first word straddles
        0xb9, 0x00, 0x06, 0, 0,             // mov ecx, 0x600
        0xf3, 0xab, 0xf4,                   // rep stosd; hlt
    ]);
    agreeHalted(word, 0x2ff0, 0x1820);
    const zero = both([
        0x31, 0xc0,                         // xor eax, eax
        0xbf, 0x00, 0x20, 0, 0,             // mov edi, 0x2000
        0xb9, 0x00, 0x08, 0, 0,             // mov ecx, 0x800
        0xf3, 0xab, 0xf4,                   // rep stosd; hlt
    ], { memory: [[0x2000, Array(0x2004).fill(0x5a)]] });
    agreeHalted(zero, 0x2000, 0x2004);
    const code = both([
        0xb0, 0x90,                         // mov al, 0x90
        0xbf, 0xf0, 0x5f, 0, 0,             // mov edi, 0x5ff0
        0xb9, 0x40, 0, 0, 0,                // mov ecx, 64
        0xf3, 0xaa, 0xf4,                   // rep stosb; hlt
    ], { mark: [[0x6000, 0x1000, PageFlag.HAS_CODE]] });
    // Up to the code page in bulk, into it one element at a time with each
    // store noted, and `stale` past the rep, as one element at a time did.
    assert.equal(code.exit.kind, Exit.STALE);
    assert.equal(code.machine.reg('ecx'), 0);
    assert.equal(code.machine.reg('edi'), 0x6030);
    assert.deepEqual([...code.machine.read(0x5ff0, 64)], Array(64).fill(0x90));
});

test('a bulk rep is charged a unit of the budget for every sixteen bytes, and stops on it with '
    + 'the count and the pointers of the elements it ran', ()=>{
    const m = createTestMachine();
    m.write(CODE, [
        0x31, 0xc0,                         // xor eax, eax
        0xbf, 0x00, 0x20, 0, 0,             // mov edi, 0x2000
        0xb9, 0xe8, 0x03, 0, 0,             // mov ecx, 1000
        0xf3, 0xab, 0xf4,                   // rep stosd; hlt
    ]);
    m.setReg('esp', STACK);
    const exit = m.runProgram(CODE, { budget: 100 });
    assert.equal(exit.kind, Exit.BUDGET);
    assert.equal(exit.eip, CODE + 12, 'on the rep');
    // The block's own instructions are charged at its end: the rep has the
    // whole budget, a unit for every sixteen bytes.
    assert.equal(exit.retired, 3 + 100, 'the block\'s three and the rep\'s hundred units');
    assert.equal(m.reg('ecx'), 1000 - 400, 'four hundred elements');
    assert.equal(m.reg('edi'), 0x2000 + 400 * 4);
    // A byte's rep is charged by its bytes too, a begun unit whole: mov, mov,
    // the rep itself and the hlt, and the units.
    for (const [count, units] of [[3, 1], [16, 1], [17, 2], [0x1000, 256]])
    {
        const bytes = createTestMachine();
        bytes.write(CODE, [
            0xbf, 0x00, 0x40, 0, 0,         // mov edi, 0x4000
            0xb9, ...le(count),             // mov ecx, count
            0xf3, 0xaa, 0xf4,               // rep stosb; hlt
        ]);
        bytes.setReg('esp', STACK);
        const done = bytes.runProgram(CODE);
        assert.equal(done.kind, Exit.HALT);
        assert.equal(done.retired, 4 + units, `${count} bytes`);
    }
    // Going down the same: std, mov, mov, the rep and the hlt.
    const down = createTestMachine();
    down.write(CODE, [
        0xfd,                               // std
        0xbf, 0xff, 0x4f, 0, 0,             // mov edi, 0x4fff
        0xb9, 0x00, 0x10, 0, 0,             // mov ecx, 0x1000
        0xf3, 0xaa, 0xf4,                   // rep stosb; hlt
    ]);
    down.setReg('esp', STACK);
    const fill = down.runProgram(CODE);
    assert.equal(fill.kind, Exit.HALT);
    assert.equal(fill.retired, 5 + 256, 'a page of bytes going down');
    assert.equal(down.reg('edi'), 0x3fff);
});

test('a repe or repne cmps or scas passed over in bulk is charged by its bytes, the element '
    + 'after them as one, and stops on the budget with the flags of the element it ran last', ()=>{
    // repne scasb for a zero over a page of 0x41 with the zero last: the
    // first 4095 bytes are passed over in bulk (256 units), the zero is the
    // element's own (1).
    const whole = createTestMachine();
    whole.write(0x4000, [...Array(0xfff).fill(0x41), 0]);
    whole.write(CODE, [
        0x31, 0xc0,                         // xor eax, eax
        0xbf, 0x00, 0x40, 0, 0,             // mov edi, 0x4000
        0xb9, 0xff, 0xff, 0xff, 0xff,       // mov ecx, -1
        0xf2, 0xae, 0xf4,                   // repne scasb; hlt
    ]);
    whole.setReg('esp', STACK);
    const found = whole.runProgram(CODE);
    assert.equal(found.kind, Exit.HALT);
    assert.equal(found.retired, 5 + 256 + 1,
        'xor, mov, mov, the rep and the hlt, the bytes and the zero');
    assert.equal(whole.reg('edi'), 0x5000, 'past the zero');
    assert.equal(whole.reg('ecx'), (-1 - 0x1000) >>> 0);
    assert.equal(whole.eflags() >>> 6 & 1, 1, 'ZF: the zero found');
    // repe cmpsd of two equal runs of a thousand dwords, stopped by a budget
    // of 100: 1600 bytes' worth passed over, all but the last dword of them
    // in bulk, which is the element's own and sets ZF (clear before it).
    const cut = createTestMachine();
    cut.write(CODE, [
        0x31, 0xc0, 0x40,                   // xor eax, eax; inc eax -- ZF clear
        0xbe, 0x00, 0x20, 0, 0,             // mov esi, 0x2000
        0xbf, 0x00, 0x60, 0, 0,             // mov edi, 0x6000
        0xb9, 0xe8, 0x03, 0, 0,             // mov ecx, 1000
        0xf3, 0xa7, 0xf4,                   // repe cmpsd; hlt
    ]);
    cut.setReg('esp', STACK);
    const exit = cut.runProgram(CODE, { budget: 100 });
    assert.equal(exit.kind, Exit.BUDGET);
    assert.equal(exit.eip, CODE + 18, 'on the rep');
    assert.equal(exit.retired, 5 + 100 + 1, 'the block\'s five, a hundred units and the element');
    assert.equal(cut.reg('ecx'), 1000 - 400);
    assert.equal(cut.reg('esi'), 0x2000 + 400 * 4);
    assert.equal(cut.reg('edi'), 0x6000 + 400 * 4);
    assert.equal(cut.eflags() >>> 6 & 1, 1, 'ZF from the four hundredth dword\'s compare');
    const rest = cut.runProgram(exit.eip);
    assert.equal(rest.kind, Exit.HALT);
    assert.equal(cut.reg('ecx'), 0);
    assert.equal(cut.reg('edi'), 0x6000 + 4000);
});

test('loops whose pointers move by fixed strides agree with the interpreter by pages clean, '
    + 'inaccessible and holding code', ()=>{
    // Each case: esi and edi walk by a stride a turn, the body loads and
    // stores off both, and a page along the way is inaccessible or holds
    // code -- or none is. The translated run (whose loop tests the pages the
    // next turns reach once, before them) must fault, note the store into
    // code or finish exactly where and as the interpreter does.
    let seed = 0x5eed;
    const random = (/** @type {number} */ n)=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) % n;
    };
    const forms = [
        [0x8b, 0x46], [0x03, 0x46], [0x89, 0x46], [0x66, 0x89, 0x46], [0x8a, 0x46],
        [0x0f, 0x10, 0x46], [0x0f, 0x11, 0x46], [0x01, 0x46], [0x89, 0x47], [0x8b, 0x57],
    ];
    const strides = [4, 12, 16, 60, -4, -16, 0, 124];
    const low = 0x10000;
    const span = 0x40000;
    for (let round = 0; round < Number(process.env.STRIDE_ROUNDS ?? 40); round++)
    {
        const body = [];
        for (let k = 1 + random(4); k > 0; k--)
        {
            body.push(...forms[random(forms.length)], random(64) & ~3);
        }
        body.push(0x83, 0xc6, strides[random(strides.length)] & 255);
        body.push(0x83, 0xc7, strides[random(strides.length)] & 255);
        body.push(0x49, 0x75, (-(body.length + 3)) & 255);
        const esi = low + 0x10000 + random(0x10000) * 4;
        const edi = low + 0x10000 + random(0x10000) * 4;
        const count = 1 + random(3000);
        const program = [0xbe, ...le(esi), 0xbf, ...le(edi), 0xb9, ...le(count), ...body, 0xf4];
        const page = (low + random(span)) & ~0xfff;
        const flag = [0, PageFlag.INACCESSIBLE, PageFlag.HAS_CODE][random(3)];
        const r = both(program, { mark: flag === 0 ? [] : [[page, 0x1000, flag]] });
        const what = `round ${round}: esi ${esi.toString(16)} edi ${edi.toString(16)} ecx ${count}`
            + ` page ${page.toString(16)} flag ${flag}`
            + ` body ${body.map(x=>x.toString(16)).join(' ')}`;
        if (r.exit.kind === Exit.STALE || r.exit.kind === -2)
        {
            // Stopped past the store into code, or held before a group whose
            // window is not clean (the host interprets it then): the interpreter, run for as
            // many instructions, stands at the same place.
            const model = createTestMachine();
            model.write(CODE, program);
            model.setReg('esp', STACK);
            const state = blockState({ memory: model.memory, layout: model.layout });
            state.eip = CODE;
            state.syncIn();
            interpret(state, r.exit.retired);
            for (let i = 0; i < 8; i++)
            {
                assert.equal(r.machine.reg(REGISTERS[i]), state.reg[i], `${what}: ${REGISTERS[i]}`);
            }
            assert.equal(r.exit.eip, state.eip, `${what}: eip`);
            continue;
        }
        for (let i = 0; i < 8; i++)
        {
            assert.equal(r.machine.reg(REGISTERS[i]), r.state.reg[i], `${what}: ${REGISTERS[i]}`);
        }
        if (r.exit.kind === Exit.FAULT)
        {
            assert.ok(r.fault !== null, `${what}: the interpreter faulted too`);
            assert.equal(r.fault.eip, r.exit.eip, `${what}: the fault's address`);
        }
        else
        {
            assert.equal(r.exit.kind, Exit.HALT, what);
            assert.equal(r.fault, null, `${what}: the interpreter did not fault`);
        }
        const theirs = new Uint8Array(r.model.memory.buffer, r.model.layout.ramBase + low, span);
        assert.equal(Buffer.compare(Buffer.from(r.machine.read(low, span)), Buffer.from(theirs)), 0,
            `${what}: the bytes`);
    }
});

test('loops of string instructions with no repeat agree with the interpreter, DF clear or set, '
    + 'by pages clean, inaccessible and holding code', ()=>{
    // A loop of movs, stos, lods, cmps and scas elements, with DF clear or
    // set as it is entered -- or written inside it -- and a page along the
    // way inaccessible or holding code, or none: the translated run (whose
    // loop, entered with DF clear, tests the pages the next turns reach once)
    // must fault, note the store into code or finish exactly where and as
    // the interpreter does.
    let seed = Number(process.env.STRING_SEED ?? 0x5171);
    const random = (/** @type {number} */ n)=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) % n;
    };
    const strings = [
        [0xa4], [0xa5], [0x66, 0xa5], [0xaa], [0xab], [0xac], [0xad], [0xa6], [0xa7], [0xae],
        [0xaf],
        [0x8b, 0x46, 0x10], [0x89, 0x47, 0xf0],     // mov eax, [esi+16]; mov [edi-16], eax
    ];
    const low = 0x10000;
    const span = 0x40000;
    for (let round = 0; round < Number(process.env.STRING_ROUNDS ?? 200); round++)
    {
        const body = [];
        for (let k = 1 + random(3); k > 0; k--)
        {
            body.push(...strings[random(strings.length)]);
        }
        if (random(8) === 0)
        {
            body.push(random(2) === 0 ? 0xfc : 0xfd);           // cld or std inside the loop
        }
        body.push(0x49, 0x75, (-(body.length + 3)) & 255);      // dec ecx; jnz back
        const set = random(2) === 0;
        const esi = low + 0x10000 + random(0x10000) * 4 + random(4);
        const edi = low + 0x10000 + random(0x10000) * 4 + random(4);
        const count = 1 + random(3000);
        const program = [0xbe, ...le(esi), 0xbf, ...le(edi), 0xb9, ...le(count),
            set ? 0xfd : 0xfc, ...body, 0xfc, 0xf4];
        // A page the pointers reach, whichever way they go, as often as not.
        const near = [esi, edi][random(2)] + (random(2) === 0 ? -1 : 1) * random(0x2000);
        const page = (random(2) === 0 ? near : low + random(span)) & ~0xfff;
        const flag = [0, PageFlag.INACCESSIBLE, PageFlag.HAS_CODE][random(3)];
        const r = both(program, { mark: flag === 0 ? [] : [[page, 0x1000, flag]] });
        const what = `round ${round}: esi ${esi.toString(16)} edi ${edi.toString(16)} ecx ${count}`
            + ` df ${set} page ${page.toString(16)} flag ${flag}`
            + ` body ${body.map(x=>x.toString(16)).join(' ')}`;
        if (r.exit.kind === Exit.STALE || r.exit.kind === -2)
        {
            const model = createTestMachine();
            model.write(CODE, program);
            model.setReg('esp', STACK);
            const state = blockState({ memory: model.memory, layout: model.layout });
            state.eip = CODE;
            state.syncIn();
            interpret(state, r.exit.retired);
            for (let i = 0; i < 8; i++)
            {
                assert.equal(r.machine.reg(REGISTERS[i]), state.reg[i], `${what}: ${REGISTERS[i]}`);
            }
            assert.equal(r.exit.eip, state.eip, `${what}: eip`);
            continue;
        }
        for (let i = 0; i < 8; i++)
        {
            assert.equal(r.machine.reg(REGISTERS[i]), r.state.reg[i], `${what}: ${REGISTERS[i]}`);
        }
        if (r.exit.kind === Exit.FAULT)
        {
            assert.ok(r.fault !== null, `${what}: the interpreter faulted too`);
            assert.equal(r.fault.eip, r.exit.eip, `${what}: the fault's address`);
        }
        else
        {
            assert.equal(r.exit.kind, Exit.HALT, what);
            assert.equal(r.fault, null, `${what}: the interpreter did not fault`);
            assert.equal(r.machine.eflags() >>> 0, r.state.eflags >>> 0, `${what}: eflags`);
        }
        const theirs = new Uint8Array(r.model.memory.buffer, r.model.layout.ramBase + low, span);
        assert.equal(Buffer.compare(Buffer.from(r.machine.read(low, span)), Buffer.from(theirs)), 0,
            `${what}: the bytes`);
    }
});

/**
 * A seeded generator: `random(n)` answers 0 <= r < n.
 * @param {number} seed
 */
function seeded(seed){
    let state = seed >>> 0;
    return (/** @type {number} */ n)=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
}

/** Where the random `rep` rounds keep their data, and its length. */
const LOW = 0x10000;
const SPAN = 0x40000;
/** The flags a `rep` round compares: the arithmetic ones and DF. */
const STATUS = 0xcd5;

/**
 * One program run five ways from the same start: translated in one call and
 * in slices of a few units of the budget each, on the JavaScript interpreter
 * and on the one in wasm -- all four taking their bulk paths where they may
 * -- and on the JavaScript interpreter with its bulk paths taken away, one
 * element at a time, the reference. Asserts that the four agree with the
 * reference: how and where each ended, the registers, the flags, every byte
 * of the span, and the stores into code each reported (translated code, which
 * reports the last, whether any). Answers the reference's run.
 *
 * @param {number[]} program  at CODE
 * @param {(ram: Uint8Array, pages: import('../runtime/pages.js').PageTable) => void} prepare
 * @param {string} what
 * @param {(n: number) => number} random  the slices' budgets
 */
function againstElements(program, prepare, what, random){
    /** @param {Uint8Array} ram @param {import('../runtime/pages.js').PageTable} pages */
    const start = (ram, pages)=>{
        prepare(ram, pages);
        ram.set(program, CODE);
    };
    /** @param {number} kind */
    const endedBy = kind=>(kind === Exit.HALT ? 'halt' : `exit ${kind}`);

    const machine = createTestMachine();
    machine.setReg('esp', STACK);
    start(new Uint8Array(machine.memory.buffer, machine.layout.ramBase, 1 << 20), machine.pages);
    // A store into code leaves past the rep, which goes on to its end first.
    let exit = machine.runProgram(CODE);
    const stale = exit.kind === Exit.STALE;
    for (let again = 0; exit.kind === Exit.STALE && again < 4; again++)
    {
        exit = machine.runProgram(exit.eip);
    }
    /**
     * @param {ReturnType<typeof createTestMachine>} m
     * @param {{ kind: number, vector: number }} left
     */
    const translatedRun = (m, left)=>({
        ended: left.kind === Exit.FAULT ? `fault ${left.vector}` : endedBy(left.kind),
        eip: m.eip(),
        regs: REGISTERS.map(name=>m.reg(name)),
        eflags: m.eflags() & STATUS,
        bytes: Buffer.from(m.read(LOW, SPAN)),
    });
    const translated = translatedRun(machine, exit);

    // In slices: a slice that runs out leaves on the `rep`, and the next
    // enters a region that starts there.
    const sliced = createTestMachine();
    sliced.setReg('esp', STACK);
    start(new Uint8Array(sliced.memory.buffer, sliced.layout.ramBase, 1 << 20), sliced.pages);
    /** @type {Map<number, ReturnType<typeof sliced.translate>>} */
    const units = new Map();
    let eip = CODE;
    let left = { kind: -1, vector: 0 };
    for (let slice = 0; slice < 100_000; slice++)
    {
        let unit = units.get(eip);
        if (unit === undefined)
        {
            unit = sliced.translate(eip);
            units.set(eip, unit);
        }
        left = unit.run(eip, 1 + random(40));
        eip = sliced.eip();
        if (left.kind !== Exit.BUDGET && left.kind !== Exit.STALE)
        {
            break;
        }
    }
    const inSlices = translatedRun(sliced, left);

    /** The JavaScript interpreter's run, with its bulk paths or without. @param {boolean} bulk */
    const js = bulk=>{
        const model = createTestMachine();
        model.setReg('esp', STACK);
        start(new Uint8Array(model.memory.buffer, model.layout.ramBase, 1 << 20), model.pages);
        /** @type {string[]} */
        const writes = [];
        const state = blockState({ memory: model.memory, layout: model.layout,
            onCodeWrite: (at, width)=>writes.push(`${at.toString(16)}/${width}`) });
        if (!bulk)
        {
            /** @type {any} */ (state.memory).repeat = undefined;
            /** @type {any} */ (state.memory).pass = undefined;
        }
        state.eip = CODE;
        state.syncIn();
        let ended = 'halt';
        try
        {
            interpret(state, 100_000);
        }
        catch (e){
            assert.ok(e instanceof Fault, `${what}: ${e}`);
            ended = `fault ${e.vector}`;
            state.eip = e.eip;
        }
        return { ended, eip: state.eip >>> 0, regs: [...state.reg], eflags: state.eflags & STATUS,
            bytes: Buffer.from(model.read(LOW, SPAN)), writes };
    };

    // The wasm tier over a memory of its own, in the same layout.
    const layout = ownLayout({ ramSize: 1 << 20, hashSlots: 1 << 16 });
    const pages = pagesFor(layout, tablesSize(layout) + WASM_INTERPRETER_AREA);
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const tier = createWasmInterpreter({ memory, layout,
        statics: WASM_INTERPRETER_STATICS_AT, area: layout.tables + tablesSize(layout),
        hotThreshold: 1 << 30, trapPort: 0xb077, parkBase: 0x100000 });
    assert.ok(tier);
    const view = new DataView(memory.buffer);
    start(new Uint8Array(memory.buffer, layout.ramBase, 1 << 20),
        createPageTable(memory, layout));
    view.setUint32(layout.regs + 16, STACK, true);
    view.setUint32(layout.eflags, 2, true);
    view.setUint32(layout.eip, CODE, true);
    let code = 0;
    /** @type {string[]} */
    const writes = [];
    // A store into code leaves mid-`rep` for the host, which goes on with it.
    for (let runs = 0; runs < 0x10000; runs++)
    {
        code = tier.run(100_000);
        if (code !== WasmExit.CODE_WRITE)
        {
            break;
        }
        writes.push(`${tier.exitValue().toString(16)}/${tier.exitSize()}`);
    }
    const wasm = {
        ended: code === WasmExit.FAULT ? `fault ${tier.exitValue()}`
            : code === WasmExit.HALT ? 'halt' : `exit ${code}`,
        eip: view.getUint32(layout.eip, true),
        regs: REGISTERS.map((_, r)=>view.getUint32(layout.regs + r * 4, true)),
        eflags: view.getUint32(layout.eflags, true) & STATUS,
        bytes: Buffer.from(new Uint8Array(memory.buffer, layout.ramBase + LOW, SPAN)),
        writes,
    };

    const reference = js(false);
    const interpreted = js(true);
    for (const [name, run] of [['translated', translated], ['translated in slices', inSlices],
        ['interpreted', interpreted], ['the wasm tier', wasm]])
    {
        const got = /** @type {typeof translated} */ (run);
        assert.equal(got.ended, reference.ended, `${what}: how ${name} ended`);
        assert.equal(got.eip, reference.eip, `${what}: ${name}'s eip`);
        assert.deepEqual(got.regs, reference.regs, `${what}: ${name}'s registers`);
        assert.equal(got.eflags.toString(16), reference.eflags.toString(16),
            `${what}: ${name}'s flags`);
        assert.equal(Buffer.compare(got.bytes, reference.bytes), 0, `${what}: ${name}'s bytes`);
    }
    assert.deepEqual(interpreted.writes, reference.writes, `${what}: the stores into code`);
    assert.deepEqual(wasm.writes, reference.writes,
        `${what}: the wasm tier's stores into code`);
    assert.equal(stale, reference.writes.length > 0, `${what}: translated code's stale exit`);
    return reference;
}

/**
 * A pointer for a random `rep`: on a page's edge as often as not, in the
 * middle of the span.
 * @param {(n: number) => number} random
 */
function randomPointer(random){
    const page = LOW + 0x10000 + random(0x20) * 0x1000;
    return random(2) === 0 ? page - random(8) : page + random(0x1000);
}

test('a rep movs or rep stos in bulk leaves what one element at a time leaves, on translated '
    + 'code and on both interpreters: across pages, overlapping, DF set, faulting, into code', ()=>{
    // Each round runs one `rep` five ways (`againstElements`) over bytes
    // that tell every element apart, a page along the pointers' way
    // inaccessible or holding code or neither.
    const random = seeded(Number(process.env.REP_SEED ?? 0xb01c));
    const forms = [[0xa4], [0x66, 0xa5], [0xa5], [0xaa], [0x66, 0xab], [0xab]];
    const counts = [0, 1, 3, 17, 0x400, 0x1000, 0x1001, 0x2345];
    let upRounds = 0;
    let downRounds = 0;
    let codeRounds = 0;
    for (let round = 0; round < Number(process.env.REP_ROUNDS ?? 300); round++)
    {
        const form = forms[random(forms.length)];
        const copy = (form[form.length - 1] & 0xfe) === 0xa4;
        const set = random(3) === 0;
        const edi = randomPointer(random);
        // A copy's source near its destination, either side, a third of the time.
        const esi = copy && random(3) === 0 ? edi + (random(2) === 0 ? -1 : 1) * random(24)
            : randomPointer(random);
        const count = random(3) === 0 ? random(0x3000) : counts[random(counts.length)];
        const byte = random(256);
        const eax = random(2) === 0 ? byte * 0x01010101 >>> 0
            : (random(1 << 16) << 16 | byte) >>> 0;
        const program = [0xbe, ...le(esi), 0xbf, ...le(edi), 0xb9, ...le(count), 0xb8, ...le(eax),
            set ? 0xfd : 0xfc, random(8) === 0 ? 0xf2 : 0xf3, ...form, 0xfc, 0xf4];
        const near = [esi, edi][random(2)] + (random(2) === 0 ? -1 : 1) * random(0x3000);
        const page = near & ~0xfff;
        const flag = [0, PageFlag.INACCESSIBLE, PageFlag.HAS_CODE][random(3)];
        upRounds += !set && flag === 0 && count >= 0x400 ? 1 : 0;
        downRounds += set && flag === 0 && count >= 0x400 ? 1 : 0;
        const what = `round ${round}: ${form.map(b=>b.toString(16)).join(' ')}`
            + ` esi ${esi.toString(16)} edi ${edi.toString(16)} ecx ${count}`
            + ` eax ${eax.toString(16)} df ${set}`
            + ` page ${page.toString(16)} flag ${flag}`;
        const reference = againstElements(program, (ram, pages)=>{
            for (let i = 0; i < SPAN; i++)
            {
                ram[LOW + i] = (i * 7 + (i >>> 8) * 13 + round) & 255;
            }
            if (flag === PageFlag.HAS_CODE)
            {
                pages.markCode(page, 0x1000);
            }
            else if (flag !== 0)
            {
                pages.markRange(page, 0x1000, flag);
            }
        }, what, random);
        codeRounds += reference.writes.length > 0 ? 1 : 0;
    }
    assert.ok(upRounds >= 20, `${upRounds} rounds of a clean run going up past a page`);
    assert.ok(downRounds >= 15, `${downRounds} rounds of a clean run going down past a page`);
    assert.ok(codeRounds >= 20, `${codeRounds} rounds of stores into code`);
});

test('a repe or repne cmps or scas passed over in bulk leaves what one element at a time '
    + 'leaves, on translated code and on both interpreters: stopping in the middle, on a page\'s '
    + 'edge, on the last element or not at all, DF clear or set, faulting', ()=>{
    // Each round runs one `repe` or `repne` `scas` or `cmps` five ways
    // (`againstElements`) over data made so that no element stops it but
    // one planted -- in the middle, on either side of a page's edge, the last
    // of the count, or none -- and a page along the pointers' way
    // inaccessible or holding code or neither. A compare whose two runs
    // overlap goes over the bytes as they are.
    const random = seeded(Number(process.env.SCAN_SEED ?? 0x5ca9));
    const forms = [[0xae], [0x66, 0xaf], [0xaf], [0xa6], [0x66, 0xa7], [0xa7]];
    const counts = [0, 1, 2, 3, 17, 0x400, 0x1000, 0x1001, 0x2345];
    const tally = { stops: 0, edges: 0, last: 0, none: 0, down: 0, faults: 0 };
    for (let round = 0; round < Number(process.env.SCAN_ROUNDS ?? 300); round++)
    {
        const form = forms[random(forms.length)];
        const opcode = form[form.length - 1];
        const compare = (opcode & 0xfe) === 0xa6;
        const size = (opcode & 1) === 0 ? 1 : form.length === 2 ? 2 : 4;
        const repe = random(2) === 0;
        const set = random(2) === 0;
        const step = set ? -size : size;
        const edi = randomPointer(random);
        const esi = compare && random(4) === 0 ? edi + (random(2) === 0 ? -1 : 1) * random(24)
            : randomPointer(random);
        const count = random(3) === 0 ? random(0x3000) : counts[random(counts.length)];
        const eax = random(2) === 0 ? random(256) * 0x01010101 >>> 0
            : (random(1 << 16) << 16 | random(1 << 16)) >>> 0;
        const value = size === 4 ? eax : eax & (size === 2 ? 0xffff : 0xff);
        const overlap = compare && Math.abs(esi - edi) < count * size;
        // The element planted to stop it: its index, or none.
        const edge = (/** @type {number} */ pointer)=>{
            // The first element on another page than the first's, the way it goes.
            for (let k = 1; k < Math.min(count, 0x1400); k++)
            {
                const at = pointer + k * step;
                if ((at & ~0xfff) !== (pointer & ~0xfff)
                    || ((at + size - 1) & ~0xfff) !== (at & ~0xfff))
                {
                    return k;
                }
            }
            return -1;
        };
        const choice = random(5);
        const crossing = edge(compare && random(2) === 0 ? esi : edi);
        const stop = count === 0 ? -1
            : choice === 0 ? random(count)
                : choice === 1 && crossing > 0 ? crossing - 1 + random(3)
                    : choice === 2 ? count - 1 : -1;
        // The byte a repe's planted element differs in.
        const flip = 1 << 8 * random(size);
        const program = [0xbe, ...le(esi), 0xbf, ...le(edi), 0xb9, ...le(count), 0xb8, ...le(eax),
            set ? 0xfd : 0xfc, repe ? 0xf3 : 0xf2, ...form, 0xfc, 0xf4];
        // The page flagged lies on the pointers' way half the time, and is
        // then inaccessible as often as not.
        const onWay = random(2) === 0;
        const near = [esi, edi][random(2)] + (onWay ? step * random(count * size + 1)
            : (random(2) === 0 ? -1 : 1) * random(0x3000));
        const page = near & ~0xfff;
        const flag = onWay ? [PageFlag.INACCESSIBLE, PageFlag.HAS_CODE][random(2)]
            : [0, PageFlag.INACCESSIBLE, PageFlag.HAS_CODE][random(3)];
        const what = `round ${round}: ${repe ? 'repe' : 'repne'} ${form.map(b=>b.toString(16))
            .join(' ')} esi ${esi.toString(16)} edi ${edi.toString(16)} ecx ${count}`
            + ` eax ${eax.toString(16)} df ${set} stop ${stop} page ${page.toString(16)}`
            + ` flag ${flag}`;
        const reference = againstElements(program, (ram, pages)=>{
            /** @param {number} at @param {number} v */
            const put = (at, v)=>{
                for (let i = 0; i < size; i++)
                {
                    if (at + i >= LOW && at + i < LOW + SPAN)
                    {
                        ram[at + i] = v >>> 8 * i & 255;
                    }
                }
            };
            /** @param {number} at */
            const get = at=>{
                let v = 0;
                for (let i = size - 1; i >= 0; i--)
                {
                    v = (v << 8 | ram[at + i]) >>> 0;
                }
                return v;
            };
            // Bytes that tell elements apart, none of them the value's low
            // byte, so no element equals it.
            for (let i = 0; i < SPAN; i++)
            {
                const byte = (i * 7 + (i >>> 8) * 13 + round) & 255;
                ram[LOW + i] = byte === (value & 255) ? byte ^ 1 : byte;
            }
            const elements = Math.min(count, 0x3000);
            if (!overlap)
            {
                for (let k = 0; k < elements; k++)
                {
                    const at = edi + k * step;
                    if (compare)
                    {
                        // The same as the source's element, or its first byte
                        // differing.
                        const source = get(esi + k * step);
                        put(at, repe ? source : source ^ 1);
                    }
                    else if (repe)
                    {
                        put(at, value);
                    }
                }
                if (stop >= 0 && stop < elements)
                {
                    const at = edi + stop * step;
                    const other = compare ? get(esi + stop * step) : value;
                    put(at, repe ? other ^ flip : other);
                }
            }
            if (flag === PageFlag.HAS_CODE)
            {
                pages.markCode(page, 0x1000);
            }
            else if (flag !== 0)
            {
                pages.markRange(page, 0x1000, flag);
            }
        }, what, random);
        const done = count - reference.regs[1];
        if (reference.ended === 'halt' && !overlap && count > 0)
        {
            if (stop >= 0 && stop < count && done === stop + 1)
            {
                tally.stops++;
                tally.edges += choice === 1 ? 1 : 0;
                tally.last += stop === count - 1 ? 1 : 0;
            }
            tally.none += stop < 0 && done === count ? 1 : 0;
            tally.down += set && done > 0x400 ? 1 : 0;
        }
        tally.faults += reference.ended.startsWith('fault') && done > 0 ? 1 : 0;
    }
    assert.ok(tally.stops >= 60, `${tally.stops} rounds stopped on the element planted`);
    assert.ok(tally.edges >= 10, `${tally.edges} of them by a page's edge`);
    assert.ok(tally.last >= 25, `${tally.last} of them the last`);
    assert.ok(tally.none >= 40, `${tally.none} rounds that ran their count out`);
    assert.ok(tally.down >= 20, `${tally.down} rounds past a page going down`);
    assert.ok(tally.faults >= 8, `${tally.faults} rounds faulting after a compare`);
});

/** @param {number} value */
function le(value){
    return [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
}

test('a pop into memory whose destination faults leaves esp as it was', ()=>{
    // pop dword [0x5000], and pop dword [esp+0xffc], whose address takes esp
    // as the pop leaves it, into an inaccessible page: the fault is before the
    // instruction, with the stack as it was.
    /** @type {[number[], number][]} */
    const pops = [
        [[0x8f, 0x05, 0x00, 0x50, 0, 0], 0x8000],
        [[0x8f, 0x84, 0x24, 0xfc, 0x0f, 0, 0], 0x4000],
    ];
    for (const [bytes, esp] of pops)
    {
        const r = both([...bytes, 0xf4], { regs: { esp }, memory: [[esp, [1, 2, 3, 4]]],
            mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
        assert.equal(r.exit.kind, Exit.FAULT);
        assert.equal(r.exit.eip, CODE, 'at the pop');
        assert.equal(r.machine.reg('esp'), esp, 'esp as before the pop');
        agree(r);
    }
    // Where the page is there, pop dword [esp+4] stores at the moved esp + 4.
    const r = both([0x8f, 0x44, 0x24, 0x04, 0xf4], { regs: { esp: 0x8000 },
        memory: [[0x8000, [1, 2, 3, 4]]] });
    assert.equal(r.exit.kind, Exit.HALT);
    assert.equal(r.machine.reg('esp'), 0x8004);
    assert.equal(r.state.reg[4], 0x8004);
    assert.equal(r.machine.readU32(0x8008), 0x04030201);
    sameBytes(r, 0x8008, 4);
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

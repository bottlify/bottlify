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

test('a bulk rep stops on the budget with the count and the pointers of the elements it ran', ()=>{
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
    // whole budget, as one element at a time had it.
    assert.equal(m.reg('ecx'), 1000 - 100, 'a hundred elements');
    assert.equal(m.reg('edi'), 0x2000 + 100 * 4);
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

/** @param {number} value */
function le(value){
    return [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
}

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

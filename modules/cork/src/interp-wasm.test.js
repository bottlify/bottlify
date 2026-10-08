/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier in wasm against the JavaScript interpreter, its
 * reference: generated programs of the integer instructions it runs, each run
 * on both from the same state, every register, the flags word and the data
 * compared; and the ways a run ends -- an instruction left to the JavaScript
 * tier, a fault, a store into translated code, a hot start, an entry, the trap
 * port, a halt. The hardware corpus judges it in `interp-wasm.itest.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Fault, Unsupported, blockState, interpret } from './interp.js';
import {
    HOT_SLOTS, WASM_INTERPRETER_AREA, WasmExit, createWasmInterpreter,
} from './interp-wasm.js';
import { SOURCE_SHA256 } from './interp-wasm.bytes.js';
import { Tables, ownLayout, pagesFor, tablesSize } from './runtime/layout.js';
import { PageFlag, createPageTable } from './runtime/pages.js';
import { Kind, eflagsOf, kindOf } from './emit/flags.js';

const RAM = 1 << 20;
const CODE = 0x1000;
const DATA = 0x8000;
const STACK = 0x20000;
const ARITH = 0x8d5;
const TRAP_PORT = 0xb077;

test('the module is built from the source beside it', ()=>{
    // Line ends as the repository keeps them: a checkout made before
    // .gitattributes pinned them may still hold CRLF, which the compiler ignores.
    const source = readFileSync(new URL('./interp-wasm.c', import.meta.url), 'utf8')
        .replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256,
        'interp-wasm.c changed: run scripts/build-interp-wasm.mjs');
});

/** A machine in cork's own layout, the tier over it, and the JavaScript interpreter's state. */
function machine(){
    const layout = ownLayout({ ramSize: RAM, hashSlots: 1 << 16 });
    const area = layout.tables + tablesSize(layout);
    const pages = pagesFor(layout, tablesSize(layout) + WASM_INTERPRETER_AREA);
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const table = createPageTable(memory, layout);
    const tier = createWasmInterpreter({ memory, layout, area, hotThreshold: 2,
        trapPort: TRAP_PORT, parkBase: 0x100000 });
    assert.ok(tier, 'the tier runs over cork\'s own layout');
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    return { layout, memory, table, tier, bytes, view, area };
}

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A little deterministic generator. @param {number} seed */
function random(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/** Operand values that sit on the edges the flags turn on. */
const EDGES = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff,
    0x80000000, 0x80000001, 0xfffffffe, 0xffffffff, 0x12345678, 0xdeadbeef, 31, 32, 33, 8, 16];

/**
 * One generated instruction: its bytes. `ebx` points at the data, so `[ebx+d8]`
 * reaches it; every integer form the tier runs is here, with a form of the
 * JavaScript tier's among them now and then (the float forms have
 * `interp-wasm-float.test.js`).
 *
 * @param {(n: number) => number} next
 * @returns {number[]}
 */
function instruction(next){
    const reg = ()=>[0, 1, 2, 5, 6, 7][next(6)];
    const rm = ()=>(next(3) === 0 ? [0x43 | reg() << 3, next(64) & ~3]
        : [0xc0 | reg() << 3 | reg()]);
    const modrm = (/** @type {number} */ g)=>(next(3) === 0 ? [0x43 | g << 3, next(64) & ~3]
        : [0xc0 | g << 3 | reg()]);
    const imm8 = ()=>next(256);
    const imm32 = ()=>u32(EDGES[next(EDGES.length)] ^ (next(4) === 0 ? next(1 << 16) : 0));
    const prefix = ()=>(next(4) === 0 ? [0x66] : []);
    switch (next(40))
    {
        case 0: case 1: case 2: case 3:
            // add or adc sbb and sub xor cmp, every form.
            return [...prefix(), (next(8) << 3) | next(4), ...rm()];
        case 4:
            return [(next(8) << 3) | 4, imm8()];
        case 5:
        {
            // The accumulator form: its immediate is as wide as the operand.
            const word = prefix();
            return [...word, (next(8) << 3) | 5, ...imm32().slice(0, word.length > 0 ? 2 : 4)];
        }
        case 6:
            return [0x81, ...modrm(next(8)), ...imm32()];
        case 7:
            return [0x83, ...modrm(next(8)), imm8()];
        case 8:
            return [0x80, ...modrm(next(8)), imm8()];
        case 9: case 10:
        {
            // Shifts and rotates by 1, by an immediate, by cl.
            const op = [0xc0, 0xc1, 0xd0, 0xd1, 0xd2, 0xd3][next(6)];
            const bytes = [...prefix(), op, ...modrm(next(8))];
            return op < 0xc2 ? [...bytes, next(40)] : bytes;
        }
        case 11:
            // test not neg mul imul div idiv
            return [...prefix(), 0xf6 | next(2), ...modrm(2 + next(6))];
        case 12:
            return [0xf7, ...modrm(0), ...imm32()];
        case 13:
            return [...prefix(), 0x0f, 0xaf, ...rm()];
        case 14:
            return [0x69, ...rm(), ...imm32()];
        case 15:
            return [0x6b, ...rm(), imm8()];
        case 16:
            return [...prefix(), 0x0f, [0xb6, 0xb7, 0xbe, 0xbf][next(4)], ...rm()];
        case 17:
            return [0x0f, 0x90 | next(16), ...modrm(0)];
        case 18:
            return [...prefix(), 0x0f, 0x40 | next(16), ...rm()];
        case 19:
            return [...prefix(), 0x40 | reg(), ...[]];
        case 20:
            return [...prefix(), 0xfe | next(2), ...modrm(next(2))];
        case 21:
            return [...prefix(), 0x0f, [0xa3, 0xab, 0xb3, 0xbb][next(4)], ...rm()];
        case 22:
            return [...prefix(), 0x0f, 0xba, ...modrm(4 + next(4)), imm8()];
        case 23:
            return [...prefix(), 0x0f, 0xbc | next(2), ...rm()];
        case 24:
            return [...prefix(), 0x0f, [0xa4, 0xac][next(2)], ...rm(), next(40)];
        case 25:
            return [...prefix(), 0x0f, [0xa5, 0xad][next(2)], ...rm()];
        case 26:
            return [...prefix(), 0x0f, 0xb0 | next(2), ...rm()];
        case 27:
            return [...prefix(), 0x0f, 0xc0 | next(2), ...rm()];
        case 28:
            return [[0x9e, 0x9f, 0xf5, 0xf8, 0xf9, 0x98, 0x99][next(7)]];
        case 29:
            // pushf; pop reg -- the flags word into a register the comparison sees.
            return [0x9c, 0x58 | reg()];
        case 30:
            return [0x86 | next(2), ...rm()];
        case 31:
            return [...prefix(), 0x88 | next(4), ...rm()];
        case 32:
            return [0xb8 | reg(), ...imm32()];
        case 33:
            // A forward branch over a mov, taken or not.
            return [0x70 | next(16), 5, 0xb8 | reg(), ...imm32()];
        case 34:
            return [0x0f, 0x80 | next(16), 5, 0, 0, 0, 0xb8 | reg(), ...imm32()];
        case 35:
            return [0x0f, 0xc8 | reg()];
        case 36:
            // lea with a base, an index and a scale.
            return [0x8d, 0x44 | reg() << 3, next(4) << 6 | reg() << 3 | 3, imm8()];
        case 37:
            // push and pop through the stack.
            return [0x50 | reg(), 0x58 | reg()];
        case 38:
            // A 16-bit address: the JavaScript tier's.
            return [0x67, 0x90];
        default:
            return [0x90];
    }
}

/**
 * Sets the machine to a program's start: registers, flags, data, code.
 *
 * @param {ReturnType<typeof machine>} m @param {number[]} code
 * @param {(n: number) => number} next
 */
function reset(m, code, next){
    const { bytes, view, layout } = m;
    bytes.fill(0, 0, 512);
    bytes.fill(0, layout.ramBase, layout.ramBase + RAM);
    bytes.set(code, layout.ramBase + CODE);
    for (let i = 0; i < 64; i += 4)
    {
        view.setUint32(layout.ramBase + DATA + i, EDGES[next(EDGES.length)] ^ next(1 << 20), true);
    }
    for (let r = 0; r < 8; r++)
    {
        view.setUint32(layout.regs + r * 4, EDGES[next(EDGES.length)] ^ next(4), true);
    }
    view.setUint32(layout.regs + 3 * 4, DATA, true);
    view.setUint32(layout.regs + 4 * 4, STACK, true);
    view.setUint32(layout.eflags, 2 | next(0x1000) & ARITH, true);
    view.setUint16(layout.x87Control, 0x37f, true);
    view.setUint8(layout.x87Empty, 0xff);
    view.setUint32(layout.eip, CODE, true);
}

/** What a run leaves: registers, eip, the arithmetic flags, the data, the stack's top. */
function outcome(/** @type {ReturnType<typeof machine>} */ m, /** @type {string} */ ended){
    const { view, layout, bytes } = m;
    return {
        ended,
        regs: Array.from({ length: 8 }, (_, r)=>view.getUint32(layout.regs + r * 4, true)),
        eip: view.getUint32(layout.eip, true),
        flags: eflagsOf(view, layout) & ARITH,
        data: Array.from(bytes.subarray(layout.ramBase + DATA, layout.ramBase + DATA + 128)),
        stack: Array.from(bytes.subarray(layout.ramBase + STACK - 64, layout.ramBase + STACK)),
    };
}

/**
 * How a run that threw ended: a fault by its vector, an instruction with no model
 * (a program that stored over its own code runs into anything) by its name.
 *
 * @param {unknown} e
 */
function ending(e){
    if (e instanceof Fault)
    {
        return `fault ${e.vector}`;
    }
    if (e instanceof Unsupported)
    {
        return `unsupported ${e.op}`;
    }
    throw e;
}

/** Runs to the halt on the JavaScript interpreter alone. */
function runJs(/** @type {ReturnType<typeof machine>} */ m){
    const state = blockState({ memory: m.memory, layout: m.layout });
    state.syncIn();
    let ended;
    try
    {
        interpret(state, 10_000);
        ended = state.halted ? 'halt' : 'budget';
    }
    catch (e){
        ended = ending(e);
        state.eip = /** @type {{ eip: number }} */ (e).eip;
    }
    state.syncOut();
    return outcome(m, ended);
}

/** Runs to the halt on the wasm tier, the JavaScript interpreter taking what it leaves. */
function runWasm(/** @type {ReturnType<typeof machine>} */ m){
    const state = blockState({ memory: m.memory, layout: m.layout });
    let left = 10_000;
    for (;;)
    {
        const code = m.tier.run(left);
        left -= m.tier.retired();
        if (code === WasmExit.HALT)
        {
            return outcome(m, 'halt');
        }
        if (code === WasmExit.FAULT)
        {
            return outcome(m, `fault ${m.tier.exitValue()}`);
        }
        if (code === WasmExit.UNSUPPORTED)
        {
            state.syncIn();
            state.eip = m.view.getUint32(m.layout.eip, true);
            state.halted = false;
            try
            {
                left -= interpret(state, 1);
            }
            catch (e){
                const ended = ending(e);
                state.eip = /** @type {{ eip: number }} */ (e).eip;
                state.syncOut();
                return outcome(m, ended);
            }
            state.syncOut();
            if (state.halted)
            {
                return outcome(m, 'halt');
            }
        }
        if (left <= 0)
        {
            return outcome(m, 'budget');
        }
    }
}

test('generated integer programs leave what the JavaScript interpreter leaves', ()=>{
    const m = machine();
    // WASM_PROGRAMS and WASM_SEED run more, or others.
    const next = random(Number(process.env.WASM_SEED ?? 0xc0ffee));
    const count = Number(process.env.WASM_PROGRAMS ?? 4000);
    let faulted = 0;
    for (let index = 0; index < count; index++)
    {
        /** @type {number[]} */
        const code = [];
        const length = 1 + next(12);
        for (let i = 0; i < length; i++)
        {
            code.push(...instruction(next));
        }
        code.push(0xf4);
        const seed = next(1 << 30);
        reset(m, code, random(seed));
        const expected = runJs(m);
        reset(m, code, random(seed));
        const actual = runWasm(m);
        faulted += expected.ended.startsWith('fault') ? 1 : 0;
        assert.deepEqual(actual, expected, `program ${index}: ${code.map(b=>b.toString(16)
            .padStart(2, '0')).join(' ')}`);
    }
    assert.ok(faulted < count / 2, `${faulted} of ${count} faulted: the programs mostly run`);
});

test('the string instructions repeat, compare and stop as the JavaScript interpreter does', ()=>{
    const m = machine();
    const next = random(7);
    const forms = [
        [0xf3, 0xa4], [0xf3, 0xa5], [0xf3, 0x66, 0xa5], [0xa4], [0xf3, 0xaa], [0xf3, 0xab],
        [0xac], [0xf3, 0xad], [0xf3, 0xa6], [0xf2, 0xa6], [0xf3, 0xa7], [0xf2, 0xae],
        [0xf3, 0xaf], [0xa6], [0xae],
    ];
    for (const form of forms)
    {
        for (const direction of [0xfc, 0xfd])
        {
            // esi, edi into the data, a count, al/eax a byte of it.
            const code = [0xbe, ...u32(DATA + 32), 0xbf, ...u32(DATA + 64), 0xb9, ...u32(next(9)),
                0xb8, ...u32(next(4)), direction, ...form, 0xf4];
            const seed = next(1 << 30);
            reset(m, code, random(seed));
            const expected = runJs(m);
            reset(m, code, random(seed));
            assert.deepEqual(runWasm(m), expected, form.map(b=>b.toString(16)).join(' '));
        }
    }
});

test('the module is instantiated at the tier\'s first run, not when the tier is made', ()=>{
    const m = machine();
    // Its data and stack live in the page below RAM, past the state block: a
    // tier made and never run has written nothing there.
    const own = m.bytes.subarray(512, m.layout.ramBase);
    assert.ok(own.every(byte=>byte === 0), 'nothing of the module yet');
    assert.equal(m.tier.retired(), 0);
    reset(m, [0x40, 0xf4], random(10));
    assert.equal(m.tier.run(100), WasmExit.HALT);
    assert.equal(m.tier.retired(), 2);
    assert.ok(own.some(byte=>byte !== 0), 'the module\'s data, once it has run');
    assert.equal(m.tier.started(), true, 'and the process has the tier started');
    assert.equal(machine().tier.stretch, m.tier.stretch, 'one stretch for every tier of a process');
});

test('an instruction the tier does not run is left at eip, unexecuted', ()=>{
    const m = machine();
    // inc eax; cpuid; hlt
    reset(m, [0x40, 0x0f, 0xa2, 0xf4], random(1));
    m.view.setUint32(m.layout.regs, 5, true);
    assert.equal(m.tier.run(100), WasmExit.UNSUPPORTED);
    assert.equal(m.tier.retired(), 1);
    assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 1);
    assert.equal(m.view.getUint32(m.layout.regs, true), 6);
});

test('a fault leaves before the instruction\'s effect, eip at it', ()=>{
    const m = machine();
    // mov eax, 0x7fff0000; push eax; mov [eax], ecx; hlt -- past RAM, so inaccessible.
    reset(m, [0xb8, ...u32(0x7fff0000), 0x50, 0x89, 0x08, 0xf4], random(2));
    const esp = m.view.getUint32(m.layout.regs + 16, true);
    assert.equal(m.tier.run(100), WasmExit.FAULT);
    assert.equal(m.tier.exitValue(), 13);
    assert.equal(m.tier.retired(), 2);
    assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 6);
    assert.equal(m.view.getUint32(m.layout.regs + 16, true), esp - 4);
    // A divide by zero: #DE at the div.
    reset(m, [0x31, 0xc9, 0xf7, 0xf1, 0xf4], random(3));
    assert.equal(m.tier.run(100), WasmExit.FAULT);
    assert.equal(m.tier.exitValue(), 0);
    assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 2);
});

test('a store into translated code leaves after it, naming where it landed', ()=>{
    const m = machine();
    // mov [ebx+8], eax; mov [ebx+0x40], eax; hlt -- the page's code is at 0x40..0x5f.
    reset(m, [0x89, 0x43, 0x08, 0x89, 0x43, 0x40, 0xf4], random(4));
    m.table.markCode(DATA + 0x40, 0x20);
    assert.equal(m.tier.run(100), WasmExit.CODE_WRITE, 'the store beside the code is not one');
    assert.equal(m.tier.retired(), 2);
    assert.equal(m.tier.exitValue(), DATA + 0x40);
    assert.equal(m.tier.exitSize(), 4);
    assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 6, 'past the store');
});

test('a jump\'s target is counted, noted hot at the threshold and each power of two', ()=>{
    const m = machine();
    // mov ecx, 40; L: dec ecx; jnz L; hlt
    reset(m, [0xb9, 40, 0, 0, 0, 0x49, 0x75, 0xfd, 0xf4], random(5));
    /** @type {number[]} */
    const noted = [];
    for (;;)
    {
        const code = m.tier.run(1000);
        if (code === WasmExit.HOT)
        {
            assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 5);
            noted.push(m.tier.exitValue());
            continue;
        }
        assert.equal(code, WasmExit.HALT);
        break;
    }
    assert.deepEqual(noted, [2, 4, 8, 16, 32]);
    assert.equal(m.tier.hotCounts[((CODE + 5) >>> 2) & (HOT_SLOTS - 1)], 39);
    const ring = m.tier.starts;
    assert.equal(ring[(m.tier.startIndex() - 1) & 255], CODE + 5, 'the ring has the last start');
});

test('a jump to a start the entry hash holds leaves for the host to enter', ()=>{
    const m = machine();
    // jmp +2; nop; nop; hlt -- the target (CODE + 4) has an entry.
    reset(m, [0xeb, 0x02, 0x90, 0x90, 0xf4], random(6));
    const target = CODE + 4;
    const shift = m.layout.hashShift ?? 16;
    const slot = Math.imul(target, 0x9e3779b1) >>> shift;
    m.view.setUint32(m.layout.tables + Tables.HASH + slot * Tables.HASH_SLOT, target, true);
    assert.equal(m.tier.run(100), WasmExit.ENTRY);
    assert.equal(m.view.getUint32(m.layout.eip, true), target);
    assert.equal(m.tier.retired(), 1);
});

test('the trap port leaves after the write with the value, another port is the JavaScript tier\'s',
    ()=>{
        const m = machine();
        // mov eax, 42; mov dx, 0xb077; out dx, eax; out 0x80, al; hlt
        reset(m, [0xb8, 42, 0, 0, 0, 0x66, 0xba, 0x77, 0xb0, 0xef, 0xe6, 0x80, 0xf4], random(8));
        assert.equal(m.tier.run(100), WasmExit.TRAP);
        assert.equal(m.tier.exitValue(), 42);
        assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 10);
        assert.equal(m.tier.run(100), WasmExit.UNSUPPORTED);
        assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 10);
    });

test('a flag record a region left is folded before the tier reads the flags', ()=>{
    const m = machine();
    // setc al; hlt
    reset(m, [0x0f, 0x92, 0xc0, 0xf4], random(9));
    m.view.setUint32(m.layout.eflags, 2, true);
    // The record a region leaves of a 32-bit 1 - 2: borrow, so CF.
    const record = m.layout.flagRecord ?? -1;
    assert.ok(record >= 0);
    [kindOf(Kind.SUB, 4), 0xffffffff, 1, 2, 0].forEach((word, i)=>{
        m.view.setUint32(record + i * 4, word, true);
    });
    assert.equal(m.tier.run(100), WasmExit.HALT);
    assert.equal(m.view.getUint32(m.layout.regs, true) & 0xff, 1, 'CF of 1 - 2');
    assert.equal(m.view.getUint32(record, true), 0, 'the record is folded into the word');
});

test('the entry translated code calls counts its target, runs and adds to the counter', ()=>{
    const m = machine();
    // jmp +2; nop; nop; mov eax, 3; hlt -- the target (CODE + 4) has an entry, so a run
    // from the start stops there, the jump retired.
    reset(m, [0xeb, 0x02, 0x90, 0x90, 0xb8, 3, 0, 0, 0, 0xf4], random(9));
    const target = CODE + 4;
    const slot = Math.imul(target, 0x9e3779b1) >>> (m.layout.hashShift ?? 16);
    m.view.setUint32(m.layout.tables + Tables.HASH + slot * Tables.HASH_SLOT, target, true);
    const enter = m.tier.entry();
    m.view.setUint32(m.layout.counter, 100, true);
    // The start is a jump's target: counted once, cold at a threshold of two.
    assert.equal(enter(1000), WasmExit.ENTRY | 1 << 8);
    assert.equal(m.view.getUint32(m.layout.eip, true), target);
    assert.equal(m.view.getUint32(m.layout.counter, true), 101, 'what it retired, counted');
    assert.equal(m.tier.entered(), 1);
    // Counted again at the same start, it is hot: back at once for the host to note.
    m.view.setUint32(m.layout.eip, CODE, true);
    assert.equal(enter(1000), WasmExit.HOT);
    assert.equal(m.tier.exitValue(), 2);
    assert.equal(m.view.getUint32(m.layout.eip, true), CODE, 'nothing ran');
    assert.equal(m.view.getUint32(m.layout.counter, true), 101);
    // From the entry's start on, which the jump counted once: hot at the second count,
    // then run to the halt.
    m.view.setUint32(m.layout.eip, target, true);
    assert.equal(enter(1000), WasmExit.HOT);
    assert.equal(enter(1000), WasmExit.HALT | 2 << 8);
    assert.equal(m.tier.entered(), 3);
    assert.equal(m.view.getUint32(m.layout.counter, true), 103);
});

test('a jump to address 0 finds no entry in the hash\'s empty slots', ()=>{
    const m = machine();
    // xor eax, eax; jmp eax -- a call through a null pointer's jump. An empty slot's key is
    // 0, which a probe for 0 must not take for an entry.
    reset(m, [0x31, 0xc0, 0xff, 0xe0], random(10));
    assert.equal(m.tier.run(2), WasmExit.BUDGET);
    assert.equal(m.view.getUint32(m.layout.eip, true), 0);
    assert.equal(m.tier.retired(), 2);
});

test('a miss on a page with a block closed in a translated loop is left to the host', ()=>{
    const m = machine();
    // inc eax; hlt
    reset(m, [0x40, 0xf4], random(11));
    const page = CODE >>> 12;
    m.table.set(page, PageFlag.CLOSED);
    const enter = m.tier.entry();
    // No tier, as far as the transfer is concerned: it leaves untranslated, and the
    // runtime counts the miss toward the region's copies.
    assert.equal(enter(1000), 0);
    assert.equal(m.view.getUint32(m.layout.eip, true), CODE);
    assert.equal(m.tier.hotCounts[(CODE >>> 2) & (HOT_SLOTS - 1)], 0, 'nor counted here');
    m.table.clear(page, PageFlag.CLOSED);
    assert.equal(enter(1000), WasmExit.HALT | 2 << 8);
});

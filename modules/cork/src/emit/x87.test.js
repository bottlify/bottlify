/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { decode } from '../decode/decoder.js';
import { formRegion } from '../region.js';
import { CF, PF, ZF } from '../decode/table.js';
import { step, trackRegion } from './x87.js';

const CODE = 0x1000;
const DATA = 0x2000;

/**
 * Runs a program with the x87 state given, and answers the machine.
 *
 * @param {number[]} bytes
 * @param {{ data?: number[], top?: number, empty?: number, st?: Record<number, number>,
 *     regs?: Record<string, number>, eflags?: number, tagged?: [number, number[]][] }} [start]
 */
function run(bytes, start = {}){
    const { data = [], top = 0, empty = 0xff, st = {}, regs = {}, eflags = 2, tagged = [] } = start;
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Top, top);
    view.setUint8(m.layout.x87Empty, empty);
    view.setUint16(m.layout.x87Control, 0x37f, true);
    for (const [k, value] of Object.entries(st))
    {
        view.setFloat64(m.layout.x87 + Number(k) * 16, value, true);
    }
    for (const [k, raw] of tagged)
    {
        new Uint8Array(m.memory.buffer, m.layout.x87 + k * 16, 16).set(raw);
    }
    m.write(DATA, data);
    m.write(CODE, [...bytes, 0xf4]);
    m.setReg('esp', 0x80000);
    for (const [name, value] of Object.entries(regs))
    {
        m.setReg(name, value);
    }
    m.setEflags(eflags);
    const exit = m.runProgram(CODE);
    return {
        m, exit, view,
        /** ST(i) as f64. @param {number} i */
        st: i=>view.getFloat64(
            m.layout.x87 + (((view.getUint8(m.layout.x87Top) + i) & 7) * 16), true),
        top: ()=>view.getUint8(m.layout.x87Top),
        empty: ()=>view.getUint8(m.layout.x87Empty),
        status: ()=>view.getUint16(m.layout.x87Status, true),
        /** @param {number} address */
        f64: address=>view.getFloat64(m.layout.ramBase + address, true),
        /** @param {number} address */
        u32: address=>view.getUint32(m.layout.ramBase + address, true),
    };
}

/** @param {number} value */
function f64bytes(value){
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    return [...b];
}

test('the tracker: pushes, pops and the exchange as a permutation', ()=>{
    const bytes = [0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xc1, 0xdd, 0x1d, 0x00, 0x20, 0, 0, 0xf4];
    let state = { top: 0, slot: [0, 1, 2, 3, 4, 5, 6, 7] };
    const tops = [];
    let eip = 0;
    for (let i = 0; i < 4; i++)
    {
        const instruction = /** @type {any} */ (decode(a=>bytes[a], eip));
        assert.ok(!instruction.refused);
        state = /** @type {any} */ (step(instruction, state));
        tops.push(state.top);
        eip += instruction.length;
    }
    assert.deepEqual(tops, [7, 6, 7, 0], 'fld1; fld1; faddp; fstp m64');
    const xchg = [0xd9, 0xc0, 0xd9, 0xca];   // fld st0; fxch st2
    state = { top: 0, slot: [0, 1, 2, 3, 4, 5, 6, 7] };
    state = /** @type {any} */ (step(/** @type {any} */ (decode(a=>xchg[a], 0)), state));
    assert.equal(state.top, 7);
    state = /** @type {any} */ (step(/** @type {any} */ (decode(a=>xchg[a], 2)), state));
    assert.deepEqual(state.slot, [0, 7, 2, 3, 4, 5, 6, 1],
        'ST0 (register 7) and ST2 (register 1) swap locals');
});

test('the tracker over a region cuts a block met with two tops', ()=>{
    // 1000: fld1            top 7
    // 1002: jz 1006         taken: 1006 with top 7
    // 1004: fld1            top 6, falling into 1006
    // 1006: hlt             met with 7 and 6: cut
    const m = createTestMachine();
    m.write(CODE, [0xd9, 0xe8, 0x74, 0x02, 0xd9, 0xe8, 0xf4]);
    const region = formRegion(a=>new Uint8Array(m.memory.buffer)[m.layout.ramBase + a], CODE);
    const { states, cut } = trackRegion(region, 0);
    assert.equal(states[0]?.top, 0);
    const at = region.blocks.findIndex(block=>block.start === 0x1006);
    assert.ok(at >= 0);
    assert.ok(cut.has(at), `the join block is cut; states ${JSON.stringify(states)}`);
    const other = region.blocks.findIndex(block=>block.start === 0x1004);
    assert.equal(states[other]?.top, 7,
        'the fall-through block is entered with the first push done');
    // Run it: the cut block leaves for the other executor at its start.
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, 'a second region, compiled for the top met, finishes the program');
    assert.equal(exit.regions, 2);
});

test('the tracker seeds the entry block, wherever it lies in address order', ()=>{
    // A region formed at the return address of a call whose callee returns a
    // value on the x87 stack: the call site's block joins the region below
    // the entry, and the seed belongs to the entry, not to the first block.
    //
    // 1000 L: call F          1100 F: fld1
    // 1005 RA: fstp [DATA]          ret
    // 100b     dec ecx
    // 100c     jnz L
    // 100e     hlt
    const m = createTestMachine();
    m.write(CODE, [
        0xe8, 0xfb, 0, 0, 0,                  // L:    call F
        0xdd, 0x1d, 0, 0x20, 0, 0,            // RA:   fstp qword [DATA]
        0x49,                                 //       dec ecx
        0x75, 0xf2,                           //       jnz L
        0xf4,                                 //       hlt
    ]);
    m.write(CODE + 0x100, [0xd9, 0xe8, 0xc3]);
    /** @param {number} address */
    const read = address=>new Uint8Array(m.memory.buffer)[m.layout.ramBase + address];
    const region = formRegion(read, CODE + 5);
    const entry = region.blocks.findIndex(block=>block.start === CODE + 5);
    assert.equal(entry, 1, 'the block below the entry in address order is the call site');
    const { states } = trackRegion(region, 7);
    assert.equal(states[entry]?.top, 7, 'the entry block carries the top it was formed at');
    assert.equal(states[0]?.top, 0, 'the loop body is tracked from the back edge, balanced');
    // Run the loop: the region at the return address retires the store the
    // mistargeted seed refused, and the program halts.
    m.setReg('esp', 0x80000);
    m.setReg('ecx', 1000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, `left out ${[...exit.unsupported]}`);
    assert.equal(exit.regions, 3, 'the loop, the callee, the return address at its top');
    assert.deepEqual([...exit.unsupported], [['dd 1d', 1]],
        'the one refusal of the first formation, while the return top was unknown');
    assert.equal(exit.retired, 6001);
    assert.equal(m.reg('ecx'), 0);
    assert.equal(new DataView(m.memory.buffer).getFloat64(m.layout.ramBase + DATA, true), 1);
});

test('load, multiply, store: fld m64; fmul m64; fstp m64 writes the product', ()=>{
    const r = run([
        0xdd, 0x05, 0x00, 0x20, 0, 0,        // fld qword [DATA]       2.5
        0xdc, 0x0d, 0x08, 0x20, 0, 0,        // fmul qword [DATA+8]    4
        0xdd, 0x1d, 0x10, 0x20, 0, 0,        // fstp qword [DATA+16]
    ], { data: [...f64bytes(2.5), ...f64bytes(4)] });
    assert.equal(r.exit.kind, 3, `left out ${[...r.exit.unsupported]}`);
    assert.equal(r.f64(DATA + 16), 10);
    assert.equal(r.top(), 0);
    assert.equal(r.empty(), 0xff, 'popped: every register empty again');
});

test('fld1; fld1; fsubp leaves 0 and the empty mask after the store', ()=>{
    const r = run([0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xe9, 0xdd, 0x1d, 0x00, 0x20, 0, 0]);
    assert.equal(r.exit.kind, 3);
    assert.equal(r.f64(DATA), 0);
    assert.equal(r.empty(), 0xff);
    assert.equal(r.top(), 0);
    const held = run([0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xe9]);
    assert.equal(held.top(), 7);
    assert.equal(held.empty(), 0x7f, 'register 7 held after fld1; fld1; fsubp');
    assert.equal(held.st(0), 0);
});

test('fstp m32 rounds to the nearest single; fxch stores the other register', ()=>{
    const r = run([
        0xdd, 0x05, 0x00, 0x20, 0, 0,        // fld qword [DATA]     1.1
        0xd9, 0x1d, 0x08, 0x20, 0, 0,        // fstp dword [DATA+8]
    ], { data: f64bytes(1.1) });
    assert.equal(r.u32(DATA + 8), 0x3f8ccccd);
    const x = run([
        0xd9, 0xe8,                          // fld1
        0xd9, 0xee,                          // fldz
        0xd9, 0xc9,                          // fxch st1
        0xdd, 0x1d, 0x00, 0x20, 0, 0,        // fstp qword [DATA]   the 1, now ST0
        0xdd, 0x1d, 0x08, 0x20, 0, 0,        // fstp qword [DATA+8] the 0
    ]);
    assert.equal(x.f64(DATA), 1);
    assert.equal(x.f64(DATA + 8), 0);
});

test('fcomi sets ZF PF CF as cmp would; fcom sets the condition bits', ()=>{
    // fld1; fldz; fcomi st0, st1 (0 < 1); pushf; pop eax
    const less = run([0xd9, 0xe8, 0xd9, 0xee, 0xdb, 0xf1, 0x9c, 0x58], {});
    assert.equal(less.m.reg('eax') & (ZF | PF | CF), CF, '0 < 1: CF');
    const equal = run([0xd9, 0xe8, 0xd9, 0xe8, 0xdb, 0xf1, 0x9c, 0x58]);
    assert.equal(equal.m.reg('eax') & (ZF | PF | CF), ZF);
    const nan = run([0xd9, 0xe8, 0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdb, 0xf1, 0x9c, 0x58],
        { data: f64bytes(NaN) });
    assert.equal(nan.m.reg('eax') & (ZF | PF | CF), ZF | PF | CF, 'unordered');
    assert.equal(nan.status() & 1, 1, 'fcomi with a NaN is invalid');
    // fcom st1 with 1 < 2: C0 set, then fnstsw ax
    const com = run([0xd9, 0xe8, 0xdd, 0x05, 0x00, 0x20, 0, 0, 0xd8, 0xd1, 0xdf, 0xe0],
        { data: f64bytes(0.5) }); // fld1; fld 0.5; fcom st1 (0.5 < 1); fnstsw ax
    assert.equal(com.m.reg('eax') & 0x4500, 0x0100, 'C0');
    assert.equal(com.m.reg('eax') >>> 11 & 7, 6, 'the top in the word');
});

test('a region entered with top 6 reads the emulator tagged form without the import', ()=>{
    // The state block in cork's own layout holds f64; the tagged form is the
    // emulator's. Both are read: here the own form, with two registers held.
    const r = run([
        0xde, 0xc1,                          // faddp st1, st0
        0xdd, 0x1d, 0x00, 0x20, 0, 0,        // fstp qword [DATA]
    ], { top: 6, empty: 0x3f, st: { 6: 2.25, 7: 4 } });
    assert.equal(r.exit.kind, 3);
    assert.equal(r.f64(DATA), 6.25);
    assert.equal(r.top(), 0);
    assert.equal(r.empty(), 0xff);
});

test('fild, fist and fistp: integers in and out, rounding to nearest even, the indefinite', ()=>{
    const r = run([
        0xdf, 0x05, 0x00, 0x20, 0, 0,        // fild word [DATA]      -7
        0xdb, 0x1d, 0x08, 0x20, 0, 0,        // fistp dword [DATA+8]
        0xdd, 0x05, 0x10, 0x20, 0, 0,        // fld qword [DATA+16]   2.5
        0xdb, 0x1d, 0x18, 0x20, 0, 0,        // fistp dword [DATA+24] -> 2 (even)
        0xdd, 0x05, 0x20, 0x20, 0, 0,        // fld qword [DATA+32]   3.5
        0xdb, 0x1d, 0x28, 0x20, 0, 0,        // fistp dword [DATA+40] -> 4
        0xdd, 0x05, 0x30, 0x20, 0, 0,        // fld qword [DATA+48]   1e12
        0xdb, 0x1d, 0x38, 0x20, 0, 0,        // fistp dword [DATA+56] -> indefinite
        0xdd, 0x05, 0x20, 0x20, 0, 0,        // fld 3.5
        0xdb, 0x0d, 0x40, 0x20, 0, 0,        // fisttp dword [DATA+64] -> 3
    ], { data: [0xf9, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ...f64bytes(2.5), ...new Array(8).fill(0), ...f64bytes(3.5), ...new Array(8).fill(0),
        ...f64bytes(1e12)] });
    assert.equal(r.exit.kind, 3);
    assert.equal(r.u32(DATA + 8) | 0, -7);
    assert.equal(r.u32(DATA + 24), 2);
    assert.equal(r.u32(DATA + 40), 4);
    assert.equal(r.u32(DATA + 56), 0x80000000);
    assert.equal(r.status() & 1, 1, 'the out-of-range store is invalid');
    assert.equal(r.u32(DATA + 64), 3);
});

test('an 80-bit load and store round-trip through the conversion helpers', ()=>{
    // 1.5 as extended: mantissa 0xc000000000000000, exponent 16383
    const r = run([
        0xdb, 0x2d, 0x00, 0x20, 0, 0,        // fld tword [DATA]
        0xdd, 0x15, 0x10, 0x20, 0, 0,        // fst qword [DATA+16]
        0xdb, 0x3d, 0x20, 0x20, 0, 0,        // fstp tword [DATA+32]
    ], { data: [0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0x3f] });
    assert.equal(r.f64(DATA + 16), 1.5);
    assert.deepEqual([...r.m.read(DATA + 32, 10)], [0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0x3f]);
    const neg = run([0xdd, 0x05, 0x00, 0x20, 0, 0, 0xdb, 0x3d, 0x10, 0x20, 0, 0,
        0xdb, 0x2d, 0x10, 0x20, 0, 0, 0xdd, 0x1d, 0x20, 0x20, 0, 0],
    { data: f64bytes(-0.1) });
    assert.equal(neg.f64(DATA + 32), -0.1, 'a double survives the extended form');
});

test('fdiv by zero raises ZE, fsqrt of a negative IE, a NaN result out of numbers IE', ()=>{
    const zero = run([0xd9, 0xee, 0xd9, 0xe8, 0xde, 0xf9]); // fldz; fld1; fdivp st1, st0 -> 0/1? no: st1 = st1 / st0 = 0/1
    assert.equal(zero.status() & 4, 0);
    const byZero = run([0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9]); // fld1; fldz; fdivp: st1 = 1 / 0
    assert.equal(byZero.status() & 4, 4, 'ZE');
    assert.equal(byZero.st(0), Infinity);
    const sqrt = run([0xd9, 0xe8, 0xd9, 0xe0, 0xd9, 0xfa]); // fld1; fchs; fsqrt
    assert.equal(sqrt.status() & 1, 1, 'IE');
    assert.ok(Number.isNaN(sqrt.st(0)));
    const inf = run([0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9, 0xd9, 0xc0, 0xde, 0xe9]);
    // 1/0 = inf; fld st0; fsubp: inf - inf = NaN -> IE
    assert.equal(inf.status() & 1, 1);
});

test('fxam classifies, fninit resets, ffree empties, fincstp moves the top', ()=>{
    const r = run([0xd9, 0xee, 0xd9, 0xe5, 0xdf, 0xe0]); // fldz; fxam; fnstsw ax
    assert.equal(r.m.reg('eax') & 0x4500, 0x4000, 'zero: C3');
    const init = run([0xd9, 0xe8, 0xd9, 0xe8, 0xdb, 0xe3]);
    assert.equal(init.top(), 0);
    assert.equal(init.empty(), 0xff);
    const free = run([0xd9, 0xe8, 0xdd, 0xc0, 0xd9, 0xf7]); // fld1; ffree st0; fincstp
    assert.equal(free.empty(), 0xff);
    assert.equal(free.top(), 0);
});

test('a loop with fxch inside: the edge into the header moves registers to match', ()=>{
    // ecx = 3; fld1; fldz; L: fxch st1; faddp? no -- keep the stack balanced:
    // L: fadd st0, st1 ; fxch st1 ; dec ecx ; jnz L ; -> after 3 rounds: values known
    const r = run([
        0xb9, 0x03, 0, 0, 0,                 // mov ecx, 3
        0xd9, 0xe8,                          // fld1          st0 = 1
        0xd9, 0xe8,                          // fld1          st0 = 1, st1 = 1
        0xd8, 0xc1,                          // L: fadd st0, st1
        0xd9, 0xc9,                          // fxch st1
        0x49,                                // dec ecx
        0x75, 0xf9,                          // jnz L
        0xde, 0xc1,                          // faddp st1, st0
        0xdd, 0x1d, 0x00, 0x20, 0, 0,        // fstp qword [DATA]
    ]);
    assert.equal(r.exit.kind, 3, `left out ${[...r.exit.unsupported]}`);
    // Round 1: (1+1, 1) -> fxch -> (1, 2); round 2: (3, 2) -> (2, 3);
    // round 3: (5, 3) -> (3, 5); sum 8.
    assert.equal(r.f64(DATA), 8);
    assert.equal(r.exit.regions, 1, 'one region: the back edge is inside it');
});

test('a push onto a full stack sets C1, and a push that fits clears it', ()=>{
    // Eight pushes fill the stack; the ninth overflows, which sets C1 (with the
    // IE and SF the fault raises) to say the stack faulted upward, as the
    // processor does. The emitter set IE and SF but not C1. The sequence corpus
    // met it at the crossover, where an MMX instruction holds every register and
    // the x87 push after it overflows -- the same fault, reached another way.
    const full = Array(8).fill([0xd9, 0xe8]).flat();       // fld1 x8 fills the stack
    const over = run([...full, 0xd9, 0xe8]);               // the ninth overflows
    assert.equal(over.exit.kind, 3, `left out ${[...over.exit.unsupported]}`);
    assert.equal(over.status() & 0x241, 0x241, 'IE, SF and C1 on the overflow');
    // A push that fits clears C1: the processor leaves it saying which way the
    // last push faulted. Overflow, pop one so the next push fits, push again.
    //   fld1 (overflow), fstp st0 (pop one), fld1 (fits -> clears C1)
    const cleared = run([...full, 0xd9, 0xe8, 0xdd, 0xd8, 0xd9, 0xe8]);
    assert.equal(cleared.exit.kind, 3, `left out ${[...cleared.exit.unsupported]}`);
    assert.equal(cleared.status() & 0x200, 0, 'a push that fits cleared C1');
});


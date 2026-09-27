/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier on the integer set: the decoder of 2.1 and the
 * evaluator of 2.2 run one instruction at a time over a memory, a budget
 * bounding a run that does not halt, and the state block reached directly so
 * what a program leaves is what the translator would leave.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Fault, interpret, blockState } from './interp.js';
import { createState } from './ir.js';
import { ownLayout, pagesFor, Tables } from './runtime/layout.js';
import { PageFlag } from './runtime/pages.js';

/** A little machine and a state over it. */
function machine(){
    const ram = new Uint8Array(0x10000);
    const view = new DataView(ram.buffer);
    const memory = {
        /** @param {number} address @param {number} size */
        read: (address, size)=>size === 1 ? ram[address]
            : size === 2 ? view.getUint16(address, true) : view.getUint32(address, true),
        /** @param {number} address @param {number} size @param {number} value */
        write: (address, size, value)=>{
            if (size === 1)
            {
                ram[address] = value;
            }
            else if (size === 2)
            {
                view.setUint16(address, value, true);
            }
            else
            {
                view.setUint32(address, value, true);
            }
        },
    };
    const state = createState(memory, { eip: 0x1000, esp: 0xf000 });
    return { ram, state };
}

test('the interpreter runs integer instructions and halts', ()=>{
    // mov eax, 5; add eax, 3; hlt
    const m = machine();
    m.ram.set([0xb8, 5, 0, 0, 0, 0x83, 0xc0, 0x03, 0xf4], 0x1000);
    const retired = interpret(m.state, 100);
    assert.equal(retired, 3);
    assert.equal(m.state.reg[0], 8);
    assert.equal(m.state.halted, true);
});

test('code rewritten in place is decoded again, not answered from the cache', ()=>{
    // mov eax, 5; hlt -- run, then the immediate rewritten to 9 and run again.
    const m = machine();
    m.ram.set([0xb8, 5, 0, 0, 0, 0xf4], 0x1000);
    interpret(m.state, 100);
    assert.equal(m.state.reg[0], 5);
    m.ram[0x1001] = 9;
    m.state.eip = 0x1000;
    m.state.halted = false;
    interpret(m.state, 100);
    assert.equal(m.state.reg[0], 9);
});

test('a budget bounds a loop', ()=>{
    // mov ecx, 4; L: dec ecx; jnz L; hlt
    const m = machine();
    m.ram.set([0xb9, 4, 0, 0, 0, 0x49, 0x75, 0xfd, 0xf4], 0x1000);
    const retired = interpret(m.state, 2);
    assert.equal(retired, 2, 'the budget stopped it mid-loop');
    assert.equal(m.state.reg[1], 3, 'after the first dec');
    const rest = interpret(m.state, 100);
    assert.equal(m.state.halted, true, 'and it finishes when given the budget');
    assert.equal(m.state.reg[1], 0);
    assert.equal(rest, 8, 'the three more turns and the hlt');
});

test('onStep says which starts a jump reached, and a resumed run starts mid-block', ()=>{
    // mov ecx, 2; L: dec ecx; jnz L; hlt
    const m = machine();
    m.ram.set([0xb9, 2, 0, 0, 0, 0x49, 0x75, 0xfd, 0xf4], 0x1000);
    /** @type {string[]} */
    const seen = [];
    /** @param {number} at @param {boolean} jumped */
    const onStep = (at, jumped)=>seen.push(`${at.toString(16)}${jumped ? '*' : ''}`);
    interpret(m.state, 2, { onStep });
    interpret(m.state, 100, { onStep });
    // The second run begins at the jnz, where the first stopped: not a jump's
    // target; the loop's head is, the second time round.
    assert.deepEqual(seen, ['1000', '1005', '1006', '1005*', '1006', '1008']);
    /** @type {boolean[]} */
    const entered = [];
    m.state.eip = 0x1005;
    m.state.halted = false;
    interpret(m.state, 1, { onStep: (at, jumped)=>entered.push(jumped), entered: true });
    assert.deepEqual(entered, [true], 'a run entered at a jump target counts its first start');
});

test('xadd writes the sum where its destination was before the source register changed', ()=>{
    // mov ebx, 0x2010; mov byte [ebx], 5; xadd [ebx], bh; hlt -- bh (0x20) takes the old
    // byte, which moves ebx; the sum still lands at 0x2010.
    const m = machine();
    m.ram.set([0xbb, 0x10, 0x20, 0, 0, 0xc6, 0x03, 5, 0x0f, 0xc0, 0x3b, 0xf4], 0x1000);
    interpret(m.state, 100);
    assert.equal(m.ram[0x2010], 0x25);
    assert.equal(m.state.reg[3], 0x0510);
    assert.equal(m.ram[0x0510], 0, 'nothing written where ebx points now');
});

test('xorps xors the two XMM operands and movd reaches a register', ()=>{
    // movd xmm0, eax; movd xmm1, ecx; xorps xmm0, xmm1; movd eax, xmm0; hlt
    const m = machine();
    m.ram.set([
        0x66, 0x0f, 0x6e, 0xc0, 0x66, 0x0f, 0x6e, 0xc9, 0x0f, 0x57, 0xc1, 0x66, 0x0f, 0x7e, 0xc0,
        0xf4,
    ], 0x1000);
    m.state.reg[0] = 0xf0f0f0f0;
    m.state.reg[1] = 0x0ff00ff0;
    const retired = interpret(m.state, 100);
    assert.equal(retired, 5);
    assert.equal(m.state.reg[0] >>> 0, 0xff00ff00, 'the xor, not the and, in the low lane');
    assert.equal(m.state.xmm[0] >>> 0, 0xff00ff00, 'the xor in the register word');
    assert.equal(m.state.xmm[1], 0, 'and the upper words clear');
});

test('force runs the first instruction whatever shouldStop answers', ()=>{
    // mov eax, 7; inc eax; hlt
    const m = machine();
    m.ram.set([0xb8, 7, 0, 0, 0, 0x40, 0xf4], 0x1000);
    // A stop before the first instruction: nothing runs.
    assert.equal(interpret(m.state, 100, { shouldStop: ()=>true }), 0);
    assert.equal(m.state.reg[0], 0);
    // Forced, the first instruction runs and the stop applies from then on:
    // the host's progress guarantee for a turn that would retire nothing.
    assert.equal(interpret(m.state, 100, { shouldStop: ()=>true, force: true }), 1);
    assert.equal(m.state.reg[0] >>> 0, 7);
    assert.equal(interpret(m.state, 100, { shouldStop: ()=>true, force: true }), 1);
    assert.equal(m.state.reg[0] >>> 0, 8);
});

test('asked runs the first run without the question and asks from the next on', ()=>{
    // mov eax, 7; inc eax; mov ecx, 1; hlt
    const m = machine();
    m.ram.set([0xb8, 7, 0, 0, 0, 0x40, 0xb9, 1, 0, 0, 0, 0xf4], 0x1000);
    /** @type {number[]} */
    const asked = [];
    const shouldStop = ()=>{
        asked.push(m.state.eip);
        return m.state.eip === 0x1006;
    };
    // The host has just looked at 0x1000 itself: the first run goes ahead
    // without the question, and it is asked again from the next run on.
    assert.equal(interpret(m.state, 100, { shouldStop, asked: true }), 2);
    assert.equal(asked[0], 0x1005);
    assert.equal(asked.at(-1), 0x1006);
    assert.equal(m.state.reg[0] >>> 0, 8);
    assert.equal(m.state.reg[1], 0, 'the stop held');
    // Not asked, the first run is asked like any other.
    asked.length = 0;
    assert.equal(interpret(m.state, 100, { shouldStop }), 0);
    assert.deepEqual(asked, [0x1006]);
});

test('an instruction with no model throws Unsupported', ()=>{
    // A form no user program runs and the evaluator has no case for: sldt.
    const m = machine();
    m.ram.set([0x0f, 0x00, 0x00], 0x1000); // sldt [eax]
    // `evaluate` counts and advances before it decides it has no case; the
    // host answers the throw for the instruction, not for the count.
    assert.throws(()=>interpret(m.state, 1), /no model for/);
});

test('blockState runs over cork\'s own state block', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    // mov eax, 0x1234; inc eax; hlt
    ram.set([0xb8, 0x34, 0x12, 0, 0, 0x40, 0xf4], 0x1000);
    const state = blockState({ memory, layout });
    state.eip = 0x1000;
    const retired = interpret(state, 100);
    state.syncOut();
    assert.equal(retired, 3);
    const reg32 = new Int32Array(memory.buffer, layout.regs, 8);
    assert.equal(reg32[0] >>> 0, 0x1235);
    const view = new DataView(memory.buffer);
    assert.equal(view.getUint32(layout.eip, true), 0x1007);
});

test('blockState faults on an inaccessible page and reports a code write', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const flags = new Uint8Array(
        memory.buffer, layout.tables + Tables.PAGE_FLAGS, Tables.PAGE_FLAGS_SIZE);
    const ranges = new Uint8Array(memory.buffer, layout.tables + Tables.CODE_RANGES, 1 << 21);
    /** @type {[number, number][]} */
    const writes = [];
    const state = blockState({
        memory, layout, onCodeWrite: (address, size)=>writes.push([address, size]),
    });
    // A #GP before the instruction, at the instruction's own address rather
    // than the next one `evaluate` leaves in eip.
    flags[0x30] = PageFlag.INACCESSIBLE;
    state.faultEip = 0x30000;
    assert.throws(()=>state.memory.read(0x30000, 1),
        e=>e instanceof Fault && e.vector === 13 && e.eip === 0x30000);
    assert.throws(()=>state.memory.write(0x30000, 4, 0),
        e=>e instanceof Fault && e.vector === 13);
    // A write into a page holding translated code reports it, so the caller
    // can invalidate; a write outside the code's granules does not.
    flags[0x40] = PageFlag.HAS_CODE;
    ranges[0x40 * 2] = 0;
    ranges[0x40 * 2 + 1] = 2;
    state.memory.write(0x40000, 4, 0x11223344);
    assert.deepEqual(writes, [[0x40000, 4]]);
    state.memory.write(0x40f00, 1, 0);
    assert.deepEqual(writes, [[0x40000, 4]], 'beside the code, no report');
    // An access that crosses into the next page is judged by that page too: a
    // read or a write into an inaccessible one faults, a write whose last byte
    // lands in translated code reports.
    assert.throws(()=>state.memory.read(0x2fffe, 4), e=>e instanceof Fault);
    assert.throws(()=>state.memory.write(0x2ffff, 2, 0), e=>e instanceof Fault);
    state.memory.write(0x3fffe, 4, 0);
    assert.deepEqual(writes, [[0x40000, 4], [0x3fffe, 4]]);
});

test('a push, a call, a leave and an SSE store that fault leave esp and memory as they were', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    const flags = new Uint8Array(
        memory.buffer, layout.tables + Tables.PAGE_FLAGS, Tables.PAGE_FLAGS_SIZE);
    const reg32 = new Uint32Array(memory.buffer, layout.regs, 8);
    flags[0x4] = PageFlag.INACCESSIBLE;
    const state = blockState({ memory, layout });
    /** @param {number[]} bytes @param {Record<number, number>} regs */
    const faults = (bytes, regs)=>{
        ram.set(bytes, 0x1000);
        state.syncIn();
        Object.entries(regs).forEach(([r, value])=>{
            state.reg[Number(r)] = value;
        });
        state.eip = 0x1000;
        assert.throws(()=>interpret(state, 1), e=>e instanceof Fault && e.vector === 13);
        state.syncOut();
    };
    // push eax, call +0 with esp at the page's end: esp as before.
    faults([0x50], { 4: 0x5000 });
    assert.equal(reg32[4], 0x5000);
    faults([0xe8, 0, 0, 0, 0], { 4: 0x5000 });
    assert.equal(reg32[4], 0x5000);
    // leave with ebp in the page: esp not moved to ebp.
    faults([0xc9], { 4: 0x6000, 5: 0x4800 });
    assert.equal(reg32[4], 0x6000);
    // movss [ecx], xmm0 over the page's start: no byte of it before the page.
    ram[0x3ffe] = 0x55;
    faults([0xf3, 0x0f, 0x11, 0x01], { 1: 0x3ffe });
    assert.equal(ram[0x3ffe], 0x55, 'nothing written');
});

test('blockState keeps its fields fast and sees code rewritten in place', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    const state = blockState({ memory, layout });
    // The step's fields are the object's own and the accessors its
    // prototype's: one literal holding both fell into V8's dictionary mode.
    assert.deepEqual(Object.keys(state).sort(), ['eflags', 'eip', 'f80Values', 'f80Words',
        'faultEip', 'halted', 'layout', 'memory', 'rdtsc', 'reg', 'retired', 'trapped', 'view',
        'x87Exact', 'x87In', 'x87Shadow', 'xmmIn', 'xmmWords']);
    for (const accessor of ['f80', 'f80bits', 'xmm', 'top', 'empty', 'status', 'control',
        'mxcsr', 'fsBase'])
    {
        assert.ok(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(state), accessor)?.get,
            `${accessor} is the prototype's`);
    }
    // mov eax, imm32 across a page boundary, then hlt; run, rewrite the
    // immediate's byte in the second page, run again.
    const at = 0x1ffe;
    ram.set([0xb8, 1, 2, 3, 4, 0xf4], at);
    state.eip = at;
    interpret(state, 10);
    assert.equal(state.reg[0], 0x04030201);
    ram[at + 3] = 9;
    state.eip = at;
    state.halted = false;
    interpret(state, 10);
    assert.equal(state.reg[0], 0x04090201);
    // And within one page.
    ram.set([0xb8, 1, 0, 0, 0, 0xf4], 0x3000);
    state.eip = 0x3000;
    state.halted = false;
    interpret(state, 10);
    ram[0x3001] = 7;
    state.eip = 0x3000;
    state.halted = false;
    interpret(state, 10);
    assert.equal(state.reg[0], 7);
});

test('a quadword fild\'s exact value does not outlive a sync, where other code may write it', ()=>{
    // fild qword [0x2000] of 2^53 + 1 interpreted; then the register rewritten
    // in the block to 2^53, the double the quadword rounds to, as translated
    // code may; then fistp qword [0x2008] interpreted: 2^53, not the quadword.
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const view = new DataView(memory.buffer);
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    view.setUint8(layout.x87Empty, 0xff);
    view.setUint16(layout.x87Control, 0x37f, true);
    view.setBigInt64(layout.ramBase + 0x2000, (1n << 53n) + 1n, true);
    ram.set([0xdf, 0x2d, 0x00, 0x20, 0, 0, 0xf4, 0xdf, 0x3d, 0x08, 0x20, 0, 0, 0xf4], 0x1000);
    const state = blockState({ memory, layout });
    state.syncIn();
    state.eip = 0x1000;
    interpret(state, 10);
    state.syncOut();
    view.setFloat64(layout.x87 + 7 * 16, 2 ** 53, true);
    state.syncIn();
    state.eip = 0x1007;
    state.halted = false;
    interpret(state, 10);
    state.syncOut();
    assert.equal(view.getBigInt64(layout.ramBase + 0x2008, true), 1n << 53n);
    // In one run, the quadword itself.
    ram.set([0xdf, 0x2d, 0x00, 0x20, 0, 0, 0xdf, 0x3d, 0x08, 0x20, 0, 0, 0xf4], 0x1100);
    state.syncIn();
    state.eip = 0x1100;
    state.halted = false;
    interpret(state, 20);
    state.syncOut();
    assert.equal(view.getBigInt64(layout.ramBase + 0x2008, true), (1n << 53n) + 1n);
});

test('fxsave writes the x87 and SSE image and fxrstor reads it back', ()=>{
    // fld1; movd xmm0, eax; fxsave [0x2000]; fstp st0; fxrstor [0x2000]; hlt
    const m = machine();
    m.ram.set([
        0xd9, 0xe8, 0x66, 0x0f, 0x6e, 0xc0, 0x0f, 0xae, 0x05, 0x00, 0x20, 0, 0,
        0xdd, 0xd8, 0x0f, 0xae, 0x0d, 0x00, 0x20, 0, 0, 0xf4,
    ], 0x1000);
    m.state.reg[0] = 0x12345678;
    interpret(m.state, 100);
    const view = new DataView(m.ram.buffer);
    assert.equal(view.getUint16(0x2000, true), 0x37f, 'the control word');
    assert.equal(view.getUint16(0x2002, true) >>> 11 & 7, 7, 'the top in the status word');
    assert.equal(m.ram[0x2004], 0x80, 'physical register 7 held');
    assert.equal(view.getUint32(0x2018, true), 0x1f80, 'MXCSR');
    assert.equal(view.getUint32(0x201c, true), 0xffbf, 'the mask, without DAZ');
    assert.equal(view.getBigUint64(0x2020, true), 0x8000000000000000n, 'ST(0) = 1.0, its mantissa');
    assert.equal(view.getUint16(0x2028, true), 0x3fff, 'and its exponent');
    assert.equal(view.getUint32(0x20a0, true), 0x12345678, 'XMM0');
    assert.equal(m.state.top, 7, 'fxrstor put back the top fstp moved');
    assert.equal(m.state.empty & 0x80, 0, 'and the register it emptied');
    assert.equal(m.state.f80[7], 1);
    assert.equal(m.state.halted, true);
});

test('a run of instructions sees a store into its own bytes decoded before it', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    // mov [0x100a], al; nop; nop; add ecx, imm8; hlt -- the store rewrites the
    // add's immediate. The first run decodes the add after the store; the
    // second finds the run decoded already and must see the store all the same.
    ram.set([0x88, 0x05, 0x0a, 0x10, 0, 0, 0x90, 0x90, 0x83, 0xc1, 0, 0xf4], 0x1000);
    const state = blockState({ memory, layout });
    state.reg[0] = 3;
    state.eip = 0x1000;
    interpret(state, 10);
    assert.equal(state.reg[1], 3);
    /** @type {number[]} */
    const starts = [];
    state.reg[0] = 5;
    state.eip = 0x1000;
    state.halted = false;
    interpret(state, 10, { onStep: at=>starts.push(at) });
    assert.equal(state.reg[1], 8, 'the immediate as the second store left it');
    assert.deepEqual(starts, [0x1000, 0x1006], 'the run ended after the store and resumed');
});

test('a rep stos moved in bulk over its own run\'s bytes ends the run as a store does', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    // mov edi, 0x100f; mov ecx, 1; rep stosb; nop; add ecx, imm8; hlt -- the
    // rep rewrites the add's immediate, as the store above does.
    ram.set([0xbf, 0x0f, 0x10, 0, 0, 0xb9, 1, 0, 0, 0, 0xf3, 0xaa, 0x90, 0x83, 0xc1, 0, 0xf4],
        0x1000);
    const state = blockState({ memory, layout });
    const bulk = /** @type {NonNullable<import('./ir.js').Memory['repeat']>} */ (
        state.memory.repeat).bind(state.memory);
    let moved = 0;
    state.memory.repeat = (...args)=>{
        const done = bulk(...args);
        moved += done;
        return done;
    };
    state.reg[0] = 3;
    state.eip = 0x1000;
    interpret(state, 10);
    assert.equal(state.reg[1], 3);
    /** @type {number[]} */
    const starts = [];
    state.reg[0] = 5;
    state.eip = 0x1000;
    state.halted = false;
    interpret(state, 10, { onStep: at=>starts.push(at) });
    assert.equal(moved, 2, 'both stores went in bulk');
    assert.equal(state.reg[1], 5, 'the immediate as the second rep left it');
    assert.deepEqual(starts, [0x1000, 0x100c], 'the run ended after the rep and resumed');
});

test('every machine\'s state and memory have one shape, whatever the machine', ()=>{
    // The interpreter's steps are one set of functions for every machine in a
    // process: states of two shapes make every access to them polymorphic, of
    // five megamorphic. Two machines over memories and layouts of their own,
    // one with the host's callbacks and one without, compared by V8 itself.
    const interp = JSON.stringify(new URL('./interp.js', import.meta.url).href);
    const layouts = JSON.stringify(new URL('./runtime/layout.js', import.meta.url).href);
    const script = `
        import { blockState } from ${interp};
        import { ownLayout, pagesFor, Tables } from ${layouts};
        const made = [[1 << 20, true], [1 << 21, false]].map(([ramSize, host])=>{
            const layout = ownLayout({ ramSize });
            const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
            return blockState(host ? { memory, layout, onCodeWrite: ()=>{}, rdtsc: ()=>0n }
                : { memory, layout });
        });
        made[1].syncIn();
        console.log(JSON.stringify([%HaveSameMap(made[0], made[1]),
            %HaveSameMap(made[0].memory, made[1].memory)]));`;
    const answer = execFileSync(process.execPath,
        ['--allow-natives-syntax', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(answer), [true, true], 'the states, then their memories');
});

test('a compiled lea step with an fs: override leaves the segment out', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    ram.set([0x64, 0x8d, 0x43, 0x18, 0xf4], 0x1000); // lea eax, fs:[ebx+0x18]; hlt
    const state = blockState({ memory, layout });
    state.eip = 0x1000;
    state.reg[3] = 0x100;
    state.fsBase = 0x7000;
    interpret(state, 10);
    assert.equal(state.reg[0], 0x118);
});

test('a cached run over a page made inaccessible since runs up to that page and faults there',
    ()=>{
        const layout = ownLayout({ ramSize: 1 << 20 });
        const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
        const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
        const flags = new Uint8Array(
            memory.buffer, layout.tables + Tables.PAGE_FLAGS, Tables.PAGE_FLAGS_SIZE);
        // At 0x1ffc: inc eax; inc eax; nop; nop | 0x2000: inc eax; hlt -- a run over two pages.
        ram.set([0x40, 0x40, 0x90, 0x90, 0x40, 0xf4], 0x1ffc);
        const state = blockState({ memory, layout });
        state.eip = 0x1ffc;
        interpret(state, 100);
        assert.equal(state.reg[0], 3, 'the run ran whole once, and is cached');
        flags[0x2] = PageFlag.INACCESSIBLE;
        state.eip = 0x1ffc;
        state.halted = false;
        state.reg[0] = 0;
        assert.throws(()=>interpret(state, 100),
            e=>e instanceof Fault && e.vector === 13 && e.eip === 0x2000,
            'the fault names the instruction on the page, not the run\'s start');
        assert.equal(state.reg[0], 2, 'the instructions before the page ran');
    });

test('a run is reported once, at its start, and a fetch from an inaccessible page faults there',
    ()=>{
        const layout = ownLayout({ ramSize: 1 << 20 });
        const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
        const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
        const flags = new Uint8Array(
            memory.buffer, layout.tables + Tables.PAGE_FLAGS, Tables.PAGE_FLAGS_SIZE);
        // mov ecx, 2; L: dec ecx; jnz L; jmp 0x5000 -- the page there inaccessible.
        ram.set([0xb9, 2, 0, 0, 0, 0x49, 0x75, 0xfd, 0xe9, ...[0xf3, 0x3f, 0, 0]], 0x1000);
        flags[0x5] = PageFlag.INACCESSIBLE;
        const state = blockState({ memory, layout });
        /** @type {string[]} */
        const seen = [];
        state.eip = 0x1000;
        assert.throws(()=>interpret(state, 100, {
            onStep: (at, jumped)=>seen.push(`${at.toString(16)}${jumped ? '*' : ''}`),
        }), e=>e instanceof Fault && e.vector === 13 && e.eip === 0x5000);
        // The loop's head is a jump's target; the not-taken branch falls
        // through within the run it heads.
        assert.deepEqual(seen, ['1000', '1005*']);
        assert.equal(state.reg[1], 0);
    });

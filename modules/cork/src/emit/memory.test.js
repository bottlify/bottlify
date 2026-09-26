/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { PageFlag } from '../runtime/pages.js';
import { planLoop, planRegion, readUndoLog, resetUndoLog, spansOf } from './memory.js';
import { Exit, emitRegion, enterRegion, mathImports, prepareModule } from './region.js';
import { buildHelpersModule } from './helpers.js';
import { formRegion, inlineReturns } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { features } from '../wasm/features.js';
import { blockState, interpret } from '../interp.js';
import { Fault } from '../ir.js';

const CODE = 0x1000;
const STACK = 0x80000;

/**
 * @param {number[]} bytes
 * @param {{ regs?: Record<string, number>, mark?: [number, number, number][],
 *   undoLog?: boolean }} [start]
 */
function run(bytes, { regs = {}, mark = [], undoLog = false } = {}){
    const m = createTestMachine();
    m.write(CODE, [...bytes, 0xf4]);
    m.setReg('esp', STACK);
    for (const [name, value] of Object.entries(regs))
    {
        m.setReg(name, value);
    }
    for (const [address, length, flag] of mark)
    {
        // Code is marked as the runtime marks it: the flag and the granules.
        if (flag === PageFlag.HAS_CODE)
        {
            m.pages.markCode(address, length);
        }
        else
        {
            m.pages.markRange(address, length, flag);
        }
    }
    const exit = m.runProgram(CODE, { undoLog });
    return { m, exit };
}

test('loads and stores reach memory, and leave unmarked pages alone', ()=>{
    const m = createTestMachine();
    m.writeU32(0x2000, 0x1234);
    m.write(CODE, [
        0xa1, 0x00, 0x20, 0, 0,             // mov eax, [0x2000]
        0x05, 0x01, 0, 0, 0,                // add eax, 1
        0xa3, 0x04, 0x20, 0, 0,             // mov [0x2004], eax
        0xf4,
    ]);
    m.setReg('esp', STACK);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, Exit.HALT);
    assert.equal(m.readU32(0x2004), 0x1235);
    assert.equal(m.pages.get(2), 0, 'no flag set by an ordinary access');
});

test('a load from an inaccessible page faults #GP before the instruction, state as before', ()=>{
    const { m, exit } = run([
        0xb9, 0x05, 0, 0, 0,                // mov ecx, 5
        0x8b, 0x05, 0x00, 0x50, 0, 0,       // mov eax, [0x5000]   inaccessible
        0xb9, 0x07, 0, 0, 0,                // mov ecx, 7
    ], { regs: { eax: 0x11 }, mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
    assert.equal(exit.kind, Exit.FAULT);
    assert.equal(exit.vector, 13);
    assert.equal(exit.eip, CODE + 5, 'at the load');
    assert.equal(m.reg('ecx'), 5, 'the instruction after did not run');
    assert.equal(m.reg('eax'), 0x11, 'the load did not happen');
    assert.equal(exit.retired, 1, 'the faulting instruction is not counted');
});

test('an access beyond RAM faults instead of trapping the engine', ()=>{
    const { exit } = run([0x8b, 0x05, 0x00, 0x00, 0x20, 0]); // mov eax, [0x200000]
    assert.equal(exit.kind, Exit.FAULT);
    assert.equal(exit.vector, 13);
    const store = run([0xa3, 0xfe, 0xff, 0x0f, 0x00]);       // mov [0xffffe], eax: spans the end
    assert.equal(store.exit.kind, Exit.FAULT, 'the last byte is past RAM');
});

test('a store into a page holding translated code leaves stale after the instruction', ()=>{
    const { m, exit } = run([
        0xb8, 0x78, 0x56, 0x34, 0x12,       // mov eax, 0x12345678
        0xa3, 0x08, 0x30, 0, 0,             // mov [0x3008], eax    a code page
        0xb9, 0x07, 0, 0, 0,                // mov ecx, 7           not reached in this run
    ], { mark: [[0x3000, 0x1000, PageFlag.HAS_CODE]] });
    assert.equal(exit.kind, Exit.STALE);
    assert.equal(exit.eip, CODE + 10, 'the next instruction');
    assert.equal(m.readU32(0x3008), 0x12345678, 'the store itself happened');
    assert.equal(m.pages.staleAddress(), 0x3008);
    assert.equal(m.reg('ecx'), 0);
    assert.equal(exit.retired, 2);
});

test('a wide access beside an inaccessible page faults only when it reaches it', ()=>{
    const near = [[0x5000, 0x1000, PageFlag.INACCESSIBLE]];
    // mov eax, [0x4ffc]; mov [0x4ffc], eax: the dword ends at the page's last byte.
    const inside = run([0xa1, 0xfc, 0x4f, 0, 0, 0xa3, 0xfc, 0x4f, 0, 0], {
        regs: { eax: 0 }, mark: /** @type {[number, number, number][]} */ (near) });
    assert.equal(inside.exit.kind, Exit.HALT);
    for (const [bytes, size] of [[[0xa1, 0xfd, 0x4f, 0, 0], 4], [[0x66, 0xa1, 0xff, 0x4f, 0, 0], 2],
        [[0x66, 0xa3, 0xff, 0x4f, 0, 0], 2]])
    {
        const { exit } = run(/** @type {number[]} */ (bytes), {
            mark: /** @type {[number, number, number][]} */ (near) });
        assert.equal(exit.kind, Exit.FAULT, `a ${size}-byte access over the edge`);
        assert.equal(exit.eip, CODE);
    }
});

test('a wide store beside a code page is no stale unless it reaches it', ()=>{
    const code = /** @type {[number, number, number][]} */ ([[0x3000, 0x20, PageFlag.HAS_CODE]]);
    const inside = run([0xa3, 0xfc, 0x2f, 0, 0], { mark: code });   // mov [0x2ffc], eax
    assert.equal(inside.exit.kind, Exit.HALT);
    const over = run([0x66, 0xa3, 0xff, 0x2f, 0, 0], { mark: code }); // mov [0x2fff], ax
    assert.equal(over.exit.kind, Exit.STALE);
    assert.equal(over.m.pages.staleAddress(), 0x2fff);
    // A push, whose check makes the code note in the same test: esp 0x3000
    // writes 0x2ffc..0x2fff, esp 0x3002 reaches the code.
    const push = run([0x50], { regs: { esp: 0x3000 }, mark: code });
    assert.equal(push.exit.kind, Exit.HALT);
    const reaching = run([0x50], { regs: { esp: 0x3002 }, mark: code });
    assert.equal(reaching.exit.kind, Exit.STALE);
    assert.equal(reaching.m.pages.staleAddress(), 0x2ffe);
});

test('a store spanning into a code page is caught by its last byte', ()=>{
    const { m, exit } = run([
        0xb8, 0x78, 0x56, 0x34, 0x12,       // mov eax, 0x12345678
        0xa3, 0xfe, 0x2f, 0, 0,             // mov [0x2ffe], eax    two bytes land in page 3
    ], { mark: [[0x3000, 0x1000, PageFlag.HAS_CODE]] });
    assert.equal(exit.kind, Exit.STALE);
    assert.equal(m.readU32(0x2ffe), 0x12345678);
});

test('a push, a call and a rep stos into a code page are stale too; a push past RAM faults', ()=>{
    const code = /** @type {[number, number, number][]} */ ([[0x3000, 0x1000, PageFlag.HAS_CODE]]);
    const push = run([0xbc, 0x04, 0x30, 0, 0, 0x50], { mark: code });
    assert.equal(push.exit.kind, Exit.STALE, 'push');
    assert.equal(push.exit.eip, CODE + 6);
    const call = run([0xbc, 0x04, 0x30, 0, 0, 0xe8, 0x10, 0, 0, 0],
        { mark: [[0x3000, 0x1000, PageFlag.HAS_CODE]] });
    assert.equal(call.exit.kind, Exit.STALE, 'call: stale wins over the untranslated exit');
    assert.equal(call.exit.eip, CODE + 10 + 0x10, 'at the call\'s target');
    assert.equal(call.m.readU32(0x3000), CODE + 10, 'the return address was pushed');
    const stos = run([
        0xbf, 0x00, 0x30, 0, 0,             // mov edi, 0x3000
        0xb9, 0x04, 0, 0, 0,                // mov ecx, 4
        0xb8, 0xaa, 0, 0, 0,                // mov eax, 0xaa
        0xf3, 0xaa,                         // rep stosb
    ], { mark: [[0x3000, 0x1000, PageFlag.HAS_CODE]] });
    assert.equal(stos.exit.kind, Exit.STALE);
    assert.equal(stos.exit.eip, CODE + 17, 'after the whole rep');
    assert.deepEqual([...stos.m.read(0x3000, 4)], [0xaa, 0xaa, 0xaa, 0xaa]);
    const past = run([0xbc, 0x04, 0x00, 0x10, 0x00, 0x50]);   // esp = 1 MiB + 4; push eax
    assert.equal(past.exit.kind, Exit.FAULT);
    assert.equal(past.exit.vector, 13);
    assert.equal(past.m.reg('esp'), 0x100004, 'esp untouched by the faulting push');
});

test('a rep movs that runs into an inaccessible page faults with its progress kept', ()=>{
    const { m, exit } = run([
        0xbe, 0x00, 0x20, 0, 0,             // mov esi, 0x2000
        0xbf, 0xfc, 0x4f, 0, 0,             // mov edi, 0x4ffc
        0xb9, 0x08, 0, 0, 0,                // mov ecx, 8
        0xf3, 0xa4,                         // rep movsb
    ], { mark: [[0x5000, 0x1000, PageFlag.INACCESSIBLE]] });
    assert.equal(exit.kind, Exit.FAULT);
    assert.equal(exit.vector, 13);
    assert.equal(exit.eip, CODE + 15, 'at the rep movs');
    assert.equal(m.reg('ecx'), 4, 'four bytes moved');
    assert.equal(m.reg('edi'), 0x5000);
    assert.equal(m.reg('esi'), 0x2004);
    assert.equal(exit.retired, 3 + 4, 'the iterations that completed');
});

test('the other precise faults: a divide by zero, ud2; int3 and int n are left before', ()=>{
    const div = run([0x31, 0xc9, 0xf7, 0xf1]);                // xor ecx, ecx; div ecx
    assert.equal(div.exit.kind, Exit.FAULT);
    assert.equal(div.exit.vector, 0);
    assert.equal(div.exit.eip, CODE + 2);
    const ud = run([0x0f, 0x0b]);
    assert.equal(ud.exit.vector, 6);
    assert.equal(ud.exit.eip, CODE);
    // The machine's -2: the region at the instruction makes no progress,
    // which is the other executor's cue to run it.
    const int3 = run([0xb9, 0x05, 0, 0, 0, 0xcc]);
    assert.equal(int3.exit.kind, -2);
    assert.equal(int3.exit.eip, CODE + 5, 'at the int3, for the other executor to raise');
    assert.equal(int3.exit.retired, 1, 'uncounted');
    const intn = run([0x90, 0xcd, 0x21]);
    assert.equal(intn.exit.kind, -2);
    assert.equal(intn.exit.eip, CODE + 1);
});

test('the undo log records every store with its old bytes, in order, and folds to spans', ()=>{
    const m = createTestMachine();
    m.write(0x3000, [1, 2, 3, 4, 5, 6, 7, 8]);
    m.write(CODE, [
        0xb8, 0x11, 0x11, 0x11, 0x11,       // mov eax, 0x11111111
        0xa3, 0x00, 0x30, 0, 0,             // mov [0x3000], eax
        0xa3, 0x04, 0x30, 0, 0,             // mov [0x3004], eax
        0x66, 0xa3, 0x00, 0x30, 0, 0,       // mov [0x3000], ax
        0x50,                               // push eax
        0xf4,
    ]);
    m.setReg('esp', STACK);
    const exit = m.runProgram(CODE, { undoLog: true });
    assert.equal(exit.kind, Exit.HALT);
    const { entries, wrapped } = readUndoLog(m.memory, m.layout);
    assert.equal(wrapped, false);
    assert.deepEqual(entries.map(e=>[e.address, e.size, [...e.old]]), [
        [0x3000, 4, [1, 2, 3, 4]],
        [0x3004, 4, [5, 6, 7, 8]],
        [0x3000, 2, [0x11, 0x11]],
        [STACK - 4, 4, [0, 0, 0, 0]],
    ]);
    assert.deepEqual(spansOf(entries),
        [{ start: 0x3000, end: 0x3008 }, { start: STACK - 4, end: STACK }]);
    resetUndoLog(m.memory, m.layout);
    assert.equal(readUndoLog(m.memory, m.layout).entries.length, 0);
    // A production translation logs nothing.
    const plain = createTestMachine();
    plain.write(CODE, [0xa3, 0x00, 0x30, 0, 0, 0xf4]);
    plain.setReg('esp', STACK);
    plain.runProgram(CODE);
    assert.equal(readUndoLog(plain.memory, plain.layout).entries.length, 0);
});

test('a store into a page the other executor compiled leaves stale too, with the width', ()=>{
    const m = createTestMachine({ codePages: true });
    // Page 3 in the other executor's table: 1 = has compiled code.
    new Uint8Array(m.memory.buffer)[/** @type {number} */ (m.layout.codePages) + 3] = 1;
    m.write(CODE, [
        0xb8, 0x78, 0x56, 0x34, 0x12,       // mov eax, 0x12345678
        0x66, 0xa3, 0x06, 0x30, 0, 0,       // mov [0x3006], ax
        0xf4,
    ]);
    m.setReg('esp', STACK);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, Exit.STALE);
    assert.equal(m.pages.staleAddress(), 0x3006);
    assert.equal(m.pages.staleSize(), 2);
    assert.equal(m.pages.get(3), 0, "this engine's own flag was never set");
    const plain = createTestMachine({ codePages: true });
    plain.write(CODE, [0xb8, 0x78, 0x56, 0x34, 0x12, 0x66, 0xa3, 0x06, 0x30, 0, 0, 0xf4]);
    plain.setReg('esp', STACK);
    assert.equal(plain.runProgram(CODE).kind, Exit.HALT, 'an unmarked page: no exit');
});

test('a store wider than a granule notes code anywhere in it, and across a page the other '
    + 'executor\'s next page', ()=>{
    // fnsave writes 108 bytes: over translated code at 0x5020..0x503f from
    // 0x5000 and from 0x5010, the code lies in neither its first byte's
    // granule nor its last's.
    for (const at of [0x5000, 0x5010])
    {
        const m = createTestMachine();
        m.write(CODE, [0xdd, 0x35, at & 0xff, at >> 8, 0, 0, 0xf4]); // fnsave [at]
        m.setReg('esp', STACK);
        m.pages.markCode(0x5020, 0x20);
        assert.equal(m.translate(CODE).run(CODE).kind, Exit.STALE, `fnsave [0x${at.toString(16)}]`);
        assert.equal(m.pages.staleSize(), 108);
    }
    const past = createTestMachine();
    past.write(CODE, [0xdd, 0x35, 0x00, 0x50, 0, 0, 0xf4]);
    past.setReg('esp', STACK);
    past.pages.markCode(0x5080, 0x20);
    assert.equal(past.translate(CODE).run(CODE).kind, Exit.HALT, 'code past its last byte');
    // mov [0x3ffe], eax reaches page 4, which the other executor compiled.
    const m = createTestMachine({ codePages: true });
    new Uint8Array(m.memory.buffer)[/** @type {number} */ (m.layout.codePages) + 4] = 1;
    m.write(CODE, [0xa3, 0xfe, 0x3f, 0, 0, 0xf4]);
    m.setReg('esp', STACK);
    assert.equal(m.runProgram(CODE).kind, Exit.STALE, 'the store\'s last page');
});

test('a store into a code page outside the code\'s own granules is no stale', ()=>{
    // mov [0x1800], eax: the code sits at 0x1000..0x1010, the store 2 KiB
    // past it on the same page.
    const m = createTestMachine();
    m.write(CODE, [0xb8, 0x11, 0x11, 0x11, 0x11, 0xa3, 0x00, 0x18, 0, 0, 0xf4]);
    m.setReg('esp', STACK);
    m.pages.markCode(CODE, 0x10);
    const unit = m.translate(CODE);
    assert.deepEqual(unit.run(CODE), { kind: 3, vector: 0 }, 'halted, not stale');
    assert.equal(m.readU32(0x1800), 0x11111111);
    // The same store into the code's own granules is.
    const n = createTestMachine();
    n.write(CODE, [0xb8, 0x11, 0x11, 0x11, 0x11, 0xa3, 0x0c, 0x10, 0, 0, 0xf4]);
    n.setReg('esp', STACK);
    n.pages.markCode(CODE, 0x10);
    assert.deepEqual(n.translate(CODE).run(CODE), { kind: Exit.STALE, vector: 0 });
    // A dword whose last byte reaches the code's granule is too.
    const o = createTestMachine();
    o.write(CODE, [0xb8, 0x11, 0x11, 0x11, 0x11, 0xa3, 0x1e, 0x10, 0, 0, 0xf4]);
    o.setReg('esp', STACK);
    o.pages.markCode(CODE + 0x20, 0x10);            // granule 1 only
    assert.deepEqual(o.translate(CODE).run(CODE), { kind: Exit.STALE, vector: 0 });
});

/**
 * Translates the bytes at CODE with the registers and marks given and runs
 * them once, returning the exit, EIP and count.
 *
 * @param {number[]} bytes
 * @param {{ regs?: Record<string, number>, code?: [number, number][],
 *     inaccessible?: number[], data?: [number, number[]][] }} [start]
 */
function once(bytes, { regs = {}, code = [], inaccessible = [], data = [] } = {}){
    const m = createTestMachine();
    m.write(CODE, [...bytes, 0xf4]);
    for (const [address, values] of data)
    {
        m.write(address, values);
    }
    m.setReg('esp', STACK);
    for (const [name, value] of Object.entries(regs))
    {
        m.setReg(name, value);
    }
    for (const [address, length] of code)
    {
        m.pages.markCode(address, length);
    }
    for (const page of inaccessible)
    {
        m.pages.markRange(page, 0x1000, PageFlag.INACCESSIBLE);
    }
    const before = m.counter();
    const exit = m.translate(CODE).run(CODE);
    return { m, exit, eip: m.eip(), retired: m.counter() - before };
}

test('a group of accesses whose window reaches an inaccessible page leaves before its first', ()=>{
    // mov ecx, 5; mov eax, [ebx]; mov edi, [ebx+4]; mov edx, 7; mov esi, [ebx+0x7fc]:
    // the last load's page is inaccessible, so the block leaves untranslated
    // at the first load, for the interpreter to fault at the last.
    const bytes = [
        0xb9, 5, 0, 0, 0, 0x8b, 0x03, 0x8b, 0x7b, 0x04, 0xba, 7, 0, 0, 0,
        0x8b, 0xb3, 0xfc, 0x07, 0, 0,
    ];
    const dirty = once(bytes, { regs: { ebx: 0x4a00 }, inaccessible: [0x5000] });
    assert.equal(dirty.exit.kind, Exit.UNTRANSLATED);
    assert.equal(dirty.eip, CODE + 5, 'before the group\'s first access');
    assert.equal(dirty.retired, 1, 'the mov before it ran, the load did not');
    assert.equal(dirty.m.reg('ecx'), 5);
    assert.equal(dirty.m.reg('edx'), 0);
    const clean = once(bytes, { regs: { ebx: 0x4000 }, inaccessible: [0x5000] });
    assert.equal(clean.exit.kind, Exit.HALT, 'a window short of the page runs through');
});

test('a group whose stores land in code leaves before it; code beside them does not', ()=>{
    // mov [ebx], eax; mov [ebx+4], eax
    const bytes = [0x89, 0x03, 0x89, 0x43, 0x04];
    const hit = once(bytes, { regs: { ebx: 0x3000, eax: 9 }, code: [[0x3004, 4]] });
    assert.equal(hit.exit.kind, Exit.UNTRANSLATED);
    assert.equal(hit.eip, CODE);
    assert.equal(hit.m.readU32(0x3000), 0, 'nothing stored');
    const beside = once(bytes, { regs: { ebx: 0x3000, eax: 9 }, code: [[0x3800, 0x20]] });
    assert.equal(beside.exit.kind, Exit.HALT, 'the page holds code, the stores\' granules not');
    assert.equal(beside.m.readU32(0x3004), 9);
});

test('pushes and pops are one group off esp, checked once', ()=>{
    // push eax; push ebx; pop edx; pop esi -- esp 0x5004 pushes into 0x4ffc.
    const bytes = [0x50, 0x53, 0x5a, 0x5e];
    const dirty = once(bytes, { regs: { esp: 0x5004 }, inaccessible: [0x4000] });
    assert.equal(dirty.exit.kind, Exit.UNTRANSLATED);
    assert.equal(dirty.retired, 0);
    assert.equal(dirty.m.reg('esp'), 0x5004);
    const clean = once(bytes, { regs: { esp: 0x5008, eax: 1, ebx: 2 }, inaccessible: [0x4000] });
    assert.equal(clean.exit.kind, Exit.HALT);
    assert.equal(clean.m.reg('edx'), 2);
    assert.equal(clean.m.reg('esi'), 1);
});

test('a register the block rewrites starts a group of its own', ()=>{
    // mov esi, [edx]; imul dword [ecx]; mov edi, [edx]: the widening imul
    // writes edx, so the second load is off another edx -- its own page,
    // inaccessible here, faults at it rather than being checked with the first.
    const bytes = [0x8b, 0x32, 0xf7, 0x29, 0x8b, 0x3a];
    // 0x10000 * 0x50000000 leaves edx = 0x5000.
    const { exit, eip } = once(bytes, {
        regs: { edx: 0x3000, ecx: 0x3010, eax: 0x10000 }, inaccessible: [0x5000],
        data: [[0x3010, [0, 0, 0, 0x50]]] });
    assert.equal(exit.kind, Exit.FAULT);
    assert.equal(eip, CODE + 4, 'at the load off the new edx');
});

test('random blocks of register moves and accesses by a page edge match the interpreter', ()=>{
    // Blocks that move their base registers every way a group follows or
    // loses (push, pop, add/sub/inc/dec, lea, mov, xchg, imul, cdq) and
    // access off them beside an inaccessible page and code granules: the
    // translated run, finished by the interpreter where it leaves, against
    // the interpreter alone -- registers, the data pages, and the fault.
    let seed = Number(process.env.GROUP_SEED ?? 0x5eed);
    const next = (/** @type {number} */ n)=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) % n;
    };
    const GPR = [0, 1, 2, 3, 5, 6, 7];
    const pick = ()=>GPR[next(GPR.length)];
    const disp = ()=>(next(33) - 16) * 4 & 0xff;
    const modrm = (/** @type {number} */ r, /** @type {number} */ b)=>0x40 | r << 3 | b;
    const forms = [
        ()=>[0x8b, modrm(pick(), pick()), disp()],                 // mov r, [b+d]
        ()=>[0x89, modrm(pick(), pick()), disp()],                 // mov [b+d], r
        ()=>[0x01, modrm(pick(), pick()), disp()],                 // add [b+d], r
        ()=>[0x8b, modrm(pick(), 4), 0x24, disp()],                // mov r, [esp+d]
        ()=>[0x83, 0xc0 | pick(), next(64) - 32 & 0xff],           // add r, imm8
        ()=>[0x83, 0xe8 | pick(), next(64) - 32 & 0xff],           // sub r, imm8
        ()=>[0x40 | pick()], ()=>[0x48 | pick()],                   // inc r, dec r
        ()=>[0x50 | pick()], ()=>[0x58 | pick()], ()=>[0x6a, 7],    // push r, pop r, push 7
        ()=>{ const r = pick(); return [0x8d, modrm(r, r), disp()]; }, // lea r, [r+d]
        ()=>[0x89, 0xc0 | pick() << 3 | pick()],                   // mov r, r2
        ()=>[0x87, 0xc0 | pick() << 3 | pick()],                   // xchg r, r2
        ()=>[0xf7, 0xe9], ()=>[0x99],                               // imul ecx, cdq
        ()=>[0xf3, 0x0f, 0x10, modrm(0, pick()), disp()],          // movss xmm0, [b+d]
        ()=>[0xf3, 0x0f, 0x11, modrm(0, pick()), disp()],          // movss [b+d], xmm0
    ];
    const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
    for (let round = 0; round < Number(process.env.GROUP_ROUNDS ?? 1500); round++)
    {
        /** @type {number[]} */
        const bytes = [];
        for (let k = 0, n = 4 + next(12); k < n; k++)
        {
            bytes.push(...forms[next(forms.length)]());
        }
        bytes.push(0xf4);
        const regs = names.map(()=>0x4f00 + next(0x180));
        const shut = next(2) === 0 ? 0x5000 : 0x4000;
        const code = next(3) === 0;
        const fill = Array.from({ length: 0x2000 }, ()=>next(256));
        const make = ()=>{
            const m = createTestMachine();
            m.write(CODE, bytes);
            m.write(0x4000, fill);
            names.forEach((name, r)=>m.setReg(name, regs[r]));
            m.pages.markRange(shut, 0x1000, PageFlag.INACCESSIBLE);
            if (code)
            {
                m.pages.markCode(0x4f80, 0x20);
            }
            return m;
        };
        /** @param {ReturnType<typeof createTestMachine>} m */
        const finish = m=>{
            const state = blockState({ memory: m.memory, layout: m.layout });
            state.syncIn();
            try
            {
                interpret(state, 200);
            }
            catch (e){
                if (!(e instanceof Fault))
                {
                    throw e;
                }
                state.syncOut();
                return `fault ${e.vector} at ${e.eip.toString(16)}`;
            }
            state.syncOut();
            return `halt at ${state.eip.toString(16)}`;
        };
        const alone = make();
        new DataView(alone.memory.buffer).setUint32(alone.layout.eip, CODE, true);
        const expected = finish(alone);
        const translated = make();
        const exit = translated.translate(CODE).run(CODE);
        const ended = exit.kind === Exit.FAULT
            ? `fault ${exit.vector} at ${translated.eip().toString(16)}`
            : exit.kind === Exit.HALT ? `halt at ${translated.eip().toString(16)}`
                : finish(translated);
        const hex = `${bytes.map(x=>x.toString(16).padStart(2, '0')).join(' ')}`
            + ` regs ${JSON.stringify(regs)} shut ${shut} code ${code}`;
        assert.equal(ended, expected, `round ${round}: ${hex}`);
        for (const name of names)
        {
            assert.equal(translated.reg(name), alone.reg(name), `round ${round} ${name}: ${hex}`);
        }
        assert.deepEqual(translated.read(0x4000, 0x2000), alone.read(0x4000, 0x2000),
            `round ${round} memory: ${hex}`);
    }
});

test('every access kind the groups take translates as the plan foresaw it', ()=>{
    // One block of accesses off ebx: the integer, SSE and x87 forms a group
    // takes, loads, stores and read-modify-writes. A form the emitter
    // accesses otherwise than the plan says is an error in translating.
    const bytes = [
        0x8b, 0x03,                         // mov eax, [ebx]
        0x01, 0x43, 0x04,                   // add [ebx+4], eax
        0x39, 0x43, 0x08,                   // cmp [ebx+8], eax
        0x85, 0x43, 0x08,                   // test [ebx+8], eax
        0xff, 0x43, 0x0c,                   // inc dword [ebx+12]
        0xd1, 0x63, 0x0c,                   // shl dword [ebx+12], 1
        0xc1, 0x63, 0x0c, 0x00,             // shl dword [ebx+12], 0: no access at all
        0xc1, 0x43, 0x0c, 0x00,             // rol dword [ebx+12], 0: checked, not stored
        0x0f, 0x94, 0x43, 0x10,             // setz [ebx+16]
        0x0f, 0xb6, 0x43, 0x11,             // movzx eax, byte [ebx+17]
        0x0f, 0xbf, 0x4b, 0x02,             // movsx ecx, word [ebx+2]
        0x0f, 0xaf, 0x43, 0x04,             // imul eax, [ebx+4]
        0x0f, 0x44, 0x43, 0x04,             // cmovz eax, [ebx+4]
        0xf3, 0x0f, 0x10, 0x43, 0x20,       // movss xmm0, [ebx+32]
        0x0f, 0x10, 0x4b, 0x30,             // movups xmm1, [ebx+48]
        0x0f, 0x59, 0x4b, 0x40,             // mulps xmm1, [ebx+64]
        0xf3, 0x0f, 0x11, 0x43, 0x50,       // movss [ebx+80], xmm0
        0x0f, 0x29, 0x4b, 0x60,             // movaps [ebx+96], xmm1
        0x0f, 0x17, 0x4b, 0x70,             // movhps [ebx+112], xmm1
        0x0f, 0x12, 0x53, 0x70,             // movlps xmm2, [ebx+112]
        0x66, 0x0f, 0x6e, 0x5b, 0x04,       // movd xmm3, [ebx+4]
        0x66, 0x0f, 0x7e, 0x9b, 0xd0, 0, 0, 0, // movd [ebx+208], xmm3
        0xf3, 0x0f, 0x7e, 0x63, 0x08,       // movq xmm4, [ebx+8]
        0x66, 0x0f, 0xd6, 0xa3, 0xd8, 0, 0, 0, // movq [ebx+216], xmm4
        0xd9, 0x83, 0x80, 0, 0, 0,          // fld dword [ebx+128]
        0xd8, 0x8b, 0x84, 0, 0, 0,          // fmul dword [ebx+132]
        0xd9, 0x9b, 0x88, 0, 0, 0,          // fstp dword [ebx+136]
        0xdb, 0x83, 0x04, 0, 0, 0,          // fild dword [ebx+4]
        0xdb, 0x9b, 0x8c, 0, 0, 0,          // fistp dword [ebx+140]
        0xd9, 0xbb, 0x90, 0, 0, 0,          // fnstcw [ebx+144]
        0xd9, 0xab, 0x90, 0, 0, 0,          // fldcw [ebx+144]
        0xdd, 0x83, 0x98, 0, 0, 0,          // fld qword [ebx+152]
        0xdd, 0x9b, 0xa0, 0, 0, 0,          // fstp qword [ebx+160]
        0xdd, 0xbb, 0xe0, 0, 0, 0,          // fnstsw [ebx+224]
        0x50, 0x59, 0x6a, 0x05, 0x5a,       // push eax; pop ecx; push 5; pop edx
        0x66, 0x0f, 0xc4, 0x43, 0x04, 0x01, // pinsrw xmm0, [ebx+4], 1
        0xf3, 0x0f, 0x2a, 0x43, 0x04,       // cvtsi2ss xmm0, [ebx+4]
        0xf3, 0x0f, 0x2c, 0x43, 0x20,       // cvttss2si eax, [ebx+32]
        0x0f, 0x2f, 0x43, 0x20,             // comiss xmm0, [ebx+32]
        0x0f, 0x2e, 0x43, 0x20,             // ucomiss xmm0, [ebx+32]
        0x0f, 0xc6, 0x4b, 0x30, 0x00,       // shufps xmm1, [ebx+48], 0
        0x0f, 0x14, 0x4b, 0x30,             // unpcklps xmm1, [ebx+48]
        0x0f, 0x54, 0x4b, 0x30,             // andps xmm1, [ebx+48]
        0x0f, 0x5f, 0x4b, 0x30,             // maxps xmm1, [ebx+48]
        0x0f, 0xc2, 0x4b, 0x30, 0x01,       // cmpltps xmm1, [ebx+48]
        0x0f, 0x5a, 0x6b, 0x08,             // cvtps2pd xmm5, [ebx+8]
        0xf3, 0x0f, 0x5a, 0x6b, 0x20,       // cvtss2sd xmm5, [ebx+32]
        0xf3, 0x0f, 0x51, 0x43, 0x20,       // sqrtss xmm0, [ebx+32]
        0x0f, 0x52, 0x4b, 0x30,             // rsqrtps xmm1, [ebx+48]
        0x0f, 0x5b, 0x4b, 0x30,             // cvtdq2ps xmm1, [ebx+48]
        0x66, 0x0f, 0x70, 0x4b, 0x30, 0x00, // pshufd xmm1, [ebx+48], 0
        0x66, 0x0f, 0xf1, 0x4b, 0x30,       // psllw xmm1, [ebx+48]
        0x66, 0x0f, 0x6c, 0x4b, 0x30,       // punpcklqdq xmm1, [ebx+48]
        0xf3, 0x0f, 0x16, 0x4b, 0x30,       // movshdup xmm1, [ebx+48]
        0xf2, 0x0f, 0x7c, 0x4b, 0x30,       // haddps xmm1, [ebx+48]
        0xf2, 0x0f, 0xd0, 0x4b, 0x30,       // addsubps xmm1, [ebx+48]
        0xf2, 0x0f, 0xf0, 0x4b, 0x30,       // lddqu xmm1, [ebx+48]
        0x0f, 0x2b, 0x4b, 0x60,             // movntps [ebx+96], xmm1
        0xf2, 0x0f, 0x10, 0x73, 0x08,       // movsd xmm6, [ebx+8]
        0xf2, 0x0f, 0x11, 0xb3, 0xd8, 0, 0, 0, // movsd [ebx+216], xmm6
        0x66, 0x0f, 0x13, 0x8b, 0xe8, 0, 0, 0, // movlpd [ebx+232], xmm1
        0x66, 0x0f, 0x16, 0x8b, 0xe8, 0, 0, 0, // movhpd xmm1, [ebx+232]
        0xdc, 0x93, 0x98, 0, 0, 0,          // fcom qword [ebx+152]
        0xde, 0x43, 0x04,                   // fiadd word [ebx+4]
        0xdb, 0x8b, 0x8c, 0, 0, 0,          // fisttp dword [ebx+140]
        0xd9, 0xe8,                         // fld1
        0xdf, 0x93, 0x90, 0, 0, 0,          // fist word [ebx+144]
        0xdf, 0x6b, 0x08,                   // fild qword [ebx+8]
        0xdf, 0xbb, 0xa0, 0, 0, 0,          // fistp qword [ebx+160]
        0xdb, 0x6b, 0x08,                   // fld tword [ebx+8]
        0xdb, 0xbb, 0xf0, 0, 0, 0,          // fstp tword [ebx+240]
        0xdd, 0xd8,                         // fstp st0
        0x11, 0x43, 0x04,                   // adc [ebx+4], eax
        0x19, 0x43, 0x04,                   // sbb [ebx+4], eax
        0x09, 0x43, 0x04,                   // or [ebx+4], eax
        0x31, 0x43, 0x04,                   // xor [ebx+4], eax
        0xf7, 0x5b, 0x0c,                   // neg dword [ebx+12]
        0xf7, 0x53, 0x0c,                   // not dword [ebx+12]
        0xd2, 0x7b, 0x11,                   // sar byte [ebx+17], cl
        0x0f, 0xa4, 0x43, 0x0c, 0x03,       // shld [ebx+12], eax, 3
        0x0f, 0xad, 0x43, 0x0c,             // shrd [ebx+12], eax, cl
        0xd1, 0x53, 0x0c,                   // rcl dword [ebx+12], 1
        0xc1, 0x4b, 0x0c, 0x05,             // ror dword [ebx+12], 5
        0xc6, 0x43, 0x12, 0x07,             // mov byte [ebx+18], 7
        0x66, 0x89, 0x43, 0x14,             // mov [ebx+20], ax
        0xf6, 0x43, 0x10, 0x01,             // test byte [ebx+16], 1
        0x83, 0x7b, 0x08, 0x03,             // cmp dword [ebx+8], 3
        0x03, 0x43, 0x04,                   // add eax, [ebx+4]
        0x0f, 0xbc, 0x43, 0x04,             // bsf eax, [ebx+4]
        0x0f, 0xb7, 0x43, 0x02,             // movzx eax, word [ebx+2]
        0x6b, 0x43, 0x04, 0x07,             // imul eax, [ebx+4], 7
        0x0f, 0x45, 0x43, 0x04,             // cmovnz eax, [ebx+4]
        0xa1, 0x00, 0x30, 0, 0,             // mov eax, [0x3000]
        0xa3, 0x04, 0x30, 0, 0,             // mov [0x3004], eax
        0x89, 0x83, 0xc8, 0, 0, 0,          // mov [ebx+200], eax
        0x8b, 0x83, 0xc8, 0, 0, 0,          // mov eax, [ebx+200]
    ];
    const { m, exit } = once(bytes, { regs: { ebx: 0x3000 } });
    assert.equal(exit.kind, Exit.HALT);
    assert.equal(m.reg('edx'), 5);
    assert.equal(m.readU32(0x30c8), m.reg('eax'), 'the store and the load of one slot');
});

test('an SSE store checks its page and code in one test, exact at both edges', ()=>{
    const code = /** @type {[number, number, number][]} */ ([[0x3000, 0x20, PageFlag.HAS_CODE]]);
    // movups [eax], xmm0 -- sixteen bytes ending just before the code, then reaching into it
    const store = [0x0f, 0x11, 0x00];
    const before = run(store, { regs: { eax: 0x2ff0 }, mark: code });
    assert.equal(before.exit.kind, Exit.HALT);
    const into = run(store, { regs: { eax: 0x2ff1 }, mark: code });
    assert.equal(into.exit.kind, Exit.STALE);
    assert.equal(into.m.pages.staleAddress(), 0x2ff1);
    assert.equal(into.exit.eip, CODE + 3, 'after the store');
    // movss [eax], xmm0 beside an inaccessible page: inside runs, over the edge faults before
    const near = /** @type {[number, number, number][]} */ ([[0x5000, 0x1000, PageFlag.INACCESSIBLE]]);
    const movss = [0xf3, 0x0f, 0x11, 0x00];
    assert.equal(run(movss, { regs: { eax: 0x4ffc }, mark: near }).exit.kind, Exit.HALT);
    const over = run(movss, { regs: { eax: 0x4ffd }, mark: near });
    assert.equal(over.exit.kind, Exit.FAULT);
    assert.equal(over.exit.eip, CODE);
});

/** The region formed at CODE over `bytes`, a `hlt` past them. @param {number[]} bytes */
function regionOf(bytes){
    return formRegion(a=>(a >= CODE && a < CODE + bytes.length ? bytes[a - CODE] : 0xf4), CODE);
}

/**
 * Translates the region at `entry` over a test machine's memory, with the
 * region's structure (its loops as wasm loops) on or off, and answers a
 * runner from any of its block starts.
 *
 * @param {ReturnType<typeof createTestMachine>} m @param {number} entry
 * @param {boolean} structure
 */
function translateWith(m, entry, structure){
    const bytes = new Uint8Array(m.memory.buffer);
    const region = formRegion(a=>bytes[m.layout.ramBase + a], entry);
    const builder = new ModuleBuilder();
    const context = prepareModule(builder, m.layout, features(), {}, { structure });
    const translation = emitRegion(context, region);
    builder.exportFunction('region', translation.functionIndex);
    const helpers = new WebAssembly.Instance(new WebAssembly.Module(
        /** @type {Uint8Array<ArrayBuffer>} */ (buildHelpersModule(m.layout))),
    { env: { memory: m.memory } }).exports;
    const instance = new WebAssembly.Instance(new WebAssembly.Module(
        /** @type {Uint8Array<ArrayBuffer>} */ (builder.toBytes())),
    { env: { memory: m.memory, ...mathImports(), ...helpers, rdtsc: ()=>0n } });
    const fn = /** @type {Function} */ (instance.exports.region);
    return {
        translation,
        /** @param {number} eip */
        run(eip){
            const label = /** @type {number} */ (translation.labels.get(eip));
            const code = enterRegion(fn, label, 1_000_000, new DataView(m.memory.buffer),
                m.layout) >>> 0;
            return { kind: code & 0xff, vector: code >>> 8 };
        },
    };
}

/**
 * Runs the interpreter from the state a machine holds until it halts or
 * faults, and says which.
 *
 * @param {ReturnType<typeof createTestMachine>} m
 */
function interpretRest(m){
    const state = blockState({ memory: m.memory, layout: m.layout });
    state.syncIn();
    try
    {
        interpret(state, 5000);
    }
    catch (e){
        if (!(e instanceof Fault))
        {
            throw e;
        }
        state.syncOut();
        return `fault ${e.vector} at ${e.eip.toString(16)}`;
    }
    state.syncOut();
    return `halt at ${state.eip.toString(16)}`;
}

/**
 * A program run translated from `entry` (in the region formed at CODE when
 * it holds `entry`) and finished by the interpreter where it leaves, against
 * the interpreter alone from the same state: the end, the registers and the
 * bytes over `[0x4000, 0x8000)` agree.
 *
 * @param {(m: ReturnType<typeof createTestMachine>) => void} setup
 * @param {number} entry @param {boolean} structure @param {string} what
 * @returns {{ kind: number, vector: number }} the translated run's exit
 */
function againstInterpreter(setup, entry, structure, what){
    const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
    const alone = createTestMachine();
    setup(alone);
    new DataView(alone.memory.buffer).setUint32(alone.layout.eip, entry, true);
    const expected = interpretRest(alone);
    const machine = createTestMachine();
    setup(machine);
    const unit = translateWith(machine, CODE, structure);
    const exit = (unit.translation.labels.has(entry) ? unit
        : translateWith(machine, entry, structure)).run(entry);
    const ended = exit.kind === Exit.FAULT
        ? `fault ${exit.vector} at ${machine.eip().toString(16)}`
        : exit.kind === Exit.HALT ? `halt at ${machine.eip().toString(16)}`
            : interpretRest(machine);
    assert.equal(ended, expected, what);
    for (const name of names)
    {
        assert.equal(machine.reg(name), alone.reg(name), `${what}: ${name}`);
    }
    assert.deepEqual(machine.read(0x4000, 0x4000), alone.read(0x4000, 0x4000), `${what}: memory`);
    return exit;
}

test('a window reaches a block only its block leads to, tested there only when entered elsewhere',
    ()=>{
        const bytes = [
            0x8b, 0x03,                         // mov eax, [ebx]
            0x85, 0xc9,                         // test ecx, ecx
            0x74, 0x07,                         // jz B2
            0x8b, 0x93, 0xfc, 0x07, 0, 0,       // B1: mov edx, [ebx+0x7fc]
            0xf4,                               // hlt
            0xf4,                               // B2: hlt
        ];
        const plan = planRegion(regionOf(bytes).blocks, { entry: CODE });
        assert.deepEqual(plan.inherit, [-1, 0, 0]);
        const [window] = /** @type {import('./memory.js').Planned} */ (plan.blocks[0].get(0)).checks;
        assert.deepEqual([window.lo, window.width], [0, 0x800], 'B0 tests both loads\' window');
        const load = /** @type {import('./memory.js').Planned} */ (plan.blocks[1].get(0));
        assert.ok(load.access !== null && load.checks.length === 0, 'B1\'s load has no test');
        assert.deepEqual(plan.entry[1].map(w=>[w.base, w.lo, w.width]), [[3, 0x7fc, 4]],
            'entered elsewhere, B1 tests its own load\'s part');
        assert.equal(plan.entry[2].length, 0);
        for (const structure of [false, true])
        {
            for (const [ebx, ecx, entry] of [[0x4a00, 0, CODE], [0x4a00, 1, CODE],
                [0x4a00, 1, CODE + 6], [0x4000, 1, CODE + 6], [0x4000, 1, CODE]])
            {
                const exit = againstInterpreter(m=>{
                    m.write(CODE, bytes);
                    m.setReg('esp', STACK);
                    m.setReg('ebx', ebx);
                    m.setReg('ecx', ecx);
                    m.pages.markRange(0x5000, 0x1000, PageFlag.INACCESSIBLE);
                }, entry, structure, `ebx ${ebx.toString(16)} ecx ${ecx} at ${entry.toString(16)}`
                    + ` structure ${structure}`);
                assert.equal(exit.kind === Exit.HALT, ebx === 0x4000,
                    'a window reaching the page leaves, the path through it taken or not');
            }
        }
    });

test('a frame through esp and ebp, with the leave and ret closing it, is one window', ()=>{
    const bytes = [
        0x55,                               // push ebp
        0x89, 0xe5,                         // mov ebp, esp
        0x83, 0xec, 0x08,                   // sub esp, 8
        0x89, 0x45, 0xfc,                   // mov [ebp-4], eax
        0x89, 0x0c, 0x24,                   // mov [esp], ecx
        0x8b, 0x45, 0x08,                   // mov eax, [ebp+8]
        0xc9,                               // leave
        0xc3,                               // ret
    ];
    const plan = planRegion(regionOf(bytes).blocks, { entry: CODE });
    const planned = [...plan.blocks[0].entries()];
    assert.deepEqual(planned.map(([i, p])=>[i, p.checks.length, p.access !== null]), [
        [0, 1, true], [3, 0, true], [4, 0, true], [5, 0, true], [6, 0, true], [7, 0, true]]);
    const [frame] = planned[0][1].checks;
    assert.deepEqual([frame.base, frame.lo, frame.width], [4, -12, 20]);
    // [esp] lands on the inaccessible page, or in code: the interpreter
    // faults or stores there, and the window leaves before the push.
    for (const [esp, shut] of /** @type {[number, boolean][]} */ ([[0x5008, true],
        [0x5010, true], [0x5008, false]]))
    {
        const exit = againstInterpreter(m=>{
            m.write(CODE, bytes);
            m.write(CODE + 0x100, [0xf4]);
            m.setReg('esp', esp);
            m.writeU32(esp, CODE + 0x100);
            m.setReg('ebp', 0x4f00);
            if (shut)
            {
                m.pages.markRange(0x4000, 0x1000, PageFlag.INACCESSIBLE);
            }
            else
            {
                m.pages.markCode(0x4ff0, 0x10);
            }
        }, CODE, false, `esp ${esp.toString(16)} ${shut ? 'inaccessible' : 'code'}`);
        assert.equal(exit.kind === Exit.UNTRANSLATED && exit.vector === 1, esp === 0x5008,
            'held before the push where the window is not clean');
    }
});

test('two registers made one value before a block are not one window in it', ()=>{
    const bytes = [
        0x8d, 0x42, 0xd4,                   // lea eax, [edx-0x2c]
        0x85, 0xc9,                         // test ecx, ecx
        0x74, 0x0a,                         // jz B2
        0x8b, 0x72, 0xc0,                   // B1: mov esi, [edx-0x40]
        0x89, 0x48, 0x08,                   // mov [eax+8], ecx
        0x8b, 0x7a, 0xe0,                   // mov edi, [edx-0x20]
        0xf4,                               // hlt
        0xf4,                               // B2: hlt
    ];
    const plan = planRegion(regionOf(bytes).blocks, { entry: CODE });
    assert.deepEqual(plan.inherit, [-1, 0, 0]);
    // Entered by the dispatch, B1's eax need not be edx - 0x2c: the store
    // keeps its own test, and the loads through edx are one window.
    const planned = [...plan.blocks[1].entries()];
    assert.deepEqual(planned.map(([i, p])=>[i, p.checks.length, p.access !== null]),
        [[0, 1, true], [2, 0, true]]);
    for (const structure of [false, true])
    {
        for (const [eax, edx, entry] of [[0, 0x4f00, CODE], [0x4ffc, 0x4f00, CODE + 7],
            [0x4e00, 0x4f00, CODE + 7], [0x4e00, 0x5040, CODE + 7]])
        {
            againstInterpreter(m=>{
                m.write(CODE, bytes);
                m.setReg('esp', STACK);
                m.setReg('eax', eax);
                m.setReg('ecx', 1);
                m.setReg('edx', edx);
                m.pages.markRange(0x5000, 0x1000, PageFlag.INACCESSIBLE);
            }, entry, structure, `eax ${eax.toString(16)} edx ${edx.toString(16)} at `
                + `${entry.toString(16)} structure ${structure}`);
        }
    }
});

test('a trap carries no window, a call and a formed-in return do; a join takes the block before',
    ()=>{
        const bytes = [
            0x8b, 0x03,                         // mov eax, [ebx]
            0x8b, 0x53, 0x04,                   // mov edx, [ebx+4]
            0xcd, 0x21,                         // int 0x21
            0x8b, 0x4b, 0x08,                   // B1: mov ecx, [ebx+8]
            0x85, 0xc9,                         // test ecx, ecx
            0x74, 0x05,                         // jz B3
            0x8b, 0x73, 0x0c,                   // B2: mov esi, [ebx+12]
            0xeb, 0x00,                         // jmp B3
            0x8b, 0x7b, 0x10,                   // B3: mov edi, [ebx+16]
            0xe8, 0x01, 0, 0, 0,                // call B5
            0xf4,                               // B4: hlt
            0x8b, 0x43, 0x14,                   // B5: mov eax, [ebx+20]
            0xc3,                               // ret
        ];
        const region = regionOf(bytes);
        const { blocks } = region;
        assert.deepEqual(blocks.map(block=>block.start - CODE), [0, 7, 14, 19, 27, 28]);
        const plan = planRegion(blocks, { entry: CODE, backward: true,
            returns: inlineReturns(region) });
        assert.deepEqual(plan.inherit, [-1, -1, 1, 2, 5, 3], 'B1 past the trap from none;'
            + ' B2 from B1, its one way in; B3 from B2, the block before it, not B1; the'
            + ' callee B5 from its call; B4 from the return');
        // The join's own load and the callee's are B1's window's: B1's way into
        // B3 goes through B3's test of them.
        assert.deepEqual(plan.entry[3].map(w=>[w.lo, w.width]), [[16, 8]]);
        for (const structure of [false, true])
        {
            for (const [ebx, ecx] of [[0x4fe8, 0], [0x4fe8, 1], [0x4fec, 1], [0x4fec, 0],
                [0x4ff0, 0]])
            {
                againstInterpreter(m=>{
                    m.write(CODE, bytes);
                    m.setReg('esp', 0x4800);
                    m.setReg('ebx', ebx);
                    m.setReg('ecx', ecx);
                    m.pages.markRange(0x5000, 0x1000, PageFlag.INACCESSIBLE);
                }, CODE + 7, structure,
                `ebx ${ebx.toString(16)} ecx ${ecx} structure ${structure}`);
            }
        }
    });

test('an entry test that leaves hands the x87 stack over as the block starts with it', ()=>{
    // S takes its windows from Q; P, which moved ebx, goes into S through S's
    // test, whose window -- U's load -- reaches the inaccessible page from
    // there: S leaves before it runs, and the interpreter goes on to T, which
    // stores the two registers the stack holds. The block emitted before S's
    // test, R, ends with the stack emptied.
    const bytes = [
        0xd9, 0x05, 0x00, 0x60, 0, 0,       // fld dword [0x6000]
        0xd9, 0x05, 0x04, 0x60, 0, 0,       // fld dword [0x6004]
        0x8b, 0x03,                         // mov eax, [ebx]
        0x85, 0xc9,                         // test ecx, ecx
        0x75, 0x05,                         // jnz P
        0x8b, 0x43, 0x04,                   // Q: mov eax, [ebx+4]
        0xeb, 0x13,                         // jmp S
        0x81, 0xc3, 0xf0, 0x07, 0, 0,       // P: add ebx, 0x7f0
        0x85, 0xff,                         // test edi, edi
        0x75, 0x09,                         // jnz S
        0xdd, 0xd8,                         // R: fstp st0
        0xd9, 0x1d, 0x18, 0x60, 0, 0,       // fstp dword [0x6018]
        0xf4,                               // hlt
        0x85, 0xf6,                         // S: test esi, esi
        0x74, 0x07,                         // jz T
        0x8b, 0x93, 0xfc, 0x07, 0, 0,       // U: mov edx, [ebx+0x7fc]
        0xf4,                               // hlt
        0xd9, 0x1d, 0x10, 0x60, 0, 0,       // T: fstp dword [0x6010]
        0xd9, 0x1d, 0x14, 0x60, 0, 0,       // fstp dword [0x6014]
        0xf4,                               // hlt
    ];
    const plan = planRegion(regionOf(bytes).blocks, { entry: CODE, backward: true });
    assert.deepEqual(plan.inherit, [-1, 0, 0, 2, 1, 4, 4]);
    assert.deepEqual(plan.entry[4].map(w=>[w.lo, w.width]), [[0x7fc, 4], [0x6010, 8]],
        'U\'s load off ebx, and T\'s stores into the window B0\'s loads opened');
    for (const structure of [false, true])
    {
        for (const [ecx, edi, ebx] of [[1, 1, 0x4020], [1, 1, 0x4000], [0, 1, 0x4020],
            [1, 0, 0x4020]])
        {
            const exit = againstInterpreter(m=>{
                m.write(CODE, bytes);
                m.write(0x6000, [0, 0, 0x80, 0x3f, 0, 0, 0, 0x40]);  // 1.0, 2.0
                m.setReg('esp', STACK);
                m.setReg('ebx', ebx);
                m.setReg('ecx', ecx);
                m.setReg('edi', edi);
                m.pages.markRange(0x5000, 0x1000, PageFlag.INACCESSIBLE);
            }, CODE, structure, `ecx ${ecx} edi ${edi} ebx ${ebx.toString(16)}`
                + ` structure ${structure}`);
            assert.equal(exit.kind === Exit.UNTRANSLATED && exit.vector === 1,
                ecx === 1 && edi === 1 && ebx === 0x4020, 'left at S\'s test');
        }
    }
});

test('a jump back carries a window only where the dispatch takes it past the test', ()=>{
    const bytes = [
        0xeb, 0x07,                         // jmp B2
        0x8b, 0x43, 0x04,                   // B1: mov eax, [ebx+4]
        0x8b, 0x53, 0x08,                   // mov edx, [ebx+8]
        0xf4,                               // hlt
        0x8b, 0x0b,                         // B2: mov ecx, [ebx]
        0x85, 0xc9,                         // test ecx, ecx
        0x75, 0xf3,                         // jnz B1
        0xf4,                               // hlt
    ];
    const blocks = regionOf(bytes).blocks;
    const back = planRegion(blocks, { entry: CODE, backward: true });
    assert.deepEqual(back.inherit, [-1, 2, 0, 2]);
    assert.deepEqual(back.entry[1].map(w=>[w.lo, w.width]), [[4, 8]]);
    assert.equal(back.blocks[1].get(0)?.checks.length, 0);
    const not = planRegion(blocks, { entry: CODE, backward: false });
    assert.deepEqual(not.inherit, [-1, -1, 0, 2]);
    for (const structure of [false, true])
    {
        for (const [ebx, value] of [[0x4ff8, 1], [0x4f00, 1], [0x4ff8, 0], [0x4000, 1]])
        {
            againstInterpreter(m=>{
                m.write(CODE, bytes);
                m.setReg('esp', STACK);
                m.setReg('ebx', ebx);
                m.writeU32(ebx, value);
                m.pages.markRange(0x5000, 0x1000, PageFlag.INACCESSIBLE);
            }, CODE, structure, `ebx ${ebx.toString(16)} [ebx] ${value} structure ${structure}`);
            againstInterpreter(m=>{
                m.write(CODE, bytes);
                m.setReg('esp', STACK);
                m.setReg('ebx', ebx);
                m.pages.markRange(0x5000, 0x1000, PageFlag.INACCESSIBLE);
            }, CODE + 2, structure,
            `entered at B1, ebx ${ebx.toString(16)} structure ${structure}`);
        }
    }
});

test('random programs of several blocks, entered at any block, match the interpreter', ()=>{
    // Blocks of accesses and register moves by a page edge -- off esp, off
    // registers copied and moved, pushes through memory, x87 loads and
    // stores in some programs -- joined by fall-throughs, forward branches
    // and jumps, jumps back (a block's to itself among them) that ebp counts
    // down, and calls of callees formed into the region: the translated run,
    // from the region's entry or from any block, finished by the interpreter
    // where it leaves, against the interpreter alone.
    let seed = Number(process.env.REGION_SEED ?? 0x5eed7);
    const next = (/** @type {number} */ n)=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) % n;
    };
    // ebp counts the jumps back and nothing else writes it.
    const GPR = [0, 1, 2, 3, 6, 7];
    const pick = ()=>GPR[next(GPR.length)];
    const disp = ()=>(next(33) - 16) * 4 & 0xff;
    const modrm = (/** @type {number} */ r, /** @type {number} */ b)=>0x40 | r << 3 | b;
    /** Forms that leave esp where they found it: a callee's, which returns. */
    const balanced = [
        ()=>[0x8b, modrm(pick(), pick()), disp()],                 // mov r, [b+d]
        ()=>[0x89, modrm(pick(), pick()), disp()],                 // mov [b+d], r
        ()=>[0x01, modrm(pick(), pick()), disp()],                 // add [b+d], r
        ()=>[0x8b, modrm(pick(), 4), 0x24, disp()],                // mov r, [esp+d]
        ()=>[0x89, modrm(pick(), 4), 0x24, 4 + next(16) * 4],      // mov [esp+d], r: not the return
        ()=>[0x83, 0xc0 | pick(), next(64) - 32 & 0xff],           // add r, imm8
        ()=>[0x40 | pick()], ()=>[0x48 | pick()],                   // inc r, dec r
        ()=>[0x8d, modrm(pick(), pick()), disp()],                 // lea r, [r2+d]
        ()=>[0x89, 0xc0 | pick() << 3 | pick()],                   // mov r, r2
        ()=>[0x87, 0xc0 | pick() << 3 | pick()],                   // xchg r, r2
        ()=>[0xf7, 0xe9],                                           // imul ecx
    ];
    const moving = [
        ...balanced,
        ()=>[0x89, modrm(pick(), 4), 0x24, disp()],                // mov [esp+d], r
        ()=>[0xff, modrm(6, pick()), disp()],                      // push [b+d]
        ()=>[0x50 | pick()], ()=>[0x58 | pick()],                   // push r, pop r
    ];
    // fld dword [b+d]; fstp dword [b+d]: the stack as it was.
    const x87Form = ()=>[0xd9, modrm(0, pick()), disp(), 0xd9, modrm(3, pick()), disp()];
    const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
    for (let round = 0; round < Number(process.env.REGION_ROUNDS ?? 400); round++)
    {
        const x87 = next(4) === 0;
        /** @param {(() => number[])[]} forms @param {number} most */
        const body = (forms, most)=>{
            /** @type {number[]} */
            const bytes = [];
            for (let k = 1 + next(most); k > 0; k--)
            {
                bytes.push(...(x87 && next(4) === 0 ? x87Form() : forms[next(forms.length)]()));
            }
            return bytes;
        };
        const count = 2 + next(4);
        const callees = Array.from({ length: 1 + next(2) }, ()=>[...body(balanced, 4), 0xc3]);
        const bodies = Array.from({ length: count }, ()=>body(moving, 6));
        // The way out of each block: 0 falls through, 1 branches forward on
        // al, 2 jumps forward, 3 jumps back (to itself, or before) while ebp
        // stays above zero, 4 calls a callee and goes on after; the last
        // halts. The callees lie past it.
        const exits = bodies.map((_, k)=>(k === count - 1 ? -1 : next(5)));
        const sizes = exits.map(kind=>[1, 0, 8, 5, 7, 5][kind + 1]);
        /** @type {number[]} */
        const starts = [];
        let at = CODE;
        for (let k = 0; k < count; k++)
        {
            starts.push(at);
            at += bodies[k].length + sizes[k];
        }
        /** @type {number[]} */
        const entries = [];
        for (const callee of callees)
        {
            entries.push(at);
            at += callee.length;
        }
        /** @type {number[]} */
        const bytes = [];
        bodies.forEach((one, k)=>{
            bytes.push(...one);
            const end = starts[k] + one.length + sizes[k];
            const to = (/** @type {number} */ target)=>le(target - end);
            const later = starts[k + 1 + next(Math.max(1, count - k - 1))];
            if (exits[k] === -1)
            {
                bytes.push(0xf4);
            }
            else if (exits[k] === 1)
            {
                bytes.push(0xa8, next(256), 0x0f, 0x84 + next(2), ...to(later));
            }
            else if (exits[k] === 2)
            {
                bytes.push(0xe9, ...to(later));
            }
            else if (exits[k] === 3)
            {
                bytes.push(0x4d, 0x0f, 0x8f, ...to(starts[next(k + 1)]));
            }
            else if (exits[k] === 4)
            {
                bytes.push(0xe8, ...to(entries[next(entries.length)]));
            }
        });
        callees.forEach(callee=>bytes.push(...callee));
        const regs = names.map(()=>0x4f00 + next(0x180));
        regs[4] = 0x6f00 + next(0x180);
        regs[5] = 1 + next(3);
        const shut = [0x4000, 0x5000, 0x7000][next(3)];
        const code = next(3) === 0;
        const fill = Array.from({ length: 0x4000 }, ()=>next(256));
        const entry = next(2) === 0 ? CODE : starts[next(count)];
        const structure = next(2) === 0;
        const what = `round ${round}: ${bytes.map(x=>x.toString(16).padStart(2, '0')).join(' ')}`
            + ` regs ${JSON.stringify(regs)} shut ${shut} code ${code} entry ${entry.toString(16)}`
            + ` structure ${structure}`;
        againstInterpreter(m=>{
            m.write(CODE, bytes);
            m.write(0x4000, fill);
            names.forEach((name, r)=>m.setReg(name, regs[r]));
            m.pages.markRange(shut, 0x1000, PageFlag.INACCESSIBLE);
            if (code)
            {
                m.pages.markCode(0x4f80, 0x20);
                m.pages.markCode(0x6f80, 0x20);
            }
        }, entry, structure, what);
    }
});

/** @param {number} value */
function le(value){
    return [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
}

test('a self-loop of string instructions streams its pointers while DF is clear', ()=>{
    const loop = planLoop(regionOf([
        0xa4,                               // movsb
        0x39, 0xc7,                         // cmp edi, eax
        0x75, 0xfb,                         // jne back
    ]).blocks[0].instructions);
    assert.ok(loop !== null && loop.forward, 'planned for DF clear');
    assert.deepEqual(loop.streams.map(s=>[s.base, s.stride, s.store]).sort(),
        [[6, 1, false], [7, 1, true]]);
    assert.ok(loop.plan.get(0)?.store, 'the movs is planned, its store with it');
    assert.equal(loop.turns, 4097);
    // A loop that writes DF itself is planned for no direction.
    const flips = planLoop(regionOf([0xfd, 0xa5, 0x39, 0xc7, 0x75, 0xfa]).blocks[0].instructions);
    assert.ok(flips === null || !flips.plan.has(1));
    // A register copied from a pointer moves with it: lea ecx, [ebx+1];
    // mov ebx, ecx is ebx moved by one a turn.
    const copied = planLoop(regionOf([
        0x0f, 0xb6, 0x43, 0x01,             // movzx eax, byte [ebx+1]
        0x8d, 0x4b, 0x01,                   // lea ecx, [ebx+1]
        0x89, 0xcb,                         // mov ebx, ecx
        0x84, 0xc0,                         // test al, al
        0x75, 0xf3,                         // jnz back
    ]).blocks[0].instructions);
    assert.deepEqual(copied?.streams.map(s=>[s.base, s.stride, s.lo]), [[3, 1, 1]]);
});

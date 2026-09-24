/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { PageFlag } from '../runtime/pages.js';
import { readUndoLog, resetUndoLog, spansOf } from './memory.js';
import { Exit } from './region.js';
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

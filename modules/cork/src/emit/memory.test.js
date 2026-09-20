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
        m.pages.markRange(address, length, flag);
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

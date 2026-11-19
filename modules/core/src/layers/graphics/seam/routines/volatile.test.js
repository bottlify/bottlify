/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A routine's bytes laid out for a 64-bit process (`relaid`): the forms it
 * renames, the ones it refuses, its copy loop beside the `rep movs` it stands
 * for on cork's long-mode machine, and every routine of the catalog held to
 * the unwinder's rule for a leaf (`tools/checks/check-routine-leaves.mjs`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_64, KEPT_64, callLong, longMachine, runLongCode }
    from '../../../../../scripts/guest-code/long.mjs';
import { leafFaults } from '../../../../../../../tools/checks/check-routine-leaves.mjs';
import { I386, X64 } from './assemble.js';
import { routinesFor } from './catalog.fixture.js';
import { relaid } from './volatile.js';

/** @param {number[]} bytes */
const hex = bytes=>bytes.map(byte=>byte.toString(16).padStart(2, '0')).join(' ');

test('EBX, ESI and EDI become R9, R10 and R11 wherever an instruction names them', ()=>{
    for (const [from, to, what] of /** @type {[number[], number[], string][]} */ ([
        [[0x89, 0xc3], [0x41, 0x89, 0xc1], 'mov ebx, eax: the r/m field'],
        [[0x8b, 0xf0], [0x44, 0x8b, 0xd0], 'mov esi, eax: the reg field'],
        [[0x89, 0xf7], [0x45, 0x89, 0xd3], 'mov edi, esi: both'],
        [[0x8b, 0x43, 0x08], [0x41, 0x8b, 0x41, 0x08], 'mov eax, [ebx+8]: a base'],
        [[0x89, 0x8c, 0x93, 1, 2, 3, 4], [0x41, 0x89, 0x8c, 0x91, 1, 2, 3, 4],
            'mov [ebx+edx*4+disp], ecx: a base beside an index'],
        [[0x8b, 0x04, 0xb1], [0x42, 0x8b, 0x04, 0x91], 'mov eax, [ecx+esi*4]: an index'],
        [[0x8b, 0x04, 0x9d, 1, 2, 3, 4], [0x42, 0x8b, 0x04, 0x8d, 1, 2, 3, 4],
            'mov eax, [ebx*4+disp]: an index with no base'],
        [[0x48, 0x8b, 0x74, 0x24, 0x10], [0x4c, 0x8b, 0x54, 0x24, 0x10],
            'mov rsi, [rsp+16]: a REX there already'],
        [[0x83, 0xe7, 0x03], [0x41, 0x83, 0xe3, 0x03], 'and edi, 3: a group, its r/m alone'],
        [[0xf7, 0xc3, 1, 0, 0, 0], [0x41, 0xf7, 0xc1, 1, 0, 0, 0], 'test ebx, imm'],
        [[0xf0, 0x83, 0xa3, 1, 2, 3, 4, 0], [0xf0, 0x41, 0x83, 0xa1, 1, 2, 3, 4, 0],
            'lock and [ebx+disp], 0: the prefix stays first'],
        [[0xbe, 1, 2, 3, 4], [0x41, 0xba, 1, 2, 3, 4], 'mov esi, imm: a register in the opcode'],
        [[0x0f, 0xa3, 0x83, 1, 2, 3, 4], [0x41, 0x0f, 0xa3, 0x81, 1, 2, 3, 4],
            'bt [ebx+disp], eax'],
        [[0x0f, 0xaf, 0xde], [0x45, 0x0f, 0xaf, 0xca], 'imul ebx, esi'],
        [[0x87, 0x77, 0x04], [0x45, 0x87, 0x53, 0x04], 'xchg [edi+4], esi'],
        [[0x8b, 0x05, 1, 2, 3, 4], [0x8b, 0x05, 1, 2, 3, 4], 'mov eax, [rip+disp]: no base'],
        [[0x4c, 0x89, 0x4c, 0x24, 0x20], [0x4c, 0x89, 0x4c, 0x24, 0x20],
            'mov [rsp+32], r9: R9 as written stays R9'],
        [[0x89, 0xc8, 0x31, 0xc0, 0xc3], [0x89, 0xc8, 0x31, 0xc0, 0xc3], 'none: as written'],
        [[0x89, 0xc3, 0x89, 0xde], [0x41, 0x89, 0xc1, 0x45, 0x89, 0xca], 'two in a run'],
    ]))
    {
        assert.equal(hex(relaid(from)), hex(to), what);
    }
});

test('what the layout cannot read or rename is refused where the routine is built', ()=>{
    for (const [bytes, what] of /** @type {[number[], string][]} */ ([
        [[0x53], 'push ebx'],
        [[0x42], 'inc edx as one byte: a prefix at 64 bits, with nothing after it'],
        [[0x88, 0xf8], 'mov al, bh'],
        [[0x0f, 0x10, 0xc1], 'an instruction it was not taught'],
        [[0x81, 0xe3, 0x01], 'an instruction cut short'],
    ]))
    {
        assert.throws(()=>relaid(bytes), /^Error: shadow: /, what);
    }
});

for (const [unit, opcode, most] of /** @type {[1 | 4, number, number][]} */ ([[4, 0xa5, 13],
    [1, 0xa4, 40]]))
{
    test(`the copy loop leaves what rep movs of ${unit} bytes leaves, in R10, R11 and RCX`, ()=>{
        const SRC = 0x200000;
        const DST = 0x210000;
        const loop = new Uint8Array([...relaid([0xf3, opcode]), 0xc3]);
        const string = new Uint8Array([0xf3, opcode, 0xc3]);
        assert.deepEqual(leafFaults(loop, 0), []);
        for (let count = 0; count <= most; count++)
        {
            const pointers = { src: BigInt(SRC + 3), dst: BigInt(DST + 5), rcx: BigInt(count) };
            const looped = runLongCode(loop, { registers: { r10: pointers.src, r11: pointers.dst,
                rcx: pointers.rcx } });
            const reference = runLongCode(string, { registers: { rsi: pointers.src,
                rdi: pointers.dst, rcx: pointers.rcx } });
            assert.ok(looped.halted && reference.halted, `${count}: both return`);
            assert.equal(looped.regs.r10, reference.regs.rsi, `${count}: the source's end`);
            assert.equal(looped.regs.r11, reference.regs.rdi, `${count}: the destination's end`);
            assert.equal(looped.regs.rcx, 0n, `${count}: the count spent`);
            assert.equal(looped.regs.r10, pointers.src + BigInt(count * unit));
            for (const name of KEPT_64)
            {
                assert.equal(looped.regs[name], looped.entry[name], `${count}: ${name}`);
            }
        }
    });
}

test('the copy loop moves the bytes rep movs moves and none past them', ()=>{
    const SRC = 0x200000;
    const DST = 0x210000;
    const RETURN = 0x0f00;
    for (const [unit, opcode] of /** @type {[number, number][]} */ ([[4, 0xa5], [1, 0xa4]]))
    {
        const m = longMachine();
        m.write(RETURN, [0xf4]);
        m.write(CODE_64, [...relaid([0xf3, opcode]), 0xc3]);
        for (const count of [0, 1, 3, 4, 5, 15, 16, 17, 33])
        {
            const bytes = count * unit;
            const source = Uint8Array.from({ length: bytes + 32 }, (_, i)=>(i * 7 + count) & 0xff);
            m.write(SRC, source);
            m.write(DST, new Uint8Array(bytes + 32).fill(0xee));
            callLong(m, CODE_64, { returnTo: RETURN, registers: { r10: BigInt(SRC),
                r11: BigInt(DST + 8), rcx: BigInt(count) } });
            assert.equal(m.rip(), RETURN + 1);
            assert.deepEqual([...m.read(DST, bytes + 32)], [...new Array(8).fill(0xee),
                ...source.subarray(0, bytes), ...new Array(24).fill(0xee)],
            `${count} elements of ${unit}`);
        }
    }
});

test('every routine built for a 64-bit process is a leaf to the unwinder', ()=>{
    const routines = routinesFor(X64);
    assert.ok(routines.length > 100, `the catalog's routines at 64 bits: ${routines.length}`);
    for (const { name, code } of routines)
    {
        assert.deepEqual(leafFaults(code), [], name);
    }
});

test('the rule finds the routines as written on the i386\'s registers', ()=>{
    // The same sources without the layout: EBX, ESI, EDI and `rep movs` as written.
    const unlaid = Object.freeze({ ...X64, lay: (/** @type {number[]} */ bytes)=>bytes });
    const faulty = routinesFor(unlaid).filter(({ code })=>leafFaults(code).length > 0);
    assert.ok(faulty.length > 90, `routines that name a kept register: ${faulty.length}`);
    const copy = faulty.find(routine=>routine.name === 'the copy of a move');
    assert.ok(copy && leafFaults(copy.code).some(fault=>fault.endsWith(': movs')),
        'rep movs is among them');
});

test('a 32-bit process\'s routine is laid out as written', ()=>{
    const bytes = [0x53, 0x89, 0xc3, 0xf3, 0xa5, 0x5b];
    assert.equal(I386.lay(bytes), bytes);
});

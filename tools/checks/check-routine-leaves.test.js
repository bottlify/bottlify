/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compiledLeaves, leafFaults, reachedLeafFaults } from './check-routine-leaves.mjs';

/** @param {number[]} bytes */
const faults = bytes=>leafFaults(new Uint8Array(bytes), 0);

test('a leaf on volatile registers, reading its arguments off RSP, has no fault', ()=>{
    assert.deepEqual(faults([
        0x48, 0x89, 0x4c, 0x24, 0x08,                   // mov [rsp+8], rcx
        0x4c, 0x8b, 0x54, 0x24, 0x10,                   // mov r10, [rsp+16]
        0x45, 0x8b, 0x02,                               // mov r8d, [r10]
        0xf3, 0x41, 0x0f, 0x6f, 0x02,                   // movdqu xmm0, [r10]
        0xe8, 0x00, 0x00, 0x00, 0x00,                   // call +0
        0x31, 0xc0,                                     // xor eax, eax
        0xc3,                                           // ret
    ]), []);
});

test('each way out of being a leaf is found', ()=>{
    for (const [bytes, fault, what] of /** @type {[number[], RegExp, string][]} */ ([
        [[0x49, 0x89, 0xd9], /names rbx/, 'mov r9, rbx: a kept register read to be put back'],
        [[0x89, 0xc3], /names rbx/, 'mov ebx, eax'],
        [[0x8b, 0x46, 0x08], /addresses through rsi/, 'mov eax, [rsi+8]'],
        [[0x8b, 0x04, 0xb9], /addresses through rdi/, 'mov eax, [rcx+rdi*4]'],
        [[0x41, 0x8b, 0x04, 0x24], /addresses through r12/, 'mov eax, [r12]'],
        [[0x53], /push/, 'push rbx'],
        [[0x58], /pop/, 'pop rax: RSP moves'],
        [[0x48, 0x83, 0xec, 0x28], /names rsp/, 'sub rsp, 40'],
        [[0x48, 0x89, 0xe0], /names rsp/, 'mov rax, rsp'],
        [[0xf3, 0xa5], /movs/, 'rep movsd: RSI and RDI unnamed'],
        [[0xf3, 0xaa], /stos/, 'rep stosb'],
        [[0x88, 0xf8], /names rbx/, 'mov al, bh'],
        [[0x66, 0x0f, 0x6f, 0xf0], /names xmm6/, 'movdqa xmm6, xmm0'],
        [[0x0f, 0xff, 0x00], /not an instruction/, 'what the decoder does not read'],
    ]))
    {
        const found = faults(bytes);
        assert.ok(found.some(one=>fault.test(one)), `${what}: ${found.join('; ') || 'no fault'}`);
    }
});

test('compiled code is read as its entry reaches it: a table after the code is no instruction, '
    + 'a push past a branch is found, the hand-over\'s jump leaves', ()=>{
    const table = [0x53, 0x53, 0x0f, 0xff];                 // push rbx twice, then nothing known
    assert.deepEqual(reachedLeafFaults(new Uint8Array([
        0x85, 0xc9,                                         // test ecx, ecx
        0x75, 0x03,                                         // jne +3
        0x31, 0xc0,                                         // xor eax, eax
        0xc3,                                               // ret
        0x8b, 0xc1,                                         // mov eax, ecx
        0xc3,                                               // ret
        ...table,
    ]), 0), []);
    assert.deepEqual(reachedLeafFaults(new Uint8Array([
        0x85, 0xc9,                                         // test ecx, ecx
        0x75, 0x01,                                         // jne +1
        0xc3,                                               // ret
        0x52,                                               // push rdx
        0x5a,                                               // pop rdx
        0xc3,                                               // ret
    ]), 0), ['+5: push', '+6: pop']);
    const handing = new Uint8Array([
        0x85, 0xc9,                                         // test ecx, ecx
        0x74, 0x01,                                         // je +1
        0xc3,                                               // ret
        0xe9, 0x00, 0x00, 0x00, 0x00,                       // jmp the trap: not yet bound
        ...table,
    ]);
    assert.deepEqual(reachedLeafFaults(handing, 0, 6), []);
    assert.ok(reachedLeafFaults(handing, 0).length > 0, 'followed, an unbound jump reads the table');
});

test('every function the build marks a leaf is one, and the rest are counted', async()=>{
    const { leaves, faults, others } = await compiledLeaves();
    assert.deepEqual(faults, []);
    assert.ok(leaves > 50, `${leaves} leaves`);
    assert.ok(others.size > 5, 'the functions that call or keep registers are named by module');
});

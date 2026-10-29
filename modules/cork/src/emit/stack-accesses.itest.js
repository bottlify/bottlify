/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Accesses through esp as loose stacks translate them: a planned access off
 * esp alone takes its displacement as the load's or store's own offset
 * (`stackOffset` in integer.js), and a run of pushes or of pops in a block
 * moves esp once, each access at its own offset (`stackRun`). Seeded sequences
 * of reads, stores and read-modify-writes off esp by every reader and writer
 * -- integer, x87, scalar SSE -- pushes and pops of registers and immediates,
 * a push of a slot off esp and a pop into one, `push esp`, esp moved by
 * `add`, `sub` and `lea`, a call to the next instruction, accesses off another
 * register (edi, which nothing moves), and blocks' ends between them, translated
 * without `precise` (whose stacks are not loose) and judged against the
 * instruction model, the stack and the data compared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { DATA, REGISTERS, SPANS, random } from '../testing/sequences.js';
import { features } from '../wasm/features.js';

/**
 * What the sequences store onto: the stack, around the stack pointer they start with, and the
 * data edi points into.
 */
const STORED = [{ address: REGISTERS.esp - 0x200, length: 0x400 }, ...SPANS];

/** @param {number} value */
const at = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24];

/**
 * Every sequence starts with this: a frame of sixteen dwords below the stack
 * pointer, each a value no other is alike, and the registers set.
 *
 * @type {import('../testing/sequences.js').Form[]}
 */
const PREFIX = [
    { name: 'sub esp, 0x40', bytes: [0x83, 0xec, 0x40] },
    ...Array.from({ length: 16 }, (_, k)=>({
        name: `mov [esp+${4 * k}], v${k}`,
        bytes: [0xc7, 0x44, 0x24, 4 * k, ...at(0x3f810203 + k * 0x00213141)],
    })),
    { name: 'mov esi, 0x11223344', bytes: [0xbe, ...at(0x11223344)] },
    { name: 'mov edi, data', bytes: [0xbf, ...at(DATA + 0x10)] },
    { name: 'mov ebp, 0x0badf00d', bytes: [0xbd, ...at(0x0badf00d)] },
];

/** @type {import('../testing/sequences.js').Form[]} */
const DRAWN = [
    // integer reads off esp
    { name: 'mov eax, [esp+4]', bytes: [0x8b, 0x44, 0x24, 0x04] },
    { name: 'mov ecx, [esp+0x10]', bytes: [0x8b, 0x4c, 0x24, 0x10] },
    { name: 'mov esi, [esp]', bytes: [0x8b, 0x34, 0x24] },
    { name: 'add edx, [esp+8]', bytes: [0x03, 0x54, 0x24, 0x08] },
    { name: 'cmp eax, [esp+0x1c]', bytes: [0x3b, 0x44, 0x24, 0x1c] },
    { name: 'movzx ebx, byte [esp+3]', bytes: [0x0f, 0xb6, 0x5c, 0x24, 0x03] },
    { name: 'movsx esi, word [esp+0x16]', bytes: [0x0f, 0xbf, 0x74, 0x24, 0x16] },
    { name: 'mov edx, [esp+0x104]', bytes: [0x8b, 0x94, 0x24, ...at(0x104)] },
    // stores and read-modify-writes off esp
    { name: 'mov [esp+8], eax', bytes: [0x89, 0x44, 0x24, 0x08] },
    { name: 'mov [esp+0x14], ecx', bytes: [0x89, 0x4c, 0x24, 0x14] },
    { name: 'mov [esp], edi', bytes: [0x89, 0x3c, 0x24] },
    { name: 'mov byte [esp+5], dl', bytes: [0x88, 0x54, 0x24, 0x05] },
    { name: 'mov word [esp+6], bx', bytes: [0x66, 0x89, 0x5c, 0x24, 0x06] },
    { name: 'mov dword [esp+0x20], imm', bytes: [0xc7, 0x44, 0x24, 0x20, ...at(0x7e5a1234)] },
    { name: 'add [esp+0xc], eax', bytes: [0x01, 0x44, 0x24, 0x0c] },
    { name: 'inc dword [esp+4]', bytes: [0xff, 0x44, 0x24, 0x04] },
    // x87 and SSE off esp
    { name: 'fld dword [esp+8]', bytes: [0xd9, 0x44, 0x24, 0x08] },
    { name: 'fild dword [esp+4]', bytes: [0xdb, 0x44, 0x24, 0x04] },
    { name: 'fstp dword [esp+0x18]', bytes: [0xd9, 0x5c, 0x24, 0x18] },
    { name: 'movss xmm0, [esp+0xc]', bytes: [0xf3, 0x0f, 0x10, 0x44, 0x24, 0x0c] },
    { name: 'addss xmm0, [esp+0x24]', bytes: [0xf3, 0x0f, 0x58, 0x44, 0x24, 0x24] },
    { name: 'movss [esp+0x1c], xmm0', bytes: [0xf3, 0x0f, 0x11, 0x44, 0x24, 0x1c] },
    { name: 'movsd xmm1, [esp+0x10]', bytes: [0xf2, 0x0f, 0x10, 0x4c, 0x24, 0x10] },
    { name: 'movsd [esp+0x28], xmm1', bytes: [0xf2, 0x0f, 0x11, 0x4c, 0x24, 0x28] },
    // pushes and pops
    { name: 'push eax', bytes: [0x50] },
    { name: 'push ecx', bytes: [0x51] },
    { name: 'push esi', bytes: [0x56] },
    { name: 'push ebp', bytes: [0x55] },
    { name: 'push 0x40', bytes: [0x6a, 0x40] },
    { name: 'push imm32', bytes: [0x68, ...at(0x12345678)] },
    { name: 'push [esp+8]', bytes: [0xff, 0x74, 0x24, 0x08] },
    { name: 'push esp', bytes: [0x54] },
    { name: 'pop eax', bytes: [0x58] },
    { name: 'pop edx', bytes: [0x5a] },
    { name: 'pop esi', bytes: [0x5e] },
    { name: 'pop ebp', bytes: [0x5d] },
    { name: 'pop [esp+4]', bytes: [0x8f, 0x44, 0x24, 0x04] },
    { name: 'pop word ax', bytes: [0x66, 0x58] },
    // accesses off another register among them, which the plan may test as a group
    { name: 'mov eax, [edi+4]', bytes: [0x8b, 0x47, 0x04] },
    { name: 'mov [edi+8], ecx', bytes: [0x89, 0x4f, 0x08] },
    { name: 'add [edi], edx', bytes: [0x01, 0x17] },
    // esp moved
    { name: 'add esp, 8', bytes: [0x83, 0xc4, 0x08] },
    { name: 'sub esp, 0xc', bytes: [0x83, 0xec, 0x0c] },
    { name: 'lea esp, [esp+4]', bytes: [0x8d, 0x64, 0x24, 0x04] },
    { name: 'mov eax, esp', bytes: [0x89, 0xe0] },
    // a call to the next instruction, which pushes its address and goes on
    { name: 'call next', bytes: [0xe8, 0, 0, 0, 0] },
    // a block's end: both ways on the next instruction
    { name: 'jne next', bytes: [0x75, 0x00] },
    { name: 'jmp next', bytes: [0xeb, 0x00] },
];

const POOL = [...PREFIX, ...DRAWN];
const SEQUENCES = 1500;
/** The pushes, the pops and the call, drawn more often: runs of them are the point. */
const STACKED = DRAWN.flatMap((form, i)=>(/^(push|pop|call)/.test(form.name) ? [i] : []));

for (const [host, flags] of /** @type {const} */ ([
    ['an x64', { defaultNaNNegative: true, armHost: false }],
    ['an arm64', { defaultNaNNegative: true, armHost: true }],
]))
{
    test(`accesses through esp on loose stacks leave what the instruction model leaves (${host}`
        + ' host)', async()=>{
        const judge = createJudge({ pool: POOL, cork: { precise: false },
            features: { ...features(), ...flags }, spans: STORED });
        const next = random(0x57ac);
        const prefix = PREFIX.map((_, i)=>i);
        let judged = 0;
        /** @type {string[]} */
        const failures = [];
        for (let k = 0; k < SEQUENCES; k++)
        {
            const drawn = Array.from({ length: 3 + Math.floor(next() * 12) },
                ()=>PREFIX.length + (next() < 0.5
                    ? STACKED[Math.floor(next() * STACKED.length)]
                    : Math.floor(next() * DRAWN.length)));
            const result = await judge.judge([...prefix, ...drawn], []);
            if (result === null)
            {
                continue;
            }
            judged++;
            if (result.divergences.length > 0 && failures.length < 10)
            {
                const what = result.divergences.slice(0, 4)
                    .map(one=>`${one.name} ${String(one.expected)} != ${String(one.actual)}`);
                failures.push(`${drawn.map(i=>POOL[i].name).join('; ')}: ${what.join('; ')}`);
            }
        }
        assert.ok(judged > SEQUENCES * 0.9, `only ${judged} of ${SEQUENCES} ran`);
        assert.ok(judge.published() > judged * 0.9,
            `${judge.published()} of ${judged} translated`);
        assert.deepEqual(failures, []);
    });
}

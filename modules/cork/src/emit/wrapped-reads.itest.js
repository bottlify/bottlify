/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Reads left untested (`wrapsRead`) off registers their block reads other
 * fields off share one wrapped sum, the rest of each displacement the load's
 * own offset (`wrappedFirst` and `readAddress` in integer.js): negative
 * displacements below a frame's or a struct's pointer, small positive ones,
 * an array's at an absolute displacement off a scaled index. Seeded sequences
 * of such reads by every reader -- integer, x87, scalar and whole-vector SSE --
 * with the pointer and the index moved, stores through another pointer onto
 * the same bytes, a store through the read pointer itself (whole addresses
 * again) and blocks' ends between them, translated without `precise` and
 * judged against the instruction model. Every address read lies far above
 * 64 KiB, where the wrapped sum is the processor's address.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { DATA, random } from '../testing/sequences.js';
import { features } from '../wasm/features.js';

/** @param {number} address */
const at = address=>[address & 0xff, address >>> 8 & 0xff, address >>> 16 & 0xff,
    address >>> 24];

/** The pointer the reads go through, mid-data. */
const POINTER = DATA + 0x40;

/**
 * Every sequence starts with this: the pointer, the index and the other
 * pointer set, and the bytes the reads reach filled with values no two of
 * which are alike, floats or not (none a NaN, which `precise` off reads
 * without the processor's IE).
 *
 * @type {import('../testing/sequences.js').Form[]}
 */
const PREFIX = [
    { name: 'mov ebx, ptr', bytes: [0xbb, ...at(POINTER)] },
    { name: 'mov esi, 2', bytes: [0xbe, 2, 0, 0, 0] },
    { name: 'mov edi, data', bytes: [0xbf, ...at(DATA)] },
    ...Array.from({ length: 16 }, (_, k)=>({
        name: `mov [edi+${0x10 + 4 * k}], v${k}`,
        bytes: [0xc7, 0x47, 0x10 + 4 * k, ...at(0x3f810203 + k * 0x00213141)],
    })),
];

/** @type {import('../testing/sequences.js').Form[]} */
const DRAWN = [
    // integer reads off the pointer, below it and above it
    { name: 'mov eax, [ebx-8]', bytes: [0x8b, 0x43, 0xf8] },
    { name: 'mov ecx, [ebx-0x20]', bytes: [0x8b, 0x4b, 0xe0] },
    { name: 'mov edx, [ebx+4]', bytes: [0x8b, 0x53, 0x04] },
    { name: 'add eax, [ebx+0x10]', bytes: [0x03, 0x43, 0x10] },
    { name: 'sub ecx, [ebx-4]', bytes: [0x2b, 0x4b, 0xfc] },
    { name: 'cmp eax, [ebx-0x10]', bytes: [0x3b, 0x43, 0xf0] },
    { name: 'movzx edx, byte [ebx-1]', bytes: [0x0f, 0xb6, 0x53, 0xff] },
    { name: 'movsx eax, word [ebx-0xe]', bytes: [0x0f, 0xbf, 0x43, 0xf2] },
    { name: 'and ecx, [ebx-0xc]', bytes: [0x23, 0x4b, 0xf4] },
    { name: 'test eax, [ebx+0x18]', bytes: [0x85, 0x43, 0x18] },
    // off the pointer and a scaled index, and off the index alone at the array's address
    { name: 'mov eax, [ebx+esi*4-0x18]', bytes: [0x8b, 0x44, 0xb3, 0xe8] },
    { name: 'add ecx, [ebx+esi*4+8]', bytes: [0x03, 0x4c, 0xb3, 0x08] },
    { name: 'mov edx, [esi*4+data+0x30]', bytes: [0x8b, 0x14, 0xb5, ...at(DATA + 0x30)] },
    { name: 'add eax, [esi*4+data+0x38]', bytes: [0x03, 0x04, 0xb5, ...at(DATA + 0x38)] },
    // x87 reads
    { name: 'fld dword [ebx-8]', bytes: [0xd9, 0x43, 0xf8] },
    { name: 'fadd dword [ebx+4]', bytes: [0xd8, 0x43, 0x04] },
    { name: 'fmul dword [ebx-0x14]', bytes: [0xd8, 0x4b, 0xec] },
    { name: 'fild dword [ebx-0x1c]', bytes: [0xdb, 0x43, 0xe4] },
    { name: 'fiadd dword [ebx+0xc]', bytes: [0xda, 0x43, 0x0c] },
    { name: 'fld qword [ebx-0x18]', bytes: [0xdd, 0x43, 0xe8] },
    { name: 'fstp dword [edi+0x58]', bytes: [0xd9, 0x5f, 0x58] },
    { name: 'fstp st0', bytes: [0xdd, 0xd8] },
    // SSE reads, scalar and whole
    { name: 'movss xmm0, [ebx-4]', bytes: [0xf3, 0x0f, 0x10, 0x43, 0xfc] },
    { name: 'addss xmm0, [ebx+8]', bytes: [0xf3, 0x0f, 0x58, 0x43, 0x08] },
    { name: 'mulsd xmm1, [ebx-0x18]', bytes: [0xf2, 0x0f, 0x59, 0x4b, 0xe8] },
    { name: 'movsd xmm1, [ebx+0x10]', bytes: [0xf2, 0x0f, 0x10, 0x4b, 0x10] },
    { name: 'comiss xmm0, [ebx-0x20]', bytes: [0x0f, 0x2f, 0x43, 0xe0] },
    { name: 'cvtss2sd xmm1, [ebx+0x14]', bytes: [0xf3, 0x0f, 0x5a, 0x4b, 0x14] },
    { name: 'cvttss2si eax, [ebx-8]', bytes: [0xf3, 0x0f, 0x2c, 0x43, 0xf8] },
    { name: 'movups xmm2, [ebx-0x20]', bytes: [0x0f, 0x10, 0x53, 0xe0] },
    { name: 'movss [edi+0x50], xmm0', bytes: [0xf3, 0x0f, 0x11, 0x47, 0x50] },
    // the pointer and the index moved
    { name: 'add ebx, 4', bytes: [0x83, 0xc3, 0x04] },
    { name: 'sub ebx, 8', bytes: [0x83, 0xeb, 0x08] },
    { name: 'inc esi', bytes: [0x46] },
    { name: 'dec esi', bytes: [0x4e] },
    // stores onto the bytes read, through the other pointer and through the read one
    { name: 'mov [edi+0x30], eax', bytes: [0x89, 0x47, 0x30] },
    { name: 'mov [edi+0x44], ecx', bytes: [0x89, 0x4f, 0x44] },
    { name: 'mov [ebx-0xc], edx', bytes: [0x89, 0x53, 0xf4] },
    // a block's end: both ways on the next instruction
    { name: 'jne next', bytes: [0x75, 0x00] },
    { name: 'jmp next', bytes: [0xeb, 0x00] },
];

const POOL = [...PREFIX, ...DRAWN];
const SEQUENCES = 1500;

for (const [host, flags] of /** @type {const} */ ([
    ['an x64', { defaultNaNNegative: true, armHost: false }],
    ['an arm64', { defaultNaNNegative: true, armHost: true }],
]))
{
    test(`reads off a shared wrapped sum read what the instruction model reads (${host} host)`,
        async()=>{
            const judge = createJudge({ pool: POOL, cork: { precise: false },
                features: { ...features(), ...flags } });
            const next = random(0x5a3d);
            const prefix = PREFIX.map((_, i)=>i);
            let judged = 0;
            /** @type {string[]} */
            const failures = [];
            for (let k = 0; k < SEQUENCES; k++)
            {
                const drawn = Array.from({ length: 3 + Math.floor(next() * 12) },
                    ()=>PREFIX.length + Math.floor(next() * DRAWN.length));
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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The scalar SSE forms hold a register's low lane in a local of their own and
 * owe the vector its lane (`pendingLows` in region.js), putting it back where
 * the vector is read whole, at the block's end and on every way out; a scalar
 * load owes the zeroed vector on an arm64 host and loads it on an x64 one
 * (`owesLoads` in simd.js). Seeded sequences of scalar loads, stores and
 * arithmetic of both widths on the same registers, mixed with forms that read
 * or write the vectors whole, with blocks' ends and with ways out in the middle
 * of a block -- a store into the code page, `fldenv` -- judged against the
 * instruction model: the registers, the flags and the memory must come out the
 * same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { CODE, DATA, random } from '../testing/sequences.js';
import { features } from '../wasm/features.js';

/** @param {number} address */
const at = address=>[address & 0xff, address >>> 8 & 0xff, address >>> 16 & 0xff,
    address >>> 24];

/** @type {import('../testing/sequences.js').Form[]} */
const POOL = [
    { name: 'movss xmm0, [m]', bytes: [0xf3, 0x0f, 0x10, 0x05, ...at(DATA)] },
    { name: 'movss xmm1, [m+4]', bytes: [0xf3, 0x0f, 0x10, 0x0d, ...at(DATA + 4)] },
    { name: 'movsd xmm2, [m+8]', bytes: [0xf2, 0x0f, 0x10, 0x15, ...at(DATA + 8)] },
    { name: 'movss [m+16], xmm0', bytes: [0xf3, 0x0f, 0x11, 0x05, ...at(DATA + 16)] },
    { name: 'movsd [m+24], xmm2', bytes: [0xf2, 0x0f, 0x11, 0x15, ...at(DATA + 24)] },
    { name: 'movsd [m+24], xmm0', bytes: [0xf2, 0x0f, 0x11, 0x05, ...at(DATA + 24)] },
    { name: 'movss xmm0, xmm1', bytes: [0xf3, 0x0f, 0x10, 0xc1] },
    { name: 'movss xmm1, xmm0', bytes: [0xf3, 0x0f, 0x10, 0xc8] },
    { name: 'movsd xmm2, xmm0', bytes: [0xf2, 0x0f, 0x10, 0xd0] },
    { name: 'addss xmm0, xmm1', bytes: [0xf3, 0x0f, 0x58, 0xc1] },
    { name: 'mulss xmm1, xmm0', bytes: [0xf3, 0x0f, 0x59, 0xc8] },
    { name: 'subss xmm0, xmm0', bytes: [0xf3, 0x0f, 0x5c, 0xc0] },
    { name: 'divss xmm1, [m]', bytes: [0xf3, 0x0f, 0x5e, 0x0d, ...at(DATA)] },
    { name: 'sqrtss xmm0, xmm1', bytes: [0xf3, 0x0f, 0x51, 0xc1] },
    { name: 'addsd xmm0, xmm2', bytes: [0xf2, 0x0f, 0x58, 0xc2] },
    { name: 'mulsd xmm2, xmm2', bytes: [0xf2, 0x0f, 0x59, 0xd2] },
    // the vectors read or written whole
    { name: 'addps xmm1, xmm0', bytes: [0x0f, 0x58, 0xc8] },
    { name: 'movaps xmm2, xmm0', bytes: [0x0f, 0x28, 0xd0] },
    { name: 'movups [m+32], xmm0', bytes: [0x0f, 0x11, 0x05, ...at(DATA + 32)] },
    { name: 'shufps xmm0, xmm0, 0x1b', bytes: [0x0f, 0xc6, 0xc0, 0x1b] },
    { name: 'cvtss2sd xmm2, xmm0', bytes: [0xf3, 0x0f, 0x5a, 0xd0] },
    { name: 'comiss xmm0, xmm1', bytes: [0x0f, 0x2f, 0xc1] },
    { name: 'maxss xmm0, xmm1', bytes: [0xf3, 0x0f, 0x5f, 0xc1] },
    { name: 'xorps xmm1, xmm1', bytes: [0x0f, 0x57, 0xc9] },
    // forms that hand an owed lane on or read it as it is
    { name: 'movaps xmm1, xmm0', bytes: [0x0f, 0x28, 0xc8] },
    { name: 'movaps xmm0, xmm2', bytes: [0x0f, 0x28, 0xc2] },
    { name: 'cvtsd2ss xmm0, xmm2', bytes: [0xf2, 0x0f, 0x5a, 0xc2] },
    { name: 'cvtss2sd xmm0, [m]', bytes: [0xf3, 0x0f, 0x5a, 0x05, ...at(DATA)] },
    { name: 'cvttss2si eax, xmm0', bytes: [0xf3, 0x0f, 0x2c, 0xc0] },
    { name: 'cvtsd2si ecx, xmm2', bytes: [0xf2, 0x0f, 0x2d, 0xca] },
    { name: 'comiss xmm0, [m]', bytes: [0x0f, 0x2f, 0x05, ...at(DATA)] },
    { name: 'ucomisd xmm2, xmm0', bytes: [0x66, 0x0f, 0x2e, 0xd0] },
    // ways out in the middle of a block
    { name: 'movss [code], xmm0', bytes: [0xf3, 0x0f, 0x11, 0x05, ...at(CODE + 0xf00)] },
    { name: 'fnstenv [m+64]', bytes: [0xd9, 0x35, ...at(DATA + 0x40)] },
    { name: 'fldenv [m+64]', bytes: [0xd9, 0x25, ...at(DATA + 0x40)] },
    // a block's end: both ways on the next instruction
    { name: 'jne next', bytes: [0x75, 0x00] },
    { name: 'jmp next', bytes: [0xeb, 0x00] },
    // integer between them
    { name: 'mov eax, [m]', bytes: [0xa1, ...at(DATA)] },
    { name: 'add eax, ebx', bytes: [0x01, 0xd8] },
];

const SEQUENCES = 3000;

for (const [host, armHost] of /** @type {const} */ ([['an arm64', true], ['an x64', false]]))
{
    test(`owed low lanes come out as the instruction model leaves the registers (${host} host)`,
        async()=>{
            const judge = createJudge({ pool: POOL,
                features: { ...features(), defaultNaNNegative: true, armHost } });
            const next = random(0x10a5e);
            let judged = 0;
            /** @type {string[]} */
            const failures = [];
            for (let k = 0; k < SEQUENCES; k++)
            {
                const body = Array.from({ length: 3 + Math.floor(next() * 10) },
                    ()=>Math.floor(next() * POOL.length));
                const result = await judge.judge(body, []);
                if (result === null)
                {
                    continue;
                }
                judged++;
                if (result.divergences.length > 0 && failures.length < 10)
                {
                    const what = result.divergences.slice(0, 4)
                        .map(one=>`${one.name} ${String(one.expected)} != ${String(one.actual)}`);
                    failures.push(`${body.map(i=>POOL[i].name).join('; ')}: ${what.join('; ')}`);
                }
            }
            assert.ok(judged > SEQUENCES * 0.9, `only ${judged} of ${SEQUENCES} ran`);
            assert.ok(judge.published() > judged * 0.9,
                `${judge.published()} of ${judged} translated`);
            assert.deepEqual(failures, []);
        });
}

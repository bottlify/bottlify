/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MMX arithmetic judged against the instruction model: the saturating adds
 * and subtracts, the high multiply, the unpacks that broadcast a word, the
 * shifts by lane and by quadword, the masks, and the moves between the MMX
 * registers, the integer ones and memory -- the forms a software mixer or a
 * span filler is made of, which the sequence corpus's pool reaches only in
 * part (one wrapping add and a shuffle).
 *
 * The values reach the saturation bounds: the data holds words near both
 * ends of the signed range, so a sum or a difference that wraps where it
 * must clamp, or a high half taken unsigned, shows. Every sequence is
 * judged as the sequence corpus judges (`createJudge`): every register, the
 * flags, the x87 block the MMX registers alias, and the memory written.
 *
 * `SEQUENCES` raises the count, `SEQUENCE_SEED` names another run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { DATA, random } from '../testing/sequences.js';

const SEED = Number(process.env.SEQUENCE_SEED ?? 0x3d5c);
const COUNT = Number(process.env.SEQUENCES ?? 3000);

/** @param {number} address */
const disp32 = address=>[address & 0xff, address >>> 8 & 0xff,
    address >>> 16 & 0xff, address >>> 24 & 0xff];

/** Words near both signed bounds (the data's 0x5a5a00xx dwords), and the qword stores land in. */
const HIGH = DATA + 0x40;
const LOW = DATA + 8;
const OUT = DATA + 0x10;

/** @type {import('../testing/sequences.js').Form[]} */
const POOL = [
    { name: 'movq mm1, [high]', bytes: [0x0f, 0x6f, 0x0d, ...disp32(HIGH)] },
    { name: 'movq mm3, [low]', bytes: [0x0f, 0x6f, 0x1d, ...disp32(LOW)] },
    { name: 'movq mm4, [high+8]', bytes: [0x0f, 0x6f, 0x25, ...disp32(HIGH + 8)] },
    { name: 'movq mm7, mm3', bytes: [0x0f, 0x7f, 0xdf] },
    { name: 'movq mm0, mm5', bytes: [0x0f, 0x7f, 0xe8] },
    { name: 'movq mm5, mm3', bytes: [0x0f, 0x7f, 0xdd] },
    { name: 'psubsw mm0, mm3', bytes: [0x0f, 0xe9, 0xc3] },
    { name: 'psubsw mm3, [high]', bytes: [0x0f, 0xe9, 0x1d, ...disp32(HIGH)] },
    { name: 'psrlq mm7, 0x20', bytes: [0x0f, 0x73, 0xd7, 0x20] },
    { name: 'paddsw mm0, mm7', bytes: [0x0f, 0xed, 0xc7] },
    { name: 'paddsw mm0, mm1', bytes: [0x0f, 0xed, 0xc1] },
    { name: 'paddsw mm0, mm0', bytes: [0x0f, 0xed, 0xc0] },
    { name: 'paddsw mm7, [high]', bytes: [0x0f, 0xed, 0x3d, ...disp32(HIGH)] },
    { name: 'paddusw mm1, mm4', bytes: [0x0f, 0xdd, 0xcc] },
    { name: 'psubusb mm4, mm3', bytes: [0x0f, 0xd8, 0xe3] },
    { name: 'pand mm5, mm7', bytes: [0x0f, 0xdb, 0xef] },
    { name: 'pand mm0, mm6', bytes: [0x0f, 0xdb, 0xc6] },
    { name: 'pcmpeqw mm6, mm6', bytes: [0x0f, 0x75, 0xf6] },
    { name: 'psubw mm0, mm0', bytes: [0x0f, 0xf9, 0xc0] },
    { name: 'movd mm7, ebx', bytes: [0x0f, 0x6e, 0xfb] },
    { name: 'movd eax, mm1', bytes: [0x0f, 0x7e, 0xc8] },
    { name: 'punpcklwd mm7, mm7', bytes: [0x0f, 0x61, 0xff] },
    { name: 'punpckldq mm7, mm7', bytes: [0x0f, 0x62, 0xff] },
    { name: 'punpckhwd mm1, mm3', bytes: [0x0f, 0x69, 0xcb] },
    { name: 'pmulhw mm4, mm7', bytes: [0x0f, 0xe5, 0xe7] },
    { name: 'pmullw mm1, mm7', bytes: [0x0f, 0xd5, 0xcf] },
    { name: 'pmaddwd mm3, mm1', bytes: [0x0f, 0xf5, 0xd9] },
    { name: 'psraw mm7, 7', bytes: [0x0f, 0x71, 0xe7, 0x07] },
    { name: 'psllq mm3, 0x10', bytes: [0x0f, 0x73, 0xf3, 0x10] },
    { name: 'packsswb mm0, mm1', bytes: [0x0f, 0x63, 0xc1] },
    { name: 'movd [out], mm0', bytes: [0x0f, 0x7e, 0x05, ...disp32(OUT)] },
    { name: 'movq [out], mm0', bytes: [0x0f, 0x7f, 0x05, ...disp32(OUT)] },
    { name: 'movq [out+8], mm1', bytes: [0x0f, 0x7f, 0x0d, ...disp32(OUT + 8)] },
    { name: 'mov [out+12], ax', bytes: [0x66, 0xa3, ...disp32(OUT + 12)] },
    { name: 'mov ebx, 0x7fff8001', bytes: [0xbb, 0x01, 0x80, 0xff, 0x7f] },
    { name: 'add ebx, eax', bytes: [0x01, 0xc3] },
    { name: 'emms', bytes: [0x0f, 0x77] },
];

/** @param {number[]} indices */
const namesOf = indices=>indices.map(index=>POOL[index].name).join('; ');

test('MMX saturating, multiplying, unpacking and shifting forms leave what the instruction model'
    + ' leaves', async()=>{
    const judge = createJudge({ pool: POOL });
    const next = random(SEED);
    /** @type {string[]} */
    const failures = [];
    let judged = 0;
    let diverged = 0;
    for (let index = 0; index < COUNT; index++)
    {
        const length = 2 + Math.floor(next() * 11);
        const body = Array.from({ length }, ()=>Math.floor(next() * POOL.length));
        const result = await judge.judge(body, []);
        if (result === null)
        {
            continue;
        }
        judged++;
        if (result.divergences.length > 0)
        {
            diverged++;
            if (failures.length < 20)
            {
                failures.push(`seed ${SEED} #${index} ${namesOf(body)}: `
                    + result.divergences.slice(0, 4).map(one=>
                        `${one.name} ${String(one.expected)} != ${String(one.actual)}`).join('; '));
            }
        }
    }
    const share = judge.share();
    console.log(`MMX sequences: ${judged} judged, ${diverged} diverged, ${judge.published()}`
        + ` translated, ${share.toFixed(3)} of the subject's instructions the translator's`);
    assert.ok(judged > COUNT * 0.9, `only ${judged} of ${COUNT} sequences ran`);
    assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}`);
    // A gate that translated nothing judged the interpreter against itself.
    assert.ok(share > 0.9, `only ${share.toFixed(3)} of the instructions ran translated`);
});

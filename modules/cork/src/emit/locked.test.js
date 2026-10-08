/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The atomic variant's gate (a second path beside the plain one): seeded
 * sequences of locked instructions -- every lockable instruction at its
 * widths, on aligned and misaligned memory -- run translated with `atomic`
 * and on the instruction model, from one state, leave the same registers,
 * flags and memory. One thread: what the atomics add for many is judged by
 * the threads' test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { LOCKED_POOL } from '../testing/locked-sequences.js';
import { bodyOf, namesOf, random } from '../testing/sequences.js';

const COUNT = Number(process.env.LOCKED_SEQUENCES ?? 1500);

test('translated locked sequences, atomic, leave what the instruction model leaves', async()=>{
    const judge = createJudge({ pool: LOCKED_POOL, cork: { atomic: true } });
    const next = random(0x10c4ed);
    /** @type {string[]} */
    const failures = [];
    let judged = 0;
    for (let index = 0; index < COUNT; index++)
    {
        const body = bodyOf(next, { pool: LOCKED_POOL });
        const result = await judge.judge(body, []);
        if (result === null)
        {
            continue;
        }
        judged++;
        if (result.divergences.length > 0 && failures.length < 20)
        {
            failures.push(`#${index} ${namesOf(body, LOCKED_POOL)}: ${result.divergences
                .slice(0, 4).map(one=>`${one.name} ${String(one.expected)} != `
                    + `${String(one.actual)}`).join('; ')}`);
        }
    }
    assert.ok(judged > COUNT * 0.9, `${judged} of ${COUNT} ran`);
    assert.ok(judge.published() > judged * 0.9,
        `the translator published an entry for ${judge.published()} of ${judged}`);
    assert.ok(judge.share() > 0.5, `the translator ran ${judge.share()} of the instructions`);
    assert.deepEqual(failures, []);
});

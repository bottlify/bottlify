/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The executors' gate: an executor past the first runs its process's threads
 * over the same guest RAM with a state block, tables and wasm interpreter
 * statics of its own (`executorLayout`), all at addresses its translations
 * carry as constants. Seeded sequences translated on the third executor of a
 * memory leave what the instruction model leaves, as on the first -- every
 * x87, MMX and SSE form of the sequences' pool, and the locked forms in the
 * atomic variant. The corpus on such an executor is
 * `emit/corpus-executor.itest.js`, two interpreter tiers sharing a memory
 * `interp-wasm.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { LOCKED_POOL } from '../testing/locked-sequences.js';
import { bodyOf, namesOf, preambleOf, random } from '../testing/sequences.js';
import { EXECUTOR_BYTES, PAGE, Tables, executorLayout, ownLayout } from './layout.js';

const COUNT = Number(process.env.EXECUTOR_SEQUENCES ?? 2000);
const THIRD = { executors: 3, executor: 2 };

/**
 * Judges `count` sequences on a judge whose translator is the third executor.
 *
 * @param {ReturnType<typeof createJudge>} judge @param {number} count
 * @param {(next: () => number) => { body: number[], setup: number[] }} draw
 * @param {import('../testing/sequences.js').Form[] | undefined} pool
 */
async function judgeAll(judge, count, draw, pool){
    const next = random(0xe8ec5);
    /** @type {string[]} */
    const failures = [];
    let judged = 0;
    for (let index = 0; index < count; index++)
    {
        const { body, setup } = draw(next);
        const result = await judge.judge(body, setup);
        if (result === null)
        {
            continue;
        }
        judged++;
        if (result.divergences.length > 0 && failures.length < 20)
        {
            failures.push(`#${index} ${namesOf(body, pool)}: ${result.divergences.slice(0, 4)
                .map(one=>`${one.name} ${String(one.expected)} != ${String(one.actual)}`)
                .join('; ')}`);
        }
    }
    assert.ok(judged > count * 0.9, `${judged} of ${count} ran`);
    assert.ok(judge.published() > judged * 0.9,
        `the translator published an entry for ${judge.published()} of ${judged}`);
    assert.deepEqual(failures, []);
}

test('an executor\'s layout moves its state and tables, and only those', ()=>{
    const own = ownLayout({ ramSize: 1 << 20 });
    const base = Math.ceil((own.tables + Tables.SIZE) / PAGE) * PAGE + EXECUTOR_BYTES;
    const moved = executorLayout(own, base);
    assert.equal(moved.regs, base + own.regs);
    assert.equal(moved.eflags, base + own.eflags);
    assert.equal(moved.nanFirst, base + /** @type {number} */ (own.nanFirst));
    assert.equal(moved.tables, base + PAGE);
    assert.equal(moved.ramBase, own.ramBase, 'guest RAM is the process\'s');
    assert.equal(moved.flagsChanged, -1, 'an absent field stays absent');
    assert.notEqual(moved.id, own.id, 'its translations are its own');
    assert.throws(()=>executorLayout(own, own.tables), /not one past the first's/);
});

test('sequences translated on the third executor of a memory leave what the model leaves',
    async()=>{
        await judgeAll(createJudge({ executor: THIRD }), COUNT,
            next=>({ body: bodyOf(next), setup: preambleOf(next) }), undefined);
    });

test('locked sequences, atomic, on the third executor leave what the model leaves', async()=>{
    await judgeAll(createJudge({ pool: LOCKED_POOL, cork: { atomic: true }, executor: THIRD }),
        COUNT / 4, next=>({ body: bodyOf(next, { pool: LOCKED_POOL }), setup: [] }), LOCKED_POOL);
});

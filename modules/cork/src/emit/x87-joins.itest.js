/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 blocks entered with a top the region cannot settle, judged against the
 * instruction model.
 *
 * A branch around a push or a pop meets the code after it with two tops; a
 * block after one is compiled for a top the tracker guesses and tests the
 * machine's at its start (`trackRegion`, `x87BlockStart`). These sequences put
 * such branches between the sequence corpus's x87 forms, after a preamble that
 * leaves the stack at any depth, and the flags the branches read are what the
 * integer forms before them left: so a join is reached sometimes with the top
 * it was compiled for, which runs on in the region, and sometimes with the
 * other, which leaves it for the interpreter at that block. Both are judged as
 * the sequence corpus judges (`createJudge`): every register, the flags, the x87
 * block with its top, empty mask and status word, and the memory written.
 *
 * `SEQUENCES` raises the count, `SEQUENCE_SEED` names another run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { DATA, POOL, at, preambleOf, random } from '../testing/sequences.js';

const SEED = Number(process.env.SEQUENCE_SEED ?? 0x10e5);
const COUNT = Number(process.env.SEQUENCES ?? 3000);

/** @param {number} address */
const disp32 = address=>[address & 0xff, address >>> 8 & 0xff,
    address >>> 16 & 0xff, address >>> 24 & 0xff];

/**
 * The forms with a branch in them: each comes back together after itself
 * with one top or another, by the flags it is reached with.
 *
 * @type {import('../testing/sequences.js').Form[]}
 */
const JOINS = [
    { name: 'jc +2; fld1', bytes: [0x72, 0x02, 0xd9, 0xe8] },
    { name: 'jnc +2; fldz', bytes: [0x73, 0x02, 0xd9, 0xee] },
    { name: 'jz +2; fstp st0', bytes: [0x74, 0x02, 0xdd, 0xd8] },
    { name: 'js +6; fld qword [m]', bytes: [0x78, 0x06, 0xdd, 0x05, ...disp32(DATA)] },
    { name: 'jc +4; fld1; fld1', bytes: [0x72, 0x04, 0xd9, 0xe8, 0xd9, 0xe8] },
    // An if and an else that push a different number of registers.
    { name: 'jnc +4; fld1; jmp +4; fldz; fldz',
        bytes: [0x73, 0x04, 0xd9, 0xe8, 0xeb, 0x04, 0xd9, 0xee, 0xd9, 0xee] },
    { name: 'add eax, 0x9e3779b9', bytes: [0x05, 0xb9, 0x79, 0x37, 0x9e] },
];

/** The joins that meet with two tops, by their index in the pool. */
const JOINED = new Set(JOINS.flatMap((form, index)=>
    (form.name.startsWith('j') ? [POOL.length + index] : [])));

/** The sequence corpus's pool with the joins after it, so its preambles index the same forms. */
const POOL_WITH_JOINS = [...POOL, ...JOINS];

/** What a body is drawn from: the x87 forms, the integer ones that move the flags, the joins. */
const BODY = [
    'fld1', 'fldz', 'fld qword [m]', 'fstp qword [m]', 'fstp st0', 'faddp', 'fmul st0, st1',
    'fxch st1', 'fcomp', 'fnstsw ax', 'fst qword [m]', 'add eax, ebx',
].map(at).concat(JOINS.map((_, index)=>POOL.length + index));

/** @param {number[]} indices */
const namesOf = indices=>indices.map(index=>POOL_WITH_JOINS[index].name).join('; ');

test('x87 blocks reached with a top the region cannot settle leave what the instruction model'
    + ' leaves, whether their test of the top passes or not', async()=>{
    const judge = createJudge({ pool: POOL_WITH_JOINS });
    const next = random(SEED);
    /** @type {string[]} */
    const failures = [];
    let judged = 0;
    let diverged = 0;
    /** Sequences with a join in them that halted in translated code. */
    let through = 0;
    for (let index = 0; index < COUNT; index++)
    {
        const length = 3 + Math.floor(next() * 8);
        const body = Array.from({ length }, ()=>BODY[Math.floor(next() * BODY.length)]);
        const setup = preambleOf(next);
        const halts = judge.diagnostics().exits.halt ?? 0;
        const result = await judge.judge(body, setup);
        if (result === null)
        {
            continue;
        }
        judged++;
        if (body.some(form=>JOINED.has(form)) && (judge.diagnostics().exits.halt ?? 0) > halts)
        {
            through++;
        }
        if (result.divergences.length > 0)
        {
            diverged++;
            if (failures.length < 20)
            {
                failures.push(`seed ${SEED} #${index}`
                    + `${setup.length > 0 ? ` [${namesOf(setup)}]` : ''} ${namesOf(body)}: `
                    + result.divergences.slice(0, 4).map(one=>
                        `${one.name} ${String(one.expected)} != ${String(one.actual)}`).join('; '));
            }
        }
    }
    const report = judge.diagnostics();
    const share = judge.share();
    console.log(`x87 joins: ${judged} judged, ${diverged} diverged, ${judge.published()}`
        + ` translated, ${through} with a join halted in translated code,`
        + ` ${share.toFixed(3)} of the subject's instructions the translator's,`
        + ` exits ${JSON.stringify(report.exits)}`);
    assert.ok(judged > COUNT * 0.9, `only ${judged} of ${COUNT} sequences ran`);
    assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}`);
    // A join compiled for the other top leaves at its test, and the rest runs
    // on the interpreter: some must, or the test of the top was never failed.
    assert.ok((report.exits.untranslated ?? 0) > 0, 'no join was reached with the other top');
    // A join reached with the top it was compiled for runs on to the halt in
    // the region; when every join was left to the interpreter whole, none did.
    assert.ok(through > judged * 0.05, `only ${through} sequences with a join ran through it`);
});

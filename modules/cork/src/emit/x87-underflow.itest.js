/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 sequences that underflow, judged against the instruction model.
 *
 * The sequence corpus's pool reaches an empty register only through its pops
 * and its two writers: no conditional move, no `fxam`, nothing that writes ST1
 * or one register alone. These forms underflow the ways the processor answers
 * differently from an ordinary result (`testing/x87-underflow.js`): a
 * conditional move writes the indefinite whatever its condition, an exchange
 * fills the empty one first, every register written is held after, C1 is
 * cleared, and `fxam` reads the sign of what an empty register still holds --
 * a negative left there by `fchs` and a pop, by `ffree`, or by `fincstp`
 * moving the top past it. The integer forms move the flags the conditional
 * moves read, and the preamble leaves the stack at any depth, so a sequence
 * meets empty and held registers in every order, in a region entered with
 * them as they are. Judged as the sequence corpus judges (`createJudge`).
 *
 * `SEQUENCES` raises the count, `SEQUENCE_SEED` names another run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { POOL, at, preambleOf, random } from '../testing/sequences.js';

const SEED = Number(process.env.SEQUENCE_SEED ?? 0x5f1d);
const COUNT = Number(process.env.SEQUENCES ?? 3000);

/** @type {import('../testing/sequences.js').Form[]} */
const UNDERFLOWS = [
    { name: 'fcmove st0, st1', bytes: [0xda, 0xc9] },
    { name: 'fcmovne st0, st1', bytes: [0xdb, 0xc9] },
    { name: 'fcmovb st0, st2', bytes: [0xda, 0xc2] },
    { name: 'fcmovnbe st0, st1', bytes: [0xdb, 0xd1] },
    { name: 'fcmovu st0, st1', bytes: [0xda, 0xd9] },
    { name: 'fxam', bytes: [0xd9, 0xe5] },
    { name: 'fchs', bytes: [0xd9, 0xe0] },
    { name: 'fsqrt', bytes: [0xd9, 0xfa] },
    { name: 'fadd st1, st0', bytes: [0xdc, 0xc1] },
    { name: 'fsub st0, st1', bytes: [0xd8, 0xe1] },
    { name: 'fpatan', bytes: [0xd9, 0xf3] },
    { name: 'fxch st2', bytes: [0xd9, 0xca] },
    { name: 'ffree st1', bytes: [0xdd, 0xc1] },
    { name: 'fincstp', bytes: [0xd9, 0xf7] },
    { name: 'cmp eax, ecx', bytes: [0x39, 0xc8] },
    { name: 'xor eax, eax', bytes: [0x31, 0xc0] },
];

/** The sequence corpus's pool with these after it, so its preambles index the same forms. */
const POOL_WITH_UNDERFLOWS = [...POOL, ...UNDERFLOWS];

/** What a body is drawn from: the corpus's x87 forms that push and pop, and these. */
const BODY = ['fld1', 'fldz', 'fld qword [m]', 'fstp st0', 'faddp', 'fxch st1', 'fnstsw ax',
    'fnclex', 'add eax, ebx'].map(at).concat(UNDERFLOWS.map((_, index)=>POOL.length + index));

/** @param {number[]} indices */
const namesOf = indices=>indices.map(index=>POOL_WITH_UNDERFLOWS[index].name).join('; ');

/** The stack-fault flag, set by an underflow (or an overflow) until cleared. */
const SF = 0x40;

test('x87 sequences that underflow leave what the instruction model leaves', async()=>{
    const judge = createJudge({ pool: POOL_WITH_UNDERFLOWS });
    const next = random(SEED);
    /** @type {string[]} */
    const failures = [];
    let judged = 0;
    let diverged = 0;
    let faulted = 0;
    /** Sequences that faulted and halted in translated code: the fault was the translator's. */
    let through = 0;
    for (let index = 0; index < COUNT; index++)
    {
        const length = 2 + Math.floor(next() * 9);
        const body = Array.from({ length }, ()=>BODY[Math.floor(next() * BODY.length)]);
        const setup = preambleOf(next);
        const halts = judge.diagnostics().exits.halt ?? 0;
        const result = await judge.judge(body, setup);
        if (result === null)
        {
            continue;
        }
        judged++;
        if ((result.oracleState.x87.status & SF) !== 0)
        {
            faulted++;
            through += (judge.diagnostics().exits.halt ?? 0) > halts ? 1 : 0;
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
    console.log(`x87 underflows: ${judged} judged, ${diverged} diverged, ${faulted} faulted,`
        + ` ${through} of them halted in translated code, ${judge.published()} translated,`
        + ` ${judge.share().toFixed(3)} of the subject's instructions the translator's`);
    assert.ok(judged > COUNT * 0.9, `only ${judged} of ${COUNT} sequences ran`);
    // A region is compiled for the stack its entry plans (`planStack`) and left at
    // its test when the machine's is otherwise, so a share of the faulting
    // sequences runs on the interpreter -- but a share must fault in the region.
    assert.ok(faulted > judged * 0.25, `only ${faulted} of ${judged} sequences faulted`);
    assert.ok(through > faulted * 0.1, `only ${through} of ${faulted} faults were translated`);
    assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}`);
});

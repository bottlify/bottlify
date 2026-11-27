/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What an x87 region keeps from one block to the next rather than at every
 * block, judged against the instruction model in loops: the precision control
 * tested where the region is entered and after a call rather than in every
 * block that rounds (`planPrecision`), the empty mask and the top written where
 * something reads them rather than at every block's end (`planCarried`), and
 * the registers a way out stores found by comparing them with the state block
 * rather than by a mask kept as they are written (`compared`).
 *
 * Each sequence is a loop of three turns around forms drawn from the x87 pool
 * -- pushes and pops that leave the next turn another top, exchanges, compares,
 * branches around a push that join with two tops, the control word set to
 * single, double or extended precision in the middle of a turn, the
 * environment loaded, a store into the code page that leaves mid-block -- after
 * a preamble that leaves the stack at any depth and the precision either way.
 * Both are judged as the sequence corpus judges (`createJudge`): every
 * register, the flags, the x87 block with its top, empty mask and status word,
 * and the memory written. A judge's runtime remembers the precision each entry
 * missed and tests every rounding form of one that missed twice, so the judges
 * are made anew every few sequences, keeping the regions compiled for one
 * precision.
 *
 * `SEQUENCES` raises the count, `SEQUENCE_SEED` names another run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { CODE, DATA, POOL, preambleOf, random } from '../testing/sequences.js';

const SEED = Number(process.env.SEQUENCE_SEED ?? 0xca22ed);
const COUNT = Number(process.env.SEQUENCES ?? 1500);
/** Sequences a judge runs before a fresh one takes over (see above). */
const PER_JUDGE = 4;

/** @param {number} address */
const disp32 = address=>[address & 0xff, address >>> 8 & 0xff,
    address >>> 16 & 0xff, address >>> 24 & 0xff];

/** Where the control words the precision forms load are written first. */
const WORD = DATA + 0x50;

/** @param {string} name @param {number} control */
const precision = (name, control)=>({
    name: `fldcw ${name}`,
    // mov dword [w], control; fldcw [w]
    bytes: [0xc7, 0x05, ...disp32(WORD), control & 0xff, control >>> 8, 0, 0,
        0xd9, 0x2d, ...disp32(WORD)],
});

/** @type {import('../testing/sequences.js').Form[]} */
const EXTRA = [
    { name: 'fldpi', bytes: [0xd9, 0xeb] },
    // A result whose rounding the precision control decides, kept in the memory judged.
    { name: 'fldpi; fsqrt; fstp qword [m]', bytes: [0xd9, 0xeb, 0xd9, 0xfa, 0xdd, 0x1d,
        ...disp32(DATA)] },
    { name: 'fdiv st0, st1', bytes: [0xd8, 0xf1] },
    { name: 'fsqrt', bytes: [0xd9, 0xfa] },
    { name: 'fxam', bytes: [0xd9, 0xe5] },
    { name: 'fucomip st1', bytes: [0xdf, 0xe9] },
    { name: 'fadd st1, st0', bytes: [0xdc, 0xc1] },
    { name: 'fstp dword [m+0x48]', bytes: [0xd9, 0x1d, ...disp32(DATA + 0x48)] },
    { name: 'fld dword [m+0x48]', bytes: [0xd9, 0x05, ...disp32(DATA + 0x48)] },
    precision('single', 0x07f),
    precision('double', 0x27f),
    precision('extended', 0x37f),
    { name: 'jc +2; fld1', bytes: [0x72, 0x02, 0xd9, 0xe8] },
    { name: 'jz +2; fstp st0', bytes: [0x74, 0x02, 0xdd, 0xd8] },
    { name: 'ja +2; fldz', bytes: [0x77, 0x02, 0xd9, 0xee] },
    { name: 'add eax, 0x9e3779b9', bytes: [0x05, 0xb9, 0x79, 0x37, 0x9e] },
    // A store into the code page: the region leaves after it, mid-block.
    { name: 'mov [code+0xf00], eax', bytes: [0xa3, ...disp32(CODE + 0xf00)] },
    { name: 'mov ecx, 3', bytes: [0xb9, 0x03, 0x00, 0x00, 0x00] },
];

/**
 * The pool: the sequence corpus's own first, so its preambles index the same
 * forms, then the forms above, then the loops' ends -- `dec ecx; jnz` back over
 * every length a body can have.
 */
const BASE = POOL.length;
const MOVE_ECX = BASE + EXTRA.length - 1;
const LOOPS = BASE + EXTRA.length;
const LONGEST = 120;
const FULL = [...POOL, ...EXTRA, ...Array.from({ length: LONGEST + 1 }, (_, length)=>({
    name: `dec ecx; jnz -${length}`, bytes: [0x49, 0x75, -(length + 3) & 0xff],
}))];
/** @param {string} name */
const named = name=>FULL.findIndex(form=>form.name === name);

/**
 * What a loop's body is drawn from, by what each does to the stack's depth: a
 * body is balanced (pops or pushes added at its end) four times in five, so its
 * turns meet the loop's head with the top it was compiled for and run on in the
 * region; the rest, and the joins, meet it with another.
 *
 * @type {[string, number][]}
 */
const DRAWN = [
    ['fld1', 1], ['fldz', 1], ['fld qword [m]', 1], ['fstp qword [m]', -1], ['fstp st0', -1],
    ['faddp', -1], ['fmul st0, st1', 0], ['fxch st1', 0], ['fxch st2', 0], ['fcomp', -1],
    ['fnstsw ax', 0], ['fst qword [m]', 0], ['fldpi', 1], ['fdiv st0, st1', 0], ['fsqrt', 0],
    ['fxam', 0], ['fucomip st1', -1], ['fadd st1, st0', 0], ['fstp dword [m+0x48]', -1],
    ['fld dword [m+0x48]', 1], ['fldcw single', 0], ['fldcw double', 0], ['fldcw extended', 0],
    ['jc +2; fld1', 0], ['jz +2; fstp st0', 0], ['ja +2; fldz', 0], ['add eax, 0x9e3779b9', 0],
    // The arithmetic that rounds, more often than the rest.
    ['fdiv st0, st1', 0], ['fadd st1, st0', 0], ['fmul st0, st1', 0],
    ['fldpi; fsqrt; fstp qword [m]', 0], ['fldpi; fsqrt; fstp qword [m]', 0],
    ['fldcw single', 0], ['fldcw double', 0],
];
/** Drawn rarely: forms that write the whole stack's words, or leave mid-block. */
const RARE = ['ffree st0', 'fldenv [m]', 'fnstenv [m]', 'mov [code+0xf00], eax'];
const BODY = DRAWN.map(([name])=>named(name));
const DEPTH = new Map(DRAWN.map(([name, depth])=>[named(name), depth]));

/** @param {number[]} indices */
const namesOf = indices=>indices.map(index=>FULL[index].name).join('; ');

test('x87 loops with the precision, the stack words and the registers kept across blocks leave'
    + ' what the instruction model leaves', async()=>{
    const next = random(SEED);
    /** @type {string[]} */
    const failures = [];
    let judged = 0;
    let diverged = 0;
    let published = 0;
    let share = 0;
    /** @type {Record<string, number>} */
    const exits = {};
    let judge = createJudge({ pool: FULL });
    const tally = ()=>{
        published += judge.published();
        const report = judge.diagnostics();
        // A diagnostic build's breakdown of the untranslated exits, by why.
        const by = /** @type {{ untranslatedBy?: Record<string, number> }} */ (report).untranslatedBy;
        for (const [kind, count] of [...Object.entries(report.exits),
            ...Object.entries(by ?? {}).map(([why, n])=>[`by ${why}`, n])])
        {
            exits[kind] = (exits[kind] ?? 0) + Number(count);
        }
    };
    for (let index = 0; index < COUNT; index++)
    {
        if (index > 0 && index % PER_JUDGE === 0)
        {
            tally();
            share += judge.share() * PER_JUDGE;
            judge = createJudge({ pool: FULL });
        }
        const length = 2 + Math.floor(next() * 7);
        const forms = Array.from({ length }, ()=>(next() < 0.04
            ? named(RARE[Math.floor(next() * RARE.length)])
            : BODY[Math.floor(next() * BODY.length)]));
        if (next() < 0.8)
        {
            const depth = forms.reduce((sum, form)=>sum + (DEPTH.get(form) ?? 0), 0);
            for (let k = 0; k < Math.abs(depth); k++)
            {
                forms.push(named(depth > 0 ? 'fstp st0' : 'fldz'));
            }
        }
        const bytes = forms.reduce((sum, form)=>sum + FULL[form].bytes.length, 0);
        const body = [MOVE_ECX, ...forms, LOOPS + bytes];
        const setup = preambleOf(next);
        if (next() < 0.3)
        {
            setup.push(named('fldcw single'));
        }
        const result = await judge.judge(body, setup);
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
                failures.push(`seed ${SEED} #${index}`
                    + `${setup.length > 0 ? ` [${namesOf(setup)}]` : ''} ${namesOf(body)}: `
                    + result.divergences.slice(0, 4).map(one=>
                        `${one.name} ${String(one.expected)} != ${String(one.actual)}`).join('; '));
            }
        }
    }
    tally();
    share += judge.share() * (COUNT % PER_JUDGE || PER_JUDGE);
    share /= COUNT;
    const refused = Object.entries(judge.diagnostics().refused).map(([op, n])=>`${op}x${n}`);
    console.log(`x87 carried: ${judged} judged, ${diverged} diverged, ${published} translated,`
        + ` ${share.toFixed(3)} of the subject's instructions the translator's,`
        + ` exits ${JSON.stringify(exits)}, the last judge's refusals ${refused.join(' ')}`);
    assert.ok(judged > COUNT * 0.9, `only ${judged} of ${COUNT} sequences ran`);
    assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}`);
    assert.ok(published > judged * 0.9, `the translator published ${published} of ${judged}`);
    // Most of what leaves is a stack shape the speculation did not hold (a pop of the
    // preamble's empty stack) or a join reached with the other top, which the host runs.
    assert.ok(share > 0.3, `the translator ran ${share} of the subject's instructions`);
    assert.ok((exits['by precision'] ?? 0) > 0, 'no region left for its precision control');
    assert.ok((exits.halt ?? 0) > judged * 0.25, `only ${exits.halt} runs halted in a region`);
});

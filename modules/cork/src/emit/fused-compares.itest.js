/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A float compare whose flags only its block's final branch reads makes no
 * flags: the branch compares the operands (`fcmp`, `fusesCompare` in
 * region.js); so does a `bt` whose carry a `jb` or `jae` alone reads, the
 * branch testing its bit (`carryBit`). Instructions that leave the flags be
 * may stand between the two -- a compiler schedules a store or a multiply
 * there -- the operands waiting in locals of their own, and a way out of one
 * of them makes the flags the compare left (`payFloatCompare`,
 * `payBitTest`). Seeded sequences of SSE compares of both widths and bit
 * tests, then flag-neutral forms (scalar arithmetic on the compared
 * registers, moves, stores, one into the code page that leaves after it),
 * then a conditional branch of every condition, judged against the
 * instruction model: the registers, the flags and the memory must come out
 * the same.
 *
 * A float compare whose flags are read past its branch, or by no branch,
 * leaves them in the record as its operands' bits (`Kind.FCMP`,
 * `recordFloatCompare`), and whoever reads one compares again. Seeded
 * sequences of SSE and x87 compares over ordered, equal and unordered
 * operands, a branch that leaves the flags be on both its ways, then what
 * reads them in the blocks after -- every `setcc`, conditional moves, `adc`
 * and `sbb`, an `inc` that keeps the carry, `pushfd` and `lahf`, a carry
 * written alone, another branch, or nothing before the region's end -- judged
 * the same way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { CODE, DATA, random } from '../testing/sequences.js';

/** @param {number} address */
const at = address=>[address & 0xff, address >>> 8 & 0xff, address >>> 16 & 0xff,
    address >>> 24];

/** @type {import('../testing/sequences.js').Form[]} */
const COMPARES = [
    { name: 'comiss xmm0, xmm1', bytes: [0x0f, 0x2f, 0xc1] },
    { name: 'ucomiss xmm1, [m]', bytes: [0x0f, 0x2e, 0x0d, ...at(DATA)] },
    { name: 'comisd xmm2, xmm0', bytes: [0x66, 0x0f, 0x2f, 0xd0] },
    { name: 'ucomisd xmm2, [m+8]', bytes: [0x66, 0x0f, 0x2e, 0x15, ...at(DATA + 8)] },
    { name: 'comiss xmm0, xmm0', bytes: [0x0f, 0x2f, 0xc0] },
    // a bit test, whose carry a jb or jae alone reads
    { name: 'bt eax, ecx', bytes: [0x0f, 0xa3, 0xc8] },
    { name: 'bt ecx, 3', bytes: [0x0f, 0xba, 0xe1, 0x03] },
    { name: 'bt dword [m], 9', bytes: [0x0f, 0xba, 0x25, ...at(DATA), 0x09] },
];

/** @type {import('../testing/sequences.js').Form[]} */
const BETWEEN = [
    { name: 'movss xmm0, [m]', bytes: [0xf3, 0x0f, 0x10, 0x05, ...at(DATA)] },
    { name: 'movss xmm1, [m+4]', bytes: [0xf3, 0x0f, 0x10, 0x0d, ...at(DATA + 4)] },
    { name: 'movsd xmm2, [m+8]', bytes: [0xf2, 0x0f, 0x10, 0x15, ...at(DATA + 8)] },
    { name: 'movss [m+16], xmm0', bytes: [0xf3, 0x0f, 0x11, 0x05, ...at(DATA + 16)] },
    { name: 'movsd [m+24], xmm2', bytes: [0xf2, 0x0f, 0x11, 0x15, ...at(DATA + 24)] },
    { name: 'mulss xmm1, xmm0', bytes: [0xf3, 0x0f, 0x59, 0xc8] },
    { name: 'addss xmm0, xmm1', bytes: [0xf3, 0x0f, 0x58, 0xc1] },
    { name: 'subsd xmm2, xmm2', bytes: [0xf2, 0x0f, 0x5c, 0xd2] },
    { name: 'divss xmm1, [m]', bytes: [0xf3, 0x0f, 0x5e, 0x0d, ...at(DATA)] },
    { name: 'xorps xmm0, xmm0', bytes: [0x0f, 0x57, 0xc0] },
    { name: 'movaps xmm1, xmm0', bytes: [0x0f, 0x28, 0xc8] },
    { name: 'cvtss2sd xmm2, xmm0', bytes: [0xf3, 0x0f, 0x5a, 0xd0] },
    { name: 'cvttss2si eax, xmm0', bytes: [0xf3, 0x0f, 0x2c, 0xc0] },
    { name: 'mov dword [m+32], 0', bytes: [0xc7, 0x05, ...at(DATA + 32), 0, 0, 0, 0] },
    { name: 'mov eax, [m]', bytes: [0xa1, ...at(DATA)] },
    { name: 'lea ecx, [eax+ebx*2+4]', bytes: [0x8d, 0x4c, 0x58, 0x04] },
    // a way out after it: a store into the code page, over the immediate of
    // the sequence's first instruction (`FIRST`) with the byte it holds
    { name: 'mov byte [code+1], 0x11', bytes: [0xc6, 0x05, ...at(CODE + 1), 0x11] },
    { name: 'fnstenv [m+64]', bytes: [0xd9, 0x35, ...at(DATA + 0x40)] },
    { name: 'fldenv [m+64]', bytes: [0xd9, 0x25, ...at(DATA + 0x40)] },
    // what reads or writes the flags: the compare is not fused over it
    { name: 'add eax, ebx', bytes: [0x01, 0xd8] },
    { name: 'setb cl', bytes: [0x0f, 0x92, 0xc1] },
    { name: 'adc edx, 0', bytes: [0x83, 0xd2, 0x00] },
];

/**
 * Each condition, its branch taken past `SKIPPED`, so where it goes shows in
 * edx. @type {import('../testing/sequences.js').Form[]}
 */
const BRANCHES = [0x70, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x7a, 0x7b, 0x7c, 0x7e, 0x7f]
    .map(op=>({ name: `j${op.toString(16)} +3`, bytes: [op, 0x03] }));

/**
 * After the branch: the instruction it skips, then the flags written again,
 * so it alone reads the compare's.
 */
const AFTER = [
    { name: 'add edx, 1', bytes: [0x83, 0xc2, 0x01] },
    { name: 'add eax, ebx', bytes: [0x01, 0xd8] },
];

/**
 * Every sequence's first instruction, at the code page's start: a register a
 * bit test reads given one of several values, its immediate's low byte 0x11.
 */
const FIRST = [0x11, 0x2211, 0x80000311, 0x7f0f0f11, 0x10011, 0xffffff11].flatMap(value=>[
    { name: `mov eax, ${value.toString(16)}`, bytes: [0xb8, ...at(value)] },
    { name: `mov ecx, ${value.toString(16)}`, bytes: [0xb9, ...at(value)] },
]);

const POOL = [...COMPARES, ...BETWEEN, ...BRANCHES, ...AFTER, ...FIRST];
const SEQUENCES = 4000;

test('a float compare or a bit test fused with its branch over the instructions between'
    + ' them leaves the flags and the state as the instruction model does', async()=>{
    const judge = createJudge({ pool: POOL });
    const next = random(0xf05ed);
    /** @param {number} from @param {number} count */
    const pick = (from, count)=>from + Math.floor(next() * count);
    let judged = 0;
    /** @type {string[]} */
    const failures = [];
    for (let k = 0; k < SEQUENCES; k++)
    {
        // a compare, zero to four between, a branch
        const body = [pick(POOL.length - FIRST.length, FIRST.length), pick(0, COMPARES.length)];
        for (let n = Math.floor(next() * 5); n > 0; n--)
        {
            body.push(pick(COMPARES.length, BETWEEN.length));
        }
        const after = COMPARES.length + BETWEEN.length + BRANCHES.length;
        body.push(pick(COMPARES.length + BETWEEN.length, BRANCHES.length), after, after + 1);
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
    assert.ok(judge.published() > judged * 0.9, `${judge.published()} of ${judged} translated`);
    assert.deepEqual(failures, []);
});

/** Operands a compare tells apart: a NaN, equal lanes, and what the registers held. */
const OPERANDS = [
    { name: 'nop', bytes: [0x90] },
    { name: 'xorps xmm0, xmm0; divss xmm0, xmm0',
        bytes: [0x0f, 0x57, 0xc0, 0xf3, 0x0f, 0x5e, 0xc0] },
    { name: 'movaps xmm1, xmm0', bytes: [0x0f, 0x28, 0xc8] },
    { name: 'movaps xmm2, xmm0', bytes: [0x0f, 0x28, 0xd0] },
    { name: 'subsd xmm2, xmm2; divsd xmm2, xmm2',
        bytes: [0xf2, 0x0f, 0x5c, 0xd2, 0xf2, 0x0f, 0x5e, 0xd2] },
    { name: 'movsd xmm0, [m+8]', bytes: [0xf2, 0x0f, 0x10, 0x05, ...at(DATA + 8)] },
];

/** The SSE compares, and x87 ones over a less, a greater, an equal and an unordered pair. */
const RECORDED = [
    ...COMPARES.slice(0, 5),
    { name: 'fld1; fldz; fucomip st, st1; fstp st0',
        bytes: [0xd9, 0xe8, 0xd9, 0xee, 0xdf, 0xe9, 0xdd, 0xd8] },
    { name: 'fldz; fld1; fcomip st, st1; fstp st0',
        bytes: [0xd9, 0xee, 0xd9, 0xe8, 0xdf, 0xf1, 0xdd, 0xd8] },
    { name: 'fld1; fld1; fucomi st, st1; fstp st0; fstp st0',
        bytes: [0xd9, 0xe8, 0xd9, 0xe8, 0xdb, 0xe9, 0xdd, 0xd8, 0xdd, 0xd8] },
    { name: 'fldz; fldz; fdivp; fld1; fucomip st, st1; fstp st0',
        bytes: [0xd9, 0xee, 0xd9, 0xee, 0xde, 0xf9, 0xd9, 0xe8, 0xdf, 0xe9, 0xdd, 0xd8] },
    { name: 'fld qword [m]; fld qword [m]; fcomip st, st1; fstp st0',
        bytes: [0xdd, 0x05, ...at(DATA), 0xdd, 0x05, ...at(DATA), 0xdf, 0xf1, 0xdd, 0xd8] },
];

/** What may stand between the compare and its branch, the flags left be. */
const NEUTRAL = BETWEEN.slice(0, 5).concat(BETWEEN.slice(13, 16));

/** The instruction a taken branch skips: it keeps the flags, so both ways on carry the compare's. */
const SKIPPED = { name: 'lea edx, [edx+1]', bytes: [0x8d, 0x52, 0x01] };

/** What reads the compare's flags in the blocks after its branch. */
const READERS = [
    ...Array.from({ length: 16 }, (_, cc)=>({ name: `set${cc.toString(16)} cl`,
        bytes: [0x0f, 0x90 | cc, 0xc1] })),
    { name: 'cmovb eax, ebx', bytes: [0x0f, 0x42, 0xc3] },
    { name: 'cmova ecx, ebx', bytes: [0x0f, 0x47, 0xcb] },
    { name: 'cmovp eax, ecx', bytes: [0x0f, 0x4a, 0xc1] },
    { name: 'cmove ebx, eax', bytes: [0x0f, 0x44, 0xd8] },
    { name: 'adc edx, 0', bytes: [0x83, 0xd2, 0x00] },
    { name: 'sbb ebx, ebx', bytes: [0x19, 0xdb] },
    { name: 'rcl eax, 1', bytes: [0xd1, 0xd0] },
    { name: 'inc eax', bytes: [0x40] },
    { name: 'dec ecx', bytes: [0x49] },
    { name: 'pushfd; pop eax', bytes: [0x9c, 0x58] },
    { name: 'lahf', bytes: [0x9f] },
    { name: 'cmc', bytes: [0xf5] },
    { name: 'stc', bytes: [0xf9] },
    { name: 'bt eax, 3', bytes: [0x0f, 0xba, 0xe0, 0x03] },
    { name: 'jb +1; inc ebx', bytes: [0x72, 0x01, 0x43] },
    { name: 'jnp +1; inc ebx', bytes: [0x7b, 0x01, 0x43] },
    { name: 'nop', bytes: [0x90] },
];

const READ_POOL = [...OPERANDS, ...RECORDED, ...NEUTRAL, ...BRANCHES, SKIPPED, ...READERS];

test('a float compare whose flags are read past its branch leaves them as the instruction'
    + ' model does, whoever reads them', async()=>{
    const judge = createJudge({ pool: READ_POOL });
    const next = random(0xfc3b);
    /** @param {number} from @param {number} count */
    const pick = (from, count)=>from + Math.floor(next() * count);
    const recorded = OPERANDS.length;
    const neutral = recorded + RECORDED.length;
    const branches = neutral + NEUTRAL.length;
    const skipped = branches + BRANCHES.length;
    const readers = skipped + 1;
    let judged = 0;
    /** @type {string[]} */
    const failures = [];
    for (let k = 0; k < SEQUENCES; k++)
    {
        // operands, a compare, what stands between, then a branch or none, and the readers
        const body = [];
        for (let n = Math.floor(next() * 3); n > 0; n--)
        {
            body.push(pick(0, OPERANDS.length));
        }
        body.push(pick(recorded, RECORDED.length));
        for (let n = Math.floor(next() * 3); n > 0; n--)
        {
            body.push(pick(neutral, NEUTRAL.length));
        }
        if (next() < 0.75)
        {
            body.push(pick(branches, BRANCHES.length), skipped);
        }
        for (let n = 1 + Math.floor(next() * 3); n > 0; n--)
        {
            body.push(pick(readers, READERS.length));
        }
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
            failures.push(`${body.map(i=>READ_POOL[i].name).join('; ')}: ${what.join('; ')}`);
        }
    }
    assert.ok(judged > SEQUENCES * 0.9, `only ${judged} of ${SEQUENCES} ran`);
    assert.ok(judge.published() > judged * 0.9, `${judge.published()} of ${judged} translated`);
    assert.deepEqual(failures, []);
});

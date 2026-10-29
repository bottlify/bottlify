/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The indexed byte copy loop run whole (`emitIndexedCopyAtOnce` in
 * copy-loop.js) beside the long-mode interpreter: seeded programs of the
 * loop's forms -- the index copied before its step or not, compared before or
 * after it, going up or down, either compare order, displacements on both
 * sides, extended registers -- each run from a source and a destination in
 * the data area, a few bytes apart either way or far, running off its end into
 * a closed page, past or across the 4 GiB window, onto the code's page, for
 * one turn to past the limit, or for ever (an end the compare never meets) --
 * run as translated regions and on the interpreter alone, under budgets that
 * end a run part way and that do not, and everything a program can see is
 * compared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, compare, load, machine } from '../testing/long-machine.js';

/**
 * The forms, as bytes, and their registers: `source` and `target` the bases,
 * `index`, `end` the register compared with, `copy` the index's copy, and
 * which of the two the compare reads; `step` up or down, the displacements.
 */
const FORMS = [
    // gcc's memcpy: the copy is the byte's register too
    { code: '0fb60c16880c104889d14883c2014839f975ed', source: 6, target: 0, index: 2,
        end: 7, step: 1, compared: 'copy', sourceDisp: 0, targetDisp: 0 },
    // memmove forward, the compare's operands the other way round
    { code: '0fb614068814014889c24883c0014839d775ed', source: 6, target: 1, index: 0,
        end: 7, step: 1, compared: 'copy', sourceDisp: 0, targetDisp: 0 },
    // memmove backward: the index itself compared, after its step
    { code: '0fb6140641881401 4883e8014939c075ef', source: 6, target: 9, index: 0,
        end: 8, step: -1, compared: 'index', sourceDisp: 0, targetDisp: 0 },
    // a quadword byte register, displacements either side
    { code: '4c0fb6541e044488541ffe4883c3014c39db75ec', source: 6, target: 7, index: 3,
        end: 11, step: 1, compared: 'index', sourceDisp: 4, targetDisp: -2 },
    // extended registers, the copy compared, going down
    { code: '470fb6742cff4788742f104c89ed4983ed014839e975e9', source: 12, target: 15,
        index: 13, end: 1, step: -1, compared: 'copy', sourceDisp: -1, targetDisp: 0x10 },
].map(form=>({ ...form, code: form.code.replace(/ /g, '') }));

/** A page of the code area closed, which some runs cross. */
const CLOSED = BigInt(CORPUS.codeAt + 0x3000);

/** `mov r64, imm64`. @param {number} register @param {bigint} value */
const move = (register, value)=>{
    const bytes = Buffer.alloc(10);
    bytes[0] = 0x48 | (register >= 8 ? 1 : 0);
    bytes[1] = 0xb8 + (register & 7);
    bytes.writeBigUInt64LE(BigInt.asUintN(64, value), 2);
    return bytes.toString('hex');
};

/**
 * One case: a form copying `turns` bytes from `from` to `to` (the first
 * turn's addresses), its index starting at `first`.
 *
 * @param {typeof FORMS[number]} form @param {bigint} from @param {bigint} to
 * @param {bigint | null} turns  null for an end the compare never meets
 * @param {bigint} first
 */
function program(form, from, to, turns, first){
    const step = BigInt(form.step);
    // The compared register at the last turn: the index there, or past it.
    const end = turns === null ? first - 7n * step
        : first + (turns - 1n) * step + (form.compared === 'index' ? step : 0n);
    return move(form.source, from - BigInt(form.sourceDisp) - first)
        + move(form.target, to - BigInt(form.targetDisp) - first)
        + move(form.index, first) + move(form.end, end) + form.code;
}

/** Seeded cases over the forms and the places. @param {number} count */
function cases(count){
    let state = 0x1dc0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    const data = BigInt(CORPUS.dataAt);
    const dataEnd = data + BigInt(CORPUS.dataSize);
    const window = 1n << 32n;
    const TURNS = [1n, 2n, 3n, 7n, 12n, 16n, 64n, 300n, 1000n, 4096n, 4097n, null];
    const DISTANCES = [-16n, -9n, -8n, -7n, -1n, 1n, 2n, 7n, 8n, 9n, 16n, 0x800n];
    const one = CORPUS.cases[0];
    return Array.from({ length: count }, (_, k)=>{
        const form = FORMS[pick(FORMS.length)];
        let turns = TURNS[pick(TURNS.length)];
        const where = pick(10);
        // The lowest byte of the source's run, and of the destination's.
        let low = data + 0x40n + BigInt(pick(0x400));
        let other = low + DISTANCES[pick(DISTANCES.length)];
        if (where === 0)
        {
            low = dataEnd - BigInt(1 + pick(24)); // into the closed page past the data
        }
        else if (where === 1)
        {
            other = dataEnd - BigInt(1 + pick(24));
        }
        else if (where === 2)
        {
            low += window; // past the window, its low half in the data
        }
        else if (where === 3)
        {
            other = window - BigInt(1 + pick(12)); // across the window's end
        }
        else if (where === 4)
        {
            other = BigInt(CORPUS.codeAt) + 0x100n + BigInt(pick(0x100)); // the code's page
        }
        else if (where === 5)
        {
            turns = 0x1000n; // the whole first page onto the second
            low = data;
            other = data + 0x1000n;
        }
        const swap = pick(2) === 0;
        let [source, target] = swap ? [other, low] : [low, other];
        if (where === 6)
        {
            // Three pages, the middle one closed: past the limit, which tests
            // a run's first and last pages alone.
            turns = 0x1800n;
            source = CLOSED - 0x800n + BigInt(pick(0x100));
            target = data;
        }
        // A run going down starts at its highest byte.
        const span = (turns ?? 1n) - 1n;
        const [from, to] = form.step > 0 ? [source, target] : [source + span, target + span];
        const first = [0n, 5n, 0x1000n, 1n << 40n, -3n][pick(5)];
        return { ...one, text: `form ${FORMS.indexOf(form)} ${from.toString(16)} to `
            + `${to.toString(16)} turns ${turns} index ${first} (${k})`,
        code: program(form, from, to, turns, first) };
    });
}

test('an indexed byte copy loop run whole leaves what the interpreter leaves', ()=>{
    const all = cases(700);
    for (const budget of [7, 300, 100000])
    {
        const { failures, exits, stats } = compare(all, { budget, closed: [Number(CLOSED)] });
        assert.deepEqual(failures.slice(0, 10), [], `budget ${budget}: ${failures.length} differ`);
        assert.ok(exits > all.length / 3, `${exits} ran to their exit`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
});

test('a budget that runs out part way through a copy stops the run where the loop would', ()=>{
    // Each run of the region ends at the first back edge past its budget,
    // a few instructions over it -- never a copy's worth.
    const m = machine();
    const data = BigInt(CORPUS.dataAt);
    let runs = 0;
    for (const [k, form] of FORMS.entries())
    {
        const span = 999n * BigInt(form.step);
        const one = { ...CORPUS.cases[0], text: `form ${k}`,
            code: program(form, data + 0x100n + (form.step > 0 ? 0n : 999n),
                data + 0x1000n + (form.step > 0 ? 0n : 999n), 1000n, span) };
        for (const budget of [50, 300, 2000])
        {
            m.runner.invalidate(CORPUS.codeAt, CORPUS.codeSize);
            load(m, one);
            let before = 0;
            try
            {
                for (let round = 0; round < 10000; round++)
                {
                    m.runner.run(m.state, budget);
                    m.state.syncOut();
                    const ran = m.state.retired - before;
                    assert.ok(ran <= budget + 16, `${one.text}: ${ran} retired for ${budget}`);
                    before = m.state.retired;
                    runs++;
                }
            }
            catch (e){
                // The exit, or a fault: the run is over.
                if (typeof (/** @type {{ vector?: number }} */ (e)).vector !== 'number')
                {
                    throw e;
                }
            }
        }
    }
    assert.ok(runs > 30, `${runs} runs`);
});

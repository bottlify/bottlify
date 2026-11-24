/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Far chunks (`FAR`): long mode's accesses past its window - 4 GiB, or a wide
 * one's 8 GiB of memory64 - sent by the
 * process's table to their frames in it (`farTranslate`), against the
 * long-mode interpreter, which takes them there too (`interp64.js`): the
 * corpus's cases and seeded programs with their data area past 4 GiB, its two
 * pages in two chunks whose frames lie side by side, or apart, or the second
 * with no frame - every access there a fault at its far address.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CORPUS, compare, flagsLeftUndefined, load, machine, nested, pool, program, run, stacked,
} from '../testing/long-machine.js';


/** The data area 16 GiB past its place, its second page in the chunk after its first's. */
const BY = 2 ** 34 + 0xf000;
const PLACINGS = [
    { name: 'frames side by side', far: { by: BY } },
    { name: 'frames apart', far: { by: BY, apart: 0x40000 } },
    // Past an 8 GiB wide window (memory64): the same chunks from its end, their
    // frames below 4 GiB in its RAM.
    { name: 'past a wide window, frames side by side', far: { by: BY }, window: 2 ** 33 },
    { name: 'past a wide window, frames apart', far: { by: BY, apart: 0x40000 },
        window: 2 ** 33 },
];

/**
 * Accesses of every width across the line between the data area's two chunks,
 * reads and writes, off rbx at the area's start.
 */
function across(){
    /** @param {number} value */
    const le = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
    const forms = [[0x48, 0x8b, 0x83], [0x48, 0x89, 0x83], [0x8b, 0x83], [0x89, 0x83],
        [0x66, 0x8b, 0x83], [0x66, 0x89, 0x83], [0xf3, 0x0f, 0x6f, 0x83], [0xf3, 0x0f, 0x7f, 0x83],
        [0x48, 0x83, 0x83]];
    const one = CORPUS.cases[0];
    return forms.flatMap((form, f)=>Array.from({ length: 16 }, (_, d)=>{
        const disp = 0xff1 + d;
        // Run eight times by a loop on r15, as `program`'s are: a region that found
        // its window past 4 GiB is formed again, and the later turns run in it.
        const body = [...form, ...le(disp), ...form[1] === 0x83 ? [1] : []];
        const code = Buffer.from([...body, 0x41, 0xff, 0xcf, 0x0f, 0x85,
            ...le(-(body.length + 9))]);
        const regs = [...one.regs];
        regs[3] = CORPUS.dataAt.toString(16);
        regs[15] = '8';
        return { ...one, text: `across ${f} +${disp.toString(16)}`, code: code.toString('hex'),
            regs };
    }));
}

/** The cases and seeded programs every placing runs. */
function cases(){
    const instructions = pool();
    return [
        ...CORPUS.cases,
        ...across(),
        ...Array.from({ length: 300 }, (_, i)=>program(instructions, 0xfa40 + i, 8 + i % 40)),
        ...Array.from({ length: 150 }, (_, i)=>nested(instructions, 0xfa400 + i)),
        ...Array.from({ length: 150 }, (_, i)=>stacked(instructions, 0xfa4000 + i, 10 + i % 30)),
    ];
}

/**
 * The cases a run outside precise is compared on, as long mode's own gate has
 * them (`runtime64-wide.itest.js`): those the interpreter runs to their end,
 * with the flags each leaves undefined, which the emitter leaves as it will.
 *
 * @param {any[]} all @param {import('../testing/long-machine.js').FarPlacing} far
 * @param {number} [window]  a wide window's bytes
 */
function clean(all, far, window){
    const interpreter = machine({ far, window });
    // The code where it lies: a wide window's RAM is a memory of its own.
    const bytes = new Uint8Array((interpreter.ram ?? interpreter.memory).buffer);
    return all.flatMap(one=>{
        load(interpreter, one);
        const undefinedFlags = flagsLeftUndefined(interpreter.state, address=>bytes[address]);
        load(interpreter, one);
        return undefinedFlags !== null && run(interpreter, false).fault === 'exit'
            ? [{ ...one, undefinedFlags }] : [];
    });
}

for (const { name, far, window } of PLACINGS)
{
    test(`data past 4 GiB in far chunks, ${name}, precise: translated as interpreted`, ()=>{
        const { failures, exits, stats } = compare(cases(), { budget: 7, far, window,
            config: { precise: true } });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
        assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
    });
    test(`data past 4 GiB in far chunks, ${name}, as a program runs - reads untested in the`
        + ' window: translated as interpreted', ()=>{
        const kept = clean(cases(), far, window);
        assert.ok(kept.length > CORPUS.cases.length * 0.8, `${kept.length} cases`);
        const { failures, exits, stats } = compare(kept, { budget: 7, far, window,
            config: { precise: false } });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.equal(exits, kept.length);
        assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
    });
}

test('a far chunk with no frame faults at its far address, translated as interpreted', ()=>{
    const { failures } = compare(cases(), { budget: 7, far: { by: BY, unmapped: true } });
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
});

test('a stack moved past 4 GiB by translated code is tested from there on', ()=>{
    // The stack in the window first - the page the second chunk's frame lies on when
    // the frames are apart - then moved into the far data by mov, lea or xchg, pushed,
    // read and popped there, as a program runs.
    const far = { by: BY, apart: 0x40000 };
    const moves = [[0x48, 0x89, 0xdc], [0x48, 0x8d, 0xa3, 0x00, 0x01, 0x00, 0x00],
        [0x48, 0x87, 0xdc]];
    const work = [0x50, 0x51, 0x48, 0x8b, 0x54, 0x24, 0x08, 0x48, 0x89, 0x44, 0x24, 0x08, 0x59,
        0x58];
    const one = CORPUS.cases[0];
    const all = moves.flatMap((move, m)=>[0x800, 0xf00, 0x1800].map(at=>{
        const body = [...move, ...work];
        const back = -(body.length + 9);
        const code = Buffer.from([...body, 0x41, 0xff, 0xcf, 0x0f, 0x85, back & 255,
            back >> 8 & 255, back >> 16 & 255, back >> 24 & 255]);
        const regs = [...one.regs];
        regs[3] = (CORPUS.dataAt + at).toString(16);
        regs[4] = (CORPUS.dataAt + 0x1f00 + 0x40000).toString(16);
        regs[15] = '8';
        return { ...one, text: `stack moved ${m} to +${at.toString(16)}`,
            code: code.toString('hex'), regs };
    }));
    const { failures, exits } = compare(all, { budget: 1000, far, config: { precise: false } });
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.equal(exits, all.length);
});

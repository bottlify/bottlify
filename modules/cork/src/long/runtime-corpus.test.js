/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The long-mode translator against the interpreter over the whole hardware
 * corpus, with and without the interpreter tier in wasm beside it, and the
 * string instructions' page walks: the long runs of its gate, a file of their
 * own (`testing/long-machine.js` for the harness).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CORPUS, compare } from '../testing/long-machine.js';

test('translated long-mode blocks do what the interpreter does on every corpus case', ()=>{
    const { failures, exits, stats } = compare(CORPUS.cases);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    // The gate means something only if most of the corpus ran translated.
    assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
    assert.ok(stats.translated > stats.interpreted / 2,
        JSON.stringify(stats));
});

test('with the wasm tier beside the regions, every corpus case ends as interpreted', ()=>{
    // Short runs: the regions stop often, and what they leave is the tier's.
    const { failures, exits, stats } = compare(CORPUS.cases, 7, true, undefined, undefined,
        true, 0, true);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
    assert.ok(stats.interpreted > 0, JSON.stringify(stats));
});

test('stos and movs run translated as interpreted: by pages, across them, into a closed one', ()=>{
    const base = CORPUS.cases[0];
    const cases = [];
    // stos and movs of every width: byte, word, dword, qword.
    const ops = [['aa', 'stos'], ['66ab', 'stos'], ['ab', 'stos'], ['48ab', 'stos'],
        ['a4', 'movs'], ['66a5', 'movs'], ['a5', 'movs'], ['48a5', 'movs']];
    for (const [opcode, op] of ops)
    {
        for (const prefix of ['f3', 'f2', ''])
        {
            for (const count of [0n, 1n, 3n, 100n, 1500n, 5000n])
            {
                // Inside the first page, at its end, across into the second,
                // and toward the closed page past the data, an element across
                // into it.
                for (const at of [0x10, 0xffe, 0x1ff8 - 0x40, CORPUS.dataSize - 0x100,
                    CORPUS.dataSize - 0x103])
                {
                    for (const down of [false, true])
                    {
                        const shapes = op === 'stos'
                            ? [[0n, 0n], [0x4141414141414141n, 0n], [0x1234n, 0n]]
                            // The source behind the destination by an element or two, or
                            // by bytes that are no whole elements, or by a hundred (the
                            // processor copies forward through what it wrote), apart, and
                            // ahead.
                            : [[0n, -1n], [0n, -8n], [0n, -3n], [0n, -6n], [0n, -100n],
                                [0n, 0x400n], [0n, 3n]];
                        for (const [rax, lead] of shapes)
                        {
                            const regs = [...base.regs];
                            const rdi = BigInt(CORPUS.dataAt + at);
                            regs[0] = rax.toString(16);
                            regs[1] = count.toString(16);
                            regs[7] = rdi.toString(16);
                            regs[6] = (op === 'movs' ? rdi + lead : rdi).toString(16);
                            const code = `${down ? 'fd' : ''}${prefix}${opcode}fc`;
                            const text = `${code} rcx=${count} rdi=+${at.toString(16)}`
                                + ` rax=${rax.toString(16)} lead=${lead}`;
                            cases.push({ ...base, text, code, regs });
                        }
                    }
                }
            }
        }
    }
    const { failures, exits, stats } = compare(cases);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    // Some ran to the closed page, most did not; most ran translated.
    assert.ok(exits > cases.length / 2 && exits < cases.length,
        `${exits} of ${cases.length} ran to their exit`);
    assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
});

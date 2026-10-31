/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hardware corpus on translated code: every case placed in a test
 * machine's state block, its code translated region by region and run, and
 * judged against what the processor left (`x86-corpus.js` says how). A case
 * that reaches an instruction the emitter leaves to the interpreter is counted
 * by that instruction's opcode and not judged here -- the interpreter's suite
 * judges it -- and the list is printed with the count.
 *
 * Run in parts, `emit/corpus-N.itest.js`, each every `of`-th case from its own
 * offset, so a part stays short.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from './machine.js';
import { CORPUS_LAYOUT, judgeAll, loadX86Corpus, outcomeOf, placeCase } from './x86-corpus.js';

const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');

/**
 * One part of the corpus: the cases whose index is `part` modulo `of`.
 *
 * @param {number} part @param {number} of
 * @param {{ executor?: number, shared?: boolean }} [where]  the executor of a shared memory
 *     the machine is: its state and tables past the first's, as for every executor of a
 *     process but the first; shared: the code translated for the process's shared layout,
 *     run with this executor's bases
 */
export function testTranslatedCorpus(part, of, { executor = 0, shared = false } = {}){
    test(`translated code leaves what the processor left, on every case it translates in full`
        + ` (part ${part + 1} of ${of}${executor > 0 ? `, executor ${executor}` : ''}`
        + `${shared ? ', the shared layout' : ''})`,
    ()=>{
        const cases = loadX86Corpus()
            .filter((one, index)=>index % of === part && ONLY.test(one.name));
        const started = Date.now();
        const result = judgeAll(cases, 'translated', one=>{
            // Judged against the hardware, so exact where the fast default is not.
            const m = createTestMachine({ ramSize: 2 << 20, precise: true, executor, shared,
                processors: shared ? Math.max(2, executor + 1) : 1 });
            const view = new DataView(m.memory.buffer);
            placeCase(view, m.layout, one);
            const exit = m.runProgram(CORPUS_LAYOUT.CODE_AT, { budget: 100_000 });
            if (exit.kind === -2 || exit.kind === -1)
            {
                if (exit.unsupported.size > 0)
                {
                    return { leftOut: exit.unsupported };
                }
                // Nothing left out: the decoder refused the instruction itself.
                return { unsupported: 'a refused encoding', eip: exit.eip,
                    outcome: outcomeOf(view, m.layout, { fault: null, halted: false }) };
            }
            return { outcome: outcomeOf(view, m.layout, {
                fault: exit.kind === 4 ? { vector: exit.vector, eip: exit.eip } : null,
                halted: exit.kind === 3,
            }) };
        });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`translated: ${result.summary}, ${seconds} s`);
        assert.deepEqual(result.stale, [], 'listed as known failures, and passing');
        assert.equal(result.failures.length, 0,
            `${result.failures.length} diverged:\n${result.failures.slice(0, 40).join('\n')}`);
        assert.ok(result.judged > 0);
    });
}

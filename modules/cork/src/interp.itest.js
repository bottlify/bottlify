/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hardware corpus on the interpreter alone: every case placed in a state
 * block, run by the JavaScript interpreter over it, and judged against what the
 * processor left (`testing/x86-corpus.js` says how). An instruction the
 * interpreter has no model for fails the case as any divergence does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fault, Unsupported, blockState, interpret } from './interp.js';
import { ownLayout, pagesFor, tablesSize } from './runtime/layout.js';
import { createPageTable } from './runtime/pages.js';
import { judgeAll, loadX86Corpus, outcomeOf, placeCase } from './testing/x86-corpus.js';

const RAM = 2 << 20;
const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');

test('the interpreter leaves what the processor left, on every corpus case', ()=>{
    const cases = loadX86Corpus().filter(one=>ONLY.test(one.name));
    const layout = ownLayout({ ramSize: RAM, hashSlots: 1 << 16 });
    const pages = pagesFor(layout, tablesSize(layout));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    createPageTable(memory, layout);
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    const started = Date.now();
    const result = judgeAll(cases, 'interpreter', one=>{
        bytes.fill(0, 0, layout.ramBase + RAM);
        placeCase(view, layout, one);
        const state = blockState({ memory, layout });
        /** @type {{ vector: number, eip: number } | null} */
        let fault = null;
        /** @type {Unsupported | null} */
        let refused = null;
        let left = 100_000;
        try
        {
            while (left > 0 && !state.halted)
            {
                left -= Math.max(interpret(state, Math.min(left, 10_000)), 1);
            }
        }
        catch (e){
            if (e instanceof Unsupported)
            {
                refused = e;
            }
            else if (e instanceof Fault)
            {
                fault = { vector: e.vector, eip: e.eip >>> 0 };
            }
            else
            {
                throw e;
            }
        }
        state.syncOut();
        const outcome = outcomeOf(view, layout, { fault, halted: state.halted });
        return refused ? { unsupported: refused.op, eip: refused.eip ?? -1, outcome } : { outcome };
    });
    console.log(`interpreter: ${result.summary}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    assert.deepEqual(result.stale, [], 'listed as known failures, and passing');
    assert.equal(result.failures.length, 0,
        `${result.failures.length} diverged:\n${result.failures.slice(0, 40).join('\n')}`);
    assert.ok(result.judged > 0);
});

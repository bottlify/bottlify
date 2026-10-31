/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hardware corpus on the interpreter tier in wasm: each case runs on the
 * tier over cork's own layout, the JavaScript interpreter taking every
 * instruction the tier leaves, as the cork host runs them, the tier `precise`
 * as the corpus is judged (`testing/x86-corpus.js` says how).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fault, Unsupported, blockState, interpret } from './interp.js';
import { WASM_INTERPRETER_AREA, WASM_INTERPRETER_STATICS_AT, WasmExit, createWasmInterpreter }
    from './interp-wasm.js';
import { ownLayout, pagesFor, tablesSize } from './runtime/layout.js';
import { createPageTable } from './runtime/pages.js';
import { judgeAll, loadX86Corpus, outcomeOf, placeCase } from './testing/x86-corpus.js';

const RAM = 2 << 20;
const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');

test('the wasm tier leaves what the processor left, on every corpus case', ()=>{
    const cases = loadX86Corpus().filter(one=>ONLY.test(one.name));
    const layout = ownLayout({ ramSize: RAM, hashSlots: 1 << 16 });
    const area = layout.tables + tablesSize(layout);
    const pages = pagesFor(layout, tablesSize(layout) + WASM_INTERPRETER_AREA);
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    createPageTable(memory, layout);
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const tier = createWasmInterpreter({ memory, layout,
        statics: WASM_INTERPRETER_STATICS_AT, area, hotThreshold: 2,
        trapPort: 0xb077, parkBase: 0x100000, precise: true });
    assert.ok(tier);
    let byTier = 0;
    let byJs = 0;
    const started = Date.now();
    const result = judgeAll(cases, 'wasm', one=>{
        // The state block and RAM as a fresh machine has them; the tier's own
        // page below RAM and the tables' flags stay.
        bytes.fill(0, 0, 512);
        bytes.fill(0, layout.ramBase, layout.ramBase + RAM);
        bytes.fill(0, area, area + WASM_INTERPRETER_AREA);
        placeCase(view, layout, one);
        const state = blockState({ memory, layout });
        /** @type {{ vector: number, eip: number } | null} */
        let fault = null;
        let halted = false;
        let left = 100_000;
        try
        {
            while (left > 0 && !halted)
            {
                const code = tier.run(Math.min(left, 10_000));
                left -= tier.retired();
                byTier += tier.retired();
                if (code === WasmExit.HALT)
                {
                    halted = true;
                }
                else if (code === WasmExit.FAULT)
                {
                    fault = { vector: tier.exitValue(), eip: view.getUint32(layout.eip, true) };
                    break;
                }
                else if (code === WasmExit.UNSUPPORTED)
                {
                    state.syncIn();
                    state.eip = view.getUint32(layout.eip, true);
                    state.halted = false;
                    const ran = interpret(state, 1);
                    left -= Math.max(ran, 1);
                    byJs += ran;
                    state.trapped.length = 0;
                    state.syncOut();
                    halted = state.halted;
                }
            }
        }
        catch (e){
            if (e instanceof Unsupported)
            {
                state.syncOut();
                return { unsupported: e.op, eip: e.eip ?? -1,
                    outcome: outcomeOf(view, layout, { fault: null, halted: false }) };
            }
            if (!(e instanceof Fault))
            {
                throw e;
            }
            state.syncOut();
            fault = { vector: e.vector, eip: e.eip >>> 0 };
        }
        return { outcome: outcomeOf(view, layout, { fault, halted }) };
    });
    console.log(`wasm tier: ${result.summary}; ${byTier} instructions on the tier, ${byJs} left`
        + ` to the JavaScript tier, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    assert.deepEqual(result.stale, [], 'listed as known failures, and passing');
    assert.equal(result.failures.length, 0,
        `${result.failures.length} diverged:\n${result.failures.slice(0, 40).join('\n')}`);
    assert.ok(result.judged > 0);
    assert.ok(byTier > byJs, 'the tier ran most of the corpus');
});

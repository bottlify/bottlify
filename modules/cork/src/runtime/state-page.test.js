/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What lies in an executor's state page, each at its own offset: the state
 * block, the NaN record, the interrupt word, the call stack with its deepest
 * return address, the wrap word, and the wasm interpreter's statics past the
 * page. A growing memory's wrap word inside the call stack had the 124th
 * nested translated call overwrite the mask every untested read is wrapped
 * by, and the reads that followed read anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_BLOCK_SIZE, WRAP_WORD, ownLayout } from './layout.js';
import { CallStack } from '../emit/region.js';
import { NanRecord } from '../emit/x87.js';
import { WASM_INTERPRETER_STATICS_AT } from '../interp-wasm.js';

test('the state page\'s occupants lie apart, the wrap word past the deepest call', ()=>{
    const layout = ownLayout({ ramSize: 1 << 30, ramBase: 0, tablesAt: 1 << 26,
        ramFloor: 1 << 27, processors: 2 });
    const state = layout.regs;
    assert.equal(/** @type {number} */ (layout.wrap) - state, WRAP_WORD);
    /** @type {[string, number, number][]} */
    const occupants = [
        ['state block', 0, STATE_BLOCK_SIZE],
        ['NaN record', /** @type {number} */ (layout.nanFirst) - state, NanRecord.SIZE],
        ['interrupt word', /** @type {number} */ (layout.interrupt) - state, 4],
        ['call stack', CallStack.DEPTH, CallStack.STACK + CallStack.LIMIT * 4 - CallStack.DEPTH],
        ['wrap word', WRAP_WORD, 4],
    ];
    occupants.sort((a, b)=>a[1] - b[1]);
    for (let i = 1; i < occupants.length; i++)
    {
        const [before, at, size] = occupants[i - 1];
        assert.ok(at + size <= occupants[i][1],
            `${before} (${at}+${size}) runs into ${occupants[i][0]} at ${occupants[i][1]}`);
    }
    const [last, at, size] = occupants[occupants.length - 1];
    assert.ok(at + size <= WASM_INTERPRETER_STATICS_AT,
        `${last} runs into the wasm interpreter's statics`);
});

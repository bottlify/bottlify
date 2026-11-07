/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An executor's state page holds words that different parts of the
 * translator place by their own constants: the state block, a diagnostic
 * build's block mark, the NaN hunt's record, the interrupt word, the return
 * addresses of calls waiting as wasm calls, a growing layout's wrap word, and
 * past the page the wasm interpreter's statics. Two of them in one place is a
 * word each writes over the other's: the wrap word lay inside the return
 * stack, and the 125th call waiting stored its return address as the mask
 * every untested read was wrapped by.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_BLOCK_SIZE, WRAP_WORD, ownLayout } from './layout.js';
import { BLOCK_MARK_AT, CallStack } from '../emit/region.js';
import { NanRecord } from '../emit/x87.js';
import { WASM_INTERPRETER_STATICS_AT } from '../interp-wasm.js';

const MIB = 1 << 20;

test('the words of a growing layout\'s state page lie apart, inside the page', ()=>{
    const layout = ownLayout({ ramSize: 64 * MIB, ramBase: 0, tablesAt: 4 * MIB,
        ramFloor: 8 * MIB, processors: 2 });
    const from = layout.regs;
    assert.equal(/** @type {number} */ (layout.wrap) - from, WRAP_WORD);
    // What, where from the page's start, and its bytes.
    const words = /** @type {[string, number, number][]} */ ([
        ['state block', 0, STATE_BLOCK_SIZE],
        ['block mark', BLOCK_MARK_AT, 4],
        ['NaN record', /** @type {number} */ (layout.nanFirst) - from, NanRecord.SIZE],
        ['interrupt word', /** @type {number} */ (layout.interrupt) - from, 4],
        ['call depth', CallStack.DEPTH, 4],
        ['call budget', CallStack.BUDGET, 4],
        ['return addresses', CallStack.STACK, 4 * CallStack.LIMIT],
        ['wrap word', /** @type {number} */ (layout.wrap) - from, 4],
    ]).sort((a, b)=>a[1] - b[1]);
    for (let i = 0; i < words.length; i++)
    {
        const [what, at, bytes] = words[i];
        assert.ok(at >= 0 && at + bytes <= WASM_INTERPRETER_STATICS_AT,
            `the ${what} (${at}, ${bytes} bytes) lies in the page, short of the interpreter's`);
        if (i > 0)
        {
            const [before, beforeAt, beforeBytes] = words[i - 1];
            assert.ok(beforeAt + beforeBytes <= at,
                `the ${before} (${beforeAt}, ${beforeBytes} bytes) reaches the ${what} (${at})`);
        }
    }
});

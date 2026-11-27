/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    THREAD_CONTROL_WORD, THREAD_MXCSR, freshThreadFpu, setContextEflags, setThreadBase,
} from './context.js';

/** A 32-bit state block's fields, where the engine's own layout puts them. */
const LAYOUT = /** @type {any} */ (Object.freeze({
    bits: 32, regs: 0, eip: 32, previousIp: 36, eflags: 40, flagRecord: 44, x87: 64,
    x87Top: 192, x87Empty: 193, x87Control: 194, x87Status: 196, x87Exact: 198, xmm: 208,
    mxcsr: 336, fsBase: 340, gsBase: -1, counter: 344,
}));

/**
 * A saved context whose block holds a distinct byte everywhere, so a field
 * written where it should not be cannot hide.
 *
 * @param {any} [layout]
 * @returns {import('./context.js').BlockContext}
 */
const context = (layout = LAYOUT)=>({
    block: new Uint8Array(512).fill(0x5a), reg32: [1, 2, 3, 4, 5, 6, 7, 8], eip: 0x401000,
    previousIp: 0, inHlt: 0, fsBase: 0x7ffde000, gsBase: 0, layout,
});

test('a new thread starts with Windows\' floating-point environment, not its creator\'s', ()=>{
    // Wine's thread tests: a thread starts at 0x27f whatever precision the
    // thread that created it set.
    const record = context();
    const view = new DataView(record.block.buffer);
    freshThreadFpu(record);
    assert.equal(THREAD_CONTROL_WORD, 0x27f);
    assert.equal(view.getUint16(LAYOUT.x87Control, true), THREAD_CONTROL_WORD);
    assert.equal(view.getUint16(LAYOUT.x87Status, true), 0);
    assert.equal(record.block[LAYOUT.x87Top], 0);
    assert.equal(record.block[LAYOUT.x87Empty], 0xff, 'every x87 register empty');
    assert.equal(record.block[LAYOUT.x87Exact], 0, 'no quadword held exact');
    assert.ok(record.block.subarray(LAYOUT.xmm, LAYOUT.xmm + 128).every(byte=>byte === 0));
    assert.equal(view.getUint32(LAYOUT.mxcsr, true), THREAD_MXCSR);
    assert.ok(record.block.subarray(LAYOUT.regs, LAYOUT.regs + 32).every(byte=>byte === 0x5a),
        'the rest of the template stays');
    assert.deepEqual(record.reg32, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('the thread base is part of the context, not the caller of the switch', ()=>{
    const record = context();
    setThreadBase(record, 0x7ffdf000);
    assert.equal(record.fsBase, 0x7ffdf000,
        'FS follows the thread; forgetting it is how a thread reads another thread TEB');
    // Long mode reaches the TEB through GS.
    const long = context({ ...LAYOUT, bits: 64 });
    setThreadBase(long, 0x7ffdf000);
    assert.equal(long.gsBase, 0x7ffdf000);
    assert.equal(long.fsBase, 0x7ffde000, 'FS has no base of its own there');
});

test('a context given a flags word whole keeps no arithmetic record beside it', ()=>{
    // The word, and its record of a region's last arithmetic cleared, as the
    // engine's own setter leaves them.
    const record = context();
    const view = new DataView(record.block.buffer);
    setContextEflags(record, 0x403);
    assert.equal(view.getUint32(LAYOUT.eflags, true), 0x403);
    assert.equal(view.getUint32(LAYOUT.flagRecord, true), 0, 'no record: the word says everything');
    assert.equal(view.getUint32(LAYOUT.flagRecord + 4, true), 0x5a5a5a5a,
        'and nothing past it is touched');
});

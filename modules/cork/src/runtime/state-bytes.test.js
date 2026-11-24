/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateBytesOf } from './diagnostics.js';

/** A region's record with what the estimate counts, of known sizes. */
const record = (/** @type {any} */ more = {})=>({
    entry: 0x401000, pages: new Set([0x401]), slots: [3, 4], table: 0, spans: [[0x401000, 0x401010]],
    extents: new Map([[0x401, [0, 1]]]), entryTop: 0, hash: 'h', labels: 'abcd', ...more,
});

test('a runtime\'s state is weighed by kind from its counts; the bytes it keeps are counted'
    + ' whole', ()=>{
    const plain = record();
    const kept = record({
        reads: new Set([0x401, 0x402]),
        sources: [{ start: 0x401000, bytes: new Uint8Array(100) },
            { start: 0x402000, bytes: new Uint8Array(28) }],
        summary: { pages: [0x401], reads: [0x401, 0x402], formable: [], read: [[0, 1]], calls: [],
            empties: [[2, 3]], crt: [] },
    });
    const pageBytes = new Map([[0x401, new Uint8Array(4096)]]);
    const figures = stateBytesOf({ regions: new Set([plain, kept]), entries: 10, remembered: 5,
        pageBytes });
    // A record 580, a set entry 12, a pair 78, a number 14, a byte of labels 1.
    const one = 580 + 1 * 12 + 2 * 78 + 2 * 14 + 4;
    assert.deepEqual(figures, {
        regions: one + (one + 2 * 12),
        sources: 2 * 260 + 128,
        summaries: 600 + 3 * 14 + 2 * 78,
        entries: 10 * 30,
        queue: 5 * 40,
        codePages: 260 + 4096,
        total: one * 2 + 24 + 648 + 798 + 300 + 200 + 4356,
    });
    assert.deepEqual(stateBytesOf({ regions: [], entries: 0, remembered: 0, pageBytes: new Map() }),
        { regions: 0, sources: 0, summaries: 0, entries: 0, queue: 0, codePages: 0, total: 0 },
        'nothing kept: nothing held, a measure, not a missing one');
});

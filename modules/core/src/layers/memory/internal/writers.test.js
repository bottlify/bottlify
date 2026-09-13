/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITER_COLUMNS, WRITER_ROWS, createWriterAccount } from './writers.js';
import { createTable, readTable } from '../../log/internal/table.js';

/** The account over a real table, with a dictionary that numbers words in order. */
function account(rows = WRITER_ROWS){
    /** @type {string[]} */
    const words = [];
    const table = createTable({ rows, columns: WRITER_COLUMNS, shared: false });
    const made = createWriterAccount({
        table,
        intern: text=>{
            const at = words.indexOf(text);
            return at >= 0 ? at : words.push(text) - 1;
        },
    });
    const reader = readTable(table.describe());
    return {
        ...made,
        words,
        /** @returns {Record<string, { bytes: number, writes: number }>} */
        rows(){
            /** @type {Record<string, { bytes: number, writes: number }>} */
            const out = {};
            for (const row of reader.all())
            {
                out[words[row.name]] = { bytes: row.bytes, writes: row.writes };
            }
            return out;
        },
    };
}

test('a write is charged to the call in flight, and nesting puts the caller back', ()=>{
    const it = account();
    const outer = it.writer('CreateTexture');
    const inner = it.writer('LockRect');

    it.charge(10);

    const wasOuter = it.charging(outer);
    it.charge(100);
    const wasInner = it.charging(inner);
    it.charge(1000);
    it.charging(wasInner);
    // Back in the outer call, not in whoever ran last.
    it.charge(2);
    it.charging(wasOuter);
    it.charge(20);

    assert.deepEqual(it.rows(), {
        '<no host call>': { bytes: 30, writes: 2 },
        '<beyond the table>': { bytes: 0, writes: 0 },
        CreateTexture: { bytes: 102, writes: 2 },
        LockRect: { bytes: 1000, writes: 1 },
    });
});

test('a row goes to a name that writes, not to a name that was registered', ()=>{
    // Two rows are reserved and two are left, so the registration order below
    // would spend both on names that never write a byte.
    const it = account(4);
    const quiet = it.writer('GetTickCount');
    const alsoQuiet = it.writer('Sleep');
    const loud = it.writer('ReadFile');

    it.charging(loud);
    it.charge(9);

    assert.deepEqual(it.rows(), {
        '<no host call>': { bytes: 0, writes: 0 },
        '<beyond the table>': { bytes: 0, writes: 0 },
        ReadFile: { bytes: 9, writes: 1 },
    }, 'the writer is named and the two that only registered are not in the table at all');
    assert.notEqual(quiet, alsoQuiet, 'each name is still numbered for itself');
});

test('a name keeps its row, and writers past the table share one', ()=>{
    const it = account(4);
    assert.equal(it.writer('a'), it.writer('a'), 'a name is numbered once');

    for (const who of ['a', 'b', 'c', 'd'])
    {
        it.charging(it.writer(who));
        it.charge(1);
    }
    assert.deepEqual(it.rows(), {
        '<no host call>': { bytes: 0, writes: 0 },
        '<beyond the table>': { bytes: 2, writes: 2 },
        a: { bytes: 1, writes: 1 },
        b: { bytes: 1, writes: 1 },
    }, 'what the table has no room for is counted rather than lost');
});

test('the frame reports its busiest writer and then starts again', ()=>{
    const it = account();
    const small = it.writer('WriteFile');
    const large = it.writer('LockRect');

    it.charging(small);
    it.charge(100);
    it.charging(large);
    it.charge(60);
    it.charge(60);
    assert.deepEqual(it.publish(), { writer: it.words.indexOf('LockRect'), bytes: 120 });

    // The frame's tally starts from nothing; the run's does not.
    it.charging(small);
    it.charge(5);
    assert.deepEqual(it.publish(), { writer: it.words.indexOf('WriteFile'), bytes: 5 });
    assert.deepEqual(it.publish(), { writer: -1, bytes: 0 },
        'a frame with no write of its own names no writer');
    assert.equal(it.rows().LockRect.bytes, 120, 'the run keeps what the frames gave up');
});

test('charging an unknown slot leaves the charge where it was', ()=>{
    const it = account();
    const known = it.writer('SetLight');
    it.charging(known);
    assert.equal(it.charging(-1), known, 'the answer is still who was being charged');
    it.charge(8);
    assert.equal(it.rows().SetLight.bytes, 8);
});

test('the write path allocates nothing', ()=>{
    const it = account();
    it.charging(it.writer('DrawIndexedPrimitive'));
    // A million charges through a fixed table: what this proves is that the
    // path is arrays and numbers, so a leak would show as growth here.
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1_000_000; i++)
    {
        it.charge(64);
        if ((i & 0xffff) === 0)
        {
            it.publish();
        }
    }
    const grew = process.memoryUsage().heapUsed - before;
    assert.ok(grew < 1 << 20, `the write path grew the heap by ${grew} bytes`);
    assert.equal(it.rows().DrawIndexedPrimitive.writes, 1_000_000);
});

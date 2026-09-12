/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The block of memory the journal lives in, read from the thread that wrote
 * it and from one that did not. What a reader is promised: every record it
 * is handed is whole, every record it is not handed is counted, and the
 * writer never waited for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
    createJournalCursor, createJournalMemory, createJournalWriter, INLINE_TEMPLATE,
} from './shared-journal.js';

const open = (/** @type {any} */ options = {})=>{
    const memory = createJournalMemory(options);
    return { memory, writer: createJournalWriter(memory), cursor: createJournalCursor(memory) };
};

test('a record round-trips with its numbers as numbers and its words by id', ()=>{
    const { writer, cursor } = open();
    const topic = writer.intern('loader');
    writer.write(17.5, 3, topic, 'mapped {0} at {1:x}', 2, 'game.exe', 0x400000,
        undefined, undefined);

    const record = cursor.read(0);
    assert.ok(record);
    assert.equal(record.time, 17.5);
    assert.equal(record.level, 3);
    assert.equal(cursor.word(record.topic), 'loader');
    assert.equal(cursor.word(record.template), 'mapped {0} at {1:x}');
    assert.deepEqual(record.args, ['game.exe', 0x400000]);
});

test('what is neither number nor string travels as the string it prints as', ()=>{
    const { writer, cursor } = open();
    writer.write(0, 3, 0, '{0} {1} {2}', 3, true, null, { toString: ()=>'object' }, undefined);
    assert.deepEqual(cursor.read(0)?.args, ['true', 'null', 'object']);
});

test('the memory is laid out from what it was made with', ()=>{
    const { memory } = open({ records: 8, bytes: 8192, dictionary: 1024 });
    assert.equal(memory.records, 8);
    assert.equal(memory.ringBytes, 8192);
    assert.equal(memory.dictBytes, 1024);
    assert.ok(memory.buffer instanceof SharedArrayBuffer, 'shared where the platform has it');
    assert.ok(open({ shared: false }).memory.buffer instanceof ArrayBuffer);
});

test('a template the dictionary cannot hold travels inline and still reads', ()=>{
    const { writer, cursor } = open({ dictionary: 256 });
    const long = 'x'.repeat(200);
    writer.write(0, 3, 0, long, 1, 7, undefined, undefined, undefined);
    const record = cursor.read(0);
    assert.ok(record);
    assert.equal(record.template, INLINE_TEMPLATE);
    assert.equal(record.inline, long);
    assert.deepEqual(record.args, [7]);
    assert.equal(writer.refused(), 1);
});

test('a reader is told exactly which records it was lapped past', ()=>{
    const { writer, cursor } = open({ records: 4, bytes: 4096 });
    for (let at = 0; at < 10; at++)
    {
        writer.write(at, 3, 0, 'line {0}', 1, at, undefined, undefined, undefined);
    }
    assert.equal(cursor.written(), 10);
    assert.equal(cursor.oldest(), 6, 'the index remembers the last four');
    assert.equal(cursor.read(5), null, 'a lapped sequence is refused, not misread');
    assert.deepEqual([6, 7, 8, 9].map(at=>cursor.read(at)?.args[0]), [6, 7, 8, 9]);
});

test('bytes written over while the index still points at them are refused too', ()=>{
    // A ring of bytes shorter than the index is long: the index says the
    // record is there, the bytes say otherwise, and the bytes win.
    const { writer, cursor } = open({ records: 64, bytes: 4096 });
    for (let at = 0; at < 64; at++)
    {
        writer.write(at, 3, 0, 'line {0}', 1, 'x'.repeat(100), undefined, undefined, undefined);
    }
    assert.equal(cursor.read(0), null);
    assert.ok(cursor.read(63));
});

test('the writer never waits for a reader and never grows', ()=>{
    const { memory, writer, cursor } = open({ records: 16, bytes: 4096 });
    const before = memory.buffer.byteLength;
    const started = performance.now();
    for (let at = 0; at < 200_000; at++)
    {
        writer.write(at, 3, 0, 'line {0} {1}', 2, at, 'text', undefined, undefined);
    }
    const each = (performance.now() - started) / 200_000;
    assert.equal(memory.buffer.byteLength, before);
    assert.equal(cursor.written(), 200_000);
    assert.ok(each < 0.01, `a record costs ${(each * 1000).toFixed(2)} us; under ten expected`);
});

test('a reader on another thread sees every record, whole, in order', async()=>{
    const { memory, writer } = open({ records: 1024, bytes: 65536 });
    const topic = writer.intern('cpu');
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(({ createJournalCursor, openJournalMemory })=>{
            const cursor = createJournalCursor(openJournalMemory(workerData.buffer));
            const seen = [];
            let next = 0;
            const drain = ()=>{
                const written = cursor.written();
                for (; next < written; next++)
                {
                    const record = cursor.read(next);
                    seen.push(record
                        ? [record.sequence, record.args[0], cursor.word(record.topic)] : null);
                }
                if (seen.length < workerData.expect)
                {
                    setTimeout(drain, 1);
                }
                else
                {
                    parentPort.postMessage(seen);
                }
            };
            drain();
        });
    `, {
        eval: true,
        workerData: {
            url: new URL('./shared-journal.js', import.meta.url).href,
            buffer: memory.buffer,
            expect: 500,
        },
    });
    const seen = new Promise(resolve=>worker.once('message', resolve));
    for (let at = 0; at < 500; at++)
    {
        writer.write(at, 3, topic, 'tick {0}', 1, at, undefined, undefined, undefined);
        if (at % 50 === 0)
        {
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
    }
    const records = /** @type {any[]} */ (await seen);
    await worker.terminate();
    assert.equal(records.length, 500);
    for (let at = 0; at < 500; at++)
    {
        assert.deepEqual(records[at], [at, at, 'cpu']);
    }
});

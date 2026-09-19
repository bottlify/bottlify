/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET_CAP, createSampleTable, creditSample, topSamples } from './samples.js';

test('a slice at a known EIP credits that EIP\'s bucket', ()=>{
    const table = createSampleTable();
    creditSample(table, 0x10a220, 1000);
    creditSample(table, 0x10a220, 500);

    assert.equal(table.slices, 2);
    const [bucket] = topSamples(table, 1);
    assert.equal(bucket.address, 0x10a220 & ~0x3f, 'rounded down to the 64-byte bucket');
    assert.equal(bucket.instructions, 1500);
    assert.equal(bucket.samples, 2);
});

test('two addresses in the same 64-byte span fold into one bucket', ()=>{
    const table = createSampleTable();
    creditSample(table, 0x10a220, 100);
    creditSample(table, 0x10a221, 200); // one byte further, same bucket

    assert.equal(table.buckets.size, 1);
    const [bucket] = topSamples(table, 1);
    assert.equal(bucket.instructions, 300);
});

test('addresses in different 64-byte spans stay in separate buckets', ()=>{
    const table = createSampleTable();
    creditSample(table, 0x10a220, 100);
    creditSample(table, 0x10a260, 200); // 64 bytes further, a new bucket

    assert.equal(table.buckets.size, 2);
});

test('topSamples ranks the heaviest buckets first, by their own address', ()=>{
    const table = createSampleTable();
    creditSample(table, 0x1000, 50);
    creditSample(table, 0x2000, 500);
    creditSample(table, 0x3000, 200);

    const top = topSamples(table, 2);
    assert.equal(top.length, 2);
    assert.equal(top[0].address, 0x2000);
    assert.equal(top[1].address, 0x3000);
});

test('ten thousand slices at their own address leave the table\'s own size bounded', ()=>{
    const table = createSampleTable();
    for (let i = 0; i < 10_000; i++)
    {
        creditSample(table, i * 64, 1);
    }

    assert.equal(table.slices, 10_000);
    assert.equal(table.buckets.size, 10_000,
        'under the cap, every distinct address gets its own bucket');
    assert.ok(table.buckets.size <= BUCKET_CAP,
        `the table grew to ${table.buckets.size} buckets, past its own cap of ${BUCKET_CAP}`);
    assert.equal(table.overflow, 0, 'ten thousand distinct addresses do not reach the cap');
});

test('past the cap, a new address is counted as overflow rather than grown into', ()=>{
    const table = createSampleTable();
    // Twice the cap's worth of distinct addresses.
    for (let i = 0; i < BUCKET_CAP * 2; i++)
    {
        creditSample(table, i * 64, 1);
    }

    assert.equal(table.slices, BUCKET_CAP * 2);
    assert.equal(table.buckets.size, BUCKET_CAP, 'the table stops growing exactly at its cap');
    assert.equal(table.overflow, BUCKET_CAP,
        'everything past the cap is counted, not silently dropped');
});

test('a table with nothing credited answers no buckets', ()=>{
    const table = createSampleTable();
    assert.deepEqual(topSamples(table), []);
    assert.equal(table.slices, 0);
    assert.equal(table.overflow, 0);
});

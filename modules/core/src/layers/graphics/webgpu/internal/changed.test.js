/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedSpans, createCompared } from './changed.js';

/**
 * The same answer byte by byte: every changed byte is in a span, and a span
 * reaches no further than the four-byte words its first and last changes
 * lie in.
 *
 * @param {Uint8Array} now @param {Uint8Array} was @param {number[]} spans @param {number} gap
 */
const holds = (now, was, spans, gap)=>{
    const covered = new Uint8Array(now.length);
    for (let index = 0; index < spans.length; index += 2)
    {
        const [start, end] = [spans[index], spans[index + 1]];
        assert.ok(start < end && end <= now.length);
        const firstChange = [0, 1, 2, 3].map(step=>start + step)
            .find(at=>at < end && now[at] !== was[at]);
        assert.ok(firstChange !== undefined, 'a span starts within a word of a change');
        const lastChange = [1, 2, 3, 4].map(step=>end - step)
            .find(at=>at >= start && now[at] !== was[at]);
        assert.ok(lastChange !== undefined, 'and ends within one');
        if (index > 0)
        {
            assert.ok(start - spans[index - 1] >= 1, 'spans are apart and in order');
        }
        covered.fill(1, start, end);
    }
    for (let at = 0; at < now.length; at++)
    {
        if (now[at] !== was[at])
        {
            assert.equal(covered[at], 1, `byte ${at} changed and is in no span`);
        }
    }
    void gap;
};

test('the spans cover every changed byte and only runs that start and end on one', ()=>{
    let seed = 7;
    const random = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed / 0x100000000;
    };
    for (let round = 0; round < 400; round++)
    {
        // Lengths and offsets that are and are not on four-byte boundaries.
        const length = Math.floor(random() * 700);
        const offset = Math.floor(random() * 5);
        const memory = new Uint8Array(length + 16);
        const sent = new Uint8Array(length + 16);
        for (let at = 0; at < memory.length; at++)
        {
            memory[at] = sent[at] = Math.floor(random() * 256);
        }
        const changes = Math.floor(random() * 6);
        for (let change = 0; change < changes; change++)
        {
            const from = Math.floor(random() * Math.max(1, length));
            const run = Math.floor(random() * 40);
            for (let at = from; at < Math.min(length, from + run); at++)
            {
                memory[offset + at] ^= 1 + Math.floor(random() * 255);
            }
        }
        const now = memory.subarray(offset, offset + length);
        const was = sent.subarray(offset, offset + length);
        const gap = [4, 16, 64][round % 3];
        holds(now, was, changedSpans(now, was, gap), gap);
    }
});

test('equal runs answer no span; one change answers one span around it', ()=>{
    const a = new Uint8Array(4096);
    const b = new Uint8Array(4096);
    assert.deepEqual(changedSpans(a, b), []);
    a[1001] = 9;
    a[1010] = 9;
    assert.deepEqual(changedSpans(a, b), [1000, 1012], 'near changes are one span, in words');
    a[3000] = 1;
    assert.deepEqual(changedSpans(a, b), [1000, 1012, 3000, 3004], 'far ones are two');
});

test('a range is compared once in a pause, and each draw takes only what is new of its own', ()=>{
    const compared = createCompared();
    const a = {};
    const b = {};
    assert.deepEqual(compared.take(a, 100, 200), [100, 200]);
    assert.deepEqual(compared.take(a, 100, 200), [], 'the same range again: nothing');
    assert.deepEqual(compared.take(a, 150, 300), [200, 300], 'the part past it');
    assert.deepEqual(compared.take(a, 0, 400), [0, 100, 300, 400], 'both sides of it');
    assert.deepEqual(compared.take(a, 50, 350), []);
    assert.deepEqual(compared.take(b, 120, 130), [120, 130], 'another buffer is its own');
    assert.deepEqual(compared.take(a, 600, 700), [600, 700]);
    assert.deepEqual(compared.take(a, 500, 650), [500, 600], 'a gap before a range');
    compared.clear();
    assert.deepEqual(compared.take(a, 100, 200), [100, 200], 'a new pause compares again');
});

test('the ranges taken are exactly what was not taken before, against a byte map', ()=>{
    let seed = 11;
    const random = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed / 0x100000000;
    };
    const compared = createCompared();
    const key = {};
    const seen = new Uint8Array(2000);
    for (let round = 0; round < 3000; round++)
    {
        const from = Math.floor(random() * 1900);
        const to = from + 1 + Math.floor(random() * 100);
        const open = compared.take(key, from, to);
        const expected = new Uint8Array(2000);
        for (let at = from; at < to; at++)
        {
            expected[at] = seen[at] ? 0 : 1;
            seen[at] = 1;
        }
        const got = new Uint8Array(2000);
        for (let index = 0; index < open.length; index += 2)
        {
            assert.ok(open[index] < open[index + 1], 'a range is not empty');
            got.fill(1, open[index], open[index + 1]);
        }
        assert.deepEqual(got, expected, `round ${round}: [${from}, ${to}) took ${open}`);
    }
});

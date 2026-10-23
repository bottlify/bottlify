/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageMarks, changedSpans, createCompared, pageMarksOf, writtenSpans } from './changed.js';

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
        // A span is not carried across an equal run longer than the gap:
        // eight words tested at once still end one where a word would.
        let equal = 0;
        for (let at = start; at < end; at++)
        {
            equal = now[at] === was[at] ? equal + 1 : 0;
            assert.ok(equal <= gap + 8, `an equal run of ${equal} inside a span, gap ${gap}`);
        }
    }
    for (let at = 0; at < now.length; at++)
    {
        if (now[at] !== was[at])
        {
            assert.equal(covered[at], 1, `byte ${at} changed and is in no span`);
        }
    }
};

test('the spans cover every changed byte and only runs that start and end on one', ()=>{
    let seed = 7;
    const random = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed / 0x100000000;
    };
    for (let round = 0; round < 3000; round++)
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
            const run = Math.floor(random() * (random() < 0.5 ? 6 : 120));
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

test('an equal run of whole eight-word blocks ends a span as the words one by one would', ()=>{
    const now = new Uint8Array(256);
    const was = new Uint8Array(256);
    // Changes in words 0 and 40, everything between equal and block aligned.
    now[0] = 1;
    now[160] = 1;
    assert.deepEqual(changedSpans(now, was, 64), [0, 4, 160, 164]);
    assert.deepEqual(changedSpans(now, was, 256), [0, 164], 'and keeps it within the gap');
});

test('a block changed inside a span ends the span at its last change, not at the block\'s end',
    ()=>{
        const now = new Uint8Array(256);
        const was = new Uint8Array(256);
        // Words 0 and 9 changed: the block of words 8-15 differs at its second word only.
        now[0] = 1;
        now[36] = 1;
        assert.deepEqual(changedSpans(now, was, 64), [0, 40]);
    });

/** A seeded generator of integers below `n`. @param {number} seed */
const seededBelow = seed=>{
    let state = seed >>> 0;
    return (/** @type {number} */ n)=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
};

test('page marks answer every question a set of the same pages does, over seeded steps', ()=>{
    for (let seed = 1; seed <= 30; seed++)
    {
        const below = seededBelow(seed);
        const first = 100 + below(5000);
        const count = 1 + below(300);
        const all = below(2) === 0;
        const marks = new PageMarks(first, count, all);
        const other = new PageMarks(first, count);
        /** @type {Set<number>} */
        const set = new Set(all ? Array.from({ length: count }, (_, at)=>first + at) : []);
        /** @type {Set<number>} */
        const otherSet = new Set();
        for (let step = 0; step < 300; step++)
        {
            const from = first - 3 + below(count + 6);
            const last = from + below(80) - 10;
            const kind = below(5);
            if (kind === 0)
            {
                marks.add(from);
                if (from >= first && from < first + count)
                {
                    set.add(from);
                }
            }
            else if (kind === 1)
            {
                const into = below(2) === 0;
                marks.take(from, last, into ? other : undefined);
                for (let page = from; page <= last; page++)
                {
                    if (set.delete(page) && into)
                    {
                        otherSet.add(page);
                    }
                }
            }
            else
            {
                const want = kind === 2;
                let expected = -1;
                for (let page = Math.max(from, first); page <= Math.min(last, first + count - 1);
                    page++)
                {
                    if (set.has(page) === want)
                    {
                        expected = page;
                        break;
                    }
                }
                assert.equal(marks.find(from, last, want), expected,
                    `seed ${seed} step ${step}: the first ${want ? 'marked' : 'clear'} page`
                    + ` in [${from}, ${last}]`);
            }
            assert.equal(marks.size, set.size, `seed ${seed} step ${step}: size`);
            assert.equal(other.size, otherSet.size, `seed ${seed} step ${step}: size moved into`);
            assert.equal(marks.has(from), set.has(from));
        }
    }
});

/**
 * `writtenSpans` as it was with a set of pages, asking it of every page in
 * the range: the reference the page marks are held to.
 *
 * @param {{ watch: { take: (address: number, length: number) => number[] },
 *     dirty: Set<number> }} tracked
 * @param {number} base @param {number} length @param {number} from @param {number} to
 */
const spansAskingEachPage = (tracked, base, length, from, to)=>{
    if (to <= from)
    {
        return [];
    }
    for (const page of tracked.watch.take(base + from, to - from))
    {
        tracked.dirty.add(page);
    }
    /** @type {number[]} */
    const spans = [];
    if (tracked.dirty.size === 0)
    {
        return spans;
    }
    const last = (base + to - 1) >>> 12;
    for (let page = (base + from) >>> 12; page <= last; page++)
    {
        if (!tracked.dirty.has(page))
        {
            continue;
        }
        let end = page;
        while (end < last && tracked.dirty.has(end + 1))
        {
            end++;
        }
        const lo = Math.max(from, page * 4096 - base);
        const hi = Math.min(to, (end + 1) * 4096 - base);
        spans.push(lo, hi);
        for (let done = page; done <= end; done++)
        {
            if (Math.max(0, done * 4096 - base) >= lo
                && Math.min(length, (done + 1) * 4096 - base) <= hi)
            {
                tracked.dirty.delete(done);
            }
        }
        page = end;
    }
    return spans;
};

/**
 * A write watch over a buffer's pages fed the same writes as another: what
 * each take answers is the pages written since that watch last took them.
 *
 * @param {number} base @param {number} length
 */
const pagesWatch = (base, length)=>{
    /** @type {Set<number>} */
    const written = new Set();
    return {
        /** @param {number} page */
        write: page=>written.add(page),
        watch: {
            /** @param {number} address @param {number} bytes */
            take(address, bytes){
                const pages = [];
                const last = Math.min((address + bytes - 1) >>> 12, (base + length - 1) >>> 12);
                for (let page = address >>> 12; page <= last; page++)
                {
                    if (written.delete(page))
                    {
                        pages.push(page);
                    }
                }
                return pages;
            },
        },
    };
};

test('written spans with page marks are those of a set asked page by page, over seeded draws',
    ()=>{
        for (let seed = 1; seed <= 60; seed++)
        {
            const below = seededBelow(seed);
            // A buffer off a page boundary or on one, of a few pages to a few hundred.
            const base = 0x400000 + below(64) * 4096 + (below(2) === 0 ? 0 : below(4096));
            const length = 1 + below(below(2) === 0 ? 3 << 12 : 600 << 12);
            const firstPage = base >>> 12;
            const pageCount = ((base + length - 1) >>> 12) - firstPage + 1;
            const dynamic = below(2) === 0;
            const one = pagesWatch(base, length);
            const two = pagesWatch(base, length);
            const marked = { watch: one.watch, dirty: pageMarksOf(base, length, !dynamic) };
            const asked = { watch: two.watch, dirty: new Set(dynamic ? []
                : Array.from({ length: pageCount }, (_, at)=>firstPage + at)) };
            for (let step = 0; step < 200; step++)
            {
                for (let writes = below(4); writes > 0; writes--)
                {
                    const page = firstPage + below(pageCount);
                    one.write(page);
                    two.write(page);
                }
                const from = below(length);
                const to = Math.min(length, from + 1 + below(below(3) === 0 ? length : 20000));
                assert.deepEqual(writtenSpans(marked, base, length, from, to),
                    spansAskingEachPage(asked, base, length, from, to),
                    `seed ${seed} step ${step}: [${from}, ${to}) of ${length} at ${base}`);
                assert.equal(marked.dirty.size, asked.dirty.size);
            }
            for (let page = firstPage; page < firstPage + pageCount; page++)
            {
                assert.equal(marked.dirty.has(page), asked.dirty.has(page));
            }
        }
    });

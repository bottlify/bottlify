/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSortFunctions } from './sort.js';
import { fakeMemory } from './harness.test.js';

const COMPARE = 0x7000;
const BASE = 0x100;

/**
 * The table over a fake memory whose comparator is Wine's qsort_comp: the
 * values modulo 1000, each call's element indices recorded.
 */
const build = ()=>{
    const memory = fakeMemory();
    /** @type {[number, number][]} */
    const calls = [];
    /** @type {number[]} */
    const contexts = [];
    /** @type {number[]} */
    const errno = [];
    const value = (/** @type {number} */ at)=>memory.u32(at) | 0;
    const table = /** @type {Record<string, any>} */ (createSortFunctions({
        ...memory,
        errno: code=>errno.push(code),
        callGuest: async(entry, args)=>{
            assert.equal(entry, COMPARE);
            const [context, left, right] = args;
            contexts.push(context);
            calls.push([(left - BASE) / 4, (right - BASE) / 4]);
            return value(left) % 1000 - value(right) % 1000;
        },
    }));
    /** @param {number[]} values */
    const put = values=>values.forEach((v, i)=>memory.setU32(BASE + i * 4, v));
    /** @param {number} count */
    const read = count=>Array.from({ length: count }, (_, i)=>value(BASE + i * 4));
    return { memory, table, calls, contexts, errno, put, read };
};

test('qsort_s sorts a short run by moving its largest to the end, call for call', async()=>{
    // Wine's msvcrt test_qsort_s: small_sort and small_sort2.
    const { table, calls, contexts, put, read } = build();
    put([0, 1, 2, 3, 4, 5, 6, 7]);
    await table.qsort_s.handler([BASE, 8, 4, COMPARE, 0x55]);
    const ascending = [];
    for (let end = 7; end > 0; end--)
    {
        for (let p = 1; p <= end; p++)
        {
            ascending.push([p, p - 1]);
        }
    }
    assert.deepEqual(calls, ascending);
    assert.equal(calls.length, 28);
    assert.ok(contexts.every(context=>context === 0x55), 'the context first');
    assert.deepEqual(read(8), [0, 1, 2, 3, 4, 5, 6, 7]);

    calls.length = 0;
    put([7, 6, 5, 4, 3, 2, 1, 0]);
    await table.qsort_s.handler([BASE, 8, 4, COMPARE, 0]);
    assert.deepEqual(calls.slice(0, 13), [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0],
        [7, 0], [1, 0], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]]);
    assert.equal(calls.length, 28);
    assert.deepEqual(read(8), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('qsort_s splits a longer run around a median of three, as msvcrt does', async()=>{
    const { table, calls, put, read } = build();
    put([0, 1, 2, 3, 4, 1, 2, 7, 8]);
    await table.qsort_s.handler([BASE, 9, 4, COMPARE, 0]);
    assert.deepEqual(calls, [[0, 4], [0, 8], [4, 8],
        [1, 4], [2, 4], [3, 4], [5, 4], [6, 4], [7, 4], [7, 4], [6, 4],
        [6, 4],
        [8, 7],
        [1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 4],
        [1, 0], [2, 1], [3, 2], [4, 3], [5, 3],
        [1, 0], [2, 1], [3, 2], [4, 2],
        [1, 0], [2, 1], [3, 2],
        [1, 0], [2, 1],
        [1, 0]]);
    assert.deepEqual(read(9), [0, 1, 1, 2, 2, 3, 4, 7, 8]);

    // Not stable, and where equal elements land is msvcrt's.
    put([1003, 7001, 6002, 5003, 4004, 3005, 2006, 1007, 9008]);
    const tab = [8, 7, 6, 5, 4, 3, 2, 1, 0].map((v, i)=>v + 1000 * (i + 1));
    tab[0] = 1003;
    put(tab);
    await table.qsort_s.handler([BASE, 9, 4, COMPARE, 0]);
    assert.deepEqual(read(9), [9000, 8001, 7002, 6003, 1003, 5004, 4005, 3006, 2007]);
});

test('qsort_s sorts a hundred values and refuses what it cannot sort', async()=>{
    const { table, errno, put, read } = build();
    const values = Array.from({ length: 100 }, (_, i)=>(i * 7919) % 1000);
    put(values);
    await table.qsort_s.handler([BASE, 100, 4, COMPARE, 0]);
    assert.deepEqual(read(100), values.slice().sort((a, b)=>a - b));
    assert.equal(await table.qsort_s.handler([BASE, 4, 0, COMPARE, 0]), 0);
    assert.equal(await table.qsort_s.handler([BASE, 4, 4, 0, 0]), 0);
    assert.deepEqual(errno, [22, 22]);
});

test('_lfind_s finds the first element its comparator calls equal, or null', async()=>{
    // Wine's msvcrt test__lfind_s: the context first, then the key, then the element.
    const { memory, table, errno, put, contexts } = build();
    put([9000, 8001, 7002, 6003, 1003, 5004, 4005, 3006, 2007]);
    const key = 0x400;
    const num = 0x404;
    memory.setU32(num, 9);
    for (const args of [[0, BASE, num, 4, COMPARE, 0], [key, 0, num, 4, COMPARE, 0],
        [key, BASE, num, 0, COMPARE, 0], [key, BASE, num, 4, 0, 0]])
    {
        assert.equal(await table._lfind_s.handler(args), 0);
    }
    assert.deepEqual(errno, [22, 22, 22, 22]);
    // The comparator here is by the values modulo 1000, as Wine's qsort_comp.
    memory.setU32(key, 1007);
    assert.equal(await table._lfind_s.handler([key, BASE, num, 4, COMPARE, 0x77]), BASE + 8 * 4);
    assert.ok(contexts.every(context=>context === 0x77));
    memory.setU32(key, 234);
    assert.equal(await table._lfind_s.handler([key, BASE, num, 4, COMPARE, 0x77]), 0);
    assert.deepEqual(errno, [22, 22, 22, 22], 'not found is no error');
});

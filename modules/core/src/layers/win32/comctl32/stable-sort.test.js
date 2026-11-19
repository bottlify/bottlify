/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableSort } from './stable-sort.js';

test('the shared sort orders by the comparison and keeps equal elements in their order', async()=>{
    const values = [{ k: 2, n: 'a' }, { k: 1, n: 'b' }, { k: 2, n: 'c' }, { k: 1, n: 'd' }];
    const sorted = await stableSort(values, (a, b)=>a.k - b.k);
    assert.deepEqual(sorted.map(v=>v.n), ['b', 'd', 'a', 'c']);
    assert.deepEqual(values.map(v=>v.n), ['a', 'b', 'c', 'd'], 'the input untouched');
});

test('the comparison may answer through a promise, as a program\'s called in the guest does',
    async()=>{
        const sorted = await stableSort([3, 1, 2], async(a, b)=>a - b);
        assert.deepEqual(sorted, [1, 2, 3]);
        assert.deepEqual(await stableSort([], ()=>0), []);
    });

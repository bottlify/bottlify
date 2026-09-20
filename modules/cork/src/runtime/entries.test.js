/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntries } from './entries.js';

const fn = ()=>0;

test('an entry is found by its address and answers its function and label', ()=>{
    const entries = createEntries();
    const a = entries.add(0x1000, fn, 0);
    const b = entries.add(0x1010, fn, 1);
    assert.notEqual(a, b);
    assert.equal(entries.entryOf(0x1000), a);
    assert.equal(entries.entryOf(0x1010), b);
    assert.equal(entries.entryOf(0x1004), -1);
    assert.deepEqual(entries.at(b), { eip: 0x1010, fn, label: 1, page: 1, top: 8 });
    assert.equal(entries.count(), 2);
    assert.equal(entries.add(0x1000, ()=>1, 5), a, 'an address already mapped keeps its entry');
    assert.equal(entries.at(a).label, 0);
});

test('removing a page drops every entry in it and no other', ()=>{
    const entries = createEntries();
    const a = entries.add(0x1000, fn, 0);
    entries.add(0x1ffc, fn, 1);
    const c = entries.add(0x2000, fn, 0);
    assert.equal(entries.removePage(1), 2);
    assert.equal(entries.entryOf(0x1000), -1);
    assert.equal(entries.entryOf(0x1ffc), -1);
    assert.equal(entries.entryOf(0x2000), c);
    assert.equal(entries.count(), 1);
    assert.throws(()=>entries.at(a), /not live/);
    assert.equal(entries.removePage(1), 0, 'nothing left there');
    entries.remove(c);
    assert.equal(entries.count(), 0);
    entries.remove(c);
    assert.equal(entries.count(), 0, 'removing twice changes nothing');
});

test('an entry compiled for an x87 top is found at that top, or under any top', ()=>{
    const entries = createEntries();
    const any = entries.add(0x1000, fn, 0);
    const seven = entries.add(0x2000, fn, 0, 7);
    assert.equal(entries.entryOf(0x1000, 3), any, 'indifferent to the top');
    assert.equal(entries.entryOf(0x2000, 7), seven);
    assert.equal(entries.entryOf(0x2000, 0), -1, 'compiled for another top');
    assert.equal(entries.isSpecialised(0x2000), true);
    assert.equal(entries.isSpecialised(0x1000), false);
    const zero = entries.add(0x2000, fn, 1, 0);
    assert.notEqual(zero, seven);
    assert.equal(entries.entryOf(0x2000, 0), zero);
    entries.remove(seven);
    assert.equal(entries.entryOf(0x2000, 7), -1);
    assert.equal(entries.entryOf(0x2000, 0), zero);
});

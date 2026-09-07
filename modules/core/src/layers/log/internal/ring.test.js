/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRing } from './ring.js';

/** @returns {any} */
const slot = ()=>({ value: 0 });

test('slots are made once and handed back again on the next lap', ()=>{
    const ring = createRing(3, slot);
    const first = [ring.next(), ring.next(), ring.next()];
    const second = [ring.next(), ring.next(), ring.next()];

    assert.equal(new Set([...first, ...second]).size, 3, 'no slot was ever allocated again');
    for (let index = 0; index < 3; index++)
    {
        assert.equal(second[index], first[index]);
    }
});

test('a reader that fell behind gets the surviving tail, not nothing', ()=>{
    const ring = createRing(3, slot);
    for (let value = 0; value < 5; value++)
    {
        ring.next().value = value;
    }

    assert.equal(ring.written(), 5);
    assert.equal(ring.oldest(), 2);

    /** @type {number[]} */
    const seen = [];
    /** @type {number[]} */
    const sequences = [];
    ring.each(0, (entry, sequence)=>{
        seen.push(entry.value);
        sequences.push(sequence);
    });
    assert.deepEqual(seen, [2, 3, 4]);
    assert.deepEqual(sequences, [2, 3, 4], 'a sequence survives being lapped');
});

test('each visits only what was asked for, and nothing before the ring filled', ()=>{
    const ring = createRing(4, slot);
    ring.next().value = 7;
    ring.next().value = 8;

    /** @type {number[]} */
    const seen = [];
    ring.each(1, entry=>seen.push(entry.value));
    assert.deepEqual(seen, [8]);

    ring.each(99, ()=>assert.fail('nothing is written past the end'));

    ring.clear();
    assert.equal(ring.written(), 0);
    ring.each(0, ()=>assert.fail('a cleared ring has nothing to visit'));
});

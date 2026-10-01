/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HashedStates } from './statehash.js';

/** @param {HashedStates} states */
const hashOf = states=>[states.low, states.high];

test('the hash names the contents, whatever order they were set in', ()=>{
    const a = new HashedStates();
    const b = new HashedStates();
    a.set(7, 1).set(8, 2).set(9, 3);
    b.set(9, 3).set(7, 1).set(8, 2);
    assert.deepEqual(hashOf(a), hashOf(b));
    b.set(8, 4);
    assert.notDeepEqual(hashOf(a), hashOf(b), 'a value changed is a different state');
    b.set(8, 2);
    assert.deepEqual(hashOf(a), hashOf(b), 'and set back, the same one');
});

test('a pair taken away or present at zero is a different state from none', ()=>{
    const states = new HashedStates();
    const empty = hashOf(states);
    states.set(5, 0);
    assert.notDeepEqual(hashOf(states), empty);
    states.delete(5);
    assert.deepEqual(hashOf(states), empty);
    states.set(1, 2).set(3, 4);
    states.clear();
    assert.deepEqual(hashOf(states), [0, 0]);
});

test('every pair of a device\'s worth of states moves the hash', ()=>{
    // Two pairs that hash alike would name two states as one draw's.
    const seen = new Set();
    const states = new HashedStates();
    for (let key = 0; key < 256; key++)
    {
        for (const value of [0, 1, 2, 0xffffffff, 0x3f800000])
        {
            states.set(key, value);
            seen.add(hashOf(states).join(':'));
        }
    }
    assert.equal(seen.size, 256 * 5);
});

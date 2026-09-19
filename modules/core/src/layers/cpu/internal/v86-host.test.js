/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushPublished } from './v86-host.js';

test('pushPublished keeps at most `limit` entries, oldest first, newest last', ()=>{
    /** @type {[number, number][]} */
    const ring = [];
    for (let i = 0; i < 5; i++)
    {
        pushPublished(ring, 3, i, i * 100);
    }
    assert.deepEqual(ring, [[2, 200], [3, 300], [4, 400]],
        'the two oldest publishes fell off, the ring stayed at the limit');
});

test('pushPublished records the exact [slot, start] pair, under the limit', ()=>{
    /** @type {[number, number][]} */
    const ring = [];
    pushPublished(ring, 4096, 0x2a, 0x401234);
    assert.deepEqual(ring, [[0x2a, 0x401234]]);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_STRIPS, stripOfBitmapId } from './strips.js';

test('a toolbar\'s IDB_ numbers name the standard strips, odd ones the large', ()=>{
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(id=>{
        const strip = stripOfBitmapId(id);
        return strip && [strip.count, strip.side];
    }), [[15, 16], [15, 24], [15, 16], [15, 24], [12, 16], [12, 24], [12, 16], [12, 24],
        [5, 16], [5, 24]]);
    assert.equal(stripOfBitmapId(10), null);
    assert.equal(stripOfBitmapId(-1), null);
    assert.equal(STANDARD_STRIPS[121].side, 24);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSpan } from './d3d10.js';

test('an update reads its last row whole, whatever its pitches (test_update_subresource,'
    + ' d3d11.c:14351)', ()=>{
    // A row of two BC7 blocks: 32 bytes.
    const row = { rowPitch: 32, rows: 1 };
    assert.equal(updateSpan(row, 1, 4, 32), 32, 'a pitch of 4 under a row of 32 reads the row');
    assert.equal(updateSpan({ rowPitch: 16, rows: 1 }, 2, 0, 16), 32, 'two slices 16 apart');
    assert.equal(updateSpan({ rowPitch: 16, rows: 1 }, 2, 0, 1), 17, 'slices that overlap');
    assert.equal(updateSpan({ rowPitch: 32, rows: 2 }, 2, 32, 64), 128, 'packed');
    assert.equal(updateSpan({ rowPitch: 8, rows: 4 }, 1, 20, 0), 68, 'rows wider apart');
});

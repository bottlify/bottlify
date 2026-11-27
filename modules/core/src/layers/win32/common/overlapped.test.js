/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlappedLayout } from './overlapped.js';

test('OVERLAPPED has the SDK\'s offsets at both widths', ()=>{
    // minwinbase.h: two ULONG_PTRs, the union of the two DWORDs of the
    // position with a PVOID, then the HANDLE - 20 bytes at 32, 32 at 64.
    assert.deepEqual({ ...overlappedLayout(4) }, { internal: 0, internalHigh: 4, offset: 8,
        offsetHigh: 12, event: 16, word: 4 });
    assert.deepEqual({ ...overlappedLayout(8) }, { internal: 0, internalHigh: 8, offset: 16,
        offsetHigh: 20, event: 24, word: 8 });
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statstgLayout } from './statstg.js';

test('STATSTG is 72 bytes at 32 bits and 80 at 64, every field after the name moved', ()=>{
    assert.deepEqual({ ...statstgLayout() }, { ...statstgLayout(4) });
    assert.deepEqual({ ...statstgLayout(4) }, { NAME: 0, TYPE: 4, SIZE: 8, MTIME: 16, CTIME: 24,
        ATIME: 32, MODE: 40, LOCKS: 44, CLSID: 48, STATE_BITS: 64, SIZE_OF: 72 });
    // pwcsName eight bytes, then cbSize aligned to eight after the DWORD type:
    // what the 64-bit SDK's struct tagSTATSTG lays out.
    assert.deepEqual({ ...statstgLayout(8) }, { NAME: 0, TYPE: 8, SIZE: 16, MTIME: 24, CTIME: 32,
        ATIME: 40, MODE: 48, LOCKS: 52, CLSID: 56, STATE_BITS: 72, SIZE_OF: 80 });
});

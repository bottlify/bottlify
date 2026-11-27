/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wholeAddress } from './address.js';

test('an address below 4 GiB is unsigned whatever sign its dword had, one past it is whole', ()=>{
    assert.equal(wholeAddress(0x1000), 0x1000);
    assert.equal(wholeAddress(-1), 0xffffffff);
    assert.equal(wholeAddress(0x80000000 | 0), 0x80000000);
    assert.equal(wholeAddress(2 ** 32 + 0x1000), 2 ** 32 + 0x1000, 'not its low dword');
    assert.equal(wholeAddress(2 ** 47), 2 ** 47);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNCHRONIZE, allows, grantedAccess } from './access.js';

test('a mutex opened by name refuses no rights and rights it does not have', ()=>{
    // Wine's kernel32 sync.c test_mutex: OpenMutex of each single bit, and
    // the bits that fail are 0x0de0fffe; ACCESS_SYSTEM_SECURITY's needs a
    // privilege, every other's is ERROR_ACCESS_DENIED, and no rights at all too.
    let failed = 0;
    for (let bit = 0; bit < 32; bit++)
    {
        const answer = grantedAccess('mutex', 2 ** bit);
        if ('error' in answer)
        {
            failed |= 2 ** bit;
            assert.equal(answer.error, bit === 24 ? 1314 : 5, `bit ${bit}`);
        }
    }
    assert.equal(failed >>> 0, 0x0de0fffe);
    assert.deepEqual(grantedAccess('mutex', 0), { error: 5 });
});

test('generic rights are the kind\'s own, and a wait needs SYNCHRONIZE', ()=>{
    // GENERIC_EXECUTE may wait on a mutex; GENERIC_READ | GENERIC_WRITE may not.
    const execute = grantedAccess('mutex', 0x20000000);
    const readWrite = grantedAccess('mutex', 0xc0000000);
    assert.ok('granted' in execute && allows(execute.granted, SYNCHRONIZE));
    assert.ok('granted' in readWrite && !allows(readWrite.granted, SYNCHRONIZE));
    assert.deepEqual(grantedAccess('event', 0x1f0003), { granted: null }, 'every right is all');
    assert.deepEqual(grantedAccess('event', 0x02000000), { granted: null }, 'MAXIMUM_ALLOWED');
    assert.deepEqual(grantedAccess('event', 0x40000000), { granted: 0x20002 },
        'GENERIC_WRITE: READ_CONTROL and EVENT_MODIFY_STATE');
    assert.equal(allows(null, SYNCHRONIZE), true);
});

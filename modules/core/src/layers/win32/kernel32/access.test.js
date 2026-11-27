/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNCHRONIZE, allows, duplicateAccess, grantedAccess, mappedAccess } from './access.js';

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

test('a thread\'s rights: generic ones mapped, and a query right carries its limited form', ()=>{
    assert.deepEqual(grantedAccess('thread', 0x1fffff), { granted: null }, 'THREAD_ALL_ACCESS');
    assert.deepEqual(grantedAccess('thread', 0x800), { granted: 0x800 },
        'THREAD_QUERY_LIMITED_INFORMATION alone');
    assert.deepEqual(grantedAccess('thread', 0x40), { granted: 0x840 },
        'THREAD_QUERY_INFORMATION is granted THREAD_QUERY_LIMITED_INFORMATION too');
    assert.deepEqual(grantedAccess('thread', 0x20), { granted: 0x420 });
    const read = grantedAccess('thread', 0x80000000);
    assert.deepEqual(read, { granted: 0x20848 }, 'GENERIC_READ: the context and the information');
    assert.ok('granted' in read && !allows(read.granted, SYNCHRONIZE));
});

test('a section\'s generic rights are its FILE_MAP_* rights; a duplicate may ask for none', ()=>{
    // winnt.h's SECTION_* generic mapping: read is QUERY and MAP_READ, write
    // MAP_WRITE, execute MAP_EXECUTE, each with READ_CONTROL.
    assert.deepEqual(grantedAccess('mapping', 0x80000000), { granted: 0x20005 });
    assert.deepEqual(grantedAccess('mapping', 0x40000000), { granted: 0x20002 });
    assert.deepEqual(grantedAccess('mapping', 0x20000000), { granted: 0x20008 });
    assert.deepEqual(grantedAccess('mapping', 0x0004), { granted: 0x0004 }, 'FILE_MAP_READ');
    assert.deepEqual(grantedAccess('mapping', 0x000f001f), { granted: 0x000f001f },
        'SECTION_ALL_ACCESS: every right of its own, no SYNCHRONIZE');
    assert.ok('error' in grantedAccess('mapping', 0), 'an open by name asks for something');
    assert.deepEqual(duplicateAccess('mapping', 0, null, false), { granted: 0 });
    assert.deepEqual(duplicateAccess('file', 0, null, false), { granted: 0 },
        'whatever the kind');
    assert.deepEqual(duplicateAccess('mapping', 0x0004, null, false), { granted: 0x0004 });
    assert.deepEqual(duplicateAccess('mapping', 0x0004, 0x0006, true), { granted: 0x0006 });
});

test('a file\'s duplicate cannot be granted a right its source lacks; generic rights map to'
    + ' FILE_GENERIC_*', ()=>{
    const GENERIC_READ = 0x80000000;
    const GENERIC_WRITE = 0x40000000;
    const FILE_READ_DATA = 0x1;
    const FILE_WRITE_DATA = 0x2;
    const FILE_APPEND_DATA = 0x4;
    const implied = SYNCHRONIZE | 0x80;
    assert.equal(mappedAccess('file', GENERIC_READ), 0x120089, 'FILE_GENERIC_READ');
    assert.equal(mappedAccess('file', GENERIC_WRITE), 0x120116, 'FILE_GENERIC_WRITE');
    assert.equal(mappedAccess('file', 0), 0, 'an open may ask for nothing');
    // Wine's test_file_access: each open, each duplicate of it.
    const opens = [GENERIC_READ | GENERIC_WRITE, GENERIC_WRITE, GENERIC_READ,
        FILE_READ_DATA | FILE_WRITE_DATA, FILE_WRITE_DATA, FILE_READ_DATA, FILE_APPEND_DATA,
        FILE_READ_DATA | FILE_APPEND_DATA, FILE_WRITE_DATA | FILE_APPEND_DATA, 0];
    for (const open of opens)
    {
        const source = mappedAccess('file', (open | implied) >>> 0);
        for (const asked of opens)
        {
            const mappedAsked = /** @type {number} */ (mappedAccess('file', asked));
            const mappedOpen = /** @type {number} */ (mappedAccess('file', open));
            const fits = (mappedOpen & mappedAsked) === mappedAsked;
            const got = duplicateAccess('file', asked, source, false);
            assert.deepEqual('error' in got, !fits,
                `${open.toString(16)} => ${asked.toString(16)}`);
            if (!fits)
            {
                assert.deepEqual(got, { error: 5 });
            }
        }
    }
    assert.deepEqual(duplicateAccess('event', 0x1f0003, 0x00100000, false), { granted: null },
        'an event\'s duplicate is not bounded by its source');
});

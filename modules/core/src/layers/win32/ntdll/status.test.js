/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_MR_MID_NOT_FOUND, STATUS, toDosError } from './status.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_MORE_DATA = 234;
const ERROR_INSUFFICIENT_BUFFER = 122;

test('success translates to success', ()=>{
    // The two domains agree on exactly one value, and a caller that reports
    // through GetLastError after a successful Nt call must see nothing wrong.
    assert.equal(toDosError(STATUS.SUCCESS), ERROR_SUCCESS);
});

test('a status arrives as a signed word and is still recognised', ()=>{
    // The bridge reads arguments as signed 32-bit integers, so every status with
    // the error severity set reaches a handler negative. Matching on the value as
    // it arrives would miss every failure code there is.
    assert.ok((STATUS.ACCESS_DENIED | 0) < 0, 'the argument really does arrive negative');
    assert.equal(toDosError(STATUS.ACCESS_DENIED | 0), ERROR_ACCESS_DENIED);
    assert.equal(toDosError(STATUS.ACCESS_DENIED), ERROR_ACCESS_DENIED);
});

test('the four ways a name can be missing all become one Win32 error', ()=>{
    // The translation is many-to-one, and this is the group that matters: code
    // written against Win32 tests for ERROR_FILE_NOT_FOUND and would not
    // recognise any of the native codes that produced it.
    for (const status of [
        STATUS.NO_SUCH_FILE,
        STATUS.NO_SUCH_DEVICE,
        STATUS.OBJECT_NAME_NOT_FOUND,
    ])
    {
        assert.equal(toDosError(status), ERROR_FILE_NOT_FOUND);
    }
});

test('the two "not enough room" statuses do not collapse together', ()=>{
    // BUFFER_OVERFLOW is a partial answer the caller may keep; BUFFER_TOO_SMALL
    // means nothing was written. Mapping both to one error would have a caller
    // discard a result it was given, or read one it never got.
    assert.equal(toDosError(STATUS.BUFFER_OVERFLOW), ERROR_MORE_DATA);
    assert.equal(toDosError(STATUS.BUFFER_TOO_SMALL), ERROR_INSUFFICIENT_BUFFER);
});

test('a status with no translation says so rather than guessing', ()=>{
    // Windows answers ERROR_MR_MID_NOT_FOUND for a status it has no message for.
    // Anything else here would be a Win32 error the failure never had, and a
    // caller acts on it as though it did.
    assert.equal(toDosError(0xc0000123), ERROR_MR_MID_NOT_FOUND);
    assert.equal(ERROR_MR_MID_NOT_FOUND, 317);
});

test('a version that does not meet a request is a revision mismatch in both domains', ()=>{
    // RtlVerifyVersionInfo's answer when the system does not satisfy the
    // request; Wine's ntdll error tests pin its translation.
    assert.equal(STATUS.REVISION_MISMATCH, 0xc0000059);
    assert.equal(toDosError(STATUS.REVISION_MISMATCH), 1306);
});

test('every status translated here answers what Wine\'s ntdll error tests expect', ()=>{
    // error.c's cmp rows for each status this table holds, as Win32 numbers.
    // STATUS_NO_SUCH_DEVICE is a cmp3 row there, which accepts
    // ERROR_FILE_NOT_FOUND beside ERROR_NO_SUCH_DEVICE; STATUS_TIMEOUT has no
    // row at all.
    /** @type {[number, number | number[]][]} */
    const rows = [
        [STATUS.SUCCESS, 0],
        [STATUS.PENDING, 997],
        [STATUS.BUFFER_OVERFLOW, 234],
        [STATUS.NO_MORE_FILES, 18],
        [STATUS.UNSUCCESSFUL, 31],
        [STATUS.NOT_IMPLEMENTED, 1],
        [STATUS.INVALID_INFO_CLASS, 87],
        [STATUS.INFO_LENGTH_MISMATCH, 24],
        [STATUS.ACCESS_VIOLATION, 998],
        [STATUS.INVALID_HANDLE, 6],
        [STATUS.INVALID_PARAMETER, 87],
        [STATUS.NO_SUCH_DEVICE, [433, 2]],
        [STATUS.NO_SUCH_FILE, 2],
        [STATUS.END_OF_FILE, 38],
        [STATUS.NO_MEMORY, 8],
        [STATUS.ACCESS_DENIED, 5],
        [STATUS.BUFFER_TOO_SMALL, 122],
        [STATUS.OBJECT_NAME_NOT_FOUND, 2],
        [STATUS.OBJECT_NAME_COLLISION, 183],
        [STATUS.OBJECT_PATH_NOT_FOUND, 3],
        [STATUS.SHARING_VIOLATION, 32],
        [STATUS.DISK_FULL, 112],
        [STATUS.INSUFFICIENT_RESOURCES, 1450],
        [STATUS.NOT_SUPPORTED, 50],
        [STATUS.INVALID_PARAMETER_2, 87],
        [STATUS.NOT_A_DIRECTORY, 267],
        [STATUS.REVISION_MISMATCH, 1306],
    ];
    for (const [status, expected] of rows)
    {
        const accepted = Array.isArray(expected) ? expected : [expected];
        const answer = toDosError(status);
        assert.ok(accepted.includes(answer),
            `0x${status.toString(16)}: ${answer}, expected ${accepted.join(' or ')}`);
    }
    const named = Object.entries(STATUS).filter(([name])=>name !== 'TIMEOUT');
    assert.equal(rows.length, named.length, 'every status this table holds but TIMEOUT has a row');
});

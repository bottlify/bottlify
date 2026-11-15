/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandleNatives } from './handles.js';

/** A kernel32 whose handles 4 and 8 open one object and 12 another. */
function fakeKernel32(){
    const objects = new Map([[4, 'a'], [8, 'a'], [12, 'b']]);
    let lastError = 0x1234;
    /** @type {number[][]} */
    const duplicated = [];
    const kernel32 = {
        GetLastError: { handler: ()=>lastError },
        SetLastError: { handler: (/** @type {number[]} */ [code])=>{
            lastError = code;
        } },
        CompareObjectHandles: { handler: (/** @type {number[]} */ [a, b])=>
            (objects.has(a) && objects.get(a) === objects.get(b) ? 1 : 0) },
        DuplicateHandle: { handler: (/** @type {number[]} */ args)=>{
            duplicated.push(args);
            if (!objects.has(args[1]))
            {
                lastError = 6;
                return 0;
            }
            return 1;
        } },
        CloseHandle: { handler: (/** @type {number[]} */ [handle])=>(objects.delete(handle) ? 1 : 0) },
    };
    return { kernel32, duplicated, lastError: ()=>lastError };
}

test('NtCompareObjects tells one object behind two handles from two objects', ()=>{
    const { kernel32, lastError } = fakeKernel32();
    const natives = createHandleNatives({ kernel32 });
    assert.equal(natives.NtCompareObjects.handler([4, 8]), 0);
    assert.equal(natives.NtCompareObjects.handler([4, 12]), 0xc00001ac, 'STATUS_NOT_SAME_OBJECT');
    assert.equal(lastError(), 0x1234, 'the last error left alone');
});

test('NtDuplicateObject is DuplicateHandle with a status, OBJ_INHERIT its inherit flag', ()=>{
    const { kernel32, duplicated, lastError } = fakeKernel32();
    const natives = createHandleNatives({ kernel32 });
    assert.equal(natives.NtDuplicateObject.handler([-1, 4, -1, 0x800, 0, 0x02, 0x06]), 0);
    assert.deepEqual(duplicated.at(-1), [-1, 4, -1, 0x800, 0, 1, 0x02],
        'inherited, and only the options DuplicateHandle knows');
    assert.equal(natives.NtDuplicateObject.handler([-1, 99, -1, 0x800, 0, 0, 0]), 0xc0000008,
        'STATUS_INVALID_HANDLE');
    assert.equal(lastError(), 0x1234, 'the last error left alone');
    assert.equal(natives.NtDuplicateObject.handler([-1, 12, -1, 0, 0, 0, 0x01]), 0,
        'no target with DUPLICATE_CLOSE_SOURCE: the source is closed');
    assert.equal(natives.NtCompareObjects.handler([12, 12]), 0xc00001ac, 'and gone');
});

test('an object is temporary already, made permanent by no one, and no callback is active', ()=>{
    const { kernel32, lastError } = fakeKernel32();
    const natives = createHandleNatives({ kernel32 });
    assert.equal(natives.NtMakeTemporaryObject.handler([4]), 0);
    assert.equal(natives.NtMakeTemporaryObject.handler([99]), 0xc0000008);
    assert.equal(natives.NtMakePermanentObject.handler([4]), 0xc0000061,
        'STATUS_PRIVILEGE_NOT_HELD');
    assert.equal(natives.NtCallbackReturn.handler(), 0xc0000258,
        'STATUS_NO_CALLBACK_ACTIVE');
    assert.equal(lastError(), 0x1234);
});

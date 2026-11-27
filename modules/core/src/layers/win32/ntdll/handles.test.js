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
    const kernel32 = {
        GetLastError: { handler: ()=>lastError },
        SetLastError: { handler: (/** @type {number[]} */ [code])=>{
            lastError = code;
        } },
        CompareObjectHandles: { handler: (/** @type {number[]} */ [a, b])=>
            (objects.has(a) && objects.get(a) === objects.get(b) ? 1 : 0) },
    };
    return { kernel32, lastError: ()=>lastError };
}

test('NtCompareObjects tells one object behind two handles from two objects', ()=>{
    const { kernel32, lastError } = fakeKernel32();
    const natives = createHandleNatives({ kernel32 });
    assert.equal(natives.NtCompareObjects.handler([4, 8]), 0);
    assert.equal(natives.NtCompareObjects.handler([4, 12]), 0xc00001ac, 'STATUS_NOT_SAME_OBJECT');
    assert.equal(lastError(), 0x1234, 'the last error left alone');
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

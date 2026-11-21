/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayWait } from './may-wait.js';

test('a thread that may block on a shared word says so', ()=>{
    assert.equal(mayWait(), true);
});

test('a thread whose Atomics.wait throws, as a page\'s window, may not block', ()=>{
    const wait = Atomics.wait;
    Atomics.wait = ()=>{
        throw new TypeError('Atomics.wait cannot be called in this context');
    };
    try
    {
        assert.equal(mayWait(), false);
    }
    finally
    {
        Atomics.wait = wait;
    }
});

test('a thread with no SharedArrayBuffer may not block', ()=>{
    const shared = globalThis.SharedArrayBuffer;
    // @ts-ignore -- removed for the test, put back below
    delete globalThis.SharedArrayBuffer;
    try
    {
        assert.equal(mayWait(), false);
    }
    finally
    {
        globalThis.SharedArrayBuffer = shared;
    }
});

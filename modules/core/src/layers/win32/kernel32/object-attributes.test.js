/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeNameOf, readObjectAttributes } from './object-attributes.js';
import { createNamedObjects } from './named-objects.js';

test('a Win32 name lives in its session\'s object directory, or the global one', ()=>{
    // MSDN "Kernel object namespaces": Global\ is \BaseNamedObjects, Local\ and
    // a bare name the session's own.
    assert.equal(nativeNameOf('wine_test', 1), '\\Sessions\\1\\BaseNamedObjects\\wine_test');
    assert.equal(nativeNameOf('Local\\a', 1), '\\Sessions\\1\\BaseNamedObjects\\a');
    assert.equal(nativeNameOf('Global\\b', 1), '\\BaseNamedObjects\\b');
});

test('the native path and the Win32 name are each other\'s way back', ()=>{
    const { keyOf } = createNamedObjects();
    for (const name of ['wine_test', 'Some Mutex'])
    {
        const native = nativeNameOf(name, 1);
        const given = { root: 0, name: native, attributes: 0, security: 0, invalid: 0 };
        assert.equal(keyOf(given, 'event'), name);
    }
});

test('an empty name with no buffer is read as empty, its buffer never touched', ()=>{
    const memory = new Uint8Array(0x100);
    const view = new DataView(memory.buffer);
    view.setUint32(0x10, 24, true);
    // ObjectName: a UNICODE_STRING of length 0 whose Buffer is NULL.
    view.setUint32(0x18, 0x40, true);
    /** @type {number[]} */
    const reads = [];
    const read = readObjectAttributes((at, length)=>{
        reads.push(at);
        if (at === 0)
        {
            throw new Error('read at NULL');
        }
        return memory.slice(at, at + length);
    }, 0x10);
    assert.equal(read?.name, '');
    assert.equal(read?.invalid, 0);
    assert.ok(!reads.includes(0), 'nothing read through the NULL buffer');
});

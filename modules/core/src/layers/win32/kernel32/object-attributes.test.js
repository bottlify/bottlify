/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeNameOf, win32NameOf } from './object-attributes.js';

test('a Win32 name lives in its session\'s object directory, or the global one', ()=>{
    // MSDN "Kernel object namespaces": Global\ is \BaseNamedObjects, Local\ and
    // a bare name the session's own.
    assert.equal(nativeNameOf('wine_test', 1), '\\Sessions\\1\\BaseNamedObjects\\wine_test');
    assert.equal(nativeNameOf('Local\\a', 1), '\\Sessions\\1\\BaseNamedObjects\\a');
    assert.equal(nativeNameOf('Global\\b', 1), '\\BaseNamedObjects\\b');
});

test('the native path and the Win32 name are each other\'s way back', ()=>{
    for (const name of ['wine_test', 'Some Mutex'])
    {
        const native = nativeNameOf(name, 1);
        assert.equal(win32NameOf({ root: 0, name: native, attributes: 0, security: 0 }), name);
    }
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Convention, calleeCleanup } from './conventions.js';

test('who pops the arguments is not how many there are', ()=>{
    // The two numbers coincide for stdcall, which is exactly why they get
    // conflated -- and why a cdecl import with arguments is where it shows.
    assert.equal(calleeCleanup(Convention.STDCALL, 12), 12);
    assert.equal(calleeCleanup(Convention.CDECL, 12), 0);

    // `this` came in ECX and was never pushed, so the callee cannot pop it.
    assert.equal(calleeCleanup(Convention.THISCALL, 12), 8);
});

test('a convention nobody defined is a configuration error, not a default', ()=>{
    assert.throws(()=>calleeCleanup('pascal', 4), /Unknown calling convention/);
    assert.throws(()=>calleeCleanup(Convention.STDCALL, 6), /multiple of 4/);
    assert.throws(()=>calleeCleanup(Convention.STDCALL, -4), /non-negative/);
    assert.throws(()=>calleeCleanup(Convention.THISCALL, 0), /at least `this`/);
});

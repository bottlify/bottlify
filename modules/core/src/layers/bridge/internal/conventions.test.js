/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Convention, calleeCleanup, registerArgumentCount } from './conventions.js';

test('who pops the arguments is not how many there are', ()=>{
    // The two numbers coincide for stdcall, which is exactly why they get
    // conflated -- and why a cdecl import with arguments is where it shows.
    assert.equal(calleeCleanup(Convention.STDCALL, 12), 12);
    assert.equal(calleeCleanup(Convention.CDECL, 12), 0);

    // `this` came in ECX and was never pushed, so the callee cannot pop it.
    assert.equal(calleeCleanup(Convention.THISCALL, 12), 8);
});

test('fastcall carries this and one argument in registers, and cleans the rest', ()=>{
    // ECX = this, EDX = the first ordinary argument, three stack words behind
    // them -- a `vector.dot(plane, verts*, count)` kernel is exactly this shape:
    // 5 logical arguments (20 bytes), 2 in registers, 12 bytes on the stack.
    assert.equal(registerArgumentCount(Convention.FASTCALL), 2);
    assert.equal(calleeCleanup(Convention.FASTCALL, 20), 12);
});

test('a convention nobody defined is a configuration error, not a default', ()=>{
    assert.throws(()=>calleeCleanup('pascal', 4), /Unknown calling convention/);
    assert.throws(()=>calleeCleanup(Convention.STDCALL, 6), /multiple of 4/);
    assert.throws(()=>calleeCleanup(Convention.STDCALL, -4), /non-negative/);
    assert.throws(()=>calleeCleanup(Convention.THISCALL, 0), /at least 4/);
    assert.throws(()=>calleeCleanup(Convention.FASTCALL, 4), /at least 8/);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mangledCall } from './mangling.js';

test('a member function of a C runtime class is thiscall, popping its parameters only', ()=>{
    // `this` travels in ECX, so what the callee pops is what follows it.
    assert.deepEqual(mangledCall('??1exception@@UAE@XZ'),
        { convention: 'thiscall', argBytes: 0 }, 'exception::~exception()');
    assert.deepEqual(mangledCall('?what@exception@@UBEPBDXZ'),
        { convention: 'thiscall', argBytes: 0 }, 'char const *exception::what() const');
    assert.deepEqual(mangledCall('??4__non_rtti_object@@QAEAAV0@ABV0@@Z'),
        { convention: 'thiscall', argBytes: 4 }, 'operator= through a name back-reference');
    assert.deepEqual(
        mangledCall('?xsputn@?$basic_streambuf@GU?$char_traits@G@std@@@std@@MAEHPBGH@Z'),
        { convention: 'thiscall', argBytes: 8 }, 'a template class, two parameters');
});

test('a class returned by value from a member goes out through a hidden pointer', ()=>{
    assert.deepEqual(mangledCall('?_Getname@_Locinfo@std@@QBE?AV?$basic_string@DU?$char_traits'
        + '@D@std@@V?$allocator@D@2@@2@XZ'), { convention: 'thiscall', argBytes: 4 });
});

test('a stdcall function pops every parameter, eight bytes for the wide ones', ()=>{
    assert.deepEqual(mangledCall('?f@@YGXHN_J@Z'), { convention: 'stdcall', argBytes: 20 },
        'int, double, __int64');
    assert.deepEqual(mangledCall('?f@@YGXPAUthing@@0@Z'), { convention: 'stdcall', argBytes: 8 },
        'the second parameter refers back to the first');
    assert.deepEqual(mangledCall('?f@@YGXP6AXH@Z_N@Z'), { convention: 'stdcall', argBytes: 8 },
        'a pointer to a function is a pointer, and a bool is pushed as a dword');
    assert.deepEqual(mangledCall('?_RunAndWait@_StructuredTaskCollection@details@Concurrency@@'
        + 'QAG?AW4_TaskCollectionStatus@23@PAV_UnrealizedChore@23@@Z'),
    { convention: 'stdcall', argBytes: 8 }, 'a stdcall member pushes its `this` too');
});

test('fastcall pops only what did not fit in ECX and EDX', ()=>{
    assert.deepEqual(mangledCall('?f@@YIXHHH@Z'), { convention: 'fastcall', argBytes: 4 });
    assert.deepEqual(mangledCall('?f@@YIX_JH@Z'), { convention: 'fastcall', argBytes: 8 },
        'a 64-bit value never goes in a register');
});

test('a cdecl function pops nothing, whatever its parameters', ()=>{
    assert.deepEqual(mangledCall('??2@YAPAXI@Z'), { convention: 'cdecl', argBytes: 0 },
        'operator new');
    assert.deepEqual(mangledCall('?f@@YAXHZZ'), { convention: 'cdecl', argBytes: 0 }, 'varargs');
    assert.deepEqual(mangledCall('?_Current_get@sys@tr2@std@@YAPADAAY0BAE@D@Z'),
        { convention: 'cdecl', argBytes: 0 }, 'even with a parameter this does not read');
});

test('what the name does not carry is not known', ()=>{
    assert.deepEqual(mangledCall('?f@@YGXVthing@@@Z'), { convention: 'stdcall', argBytes: null },
        'a class passed by value');
    assert.deepEqual(mangledCall('?f@@YG?AUthing@@XZ'), { convention: 'stdcall', argBytes: null },
        'a class returned by value from a free function may come back in registers');
    // A class with virtual bases passes its constructor one more argument than
    // the name has, and nothing in the name says which classes do.
    assert.deepEqual(mangledCall('??0exception@@QAE@ABQBD@Z'),
        { convention: 'thiscall', argBytes: null });
});

test('a name that is not a decorated function is not read as one', ()=>{
    assert.equal(mangledCall('_Sleep@4'), null);
    assert.equal(mangledCall('printf'), null);
    assert.equal(mangledCall('?_Min_int@?$numeric_limits@H@std@@2HB'), null, 'a data member');
    assert.equal(mangledCall('??_7type_info@@6B@'), null, 'a vtable');
    assert.equal(mangledCall('?f@@Y'), null, 'cut short before the convention');
    assert.deepEqual(mangledCall('?f@@YG'), { convention: 'stdcall', argBytes: null },
        'and after it');
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesiseProcessInit, DLL_PROCESS_ATTACH } from './init.js';

/** Reads a little-endian dword out of the emitted code. */
const u32At = (/** @type {Uint8Array} */ bytes, /** @type {number} */ at)=>
    bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24;

/** @param {string} name @param {number} base */
function library(name, base){
    return { name, base, entryPoint: base + 0x1000 };
}

test('each library is attached, in the order it was given', ()=>{
    const { bytes, attached } = synthesiseProcessInit({
        libraries: [library('msacm32.dll', 0x03000000), library('fmod.dll', 0x03100000)],
        entryPoint: 0x00401000,
    });

    assert.deepEqual(attached, ['msacm32.dll', 'fmod.dll'],
        'a dependency is attached before what depends on it');

    // push 1 / push 1 / push hinst / mov eax, DllMain / call eax, twice.
    assert.deepEqual([...bytes.subarray(0, 4)], [0x6a, 0x01, 0x6a, DLL_PROCESS_ATTACH]);
    assert.equal(bytes[4], 0x68);
    assert.equal(u32At(bytes, 5), 0x03000000, 'hinstDLL is the base it was mapped at');
    assert.equal(bytes[9], 0xb8);
    assert.equal(u32At(bytes, 10), 0x03001000);
    assert.deepEqual([...bytes.subarray(14, 16)], [0xff, 0xd0]);

    assert.equal(u32At(bytes, 5 + 16), 0x03100000, 'and the second one follows');
});

test('the last thing it does is enter the program', ()=>{
    const { bytes } = synthesiseProcessInit({ libraries: [], entryPoint: 0x00401234 });

    // With nothing to attach this is the whole stub: mov eax, entry / jmp eax.
    assert.equal(bytes.length, 7);
    assert.equal(bytes[0], 0xb8);
    assert.equal(u32At(bytes, 1), 0x00401234);
    assert.deepEqual([...bytes.subarray(5, 7)], [0xff, 0xe0]);
});

test('a library with no entry point is skipped, not called at zero', ()=>{
    // A library without DllMain is ordinary. Calling its base, or address zero,
    // would fault before the program ever started and blame the loader.
    const { bytes, attached } = synthesiseProcessInit({
        libraries: [
            { name: 'data.dll', base: 0x03000000, entryPoint: 0 },
            { name: 'also.dll', base: 0x03100000, entryPoint: 0x03100000 },
        ],
        entryPoint: 0x00401000,
    });

    assert.deepEqual(attached, []);
    assert.equal(bytes.length, 7, 'nothing but the jump to the program');
});

test('the arguments are the ones DllMain is declared to take', ()=>{
    // Wrong order here is not a crash: DllMain reads DLL_PROCESS_DETACH or a
    // nonsense reason and quietly does the opposite of attaching.
    const { bytes } = synthesiseProcessInit({
        libraries: [library('one.dll', 0x03000000)],
        entryPoint: 0x00401000,
    });

    // Pushed right to left, so the stack reads hinstDLL, fdwReason, lpvReserved.
    assert.notEqual(bytes[1], 0x00,
        'lpvReserved is pushed first, and says the library was linked against '
        + 'rather than loaded by name -- a library reads it and takes a '
        + 'different path for each');
    assert.equal(bytes[3], DLL_PROCESS_ATTACH, 'then the reason');
    assert.equal(u32At(bytes, 5), 0x03000000, 'then the handle, which is the base');
});

test('the loader lock is held from before the first DllMain to the jump into the program', ()=>{
    const lock = { address: 0x00500000, enter: 0x00600000, leave: 0x00600100 };
    const { bytes } = synthesiseProcessInit({
        libraries: [library('one.dll', 0x03000000)],
        entryPoint: 0x00401000,
        loaderLock: lock,
    });

    // push lock / mov eax, EnterCriticalSection / call eax, first.
    assert.equal(bytes[0], 0x68);
    assert.equal(u32At(bytes, 1), lock.address);
    assert.equal(bytes[5], 0xb8);
    assert.equal(u32At(bytes, 6), lock.enter);
    assert.deepEqual([...bytes.subarray(10, 12)], [0xff, 0xd0]);
    assert.equal(u32At(bytes, 12 + 5), 0x03000000, 'then the library, as without one');

    // And the same with LeaveCriticalSection just before the program's entry.
    const tail = bytes.length - 7 - 12;
    assert.equal(u32At(bytes, tail + 1), lock.address);
    assert.equal(u32At(bytes, tail + 6), lock.leave);
    assert.equal(u32At(bytes, bytes.length - 6), 0x00401000);
});

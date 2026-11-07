/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBcryptFunctions, createBcryptPrimitivesFunctions } from './functions.js';

const STATUS_INVALID_HANDLE = 0xc0000008 | 0;
const STATUS_INVALID_PARAMETER = 0xc000000d | 0;
const STATUS_NOT_FOUND = 0xc0000225 | 0;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG = 2;

function machine(){
    const memory = new Uint8Array(0x1000);
    const fns = createBcryptFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readMemory: (address, length)=>memory.subarray(address, address + length),
    });
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>memory.set(
        new Uint8Array(Uint16Array.from(`${text}\0`, c=>c.charCodeAt(0)).buffer), at);
    return { memory, fns, putWide, view: new DataView(memory.buffer) };
}

test('BCryptGenRandom fills a buffer from the system generator the flag names', ()=>{
    // Wine's bcrypt test_BCryptGenRandom: the flag with no handle is the
    // system's generator; no flag and no handle is no generator at all.
    const { memory, fns } = machine();
    assert.equal(fns.BCryptGenRandom.argBytes, 16);
    assert.equal(fns.BCryptGenRandom.handler([0, 0x100, 64, BCRYPT_USE_SYSTEM_PREFERRED_RNG]), 0);
    assert.ok(memory.subarray(0x100, 0x140).some(byte=>byte !== 0), 'random bytes were written');
    assert.equal(memory[0x140], 0, 'and nothing past the count');
    assert.equal(fns.BCryptGenRandom.handler([0, 0x100, 64, 0]), STATUS_INVALID_HANDLE);
    assert.equal(fns.BCryptGenRandom.handler([0, 0, 0, BCRYPT_USE_SYSTEM_PREFERRED_RNG]),
        STATUS_INVALID_PARAMETER, 'no buffer, even for no bytes');
});

test('an RNG algorithm handle names the same generator; other algorithms are not found', ()=>{
    const { memory, fns, putWide, view } = machine();
    putWide(0x200, 'RNG');
    assert.equal(fns.BCryptOpenAlgorithmProvider.handler([0x300, 0x200, 0, 0]), 0);
    const handle = view.getUint32(0x300, true);
    assert.notEqual(handle, 0);
    assert.equal(fns.BCryptGenRandom.handler([handle, 0x100, 16, 0]), 0);
    assert.ok(memory.subarray(0x100, 0x110).some(byte=>byte !== 0));
    assert.equal(fns.BCryptGenRandom.handler([handle, 0x100, 16, BCRYPT_USE_SYSTEM_PREFERRED_RNG]),
        STATUS_INVALID_PARAMETER, 'a handle and the flag together');
    // Windows 10's pseudo-handle for the generator needs no opening.
    assert.equal(fns.BCryptGenRandom.handler([0x81, 0x100, 16, 0]), 0);
    assert.equal(fns.BCryptCloseAlgorithmProvider.handler([handle, 0]), 0);
    assert.equal(fns.BCryptGenRandom.handler([handle, 0x100, 16, 0]), STATUS_INVALID_HANDLE,
        'a closed handle');
    assert.equal(fns.BCryptCloseAlgorithmProvider.handler([handle, 0]), STATUS_INVALID_HANDLE);

    putWide(0x200, 'SHA512');
    assert.equal(fns.BCryptOpenAlgorithmProvider.handler([0x300, 0x200, 0, 0]), STATUS_NOT_FOUND);
    assert.equal(fns.BCryptOpenAlgorithmProvider.handler([0, 0x200, 0, 0]),
        STATUS_INVALID_PARAMETER);
});

test('ProcessPrng fills the buffer and cannot fail', ()=>{
    const memory = new Uint8Array(0x400);
    const fns = createBcryptPrimitivesFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readMemory: (address, length)=>memory.subarray(address, address + length),
    });
    assert.equal(fns.ProcessPrng.handler([0x100, 32]), 1);
    assert.ok(memory.subarray(0x100, 0x120).some(byte=>byte !== 0));
    assert.equal(memory[0x120], 0, 'nothing past the count');
    assert.equal(fns.ProcessPrng.handler([0, 0]), 1, 'no bytes is TRUE too');
});

/** @param {Uint8Array} bytes */
const hex = bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join('');

test('a hash: its lengths asked by property, its data, its digest', ()=>{
    const { memory, fns, putWide, view } = machine();
    putWide(0x100, 'SHA1');
    assert.equal(fns.BCryptOpenAlgorithmProvider.handler([0x10, 0x100, 0, 0]), 0);
    const algorithm = view.getUint32(0x10, true);
    putWide(0x140, 'HashDigestLength');
    assert.equal(fns.BCryptGetProperty.handler([algorithm, 0x140, 0, 0, 0x18, 0]), 0);
    assert.equal(view.getUint32(0x18, true), 4, 'the size needed, with no buffer');
    assert.equal(fns.BCryptGetProperty.handler([algorithm, 0x140, 0x1c, 2, 0x18, 0]) >>> 0,
        0xc0000023, 'STATUS_BUFFER_TOO_SMALL');
    assert.equal(fns.BCryptGetProperty.handler([algorithm, 0x140, 0x1c, 4, 0x18, 0]), 0);
    assert.equal(view.getUint32(0x1c, true), 20);
    putWide(0x180, 'ObjectLength');
    assert.equal(fns.BCryptGetProperty.handler([algorithm, 0x180, 0x1c, 4, 0x18, 0]), 0);
    assert.ok(view.getUint32(0x1c, true) > 0);
    putWide(0x1c0, 'KeyLengths');
    assert.equal(fns.BCryptGetProperty.handler([algorithm, 0x1c0, 0x1c, 4, 0x18, 0]) >>> 0,
        0xc00000bb, 'STATUS_NOT_SUPPORTED');

    assert.equal(fns.BCryptCreateHash.handler([algorithm, 0x20, 0, 0, 0, 0, 0]), 0);
    const hash = view.getUint32(0x20, true);
    memory.set(Uint8Array.from('test', c=>c.charCodeAt(0)), 0x200);
    assert.equal(fns.BCryptHashData.handler([hash, 0x200, 2, 0]), 0);
    assert.equal(fns.BCryptHashData.handler([hash, 0x202, 2, 0]), 0);
    assert.equal(fns.BCryptFinishHash.handler([hash, 0x300, 16, 0]), STATUS_INVALID_PARAMETER,
        'not the digest\'s length');
    assert.equal(fns.BCryptFinishHash.handler([hash, 0x300, 20, 0]), 0);
    assert.equal(hex(memory.subarray(0x300, 0x314)), 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3');
    assert.equal(fns.BCryptHashData.handler([hash, 0x200, 4, 0]), STATUS_INVALID_HANDLE,
        'finished, it takes no more');
    assert.equal(fns.BCryptDestroyHash.handler([hash]), 0);
    assert.equal(fns.BCryptGenRandom.handler([algorithm, 0x400, 4, 0]), STATUS_INVALID_HANDLE,
        'a hash is not a generator');
    assert.equal(fns.BCryptCloseAlgorithmProvider.handler([algorithm, 0]), 0);
});

test('an algorithm opened for an HMAC keys its hashes by the secret', ()=>{
    const { memory, fns, putWide, view } = machine();
    putWide(0x100, 'SHA1');
    assert.equal(fns.BCryptOpenAlgorithmProvider.handler([0x10, 0x100, 0, 8]), 0);
    memory.set(Uint8Array.from('key', c=>c.charCodeAt(0)), 0x200);
    assert.equal(fns.BCryptCreateHash.handler([view.getUint32(0x10, true), 0x20, 0, 0,
        0x200, 3, 0]), 0);
    const text = 'The quick brown fox jumps over the lazy dog';
    memory.set(Uint8Array.from(text, c=>c.charCodeAt(0)), 0x400);
    const hash = view.getUint32(0x20, true);
    assert.equal(fns.BCryptHashData.handler([hash, 0x400, text.length, 0]), 0);
    assert.equal(fns.BCryptFinishHash.handler([hash, 0x300, 20, 0]), 0);
    assert.equal(hex(memory.subarray(0x300, 0x314)), 'de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9');
    putWide(0x140, 'SHA384');
    assert.equal(fns.BCryptOpenAlgorithmProvider.handler([0x10, 0x140, 0, 0]), STATUS_NOT_FOUND);
});

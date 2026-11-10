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

/** @param {string} text */
const bytesOf = text=>Uint8Array.from(text.match(/../g) ?? [], byte=>parseInt(byte, 16));

/**
 * An AES key of `secret` (hex) in a fresh machine; the algorithm's handle and the key's.
 *
 * @param {string} secret
 */
function aesKey(secret){
    const m = machine();
    m.putWide(0x200, 'AES');
    assert.equal(m.fns.BCryptOpenAlgorithmProvider.handler([0x300, 0x200, 0, 0]), 0);
    const algorithm = m.view.getUint32(0x300, true);
    m.memory.set(bytesOf(secret), 0x400);
    assert.equal(m.fns.BCryptGenerateSymmetricKey.handler(
        [algorithm, 0x304, 0, 0, 0x400, secret.length / 2, 0]), 0);
    return { ...m, algorithm, key: m.view.getUint32(0x304, true) };
}

test('an AES key in CBC enciphers SP 800-38A\'s vectors, the IV left on the chain', ()=>{
    // NIST SP 800-38A F.2.1, CBC-AES128.Encrypt, its first two blocks.
    const { memory, fns, view, key } = aesKey('2b7e151628aed2a6abf7158809cf4f3c');
    memory.set(bytesOf('000102030405060708090a0b0c0d0e0f'), 0x500);
    memory.set(bytesOf('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51'), 0x600);
    assert.equal(fns.BCryptEncrypt.handler([key, 0x600, 32, 0, 0x500, 16, 0x700, 32, 0x800, 0]), 0);
    assert.equal(view.getUint32(0x800, true), 32);
    assert.equal(hex(memory.subarray(0x700, 0x720)),
        '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2');
    assert.equal(hex(memory.subarray(0x500, 0x510)), '5086cb9b507219ee95db113a917678b2',
        'the IV is the last cipher block');

    memory.set(bytesOf('000102030405060708090a0b0c0d0e0f'), 0x500);
    assert.equal(fns.BCryptDecrypt.handler([key, 0x700, 32, 0, 0x500, 16, 0x900, 32, 0x800, 0]), 0);
    assert.equal(hex(memory.subarray(0x900, 0x920)),
        '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51');
});

test('BCRYPT_BLOCK_PADDING pads with PKCS #7 and takes it off; a size is asked with no buffer',
    ()=>{
        const { memory, fns, view, key, putWide, algorithm } = aesKey(
            '000102030405060708090a0b0c0d0e0f');
        // ECB, set on the key itself.
        putWide(0x280, 'ChainingMode');
        putWide(0x2c0, 'ChainingModeECB');
        assert.equal(fns.BCryptSetProperty.handler([key, 0x280, 0x2c0, 32, 0]), 0);
        memory.set(new TextEncoder().encode('hello'), 0x600);
        assert.equal(fns.BCryptEncrypt.handler([key, 0x600, 5, 0, 0, 0, 0, 0, 0x800, 1]), 0);
        assert.equal(view.getUint32(0x800, true), 16, 'five bytes padded to a block');
        assert.equal(fns.BCryptEncrypt.handler([key, 0x600, 5, 0, 0, 0, 0x700, 16, 0x800, 1]), 0);
        assert.equal(fns.BCryptDecrypt.handler([key, 0x700, 16, 0, 0, 0, 0x900, 16, 0x800, 1]), 0);
        assert.equal(view.getUint32(0x800, true), 5);
        assert.equal(new TextDecoder().decode(memory.subarray(0x900, 0x905)), 'hello');
        assert.equal(fns.BCryptEncrypt.handler([key, 0x600, 5, 0, 0, 0, 0x700, 16, 0x800, 0]),
            0xc0000206 | 0, 'no padding: whole blocks only');
        putWide(0x2c0, 'ChainingModeGCM');
        assert.equal(fns.BCryptSetProperty.handler([algorithm, 0x280, 0x2c0, 32, 0]),
            0xc00000bb | 0, 'a mode not kept is not supported');
    });

test('a duplicated key and hash go on apart from their originals', ()=>{
    const { memory, fns, view, key } = aesKey('000102030405060708090a0b0c0d0e0f');
    assert.equal(fns.BCryptDuplicateKey.handler([key, 0x310, 0, 0, 0]), 0);
    const copy = view.getUint32(0x310, true);
    assert.notEqual(copy, key);
    assert.equal(fns.BCryptDestroyKey.handler([key]), 0);
    memory.set(bytesOf('00112233445566778899aabbccddeeff'), 0x600);
    assert.equal(fns.BCryptSetProperty.handler([copy, 0, 0, 0, 0]), STATUS_INVALID_PARAMETER);
    assert.equal(fns.BCryptEncrypt.handler([copy, 0x600, 16, 0, 0, 0, 0x700, 16, 0x800, 0]), 0);
    // FIPS 197 C.1, the zero IV in CBC making it the bare block.
    assert.equal(hex(memory.subarray(0x700, 0x710)), '69c4e0d86a7b0430d8cdb78070b4c55a');
    assert.equal(fns.BCryptDestroyKey.handler([key]), STATUS_INVALID_HANDLE);

    const hashing = machine();
    hashing.putWide(0x200, 'SHA256');
    hashing.fns.BCryptOpenAlgorithmProvider.handler([0x300, 0x200, 0, 0]);
    const sha = hashing.view.getUint32(0x300, true);
    hashing.fns.BCryptCreateHash.handler([sha, 0x304, 0, 0, 0, 0, 0]);
    const hash = hashing.view.getUint32(0x304, true);
    hashing.memory.set(new TextEncoder().encode('abc'), 0x400);
    hashing.fns.BCryptHashData.handler([hash, 0x400, 3, 0]);
    assert.equal(hashing.fns.BCryptDuplicateHash.handler([hash, 0x308, 0, 0, 0]), 0);
    const twin = hashing.view.getUint32(0x308, true);
    hashing.fns.BCryptHashData.handler([hash, 0x400, 3, 0]);
    assert.equal(hashing.fns.BCryptFinishHash.handler([twin, 0x500, 32, 0]), 0);
    assert.equal(hex(hashing.memory.subarray(0x500, 0x520)),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        'SHA-256("abc"): the twin did not see the original\'s second update');
});

test('an AES key imported from a BCRYPT_KEY_DATA_BLOB enciphers as one generated, and exports'
    + ' as the same blob', ()=>{
    const { memory, fns, view, putWide, algorithm } = aesKey('000102030405060708090a0b0c0d0e0f');
    // 'KDBM', version 1, 16 bytes, the key: FIPS 197 C.1's.
    const blob = new Uint8Array(28);
    new DataView(blob.buffer).setUint32(0, 0x4d42444b, true);
    new DataView(blob.buffer).setUint32(4, 1, true);
    new DataView(blob.buffer).setUint32(8, 16, true);
    blob.set(bytesOf('000102030405060708090a0b0c0d0e0f'), 12);
    memory.set(blob, 0xa00);
    putWide(0x280, 'KeyDataBlob');
    assert.equal(fns.BCryptImportKey.handler([algorithm, 0, 0x280, 0x320, 0, 0, 0xa00, 28, 0]), 0);
    const imported = view.getUint32(0x320, true);
    putWide(0x2c0, 'ChainingMode');
    putWide(0x2e0, 'ChainingModeECB');
    assert.equal(fns.BCryptSetProperty.handler([imported, 0x2c0, 0x2e0, 32, 0]), 0);
    memory.set(bytesOf('00112233445566778899aabbccddeeff'), 0x600);
    assert.equal(fns.BCryptEncrypt.handler([imported, 0x600, 16, 0, 0, 0, 0x700, 16, 0x800, 0]), 0);
    assert.equal(hex(memory.subarray(0x700, 0x710)), '69c4e0d86a7b0430d8cdb78070b4c55a');
    assert.equal(fns.BCryptExportKey.handler([imported, 0, 0x280, 0, 0, 0x800, 0]), 0);
    assert.equal(view.getUint32(0x800, true), 28, 'the blob\'s size, asked with no buffer');
    assert.equal(fns.BCryptExportKey.handler([imported, 0, 0x280, 0xb00, 28, 0x800, 0]), 0);
    assert.deepEqual([...memory.subarray(0xb00, 0xb1c)], [...blob]);
    memory[0xa04] = 2;
    assert.equal(fns.BCryptImportKey.handler([algorithm, 0, 0x280, 0x320, 0, 0, 0xa00, 28, 0]),
        STATUS_INVALID_PARAMETER, 'a version that is not 1');
    assert.equal(fns.BCryptGenerateKeyPair.handler(),
        STATUS_INVALID_HANDLE, 'no key pair: no such algorithm opens');
});

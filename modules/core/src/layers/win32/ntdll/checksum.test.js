/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChecksumFunctions, crc32 } from './checksum.js';

const ascii = (/** @type {string} */ text)=>new Uint8Array([...text].map(c=>c.charCodeAt(0)));

test('the CRC-32 of "123456789" is the standard check value, and two pieces continue', ()=>{
    assert.equal(crc32(0, ascii('123456789')), 0xcbf43926);
    assert.equal(crc32(crc32(0, ascii('1234')), ascii('56789')), 0xcbf43926);
    assert.equal(crc32(0, new Uint8Array(0)), 0);
});

test('RtlComputeCrc32 reads the caller\'s bytes; no length is no bytes', ()=>{
    const memory = new Uint8Array(0x100);
    memory.set(ascii('123456789'), 0x10);
    const { RtlComputeCrc32 } = createChecksumFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
    });
    assert.equal(RtlComputeCrc32.handler([0, 0x10, 9]), 0xcbf43926);
    assert.equal(RtlComputeCrc32.handler([0x1234, 0x10, 0]), 0x1234);
});

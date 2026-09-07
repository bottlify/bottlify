/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GUID_NULL,
    GUID_SIZE,
    canonicalGuid,
    formatGuid,
    parseGuid,
    readGuid,
    writeGuid,
} from './guid.js';

/**
 * The GUID Microsoft's own documentation uses as its worked example, and the
 * only one here whose every field is non-zero -- which is what makes it able to
 * catch a byte order mistake at all.
 */
const EXAMPLE = '{6B29FC40-CA47-1067-B31D-00DD010662DA}';

/**
 * How Windows actually stores it. The first eight bytes are byte-swapped
 * against the way they are printed and the last eight are not; a flat
 * hex-string decode would produce 6B 29 FC 40 ... and match nothing.
 */
const EXAMPLE_BYTES = Uint8Array.from([
    0x40, 0xfc, 0x29, 0x6b,
    0x47, 0xca,
    0x67, 0x10,
    0xb3, 0x1d, 0x00, 0xdd, 0x01, 0x06, 0x62, 0xda,
]);

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IUNKNOWN_BYTES = Uint8Array.from([
    0, 0, 0, 0, 0, 0, 0, 0,
    0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]);

/** Guest memory as a flat array, the way the other win32 fixtures model it. */
function fakeMemory(size = 0x200){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
    };
}

test('formatGuid decodes Data1..Data3 little-endian and Data4 raw', ()=>{
    assert.equal(formatGuid(EXAMPLE_BYTES), EXAMPLE);
    assert.equal(formatGuid(IID_IUNKNOWN_BYTES), IID_IUNKNOWN);
});

test('parseGuid encodes Data1..Data3 little-endian and Data4 raw', ()=>{
    assert.deepEqual(parseGuid(EXAMPLE), EXAMPLE_BYTES);
    assert.deepEqual(parseGuid(IID_IUNKNOWN), IID_IUNKNOWN_BYTES);
});

test('the first byte of the encoding is the last byte of Data1', ()=>{
    const bytes = /** @type {Uint8Array} */ (parseGuid(EXAMPLE));
    assert.equal(bytes[0], 0x40);
    assert.equal(bytes[3], 0x6b);
    // Data4 is the half that is stored exactly as it is printed.
    assert.equal(bytes[8], 0xb3);
    assert.equal(bytes[15], 0xda);
});

test('string and bytes round-trip in both directions', ()=>{
    assert.equal(formatGuid(/** @type {Uint8Array} */ (parseGuid(EXAMPLE))), EXAMPLE);
    assert.deepEqual(parseGuid(formatGuid(EXAMPLE_BYTES)), EXAMPLE_BYTES);
    assert.deepEqual(parseGuid(GUID_NULL), new Uint8Array(GUID_SIZE));
    assert.equal(formatGuid(new Uint8Array(GUID_SIZE)), GUID_NULL);
});

test('parsing accepts either case and canonicalises to upper', ()=>{
    assert.deepEqual(parseGuid(EXAMPLE.toLowerCase()), EXAMPLE_BYTES);
    assert.equal(canonicalGuid(EXAMPLE.toLowerCase()), EXAMPLE);
    assert.equal(canonicalGuid(EXAMPLE), EXAMPLE);
});

test('parsing rejects anything that is not the canonical form', ()=>{
    // The braces are part of it: this is the shape CLSIDFromString takes.
    assert.equal(parseGuid(EXAMPLE.slice(1, -1)), null);
    assert.equal(parseGuid(''), null);
    assert.equal(parseGuid('{6B29FC40-CA47-1067-B31D-00DD010662D}'), null);
    assert.equal(parseGuid('{6B29FC40-CA47-1067-B31D-00DD010662DAA}'), null);
    assert.equal(parseGuid('{6B29FC4G-CA47-1067-B31D-00DD010662DA}'), null);
    assert.equal(parseGuid('{6B29FC40CA471067B31D00DD010662DA}'), null);
    assert.equal(parseGuid(` ${EXAMPLE}`), null);
    assert.equal(canonicalGuid('not a guid'), null);
});

test('a GUID read back from guest memory is the one that was written', ()=>{
    const memory = fakeMemory();
    assert.equal(writeGuid(memory, 0x40, EXAMPLE), true);
    assert.deepEqual(memory.bytes.subarray(0x40, 0x40 + GUID_SIZE), EXAMPLE_BYTES);
    assert.equal(readGuid(memory, 0x40), EXAMPLE);
});

test('writing a malformed GUID touches no memory', ()=>{
    const memory = fakeMemory();
    memory.bytes.fill(0xa5);
    assert.equal(writeGuid(memory, 0x40, 'nonsense'), false);
    assert.ok(memory.bytes.every(byte=>byte === 0xa5));
});

test('reading is offset-correct: a GUID does not have to start at zero', ()=>{
    const memory = fakeMemory();
    memory.bytes.set(EXAMPLE_BYTES, 0x33);
    assert.equal(readGuid(memory, 0x33), EXAMPLE);
});

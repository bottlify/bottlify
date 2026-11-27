/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSecurityAttributes } from './security-attributes.js';

/** A memory of `bytes` at `base`. @param {number} base @param {number[]} bytes */
const memory = (base, bytes)=>(/** @type {number} */ at, /** @type {number} */ length)=>
    Uint8Array.from(bytes.slice(at - base, at - base + length));

test('a 32-bit SECURITY_ATTRIBUTES has its descriptor at 4 and its flag at 8', ()=>{
    const read = memory(0x1000, [12, 0, 0, 0, 0x78, 0x56, 0x34, 0x12, 1, 0, 0, 0]);
    assert.deepEqual(readSecurityAttributes(read, 0x1000),
        { descriptor: 0x12345678, inherit: true });
    assert.deepEqual(readSecurityAttributes(read, 0x1000, 4),
        { descriptor: 0x12345678, inherit: true });
});

test('a 64-bit SECURITY_ATTRIBUTES has its descriptor at 8 and its flag at 16', ()=>{
    // nLength 24, padding, a descriptor of none, bInheritHandle TRUE: what
    // a 64-bit process passes for an inheritable pipe or event.
    const inheriting = memory(0x2000, [24, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(readSecurityAttributes(inheriting, 0x2000, 8),
        { descriptor: 0, inherit: true });
    // The descriptor whole, its high dword too; the padding is not the flag.
    const described = memory(0x2000, [24, 0, 0, 0, 0xff, 0xff, 0xff, 0xff,
        0x00, 0x10, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(readSecurityAttributes(described, 0x2000, 8),
        { descriptor: 0x100001000, inherit: false });
});

test('a null SECURITY_ATTRIBUTES is no structure', ()=>{
    assert.equal(readSecurityAttributes(()=>{
        throw new Error('read');
    }, 0, 8), null);
});

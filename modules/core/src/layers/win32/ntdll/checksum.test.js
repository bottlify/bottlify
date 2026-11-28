/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { createChecksumFunctions } from './checksum.js';

const ascii = (/** @type {string} */ text)=>new Uint8Array([...text].map(c=>c.charCodeAt(0)));

test('RtlComputeCrc32 reads the caller\'s bytes and continues from its initial value', ()=>{
    const memory = new Uint8Array(0x100);
    memory.set(ascii('123456789'), 0x10);
    const { RtlComputeCrc32 } = createChecksumFunctions({ guest: guestOver(memory) });
    assert.equal(RtlComputeCrc32.handler([0, 0x10, 9]), 0xcbf43926);
    assert.equal(RtlComputeCrc32.handler([RtlComputeCrc32.handler([0, 0x10, 4]), 0x14, 5]),
        0xcbf43926);
});

test('RtlComputeCrc32 of no length, or a negative one, is no bytes: its initial value', ()=>{
    // No memory at 0x10: a read there would fault.
    const { RtlComputeCrc32 } = createChecksumFunctions({ guest: guestOver(new Uint8Array(0x10)) });
    assert.equal(RtlComputeCrc32.handler([0, 0x10, 0]), 0);
    assert.equal(RtlComputeCrc32.handler([0x1234, 0x10, 0]), 0x1234);
    assert.equal(RtlComputeCrc32.handler([0x1234, 0x10, -1]), 0x1234);
});

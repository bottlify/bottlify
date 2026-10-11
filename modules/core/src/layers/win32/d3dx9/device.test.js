/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceCalls } from './device.js';

test('a string near the end of its region is read to its NUL, not past the region', ()=>{
    // An effect parameter's name on the stack's last page: a fixed 4 KB read
    // from it ran past the stack and faulted the call.
    const memory = new Uint8Array(0x3000);
    const end = memory.length;
    const host = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>{
            if (at + length > end)
            {
                throw new Error(`read of ${length} bytes at 0x${at.toString(16)} runs past`);
            }
            return memory.slice(at, at + length);
        },
        writeMemory: ()=>{},
    };
    const { string } = createDeviceCalls(/** @type {any} */ (host));
    const at = end - 6;
    memory.set([0x6c, 0x69, 0x67, 0x68, 0x74, 0], at);
    assert.equal(string(at), 'light');
    memory.set([0x61, 0, 0x62, 0, 0, 0], at);
    assert.equal(string(at, true), 'ab');
    // A string the region cuts before its NUL ends with the region.
    memory.set([0x61, 0x62, 0x63, 0x64, 0x65, 0x66], at);
    assert.equal(string(at), 'abcdef');
    // One that crosses a page boundary inside the region reads on.
    memory.set([0x78, 0x79, 0x7a, 0], 0x1ffe);
    assert.equal(string(0x1ffe), 'xyz');
    assert.throws(()=>string(end + 0x100), /runs past/, 'an address outside is the caller\'s fault');
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestMemory } from './guest-code.js';

test('fill over a host with no fillMemory writes the program\'s count a chunk at a time', ()=>{
    // memset handed a count of tens of megabytes: a buffer of that count made
    // on the host is the host's memory grown by it for one call.
    const size = 32 << 20;
    const bytes = new Uint8Array(size + 0x1000);
    let largest = 0;
    const guest = guestMemory({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>{
            largest = Math.max(largest, data.length);
            bytes.set(data, address);
        },
    });
    const before = process.memoryUsage().arrayBuffers;
    guest.fill(0x800, 0x1ab, size);
    const grown = process.memoryUsage().arrayBuffers - before;
    assert.equal(bytes[0x7ff], 0, 'nothing before it');
    assert.ok(bytes.subarray(0x800, 0x800 + size).every(byte=>byte === 0xab),
        'the low byte, all of it');
    assert.equal(bytes[0x800 + size], 0, 'nothing past it');
    assert.ok(largest <= 0x10000, `written ${largest} bytes at once`);
    assert.ok(grown < 4 << 20, `the host grew by ${grown} bytes`);
    assert.throws(()=>guestMemory({ readMemory: ()=>new Uint8Array(0),
        writeMemory: ()=>{
            throw new Error('Unmapped write');
        } }).fill(0x10, 0, size), /Unmapped write/, 'a destination not there faults');
});

test('a long copy moves a chunk at a time, overlapping either way as the byte loop does', ()=>{
    const length = 0x30000 + 17;
    for (const [from, to] of [[0x100, 0x100 + 1000], [0x100 + 1000, 0x100], [0x100, 0x80000]])
    {
        const bytes = new Uint8Array(0x100000);
        bytes.forEach((_, i)=>{
            bytes[i] = i * 7 & 0xff;
        });
        const expected = bytes.slice();
        expected.copyWithin(to, from, from + length);
        let largest = 0;
        const guest = guestMemory({
            readMemory: (address, size)=>bytes.slice(address, address + size),
            writeMemory: (address, data)=>{
                largest = Math.max(largest, data.length);
                bytes.set(data, address);
            },
        });
        (to > from ? guest.copyDown : guest.copyUp)(to, from, length);
        assert.deepEqual(bytes, expected, `${from} to ${to}`);
        assert.ok(largest <= 0x10000, `${from} to ${to}: written ${largest} bytes at once`);
    }
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SOCKADDR_IN_SIZE, addressKey, formatAddress, parseAddress,
    readSockaddr, swap16, swap32, writeSockaddr,
} from './sockaddr.js';
import { AF_INET, INADDR_NONE } from './constants.js';

/** Guest memory as a flat array, as the other win32 tests model it. */
function fakeMemory(size = 0x100){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
    };
}

test('a sockaddr written and read back is the same address', ()=>{
    const memory = fakeMemory();
    writeSockaddr(memory.writeMemory, 0x20, { host: 0x7f000001, port: 6112 });

    const read = readSockaddr(memory.readMemory, 0x20);
    assert.deepEqual(read, { family: AF_INET, host: 0x7f000001, port: 6112 });
});

test('the port and address are big-endian in the structure, the family is not', ()=>{
    // The one place byte order is not a matter of taste: a sockaddr carries the
    // family in host order and everything after it in network order, and a
    // structure that got this uniform would work only against itself.
    const memory = fakeMemory();
    writeSockaddr(memory.writeMemory, 0, { host: 0x01020304, port: 0x1234 });

    assert.deepEqual([...memory.bytes.subarray(0, 8)],
        [AF_INET, 0, 0x12, 0x34, 0x01, 0x02, 0x03, 0x04]);
    assert.deepEqual([...memory.bytes.subarray(8, SOCKADDR_IN_SIZE)], [0, 0, 0, 0, 0, 0, 0, 0],
        'the tail is zeroed, because a caller may compare whole structures');
});

test('a null pointer is not an address', ()=>{
    const memory = fakeMemory();
    assert.equal(readSockaddr(memory.readMemory, 0), null);
});

test('inet_addr accepts the short forms, because programs use them', ()=>{
    assert.equal(parseAddress('127.0.0.1'), 0x7f000001);
    assert.equal(parseAddress('127.1'), 0x7f000001, '"127.1" is 127.0.0.1');
    assert.equal(parseAddress('127.0.1'), 0x7f000001);
    assert.equal(parseAddress('16909060'), 0x01020304, 'one part fills all four bytes');
    assert.equal(parseAddress('0.0.0.0'), 0);
});

test('what is not an address says so rather than becoming one', ()=>{
    for (const text of ['', 'localhost', '1.2.3.4.5', '1.2.3.256', '1.-2.3.4', '1.2.3.x'])
    {
        assert.equal(parseAddress(text), INADDR_NONE, `"${text}" should not parse`);
    }
});

test('an address formats back to what it parsed from', ()=>{
    for (const text of ['0.0.0.0', '127.0.0.1', '192.168.1.255', '255.255.255.255'])
    {
        assert.equal(formatAddress(parseAddress(text)), text);
    }
});

test('the byte swaps are their own inverse', ()=>{
    assert.equal(swap16(0x1234), 0x3412);
    assert.equal(swap16(swap16(0xabcd)), 0xabcd);
    assert.equal(swap32(0x01020304), 0x04030201);
    assert.equal(swap32(swap32(0xdeadbeef)), 0xdeadbeef);
    assert.equal(swap32(0xffffffff), 0xffffffff, 'and stay unsigned');
});

test('a stream and a datagram on one port are two different addresses', ()=>{
    // The separation that keeps a discovery datagram out of a stream that
    // happens to share its port number.
    const address = { host: 0x7f000001, port: 6112 };
    assert.notEqual(addressKey(true, address), addressKey(false, address));
});

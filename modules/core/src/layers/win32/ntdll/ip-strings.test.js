/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpStringFunctions, ipv4ToString, ipv6ToString, parseIpv4, parseIpv6 }
    from './ip-strings.js';

/** @param {string} text */
const v6 = text=>{
    const read = parseIpv6(text);
    assert.ok(!('error' in read), text);
    return ipv6ToString(/** @type {any} */ (read).bytes);
};

test('IPv4 reads strictly as four decimal parts, loosely as inet_addr does', ()=>{
    assert.deepEqual([.../** @type {any} */ (parseIpv4('192.168.0.1', true)).bytes],
        [192, 168, 0, 1]);
    assert.ok('error' in parseIpv4('192.168.1', true), 'three parts are not strict');
    assert.deepEqual([.../** @type {any} */ (parseIpv4('192.168.1', false)).bytes],
        [192, 168, 0, 1], 'the last part fills the rest');
    assert.deepEqual([.../** @type {any} */ (parseIpv4('0x7f.1', false)).bytes], [127, 0, 0, 1]);
    assert.deepEqual([.../** @type {any} */ (parseIpv4('010.0.0.1', false)).bytes], [8, 0, 0, 1],
        'a leading zero is octal');
    assert.ok('error' in parseIpv4('256.0.0.1', true));
    assert.equal(parseIpv4('1.2.3.4:80', true).end, 7, 'reading stops where the address does');
    assert.equal(ipv4ToString(Uint8Array.of(10, 0, 0, 255)), '10.0.0.255');
});

test('IPv6 writes its longest zero run as ::, and an IPv4 tail in dotted decimal', ()=>{
    assert.equal(v6('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
    assert.equal(v6('::'), '::');
    assert.equal(v6('::1'), '::1');
    assert.equal(v6('1:0:0:2:0:0:0:3'), '1:0:0:2::3', 'the longer run');
    assert.equal(v6('1:0:2:3:4:5:6:7'), '1:0:2:3:4:5:6:7', 'one zero group stays');
    assert.equal(v6('::ffff:1.2.3.4'), '::ffff:1.2.3.4');
    assert.equal(v6('::ffff:102:304'), '::ffff:1.2.3.4', 'mapped, however it was written');
    assert.ok('error' in parseIpv6('1::2::3'), 'two gaps');
    assert.ok('error' in parseIpv6('1:2:3:4:5:6:7'), 'seven groups and no gap');
});

test('the Ex forms write a port, and say the length a short buffer needs', ()=>{
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    const fns = createIpStringFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
    });
    memory.set([127, 0, 0, 1], 0x100);
    view.setUint32(0x200, 4, true);
    // Port 80 in network order.
    assert.equal(fns.RtlIpv4AddressToStringExA.handler([0x100, 0x5000, 0x300, 0x200]), 0xc000000d);
    assert.equal(view.getUint32(0x200, true), 13, '"127.0.0.1:80" and its terminator');
    assert.equal(fns.RtlIpv4AddressToStringExA.handler([0x100, 0x5000, 0x300, 0x200]), 0);
    assert.equal(new TextDecoder().decode(memory.subarray(0x300, 0x30c)), '127.0.0.1:80');

    memory.set(new TextEncoder().encode('[::1%3]:443\0'), 0x400);
    assert.equal(fns.RtlIpv6StringToAddressExA.handler([0x400, 0x500, 0x520, 0x530]), 0);
    assert.equal(memory[0x50f], 1);
    assert.equal(view.getUint32(0x520, true), 3, 'the scope');
    assert.equal(view.getUint16(0x530, false), 443, 'the port in network order');

    const end = fns.RtlIpv4AddressToStringA.handler([0x100, 0x600]);
    assert.equal(end, 0x600 + 9, 'the pointer to its terminator');
    assert.equal(memory[end], 0);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    HEADER_SIZE, MAX_PAYLOAD, Op, Wsa, decodeControl, decodeFrame, encodeControl,
    encodeFrame, formatIp, packAddresses, packError, parseIp, unpackAddresses,
    unpackError, wsaErrorFor,
} from './protocol.js';

test('a frame survives the round trip with every field intact', ()=>{
    const payload = new Uint8Array([1, 2, 3, 250, 255]);
    const frame = {
        op: Op.DATAGRAM,
        flags: 0x05,
        tag: 0xdeadbeef,
        fromIp: 0x0a560001,
        toIp: 0xffffffff,
        fromPort: 6112,
        toPort: 65535,
        payload,
    };
    const decoded = decodeFrame(encodeFrame(frame));
    assert.deepEqual(decoded, frame);
});

test('the header is exactly the documented size, so a payload starts where it says', ()=>{
    // The relay routes on the header and forwards the rest untouched, so the
    // boundary between them is a contract and not an implementation detail.
    const encoded = encodeFrame({ op: Op.STREAM, payload: new Uint8Array(7) });
    assert.equal(encoded.length, HEADER_SIZE + 7);
    assert.equal(HEADER_SIZE, 20);
});

test('an omitted field encodes as zero rather than as NaN', ()=>{
    const decoded = decodeFrame(encodeFrame({ op: Op.LISTEN }));
    assert.deepEqual(decoded, {
        op: Op.LISTEN, flags: 0, tag: 0, fromIp: 0, toIp: 0,
        fromPort: 0, toPort: 0, payload: new Uint8Array(0),
    });
});

test('a decoded payload does not alias the buffer it arrived in', ()=>{
    // The receive buffer is the transport's and gets reused; a payload that is a
    // view onto it turns into whatever the next frame put there.
    const encoded = encodeFrame({ op: Op.STREAM, payload: new Uint8Array([9, 9]) });
    const decoded = decodeFrame(encoded);
    encoded.fill(0);
    assert.deepEqual([...(decoded?.payload ?? [])], [9, 9]);
});

test('a full address is not truncated by a signed shift', ()=>{
    // 0xff... is negative as a signed 32-bit integer, and an encoder that lets
    // it stay that way writes a plausible-looking wrong address.
    const decoded = decodeFrame(encodeFrame({
        op: Op.DIAL, fromIp: 0xffffffff, toIp: 0x80000001, tag: 0xffffffff,
    }));
    assert.equal(decoded?.fromIp, 0xffffffff);
    assert.equal(decoded?.toIp, 0x80000001);
    assert.equal(decoded?.tag, 0xffffffff);
});

test('rubbish decodes to null instead of throwing', ()=>{
    assert.equal(decodeFrame(new Uint8Array(0)), null);
    assert.equal(decodeFrame(new Uint8Array(HEADER_SIZE - 1)), null);
    const unknownOp = encodeFrame({ op: Op.DIAL });
    unknownOp[0] = 99;
    assert.equal(decodeFrame(unknownOp), null, 'an op nobody implements is not a frame');
    unknownOp[0] = 0;
    assert.equal(decodeFrame(unknownOp), null);
});

test('a payload over the cap is refused rather than encoded', ()=>{
    assert.throws(()=>encodeFrame({ op: Op.STREAM, payload: new Uint8Array(MAX_PAYLOAD + 1) }),
        RangeError);
    assert.equal(decodeFrame(new Uint8Array(HEADER_SIZE + MAX_PAYLOAD + 1)), null);
});

test('addresses parse and print the way a dotted quad reads', ()=>{
    assert.equal(parseIp('10.86.0.1'), 0x0a560001);
    assert.equal(parseIp('255.255.255.255'), 0xffffffff);
    assert.equal(formatIp(0x0a560001), '10.86.0.1');
    assert.equal(formatIp(parseIp('192.168.1.20')), '192.168.1.20');
});

test('a malformed address is zero, not a number that happens to parse', ()=>{
    assert.equal(parseIp('10.86.0'), 0);
    assert.equal(parseIp('10.86.0.256'), 0);
    assert.equal(parseIp('10.86.0.1.2'), 0);
    assert.equal(parseIp('ten.86.0.1'), 0);
    assert.equal(parseIp(''), 0);
});

test('a resolver answer keeps its order and its full range', ()=>{
    const addresses = [0x0a000001, 0xc0a80001, 0xffffff00];
    assert.deepEqual(unpackAddresses(packAddresses(addresses)), addresses);
    assert.deepEqual(unpackAddresses(new Uint8Array(0)), []);
});

test('an error survives the wire, and its absence reads as no reason given', ()=>{
    assert.equal(unpackError(packError(Wsa.CONNREFUSED)), Wsa.CONNREFUSED);
    assert.equal(unpackError(new Uint8Array(0)), 0);
    assert.equal(unpackError(new Uint8Array(3)), 0);
});

test('a system error becomes the Winsock number a guest expects', ()=>{
    assert.equal(wsaErrorFor('ECONNREFUSED'), Wsa.CONNREFUSED);
    assert.equal(wsaErrorFor('ETIMEDOUT'), Wsa.TIMEDOUT);
    assert.equal(wsaErrorFor('ENOTFOUND'), Wsa.NETUNREACH);
    assert.equal(wsaErrorFor(undefined), Wsa.CONNREFUSED, 'an unknown failure is still a failure');
});

test('control messages round-trip, and nonsense is a null', ()=>{
    const hello = { t: /** @type {'hello'} */ ('hello'), protocol: 1, room: 'r' };
    assert.deepEqual(decodeControl(encodeControl(hello)), hello);
    assert.equal(decodeControl('{'), null);
    assert.equal(decodeControl('[]'), null);
    assert.equal(decodeControl('null'), null);
    assert.equal(decodeControl('{"no":"tag"}'), null);
});

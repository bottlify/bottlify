/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    childrenOf, contents, DerError, encoding, readBitString, readInteger, readNode, readOid,
    readString, readTime, readUnsigned, TAG,
} from './der.js';
import { der } from './pki.test.js';

test('a node\'s length is read in the short and the long form', ()=>{
    const short = der.octets(new Uint8Array(5));
    assert.deepEqual([...short.subarray(0, 2)], [0x04, 5]);
    const long = der.octets(new Uint8Array(300));
    const node = readNode(long);
    assert.equal(node.tag, TAG.OCTET_STRING);
    assert.equal(node.contentStart, 4, 'two length bytes after 0x82');
    assert.equal(contents(node).length, 300);
    assert.equal(encoding(node).length, 304);
});

test('a constructed node lists its children, each a window on the same bytes', ()=>{
    const bytes = der.seq(der.int(5), der.seq(der.nul()), der.octets(Uint8Array.of(9)));
    const [number, inner, octets] = childrenOf(readNode(bytes));
    assert.equal(readInteger(number), 5n);
    assert.equal(childrenOf(inner)[0].tag, TAG.NULL);
    assert.equal(octets.bytes, bytes);
    assert.throws(()=>childrenOf(number), DerError, 'a primitive has none');
});

test('a length that runs past its parent, an indefinite one and a high tag are refused', ()=>{
    assert.throws(()=>readNode(Uint8Array.of(0x04, 5, 1, 2)), DerError);
    assert.throws(()=>readNode(Uint8Array.of(0x30, 0x80, 0, 0)), DerError);
    assert.throws(()=>readNode(Uint8Array.of(0x1f, 0x81, 1, 0)), DerError);
    assert.throws(()=>childrenOf(readNode(Uint8Array.of(0x30, 3, 0x04, 5, 0))), DerError,
        'a child running past its parent');
});

test('object identifiers decode, the first two arcs folded and long arcs in base 128', ()=>{
    for (const oid of ['1.2.840.113549.1.1.5', '1.3.14.3.2.26', '2.5.29.37.0',
        '2.16.840.1.101.3.4.2.1', '2.999.1'])
    {
        assert.equal(readOid(readNode(der.oid(oid))), oid);
    }
});

test('integers are two\'s complement, and an unsigned magnitude drops its sign octet', ()=>{
    assert.equal(readInteger(readNode(Uint8Array.of(0x02, 1, 0xff))), -1n);
    assert.equal(readInteger(readNode(Uint8Array.of(0x02, 2, 0x00, 0x80))), 128n);
    assert.deepEqual([...readUnsigned(readNode(der.int(0x80ff)))], [0x80, 0xff]);
});

test('UTCTime years run from 1950 to 2049, and GeneralizedTime carries four digits', ()=>{
    const time = (/** @type {number} */ tag, /** @type {string} */ text)=>
        readTime(readNode(der.node(tag, new Uint8Array(Buffer.from(text, 'latin1')))));
    assert.equal(time(TAG.UTC_TIME, '491231235959Z'), Date.UTC(2049, 11, 31, 23, 59, 59));
    assert.equal(time(TAG.UTC_TIME, '500101000000Z'), Date.UTC(1950, 0, 1));
    assert.equal(time(TAG.UTC_TIME, '9701100700Z'), Date.UTC(1997, 0, 10, 7, 0), 'seconds absent');
    assert.equal(time(TAG.GENERALIZED_TIME, '20201231070000Z'), Date.UTC(2020, 11, 31, 7));
    assert.throws(()=>time(TAG.UTC_TIME, '20201231070000'), DerError);
});

test('bit strings keep their unused-bit count, strings their text', ()=>{
    const { unused, bits } = readBitString(readNode(Uint8Array.of(0x03, 2, 7, 0x80)));
    assert.equal(unused, 7);
    assert.deepEqual([...bits], [0x80]);
    assert.equal(readString(readNode(der.printable('Root'))), 'Root');
    assert.equal(readString(readNode(Uint8Array.of(0x1e, 4, 0, 0x41, 0x04, 0x10))), 'AА');
});

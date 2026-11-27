/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from './protobuf.js';

const hex = (/** @type {Uint8Array} */ bytes)=>Buffer.from(bytes).toString('hex');

test('the encoding guide\'s examples', ()=>{
    assert.equal(hex(encode({ a: [1, 'uint32'] }, { a: 150 })), '089601');
    assert.equal(hex(encode({ b: [2, 'string'] }, { b: 'testing' })), '120774657374696e67');
    assert.equal(hex(encode({ a: [1, 'int32'] }, { a: -1 })), '08ffffffffffffffffff01');
    // A packed repeated field is read as well as an unpacked one.
    const packed = Uint8Array.from(Buffer.from('2206038e029ea705', 'hex'));
    assert.deepEqual(decode({ d: [4, 'uint32', 'repeated'] }, packed).d, [3, 270, 86942]);
});

test('every type round-trips, nested and repeated, and unknown fields are skipped', ()=>{
    const inner = { id: [1, 'fixed64'], name: [2, 'string'] };
    const schema = {
        small: [1, 'uint32'], signed: [2, 'int32'], big: [3, 'uint64'], word: [4, 'fixed32'],
        flag: [5, 'bool'], blob: [6, 'bytes'], ratio: [7, 'float'],
        items: [8, inner, 'repeated'], numbers: [9, 'uint32', 'repeated'],
    };
    /** @type {Record<string, any>} */
    const message = {
        small: 0xFFFFFFFF, signed: -5, big: 0xFFFFFFFFFFFFFFFFn, word: 0x89ABCDEF,
        flag: true, blob: Uint8Array.of(1, 2, 3), ratio: 0.5,
        items: [{ id: 76561197960265728n, name: 'α' }, { id: 1n, name: '' }],
        numbers: [1, 2],
    };
    const bytes = encode(/** @type {any} */ (schema), message);
    assert.deepEqual(decode(/** @type {any} */ (schema), bytes), message);
    // A reader knowing two fields of it reads those two.
    assert.deepEqual(decode({ flag: [5, 'bool'], small: [1, 'uint32'] }, bytes),
        { flag: true, small: 0xFFFFFFFF });
});

test('a message cut short is an error, not a partial answer', ()=>{
    assert.throws(()=>decode({ b: [2, 'string'] }, Uint8Array.of(0x12, 5, 0x41)), RangeError);
});

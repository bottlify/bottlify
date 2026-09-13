/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IID_ICREATEERRORINFO, IID_IERRORINFO, createErrorInfoObjects } from './errorinfo.js';
import { createAdapter } from './objects.js';
import { IID_IUNKNOWN } from '../ole32/objects.js';

test('an error object is filled through one interface and read through the other', ()=>{
    const bytes = new Uint8Array(0x1000);
    /** @type {Map<number, string>} */
    const bstrs = new Map();
    /** @type {any} */
    let published = null;
    const objects = createErrorInfoObjects({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        publish: object=>{
            published = object;
            return 0x5000;
        },
        allocateBstr: text=>{
            const at = 0x100 + bstrs.size * 0x40;
            bstrs.set(at, text);
            return at;
        },
        adapt: (state, interfaces)=>createAdapter(state, interfaces),
    });
    assert.equal(objects.create(), 0x5000);
    assert.ok(published.interfaceFor(IID_IUNKNOWN));
    const creator = published.interfaceFor(IID_ICREATEERRORINFO);
    const reader = published.interfaceFor(IID_IERRORINFO);
    assert.ok(creator && reader, 'both interfaces on one object');
    /** @param {any} record @param {string} name @param {number[]} args */
    const call = (record, name, args)=>record.methods.find(
        (/** @type {any} */ m)=>m.name === name).invoke(published, args);
    const u32 = (/** @type {number} */ at)=>(bytes[at] | (bytes[at + 1] << 8)
        | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

    // Nothing set: a nil GUID, null strings, context zero.
    assert.equal(call(reader, 'GetGUID', [0x200]), 0);
    assert.deepEqual([...bytes.subarray(0x200, 0x210)], new Array(16).fill(0));
    bytes.set([1, 2, 3, 4], 0x300);
    assert.equal(call(reader, 'GetDescription', [0x300]), 0);
    assert.equal(u32(0x300), 0);
    assert.equal(call(reader, 'GetSource', [0]) >>> 0, 0x80070057);

    const text = 'It broke';
    for (let at = 0; at < text.length; at++)
    {
        bytes[0x400 + at * 2] = text.charCodeAt(at);
    }
    bytes.set([0x40, 0xfc, 0x29, 0x6b, 0x47, 0xca, 0x67, 0x10,
        0xb3, 0x1d, 0x00, 0xdd, 0x01, 0x06, 0x62, 0xda], 0x500);
    assert.equal(call(creator, 'SetDescription', [0x400]), 0);
    assert.equal(call(creator, 'SetSource', [0]), 0, 'NULL clears');
    assert.equal(call(creator, 'SetGUID', [0x500]), 0);
    assert.equal(call(creator, 'SetGUID', [0]) >>> 0, 0x80070057);
    assert.equal(call(creator, 'SetHelpContext', [77]), 0);

    assert.equal(call(reader, 'GetDescription', [0x300]), 0);
    assert.equal(bstrs.get(u32(0x300)), 'It broke', 'a fresh BSTR the caller owns');
    assert.equal(call(reader, 'GetGUID', [0x200]), 0);
    assert.deepEqual([...bytes.subarray(0x200, 0x210)], [...bytes.subarray(0x500, 0x510)]);
    assert.equal(call(reader, 'GetHelpContext', [0x300]), 0);
    assert.equal(u32(0x300), 77);
    assert.equal(call(reader, 'GetHelpFile', [0x300]), 0);
    assert.equal(u32(0x300), 0);
});

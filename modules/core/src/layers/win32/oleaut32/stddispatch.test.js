/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStdDispatchObjects, IID_IDISPATCH } from './stddispatch.js';
import { createAdapter } from './objects.js';

const IID_NULL = new Uint8Array(16);

/** A memory, a type information whose vtable records calls, and the objects. */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {[number, number[]][]} */
    const calls = [];
    const TYPEINFO = 0x100;
    const VTABLE = 0x200;
    view.setUint32(TYPEINFO, VTABLE, true);
    for (let slot = 0; slot < 22; slot++)
    {
        view.setUint32(VTABLE + slot * 4, 0x9000 + slot, true);
    }
    const OUTER = 0x400;
    view.setUint32(OUTER, VTABLE + 0x100, true);
    for (let slot = 0; slot < 3; slot++)
    {
        view.setUint32(VTABLE + 0x100 + slot * 4, 0x9100 + slot, true);
    }
    /** @type {any[]} */
    const published = [];
    const objects = createStdDispatchObjects({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        publish: (object, id)=>{
            published.push([object, id]);
            return 0x7000 + published.length;
        },
        call: (entry, args)=>{
            calls.push([entry, args]);
            return Promise.resolve(entry === 0x9100 ? 0x80010003 : 0);
        },
        adapt: (state, interfaces, destroy)=>createAdapter(state, interfaces, destroy),
    });
    return { bytes, view, calls, objects, published, TYPEINFO, OUTER };
}

/** @param {any} adapter @param {string} name */
const methodOf = (adapter, name)=>adapter.interfaceFor(IID_IDISPATCH).methods
    .find((/** @type {any} */ method)=>method.name === name);

test('the object holds its type information and answers IDispatch from it', async()=>{
    const { bytes, view, calls, objects, published, TYPEINFO } = fixture();
    const pointer = await objects.create(0, 0x500, TYPEINFO);
    assert.equal(pointer, 0x7001);
    assert.deepEqual(calls.shift(), [0x9001, [TYPEINFO]], 'AddRef on the type information');
    const adapter = published[0][0];
    assert.equal(published[0][1], '{00000000-0000-0000-C000-000000000046}');
    const count = methodOf(adapter, 'GetTypeInfoCount');
    assert.equal(count.invoke(adapter, [0x600]), 0);
    assert.equal(view.getUint32(0x600, true), 1);
    assert.equal(methodOf(adapter, 'GetTypeInfo').invoke(adapter, [1, 0, 0x600]), 0x8002000b | 0);
    bytes.set(IID_NULL, 0x700);
    await methodOf(adapter, 'Invoke').invoke(adapter, [7, 0x700, 0, 1, 0x800, 0x810, 0, 0]);
    assert.deepEqual(calls.shift(), [0x900b, [TYPEINFO, 0x500, 7, 1, 0x800, 0x810, 0, 0]],
        'ITypeInfo::Invoke over the program\'s object');
    bytes[0x700] = 1;
    assert.equal(methodOf(adapter, 'GetIDsOfNames').invoke(adapter, [0x700, 0, 1, 0, 0x900]),
        0x80020001 | 0, 'DISP_E_UNKNOWNINTERFACE for an IID other than IID_NULL');
    adapter.release();
    assert.deepEqual(calls.shift(), [0x9002, [TYPEINFO]], 'Release on the last reference');
});

test('an aggregate\'s IDispatch asks the outer object what it is', async()=>{
    const { calls, objects, published, TYPEINFO, OUTER } = fixture();
    await objects.create(OUTER, 0x500, TYPEINFO);
    calls.length = 0;
    const adapter = published[0][0];
    const queryInterface = adapter.interfaceFor(IID_IDISPATCH).methods[0];
    assert.equal(await queryInterface.invoke(adapter, [0x700, 0x600]), 0x80010003);
    assert.deepEqual(calls, [[0x9100, [OUTER, 0x700, 0x600]]]);
});

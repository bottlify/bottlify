/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStdDispatchObjects, IID_IDISPATCH } from './stddispatch.js';
import { createAdapter } from './objects.js';
import { guestOver } from '../common/guest.fixture.js';

const IID_NULL = new Uint8Array(16);

/**
 * A memory, a type information whose vtable records calls, and the objects.
 *
 * @param {4 | 8} [pointerSize]  the width the vtables are laid out at
 */
function fixture(pointerSize = 4){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    const guest = guestOver(bytes, pointerSize);
    /** @type {[number, number[]][]} */
    const calls = [];
    const TYPEINFO = 0x100;
    const VTABLE = 0x200;
    guest.setPtr(TYPEINFO, VTABLE);
    for (let slot = 0; slot < 22; slot++)
    {
        guest.setPtr(VTABLE + slot * pointerSize, 0x9000 + slot);
    }
    const OUTER = 0x400;
    guest.setPtr(OUTER, VTABLE + 0x100);
    for (let slot = 0; slot < 3; slot++)
    {
        guest.setPtr(VTABLE + 0x100 + slot * pointerSize, 0x9100 + slot);
    }
    /** @type {any[]} */
    const published = [];
    const objects = createStdDispatchObjects({
        guest,
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
    // The bridge runs lastRelease inside the last Release and waits for it.
    assert.equal(adapter.refCount, 1);
    await adapter.lastRelease();
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

test('an aggregate\'s inner IUnknown hands out IDispatch counted on the outer object', async()=>{
    // tmarshal.c's Widget aggregates a standard dispatch and asks its inner
    // IUnknown for IDispatch on every GetTypeInfoCount, releasing what it got:
    // that Release goes to the outer object, so the QueryInterface has to
    // AddRef the outer one, and the inner keeps its own count.
    const { bytes, view, calls, objects, published, TYPEINFO, OUTER } = fixture();
    await objects.create(OUTER, 0x500, TYPEINFO);
    calls.length = 0;
    const adapter = published[0][0];
    const unknown = adapter.interfaceFor('{00000000-0000-0000-C000-000000000046}').methods;
    // IID_IDispatch, {00020400-0000-0000-C000-000000000046}, as it lies in memory.
    bytes.set(Uint8Array.of(0x00, 0x04, 0x02, 0x00, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46),
        0x700);
    assert.equal(await unknown[0].invoke(adapter, [0x700, 0x600]), 0);
    assert.deepEqual(published.at(-1), [adapter, IID_IDISPATCH]);
    assert.equal(view.getUint32(0x600, true), 0x7000 + published.length);
    assert.deepEqual(calls, [[0x9101, [OUTER]]], 'AddRef on the outer object');
    assert.equal(adapter.refCount, 1, 'the inner object\'s own count is left alone');
    calls.length = 0;
    bytes.set(new Uint8Array(16), 0x700);
    bytes[0x70f] = 0x46;
    bytes[0x708] = 0xc0;
    assert.equal(await unknown[0].invoke(adapter, [0x700, 0x600]), 0, 'IUnknown is itself');
    assert.equal(adapter.refCount, 2);
    assert.deepEqual(published.at(-1), [adapter, '{00000000-0000-0000-C000-000000000046}']);
    assert.equal(view.getUint32(0x600, true), 0x7000 + published.length);
    assert.deepEqual(calls, []);
    bytes[0x700] = 9;
    assert.equal(await unknown[0].invoke(adapter, [0x700, 0x600]), 0x80004002 | 0);
    assert.equal(view.getUint32(0x600, true), 0);
    assert.equal(unknown[0].invoke(adapter, [0x700, 0]), 0x80004003 | 0);
});

test('a 64-bit type information\'s methods are read from its vtable of pointers', async()=>{
    const { calls, objects, TYPEINFO } = fixture(8);
    assert.equal(await objects.create(0, 0x500, TYPEINFO), 0x7001);
    assert.deepEqual(calls.shift(), [0x9001, [TYPEINFO]], 'AddRef, slot 1 of eight-byte slots');
});

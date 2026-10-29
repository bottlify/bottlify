/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordInfoObjects, IID_IRECORDINFO } from './recordinfo.js';
import { createAdapter } from './objects.js';

const plain = (/** @type {number} */ vt)=>({ vt, element: null, hreftype: -1, array: null });

/** test_struct of Wine's vartype: an HRESULT, a VARIANT_BOOL, an IDispatch * and a BSTR. */
const LIBRARY = /** @type {any} */ ({
    typeInfos: [{ name: 'test_struct', kind: 1, guid: '{4029F190-CA4A-4611-AEB9-673983CB96DD}',
        instanceSize: 16, variables: [
            { name: 'hr', type: plain(25), offset: 0 },
            { name: 'b', type: plain(11), offset: 4 },
            { name: 'disp', type: plain(9), offset: 8 },
            { name: 'bstr', type: plain(8), offset: 12 }] }],
    imports: [],
});

function fixture(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {[number, number[]][]} */
    const calls = [];
    /** @type {number[]} */
    const freed = [];
    let next = 0x8000;
    /** @type {any} */
    let published = null;
    const objects = createRecordInfoObjects({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        heap: { allocate: size=>{
            const at = next;
            next += size + 16;
            return at;
        }, free: ()=>true },
        publish: object=>{
            published = object;
            return 0x7000;
        },
        call: (entry, args)=>{
            calls.push([entry, args]);
            return Promise.resolve(0);
        },
        thread: ()=>null,
        adapt: (state, interfaces, destroy)=>createAdapter(state, interfaces, destroy),
        clearVariant: ()=>0,
        copyVariant: ()=>0,
        copyBstr: bstr=>(bstr === 0 ? 0 : bstr + 0x100),
        freeBstr: bstr=>void freed.push(bstr),
        allocateBstr: ()=>0x6000,
        divergence: ()=>{},
    });
    return { bytes, view, calls, freed, objects, published: ()=>published };
}

/** @param {any} adapter @param {string} name */
const methodOf = (adapter, name)=>adapter.interfaceFor(IID_IRECORDINFO).methods
    .find((/** @type {any} */ method)=>method.name === name);

test('a record is copied over an emptied one: a string duplicated, an interface held', async()=>{
    const { view, calls, freed, objects, published } = fixture();
    // The interface's vtable: AddRef and Release at 0x9001 and 0x9002.
    view.setUint32(0x500, 0x600, true);
    view.setUint32(0x604, 0x9001, true);
    view.setUint32(0x608, 0x9002, true);
    assert.equal(await objects.create(LIBRARY, LIBRARY.typeInfos[0], 0x100), 0x7000);
    const adapter = published();
    const FROM = 0x1000;
    const TO = 0x1100;
    view.setUint32(FROM, 1, true);
    view.setInt16(FROM + 4, -1, true);
    view.setUint32(FROM + 8, 0x500, true);
    view.setUint32(FROM + 12, 0x2000, true);
    view.setUint32(TO + 8, 0x500, true);
    view.setUint32(TO + 12, 0x3000, true);
    assert.equal(await methodOf(adapter, 'RecordCopy').invoke(adapter, [FROM, TO]), 0);
    assert.deepEqual(freed, [0x3000], 'the target\'s string freed first');
    assert.deepEqual(calls.map(([entry])=>entry), [0x9002, 0x9001],
        'the target\'s interface released, then the source\'s taken');
    assert.deepEqual([view.getUint32(TO, true), view.getInt16(TO + 4, true),
        view.getUint32(TO + 8, true), view.getUint32(TO + 12, true)], [1, -1, 0x500, 0x2100]);
    calls.length = 0;
    assert.equal(await methodOf(adapter, 'RecordClear').invoke(adapter, [TO]), 0);
    assert.deepEqual([view.getUint32(TO + 8, true), view.getUint32(TO + 12, true)], [0, 0]);
    assert.deepEqual(calls.map(([entry])=>entry), [0x9002]);
    assert.equal(methodOf(adapter, 'GetSize').invoke(adapter, [0x1200]), 0);
    assert.equal(view.getUint32(0x1200, true), 16);
    view.setUint32(TO, 0xdead, true);
    assert.equal(methodOf(adapter, 'RecordInit').invoke(adapter, [TO]), 0);
    assert.equal(view.getUint32(TO, true), 0);
});

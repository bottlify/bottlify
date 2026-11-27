/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Private data holding one of the program's own objects: its AddRef and
 * Release are called as Windows calls them (Wine's d3d8 and d3d9
 * test_fpu_setup, test_private_data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3D_PRIVATE_DATA, createPrivateData } from './privatedata.js';

const GUID = 0x100;
/** The program's object: its table at 0x200, AddRef at 0x1000, Release at 0x1100. */
const OBJECT = 0x300;
const OTHER = 0x340;
const SIZE_AT = 0x400;
const OUT = 0x404;
const ADD_REF = 0x1000;
const RELEASE = 0x1100;
const THREAD = { name: 'main' };

function harness(){
    const bytes = new Uint8Array(0x2000);
    const view = new DataView(bytes.buffer);
    const memory = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} data */
        writeMemory: (at, data)=>bytes.set(data, at),
        /** @param {number} at */
        readU32: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        writeU32: (at, value)=>view.setUint32(at, value >>> 0, true),
    };
    bytes.set(Uint8Array.from({ length: 16 }, (_, i)=>i + 1), GUID);
    memory.writeU32(0x200 + 4, ADD_REF);
    memory.writeU32(0x200 + 8, RELEASE);
    memory.writeU32(OBJECT, 0x200);
    memory.writeU32(OTHER, 0x200);
    /** @type {string[]} */
    const heard = [];
    /** @type {((thread: unknown) => unknown)[]} */
    const owed = [];
    const data = createPrivateData({
        memory,
        publisher: { objectAt: ()=>null, adapterFor: ()=>null,
            owe: (/** @type {(thread: unknown) => unknown} */ call)=>owed.push(call) },
        rules: D3D_PRIVATE_DATA,
        callGuest: async({ entry, args, thread })=>{
            assert.equal(thread, THREAD, 'on the calling thread');
            heard.push(`${entry === ADD_REF ? 'AddRef' : 'Release'} ${args[0].toString(16)}`);
            return 1;
        },
        currentThread: ()=>THREAD,
    });
    return { data, memory, heard, owed };
}

test('an interface entry of the program\'s own holds it by its AddRef, and lets go by Release',
    async()=>{
        const { data, memory, heard } = harness();
        const surface = {};
        const IUNKNOWN = 1;
        const { SetPrivateData, GetPrivateData, FreePrivateData } = data.methods;
        assert.equal(await SetPrivateData(surface, [GUID, OBJECT, 4, IUNKNOWN]), 0);
        assert.deepEqual(heard.splice(0), ['AddRef 300']);
        assert.equal(await SetPrivateData(surface, [GUID, OTHER, 4, IUNKNOWN]), 0);
        assert.deepEqual(heard.splice(0), ['AddRef 340', 'Release 300'],
            'the new one held before the old one goes');
        memory.writeU32(SIZE_AT, 4);
        assert.equal(await GetPrivateData(surface, [GUID, OUT, SIZE_AT]), 0);
        assert.equal(memory.readU32(OUT), OTHER);
        assert.deepEqual(heard.splice(0), ['AddRef 340'], 'a read hands the caller a reference');
        assert.equal(await FreePrivateData(surface, [GUID]), 0);
        assert.deepEqual(heard.splice(0), ['Release 340']);
    });

test('an object that goes owes the program its entries\' Releases, made after its own', async()=>{
    const { data, heard, owed } = harness();
    const backBuffer = { destroyed: false };
    const texture = { destroyed: false };
    await data.methods.SetPrivateData(backBuffer, [GUID, OBJECT, 4, 1]);
    await data.methods.SetPrivateData(texture, [GUID, OTHER, 4, 1]);
    heard.length = 0;
    data.released(texture);
    assert.deepEqual(heard, [], 'nothing called while the object goes');
    assert.equal(owed.length, 1);
    await owed.shift()?.(THREAD);
    assert.deepEqual(heard.splice(0), ['Release 340']);
    // The device going takes the back buffer it kept with it.
    data.sweep(holder=>holder === backBuffer);
    await owed.shift()?.(THREAD);
    assert.deepEqual(heard.splice(0), ['Release 300']);
    assert.equal(owed.length, 0);
});

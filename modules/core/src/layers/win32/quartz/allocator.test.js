/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../ole32/objects.js';
import { createMemoryAllocator } from './allocator.js';
import {
    CLSID_MEMORY_ALLOCATOR, IID_IMEDIA_SAMPLE, IID_IMEDIA_SAMPLE2, IID_IMEM_ALLOCATOR,
} from './interfaces.js';

const S_OK = 0;
const S_FALSE = 1;
const VFW_E_BADALIGN = 0x8004020e;
const VFW_E_ALREADY_COMMITTED = 0x8004020f;
const VFW_E_BUFFERS_OUTSTANDING = 0x80040210;
const VFW_E_NOT_COMMITTED = 0x80040211;
const VFW_E_SIZENOTSET = 0x80040212;
const VFW_E_TIMEOUT = 0x8004022e;
const VFW_E_SAMPLE_TIME_NOT_SET = 0x80040249;
const VFW_S_NO_STOP_TIME = 0x00040270;
const VFW_E_BUFFER_OVERFLOW = 0x8004020d;

function machine(){
    const memory = new DataView(new ArrayBuffer(0x100000));
    let next = 0x1000;
    /** @type {Set<number>} */
    const freed = new Set();
    /** @type {Map<number, import('../ole32/objects.js').ComObject>} */
    const objects = new Map();
    const host = {
        /** @param {number} address */
        readU32: address=>memory.getUint32(address, true),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>bytes.forEach((b, i)=>memory.setUint8(address + i, b)),
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += Math.ceil(bytes / 16) * 16 + 16;
            return at;
        },
        /** @param {number} address */
        free: address=>freed.add(address),
        /** @param {import('../ole32/objects.js').ComObject} object */
        publish: object=>{
            const pointer = 0x80000 + objects.size * 16;
            objects.set(pointer, object);
            return pointer;
        },
    };
    const allocator = createComObject(CLSID_MEMORY_ALLOCATOR, createMemoryAllocator(host)());
    /** @param {import('../ole32/objects.js').ComObject} object @param {string} iid */
    const method = (object, iid)=>(/** @type {string} */ name, /** @type {number[]} */ args)=>
        /** @type {any} */ (object.interfaceFor(iid)).methods
            .find((/** @type {any} */ m)=>m.name === name).invoke(object, args);
    const call = method(allocator, IID_IMEM_ALLOCATOR);
    /** @param {number[]} props [buffers, size, align, prefix] */
    const set = props=>{
        props.forEach((value, i)=>memory.setInt32(0x100 + i * 4, value, true));
        return call('SetProperties', [0x100, 0x200]) >>> 0;
    };
    /** Takes a buffer through the out word at 0x300; answers its sample object. */
    const take = async(flags = 0)=>{
        const hr = await call('GetBuffer', [0x300, 0, 0, flags]) >>> 0;
        return { hr, object: objects.get(memory.getUint32(0x300, true)) ?? null };
    };
    return { memory, freed, allocator, call, set, take, method };
}

test('properties are refused unaligned, while committed and while a sample is out', async()=>{
    const m = machine();
    assert.equal(m.set([1, 0, 0, 0]), VFW_E_BADALIGN);
    assert.equal(m.set([2, 64, 16, 4]), S_OK);
    assert.deepEqual([0, 4, 8, 12].map(at=>m.memory.getInt32(0x200 + at, true)), [2, 64, 16, 4]);
    assert.equal(m.call('Commit', []) >>> 0, S_OK);
    assert.equal(m.set([2, 64, 16, 4]), VFW_E_ALREADY_COMMITTED);
    const { object } = await m.take();
    assert.equal(m.call('Decommit', []) >>> 0, S_OK);
    assert.equal(m.set([2, 64, 16, 4]), VFW_E_BUFFERS_OUTSTANDING);
    const sample = m.method(/** @type {any} */ (object), IID_IMEDIA_SAMPLE);
    m.memory.setUint32(0x310, 0, true);
    sample('GetPointer', [0x310]);
    assert.equal(m.memory.getUint32(0x310, true) % 16, 0, 'the data is aligned');
    /** @type {any} */ (object).release();
    assert.equal(m.freed.size, 2, 'both buffers go once decommitted and back');
});

test('Commit needs a size; GetBuffer needs a commit, and waits for a buffer or says so', async()=>{
    const m = machine();
    m.set([1, 0, 1, 0]);
    assert.equal(m.call('Commit', []) >>> 0, VFW_E_SIZENOTSET);
    m.set([1, 32, 1, 0]);
    assert.equal((await m.take()).hr, VFW_E_NOT_COMMITTED);
    m.call('Commit', []);
    const first = await m.take();
    assert.equal(first.hr, S_OK);
    assert.equal((await m.take(4)).hr, VFW_E_TIMEOUT, 'AM_GBF_NOWAIT with every buffer out');
    const waiting = m.take();
    /** @type {any} */ (first.object).release();
    const second = await waiting;
    assert.equal(second.hr, S_OK, 'the waiting GetBuffer took the buffer that came back');
    const third = m.take();
    m.call('Decommit', []);
    assert.equal((await third).hr, VFW_E_NOT_COMMITTED, 'a wait ends with the decommit');
});

test('a sample\'s times and flags, and what survives its return to the pool', async()=>{
    const m = machine();
    m.set([1, 32, 1, 0]);
    m.call('Commit', []);
    const { object } = await m.take();
    const sample = m.method(/** @type {any} */ (object), IID_IMEDIA_SAMPLE2);
    assert.equal(sample('GetTime', [0x400, 0x408]) >>> 0, VFW_E_SAMPLE_TIME_NOT_SET);
    m.memory.setBigInt64(0x400, 0x123n, true);
    sample('SetTime', [0x400, 0]);
    m.memory.setBigInt64(0x408, 0n, true);
    assert.equal(sample('GetTime', [0x400, 0x408]) >>> 0, VFW_S_NO_STOP_TIME);
    assert.equal(m.memory.getBigInt64(0x408, true), 0x124n, 'no stop: the start\'s next tick');
    assert.equal(sample('IsSyncPoint', []) >>> 0, S_FALSE);
    sample('SetSyncPoint', [1]);
    sample('GetProperties', [48, 0x500]);
    assert.equal(m.memory.getUint32(0x508, true), 0x11, 'TIMEVALID and SPLICEPOINT');
    assert.equal(sample('SetActualDataLength', [33]) >>> 0, VFW_E_BUFFER_OVERFLOW);
    assert.equal(sample('SetActualDataLength', [7]) >>> 0, S_OK);
    /** @type {any} */ (object).release();

    const again = await m.take();
    const reused = m.method(/** @type {any} */ (again.object), IID_IMEDIA_SAMPLE);
    assert.equal(reused('GetActualDataLength', []), 7, 'the actual length stays with the buffer');
    assert.equal(reused('GetTime', [0x400, 0x408]) >>> 0, VFW_E_SAMPLE_TIME_NOT_SET,
        'the times do not');
    assert.equal(reused('IsSyncPoint', []) >>> 0, S_FALSE, 'nor the flags');
});

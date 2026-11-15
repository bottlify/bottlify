/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An asynchronous result is an MFASYNCRESULT a program reads and writes,
 * and a work item is its callback's Invoke on the platform's thread, as
 * Wine's test_MFCreateAsyncResult and test_allocate_queue say Windows answers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mfMachine } from './machine.fixture.js';

const S_OK = 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_FAIL = 0x80004005 | 0;
const MF_E_INVALID_WORKQUEUE = 0xc00d36ff | 0;
const MF_E_SHUTDOWN = 0xc00d3e85 | 0;

/** A machine whose platform thread records what it was asked to call. */
function machine(){
    /** @type {{ entry: number, args: number[], done?: () => void }[]} */
    const delivered = [];
    const m = mfMachine({ notices: { deliver: (entry, args, done)=>delivered.push(
        { entry, args, done }) } });
    return { ...m, delivered };
}

test('a result is an MFASYNCRESULT: no callback, status S_OK, the program\'s writes read back',
    async()=>{
        const m = machine();
        const out = m.out(4);
        assert.equal(m.mf.table.MFCreateAsyncResult.handler([0, 0, 0, 0]), E_INVALIDARG);
        assert.equal(m.mf.table.MFCreateAsyncResult.handler([0, 0, 0, out]), S_OK);
        const result = m.u32(out);
        assert.equal(m.u32(result + 24), 0, 'pCallback');
        assert.equal(m.u32(result + 28), 0, 'hrStatusResult');
        assert.equal(m.u32(result + 32), 0, 'dwBytesTransferred');
        assert.equal(m.u32(result + 36), 0, 'hEvent');

        const state = m.out(4);
        m.putU32(state, 0xdeadbeef);
        assert.equal(await m.call(result, 'GetState', 0), E_POINTER);
        assert.equal(await m.call(result, 'GetState', state), E_POINTER);
        assert.equal(m.u32(state), 0xdeadbeef, 'no state: the out left alone');
        m.putU32(result + 28, 123);
        assert.equal(await m.call(result, 'GetStatus'), 123, 'the status is the structure\'s');
        assert.equal(await m.call(result, 'SetStatus', E_FAIL), S_OK);
        assert.equal(m.u32(result + 28) | 0, E_FAIL);
        assert.equal(await m.call(result, 'GetObject', state), E_POINTER);

        // A result holding the first as its object and its state.
        const callback = m.foreign([()=>S_OK, ()=>S_OK]).pointer;
        assert.equal(await m.mf.table.MFCreateAsyncResult.handler([result, callback, result, out]),
            S_OK);
        const second = m.u32(out);
        assert.equal(m.u32(second + 24), callback);
        assert.equal(await m.call(second, 'GetObject', state), S_OK);
        assert.equal(m.u32(state), result);
        assert.equal(await m.call(second, 'GetStateNoAddRef'), result);
    });

test('MFInvokeCallback calls Invoke on the platform\'s thread, the result held until it returns',
    async()=>{
        const m = machine();
        assert.equal(m.mf.table.MFInvokeCallback.handler([0]), MF_E_SHUTDOWN,
            'before MFStartup there is no platform to call back from');
        m.mf.table.MFStartup.handler([0x20070, 0]);
        const invoke = ()=>S_OK;
        const callback = m.foreign([()=>S_OK, invoke]).pointer;
        const out = m.out(4);
        await m.mf.table.MFCreateAsyncResult.handler([0, callback, 0, out]);
        const result = m.u32(out);
        assert.equal(m.mf.table.MFInvokeCallback.handler([result]), S_OK);
        assert.equal(m.delivered.length, 1);
        const [call] = m.delivered;
        assert.equal(call.entry, m.u32(m.u32(callback) + 16),
            'IMFAsyncCallback::Invoke, slot 4');
        assert.deepEqual(call.args, [callback, result]);

        assert.equal(await m.mf.table.MFPutWorkItem.handler([0, callback, 0]), S_OK);
        assert.equal(m.delivered.length, 2, 'a work item is a result invoked the same way');
        assert.equal(m.mf.table.MFPutWorkItem.handler([0, 0, 0]), E_INVALIDARG);
    });

test('a queue allocated is locked once; unlocked away it is gone; the standard ones stay',
    ()=>{
        const m = machine();
        const out = m.out(4);
        assert.equal(m.mf.table.MFAllocateWorkQueue.handler([out]), MF_E_SHUTDOWN);
        m.mf.table.MFStartup.handler([0x20070, 0]);
        assert.equal(m.mf.table.MFAllocateWorkQueue.handler([out]), S_OK);
        const queue = m.u32(out);
        assert.ok(queue >= 0x10000);
        assert.equal(m.mf.table.MFLockWorkQueue.handler([queue]), S_OK);
        assert.equal(m.mf.table.MFUnlockWorkQueue.handler([queue]), S_OK);
        assert.equal(m.mf.table.MFUnlockWorkQueue.handler([queue]), S_OK);
        assert.equal(m.mf.table.MFUnlockWorkQueue.handler([queue]), MF_E_INVALID_WORKQUEUE);
        assert.equal(m.mf.table.MFLockWorkQueue.handler([1]), S_OK,
            'MFASYNC_CALLBACK_QUEUE_STANDARD');
    });

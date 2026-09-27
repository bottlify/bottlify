/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DEVICE_HOOK, describeDevice } from './device-lag.mjs';

/**
 * A realm with a queue whose work finishes when the test says so, in order,
 * as a device's does.
 */
function realm(){
    /** @type {(() => void)[]} */
    const pending = [];
    let clock = 0;
    class GPUQueue
    {
        /** @param {any[]} buffers */
        submit(buffers){
            return buffers.length;
        }

        onSubmittedWorkDone(){
            return new Promise(resolve=>pending.push(()=>resolve(undefined)));
        }
    }
    /** @type {any} */
    const context = vm.createContext({ GPUQueue, performance: { now: ()=>clock } });
    context.self = context;
    return {
        context,
        queue: new GPUQueue(),
        /** @param {number} ms */
        advance(ms){
            clock += ms;
        },
        /** Finishes the oldest outstanding submit. */
        async finish(){
            pending.shift()?.();
            await new Promise(resolve=>setImmediate(resolve));
        },
        read(){
            return JSON.parse(vm.runInContext('self.__bottlifyDevice()', context));
        },
    };
}

test('the hook counts submits, and how old the oldest the device has not finished is', async()=>{
    const r = realm();
    assert.equal(vm.runInContext(DEVICE_HOOK, r.context), true);
    assert.equal(vm.runInContext(DEVICE_HOOK, r.context), true, 'a second install is harmless');
    // The queue made before the hook still goes through it: the prototype is wrapped.
    assert.equal(r.queue.submit([1, 2]), 2, 'and submit answers as it did');
    r.advance(1000);
    r.queue.submit([]);
    r.advance(500);
    r.queue.submit([]);
    r.advance(2000);
    assert.deepEqual(r.read(), { submitted: 3, done: 0, oldestMs: 3500 });
    await r.finish();
    assert.deepEqual(r.read(), { submitted: 3, done: 1, oldestMs: 2500 },
        'the oldest unfinished is now the second');
    await r.finish();
    await r.finish();
    assert.deepEqual(r.read(), { submitted: 3, done: 3, oldestMs: 0 });
});

test('a description says how far behind the device was, or that it was not', ()=>{
    assert.equal(describeDevice({ submitted: 235, done: 61, oldestMs: 58234 }),
        'the device had finished 61 of 235 submits, the oldest unfinished made 58.2 s before');
    assert.equal(describeDevice({ submitted: 235, done: 235, oldestMs: 0 }),
        'the device had finished all 235 submits');
    assert.equal(describeDevice(null), 'the device was not watched');
});

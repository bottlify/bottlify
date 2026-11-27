/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFunctions } from './pool.js';
import { STATUS } from './status.js';

/** kernel32's pool calls, recording what each was asked, failing with `error`. */
function machine({ answer = 1, error = 0 } = {}){
    /** @type {[string, number[]][]} */
    const asked = [];
    /** @param {string} name */
    const entry = name=>({ handler: (/** @type {number[]} */ args)=>{
        asked.push([name, args]);
        return answer;
    } });
    const kernel32 = Object.fromEntries(['QueueUserWorkItem', 'RegisterWaitForSingleObject',
        'CreateTimerQueueTimer', 'ChangeTimerQueueTimer'].map(name=>[name, entry(name)]));
    kernel32.CreateTimerQueue = { handler: ()=>answer ? 0x44 : 0 };
    kernel32.GetLastError = { handler: ()=>error };
    /** The pool's own deletions, answering a status of their own. */
    const deletions = {
        deregisterWait: (/** @type {number} */ wait, /** @type {number} */ event)=>{
            asked.push(['deregisterWait', [wait, event]]);
            return STATUS.PENDING;
        },
        deleteTimer: (/** @type {number} */ timer, /** @type {number} */ event)=>{
            asked.push(['deleteTimer', [timer, event]]);
            return STATUS.SUCCESS;
        },
        deleteTimerQueue: (/** @type {number} */ queue, /** @type {number} */ event)=>{
            asked.push(['deleteTimerQueue', [queue, event]]);
            return STATUS.INVALID_HANDLE;
        },
    };
    /** @type {Uint8Array[]} */
    const written = [];
    const table = createPoolFunctions({ kernel32, deletions,
        writeMemory: (_, bytes)=>written.push(bytes) });
    return { table, asked, written };
}

test('a timer is kernel32\'s with the queue and its place swapped, a status answered', ()=>{
    const { table, asked } = machine();
    assert.equal(table.RtlCreateTimer.handler([0x44, 0x100, 0x401000, 7, 10, 20, 0]),
        STATUS.SUCCESS);
    assert.deepEqual(asked.at(-1),
        ['CreateTimerQueueTimer', [0x100, 0x44, 0x401000, 7, 10, 20, 0]]);
});

test('a deletion is the pool\'s, its status passed through untranslated', ()=>{
    const { table, asked } = machine();
    assert.equal(table.RtlDeregisterWait.handler([0x88]), STATUS.PENDING);
    assert.deepEqual(asked.at(-1), ['deregisterWait', [0x88, 0]], 'returning at once');
    assert.equal(table.RtlDeregisterWaitEx.handler([0x88, 0xffffffff]), STATUS.PENDING);
    assert.deepEqual(asked.at(-1), ['deregisterWait', [0x88, 0xffffffff]]);
    assert.equal(table.RtlDeleteTimer.handler([0x44, 0x90, 0]), STATUS.SUCCESS);
    assert.deepEqual(asked.at(-1), ['deleteTimer', [0x90, 0]], 'the timer knows its queue');
    assert.equal(table.RtlDeleteTimerQueueEx.handler([0x44, 7]), STATUS.INVALID_HANDLE);
    assert.deepEqual(asked.at(-1), ['deleteTimerQueue', [0x44, 7]]);
});

test('a refusal is the status of its last error, and a queue is written where asked', ()=>{
    assert.equal(machine({ answer: 0, error: 6 }).table.RtlRegisterWait.handler(
        [0x100, 4, 0x401000, 0, 0, 0]), STATUS.INVALID_HANDLE);
    assert.equal(machine({ answer: 0, error: 87 }).table.RtlQueueWorkItem.handler(
        [0, 0, 0]), STATUS.INVALID_PARAMETER);
    const { table, written } = machine();
    assert.equal(table.RtlCreateTimerQueue.handler([0x200]), STATUS.SUCCESS);
    assert.deepEqual([...written[0]], [0x44, 0, 0, 0]);
});

test('the Tp* calls are the thread pool API\'s objects, a new one written where asked', ()=>{
    /** @type {[string, any[]][]} */
    const asked = [];
    /** @type {Uint8Array[]} */
    const written = [];
    const objects = new Proxy({}, { get: (_, name)=>(/** @type {any[]} */ ...args)=>{
        asked.push([String(name), args]);
        return { create: args[1] === 0 ? { error: 87 } : 0x500, allocPool: 0x600,
            allocGroup: 0, simple: 8, mayRunLong: false, setTimer: true }[String(name)];
    } });
    const table = createPoolFunctions({ kernel32: {}, writeMemory: (_, bytes)=>written.push(bytes),
        deletions: { deregisterWait: ()=>0, deleteTimer: ()=>0, deleteTimerQueue: ()=>0,
            objects } });
    assert.equal(table.TpAllocWork.handler([0x100, 0x401000, 7, 0]), STATUS.SUCCESS);
    assert.deepEqual(asked.at(-1), ['create', ['work', 0x401000, 7, 0]]);
    assert.deepEqual([...written.at(-1) ?? []], [0, 5, 0, 0]);
    assert.equal(table.TpAllocTimer.handler([0x100, 0, 7, 0]), STATUS.INVALID_PARAMETER,
        'refused, as its Win32 error\'s status');
    assert.equal(table.TpAllocPool.handler([0x104, 0]), STATUS.SUCCESS);
    assert.deepEqual([...written.at(-1) ?? []], [0, 6, 0, 0]);
    assert.equal(table.TpAllocCleanupGroup.handler([0x108]), STATUS.NO_MEMORY);
    assert.equal(table.TpSimpleTryPost.handler([0x401000, 0, 0]), STATUS.NO_MEMORY);
    assert.equal(table.TpCallbackMayRunLong.handler([0x8000]), 0xc0000129,
        'STATUS_TOO_MANY_THREADS');
    assert.equal(table.TpSetTimerEx.handler([0x500, 0x200, 0, 0]), 1, 'it was set');
    table.TpCallbackReleaseSemaphoreOnCompletion.handler([0x8000, 0x50, 3]);
    assert.deepEqual(asked.at(-1), ['onCompletion', [0x8000, 'ReleaseSemaphore', [0x50, 3, 0]]]);
    table.TpCallbackUnloadDllOnCompletion.handler([0x8000, 0x10000000]);
    assert.deepEqual(asked.at(-1), ['onCompletion', [0x8000, 'FreeLibrary', [0x10000000]]]);
});

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

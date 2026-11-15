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
        'UnregisterWaitEx', 'CreateTimerQueueTimer', 'DeleteTimerQueueTimer',
        'DeleteTimerQueueEx', 'ChangeTimerQueueTimer'].map(name=>[name, entry(name)]));
    kernel32.CreateTimerQueue = { handler: ()=>answer ? 0x44 : 0 };
    kernel32.GetLastError = { handler: ()=>error };
    /** @type {Uint8Array[]} */
    const written = [];
    const table = createPoolFunctions({ kernel32, writeMemory: (_, bytes)=>written.push(bytes) });
    return { table, asked, written };
}

test('a timer is kernel32\'s with the queue and its place swapped, a status answered', ()=>{
    const { table, asked } = machine();
    assert.equal(table.RtlCreateTimer.handler([0x44, 0x100, 0x401000, 7, 10, 20, 0]),
        STATUS.SUCCESS);
    assert.deepEqual(asked.at(-1),
        ['CreateTimerQueueTimer', [0x100, 0x44, 0x401000, 7, 10, 20, 0]]);
    assert.equal(table.RtlDeregisterWait.handler([0x88]), STATUS.SUCCESS);
    assert.deepEqual(asked.at(-1), ['UnregisterWaitEx', [0x88, 0]], 'returning at once');
});

test('a refusal is the status of its last error, and a queue is written where asked', ()=>{
    assert.equal(machine({ answer: 0, error: 6 }).table.RtlDeleteTimer.handler([1, 2, 0]),
        STATUS.INVALID_HANDLE);
    assert.equal(machine({ answer: 0, error: 997 }).table.RtlDeleteTimerQueueEx.handler([1, 0]),
        STATUS.PENDING);
    const { table, written } = machine();
    assert.equal(table.RtlCreateTimerQueue.handler([0x200]), STATUS.SUCCESS);
    assert.deepEqual([...written[0]], [0x44, 0, 0, 0]);
});

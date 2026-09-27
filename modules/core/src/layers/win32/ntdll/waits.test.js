/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaitFunctions } from './waits.js';

const STATUS_TIMEOUT = 0x102;
const STATUS_INVALID_HANDLE = 0xc0000008;
const PARKED = Object.freeze({ parked: true });

/**
 * kernel32's waits as recorders: each answers what the test says and keeps
 * the arguments it was handed.
 *
 * @param {{ answer?: any, lastError?: number }} [options]
 */
function setup({ answer = 0, lastError = 0 } = {}){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    /** @type {{ name: string, args: number[] }[]} */
    const calls = [];
    /** @param {string} name */
    const recorder = name=>({
        argBytes: 0,
        handler: (/** @type {number[]} */ args)=>{
            calls.push({ name, args });
            return answer;
        },
    });
    const fns = createWaitFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        allocate: ()=>0x800,
        kernel32: {
            WaitForSingleObjectEx: recorder('WaitForSingleObjectEx'),
            WaitForMultipleObjectsEx: recorder('WaitForMultipleObjectsEx'),
            SleepEx: recorder('SleepEx'),
            GetLastError: { argBytes: 0, handler: ()=>lastError },
            // The system time: 1,000,000 ms past the FILETIME epoch.
            GetSystemTimeAsFileTime: {
                argBytes: 4,
                handler: (/** @type {number[]} */ [at])=>{
                    view.setBigUint64(at, 10000000000n, true);
                    return 0;
                },
            },
        },
    });
    return { fns, view, calls };
}

test('a timeout is hundreds of nanoseconds: an interval negative, a moment positive, none infinite',
    ()=>{
        const { fns, view, calls } = setup();
        view.setBigInt64(0x100, -25000n, true);
        fns.NtWaitForSingleObject.handler([0x10, 0, 0x100]);
        assert.deepEqual(calls.at(-1), { name: 'WaitForSingleObjectEx', args: [0x10, 3, 0] },
            '2.5 ms, rounded up so that a wait never ends early');

        view.setBigInt64(0x100, 0n, true);
        fns.NtWaitForSingleObject.handler([0x10, 1, 0x100]);
        assert.deepEqual(calls.at(-1)?.args, [0x10, 0, 1], 'zero is a poll, and alertable');

        fns.NtWaitForSingleObject.handler([0x10, 0, 0]);
        assert.equal(calls.at(-1)?.args[1], 0xffffffff, 'no pointer is no limit');

        // A moment 40 ms after the system time now; one already past is a poll.
        view.setBigInt64(0x100, 10000400000n, true);
        fns.NtWaitForSingleObject.handler([0x10, 0, 0x100]);
        assert.equal(calls.at(-1)?.args[1], 40);
        view.setBigInt64(0x100, 5n, true);
        fns.NtWaitForSingleObject.handler([0x10, 0, 0x100]);
        assert.equal(calls.at(-1)?.args[1], 0);
    });

test('a wait that ends answers kernel32\'s number, which is the status, and a parked one parks',
    ()=>{
        assert.equal(setup({ answer: STATUS_TIMEOUT }).fns.NtWaitForSingleObject
            .handler([0x10, 0, 0]), STATUS_TIMEOUT);
        assert.equal(setup({ answer: 0xc0 }).fns.NtWaitForSingleObject.handler([0x10, 1, 0]),
            0xc0, 'WAIT_IO_COMPLETION is STATUS_USER_APC');
        assert.equal(setup({ answer: PARKED }).fns.NtWaitForSingleObject.handler([0x10, 0, 0]),
            PARKED);
    });

test('a failed wait is STATUS_INVALID_HANDLE for a bad handle, and a standard stream is one',
    ()=>{
        const bad = setup({ answer: 0xffffffff, lastError: 6 });
        assert.equal(bad.fns.NtWaitForSingleObject.handler([0xfffffffc, 0, 0]),
            STATUS_INVALID_HANDLE);

        const { fns, calls } = setup();
        for (const stream of [0xfffffff6, 0xfffffff5, 0xfffffff4])
        {
            assert.equal(fns.NtWaitForSingleObject.handler([stream, 0, 0]),
                STATUS_INVALID_HANDLE);
        }
        assert.equal(calls.length, 0, 'refused before kernel32 could read it as the stream');
    });

test('NtWaitForMultipleObjects takes WaitAll as zero and WaitAny as one, and no stream', ()=>{
    const { fns, view, calls } = setup({ answer: 3 });
    view.setUint32(0x200, 0x10, true);
    view.setUint32(0x204, 0x14, true);
    assert.equal(fns.NtWaitForMultipleObjects.handler([2, 0x200, 1, 0, 0]), 3);
    assert.deepEqual(calls.at(-1), { name: 'WaitForMultipleObjectsEx',
        args: [2, 0x200, 0, 0xffffffff, 0] });
    fns.NtWaitForMultipleObjects.handler([2, 0x200, 0, 1, 0]);
    assert.deepEqual(calls.at(-1)?.args, [2, 0x200, 1, 0xffffffff, 1]);

    view.setUint32(0x204, 0xfffffff5, true);
    assert.equal(fns.NtWaitForMultipleObjects.handler([2, 0x200, 1, 0, 0]),
        STATUS_INVALID_HANDLE);
    assert.equal(fns.NtWaitForMultipleObjects.handler([65, 0x200, 1, 0, 0]), 0xc00000ef);
});

test('NtDelayExecution is SleepEx over the same timeout', ()=>{
    const { fns, view, calls } = setup();
    view.setBigInt64(0x100, -10000000n, true);
    assert.equal(fns.NtDelayExecution.handler([1, 0x100]), 0);
    assert.deepEqual(calls.at(-1), { name: 'SleepEx', args: [1000, 1] });
});

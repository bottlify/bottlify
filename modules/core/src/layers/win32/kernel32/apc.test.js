/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApcs, WAIT_IO_COMPLETION } from './apc.js';

const STUB = 0x00100400;

/**
 * A thread, a kernel that knows whether it is waiting alertably, and the
 * calls the Ex waits make underneath.
 */
function machine(){
    const main = { name: 'main', state: 'running', alertable: false };
    const worker = {
        name: 'worker', state: 'blocked', alertable: true,
        parkedReturn: 0x00401234, resumeStack: 0x002ff010,
    };
    /** @type {Map<number, number>} */
    const words = new Map();
    /** @type {any[]} */
    const guest = [];
    /** @type {any[]} */
    const calls = [];
    /** @type {any[]} */
    const alerted = [];
    /** @type {number[]} */
    const errors = [];
    let current = /** @type {any} */ (main);
    let registered = 0;
    let entering = false;

    const kernel = {
        /** @param {any} thread @param {() => any} wait */
        alertably: (thread, wait)=>{
            entering = true;
            try
            {
                return wait();
            }
            finally
            {
                entering = false;
            }
        },
        /** @param {any} thread @param {number} result */
        alert: (thread, result)=>{
            if (thread.state !== 'blocked' || !thread.alertable)
            {
                return false;
            }
            alerted.push([thread.name, result]);
            thread.state = 'ready';
            thread.alertable = false;
            return true;
        },
        handles: {
            /** @param {number} handle @param {string} type */
            resolve: (handle, type)=>{
                if (handle === 0x44 && type === 'thread')
                {
                    return worker;
                }
                throw new Error('not a thread');
            },
            /** @param {number} handle */
            typeOf: handle=>({ 0x50: 'event', 0x54: 'mutex', 0x58: 'semaphore' })[handle] ?? null,
        },
    };

    const apcs = createApcs({
        kernel,
        register: ()=>{
            registered++;
            return STUB;
        },
        callGuest: async call=>{
            guest.push({ entry: call.entry, args: call.args, thread: call.thread.name });
            return 0;
        },
        currentThread: ()=>current,
        writeU32: (address, value)=>words.set(address >>> 0, value >>> 0),
        setLastError: code=>errors.push(code),
        call: name=>(/** @type {number[]} */ args)=>{
            calls.push({ name, args, alertable: entering });
            return name === 'WaitForSingleObject' || name === 'Sleep' ? 'parked' : 1;
        },
    });
    return {
        apcs, main, worker, words, guest, calls, alerted, errors,
        registered: ()=>registered,
        /** @param {any} thread */
        run: thread=>{
            current = thread;
        },
    };
}

test('a routine queued to a thread in an alertable wait ends the wait and runs there', async()=>{
    const m = machine();

    assert.equal(m.apcs.table.QueueUserAPC.handler([0x00405000, 0x44, 7]), 1);

    assert.deepEqual(m.alerted, [['worker', WAIT_IO_COMPLETION]]);
    // The wait's return address goes back on the stack under where the call's
    // arguments were, and the thread resumes in the stub standing on it.
    assert.equal(m.words.get(0x002ff00c), 0x00401234);
    assert.equal(m.worker.parkedReturn, STUB);
    assert.equal(m.worker.resumeStack, 0x002ff00c);

    // The stub is where the routines run: on that thread, with their argument.
    m.run(m.worker);
    const answer = await m.apcs.deliver(m.worker);
    assert.equal(answer, WAIT_IO_COMPLETION);
    assert.deepEqual(m.guest, [{ entry: 0x00405000, args: [7], thread: 'worker' }]);
    assert.equal(m.apcs.pending(m.worker), 0);
});

test('a routine queued to a thread that is not waiting alertably only waits in its queue', ()=>{
    const m = machine();
    m.worker.alertable = false;

    m.apcs.table.QueueUserAPC.handler([0x00405000, 0x44, 7]);

    assert.deepEqual(m.alerted, [], 'a wait that is not alertable is not ended');
    assert.equal(m.worker.parkedReturn, 0x00401234, 'and its return is left where it was');
    assert.equal(m.apcs.pending(m.worker), 1);
    assert.equal(m.registered(), 0, 'no stub is taken for nothing');
});

test('an alertable wait with something queued runs it and does not wait at all', async()=>{
    const m = machine();
    m.apcs.table.QueueUserAPC.handler([0x00405000, 0xfffffffe, 3]);

    const answer = await m.apcs.table.SleepEx.handler([0xffffffff, 1]);

    assert.equal(answer, WAIT_IO_COMPLETION);
    assert.deepEqual(m.guest.map(call=>call.args), [[3]]);
    assert.deepEqual(m.calls, [], 'the sleep underneath was never started');
});

test('an alertable wait with nothing queued is the plain wait, made alertable', ()=>{
    const m = machine();

    assert.equal(m.apcs.table.WaitForSingleObjectEx.handler([0x50, 100, 1]), 'parked');
    assert.equal(m.apcs.table.SleepEx.handler([16, 0]), 'parked');

    assert.deepEqual(m.calls, [
        { name: 'WaitForSingleObject', args: [0x50, 100], alertable: true },
        { name: 'Sleep', args: [16], alertable: false },
    ]);
});

test('routines queued while routines run are run by the same wait', async()=>{
    const m = machine();
    m.apcs.queue(m.main, 0x00405000, [1]);
    const first = m.apcs.deliver(m.main);
    m.apcs.queue(m.main, 0x00406000, [2]);

    assert.equal(await first, WAIT_IO_COMPLETION);
    assert.deepEqual(m.guest.map(call=>call.entry), [0x00405000, 0x00406000]);
});

test('QueueUserAPC refuses a handle that is not a thread, and a null routine', ()=>{
    const m = machine();

    assert.equal(m.apcs.table.QueueUserAPC.handler([0x00405000, 0x99, 0]), 0);
    assert.equal(m.apcs.table.QueueUserAPC.handler([0, 0x44, 0]), 0);
    assert.deepEqual(m.errors, [6, 6]);
});

test('SignalObjectAndWait signals by the object\'s kind, then waits', ()=>{
    const m = machine();

    m.apcs.table.SignalObjectAndWait.handler([0x50, 0x60, 10, 0]);
    m.apcs.table.SignalObjectAndWait.handler([0x54, 0x60, 10, 1]);
    m.apcs.table.SignalObjectAndWait.handler([0x58, 0x60, 10, 0]);

    assert.deepEqual(m.calls.map(call=>[call.name, call.args, call.alertable]), [
        ['SetEvent', [0x50], false], ['WaitForSingleObject', [0x60, 10], false],
        ['ReleaseMutex', [0x54], false], ['WaitForSingleObject', [0x60, 10], true],
        ['ReleaseSemaphore', [0x58, 1, 0], false], ['WaitForSingleObject', [0x60, 10], false],
    ]);
    assert.equal(m.apcs.table.SignalObjectAndWait.handler([0x44, 0x60, 10, 0]), 0xffffffff,
        'a thread cannot be signalled');
});

test('MsgWaitForMultipleObjectsEx reads wait-all and alertable out of its flags', ()=>{
    const m = machine();

    m.apcs.user32.MsgWaitForMultipleObjectsEx.handler([2, 0x3000, 50, 0xff, 0x3]);

    assert.deepEqual(m.calls, [{
        name: 'MsgWaitForMultipleObjects', args: [2, 0x3000, 1, 50, 0xff], alertable: true,
    }]);
});

test('every entry pops its own stdcall bytes', ()=>{
    const { apcs } = machine();
    assert.equal(apcs.table.QueueUserAPC.argBytes, 12);
    assert.equal(apcs.table.SleepEx.argBytes, 8);
    assert.equal(apcs.table.WaitForSingleObjectEx.argBytes, 12);
    assert.equal(apcs.table.WaitForMultipleObjectsEx.argBytes, 20);
    assert.equal(apcs.table.SignalObjectAndWait.argBytes, 16);
    assert.equal(apcs.user32.MsgWaitForMultipleObjectsEx.argBytes, 20);
});

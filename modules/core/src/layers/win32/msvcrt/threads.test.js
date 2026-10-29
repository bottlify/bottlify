/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadFunctions } from './threads.js';
import { fakeMemory } from './harness.test.js';

function build(){
    /** @type {any[]} */
    const started = [];
    /** @type {number[]} */
    const ended = [];
    const PARKED = { parked: true };
    const fns = createThreadFunctions({
        start: request=>{
            started.push(request);
            return request.entry === 0 ? 0 : 0x190 + started.length * 4;
        },
        exit: code=>{
            ended.push(code);
            return PARKED;
        },
    });
    return { fns, started, ended, PARKED };
}

test('_beginthread makes the thread CreateThread makes, and -1 says it could not', ()=>{
    const { fns, started } = build();
    assert.equal(fns._beginthread.handler([0x401000, 0x8000, 0x1234]), 0x194);
    assert.deepEqual(started, [{ entry: 0x401000, stackSize: 0x8000, parameter: 0x1234,
        threadIdOut: 0, flags: 0 }], 'without the runtime\'s start routine, the routine itself');
    assert.equal(fns._beginthread.handler([0, 0, 0]), -1);
    assert.equal(fns._beginthread.convention, 'cdecl');
    assert.equal(fns._beginthread.argBytes, 12);
});

test('_beginthreadex passes the id slot through and answers the handle, zero on failure', ()=>{
    const { fns, started } = build();
    assert.equal(fns._beginthreadex.handler([0, 0x1000, 0x402000, 0x99, 0, 0x5000]), 0x194);
    assert.equal(started[0].threadIdOut, 0x5000);
    assert.equal(started[0].flags, 0);
    assert.equal(fns._beginthreadex.handler([0, 0, 0, 0, 0, 0]), 0);
    const CREATE_SUSPENDED = 4;
    fns._beginthreadex.handler([0, 0, 0x402000, 0, CREATE_SUSPENDED, 0]);
    assert.equal(started.at(-1).flags, CREATE_SUSPENDED, 'a suspended thread is made suspended');
    assert.equal(fns._beginthreadex.argBytes, 24);
});

test('a runtime thread ends through the kernel, and the call does not return', ()=>{
    const { fns, ended, PARKED } = build();
    assert.equal(fns._endthreadex.handler([7]), PARKED);
    assert.equal(fns._endthread.handler([]), PARKED);
    assert.deepEqual(ended, [7, 0]);
    assert.deepEqual([fns._endthread.argBytes, fns._endthreadex.argBytes], [0, 4]);
});

test('_sleep waits through the kernel\'s Sleep, a request for none being one millisecond', ()=>{
    // msvcrt's _sleep never yields for nothing the way Sleep(0) does: zero
    // is taken as the shortest real wait.
    /** @type {number[]} */
    const slept = [];
    const PARKED = { parked: true };
    const fns = /** @type {Record<string, any>} */ (createThreadFunctions({
        start: ()=>0,
        exit: ()=>PARKED,
        sleep: milliseconds=>{
            slept.push(milliseconds);
            return PARKED;
        },
    }));
    assert.equal(fns._sleep.handler([250]), PARKED);
    assert.equal(fns._sleep.handler([0]), PARKED);
    assert.deepEqual(slept, [250, 1]);
    assert.deepEqual([fns._sleep.convention, fns._sleep.argBytes], ['cdecl', 4]);

    const without = /** @type {Record<string, any>} */ (createThreadFunctions({
        start: ()=>0, exit: ()=>PARKED,
    }));
    assert.equal(without._sleep, undefined, 'unexported without a way to wait');
});

test('_beginthread starts in the runtime\'s start routine, and _endthread closes its handle', ()=>{
    // Wine's msvcrt test_thread_handle_close: a _beginthread thread's handle
    // is closed when its routine returns or calls _endthread, not when it
    // ends by ExitThread or _endthreadex.
    const memory = fakeMemory();
    /** @type {any[]} */
    const started = [];
    /** @type {number[]} */
    const closed = [];
    /** @type {number[]} */
    const freed = [];
    let current = 0;
    const ENDTHREAD = 0x7f001234;
    const fns = /** @type {Record<string, any>} */ (createThreadFunctions({
        start: request=>{
            started.push(request);
            const id = 0x40 + started.length;
            memory.writeMemory(request.threadIdOut, Uint8Array.of(id, 0, 0, 0));
            return 0x200 + started.length * 4;
        },
        exit: ()=>0,
        runtime: {
            endthread: ()=>ENDTHREAD,
            allocate: bytes=>memory.allocate(bytes),
            free: address=>void freed.push(address),
            allocateCode: bytes=>memory.allocate(bytes),
            readMemory: memory.readMemory,
            writeMemory: memory.writeMemory,
            closeHandle: handle=>void closed.push(handle),
            currentThreadId: ()=>current,
        },
    }));
    const handle = fns._beginthread.handler([0x401000, 0, 0x1234]);
    const [request] = started;
    const code = memory.bytes.subarray(request.entry, request.entry + 20);
    assert.deepEqual([...code.subarray(12, 17)], [0xb8, 0x34, 0x12, 0x00, 0x7f],
        'the start routine ends in the runtime\'s _endthread');
    const block = request.parameter;
    assert.equal(memory.u32(block), 0x401000, 'the routine');
    assert.equal(memory.u32(block + 4), 0x1234, 'its argument');
    assert.equal(memory.u32(block + 8), handle, 'the handle _endthread closes');

    current = 0x41;
    fns._endthread.handler([]);
    assert.deepEqual(closed, [handle]);
    assert.deepEqual(freed, [block]);

    const second = fns._beginthread.handler([0x401000, 0, 0]);
    current = 0x42;
    fns._endthreadex.handler([0]);
    assert.deepEqual(closed, [handle], '_endthreadex leaves the handle open');
    assert.notEqual(second, 0);
    current = 0x99;
    fns._endthread.handler([]);
    assert.deepEqual(closed, [handle], 'a thread the runtime did not make keeps its handle');
});

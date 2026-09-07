/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadingFunctions } from './threading.js';

/**
 * A kernel stand-in with the same contract as the real one, so these tests are
 * about the translation between the guest's vocabulary and the kernel's, not
 * about scheduling.
 */
function fakeKernel(){
    /** @type {Map<number, { type: string, object: any }>} */
    const handles = new Map();
    let nextHandle = 4;
    const state = {
        created: /** @type {any[]} */ ([]),
        waits: /** @type {any[]} */ ([]),
        released: /** @type {any[]} */ ([]),
        exited: /** @type {any[]} */ ([]),
        threadIds: /** @type {any[]} */ ([]),
        /** Set this to make the next wait block. */
        waitBlocks: false,
    };

    const kernel = {
        state,
        /** @param {any} options */
        createThread(options){
            const thread = { id: state.created.length + 2, handle: nextHandle, ...options };
            handles.set(nextHandle, { type: 'thread', object: thread });
            nextHandle += 4;
            state.created.push(thread);
            return thread;
        },
        /** @param {number} address @param {number} id */
        writeThreadId: (address, id)=>state.threadIds.push({ address, id }),
        /** @param {any} options */
        createMutex: options=>({ kind: 'mutex', ...options }),
        /** @param {any} options */
        createEvent: options=>({ kind: 'event', ...options }),
        /** @param {any} object @param {any} thread */
        wait(object, thread){
            state.waits.push({ object, thread });
            return state.waitBlocks ? null : 0;
        },
        /** @param {any} object @param {any} thread */
        releaseMutex(object, thread){
            state.released.push({ object, thread });
            return true;
        },
        /** @param {any} event */
        setEvent: event=>state.waits.push({ set: event }),
        /** @param {any} event */
        resetEvent: event=>state.waits.push({ reset: event }),
        /** @param {any} thread @param {number} code */
        exitThread: (thread, code)=>state.exited.push({ thread, code }),
        handles: {
            /** @param {string} type @param {any} object */
            open(type, object){
                const handle = nextHandle;
                handles.set(handle, { type, object });
                nextHandle += 4;
                return handle;
            },
            /** @param {number} handle @param {string} [type] */
            resolve(handle, type){
                const entry = handles.get(handle);
                if (!entry)
                {
                    throw new Error('Invalid handle');
                }
                if (type && entry.type !== type)
                {
                    throw new Error('Wrong type');
                }
                return entry.object;
            },
            /** @param {number} handle */
            close(handle){
                if (!handles.delete(handle))
                {
                    throw new Error('Invalid handle');
                }
            },
        },
    };
    return kernel;
}

/** Stands in for the bridge's parked token: identity is all that matters. */
const PARKED = Object.freeze({ parked: true });

function setup(){
    const kernel = fakeKernel();
    const current = { name: 'caller' };
    /** @type {any[]} */
    const parked = [];
    /** What a handler wrote, by address, so a test can read an out-parameter. */
    /** @type {Map<number, Uint8Array>} */
    const written = new Map();
    /** @type {number[]} */
    const errors = [];
    const fns = createThreadingFunctions({
        kernel,
        readMemory: ()=>new Uint8Array(0),
        currentThread: ()=>current,
        park: thread=>{
            parked.push(thread ?? current);
            return PARKED;
        },
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>{
            written.set(address, bytes);
        },
        /** @param {number} code */
        setLastError: code=>{
            errors.push(code);
        },
    });
    return { kernel, fns, parked, current, written, errors };
}

test('CreateThread makes a thread and does not switch to it', ()=>{
    const { kernel, fns, parked } = setup();

    const handle = fns.CreateThread.handler([0, 0x10000, 0x401000, 0xdead, 0, 0]);

    assert.equal(kernel.state.created.length, 1);
    assert.equal(kernel.state.created[0].entry, 0x401000);
    assert.equal(kernel.state.created[0].parameter, 0xdead);
    assert.ok(handle > 0, 'the guest gets a handle back');
    assert.deepEqual(parked, [], 'the creating thread keeps running');
});

test('CreateThread fills in the thread id when asked, and not when not', ()=>{
    const { kernel, fns } = setup();

    fns.CreateThread.handler([0, 0, 0x401000, 0, 0, 0x405000]);
    assert.deepEqual(kernel.state.threadIds, [{ address: 0x405000, id: 2 }]);

    fns.CreateThread.handler([0, 0, 0x401000, 0, 0, 0]);
    assert.equal(kernel.state.threadIds.length, 1, 'a null pointer is not written through');
});

test('a wait that succeeds returns immediately', ()=>{
    const { kernel, fns, parked } = setup();
    const handle = fns.CreateEventA.handler([0, 1, 1, 0]);

    assert.equal(fns.WaitForSingleObject.handler([handle, 0xffffffff]), 0);
    assert.deepEqual(parked, [], 'nothing to wait for, so the thread runs on');
    assert.equal(kernel.state.waits.length, 1);
});

test('a wait that blocks parks the thread instead of returning', ()=>{
    const { kernel, fns, parked, current } = setup();
    kernel.state.waitBlocks = true;
    const handle = fns.CreateEventA.handler([0, 0, 0, 0]);

    const result = fns.WaitForSingleObject.handler([handle, 0xffffffff]);

    assert.deepEqual(parked, [current],
        'the thread stops where it stands; its result arrives on its next turn');
    assert.equal(result, PARKED,
        'what comes back is the token parking produced, not a stand-in value');
});

test('a bad handle is a return code, not a crash', ()=>{
    const { fns } = setup();
    assert.equal(fns.WaitForSingleObject.handler([0x9999, 0xffffffff]), 0xffffffff);
    assert.equal(fns.ReleaseMutex.handler([0x9999]), 0);
    assert.equal(fns.SetEvent.handler([0x9999]), 0);
    assert.equal(fns.CloseHandle.handler([0x9999]), 0);
});

test('a timed wait is refused rather than faked', ()=>{
    const { fns } = setup();
    const handle = fns.CreateEventA.handler([0, 0, 0, 0]);

    // Pretending a timeout elapsed, or that it never does, both produce programs
    // that look fine until they hang. Until the clock drives expiry, say so.
    assert.throws(()=>fns.WaitForSingleObject.handler([handle, 5000]),
        /only INFINITE and 0 are implemented/);
});

test('a mutex created with initial ownership is taken by its creator', ()=>{
    const { kernel, fns, current } = setup();

    fns.CreateMutexA.handler([0, 1, 0]);
    assert.equal(kernel.state.waits.length, 1, 'the creator acquires it');
    assert.equal(kernel.state.waits[0].thread, current);

    fns.CreateMutexA.handler([0, 0, 0]);
    assert.equal(kernel.state.waits.length, 1, 'without initial ownership, nobody takes it');
});

test('ExitThread ends the thread and parks it', ()=>{
    const { kernel, fns, parked, current } = setup();

    const result = fns.ExitThread.handler([7]);

    assert.deepEqual(kernel.state.exited, [{ thread: current, code: 7 }]);
    assert.deepEqual(parked, [current], 'it must not run on after ending');
    assert.equal(result, PARKED, 'a call that does not return has no value to return');
});

test('every function declares the stack it pops', ()=>{
    const { fns } = setup();
    // stdcall: the callee cleans up, so a wrong count corrupts the guest stack
    // silently. These are the documented signatures, in bytes.
    assert.equal(fns.CreateThread.argBytes, 24);
    assert.equal(fns.WaitForSingleObject.argBytes, 8);
    assert.equal(fns.CreateMutexA.argBytes, 12);
    assert.equal(fns.CreateEventA.argBytes, 16);
    assert.equal(fns.ReleaseMutex.argBytes, 4);
    assert.equal(fns.ExitThread.argBytes, 4);
    assert.equal(fns.CloseHandle.argBytes, 4);
});

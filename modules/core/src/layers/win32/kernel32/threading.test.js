/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadingFunctions } from './threading.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_ALREADY_EXISTS = 183;

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
        blocked: /** @type {any[]} */ ([]),
        threadIds: /** @type {any[]} */ ([]),
        /** Set this to make the next wait block. */
        waitBlocks: false,
        /** Guest time, which a deadline is measured against. */
        now: 0,
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
        /** @param {any} object @param {any} thread @param {any} [timed] */
        wait(object, thread, timed){
            state.waits.push({ object, thread, timed });
            return state.waitBlocks ? null : 0;
        },
        clock: { virtualTime: ()=>state.now },
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
        /** @param {any} thread @param {string} [reason] */
        block: (thread, reason)=>state.blocked.push({ thread, reason }),
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
            /** @param {number} handle */
            typeOf: handle=>handles.get(handle)?.type ?? null,
            /** @param {any} object */
            holds: object=>[...handles.values()].some(entry=>entry.object === object),
        },
    };
    return kernel;
}

/** Stands in for the bridge's parked token: identity is all that matters. */
const PARKED = Object.freeze({ parked: true });

/**
 * @param {Record<number, string>} [names] What each name pointer spells, for the
 *   tests that are about the Win32 object namespace. Every other test passes
 *   nothing and every pointer reads as the empty name, which is no name at all.
 */
function setup(names){
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
        /** @param {number} pointer */
        readCString: pointer=>names?.[pointer] ?? '',
        /** @param {number} code */
        setLastError: code=>{
            errors.push(code);
        },
        /** @param {number} handle */
        handleType: handle=>kernel.handles.typeOf(handle),
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

test('waiting on a child process is where the parent hands over', ()=>{
    // Nothing in this process can ever signal a child: the child takes this
    // process's place rather than running beside it. So the thread stops here
    // for good, and the replacement is what happens instead of the wait
    // returning. Left to the ordinary path, this would join a queue on an
    // object with no signal and be reported as a deadlock.
    const { kernel, fns, parked, current } = setup();
    const child = { imagePath: 'C:\\App\\child.exe' };
    const handle = kernel.handles.open('process', child);

    assert.equal(fns.WaitForSingleObject.handler([handle, 0xffffffff]), PARKED);
    assert.deepEqual(parked, [current]);
    assert.equal(kernel.state.blocked.length, 1);
    assert.equal(kernel.state.blocked[0].thread, current);
    assert.equal(kernel.state.waits.length, 0, 'and it never joined a wait queue');
});

test('polling a child process says it is still running', ()=>{
    // A zero timeout is a question, not a wait. Parking on it would stop a
    // parent that was only checking whether its child had finished.
    const { kernel, fns, parked } = setup();
    const handle = kernel.handles.open('process', { imagePath: 'C:\\App\\child.exe' });

    assert.equal(fns.WaitForSingleObject.handler([handle, 0]), 0x102);
    assert.deepEqual(parked, []);
    assert.deepEqual(kernel.state.blocked, []);
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

test('a timed wait carries a deadline, and a zero one is a poll', ()=>{
    const { fns, kernel } = setup();
    const state = kernel.state;
    const handle = fns.CreateEventA.handler([0, 0, 0, 0]);
    state.now = 1000;

    state.waitBlocks = true;
    fns.WaitForSingleObject.handler([handle, 5000]);
    assert.deepEqual(state.waits.at(-1).timed, { deadline: 6000, result: 0x102 },
        'the deadline is guest time, not a duration: the scheduler compares, it does not count');

    // Zero asks whether the object is available now. A program checking must
    // not be stopped by the question, so an unavailable object answers at once.
    assert.equal(fns.WaitForSingleObject.handler([handle, 0]), 0x102);

    // INFINITE carries no deadline at all rather than one far away, so nothing
    // downstream has to know how far away is far enough.
    fns.WaitForSingleObject.handler([handle, 0xffffffff]);
    assert.equal(state.waits.at(-1).timed, undefined);
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

test('a second create of a live name hands back the same object', ()=>{
    const NAME = 0x2000;
    const { fns, errors } = setup({ [NAME]: 'Warcraft III' });

    const first = fns.CreateMutexA.handler([0, 0, NAME]);
    assert.equal(errors.at(-1), ERROR_SUCCESS, 'nothing held the name yet');

    const second = fns.CreateMutexA.handler([0, 0, NAME]);
    assert.notEqual(second, first, 'a create always returns a handle of its own');
    assert.equal(errors.at(-1), ERROR_ALREADY_EXISTS,
        'the single-instance idiom reads exactly this');
});

test('a name lives only as long as a handle to the object behind it', ()=>{
    const NAME = 0x2000;
    const { fns, errors } = setup({ [NAME]: 'Warcraft III' });

    // The idiom in full: probe for a first copy, close the probe, then create
    // the object for real. The second create must not be told its own probe
    // took the name, or the program exits believing it is the second copy.
    const probe = fns.CreateMutexA.handler([0, 0, NAME]);
    fns.CloseHandle.handler([probe]);
    fns.CreateMutexA.handler([0, 0, NAME]);

    assert.equal(errors.at(-1), ERROR_SUCCESS);
});

test('a name taken by one kind of object is not a match for another', ()=>{
    const NAME = 0x2000;
    const { kernel, fns, errors } = setup({ [NAME]: 'shared' });

    const mutex = fns.CreateMutexA.handler([0, 0, NAME]);

    assert.equal(fns.CreateEventA.handler([0, 0, 0, NAME]), 0,
        'the name is not the event\'s to take');
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(fns.OpenEventA.handler([0, 0, NAME]), 0, 'nor is the mutex openable as an event');
    assert.equal(
        kernel.handles.resolve(fns.OpenMutexA.handler([0, 0, NAME]), 'mutex'),
        kernel.handles.resolve(mutex, 'mutex'),
        'and the mutex keeps the name it holds',
    );
});

test('OpenEventA finds an event created by name', ()=>{
    const NAME = 0x2000;
    const { kernel, fns } = setup({ [NAME]: 'ready' });

    const created = fns.CreateEventA.handler([0, 1, 0, NAME]);
    const opened = fns.OpenEventA.handler([0, 0, NAME]);

    assert.notEqual(opened, 0);
    assert.notEqual(opened, created, 'opening yields a second handle, not the first');
    assert.equal(
        kernel.handles.resolve(opened, 'event'),
        kernel.handles.resolve(created, 'event'),
        'both handles name one object, which is what makes the signal shared',
    );
});

test('OpenEventA reports no such thing for a name nothing created', ()=>{
    const NAME = 0x2000;
    const { fns, errors } = setup({ [NAME]: 'never-made' });

    assert.equal(fns.OpenEventA.handler([0, 0, NAME]), 0);
    assert.equal(errors.at(-1), ERROR_FILE_NOT_FOUND,
        'a caller must tell this apart from a failure to open');
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
    assert.equal(fns.OpenEventA.argBytes, 12);
    assert.equal(fns.OpenMutexA.argBytes, 12);
});

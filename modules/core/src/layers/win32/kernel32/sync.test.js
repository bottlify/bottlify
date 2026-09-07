/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncFunctions } from './sync.js';

const CS_LOCK_COUNT = 0x04;
const CS_RECURSION_COUNT = 0x08;
const CS_OWNING_THREAD = 0x0c;
const CS_SPIN_COUNT = 0x14;
const CS_UNLOCKED = -1;

const INFINITE = 0xffffffff;
const WAIT_OBJECT_0 = 0x00000000;
const WAIT_ABANDONED_0 = 0x00000080;
const WAIT_TIMEOUT = 0x00000102;
const WAIT_FAILED = 0xffffffff;

/** What the bridge hands back for a call that cannot answer yet. */
const PARKED = Object.freeze({ parked: true });

/**
 * A kernel stand-in that models mutex ownership the way the real one does --
 * an owner, a recursion count, and a queue -- because these tests are about
 * what the guest's structure says at each transition, and that is derived from
 * exactly those three things.
 */
function fakeKernel(){
    const state = {
        /** @type {any[]} */ blocked: [],
        /** @type {any[]} */ woken: [],
        /** @type {number[]} */ advanced: [],
    };

    /** @param {any} object @param {any} thread */
    const acquire = (object, thread)=>{
        if (object.kind === 'mutex')
        {
            const abandoned = object.abandoned === true;
            object.owner = thread;
            object.recursion = 1;
            object.abandoned = false;
            return abandoned ? WAIT_ABANDONED_0 : WAIT_OBJECT_0;
        }
        if (object.kind === 'event' && !object.manualReset)
        {
            object.signalled = false;
        }
        if (object.kind === 'semaphore')
        {
            object.count--;
        }
        return WAIT_OBJECT_0;
    };

    /** @param {any} object */
    const signalled = object=>{
        switch (object.kind)
        {
            case 'mutex':
                return object.owner === null;
            case 'event':
                return object.signalled === true;
            case 'semaphore':
                return object.count > 0;
            default:
                return false;
        }
    };

    return {
        state,
        /** @param {any} options */
        createMutex: options=>(
            { kind: 'mutex', owner: null, recursion: 0, waiters: [], ...options }),
        /** @param {any} options */
        createEvent: options=>(
            { kind: 'event', signalled: false, manualReset: false, waiters: [], ...options }),
        /** @param {any} object @param {any} thread */
        wait(object, thread){
            if (object.kind === 'mutex' && object.owner === thread)
            {
                object.recursion++;
                return WAIT_OBJECT_0;
            }
            if (signalled(object))
            {
                return acquire(object, thread);
            }
            object.waiters.push(thread);
            state.blocked.push(thread);
            return null;
        },
        /** @param {any[]} objects @param {any} thread */
        waitAll(objects, thread){
            if (!objects.every(object=>
                signalled(object) || (object.kind === 'mutex' && object.owner === thread)))
            {
                state.blocked.push(thread);
                return null;
            }
            let result = WAIT_OBJECT_0;
            for (const object of objects)
            {
                if (this.wait(object, thread) === WAIT_ABANDONED_0)
                {
                    result = WAIT_ABANDONED_0;
                }
            }
            return result;
        },
        /** @param {any[]} objects @param {any} thread */
        waitAny(objects, thread){
            for (let at = 0; at < objects.length; at++)
            {
                const object = objects[at];
                if (signalled(object) || (object.kind === 'mutex' && object.owner === thread))
                {
                    return { index: at, result: this.wait(object, thread) };
                }
            }
            state.blocked.push(thread);
            return null;
        },
        /** @param {any} object @param {any} thread */
        releaseMutex(object, thread){
            if (object.owner !== thread)
            {
                return false;
            }
            object.recursion--;
            if (object.recursion > 0)
            {
                return true;
            }
            const next = object.waiters.shift() ?? null;
            object.owner = next;
            object.recursion = next ? 1 : 0;
            return true;
        },
        /** @param {any} thread @param {string} reason */
        block: (thread, reason)=>state.blocked.push({ thread, reason }),
        /** @param {any} thread */
        wake: thread=>state.woken.push(thread),
        /** @param {any} thread @param {number} code */
        exitThread: (thread, code)=>state.woken.push({ exited: thread, code }),
        handles: {
            /** @type {Map<number, { type: string, object: any }>} */
            table: new Map(),
            /** @param {number} handle @param {string} [type] */
            resolve(handle, type){
                const held = this.table.get(handle);
                if (!held || (type && held.type !== type))
                {
                    throw new Error(`bad handle ${handle}`);
                }
                return held.object;
            },
        },
    };
}

function fakeHost(){
    const bytes = new Uint8Array(0x1000);
    const kernel = fakeKernel();
    /** @type {{ first: any, second: any }} */
    const threads = { first: { id: 0x100 }, second: { id: 0x104 } };
    /** @type {any} */
    let current = threads.first;

    const host = {
        bytes,
        kernel,
        threads,
        /** @param {any} thread */
        run: thread=>{
            current = thread;
        },
        currentThread: ()=>current,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory(address, data){
            bytes.set(data, address);
        },
        park: ()=>PARKED,
        /** @param {number} milliseconds */
        advanceClock: milliseconds=>kernel.state.advanced.push(milliseconds),
        /** @param {number} address */
        readI32: address=>new DataView(bytes.buffer).getInt32(address, true),
        /** @param {number} handle @param {string} type @param {any} object */
        register(handle, type, object){
            kernel.handles.table.set(handle, { type, object });
            return object;
        },
    };
    return host;
}

test('a critical section is initialised in the guest structure, not beside it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const section = 0x200;

    // Whatever was in the guest's memory before must be gone: this is a struct
    // it allocated, and stale bytes read as a section somebody already holds.
    host.bytes.fill(0xcc, section, section + 0x18);

    fns.InitializeCriticalSection.handler([section]);
    assert.equal(host.readI32(section + CS_LOCK_COUNT), CS_UNLOCKED);
    assert.equal(host.readI32(section + CS_RECURSION_COUNT), 0);
    assert.equal(host.readI32(section + CS_OWNING_THREAD), 0);
});

test('entering a section writes the owner and the count a runtime reads back', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const section = 0x200;

    fns.InitializeCriticalSection.handler([section]);
    fns.EnterCriticalSection.handler([section]);

    assert.equal(host.readI32(section + CS_LOCK_COUNT), 0, 'held');
    assert.equal(host.readI32(section + CS_RECURSION_COUNT), 1);
    assert.equal(host.readI32(section + CS_OWNING_THREAD), host.threads.first.id);
});

test('a section is recursive, and only the matching leave releases it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const section = 0x200;

    fns.InitializeCriticalSection.handler([section]);
    fns.EnterCriticalSection.handler([section]);
    fns.EnterCriticalSection.handler([section]);
    assert.equal(host.readI32(section + CS_RECURSION_COUNT), 2);

    fns.LeaveCriticalSection.handler([section]);
    assert.equal(host.readI32(section + CS_RECURSION_COUNT), 1,
        'one leave of two does not release it');
    assert.equal(host.readI32(section + CS_OWNING_THREAD), host.threads.first.id);

    fns.LeaveCriticalSection.handler([section]);
    assert.equal(host.readI32(section + CS_LOCK_COUNT), CS_UNLOCKED, 'and the second does');
    assert.equal(host.readI32(section + CS_OWNING_THREAD), 0);
});

test('a thread that cannot take a section is parked, and told when it wins', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const section = 0x200;

    fns.InitializeCriticalSection.handler([section]);
    fns.EnterCriticalSection.handler([section]);

    host.run(host.threads.second);
    assert.equal(fns.EnterCriticalSection.handler([section]), PARKED);
    assert.equal(host.readI32(section + CS_OWNING_THREAD), host.threads.first.id,
        'the structure still describes the thread that holds it');

    // The leaving thread writes the structure for whoever the kernel handed it
    // to: the winner's own call has already returned and cannot do it.
    host.run(host.threads.first);
    fns.LeaveCriticalSection.handler([section]);
    assert.equal(host.readI32(section + CS_OWNING_THREAD), host.threads.second.id);
    assert.equal(host.readI32(section + CS_RECURSION_COUNT), 1);
});

test('a spin count is recorded where a guest looks for it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);

    assert.equal(fns.InitializeCriticalSectionAndSpinCount.handler([0x200, 4000]), 1);
    assert.equal(host.readI32(0x200 + CS_SPIN_COUNT), 4000);
    assert.equal(host.readI32(0x200 + CS_LOCK_COUNT), CS_UNLOCKED);
});

test('trying a held section fails without blocking', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const section = 0x200;

    fns.InitializeCriticalSection.handler([section]);
    assert.equal(fns.TryEnterCriticalSection.handler([section]), 1, 'free: taken');

    host.run(host.threads.second);
    assert.equal(fns.TryEnterCriticalSection.handler([section]), 0, 'held: refused');
    assert.equal(host.kernel.state.blocked.length, 0, 'and nothing was queued');
});

test('increment and decrement answer with the value after, exchange with the value before', ()=>{
    // The two families disagree on purpose, and getting it backwards is a
    // reference count that releases one object early -- a long way from here.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const counter = 0x300;

    new DataView(host.bytes.buffer).setInt32(counter, 7, true);
    assert.equal(fns.InterlockedIncrement.handler([counter]), 8);
    assert.equal(fns.InterlockedDecrement.handler([counter]), 7);

    assert.equal(fns.InterlockedExchange.handler([counter, 99]), 7, 'the value it replaced');
    assert.equal(host.readI32(counter), 99);

    assert.equal(fns.InterlockedCompareExchange.handler([counter, 1, 99]), 99);
    assert.equal(host.readI32(counter), 1, 'the comparand matched, so it exchanged');

    assert.equal(fns.InterlockedCompareExchange.handler([counter, 2, 99]), 1);
    assert.equal(host.readI32(counter), 1, 'and did not, so it did not');
});

test('interlocked arithmetic wraps at 32 bits rather than growing', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const counter = 0x300;

    new DataView(host.bytes.buffer).setInt32(counter, 0x7fffffff, true);
    assert.equal(fns.InterlockedIncrement.handler([counter]) | 0, -0x80000000);
});

test('waiting for all of several objects reports one answer, not an index', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const first = host.kernel.createEvent({ signalled: true, manualReset: true });
    const second = host.kernel.createEvent({ signalled: true, manualReset: true });
    host.register(0x10, 'event', first);
    host.register(0x14, 'event', second);

    const array = 0x400;
    const view = new DataView(host.bytes.buffer);
    view.setUint32(array, 0x10, true);
    view.setUint32(array + 4, 0x14, true);

    assert.equal(fns.WaitForMultipleObjects.handler([2, array, 1, INFINITE]), WAIT_OBJECT_0);
});

test('waiting for any one of them reports which one, as an offset from the base', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const first = host.kernel.createEvent({ signalled: false });
    const second = host.kernel.createEvent({ signalled: true });
    host.register(0x10, 'event', first);
    host.register(0x14, 'event', second);

    const array = 0x400;
    const view = new DataView(host.bytes.buffer);
    view.setUint32(array, 0x10, true);
    view.setUint32(array + 4, 0x14, true);

    assert.equal(fns.WaitForMultipleObjects.handler([2, array, 0, INFINITE]),
        WAIT_OBJECT_0 + 1, 'the second one, which is what makes it a base');
});

test('a zero timeout that finds nothing ready times out instead of blocking', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: false }));
    new DataView(host.bytes.buffer).setUint32(0x400, 0x10, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_TIMEOUT);
    assert.equal(host.kernel.state.blocked.length, 0, 'and did not join the queue');
    assert.deepEqual(host.kernel.state.advanced, [], 'nor credit a clock it never waited on');
});

test('a zero timeout that finds an object ready still takes it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const event = host.kernel.createEvent({ signalled: true });
    host.register(0x10, 'event', event);
    new DataView(host.bytes.buffer).setUint32(0x400, 0x10, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_OBJECT_0);
    assert.equal(event.signalled, false, 'an auto-reset event was consumed, not merely peeked');
});

test('a finite timeout credits the clock for the time it reports having waited', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: false }));
    new DataView(host.bytes.buffer).setUint32(0x400, 0x10, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 250]), WAIT_TIMEOUT);
    assert.deepEqual(host.kernel.state.advanced, [250],
        'a guest timing its own loop must not see the wait take no time at all');
});

test('a wait on nothing, or on too much, fails rather than guessing', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);

    assert.equal(fns.WaitForMultipleObjects.handler([0, 0x400, 0, INFINITE]), WAIT_FAILED);
    assert.equal(fns.WaitForMultipleObjects.handler([65, 0x400, 0, INFINITE]), WAIT_FAILED);
});

test('suspending another thread reports the count before, and resuming undoes it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const other = host.threads.second;
    host.register(0x20, 'thread', other);

    assert.equal(fns.SuspendThread.handler([0x20]), 0, 'nobody had suspended it yet');
    assert.equal(fns.SuspendThread.handler([0x20]), 1, 'and now one caller had');
    assert.equal(other.suspendCount, 2);

    assert.equal(fns.ResumeThread.handler([0x20]), 2);
    assert.equal(fns.ResumeThread.handler([0x20]), 1);
    assert.equal(other.suspendCount, 0);
    assert.equal(host.kernel.state.woken.includes(other), true, 'and it was woken exactly once');
});

test('argument sizes match what the guest compiled against', ()=>{
    const fns = createSyncFunctions(fakeHost());

    assert.equal(fns.InitializeCriticalSection.argBytes, 4);
    assert.equal(fns.InitializeCriticalSectionAndSpinCount.argBytes, 8);
    assert.equal(fns.InterlockedIncrement.argBytes, 4);
    assert.equal(fns.InterlockedExchange.argBytes, 8);
    assert.equal(fns.InterlockedCompareExchange.argBytes, 12);
    assert.equal(fns.WaitForMultipleObjects.argBytes, 16);
    assert.equal(fns.GetCurrentThread.argBytes, 0);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncNatives } from './sync-natives.js';
import { createNamedObjects } from './named-objects.js';
import { STATUS } from '../ntdll/status.js';

const OBJ_OPENIF = 0x80;
const PARKED = Object.freeze({ parked: true });

/**
 * A machine with guest memory, a handle table and the four creates over a
 * named-object table, as kernel32's are.
 */
function setup(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let next = 0x100;
    /** @type {Map<number, { kind: string, object: any, access?: number | null }>} */
    const handles = new Map();
    /** @type {any[]} */
    const blocked = [];
    /** @type {((thread: any) => void) | null} */
    let timedOut = null;
    /** @type {any[]} */
    const woken = [];
    const main = { name: 'main' };
    let current = main;
    const kernel = {
        clock: { virtualTime: ()=>0, wallClock: ()=>0 },
        handles: {
            /** @param {string} kind @param {any} object @param {number | null} [access] */
            open: (kind, object, access = null)=>{
                handles.set(next, { kind, object, access });
                return (next += 4) - 4;
            },
            /** @param {number} handle */
            access: handle=>handles.get(handle)?.access ?? null,
        },
        /** @param {any} options */
        createEvent: options=>({ ...options }),
        /** @param {(thread: any) => void} handler */
        onTimeout: handler=>{
            timedOut = handler;
        },
        /** @param {any} thread @param {() => any} wait */
        alertably: (thread, wait)=>wait(),
        /** @param {any} event */
        setEvent: event=>{
            event.signalled = true;
        },
        /** @param {any} event */
        resetEvent: event=>{
            event.signalled = false;
        },
        /** @param {any} mutex @param {any} thread */
        releaseMutex: (mutex, thread)=>{
            if (mutex.owner !== thread)
            {
                return false;
            }
            if (--mutex.recursion === 0)
            {
                mutex.owner = null;
            }
            return true;
        },
        /** @param {any} semaphore @param {number} count */
        releaseSemaphore: (semaphore, count)=>{
            const previous = semaphore.count;
            semaphore.count += count;
            return previous;
        },
        /** @param {any} thread @param {string} reason @param {any} [timed] */
        block: (thread, reason, timed)=>{
            blocked.push({ thread, timed });
        },
        /** @param {any} thread @param {number} result */
        wake: (thread, result)=>{
            woken.push({ thread, result });
            return true;
        },
    };
    const named = createNamedObjects();
    /**
     * @param {string} kind @param {object} fields
     * @returns {(name: string | null) => number}
     */
    const make = (kind, fields)=>name=>{
        const object = { kind, ...fields };
        named.remember(name, kind, object, false, ()=>{});
        return kernel.handles.open(kind, object);
    };
    const natives = createSyncNatives({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        kernel,
        creates: {
            /** @param {string | null} name @param {boolean} owned */
            mutex: (name, owned)=>make('mutex', { owner: owned ? current : null,
                recursion: owned ? 1 : 0 })(name),
            /** @param {string | null} name @param {boolean} manual @param {boolean} initial */
            event: (name, manual, initial)=>make('event', { manualReset: manual,
                signalled: initial })(name),
            /** @param {string | null} name @param {number} initial @param {number} maximum */
            semaphore: (name, initial, maximum)=>make('semaphore', { count: initial,
                maximum })(name),
            /** @param {string | null} name @param {boolean} manual */
            timer: (name, manual)=>make('timer', { manualReset: manual, signalled: false,
                due: null })(name),
            /**
             * @param {string | null} name @param {number} sd @param {boolean} inherit
             * @param {number | null} granted
             */
            keyedEvent: (name, sd, inherit, granted)=>{
                const object = { kind: 'keyedevent', keyed: { waiting: [], releasing: [] } };
                named.remember(name, 'keyedevent', object, false, ()=>{});
                return kernel.handles.open('keyedevent', object, granted);
            },
        },
        existing: named.existing,
        reference: ()=>{},
        object: (handle, kind)=>{
            const entry = handles.get(handle);
            return entry && (!kind || entry.kind === kind) ? entry.object : null;
        },
        currentThread: ()=>current,
        park: ()=>PARKED,
    });
    /**
     * An OBJECT_ATTRIBUTES naming `name` at 0x1000, its UNICODE_STRING at
     * 0x1100 and the characters at 0x1200.
     *
     * @param {string | null} name @param {number} [flags]
     */
    const attributes = (name, flags = 0)=>{
        view.setUint32(0x1000, 24, true);
        view.setUint32(0x1004, 0, true);
        view.setUint32(0x1008, name === null ? 0 : 0x1100, true);
        view.setUint32(0x100c, flags, true);
        if (name !== null)
        {
            view.setUint16(0x1100, name.length * 2, true);
            view.setUint32(0x1104, 0x1200, true);
            [...name].forEach((c, i)=>view.setUint16(0x1200 + i * 2, c.charCodeAt(0), true));
        }
        return 0x1000;
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>/** @type {any} */ (natives)[name].handler(args);
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    const i32 = (/** @type {number} */ at)=>view.getInt32(at, true);
    const other = { name: 'other' };
    return { call, attributes, u32, i32, handles, woken, main, other, blocked, view,
        /** @param {any} thread */
        timeOut: thread=>timedOut?.(thread),
        /** @param {any} thread */
        become: thread=>{
            current = thread;
        } };
}

test('a native create makes a named object once; again it collides, or opens with OBJ_OPENIF',
    ()=>{
        const { call, attributes, u32, handles } = setup();
        const name = '\\BaseNamedObjects\\testEvent';
        assert.equal(call('NtCreateEvent', [0x2000, 0, attributes(name), 2, 0]),
            STATUS.INVALID_PARAMETER, 'an event type that is neither');
        assert.equal(call('NtCreateEvent', [0x2000, 0, attributes(name), 0, 0]), STATUS.SUCCESS);
        const first = handles.get(u32(0x2000))?.object;
        assert.equal(call('NtCreateEvent', [0x2004, 0, attributes(name), 0, 0]),
            STATUS.OBJECT_NAME_COLLISION);
        assert.equal(call('NtCreateEvent', [0x2004, 0, attributes(name, OBJ_OPENIF), 0, 0]),
            STATUS.OBJECT_NAME_EXISTS);
        assert.equal(handles.get(u32(0x2004))?.object, first, 'the object its name held');
        assert.equal(call('NtCreateMutant', [0x2008, 0, attributes(name), 0]),
            STATUS.OBJECT_TYPE_MISMATCH, 'the name holds an event');
        assert.equal(call('NtOpenEvent', [0x200c, 0x1f0003, attributes('\\BaseNamedObjects\\no')]),
            STATUS.OBJECT_NAME_NOT_FOUND);
        assert.equal(call('NtCreateEvent', [0x2010, 0, attributes('\\Elsewhere\\x'), 0, 0]),
            STATUS.OBJECT_PATH_NOT_FOUND, 'a path outside the Win32 directory');
    });

test('a set, reset and pulse hand back the state they found; a query says type and state', ()=>{
    const { call, attributes, u32, i32 } = setup();
    call('NtCreateEvent', [0x2000, 0, attributes(null), 1, 0]);
    const event = u32(0x2000);
    assert.equal(call('NtSetEvent', [event, 0x2100]), STATUS.SUCCESS);
    assert.equal(i32(0x2100), 0);
    assert.equal(call('NtSetEvent', [event, 0x2100]), STATUS.SUCCESS);
    assert.equal(i32(0x2100), 1);
    assert.equal(call('NtPulseEvent', [event, 0x2100]), STATUS.SUCCESS);
    assert.equal(i32(0x2100), 1, 'signalled before the pulse');
    assert.equal(call('NtQueryEvent', [event, 0, 0x2200, 8, 0]), STATUS.SUCCESS);
    assert.deepEqual([u32(0x2200), u32(0x2204)], [1, 0], 'synchronization, left unsignalled');
    assert.equal(call('NtQueryEvent', [event, 0, 0x2200, 4, 0]), STATUS.INFO_LENGTH_MISMATCH);
    assert.equal(call('NtSetEvent', [0x9999, 0]), STATUS.INVALID_HANDLE);
});

test('a mutant released hands back its signal state; by a thread not owning it, refused', ()=>{
    const { call, attributes, u32, i32, become, other } = setup();
    call('NtCreateMutant', [0x2000, 0, attributes(null), 1]);
    const mutant = u32(0x2000);
    assert.equal(call('NtQueryMutant', [mutant, 0, 0x2200, 8, 0]), STATUS.SUCCESS);
    assert.equal(i32(0x2200), 0, 'owned once');
    become(other);
    assert.equal(call('NtReleaseMutant', [mutant, 0x2100]), STATUS.MUTANT_NOT_OWNED);
});

test('a semaphore past its maximum releases nothing; within it, the count before', ()=>{
    const { call, attributes, u32 } = setup();
    assert.equal(call('NtCreateSemaphore', [0x2000, 0, attributes(null), 2, 1]),
        STATUS.INVALID_PARAMETER, 'an initial count above the maximum');
    call('NtCreateSemaphore', [0x2000, 0, attributes(null), 1, 3]);
    const semaphore = u32(0x2000);
    assert.equal(call('NtReleaseSemaphore', [semaphore, 3, 0x2100]),
        STATUS.SEMAPHORE_LIMIT_EXCEEDED);
    assert.equal(call('NtReleaseSemaphore', [semaphore, 2, 0x2100]), STATUS.SUCCESS);
    assert.equal(u32(0x2100), 1);
    assert.equal(call('NtQuerySemaphore', [semaphore, 0, 0x2200, 8, 0]), STATUS.SUCCESS);
    assert.deepEqual([u32(0x2200), u32(0x2204)], [3, 3]);
});

test('a resource is shared beside sharers, exclusive alone, and handed to who waits for it',
    ()=>{
        const { call, woken, become, main, other } = setup();
        call('RtlInitializeResource', [0x3000]);
        assert.equal(call('RtlAcquireResourceShared', [0x3000, 0]), 1);
        assert.equal(call('RtlAcquireResourceShared', [0x3000, 0]), 1);
        assert.equal(call('RtlAcquireResourceExclusive', [0x3000, 0]), 0, 'shared already');
        become(other);
        assert.equal(call('RtlAcquireResourceExclusive', [0x3000, 1]), PARKED, 'it waits');
        become(main);
        call('RtlReleaseResource', [0x3000]);
        assert.deepEqual(woken, [], 'a sharer still holds it');
        call('RtlReleaseResource', [0x3000]);
        assert.deepEqual(woken, [{ thread: other, result: 1 }], 'handed on, the acquire TRUE');
        assert.equal(call('RtlAcquireResourceShared', [0x3000, 0]), 0, 'held exclusively now');
        become(other);
        assert.equal(call('RtlAcquireResourceShared', [0x3000, 0]), 1,
            'the exclusive holder takes it shared as once more exclusively');
    });

test('a keyed event pairs a wait with a release of the same key, whichever comes first', ()=>{
    const { call, attributes, u32, woken, become, main, other, blocked, view } = setup();
    const name = '\\BaseNamedObjects\\keyed';
    assert.equal(call('NtCreateKeyedEvent', [0x2000, 0xf0003, attributes(name), 1]),
        STATUS.INVALID_PARAMETER, 'flags are reserved');
    assert.equal(call('NtCreateKeyedEvent', [0x2000, 0xf0003, attributes(name), 0]),
        STATUS.SUCCESS);
    const handle = u32(0x2000);
    assert.equal(call('NtWaitForKeyedEvent', [handle, 255, 0, 0]), 0xc00000ef,
        'an odd key, before the handle is looked at');
    assert.equal(call('NtReleaseKeyedEvent', [0xdeadbeef, 9, 0, 0]), 0xc00000ef);
    assert.equal(call('NtReleaseKeyedEvent', [0xdeadbeef, 8, 0, 0]), STATUS.INVALID_HANDLE);

    assert.equal(call('NtWaitForKeyedEvent', [handle, 8, 0, 0]), PARKED, 'nobody released 8');
    become(other);
    assert.equal(call('NtReleaseKeyedEvent', [handle, 6, 0, 0]), PARKED, 'nobody waits on 6');
    become(main);
    assert.equal(call('NtWaitForKeyedEvent', [handle, 6, 0, 0]), STATUS.SUCCESS,
        'the release of 6 was parked');
    assert.deepEqual(woken, [{ thread: other, result: STATUS.SUCCESS }]);
    assert.equal(call('NtReleaseKeyedEvent', [handle, 8, 0, 0]), STATUS.SUCCESS);
    assert.deepEqual(woken[1], { thread: main, result: STATUS.SUCCESS }, 'the waiter on 8');

    view.setBigInt64(0x2100, -10000n, true);
    blocked.length = 0;
    assert.equal(call('NtWaitForKeyedEvent', [handle, 4, 0, 0x2100]), PARKED);
    assert.equal(blocked[0].timed.deadline, 1, 'a millisecond from now');
    assert.equal(blocked[0].timed.result, STATUS.TIMEOUT);
    become(other);
    view.setBigInt64(0x2108, 0n, true);
    assert.equal(call('NtReleaseKeyedEvent', [handle, 4, 0, 0x2108]), STATUS.SUCCESS,
        'the timed waiter on 4 is still parked');
});

test('a keyed event whose wait timed out is not released; its handle has the rights asked', ()=>{
    const { call, attributes, u32, woken, become, main, other, view, timeOut } = setup();
    const name = '\\BaseNamedObjects\\rights';
    view.setBigInt64(0x2100, 0n, true);
    call('NtCreateKeyedEvent', [0x2000, 0xf0003, attributes(name), 0]);
    const handle = u32(0x2000);
    assert.equal(call('NtWaitForKeyedEvent', [handle, 4, 0, 0x2100]), STATUS.TIMEOUT,
        'a zero time-out never parks');
    view.setBigInt64(0x2100, -10000n, true);
    assert.equal(call('NtWaitForKeyedEvent', [handle, 4, 0, 0x2100]), PARKED);
    timeOut(main);
    become(other);
    view.setBigInt64(0x2108, 0n, true);
    assert.equal(call('NtReleaseKeyedEvent', [handle, 4, 0, 0x2108]), STATUS.TIMEOUT,
        'the waiter that ran out of time is gone');
    assert.deepEqual(woken, []);

    call('NtCreateKeyedEvent', [0x2004, 0x1, attributes(null), 0]);
    assert.equal(call('NtReleaseKeyedEvent', [u32(0x2004), 8, 0, 0x2108]), STATUS.ACCESS_DENIED,
        'KEYEDEVENT_WAIT only');
    assert.equal(call('NtWaitForKeyedEvent', [u32(0x2004), 8, 0, 0x2108]), STATUS.TIMEOUT);
    call('NtCreateKeyedEvent', [0x2008, 0x40000000, attributes(null), 0]);
    assert.equal(call('NtWaitForKeyedEvent', [u32(0x2008), 8, 0, 0x2108]), STATUS.ACCESS_DENIED,
        'GENERIC_WRITE is KEYEDEVENT_WAKE');
    assert.equal(call('NtReleaseKeyedEvent', [0, 8, 0, 0x2108]), STATUS.TIMEOUT,
        'a NULL handle is the system\'s keyed event');
});

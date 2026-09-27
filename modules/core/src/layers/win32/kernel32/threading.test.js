/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadingFunctions } from './threading.js';
import { createNamedObjects } from './named-objects.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
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
        polls: /** @type {any[]} */ ([]),
        released: /** @type {any[]} */ ([]),
        exited: /** @type {any[]} */ ([]),
        blocked: /** @type {any[]} */ ([]),
        threadIds: /** @type {any[]} */ ([]),
        /** Threads a signal or a timeout released from a wait. */
        woken: /** @type {any[]} */ ([]),
        /** Every arm, in order: what due time and period the timer was given. */
        arms: /** @type {any[]} */ ([]),
        /** The armed timers the clock below fires. */
        timers: /** @type {any[]} */ ([]),
        /** Threads parked on a wait, with the deadline that ends it. */
        parked: /** @type {any[]} */ ([]),
        /** Set this to make the next wait block. */
        waitBlocks: false,
        /** Guest time, which a deadline is measured against. */
        now: 0,
    };

    /** @param {any} object @param {any} thread */
    const acquire = (object, thread)=>{
        if (object.kind === 'mutex')
        {
            const abandoned = object.abandoned === true;
            object.owner = thread;
            object.recursion = 1;
            object.abandoned = false;
            return abandoned ? 0x80 : 0;
        }
        // An auto-reset event and a synchronisation timer are reset by the
        // wait that takes them; a manual-reset one stays signalled.
        if ((object.kind === 'event' || object.kind === 'timer') && !object.manualReset)
        {
            object.signalled = false;
        }
        return 0;
    };

    /** @param {any} object */
    const signalled = object=>{
        if (object.kind === 'mutex')
        {
            return object.owner === null;
        }
        return object.kind === 'event' || object.kind === 'timer'
            ? object.signalled === true
            : false;
    };

    /** @param {any} thread @param {number} result */
    const wake = (thread, result)=>{
        thread.waitResult = result;
        const at = state.parked.findIndex(entry=>entry.thread === thread);
        if (at >= 0)
        {
            state.parked.splice(at, 1);
        }
        state.woken.push(thread);
    };

    /**
     * The clock setting an object signalled, releasing waiters the way the
     * real kernel does: everyone for a manual-reset object, one for an
     * auto-reset one, which then closes again.
     *
     * @param {any} object
     */
    const signal = object=>{
        object.signalled = true;
        if (object.manualReset)
        {
            for (const thread of object.waiters.splice(0))
            {
                wake(thread, 0);
            }
        }
        else
        {
            const thread = object.waiters.shift();
            if (thread)
            {
                object.signalled = false;
                wake(thread, 0);
            }
        }
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
        createMutex: options=>({
            kind: 'mutex', owner: null, recursion: 0, abandoned: false, waiters: [], ...options,
        }),
        /** @param {any} options */
        createEvent: options=>(
            { kind: 'event', signalled: false, manualReset: false, waiters: [], ...options }),
        /** @param {any} options */
        createSemaphore: options=>({ kind: 'semaphore', waiters: [], ...options }),
        /** @param {any} options */
        createTimer: options=>(
            { kind: 'timer', signalled: false, manualReset: false, waiters: [], ...options }),
        /**
         * Registers a timer with the fake clock. The clock is what makes the
         * signal a property of the object: it fires whether or not a thread
         * was already parked, and a positive period re-arms it.
         *
         * @param {any} timer @param {number} due @param {number} period
         * @param {((at: number) => void) | null} [fired]
         */
        armTimer(timer, due, period, fired = null){
            const at = state.timers.findIndex(entry=>entry.timer === timer);
            if (at >= 0)
            {
                state.timers.splice(at, 1);
            }
            timer.signalled = false;
            timer.due = due;
            timer.period = period;
            timer.fired = fired;
            state.timers.push({ timer, due, period });
            state.arms.push({ timer, due, period });
        },
        /** @param {any} timer */
        cancelTimer(timer){
            const at = state.timers.findIndex(entry=>entry.timer === timer);
            if (at >= 0)
            {
                state.timers.splice(at, 1);
            }
            timer.due = null;
            timer.period = 0;
        },
        /** The guest's clock reaching a moment, and everything it releases. */
        /** @param {number} milliseconds */
        advance(milliseconds){
            state.now += milliseconds;
            for (const armed of [...state.timers])
            {
                if (armed.due > state.now)
                {
                    continue;
                }
                if (armed.period > 0)
                {
                    const missed = Math.floor((state.now - armed.due) / armed.period) + 1;
                    armed.due += missed * armed.period;
                }
                else
                {
                    state.timers.splice(state.timers.indexOf(armed), 1);
                }
                signal(armed.timer);
            }
            for (const entry of [...state.parked])
            {
                if (entry.timed && entry.timed.deadline <= state.now)
                {
                    const at = entry.object.waiters.indexOf(entry.thread);
                    if (at >= 0)
                    {
                        entry.object.waiters.splice(at, 1);
                    }
                    wake(entry.thread, entry.timed.result);
                }
            }
        },
        /** @param {any} object @param {any} thread @param {any} [timed] */
        wait(object, thread, timed){
            state.waits.push({ object, thread, timed });
            if (object.kind === 'mutex' && object.owner === thread)
            {
                object.recursion++;
                return 0;
            }
            if (signalled(object))
            {
                return acquire(object, thread);
            }
            // A thread is itself waitable and has no queue until someone
            // waits on it; the kernel's own thread record carries one.
            if (!object.waiters)
            {
                object.waiters = [];
            }
            object.waiters.push(thread);
            state.parked.push({ thread, object, timed });
            return null;
        },
        /** @param {any} object @param {any} thread */
        poll(object, thread){
            state.polls.push({ object, thread });
            return signalled(object) ? acquire(object, thread) : null;
        },
        clock: { virtualTime: ()=>state.now, wallClock: ()=>state.now },
        /** @param {any} object @param {any} thread */
        releaseMutex(object, thread){
            state.released.push({ object, thread });
            return true;
        },
        /** @param {any} event */
        setEvent: event=>signal(event),
        /** @param {any} event */
        resetEvent: event=>{
            event.signalled = false;
        },
        /** @param {any} thread @param {number} code */
        exitThread: (thread, code)=>state.exited.push({ thread, code }),
        /** @param {any} thread @param {string} [reason] */
        /** @param {any} thread @param {string} reason @param {any} [timed] */
        block: (thread, reason, timed)=>state.blocked.push(
            timed === undefined ? { thread, reason } : { thread, reason, timed }),
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
                const entry = handles.get(handle);
                if (!entry || !handles.delete(handle))
                {
                    throw new Error('Invalid handle');
                }
                return entry.object;
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
 * A little-endian dword a handler wrote into guest memory.
 *
 * @param {Map<number, Uint8Array>} written
 * @param {number} address
 * @returns {number}
 */
function writtenU32(written, address){
    const bytes = written.get(address);
    assert.ok(bytes, `nothing was written at 0x${address.toString(16)}`);
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
}

/**
 * @param {Record<number, string>} [names] What each name pointer spells, for the
 *   tests that are about the Win32 object namespace. Every other test passes
 *   nothing and every pointer reads as the empty name, which is no name at all.
 */
function setup(names){
    const kernel = fakeKernel();
    /** @type {any} */
    const current = { name: 'caller' };
    /** @type {any[]} */
    const parked = [];
    /** What a handler wrote, by address, so a test can read an out-parameter. */
    /** @type {Map<number, Uint8Array>} */
    const written = new Map();
    /** @type {number[]} */
    const errors = [];
    /** @type {import('./threading.js').ThreadingHost} */
    const host = {
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
        /** @param {number} pointer */
        readWideString: pointer=>names?.[pointer] ?? '',
        /** @param {number} code */
        setLastError: code=>{
            errors.push(code);
        },
        /** @param {number} handle */
        handleType: handle=>kernel.handles.typeOf(handle),
        namedObjects: createNamedObjects(),
    };
    const fns = createThreadingFunctions(host);
    return { kernel, fns, host, parked, current, written, errors };
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

test('CreateRemoteThread into this process is CreateThread, and into another is refused', ()=>{
    // kernel32's process and thread tests: the stack of a remote thread of
    // our own process; a child, which runs only after this process, cannot
    // be given one.
    const { kernel, fns, errors } = setup();
    const handle = fns.CreateRemoteThread.handler(
        [0xffffffff, 0, 0x10000, 0x401000, 0xdead, 0, 0x405000]);
    assert.ok(handle > 0);
    assert.equal(kernel.state.created[0].entry, 0x401000);
    assert.equal(kernel.state.created[0].parameter, 0xdead);
    assert.deepEqual(kernel.state.threadIds, [{ address: 0x405000, id: 2 }]);

    assert.ok(fns.CreateRemoteThreadEx.handler(
        [0xffffffff, 0, 0, 0x402000, 0, 0, 0x406000, 0x407000]) > 0);
    assert.equal(kernel.state.created[1].entry, 0x402000);
    assert.equal(kernel.state.threadIds.at(-1)?.address, 0x407000, 'the id after the list');

    assert.equal(fns.CreateRemoteThread.handler([0x1234, 0, 0, 0x401000, 0, 0, 0]), 0);
    assert.deepEqual(errors, [6], 'ERROR_INVALID_HANDLE for what is no process');
    assert.deepEqual([fns.CreateRemoteThread.argBytes, fns.CreateRemoteThreadEx.argBytes],
        [28, 32]);
});

test('CreateThread gives the new thread its own environment block', ()=>{
    // FS points at it: a thread without one reads its id, its stack bounds
    // and its thread-local slots from linear address zero and up.
    const { kernel, fns, host } = setup();
    /** @type {any[]} */
    const given = [];
    host.threadBlock = (/** @type {any} */ thread)=>{
        given.push(thread);
        thread.tebAddress = 0x7ffd0000;
    };

    fns.CreateThread.handler([0, 0x10000, 0x401000, 0, 0, 0]);

    assert.equal(given.length, 1, 'asked once, for the thread just made');
    assert.equal(given[0], kernel.state.created[0]);
    assert.equal(kernel.state.created[0].tebAddress, 0x7ffd0000);
});

test('CreateThread fills in the thread id when asked, and not when not', ()=>{
    const { kernel, fns } = setup();

    fns.CreateThread.handler([0, 0, 0x401000, 0, 0, 0x405000]);
    assert.deepEqual(kernel.state.threadIds, [{ address: 0x405000, id: 2 }]);

    fns.CreateThread.handler([0, 0, 0x401000, 0, 0, 0]);
    assert.equal(kernel.state.threadIds.length, 1, 'a null pointer is not written through');
});

test('CreateThread hands the kernel the stack size as a commit, or as a reserve when flagged', ()=>{
    const STACK_SIZE_PARAM_IS_A_RESERVATION = 0x00010000;
    const { kernel, fns } = setup();

    fns.CreateThread.handler([0, 0x800000, 0x401000, 0, 0, 0]);
    assert.equal(kernel.state.created[0].stackSize, 0x800000);
    assert.equal(kernel.state.created[0].stackReserve, undefined);

    fns.CreateThread.handler([0, 0x40000, 0x401000, 0, STACK_SIZE_PARAM_IS_A_RESERVATION, 0]);
    assert.equal(kernel.state.created[1].stackReserve, 0x40000);
    assert.equal(kernel.state.created[1].stackSize, undefined);
});

test('CREATE_SUSPENDED makes the thread with one suspension, and no turn until resumed', ()=>{
    // Wine's thread test: a thread created suspended does not run, and the
    // first ResumeThread answers a previous count of one.
    const CREATE_SUSPENDED = 0x4;
    const { kernel, fns } = setup();
    /** @type {any[]} */
    const suspended = [];
    Object.assign(kernel, {
        suspendThread: (/** @type {any} */ thread)=>{
            suspended.push(thread);
            return 0;
        },
    });

    fns.CreateThread.handler([0, 0, 0x401000, 0, 0, 0]);
    assert.deepEqual(suspended, [], 'a thread created without it is left to run');
    fns.CreateThread.handler([0, 0, 0x401000, 0, CREATE_SUSPENDED, 0]);
    assert.deepEqual(suspended, [kernel.state.created[1]]);
});

test('a thread the kernel has no room for is a failed CreateThread, not a stopped machine', ()=>{
    const ERROR_NOT_ENOUGH_MEMORY = 8;
    const { kernel, fns, errors } = setup();
    kernel.createThread = ()=>null;

    assert.equal(fns.CreateThread.handler([0, 0, 0x401000, 0, 0, 0x405000]), 0);
    assert.deepEqual(errors, [ERROR_NOT_ENOUGH_MEMORY]);
    assert.deepEqual(kernel.state.threadIds, [], 'no id is written for a thread never made');
});

test('waiting on a child process is where the parent hands over', ()=>{
    // Nothing in this process can signal a child: it runs once the parent has
    // nothing else to do. So the thread blocks outside every wait queue, and is
    // noted on the child with its answer, for the engine to wake when the
    // child it runs beside this process exits. Left to the ordinary path,
    // this would join a queue on an object with no signal and be reported as
    // a deadlock.
    const { kernel, fns, parked, current } = setup();
    /** @type {any} */
    const child = { imagePath: 'C:\\App\\child.exe' };
    const handle = kernel.handles.open('process', child);

    assert.equal(fns.WaitForSingleObject.handler([handle, 0xffffffff]), PARKED);
    assert.deepEqual(parked, [current]);
    assert.equal(kernel.state.blocked.length, 1);
    assert.equal(kernel.state.blocked[0].thread, current);
    assert.equal(kernel.state.waits.length, 0, 'and it never joined a wait queue');
    assert.deepEqual(child.waiters, [{ thread: current, result: 0 }],
        'the child knows who waits on it, and that the wait answers WAIT_OBJECT_0');
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
    // not be stopped by the question, so an unavailable object answers at once
    // -- and is not queued on it either, which a zero-deadline wait would do.
    const waits = state.waits.length;
    assert.equal(fns.WaitForSingleObject.handler([handle, 0]), 0x102);
    assert.equal(state.waits.length, waits, 'a poll is not a wait');
    assert.equal(state.polls.length, 1);

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
    const { kernel, fns, errors } = setup({ [NAME]: 'Warcraft III' });

    const first = fns.CreateMutexA.handler([0, 0, NAME]);
    assert.equal(errors.at(-1), ERROR_SUCCESS, 'nothing held the name yet');

    const second = fns.CreateMutexA.handler([0, 0, NAME]);
    assert.notEqual(second, first, 'a create always returns a handle of its own');
    assert.equal(errors.at(-1), ERROR_ALREADY_EXISTS,
        'the single-instance idiom reads exactly this');
    assert.equal(kernel.handles.resolve(second, 'mutex'), kernel.handles.resolve(first, 'mutex'),
        'both handles name the one mutex');
});

test('CreateMutexW reads the wide name and finds what CreateMutexA made', ()=>{
    const NAME = 0x2000;
    const { kernel, fns, errors } = setup({ [NAME]: 'Warcraft III' });

    const ansi = fns.CreateMutexA.handler([0, 0, NAME]);
    const wide = fns.CreateMutexW.handler([0, 0, NAME]);
    assert.equal(errors.at(-1), ERROR_ALREADY_EXISTS);
    assert.equal(kernel.handles.resolve(wide, 'mutex'), kernel.handles.resolve(ansi, 'mutex'));
    assert.equal(fns.CreateMutexW.argBytes, 12);
});

test('a named semaphore is found by a second create, and by OpenSemaphore', ()=>{
    const NAME = 0x2000;
    const { kernel, fns, errors } = setup({ [NAME]: 'Warcraft III' });

    const first = fns.CreateSemaphoreA.handler([0, 1, 4, NAME]);
    assert.notEqual(first, 0);
    assert.equal(errors.at(-1), ERROR_SUCCESS);

    const second = fns.CreateSemaphoreW.handler([0, 0, 0, NAME]);
    assert.equal(errors.at(-1), ERROR_ALREADY_EXISTS,
        'the bogus counts of the second create are ignored -- the name found the first');
    assert.equal(kernel.handles.resolve(second, 'semaphore'),
        kernel.handles.resolve(first, 'semaphore'));

    const opened = fns.OpenSemaphoreA.handler([0, 0, NAME]);
    assert.equal(kernel.handles.resolve(opened, 'semaphore'),
        kernel.handles.resolve(first, 'semaphore'));
    assert.equal(fns.OpenSemaphoreW.argBytes, 12);
});

test('an unnamed CreateSemaphore still validates its counts', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.CreateSemaphoreA.handler([0, 0, 0, 0]), 0, 'a maximum of zero is refused');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'and says why');
    errors.length = 0;
    assert.equal(fns.CreateSemaphoreA.handler([0, 5, 4, 0]), 0, 'initial above maximum is refused');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    errors.length = 0;
    assert.equal(fns.CreateSemaphoreW.handler([0, -1, 4, 0]), 0, 'a negative initial is refused');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.notEqual(fns.CreateSemaphoreA.handler([0, 1, 4, 0]), 0);
});

test('the Ex creators take their options as flags, and make the same objects', ()=>{
    const CREATE_EVENT_MANUAL_RESET = 0x1;
    const CREATE_EVENT_INITIAL_SET = 0x2;
    const CREATE_MUTEX_INITIAL_OWNER = 0x1;
    const ALL_ACCESS = 0x1f0003;
    const NAME = 0x2000;
    const { kernel, fns, errors, current } = setup({ [NAME]: 'Ready' });

    const event = fns.CreateEventExW.handler(
        [0, NAME, CREATE_EVENT_MANUAL_RESET | CREATE_EVENT_INITIAL_SET, ALL_ACCESS]);
    const made = kernel.handles.resolve(event, 'event');
    assert.equal(made.manualReset, true);
    assert.equal(made.signalled, true);
    assert.equal(kernel.handles.resolve(fns.CreateEventA.handler([0, 0, 0, NAME]), 'event'), made,
        'the name is the one CreateEvent uses');
    assert.equal(errors.at(-1), ERROR_ALREADY_EXISTS);
    assert.equal(kernel.handles.resolve(fns.CreateEventExA.handler([0, 0, 0, ALL_ACCESS]),
        'event').manualReset, false, 'no flags is an auto-reset event, not signalled');

    const mutex = kernel.handles.resolve(
        fns.CreateMutexExA.handler([0, 0, CREATE_MUTEX_INITIAL_OWNER, ALL_ACCESS]), 'mutex');
    assert.deepEqual(kernel.state.waits.at(-1).object, mutex);
    assert.equal(kernel.state.waits.at(-1).thread, current, 'taken by the caller');

    const semaphore = fns.CreateSemaphoreExW.handler([0, 1, 4, 0, 0, ALL_ACCESS]);
    assert.equal(kernel.handles.resolve(semaphore, 'semaphore').maximum, 4);
    assert.equal(fns.CreateSemaphoreExA.handler([0, 5, 4, 0, 0, ALL_ACCESS]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);

    assert.deepEqual([fns.CreateEventExA, fns.CreateEventExW, fns.CreateMutexExA,
        fns.CreateMutexExW, fns.CreateSemaphoreExA, fns.CreateSemaphoreExW]
        .map(fn=>fn.argBytes), [16, 16, 16, 16, 24, 24]);
});

test('OpenSemaphoreA reports no such thing for a name nothing created', ()=>{
    const NAME = 0x2000;
    const { fns, errors } = setup({ [NAME]: 'Warcraft III' });
    assert.equal(fns.OpenSemaphoreA.handler([0, 0, NAME]), 0);
    assert.equal(errors.at(-1), ERROR_FILE_NOT_FOUND);
});

test('a named waitable timer is found by a second create, and by OpenWaitableTimer', ()=>{
    const NAME = 0x2000;
    const { kernel, fns, errors } = setup({ [NAME]: 'Warcraft III' });

    const first = fns.CreateWaitableTimerW.handler([0, 1, NAME]);
    assert.notEqual(first, 0);
    const second = fns.CreateWaitableTimerA.handler([0, 0, NAME]);
    assert.equal(errors.at(-1), ERROR_ALREADY_EXISTS);
    assert.equal(kernel.handles.resolve(second, 'timer'), kernel.handles.resolve(first, 'timer'));

    const opened = fns.OpenWaitableTimerW.handler([0, 0, NAME]);
    assert.equal(kernel.handles.resolve(opened, 'timer'), kernel.handles.resolve(first, 'timer'));
    assert.equal(fns.OpenWaitableTimerA.argBytes, 12);
});

test('OpenMutexW and OpenEventW read the wide name too', ()=>{
    const MUTEX_NAME = 0x2000;
    const EVENT_NAME = 0x2100;
    const { kernel, fns } = setup({ [MUTEX_NAME]: 'Warcraft III', [EVENT_NAME]: 'wc3-ready' });

    const mutex = fns.CreateMutexA.handler([0, 0, MUTEX_NAME]);
    assert.equal(kernel.handles.resolve(fns.OpenMutexW.handler([0, 0, MUTEX_NAME]), 'mutex'),
        kernel.handles.resolve(mutex, 'mutex'));

    const event = fns.CreateEventA.handler([0, 0, 0, EVENT_NAME]);
    assert.equal(kernel.handles.resolve(fns.OpenEventW.handler([0, 0, EVENT_NAME]), 'event'),
        kernel.handles.resolve(event, 'event'));
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

test('a Toolhelp snapshot holds this process and nothing after it', ()=>{
    const { fns, host, written, errors } = setup();
    host.processId = 0x2a4;
    host.imagePath = ()=>'C:\\App\\Setup.exe';
    const bytes = new Uint8Array(0x1000);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    bytes.set([296 & 0xff, 296 >> 8, 0, 0], 0x100);

    const snapshot = fns.CreateToolhelp32Snapshot.handler([0x2, 0]);
    assert.ok(snapshot > 0);
    assert.equal(fns.Process32First.handler([snapshot, 0x100]), 1);
    const entry = written.get(0x100);
    assert.ok(entry);
    const view = new DataView(entry.buffer, entry.byteOffset);
    assert.equal(view.getUint32(8, true), 0x2a4, 'th32ProcessID');
    assert.equal(new TextDecoder().decode(entry.subarray(36, 45)), 'Setup.exe', 'szExeFile');
    assert.equal(fns.Process32Next.handler([snapshot, 0x100]), 0);
    assert.equal(errors.at(-1), 18, 'ERROR_NO_MORE_FILES');

    bytes.set([100, 0, 0, 0], 0x100);
    assert.equal(fns.Process32First.handler([snapshot, 0x100]), 0, 'too small an entry');
    assert.equal(errors.at(-1), 122, 'ERROR_INSUFFICIENT_BUFFER');
    assert.equal(fns.CloseHandle.handler([snapshot]), 1);
    assert.equal(fns.Process32First.handler([snapshot, 0x100]), 0, 'closed');
    assert.equal(fns.CreateToolhelp32Snapshot.argBytes, 8);
    assert.equal(fns.Process32First.argBytes, 8);
    assert.equal(fns.Process32Next.argBytes, 8);
});

test('a snapshot names the image in the ANSI page', ()=>{
    // The euro sign is 0x80 there, the trade mark 0x99 and an em dash 0x97,
    // as the ANSI calls read those bytes; an image named with them is named
    // with them in the entry too.
    const { fns, host, written } = setup();
    host.imagePath = ()=>'C:\\App\\\u20ac\u2122\u2014\u00e9.exe';
    const bytes = new Uint8Array(0x1000);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    bytes.set([296 & 0xff, 296 >> 8, 0, 0], 0x100);

    const snapshot = fns.CreateToolhelp32Snapshot.handler([0x2, 0]);
    assert.equal(fns.Process32First.handler([snapshot, 0x100]), 1);
    const entry = /** @type {Uint8Array} */ (written.get(0x100));
    assert.deepEqual([...entry.subarray(36, 45)],
        [0x80, 0x99, 0x97, 0xe9, 0x2e, 0x65, 0x78, 0x65, 0]);
});

test('arming a timer with a waiter already parked releases it at the due time', ()=>{
    // The deadlock in one line: thread B waits before thread A arms. The
    // signal is a property of the object and the clock, so the arm is what
    // schedules the wake -- the wait that arrived first is not a lost one.
    const { fns, kernel, host, current } = setup();
    const bytes = new Uint8Array(0x100);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    kernel.state.now = 1000;
    const timer = fns.CreateWaitableTimerA.handler([0, 1, 0]);
    assert.equal(kernel.handles.typeOf(timer), 'timer');
    const object = kernel.handles.resolve(timer, 'timer');

    assert.equal(fns.WaitForSingleObject.handler([timer, 0xffffffff]), PARKED,
        'nothing has armed it yet, so the waiter parks on the timer itself');
    assert.equal(object.waiters.length, 1);

    // -160000 in hundreds of nanoseconds: 16 ms from now, one-shot.
    new DataView(bytes.buffer).setBigInt64(0x10, -160000n, true);
    assert.equal(fns.SetWaitableTimer.handler([timer, 0x10, 0, 0, 0, 0]), 1);
    assert.deepEqual(kernel.state.arms.at(-1), { timer: object, due: 1016, period: 0 },
        'the due time lands on the same clock the scheduler already keeps');

    kernel.advance(16);
    assert.equal(current.waitResult, 0, 'released with WAIT_OBJECT_0 at the due time');
    assert.equal(object.signalled, true, 'a manual-reset timer stays signalled');
    assert.equal(object.waiters.length, 0);
});

test('a wait on an armed timer parks until it is due, then consumes it', ()=>{
    const { fns, kernel, host, current } = setup();
    const bytes = new Uint8Array(0x100);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    kernel.state.now = 1000;
    const timer = fns.CreateWaitableTimerA.handler([0, 0, 0]);
    const object = kernel.handles.resolve(timer, 'timer');
    new DataView(bytes.buffer).setBigInt64(0x10, -160000n, true);
    assert.equal(fns.SetWaitableTimer.handler([timer, 0x10, 0, 0, 0, 0]), 1);

    assert.equal(fns.WaitForSingleObject.handler([timer, 0xffffffff]), PARKED,
        'not due yet, so the thread parks');
    assert.deepEqual(kernel.state.waits.at(-1), { object, thread: current, timed: undefined },
        'on the object, with no deadline of its own: the clock owns the due time');
    kernel.advance(16);
    assert.equal(current.waitResult, 0, 'the clock signals the object and releases the wait');
    assert.equal(object.signalled, false,
        'a synchronisation timer is reset by the wait that takes it');
    assert.equal(kernel.state.timers.length, 0, 'a one-shot timer is disarmed once it has fired');

    assert.equal(fns.CreateWaitableTimerA.argBytes, 12);
    assert.equal(fns.SetWaitableTimer.argBytes, 24, 'six stdcall arguments, or the stack leaks');
    assert.equal(fns.CancelWaitableTimer.argBytes, 4);
});

test('a periodic timer signals again a period on, with no thread present between', ()=>{
    const { fns, kernel, host, current } = setup();
    const bytes = new Uint8Array(0x100);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    kernel.state.now = 1000;
    const timer = fns.CreateWaitableTimerA.handler([0, 0, 0]);
    new DataView(bytes.buffer).setBigInt64(0x10, -10000n, true);
    assert.equal(fns.SetWaitableTimer.handler([timer, 0x10, 20, 0, 0, 0]), 1);

    assert.equal(fns.WaitForSingleObject.handler([timer, 0xffffffff]), PARKED);
    kernel.advance(1);
    assert.equal(current.waitResult, 0, 'the first period');
    current.waitResult = null;

    assert.equal(fns.WaitForSingleObject.handler([timer, 0xffffffff]), PARKED,
        'the second wait does not see a signal left over from the first');
    kernel.advance(20);
    assert.equal(current.waitResult, 0, 'and the next period releases it, one period later');
    assert.equal(kernel.state.timers.length, 1, 'still armed for the period after');
});

test('cancelling a timer leaves a parked waiter parked, and its own timeout still ends it', ()=>{
    const { fns, kernel, host, current, errors } = setup();
    const bytes = new Uint8Array(0x100);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    kernel.state.now = 1000;
    const timer = fns.CreateWaitableTimerA.handler([0, 0, 0]);
    const object = kernel.handles.resolve(timer, 'timer');
    new DataView(bytes.buffer).setBigInt64(0x10, -160000n, true);
    fns.SetWaitableTimer.handler([timer, 0x10, 0, 0, 0, 0]);

    assert.equal(fns.WaitForSingleObject.handler([timer, 5]), PARKED);
    assert.deepEqual(kernel.state.waits.at(-1).timed, { deadline: 1005, result: 0x102 },
        'a wait shorter than the due time times out on its own clock');
    assert.equal(fns.CancelWaitableTimer.handler([timer]), 1);
    assert.equal(kernel.state.timers.length, 0, 'disarmed');
    assert.equal(object.signalled, false, 'and it did not signal');
    kernel.advance(5);
    assert.equal(current.waitResult, 0x102, 'the wait times out exactly as it would have');

    assert.equal(fns.SetWaitableTimer.handler([0x999, 0x10, 0, 0, 0, 0]), 0, 'a stranger fails');
    assert.equal(errors.at(-1), 6, 'ERROR_INVALID_HANDLE');
});

test('CancelWaitableTimer un-arms without signalling a parked waiter', ()=>{
    const { fns, kernel, host, current } = setup();
    const bytes = new Uint8Array(0x100);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    kernel.state.now = 1000;
    const timer = fns.CreateWaitableTimerA.handler([0, 0, 0]);
    const object = kernel.handles.resolve(timer, 'timer');
    new DataView(bytes.buffer).setBigInt64(0x10, -160000n, true);
    fns.SetWaitableTimer.handler([timer, 0x10, 0, 0, 0, 0]);

    assert.equal(fns.WaitForSingleObject.handler([timer, 0xffffffff]), PARKED);
    assert.equal(fns.CancelWaitableTimer.handler([timer]), 1);
    kernel.advance(1000);
    assert.equal(current.waitResult, undefined, 'nothing released it');
    assert.equal(object.waiters.length, 1, 'it is still parked on the object');
});

test('DuplicateHandle accepts the pseudo-handles wherever a handle is taken', ()=>{
    const { fns, kernel, written } = setup();

    // DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), ...)
    assert.equal(
        fns.DuplicateHandle.handler([0xffffffff, 0xfffffffe, 0xffffffff, 0x300, 0, 0, 0]), 1);
    const thread = writtenU32(written, 0x300);
    assert.equal(kernel.handles.typeOf(thread), 'thread', 'a real handle to the current thread');
    assert.equal(kernel.handles.resolve(thread).name, 'caller', 'which is this thread');

    // The current process pseudo-handle names a process object.
    assert.equal(
        fns.DuplicateHandle.handler([0xffffffff, 0xffffffff, 0xffffffff, 0x304, 0, 0, 0]), 1);
    const process = writtenU32(written, 0x304);
    assert.equal(kernel.handles.typeOf(process), 'process');
    assert.equal(kernel.handles.resolve(process, 'process').current, true);

    // A duplicate may close the source, but a pseudo-handle cannot be closed.
    assert.equal(
        fns.DuplicateHandle.handler([0xffffffff, 0xfffffffe, 0xffffffff, 0x308, 0, 0, 1]), 1);
    assert.ok(writtenU32(written, 0x308) > 0);
});

test('a wait on a pseudo-handle is a wait on the running object, which is not signalled', ()=>{
    const { fns, kernel, current, written } = setup();

    // WaitForSingleObject(NtCurrentThread(), 0) and (NtCurrentProcess(), 0):
    // Wine's sync.c test_WaitForSingleObject requires WAIT_TIMEOUT for both.
    assert.equal(fns.WaitForSingleObject.handler([0xfffffffe, 0]), 0x102);
    assert.equal(fns.WaitForSingleObject.handler([0xffffffff, 0]), 0x102);

    // A timeout on a duplicate of the running thread expires while it runs.
    assert.equal(
        fns.DuplicateHandle.handler([0xffffffff, 0xfffffffe, 0xffffffff, 0x300, 0, 0, 0]), 1);
    const duplicate = writtenU32(written, 0x300);
    assert.equal(fns.WaitForSingleObject.handler([duplicate, 100]), PARKED);
    kernel.advance(100);
    assert.equal(current.waitResult, 0x102, 'the thread was still running');
});

test('a timer\'s completion routine is queued to the setting thread at each expiry', ()=>{
    // With the timer's argument and the time it expired as a FILETIME. It runs
    // when that thread next waits alertably; queuing it is all this does.
    const { fns, kernel, host, current } = setup();
    /** @type {any[]} */
    const queued = [];
    host.queueApc = (thread, routine, args)=>queued.push({ thread, routine, args });
    const bytes = new Uint8Array(0x100);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    kernel.state.now = 1000;
    const timer = fns.CreateWaitableTimerA.handler([0, 0, 0]);
    const object = kernel.handles.resolve(timer, 'timer');
    new DataView(bytes.buffer).setBigInt64(0x10, -160000n, true);

    assert.equal(fns.SetWaitableTimer.handler([timer, 0x10, 0, 0x00405000, 0x1234, 0]), 1);
    object.fired(1016);

    assert.equal(queued.length, 1);
    assert.equal(queued[0].thread, current, 'the thread that set it, not whoever is running');
    assert.equal(queued[0].routine, 0x00405000);
    assert.equal(queued[0].args[0], 0x1234);
    const filetime = BigInt(queued[0].args[2]) << 32n | BigInt(queued[0].args[1]);
    assert.ok(filetime > 116444736000000000n, 'a FILETIME, after 1970');
});

test('a timer set without a routine queues nothing', ()=>{
    const { fns, kernel, host } = setup();
    const bytes = new Uint8Array(0x100);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    host.queueApc = ()=>assert.fail('nothing to queue');
    const timer = fns.CreateWaitableTimerA.handler([0, 0, 0]);
    new DataView(bytes.buffer).setBigInt64(0x10, -160000n, true);

    fns.SetWaitableTimer.handler([timer, 0x10, 0, 0, 0, 0]);

    assert.equal(kernel.handles.resolve(timer, 'timer').fired, null);
});

test('SwitchToThread answers zero at once when no other thread is ready', ()=>{
    const { fns, kernel, parked, current } = setup();
    /** @type {any} */ (kernel).threads = ()=>[current, { state: 'blocked' },
        { state: 'ready', awaitingHost: true }];
    assert.equal(fns.SwitchToThread.handler(), 0);
    assert.deepEqual(parked, []);
    assert.deepEqual(kernel.state.blocked, []);
    assert.equal(fns.SwitchToThread.argBytes, 0);
});

test('SwitchToThread stands aside for a ready thread and answers nonzero when it runs again',
    ()=>{
        const { fns, kernel, parked, current } = setup();
        kernel.state.now = 500;
        current.priority = 0;
        /** @type {any} */ (kernel).threads = ()=>[current, { state: 'ready', priority: 0 }];
        assert.equal(fns.SwitchToThread.handler(), PARKED);
        assert.deepEqual(parked, [current]);
        assert.deepEqual(kernel.state.blocked, [{ thread: current, reason: 'SwitchToThread',
            timed: { deadline: 500, result: 1 } }], 'behind one of its own priority, no longer');

        /** @type {any} */ (kernel).threads = ()=>[current, { state: 'ready', priority: -2 }];
        current.priority = 2;
        fns.SwitchToThread.handler();
        assert.deepEqual(kernel.state.blocked[1].timed, { deadline: 501, result: 1 },
            'a lower priority gets a moment of guest time, as the scheduler would pick the '
            + 'caller again at once');
    });

/**
 * An OVERLAPPED in guest memory at 0x20, and a count at 0x40.
 *
 * @param {ReturnType<typeof setup>} parts
 * @param {number} internal @param {number} internalHigh @param {number} [event]
 */
function overlapped({ host }, internal, internalHigh, event = 0){
    const bytes = new Uint8Array(0x100);
    const view = new DataView(bytes.buffer);
    host.readMemory = (address, length)=>bytes.subarray(address, address + length);
    host.writeMemory = (address, data)=>bytes.set(data, address);
    view.setUint32(0x20, internal, true);
    view.setUint32(0x24, internalHigh, true);
    view.setUint32(0x30, event, true);
    view.setUint32(0x40, 0x5555, true);
    return { count: ()=>view.getUint32(0x40, true), view };
}

test('GetOverlappedResult reads the count and the status the I/O left in the OVERLAPPED', ()=>{
    // Wine's kernel32 file tests, test_overlapped.
    const STATUS_INVALID_HANDLE = 0xc0000008;
    const parts = setup();
    const done = overlapped(parts, 0, 0xabcd);
    assert.equal(parts.fns.GetOverlappedResult.handler([0, 0x20, 0x40, 0]), 1);
    assert.equal(done.count(), 0xabcd);
    assert.equal(parts.fns.GetOverlappedResult.argBytes, 16);

    const failed = overlapped(parts, STATUS_INVALID_HANDLE, 0xabcd);
    assert.equal(parts.fns.GetOverlappedResult.handler([0, 0x20, 0x40, 0]), 0);
    assert.equal(parts.errors.at(-1), 6, 'ERROR_INVALID_HANDLE, from the status');
    assert.equal(failed.count(), 0xabcd, 'the count is written all the same');
});

test('an operation still pending is incomplete without bWait, and waited for with it', ()=>{
    const STATUS_PENDING = 0x103;
    const ERROR_IO_INCOMPLETE = 996;
    const parts = setup();
    const { fns, kernel, parked, current } = parts;
    const event = fns.CreateEventA.handler([0, 1, 1, 0]);
    const pending = overlapped(parts, STATUS_PENDING, 0xabcd, event);
    assert.equal(fns.GetOverlappedResult.handler([0, 0x20, 0x40, 0]), 0);
    assert.equal(parts.errors.at(-1), ERROR_IO_INCOMPLETE);
    assert.equal(pending.count(), 0x5555, 'and the count is left alone');

    /** @type {any[]} */
    const sets = [];
    /** @type {any} */ (kernel).waitAny = (/** @type {any[]} */ objects)=>{
        sets.push(objects);
        const index = objects.findIndex(object=>object.signalled);
        return index < 0 ? null : { index, result: index };
    };
    assert.equal(fns.GetOverlappedResult.handler([0, 0x20, 0x40, 1]), 1,
        'a signalled event ends the wait at once, the status still pending');
    assert.equal(pending.count(), 0xabcd);
    const object = kernel.handles.resolve(event, 'event');
    assert.equal(sets[0][1], object, 'the event awaited is the one the OVERLAPPED names');
    assert.equal(sets[0][0].signalled, false, 'behind one nothing sets');

    kernel.resetEvent(object);
    pending.view.setUint32(0x30, event | 1, true);
    assert.equal(fns.GetOverlappedResult.handler([0, 0x20, 0x40, 1]), PARKED,
        'the low bit of hEvent is a flag, not part of the handle');
    assert.deepEqual(parked, [current]);
    assert.equal(sets[1][1], object);

    pending.view.setUint32(0x30, 0, true);
    assert.equal(fns.GetOverlappedResult.handler([0x9999, 0x20, 0x40, 1]), 0,
        'with no event the file is waited on, and it must be a handle');
    assert.equal(parts.errors.at(-1), 6);
});

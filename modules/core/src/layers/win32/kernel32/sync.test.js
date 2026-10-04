/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncFunctions } from './sync.js';
import { createCriticalSections, enterCode, leaveCode, tryEnterCode } from './critical.js';
import { INTERLOCKED } from './interlocked.js';

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
const ERROR_SIGNAL_REFUSED = 156;

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
        /** @type {any[]} */ timed: [],
        /** Guest time, which a deadline is measured against. */ now: 0,
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
        if ((object.kind === 'event' || object.kind === 'timer') && !object.manualReset)
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
            case 'timer':
                return object.signalled === true;
            case 'semaphore':
                return object.count > 0;
            // As the kernel has it: signalled once it has ended, for ever.
            case 'thread':
                return (object.exitCode ?? null) !== null;
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
        /** @param {any} options */
        createTimer: options=>(
            { kind: 'timer', signalled: false, manualReset: false, waiters: [], ...options }),
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
        clock: { virtualTime: ()=>state.now, wallClock: ()=>state.now },
        /** @param {any[]} objects @param {any} thread @param {any} [timed] */
        waitAll(objects, thread, timed){
            state.timed.push(timed);
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
        /** @param {any[]} objects @param {any} thread @param {any} [timed] */
        waitAny(objects, thread, timed){
            state.timed.push(timed);
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
        /** The count lives on the thread, and 127 is the most it carries. */
        /** @param {any} thread */
        suspendThread(thread){
            const previous = thread.suspendCount ?? 0;
            if (previous >= 127)
            {
                return null;
            }
            thread.suspendCount = previous + 1;
            return previous;
        },
        /** @param {any} thread */
        resumeThread(thread){
            const previous = thread.suspendCount ?? 0;
            thread.suspendCount = Math.max(0, previous - 1);
            return previous;
        },
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
            /** @param {number} handle */
            typeOf(handle){
                return this.table.get(handle)?.type ?? null;
            },
        },
    };
}

function fakeHost(){
    const bytes = new Uint8Array(0x1000);
    let free = 0x800;
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
        /** @type {number[]} */
        errors: [],
        /** @param {number} code */
        setLastError: code=>host.errors.push(code),
        /** @param {number} milliseconds */
        advanceClock: milliseconds=>kernel.state.advanced.push(milliseconds),
        /** Guest memory for code and counters, from the top of this little machine. */
        allocate: (/** @type {number} */ size)=>{
            const at = free;
            free += size;
            return at;
        },
        /** @type {any} */
        critical: null,
        /** @param {number} address */
        readI32: address=>new DataView(bytes.buffer).getInt32(address, true),
        /** @param {number} handle @param {string} type @param {any} object */
        register(handle, type, object){
            kernel.handles.table.set(handle, { type, object });
            return object;
        },
    };
    host.critical = createCriticalSections({
        readMemory: host.readMemory,
        writeMemory: (address, data)=>host.writeMemory(address, data),
        currentThread: ()=>current,
        /** @param {any} thread @param {string} reason */
        block: (thread, reason)=>kernel.state.blocked.push({ thread, reason }),
        /** @param {any} thread */
        wake: thread=>{
            kernel.state.woken.push(thread);
            return true;
        },
        park: ()=>PARKED,
        allocate: host.allocate,
    });
    return host;
}

/** What the export binding hands a guest-code entry: traps it can fall back to. */
function fakeBuilder(){
    /** @type {{ label: string, trap: any }[]} */
    const registered = [];
    return {
        registered,
        /** @param {string} label @param {any} trap */
        register: (label, trap)=>{
            registered.push({ label, trap });
            return 0x105000 + registered.length * 0x10;
        },
    };
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
    // Windows 8 and later keep no debug record and say so with -1, which
    // DeleteCriticalSection clears (Wine's kernel32 sync test_crit_section).
    assert.equal(host.readI32(section), -1);
    fns.DeleteCriticalSection.handler([section]);
    assert.equal(host.readI32(section), 0);
    fns.InitializeCriticalSectionAndSpinCount.handler([section, 4000]);
    assert.equal(host.readI32(section), -1);
});

test('entering, leaving and trying a section are guest code, placed once', ()=>{
    // The structure the program passes is the lock, and every export that
    // touches it points at a few instructions rather than at a trap. What the
    // host places is the code, the two traps it falls back to, and nothing
    // else; asking twice places nothing more.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const builder = fakeBuilder();

    const enter = fns.EnterCriticalSection.guest(builder);
    const leave = fns.LeaveCriticalSection.guest(builder);
    const attempt = fns.TryEnterCriticalSection.guest(builder);

    assert.deepEqual(builder.registered.map(one=>one.label), ['<cs-wait>', '<cs-wake>']);
    assert.ok(enter !== leave && leave !== attempt && enter !== attempt, 'three places');
    const counters = host.critical.counters();
    assert.deepEqual([...host.bytes.slice(enter, enter + enterCode(enter, 0, 0).length)],
        [...enterCode(enter, 0x105010, counters)], 'the entry falls back to the wait trap');
    assert.deepEqual([...host.bytes.slice(leave, leave + leaveCode(leave, 0, 0).length)],
        [...leaveCode(leave, 0x105020, counters)], 'the release falls back to the wake trap');
    assert.deepEqual([...host.bytes.slice(attempt, attempt + tryEnterCode(0).length)],
        [...tryEnterCode(counters)], 'the try counts itself where the entry does');

    assert.equal(fns.EnterCriticalSection.guest(builder), enter, 'the same place again');
    assert.equal(builder.registered.length, 2, 'and no more traps');
    assert.equal('handler' in fns.EnterCriticalSection, false, 'nothing to trap into');
});

test('the fast paths are placed where the host keeps code, not in the heap beside data',
    ()=>{
        // Code beside data a program writes is code a translator keeps finding
        // stored into: in one title the entry ran interpreted thirty-two million
        // times in two minutes, because the counters sat eight bytes before it.
        const host = fakeHost();
        /** @type {number[]} */
        const placed = [];
        /** @type {any} */ (host).allocateCode = ()=>{
            const at = 0x400 + placed.length * 0x80;
            placed.push(at);
            return at;
        };
        const fns = createSyncFunctions(/** @type {any} */ (host));
        const builder = fakeBuilder();
        const enter = fns.EnterCriticalSection.guest(builder);
        const leave = fns.LeaveCriticalSection.guest(builder);
        const attempt = fns.TryEnterCriticalSection.guest(builder);
        assert.deepEqual([enter, leave, attempt], placed, 'every fast path from the code pages');
    });

test('the traps behind the fast paths queue a loser and hand the section to it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const builder = fakeBuilder();
    fns.EnterCriticalSection.guest(builder);
    const [wait, wake] = builder.registered.map(one=>one.trap);
    const section = 0x200;

    // The first thread holds it; the second lost the increment and traps.
    host.run(host.threads.second);
    assert.equal(wait.handler([section]), PARKED);
    assert.equal(host.kernel.state.blocked.length, 1);
    assert.equal(host.kernel.state.blocked[0].thread, host.threads.second);

    // The owner's release found the count saying somebody waited.
    host.run(host.threads.first);
    assert.equal(wake.handler([section]), 0);
    assert.deepEqual(host.kernel.state.woken, [host.threads.second]);
    assert.equal(host.readI32(section + CS_OWNING_THREAD), host.threads.second.id,
        'the structure names the new owner before it runs');
    assert.equal(host.readI32(section + CS_RECURSION_COUNT), 1);
});

test('initialising or deleting a section forgets whoever was queued on it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const builder = fakeBuilder();
    fns.EnterCriticalSection.guest(builder);
    const [wait] = builder.registered.map(one=>one.trap);

    host.run(host.threads.second);
    wait.handler([0x200]);
    assert.equal(host.critical.diagnostics().queued, 1);
    fns.DeleteCriticalSection.handler([0x200]);
    assert.equal(host.critical.diagnostics().queued, 0);

    wait.handler([0x300]);
    fns.InitializeCriticalSection.handler([0x300]);
    assert.equal(host.critical.diagnostics().queued, 0);
    assert.equal(host.readI32(0x300 + CS_LOCK_COUNT), CS_UNLOCKED);
});

test('a spin count is recorded where a guest looks for it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);

    assert.equal(fns.InitializeCriticalSectionAndSpinCount.handler([0x200, 4000]), 1);
    assert.equal(host.readI32(0x200 + CS_SPIN_COUNT), 4000);
    assert.equal(host.readI32(0x200 + CS_LOCK_COUNT), CS_UNLOCKED);
});

test('the interlocked exports are guest code, placed once where the host keeps code', ()=>{
    // One locked instruction on the program's dword each: nothing to trap
    // into, so the export binds to the code and registers no trap at all.
    const host = fakeHost();
    /** @type {number[]} */
    const placed = [];
    /** @type {any} */ (host).allocateCode = (/** @type {number} */ size)=>{
        const at = 0x900 + placed.length * 0x20;
        assert.ok(size <= 0x20);
        placed.push(at);
        return at;
    };
    const fns = createSyncFunctions(/** @type {any} */ (host));
    const builder = fakeBuilder();
    const names = /** @type {(keyof typeof INTERLOCKED)[]} */ (Object.keys(INTERLOCKED));
    assert.deepEqual(names.sort(), ['InterlockedCompareExchange', 'InterlockedDecrement',
        'InterlockedExchange', 'InterlockedExchangeAdd', 'InterlockedIncrement']);
    for (const name of names)
    {
        const entry = /** @type {any} */ (fns[name]);
        assert.equal('handler' in entry, false, `${name} has nothing to trap into`);
        assert.equal(entry.argBytes, INTERLOCKED[name].argBytes);
        const at = entry.guest(builder);
        assert.ok(placed.includes(at), `${name} is in the code pages`);
        const { code } = INTERLOCKED[name];
        assert.deepEqual([...host.bytes.slice(at, at + code.length)], [...code]);
        assert.equal(entry.guest(builder), at, 'the same place again');
    }
    assert.equal(placed.length, names.length, 'each placed once');
    assert.deepEqual(builder.registered, [], 'and no trap registered for any');
});

test('each interlocked routine is its one locked instruction, and pops what it was passed',
    ()=>{
        // What each answers -- the value after for an increment and a
        // decrement, the value before for the rest -- is run through the
        // import on both engines by kernel32-inguest.itest.
        /** @param {Uint8Array} code @param {number[]} instruction */
        const holds = (code, instruction)=>code.join(',').includes(instruction.join(','));
        const { InterlockedIncrement, InterlockedDecrement, InterlockedExchange,
            InterlockedExchangeAdd, InterlockedCompareExchange } = INTERLOCKED;
        assert.ok(holds(InterlockedIncrement.code, [0xf0, 0x0f, 0xc1, 0x01, 0x40]),
            'lock xadd [ecx], eax; inc eax');
        assert.ok(holds(InterlockedDecrement.code, [0xf0, 0x0f, 0xc1, 0x01, 0x48]),
            'lock xadd [ecx], eax; dec eax');
        assert.ok(holds(InterlockedExchange.code, [0x87, 0x01]), 'xchg [ecx], eax');
        assert.ok(holds(InterlockedExchangeAdd.code, [0xf0, 0x0f, 0xc1, 0x01, 0xc2]),
            'lock xadd [ecx], eax, and nothing after it');
        assert.ok(holds(InterlockedCompareExchange.code, [0xf0, 0x0f, 0xb1, 0x11]),
            'lock cmpxchg [ecx], edx');
        for (const { argBytes, code } of Object.values(INTERLOCKED))
        {
            assert.deepEqual([...code.slice(-3)], [0xc2, argBytes, 0x00], 'ret argBytes');
            assert.deepEqual([...code.slice(0, 4)], [0x8b, 0x4c, 0x24, 0x04],
                'the pointer from the first argument');
        }
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

test('a waitable timer in a set is ready once the clock has signalled it', ()=>{
    // WaitForSingleObject stopped needing a timer special case; a timer among
    // several handles is the same test as an event's, because the clock owns
    // the object's signalled state and a poll only reads it.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const timer = host.kernel.createTimer({ manualReset: false });
    timer.signalled = true;
    host.register(0x10, 'timer', timer);
    const idle = host.kernel.createTimer({ manualReset: false });
    host.register(0x14, 'timer', idle);
    new DataView(host.bytes.buffer).setUint32(0x400, 0x10, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_OBJECT_0);
    assert.equal(timer.signalled, false, 'a synchronisation timer is consumed by the wait');

    new DataView(host.bytes.buffer).setUint32(0x400, 0x14, true);
    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_TIMEOUT,
        'an armed but not-yet-due timer is not ready');
});

test('a thread in a polled set is ready once it has ended', ()=>{
    // Joining a worker by polling its handle with WaitForMultipleObjects: an
    // ended thread is signalled, one still running is not.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const worker = { kind: 'thread', id: 0x108, exitCode: /** @type {number | null} */ (null) };
    host.register(0x20, 'thread', worker);
    new DataView(host.bytes.buffer).setUint32(0x400, 0x20, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_TIMEOUT);
    worker.exitCode = 0;
    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_OBJECT_0);
    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 1, 0]), WAIT_OBJECT_0,
        'and stays so, for a wait on all of the set too');
});

test('a finite timeout is a wait with a deadline, not an immediate refusal', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.kernel.state.now = 1000;
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: false }));
    new DataView(host.bytes.buffer).setUint32(0x400, 0x10, true);

    // Parked, not refused. Answering at once that the time elapsed never lets
    // whoever would signal the object have a turn, so the loop a program wraps
    // around this cannot terminate however long it runs.
    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 250]), PARKED);
    assert.deepEqual(host.kernel.state.timed.at(-1), { deadline: 1250, result: WAIT_TIMEOUT },
        'the deadline is guest time, not a duration: the scheduler compares, it does not count');

    // INFINITE carries no deadline at all rather than one far away, so nothing
    // downstream has to decide how far away is far enough.
    fns.WaitForMultipleObjects.handler([1, 0x400, 0, INFINITE]);
    assert.equal(host.kernel.state.timed.at(-1), undefined);
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
    assert.equal(fns.ResumeThread.handler([0x20]), 0, 'resuming a running thread changes nothing');
    assert.equal(host.kernel.state.blocked.length, 0,
        'suspension is a count beside the thread\'s state, not a wait of its own');
});

test('a suspension past MAXIMUM_SUSPEND_COUNT fails and leaves the count alone', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const other = host.threads.second;
    host.register(0x20, 'thread', other);

    for (let count = 0; count < 127; count++)
    {
        assert.equal(fns.SuspendThread.handler([0x20]), count);
    }
    assert.equal(fns.SuspendThread.handler([0x20]), 0xffffffff, '(DWORD)-1');
    assert.equal(other.suspendCount, 127);
    assert.deepEqual(host.errors, [ERROR_SIGNAL_REFUSED]);
});

test('GetThreadTimes fills a FILETIME per slot, zero exit for a running thread', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x20, 'thread', host.threads.second);

    const read64 = (/** @type {number} */ at)=>new DataView(host.bytes.buffer).getBigInt64(at, true);
    assert.equal(fns.GetThreadTimes.handler([0x20, 0x300, 0x308, 0x310, 0x318]), 1);
    assert.notEqual(read64(0x300), 0n, 'a creation time');
    assert.equal(read64(0x308), 0n, 'a running thread has no exit time');
    assert.equal(read64(0x310), 0n);
    assert.equal(read64(0x318), 0n);

    host.threads.second.exitCode = 0;
    assert.equal(fns.GetThreadTimes.handler([0x20, 0x300, 0x308, 0x310, 0x318]), 1);
    assert.notEqual(read64(0x308), 0n, 'an ended thread has an exit time');

    assert.equal(fns.GetThreadTimes.handler([0x1234, 0x300, 0x308, 0x310, 0x318]), 0);
    assert.deepEqual(host.errors, [6], 'ERROR_INVALID_HANDLE');
});

test('GetProcessTimes fills the same four FILETIMEs for this process', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const read64 = (/** @type {number} */ at)=>new DataView(host.bytes.buffer).getBigInt64(at, true);
    assert.equal(fns.GetProcessTimes.handler([0xffffffff, 0x300, 0x308, 0x310, 0x318]), 1);
    assert.notEqual(read64(0x300), 0n, 'a creation time');
    assert.deepEqual([read64(0x308), read64(0x310), read64(0x318)], [0n, 0n, 0n],
        'running: no exit time');
    assert.equal(fns.GetProcessTimes.handler([0x1234, 0x300, 0x308, 0x310, 0x318]), 0);
    assert.deepEqual(host.errors, [6], 'ERROR_INVALID_HANDLE');
});

test('SetThreadAffinityMask records the mask and answers the one before', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x20, 'thread', host.threads.second);

    assert.equal(fns.SetThreadAffinityMask.handler([0x20, 2]), 1, 'the one processor');
    assert.equal(fns.SetThreadAffinityMask.handler([0x20, 4]), 2, 'what was set before');
    assert.equal(host.threads.second.affinityMask, 4);

    assert.equal(fns.SetThreadAffinityMask.handler([0x1234, 1]), 0, 'not a thread');
    assert.deepEqual(host.errors, [6], 'ERROR_INVALID_HANDLE');
});

test('SetThreadIdealProcessor records the ideal and answers the one before', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x20, 'thread', host.threads.second);

    assert.equal(fns.SetThreadIdealProcessor.handler([0x20, 1]), 0, 'processor 0 before');
    assert.equal(fns.SetThreadIdealProcessor.handler([0x20, 3]), 1);
    assert.equal(host.threads.second.idealProcessor, 3);
});

test('a thread resumed while queued behind a released section takes it', ()=>{
    // Suspended behind a section, a thread is passed over by the release that
    // nobody else could take; resuming it hands it the section then.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const builder = fakeBuilder();
    fns.EnterCriticalSection.guest(builder);
    fns.LeaveCriticalSection.guest(builder);
    const [wait, wake] = builder.registered.map(one=>one.trap);
    const section = 0x200;
    const waiter = host.threads.second;
    host.register(0x20, 'thread', waiter);

    host.run(waiter);
    wait.handler([section]);
    host.run(host.threads.first);
    fns.SuspendThread.handler([0x20]);
    wake.handler([section]);
    assert.deepEqual(host.kernel.state.woken, [], 'nobody could take it');

    assert.equal(fns.ResumeThread.handler([0x20]), 1);
    assert.deepEqual(host.kernel.state.woken, [waiter]);
    assert.equal(host.readI32(section + CS_OWNING_THREAD), waiter.id);
});

test('a thread that has ended cannot be suspended', ()=>{
    // Wine's thread test: SuspendThread on a thread that has finished answers
    // (DWORD)-1, with ERROR_ACCESS_DENIED.
    const ERROR_ACCESS_DENIED = 5;
    const host = fakeHost();
    Object.assign(host.kernel, { ThreadState: { TERMINATED: 'terminated' } });
    const fns = createSyncFunctions(host);
    const other = host.threads.second;
    other.state = 'terminated';
    host.register(0x20, 'thread', other);

    assert.equal(fns.SuspendThread.handler([0x20]), 0xffffffff);
    assert.deepEqual(host.errors, [ERROR_ACCESS_DENIED]);
    assert.equal(other.suspendCount ?? 0, 0, 'and nothing is counted');
});

test('resuming a suspended child is what arms the replacement', ()=>{
    // CREATE_SUSPENDED, WriteProcessMemory, ResumeThread is how a launcher
    // hollows its child. The handle names a process record rather than a
    // thread -- there is no thread until the child is really running -- so
    // without this it resolves as nothing and the resume is silently lost.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const child = { imagePath: 'C:\\App\\child.exe', suspended: true };
    host.register(0x24, 'process-thread', child);

    assert.equal(fns.ResumeThread.handler([0x24]), 1, 'a suspended child had a count of one');
    assert.equal(child.suspended, false);
    assert.equal(fns.ResumeThread.handler([0x24]), 0, 'and resuming again does nothing');
});

test('argument sizes match what the guest compiled against', ()=>{
    const fns = createSyncFunctions(fakeHost());

    assert.equal(fns.InitializeCriticalSection.argBytes, 4);
    assert.equal(fns.InitializeCriticalSectionAndSpinCount.argBytes, 8);
    assert.equal(fns.InterlockedIncrement.argBytes, 4);
    assert.equal(fns.InterlockedDecrement.argBytes, 4);
    assert.equal(fns.InterlockedExchange.argBytes, 8);
    assert.equal(fns.InterlockedExchangeAdd.argBytes, 8);
    assert.equal(fns.InterlockedCompareExchange.argBytes, 12);
    assert.equal(fns.WaitForMultipleObjects.argBytes, 16);
    assert.equal(fns.GetCurrentThread.argBytes, 0);
});

// --- waiting on a child process ---

test('a wait on a set holding a child process is where the parent hands over', ()=>{
    // A child never signals while its parent can look: it takes this process's
    // place rather than running beside it. So the thread stops here for good,
    // and the replacement is what happens instead of the wait returning. Left
    // to the ordinary path this joins a queue on an object with no signal and
    // is reported as a deadlock.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    /** @type {any} */
    const child = { imagePath: 'C:\\App\\war3.exe' };
    host.register(0x20, 'process', child);
    new DataView(host.bytes.buffer).setUint32(0x400, 0x20, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, INFINITE]), PARKED);
    assert.equal(child.waiters.length, 1, 'noted on the child, to be woken when it exits');
    assert.equal(host.kernel.state.blocked.length, 1);
    assert.match(host.kernel.state.blocked[0].reason, /child process/);
    assert.deepEqual(host.kernel.state.timed, [],
        'and it never went through the ordinary wait at all');
});

test('a child among other objects still hands over, waiting for all or any', ()=>{
    // A wait for any is noted on the child, whose own place in the set is the
    // answer unless something else in it came first; a wait for all cannot be
    // satisfied by the child alone, and is left to the replacement.
    for (const all of [0, 1])
    {
        const host = fakeHost();
        const fns = createSyncFunctions(host);
        /** @type {any} */
        const child = { imagePath: 'C:\\App\\war3.exe' };
        host.register(0x10, 'event', host.kernel.createEvent({ signalled: true }));
        host.register(0x20, 'process', child);
        const view = new DataView(host.bytes.buffer);
        view.setUint32(0x400, 0x10, true);
        view.setUint32(0x404, 0x20, true);

        assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, all, INFINITE]), PARKED,
            `bWaitAll=${all}`);
        assert.deepEqual(child.waiters?.map((/** @type {any} */ one)=>one.result),
            all ? undefined : [1], `bWaitAll=${all}`);
        assert.equal(child.handsOver, all ? true : undefined,
            'the child alone cannot answer a wait for all of them: the parent hands over');
    }
});

test('polling a set with a child says it is still running rather than blocking', ()=>{
    // A zero timeout is a question, not a wait. Parking on it would stop a
    // program that was only checking whether its child had finished.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    /** @type {any} */
    const child = { imagePath: 'C:\\App\\war3.exe' };
    host.register(0x20, 'process', child);
    new DataView(host.bytes.buffer).setUint32(0x400, 0x20, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_TIMEOUT);
    assert.equal(host.kernel.state.blocked.length, 0, 'and did not join the queue');
    assert.equal(child.handsOver, undefined, 'a question hands nothing over');
});

test('polling for all of a set with a child can never be satisfied', ()=>{
    // Every other object being ready is not enough: the child is never ready,
    // so "all of them" never is either -- and answering otherwise tells a
    // program its child has finished.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: true }));
    host.register(0x20, 'process', { imagePath: 'C:\\App\\war3.exe' });
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x400, 0x10, true);
    view.setUint32(0x404, 0x20, true);

    assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 1, 0]), WAIT_TIMEOUT);
});

test('polling for any of a set with a child still reports one that is ready', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: true }));
    host.register(0x20, 'process', { imagePath: 'C:\\App\\war3.exe' });
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x400, 0x20, true);
    view.setUint32(0x404, 0x10, true);

    assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 0, 0]), WAIT_OBJECT_0,
        'the event, which is the only thing in the set that can be');
});

test('an event of the set the child signalled before it exited is the answer, taken', ()=>{
    // A launcher waits for its game's process or a named event the game sets
    // once it is running. The game opens the event by name and signals it; on
    // Windows that wakes the launcher, which goes on while the game runs. Here
    // the launcher only resumes once the game has exited -- and must still be
    // told the event came first, not that the game ended.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    /** @type {any} */
    const child = { imagePath: 'C:\\App\\war3.exe' };
    const event = host.kernel.createEvent({ signalled: false, manualReset: false });
    host.register(0x20, 'process', child);
    host.register(0x10, 'event', event);
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x400, 0x20, true);
    view.setUint32(0x404, 0x10, true);

    assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 0, INFINITE]), PARKED);
    const [waiter] = child.waiters;
    assert.equal(waiter.settle(), 0, 'nothing signalled: the child exiting is the answer');

    event.signalled = true;
    assert.equal(waiter.settle(), 1, 'the event the child set came before its exit');
    assert.equal(event.signalled, false, 'and the wait took it, as an auto-reset event is taken');
});

test('a set with a pseudo-handle or a stale handle fails with ERROR_INVALID_HANDLE', ()=>{
    // Unlike WaitForSingleObject, no pseudo-handle is accepted in a set, the
    // running process and thread included, wherever in the set it stands.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: true, manualReset: true }));
    const view = new DataView(host.bytes.buffer);
    for (const bad of [0xffffffff, 0xfffffffe, 0xfffffffd, 0xfffffffc, 0xdeadbee0])
    {
        view.setUint32(0x400, 0x10, true);
        view.setUint32(0x404, bad, true);
        host.errors.length = 0;
        assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 0, 0]), WAIT_FAILED);
        assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 1, 0]), WAIT_FAILED);
        assert.deepEqual(host.errors, [6, 6]);
    }
});

test('a set reads its handles without their two tag bits, and a standard stream is ready', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: false }));
    host.register(0x14, 'event', host.kernel.createEvent({ signalled: true, manualReset: true }));
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x400, 0x13, true);
    view.setUint32(0x404, 0x15, true);
    assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 0, 0]), WAIT_OBJECT_0 + 1);

    for (const stream of [0xfffffff6, 0xfffffff5, 0xfffffff4, 1, 2, 3])
    {
        view.setUint32(0x400, stream, true);
        assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, 0]), WAIT_OBJECT_0);
    }
});

test('a count of nothing or of too much is ERROR_INVALID_PARAMETER', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    fns.WaitForMultipleObjects.handler([0, 0x400, 0, INFINITE]);
    fns.WaitForMultipleObjects.handler([65, 0x400, 0, INFINITE]);
    assert.deepEqual(host.errors, [87, 87]);
});

test('GetThreadContext fills the groups asked for, and SetThreadContext is refused', ()=>{
    const host = /** @type {any} */ (fakeHost());
    const said = /** @type {string[]} */ ([]);
    host.divergence = (/** @type {string} */ api)=>said.push(api);
    host.registers = ()=>({ eax: 1, ecx: 2, edx: 3, ebx: 4, esp: 0x5000, ebp: 6, esi: 7, edi: 8,
        eip: 0x401000, eflags: 0x246 });
    const fns = createSyncFunctions(host);
    const other = host.threads.second;
    other.context = { reg32: Int32Array.of(10, 11, 12, 13, 0x6000, 15, 16, 17), eip: 0x402000,
        flags: 0x202 };
    host.register(0x20, 'thread', other);
    const at = 0x400;
    const view = new DataView(host.bytes.buffer);
    const CONTEXT_FULL = 0x10007;

    view.setUint32(at, CONTEXT_FULL, true);
    assert.equal(fns.GetThreadContext.handler([0xfffffffe, at]), 1, 'the calling thread');
    assert.deepEqual([view.getUint32(at + 0xb0, true), view.getUint32(at + 0xc4, true),
        view.getUint32(at + 0xb8, true)], [1, 0x5000, 0x401000]);
    assert.equal(view.getUint32(at, true), CONTEXT_FULL, 'the flags stay as given');

    view.setUint32(at, 0x10001, true);
    view.setUint32(at + 0xb0, 0xcccccccc, true);
    assert.equal(fns.GetThreadContext.handler([0x20, at]), 1, 'a switched-away thread');
    assert.equal(view.getUint32(at + 0xb8, true), 0x402000);
    assert.equal(view.getUint32(at + 0xc4, true), 0x6000);
    assert.equal(view.getUint32(at + 0xb0, true), 0xcccccccc, 'integer registers not asked for');

    assert.equal(fns.SetThreadContext.handler([0x20, at]), 0);
    assert.deepEqual(said, ['SetThreadContext']);
    assert.equal(fns.GetThreadContext.handler([0x99, at]), 0, 'no such thread');
});

test('GetThreadSelectorEntry describes the flat selectors and the thread block behind FS', ()=>{
    const host = /** @type {any} */ (fakeHost());
    const fns = createSyncFunctions(host);
    const self = host.currentThread();
    self.tebAddress = 0x7ffd0000;
    const at = 0x400;
    assert.equal(fns.GetThreadSelectorEntry.handler([0xfffffffe, 0x3b, at]), 1);
    const bytes = host.bytes.subarray(at, at + 8);
    const base = (bytes[7] << 24 | bytes[4] << 16 | bytes[2] | bytes[3] << 8) >>> 0;
    assert.equal(base, 0x7ffd0000, 'FS is the thread block');
    assert.equal(bytes[0] | bytes[1] << 8, 0xfff);
    assert.equal(bytes[5] & 0x1f, 0x13);
    assert.equal(fns.GetThreadSelectorEntry.handler([0xfffffffe, 0x1b, at]), 1);
    assert.equal(bytes[6] & 0xc0, 0xc0, 'flat code: 32-bit and page granular');
    assert.equal(fns.GetThreadSelectorEntry.handler([0xfffffffe, 3, at]), 1, 'the null one');
    assert.equal(fns.GetThreadSelectorEntry.handler([0xfffffffe, 0x123, at]), 0);
    assert.equal(fns.GetThreadSelectorEntry.handler([0xfffffffe, 0xdeadbeef, at]), 0);
});

test('a debugged child reports its creation, then its exit, waited for as the child is', ()=>{
    // Wine's kernel32 process.c test_DebuggingFlag reads events until the
    // child's exit; WaitForDebugEvent was missing.
    const host = fakeHost();
    const kernel = /** @type {any} */ (host.kernel);
    const child = { id: 0x300, threadId: 0x304, handle: 0x40, threadHandle: 0x44,
        imagePath: 'C:/child.exe', exitCode: 259, completed: false,
        debugEvents: ['create', 'exit'], waiters: /** @type {any[]} */ ([]) };
    kernel.processes = { STILL_ACTIVE: 259, all: ()=>[child] };
    /** @type {any[]} */
    const blocked = [];
    kernel.block = (/** @type {any} */ thread, /** @type {string} */ why)=>blocked.push(why);
    const fns = createSyncFunctions(host);
    const view = new DataView(host.bytes.buffer);
    const event = ()=>[0, 4, 8, 12, 16, 20].map(at=>view.getUint32(0x200 + at, true));

    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0xffffffff]), 1);
    assert.deepEqual(event(), [3, 0x300, 0x304, 0, 0x40, 0x44], 'CREATE_PROCESS_DEBUG_EVENT');
    assert.equal(/** @type {any} */ (fns.ContinueDebugEvent).handler([0x300, 0x304, 0x10002]), 1);
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 0, 'a poll while it runs');
    assert.equal(host.errors.at(-1), 121, 'ERROR_SEM_TIMEOUT');

    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0xffffffff]), PARKED);
    assert.equal(blocked.length, 1, 'the debugger waits on the child');
    child.exitCode = 7;
    assert.equal(child.waiters[0].settle(), 1, 'its exit is the answer');
    assert.deepEqual(event().slice(0, 4), [5, 0x300, 0x304, 7], 'EXIT_PROCESS_DEBUG_EVENT');
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 100]), 0, 'and then nothing more');
    assert.equal(fns.WaitForDebugEvent.argBytes, 8);
    assert.equal(fns.ContinueDebugEvent.argBytes, 12);
});

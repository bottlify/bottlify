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
import { childThread } from './cross-process.js';

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
const ERROR_ACCESS_DENIED = 5;

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
    // The trap beside it is a 64-bit process's (critical-paths.itest.js).
    assert.equal(typeof fns.EnterCriticalSection.handler, 'function');
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

test('InitializeCriticalSectionEx makes InitializeCriticalSection\'s section, flags aside', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.bytes.fill(0xcc, 0x200, 0x200 + 0x18);

    assert.equal(fns.InitializeCriticalSectionEx.argBytes, 12);
    // CRITICAL_SECTION_NO_DEBUG_INFO, as the 2015 runtime passes it.
    assert.equal(fns.InitializeCriticalSectionEx.handler([0x200, 4000, 0x01000000]), 1);
    assert.equal(host.readI32(0x200), -1, 'no debug record');
    assert.equal(host.readI32(0x200 + CS_LOCK_COUNT), CS_UNLOCKED);
    assert.equal(host.readI32(0x200 + CS_RECURSION_COUNT), 0);
    assert.equal(host.readI32(0x200 + CS_OWNING_THREAD), 0);
    assert.equal(host.readI32(0x200 + CS_SPIN_COUNT), 4000);
    // The count's top byte holds flags, not count.
    fns.InitializeCriticalSectionEx.handler([0x200, 0x80000fa0, 0]);
    assert.equal(host.readI32(0x200 + CS_SPIN_COUNT), 0xfa0);
});

test('InitializeCriticalSectionEx has no debug information unless it is forced', ()=>{
    // Wine's kernel32 sync.c test_crit_section, as Windows 8 on answers it.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    for (const flags of [0, 0x01000000])
    {
        assert.equal(fns.InitializeCriticalSectionEx.handler([0x200, 4000, flags]), 1);
        assert.equal(host.readI32(0x200), -1, 'DebugInfo');
        assert.equal(host.readI32(0x200 + CS_LOCK_COUNT), CS_UNLOCKED);
        assert.equal(host.readI32(0x200 + CS_SPIN_COUNT), 4000);
    }
    assert.equal(fns.InitializeCriticalSectionEx.handler([0x200, 0, 0x10000000]), 1);
    const debug = host.readI32(0x200);
    assert.ok(debug !== 0 && debug !== -1, 'RTL_CRITICAL_SECTION_FLAG_FORCE_DEBUG_INFO');
    assert.equal(host.readI32(debug + 4), 0x200, 'naming its section');
    assert.equal(fns.InitializeCriticalSectionEx.handler([0x200, 0, 0x10]), 0);
    assert.equal(host.errors.at(-1), 87);
});

test('SetCriticalSectionSpinCount keeps the count in the section and answers the old one', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    fns.InitializeCriticalSectionAndSpinCount.handler([0x200, 4000]);

    assert.equal(fns.SetCriticalSectionSpinCount.argBytes, 8);
    assert.equal(fns.SetCriticalSectionSpinCount.handler([0x200, 1500]), 4000);
    assert.equal(host.readI32(0x200 + CS_SPIN_COUNT), 1500);
    assert.equal(host.readI32(0x200 + CS_LOCK_COUNT), CS_UNLOCKED, 'nothing else in it moves');
    assert.equal(fns.SetCriticalSectionSpinCount.handler([0x200, 0]), 1500);
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
        // At 64 bits the same instruction on [rcx], the value from EDX and
        // the comparand from R8D, and a plain ret: x64 has its callers pop.
        assert.ok(holds(InterlockedIncrement.long, [0xf0, 0x0f, 0xc1, 0x01, 0xff, 0xc0]),
            'lock xadd [rcx], eax; inc eax');
        assert.ok(holds(InterlockedDecrement.long, [0xf0, 0x0f, 0xc1, 0x01, 0xff, 0xc8]),
            'lock xadd [rcx], eax; dec eax');
        assert.ok(holds(InterlockedExchange.long, [0x89, 0xd0, 0x87, 0x01]),
            'mov eax, edx; xchg [rcx], eax');
        assert.ok(holds(InterlockedExchangeAdd.long, [0x89, 0xd0, 0xf0, 0x0f, 0xc1, 0x01]),
            'mov eax, edx; lock xadd [rcx], eax');
        assert.ok(holds(InterlockedCompareExchange.long,
            [0x44, 0x89, 0xc0, 0xf0, 0x0f, 0xb1, 0x11]), 'mov eax, r8d; lock cmpxchg [rcx], edx');
        for (const { long } of Object.values(INTERLOCKED))
        {
            assert.equal(long[long.length - 1], 0xc3, 'ret');
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

test('a 64-bit caller\'s handle array holds a quadword a handle', ()=>{
    // HANDLE is a pointer: read four bytes apart, the second handle of the set
    // was the first's high half -- zero, an invalid handle, and the whole
    // wait failed.
    const host = fakeHost();
    const fns = createSyncFunctions({ ...host, pointerSize: 8 });
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: false }));
    host.register(0x14, 'event', host.kernel.createEvent({ signalled: true }));

    const array = 0x400;
    const view = new DataView(host.bytes.buffer);
    view.setBigUint64(array, 0x10n, true);
    view.setBigUint64(array + 8, 0x14n, true);

    assert.equal(fns.WaitForMultipleObjects.handler([2, array, 0, INFINITE]), WAIT_OBJECT_0 + 1);
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

test('the user times are the processor time the scheduler gave, the process\'s past the wall'
    + ' clock when its threads ran at once', ()=>{
    const host = fakeHost();
    /** @type {any} */ (host.kernel).processCpuMs = ()=>2500;
    const fns = createSyncFunctions(host);
    host.register(0x20, 'thread', host.threads.second);
    host.threads.second.cpuMs = 1250.5;
    const read64 = (/** @type {number} */ at)=>new DataView(host.bytes.buffer).getBigInt64(at, true);
    assert.equal(fns.GetThreadTimes.handler([0x20, 0, 0, 0x310, 0x318]), 1);
    assert.deepEqual([read64(0x310), read64(0x318)], [0n, 12_505_000n], '100 ns units, user time');
    assert.equal(fns.GetProcessTimes.handler([0xffffffff, 0, 0, 0x310, 0x318]), 1);
    assert.equal(read64(0x318), 25_000_000n);
});

test('SetThreadAffinityMask records the mask and answers the one before', ()=>{
    // One processor: its mask is the only one there is to set, and the one a
    // thread had before (Wine's kernel32 test_thread_processor).
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x20, 'thread', host.threads.second);

    assert.equal(fns.SetThreadAffinityMask.handler([0x20, 1]), 1, 'the process\'s, before');
    assert.equal(host.threads.second.affinityMask, 1);
    assert.equal(fns.SetThreadAffinityMask.handler([0x20, 0xffffffff]), 1, 'every processor');

    assert.equal(fns.SetThreadAffinityMask.handler([0x20, 2]), 0, 'a processor there is not');
    assert.equal(fns.SetThreadAffinityMask.handler([0x20, 0]), 0, 'no processor');
    assert.equal(fns.SetThreadAffinityMask.handler([0x1234, 1]), 0, 'not a thread');
    assert.deepEqual(host.errors, [87, 87, 6], 'ERROR_INVALID_PARAMETER, then _HANDLE');
    assert.equal(host.threads.second.affinityMask, 1, 'nothing changed by a refusal');
});

test('GetThreadGroupAffinity answers the thread\'s mask in group zero, the mask a pointer wide',
    ()=>{
        for (const pointerSize of [4, 8])
        {
            const host = fakeHost();
            /** @type {any} */ (host.kernel).processors = ()=>4;
            const fns = createSyncFunctions({ ...host, pointerSize });
            host.register(0x20, 'thread', host.threads.second);
            assert.equal(fns.SetThreadAffinityMask.handler([0x20, 6]), 0xf);
            const out = 0x500;
            host.bytes.fill(0xcc, out, out + 32);
            assert.equal(fns.GetThreadGroupAffinity.handler([0x20, out]), 1);
            const view = new DataView(host.bytes.buffer);
            assert.equal(view.getUint32(out, true), 6, 'the mask');
            if (pointerSize === 8)
            {
                assert.equal(view.getUint32(out + 4, true), 0, 'all eight bytes of it');
            }
            assert.deepEqual([...host.bytes.subarray(out + pointerSize, out + pointerSize + 8)],
                new Array(8).fill(0), 'group zero, the reserved words zero');
            assert.equal(host.bytes[out + pointerSize + 8], 0xcc, 'and nothing past them');
            assert.equal(fns.GetThreadGroupAffinity.handler([0x1234, out]), 0, 'not a thread');
        }
    });

test('on four processors a thread is kept to the ones its mask names, within its process\'s',
    ()=>{
        const host = fakeHost();
        /** @type {any} */ (host.kernel).processors = ()=>4;
        const fns = createSyncFunctions(host);
        host.register(0x20, 'thread', host.threads.second);

        assert.equal(fns.SetThreadAffinityMask.handler([0x20, 4]), 0xf, 'every processor before');
        assert.equal(fns.SetThreadAffinityMask.handler([0x20, 0x13]), 4,
            'the bits past the fourth go');
        assert.equal(host.threads.second.affinityMask, 3);
        assert.equal(fns.SetThreadAffinityMask.handler([0x20, 0x10]), 0, 'none of the four');
        assert.deepEqual(host.errors, [87]);
    });

test('a thread that moves itself off its processor gives up its turn and answers the old mask',
    ()=>{
        // A program pins itself to each processor in turn and reads the APIC id
        // there: the call returns on one the new mask names.
        const host = fakeHost();
        /** @type {any} */
        const kernel = host.kernel;
        kernel.processors = ()=>4;
        kernel.processorOf = (/** @type {any} */ thread)=>(thread === host.threads.first ? 2 : 0);
        /** @type {any[]} */
        const blocked = [];
        kernel.block = (/** @type {any} */ thread, /** @type {string} */ reason,
            /** @type {any} */ timed)=>blocked.push({ thread, reason, timed });
        host.kernel.state.now = 50;
        const fns = createSyncFunctions(host);

        assert.equal(fns.SetThreadAffinityMask.handler([0xfffffffe, 0xc]), 0xf, 'still on 2');
        assert.deepEqual(blocked, []);
        assert.equal(fns.SetThreadAffinityMask.handler([0xfffffffe, 1]), PARKED, 'off 2');
        assert.deepEqual(blocked, [{ thread: host.threads.first, reason: 'SetThreadAffinityMask',
            timed: { deadline: 50, result: 0xc } }], 'woken at once, with the mask before');
        assert.equal(host.threads.first.affinityMask, 1);

        host.register(0x20, 'thread', host.threads.second);
        assert.equal(fns.SetThreadAffinityMask.handler([0x20, 2]), 0xf, 'another thread: no wait');
        assert.equal(blocked.length, 1);
    });

test('SetThreadIdealProcessor records the ideal and answers the one before', ()=>{
    const host = fakeHost();
    /** @type {any} */ (host.kernel).processors = ()=>4;
    const fns = createSyncFunctions(host);
    host.register(0x20, 'thread', host.threads.second);

    assert.equal(fns.SetThreadIdealProcessor.handler([0x20, 1]), 0, 'processor 0 before');
    assert.equal(fns.SetThreadIdealProcessor.handler([0x20, 3]), 1);
    assert.equal(host.threads.second.idealProcessor, 3);
    assert.equal(fns.SetThreadIdealProcessor.handler([0x20, 32]), 3, 'MAXIMUM_PROCESSORS reads');
    assert.equal(host.threads.second.idealProcessor, 3);
});

test('SetThreadIdealProcessor refuses a processor the machine does not have', ()=>{
    // Wine's kernel32 test_thread_processor: MAXIMUM_PROCESSORS + 1 is (DWORD)-1
    // and ERROR_INVALID_PARAMETER, MAXIMUM_PROCESSORS itself an answer.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    assert.equal(fns.SetThreadIdealProcessor.handler([0xfffffffe, 0]), 0);
    assert.equal(fns.SetThreadIdealProcessor.handler([0xfffffffe, 1]), 0xffffffff, 'one: 0 only');
    assert.equal(fns.SetThreadIdealProcessor.handler([0xfffffffe, 33]), 0xffffffff);
    assert.equal(fns.SetThreadIdealProcessor.handler([0xfffffffe, 32]), 0);
    assert.equal(fns.SetThreadIdealProcessor.handler([0x1234, 0]), 0xffffffff, 'not a thread');
    assert.deepEqual(host.errors, [87, 87, 6]);
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

test('resuming a child\'s first thread is asked of the child, where it runs', async()=>{
    // CREATE_SUSPENDED, WriteProcessMemory, ResumeThread is how a launcher
    // hollows its child. The thread is the child's, so its count is too: the
    // call is made there, on the thread of the id CreateProcess answered.
    const host = /** @type {any} */ (fakeHost());
    /** @type {any[]} */
    const asked = [];
    host.askChild = (/** @type {any} */ record, /** @type {any} */ call)=>{
        asked.push({ record, call });
        return Promise.resolve({ result: 1, error: 0, outs: [null] });
    };
    /** @type {any[]} */
    const errors = [];
    host.setLastErrorFor = (/** @type {any} */ thread, /** @type {number} */ code)=>
        errors.push({ thread, code });
    const fns = createSyncFunctions(host);
    const child = { imagePath: 'C:\\App\\child.exe', threadId: 0x2c };
    host.register(0x24, 'process-thread', childThread(child, 0x2c));

    assert.equal(await fns.ResumeThread.handler([0x24]), 1, 'the count the child\'s thread had');
    assert.deepEqual(asked, [{ record: child, call: { call: 'ResumeThread',
        args: [{ thread: 0x2c }] } }]);
    assert.deepEqual(errors, [{ thread: host.threads.first, code: 0 }],
        'the last error set on the thread that asked');
});

test('a child no run can ask fails the resume with ERROR_ACCESS_DENIED', ()=>{
    // Answering as if resumed would tell the launcher its child is running.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    host.register(0x24, 'process-thread',
        childThread({ imagePath: 'C:\\App\\child.exe', threadId: 0x2c }, 0x2c));

    assert.equal(fns.ResumeThread.handler([0x24]), WAIT_FAILED);
    assert.equal(fns.SuspendThread.handler([0x24]), WAIT_FAILED);
    assert.deepEqual(host.errors, [ERROR_ACCESS_DENIED, ERROR_ACCESS_DENIED]);
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

/**
 * A child as the kernel records it: running beside its parent, its exit the
 * manual-reset event the kernel sets when it ends.
 *
 * @param {ReturnType<typeof fakeHost>} host
 */
const childOf = host=>({ imagePath: 'C:\\App\\child.exe',
    exited: host.kernel.createEvent({ manualReset: true }) });

test('a wait on a set holding a child is a wait on its exit', ()=>{
    // The child runs beside its parent, so its exit is an ordinary signal:
    // the parent blocks on it like on any other object, until it is set.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const child = childOf(host);
    host.register(0x20, 'process', child);
    new DataView(host.bytes.buffer).setUint32(0x400, 0x20, true);

    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, INFINITE]), PARKED);
    assert.equal(host.kernel.state.blocked.length, 1, 'blocked like any other wait');

    child.exited.signalled = true;
    assert.equal(fns.WaitForMultipleObjects.handler([1, 0x400, 0, INFINITE]), WAIT_OBJECT_0);
    assert.equal(child.exited.signalled, true, 'an exit stays signalled for every waiter');
});

test('polling a set with a running child times out rather than blocking', ()=>{
    // A zero timeout is a question, not a wait: a program checking whether
    // its child has finished is told it has not, and goes on.
    for (const all of [0, 1])
    {
        const host = fakeHost();
        const fns = createSyncFunctions(host);
        host.register(0x10, 'event',
            host.kernel.createEvent({ signalled: true, manualReset: true }));
        host.register(0x20, 'process', childOf(host));
        const view = new DataView(host.bytes.buffer);
        view.setUint32(0x400, 0x20, true);
        view.setUint32(0x404, 0x10, true);

        assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, all, 0]),
            all ? WAIT_TIMEOUT : WAIT_OBJECT_0 + 1, `bWaitAll=${all}`);
        assert.equal(host.kernel.state.blocked.length, 0, 'and did not join a queue');
    }
});

test('a child that has exited satisfies a wait for all of a set with it', ()=>{
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const child = childOf(host);
    child.exited.signalled = true;
    host.register(0x10, 'event', host.kernel.createEvent({ signalled: true }));
    host.register(0x20, 'process', child);
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x400, 0x10, true);
    view.setUint32(0x404, 0x20, true);

    assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 1, 0]), WAIT_OBJECT_0);
});

test('an event the running child signals answers a wait for any before its exit', ()=>{
    // A launcher waits for its game's process or a named event the game sets
    // once it is running; the game, beside it, sets the event, and the
    // launcher goes on while the game runs.
    const host = fakeHost();
    const fns = createSyncFunctions(host);
    const event = host.kernel.createEvent({ signalled: false, manualReset: false });
    host.register(0x20, 'process', childOf(host));
    host.register(0x10, 'event', event);
    const view = new DataView(host.bytes.buffer);
    view.setUint32(0x400, 0x20, true);
    view.setUint32(0x404, 0x10, true);

    event.signalled = true;
    assert.equal(fns.WaitForMultipleObjects.handler([2, 0x400, 0, INFINITE]), WAIT_OBJECT_0 + 1);
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

test('the debugger calls act on the children this process debugs and refuse the rest', ()=>{
    const host = fakeHost();
    const kernel = /** @type {any} */ (host.kernel);
    const debugged = { id: 0x300, debugEvents: ['create', 'exit'] };
    const plain = { id: 0x310, debugEvents: null };
    kernel.processes = { STILL_ACTIVE: 259, all: ()=>[debugged, plain] };
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {any} */ (createSyncFunctions({ ...host, kernel,
        divergence: (/** @type {string} */ api)=>said.push(api) }));
    host.register(0x50, 'process', debugged);
    host.register(0x54, 'process', plain);
    host.register(0x58, 'event', { kind: 'event' });
    assert.deepEqual([fns.DebugActiveProcessStop.argBytes, fns.DebugBreakProcess.argBytes,
        fns.DebugSetProcessKillOnExit.argBytes], [4, 4, 4]);

    assert.equal(fns.DebugSetProcessKillOnExit.handler([0]), 1, 'a debugger sets it');
    assert.equal(/** @type {any} */ (debugged).killOnExit, false);

    assert.equal(fns.DebugBreakProcess.handler([0xffffffff]), 1, 'no debugger: nothing happens');
    assert.equal(fns.DebugBreakProcess.handler([0x54]), 1);
    assert.equal(fns.DebugBreakProcess.handler([0x50]), 1);
    assert.deepEqual(said, ['DebugBreakProcess'], 'the debugged child\'s breakpoint is said');
    assert.equal(fns.DebugBreakProcess.handler([0x58]), 0, 'an event is no process');
    assert.equal(host.errors.at(-1), 6);

    assert.equal(fns.DebugActiveProcessStop.handler([0x310]), 0, 'not debugged by us');
    assert.equal(host.errors.at(-1), 6);
    assert.equal(fns.DebugActiveProcessStop.handler([0x999]), 0, 'no such process');
    assert.equal(host.errors.at(-1), 87);
    assert.equal(fns.DebugActiveProcessStop.handler([0x300]), 1);
    assert.equal(debugged.debugEvents, null, 'it reports to nobody now');
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 0, 'and no event comes');

    assert.equal(fns.DebugSetProcessKillOnExit.handler([1]), 0,
        'with no child debugged there is no debug object to set');
    assert.equal(host.errors.at(-1), 6);
});

test('ReinitializeCriticalSection makes a section new again, as InitializeCriticalSection does',
    ()=>{
        const host = fakeHost();
        const fns = /** @type {any} */ (createSyncFunctions(host));
        assert.equal(fns.ReinitializeCriticalSection.argBytes, 4);
        host.bytes.fill(0x55, 0x100, 0x118);
        fns.ReinitializeCriticalSection.handler([0x100]);
        const reinitialised = host.bytes.slice(0x100, 0x118);
        host.bytes.fill(0x55, 0x100, 0x118);
        fns.InitializeCriticalSection.handler([0x100]);
        assert.deepEqual(reinitialised, host.bytes.slice(0x100, 0x118));
        assert.equal(host.readI32(0x104), -1, 'LockCount: free');
    });

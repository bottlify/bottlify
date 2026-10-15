/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlimSync, sleepCsCode, sleepSrwCode } from './slimsync.js';

/** What the bridge hands back for a call that cannot answer yet. */
const PARKED = Object.freeze({ parked: true });
const INFINITE = 0xffffffff;
const LOCK = 0x100;
const VARIABLE = 0x140;
const SECTION = 0x180;

/**
 * A kernel that records what blocks and what wakes, with a timeout the test
 * delivers itself, and a guest memory the words live in.
 */
/**
 * @param {{ between?: () => void }} [race]  run once inside the first
 *     compare-and-swap, before it compares: another thread's store meanwhile
 */
function setup(race = {}){
    const bytes = new Uint8Array(0x1000);
    /** @type {any[]} */
    const blocked = [];
    /** @type {{ thread: any, result: number | undefined }[]} */
    const woken = [];
    /** @type {((thread: any) => void)[]} */
    const timeouts = [];
    /** @type {number[]} */
    const sectionWakes = [];
    /** @type {number[]} */
    const errors = [];
    const threads = { a: { id: 1, name: 'a' }, b: { id: 2, name: 'b' }, c: { id: 3, name: 'c' } };
    /** @type {any} */
    let current = threads.a;
    const kernel = {
        /** @param {any} thread @param {string} reason @param {any} [timed] */
        block: (thread, reason, timed)=>blocked.push({ thread, reason, timed }),
        /** @param {any} thread @param {number} [result] */
        wake: (thread, result)=>woken.push({ thread, result }),
        /** @param {(thread: any) => void} handler */
        onTimeout: handler=>timeouts.push(handler),
        clock: { virtualTime: ()=>1000 },
    };
    let free = 0x800;
    /** @type {{ label: string, trap: any }[]} */
    const registered = [];
    const builder = {
        /** @param {string} label @param {any} trap */
        register: (label, trap)=>{
            registered.push({ label, trap });
            return 0x105000 + registered.length * 0x10;
        },
    };
    const fns = createSlimSync({
        kernel,
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        compareExchangeU32: (/** @type {number} */ address, /** @type {number} */ expected,
            /** @type {number} */ value)=>
        {
            const between = race.between;
            race.between = undefined;
            between?.();
            const view = new DataView(bytes.buffer);
            const held = view.getUint32(address, true);
            if (held === expected)
            {
                view.setUint32(address, value, true);
            }
            return held;
        },
        currentThread: ()=>current,
        park: ()=>PARKED,
        allocate: size=>{
            const at = free;
            free += size;
            return at;
        },
        setLastError: code=>errors.push(code),
        critical: { wake: address=>sectionWakes.push(address) },
    }, ()=>0x106000);
    return {
        bytes, fns, threads, blocked, woken, timeouts, sectionWakes, errors, builder, registered,
        /** @param {any} thread */
        run: thread=>{
            current = thread;
        },
        /** @param {number} address */
        word: address=>new DataView(bytes.buffer).getUint32(address, true),
        /** @param {string} label */
        trap: label=>registered.find(entry=>entry.label === label)?.trap,
    };
}

test('an SRW lock is taken, shared, and handed on to its waiters in arrival order', ()=>{
    const { fns, threads, blocked, woken, run, word } = setup();

    assert.equal(fns.AcquireSRWLockExclusive.handler([LOCK]), 0, 'free, it is taken at once');
    assert.equal(word(LOCK), 1, 'and the word says it is held');
    run(threads.b);
    assert.equal(fns.AcquireSRWLockExclusive.handler([LOCK]), PARKED);
    run(threads.c);
    assert.equal(fns.AcquireSRWLockShared.handler([LOCK]), PARKED);
    assert.deepEqual(blocked.map(entry=>entry.thread), [threads.b, threads.c]);

    run(threads.a);
    fns.ReleaseSRWLockExclusive.handler([LOCK]);
    assert.deepEqual(woken, [{ thread: threads.b, result: 0 }], 'the writer that came first');
    run(threads.b);
    assert.equal(fns.TryAcquireSRWLockShared.handler([LOCK]), 0, 'held, nobody else gets in');
    fns.ReleaseSRWLockExclusive.handler([LOCK]);
    assert.deepEqual(woken.at(-1), { thread: threads.c, result: 0 });
    assert.equal(word(LOCK), 0x11, 'one reader inside');

    run(threads.a);
    assert.equal(fns.TryAcquireSRWLockShared.handler([LOCK]), 1, 'readers share');
    assert.equal(word(LOCK), 0x21);
    assert.equal(fns.TryAcquireSRWLockExclusive.handler([LOCK]), 0);
    fns.ReleaseSRWLockShared.handler([LOCK]);
    run(threads.c);
    fns.ReleaseSRWLockShared.handler([LOCK]);
    assert.equal(word(LOCK), 0, 'free again');
    assert.equal(fns.TryAcquireSRWLockExclusive.handler([LOCK]), 1);
});

test('releasing a lock the program set by hand clears the word', ()=>{
    // Wine's kernel32 sync test_srwlock_quirk: a word of 1 released
    // exclusively is 0, though no acquire was ever seen.
    const { fns, bytes, word } = setup();
    new DataView(bytes.buffer).setUint32(LOCK, 1, true);
    fns.ReleaseSRWLockExclusive.handler([LOCK]);
    assert.equal(word(LOCK), 0);
});

test('a reader does not overtake a writer already waiting', ()=>{
    const { fns, threads, woken, run } = setup();
    fns.AcquireSRWLockShared.handler([LOCK]);
    run(threads.b);
    assert.equal(fns.AcquireSRWLockExclusive.handler([LOCK]), PARKED);
    run(threads.c);
    assert.equal(fns.AcquireSRWLockShared.handler([LOCK]), PARKED,
        'otherwise a stream of readers keeps the writer out for ever');

    run(threads.a);
    fns.ReleaseSRWLockShared.handler([LOCK]);
    assert.deepEqual(woken.map(entry=>entry.thread), [threads.b]);
    run(threads.b);
    fns.ReleaseSRWLockExclusive.handler([LOCK]);
    assert.deepEqual(woken.map(entry=>entry.thread), [threads.b, threads.c]);
});

test('sleeping on a condition variable queues, then lets go of the lock, in one call', ()=>{
    const { fns, threads, blocked, woken, run, word, builder, trap } = setup();
    fns.SleepConditionVariableSRW.guest(builder);
    const sleep = trap('<cv-sleep-srw>');

    fns.AcquireSRWLockExclusive.handler([LOCK]);
    run(threads.b);
    fns.AcquireSRWLockExclusive.handler([LOCK]);
    run(threads.a);
    assert.equal(sleep.handler([VARIABLE, LOCK, INFINITE, 0]), PARKED);
    assert.equal(blocked.at(-1).thread, threads.a);
    assert.equal(blocked.at(-1).timed, undefined, 'INFINITE has no deadline');
    assert.deepEqual(woken, [{ thread: threads.b, result: 0 }],
        'the lock went to the thread waiting for it');
    assert.equal(word(LOCK), 1);

    run(threads.b);
    fns.WakeConditionVariable.handler([VARIABLE]);
    assert.deepEqual(woken.at(-1), { thread: threads.a, result: 1 }, 'TRUE, when woken');
    fns.WakeConditionVariable.handler([VARIABLE]);
    assert.equal(woken.length, 2, 'a wake with nobody asleep is spent on nobody');
});

test('a sleep that runs out of time leaves the queue, and every sleeper can be woken at once', ()=>{
    const { fns, threads, blocked, woken, timeouts, run, builder, trap } = setup();
    fns.SleepConditionVariableSRW.guest(builder);
    const sleep = trap('<cv-sleep-srw>');
    const CONDITION_VARIABLE_LOCKMODE_SHARED = 1;

    fns.AcquireSRWLockShared.handler([LOCK]);
    assert.equal(sleep.handler([VARIABLE, LOCK, 50, CONDITION_VARIABLE_LOCKMODE_SHARED]), PARKED);
    assert.deepEqual(blocked.at(-1).timed, { deadline: 1050, result: 0 },
        'FALSE when the time runs out');
    timeouts.forEach(handler=>handler(threads.a));
    fns.WakeConditionVariable.handler([VARIABLE]);
    assert.equal(woken.length, 0, 'it is no longer asleep');

    for (const thread of [threads.b, threads.c])
    {
        run(thread);
        sleep.handler([VARIABLE, LOCK, INFINITE, 0]);
    }
    fns.WakeAllConditionVariable.handler([VARIABLE]);
    assert.deepEqual(woken.map(entry=>entry.thread), [threads.b, threads.c]);
    assert.equal(sleep.handler([VARIABLE, LOCK, 0, 0]), 0, 'no time at all is FALSE at once');
});

test('sleeping on a condition variable with a critical section leaves the section', ()=>{
    const { bytes, fns, sectionWakes, builder, trap } = setup();
    fns.SleepConditionVariableCS.guest(builder);
    const sleep = trap('<cv-sleep-cs>');
    const view = new DataView(bytes.buffer);
    view.setInt32(SECTION + 4, 0, true);
    view.setInt32(SECTION + 8, 1, true);
    view.setInt32(SECTION + 12, 1, true);

    assert.equal(sleep.handler([VARIABLE, SECTION, INFINITE]), PARKED);
    assert.deepEqual([view.getInt32(SECTION + 4, true), view.getInt32(SECTION + 8, true),
        view.getInt32(SECTION + 12, true)], [-1, 0, 0], 'free, with nobody owed a wake');
    assert.deepEqual(sectionWakes, []);

    view.setInt32(SECTION + 4, 1, true);
    view.setInt32(SECTION + 8, 1, true);
    sleep.handler([VARIABLE, SECTION, INFINITE]);
    assert.deepEqual(sectionWakes, [SECTION], 'one waiting for the section is handed it');
});

test('a thread entering the section on another executor as the sleeper leaves it is handed it',
    ()=>{
        // The sleeper holds the section alone (LockCount 0); between the host's
        // read of the count and its store, another thread's `lock inc` takes it
        // to 1 and that thread goes to wait. Leaving brings it to 0, not -1, and
        // wakes the waiter.
        const race = {};
        const { bytes, fns, sectionWakes, builder, trap } = setup(race);
        fns.SleepConditionVariableCS.guest(builder);
        const sleep = trap('<cv-sleep-cs>');
        const view = new DataView(bytes.buffer);
        view.setInt32(SECTION + 4, 0, true);
        view.setInt32(SECTION + 8, 1, true);
        view.setInt32(SECTION + 12, 1, true);
        Object.assign(race, { between: ()=>view.setInt32(SECTION + 4,
            view.getInt32(SECTION + 4, true) + 1, true) });

        assert.equal(sleep.handler([VARIABLE, SECTION, INFINITE]), PARKED);
        assert.equal(view.getInt32(SECTION + 4, true), 0,
            'one waiting, as the other\'s inc left it');
        assert.deepEqual(sectionWakes, [SECTION], 'and it is handed the section');
    });

test('the guest code around a sleep takes the lock back, and says when the time ran out', ()=>{
    /** @param {Uint8Array} code @param {number} at @param {number} offset */
    const target = (code, at, offset)=>{
        assert.equal(code[offset], 0xe8, `a call at +${offset}`);
        return at + offset + 5
            + new DataView(code.buffer, code.byteOffset).getInt32(offset + 1, true);
    };
    const at = 0x2000;
    const srw = sleepSrwCode(at, { sleep: 0x9000, timedOut: 0x9010, shared: 0x9020,
        exclusive: 0x9030 });
    assert.equal(target(srw, at, 16), 0x9000);
    assert.equal(target(srw, at, 26), 0x9010);
    assert.equal(target(srw, at, 42), 0x9020);
    assert.equal(target(srw, at, 49), 0x9030);
    assert.deepEqual([...srw.subarray(-4)], [0x58, 0xc2, 0x10, 0x00], 'pop eax; ret 16');

    const cs = sleepCsCode(at, { sleep: 0x9000, timedOut: 0x9010, enter: 0x9040 });
    assert.equal(target(cs, at, 12), 0x9000);
    assert.equal(target(cs, at, 22), 0x9010);
    assert.equal(target(cs, at, 31), 0x9040);
    assert.deepEqual([...cs.subarray(-4)], [0x58, 0xc2, 0x0c, 0x00], 'pop eax; ret 12');
});

const ONCE = 0x200;
const PENDING = 0x210;
const CONTEXT = 0x220;
const INIT_ONCE_CHECK_ONLY = 1;
const INIT_ONCE_ASYNC = 2;
const INIT_ONCE_INIT_FAILED = 4;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_GEN_FAILURE = 31;

test('a one-time initialisation begins once and completes once, as Wine\'s sync test has it', ()=>{
    const { bytes, fns, errors, word } = setup();
    const view = new DataView(bytes.buffer);
    /** @param {number} flags */
    const begin = flags=>fns.InitOnceBeginInitialize.handler([ONCE, flags, PENDING, CONTEXT]);
    /** @param {number} flags @param {number} context */
    const complete = (flags, context)=>fns.InitOnceComplete.handler([ONCE, flags, context]);
    /** @param {number} result @param {number} code */
    const refused = (result, code)=>{
        assert.equal(result, 0);
        assert.equal(errors.at(-1), code);
    };

    view.setUint32(ONCE, 0xdeadbeef, true);
    fns.InitOnceInitialize.handler([ONCE]);
    assert.equal(word(ONCE), 0);
    assert.equal(begin(0), 1);
    assert.equal(word(PENDING), 1, 'this caller is the one to do it');
    assert.equal(word(ONCE), 1);
    refused(begin(INIT_ONCE_CHECK_ONLY), ERROR_GEN_FAILURE);
    refused(complete(INIT_ONCE_INIT_FAILED, 0xdeadbee0), ERROR_INVALID_PARAMETER);
    assert.equal(complete(0, 0xdeadbee0), 1);
    assert.equal(word(ONCE), 0xdeadbee2, 'done, with its context above the state');
    assert.equal(begin(INIT_ONCE_CHECK_ONLY), 1);
    assert.equal(word(PENDING), 0);
    assert.equal(word(CONTEXT), 0xdeadbee0);

    fns.InitOnceInitialize.handler([ONCE]);
    refused(complete(INIT_ONCE_INIT_FAILED, 0), ERROR_GEN_FAILURE);
    refused(complete(INIT_ONCE_INIT_FAILED | INIT_ONCE_ASYNC, 0), ERROR_INVALID_PARAMETER);
    assert.equal(begin(0), 1);
    refused(begin(INIT_ONCE_ASYNC), ERROR_INVALID_PARAMETER);
    refused(complete(0, 0xdeadbeef), ERROR_INVALID_PARAMETER);
    assert.equal(complete(INIT_ONCE_INIT_FAILED, 0), 1);
    assert.equal(word(ONCE), 0, 'failed, it may be begun again');

    assert.equal(begin(INIT_ONCE_ASYNC), 1);
    assert.equal(word(ONCE), 3);
    refused(begin(0), ERROR_INVALID_PARAMETER);
    assert.equal(begin(INIT_ONCE_ASYNC), 1, 'others begin beside it without waiting');
    refused(complete(INIT_ONCE_INIT_FAILED, 0), ERROR_INVALID_PARAMETER);
    refused(complete(INIT_ONCE_ASYNC, 0xdeadbeef), ERROR_INVALID_PARAMETER);
    assert.equal(complete(INIT_ONCE_ASYNC, 0xdeadbee0), 1);
    assert.equal(word(ONCE), 0xdeadbee2);
    refused(complete(INIT_ONCE_INIT_FAILED | INIT_ONCE_ASYNC, 0), ERROR_INVALID_PARAMETER);
    refused(begin(INIT_ONCE_CHECK_ONLY | INIT_ONCE_ASYNC), ERROR_INVALID_PARAMETER);
});

test('a caller that finds initialisation under way waits for it, and is told how it went', ()=>{
    const { fns, threads, blocked, woken, run, word } = setup();
    /** @param {number} pending @param {number} context */
    const begin = (pending, context)=>
        fns.InitOnceBeginInitialize.handler([ONCE, 0, pending, context]);

    assert.equal(begin(PENDING, CONTEXT), 1);
    run(threads.b);
    assert.equal(begin(PENDING + 4, CONTEXT + 4), PARKED);
    run(threads.c);
    assert.equal(begin(PENDING + 8, CONTEXT + 8), PARKED);
    assert.deepEqual(blocked.map(entry=>entry.thread), [threads.b, threads.c]);

    run(threads.a);
    fns.InitOnceComplete.handler([ONCE, INIT_ONCE_INIT_FAILED, 0]);
    assert.deepEqual(woken, [{ thread: threads.b, result: 1 }],
        'a failure passes it to the next, who is now the one to do it');
    assert.equal(word(PENDING + 4), 1);
    assert.equal(word(ONCE), 1);

    run(threads.b);
    fns.InitOnceComplete.handler([ONCE, 0, 0x5550]);
    assert.deepEqual(woken.at(-1), { thread: threads.c, result: 1 });
    assert.equal(word(PENDING + 8), 0, 'done: not pending');
    assert.equal(word(CONTEXT + 8), 0x5550, 'and here is the context');
});

test('ExecuteOnce runs the function in the first caller only, and hands out its context', ()=>{
    const { fns, threads, woken, run, word, builder, trap, bytes } = setup();
    fns.InitOnceExecuteOnce.guest(builder);
    const begin = trap('<init-once-begin>');
    const end = trap('<init-once-end>');
    const view = new DataView(bytes.buffer);

    assert.equal(begin.handler([ONCE, CONTEXT]), 1, 'run the function');
    run(threads.b);
    assert.equal(begin.handler([ONCE, CONTEXT + 4]), PARKED, 'wait for the one running it');
    run(threads.a);
    view.setUint32(CONTEXT, 0xfffffff0, true);
    assert.equal(end.handler([ONCE, 1, CONTEXT]), 1, 'TRUE, as the function answered');
    assert.equal(word(ONCE), 0xfffffff2);
    assert.deepEqual(woken, [{ thread: threads.b, result: 0 }], 'done: nothing left to run');
    assert.equal(word(CONTEXT + 4), 0xfffffff0);
    assert.equal(begin.handler([ONCE, CONTEXT + 8]), 0);
    assert.equal(word(CONTEXT + 8), 0xfffffff0);

    fns.InitOnceInitialize.handler([ONCE]);
    assert.equal(begin.handler([ONCE, CONTEXT]), 1);
    assert.equal(end.handler([ONCE, 0, CONTEXT]), 0, 'FALSE, as the function answered');
    assert.equal(word(ONCE), 0, 'and it may be run again');
    fns.InitOnceBeginInitialize.handler([ONCE, INIT_ONCE_ASYNC, PENDING, CONTEXT]);
    assert.equal(begin.handler([ONCE, CONTEXT]), 2, 'an asynchronous one is not waited on');
});

test('argument sizes match what the guest compiled against', ()=>{
    const { fns } = setup();
    assert.deepEqual(Object.fromEntries(
        Object.entries(fns).map(([name, fn])=>[name, fn.argBytes])), {
        InitializeSRWLock: 4, AcquireSRWLockExclusive: 4, AcquireSRWLockShared: 4,
        TryAcquireSRWLockExclusive: 4, TryAcquireSRWLockShared: 4, ReleaseSRWLockExclusive: 4,
        ReleaseSRWLockShared: 4, InitializeConditionVariable: 4, WakeConditionVariable: 4,
        WakeAllConditionVariable: 4, SleepConditionVariableSRW: 16, SleepConditionVariableCS: 12,
        InitOnceInitialize: 4, InitOnceBeginInitialize: 16, InitOnceComplete: 12,
        InitOnceExecuteOnce: 16,
    });
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadPool, poolLoopCode } from './pool.js';

const PARKED = Object.freeze({ parked: true });
const RUN = 0x10000;
const RAN = 0x20000;
const INVALID_HANDLE_VALUE = 0xffffffff;
const ERROR_INVALID_HANDLE = 6;
const ERROR_IO_PENDING = 997;
const EVENT = 0x40;

/**
 * A machine with a clock the test moves, kernel timers it fires, and pool
 * threads the test steps through their loop by hand: `ask` is the loop's call
 * to the trap, and a RUN answer means the record now names a callback.
 */
function machine(){
    const memory = new Uint8Array(0x10000);
    let free = 0x1000;
    let now = 0;
    /** @type {any} */
    let current = { name: 'main' };
    const main = current;
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const traps = {};
    /** @type {any[]} */
    const created = [];
    /** @type {{ thread: any, result: number }[]} */
    const woken = [];
    /** @type {any[]} */
    const blocked = [];
    /** @type {number[]} */
    const errors = [];
    const event = { kind: 'event', signalled: false };
    /** @type {{ due: number, period: number, fired: Function | null }[]} */
    const clocks = [];
    /** @type {number[]} */
    const freed = [];

    const pool = createThreadPool({
        kernel: {
            currentThread: ()=>current,
            createThread: (/** @type {any} */ options)=>{
                const thread = { name: `${options.name} ${created.length}`, entry: options.entry };
                created.push(thread);
                return thread;
            },
            block: (/** @type {any} */ thread)=>blocked.push(thread),
            wake: (/** @type {any} */ thread, /** @type {number} */ result)=>{
                woken.push({ thread, result });
                return true;
            },
            createTimer: ()=>{
                const clock = { due: -1, period: 0, fired: null };
                clocks.push(clock);
                return clock;
            },
            armTimer: (/** @type {any} */ clock, /** @type {number} */ due,
                /** @type {number} */ period, /** @type {Function} */ fired)=>
                Boolean(Object.assign(clock, { due, period, fired })),
            cancelTimer: (/** @type {any} */ clock)=>Object.assign(clock,
                { due: -1, period: 0, fired: null }),
            setEvent: (/** @type {any} */ object)=>{
                object.signalled = true;
                return [];
            },
            handles: {
                resolve: (/** @type {number} */ handle)=>{
                    if (handle !== EVENT)
                    {
                        throw new Error('not an event');
                    }
                    return event;
                },
            },
            clock: { virtualTime: ()=>now },
        },
        register: (name, fn)=>{
            traps[name] = fn;
            return 0x900;
        },
        allocate: bytes=>{
            const at = free;
            free += Math.max(bytes, 16);
            return at;
        },
        free: address=>freed.push(address),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        threadBlock: thread=>{
            thread.block = true;
        },
        park: ()=>PARKED,
        setLastError: code=>errors.push(code),
    });
    const fns = pool.table;

    /** @param {number} at */
    const get32 = at=>(memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24) >>> 0;

    /** Where each thread's loop keeps its record, as its stack would. */
    const records = new Map();
    /** @param {any} thread */
    const recordOf = thread=>{
        if (!records.has(thread))
        {
            records.set(thread, 0x8000 + records.size * 0x20);
        }
        return records.get(thread);
    };

    /** The loop asking for work on `thread`. @param {any} thread */
    const ask = thread=>{
        const was = current;
        current = thread;
        const answer = traps['<thread-pool>'].handler([recordOf(thread), RAN]);
        current = was;
        return answer;
    };
    /** What the record of `thread` names. @param {any} thread */
    const record = thread=>({
        entry: get32(recordOf(thread)),
        args: [4, 8, 12, 16].map(offset=>get32(recordOf(thread) + offset)),
    });
    /** Moves the clock, firing every kernel timer that comes due. @param {number} ms */
    const tick = ms=>{
        const until = now + ms;
        for (;;)
        {
            const due = clocks.filter(clock=>clock.fired && clock.due <= until)
                .sort((a, b)=>a.due - b.due)[0];
            if (!due)
            {
                break;
            }
            now = due.due;
            const fired = /** @type {Function} */ (due.fired);
            if (due.period > 0)
            {
                due.due += due.period;
            }
            else
            {
                due.fired = null;
            }
            fired(now);
        }
        now = until;
    };
    /** Runs `fn` as though `thread` called it. @param {any} thread @param {() => any} fn */
    const as = (thread, fn)=>{
        const was = current;
        current = thread;
        try
        {
            return fn();
        }
        finally
        {
            current = was;
        }
    };
    /** @param {number} queue @param {number[]} rest */
    const timer = (queue, ...rest)=>{
        const out = 0x7000 + created.length * 4 + clocks.length * 16;
        assert.equal(fns.CreateTimerQueueTimer.handler([out, queue, ...rest]), 1);
        return get32(out);
    };

    return { pool, fns, memory, created, woken, blocked, errors, event, freed, main,
        ask, record, tick, as, timer, get32 };
}

test('the loop is the bytes it says it is, and both of its jumps land on the question', ()=>{
    const code = poolLoopCode(0x900, 0x200);
    assert.equal(code.length, 51);
    assert.deepEqual([...code.slice(0, 3)], [0x83, 0xec, 20], 'sub esp, 20: the record');
    assert.equal(code[14], 0xe8);
    const relative = new DataView(code.buffer).getInt32(15, true);
    assert.equal(0x200 + 19 + relative, 0x900, 'call fetch');
    // jne at 24 and jmp at 49, each two bytes, back to the push at 8.
    assert.equal(26 + (code[25] << 24 >> 24), 8);
    assert.equal(51 + (code[50] << 24 >> 24), 8);
});

test('a timer due now is handed to a pool thread before the call returns', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    assert.notEqual(queue, 0);
    assert.notEqual(m.fns.CreateTimerQueue.handler(), queue, 'each queue its own handle');

    const handle = m.timer(queue, 0x401000, 0xbeef, 0, 0, 0);
    assert.notEqual(handle, 0);
    assert.equal(m.created.length, 1, 'a thread for the callback');
    assert.equal(m.created[0].block, true, 'with an environment block of its own');

    assert.equal(m.ask(m.created[0]), RUN);
    assert.deepEqual(m.record(m.created[0]), { entry: 0x401000, args: [0xbeef, 1, 0, 0] },
        'the parameter, and TRUE: a timer callback has always timed out');
    assert.equal(m.ask(m.created[0]), PARKED, 'returned, and nothing else to do');
});

test('QueueUserWorkItem hands its routine and its context to a pool thread', ()=>{
    // An OpenMP runtime's workers: each item an ordinary call on a pool
    // thread, handed nothing but its context.
    const m = machine();
    assert.equal(m.fns.QueueUserWorkItem.argBytes, 12);
    assert.equal(m.fns.QueueUserWorkItem.handler([0x402000, 0xcafe, 0]), 1);
    assert.equal(m.created.length, 1, 'a thread for it');
    assert.equal(m.ask(m.created[0]), RUN);
    assert.deepEqual(m.record(m.created[0]), { entry: 0x402000, args: [0xcafe, 0, 0, 0] });
    assert.equal(m.ask(m.created[0]), PARKED, 'returned, and nothing else to do');

    assert.equal(m.fns.QueueUserWorkItem.handler([0, 0xcafe, 0]), 0, 'no routine to run');
    assert.equal(m.errors.at(-1), 87, 'ERROR_INVALID_PARAMETER');
});

test('the pool grows a thread at a time while callbacks wait, not a thread a callback', ()=>{
    // Wine's kernel32 test_QueueUserWorkItem queues a hundred items that
    // return at once: a thread each was a stack each, kept for good, and the
    // next thread the program made found no room.
    const m = machine();
    for (let item = 0; item < 100; item++)
    {
        assert.equal(m.fns.QueueUserWorkItem.handler([0x402000, item, 0]), 1);
    }
    assert.equal(m.created.length, 1, 'one thread on its way');

    const [first] = m.created;
    assert.equal(m.ask(first), RUN);
    assert.equal(m.created.length, 2, 'more wait: the next is started once it took one');
    for (let item = 1; item < 100; item++)
    {
        assert.equal(m.ask(first), RUN);
        assert.equal(m.record(first).args[0], item, 'in the order queued');
    }
    assert.equal(m.created.length, 2, 'the one already starting was enough');
    assert.equal(m.ask(m.created[1]), PARKED, 'and it finds nothing left');

    // Callbacks that block each other still get a thread each: every new
    // thread that takes one starts another while any waits.
    const n = machine();
    for (let item = 0; item < 3; item++)
    {
        n.fns.QueueUserWorkItem.handler([0x402000, item, 0]);
    }
    for (let started = 0; started < 3; started++)
    {
        assert.equal(n.ask(n.created[started]), RUN, `thread ${started} takes item ${started}`);
        assert.equal(n.record(n.created[started]).args[0], started);
    }
    assert.equal(n.created.length, 3, 'and no fourth');
});

test('a periodic timer fires on its period on the idle thread, and a busy one makes another', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    m.timer(queue, 0x401000, 1, 10, 10, 0);
    assert.equal(m.created.length, 0, 'nothing due yet');

    m.tick(10);
    const [first] = m.created;
    assert.equal(m.ask(first), RUN);
    assert.equal(m.ask(first), PARKED);

    m.tick(10);
    assert.deepEqual(m.woken.at(-1), { thread: first, result: RUN }, 'the idle thread takes it');
    assert.equal(m.created.length, 1);

    // Still inside that callback when the next comes due: a second thread.
    m.tick(10);
    assert.equal(m.created.length, 2);
    assert.equal(m.ask(m.created[1]), RUN);
    assert.equal(m.record(m.created[1]).entry, 0x401000);
});

test('WT_EXECUTEONLYONCE fires once whatever the period', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    m.timer(queue, 0x401000, 1, 5, 5, 0x8);
    m.tick(5);
    assert.equal(m.ask(m.created[0]), RUN);
    assert.equal(m.ask(m.created[0]), PARKED);
    m.tick(50);
    assert.equal(m.woken.length, 0);
});

test('a deletion with no event answers ERROR_IO_PENDING while a callback is outstanding', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    const done = m.timer(queue, 0x401000, 1, 0, 0, 0);
    const busy = m.timer(queue, 0x402000, 2, 0, 0, 0);
    const [one, two] = m.created;
    assert.equal(m.ask(one), RUN);
    assert.equal(m.ask(two), RUN);
    assert.equal(m.ask(one), PARKED, 'the first has returned');

    assert.equal(m.fns.DeleteTimerQueueTimer.handler([queue, done, 0]), 1,
        'nothing outstanding: done at once');
    assert.equal(m.fns.DeleteTimerQueueTimer.handler([queue, busy, 0]), 0);
    assert.deepEqual(m.errors, [ERROR_IO_PENDING]);
});

test('a deletion with an event sets it at once, or when the last callback returns', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    const done = m.timer(queue, 0x401000, 1, 0, 0, 0);
    assert.equal(m.ask(m.created[0]), RUN);
    assert.equal(m.ask(m.created[0]), PARKED);
    assert.equal(m.fns.DeleteTimerQueueTimer.handler([queue, done, EVENT]), 1);
    assert.equal(m.event.signalled, true);
    assert.deepEqual(m.errors, [], 'and the last error is left alone');

    m.event.signalled = false;
    const busy = m.timer(queue, 0x402000, 2, 0, 0, 0);
    assert.deepEqual(m.woken.at(-1), { thread: m.created[0], result: RUN },
        'the idle thread is handed it');
    assert.equal(m.fns.DeleteTimerQueueTimer.handler([queue, busy, EVENT]), 0);
    assert.deepEqual(m.errors, [ERROR_IO_PENDING]);
    assert.equal(m.event.signalled, false);
    m.ask(m.created[0]);
    assert.equal(m.event.signalled, true, 'set as the callback returned');
});

test('INVALID_HANDLE_VALUE waits for the callback, and wakes the deleter with TRUE', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    const busy = m.timer(queue, 0x402000, 2, 0, 0, 0);
    const [worker] = m.created;
    assert.equal(m.ask(worker), RUN);

    assert.equal(m.fns.DeleteTimerQueueTimer.handler([queue, busy, INVALID_HANDLE_VALUE]),
        PARKED);
    assert.ok(m.blocked.includes(m.main));
    m.ask(worker);
    assert.deepEqual(m.woken.at(-1), { thread: m.main, result: 1 });
});

test('a callback deleting its own timer does not wait for itself', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    const self = m.timer(queue, 0x402000, 2, 10, 10, 0);
    m.tick(10);
    const [worker] = m.created;
    assert.equal(m.ask(worker), RUN);
    // From inside the callback: NULL is pending (it is running), INVALID_HANDLE_VALUE
    // would be a deadlock and is not.
    assert.equal(m.as(worker, ()=>m.fns.DeleteTimerQueueTimer.handler([queue, self, 0])), 0);
    assert.deepEqual(m.errors, [ERROR_IO_PENDING]);

    // The same thread, back from that callback and handed another's.
    const other = m.timer(queue, 0x403000, 3, 10, 10, 0);
    m.ask(worker);
    m.tick(10);
    const running = m.woken.at(-1)?.thread;
    assert.equal(running, worker);
    assert.equal(m.record(worker).entry, 0x403000);
    assert.equal(m.as(running, ()=>
        m.fns.DeleteTimerQueueTimer.handler([queue, other, INVALID_HANDLE_VALUE])), 1);
});

test('a callback handed over before its timer was deleted still runs', ()=>{
    // Windows queues a timer due now as it is made; kernel32's sync tests count
    // one call of a timer deleted straight after it was made.
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    const handle = m.timer(queue, 0x401000, 7, 0, 300, 0);
    assert.equal(m.fns.DeleteTimerQueueTimer.handler([queue, handle, 0]), 0);
    assert.deepEqual(m.errors, [ERROR_IO_PENDING]);
    assert.equal(m.ask(m.created[0]), RUN);
    assert.equal(m.record(m.created[0]).args[0], 7);
    m.ask(m.created[0]);
    m.tick(1000);
    assert.equal(m.woken.length, 0, 'and it never fires again');
});

test('a spent one-shot accepts a change and stays silent; one not yet fired is re-armed', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    const spent = m.timer(queue, 0x401000, 1, 10, 0, 0);
    m.tick(10);
    assert.equal(m.ask(m.created[0]), RUN);
    assert.equal(m.as(m.created[0], ()=>
        m.fns.ChangeTimerQueueTimer.handler([queue, spent, 50, 50])), 1);
    m.ask(m.created[0]);
    m.tick(500);
    assert.equal(m.woken.length, 0, 'it ran once');

    const later = m.timer(queue, 0x402000, 2, 10000, 0, 0);
    assert.equal(m.fns.ChangeTimerQueueTimer.handler([queue, later, 0, 0]), 1);
    assert.deepEqual(m.woken.at(-1), { thread: m.created[0], result: RUN },
        'due now, and handed over at once');
    assert.equal(m.record(m.created[0]).entry, 0x402000);
});

test('the default queue is no handle at all, and cannot be deleted', ()=>{
    const m = machine();
    const handle = m.timer(0, 0x401000, 1, 1000, 1000, 0);
    assert.equal(m.fns.ChangeTimerQueueTimer.handler([0, handle, 2000, 2000]), 1);
    assert.equal(m.fns.DeleteTimerQueueTimer.handler([0, handle, INVALID_HANDLE_VALUE]), 1);
    assert.equal(m.fns.DeleteTimerQueueEx.handler([0, 0]), 0);
    assert.deepEqual(m.errors, [ERROR_INVALID_HANDLE]);
});

test('deleting a queue silences every timer in it and waits for all their callbacks', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    m.timer(queue, 0x401000, 1, 0, 10, 0);
    m.timer(queue, 0x402000, 2, 5000, 10, 0);
    const [worker] = m.created;
    assert.equal(m.ask(worker), RUN);

    assert.equal(m.fns.DeleteTimerQueueEx.handler([queue, INVALID_HANDLE_VALUE]), PARKED);
    m.ask(worker);
    assert.deepEqual(m.woken.at(-1), { thread: m.main, result: 1 });
    const before = m.woken.length;
    m.tick(10000);
    assert.equal(m.woken.length, before, 'neither fires again');
    assert.equal(m.fns.DeleteTimerQueueEx.handler([queue, 0]), 0, 'and the handle is gone');

    const empty = m.fns.CreateTimerQueue.handler();
    assert.equal(m.fns.DeleteTimerQueue.handler([empty]), 1, 'an empty queue at once');
});

test('a registered wait hands its callback to the pool on each answer, until unregistered', ()=>{
    const memory = new Uint8Array(0x10000);
    let free = 0x1000;
    /** @type {any} */
    let current = { name: 'main' };
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const traps = {};
    /** @type {any[]} */
    const created = [];
    /** @type {number[]} */
    const errors = [];
    /** @type {[number, number][]} */
    const waited = [];
    let answer = 0x102;
    const OBJECT = 0x44;
    const CALLBACK = 0x401000;
    const CONTEXT = 0x1234;
    const pool = createThreadPool({
        kernel: {
            currentThread: ()=>current,
            createThread: (/** @type {any} */ options)=>{
                created.push(options);
                return { name: options.name, parameter: options.parameter };
            },
            block: ()=>{},
            wake: ()=>true,
        },
        register: (name, fn)=>{
            traps[name] = fn;
            return 0x900 + Object.keys(traps).length * 0x10;
        },
        allocate: bytes=>{
            const at = free;
            free += Math.max(bytes, 16);
            return at;
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        park: ()=>PARKED,
        setLastError: code=>errors.push(code),
        waitFor: (handle, milliseconds)=>{
            waited.push([handle, milliseconds]);
            return answer;
        },
    });
    const fns = pool.table;
    const handle = fns.RegisterWaitForSingleObjectEx.handler([OBJECT, CALLBACK, CONTEXT, 250, 0]);
    assert.notEqual(handle, 0);
    const waiter = created.find(options=>options.name === 'registered wait');
    assert.equal(waiter.parameter, handle, 'the wait\'s thread is handed the wait');

    assert.equal(traps['<registered-wait>'].handler([handle]), 0x102);
    assert.deepEqual(waited, [[OBJECT, 250]], 'it waits on the object for the time asked');
    assert.equal(traps['<registered-wait-done>'].handler([handle, 0x102]), 1, 'and again after');
    const worker = created.find(options=>options.name === 'thread pool');
    assert.ok(worker, 'the callback goes to a pool thread');
    current = { name: 'worker' };
    assert.equal(traps['<thread-pool>'].handler([0x8000, RAN]), RUN);
    const get32 = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    assert.deepEqual([get32(0x8000), get32(0x8004), get32(0x8008)], [CALLBACK, CONTEXT, 1],
        'its context, and TRUE: the time ran out');

    current = { name: 'main' };
    assert.equal(fns.UnregisterWait.handler([handle]), 0, 'a callback still running');
    assert.deepEqual(errors, [ERROR_IO_PENDING]);
    assert.equal(traps['<registered-wait>'].handler([handle]), 0x80, 'no wait once unregistered');
    assert.equal(traps['<registered-wait-done>'].handler([handle, 0x80]), 0,
        'and the thread stops');

    answer = 0;
    const once = fns.RegisterWaitForSingleObjectEx.handler([OBJECT, CALLBACK, CONTEXT,
        0xffffffff, 0x8]);
    assert.equal(traps['<registered-wait-done>'].handler([once, 0]), 0,
        'WT_EXECUTEONLYONCE waits no more after its callback');
    assert.equal(fns.RegisterWaitForSingleObjectEx.handler([OBJECT, 0, CONTEXT, 0, 0]), 0,
        'no callback is refused');
});

test('an unregistered wait keeps its handle until its thread has left its loop', ()=>{
    // Wine's kernel32 test_RegisterWaitForSingleObject unregisters a wait whose
    // thread is still blocked on its object, then registers another. Its handle
    // was freed and handed to the new wait, and when the object was set the old
    // thread woke into the new wait and ran its callback a second time.
    /** @type {number[]} */
    const freed = [];
    let next = 0x1000;
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const traps = {};
    /** @type {any[]} */
    const created = [];
    const pool = createThreadPool({
        kernel: {
            currentThread: ()=>({ name: 'main' }),
            createThread: (/** @type {any} */ options)=>{
                created.push(options);
                return { name: options.name };
            },
            block: ()=>{},
            wake: ()=>true,
        },
        register: (name, fn)=>{
            traps[name] = fn;
            return 0x900 + Object.keys(traps).length * 0x10;
        },
        // Freed blocks are handed out again first, as a heap does.
        allocate: ()=>freed.pop() ?? (next += 16),
        free: address=>freed.push(address),
        writeMemory: ()=>{},
        park: ()=>PARKED,
        setLastError: ()=>{},
        waitFor: ()=>PARKED,
    });
    const fns = pool.table;
    const pooled = ()=>created.filter(options=>options.name === 'thread pool').length;

    const first = fns.RegisterWaitForSingleObjectEx.handler([0x44, 0x401000, 1, 0xffffffff,
        8]);
    assert.equal(traps['<registered-wait>'].handler([first]), PARKED, 'its thread blocks');
    assert.equal(fns.UnregisterWait.handler([first]), 1, 'nothing of it is running');
    assert.deepEqual(freed, [], 'but its thread may still come back with its handle');

    const second = fns.RegisterWaitForSingleObjectEx.handler([0x44, 0x402000, 2, 0xffffffff,
        8]);
    assert.notEqual(second, first);
    // The object is set: both threads wake.
    assert.equal(traps['<registered-wait-done>'].handler([first, 0]), 0, 'the first one stops');
    assert.equal(pooled(), 0, 'and runs no callback');
    assert.deepEqual(freed, [first], 'and only now is its handle let go');
    assert.equal(traps['<registered-wait-done>'].handler([second, 0]), 0);
    assert.equal(pooled(), 1, 'the second runs its own, once');
});

test('WT_EXECUTEINWAITTHREAD callbacks run one after another on the one wait thread', ()=>{
    // Wine's kernel32 test_RegisterWaitForSingleObject: a callback waiting
    // for another wait's callback times out, since that one runs after it.
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const traps = {};
    /** @type {any[]} */
    const created = [];
    /** @type {number[]} */
    const errors = [];
    let next = 0x1000;
    const memory = new Uint8Array(0x10000);
    /** @type {any} */
    let current = { name: 'main' };
    const pool = createThreadPool({
        kernel: {
            currentThread: ()=>current,
            createThread: (/** @type {any} */ options)=>{
                const thread = { name: options.name };
                created.push(thread);
                return thread;
            },
            block: ()=>{},
            wake: ()=>true,
        },
        register: (name, fn)=>{
            traps[name] = fn;
            return 0x900 + Object.keys(traps).length * 0x10;
        },
        allocate: ()=>(next += 16),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        park: ()=>PARKED,
        setLastError: code=>errors.push(code),
        waitFor: ()=>0,
    });
    const fns = pool.table;
    const WT_EXECUTEINWAITTHREAD = 0x4;
    const ONCE = 0x8;
    const get32 = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    /** @param {any} thread */
    const ask = thread=>{
        const was = current;
        current = thread;
        const answer = traps['<thread-pool>'].handler([0x8000, RAN]);
        current = was;
        return answer;
    };

    const first = fns.RegisterWaitForSingleObjectEx.handler([0x44, 0x401000, 1, 0xffffffff,
        ONCE | WT_EXECUTEINWAITTHREAD]);
    const second = fns.RegisterWaitForSingleObjectEx.handler([0x48, 0x402000, 2, 0xffffffff,
        ONCE | WT_EXECUTEINWAITTHREAD]);
    traps['<registered-wait-done>'].handler([first, 0]);
    traps['<registered-wait-done>'].handler([second, 0]);
    const waitThreads = created.filter(thread=>thread.name === 'wait thread');
    assert.equal(waitThreads.length, 1, 'one thread for both');
    assert.equal(created.filter(thread=>thread.name === 'thread pool').length, 0,
        'and none of the pool\'s');

    const [thread] = waitThreads;
    assert.equal(ask(thread), RUN);
    assert.equal(get32(0x8000), 0x401000, 'the first');
    // From inside its own callback, the wait is let go at once.
    current = thread;
    assert.equal(fns.UnregisterWait.handler([first]), 1);
    current = { name: 'main' };
    assert.deepEqual(errors, []);
    assert.equal(ask(thread), RUN);
    assert.equal(get32(0x8000), 0x402000, 'the second only once the first returned');
    assert.equal(ask(thread), PARKED);
    assert.equal(fns.UnregisterWait.handler([second]), 1, 'its callback has returned');
});

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
    /** @type {Map<number, any>} */
    const sinks = new Map();
    /** @type {[string, number[]][]} */
    const calls = [];
    /** @type {any[]} */
    const guestCalls = [];

    const pool = createThreadPool({
        kernel: {
            currentThread: ()=>current,
            createThread: (/** @type {any} */ options)=>{
                const thread = { name: `${options.name} ${created.length}`, entry: options.entry,
                    options };
                created.push(thread);
                return thread;
            },
            block: (/** @type {any} */ thread)=>blocked.push(thread),
            alertably: (/** @type {any} */ thread, /** @type {() => any} */ wait)=>{
                thread.alertableWaits = (thread.alertableWaits ?? 0) + 1;
                return wait();
            },
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
        readMemory: (address, length)=>memory.slice(address, address + length),
        wallClock: ()=>1_000_000,
        threadBlock: thread=>{
            thread.block = true;
        },
        park: ()=>PARKED,
        setLastError: code=>errors.push(code),
        call: (name, args)=>calls.push([name, args]),
        bindIo: (file, sink)=>{
            sinks.set(file, sink);
            return true;
        },
        callGuest: async call=>{
            guestCalls.push(call);
            return 0;
        },
        imageStack: ()=>({ reserve: 0x100000, commit: 0x1000 }),
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
    const ask = (thread, last = RAN)=>{
        const was = current;
        current = thread;
        const answer = traps['<thread-pool>'].handler([recordOf(thread), last]);
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

    return { pool, fns, memory, created, woken, blocked, errors, event, freed, main, calls, sinks,
        guestCalls,
        ask, record, tick, as, timer, get32 };
}

test('the loop is the bytes it says it is, and both of its jumps land on the question', ()=>{
    const code = poolLoopCode(0x900, 0x200);
    assert.equal(code.length, 67);
    assert.deepEqual([...code.slice(0, 3)], [0x83, 0xec, 28], 'sub esp, 28: the record');
    assert.equal(code[14], 0xe8);
    const relative = new DataView(code.buffer).getInt32(15, true);
    assert.equal(0x200 + 19 + relative, 0x900, 'call fetch');
    // jne at 28 and jmp at 59, each two bytes, back to the push at 8.
    assert.equal(30 + (code[29] << 24 >> 24), 8);
    assert.equal(61 + (code[60] << 24 >> 24), 8);
    // jz at 21 to the exit at 61: the record given back, and ret 4.
    assert.equal(code[21], 0x74);
    assert.equal(23 + code[22], 61);
    assert.deepEqual([...code.slice(61)], [0x83, 0xc4, 28, 0xc2, 4, 0]);
    // Six arguments pushed from the record, last first, then call [ebx].
    assert.deepEqual([...code.slice(32, 52)], [0xff, 0x73, 24, 0xff, 0x73, 20, 0xff, 0x73, 16,
        0xff, 0x73, 12, 0xff, 0x73, 8, 0xff, 0x73, 4, 0xff, 0x13]);
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

test('ntdll\'s deletions answer statuses, and wake a deleter that waited with STATUS_SUCCESS', ()=>{
    const m = machine();
    const queue = m.fns.CreateTimerQueue.handler();
    const busy = m.timer(queue, 0x402000, 2, 0, 0, 0);
    const [worker] = m.created;
    assert.equal(m.ask(worker), RUN);

    assert.equal(m.pool.native.deleteTimer(busy, 0), 0x103, 'STATUS_PENDING');
    assert.deepEqual(m.errors, [], 'and no last error');
    assert.equal(m.pool.native.deleteTimer(busy, 0), 0xc000000d, 'gone: STATUS_INVALID_PARAMETER');
    assert.equal(m.pool.native.deleteTimerQueue(0x9999, 0), 0xc0000008,
        'STATUS_INVALID_HANDLE');
    assert.equal(m.pool.native.deleteTimerQueue(queue, INVALID_HANDLE_VALUE), PARKED,
        'the deleted timer\'s callback still runs');
    m.ask(worker);
    assert.deepEqual(m.woken.at(-1), { thread: m.main, result: 0 }, 'STATUS_SUCCESS, not TRUE');
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

/**
 * A pool whose wait threads the test steps by hand: `step` is a wait
 * thread's question (the objects it waits on and for how long), `done` its
 * answer handed back, `ask` a pool thread taking its next callback.
 */
/** @param {{ divergence?: (api: string, detail: string) => void }} [options] */
function waitMachine({ divergence } = {}){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let free = 0x1000;
    let now = 0;
    /** @type {any} */
    let current = { name: 'main' };
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const traps = {};
    /** @type {any[]} */
    const created = [];
    /** @type {[string, number][]} */
    const alerted = [];
    /** @type {number[]} */
    const errors = [];
    /** @type {number[]} */
    const freed = [];
    /** @type {{ objects: number[], milliseconds: number }[]} */
    const waited = [];
    /** @type {number[]} */
    const closed = [];
    const pool = createThreadPool({
        kernel: {
            currentThread: ()=>current,
            createThread: (/** @type {any} */ options)=>{
                const thread = { name: `${options.name} ${created.length}`,
                    parameter: options.parameter };
                created.push(thread);
                return thread;
            },
            block: ()=>{},
            alertably: (/** @type {any} */ thread, /** @type {() => any} */ wait)=>wait(),
            wake: ()=>true,
            alert: (/** @type {any} */ thread, /** @type {number} */ result)=>{
                alerted.push([thread.name, result]);
                return true;
            },
            clock: { virtualTime: ()=>now },
            handles: { resolve: (/** @type {number} */ handle)=>(handle === 0xdead ? null : {}) },
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
        free: address=>freed.push(address),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readMemory: (address, length)=>memory.slice(address, address + length),
        park: ()=>PARKED,
        setLastError: code=>errors.push(code),
        ...divergence ? { divergence } : {},
        call: (/** @type {string} */ name, /** @type {number[]} */ args)=>{
            if (name === 'DuplicateHandle')
            {
                // A handle of the wait's own, the object's plus 0x1000.
                view.setUint32(args[3], args[1] + 0x1000, true);
                return 1;
            }
            if (name === 'CloseHandle')
            {
                closed.push(args[0]);
            }
            return name === 'CreateEventW' ? 0x99 : 1;
        },
        waitFor: (count, handles, milliseconds)=>{
            waited.push({ objects: Array.from({ length: count },
                (_, index)=>view.getUint32(handles + index * 4, true)), milliseconds });
            return PARKED;
        },
    });
    /** @param {string} prefix */
    const threads = prefix=>created.filter(thread=>thread.name.startsWith(prefix));
    /** A wait thread's question: what it waits on, and for how long. @param {any} thread */
    const step = thread=>{
        traps['<registered-wait>'].handler([thread.parameter]);
        return /** @type {{ objects: number[], milliseconds: number }} */ (waited.at(-1));
    };
    /** @param {any} thread @param {number} answer */
    const done = (thread, answer)=>traps['<registered-wait-done>'].handler(
        [thread.parameter, answer]);
    /** A pool thread taking its next callback: its record, or null. @param {any} thread */
    const ask = thread=>{
        const was = current;
        current = thread;
        const answer = traps['<thread-pool>'].handler([0x8000, RAN]);
        current = was;
        return answer === RUN ? [0, 4, 8, 12, 16].map(at=>view.getUint32(0x8000 + at, true))
            : null;
    };
    /** What a pool thread woken with a callback finds in its record. */
    const record = ()=>[0, 4, 8, 12, 16].map(at=>view.getUint32(0x8000 + at, true));
    return { pool, fns: pool.table, view, created, alerted, errors, freed, threads, step, closed,
        done, ask, record,
        /** @param {number} ms */
        tick: ms=>{
            now += ms;
        },
        /** @param {any} thread */
        as: thread=>{
            current = thread;
        } };
}

test('registered waits share a wait thread, which waits for any of their objects', ()=>{
    const m = waitMachine();
    const CALLBACK = 0x401000;
    const first = m.fns.RegisterWaitForSingleObjectEx.handler([0x44, CALLBACK, 1, 250, 0]);
    const second = m.fns.RegisterWaitForSingleObjectEx.handler([0x48, CALLBACK, 2, 0xffffffff,
        0]);
    assert.notEqual(first, 0);
    const [home] = m.threads('registered waits');
    assert.equal(m.threads('registered waits').length, 1, 'one thread for both');
    assert.deepEqual(m.alerted.at(-1), [home.name, 0xc0],
        'the second added starts its wait again');
    assert.deepEqual(m.step(home), { objects: [0x44, 0x48], milliseconds: 250 },
        'both objects, until the nearer time-out');

    assert.equal(m.done(home, 1), 1, 'the second object came; the thread waits on');
    const [worker] = m.threads('thread pool');
    assert.deepEqual(m.ask(worker)?.slice(0, 3), [CALLBACK, 2, 0], 'its context, and FALSE');
    m.ask(worker);
    m.tick(100);
    assert.deepEqual(m.step(home), { objects: [0x44, 0x48], milliseconds: 150 },
        'the time-out counts from its registration');
    m.tick(150);
    assert.equal(m.done(home, 0x102), 1);
    assert.deepEqual(m.record().slice(0, 3), [CALLBACK, 1, 1],
        'handed to the idle pool thread: the time ran out, TRUE');
    m.ask(worker);
    assert.equal(m.step(home).milliseconds, 250, 'and waits its time-out again from now');

    assert.equal(m.done(home, 0xc0), 1, 'routines queued to the thread ran: nothing fires');
    assert.equal(m.ask(worker), null);

    m.as(m.created[0]);
    assert.equal(m.fns.UnregisterWait.handler([first]), 1, 'nothing of it is running');
    // Left in its wait, the thread would take the next signal of a semaphore
    // or an auto-reset event for a wait nobody has any more.
    assert.deepEqual(m.alerted.at(-1), [home.name, 0xc0], 'taken out of its wait');
    assert.deepEqual(m.step(home).objects, [0x48], 'and waits for what is left');
    assert.ok(m.freed.includes(first), 'its handle goes at once: the thread holds the wait');
    assert.equal(m.fns.UnregisterWait.handler([second]), 1);
    assert.equal(m.done(home, 0xc0), 0, 'no waits left: the thread ends');
    assert.equal(m.fns.UnregisterWait.handler([second]), 0, 'gone');
    assert.deepEqual(m.errors, [ERROR_INVALID_HANDLE]);
    assert.equal(m.fns.RegisterWaitForSingleObjectEx.handler([0x44, 0, 1, 0, 0]), 0,
        'no callback is refused');
});

test('two waits on one object are one entry, and a signal fires the first of them', ()=>{
    // Wine's ntdll test_tp_wait: a semaphore released once wakes one of the
    // two waits set on it, released twice both.
    const m = waitMachine();
    const ONCE = 0x8;
    m.fns.RegisterWaitForSingleObjectEx.handler([0x44, 0x401000, 1, 0xffffffff, ONCE]);
    m.fns.RegisterWaitForSingleObjectEx.handler([0x44, 0x402000, 2, 0xffffffff, ONCE]);
    const [home] = m.threads('registered waits');
    assert.deepEqual(m.step(home).objects, [0x44], 'the object once');
    assert.equal(m.done(home, 0), 1);
    const [worker] = m.threads('thread pool');
    assert.equal(m.ask(worker)?.[0], 0x401000, 'the first registered');
    assert.deepEqual(m.step(home).objects, [0x44], 'the second still waits');
    assert.equal(m.done(home, 0), 0, 'fired, and the thread has nothing left');
    assert.equal(m.ask(worker)?.[0], 0x402000, 'once the first callback returned');
});

test('a wait thread has room for sixty-four objects, and another is made past them', ()=>{
    const m = waitMachine();
    for (let i = 0; i < 65; i++)
    {
        m.fns.RegisterWaitForSingleObjectEx.handler([0x1000 + i * 4, 0x401000, i, 0xffffffff,
            0]);
    }
    const homes = m.threads('registered waits');
    assert.equal(homes.length, 2);
    assert.equal(m.step(homes[0]).objects.length, 64);
    assert.deepEqual(m.step(homes[1]).objects, [0x1000 + 64 * 4]);
});

test('an object closed under its wait is said and dropped; the other waits go on', ()=>{
    /** @type {string[]} */
    const said = [];
    const m = waitMachine({ divergence: (api, detail)=>said.push(`${api}: ${detail}`) });
    m.fns.RegisterWaitForSingleObjectEx.handler([0xdead, 0x401000, 1, 0xffffffff, 0]);
    m.fns.RegisterWaitForSingleObjectEx.handler([0x44, 0x401000, 2, 0xffffffff, 0]);
    const [home] = m.threads('registered waits');
    m.step(home);
    assert.equal(m.done(home, 0xffffffff), 1, 'the wait for all of them failed');
    assert.deepEqual(m.step(home).objects, [0x44]);
    assert.equal(said.length, 1);
    assert.match(said[0], /0xdead was closed under its wait/);
});

test('WT_EXECUTEINWAITTHREAD callbacks run one after another on the one wait thread', ()=>{
    // Wine's kernel32 test_RegisterWaitForSingleObject: a callback waiting
    // for another wait's callback times out, since that one runs after it.
    const m = waitMachine();
    const WT_EXECUTEINWAITTHREAD = 0x4;
    const ONCE = 0x8;
    const first = m.fns.RegisterWaitForSingleObjectEx.handler([0x44, 0x401000, 1, 0xffffffff,
        ONCE | WT_EXECUTEINWAITTHREAD]);
    const second = m.fns.RegisterWaitForSingleObjectEx.handler([0x48, 0x402000, 2, 0xffffffff,
        ONCE | WT_EXECUTEINWAITTHREAD]);
    const [home] = m.threads('registered waits');
    m.step(home);
    m.done(home, 0);
    m.step(home);
    m.done(home, 0);
    const waitThreads = m.threads('wait thread');
    assert.equal(waitThreads.length, 1, 'one thread for both callbacks');
    assert.equal(m.threads('thread pool').length, 0, 'and none of the pool\'s');

    const [thread] = waitThreads;
    assert.equal(m.ask(thread)?.[0], 0x401000, 'the first');
    // From inside its own callback, the wait is let go at once.
    m.as(thread);
    assert.equal(m.fns.UnregisterWait.handler([first]), 1);
    m.as(m.created[0]);
    assert.deepEqual(m.errors, []);
    assert.equal(m.ask(thread)?.[0], 0x402000, 'the second only once the first returned');
    assert.equal(m.ask(thread), null);
    assert.equal(m.fns.UnregisterWait.handler([second]), 1, 'its callback has returned');
});

test('a thread pool wait fires once with its result, and is set again to wait again', ()=>{
    const m = waitMachine();
    const wait = m.fns.CreateThreadpoolWait.handler([0x405000, 0x77, 0]);
    m.view.setBigInt64(0x6000, -2500000n, true);
    m.fns.SetThreadpoolWait.handler([wait, 0x44, 0x6000]);
    const [home] = m.threads('registered waits');
    assert.deepEqual(m.step(home), { objects: [0x1044], milliseconds: 250 },
        'the object, by a handle of the wait\'s own, for its time-out');
    assert.equal(m.done(home, 0), 0, 'once');
    assert.deepEqual(m.closed, [0x1044], 'its own handle closed once it fired');
    const [worker] = m.threads('thread pool');
    assert.deepEqual(m.ask(worker)?.slice(0, 5), [0x405000, 0x8000, 0x77, wait, 0],
        'its instance (the record, on the pool thread), its context, the wait and WAIT_OBJECT_0');
    m.ask(worker);
    assert.equal(m.fns.WaitForThreadpoolWaitCallbacks.handler([wait, 0]), 0, 'nothing owed');

    m.fns.SetThreadpoolWait.handler([wait, 0x48, 0]);
    const again = m.threads('registered waits').at(-1);
    assert.deepEqual(m.step(again), { objects: [0x1048], milliseconds: 0xffffffff },
        'no time-out waits for ever');
    m.fns.SetThreadpoolWait.handler([wait, 0, 0]);
    assert.deepEqual(m.alerted.at(-1), [again.name, 0xc0], 'no object: the wait is withdrawn');
    assert.deepEqual(m.closed, [0x1044, 0x1048], 'and its handle closed');
    assert.equal(m.done(again, 0xc0), 0);
    m.fns.CloseThreadpoolWait.handler([wait]);
    assert.equal(m.fns.FreeLibraryWhenCallbackReturns.handler([0, 0]), 0);
});

test('a thread pool work runs once a submission, and a wait for it waits for its callbacks', ()=>{
    // Wine's kernel32 thread.c test_threadpool: CreateThreadpoolWork,
    // SubmitThreadpoolWork, WaitForThreadpoolWorkCallbacks, CloseThreadpoolWork.
    const m = machine();
    const work = m.fns.CreateThreadpoolWork.handler([0x403000, 0xcafe, 0]);
    assert.notEqual(work, 0);
    m.fns.SubmitThreadpoolWork.handler([work]);
    assert.equal(m.fns.WaitForThreadpoolWorkCallbacks.handler([work, 0]), PARKED,
        'its callback has not run yet');
    assert.deepEqual(m.blocked, [m.main]);
    assert.equal(m.ask(m.created[0]), RUN);
    const { entry, args } = m.record(m.created[0]);
    assert.equal(entry, 0x403000);
    assert.deepEqual(args.slice(1, 3), [0xcafe, work], 'its instance, context and work');
    assert.notEqual(args[0], 0);
    m.ask(m.created[0]);
    assert.deepEqual(m.woken.at(-1), { thread: m.main, result: 1 }, 'the wait is over');
    assert.equal(m.fns.WaitForThreadpoolWorkCallbacks.handler([work, 0]), 0, 'nothing to wait for');

    // Pending submissions dropped, the one running waited for.
    m.fns.SubmitThreadpoolWork.handler([work]);
    m.fns.SubmitThreadpoolWork.handler([work]);
    m.fns.CloseThreadpoolWork.handler([work]);
    assert.equal(m.freed.includes(work), false, 'not given back while callbacks are owed');
    assert.equal(m.fns.CreateThreadpoolWork.handler([0, 0, 0]), 0);
    assert.equal(m.errors.at(-1), 87);

    const pool = m.fns.CreateThreadpool.handler([0]);
    assert.notEqual(pool, 0);
    m.fns.CloseThreadpool.handler([pool]);
    assert.ok(m.freed.includes(pool));
});

test('an environment\'s FinalizationCallback runs on the same thread after each callback', ()=>{
    // Wine's msvcp140_atomic_wait test, test_threadpool_work: the callback,
    // then the finalization, both with the work's instance and context; a
    // version 3 environment with an invalid CallbackPriority is refused.
    const m = machine();
    const environment = 0x6000;
    const view = new DataView(m.memory.buffer);
    m.memory.fill(0, environment, environment + 40);
    view.setUint32(environment, 1, true); // Version
    view.setUint32(environment + 24, 0x404000, true); // FinalizationCallback
    const work = m.fns.CreateThreadpoolWork.handler([0x403000, 0xcafe, environment]);
    assert.notEqual(work, 0);
    m.fns.SubmitThreadpoolWork.handler([work]);
    assert.equal(m.ask(m.created[0]), RUN);
    assert.equal(m.record(m.created[0]).entry, 0x403000, 'the callback first');
    assert.equal(m.ask(m.created[0]), RUN, 'then, on the same thread, the finalization');
    const { entry, args } = m.record(m.created[0]);
    assert.equal(entry, 0x404000);
    assert.equal(args[1], 0xcafe, 'with the context');
    assert.notEqual(args[0], 0, 'and the instance');
    assert.equal(m.fns.WaitForThreadpoolWorkCallbacks.handler([work, 0]), PARKED,
        'the callback is not done until its finalization is');
    m.ask(m.created[0]);
    assert.deepEqual(m.woken.at(-1), { thread: m.main, result: 1 });

    view.setUint32(environment, 3, true); // Version 3
    view.setUint32(environment + 32, 1, true); // TP_CALLBACK_PRIORITY_NORMAL
    assert.notEqual(m.fns.CreateThreadpoolWork.handler([0x403000, 0, environment]), 0);
    view.setUint32(environment + 32, 3, true); // TP_CALLBACK_PRIORITY_INVALID
    assert.equal(m.fns.CreateThreadpoolWork.handler([0x403000, 0, environment]), 0);
    assert.equal(m.errors.at(-1), 87, 'ERROR_INVALID_PARAMETER');
});

test('cancelling pending submissions leaves only the ones running to wait for', ()=>{
    const m = machine();
    const work = m.fns.CreateThreadpoolWork.handler([0x403000, 1, 0]);
    for (let i = 0; i < 3; i++)
    {
        m.fns.SubmitThreadpoolWork.handler([work]);
    }
    assert.equal(m.fns.WaitForThreadpoolWorkCallbacks.handler([work, 1]), 0,
        'none had started: all dropped, nothing to wait for');
    assert.equal(m.ask(m.created[0]), PARKED, 'and none runs');
    assert.equal(m.fns.TrySubmitThreadpoolCallback.handler([0x404000, 7, 0]), 1);
    assert.deepEqual(m.woken.at(-1), { thread: m.created[0], result: RUN },
        'the idle thread is woken to run it');
    assert.deepEqual(m.record(m.created[0]).args.slice(1, 2), [7]);
});

test('a thread pool timer fires after its relative due time, then on its period', ()=>{
    const m = machine();
    const view = new DataView(m.memory.buffer);
    const timer = m.fns.CreateThreadpoolTimer.handler([0x404000, 0xbeef, 0]);
    assert.notEqual(timer, 0);
    assert.equal(m.fns.IsThreadpoolTimerSet.handler([timer]), 0);
    // 50 ms from now, as a negative count of 100 ns units.
    view.setBigInt64(0x6000, -500000n, true);
    m.fns.SetThreadpoolTimer.handler([timer, 0x6000, 20, 0]);
    assert.equal(m.fns.IsThreadpoolTimerSet.handler([timer]), 1);
    m.tick(49);
    assert.equal(m.created.length, 0, 'not yet');
    m.tick(1);
    assert.equal(m.ask(m.created[0]), RUN);
    const { entry, args } = m.record(m.created[0]);
    assert.equal(entry, 0x404000);
    assert.deepEqual(args.slice(1, 3), [0xbeef, timer], 'its instance, context and timer');
    m.ask(m.created[0]);
    m.tick(20);
    assert.deepEqual(m.woken.at(-1), { thread: m.created[0], result: RUN },
        'again on its period, to the idle thread');
    m.ask(m.created[0]);

    // No due time stops it; an absolute one counts from the wall clock.
    m.fns.SetThreadpoolTimer.handler([timer, 0, 0, 0]);
    assert.equal(m.fns.IsThreadpoolTimerSet.handler([timer]), 0);
    m.tick(100);
    assert.equal(m.ask(m.created[0]), PARKED, 'stopped');
    view.setBigInt64(0x6000, (1_000_030n + 11644473600000n) * 10000n, true);
    m.fns.SetThreadpoolTimer.handler([timer, 0x6000, 0, 0]);
    const before = m.woken.length;
    m.tick(29);
    assert.equal(m.woken.length, before);
    m.tick(1);
    assert.equal(m.woken.at(-1)?.result, RUN, 'thirty milliseconds past the wall clock');
    assert.equal(m.fns.IsThreadpoolTimerSet.handler([timer]), 1,
        'a one-shot that fired stays set until stopped, as Wine\'s ntdll test_tp_timer sees');
    assert.equal(m.fns.WaitForThreadpoolTimerCallbacks.handler([timer, 0]), PARKED);
    m.ask(m.created[0]);
    m.fns.CloseThreadpoolTimer.handler([timer]);
    assert.ok(m.freed.includes(timer), 'given back with nothing owed');
});

test('an idle pool thread waits alertably; a callback handed over during an APC still runs', ()=>{
    // Wine's ntdll test_RtlRegisterWait queues an APC to the pool thread its
    // callback ran on and waits for it: an idle pool thread runs it, as
    // Windows' do.
    const m = machine();
    m.fns.QueueUserWorkItem.handler([0x402000, 1, 0]);
    const [thread] = m.created;
    assert.equal(m.ask(thread), RUN);
    assert.equal(m.ask(thread), PARKED, 'idle');
    assert.equal(thread.alertableWaits, 1, 'and its wait alertable');

    // The APC ran and the loop asks again with WAIT_IO_COMPLETION: still
    // idle, once, not twice.
    assert.equal(m.ask(thread, 0xc0), PARKED);
    m.fns.QueueUserWorkItem.handler([0x402000, 2, 0]);
    assert.equal(m.created.length, 1, 'the idle thread took it: no second one');
    assert.equal(m.woken.at(-1)?.thread, thread);
    assert.equal(m.fns.QueueUserWorkItem.handler([0x402000, 3, 0]), 1);
    assert.equal(m.created.length, 2, 'it was in the idle list once');

    // Handed a callback while it was running an APC (the wake found it
    // running): back in the loop, it runs that callback rather than counting
    // it done.
    const n = machine();
    n.fns.QueueUserWorkItem.handler([0x402000, 1, 0]);
    const [other] = n.created;
    assert.equal(n.ask(other), RUN);
    assert.equal(n.ask(other), PARKED);
    n.fns.QueueUserWorkItem.handler([0x402000, 7, 0]);
    assert.equal(n.ask(other, 0xc0), RUN, 'the callback handed over, not yet run');
    assert.equal(n.record(other).args[0], 7);
    assert.equal(n.ask(other), PARKED, 'run once, and idle again');
});

/**
 * A TP_CALLBACK_ENVIRON version 1 at `at`.
 *
 * @param {any} m @param {number} at
 * @param {{ pool?: number, group?: number, cancel?: number, finalization?: number }} fields
 */
function callbackEnvironment(m, at, { pool = 0, group = 0, cancel = 0, finalization = 0 }){
    const view = new DataView(m.memory.buffer);
    m.memory.fill(0, at, at + 40);
    view.setUint32(at, 1, true);
    view.setUint32(at + 4, pool, true);
    view.setUint32(at + 8, group, true);
    view.setUint32(at + 12, cancel, true);
    view.setUint32(at + 24, finalization, true);
    return at;
}

test('a pool of its own runs at most its maximum at once, its objects taking turns', ()=>{
    // Wine's ntdll test_tp_work_scheduler: one object's ten callbacks do not
    // hold up another's on a pool of one thread.
    const m = machine();
    const pool = m.fns.CreateThreadpool.handler([0]);
    m.fns.SetThreadpoolThreadMaximum.handler([pool, 1]);
    const env = callbackEnvironment(m, 0x6000, { pool });
    const a = m.fns.CreateThreadpoolWork.handler([0x403000, 1, env]);
    const b = m.fns.CreateThreadpoolWork.handler([0x403100, 2, env]);
    for (let i = 0; i < 3; i++)
    {
        m.fns.SubmitThreadpoolWork.handler([a]);
    }
    m.fns.SubmitThreadpoolWork.handler([b]);
    m.fns.SubmitThreadpoolWork.handler([b]);
    assert.equal(m.created.length, 1, 'one thread: its maximum');
    const [thread] = m.created;
    /** @type {number[]} */
    const order = [];
    while (m.ask(thread) === RUN)
    {
        order.push(m.record(thread).entry);
        assert.equal(m.record(thread).args[0], 0x8000, 'the instance is the running record');
    }
    assert.deepEqual(order, [0x403000, 0x403100, 0x403000, 0x403100, 0x403000]);
    assert.equal(m.created.length, 1);

    // The stack its threads are made with, the program's until set.
    const info = 0x6100;
    const view = new DataView(m.memory.buffer);
    assert.equal(m.fns.QueryThreadpoolStackInformation.handler([pool, info]), 1);
    assert.deepEqual([view.getUint32(info, true), view.getUint32(info + 4, true)],
        [0x100000, 0x1000]);
    view.setUint32(info, 0x40000, true);
    view.setUint32(info + 4, 0x2000, true);
    assert.equal(m.fns.SetThreadpoolStackInformation.handler([pool, info]), 1);
    assert.equal(m.fns.SetThreadpoolThreadMinimum.handler([pool, 2]), 1);
    assert.equal(m.created.length, 2, 'the minimum made now');
    assert.deepEqual([m.created[1].options.stackReserve, m.created[1].options.stackSize],
        [0x40000, 0x2000]);
});

test('a callback\'s instance: completion calls in order, may-run-long, and letting go', ()=>{
    const m = machine();
    const work = m.fns.CreateThreadpoolWork.handler([0x403000, 1, 0]);
    m.fns.SubmitThreadpoolWork.handler([work]);
    const [thread] = m.created;
    assert.equal(m.ask(thread), RUN);
    const instance = m.record(thread).args[0];
    m.as(thread, ()=>{
        m.fns.SetEventWhenCallbackReturns.handler([instance, 0x54]);
        m.fns.ReleaseSemaphoreWhenCallbackReturns.handler([instance, 0x50, 2]);
        m.fns.LeaveCriticalSectionWhenCallbackReturns.handler([instance, 0x58]);
        m.fns.SetEventWhenCallbackReturns.handler([instance, 0x5c]);
        assert.equal(m.fns.CallbackMayRunLong.handler([instance]), 1, 'room for more threads');
    });
    assert.deepEqual(m.calls, [], 'nothing until the callback returns');
    assert.equal(m.ask(thread), PARKED);
    assert.deepEqual(m.calls, [['LeaveCriticalSection', [0x58]],
        ['ReleaseSemaphore', [0x50, 2, 0]], ['SetEvent', [0x5c]]],
    'the lock first, the last event asked');

    // Let go, the work's callbacks are no longer waited for while it runs.
    m.fns.SubmitThreadpoolWork.handler([work]);
    assert.equal(m.woken.at(-1)?.result, RUN);
    assert.equal(m.fns.WaitForThreadpoolWorkCallbacks.handler([work, 0]), PARKED);
    m.as(thread, ()=>m.fns.DisassociateCurrentThreadFromCallback.handler([0x8000]));
    assert.deepEqual(m.woken.at(-1), { thread: m.main, result: 1 }, 'the wait is over');
    assert.equal(m.fns.WaitForThreadpoolWorkCallbacks.handler([work, 0]), 0);
    m.ask(thread);

    // A pool of one busy thread has none for another callback.
    const pool = m.fns.CreateThreadpool.handler([0]);
    m.fns.SetThreadpoolThreadMaximum.handler([pool, 1]);
    m.fns.TrySubmitThreadpoolCallback.handler([0x404000, 0,
        callbackEnvironment(m, 0x6000, { pool })]);
    const own = m.created.at(-1);
    assert.equal(m.ask(own), RUN);
    assert.equal(m.fns.CallbackMayRunLong.handler([0x8000 + 0x20]), 0);
});

test('a cleanup group closes its members once their callbacks returned, cancel callbacks after',
    async()=>{
        // Wine's ntdll test_tp_group_cancel: a cancel callback for each member
        // the program has not released, on the closing thread, after the
        // wait; a simple callback that ran to its end calls none.
        const m = machine();
        const pool = m.fns.CreateThreadpool.handler([0]);
        m.fns.SetThreadpoolThreadMaximum.handler([pool, 1]);
        const group = m.fns.CreateThreadpoolCleanupGroup.handler([]);
        const env = callbackEnvironment(m, 0x6000, { pool, group, cancel: 0x409000 });
        assert.equal(m.fns.TrySubmitThreadpoolCallback.handler([0x404000, 0x11, env]), 1);
        assert.equal(m.fns.TrySubmitThreadpoolCallback.handler([0x404000, 0x22, env]), 1);
        const work = m.fns.CreateThreadpoolWork.handler([0x403000, 0x33, env]);
        const released = m.fns.CreateThreadpoolWork.handler([0x403000, 0x44, env]);
        m.fns.CloseThreadpoolWork.handler([released]);
        const [thread] = m.created;
        assert.equal(m.ask(thread), RUN, 'the first simple callback runs');

        const closing = m.fns.CloseThreadpoolCleanupGroupMembers.handler([group, 1, 0xabc]);
        assert.equal(typeof closing?.then, 'function', 'waiting for the running one');
        assert.deepEqual(m.guestCalls, [], 'not before the wait');
        assert.equal(m.ask(thread), PARKED, 'the pending one was dropped');
        assert.equal(await closing, 0);
        assert.deepEqual(m.guestCalls.map((/** @type {any} */ call)=>call.args), [[0x22, 0xabc], [0x33, 0xabc]]);
        assert.ok(m.guestCalls.every((/** @type {any} */ call)=>call.entry === 0x409000 && call.thread === m.main));
        assert.ok(m.freed.includes(work), 'the member released');
        assert.equal(m.fns.CloseThreadpoolCleanupGroupMembers.handler([group, 0, 0]), 0,
            'none left');
    });

test('a closed pool\'s threads end: the idle at once, the busy once idle', ()=>{
    const m = machine();
    const pool = m.fns.CreateThreadpool.handler([0]);
    const env = callbackEnvironment(m, 0x6000, { pool });
    const work = m.fns.CreateThreadpoolWork.handler([0x403000, 1, env]);
    m.fns.SubmitThreadpoolWork.handler([work]);
    m.fns.SetThreadpoolThreadMinimum.handler([pool, 2]);
    const [busy, idle] = m.created;
    assert.equal(m.ask(busy), RUN);
    assert.equal(m.ask(idle), PARKED);
    m.fns.CloseThreadpoolWork.handler([work]);
    m.fns.CloseThreadpool.handler([pool]);
    assert.equal(m.freed.includes(pool), false, 'its work still runs');
    assert.equal(m.ask(busy), 0, 'the busy thread ends once its callback returned');
    assert.ok(m.freed.includes(pool));
    assert.deepEqual(m.woken.at(-1), { thread: idle, result: 0 }, 'the idle one ends');
});

test('a wait on a pseudo-handle is its time-out alone', ()=>{
    // Wine's ntdll test_tp_wait sets a wait on INVALID_HANDLE_VALUE, the
    // process's own handle: no wait for many objects takes it.
    const m = waitMachine();
    m.fns.RegisterWaitForSingleObjectEx.handler([0xffffffff, 0x401000, 7, 50, 0]);
    const [home] = m.threads('registered waits');
    assert.deepEqual(m.step(home), { objects: [0x99], milliseconds: 50 },
        'an event nobody sets, for the time-out');
    m.tick(50);
    assert.equal(m.done(home, 0x102), 1);
    const [worker] = m.threads('thread pool');
    assert.deepEqual(m.ask(worker)?.slice(0, 3), [0x401000, 7, 1], 'timed out');
});

test('a thread pool I/O object hands each expected completion of its file to its callback', ()=>{
    // Wine's ntdll test_kernel32_tp_io and test_tp_io: started operations
    // are waited for until their completions ran; one cancelled is not
    // delivered.
    const m = machine();
    const io = m.fns.CreateThreadpoolIo.handler([0x70, 0x407000, 0xc0, 0]);
    assert.notEqual(io, 0);
    const sink = m.sinks.get(0x70);
    assert.equal(typeof sink, 'function', 'the file\'s completions are its');
    assert.equal(m.fns.WaitForThreadpoolIoCallbacks.handler([io, 0]), 0, 'none expected');

    m.fns.StartThreadpoolIo.handler([io]);
    assert.equal(m.fns.WaitForThreadpoolIoCallbacks.handler([io, 0]), PARKED,
        'one expected: waited for before it came');
    sink({ transferred: 1, overlapped: 0x300, key: 0 });
    const [thread] = m.created;
    assert.equal(m.ask(thread), RUN);
    assert.deepEqual(m.record(thread), { entry: 0x407000, args: [0x8000, 0xc0, 0x300, 0] });
    assert.equal(m.get32(0x8000 + 20), 1, 'the fifth: the bytes');
    assert.equal(m.get32(0x8000 + 24), io, 'the sixth argument: the object');
    assert.equal(m.ask(thread), PARKED);
    assert.deepEqual(m.woken.at(-1), { thread: m.main, result: 1 });

    m.fns.StartThreadpoolIo.handler([io]);
    m.fns.CancelThreadpoolIo.handler([io]);
    sink({ transferred: 1, overlapped: 0x300, key: 0 });
    assert.equal(m.woken.at(-1)?.thread, m.main, 'not delivered: none expected');
    m.fns.StartThreadpoolIo.handler([io]);
    assert.equal(m.fns.WaitForThreadpoolIoCallbacks.handler([io, 1]), 0,
        'cancelled with the pending callbacks');

    // ntdll's form: the completion value and an IO_STATUS_BLOCK of its own.
    const native = /** @type {number} */ (
        m.pool.native.objects.createIo(0x74, 0x408000, 0xd0, 0, true));
    m.pool.native.objects.startIo(native);
    m.sinks.get(0x74)({ transferred: 5, overlapped: 0x310, status: 0xc0000120, key: 0 });
    assert.equal(m.woken.at(-1)?.result, RUN);
    const { args } = m.record(thread);
    assert.deepEqual([args[1], args[2], m.get32(0x8000 + 20)], [0xd0, 0x310, native]);
    assert.deepEqual([m.get32(args[3]), m.get32(args[3] + 4)], [0xc0000120, 5]);
    m.ask(thread);
    assert.ok(m.freed.includes(args[3]), 'given back once the callback returned');

    m.fns.CloseThreadpoolIo.handler([io]);
    assert.equal(m.sinks.get(0x70), null, 'the file let go');
});


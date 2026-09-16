/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createHandleTable } from './internal/handles.js';
import { createSwitcher } from './internal/switch.js';
import {
    SCHEDULER_COUNTERS, SLOW_SLICE_COLUMNS, THREAD_COLUMNS, THREAD_ROWS, ThreadState,
    createScheduler,
} from './internal/threads.js';
import { WaitResult, createSyncObjects } from './internal/sync.js';
import { createProcessTable } from './internal/processes.js';
import { createClock } from './internal/time.js';

/**
 * kernel — the execution core: threads, the scheduler, synchronisation, handles
 * and the guest's clock.
 *
 * This is our own engine, not the guest-facing API. What a guest calls to make
 * a thread is `win32/kernel32`'s business; what happens as a result is here.
 */

/** @type {any} */
let scheduler = null;
/** @type {any} */
let sync = null;
/** @type {any} */
let handles = null;
/** @type {any} */
let clock = null;
/** @type {any} */
let switcher = null;
/** @type {any} */
let processes = null;

/**
 * The scheduler's shared tables, registered with the log layer when there is
 * one to register with. Without a registry -- a test's fake, a build with the
 * log layer switched off -- the scheduler keeps the same figures in arrays of
 * its own, and nothing about how it runs changes.
 *
 * The page array spans the guest's memory: one entry per 64 KiB, and one
 * more for an address outside it.
 *
 * @param {any} cpu @param {any} log
 */
function published(cpu, log){
    const memorySize = cpu.layout?.memorySize ?? 1024 * 1024 * 1024;
    const pageRows = Math.ceil(memorySize / 0x10000) + 1;
    const metrics = typeof log.metrics?.table === 'function' ? log.metrics : null;
    if (!metrics)
    {
        return { pages: new Float64Array(pageRows) };
    }
    return {
        pages: metrics.table('kernel', 'pages', { rows: pageRows, columns: ['instructions'] })
            .values,
        counters: metrics.counters('kernel', SCHEDULER_COUNTERS),
        threadTable: metrics.table('kernel', 'threads',
            { rows: THREAD_ROWS, columns: THREAD_COLUMNS }),
        slowSliceTable: metrics.table('kernel', 'slowSlices',
            { rows: 8, columns: SLOW_SLICE_COLUMNS }),
        intern: (/** @type {string} */ text)=>log.intern(text),
    };
}

export const kernelModule = {
    name: 'kernel',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['cpu', 'memory', 'log']),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const cpu = host.requireApi('cpu');
        const memory = host.requireApi('memory');
        const log = host.requireApi('log');

        // Where new threads get their stacks. Each is registered in the address
        // space like anything else, so a stack that runs into its neighbour is
        // caught by the region map rather than by the corruption it causes.
        const stacks = {
            base: config?.stacks?.base ?? 0x00400000 - 0x00100000,
            size: config?.stacks?.size ?? 0x10000,
            // Where the pool ends. Without one it grows into whatever follows
            // it, and a stack overlapping the heap corrupts by writing rather
            // than by failing -- which is the hardest kind of fault to read
            // back to its cause.
            limit: config?.stacks?.limit ?? Infinity,
            issued: 0,
        };

        switcher = createSwitcher({ cpu });
        clock = createClock(config?.clock);
        scheduler = createScheduler({
            cpu,
            switcher,
            // The guest's clock, which is what a timed wait is timed against
            // and what the scheduler moves when every thread is waiting on one.
            now: ()=>clock.virtualTime(),
            // Moved *to* the deadline rather than *by* an interval, because
            // the clock is the one that knows the host's, and a wait nobody has
            // to sit through must never carry the guest past real time.
            /** @param {number} deadline */
            skipTo: deadline=>clock.skipTo(deadline),
            // The answer a parked call woke with, which the trace has no other
            // record of: a program that quits a loop on a wait's answer cannot
            // be read back without it.
            /** @param {any} thread @param {string | null} reason @param {number} value */
            onResume: (thread, reason, value)=>log.debug('kernel',
                '{0} resumed from {1} with {2:x}', thread.name, reason ?? 'a park', value),
            // Below a page the emulator cannot honour a smaller quantum anyway,
            // so asking for one would only be a lie in the configuration.
            quantum: config?.quantum ?? 100_000,
            ...published(cpu, log),
        });
        if (typeof log.metrics?.onFrame === 'function')
        {
            log.metrics.onFrame(()=>scheduler.publish());
        }
        sync = createSyncObjects({ scheduler });
        handles = createHandleTable();
        processes = createProcessTable();

        return {
            ThreadState,
            WaitResult,

            /**
             * Creates a thread, giving it a stack of its own.
             *
             * The stack is primed the way a call would leave it: the thread's
             * parameter above the return address, and the return address itself
             * pointing at the park loop -- so a thread that runs off the end of
             * its start routine stops instead of returning into nothing.
             *
             * @param {Object} options
             * @param {number} options.entry
             * @param {number} [options.parameter]
             * @param {number} [options.stackTop]  Overrides the pool, for the first thread.
             * @param {number} [options.stackLimit]
             *   The low end of that stack. Only meaningful beside `stackTop`;
             *   a stack from the pool knows its own.
             * @param {number} [options.tebAddress]
             * @param {string} [options.name]
             * @param {number} [options.returnTo]
             *   Where the start routine returns to. A thread that returns has
             *   ended, and something has to notice: left at the park loop it
             *   stays runnable for ever, is picked every turn, retires no
             *   instructions, and keeps whatever it was holding. The default is
             *   that loop, for a caller with nothing better -- but a caller
             *   that can end the thread should pass somewhere that does.
             */
            createThread(
                { entry, parameter = 0, stackTop, stackLimit, tebAddress, name, returnTo })
            {
                /** @type {number | undefined} */
                let low = stackLimit;
                // A stack from the pool unless the caller brought its own (the
                // first thread runs on the one the process was given).
                const allocateStack = ()=>{
                    const base = stacks.base + stacks.issued * stacks.size;
                    if (base + stacks.size > stacks.limit)
                    {
                        throw new Error('kernel: no room for another thread stack'
                            + ` (${stacks.issued} of ${stacks.size} bytes from`
                            + ` 0x${stacks.base.toString(16)})`);
                    }
                    memory.register({
                        name: `stack-${stacks.issued + 1}`,
                        base,
                        size: stacks.size,
                        kind: memory.RegionKind.STACK,
                        access: memory.Access.READ_WRITE,
                    });
                    stacks.issued++;
                    low = base;
                    return base + stacks.size;
                };
                // Sixteen rather than the eight the frame needs: a thread that
                // returns pops its return address and then the stub it returns
                // into pops again, and a stack pointer that lands exactly on
                // the top of the region is outside it. The headroom keeps every
                // pointer the thread can reach inside the memory it was given.
                const top = (stackTop ?? allocateStack()) - 16;
                memory.writeU32(top + 4, parameter);
                memory.writeU32(top, returnTo ?? cpu.parkAddress());

                const thread = scheduler.create({
                    entry,
                    stackTop: top,
                    stackLimit: low,
                    tebAddress: tebAddress ?? 0,
                    name,
                });
                thread.handle = handles.open('thread', thread);
                return thread;
            },

            /**
             * Stops the running thread where it stands, and says where its stub
             * would have returned to.
             *
             * The stub is about to execute a `ret`, so the return address on the
             * stack is replaced with the park loop: the loop is a parking slot,
             * not code to resume into. Where the thread goes instead is the
             * caller's decision, and this returns what it needs to make it.
             *
             * @returns {number} the address the stub was going to return to
             */
            holdThread(){
                const esp = cpu.readReg32('esp');
                const returnAddress = memory.readU32(esp);
                memory.writeU32(esp, cpu.parkAddress());
                return returnAddress;
            },

            /**
             * Stops the running thread and arranges for it to carry on exactly
             * where it left off -- what a blocking wait and a terminating call
             * both want.
             *
             * @param {any} thread
             */
            parkThread(thread){
                const esp = cpu.readReg32('esp');
                thread.parkedReturn = memory.readU32(esp);
                memory.writeU32(esp, cpu.parkAddress());
            },

            /**
             * Says where a stopped thread continues when it next gets a turn.
             *
             * Applied inside the switch rather than here (§12.5): a saved
             * context rewritten anywhere else would be ignored for the thread
             * that is still on the CPU.
             *
             * @param {any} thread
             * @param {Object} where
             * @param {number} where.eip
             * @param {number} [where.esp]           For a thread being sent somewhere new.
             * @param {number} [where.returnValue]
             */
            scheduleResume(thread, { eip, esp, returnValue = 0 }){
                thread.parkedReturn = eip;
                thread.resumeStack = esp ?? null;
                thread.waitResult = returnValue;
            },
            currentThread: ()=>scheduler.current(),
            threads: ()=>scheduler.all(),

            /** @param {number} address @param {number} id */
            writeThreadId: (address, id)=>memory.writeU32(address, id),

            /**
             * Runs one turn. Returns what happened rather than a count, so a
             * caller can tell progress from an idle system from a finished one.
             */
            runOnce: ()=>scheduler.runOnce(),

            /** The scheduler's own view, for a caller driving the machine. */
            diagnosticsSnapshot: ()=>scheduler.diagnostics(),
            /**
             * Where the guest ran, by page of guest code, weighted by retired
             * instructions. Addresses, because naming them needs the image map.
             * A walk of every page: for a caller on this thread that asks
             * once, not for a poll. The `kernel/pages` table is the same
             * figures with no walk.
             */
            pages: ()=>scheduler.pages(),
            /**
             * Every synchronisation object ever made, one row each. Thousands
             * in a running program, so asked for by name rather than carried
             * in the diagnostics table.
             */
            syncObjects: ()=>sync.diagnostics(),

            /**
             * The soonest guest time a blocked thread is waiting for, or null.
             *
             * Whoever drives the machine needs it to tell two states apart that
             * look identical from outside: nothing can run because nothing ever
             * will, and nothing can run until a moment that is coming.
             */
            nextDeadline: ()=>scheduler.nextDeadline(),

            /** @param {any} thread @param {number} exitCode */
            exitThread(thread, exitCode){
                // A thread that dies holding a mutex leaves whatever it protected
                // half-written; the next owner has to be told (§ abandoned mutex).
                sync.abandonMutexesOwnedBy(thread);
                scheduler.terminate(thread, exitCode);
                // And a thread is itself something a program waits on. Whoever
                // joined it is released now and stays released: the object is
                // signalled by having ended, not by handing anything over.
                sync.releaseAll(thread);
            },

            /**
             * @param {any} thread @param {string} [reason]
             * @param {{ deadline?: number, result?: number }} [timed]
             *   For a waiter the kernel does not hold a queue for -- a
             *   completion port lives above this layer, and its wait still has
             *   to expire in guest time like any other.
             */
            block: (thread, reason, timed)=>scheduler.block(thread, reason, timed),
            /**
             * @param {any} thread
             * @param {number} [result]
             *   What the blocked call answers. A waker outside the kernel's own
             *   objects has no other way to say it: the thread resumes straight
             *   into guest code with this value in EAX.
             * @returns {boolean} whether the thread was blocked at all
             */
            wake(thread, result){
                if (result !== undefined)
                {
                    thread.waitResult = result >>> 0;
                }
                return scheduler.wake(thread);
            },

            /**
             * Told when a thread's timed wait ran out, so a queue kept outside
             * the kernel can drop a thread that has stopped waiting.
             *
             * @param {(thread: any) => void} handler
             */
            onTimeout: handler=>scheduler.onTimeout(handler),

            createEvent: (/** @type {any} */ options)=>sync.createEvent(options),
            createMutex: (/** @type {any} */ options)=>sync.createMutex(options),
            createSemaphore: (/** @type {any} */ options)=>sync.createSemaphore(options),
            /**
             * A waitable timer, whose due time the clock honours on its own.
             *
             * @param {any} options
             */
            createTimer: (/** @type {any} */ options)=>sync.createTimer(options),
            /**
             * @param {any} timer @param {number} due @param {number} period
             */
            armTimer: (/** @type {any} */ timer, due, period)=>
                sync.armTimer(timer, due, period),
            /** @param {any} timer */
            cancelTimer: (/** @type {any} */ timer)=>sync.cancelTimer(timer),
            /**
             * @param {any} object
             * @param {any} thread
             * @param {{ deadline?: number, result?: number }} [timed]
             */
            wait: (object, thread, timed)=>sync.wait(object, thread, timed),
            /** @param {any} object @param {any} thread */
            poll: (object, thread)=>sync.poll(object, thread),

            /**
             * Blocks a thread for a span of guest time and nothing else.
             *
             * The scheduler moves the clock forward when every thread is
             * waiting on one, so a program that sleeps between frames costs the
             * host nothing and still observes time passing.
             *
             * @param {any} thread @param {number} milliseconds
             */
            sleep(thread, milliseconds){
                scheduler.block(thread, `${milliseconds} ms`, {
                    deadline: clock.virtualTime() + milliseconds,
                    result: 0,
                });
            },
            /**
             * @param {any[]} objects @param {any} thread
             * @param {{ deadline?: number, result?: number }} [timed]
             */
            waitAll: (objects, thread, timed)=>sync.waitAll(objects, thread, timed),
            /**
             * @param {any[]} objects @param {any} thread
             * @param {{ deadline?: number, result?: number }} [timed]
             */
            waitAny: (objects, thread, timed)=>sync.waitAny(objects, thread, timed),
            setEvent: (/** @type {any} */ object)=>sync.setEvent(object),
            resetEvent: (/** @type {any} */ object)=>sync.resetEvent(object),
            releaseMutex: (/** @type {any} */ object, /** @type {any} */ thread)=>
                sync.releaseMutex(object, thread),
            releaseSemaphore: (/** @type {any} */ object, /** @type {number} */ count)=>
                sync.releaseSemaphore(object, count),

            handles: {
                /** @param {string} type @param {any} object */
                open: (type, object)=>handles.open(type, object),
                /** @param {number} handle @param {string} [type] */
                resolve: (handle, type)=>handles.resolve(handle, type),
                /** @param {number} handle */
                close: handle=>handles.close(handle),
                /**
                 * What kind of object a handle names, without resolving it.
                 *
                 * Duplicating a handle has to make one of the same kind, and
                 * asking for the object to find that out would fail for a kind
                 * the caller did not name.
                 *
                 * @param {number} handle
                 */
                typeOf: handle=>handles.typeOf(handle),
                /**
                 * Whether anything still holds a handle to this object. A
                 * Win32 name lives exactly as long as one does.
                 *
                 * @param {any} object
                 */
                holds: object=>handles.holds(object),
            },

            /**
             * Child processes, as records. Nothing here runs one: a request is
             * recorded, and whoever drives the machine decides when the parent
             * has nothing left to do and the child takes its place.
             */
            processes: {
                /**
                 * @param {{ imagePath: string, commandLine: string,
                 *           suspended?: boolean }} options
                 */
                create: options=>processes.create(options),
                pending: ()=>processes.pending(),
                all: ()=>processes.all(),
            },

            clock,
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'kernel',
            version: '0.1.0',
            status: scheduler ? 'ready' : 'created',
            metrics: scheduler
                ? {
                    ...scheduler.diagnostics(),
                    ...switcher.diagnostics(),
                    handles: handles.diagnostics(),
                    sync: sync.summary(),
                    processes: processes.diagnostics(),
                    time: clock.diagnostics(),
                }
                : {},
        };
    },

    async dispose(){
        scheduler = null;
        sync = null;
        handles = null;
        clock = null;
        switcher = null;
        processes = null;
    },
};

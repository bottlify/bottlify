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
import { STILL_ACTIVE, createProcessTable } from './internal/processes.js';
import { createClock } from './internal/time.js';
import { createStackPool } from './internal/stacks.js';

/**
 * kernel — the execution core: threads, the scheduler, synchronisation, handles
 * and the guest's clock.
 *
 * This is our own engine, not the guest-facing API. What a guest calls to make
 * a thread is `win32/kernel32`'s business; what happens as a result is here.
 */

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

/** The kernel layer's module for one graph; see `defaultModules`. */
export function createKernelModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- the scheduler, the sync objects, the handle table, the
     * process table and the clock belong to the closure `create()` returns,
     * so a second instance in one realm cannot take the first one's threads.
     *
     * @type {any}
     */
    let current = null;

    return {
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

            // Where new threads get their stacks.
            const stacks = createStackPool({
                memory,
                base: config?.stacks?.base ?? 0x00400000 - 0x00100000,
                size: config?.stacks?.size ?? 0x10000,
                // Where the pool ends. Without one it grows into whatever follows
                // it, and a stack overlapping the heap corrupts by writing rather
                // than by failing -- which is the hardest kind of fault to read
                // back to its cause.
                limit: config?.stacks?.limit ?? Infinity,
            });

            /**
             * Everything this instance owns, and whether it is still open.
             *
             * The calls an api hands out close over this object rather than over
             * module-level bindings, because `create()` may run more than once in
             * one realm -- a process replacement does, and the plan for more than
             * one machine in a worker needs two at once -- so each run keeps its
             * own threads, sync objects and handles.
             *
             * @type {{ scheduler: any, sync: any, handles: any, clock: any, switcher: any,
             *          processes: any, stacks: any, disposed: boolean, resumeLog: string[],
             *          refreshClock: (() => void) | undefined }}
             */
            const state = {
                stacks,
                scheduler: null,
                sync: null,
                handles: null,
                clock: null,
                switcher: null,
                processes: null,
                disposed: false,
                refreshClock: undefined,
                // The last parks, holds and scheduled resumes, newest last: what a
                // thread that sits in the park loop is read by.
                resumeLog: [],
            };
            /** @param {string} entry */
            const noteResume = entry=>{
                state.resumeLog.push(entry);
                if (state.resumeLog.length > 16)
                {
                    state.resumeLog.shift();
                }
            };

            state.switcher = createSwitcher({ cpu });
            state.clock = createClock(config?.clock);
            // The time-stamp counter counts the same time QueryPerformanceCounter
            // reads, so a program calibrating one against the other measures the
            // frequency CPUID states.
            cpu.useGuestClock?.(()=>state.clock.virtualTime());
            state.scheduler = createScheduler({
                cpu,
                switcher: state.switcher,
                // The guest's clock, which is what a timed wait is timed against
                // and what the scheduler moves when every thread is waiting on one.
                now: ()=>state.clock.virtualTime(),
                // Moved *to* the deadline rather than *by* an interval, because
                // the clock is the one that knows the host's, and a wait nobody has
                // to sit through must never carry the guest past real time.
                /** @param {number} deadline */
                skipTo: deadline=>state.clock.skipTo(deadline),
                // The answer a parked call woke with, which the trace has no other
                // record of: a program that quits a loop on a wait's answer cannot
                // be read back without it.
                /** @param {any} thread @param {string | null} reason @param {number} value */
                onResume: (thread, reason, value)=>log.debug('kernel',
                    '{0} resumed from {1} with {2:x}', thread.name, reason ?? 'a park', value),
                // Below a page the emulator cannot honour a smaller quantum anyway,
                // so asking for one would only be a lie in the configuration.
                quantum: config?.quantum ?? 100_000,
                soloQuantum: config?.soloQuantum,
                ids: config?.ids,
                ...published(cpu, log),
            });
            if (typeof log.metrics?.onFrame === 'function')
            {
                log.metrics.onFrame(()=>state.scheduler.publish());
            }
            // With `preemption` on, a slice ends between chunks of translated
            // code once a thread of higher priority comes due, as Windows
            // preempts for one (`preemptionDue`). Off by default: measured on
            // the Warcraft III demo it ended ~8 000 slices early for Miles'
            // TIME_CRITICAL mixer and changed nothing heard in a browser, where
            // the mixer's lateness is collection pauses outside any slice; and
            // the chunked budget it needs has not been measured for speed.
            if (config?.preemption === true)
            {
                cpu.setYieldCheck?.(()=>!state.disposed
                    && state.scheduler.preemptionDue(state.refreshClock));
            }
            state.sync = createSyncObjects({ scheduler: state.scheduler,
                remote: config?.remoteObjects ?? null });
            // A wait of this process on another's object, across a link,
            // ends there; the word comes back here.
            config?.remoteObjects?.onWake?.((/** @type {number} */ token,
                /** @type {number} */ result)=>state.sync?.wakeRemote(token, result));
            state.handles = createHandleTable();
            state.processes = createProcessTable(config?.ids);

            /**
             * Whether this instance is still open. A call still in flight when the
             * machine was disposed must not find the scheduler, the sync objects
             * or the handle table gone: it answers the harmless value below
             * rather than dereferencing what disposal took away.
             */
            const live = ()=>!state.disposed;

            current = state;
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
                 * @param {number} [options.stackSize]
                 *   The commit a caller asked for, which moves the reserve only
                 *   when it is as large as the default reserve.
                 * @param {number} [options.stackReserve]  The reserve a caller asked for.
                 * @param {number} [options.tebAddress]
                 * @param {string} [options.name]
                 * @param {number} [options.id]  The id the thread was promised
                 *   before it was made: a child's first thread has the one its
                 *   parent was told in PROCESS_INFORMATION.
                 * @param {number} [options.returnTo]
                 *   Where the start routine returns to. A thread that returns has
                 *   ended, and something has to notice: left at the park loop it
                 *   stays runnable for ever, is picked every turn, retires no
                 *   instructions, and keeps whatever it was holding. The default is
                 *   that loop, for a caller with nothing better -- but a caller
                 *   that can end the thread should pass somewhere that does.
                 * @returns {any} null once this instance is disposed -- there is
                 *     no scheduler left to give a thread to -- or when the pool has
                 *     no room for its stack, which is a thread that cannot be made
                 *     rather than a machine that has to stop.
                 */
                createThread({
                    entry, parameter = 0, stackTop, stackLimit, stackSize, stackReserve,
                    tebAddress, name, returnTo, id,
                })
                {
                    if (!live())
                    {
                        return null;
                    }
                    /** @type {number | undefined} */
                    let low = stackLimit;
                    let top = stackTop ?? 0;
                    /** @type {any} */
                    let slot = null;
                    // A stack from the pool unless the caller brought its own (the
                    // first thread runs on the one the process was given).
                    if (stackTop === undefined)
                    {
                        slot = stacks.allocate({ commit: stackSize, reserve: stackReserve },
                            (/** @type {any} */ owner)=>owner.releasesStack === true
                                && owner.state === ThreadState.TERMINATED
                                && owner !== state.scheduler.current());
                        if (!slot)
                        {
                            log.warn?.('kernel', 'no room in the stack pool for a thread'
                                + ' (commit {0}, reserve {1}): {2}', stackSize ?? 0,
                            stackReserve ?? 0, JSON.stringify(stacks.diagnostics()));
                            return null;
                        }
                        low = slot.base;
                        top = slot.base + slot.size;
                    }
                    // The translator stores through esp untested while no code
                    // lies on a stack; a caller that names no low end has the
                    // reserve a thread gets by default.
                    const base = low ?? Math.max(0, top - 0x100000);
                    cpu.noteStack?.(base, top - base);
                    // Sixteen rather than the eight the frame needs: a thread that
                    // returns pops its return address and then the stub it returns
                    // into pops again, and a stack pointer that lands exactly on
                    // the top of the region is outside it. The headroom keeps every
                    // pointer the thread can reach inside the memory it was given.
                    top -= 16;
                    memory.writeU32(top + 4, parameter);
                    memory.writeU32(top, returnTo ?? cpu.parkAddress());

                    const thread = state.scheduler.create({
                        entry,
                        stackTop: top,
                        stackLimit: low,
                        tebAddress: tebAddress ?? 0,
                        name,
                        id,
                    });
                    thread.handle = state.handles.open('thread', thread);
                    if (slot)
                    {
                        slot.owner = thread;
                    }
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
                    noteResume(`hold ${state.scheduler.current()?.name}`
                        + `@0x${(returnAddress >>> 0).toString(16)}`);
                    return returnAddress;
                },

                /**
                 * Stops the running thread and arranges for it to carry on exactly
                 * where it left off -- what a blocking wait and a terminating call
                 * both want.
                 *
                 * @param {any} thread
                 * @param {number} restingStack
                 *   Where the stub's `ret` leaves ESP. Given, the resume sets ESP
                 *   there rather than trusting the saved context, which may have
                 *   been taken before that `ret` ran.
                 */
                parkThread(thread, restingStack){
                    const esp = cpu.readReg32('esp');
                    thread.parkedReturn = memory.readU32(esp);
                    noteResume(`park ${thread.name}@0x${(thread.parkedReturn >>> 0).toString(16)}`);
                    thread.resumeStack = restingStack;
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
                 * @param {Record<string, number>} [where.registers]
                 *        The others it continues with, for code that reads them
                 *        before it sets them. EAX here wins over `returnValue`.
                 */
                scheduleResume(thread, { eip, esp, returnValue = 0, registers }){
                    noteResume(`schedule ${thread.name}@0x${(eip >>> 0).toString(16)}`);
                    thread.parkedReturn = eip;
                    thread.resumeStack = esp ?? null;
                    thread.waitResult = registers?.eax ?? returnValue;
                    thread.resumeRegisters = registers ?? null;
                },
                currentThread: ()=>live() ? state.scheduler.current() : null,
                /**
                 * Guest code no slice ends inside (see the scheduler's
                 * `atomicCode`): a routine of the host's that writes what other
                 * threads read, and never waits.
                 *
                 * @param {number} address @param {number} length
                 */
                atomicCode: (address, length)=>{
                    if (live())
                    {
                        state.scheduler.atomicCode(address, length);
                    }
                },
                /** Whether a thread of higher priority is due the processor now (see the scheduler). */
                preemptionDue: ()=>live() && state.scheduler.preemptionDue(state.refreshClock),
                /**
                 * How the guest's clock is brought up to the host's between turns,
                 * so a wait can come due inside a slice (see `preemptionDue`).
                 *
                 * @param {() => void} refresh
                 */
                refreshClockWith(refresh){
                    state.refreshClock = refresh;
                },
                threads: ()=>live() ? state.scheduler.all() : [],
                /**
                 * The processors the machine has: the process's executors,
                 * each a processor its threads may be pinned to.
                 *
                 * @returns {number}
                 */
                processors: ()=>cpu.processors?.() ?? 1,
                /**
                 * The processor `thread` runs on now: the executor holding it.
                 *
                 * @param {any} thread
                 * @returns {number}
                 */
                processorOf: thread=>(live() ? state.scheduler.processorOf(thread) : 0),
                /** The processor time the process's threads have taken, in milliseconds. */
                processCpuMs: ()=>(live() ? state.scheduler.cpuMs() : 0),

                /** @param {number} address @param {number} id */
                writeThreadId: (address, id)=>memory.writeU32(address, id),

                /**
                 * Runs one turn. Returns what happened rather than a count, so a
                 * caller can tell progress from an idle system from a finished one.
                 * Once this instance is disposed there is nothing to run.
                 */
                /** @param {number} ticks @param {boolean} answered */
                noteHostAnswer: (ticks, answered)=>{
                    if (live())
                    {
                        state.scheduler.noteHostAnswer(ticks, answered);
                    }
                },
                runOnce: ()=>live()
                    ? state.scheduler.runOnce()
                    : { ran: null, instructions: 0, switched: false },

                /** The scheduler's own view, for a caller driving the machine. */
                diagnosticsSnapshot: ()=>live() ? state.scheduler.diagnostics() : {},
                /**
                 * Where the guest ran, by page of guest code, weighted by retired
                 * instructions. Addresses, because naming them needs the image map.
                 * A walk of every page: for a caller on this thread that asks
                 * once, not for a poll. The `kernel/pages` table is the same
                 * figures with no walk.
                 */
                pages: ()=>live() ? state.scheduler.pages() : {},
                /**
                 * Every synchronisation object ever made, one row each. Thousands
                 * in a running program, so asked for by name rather than carried
                 * in the diagnostics table.
                 */
                syncObjects: ()=>live() ? state.sync.diagnostics() : [],

                /**
                 * The soonest guest time a blocked thread is waiting for, or null.
                 *
                 * Whoever drives the machine needs it to tell two states apart that
                 * look identical from outside: nothing can run because nothing ever
                 * will, and nothing can run until a moment that is coming.
                 */
                nextDeadline: ()=>live() ? state.scheduler.nextDeadline() : null,

                /** @param {any} thread @param {number} exitCode */
                exitThread(thread, exitCode){
                    if (!live())
                    {
                        return;
                    }
                    // A thread that ends itself gives its stack back; one ended
                    // by another thread does not, as Microsoft documents for
                    // TerminateThread -- whatever it left there stays readable.
                    thread.releasesStack = thread === state.scheduler.current();
                    // A thread that dies holding a mutex leaves whatever it protected
                    // half-written; the next owner has to be told (§ abandoned mutex).
                    state.sync.abandonMutexesOwnedBy(thread);
                    // A thread ended while it waited leaves the queues it stood
                    // in: the next signal would otherwise go to it and be lost
                    // to a live waiter.
                    state.sync.stopWaiting(thread);
                    state.scheduler.terminate(thread, exitCode);
                    // And a thread is itself something a program waits on. Whoever
                    // joined it is released now and stays released: the object is
                    // signalled by having ended, not by handing anything over.
                    state.sync.releaseAll(thread);
                },

                /**
                 * Suspends a thread: it keeps its state -- a wait stays a wait,
                 * deadline and all -- and gets no turn, and no object it waits on
                 * is handed to it, until it has been resumed as often.
                 *
                 * @param {any} thread
                 * @returns {number | null} the count before, or null when the
                 *     thread already carries the most suspensions it can
                 */
                suspendThread: thread=>live() ? state.scheduler.suspend(thread) : null,

                /**
                 * Brings a thread running on another of the process's executors
                 * back to it, its registers saved (`scheduler.settle`).
                 *
                 * @param {any} thread
                 * @returns {boolean} whether it runs nowhere now
                 */
                settleThread: thread=>!live() || state.scheduler.settle(thread),

                /**
                 * @param {any} thread
                 * @returns {number} the count before
                 */
                resumeThread(thread){
                    if (!live())
                    {
                        return 0;
                    }
                    const previous = state.scheduler.resume(thread);
                    if (previous === 1)
                    {
                        state.sync.retry(thread);
                    }
                    return previous;
                },

                /**
                 * @param {any} thread @param {string} [reason]
                 * @param {{ deadline?: number, result?: number }} [timed]
                 *   For a waiter the kernel does not hold a queue for -- a
                 *   completion port lives above this layer, and its wait still has
                 *   to expire in guest time like any other.
                 */
                block: (thread, reason, timed)=>{
                    if (live())
                    {
                        state.scheduler.block(thread, reason, timed);
                    }
                },
                /**
                 * @param {any} thread
                 * @param {number} [result]
                 *   What the blocked call answers. A waker outside the kernel's own
                 *   objects has no other way to say it: the thread resumes straight
                 *   into guest code with this value in EAX.
                 * @returns {boolean} whether the thread was blocked at all
                 */
                wake(thread, result){
                    if (!live())
                    {
                        return false;
                    }
                    if (result !== undefined)
                    {
                        thread.waitResult = result >>> 0;
                    }
                    return state.scheduler.wake(thread);
                },

                /**
                 * Told when a thread's timed wait ran out, so a queue kept outside
                 * the kernel can drop a thread that has stopped waiting.
                 *
                 * @param {(thread: any) => void} handler
                 */
                onTimeout: handler=>{
                    if (live())
                    {
                        state.scheduler.onTimeout(handler);
                    }
                },

                createEvent: (/** @type {any} */ options)=>
                    live() ? state.sync.createEvent(options) : null,
                createMutex: (/** @type {any} */ options)=>
                    live() ? state.sync.createMutex(options) : null,
                createSemaphore: (/** @type {any} */ options)=>
                    live() ? state.sync.createSemaphore(options) : null,
                /**
                 * A waitable timer, whose due time the clock honours on its own.
                 *
                 * @param {any} options
                 */
                createTimer: (/** @type {any} */ options)=>
                    live() ? state.sync.createTimer(options) : null,
                /**
                 * @param {any} timer @param {number} due @param {number} period
                 * @param {((at: number) => void) | null} [fired]
                 */
                armTimer: (/** @type {any} */ timer, due, period, fired)=>
                    live() ? state.sync.armTimer(timer, due, period, fired) : false,

                /**
                 * Runs `wait` as an alertable wait: a block it makes may be ended
                 * early by `alert`. Anything it answers without blocking is its
                 * own answer.
                 *
                 * @template T
                 * @param {any} thread
                 * @param {() => T} wait
                 * @returns {T}
                 */
                alertably(thread, wait){
                    thread.enteringAlertable = true;
                    try
                    {
                        return wait();
                    }
                    finally
                    {
                        thread.enteringAlertable = false;
                    }
                },

                /**
                 * Ends an alertable wait early, with `result` as what the call that
                 * waited answers. A thread that is not blocked in an alertable wait
                 * is left alone.
                 *
                 * @param {any} thread
                 * @param {number} result
                 * @returns {boolean} whether the wait was ended
                 */
                alert(thread, result){
                    if (!live() || thread.state !== ThreadState.BLOCKED
                        || thread.alertable !== true)
                    {
                        return false;
                    }
                    state.sync.stopWaiting(thread);
                    thread.waitResult = result >>> 0;
                    return state.scheduler.wake(thread);
                },
                /** @param {any} timer */
                cancelTimer: (/** @type {any} */ timer)=>{
                    if (live())
                    {
                        state.sync.cancelTimer(timer);
                    }
                },
                /**
                 * @param {any} object
                 * @param {any} thread
                 * @param {{ deadline?: number, result?: number }} [timed]
                 */
                wait: (object, thread, timed)=>
                    live() ? state.sync.wait(object, thread, timed) : WaitResult.FAILED,
                /** @param {any} object @param {any} thread */
                poll: (object, thread)=>(live()
                    ? state.sync.poll(object, thread) : WaitResult.FAILED),

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
                    if (!live())
                    {
                        return;
                    }
                    state.scheduler.block(thread, `${milliseconds} ms`, {
                        deadline: state.clock.virtualTime() + milliseconds,
                        result: 0,
                    });
                },
                /**
                 * @param {any[]} objects @param {any} thread
                 * @param {{ deadline?: number, result?: number }} [timed]
                 */
                waitAll: (objects, thread, timed)=>
                    live() ? state.sync.waitAll(objects, thread, timed) : WaitResult.FAILED,
                /**
                 * @param {any[]} objects @param {any} thread
                 * @param {{ deadline?: number, result?: number }} [timed]
                 */
                waitAny: (objects, thread, timed)=>live()
                    ? state.sync.waitAny(objects, thread, timed)
                    : { index: -1, result: WaitResult.FAILED },
                /** @param {any[]} objects @param {any} thread */
                pollAny: (objects, thread)=>(live()
                    ? state.sync.pollAny(objects, thread)
                    : { index: -1, result: WaitResult.FAILED }),
                setEvent: (/** @type {any} */ object)=>live() ? state.sync.setEvent(object) : [],
                resetEvent: (/** @type {any} */ object)=>{
                    if (live())
                    {
                        state.sync.resetEvent(object);
                    }
                },
                releaseMutex: (/** @type {any} */ object, /** @type {any} */ thread)=>
                    live() ? state.sync.releaseMutex(object, thread) : false,
                releaseSemaphore: (/** @type {any} */ object, /** @type {number} */ count)=>
                    live() ? state.sync.releaseSemaphore(object, count) : 0,

                handles: {
                    /** @param {string} type @param {any} object */
                    open: (type, object)=>live() ? state.handles.open(type, object) : 0,
                    /** @param {number} handle @param {string} [type] */
                    resolve: (handle, type)=>live() ? state.handles.resolve(handle, type) : null,
                    /** @param {number} handle */
                    close: handle=>live() ? state.handles.close(handle) : null,
                    /**
                     * What kind of object a handle names, without resolving it.
                     *
                     * Duplicating a handle has to make one of the same kind, and
                     * asking for the object to find that out would fail for a kind
                     * the caller did not name.
                     *
                     * @param {number} handle
                     */
                    typeOf: handle=>live() ? state.handles.typeOf(handle) : null,
                    /**
                     * Whether anything still holds a handle to this object. A
                     * Win32 name lives exactly as long as one does.
                     *
                     * @param {any} object
                     */
                    holds: object=>live() ? state.handles.holds(object) : false,
                },

                /**
                 * Child processes, as records. Nothing here runs one: a request is
                 * recorded, and whoever drives the machine decides when the parent
                 * has nothing left to do and the child takes its place.
                 */
                processes: {
                    /** The exit code a process still running reports. */
                    STILL_ACTIVE,
                    /**
                     * @param {{ imagePath: string, commandLine: string,
                     *           suspended?: boolean, completed?: boolean }} options
                     */
                    create: options=>live() ? state.processes.create(options) : null,
                    pending: ()=>live() ? state.processes.pending() : null,
                    all: ()=>live() ? state.processes.all() : [],
                    /** @param {any} record */
                    finished: record=>live() ? state.processes.finished(record) : false,
                    /**
                     * A process taken up by a machine of its own while its
                     * parent goes on: no longer pending.
                     *
                     * @param {any} record
                     */
                    started: record=>live() ? state.processes.started(record) : undefined,
                },

                clock: state.clock,
            };
        },

        /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
        diagnostics(){
            const instance = current;
            if (!instance || instance.disposed)
            {
                return { name: 'kernel', version: '0.1.0', status: 'created', metrics: {} };
            }
            return {
                name: 'kernel',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    ...instance.scheduler.diagnostics(),
                    ...instance.switcher.diagnostics(),
                    ...instance.stacks.diagnostics(),
                    recentScheduled: instance.resumeLog.slice(),
                    handles: instance.handles.diagnostics(),
                    sync: instance.sync.summary(),
                    processes: instance.processes.diagnostics(),
                    time: instance.clock.diagnostics(),
                },
            };
        },

        async dispose(){
            if (current)
            {
                current.disposed = true;
            }
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const kernelModule = createKernelModule();

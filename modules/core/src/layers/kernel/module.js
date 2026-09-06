/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createHandleTable } from './internal/handles.js';
import { createSwitcher } from './internal/switch.js';
import { ThreadState, createScheduler } from './internal/threads.js';
import { WaitResult, createSyncObjects } from './internal/sync.js';
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

        // Where new threads get their stacks. Each is registered in the address
        // space like anything else, so a stack that runs into its neighbour is
        // caught by the region map rather than by the corruption it causes.
        const stacks = {
            base: config?.stacks?.base ?? 0x00400000 - 0x00100000,
            size: config?.stacks?.size ?? 0x10000,
            issued: 0,
        };

        switcher = createSwitcher({ cpu });
        scheduler = createScheduler({
            cpu,
            switcher,
            // Below a page the emulator cannot honour a smaller quantum anyway,
            // so asking for one would only be a lie in the configuration.
            quantum: config?.quantum ?? 100_000,
        });
        sync = createSyncObjects({ scheduler });
        handles = createHandleTable();
        clock = createClock(config?.clock);

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
             * @param {number} [options.tebAddress]
             * @param {string} [options.name]
             */
            createThread({ entry, parameter = 0, stackTop, tebAddress, name }){
                // A stack from the pool unless the caller brought its own (the
                // first thread runs on the one the process was given).
                const allocateStack = ()=>{
                    const base = stacks.base + stacks.issued * stacks.size;
                    memory.register({
                        name: `stack-${stacks.issued + 1}`,
                        base,
                        size: stacks.size,
                        kind: memory.RegionKind.STACK,
                        access: memory.Access.READ_WRITE,
                    });
                    stacks.issued++;
                    return base + stacks.size;
                };
                const top = (stackTop ?? allocateStack()) - 8;
                memory.writeU32(top + 4, parameter);
                memory.writeU32(top, cpu.parkAddress());

                const thread = scheduler.create({
                    entry,
                    stackTop: top,
                    tebAddress: tebAddress ?? 0,
                    name,
                });
                thread.handle = handles.open('thread', thread);
                return thread;
            },

            /**
             * Stops the running thread where it stands.
             *
             * Its stub is about to execute a `ret`, so the return address on the
             * stack is put aside and replaced with the park loop: the loop is a
             * parking slot, not code to resume into. The saved address is where
             * the thread continues when it next gets a turn.
             *
             * @param {any} thread
             */
            parkThread(thread){
                const esp = cpu.readReg32('esp');
                thread.parkedReturn = memory.readU32(esp);
                memory.writeU32(esp, cpu.parkAddress());
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

            /** @param {any} thread @param {number} exitCode */
            exitThread(thread, exitCode){
                // A thread that dies holding a mutex leaves whatever it protected
                // half-written; the next owner has to be told (§ abandoned mutex).
                sync.abandonMutexesOwnedBy(thread);
                scheduler.terminate(thread, exitCode);
            },

            /** @param {any} thread @param {string} [reason] */
            block: (thread, reason)=>scheduler.block(thread, reason),
            /** @param {any} thread */
            wake: thread=>scheduler.wake(thread),

            createEvent: (/** @type {any} */ options)=>sync.createEvent(options),
            createMutex: (/** @type {any} */ options)=>sync.createMutex(options),
            createSemaphore: (/** @type {any} */ options)=>sync.createSemaphore(options),
            wait: (/** @type {any} */ object, /** @type {any} */ thread)=>sync.wait(object, thread),
            waitAll: (/** @type {any[]} */ objects, /** @type {any} */ thread)=>
                sync.waitAll(objects, thread),
            waitAny: (/** @type {any[]} */ objects, /** @type {any} */ thread)=>
                sync.waitAny(objects, thread),
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
                    sync: sync.diagnostics(),
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
    },
};

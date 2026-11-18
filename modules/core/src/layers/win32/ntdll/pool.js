/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ntdll's thread pool: work items, waits and timer queues, and the thread
 * pool API's Tp* calls.
 *
 * kernel32's pool calls are these on Windows; here the pool is kernel32's
 * (pool.js), so each is its call with the arguments in ntdll's order and
 * the answer as a status. One pool means a wait registered here is
 * unregistered through UnregisterWait, and a timer made here fires on the
 * same threads as one made through CreateTimerQueueTimer. The deletions are
 * the pool's own, answering statuses (`PoolDeletions`): one that waits for
 * the callbacks wakes its caller with its answer, which no translation
 * here could reach. The Tp* calls are the thread pool API's objects
 * (`threadpool-api.js`) that kernel32's CreateThreadpool* calls are, a
 * new object written where its caller asks.
 */

import { STATUS } from './status.js';

/** The kernel32 calls these are made of. */
export const POOL_ENTRIES = ['QueueUserWorkItem', 'RegisterWaitForSingleObject',
    'CreateTimerQueue', 'CreateTimerQueueTimer', 'ChangeTimerQueueTimer', 'GetLastError'];

const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;

/** TpCallbackMayRunLong's answer when no other thread can take the next callback. */
const STATUS_TOO_MANY_THREADS = 0xc0000129;

/**
 * The pool's deletions, answered as statuses by the pool itself: a deletion
 * that waits for the callbacks parks its caller, and the caller is woken
 * with its answer, which kernel32's would give as TRUE. `objects` is the
 * thread pool API's.
 *
 * @typedef {Object} PoolDeletions
 * @property {(wait: number, event: number) => any} deregisterWait
 * @property {(timer: number, event: number) => any} deleteTimer
 * @property {(queue: number, event: number) => any} deleteTimerQueue
 * @property {any} [objects]
 */

/**
 * @param {{ kernel32: Record<string, { handler: Function }>, deletions: PoolDeletions,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} host
 * @returns {Record<string, { argBytes: number, handler: Function }>}
 */
export function createPoolFunctions({ kernel32, deletions, writeMemory }){
    /** @param {number} at @param {number} value */
    const write32 = (at, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        writeMemory(at >>> 0, bytes);
    };
    /** A Win32 error the API refused with, as its status. @param {number} error */
    const statusOf = error=>(error === 0 ? STATUS.SUCCESS
        : error === ERROR_NOT_ENOUGH_MEMORY ? STATUS.NO_MEMORY : STATUS.INVALID_PARAMETER);
    /** @param {number} argBytes @param {(args: number[]) => any} handler */
    const fn = (argBytes, handler)=>({ argBytes, handler });
    /**
     * A void call: done, answering nothing.
     *
     * @param {number} argBytes @param {(args: number[]) => void} does
     */
    const act = (argBytes, does)=>fn(argBytes, args=>{
        does(args);
        return 0;
    });
    const objects = deletions.objects;
    /**
     * An object made, written where its caller asks.
     *
     * @param {'work' | 'timer' | 'wait'} kind
     */
    const alloc = kind=>fn(16, ([out, callback, context, environment])=>{
        const made = objects.create(kind, callback, context, environment);
        if (typeof made !== 'number')
        {
            return statusOf(made.error);
        }
        write32(out, made);
        return STATUS.SUCCESS;
    });
    /** @param {number} instance @param {string} name @param {number[]} args */
    const onCompletion = (instance, name, args)=>objects.onCompletion(instance, name, args);
    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const tp = !objects ? {} : {
        /** NTSTATUS TpAllocPool(TP_POOL **out, PVOID reserved) */
        TpAllocPool: fn(8, ([out])=>{
            const pool = objects.allocPool();
            if (pool === 0)
            {
                return STATUS.NO_MEMORY;
            }
            write32(out, pool);
            return STATUS.SUCCESS;
        }),
        /** VOID TpReleasePool(TP_POOL *) */
        TpReleasePool: act(4, ([pool])=>objects.releasePool(pool)),
        /** VOID TpSetPoolMaxThreads(TP_POOL *, DWORD) */
        TpSetPoolMaxThreads: act(8, ([pool, max])=>objects.setMax(pool, max)),
        /** NTSTATUS TpSetPoolMinThreads(TP_POOL *, DWORD) */
        TpSetPoolMinThreads: fn(8, ([pool, min])=>
            (objects.setMin(pool, min) ? STATUS.SUCCESS : STATUS.NO_MEMORY)),
        /** NTSTATUS TpSetPoolStackInformation(TP_POOL *, TP_POOL_STACK_INFORMATION *) */
        TpSetPoolStackInformation: fn(8, ([pool, information])=>
            (objects.setStack(pool, information) ? STATUS.SUCCESS : STATUS.INVALID_PARAMETER)),
        /** NTSTATUS TpQueryPoolStackInformation(TP_POOL *, TP_POOL_STACK_INFORMATION *) */
        TpQueryPoolStackInformation: fn(8, ([pool, information])=>
            (objects.queryStack(pool, information) ? STATUS.SUCCESS : STATUS.INVALID_PARAMETER)),

        /** NTSTATUS TpAllocCleanupGroup(TP_CLEANUP_GROUP **out) */
        TpAllocCleanupGroup: fn(4, ([out])=>{
            const group = objects.allocGroup();
            if (group === 0)
            {
                return STATUS.NO_MEMORY;
            }
            write32(out, group);
            return STATUS.SUCCESS;
        }),
        /** VOID TpReleaseCleanupGroup(TP_CLEANUP_GROUP *) */
        TpReleaseCleanupGroup: act(4, ([group])=>objects.releaseGroup(group)),
        /** VOID TpReleaseCleanupGroupMembers(TP_CLEANUP_GROUP *, BOOL cancel, PVOID userdata) */
        TpReleaseCleanupGroupMembers: fn(12, ([group, cancel, userdata])=>
            objects.releaseMembers(group, cancel, userdata)),

        /** NTSTATUS TpAllocWork(TP_WORK **, PTP_WORK_CALLBACK, PVOID, TP_CALLBACK_ENVIRON *) */
        TpAllocWork: alloc('work'),
        /** VOID TpPostWork(TP_WORK *) */
        TpPostWork: act(4, ([work])=>objects.post(work)),
        /** VOID TpWaitForWork(TP_WORK *, BOOL cancel) */
        TpWaitForWork: fn(8, ([work, cancel])=>objects.waitFor(work, cancel)),
        /** VOID TpReleaseWork(TP_WORK *) */
        TpReleaseWork: act(4, ([work])=>objects.close(work)),
        /** NTSTATUS TpSimpleTryPost(PTP_SIMPLE_CALLBACK, PVOID, TP_CALLBACK_ENVIRON *) */
        TpSimpleTryPost: fn(12, ([callback, context, environment])=>
            statusOf(objects.simple(callback, context, environment))),

        /** NTSTATUS TpAllocTimer(TP_TIMER **, PTP_TIMER_CALLBACK, PVOID, TP_CALLBACK_ENVIRON *) */
        TpAllocTimer: alloc('timer'),
        /** VOID TpSetTimer(TP_TIMER *, LARGE_INTEGER *due, LONG period, LONG window) */
        TpSetTimer: act(16, ([timer, due, period])=>objects.setTimer(timer, due, period)),
        /** BOOL TpSetTimerEx(TP_TIMER *, LARGE_INTEGER *, LONG, LONG): whether it was set */
        TpSetTimerEx: fn(16, ([timer, due, period])=>
            (objects.setTimer(timer, due, period) ? 1 : 0)),
        /** BOOL TpIsTimerSet(TP_TIMER *) */
        TpIsTimerSet: fn(4, ([timer])=>(objects.isTimerSet(timer) ? 1 : 0)),
        /** VOID TpWaitForTimer(TP_TIMER *, BOOL cancel) */
        TpWaitForTimer: fn(8, ([timer, cancel])=>objects.waitFor(timer, cancel)),
        /** VOID TpReleaseTimer(TP_TIMER *) */
        TpReleaseTimer: act(4, ([timer])=>objects.close(timer)),

        /** NTSTATUS TpAllocWait(TP_WAIT **, PTP_WAIT_CALLBACK, PVOID, TP_CALLBACK_ENVIRON *) */
        TpAllocWait: alloc('wait'),
        /** VOID TpSetWait(TP_WAIT *, HANDLE, LARGE_INTEGER *timeout) */
        TpSetWait: act(12, ([wait, object, timeout])=>objects.setWait(wait, object, timeout)),
        /** BOOL TpSetWaitEx(TP_WAIT *, HANDLE, LARGE_INTEGER *, PVOID): whether one was under way */
        TpSetWaitEx: fn(16, ([wait, object, timeout])=>
            (objects.setWait(wait, object, timeout) ? 1 : 0)),
        /** VOID TpWaitForWait(TP_WAIT *, BOOL cancel) */
        TpWaitForWait: fn(8, ([wait, cancel])=>objects.waitFor(wait, cancel)),
        /** VOID TpReleaseWait(TP_WAIT *) */
        TpReleaseWait: act(4, ([wait])=>objects.close(wait)),

        /** NTSTATUS TpCallbackMayRunLong(TP_CALLBACK_INSTANCE *) */
        TpCallbackMayRunLong: fn(4, ([instance])=>
            (objects.mayRunLong(instance) ? STATUS.SUCCESS : STATUS_TOO_MANY_THREADS)),
        /** VOID TpCallbackReleaseSemaphoreOnCompletion(TP_CALLBACK_INSTANCE *, HANDLE, DWORD) */
        TpCallbackReleaseSemaphoreOnCompletion: act(12, ([instance, semaphore, count])=>
            onCompletion(instance, 'ReleaseSemaphore', [semaphore >>> 0, count >>> 0, 0])),
        /** VOID TpCallbackSetEventOnCompletion(TP_CALLBACK_INSTANCE *, HANDLE) */
        TpCallbackSetEventOnCompletion: act(8, ([instance, event])=>
            onCompletion(instance, 'SetEvent', [event >>> 0])),
        /** VOID TpCallbackReleaseMutexOnCompletion(TP_CALLBACK_INSTANCE *, HANDLE) */
        TpCallbackReleaseMutexOnCompletion: act(8, ([instance, mutex])=>
            onCompletion(instance, 'ReleaseMutex', [mutex >>> 0])),
        /** VOID TpCallbackLeaveCriticalSectionOnCompletion(TP_CALLBACK_INSTANCE *, RTL_CRITICAL_SECTION *) */
        TpCallbackLeaveCriticalSectionOnCompletion: act(8, ([instance, section])=>
            onCompletion(instance, 'LeaveCriticalSection', [section >>> 0])),
        /** VOID TpCallbackUnloadDllOnCompletion(TP_CALLBACK_INSTANCE *, HMODULE) */
        TpCallbackUnloadDllOnCompletion: act(8, ([instance, module])=>
            onCompletion(instance, 'FreeLibrary', [module >>> 0])),
        /** VOID TpDisassociateCallback(TP_CALLBACK_INSTANCE *) */
        TpDisassociateCallback: act(4, ([instance])=>objects.disassociate(instance)),
    };

    /**
     * A kernel32 answer as a status: nonzero is success; zero is the status
     * its last error is made from.
     *
     * @param {any} answer
     */
    const status = answer=>{
        /** @param {number} value */
        const of = value=>{
            if ((value >>> 0) !== 0)
            {
                return STATUS.SUCCESS;
            }
            return kernel32.GetLastError.handler([]) === ERROR_INVALID_HANDLE
                ? STATUS.INVALID_HANDLE : STATUS.INVALID_PARAMETER;
        };
        return typeof answer?.then === 'function' ? answer.then(of) : of(answer);
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>status(kernel32[name].handler(args));

    return {
        ...tp,
        /** NTSTATUS RtlQueueWorkItem(PRTL_WORK_ITEM_ROUTINE, PVOID Context, ULONG Flags) */
        RtlQueueWorkItem: {
            argBytes: 12,
            handler: (/** @type {number[]} */ args)=>call('QueueUserWorkItem', args),
        },

        /**
         * NTSTATUS RtlRegisterWait(PHANDLE NewWaitObject, HANDLE Object,
         *     RTL_WAITORTIMERCALLBACKFUNC Callback, PVOID Context, ULONG Milliseconds,
         *     ULONG Flags)
         */
        RtlRegisterWait: {
            argBytes: 24,
            handler: (/** @type {number[]} */ args)=>call('RegisterWaitForSingleObject', args),
        },

        /** NTSTATUS RtlDeregisterWait(HANDLE WaitHandle): no event, returning at once. */
        RtlDeregisterWait: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [wait])=>deletions.deregisterWait(wait, 0),
        },

        /** NTSTATUS RtlDeregisterWaitEx(HANDLE WaitHandle, HANDLE CompletionEvent) */
        RtlDeregisterWaitEx: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [wait, event])=>
                deletions.deregisterWait(wait, event),
        },

        /** NTSTATUS RtlCreateTimerQueue(PHANDLE NewTimerQueue) */
        RtlCreateTimerQueue: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [out])=>{
                const queue = kernel32.CreateTimerQueue.handler([]) >>> 0;
                if (queue === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, queue, true);
                writeMemory(out >>> 0, bytes);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlCreateTimer(HANDLE TimerQueue, PHANDLE NewTimer,
         *     RTL_WAITORTIMERCALLBACKFUNC Callback, PVOID Parameter, DWORD DueTime,
         *     DWORD Period, ULONG Flags)
         *
         * CreateTimerQueueTimer's, the queue and the new timer's place the
         * other way round.
         */
        RtlCreateTimer: {
            argBytes: 28,
            handler: (/** @type {number[]} */ [queue, out, ...rest])=>
                call('CreateTimerQueueTimer', [out, queue, ...rest]),
        },

        /** NTSTATUS RtlUpdateTimer(HANDLE TimerQueue, HANDLE Timer, DWORD DueTime, DWORD Period) */
        RtlUpdateTimer: {
            argBytes: 16,
            handler: (/** @type {number[]} */ args)=>call('ChangeTimerQueueTimer', args),
        },

        /** NTSTATUS RtlDeleteTimer(HANDLE TimerQueue, HANDLE Timer, HANDLE CompletionEvent) */
        RtlDeleteTimer: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [, timer, event])=>
                deletions.deleteTimer(timer, event),
        },

        /** NTSTATUS RtlDeleteTimerQueueEx(HANDLE TimerQueue, HANDLE CompletionEvent) */
        RtlDeleteTimerQueueEx: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [queue, event])=>
                deletions.deleteTimerQueue(queue, event),
        },
    };
}

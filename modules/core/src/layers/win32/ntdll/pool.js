/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ntdll's thread pool: work items, waits and timer queues.
 *
 * kernel32's pool calls are these on Windows; here the pool is kernel32's
 * (pool.js), so each is its call with the arguments in ntdll's order and
 * the answer as a status. One pool means a wait registered here is
 * unregistered through UnregisterWait, and a timer made here fires on the
 * same threads as one made through CreateTimerQueueTimer. The deletions are
 * the pool's own, answering statuses (`PoolDeletions`): one that waits for
 * the callbacks wakes its caller with its answer, which no translation
 * here could reach.
 */

import { STATUS } from './status.js';

/** The kernel32 calls these are made of. */
export const POOL_ENTRIES = ['QueueUserWorkItem', 'RegisterWaitForSingleObject',
    'CreateTimerQueue', 'CreateTimerQueueTimer', 'ChangeTimerQueueTimer', 'GetLastError'];

const ERROR_INVALID_HANDLE = 6;

/**
 * The pool's deletions, answered as statuses by the pool itself: a deletion
 * that waits for the callbacks parks its caller, and the caller is woken
 * with its answer, which kernel32's would give as TRUE.
 *
 * @typedef {Object} PoolDeletions
 * @property {(wait: number, event: number) => any} deregisterWait
 * @property {(timer: number, event: number) => any} deleteTimer
 * @property {(queue: number, event: number) => any} deleteTimerQueue
 */

/**
 * @param {{ kernel32: Record<string, { handler: Function }>, deletions: PoolDeletions,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} host
 * @returns {Record<string, { argBytes: number, handler: Function }>}
 */
export function createPoolFunctions({ kernel32, deletions, writeMemory }){
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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The debugger's side of debugging a child: the events a child started with
 * DEBUG_PROCESS or DEBUG_ONLY_THIS_PROCESS reports, each stopping the thread
 * that reported it until the debugger continues it, as Windows' debug object
 * does between a debuggee and its debugger.
 *
 * The child reports an event as values (`DebugReport`) through the way its
 * parent hears from it wherever it runs - on this thread, or in a worker of
 * its own - and waits for the answer: the status ContinueDebugEvent gave.
 * Here each debuggee has a queue; WaitForDebugEvent takes the first event of a
 * debuggee with none outstanding, writes its DEBUG_EVENT with handles opened
 * in this process, and ContinueDebugEvent answers it. A debuggee's exit is
 * reported here when its parent hears of it, and needs no answer.
 */

import { childThread } from './cross-process.js';

/** dwDebugEventCode (winbase.h). */
export const DEBUG_EVENT = /** @type {const} */ ({
    EXCEPTION: 1,
    CREATE_THREAD: 2,
    CREATE_PROCESS: 3,
    EXIT_THREAD: 4,
    EXIT_PROCESS: 5,
    LOAD_DLL: 6,
    UNLOAD_DLL: 7,
    OUTPUT_DEBUG_STRING: 8,
});

/** ContinueDebugEvent's statuses (winnt.h's DBG_*). */
export const DBG_CONTINUE = 0x00010002;
export const DBG_EXCEPTION_NOT_HANDLED = 0x80010001;
const DBG_REPLY_LATER = 0x40010001;
const CONTINUE_STATUSES = new Set([DBG_CONTINUE, 0x00010001, DBG_EXCEPTION_NOT_HANDLED,
    0x40010003, 0x40010004]);

/** A 32-bit DEBUG_EVENT: code, process and thread ids, then the union. */
const DEBUG_EVENT_SIZE = 96;
const UNION = 12;
/** EXCEPTION_RECORD's size, after which EXCEPTION_DEBUG_INFO keeps dwFirstChance. */
const EXCEPTION_RECORD_SIZE = 80;
const EXCEPTION_MAXIMUM_PARAMETERS = 15;

const INFINITE = 0xffffffff;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_SEM_TIMEOUT = 121;

/**
 * An event as a debuggee reports it: values only, since it may come from
 * another thread. `exception` for EXCEPTION, `base` for a library's, `start`
 * for a thread's or the process's first address, `string` for
 * OUTPUT_DEBUG_STRING (the debuggee's address, its length in characters, and
 * whether it is UTF-16), `exitCode` for EXIT_THREAD.
 *
 * @typedef {{ code: number, threadId: number,
 *     exception?: { code: number, flags: number, address: number, parameters: number[],
 *         firstChance: boolean },
 *     base?: number, start?: number, exitCode?: number,
 *     string?: { address: number, length: number, unicode: boolean } }} DebugReport
 */

/**
 * The record of a debuggee its debugger keeps: what it reported and was not
 * yet taken, and the one taken and not yet continued.
 *
 * @typedef {{ events: { report: DebugReport, answer: (status: number) => void }[],
 *     current: { report: DebugReport, answer: (status: number) => void } | null,
 *     onlyThis: boolean, killOnExit: boolean }} Debuggee
 */

/**
 * A debuggee's record for a child started with these CreateProcess flags;
 * null when it is not debugged.
 *
 * @param {number} flags
 * @returns {Debuggee | null}
 */
export function debuggeeFor(flags){
    const DEBUG_PROCESS = 0x1;
    const DEBUG_ONLY_THIS_PROCESS = 0x2;
    if ((flags & (DEBUG_PROCESS | DEBUG_ONLY_THIS_PROCESS)) === 0)
    {
        return null;
    }
    return { events: [], current: null, onlyThis: (flags & DEBUG_PROCESS) === 0,
        killOnExit: true };
}

/**
 * The 32-bit CONTEXT's groups by flag, as the byte ranges each fills.
 * Copying a group is copying its range: what a debugger's SetThreadContext
 * on a thread stopped at an exception does to the context the thread goes on
 * from.
 */
const CONTEXT_GROUPS = /** @type {const} */ ([
    [0x10010, 0x04, 0x1c], // CONTEXT_DEBUG_REGISTERS
    [0x10008, 0x1c, 0x8c], // CONTEXT_FLOATING_POINT
    [0x10004, 0x8c, 0x9c], // CONTEXT_SEGMENTS
    [0x10002, 0x9c, 0xb4], // CONTEXT_INTEGER
    [0x10001, 0xb4, 0xcc], // CONTEXT_CONTROL
    [0x10020, 0xcc, 0x2cc], // CONTEXT_EXTENDED_REGISTERS
]);

/**
 * Copies the groups `given`'s flags name from one 32-bit CONTEXT to another,
 * the rest of `into` left as it was.
 *
 * @param {Uint8Array} into @param {Uint8Array} given
 */
export function mergeContextGroups(into, given){
    const flags = new DataView(given.buffer, given.byteOffset, 4).getUint32(0, true);
    for (const [group, from, to] of CONTEXT_GROUPS)
    {
        if ((flags & group) === group)
        {
            into.set(given.subarray(from, to), from);
        }
    }
}

/**
 * @typedef {Object} DebuggerHost
 * @property {any} kernel
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} [setLastError]
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 * @property {() => any} currentThread
 * @property {(thread: any) => Promise<number> | number} park
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ major: number, build: number }} [windows]
 */

/**
 * @param {DebuggerHost} host
 */
export function createDebuggerFunctions(host){
    const { kernel } = host;
    /** The threads waiting in WaitForDebugEvent, with where each wants its event. */
    /** @type {{ thread: any, out: number }[]} */
    let waiting = [];

    // A WaitForDebugEvent that ran out of time hears nothing more and says
    // ERROR_SEM_TIMEOUT.
    kernel.onTimeout?.((/** @type {any} */ thread)=>{
        const before = waiting.length;
        waiting = waiting.filter(waiter=>waiter.thread !== thread);
        if (waiting.length < before)
        {
            host.setLastErrorFor?.(thread, ERROR_SEM_TIMEOUT);
        }
    });

    /** @returns {any[]} */
    const debuggees = ()=>(kernel.processes?.all() ?? []).filter(
        (/** @type {any} */ child)=>child.debugged);

    /**
     * The handle a thread of a debuggee is handed to its debugger by.
     *
     * @param {any} child @param {number} threadId
     */
    const threadHandle = (child, threadId)=>
        kernel.handles.open('process-thread', childThread(child, threadId));

    /**
     * Writes a debuggee's event as DEBUG_EVENT at `out`, opening here the
     * handles it carries.
     *
     * @param {number} out @param {any} child @param {DebugReport} report
     */
    const writeEvent = (out, child, report)=>{
        const bytes = new Uint8Array(DEBUG_EVENT_SIZE);
        const view = new DataView(bytes.buffer);
        /** @param {number} at @param {number} value */
        const put = (at, value)=>view.setUint32(UNION + at, value >>> 0, true);
        view.setUint32(0, report.code, true);
        view.setUint32(4, child.id >>> 0, true);
        view.setUint32(8, report.threadId >>> 0, true);
        switch (report.code)
        {
            case DEBUG_EVENT.EXCEPTION: {
                const exception = /** @type {NonNullable<DebugReport['exception']>} */ (
                    report.exception);
                const parameters = exception.parameters.slice(0, EXCEPTION_MAXIMUM_PARAMETERS);
                put(0, exception.code);
                put(4, exception.flags);
                put(12, exception.address);
                put(16, parameters.length);
                parameters.forEach((value, index)=>put(20 + index * 4, value));
                put(EXCEPTION_RECORD_SIZE, exception.firstChance ? 1 : 0);
                break;
            }
            case DEBUG_EVENT.CREATE_THREAD:
                put(0, threadHandle(child, report.threadId));
                put(8, report.start ?? 0);
                break;
            case DEBUG_EVENT.CREATE_PROCESS:
            // No file is handed over (hFile NULL, which the structure allows);
            // the process and thread are handles of the debugger's own.
                put(4, kernel.handles.open('process', child));
                put(8, threadHandle(child, report.threadId));
                put(12, report.base ?? 0);
                put(28, report.start ?? 0);
                break;
            case DEBUG_EVENT.EXIT_THREAD:
            case DEBUG_EVENT.EXIT_PROCESS:
                put(0, report.exitCode ?? 0);
                break;
            case DEBUG_EVENT.LOAD_DLL:
                put(4, report.base ?? 0);
                break;
            case DEBUG_EVENT.UNLOAD_DLL:
                put(0, report.base ?? 0);
                break;
            case DEBUG_EVENT.OUTPUT_DEBUG_STRING:
                put(0, report.string?.address ?? 0);
                view.setUint16(UNION + 4, report.string?.unicode ? 1 : 0, true);
                view.setUint16(UNION + 6, Math.min(report.string?.length ?? 0, 0xffff), true);
                break;
            default:
                break;
        }
        host.writeMemory(out >>> 0, bytes);
    };

    /**
     * The first event of a debuggee with none outstanding, made its
     * outstanding one; null when there is none to take.
     */
    const take = ()=>{
        for (const child of debuggees())
        {
            const { debugged } = child;
            if (debugged.current === null && debugged.events.length > 0)
            {
                debugged.current = debugged.events.shift();
                return { child, report: debugged.current.report };
            }
        }
        return null;
    };

    /** Hands the events there are to the threads waiting for one. */
    const serve = ()=>{
        while (waiting.length > 0)
        {
            const taken = take();
            if (!taken)
            {
                return;
            }
            const waiter = /** @type {{ thread: any, out: number }} */ (waiting.shift());
            writeEvent(waiter.out, taken.child, taken.report);
            kernel.wake(waiter.thread, 1);
        }
    };

    /**
     * A debuggee's event, queued for its debugger; answered with the status
     * the debugger continues it with.
     *
     * @param {any} child @param {DebugReport} report
     * @returns {Promise<number>}
     */
    const deliver = (child, report)=>{
        if (!child.debugged)
        {
            return Promise.resolve(DBG_CONTINUE);
        }
        return new Promise(answer=>{
            child.debugged.events.push({ report, answer });
            serve();
        });
    };

    return {
        deliver,

        /**
         * A debuggee has exited: its exit is the last event it reports.
         *
         * @param {any} child
         */
        exited(child){
            if (child.debugged)
            {
                child.debugged.events.push({ report: { code: DEBUG_EVENT.EXIT_PROCESS,
                    threadId: child.threadId >>> 0, exitCode: child.exitCode >>> 0 },
                answer: ()=>{
                    child.debugged = null;
                } });
                serve();
            }
        },

        functions: {
            /**
             * BOOL WaitForDebugEvent(LPDEBUG_EVENT lpDebugEvent, DWORD dwMilliseconds)
             *
             * The next event of a debuggee with none outstanding, waited for
             * as long as asked. Nothing within the time answers
             * ERROR_SEM_TIMEOUT.
             */
            WaitForDebugEvent: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([out, timeout])=>{
                    const taken = (out >>> 0) === 0 ? null : take();
                    if (taken)
                    {
                        writeEvent(out >>> 0, taken.child, taken.report);
                        return 1;
                    }
                    if ((out >>> 0) === 0 || (timeout >>> 0) === 0 || debuggees().length === 0)
                    {
                        host.setLastError?.(ERROR_SEM_TIMEOUT);
                        return 0;
                    }
                    const thread = host.currentThread();
                    waiting.push({ thread, out: out >>> 0 });
                    kernel.block(thread, 'debug event',
                        (timeout >>> 0) === INFINITE ? undefined
                            : { deadline: kernel.clock.virtualTime() + (timeout >>> 0),
                                result: 0 });
                    return host.park(thread);
                },
            },

            /**
             * BOOL ContinueDebugEvent(DWORD dwProcessId, DWORD dwThreadId,
             *     DWORD dwContinueStatus)
             *
             * Lets the debuggee's thread that reported the outstanding event
             * go on with the status. A status that is none of winnt.h's DBG_*
             * is a bad parameter, and so is DBG_REPLY_LATER before Windows
             * 10's 1709, which brought it; after, it is taken as DBG_CONTINUE
             * and that is said. No outstanding event of that process and
             * thread is a bad parameter too.
             */
            ContinueDebugEvent: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([processId, threadId, status])=>{
                    let value = status >>> 0;
                    if (value === DBG_REPLY_LATER
                        && (host.windows?.major ?? 0) >= 10 && (host.windows?.build ?? 0) >= 16299)
                    {
                        host.divergence?.('ContinueDebugEvent',
                            'DBG_REPLY_LATER: the event is not reported again');
                        value = DBG_CONTINUE;
                    }
                    else if (!CONTINUE_STATUSES.has(value))
                    {
                        host.setLastError?.(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    const child = debuggees().find(each=>(each.id >>> 0) === (processId >>> 0)
                        && each.debugged.current?.report.threadId === (threadId >>> 0));
                    if (!child)
                    {
                        host.setLastError?.(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    const { answer } = child.debugged.current;
                    child.debugged.current = null;
                    answer(value);
                    serve();
                    return 1;
                },
            },

            /**
             * BOOL DebugActiveProcessStop(DWORD dwProcessId)
             *
             * A debuggee stops reporting and goes on: what it reported and
             * was not continued is continued. A process not debugged here is
             * refused as one with no debug object between them, an id naming
             * no process as a bad parameter.
             */
            DebugActiveProcessStop: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([id])=>{
                    const child = (kernel.processes?.all() ?? []).find(
                        (/** @type {any} */ made)=>(made.id >>> 0) === (id >>> 0));
                    if (!child)
                    {
                        host.setLastError?.(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    if (!child.debugged)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    const { current, events } = child.debugged;
                    child.debugged = null;
                    for (const each of [...current ? [current] : [], ...events])
                    {
                        each.answer(DBG_CONTINUE);
                    }
                    return 1;
                },
            },

            /**
             * BOOL DebugSetProcessKillOnExit(BOOL KillOnExit)
             *
             * Whether the debuggees end when their debugger does. A caller
             * debugging none has no debug object to set it on and is refused
             * as such. Kept on each; a debuggee here ends with its debugger
             * either way, as a child running beside its parent does.
             */
            DebugSetProcessKillOnExit: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([kill])=>{
                    const debugged = debuggees();
                    if (debugged.length === 0)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    for (const child of debugged)
                    {
                        child.debugged.killOnExit = (kill >>> 0) !== 0;
                    }
                    return 1;
                },
            },
        },
    };
}

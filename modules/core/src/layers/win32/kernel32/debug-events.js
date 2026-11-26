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
 * Here each debuggee has a queue and the debug object it reports to. A wait
 * through a debug object - NtWaitForDebugEvent, DbgUiWaitStateChange on the
 * calling thread's, WaitForDebugEvent through it - takes the first event of
 * one of that object's debuggees with none outstanding, as the state change
 * Windows' kernel hands out (DBGUI_WAIT_STATE_CHANGE, with handles opened in
 * this process); WaitForDebugEvent writes it as DEBUG_EVENT through the one
 * conversion DbgUiConvertStateChangeStructure makes. A continue through the
 * same object (NtDebugContinue, DbgUiContinue, ContinueDebugEvent) answers
 * it. A debuggee's exit is reported here when its parent hears of it, and
 * needs no answer.
 */

import { DEBUG_ATTACH, DEBUG_BREAK, askChild, childThread } from './cross-process.js';
import { untagged } from './handle-tags.js';
import { dueInMs, readLargeInteger } from './due-time.js';
import { wholeAddress } from '../common/pointers.js';

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

/**
 * A 32-bit DBGUI_WAIT_STATE_CHANGE: its state, the client id, then the union,
 * of which DBGKM_EXCEPTION (the record and FirstChance) is the largest.
 */
const STATE_CHANGE_SIZE = 96;
/** DBG_STATE (ntdbg.h). */
const DBG_STATE = /** @type {const} */ ({
    CREATE_THREAD: 2,
    CREATE_PROCESS: 3,
    EXIT_THREAD: 4,
    EXIT_PROCESS: 5,
    EXCEPTION: 6,
    BREAKPOINT: 7,
    SINGLE_STEP: 8,
    LOAD_DLL: 9,
    UNLOAD_DLL: 10,
});
const STATUS_BREAKPOINT = 0x80000003;
const STATUS_SINGLE_STEP = 0x80000004;
/** The exceptions OutputDebugString raises, which the conversion makes its event. */
const DBG_PRINTEXCEPTION_C = 0x40010006;
const DBG_PRINTEXCEPTION_WIDE_C = 0x4001000a;
const STATUS_TIMEOUT = 0x102;
const STATUS_UNSUCCESSFUL = 0xc0000001;

const INFINITE = 0xffffffff;
/** GetCurrentProcess()'s pseudo-handle. */
const OWN_PROCESS = 0xffffffff;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_SEM_TIMEOUT = 121;
const STATUS_SUCCESS = 0;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_ACCESS_DENIED = 0xc0000022;
/** NtRemoveProcessDebug's answer for a process its debug object does not debug. */
const STATUS_PORT_NOT_SET = 0xc0000353;
/** NtCreateDebugObject's one flag, and its information class. */
const DEBUG_KILL_ON_CLOSE = 1;
const DEBUG_OBJECT_KILL_PROCESS_ON_EXIT_INFORMATION = 1;
/** The code a debuggee ends with when its debugger ends and takes it along. */
const STATUS_DEBUGGER_INACTIVE = 0xc0000354;

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
 *     onlyThis: boolean, object: DebugObject }} Debuggee
 */

/**
 * A debug object, what Windows' kernel keeps between a debugger and its
 * debuggees: whether they end when the last handle to it closes
 * (DEBUG_KILL_ON_CLOSE) or are let go. A thread debugs through the one its
 * thread block names (DbgUiGetThreadDebugObject), made when it first
 * debugs (DbgUiConnectToDbg).
 *
 * @typedef {{ killOnClose: boolean }} DebugObject
 */

/**
 * A debuggee's record for a child started with these CreateProcess flags;
 * null when it is not debugged.
 *
 * @param {number} flags
 * @param {() => DebugObject} [objectOf]  The caller's debug object, made if it
 *        has none: asked only for a child that is debugged.
 * @returns {Debuggee | null}
 */
export function debuggeeFor(flags, objectOf = ()=>({ killOnClose: true })){
    const DEBUG_PROCESS = 0x1;
    const DEBUG_ONLY_THIS_PROCESS = 0x2;
    if ((flags & (DEBUG_PROCESS | DEBUG_ONLY_THIS_PROCESS)) === 0)
    {
        return null;
    }
    return { events: [], current: null, onlyThis: (flags & DEBUG_PROCESS) === 0,
        object: objectOf() };
}

/**
 * What a process a debugger attaches to tells it at once, as Windows' kernel
 * makes it up for a process already running: its creation on its first
 * thread, ntdll, a creation for each of its other threads, then each library
 * it has loaded (DebugActiveProcess, `debugger.c`'s process_attach_events).
 *
 * @param {{ mainThreadId: number, image: { base: number, start: number },
 *     ntdll: number, libraries: number[], threads: number[] }} process
 *     `libraries` the bases of the rest, `threads` the ids of the others
 * @returns {DebugReport[]}
 */
export function attachEvents({ mainThreadId, image, ntdll, libraries, threads }){
    const threadId = wholeAddress(mainThreadId);
    return [
        { code: DEBUG_EVENT.CREATE_PROCESS, threadId, base: image.base, start: image.start },
        ...ntdll ? [{ code: DEBUG_EVENT.LOAD_DLL, threadId, base: ntdll }] : [],
        ...threads.filter(id=>(id >>> 0) !== threadId).map(id=>(
            { code: DEBUG_EVENT.CREATE_THREAD, threadId: id >>> 0 })),
        ...libraries.filter(base=>base !== ntdll && base !== image.base).map(base=>(
            { code: DEBUG_EVENT.LOAD_DLL, threadId, base })),
    ];
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
 * A 32-bit DBGUI_WAIT_STATE_CHANGE as the DEBUG_EVENT it stands for
 * (DbgUiConvertStateChangeStructure): the exception OutputDebugString raises
 * becomes OUTPUT_DEBUG_STRING_EVENT, a breakpoint and a single step are
 * exceptions again; null for a state that is no event.
 *
 * @param {Uint8Array} state
 * @returns {Uint8Array | null}
 */
function convertStateChange(state){
    const from = new DataView(state.buffer, state.byteOffset, STATE_CHANGE_SIZE);
    const event = new Uint8Array(DEBUG_EVENT_SIZE);
    const to = new DataView(event.buffer);
    /** @param {number} at */
    const read = at=>from.getUint32(UNION + at, true);
    /** @param {number} at @param {number} value */
    const put = (at, value)=>to.setUint32(UNION + at, value >>> 0, true);
    to.setUint32(4, from.getUint32(4, true), true);
    to.setUint32(8, from.getUint32(8, true), true);
    switch (from.getUint32(0, true))
    {
        case DBG_STATE.CREATE_THREAD:
            to.setUint32(0, DEBUG_EVENT.CREATE_THREAD, true);
            put(0, read(0));
            put(8, read(8));
            break;
        case DBG_STATE.CREATE_PROCESS:
            to.setUint32(0, DEBUG_EVENT.CREATE_PROCESS, true);
            put(0, read(12));
            put(4, read(0));
            put(8, read(4));
            put(12, read(16));
            put(16, read(20));
            put(20, read(24));
            put(28, read(32));
            break;
        case DBG_STATE.EXIT_THREAD:
        case DBG_STATE.EXIT_PROCESS:
            to.setUint32(0, from.getUint32(0, true) === DBG_STATE.EXIT_THREAD
                ? DEBUG_EVENT.EXIT_THREAD : DEBUG_EVENT.EXIT_PROCESS, true);
            put(0, read(0));
            break;
        case DBG_STATE.LOAD_DLL:
            to.setUint32(0, DEBUG_EVENT.LOAD_DLL, true);
            put(0, read(0));
            put(4, read(4));
            put(8, read(8));
            put(12, read(12));
            put(16, read(16));
            break;
        case DBG_STATE.UNLOAD_DLL:
            to.setUint32(0, DEBUG_EVENT.UNLOAD_DLL, true);
            put(0, read(0));
            break;
        case DBG_STATE.EXCEPTION:
        case DBG_STATE.BREAKPOINT:
        case DBG_STATE.SINGLE_STEP: {
            const code = read(0);
            if (code === DBG_PRINTEXCEPTION_C || code === DBG_PRINTEXCEPTION_WIDE_C)
            {
                to.setUint32(0, DEBUG_EVENT.OUTPUT_DEBUG_STRING, true);
                put(0, read(24));
                to.setUint16(UNION + 4, code === DBG_PRINTEXCEPTION_WIDE_C ? 1 : 0, true);
                to.setUint16(UNION + 6, Math.min(read(20), 0xffff), true);
                break;
            }
            to.setUint32(0, DEBUG_EVENT.EXCEPTION, true);
            event.set(state.subarray(UNION, UNION + EXCEPTION_RECORD_SIZE + 4), UNION);
            break;
        }
        default:
            return null;
    }
    return event;
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
 * @property {number} [processId]  This process's id.
 * @property {import('./cross-process.js').AskHost['askChild']} [askChild]
 *           A call made in a child, where the debugger reaches it.
 * @property {() => boolean} [debugged]  Whether a debugger hears this process now.
 * @property {() => number} [breakIn]  This process breaks into its own debugger:
 *           a thread of its own runs DbgBreakPoint.
 * @property {(child: any, code: number) => boolean} [terminateChild]  Ends a child
 *           where it runs, as TerminateProcess does.
 * @property {{ get: () => number, set: (handle: number) => void }} [threadDebugObject]
 *           The debug object handle the calling thread's block keeps.
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 */

/**
 * @param {DebuggerHost} host
 */
export function createDebuggerFunctions(host){
    const { kernel } = host;
    /**
     * The threads waiting on a debug object, each with how its event is
     * written and what it wakes with; `win32` for WaitForDebugEvent, which
     * says a time-out as ERROR_SEM_TIMEOUT.
     *
     * @type {{ thread: any, object: DebugObject,
     *     write: (state: Uint8Array) => void, woken: number, win32: boolean }[]}
     */
    let waiting = [];

    // A wait that ran out of time hears nothing more: WaitForDebugEvent says
    // ERROR_SEM_TIMEOUT, the native wait answers STATUS_TIMEOUT.
    kernel.onTimeout?.((/** @type {any} */ thread)=>{
        const gone = waiting.find(waiter=>waiter.thread === thread);
        waiting = waiting.filter(waiter=>waiter.thread !== thread);
        if (gone?.win32)
        {
            host.setLastErrorFor?.(thread, ERROR_SEM_TIMEOUT);
        }
    });

    /** @param {number} id @returns {any} the child of that id the kernel knows */
    const processOf = id=>(kernel.processes?.all() ?? []).find(
        (/** @type {any} */ made)=>(made.id >>> 0) === (id >>> 0)) ?? null;

    /**
     * A call made in a child, answered on the calling thread; null where the
     * child cannot be asked.
     *
     * @param {any} child @param {string} call
     */
    const ask = (child, call)=>(host.setLastErrorFor ? askChild({ askChild: host.askChild,
        writeMemory: host.writeMemory, currentThread: host.currentThread,
        setLastErrorFor: host.setLastErrorFor }, child, { call, args: [] }, []) : null);

    /** @returns {any[]} */
    const debuggees = ()=>(kernel.processes?.all() ?? []).filter(
        (/** @type {any} */ child)=>child.debugged);

    /**
     * The debug object a handle names; null for none.
     *
     * @param {number} handle @returns {DebugObject | null}
     */
    const objectOf = handle=>{
        const plain = untagged(handle >>> 0);
        return plain !== 0 && kernel.handles.typeOf?.(plain) === 'debug-object'
            ? kernel.handles.resolve(plain) : null;
    };

    /** @returns {DebugObject | null} the calling thread's */
    const threadObject = ()=>objectOf(host.threadDebugObject?.get() ?? 0);

    /**
     * The calling thread's debug object, made - set to end its debuggees with
     * it - when it has none (DbgUiConnectToDbg).
     *
     * @returns {DebugObject}
     */
    const connect = ()=>{
        const held = threadObject();
        if (held)
        {
            return held;
        }
        /** @type {DebugObject} */
        const made = { killOnClose: true };
        host.threadDebugObject?.set(kernel.handles.open('debug-object', made));
        return made;
    };

    /**
     * A debuggee is let go, what it reported continued: ended with
     * STATUS_DEBUGGER_INACTIVE when `end` says so - its debugger gone and its
     * debug object set to end it - else going on, as DebugActiveProcessStop
     * lets one go.
     *
     * @param {any} child @param {boolean} end
     */
    const release = (child, end)=>{
        const { current, events } = child.debugged;
        child.debugged = null;
        for (const each of [...current ? [current] : [], ...events])
        {
            each.answer(DBG_CONTINUE);
        }
        if (end && !host.terminateChild?.(child, STATUS_DEBUGGER_INACTIVE))
        {
            host.divergence?.('debug object',
                `debuggee ${child.id} could not be ended with its debugger, and goes on`);
        }
    };

    /** @param {any} child */
    const debuggerGone = child=>release(child, child.debugged.object.killOnClose);

    /**
     * Attaches a running child to a debug object (DebugActiveProcess,
     * NtDebugActiveProcess): it is debugged from now, tells at once what it
     * already is (`attachEvents`) and breaks in on a thread of its own. Only
     * a child the debugger hears can be attached to - one run beside it.
     *
     * @param {any} child @param {DebugObject} object
     * @returns {Promise<number> | number} 1, or 0 with ERROR_ACCESS_DENIED set
     */
    const attach = (child, object)=>{
        if (child.debugged || kernel.processes?.finished?.(child))
        {
            host.setLastError?.(ERROR_ACCESS_DENIED);
            return 0;
        }
        child.debugged = { events: [], current: null, onlyThis: true, object };
        const asked = ask(child, DEBUG_ATTACH);
        if (asked === null)
        {
            child.debugged = null;
            host.setLastError?.(ERROR_ACCESS_DENIED);
            return 0;
        }
        return asked.then(result=>{
            if (result === 0)
            {
                child.debugged = null;
                return result;
            }
            // Attached, its NoDebugInherit is set, and stays so after a
            // detach (ProcessDebugFlags).
            child.noDebugInherit = true;
            return result;
        });
    };

    /** @param {Promise<number> | number} attached @returns {Promise<number>} */
    const attachStatus = attached=>Promise.resolve(attached).then(result=>(result === 0
        ? STATUS_ACCESS_DENIED : STATUS_SUCCESS));

    /** @param {number} handle @returns {any} the process a handle names, or null */
    const processHandle = handle=>{
        const plain = untagged(handle >>> 0);
        return kernel.handles.typeOf?.(plain) === 'process' ? kernel.handles.resolve(plain) : null;
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(wholeAddress(address), bytes);
    };

    /**
     * The handle a thread of a debuggee is handed to its debugger by.
     *
     * @param {any} child @param {number} threadId
     */
    const threadHandle = (child, threadId)=>
        kernel.handles.open('process-thread', childThread(child, threadId));

    /**
     * A debuggee's event as the state change a wait through its debug object
     * hands out (DBGUI_WAIT_STATE_CHANGE), opening here the handles it
     * carries. OutputDebugString's string is the exception it raises.
     *
     * @param {any} child @param {DebugReport} report
     * @returns {Uint8Array}
     */
    const stateChangeOf = (child, report)=>{
        const bytes = new Uint8Array(STATE_CHANGE_SIZE);
        const view = new DataView(bytes.buffer);
        /** @param {number} at @param {number} value */
        const put = (at, value)=>view.setUint32(UNION + at, value >>> 0, true);
        /** @param {number} value */
        const state = value=>view.setUint32(0, value, true);
        view.setUint32(4, child.id >>> 0, true);
        view.setUint32(8, report.threadId >>> 0, true);
        switch (report.code)
        {
            case DEBUG_EVENT.EXCEPTION: {
                const exception = /** @type {NonNullable<DebugReport['exception']>} */ (
                    report.exception);
                const parameters = exception.parameters.slice(0, EXCEPTION_MAXIMUM_PARAMETERS);
                const code = exception.code >>> 0;
                state(code === STATUS_BREAKPOINT ? DBG_STATE.BREAKPOINT
                    : code === STATUS_SINGLE_STEP ? DBG_STATE.SINGLE_STEP : DBG_STATE.EXCEPTION);
                put(0, code);
                put(4, exception.flags);
                put(12, exception.address);
                put(16, parameters.length);
                parameters.forEach((value, index)=>put(20 + index * 4, value));
                put(EXCEPTION_RECORD_SIZE, exception.firstChance ? 1 : 0);
                break;
            }
            case DEBUG_EVENT.OUTPUT_DEBUG_STRING:
                state(DBG_STATE.EXCEPTION);
                put(0, report.string?.unicode ? DBG_PRINTEXCEPTION_WIDE_C : DBG_PRINTEXCEPTION_C);
                put(16, 2);
                put(20, report.string?.length ?? 0);
                put(24, report.string?.address ?? 0);
                put(EXCEPTION_RECORD_SIZE, 1);
                break;
            case DEBUG_EVENT.CREATE_THREAD:
                state(DBG_STATE.CREATE_THREAD);
                put(0, threadHandle(child, report.threadId));
                put(8, report.start ?? 0);
                break;
            case DEBUG_EVENT.CREATE_PROCESS:
                // No file is handed over (FileHandle NULL, which the
                // structure allows); the process and thread are handles of
                // the debugger's own.
                state(DBG_STATE.CREATE_PROCESS);
                put(0, kernel.handles.open('process', child));
                put(4, threadHandle(child, report.threadId));
                put(16, report.base ?? 0);
                put(32, report.start ?? 0);
                break;
            case DEBUG_EVENT.EXIT_THREAD:
            case DEBUG_EVENT.EXIT_PROCESS:
                state(report.code === DEBUG_EVENT.EXIT_THREAD ? DBG_STATE.EXIT_THREAD
                    : DBG_STATE.EXIT_PROCESS);
                put(0, report.exitCode ?? 0);
                break;
            case DEBUG_EVENT.LOAD_DLL:
                state(DBG_STATE.LOAD_DLL);
                put(4, report.base ?? 0);
                break;
            case DEBUG_EVENT.UNLOAD_DLL:
                state(DBG_STATE.UNLOAD_DLL);
                put(0, report.base ?? 0);
                break;
            default:
                break;
        }
        return bytes;
    };

    /**
     * The first event of one of a debug object's debuggees with none
     * outstanding, made its outstanding one, as its state change; null when
     * there is none to take.
     *
     * @param {DebugObject} object
     */
    const take = object=>{
        for (const child of debuggees())
        {
            const { debugged } = child;
            if (debugged.object === object && debugged.current === null
                && debugged.events.length > 0)
            {
                debugged.current = debugged.events.shift();
                return stateChangeOf(child, debugged.current.report);
            }
        }
        return null;
    };

    /** Hands the events there are to the threads waiting for one. */
    const serve = ()=>{
        for (const waiter of [...waiting])
        {
            const state = take(waiter.object);
            if (state)
            {
                waiting = waiting.filter(each=>each !== waiter);
                waiter.write(state);
                kernel.wake(waiter.thread, waiter.woken);
            }
        }
    };

    /**
     * Waits through a debug object for its next event, written by `write`:
     * at once when there is one, else for as long as `timeout` (milliseconds,
     * INFINITE for ever) allows.
     *
     * @param {DebugObject} object @param {number} timeout
     * @param {(state: Uint8Array) => void} write
     * @param {{ woken: number, expired: number, win32: boolean }} answers
     *        what the wait answers with an event and without one
     * @returns {number | Promise<number>}
     */
    const waitOn = (object, timeout, write, { woken, expired, win32 })=>{
        const state = take(object);
        if (state)
        {
            write(state);
            return woken;
        }
        if (timeout === 0)
        {
            if (win32)
            {
                host.setLastError?.(ERROR_SEM_TIMEOUT);
            }
            return expired;
        }
        const thread = host.currentThread();
        waiting.push({ thread, object, write, woken, win32 });
        kernel.block(thread, 'debug event', timeout === INFINITE ? undefined
            : { deadline: kernel.clock.virtualTime() + timeout, result: expired });
        return host.park(thread);
    };

    /**
     * Continues the outstanding event of a debuggee of `object` that this
     * process and thread reported, with `status`; false when there is none.
     *
     * @param {DebugObject} object @param {number} processId @param {number} threadId
     * @param {number} status
     */
    const continueEvent = (object, processId, threadId, status)=>{
        const child = debuggees().find(each=>each.debugged.object === object
            && (each.id >>> 0) === (processId >>> 0)
            && each.debugged.current?.report.threadId === (threadId >>> 0));
        if (!child)
        {
            return false;
        }
        const { answer } = child.debugged.current;
        child.debugged.current = null;
        answer(status);
        serve();
        return true;
    };

    /** @param {number} address @param {number} length */
    const read = (address, length)=>/** @type {NonNullable<DebuggerHost['readMemory']>} */ (
        host.readMemory)(address >>> 0, length).slice();

    /**
     * A native timeout (a LARGE_INTEGER, NULL for none) in milliseconds.
     *
     * @param {number} pointer
     */
    const timeoutAt = pointer=>((pointer >>> 0) === 0 ? INFINITE
        : Math.min(Math.ceil(dueInMs(readLargeInteger(read, pointer),
            kernel.clock.wallClock?.() ?? 0)), INFINITE - 1));

    /**
     * NtWaitForDebugEvent's wait, on a debug object: STATUS_SUCCESS with the
     * state change written, STATUS_TIMEOUT when none came in time. An
     * alertable wait waits as one that is not, which is said.
     *
     * @param {DebugObject} object @param {number} alertable @param {number} timeout
     * @param {number} out
     */
    const nativeWait = (object, alertable, timeout, out)=>{
        if ((alertable & 0xff) !== 0)
        {
            host.divergence?.('NtWaitForDebugEvent', 'an alertable wait is not ended by an APC');
        }
        return waitOn(object, timeoutAt(timeout), state=>host.writeMemory(wholeAddress(out), state),
            { woken: STATUS_SUCCESS, expired: STATUS_TIMEOUT, win32: false });
    };

    /**
     * NtDebugContinue's continue, through a debug object, of the event the
     * CLIENT_ID at `client` names.
     *
     * @param {DebugObject} object @param {number} client @param {number} status
     */
    const nativeContinue = (object, client, status)=>{
        if (!CONTINUE_STATUSES.has(status >>> 0) || (client >>> 0) === 0)
        {
            return STATUS_INVALID_PARAMETER;
        }
        const view = new DataView(read(client, 8).buffer);
        return continueEvent(object, view.getUint32(0, true), view.getUint32(4, true),
            status >>> 0) ? STATUS_SUCCESS : STATUS_INVALID_PARAMETER;
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

        /**
         * This process, a debugger, has ended, and every handle to its debug
         * objects with it: each debuggee goes as its debug object says.
         */
        debuggerEnded(){
            debuggees().forEach(debuggerGone);
        },

        /**
         * A handle to a debug object was closed: with the last, its
         * debuggees go as it says.
         *
         * @param {DebugObject} object
         */
        closed(object){
            if (!kernel.handles.holds?.(object))
            {
                debuggees().filter(child=>child.debugged.object === object)
                    .forEach(debuggerGone);
            }
        },

        /** The calling thread's debug object, made if it has none (CreateProcess). */
        connect,

        functions: {
            /**
             * BOOL WaitForDebugEvent(LPDEBUG_EVENT lpDebugEvent, DWORD dwMilliseconds)
             *
             * DbgUiWaitStateChange on the calling thread's debug object, its
             * state change converted to DEBUG_EVENT: the next event of one of
             * that object's debuggees with none outstanding, waited for as
             * long as asked. Nothing within the time answers ERROR_SEM_TIMEOUT;
             * a thread with no debug object has none to wait on.
             */
            WaitForDebugEvent: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([out, timeout])=>{
                    const object = threadObject();
                    if (!object)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    if (wholeAddress(out) === 0)
                    {
                        host.setLastError?.(ERROR_SEM_TIMEOUT);
                        return 0;
                    }
                    return waitOn(object, timeout >>> 0, state=>host.writeMemory(wholeAddress(out),
                        /** @type {Uint8Array} */ (convertStateChange(state))),
                    { woken: 1, expired: 0, win32: true });
                },
            },

            /**
             * BOOL ContinueDebugEvent(DWORD dwProcessId, DWORD dwThreadId,
             *     DWORD dwContinueStatus)
             *
             * DbgUiContinue on the calling thread's debug object: lets the
             * debuggee's thread that reported the outstanding event go on
             * with the status. A status that is none of winnt.h's DBG_* is a
             * bad parameter, and so is DBG_REPLY_LATER before Windows 10's
             * 1709, which brought it; after, it is taken as DBG_CONTINUE and
             * that is said. No outstanding event of that process and thread
             * is a bad parameter too, and a thread with no debug object has
             * none to continue through.
             */
            ContinueDebugEvent: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([processId, threadId, status])=>{
                    let value = wholeAddress(status);
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
                    const object = threadObject();
                    if (!object)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    if (!continueEvent(object, processId, threadId, value))
                    {
                        host.setLastError?.(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    return 1;
                },
            },

            /**
             * BOOL DebugActiveProcess(DWORD dwProcessId)
             *
             * Attaches to a running process: it is debugged from now, tells
             * at once what it already is (`attachEvents`) and breaks in on a
             * thread of its own. Only a child the debugger hears can be
             * attached to - one run beside it; another, as the caller itself,
             * is refused as one it may not debug, and an id naming no process
             * is a bad parameter.
             */
            DebugActiveProcess: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([id])=>{
                    if ((id >>> 0) !== 0 && (id >>> 0) === (host.processId ?? 0) >>> 0)
                    {
                        host.setLastError?.(ERROR_ACCESS_DENIED);
                        return 0;
                    }
                    const child = (id >>> 0) === 0 ? null : processOf(id);
                    if (!child)
                    {
                        host.setLastError?.(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    return attach(child, connect());
                },
            },

            /**
             * BOOL DebugBreakProcess(HANDLE Process)
             *
             * The process breaks into its debugger on a thread of its own, at
             * DbgBreakPoint. Without a debugger Windows' thread ends doing
             * nothing, and the call succeeds either way; a handle that is no
             * process is refused.
             */
            DebugBreakProcess: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>{
                    if ((handle >>> 0) === OWN_PROCESS)
                    {
                        return host.debugged?.() ? host.breakIn?.() ?? 1 : 1;
                    }
                    const plain = untagged(handle >>> 0);
                    const child = kernel.handles.typeOf?.(plain) === 'process'
                        ? kernel.handles.resolve(plain) : null;
                    if (!child)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    if (child.current)
                    {
                        return host.debugged?.() ? host.breakIn?.() ?? 1 : 1;
                    }
                    return child.debugged ? ask(child, DEBUG_BREAK) ?? 1 : 1;
                },
            },

            /**
             * BOOL DebugActiveProcessStop(DWORD dwProcessId)
             *
             * A debuggee stops reporting and goes on: what it reported and
             * was not continued is continued. A process the calling thread's
             * debug object does not debug is refused as one with no debug
             * object between them, an id naming
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
                    if (!child.debugged || child.debugged.object !== threadObject())
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    release(child, false);
                    return 1;
                },
            },

            /**
             * BOOL DebugSetProcessKillOnExit(BOOL KillOnExit)
             *
             * Whether the debuggees end when their debugger does: set on the
             * calling thread's debug object, as NtSetInformationDebugObject
             * sets it. A thread with none has nothing to set it on.
             */
            DebugSetProcessKillOnExit: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([kill])=>{
                    const object = threadObject();
                    if (!object)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    object.killOnClose = (kill >>> 0) !== 0;
                    return 1;
                },
                // The native calls on debug objects, ntdll's, over the same
                // objects and debuggees.
                natives: {
                    /**
                     * NTSTATUS NtCreateDebugObject(PHANDLE DebugObjectHandle,
                     *   ACCESS_MASK, POBJECT_ATTRIBUTES, ULONG Flags)
                     *
                     * DEBUG_KILL_ON_CLOSE is its one flag.
                     */
                    NtCreateDebugObject: {
                        argBytes: 16,
                        /** @param {number[]} args */
                        handler: ([out, , , flags])=>{
                            if (((flags >>> 0) & ~DEBUG_KILL_ON_CLOSE) !== 0)
                            {
                                return STATUS_INVALID_PARAMETER;
                            }
                            if (wholeAddress(out) === 0)
                            {
                                return STATUS_ACCESS_VIOLATION;
                            }
                            writeU32(out, kernel.handles.open('debug-object',
                                { killOnClose: ((flags >>> 0) & DEBUG_KILL_ON_CLOSE) !== 0 }));
                            return STATUS_SUCCESS;
                        },
                    },

                    /**
                     * NTSTATUS NtSetInformationDebugObject(HANDLE DebugObject,
                     *   DEBUGOBJECTINFOCLASS, PVOID, ULONG, PULONG ReturnLength)
                     *
                     * Its one class, DebugObjectKillProcessOnExitInformation: a
                     * ULONG of DEBUG_KILL_ON_CLOSE or 0.
                     */
                    NtSetInformationDebugObject: {
                        argBytes: 20,
                        /** @param {number[]} args */
                        handler: ([handle, kind, info, length, returned])=>{
                            if ((kind >>> 0) !== DEBUG_OBJECT_KILL_PROCESS_ON_EXIT_INFORMATION)
                            {
                                return STATUS_INVALID_PARAMETER;
                            }
                            if ((length >>> 0) !== 4)
                            {
                                if (wholeAddress(returned) !== 0)
                                {
                                    writeU32(returned, 4);
                                }
                                return STATUS_INFO_LENGTH_MISMATCH;
                            }
                            const object = objectOf(handle);
                            if (!object)
                            {
                                return STATUS_INVALID_HANDLE;
                            }
                            const bytes = host.readMemory?.(wholeAddress(info),
                                4) ?? new Uint8Array(4);
                            const value = new DataView(bytes.slice().buffer).getUint32(0, true);
                            if ((value & ~DEBUG_KILL_ON_CLOSE) !== 0)
                            {
                                return STATUS_INVALID_PARAMETER;
                            }
                            object.killOnClose = value !== 0;
                            return STATUS_SUCCESS;
                        },
                    },

                    /** NTSTATUS DbgUiConnectToDbg(void): the thread's debug object, made. */
                    DbgUiConnectToDbg: {
                        argBytes: 0,
                        handler: ()=>{
                            connect();
                            return STATUS_SUCCESS;
                        },
                    },

                    /**
                     * NTSTATUS NtDebugActiveProcess(HANDLE Process, HANDLE DebugObject)
                     *
                     * DebugActiveProcess's attach, on the debug object given.
                     */
                    NtDebugActiveProcess: {
                        argBytes: 8,
                        /** @param {number[]} args */
                        handler: ([process, handle])=>{
                            const object = objectOf(handle);
                            const child = processHandle(process);
                            if (!object)
                            {
                                return STATUS_INVALID_HANDLE;
                            }
                            if (!child)
                            {
                                return (process >>> 0) === OWN_PROCESS ? STATUS_ACCESS_DENIED
                                    : STATUS_INVALID_HANDLE;
                            }
                            return attachStatus(attach(child, object));
                        },
                    },

                    /**
                     * NTSTATUS DbgUiDebugActiveProcess(HANDLE Process)
                     *
                     * NtDebugActiveProcess on the calling thread's debug object;
                     * the attach breaks in.
                     */
                    DbgUiDebugActiveProcess: {
                        argBytes: 4,
                        /** @param {number[]} args */
                        handler: ([process])=>{
                            const child = processHandle(process);
                            return child ? attachStatus(attach(child, connect()))
                                : STATUS_INVALID_HANDLE;
                        },
                    },

                    /**
                     * NTSTATUS NtRemoveProcessDebug(HANDLE Process, HANDLE DebugObject)
                     *
                     * DebugActiveProcessStop on the debug object given: a process
                     * it does not debug has no port to remove.
                     */
                    NtRemoveProcessDebug: {
                        argBytes: 8,
                        /** @param {number[]} args */
                        handler: ([process, handle])=>{
                            const object = objectOf(handle);
                            const child = processHandle(process);
                            if (!object || !child)
                            {
                                return STATUS_INVALID_HANDLE;
                            }
                            if (child.debugged?.object !== object)
                            {
                                return STATUS_PORT_NOT_SET;
                            }
                            release(child, false);
                            return STATUS_SUCCESS;
                        },
                    },

                    /**
                     * NTSTATUS NtWaitForDebugEvent(HANDLE DebugObject, BOOLEAN Alertable,
                     *   PLARGE_INTEGER Timeout, PDBGUI_WAIT_STATE_CHANGE StateChange)
                     */
                    NtWaitForDebugEvent: {
                        argBytes: 16,
                        /** @param {number[]} args */
                        handler: ([handle, alertable, timeout, out])=>{
                            const object = objectOf(handle);
                            return object ? nativeWait(object, alertable, timeout, out)
                                : STATUS_INVALID_HANDLE;
                        },
                    },

                    /**
                     * NTSTATUS DbgUiWaitStateChange(PDBGUI_WAIT_STATE_CHANGE StateChange,
                     *   PLARGE_INTEGER Timeout)
                     *
                     * NtWaitForDebugEvent, alertable, on the calling thread's
                     * debug object.
                     */
                    DbgUiWaitStateChange: {
                        argBytes: 8,
                        /** @param {number[]} args */
                        handler: ([out, timeout])=>{
                            const object = threadObject();
                            return object ? nativeWait(object, 1, timeout, out)
                                : STATUS_INVALID_HANDLE;
                        },
                    },

                    /**
                     * NTSTATUS NtDebugContinue(HANDLE DebugObject, PCLIENT_ID ClientId,
                     *   NTSTATUS ContinueStatus)
                     */
                    NtDebugContinue: {
                        argBytes: 12,
                        /** @param {number[]} args */
                        handler: ([handle, client, status])=>{
                            const object = objectOf(handle);
                            return object ? nativeContinue(object, client, status)
                                : STATUS_INVALID_HANDLE;
                        },
                    },

                    /**
                     * NTSTATUS DbgUiContinue(PCLIENT_ID AppClientId, NTSTATUS ContinueStatus)
                     *
                     * NtDebugContinue through the calling thread's debug object.
                     */
                    DbgUiContinue: {
                        argBytes: 8,
                        /** @param {number[]} args */
                        handler: ([client, status])=>{
                            const object = threadObject();
                            return object ? nativeContinue(object, client, status)
                                : STATUS_INVALID_HANDLE;
                        },
                    },

                    /**
                     * NTSTATUS DbgUiConvertStateChangeStructure(
                     *   PDBGUI_WAIT_STATE_CHANGE StateChange, LPDEBUG_EVENT DebugEvent)
                     *
                     * The state change as the DEBUG_EVENT WaitForDebugEvent
                     * answers (`convertStateChange`); a state that is no event
                     * is unsuccessful.
                     */
                    DbgUiConvertStateChangeStructure: {
                        argBytes: 8,
                        /** @param {number[]} args */
                        handler: ([state, out])=>{
                            const event = convertStateChange(read(state, STATE_CHANGE_SIZE));
                            if (!event)
                            {
                                return STATUS_UNSUCCESSFUL;
                            }
                            host.writeMemory(wholeAddress(out), event);
                            return STATUS_SUCCESS;
                        },
                    },
                },
            },
        },
    };
}

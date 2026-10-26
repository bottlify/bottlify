/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WinEvent hooks: SetWinEventHook, UnhookWinEvent, IsWinEventHookInstalled
 * and NotifyWinEvent, the accessibility half of user32's hooks.
 *
 * Whoever changes something a screen reader would want to hear of -- a
 * control's value, its selection, an item made or destroyed -- raises an
 * event with NotifyWinEvent, and every hook whose filter takes it is called
 * with (hook, event, hwnd, idObject, idChild, idEventThread, dwmsEventTime).
 *
 * Where the callback runs is what the two kinds of hook differ in. An
 * in-context hook (WINEVENT_INCONTEXT) is a procedure in a module mapped into
 * the process that raises the event, so it is called there and then, on the
 * raising thread, before NotifyWinEvent returns. An out-of-context hook runs
 * on the thread that installed it, and the event waits for that thread's
 * next look at its messages -- even when that thread raised it, which is
 * how Wine's tests find Windows: the in-context hook has heard the event
 * when NotifyWinEvent returns, the out-of-context one only after a
 * PeekMessage.
 *
 * The thread an event is reported from, and the one a hook's thread filter
 * is compared with, is the thread that owns the window the event is about;
 * for an event about no window of this process it is the raising thread.
 */

import { threadIdOf } from './messages.js';

export const WINEVENT_OUTOFCONTEXT = 0x0000;
export const WINEVENT_SKIPOWNTHREAD = 0x0001;
export const WINEVENT_SKIPOWNPROCESS = 0x0002;
export const WINEVENT_INCONTEXT = 0x0004;

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_THREAD_ID = 1444;
const ERROR_INVALID_HOOK_FILTER = 1426;
const ERROR_INVALID_FILTER_PROC = 1427;
const ERROR_HOOK_NEEDS_HMOD = 1428;

/**
 * @typedef {Object} WinEventHook
 * @property {number} handle
 * @property {number} min      The lowest event it hears.
 * @property {number} max      The highest, inclusive.
 * @property {number} proc     WINEVENTPROC.
 * @property {number} process  The process it hears, zero for every one.
 * @property {number} thread   The thread it hears, zero for every one.
 * @property {number} flags    WINEVENT_*.
 * @property {number | null} owner  The thread that installed it.
 */

/**
 * @typedef {Object} WinEventHost
 * @property {{ open: (type: string, object: any) => number,
 *              close: (handle: number) => any }} handles
 * @property {(entry: number, args: number[], thread?: unknown) => any} [call]
 *           Runs a guest routine on a thread; absent, no hook is ever called.
 * @property {() => unknown} [callerThread]
 * @property {(code: number) => void} [setLastError]
 * @property {(id: number) => boolean} [threadExists]
 * @property {number} [processId]
 * @property {() => number} [now]  The guest's clock in milliseconds.
 */

/**
 * @param {WinEventHost} host
 * @param {{ windowThread: (hwnd: number) => number | null,
 *     later: (thread: number, run: (thread: unknown) => any) => void }} windows
 *        windowThread: the thread that owns a window of this process, or null
 *        for a handle that names none. later: runs work on a thread when it
 *        next looks at its messages, before any message it takes.
 */
export function createWinEventHooks(host, { windowThread, later }){
    /** @type {WinEventHook[]} */
    const hooks = [];
    const processId = host.processId ?? 0x1000;

    /** @param {unknown} value @param {() => any} then */
    const andThen = (value, then)=>(typeof (/** @type {any} */ (value))?.then === 'function'
        ? /** @type {Promise<unknown>} */ (value).then(then) : then());

    /**
     * Whether a hook takes an event of this number reported from this thread.
     *
     * @param {WinEventHook} hook @param {number} event @param {number | null} from
     */
    const takes = (hook, event, from)=>{
        if (event < hook.min || event > hook.max)
        {
            return false;
        }
        if (hook.process !== 0 && hook.process !== processId)
        {
            return false;
        }
        if (hook.thread !== 0 && from !== null && hook.thread !== from)
        {
            return false;
        }
        if ((hook.flags & WINEVENT_SKIPOWNPROCESS) !== 0)
        {
            return false;
        }
        return (hook.flags & WINEVENT_SKIPOWNTHREAD) === 0 || from === null || hook.owner !== from;
    };

    /**
     * Calls each hook that takes the event, oldest first, one after another:
     * a hook the one before it removed is not called.
     *
     * @param {number} event @param {number} hwnd @param {number} object @param {number} child
     */
    const notify = (event, hwnd, object, child)=>{
        const caller = host.callerThread?.();
        const raisedOn = threadIdOf(caller);
        const from = windowThread(hwnd) ?? raisedOn;
        const heard = hooks.filter(hook=>takes(hook, event, from));
        if (heard.length === 0 || !host.call)
        {
            return 0;
        }
        const time = Math.floor(host.now?.() ?? 0) >>> 0;
        /** @param {number} at @returns {any} */
        const next = at=>{
            for (; at < heard.length; at++)
            {
                const hook = heard[at];
                if (!hooks.includes(hook))
                {
                    continue;
                }
                const args = [hook.handle, event >>> 0, hwnd >>> 0, object >>> 0, child >>> 0,
                    (from ?? 0) >>> 0, time];
                // A build with no scheduler has one thread, and nothing to wait for.
                if ((hook.flags & WINEVENT_INCONTEXT) === 0 && hook.owner !== null)
                {
                    later(hook.owner, thread=>(hooks.includes(hook) && host.call
                        ? host.call(hook.proc, args, thread) : 0));
                    continue;
                }
                const answer = /** @type {NonNullable<typeof host.call>} */ (host.call)(hook.proc,
                    args, caller);
                const after = at + 1;
                return andThen(answer, ()=>next(after));
            }
            return 0;
        };
        return next(0);
    };

    const table = {
        /**
         * HWINEVENTHOOK SetWinEventHook(DWORD eventMin, DWORD eventMax,
         *     HMODULE hmodWinEventProc, WINEVENTPROC pfnWinEventProc,
         *     DWORD idProcess, DWORD idThread, DWORD dwFlags)
         *
         * A range upside down is ERROR_INVALID_HOOK_FILTER, no procedure
         * ERROR_INVALID_FILTER_PROC, an in-context hook with no module
         * ERROR_HOOK_NEEDS_HMOD -- even one for this process alone -- and a
         * thread that does not exist ERROR_INVALID_THREAD_ID. The process is
         * not checked: Windows takes one that does not exist.
         */
        SetWinEventHook: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([min, max, module, proc, process, thread, flags])=>{
                if ((min >>> 0) > (max >>> 0))
                {
                    host.setLastError?.(ERROR_INVALID_HOOK_FILTER);
                    return 0;
                }
                if ((proc >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_FILTER_PROC);
                    return 0;
                }
                if ((flags & WINEVENT_INCONTEXT) !== 0 && (module >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_HOOK_NEEDS_HMOD);
                    return 0;
                }
                if ((thread >>> 0) !== 0 && host.threadExists && !host.threadExists(thread >>> 0))
                {
                    host.setLastError?.(ERROR_INVALID_THREAD_ID);
                    return 0;
                }
                /** @type {WinEventHook} */
                const hook = {
                    handle: 0, min: min >>> 0, max: max >>> 0, proc: proc >>> 0,
                    process: process >>> 0, thread: thread >>> 0, flags: flags >>> 0,
                    owner: threadIdOf(host.callerThread?.()),
                };
                hook.handle = host.handles.open('winevent-hook', hook);
                hooks.push(hook);
                return hook.handle;
            },
        },

        /** BOOL UnhookWinEvent(HWINEVENTHOOK hWinEventHook): ERROR_INVALID_HANDLE for one not installed. */
        UnhookWinEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const at = hooks.findIndex(hook=>hook.handle === (handle >>> 0));
                if (at < 0)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                hooks.splice(at, 1);
                host.handles.close(handle >>> 0);
                return 1;
            },
        },

        /** BOOL IsWinEventHookInstalled(DWORD event): whether any hook's range holds it. */
        IsWinEventHookInstalled: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([event])=>(hooks.some(hook=>(event >>> 0) >= hook.min
                && (event >>> 0) <= hook.max) ? 1 : 0),
        },

        /** void NotifyWinEvent(DWORD event, HWND hwnd, LONG idObject, LONG idChild) */
        NotifyWinEvent: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([event, hwnd, object, child])=>andThen(
                notify(event >>> 0, hwnd >>> 0, object | 0, child | 0), ()=>0),
        },
    };

    return { table, notify };
}

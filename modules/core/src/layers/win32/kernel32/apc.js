/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Asynchronous procedure calls: routines queued to a thread, run by that thread
 * the next time it waits alertably.
 *
 * A program queues one with QueueUserAPC, or has the system queue one for it --
 * a waitable timer's completion routine when the timer comes due, a
 * ReadFileEx's once the read is done. Nothing runs it until the thread itself
 * enters an alertable wait (SleepEx, the `Ex` waits with bAlertable set,
 * MsgWaitForMultipleObjectsEx with MWMO_ALERTABLE): then every routine queued
 * to it runs, in order, on that thread, and the wait answers
 * WAIT_IO_COMPLETION instead of whatever it was waiting for. A thread that
 * finds one already queued when it starts to wait never blocks at all.
 *
 * The one mechanism this needs that a plain wait does not is a way back into
 * the host once the wait has ended, to run the routines before the call
 * returns. A wait parks its thread with the call's return address kept aside;
 * an APC that ends the wait puts that address back on the stack, below where
 * the call's arguments were, and sends the thread instead to a stub whose own
 * return lands on it. The stub runs the routines -- guest callbacks, like any
 * other -- and answers WAIT_IO_COMPLETION, and the program's call returns
 * with it as though the wait itself had.
 */

/** What an alertable wait answers when APCs ended it. */
export const WAIT_IO_COMPLETION = 0xc0;

/** MsgWaitForMultipleObjectsEx's flags. */
const MWMO_WAITALL = 0x1;
const MWMO_ALERTABLE = 0x2;
const MWMO_INPUTAVAILABLE = 0x4;

/** The pseudo-handle GetCurrentThread answers. */
const CURRENT_THREAD = 0xfffffffe;

/** WaitForSingleObject's failure. */
const WAIT_FAILED = 0xffffffff;

/** SignalObjectAndWait's refusal of an object it cannot signal. */
const ERROR_INVALID_HANDLE = 6;

/**
 * @typedef {Object} ApcHost
 * @property {any} kernel  `alertably`, `alert`, `handles`, and `armTimer`'s `fired`.
 * @property {(name: string, fn: object) => number} register  A host routine the
 *           guest can be sent to: the stub a woken thread returns through.
 * @property {(call: { entry: number, args: number[], thread: any }) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {(address: number, value: number) => void} writeU32
 * @property {(code: number) => void} setLastError
 * @property {(name: string) => ((args: number[]) => any)} call
 *           Another kernel32 or user32 export's handler, by name, read when it
 *           is called: the waits here are those calls, made alertable.
 */

/**
 * @param {ApcHost} host
 */
export function createApcs(host){
    const { kernel } = host;

    /**
     * What each thread has queued, oldest first.
     *
     * @type {WeakMap<object, { routine: number, args: number[] }[]>}
     */
    const queues = new WeakMap();
    /** @param {any} thread */
    const queueOf = thread=>{
        let queue = queues.get(thread);
        if (!queue)
        {
            queue = [];
            queues.set(thread, queue);
        }
        return queue;
    };

    let queued = 0;
    let delivered = 0;
    let interrupted = 0;

    /**
     * Runs everything queued to the thread, including what the routines queue
     * while they run, and answers what the alertable wait answers.
     *
     * @param {any} thread
     */
    const deliver = async thread=>{
        const queue = queueOf(thread);
        while (queue.length > 0)
        {
            const { routine, args } = /** @type {{ routine: number, args: number[] }} */
                (queue.shift());
            delivered++;
            await host.callGuest({ entry: routine, args, thread });
        }
        return WAIT_IO_COMPLETION;
    };

    /** @type {number} */
    let stub = 0;
    /**
     * The stub a woken thread is sent to. Its return lands on the address the
     * wait was going to return to, which is put back on the stack for it.
     */
    const deliveryStub = ()=>{
        stub ||= host.register('<apc-delivery>', {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>deliver(host.currentThread()),
        });
        return stub;
    };

    /**
     * Queues a routine to a thread and, when the thread is in an alertable
     * wait, ends the wait so the routine runs now.
     *
     * @param {any} thread
     * @param {number} routine
     * @param {number[]} args
     */
    const queue = (thread, routine, args)=>{
        queueOf(thread).push({ routine: routine >>> 0, args });
        queued++;
        const returnTo = thread.parkedReturn;
        const resting = thread.resumeStack;
        if (returnTo === null || returnTo === undefined || resting === null
            || resting === undefined || !kernel.alert(thread, WAIT_IO_COMPLETION))
        {
            return;
        }
        interrupted++;
        // The wait's return address goes back where the call's own `ret`
        // would have popped it from, and the thread resumes in the stub with
        // the stack standing on it.
        const at = (resting - 4) >>> 0;
        host.writeU32(at, returnTo);
        thread.parkedReturn = deliveryStub();
        thread.resumeStack = at;
    };

    /**
     * A wait, made alertable when asked: queued routines run first and end it
     * at once; otherwise a block it makes can be ended by one queued later.
     *
     * @param {boolean} alertable
     * @param {() => any} wait
     */
    const waitWith = (alertable, wait)=>{
        if (!alertable)
        {
            return wait();
        }
        const thread = host.currentThread();
        if (queueOf(thread).length > 0)
        {
            return deliver(thread);
        }
        return kernel.alertably(thread, wait);
    };

    /** @param {number} handle */
    const threadOf = handle=>{
        if ((handle >>> 0) === CURRENT_THREAD)
        {
            return host.currentThread();
        }
        try
        {
            return kernel.handles.resolve(handle >>> 0, 'thread');
        }
        catch (e){
            void e;
            return null;
        }
    };

    return {
        queue,
        deliver,
        waitWith,
        /** @param {any} thread */
        pending: thread=>queueOf(thread).length,

        diagnostics: ()=>({ queued, delivered, interrupted }),

        table: {
            /**
             * DWORD QueueUserAPC(PAPCFUNC pfnAPC, HANDLE hThread, ULONG_PTR dwData)
             *
             * The routine is called with the one argument, on the thread named,
             * the next time that thread waits alertably -- now, if it already is.
             */
            QueueUserAPC: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([routine, handle, data])=>{
                    const thread = threadOf(handle);
                    if (!thread || (routine >>> 0) === 0)
                    {
                        host.setLastError(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    queue(thread, routine, [data >>> 0]);
                    return 1;
                },
            },

            /**
             * DWORD SleepEx(DWORD dwMilliseconds, BOOL bAlertable)
             *
             * Declared with its own two arguments: kernel32 exports it
             * undecorated though it is stdcall, and a stub popping only
             * Sleep's one argument leaks four bytes of stack on every call.
             */
            SleepEx: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([milliseconds, alertable])=>
                    waitWith(alertable !== 0, ()=>host.call('Sleep')([milliseconds])),
            },

            /** DWORD WaitForSingleObjectEx(HANDLE, DWORD dwMilliseconds, BOOL bAlertable) */
            WaitForSingleObjectEx: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([handle, milliseconds, alertable])=>waitWith(alertable !== 0,
                    ()=>host.call('WaitForSingleObject')([handle, milliseconds])),
            },

            /**
             * DWORD WaitForMultipleObjectsEx(DWORD nCount, const HANDLE *lpHandles,
             *   BOOL bWaitAll, DWORD dwMilliseconds, BOOL bAlertable)
             */
            WaitForMultipleObjectsEx: {
                argBytes: 20,
                /** @param {number[]} args */
                handler: ([count, handles, waitAll, milliseconds, alertable])=>
                    waitWith(alertable !== 0, ()=>host.call('WaitForMultipleObjects')(
                        [count, handles, waitAll, milliseconds])),
            },

            /**
             * DWORD SignalObjectAndWait(HANDLE hObjectToSignal, HANDLE hObjectToWaitOn,
             *   DWORD dwMilliseconds, BOOL bAlertable)
             *
             * One call so that nothing can run between the two halves -- which
             * is true here of any pair of host calls, since no other thread
             * runs until this one parks.
             */
            SignalObjectAndWait: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([signal, waitOn, milliseconds, alertable])=>{
                    const kind = kernel.handles.typeOf?.(signal >>> 0);
                    const signalled = kind === 'event'
                        ? host.call('SetEvent')([signal])
                        : kind === 'mutex'
                            ? host.call('ReleaseMutex')([signal])
                            : kind === 'semaphore'
                                ? host.call('ReleaseSemaphore')([signal, 1, 0])
                                : 0;
                    if (!signalled)
                    {
                        if (kind !== 'event' && kind !== 'mutex' && kind !== 'semaphore')
                        {
                            host.setLastError(ERROR_INVALID_HANDLE);
                        }
                        return WAIT_FAILED;
                    }
                    return waitWith(alertable !== 0,
                        ()=>host.call('WaitForSingleObject')([waitOn, milliseconds]));
                },
            },
        },

        /** What user32 publishes, since the message wait is its own. */
        user32: {
            /**
             * DWORD MsgWaitForMultipleObjectsEx(DWORD nCount, const HANDLE *pHandles,
             *   DWORD dwMilliseconds, DWORD dwWakeMask, DWORD dwFlags)
             *
             * The message wait is handed, after its own five arguments, the two
             * flags it acts on itself: whether input already seen counts
             * (MWMO_INPUTAVAILABLE), and whether the wait is alertable.
             */
            MsgWaitForMultipleObjectsEx: {
                argBytes: 20,
                /** @param {number[]} args */
                handler: ([count, handles, milliseconds, mask, flags])=>
                    waitWith((flags & MWMO_ALERTABLE) !== 0,
                        ()=>host.call('MsgWaitForMultipleObjects')(
                            [count, handles, (flags & MWMO_WAITALL) !== 0 ? 1 : 0, milliseconds,
                                mask, flags & MWMO_INPUTAVAILABLE, flags & MWMO_ALERTABLE])),
            },
        },
    };
}

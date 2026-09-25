/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { enterCode, leaveCode, tryEnterCode } from './critical.js';

/**
 * What the export binding hands an entry that is guest code rather than a
 * trap: the means to register the traps it falls back to.
 *
 * @typedef {Object} GuestBuilder
 * @property {(name: string, fn: { argBytes: number, handler: Function }) => number} register
 */

/**
 * The synchronisation a C runtime's startup reaches for before it reaches for
 * anything else: critical sections, the interlocked arithmetic that reference
 * counts are built out of, waits on more than one object, and suspending a
 * thread.
 *
 * A critical section is not a handle. It is a structure the guest allocated,
 * usually inside its own data, and the guest reads the fields back -- a runtime
 * checks the recursion count, a debugger walks the list, a program asserts on
 * the owner. So the structure in guest memory is the record, kept true on every
 * transition, and the kernel object beside it exists only to hold the threads
 * that have to wait. Keeping the state solely on our side would leave a guest
 * reading zeroes out of a section it is standing inside.
 *
 * The transition that has to be got right is the handoff. A thread that cannot
 * take the section stops inside the kernel and its call never returns, so it is
 * in no position to write the structure once it wins. The thread that *leaves*
 * writes it, for whoever the kernel just handed it to -- which is the only
 * moment at which both the new owner and the structure are known.
 */

/**
 * Offsets into RTL_CRITICAL_SECTION, 32-bit.
 *
 * DebugInfo and LockSemaphore are at 0x00 and 0x10 and are deliberately left at
 * zero: the first is a pointer into a structure only a debugger walks, and the
 * second is created lazily by Windows itself, so a guest that finds either null
 * is looking at something Windows also produces.
 */
const CS_LOCK_COUNT = 0x04;
const CS_SPIN_COUNT = 0x14;
const CS_SIZE = 0x18;

/** LockCount while nobody holds the section. Held, it is zero or above. */
const CS_UNLOCKED = -1;

/** Waits with this timeout never give up. */
const INFINITE = 0xffffffff;

/** What a wait returns. WAIT_OBJECT_0 and WAIT_ABANDONED_0 are bases, not values. */
const WAIT_OBJECT_0 = 0x00000000;
const WAIT_ABANDONED_0 = 0x00000080;
const WAIT_TIMEOUT = 0x00000102;
const WAIT_FAILED = 0xffffffff;

/** The kernel's own answer for an abandoned mutex, before the index is added. */
const KERNEL_ABANDONED = 0x00000080;

/** GetCurrentThread hands out this, and it is -2 on every Windows. */
const CURRENT_THREAD = 0xfffffffe;

/** More than this in one wait is a caller that has lost track of its handles. */
const MAXIMUM_WAIT_OBJECTS = 64;

/**
 * @typedef {Object} SyncHost
 * @property {any} kernel                        The kernel layer's API.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => any} currentThread
 * @property {(thread?: any) => any} park        Stops a thread; returns the parked token.
 * @property {ReturnType<typeof import('./critical.js').createCriticalSections>} critical
 *           The queues behind contended sections, and the counters the fast
 *           paths keep.
 * @property {(bytes: number) => number} allocate
 * @property {(bytes: number) => number} [allocateCode]  pages of their own for the fast
 *           paths' code (`code-arena.js`), where a store beside it cannot invalidate it
 *           Guest memory the processor executes, for the fast paths.
 * @property {(milliseconds: number) => void} [advanceClock]
 *   Credits the guest clock for time a wait was supposed to spend. See the
 *   timeout note on WaitForMultipleObjects.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; all of
 * these are stdcall, the bridge's default, so none of them says so.
 *
 * @param {SyncHost} host
 */
export function createSyncFunctions(host){
    const { kernel } = host;

    /** @param {number} address */
    const readI32 = address=>new DataView(
        host.readMemory(address, 4).buffer).getInt32(0, true);

    /** @param {number} address @param {number} value */
    const writeI32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(address, bytes);
    };

    /**
     * The fast paths, placed once and shared by every export that uses them.
     *
     * Entering, leaving and trying a section are guest code: the structure the
     * program passes is the lock, and only a contended entry or a release that
     * owes a wake reaches the host, through the two traps registered here.
     *
     * @type {{ enter: number, leave: number, tryEnter: number } | null}
     */
    let fastPaths = null;
    /** @param {GuestBuilder} builder */
    const placed = builder=>{
        if (fastPaths)
        {
            return fastPaths;
        }
        const waitTrap = builder.register('<cs-wait>', {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>host.critical.wait(pointer >>> 0),
        });
        const wakeTrap = builder.register('<cs-wake>', {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>host.critical.wake(pointer >>> 0),
        });
        const counters = host.critical.counters();
        /** @param {(at: number) => Uint8Array} code */
        const place = code=>{
            // Sized by a throwaway rendering: the bytes depend on where they
            // land only through relative jumps, never in length.
            const at = (host.allocateCode ?? host.allocate)(code(0).length);
            host.writeMemory(at, code(at));
            return at;
        };
        fastPaths = {
            enter: place(at=>enterCode(at, waitTrap, counters)),
            leave: place(at=>leaveCode(at, wakeTrap, counters)),
            tryEnter: place(()=>tryEnterCode()),
        };
        return fastPaths;
    };

    /**
     * Resolves a handle to a kernel object, or null. A bad handle is a return
     * code and not a crash: programs do pass stale handles, and Windows answers
     * with a failure rather than stopping.
     *
     * @param {number} handle @param {string} [type]
     */
    const object = (handle, type)=>{
        try
        {
            return kernel.handles.resolve(handle, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {number} handle */
    const threadOf = handle=>(handle >>> 0) === CURRENT_THREAD
        ? host.currentThread()
        : object(handle >>> 0, 'thread');

    /**
     * Whether a wait on this object would return rather than block.
     *
     * Asked before waiting, never instead of it: a timeout is the one case where
     * the answer has to be known without joining the queue, because joining it
     * is the thing a timeout exists to avoid. The fields read here are the same
     * ones the kernel's own signal test reads, and a mutex this thread already
     * owns counts as ready because taking it again is a counter, not a wait.
     *
     * @param {any} target @param {any} thread
     */
    const ready = (target, thread)=>{
        switch (target.kind)
        {
            case 'event':
                return target.signalled === true;
            // A waitable timer's signal is set by the clock, so by the time a
            // wait on a set sees it, it is the same test as an event's.
            case 'timer':
                return target.signalled === true;
            case 'mutex':
                return target.owner === null || target.owner === thread;
            case 'semaphore':
                return target.count > 0;
            default:
                return false;
        }
    };

    /** @param {number} address @param {number} spinCount */
    const initialise = (address, spinCount)=>{
        host.critical.forget(address);
        // Written whole rather than field by field: the guest allocated this and
        // its contents are whatever was there before.
        host.writeMemory(address, new Uint8Array(CS_SIZE));
        writeI32(address + CS_LOCK_COUNT, CS_UNLOCKED);
        writeI32(address + CS_SPIN_COUNT, spinCount);
    };

    return {
        /** VOID InitializeCriticalSection(LPCRITICAL_SECTION lpCriticalSection) */
        InitializeCriticalSection: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                initialise(pointer >>> 0, 0);
                return 0;
            },
        },

        /**
         * BOOL InitializeCriticalSectionAndSpinCount(LPCRITICAL_SECTION, DWORD)
         *
         * The spin count is recorded and not honoured. Spinning is a bet that a
         * section will be released within a few thousand cycles on another core,
         * and there is no other core here -- a spin would burn the quantum of the
         * only thread that could release it.
         */
        InitializeCriticalSectionAndSpinCount: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, spinCount])=>{
                initialise(pointer >>> 0, spinCount | 0);
                return 1;
            },
        },

        /**
         * BOOL TryEnterCriticalSection(LPCRITICAL_SECTION lpCriticalSection)
         *
         * Guest code, never a trap: a try that would wait answers FALSE.
         */
        TryEnterCriticalSection: {
            argBytes: 4,
            /** @param {GuestBuilder} builder */
            guest: builder=>placed(builder).tryEnter,
        },

        /** VOID DeleteCriticalSection(LPCRITICAL_SECTION lpCriticalSection) */
        DeleteCriticalSection: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const address = pointer >>> 0;
                host.critical.forget(address);
                host.writeMemory(address, new Uint8Array(CS_SIZE));
                return 0;
            },
        },

        /**
         * VOID EnterCriticalSection(LPCRITICAL_SECTION lpCriticalSection)
         *
         * Guest code: the increment that takes the lock and the recursion are
         * the program's own instructions, and only a section somebody else
         * holds brings the thread here to be queued.
         */
        EnterCriticalSection: {
            argBytes: 4,
            /** @param {GuestBuilder} builder */
            guest: builder=>placed(builder).enter,
        },

        /**
         * VOID LeaveCriticalSection(LPCRITICAL_SECTION lpCriticalSection)
         *
         * Guest code too; a release that finds the count saying somebody
         * waited traps to hand the section over.
         */
        LeaveCriticalSection: {
            argBytes: 4,
            /** @param {GuestBuilder} builder */
            guest: builder=>placed(builder).leave,
        },

        /** LONG InterlockedIncrement(LONG volatile *lpAddend) */
        InterlockedIncrement: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                // The value AFTER the operation. A reference count that returns
                // the value before it releases one object too early, and does it
                // a long way from here.
                const next = (readI32(pointer >>> 0) + 1) | 0;
                writeI32(pointer >>> 0, next);
                return next >>> 0;
            },
        },

        /** LONG InterlockedDecrement(LONG volatile *lpAddend) */
        InterlockedDecrement: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const next = (readI32(pointer >>> 0) - 1) | 0;
                writeI32(pointer >>> 0, next);
                return next >>> 0;
            },
        },

        /** LONG InterlockedExchange(LONG volatile *Target, LONG Value) */
        InterlockedExchange: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, value])=>{
                // The value BEFORE, unlike the two above. This is the pair a
                // lock is built from, and it is only useful as the old value.
                const previous = readI32(pointer >>> 0);
                writeI32(pointer >>> 0, value);
                return previous >>> 0;
            },
        },

        /** LONG InterlockedCompareExchange(LONG volatile *Destination, LONG Exchange, LONG Comparand) */
        InterlockedCompareExchange: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, exchange, comparand])=>{
                const previous = readI32(pointer >>> 0);
                if (previous === (comparand | 0))
                {
                    writeI32(pointer >>> 0, exchange);
                }
                return previous >>> 0;
            },
        },

        /** DWORD WaitForMultipleObjects(DWORD nCount, const HANDLE *lpHandles, BOOL bWaitAll, DWORD dwMilliseconds) */
        WaitForMultipleObjects: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([count, handles, waitAll, timeout])=>{
                const total = count >>> 0;
                if (total === 0 || total > MAXIMUM_WAIT_OBJECTS)
                {
                    return WAIT_FAILED;
                }
                const view = new DataView(host.readMemory(handles >>> 0, total * 4).buffer);
                /** @type {any[]} */
                const objects = [];
                /** @type {any} */
                let child = null;
                /** Where a finished process sits in the caller's handle array. */
                let finishedAt = -1;
                /** And where the child still to run does. */
                let childAt = -1;
                for (let at = 0; at < total; at++)
                {
                    const handle = view.getUint32(at * 4, true);
                    const target = object(handle);
                    if (!target)
                    {
                        return WAIT_FAILED;
                    }
                    if (kernel.handles.typeOf?.(handle) === 'process')
                    {
                        if (kernel.processes?.finished?.(target))
                        {
                            finishedAt = at;
                        }
                        child = target;
                        childAt = at;
                        continue;
                    }
                    objects.push(target);
                }

                const thread = host.currentThread();

                // A process the engine already answered for -- a redistributable
                // installer it stands in for -- is finished, so the wait is
                // satisfied at once. The answer names its position in the
                // caller's own array, which is what the index means.
                if (finishedAt >= 0 && (waitAll === 0 || objects.length === 0))
                {
                    return WAIT_OBJECT_0 + finishedAt;
                }

                // A child process is in the set. It has not run while its
                // parent can look -- it runs once the parent has nothing else
                // to do -- so a real wait on a set containing one is the parent
                // handing over to it. A wait for any of the set is noted on
                // the child and answered with the child's own index when it
                // exits, the engine having run it beside this process; nothing
                // else in the set can be signalled meanwhile, since nothing of
                // the parent's runs. A wait for all of a set with more in it
                // than the child cannot be satisfied by the child alone, and
                // stays the old handover: the parent is replaced.
                if (child !== null && (timeout >>> 0) !== 0)
                {
                    if (waitAll === 0 || objects.length === 0)
                    {
                        (child.waiters ??= []).push({ thread, result: WAIT_OBJECT_0 + childAt });
                    }
                    kernel.block(thread, `child process ${child.imagePath}`);
                    return host.park(thread);
                }
                // A poll is a question, not a wait, and the honest answer about
                // a child is that it is still running. So a poll for all of a
                // set containing one can never be satisfied, and neither can a
                // poll for any of a set that holds nothing else.
                if (child !== null && (waitAll !== 0 || objects.length === 0))
                {
                    return WAIT_TIMEOUT;
                }

                // Zero is a poll: it asks whether the set is ready now and
                // never blocks, so a program checking is not stopped by the
                // question.
                const wait = timeout >>> 0;
                if (wait === 0)
                {
                    const satisfied = waitAll
                        ? objects.every(target=>ready(target, thread))
                        : objects.some(target=>ready(target, thread));
                    if (!satisfied)
                    {
                        return WAIT_TIMEOUT;
                    }
                }

                // Anything else is a real wait with a deadline behind it. This
                // used to poll once, credit the clock and report a timeout,
                // because expiry needed a timer the scheduler did not have. It
                // has one now, and the difference is not academic: a program
                // that waits a second for a worker and is told immediately that
                // the second elapsed never gives the worker a turn, so the loop
                // it is in cannot terminate however long it runs.
                const timed = wait === INFINITE
                    ? undefined
                    : { deadline: kernel.clock.virtualTime() + wait, result: WAIT_TIMEOUT };

                if (waitAll)
                {
                    const result = kernel.waitAll(objects, thread, timed);
                    if (result === null)
                    {
                        return host.park();
                    }
                    // Waiting for all of them reports one answer for the set:
                    // there is no index, because every one of them was taken.
                    return result === KERNEL_ABANDONED ? WAIT_ABANDONED_0 : WAIT_OBJECT_0;
                }

                const any = kernel.waitAny(objects, thread, timed);
                if (any === null)
                {
                    return host.park();
                }
                // The index is added to the base, which is what makes
                // WAIT_OBJECT_0 a base rather than a value.
                const base = any.result === KERNEL_ABANDONED ? WAIT_ABANDONED_0 : WAIT_OBJECT_0;
                return (base + any.index) >>> 0;
            },
        },

        /** HANDLE GetCurrentThread(VOID) */
        GetCurrentThread: {
            argBytes: 0,
            handler: ()=>CURRENT_THREAD,
        },

        /** DWORD SuspendThread(HANDLE hThread) */
        SuspendThread: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    return WAIT_FAILED;
                }
                // The count before, which is what tells a caller whether it was
                // the one that stopped the thread or merely the second to ask.
                const previous = thread.suspendCount ?? 0;
                thread.suspendCount = previous + 1;
                if (previous === 0)
                {
                    kernel.block(thread, 'suspended');
                }
                return thread === host.currentThread() ? host.park(thread) : previous >>> 0;
            },
        },

        /** DWORD ResumeThread(HANDLE hThread) */
        ResumeThread: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                // A child created with CREATE_SUSPENDED has a thread handle but
                // no thread: the launcher writes into the child and resumes it,
                // and this is the point at which the child is ready to take
                // this process's place. It answers a suspend count of one, the
                // count a freshly suspended child really has.
                const child = object(handle >>> 0, 'process-thread');
                if (child)
                {
                    const wasSuspended = child.suspended;
                    child.suspended = false;
                    return wasSuspended ? 1 : 0;
                }
                const thread = threadOf(handle);
                if (!thread)
                {
                    return WAIT_FAILED;
                }
                const previous = thread.suspendCount ?? 0;
                if (previous === 0)
                {
                    return 0;
                }
                thread.suspendCount = previous - 1;
                if (thread.suspendCount === 0)
                {
                    kernel.wake(thread);
                }
                return previous >>> 0;
            },
        },

        /** BOOL TerminateThread(HANDLE hThread, DWORD dwExitCode) */
        TerminateThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    return 0;
                }
                kernel.exitThread(thread, code >>> 0);
                // Killing yourself does not return. Killing somebody else does,
                // and says it worked.
                return thread === host.currentThread() ? host.park(thread) : 1;
            },
        },
    };
}

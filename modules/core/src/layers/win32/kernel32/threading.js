/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The kernel32 surface a threaded program calls.
 *
 * These translate between the guest's vocabulary -- handles, milliseconds,
 * return codes -- and the kernel's objects. The scheduling itself is the
 * kernel's; nothing here decides who runs next.
 *
 * A call that has to wait cannot simply return: the guest thread must stop
 * where it is and the CPU must go elsewhere. So a blocking function reports
 * that it blocked, and the caller parks the thread -- the same mechanism that
 * ends a process, reused rather than reinvented.
 */

/** Waits with this timeout never give up. */
const INFINITE = 0xffffffff;

/** What the guest gets back when a handle is not what it claims to be. */
const WAIT_FAILED = 0xffffffff;
/** The wait ran out of time; the object was never signalled. */
const WAIT_TIMEOUT = 0x102;
/** The object was signalled: the first of a set, or the one. */
const WAIT_OBJECT_0 = 0;
/** Milliseconds from the FILETIME epoch (1601) to the Unix one, for an absolute due time. */
const FILETIME_EPOCH_MS = 11644473600000;

/** The pseudo-handle for the running process; -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;
/** GetCurrentThread hands out this, and it is -2 on every Windows. */
const CURRENT_THREAD = 0xfffffffe;

/** Codes this surface reports. */
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_SUCCESS = 0;
/** What a create reports when the name was already taken. */
const ERROR_ALREADY_EXISTS = 183;

/** A name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_SUPPORTED = 50;

/** DuplicateHandle's one option that changes what it does. */
const DUPLICATE_CLOSE_SOURCE = 0x00000001;

/**
 * @typedef {Object} ThreadingHost
 * @property {any} kernel                       The kernel layer's API.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {() => any} currentThread
 * @property {(thread?: any) => any} park       Stops a thread; returns the parked token.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {() => number} [threadReturn]
 * @property {(thread: any) => void} [threadBlock]
 *           Gives a thread just made its own environment block -- the thing FS
 *           points at, with its id, its stack bounds and its thread-local
 *           slots. Without one a thread reads all of those at linear address
 *           zero and up, which is nobody's.
 *           Where a start routine returns to. A thread that returns has ended,
 *           and if nothing notices it stays runnable for ever, is picked every
 *           turn, retires nothing, and keeps whatever it was holding.
 * @property {number} [processId]      What the running process is numbered.
 * @property {() => string} [imagePath]  Where its image is, for a snapshot's entry.
 * @property {(handle: number) => string | null} [handleType]
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that does less than the real one says so.
 *           What kind of object a handle names. The kernel's handle table
 *           knows; it is not forwarded through the kernel API yet, and
 *           without it DuplicateHandle refuses rather than guessing.
 */

/** PROCESSENTRY32, as a caller of the era declares it: 296 bytes. */
const PROCESSENTRY32 = Object.freeze({
    dwSize: 0,
    th32ProcessID: 8,
    cntThreads: 20,
    pcPriClassBase: 28,
    szExeFile: 36,
    SIZE: 296,
});
const MAX_PATH = 260;
const TH32CS_SNAPPROCESS = 0x2;
const NORMAL_PRIORITY_BASE = 8;
const ERROR_NO_MORE_FILES = 18;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** @param {Uint8Array} bytes @param {number} at */
const readU32 = (bytes, at)=>
    (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; every
 * one of these is stdcall, the bridge's default, so none of them says so.
 *
 * @param {ThreadingHost} host
 */
export function createThreadingFunctions(host){
    /** @param {number} handle @returns {{ flags: number, walked: boolean } | null} */
    const snapshotOf = handle=>{
        try
        {
            return host.kernel.handles.resolve(handle >>> 0, 'snapshot');
        }
        catch (e){
            void e;
            return null;
        }
    };
    const { kernel } = host;

    /**
     * The running program, as the object the (HANDLE)-1 pseudo-handle names.
     *
     * It is a process object but not a child: a child takes this process's
     * place rather than running beside it, so a wait on it is a handover,
     * while a wait on this one is a wait on something that can only be
     * signalled when the waiter itself has stopped.
     */
    const currentProcess = {
        kind: 'process',
        current: true,
        /** @returns {string} */
        get imagePath(){
            return host.imagePath?.() ?? '';
        },
    };

    /**
     * The two pseudo-handles Windows accepts wherever a handle is taken:
     * (HANDLE)-1 is the current process, (HANDLE)-2 the current thread. They
     * are not entries in the handle table -- that is what makes them always
     * valid -- so a lookup has to map them before it misses.
     *
     * @param {number} handle
     * @returns {{ type: string, object: any } | null}
     */
    const pseudo = handle=>{
        if ((handle >>> 0) === CURRENT_THREAD)
        {
            return { type: 'thread', object: host.currentThread() };
        }
        if ((handle >>> 0) === CURRENT_PROCESS)
        {
            return { type: 'process', object: currentProcess };
        }
        return null;
    };

    /**
     * Resolves a handle to a kernel object, or null if the guest passed
     * something that is not one. A bad handle is a return code, not a crash:
     * programs do pass stale handles, and Windows answers with a failure.
     *
     * @param {number} handle
     * @param {string} [type]
     */
    const object = (handle, type)=>{
        const special = pseudo(handle);
        if (special)
        {
            return !type || type === special.type ? special.object : null;
        }
        try
        {
            return kernel.handles.resolve(handle, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * What kind of object a handle names, the pseudo-handles included.
     *
     * @param {number} handle
     * @returns {string | null}
     */
    const kindOf = handle=>{
        const special = pseudo(handle);
        if (special)
        {
            return special.type;
        }
        return host.handleType ? host.handleType(handle >>> 0) : null;
    };

    /**
     * Applies a wait's outcome. When the object was not available there is no
     * outcome yet, so the caller is parked and the token that says so is what
     * goes back -- the real result reaches the thread when it next runs.
     *
     * @param {number | null} result
     * @returns {number | any}
     */
    const settle = result=>result === null ? host.park() : result;

    /**
     * Objects that have a name, by that name.
     *
     * A name is not decoration. Two calls naming the same object must get the
     * same object -- that is how one process coordinates with itself across
     * libraries, and how a second copy of a program discovers the first. The
     * create reports that the name was already taken, and the canonical
     * single-instance idiom reads exactly that.
     *
     * Kept here rather than in the kernel because naming is a Win32 idea: the
     * kernel has objects and no namespace.
     *
     * @type {Map<string, { kind: string, object: any }>}
     */
    const named = new Map();

    /** @param {number} pointer @returns {string | null} */
    const nameOf = pointer=>((pointer >>> 0) === 0
        ? null
        : host.readCString(pointer >>> 0, MAX_NAME) || null);

    /**
     * A live name standing for an object of some other kind. Windows keeps one
     * namespace and does not convert between kinds, so neither a create nor an
     * open may quietly take the name over: the call fails and the object that
     * holds the name keeps it.
     */
    const TAKEN = Symbol('taken');

    /**
     * The object this name already stands for, TAKEN if another kind holds it,
     * or null if the name is free.
     *
     * @param {string | null} name @param {string} kind
     */
    const existing = (name, kind)=>{
        if (name === null)
        {
            return null;
        }
        const held = named.get(name);
        if (!held)
        {
            return null;
        }
        // A name lives exactly as long as a handle to the object behind it.
        // Windows destroys the object when the last one closes and the name
        // goes with it, which is what makes the single-instance idiom work at
        // all: a program creates the object to probe for a first copy, closes
        // it, and creates it again for real -- and the second create must not
        // be told the name is taken by the handle it just closed.
        if (!kernel.handles.holds(held.object))
        {
            named.delete(name);
            return null;
        }
        return held.kind === kind ? held.object : TAKEN;
    };

    /**
     * Records the name and reports what the create should leave behind: a
     * create that found its name already taken says so, and one that did not
     * must clear the slot rather than leave whatever an unrelated call put
     * there. The single-instance idiom reads this immediately after the call
     * and cannot tell a stale value from its own.
     *
     * @param {string | null} name @param {string} kind @param {any} made
     * @param {boolean} reused
     */
    const remember = (name, kind, made, reused)=>{
        if (name !== null && !reused)
        {
            named.set(name, { kind, object: made });
        }
        host.setLastError(reused ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
    };

    return {
        /** HANDLE CreateThread(LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE, LPVOID, DWORD, LPDWORD) */
        CreateThread: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, stackSize, start, parameter, , threadIdOut])=>{
                const thread = kernel.createThread({
                    entry: start >>> 0,
                    stackSize: stackSize >>> 0,
                    parameter: parameter >>> 0,
                    // Returning from the start routine is how most threads end,
                    // and it means exactly what calling ExitThread with the
                    // same value means. Somewhere has to notice; this is where
                    // it returns to.
                    returnTo: host.threadReturn?.(),
                });
                host.threadBlock?.(thread);
                if (threadIdOut !== 0)
                {
                    kernel.writeThreadId(threadIdOut, thread.id);
                }
                // Deliberately no switch: the creator has not necessarily
                // finished setting up what the new thread is about to read.
                return thread.handle;
            },
        },

        /** DWORD WaitForSingleObject(HANDLE, DWORD dwMilliseconds) */
        WaitForSingleObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, timeout])=>{
                const target = object(handle >>> 0);
                if (!target)
                {
                    return WAIT_FAILED;
                }
                const wait = timeout >>> 0;
                const thread = host.currentThread();

                if (kindOf(handle >>> 0) === 'process')
                {
                    // A child the engine already answered for -- a
                    // redistributable installer it stands in for -- is
                    // finished, and a wait on it returns at once with its exit
                    // code, as on any already-signalled object.
                    if (kernel.processes?.finished?.(target))
                    {
                        return WAIT_OBJECT_0;
                    }
                    // The running process is signalled only when it ends, and
                    // that cannot happen while the waiter is still running: a
                    // poll or a timeout answers WAIT_TIMEOUT, and an infinite
                    // wait parks until a moment that never comes.
                    if (target.current)
                    {
                        if (wait === 0)
                        {
                            return WAIT_TIMEOUT;
                        }
                        kernel.block(thread, `the current process "${target.imagePath}"`,
                            wait === INFINITE ? undefined : {
                                deadline: kernel.clock.virtualTime() + wait,
                                result: WAIT_TIMEOUT,
                            });
                        return host.park(thread);
                    }
                    // A child process is never signalled while its parent can
                    // look: it takes this process's place rather than running
                    // beside it. So a poll says the child is still running,
                    // which is true, and a real wait is the parent saying it
                    // has nothing left to do -- the thread stops here for good,
                    // and the replacement is what happens instead of the wait
                    // ever returning.
                    if (wait === 0)
                    {
                        return WAIT_TIMEOUT;
                    }
                    kernel.block(thread, `child process ${target.imagePath}`);
                    return host.park(thread);
                }

                // A timer is ordinary here. Its signal is a property of the
                // object and the kernel's clock, not of this wait: the clock
                // sets it when the due time arrives whether this call came
                // before or after it was armed, so there is nothing left to
                // special-case.
                //
                // Zero is a poll, not a wait: it asks whether the object is
                // available now and never blocks or queues. A wait with a zero
                // deadline answered at once too, but left the thread queued on
                // the object, and a later signal woke it out of whatever it
                // was waiting on by then with an answer naming the wrong thing.
                if (wait === 0)
                {
                    return kernel.poll(target, thread) ?? WAIT_TIMEOUT;
                }
                return settle(kernel.wait(target, thread, wait === INFINITE
                    ? undefined
                    : { deadline: kernel.clock.virtualTime() + wait, result: WAIT_TIMEOUT }));
            },
        },


        /**
         * HANDLE CreateSemaphoreA(LPSECURITY_ATTRIBUTES, LONG lInitialCount,
         *                         LONG lMaximumCount, LPCSTR lpName)
         *
         * The counts are signed and both are checked, because the failure they
         * guard against is silent: a maximum of zero or an initial count above
         * it makes every later wait behave in a way the caller cannot explain.
         */
        CreateSemaphoreA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, initial, maximum])=>{
                const start = initial | 0;
                const limit = maximum | 0;
                if (limit <= 0 || start < 0 || start > limit)
                {
                    return 0;
                }
                const semaphore = kernel.createSemaphore({
                    initial: start, maximum: limit, name: 'semaphore',
                });
                return kernel.handles.open('semaphore', semaphore);
            },
        },

        /**
         * BOOL ReleaseSemaphore(HANDLE, LONG lReleaseCount, LPLONG lpPreviousCount)
         *
         * Releasing past the maximum fails and releases nothing -- it does not
         * clamp. A caller uses exactly that to detect its own double release,
         * and the previous count is written only on success, which is what makes
         * the check meaningful.
         */
        ReleaseSemaphore: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, count, previous])=>{
                const semaphore = object(handle >>> 0, 'semaphore');
                if (!semaphore || (count | 0) <= 0)
                {
                    return 0;
                }
                try
                {
                    const before = kernel.releaseSemaphore(semaphore, count | 0);
                    if (previous !== 0)
                    {
                        host.writeMemory(previous >>> 0, new Uint8Array([
                            before & 0xff, before >>> 8 & 0xff,
                            before >>> 16 & 0xff, before >>> 24 & 0xff,
                        ]));
                    }
                    return 1;
                }
                catch (e){
                    void e;
                    return 0;
                }
            },
        },

        /**
         * HANDLE OpenMutexA(DWORD dwDesiredAccess, BOOL bInheritHandle, LPCSTR lpName)
         *
         * Always fails with "no such thing", and that is the useful answer. A
         * named mutex is how a program discovers a second copy of itself already
         * running; there is exactly one process here, so nothing it could open
         * exists, and reporting one would make it exit believing it is the
         * second copy.
         */
        OpenMutexA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , namePointer])=>{
                const mutex = existing(nameOf(namePointer), 'mutex');
                if (!mutex || mutex === TAKEN)
                {
                    host.setLastError(mutex === TAKEN
                        ? ERROR_INVALID_HANDLE
                        : ERROR_FILE_NOT_FOUND);
                    return 0;
                }
                return kernel.handles.open('mutex', mutex);
            },
        },

        /**
         * HANDLE OpenEventA(DWORD dwDesiredAccess, BOOL bInheritHandle, LPCSTR lpName)
         *
         * Unlike the mutex form this can succeed, and routinely does: one
         * process names an event in one library and opens it by name in
         * another, which is how two parts of the same program that do not know
         * about each other agree on a signal. A name nothing created is
         * "no such thing" -- not an error the caller cannot tell apart from a
         * failure to open one that exists.
         */
        OpenEventA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , namePointer])=>{
                const event = existing(nameOf(namePointer), 'event');
                if (!event || event === TAKEN)
                {
                    host.setLastError(event === TAKEN
                        ? ERROR_INVALID_HANDLE
                        : ERROR_FILE_NOT_FOUND);
                    return 0;
                }
                return kernel.handles.open('event', event);
            },
        },

        /**
         * BOOL DuplicateHandle(HANDLE hSourceProcessHandle, HANDLE hSourceHandle,
         *   HANDLE hTargetProcessHandle, LPHANDLE lpTargetHandle,
         *   DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwOptions)
         *
         * A second handle onto the same object, which is what a duplicate is --
         * not a copy of the object. Closing either leaves the other usable,
         * which is the property a caller duplicates a handle to get.
         *
         * Both process handles are ignored: there is one process, and a
         * duplicate into another one has nowhere to go.
         */
        DuplicateHandle: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, source, , target, , , options])=>{
                const held = object(source >>> 0);
                const kind = kindOf(source >>> 0);
                if (!held || target === 0 || kind === null)
                {
                    // Without the source handle's type there is nothing to
                    // reopen the object under, and a duplicate filed under the
                    // wrong type fails every later typed lookup -- a slower,
                    // stranger failure than refusing here.
                    host.setLastError(kind === null && held
                        ? ERROR_NOT_SUPPORTED
                        : ERROR_INVALID_HANDLE);
                    return 0;
                }
                const duplicate = kernel.handles.open(kind, held);
                host.writeMemory(target >>> 0, new Uint8Array([
                    duplicate & 0xff, duplicate >>> 8 & 0xff,
                    duplicate >>> 16 & 0xff, duplicate >>> 24 & 0xff,
                ]));
                // A pseudo-handle cannot be closed: duplicating one and closing
                // the source leaves both usable, as it does on Windows.
                if ((options >>> 0 & DUPLICATE_CLOSE_SOURCE) !== 0 && !pseudo(source))
                {
                    kernel.handles.close(source >>> 0);
                }
                return 1;
            },
        },

        /** HANDLE CreateMutexA(LPSECURITY_ATTRIBUTES, BOOL bInitialOwner, LPCSTR) */
        CreateMutexA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, initialOwner, namePointer])=>{
                const name = nameOf(namePointer);
                const found = existing(name, 'mutex');
                if (found === TAKEN)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const mutex = found ?? kernel.createMutex({ name: name ?? 'mutex' });
                if (initialOwner && found === null)
                {
                    kernel.wait(mutex, host.currentThread());
                }
                remember(name, 'mutex', mutex, found !== null);
                const handle = kernel.handles.open('mutex', mutex);
                if (name === null)
                {
                    mutex.name = `#${handle.toString(16)}`;
                }
                return handle;
            },
        },

        /** BOOL ReleaseMutex(HANDLE) */
        ReleaseMutex: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const mutex = object(handle >>> 0, 'mutex');
                if (!mutex)
                {
                    return 0;
                }
                return kernel.releaseMutex(mutex, host.currentThread()) ? 1 : 0;
            },
        },

        /** HANDLE CreateEventA(LPSECURITY_ATTRIBUTES, BOOL bManualReset, BOOL bInitialState, LPCSTR) */
        CreateEventA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, manualReset, initialState, namePointer])=>{
                const name = nameOf(namePointer);
                const found = existing(name, 'event');
                if (found === TAKEN)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const event = found ?? kernel.createEvent({
                    manualReset: Boolean(manualReset),
                    signalled: Boolean(initialState),
                    name: name ?? 'event',
                });
                remember(name, 'event', event, found !== null);
                const handle = kernel.handles.open('event', event);
                // An unnamed object is most of them, and "event" tells a reader
                // nothing when three threads are blocked on three of them. The
                // handle is what the trace shows at every other call, so it is
                // what ties a blocked thread to the code that made the object.
                if (name === null)
                {
                    event.name = `#${handle.toString(16)}`;
                }
                return handle;
            },
        },

        /** BOOL SetEvent(HANDLE) */
        SetEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const event = object(handle >>> 0, 'event');
                if (!event)
                {
                    return 0;
                }
                kernel.setEvent(event);
                return 1;
            },
        },

        /** BOOL ResetEvent(HANDLE) */
        ResetEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const event = object(handle >>> 0, 'event');
                if (!event)
                {
                    return 0;
                }
                kernel.resetEvent(event);
                return 1;
            },
        },

        /**
         * The waitable timer, which a frame limiter arms and then waits on.
         *
         * A kernel object whose due time the scheduler's clock honours: when
         * the due time arrives the object is signalled, releasing whoever is
         * waiting on it -- all of them for a manual-reset timer, one for a
         * synchronisation timer, which is reset by the wait that takes it --
         * whether the wait began before or after the arm. A periodic timer
         * re-arms itself on the same clock with no thread present. Declared
         * for the stack it pops as much as for what it does: these are stdcall
         * and exported undecorated, so a stub popping nothing walks the
         * caller's stack off -- which for a limiter called every frame
         * exhausts the stack.
         *
         * The completion routine a caller passes is not modelled: there are no
         * APCs here, so it is ignored and never runs. A program that arms a
         * timer and waits on it, which is what a limiter does, is unaffected.
         *
         * HANDLE CreateWaitableTimerA(LPSECURITY_ATTRIBUTES, BOOL bManualReset, LPCSTR)
         * BOOL SetWaitableTimer(HANDLE, const LARGE_INTEGER* pDueTime, LONG lPeriod,
         *     PTIMERAPCROUTINE, LPVOID, BOOL fResume)
         * BOOL CancelWaitableTimer(HANDLE)
         */
        CreateWaitableTimerA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, manualReset, namePointer])=>{
                const name = nameOf(namePointer);
                const found = existing(name, 'timer');
                if (found === TAKEN)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const timer = found ?? kernel.createTimer({
                    manualReset: Boolean(manualReset),
                    name: name ?? 'timer',
                });
                remember(name, 'timer', timer, found !== null);
                const handle = kernel.handles.open('timer', timer);
                if (name === null)
                {
                    timer.name = `#${handle.toString(16)}`;
                }
                return handle;
            },
        },

        SetWaitableTimer: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, dueTime, period])=>{
                const timer = object(handle >>> 0, 'timer');
                if (!timer || (dueTime >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                // A negative due time is relative, in hundreds of nanoseconds;
                // a positive one is an absolute FILETIME.
                const bytes = host.readMemory(dueTime >>> 0, 8);
                const raw = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
                const now = kernel.clock.virtualTime();
                const due = raw < 0n
                    ? now + Number(-raw) / 10000
                    : now + Math.max(0,
                        Number(raw / 10000n) - FILETIME_EPOCH_MS - kernel.clock.wallClock());
                kernel.armTimer(timer, due, Math.max(0, period | 0));
                return 1;
            },
        },

        CancelWaitableTimer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const timer = object(handle >>> 0, 'timer');
                if (!timer)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                kernel.cancelTimer(timer);
                return 1;
            },
        },

        /** VOID ExitThread(DWORD dwExitCode) — does not return */
        ExitThread: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                // Hold the thread before ending it: terminating clears the
                // kernel's notion of a current thread, and the parking that
                // follows still has to happen to the thread that called.
                const thread = host.currentThread();
                kernel.exitThread(thread, code >>> 0);
                return host.park(thread);
            },
        },

        /**
         * The Toolhelp snapshot, which a program walks to see whether another
         * copy of itself is running. One process is running here, so the
         * snapshot holds one entry -- this one -- and the walk ends after it,
         * with the error the end of a real walk carries.
         *
         * HANDLE CreateToolhelp32Snapshot(DWORD dwFlags, DWORD th32ProcessID)
         * BOOL Process32First(HANDLE, LPPROCESSENTRY32)
         * BOOL Process32Next(HANDLE, LPPROCESSENTRY32)
         */
        CreateToolhelp32Snapshot: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags])=>
                kernel.handles.open('snapshot', { flags: flags >>> 0, walked: false }),
        },

        Process32First: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, entry])=>{
                const snapshot = snapshotOf(handle);
                if (!snapshot)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if ((snapshot.flags & TH32CS_SNAPPROCESS) === 0 || (entry >>> 0) === 0)
                {
                    host.setLastError(ERROR_NO_MORE_FILES);
                    return 0;
                }
                const size = readU32(host.readMemory(entry >>> 0, 4), 0);
                if (size < PROCESSENTRY32.SIZE)
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                const bytes = new Uint8Array(PROCESSENTRY32.SIZE);
                const view = new DataView(bytes.buffer);
                view.setUint32(PROCESSENTRY32.dwSize, PROCESSENTRY32.SIZE, true);
                view.setUint32(PROCESSENTRY32.th32ProcessID,
                    (host.processId ?? 0x1000) >>> 0, true);
                view.setUint32(PROCESSENTRY32.cntThreads, 1, true);
                view.setUint32(PROCESSENTRY32.pcPriClassBase, NORMAL_PRIORITY_BASE, true);
                const path = host.imagePath?.() ?? '';
                const name = path.slice(path.lastIndexOf('\\') + 1).slice(0, MAX_PATH - 1);
                for (let at = 0; at < name.length; at++)
                {
                    bytes[PROCESSENTRY32.szExeFile + at] = name.charCodeAt(at) & 0xff;
                }
                host.writeMemory(entry >>> 0, bytes);
                snapshot.walked = true;
                return 1;
            },
        },

        Process32Next: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>{
                host.setLastError(snapshotOf(handle) ? ERROR_NO_MORE_FILES : ERROR_INVALID_HANDLE);
                return 0;
            },
        },

        /** BOOL CloseHandle(HANDLE) */
        CloseHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                try
                {
                    kernel.handles.close(handle >>> 0);
                    return 1;
                }
                catch (e){
                    void e;
                    return 0;
                }
            },
        },
    };
}

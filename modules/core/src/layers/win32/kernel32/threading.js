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
 * @property {(handle: number) => string | null} [handleType]
 *           What kind of object a handle names. The kernel's handle table
 *           knows; it is not forwarded through the kernel API yet, and
 *           without it DuplicateHandle refuses rather than guessing.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; every
 * one of these is stdcall, the bridge's default, so none of them says so.
 *
 * @param {ThreadingHost} host
 */
export function createThreadingFunctions(host){
    const { kernel } = host;

    /**
     * Resolves a handle to a kernel object, or null if the guest passed
     * something that is not one. A bad handle is a return code, not a crash:
     * programs do pass stale handles, and Windows answers with a failure.
     *
     * @param {number} handle
     * @param {string} [type]
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
     * The object this name already stands for, or null. A name taken by an
     * object of another kind is not a match: Windows keeps one namespace, so
     * asking for an event by a mutex's name fails rather than converting it.
     *
     * @param {string | null} name @param {string} kind
     */
    const existing = (name, kind)=>{
        if (name === null)
        {
            return null;
        }
        const held = named.get(name);
        return held && held.kind === kind ? held.object : null;
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
                });
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
                // Zero is a poll, not a wait: it asks whether the object is
                // available now and never blocks. Blocking on it would stop a
                // program that was only checking.
                if (wait === 0)
                {
                    const answer = kernel.wait(target, thread,
                        { deadline: 0, result: WAIT_TIMEOUT });
                    return answer === null ? WAIT_TIMEOUT : answer;
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
                if (!mutex)
                {
                    host.setLastError(ERROR_FILE_NOT_FOUND);
                    return 0;
                }
                return kernel.handles.open('mutex', mutex);
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
                const kind = host.handleType ? host.handleType(source >>> 0) : null;
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
                if ((options >>> 0 & DUPLICATE_CLOSE_SOURCE) !== 0)
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
                const mutex = found ?? kernel.createMutex({ name: name ?? 'mutex' });
                if (initialOwner && found === null)
                {
                    kernel.wait(mutex, host.currentThread());
                }
                remember(name, 'mutex', mutex, found !== null);
                return kernel.handles.open('mutex', mutex);
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
                const event = found ?? kernel.createEvent({
                    manualReset: Boolean(manualReset),
                    signalled: Boolean(initialState),
                    name: name ?? 'event',
                });
                remember(name, 'event', event, found !== null);
                return kernel.handles.open('event', event);
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

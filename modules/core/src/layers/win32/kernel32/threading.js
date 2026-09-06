/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
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

/**
 * @typedef {Object} ThreadingHost
 * @property {any} kernel                       The kernel layer's API.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {() => any} currentThread
 * @property {(thread: any) => void} park       Stops a thread where it stands.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is what the stub pops on return; every one of these is stdcall, so
 * the callee cleans up and a wrong count corrupts the guest's stack silently.
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
     * Applies a wait's outcome. When the object was not available the thread is
     * parked and the result is delivered on its next turn instead.
     *
     * @param {number | null} result
     * @returns {number}
     */
    const settle = result=>{
        if (result === null)
        {
            host.park(host.currentThread());
            return 0; // ignored: the thread is not going to read EAX yet
        }
        return result;
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
                if ((timeout >>> 0) !== INFINITE && timeout !== 0)
                {
                    // Timed waits need the clock to drive expiry, which is not
                    // built yet. Failing loudly beats pretending a timeout works.
                    throw new Error('WaitForSingleObject: only INFINITE and 0 are implemented');
                }
                return settle(kernel.wait(target, host.currentThread()));
            },
        },

        /** HANDLE CreateMutexA(LPSECURITY_ATTRIBUTES, BOOL bInitialOwner, LPCSTR) */
        CreateMutexA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, initialOwner])=>{
                const mutex = kernel.createMutex({ name: 'mutex' });
                if (initialOwner)
                {
                    kernel.wait(mutex, host.currentThread());
                }
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
            handler: ([, manualReset, initialState])=>{
                const event = kernel.createEvent({
                    manualReset: Boolean(manualReset),
                    signalled: Boolean(initialState),
                });
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
                kernel.exitThread(host.currentThread(), code >>> 0);
                host.park(host.currentThread());
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

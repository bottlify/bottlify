/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { enterCode, leaveCode, tryEnterCode } from './critical.js';
import { INTERLOCKED } from './interlocked.js';
import { createSlimSync } from './slimsync.js';
import { createSListFunctions } from './slist.js';
import { isStandardHandle, untagged } from './handle-tags.js';
import { createChangeNotifications } from './changes.js';

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
 * DebugInfo at 0x00 is a pointer into a structure only a debugger walks, and
 * Windows 8 and later make none: they write -1 there, which DeleteCriticalSection
 * clears. LockSemaphore at 0x10 is left at zero: Windows creates it lazily
 * itself, so a guest that finds it null is looking at something Windows also
 * produces.
 */
const CS_DEBUG_INFO = 0x00;
const CS_NO_DEBUG_INFO = -1;
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

/** A handle in a wait's set that names nothing; a count out of range. */
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

/** A thread already carries MAXIMUM_SUSPEND_COUNT suspensions. */
const ERROR_SIGNAL_REFUSED = 156;
/** A thread that has ended cannot be suspended. */
const ERROR_ACCESS_DENIED = 5;
/** What GetThreadContext answers for a thread that has ended. */
const ERROR_GEN_FAILURE = 31;
/** What GetThreadSelectorEntry answers for a selector it holds nothing for. */
const ERROR_NOACCESS = 998;
const ERROR_INVALID_THREAD_ID = 1444;
const ERROR_SEM_TIMEOUT = 121;
/** The pseudo-handle for the running process. */
const OWN_PROCESS = 0xffffffff;

/** The debug events a child reports here, and the size of the record they fill. */
const CREATE_PROCESS_DEBUG_EVENT = 3;
const EXIT_PROCESS_DEBUG_EVENT = 5;
const DEBUG_EVENT_SIZE = 96;
/** The CONTEXT groups GetThreadContext fills, and the size of the record. */
const CONTEXT_CONTROL = 0x10001;
const CONTEXT_INTEGER = 0x10002;
const CONTEXT_SEGMENTS = 0x10004;
const CONTEXT_DEBUG_REGISTERS = 0x10010;
const CONTEXT_BYTES = 0x2cc;
/** The flat selectors a 32-bit thread runs under. */
const SELECTOR_CODE = 0x1b;
const SELECTOR_DATA = 0x23;
const SELECTOR_FS = 0x3b;

/** Milliseconds from the FILETIME epoch (1601) to the Unix one, for thread times. */
const FILETIME_EPOCH_MS = 11644473600000;

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
 * @property {(code: number) => void} [setLastError]
 * @property {() => Record<string, number>} [registers]  the running thread's
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {import('./changes.js').WatchedVolume} [volume]
 *           The volume, for the directories a change notification watches;
 *           without it FindFirstChangeNotification is refused.
 */

/**
 * Builds the function table: name -> { argBytes, handler } for a trap, or
 * { argBytes, guest } for guest code.
 *
 * `argBytes` is the size of the argument list the guest compiled against; all of
 * these are stdcall, the bridge's default, so none of them says so.
 *
 * @param {SyncHost} host
 */
export function createSyncFunctions(host){
    const { kernel } = host;

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
            tryEnter: place(()=>tryEnterCode(counters)),
        };
        return fastPaths;
    };

    /**
     * Where each interlocked export's code was placed, once, on the first
     * bind of any of them.
     *
     * @type {Map<string, number> | null}
     */
    let interlocked = null;
    /** @param {keyof typeof INTERLOCKED} name */
    const interlockedAt = name=>{
        if (!interlocked)
        {
            const allocate = host.allocateCode ?? host.allocate;
            interlocked = new Map(Object.entries(INTERLOCKED).map(([exported, { code }])=>{
                const at = allocate(code.length);
                host.writeMemory(at, code);
                return [exported, at];
            }));
        }
        return /** @type {number} */ (interlocked.get(name));
    };

    /**
     * An interlocked export: guest code, one locked instruction on the
     * program's dword (`interlocked.js`), with nothing to trap into.
     *
     * @param {keyof typeof INTERLOCKED} name
     */
    const interlockedExport = name=>({
        argBytes: INTERLOCKED[name].argBytes,
        guest: ()=>interlockedAt(name),
    });

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
            return kernel.handles.resolve(untagged(handle), type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @type {any} */
    let standing = null;
    /**
     * What a standard stream is in a set: an event that stays set, since the
     * stream is always ready and a wait for all of a set must still take the
     * rest.
     */
    const alwaysReady = ()=>{
        standing ??= kernel.createEvent({ manualReset: true, signalled: true,
            name: 'standard stream' });
        return standing;
    };

    /**
     * The registers a switched-away thread's saved state holds, in either
     * engine's shape: both keep the eight general registers and eip.
     *
     * @param {any} context
     * @returns {Record<string, number>}
     */
    const savedRegisters = context=>{
        if (!context)
        {
            return {};
        }
        const [eax, ecx, edx, ebx, esp, ebp, esi, edi] = Array.from(context.reg32 ?? [],
            value=>Number(value) >>> 0);
        let eflags = context.flags;
        if (context.block instanceof Uint8Array && context.layout)
        {
            eflags = new DataView(context.block.buffer, context.block.byteOffset)
                .getUint32(context.layout.eflags, true);
        }
        return { eax, ecx, edx, ebx, esp, ebp, esi, edi, eip: context.eip >>> 0,
            eflags: (eflags ?? 0x202) >>> 0 };
    };

    /**
     * Writes the groups of a CONTEXT its ContextFlags name, and nothing else.
     *
     * @param {number} at @param {Record<string, number>} registers
     */
    const writeThreadContext = (at, registers)=>{
        const bytes = host.readMemory(at, CONTEXT_BYTES).slice();
        const view = new DataView(bytes.buffer);
        const flags = view.getUint32(0, true);
        /** @param {number} offset @param {number | undefined} value */
        const put = (offset, value)=>view.setUint32(offset, (value ?? 0) >>> 0, true);
        if ((flags & CONTEXT_DEBUG_REGISTERS) === CONTEXT_DEBUG_REGISTERS)
        {
            bytes.fill(0, 4, 0x1c);
        }
        if ((flags & CONTEXT_SEGMENTS) === CONTEXT_SEGMENTS)
        {
            put(0x8c, 0);
            put(0x90, SELECTOR_FS);
            put(0x94, SELECTOR_DATA);
            put(0x98, SELECTOR_DATA);
        }
        if ((flags & CONTEXT_INTEGER) === CONTEXT_INTEGER)
        {
            [['edi', 0x9c], ['esi', 0xa0], ['ebx', 0xa4], ['edx', 0xa8], ['ecx', 0xac],
                ['eax', 0xb0]].forEach(([name, offset])=>
                put(Number(offset), registers[String(name)]));
        }
        if ((flags & CONTEXT_CONTROL) === CONTEXT_CONTROL)
        {
            put(0xb4, registers.ebp);
            put(0xb8, registers.eip);
            put(0xbc, SELECTOR_CODE);
            put(0xc0, registers.eflags ?? 0x202);
            put(0xc4, registers.esp);
            put(0xc8, SELECTOR_DATA);
        }
        host.writeMemory(at, bytes);
    };

    /**
     * The four FILETIMEs GetThreadTimes and GetProcessTimes write, a slot of
     * zero left alone. The clock this build keeps is one wall clock, so the
     * creation time is now, the exit time now for one that has ended and
     * zero otherwise, and the processor times zero -- a plausible FILETIME
     * rather than a pointer left unwritten.
     *
     * @param {number[]} slots  creation, exit, kernel, user
     * @param {boolean} ended
     */
    const writeTimes = ([creation, exit, kernelTime, userTime], ended)=>{
        const now = BigInt(Math.floor(kernel.clock.wallClock() + FILETIME_EPOCH_MS)) * 10000n;
        /** @param {number} address @param {bigint} value */
        const write = (address, value)=>{
            if ((address >>> 0) !== 0)
            {
                const bytes = new Uint8Array(8);
                new DataView(bytes.buffer).setBigInt64(0, value, true);
                host.writeMemory(address >>> 0, bytes);
            }
        };
        write(creation, now);
        write(exit, ended ? now : 0n);
        write(kernelTime, 0n);
        write(userTime, 0n);
        return 1;
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
            // Signalled by having ended, and for ever after.
            case 'thread':
                return (target.exitCode ?? null) !== null;
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
        writeI32(address + CS_DEBUG_INFO, CS_NO_DEBUG_INFO);
        writeI32(address + CS_LOCK_COUNT, CS_UNLOCKED);
        writeI32(address + CS_SPIN_COUNT, spinCount);
    };

    /**
     * A DEBUG_EVENT of the two kinds a debugged child gives here: its
     * creation, and its exit with the code it left.
     *
     * @param {number} address @param {any} child @param {boolean} exited
     */
    const writeDebugEvent = (address, child, exited)=>{
        const bytes = new Uint8Array(DEBUG_EVENT_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, exited ? EXIT_PROCESS_DEBUG_EVENT : CREATE_PROCESS_DEBUG_EVENT, true);
        view.setUint32(4, child.id >>> 0, true);
        view.setUint32(8, child.threadId >>> 0, true);
        if (exited)
        {
            view.setUint32(12, child.exitCode >>> 0, true);
        }
        else
        {
            // hFile, hProcess, hThread: no file is handed over, and the
            // process and thread are the handles CreateProcess gave.
            view.setUint32(16, child.handle >>> 0, true);
            view.setUint32(20, child.threadHandle >>> 0, true);
        }
        host.writeMemory(address, bytes);
    };

    return {
        /**
         * BOOL WaitForDebugEvent(LPDEBUG_EVENT lpDebugEvent, DWORD dwMilliseconds)
         *
         * A child started with DEBUG_PROCESS reports its creation and then
         * its exit -- no thread, library or exception of its own is reported,
         * since nothing stops it to report one -- the second waited for as a
         * wait on the child is. With no debugged child to hear from, or no
         * time to wait, the wait times out.
         */
        WaitForDebugEvent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([event, timeout])=>{
                const child = (kernel.processes?.all() ?? []).find(
                    (/** @type {any} */ made)=>made.debugEvents?.length > 0);
                if (!child || (event >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_SEM_TIMEOUT);
                    return 0;
                }
                if (child.debugEvents[0] === 'create')
                {
                    child.debugEvents.shift();
                    writeDebugEvent(event >>> 0, child, false);
                    return 1;
                }
                const report = ()=>{
                    child.debugEvents = [];
                    writeDebugEvent(event >>> 0, child, true);
                    return 1;
                };
                if (child.completed || child.exitCode !== kernel.processes.STILL_ACTIVE)
                {
                    return report();
                }
                if ((timeout >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_SEM_TIMEOUT);
                    return 0;
                }
                const thread = host.currentThread();
                (child.waiters ??= []).push({ thread, result: 1, settle: report });
                kernel.block(thread, `debug event of ${child.imagePath}`);
                return host.park(thread);
            },
        },

        /** BOOL ContinueDebugEvent(DWORD dwProcessId, DWORD dwThreadId, DWORD dwContinueStatus) */
        ContinueDebugEvent: { argBytes: 12, handler: ()=>1 },

        /**
         * BOOL DebugActiveProcessStop(DWORD dwProcessId)
         *
         * A child this process debugs stops reporting to it and goes on. A
         * process it does not debug is refused as one with no debug object
         * between them, and an id naming no process as a bad parameter.
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
                if (!child.debugEvents)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                child.debugEvents = null;
                return 1;
            },
        },

        /**
         * BOOL DebugSetProcessKillOnExit(BOOL KillOnExit)
         *
         * Whether the children this thread debugs end when it does. A caller
         * that debugs none has no debug object to set it on, and is refused
         * as such. The choice is kept on each child; no child of a debugger
         * outlives its parent here, since a child runs only when the parent
         * hands over to it.
         */
        DebugSetProcessKillOnExit: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([kill])=>{
                const debugged = (kernel.processes?.all() ?? []).filter(
                    (/** @type {any} */ made)=>made.debugEvents);
                if (debugged.length === 0)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                for (const child of debugged)
                {
                    child.killOnExit = (kill >>> 0) !== 0;
                }
                return 1;
            },
        },

        /**
         * BOOL DebugBreakProcess(HANDLE Process)
         *
         * On Windows the target gets a thread that breaks only if a debugger
         * is attached and otherwise just ends, and the call succeeds either
         * way. Neither this process nor a child it does not debug has one,
         * so nothing happens and the call succeeds; a child it debugs would
         * report a breakpoint, which the debug events here do not carry, and
         * that is said. A handle that is no process is refused.
         */
        DebugBreakProcess: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if ((handle >>> 0) === OWN_PROCESS)
                {
                    return 1;
                }
                const plain = untagged(handle);
                const child = kernel.handles.typeOf?.(plain) === 'process' ? object(plain) : null;
                if (!child)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if (child.debugEvents)
                {
                    host.divergence?.('DebugBreakProcess',
                        'a debugged child\'s breakpoint is not reported as a debug event');
                }
                return 1;
            },
        },

        /**
         * VOID ReinitializeCriticalSection(LPCRITICAL_SECTION lpCriticalSection):
         * the section made new again, as InitializeCriticalSection makes it,
         * whatever was waiting on it forgotten with it.
         */
        ReinitializeCriticalSection: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                initialise(pointer >>> 0, 0);
                return 0;
            },
        },

        // Directory change notifications (`changes.js`): waitable handles of
        // their own kind over the kernel's events.
        ...createChangeNotifications(host),

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
         * DWORD SetCriticalSectionSpinCount(LPCRITICAL_SECTION, DWORD dwSpinCount)
         *
         * The count is kept in the section, where
         * InitializeCriticalSectionAndSpinCount put it; the answer is the one it
         * replaced.
         */
        SetCriticalSectionSpinCount: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, spinCount])=>{
                const at = (pointer >>> 0) + CS_SPIN_COUNT;
                const bytes = host.readMemory(at, 4);
                const previous = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
                writeI32(at, spinCount | 0);
                return previous;
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

        // The value after for an increment or a decrement, the value before
        // for the other three. The two families disagree on purpose: a
        // reference count that answered the value before would release an
        // object one call early, a long way from here.
        InterlockedIncrement: interlockedExport('InterlockedIncrement'),
        InterlockedDecrement: interlockedExport('InterlockedDecrement'),
        InterlockedExchange: interlockedExport('InterlockedExchange'),
        InterlockedExchangeAdd: interlockedExport('InterlockedExchangeAdd'),
        InterlockedCompareExchange: interlockedExport('InterlockedCompareExchange'),

        /** DWORD WaitForMultipleObjects(DWORD nCount, const HANDLE *lpHandles, BOOL bWaitAll, DWORD dwMilliseconds) */
        WaitForMultipleObjects: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([count, handles, waitAll, timeout])=>{
                const total = count >>> 0;
                if (total === 0 || total > MAXIMUM_WAIT_OBJECTS)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return WAIT_FAILED;
                }
                const view = new DataView(host.readMemory(handles >>> 0, total * 4).buffer);
                /** @type {any[]} */
                const objects = [];
                /** Where each of `objects` sits in the caller's handle array. */
                /** @type {number[]} */
                const indices = [];
                /** @type {any} */
                let child = null;
                /** Where a finished process sits in the caller's handle array. */
                let finishedAt = -1;
                /** And where the child still to run does. */
                let childAt = -1;
                for (let at = 0; at < total; at++)
                {
                    const handle = view.getUint32(at * 4, true);
                    // No pseudo-handle is a member of a set, not even the two
                    // WaitForSingleObject takes: none is in the table.
                    const target = isStandardHandle(handle) ? alwaysReady() : object(handle);
                    if (!target)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return WAIT_FAILED;
                    }
                    if (kernel.handles.typeOf?.(untagged(handle)) === 'process')
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
                    indices.push(at);
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
                // the child and answered when it exits, the engine having run
                // it beside this process. Nothing of the parent's runs
                // meanwhile, but the child can signal the rest of the set: a
                // named event the parent made and the child opened by name.
                // One it signalled came before its exit, and is the answer --
                // taken as a wait takes it -- where Windows would have woken
                // the parent with it while the child ran on; otherwise the
                // child's own index. A wait for all of a set with more in it
                // than the child cannot be satisfied by the child alone, and
                // stays the old handover: the parent is replaced.
                if (child !== null && (timeout >>> 0) === 0 && !child.started
                    && !kernel.processes?.finished?.(child))
                {
                    child.polled = true;
                }
                if (child !== null && (timeout >>> 0) !== 0)
                {
                    if (waitAll === 0 || objects.length === 0)
                    {
                        const settle = ()=>{
                            if (!objects.some(target=>ready(target, thread)))
                            {
                                return WAIT_OBJECT_0 + childAt;
                            }
                            const any = /** @type {{ index: number, result: number }} */ (
                                kernel.waitAny(objects, thread));
                            const base = any.result === KERNEL_ABANDONED
                                ? WAIT_ABANDONED_0 : WAIT_OBJECT_0;
                            return base + indices[any.index];
                        };
                        (child.waiters ??= []).push(
                            { thread, result: WAIT_OBJECT_0 + childAt, settle });
                    }
                    else
                    {
                        child.handsOver = true;
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
                // An object another process of the run holds is answered there:
                // its stand-in here says nothing of whether it is signalled.
                if (wait === 0 && !waitAll && objects.some(target=>target.remote))
                {
                    const any = kernel.pollAny(objects, thread);
                    if (any === null)
                    {
                        return WAIT_TIMEOUT;
                    }
                    const base = any.result === KERNEL_ABANDONED ? WAIT_ABANDONED_0 : WAIT_OBJECT_0;
                    return (base + indices[any.index]) >>> 0;
                }
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
            code: ()=>Uint8Array.from([0xb8, 0xfe, 0xff, 0xff, 0xff, 0xc3]), // mov eax, -2; ret
        },

        /**
         * BOOL GetThreadTimes(HANDLE hThread, LPFILETIME lpCreationTime,
         *     LPFILETIME lpExitTime, LPFILETIME lpKernelTime, LPFILETIME lpUserTime)
         *
         * The thread's creation time, its exit time (zero while it runs), and
         * its CPU time in each mode. The clock this build keeps is one wall
         * clock, so the creation time is now and the times are zero -- a
         * caller that asks for them gets a plausible FILETIME, not a pointer
         * left unwritten.
         */
        GetThreadTimes: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, creation, exit, kernelTime, userTime])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                return writeTimes([creation, exit, kernelTime, userTime],
                    (thread.exitCode ?? null) !== null);
            },
        },

        /**
         * BOOL GetProcessTimes(HANDLE hProcess, LPFILETIME lpCreationTime,
         *     LPFILETIME lpExitTime, LPFILETIME lpKernelTime, LPFILETIME lpUserTime)
         *
         * The same four times for a process -- this one, or a child it holds
         * a handle to -- on the same one clock.
         */
        GetProcessTimes: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, creation, exit, kernelTime, userTime])=>{
                const CURRENT_PROCESS = 0xffffffff;
                const child = (handle >>> 0) === CURRENT_PROCESS ? null : object(handle, 'process');
                if ((handle >>> 0) !== CURRENT_PROCESS && !child)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                return writeTimes([creation, exit, kernelTime, userTime], child !== null
                    && (child.completed || child.exitCode !== kernel.processes?.STILL_ACTIVE));
            },
        },

        /**
         * DWORD_PTR SetThreadAffinityMask(HANDLE hThread, DWORD_PTR dwThreadAffinityMask)
         *
         * The processor a thread is allowed on. This build has one processor,
         * so the mask is recorded and the previous one handed back -- a caller
         * that sets and restores it gets the value it saved. A handle that is
         * not a thread fails with ERROR_INVALID_HANDLE.
         */
        SetThreadAffinityMask: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, mask])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const previous = thread.affinityMask ?? 1;
                thread.affinityMask = mask >>> 0;
                return previous;
            },
        },

        /**
         * DWORD SetThreadIdealProcessor(HANDLE hThread, DWORD dwIdealProcessor)
         *
         * The processor a thread would prefer to run on. There is one, so the
         * choice is recorded and the previous one handed back, as
         * SetThreadAffinityMask does.
         */
        SetThreadIdealProcessor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, ideal])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const previous = thread.idealProcessor ?? 0;
                thread.idealProcessor = ideal >>> 0;
                return previous;
            },
        },

        /**
         * BOOL GetThreadContext(HANDLE hThread, LPCONTEXT lpContext)
         *
         * The groups ContextFlags asks for, from the running registers for
         * the calling thread and from the state saved when another was last
         * switched away. A thread that has ended has no context to read.
         */
        GetThreadContext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if (kernel.ThreadState && thread.state === kernel.ThreadState.TERMINATED)
                {
                    host.setLastError?.(ERROR_GEN_FAILURE);
                    return 0;
                }
                const registers = thread === host.currentThread()
                    ? host.registers?.() ?? {} : savedRegisters(thread.context);
                writeThreadContext(out >>> 0, registers);
                return 1;
            },
        },

        /**
         * BOOL SetThreadContext(HANDLE hThread, const CONTEXT *lpContext)
         *
         * Refused: a thread stopped here is usually stopped inside a call
         * into the system, whose return would overwrite whatever registers
         * were put in its place, and a context that took effect only
         * sometimes would be worse than one refused.
         */
        SetThreadContext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                host.divergence?.('SetThreadContext', 'the registers of a thread are not replaced');
                host.setLastError?.(ERROR_ACCESS_DENIED);
                return 0;
            },
        },

        /**
         * BOOL GetThreadSelectorEntry(HANDLE hThread, DWORD dwSelector, LPLDT_ENTRY)
         *
         * The flat descriptors a 32-bit thread runs under -- code, data, and
         * the thread's own block behind FS -- and nothing for the null one.
         */
        GetThreadSelectorEntry: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, selector, out])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if ((selector >>> 0) > 0xffff)
                {
                    host.setLastError?.(ERROR_INVALID_THREAD_ID);
                    return 0;
                }
                const index = (selector >>> 0) & ~3;
                /** @type {[number, number, number, number, boolean] | null} */
                const descriptor = index === 0 ? [0, 0, 0, 0, false]
                    : index === (SELECTOR_CODE & ~3) ? [0, 0xfffff, 0x1b, 3, true]
                        : index === (SELECTOR_DATA & ~3) ? [0, 0xfffff, 0x13, 3, true]
                            : index === (SELECTOR_FS & ~3)
                                ? [thread.tebAddress >>> 0, 0xfff, 0x13, 3, false] : null;
                if (!descriptor)
                {
                    host.setLastError?.(ERROR_NOACCESS);
                    return 0;
                }
                const [base, limit, type, dpl, pages] = descriptor;
                const bytes = new Uint8Array(8);
                const view = new DataView(bytes.buffer);
                if (index !== 0)
                {
                    view.setUint16(0, limit & 0xffff, true);
                    view.setUint16(2, base & 0xffff, true);
                    bytes[4] = base >>> 16 & 0xff;
                    bytes[5] = type | dpl << 5 | 0x80;
                    // The high limit, 32-bit operands, and page granularity when flat.
                    bytes[6] = (limit >>> 16 & 0xf) | 0x40 | (pages ? 0x80 : 0);
                    bytes[7] = base >>> 24;
                }
                host.writeMemory(out >>> 0, bytes);
                return 1;
            },
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
                if (kernel.ThreadState && thread.state === kernel.ThreadState.TERMINATED)
                {
                    host.setLastError?.(ERROR_ACCESS_DENIED);
                    return WAIT_FAILED;
                }
                // The count before, which is what tells a caller whether it was
                // the one that stopped the thread or merely the second to ask.
                const previous = kernel.suspendThread(thread);
                if (previous === null)
                {
                    host.setLastError?.(ERROR_SIGNAL_REFUSED);
                    return WAIT_FAILED;
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
                const previous = kernel.resumeThread(thread);
                if (previous === 1)
                {
                    // A section released while it was suspended may be its now.
                    host.critical.resumed(thread);
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

        // SRW locks and condition variables; a sleep on one takes a critical
        // section back through the same guest code EnterCriticalSection is.
        ...createSlimSync(host, builder=>placed(builder).enter),

        // Interlocked singly linked lists over the header the program owns.
        ...createSListFunctions(host),
    };
}

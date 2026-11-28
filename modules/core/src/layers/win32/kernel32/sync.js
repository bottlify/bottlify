/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { COUNTERS, criticalLayout, enterCode, enterLongCode, leaveCode, leaveLongCode, tryEnterCode,
    tryEnterLongCode } from './critical.js';
import { INTERLOCKED, INTERLOCKED_64 } from './interlocked.js';
import { createSlimSync } from './slimsync.js';
import { createSListFunctions } from './slist.js';
import { FILE_OBJECT_KINDS, isStandardHandle, untagged } from './handle-tags.js';
import { createChangeNotifications } from './changes.js';
import { SELECTORS } from './seh.js';
import { MAXIMUM_PROCESSORS } from './processor.js';
import { createThreadInfoFunctions } from './thread-info.js';
import { createProcessPolicyFunctions } from './process-policy.js';
import { askChild, threadArg, threadEnd } from './cross-process.js';
import { mergeContextGroups } from './debug-events.js';
import { SYNCHRONIZE, allows } from './access.js';
import { floatGroupsOf, writeFloatGroups } from './fpu-context.js';
import { CONTEXT_DEBUG_REGISTERS, debugGroupOf, setDebugRegisters, writeDebugGroup }
    from './debug-registers.js';
import { pointerWidth, wholeAddress } from '../common/pointers.js';

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

/*
 * RTL_CRITICAL_SECTION (`criticalLayout`): DebugInfo, its first field, is a
 * pointer into a structure only a debugger walks, and Windows 8 and later make
 * none: they write -1 there, which DeleteCriticalSection clears. LockSemaphore
 * is left at zero: Windows creates it lazily itself, so a guest that finds it
 * null is looking at something Windows also produces.
 */
/** The flags InitializeCriticalSectionEx takes, all in the high byte. */
const CS_FLAG_BITS = 0xff000000;
const CS_FORCE_DEBUG_INFO = 0x10000000;

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
/** NTSTATUS of a native call on a child that cannot be asked. */
const STATUS_ACCESS_DENIED = 0xc0000022;
/** What GetThreadContext answers for a thread that has ended. */
const ERROR_GEN_FAILURE = 31;
/** What GetThreadSelectorEntry answers for a selector it holds nothing for. */
const ERROR_NOACCESS = 998;
const ERROR_INVALID_THREAD_ID = 1444;

/** The CONTEXT groups GetThreadContext fills, and the size of the record. */
const CONTEXT_CONTROL = 0x10001;
const CONTEXT_INTEGER = 0x10002;
const CONTEXT_SEGMENTS = 0x10004;
const CONTEXT_BYTES = 0x2cc;
/** The 32-bit CONTEXT's integer and control registers, by winnt.h's offsets. */
const CONTEXT_INTEGERS = /** @type {const} */ ([['edi', 0x9c], ['esi', 0xa0], ['ebx', 0xa4],
    ['edx', 0xa8], ['ecx', 0xac], ['eax', 0xb0]]);
const CONTEXT_CONTROLS = /** @type {const} */ ([['ebp', 0xb4], ['eip', 0xb8], ['eflags', 0xc0],
    ['esp', 0xc4]]);
/**
 * The 64-bit CONTEXT (winnt.h's CONTEXT_AMD64 groups): its flags, MXCSR, the
 * flags word, the sixteen general registers from RAX in the encoding's order,
 * RIP, and XMM0 onward. Control is RSP, RIP and the flags; integer the other
 * fifteen; floating point the XMM registers and MXCSR.
 */
const CONTEXT64 = Object.freeze({ FLAGS: 0x30, MXCSR: 0x34, EFLAGS: 0x44, RAX: 0x78, RIP: 0xf8,
    XMM0: 0x1a0, SIZE: 0x4d0 });
const CONTEXT64_CONTROL = 0x100001;
const CONTEXT64_INTEGER = 0x100002;
const CONTEXT64_FLOATING_POINT = 0x100008;
/** RSP's index among the sixteen general registers. */
const RSP_INDEX = 4;
/** The bits of ContextFlags that name a part of the context, the machine's bit aside. */
const CONTEXT_PARTS = 0x3f;
/** The 32-bit CONTEXT's head: its flags, then Dr0-Dr3, Dr6 and Dr7. */
const CONTEXT_DEBUG_BYTES = 0x1c;

/** Milliseconds from the FILETIME epoch (1601) to the Unix one, for thread times. */
const FILETIME_EPOCH_MS = 11644473600000;

/**
 * @typedef {Object} SyncHost
 * @property {ReturnType<typeof import('./named-objects.js').createNamedObjects>} [namedObjects]
 *           the run's one namespace, where a job made by name is found again
 * @property {any} kernel                        The kernel layer's API.
 * @property {{ major: number, build: number }} [windows]  The Windows the run is.
 * @property {(process: any, code: number) => any} [terminateProcess]  A job's process ended
 *           as TerminateProcess ends it, null for this one (`process-policy.js`).
 * @property {() => boolean} [debugged]  Whether this process's parent debugs it.
 * @property {import('./process-policy.js').ProcessPolicyHost['postCompletion']} [postCompletion]
 * @property {import('./process-policy.js').ProcessPolicyHost['cancelSynchronous']}
 *     [cancelSynchronous]
 * @property {import('./process-policy.js').ProcessPolicyHost['listen']} [listenJobs]  Where
 *     the jobs are told of a process that exited and of a job's handle closed.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, expected: number, value: number) => number} [compareExchangeU32]
 *           A dword swapped only if it holds `expected`, indivisible against the
 *           guest's threads on the process's other executors; answers what it held.
 * @property {(address: number, expected: bigint, value: bigint) => bigint} [compareExchangeU64]
 *           The same for a quadword, as `lock cmpxchg8b` takes one.
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
 * @property {import('./fpu-context.js').FloatState | null} [float]  the processor's
 *           images of a thread's x87 and SSE state
 * @property {() => Record<string, number>} [registers]  the running thread's
 * @property {(values: Record<string, number>) => void} [setRegisters]  the running
 *           thread's, where it goes on from (NtContinue)
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {import('./changes.js').WatchedVolume} [volume]
 *           The volume, for the directories a change notification watches;
 *           without it FindFirstChangeNotification is refused.
 * @property {import('./processor.js').Processors} processors  The process's
 *           processors and its affinity, which every other interface that
 *           counts or sets them shares.
 * @property {number} [processId]  This process's id, which a job's list names.
 * @property {number} [pointerSize]  8 in a 64-bit process, whose critical
 *           sections are 40 bytes and taken by traps; absent, 4.
 * @property {import('./cross-process.js').AskHost['askChild']} [askChild]
 *           A call made in a child where it runs: what a child's thread handle
 *           is suspended, resumed and read through. Absent, no child is reached.
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 */

/**
 * Builds the function table: name -> { argBytes, handler } for a trap, or
 * { argBytes, guest } for guest code, with a `handler` beside it where a
 * 64-bit process takes the call as a trap.
 *
 * `argBytes` is the size of the argument list the guest compiled against; all of
 * these are stdcall, the bridge's default, so none of them says so.
 *
 * @param {SyncHost} host
 */
export function createSyncFunctions(host){
    const { kernel } = host;
    const processors = host.processors;
    const cs = criticalLayout(host.pointerSize);
    // A HANDLE is a pointer: an array of them holds quadwords in a 64-bit
    // process, each a handle's dword in its low half.
    const handleSize = host.pointerSize ?? 4;

    /** @param {number} address @param {number} value */
    const writeI32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} address */
    const readI32 = address=>new DataView(host.readMemory(address, 4).buffer)
        .getInt32(0, true);

    /**
     * Adds to a section's LockCount as the fast paths' `lock inc` and `lock
     * dec` do, so a thread entering on another executor is not lost between
     * the read and the write; answers the count after.
     *
     * @param {number} section @param {number} delta
     */
    const addLockCount = (section, delta)=>{
        const at = section + cs.LOCK_COUNT;
        for (;;)
        {
            const was = readI32(at);
            const now = (was + delta) | 0;
            if (host.compareExchangeU32 === undefined)
            {
                writeI32(at, now);
                return now;
            }
            if ((host.compareExchangeU32(at, was >>> 0, now >>> 0) | 0) === was)
            {
                return now;
            }
        }
    };

    /** One more in the fast paths' counter at `offset`, for a section the host took or left. @param {number} offset */
    const tally = offset=>{
        const at = host.critical.counters() + offset;
        writeI32(at, readI32(at) + 1);
    };

    /**
     * Entering, leaving and trying a section as traps over the same fields
     * and queues the guest code below uses, for a 64-bit process, whose
     * processor runs none of that 32-bit code.
     */
    const sectionTraps = {
        /** @param {number[]} args */
        enter: ([pointer])=>{
            const section = wholeAddress(pointer);
            const me = host.currentThread().id;
            tally(COUNTERS.ENTERED);
            if (addLockCount(section, 1) === 0)
            {
                writeI32(section + cs.OWNING_THREAD, me);
                writeI32(section + cs.RECURSION_COUNT, 1);
                return 0;
            }
            if (readI32(section + cs.OWNING_THREAD) === me)
            {
                writeI32(section + cs.RECURSION_COUNT, readI32(section + cs.RECURSION_COUNT) + 1);
                return 0;
            }
            return host.critical.wait(section);
        },
        /** @param {number[]} args */
        leave: ([pointer])=>{
            const section = wholeAddress(pointer);
            tally(COUNTERS.LEFT);
            const recursion = readI32(section + cs.RECURSION_COUNT) - 1;
            writeI32(section + cs.RECURSION_COUNT, recursion);
            if (recursion !== 0)
            {
                addLockCount(section, -1);
                return 0;
            }
            writeI32(section + cs.OWNING_THREAD, 0);
            return addLockCount(section, -1) >= 0 ? host.critical.wake(section) : 0;
        },
        /** @param {number[]} args */
        tryEnter: ([pointer])=>{
            const section = wholeAddress(pointer);
            const me = host.currentThread().id;
            const at = section + cs.LOCK_COUNT;
            const free = host.compareExchangeU32 === undefined
                ? readI32(at) === CS_UNLOCKED && (writeI32(at, 0), true)
                : (host.compareExchangeU32(at, CS_UNLOCKED >>> 0, 0) | 0) === CS_UNLOCKED;
            if (free)
            {
                writeI32(section + cs.OWNING_THREAD, me);
                writeI32(section + cs.RECURSION_COUNT, 1);
            }
            else if (readI32(section + cs.OWNING_THREAD) === me)
            {
                addLockCount(section, 1);
                writeI32(section + cs.RECURSION_COUNT, readI32(section + cs.RECURSION_COUNT) + 1);
            }
            else
            {
                return 0;
            }
            tally(COUNTERS.ENTERED);
            return 1;
        },
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
     * The same routines in x86-64 for a 64-bit process, each placed with its
     * module by the loader: a contended entry or an owed wake jumps to a trap
     * into the same host half.
     *
     * @param {(counters: number) => { code: Uint8Array, jump: number }} make
     * @param {'wait' | 'wake'} trap
     */
    const longSection = (make, trap)=>(
        /** @type {{ register: (trap: any) => number, jump: (at: number, target: number) => void }} */
        builder)=>{
        const { code, jump } = make(host.critical.counters());
        builder.jump(jump, builder.register({
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>host.critical[trap](pointer >>> 0),
        }));
        return code;
    };

    /**
     * Where each interlocked export's code was placed, once, on the first
     * bind of any of them.
     *
     * @type {Map<string, number> | null}
     */
    let interlocked = null;
    /** @param {keyof typeof INTERLOCKED | keyof typeof INTERLOCKED_64} name */
    const interlockedAt = name=>{
        if (!interlocked)
        {
            const allocate = host.allocateCode ?? host.allocate;
            interlocked = new Map(Object.entries({ ...INTERLOCKED, ...INTERLOCKED_64 })
                .map(([exported, { code }])=>{
                    const at = allocate(code.length);
                    host.writeMemory(at, code);
                    return [exported, at];
                }));
        }
        return /** @type {number} */ (interlocked.get(name));
    };

    /**
     * An interlocked export: guest code, one locked instruction on the
     * program's dword (`interlocked.js`), with nothing to trap into; in a
     * 64-bit process its x86-64 (`long`).
     *
     * @param {keyof typeof INTERLOCKED | keyof typeof INTERLOCKED_64} name
     */
    const interlockedExport = name=>{
        const { argBytes, long } = name in INTERLOCKED
            ? INTERLOCKED[/** @type {keyof typeof INTERLOCKED} */ (name)]
            : INTERLOCKED_64[/** @type {keyof typeof INTERLOCKED_64} */ (name)];
        return { argBytes, guest: ()=>interlockedAt(name), long: ()=>long };
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
     * What a stopped thread will run with, as GetThreadContext reads it: its
     * saved registers, under what a SetThreadContext not yet run put in their
     * place - a caller that sets a context and reads it back sees its own.
     *
     * @param {any} thread
     */
    const stoppedRegisters = thread=>{
        const saved = savedRegisters(thread.context);
        const pending = thread.resumeRegisters;
        if (!pending)
        {
            return saved;
        }
        // A 64-bit thread's registers whole are read by `writeLongContext`.
        const registers = { ...pending };
        delete registers.long;
        return { ...saved, ...registers,
            ...thread.parkedReturn !== null && thread.parkedReturn !== undefined
                ? { eip: thread.parkedReturn >>> 0 } : {},
            ...thread.resumeStack !== null && thread.resumeStack !== undefined
                ? { esp: thread.resumeStack >>> 0 } : {} };
    };

    /**
     * A long-mode thread's sixteen general registers whole, its XMM registers
     * and MXCSR, from the state block its context saved. The first eight's low
     * dwords are the context's dword view, as a restore writes them over the
     * block: a thread made and not yet run has its stack pointer there alone,
     * and read from the block it had none (a context set from it sent the
     * thread off with RSP 0).
     *
     * @param {any} context
     */
    const savedLong = context=>{
        const { block, layout } = context;
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
        /** @param {number} index */
        const whole = index=>{
            const value = view.getBigUint64(layout.regs + index * 8, true);
            return index < 8
                ? (value & 0xffffffff00000000n) | BigInt(context.reg32[index] >>> 0)
                : value;
        };
        return {
            gpr: Array.from({ length: 16 }, (_, index)=>whole(index)),
            xmm: block.slice(layout.xmm, layout.xmm + 256),
            mxcsr: view.getUint32(layout.mxcsr, true),
        };
    };

    /**
     * GetThreadContext's answer for another thread of a 64-bit process: the
     * groups its flags ask for, in the 64-bit CONTEXT's layout.
     *
     * @param {number} at @param {any} thread
     */
    const writeLongContext = (at, thread)=>{
        const bytes = host.readMemory(at, CONTEXT64.SIZE);
        const view = new DataView(bytes.buffer);
        const flags = view.getUint32(CONTEXT64.FLAGS, true);
        const long = thread.resumeRegisters?.long ?? savedLong(thread.context);
        const { eip, eflags } = stoppedRegisters(thread);
        const gpr = [...long.gpr];
        if (!thread.resumeRegisters?.long && thread.resumeStack !== null
            && thread.resumeStack !== undefined)
        {
            gpr[RSP_INDEX] = BigInt(thread.resumeStack >>> 0);
        }
        /** @param {number} index */
        const put = index=>view.setBigUint64(CONTEXT64.RAX + index * 8,
            BigInt.asUintN(64, gpr[index]), true);
        if ((flags & CONTEXT64_INTEGER) === CONTEXT64_INTEGER)
        {
            gpr.forEach((_, index)=>index !== RSP_INDEX && put(index));
        }
        if ((flags & CONTEXT64_CONTROL) === CONTEXT64_CONTROL)
        {
            put(RSP_INDEX);
            view.setBigUint64(CONTEXT64.RIP, BigInt(thread.parkedReturn ?? eip ?? 0), true);
            view.setUint32(CONTEXT64.EFLAGS, eflags ?? 0x202, true);
        }
        if ((flags & CONTEXT64_FLOATING_POINT) === CONTEXT64_FLOATING_POINT)
        {
            bytes.set(long.xmm.subarray(0, 256), CONTEXT64.XMM0);
            view.setUint32(CONTEXT64.MXCSR, long.mxcsr >>> 0, true);
        }
        host.writeMemory(at, bytes);
    };

    /**
     * SetThreadContext's work on a stopped thread: the groups the record's
     * flags name, applied where it next runs. A thread parked in a wait keeps
     * its wait's continuation when the record moves no control register.
     *
     * @param {any} thread @param {number} at
     */
    const replaceContext = (thread, at)=>{
        const parked = thread.parkedReturn !== null && thread.parkedReturn !== undefined;
        /** @type {Record<string, any>} */
        const values = {};
        if (handleSize === 4)
        {
            const bytes = host.readMemory(at, CONTEXT_BYTES);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const flags = view.getUint32(0, true);
            for (const [group, fields] of /** @type {const} */ ([
                [CONTEXT_INTEGER, CONTEXT_INTEGERS], [CONTEXT_CONTROL, CONTEXT_CONTROLS]]))
            {
                for (const [name, offset] of (flags & group) === group ? fields : [])
                {
                    values[name] = view.getUint32(offset, true);
                }
            }
            const groups = floatGroupsOf(bytes, flags);
            if (groups !== null && host.float?.restore(thread.context, groups) !== true)
            {
                host.divergence?.('SetThreadContext',
                    'the floating-point registers of a context are not put back');
            }
        }
        else
        {
            const bytes = host.readMemory(at, CONTEXT64.SIZE);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const flags = view.getUint32(CONTEXT64.FLAGS, true);
            const long = { ...thread.resumeRegisters?.long ?? savedLong(thread.context) };
            const gpr = [...long.gpr];
            /** @param {number} index */
            const take = index=>{
                gpr[index] = view.getBigUint64(CONTEXT64.RAX + index * 8, true);
            };
            if ((flags & CONTEXT64_INTEGER) === CONTEXT64_INTEGER)
            {
                gpr.forEach((_, index)=>index !== RSP_INDEX && take(index));
            }
            if ((flags & CONTEXT64_CONTROL) === CONTEXT64_CONTROL)
            {
                take(RSP_INDEX);
                values.esp = Number(BigInt.asUintN(32, gpr[RSP_INDEX]));
                values.eip = Number(view.getBigUint64(CONTEXT64.RIP, true));
                values.eflags = view.getUint32(CONTEXT64.EFLAGS, true);
            }
            if ((flags & CONTEXT64_FLOATING_POINT) === CONTEXT64_FLOATING_POINT)
            {
                long.xmm = bytes.slice(CONTEXT64.XMM0, CONTEXT64.XMM0 + 256);
                long.mxcsr = view.getUint32(CONTEXT64.MXCSR, true);
            }
            values.long = { ...long, gpr };
            // RAX whole goes with the rest; its low dword is what the resume answers.
            values.eax = Number(BigInt.asUintN(32, gpr[0]));
        }
        const { eip, esp, ...registers } = values;
        const merged = { ...thread.resumeRegisters ?? {}, ...registers };
        if (eip === undefined && parked)
        {
            thread.resumeRegisters = merged;
            return;
        }
        kernel.scheduleResume(thread, {
            eip: eip ?? (parked ? thread.parkedReturn : thread.context.eip),
            // A 64-bit stack pointer moves whole with the other registers.
            esp: esp ?? (parked ? thread.resumeStack ?? undefined : undefined),
            returnValue: parked ? thread.waitResult ?? 0 : thread.context.reg32[0] >>> 0,
            registers: merged,
        });
    };

    /**
     * Writes the groups of a CONTEXT its ContextFlags name, and nothing else;
     * the floating-point ones from a stopped thread's state block, the debug
     * registers from what the thread was given (`debug-registers.js`).
     *
     * @param {number} at @param {Record<string, number>} registers
     * @param {any} thread
     * @param {any} [context]  The stopped thread's.
     */
    const writeThreadContext = (at, registers, thread, context)=>{
        const bytes = host.readMemory(at, CONTEXT_BYTES);
        const view = new DataView(bytes.buffer);
        const flags = view.getUint32(0, true);
        /** @param {number} offset @param {number | undefined} value */
        const put = (offset, value)=>view.setUint32(offset, (value ?? 0) >>> 0, true);
        writeDebugGroup(thread, bytes, flags);
        if ((flags & CONTEXT_SEGMENTS) === CONTEXT_SEGMENTS)
        {
            put(0x8c, SELECTORS.GS);
            put(0x90, SELECTORS.FS);
            put(0x94, SELECTORS.DATA);
            put(0x98, SELECTORS.DATA);
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
            put(0xbc, SELECTORS.CODE);
            put(0xc0, registers.eflags ?? 0x202);
            put(0xc4, registers.esp);
            put(0xc8, SELECTORS.DATA);
        }
        // The calling thread's own as they stand, another's from where it stopped.
        writeFloatGroups(host.float?.images(context) ?? null, bytes, flags);
        host.writeMemory(at, bytes);
    };

    /**
     * The four FILETIMEs GetThreadTimes and GetProcessTimes write, a slot of
     * zero left alone. The clock this build keeps is one wall clock, so the
     * creation time is now and the exit time now for one that has ended and
     * zero otherwise. The processor time is the slices the scheduler gave,
     * all of it user time: a benchmark divides it by the time that passed to
     * say how busy its threads kept the processors.
     *
     * @param {number[]} slots  creation, exit, kernel, user
     * @param {boolean} ended
     * @param {number} [userMs]
     */
    const writeTimes = ([creation, exit, kernelTime, userTime], ended, userMs = 0)=>{
        const now = BigInt(Math.floor(kernel.clock.wallClock() + FILETIME_EPOCH_MS)) * 10000n;
        /** @param {number} address @param {bigint} value */
        const write = (address, value)=>{
            if ((address >>> 0) !== 0)
            {
                const bytes = new Uint8Array(8);
                new DataView(bytes.buffer).setBigInt64(0, value, true);
                host.writeMemory(wholeAddress(address), bytes);
            }
        };
        write(creation, now);
        write(exit, ended ? now : 0n);
        write(kernelTime, 0n);
        write(userTime, BigInt(Math.round(userMs * 10000)));
        return 1;
    };

    /**
     * The same call made on a child's first thread, where the child runs, when
     * the handle is the one CreateProcess handed out for it; null otherwise.
     *
     * @param {number} handle @param {string} name
     * @param {import('./cross-process.js').CrossArg[]} rest  after the thread
     * @param {(number | null)[]} [into]  after the thread
     * @returns {number | Promise<number> | null}
     */
    const onChildThread = (handle, name, rest, into = [])=>{
        /** @type {import('./cross-process.js').ChildThread | null} */
        const child = (handle >>> 0) === CURRENT_THREAD ? null : object(handle, 'process-thread');
        if (!child)
        {
            return null;
        }
        const asked = host.setLastErrorFor ? askChild({ askChild: host.askChild,
            writeMemory: host.writeMemory, currentThread: host.currentThread,
            setLastErrorFor: host.setLastErrorFor }, child.process,
        { call: name, args: [threadArg(child), ...rest] }, [null, ...into]) : null;
        if (asked === null)
        {
            host.setLastError?.(ERROR_ACCESS_DENIED);
            return name === 'SuspendThread' || name === 'ResumeThread' ? WAIT_FAILED : 0;
        }
        return asked;
    };

    /**
     * A native call on a thread of a child, made where the child runs: its
     * NTSTATUS, STATUS_ACCESS_DENIED for a child the run cannot ask; null
     * for a handle that names no child's thread.
     *
     * @param {number} handle @param {string} name
     * @param {import('./cross-process.js').CrossArg[]} rest @param {(number | null)[]} into
     * @returns {number | Promise<number> | null}
     */
    const onChildNative = (handle, name, rest, into)=>{
        /** @type {import('./cross-process.js').ChildThread | null} */
        const child = (handle >>> 0) === CURRENT_THREAD ? null : object(handle, 'process-thread');
        if (!child)
        {
            return null;
        }
        const asked = host.setLastErrorFor ? askChild({ askChild: host.askChild,
            writeMemory: host.writeMemory, currentThread: host.currentThread,
            setLastErrorFor: host.setLastErrorFor }, child.process,
        { call: name, args: [threadArg(child), ...rest] }, [null, ...into],
        // A child gone, or one that refused the call, answers no buffers:
        // refused, never a success of 0.
        (answer, result)=>(answer.outs.every(bytes=>!bytes) ? STATUS_ACCESS_DENIED : result))
            : null;
        return asked ?? STATUS_ACCESS_DENIED;
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
        host.writeMemory(address, new Uint8Array(cs.SIZE));
        host.writeMemory(address, new Uint8Array(host.pointerSize ?? 4).fill(0xff));
        writeI32(address + cs.LOCK_COUNT, CS_UNLOCKED);
        writeI32(address + cs.SPIN_COUNT, spinCount);
    };

    return {
        // Jobs, policies, power requests, the cycle counters and the stack:
        // what a sandboxing browser asks before anything else.
        ...createProcessPolicyFunctions({
            kernel,
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            setLastError: host.setLastError,
            currentThread: host.currentThread,
            registers: host.registers,
            setRegisters: host.setRegisters,
            float: host.float,
            divergence: host.divergence,
            pointerSize: host.pointerSize,
            processId: host.processId,
            namedObjects: host.namedObjects,
            threadOf,
            objectOf: object,
            processors,
            terminateProcess: host.terminateProcess,
            debugged: host.debugged,
            postCompletion: host.postCompletion,
            listen: host.listenJobs,
            cancelSynchronous: host.cancelSynchronous,
        }),
        ...createThreadInfoFunctions({
            kernel,
            processors,
            pointerSize: host.pointerSize,
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            currentThread: host.currentThread,
            park: host.park,
            setLastError: host.setLastError,
            allocate: host.allocate,
            divergence: host.divergence,
            onChildThread: onChildNative,
            threadTimes: (handle, at)=>{
                const thread = threadOf(handle);
                writeTimes([at, at + 8, at + 16, at + 24],
                    (thread?.exitCode ?? null) !== null, thread?.cpuMs ?? 0);
            },
        }),

        /**
         * VOID ReinitializeCriticalSection(LPCRITICAL_SECTION lpCriticalSection):
         * the section made new again, as InitializeCriticalSection makes it,
         * whatever was waiting on it forgotten with it.
         */
        ReinitializeCriticalSection: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                initialise(wholeAddress(pointer), 0);
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
                initialise(wholeAddress(pointer), 0);
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
                initialise(wholeAddress(pointer), spinCount | 0);
                return 1;
            },
        },

        /**
         * BOOL InitializeCriticalSectionEx(LPCRITICAL_SECTION, DWORD dwSpinCount,
         *     DWORD Flags)
         *
         * As InitializeCriticalSectionAndSpinCount, with no debug information
         * unless RTL_CRITICAL_SECTION_FLAG_FORCE_DEBUG_INFO asks for it, as
         * Windows 8 on; a flag outside the high byte the flags occupy is
         * refused.
         */
        InitializeCriticalSectionEx: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, spinCount, flags])=>{
                if (((flags >>> 0) & ~CS_FLAG_BITS) !== 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                initialise(wholeAddress(pointer), spinCount & 0x00ffffff);
                if (((flags >>> 0) & CS_FORCE_DEBUG_INFO) !== 0)
                {
                    // RTL_CRITICAL_SECTION_DEBUG: 0x20 bytes, 0x30 with 64-bit pointers.
                    const debugSize = handleSize === 8 ? 0x30 : 0x20;
                    const debug = host.allocate(debugSize);
                    if (debug !== 0)
                    {
                        host.writeMemory(debug, new Uint8Array(debugSize));
                        // CriticalSection, the pointer after Type and CreatorBackTraceIndex.
                        const width = pointerWidth(handleSize);
                        host.writeMemory(debug + handleSize, width.bytes(wholeAddress(pointer)));
                        // DebugInfo, the section's first field, which initialise set to -1.
                        host.writeMemory(wholeAddress(pointer), width.bytes(debug));
                    }
                }
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
                const at = wholeAddress(pointer) + cs.SPIN_COUNT;
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
            long: ()=>tryEnterLongCode(host.critical.counters()),
            handler: sectionTraps.tryEnter,
        },

        /**
         * VOID DeleteCriticalSection(LPCRITICAL_SECTION lpCriticalSection)
         *
         * The section is left free, as Wine's RtlDeleteCriticalSection leaves
         * it (LockCount -1, no owner, no debug record): a program that enters
         * a section after deleting it, as Crysis's renderer does on its way
         * out, takes it on Windows. Zeroed whole, its count read as held by
         * nobody, and that entry waited for good.
         */
        DeleteCriticalSection: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const address = wholeAddress(pointer);
                host.critical.forget(address);
                host.writeMemory(address, new Uint8Array(cs.SIZE));
                writeI32(address + cs.LOCK_COUNT, CS_UNLOCKED);
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
            long: longSection(enterLongCode, 'wait'),
            handler: sectionTraps.enter,
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
            long: longSection(leaveLongCode, 'wake'),
            handler: sectionTraps.leave,
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
        InterlockedCompareExchange64: interlockedExport('InterlockedCompareExchange64'),

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
                const view = new DataView(
                    host.readMemory(wholeAddress(handles), total * handleSize).buffer);
                /** @type {any[]} */
                const objects = [];
                /** Where each of `objects` sits in the caller's handle array. */
                /** @type {number[]} */
                const indices = [];
                for (let at = 0; at < total; at++)
                {
                    const handle = view.getUint32(at * handleSize, true);
                    // No pseudo-handle is a member of a set, not even the two
                    // WaitForSingleObject takes: none is in the table.
                    const target = isStandardHandle(handle) ? alwaysReady() : object(handle);
                    if (!target)
                    {
                        host.setLastError?.(ERROR_INVALID_HANDLE);
                        return WAIT_FAILED;
                    }
                    // One opened without SYNCHRONIZE fails the whole wait.
                    if (!isStandardHandle(handle)
                        && !allows(kernel.handles.access(untagged(handle)), SYNCHRONIZE))
                    {
                        host.setLastError?.(ERROR_ACCESS_DENIED);
                        return WAIT_FAILED;
                    }
                    // A child process is in a set as the event its exit sets,
                    // one already set for one the engine answered for; a
                    // child's thread as the one this process sets once the
                    // child says it has ended.
                    const kind = kernel.handles.typeOf(untagged(handle));
                    objects.push(kind === 'process' ? target.exited
                        : kind === 'process-thread'
                            ? threadEnd({ kernel, askChild: host.askChild }, target)
                            : FILE_OBJECT_KINDS.has(kind ?? '') ? alwaysReady()
                                : target.waitable ?? target);
                    indices.push(at);
                }

                // A wait for all of a set may not name one object twice, under
                // one handle or two (NtWaitForMultipleObjects answers
                // STATUS_INVALID_PARAMETER_MIX): taking it once for each made
                // the second take of a semaphore with one count block for good.
                if (waitAll && new Set(objects).size < objects.length)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return WAIT_FAILED;
                }

                const thread = host.currentThread();

                // Zero is a poll: it asks whether the set is ready now and
                // never blocks, so a program checking is not stopped by the
                // question.
                const wait = wholeAddress(timeout);
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
                    (thread.exitCode ?? null) !== null, thread.cpuMs ?? 0);
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
                // A child's processor time is its own scheduler's, not known here.
                return writeTimes([creation, exit, kernelTime, userTime], child !== null
                    && (child.completed || child.exitCode !== kernel.processes.STILL_ACTIVE),
                child === null ? kernel.processCpuMs() : 0);
            },
        },

        /**
         * BOOL GetSystemTimes(LPFILETIME lpIdleTime, LPFILETIME lpKernelTime,
         *     LPFILETIME lpUserTime)
         *
         * The machine's processor time since it started, summed over its
         * processors: user time is what this process's threads ran, idle
         * the rest, and kernel time includes the idle time, as Windows
         * counts it. Each pointer may be null.
         */
        GetSystemTimes: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([idle, kernelTime, userTime])=>{
                const total = kernel.clock.virtualTime() * processors.count();
                const busy = Math.min(kernel.processCpuMs(), total);
                /** @param {number} address @param {number} ms */
                const write = (address, ms)=>{
                    if ((address >>> 0) !== 0)
                    {
                        const bytes = new Uint8Array(8);
                        new DataView(bytes.buffer).setBigUint64(0,
                            BigInt(Math.round(ms * 10000)), true);
                        host.writeMemory(wholeAddress(address), bytes);
                    }
                };
                write(idle, total - busy);
                write(kernelTime, total - busy);
                write(userTime, busy);
                return 1;
            },
        },

        /**
         * DWORD_PTR SetThreadAffinityMask(HANDLE hThread, DWORD_PTR dwThreadAffinityMask)
         *
         * The processors a thread may run on, which the scheduler keeps it to,
         * and the mask it had before -- its process's, until one is set. A
         * mask naming none of the process's processors, or one it does not
         * have, is ERROR_INVALID_PARAMETER and 0 (`threadMaskFor`). A thread
         * that moves itself off the processor it is on gives up its turn, so
         * it is on one of the new ones before the call returns: a program that
         * pins itself to each processor in turn reads each one's APIC id next.
         */
        SetThreadAffinityMask: {
            returns: 'pointer',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, mask])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const wanted = processors.threadMaskFor(mask);
                if (wanted === 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const previous = processors.threadMask(thread);
                thread.affinityMask = wanted;
                const self = host.currentThread();
                if (thread === self && (wanted >>> processors.processorOf(self) & 1) === 0)
                {
                    // Woken at once with the answer: the scheduler gives the
                    // thread an allowed processor when it next chooses.
                    kernel.block(self, 'SetThreadAffinityMask', {
                        deadline: kernel.clock.virtualTime(),
                        result: previous,
                    });
                    return host.park();
                }
                return previous;
            },
        },

        /**
         * BOOL GetThreadGroupAffinity(HANDLE hThread, PGROUP_AFFINITY GroupAffinity)
         *
         * The thread's mask in the one processor group a machine of fewer than
         * 64 processors has: GROUP_AFFINITY's KAFFINITY Mask, a pointer wide,
         * then the group, zero, and three reserved words, zero. No structure
         * to fill is ERROR_INVALID_PARAMETER (Wine's kernel32
         * test_thread_processor), never a fault.
         */
        GetThreadGroupAffinity: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                if (wholeAddress(out) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const bytes = new Uint8Array(handleSize + 8);
                new DataView(bytes.buffer).setUint32(0, processors.threadMask(thread) >>> 0, true);
                host.writeMemory(wholeAddress(out), bytes);
                return 1;
            },
        },

        /**
         * DWORD SetThreadIdealProcessor(HANDLE hThread, DWORD dwIdealProcessor)
         *
         * The processor a thread would prefer to run on: recorded, and the
         * previous one handed back. MAXIMUM_PROCESSORS only reads it; a
         * processor the machine does not have is (DWORD)-1 with
         * ERROR_INVALID_PARAMETER (Wine's kernel32 test_thread_processor).
         */
        SetThreadIdealProcessor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, ideal])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0xffffffff;
                }
                const previous = thread.idealProcessor ?? 0;
                const asked = wholeAddress(ideal);
                if (asked === MAXIMUM_PROCESSORS)
                {
                    return previous;
                }
                if (asked >= processors.count())
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0xffffffff;
                }
                thread.idealProcessor = asked;
                return previous;
            },
        },

        /**
         * BOOL GetThreadContext(HANDLE hThread, LPCONTEXT lpContext)
         *
         * The groups ContextFlags asks for, from the running registers for
         * the calling thread and from the state saved when another was last
         * switched away -- one running on another executor brought back first,
         * so a thread SuspendThread stopped is read where it stopped. A thread
         * that has ended has no context to read.
         */
        GetThreadContext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                // The flags it asks for travel in the structure, and the rest comes back.
                const child = onChildThread(handle, 'GetThreadContext',
                    [{ inout: host.readMemory(wholeAddress(out),
                        CONTEXT_BYTES) }], [wholeAddress(out)]);
                if (child !== null)
                {
                    return child;
                }
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
                const own = thread === host.currentThread();
                // A thread stopped at a debug event for an exception goes on
                // from the context its exception carries: that is its context.
                if (!own && handleSize === 4 && thread.debugStop)
                {
                    const wanted = host.readMemory(wholeAddress(out), CONTEXT_BYTES);
                    const record = host.readMemory(wholeAddress(thread.debugStop),
                        CONTEXT_BYTES);
                    record.set(wanted.subarray(0, 4), 0);
                    mergeContextGroups(wanted, record);
                    host.writeMemory(wholeAddress(out), wanted);
                    return 1;
                }
                const answer = ()=>{
                    if (handleSize === 8 && !own)
                    {
                        writeLongContext(wholeAddress(out), thread);
                        return 1;
                    }
                    writeThreadContext(wholeAddress(out),
                        own ? host.registers?.() ?? {} : stoppedRegisters(thread), thread,
                        own ? undefined : thread.context);
                    return 1;
                };
                // Windows answers for a suspended thread once it has stopped:
                // SuspendThread only asks, and GetThreadContext is how a caller
                // waits for the stop. A thread still running on another executor
                // that could not be brought back at once is waited for, the caller
                // parked: answered from where it was last placed, the registers
                // name a stack the thread is still writing, which a collector
                // that walks a suspended thread's stack reads as its frames.
                if (!own && kernel.settleThread(thread) === false)
                {
                    return kernel.settledThread(thread).then(answer);
                }
                return answer();
            },
        },

        /**
         * BOOL SetThreadContext(HANDLE hThread, const CONTEXT *lpContext)
         *
         * The groups ContextFlags names replace the thread's registers where
         * it next runs, as Windows replaces the context a thread returns to
         * user mode with: one stopped between instructions goes on from the
         * new context; one waiting in a call into the system finishes the
         * wait and then returns into it, not into its caller. What a .NET
         * runtime's collector does to a thread it suspended in managed code:
         * it sends it to a stub that waits for the collection to end. Put
         * through the resume the switch applies (`scheduleResume`), the one
         * place a stopped thread's continuation is decided. A thread running
         * on another executor is brought back first, as GetThreadContext
         * does. The calling thread's own context is refused, as before.
         * A 32-bit context's x87 and SSE state goes back with the rest (`fpu-context.js`).
         */
        SetThreadContext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, context])=>{
                const child = onChildThread(handle, 'SetThreadContext',
                    [{ in: host.readMemory(wholeAddress(context), CONTEXT_BYTES) }]);
                if (child !== null)
                {
                    return child;
                }
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                // Stopped at a debug event for an exception, it goes on from the
                // exception's context once continued: that is what is replaced.
                if (thread !== host.currentThread() && handleSize === 4 && thread.debugStop)
                {
                    const record = host.readMemory(wholeAddress(thread.debugStop),
                        CONTEXT_BYTES);
                    mergeContextGroups(record,
                        host.readMemory(wholeAddress(context), CONTEXT_BYTES));
                    host.writeMemory(wholeAddress(thread.debugStop), record);
                    return 1;
                }
                // The debug registers are the thread's to keep, its own
                // included (`debug-registers.js`); a record that names nothing
                // else is done once they are kept.
                const head = handleSize === 4
                    ? host.readMemory(wholeAddress(context), CONTEXT_DEBUG_BYTES) : null;
                const headFlags = head === null ? 0 : new DataView(head.buffer, head.byteOffset,
                    CONTEXT_DEBUG_BYTES).getUint32(0, true);
                const debug = head === null ? null : debugGroupOf(head, headFlags);
                if (debug !== null && (headFlags & CONTEXT_PARTS & ~CONTEXT_DEBUG_REGISTERS) === 0)
                {
                    setDebugRegisters(thread, debug, host.divergence, 'SetThreadContext');
                    return 1;
                }
                if (kernel.ThreadState && thread.state === kernel.ThreadState.TERMINATED)
                {
                    host.setLastError?.(ERROR_GEN_FAILURE);
                    return 0;
                }
                if (thread === host.currentThread() || !kernel.scheduleResume)
                {
                    host.divergence?.('SetThreadContext',
                        'the calling thread\'s own registers are not replaced');
                    host.setLastError?.(ERROR_ACCESS_DENIED);
                    return 0;
                }
                const at = wholeAddress(context);
                const apply = ()=>{
                    replaceContext(thread, at);
                    if (debug !== null)
                    {
                        setDebugRegisters(thread, debug, host.divergence, 'SetThreadContext');
                    }
                    return 1;
                };
                if (kernel.settleThread(thread) === false)
                {
                    return kernel.settledThread(thread).then(apply);
                }
                return apply();
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
                    : index === (SELECTORS.CODE & ~3) ? [0, 0xfffff, 0x1b, 3, true]
                        : index === (SELECTORS.DATA & ~3) ? [0, 0xfffff, 0x13, 3, true]
                            : index === (SELECTORS.FS & ~3)
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
                host.writeMemory(wholeAddress(out), bytes);
                return 1;
            },
        },

        /** DWORD SuspendThread(HANDLE hThread) */
        SuspendThread: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const child = onChildThread(handle, 'SuspendThread', []);
                if (child !== null)
                {
                    return child;
                }
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
                // A child's first thread is resumed where the child runs: one
                // made CREATE_SUSPENDED runs its first instruction now.
                const child = onChildThread(handle, 'ResumeThread', []);
                if (child !== null)
                {
                    return child;
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
                return wholeAddress(previous);
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
        ...createSlimSync(host, builder=>placed(builder).enter, sectionTraps.enter),

        // Interlocked singly linked lists over the header the program owns.
        ...createSListFunctions(host),
    };
}

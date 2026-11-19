/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a sandboxing browser asks of the process it runs in before it does
 * anything else: job objects to put its children in, mitigation and DEP
 * policies, thread and process information classes, power requests, the
 * memory resource notifications, the cycle counters, and its own stack.
 *
 * Most of it is state a program sets and reads back -- a policy, a limit, a
 * request -- with nothing here to enforce it: there is no second address
 * space to fence and no power manager to keep awake. What is kept is what a
 * program can observe: the value it set, the sizes and classes Windows
 * accepts, the errors for the ones it refuses.
 */

import { blockLayouts } from './teb.js';
import { SELECTORS } from './seh.js';
import { floatGroupsOf } from './fpu-context.js';
import { debugGroupOf, setDebugRegisters } from './debug-registers.js';
import { PROCESSOR } from './processor.js';
import { TAKEN } from './named-objects.js';
import { OBJ_OPENIF, nameToWalk, readObjectAttributes } from './object-attributes.js';
import { STATUS } from '../ntdll/status.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
/** GetExitCodeProcess's answer for a process that runs. */
const STILL_ACTIVE = 0x103;
const ERROR_INVALID_HANDLE = 6;
const ERROR_BAD_LENGTH = 24;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_FOUND = 1168;
const ERROR_PRIVILEGE_NOT_HELD = 1314;
const ERROR_MORE_DATA = 234;
const ERROR_ALREADY_EXISTS = 183;

const CURRENT_PROCESS = 0xffffffff;
const E_INVALIDARG = 0x80070057;

/** CONTEXT_i386 with its control, integer and segment groups: RtlCaptureContext's set. */
const CONTEXT_FULL_SEGMENTS = 0x00010007;
/** The segment, integer and control fields: SegGs up to SegSs. */
const CONTEXT_CAPTURED_FROM = 0x8c;
const CONTEXT_CAPTURED_END = 0xcc;
/** CONTEXT_i386's groups, each a bit beside the i386 one. */
const CONTEXT_CONTROL = 0x1;
const CONTEXT_INTEGER = 0x2;
/** The 32-bit CONTEXT's size. */
const CONTEXT_BYTES = 0x2cc;
/** Where each register a context restores stands in it, by group. */
const CONTEXT_INTEGERS = /** @type {const} */ ([['edi', 0x9c], ['esi', 0xa0], ['ebx', 0xa4],
    ['edx', 0xa8], ['ecx', 0xac], ['eax', 0xb0]]);
const CONTEXT_CONTROLS = /** @type {const} */ ([['ebp', 0xb4], ['eip', 0xb8], ['eflags', 0xc0],
    ['esp', 0xc4]]);
const STATUS_ACCESS_VIOLATION = 0xc0000005;

/** JOBOBJECTINFOCLASS, the classes a 32-bit process sets or reads, and their sizes. */
const JOB = Object.freeze({
    BASIC_ACCOUNTING: 1,
    BASIC_LIMIT: 2,
    BASIC_PROCESS_ID_LIST: 3,
    BASIC_UI_RESTRICTIONS: 4,
    SECURITY_LIMIT: 5,
    END_OF_JOB_TIME: 6,
    ASSOCIATE_COMPLETION_PORT: 7,
    BASIC_AND_IO_ACCOUNTING: 8,
    EXTENDED_LIMIT: 9,
    GROUP: 11,
    CPU_RATE_CONTROL: 15,
});
/** JOBOBJECT_BASIC_LIMIT_INFORMATION: two LARGE_INTEGERs, then seven words, padded to 8. */
const BASIC_LIMIT_BYTES = 48;
/** Its LimitFlags, and the one limit kept to: the job's processes end with its last handle. */
const LIMIT_FLAGS = 16;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** A child may leave the job when it asks to (CREATE_BREAKAWAY_FROM_JOB). */
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
/** A child leaves the job without asking. */
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
/**
 * The messages a job posts to its completion port (winnt.h's JOB_OBJECT_MSG_*),
 * each as the packet's byte count, with the job's key as the completion key
 * and the process id as the OVERLAPPED pointer.
 */
const JOB_OBJECT_MSG = Object.freeze({
    ACTIVE_PROCESS_ZERO: 4,
    NEW_PROCESS: 6,
    EXIT_PROCESS: 7,
    ABNORMAL_EXIT_PROCESS: 8,
});
/** The basic limits, IO_COUNTERS, then four SIZE_Ts. */
const EXTENDED_LIMIT_BYTES = BASIC_LIMIT_BYTES + 48 + 16;
/**
 * The sizes of the classes kept as they were set and read back as they were.
 *
 * @type {Map<number, number>}
 */
const KEPT_JOB_CLASSES = new Map([
    [JOB.BASIC_UI_RESTRICTIONS, 4],
    [JOB.END_OF_JOB_TIME, 4],
    [JOB.ASSOCIATE_COMPLETION_PORT, 8],
    [JOB.GROUP, 2],
    [JOB.CPU_RATE_CONTROL, 8],
]);

/**
 * PROCESS_MITIGATION_POLICY's members: ProcessDEPPolicy is a DWORD of flags
 * and a BOOLEAN (eight bytes with its padding), every other one a DWORD of
 * flags. Win10 2004 knows these up to ProcessUserShadowStackPolicy.
 */
const DEP_POLICY = 0;
const ASLR_POLICY = 1;
const MITIGATION_POLICIES = 17;
/** ProcessDEPPolicy's own: enabled, ATL thunk emulation off. */
const PROCESS_DEP_ENABLE = 0x1;
const PROCESS_DEP_DISABLE_ATL_THUNK_EMULATION = 0x2;

/**
 * PROCESS_INFORMATION_CLASS sizes SetProcessInformation takes, on a 32-bit process.
 *
 * @type {Map<number, number>}
 */
/** MEMORY_PRIORITY_INFORMATION's default. */
const MEMORY_PRIORITY_NORMAL = 5;
const PROCESS_INFORMATION_SIZES = new Map([
    [0, 4], // ProcessMemoryPriority: MEMORY_PRIORITY_INFORMATION
    [1, 12], // ProcessMemoryExhaustionInfo: USHORT, USHORT, ULONG, ULONG_PTR
    [4, 12], // ProcessPowerThrottling: PROCESS_POWER_THROTTLING_STATE
    [5, 4], // ProcessReservedValue1
    [6, 4], // ProcessTelemetryCoverageInfo
    [7, 4], // ProcessProtectionLevelInfo
    [8, 4], // ProcessLeapSecondInfo
]);
/**
 * THREAD_INFORMATION_CLASS sizes SetThreadInformation takes.
 *
 * @type {Map<number, number>}
 */
const THREAD_INFORMATION_SIZES = new Map([
    [0, 4], // ThreadMemoryPriority
    [1, 4], // ThreadAbsoluteCpuPriority
    [2, 4], // ThreadDynamicCodePolicy
    [3, 12], // ThreadPowerThrottling: THREAD_POWER_THROTTLING_STATE
]);

/** POWER_REQUEST_TYPE: display, system, away mode, execution. */
const POWER_REQUEST_TYPES = 4;

/** MEMORY_RESOURCE_NOTIFICATION_TYPE. */
const LOW_MEMORY = 0;
const HIGH_MEMORY = 1;

/** FIRMWARE_TYPE: what a machine that boots Windows 10 has. */
const FIRMWARE_TYPE_UEFI = 2;

/**
 * The handle values a probe for open handles walks, from the table's first
 * (`kernel/internal/handles.js`), when the kernel does not count them itself.
 */
const FIRST_HANDLE = 0x40;
const HANDLE_PROBE = 1 << 20;

/**
 * @typedef {Object} ProcessPolicyHost
 * @property {any} kernel
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} [setLastError]
 * @property {() => any} currentThread
 * @property {() => Record<string, number>} [registers]
 * @property {number} [pointerSize]
 * @property {(handle: number) => any} threadOf  A thread by handle, the pseudo-handle its own.
 * @property {(thread: any, block?: number) => number} [cancelSynchronous]  Ends cancelled
 *     the synchronous I/O a thread waits in - the one whose IO_STATUS_BLOCK is `block`,
 *     when given - how many there were: a pipe's reads, writes and connects.
 * @property {(handle: number, type?: string) => any} objectOf  A kernel object by handle, or null.
 * @property {(process: any, code: number) => any} [terminateProcess]  A process ended as
 *     TerminateProcess ends it, null for this one (which does not return: its answer is the park).
 * @property {number} [processId]  This process's id, which a job's id list names.
 * @property {() => boolean} [debugged]  Whether this process's parent debugs it.
 * @property {ReturnType<typeof import('./named-objects.js').createNamedObjects>} [namedObjects]
 *     the run's one namespace, where a job made by name is found again
 * @property {{ count: () => number, systemMask: () => number }} [processors]  The
 *     machine's processors, all of them on its one NUMA node.
 * @property {import('./fpu-context.js').FloatState | null} [float]  The processor's
 *           images of a thread's x87 and SSE state.
 * @property {(values: Record<string, number>) => void} [setRegisters]  The running
 *           thread's registers, EIP and ESP among them: where it goes on from.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(port: any, packet: { transferred: number, key: number, overlapped: number })
 *     => void} [postCompletion]  A packet posted to a completion port object.
 * @property {(events: { exited: (process: any, code: number) => void,
 *     closed: (job: any) => void, started: (process: any) => void,
 *     refusesBreakaway: () => boolean,
 *     listed: (handles: number[]) => any[] | null }) => void} [listen]
 *     Where a job is told of a process of this one's that has exited, of a job's
 *     handle closed, and of a child this one started, and asked whether a child
 *     may break away.
 */

/** @param {ProcessPolicyHost} host */
export function createProcessPolicyFunctions(host){
    const { kernel } = host;
    const wide = host.pointerSize === 8;

    /** @param {number} code */
    const fail = code=>{
        host.setLastError?.(code);
        return 0;
    };
    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };
    /** The machine's processors, all on node 0: one when nothing says. */
    const processorCount = ()=>host.processors?.count() ?? 1;
    /** The processors node 0 holds, as an affinity mask. */
    const nodeMask = ()=>host.processors?.systemMask() ?? 1;
    /** @param {number} address @param {bigint} value */
    const writeQword = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
        host.writeMemory(address, bytes);
    };

    /**
     * The process a handle names: this one for the pseudo-handle, a child for
     * a handle CreateProcess gave; null for anything else.
     *
     * @param {number} handle
     */
    const processOf = handle=>((handle >>> 0) === CURRENT_PROCESS ? SELF
        : host.objectOf(handle >>> 0, 'process'));
    /** This process, as the jobs it is in record it. */
    const SELF = { self: true };

    // ---- Stack and context -----------------------------------------------

    /**
     * The caller's registers as they are when RtlCaptureContext returns to
     * it: EIP is the return address, ESP is past it and past the argument
     * the call pops. At a trap ESP points at the return address.
     *
     * Only the flags and the groups they name are written, as Windows writes
     * them: a caller may hold the context in less than its whole size (Mono
     * keeps one in 0xcc bytes of its frame, up to the extended registers),
     * and the bytes past those groups are its own.
     *
     * @param {number} out
     */
    const captureContext = out=>{
        const registers = host.registers?.() ?? {};
        const esp = (registers.esp ?? 0) >>> 0;
        const bytes = new Uint8Array(CONTEXT_CAPTURED_END);
        const view = new DataView(bytes.buffer);
        /** @param {number} offset @param {number | undefined} value */
        const put = (offset, value)=>view.setUint32(offset, (value ?? 0) >>> 0, true);
        put(0, CONTEXT_FULL_SEGMENTS);
        put(0x8c, SELECTORS.GS);
        put(0x90, SELECTORS.FS);
        put(0x94, SELECTORS.DATA);
        put(0x98, SELECTORS.DATA);
        put(0x9c, registers.edi);
        put(0xa0, registers.esi);
        put(0xa4, registers.ebx);
        put(0xa8, registers.edx);
        put(0xac, registers.ecx);
        put(0xb0, registers.eax);
        put(0xb4, registers.ebp);
        put(0xb8, esp === 0 ? 0 : readDword(esp));
        put(0xbc, SELECTORS.CODE);
        put(0xc0, registers.eflags ?? 0x202);
        put(0xc4, esp + 8);
        put(0xc8, SELECTORS.DATA);
        host.writeMemory(out, bytes.subarray(0, 4));
        host.writeMemory(out + CONTEXT_CAPTURED_FROM,
            bytes.subarray(CONTEXT_CAPTURED_FROM, CONTEXT_CAPTURED_END));
    };

    /**
     * The return addresses up the caller's frame chain: the first is the
     * address the call returns to, then each frame's saved return address as
     * EBP links them. The walk stops at a frame outside the thread's stack,
     * one that does not move up it, or one that is not aligned -- code built
     * without frame pointers ends the chain early, as it does on Windows.
     *
     * @param {number} skip @param {number} wanted
     * @returns {number[]}
     */
    const backTrace = (skip, wanted)=>{
        const registers = host.registers?.() ?? {};
        const teb = (host.currentThread()?.tebAddress ?? 0) >>> 0;
        const layout = blockLayouts(host.pointerSize).teb;
        const base = teb === 0 ? 0xffffffff : readDword(teb + layout.STACK_BASE);
        const limit = teb === 0 ? 0 : readDword(teb + layout.STACK_LIMIT);
        const within = (/** @type {number} */ at)=>at >= limit && at + 8 <= base
            && (at & 3) === 0;
        /** @type {number[]} */
        const frames = [];
        const esp = (registers.esp ?? 0) >>> 0;
        if (within(esp))
        {
            frames.push(readDword(esp));
        }
        let frame = (registers.ebp ?? 0) >>> 0;
        while (frames.length < skip + wanted && within(frame))
        {
            const returnTo = readDword(frame + 4);
            if (returnTo === 0)
            {
                break;
            }
            frames.push(returnTo);
            const next = readDword(frame);
            if (next <= frame)
            {
                break;
            }
            frame = next;
        }
        return frames.slice(skip, skip + wanted);
    };

    // ---- Job objects -----------------------------------------------------

    /**
     * A job: the processes ever assigned to it (`total` of them), and the
     * event a wait on it waits for, set once TerminateJobObject has ended
     * them and never reset, as Windows' job object is.
     *
     * @typedef {{ kind: 'job', name: string | null, processes: Set<any>, terminated: boolean,
     *     total: number, waitable: any, extended: Uint8Array, kept: Map<number, Uint8Array>,
     *     port: { object: any, key: number } | null, parent: Job | null }} Job
     */
    /** Every job made or reached, a closed one let go when it is next looked through. @type {Set<Job>} */
    const jobs = new Set();
    /**
     * The job a handle names; one this process reached by name, duplication or
     * inheritance is among its jobs from then, as one it made.
     *
     * @param {number} handle @returns {Job | null}
     */
    const jobOf = handle=>{
        const job = host.objectOf(handle >>> 0, 'job');
        if (job)
        {
            jobs.add(job);
        }
        return job;
    };
    /** When this process joined each job it is in: a later one is nested in the earlier. */
    const selfJoined = /** @type {Map<Job, number>} */ (new Map());
    let joins = 0;

    /**
     * Whether a process a job holds is still running: this one is.
     *
     * @param {any} process
     */
    const running = process=>process === SELF
        || !(process.completed || (process.exitCode ?? STILL_ACTIVE) !== STILL_ACTIVE);

    /**
     * The jobs holding a process that a handle still names: a job whose
     * last handle closed is gone, as on Windows.
     *
     * @param {any} process
     */
    const jobsHolding = process=>[...jobs].filter(job=>{
        if (!kernel.handles.holds(job))
        {
            jobs.delete(job);
            return false;
        }
        return job.processes.has(process);
    });

    /**
     * Jobs nest (Windows 8 on): a job a process is assigned to while it is in
     * another becomes that one's child, and a process in a job is in each job
     * above it. A job's depth is how many jobs are above it.
     *
     * @param {Job} job
     */
    const depth = job=>{
        let count = 0;
        for (let above = job.parent; above; above = above.parent)
        {
            count++;
        }
        return count;
    };

    /** The jobs holding a process, the innermost - the deepest - first. @param {any} process */
    const chainOf = process=>jobsHolding(process).sort((a, b)=>depth(b) - depth(a)
        || (selfJoined.get(b) ?? 0) - (selfJoined.get(a) ?? 0));

    /** @param {Job} job @param {Job} above whether `above` is `job` or a job over it */
    const under = (job, above)=>{
        for (let at = /** @type {Job | null} */ (job); at; at = at.parent)
        {
            if (at === above)
            {
                return true;
            }
        }
        return false;
    };

    /**
     * A process joins a job and every job above it it is not in yet, each
     * hearing of it as a new process.
     *
     * @param {Job} job @param {any} process
     */
    const join = (job, process)=>{
        for (let at = /** @type {Job | null} */ (job); at && !at.processes.has(process); at = at.parent)
        {
            at.processes.add(process);
            at.total++;
            tell(at, JOB_OBJECT_MSG.NEW_PROCESS, idOf(process));
            if (process === SELF)
            {
                selfJoined.set(at, ++joins);
            }
        }
    };

    /**
     * AssignProcessToJobObject's rule for a process already in a job: a job
     * below the process's innermost one takes it; a job of no hierarchy and
     * no process of its own becomes the innermost one's child and takes it;
     * any other is refused (ERROR_ACCESS_DENIED), the process being in another
     * hierarchy. True when the process is in the job after it.
     *
     * @param {Job} job @param {any} process
     */
    const nestInto = (job, process)=>{
        if (job.processes.has(process))
        {
            return true;
        }
        const innermost = chainOf(process)[0];
        if (innermost && !(job.parent && under(job.parent, innermost)))
        {
            if (job.parent || job.total > 0)
            {
                return false;
            }
            job.parent = innermost;
        }
        join(job, process);
        return true;
    };

    /**
     * The name a Create/OpenJobObject string gives, null for none.
     *
     * @param {number} namePointer @param {boolean} wideName
     * @returns {string | null}
     */
    const jobName = (namePointer, wideName)=>{
        if ((namePointer >>> 0) === 0)
        {
            return null;
        }
        let name = '';
        for (let at = namePointer >>> 0, units = 0; units < 260; units++)
        {
            const unit = wideName ? host.readMemory(at, 2) : host.readMemory(at, 1);
            const code = wideName ? unit[0] | unit[1] << 8 : unit[0];
            if (code === 0)
            {
                break;
            }
            name += String.fromCharCode(code);
            at += wideName ? 2 : 1;
        }
        return name === '' ? null : name;
    };

    /**
     * A job made, or the one its name already holds (`reused`), in the
     * namespace every named kernel object shares; TAKEN where another kind
     * holds the name. Answers the handle, or the object found and not opened.
     *
     * @param {string | null} name
     * @returns {{ handle: number, reused: boolean } | typeof TAKEN}
     */
    const makeJob = name=>{
        const found = host.namedObjects?.existing(name, 'job') ?? null;
        if (found === TAKEN)
        {
            return TAKEN;
        }
        /** @type {Job} */
        const job = found ?? { kind: 'job', name, processes: new Set(), terminated: false,
            total: 0, waitable: kernel.createEvent({ manualReset: true, signalled: false,
                name: name ?? 'job' }),
            extended: new Uint8Array(EXTENDED_LIMIT_BYTES), kept: new Map(), port: null,
            parent: null };
        jobs.add(job);
        host.namedObjects?.remember(name, 'job', job, found !== null, ()=>{});
        return { handle: kernel.handles.open('job', job), reused: found !== null };
    };

    /**
     * CreateJobObject: a name another job holds opens that job, as a
     * mutex's does, with ERROR_ALREADY_EXISTS.
     *
     * @param {number} namePointer @param {boolean} wideName
     */
    const createJob = (namePointer, wideName)=>{
        const made = makeJob(jobName(namePointer, wideName));
        if (made === TAKEN)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        host.setLastError?.(made.reused ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
        return made.handle;
    };

    /**
     * OpenJobObject: the job a name holds, ERROR_FILE_NOT_FOUND for none.
     *
     * @param {number} namePointer @param {boolean} wideName
     */
    const openJob = (namePointer, wideName)=>{
        const name = jobName(namePointer, wideName);
        if (name === null)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const found = host.namedObjects?.existing(name, 'job') ?? null;
        if (found === TAKEN)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (!found)
        {
            return fail(ERROR_FILE_NOT_FOUND);
        }
        host.namedObjects?.reference(found);
        return kernel.handles.open('job', found);
    };

    /**
     * The record a job keeps for an information class, null for a class it
     * does not keep: the extended limits hold the basic ones, so the two
     * classes are one record.
     *
     * @param {Job} job @param {number} type
     * @returns {Uint8Array | null}
     */
    const jobClass = (job, type)=>{
        switch (type)
        {
            case JOB.BASIC_LIMIT:
                return job.extended.subarray(0, BASIC_LIMIT_BYTES);
            case JOB.EXTENDED_LIMIT:
                return job.extended;
            default: {
                const size = KEPT_JOB_CLASSES.get(type);
                if (size === undefined)
                {
                    return null;
                }
                if (!job.kept.has(type))
                {
                    job.kept.set(type, new Uint8Array(size));
                }
                return /** @type {Uint8Array} */ (job.kept.get(type));
            }
        }
    };

    /** @param {any} process @returns {number} its id, this one's as its own */
    const idOf = process=>(process === SELF ? host.processId ?? 0 : process.id ?? 0) >>> 0;

    /** The ids of the processes a job holds that run, this one's as its own. @param {Job} job */
    const jobProcessIds = job=>[...job.processes].filter(running).map(idOf);

    /**
     * Posts a job's message to the completion port it was associated with,
     * if any: the message as the byte count, the job's key, the id.
     *
     * @param {Job} job @param {number} message @param {number} id
     */
    const tell = (job, message, id)=>{
        if (job.port)
        {
            host.postCompletion?.(job.port.object, { transferred: message,
                key: job.port.key, overlapped: id >>> 0 });
        }
    };

    /**
     * JobObjectAssociateCompletionPortInformation: a job takes one port, for
     * good - a second is a bad parameter, as is a handle that names no port;
     * no port at all is accepted and changes nothing, as from Windows 8. The
     * port hears at once of each process the job already runs.
     *
     * @param {Job} job @param {Uint8Array} given  JOBOBJECT_ASSOCIATE_COMPLETION_PORT
     */
    const associatePort = (job, given)=>{
        const view = new DataView(given.slice().buffer);
        const key = view.getUint32(0, true);
        const handle = view.getUint32(4, true);
        if (handle === 0)
        {
            return 1;
        }
        const object = job.port ? null : host.objectOf(handle, 'iocp');
        if (!object)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        job.port = { object, key };
        job.kept.set(JOB.ASSOCIATE_COMPLETION_PORT, given.slice());
        for (const process of [...job.processes].filter(running))
        {
            tell(job, JOB_OBJECT_MSG.NEW_PROCESS, idOf(process));
        }
        return 1;
    };

    // A process of this one's has exited: each job holding it tells its port,
    // and that its last running process has gone. A code with an error's
    // severity, an exception's, is an abnormal end.
    /** @param {Job} job */
    const limitFlags = job=>new DataView(job.extended.buffer).getUint32(LIMIT_FLAGS, true);
    /**
     * Whether a child leaves a job: always where the job says
     * SILENT_BREAKAWAY_OK, when it asked where it says BREAKAWAY_OK.
     *
     * @param {Job} job @param {boolean} asked
     */
    const letsGo = (job, asked)=>(limitFlags(job) & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) !== 0
        || asked && (limitFlags(job) & JOB_OBJECT_LIMIT_BREAKAWAY_OK) !== 0;
    /** The jobs this process is in, the innermost first. */
    const nesting = ()=>chainOf(SELF);
    host.listen?.({
        // CREATE_BREAKAWAY_FROM_JOB is refused while the innermost job this
        // process is in keeps its children.
        refusesBreakaway(){
            const innermost = nesting()[0];
            return innermost !== undefined && !letsGo(innermost, true);
        },

        // A child this process starts is in each job this process is in, but
        // those it breaks away from: from the innermost out, each that lets
        // it go, until one keeps it - that one and those around it hold it.
        started(process){
            const holding = nesting();
            let kept = 0;
            while (kept < holding.length && letsGo(holding[kept], process.breakaway === true))
            {
                kept++;
            }
            for (const job of holding.slice(kept))
            {
                join(job, process);
            }
            // Then each job PROC_THREAD_ATTRIBUTE_JOB_LIST names, in turn, each
            // nesting under the one before it. One that is in another
            // hierarchy refuses the child, which was never; the jobs it had
            // joined hear it come and go.
            for (const job of process.jobList ?? [])
            {
                if (!nestInto(job, process))
                {
                    process.refused = ERROR_ACCESS_DENIED;
                    process.completed = true;
                    process.exitCode = 0;
                    for (const holder of jobsHolding(process))
                    {
                        tell(holder, JOB_OBJECT_MSG.EXIT_PROCESS, idOf(process));
                        if (![...holder.processes].some(running))
                        {
                            tell(holder, JOB_OBJECT_MSG.ACTIVE_PROCESS_ZERO, 0);
                        }
                    }
                    return;
                }
            }
        },

        /**
         * The jobs a PROC_THREAD_ATTRIBUTE_JOB_LIST names, null when one of
         * them names no job (CreateProcess's ERROR_INVALID_HANDLE).
         *
         * @param {number[]} handles
         * @returns {Job[] | null}
         */
        listed(handles){
            const found = handles.map(jobOf);
            return found.every(Boolean) ? /** @type {Job[]} */ (found) : null;
        },

        exited(process, code){
            for (const job of jobsHolding(process))
            {
                tell(job, (code >>> 30) === 3 ? JOB_OBJECT_MSG.ABNORMAL_EXIT_PROCESS
                    : JOB_OBJECT_MSG.EXIT_PROCESS, idOf(process));
                if (![...job.processes].some(running))
                {
                    tell(job, JOB_OBJECT_MSG.ACTIVE_PROCESS_ZERO, 0);
                }
            }
        },

        // With a job's last handle, a job set to kill on close ends every
        // process it runs, this one last (TerminateJobObject's order).
        closed(job){
            if (kernel.handles.holds(job))
            {
                return;
            }
            jobs.delete(job);
            const flags = new DataView(job.extended.buffer).getUint32(LIMIT_FLAGS, true);
            if ((flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) === 0)
            {
                return;
            }
            const ending = [...job.processes].filter(running);
            for (const process of ending.filter(each=>each !== SELF))
            {
                host.terminateProcess?.(process, 0);
            }
            if (ending.includes(SELF))
            {
                host.terminateProcess?.(null, 0);
            }
        },
    });

    /**
     * The native calls over the same jobs, which ntdll publishes: a job one
     * front door makes by name the other opens - and NtCancelSynchronousIoFile,
     * CancelSynchronousIo's.
     */
    const jobNatives = {
        /**
         * NTSTATUS NtCancelSynchronousIoFile(HANDLE ThreadHandle,
         *   PIO_STATUS_BLOCK IoRequestToCancel, PIO_STATUS_BLOCK IoStatusBlock)
         *
         * CancelSynchronousIo's, native: the thread's synchronous I/O - the one
         * whose block is named, or any - ends cancelled; STATUS_NOT_FOUND when
         * there was none. The answer is written in the block, which is probed
         * before anything is cancelled: one that cannot be written is
         * STATUS_ACCESS_VIOLATION (ntdll's wrapper answers the fault so).
         */
        NtCancelSynchronousIoFile: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, request, block])=>{
                const thread = host.threadOf(handle);
                if (!thread)
                {
                    return STATUS.INVALID_HANDLE;
                }
                if ((block >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                writeDword(block >>> 0, 0);
                const status = (host.cancelSynchronous?.(thread, request >>> 0) ?? 0) > 0
                    ? STATUS.SUCCESS : STATUS.NOT_FOUND;
                // Status and Information, each a pointer wide.
                writeDword(block >>> 0, status);
                writeDword((block >>> 0) + 4, 0);
                if (wide)
                {
                    writeDword((block >>> 0) + 8, 0);
                    writeDword((block >>> 0) + 12, 0);
                }
                return status;
            },
        },

        /**
         * NTSTATUS NtCreateJobObject(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES)
         *
         * CreateJobObject's job, named by a path in the object namespace: a
         * name held already collides, or with OBJ_OPENIF is opened.
         */
        NtCreateJobObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, , attributes])=>{
                if ((out >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const given = readObjectAttributes(host.readMemory, attributes, wide ? 8 : 4);
                const walked = nameToWalk(given, false);
                if ('status' in walked)
                {
                    return walked.status;
                }
                const name = given === null || walked.name === null ? null
                    : host.namedObjects?.keyOf(given, 'job') ?? STATUS.OBJECT_PATH_NOT_FOUND;
                if (typeof name === 'number')
                {
                    return name;
                }
                const found = host.namedObjects?.existing(name, 'job') ?? null;
                if (found === TAKEN)
                {
                    return STATUS.OBJECT_TYPE_MISMATCH;
                }
                if (found && ((given?.attributes ?? 0) & OBJ_OPENIF) === 0)
                {
                    return STATUS.OBJECT_NAME_COLLISION;
                }
                const made = makeJob(name);
                if (made === TAKEN)
                {
                    return STATUS.OBJECT_TYPE_MISMATCH;
                }
                writeDword(out >>> 0, made.handle);
                return made.reused ? STATUS.OBJECT_NAME_EXISTS : STATUS.SUCCESS;
            },
        },
        /** NTSTATUS NtOpenJobObject(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
        NtOpenJobObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, , attributes])=>{
                if ((out >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const given = readObjectAttributes(host.readMemory, attributes, wide ? 8 : 4);
                const walked = nameToWalk(given, true);
                if ('status' in walked || given === null)
                {
                    return 'status' in walked ? walked.status : STATUS.INVALID_PARAMETER;
                }
                const name = host.namedObjects?.keyOf(given, 'job')
                    ?? STATUS.OBJECT_PATH_NOT_FOUND;
                if (typeof name === 'number')
                {
                    return name;
                }
                const found = host.namedObjects?.existing(name, 'job') ?? null;
                if (found === TAKEN)
                {
                    return STATUS.OBJECT_TYPE_MISMATCH;
                }
                if (!found)
                {
                    return STATUS.OBJECT_NAME_NOT_FOUND;
                }
                host.namedObjects?.reference(found);
                writeDword(out >>> 0, kernel.handles.open('job', found));
                return STATUS.SUCCESS;
            },
        },
    };

    // ---- Policies ----------------------------------------------------------

    /** The mitigation policies this process set, by policy. @type {Map<number, number>} */
    const mitigations = new Map();
    let depFlags = PROCESS_DEP_ENABLE;
    /** DEP_SYSTEM_POLICY_TYPE's OptOut. */
    const DEP_POLICY_OPT_OUT = 3;
    let depPermanent = false;
    /** WerSetFlags's flags, which WerGetFlags answers. */
    let werFlags = 0;

    /**
     * How many handles this process holds: the kernel's own count where it
     * keeps one, the table probed otherwise.
     */
    const handleCount = ()=>{
        if (typeof kernel.handles.count === 'function')
        {
            return kernel.handles.count();
        }
        let count = 0;
        for (let handle = FIRST_HANDLE; handle < FIRST_HANDLE + HANDLE_PROBE * 4; handle += 4)
        {
            if (kernel.handles.typeOf(handle) !== null)
            {
                count++;
            }
        }
        return count;
    };

    /**
     * NTSTATUS NtContinue(PCONTEXT ContextRecord, BOOLEAN TestAlert)
     *
     * The thread goes on from the context, as a handler's continue
     * does: the groups its flags name are put back (control: EBP,
     * EIP, EFLAGS, ESP; integer: the rest), every other register is
     * left as the call found it. A runtime that unwinds by itself
     * (Mono's) captures a context, unwinds to it and continues here. A
     * null context is refused. The floating-point groups go back with the
     * rest (said where there is nothing to take them), and the debug
     * registers become the thread's (`debug-registers.js`).
     */
    const ntContinue = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([context])=>{
            const at = context >>> 0;
            if (at === 0 || !host.setRegisters)
            {
                return STATUS_ACCESS_VIOLATION;
            }
            const flags = readDword(at);
            /** @type {Record<string, number>} */
            const values = {};
            for (const [group, fields] of /** @type {const} */ ([
                [CONTEXT_INTEGER, CONTEXT_INTEGERS], [CONTEXT_CONTROL, CONTEXT_CONTROLS]]))
            {
                for (const [name, offset] of (flags & group) === 0 ? [] : fields)
                {
                    values[name] = readDword(at + offset);
                }
            }
            // The floating-point groups go back with the rest, as Windows
            // continues from the whole record.
            // On the calling thread, whose call this is: its own registers now.
            const bytes = host.readMemory(at, CONTEXT_BYTES);
            const debug = debugGroupOf(bytes, flags);
            if (debug !== null)
            {
                setDebugRegisters(host.currentThread(), debug, host.divergence, 'NtContinue');
            }
            const groups = floatGroupsOf(bytes, flags);
            if (groups !== null && host.float?.restore(null, groups) !== true)
            {
                host.divergence?.('NtContinue',
                    'the floating-point registers of a context are not put back');
            }
            host.setRegisters(values);
            // EAX is what the call answers, so the context's is the answer.
            return values.eax ?? (host.registers?.().eax ?? 0) >>> 0;
        },
    };

    /** A thread's cycles: its processor time at the processor's rate. @param {any} thread */
    const cyclesOf = thread=>BigInt(Math.round((thread?.cpuMs ?? 0) * PROCESSOR.mhz * 1000));

    /** What SetProcessInformation was given, by class. @type {Map<number, Uint8Array>} */
    const processInformation = new Map();

    return {
        /** VOID RtlCaptureContext(PCONTEXT ContextRecord) -- a 64-bit process has its own. */
        ...wide ? {} : {
            RtlCaptureContext: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([out])=>{
                    captureContext(out >>> 0);
                    return 0;
                },
                // ntdll's, which goes on from what this captured.
                natives: { NtContinue: ntContinue },
            },

            /**
             * WORD RtlCaptureStackBackTrace(DWORD FramesToSkip, DWORD FramesToCapture,
             *     PVOID *BackTrace, PDWORD BackTraceHash)
             *
             * The count captured; the hash, where asked, is the sum of the
             * addresses, which is what makes two equal traces hash alike.
             */
            RtlCaptureStackBackTrace: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([skip, wanted, out, hash])=>{
                    if ((out >>> 0) === 0)
                    {
                        return 0;
                    }
                    const frames = backTrace(skip >>> 0, Math.min(wanted >>> 0, 0xffff));
                    let sum = 0;
                    frames.forEach((address, index)=>{
                        writeDword((out >>> 0) + index * 4, address);
                        sum = (sum + address) >>> 0;
                    });
                    if ((hash >>> 0) !== 0)
                    {
                        writeDword(hash >>> 0, sum);
                    }
                    return frames.length;
                },
            },
        },

        /** HANDLE CreateJobObjectA/W(LPSECURITY_ATTRIBUTES, LPCSTR/LPCWSTR lpName) */
        CreateJobObjectA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, name])=>createJob(name, false),
        },
        CreateJobObjectW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, name])=>createJob(name, true),
            natives: jobNatives,
        },

        /** HANDLE OpenJobObjectA/W(DWORD dwDesiredAccess, BOOL bInheritHandle, LPCSTR/LPCWSTR) */
        OpenJobObjectA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , name])=>openJob(name, false),
        },
        OpenJobObjectW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , name])=>openJob(name, true),
        },

        /**
         * BOOL AssignProcessToJobObject(HANDLE hJob, HANDLE hProcess)
         *
         * A process may be in several jobs, as from Windows 8. A job that
         * was terminated takes no more (ERROR_ACCESS_DENIED).
         */
        AssignProcessToJobObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, processHandle])=>{
                const job = jobOf(handle);
                const process = processOf(processHandle);
                if (!job || !process)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                // A process that has ended joins nothing; a job that was
                // terminated still takes new ones, and stays signalled.
                if (!running(process))
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                // In a job already, the process is in a hierarchy: the job
                // nests under its innermost one, or is refused.
                return nestInto(job, process) ? 1 : fail(ERROR_ACCESS_DENIED);
            },
        },

        /**
         * BOOL IsProcessInJob(HANDLE ProcessHandle, HANDLE JobHandle, PBOOL Result)
         *
         * No job asks whether the process is in any.
         */
        IsProcessInJob: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([processHandle, handle, out])=>{
                const process = processOf(processHandle);
                if (!process || (out >>> 0) === 0)
                {
                    return fail(!process ? ERROR_INVALID_HANDLE : ERROR_INVALID_PARAMETER);
                }
                let inJob;
                if ((handle >>> 0) === 0)
                {
                    inJob = jobsHolding(process).length > 0;
                }
                else
                {
                    const job = jobOf(handle);
                    if (!job)
                    {
                        return fail(ERROR_INVALID_HANDLE);
                    }
                    inJob = job.processes.has(process);
                }
                writeDword(out >>> 0, inJob ? 1 : 0);
                return 1;
            },
        },

        /**
         * BOOL SetInformationJobObject(HANDLE hJob, JOBOBJECTINFOCLASS,
         *     LPVOID lpJobObjectInformation, DWORD cbJobObjectInformationLength)
         *
         * The limits are kept and read back; of them only
         * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is kept to, there being one
         * address space and no processor time to ration. A completion port
         * associated hears the job's messages (`associatePort`).
         */
        SetInformationJobObject: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, type, from, length])=>{
                const job = jobOf(handle);
                if (!job)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const record = jobClass(job, type >>> 0);
                if (!record)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((length >>> 0) !== record.length)
                {
                    return fail(ERROR_BAD_LENGTH);
                }
                if ((type >>> 0) === JOB.ASSOCIATE_COMPLETION_PORT)
                {
                    return associatePort(job, host.readMemory(from >>> 0, record.length));
                }
                record.set(host.readMemory(from >>> 0, record.length));
                return 1;
            },
        },

        /**
         * BOOL QueryInformationJobObject(HANDLE hJob, JOBOBJECTINFOCLASS,
         *     LPVOID, DWORD cbLength, LPDWORD lpReturnLength)
         *
         * NULL is the job of the calling process. The accounting classes
         * count the processes the job holds and nothing they spent; the id
         * list fills what fits and says ERROR_MORE_DATA past that.
         */
        QueryInformationJobObject: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, type, to, length, returned])=>{
                const job = (handle >>> 0) === 0 ? jobsHolding(SELF)[0] ?? null : jobOf(handle);
                if (!job)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const room = length >>> 0;
                /** @type {Uint8Array} */
                let answer;
                let more = false;
                switch (type >>> 0)
                {
                    case JOB.BASIC_ACCOUNTING:
                    case JOB.BASIC_AND_IO_ACCOUNTING: {
                        answer = new Uint8Array(type === JOB.BASIC_ACCOUNTING ? 48 : 96);
                        const view = new DataView(answer.buffer);
                        // TotalProcesses, then ActiveProcesses.
                        view.setUint32(36, job.total, true);
                        view.setUint32(40, [...job.processes].filter(running).length, true);
                        break;
                    }
                    case JOB.BASIC_PROCESS_ID_LIST: {
                        if (room < 8)
                        {
                            return fail(ERROR_BAD_LENGTH);
                        }
                        const ids = jobProcessIds(job);
                        const fits = Math.min(ids.length, Math.floor((room - 8) / 4));
                        answer = new Uint8Array(8 + fits * 4);
                        const view = new DataView(answer.buffer);
                        view.setUint32(0, ids.length, true);
                        view.setUint32(4, fits, true);
                        ids.slice(0, fits).forEach((id, index)=>
                            view.setUint32(8 + index * 4, id, true));
                        more = fits < ids.length;
                        break;
                    }
                    default: {
                        const record = jobClass(job, type >>> 0);
                        if (!record)
                        {
                            return fail(ERROR_INVALID_PARAMETER);
                        }
                        answer = record;
                    }
                }
                if (room < answer.length)
                {
                    return fail(ERROR_BAD_LENGTH);
                }
                host.writeMemory(to >>> 0, answer);
                if ((returned >>> 0) !== 0)
                {
                    writeDword(returned >>> 0, answer.length);
                }
                return more ? fail(ERROR_MORE_DATA) : 1;
            },
        },

        /**
         * BOOL TerminateJobObject(HANDLE hJob, UINT uExitCode)
         *
         * Every process the job holds that still runs is ended with the code,
         * as TerminateProcess ends it, and the job is signalled for good. This
         * process, if the job holds it, is ended last: the call does not
         * return to it.
         */
        TerminateJobObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                const job = jobOf(handle);
                if (!job)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                job.terminated = true;
                const ending = [...job.processes].filter(running);
                for (const process of ending.filter(each=>each !== SELF))
                {
                    host.terminateProcess?.(process, code >>> 0);
                }
                kernel.setEvent(job.waitable);
                if (ending.includes(SELF))
                {
                    return host.terminateProcess?.(null, code >>> 0) ?? 1;
                }
                return 1;
            },
        },

        /**
         * BOOL GetProcessMitigationPolicy(HANDLE hProcess,
         *     PROCESS_MITIGATION_POLICY MitigationPolicy, PVOID lpBuffer, SIZE_T dwLength)
         *
         * What this process set, zero where it set nothing; DEP is on, as
         * on a Windows 10 that opts every process in. The buffer must be the
         * policy's size exactly.
         */
        GetProcessMitigationPolicy: {
            argBytes: 16,
            sizes: [3],
            /** @param {number[]} args */
            handler: ([process, policy, to, length])=>{
                if (!processOf(process))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const which = policy >>> 0;
                const size = which === DEP_POLICY ? 8 : 4;
                if (which >= MITIGATION_POLICIES || (length >>> 0) !== size || (to >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (which === DEP_POLICY)
                {
                    writeDword(to >>> 0, depFlags);
                    writeDword((to >>> 0) + 4, depPermanent ? 1 : 0);
                    return 1;
                }
                writeDword(to >>> 0, mitigations.get(which) ?? 0);
                return 1;
            },
        },

        /**
         * BOOL SetProcessMitigationPolicy(PROCESS_MITIGATION_POLICY, PVOID, SIZE_T)
         *
         * Kept, for this process, and read back; a policy turned on stays on,
         * as Windows will not lift one, and ASLR's flags are Windows' to set
         * at load time, not the process's (ERROR_INVALID_PARAMETER).
         */
        SetProcessMitigationPolicy: {
            argBytes: 12,
            sizes: [2],
            /** @param {number[]} args */
            handler: ([policy, from, length])=>{
                const which = policy >>> 0;
                const size = which === DEP_POLICY ? 8 : 4;
                if (which >= MITIGATION_POLICIES || which === ASLR_POLICY
                    || (length >>> 0) !== size || (from >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const flags = readDword(from >>> 0);
                if (which === DEP_POLICY)
                {
                    depFlags |= flags;
                    depPermanent ||= readDword((from >>> 0) + 4) !== 0;
                    return 1;
                }
                mitigations.set(which, (mitigations.get(which) ?? 0) | flags);
                return 1;
            },
        },

        /**
         * BOOL SetProcessDEPPolicy(DWORD dwFlags)
         *
         * DEP once set is permanent: turning it off after is refused, as is a
         * flag beyond the two (ERROR_INVALID_PARAMETER).
         */
        SetProcessDEPPolicy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([flags])=>{
                const asked = flags >>> 0;
                if ((asked & ~(PROCESS_DEP_ENABLE | PROCESS_DEP_DISABLE_ATL_THUNK_EMULATION)) !== 0
                    || (asked & PROCESS_DEP_DISABLE_ATL_THUNK_EMULATION) !== 0
                        && (asked & PROCESS_DEP_ENABLE) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (depPermanent && (asked & PROCESS_DEP_ENABLE) === 0)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                depFlags = asked;
                depPermanent ||= (asked & PROCESS_DEP_ENABLE) !== 0;
                return 1;
            },
        },

        /**
         * DEP_SYSTEM_POLICY_TYPE GetSystemDEPPolicy(void)
         *
         * OptOut: every process starts with DEP on (its flags above) and may
         * turn it off for itself, which is what SetProcessDEPPolicy allows.
         */
        GetSystemDEPPolicy: {
            argBytes: 0,
            handler: ()=>DEP_POLICY_OPT_OUT,
        },

        /** BOOL GetProcessDEPPolicy(HANDLE hProcess, LPDWORD lpFlags, PBOOL lpPermanent) */
        GetProcessDEPPolicy: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([process, flags, permanent])=>{
                if (!processOf(process))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((flags >>> 0) !== 0)
                {
                    writeDword(flags >>> 0, depFlags);
                }
                if ((permanent >>> 0) !== 0)
                {
                    writeDword(permanent >>> 0, depPermanent ? 1 : 0);
                }
                return 1;
            },
        },

        /**
         * BOOL SetProcessInformation(HANDLE hProcess, PROCESS_INFORMATION_CLASS,
         *     LPVOID, DWORD)
         *
         * Accepted for the classes Windows sets, at their sizes: a memory
         * priority or a power throttling state changes nothing that can be
         * seen here.
         */
        SetProcessInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([process, type, from, length])=>{
                if (!processOf(process))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const size = PROCESS_INFORMATION_SIZES.get(type >>> 0);
                if (size === undefined || (length >>> 0) !== size || (from >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                processInformation.set(type >>> 0, host.readMemory(from >>> 0, size).slice());
                return 1;
            },
        },

        /**
         * BOOL GetProcessInformation(HANDLE hProcess, PROCESS_INFORMATION_CLASS,
         *     LPVOID, DWORD)
         *
         * What SetProcessInformation was given for the class, or Windows'
         * default: a normal memory priority (MEMORY_PRIORITY_NORMAL, 5), and
         * version 1 of a power throttling state that controls nothing; zeroes
         * for the rest. The size must be the class's.
         */
        GetProcessInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([process, type, into, length])=>{
                if (!processOf(process))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const size = PROCESS_INFORMATION_SIZES.get(type >>> 0);
                if (size === undefined || (length >>> 0) !== size || (into >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                let bytes = processInformation.get(type >>> 0);
                if (!bytes)
                {
                    bytes = new Uint8Array(size);
                    if ((type >>> 0) === 0)
                    {
                        bytes[0] = MEMORY_PRIORITY_NORMAL;
                    }
                    else if ((type >>> 0) === 4)
                    {
                        bytes[0] = 1;
                    }
                }
                host.writeMemory(into >>> 0, bytes);
                return 1;
            },
        },

        /** BOOL SetThreadInformation(HANDLE hThread, THREAD_INFORMATION_CLASS, LPVOID, DWORD) */
        SetThreadInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([thread, type, from, length])=>{
                if (!host.threadOf(thread))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const size = THREAD_INFORMATION_SIZES.get(type >>> 0);
                return size === undefined || (length >>> 0) !== size || (from >>> 0) === 0
                    ? fail(ERROR_INVALID_PARAMETER) : 1;
            },
        },

        /**
         * BOOL QueryThreadCycleTime(HANDLE ThreadHandle, PULONG64 CycleTime)
         *
         * The thread's processor time at the processor's rate: the cycles a
         * time-stamp counter read across its turns would have counted.
         */
        QueryThreadCycleTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const thread = host.threadOf(handle);
                if (!thread)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                writeQword(out >>> 0, cyclesOf(thread));
                return 1;
            },
        },

        /**
         * BOOL QueryProcessCycleTime(HANDLE ProcessHandle, PULONG64 CycleTime)
         *
         * This process's, its threads' together; a child's is its own
         * scheduler's and not known here, so zero.
         */
        QueryProcessCycleTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const process = processOf(handle);
                if (!process)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const ms = process === SELF ? kernel.processCpuMs?.() ?? 0 : 0;
                writeQword(out >>> 0, BigInt(Math.round(ms * PROCESSOR.mhz * 1000)));
                return 1;
            },
        },

        /** BOOL GetProcessHandleCount(HANDLE hProcess, PDWORD pdwHandleCount): this process's. */
        GetProcessHandleCount: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                if ((handle >>> 0) !== CURRENT_PROCESS)
                {
                    return fail(processOf(handle) ? ERROR_ACCESS_DENIED : ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, handleCount());
                return 1;
            },
        },

        /**
         * BOOL CancelSynchronousIo(HANDLE hThread)
         *
         * The synchronous I/O the thread waits in ends cancelled, its call
         * failing ERROR_OPERATION_ABORTED, and the last error is left alone.
         * A file's reads and writes have finished by the time their calls
         * answer; what waits is a pipe's read or connect. A thread waiting in
         * none, or only in overlapped I/O, has nothing to cancel
         * (ERROR_NOT_FOUND).
         */
        CancelSynchronousIo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const thread = host.threadOf(handle);
                if (!thread)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                return (host.cancelSynchronous?.(thread) ?? 0) > 0 ? 1 : fail(ERROR_NOT_FOUND);
            },
        },

        /**
         * BOOL CheckRemoteDebuggerPresent(HANDLE hProcess, PBOOL pbDebuggerPresent)
         *
         * Whether a debugger debugs the process: a child this process started
         * with DEBUG_PROCESS or DEBUG_ONLY_THIS_PROCESS is debugged by it, and
         * this process is when its parent started it so (`debug-events.js`).
         * No process handle, or nowhere to
         * answer, is a bad parameter; a handle that names no process a bad
         * handle. The last error is left alone on success.
         */
        CheckRemoteDebuggerPresent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                if ((handle >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const process = processOf(handle);
                if (!process)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                writeDword(out >>> 0, (process === SELF ? host.debugged?.() === true
                    : Boolean(process.debugged)) ? 1 : 0);
                return 1;
            },
        },

        /** HANDLE PowerCreateRequest(PREASON_CONTEXT Context) */
        PowerCreateRequest: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>((context >>> 0) === 0 ? fail(ERROR_INVALID_PARAMETER)
                : kernel.handles.open('power-request', { kind: 'power-request', types: 0 })),
        },

        /**
         * BOOL PowerSetRequest(HANDLE PowerRequest, POWER_REQUEST_TYPE RequestType) and
         * BOOL PowerClearRequest(HANDLE, POWER_REQUEST_TYPE)
         *
         * Kept on the request; nothing here sleeps or blanks a display.
         */
        PowerSetRequest: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, type])=>{
                const request = host.objectOf(handle >>> 0, 'power-request');
                if (!request)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((type >>> 0) >= POWER_REQUEST_TYPES)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                request.types |= 1 << (type >>> 0);
                return 1;
            },
        },
        PowerClearRequest: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, type])=>{
                const request = host.objectOf(handle >>> 0, 'power-request');
                if (!request)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((type >>> 0) >= POWER_REQUEST_TYPES)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                request.types &= ~(1 << (type >>> 0));
                return 1;
            },
        },

        /**
         * HANDLE CreateMemoryResourceNotification(
         *     MEMORY_RESOURCE_NOTIFICATION_TYPE NotificationType)
         *
         * An event a wait can name: the low-memory one never signalled, the
         * high-memory one signalled -- the tab's memory is held within its
         * zones, so the system is never short of it on the program's behalf.
         */
        CreateMemoryResourceNotification: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([type])=>{
                const kind = type >>> 0;
                if (kind !== LOW_MEMORY && kind !== HIGH_MEMORY)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const event = kernel.createEvent({ manualReset: true,
                    signalled: kind === HIGH_MEMORY,
                    name: kind === HIGH_MEMORY ? 'high memory' : 'low memory' });
                return kernel.handles.open('event', event);
            },
        },

        /** BOOL QueryMemoryResourceNotification(HANDLE, PBOOL ResourceState) */
        QueryMemoryResourceNotification: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const event = host.objectOf(handle >>> 0, 'event');
                if (!event)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, event.signalled ? 1 : 0);
                return 1;
            },
        },

        /**
         * BOOL GetNumaNodeProcessorMask(UCHAR Node, PULONGLONG ProcessorMask):
         * node 0 holds every processor; another node is no node of this
         * machine's, ERROR_INVALID_PARAMETER.
         */
        GetNumaNodeProcessorMask: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([node, out])=>{
                if ((node & 0xff) !== 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeQword(out >>> 0, BigInt(nodeMask() >>> 0));
                return 1;
            },
        },

        /**
         * BOOL GetNumaNodeProcessorMaskEx(USHORT Node, PGROUP_AFFINITY ProcessorMask):
         * the same mask in group 0, the GROUP_AFFINITY's mask a pointer wide.
         */
        GetNumaNodeProcessorMaskEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([node, out])=>{
                if ((node & 0xffff) !== 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const record = new Uint8Array(wide ? 16 : 12);
                new DataView(record.buffer).setUint32(0, nodeMask(), true);
                host.writeMemory(out >>> 0, record);
                return 1;
            },
        },

        /**
         * BOOL GetNumaProcessorNode(UCHAR Processor, PUCHAR NodeNumber): node 0
         * for a processor the machine has; for another, 0xff and
         * ERROR_INVALID_PARAMETER.
         */
        GetNumaProcessorNode: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([processor, out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const known = (processor & 0xff) < processorCount();
                host.writeMemory(out >>> 0, new Uint8Array([known ? 0 : 0xff]));
                return known ? 1 : fail(ERROR_INVALID_PARAMETER);
            },
        },

        /**
         * BOOL GetNumaProcessorNodeEx(PPROCESSOR_NUMBER Processor, PUSHORT NodeNumber):
         * as GetNumaProcessorNode for a processor named by group and number, all
         * of them in group 0; 0xffff for one the machine does not have.
         */
        GetNumaProcessorNodeEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([processor, out])=>{
                if ((processor >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const named = host.readMemory(processor >>> 0, 4);
                const group = named[0] | named[1] << 8;
                const known = group === 0 && named[2] < processorCount();
                host.writeMemory(out >>> 0, known ? new Uint8Array([0, 0])
                    : new Uint8Array([0xff, 0xff]));
                return known ? 1 : fail(ERROR_INVALID_PARAMETER);
            },
        },

        /**
         * BOOL GetNumaHighestNodeNumber(PULONG HighestNodeNumber): one node, the
         * processors' (`GetLogicalProcessorInformation` reports the same).
         */
        GetNumaHighestNodeNumber: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, 0);
                return 1;
            },
        },

        /** BOOL GetFirmwareType(PFIRMWARE_TYPE FirmwareType): a Windows 10 machine's UEFI. */
        GetFirmwareType: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, FIRMWARE_TYPE_UEFI);
                return 1;
            },
        },

        /**
         * VOID FlushProcessWriteBuffers(void)
         *
         * Returns once every other processor has passed a barrier: each
         * executor running guest code when it is called has since ended a
         * run of it, so its stores before are seen here and its loads after
         * see the caller's (`kernel.flushProcessWrites`).
         */
        FlushProcessWriteBuffers: {
            argBytes: 0,
            handler: ()=>{
                const flushed = kernel.flushProcessWrites?.() ?? true;
                return flushed === true ? 0 : flushed.then(()=>0);
            },
        },

        /**
         * BOOL SetSystemPowerState(BOOL fSuspend, BOOL fForce)
         *
         * The caller does not hold SeShutdownPrivilege enabled, which a
         * process has to enable before it may suspend the machine.
         */
        SetSystemPowerState: {
            argBytes: 8,
            handler: ()=>fail(ERROR_PRIVILEGE_NOT_HELD),
        },

        /**
         * HRESULT WerRegisterRuntimeExceptionModule(PCWSTR, PVOID) and
         * HRESULT WerUnregisterRuntimeExceptionModule(PCWSTR, PVOID)
         *
         * S_OK: there is no error reporting service to hand a crash to, and
         * a module registered with it is never asked anything.
         */
        WerRegisterRuntimeExceptionModule: {
            argBytes: 8,
            handler: ()=>0,
        },
        WerUnregisterRuntimeExceptionModule: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * HRESULT WerSetFlags(DWORD dwFlags) and
         * HRESULT WerGetFlags(HANDLE hProcess, PDWORD pdwFlags)
         *
         * The process's error reporting flags (WER_FAULT_REPORTING_*), kept and
         * answered back; nothing reads them, as no reporting service runs. Another
         * process's are not this one's to read: E_INVALIDARG, as for a handle that
         * names no process.
         */
        WerSetFlags: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([flags])=>{
                werFlags = flags >>> 0;
                return 0;
            },
        },
        WerGetFlags: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([process, out])=>{
                if (processOf(process) !== SELF || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeDword(out >>> 0, werFlags);
                return 0;
            },
        },

        /**
         * HRESULT WerRegisterFile(PCWSTR, WER_REGISTER_FILE_TYPE, DWORD),
         * HRESULT WerUnregisterFile(PCWSTR),
         * HRESULT WerRegisterMemoryBlock(PVOID, DWORD) and
         * HRESULT WerUnregisterMemoryBlock(PVOID)
         *
         * S_OK: what a report would carry is accepted, and no report is ever made.
         */
        WerRegisterFile: { argBytes: 12, handler: ()=>0 },
        WerUnregisterFile: { argBytes: 4, handler: ()=>0 },
        WerRegisterMemoryBlock: { argBytes: 8, handler: ()=>0 },
        WerUnregisterMemoryBlock: { argBytes: 4, handler: ()=>0 },
    };
}

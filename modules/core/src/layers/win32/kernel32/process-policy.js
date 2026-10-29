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
import { PROCESSOR } from './processor.js';

const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_BAD_LENGTH = 24;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_FOUND = 1168;
const ERROR_PRIVILEGE_NOT_HELD = 1314;
const ERROR_MORE_DATA = 234;

const CURRENT_PROCESS = 0xffffffff;

/** CONTEXT_i386 with its control, integer and segment groups: RtlCaptureContext's set. */
const CONTEXT_FULL_SEGMENTS = 0x00010007;
const CONTEXT_BYTES = 0x2cc;

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
 * @property {(handle: number, type?: string) => any} objectOf  A kernel object by handle, or null.
 * @property {number} [processId]  This process's id, which a job's id list names.
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
     * @param {number} out
     */
    const captureContext = out=>{
        const registers = host.registers?.() ?? {};
        const esp = (registers.esp ?? 0) >>> 0;
        const bytes = new Uint8Array(CONTEXT_BYTES);
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
        host.writeMemory(out, bytes);
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
     * @typedef {{ kind: 'job', name: string | null, processes: Set<any>, terminated: boolean,
     *     extended: Uint8Array, kept: Map<number, Uint8Array> }} Job
     */
    /** @param {number} handle @returns {Job | null} */
    const jobOf = handle=>host.objectOf(handle >>> 0, 'job');
    /** Every job made, a closed one let go when it is next looked through. @type {Set<Job>} */
    const jobs = new Set();

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
     * A job named by another call shares nothing here: names of jobs are not
     * in the namespace events and mutexes share, so a second CreateJobObject
     * by the same name makes a job of its own.
     *
     * @param {number} namePointer @param {boolean} wideName
     */
    const createJob = (namePointer, wideName)=>{
        let name = null;
        if ((namePointer >>> 0) !== 0)
        {
            name = '';
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
        }
        /** @type {Job} */
        const job = { kind: 'job', name, processes: new Set(), terminated: false,
            extended: new Uint8Array(EXTENDED_LIMIT_BYTES), kept: new Map() };
        jobs.add(job);
        return kernel.handles.open('job', job);
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

    /** The ids of the processes a job holds, this one's as its own. @param {Job} job */
    const jobProcessIds = job=>[...job.processes].map(process=>(process === SELF
        ? host.processId ?? 0 : process.id ?? 0) >>> 0);

    // ---- Policies ----------------------------------------------------------

    /** The mitigation policies this process set, by policy. @type {Map<number, number>} */
    const mitigations = new Map();
    let depFlags = PROCESS_DEP_ENABLE;
    let depPermanent = false;

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
                if (job.terminated)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                job.processes.add(process);
                return 1;
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
         * The limits are kept and read back; none is enforced, there being
         * one address space and no processor time to ration.
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
                        view.setUint32(36, job.processes.size, true);
                        view.setUint32(40, job.processes.size, true);
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
         * The job takes no more processes. The ones it holds are not ended:
         * a child runs where its driver runs it, and ending it is
         * TerminateProcess's, by its own handle.
         */
        TerminateJobObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const job = jobOf(handle);
                if (!job)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                job.terminated = true;
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
         * No synchronous read or write here waits in a way another thread
         * can cut short, so there is never one to cancel (ERROR_NOT_FOUND).
         */
        CancelSynchronousIo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>fail(host.threadOf(handle) ? ERROR_NOT_FOUND
                : ERROR_INVALID_HANDLE),
        },

        /**
         * BOOL CheckRemoteDebuggerPresent(HANDLE hProcess, PBOOL pbDebuggerPresent)
         *
         * No debugger attaches to anything here.
         */
        CheckRemoteDebuggerPresent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([process, out])=>{
                if (!processOf(process))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(out >>> 0, 0);
                return 1;
            },
        },

        /**
         * BOOL DebugActiveProcess(DWORD dwProcessId)
         *
         * There is no debugging interface to attach through: no process id
         * is ERROR_INVALID_PARAMETER, any other is refused as a process the
         * caller may not debug.
         */
        DebugActiveProcess: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([id])=>fail((id >>> 0) === 0 ? ERROR_INVALID_PARAMETER : ERROR_ACCESS_DENIED),
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
         * Every store an executor made is already seen by the others when
         * the call that publishes them returns: the guest's memory is one
         * buffer, its stores in program order.
         */
        FlushProcessWriteBuffers: {
            argBytes: 0,
            handler: ()=>0,
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
    };
}

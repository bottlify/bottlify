/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program can ask the native interface about the machine it is on.
 *
 * Each of these takes an information class, and the classes are an open-ended
 * list of structures the kernel happens to be able to fill in. Only the ones
 * this engine can answer truthfully are answered; every other class is refused
 * with a status. That refusal is the point of the file: a plausible structure
 * full of invented numbers is indistinguishable from a real one to the caller,
 * and it is acted on -- a cache is sized from it, a code path is chosen by it --
 * long before anybody discovers where the numbers came from.
 *
 * Nothing here keeps its own copy of the version or the process identity. Both
 * live in the process block, which is where Windows keeps them and where a
 * program that reads the block itself -- and some do -- will find the same
 * numbers as the ones reported here.
 */

import { PEB, TEB } from '../kernel32/teb.js';
import { STATUS } from './status.js';
import { PROCESSOR } from '../kernel32/processor.js';
import { verifyVersion, windowsVersion } from '../kernel32/versions.js';

/** RTL_OSVERSIONINFOW, and the extended form that also carries the service pack. */
const OSVERSIONINFOW_SIZE = 276;
const OSVERSIONINFOEXW_SIZE = 284;
const OSVERSIONINFO = Object.freeze({
    SIZE_FIELD: 0x000,
    MAJOR: 0x004,
    MINOR: 0x008,
    BUILD: 0x00c,
    PLATFORM: 0x010,
    CSD_VERSION: 0x014,
    SERVICE_PACK_MAJOR: 0x114,
    SERVICE_PACK_MINOR: 0x116,
    SUITE_MASK: 0x118,
    PRODUCT_TYPE: 0x11a,
});

/** szCSDVersion's room, in characters. */
const CSD_VERSION_CHARACTERS = 128;

/** SYSTEM_BASIC_INFORMATION as a 32-bit program declares it. */
const SYSTEM_BASIC = Object.freeze({
    RESERVED: 0x00,
    TIMER_RESOLUTION: 0x04,
    PAGE_SIZE: 0x08,
    PHYSICAL_PAGES: 0x0c,
    LOWEST_PHYSICAL_PAGE: 0x10,
    HIGHEST_PHYSICAL_PAGE: 0x14,
    ALLOCATION_GRANULARITY: 0x18,
    MINIMUM_USER_ADDRESS: 0x1c,
    MAXIMUM_USER_ADDRESS: 0x20,
    ACTIVE_PROCESSORS: 0x24,
    PROCESSOR_COUNT: 0x28,
    SIZE: 0x2c,
});

/** PROCESS_BASIC_INFORMATION, likewise. */
const PROCESS_BASIC = Object.freeze({
    EXIT_STATUS: 0x00,
    PEB_BASE_ADDRESS: 0x04,
    AFFINITY_MASK: 0x08,
    BASE_PRIORITY: 0x0c,
    PROCESS_ID: 0x10,
    PARENT_PROCESS_ID: 0x14,
    SIZE: 0x18,
});

/** The information classes answered here. */
const SYSTEM_BASIC_INFORMATION = 0;
const PROCESS_BASIC_INFORMATION = 0;
const PROCESS_DEBUG_PORT = 7;
const PROCESS_EXECUTE_FLAGS = 0x22;

/**
 * The process's execute flags: data runs as code, and that cannot be changed.
 * It is what this engine does -- no page refuses to execute -- told the way
 * a system whose DEP is always off tells it.
 */
const EXECUTE_FLAGS = 0x2 | 0x8;
const OBJECT_BASIC_INFORMATION = 0;

/**
 * OBJECT_BASIC_INFORMATION: attributes, granted access, the two counts, pool
 * usage, three reserved words, three lengths and the creation time.
 */
const OBJECT_BASIC = Object.freeze({
    GRANTED_ACCESS: 0x04,
    HANDLE_COUNT: 0x08,
    POINTER_COUNT: 0x0c,
    SIZE: 0x38,
});

/** STANDARD_RIGHTS_ALL | SPECIFIC_RIGHTS_ALL: every right any object has. */
const ALL_ACCESS = 0x001fffff;

/** NtCurrentProcess() and NtCurrentThread(), which name without a table entry. */
const CURRENT_PROCESS = 0xffffffff;
const CURRENT_THREAD = 0xfffffffe;

/** Facts about the machine this engine presents, not preferences. */
const PAGE_SIZE = 0x1000;
const ALLOCATION_GRANULARITY = 0x10000;
const MINIMUM_USER_ADDRESS = 0x00010000;
const MAXIMUM_USER_ADDRESS = 0x7ffeffff;

/**
 * The clock tick, in hundreds of nanoseconds. Nothing here interrupts on a
 * timer, so this is the interval a program is told it can expect rather than one
 * measured: the value a program of this era would have found on Windows, and the
 * one a caller that rounds a timeout up to a tick will produce sane numbers from.
 */
const TIMER_RESOLUTION = 156250;

/** How many processors, and the mask that says which. */
const PROCESSOR_COUNT = PROCESSOR.count;
const ACTIVE_PROCESSORS = (1 << PROCESSOR.count) - 1;

/** The priority a process started from the shell runs at. */
const NORMAL_BASE_PRIORITY = 8;

/**
 * @typedef {Object} QueryHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => number} teb  The running thread's block, which is the only
 *           route to the process block a program would take itself.
 * @property {{ base: number, size: number }} arena  The memory the process has.
 * @property {import('../kernel32/versions.js').WindowsVersion} [version]
 *           The machine's Windows, for the two fields the process block does
 *           not hold: the suite and the product type, which Windows keeps in
 *           the page the kernel shares with every process. Absent, the default.
 * @property {(handle: number) => string | null} [handleType]  What a handle
 *           names, or null when it names nothing. Without it NtQueryObject
 *           answers every handle as invalid.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Builds the query half of the table: name -> { argBytes, handler }.
 *
 * All of these are stdcall, which is the bridge's default, so none of them says
 * so. `argBytes` is the size of the argument list the guest compiled against.
 *
 * @param {QueryHost} host
 */
export function createQueryFunctions(host){
    const machine = host.version ?? windowsVersion();

    /** @param {number} at */
    const readU32 = at=>{
        const bytes = host.readMemory(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} at @param {number} value */
    const writeU32If = (at, value)=>{
        if (at !== 0)
        {
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
            host.writeMemory(at, bytes);
        }
    };

    /** @returns {number} the process block, or zero when there is none yet */
    const peb = ()=>{
        const teb = host.teb() >>> 0;
        return teb === 0 ? 0 : readU32(teb + TEB.PEB);
    };

    /**
     * The version a process block holds, as the comparison reads one; the
     * suite and product type are the machine's, which the block does not hold.
     *
     * @param {number} block
     * @returns {import('../kernel32/versions.js').ComparedVersion}
     */
    const versionIn = block=>{
        const buildAndPack = readU32(block + PEB.OS_BUILD_NUMBER);
        return {
            major: readU32(block + PEB.OS_MAJOR_VERSION),
            minor: readU32(block + PEB.OS_MINOR_VERSION),
            build: buildAndPack & 0xffff,
            platformId: readU32(block + PEB.OS_PLATFORM_ID),
            servicePackMajor: buildAndPack >>> 24,
            servicePackMinor: buildAndPack >>> 16 & 0xff,
            suiteMask: machine.suiteMask,
            productType: machine.productType,
        };
    };

    return {
        /**
         * NTSTATUS RtlGetVersion(PRTL_OSVERSIONINFOW lpVersionInformation)
         *
         * The size field says which of the two structures the caller allocated,
         * so an unrecognised one means writing past the end of something and
         * nothing is written at all.
         */
        RtlGetVersion: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const at = pointer >>> 0;
                const declared = readU32(at + OSVERSIONINFO.SIZE_FIELD);
                if (declared !== OSVERSIONINFOW_SIZE && declared !== OSVERSIONINFOEXW_SIZE)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const block = peb();
                if (block === 0)
                {
                    // Zeros here would read as a version older than any Windows,
                    // and a program that checks a minimum would refuse to run on
                    // the strength of a structure nobody filled in.
                    return STATUS.UNSUCCESSFUL;
                }

                // Built whole and written from the second field on, so the
                // caller's own size field survives untouched.
                const struct = new Uint8Array(declared);
                const view = new DataView(struct.buffer);
                const version = versionIn(block);
                view.setUint32(OSVERSIONINFO.MAJOR, version.major, true);
                view.setUint32(OSVERSIONINFO.MINOR, version.minor, true);
                view.setUint32(OSVERSIONINFO.BUILD, version.build, true);
                view.setUint32(OSVERSIONINFO.PLATFORM, version.platformId, true);
                // The rest of szCSDVersion stays zeroed rather than whatever
                // the caller left there.
                const csdLength = Math.min(readU32(block + PEB.CSD_VERSION) & 0xffff,
                    (CSD_VERSION_CHARACTERS - 1) * 2);
                const csdText = readU32(block + PEB.CSD_VERSION + 4);
                if (csdLength > 0 && csdText !== 0)
                {
                    struct.set(host.readMemory(csdText, csdLength), OSVERSIONINFO.CSD_VERSION);
                }
                if (declared === OSVERSIONINFOEXW_SIZE)
                {
                    view.setUint16(OSVERSIONINFO.SERVICE_PACK_MAJOR, version.servicePackMajor,
                        true);
                    view.setUint16(OSVERSIONINFO.SERVICE_PACK_MINOR, version.servicePackMinor,
                        true);
                    view.setUint16(OSVERSIONINFO.SUITE_MASK, version.suiteMask, true);
                    view.setUint8(OSVERSIONINFO.PRODUCT_TYPE, version.productType);
                }
                host.writeMemory(at + 4, struct.subarray(4));
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlVerifyVersionInfo(PRTL_OSVERSIONINFOEXW VersionInfo,
         *                               ULONG TypeMask, ULONGLONG ConditionMask)
         *
         * VerifyVersionInfo's comparison against the version RtlGetVersion
         * answers: the machine's own, where kernel32's compares against what
         * the program is told. The request's size field is not read, as
         * VerifyVersionInfo does not read it.
         */
        RtlVerifyVersionInfo: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pointer, typeMask, maskLow, maskHigh])=>{
                const block = peb();
                if (block === 0)
                {
                    return STATUS.UNSUCCESSFUL;
                }
                const at = pointer >>> 0;
                const extended = host.readMemory(at + OSVERSIONINFO.SERVICE_PACK_MAJOR, 8)
                    .slice();
                const fields = new DataView(extended.buffer);
                const answer = verifyVersion(versionIn(block), {
                    major: readU32(at + OSVERSIONINFO.MAJOR),
                    minor: readU32(at + OSVERSIONINFO.MINOR),
                    build: readU32(at + OSVERSIONINFO.BUILD),
                    platformId: readU32(at + OSVERSIONINFO.PLATFORM),
                    servicePackMajor: fields.getUint16(0, true),
                    servicePackMinor: fields.getUint16(2, true),
                    suiteMask: fields.getUint16(4, true),
                    productType: fields.getUint8(6),
                }, typeMask, BigInt(maskLow >>> 0) | BigInt(maskHigh >>> 0) << 32n);
                if (answer === 'met')
                {
                    return STATUS.SUCCESS;
                }
                return answer === 'invalid' ? STATUS.INVALID_PARAMETER : STATUS.REVISION_MISMATCH;
            },
        },

        /**
         * NTSTATUS NtQuerySystemInformation(SYSTEM_INFORMATION_CLASS SystemInformationClass,
         *                                   PVOID SystemInformation,
         *                                   ULONG SystemInformationLength,
         *                                   PULONG ReturnLength)
         *
         * The length a class needs is reported whether or not the buffer was big
         * enough, because that is the two-call protocol every caller of this uses:
         * ask with nothing, allocate, ask again.
         */
        NtQuerySystemInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([infoClass, buffer, length, returnLength])=>{
                if ((infoClass >>> 0) !== SYSTEM_BASIC_INFORMATION)
                {
                    return STATUS.INVALID_INFO_CLASS;
                }
                writeU32If(returnLength >>> 0, SYSTEM_BASIC.SIZE);
                if ((length >>> 0) < SYSTEM_BASIC.SIZE || buffer === 0)
                {
                    return STATUS.INFO_LENGTH_MISMATCH;
                }

                const struct = new Uint8Array(SYSTEM_BASIC.SIZE);
                const view = new DataView(struct.buffer);
                view.setUint32(SYSTEM_BASIC.TIMER_RESOLUTION, TIMER_RESOLUTION, true);
                view.setUint32(SYSTEM_BASIC.PAGE_SIZE, PAGE_SIZE, true);
                // What the process actually has, not a figure chosen to look
                // generous: a program sizes a cache from this, and one told about
                // memory that is not there allocates until it fails.
                const pages = Math.floor(host.arena.size / PAGE_SIZE);
                view.setUint32(SYSTEM_BASIC.PHYSICAL_PAGES, pages, true);
                view.setUint32(SYSTEM_BASIC.LOWEST_PHYSICAL_PAGE, pages === 0 ? 0 : 1, true);
                view.setUint32(SYSTEM_BASIC.HIGHEST_PHYSICAL_PAGE, pages, true);
                view.setUint32(SYSTEM_BASIC.ALLOCATION_GRANULARITY,
                    ALLOCATION_GRANULARITY, true);
                view.setUint32(SYSTEM_BASIC.MINIMUM_USER_ADDRESS,
                    MINIMUM_USER_ADDRESS, true);
                view.setUint32(SYSTEM_BASIC.MAXIMUM_USER_ADDRESS,
                    MAXIMUM_USER_ADDRESS, true);
                view.setUint32(SYSTEM_BASIC.ACTIVE_PROCESSORS, ACTIVE_PROCESSORS, true);
                view.setUint8(SYSTEM_BASIC.PROCESSOR_COUNT, PROCESSOR_COUNT);
                host.writeMemory(buffer >>> 0, struct);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtQueryInformationProcess(HANDLE ProcessHandle,
         *                                    PROCESSINFOCLASS ProcessInformationClass,
         *                                    PVOID ProcessInformation,
         *                                    ULONG ProcessInformationLength,
         *                                    PULONG ReturnLength)
         *
         * The handle is not looked at. There is one process and no way to obtain
         * a handle to another, so every handle a caller can hold names this one.
         */
        NtQueryInformationProcess: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, infoClass, buffer, length, returnLength])=>{
                const wanted = infoClass >>> 0;
                if (wanted === PROCESS_BASIC_INFORMATION)
                {
                    writeU32If(returnLength >>> 0, PROCESS_BASIC.SIZE);
                    if ((length >>> 0) < PROCESS_BASIC.SIZE || buffer === 0)
                    {
                        return STATUS.INFO_LENGTH_MISMATCH;
                    }
                    const teb = host.teb() >>> 0;
                    const struct = new Uint8Array(PROCESS_BASIC.SIZE);
                    const view = new DataView(struct.buffer);
                    // A process that has not exited has no exit status, and both
                    // interfaces spell that as the same number: Win32 calls it
                    // STILL_ACTIVE, the native side STATUS_PENDING.
                    view.setUint32(PROCESS_BASIC.EXIT_STATUS, STATUS.PENDING, true);
                    view.setUint32(PROCESS_BASIC.PEB_BASE_ADDRESS, peb(), true);
                    view.setUint32(PROCESS_BASIC.AFFINITY_MASK, ACTIVE_PROCESSORS, true);
                    view.setUint32(PROCESS_BASIC.BASE_PRIORITY, NORMAL_BASE_PRIORITY, true);
                    view.setUint32(PROCESS_BASIC.PROCESS_ID,
                        teb === 0 ? 0 : readU32(teb + TEB.PROCESS_ID), true);
                    // Nothing started this process, so there is no parent to name.
                    view.setUint32(PROCESS_BASIC.PARENT_PROCESS_ID, 0, true);
                    host.writeMemory(buffer >>> 0, struct);
                    return STATUS.SUCCESS;
                }
                if (wanted === PROCESS_DEBUG_PORT || wanted === PROCESS_EXECUTE_FLAGS)
                {
                    writeU32If(returnLength >>> 0, 4);
                    if ((length >>> 0) < 4 || buffer === 0)
                    {
                        return STATUS.INFO_LENGTH_MISMATCH;
                    }
                    // No debugger is attached, and that is the truth rather than
                    // an evasion: this is asked by code that means to behave
                    // differently under one, and it would find none.
                    writeU32If(buffer >>> 0, wanted === PROCESS_EXECUTE_FLAGS ? EXECUTE_FLAGS : 0);
                    return STATUS.SUCCESS;
                }
                return STATUS.INVALID_INFO_CLASS;
            },
        },

        /**
         * NTSTATUS NtSetInformationProcess(HANDLE ProcessHandle,
         *                                  PROCESSINFOCLASS ProcessInformationClass,
         *                                  PVOID ProcessInformation,
         *                                  ULONG ProcessInformationLength)
         *
         * The execute flags are permanent, so changing them is refused as
         * Windows refuses a permanent policy. Every other class is taken and
         * kept nowhere, and says so.
         */
        NtSetInformationProcess: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, infoClass])=>{
                if ((infoClass >>> 0) === PROCESS_EXECUTE_FLAGS)
                {
                    return STATUS.ACCESS_DENIED;
                }
                host.divergence?.('NtSetInformationProcess',
                    `information class ${infoClass >>> 0} is taken and ignored`);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtQueryObject(HANDLE Handle, OBJECT_INFORMATION_CLASS Class,
         *                        PVOID Information, ULONG Length, PULONG ReturnLength)
         *
         * Only the basic class. The handle table keeps neither the access a
         * handle was opened with nor how many handles share an object, so a
         * handle is answered with every right and counts of one, and says so.
         */
        NtQueryObject: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, infoClass, buffer, length, returnLength])=>{
                const named = handle >>> 0;
                if (named !== CURRENT_PROCESS && named !== CURRENT_THREAD
                    && (host.handleType?.(named) ?? null) === null)
                {
                    return STATUS.INVALID_HANDLE;
                }
                if ((infoClass >>> 0) !== OBJECT_BASIC_INFORMATION)
                {
                    host.divergence?.('NtQueryObject',
                        `information class ${infoClass >>> 0} is refused`);
                    return STATUS.INVALID_INFO_CLASS;
                }
                writeU32If(returnLength >>> 0, OBJECT_BASIC.SIZE);
                if ((length >>> 0) < OBJECT_BASIC.SIZE || buffer === 0)
                {
                    return STATUS.INFO_LENGTH_MISMATCH;
                }
                const struct = new Uint8Array(OBJECT_BASIC.SIZE);
                const view = new DataView(struct.buffer);
                view.setUint32(OBJECT_BASIC.GRANTED_ACCESS, ALL_ACCESS, true);
                view.setUint32(OBJECT_BASIC.HANDLE_COUNT, 1, true);
                view.setUint32(OBJECT_BASIC.POINTER_COUNT, 1, true);
                host.writeMemory(buffer >>> 0, struct);
                host.divergence?.('NtQueryObject',
                    'granted access and counts are not kept; every right and one handle answered');
                return STATUS.SUCCESS;
            },
        },
    };
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * powrprof and pdh — the power-scheme library and the performance-counter
 * library, as a machine answers them that has one power scheme and publishes
 * no counters.
 *
 * A game imports both to raise the processor's scheme while it runs and to
 * show its own processor load; a library that does not load stops the
 * program before its first line. The scheme library reports scheme 0 active
 * and the processor's speed, and keeps no processor policy to read or write
 * -- the answer Windows since Vista gives for the XP-era policy calls. The
 * counter library opens a query and finds no object behind any counter path,
 * so a program that asks for a load learns there is none to read.
 */

const STATUS_SUCCESS = 0;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_NOT_IMPLEMENTED = 0xc0000002;

const ERROR_SUCCESS = 0;
const ERROR_NOT_SUPPORTED = 50;

/** POWER_INFORMATION_LEVEL's ProcessorInformation. */
const PROCESSOR_INFORMATION = 11;
/** PROCESSOR_POWER_INFORMATION: six ULONGs. */
const PROCESSOR_POWER_INFORMATION_SIZE = 24;

const PDH_INVALID_ARGUMENT = 0xc0000bbd;
const PDH_INVALID_HANDLE = 0xc0000bbc;
const PDH_CSTATUS_NO_OBJECT = 0xc0000bb8;
const PDH_NO_DATA = 0x800007d5;

/**
 * @typedef {Object} PowerHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {number} processors  How many processors the process is told of.
 * @property {number} mhz  Their speed, as the registry's `~MHz` says it.
 * @property {(bytes: number) => number} [localAlloc]  LPTR memory the caller LocalFrees
 */

/** The Balanced scheme's GUID, {381b4222-f694-41f0-9685-ff5bb260df2e}, as its bytes. */
const BALANCED = Uint8Array.of(0x22, 0x42, 0x1b, 0x38, 0x94, 0xf6, 0xf0, 0x41,
    0x96, 0x85, 0xff, 0x5b, 0xb2, 0x60, 0xdf, 0x2e);
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** POWER_PLATFORM_ROLE's PlatformRoleDesktop. */
const PLATFORM_ROLE_DESKTOP = 1;

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {PowerHost} host */
export function createPowrprofFunctions(host){
    /** A policy call this machine has no policy for: FALSE, as Vista on answers it. */
    const noPolicy = (/** @type {number} */ argBytes)=>({
        argBytes,
        /** @type {(args: number[]) => number} */
        handler: ()=>{
            host.setLastError(ERROR_NOT_SUPPORTED);
            return 0;
        },
    });

    return {
        /** POWER_PLATFORM_ROLE PowerDeterminePlatformRoleEx(ULONG Version): a desktop. */
        PowerDeterminePlatformRoleEx: { argBytes: 4, handler: ()=>PLATFORM_ROLE_DESKTOP },
        PowerDeterminePlatformRole: { argBytes: 0, handler: ()=>PLATFORM_ROLE_DESKTOP },

        /**
         * DWORD PowerGetActiveScheme(HKEY UserRootPowerKey, GUID **ActivePolicyGuid)
         *
         * Balanced, the one scheme, in a block the caller LocalFrees.
         */
        PowerGetActiveScheme: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const block = host.localAlloc?.(16) ?? 0;
                if (block === 0)
                {
                    return ERROR_NOT_ENOUGH_MEMORY;
                }
                host.writeMemory(block, BALANCED);
                host.writeMemory(out >>> 0, dword(block));
                return ERROR_SUCCESS;
            },
        },

        /**
         * DWORD PowerReadACValue(HKEY, const GUID *Scheme, const GUID *SubGroup,
         *     const GUID *Setting, PULONG Type, LPBYTE Buffer, LPDWORD BufferSize),
         *     PowerReadDCValue alike
         *
         * The scheme keeps no settings to read: ERROR_FILE_NOT_FOUND, as for a
         * setting the scheme does not have.
         */
        PowerReadACValue: { argBytes: 28, handler: ()=>ERROR_FILE_NOT_FOUND },
        PowerReadDCValue: { argBytes: 28, handler: ()=>ERROR_FILE_NOT_FOUND },

        /** BOOLEAN GetActivePwrScheme(PUINT puiID): scheme 0, the only one. */
        GetActivePwrScheme: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([id])=>{
                if ((id >>> 0) !== 0)
                {
                    host.writeMemory(id >>> 0, dword(0));
                }
                return 1;
            },
        },

        /**
         * BOOLEAN SetActivePwrScheme(UINT uiID, PGLOBAL_POWER_POLICY, PPOWER_POLICY)
         *
         * Scheme 0 is active already; any other is not one this machine has.
         */
        SetActivePwrScheme: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([id])=>{
                if ((id >>> 0) === 0)
                {
                    return 1;
                }
                host.setLastError(ERROR_NOT_SUPPORTED);
                return 0;
            },
        },

        /** BOOLEAN ReadProcessorPwrScheme(UINT, PMACHINE_PROCESSOR_POWER_POLICY) */
        ReadProcessorPwrScheme: noPolicy(8),
        /** BOOLEAN WriteProcessorPwrScheme(UINT, PMACHINE_PROCESSOR_POWER_POLICY) */
        WriteProcessorPwrScheme: noPolicy(8),

        /**
         * NTSTATUS CallNtPowerInformation(POWER_INFORMATION_LEVEL InformationLevel,
         *     PVOID InputBuffer, ULONG InputBufferLength, PVOID OutputBuffer,
         *     ULONG OutputBufferLength)
         *
         * ProcessorInformation: one PROCESSOR_POWER_INFORMATION a processor,
         * each at its full speed and never idle. Other levels are not answered.
         */
        CallNtPowerInformation: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([level, , , output, outputLength])=>{
                if ((level >>> 0) !== PROCESSOR_INFORMATION)
                {
                    return STATUS_NOT_IMPLEMENTED;
                }
                const size = host.processors * PROCESSOR_POWER_INFORMATION_SIZE;
                if ((output >>> 0) === 0 || (outputLength >>> 0) < size)
                {
                    return STATUS_BUFFER_TOO_SMALL;
                }
                const bytes = new Uint8Array(size);
                const view = new DataView(bytes.buffer);
                for (let number = 0; number < host.processors; number++)
                {
                    const at = number * PROCESSOR_POWER_INFORMATION_SIZE;
                    view.setUint32(at, number, true);
                    view.setUint32(at + 4, host.mhz, true);
                    view.setUint32(at + 8, host.mhz, true);
                    view.setUint32(at + 12, host.mhz, true);
                }
                host.writeMemory(output >>> 0, bytes);
                return STATUS_SUCCESS;
            },
        },
    };
}

/** @param {{ writeMemory: (address: number, bytes: Uint8Array) => void }} host */
export function createPdhFunctions(host){
    /** Queries open, each a handle. */
    const queries = new Set();
    let nextQuery = 0x5100;

    /**
     * PDH_STATUS PdhOpenQuery(LPCSTR szDataSource, DWORD_PTR dwUserData, PDH_HQUERY *phQuery)
     */
    const openQuery = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([, , out])=>{
            if ((out >>> 0) === 0)
            {
                return PDH_INVALID_ARGUMENT;
            }
            const query = nextQuery;
            nextQuery += 4;
            queries.add(query);
            host.writeMemory(out >>> 0, dword(query));
            return ERROR_SUCCESS;
        },
    };

    /**
     * PDH_STATUS PdhAddCounter(PDH_HQUERY hQuery, LPCSTR szFullCounterPath,
     *     DWORD_PTR dwUserData, PDH_HCOUNTER *phCounter)
     *
     * No counter path names an object here.
     */
    const addCounter = {
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([query])=>(queries.has(query >>> 0) ? PDH_CSTATUS_NO_OBJECT : PDH_INVALID_HANDLE),
    };

    return {
        PdhOpenQueryA: openQuery,
        PdhOpenQueryW: openQuery,
        PdhOpenQuery: openQuery,
        PdhAddCounterA: addCounter,
        PdhAddCounterW: addCounter,
        PdhAddEnglishCounterA: addCounter,
        PdhAddEnglishCounterW: addCounter,

        /** PDH_STATUS PdhCollectQueryData(PDH_HQUERY hQuery): a query with no counters has none. */
        PdhCollectQueryData: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([query])=>(queries.has(query >>> 0) ? PDH_NO_DATA : PDH_INVALID_HANDLE),
        },

        /**
         * PDH_STATUS PdhGetFormattedCounterValue(PDH_HCOUNTER hCounter, DWORD dwFormat,
         *     LPDWORD lpdwType, PPDH_FMT_COUNTERVALUE pValue)
         *
         * No counter was ever handed out, so no handle is one.
         */
        PdhGetFormattedCounterValue: { argBytes: 16, handler: ()=>PDH_INVALID_HANDLE },

        /** PDH_STATUS PdhCloseQuery(PDH_HQUERY hQuery) */
        PdhCloseQuery: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([query])=>(queries.delete(query >>> 0) ? ERROR_SUCCESS : PDH_INVALID_HANDLE),
        },
    };
}

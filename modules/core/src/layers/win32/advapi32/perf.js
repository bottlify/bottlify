/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * Performance counters, version 2: a provider registers its counter sets and
 * publishes instances whose counters it writes in place, and a consumer opens
 * a query and reads the counters it added. Every answer is a Win32 error code.
 *
 * A provider here publishes to nobody -- no other process reads this
 * machine's counters -- so its instances are memory the provider writes and
 * nothing else reads; the calls check what Windows checks, so a provider's
 * mistakes show as they would. A consumer's query finds no counter set but
 * what it is told of, and answers its header with the clocks the program
 * itself reads.
 */

const ERROR_SUCCESS = 0;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_NOT_FOUND = 1168;
const ERROR_WMI_GUID_NOT_FOUND = 4200;

/** PERF_COUNTERSET_INFO and the PERF_COUNTER_INFOs after it. */
const COUNTERSET_INFO_SIZE = 40;
const COUNTER_INFO_SIZE = 32;
/** PERF_COUNTERSET_INSTANCE: the set's GUID, its size, id, name offset and size. */
const INSTANCE_HEADER = 32;
/** PERF_PROVIDER_CONTEXT on a 32-bit machine. */
const PROVIDER_CONTEXT_SIZE = 24;
/** PERF_COUNTER_IDENTIFIER. */
const COUNTER_IDENTIFIER_SIZE = 40;
/** PERF_DATA_HEADER: sizes, three clocks and a SYSTEMTIME. */
const DATA_HEADER_SIZE = 48;

/** A counter's size bits, and the attribute that makes it a pointer. */
const PERF_SIZE_LARGE = 0x100;
const PERF_SIZE_MASK = 0x300;
const PERF_ATTRIB_BY_REFERENCE = 1;

/**
 * @typedef {Object} PerfHost
 * @property {import('../common/guest.js').Guest} guest  the guest's memory at the process's width
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} [release]
 * @property {(code: number) => void} [setLastError]
 * @property {(library: string, name: string, args: number[]) => unknown} [system]
 *           Another library's export, called as the program would call it:
 *           the clocks a query's header is read from.
 */

/**
 * @typedef {Object} CounterSet
 * @property {{ id: number, type: number, byReference: boolean }[]} counters
 */

/** @param {Uint8Array} bytes */
const guidKey = bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join('');

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {PerfHost} host
 */
export function createPerfFunctions(host){
    const { guest } = host;
    /**
     * Each provider, by the address its handle is: its counter sets by GUID.
     *
     * @type {Map<number, Map<string, CounterSet>>}
     */
    const providers = new Map();
    /** Each instance a provider made, by its address: the set it is of. @type {Map<number, CounterSet>} */
    const instances = new Map();
    /** The queries open. */
    const queries = new Set();


    /** @param {number} guid @param {number} out */
    const startProvider = (guid, out)=>{
        if ((guid >>> 0) === 0 || (out >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        // A pointer to memory of the provider's, not a kernel handle.
        const handle = host.allocate(16);
        guest.setBytes(handle, guest.snapshot(guid, 16));
        providers.set(handle >>> 0, new Map());
        guest.set32(out, handle);
        return ERROR_SUCCESS;
    };

    /**
     * The counter of an instance a value is written to, and why not.
     *
     * @param {number} provider @param {number} instance @param {number} id
     * @returns {{ at: number, counter: { type: number, byReference: boolean } } | number}
     */
    const counterOf = (provider, instance, id)=>{
        const set = providers.has(provider >>> 0) ? instances.get(instance >>> 0) : undefined;
        if (!set)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const index = set.counters.findIndex(counter=>counter.id === (id >>> 0));
        return index < 0 ? ERROR_NOT_FOUND
            : { at: (instance >>> 0) + INSTANCE_HEADER + index * 8, counter: set.counters[index] };
    };

    /**
     * PerfSetULongCounterValue and PerfSetULongLongCounterValue: the value,
     * in place, for a counter of that size held by value.
     *
     * @param {boolean} large
     */
    const setValue = large=>({
        argBytes: large ? 20 : 16,
        // A ULONGLONG value is one slot to a 64-bit caller.
        ...large ? { quadwords: [3] } : {},
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [provider, instance, id, low, high])=>{
            const found = counterOf(provider, instance, id);
            if (typeof found === 'number')
            {
                return found;
            }
            if (found.counter.byReference
                || ((found.counter.type & PERF_SIZE_MASK) === PERF_SIZE_LARGE) !== large)
            {
                return ERROR_INVALID_PARAMETER;
            }
            guest.set32(found.at, low);
            if (large)
            {
                guest.set32(found.at + 4, high);
            }
            return ERROR_SUCCESS;
        },
    });

    return {
        /**
         * ULONG PerfStartProvider(LPGUID ProviderGuid, PERFLIBREQUEST ControlCallback,
         *   HANDLE *phProvider)
         */
        PerfStartProvider: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([guid, , out])=>startProvider(guid, out),
        },

        /**
         * ULONG PerfStartProviderEx(LPGUID ProviderGuid,
         *   PPERF_PROVIDER_CONTEXT ProviderContext, HANDLE *Provider)
         *
         * The context has to say it is at least as large as it is.
         */
        PerfStartProviderEx: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([guid, context, out])=>(wholeAddress(context) === 0
                || guest.u32(context) < PROVIDER_CONTEXT_SIZE ? ERROR_INVALID_PARAMETER
                : startProvider(guid, out)),
        },

        /** ULONG PerfStopProvider(HANDLE ProviderHandle) */
        PerfStopProvider: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([provider])=>{
                if (!providers.delete(provider >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                host.release?.(provider >>> 0);
                return ERROR_SUCCESS;
            },
        },

        /**
         * ULONG PerfSetCounterSetInfo(HANDLE ProviderHandle,
         *   PPERF_COUNTERSET_INFO Template, ULONG TemplateSize)
         *
         * A set of at least one counter, its counters after it in the
         * template, registered once per provider.
         */
        PerfSetCounterSetInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([provider, template, size])=>{
                const sets = providers.get(provider >>> 0);
                if (!sets || wholeAddress(template) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const count = guest.u32(template + 32);
                if (count === 0 || (size >>> 0) < COUNTERSET_INFO_SIZE + count * COUNTER_INFO_SIZE)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const key = guidKey(guest.snapshot(template, 16));
                if (sets.has(key))
                {
                    return ERROR_ALREADY_EXISTS;
                }
                const counters = [];
                for (let index = 0; index < count; index++)
                {
                    const at =
                        wholeAddress(template) + COUNTERSET_INFO_SIZE + index * COUNTER_INFO_SIZE;
                    counters.push({ id: guest.u32(at), type: guest.u32(at + 4),
                        byReference: (guest.u32(at + 8) & PERF_ATTRIB_BY_REFERENCE) !== 0 });
                }
                sets.set(key, { counters });
                return ERROR_SUCCESS;
            },
        },

        /**
         * PPERF_COUNTERSET_INSTANCE PerfCreateInstance(HANDLE ProviderHandle,
         *   LPCGUID CounterSetGuid, PCWSTR Name, ULONG Id)
         *
         * The instance's header, eight bytes per counter, then its name, the
         * whole rounded to eight. A success leaves the last error alone.
         */
        PerfCreateInstance: {
            returns: 'pointer',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([provider, guid, namePointer, id])=>{
                const sets = providers.get(provider >>> 0);
                const name = guest.optionalText(namePointer, true, 0x400 * 2);
                if (!sets || wholeAddress(guid) === 0 || name === null)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const set = sets.get(guidKey(guest.snapshot(guid, 16)));
                if (!set)
                {
                    host.setLastError?.(ERROR_NOT_FOUND);
                    return 0;
                }
                const nameAt = INSTANCE_HEADER + set.counters.length * 8;
                const nameSize = (name.length + 1) * 2;
                const size = nameAt + nameSize + 7 & ~7;
                const bytes = new Uint8Array(size);
                const view = new DataView(bytes.buffer);
                bytes.set(guest.snapshot(guid, 16), 0);
                view.setUint32(16, size, true);
                view.setUint32(20, id >>> 0, true);
                view.setUint32(24, nameAt, true);
                view.setUint32(28, nameSize, true);
                [...name].forEach((char, at)=>view.setUint16(nameAt + at * 2, char.charCodeAt(0),
                    true));
                const instance = host.allocate(size);
                guest.setBytes(instance, bytes);
                instances.set(instance >>> 0, set);
                return instance;
            },
        },

        /** ULONG PerfDeleteInstance(HANDLE Provider, PPERF_COUNTERSET_INSTANCE InstanceBlock) */
        PerfDeleteInstance: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([provider, instance])=>{
                if (!providers.has(provider >>> 0) || !instances.delete(wholeAddress(instance)))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                host.release?.(wholeAddress(instance));
                return ERROR_SUCCESS;
            },
        },

        /**
         * ULONG PerfSetCounterRefValue(HANDLE Provider, PPERF_COUNTERSET_INSTANCE,
         *   ULONG CounterId, PVOID Address)
         *
         * Where a counter held by reference is read from.
         */
        PerfSetCounterRefValue: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([provider, instance, id, address])=>{
                const found = counterOf(provider, instance, id);
                if (typeof found === 'number')
                {
                    return found;
                }
                if (!found.counter.byReference)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                guest.set32(found.at, address);
                guest.set32(found.at + 4, 0);
                return ERROR_SUCCESS;
            },
        },

        PerfSetULongCounterValue: setValue(false),
        PerfSetULongLongCounterValue: setValue(true),

        /** ULONG PerfOpenQueryHandle(LPCWSTR szMachine, HANDLE *hQuery) */
        PerfOpenQueryHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if (wholeAddress(out) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const query = host.allocate(8);
                queries.add(query >>> 0);
                guest.set32(out, query);
                return ERROR_SUCCESS;
            },
        },

        /** ULONG PerfCloseQueryHandle(HANDLE hQuery) */
        PerfCloseQueryHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([query])=>{
                if (!queries.delete(query >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                host.release?.(query >>> 0);
                return ERROR_SUCCESS;
            },
        },

        /**
         * ULONG PerfAddCounters(HANDLE hQuery, PPERF_COUNTER_IDENTIFIER pCounters,
         *   DWORD cbCounters)
         *
         * Each identifier, as long as it says it is, gets its status: no
         * provider here publishes any set, so every one is a GUID not found.
         */
        PerfAddCounters: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([query, counters, size])=>{
                if (!queries.has(query >>> 0) || wholeAddress(counters) === 0
                    || (size >>> 0) < COUNTER_IDENTIFIER_SIZE)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                for (let at = 0; at < (size >>> 0);)
                {
                    const length = guest.u32(counters + at + 20);
                    if (length < COUNTER_IDENTIFIER_SIZE || at + length > (size >>> 0))
                    {
                        return ERROR_INVALID_PARAMETER;
                    }
                    guest.set32(counters + at + 16, ERROR_WMI_GUID_NOT_FOUND);
                    at += length;
                }
                return ERROR_SUCCESS;
            },
        },

        /**
         * ULONG PerfQueryCounterData(HANDLE hQuery, PPERF_DATA_HEADER pCounterBlock,
         *   DWORD cbCounterBlock, DWORD *pcbCounterBlockActual)
         *
         * The header alone -- no counter was found -- stamped with the
         * performance counter, the system time and its frequency, read as
         * the program reads them.
         */
        PerfQueryCounterData: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([query, block, size, actual])=>{
                if (!queries.has(query >>> 0) || wholeAddress(actual) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                guest.set32(actual, DATA_HEADER_SIZE);
                if (wholeAddress(block) === 0 || (size >>> 0) < DATA_HEADER_SIZE)
                {
                    return ERROR_NOT_ENOUGH_MEMORY;
                }
                const at = wholeAddress(block);
                guest.setBytes(at, new Uint8Array(DATA_HEADER_SIZE));
                guest.set32(at, DATA_HEADER_SIZE);
                host.system?.('KERNEL32.dll', 'QueryPerformanceCounter', [at + 8]);
                host.system?.('KERNEL32.dll', 'GetSystemTimeAsFileTime', [at + 16]);
                host.system?.('KERNEL32.dll', 'QueryPerformanceFrequency', [at + 24]);
                host.system?.('KERNEL32.dll', 'FileTimeToSystemTime', [at + 16, at + 32]);
                return ERROR_SUCCESS;
            },
        },
    };
}

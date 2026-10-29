/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
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

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address @returns {string | null} */
    const wideAt = address=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        let text = '';
        for (let at = address >>> 0; text.length < 0x400; at += 2)
        {
            const unit = host.readMemory(at, 2);
            const code = unit[0] | unit[1] << 8;
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };

    /** @param {number} guid @param {number} out */
    const startProvider = (guid, out)=>{
        if ((guid >>> 0) === 0 || (out >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        // A pointer to memory of the provider's, not a kernel handle.
        const handle = host.allocate(16);
        host.writeMemory(handle, host.readMemory(guid >>> 0, 16).slice());
        providers.set(handle >>> 0, new Map());
        writeDword(out, handle);
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
            writeDword(found.at, low);
            if (large)
            {
                writeDword(found.at + 4, high);
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
            handler: ([guid, context, out])=>((context >>> 0) === 0
                || readDword(context) < PROVIDER_CONTEXT_SIZE ? ERROR_INVALID_PARAMETER
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
                if (!sets || (template >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const count = readDword((template >>> 0) + 32);
                if (count === 0 || (size >>> 0) < COUNTERSET_INFO_SIZE + count * COUNTER_INFO_SIZE)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const key = guidKey(host.readMemory(template >>> 0, 16));
                if (sets.has(key))
                {
                    return ERROR_ALREADY_EXISTS;
                }
                const counters = [];
                for (let index = 0; index < count; index++)
                {
                    const at = (template >>> 0) + COUNTERSET_INFO_SIZE + index * COUNTER_INFO_SIZE;
                    counters.push({ id: readDword(at), type: readDword(at + 4),
                        byReference: (readDword(at + 8) & PERF_ATTRIB_BY_REFERENCE) !== 0 });
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
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([provider, guid, namePointer, id])=>{
                const sets = providers.get(provider >>> 0);
                const name = wideAt(namePointer);
                if (!sets || (guid >>> 0) === 0 || name === null)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const set = sets.get(guidKey(host.readMemory(guid >>> 0, 16)));
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
                bytes.set(host.readMemory(guid >>> 0, 16), 0);
                view.setUint32(16, size, true);
                view.setUint32(20, id >>> 0, true);
                view.setUint32(24, nameAt, true);
                view.setUint32(28, nameSize, true);
                [...name].forEach((char, at)=>view.setUint16(nameAt + at * 2, char.charCodeAt(0),
                    true));
                const instance = host.allocate(size);
                host.writeMemory(instance, bytes);
                instances.set(instance >>> 0, set);
                return instance;
            },
        },

        /** ULONG PerfDeleteInstance(HANDLE Provider, PPERF_COUNTERSET_INSTANCE InstanceBlock) */
        PerfDeleteInstance: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([provider, instance])=>{
                if (!providers.has(provider >>> 0) || !instances.delete(instance >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                host.release?.(instance >>> 0);
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
                writeDword(found.at, address);
                writeDword(found.at + 4, 0);
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
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const query = host.allocate(8);
                queries.add(query >>> 0);
                writeDword(out, query);
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
                if (!queries.has(query >>> 0) || (counters >>> 0) === 0
                    || (size >>> 0) < COUNTER_IDENTIFIER_SIZE)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                for (let at = 0; at < (size >>> 0);)
                {
                    const length = readDword((counters >>> 0) + at + 20);
                    if (length < COUNTER_IDENTIFIER_SIZE || at + length > (size >>> 0))
                    {
                        return ERROR_INVALID_PARAMETER;
                    }
                    writeDword((counters >>> 0) + at + 16, ERROR_WMI_GUID_NOT_FOUND);
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
                if (!queries.has(query >>> 0) || (actual >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                writeDword(actual, DATA_HEADER_SIZE);
                if ((block >>> 0) === 0 || (size >>> 0) < DATA_HEADER_SIZE)
                {
                    return ERROR_NOT_ENOUGH_MEMORY;
                }
                const at = block >>> 0;
                host.writeMemory(at, new Uint8Array(DATA_HEADER_SIZE));
                writeDword(at, DATA_HEADER_SIZE);
                host.system?.('KERNEL32.dll', 'QueryPerformanceCounter', [at + 8]);
                host.system?.('KERNEL32.dll', 'GetSystemTimeAsFileTime', [at + 16]);
                host.system?.('KERNEL32.dll', 'QueryPerformanceFrequency', [at + 24]);
                host.system?.('KERNEL32.dll', 'FileTimeToSystemTime', [at + 16, at + 32]);
                return ERROR_SUCCESS;
            },
        },
    };
}

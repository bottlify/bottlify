/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ntdll surface: the native interface underneath Win32.
 *
 * Almost nothing here is a new facility. ntdll is the layer kernel32 is built on
 * top of on a real machine, so most of what it publishes is the same function a
 * program could have reached through kernel32 under a different name -- the same
 * heap, the same critical sections, the same unwind. Those are aliased onto the
 * tables that already implement them rather than reimplemented, and that is not
 * tidiness: a program allocates through RtlAllocateHeap and frees through
 * HeapFree in the same breath, and two allocators would each refuse the other's
 * pointers.
 *
 * The same reasoning covers the C runtime functions ntdll exports. A program
 * that imports `memcpy` from here and `memcpy` from msvcrt is entitled to two
 * functions that behave identically, so there is one implementation and two
 * names for it.
 *
 * What is genuinely ntdll's own is the counted-string family, the status
 * translation, the queries about the machine, and the compiler's 64-bit
 * helpers -- each in its own file beside this one.
 */

import { createCountedStringFunctions } from './strings.js';
import { createQueryFunctions } from './query.js';
import { createImageFunctions } from './image.js';
import { createIntegerFunctions } from './integer.js';
import { createWaitFunctions } from './waits.js';
import { createPathFunctions } from './paths.js';
import { MEMORY_ENTRIES, createMemoryFunctions } from './memory.js';
import { createDebugFunctions } from './debug.js';
import { createProcessFunctions } from './process.js';
import { STATUS, toDosError } from './status.js';
import { REGISTRY_NATIVES, UNLOAD_KEY } from '../advapi32/functions.js';
import { TOKEN_NATIVES } from '../advapi32/tokens.js';

/**
 * The C runtime functions ntdll publishes under its own name.
 *
 * This list says what ntdll exports, not what this engine implements. A name the
 * runtime beside us does not have stays unexported, so an import that needs it
 * fails by naming the function rather than by reaching a second implementation
 * with its own bugs.
 */
const CRT_EXPORTS = [
    'memchr', 'memcpy', 'memmove', 'memset', 'memcmp',
    'qsort', 'bsearch',
    'sprintf', '_snprintf', '_snwprintf', 'vsprintf', 'sscanf',
    'strcat', 'strchr', 'strcmp', 'strcpy', 'strcspn', 'strlen', 'strncat',
    'strncmp', 'strncpy', 'strpbrk', 'strrchr', 'strspn', 'strstr',
    '_stricmp', '_strnicmp', '_strlwr', '_strupr',
    'atoi', 'atol', 'strtol', 'strtoul',
    '_itoa', '_ltoa', '_ultoa', '_i64toa', '_ui64toa',
    'tolower', 'toupper',
    'isalnum', 'isalpha', 'iscntrl', 'isdigit', 'islower',
    'isprint', 'ispunct', 'isspace', 'isupper', 'isxdigit',
    'abs', 'labs',
    'mbstowcs', 'wcstombs',
    'wcscat', 'wcschr', 'wcscmp', 'wcscpy', 'wcslen', 'wcsncat', 'wcsncmp',
    'wcsncpy', 'wcsrchr', 'wcsstr', '_wcsicmp',
];

/**
 * The names ntdll exports for functions kernel32 exports too, and what they are
 * called there. Each pair is the same entry point on a real machine.
 */
/** 'MZ' and 'PE' with two zero bytes, as an image's two headers begin. */
const IMAGE_DOS_SIGNATURE = 0x5a4d;
const IMAGE_NT_SIGNATURE = 0x00004550;

const KERNEL32_ALIASES = Object.freeze({
    RtlAddVectoredExceptionHandler: 'AddVectoredExceptionHandler',
    RtlRemoveVectoredExceptionHandler: 'RemoveVectoredExceptionHandler',
    RtlAddVectoredContinueHandler: 'AddVectoredContinueHandler',
    RtlRemoveVectoredContinueHandler: 'RemoveVectoredContinueHandler',
    RtlAllocateHeap: 'HeapAlloc',
    RtlFreeHeap: 'HeapFree',
    RtlReAllocateHeap: 'HeapReAlloc',
    RtlSizeHeap: 'HeapSize',
    RtlInitializeCriticalSection: 'InitializeCriticalSection',
    RtlInitializeCriticalSectionAndSpinCount: 'InitializeCriticalSectionAndSpinCount',
    RtlDeleteCriticalSection: 'DeleteCriticalSection',
    RtlEnterCriticalSection: 'EnterCriticalSection',
    RtlLeaveCriticalSection: 'LeaveCriticalSection',
    RtlTryEnterCriticalSection: 'TryEnterCriticalSection',
    RtlGetLastWin32Error: 'GetLastError',
    RtlSetLastWin32Error: 'SetLastError',
    // Not a rename: kernel32 forwards this one to ntdll on a real machine, and
    // the walk it drives is the same walk a processor fault goes through here.
    RtlUnwind: 'RtlUnwind',
    // Forwarded the same way (kernel32.spec), so a mask built through either
    // name is the one both comparisons read.
    VerSetConditionMask: 'VerSetConditionMask',
    // The interlocked lists: kernel32's are ntdll's on Windows.
    RtlInitializeSListHead: 'InitializeSListHead',
    RtlQueryDepthSList: 'QueryDepthSList',
    RtlInterlockedPushEntrySList: 'InterlockedPushEntrySList',
    RtlInterlockedPopEntrySList: 'InterlockedPopEntrySList',
    RtlInterlockedFlushSList: 'InterlockedFlushSList',
    // kernel32's is forwarded to the Rtl one; the Nt one is the system call
    // under it, with the same answer.
    RtlGetCurrentProcessorNumber: 'GetCurrentProcessorNumber',
    NtGetCurrentProcessorNumber: 'GetCurrentProcessorNumber',
});

/**
 * @typedef {{ argBytes: number, convention?: string, handler: Function,
 *     natives?: Record<string, any> }} Entry
 *     `natives`: the native calls ntdll publishes over the state this entry's
 *     own table keeps.
 */

/**
 * @typedef {Object} NtdllHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {Record<string, Entry>} kernel32  The assembled KERNEL32.dll table.
 * @property {Record<string, Entry>} crt       The assembled msvcrt.dll table.
 * @property {() => number} teb  The running thread's block.
 * @property {() => any} [currentThread]
 * @property {(thread: any) => number} [lastErrorOf]  A thread's last error, which a call
 *           answered by another process leaves after its thread stopped running.
 * @property {{ base: number, size: number }} arena  The memory the process has.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *           Without it the 64-bit helpers stay unexported: their answer does not
 *           fit in the one register the dispatcher writes.
 * @property {import('../kernel32/versions.js').WindowsVersion} [windows]
 *           The machine's Windows, for what RtlGetVersion cannot read from the
 *           process block. Absent, the default.
 * @property {() => import('./query.js').SystemProcess[]} [processes]
 *           What SystemProcessInformation lists.
 * @property {(handle: number) => string | null} [handleType]
 * @property {import('./query.js').QueryHost['processOf']} [processOf]
 * @property {import('./query.js').QueryHost['askChild']} [askChild]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {Record<string | symbol, any>} [advapi32]
 *           The assembled ADVAPI32.dll table, whose registry NtUnloadKey
 *           unloads a hive from. Absent, NtUnloadKey stays unexported.
 * @property {import('../kernel32/processor.js').Processors} [processors]
 *           The process's processors, kernel32's own. Absent, one.
 */

/**
 * Takes entries from another library's table under the names ntdll exports them
 * by, dropping any that table does not have.
 *
 * @param {Record<string, Entry>} table
 * @param {Record<string, string>} names  ntdll's name -> the other table's name
 * @returns {Record<string, Entry>}
 */
const alias = (table, names)=>Object.fromEntries(
    Object.entries(names)
        .filter(([, from])=>table[from] !== undefined)
        .map(([to, from])=>[to, table[from]]));

/**
 * The kernel32 calls the native process calls are made of. A table without
 * them -- a host that assembled no processes -- leaves those unexported.
 */
const PROCESS_ENTRIES = ['ResumeThread', 'OpenProcess', 'FindResourceExW', 'LoadResource',
    'SizeofResource'];

/** Where a thread block keeps its process's block. */
const TEB_PEB = 0x30;

/** @param {Uint8Array} bytes  Four of them, little-endian. */
const readU32 = bytes=>(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;

/** The user flags a heap block may carry, HEAP_SETTABLE_USER_FLAGS, and a new block's. */
const SETTABLE_USER_FLAGS = 0xe00;
const DEFAULT_USER_FLAGS = 0x200;
const ERROR_INVALID_PARAMETER = 87;

/**
 * The value and flags a program may keep in a heap block of its own:
 * RtlSetUserValueHeap, RtlSetUserFlagsHeap and RtlGetUserInfoHeap, over the
 * blocks kernel32's heaps hand out. A pointer that is no live block of the
 * heap is refused, as the heap refuses it.
 *
 * @param {Record<string, Entry>} kernel32
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 * @returns {Record<string, Entry>}
 */
function createUserInfoFunctions(kernel32, writeMemory){
    /** @type {Map<number, { value: number, flags: number }>} by block */
    const kept = new Map();
    /** @param {number} heap @param {number} block */
    const infoOf = (heap, block)=>{
        if (kernel32.HeapValidate.handler([heap, 0, block]) === 0 || block === 0)
        {
            kernel32.SetLastError?.handler([ERROR_INVALID_PARAMETER]);
            return null;
        }
        let info = kept.get(block);
        if (!info)
        {
            info = { value: 0, flags: DEFAULT_USER_FLAGS };
            kept.set(block, info);
        }
        return info;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        writeMemory(address, bytes);
    };
    return {
        /** BOOLEAN RtlGetUserInfoHeap(HANDLE, ULONG, PVOID, PVOID *UserValue, PULONG UserFlags) */
        RtlGetUserInfoHeap: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([heap, , block, value, flags])=>{
                const info = infoOf(heap >>> 0, block >>> 0);
                if (!info)
                {
                    return 0;
                }
                if ((value >>> 0) !== 0)
                {
                    writeU32(value >>> 0, info.value);
                }
                if ((flags >>> 0) !== 0)
                {
                    writeU32(flags >>> 0, info.flags);
                }
                return 1;
            },
        },
        /** BOOLEAN RtlSetUserValueHeap(HANDLE, ULONG, PVOID, PVOID UserValue) */
        RtlSetUserValueHeap: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([heap, , block, value])=>{
                const info = infoOf(heap >>> 0, block >>> 0);
                if (!info)
                {
                    return 0;
                }
                info.value = value >>> 0;
                return 1;
            },
        },
        /** BOOLEAN RtlSetUserFlagsHeap(HANDLE, ULONG, PVOID, ULONG FlagsReset, ULONG FlagsSet) */
        RtlSetUserFlagsHeap: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([heap, , block, reset, set])=>{
                if (((reset | set) & ~SETTABLE_USER_FLAGS) !== 0)
                {
                    kernel32.SetLastError?.handler([ERROR_INVALID_PARAMETER]);
                    return 0;
                }
                const info = infoOf(heap >>> 0, block >>> 0);
                if (!info)
                {
                    return 0;
                }
                info.flags = ((info.flags & ~reset) | set) >>> 0;
                return 1;
            },
        },
    };
}

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * Everything ntdll defines itself is stdcall, which is the bridge's default, so
 * none of those says so; the C runtime functions arrive from msvcrt already
 * carrying their own cdecl declaration.
 *
 * @param {NtdllHost} host
 * @returns {Record<string, Entry>}
 */
export function createNtdllFunctions(host){
    const { kernel32, crt } = host;

    // The process heap, reached the way a program reaches it. What this library
    // hands a caller has to be what RtlFreeHeap and HeapFree both take back, and
    // a block allocated outside that heap belongs to neither.
    const processHeap = kernel32.GetProcessHeap.handler([]) >>> 0;

    /** @param {number} bytes */
    const allocate = bytes=>kernel32.HeapAlloc.handler([processHeap, 0, bytes]) >>> 0;
    /** @param {number} address */
    const free = address=>kernel32.HeapFree.handler([processHeap, 0, address]) !== 0;

    // Native calls a kernel32 table builds over state only it holds -- the
    // APC queues -- ride on the entry that shares the state, since nothing
    // here reaches it.
    const natives = Object.assign({}, ...Object.values(kernel32)
        .map(entry=>entry?.natives ?? {}));
    // The registry's native calls ride on advapi32's table, whose keys and
    // handles they are, and a key handle closes there.
    const registry = host.advapi32?.[REGISTRY_NATIVES] ?? null;

    const table = {
        ...alias(kernel32, KERNEL32_ALIASES),
        ...natives,
        ...registry?.entries ?? {},
        // And the token calls on advapi32's, whose handles they open.
        ...host.advapi32?.[TOKEN_NATIVES] ?? {},
        ...alias(crt, Object.fromEntries(CRT_EXPORTS.map(name=>[name, name]))),

        ...createCountedStringFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            readWideString: host.readWideString,
            allocate,
            free,
        }),

        ...createImageFunctions({ readMemory: host.readMemory, writeMemory: host.writeMemory }),

        ...createQueryFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            teb: host.teb,
            arena: host.arena,
            version: host.windows,
            handleType: host.handleType,
            processOf: host.processOf,
            askChild: host.askChild,
            divergence: host.divergence,
            processes: host.processes,
            processors: host.processors,
        }),

        ...(host.setRegisters
            ? createIntegerFunctions({ setRegisters: host.setRegisters })
            : {}),

        ...(['WaitForSingleObjectEx', 'WaitForMultipleObjectsEx', 'SleepEx', 'GetLastError',
            'GetSystemTimeAsFileTime'].every(name=>kernel32[name])
            ? createWaitFunctions({ readMemory: host.readMemory, kernel32, allocate })
            : {}),

        ...(kernel32.GetFullPathNameW
            ? createPathFunctions({ readMemory: host.readMemory,
                writeMemory: host.writeMemory, readWideString: host.readWideString,
                kernel32, allocate, free })
            : {}),

        ...(MEMORY_ENTRIES.every(name=>kernel32[name])
            ? createMemoryFunctions({ readMemory: host.readMemory,
                writeMemory: host.writeMemory, kernel32, allocate,
                currentThread: host.currentThread, lastErrorOf: host.lastErrorOf })
            : {}),

        ...(kernel32.HeapValidate ? createUserInfoFunctions(kernel32, host.writeMemory) : {}),

        ...createDebugFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            kernel32,
            crt,
            teb: host.teb,
            allocate,
            free,
            ...host.divergence ? { divergence: host.divergence } : {},
        }),

        ...(PROCESS_ENTRIES.every(name=>kernel32[name])
            ? createProcessFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                kernel32,
                teb: host.teb,
                allocate,
                free,
            })
            : {}),

        /**
         * NTSTATUS LdrUnloadDll(PVOID BaseAddress)
         *
         * FreeLibrary underneath, as a status. Its presence is what a program
         * built with the Microsoft Layer for Unicode asks to tell NT from
         * Windows 9x: without it the program loads unicows.dll, whose NT
         * forwarding is not what any NT program was run with.
         */
        ...(kernel32.FreeLibrary
            ? {
                LdrUnloadDll: {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([module])=>(kernel32.FreeLibrary.handler([module]) !== 0
                        ? STATUS.SUCCESS : STATUS.DLL_NOT_FOUND),
                },
            }
            : {}),

        /**
         * NTSTATUS NtQuerySystemTime(PLARGE_INTEGER SystemTime)
         *
         * GetSystemTimeAsFileTime's clock, as a status: no place to put it is
         * an access violation.
         */
        ...(kernel32.GetSystemTimeAsFileTime
            ? {
                NtQuerySystemTime: {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([out])=>{
                        if ((out >>> 0) === 0)
                        {
                            return STATUS.ACCESS_VIOLATION;
                        }
                        kernel32.GetSystemTimeAsFileTime.handler([out >>> 0]);
                        return STATUS.SUCCESS;
                    },
                },
            }
            : {}),

        /**
         * NTSTATUS NtUnloadKey(POBJECT_ATTRIBUTES TargetKey)
         *
         * A hive RegLoadKey mounted, named the native way --
         * \REGISTRY\Machine\<key> or \REGISTRY\User\<key> -- unloaded
         * through the same table: a key that is no loaded hive is refused,
         * one a handle is still open on cannot go.
         */
        ...(host.advapi32?.[UNLOAD_KEY]
            ? {
                NtUnloadKey: {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([attributes])=>{
                        const name = (attributes >>> 0) === 0 ? 0
                            : readU32(host.readMemory((attributes >>> 0) + 8, 4));
                        if (name === 0)
                        {
                            return STATUS.INVALID_PARAMETER;
                        }
                        const length = host.readMemory(name, 2);
                        const buffer = readU32(host.readMemory(name + 4, 4));
                        const units = host.readMemory(buffer, length[0] | length[1] << 8);
                        let path = '';
                        for (let at = 0; at + 1 < units.length; at += 2)
                        {
                            path += String.fromCharCode(units[at] | units[at + 1] << 8);
                        }
                        const match = /^\\registry\\(machine|user)\\(.+)$/i.exec(path);
                        if (!match)
                        {
                            return STATUS.OBJECT_NAME_NOT_FOUND;
                        }
                        const HKEY_LOCAL_MACHINE = 0x80000002;
                        const HKEY_USERS = 0x80000003;
                        return host.advapi32?.[UNLOAD_KEY](match[1].toLowerCase() === 'machine'
                            ? HKEY_LOCAL_MACHINE : HKEY_USERS, match[2]);
                    },
                },
            }
            : {}),

        /**
         * NTSTATUS NtShutdownSystem(SHUTDOWN_ACTION Action)
         *
         * No machine to stop or restart: not implemented, as advapi32's
         * InitiateSystemShutdown answers.
         */
        NtShutdownSystem: {
            argBytes: 4,
            handler: ()=>{
                host.divergence?.('NtShutdownSystem', 'there is no machine to restart');
                return STATUS.NOT_IMPLEMENTED;
            },
        },

        /**
         * NTSTATUS NtClose(HANDLE Handle)
         *
         * CloseHandle answered as a status: one handle table, so whatever the
         * handle names -- a file NtCreateFile opened, an event, a thread -- it
         * closes the same way.
         */
        ...(kernel32.CloseHandle
            ? {
                NtClose: {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([handle])=>registry?.close(handle >>> 0)
                        ?? (kernel32.CloseHandle.handler([handle]) !== 0
                            ? STATUS.SUCCESS : STATUS.DLL_NOT_FOUND),
                },
            }
            : {}),

        /**
         * ULONG RtlNtStatusToDosError(NTSTATUS Status)
         *
         * The one bridge between the two error domains, and the reason a program
         * can call an Nt entry point and still report through GetLastError.
         */
        RtlNtStatusToDosError: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([status])=>toDosError(status),
        },

        /**
         * PIMAGE_NT_HEADERS RtlImageNtHeader(PVOID BaseOfImage)
         *
         * The headers an image's DOS stub points at, when the stub is one and
         * they carry the PE signature; NULL for anything else.
         */
        RtlImageNtHeader: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([base])=>{
                const at = base >>> 0;
                if (at === 0)
                {
                    return 0;
                }
                const read = (/** @type {number} */ address)=>{
                    const bytes = host.readMemory(address, 4);
                    return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
                };
                if ((read(at) & 0xffff) !== IMAGE_DOS_SIGNATURE)
                {
                    return 0;
                }
                const headers = (at + read(at + 0x3c)) >>> 0;
                return read(headers) === IMAGE_NT_SIGNATURE ? headers : 0;
            },
        },

        /** PPEB RtlGetCurrentPeb(void): where the running thread's block says it is. */
        RtlGetCurrentPeb: {
            argBytes: 0,
            handler: ()=>{
                const teb = host.teb();
                if (teb === 0)
                {
                    return 0;
                }
                const bytes = host.readMemory(teb + TEB_PEB, 4);
                return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
            },
        },

        /**
         * NTSTATUS RtlWalkHeap(HANDLE HeapHandle, PVOID Entry)
         *
         * kernel32's HeapWalk is this walk on Windows, answered here as a
         * status: its end is STATUS_NO_MORE_ENTRIES, which a caller's
         * `while (!RtlWalkHeap(...))` stops on. HeapWalk hands out no entries
         * here, so the two structures' different layouts never show.
         */
        RtlWalkHeap: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([heap, entry])=>
                (kernel32.HeapWalk.handler([heap, entry]) !== 0 ? 0 : STATUS.NO_MORE_ENTRIES),
        },

        /**
         * VOID RtlZeroMemory(VOID UNALIGNED *Destination, SIZE_T Length)
         *
         * The memory trio are the C runtime's functions with the arguments in a
         * different order, and they call it rather than repeating it. The order
         * is the whole difference and it is where the mistakes are: the fill
         * value comes last here and second there.
         */
        RtlZeroMemory: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, length])=>crt.memset.handler([destination, 0, length]),
        },

        /** VOID RtlFillMemory(VOID UNALIGNED *Destination, SIZE_T Length, UCHAR Fill) */
        RtlFillMemory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, length, fill])=>
                crt.memset.handler([destination, fill, length]),
        },

        /**
         * VOID RtlMoveMemory(VOID UNALIGNED *Destination,
         *                    const VOID UNALIGNED *Source, SIZE_T Length)
         *
         * Named for what it promises: the regions may overlap, and memmove is the
         * function that already honours that.
         */
        RtlMoveMemory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, length])=>
                crt.memmove.handler([destination, source, length]),
        },

        /**
         * SIZE_T RtlCompareMemory(const VOID *Source1, const VOID *Source2,
         *                         SIZE_T Length)
         *
         * Answers how many leading bytes matched, not an ordering. Code that
         * treats this as memcmp reads a complete match as "greater than", and
         * every equality test it makes comes out backwards.
         */
        RtlCompareMemory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, length])=>{
                const total = length >>> 0;
                const a = host.readMemory(left >>> 0, total);
                const b = host.readMemory(right >>> 0, total);
                let matched = 0;
                while (matched < total && a[matched] === b[matched])
                {
                    matched++;
                }
                return matched;
            },
        },
    };
    // A native call answers to both its names: user mode reaches the same
    // entry through Zw as through Nt, and a program asks GetProcAddress for
    // either.
    for (const [name, entry] of Object.entries(table))
    {
        const twin = `Zw${name.slice(2)}`;
        if (name.startsWith('Nt') && !(twin in table))
        {
            /** @type {any} */ (table)[twin] = entry;
        }
    }
    return table;
}

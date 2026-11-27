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
import { HEAP_USER_INFO } from '../kernel32/heap.js';
import { createQueryFunctions, loadOrder } from './query.js';
import { createDebugBufferFunctions } from './debug-buffer.js';
import { createImageFunctions } from './image.js';
import { createIntegerFunctions } from './integer.js';
import { createByteSwapFunctions } from './byte-swap.js';
import { createBitmapFunctions } from './bitmap.js';
import { createWaitFunctions } from './waits.js';
import { createPathFunctions } from './paths.js';
import { createAtomTableFunctions } from './atoms.js';
import { createTimeFunctions } from './time.js';
import { createEnvironmentFunctions } from './environment.js';
import { LOADER_ENTRIES, createLoaderFunctions } from './loader.js';
import { POOL_ENTRIES, createPoolFunctions } from './pool.js';
import { createStringOperations } from './string-ops.js';
import { createNtdllCrt } from './crt.js';
import { createRandomFunctions } from './random.js';
import { createChecksumFunctions } from './checksum.js';
import { createIpStringFunctions } from './ip-strings.js';
import { createCompressionFunctions } from './lznt1.js';
import { createHandleTableFunctions } from './handle-table.js';
import { createSecurityFunctions } from './security.js';
import { MEMORY_ENTRIES, createMemoryFunctions } from './memory.js';
import { HANDLE_ENTRIES, createHandleNatives } from './handles.js';
import { createDebugFunctions } from './debug.js';
import { createProcessFunctions } from './process.js';
import { STATUS, toDosError } from './status.js';
import { probed } from './probe.js';
import { nativeNameOf } from '../kernel32/object-attributes.js';
import { blockLayouts, INTERACTIVE_SESSION } from '../kernel32/teb.js';
import { REGISTRY_NATIVES, UNLOAD_KEY } from '../advapi32/functions.js';
import { TOKEN_NATIVES, USER_SID_TEXT } from '../advapi32/tokens.js';
import { PROCESSOR_NAME } from '../kernel32/processor.js';
import { wholeAddress } from '../common/pointers.js';
import { utf16z } from '../common/utf16.js';

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
    '_snprintf_s', '_snwprintf_s',
    'atoi', 'atol', '_atoi64', 'strtol', 'strtoul',
    '_wtoi', '_wtol', '_wtoi64', 'wcstol', 'wcstoul',
    '_itoa', '_ltoa', '_ultoa', '_i64toa', '_ui64toa',
    '_itow', '_ltow', '_ultow', '_i64tow', '_ui64tow',
    'tolower', 'toupper', 'towlower', 'towupper',
    'isalnum', 'isalpha', 'iscntrl', 'isdigit', 'isgraph', 'islower',
    'isprint', 'ispunct', 'isspace', 'isupper', 'isxdigit',
    'iswalpha', 'iswctype', 'iswdigit', 'iswlower', 'iswspace', 'iswxdigit',
    'abs', 'labs',
    'mbstowcs', 'wcstombs',
    'wcscat', 'wcschr', 'wcscmp', 'wcscpy', 'wcslen', 'wcsncat', 'wcsncmp',
    'wcsncpy', 'wcsrchr', 'wcsstr', '_wcsicmp', '_wcsnicmp', '_wcslwr', '_wcsupr',
];

/**
 * The names ntdll exports for functions kernel32 exports too, and what they are
 * called there. Each pair is the same entry point on a real machine.
 */
/** 'MZ' and 'PE' with two zero bytes, as an image's two headers begin. */
const IMAGE_DOS_SIGNATURE = 0x5a4d;
/** NtQuerySystemInformation's classes answered here, past query.js's own. */
const SYSTEM_KERNEL_DEBUGGER_INFORMATION = 35;
/** SYSTEM_CACHE_INFORMATION, which NtSetSystemInformation sizes too. */
const SYSTEM_FILECACHE_INFORMATION = 21;
const SYSTEM_RANGE_START_INFORMATION = 50;
const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX = 107;
const SYSTEM_CPU_INFORMATION = 1;
/** The emulated view of it, the same structure in a process of the machine's width. */
const SYSTEM_EMULATION_PROCESSOR_INFORMATION = 63;
const SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION = 8;
/** The processor's name as CPUID's leaves 0x80000002 to 4 spell it: 48 bytes and a NUL. */
const SYSTEM_PROCESSOR_BRAND_STRING = 105;
const BRAND_STRING_BYTES = 48;
/**
 * SYSTEM_CPU_INFORMATION's ProcessorFeatureBits (the kernel's KF_ flags) for
 * the IsProcessorFeaturePresent features that have one.
 *
 * @type {[number, number][]}
 */
const KERNEL_FEATURES = [
    [8, 0x2],           // PF_RDTSC_INSTRUCTION_AVAILABLE -> KF_RDTSC
    [2, 0x80],          // PF_COMPARE_EXCHANGE_DOUBLE -> KF_CMPXCHG8B
    [3, 0x100],         // PF_MMX_INSTRUCTIONS_AVAILABLE -> KF_MMX
    [6, 0x2000],        // PF_XMMI_INSTRUCTIONS_AVAILABLE -> KF_XMMI
    [7, 0x4000],        // PF_3DNOW_INSTRUCTIONS_AVAILABLE -> KF_3DNOW
    [10, 0x10000],      // PF_XMMI64_INSTRUCTIONS_AVAILABLE -> KF_XMMI64
    [12, 0x20000000],   // PF_NX_ENABLED -> KF_NOEXECUTE
];
const IMAGE_NT_SIGNATURE = 0x00004550;
/** GetFinalPathNameByHandle's flag for a name under the volume's device. */
const VOLUME_NAME_NT = 0x2;
/** The HEAP_* flags RtlCreateHeap hands on to HeapCreate: no serialize, generate exceptions, executable. */
const HEAP_CREATE_FLAGS = 0x00000001 | 0x00000004 | 0x00040000;

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
    // kernel32's is ntdll's (kernel32.spec forwards it).
    RtlIsProcessorFeaturePresent: 'IsProcessorFeaturePresent',
    NtGetCurrentProcessorNumber: 'GetCurrentProcessorNumber',
    // kernel32's is ntdll's under the same name (kernel32.spec forwards it).
    RtlCaptureStackBackTrace: 'RtlCaptureStackBackTrace',
    // kernel32's is ntdll's on Windows (kernel32.spec forwards it); clr.dll
    // imports it from ntdll to raise its exceptions.
    RtlCaptureContext: 'RtlCaptureContext',
    // kernel32's pointer encoding is ntdll's (kernel32.spec forwards both).
    RtlEncodePointer: 'EncodePointer',
    RtlDecodePointer: 'DecodePointer',
    RtlEncodeSystemPointer: 'EncodeSystemPointer',
    RtlDecodeSystemPointer: 'DecodeSystemPointer',
});

/**
 * @typedef {{ argBytes: number, convention?: string, handler: Function,
 *     natives?: Record<string, any> }} Entry
 *     `natives`: the native calls ntdll publishes over the state this entry's
 *     own table keeps.
 */

/** The handle types a Win32 name can stand for, whose names the named table keeps. */
const NAMED_KINDS = new Set(['event', 'mutex', 'semaphore', 'timer', 'mapping', 'keyedevent', 'job',
    'iocp']);

/**
 * @typedef {Object} NtdllHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {import('../common/guest.js').Guest} guest  The guest's memory at the
 *     process's pointer width.
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {Record<string, Entry>} kernel32  The assembled KERNEL32.dll table.
 * @property {import('./pool.js').PoolDeletions} [pool]  The thread pool's deletions,
 *           answered as statuses.
 * @property {import('./loader.js').LoaderHost['notifications']} [dllNotifications]  The
 *           loader's LdrRegisterDllNotification callbacks.
 * @property {import('./loader.js').LoaderHost['shutdown']} [processShutdown]  The
 *           process's shutdown: whether it began, and LdrShutdownProcess's beginning.
 * @property {Record<string, Entry>} crt       The assembled msvcrt.dll table.
 * @property {(library: string, name: string) => number} [exportAddress]  Where a
 *           system library's export was placed, 0 for none.
 * @property {() => number} teb  The running thread's block.
 * @property {() => number} [processBlock]  The process block, whichever thread runs
 *           or none: a call its parent makes in it runs between its threads' turns.
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
 * @property {() => { win32: string, native: string }} [imagePath]  The program's
 *           path, and as the object manager names it (`\\Device\\HarddiskVolume1\\...`).
 * @property {() => import('./query.js').SystemProcess[]} [processes]
 *           What SystemProcessInformation lists.
 * @property {(handle: number) => string | null} [handleType]
 * @property {(handle: number) => number | null} [handleAccess]
 * @property {(handle: number) => number | null} [handleFlags]
 * @property {() => import('./query.js').OpenHandle[]} [openHandles]
 *           The handles this process holds, what SystemHandleInformation lists.
 * @property {number} [processId]  This process's id.
 * @property {() => Uint8Array | null} [imageInformation]  SECTION_IMAGE_INFORMATION of
 *           the program's image, for ProcessImageInformation.
 * @property {string} [processorName]  CPUID's brand string, what
 *           SystemProcessorBrandString answers.
 * @property {(handle: number) => string | null} [namedObjectName]  The Win32 name
 *     a kernel object was made or opened by, null for one made with none.
 * @property {(handle: number) => string | null | undefined} [pipeName]  A pipe end's
 *     name under the pipe device (`\Device\NamedPipe\name`), null for a pipe made
 *     with no name, undefined for a handle that is no pipe end.
 * @property {import('./query.js').QueryHost['processOf']} [processOf]
 * @property {import('./query.js').QueryHost['askChild']} [askChild]
 * @property {import('./query.js').QueryHost['debugState']} [debugState]
 * @property {import('./query.js').QueryHost['openDebugObject']} [openDebugObject]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {Record<string | symbol, any>} [advapi32]
 *           The assembled ADVAPI32.dll table, whose registry NtUnloadKey
 *           unloads a hive from. Absent, NtUnloadKey stays unexported.
 * @property {import('../kernel32/processor.js').Processors} [processors]
 *           The process's processors, kernel32's own. Absent, one.
 * @property {number} [pointerSize]  8 in a 64-bit process; absent, 4.
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
    'SizeofResource', 'OpenThread', 'GetProcessId', 'GetThreadId'];

/** Where a thread block keeps its process's block. */
const TEB_PEB = 0x30;

/** @param {Uint8Array} bytes  Four of them, little-endian. */
const readU32 = bytes=>(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;

/** TEB.LastStatusValue: where the last status turned into an error is kept. */
const LAST_STATUS = { 4: 0xbf4, 8: 0x1250 };
/** The option bits NtOpenKeyEx knows: REG_OPTION_BACKUP_RESTORE and REG_OPTION_OPEN_LINK. */
const OPEN_KEY_OPTIONS = 0x4 | 0x8;

/** The user flags a heap block may carry, HEAP_SETTABLE_USER_FLAGS. */
const SETTABLE_USER_FLAGS = 0xe00;
const ERROR_INVALID_PARAMETER = 87;

/**
 * The value and flags a program may keep in a heap block of its own:
 * RtlSetUserValueHeap, RtlSetUserFlagsHeap and RtlGetUserInfoHeap, over the
 * record kernel32's heap keeps for each block (`HEAP_USER_INFO`) - the same
 * one a moveable global handle's block carries its handle in. A pointer that
 * is no live block of the heap is refused, as the heap refuses it; a block
 * nothing was kept for has no flags, and its value is left unwritten.
 *
 * @param {Record<string, Entry>} kernel32
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 * @returns {Record<string, Entry>}
 */
function createUserInfoFunctions(kernel32, writeMemory){
    const records = /** @type {any} */ (kernel32)[HEAP_USER_INFO];
    /** @param {number} heap @param {number} block @param {boolean} [make] */
    const infoOf = (heap, block, make = false)=>{
        const info = records(heap, block, make);
        if (!info)
        {
            kernel32.SetLastError?.handler([ERROR_INVALID_PARAMETER]);
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
                const info = infoOf(heap >>> 0, wholeAddress(block));
                if (!info)
                {
                    return 0;
                }
                if (wholeAddress(value) !== 0 && info.value !== undefined)
                {
                    writeU32(wholeAddress(value), info.value);
                }
                if (wholeAddress(flags) !== 0)
                {
                    writeU32(wholeAddress(flags), info.flags);
                }
                return 1;
            },
        },
        /** BOOLEAN RtlSetUserValueHeap(HANDLE, ULONG, PVOID, PVOID UserValue) */
        RtlSetUserValueHeap: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([heap, , block, value])=>{
                const info = infoOf(heap >>> 0, wholeAddress(block), true);
                if (!info)
                {
                    return 0;
                }
                info.value = wholeAddress(value);
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
                const info = infoOf(heap >>> 0, wholeAddress(block), true);
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
    const processHeap = wholeAddress(kernel32.GetProcessHeap.handler([]));
    const lastStatusOffset = LAST_STATUS[host.pointerSize === 8 ? 8 : 4];

    /** @param {number} bytes */
    const allocate = bytes=>wholeAddress(kernel32.HeapAlloc.handler([processHeap, 0, bytes]));
    /** @param {number} address */
    const free = address=>kernel32.HeapFree.handler([processHeap, 0, address]) !== 0;

    /**
     * `length` bytes of a pattern of dwords, written where they go: one byte
     * value repeated is the memory layer's fill, any other pattern made a
     * chunk at a time. A length the destination does not have faults where
     * it ends, as Windows' loop does, with no host buffer of that length.
     *
     * @param {number} destination @param {number} length  a whole number of patterns
     * @param {number[]} dwords
     */
    const fillPattern = (destination, length, dwords)=>{
        if (length === 0)
        {
            return;
        }
        const pattern = new Uint8Array(Uint32Array.from(dwords, dword=>dword >>> 0).buffer);
        if (pattern.every(byte=>byte === pattern[0]))
        {
            host.guest.fill(wholeAddress(destination), pattern[0], length);
            return;
        }
        host.guest.setMade(wholeAddress(destination), length, chunk=>{
            for (let at = 0; at < chunk.length; at++)
            {
                chunk[at] = pattern[at % pattern.length];
            }
        });
    };

    // Native calls a kernel32 table builds over state only it holds -- the
    // APC queues -- ride on the entry that shares the state, since nothing
    // here reaches it.
    const natives = Object.assign({}, ...Object.values(kernel32)
        .map(entry=>entry?.natives ?? {}));
    // The registry's native calls ride on advapi32's table, whose keys and
    // handles they are, and a key handle closes there.
    const registry = host.advapi32?.[REGISTRY_NATIVES] ?? null;

    /**
     * SystemCpuInformation, from what GetSystemInfo and IsProcessorFeaturePresent
     * say of the processor, and SystemProcessorPerformanceInformation, one
     * record a processor of GetSystemTimes' times shared out evenly.
     *
     * @returns {Record<number, import('./query.js').SystemClass>}
     */
    const processorClasses = ()=>{
        /** @type {Record<number, import('./query.js').SystemClass>} */
        const classes = {};
        const scratch = (/** @type {number} */ size, /** @type {(at: number) => void} */ fill)=>{
            const at = allocate(size);
            try
            {
                fill(at);
                return host.readMemory(at, size);
            }
            finally
            {
                free(at);
            }
        };
        if (kernel32.GetSystemInfo && kernel32.IsProcessorFeaturePresent)
        {
            classes[SYSTEM_CPU_INFORMATION] = classes[SYSTEM_EMULATION_PROCESSOR_INFORMATION] = {
                exact: true, read: ()=>{
                    const info = new DataView(scratch(36,
                        at=>kernel32.GetSystemInfo.handler([at])).buffer);
                    let features = 0;
                    for (const [feature, bit] of KERNEL_FEATURES)
                    {
                        if (kernel32.IsProcessorFeaturePresent.handler([feature]) !== 0)
                        {
                            features |= bit;
                        }
                    }
                    const out = new DataView(new ArrayBuffer(12));
                    out.setUint16(0, info.getUint16(0, true), true);
                    out.setUint16(2, info.getUint16(32, true), true);
                    out.setUint16(4, info.getUint16(34, true), true);
                    out.setUint16(6, 0, true);
                    out.setUint32(8, features >>> 0, true);
                    return new Uint8Array(out.buffer);
                } };
        }
        if (kernel32.GetSystemTimes)
        {
            const count = host.processors?.count() ?? 1;
            classes[SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION] = { read: ()=>{
                const times = new DataView(scratch(24, at=>
                    kernel32.GetSystemTimes.handler([at, at + 8, at + 16])).buffer);
                const out = new DataView(new ArrayBuffer(48 * count));
                for (let one = 0; one < count; one++)
                {
                    // IdleTime, KernelTime, UserTime: each processor its share,
                    // the first the remainder too, so that the shares add up to
                    // what GetSystemTimes says - a caller comparing the sums
                    // subtracts one from the other unsigned.
                    for (const field of [0, 1, 2])
                    {
                        const whole = times.getBigUint64(field * 8, true);
                        const share = whole / BigInt(count);
                        out.setBigUint64(one * 48 + field * 8,
                            one === 0 ? whole - share * BigInt(count - 1) : share, true);
                    }
                }
                return new Uint8Array(out.buffer);
            } };
        }
        return classes;
    };

    const time = createTimeFunctions({ readMemory: host.readMemory,
        writeMemory: host.writeMemory, kernel32, allocate, free });

    const table = {
        ...alias(kernel32, KERNEL32_ALIASES),
        ...kernel32.HeapCreate && kernel32.HeapDestroy ? {
            /**
             * PVOID RtlCreateHeap(ULONG Flags, PVOID HeapBase, SIZE_T ReserveSize,
             *   SIZE_T CommitSize, PVOID Lock, PRTL_HEAP_PARAMETERS Parameters)
             *
             * HeapCreate's heap, which is what kernel32's is on Windows. A heap
             * laid over memory the caller gives is not made here: NULL.
             */
            RtlCreateHeap: {
                returns: 'pointer',
                argBytes: 24,
                sizes: [2, 3],
                /** @param {number[]} args */
                handler: ([flags, base, reserve, commit])=>{
                    if (wholeAddress(base) !== 0)
                    {
                        host.divergence?.('RtlCreateHeap', 'a heap over memory the caller'
                            + ' gives is not made');
                        return 0;
                    }
                    return kernel32.HeapCreate.handler([flags & HEAP_CREATE_FLAGS,
                        commit >>> 0, reserve >>> 0]) >>> 0;
                },
            },
            /**
             * PVOID RtlDestroyHeap(PVOID Heap)
             *
             * NULL once the heap is gone; the heap itself when it could not be.
             */
            RtlDestroyHeap: {
                returns: 'pointer',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([heap])=>(kernel32.HeapDestroy.handler([heap]) !== 0 ? 0
                    : wholeAddress(heap)),
            },
        } : {},
        ...natives,
        ...registry?.entries ?? {},
        // And the token calls on advapi32's, whose handles they open.
        ...host.advapi32?.[TOKEN_NATIVES] ?? {},
        // advapi32's is ntdll's on Windows (advapi32.spec forwards it).
        ...host.advapi32?.IsTextUnicode ? { RtlIsTextUnicode: host.advapi32.IsTextUnicode } : {},
        // The SID, ACL and descriptor calls are advapi32's (`security.js`).
        ...createSecurityFunctions({ advapi32: host.advapi32 ?? {}, readMemory: host.readMemory,
            writeMemory: host.writeMemory, teb: host.teb }),
        ...alias(crt, Object.fromEntries(CRT_EXPORTS.map(name=>[name, name]))),
        // Where ntdll's own runtime answers otherwise than msvcrt (`crt.js`).
        ...createNtdllCrt({ readMemory: host.readMemory, writeMemory: host.writeMemory,
            crt }),

        ...createCountedStringFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            readWideString: host.readWideString,
            allocate,
            free,
        }),

        ...createStringOperations({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            readWideString: host.readWideString,
            allocate,
        }),

        ...createImageFunctions({ readMemory: host.readMemory, writeMemory: host.writeMemory }),

        ...createRandomFunctions({ readMemory: host.readMemory, writeMemory: host.writeMemory }),
        ...createChecksumFunctions({ readMemory: host.readMemory }),
        ...createIpStringFunctions({ readMemory: host.readMemory, writeMemory: host.writeMemory }),
        ...createCompressionFunctions({ readMemory: host.readMemory,
            writeMemory: host.writeMemory }),
        ...createHandleTableFunctions({ readMemory: host.readMemory,
            writeMemory: host.writeMemory, allocate, free }),

        ...createAtomTableFunctions({ readMemory: host.readMemory, writeMemory: host.writeMemory,
            readWideString: host.readWideString, allocate, free }),

        ...createBitmapFunctions({ guest: host.guest }),

        ...time.table,

        ...(host.pool && POOL_ENTRIES.every(name=>kernel32[name])
            ? createPoolFunctions({ kernel32, deletions: host.pool,
                writeMemory: host.writeMemory })
            : {}),

        ...(LOADER_ENTRIES.every(name=>kernel32[name])
            ? createLoaderFunctions({ guest: host.guest, kernel32, allocate, free,
                notifications: host.dllNotifications, shutdown: host.processShutdown })
            : {}),

        ...(['GetEnvironmentStringsW', 'SetEnvironmentVariableW'].every(name=>kernel32[name])
            ? createEnvironmentFunctions({ readMemory: host.readMemory,
                writeMemory: host.writeMemory, kernel32, allocate, free })
            : {}),

        ...(host.processId !== undefined && kernel32.GetProcessHeaps
            ? createDebugBufferFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                allocate,
                free,
                processId: host.processId,
                otherProcess: id=>(host.processes?.() ?? []).some(process=>process.id === id),
                modules: ()=>{
                    const layout = blockLayouts(host.pointerSize);
                    const word = (/** @type {number} */ at)=>readU32(host.readMemory(at, 4));
                    const teb = host.teb() >>> 0;
                    const peb = teb === 0 ? 0 : word(teb + layout.teb.PEB);
                    return [...loadOrder(word, peb, layout)].map(entry=>{
                        const name = entry + layout.entry.FULL_DLL_NAME;
                        const units = (word(name) & 0xffff) >>> 1;
                        return {
                            base: word(entry + layout.entry.DLL_BASE),
                            size: word(entry + layout.entry.SIZE_OF_IMAGE),
                            path: units === 0 ? ''
                                : host.readWideString(word(name + 4), units * 2),
                        };
                    });
                },
                heaps: ()=>{
                    const count = kernel32.GetProcessHeaps.handler([0, 0]) >>> 0;
                    const list = allocate(count * 4);
                    if (list === 0)
                    {
                        return [];
                    }
                    kernel32.GetProcessHeaps.handler([count, list]);
                    const bytes = host.readMemory(list, count * 4);
                    free(list);
                    return Array.from({ length: count }, (_, at)=>readU32(bytes.subarray(at * 4)));
                },
                pointerSize: host.pointerSize,
                divergence: host.divergence,
            })
            : {}),

        ...createQueryFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            teb: host.teb,
            ...host.processBlock ? { processBlock: host.processBlock } : {},
            arena: host.arena,
            version: host.windows,
            handleType: host.handleType,
            handleAccess: host.handleAccess,
            handleFlags: host.handleFlags,
            // A file's or folder's name is its path under the volume's device,
            // as GetFinalPathNameByHandle's VOLUME_NAME_NT spells it.
            objectName: handle=>{
                const type = host.handleType?.(handle);
                // A kernel object's name is the Win32 name it was made or
                // opened by, under the object directory that name lives in;
                // one made with no name has none, an empty string.
                if (typeof type === 'string' && NAMED_KINDS.has(type) && host.namedObjectName)
                {
                    const name = host.namedObjectName(handle);
                    return name === null ? '' : nativeNameOf(name, INTERACTIVE_SESSION);
                }
                // A pipe's name is under its device; one made with none has
                // no name to spell.
                if (type === 'pipe' && host.pipeName)
                {
                    const name = host.pipeName(handle);
                    if (name !== undefined)
                    {
                        return name === null ? { status: STATUS.OBJECT_PATH_INVALID } : name;
                    }
                }
                if ((type !== 'file' && type !== 'directory')
                    || !kernel32.GetFinalPathNameByHandleW)
                {
                    return null;
                }
                const room = 32768;
                const buffer = allocate(room * 2);
                if (buffer === 0)
                {
                    return null;
                }
                try
                {
                    const length = kernel32.GetFinalPathNameByHandleW.handler([handle, buffer, room,
                        VOLUME_NAME_NT]) >>> 0;
                    return length === 0 || length >= room ? null
                        : host.readWideString(buffer, length * 2);
                }
                finally
                {
                    free(buffer);
                }
            },
            processOf: host.processOf,
            askChild: host.askChild,
            debugState: host.debugState,
            openDebugObject: host.openDebugObject,
            divergence: host.divergence,
            processes: host.processes,
            imagePath: host.imagePath,
            processors: host.processors,
            openHandles: host.openHandles,
            processId: host.processId,
            ...host.imageInformation ? { imageInformation: host.imageInformation } : {},
            systemClasses: {
                ...time.systemClasses,
                // SYSTEM_KERNEL_DEBUGGER_INFORMATION: no kernel debugger, none
                // present - the machine is not being debugged.
                [SYSTEM_KERNEL_DEBUGGER_INFORMATION]: { read: ()=>Uint8Array.of(0, 1) },
                ...processorClasses(),
                // SYSTEM_CACHE_INFORMATION: the system file cache's sizes and
                // working set. The engine keeps no cache of its own, so every
                // figure is zero; a buffer short of the whole is given its
                // first three ULONGs, as Windows 7 gives them. Its 32-bit
                // layout only.
                .../** @type {Record<number, import('./query.js').SystemClass>} */ (
                    host.pointerSize === 8 ? {} : { [SYSTEM_FILECACHE_INFORMATION]: { head: 12,
                        read: ()=>new Uint8Array(36) } }),
                [SYSTEM_PROCESSOR_BRAND_STRING]: { read: ()=>{
                    const name = host.processorName ?? PROCESSOR_NAME;
                    const bytes = new Uint8Array(BRAND_STRING_BYTES + 1);
                    for (let i = 0; i < Math.min(name.length, BRAND_STRING_BYTES); i++)
                    {
                        bytes[i] = name.charCodeAt(i) & 0x7f;
                    }
                    return bytes;
                } },
                // SYSTEM_RANGE_START_INFORMATION: where the system's half of
                // the address space begins, a pointer wide.
                [SYSTEM_RANGE_START_INFORMATION]: { exact: true,
                    read: ()=>(host.pointerSize === 8
                        ? Uint8Array.of(0, 0, 0, 0, 0, 0x80, 0xff, 0xff)
                        : Uint8Array.of(0, 0, 0, 0x80)) },
            },
            pointerSize: host.pointerSize,
        }),

        ...(host.setRegisters
            ? createIntegerFunctions({ setRegisters: host.setRegisters })
            : {}),

        // A 64-bit ntdll has no byte swaps to export: its compiler inlines them.
        ...(host.setRegisters && host.pointerSize !== 8
            ? createByteSwapFunctions({ setRegisters: host.setRegisters })
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

        ...(HANDLE_ENTRIES.every(name=>kernel32[name]) ? createHandleNatives({ kernel32 }) : {}),

        ...(MEMORY_ENTRIES.every(name=>kernel32[name])
            ? createMemoryFunctions({ readMemory: host.readMemory,
                writeMemory: host.writeMemory, kernel32, allocate, pointerSize: host.pointerSize,
                currentThread: host.currentThread, lastErrorOf: host.lastErrorOf,
                ...host.divergence ? { divergence: host.divergence } : {} })
            : {}),

        ...(/** @type {any} */ (kernel32)[HEAP_USER_INFO]
            ? createUserInfoFunctions(kernel32, host.writeMemory) : {}),

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
            breakPoint: ()=>host.exportAddress?.('ntdll.dll', 'DbgBreakPoint') ?? 0,
        }),

        ...(PROCESS_ENTRIES.every(name=>kernel32[name])
            ? createProcessFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                kernel32,
                teb: host.teb,
                allocate,
                free,
                processes: host.processes,
                native: name=>natives[name],
                ...host.processShutdown ? { terminate: host.processShutdown.terminate } : {},
                ...host.pointerSize ? { pointerSize: host.pointerSize } : {},
                ...host.divergence ? { divergence: host.divergence } : {},
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
                        if (wholeAddress(out) === 0)
                        {
                            return STATUS.ACCESS_VIOLATION;
                        }
                        kernel32.GetSystemTimeAsFileTime.handler([wholeAddress(out)]);
                        return STATUS.SUCCESS;
                    },
                },
            }
            : {}),

        /**
         * NTSTATUS NtQueryDefaultLocale(BOOLEAN UserProfile, PLCID DefaultLocaleId)
         * NTSTATUS NtSetDefaultLocale(BOOLEAN UserProfile, LCID DefaultLocaleId)
         *
         * The user's or the system's default locale, as GetUserDefaultLCID and
         * GetSystemDefaultLCID answer them. The flag is a BOOLEAN, its low
         * byte: a caller that leaves garbage above it still asks for the
         * system's. One locale is installed, so setting another is said and
         * the default stays.
         */
        ...(kernel32.GetUserDefaultLCID && kernel32.GetSystemDefaultLCID
            ? {
                NtQueryDefaultLocale: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([user, out])=>{
                        const lcid = ((user & 0xff) !== 0 ? kernel32.GetUserDefaultLCID
                            : kernel32.GetSystemDefaultLCID).handler([]);
                        host.writeMemory(wholeAddress(out), Uint8Array.of(lcid & 0xff,
                            lcid >>> 8 & 0xff,
                            lcid >>> 16 & 0xff, lcid >>> 24 & 0xff));
                        return STATUS.SUCCESS;
                    },
                },
                NtSetDefaultLocale: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([user, lcid])=>{
                        const which = (user & 0xff) !== 0 ? 'user' : 'system';
                        const current = ((user & 0xff) !== 0 ? kernel32.GetUserDefaultLCID
                            : kernel32.GetSystemDefaultLCID).handler([]);
                        if ((lcid >>> 0) !== current >>> 0)
                        {
                            host.divergence?.('NtSetDefaultLocale', `the ${which} default `
                                + `0x${(lcid >>> 0).toString(16)} is not installed; `
                                + `0x${(current >>> 0).toString(16)} stays`);
                        }
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
                        const name = wholeAddress(attributes) === 0 ? 0
                            : readU32(host.readMemory(wholeAddress(attributes) + 8, 4));
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
         * kernel32's, which CloseHandle answers from: one handle table, so
         * whatever the handle names it closes the same way. A registry key
         * is the registry's own.
         */
        ...(natives.NtClose
            ? {
                NtClose: {
                    argBytes: 4,
                    /** @param {number[]} args */
                    handler: ([handle])=>registry?.close(handle >>> 0)
                        ?? natives.NtClose.handler([handle]),
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
            handler: ([status])=>{
                // The status is kept in the thread's block as it is turned
                // into an error, which RtlGetLastNtStatus reads back.
                const teb = host.teb();
                if (teb !== 0)
                {
                    host.writeMemory(teb + lastStatusOffset, Uint8Array.of(status & 0xff,
                        status >>> 8 & 0xff, status >>> 16 & 0xff, status >>> 24 & 0xff));
                }
                return toDosError(status);
            },
        },

        /** NTSTATUS RtlGetLastNtStatus(void): the status the last error was made from. */
        RtlGetLastNtStatus: {
            argBytes: 0,
            handler: ()=>{
                const teb = host.teb();
                return teb === 0 ? 0 : readU32(host.readMemory(teb + lastStatusOffset, 4));
            },
        },

        /**
         * NTSTATUS RtlFormatCurrentUserKeyPath(PUNICODE_STRING CurrentUserKeyPath)
         *
         * \REGISTRY\USER\ and the user's SID, in a buffer of the process
         * heap that RtlFreeUnicodeString gives back.
         */
        RtlFormatCurrentUserKeyPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                const text = `\\REGISTRY\\USER\\${USER_SID_TEXT}`;
                const bytes = utf16z(text);
                const buffer = allocate(bytes.length);
                if (buffer === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                host.writeMemory(buffer, bytes);
                const descriptor = new Uint8Array(8);
                const view = new DataView(descriptor.buffer);
                view.setUint16(0, text.length * 2, true);
                view.setUint16(2, bytes.length, true);
                view.setUint32(4, buffer, true);
                host.writeMemory(wholeAddress(out), descriptor);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtOpenKeyEx(PHANDLE KeyHandle, ACCESS_MASK DesiredAccess,
         *     POBJECT_ATTRIBUTES ObjectAttributes, ULONG OpenOptions)
         *
         * NtOpenKey with the open options Windows 7 added: backup-restore
         * and opening a link itself change nothing for a key here; any other
         * bit is STATUS_INVALID_PARAMETER.
         */
        ...(registry?.entries?.NtOpenKey
            ? {
                NtOpenKeyEx: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([out, access, attributes, options])=>(
                        ((options >>> 0) & ~OPEN_KEY_OPTIONS) !== 0 ? STATUS.INVALID_PARAMETER
                            : registry.entries.NtOpenKey.handler([out, access, attributes])),
                },
            }
            : {}),

        /**
         * PIMAGE_NT_HEADERS RtlImageNtHeader(PVOID BaseOfImage)
         *
         * The headers an image's DOS stub points at, when the stub is one and
         * they carry the PE signature; NULL for anything else.
         */
        RtlImageNtHeader: {
            returns: 'pointer',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([base])=>{
                const at = wholeAddress(base);
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
            returns: 'pointer',
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
            sizes: [1],
            /** @param {number[]} args */
            handler: ([destination, length])=>crt.memset.handler([destination, 0, length]),
        },

        /** VOID RtlFillMemory(VOID UNALIGNED *Destination, SIZE_T Length, UCHAR Fill) */
        RtlFillMemory: {
            argBytes: 12,
            sizes: [1],
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
            sizes: [2],
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
            sizes: [2],
            /** @param {number[]} args */
            handler: ([left, right, length])=>{
                const total = length >>> 0;
                const a = host.readMemory(wholeAddress(left), total);
                const b = host.readMemory(wholeAddress(right), total);
                let matched = 0;
                while (matched < total && a[matched] === b[matched])
                {
                    matched++;
                }
                return matched;
            },
        },

        /**
         * SIZE_T RtlCompareMemoryUlong(PVOID Source, SIZE_T Length, ULONG Pattern)
         *
         * How many bytes, in whole ULONGs from the start, hold the pattern; a
         * length past the last whole ULONG is not looked at.
         */
        RtlCompareMemoryUlong: {
            argBytes: 12,
            sizes: [1],
            /** @param {number[]} args */
            handler: ([source, length, pattern])=>{
                const words = (length >>> 0) >>> 2;
                const bytes = words === 0 ? new Uint8Array(0)
                    : host.readMemory(wholeAddress(source), words * 4);
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
                let matched = 0;
                while (matched < words && view.getUint32(matched * 4, true) === pattern >>> 0)
                {
                    matched++;
                }
                return matched * 4;
            },
        },

        /** VOID RtlFillMemoryUlong(PVOID Destination, SIZE_T Length, ULONG Pattern) */
        RtlFillMemoryUlong: {
            argBytes: 12,
            sizes: [1],
            /** @param {number[]} args */
            handler: ([destination, length, pattern])=>{
                fillPattern(destination, (length & ~3) >>> 0, [pattern]);
                return 0;
            },
        },

        /** VOID RtlFillMemoryUlonglong(PVOID Destination, SIZE_T Length, ULONGLONG Pattern) */
        RtlFillMemoryUlonglong: {
            argBytes: 16,
            quadwords: [2],
            /** @param {number[]} args */
            handler: ([destination, length, low, high])=>{
                fillPattern(destination, (length & ~7) >>> 0, [low, high]);
                return 0;
            },
        },
    };
    const query = /** @type {any} */ (table).NtQuerySystemInformation;
    if (query && kernel32.GetLogicalProcessorInformationEx)
    {
        /**
         * NTSTATUS NtQuerySystemInformationEx(SYSTEM_INFORMATION_CLASS, PVOID InputBuffer,
         *     ULONG InputLength, PVOID SystemInformation, ULONG Length, PULONG ReturnLength)
         *
         * The classes that take an input: the logical processors of one
         * relationship (kernel32's records, which GetLogicalProcessorInformationEx
         * is built on). Any other class takes none and is not asked this way.
         */
        /** @type {any} */ (table).NtQuerySystemInformationEx = {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([infoClass, input, inputLength, buffer, length, returnLength])=>{
                if ((infoClass >>> 0) !== SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)
                {
                    return STATUS.INVALID_INFO_CLASS;
                }
                if ((inputLength >>> 0) < 4 || (input >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const relation = readU32(host.readMemory(wholeAddress(input), 4));
                const size = allocate(4);
                try
                {
                    host.writeMemory(size, Uint8Array.of(length & 0xff, length >>> 8 & 0xff,
                        length >>> 16 & 0xff, length >>> 24 & 0xff));
                    const ok = kernel32.GetLogicalProcessorInformationEx.handler(
                        [relation, buffer >>> 0, size]) !== 0;
                    const needed = readU32(host.readMemory(size, 4));
                    if ((returnLength >>> 0) !== 0)
                    {
                        host.writeMemory(wholeAddress(returnLength), host.readMemory(size, 4));
                    }
                    if (ok)
                    {
                        return STATUS.SUCCESS;
                    }
                    return needed > (length >>> 0) ? STATUS.INFO_LENGTH_MISMATCH
                        : STATUS.INVALID_PARAMETER;
                }
                finally
                {
                    free(size);
                }
            },
        };
    }
    // A native call is a system call: the kernel probes the pointers it is
    // handed and answers one it cannot reach with STATUS_ACCESS_VIOLATION,
    // where the same pointer handed to a user-mode Rtl function faults.
    // An entry another library's table owns (a kernel32 entry ntdll exports
    // under its own name, advapi32's registry and token calls) is that table's
    // own and stays the same entry; the registry's and the token calls are
    // probed where they are made (`probe.js`). The native calls kernel32's tables carry
    // (NtReadFile, NtWriteFile, the APC calls) are ntdll's alone, and probed
    // as every other one is: NtWriteFile of a NULL buffer answers
    // STATUS_ACCESS_VIOLATION, as Wine's ntdll:file asks.
    const foreign = new Set([...Object.values(kernel32),
        ...Object.values(registry?.entries ?? {}),
        ...Object.values(host.advapi32?.[TOKEN_NATIVES] ?? {})]);
    for (const [name, entry] of Object.entries(table))
    {
        if (name.startsWith('Nt') && typeof entry?.handler === 'function' && !foreign.has(entry))
        {
            /** @type {any} */ (table)[name] = { ...entry, handler: probed(entry.handler) };
        }
    }
    if (/** @type {any} */ (table).NtQuerySystemInformation)
    {
        // The native view and the process's are one where the process is the
        // machine's own width, as every process here is: the same system call.
        /** @type {any} */ (table).RtlGetNativeSystemInformation =
            /** @type {any} */ (table).NtQuerySystemInformation;
    }
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

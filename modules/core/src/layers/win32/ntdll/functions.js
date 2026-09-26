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
import { createIntegerFunctions } from './integer.js';
import { toDosError } from './status.js';

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
    'sprintf', '_snprintf', 'vsprintf', 'sscanf',
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
const KERNEL32_ALIASES = Object.freeze({
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
});

/**
 * @typedef {{ argBytes: number, convention?: string, handler: Function }} Entry
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
 * @property {{ base: number, size: number }} arena  The memory the process has.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *           Without it the 64-bit helpers stay unexported: their answer does not
 *           fit in the one register the dispatcher writes.
 * @property {import('../kernel32/versions.js').WindowsVersion} [windows]
 *           The machine's Windows, for what RtlGetVersion cannot read from the
 *           process block. Absent, the default.
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

    return {
        ...alias(kernel32, KERNEL32_ALIASES),
        ...alias(crt, Object.fromEntries(CRT_EXPORTS.map(name=>[name, name]))),

        ...createCountedStringFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            readWideString: host.readWideString,
            allocate,
            free,
        }),

        ...createQueryFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            teb: host.teb,
            arena: host.arena,
            version: host.windows,
        }),

        ...(host.setRegisters
            ? createIntegerFunctions({ setRegisters: host.setRegisters })
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
}

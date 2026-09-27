/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The msvcrt surface: the C runtime a Win32 program links against.
 *
 * Every one of these is cdecl -- the caller pops its own arguments -- which is
 * why `argBytes` here describes the signature and nothing else. It is what the
 * arguments occupy on the guest stack, not what the callee cleans up, and the
 * two numbers only happen to coincide under stdcall.
 *
 * The return values are as much of the contract as the arguments are: guest
 * code chains `strcpy` into `strcat`, tests the sign of `strcmp`, and counts
 * the characters `printf` produced. Where the C standard leaves a case
 * undefined, the choice made here is written down at the function.
 */

import { formatToString, guestAccess, varargsSlots } from './format.js';
import { createStringFunctions } from './strings.js';
import { createConversionFunctions } from './convert.js';
import { createScanFunctions, VARIADIC_SLOTS } from './scan.js';
import { createHeapFunctions } from './heap.js';
import { createTimeFunctions } from './time.js';
import { createPathFunctions } from './paths.js';
import {
    createWideFunctions, createWideClassificationFunctions, createMultiByteFunctions,
} from './mbstring.js';
import { createCxxFunctions } from './cxx.js';
import { guestEntry, guestExport } from './guest-code.js';
import * as inGuest from './inguest.js';
import { COMPILED } from './inguest.x86.js';
import { createMathFunctions } from './math.js';
import { readDouble } from './float.js';
import { createStartupFunctions } from './startup.js';
import { createStdioFunctions, standardRecords } from './stdio.js';
import { createThreadFunctions } from './threads.js';
import { createGlobals, EINVAL, ERANGE } from './globals.js';
import { createDescriptors, createIoFunctions } from './io.js';
import { createEnvironment } from './environ.js';
import { createMultiBytePage } from './mbcs.js';
import { bytesOfUnits, unitsOfText, wideStringAt } from './widetext.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

/** How many argument slots a `va_list` is read for, since it carries no count. */
const VA_LIST_SLOTS = 64;

/**
 * A string is scanned no further than this. Nothing in C bounds `strlen`, so a
 * guest that hands us an unterminated buffer would otherwise walk its whole
 * address space before failing.
 */
const MAX_STRING = 1 << 20;

/** The largest number `rand` produces, which a caller scales its range by. */
const RAND_MAX = 0x7fff;


/**
 * @typedef {Object} MsvcrtHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => { base: number, size: number } | null} [regionAt]
 *           The region an address sits in, from the memory layer's map: the
 *           `va_list` window stops at its end rather than faulting the run.
 * @property {(address: number, value: number, length: number) => void} fillMemory
 *     Sets a range to one byte value in place, with no host buffer holding
 *     the pattern: the lengths are the program's, and a clear of a megabyte
 *     through writeMemory costs an allocation and two extra passes.
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, limit: number, wanted: Uint8Array) =>
 *            { index: number, byte: number }} scanCString
 *     Walks a guest string's bytes in chunks and answers with the first one a
 *     table marks -- or the terminator -- without materialising the string:
 *     the scan under the C functions whose answer is a position or a length.
 * @property {(handle: number, text: string) => void} write   Where stdout goes.
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} callGuest
 * @property {() => any} [currentThread]
 *            Runs a guest routine and resolves with what it returned.
 * @property {(bytes: number) => number} [allocate]  The process heap. Without
 *            it every allocating function answers null, which is a failure a
 *            caller is required to handle -- unlike a wrong pointer.
 * @property {(address: number) => boolean} [free]
 * @property {(address: number) => { size: number, capacity: number } | null} [block]
 * @property {(address: number, bytes: number) => boolean} [resize]
 * @property {() => number} [systemTimeMs]  Guest wall clock, milliseconds.
 * @property {() => number} [now]           Guest running time, milliseconds.
 * @property {any} [files]                  The volume, for the path functions.
 * @property {(task: () => void) => void} [atProcessEnd]
 *           Where the runtime leaves what is to run when the process ends,
 *           whichever way it ends. Absent, its files stay open at the end.
 * @property {import('./io.js').FileHandles} [handles]
 *           kernel32's handle table, as far as files go: what `_get_osfhandle`
 *           hands out and `_open_osfhandle` takes. Absent, the two stay
 *           unexported.
 * @property {() => string[]} [drives]      Letters the filesystem has mounted.
 * @property {() => number} [iob]           Where the runtime's `_iob` was placed, once it has been.
 * @property {() => Record<string, string>} [environment]
 *           The process's variables as it starts, as GetEnvironmentStrings
 *           holds them: the runtime's own copy begins as these. Absent, the
 *           runtime starts with none.
 * @property {(name: string, value: string | null) => void} [setVariable]
 *           Where `_putenv` changes the process's block, as
 *           SetEnvironmentVariable does; null removes. Absent, the change is
 *           the runtime's alone.
 * @property {(name: string) => number} [addressOf]
 *           Where the runtime's own export of that name was placed, zero
 *           before it is: a table a program reads in place, `_mbctype`, is
 *           rewritten there when the call that changes it comes. Absent, the
 *           table stays as it was placed.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *           Registers a call answers in besides EAX: EDX, for the high half
 *           of an __int64. Absent, the calls answering one stay unexported.
 * @property {import('./float.js').FloatHost} [fpu]
 * @property {import('../kernel32/versions.js').WindowsVersion} [version]
 *           The Windows GetVersion answers for the process, which the
 *           runtime's own copy of it follows. Absent, the default one.
 * @property {() => string} [commandLine]
 *           What the process was started with, as GetCommandLineA reports it.
 * @property {(code: number) => any} [exitProcess]
 * @property {(code: number) => void} [exit]
 *           Records an exit for a call that has already left the bridge and
 *           cannot park: `exit` once its handlers have run.
 *           Ends the process; answers with what the calling thread must return,
 *           since `exit` does not come back.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call answers plausibly but not the way real Windows does
 *           -- a locale we do not carry data for is the case here. Absent,
 *           the difference goes unreported rather than the call refused.
 * @property {(message: string) => void} [abort]
 * @property {import('./threads.js').ThreadSeam} [threads]
 *           Where a thread the runtime starts is made and ended: the same
 *           kernel path CreateThread and ExitThread take. Absent, the thread
 *           functions stay unexported.
 */

/**
 * Builds the function table: name -> { convention, argBytes, handler }.
 *
 * @param {MsvcrtHost} host
 */
export function createMsvcrtFunctions(host){
    /** What `rand` draws from next; where this runtime starts before any srand. */
    let randomSeed = 1;

    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** @param {number} pointer */
    const readWide = pointer=>wideStringAt(host.readMemory, pointer);

    /** Where %Z reads and %n writes. */
    const memoryAccess = guestAccess(host.readMemory, host.writeMemory);

    /**
     * Text into bytes that may be longer than it, in the ANSI page the text
     * was read in: a string a program passed is copied as its own bytes.
     *
     * @param {Uint8Array} bytes @param {string} text
     */
    const packInto = (bytes, text)=>{
        bytes.set(encodeAnsi(text));
        return bytes;
    };

    /** @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        // One byte longer than the text: a caller expects the terminator too.
        host.writeMemory(pointer, packInto(new Uint8Array(text.length + 1), text));
    };

    /**
     * What a narrow printer writes: %S and %ls read wide strings, and the
     * text is bytes under the C locale (see `formatToString`), held in the
     * ANSI page the format and its strings are read in.
     *
     * @param {number} format @param {number[]} values
     */
    const narrowText = (format, values)=>formatToString(readString(format), values, readString,
        { readWideString: readWide, cLocale: true, decodeBytes: decodeAnsi, ...memoryAccess });

    /** @param {number[]} args @param {number} fixed */
    const render = (args, fixed)=>narrowText(args[fixed - 1], args.slice(fixed));

    /**
     * The _snprintf family's answer: at most `count` characters, with the
     * terminator only when the text is shorter than that -- a text of
     * exactly `count` fills the buffer and the byte after it stays the
     * caller's -- and -1 when the text did not fit. No buffer and a count of
     * zero asks how long the text is; no buffer for a count is EINVAL.
     *
     * @param {number} buffer @param {number} count @param {string} text
     */
    const countedPrint = (buffer, count, text)=>{
        const limit = count >>> 0;
        if ((buffer >>> 0) === 0)
        {
            if (limit === 0)
            {
                return text.length;
            }
            errno(EINVAL);
            return -1;
        }
        const kept = text.slice(0, limit);
        host.writeMemory(buffer, packInto(
            new Uint8Array(kept.length + (text.length < limit ? 1 : 0)), kept));
        return text.length > limit ? -1 : text.length;
    };

    /**
     * What a wide printer writes: %s is a wide string, %S a narrow one.
     *
     * @param {number} format @param {number[]} values
     */
    const wideText = (format, values)=>formatToString(readWide(format), values, readString,
        { readWideString: readWide, wide: true, ...memoryAccess });

    /**
     * The _snwprintf family's answer: at most `count` characters, terminated
     * only when there is room, and -1 when the text does not fit. With no
     * buffer and a count of zero it answers how many the text needs (Wine's
     * msvcrt test_vsnwprintf); no format, or no buffer for a count, is -1
     * and EINVAL.
     *
     * @param {number} buffer @param {number} count @param {number} format
     * @param {number[]} values
     */
    const countedWide = (buffer, count, format, values)=>{
        const limit = count >>> 0;
        if ((format >>> 0) === 0 || ((buffer >>> 0) === 0 && limit !== 0))
        {
            errno(EINVAL);
            return -1;
        }
        const text = wideText(format, values);
        if ((buffer >>> 0) === 0)
        {
            return text.length;
        }
        const units = unitsOfText(text.slice(0, limit));
        host.writeMemory(buffer, bytesOfUnits(text.length < limit ? [...units, 0] : units));
        return text.length > limit ? -1 : text.length;
    };

    /** int swprintf(wchar_t *buffer, const wchar_t *format, ...) */
    const uncountedWide = {
        convention: 'cdecl',
        argBytes: 8 + VARIADIC_SLOTS * 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const text = wideText(args[1], args.slice(2));
            host.writeMemory(args[0], bytesOfUnits([...unitsOfText(text), 0]));
            return text.length;
        },
    };

    /** int atoi(const char *str) -- in the guest */
    const atoi = guestEntry(inGuest.atoi, COMPILED.atoi, host);

    /** char *_itoa(int value, char *buffer, int radix) */
    const itoa = {
        convention: 'cdecl',
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([value, buffer, radix])=>{
            if (radix < 2 || radix > 36)
            {
                // The secure variants reject this outright; the classic ones
                // leave it undefined. Refusing beats writing arbitrary bytes.
                return 0;
            }
            // Only base ten is signed: every other radix prints the bit pattern.
            const text = radix === 10 ? (value | 0).toString(10) : (value >>> 0).toString(radix);
            writeString(buffer, text);
            return buffer;
        },
    };

    /**
     * A `va_list` is a pointer into the caller's stack and carries no count, so
     * a fixed window is read and the format string decides how much of it is
     * meaningful. Reading past the arguments is harmless -- the extra slots are
     * never consulted -- while reading too few would silently print zeros. The
     * window stops at the end of its region for the reason `varargsSlots`
     * gives: a thread formatting from just below its stack's top is a real
     * thing a program does, and reaching past it is ours to avoid.
     *
     * @param {number} list
     */
    const varargsAt = list=>varargsSlots(
        host.readMemory, address=>host.regionAt?.(address) ?? null, list, VA_LIST_SLOTS);

    /**
     * The secure printers' shared body. A size of zero leaves nowhere to put
     * even the terminator, which is the same invalid parameter as a null
     * buffer.
     *
     * @param {number} buffer @param {number} size @param {number} format
     * @param {number[]} values
     */
    const boundedPrint = (buffer, size, format, values)=>{
        const room = size >>> 0;
        if ((buffer >>> 0) === 0 || (format >>> 0) === 0 || room === 0)
        {
            errno(EINVAL);
            return -1;
        }
        const text = narrowText(format, values);
        if (text.length + 1 > room)
        {
            host.writeMemory(buffer, new Uint8Array(1));
            errno(ERANGE);
            return -1;
        }
        writeString(buffer, text);
        return text.length;
    };

    /**
     * Where the runtime would report a fatal error. Nothing here reports one,
     * so the mode is only ever handed back to whoever set it.
     */
    let errorMode = 0;

    /**
     * `setlocale`'s answer: a pointer to "C" the caller may hold onto, built
     * once rather than on every call, since a string setlocale returns is
     * documented to stay valid until the next call that changes the locale --
     * which nothing here ever does, this runtime carrying only the one.
     */
    let currentLocale = 0;

    const table = {
        /**
         * int _set_error_mode(int mode)
         *
         * _REPORT_ERRMODE asks; the three output modes set. Anything else is
         * refused with -1, which is what the runtime answers for a mode it
         * does not have.
         */
        _set_error_mode: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([mode])=>{
                if ((mode | 0) === 3)
                {
                    return errorMode;
                }
                if ((mode | 0) < 0 || (mode | 0) > 2)
                {
                    return -1 >>> 0;
                }
                const previous = errorMode;
                errorMode = mode | 0;
                return previous;
            },
        },

        /**
         * char *setlocale(int category, const char *locale)
         *
         * Only the C locale is carried: `locale` null or "C" answers "C" and
         * takes hold; "" -- the native environment, on real Windows -- is
         * accepted the same way, since the C locale is what this runtime's
         * classifiers and formatters already are under. Anything else names a
         * locale with no data behind it here, which is reported as the
         * divergence it is and refused, the way an unset locale is on the
         * real runtime: the previous setting stands and null comes back.
         * `locale` is read before `category` is used for anything, since a
         * query (`locale` null) never touches the category at all.
         */
        setlocale: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, locale])=>{
                if (locale !== 0 && readString(locale) !== 'C' && readString(locale) !== '')
                {
                    host.divergence?.('setlocale',
                        `locale "${readString(locale)}" is not carried; only "C" is`);
                    return 0;
                }
                if (currentLocale === 0)
                {
                    currentLocale = allocate(2);
                    if (currentLocale !== 0)
                    {
                        writeString(currentLocale, 'C');
                    }
                }
                return currentLocale;
            },
        },

        /** size_t strlen(const char *str) -- in the guest */
        strlen: guestEntry(inGuest.strlen, COMPILED.strlen, host),

        /** int strcmp(const char *left, const char *right) -- in the guest */
        strcmp: guestEntry(inGuest.strcmp, COMPILED.strcmp, host),

        /** int strncmp(const char *left, const char *right, size_t count) -- in the guest */
        strncmp: guestEntry(inGuest.strncmp, COMPILED.strncmp, host),

        /** int _stricmp(const char *left, const char *right) -- in the guest */
        _stricmp: guestEntry(inGuest._stricmp, COMPILED._stricmp, host),

        /** char *strcpy(char *dest, const char *src) -- in the guest */
        strcpy: guestEntry(inGuest.strcpy, COMPILED.strcpy, host),

        /**
         * char *strncpy(char *dest, const char *src, size_t count) -- in the
         * guest: padded to the full count when the source is short, and no
         * terminator at all when it truncates
         */
        strncpy: guestEntry(inGuest.strncpy, COMPILED.strncpy, host),

        /** char *strcat(char *dest, const char *src) -- in the guest */
        strcat: guestEntry(inGuest.strcat, COMPILED.strcat, host),

        /** char *strchr(const char *str, int ch) -- in the guest */
        strchr: guestEntry(inGuest.strchr, COMPILED.strchr, host),

        /** char *strstr(const char *haystack, const char *needle) -- in the guest */
        strstr: guestEntry(inGuest.strstr, COMPILED.strstr, host),

        /** int toupper(int ch) -- in the guest */
        toupper: guestEntry(inGuest.toupper, COMPILED.toupper, host),

        /** int _strcmpi(const char *, const char *): the older name of _stricmp, in the guest */
        _strcmpi: guestEntry(inGuest._stricmp, COMPILED._stricmp, host),

        /** int tolower(int ch) -- in the guest */
        tolower: guestEntry(inGuest.tolower, COMPILED.tolower, host),

        /**
         * void *memcpy(void *dest, const void *src, size_t count) and memmove,
         * one function: in the guest
         */
        memcpy: guestEntry(inGuest.memmove, COMPILED.memmove, host),
        memmove: guestEntry(inGuest.memmove, COMPILED.memmove, host),

        /** void *memset(void *dest, int value, size_t count) -- in the guest */
        memset: guestEntry(inGuest.memset, COMPILED.memset, host),

        /** int memcmp(const void *left, const void *right, size_t count) -- in the guest */
        memcmp: guestEntry(inGuest.memcmp, COMPILED.memcmp, host),

        atoi,

        /** long atol(const char *str) -- the same function on a 32-bit target */
        atol: atoi,

        itoa,
        _itoa: itoa,

        /**
         * int _isnan(double x)
         *
         * A question about the bits of a double on the stack, answered in EAX:
         * unlike the maths functions it needs no FPU, so it is here rather than
         * with them.
         */
        _isnan: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>(Number.isNaN(readDouble(args, 0)) ? 1 : 0),
        },

        /** int _finite(double x): nonzero unless x is infinite or a NaN. */
        _finite: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>(Number.isFinite(readDouble(args, 0)) ? 1 : 0),
        },

        /**
         * void srand(unsigned int seed) and int rand(void)
         *
         * This runtime's own generator, not a better one. The sequence is part
         * of the contract: a program that seeds with a constant expects the same
         * numbers every run -- a level layout, a shuffled deck, a name picked
         * from a table -- and one that seeds from the clock still expects
         * fifteen bits, because it scales the result by RAND_MAX. Substituting
         * anything else changes what the program produces, and the arithmetic
         * below is small enough that there is no reason to.
         *
         * One sequence for the process, where this runtime keeps one per thread.
         * The difference shows only in which thread draws which number, and no
         * program can depend on that ordering in the first place.
         */
        srand: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([seed])=>{
                randomSeed = seed >>> 0;
                return 0; // void
            },
        },

        rand: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                randomSeed = (Math.imul(randomSeed, 214013) + 2531011) >>> 0;
                return (randomSeed >>> 16) & RAND_MAX;
            },
        },

        /**
         * void qsort(void *base, size_t num, size_t width, int (*cmp)(const void*, const void*))
         *
         * Code in the guest's own msvcrt (`inguest.js`): the comparator is the
         * program's, and a sort on the host ran the guest from the host once a
         * comparison -- a hundred milliseconds a frame for Warcraft III's two
         * hundred translucent objects, sorted every frame by depth.
         */
        qsort: guestExport(COMPILED.qsort),

        /**
         * int sprintf(char *buffer, const char *format, ...)
         *
         * The count returned excludes the terminator, which is written anyway.
         */
        sprintf: {
            convention: 'cdecl',
            argBytes: 8 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: args=>{
                const text = render(args, 2);
                writeString(args[0], text);
                return text.length;
            },
        },

        /**
         * int _snprintf(char *buffer, size_t count, const char *format, ...)
         *
         * Truncation is reported as a negative return and the buffer is left
         * unterminated -- the msvcrt behaviour, not C99's, and the difference
         * is why code written against this one terminates the buffer itself.
         */
        _snprintf: {
            convention: 'cdecl',
            argBytes: 12 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: args=>countedPrint(args[0], args[1], render(args, 3)),
        },

        /** int vsprintf(char *buffer, const char *format, va_list args) */
        vsprintf: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([buffer, format, list])=>{
                const text = narrowText(format, varargsAt(list));
                writeString(buffer, text);
                return text.length;
            },
        },

        /**
         * int _vsnprintf(char *buffer, size_t count, const char *format, va_list args)
         *
         * _snprintf with its arguments in memory: the same negative answer
         * and unterminated buffer when the text does not fit.
         */
        _vsnprintf: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([buffer, count, format, list])=>
                countedPrint(buffer, count, narrowText(format, varargsAt(list))),
        },

        /**
         * int _vsnwprintf(wchar_t *buffer, size_t count, const wchar_t *format,
         *                 va_list args)
         *
         * _vsnprintf in wide characters, where %s is a wide string: at most
         * `count` characters, terminated only when there is room, and -1 when
         * the text does not fit. With no buffer and a count of zero it answers
         * how many the text needs (Wine's msvcrt test_vsnwprintf); no format,
         * or no buffer for a count, is -1 and EINVAL.
         */
        _vsnwprintf: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([buffer, count, format, list])=>
                countedWide(buffer, count, format, (format >>> 0) === 0 ? [] : varargsAt(list)),
        },

        /** int _snwprintf(wchar_t *buffer, size_t count, const wchar_t *format, ...) */
        _snwprintf: {
            convention: 'cdecl',
            argBytes: 12 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: args=>countedWide(args[0], args[1], args[2], args.slice(3)),
        },

        /**
         * int swprintf(wchar_t *buffer, const wchar_t *format, ...)
         *
         * msvcrt's own, which takes no count: the text and its terminator,
         * however long, and the count of its characters. `_swprintf` is
         * the same function.
         */
        swprintf: uncountedWide,
        _swprintf: uncountedWide,

        /**
         * int sprintf_s(char *buffer, size_t size, const char *format, ...)
         *
         * sprintf with the buffer's size: text that does not fit with its
         * terminator is not written at all -- the buffer is left an empty
         * string, and the answer is -1 with ERANGE. A null buffer or format
         * is -1 and EINVAL.
         */
        sprintf_s: {
            convention: 'cdecl',
            argBytes: 12 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: args=>boundedPrint(args[0], args[1], args[2], args.slice(3)),
        },

        /** int vsprintf_s(char *buffer, size_t size, const char *format, va_list args) */
        vsprintf_s: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([buffer, size, format, list])=>
                boundedPrint(buffer, size, format, (format >>> 0) === 0 ? [] : varargsAt(list)),
        },

        /**
         * void *bsearch(const void *key, const void *base, size_t num,
         *               size_t width, int (*compare)(const void *, const void *))
         *
         * Code in the guest's own msvcrt, as qsort is: the comparator is the
         * program's, called with a `call`.
         */
        bsearch: guestExport(COMPILED.bsearch),
    };

    const allocate = host.allocate ?? (()=>0);

    // One set of the runtime's variables for the whole table: errno is set by
    // whichever function fails and read through the address `_errno` hands out.
    const globals = createGlobals({
        allocate, readMemory: host.readMemory, writeMemory: host.writeMemory,
    });

    /**
     * errno is the calling thread's own, as the runtime keeps it: the
     * scheduler may switch threads between a failing call and the line that
     * reads errno after it. Without a thread to ask, there is the one.
     *
     * @type {WeakMap<object, string>}
     */
    const errnoOf = new WeakMap();
    let threadsSeen = 0;
    const errnoName = ()=>{
        const thread = host.currentThread?.();
        if (thread === null || typeof thread !== 'object')
        {
            return 'errno';
        }
        let name = errnoOf.get(thread);
        if (name === undefined)
        {
            name = `errno:${++threadsSeen}`;
            errnoOf.set(thread, name);
        }
        return name;
    };
    /** @param {number} code */
    const errno = code=>globals.set(errnoName(), code);

    // The runtime's copy of the environment, taken from the process's as it
    // starts: what getenv reads, _putenv changes and main is handed.
    const environment = host.allocate
        ? createEnvironment({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            allocate: host.allocate,
            errno,
            ...host.environment ? { environment: host.environment } : {},
            ...host.setVariable ? { setVariable: host.setVariable } : {},
            ...host.addressOf ? { addressOf: host.addressOf } : {},
            cell: (name, initial)=>globals.address(name, initial),
        })
        : null;

    // The descriptor table the low-level calls hand out numbers from and the
    // streams stand on, so `_fileno(f)` is a number `_read` accepts.
    const descriptors = host.files
        ? createDescriptors({
            files: host.files, write: host.write, errno, fmode: ()=>globals.get('fmode'),
            handles: host.handles,
        })
        : null;

    // Every handle a process held closes when it ends, however it ends --
    // which is when a file opened to be deleted on close goes.
    if (descriptors)
    {
        host.atProcessEnd?.(()=>descriptors.closeAll());
    }

    const stdio = host.files && host.allocate && host.free
        ? createStdioFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            allocate: host.allocate,
            free: host.free,
            files: host.files,
            write: host.write,
            iob: host.iob,
            errno,
            descriptors: descriptors ?? undefined,
            varargs: varargsAt,
        })
        : null;

    /**
     * What `_cexit` closes: every stream fopen and its kin opened, and a
     * standard stream freopen moved to a file, which goes back on the console.
     */
    const closeStreams = ()=>{
        if (stdio)
        {
            stdio._fcloseall.handler([]);
            standardRecords(host.iob?.() ?? 0).forEach(record=>stdio.fclose.handler([record]));
        }
    };

    // The multibyte code page `_setmbcp` selects, which `_splitpath` reads
    // by as the `_mbs*` family does.
    const multiBytePage = createMultiBytePage();

    const narrow = {
        ...table,
        ...createStringFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            scanCString: host.scanCString,
            allocate,
            errno,
        }),
    };

    return {
        ...narrow,
        // Bound to the byte functions above, so the two families cannot drift.
        ...createMultiByteFunctions(narrow, {
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            fillMemory: host.fillMemory,
            errno,
            addressOf: host.addressOf,
            divergence: host.divergence,
            page: multiBytePage,
        }),
        ...createWideClassificationFunctions(),
        ...createWideFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            errno,
            ...host.allocate ? { allocate: host.allocate } : {},
        }),
        ...createConversionFunctions({
            readCString: host.readCString,
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            allocate,
            fpu: host.fpu,
            errno,
        }),
        ...createScanFunctions(host),
        ...createCxxFunctions(host),

        // The start-up runs before main and needs more of the machine than the
        // rest of the runtime: a heap to put argv in, the command line the
        // process was given, a way into guest code for the static constructors,
        // and a way to end the process. Without them these stay unexported, and
        // an unresolved import names the one that is missing -- which says more
        // than a start-up that half runs.
        ...(host.allocate && host.commandLine && host.exitProcess
            ? createStartupFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                allocate: host.allocate,
                commandLine: host.commandLine,
                callGuest: host.callGuest,
                currentThread: host.currentThread,
                exitProcess: host.exitProcess,
                exit: host.exit,
                globals,
                errnoName,
                closeStreams,
                version: host.version,
                ...environment ? { environment } : {},
            })
            : {}),
        ...environment?.functions,

        // The rest of the runtime needs seams the assembling caller may not
        // have wired. A missing one leaves the functions unexported, and an
        // unresolved import names what is missing -- which is a better failure
        // than a function that answers plausibly and wrongly.
        ...(host.allocate && host.free && host.block && host.resize
            ? createHeapFunctions({
                allocate: host.allocate,
                free: host.free,
                block: host.block,
                resize: host.resize,
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                fillMemory: host.fillMemory,
                errno,
            })
            : {}),
        ...(host.systemTimeMs && host.now
            ? createTimeFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                readCString: host.readCString,
                allocate,
                systemTimeMs: host.systemTimeMs,
                now: host.now,
                fpu: host.fpu,
                getenv: name=>environment?.value(name) ?? null,
                ...host.addressOf ? { addressOf: host.addressOf } : {},
                cell: (name, initial)=>globals.address(name, initial),
                errno,
                ...host.setRegisters ? { setRegisters: host.setRegisters } : {},
            })
            : {}),
        ...(host.files
            ? createPathFunctions({
                readCString: host.readCString,
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                allocate,
                drives: host.drives,
                files: host.files,
                errno,
                getenv: name=>environment?.value(name) ?? null,
                isLead: byte=>multiBytePage.isLead(byte),
            })
            : {}),
        ...(descriptors
            ? createIoFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                readCString: host.readCString,
                files: host.files,
                errno,
                divergence: host.divergence,
                setRegisters: host.setRegisters,
            }, descriptors)
            : {}),
        ...(stdio ?? {}),
        ...(host.threads ? createThreadFunctions(host.threads) : {}),
        ...(host.fpu
            ? createMathFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                fpu: host.fpu,
                errno,
                ...host.setRegisters ? { setRegisters: host.setRegisters } : {},
            })
            : {}),
    };
}

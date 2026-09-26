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

import { HANDLE_STDOUT } from '../kernel32/console.js';
import { formatToString, varargsSlots } from './format.js';
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
import { createMathFunctions } from './math.js';
import { createStartupFunctions } from './startup.js';
import { createStdioFunctions } from './stdio.js';
import { createThreadFunctions } from './threads.js';
import { createGlobals } from './globals.js';
import { createDescriptors, createIoFunctions } from './io.js';

/** How many argument slots a `va_list` is read for, since it carries no count. */
const VA_LIST_SLOTS = 64;

/**
 * A string is scanned no further than this. Nothing in C bounds `strlen`, so a
 * guest that hands us an unterminated buffer would otherwise walk its whole
 * address space before failing.
 */
const MAX_STRING = 1 << 20;

/** A scan table marking nothing: a walk only the terminator ends. */
const NO_BYTES = new Uint8Array(256);

const INT_MAX = 0x7fffffff;
const INT_MIN = -0x80000000;

/** The largest number `rand` produces, which a caller scales its range by. */
const RAND_MAX = 0x7fff;

/** Leading whitespace atoi skips, then an optional sign and decimal digits. */
const LEADING_INTEGER = /^[ \t\n\v\f\r]*([+-]?[0-9]+)/;

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
 * @property {() => string[]} [drives]      Letters the filesystem has mounted.
 * @property {() => number} [iob]           Where the runtime's `_iob` was placed, once it has been.
 * @property {import('./float.js').FloatHost} [fpu]
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
 * Only the sign of a comparison is defined by C, and msvcrt normalises it to
 * -1, 0 or 1. Guest code that compares the result against 1 rather than testing
 * its sign exists, so match what it was compiled against.
 *
 * @param {string} a @param {string} b
 */
function compare(a, b){
    if (a === b)
    {
        return 0;
    }
    return a < b ? -1 : 1;
}

/**
 * msvcrt's case folding is locale-driven; ours is the C locale, ASCII only.
 *
 * @param {string} text
 */
const foldCase = text=>text.replace(/[A-Z]/g, letter=>letter.toLowerCase());

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

    /**
     * The scratch a single-byte search marks in. Handlers answer one call at a
     * time and never await inside a scan, so one table per runtime is safe and
     * saves allocating and clearing a fresh one per strchr.
     */
    const charTable = new Uint8Array(256);

    /** @param {Uint8Array} bytes @param {string} text */
    const packInto = (bytes, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            bytes[i] = text.charCodeAt(i) & 0xff;
        }
        return bytes;
    };

    /** @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        // One byte longer than the text: a caller expects the terminator too.
        host.writeMemory(pointer, packInto(new Uint8Array(text.length + 1), text));
    };

    /**
     * A read that owns its bytes. The memory layer may hand back a view onto
     * guest memory, and writing through one while reading from it is how an
     * overlapping copy corrupts its own source.
     *
     * @param {number} address @param {number} length
     */
    const copyOf = (address, length)=>host.readMemory(address, length).slice();

    /** @param {number[]} args @param {number} fixed */
    const render = (args, fixed)=>
        formatToString(readString(args[fixed - 1]), args.slice(fixed), readString);

    /** int atoi(const char *str) */
    const atoi = {
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([string])=>{
            const match = LEADING_INTEGER.exec(readString(string));
            if (!match)
            {
                return 0;
            }
            // C leaves overflow undefined; msvcrt clamps, and a clamped value is
            // at least ordered the way the digits were.
            return Math.min(Math.max(Number(match[1]), INT_MIN), INT_MAX);
        },
    };

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

        /**
         * size_t strlen(const char *str)
         *
         * The count wants the terminator's position and nothing else, so the
         * scan finds it in the guest's own bytes; building the string to ask
         * its length copies every character first.
         */
        strlen: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>host.scanCString(string, MAX_STRING, NO_BYTES).index,
        },

        /** int strcmp(const char *left, const char *right) */
        strcmp: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([left, right])=>compare(readString(left), readString(right)),
        },

        /** int strncmp(const char *left, const char *right, size_t count) */
        strncmp: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, count])=>compare(
                readString(left).slice(0, count >>> 0),
                readString(right).slice(0, count >>> 0),
            ),
        },

        /** int _stricmp(const char *left, const char *right) */
        _stricmp: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([left, right])=>compare(
                foldCase(readString(left)),
                foldCase(readString(right)),
            ),
        },

        /** char *strcpy(char *dest, const char *src) */
        strcpy: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                writeString(destination, readString(source));
                return destination;
            },
        },

        /** char *strncpy(char *dest, const char *src, size_t count) */
        strncpy: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const length = count >>> 0;
                // The surprising half of strncpy, and the reason it is not a
                // bounded strcpy: it pads to the full count when the source is
                // short, and writes no terminator at all when it truncates.
                const text = readString(source).slice(0, length);
                host.writeMemory(destination, packInto(new Uint8Array(length), text));
                return destination;
            },
        },

        /** char *strcat(char *dest, const char *src) */
        strcat: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                writeString(destination + readString(destination).length, readString(source));
                return destination;
            },
        },

        /** char *strchr(const char *str, int ch) */
        strchr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, ch])=>{
                const wanted = ch & 0xff;
                charTable.fill(0);
                charTable[wanted] = 1;
                // The terminator ends the scan like any marked byte, and which
                // of the two stopped it decides the answer: the byte asked for
                // is a pointer into the caller's string, the terminator is a
                // miss. Searching for the terminator finds it -- it is part of
                // the string, and code uses that to find the end -- because
                // then the byte and the stop are the same one.
                const found = host.scanCString(string, MAX_STRING, charTable);
                return found.byte === wanted ? string + found.index : 0;
            },
        },

        /** char *strstr(const char *haystack, const char *needle) */
        strstr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([haystack, needle])=>{
                const index = readString(haystack).indexOf(readString(needle));
                return index === -1 ? 0 : haystack + index;
            },
        },

        /** int toupper(int ch) */
        toupper: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([ch])=>(ch >= 0x61 && ch <= 0x7a ? ch - 0x20 : ch),
        },

        /** int tolower(int ch) */
        tolower: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([ch])=>(ch >= 0x41 && ch <= 0x5a ? ch + 0x20 : ch),
        },

        /** void *memcpy(void *dest, const void *src, size_t count) */
        memcpy: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                host.writeMemory(destination, copyOf(source, count >>> 0));
                return destination;
            },
        },

        /** void *memmove(void *dest, const void *src, size_t count) */
        memmove: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                // Overlap is the whole point of this function: the source is
                // read out in full before a single byte is written back.
                host.writeMemory(destination, copyOf(source, count >>> 0));
                return destination;
            },
        },

        /** void *memset(void *dest, int value, size_t count) */
        memset: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, value, count])=>{
                host.fillMemory(destination, value & 0xff, count >>> 0);
                return destination;
            },
        },

        /** int memcmp(const void *left, const void *right, size_t count) */
        memcmp: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, count])=>{
                const length = count >>> 0;
                const a = host.readMemory(left, length);
                const b = host.readMemory(right, length);
                for (let i = 0; i < length; i++)
                {
                    if (a[i] !== b[i])
                    {
                        return a[i] < b[i] ? -1 : 1;
                    }
                }
                return 0;
            },
        },

        atoi,

        /** long atol(const char *str) -- the same function on a 32-bit target */
        atol: atoi,

        itoa,
        _itoa: itoa,

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

        /** int puts(const char *str) */
        puts: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
                // puts appends the newline that printf would have had in the
                // format string.
                host.write(HANDLE_STDOUT, `${readString(string)}\n`);
                return 0;
            },
        },

        /**
         * int printf(const char *format, ...)
         *
         * The variadic arguments sit contiguously above the format pointer on
         * the caller's stack and arrive as the tail of `args` -- everything
         * from index 1 on -- for as many slots as `argBytes` reads.
         */
        printf: {
            convention: 'cdecl',
            argBytes: 4 + VARIADIC_SLOTS * 4,
            /** @param {number[]} args */
            handler: args=>{
                const text = render(args, 1);
                host.write(HANDLE_STDOUT, text);
                return text.length;
            },
        },

        /**
         * void qsort(void *base, size_t num, size_t width, int (*cmp)(const void*, const void*))
         *
         * The first function here that runs guest code: the comparator belongs
         * to the program, and every ordering decision is its to make. So the
         * handler is asynchronous, and each comparison suspends it while the
         * guest runs -- which is exactly what the bridge's callbacks are for.
         *
         * Insertion sort, and deliberately so. The elements are swapped in guest
         * memory as they move, so the comparator always sees the array as it
         * actually is at that moment, and the addresses it is handed are the
         * real ones. Sorting a copy and writing it back would be quicker and
         * would lie to any comparator that looks at anything but its two
         * arguments. It is quadratic in comparisons, which is worth revisiting
         * when something sorts more than a screenful.
         */
        qsort: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([base, num, width, comparator])=>{
                const count = num >>> 0;
                const size = width >>> 0;
                // Whose call this is, read before the first await. Every one of
                // these calls the guest back more than once, and only the first
                // is made while this handler still holds the processor: the
                // loop turns between them and hands the machine to somebody
                // else, whose stack the rest would otherwise be built on.
                const asked = host.currentThread?.();
                for (let index = 1; index < count; index++)
                {
                    for (let at = index; at > 0; at--)
                    {
                        const left = base + (at - 1) * size;
                        const right = base + at * size;
                        if (await host.callGuest(comparator, [left, right], asked) <= 0)
                        {
                            break;
                        }
                        // Copied out, not viewed: the first write below lands in
                        // the same memory a view would still be pointing at.
                        const first = copyOf(left, size);
                        host.writeMemory(left, host.readMemory(right, size));
                        host.writeMemory(right, first);
                    }
                }
                return 0; // void: the guest reads nothing back
            },
        },

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
            handler: args=>{
                const limit = args[1] >>> 0;
                const text = render(args, 3);
                if (text.length > limit)
                {
                    host.writeMemory(args[0], packInto(new Uint8Array(limit), text));
                    return -1;
                }
                writeString(args[0], text);
                return text.length;
            },
        },

        /** int vsprintf(char *buffer, const char *format, va_list args) */
        vsprintf: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([buffer, format, list])=>{
                const text = formatToString(readString(format), varargsAt(list), readString);
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
            handler: ([buffer, count, format, list])=>{
                const limit = count >>> 0;
                const text = formatToString(readString(format), varargsAt(list), readString);
                if (text.length > limit)
                {
                    host.writeMemory(buffer, packInto(new Uint8Array(limit), text));
                    return -1;
                }
                writeString(buffer, text);
                return text.length;
            },
        },

        /** int vprintf(const char *format, va_list args) */
        vprintf: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([format, list])=>{
                const text = formatToString(readString(format), varargsAt(list), readString);
                host.write(HANDLE_STDOUT, text);
                return text.length;
            },
        },

        /**
         * void *bsearch(const void *key, const void *base, size_t num,
         *               size_t width, int (*compare)(const void *, const void *))
         *
         * The comparator is guest code, so this suspends across every step the
         * way qsort does. The key is the first argument to it, which is the
         * order a caller's comparator was written for and the reason a
         * comparator shared with qsort is often subtly wrong here.
         */
        bsearch: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: async([key, base, num, width, ordering])=>{
                const size = width >>> 0;
                // Whose call this is, read before the first await. Every one of
                // these calls the guest back more than once, and only the first
                // is made while this handler still holds the processor: the
                // loop turns between them and hands the machine to somebody
                // else, whose stack the rest would otherwise be built on.
                const asked = host.currentThread?.();
                let low = 0;
                let high = (num >>> 0) - 1;
                while (low <= high)
                {
                    const middle = (low + high) >> 1;
                    const element = base + middle * size;
                    const order = await host.callGuest(ordering, [key, element], asked);
                    if (order === 0)
                    {
                        return element;
                    }
                    if (order < 0)
                    {
                        high = middle - 1;
                    }
                    else
                    {
                        low = middle + 1;
                    }
                }
                return 0;
            },
        },
    };

    const allocate = host.allocate ?? (()=>0);

    // One set of the runtime's variables for the whole table: errno is set by
    // whichever function fails and read through the address `_errno` hands out.
    const globals = createGlobals({
        allocate, readMemory: host.readMemory, writeMemory: host.writeMemory,
    });
    /** @param {number} code */
    const errno = code=>globals.set('errno', code);

    // The descriptor table the low-level calls hand out numbers from and the
    // streams stand on, so `_fileno(f)` is a number `_read` accepts.
    const descriptors = host.files
        ? createDescriptors({
            files: host.files, write: host.write, errno, fmode: ()=>globals.get('fmode'),
        })
        : null;

    const narrow = {
        ...table,
        ...createStringFunctions({
            readMemory: host.readMemory,
            writeMemory: host.writeMemory,
            readCString: host.readCString,
            scanCString: host.scanCString,
            allocate,
        }),
    };

    return {
        ...narrow,
        // Bound to the byte functions above, so the two families cannot drift.
        ...createMultiByteFunctions(narrow),
        ...createWideClassificationFunctions(narrow),
        ...createWideFunctions(host),
        ...createConversionFunctions({
            readCString: host.readCString,
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
            })
            : {}),

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
            })
            : {}),
        ...(host.files
            ? createPathFunctions({
                readCString: host.readCString,
                writeMemory: host.writeMemory,
                allocate,
                drives: host.drives,
                files: host.files,
                errno,
            })
            : {}),
        ...(descriptors
            ? createIoFunctions({
                readMemory: host.readMemory,
                writeMemory: host.writeMemory,
                readCString: host.readCString,
                files: host.files,
                errno,
            }, descriptors)
            : {}),
        ...(host.files && host.allocate && host.free
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
            })
            : {}),
        ...(host.threads ? createThreadFunctions(host.threads) : {}),
        ...(host.fpu
            ? createMathFunctions({ writeMemory: host.writeMemory, fpu: host.fpu })
            : {}),
    };
}

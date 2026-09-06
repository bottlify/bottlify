/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
import { formatToString } from './format.js';

/**
 * A string is scanned no further than this. Nothing in C bounds `strlen`, so a
 * guest that hands us an unterminated buffer would otherwise walk its whole
 * address space before failing.
 */
const MAX_STRING = 1 << 20;

const INT_MAX = 0x7fffffff;
const INT_MIN = -0x80000000;

/** Leading whitespace atoi skips, then an optional sign and decimal digits. */
const LEADING_INTEGER = /^[ \t\n\v\f\r]*([+-]?[0-9]+)/;

/**
 * @typedef {Object} MsvcrtHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(handle: number, text: string) => void} write   Where stdout goes.
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
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

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

    return {
        /** size_t strlen(const char *str) */
        strlen: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>readString(string).length,
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
                const text = readString(string);
                const byte = ch & 0xff;
                if (byte === 0)
                {
                    // Searching for the terminator finds it: it is part of the
                    // string, and code uses this to find the end.
                    return string + text.length;
                }
                const index = text.indexOf(String.fromCharCode(byte));
                return index === -1 ? 0 : string + index;
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
                host.writeMemory(destination, new Uint8Array(count >>> 0).fill(value & 0xff));
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
         * `argBytes` counts the format pointer alone. Under cdecl the variadic
         * arguments sit contiguously above it on the caller's stack, so they
         * arrive as the tail of `args` -- everything from index 1 on.
         */
        printf: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: args=>{
                const text = render(args, 1);
                host.write(HANDLE_STDOUT, text);
                return text.length;
            },
        },

        /**
         * int sprintf(char *buffer, const char *format, ...)
         *
         * The count returned excludes the terminator, which is written anyway.
         */
        sprintf: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>{
                const text = render(args, 2);
                writeString(args[0], text);
                return text.length;
            },
        },
    };
}

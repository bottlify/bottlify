/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The rest of the C string and memory surface.
 *
 * A program calls these far more often than it calls anything in Win32, and
 * mostly in code its compiler generated, so the cost of a wrong answer is paid
 * everywhere at once rather than at one call site somebody can find.
 *
 * Two rules run through the file. A function that returns a pointer returns a
 * *guest* pointer into the caller's own buffer, computed from the address it
 * was given -- never a fresh one, because callers do arithmetic on what they
 * get back. And a function whose result outlives the call keeps its storage
 * position between calls, because that is what the C library promises.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { EINVAL } from './globals.js';
import { guestEntry } from './guest-code.js';
import * as inGuest from './inguest.js';
import { unitsAt } from './widetext.js';
import { COMPILED } from './inguest.x86.js';

/**
 * @typedef {Object} StringHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, limit: number, wanted: Uint8Array) =>
 *            { index: number, byte: number }} scanCString
 *     Walks a guest string's bytes in chunks and answers with the first one a
 *     table marks -- or the terminator -- without materialising the string.
 *     The span and search functions below answer from a position near the
 *     front of buffers that reach megabytes; reading the text to find it was
 *     the largest host cost in an install that scans while it copies.
 * @property {(bytes: number) => number} allocate  Guest memory that outlives a call.
 * @property {(code: number) => void} [errno]  Where a refused parameter says why.
 */

/** A string is scanned no further than this, since nothing in C bounds one. */
const MAX_STRING = 1 << 20;

/** What a length answers for a parameter msvcrt refuses. */
const INT_MAX = 0x7fffffff;

/** What a locale comparison answers for one: `_NLSCMPERROR`. */
const NLS_COMPARE_ERROR = 0x7fffffff;

/**
 * The bits `_isctype`/`_pctype` classify a character with, at the values
 * msvcrt's own `<ctype.h>` gives them: a mask a guest builds and passes is
 * built from these, not from our own choice of numbering.
 */
const CT_UPPER = 0x0001;
const CT_LOWER = 0x0002;
const CT_DIGIT = 0x0004;
const CT_SPACE = 0x0008;
const CT_PUNCT = 0x0010;
const CT_CONTROL = 0x0020;
const CT_BLANK = 0x0040;
const CT_HEX = 0x0080;
/**
 * Set on an alpha character alongside `_UPPER`/`_LOWER`, never alone: a
 * caller asking `_isctype(c, _ALPHA)` passes `0x0100|_UPPER|_LOWER` and
 * matches on the overlap, the same as every other mask here.
 */
const CT_ALPHA_MARK = 0x0100;
/** `_LEADBYTE`: a multibyte character's first byte in the locale's code page. */
const CT_LEADBYTE = 0x8000;


/**
 * @param {StringHost} host
 */
export function createStringFunctions(host){
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** In the ANSI page the string was read in. @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        host.writeMemory(pointer, encodeAnsi(`${text}\0`));
    };

    /**
     * strtok's saved position.
     *
     * A single stream for the whole runtime, which is what the C library
     * promises and what makes strtok unusable from two threads at once. Keeping
     * one here reproduces that rather than improving on it: a program that
     * depends on the single stream would otherwise get answers no real runtime
     * would give.
     */
    let tokenAt = 0;

    /**
     * The scan table's scratch. Handlers answer one call at a time and never
     * await inside a scan, so one table per runtime is safe and saves clearing
     * a fresh one per call.
     */
    const scanTable = new Uint8Array(256);

    /**
     * @param {(text: string) => string} transform
     * @returns {{ convention: string, argBytes: number, handler: Function }}
     */
    const inPlace = transform=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([string])=>{
            writeString(string, transform(readString(string)));
            return string;
        },
    });

    /** @type {Record<string, any>} */
    const table = {
        /** char *strrchr(const char *str, int ch) -- in the guest */
        strrchr: guestEntry(inGuest.strrchr, COMPILED.strrchr, host),

        /** char *strpbrk(const char *str, const char *accept) -- in the guest */
        strpbrk: guestEntry(inGuest.strpbrk, COMPILED.strpbrk, host),

        /** size_t strspn(const char *str, const char *accept) -- in the guest */
        strspn: guestEntry(inGuest.strspn, COMPILED.strspn, host),

        /** size_t strcspn(const char *str, const char *reject) -- in the guest */
        strcspn: guestEntry(inGuest.strcspn, COMPILED.strcspn, host),

        /** char *strncat(char *dest, const char *src, size_t count) */
        strncat: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const existing = readString(destination);
                // Unlike strncpy, this one always terminates: the count bounds
                // what is appended, not what is written.
                // The source is read no further than the count: it need not be
                // terminated within it.
                writeString(destination + existing.length, decodeAnsi(Uint8Array.from(
                    unitsAt(host.readMemory, source, 1, Math.min(count >>> 0, MAX_STRING)))));
                return destination;
            },
        },

        /** int _strnicmp(const char *l, const char *r, size_t count) -- in the guest */
        _strnicmp: guestEntry(inGuest._strnicmp, COMPILED._strnicmp, host),

        /** char *_strupr(char *str) -- in the guest */
        _strupr: guestEntry(inGuest._strupr, COMPILED._strupr, host),

        /** char *_strlwr(char *str) -- in the guest */
        _strlwr: guestEntry(inGuest._strlwr, COMPILED._strlwr, host),

        /** char *_strrev(char *str) */
        _strrev: inPlace(text=>[...text].reverse().join('')),

        /**
         * char *strtok(char *str, const char *delimiters)
         *
         * It edits the string it is given, writing a terminator over each
         * delimiter it stops at, and remembers where it left off. A caller
         * passes null on every call after the first to mean "carry on".
         */
        strtok: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, delimiters])=>{
                if ((string >>> 0) !== 0)
                {
                    tokenAt = string >>> 0;
                }
                if (tokenAt === 0)
                {
                    return 0;
                }

                const separators = new Set(readString(delimiters));
                const rest = readString(tokenAt);
                let start = 0;
                while (start < rest.length && separators.has(rest[start]))
                {
                    start++;
                }
                if (start === rest.length)
                {
                    // Nothing left but delimiters. The saved position is cleared
                    // so a further call answers null rather than rescanning.
                    tokenAt = 0;
                    return 0;
                }

                let end = start;
                while (end < rest.length && !separators.has(rest[end]))
                {
                    end++;
                }

                const token = tokenAt + start;
                if (end < rest.length)
                {
                    host.writeMemory(tokenAt + end, new Uint8Array(1));
                    tokenAt = tokenAt + end + 1;
                }
                else
                {
                    tokenAt = 0;
                }
                return token;
            },
        },

        /**
         * char *_strdup(const char *str)
         *
         * The caller frees this, so it comes from the same allocator everything
         * else does rather than from storage this file keeps. A null string
         * duplicates to null, errno untouched, as msvcrt checks for it.
         */
        _strdup: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
                if ((string >>> 0) === 0)
                {
                    return 0;
                }
                const text = readString(string);
                const address = host.allocate(text.length + 1);
                if (address === 0)
                {
                    return 0;
                }
                writeString(address, text);
                return address;
            },
        },

        /**
         * void _swab(char *source, char *destination, int count)
         *
         * Each pair of bytes swapped, `count` bytes, an odd last byte left
         * where it is -- in the destination as it was, not copied. The
         * source is read whole first, so a swap in place is one.
         */
        _swab: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, destination, count])=>{
                const length = (count | 0) & ~1;
                if (length <= 0)
                {
                    return 0;
                }
                const bytes = host.readMemory(source, length).slice();
                for (let at = 0; at < length; at += 2)
                {
                    const first = bytes[at];
                    bytes[at] = bytes[at + 1];
                    bytes[at + 1] = first;
                }
                host.writeMemory(destination, bytes);
                return 0;
            },
        },

        /**
         * int strcoll(const char *left, const char *right)
         *
         * Under the C locale the collation is the bytes' order, so this is
         * strcmp: the bytes compared as unsigned chars, answered -1, 0 or 1 as
         * msvcrt's strcmp answers. No string is _NLSCMPERROR and EINVAL.
         */
        strcoll: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([left, right])=>{
                if ((left >>> 0) === 0 || (right >>> 0) === 0)
                {
                    host.errno?.(EINVAL);
                    return NLS_COMPARE_ERROR;
                }
                /** @param {number} at */
                const bytesOf = at=>host.readMemory(at,
                    host.scanCString(at, MAX_STRING, scanTable.fill(0)).index + 1).slice();
                const a = bytesOf(left >>> 0);
                const b = bytesOf(right >>> 0);
                for (let at = 0; ; at++)
                {
                    if (a[at] !== b[at])
                    {
                        return a[at] < b[at] ? -1 >>> 0 : 1;
                    }
                    if (a[at] === 0)
                    {
                        return 0;
                    }
                }
            },
        },

        /**
         * size_t strxfrm(char *destination, const char *source, size_t count)
         *
         * Under the C locale a string is its own collation key: as much of
         * the source and its terminator as `count` holds, and the source's
         * length whatever fits. No source, or no destination for a count, is
         * INT_MAX and EINVAL.
         */
        strxfrm: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const room = count >>> 0;
                if ((source >>> 0) === 0 || ((destination >>> 0) === 0 && room !== 0))
                {
                    host.errno?.(EINVAL);
                    return INT_MAX;
                }
                const length = host.scanCString(source, MAX_STRING, scanTable.fill(0)).index;
                if (room !== 0)
                {
                    host.writeMemory(destination,
                        host.readMemory(source, Math.min(room, length + 1)).slice());
                }
                return length;
            },
        },

        /**
         * int _memicmp(const void *left, const void *right, size_t count)
         *
         * memcmp with the ASCII letters folded to lower case, the answer the
         * difference of the first two bytes that differ; no buffer for a
         * count is _NLSCMPERROR and EINVAL.
         */
        _memicmp: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, count])=>{
                const length = count >>> 0;
                if (length === 0)
                {
                    return 0;
                }
                if ((left >>> 0) === 0 || (right >>> 0) === 0)
                {
                    host.errno?.(EINVAL);
                    return NLS_COMPARE_ERROR;
                }
                const a = host.readMemory(left, length).slice();
                const b = host.readMemory(right, length);
                for (let at = 0; at < length; at++)
                {
                    const difference = inGuest.LOWER[a[at]] - inGuest.LOWER[b[at]];
                    if (difference !== 0)
                    {
                        return difference;
                    }
                }
                return 0;
            },
        },

        /** void *memchr(const void *buffer, int value, size_t count) */
        memchr: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([buffer, value, count])=>{
                const length = count >>> 0;
                const bytes = host.readMemory(buffer, length);
                const wanted = value & 0xff;
                for (let at = 0; at < length; at++)
                {
                    if (bytes[at] === wanted)
                    {
                        return buffer + at;
                    }
                }
                return 0;
            },
        },

        // The classifiers, under the C locale, in the guest (`inguest.js`):
        // 1 for a byte of the class, 0 for anything else, EOF included.
        ...Object.fromEntries(['isalpha', 'isdigit', 'isalnum', 'isspace', 'isupper', 'islower',
            'ispunct', 'isxdigit', 'isprint', 'isgraph', 'iscntrl'].map(name=>[name, guestEntry(
            /** @type {Function} */ (inGuest[/** @type {'isalpha'} */ (name)]),
            COMPILED[/** @type {'isalpha'} */ (name)], host)])),
    };

    // The table `_pctype` points at and `_isctype` reads: one mask per byte,
    // built from the same classifiers above so the two families cannot
    // disagree about a character. `_BLANK` answers for space and tab alone --
    // narrower than `isspace`, and no classifier above already answers it.
    // Slot 0 answers for EOF, exactly as `_pctype[-1]` does on real msvcrt: a
    // loop that classifies whatever `getc` handed it, EOF included, reads
    // nothing there rather than one byte before an allocation that has none.
    /** @type {Uint16Array} */
    const ctypeTable = new Uint16Array(257);
    for (let code = 0; code < 256; code++)
    {
        let mask = 0;
        if (table.isupper.handler([code]) !== 0)
            mask |= CT_UPPER;
        if (table.islower.handler([code]) !== 0)
            mask |= CT_LOWER;
        if (table.isdigit.handler([code]) !== 0)
            mask |= CT_DIGIT;
        if (table.isspace.handler([code]) !== 0)
            mask |= CT_SPACE;
        if (table.ispunct.handler([code]) !== 0)
            mask |= CT_PUNCT;
        if (table.iscntrl.handler([code]) !== 0)
            mask |= CT_CONTROL;
        if (table.isxdigit.handler([code]) !== 0)
            mask |= CT_HEX;
        if (code === 0x20 || code === 0x09)
            mask |= CT_BLANK;
        if ((mask & (CT_UPPER | CT_LOWER)) !== 0)
            mask |= CT_ALPHA_MARK;
        ctypeTable[code + 1] = mask;
    }

    /**
     * int _isctype(int c, int type)
     *
     * Nonzero when `c` (an unsigned char, or EOF) has any of the classes
     * `type` names; outside that range it has none, the same as every other
     * classifier here.
     */
    table._isctype = {
        convention: 'cdecl',
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([code, type])=>{
            const value = code | 0;
            if (value < -1 || value > 0xff)
            {
                return 0;
            }
            return (ctypeTable[value + 1] & type) !== 0 ? 1 : 0;
        },
    };

    /**
     * int isleadbyte(int c)
     *
     * `_isctype(c, _LEADBYTE)`: the table is the "C" locale's, which has no
     * lead bytes, so never.
     */
    table.isleadbyte = {
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([code])=>table._isctype.handler([code, CT_LEADBYTE]),
    };

    /**
     * const unsigned short *_pctype
     *
     * A variable, not a function: the runtime's classification table, indexed
     * by an unsigned char (and by EOF, at index -1). Published once, in guest
     * memory the process heap owns, since nothing here has a static data
     * segment of its own to hold it; the exported address is the table's
     * second element, so `_pctype[-1]` reads the EOF slot before it.
     */
    /**
     * const unsigned short _ctype[257]
     *
     * The same table as a variable of its own: msvcrt exports the array
     * itself, EOF's slot first, and `_pctype` points one element into it.
     * Placed in the runtime's own data, where a program that imported it by
     * address reads it.
     */
    table._ctype = {
        data: ()=>new Uint8Array(ctypeTable.buffer.slice(ctypeTable.byteOffset,
            ctypeTable.byteOffset + ctypeTable.byteLength)),
    };

    table._pctype = {
        data: ()=>{
            const address = host.allocate(ctypeTable.byteLength);
            if (address === 0)
            {
                return new Uint8Array(4);
            }
            const bytes = new Uint8Array(ctypeTable.buffer, ctypeTable.byteOffset,
                ctypeTable.byteLength);
            host.writeMemory(address, bytes);
            const pointer = new Uint8Array(4);
            new DataView(pointer.buffer).setUint32(0, address + 2, true);
            return pointer;
        },
    };

    return table;
}

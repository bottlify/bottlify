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
 */

/** A string is scanned no further than this, since nothing in C bounds one. */
const MAX_STRING = 1 << 20;

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

/** Only the sign is defined by C; this runtime normalises it to -1, 0 or 1. */
const compare = (/** @type {string} */ a, /** @type {string} */ b)=>{
    if (a === b)
    {
        return 0;
    }
    return a < b ? -1 : 1;
};

/** msvcrt's case folding under the C locale is ASCII and nothing else. */
const foldCase = (/** @type {string} */ text)=>
    text.replace(/[A-Z]/g, letter=>letter.toLowerCase());

/**
 * Marks the bytes of a set string in a scan table, every other byte taking the
 * opposite mark: one helper builds both the strspn table (stop at a byte the
 * set does not cover) and the strcspn/strpbrk one (stop at a byte it does).
 * Membership is by byte value rather than by one-character string, because a
 * scan asks once per byte of strings that reach megabytes.
 *
 * @param {string} text    The set string, as the caller passed it: read in the
 *     ANSI page, so its bytes are that page's and not its characters' codes.
 * @param {Uint8Array} table  Scratch, 256 entries; answered with, marked.
 * @param {number} mark   What the set's own bytes get.
 */
function markBytes(text, table, mark){
    table.fill(mark === 0 ? 1 : 0);
    for (const byte of encodeAnsi(text))
    {
        table[byte] = mark;
    }
    return table;
}

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
        /** char *strrchr(const char *str, int ch) */
        strrchr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, ch])=>{
                const text = readString(string);
                const byte = ch & 0xff;
                if (byte === 0)
                {
                    return string + text.length;
                }
                const index = text.lastIndexOf(decodeAnsi(Uint8Array.of(byte)));
                return index === -1 ? 0 : string + index;
            },
        },

        /** char *strpbrk(const char *str, const char *accept) */
        strpbrk: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, accept])=>{
                const wanted = markBytes(readString(accept), scanTable, 1);
                // The terminator is a stop like any marked byte, and which of
                // the two ended the scan is the answer: a marked byte is a
                // pointer into the caller's string, the terminator is a miss.
                const found = host.scanCString(string, MAX_STRING, wanted);
                return found.byte === 0 ? 0 : string + found.index;
            },
        },

        /** size_t strspn(const char *str, const char *accept) */
        strspn: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, accept])=>{
                // The span ends at the first byte the set does not cover, so
                // the set's complement is what the scan stops at; a terminator
                // is never covered and ends the span as it always did.
                const wanted = markBytes(readString(accept), scanTable, 0);
                return host.scanCString(string, MAX_STRING, wanted).index;
            },
        },

        /** size_t strcspn(const char *str, const char *reject) */
        strcspn: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, reject])=>{
                const wanted = markBytes(readString(reject), scanTable, 1);
                return host.scanCString(string, MAX_STRING, wanted).index;
            },
        },

        /** char *strncat(char *dest, const char *src, size_t count) */
        strncat: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const existing = readString(destination);
                // Unlike strncpy, this one always terminates: the count bounds
                // what is appended, not what is written.
                writeString(destination + existing.length,
                    readString(source).slice(0, count >>> 0));
                return destination;
            },
        },

        /** int _strnicmp(const char *l, const char *r, size_t count) */
        _strnicmp: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, count])=>compare(
                foldCase(readString(left).slice(0, count >>> 0)),
                foldCase(readString(right).slice(0, count >>> 0)),
            ),
        },

        /** char *_strupr(char *str) */
        _strupr: inPlace(text=>text.replace(/[a-z]/g, c=>c.toUpperCase())),

        /** char *_strlwr(char *str) */
        _strlwr: inPlace(foldCase),

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
         * else does rather than from storage this file keeps.
         */
        _strdup: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
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

        /** int isalpha/isdigit/... — the classifiers, under the C locale */
        isalpha: classify(/[A-Za-z]/),
        isdigit: classify(/[0-9]/),
        isalnum: classify(/[0-9A-Za-z]/),
        isspace: classify(/[ \t\n\v\f\r]/),
        isupper: classify(/[A-Z]/),
        islower: classify(/[a-z]/),
        ispunct: classify(/[!-/:-@[-`{-~]/),
        isxdigit: classify(/[0-9A-Fa-f]/),
        isprint: classify(/[ -~]/),
        // Expressed as a range rather than a pattern: a control character in a
        // regular expression is the kind of thing that survives a copy-paste
        // and then does not.
        iscntrl: range(code=>code < 0x20 || code === 0x7f),
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
     * const unsigned short *_pctype
     *
     * A variable, not a function: the runtime's classification table, indexed
     * by an unsigned char (and by EOF, at index -1). Published once, in guest
     * memory the process heap owns, since nothing here has a static data
     * segment of its own to hold it; the exported address is the table's
     * second element, so `_pctype[-1]` reads the EOF slot before it.
     */
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

/**
 * One character classifier.
 *
 * C says the argument must be representable as unsigned char or EOF, and every
 * one of these is called with a value that came from getc or an array index.
 * Anything outside that range classifies as nothing, which is what a table
 * lookup with a bounded table does.
 *
 * @param {(code: number) => boolean} holds
 */
function range(holds){
    return {
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([code])=>{
            const value = code | 0;
            if (value < 0 || value > 0xff)
            {
                return 0;
            }
            return holds(value) ? 1 : 0;
        },
    };
}

/** The same, written as a pattern where one reads more clearly than a range. */
const classify = (/** @type {RegExp} */ pattern)=>
    range(code=>pattern.test(String.fromCharCode(code)));

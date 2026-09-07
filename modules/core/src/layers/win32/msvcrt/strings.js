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

/**
 * @typedef {Object} StringHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate  Guest memory that outlives a call.
 */

/** A string is scanned no further than this, since nothing in C bounds one. */
const MAX_STRING = 1 << 20;

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
 * @param {StringHost} host
 */
export function createStringFunctions(host){
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(pointer, bytes);
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

    return {
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
                const index = text.lastIndexOf(String.fromCharCode(byte));
                return index === -1 ? 0 : string + index;
            },
        },

        /** char *strpbrk(const char *str, const char *accept) */
        strpbrk: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, accept])=>{
                const text = readString(string);
                const wanted = new Set(readString(accept));
                for (let at = 0; at < text.length; at++)
                {
                    if (wanted.has(text[at]))
                    {
                        return string + at;
                    }
                }
                return 0;
            },
        },

        /** size_t strspn(const char *str, const char *accept) */
        strspn: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, accept])=>{
                const text = readString(string);
                const wanted = new Set(readString(accept));
                let at = 0;
                while (at < text.length && wanted.has(text[at]))
                {
                    at++;
                }
                return at;
            },
        },

        /** size_t strcspn(const char *str, const char *reject) */
        strcspn: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, reject])=>{
                const text = readString(string);
                const unwanted = new Set(readString(reject));
                let at = 0;
                while (at < text.length && !unwanted.has(text[at]))
                {
                    at++;
                }
                return at;
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

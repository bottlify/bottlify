/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Characters that are not one byte wide.
 *
 * Two families live here for one reason: both exist because `char` is not the
 * unit a program means. The wide family is UTF-16, two bytes per unit, and is
 * what Win32 itself speaks. The multi-byte family is the other answer to the
 * same problem -- a variable-width encoding chosen by the locale -- and under
 * the C locale, which is the only locale this runtime has, every character is
 * one byte and every `_mbs*` function is its `str*` equivalent exactly.
 *
 * So the `_mbs*` entries are deliberately thin. They are not stubs: under this
 * locale they are complete and correct, and a lead-byte test that answers "no"
 * is the true answer rather than an unimplemented one. What they are not is
 * ready for a double-byte locale, and the place that would change is here.
 */

const MAX_STRING = 1 << 20;

/** Sixty-four thousand UTF-16 units is as far as a wide string is scanned. */
const MAX_WIDE = 1 << 16;

/**
 * @typedef {Object} WideHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 */

/**
 * @param {WideHost} host
 */
export function createWideFunctions(host){
    /** @param {number} pointer */
    const readNarrow = pointer=>host.readCString(pointer, MAX_STRING);

    /** @param {number} pointer @param {number} [limit] */
    const readWide = (pointer, limit = MAX_WIDE)=>{
        const bytes = host.readMemory(pointer, limit * 2);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let text = '';
        for (let at = 0; at * 2 + 1 < bytes.length && at < limit; at++)
        {
            const unit = view.getUint16(at * 2, true);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /** @param {number} pointer @param {string} text @param {boolean} terminate */
    const writeWide = (pointer, text, terminate = true)=>{
        const bytes = new Uint8Array((text.length + (terminate ? 1 : 0)) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        host.writeMemory(pointer, bytes);
    };

    /** @param {number} pointer @param {string} text */
    const writeNarrow = (pointer, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(pointer, bytes);
    };

    /** @param {string} a @param {string} b */
    const compare = (a, b)=>(a === b ? 0 : (a < b ? -1 : 1));

    /** @param {string} text */
    const foldCase = text=>text.replace(/[A-Z]/g, letter=>letter.toLowerCase());

    return {
        /** size_t wcslen(const wchar_t *) */
        wcslen: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>readWide(string).length,
        },

        /** wchar_t *wcscpy(wchar_t *dest, const wchar_t *src) */
        wcscpy: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                writeWide(destination, readWide(source));
                return destination;
            },
        },

        /** wchar_t *wcsncpy(wchar_t *dest, const wchar_t *src, size_t count) */
        wcsncpy: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const length = count >>> 0;
                const text = readWide(source).slice(0, length);
                // Padded to the full count and unterminated when it truncates,
                // exactly as the narrow strncpy does.
                writeWide(destination, text.padEnd(length, '\0'), false);
                return destination;
            },
        },

        /** wchar_t *wcscat(wchar_t *dest, const wchar_t *src) */
        wcscat: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                const existing = readWide(destination);
                writeWide(destination + existing.length * 2, readWide(source));
                return destination;
            },
        },

        /** int wcscmp(const wchar_t *, const wchar_t *) */
        wcscmp: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([left, right])=>compare(readWide(left), readWide(right)),
        },

        /** int wcsncmp(const wchar_t *, const wchar_t *, size_t) */
        wcsncmp: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, count])=>compare(
                readWide(left).slice(0, count >>> 0),
                readWide(right).slice(0, count >>> 0)),
        },

        /** int _wcsicmp(const wchar_t *, const wchar_t *) */
        _wcsicmp: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([left, right])=>compare(
                foldCase(readWide(left)), foldCase(readWide(right))),
        },

        /** wchar_t *wcschr(const wchar_t *, wchar_t) */
        wcschr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, unit])=>{
                const text = readWide(string);
                const wanted = unit & 0xffff;
                if (wanted === 0)
                {
                    return string + text.length * 2;
                }
                const index = text.indexOf(String.fromCharCode(wanted));
                return index === -1 ? 0 : string + index * 2;
            },
        },

        /** wchar_t *wcsrchr(const wchar_t *, wchar_t) */
        wcsrchr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, unit])=>{
                const text = readWide(string);
                const index = text.lastIndexOf(String.fromCharCode(unit & 0xffff));
                return index === -1 ? 0 : string + index * 2;
            },
        },

        /** wchar_t *wcsstr(const wchar_t *, const wchar_t *) */
        wcsstr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([haystack, needle])=>{
                const index = readWide(haystack).indexOf(readWide(needle));
                return index === -1 ? 0 : haystack + index * 2;
            },
        },

        /**
         * size_t mbstowcs(wchar_t *dest, const char *src, size_t count)
         *
         * A null destination means "how many units would this need", which is
         * how a caller sizes the buffer before the call that fills it.
         */
        mbstowcs: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const text = readNarrow(source);
                if ((destination >>> 0) === 0)
                {
                    return text.length;
                }
                const written = text.slice(0, count >>> 0);
                // The terminator is written only when it fits within the count,
                // which is the trap in this function: a full buffer comes back
                // unterminated and the caller must terminate it itself.
                writeWide(destination, written, written.length < (count >>> 0));
                return written.length;
            },
        },

        /** size_t wcstombs(char *dest, const wchar_t *src, size_t count) */
        wcstombs: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const text = readWide(source);
                if ((destination >>> 0) === 0)
                {
                    return text.length;
                }
                const written = text.slice(0, count >>> 0);
                writeNarrow(destination, written);
                return written.length;
            },
        },

        /** int wctomb(char *dest, wchar_t unit) */
        wctomb: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, unit])=>{
                if ((destination >>> 0) === 0)
                {
                    // Asking whether the encoding is stateful. It is not.
                    return 0;
                }
                host.writeMemory(destination, new Uint8Array([unit & 0xff]));
                return 1;
            },
        },

        /** int mbtowc(wchar_t *dest, const char *src, size_t count) */
        mbtowc: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                if ((source >>> 0) === 0 || (count >>> 0) === 0)
                {
                    return 0;
                }
                const byte = host.readMemory(source, 1)[0];
                if ((destination >>> 0) !== 0)
                {
                    writeWide(destination, String.fromCharCode(byte), false);
                }
                return byte === 0 ? 0 : 1;
            },
        },
    };
}

/**
 * The multi-byte family, which under the C locale is the byte family.
 *
 * Each name is bound to the narrow function of the same meaning, taken from
 * the table the caller already built rather than written again: two
 * implementations of `strcpy` that must agree is one more than is needed.
 *
 * @param {Record<string, any>} narrow  The byte-string table.
 */
export function createMultiByteFunctions(narrow){
    /** @type {Record<string, any>} */
    const table = {};
    for (const [multiByte, byte] of Object.entries({
        _mbslen: 'strlen',
        _mbscpy: 'strcpy',
        _mbsncpy: 'strncpy',
        _mbscat: 'strcat',
        _mbsncat: 'strncat',
        _mbscmp: 'strcmp',
        _mbsncmp: 'strncmp',
        _mbsicmp: '_stricmp',
        _mbsnicmp: '_strnicmp',
        _mbschr: 'strchr',
        _mbsrchr: 'strrchr',
        _mbsstr: 'strstr',
        _mbstok: 'strtok',
        _mbsdup: '_strdup',
        _mbsupr: '_strupr',
        _mbslwr: '_strlwr',
    }))
    {
        if (narrow[byte])
        {
            table[multiByte] = narrow[byte];
        }
    }

    return {
        ...table,

        /**
         * unsigned char *_mbsinc(const unsigned char *)
         *
         * Advances by one character, which is one byte here. A program uses
         * this instead of `++` precisely so that it would still be right in a
         * locale where it is not one byte.
         */
        _mbsinc: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>string + 1,
        },

        /**
         * unsigned char *_mbsdec(const unsigned char *start, const unsigned char *at)
         *
         * Backwards, and it needs the start of the string because a
         * variable-width encoding cannot be read backwards without it.
         */
        _mbsdec: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([start, at])=>(at > start ? at - 1 : 0),
        },

        /** size_t _mbclen(const unsigned char *) */
        _mbclen: {
            convention: 'cdecl',
            argBytes: 4,
            handler: ()=>1,
        },

        /** int _ismbblead(unsigned int) -- never, in a single-byte locale */
        _ismbblead: {
            convention: 'cdecl',
            argBytes: 4,
            handler: ()=>0,
        },

        /** int _ismbbtrail(unsigned int) */
        _ismbbtrail: {
            convention: 'cdecl',
            argBytes: 4,
            handler: ()=>0,
        },
    };
}

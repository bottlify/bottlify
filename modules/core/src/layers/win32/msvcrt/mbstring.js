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

import { EILSEQ } from './globals.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { wideStringAt } from './widetext.js';

const MAX_STRING = 1 << 20;

/**
 * @typedef {Object} WideHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} [errno]  Where a failure says why.
 */

/** WEOF: the value no code unit is, and the one every classifier answers nothing for. */
const WEOF = 0xffff;

/** The classes of the wide table below. They mark membership, and nothing else. */
const W_ALPHA = 0x001;
const W_DIGIT = 0x002;
const W_UPPER = 0x004;
const W_LOWER = 0x008;
const W_SPACE = 0x010;
const W_PUNCT = 0x020;
const W_CNTRL = 0x040;
const W_PRINT = 0x080;
const W_GRAPH = 0x100;
const W_XDIGIT = 0x200;

/**
 * The bits `iswctype`'s mask is built from, at the values msvcrt's own
 * `<wctype.h>` gives them -- the same numbering `_isctype` uses, since a
 * guest builds both from the same header.
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
 * caller asking `iswctype(c, _ALPHA)` passes `0x0100|_UPPER|_LOWER` and
 * matches on the overlap, the same as every other mask here.
 */
const CT_ALPHA_MARK = 0x0100;

/**
 * Which byte classifier answers which class: the wide table is read from the
 * narrow answers, not from a second copy of them.
 *
 * @type {Record<string, number>}
 */
const CLASSES = {
    isalpha: W_ALPHA, isdigit: W_DIGIT, isupper: W_UPPER, islower: W_LOWER,
    isspace: W_SPACE, ispunct: W_PUNCT, iscntrl: W_CNTRL, isprint: W_PRINT,
    isxdigit: W_XDIGIT,
};

/**
 * @param {WideHost} host
 */
export function createWideFunctions(host){
    /**
     * A narrow string as the C locale widens it, each byte to the unit of its
     * own value as mbtowc widens one: the memory layer reads the string in the
     * ANSI page, whose characters above 0x7f are not those units.
     *
     * @param {number} pointer
     */
    const readNarrowUnits = pointer=>Array.from(encodeAnsi(host.readCString(pointer, MAX_STRING)),
        byte=>String.fromCharCode(byte)).join('');

    // Up to the terminator a stretch at a time: a string near the top of its
    // region (a path in a stack buffer) cannot be read as one wide window.
    /** @param {number} pointer */
    const readWide = pointer=>wideStringAt(host.readMemory, pointer);

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

    /** @param {number} pointer @param {string} text @param {boolean} terminate */
    const writeNarrow = (pointer, text, terminate)=>{
        const bytes = new Uint8Array(text.length + (terminate ? 1 : 0));
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
                const text = readNarrowUnits(source);
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

        /**
         * size_t wcstombs(char *dest, const wchar_t *src, size_t count)
         *
         * A byte for each character it converts -- all of them with no
         * destination, which asks how many bytes that is -- and -1 with
         * EILSEQ, nothing written, when one of those has no byte in the C
         * locale, as wctomb refuses it.
         */
        wcstombs: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const text = readWide(source);
                const converted = (destination >>> 0) === 0 ? text : text.slice(0, count >>> 0);
                if (/[^\0-\xff]/.test(converted))
                {
                    host.errno?.(EILSEQ);
                    return -1;
                }
                if ((destination >>> 0) === 0)
                {
                    return text.length;
                }
                // Terminated, as mbstowcs is, only when the text ends within
                // the count: a buffer the text fills is left unterminated.
                writeNarrow(destination, converted, converted.length < (count >>> 0));
                return converted.length;
            },
        },

        /**
         * int wctomb(char *dest, wchar_t unit)
         *
         * One byte for a character to U+00FF; the C locale has none for a
         * character past it, which is -1 and EILSEQ with nothing written.
         */
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
                if ((unit & 0xffff) > 0xff)
                {
                    host.errno?.(EILSEQ);
                    return -1;
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
 * The wide classifiers, bound to the byte ones so the two cannot drift: a
 * program may ask either family about the same character and is entitled to
 * the same answer for every code unit below 0x80. Above it the C locale is not
 * empty, which is what a real Windows answers through iswctype: the Latin-1
 * letters are alpha -- both signs except the multiplication and division signs
 * that sit among them and are not letters -- and there are two spaces the
 * ASCII list does not carry, NEL at 0x85 and the no-break space at 0xa0. Case
 * folding stays ASCII with the rest of the locale, so those letters are alpha
 * with no upper or lower answer of their own, and every code unit above 0xff
 * that is neither of those things -- a CJK unit, WEOF -- is nothing at all.
 *
 * @param {Record<string, any>} narrow  The byte table, classifiers included.
 */
export function createWideClassificationFunctions(narrow){
    const table = new Uint16Array(0x100);
    for (let code = 0; code < table.length; code++)
    {
        let classes = 0;
        for (const [name, klass] of Object.entries(CLASSES))
        {
            if (narrow[name].handler([code]) !== 0)
            {
                classes |= klass;
            }
        }
        if ((classes & W_PRINT) !== 0 && (classes & W_SPACE) === 0)
        {
            classes |= W_GRAPH;
        }
        if (code >= 0xc0 && code <= 0xff && code !== 0xd7 && code !== 0xf7)
        {
            classes |= W_ALPHA;
        }
        if (code === 0x85 || code === 0xa0)
        {
            classes |= W_SPACE;
        }
        table[code] = classes;
    }

    /**
     * @param {number} klass  The classes that answer this one.
     */
    const classifyWide = klass=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([code])=>{
            const unit = code & 0xffff;
            return unit < table.length && (table[unit] & klass) !== 0 ? 1 : 0;
        },
    });

    /** @param {(unit: number) => number} fold */
    const toCase = fold=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([code])=>{
            const unit = code & 0xffff;
            return unit === WEOF ? 0 : fold(unit);
        },
    });

    return {
        /** int iswalpha/isdigit/... (wint_t) — the classifiers, under the C locale */
        iswalpha: classifyWide(W_ALPHA),
        iswdigit: classifyWide(W_DIGIT),
        iswalnum: classifyWide(W_ALPHA | W_DIGIT),
        iswspace: classifyWide(W_SPACE),
        iswupper: classifyWide(W_UPPER),
        iswlower: classifyWide(W_LOWER),
        iswpunct: classifyWide(W_PUNCT),
        iswxdigit: classifyWide(W_XDIGIT),
        iswcntrl: classifyWide(W_CNTRL),
        iswprint: classifyWide(W_PRINT),
        iswgraph: classifyWide(W_GRAPH),

        /** int iswascii(wint_t) -- the range, not a class the table carries */
        iswascii: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>((code & 0xffff) < 0x80 ? 1 : 0),
        },

        /**
         * int iswctype(wint_t c, wctype_t type)
         *
         * `_isctype` for a wide code unit: nonzero when `c` has any of the
         * classes `type` names. Built from the same table the classifiers
         * above are, translated to the bits a guest actually passes, since
         * this table's own numbering exists only for the classifiers to share
         * and was never meant to leave this function.
         */
        iswctype: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([code, type])=>{
                const unit = code & 0xffff;
                if (unit === WEOF || unit >= table.length)
                {
                    return 0;
                }
                const classes = table[unit];
                let real = 0;
                if (classes & W_UPPER)
                    real |= CT_UPPER;
                if (classes & W_LOWER)
                    real |= CT_LOWER;
                if (classes & W_DIGIT)
                    real |= CT_DIGIT;
                if (classes & W_SPACE)
                    real |= CT_SPACE;
                if (classes & W_PUNCT)
                    real |= CT_PUNCT;
                if (classes & W_CNTRL)
                    real |= CT_CONTROL;
                if (classes & W_XDIGIT)
                    real |= CT_HEX;
                if (unit === 0x20 || unit === 0x09)
                    real |= CT_BLANK;
                // The Latin-1 extension's letters are alpha with no case of
                // their own, so the marker follows the table's own alpha bit
                // rather than being derived from `_UPPER`/`_LOWER` here.
                if (classes & W_ALPHA)
                    real |= CT_ALPHA_MARK;
                return (real & type) !== 0 ? 1 : 0;
            },
        },

        /** wint_t towupper(wint_t) */
        towupper: toCase(unit=>unit >= 0x61 && unit <= 0x7a ? unit - 0x20 : unit),

        /** wint_t towlower(wint_t) */
        towlower: toCase(unit=>unit >= 0x41 && unit <= 0x5a ? unit + 0x20 : unit),
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
 * @param {(api: string, detail: string) => void} [divergence]
 */
export function createMultiByteFunctions(narrow, divergence){
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
        _mbspbrk: 'strpbrk',
        _mbsspn: 'strspn',
        _mbscspn: 'strcspn',
        _mbsrev: '_strrev',
        // The `nb` forms count bytes rather than characters, which in a
        // single-byte locale is the same count.
        _mbsnbcmp: 'strncmp',
        _mbsnbicmp: '_strnicmp',
        _mbsnbcpy: 'strncpy',
        _mbsnbcat: 'strncat',
        // A classifier, not a string function, but the same shape: one
        // character code in, one flag out, and the C locale's answer is the
        // byte one's exactly, the same as every multi-byte function above.
        _ismbcspace: 'isspace',
        _ismbcdigit: 'isdigit',
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

        /**
         * int _setmbcp(int codepage)
         *
         * The multi-byte code page stays the single-byte ANSI one, whatever is
         * asked: every function in this family answers as that page does, and
         * a lead-byte table set for another page would disagree with them.
         * Asked for the ANSI page, or for "the current locale's", that is
         * exactly right; asked for a double-byte page, it is not, and says so.
         */
        _setmbcp: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([codepage])=>{
                const asked = codepage | 0;
                if (![0, -3, -4, -2, 1252].includes(asked))
                {
                    divergence?.('_setmbcp', `code page ${asked} stays the ANSI page`);
                }
                return 0;
            },
        },

        /** int _getmbcp(void): 0, a single-byte locale's answer. */
        _getmbcp: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>0,
        },

        /**
         * unsigned char _mbctype[257]
         *
         * The lead- and trail-byte flags for each byte, the first entry for
         * EOF: none, in a single-byte locale.
         */
        _mbctype: { data: ()=>new Uint8Array(257) },
    };
}

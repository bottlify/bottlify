/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C runtime functions ntdll exports where its own answer is not msvcrt's.
 *
 * ntdll carries a small runtime of its own for the kernel's callers, and in a
 * few places it answers otherwise than the C runtime a program links: the
 * number-to-text family takes any base from 2 up, writing a digit past 'z' as
 * the character after it; towlower knows the Latin-1 letters alone and
 * towupper is RtlUpcaseUnicodeChar; _wcslwr, _wcsupr, _wcsicmp and _wcsnicmp
 * know ASCII letters only; the character classes answer the class bits
 * themselves, from the Latin-1 table below for the wide ones and its ASCII
 * half for the narrow; toupper is the ANSI page's own upper case of the low
 * byte. The wide integer readings skip the Latin-1 blanks alone (U+00A0 is
 * one, U+2002 and U+3000 are not), sscanf reads no floating-point field, and
 * qsort orders equal elements as msvcrt.dll's own sort does: each is msvcrt's
 * reading given ntdll's rule (`WIDE_READINGS`, `KERNEL_SCAN`, `WINDOWS_SORT`).
 * Everything else ntdll exports of the runtime is msvcrt's own entry
 * (`functions.js`).
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { upcaseUnit } from '../../../system/text.js';
import { WIDE_READINGS } from '../msvcrt/convert.js';
import { KERNEL_SCAN } from '../msvcrt/scan.js';
import { WINDOWS_SORT } from '../msvcrt/sort.js';
import { wholeAddress } from '../common/pointers.js';

/**
 * The CT_CTYPE1 classes ntdll's wide classifiers answer for the first 256
 * characters, as Windows answers them (Wine's ntdll:string records them); past
 * them, none. The narrow ones read its first 128, where a tab is no blank.
 */
const LATIN1_TYPES = Uint16Array.of(
    0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020,
    0x020, 0x068, 0x028, 0x028, 0x028, 0x028, 0x020, 0x020,
    0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020,
    0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020,
    0x048, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010,
    0x010, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010,
    0x084, 0x084, 0x084, 0x084, 0x084, 0x084, 0x084, 0x084,
    0x084, 0x084, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010,
    0x010, 0x181, 0x181, 0x181, 0x181, 0x181, 0x181, 0x101,
    0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101,
    0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101,
    0x101, 0x101, 0x101, 0x010, 0x010, 0x010, 0x010, 0x010,
    0x010, 0x182, 0x182, 0x182, 0x182, 0x182, 0x182, 0x102,
    0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102,
    0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102,
    0x102, 0x102, 0x102, 0x010, 0x010, 0x010, 0x010, 0x020,
    0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020,
    0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020,
    0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020,
    0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020, 0x020,
    0x048, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010,
    0x010, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010,
    0x010, 0x010, 0x014, 0x014, 0x010, 0x010, 0x010, 0x010,
    0x010, 0x014, 0x010, 0x010, 0x010, 0x010, 0x010, 0x010,
    0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101,
    0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101,
    0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x010,
    0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x101, 0x102,
    0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102,
    0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102,
    0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x010,
    0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102, 0x102
);

const C1_UPPER = 0x001;
const C1_LOWER = 0x002;
const C1_DIGIT = 0x004;
const C1_SPACE = 0x008;
const C1_PUNCT = 0x010;
const C1_CNTRL = 0x020;
const C1_BLANK = 0x040;
const C1_XDIGIT = 0x080;
const C1_ALPHA = 0x100;
const TAB = 0x09;

/** @param {number} value  a character as the narrow classifiers take it */
const narrowType = value=>(value >= 0 && value < 0x80
    ? LATIN1_TYPES[value] & ~(value === TAB ? C1_BLANK : 0) : 0);
/** @param {number} value  a character as the wide classifiers take it */
const wideType = value=>(value >= 0 && value < 0x100 ? LATIN1_TYPES[value] : 0);

/** @param {number} unit */
const asciiLower = unit=>(unit >= 0x41 && unit <= 0x5a ? unit + 32 : unit);

/**
 * The white space ntdll's wide readings skip: the Latin-1 characters its
 * classifiers call space.
 *
 * @param {string | undefined} character
 */
const isLatin1Space = character=>character !== undefined
    && (wideType(character.charCodeAt(0)) & C1_SPACE) !== 0;

/**
 * @typedef {Object} CrtHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {Record<string | symbol, any>} [crt]  msvcrt.dll's table, whose
 *     readings these give ntdll's rules.
 */

/**
 * The text of a value in a base, as ntdll writes it: the digits '0'-'9', then
 * from 'a' on for as far as the base goes.
 *
 * @param {bigint} value  not negative
 * @param {number} base   2 or more
 */
const digitsOf = (value, base)=>{
    const radix = BigInt(base);
    let text = '';
    let rest = value;
    for (;;)
    {
        const digit = Number(rest % radix);
        text = String.fromCharCode(digit < 10 ? 48 + digit : 87 + digit) + text;
        rest /= radix;
        if (rest === 0n)
        {
            break;
        }
    }
    return text;
};

/**
 * ntdll's own runtime entries.
 *
 * @param {CrtHost} host
 */
export function createNtdllCrt(host){
    const { guest } = host;

    /**
     * One of the number-to-text entries: `slots` the value's words, `signed`
     * whether base ten writes a minus, `wide` whether the text is WCHARs.
     * A base below 2 writes nothing and answers NULL.
     *
     * @param {number} slots @param {boolean} signed @param {boolean} wide
     */
    const toText = (slots, signed, wide)=>({
        convention: 'cdecl',
        argBytes: (slots + 2) * 4,
        ...slots === 2 ? { quadwords: [0] } : {},
        /** @param {number[]} args */
        handler: args=>{
            const buffer = args[slots] >>> 0;
            const base = args[slots + 1] | 0;
            if (base < 2)
            {
                return 0;
            }
            const bits = BigInt(slots * 32);
            let pattern = 0n;
            for (let slot = slots - 1; slot >= 0; slot--)
            {
                pattern = (pattern << 32n) | BigInt(args[slot] >>> 0);
            }
            const negative = signed && base === 10 && BigInt.asIntN(Number(bits), pattern) < 0n;
            guest.setText(buffer, negative
                ? `-${digitsOf(-BigInt.asIntN(Number(bits), pattern), base)}`
                : digitsOf(pattern, base), wide);
            return buffer;
        },
    });

    /**
     * _wcslwr or _wcsupr: the ASCII letters of a NUL-terminated wide string
     * changed in place, everything else left as it is.
     *
     * @param {number} from @param {number} to  the range of letters changed
     * @param {number} by  added to each
     */
    const asciiCase = (from, to, by)=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([string])=>{
            const at = wholeAddress(string);
            if (at === 0)
            {
                return 0;
            }
            for (let offset = at; ; offset += 2)
            {
                const unit = guest.u16(offset);
                if (unit === 0)
                {
                    break;
                }
                if (unit >= from && unit <= to)
                {
                    guest.set16(offset, unit + by);
                }
            }
            return at;
        },
    });

    /** @param {(value: number) => number} type @param {number} mask */
    const classifier = (type, mask)=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([value])=>type(value | 0) & mask,
    });

    /**
     * _wcsicmp or, with a count, _wcsnicmp: ASCII letters folded to lower
     * case, answering the difference of the first pair that differs.
     *
     * @param {boolean} counted
     */
    const asciiCompare = counted=>({
        convention: 'cdecl',
        argBytes: counted ? 12 : 8,
        /** @param {number[]} args */
        handler: ([first, second, count])=>{
            const limit = counted ? count >>> 0 : Infinity;
            for (let at = 0; at < limit; at++)
            {
                const left = asciiLower(guest.u16(wholeAddress(first) + at * 2));
                const right = asciiLower(guest.u16(wholeAddress(second) + at * 2));
                if (left !== right || left === 0)
                {
                    return left - right;
                }
            }
            return 0;
        },
    });

    const crt = host.crt ?? {};
    return {
        ...crt[WIDE_READINGS]?.(isLatin1Space) ?? {},
        ...crt[KERNEL_SCAN] ? { sscanf: crt[KERNEL_SCAN] } : {},
        ...crt[WINDOWS_SORT] ? { qsort: crt[WINDOWS_SORT] } : {},

        _itoa: toText(1, true, false),
        _ltoa: toText(1, true, false),
        _ultoa: toText(1, false, false),
        _i64toa: toText(2, true, false),
        _ui64toa: toText(2, false, false),
        _itow: toText(1, true, true),
        _ltow: toText(1, true, true),
        _ultow: toText(1, false, true),
        _i64tow: toText(2, true, true),
        _ui64tow: toText(2, false, true),

        /** WCHAR towlower(WCHAR): the ASCII and Latin-1 capitals, nothing past them. */
        towlower: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                const unit = value & 0xffff;
                return (unit >= 0x41 && unit <= 0x5a) || (unit >= 0xc0 && unit <= 0xd6)
                    || (unit >= 0xd8 && unit <= 0xde) ? unit + 32 : unit;
            },
        },

        /** WCHAR towupper(WCHAR): RtlUpcaseUnicodeChar. */
        towupper: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>upcaseUnit(value & 0xffff),
        },

        _wcslwr: asciiCase(0x41, 0x5a, 32),
        _wcsupr: asciiCase(0x61, 0x7a, -32),
        _wcsicmp: asciiCompare(false),
        _wcsnicmp: asciiCompare(true),

        /** int tolower(int): an ASCII capital in the low byte lowered, the rest as it came. */
        tolower: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                const low = value & 0xff;
                return low >= 0x41 && low <= 0x5a ? (value | 0) + 32 : value | 0;
            },
        },

        /**
         * int toupper(int): the low byte as the ANSI page's character, its
         * upper case written back in the page (`?` where the page has none).
         */
        toupper: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                const unit = upcaseUnit(decodeAnsi(Uint8Array.of(value & 0xff)).charCodeAt(0));
                return encodeAnsi(String.fromCharCode(unit))[0];
            },
        },

        iswctype: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([value, mask])=>wideType(value & 0xffff) & mask,
        },
        iswalpha: classifier(value=>wideType(value & 0xffff), C1_ALPHA | C1_LOWER | C1_UPPER),
        iswdigit: classifier(value=>wideType(value & 0xffff), C1_DIGIT),
        iswlower: classifier(value=>wideType(value & 0xffff), C1_LOWER),
        iswspace: classifier(value=>wideType(value & 0xffff), C1_SPACE),
        iswxdigit: classifier(value=>wideType(value & 0xffff), C1_XDIGIT),

        isalnum: classifier(narrowType, C1_DIGIT | C1_LOWER | C1_UPPER),
        isalpha: classifier(narrowType, C1_LOWER | C1_UPPER),
        iscntrl: classifier(narrowType, C1_CNTRL),
        isdigit: classifier(narrowType, C1_DIGIT),
        isgraph: classifier(narrowType, C1_DIGIT | C1_PUNCT | C1_LOWER | C1_UPPER),
        islower: classifier(narrowType, C1_LOWER),
        isprint: classifier(narrowType, C1_DIGIT | C1_BLANK | C1_PUNCT | C1_LOWER | C1_UPPER),
        ispunct: classifier(narrowType, C1_PUNCT),
        isspace: classifier(narrowType, C1_SPACE),
        isupper: classifier(narrowType, C1_UPPER),
        isxdigit: classifier(narrowType, C1_XDIGIT),
    };
}

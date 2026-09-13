/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Code pages and the string conversions built on them.
 *
 * A C runtime asks these before main runs, to find out what a byte means. The
 * answer chosen here is Windows-1252 for the ANSI page and 437 for the OEM one:
 * one byte per character, every byte defined, which is what a program compiled
 * for a Western Windows was linked against.
 *
 * Two conventions run through every function here and are the whole difficulty.
 * A source length of -1 means "the string is NUL-terminated, and the terminator
 * is part of what you convert and part of what you count". A destination size of
 * zero means "do not write anything; tell me how much room you need". A runtime
 * uses both on the same call pair -- measure, allocate, convert -- so getting
 * either wrong produces a buffer that is exactly one character short, which is
 * the kind of fault that lands somewhere else entirely.
 */

/** The pages this build understands. CP_ACP and CP_OEMCP are selectors, not pages. */
const CP_ACP = 0;
const CP_OEMCP = 1;
const CP_UTF8 = 65001;
const CP_WINDOWS_1252 = 1252;
const CP_OEM_437 = 437;

/** What GetACP and GetOEMCP answer. */
const ANSI_CODE_PAGE = CP_WINDOWS_1252;
const OEM_CODE_PAGE = CP_OEM_437;

/** Error codes this file can produce. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** sizeof(CPINFO): MaxCharSize, DefaultChar[2], LeadByte[12]. */
const CPINFO_SIZE = 18;

/** What GetStringType reports. Only CT_CTYPE1 is answered. */
const CT_CTYPE1 = 1;
const C1_UPPER = 0x0001;
const C1_LOWER = 0x0002;
const C1_DIGIT = 0x0004;
const C1_SPACE = 0x0008;
const C1_PUNCT = 0x0010;
const C1_CNTRL = 0x0020;
const C1_BLANK = 0x0040;
const C1_XDIGIT = 0x0080;
const C1_ALPHA = 0x0100;

/** LCMapString's two cases. Everything else is a copy. */
const LCMAP_LOWERCASE = 0x00000100;
const LCMAP_UPPERCASE = 0x00000200;

/**
 * The sixteen positions where Windows-1252 is not Latin-1.
 *
 * Latin-1 leaves 0x80..0x9f as control characters; Windows put punctuation and
 * a handful of letters there, and text from that era is full of them. A zero
 * here means the position is genuinely undefined in the page.
 */
const CP1252_HIGH = [
    0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017d, 0x0000,
    0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];

/**
 * Code page 437's upper half, which is nothing like Latin-1: accented letters,
 * box-drawing and mathematics, in the order IBM chose for the PC.
 */
const CP437_HIGH = [
    0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
    0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
    0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
    0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
    0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
    0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
    0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
    0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
    0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
    0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
    0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
    0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
    0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
    0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
    0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];

/**
 * The one locale, and the two selectors that also name it.
 *
 * 0x0409 is English (United States), which is the locale the code pages above
 * describe. A build claiming a locale whose code page it does not carry would
 * convert text one way and format it another.
 */
const LANGID_EN_US = 0x0409;
const LCID_EN_US = 0x0409;
const LOCALE_USER_DEFAULT = 0x0400;
const LOCALE_SYSTEM_DEFAULT = 0x0800;

/** Asks for the system value rather than one a user overrode. There is no user. */
const LOCALE_NOUSEROVERRIDE = 0x80000000;

/** CompareString's answers. Note that none of them is zero: zero is failure. */
const CSTR_LESS_THAN = 1;
const CSTR_EQUAL = 2;
const CSTR_GREATER_THAN = 3;

/** The one CompareString flag honoured. */
const NORM_IGNORECASE = 0x00000001;

/** Which picture GetDateFormat and GetTimeFormat use when given none. */
const DATE_LONGDATE = 0x00000002;
const TIME_NOSECONDS = 0x00000002;

const SHORT_DATE = 'M/d/yyyy';
const LONG_DATE = 'dddd, MMMM dd, yyyy';
const LONG_TIME = 'h:mm:ss tt';
const SHORT_TIME = 'h:mm tt';

/** sizeof(SYSTEMTIME), which the date and time formats are given one of. */
const SYSTEMTIME_SIZE = 16;

/** ERROR_CALL_NOT_IMPLEMENTED, for the one function here that is not. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;

/** The pages this build can actually convert; IsValidCodePage answers from it. */
const KNOWN_PAGES = [CP_WINDOWS_1252, CP_OEM_437, CP_UTF8];

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

const DAYS = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * What GetLocaleInfo answers, by LCTYPE.
 *
 * Only the values a C runtime and a program's own formatting actually ask for.
 * An LCTYPE not here fails rather than returning an empty string: a caller
 * given "" for the decimal separator formats every number wrongly and never
 * finds out, where a failure sends it to its own default.
 */
const LOCALE_STRINGS = Object.freeze({
    0x00000001: '0409',                    // ILANGUAGE
    0x00000002: 'English (United States)', // SLANGUAGE
    0x00000003: 'ENU',                     // SABBREVLANGNAME
    0x00000006: 'United States',           // SCOUNTRY
    0x0000000B: '437',                     // IDEFAULTCODEPAGE
    0x0000000C: ',',                       // SLIST
    0x0000000D: '1',                       // IMEASURE, non-metric
    0x0000000E: '.',                       // SDECIMAL
    0x0000000F: ',',                       // STHOUSAND
    0x0000001D: '/',                       // SDATE
    0x0000001E: ':',                       // STIME
    0x0000001F: SHORT_DATE,                // SSHORTDATE
    0x00000020: LONG_DATE,                 // SLONGDATE
    0x00000028: 'AM',                      // S1159
    0x00000029: 'PM',                      // S2359
    0x0000002A: 'Monday',                  // SDAYNAME1
    0x0000002B: 'Tuesday',
    0x0000002C: 'Wednesday',
    0x0000002D: 'Thursday',
    0x0000002E: 'Friday',
    0x0000002F: 'Saturday',
    0x00000030: 'Sunday',                  // SDAYNAME7
    0x00000038: 'January',                 // SMONTHNAME1
    0x00000039: 'February',
    0x0000003A: 'March',
    0x0000003B: 'April',
    0x0000003C: 'May',
    0x0000003D: 'June',
    0x0000003E: 'July',
    0x0000003F: 'August',
    0x00000040: 'September',
    0x00000041: 'October',
    0x00000042: 'November',
    0x00000043: 'December',                // SMONTHNAME12
    0x00000059: 'en',                      // SISO639LANGNAME
    0x0000005A: 'US',                      // SISO3166CTRYNAME
    0x00001001: 'English',                 // SENGLANGUAGE
    0x00001002: 'United States',           // SENGCOUNTRY
    0x00001003: LONG_TIME,                 // STIMEFORMAT
    0x00001004: '1252',                    // IDEFAULTANSICODEPAGE
    0x00001009: '1',                       // ICALENDARTYPE, Gregorian
    0x0000100C: '6',                       // IFIRSTDAYOFWEEK, Sunday first
});

/** The byte a character outside the page becomes. */
const DEFAULT_CHAR = 0x3f;

/** @param {number} page */
const resolvePage = page=>{
    const wanted = page >>> 0;
    if (wanted === CP_ACP)
    {
        return ANSI_CODE_PAGE;
    }
    if (wanted === CP_OEMCP)
    {
        return OEM_CODE_PAGE;
    }
    return wanted;
};

/** The upper half of a single-byte page, or null when the page is not one. */
const highHalf = (/** @type {number} */ page)=>{
    switch (page)
    {
        case CP_WINDOWS_1252:
            return CP1252_HIGH;
        case CP_OEM_437:
            return CP437_HIGH;
        default:
            // An unknown page is treated as the ANSI one rather than refused.
            // A program that names a page we do not carry is better served with
            // readable text than with a failure it has no path for.
            return CP1252_HIGH;
    }
};

/**
 * Bytes of a single-byte page, decoded.
 *
 * @param {Uint8Array} bytes @param {number} page
 */
const decodeSingleByte = (bytes, page)=>{
    const high = highHalf(page);
    let text = '';
    for (const byte of bytes)
    {
        text += String.fromCharCode(byte < 0x80 ? byte : high[byte - 0x80] || byte);
    }
    return text;
};

/**
 * Text encoded into a single-byte page. Anything the page cannot hold becomes
 * the default character, which is what Windows does and what a caller asking
 * for lpUsedDefaultChar is trying to find out.
 *
 * @param {string} text @param {number} page
 * @returns {{ bytes: Uint8Array, usedDefault: boolean }}
 */
const encodeSingleByte = (text, page)=>{
    const high = highHalf(page);
    const bytes = new Uint8Array(text.length);
    let usedDefault = false;
    for (let at = 0; at < text.length; at++)
    {
        const code = text.charCodeAt(at);
        if (code < 0x80)
        {
            bytes[at] = code;
            continue;
        }
        const found = high.indexOf(code);
        // A page whose table stops short of the top is Latin-1 above it, the
        // way its decoder already reads it; without this the accented half of
        // Windows-1252 came back as the default character.
        if (found === -1 && code >= 0x80 + high.length && code <= 0xff)
        {
            bytes[at] = code;
            continue;
        }
        if (found === -1)
        {
            bytes[at] = DEFAULT_CHAR;
            usedDefault = true;
            continue;
        }
        bytes[at] = 0x80 + found;
    }
    return { bytes, usedDefault };
};

/**
 * Bytes of one single-byte page re-encoded in another, byte for byte: what
 * OemToChar and CharToOem do, and the same tables the code-page conversions
 * use, so the two agree on every character.
 *
 * @param {Uint8Array} bytes @param {number} from @param {number} to
 * @returns {Uint8Array}
 */
export const transcodeSingleByte = (bytes, from, to)=>
    encodeSingleByte(decodeSingleByte(bytes, from), to).bytes;

/** The pages the OEM/ANSI conversions translate between, for their callers. */
export const OEM_PAGE = CP_OEM_437;
export const ANSI_PAGE = CP_WINDOWS_1252;

/** @param {number} code */
const characterType = code=>{
    const character = String.fromCharCode(code);
    let type = 0;
    if (/\p{Lu}/u.test(character))
    {
        type |= C1_UPPER | C1_ALPHA;
    }
    if (/\p{Ll}/u.test(character))
    {
        type |= C1_LOWER | C1_ALPHA;
    }
    if (/\p{L}/u.test(character))
    {
        type |= C1_ALPHA;
    }
    if (code >= 0x30 && code <= 0x39)
    {
        type |= C1_DIGIT | C1_XDIGIT;
    }
    if (/[a-fA-F]/.test(character))
    {
        type |= C1_XDIGIT;
    }
    if (/\s/.test(character))
    {
        type |= C1_SPACE;
    }
    if (code === 0x20 || code === 0x09)
    {
        type |= C1_BLANK;
    }
    if (code < 0x20 || code === 0x7f)
    {
        type |= C1_CNTRL;
    }
    if (/[!-/:-@[-`{-~]/.test(character))
    {
        type |= C1_PUNCT;
    }
    return type;
};

/**
 * @typedef {Object} LocaleHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {() => number} [systemTimeMs]
 *           The guest wall clock, for a date or time format given no
 *           SYSTEMTIME of its own. Without it that one case fails.
 */

/**
 * @param {LocaleHost} host
 */
export function createLocaleFunctions(host){
    /**
     * The source of a conversion, as characters.
     *
     * A length of -1 means the string is NUL-terminated and the terminator
     * travels with it -- so the result of the conversion is terminated too, and
     * the count a caller is told includes it. Every other length is exact and
     * carries no terminator of its own.
     *
     * @param {number} address @param {number} declared @param {number} unit
     * @returns {{ length: number, terminated: boolean }}
     */
    const sourceSpan = (address, declared, unit)=>{
        if ((declared | 0) !== -1)
        {
            return { length: Math.max(declared | 0, 0), terminated: false };
        }
        let count = 0;
        for (;;)
        {
            const bytes = host.readMemory(address + count * unit, unit);
            const code = unit === 1 ? bytes[0] : bytes[0] | bytes[1] << 8;
            if (code === 0)
            {
                break;
            }
            count++;
        }
        return { length: count + 1, terminated: true };
    };

    /** @param {number} address @param {number} count */
    const readWide = (address, count)=>{
        const bytes = host.readMemory(address, count * 2);
        let text = '';
        for (let at = 0; at < count; at++)
        {
            text += String.fromCharCode(bytes[at * 2] | bytes[at * 2 + 1] << 8);
        }
        return text;
    };

    /** @param {number} address @param {string} text */
    const writeWide = (address, text)=>{
        const bytes = new Uint8Array(text.length * 2);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >> 8;
        }
        host.writeMemory(address, bytes);
    };

    /**
     * A span of eight-bit text. A length of -1 means NUL-terminated, and unlike
     * the conversion functions above the terminator is *not* part of what is
     * compared or formatted -- these functions take text, not a buffer.
     *
     * @param {number} address @param {number} declared
     */
    const readAnsiSpan = (address, declared)=>{
        const { length } = sourceSpan(address, declared, 1);
        const wanted = (declared | 0) === -1 ? Math.max(length - 1, 0) : length;
        return decodeSingleByte(host.readMemory(address, wanted), ANSI_CODE_PAGE);
    };

    /** @param {number} address @param {number} declared */
    const readWideSpan = (address, declared)=>{
        const { length } = sourceSpan(address, declared, 2);
        const wanted = (declared | 0) === -1 ? Math.max(length - 1, 0) : length;
        return readWide(address, wanted);
    };

    /**
     * CompareString's three-valued answer.
     *
     * @param {string} first @param {string} second @param {number} flags
     */
    const compare = (first, second, flags)=>{
        const left = (flags & NORM_IGNORECASE) !== 0 ? first.toLowerCase() : first;
        const right = (flags & NORM_IGNORECASE) !== 0 ? second.toLowerCase() : second;
        if (left < right)
        {
            return CSTR_LESS_THAN;
        }
        return left > right ? CSTR_GREATER_THAN : CSTR_EQUAL;
    };

    /** @param {number} locale */
    const isOurLocale = locale=>locale === LCID_EN_US
        || locale === LOCALE_USER_DEFAULT
        || locale === LOCALE_SYSTEM_DEFAULT;

    /**
     * The two-call protocol these three share: with a count of zero, the room
     * needed *including* the terminator and nothing written; otherwise the
     * length written *including* the terminator, or a failure when it does not
     * fit. Note that this differs from the path functions elsewhere, which
     * report the length without the terminator on success -- the difference is
     * real and a caller of both has to know which it is holding.
     *
     * @param {string} text @param {number} buffer @param {number} count
     * @param {boolean} isWide
     */
    const writeAnswer = (text, buffer, count, isWide)=>{
        const needed = text.length + 1;
        if (count === 0)
        {
            return needed;
        }
        if (buffer === 0 || needed > count)
        {
            host.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        if (isWide)
        {
            writeWide(buffer, text + String.fromCharCode(0));
        }
        else
        {
            const { bytes } = encodeSingleByte(text + String.fromCharCode(0),
                ANSI_CODE_PAGE);
            host.writeMemory(buffer, bytes);
        }
        return needed;
    };

    /** @param {string} text @param {number} buffer @param {number} count */
    const writeFormatted = (text, buffer, count)=>writeAnswer(text, buffer, count, false);

    /**
     * @param {number} locale @param {number} type @param {number} buffer
     * @param {number} count @param {boolean} isWide
     */
    const localeInfo = (locale, type, buffer, count, isWide)=>{
        if (!isOurLocale(locale))
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        // The high bit asks for the unaltered system value rather than whatever
        // the user changed in the control panel. There is no user here, so both
        // answers are the same one and the bit is simply cleared.
        const wanted = type & ~LOCALE_NOUSEROVERRIDE;
        const text = /** @type {Record<number, string>} */ (LOCALE_STRINGS)[wanted];
        if (text === undefined)
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        return writeAnswer(text, buffer, count, isWide);
    };

    /**
     * The SYSTEMTIME a date or time format was given, or the clock when it was
     * given none. Null when there is neither.
     *
     * @param {number} address
     * @returns {{ year: number, month: number, day: number, weekday: number,
     *             hour: number, minute: number, second: number } | null}
     */
    const timeOf = address=>{
        if (address !== 0)
        {
            const bytes = host.readMemory(address, SYSTEMTIME_SIZE);
            const view = new DataView(bytes.buffer, bytes.byteOffset, SYSTEMTIME_SIZE);
            return {
                year: view.getUint16(0, true),
                month: view.getUint16(2, true),
                weekday: view.getUint16(4, true),
                day: view.getUint16(6, true),
                hour: view.getUint16(8, true),
                minute: view.getUint16(10, true),
                second: view.getUint16(12, true),
            };
        }
        if (!host.systemTimeMs)
        {
            return null;
        }
        const now = new Date(host.systemTimeMs());
        return {
            year: now.getUTCFullYear(),
            month: now.getUTCMonth() + 1,
            weekday: now.getUTCDay(),
            day: now.getUTCDate(),
            hour: now.getUTCHours(),
            minute: now.getUTCMinutes(),
            second: now.getUTCSeconds(),
        };
    };

    /**
     * A date or time picture, rendered.
     *
     * The tokens are matched longest first, which is the whole of the
     * difference between a correct renderer and one that turns "yyyy" into four
     * copies of the year. Anything not a token is copied through, so a picture
     * carrying separators or literal text comes out with them.
     *
     * @param {string} picture
     * @param {{ year: number, month: number, day: number, weekday: number,
     *           hour: number, minute: number, second: number }} when
     */
    const render = (picture, when)=>{
        const pad = (/** @type {number} */ value, /** @type {number} */ width)=>
            String(value).padStart(width, '0');
        const hour12 = when.hour % 12 === 0 ? 12 : when.hour % 12;
        /** @type {[string, string][]} */
        const tokens = [
            ['yyyy', pad(when.year, 4)],
            ['yy', pad(when.year % 100, 2)],
            ['MMMM', MONTHS[when.month - 1] ?? ''],
            ['MMM', (MONTHS[when.month - 1] ?? '').slice(0, 3)],
            ['MM', pad(when.month, 2)],
            ['M', String(when.month)],
            ['dddd', DAYS[when.weekday] ?? ''],
            ['ddd', (DAYS[when.weekday] ?? '').slice(0, 3)],
            ['dd', pad(when.day, 2)],
            ['d', String(when.day)],
            ['HH', pad(when.hour, 2)],
            ['H', String(when.hour)],
            ['hh', pad(hour12, 2)],
            ['h', String(hour12)],
            ['mm', pad(when.minute, 2)],
            ['m', String(when.minute)],
            ['ss', pad(when.second, 2)],
            ['s', String(when.second)],
            ['tt', when.hour < 12 ? 'AM' : 'PM'],
            ['t', when.hour < 12 ? 'A' : 'P'],
        ];

        let out = '';
        let at = 0;
        while (at < picture.length)
        {
            const found = tokens.find(([token])=>picture.startsWith(token, at));
            if (found)
            {
                out += found[1];
                at += found[0].length;
                continue;
            }
            out += picture[at];
            at++;
        }
        return out;
    };

    return {
        /** UINT GetACP(VOID) */
        GetACP: { argBytes: 0, handler: ()=>ANSI_CODE_PAGE },

        /**
         * LCID GetUserDefaultLCID(VOID) / GetSystemDefaultLCID(VOID)
         *
         * One locale, and it is the one the code pages above describe. A build
         * claiming a locale whose code page it does not carry would convert text
         * one way and format it another.
         */
        GetUserDefaultLCID: { argBytes: 0, handler: ()=>LCID_EN_US },

        /** LANGID GetUserDefaultLangID(VOID) */
        GetUserDefaultLangID: { argBytes: 0, handler: ()=>LANGID_EN_US },

        /** LANGID GetSystemDefaultLangID(VOID) */
        GetSystemDefaultLangID: { argBytes: 0, handler: ()=>LANGID_EN_US },

        /**
         * LANGID GetSystemDefaultUILanguage(VOID)
         *
         * The language the system's own resources are in, which here is the
         * only one there is: a program that picks its strings by this must
         * land on the same table it picks its formats by.
         */
        GetSystemDefaultUILanguage: { argBytes: 0, handler: ()=>LANGID_EN_US },

        /**
         * BOOL IsValidCodePage(UINT CodePage)
         *
         * Only the pages this build can actually convert. Claiming one it cannot
         * would have a caller select it and then get default characters back for
         * every byte, which looks like corrupt data rather than a refusal.
         */
        IsValidCodePage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([page])=>KNOWN_PAGES.includes(resolvePage(page)) ? 1 : 0,
        },

        /**
         * BOOL IsValidLocale(LCID Locale, DWORD dwFlags)
         *
         * The one locale, plus the two selectors that name it indirectly. A
         * caller enumerating locales checks each against this.
         */
        IsValidLocale: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([locale])=>isOurLocale(locale >>> 0) ? 1 : 0,
        },

        /**
         * BOOL IsDBCSLeadByteEx(UINT CodePage, BYTE TestChar)
         *
         * Never. Both pages this build carries are single-byte, so no byte
         * begins a two-byte character -- and a caller that believed otherwise
         * would skip the byte after it.
         */
        IsDBCSLeadByteEx: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * int CompareStringA(LCID, DWORD dwCmpFlags, LPCSTR, int, LPCSTR, int)
         *
         * An ordinal comparison, optionally case-insensitive. It is not the
         * locale-aware collation Windows performs: this build has no collation
         * table, and one invented here would sort a list into an order no other
         * part of the system agrees with. For the alphabet these code pages
         * cover the two orders differ only in where accented letters fall.
         *
         * The return values are 1, 2 and 3 rather than the -1, 0 and 1 every
         * other comparison in the world uses -- a caller subtracts 2 to get the
         * familiar sign, and a function returning 0 here means it failed.
         */
        CompareStringA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, flags, first, firstLength, second, secondLength])=>compare(
                readAnsiSpan(first >>> 0, firstLength),
                readAnsiSpan(second >>> 0, secondLength),
                flags >>> 0),
        },

        /** int CompareStringW(LCID, DWORD, LPCWSTR, int, LPCWSTR, int) */
        CompareStringW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, flags, first, firstLength, second, secondLength])=>compare(
                readWideSpan(first >>> 0, firstLength),
                readWideSpan(second >>> 0, secondLength),
                flags >>> 0),
        },

        /** int GetLocaleInfoA(LCID Locale, LCTYPE LCType, LPSTR lpLCData, int cchData) */
        GetLocaleInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([locale, type, buffer, count])=>localeInfo(
                locale >>> 0, type >>> 0, buffer >>> 0, count | 0, false),
        },

        /** int GetLocaleInfoW(LCID Locale, LCTYPE LCType, LPWSTR lpLCData, int cchData) */
        GetLocaleInfoW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([locale, type, buffer, count])=>localeInfo(
                locale >>> 0, type >>> 0, buffer >>> 0, count | 0, true),
        },

        /**
         * BOOL EnumSystemLocalesA(LOCALE_ENUMPROCA lpLocaleEnumProc, DWORD dwFlags)
         *
         * Not enumerated. Calling the callback would mean calling into guest
         * code from here, which this table has no way to do; a C runtime uses
         * this to find out which locales exist and falls back to the default
         * when it learns nothing, which is the same place it ends up anyway with
         * one locale installed.
         */
        EnumSystemLocalesA: {
            argBytes: 8,
            handler: ()=>{
                host.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
                return 0;
            },
        },

        /**
         * int GetDateFormatA(LCID, DWORD dwFlags, const SYSTEMTIME *,
         *                    LPCSTR lpFormat, LPSTR lpDateStr, int cchDate)
         *
         * A NULL SYSTEMTIME means now, which is the only reason this needs a
         * clock at all. A NULL format means the locale's own short or long
         * picture, chosen by the flags.
         */
        GetDateFormatA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, flags, time, format, buffer, count])=>{
                const when = timeOf(time >>> 0);
                if (!when)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const picture = format !== 0
                    ? readAnsiSpan(format >>> 0, -1)
                    : ((flags >>> 0) & DATE_LONGDATE) !== 0 ? LONG_DATE : SHORT_DATE;
                return writeFormatted(render(picture, when), buffer >>> 0, count | 0);
            },
        },

        /**
         * int GetTimeFormatA(LCID, DWORD dwFlags, const SYSTEMTIME *,
         *                    LPCSTR lpFormat, LPSTR lpTimeStr, int cchTime)
         */
        GetTimeFormatA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, flags, time, format, buffer, count])=>{
                const when = timeOf(time >>> 0);
                if (!when)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const picture = format !== 0
                    ? readAnsiSpan(format >>> 0, -1)
                    : ((flags >>> 0) & TIME_NOSECONDS) !== 0 ? SHORT_TIME : LONG_TIME;
                return writeFormatted(render(picture, when), buffer >>> 0, count | 0);
            },
        },

        /** UINT GetOEMCP(VOID) */
        GetOEMCP: { argBytes: 0, handler: ()=>OEM_CODE_PAGE },

        /** BOOL GetCPInfo(UINT CodePage, LPCPINFO lpCPInfo) */
        GetCPInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([page, info])=>{
                const resolved = resolvePage(page);
                const bytes = new Uint8Array(CPINFO_SIZE);
                // MaxCharSize, then DefaultChar, then the lead-byte ranges. Every
                // page here is single byte or UTF-8, so no lead-byte range is
                // reported and the array stays zero -- which is how a caller
                // learns the page has no double-byte sequences.
                new DataView(bytes.buffer).setUint32(
                    0, resolved === CP_UTF8 ? 4 : 1, true);
                bytes[4] = DEFAULT_CHAR;
                host.writeMemory(info >>> 0, bytes);
                return 1;
            },
        },

        /**
         * int MultiByteToWideChar(UINT CodePage, DWORD dwFlags, LPCCH lpMultiByteStr,
         *                         int cbMultiByte, LPWSTR lpWideCharStr, int cchWideChar)
         */
        MultiByteToWideChar: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([page, flags, source, sourceBytes, destination, destinationChars])=>{
                void flags;
                const resolved = resolvePage(page);
                const span = sourceSpan(source >>> 0, sourceBytes, 1);
                if (span.length === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const raw = host.readMemory(source >>> 0, span.length);
                const text = resolved === CP_UTF8
                    ? new TextDecoder().decode(raw)
                    : decodeSingleByte(raw, resolved);

                // Zero is the measuring call, and it must not write.
                if ((destinationChars | 0) === 0)
                {
                    return text.length;
                }
                if (text.length > (destinationChars | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                writeWide(destination >>> 0, text);
                return text.length;
            },
        },

        /**
         * int WideCharToMultiByte(UINT CodePage, DWORD dwFlags, LPCWCH lpWideCharStr,
         *                         int cchWideChar, LPSTR lpMultiByteStr, int cbMultiByte,
         *                         LPCCH lpDefaultChar, LPBOOL lpUsedDefaultChar)
         */
        WideCharToMultiByte: {
            argBytes: 32,
            /** @param {number[]} args */
            handler(args){
                const [page, flags, source, sourceChars, destination, destinationBytes] = args;
                const usedDefaultOut = args[7] >>> 0;
                void flags;
                const resolved = resolvePage(page);
                const span = sourceSpan(source >>> 0, sourceChars, 2);
                if (span.length === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const text = readWide(source >>> 0, span.length);
                const encoded = resolved === CP_UTF8
                    ? { bytes: new TextEncoder().encode(text), usedDefault: false }
                    : encodeSingleByte(text, resolved);

                if (usedDefaultOut !== 0)
                {
                    host.writeMemory(usedDefaultOut,
                        new Uint8Array([encoded.usedDefault ? 1 : 0, 0, 0, 0]));
                }
                if ((destinationBytes | 0) === 0)
                {
                    return encoded.bytes.length;
                }
                if (encoded.bytes.length > (destinationBytes | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                host.writeMemory(destination >>> 0, encoded.bytes);
                return encoded.bytes.length;
            },
        },

        /**
         * BOOL GetStringTypeA(LCID Locale, DWORD dwInfoType, LPCSTR lpSrcStr,
         *                     int cchSrc, LPWORD lpCharType)
         */
        GetStringTypeA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([locale, infoType, source, count, types])=>{
                void locale;
                if ((infoType >>> 0) !== CT_CTYPE1)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const span = sourceSpan(source >>> 0, count, 1);
                const raw = host.readMemory(source >>> 0, span.length);
                const text = decodeSingleByte(raw, ANSI_CODE_PAGE);
                const out = new Uint8Array(text.length * 2);
                const view = new DataView(out.buffer);
                for (let at = 0; at < text.length; at++)
                {
                    view.setUint16(at * 2, characterType(text.charCodeAt(at)), true);
                }
                host.writeMemory(types >>> 0, out);
                return 1;
            },
        },

        /**
         * BOOL GetStringTypeW(DWORD dwInfoType, LPCWCH lpSrcStr, int cchSrc,
         *                     LPWORD lpCharType)
         *
         * Four arguments, not five: the W form has no locale, which is the one
         * place these two disagree about their own shape.
         */
        GetStringTypeW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([infoType, source, count, types])=>{
                if ((infoType >>> 0) !== CT_CTYPE1)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const span = sourceSpan(source >>> 0, count, 2);
                const text = readWide(source >>> 0, span.length);
                const out = new Uint8Array(text.length * 2);
                const view = new DataView(out.buffer);
                for (let at = 0; at < text.length; at++)
                {
                    view.setUint16(at * 2, characterType(text.charCodeAt(at)), true);
                }
                host.writeMemory(types >>> 0, out);
                return 1;
            },
        },

        /**
         * int LCMapStringA(LCID Locale, DWORD dwMapFlags, LPCSTR lpSrcStr, int cchSrc,
         *                  LPSTR lpDestStr, int cchDest)
         */
        LCMapStringA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([locale, mapFlags, source, sourceChars, destination, destinationChars])=>{
                void locale;
                const span = sourceSpan(source >>> 0, sourceChars, 1);
                const raw = host.readMemory(source >>> 0, span.length);
                const text = decodeSingleByte(raw, ANSI_CODE_PAGE);
                const mapped = (mapFlags >>> 0) & LCMAP_UPPERCASE
                    ? text.toUpperCase()
                    : (mapFlags >>> 0) & LCMAP_LOWERCASE ? text.toLowerCase() : text;
                const { bytes } = encodeSingleByte(mapped, ANSI_CODE_PAGE);

                if ((destinationChars | 0) === 0)
                {
                    return bytes.length;
                }
                if (bytes.length > (destinationChars | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                host.writeMemory(destination >>> 0, bytes);
                return bytes.length;
            },
        },

        /**
         * int LCMapStringW(LCID Locale, DWORD dwMapFlags, LPCWSTR lpSrcStr, int cchSrc,
         *                  LPWSTR lpDestStr, int cchDest)
         */
        LCMapStringW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([locale, mapFlags, source, sourceChars, destination, destinationChars])=>{
                void locale;
                const span = sourceSpan(source >>> 0, sourceChars, 2);
                const text = readWide(source >>> 0, span.length);
                const mapped = (mapFlags >>> 0) & LCMAP_UPPERCASE
                    ? text.toUpperCase()
                    : (mapFlags >>> 0) & LCMAP_LOWERCASE ? text.toLowerCase() : text;

                if ((destinationChars | 0) === 0)
                {
                    return mapped.length;
                }
                if (mapped.length > (destinationChars | 0))
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                writeWide(destination >>> 0, mapped);
                return mapped.length;
            },
        },
    };
}

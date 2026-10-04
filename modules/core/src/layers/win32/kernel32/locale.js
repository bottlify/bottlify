/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { UI_LANGUAGE } from '../../loader/internal/resources.js';
import { STATUS } from '../ntdll/status.js';

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

/** GetUserGeoID's class of a country, and the United States' number among them. */
const GEOCLASS_NATION = 16;
const GEOID_UNITED_STATES = 244;

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
const ERROR_INVALID_FLAGS = 1004;
const ERROR_NO_UNICODE_TRANSLATION = 1113;
const ERROR_GEN_FAILURE = 31;

/** How the preferred-UI-language calls name a language, and which they list (winnls.h). */
const MUI_LANGUAGE_ID = 0x04;
const MUI_LANGUAGE_NAME = 0x08;
const MUI_UI_FALLBACK = 0x30;
const MUI_THREAD_LANGUAGES = 0x40;
const MUI_MACHINE_LANGUAGE_SETTINGS = 0x400;
/** The filters GetThreadPreferredUILanguages takes and nothing here filters out. */
const MUI_FILTERS = 0x001 | 0x100 | 0x200;
/** A thread keeps this many of the languages it names, as Windows does. */
const THREAD_LANGUAGE_LIMIT = 5;

/** MultiByteToWideChar's flag that turns a malformed sequence into a failure. */
const MB_ERR_INVALID_CHARS = 0x8;

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
export const LANGID_EN_US = 0x0409;
const LCID_EN_US = 0x0409;
const LOCALE_INVARIANT = 0x007F;
const LOCALE_USER_DEFAULT = 0x0400;
const LOCALE_SYSTEM_DEFAULT = 0x0800;

/** Asks for the system value rather than one a user overrode. There is no user. */
const LOCALE_NOUSEROVERRIDE = 0x80000000;
/** Converts with the ANSI page rather than the locale's; they are the same page here. */
const LOCALE_USE_CP_ACP = 0x40000000;
const LOCALE_RETURN_NUMBER = 0x20000000;
/** The month names as they stand after a day; English has no second form. */
const LOCALE_RETURN_GENITIVE_NAMES = 0x10000000;
const LOCALE_ALLOW_NEUTRAL_NAMES = 0x08000000;
const LOCALE_FLAGS = LOCALE_NOUSEROVERRIDE | LOCALE_USE_CP_ACP | LOCALE_RETURN_NUMBER
    | LOCALE_RETURN_GENITIVE_NAMES | LOCALE_ALLOW_NEUTRAL_NAMES;
const LOCALE_SMONTHNAME1 = 0x0038;
const LOCALE_SMONTHNAME13 = 0x100E;

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

/** The time formats EnumTimeFormats enumerates, the locale's own first. */
const TIME_FORMATS = ['h:mm:ss tt', 'hh:mm:ss tt', 'H:mm:ss', 'HH:mm:ss',
    'h:mm tt', 'hh:mm tt', 'H:mm', 'HH:mm'];

/** And the date formats EnumDateFormats does, by kind, the locale's own first. */
const YEAR_MONTH = 'MMMM, yyyy';
const SHORT_DATE_FORMATS = [SHORT_DATE, 'M/d/yy', 'MM/dd/yy', 'MM/dd/yyyy', 'yy/MM/dd',
    'yyyy-MM-dd', 'dd-MMM-yy'];
const LONG_DATE_FORMATS = [LONG_DATE, 'MMMM dd, yyyy', 'dddd, dd MMMM, yyyy', 'dd MMMM, yyyy'];
const YEAR_MONTH_FORMATS = [YEAR_MONTH];

/** EnumDateFormats' kinds besides DATE_LONGDATE: DATE_SHORTDATE, DATE_YEARMONTH. */
const DATE_SHORTDATE = 0x00000001;
const DATE_YEARMONTH = 0x00000008;

/** sizeof(SYSTEMTIME), which the date and time formats are given one of. */
const SYSTEMTIME_SIZE = 16;

/**
 * @typedef {Object} NumberPicture   A NUMBERFMT, read or defaulted.
 * @property {number} digits         Decimal places.
 * @property {number} leadingZero    Whether 0.5 is written with its zero.
 * @property {number} grouping       Digits to a group, 0 for none.
 * @property {string} decimal
 * @property {string} thousand
 * @property {number} negativeOrder  Where the sign goes, 0..4 (0..15 for money).
 * @property {number} [positiveOrder] Where a currency symbol goes, 0..3.
 * @property {string} [symbol]       The currency's.
 */

/**
 * How GetNumberFormat writes a number when handed no NUMBERFMT of its own:
 * the locale's own picture, which for this one is two decimals, a leading
 * zero, groups of three, and a minus sign in front.
 *
 * @type {Readonly<NumberPicture>}
 */
const NUMBER_DEFAULTS = Object.freeze({
    digits: 2, leadingZero: 1, grouping: 3, decimal: '.', thousand: ',', negativeOrder: 1,
});

/**
 * GetCurrencyFormat's picture when handed none: the number's, with a dollar
 * sign in front and a negative amount in parentheses.
 *
 * @type {Readonly<NumberPicture>}
 */
const CURRENCY_DEFAULTS = Object.freeze({
    ...NUMBER_DEFAULTS, negativeOrder: 0, positiveOrder: 0, symbol: '$',
});

/** sizeof(NUMBERFMTA): six DWORD-sized fields, two of them pointers. */
const NUMBERFMTA_SIZE = 24;
/** sizeof(CURRENCYFMTA): NUMBERFMTA's, then PositiveOrder and the symbol. */
const CURRENCYFMTA_SIZE = 32;

/**
 * Where a currency symbol goes ($) around an amount (1), by PositiveOrder and
 * by NegativeOrder.
 */
const CURRENCY_POSITIVE = ['$1', '1$', '$ 1', '1 $'];
const CURRENCY_NEGATIVE = ['($1)', '-$1', '$-1', '$1-', '(1$)', '-1$', '1-$', '1$-',
    '-1 $', '-$ 1', '1 $-', '$ 1-', '$ -1', '1- $', '($ 1)', '(1 $)'];

/** GetCPInfoEx's names for the pages there are. */
const PAGE_NAMES = Object.freeze({
    1252: '1252  (ANSI - Latin I)',
    437: '437   (OEM - United States)',
    65001: '65001 (UTF-8)',
});
/** Where CodePageName starts in CPINFOEXA and CPINFOEXW, and its characters. */
const CPINFOEX_NAME = 24;
const MAX_PATH = 260;

/** ERROR_CALL_NOT_IMPLEMENTED, for the one function here that is not. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;

/** FoldString's mappings (winnls.h). */
const MAP_FOLDCZONE = 0x10;
const MAP_PRECOMPOSED = 0x20;
const MAP_COMPOSITE = 0x40;
const MAP_FOLDDIGITS = 0x80;
const MAP_EXPAND_LIGATURES = 0x2000;
const MAP_FLAGS = MAP_FOLDCZONE | MAP_PRECOMPOSED | MAP_COMPOSITE | MAP_FOLDDIGITS
    | MAP_EXPAND_LIGATURES;

/** What MAP_EXPAND_LIGATURES makes of each ligature Windows expands. */
const LIGATURES = new Map(Object.entries({
    'Æ': 'AE', 'Þ': 'TH', 'ß': 'ss', 'æ': 'ae', 'þ': 'th', 'Ĳ': 'IJ', 'ĳ': 'ij', 'Œ': 'OE',
    'œ': 'oe', 'Ǆ': 'DŽ', 'ǅ': 'Dž', 'ǆ': 'dž', 'Ǉ': 'LJ', 'ǈ': 'Lj', 'ǉ': 'lj', 'Ǌ': 'NJ',
    'ǋ': 'Nj', 'ǌ': 'nj', 'Ǣ': 'ĀĒ', 'ǣ': 'āē', 'Ǳ': 'DZ', 'ǲ': 'Dz', 'ǳ': 'dz', 'Ǽ': 'ÁÉ',
    'ǽ': 'áé', 'װ': 'וו', 'ױ': 'וי', 'ײ': 'יי', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi',
    'ﬄ': 'ffl', 'ﬅ': 'ſt', 'ﬆ': 'st',
}));

/**
 * The digits MAP_FOLDDIGITS folds that are not decimal digits in Unicode's
 * sense -- superscripts, circled and bracketed forms and the like -- as
 * [first code point, its digit, the last digit of the run].
 */
const OTHER_DIGITS = [
    [0x00b2, 2, 3], [0x00b9, 1, 1], [0x2070, 0, 0], [0x2074, 4, 9], [0x2080, 0, 9],
    [0x2460, 1, 9], [0x2474, 1, 9], [0x2488, 1, 9], [0x24ea, 0, 0], [0x24f5, 1, 9],
    [0x24ff, 0, 0], [0x2776, 1, 9], [0x2780, 1, 9], [0x278a, 1, 9], [0x3007, 0, 0],
    [0x3021, 1, 9], [0x1369, 1, 9],
];

/**
 * The ASCII digit a character folds to, or null. A decimal digit's value is
 * its distance from the zero of its run: Unicode encodes every set of them
 * as ten in a row, 0 to 9.
 *
 * @param {number} code
 */
const digitOf = code=>{
    const isDecimal = (/** @type {number} */ at)=>/\p{Nd}/u.test(String.fromCodePoint(at));
    if (isDecimal(code))
    {
        let start = code;
        while (isDecimal(start - 1))
        {
            start--;
        }
        return (code - start) % 10;
    }
    const run = OTHER_DIGITS.find(([first, low, high])=>
        code >= first && code <= first + high - low);
    return run ? run[1] + code - run[0] : null;
};

/**
 * FoldString's mappings over a string: the ligatures expanded, the
 * compatibility zone folded (on Windows today a compatibility normalisation,
 * which composes too), the digits made ASCII, then composed or decomposed.
 *
 * @param {string} text @param {number} flags
 */
const fold = (text, flags)=>{
    let out = text;
    if ((flags & MAP_EXPAND_LIGATURES) !== 0)
    {
        out = [...out].map(character=>LIGATURES.get(character) ?? character).join('');
    }
    if ((flags & MAP_FOLDCZONE) !== 0)
    {
        out = out.normalize('NFKC');
    }
    if ((flags & MAP_FOLDDIGITS) !== 0)
    {
        out = [...out].map(character=>{
            const digit = digitOf(/** @type {number} */ (character.codePointAt(0)));
            return digit === null ? character : String(digit);
        }).join('');
    }
    if ((flags & MAP_PRECOMPOSED) !== 0)
    {
        out = out.normalize('NFC');
    }
    return (flags & MAP_COMPOSITE) !== 0 ? out.normalize('NFD') : out;
};

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
 * finds out, where a failure sends it to its own default. The two empty
 * strings below are the locale's real answers, not placeholders.
 */
const LOCALE_STRINGS = Object.freeze({
    0x00000002: 'English (United States)', // SLANGUAGE
    0x00000003: 'ENU',                     // SABBREVLANGNAME
    0x00000004: 'English',                 // SNATIVELANGNAME
    0x00000006: 'United States',           // SCOUNTRY
    0x00000007: 'USA',                     // SABBREVCTRYNAME
    0x00000008: 'United States',           // SNATIVECTRYNAME
    0x0000000C: ',',                       // SLIST
    0x0000000E: '.',                       // SDECIMAL
    0x0000000F: ',',                       // STHOUSAND
    0x00000010: '3;0',                     // SGROUPING
    0x00000013: '0123456789',              // SNATIVEDIGITS
    0x00000014: '$',                       // SCURRENCY
    0x00000015: 'USD',                     // SINTLSYMBOL
    0x00000016: '.',                       // SMONDECIMALSEP
    0x00000017: ',',                       // SMONTHOUSANDSEP
    0x00000018: '3;0',                     // SMONGROUPING
    0x0000001D: '/',                       // SDATE
    0x0000001E: ':',                       // STIME
    0x0000001F: SHORT_DATE,                // SSHORTDATE
    0x00000020: LONG_DATE,                 // SLONGDATE
    0x00001006: YEAR_MONTH,                // SYEARMONTH
    0x00000028: 'AM',                      // S1159
    0x00000029: 'PM',                      // S2359
    // SDAYNAME1..7 and SABBREVDAYNAME1..7 start the week on Monday.
    ...Object.fromEntries([...DAYS.slice(1), DAYS[0]].flatMap((day, at)=>[
        [0x2A + at, day], [0x31 + at, day.slice(0, 3)],
    ])),
    // SMONTHNAME1..12 and SABBREVMONTHNAME1..12; the thirteenth month of a
    // twelve-month calendar is there and empty.
    ...Object.fromEntries(MONTHS.flatMap((month, at)=>[
        [0x38 + at, month], [0x44 + at, month.slice(0, 3)],
    ])),
    0x0000100E: '',                        // SMONTHNAME13
    0x0000100F: '',                        // SABBREVMONTHNAME13
    0x00000050: '',                        // SPOSITIVESIGN
    0x00000051: '-',                       // SNEGATIVESIGN
    0x00000059: 'en',                      // SISO639LANGNAME
    0x0000005A: 'US',                      // SISO3166CTRYNAME
    0x0000005C: 'en-US',                   // SNAME
    0x00001001: 'English',                 // SENGLANGUAGE
    0x00001002: 'United States',           // SENGCOUNTRY
    0x00001003: LONG_TIME,                 // STIMEFORMAT
    0x00001007: 'US Dollar',               // SENGCURRNAME
    0x00001008: 'US Dollar',               // SNATIVECURRNAME
});

/**
 * The languages a preferred-UI-language list can name, by LANGID: the one this
 * machine has, so a list naming only others is refused as naming none.
 */
const LANGUAGE_NAMES = new Map([[UI_LANGUAGE, LOCALE_STRINGS[0x0000005C]]]);

/** EnumCalendarInfo's calendars: every one, and the one this locale has. */
const ENUM_ALL_CALENDARS = 0xffffffff;
const CAL_GREGORIAN = 1;
/** CAL_NOUSEROVERRIDE, CAL_USE_CP_ACP and CAL_RETURN_NUMBER: how to answer, not what. */
const CAL_FLAGS = 0x80000000 | 0x40000000 | 0x20000000;

/**
 * The Gregorian calendar's answers by CALTYPE (winnls.h): its number and
 * name, its date pictures, its day names -- Monday first, as CAL_SDAYNAME1
 * is -- and month names, and the year a two-digit year stops before.
 *
 * @type {Readonly<Record<number, string>>}
 */
const CALENDAR_INFO = Object.freeze({
    1: '1', 2: 'Gregorian Calendar', 5: SHORT_DATE, 6: LONG_DATE, 47: YEAR_MONTH, 48: '2049',
    56: 'MMMM d', 33: '', 46: '',
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 0].flatMap((day, at)=>[
        [7 + at, DAYS[day]], [14 + at, DAYS[day].slice(0, 3)], [49 + at, DAYS[day].slice(0, 2)],
    ])),
    ...Object.fromEntries(MONTHS.flatMap((month, at)=>[
        [21 + at, month], [34 + at, month.slice(0, 3)],
    ])),
});

/**
 * The LCTYPEs whose value is a number: answered as its digits, or with
 * LOCALE_RETURN_NUMBER as the DWORD itself.
 */
const LOCALE_NUMBERS = Object.freeze({
    0x00000001: LCID_EN_US,                // ILANGUAGE
    0x00000005: 1,                         // ICOUNTRY
    0x00000009: LCID_EN_US,                // IDEFAULTLANGUAGE
    0x0000000A: 1,                         // IDEFAULTCOUNTRY
    0x0000000B: 437,                       // IDEFAULTCODEPAGE
    0x0000000D: 1,                         // IMEASURE, non-metric
    0x00000011: 2,                         // IDIGITS
    0x00000012: 1,                         // ILZERO
    0x00000019: 2,                         // ICURRDIGITS
    0x0000001A: 2,                         // IINTLCURRDIGITS
    0x0000001B: 0,                         // ICURRENCY, "$1.1"
    0x0000001C: 0,                         // INEGCURR, "($1.1)"
    0x00000021: 0,                         // IDATE, month first
    0x00000022: 0,                         // ILDATE
    0x00000023: 0,                         // ITIME, twelve hours
    0x00000024: 1,                         // ICENTURY
    0x00000025: 0,                         // ITLZERO
    0x00000026: 0,                         // IDAYLZERO
    0x00000027: 0,                         // IMONLZERO
    0x00000052: 3,                         // IPOSSIGNPOSN
    0x00000053: 0,                         // INEGSIGNPOSN
    0x00000054: 1,                         // IPOSSYMPRECEDES
    0x00000055: 0,                         // IPOSSEPBYSPACE
    0x00000056: 1,                         // INEGSYMPRECEDES
    0x00000057: 0,                         // INEGSEPBYSPACE
    0x00001004: 1252,                      // IDEFAULTANSICODEPAGE
    0x00001005: 0,                         // ITIMEMARKPOSN
    0x00001009: 1,                         // ICALENDARTYPE, Gregorian
    0x0000100A: 1,                         // IPAPERSIZE, letter
    0x0000100C: 6,                         // IFIRSTDAYOFWEEK, Sunday first
    0x0000100D: 0,                         // IFIRSTWEEKOFYEAR
    0x00001010: 1,                         // INEGNUMBER
    0x00001011: 10000,                     // IDEFAULTMACCODEPAGE
});

/** The two numbers written as hex, four digits: a language is read as one. */
const HEX_NUMBERS = [0x0001, 0x0009];

/** The byte a character outside the page becomes. */
const DEFAULT_CHAR = 0x3f;

/** @param {number} page */
const resolvePage = page=>{
    const wanted = page >>> 0;
    // CP_THREAD_ACP: the thread's locale's ANSI page, and there is one locale.
    if (wanted === CP_ACP || wanted === 3)
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
        if (found !== -1)
        {
            bytes[at] = 0x80 + found;
            continue;
        }
        // A position the page leaves undefined decodes as its own code point,
        // and goes back as its own byte.
        if (code < 0x80 + high.length && high[code - 0x80] === 0)
        {
            bytes[at] = code;
            continue;
        }
        // A table that stops short of the top of the page leaves the rest of
        // it Latin-1, exactly as decoding reads it: an accented letter is a
        // byte of its own there, not the default character.
        if (code >= 0x80 + high.length && code <= 0xff)
        {
            bytes[at] = code;
            continue;
        }
        bytes[at] = DEFAULT_CHAR;
        usedDefault = true;
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

/**
 * Text in the ANSI page, as WideCharToMultiByte(CP_ACP) writes it: what a
 * wide call's string becomes when it reaches something that reads ANSI.
 *
 * @param {string} text
 */
export const encodeAnsi = text=>encodeSingleByte(text, ANSI_PAGE).bytes;

/**
 * Bytes of the ANSI page as text, as MultiByteToWideChar(CP_ACP) reads them.
 *
 * @param {Uint8Array} bytes
 */
export const decodeAnsi = bytes=>decodeSingleByte(bytes, ANSI_PAGE);

/** Bytes of the OEM page as text, as MultiByteToWideChar(CP_OEMCP) reads them. @param {Uint8Array} bytes */
export const decodeOem = bytes=>decodeSingleByte(bytes, OEM_PAGE);

/** Text in the OEM page, as WideCharToMultiByte(CP_OEMCP) writes it. @param {string} text */
export const encodeOem = text=>encodeSingleByte(text, OEM_PAGE).bytes;

/**
 * Bytes of the ANSI page with their case changed, one byte to one byte.
 *
 * What CharUpper and CharLower do to a buffer: a byte whose mapping is not
 * itself one character of the page -- a sharp s, which Unicode uppercases to
 * two letters -- is left as it was, because a buffer being converted in place
 * has no room for it to grow.
 *
 * @param {Uint8Array} bytes @param {boolean} upper
 * @returns {Uint8Array}
 */
export const mapCaseAnsi = (bytes, upper)=>{
    const text = decodeSingleByte(bytes, ANSI_CODE_PAGE);
    const mapped = new Uint8Array(bytes.length);
    for (let at = 0; at < text.length; at++)
    {
        const character = text[at];
        const changed = upper ? character.toUpperCase() : character.toLowerCase();
        const { bytes: encoded, usedDefault } = encodeSingleByte(changed, ANSI_CODE_PAGE);
        mapped[at] = changed.length === 1 && !usedDefault ? encoded[0] : bytes[at];
    }
    return mapped;
};

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
 * @property {(address: number, unit: number) => number} stringLength
 *           The code units of a NUL-terminated string of 1- or 2-byte units
 *           before its terminator.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {() => number} [systemTimeMs]
 *           The guest wall clock, for a date or time format given no
 *           SYSTEMTIME of its own. Without it that one case fails.
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} [call]
 *           A stdcall into guest code, for an enumeration's callback. Absent,
 *           the enumerations report not implemented rather than calling.
 * @property {() => unknown} [callerThread]  Whose call a callback answers.
 * @property {(bytes: number) => number} [allocate]  Guest memory for a format
 *           string the callback reads; absent, enumerations do not call.
 * @property {(address: number) => void} [free]
 */

/**
 * @param {LocaleHost} host
 */
export function createLocaleFunctions(host){
    /**
     * The locale each thread set for itself, by thread; one slot where there
     * is no thread to tell them apart.
     *
     * @type {Map<unknown, number>}
     */
    const threadLocales = new Map();
    const threadKey = ()=>host.callerThread?.() ?? null;

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
        return { length: host.stringLength(address, unit) + 1, terminated: true };
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

    /**
     * EnumTimeFormats' and EnumDateFormats' body: each format as a
     * NUL-terminated string in guest memory, the callback called with it, and
     * the whole run stopped the moment the callback answers zero. The answer is
     * the callback's last answer, or zero when it never ran -- a null
     * callback, no allocation, no bridge.
     *
     * @param {number} proc @param {readonly string[]} formats @param {boolean} wide
     * @param {number[]} [after]  The arguments the callback takes after the text.
     * @returns {number | Promise<number>}
     */
    const enumerateFormats = (proc, formats, wide, after = [])=>{
        const call = host.call;
        const allocate = host.allocate;
        if (!call || !allocate || (proc >>> 0) === 0)
        {
            return 0;
        }
        const thread = host.callerThread?.();
        const longest = formats.reduce((max, format)=>Math.max(max, format.length), 0);
        const block = allocate((longest + 1) * (wide ? 2 : 1));
        if (block === 0)
        {
            return 0;
        }
        const run = async()=>{
            let answer = 1;
            for (const format of formats)
            {
                const text = format + String.fromCharCode(0);
                if (wide)
                {
                    writeWide(block, text);
                }
                else
                {
                    const { bytes } = encodeSingleByte(text, ANSI_CODE_PAGE);
                    host.writeMemory(block, bytes);
                }
                answer = (await call(proc >>> 0, [block, ...after], thread)) | 0;
                if (answer === 0)
                {
                    break;
                }
            }
            host.free?.(block);
            return answer;
        };
        return run();
    };

    /**
     * EnumDateFormats: the list its kind names, the code page flag set aside.
     *
     * @param {number} proc @param {number} flags @param {boolean} wide
     * @param {number[]} [after]  The arguments the callback takes after the text.
     * @returns {number | Promise<number>}
     */
    const enumerateDateFormats = (proc, flags, wide, after = [])=>{
        const kind = flags & ~LOCALE_USE_CP_ACP;
        const formats = kind === 0 || kind === DATE_SHORTDATE ? SHORT_DATE_FORMATS
            : kind === DATE_LONGDATE ? LONG_DATE_FORMATS
                : kind === DATE_YEARMONTH ? YEAR_MONTH_FORMATS : null;
        if (formats === null)
        {
            host.setLastError(ERROR_INVALID_FLAGS);
            return 0;
        }
        return enumerateFormats(proc, formats, wide, after);
    };

    /**
     * A NUMBERFMT or CURRENCYFMT read out of the guest, or the locale's own
     * picture when the caller passed none.
     *
     * @param {number} address @param {boolean} wide @param {boolean} currency
     * @returns {Readonly<NumberPicture> | null} null for a picture Windows refuses
     */
    const numberPicture = (address, wide, currency)=>{
        if (address === 0)
        {
            return currency ? CURRENCY_DEFAULTS : NUMBER_DEFAULTS;
        }
        const view = new DataView(host.readMemory(address,
            currency ? CURRENCYFMTA_SIZE : NUMBERFMTA_SIZE).slice().buffer);
        const strings = (currency ? [12, 16, 28] : [12, 16]).map(at=>view.getUint32(at, true));
        const negativeOrder = view.getUint32(20, true);
        const positiveOrder = currency ? view.getUint32(24, true) : 0;
        // A separator or symbol missing, or an order past the last there is,
        // is a picture Windows refuses.
        if (strings.includes(0) || negativeOrder > (currency ? 15 : 4) || positiveOrder > 3)
        {
            return null;
        }
        const [decimal, thousand, symbol] = strings.map(text=>
            (wide ? readWideSpan : readAnsiSpan)(text, -1));
        return {
            digits: view.getUint32(0, true),
            leadingZero: view.getUint32(4, true),
            grouping: view.getUint32(8, true),
            decimal, thousand, negativeOrder, positiveOrder, symbol,
        };
    };

    /**
     * The integer digits in groups, as a Grouping number says: its decimal
     * digits are the group sizes from the point leftwards, the last repeated
     * -- unless it is 0, which leaves the rest in one run (3 is 1,234,567;
     * 32 is 12,34,567; 30 is 1234,567).
     *
     * @param {string} whole @param {number} grouping @param {string} separator
     */
    const group = (whole, grouping, separator)=>{
        const text = String(grouping);
        const repeats = !text.endsWith('0');
        const sizes = [...(repeats ? text : text.slice(0, -1))].map(Number);
        const parts = [];
        let rest = whole;
        for (let at = 0; rest.length > 0; at++)
        {
            const size = sizes[Math.min(at, sizes.length - 1)] ?? 0;
            if (size === 0 || (!repeats && at >= sizes.length) || rest.length <= size)
            {
                parts.unshift(rest);
                break;
            }
            parts.unshift(rest.slice(rest.length - size));
            rest = rest.slice(0, rest.length - size);
        }
        return parts.join(separator);
    };

    /**
     * A number, or an amount of money, as text in the picture given.
     *
     * The value arrives as text too -- digits, one optional point, one
     * optional leading minus -- and is never turned into a float on the way:
     * a size in bytes has more digits than a double keeps. It is rounded half
     * up at the last place the picture keeps, on the digits themselves.
     *
     * @param {string} value @param {Readonly<NumberPicture>} picture
     * @param {boolean} currency
     * @returns {string | null} null when the value is not a number
     */
    const formatNumber = (value, picture, currency)=>{
        const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value);
        if (!match || match[2].length + (match[3]?.length ?? 0) === 0)
        {
            return null;
        }
        const kept = match[2].length + picture.digits;
        const all = `${match[2]}${match[3] ?? ''}`.padEnd(kept + 1, '0');
        let digits = all.slice(0, kept);
        if (all.charCodeAt(kept) >= 0x35)
        {
            // Plus one, carried through the trailing nines; past the first
            // digit it makes the number a digit longer.
            const nines = digits.length - digits.replace(/9+$/, '').length;
            const head = digits.slice(0, digits.length - nines);
            digits = `${head === '' ? '1'
                : `${head.slice(0, -1)}${Number(head[head.length - 1]) + 1}`}${'0'.repeat(nines)}`;
        }
        let whole = digits.slice(0, digits.length - picture.digits).replace(/^0+/, '');
        const fraction = digits.slice(digits.length - picture.digits);
        if (whole === '')
        {
            whole = picture.leadingZero !== 0 ? '0' : '';
        }
        whole = group(whole, picture.grouping, picture.thousand);
        const magnitude = fraction === '' ? whole : `${whole}${picture.decimal}${fraction}`;
        const negative = match[1] === '-' && /[1-9]/.test(digits);
        if (currency)
        {
            const shape = negative ? CURRENCY_NEGATIVE[picture.negativeOrder]
                : CURRENCY_POSITIVE[picture.positiveOrder ?? 0];
            return shape.replace('$', picture.symbol ?? '').replace('1', magnitude);
        }
        if (!negative)
        {
            return magnitude;
        }
        // NegativeOrder: 0 "(1.1)", 1 "-1.1", 2 "- 1.1", 3 "1.1-", 4 "1.1 -".
        switch (picture.negativeOrder)
        {
            case 0: return `(${magnitude})`;
            case 2: return `- ${magnitude}`;
            case 3: return `${magnitude}-`;
            case 4: return `${magnitude} -`;
            default: return `-${magnitude}`;
        }
    };

    /**
     * What SetLocaleInfo changed, by type: the user's own values, which
     * GetLocaleInfo answers unless LOCALE_NOUSEROVERRIDE asks past them.
     *
     * @type {Map<number, string>}
     */
    const userValues = new Map();

    /**
     * SetLocaleInfo in either width: a string the locale holds, replaced for
     * this user.
     *
     * @param {number} locale @param {number} type @param {string | null} value
     */
    const setLocaleInfo = (locale, type, value)=>{
        if (!isOurLocale(locale) || value === null)
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const wanted = type & ~LOCALE_USE_CP_ACP;
        if (/** @type {Record<number, string>} */ (LOCALE_STRINGS)[wanted] === undefined)
        {
            host.setLastError(ERROR_INVALID_FLAGS);
            return 0;
        }
        userValues.set(wanted, value);
        return 1;
    };

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
        // answers are the same one and the bit is simply ignored.
        const wanted = type & ~LOCALE_FLAGS;
        const number = /** @type {Record<number, number>} */ (LOCALE_NUMBERS)[wanted];
        const text = ((type & LOCALE_NOUSEROVERRIDE) === 0 ? userValues.get(wanted) : undefined)
            ?? /** @type {Record<number, string>} */ (LOCALE_STRINGS)[wanted];
        const genitive = (type & LOCALE_RETURN_GENITIVE_NAMES) !== 0;
        const asNumber = (type & LOCALE_RETURN_NUMBER) !== 0;
        // What the type cannot be asked for is a bad flag rather than a bad
        // parameter, and a caller that tells the two apart retries without
        // the flag: a string has no number, and only the wide form carries
        // the genitive month names.
        const refused = (number === undefined && text === undefined)
            || (asNumber && number === undefined)
            || (genitive && (!isWide || wanted < LOCALE_SMONTHNAME1
                || (wanted > LOCALE_SMONTHNAME1 + 11 && wanted !== LOCALE_SMONTHNAME13)));
        if (refused)
        {
            host.setLastError(ERROR_INVALID_FLAGS);
            return 0;
        }
        if (asNumber)
        {
            const bytes = 4;
            const needed = isWide ? bytes / 2 : bytes;
            if (count === 0)
            {
                return needed;
            }
            if (buffer === 0 || needed > count)
            {
                host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return 0;
            }
            const value = new Uint8Array(bytes);
            new DataView(value.buffer).setUint32(0, number, true);
            host.writeMemory(buffer, value);
            return needed;
        }
        const answer = text ?? (HEX_NUMBERS.includes(wanted)
            ? number.toString(16).padStart(4, '0')
            : String(number));
        return writeAnswer(answer, buffer, count, isWide);
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
            const [year, month, day] = [0, 2, 6].map(at=>view.getUint16(at, true));
            return {
                year,
                month,
                // The date's own weekday: a caller's wDayOfWeek is not read.
                weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
                day,
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
            // Text in single quotes is written as it stands, and two quotes
            // together, in or out of them, are one.
            if (picture[at] === '\'')
            {
                const quoted = /^'((?:[^']|'')*)'?/.exec(picture.slice(at)) ?? ['\'', ''];
                out += quoted[0] === '\'\'' ? '\'' : quoted[1].replace(/''/g, '\'');
                at += quoted[0].length;
                continue;
            }
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

    /** @param {number} address */
    const readLong = address=>
        new DataView(host.readMemory(address, 4).slice().buffer).getUint32(0, true);

    /** @param {number} address @param {number} value */
    const writeLong = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /**
     * What a thread said of its user interface's language: the languages
     * SetThreadPreferredUILanguages gave it, and the one SetThreadUILanguage
     * did, which wins over them.
     *
     * @type {WeakMap<object, { languages: number[], ui: number }>}
     */
    const threadLanguages = new WeakMap();
    const unthreaded = { languages: /** @type {number[]} */ ([]), ui: 0 };
    const languagesOf = ()=>{
        const thread = host.callerThread?.();
        if (!thread || typeof thread !== 'object')
        {
            return unthreaded;
        }
        const known = threadLanguages.get(thread);
        if (known)
        {
            return known;
        }
        const fresh = { languages: /** @type {number[]} */ ([]), ui: 0 };
        threadLanguages.set(thread, fresh);
        return fresh;
    };

    /** @param {number} id @param {number} flags */
    const languageText = (id, flags)=>((flags & MUI_LANGUAGE_ID) !== 0
        ? id.toString(16).toUpperCase().padStart(4, '0') : LANGUAGE_NAMES.get(id) ?? '');

    /** @param {string} text @param {number} flags @returns {number} 0 for none known */
    const languageOf = (text, flags)=>{
        if ((flags & MUI_LANGUAGE_ID) !== 0)
        {
            const id = /^[0-9a-f]{1,4}$/i.test(text) ? parseInt(text, 16) : 0;
            return LANGUAGE_NAMES.has(id) ? id : 0;
        }
        const name = text.toLowerCase();
        return [...LANGUAGE_NAMES].find(([, known])=>known.toLowerCase() === name)?.[0] ?? 0;
    };

    const BOTH_NAMINGS = MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME;

    /**
     * Only the flags a call takes, naming its languages one way at most.
     *
     * @param {number} flags @param {number} allowed
     */
    const namingFlags = (flags, allowed)=>(flags & ~allowed) === 0
        && (flags & BOTH_NAMINGS) !== BOTH_NAMINGS;

    /**
     * The answer the preferred-UI-language calls share: a multi-string, each
     * language terminated and an empty string closing the list, its size in
     * characters with every terminator counted. With no buffer and a size of
     * zero, the size and count alone; a buffer too small is refused, told the
     * size it needs.
     *
     * @param {number[]} languages @param {number} flags
     * @param {number} countAddress @param {number} buffer @param {number} sizeAddress
     * @returns {number} 0, or the Win32 error the call fails with
     */
    const answerLanguages = (languages, flags, countAddress, buffer, sizeAddress)=>{
        if (countAddress === 0 || sizeAddress === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const room = readLong(sizeAddress);
        if (buffer === 0 && room !== 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const text = languages.length === 0 ? '\0\0'
            : `${languages.map(id=>`${languageText(id, flags)}\0`).join('')}\0`;
        writeLong(sizeAddress, text.length);
        if (buffer !== 0 && room < text.length)
        {
            return ERROR_INSUFFICIENT_BUFFER;
        }
        if (buffer !== 0)
        {
            writeWide(buffer, text);
        }
        writeLong(countAddress, languages.length);
        return 0;
    };

    /**
     * The machine's languages and the user's are both the one there is.
     *
     * @param {number} allowed @returns {(args: number[]) => number}
     */
    const fixedLanguages = allowed=>([flags, count, buffer, size])=>
        (namingFlags(flags >>> 0, allowed)
            ? answerLanguages([UI_LANGUAGE], flags >>> 0, count >>> 0, buffer >>> 0, size >>> 0)
            : ERROR_INVALID_PARAMETER);
    const systemLanguages = fixedLanguages(MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME
        | MUI_MACHINE_LANGUAGE_SETTINGS);
    const userLanguages = fixedLanguages(MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME);

    /**
     * The thread's own languages; without MUI_THREAD_LANGUAGES, the user's
     * when it named none, and with the fallbacks asked for merged in after.
     *
     * @param {number[]} args
     */
    const threadPreferred = ([flags, count, buffer, size])=>{
        const asked = flags >>> 0;
        if (!namingFlags(asked, MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME | MUI_UI_FALLBACK
            | MUI_THREAD_LANGUAGES | MUI_FILTERS))
        {
            return ERROR_INVALID_PARAMETER;
        }
        const { languages } = languagesOf();
        const merged = (asked & MUI_THREAD_LANGUAGES) !== 0 ? languages
            : [...new Set(languages.length === 0 || (asked & MUI_UI_FALLBACK) !== 0
                ? [...languages, UI_LANGUAGE] : languages)];
        return answerLanguages(merged, asked, count >>> 0, buffer >>> 0, size >>> 0);
    };

    /** A Win32 answer: TRUE, or FALSE with the error for GetLastError. @param {number} error */
    const asBool = error=>{
        if (error !== 0)
        {
            host.setLastError(error);
            return 0;
        }
        return 1;
    };

    /** The same answer as ntdll's own entry gives it. @param {number} error */
    const asStatus = error=>(error === 0 ? STATUS.SUCCESS
        : error === ERROR_INSUFFICIENT_BUFFER ? STATUS.BUFFER_TOO_SMALL : STATUS.INVALID_PARAMETER);

    /** @param {number} error @returns {0} */
    const refuse = error=>{
        host.setLastError(error);
        return 0;
    };

    /**
     * The locale a name names, or 0 for one this machine does not have: no
     * name is the user's, "" the invariant locale, and
     * LOCALE_NAME_SYSTEM_DEFAULT the system's.
     *
     * @param {number} address
     */
    const localeOfName = address=>{
        if (address === 0)
        {
            return LCID_EN_US;
        }
        const name = readWideSpan(address, -1).toLowerCase();
        if (name === '')
        {
            return LOCALE_INVARIANT;
        }
        return name === LOCALE_STRINGS[0x0000005C].toLowerCase()
            || name === '!x-sys-default-locale' ? LCID_EN_US : 0;
    };

    /**
     * EnumCalendarInfo or its Ex form, at either width:
     *
     *     BOOL EnumCalendarInfo(CALINFO_ENUMPROC, LCID, CALID Calendar, CALTYPE)
     *
     * The callback is given the Gregorian calendar's answer to the CALTYPE --
     * the one calendar the locale has, so asking for another enumerates none
     * -- and the Ex form's callback the calendar's number after it.
     *
     * @param {boolean} wide @param {boolean} ex
     */
    const calendarInfo = (wide, ex)=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [proc, locale, calendar, type])=>{
            const text = CALENDAR_INFO[(type >>> 0) & ~CAL_FLAGS];
            if (!isOurLocale(locale >>> 0) || text === undefined)
            {
                return refuse(ERROR_INVALID_FLAGS);
            }
            const wanted = calendar >>> 0;
            return wanted !== ENUM_ALL_CALENDARS && wanted !== CAL_GREGORIAN ? 1
                : enumerateFormats(proc, [text], wide, ex ? [CAL_GREGORIAN] : []);
        },
    });

    /**
     * FoldString, at either width:
     *
     *     int FoldStringW(DWORD dwMapFlags, LPCWSTR lpSrcStr, int cchSrc,
     *                     LPWSTR lpDestStr, int cchDest)
     *
     * Composing, decomposing and expanding ligatures exclude one another; one
     * buffer for source and destination, no source or an empty one, and a
     * negative room are refused. The ANSI form folds the text the ANSI page
     * decodes and writes back what that page can hold of the answer.
     *
     * @param {boolean} wide
     */
    const foldString = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [flags, source, sourceChars, destination, room])=>{
            const asked = flags >>> 0;
            const exclusive = [MAP_PRECOMPOSED, MAP_COMPOSITE, MAP_EXPAND_LIGATURES]
                .filter(bit=>(asked & bit) !== 0).length;
            if (asked === 0 || (asked & ~MAP_FLAGS) !== 0 || exclusive > 1)
            {
                return refuse(ERROR_INVALID_FLAGS);
            }
            if ((source >>> 0) === 0 || (sourceChars | 0) === 0 || (room | 0) < 0
                || (source >>> 0) === (destination >>> 0))
            {
                return refuse(ERROR_INVALID_PARAMETER);
            }
            const span = sourceSpan(source >>> 0, sourceChars, wide ? 2 : 1);
            const folded = fold(wide ? readWide(source >>> 0, span.length)
                : decodeSingleByte(host.readMemory(source >>> 0, span.length), ANSI_CODE_PAGE),
            asked);
            const bytes = wide ? null : encodeSingleByte(folded, ANSI_CODE_PAGE).bytes;
            const length = bytes ? bytes.length : folded.length;
            if ((room | 0) === 0)
            {
                return length;
            }
            if (length > (room | 0))
            {
                return refuse(ERROR_INSUFFICIENT_BUFFER);
            }
            if (bytes)
            {
                host.writeMemory(destination >>> 0, bytes);
            }
            else
            {
                writeWide(destination >>> 0, folded);
            }
            return length;
        },
    });

    /**
     * GetCPInfo's CPINFO, or with a width GetCPInfoEx's CPINFOEX, for a page
     * this build converts; any other is refused.
     *
     * MaxCharSize, then DefaultChar, then the lead-byte ranges. Every page
     * here is single byte or UTF-8, so no lead-byte range is reported and the
     * array stays zero -- which is how a caller learns the page has no
     * double-byte sequences.
     *
     * @param {number} page @param {number} info @param {boolean | null} wide
     */
    const pageInfo = (page, info, wide)=>{
        const resolved = resolvePage(page);
        if (!KNOWN_PAGES.includes(resolved))
        {
            return refuse(ERROR_INVALID_PARAMETER);
        }
        const name = PAGE_NAMES[/** @type {keyof typeof PAGE_NAMES} */ (resolved)];
        const bytes = new Uint8Array(wide === null ? CPINFO_SIZE
            : CPINFOEX_NAME + MAX_PATH * (wide ? 2 : 1));
        const view = new DataView(bytes.buffer);
        view.setUint32(0, resolved === CP_UTF8 ? 4 : 1, true);
        bytes[4] = DEFAULT_CHAR;
        if (wide !== null)
        {
            view.setUint16(CPINFO_SIZE, 0xfffd, true);
            view.setUint32(CPINFO_SIZE + 2, resolved, true);
            [...name].forEach((character, at)=>(wide
                ? view.setUint16(CPINFOEX_NAME + at * 2, character.charCodeAt(0), true)
                : view.setUint8(CPINFOEX_NAME + at, character.charCodeAt(0))));
        }
        host.writeMemory(info, bytes);
        return 1;
    };

    /**
     * A date GetDateFormat takes: one of the Gregorian calendar's that
     * Windows' clock can hold, its time of day and weekday never looked at.
     *
     * @param {NonNullable<ReturnType<typeof timeOf>>} when
     */
    const isDate = when=>when.year >= 1601 && when.year <= 30827
        && when.month >= 1 && when.month <= 12 && when.day >= 1
        && when.day <= new Date(Date.UTC(when.year, when.month, 0)).getUTCDate();

    /** @param {NonNullable<ReturnType<typeof timeOf>>} when */
    const isTimeOfDay = when=>when.hour < 24 && when.minute < 60 && when.second < 60;

    /**
     * GetDateFormat or GetTimeFormat, at either width:
     *
     *     int GetDateFormatA/W(LCID, DWORD dwFlags, const SYSTEMTIME *,
     *                          LPCTSTR lpFormat, LPTSTR lpDateStr, int cchDate)
     *
     * A NULL SYSTEMTIME means now, which is the only reason this needs a clock
     * at all. A NULL format means the locale's own short or long picture,
     * chosen by the flags; a picture of the caller's comes with no flags for
     * a date, and without LOCALE_NOUSEROVERRIDE for a time.
     *
     * @param {boolean} wide @param {boolean} date
     */
    const whenFormat = (wide, date)=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [, flags, time, format, buffer, count])=>{
            const asked = flags >>> 0;
            if ((buffer >>> 0) === 0 && (count | 0) !== 0)
            {
                return refuse(ERROR_INVALID_PARAMETER);
            }
            if ((format >>> 0) !== 0 && (date ? asked : asked & LOCALE_NOUSEROVERRIDE) !== 0)
            {
                return refuse(ERROR_INVALID_FLAGS);
            }
            const when = timeOf(time >>> 0);
            if (!when || !(date ? isDate(when) : isTimeOfDay(when)))
            {
                return refuse(ERROR_INVALID_PARAMETER);
            }
            const picture = (format >>> 0) !== 0
                ? (wide ? readWideSpan : readAnsiSpan)(format >>> 0, -1)
                : date ? ((asked & DATE_LONGDATE) !== 0 ? LONG_DATE : SHORT_DATE)
                    : ((asked & TIME_NOSECONDS) !== 0 ? SHORT_TIME : LONG_TIME);
            return writeAnswer(render(picture, when), buffer >>> 0, count | 0, wide);
        },
    });

    /**
     * GetNumberFormat or GetCurrencyFormat, at either width:
     *
     *     int GetNumberFormatA/W(LCID, DWORD dwFlags, LPCTSTR lpValue,
     *         const NUMBERFMT *lpFormat, LPTSTR lpNumberStr, int cchNumber)
     *
     * The flags are LOCALE_NOUSEROVERRIDE alone, which cannot come with a
     * picture of the caller's; there is no user to override anything, so
     * otherwise they change nothing.
     *
     * @param {boolean} wide @param {boolean} currency
     */
    const amountFormat = (wide, currency)=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [locale, flags, value, format, buffer, count])=>{
            if (!isOurLocale(locale >>> 0) || ((buffer >>> 0) === 0 && (count | 0) !== 0))
            {
                return refuse(ERROR_INVALID_PARAMETER);
            }
            if ((format >>> 0) !== 0 && (flags >>> 0) !== 0)
            {
                return refuse(ERROR_INVALID_FLAGS);
            }
            const picture = numberPicture(format >>> 0, wide, currency);
            const text = picture && formatNumber(
                (wide ? readWideSpan : readAnsiSpan)(value >>> 0, -1), picture, currency);
            return text === null ? refuse(ERROR_INVALID_PARAMETER)
                : writeAnswer(text, buffer >>> 0, count | 0, wide);
        },
    });

    const table = {
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

        /**
         * GEOID GetUserGeoID(GEOCLASS GeoClass)
         *
         * The nation of the one locale installed, the United States; any other
         * class is GEOID_NOT_AVAILABLE.
         */
        GetUserGeoID: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([geoClass])=>
                ((geoClass >>> 0) === GEOCLASS_NATION ? GEOID_UNITED_STATES : -1),
        },
        GetSystemDefaultLCID: { argBytes: 0, handler: ()=>LCID_EN_US },
        GetThreadLocale: { argBytes: 0, handler: ()=>threadLocales.get(threadKey()) ?? LCID_EN_US },

        /**
         * BOOL SetThreadLocale(LCID Locale)
         *
         * The calling thread's locale, as GetThreadLocale answers it from then
         * on; the default placeholders are the one locale there is. Text is
         * still formatted as that one locale, the only one this system has
         * the data of.
         */
        SetThreadLocale: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([locale])=>{
                const asked = locale >>> 0;
                threadLocales.set(threadKey(),
                    asked === LOCALE_USER_DEFAULT || asked === LOCALE_SYSTEM_DEFAULT
                        ? LCID_EN_US : asked);
                return 1;
            },
        },

        /**
         * LCID ConvertDefaultLocale(LCID Locale)
         *
         * The two placeholders for "the default" become the one locale there
         * is; any other locale is already itself.
         */
        ConvertDefaultLocale: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([locale])=>{
                const asked = locale >>> 0;
                return asked === LOCALE_SYSTEM_DEFAULT || asked === LOCALE_USER_DEFAULT
                    || asked === 0 ? LCID_EN_US : asked;
            },
        },

        /** LANGID GetUserDefaultLangID(VOID) */
        GetUserDefaultLangID: { argBytes: 0, handler: ()=>LANGID_EN_US },

        /** LANGID GetSystemDefaultLangID(VOID) */
        GetSystemDefaultLangID: { argBytes: 0, handler: ()=>LANGID_EN_US },

        /**
         * LANGID GetSystemDefaultUILanguage(VOID)
         *
         * The language the system's own resources are in, which here is the
         * only one there is: a program that picks its strings by this must
         * land on the same table it picks its formats by. It is the loader's,
         * the one a resource lookup naming no language prefers.
         */
        GetSystemDefaultUILanguage: { argBytes: 0, handler: ()=>UI_LANGUAGE },

        /**
         * LANGID GetUserDefaultUILanguage(VOID)
         *
         * The user's choice of the same, and there is one language to choose:
         * a locale lookup by it answers what one by the user's LCID does, as
         * Wine's kernel32 locale tests (test_GetLocaleInfoA,
         * test_ConvertDefaultLocale) require of the pair.
         */
        GetUserDefaultUILanguage: { argBytes: 0, handler: ()=>UI_LANGUAGE },

        /**
         * BOOL GetSystemPreferredUILanguages(DWORD dwFlags, PULONG pulNumLanguages,
         *     PZZWSTR pwszLanguagesBuffer, PULONG pcchLanguagesBuffer)
         */
        GetSystemPreferredUILanguages: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>asBool(systemLanguages(args)),
            natives: {
                /**
                 * NTSTATUS RtlGetSystemPreferredUILanguages(DWORD, ULONG, PULONG,
                 *     PZZWSTR, PULONG): the same, with a second argument that
                 *     changes nothing.
                 */
                RtlGetSystemPreferredUILanguages: {
                    argBytes: 20,
                    /** @param {number[]} args */
                    handler: ([flags, , count, buffer, size])=>
                        asStatus(systemLanguages([flags, count, buffer, size])),
                },
            },
        },

        /**
         * BOOL GetUserPreferredUILanguages(DWORD dwFlags, PULONG pulNumLanguages,
         *     PZZWSTR pwszLanguagesBuffer, PULONG pcchLanguagesBuffer)
         */
        GetUserPreferredUILanguages: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>asBool(userLanguages(args)),
            natives: {
                /** NTSTATUS RtlGetUserPreferredUILanguages(DWORD, ULONG, PULONG, PZZWSTR, PULONG) */
                RtlGetUserPreferredUILanguages: {
                    argBytes: 20,
                    /** @param {number[]} args */
                    handler: ([flags, , count, buffer, size])=>
                        asStatus(userLanguages([flags, count, buffer, size])),
                },
            },
        },

        /**
         * BOOL GetThreadPreferredUILanguages(DWORD dwFlags, PULONG pulNumLanguages,
         *     PZZWSTR pwszLanguagesBuffer, PULONG pcchLanguagesBuffer)
         */
        GetThreadPreferredUILanguages: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>asBool(threadPreferred(args)),
            natives: {
                /** NTSTATUS RtlGetThreadPreferredUILanguages(DWORD, PULONG, PZZWSTR, PULONG) */
                RtlGetThreadPreferredUILanguages: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: args=>asStatus(threadPreferred(args)),
                },
            },
        },

        /**
         * BOOL SetThreadPreferredUILanguages(DWORD dwFlags, PCZZWSTR pwszLanguagesBuffer,
         *     PULONG pulNumLanguages)
         *
         * The languages of the list this machine knows, each once and five at
         * most, become the thread's; a list naming none of them is refused, and
         * no list or an empty one clears what the thread had.
         */
        SetThreadPreferredUILanguages: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([flags, list, count])=>{
                const asked = flags >>> 0;
                if (!namingFlags(asked, MUI_LANGUAGE_ID | MUI_LANGUAGE_NAME | MUI_FILTERS))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const named = [];
                for (let at = list >>> 0, length; at !== 0
                    && (length = host.stringLength(at, 2)) !== 0; at += (length + 1) * 2)
                {
                    named.push(readWide(at, length));
                }
                const state = languagesOf();
                const known = [...new Set(named.map(text=>languageOf(text, asked)))]
                    .filter(id=>id !== 0).slice(0, THREAD_LANGUAGE_LIMIT);
                if (named.length !== 0 && known.length === 0)
                {
                    host.setLastError(ERROR_GEN_FAILURE);
                    return 0;
                }
                state.languages = known;
                state.ui = 0;
                if (known.length !== 0 && (count >>> 0) !== 0)
                {
                    writeLong(count >>> 0, known.length);
                }
                return 1;
            },
        },

        /**
         * LANGID GetThreadUILanguage(void)
         *
         * The language SetThreadUILanguage gave the thread, else the first it
         * prefers, else the user's.
         */
        GetThreadUILanguage: {
            argBytes: 0,
            handler: ()=>{
                const { ui, languages } = languagesOf();
                return ui || (languages[0] ?? UI_LANGUAGE);
            },
        },

        /**
         * LANGID SetThreadUILanguage(LANGID LangId)
         *
         * Takes the language as the thread's and answers it; zero changes
         * nothing and answers the thread's language as it stands.
         */
        SetThreadUILanguage: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([language])=>{
                const state = languagesOf();
                if ((language & 0xffff) !== 0)
                {
                    state.ui = language & 0xffff;
                }
                return state.ui || (state.languages[0] ?? UI_LANGUAGE);
            },
        },

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

        /** BOOL SetLocaleInfoA(LCID Locale, LCTYPE LCType, LPCSTR lpLCData) */
        SetLocaleInfoA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([locale, type, data])=>setLocaleInfo(locale >>> 0, type >>> 0,
                (data >>> 0) === 0 ? null : readAnsiSpan(data >>> 0, -1)),
        },

        /** BOOL SetLocaleInfoW(LCID Locale, LCTYPE LCType, LPCWSTR lpLCData) */
        SetLocaleInfoW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([locale, type, data])=>setLocaleInfo(locale >>> 0, type >>> 0,
                (data >>> 0) === 0 ? null : readWideSpan(data >>> 0, -1)),
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
         * BOOL EnumDateFormatsA/W(DATEFMT_ENUMPROCA/W lpDateFmtEnumProc,
         *     LCID Locale, DWORD dwFlags)
         *
         * The locale's short dates (also for no kind at all), long dates or
         * year-and-month pictures, to the callback one at a time as
         * EnumTimeFormats hands out times; any other kind is ERROR_INVALID_FLAGS.
         */
        EnumDateFormatsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([proc, , flags])=>enumerateDateFormats(proc, flags >>> 0, false),
        },
        EnumDateFormatsW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([proc, , flags])=>enumerateDateFormats(proc, flags >>> 0, true),
        },

        /**
         * BOOL EnumTimeFormatsA/W(TIMEFMT_ENUMPROCA/W lpTimeFmtProc,
         *     LCID Locale, DWORD dwFlags)
         *
         * Three arguments, and the callback takes the format alone:
         * EnumTimeFormatsEx is the form with an lParam. Popping a fourth
         * argument moved the caller's stack four bytes a call, and a program
         * that enumerated twice returned to nowhere.
         *
         * The locale's time formats, handed to the program's callback one at a
         * time until it answers zero, then the answer (nonzero) returned. The
         * format travels as an ANSI or wide string in guest memory allocated
         * for it, freed after the call. A null callback, or a build without
         * the bridge to call into, is a failure rather than a silent no-op.
         */
        EnumTimeFormatsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([proc])=>enumerateFormats(proc, TIME_FORMATS, false),
        },
        EnumTimeFormatsW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([proc])=>enumerateFormats(proc, TIME_FORMATS, true),
        },

        /** GetDateFormatA/W and GetTimeFormatA/W: see whenFormat. */
        GetDateFormatA: whenFormat(false, true),
        GetDateFormatW: whenFormat(true, true),
        GetTimeFormatA: whenFormat(false, false),
        GetTimeFormatW: whenFormat(true, false),

        /** GetNumberFormatA/W and GetCurrencyFormatA/W: see amountFormat. */
        GetNumberFormatA: amountFormat(false, false),
        GetNumberFormatW: amountFormat(true, false),
        GetCurrencyFormatA: amountFormat(false, true),
        GetCurrencyFormatW: amountFormat(true, true),

        /** UINT GetOEMCP(VOID) */
        GetOEMCP: { argBytes: 0, handler: ()=>OEM_CODE_PAGE },

        /** BOOL IsDBCSLeadByte(BYTE TestChar) -- the ANSI page's own answer, which is never. */
        IsDBCSLeadByte: {
            argBytes: 4,
            handler: ()=>0,
        },

        /** BOOL GetCPInfo(UINT CodePage, LPCPINFO lpCPInfo) */
        GetCPInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([page, info])=>pageInfo(page, info >>> 0, null),
        },

        /**
         * BOOL GetCPInfoExA/W(UINT CodePage, DWORD dwFlags, LPCPINFOEX lpCPInfoEx)
         *
         * CPINFO, then the Unicode default character, the page's number and
         * its name.
         */
        GetCPInfoExA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([page, , info])=>pageInfo(page, info >>> 0, false),
        },
        GetCPInfoExW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([page, , info])=>pageInfo(page, info >>> 0, true),
        },

        /**
         * int MultiByteToWideChar(UINT CodePage, DWORD dwFlags, LPCCH lpMultiByteStr,
         *                         int cbMultiByte, LPWSTR lpWideCharStr, int cchWideChar)
         */
        MultiByteToWideChar: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([page, flags, source, sourceBytes, destination, destinationChars])=>{
                const resolved = resolvePage(page);
                // A NULL source is refused before it is measured: measuring
                // reads it, and a read of address zero is a fault where
                // Windows answers with an error code. A negative destination
                // size is refused with it, before anything is written: unlike
                // the source's, it has no "up to the terminator" meaning.
                const span = (source >>> 0) === 0
                    ? { length: 0 } : sourceSpan(source >>> 0, sourceBytes, 1);
                if (span.length === 0 || (destinationChars | 0) < 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const raw = host.readMemory(source >>> 0, span.length);
                let text;
                if (resolved === CP_UTF8)
                {
                    // With MB_ERR_INVALID_CHARS a malformed sequence fails the
                    // call rather than becoming U+FFFD, measuring included.
                    try
                    {
                        text = new TextDecoder('utf-8',
                            { fatal: (flags & MB_ERR_INVALID_CHARS) !== 0 }).decode(raw);
                    }
                    catch (e){
                        void e;
                        host.setLastError(ERROR_NO_UNICODE_TRANSLATION);
                        return 0;
                    }
                }
                else
                {
                    text = decodeSingleByte(raw, resolved);
                }

                // Zero is the measuring call, and it must not write.
                if ((destinationChars | 0) === 0)
                {
                    return text.length;
                }
                // A destination too small is filled as far as it goes and then
                // reported as too small. Both halves are the contract: a
                // program that sized a buffer from the measuring call less the
                // terminator -- a BSTR, whose own terminator sits past its
                // length -- reads the converted text back after the failure,
                // and nothing written leaves it holding an empty string.
                if (text.length > (destinationChars | 0))
                {
                    writeWide(destination >>> 0, text.slice(0, destinationChars | 0));
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
                const span = (source >>> 0) === 0
                    ? { length: 0 } : sourceSpan(source >>> 0, sourceChars, 2);
                if (span.length === 0 || (destinationBytes | 0) < 0)
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
                // Filled as far as it goes, for the reason MultiByteToWideChar
                // gives.
                if (encoded.bytes.length > (destinationBytes | 0))
                {
                    host.writeMemory(destination >>> 0,
                        encoded.bytes.subarray(0, destinationBytes | 0));
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
                if ((infoType >>> 0) !== CT_CTYPE1 || (source >>> 0) === 0 || (types >>> 0) === 0)
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
                if ((infoType >>> 0) !== CT_CTYPE1 || (source >>> 0) === 0 || (types >>> 0) === 0)
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

        /** FoldStringA/W: see foldString. */
        FoldStringA: foldString(false),
        FoldStringW: foldString(true),

        /** EnumCalendarInfoA/W and EnumCalendarInfoExA/W: see calendarInfo. */
        EnumCalendarInfoA: calendarInfo(false, false),
        EnumCalendarInfoW: calendarInfo(true, false),
        EnumCalendarInfoExA: calendarInfo(false, true),
        EnumCalendarInfoExW: calendarInfo(true, true),

        /**
         * BOOL EnumDateFormatsExEx(DATEFMT_ENUMPROCEXEX lpDateFmtEnumProcExEx,
         *     LPCWSTR lpLocaleName, DWORD dwFlags, LPARAM lParam)
         *
         * EnumDateFormatsW by the locale's name, the callback given the
         * calendar's number and the caller's lParam after each picture.
         */
        EnumDateFormatsExEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([proc, name, flags, parameter])=>(localeOfName(name >>> 0) === 0
                ? refuse(ERROR_INVALID_PARAMETER)
                : enumerateDateFormats(proc, flags >>> 0, true, [CAL_GREGORIAN, parameter >>> 0])),
        },
    };

    // GetStringTypeExA is GetStringTypeA with the locale made explicit in the
    // name: same five arguments, same answer.
    return {
        ...table,
        GetStringTypeExA: table.GetStringTypeA,

        /**
         * BOOL GetStringTypeExW(LCID Locale, DWORD dwInfoType, LPCWSTR lpSrcStr,
         *                       int cchSrc, LPWORD lpCharType)
         *
         * The Ex form keeps the locale in the W form too, so it has the A
         * form's five arguments; a wide character's type does not depend on
         * it, and the rest is GetStringTypeW.
         */
        GetStringTypeExW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, ...rest])=>table.GetStringTypeW.handler(rest),
        },
    };
}

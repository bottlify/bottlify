/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What GetLocaleInfo answers for a locale, by LCTYPE.
 *
 * Two locales are written out: en-US, the machine's own, and the invariant
 * locale, each as Windows answers them. Every other locale is read from the
 * platform's own locale data (CLDR, through Intl) the first time a program
 * asks: its names, month and day names, separators and date and time
 * pictures; its identity -- LCID, name, code pages -- from the table
 * (`locales.js`). Where the platform's data and Windows' part, Windows' is
 * taken: a group separator CLDR writes as a narrow no-break space Windows
 * writes as a no-break space. What CLDR says nothing about -- currency
 * pictures, paper size -- is en-US's.
 *
 * A number is answered as its digits, or with LOCALE_RETURN_NUMBER as the
 * DWORD itself; the two LANGIDs are four hex digits.
 */

/**
 * @typedef {import('./locales.js').Locale} Locale
 * @typedef {{ strings: Map<number, string>, numbers: Map<number, number> }} LocaleValues
 */

/** The LCTYPEs, as winnls.h numbers them. */
export const LCTYPE = Object.freeze({
    ILANGUAGE: 0x01, SLANGUAGE: 0x02, SABBREVLANGNAME: 0x03, SNATIVELANGNAME: 0x04,
    ICOUNTRY: 0x05, SCOUNTRY: 0x06, SABBREVCTRYNAME: 0x07, SNATIVECTRYNAME: 0x08,
    IDEFAULTLANGUAGE: 0x09, IDEFAULTCOUNTRY: 0x0a, IDEFAULTCODEPAGE: 0x0b, SLIST: 0x0c,
    IMEASURE: 0x0d, SDECIMAL: 0x0e, STHOUSAND: 0x0f, SGROUPING: 0x10, IDIGITS: 0x11,
    ILZERO: 0x12, SNATIVEDIGITS: 0x13, SCURRENCY: 0x14, SINTLSYMBOL: 0x15,
    SMONDECIMALSEP: 0x16, SMONTHOUSANDSEP: 0x17, SMONGROUPING: 0x18, ICURRDIGITS: 0x19,
    IINTLCURRDIGITS: 0x1a, ICURRENCY: 0x1b, INEGCURR: 0x1c, SDATE: 0x1d, STIME: 0x1e,
    SSHORTDATE: 0x1f, SLONGDATE: 0x20, IDATE: 0x21, ILDATE: 0x22, ITIME: 0x23, ICENTURY: 0x24,
    ITLZERO: 0x25, IDAYLZERO: 0x26, IMONLZERO: 0x27, S1159: 0x28, S2359: 0x29,
    SDAYNAME1: 0x2a, SABBREVDAYNAME1: 0x31, SMONTHNAME1: 0x38, SABBREVMONTHNAME1: 0x44,
    SPOSITIVESIGN: 0x50, SNEGATIVESIGN: 0x51, IPOSSIGNPOSN: 0x52, INEGSIGNPOSN: 0x53,
    IPOSSYMPRECEDES: 0x54, IPOSSEPBYSPACE: 0x55, INEGSYMPRECEDES: 0x56, INEGSEPBYSPACE: 0x57,
    SISO639LANGNAME: 0x59, SISO3166CTRYNAME: 0x5a, IGEOID: 0x5b, SNAME: 0x5c, SDURATION: 0x5d,
    SSHORTESTDAYNAME1: 0x60, SISO639LANGNAME2: 0x67, SISO3166CTRYNAME2: 0x68, SNAN: 0x69,
    SPOSINFINITY: 0x6a, SNEGINFINITY: 0x6b, SSCRIPTS: 0x6c, SPARENT: 0x6d,
    SCONSOLEFALLBACKNAME: 0x6e, SLOCALIZEDLANGUAGENAME: 0x6f, IREADINGLAYOUT: 0x70,
    INEUTRAL: 0x71, SENGLISHDISPLAYNAME: 0x72, SNATIVEDISPLAYNAME: 0x73,
    INEGATIVEPERCENT: 0x74, IPOSITIVEPERCENT: 0x75, SPERCENT: 0x76, SPERMILLE: 0x77,
    SMONTHDAY: 0x78, SSHORTTIME: 0x79, SOPENTYPELANGUAGETAG: 0x7a, SSORTLOCALE: 0x7b,
    SRELATIVELONGDATE: 0x7c, SSHORTESTAM: 0x7e, SSHORTESTPM: 0x7f,
    SENGLANGUAGE: 0x1001, SENGCOUNTRY: 0x1002, STIMEFORMAT: 0x1003,
    IDEFAULTANSICODEPAGE: 0x1004, ITIMEMARKPOSN: 0x1005, SYEARMONTH: 0x1006,
    SENGCURRNAME: 0x1007, SNATIVECURRNAME: 0x1008, ICALENDARTYPE: 0x1009, IPAPERSIZE: 0x100a,
    IOPTIONALCALENDAR: 0x100b, IFIRSTDAYOFWEEK: 0x100c, IFIRSTWEEKOFYEAR: 0x100d,
    SMONTHNAME13: 0x100e, SABBREVMONTHNAME13: 0x100f, INEGNUMBER: 0x1010,
    IDEFAULTMACCODEPAGE: 0x1011, IDEFAULTEBCDICCODEPAGE: 0x1012, SSORTNAME: 0x1013,
    IDIGITSUBSTITUTION: 0x1014,
});

const T = LCTYPE;

/** The two LCTYPEs answered as four hex digits. */
export const HEX_TYPES = Object.freeze(/** @type {number[]} */ ([T.ILANGUAGE, T.IDEFAULTLANGUAGE]));

/** The LCTYPEs whose text is a number's digits; with LOCALE_RETURN_NUMBER, the DWORD. */
const NUMBER_TYPES = new Set(/** @type {number[]} */ ([
    T.ILANGUAGE, T.ICOUNTRY, T.IDEFAULTLANGUAGE, T.IDEFAULTCOUNTRY, T.IDEFAULTCODEPAGE,
    T.IMEASURE, T.IDIGITS, T.ILZERO, T.ICURRDIGITS, T.IINTLCURRDIGITS, T.ICURRENCY, T.INEGCURR,
    T.IDATE, T.ILDATE, T.ITIME, T.ICENTURY, T.ITLZERO, T.IDAYLZERO, T.IMONLZERO,
    T.IPOSSIGNPOSN, T.INEGSIGNPOSN, T.IPOSSYMPRECEDES, T.IPOSSEPBYSPACE, T.INEGSYMPRECEDES,
    T.INEGSEPBYSPACE, T.IGEOID, T.IREADINGLAYOUT, T.INEUTRAL, T.INEGATIVEPERCENT,
    T.IPOSITIVEPERCENT, T.IDEFAULTANSICODEPAGE, T.ITIMEMARKPOSN, T.ICALENDARTYPE, T.IPAPERSIZE,
    T.IOPTIONALCALENDAR, T.IFIRSTDAYOFWEEK, T.IFIRSTWEEKOFYEAR, T.INEGNUMBER,
    T.IDEFAULTMACCODEPAGE, T.IDEFAULTEBCDICCODEPAGE, T.IDIGITSUBSTITUTION,
]));

export const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']);
export const DAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday']);

/**
 * The day and month names, by LCTYPE: SDAYNAME1..7 start the week on Monday,
 * and a twelve-month calendar's thirteenth month is there and empty.
 *
 * @param {readonly string[]} days  Sunday first. @param {readonly string[]} shortDays
 * @param {readonly string[]} shortestDays
 * @param {readonly string[]} months @param {readonly string[]} shortMonths
 * @returns {[number, string][]}
 */
const calendarNames = (days, shortDays, shortestDays, months, shortMonths)=>[
    ...[1, 2, 3, 4, 5, 6, 0].flatMap((day, at)=>/** @type {[number, string][]} */ ([
        [T.SDAYNAME1 + at, days[day]], [T.SABBREVDAYNAME1 + at, shortDays[day]],
        [T.SSHORTESTDAYNAME1 + at, shortestDays[day]],
    ])),
    ...months.flatMap((month, at)=>/** @type {[number, string][]} */ ([
        [T.SMONTHNAME1 + at, month], [T.SABBREVMONTHNAME1 + at, shortMonths[at]],
    ])),
    [T.SMONTHNAME13, ''], [T.SABBREVMONTHNAME13, ''],
];

/** en-US, as Windows answers it. @type {LocaleValues} */
const EN_US = {
    strings: new Map([
        [T.SLANGUAGE, 'English (United States)'], [T.SABBREVLANGNAME, 'ENU'],
        [T.SNATIVELANGNAME, 'English'], [T.SCOUNTRY, 'United States'],
        [T.SABBREVCTRYNAME, 'USA'], [T.SNATIVECTRYNAME, 'United States'], [T.SLIST, ','],
        [T.SDECIMAL, '.'], [T.STHOUSAND, ','], [T.SGROUPING, '3;0'],
        [T.SNATIVEDIGITS, '0123456789'], [T.SCURRENCY, '$'], [T.SINTLSYMBOL, 'USD'],
        [T.SMONDECIMALSEP, '.'], [T.SMONTHOUSANDSEP, ','], [T.SMONGROUPING, '3;0'],
        [T.SDATE, '/'], [T.STIME, ':'], [T.SSHORTDATE, 'M/d/yyyy'],
        [T.SLONGDATE, 'dddd, MMMM dd, yyyy'], [T.STIMEFORMAT, 'h:mm:ss tt'],
        [T.SSHORTTIME, 'h:mm tt'], [T.SYEARMONTH, 'MMMM, yyyy'], [T.S1159, 'AM'],
        [T.S2359, 'PM'],
        ...calendarNames(DAYS, DAYS.map(day=>day.slice(0, 3)), DAYS.map(day=>day.slice(0, 2)),
            MONTHS, MONTHS.map(month=>month.slice(0, 3))),
        [T.SPOSITIVESIGN, ''], [T.SNEGATIVESIGN, '-'], [T.SISO639LANGNAME, 'en'],
        [T.SISO3166CTRYNAME, 'US'], [T.SNAME, 'en-US'], [T.SDURATION, 'h:mm:ss'],
        [T.SISO639LANGNAME2, 'eng'], [T.SISO3166CTRYNAME2, 'USA'], [T.SNAN, 'NaN'],
        [T.SPOSINFINITY, 'Infinity'], [T.SNEGINFINITY, '-Infinity'], [T.SSCRIPTS, 'Latn;'],
        [T.SPARENT, 'en'], [T.SCONSOLEFALLBACKNAME, 'en-US'],
        [T.SLOCALIZEDLANGUAGENAME, 'English'], [T.SENGLISHDISPLAYNAME, 'English (United States)'],
        [T.SNATIVEDISPLAYNAME, 'English (United States)'], [T.SPERCENT, '%'],
        [T.SPERMILLE, '‰'], [T.SMONTHDAY, 'MMMM d'], [T.SOPENTYPELANGUAGETAG, 'ENG '],
        [T.SSORTLOCALE, 'en-US'], [T.SRELATIVELONGDATE, 'MMMM d'], [T.SSHORTESTAM, 'a'],
        [T.SSHORTESTPM, 'p'], [T.SENGLANGUAGE, 'English'], [T.SENGCOUNTRY, 'United States'],
        [T.SENGCURRNAME, 'US Dollar'], [T.SNATIVECURRNAME, 'US Dollar'], [T.SSORTNAME, 'Default'],
    ]),
    numbers: new Map([
        [T.ILANGUAGE, 0x0409], [T.ICOUNTRY, 1], [T.IDEFAULTLANGUAGE, 0x0409],
        [T.IDEFAULTCOUNTRY, 1], [T.IDEFAULTCODEPAGE, 437], [T.IMEASURE, 1], [T.IDIGITS, 2],
        [T.ILZERO, 1], [T.ICURRDIGITS, 2], [T.IINTLCURRDIGITS, 2], [T.ICURRENCY, 0],
        [T.INEGCURR, 0], [T.IDATE, 0], [T.ILDATE, 0], [T.ITIME, 0], [T.ICENTURY, 1],
        [T.ITLZERO, 0], [T.IDAYLZERO, 0], [T.IMONLZERO, 0], [T.IPOSSIGNPOSN, 3],
        [T.INEGSIGNPOSN, 0], [T.IPOSSYMPRECEDES, 1], [T.IPOSSEPBYSPACE, 0],
        [T.INEGSYMPRECEDES, 1], [T.INEGSEPBYSPACE, 0], [T.IGEOID, 244], [T.IREADINGLAYOUT, 0],
        [T.INEUTRAL, 0], [T.INEGATIVEPERCENT, 1], [T.IPOSITIVEPERCENT, 1],
        [T.IDEFAULTANSICODEPAGE, 1252], [T.ITIMEMARKPOSN, 0], [T.ICALENDARTYPE, 1],
        [T.IPAPERSIZE, 1], [T.IOPTIONALCALENDAR, 0], [T.IFIRSTDAYOFWEEK, 6],
        [T.IFIRSTWEEKOFYEAR, 0], [T.INEGNUMBER, 1], [T.IDEFAULTMACCODEPAGE, 10000],
        [T.IDEFAULTEBCDICCODEPAGE, 37], [T.IDIGITSUBSTITUTION, 1],
    ]),
};

/** The invariant locale, LOCALE_INVARIANT, as Windows answers it. @type {LocaleValues} */
const INVARIANT = {
    strings: new Map([
        ...EN_US.strings,
        [T.SLANGUAGE, 'Invariant Language (Invariant Country)'],
        [T.SENGLANGUAGE, 'Invariant Language'], [T.SABBREVLANGNAME, 'IVL'],
        [T.SNATIVELANGNAME, 'Invariant Language'], [T.SCOUNTRY, 'Invariant Country'],
        [T.SENGCOUNTRY, 'Invariant Country'], [T.SABBREVCTRYNAME, 'IVC'],
        [T.SNATIVECTRYNAME, 'Invariant Country'], [T.SCURRENCY, '¤'],
        [T.SINTLSYMBOL, 'XDR'], [T.SSHORTDATE, 'MM/dd/yyyy'], [T.SLONGDATE, 'dddd, dd MMMM yyyy'],
        [T.STIMEFORMAT, 'HH:mm:ss'], [T.SSHORTTIME, 'HH:mm'], [T.SPOSITIVESIGN, '+'],
        [T.SISO639LANGNAME, 'iv'], [T.SISO3166CTRYNAME, 'IV'],
        [T.SENGCURRNAME, 'International Monetary Fund'],
        [T.SNATIVECURRNAME, 'International Monetary Fund'], [T.SYEARMONTH, 'yyyy MMMM'],
        [T.SNAME, ''], [T.SPARENT, ''], [T.SISO639LANGNAME2, 'ivl'],
        [T.SISO3166CTRYNAME2, 'ivc'],
        [T.SENGLISHDISPLAYNAME, 'Invariant Language (Invariant Country)'],
        [T.SNATIVEDISPLAYNAME, 'Invariant Language (Invariant Country)'],
        [T.SLOCALIZEDLANGUAGENAME, 'Invariant Language'], [T.SSORTNAME, 'Math Alphanumerics'],
        [T.SCONSOLEFALLBACKNAME, ''], [T.SSORTLOCALE, ''],
    ]),
    numbers: new Map([
        ...EN_US.numbers,
        [T.ILANGUAGE, 0x007f], [T.IMEASURE, 0], [T.ILDATE, 1], [T.ITIME, 1], [T.ITLZERO, 1],
        [T.IDAYLZERO, 1], [T.IMONLZERO, 1], [T.IPAPERSIZE, 9], [T.IGEOID, 0],
    ]),
};

/** @type {Map<number, LocaleValues>} */
const cache = new Map([[0x0409, EN_US], [0x007f, INVARIANT]]);

/**
 * What a locale answers. The en-US and invariant answers are written out;
 * another locale's is read from the platform and kept.
 *
 * @param {Locale} locale
 * @returns {LocaleValues}
 */
export function localeValues(locale){
    let values = cache.get(locale.lcid);
    if (values === undefined)
    {
        values = derive(locale);
        cache.set(locale.lcid, values);
    }
    return values;
}

/** Whether an LCTYPE's answer is a number. @param {number} type */
export const isNumberType = type=>NUMBER_TYPES.has(type);

/** The CLDR group and decimal separators Windows writes otherwise. */
const SEPARATOR_FIXES = new Map([[' ', ' ']]);

/**
 * A date or time as the platform writes it in a locale, as a Windows
 * picture: day, month, year, hour, minute and second fields replaced by
 * their letters, the text between them as it stands (quoted when it holds a
 * letter a picture would read).
 *
 * @param {Intl.DateTimeFormatPart[]} parts
 * @param {Record<string, string>} letters
 */
const picture = (parts, letters)=>parts.map(part=>{
    if (part.type === 'literal')
    {
        const text = part.value.replace(/[‎‏]/g, '');
        return /[A-Za-z']/.test(text) ? `'${text.replace(/'/g, '\'\'')}'` : text;
    }
    return letters[part.type] ?? '';
}).join('');

/**
 * A locale's answers, its identity from the table and the rest from the
 * platform; en-US's where the platform has nothing to say.
 *
 * @param {Locale} locale
 * @returns {LocaleValues}
 */
function derive(locale){
    const strings = new Map(EN_US.strings);
    const numbers = new Map(EN_US.numbers);
    const tag = locale.name.split('_')[0];
    const [language, ...rest] = tag.split('-');
    const region = rest.find(part=>/^([A-Z]{2}|\d{3})$/.test(part)) ?? '';
    const parent = locale.neutral ? '' : tag.split('-').slice(0, -1).join('-');

    numbers.set(T.ILANGUAGE, locale.lcid & 0xffff);
    numbers.set(T.IDEFAULTLANGUAGE, locale.specific & 0xffff);
    numbers.set(T.IDEFAULTANSICODEPAGE, locale.ansi);
    numbers.set(T.IDEFAULTCODEPAGE, locale.oem);
    numbers.set(T.IDEFAULTMACCODEPAGE, locale.mac);
    numbers.set(T.INEUTRAL, locale.neutral ? 1 : 0);
    strings.set(T.SNAME, locale.name);
    strings.set(T.SSORTLOCALE, locale.name);
    strings.set(T.SCONSOLEFALLBACKNAME, locale.name);
    strings.set(T.SPARENT, parent);
    strings.set(T.SISO639LANGNAME, language);
    strings.set(T.SISO3166CTRYNAME, region);

    try
    {
        const intlTag = `${tag}-u-nu-latn`;
        const standard = /** @type {const} */ ({ type: 'language', languageDisplay: 'standard' });
        const english = new Intl.DisplayNames('en', standard);
        const native = new Intl.DisplayNames(tag, standard);
        const englishRegion = new Intl.DisplayNames('en', { type: 'region' });
        const nativeRegion = new Intl.DisplayNames(tag, { type: 'region' });
        const englishLanguage = english.of(language) ?? language;
        strings.set(T.SENGLANGUAGE, englishLanguage);
        strings.set(T.SLOCALIZEDLANGUAGENAME, englishLanguage);
        strings.set(T.SNATIVELANGNAME, native.of(language) ?? englishLanguage);
        strings.set(T.SLANGUAGE, english.of(tag) ?? englishLanguage);
        strings.set(T.SENGLISHDISPLAYNAME, english.of(tag) ?? englishLanguage);
        strings.set(T.SNATIVEDISPLAYNAME, native.of(tag) ?? englishLanguage);
        const country = region === '' ? '' : englishRegion.of(region) ?? region;
        strings.set(T.SENGCOUNTRY, country);
        strings.set(T.SCOUNTRY, country);
        strings.set(T.SNATIVECTRYNAME, region === '' ? '' : nativeRegion.of(region) ?? country);

        const numberParts = new Intl.NumberFormat(intlTag).formatToParts(1234567.5);
        const separator = (/** @type {string} */ type, /** @type {string} */ otherwise)=>{
            const found = numberParts.find(part=>part.type === type)?.value ?? otherwise;
            return SEPARATOR_FIXES.get(found) ?? found;
        };
        for (const [type, value] of /** @type {[number, string][]} */ ([
            [T.SDECIMAL, separator('decimal', '.')], [T.STHOUSAND, separator('group', '')],
            [T.SMONDECIMALSEP, separator('decimal', '.')],
            [T.SMONTHOUSANDSEP, separator('group', '')]]))
        {
            strings.set(type, value);
        }

        const at = (/** @type {number} */ month, /** @type {number} */ day)=>
            new Date(Date.UTC(2001, month, day, 15, 4, 5));
        const format = (/** @type {Intl.DateTimeFormatOptions} */ options, /** @type {Date} */ when)=>
            new Intl.DateTimeFormat(intlTag, { timeZone: 'UTC', ...options }).formatToParts(when);
        const field = (/** @type {Intl.DateTimeFormatPart[]} */ parts, /** @type {string} */ type)=>
            parts.find(part=>part.type === type)?.value ?? '';
        // 1 January 2001 was a Monday: the days from 7 January, a Sunday.
        const days = [0, 1, 2, 3, 4, 5, 6].map(day=>
            field(format({ weekday: 'long' }, at(0, 7 + day)), 'weekday'));
        const shortDays = [0, 1, 2, 3, 4, 5, 6].map(day=>
            field(format({ weekday: 'short' }, at(0, 7 + day)), 'weekday'));
        const shortestDays = [0, 1, 2, 3, 4, 5, 6].map(day=>
            field(format({ weekday: 'narrow' }, at(0, 7 + day)), 'weekday'));
        const months = MONTHS.map((_, month)=>
            field(format({ month: 'long' }, at(month, 1)), 'month'));
        const shortMonths = MONTHS.map((_, month)=>
            field(format({ month: 'short' }, at(month, 1)), 'month'));
        for (const [type, value] of calendarNames(days, shortDays, shortestDays, months,
            shortMonths))
        {
            strings.set(type, value);
        }
        /** The months as a date writes them, where the language declines them. */
        const genitive = MONTHS.map((_, month)=>
            field(format({ month: 'long', day: 'numeric' }, at(month, 1)), 'month'));
        if (genitive.some((name, month)=>name !== months[month]))
        {
            genitive.forEach((name, month)=>strings.set(GENITIVE + month, name));
        }

        const dateLetters = { day: 'dd', month: 'MM', year: 'yyyy' };
        const shortDate = picture(format({ year: 'numeric', month: '2-digit', day: '2-digit' },
            at(11, 31)), dateLetters);
        const longDate = picture(format({ weekday: 'long', year: 'numeric', month: 'long',
            day: 'numeric' }, at(11, 31)),
        { weekday: 'dddd', month: 'MMMM', day: 'd', year: 'yyyy' });
        const yearMonth = picture(format({ year: 'numeric', month: 'long' }, at(11, 31)),
            { month: 'MMMM', year: 'yyyy' });
        const twelve = new Intl.DateTimeFormat(intlTag, { hour: 'numeric' }).resolvedOptions()
            .hour12 === true;
        const timeParts = format({ hour: 'numeric', minute: '2-digit', second: '2-digit' },
            at(0, 1));
        const hourLetter = twelve ? 'h' : field(timeParts, 'hour').length === 2 ? 'HH' : 'H';
        const timeLetters = { hour: hourLetter, minute: 'mm', second: 'ss', dayPeriod: 'tt' };
        const longTime = picture(timeParts, timeLetters).trim();
        const shortTime = picture(format({ hour: 'numeric', minute: '2-digit' }, at(0, 1)),
            timeLetters).trim();
        strings.set(T.SSHORTDATE, shortDate);
        strings.set(T.SLONGDATE, longDate);
        strings.set(T.SYEARMONTH, yearMonth);
        strings.set(T.STIMEFORMAT, longTime);
        strings.set(T.SSHORTTIME, shortTime);
        strings.set(T.SDATE, /[^dMy']+/.exec(shortDate)?.[0] ?? '/');
        strings.set(T.STIME, /[^Hhmst' ]+/.exec(longTime)?.[0] ?? ':');
        const order = shortDate.replace(/[^dMy]/g, '').replace(/(.)\1+/g, '$1');
        numbers.set(T.IDATE, order === 'Mdy' ? 0 : order === 'dMy' ? 1 : 2);
        const longOrder = longDate.replace(/[^dMy]/g, '').replace(/(.)\1+/g, '$1');
        numbers.set(T.ILDATE, longOrder.startsWith('M') ? 0 : longOrder.startsWith('d') ? 1 : 2);
        numbers.set(T.ITIME, twelve ? 0 : 1);
        numbers.set(T.ITLZERO, hourLetter.length === 2 ? 1 : 0);
        numbers.set(T.IDAYLZERO, 1);
        numbers.set(T.IMONLZERO, 1);
        numbers.set(T.ITIMEMARKPOSN, longTime.startsWith('tt') ? 1 : 0);
        const marks = format({ hour: 'numeric', hour12: true }, new Date(Date.UTC(2001, 0, 1, 3)));
        const afternoon = format({ hour: 'numeric', hour12: true }, at(0, 1));
        strings.set(T.S1159, twelve ? field(marks, 'dayPeriod') : '');
        strings.set(T.S2359, twelve ? field(afternoon, 'dayPeriod') : '');

        const week = /** @type {{ weekInfo?: { firstDay: number, minimalDays: number } }} */ (
            /** @type {unknown} */ (new Intl.Locale(tag))).weekInfo;
        if (week !== undefined)
        {
            numbers.set(T.IFIRSTDAYOFWEEK, (week.firstDay + 6) % 7);
            numbers.set(T.IFIRSTWEEKOFYEAR,
                week.minimalDays >= 7 ? 1 : week.minimalDays >= 4 ? 2 : 0);
        }
        numbers.set(T.IMEASURE, ['US', 'LR', 'MM'].includes(region) ? 1 : 0);
        numbers.set(T.IPAPERSIZE, ['US', 'CA', 'MX', 'CL', 'CO', 'VE', 'PH', 'PR'].includes(region)
            ? 1 : 9);
    }
    catch (e){
        void e;
    }
    return { strings, numbers };
}

/**
 * Where a locale's genitive month names are kept, past the LCTYPEs: the
 * month as a date names it, which LOCALE_RETURN_GENITIVE_NAMES asks for.
 */
export const GENITIVE = 0x10000;

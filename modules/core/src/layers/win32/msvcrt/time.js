/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C time functions.
 *
 * Two clocks, and they are not the same one. `time` reports the wall clock,
 * which a program prints and stamps files with; `clock` reports how long this
 * process has been running, which a program *subtracts from itself* to measure
 * an interval. Both come from the guest's own clock rather than the host's,
 * because a frame loop that starts an interval with one and ends it with the
 * other measures the difference between two clocks instead of the time that
 * passed, and the answer can be negative.
 *
 * Local time is the runtime's time zone, which is the runtime's own state:
 * `_timezone`, `_daylight`, `_dstbias` and `_tzname`. Until anything reads
 * them for a conversion they hold what msvcrt compiles in -- Pacific time,
 * 28800 seconds west with daylight saving; `_tzset` reads TZ from the
 * runtime's environment, or, with none set, takes the machine's zone, which
 * here is UTC with no daylight saving; and the first conversion that needs
 * the zone runs it once, whatever `_tzset` a program called before. TZ is
 * "NAME[+|-]hh[:mm[:ss]][DST]", and with a DST name the zone keeps daylight
 * saving by the United States' rules.
 */

import { encodeAnsi } from '../kernel32/locale.js';
import { EINVAL, ERANGE } from './globals.js';
import { pointerWidth, wholeAddress } from '../common/pointers.js';

/** A variable's int as its export's bytes, placed before the program runs. @param {number} value */
const int32Bytes = value=>new Uint8Array(Int32Array.of(value).buffer);

const MAX_STRING = 1 << 20;

/** msvcrt's clock ticks once per millisecond, unlike most Unix runtimes. */
export const CLOCKS_PER_SEC = 1000;

/**
 * The key under which the time functions' table carries strftime, wcsftime
 * and _Strftime as the universal runtime has them, with C99's conversions;
 * a symbol, so it is no export a program could name.
 */
export const STANDARD_TIME_FORMATS = Symbol('standard time formats');

/** `struct tm`: nine ints, in this order, and the order is the layout. */
export const TM = Object.freeze({
    SEC: 0, MIN: 4, HOUR: 8, MDAY: 12, MON: 16, YEAR: 20, WDAY: 24, YDAY: 28, ISDST: 32,
    SIZE: 36,
});

/** The last second a 64-bit time_t may be: 23:59:59, 31 December 3000. */
const MAX_TIME64 = 0x793406fff;

/** How far before 1970 a gmtime still answers: half a day, for the zones east of it. */
const EARLIEST = -43200;

/** What msvcrt holds before anything reads the zone: Pacific time. */
const COMPILED_ZONE = { timezone: 28800, daylight: 1, dstbias: -3600, names: ['PST', 'PDT'] };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/** @param {number} value @param {number} width */
const pad = (value, width = 2)=>String(value).padStart(width, '0');

/**
 * The names a time is written with: what msvcrt keeps in its
 * `__lc_time_data`, here as strings. The three pictures are in the notation
 * GetDateFormat reads -- `dddd`, `MMM`, `yy`, `HH`, quoted text -- and are
 * what %x, %#x and %X expand.
 *
 * @typedef {Object} TimeNames
 * @property {string[]} shortDays  Seven, Sunday first.
 * @property {string[]} days
 * @property {string[]} shortMonths  Twelve.
 * @property {string[]} months
 * @property {string} am
 * @property {string} pm
 * @property {string} shortDate
 * @property {string} longDate
 * @property {string} time
 */

/** @type {TimeNames} The C locale's. */
export const C_TIME_NAMES = Object.freeze({
    shortDays: DAYS.map(day=>day.slice(0, 3)),
    days: DAYS,
    shortMonths: MONTHS.map(month=>month.slice(0, 3)),
    months: MONTHS,
    am: 'AM',
    pm: 'PM',
    shortDate: 'MM/dd/yy',
    longDate: 'dddd, MMMM dd, yyyy',
    time: 'HH:mm:ss',
});

/**
 * `__lc_time_data` as msvcrt.dll's callers compiled it: the 43 name
 * pointers in TimeNames' order, a pointer of the process's width each, then
 * the locale, the calendar and a reference count, the whole padded to a
 * pointer's alignment.
 */
export const lcTimeData = (/** @type {4 | 8} */ pointerSize)=>Object.freeze({
    POINTERS: 43, LCID: 43 * pointerSize, CALTYPE: 43 * pointerSize + 4,
    REFCOUNT: 43 * pointerSize + 8,
    SIZE: Math.ceil((43 * pointerSize + 12) / pointerSize) * pointerSize });

/** A 32-bit process's. */
export const LC_TIME_DATA = lcTimeData(4);

/** @param {TimeNames} names @returns {string[]} the 43 strings, in the structure's order */
const timeNameList = names=>[...names.shortDays, ...names.days, ...names.shortMonths,
    ...names.months, names.am, names.pm, names.shortDate, names.longDate, names.time];

/** @param {string[]} list @returns {TimeNames} */
const timeNamesOf = list=>({
    shortDays: list.slice(0, 7), days: list.slice(7, 14), shortMonths: list.slice(14, 26),
    months: list.slice(26, 38), am: list[38], pm: list[39], shortDate: list[40],
    longDate: list[41], time: list[42],
});

/**
 * A struct tm's fields.
 *
 * @typedef {Object} BrokenDown
 * @property {number} sec
 * @property {number} min
 * @property {number} hour
 * @property {number} mday
 * @property {number} mon
 * @property {number} year   Since 1900.
 * @property {number} wday
 * @property {number} yday
 * @property {number} isdst
 */

/**
 * A GetDateFormat picture expanded from a struct tm's fields: `d`..`dddd`,
 * `M`..`MMMM`, `yy`, `yyyy`, `h`/`hh`, `H`/`HH`, `m`/`mm`, `s`/`ss`, `t`
 * (the marker's first character), `tt`, `a` and `A` (the whole marker), text
 * in single quotes as itself (`''` a quote), and anything else as itself. A
 * run longer than the longest form leaves its extra letters in front as
 * text -- `hhh` is `h` and the hour in two digits, `ddddd` `d` and the day's
 * name -- and a lone `y` is a letter. `noZeros` drops the leading zeros, as
 * strftime's `#` flag asks. Null when a field the picture uses is out of
 * its range.
 *
 * @param {string} picture @param {BrokenDown} tm @param {TimeNames} names
 * @param {boolean} [noZeros]
 * @returns {string | null}
 */
function expandPicture(picture, tm, names, noZeros = false){
    /** @param {number} value @param {number} width */
    const number = (value, width)=>(noZeros ? String(value) : pad(value, width));
    /** @param {string} letter @param {number} run @param {number} longest */
    const extra = (letter, run, longest)=>letter.repeat(Math.max(0, run - longest));
    let text = '';
    for (let at = 0; at < picture.length;)
    {
        const letter = picture[at];
        if (letter === '\'')
        {
            const close = picture.indexOf('\'', at + 1);
            const end = close < 0 ? picture.length : close;
            text += at + 1 === end && close >= 0 ? '\'' : picture.slice(at + 1, end);
            at = end + 1;
            continue;
        }
        let run = 1;
        while (picture[at + run] === letter)
        {
            run++;
        }
        at += run;
        /** @type {string | null} */
        let field;
        switch (letter)
        {
            case 'd':
                field = run >= 3 ? dayName(tm, run >= 4 ? names.days : names.shortDays)
                    : inRange(tm.mday, 1, 31) ? number(tm.mday, run) : null;
                break;
            case 'M':
                field = run >= 3 ? monthName(tm, run >= 4 ? names.months : names.shortMonths)
                    : inRange(tm.mon, 0, 11) ? number(tm.mon + 1, run) : null;
                break;
            case 'y':
                field = run === 1 ? 'y'
                    : !inRange(tm.year, -1900, 8099) ? null
                        : run >= 4 ? String(tm.year + 1900)
                            : number((tm.year + 1900) % 100, 2);
                text += extra(letter, run, run >= 4 ? 4 : 2);
                break;
            case 'h':
                field = inRange(tm.hour, 0, 23)
                    ? number(tm.hour % 12 === 0 ? 12 : tm.hour % 12, Math.min(run, 2)) : null;
                break;
            case 'H':
                field = inRange(tm.hour, 0, 23) ? number(tm.hour, Math.min(run, 2)) : null;
                break;
            case 'm':
                field = inRange(tm.min, 0, 59) ? number(tm.min, Math.min(run, 2)) : null;
                break;
            case 's':
                field = inRange(tm.sec, 0, 59) ? number(tm.sec, Math.min(run, 2)) : null;
                break;
            case 't': case 'a': case 'A': {
                const marker = !inRange(tm.hour, 0, 23) ? null
                    : tm.hour < 12 ? names.am : names.pm;
                field = marker !== null && letter === 't' && run === 1 ? marker.slice(0, 1)
                    : marker;
                break;
            }
            default:
                field = letter.repeat(run);
        }
        if (field === null)
        {
            return null;
        }
        if ('dM'.includes(letter))
        {
            text += extra(letter, run, 4);
        }
        else if ('hHms'.includes(letter))
        {
            text += extra(letter, run, 2);
        }
        text += field;
    }
    return text;
}

/** @param {number} value @param {number} low @param {number} high */
const inRange = (value, low, high)=>value >= low && value <= high;

/** @param {BrokenDown} tm @param {string[]} list */
const dayName = (tm, list)=>(inRange(tm.wday, 0, 6) ? list[tm.wday] : null);

/** @param {BrokenDown} tm @param {string[]} list */
const monthName = (tm, list)=>(inRange(tm.mon, 0, 11) ? list[tm.mon] : null);

/**
 * ISO 8601's week of a struct tm and the year it belongs to, from its year,
 * day of the year and weekday as they are: weeks start on Monday, and the
 * first is the one with the year's first Thursday, so the first days of
 * January can be the last week of the year before, and the last of
 * December the first of the next. Null for a field out of its range.
 *
 * @param {BrokenDown} tm
 * @returns {{ year: number, week: number } | null}
 */
function isoWeek(tm){
    if (!inRange(tm.wday, 0, 6) || !inRange(tm.yday, 0, 365) || !inRange(tm.year, -1900, 8099))
    {
        return null;
    }
    const year = tm.year + 1900;
    const monday = (tm.wday + 6) % 7;
    /** Weeks in a year whose first of January falls on `first`, Monday 0. */
    const weeksIn = (/** @type {number} */ y, /** @type {number} */ first)=>
        (first === 3 || first === 2 && isLeap(y) ? 53 : 52);
    const first = ((monday - tm.yday) % 7 + 7) % 7;
    const week = Math.floor((tm.yday - monday + 10) / 7);
    if (week < 1)
    {
        const before = ((first - (isLeap(year - 1) ? 366 : 365)) % 7 + 7) % 7;
        return { year: year - 1, week: weeksIn(year - 1, before) };
    }
    if (week > weeksIn(year, first))
    {
        return { year: year + 1, week: 1 };
    }
    return { year, week };
}

/** @param {number} year */
const isLeap = year=>(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** @param {number} year @param {number} month  Zero-based. */
const daysIn = (year, month)=>[31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31,
    30, 31][month];

/**
 * Seconds since 1970 of a date and time, each field allowed past its range
 * and carried, as mktime normalises: a year below 100 is that year, not 1900
 * and it.
 *
 * @param {number} year  The full year.
 * @param {number} mon @param {number} mday @param {number} hour @param {number} min
 * @param {number} sec
 */
function utcSeconds(year, mon, mday, hour, min, sec){
    const when = new Date(0);
    when.setUTCFullYear(year, mon, mday);
    when.setUTCHours(hour, min, sec, 0);
    return when.getTime() / 1000;
}

/**
 * A second since 1970, broken down in UTC.
 *
 * @param {number} seconds @param {number} [isdst]
 * @returns {BrokenDown}
 */
function breakDown(seconds, isdst = 0){
    const when = new Date(seconds * 1000);
    const year = when.getUTCFullYear();
    return {
        sec: when.getUTCSeconds(),
        min: when.getUTCMinutes(),
        hour: when.getUTCHours(),
        mday: when.getUTCDate(),
        mon: when.getUTCMonth(),
        year: year - 1900,
        wday: when.getUTCDay(),
        yday: Math.round((utcSeconds(year, when.getUTCMonth(), when.getUTCDate(), 0, 0, 0)
            - utcSeconds(year, 0, 1, 0, 0, 0)) / 86400),
        isdst,
    };
}

/**
 * asctime's text of a struct tm, as msvcrt makes it from the fields
 * themselves: the day of the week and the month named, the rest as two
 * digits, the year as four characters each a digit's code past '0' -- the
 * first may be past '9', a year past 9999 wrapping -- and null for a field
 * out of its range, a day the month has not, or a year before 1900.
 *
 * @param {BrokenDown} tm
 * @returns {string | null}
 */
export function asctime(tm){
    if (tm.wday < 0 || tm.wday > 6 || tm.mon < 0 || tm.mon > 11 || tm.year < 0
        || tm.mday < 1 || tm.mday > daysIn(tm.year + 1900, tm.mon)
        || tm.hour < 0 || tm.hour > 23 || tm.min < 0 || tm.min > 59 || tm.sec < 0 || tm.sec > 59)
    {
        return null;
    }
    const year = tm.year + 1900;
    const digits = [Math.floor(year / 1000), Math.floor(year / 100) % 10,
        Math.floor(year / 10) % 10, year % 10].map(value=>String.fromCharCode(0x30 + value & 0xff))
        .join('');
    return `${DAYS[tm.wday].slice(0, 3)} ${MONTHS[tm.mon].slice(0, 3)} ${pad(tm.mday)}`
        + ` ${pad(tm.hour)}:${pad(tm.min)}:${pad(tm.sec)} ${digits}\n`;
}

/**
 * strftime's text of a struct tm, with the names and pictures of a locale --
 * the C locale's unless others are given, as `_Strftime` gives them. Each
 * conversion reads the fields as they are, unnormalised: the 30th of
 * February is written as such, the weekday is `tm_wday` and the day of the
 * year `tm_yday`. The `#` flag is msvcrt's: `%#c` and `%#x` are the long
 * date, and on a number it drops the leading zeros. Null -- EINVAL, and
 * nothing written -- for a conversion msvcrt does not know (C99's `%e`,
 * `%D`, `%T`... among them), a field the conversion reads out of its range,
 * or no struct at all when a conversion needs one; a format of plain text
 * reads no struct.
 *
 * `standard` is the universal runtime's strftime, which knows C99's too:
 * `%C %D %e %F %g %G %h %n %r %R %t %T %u %V %z`, and the `E` and `O`
 * modifiers, which the C locale has no other form for and so ignores.
 *
 * @param {string} format
 * @param {BrokenDown | null} tm
 * @param {TimeNames} [names]
 * @param {boolean} [standard]
 * @returns {string | null}
 */
export function strftime(format, tm, names = C_TIME_NAMES, standard = false){
    let alternate = false;
    /** @param {number} value @param {number} low @param {number} high @param {number} [width] */
    const number = (value, low, high, width = 2)=>(inRange(value, low, high)
        ? (alternate ? String(value) : pad(value, width)) : null);
    /** The week of the year, its weeks starting on `firstDay`. @param {number} firstDay */
    const week = firstDay=>(/** @param {BrokenDown} t */ t=>(inRange(t.wday, 0, 6)
        && inRange(t.yday, 0, 365)
        ? number(Math.floor((t.yday + 7 - (t.wday - firstDay + 7) % 7) / 7), 0, 53) : null));

    /** @type {Record<string, (tm: BrokenDown) => string | null>} */
    const fields = {
        a: t=>dayName(t, names.shortDays),
        A: t=>dayName(t, names.days),
        b: t=>monthName(t, names.shortMonths),
        B: t=>monthName(t, names.months),
        c: t=>{
            const date = fields.x(t);
            const time = date === null ? null : fields.X(t);
            return time === null ? null : `${date} ${time}`;
        },
        d: t=>number(t.mday, 1, 31),
        H: t=>number(t.hour, 0, 23),
        I: t=>(inRange(t.hour, 0, 23) ? number(t.hour % 12 === 0 ? 12 : t.hour % 12, 1, 12)
            : null),
        j: t=>number(t.yday + 1, 1, 366, 3),
        m: t=>number(t.mon + 1, 1, 12),
        M: t=>number(t.min, 0, 59),
        p: t=>(!inRange(t.hour, 0, 23) ? null : t.hour < 12 ? names.am : names.pm),
        S: t=>number(t.sec, 0, 59),
        U: week(0),
        w: t=>(inRange(t.wday, 0, 6) ? String(t.wday) : null),
        W: week(1),
        x: t=>expandPicture(alternate ? names.longDate : names.shortDate, t, names),
        X: t=>expandPicture(names.time, t, names),
        y: t=>number((t.year + 1900) % 100, 0, 99),
        Y: t=>(inRange(t.year, -1900, 8099) ? String(t.year + 1900) : null),
        Z: ()=>'UTC',
    };
    /**
     * Each C99 field from the ones above, so `#` reaches what they read:
     * `%#D` is "1/1/70".
     *
     * @param {string} picture
     * @returns {(tm: BrokenDown) => string | null}
     */
    const composed = picture=>t=>{
        let out = '';
        for (const part of picture.split(/(%[a-zA-Z])/))
        {
            const value = part.startsWith('%') ? fields[part[1]](t) : part;
            if (value === null)
            {
                return null;
            }
            out += value;
        }
        return out;
    };
    if (standard)
    {
        Object.assign(fields, {
            C: (/** @type {BrokenDown} */ t)=>(inRange(t.year, -1900, 8099)
                ? number(Math.floor((t.year + 1900) / 100), 0, 99) : null),
            D: composed('%m/%d/%y'),
            e: (/** @type {BrokenDown} */ t)=>(!inRange(t.mday, 1, 31) ? null
                : alternate ? String(t.mday) : String(t.mday).padStart(2, ' ')),
            F: composed('%Y-%m-%d'),
            g: (/** @type {BrokenDown} */ t)=>{
                const iso = isoWeek(t);
                return iso === null ? null : number(iso.year % 100, 0, 99);
            },
            G: (/** @type {BrokenDown} */ t)=>{
                const iso = isoWeek(t);
                return iso === null ? null : String(iso.year);
            },
            h: fields.b,
            n: ()=>'\n',
            r: composed('%I:%M:%S %p'),
            R: composed('%H:%M'),
            t: ()=>'\t',
            T: composed('%H:%M:%S'),
            u: (/** @type {BrokenDown} */ t)=>(inRange(t.wday, 0, 6) ? String(t.wday || 7) : null),
            V: (/** @type {BrokenDown} */ t)=>{
                const iso = isoWeek(t);
                return iso === null ? null : number(iso.week, 1, 53);
            },
            // The engine's clock is UTC.
            z: ()=>'+0000',
        });
    }

    let text = '';
    for (let at = 0; at < format.length; at++)
    {
        if (format[at] !== '%')
        {
            text += format[at];
            continue;
        }
        alternate = format[at + 1] === '#';
        if (alternate)
        {
            at++;
        }
        if (standard && (format[at + 1] === 'E' || format[at + 1] === 'O'))
        {
            at++;
        }
        const letter = format[++at];
        if (letter === '%')
        {
            text += '%';
            continue;
        }
        const field = Object.hasOwn(fields, letter) ? fields[letter] : null;
        const value = field === null || tm === null ? null : field(tm);
        if (value === null)
        {
            return null;
        }
        text += value;
    }
    return text;
}

/**
 * TZ's reading: three letters of the standard name, the offset west of UTC
 * as hours, minutes and seconds with a sign, and after it the name of
 * daylight time -- whose first character `_daylight` is set to, as msvcrt
 * sets it, zero for none.
 *
 * @param {string} tz
 */
export function parseTz(tz){
    let at = Math.min(3, tz.length);
    const standard = tz.slice(0, at);
    let sign = 1;
    if (tz[at] === '-' || tz[at] === '+')
    {
        sign = tz[at] === '-' ? -1 : 1;
        at++;
    }
    /** @returns {number} */
    const number = ()=>{
        let value = 0;
        while (tz[at] >= '0' && tz[at] <= '9')
        {
            value = value * 10 + Number(tz[at]);
            at++;
        }
        return value;
    };
    let seconds = number() * 3600;
    if (tz[at] === ':')
    {
        at++;
        seconds += number() * 60;
        if (tz[at] === ':')
        {
            at++;
            seconds += number();
        }
    }
    const daylight = at < tz.length ? tz.charCodeAt(at) : 0;
    return { timezone: sign * seconds, daylight, names: [standard, tz.slice(at, at + 3)] };
}

/**
 * Whether a moment of standard local time is in daylight time by the United
 * States' rules: from 2:00 on the second Sunday of March to 2:00 on the first
 * Sunday of November.
 *
 * @param {number} local  Standard local time, seconds since 1970.
 */
function inDaylightTime(local){
    const year = new Date(local * 1000).getUTCFullYear();
    /** The nth Sunday of a month at 2:00. @param {number} month @param {number} nth */
    const sunday = (month, nth)=>{
        const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
        return utcSeconds(year, month, 1 + (7 - first) % 7 + (nth - 1) * 7, 2, 0, 0);
    };
    return local >= sunday(2, 2) && local < sunday(10, 1) - 3600;
}

/**
 * @typedef {Object} TimeHost
 * @property {import('../common/guest.js').Guest} guest  The process's memory, read
 *           and written in place at its pointer width (`host.guest`).
 * @property {(bytes: number) => number} allocate
 * @property {() => number} systemTimeMs  Guest wall clock, milliseconds since 1970.
 * @property {() => number} now           Guest running time, milliseconds.
 * @property {import('./float.js').FloatHost} [fpu]
 * @property {(name: string) => string | null} [getenv]
 *           The runtime's environment, where `_tzset` finds TZ.
 * @property {(name: string) => number} [addressOf]
 *           Where the runtime's own export of that name was placed: the zone's
 *           variables are rewritten there as `_tzset` changes them.
 * @property {(name: string, initial?: number) => number} [cell]
 *           An int of the runtime's own, for an accessor when the export's
 *           own address is not to be had.
 * @property {(code: number) => void} [errno]
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *           The high half of a 64-bit time_t answer, in EDX. Absent, the
 *           64-bit calls that answer one stay unexported.
 */

/**
 * @param {TimeHost} host
 */
export function createTimeFunctions(host){
    const { guest } = host;
    const { pointerSize } = guest;

    /**
     * A time_t read through a pointer, each width's: a 32-bit one signed, a
     * 64-bit one whole.
     *
     * @type {Record<'time32At' | 'time64At', (pointer: number) => number>}
     */
    const times = {
        time32At: pointer=>guest.i32(wholeAddress(pointer)),
        time64At: pointer=>Number(guest.i64(wholeAddress(pointer))),
    };
    const { time32At, time64At } = times;

    /**
     * Text where it lies, in the ANSI page a format is read in or in UTF-16,
     * its terminator after it.
     *
     * @type {Record<'ansi' | 'utf16', (pointer: number, text: string) => void>}
     */
    const put = {
        ansi: (pointer, text)=>void guest.writeAnsi(wholeAddress(pointer), text),
        utf16: (pointer, text)=>void guest.writeWide(wholeAddress(pointer), text),
    };

    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
        return code;
    };

    /**
     * The static results. Every one of these functions documents that its
     * answer is overwritten by the next call, and code copies it out at once.
     */
    let tmBlock = 0;
    let textBlock = 0;
    let wideBlock = 0;
    const staticTm = ()=>(tmBlock === 0 ? (tmBlock = host.allocate(TM.SIZE)) : tmBlock);
    const staticText = ()=>(textBlock === 0 ? (textBlock = host.allocate(64)) : textBlock);
    /** The wide functions' own buffer, as msvcrt keeps one apart from the narrow. */
    const staticWide = ()=>(wideBlock === 0 ? (wideBlock = host.allocate(128)) : wideBlock);

    /** @param {number} block @param {BrokenDown} tm */
    const writeTm = (block, tm)=>{
        guest.set32s(wholeAddress(block), [tm.sec, tm.min, tm.hour, tm.mday, tm.mon, tm.year,
            tm.wday, tm.yday, tm.isdst]);
        return block;
    };

    /** @param {number} block @returns {BrokenDown} */
    const readTm = block=>{
        const at = (/** @type {number} */ offset)=>guest.i32(wholeAddress(block) + offset);
        return { sec: at(TM.SEC), min: at(TM.MIN), hour: at(TM.HOUR), mday: at(TM.MDAY),
            mon: at(TM.MON), year: at(TM.YEAR), wday: at(TM.WDAY), yday: at(TM.YDAY),
            isdst: at(TM.ISDST) };
    };

    /** The struct tm strftime reads, or null for none. @param {number} block */
    const tmAt = block=>(wholeAddress(block) === 0 ? null : readTm(block));

    /** strftime of the wall clock's moment, for the fixed forms. @param {string} format */
    const stampOf = format=>strftime(format,
        breakDown(Math.floor(host.systemTimeMs() / 1000))) ?? '';

    /**
     * The strftime family's ending: the text and its length when it fits
     * in `max` with its terminator; otherwise an empty string where there
     * is room for one and zero -- EINVAL for a format refused or no buffer,
     * ERANGE for text too long.
     *
     * @param {number} destination @param {number} max @param {string | null} text
     * @param {(pointer: number, text: string) => void} write
     */
    const finishFormat = (destination, max, text, write)=>{
        if (wholeAddress(destination) === 0 || (max >>> 0) === 0)
        {
            fail(EINVAL);
            return 0;
        }
        if (text === null || text.length + 1 > (max >>> 0))
        {
            write(destination, '');
            fail(text === null ? EINVAL : ERANGE);
            return 0;
        }
        write(destination, text);
        return text.length;
    };

    /**
     * The names an `__lc_time_data` in guest memory points at: its first
     * fields, a pointer of the process's width each.
     *
     * @param {number} block
     * @returns {TimeNames}
     */
    const readTimeNames = block=>timeNamesOf(Array.from({ length: LC_TIME_DATA.POINTERS },
        (_, at)=>{
            const pointer = guest.ptr(wholeAddress(block) + at * pointerSize);
            return pointer === 0 ? '' : guest.cstr(pointer, 256);
        }));

    /** strftime, msvcrt's or with C99's conversions. @param {boolean} standard */
    const strftimeEntry = standard=>({
        convention: 'cdecl',
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([destination, max, format, block])=>{
            const text = wholeAddress(format) === 0 ? null
                : strftime(guest.cstr(wholeAddress(format), MAX_STRING), tmAt(block),
                    C_TIME_NAMES, standard);
            return finishFormat(destination, max, text, put.ansi);
        },
    });

    /** wcsftime, likewise. @param {boolean} standard */
    const wcsftimeEntry = standard=>({
        convention: 'cdecl',
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([destination, max, format, block])=>{
            const text = wholeAddress(format) === 0 ? null
                : strftime(guest.wstr(wholeAddress(format), MAX_STRING * 2), tmAt(block),
                    C_TIME_NAMES, standard);
            return finishFormat(destination, max, text, put.utf16);
        },
    });

    /** _Strftime, likewise. @param {boolean} standard */
    const namedStrftimeEntry = standard=>({
        convention: 'cdecl',
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([destination, max, format, block, timeNames])=>{
            const text = wholeAddress(format) === 0 ? null
                : strftime(guest.cstr(wholeAddress(format), MAX_STRING), tmAt(block),
                    wholeAddress(timeNames) === 0 ? C_TIME_NAMES : readTimeNames(timeNames),
                    standard);
            return finishFormat(destination, max, text, put.ansi);
        },
    });

    /**
     * Text on the heap for the caller to free, in the ANSI page; null when
     * there is no room.
     *
     * @param {string} text
     */
    const publishText = text=>{
        const address = host.allocate(encodeAnsi(text).length + 1);
        if (address !== 0)
        {
            put.ansi(address, text);
        }
        return address;
    };

    /** What a secure call leaves in a struct tm it refuses: every field -1. */
    const INVALID_TM = { sec: -1, min: -1, hour: -1, mday: -1, mon: -1, year: -1, wday: -1,
        yday: -1, isdst: -1 };

    // ---- the zone ----

    /** @type {Map<string, number>} */
    const ownCells = new Map();
    /** @param {string} name */
    const cellOf = name=>{
        if (host.cell)
        {
            return host.cell(name);
        }
        if (!ownCells.has(name))
        {
            ownCells.set(name, host.allocate(4));
        }
        return /** @type {number} */ (ownCells.get(name));
    };

    /**
     * Where each variable is read from: its export's own address, or its
     * cell -- for `_tzname`, the array of its two names.
     *
     * @param {string} name
     */
    const home = name=>(host.addressOf?.(name) ?? 0)
        || (name === '_tzname' ? names() : cellOf(name));

    /**
     * The array of the two names, a pointer of the process's width each, and
     * the two names' buffers after it, 64 bytes each as msvcrt keeps them.
     */
    let nameBuffers = 0;
    /** Where each of the two names' buffers is, past the array. @param {0 | 1} which */
    const nameAt = which=>nameBuffers + 2 * pointerSize + which * 64;
    const names = ()=>{
        if (nameBuffers === 0)
        {
            nameBuffers = host.allocate(2 * pointerSize + 128);
            if (nameBuffers !== 0)
            {
                guest.setPtr(nameBuffers, nameAt(0));
                guest.setPtr(nameBuffers + pointerSize, nameAt(1));
                put.ansi(nameAt(0), COMPILED_ZONE.names[0]);
                put.ansi(nameAt(1), COMPILED_ZONE.names[1]);
            }
        }
        return nameBuffers;
    };

    let started = false;
    /** The variables as compiled in, in their cells, the first time any is asked for. */
    const startZone = ()=>{
        if (started)
        {
            return;
        }
        started = true;
        names();
        for (const [name, value] of /** @type {[string, number][]} */ ([
            ['_timezone', COMPILED_ZONE.timezone], ['_daylight', COMPILED_ZONE.daylight],
            ['_dstbias', COMPILED_ZONE.dstbias]]))
        {
            guest.set32(cellOf(name), value);
        }
    };

    /** @param {string} name @param {number} value */
    const setVariable = (name, value)=>{
        startZone();
        for (const at of new Set([host.addressOf?.(name) ?? 0, cellOf(name)]))
        {
            if (at !== 0)
            {
                guest.set32(at, value);
            }
        }
    };

    /** @param {string} name */
    const variable = name=>{
        startZone();
        return guest.i32(home(name));
    };

    /** _tzset: TZ read again, or the machine's zone -- UTC, no daylight time. */
    const tzset = ()=>{
        const tz = host.getenv?.('TZ') ?? '';
        const zone = tz === '' ? { timezone: 0, daylight: 0, names: ['UTC', 'UTC'] }
            : parseTz(tz);
        setVariable('_timezone', zone.timezone);
        setVariable('_daylight', zone.daylight);
        if (names() !== 0)
        {
            guest.writeAnsi(nameAt(0), zone.names[0], 64);
            guest.writeAnsi(nameAt(1), zone.names[1], 64);
        }
    };

    /** The zone a conversion uses: read from TZ once, the first time one needs it. */
    let zoneRead = false;
    const zone = ()=>{
        if (!zoneRead)
        {
            zoneRead = true;
            tzset();
        }
        return { timezone: variable('_timezone'), daylight: variable('_daylight') !== 0,
            dstbias: variable('_dstbias') };
    };

    /**
     * A time broken down in local time.
     *
     * @param {number} seconds
     * @returns {BrokenDown}
     */
    const toLocal = seconds=>{
        const { timezone, daylight, dstbias } = zone();
        const standard = seconds - timezone;
        if (daylight && inDaylightTime(standard))
        {
            return breakDown(standard - dstbias, 1);
        }
        return breakDown(standard, 0);
    };

    /**
     * mktime's reading of a struct tm as local time, normalised: the time,
     * and the fields as they then are.
     *
     * @param {BrokenDown} tm
     */
    const fromLocal = tm=>{
        const { timezone, daylight, dstbias } = zone();
        const standard = utcSeconds(tm.year + 1900, tm.mon, tm.mday, tm.hour, tm.min, tm.sec);
        const dst = daylight && (tm.isdst > 0 || (tm.isdst < 0 && inDaylightTime(standard)));
        const seconds = standard + timezone + (dst ? dstbias : 0);
        return { seconds, tm: toLocal(seconds) };
    };

    /**
     * gmtime's answer for a 32-bit time_t: -1 and a time more than half a day
     * before 1970 are refused; one within that half day is 1 January 1970 at
     * a negative hour, as msvcrt breaks it down.
     *
     * @param {number} seconds
     * @returns {BrokenDown | null}
     */
    const gmtime32 = seconds=>{
        if (seconds === -1 || seconds < EARLIEST)
        {
            return null;
        }
        if (seconds < 0)
        {
            return { sec: seconds % 60, min: Math.trunc(seconds / 60) % 60,
                hour: Math.trunc(seconds / 3600), mday: 1, mon: 0, year: 70, wday: 4, yday: 0,
                isdst: 0 };
        }
        return breakDown(seconds);
    };

    /** @param {number} seconds */
    const gmtime64 = seconds=>(seconds < EARLIEST || seconds > MAX_TIME64 + 46800 ? null
        : breakDown(seconds));

    /** localtime's range: from 1970 to the end of the year 3000. @param {number} seconds */
    const localtimeOf = seconds=>(seconds < 0 || seconds > MAX_TIME64 ? null : toLocal(seconds));

    /**
     * A conversion into the static struct tm, from a time_t read through a
     * pointer: null for no pointer or a time refused.
     *
     * @param {(pointer: number) => number} read
     * @param {(seconds: number) => BrokenDown | null} convert
     */
    const intoStatic = (read, convert)=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [pointer])=>{
            const tm = wholeAddress(pointer) === 0 ? null : convert(read(pointer));
            if (!tm)
            {
                fail(EINVAL);
                return 0;
            }
            return writeTm(staticTm(), tm);
        },
    });

    /**
     * The secure form, into the caller's struct tm: EINVAL for no struct, and
     * for no time or a time refused with every field -1.
     *
     * @param {(pointer: number) => number} read
     * @param {(seconds: number) => BrokenDown | null} convert
     */
    const intoCaller = (read, convert)=>({
        convention: 'cdecl',
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [block, pointer])=>{
            if (wholeAddress(block) === 0)
            {
                return fail(EINVAL);
            }
            const tm = wholeAddress(pointer) === 0 ? null : convert(read(pointer));
            writeTm(block, tm ?? INVALID_TM);
            return tm ? 0 : fail(EINVAL);
        },
    });

    /**
     * mktime and _mkgmtime: the struct normalised and written back, the time
     * answered -- -1 for one before 1970 or past the time_t's range.
     *
     * @param {(tm: BrokenDown) => { seconds: number, tm: BrokenDown }} read
     * @param {number} most
     */
    const makeTime = (read, most)=>{
        /** @param {number} block */
        return block=>{
            const { seconds, tm } = read(readTm(block));
            if (!Number.isFinite(seconds) || seconds < 0 || seconds > most)
            {
                return -1;
            }
            writeTm(block, tm);
            return seconds;
        };
    };

    /** @param {BrokenDown} tm */
    const fromUtc = tm=>{
        const seconds = utcSeconds(tm.year + 1900, tm.mon, tm.mday, tm.hour, tm.min, tm.sec);
        return { seconds, tm: breakDown(seconds) };
    };

    const mktime32 = makeTime(fromLocal, 0x7fffffff);
    const mktime64 = makeTime(fromLocal, MAX_TIME64);
    const mkgmtime32 = makeTime(fromUtc, 0x7fffffff);
    const mkgmtime64 = makeTime(fromUtc, MAX_TIME64);

    /**
     * An answer in EDX:EAX, for the 64-bit calls.
     *
     * @param {number} value
     */
    const answer64 = value=>{
        const wide = BigInt(Math.trunc(value));
        host.setRegisters?.({ edx: Number(BigInt.asUintN(32, wide >> 32n)) });
        return Number(BigInt.asUintN(32, wide));
    };

    /**
     * ctime's text for a time read through a pointer, into the buffer it
     * shares with asctime; null for a time localtime refuses. `wide`: _wctime's,
     * UTF-16 into the buffer it shares with _wasctime.
     *
     * @param {(pointer: number) => number} read
     * @param {boolean} [wide]
     */
    const ctime = (read, wide = false)=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [pointer])=>{
            const tm = wholeAddress(pointer) === 0 ? null : localtimeOf(read(pointer));
            const text = tm ? asctime(tm) : null;
            if (text === null)
            {
                fail(EINVAL);
                return 0;
            }
            const buffer = wide ? staticWide() : staticText();
            (wide ? put.utf16 : put.ansi)(buffer, text);
            return buffer;
        },
    });

    /**
     * The secure ctime: into a buffer of at least 26 bytes.
     *
     * @param {(pointer: number) => number} read
     */
    const ctimeInto = read=>({
        convention: 'cdecl',
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [buffer, size, pointer])=>{
            if (wholeAddress(buffer) === 0 || (size >>> 0) === 0)
            {
                return fail(EINVAL);
            }
            guest.set8(wholeAddress(buffer), 0);
            if (wholeAddress(pointer) === 0)
            {
                return fail(EINVAL);
            }
            const tm = localtimeOf(read(pointer));
            const text = tm ? asctime(tm) : null;
            if (text === null)
            {
                return fail(EINVAL);
            }
            if ((size >>> 0) < text.length + 1)
            {
                return fail(ERANGE);
            }
            put.ansi(buffer, text);
            return 0;
        },
    });

    /**
     * _strdate_s and _strtime_s: nine bytes at least, the buffer emptied and
     * ERANGE where fewer are given.
     *
     * @param {string} format
     */
    const stampInto = format=>({
        convention: 'cdecl',
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [buffer, size])=>{
            if (wholeAddress(buffer) === 0 || (size >>> 0) === 0)
            {
                return fail(EINVAL);
            }
            if ((size >>> 0) < 9)
            {
                guest.set8(wholeAddress(buffer), 0);
                return fail(ERANGE);
            }
            put.ansi(buffer, stampOf(format));
            return 0;
        },
    });

    /**
     * An accessor of a zone variable: its export's own address, or its cell.
     *
     * @param {string} name
     */
    const accessor = name=>({
        convention: 'cdecl',
        returns: 'pointer',
        argBytes: 0,
        handler: ()=>{
            startZone();
            return home(name);
        },
    });

    /**
     * _get_timezone and its kin: the variable through a pointer, EINVAL for none.
     *
     * @param {string} name
     */
    const getter = name=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [out])=>{
            if (wholeAddress(out) === 0)
            {
                return fail(EINVAL);
            }
            guest.set32(wholeAddress(out), variable(name));
            return 0;
        },
    });


    /** The wall clock in whole seconds. */
    const seconds = ()=>Math.floor(host.systemTimeMs() / 1000);

    /** time_t time(time_t *destination) */
    const time32 = {
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [destination])=>{
            const now = seconds();
            if (wholeAddress(destination) !== 0)
            {
                guest.set32(wholeAddress(destination), now);
            }
            return now | 0;
        },
    };

    /** double difftime(time_t later, time_t earlier) -- only with the FPU seam */
    const difftime = host.fpu
        ? {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [later, earlier])=>{
                // Signed: a caller subtracts in the order it chose, and a
                // negative difference is a meaningful answer rather than a
                // wrapped one.
                host.fpu?.setResult((later | 0) - (earlier | 0));
                return 0;
            },
        }
        : null;

    /** double _difftime64(__time64_t later, __time64_t earlier) -- only with the FPU seam */
    const difftime64 = host.fpu
        ? {
            convention: 'cdecl',
            argBytes: 16,
            quadwords: [0, 2],
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [laterLow, laterHigh, earlierLow, earlierHigh])=>{
                host.fpu?.setResult(((laterHigh | 0) - (earlierHigh | 0)) * 0x100000000
                    + (laterLow >>> 0) - (earlierLow >>> 0));
                return 0;
            },
        }
        : null;

    /**
     * `_ftime` for a 32- or 64-bit time_t.
     *
     * @param {boolean} wide
     */
    function timeb(wide){
        return {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [result])=>{
                const milliseconds = host.systemTimeMs();
                const now = Math.floor(milliseconds / 1000);
                const local = toLocal(now);
                const block = wholeAddress(result);
                const at = wide ? 8 : 4;
                if (wide)
                {
                    guest.set64(block, BigInt(now));
                }
                else
                {
                    guest.set32(block, now);
                }
                guest.set16(block + at, Math.floor(milliseconds) % 1000);
                guest.set16(block + at + 2, Math.trunc(zone().timezone / 60) & 0xffff);
                guest.set16(block + at + 4, local.isdst & 0xffff);
                // The tail the compiler pads the struct with.
                guest.set16(block + at + 6, 0);
                return 0;
            },
        };
    }

    const sixtyFour = host.setRegisters
        ? {
            /** __time64_t _time64(__time64_t *destination) */
            _time64: {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: (/** @type {number[]} */ [destination])=>{
                    if (wholeAddress(destination) !== 0)
                    {
                        guest.set64(wholeAddress(destination), BigInt(seconds()));
                    }
                    return answer64(seconds());
                },
            },

            /** __time64_t _mktime64(struct tm *broken) */
            _mktime64: {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: (/** @type {number[]} */ [block])=>answer64(mktime64(block)),
            },

            /** __time64_t _mkgmtime64(struct tm *broken) */
            _mkgmtime64: {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: (/** @type {number[]} */ [block])=>answer64(mkgmtime64(block)),
            },
        }
        : {};

    return {
        ...(difftime ? { difftime } : {}),
        ...(difftime64 ? { _difftime64: difftime64, _difftime32: difftime } : {}),
        ...sixtyFour,

        time: time32,
        _time32: time32,

        /** clock_t clock(void) */
        clock: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>Math.floor(host.now()) | 0,
        },

        /** struct tm *localtime(const time_t *), and the 32- and 64-bit spellings */
        localtime: { ...intoStatic(time32At, localtimeOf), returns: 'pointer' },
        _localtime32: intoStatic(time32At, localtimeOf),
        _localtime64: intoStatic(time64At, localtimeOf),
        /** errno_t _localtime32_s(struct tm *, const __time32_t *), and the 64-bit one */
        _localtime32_s: intoCaller(time32At, localtimeOf),
        _localtime64_s: intoCaller(time64At, localtimeOf),

        /** struct tm *gmtime(const time_t *), and the 32- and 64-bit spellings */
        gmtime: { ...intoStatic(time32At, gmtime32), returns: 'pointer' },
        _gmtime32: intoStatic(time32At, gmtime32),
        _gmtime64: intoStatic(time64At, gmtime64),
        _gmtime32_s: intoCaller(time32At, gmtime32),
        _gmtime64_s: intoCaller(time64At, gmtime64),

        /**
         * time_t mktime(struct tm *broken), and _mktime32
         *
         * Normalising is the part that gets used: a caller adds thirty to
         * tm_mday and expects the month to roll over.
         */
        mktime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [block])=>mktime32(block) | 0,
        },
        _mktime32: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [block])=>mktime32(block) | 0,
        },

        /** time_t _mkgmtime(struct tm *broken): mktime in UTC, whatever tm_isdst says. */
        _mkgmtime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [block])=>mkgmtime32(block) | 0,
        },
        _mkgmtime32: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [block])=>mkgmtime32(block) | 0,
        },

        /** char *ctime(const time_t *), and the 32- and 64-bit spellings */
        ctime: { ...ctime(time32At), returns: 'pointer' },
        _ctime32: ctime(time32At),
        _ctime64: ctime(time64At),
        /** wchar_t *_wctime(const time_t *), and the 32- and 64-bit spellings */
        _wctime: { ...ctime(time32At, true), returns: 'pointer' },
        _wctime32: ctime(time32At, true),
        _wctime64: ctime(time64At, true),
        /** errno_t _ctime32_s(char *, size_t, const __time32_t *), and the 64-bit one */
        _ctime32_s: ctimeInto(time32At),
        _ctime64_s: ctimeInto(time64At),

        /** char *asctime(const struct tm *): null and EINVAL for a struct it refuses */
        asctime: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                const text = wholeAddress(block) === 0 ? null : asctime(readTm(block));
                if (text === null)
                {
                    fail(EINVAL);
                    return 0;
                }
                const buffer = staticText();
                put.ansi(buffer, text);
                return buffer;
            },
        },

        /**
         * size_t strftime(char *dest, size_t max, const char *format,
         *                 const struct tm *broken)
         *
         * A result that does not fit is not truncated: the buffer is left
         * empty and the answer is zero, as for a format refused. A caller
         * cannot tell an overflow from an empty format, which is a defect in
         * the interface rather than here.
         */
        strftime: { ...strftimeEntry(false) },

        /**
         * size_t wcsftime(wchar_t *dest, size_t max, const wchar_t *format,
         *                 const struct tm *broken)
         *
         * strftime's text in UTF-16, `max` in characters, and an empty string
         * when it does not fit.
         */
        wcsftime: { ...wcsftimeEntry(false) },

        /**
         * size_t _Strftime(char *dest, size_t max, const char *format,
         *                  const struct tm *broken, void *timeNames)
         *
         * strftime with the names of an `__lc_time_data` -- one `_Gettnames`
         * made, say -- in place of the current locale's; null is the current
         * locale's.
         */
        _Strftime: { ...namedStrftimeEntry(false) },

        // The universal runtime's, which knows C99's conversions too.
        [STANDARD_TIME_FORMATS]: {
            strftime: strftimeEntry(true),
            wcsftime: wcsftimeEntry(true),
            _Strftime: namedStrftimeEntry(true),
        },

        /**
         * char *_Getdays(void) and char *_Getmonths(void)
         *
         * The current locale's names on the heap, for the caller to free, as
         * the runtime spells them: each short name and its long one after a
         * colon -- ":Sun:Sunday:Mon:Monday..." -- null when there is no room.
         */
        _Getdays: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>publishText(C_TIME_NAMES.shortDays
                .map((name, at)=>`:${name}:${C_TIME_NAMES.days[at]}`).join('')),
        },
        _Getmonths: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>publishText(C_TIME_NAMES.shortMonths
                .map((name, at)=>`:${name}:${C_TIME_NAMES.months[at]}`).join('')),
        },

        /**
         * void *_Gettnames(void)
         *
         * A copy of the current locale's `__lc_time_data` on the heap, its
         * strings in the same block after it, so the one free the caller
         * makes releases it all.
         */
        _Gettnames: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const layout = lcTimeData(pointerSize);
                const strings = timeNameList(C_TIME_NAMES);
                const size = layout.SIZE
                    + strings.reduce((total, name)=>total + encodeAnsi(name).length + 1, 0);
                const block = host.allocate(size);
                if (block === 0)
                {
                    return 0;
                }
                let at = block + layout.SIZE;
                strings.forEach((text, index)=>{
                    guest.setPtr(block + index * pointerSize, at);
                    at += guest.writeAnsi(at, text) + 1;
                });
                // The C locale is LCID zero, its calendar the Gregorian (1).
                guest.set32s(block + layout.LCID, [0, 1, 0]);
                guest.fill(block + layout.REFCOUNT + 4, 0, layout.SIZE - layout.REFCOUNT - 4);
                return block;
            },
        },

        /** char *_strdate(char *buffer) -- exactly nine bytes, "MM/DD/YY" */
        _strdate: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                put.ansi(buffer, stampOf('%m/%d/%y'));
                return buffer;
            },
        },

        /** char *_strtime(char *buffer) -- exactly nine bytes, "HH:MM:SS" */
        _strtime: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                put.ansi(buffer, stampOf('%H:%M:%S'));
                return buffer;
            },
        },

        /** wchar_t *_wstrdate(wchar_t *buffer) */
        _wstrdate: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                put.utf16(buffer, stampOf('%m/%d/%y'));
                return buffer;
            },
        },

        /** wchar_t *_wstrtime(wchar_t *buffer) */
        _wstrtime: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                put.utf16(buffer, stampOf('%H:%M:%S'));
                return buffer;
            },
        },

        /** errno_t _strdate_s(char *buffer, size_t size) / _strtime_s */
        _strdate_s: stampInto('%m/%d/%y'),
        _strtime_s: stampInto('%H:%M:%S'),

        /**
         * void _ftime(struct _timeb *result)
         *
         * struct _timeb is { time_t time; unsigned short millitm; short
         * timezone; short dstflag; } -- the four-byte seconds first, then three
         * shorts, and the compiler pads the tail to twelve bytes. The zone's
         * minutes west and whether it is in daylight time now.
         */
        _ftime: timeb(false),

        /**
         * void _ftime64(struct __timeb64 *result)
         *
         * `_ftime` with the seconds an __int64: the shorts follow at 8, and
         * the whole is padded to sixteen bytes.
         */
        _ftime64: timeb(true),

        /** void _tzset(void): the zone from TZ, or the machine's. */
        _tzset: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                tzset();
                return 0;
            },
        },

        /**
         * long *__p__timezone(void), int *__p__daylight(void),
         * long *__p__dstbias(void), char **__p__tzname(void), and the
         * later spellings without the __p
         */
        __p__timezone: { ...accessor('_timezone'), returns: 'pointer' },
        __p__daylight: accessor('_daylight'),
        __p__dstbias: accessor('_dstbias'),
        __p__tzname: accessor('_tzname'),
        __timezone: accessor('_timezone'),
        __daylight: accessor('_daylight'),
        __dstbias: accessor('_dstbias'),

        /** errno_t _get_timezone(long *), _get_daylight(int *), _get_dstbias(long *) */
        _get_timezone: getter('_timezone'),
        _get_daylight: getter('_daylight'),
        _get_dstbias: getter('_dstbias'),

        /**
         * long _timezone, int _daylight, long _dstbias, char *_tzname[2]
         *
         * Variables, as msvcrt compiles them in until the zone is read.
         */
        _timezone: { data: ()=>int32Bytes(COMPILED_ZONE.timezone) },
        _daylight: { data: ()=>int32Bytes(COMPILED_ZONE.daylight) },
        _dstbias: { data: ()=>int32Bytes(COMPILED_ZONE.dstbias) },
        // The two pointers at the process's width.
        _tzname: {
            data: ()=>(names() === 0 ? new Uint8Array(2 * pointerSize)
                : pointerWidth(pointerSize).array([nameAt(0), nameAt(1)])
                    .subarray(0, 2 * pointerSize)),
        },

        // A 64-bit process's time_t is an __int64: its plain names are the
        // 64-bit forms, as its msvcrt exports them (Wine's msvcrt.spec, its
        // win64 entries), and a 32-bit time read there was half of one.
        ...pointerSize === 8 ? {
            localtime: { ...intoStatic(time64At, localtimeOf), returns: 'pointer' },
            gmtime: { ...intoStatic(time64At, gmtime64), returns: 'pointer' },
            ctime: { ...ctime(time64At), returns: 'pointer' },
            _wctime: { ...ctime(time64At, true), returns: 'pointer' },
            _ftime: timeb(true),
            ...difftime64 ? { difftime: difftime64 } : {},
            ...host.setRegisters ? {
                time: sixtyFour._time64,
                mktime: sixtyFour._mktime64,
                _mkgmtime: sixtyFour._mkgmtime64,
            } : {},
        } : {},
    };
}

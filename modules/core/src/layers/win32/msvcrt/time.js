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

const MAX_STRING = 1 << 20;

/** msvcrt's clock ticks once per millisecond, unlike most Unix runtimes. */
export const CLOCKS_PER_SEC = 1000;

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
 * @param {string} format
 * @param {Date} when
 */
export function strftime(format, when){
    const dayOfYear = Math.floor(
        (Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate())
            - Date.UTC(when.getUTCFullYear(), 0, 1)) / 86400000);
    /** @param {number} firstDay */
    const weekOfYear = firstDay=>pad(Math.floor(
        (dayOfYear + 7 - (when.getUTCDay() - firstDay + 7) % 7) / 7));

    /** @type {Record<string, () => string>} */
    const fields = {
        a: ()=>DAYS[when.getUTCDay()].slice(0, 3),
        A: ()=>DAYS[when.getUTCDay()],
        b: ()=>MONTHS[when.getUTCMonth()].slice(0, 3),
        B: ()=>MONTHS[when.getUTCMonth()],
        c: ()=>`${fields.x()} ${fields.X()}`,
        d: ()=>pad(when.getUTCDate()),
        H: ()=>pad(when.getUTCHours()),
        I: ()=>pad(when.getUTCHours() % 12 === 0 ? 12 : when.getUTCHours() % 12),
        j: ()=>pad(dayOfYear + 1, 3),
        m: ()=>pad(when.getUTCMonth() + 1),
        M: ()=>pad(when.getUTCMinutes()),
        p: ()=>(when.getUTCHours() < 12 ? 'AM' : 'PM'),
        S: ()=>pad(when.getUTCSeconds()),
        U: ()=>weekOfYear(0),
        w: ()=>String(when.getUTCDay()),
        W: ()=>weekOfYear(1),
        x: ()=>`${pad(when.getUTCMonth() + 1)}/${pad(when.getUTCDate())}`
            + `/${pad(when.getUTCFullYear() % 100)}`,
        X: ()=>`${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`
            + `:${pad(when.getUTCSeconds())}`,
        y: ()=>pad(when.getUTCFullYear() % 100),
        Y: ()=>String(when.getUTCFullYear()),
        Z: ()=>'UTC',
        '%': ()=>'%',
    };

    let text = '';
    for (let at = 0; at < format.length; at++)
    {
        if (format[at] !== '%' || at + 1 === format.length)
        {
            text += format[at];
            continue;
        }
        const field = fields[format[++at]];
        // An unknown specifier is undefined behaviour; msvcrt drops it, and
        // dropping keeps the rest of the string in the positions the caller
        // laid out.
        text += field ? field() : '';
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
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
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
    /** @param {number} pointer @param {number} value */
    const writeInt = (pointer, value)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(pointer, bytes);
    };

    /** @param {number} pointer */
    const readInt = pointer=>
        new DataView(host.readMemory(pointer, 4).slice().buffer).getInt32(0, true);

    /** A 64-bit time_t. @param {number} pointer */
    const readTime64 = pointer=>Number(new DataView(host.readMemory(pointer, 8).slice().buffer)
        .getBigInt64(0, true));

    /** In the ANSI page a format is read in. @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        host.writeMemory(pointer, encodeAnsi(`${text}\0`));
    };

    /** @param {number} pointer @param {string} text */
    const writeWide = (pointer, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        [...text].forEach((c, at)=>new DataView(bytes.buffer).setUint16(at * 2, c.charCodeAt(0),
            true));
        host.writeMemory(pointer, bytes);
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
    const staticTm = ()=>(tmBlock === 0 ? (tmBlock = host.allocate(TM.SIZE)) : tmBlock);
    const staticText = ()=>(textBlock === 0 ? (textBlock = host.allocate(64)) : textBlock);

    /** @param {number} block @param {BrokenDown} tm */
    const writeTm = (block, tm)=>{
        const bytes = new Uint8Array(TM.SIZE);
        const view = new DataView(bytes.buffer);
        [tm.sec, tm.min, tm.hour, tm.mday, tm.mon, tm.year, tm.wday, tm.yday, tm.isdst]
            .forEach((value, index)=>view.setInt32(index * 4, value, true));
        host.writeMemory(block, bytes);
        return block;
    };

    /** @param {number} block @returns {BrokenDown} */
    const readTm = block=>{
        const view = new DataView(host.readMemory(block, TM.SIZE).slice().buffer);
        const at = (/** @type {number} */ offset)=>view.getInt32(offset, true);
        return { sec: at(TM.SEC), min: at(TM.MIN), hour: at(TM.HOUR), mday: at(TM.MDAY),
            mon: at(TM.MON), year: at(TM.YEAR), wday: at(TM.WDAY), yday: at(TM.YDAY),
            isdst: at(TM.ISDST) };
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

    /** The two names' buffers, 64 bytes each as msvcrt keeps them, and the array of the two. */
    let nameBuffers = 0;
    const names = ()=>{
        if (nameBuffers === 0)
        {
            nameBuffers = host.allocate(136);
            if (nameBuffers !== 0)
            {
                const pointers = new Uint8Array(8);
                new DataView(pointers.buffer).setUint32(0, nameBuffers + 8, true);
                new DataView(pointers.buffer).setUint32(4, nameBuffers + 72, true);
                host.writeMemory(nameBuffers, pointers);
                writeString(nameBuffers + 8, COMPILED_ZONE.names[0]);
                writeString(nameBuffers + 72, COMPILED_ZONE.names[1]);
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
            writeInt(cellOf(name), value);
        }
    };

    /** @param {string} name @param {number} value */
    const setVariable = (name, value)=>{
        startZone();
        for (const at of new Set([host.addressOf?.(name) ?? 0, cellOf(name)]))
        {
            if (at !== 0)
            {
                writeInt(at, value);
            }
        }
    };

    /** @param {string} name */
    const variable = name=>{
        startZone();
        return readInt(home(name));
    };

    /** _tzset: TZ read again, or the machine's zone -- UTC, no daylight time. */
    const tzset = ()=>{
        const tz = host.getenv?.('TZ') ?? '';
        const zone = tz === '' ? { timezone: 0, daylight: 0, names: ['UTC', 'UTC'] }
            : parseTz(tz);
        setVariable('_timezone', zone.timezone);
        setVariable('_daylight', zone.daylight);
        const buffers = names();
        if (buffers !== 0)
        {
            writeString(buffers + 8, zone.names[0].slice(0, 63));
            writeString(buffers + 72, zone.names[1].slice(0, 63));
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
            const tm = (pointer >>> 0) === 0 ? null : convert(read(pointer));
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
            if ((block >>> 0) === 0)
            {
                return fail(EINVAL);
            }
            const tm = (pointer >>> 0) === 0 ? null : convert(read(pointer));
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
     * shares with asctime; null for a time localtime refuses.
     *
     * @param {(pointer: number) => number} read
     */
    const ctime = read=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [pointer])=>{
            const tm = (pointer >>> 0) === 0 ? null : localtimeOf(read(pointer));
            const text = tm ? asctime(tm) : null;
            if (text === null)
            {
                fail(EINVAL);
                return 0;
            }
            const buffer = staticText();
            writeString(buffer, text);
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
            if ((buffer >>> 0) === 0 || (size >>> 0) === 0)
            {
                return fail(EINVAL);
            }
            host.writeMemory(buffer, new Uint8Array(1));
            if ((pointer >>> 0) === 0)
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
            writeString(buffer, text);
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
            if ((buffer >>> 0) === 0 || (size >>> 0) === 0)
            {
                return fail(EINVAL);
            }
            if ((size >>> 0) < 9)
            {
                host.writeMemory(buffer, new Uint8Array(1));
                return fail(ERANGE);
            }
            writeString(buffer, strftime(format, new Date(host.systemTimeMs())));
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
            if ((out >>> 0) === 0)
            {
                return fail(EINVAL);
            }
            writeInt(out, variable(name));
            return 0;
        },
    });

    /** @param {number} value */
    const dword = value=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value, true);
        return bytes;
    };

    /** The wall clock in whole seconds. */
    const seconds = ()=>Math.floor(host.systemTimeMs() / 1000);

    /** time_t time(time_t *destination) */
    const time32 = {
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [destination])=>{
            const now = seconds();
            writeInt(destination, now);
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

    const sixtyFour = host.setRegisters
        ? {
            /** __time64_t _time64(__time64_t *destination) */
            _time64: {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: (/** @type {number[]} */ [destination])=>{
                    if ((destination >>> 0) !== 0)
                    {
                        const bytes = new Uint8Array(8);
                        new DataView(bytes.buffer).setBigInt64(0, BigInt(seconds()), true);
                        host.writeMemory(destination, bytes);
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
        localtime: intoStatic(readInt, localtimeOf),
        _localtime32: intoStatic(readInt, localtimeOf),
        _localtime64: intoStatic(readTime64, localtimeOf),
        /** errno_t _localtime32_s(struct tm *, const __time32_t *), and the 64-bit one */
        _localtime32_s: intoCaller(readInt, localtimeOf),
        _localtime64_s: intoCaller(readTime64, localtimeOf),

        /** struct tm *gmtime(const time_t *), and the 32- and 64-bit spellings */
        gmtime: intoStatic(readInt, gmtime32),
        _gmtime32: intoStatic(readInt, gmtime32),
        _gmtime64: intoStatic(readTime64, gmtime64),
        _gmtime32_s: intoCaller(readInt, gmtime32),
        _gmtime64_s: intoCaller(readTime64, gmtime64),

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
        ctime: ctime(readInt),
        _ctime32: ctime(readInt),
        _ctime64: ctime(readTime64),
        /** errno_t _ctime32_s(char *, size_t, const __time32_t *), and the 64-bit one */
        _ctime32_s: ctimeInto(readInt),
        _ctime64_s: ctimeInto(readTime64),

        /** char *asctime(const struct tm *): null and EINVAL for a struct it refuses */
        asctime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                const text = (block >>> 0) === 0 ? null : asctime(readTm(block));
                if (text === null)
                {
                    fail(EINVAL);
                    return 0;
                }
                const buffer = staticText();
                writeString(buffer, text);
                return buffer;
            },
        },

        /**
         * size_t strftime(char *dest, size_t max, const char *format,
         *                 const struct tm *broken)
         *
         * Nothing is written when the result would not fit, and the answer is
         * zero -- not a truncated string. A caller cannot tell an overflow from
         * an empty format, which is a defect in the interface rather than here.
         */
        strftime: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, max, format, block])=>{
                const tm = readTm(block);
                const when = new Date(utcSeconds(tm.year + 1900, tm.mon, tm.mday, tm.hour,
                    tm.min, tm.sec) * 1000);
                const text = strftime(host.readCString(format, MAX_STRING), when);
                if (text.length + 1 > (max >>> 0))
                {
                    return 0;
                }
                writeString(destination, text);
                return text.length;
            },
        },

        /** char *_strdate(char *buffer) -- exactly nine bytes, "MM/DD/YY" */
        _strdate: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                writeString(buffer, strftime('%m/%d/%y', new Date(host.systemTimeMs())));
                return buffer;
            },
        },

        /** char *_strtime(char *buffer) -- exactly nine bytes, "HH:MM:SS" */
        _strtime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                writeString(buffer, strftime('%H:%M:%S', new Date(host.systemTimeMs())));
                return buffer;
            },
        },

        /** wchar_t *_wstrdate(wchar_t *buffer) */
        _wstrdate: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                writeWide(buffer, strftime('%m/%d/%y', new Date(host.systemTimeMs())));
                return buffer;
            },
        },

        /** wchar_t *_wstrtime(wchar_t *buffer) */
        _wstrtime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                writeWide(buffer, strftime('%H:%M:%S', new Date(host.systemTimeMs())));
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
        _ftime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([result])=>{
                const milliseconds = host.systemTimeMs();
                const now = Math.floor(milliseconds / 1000);
                const local = toLocal(now);
                const bytes = new Uint8Array(12);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, now, true);
                view.setUint16(4, Math.floor(milliseconds) % 1000, true);
                view.setInt16(6, Math.trunc(zone().timezone / 60), true);
                view.setInt16(8, local.isdst, true);
                host.writeMemory(result, bytes);
                return 0;
            },
        },

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
        __p__timezone: accessor('_timezone'),
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
        _timezone: { data: ()=>dword(COMPILED_ZONE.timezone) },
        _daylight: { data: ()=>dword(COMPILED_ZONE.daylight) },
        _dstbias: { data: ()=>dword(COMPILED_ZONE.dstbias) },
        _tzname: {
            data: ()=>{
                const buffers = names();
                const bytes = new Uint8Array(8);
                new DataView(bytes.buffer).setUint32(0, buffers === 0 ? 0 : buffers + 8, true);
                new DataView(bytes.buffer).setUint32(4, buffers === 0 ? 0 : buffers + 72, true);
                return bytes;
            },
        },
    };
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's dates and times, and the Format functions, in the English
 * (United States) locale: M/D/YYYY, a twelve-hour clock, "$" and "," and
 * ".", the week starting on Sunday.
 *
 * A Date is an automation date (`oleaut32/dates.js`), which before 30
 * December 1899 is not linear -- -1.25 is six in the morning of the 29th --
 * so arithmetic on one goes through its calendar fields or its count of
 * seconds, never its raw number. The clock is the embedder's: Now is its
 * local time, to the second.
 */

import { VAR_DATEVALUEONLY, VAR_TIMEVALUEONLY, dateOf, fieldsOf } from '../oleaut32/dates.js';
import { dateFromText, textOfDate } from '../oleaut32/vartext.js';
import { ForeignValue, wallTimeToOleDate } from '../script/values.js';
import { VT_DATE } from '../oleaut32/vartypes.js';
import { VBRuntimeError } from './errors.js';
import { define } from './builtins.js';
import {
    checkedDate, date, integer, long, single, toDate, toDouble, toLong, toStr,
} from './values.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('./interpreter.js').Interpreter} Interpreter
 * @typedef {import('./builtins.js').BuiltinHost} BuiltinHost
 * @typedef {import('../oleaut32/dates.js').Fields} Fields
 */

const DAY_MS = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
    'Saturday'];

/**
 * A Date's calendar fields, or error 5 for a day no Date can name.
 *
 * @param {number} day @returns {Fields}
 */
function fields(day){
    const found = fieldsOf(day);
    if (found === null)
    {
        throw new VBRuntimeError(5);
    }
    return found;
}

/**
 * A Date as seconds from 30 December 1899, which is linear where the Date
 * is not.
 *
 * @param {number} day @returns {number}
 */
function secondsOf(day){
    const whole = Math.trunc(day);
    return whole * 86400 + Math.round(Math.abs(day - whole) * 86400);
}

/** @param {number} seconds @returns {number} the Date those seconds make */
const fromSeconds = seconds=>dateOf({ year: 1899, month: 12, day: 30, hour: 0, minute: 0,
    second: seconds });

/** @param {number} day @returns {number} the whole day a Date is in, counted linearly */
const dayCount = day=>Math.floor(secondsOf(day) / 86400);

/**
 * The first day of the week an argument names: 1 (Sunday) to 7, 0 for the
 * system's, which is Sunday here.
 *
 * @param {Value} value @returns {number} 0 for Sunday to 6
 */
function firstDay(value){
    const n = value === undefined ? 1 : toLong(value);
    if (n < 0 || n > 7)
    {
        throw new VBRuntimeError(5);
    }
    return n === 0 ? 0 : n - 1;
}

/**
 * The weekday of a Date counted from the first day of the week, from 1.
 *
 * @param {number} day @param {number} first  0 for Sunday.
 */
const weekday = (day, first)=>((fields(day).dayOfWeek - first + 7) % 7) + 1;

/**
 * The week of the year a Date is in, as DatePart's "ww" counts: from the
 * week holding 1 January, the first with four days, or the first whole one.
 *
 * @param {number} day @param {number} first @param {number} rule  1, 2 or 3.
 * @returns {number}
 */
function weekOfYear(day, first, rule){
    const { year } = fields(day);
    /** @param {number} y @returns {number} the day the year's first week starts */
    const start = y=>{
        const jan1 = dateOf({ year: y, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const back = (fields(jan1).dayOfWeek - first + 7) % 7;
        const weekStart = jan1 - back;
        if (rule === 2)
        {
            return 7 - back >= 4 ? weekStart : weekStart + 7;
        }
        if (rule === 3)
        {
            return back === 0 ? weekStart : weekStart + 7;
        }
        return weekStart;
    };
    const today = dayCount(day);
    let from = start(year);
    if (today < from)
    {
        from = start(year - 1);
    }
    else if (rule !== 1 && today >= start(year + 1))
    {
        from = start(year + 1);
    }
    return Math.floor((today - from) / 7) + 1;
}

/**
 * The clock as the script reads it: local time.
 *
 * @param {BuiltinHost} host @returns {number} milliseconds since 1970 on the local wall clock
 */
const localNow = host=>{
    const utc = host.now();
    return utc + host.localOffset(utc);
};

/**
 * A number spelled as GetNumberFormat spells it for the English locale.
 *
 * @param {number} n @param {number} digits  Places after the point.
 * @param {boolean} leading  A zero before a point with nothing else there.
 * @param {boolean} group  Thousands separated by ",".
 * @returns {{ negative: boolean, text: string }}
 */
function spellNumber(n, digits, leading, group){
    // The number is first spelled to six places, as the conversion behind
    // the Format functions does, then rounded a half away from zero.
    const six = Math.abs(n).toFixed(Math.max(6, digits));
    const [whole, fraction] = six.split('.');
    let units = BigInt(whole + fraction.slice(0, digits));
    if (Number(fraction[digits] ?? '0') >= 5)
    {
        units += 1n;
    }
    const scaled = units.toString().padStart(digits + 1, '0');
    let integral = scaled.slice(0, scaled.length - digits);
    const decimals = scaled.slice(scaled.length - digits);
    if (group)
    {
        integral = integral.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    if (integral === '0' && !leading && digits > 0)
    {
        integral = '';
    }
    const negative = n < 0 && units !== 0n;
    return { negative, text: digits > 0 ? `${integral}.${decimals}` : integral };
}

/**
 * A tristate argument of the Format functions: -2 (vbUseDefault) for the
 * locale's choice, -1 for yes, 0 for no.
 *
 * @param {Value} value @param {boolean} fallback @returns {boolean}
 */
function tristate(value, fallback){
    const n = value === undefined ? -2 : toLong(value);
    return n === -2 ? fallback : n !== 0;
}

/**
 * The arguments every Format function shares after the value.
 *
 * @param {Value[]} args @param {boolean} parensByDefault
 */
function formatOptions(args, parensByDefault){
    const places = args[1] === undefined ? -1 : toLong(args[1]);
    if (places < -1 || places > 255)
    {
        throw new VBRuntimeError(5);
    }
    return {
        digits: places === -1 ? 2 : places,
        leading: tristate(args[2], true),
        parens: tristate(args[3], parensByDefault),
        group: tristate(args[4], true),
    };
}

/**
 * @param {Interpreter} interp @param {BuiltinHost} host
 */
export function installDates(interp, host){
    const thisYear = ()=>fields(wallTimeToOleDate(localNow(host))).year;
    /** @param {Value} v @returns {number} */
    const asDate = v=>toDate(v, thisYear);
    /** The local time to the second, as a Date. */
    const now = ()=>wallTimeToOleDate(Math.floor(localNow(host) / 1000) * 1000);
    /**
     * A function of a Date's calendar fields; Null stays Null.
     *
     * @param {string} name @param {(f: Fields) => number} pick
     */
    const part = (name, pick)=>define(interp, name, 1, 1, ([v])=>(v === null ? null
        : integer(pick(fields(asDate(v))))));

    define(interp, 'Now', 0, 0, ()=>date(now()));
    define(interp, 'Date', 0, 0, ()=>date(Math.floor(now())));
    define(interp, 'Time', 0, 0, ()=>{
        const day = now();
        return date(day - Math.floor(day));
    });
    define(interp, 'Timer', 0, 0, ()=>single((((localNow(host) % DAY_MS) + DAY_MS) % DAY_MS)
        / 1000));
    part('Year', f=>f.year);
    part('Month', f=>f.month);
    part('Day', f=>f.day);
    part('Hour', f=>f.hour);
    part('Minute', f=>f.minute);
    part('Second', f=>f.second);
    define(interp, 'Weekday', 1, 2, ([v, first])=>(v === null ? null
        : integer(weekday(asDate(v), firstDay(first)))));
    define(interp, 'WeekdayName', 1, 3, ([w, abbreviate, first])=>{
        const n = toLong(w);
        if (n < 1 || n > 7)
        {
            throw new VBRuntimeError(5);
        }
        const name = WEEKDAYS[(n - 1 + firstDay(first)) % 7];
        return abbreviate !== undefined && toDouble(abbreviate) !== 0 ? name.slice(0, 3) : name;
    });
    define(interp, 'MonthName', 1, 2, ([m, abbreviate])=>{
        const n = toLong(m);
        if (n < 1 || n > 12)
        {
            throw new VBRuntimeError(5);
        }
        const name = MONTHS[n - 1];
        return abbreviate !== undefined && toDouble(abbreviate) !== 0 ? name.slice(0, 3) : name;
    });
    define(interp, 'DateSerial', 3, 3, ([y, m, d])=>{
        let year = toLong(y);
        // A two-digit year is placed by the window Windows draws, before the
        // months roll into it.
        if (year >= 0 && year < 30)
        {
            year += 2000;
        }
        else if (year >= 30 && year < 100)
        {
            year += 1900;
        }
        const day = dateOf({ year, month: toLong(m), day: toLong(d), hour: 0, minute: 0,
            second: 0 });
        if (fieldsOf(day) === null)
        {
            throw new VBRuntimeError(5);
        }
        return date(day);
    });
    define(interp, 'TimeSerial', 3, 3, ([h, m, s])=>{
        const day = fromSeconds(toLong(h) * 3600 + toLong(m) * 60 + toLong(s));
        return date(checkedDate(day));
    });
    define(interp, 'DateValue', 1, 1, ([v])=>{
        if (typeof v === 'string')
        {
            const day = dateFromText(v, VAR_DATEVALUEONLY, thisYear);
            if (day === null)
            {
                throw new VBRuntimeError(13);
            }
            return date(day);
        }
        return date(Math.trunc(asDate(v)));
    });
    define(interp, 'TimeValue', 1, 1, ([v])=>{
        if (typeof v === 'string')
        {
            const time = dateFromText(v, VAR_TIMEVALUEONLY, thisYear);
            if (time === null)
            {
                throw new VBRuntimeError(13);
            }
            return date(time);
        }
        const day = asDate(v);
        return date(Math.abs(day - Math.trunc(day)));
    });
    define(interp, 'IsDate', 1, 1, ([v])=>{
        if (v instanceof ForeignValue && v.vt === VT_DATE)
        {
            return true;
        }
        return typeof v === 'string' && dateFromText(v, 0, thisYear) !== null;
    });
    define(interp, 'DateAdd', 3, 3, ([interval, n, v])=>{
        const count = toLong(n);
        const day = asDate(v);
        const unit = toStr(interval).toLowerCase();
        let result;
        if (unit === 'yyyy' || unit === 'q' || unit === 'm')
        {
            const months = count * (unit === 'yyyy' ? 12 : unit === 'q' ? 3 : 1);
            const f = fields(day);
            const total = f.year * 12 + f.month - 1 + months;
            const year = Math.floor(total / 12);
            const month = total - year * 12 + 1;
            // The day of the month stays, but no further than the month's end.
            const length = month === 2 ? (isLeap(year) ? 29 : 28) : MONTH_DAYS[month - 1];
            result = dateOf({ year, month, day: Math.min(f.day, length), hour: f.hour,
                minute: f.minute, second: f.second });
        }
        else
        {
            const seconds = { y: 86400, d: 86400, w: 86400, ww: 604800, h: 3600, n: 60, s: 1 }[
                unit];
            if (seconds === undefined)
            {
                throw new VBRuntimeError(5);
            }
            result = fromSeconds(secondsOf(day) + count * seconds);
        }
        if (fieldsOf(result) === null)
        {
            throw new VBRuntimeError(5);
        }
        return date(result);
    });
    define(interp, 'DateDiff', 3, 5, ([interval, a, b, first])=>{
        const from = asDate(a);
        const to = asDate(b);
        const unit = toStr(interval).toLowerCase();
        const f = fields(from);
        const t = fields(to);
        switch (unit)
        {
            case 'yyyy': return long(t.year - f.year);
            case 'q':
                return long(t.year * 4 + Math.floor((t.month - 1) / 3)
                    - (f.year * 4 + Math.floor((f.month - 1) / 3)));
            case 'm': return long(t.year * 12 + t.month - (f.year * 12 + f.month));
            case 'y': case 'd': return long(dayCount(to) - dayCount(from));
            case 'w': return long(Math.trunc((dayCount(to) - dayCount(from)) / 7));
            case 'ww': {
                const start = firstDay(first);
                /** @param {number} day */
                const weekStart = day=>dayCount(day) - ((fields(day).dayOfWeek - start + 7) % 7);
                return long((weekStart(to) - weekStart(from)) / 7);
            }
            case 'h': return long(Math.floor(secondsOf(to) / 3600)
                - Math.floor(secondsOf(from) / 3600));
            case 'n': return long(Math.floor(secondsOf(to) / 60) - Math.floor(secondsOf(from) / 60));
            case 's': return long(secondsOf(to) - secondsOf(from));
            default:
                throw new VBRuntimeError(5);
        }
    });
    define(interp, 'DatePart', 2, 4, ([interval, v, first, firstWeek])=>{
        const day = asDate(v);
        const f = fields(day);
        switch (toStr(interval).toLowerCase())
        {
            case 'yyyy': return integer(f.year);
            case 'q': return integer(Math.floor((f.month - 1) / 3) + 1);
            case 'm': return integer(f.month);
            case 'y': return integer(f.dayOfYear);
            case 'd': return integer(f.day);
            case 'w': return integer(weekday(day, firstDay(first)));
            case 'ww': {
                const rule = firstWeek === undefined ? 1 : toLong(firstWeek) || 1;
                if (rule < 1 || rule > 3)
                {
                    throw new VBRuntimeError(5);
                }
                return integer(weekOfYear(day, firstDay(first), rule));
            }
            case 'h': return integer(f.hour);
            case 'n': return integer(f.minute);
            case 's': return integer(f.second);
            default:
                throw new VBRuntimeError(5);
        }
    });
    define(interp, 'FormatDateTime', 1, 2, ([v, format])=>{
        const day = asDate(v);
        const f = fields(day);
        const clock = `${f.hour % 12 || 12}:${pad(f.minute)}:${pad(f.second)} `
            + `${f.hour < 12 ? 'AM' : 'PM'}`;
        switch (format === undefined ? 0 : toLong(format))
        {
            case 0: return /** @type {string} */ (textOfDate(day, 0));
            case 1:
                return `${WEEKDAYS[f.dayOfWeek]}, ${MONTHS[f.month - 1]} ${pad(f.day)}, `
                    + `${f.year}`;
            case 2: return `${f.month}/${f.day}/${f.year}`;
            case 3: return clock;
            case 4: return `${pad(f.hour)}:${pad(f.minute)}`;
            default:
                throw new VBRuntimeError(5);
        }
    });
    define(interp, 'FormatNumber', 1, 5, args=>{
        const options = formatOptions(args, false);
        const { negative, text } = spellNumber(toDouble(args[0]), options.digits,
            options.leading, options.group);
        if (!negative)
        {
            return text;
        }
        return options.parens ? `(${text})` : `-${text}`;
    });
    define(interp, 'FormatCurrency', 1, 5, args=>{
        const options = formatOptions(args, true);
        const { negative, text } = spellNumber(toDouble(args[0]), options.digits,
            options.leading, options.group);
        if (!negative)
        {
            return `$${text}`;
        }
        return options.parens ? `($${text})` : `-$${text}`;
    });
    define(interp, 'FormatPercent', 1, 5, args=>{
        const options = formatOptions(args, false);
        const { negative, text } = spellNumber(toDouble(args[0]) * 100, options.digits,
            options.leading, options.group);
        if (!negative)
        {
            return `${text}%`;
        }
        return options.parens ? `(${text}%)` : `-${text}%`;
    });
}

/** @param {number} n */
const pad = n=>String(n).padStart(2, '0');

/** @param {number} year */
const isLeap = year=>(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

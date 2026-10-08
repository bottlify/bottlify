/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Date (ECMA-262 3rd edition 15.9), on the machine's clock and in its time
 * zone, both of which the embedder supplies.
 *
 * The time arithmetic is ES3's (15.9.1), done here rather than by the host's
 * Date, whose time zone is the host's and not the machine's. The text forms
 * are JScript's: `toString` is "Wed Oct 8 12:34:56 UTC+0200 2026", the UTC
 * form "Wed, 8 Oct 2026 10:34:56 UTC", and the locale forms an English
 * system's long date and time. `parse` reads what JScript documents it
 * reads: month/day/year, a month's name with the day and year in any order,
 * a time with AM or PM, and a zone as UTC or GMT with an offset or as a US
 * zone's name.
 *
 * JScript's own members: `getYear`, `setYear`, and `getVarDate`, which
 * answers the time as an automation date.
 */

import { ForeignValue, dateValue, oleDateToWallTime, wallTimeToOleDate } from '../script/values.js';
import { VT_DATE } from '../oleaut32/vartypes.js';
import { JSObject } from './objects.js';
import { isPrimitive, toInteger } from './realm.js';

/** @typedef {import('./realm.js').Realm} Realm */

const MS_PER_DAY = 86400000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
    'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov',
    'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

/** @param {number} a @param {number} b @returns {number} a mod b, never negative */
const mod = (a, b)=>((a % b) + b) % b;

/** @param {number} t @returns {number} */
export const day = t=>Math.floor(t / MS_PER_DAY);

/** @param {number} y @returns {number} */
const dayFromYear = y=>365 * (y - 1970) + Math.floor((y - 1969) / 4)
    - Math.floor((y - 1901) / 100) + Math.floor((y - 1601) / 400);

/** @param {number} y @returns {boolean} */
const isLeap = y=>(y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** @param {number} t @returns {number} */
export function yearFromTime(t){
    let y = Math.floor(day(t) / 365.2425) + 1970;
    while (dayFromYear(y) * MS_PER_DAY > t)
    {
        y--;
    }
    while (dayFromYear(y + 1) * MS_PER_DAY <= t)
    {
        y++;
    }
    return y;
}

/** First day of each month in a common year and in a leap one. */
const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

/** @param {number} month @param {boolean} leap @returns {number} */
const monthStart = (month, leap)=>MONTH_STARTS[month] + (leap && month >= 2 ? 1 : 0);

/** @param {number} t @returns {{ year: number, month: number, date: number }} */
export function dateParts(t){
    const year = yearFromTime(t);
    const inYear = day(t) - dayFromYear(year);
    const leap = isLeap(year);
    let month = 0;
    while (month < 11 && inYear >= monthStart(month + 1, leap))
    {
        month++;
    }
    return { year, month, date: inYear - monthStart(month, leap) + 1 };
}

/** @param {number} t @returns {number} */
const weekDay = t=>mod(day(t) + 4, 7);

/**
 * MakeTime (15.9.1.11).
 *
 * @param {number} hour @param {number} min @param {number} sec @param {number} ms
 * @returns {number}
 */
export function makeTime(hour, min, sec, ms){
    if (![hour, min, sec, ms].every(Number.isFinite))
    {
        return NaN;
    }
    return toInteger(hour) * 3600000 + toInteger(min) * 60000 + toInteger(sec) * 1000
        + toInteger(ms);
}

/**
 * MakeDay (15.9.1.12).
 *
 * @param {number} year @param {number} month @param {number} date @returns {number}
 */
export function makeDay(year, month, date){
    if (![year, month, date].every(Number.isFinite))
    {
        return NaN;
    }
    const m = toInteger(month);
    const y = toInteger(year) + Math.floor(m / 12);
    const inYear = mod(m, 12);
    return dayFromYear(y) + monthStart(inYear, isLeap(y)) + toInteger(date) - 1;
}

/** @param {number} days @param {number} time @returns {number} */
export const makeDate = (days, time)=>(Number.isFinite(days) && Number.isFinite(time)
    ? days * MS_PER_DAY + time : NaN);

/** @param {number} t @returns {number} TimeClip (15.9.1.14) */
export const timeClip = t=>(!Number.isFinite(t) || Math.abs(t) > 8.64e15 ? NaN : toInteger(t) + 0);

/** @param {number} n @param {number} [width] */
const pad = (n, width = 2)=>String(n).padStart(width, '0');

/**
 * A year as JScript prints one: B.C. for the years before 1.
 *
 * @param {number} year @returns {string}
 */
const yearText = year=>(year > 0 ? String(year) : `${1 - year} B.C.`);

/** @param {number} offset  Milliseconds east of UTC. @returns {string} */
function zoneText(offset){
    if (offset === 0)
    {
        return 'UTC';
    }
    const minutes = Math.round(Math.abs(offset) / 60000);
    return `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`;
}

/** @param {number} t @returns {string} hh:mm:ss */
const clock = t=>{
    const within = mod(t, MS_PER_DAY);
    return `${pad(Math.floor(within / 3600000))}:${pad(Math.floor(within / 60000) % 60)}:`
        + `${pad(Math.floor(within / 1000) % 60)}`;
};

/** @param {number} t @returns {string} h:mm:ss AM */
const localeClock = t=>{
    const within = mod(t, MS_PER_DAY);
    const hours = Math.floor(within / 3600000);
    const twelve = hours % 12 === 0 ? 12 : hours % 12;
    return `${twelve}:${pad(Math.floor(within / 60000) % 60)}:${pad(Math.floor(within / 1000) % 60)}`
        + ` ${hours < 12 ? 'AM' : 'PM'}`;
};

/** @param {number} t @returns {string} the UTC form, "Thu, 1 Jan 1970 00:00:00 UTC" */
const utcString = t=>{
    const { year, month, date } = dateParts(t);
    return `${DAYS[weekDay(t)]}, ${date} ${MONTHS[month]} ${yearText(year)} ${clock(t)} UTC`;
};

/** @param {number} t @returns {string} */
const localeDate = t=>{
    const { year, month, date } = dateParts(t);
    return `${DAY_NAMES[weekDay(t)]}, ${MONTH_NAMES[month]} ${pad(date)}, ${yearText(year)}`;
};

/** US zones a date may name, by their offset in hours. */
const US_ZONES = new Map([
    ['est', -5], ['edt', -4], ['cst', -6], ['cdt', -5], ['mst', -7], ['mdt', -6],
    ['pst', -8], ['pdt', -7],
]);

/**
 * Date.parse as JScript reads a date (see the file's comment): a time in
 * milliseconds since 1970, UTC, or NaN. `utc` places a local time.
 *
 * @param {string} text @param {(local: number) => number} utc @returns {number}
 */
export function parseDate(text, utc){
    const tokens = text.toLowerCase().replace(/\([^)]*\)/g, ' ')
        .match(/[a-z]+\.?|\d+|[/:+\-,]/g) ?? [];
    /** @type {number | undefined} */
    let year;
    /** @type {number | undefined} */
    let month;
    /** @type {number | undefined} */
    let date;
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    /** @type {string | null} */
    let meridiem = null;
    /** @type {number | null} milliseconds east of UTC */
    let offset = null;
    let sawZone = false;
    /** @type {number[]} */
    const loose = [];
    for (let i = 0; i < tokens.length; i++)
    {
        const token = tokens[i];
        if (token === ',')
        {
            continue;
        }
        if (/^[a-z]/.test(token))
        {
            const word = token.replace('.', '');
            if (word === 'am' || word === 'pm' || word === 'a' || word === 'p')
            {
                meridiem = word[0];
            }
            else if (word === 'utc' || word === 'gmt' || word === 'z')
            {
                offset = 0;
                sawZone = true;
            }
            else if (US_ZONES.has(word))
            {
                offset = /** @type {number} */ (US_ZONES.get(word)) * 3600000;
            }
            else if (word.length >= 3 && MONTH_NAMES.some(name=>name.toLowerCase()
                .startsWith(word)))
            {
                month = MONTH_NAMES.findIndex(name=>name.toLowerCase().startsWith(word));
            }
            else if (word.length >= 3 && DAY_NAMES.some(name=>name.toLowerCase()
                .startsWith(word)))
            {
                // A weekday says nothing the date does not.
            }
            else
            {
                return NaN;
            }
            continue;
        }
        if ((token === '+' || token === '-') && /^\d+$/.test(tokens[i + 1] ?? '')
            && (sawZone || tokens[i + 2] !== token))
        {
            const digits = tokens[i + 1];
            const value = Number(digits);
            const minutesEast = digits.length <= 2 ? value * 60
                : Math.floor(value / 100) * 60 + (value % 100);
            offset = (token === '-' ? -1 : 1) * minutesEast * 60000;
            i++;
            continue;
        }
        if (!/^\d+$/.test(token))
        {
            return NaN;
        }
        const value = Number(token);
        if (tokens[i + 1] === ':')
        {
            hours = value;
            minutes = Number(tokens[i + 2] ?? NaN);
            i += 2;
            if (tokens[i + 1] === ':')
            {
                seconds = Number(tokens[i + 2] ?? NaN);
                i += 2;
            }
            continue;
        }
        if (tokens[i + 1] === '/' || tokens[i + 1] === '-')
        {
            const separator = tokens[i + 1];
            month = value - 1;
            date = Number(tokens[i + 2] ?? NaN);
            i += 2;
            if (tokens[i + 1] === separator)
            {
                year = Number(tokens[i + 2] ?? NaN);
                i += 2;
            }
            continue;
        }
        loose.push(value);
    }
    for (const value of loose)
    {
        if (date === undefined && value <= 31 && month !== undefined)
        {
            date = value;
        }
        else if (year === undefined)
        {
            year = value;
        }
        else if (date === undefined)
        {
            date = value;
        }
        else
        {
            return NaN;
        }
    }
    if (year === undefined || month === undefined || date === undefined)
    {
        return NaN;
    }
    if (year < 100)
    {
        year += 1900;
    }
    if (meridiem !== null)
    {
        if (hours > 12)
        {
            return NaN;
        }
        hours = hours % 12 + (meridiem === 'p' ? 12 : 0);
    }
    const local = makeDate(makeDay(year, month, date), makeTime(hours, minutes, seconds, 0));
    return timeClip(offset === null ? utc(local) : local - offset);
}

/** @param {Realm} realm */
export function installDate(realm){
    const prototype = realm.datePrototype;
    prototype.cls = 'Date';
    prototype.value = NaN;

    /** @param {number} t @returns {number} the local zone's offset at t */
    const offsetAt = t=>realm.options.localOffset(t);
    /** @param {number} t @returns {number} */
    const local = t=>t + offsetAt(t);
    /** @param {number} t @returns {number} */
    const utc = t=>t - offsetAt(t - offsetAt(t));

    /** @param {number} t @returns {string} */
    const dateString = t=>{
        if (Number.isNaN(t))
        {
            return 'NaN';
        }
        const l = local(t);
        const { year, month, date } = dateParts(l);
        return `${DAYS[weekDay(l)]} ${MONTHS[month]} ${date} ${clock(l)} ${zoneText(offsetAt(t))} `
            + yearText(year);
    };

    /** @param {number} t @returns {JSObject} */
    const newDate = t=>{
        const object = new JSObject(prototype, 'Date');
        object.value = timeClip(t);
        return object;
    };

    /**
     * @param {any[]} args @param {boolean} asUtc
     * @returns {Generator<unknown, number, unknown>} the time the fields make
     */
    const fromFields = function*(args, asUtc){
        const n = [];
        for (let i = 0; i < 7; i++)
        {
            n.push(i < args.length ? yield* realm.toNumber(args[i]) : (i === 2 ? 1 : 0));
        }
        let year = n[0];
        if (!Number.isNaN(year) && toInteger(year) >= 0 && toInteger(year) <= 99)
        {
            year = 1900 + toInteger(year);
        }
        const t = makeDate(makeDay(year, n[1], n[2]), makeTime(n[3], n[4], n[5], n[6]));
        return asUtc ? t : utc(t);
    };

    const constructor = realm.defineConstructor('Date', 7, prototype,
        ()=>dateString(realm.options.now()),
        function*(_this, args){
            if (args.length === 0)
            {
                return newDate(realm.options.now());
            }
            if (args.length === 1)
            {
                const value = args[0];
                if (value instanceof ForeignValue && value.vt === VT_DATE)
                {
                    return newDate(utc(oleDateToWallTime(value.value)));
                }
                const primitive = isPrimitive(value) ? value : yield* realm.toPrimitive(value);
                if (typeof primitive === 'string')
                {
                    return newDate(parseDate(primitive, utc));
                }
                return newDate(realm.primitiveNumber(primitive));
            }
            return newDate(yield* fromFields(args, false));
        });

    realm.methods(constructor, [
        ['parse', 1, function*(_this, args){
            return parseDate(yield* realm.toString(args[0]), utc);
        }],
        ['UTC', 7, function*(_this, args){
            return timeClip(yield* fromFields(args, true));
        }],
    ]);

    /** @param {any} self @returns {JSObject} */
    const thisDate = self=>{
        if (self instanceof JSObject && self.cls === 'Date')
        {
            return self;
        }
        throw realm.typeError(5006);
    };
    /** @param {(t: number) => any} read @param {boolean} inLocal @returns {import('./objects.js').NativeCall} */
    const getter = (read, inLocal)=>self=>{
        const t = thisDate(self).value;
        return Number.isNaN(t) ? NaN : read(inLocal ? local(t) : t);
    };
    /** @param {(t: number) => string} write @returns {import('./objects.js').NativeCall} */
    const text = write=>self=>{
        const t = thisDate(self).value;
        return Number.isNaN(t) ? 'NaN' : write(t);
    };

    /** @param {number} t */
    const hour = t=>Math.floor(mod(t, MS_PER_DAY) / 3600000);
    /** @param {number} t */
    const minute = t=>Math.floor(mod(t, MS_PER_DAY) / 60000) % 60;
    /** @param {number} t */
    const second = t=>Math.floor(mod(t, MS_PER_DAY) / 1000) % 60;
    /** @param {number} t */
    const milli = t=>mod(t, 1000);

    /**
     * A setter: which fields its arguments replace, from the first one it
     * names, the rest kept from the date as it was.
     *
     * @param {'ms' | 'sec' | 'min' | 'hour' | 'date' | 'month' | 'year'} first
     * @param {number} count  How many fields it may take.
     * @param {boolean} inLocal
     * @returns {import('./objects.js').NativeCall}
     */
    const setter = (first, count, inLocal)=>function*(self, args){
        const object = thisDate(self);
        const values = [];
        for (let i = 0; i < Math.min(args.length, count); i++)
        {
            values.push(yield* realm.toNumber(args[i]));
        }
        if (values.length === 0)
        {
            values.push(NaN);
        }
        let t = object.value;
        if (Number.isNaN(t))
        {
            if (first !== 'year')
            {
                return NaN;
            }
            t = 0;
        }
        else if (inLocal)
        {
            t = local(t);
        }
        const parts = dateParts(t);
        const fields = {
            year: parts.year, month: parts.month, date: parts.date,
            hour: hour(t), min: minute(t), sec: second(t), ms: milli(t),
        };
        const order = /** @type {const} */ (['year', 'month', 'date', 'hour', 'min', 'sec',
            'ms']);
        const start = order.indexOf(first);
        values.forEach((value, i)=>{
            fields[order[start + i]] = value;
        });
        let next = makeDate(makeDay(fields.year, fields.month, fields.date),
            makeTime(fields.hour, fields.min, fields.sec, fields.ms));
        if (inLocal)
        {
            next = utc(next);
        }
        object.value = timeClip(next);
        return object.value;
    };

    realm.methods(prototype, [
        ['toString', 0, text(dateString)],
        ['toDateString', 0, text(t=>{
            const l = local(t);
            const { year, month, date } = dateParts(l);
            return `${DAYS[weekDay(l)]} ${MONTHS[month]} ${date} ${yearText(year)}`;
        })],
        ['toTimeString', 0, text(t=>`${clock(local(t))} ${zoneText(offsetAt(t))}`)],
        ['toLocaleString', 0, text(t=>`${localeDate(local(t))} ${localeClock(local(t))}`)],
        ['toLocaleDateString', 0, text(t=>localeDate(local(t)))],
        ['toLocaleTimeString', 0, text(t=>localeClock(local(t)))],
        ['toUTCString', 0, text(utcString)],
        ['toGMTString', 0, text(utcString)],
        ['valueOf', 0, self=>thisDate(self).value],
        ['getTime', 0, self=>thisDate(self).value],
        ['getFullYear', 0, getter(yearFromTime, true)],
        ['getUTCFullYear', 0, getter(yearFromTime, false)],
        ['getMonth', 0, getter(t=>dateParts(t).month, true)],
        ['getUTCMonth', 0, getter(t=>dateParts(t).month, false)],
        ['getDate', 0, getter(t=>dateParts(t).date, true)],
        ['getUTCDate', 0, getter(t=>dateParts(t).date, false)],
        ['getDay', 0, getter(weekDay, true)],
        ['getUTCDay', 0, getter(weekDay, false)],
        ['getHours', 0, getter(hour, true)],
        ['getUTCHours', 0, getter(hour, false)],
        ['getMinutes', 0, getter(minute, true)],
        ['getUTCMinutes', 0, getter(minute, false)],
        ['getSeconds', 0, getter(second, true)],
        ['getUTCSeconds', 0, getter(second, false)],
        ['getMilliseconds', 0, getter(milli, true)],
        ['getUTCMilliseconds', 0, getter(milli, false)],
        ['getTimezoneOffset', 0, getter(t=>-Math.round(offsetAt(t) / 60000), false)],
        // Years 1900 to 1999 as the two digits after 19; any other in full.
        ['getYear', 0, getter(t=>{
            const year = yearFromTime(t);
            return year >= 1900 && year <= 1999 ? year - 1900 : year;
        }, true)],
        ['getVarDate', 0, self=>{
            const t = thisDate(self).value;
            return dateValue(Number.isNaN(t) ? NaN : wallTimeToOleDate(local(t)));
        }],
        ['setTime', 1, function*(self, args){
            const object = thisDate(self);
            object.value = timeClip(yield* realm.toNumber(args[0]));
            return object.value;
        }],
        ['setMilliseconds', 1, setter('ms', 1, true)],
        ['setUTCMilliseconds', 1, setter('ms', 1, false)],
        ['setSeconds', 2, setter('sec', 2, true)],
        ['setUTCSeconds', 2, setter('sec', 2, false)],
        ['setMinutes', 3, setter('min', 3, true)],
        ['setUTCMinutes', 3, setter('min', 3, false)],
        ['setHours', 4, setter('hour', 4, true)],
        ['setUTCHours', 4, setter('hour', 4, false)],
        ['setDate', 1, setter('date', 1, true)],
        ['setUTCDate', 1, setter('date', 1, false)],
        ['setMonth', 2, setter('month', 2, true)],
        ['setUTCMonth', 2, setter('month', 2, false)],
        ['setFullYear', 3, setter('year', 3, true)],
        ['setUTCFullYear', 3, setter('year', 3, false)],
        ['setYear', 1, function*(self, args){
            const object = thisDate(self);
            let year = yield* realm.toNumber(args[0]);
            if (Number.isNaN(year))
            {
                object.value = NaN;
                return NaN;
            }
            year = toInteger(year);
            if (year >= 0 && year <= 99)
            {
                year += 1900;
            }
            const set = /** @type {(self: any, args: any[]) => any} */ (setter('year', 1, true));
            return yield* set(object, [year]);
        }],
    ]);
}

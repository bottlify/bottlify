/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Automation's text: numbers, booleans and dates as the conversions from a
 * string read them, and currency and dates as the conversions to one spell
 * them -- in the English (United States) locale, the one this build speaks.
 *
 * A string conversion reads the whole string or nothing: what VarR8FromStr and
 * its kin ask VarParseNumFromStr for is NUMPRS_STD, which includes
 * NUMPRS_USE_ALL, so "12abc" is no number at all rather than 12.
 */

import { dateOf, fieldsOf, rollYear, VAR_DATEVALUEONLY, VAR_TIMEVALUEONLY } from './dates.js';

/**
 * A number as its decimal digits: `digits` without leading or trailing zeros
 * ('' for zero), times ten to `pwr10`.
 *
 * @typedef {{ negative: boolean, digits: string, pwr10: number }} ParsedNumber
 */

/**
 * The spaces a number may stand between: every kind a C isspace() knows, and
 * the no-break space a formatted number carries.
 *
 * @param {string} char
 */
const isSpace = char=>char === ' ' || char === '\t' || char === '\n' || char === '\r'
    || char === '\v' || char === '\f' || char === ' ';

/** What is left of a currency amount once its sign and its '$' are taken off. */
const AMOUNT = /^(\d[\d,]*)?(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * A number string as VarR8FromStr and its kin read it in English: spaces
 * around it; one sign, before the amount or after it, or parentheses around it
 * for a negative; one '$' either side of the digits; thousands commas, not
 * leading; a '.' and an exponent; or a whole number in VB's &H hexadecimal or
 * &O octal. null when the string is not a number, or not only one.
 *
 * @param {string} text
 * @returns {ParsedNumber | null}
 */
export function parseNumber(text){
    let start = 0;
    let end = text.length;
    while (start < end && isSpace(text[start]))
    {
        start++;
    }
    while (end > start && isSpace(text[end - 1]))
    {
        end--;
    }
    let body = text.slice(start, end);
    const radix = /^&([HhOo])([0-9A-Fa-f]+)$/.exec(body);
    if (radix)
    {
        const hex = radix[1] === 'H' || radix[1] === 'h';
        if (!hex && /[89A-Fa-f]/.test(radix[2]))
        {
            return null;
        }
        const value = BigInt(`${hex ? '0x' : '0o'}${radix[2]}`);
        return { negative: false, ...digitsOf(value === 0n ? '' : value.toString(), 0) };
    }
    let negative = false;
    let signs = 0;
    if (body.startsWith('(') && body.endsWith(')'))
    {
        negative = true;
        signs = 1;
        body = body.slice(1, -1);
    }
    let dollars = 0;
    // A sign and a '$' may come in either order on either side, each once.
    for (let pass = 0; pass < 2; pass++)
    {
        const head = body[0];
        if (head === '$')
        {
            dollars++;
            body = body.slice(1);
        }
        else if (head === '+' || head === '-')
        {
            signs++;
            negative = negative || head === '-';
            body = body.slice(1);
        }
        const tail = body[body.length - 1];
        if (tail === '$')
        {
            dollars++;
            body = body.slice(0, -1);
        }
        else if (tail === '+' || tail === '-')
        {
            signs++;
            negative = negative || tail === '-';
            body = body.slice(0, -1);
        }
    }
    const amount = AMOUNT.exec(body);
    if (!amount || signs > 1 || dollars > 1 || (!amount[1] && !amount[2]))
    {
        return null;
    }
    const fraction = amount[2] ?? '';
    const exponent = amount[3] === undefined ? 0 : Number(amount[3]);
    return { negative, ...digitsOf(`${(amount[1] ?? '').replaceAll(',', '')}${fraction}`,
        exponent - fraction.length) };
}

/**
 * Digits and a power of ten with the zeros at either end taken off.
 *
 * @param {string} raw @param {number} pwr10
 */
const digitsOf = (raw, pwr10)=>{
    const significant = raw.replace(/^0+/, '');
    const digits = significant.replace(/0+$/, '');
    return digits === ''
        ? { digits: '', pwr10: 0 }
        : { digits, pwr10: pwr10 + significant.length - digits.length };
};

/**
 * The double nearest a parsed number: past the doubles it is infinite, and
 * below them zero.
 *
 * @param {ParsedNumber} parsed
 */
export const numberOf = ({ negative, digits, pwr10 })=>
    Number(`${negative ? '-' : ''}${digits || '0'}e${pwr10}`);

/**
 * A parsed number exactly, as the conversions to CY and DECIMAL want it; null
 * when it is past anything either can hold. A number too small for either is
 * zero rather than a value carried to thousands of places.
 *
 * @param {ParsedNumber} parsed
 * @returns {import('./varmath.js').Exact | null}
 */
export function exactOfNumber({ negative, digits, pwr10 }){
    if (digits === '' || digits.length + pwr10 < -40)
    {
        return { value: 0n, scale: 0 };
    }
    if (digits.length + pwr10 > 40)
    {
        return null;
    }
    const magnitude = pwr10 >= 0 ? BigInt(digits) * 10n ** BigInt(pwr10) : BigInt(digits);
    return { value: negative ? -magnitude : magnitude, scale: Math.max(0, -pwr10) };
}

/**
 * A string read as a boolean, as VarBoolFromStr reads it: #TRUE# and #FALSE#
 * exactly as spelled, True and False in any case, or a number, non-zero for
 * true. The VARIANT_BOOL, or null for anything else.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function boolOf(text){
    if (text === '#TRUE#' || text.toLowerCase() === 'true')
    {
        return -1;
    }
    if (text === '#FALSE#' || text.toLowerCase() === 'false')
    {
        return 0;
    }
    const parsed = parseNumber(text);
    return parsed === null ? null : (parsed.digits === '' ? 0 : -1);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december'];

/**
 * The month a word names, by its English name or its three-letter
 * abbreviation, from 1; 0 for any other word.
 *
 * @param {string} word
 */
const monthOf = word=>{
    const lower = word.toLowerCase();
    return MONTHS.findIndex(name=>name === lower || name.slice(0, 3) === lower) + 1;
};

/** @param {number} year @param {number} month */
const daysIn = (year, month)=>new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * A year as written: below 100 it is two digits, placed by the window
 * Windows XP draws, 1930 to 2029.
 *
 * @param {number} written
 */
const fullYear = written=>rollYear(written, 1).year;

/**
 * Whether a year, month and day make a date a DATE can hold.
 *
 * @param {number} year @param {number} month @param {number} day
 */
const isDate = (year, month, day)=>year >= 100 && year <= 9999 && month >= 1 && month <= 12
    && day >= 1 && day <= daysIn(year, month);

/**
 * @typedef {{ kind: 'number', value: number }
 *     | { kind: 'time', parts: number[] }
 *     | { kind: 'month', value: number }
 *     | { kind: 'meridian', pm: boolean }} DateElement
 */

/**
 * One chunk of a date string between its spaces, slashes, dashes and commas.
 *
 * @param {string} chunk
 * @returns {DateElement[] | null}
 */
const elementsOf = chunk=>{
    const numeric = /^(\d+(?:[:.]\d+)*)([A-Za-z]*)$/.exec(chunk);
    if (numeric)
    {
        const parts = numeric[1].split(/[:.]/).map(Number);
        const word = numeric[2] === '' ? [] : elementsOf(numeric[2]);
        if (word === null || parts.length > 3)
        {
            return null;
        }
        return [parts.length === 1 ? { kind: 'number', value: parts[0] } : { kind: 'time', parts },
            ...word];
    }
    if (!/^[A-Za-z]+$/.test(chunk))
    {
        return null;
    }
    const lower = chunk.toLowerCase();
    if (lower === 'am' || lower === 'a' || lower === 'pm' || lower === 'p')
    {
        return [{ kind: 'meridian', pm: lower[0] === 'p' }];
    }
    const month = monthOf(chunk);
    return month === 0 ? null : [{ kind: 'month', value: month }];
};

/**
 * The calendar date some numbers and perhaps a month's name spell, in the
 * order the English locale prefers -- month, day, year -- and failing that
 * year, month, day, then day, month, year. Two numbers are a month and a day
 * of this year when they can be, and a year and a month when they cannot.
 *
 * @param {DateElement[]} parts @param {() => number | null} thisYear
 * @returns {{ year: number, month: number, day: number } | null}
 */
const calendarOf = (parts, thisYear)=>{
    const named = parts.flatMap(part=>(part.kind === 'month' ? [part.value] : []));
    const numbers = parts.flatMap(part=>(part.kind === 'number' ? [part.value] : []));
    if (named.length > 1 || numbers.length + named.length !== parts.length)
    {
        return null;
    }
    /** @param {number} year @param {number} month @param {number} day */
    const date = (year, month, day)=>(isDate(year, month, day) ? { year, month, day } : null);
    if (named.length === 1)
    {
        const month = named[0];
        if (numbers.length === 1)
        {
            const year = thisYear();
            return year === null ? null
                : date(year, month, numbers[0]) ?? date(fullYear(numbers[0]), month, 1);
        }
        const [first, second] = numbers;
        return date(fullYear(second), month, first) ?? date(fullYear(first), month, second);
    }
    if (numbers.length === 3)
    {
        const [a, b, c] = numbers;
        return date(fullYear(c), a, b) ?? date(fullYear(a), b, c) ?? date(fullYear(c), b, a);
    }
    const year = thisYear();
    if (year === null)
    {
        return null;
    }
    const [a, b] = numbers;
    return date(year, a, b) ?? date(year, b, a)
        ?? (b >= 1 && b <= 12 ? date(fullYear(a), b, 1) : null)
        ?? (a >= 1 && a <= 12 ? date(fullYear(b), a, 1) : null);
};

/**
 * A date string as VarDateFromStr reads it in English: a date of two or three
 * parts -- numbers, or a month's name and numbers -- and a time, h:m or h:m:s
 * with ':' or '.' between, or an hour with AM or PM, before the date or after
 * it. A date with no year is in this year, which `thisYear` gives; it answers
 * null when there is no clock to read, and the string is then refused.
 * VAR_TIMEVALUEONLY and VAR_DATEVALUEONLY keep one half. The DATE, or null.
 *
 * @param {string} text @param {number} flags @param {() => number | null} thisYear
 * @returns {number | null}
 */
export function dateFromText(text, flags, thisYear){
    const spaced = text.replaceAll('　', ' ').trim();
    if (spaced === '' || /^[-/,]|[-/,]$/.test(spaced))
    {
        return null;
    }
    /** @type {DateElement[]} */
    const elements = [];
    for (const chunk of spaced.split(/[\s/,-]+/))
    {
        const found = elementsOf(chunk);
        if (found === null)
        {
            return null;
        }
        elements.push(...found);
    }
    // The time is one element: h:m or h:m:s, or an hour, either with a
    // meridian after it; and it stands before the date or after it, never
    // inside it.
    const meridians = elements.filter(element=>element.kind === 'meridian').length;
    let at = elements.findIndex(element=>element.kind === 'time');
    if (meridians > 1 || elements.filter(element=>element.kind === 'time').length > 1)
    {
        return null;
    }
    const marked = elements.findIndex(element=>element.kind === 'meridian');
    if (marked === 0 || (marked > 0 && at >= 0 && marked !== at + 1))
    {
        return null;
    }
    if (marked > 0)
    {
        at = marked - 1;
    }
    const length = at < 0 ? 0 : marked > 0 ? 2 : 1;
    if (at > 0 && at + length !== elements.length)
    {
        return null;
    }
    const time = at < 0 ? null : elements[at];
    const dateParts = at < 0 ? elements : at === 0 ? elements.slice(length)
        : elements.slice(0, at);
    let hour = 0;
    let minute = 0;
    let second = 0;
    if (time !== null)
    {
        if (time.kind !== 'time' && time.kind !== 'number')
        {
            return null;
        }
        [hour, minute = 0, second = 0] = time.kind === 'time' ? time.parts : [time.value];
        if (hour > 23 || minute > 59 || second > 59)
        {
            return null;
        }
        const meridian = marked > 0 ? elements[marked] : null;
        if (meridian?.kind === 'meridian' && hour <= 12)
        {
            hour = meridian.pm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
        }
    }
    if (dateParts.length === 0)
    {
        return time === null ? null
            : dateOf({ year: 1899, month: 12, day: 30, hour, minute, second }, flags);
    }
    if (dateParts.length < 2 || dateParts.length > 3)
    {
        return null;
    }
    const calendar = calendarOf(dateParts, thisYear);
    return calendar === null ? null : dateOf({ ...calendar, hour, minute, second }, flags);
}

/** @param {number} value */
const twoDigits = value=>String(value).padStart(2, '0');

/**
 * A DATE as VarBstrFromDate spells it in English: M/D/YYYY and h:mm:ss AM, the
 * date alone when there is no time of day, the time alone on the day the
 * calendar starts from, or the half VAR_TIMEVALUEONLY or VAR_DATEVALUEONLY
 * asks for. null for a day no DATE can name.
 *
 * @param {number} date @param {number} flags
 * @returns {string | null}
 */
export function textOfDate(date, flags){
    const fields = fieldsOf(date);
    if (fields === null)
    {
        return null;
    }
    const day = `${fields.month}/${fields.day}/${fields.year}`;
    const clock = `${fields.hour % 12 || 12}:${twoDigits(fields.minute)}:`
        + `${twoDigits(fields.second)} ${fields.hour < 12 ? 'AM' : 'PM'}`;
    if ((flags & VAR_TIMEVALUEONLY) !== 0)
    {
        return clock;
    }
    if ((flags & VAR_DATEVALUEONLY) !== 0)
    {
        return day;
    }
    if (Math.trunc(date) === 0)
    {
        return clock;
    }
    return fields.hour === 0 && fields.minute === 0 && fields.second === 0
        ? day : `${day} ${clock}`;
}

/**
 * A currency value as VarBstrFromCy spells it in English: as many places as
 * it needs and no more, no thousands separators, '.' before the fraction.
 *
 * @param {bigint} units  ten-thousandths
 */
export function textOfCurrency(units){
    const magnitude = units < 0n ? -units : units;
    const fraction = String(magnitude % 10000n).padStart(4, '0').replace(/0+$/, '');
    return `${units < 0n ? '-' : ''}${magnitude / 10000n}${fraction === '' ? '' : `.${fraction}`}`;
}

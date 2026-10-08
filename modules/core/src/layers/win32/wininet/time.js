/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * HTTP dates, read the way InternetTimeToSystemTime reads them.
 *
 * The reader is lenient on purpose, because the dates it is given come from
 * servers and cookies of every vintage: RFC 1123 ("Fri, 07 Jan 2005 12:06:35
 * GMT"), RFC 850 ("Friday, 07-Jan-05 ..."), asctime ("Fri Jan  7 12:06:35
 * 2005"), and the numeric variants in between. What separates the fields does
 * not matter -- a comma, a dash, a slash, a space -- only their order does, so
 * the text is read as a run of words and numbers and nothing else.
 *
 * The weekday is taken from the text rather than worked out from the date: a
 * caller handed "Fri" gets Friday back even when the date was not a Friday,
 * which is what the system's own reader does. Only when the text names no
 * weekday at all is it computed.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov',
    'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * @typedef {Object} SystemTime
 * @property {number} year
 * @property {number} month       1 to 12.
 * @property {number} dayOfWeek   0 is Sunday.
 * @property {number} day
 * @property {number} hour
 * @property {number} minute
 * @property {number} second
 */

/** @param {string} token */
const isWord = token=>/^[a-z]/i.test(token);

/** @param {string | undefined} token */
const monthOf = token=>{
    if (token === undefined)
    {
        return 0;
    }
    if (isWord(token))
    {
        return MONTHS.indexOf(token.slice(0, 3).toLowerCase()) + 1;
    }
    return Number(token);
};

/**
 * A two-digit year is a window on a century: below 80 is this one, from 80
 * the last. Three digits or more are the year as written.
 *
 * @param {string | undefined} token
 */
const yearOf = token=>{
    if (token === undefined)
    {
        return 0;
    }
    const value = Number(token);
    if (token.length > 2)
    {
        return value;
    }
    return value < 80 ? 2000 + value : 1900 + value;
};

/** @param {string | undefined} token */
const numberOf = token=>(token === undefined || isWord(token) ? 0 : Number(token));

/**
 * Reads an HTTP date. Never fails: a field the text does not carry is zero,
 * as the system's reader leaves it, and the caller is told only that the text
 * was read.
 *
 * @param {string} text
 * @returns {SystemTime}
 */
export function parseInternetTime(text){
    const tokens = text.match(/[a-z]+|[0-9]+/gi) ?? [];
    let at = 0;
    /** @type {number | null} */
    let dayOfWeek = null;
    const [first, following] = tokens;
    if (first !== undefined && isWord(first))
    {
        const index = WEEKDAYS.indexOf(first.slice(0, 3).toLowerCase());
        dayOfWeek = index === -1 ? 0 : index;
        at = 1;
    }
    else if (first !== undefined && !(following !== undefined && isWord(following)))
    {
        // A number in the weekday's place is a weekday given as a number --
        // unless a month name follows it, when it was the day of the month
        // and the weekday was left out.
        dayOfWeek = Number(first) % 7;
        at = 1;
    }

    let day; let month; let year; let hour; let minute; let seconds;
    if (tokens[at] !== undefined && isWord(tokens[at]))
    {
        // asctime: the month first, the year last.
        month = monthOf(tokens[at]);
        day = numberOf(tokens[at + 1]);
        hour = numberOf(tokens[at + 2]);
        minute = numberOf(tokens[at + 3]);
        seconds = numberOf(tokens[at + 4]);
        year = yearOf(tokens[at + 5]);
    }
    else
    {
        day = numberOf(tokens[at]);
        month = monthOf(tokens[at + 1]);
        year = yearOf(tokens[at + 2]);
        hour = numberOf(tokens[at + 3]);
        minute = numberOf(tokens[at + 4]);
        seconds = numberOf(tokens[at + 5]);
    }
    if (dayOfWeek === null)
    {
        dayOfWeek = year > 0 && month > 0 && day > 0
            ? new Date(Date.UTC(year, month - 1, day)).getUTCDay()
            : 0;
    }
    return { year, month, dayOfWeek, day, hour, minute, second: seconds };
}

/**
 * Milliseconds since 1970 for a date read by parseInternetTime, or NaN when
 * it has no month or day to place it.
 *
 * @param {SystemTime} time
 */
export function timeValue(time){
    if (time.month < 1 || time.day < 1)
    {
        return Number.NaN;
    }
    const date = new Date(0);
    date.setUTCFullYear(time.year, time.month - 1, time.day);
    date.setUTCHours(time.hour, time.minute, time.second, 0);
    return date.getTime();
}

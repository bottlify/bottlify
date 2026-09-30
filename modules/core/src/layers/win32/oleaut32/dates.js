/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The automation DATE: days since 30 December 1899 in the whole part, the
 * time of day in the fraction. Before that day the whole part counts back
 * and the fraction still counts forward, so -5.25 is six in the morning of
 * 25 December 1899 -- the value is not linear across the epoch.
 */

const DAY_MS = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);
/** The first and last days a DATE may name: 1 January 100, 31 December 9999. */
const FIRST_DAY = -657434;
const LAST_DAY = 2958465;

export const VAR_TIMEVALUEONLY = 1;
export const VAR_DATEVALUEONLY = 2;

/**
 * @typedef {Object} Fields
 * @property {number} year @property {number} month @property {number} day
 * @property {number} hour @property {number} minute @property {number} second
 * @property {number} milliseconds @property {number} dayOfWeek @property {number} dayOfYear
 */

/**
 * The day number of a calendar date, with month and day free to overflow.
 *
 * @param {number} year @param {number} month @param {number} day
 */
const dayNumber = (year, month, day)=>{
    const at = new Date(EPOCH);
    at.setUTCFullYear(year, month - 1, day);
    return Math.round((at.getTime() - EPOCH) / DAY_MS);
};

/**
 * A DATE as its calendar fields, the time rounded to the second; null when
 * the day is outside the years 100 to 9999.
 *
 * @param {number} date
 * @returns {Fields | null}
 */
export function fieldsOf(date){
    const whole = Math.trunc(date);
    if (!Number.isFinite(date) || whole < FIRST_DAY || whole > LAST_DAY)
    {
        return null;
    }
    // A second's rounding never carries into the next day.
    const seconds = Math.min(86399, Math.round(Math.abs(date - whole) * 86400));
    const at = new Date(EPOCH + whole * DAY_MS);
    const year = at.getUTCFullYear();
    return {
        year,
        month: at.getUTCMonth() + 1,
        day: at.getUTCDate(),
        hour: Math.floor(seconds / 3600),
        minute: Math.floor(seconds / 60) % 60,
        second: seconds % 60,
        milliseconds: 0,
        dayOfWeek: at.getUTCDay(),
        dayOfYear: whole - dayNumber(year, 1, 1) + 1,
    };
}

/**
 * A DATE from calendar fields, every field free to roll into the next one;
 * milliseconds are not part of a DATE. The year is taken as given.
 *
 * @param {{ year: number, month: number, day: number, hour: number,
 *     minute: number, second: number }} fields
 * @param {number} [flags]
 */
export function dateOf(fields, flags = 0){
    const total = dayNumber(fields.year, fields.month, fields.day) * 86400
        + fields.hour * 3600 + fields.minute * 60 + fields.second;
    const day = Math.floor(total / 86400);
    const time = (total - day * 86400) / 86400;
    if ((flags & VAR_TIMEVALUEONLY) !== 0)
    {
        return time;
    }
    if ((flags & VAR_DATEVALUEONLY) !== 0)
    {
        return day;
    }
    return day < 0 ? day - time : day + time;
}

/**
 * VarDateFromUdate's year: the month rolls into it first, then a year below
 * 100 is two digits -- below 30 this century, from 30 the last.
 *
 * @param {number} year @param {number} month
 * @returns {{ year: number, month: number }}
 */
export function rollYear(year, month){
    const rolled = year + Math.floor((month - 1) / 12);
    const within = ((month - 1) % 12 + 12) % 12 + 1;
    if (rolled < 0)
    {
        return { year: 2000 + rolled, month: within };
    }
    return { year: rolled < 30 ? 2000 + rolled : rolled < 100 ? 1900 + rolled : rolled,
        month: within };
}

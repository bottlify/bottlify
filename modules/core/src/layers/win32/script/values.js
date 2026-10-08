/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The values a script engine here works with, shared by every language on
 * this runtime.
 *
 * A script value is a host value of the matching kind -- undefined, null, a
 * boolean, a number, a string -- or an object: one of the language's own, an
 * external object (`external.js`), or a {@link ForeignValue}. The last is a
 * VARIANT the language has no type for, kept as it arrived so that it can be
 * handed back unchanged: an automation date, a SAFEARRAY, an error code. A
 * language decides what such a value does when it is used; JScript, for one,
 * calls a date's type "date" and anything else it cannot read "unknown".
 *
 * @typedef {any} Value
 */

import {
    VT_ARRAY, VT_DATE, VT_ERROR, VT_TYPEMASK, VT_UNKNOWN, VT_VARIANT,
} from '../oleaut32/vartypes.js';

/**
 * A SAFEARRAY's contents, read out of guest memory: the bounds of each
 * dimension, the first (fastest-varying) first, and the elements in the
 * order the array stores them -- the first index varying fastest.
 *
 * @typedef {Object} SafeArrayValue
 * @property {number} elementType  The VARTYPE of an element: VT_VARIANT, VT_BSTR, ...
 * @property {{ lower: number, count: number }[]} bounds
 * @property {Value[]} items
 */

/** A VARIANT the language has no value for, kept as it came. */
export class ForeignValue
{
    /**
     * @param {number} vt  The VARTYPE, VT_ARRAY included for an array.
     * @param {any} value  A date's or a number's double, an error's SCODE,
     *     an interface pointer, or a {@link SafeArrayValue}.
     */
    constructor(vt, value){
        this.vt = vt;
        this.value = value;
    }

    /** @returns {boolean} */
    get isDate(){
        return this.vt === VT_DATE;
    }

    /** @returns {boolean} */
    get isArray(){
        return (this.vt & VT_ARRAY) !== 0;
    }
}

/** @param {number} oleDate @returns {ForeignValue} */
export const dateValue = oleDate=>new ForeignValue(VT_DATE, oleDate);

/** @param {number} scode @returns {ForeignValue} */
export const errorValue = scode=>new ForeignValue(VT_ERROR, scode | 0);

/** @param {SafeArrayValue} array @returns {ForeignValue} */
export const arrayValue = array=>new ForeignValue(VT_ARRAY | (array.elementType & VT_TYPEMASK),
    array);

/**
 * A one-dimensional array of variants, as a language makes one to hand a
 * list to an automation object.
 *
 * @param {Value[]} items @returns {ForeignValue}
 */
export const variantArray = items=>arrayValue({
    elementType: VT_VARIANT, bounds: [{ lower: 0, count: items.length }], items,
});

/** @param {number} pointer @returns {ForeignValue} */
export const unknownValue = pointer=>new ForeignValue(VT_UNKNOWN, pointer >>> 0);

const DAY = 86400000;
/** Days from 30 December 1899, where an automation date counts from, to 1970. */
const OLE_EPOCH_DAYS = 25569;

/**
 * An automation date as milliseconds since 1970 on the same wall clock: a
 * VT_DATE carries no time zone, so the answer is local time read as if it
 * were UTC, which the language then places in its zone.
 *
 * The day is the whole part, rounded toward zero, and the time the fraction's
 * magnitude: -1.25 is 29 December 1899 at six in the morning, not 31 December
 * at six in the evening.
 *
 * @param {number} oleDate @returns {number}
 */
export function oleDateToWallTime(oleDate){
    if (!Number.isFinite(oleDate))
    {
        return NaN;
    }
    const days = Math.trunc(oleDate);
    const fraction = Math.abs(oleDate - days);
    return (days - OLE_EPOCH_DAYS) * DAY + Math.round(fraction * DAY);
}

/**
 * The other way: wall-clock milliseconds since 1970 as an automation date.
 *
 * @param {number} wallTime @returns {number}
 */
export function wallTimeToOleDate(wallTime){
    if (!Number.isFinite(wallTime))
    {
        return NaN;
    }
    const days = Math.floor(wallTime / DAY);
    const fraction = (wallTime - days * DAY) / DAY;
    const day = days + OLE_EPOCH_DAYS;
    return day < 0 ? day - fraction : day + fraction;
}

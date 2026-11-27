/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VarFormat's format strings -- Visual Basic's Format -- in the English
 * locale: what a value looks like under "#,##0.00", "dd mmm yyyy", ">@" or
 * a named format such as "Standard" or "Long Date".
 *
 * A format is up to four sections split by semicolons: for a positive
 * number, a negative one (shown without its sign), zero, and null. Within a
 * section, 0 and # stand for digits (0 always written, # only when there is
 * one), a dot for the decimal point, a comma between digit placeholders for
 * grouping by thousands, % for a hundredfold value and a percent sign, and
 * E+, E-, e+ or e- for an exponent; a backslash takes the next character as
 * it is, quotes take what is between them, and anything else is itself. A
 * date is written by d, m, y, h, n, s, w and q runs, AM/PM and its kin, and a
 * string by the at sign, the ampersand and the case marks < and >.
 */

import { fieldsOf } from './dates.js';
import { textOfDate } from './vartext.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

/** @param {number} index @param {boolean} short */
export const dayName = (index, short)=>(short ? DAYS[index].slice(0, 3) : DAYS[index]);
/** @param {number} index  0 for January @param {boolean} short */
export const monthName = (index, short)=>(short ? MONTHS[index].slice(0, 3) : MONTHS[index]);

/** The formats a name stands for, by the name in lower case. */
const NAMED = new Map([
    ['general number', null],
    ['currency', '$#,##0.00;($#,##0.00)'],
    ['fixed', '0.00'],
    ['standard', '#,##0.00'],
    ['percent', '0.00%'],
    ['scientific', '0.00E+00'],
    ['general date', 'c'],
    ['long date', 'dddd, mmmm dd, yyyy'],
    ['medium date', 'dd-mmm-yy'],
    ['short date', 'm/d/yyyy'],
    ['long time', 'h:nn:ss AM/PM'],
    ['medium time', 'hh:nn AM/PM'],
    ['short time', 'hh:nn'],
]);

/** The named formats that answer a word for a number: the first for non-zero. */
const WORDS = new Map([['yes/no', ['Yes', 'No']], ['true/false', ['True', 'False']],
    ['on/off', ['On', 'Off']]]);

/**
 * A value as VarFormat formats it.
 *
 * @typedef {{ kind: 'number', value: number } | { kind: 'date', value: number }
 *     | { kind: 'string', value: string } | { kind: 'null' } | { kind: 'empty' }} Formattable
 */

/**
 * The text a format makes of a value, or null when the value has no form
 * under it (a string that is no number under a number format falls back to
 * the string itself).
 *
 * @param {Formattable} value @param {string} format
 * @param {number} firstDay  1 for Sunday to 7, 0 for the locale's (Sunday)
 * @param {(value: number) => string} general  a number as VarBstrFromR8 spells it
 * @returns {string | null} null for a null with no section for it
 */
export function formatValue(value, format, firstDay, general){
    const named = format.toLowerCase();
    if (WORDS.has(named))
    {
        const words = /** @type {string[]} */ (WORDS.get(named));
        if (value.kind === 'number' || value.kind === 'date')
        {
            return value.value !== 0 ? words[0] : words[1];
        }
    }
    const actual = NAMED.has(named) ? NAMED.get(named) ?? '' : format;
    const sections = splitSections(actual);
    if (value.kind === 'null')
    {
        return sections.length > 3 ? literalsOf(sections[3]) : null;
    }
    if (value.kind === 'empty')
    {
        return formatValue({ kind: 'number', value: 0 }, format, firstDay, general) ?? '';
    }
    if (value.kind === 'string')
    {
        if (actual === '' || isStringFormat(sections[0]))
        {
            return formatString(value.value, sections[0] ?? '');
        }
        const number = Number(value.value.trim());
        if (value.value.trim() === '' || Number.isNaN(number))
        {
            return value.value;
        }
        return formatValue({ kind: isDateFormat(sections[0]) ? 'date' : 'number', value: number },
            format, firstDay, general) ?? '';
    }
    if (actual === '')
    {
        return value.kind === 'date' ? textOfDate(value.value, 0) ?? '' : general(value.value);
    }
    if (isStringFormat(sections[0]))
    {
        return formatString(value.kind === 'date' ? textOfDate(value.value, 0) ?? ''
            : general(value.value), sections[0]);
    }
    if (value.kind === 'date' || isDateFormat(sections[0]))
    {
        return formatDate(value.value, sections[0], firstDay);
    }
    const number = value.value;
    if (number < 0 && sections.length > 1 && sections[1] !== '')
    {
        return formatNumber(-number, sections[1]);
    }
    if (number === 0 && sections.length > 2 && sections[2] !== '')
    {
        return formatNumber(0, sections[2]);
    }
    // One section for both signs: a minus in front of what is not zero once written.
    const text = formatNumber(Math.abs(number), sections[0]);
    return number < 0 && /[1-9]/.test(text) ? `-${text}` : text;
}

/**
 * A format cut at the semicolons that are not quoted or escaped.
 *
 * @param {string} format
 */
function splitSections(format){
    /** @type {string[]} */
    const sections = [''];
    for (let at = 0; at < format.length; at++)
    {
        const char = format[at];
        if (char === '\\' && at + 1 < format.length)
        {
            sections[sections.length - 1] += char + format[++at];
        }
        else if (char === '"')
        {
            const end = format.indexOf('"', at + 1);
            const close = end < 0 ? format.length : end;
            sections[sections.length - 1] += format.slice(at, close + 1);
            at = close;
        }
        else if (char === ';')
        {
            sections.push('');
        }
        else
        {
            sections[sections.length - 1] += char;
        }
    }
    return sections;
}

/**
 * A format's pieces: each placeholder or mark on its own, quoted and
 * escaped text as literals.
 *
 * @param {string} section
 * @returns {{ code: string, text: string }[]} code '' for a literal
 */
function tokens(section){
    /** @type {{ code: string, text: string }[]} */
    const list = [];
    for (let at = 0; at < section.length; at++)
    {
        const char = section[at];
        if (char === '\\')
        {
            list.push({ code: '', text: section[at + 1] ?? '' });
            at++;
        }
        else if (char === '"')
        {
            const end = section.indexOf('"', at + 1);
            const close = end < 0 ? section.length : end;
            list.push({ code: '', text: section.slice(at + 1, close) });
            at = close;
        }
        else if ((char === 'E' || char === 'e') && (section[at + 1] === '+'
            || section[at + 1] === '-'))
        {
            list.push({ code: 'E', text: char + section[at + 1] });
            at++;
        }
        else if ('0#.,%'.includes(char))
        {
            list.push({ code: char, text: char });
        }
        else
        {
            list.push({ code: '', text: char });
        }
    }
    return list;
}

/** @param {string} section */
const literalsOf = section=>tokens(section).map(token=>token.text).join('');

/** @param {string | undefined} section */
const isStringFormat = section=>section !== undefined && /[@&<>!]/.test(unquoted(section))
    && !/[0#]/.test(unquoted(section));

/** @param {string | undefined} section */
const isDateFormat = section=>section !== undefined
    && /[dmyhnswqc]|am\/pm|a\/p/i.test(unquoted(section)) && !/[0#]/.test(unquoted(section));

/** A section with its quoted and escaped text taken out. @param {string} section */
const unquoted = section=>section.replace(/"[^"]*"?|\\./g, '');

/**
 * A non-negative number under one section of a number format.
 *
 * @param {number} number @param {string} section
 */
function formatNumber(number, section){
    const list = tokens(section);
    const exponentAt = list.findIndex(token=>token.code === 'E');
    const point = list.findIndex((token, index)=>token.code === '.'
        && (exponentAt < 0 || index < exponentAt));
    const mantissaEnd = exponentAt < 0 ? list.length : exponentAt;
    const isDigit = (/** @type {{ code: string }} */ token)=>token.code === '0'
        || token.code === '#';
    // A comma between two digit placeholders groups by thousands, and is not
    // itself written; any other comma is text.
    let grouped = false;
    list.forEach((token, index)=>{
        if (token.code !== ',')
        {
            return;
        }
        const before = list.slice(0, index).reverse().find(other=>other.code !== ',');
        const after = list.slice(index + 1).find(other=>other.code !== ',');
        if (before && after && isDigit(before) && isDigit(after) && (point < 0 || index < point))
        {
            grouped = true;
            token.code = 'group';
        }
        else
        {
            token.code = '';
        }
    });
    const integerSlots = list.slice(0, point < 0 ? mantissaEnd : point).filter(isDigit);
    const fractionSlots = point < 0 ? [] : list.slice(point + 1, mantissaEnd).filter(isDigit);
    const percents = list.filter(token=>token.code === '%').length;
    let value = number * 100 ** percents;
    let exponent = 0;
    if (exponentAt >= 0 && value !== 0)
    {
        // As many digits before the point as there are placeholders for
        // them; with none, the mantissa is below one.
        const integerDigits = integerSlots.length;
        exponent = Math.floor(Math.log10(value)) - integerDigits + 1;
        value /= 10 ** exponent;
        if (round(value, fractionSlots.length) >= 10 ** integerDigits)
        {
            value /= 10;
            exponent++;
        }
    }
    const rounded = roundedDigits(value, fractionSlots.length);
    let whole = rounded.whole.replace(/^0+/, '');
    let fraction = rounded.fraction;

    // The fraction: each placeholder a digit, a trailing run of # without its zeros.
    let keep = fraction.length;
    for (let index = fractionSlots.length - 1; index >= 0; index--)
    {
        if (fractionSlots[index].code !== '#' || fraction[index] !== '0')
        {
            break;
        }
        keep = index;
    }
    fraction = fraction.slice(0, keep);

    // The whole part: digits filled from the right, zeros where a 0 has none,
    // whatever is left over in front of the first placeholder.
    const zeros = integerSlots.length - integerSlots.findIndex(slot=>slot.code === '0');
    if (integerSlots.some(slot=>slot.code === '0') && whole.length < zeros)
    {
        whole = whole.padStart(zeros, '0');
    }
    if (grouped)
    {
        whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    const digits = [...whole];
    const integerTokens = list.map((token, index)=>({ token, index }))
        .filter(({ token, index })=>isDigit(token) && index < (point < 0 ? mantissaEnd : point));
    /** @type {Map<number, string>} */
    const written = new Map();
    for (let slot = integerTokens.length - 1; slot >= 0; slot--)
    {
        const { index } = integerTokens[slot];
        if (slot === 0)
        {
            written.set(index, digits.join(''));
        }
        else
        {
            let piece = digits.pop() ?? '';
            // A group separator travels with the digit before it.
            while (digits[digits.length - 1] === ',' && digits.length > 1)
            {
                piece = digits.pop() + piece;
            }
            written.set(index, piece);
        }
    }

    let out = '';
    let fractionIndex = 0;
    for (let index = 0; index < mantissaEnd; index++)
    {
        const token = list[index];
        if (index === point)
        {
            out += '.';
        }
        else if (isDigit(token))
        {
            if (point >= 0 && index > point)
            {
                out += fraction[fractionIndex] ?? '';
                fractionIndex++;
            }
            else
            {
                out += written.get(index) ?? '';
            }
        }
        else if (token.code === '%')
        {
            out += '%';
        }
        else if (token.code !== 'group')
        {
            out += token.text;
        }
    }
    if (exponentAt >= 0)
    {
        const mark = list[exponentAt].text;
        const rest = list.slice(exponentAt + 1);
        const placeholders = rest.filter(isDigit);
        const minimum = placeholders.filter(slot=>slot.code === '0').length;
        const sign = exponent < 0 ? '-' : mark[1] === '+' ? '+' : '';
        out += `${mark[0]}${sign}${String(Math.abs(exponent)).padStart(minimum, '0')}`;
        out += rest.filter(token=>!isDigit(token)).map(token=>token.text).join('');
    }
    return out;
}

/**
 * A number rounded to `places`, a half away from zero, by the digits its
 * double spells.
 *
 * @param {number} value @param {number} places
 */
function round(value, places){
    const { whole, fraction } = roundedDigits(value, places);
    return Number(`${whole}.${fraction || '0'}`);
}

/**
 * @param {number} value @param {number} places
 * @returns {{ whole: string, fraction: string }}
 */
function roundedDigits(value, places){
    const spelled = Number(value.toPrecision(15));
    const [mantissa, power] = spelled.toExponential(14).split('e');
    const digits = mantissa.replace('.', '');
    const exponent = Number(power);
    // As an integer count of 10^-places.
    const shift = exponent - 14 + places;
    let scaled = BigInt(digits);
    if (shift >= 0)
    {
        scaled *= 10n ** BigInt(shift);
    }
    else
    {
        const divisor = 10n ** BigInt(-shift);
        const rest = scaled % divisor;
        scaled /= divisor;
        if (rest * 2n >= divisor)
        {
            scaled++;
        }
    }
    const text = scaled.toString().padStart(places + 1, '0');
    return { whole: text.slice(0, text.length - places), fraction: places === 0 ? ''
        : text.slice(text.length - places) };
}

/**
 * A date under a date format: runs of d, m, y, h, n, s, w, q and the AM/PM
 * marks, an m or mm minutes when the date token before it is an hour.
 *
 * @param {number} date @param {string} section @param {number} firstDay
 */
function formatDate(date, section, firstDay){
    const fields = fieldsOf(date);
    if (!fields)
    {
        return '';
    }
    const twelve = /am\/pm|a\/p|ampm/i.test(unquoted(section));
    const hour12 = fields.hour % 12 === 0 ? 12 : fields.hour % 12;
    const hour = twelve ? hour12 : fields.hour;
    let out = '';
    let lastCode = '';
    const pad = (/** @type {number} */ number)=>String(number).padStart(2, '0');
    for (let at = 0; at < section.length;)
    {
        const rest = section.slice(at);
        const char = section[at];
        if (char === '\\')
        {
            out += section[at + 1] ?? '';
            at += 2;
            continue;
        }
        if (char === '"')
        {
            const end = section.indexOf('"', at + 1);
            const close = end < 0 ? section.length : end;
            out += section.slice(at + 1, close);
            at = close + 1;
            continue;
        }
        const marks = /^(am\/pm|a\/p|ampm)/i.exec(rest);
        if (marks)
        {
            const pm = fields.hour >= 12;
            const mark = marks[1];
            if (mark.toLowerCase() === 'ampm')
            {
                out += pm ? 'PM' : 'AM';
            }
            else
            {
                const [am, pmText] = mark.split('/');
                out += pm ? pmText : am;
            }
            at += mark.length;
            continue;
        }
        const run = /^([dDmMyYhHnNsSwWqQcC])\1*/.exec(rest);
        if (!run)
        {
            out += char;
            at++;
            continue;
        }
        let code = run[1].toLowerCase();
        let length = run[0].length;
        // A run of y is read greedily -- yyyy, yy, y -- so yyy is yy then y.
        let consumed = length;
        if (code === 'y')
        {
            length = length >= 4 ? 4 : length >= 2 ? 2 : 1;
            consumed = length;
        }
        else if (code === 'd' || code === 'm')
        {
            length = Math.min(length, code === 'd' ? 6 : 4);
        }
        else
        {
            length = Math.min(length, code === 'w' ? 2 : code === 'q' || code === 'c' ? 1 : 2);
        }
        if (code === 'm' && length <= 2 && lastCode === 'h')
        {
            code = 'n';
        }
        switch (code)
        {
            case 'd':
                out += length === 1 ? String(fields.day) : length === 2 ? pad(fields.day)
                    : length === 3 ? dayName(fields.dayOfWeek, true)
                        : length === 4 ? dayName(fields.dayOfWeek, false)
                            : length === 5 ? `${fields.month}/${fields.day}/${fields.year}`
                                : `${dayName(fields.dayOfWeek, false)}, `
                                    + `${monthName(fields.month - 1, false)} ${pad(fields.day)}, `
                                    + `${fields.year}`;
                break;
            case 'm':
                out += length === 1 ? String(fields.month) : length === 2 ? pad(fields.month)
                    : monthName(fields.month - 1, length === 3);
                break;
            case 'y':
                out += length === 1 ? String(fields.dayOfYear) : length === 2
                    ? pad(fields.year % 100) : String(fields.year).padStart(4, '0');
                break;
            case 'h':
                out += length === 1 ? String(hour) : pad(hour);
                break;
            case 'n':
                out += length === 1 ? String(fields.minute) : pad(fields.minute);
                break;
            case 's':
                out += length === 1 ? String(fields.second) : pad(fields.second);
                break;
            case 'w':
                if (length === 1)
                {
                    const first = firstDay === 0 ? 1 : firstDay;
                    out += String((fields.dayOfWeek - (first - 1) + 7) % 7 + 1);
                }
                else
                {
                    out += String(Math.floor((fields.dayOfYear - 1 + 7) / 7));
                }
                break;
            case 'q':
                out += String(Math.floor((fields.month - 1) / 3) + 1);
                break;
            default:
                out += textOfDate(date, 0) ?? '';
                break;
        }
        lastCode = code;
        at += consumed;
    }
    return out;
}

/**
 * A string under a string format: the at sign a character or a space, the
 * ampersand a character or nothing, filled from the right unless ! asks for
 * the left, < and > the case of all of it.
 *
 * @param {string} text @param {string} section
 */
function formatString(text, section){
    if (section === '')
    {
        return text;
    }
    const plain = unquoted(section);
    const upper = plain.includes('>') && !plain.includes('<');
    const lower = plain.includes('<') && !plain.includes('>');
    const fromLeft = plain.includes('!');
    const source = upper ? text.toUpperCase() : lower ? text.toLowerCase() : text;
    const list = tokens(section).filter(token=>!(token.code === '' && '<>!'.includes(token.text)));
    const slots = list.filter(token=>token.code === '' && (token.text === '@' || token.text === '&')
        && !isQuoted(token));
    const chars = [...source];
    /** @type {string[]} */
    const fills = slots.map(()=>'');
    // Text as long as the placeholders or longer goes in from the left, a
    // character to each, and what is left over after everything; shorter
    // text fills them from the right, unless ! asks for the left.
    let remainder = '';
    if (fromLeft || chars.length >= slots.length)
    {
        slots.forEach((slot, index)=>{
            fills[index] = chars.shift() ?? (slot.text === '@' ? ' ' : '');
        });
        remainder = chars.join('');
    }
    else
    {
        for (let index = slots.length - 1; index >= 0; index--)
        {
            fills[index] = chars.pop() ?? (slots[index].text === '@' ? ' ' : '');
        }
    }
    let slot = 0;
    return list.map(token=>(slots.includes(token) ? fills[slot++] : token.text)).join('')
        + remainder;
}

/** @param {{ code: string, text: string }} token */
const isQuoted = token=>token.text.length !== 1;

/**
 * VarFormatNumber, VarFormatPercent and VarFormatCurrency: a number to a
 * fixed count of places, a half away from zero, in the English locale's
 * spelling -- a leading zero, groups of three, and a minus sign -- unless
 * the caller's tristates ask otherwise (-1 yes, 0 no, -2 the locale's).
 *
 * @param {number} number @param {number} places  -1 for the locale's two
 * @param {number} leading @param {number} parens @param {number} group
 * @param {{ prefix?: string, suffix?: string, parensByDefault?: boolean }} [shape]
 */
export function formatFixed(number, places, leading, parens, group, shape = {}){
    const count = places < 0 ? 2 : places;
    const rounded = roundedDigits(Math.abs(number), count);
    let whole = rounded.whole.replace(/^0+(?=\d)/, '');
    if (leading === 0 && whole === '0')
    {
        whole = '';
    }
    if (group !== 0)
    {
        whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    const text = `${shape.prefix ?? ''}${whole}${count > 0 ? `.${rounded.fraction}` : ''}`
        + `${shape.suffix ?? ''}`;
    const negative = number < 0 && /[1-9]/.test(rounded.whole + rounded.fraction);
    const useParens = parens === -1 || (parens === -2 && shape.parensByDefault === true);
    return !negative ? text : useParens ? `(${text})` : `-${text}`;
}

/**
 * VarFormatDateTime's named formats: 0 the general date, 1 the long date,
 * 2 the short date, 3 the long time, 4 the short time.
 *
 * @param {number} date @param {number} named
 * @returns {string | null} null for a name there is not
 */
export function formatNamedDate(date, named){
    const formats = ['c', 'dddd, mmmm dd, yyyy', 'm/d/yyyy', 'h:nn:ss AM/PM', 'hh:nn'];
    return named >= 0 && named < formats.length ? formatDate(date, formats[named], 0) : null;
}

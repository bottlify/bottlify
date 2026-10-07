/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    boolOf, dateFromText, exactOfNumber, numberOf, parseNumber, textOfCurrency, textOfDate,
} from './vartext.js';
import { VAR_DATEVALUEONLY, VAR_TIMEVALUEONLY } from './dates.js';

/** @param {string} text */
const read = text=>{
    const parsed = parseNumber(text);
    return parsed === null ? null : numberOf(parsed);
};

test('a number string is read whole, in the English spelling', ()=>{
    assert.equal(read('0'), 0);
    assert.equal(read(' -1.5 '), -1.5);
    assert.equal(read('\t+12\n'), 12);
    assert.equal(read('1,000.25'), 1000.25);
    assert.equal(read('1,,0,00'), 1000, 'separators anywhere after the first digit');
    assert.equal(read('.5'), 0.5);
    assert.equal(read('5.'), 5);
    assert.equal(read('1.5e3'), 1500);
    assert.equal(read('25E-1'), 2.5);
    assert.equal(read('1e-94938484'), 0, 'too small to be anything but zero');
    assert.equal(read('1e400'), Infinity, 'past the doubles, for the caller to call an overflow');
    assert.equal(read(' 7'), 7, 'a no-break space is a space');
});

test('a sign goes before or after, parentheses make a negative, and $ is the currency', ()=>{
    assert.equal(read('5-'), -5);
    assert.equal(read('(5)'), -5);
    assert.equal(read('($1,234.50)'), -1234.5);
    assert.equal(read('$12'), 12);
    assert.equal(read('-$12'), -12);
    assert.equal(read('$-12'), -12);
    assert.equal(read('12$'), 12);
    assert.equal(read('&H10'), 16, 'VB hexadecimal');
    assert.equal(read('&hff'), 255);
    assert.equal(read('&O17'), 15, 'VB octal');
    assert.equal(read('&O18'), null, 'an octal 8 is no digit');
});

test('anything left over, or nothing at all, is no number', ()=>{
    for (const text of ['', ' ', '12abc', 'abc', '-', '+-5', '-5-', '(-5)', '(5', '$$5', ',5',
        '.', 'e5', '- 55', '0x10', 'Infinity', 'NaN', '1 2', '#TRUE#'])
    {
        assert.equal(parseNumber(text), null, JSON.stringify(text));
    }
});

test('a number string is carried exactly for a currency or a decimal', ()=>{
    /** @param {string} text */
    const exact = text=>exactOfNumber(/** @type {any} */ (parseNumber(text)));
    assert.deepEqual(exact('1.23456'), { value: 123456n, scale: 5 });
    assert.deepEqual(exact('-1200'), { value: -1200n, scale: 0 });
    assert.deepEqual(exact('0.000'), { value: 0n, scale: 0 });
    assert.deepEqual(exact('922337203685477.5807'), { value: 9223372036854775807n, scale: 4 },
        'no double in between');
    assert.equal(exact('1e50'), null, 'past anything exact');
    assert.deepEqual(exact('1e-50'), { value: 0n, scale: 0 });
});

test('a boolean string is #TRUE#, #FALSE#, True, False or a number', ()=>{
    // VarBoolFromStr's answers on Windows (vartype.c).
    assert.equal(boolOf('#TRUE#'), -1);
    assert.equal(boolOf('#FALSE#'), 0);
    assert.equal(boolOf('#False#'), null, 'the # forms are matched as spelled');
    assert.equal(boolOf('false'), 0, 'the words in any case');
    assert.equal(boolOf('TRUE'), -1);
    assert.equal(boolOf('On'), null);
    assert.equal(boolOf('Yes'), null);
    assert.equal(boolOf('0'), 0);
    assert.equal(boolOf('-1'), -1);
    assert.equal(boolOf('+1'), -1);
    assert.equal(boolOf('0.1'), -1, 'read as a double, and not zero');
    assert.equal(boolOf(''), null);
});

/** The year a test pretends it is. */
const YEAR = 2026;

/** @param {string} text @param {number} [flags] */
const date = (text, flags = 0)=>dateFromText(text, flags, ()=>YEAR);

/** @param {number} year @param {number} month @param {number} dayOfMonth */
const day = (year, month, dayOfMonth)=>Math.round((Date.UTC(year, month - 1, dayOfMonth)
    - Date.UTC(1899, 11, 30)) / 86400000);

/** @param {number | null} actual @param {number} expected @param {string} [message] */
const near = (actual, expected, message)=>{
    assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9,
        `${message ?? ''} ${actual} against ${expected}`);
};

test('a time alone needs a separator or a meridian, and stays in range', ()=>{
    // VarDateFromStr's answers on Windows (vartype.c), English locale.
    near(date('1 am'), 1 / 24);
    near(date('0.1'), 1 / 1440, 'a point is a time separator');
    near(date('0.40'), 40 / 1440);
    near(date('2.5'), 125 / 1440);
    near(date('0:20'), 20 / 1440);
    near(date('3:5'), 185 / 1440);
    near(date('00:00 AM'), 0);
    near(date('12:59 A'), 59 / 1440);
    near(date('00:00 p'), 0.5);
    near(date('12:59 pm'), 0.5 + 59 / 1440);
    near(date('13:00 AM'), 13 / 24, 'a meridian past twelve is ignored');
    near(date('0.1.0'), 1 / 1440);
    near(date('1.5.2'), (3600 + 300 + 2) / 86400);
    for (const text of ['0.60', '24.00', '0:60', '24:00', '0', '1', '0.', '.0', '-1.1', '1.1-'])
    {
        assert.equal(date(text), null, text);
    }
});

test('two numbers are a month and a day of this year, or a year and a month', ()=>{
    assert.equal(date('1 2'), day(YEAR, 1, 2));
    assert.equal(date('2 1'), day(YEAR, 2, 1));
    assert.equal(date('14 1'), day(YEAR, 1, 14), 'the one that is no month is the day');
    assert.equal(date('1 14'), day(YEAR, 1, 14));
    assert.equal(date('30 2'), day(1930, 2, 1), 'no such day: a year and a month');
    assert.equal(date('2 30'), day(1930, 2, 1));
    assert.equal(date('32 49'), null);
    assert.equal(date('0 49'), null);
    assert.equal(date('Jan 2'), day(YEAR, 1, 2));
    assert.equal(date('2 Jan'), day(YEAR, 1, 2));
    for (const text of ['Jan 35', '35 Jan', 'Jan-35', '35-Jan', 'Jan/35', '35/Jan'])
    {
        assert.equal(date(text), day(1935, 1, 1), text);
    }
});

test('three numbers go month, day, year first, then year, month, day, then day, month, year',
    ()=>{
        assert.equal(date('1 2 3'), 37623);
        assert.equal(date('14 2 3'), 41673);
        assert.equal(date('2 14 3'), 37666);
        assert.equal(date('2 3 14'), 41673);
        assert.equal(date('32 2 3'), 11722, 'a two-digit year from 30 is the 1900s');
        assert.equal(date('2 3 32'), 11722);
        assert.equal(date('1 1 0'), 36526);
        assert.equal(date('12 31 29'), 47483);
        assert.equal(date('1 1 30'), 10959);
        assert.equal(date('31 12 49'), 18263);
        assert.equal(date('12 31 99'), 36525);
        assert.equal(date('1 1 100'), -657434);
        assert.equal(date('2 32 3'), null);
    });

test('a date and a time go together, the time first or last', ()=>{
    near(date('3 am 1 2'), day(YEAR, 1, 2) + 0.125);
    near(date('1 2 3 am'), day(YEAR, 1, 2) + 0.125);
    near(date('1.2 3 4'), day(YEAR, 3, 4) + 62 / 1440);
    near(date('3 4 1.2'), day(YEAR, 3, 4) + 62 / 1440);
    near(date('1.2.3 4 5'), day(YEAR, 4, 5) + 3723 / 86400);
    near(date('1.2 3 4 5'), 38415 + 62 / 1440);
    near(date('1 2 3 4.5'), 37623 + 245 / 1440);
    near(date('1.2.3 4 5 6'), 38812 + 3723 / 86400);
    near(date('1 2 3 4.5.6'), 37623 + (4 * 3600 + 5 * 60 + 6) / 86400);
    for (const text of ['1 2 am', '1 am 2', '1.5 2', '1 5.2', '1 2 am 3', '1 2.3 4', '1.2.3.4',
        '1.2 3.4', '1 2 3 4', '1 am 2 3.4', '1.2 3 am 4', '1.2 3 4 5 am', '1 2 3 4 5'])
    {
        assert.equal(date(text), null, text);
    }
});

test('the usual spellings of a date are read, and other locales\' are not', ()=>{
    for (const text of ['2 January, 1970', '2 January 1970', '2 Jan 1970', '2/Jan/1970',
        '2-Jan-1970', '1 2 1970', '1/2/1970', '1-2-1970', 'January 2, 1970'])
    {
        assert.equal(date(text), 25570, text);
    }
    assert.equal(date('13-1-1970'), 25581);
    assert.equal(date('1970-1-13'), 25581);
    near(date('6/30/2011 01:20:34'), 40724.05594907407);
    near(date('6/30/2011 01:20:34 PM'), 40724.55594907407);
    near(date('2013-05-14 02:04:12'), 41408.08625000001);
    near(date('6/30/2011　1:20:34'), 40724.05594907407, 'an ideographic space');
    for (const text of ['2013-05-14 02:04:12.017000000', '02.01.1970', 'True', '1;2;3',
        '(1:2)', '1|2|3', ''])
    {
        assert.equal(date(text), null, text);
    }
});

test('half a date can be kept, and with no clock a date without a year is refused', ()=>{
    assert.equal(date('6/30/2011 06:00', VAR_DATEVALUEONLY), 40724);
    near(date('6/30/2011 06:00', VAR_TIMEVALUEONLY), 0.25);
    assert.equal(dateFromText('1 2', 0, ()=>null), null);
    assert.equal(dateFromText('1 2 1970', 0, ()=>null), 25570, 'a year given needs no clock');
});

test('a date is spelled M/D/YYYY h:mm:ss AM, each half only when it has one', ()=>{
    // VarBstrFromDate's answers on Windows (vartype.c), English locale.
    assert.equal(textOfDate(0, 0), '12:00:00 AM');
    assert.equal(textOfDate(3.34, 0), '1/2/1900 8:09:36 AM');
    assert.equal(textOfDate(3339.34, 0), '2/20/1909 8:09:36 AM');
    assert.equal(textOfDate(365, 0), '12/30/1900');
    assert.equal(textOfDate(365.25, 0), '12/30/1900 6:00:00 AM');
    assert.equal(textOfDate(1461.5, 0), '12/31/1903 12:00:00 PM');
    assert.equal(textOfDate(-49192.24, 0), '4/24/1765 5:45:36 AM');
    assert.equal(textOfDate(-657434, 0), '1/1/100');
    assert.equal(textOfDate(2958465, 0), '12/31/9999');
    assert.equal(textOfDate(365.25, VAR_DATEVALUEONLY), '12/30/1900');
    assert.equal(textOfDate(365, VAR_TIMEVALUEONLY), '12:00:00 AM');
    assert.equal(textOfDate(2958466, 0), null, 'past the last day');
});

test('a currency is spelled with the places it needs and no more', ()=>{
    // VarBstrFromCy's answers on Windows (vartype.c), English locale.
    assert.equal(textOfCurrency(0n), '0');
    assert.equal(textOfCurrency(10000n), '1');
    assert.equal(textOfCurrency(15000n), '1.5');
    assert.equal(textOfCurrency(-15000n), '-1.5');
    assert.equal(textOfCurrency(4294967295n), '429496.7295');
    assert.equal(textOfCurrency(4294967296n), '429496.7296');
    assert.equal(textOfCurrency(9223372036854775807n), '922337203685477.5807');
    assert.equal(textOfCurrency(9n), '0.0009');
    assert.equal(textOfCurrency(-9223372036854775808n), '-922337203685477.5808');
});

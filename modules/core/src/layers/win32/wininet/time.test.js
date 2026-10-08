/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInternetTime, timeValue } from './time.js';

/** [year, month, dayOfWeek, day, hour, minute, second] */
const JAN_7_2005 = [2005, 1, 5, 7, 12, 6, 35];
const JAN_11_2022 = [2022, 1, 2, 11, 11, 13, 5];

/** @param {import('./time.js').SystemTime} time */
const fields = time=>[time.year, time.month, time.dayOfWeek, time.day, time.hour, time.minute,
    time.second];

test('every date layout a server sends reads to the same fields', ()=>{
    // The cases Windows' own reader is recorded answering, in Wine's tests.
    const cases = /** @type {[string, number[]][]} */ ([
        ['Fri, 07 Jan 2005 12:06:35 GMT', JAN_7_2005],
        ['Fri, 07 Jan 2005 12:06:35 UTC', JAN_7_2005],
        [' fri, 7 jan 2005 12 06 35', JAN_7_2005],
        ['Fri, 07-01-2005 12:06:35', JAN_7_2005],
        ['5, 07-01-2005 12:06:35 GMT', JAN_7_2005],
        ['5, 07-01-2005 12:06:35 GMT;', JAN_7_2005],
        ['5, 07-01-2005 12:06:35 GMT123', JAN_7_2005],
        ['2, 11 01 2022 11 13 05', JAN_11_2022],
        ['2, 11-01-2022 11#13^05', JAN_11_2022],
        ['2, 11*01/2022 11+13=05', JAN_11_2022],
        ['2, 11-Jan-2022 11:13:05', JAN_11_2022],
        ['Fri Jan 7 12:06:35 2005', JAN_7_2005],
        ['Fri Jan 7 12:06:35 2005 GMT', JAN_7_2005],
        ['Fri, 7-Jan-05 12:06:35 GMT', JAN_7_2005],
        ['Fri Jan 7 12:06:35 99 UTC', [1999, 1, 5, 7, 12, 6, 35]],
        ['Fri Jan 7 12:06:35 100 UTC', [100, 1, 5, 7, 12, 6, 35]],
        ['Fri Jan 7 12:06:35 1600 UTC', [1600, 1, 5, 7, 12, 6, 35]],
        ['Fri Jan 7 12:06:35 30828 UTC', [30828, 1, 5, 7, 12, 6, 35]],
        ['Fri Jan 7 12:06:35 79 UTC', [2079, 1, 5, 7, 12, 6, 35]],
        ['Fri Jan 7 12:06:35 80 UTC', [1980, 1, 5, 7, 12, 6, 35]],
    ]);
    for (const [text, expected] of cases)
    {
        assert.deepEqual(fields(parseInternetTime(text)), expected, text);
    }
});

test('a weekday left out is computed, and text with no date still reads', ()=>{
    assert.deepEqual(fields(parseInternetTime('07 Jan 2005 12:06:35 GMT')), JAN_7_2005);
    assert.deepEqual(fields(parseInternetTime('Fr')), [0, 0, 0, 0, 0, 0, 0]);
    assert.equal(timeValue(parseInternetTime('Fri, 01-Jan-2038 00:00:00 GMT')),
        Date.UTC(2038, 0, 1));
    assert.ok(Number.isNaN(timeValue(parseInternetTime(''))));
});

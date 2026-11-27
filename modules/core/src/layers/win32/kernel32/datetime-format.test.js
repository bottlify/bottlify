/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIME_FORCE24HOURFORMAT, TIME_NOMINUTESORSECONDS, TIME_NOSECONDS, TIME_NOTIMEMARKER,
    renderDate, renderTime } from './datetime-format.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
/** @type {import('./datetime-format.js').CalendarNames} */
const ENGLISH = { days: DAYS, shortDays: DAYS.map(day=>day.slice(0, 3)), months: MONTHS,
    shortMonths: MONTHS.map(month=>month.slice(0, 3)), genitive: null, am: 'AM', pm: 'PM',
    era: 'A.D.' };
/** @param {number} hour @param {number} minute @param {number} second */
const at = (hour, minute, second)=>({ year: 2002, month: 5, day: 4, weekday: 6, hour, minute,
    second });

test('time fields, quotes, and a run longer than the longest form', ()=>{
    // Wine's locale.c test_GetTimeFormatA.
    assert.equal(renderTime('h hh H HH m mm s ss t tt', at(14, 5, 3), ENGLISH, 0),
        '2 02 14 14 5 05 3 03 P PM');
    assert.equal(renderTime('h/H/hh/HH', at(0, 5, 3), ENGLISH, 0), '12/0/12/00');
    assert.equal(renderTime('h:hh:hhh H:HH:HHH m:mm:mmm M:MM:MMM s:ss:sss S:SS:SSS',
        at(8, 56, 13), ENGLISH, 0), '8:08:08 8:08:08 56:56:56 M:MM:MMM 13:13:13 S:SS:SSS');
    assert.equal(renderTime('h \'h\' H \'H\' tt \'tt\'', at(8, 56, 13), ENGLISH, 0),
        '8 h 8 H AM tt');
    for (const [picture, expected] of [['\'\'\'', '\''], ['\'\'\'\'', '\''],
        ['\'\'HHHHHH', '08'], ['\'\'\'HHHHHH\'', '\'HHHHHH'], ['\'\'\'HHHHHH', '\'HHHHHH']])
    {
        assert.equal(renderTime(picture, at(8, 56, 13), ENGLISH, 0), expected, picture);
    }
});

test('a field a flag leaves out takes the text before it and after it up to a space', ()=>{
    const when = at(8, 56, 13);
    assert.equal(renderTime('h:mm:ss tt', when, ENGLISH, TIME_NOMINUTESORSECONDS), '8 AM');
    assert.equal(renderTime('h:m:s tt', when, ENGLISH, TIME_NOSECONDS), '8:56 AM');
    assert.equal(renderTime('h.@:m.@:s.@:tt', when, ENGLISH, TIME_NOSECONDS), '8.@:56AM');
    assert.equal(renderTime('s1s2s3', when, ENGLISH, TIME_NOSECONDS), '');
    assert.equal(renderTime('h1t2tt3m', at(13, 56, 13), ENGLISH, TIME_NOTIMEMARKER), '156');
    assert.equal(renderTime('\'123\'tt', when, ENGLISH, TIME_NOTIMEMARKER), '');
    assert.equal(renderTime('h:m:s tt', at(13, 56, 13), ENGLISH, TIME_FORCE24HOURFORMAT),
        '13:56:13 PM');
});

test('a full month next to the day\'s number takes its genitive form', ()=>{
    const genitive = { ...ENGLISH, genitive: MONTHS.map(month=>`${month}-of`) };
    const when = at(0, 0, 0);
    assert.equal(renderDate('ddd\',\' MMM dd yy', when, ENGLISH), 'Sat, May 04 02');
    assert.equal(renderDate('ddMMMM', when, genitive), '04May-of');
    assert.equal(renderDate('MMMMddd dd', when, genitive), 'MaySat 04');
    assert.equal(renderDate('dd dddMMMM ddd MMMMdd', when, genitive), '04 SatMay Sat May-of04');
    assert.equal(renderDate('ddd\',\' MMMM dd', when, genitive), 'Sat, May-of 04');
    assert.equal(renderDate('dddd d MMMM yyyy gg', when, ENGLISH), 'Saturday 4 May 2002 A.D.');
});

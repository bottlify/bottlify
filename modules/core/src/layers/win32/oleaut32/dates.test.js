/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateOf, fieldsOf, rollYear, VAR_DATEVALUEONLY, VAR_TIMEVALUEONLY } from './dates.js';

/** @param {number} date */
const short = date=>{
    const f = fieldsOf(date);
    return f && [f.day, f.month, f.year, f.hour, f.minute, f.second, f.dayOfWeek, f.dayOfYear];
};

test('a DATE reads as its day and its time, the fraction counting forward either side of 1899',
    ()=>{
        assert.deepEqual(short(29221), [1, 1, 1980, 0, 0, 0, 2, 1]);
        assert.deepEqual(short(0), [30, 12, 1899, 0, 0, 0, 6, 364]);
        assert.deepEqual(short(-657434), [1, 1, 100, 0, 0, 0, 5, 1]);
        assert.deepEqual(short(2958465), [31, 12, 9999, 0, 0, 0, 5, 365]);
        assert.equal(fieldsOf(-657435), null);
        assert.equal(fieldsOf(2958466), null);
        assert.deepEqual(short(29221.7508765432), [1, 1, 1980, 18, 1, 16, 2, 1], 'to the second');
        assert.deepEqual(short(-5.25), [25, 12, 1899, 6, 0, 0, 1, 359]);
        assert.deepEqual(short(-0.25), short(0.25));
        assert.deepEqual(short(2958465.999999)?.slice(3, 6), [23, 59, 59], 'no carry');
    });

test('fields roll into one another, and a two-digit year is placed by its value', ()=>{
    const at = (/** @type {number[]} */ [d, m, y, h = 0, mn = 0, s = 0], flags = 0)=>
        dateOf({ ...rollYear(y, m), day: d, hour: h, minute: mn, second: s }, flags);
    assert.equal(at([1, 1, 1980]), 29221);
    assert.equal(at([31, 12, 90]), 33238);
    assert.equal(at([1, 1, 0]), 36526);
    assert.equal(at([0, 1, 1980]), 29220);
    assert.equal(at([1, 13, 1980]), 29587);
    assert.ok(Math.abs(at([1, 12001, -1020, 18, 1, 16]) - 29221.75087962963) < 1e-9);
    assert.ok(Math.abs(at([1, -1, 1980, 18, 1, 16]) - 29160.7508796296) < 1e-9);
    assert.ok(Math.abs(at([25, 12, 1899, 6]) - -5.25) < 1e-12);
    assert.equal(at([25, 12, 1899, 6], VAR_DATEVALUEONLY), -5);
    assert.equal(at([25, 12, 1899, 6], VAR_TIMEVALUEONLY), 0.25);
});

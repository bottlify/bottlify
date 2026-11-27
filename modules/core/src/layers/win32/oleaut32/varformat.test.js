/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFixed, formatNamedDate, formatValue } from './varformat.js';
import { textOfReal } from './vartext.js';

/** @param {number} value @param {string} format */
const number = (value, format)=>formatValue({ kind: 'number', value }, format, 0,
    real=>textOfReal(real, 15));
/** @param {number} value @param {string} format @param {number} [firstDay] */
const date = (value, format, firstDay = 0)=>formatValue({ kind: 'date', value }, format,
    firstDay, real=>textOfReal(real, 15));
/** @param {string} value @param {string} format */
const string = (value, format)=>formatValue({ kind: 'string', value }, format, 0,
    real=>textOfReal(real, 15));

test('digit placeholders: 0 always, # only with a digit, extra digits in front', ()=>{
    assert.equal(number(1, '#00000000'), '00000001');
    assert.equal(number(1, '1#####0000'), '10001');
    assert.equal(number(17, '#3.33'), '173.33');
    assert.equal(number(0, '#'), '');
    assert.equal(number(0, '#.#'), '.');
    assert.equal(number(0.17, '#.00'), '.17');
    assert.equal(number(0.0995, '#.##'), '.1', 'rounded, the trailing # zero dropped');
    assert.equal(number(1.2, '0#.0#0#0#0#0'), '01.200000000');
    assert.equal(number(9.9999999, '#0.000000'), '10.000000');
    assert.equal(number(-0.1, '.#'), '-.1');
});

test('a comma between placeholders groups, any other is text', ()=>{
    assert.equal(number(100000, '#,###,###,###'), '100,000');
    assert.equal(number(1, '0,000,000,000'), '0,000,000,001');
    assert.equal(number(123456789, '###, ###, ###'), '123, 456, 789');
});

test('sections, percent, exponents and named formats', ()=>{
    assert.equal(number(-1, '"pos";"neg"'), 'neg');
    assert.equal(number(0, '"pos";"neg";"zero"'), 'zero');
    assert.equal(number(1, 'Percent'), '100.00%');
    assert.equal(number(1, 'Scientific'), '1.00E+00');
    assert.equal(number(1, 'Yes/No'), 'Yes');
    assert.equal(number(1.73245, '0.0000E+000'), '1.7325E+000');
    assert.equal(number(47.11, '.0000E+0'), '.4711E+2');
    assert.equal(number(29.565331, '0.#####E-#'), '2.95653E1');
    assert.equal(number(1000001, '0.0000e+1'), '1.0000e+61');
    assert.equal(formatValue({ kind: 'null' }, '', 0, String), null);
});

test('dates: runs of letters, m as minutes after an hour, w from the first day', ()=>{
    assert.equal(date(2.525, 'dd mm yyyy hh:mm:ss'), '01 01 1900 12:36:00');
    assert.equal(date(2.525, 'mm :mm:ss'), '01 :01:00');
    assert.equal(date(2.525, 'hh :mm:mm'), '12 :36:01');
    assert.equal(date(2.525, 'yyy'), '001');
    assert.equal(date(2.725, 'hh:nn:ss A/P'), '05:24:00 P');
    assert.equal(date(0, 'w', 1), '7');
    assert.equal(date(0, 'w', 7), '1');
    assert.equal(date(2.525, 'medium time'), '12:36 PM');
    assert.equal(formatNamedDate(2.525, 1), 'Monday, January 01, 1900');
});

test('strings: placeholders from the right, longer text from the left with the rest after', ()=>{
    assert.equal(string('testing', '@@@@@@@@'), ' testing');
    assert.equal(string('testing', '\\x@\\x@'), 'xtxesting');
    assert.equal(string('testing', '@\\x'), 'txesting');
    assert.equal(string('testing', '>&&'), 'TESTING');
    assert.equal(string('39697.11', 'mm-dd-yy'), '09-06-08');
});

test('VarFormatNumber and its kin round half away and follow their tristates', ()=>{
    assert.equal(formatFixed(1, 2, 0, 0, 0), '1.00');
    assert.equal(formatFixed(-1, 2, -1, -1, -1), '(1.00)');
    assert.equal(formatFixed(74.5, 2, -1, -1, -1, { suffix: '%' }), '74.50%');
    assert.equal(formatFixed(-1234.5, 0, -2, -2, -2, { prefix: '$', parensByDefault: true }),
        '($1,235)');
    assert.equal(formatFixed(0.5, 2, 0, 0, 0), '.50');
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutText } from './paint.js';

const DT_CENTER = 0x0001;
const DT_RIGHT = 0x0002;
const DT_WORDBREAK = 0x0010;

/** A cell with no measure: every character is one cell wide. */
const FIXED = { cellWidth: 8, cellHeight: 16 };

/** A measure in which a wide letter is twice a narrow one. */
const PROPORTIONAL = {
    cellWidth: 8,
    cellHeight: 16,
    /** @param {string} text */
    width: text=>[...text].reduce((sum, ch)=>sum + (ch === 'W' ? 16 : 8), 0),
};

test('without a measure a line breaks at the last space within the cells that fit', ()=>{
    const lines = layoutText('one two three', { left: 0, top: 0, right: 8 * 8, bottom: 100 },
        DT_WORDBREAK, FIXED);
    assert.deepEqual(lines.map(line=>[line.text, line.x, line.y]),
        [['one two ', 0, 0], ['three', 0, 16]]);
});

test('with a measure a line breaks where the measured width runs out', ()=>{
    // Eight cells of eight: "one two" fits at 56 in either measure, but with
    // the W twice as wide "WW WW WW" no longer does.
    const rect = { left: 0, top: 0, right: 64, bottom: 100 };
    assert.deepEqual(layoutText('WW WW WW', rect, DT_WORDBREAK, FIXED).map(line=>line.text),
        ['WW WW WW']);
    assert.deepEqual(layoutText('WW WW WW', rect, DT_WORDBREAK, PROPORTIONAL)
        .map(line=>line.text), ['WW ', 'WW ', 'WW']);
});

test('alignment uses the measured width of each line', ()=>{
    const rect = { left: 0, top: 0, right: 100, bottom: 20 };
    assert.equal(layoutText('W', rect, DT_RIGHT, FIXED)[0].x, 92);
    assert.equal(layoutText('W', rect, DT_RIGHT, PROPORTIONAL)[0].x, 84);
    assert.equal(layoutText('W', rect, DT_CENTER, PROPORTIONAL)[0].x, 42);
});

test('a word wider than the rectangle is cut where it stops fitting, never at nothing', ()=>{
    const lines = layoutText('WWWW', { left: 0, top: 0, right: 40, bottom: 100 },
        DT_WORDBREAK, PROPORTIONAL);
    assert.deepEqual(lines.map(line=>line.text), ['WW', 'WW']);
    const narrow = layoutText('WW', { left: 0, top: 0, right: 4, bottom: 100 },
        DT_WORDBREAK, PROPORTIONAL);
    assert.deepEqual(narrow.map(line=>line.text), ['W', 'W'],
        'one character a line when not even one fits');
});

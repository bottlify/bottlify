/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaintFunctions, layoutText } from './paint.js';

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

test('DrawIcon puts the icon\'s picture down at its size, DrawIconEx at the size asked for', ()=>{
    /** @type {any[]} */
    const drawn = [];
    /** @type {string[]} */
    const said = [];
    const picture = { width: 32, height: 32, bgra: new Uint8Array(32 * 32 * 4) };
    const ICON = 0x30;
    const { table } = createPaintFunctions({
        host: /** @type {any} */ ({
            readMemory: ()=>new Uint8Array(0),
            writeMemory: ()=>{},
            readCString: ()=>'',
            picture: (/** @type {number} */ handle)=>(handle === ICON ? picture : null),
            draw: {
                picture: (/** @type {any[]} */ ...args)=>drawn.push(['picture', ...args]) > 0,
                fillWith: (/** @type {any[]} */ ...args)=>drawn.push(['fill', ...args]) > 0,
            },
            divergence: (/** @type {string} */ api)=>said.push(api),
        }),
        live: ()=>null,
        WM_PAINT: 0x000f,
        geometry: /** @type {any} */ ({}),
        send: ()=>0,
        invalidated: ()=>{},
        painted: ()=>{},
    });
    const HDC = 0x44;
    assert.equal(table.DrawIcon.handler([HDC, 10, 20, ICON]), 1);
    assert.deepEqual(drawn.pop(), ['picture', HDC, 10, 20, picture, 32, 32]);

    const DI_NORMAL = 3;
    const DI_DEFAULTSIZE = 8;
    const BRUSH = 0x88;
    assert.equal(table.DrawIconEx.argBytes, 36);
    assert.equal(table.DrawIconEx.handler([HDC, 1, 2, ICON, 16, 0, 0, BRUSH, DI_NORMAL]), 1);
    assert.deepEqual(drawn.splice(0), [
        ['fill', HDC, { left: 1, top: 2, right: 17, bottom: 34 }, BRUSH],
        ['picture', HDC, 1, 2, picture, 16, 32],
    ], 'the brush first, then the icon sixteen wide and its own height');
    picture.width = 48;
    table.DrawIconEx.handler([HDC, 0, 0, ICON, 0, 0, 0, 0, DI_NORMAL | DI_DEFAULTSIZE]);
    assert.deepEqual(drawn.pop(), ['picture', HDC, 0, 0, picture, 32, 32],
        'DI_DEFAULTSIZE is the system\'s size, not the icon\'s');
    assert.equal(table.DrawIconEx.handler([HDC, 0, 0, ICON, 0, 0, 0, 0, 0]), 0,
        'neither image nor mask asked for');

    assert.equal(table.DrawIcon.handler([HDC, 0, 0, 0x99]), 1, 'one with no picture succeeds');
    assert.deepEqual(said, ['DrawIcon'], 'and is said');
    assert.equal(drawn.length, 0);
});

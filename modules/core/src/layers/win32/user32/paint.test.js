/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaintFunctions, layoutText, tabbedWidth } from './paint.js';

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
    for (const right of [0, -10])
    {
        const none = layoutText('WW W', { left: 0, top: 0, right, bottom: 100 },
            DT_WORDBREAK, PROPORTIONAL);
        assert.deepEqual(none.map(line=>line.text), ['W', 'W ', 'W'],
            `a rectangle ${right} wide still ends, a character a line`);
    }
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

/**
 * A paint table over a byte array, its drawing recorded: each fill as
 * [rectangle, colour], each text as [x, y, text, colour]. A system colour is
 * 0x100 plus its index, so a fill names the colour it was drawn in.
 */
const recording = ()=>{
    const memory = new Uint8Array(0x1000);
    /** @type {any[]} */
    const fills = [];
    /** @type {any[]} */
    const texts = [];
    /** @type {string[]} */
    const said = [];
    const { table } = createPaintFunctions({
        host: /** @type {any} */ ({
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                memory.slice(at, at + length),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
                memory.set(bytes, at),
            readCString: (/** @type {number} */ at)=>new TextDecoder()
                .decode(memory.subarray(at, memory.indexOf(0, at))),
            draw: {
                sysColor: (/** @type {number} */ index)=>0x100 + index,
                fill: (/** @type {number} */ hdc, /** @type {any} */ rect, /** @type {number} */ color)=>
                    fills.push([rect, color]) > 0,
                text: (/** @type {number} */ hdc, /** @type {number} */ x, /** @type {number} */ y,
                    /** @type {string} */ text, /** @type {any} */ options)=>
                    texts.push([x, y, text, options.color]) > 0,
                measure: (/** @type {number} */ hdc, /** @type {string} */ text)=>
                    ({ width: text.length * 8, height: 16, ascent: 12 }),
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
    const view = new DataView(memory.buffer);
    /** @param {number} at @param {number[]} sides */
    const setRect = (at, sides)=>sides.forEach((side, i)=>view.setInt32(at + i * 4, side, true));
    /** @param {number} at */
    const rectAt = at=>({ left: view.getInt32(at, true), top: view.getInt32(at + 4, true),
        right: view.getInt32(at + 8, true), bottom: view.getInt32(at + 12, true) });
    return { table, memory, fills, texts, said, setRect, rectAt };
};

const HDC = 0x44;
const RECT = 0x100;
const DFC_MENU = 2;
const DFC_BUTTON = 4;

test('DrawFrameControl draws a check box as a sunken square, centred, with its mark', ()=>{
    const { table, fills, setRect } = recording();
    const DFCS_CHECKED = 0x400;
    const WINDOW = 0x100 + 5;
    const WINDOW_TEXT = 0x100 + 8;
    setRect(RECT, [10, 20, 30, 33]);
    assert.equal(table.DrawFrameControl.argBytes, 16);
    assert.equal(table.DrawFrameControl.handler([HDC, RECT, DFC_BUTTON, DFCS_CHECKED]), 1);
    // Thirteen pixels square, three in from the left of a rectangle twenty
    // wide; the face is inside two rings of edge.
    assert.deepEqual(fills.filter(([, color])=>color === WINDOW).map(([rect])=>rect),
        [{ left: 15, top: 22, right: 24, bottom: 31 }]);
    const mark = fills.filter(([, color])=>color === WINDOW_TEXT);
    assert.equal(mark.length, 21, 'the check mark, a pixel at a time');
    assert.deepEqual(mark[0][0], { left: 22, top: 23, right: 23, bottom: 24 },
        'its first pixel, three in from the square\'s corner and six along');

    fills.length = 0;
    table.DrawFrameControl.handler([HDC, RECT, DFC_BUTTON, 0]);
    assert.equal(fills.filter(([, color])=>color === WINDOW_TEXT).length, 0, 'no mark unchecked');
});

test('DrawFrameControl sinks a pushed button; DFCS_ADJUSTRECT leaves what is inside', ()=>{
    const { table, fills, setRect, rectAt } = recording();
    const DFCS_BUTTONPUSH = 0x10;
    const DFCS_PUSHED = 0x200;
    const DFCS_ADJUSTRECT = 0x2000;
    setRect(RECT, [0, 0, 40, 20]);
    assert.equal(table.DrawFrameControl.handler([HDC, RECT, DFC_BUTTON,
        DFCS_BUTTONPUSH | DFCS_PUSHED | DFCS_ADJUSTRECT]), 1);
    assert.deepEqual(fills[0], [{ left: 0, top: 0, right: 40, bottom: 20 }, 0x100 + 15],
        'the face first');
    assert.equal(fills[1][1], 0x100 + 16, 'then the edge, its top in the shadow colour');
    assert.deepEqual(rectAt(RECT), { left: 2, top: 2, right: 38, bottom: 18 });

    fills.length = 0;
    table.DrawFrameControl.handler([HDC, RECT, DFC_BUTTON, DFCS_BUTTONPUSH]);
    assert.equal(fills[1][1], 0x100 + 20, 'raised, its top in the highlight colour');
});

test('DrawFrameControl draws a menu check black on white and refuses an unknown type', ()=>{
    const { table, fills, setRect } = recording();
    const DFCS_MENUCHECK = 1;
    setRect(RECT, [0, 0, 16, 16]);
    assert.equal(table.DrawFrameControl.handler([HDC, RECT, DFC_MENU, DFCS_MENUCHECK]), 1);
    assert.deepEqual(fills[0], [{ left: 0, top: 0, right: 16, bottom: 16 }, 0xffffff]);
    assert.equal(fills.filter(([, color])=>color === 0).length, 21);
    assert.equal(table.DrawFrameControl.handler([HDC, RECT, 0, 0]), 0);
    assert.equal(table.DrawFrameControl.handler([HDC, RECT, 6, 0]), 0);
});

test('DrawState embosses disabled text and takes the mnemonic out of prefix text', ()=>{
    const { table, memory, texts, said } = recording();
    const TEXT = 0x200;
    const DST_TEXT = 1;
    const DST_PREFIXTEXT = 2;
    const DSS_DISABLED = 0x20;
    memory.set(new TextEncoder().encode('&Run'), TEXT);
    assert.equal(table.DrawStateA.argBytes, 40);
    assert.equal(table.DrawStateA.handler([HDC, 0, 0, TEXT, 0, 5, 6, 0, 0,
        DST_PREFIXTEXT | DSS_DISABLED]), 1);
    assert.deepEqual(texts.splice(0), [[6, 7, 'Run', 0x100 + 20], [5, 6, 'Run', 0x100 + 16]],
        'the highlight a pixel down and right, the shadow over it');
    assert.equal(table.DrawStateA.handler([HDC, 0, 0, TEXT, 2, 5, 6, 0, 0, DST_TEXT]), 1);
    assert.deepEqual(texts.splice(0), [[5, 6, '&R', undefined]],
        'two characters as counted, the ampersand kept, in the context\'s own colour');
    // Wine's text test, test_DrawState: no text fails, counted or not.
    assert.equal(table.DrawStateA.handler([HDC, 0, 0, 0, 4, 5, 6, 0, 0, DST_TEXT]), 0);
    assert.equal(table.DrawStateA.handler([HDC, 0, 0, 0, 0, 5, 6, 0, 0, DST_TEXT]), 0);
    const DST_COMPLEX = 0;
    assert.equal(table.DrawStateA.handler([HDC, 0, 0x401000, 0, 0, 0, 0, 8, 8, DST_COMPLEX]), 1,
        'a procedure\'s drawing is left out and the call succeeds');
    assert.deepEqual(said, ['DrawState']);
});

test('tabs expand to the first stop past the text, a negative stop right-aligning '
    + 'what follows', ()=>{
    // user32's text tests (test_TabbedText), whose stops sit a pixel either
    // side of four characters to catch an off-by-one: the stop is taken only
    // when strictly past where the text has reached -- for a right-aligned
    // one, when the text that follows it would start strictly past there.
    for (const cx of [7, 8])
    {
        /** @param {string} text */
        const widthOf = text=>text.length * cx;
        for (const t of [-1, 0, 1])
        {
            const tab = cx * 4 + t;
            for (const count of [1, 8])
            {
                /** @param {number} sign @param {string} text */
                const width = (sign, text)=>tabbedWidth(text, widthOf,
                    Array.from({ length: count }, (_, i)=>sign * (i + 1) * tab), 8 * cx);
                const left = {
                    '\t': tab, 'xxx\t': tab, '\tx': tab + cx, '\t\t': tab * 2,
                    '\tx\t': tab * 2, 'x\tx': tab + cx, 'xx\tx': tab + cx,
                    'xxx\tx': tab + cx, 'xxxx\tx': t > 0 ? tab + cx : 2 * tab + cx,
                    'xxxxx\tx': 2 * tab + cx,
                };
                const right = {
                    '\t': tab, 'xxx\t': tab, '\tx': tab, '\t\t': tab * 2, '\tx\t': tab * 2,
                    'x\tx': tab, 'xx\tx': tab, 'xxx\tx': 4 * cx >= tab ? 2 * tab : tab,
                    'xxxx\tx': 2 * tab, 'xxxxx\tx': 2 * tab,
                };
                for (const [text, expected] of Object.entries(left))
                {
                    assert.equal(width(1, text), expected,
                        `${JSON.stringify(text)} t=${t} n=${count}`);
                }
                for (const [text, expected] of Object.entries(right))
                {
                    assert.equal(width(-1, text), expected,
                        `right-aligned ${JSON.stringify(text)} t=${t} n=${count}`);
                }
            }
        }
    }
});

test('with no stops, or past the last of several, tabs fall every default interval', ()=>{
    /** @param {string} text */
    const widthOf = text=>text.length * 8;
    assert.equal(tabbedWidth('ab\tc', widthOf, [], 64), 72);
    assert.equal(tabbedWidth('ab\tc\td', widthOf, [20, 24], 64), 72,
        'the second tab is past the last stop');
    assert.equal(tabbedWidth('\tc', widthOf, [0], 64), 72, 'a zero interval is none');
    assert.equal(tabbedWidth('plain', widthOf, [10], 64), 40);
});

test('DrawFocusRect inverts the rectangle\'s one-pixel border through the gray brush, each'
    + ' pixel once', ()=>{
    const memory = new Uint8Array(0x100);
    /** @type {any[]} */
    const inverted = [];
    const { table } = createPaintFunctions({
        host: /** @type {any} */ ({
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                memory.slice(at, at + length),
            writeMemory: ()=>{},
            readCString: ()=>'',
            draw: {
                invert: (/** @type {number} */ hdc, /** @type {any} */ rect,
                    /** @type {boolean} */ halftone)=>inverted.push([hdc, rect, halftone]) > 0,
            },
        }),
        live: ()=>null,
        WM_PAINT: 0x000f,
        geometry: /** @type {any} */ ({}),
        send: ()=>0,
        invalidated: ()=>{},
        painted: ()=>{},
    });
    const view = new DataView(memory.buffer);
    [10, 20, 50, 40].forEach((side, i)=>view.setInt32(0x10 + i * 4, side, true));
    assert.equal(table.DrawFocusRect.handler([HDC, 0x10]), 1);
    assert.deepEqual(inverted, [
        [HDC, { left: 10, top: 20, right: 50, bottom: 21 }, true],
        [HDC, { left: 10, top: 39, right: 50, bottom: 40 }, true],
        [HDC, { left: 10, top: 21, right: 11, bottom: 39 }, true],
        [HDC, { left: 49, top: 21, right: 50, bottom: 39 }, true],
    ], 'dotted, so drawing it twice takes it away and it shows over any picture');
});

test('DrawText on a handle that is no context answers zero and reads nothing', ()=>{
    // Wine's text test: DrawTextExW((HDC)0xdeadbeef, (LPWSTR)0xdeadbeef, 100000, ...)
    // is zero with the last error untouched; the ANSI form says the handle.
    /** @type {number[]} */
    const errors = [];
    /** @type {number[]} */
    const read = [];
    const { table } = createPaintFunctions({
        host: /** @type {any} */ ({
            readMemory: (/** @type {number} */ address)=>{
                read.push(address);
                return new Uint8Array(0);
            },
            writeMemory: ()=>{},
            readCString: ()=>'',
            setLastError: (/** @type {number} */ code)=>errors.push(code),
            draw: { isContext: (/** @type {number} */ hdc)=>hdc === 0x44 },
        }),
        live: ()=>null,
        WM_PAINT: 0x000f,
        geometry: /** @type {any} */ ({}),
        send: ()=>0,
        invalidated: ()=>{},
        painted: ()=>{},
    });
    assert.equal(table.DrawTextExW.handler([0xdeadbeef, 0xdeadbeef, 100000, 0x100, 0, 0]), 0);
    assert.equal(table.DrawTextW.handler([0xdeadbeef, 0, -1, 0xdeadbeef, 0x400]), 0);
    assert.deepEqual(errors, []);
    assert.equal(table.DrawTextExA.handler([0xdeadbeef, 0, -1, 0xdeadbeef, 0x400, 0]), 0);
    assert.deepEqual(errors, [6]);
    assert.deepEqual(read, []);
});

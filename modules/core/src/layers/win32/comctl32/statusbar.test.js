/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import * as surfaces from '../../graphics/gdi/surface.js';
import { setupBars as setupWith, OUT, TEXT } from './bars.fixture.js';
import {
    STATUSBAR_CLASS, CCS_NORESIZE, CCS_TOP, SBT_POPOUT, SBT_NOBORDERS, SB_SIMPLEID,
    SB_SETPARTS, SB_GETPARTS, SB_GETRECT, SB_GETBORDERS, SB_SETTEXTA, SB_SETTEXTW,
    SB_GETTEXTA, SB_GETTEXTW, SB_GETTEXTLENGTHA, SB_SIMPLE, SB_ISSIMPLE, SB_SETMINHEIGHT,
} from './statusbar.js';

/** The fixture over the graphics layer's drawing engine. */
const setupBars = ()=>setupWith({ createGdiDrawing, ...surfaces });

/**
 * The expectations are the status bar's documented contract and what MFC's
 * CStatusBar asks of it: the borders, the parts' right edges, and each
 * part's text with the way it is drawn in the high byte beside the part.
 */

const WM_SIZE = 0x0005;
const WM_SETTEXT = 0x000c;
const WM_GETTEXT = 0x000d;
const FACE = 0x00c0c0c0;
const SHADOW = 0x00808080;
const LIGHT = 0x00ffffff;

/** @param {ReturnType<typeof setupBars>} context @param {number} hwnd @param {number} part */
function partRect(context, hwnd, part){
    context.memory.bytes.fill(0, OUT, OUT + 16);
    const found = context.send([hwnd, SB_GETRECT, part, OUT]);
    return { found, rect: [0, 4, 8, 12].map(offset=>context.memory.i32(OUT + offset)) };
}

test('a status bar places itself along its parent\'s bottom, as wide as the parent, and '
    + 'again when it is sent WM_SIZE; with CCS_NORESIZE it stays where it was put', async()=>{
    const context = setupBars();
    const parent = await context.makeParent(300, 200);
    const bar = await context.control(STATUSBAR_CLASS, 0);
    assert.notEqual(bar, 0, 'msctls_statusbar32 resolves to a window');
    const room = context.clientSize(parent);
    const placed = context.clientSize(bar);
    assert.equal(placed.width, room.width);
    assert.ok(placed.height >= 18 && placed.height <= 30, `a line tall: ${placed.height}`);
    assert.equal(context.windowRect(bar).bottom, context.toScreen(parent, 0, room.height).y,
        'its bottom is the client area\'s');
    assert.equal(context.windowRect(bar).left, context.toScreen(parent, 0, 0).x);

    await context.fns.MoveWindow.handler([parent, 0, 0, 250, 180, 1]);
    await context.send([bar, WM_SIZE, 0, 0]);
    const moved = context.clientSize(parent);
    assert.equal(context.clientSize(bar).width, moved.width, 'as wide as the parent again');

    assert.equal(context.windowRect(bar).bottom, context.toScreen(parent, 0, moved.height).y);
    const atTop = await context.control(STATUSBAR_CLASS, CCS_TOP);
    assert.equal(context.windowRect(atTop).top, context.toScreen(parent, 0, 0).y,
        'CCS_TOP puts it at the top');

    const fixed = await context.control(STATUSBAR_CLASS, CCS_NORESIZE, [5, 6, 70, 20]);
    assert.deepEqual(context.clientSize(fixed), { width: 70, height: 20 });
});

test('SB_SETPARTS cuts it at the right edges given, -1 to the end; SB_GETPARTS, SB_GETRECT '
    + 'and SB_GETBORDERS report them, and a part keeps its text through a new cut', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(STATUSBAR_CLASS, 0);
    const size = context.clientSize(bar);
    assert.equal(context.send([bar, SB_GETPARTS, 0, 0]), 1, 'one part to begin with');
    context.memory.put32s(OUT + 0x40, [100, 200, -1]);
    assert.equal(context.send([bar, SB_SETPARTS, 3, OUT + 0x40]), 1);
    assert.equal(context.send([bar, SB_SETPARTS, 0, OUT + 0x40]), 0, 'no parts is refused');
    context.memory.bytes.fill(0, OUT + 0x60, OUT + 0x70);
    assert.equal(context.send([bar, SB_GETPARTS, 2, OUT + 0x60]), 3);
    assert.deepEqual([context.memory.i32(OUT + 0x60), context.memory.i32(OUT + 0x64),
        context.memory.i32(OUT + 0x68)], [100, 200, 0], 'as many edges as asked for');

    context.memory.bytes.fill(0xcc, OUT, OUT + 12);
    assert.equal(context.send([bar, SB_GETBORDERS, 0, OUT]), 1);
    assert.deepEqual([context.memory.i32(OUT), context.memory.i32(OUT + 4),
        context.memory.i32(OUT + 8)], [0, 2, 2]);
    assert.deepEqual(partRect(context, bar, 0), { found: 1, rect: [0, 2, 100, size.height - 2] });
    assert.deepEqual(partRect(context, bar, 1),
        { found: 1, rect: [102, 2, 200, size.height - 2] }, 'a border on from the one before');
    assert.deepEqual(partRect(context, bar, 2).rect, [202, 2, size.width, size.height - 2]);
    assert.equal(partRect(context, bar, 3).found, 0);

    context.memory.putString(TEXT, 'kept');
    context.send([bar, SB_SETTEXTA, 1, TEXT]);
    context.memory.put32s(OUT + 0x40, [50, -1]);
    context.send([bar, SB_SETPARTS, 2, OUT + 0x40]);
    assert.equal(context.send([bar, SB_GETTEXTLENGTHA, 1, 0]), 4);
});

test('SB_SETTEXT keeps a part\'s text and the way it is drawn, which SB_GETTEXT answers '
    + 'beside its length; WM_SETTEXT is the first part\'s, and simple mode has its own',
async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(STATUSBAR_CLASS, 0);
    context.memory.put32s(OUT + 0x40, [100, -1]);
    context.send([bar, SB_SETPARTS, 2, OUT + 0x40]);
    context.memory.putString(TEXT, 'Ready');
    assert.equal(context.send([bar, SB_SETTEXTA, 1 | SBT_POPOUT, TEXT]), 1);
    assert.equal(context.send([bar, SB_SETTEXTA, 5, TEXT]), 0, 'no sixth part');
    assert.equal(context.send([bar, SB_GETTEXTLENGTHA, 1, 0]), (SBT_POPOUT << 16 | 5) >>> 0);
    context.memory.bytes.fill(0xcc, OUT, OUT + 16);
    assert.equal(context.send([bar, SB_GETTEXTA, 1, OUT]), (SBT_POPOUT << 16 | 5) >>> 0);
    assert.equal(context.memory.readCString(OUT, 16), 'Ready');

    context.memory.putWide(TEXT, 'Wide');
    assert.equal(context.send([bar, SB_SETTEXTW, 0, TEXT]), 1);
    context.memory.bytes.fill(0xcc, OUT, OUT + 16);
    assert.equal(context.send([bar, SB_GETTEXTW, 0, OUT]), 4);
    assert.deepEqual([...context.memory.bytes.subarray(OUT, OUT + 10)],
        [0x57, 0, 0x69, 0, 0x64, 0, 0x65, 0, 0, 0]);

    context.memory.putString(TEXT, 'Title');
    assert.equal(context.send([bar, WM_SETTEXT, 0, TEXT]), 1);
    assert.equal(context.send([bar, SB_GETTEXTLENGTHA, 0, 0]), 5);

    context.send([bar, SB_SIMPLE, 1, 0]);
    assert.equal(context.send([bar, SB_ISSIMPLE, 0, 0]), 1);
    context.memory.putString(TEXT, 'Loading...');
    assert.equal(context.send([bar, SB_SETTEXTA, SB_SIMPLEID, TEXT]), 1);
    assert.equal(context.send([bar, WM_GETTEXT, 32, OUT]), 10);
    assert.equal(context.memory.readCString(OUT, 32), 'Loading...');
    assert.equal(partRect(context, bar, 1).found, 0, 'one part in simple mode');
    context.send([bar, SB_SIMPLE, 0, 0]);
    assert.equal(context.send([bar, WM_GETTEXT, 32, OUT]), 5, 'the parts\' texts kept');
    context.send([bar, SB_SETMINHEIGHT, 40, 0]);
    await context.send([bar, WM_SIZE, 0, 0]);
    assert.ok(context.clientSize(bar).height >= 40, 'SB_SETMINHEIGHT takes at the next size');
});

test('a part is drawn sunken, raised with SBT_POPOUT or with no border, its text in it',
    async()=>{
        const context = setupBars();
        await context.makeParent();
        const bar = await context.control(STATUSBAR_CLASS, 0);
        context.memory.put32s(OUT + 0x40, [80, 160, -1]);
        context.send([bar, SB_SETPARTS, 3, OUT + 0x40]);
        context.memory.putString(TEXT, 'MMMM');
        context.send([bar, SB_SETTEXTA, 0, TEXT]);
        context.send([bar, SB_SETTEXTA, 1 | SBT_POPOUT, TEXT]);
        context.send([bar, SB_SETTEXTA, 2 | SBT_NOBORDERS, TEXT]);
        await context.pump();
        const bottom = context.clientSize(bar).height - 3;
        assert.deepEqual([context.pixel(bar, 0, 2), context.pixel(bar, 79, bottom)],
            [SHADOW, LIGHT], 'sunken');
        assert.deepEqual([context.pixel(bar, 82, 2), context.pixel(bar, 159, bottom)],
            [LIGHT, SHADOW], 'raised');
        assert.deepEqual([context.pixel(bar, 162, 2), context.pixel(bar, 162, bottom)],
            [FACE, FACE], 'no border');
        const row = Math.floor(context.clientSize(bar).height / 2);
        const inked = [];
        for (let x = 3; x < 40; x++)
        {
            inked.push(context.pixel(bar, x, row));
        }
        assert.ok(inked.some(color=>color !== FACE), 'the text is drawn in the part');
    });

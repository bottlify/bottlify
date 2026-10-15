/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import * as surfaces from '../../graphics/gdi/surface.js';
import { createScreen } from '../../graphics/gdi/screen.js';
import { setupBars as setupWith, OUT, ITEM, HINSTANCE } from './bars.fixture.js';
import {
    TOOLBAR_CLASS, TBSTATE_ENABLED, TBSTATE_CHECKED, TBSTYLE_SEP, TBSTYLE_CHECK,
    TBSTYLE_CHECKGROUP, TBSTYLE_FLAT,
    TB_BUTTONSTRUCTSIZE, TB_SETBITMAPSIZE, TB_SETBUTTONSIZE, TB_GETBUTTONSIZE, TB_ADDBITMAP,
    TB_ADDBUTTONSA, TB_INSERTBUTTONA, TB_DELETEBUTTON, TB_BUTTONCOUNT, TB_GETBUTTON,
    TB_GETITEMRECT, TB_COMMANDTOINDEX, TB_ISBUTTONENABLED, TB_ISBUTTONCHECKED,
    TB_ISBUTTONPRESSED, TB_CHECKBUTTON, TB_ENABLEBUTTON, TB_SETPARENT, TB_GETSTATE,
    TB_HITTEST, TB_REPLACEBITMAP,
} from './toolbar.js';

/** The fixture over the graphics layer's drawing engine. */
const setupBars = ()=>setupWith({ createGdiDrawing, createScreen, ...surfaces });

/**
 * The expectations are the toolbar's documented contract and what MFC's
 * CToolBar sends it: the sizes, then each bitmap with TB_ADDBITMAP, the
 * buttons one at a time with TB_ADDBUTTONS, and a button's state changed by
 * deleting it and inserting it again.
 */

const WM_COMMAND = 0x0111;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
/** MFC's CToolBar styles: no parent alignment, no divider, no resizing; flat. */
const MFC_STYLE = 0x0400004e | TBSTYLE_FLAT;
const FACE = 0x00c0c0c0;
const SHADOW = 0x00808080;
const LIGHT = 0x00ffffff;
const GREEN = 0x0000ff00;

/** @param {number} x @param {number} y */
const at = (x, y)=>(y << 16 | x) >>> 0;

/**
 * A toolbar set up as MFC sets one up, with a three-image bitmap and the
 * buttons given.
 *
 * @param {ReturnType<typeof setupBars>} context @param {number} style
 * @param {{ command: number, image?: number, state?: number, style?: number }[]} buttons
 */
async function toolbar(context, style, buttons, place = [0, 0, 0, 0]){
    const hwnd = await context.control(TOOLBAR_CLASS, style, place);
    context.send([hwnd, TB_BUTTONSTRUCTSIZE, 20, 0]);
    assert.equal(context.send([hwnd, TB_SETBITMAPSIZE, 0, at(16, 15)]), 1);
    assert.equal(context.send([hwnd, TB_SETBUTTONSIZE, 0, at(23, 22)]), 1);
    // Three images: green, a black square on the face, and the face alone.
    const strip = context.bitmap(48, 15, (x, y)=>{
        const image = Math.floor(x / 16);
        const inside = x % 16 >= 4 && x % 16 < 12 && y >= 4 && y < 11;
        return image === 0 ? GREEN : image === 1 && inside ? 0 : FACE;
    });
    context.memory.put32s(ITEM, [0, strip]);
    assert.equal(context.send([hwnd, TB_ADDBITMAP, 3, ITEM]), 0, 'the first image is 0');
    for (const button of buttons)
    {
        addButton(context, hwnd, button);
    }
    return { hwnd, strip };
}

/**
 * @param {ReturnType<typeof setupBars>} context @param {number} hwnd
 * @param {{ command: number, image?: number, state?: number, style?: number }} button
 * @param {number} [insertAt]
 */
function addButton(context, hwnd, button, insertAt){
    context.memory.bytes.fill(0, ITEM + 0x40, ITEM + 0x40 + 20);
    context.memory.put32s(ITEM + 0x40, [button.image ?? 0, button.command]);
    context.memory.bytes[ITEM + 0x48] = button.state ?? TBSTATE_ENABLED;
    context.memory.bytes[ITEM + 0x49] = button.style ?? 0;
    context.memory.put32s(ITEM + 0x50, [-1]);
    return insertAt === undefined
        ? context.send([hwnd, TB_ADDBUTTONSA, 1, ITEM + 0x40])
        : context.send([hwnd, TB_INSERTBUTTONA, insertAt, ITEM + 0x40]);
}

/** @param {ReturnType<typeof setupBars>} context @param {number} hwnd @param {number} index */
function itemRect(context, hwnd, index){
    context.memory.bytes.fill(0, OUT, OUT + 16);
    const found = context.send([hwnd, TB_GETITEMRECT, index, OUT]);
    return { found, rect: [0, 4, 8, 12].map(offset=>context.memory.i32(OUT + offset)) };
}

/**
 * @param {ReturnType<typeof setupBars>} context @param {number} hwnd
 * @param {number} x @param {number} y @param {number} [upX]
 */
async function click(context, hwnd, x, y, upX = x){
    await context.send([hwnd, WM_LBUTTONDOWN, 1, at(x, y)]);
    await context.send([hwnd, WM_MOUSEMOVE, 1, at(upX, y)]);
    await context.send([hwnd, WM_LBUTTONUP, 0, at(upX, y)]);
}

/** @param {ReturnType<typeof setupBars>} context @param {number} hwnd */
const commands = (context, hwnd)=>context.sent
    .filter(message=>message.message === WM_COMMAND && message.lParam === hwnd)
    .map(message=>message.wParam);

test('a toolbar is a class a program creates by name, and takes MFC\'s set-up: the sizes, '
    + 'a bitmap, its buttons one at a time', async()=>{
    const context = setupBars();
    const parent = await context.makeParent();
    const { hwnd } = await toolbar(context, MFC_STYLE, [
        { command: 100, image: 0 },
        { command: 0, image: 6, style: TBSTYLE_SEP },
        { command: 101, image: 1 },
        { command: 102, image: 2 },
    ]);
    assert.notEqual(hwnd, 0, 'ToolbarWindow32 resolves to a window');
    assert.equal(context.send([hwnd, TB_GETBUTTONSIZE, 0, 0]), at(23, 22));
    assert.equal(context.send([hwnd, TB_BUTTONCOUNT, 0, 0]), 4);
    // A second bitmap's images follow the first's.
    const more = context.bitmap(32, 15, ()=>FACE);
    context.memory.put32s(ITEM, [0, more]);
    assert.equal(context.send([hwnd, TB_ADDBITMAP, 2, ITEM]), 3);

    // Side by side from the left, two pixels down; a separator as wide as its iBitmap.
    assert.deepEqual(itemRect(context, hwnd, 0), { found: 1, rect: [0, 2, 23, 24] });
    assert.deepEqual(itemRect(context, hwnd, 1), { found: 1, rect: [23, 2, 29, 24] });
    assert.deepEqual(itemRect(context, hwnd, 3), { found: 1, rect: [52, 2, 75, 24] });
    assert.equal(itemRect(context, hwnd, 4).found, 0, 'no fifth button');

    context.memory.bytes.fill(0xcc, OUT, OUT + 20);
    assert.equal(context.send([hwnd, TB_GETBUTTON, 2, OUT]), 1);
    assert.deepEqual([context.memory.i32(OUT), context.memory.i32(OUT + 4),
        context.memory.bytes[OUT + 8], context.memory.bytes[OUT + 9],
        context.memory.i32(OUT + 16)], [1, 101, TBSTATE_ENABLED, 0, -1]);

    // MFC changes a button's state by deleting it and inserting it again.
    assert.equal(context.send([hwnd, TB_DELETEBUTTON, 2, 0]), 1);
    assert.equal(addButton(context, hwnd, { command: 101, image: 1, state: 0 }, 2), 1);
    assert.equal(context.send([hwnd, TB_BUTTONCOUNT, 0, 0]), 4);
    assert.equal(context.send([hwnd, TB_ISBUTTONENABLED, 101, 0]), 0);
    assert.equal(context.send([hwnd, TB_COMMANDTOINDEX, 101, 0]), 2);
    assert.equal(context.send([hwnd, TB_COMMANDTOINDEX, 999, 0]) | 0, -1);
    assert.equal(context.send([hwnd, TB_GETSTATE, 999, 0]) | 0, -1);
    assert.equal(context.send([hwnd, TB_DELETEBUTTON, 9, 0]), 0);

    // A hit test names a button, a separator negated, and nowhere -1.
    context.memory.put32s(OUT, [60, 10]);
    assert.equal(context.send([hwnd, TB_HITTEST, 0, OUT]), 3);
    context.memory.put32s(OUT, [25, 10]);
    assert.equal(context.send([hwnd, TB_HITTEST, 0, OUT]) | 0, -1);
    context.memory.put32s(OUT, [200, 10]);
    assert.equal(context.send([hwnd, TB_HITTEST, 0, OUT]) | 0, -1);

    assert.equal(context.send([hwnd, TB_SETPARENT, 0x1234, 0]), parent,
        'the parent is the owner until TB_SETPARENT names another');
    assert.equal(context.send([hwnd, TB_SETPARENT, parent, 0]), 0x1234);
});

test('a click on an enabled button tells the owner WM_COMMAND with its id; a disabled '
    + 'button, or a press let go off the button, tells it nothing', async()=>{
    const context = setupBars();
    await context.makeParent();
    const { hwnd } = await toolbar(context, MFC_STYLE, [
        { command: 100 }, { command: 101, state: 0 },
    ]);
    await click(context, hwnd, 5, 10);
    assert.deepEqual(commands(context, hwnd), [100]);
    assert.equal(context.send([hwnd, TB_ISBUTTONPRESSED, 100, 0]), 0, 'up again');

    await context.send([hwnd, WM_LBUTTONDOWN, 1, at(5, 10)]);
    assert.notEqual(context.send([hwnd, TB_ISBUTTONPRESSED, 100, 0]), 0, 'down while held');
    await context.send([hwnd, WM_MOUSEMOVE, 1, at(150, 10)]);
    assert.equal(context.send([hwnd, TB_ISBUTTONPRESSED, 100, 0]), 0, 'up when the mouse leaves');
    await context.send([hwnd, WM_LBUTTONUP, 0, at(150, 10)]);
    await click(context, hwnd, 30, 10);
    assert.deepEqual(commands(context, hwnd), [100], 'neither the let-go nor the disabled one');

    assert.equal(context.send([hwnd, TB_ENABLEBUTTON, 101, 1]), 1);
    await click(context, hwnd, 30, 10);
    assert.deepEqual(commands(context, hwnd), [100, 101]);
});

test('a check button stays down until it is clicked again, and of a check group one is '
    + 'down at a time', async()=>{
    const context = setupBars();
    await context.makeParent();
    const { hwnd } = await toolbar(context, MFC_STYLE, [
        { command: 200, style: TBSTYLE_CHECK },
        { command: 201, style: TBSTYLE_CHECKGROUP },
        { command: 202, style: TBSTYLE_CHECKGROUP },
    ]);
    /** @param {number} command */
    const checked = command=>context.send([hwnd, TB_ISBUTTONCHECKED, command, 0]) !== 0;
    await click(context, hwnd, 5, 10);
    assert.equal(checked(200), true);
    await click(context, hwnd, 5, 10);
    assert.equal(checked(200), false);

    await click(context, hwnd, 30, 10);
    assert.deepEqual([checked(201), checked(202)], [true, false]);
    await click(context, hwnd, 50, 10);
    assert.deepEqual([checked(201), checked(202)], [false, true]);
    await click(context, hwnd, 50, 10);
    assert.equal(checked(202), true, 'a group\'s button stays down when clicked again');
    assert.equal(context.send([hwnd, TB_CHECKBUTTON, 201, 1]), 1);
    assert.deepEqual([checked(201), checked(202)], [true, false]);
    assert.equal(context.send([hwnd, TB_GETSTATE, 201, 0]), TBSTATE_ENABLED | TBSTATE_CHECKED);
    assert.deepEqual(commands(context, hwnd), [200, 200, 201, 202, 202]);
});

test('a button shows its image masked by the face colour, and a disabled one embossed in '
    + 'the shadow over the highlight', async()=>{
    const context = setupBars();
    await context.makeParent();
    const { hwnd } = await toolbar(context, 0x04000040, [
        { command: 1, image: 0 }, { command: 2, image: 1 }, { command: 3, image: 1, state: 0 },
    ], [10, 10, 200, 30]);
    await context.pump();
    // The image sits in the middle of its 23 by 22 button: 3 in and 3 down.
    assert.equal(context.pixel(hwnd, 3 + 8, 2 + 3 + 7), GREEN);
    // The black square, its image's face transparent onto the button's face.
    assert.equal(context.pixel(hwnd, 23 + 3 + 6, 2 + 3 + 6), 0);
    assert.equal(context.pixel(hwnd, 23 + 3 + 1, 2 + 3 + 1), FACE);
    // Disabled: the square in the shadow, its highlight a pixel down and right.
    assert.equal(context.pixel(hwnd, 46 + 3 + 6, 2 + 3 + 6), SHADOW);
    assert.equal(context.pixel(hwnd, 46 + 3 + 12, 2 + 3 + 11), LIGHT);
    assert.equal(context.pixel(hwnd, 46 + 3 + 1, 2 + 3 + 1), FACE);
});

test('TB_ADDBITMAP takes a module\'s bitmap resource, counts comctl32\'s standard strips '
    + 'blank and says so, and TB_REPLACEBITMAP swaps one bitmap\'s images', async()=>{
    const context = setupBars();
    await context.makeParent();
    const { hwnd, strip } = await toolbar(context, MFC_STYLE, [{ command: 1, image: 3 }],
        [0, 0, 100, 30]);
    context.memory.put32s(ITEM, [0xffffffff, 0]);
    assert.equal(context.send([hwnd, TB_ADDBITMAP, 15, ITEM]), 3, 'after the three');
    assert.match(context.divergences.join('\n'), /standard bitmap 0/);
    context.resources.set(0x80, context.bitmap(16, 15, ()=>GREEN));
    context.memory.put32s(ITEM, [HINSTANCE, 0x80]);
    assert.equal(context.send([hwnd, TB_ADDBITMAP, 1, ITEM]), 18, 'after the fifteen');
    context.memory.put32s(ITEM, [HINSTANCE, 0x81]);
    assert.equal(context.send([hwnd, TB_ADDBITMAP, 1, ITEM]) | 0, -1, 'no such resource');

    // The first bitmap's three images replaced: image 0 is no longer green.
    const plain = context.bitmap(48, 15, ()=>0x00000080);
    context.memory.put32s(ITEM, [0, strip, 0, plain, 3]);
    assert.equal(context.send([hwnd, TB_REPLACEBITMAP, 0, ITEM]), 1);
    context.memory.put32s(ITEM, [0, strip, 0, plain, 3]);
    assert.equal(context.send([hwnd, TB_REPLACEBITMAP, 0, ITEM]), 0, 'it is gone');
});

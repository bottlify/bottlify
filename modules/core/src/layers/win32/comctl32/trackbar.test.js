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
    TRACKBAR_CLASS, TBS_VERT, TBS_NOTICKS, TBS_FIXEDLENGTH,
    TBM_GETPOS, TBM_GETRANGEMIN, TBM_GETRANGEMAX, TBM_SETPOS, TBM_SETRANGE, TBM_SETRANGEMIN,
    TBM_SETRANGEMAX, TBM_SETPAGESIZE, TBM_GETPAGESIZE, TBM_SETLINESIZE, TBM_GETLINESIZE,
    TBM_SETTIC, TBM_GETTIC, TBM_GETNUMTICS, TBM_CLEARTICS, TBM_SETSEL, TBM_GETSELSTART,
    TBM_GETSELEND, TBM_CLEARSEL, TBM_GETTHUMBRECT, TBM_GETCHANNELRECT, TBM_SETTHUMBLENGTH,
    TBM_GETTHUMBLENGTH, TB_LINEUP, TB_LINEDOWN, TB_PAGEDOWN, TB_TOP, TB_BOTTOM,
    TB_THUMBTRACK, TB_THUMBPOSITION, TB_ENDTRACK,
} from './trackbar.js';

/** The fixture over the graphics layer's drawing engine. */
const setupBars = ()=>setupWith({ createGdiDrawing, ...surfaces });

/**
 * The expectations are the trackbar's documented contract and what Wine's
 * conformance tests record Windows answering: the defaults, the clamping,
 * which setters answer the previous value, and the notification a move
 * sends the parent after the position has moved.
 */

const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_HSCROLL = 0x0114;
const WM_VSCROLL = 0x0115;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const VK_HOME = 0x24;
const VK_END = 0x23;
const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const VK_NEXT = 0x22;
const FACE = 0x00c0c0c0;

/** WNDCLASSEXA's size and its procedure's offset. */
const WNDCLASSEX_SIZE = 48;
const WNDCLASSEX_WNDPROC = 8;

/** @param {number} x @param {number} y */
const point = (x, y)=>((y & 0xffff) << 16 | x & 0xffff) >>> 0;

/**
 * @param {ReturnType<typeof setupBars>} context @param {number} hwnd @param {number} message
 */
const rectBy = (context, hwnd, message)=>{
    context.memory.bytes.fill(0, OUT, OUT + 16);
    context.send([hwnd, message, 0, OUT]);
    return { left: context.memory.i32(OUT), top: context.memory.i32(OUT + 4),
        right: context.memory.i32(OUT + 8), bottom: context.memory.i32(OUT + 12) };
};

/** The scroll notifications the parent was sent: [code, position, from]. */
const scrolls = (/** @type {ReturnType<typeof setupBars>} */ context)=>context.sent
    .filter(m=>m.message === WM_HSCROLL || m.message === WM_VSCROLL)
    .map(m=>[m.wParam & 0xffff, m.wParam >>> 16, m.lParam]);

test('a toolkit that superclasses the trackbar finds it by name with GetClassInfoEx '
    + 'before it makes one, as it finds a button', async()=>{
    const context = setupBars();
    for (const name of [TRACKBAR_CLASS, 'MSCTLS_TRACKBAR32'])
    {
        context.memory.putString(TEXT, name);
        context.memory.bytes.fill(0, OUT, OUT + WNDCLASSEX_SIZE);
        context.memory.put32s(OUT, [WNDCLASSEX_SIZE]);
        assert.equal(context.fns.GetClassInfoExA.handler([0, TEXT, OUT]), 1, name);
        assert.notEqual(context.memory.u32(OUT + WNDCLASSEX_WNDPROC), 0,
            'with a procedure a superclass can call');
    }
});

test('a trackbar starts at 0 in 0..100, a line of 1 and a page of 20', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    assert.notEqual(bar, 0, 'msctls_trackbar32 resolves to a window');
    assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 0);
    assert.equal(context.send([bar, TBM_GETRANGEMIN, 0, 0]), 0);
    assert.equal(context.send([bar, TBM_GETRANGEMAX, 0, 0]), 100);
    assert.equal(context.send([bar, TBM_GETLINESIZE, 0, 0]), 1);
    assert.equal(context.send([bar, TBM_GETPAGESIZE, 0, 0]), 20);
    assert.equal(context.send([bar, TBM_GETNUMTICS, 0, 0]), 2, 'the two ends');
});

test('a position is held inside the range, and a range that shrinks moves it in', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    context.send([bar, TBM_SETPOS, 1, 250]);
    assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 100);
    context.send([bar, TBM_SETPOS, 1, -5]);
    assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 0);
    // MAKELONG of two shorts: a minimum below zero is negative.
    context.send([bar, TBM_SETRANGE, 1, point(-10, 40)]);
    assert.equal(context.send([bar, TBM_GETRANGEMIN, 0, 0]), -10);
    assert.equal(context.send([bar, TBM_GETRANGEMAX, 0, 0]), 40);
    context.send([bar, TBM_SETPOS, 1, 30]);
    context.send([bar, TBM_SETRANGEMAX, 1, 20]);
    assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 20, 'moved in with the top');
    context.send([bar, TBM_SETRANGEMIN, 1, 25]);
    assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 25, 'and up with the bottom');
    assert.deepEqual(scrolls(context), [], 'a program\'s own move tells nobody');
});

test('the page and line setters answer the size they replace', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    assert.equal(context.send([bar, TBM_SETPAGESIZE, 0, 7]), 20);
    assert.equal(context.send([bar, TBM_GETPAGESIZE, 0, 0]), 7);
    assert.equal(context.send([bar, TBM_SETLINESIZE, 0, 3]), 1);
    assert.equal(context.send([bar, TBM_GETLINESIZE, 0, 0]), 3);
});

test('tics: one inside the range is kept in order, one outside is refused, '
    + 'and the ends always count', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    assert.equal(context.send([bar, TBM_SETTIC, 0, 60]), 1);
    assert.equal(context.send([bar, TBM_SETTIC, 0, 30]), 1);
    assert.equal(context.send([bar, TBM_SETTIC, 0, 101]), 0);
    assert.equal(context.send([bar, TBM_GETNUMTICS, 0, 0]), 4);
    assert.equal(context.send([bar, TBM_GETTIC, 0, 0]), 30);
    assert.equal(context.send([bar, TBM_GETTIC, 1, 0]), 60);
    assert.equal(context.send([bar, TBM_GETTIC, 2, 0]), -1);
    context.send([bar, TBM_CLEARTICS, 1, 0]);
    assert.equal(context.send([bar, TBM_GETNUMTICS, 0, 0]), 2);
    const bare = await context.control(TRACKBAR_CLASS, TBS_NOTICKS, [10, 50, 200, 30]);
    assert.equal(context.send([bare, TBM_GETNUMTICS, 0, 0]), 0, 'TBS_NOTICKS has none');
});

test('a selection is two signed words, and clears to nothing', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    context.send([bar, TBM_SETSEL, 1, point(10, 70)]);
    assert.equal(context.send([bar, TBM_GETSELSTART, 0, 0]), 10);
    assert.equal(context.send([bar, TBM_GETSELEND, 0, 0]), 70);
    context.send([bar, TBM_CLEARSEL, 1, 0]);
    assert.equal(context.send([bar, TBM_GETSELSTART, 0, 0]), 0);
    assert.equal(context.send([bar, TBM_GETSELEND, 0, 0]), 0);
});

test('the keys move the position, then tell the parent; a key let go ends the track',
    async()=>{
        const context = setupBars();
        await context.makeParent();
        const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
        context.sent.length = 0;
        await context.send([bar, WM_KEYDOWN, VK_RIGHT, 0]);
        assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 1);
        await context.send([bar, WM_KEYUP, VK_RIGHT, 0]);
        await context.send([bar, WM_KEYDOWN, VK_NEXT, 0]);
        assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 21);
        await context.send([bar, WM_KEYDOWN, VK_END, 0]);
        assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 100);
        await context.send([bar, WM_KEYDOWN, VK_LEFT, 0]);
        await context.send([bar, WM_KEYDOWN, VK_HOME, 0]);
        assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 0);
        // A key at the end it already is at moves nothing and says nothing.
        await context.send([bar, WM_KEYDOWN, VK_HOME, 0]);
        assert.deepEqual(scrolls(context).map(([code])=>code),
            [TB_LINEDOWN, TB_ENDTRACK, TB_PAGEDOWN, TB_BOTTOM, TB_LINEUP, TB_TOP]);
        assert.ok(scrolls(context).every(([, , from])=>from === bar),
            'the control\'s window in lParam');
    });

test('a dragged thumb tracks with its position in the high word, then lands', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    const thumb = rectBy(context, bar, TBM_GETTHUMBRECT);
    const channel = rectBy(context, bar, TBM_GETCHANNELRECT);
    assert.ok(thumb.right > thumb.left && thumb.bottom > thumb.top, JSON.stringify(thumb));
    assert.ok(channel.right - channel.left > 150, JSON.stringify(channel));
    const y = (thumb.top + thumb.bottom) >> 1;
    context.sent.length = 0;
    await context.send([bar, WM_LBUTTONDOWN, 1, point((thumb.left + thumb.right) >> 1, y)]);
    await context.send([bar, WM_MOUSEMOVE, 1, point((channel.left + channel.right) >> 1, y)]);
    const middle = context.send([bar, TBM_GETPOS, 0, 0]);
    assert.ok(middle > 40 && middle < 60, `half way: ${middle}`);
    await context.send([bar, WM_MOUSEMOVE, 1, point(channel.right + 50, y)]);
    assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 100, 'held at the end');
    await context.send([bar, WM_LBUTTONUP, 0, point(channel.right + 50, y)]);
    assert.deepEqual(scrolls(context).map(([code, pos])=>[code, pos]),
        [[TB_THUMBTRACK, middle], [TB_THUMBTRACK, 100], [TB_THUMBPOSITION, 100],
            [TB_ENDTRACK, 0]]);
    // The thumb moved with the position.
    assert.ok(rectBy(context, bar, TBM_GETTHUMBRECT).left > thumb.left);
});

test('a click on the channel beside the thumb pages toward it', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    const channel = rectBy(context, bar, TBM_GETCHANNELRECT);
    const y = (channel.top + channel.bottom) >> 1;
    context.sent.length = 0;
    await context.send([bar, WM_LBUTTONDOWN, 1, point(channel.right - 4, y)]);
    await context.send([bar, WM_LBUTTONUP, 0, point(channel.right - 4, y)]);
    assert.equal(context.send([bar, TBM_GETPOS, 0, 0]), 20);
    assert.deepEqual(scrolls(context).map(([code])=>code), [TB_PAGEDOWN, TB_ENDTRACK]);
});

test('a vertical trackbar tells the parent with WM_VSCROLL', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, TBS_VERT, [10, 10, 30, 150]);
    context.sent.length = 0;
    await context.send([bar, WM_KEYDOWN, VK_RIGHT, 0]);
    assert.deepEqual(context.sent.filter(m=>m.message === WM_VSCROLL).length, 1);
    const channel = rectBy(context, bar, TBM_GETCHANNELRECT);
    assert.ok(channel.bottom - channel.top > channel.right - channel.left, 'standing up');
});

test('only a fixed-length thumb takes a length of the program\'s', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    const length = context.send([bar, TBM_GETTHUMBLENGTH, 0, 0]);
    context.send([bar, TBM_SETTHUMBLENGTH, 9, 0]);
    assert.equal(context.send([bar, TBM_GETTHUMBLENGTH, 0, 0]), length);
    const fixed = await context.control(TRACKBAR_CLASS, TBS_FIXEDLENGTH, [10, 50, 200, 30]);
    context.send([fixed, TBM_SETTHUMBLENGTH, 9, 0]);
    assert.equal(context.send([fixed, TBM_GETTHUMBLENGTH, 0, 0]), 9);
});

test('a trackbar paints a face background and a raised thumb', async()=>{
    const context = setupBars();
    await context.makeParent();
    const bar = await context.control(TRACKBAR_CLASS, 0, [10, 10, 200, 30]);
    await context.pump();
    const thumb = rectBy(context, bar, TBM_GETTHUMBRECT);
    assert.equal(context.pixel(bar, 199, 0), FACE, 'the background');
    assert.equal(context.pixel(bar, thumb.left, thumb.top), 0x00ffffff, 'a lit top-left');
    assert.equal(context.pixel(bar, (thumb.left + thumb.right) >> 1,
        (thumb.top + thumb.bottom) >> 1), FACE, 'a face inside');
});

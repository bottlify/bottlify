/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A device context a program holds on its window, on the real drawing engine
 * and the shared screen: what it reaches follows the windows, not the moment
 * it was taken. A program that takes a DC once and draws a frame through it
 * every frame -- never through BeginPaint, never releasing it -- must not draw
 * over a dialog opened since, nor at the place its window has left (MSDN
 * GetDC; Wine's dce.c test_dc_visrgn).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import * as surfaces from '../../graphics/gdi/surface.js';
import { setupBars, TEXT, HINSTANCE } from '../comctl32/bars.fixture.js';

const WS_POPUP = 0x80000000 | 0;
const WS_VISIBLE = 0x10000000;
const SWP_NOSIZE = 0x1;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;
const RECT = 0x13800;
const RED = 0x000000ff;
const BLUE = 0x00ff0000;

/** A program's window at the screen's corner, and a popup class with a white background. */
async function screen(){
    const context = setupBars({ createGdiDrawing, ...surfaces });
    const window = await context.makeParent(200, 150);
    const name = TEXT + 256;
    context.memory.putString(name, 'popup');
    const CLASS = name + 64;
    const COLOR_WINDOW = 5;
    context.memory.put32s(CLASS, [0, 0x401000, 0, 0, HINSTANCE, 0, 0, COLOR_WINDOW + 1, 0, name]);
    context.fns.RegisterClassA.handler([CLASS]);
    context.memory.put32s(RECT, [0, 0, 200, 150]);
    /** @param {number} hdc @param {number} color */
    const fill = (hdc, color)=>context.fns.FillRect.handler(
        [hdc, RECT, context.gdi32.CreateSolidBrush.handler([color])]);
    return { context, window, name, fill };
}

test('a DC held from before a popup opened does not draw over the popup', async()=>{
    const { context, window, name, fill } = await screen();
    const held = context.fns.GetDC.handler([window]);
    fill(held, BLUE);
    assert.equal(context.desktop.read(100, 80), 0x0000ff, 'blue, as a pixel');

    await context.fns.CreateWindowExA.handler([0, name, name, WS_POPUP | WS_VISIBLE,
        80, 60, 60, 40, 0, 0, HINSTANCE, 0]);
    await context.pump();
    const popup = context.desktop.read(100, 80);
    fill(held, RED);
    assert.equal(context.desktop.read(100, 80), popup, 'the popup is still there');
    const corner = context.toScreen(window, 10, 10);
    assert.equal(context.desktop.read(corner.x, corner.y), 0xff0000,
        'the rest of the window is red');
});

test('a DC held across a move draws where the window is now', async()=>{
    const { context, window, fill } = await screen();
    const held = context.fns.GetDC.handler([window]);
    await context.fns.SetWindowPos.handler([window, 0, 150, 100, 0, 0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE]);
    await context.pump();
    const left = context.desktop.read(10, 40);
    fill(held, RED);
    assert.equal(context.desktop.read(10, 40), left, 'nothing drawn where it was');
    const corner = context.toScreen(window, 10, 10);
    assert.equal(context.desktop.read(corner.x, corner.y), 0xff0000, 'drawn where it is');
});

const CS_OWNDC = 0x20;
const CS_CLASSDC = 0x40;
const R2_WHITE = 16;
const R2_BLACK = 1;
const DCX_EXCLUDERGN = 0x40;
const DCX_INTERSECTRGN = 0x80;
const DCX_USESTYLE = 0x10000;

/**
 * Popups of a class with `style` at the screen's corner, 100 by 100, and the
 * calls the cases below read a context with.
 *
 * @param {number} style  The class's.
 */
async function classed(style){
    const context = setupBars({ createGdiDrawing, ...surfaces });
    await context.makeParent(200, 150);
    const name = TEXT + 256;
    context.memory.putString(name, `kept${style}`);
    const CLASS = name + 64;
    context.memory.put32s(CLASS, [style, 0x401000, 0, 0, HINSTANCE, 0, 0, 0, 0, name]);
    context.fns.RegisterClassA.handler([CLASS]);
    /** @param {number} x @param {number} y */
    const make = async(x, y)=>{
        const hwnd = await context.fns.CreateWindowExA.handler([0, name, name,
            WS_POPUP | WS_VISIBLE, x, y, 100, 100, 0, 0, HINSTANCE, 0]);
        await context.pump();
        return hwnd;
    };
    const { gdi32, memory } = context;
    const BOX = TEXT + 0x200;
    /** @param {number} hdc */
    const clipBox = hdc=>{
        gdi32.GetClipBox.handler([hdc, BOX]);
        return [0, 4, 8, 12].map(at=>memory.i32(BOX + at));
    };
    /** @param {number} region */
    const regionAlive = region=>gdi32.GetRgnBox.handler([region, BOX]) !== 0;
    /** A region over the window's client rectangle from (l, t) to (r, b), on the screen. */
    const regionOver = (/** @type {number} */ hwnd, /** @type {number[]} */ [l, t, r, b])=>{
        const at = context.toScreen(hwnd, l, t);
        return gdi32.CreateRectRgn.handler([at.x, at.y, at.x + r - l, at.y + b - t]);
    };
    return { context, make, clipBox, regionAlive, regionOver };
}

test('a CS_OWNDC window hands out one context, which keeps what was set in it', async()=>{
    // dce.c test_dc_attributes and test_parameters.
    const { context, make } = await classed(CS_OWNDC);
    const { fns, gdi32 } = context;
    const hwnd = await make(10, 10);
    const hdc = fns.GetDC.handler([hwnd]);
    gdi32.SetROP2.handler([hdc, R2_WHITE]);
    assert.equal(fns.ReleaseDC.handler([hwnd, hdc]), 1);
    assert.equal(fns.WindowFromDC.handler([hdc]), hwnd, 'still its window\'s');
    assert.equal(fns.GetDC.handler([hwnd]), hdc, 'the same context again');
    assert.equal(gdi32.GetROP2.handler([hdc]), R2_WHITE, 'with what was set in it');
    assert.equal(fns.ReleaseDC.handler([hwnd, hdc]), 1);
    assert.equal(fns.ReleaseDC.handler([hwnd, hdc]), 1, 'a second release succeeds too');
    assert.equal(gdi32.GetROP2.handler([hdc]), R2_WHITE);
});

test('a CS_CLASSDC class hands its one context to whichever window asks', async()=>{
    const { context, make } = await classed(CS_CLASSDC);
    const { fns, gdi32 } = context;
    const first = await make(10, 10);
    const second = await make(120, 10);
    const hdc = fns.GetDC.handler([first]);
    gdi32.SetROP2.handler([hdc, R2_BLACK]);
    assert.equal(fns.GetDC.handler([second]), hdc, 'the class\'s one context');
    assert.equal(gdi32.GetROP2.handler([hdc]), R2_BLACK, 'with what was set in it');
    assert.equal(fns.WindowFromDC.handler([hdc]), second, 'on the window that asked');
    fns.ReleaseDC.handler([first, hdc]);
    assert.equal(fns.WindowFromDC.handler([hdc]), second);
});

test('a cache context is a new one each time, and released it names nothing', async()=>{
    const { context, make } = await classed(0);
    const { fns, gdi32 } = context;
    const hwnd = await make(10, 10);
    const hdc = fns.GetDC.handler([hwnd]);
    const R2_COPYPEN = 13;
    gdi32.SetROP2.handler([hdc, R2_WHITE]);
    assert.equal(fns.ReleaseDC.handler([0x1234, hdc]), 1,
        'released whichever window the call names');
    assert.equal(fns.ReleaseDC.handler([hwnd, hdc]), 0, 'and only once');
    assert.equal(gdi32.GetROP2.handler([hdc]), 0, 'a released context answers nothing');
    assert.equal(gdi32.GetROP2.handler([fns.GetDC.handler([hwnd])]), R2_COPYPEN,
        'the next one starts afresh');
});

test('GetDCEx keeps a context to its region, which the system owns from then on', async()=>{
    // dce.c test_dc_visrgn: a cache context's region goes when it is
    // released; a kept one's stays until another region takes its place.
    const cache = await classed(0);
    const plain = await cache.make(10, 10);
    let region = cache.regionOver(plain, [10, 10, 20, 20]);
    let hdc = cache.context.fns.GetDCEx.handler([plain, region,
        DCX_INTERSECTRGN | DCX_USESTYLE]);
    assert.deepEqual(cache.clipBox(hdc), [10, 10, 20, 20]);
    assert.ok(cache.regionAlive(region), 'the region still there while the context is out');
    cache.context.fns.ReleaseDC.handler([plain, hdc]);
    assert.ok(!cache.regionAlive(region), 'and gone with it');

    const own = await classed(CS_OWNDC);
    const hwnd = await own.make(10, 10);
    const { fns } = own.context;
    region = own.regionOver(hwnd, [10, 10, 20, 20]);
    hdc = fns.GetDCEx.handler([hwnd, region, DCX_INTERSECTRGN | DCX_USESTYLE]);
    fns.ReleaseDC.handler([hwnd, hdc]);
    assert.ok(own.regionAlive(region), 'a kept context keeps its region');
    assert.deepEqual(own.clipBox(fns.GetDCEx.handler([hwnd, 0, DCX_USESTYLE])), [10, 10, 20, 20],
        'and is kept to it when asked for again');
    const next = own.regionOver(hwnd, [20, 20, 30, 30]);
    hdc = fns.GetDCEx.handler([hwnd, next, DCX_INTERSECTRGN | DCX_USESTYLE]);
    assert.ok(!own.regionAlive(region), 'until another takes its place');
    assert.deepEqual(own.clipBox(hdc), [20, 20, 30, 30]);
    hdc = fns.GetDCEx.handler([hwnd, 0, DCX_EXCLUDERGN | DCX_USESTYLE]);
    assert.ok(!own.regionAlive(next), 'or none does');
    assert.deepEqual(own.clipBox(hdc), [0, 0, 100, 100]);
});

test('a CS_OWNDC context keeps a paint\'s limit until EndPaint, not ReleaseDC', async()=>{
    // dce.c test_begin_paint.
    const { context, make, clipBox } = await classed(CS_OWNDC);
    const { fns, memory } = context;
    const hwnd = await make(10, 10);
    const DIRTY = TEXT + 0x240;
    const PS = TEXT + 0x280;
    fns.ValidateRect.handler([hwnd, 0]);
    memory.put32s(DIRTY, [10, 10, 20, 20]);
    fns.InvalidateRect.handler([hwnd, DIRTY, 0]);
    const hdc = await fns.BeginPaint.handler([hwnd, PS]);
    assert.deepEqual(clipBox(hdc), [10, 10, 20, 20]);
    fns.ReleaseDC.handler([hwnd, hdc]);
    assert.deepEqual(clipBox(hdc), [10, 10, 20, 20], 'ReleaseDC leaves it as it is');
    assert.equal(fns.GetDC.handler([hwnd]), hdc);
    assert.deepEqual(clipBox(hdc), [10, 10, 20, 20]);
    fns.EndPaint.handler([hwnd, PS]);
    assert.deepEqual(clipBox(hdc), [0, 0, 100, 100], 'EndPaint gives it the window back');
});

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

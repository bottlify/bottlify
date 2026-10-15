/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What ScrollDC and ScrollWindowEx leave to be painted, on the real drawing
 * engine: a region, not the strip along one edge -- where the pixels came
 * from a part that does not show, as under a sibling over the window, is
 * owed too, and an update still owed moves with the pixels and stays owed
 * where it was. The cases and their answers are those of Wine's win.c
 * test_scrollvalidate, which real Windows passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import * as surfaces from '../../graphics/gdi/surface.js';
import { createScreen } from '../../graphics/gdi/screen.js';
import { setupBars, OUT } from '../comctl32/bars.fixture.js';

const WS_CLIPSIBLINGS = 0x04000000;
const WS_CLIPCHILDREN = 0x02000000;
const WS_BORDER = 0x00800000;
const SW_SCROLLCHILDREN = 0x1;
const SW_INVALIDATE = 0x2;
const GWL_STYLE = -16;
const RC = OUT + 0x200;
const CLIP = OUT + 0x210;
const RCU = OUT + 0x220;

/** Two overlapping static children, the second made under the first. */
async function overlapping(){
    const context = setupBars({ createGdiDrawing, createScreen, ...surfaces });
    await context.makeParent(300, 250);
    const hwnd2 = await context.control('static', WS_CLIPSIBLINGS | WS_BORDER, [75, 30, 100, 100]);
    const hwnd1 = await context.control('static', WS_CLIPSIBLINGS | WS_BORDER, [25, 50, 100, 100]);
    await context.pump();
    const { gdi32 } = context;
    const hrgn = gdi32.CreateRectRgn.handler([0, 0, 0, 0]);
    /** @param {number[][]} rects @param {string} message */
    const expectRegion = (rects, message)=>{
        const expected = gdi32.CreateRectRgn.handler([0, 0, 0, 0]);
        for (const rect of rects)
        {
            const piece = gdi32.CreateRectRgn.handler(rect);
            gdi32.CombineRgn.handler([expected, expected, piece, 2]);
            gdi32.DeleteObject.handler([piece]);
        }
        const size = gdi32.GetRegionData.handler([hrgn, 0, 0]);
        gdi32.GetRegionData.handler([hrgn, size, OUT + 0x400]);
        const count = context.memory.i32(OUT + 0x408);
        const got = Array.from({ length: count }, (_, index)=>[0, 4, 8, 12]
            .map(at=>context.memory.i32(OUT + 0x420 + index * 16 + at)));
        assert.equal(gdi32.EqualRgn.handler([expected, hrgn]), 1,
            `${message}: got ${JSON.stringify(got)}`);
        gdi32.DeleteObject.handler([expected]);
    };
    const rcu = ()=>[0, 4, 8, 12].map(at=>context.memory.i32(RCU + at));
    return { context, hwnd1, hwnd2, hrgn, expectRegion, rcu };
}

test('ScrollDC owes what the pixels left and what came from under a sibling', async()=>{
    const { context, hwnd1, hrgn, expectRegion } = await overlapping();
    const { fns, gdi32, memory } = context;
    fns.GetClientRect.handler([hwnd1, RC]);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.i32(RC + at)), [0, 0, 98, 98]);
    fns.GetClientRect.handler([hwnd1, CLIP]);
    const hdc = fns.GetDC.handler([hwnd1]);
    fns.ScrollDC.handler([hdc, -10, -5, RC, CLIP, hrgn, RCU]);
    expectRegion([[39, 0, 49, 74], [88, 79, 98, 93], [0, 93, 98, 98]], 'without a clip');

    const clipping = gdi32.CreateRectRgn.handler([10, 10, 90, 90]);
    gdi32.SelectClipRgn.handler([hdc, clipping]);
    fns.ScrollDC.handler([hdc, -10, -5, RC, CLIP, hrgn, RCU]);
    expectRegion([[39, 10, 49, 74], [80, 79, 90, 85], [10, 85, 90, 90]], 'with a clip region');
    fns.ReleaseDC.handler([hwnd1, hdc]);
});

test('ScrollWindowEx carries an owed update with the pixels and keeps it owed', async()=>{
    const { context, hwnd1, hwnd2, hrgn, expectRegion, rcu } = await overlapping();
    const { fns, memory } = context;
    await fns.DestroyWindow.handler([hwnd2]);
    fns.ValidateRect.handler([hwnd1, 0]);
    memory.put32s(RC, [40, 40, 50, 50]);
    fns.InvalidateRect.handler([hwnd1, RC, 1]);
    assert.equal(fns.ScrollWindowEx.handler([hwnd1, -20, 0, RC, 0, hrgn, RCU,
        SW_SCROLLCHILDREN | SW_INVALIDATE]), 3);
    expectRegion([[20, 40, 30, 50], [40, 40, 50, 50]], 'a rectangle scrolled past its size');
    assert.deepEqual(rcu(), [20, 40, 50, 50]);

    fns.ValidateRect.handler([hwnd1, 0]);
    memory.put32s(RC, [40, 40, 50, 50]);
    fns.InvalidateRect.handler([hwnd1, RC, 1]);
    fns.GetClientRect.handler([hwnd1, RC]);
    fns.GetClientRect.handler([hwnd1, CLIP]);
    fns.ScrollWindowEx.handler([hwnd1, -10, 0, RC, CLIP, hrgn, RCU,
        SW_SCROLLCHILDREN | SW_INVALIDATE]);
    expectRegion([[88, 0, 98, 98], [30, 40, 50, 50]], 'a window with an update region');

    await fns.UpdateWindow.handler([hwnd1]);
    memory.put32s(RC, [0, 40, 100, 60]);
    memory.put32s(CLIP, [0, 0, 100, 100]);
    fns.ScrollWindowEx.handler([hwnd1, 0, -25, RC, CLIP, hrgn, RCU, SW_INVALIDATE]);
    expectRegion([[0, 40, 98, 60]], 'an excessive scroll');
});

test('ScrollWindowEx goes over children it takes along, and around those it leaves', async()=>{
    const { context, hwnd1, hwnd2, hrgn, expectRegion } = await overlapping();
    const { fns, memory } = context;
    await fns.DestroyWindow.handler([hwnd2]);
    const name = OUT + 0x300;
    memory.putString(name, 'static');
    const child = await fns.CreateWindowExA.handler([0, name, 0,
        0x40000000 | 0x10000000 | WS_BORDER, 50, 50, 100, 100, hwnd1, 0, 0x400000, 0]);
    await context.pump();
    const style = ()=>fns.GetWindowLongA.handler([hwnd1, GWL_STYLE]);
    fns.SetWindowLongA.handler([hwnd1, GWL_STYLE, style() & ~WS_CLIPSIBLINGS]);
    fns.GetClientRect.handler([hwnd1, RC]);
    fns.GetClientRect.handler([hwnd1, CLIP]);
    const strips = [[88, 0, 98, 88], [0, 88, 98, 98]];
    /** @param {boolean} clipChildren @param {number} flags */
    const scroll = (clipChildren, flags)=>{
        fns.SetWindowLongA.handler([hwnd1, GWL_STYLE,
            clipChildren ? style() | WS_CLIPCHILDREN : style() & ~WS_CLIPCHILDREN]);
        fns.ValidateRect.handler([hwnd1, 0]);
        fns.ValidateRect.handler([child, 0]);
        return fns.ScrollWindowEx.handler([hwnd1, -10, -10, RC, CLIP, hrgn, RCU, flags]);
    };
    await scroll(true, SW_SCROLLCHILDREN | SW_INVALIDATE);
    expectRegion(strips, 'clipping children, taking them along');
    await scroll(false, SW_SCROLLCHILDREN | SW_INVALIDATE);
    expectRegion(strips, 'taking children along');
    await scroll(false, SW_INVALIDATE);
    expectRegion(strips, 'leaving children');
    await scroll(true, SW_INVALIDATE);
    expectRegion([[88, 0, 98, 20], [20, 20, 98, 30], [20, 30, 30, 88], [0, 88, 30, 98]],
        'clipping children, leaving them');
});

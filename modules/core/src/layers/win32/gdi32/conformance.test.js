/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Answers gdi32 owes a program whatever it draws with, checked against the
 * real drawing engine: the clip a DC reports, the state SaveDC keeps, the
 * colours a palette-relative COLORREF names, and the refusals Windows gives
 * a bad argument instead of taking the run down. Each expectation is what
 * Windows answers in Wine's gdi32 conformance tests, named per test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { painted } from './fixtures.test.js';
import { DEFAULT_PALETTE_COLORS } from './drawing.js';

const SIMPLEREGION = 2;
const COMPLEXREGION = 3;
const NULLREGION = 1;
const RGN_AND = 1;
const MM_ISOTROPIC = 7;
const MM_ANISOTROPIC = 8;
const BLACKONWHITE = 1;
const COLORONCOLOR = 3;
const HALFTONE = 4;
const GM_COMPATIBLE = 1;
const GM_ADVANCED = 2;
const AD_COUNTERCLOCKWISE = 1;
const AD_CLOCKWISE = 2;
const ERROR_NOACCESS = 998;
const ERROR_INSUFFICIENT_BUFFER = 122;
const RECT_AT = 0x200;
const SIZE_AT = 0x240;

/** @param {ReturnType<typeof painted>} machine @param {number} at */
const rectAt = (machine, at)=>[0, 4, 8, 12].map(offset=>machine.view.getInt32(at + offset, true));

/** @param {ReturnType<typeof painted>} machine @param {number} [at] */
const clipBox = (machine, at = RECT_AT)=>{
    const kind = machine.fns.GetClipBox.handler([machine.dc, at]);
    return { kind, box: rectAt(machine, at) };
};

test('GetClipBox is the clip, not the surface; PtVisible and RectVisible agree'
    + ' (dc.c test_savedc_2)', ()=>{
    const machine = painted(100, 100);
    assert.deepEqual(clipBox(machine), { kind: SIMPLEREGION, box: [0, 0, 100, 100] });

    machine.fns.IntersectClipRect.handler([machine.dc, 10, 10, 20, 20]);
    assert.deepEqual(clipBox(machine), { kind: SIMPLEREGION, box: [10, 10, 20, 20] });
    assert.equal(machine.fns.PtVisible.handler([machine.dc, 15, 15]), 1);
    assert.equal(machine.fns.PtVisible.handler([machine.dc, 5, 5]), 0);
    assert.equal(machine.fns.PtVisible.handler([machine.dc, 20, 15]), 0,
        'the right edge is outside');
    machine.view.setInt32(0x210, 0, true);
    machine.view.setInt32(0x214, 0, true);
    machine.view.setInt32(0x218, 5, true);
    machine.view.setInt32(0x21c, 5, true);
    assert.equal(machine.fns.RectVisible.handler([machine.dc, 0x210]), 0);

    machine.fns.ExcludeClipRect.handler([machine.dc, 12, 12, 14, 14]);
    assert.deepEqual(clipBox(machine), { kind: COMPLEXREGION, box: [10, 10, 20, 20] });
});

test('GetClipBox answers in logical units under a moved viewport (mapping.c test_dc_layout)', ()=>{
    const machine = painted(100, 100);
    machine.fns.IntersectClipRect.handler([machine.dc, 10, 10, 20, 20]);
    machine.fns.SetViewportOrgEx.handler([machine.dc, 5, 5, 0]);
    assert.deepEqual(clipBox(machine).box, [5, 5, 15, 15]);
    assert.equal(machine.fns.PtVisible.handler([machine.dc, 5, 5]), 1);
});

test('a clip that leaves nothing is NULLREGION with an empty box', ()=>{
    const machine = painted(100, 100);
    machine.fns.IntersectClipRect.handler([machine.dc, 10, 10, 20, 20]);
    machine.fns.IntersectClipRect.handler([machine.dc, 50, 50, 60, 60]);
    assert.deepEqual(clipBox(machine), { kind: NULLREGION, box: [0, 0, 0, 0] });
});

test('SetMetaRgn folds the clip into the meta region, which no later clip can widen'
    + ' (clipping.c test_GetRandomRgn)', ()=>{
    const machine = painted(100, 100);
    const { fns, dc } = machine;
    const region = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    assert.equal(fns.GetRandomRgn.handler([dc, region, 1]), 0, 'CLIPRGN: none yet');
    assert.equal(fns.GetRandomRgn.handler([dc, region, 2]), 0, 'METARGN: none yet');
    assert.equal(fns.GetRandomRgn.handler([dc, region, 3]), 0, 'APIRGN: none yet');

    fns.IntersectClipRect.handler([dc, 20, 20, 80, 80]);
    assert.equal(fns.GetRandomRgn.handler([dc, region, 3]), 1);
    fns.GetRgnBox.handler([region, RECT_AT]);
    assert.deepEqual(rectAt(machine, RECT_AT), [20, 20, 80, 80]);

    assert.equal(fns.SetMetaRgn.handler([dc]), SIMPLEREGION);
    assert.equal(fns.GetClipRgn.handler([dc, region]), 0, 'the clip went into the meta region');
    assert.equal(fns.GetMetaRgn.handler([dc, region]), 1);
    fns.GetRgnBox.handler([region, RECT_AT]);
    assert.deepEqual(rectAt(machine, RECT_AT), [20, 20, 80, 80]);

    // A clip selected afterwards is cut by the meta region.
    const wide = fns.CreateRectRgn.handler([0, 0, 100, 100]);
    fns.SelectClipRgn.handler([dc, wide]);
    assert.deepEqual(clipBox(machine).box, [20, 20, 80, 80]);
    machine.fill(0);
    fns.PatBlt.handler([dc, 0, 0, 100, 100, 0x00ff0062]);
    assert.equal(machine.pixel(10, 10), 0, 'outside the meta region nothing is drawn');
    assert.equal(machine.pixel(50, 50), 0xffffffff, 'WHITENESS sets every bit, as bitmap.c finds');
});

test('the stretch mode is the DC\'s: a bitmap selected after it keeps it, RestoreDC puts it back'
    + ' (MSDN SetStretchBltMode, SaveDC)', ()=>{
    const machine = painted(4, 4);
    const { fns } = machine;
    const dc = fns.CreateCompatibleDC.handler([0]);
    assert.equal(fns.GetStretchBltMode.handler([dc]), BLACKONWHITE);
    assert.equal(fns.SetStretchBltMode.handler([dc, COLORONCOLOR]), BLACKONWHITE);
    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([machine.dc, 8, 8])]);
    assert.equal(fns.GetStretchBltMode.handler([dc]), COLORONCOLOR);

    const level = fns.SaveDC.handler([dc]);
    fns.SetStretchBltMode.handler([dc, HALFTONE]);
    fns.RestoreDC.handler([dc, level]);
    assert.equal(fns.GetStretchBltMode.handler([dc]), COLORONCOLOR);
    assert.equal(fns.SetStretchBltMode.handler([dc, 9]), 0, 'a mode there is not');
});

test('RestoreDC puts back the graphics mode, the world transform and the arc direction', ()=>{
    const machine = painted(4, 4);
    const { fns, dc } = machine;
    const level = fns.SaveDC.handler([dc]);
    fns.SetGraphicsMode.handler([dc, GM_ADVANCED]);
    fns.SetArcDirection.handler([dc, AD_CLOCKWISE]);
    fns.RestoreDC.handler([dc, level]);
    assert.equal(fns.GetGraphicsMode.handler([dc]), GM_COMPATIBLE);
    assert.equal(fns.GetArcDirection.handler([dc]), AD_COUNTERCLOCKWISE);
});

test('a shrinking StretchBlt keeps the colours it is told to in COLORONCOLOR after a'
    + ' selection', ()=>{
    const machine = painted(4, 4);
    const { fns } = machine;
    const source = machine.section(4, 4);
    for (let y = 0; y < 4; y++)
    {
        for (let x = 0; x < 4; x++)
        {
            source.put(x, y, (x + y) % 2 === 0 ? 0x00ff0000 : 0x0000ff00);
        }
    }
    const dc = fns.CreateCompatibleDC.handler([0]);
    fns.SetStretchBltMode.handler([dc, COLORONCOLOR]);
    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([machine.dc, 2, 2])]);
    fns.StretchBlt.handler([dc, 0, 0, 2, 2, source.dc, 0, 0, 4, 4, 0x00cc0020]);
    assert.equal(fns.GetPixel.handler([dc, 0, 0]), 0x000000ff, 'a colour, not the AND of two');
});

test('PALETTEINDEX names the DC\'s palette entry; DIBINDEX the bitmap\'s colour table'
    + ' (bitmap.c test_dibsections, palette.c test_DIB_PAL_COLORS)', ()=>{
    const machine = painted(4, 4);
    const { fns, dc } = machine;
    // The table is in pixel order, 0xRRGGBB; a COLORREF is 0xBBGGRR.
    const entry = (/** @type {number} */ index)=>{
        const pixel = DEFAULT_PALETTE_COLORS[index];
        return ((pixel & 0xff) << 16 | pixel & 0xff00 | pixel >>> 16 & 0xff) >>> 0;
    };
    assert.equal(fns.SetPixel.handler([dc, 0, 0, 0x01000005]), entry(5));
    assert.equal(fns.GetPixel.handler([dc, 0, 0]), entry(5));
    assert.equal(fns.SetPixel.handler([dc, 0, 0, 0x01000400]), entry(0),
        'an index past the palette is its first entry');

    const brush = fns.CreateSolidBrush.handler([0x01000004]);
    fns.SelectObject.handler([dc, brush]);
    fns.PatBlt.handler([dc, 0, 0, 4, 4, 0x00f00021]);
    assert.equal(fns.GetPixel.handler([dc, 1, 1]), entry(4));

    // A one-bit section: DIBINDEX(1) is its second colour, white.
    const mono = machine.section(8, 1, { bitCount: 1 });
    assert.equal(fns.SetPixel.handler([mono.dc, 0, 0, 0x10ff0001]), 0x00ffffff);
    assert.equal(fns.SetPixel.handler([mono.dc, 0, 0, 0x10ff0000]), 0);
});

test('SetPixel answers the colour the pixel became, the nearest a 1-bit bitmap has', ()=>{
    const machine = painted(4, 4);
    const mono = machine.section(8, 1, { bitCount: 1 });
    assert.equal(machine.fns.SetPixel.handler([mono.dc, 0, 0, 0x00202020]), 0);
    assert.equal(machine.fns.SetPixel.handler([mono.dc, 0, 0, 0x00e0e0e0]), 0x00ffffff);
});

test('MM_ISOTROPIC shrinks the viewport so a unit is square (mapping.c test_SetWindowExt)', ()=>{
    const machine = painted(4, 4);
    const { fns, dc, view } = machine;
    fns.SetMapMode.handler([dc, MM_ISOTROPIC]);
    fns.SetWindowExtEx.handler([dc, 100, 100, 0]);
    fns.SetViewportExtEx.handler([dc, 200, -100, 0]);
    fns.GetViewportExtEx.handler([dc, SIZE_AT]);
    assert.deepEqual([view.getInt32(SIZE_AT, true), view.getInt32(SIZE_AT + 4, true)], [100, -100]);

    fns.SetMapMode.handler([dc, MM_ANISOTROPIC]);
    fns.SetViewportExtEx.handler([dc, 200, -100, 0]);
    fns.GetViewportExtEx.handler([dc, SIZE_AT]);
    assert.deepEqual([view.getInt32(SIZE_AT, true), view.getInt32(SIZE_AT + 4, true)], [200, -100],
        'MM_ANISOTROPIC takes the extents as they are');
});

test('ScaleViewportExtEx scales, and reports the extent it replaced', ()=>{
    const machine = painted(4, 4);
    const { fns, dc, view } = machine;
    fns.SetMapMode.handler([dc, MM_ANISOTROPIC]);
    fns.SetViewportExtEx.handler([dc, 100, 50, 0]);
    assert.equal(fns.ScaleViewportExtEx.handler([dc, 3, 2, 1, 5, SIZE_AT]), 1);
    assert.deepEqual([view.getInt32(SIZE_AT, true), view.getInt32(SIZE_AT + 4, true)], [100, 50]);
    fns.GetViewportExtEx.handler([dc, SIZE_AT]);
    assert.deepEqual([view.getInt32(SIZE_AT, true), view.getInt32(SIZE_AT + 4, true)], [150, 10]);
    assert.equal(fns.ScaleWindowExtEx.handler([dc, 1, 0, 1, 1, 0]), 0, 'a zero denominator');
});

test('a buffer GetObject cannot write is ERROR_NOACCESS, not the end of the run'
    + ' (gdiobj.c test_gdi_objects)', ()=>{
    const machine = painted(4, 4, { canWrite: address=>address >= 0x1000 });
    const pen = machine.fns.CreatePen.handler([0, 1, 0]);
    assert.equal(machine.fns.GetObjectA.handler([pen, 64, 0x100]), 0);
    assert.equal(machine.errors.at(-1), ERROR_NOACCESS);
    assert.ok(machine.fns.GetObjectA.handler([pen, 64, 0x2000]) > 0);
});

test('character widths past what the font can name are refused, not written'
    + ' (font.c test_GetCharABCWidths)', ()=>{
    const machine = painted(4, 4);
    const { fns, dc } = machine;
    const out = 0x3000;
    assert.equal(fns.GetCharABCWidthsA.handler([dc, 0, 0xff, out]), 1);
    assert.equal(fns.GetCharABCWidthsA.handler([dc, 0xff, 0x100, out]), 0);
    assert.equal(fns.GetCharABCWidthsA.handler([dc, 0x1ff, 0xff00, out]), 0);
    assert.equal(fns.GetCharWidth32A.handler([dc, 0, 0x100, out]), 0);
    assert.equal(fns.GetCharWidth32W.handler([dc, 0x41, 0x42, out]), 1);
});

test('ExtTextOut refuses a count of -1 rather than reading four gigabytes'
    + ' (dib.c test_simple_graphics)', ()=>{
    const machine = painted(4, 4);
    machine.bytes.set([0x41, 0], 0x3000);
    assert.equal(machine.fns.ExtTextOutA.handler([machine.dc, 0, 0, 0, 0, 0x3000, -1, 0]), 0);
});

test('CreateFontIndirectEx takes the LOGFONT it opens with; a null one is zero', ()=>{
    const machine = painted(4, 4);
    assert.equal(machine.fns.CreateFontIndirectExA.handler([0]), 0);
    assert.equal(machine.errors.length, 0, 'the last error is left alone');
    machine.bytes.fill(0, 0x3000, 0x3000 + 0x200);
    machine.view.setInt32(0x3000, -12, true);
    assert.ok(machine.fns.CreateFontIndirectExA.handler([0x3000]) !== 0);
});

test('GetICMProfile asks for room first, then names the display\'s profile (icm.c)', ()=>{
    const machine = painted(4, 4);
    const { fns, dc, view } = machine;
    assert.equal(fns.GetICMProfileA.handler([0, 0, 0]), 0);
    assert.equal(fns.GetICMProfileA.handler([dc, 0, 0]), 0);
    view.setUint32(SIZE_AT, 0, true);
    assert.equal(fns.GetICMProfileA.handler([dc, SIZE_AT, 0x3000]), 0);
    assert.equal(machine.errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    const needed = view.getUint32(SIZE_AT, true);
    assert.ok(needed > 1);
    assert.equal(machine.bytes[0x3000], 0, 'nothing written into a short buffer');
    view.setUint32(SIZE_AT, 260, true);
    assert.equal(fns.GetICMProfileA.handler([dc, SIZE_AT, 0x3000]), 1);
    assert.equal(machine.bytes[0x3000 + needed - 1], 0, 'terminated');
    assert.match(String.fromCharCode(...machine.bytes.subarray(0x3000, 0x3000 + needed - 1)),
        /\.icm$/);
});

test('FixBrushOrgEx does nothing and answers FALSE (brush.c test_brush_org)', ()=>{
    const machine = painted(4, 4);
    machine.view.setInt32(0x3000, 10, true);
    assert.equal(machine.fns.FixBrushOrgEx.handler([machine.dc, 2, 3, 0x3000]), 0);
    assert.equal(machine.view.getInt32(0x3000, true), 10);
});

test('RGN_AND of a clip with a region is what ExtSelectClipRgn leaves, and GetClipBox sees it',
    ()=>{
        const machine = painted(100, 100);
        const { fns, dc } = machine;
        fns.IntersectClipRect.handler([dc, 0, 0, 50, 50]);
        fns.ExtSelectClipRgn.handler([dc, fns.CreateRectRgn.handler([25, 25, 100, 100]), RGN_AND]);
        assert.deepEqual(clipBox(machine).box, [25, 25, 50, 50]);
    });

test('GetSystemPaletteEntries counts none on this display but writes the static colours'
    + ' (palette.c check_system_palette_entries)', ()=>{
    const machine = painted(4, 4);
    const out = 0x3000;
    machine.bytes.fill(0x55, out, out + 1024);
    assert.equal(machine.fns.GetSystemPaletteEntries.handler([machine.dc, 0, 256, out]), 0);
    const entry = (/** @type {number} */ index)=>[...machine.bytes.subarray(out + index * 4,
        out + index * 4 + 4)];
    assert.deepEqual(entry(1), [0x80, 0, 0, 0], 'the second static colour, dark red');
    assert.deepEqual(entry(100), [0, 0, 0, 0], 'black between the two ends');
    assert.deepEqual(entry(255), [0xff, 0xff, 0xff, 0], 'white last');
});

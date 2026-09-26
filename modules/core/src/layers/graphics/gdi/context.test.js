/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLR_INVALID, createGdiDrawing } from './context.js';
import { COLORONCOLOR, HALFTONE } from './blit.js';
import { DSTINVERT, PATCOPY, SRCCOPY } from './rop.js';
import { BS_HATCHED, BS_SOLID, HS_HORIZONTAL, OPAQUE, TRANSPARENT } from './brush.js';
import { PS_NULL, PS_SOLID } from './shapes.js';
import { TA_CENTER, TA_UPDATECP } from './text.js';
import {
    clearSurface, createSurface, surfaceForDdb, surfaceForDibSection,
} from './surface.js';
import { createGdiObjects } from '../../win32/gdi32/objects.js';
import { createGdiFunctions } from '../../win32/gdi32/functions.js';
import { BITMAPINFOHEADER } from '../../win32/gdi32/structs.js';
import {
    DDSCAPS_OFFSCREENPLAIN,
    DDSCL_NORMAL,
    DDSD_CAPS,
    DDSD_HEIGHT,
    DDSD_PIXELFORMAT,
    DDSD_WIDTH,
    DDPF_RGB,
    DD_OK,
} from '../ddraw/constants.js';
import { createDirectDraw } from '../ddraw/objects.js';

const BACKGROUND = 0x00202020;
const RED_COLOR = 0x000000ff;
const RED_PIXEL = 0x00ff0000;
const BLUE_COLOR = 0x00ff0000;
const BLUE_PIXEL = 0x000000ff;

const HDC = 0x1000;
const SOURCE_HDC = 0x2000;
const HWND = 0x4000;

/** The kernel handle table, reduced to what the GDI object table needs. */
function fakeHandles(){
    let next = 8;
    /** @type {Map<number, any>} */
    const entries = new Map();
    return {
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            entries.set(handle, object);
            return handle;
        },
        /** @param {number} handle */
        close(handle){
            const object = entries.get(handle);
            entries.delete(handle);
            return object;
        },
    };
}

const METRICS = Object.freeze({ cellWidth: 6, cellHeight: 10, ascent: 8 });

/**
 * A drawing layer over the bookkeeping half's real object table, so a pen
 * handle here is the pen a program would have created there.
 *
 * @param {{ width?: number, height?: number }} [options]
 */
function fixture(options = {}){
    const objects = createGdiObjects(fakeHandles());
    const drawing = createGdiDrawing({ objects, metrics: ()=>METRICS });
    const surface = createSurface({
        width: options.width ?? 16,
        height: options.height ?? 16,
    });
    clearSurface(surface, BACKGROUND);
    const context = drawing.bind(HDC, surface);
    return { objects, drawing, surface, context };
}

test('a context with no pixels answers nothing rather than throwing', ()=>{
    const drawing = createGdiDrawing();
    assert.equal(drawing.getPixel(HDC, 0, 0), CLR_INVALID);
    assert.equal(drawing.setPixel(HDC, 0, 0, RED_COLOR), CLR_INVALID);
    assert.equal(drawing.rectangle(HDC, 0, 0, 4, 4), false);
    assert.equal(drawing.contextOf(HDC), null);
});

test('SetPixel and GetPixel agree, and disagree with everything outside', ()=>{
    const { drawing, surface } = fixture();
    assert.equal(drawing.setPixel(HDC, 3, 4, RED_COLOR), RED_COLOR);
    assert.equal(surface.read(3, 4), RED_PIXEL, 'a COLORREF is not the pixel it becomes');
    assert.equal(drawing.getPixel(HDC, 3, 4), RED_COLOR);
    assert.equal(drawing.getPixel(HDC, 16, 4), CLR_INVALID);
    assert.equal(drawing.getPixel(HDC, -1, 0), CLR_INVALID);
    assert.equal(drawing.setPixel(HDC, 99, 0, RED_COLOR), CLR_INVALID);
});

test('a pixel outside the clip is refused, not silently dropped', ()=>{
    const { drawing, surface } = fixture();
    drawing.setClipRect(HDC, { left: 4, top: 4, right: 8, bottom: 8 });
    assert.equal(drawing.setPixel(HDC, 2, 2, RED_COLOR), CLR_INVALID);
    assert.equal(surface.read(2, 2), BACKGROUND);
    assert.equal(drawing.setPixel(HDC, 4, 4, RED_COLOR), RED_COLOR);
});

test('the selected pen and brush come from the shared object table', ()=>{
    const { objects, drawing, surface, context } = fixture();
    context.state.pen = objects.create('pen', { style: PS_SOLID, width: 1, color: RED_COLOR });
    context.state.brush = objects.create('brush', {
        style: BS_SOLID, color: BLUE_COLOR, hatch: 0,
    });

    drawing.rectangle(HDC, 2, 2, 8, 6);
    assert.equal(surface.read(2, 2), RED_PIXEL, 'the boundary is the pen');
    assert.equal(surface.read(7, 5), RED_PIXEL);
    assert.equal(surface.read(8, 5), BACKGROUND);
    assert.equal(surface.read(4, 4), BLUE_PIXEL, 'the interior is the brush');
});

test('a hatched brush honours the background mode and the brush origin', ()=>{
    const { objects, drawing, surface, context } = fixture();
    context.state.brush = objects.create('brush', {
        style: BS_HATCHED, color: RED_COLOR, hatch: HS_HORIZONTAL,
    });
    context.state.pen = objects.create('pen', { style: PS_NULL, width: 1, color: 0 });
    context.state.bkMode = TRANSPARENT;
    drawing.setBrushOrgEx(HDC, 0, 1);

    drawing.patBlt(HDC, 0, 0, 16, 16, PATCOPY);
    assert.equal(surface.read(3, 1), RED_PIXEL, 'the hatch line moved with the origin');
    assert.equal(surface.read(3, 0), BACKGROUND, 'a transparent gap keeps the destination');
    assert.equal(surface.read(3, 9), RED_PIXEL);

    context.state.bkMode = OPAQUE;
    context.state.bkColor = BLUE_COLOR;
    drawing.patBlt(HDC, 0, 0, 16, 16, PATCOPY);
    assert.equal(surface.read(3, 0), BLUE_PIXEL, 'an opaque gap is the background colour');
});

test('MoveToEx and LineTo share one current position with the other half', ()=>{
    const { objects, drawing, surface, context } = fixture();
    context.state.pen = objects.create('pen', { style: PS_SOLID, width: 1, color: RED_COLOR });

    // The state record is the bookkeeping half's own: a position set through
    // its MoveToEx is the position this LineTo starts from, because there is
    // only one of them.
    context.state.position = { x: 2, y: 2 };
    drawing.lineTo(HDC, 6, 2);
    assert.equal(surface.read(2, 2), RED_PIXEL);
    assert.equal(surface.read(5, 2), RED_PIXEL);
    assert.equal(surface.read(6, 2), BACKGROUND, 'the endpoint belongs to the next segment');
    assert.deepEqual(context.state.position, { x: 6, y: 2 });

    // Which the next LineTo then paints, so a polyline has no gap at the join.
    drawing.lineTo(HDC, 6, 6);
    assert.equal(surface.read(6, 2), RED_PIXEL);

    assert.deepEqual(drawing.moveToEx(HDC, 1, 1), { x: 6, y: 6 });
    assert.deepEqual(context.state.position, { x: 1, y: 1 });
});

test('InvertRect is exactly a DSTINVERT over the half-open rectangle', ()=>{
    const { drawing, surface } = fixture();
    drawing.invertRect(HDC, { left: 1, top: 1, right: 3, bottom: 3 });
    assert.equal(surface.read(1, 1), (~BACKGROUND) >>> 0);
    assert.equal(surface.read(2, 2), (~BACKGROUND) >>> 0);
    assert.equal(surface.read(3, 3), BACKGROUND);

    const again = createSurface({ width: 4, height: 4 });
    clearSurface(again, BACKGROUND);
    const drawing2 = createGdiDrawing();
    drawing2.bind(HDC, again);
    drawing2.patBlt(HDC, 1, 1, 2, 2, DSTINVERT);
    assert.equal(again.read(1, 1), surface.read(1, 1));
});

test('FillRect and FrameRect use the brush the call names, not the selected one', ()=>{
    const { objects, drawing, surface, context } = fixture();
    context.state.brush = objects.create('brush', {
        style: BS_SOLID, color: RED_COLOR, hatch: 0,
    });
    const blue = objects.create('brush', { style: BS_SOLID, color: BLUE_COLOR, hatch: 0 });

    drawing.fillRect(HDC, { left: 0, top: 0, right: 4, bottom: 4 }, blue);
    assert.equal(surface.read(0, 0), BLUE_PIXEL);
    assert.equal(surface.read(3, 3), BLUE_PIXEL);
    assert.equal(surface.read(4, 3), BACKGROUND);

    drawing.frameRect(HDC, { left: 8, top: 8, right: 12, bottom: 12 }, blue);
    assert.equal(surface.read(8, 8), BLUE_PIXEL);
    assert.equal(surface.read(11, 11), BLUE_PIXEL);
    assert.equal(surface.read(9, 9), BACKGROUND, 'a frame is hollow');
});

test('the stretch mode is per context and reaches StretchBlt', ()=>{
    const { drawing } = fixture({ width: 4, height: 4 });
    const source = createSurface({ width: 2, height: 2 });
    source.write(0, 0, 0x00ff0000);
    source.write(1, 0, 0x0000ff00);
    source.write(0, 1, 0x000000ff);
    source.write(1, 1, 0x00000000);
    drawing.bind(SOURCE_HDC, source);

    assert.equal(drawing.getStretchBltMode(HDC), 1, 'BLACKONWHITE is the default');
    assert.equal(drawing.setStretchBltMode(HDC, HALFTONE), 1, 'and is what the setter reports');
    assert.equal(drawing.getStretchBltMode(HDC), HALFTONE);
    assert.equal(drawing.setStretchBltMode(HDC, 99), 0, 'an unknown mode changes nothing');
    assert.equal(drawing.getStretchBltMode(HDC), HALFTONE);

    drawing.stretchBlt(HDC, 0, 0, 1, 1, SOURCE_HDC, 0, 0, 2, 2, SRCCOPY);
    assert.equal(drawing.getPixel(HDC, 0, 0), 0x00404040,
        'the four source pixels were averaged, which only HALFTONE does');

    drawing.setStretchBltMode(HDC, COLORONCOLOR);
    drawing.stretchBlt(HDC, 0, 0, 1, 1, SOURCE_HDC, 0, 0, 2, 2, SRCCOPY);
    assert.equal(drawing.getPixel(HDC, 0, 0), 0x000000ff, 'and now only the first survives');
});

test('BitBlt between two bound contexts moves pixels between their surfaces', ()=>{
    const { drawing, surface } = fixture();
    const source = createSurface({ width: 4, height: 4 });
    clearSurface(source, RED_PIXEL);
    drawing.bind(SOURCE_HDC, source);

    assert.equal(drawing.bitBlt(HDC, 2, 2, 4, 4, SOURCE_HDC, 0, 0, SRCCOPY), true);
    assert.equal(surface.read(2, 2), RED_PIXEL);
    assert.equal(surface.read(5, 5), RED_PIXEL);
    assert.equal(surface.read(6, 5), BACKGROUND);
    assert.equal(drawing.bitBlt(HDC, 0, 0, 4, 4, 0, 0, 0, SRCCOPY), false,
        'SRCCOPY without a source has nothing to copy');
});

test('TA_UPDATECP moves the current position by the string it just drew', ()=>{
    const { drawing, surface, context } = fixture({ width: 64, height: 32 });
    context.state.textColor = RED_COLOR;
    context.state.position = { x: 4, y: 2 };
    drawing.setTextAlign(HDC, TA_UPDATECP);

    // The coordinates the call carries are ignored when TA_UPDATECP is set.
    drawing.textOutA(HDC, 40, 40, 'HB');
    assert.equal(surface.read(4, 3), RED_PIXEL);
    assert.deepEqual(context.state.position, { x: 16, y: 2 });

    drawing.textOutA(HDC, 0, 0, 'L');
    assert.equal(surface.read(16, 3), RED_PIXEL, 'the second call starts where the first ended');
});

test('SetTextAlign reports the previous value and reaches the drawing', ()=>{
    const { drawing, surface, context } = fixture({ width: 64, height: 32 });
    context.state.textColor = RED_COLOR;
    assert.equal(drawing.setTextAlign(HDC, TA_CENTER), 0);
    assert.equal(drawing.getTextAlign(HDC), TA_CENTER);

    drawing.textOutA(HDC, 32, 0, 'AB');
    // Twelve pixels wide, centred on x = 32: the first cell starts at 26.
    assert.equal(surface.read(26, 3), RED_PIXEL);
    assert.equal(surface.read(25, 3), BACKGROUND);
});

test('a released context keeps its pixels and stops answering', ()=>{
    const { drawing, surface } = fixture();
    drawing.setPixel(HDC, 1, 1, RED_COLOR);
    assert.equal(drawing.count(), 1);
    assert.equal(drawing.release(HDC), surface);
    assert.equal(drawing.count(), 0);
    assert.equal(drawing.getPixel(HDC, 1, 1), CLR_INVALID);
    assert.equal(surface.read(1, 1), RED_PIXEL, 'the pixels outlive the context');
    assert.equal(drawing.release(HDC), null);
});

// --- the DIB section seam ---

/** The base guest address of the fake memory below. */
const MEMORY_BASE = 0;
const INFO = 0x2000;

/**
 * Enough of the win32 host for CreateDIBSection: flat memory, a handle table,
 * and an allocator that hands out addresses inside that memory.
 */
function fakeGdiHost(){
    const bytes = new Uint8Array(0x8000);
    let next = 0x3000;
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: ()=>'',
        handles: fakeHandles(),
        surfaces: {
            /** @param {number} size */
            allocate(size){
                const address = next;
                next += (size + 0xfff) & ~0xfff;
                return address;
            },
            free: ()=>undefined,
        },
    };
}

test('the bits CreateDIBSection allocated are a surface this layer can draw into', ()=>{
    const host = fakeGdiHost();
    const gdi = createGdiFunctions(host).table;

    // A four-by-three top-down 32-bit section, written as the guest would.
    const info = new Uint8Array(BITMAPINFOHEADER.SIZE);
    const view = new DataView(info.buffer);
    view.setUint32(BITMAPINFOHEADER.biSize, BITMAPINFOHEADER.SIZE, true);
    view.setInt32(BITMAPINFOHEADER.biWidth, 4, true);
    view.setInt32(BITMAPINFOHEADER.biHeight, -3, true);
    view.setUint16(BITMAPINFOHEADER.biPlanes, 1, true);
    view.setUint16(BITMAPINFOHEADER.biBitCount, 32, true);
    host.writeMemory(INFO, info);

    const bitmap = gdi.CreateDIBSection.handler([0, INFO, 0, 0, 0, 0]);
    assert.notEqual(bitmap, 0, 'the section must have been created');
    const record = host.handles.close(bitmap);
    const surface = surfaceForDibSection(record.attributes, host.bytes, MEMORY_BASE);
    assert.ok(surface, 'a 32-bit section is drawable as it stands');
    assert.equal(surface.pitch, 16);
    assert.equal(surface.topDown, true, 'a negative biHeight is recorded, not re-derived');

    const drawing = createGdiDrawing();
    drawing.bind(HDC, surface);
    drawing.setPixel(HDC, 1, 2, 0x00abcdef);
    // The address the guest was handed points at the byte the drawing wrote.
    const at = record.attributes.bits + (2 * 16) + (1 * 4);
    assert.equal(host.bytes[at], 0xab);
    assert.equal(host.bytes[at + 2], 0xef);
});

// --- the DirectDraw seam ---

/**
 * A DirectDraw whose surface memory is a real byte pool, so that a surface's
 * own Lock and a device context bound to the same address are two views of one
 * allocation rather than two numbers that happen to match.
 */
function withDirectDraw(){
    const pool = new Uint8Array(0x40000);
    let next = 0x100;
    const ddraw = createDirectDraw({
        version: 7,
        allocate: bytes=>{
            const address = next;
            next += (bytes + 0xfff) & ~0xfff;
            return address;
        },
    });
    ddraw.setCooperativeLevel(HWND, DDSCL_NORMAL);
    const created = ddraw.createSurface({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
        caps: DDSCAPS_OFFSCREENPLAIN,
        width: 8,
        height: 8,
        pixelFormat: {
            size: 0x20,
            flags: DDPF_RGB,
            fourCC: 0,
            bitCount: 32,
            redMask: 0x00ff0000,
            greenMask: 0x0000ff00,
            blueMask: 0x000000ff,
            alphaMask: 0,
        },
    });
    assert.equal(created.hr, DD_OK);
    return { pool, ddraw, surface: created.surface };
}

test('a DirectDraw surface pitch is the DWORD-aligned row a DIB section reports', ()=>{
    const { surface } = withDirectDraw();
    assert.ok(surface);
    // Eight pixels at four bytes each: the two pitch rules agree here, and the
    // seam only works because they do.
    assert.equal(surface.pitch, 32);
});

test('drawing into a surface GetDC lands in the pixels the surface itself reads', ()=>{
    const { pool, surface } = withDirectDraw();
    assert.ok(surface);
    const drawing = createGdiDrawing();

    // GetDC mints the handle; this layer is what gives that handle pixels.
    const got = surface.getDC();
    assert.equal(got.hr, DD_OK);
    const hdc = /** @type {number} */ (got.dc);

    const view = createSurface({
        width: surface.width,
        height: surface.height,
        pitch: surface.pitch,
        bytes: pool,
        offset: surface.buffer,
    });
    drawing.bind(hdc, view);

    const source = createSurface({ width: 2, height: 2 });
    clearSurface(source, RED_PIXEL);
    drawing.bind(SOURCE_HDC, source);
    assert.equal(drawing.bitBlt(hdc, 3, 4, 2, 2, SOURCE_HDC, 0, 0, SRCCOPY), true);

    assert.equal(surface.releaseDC(hdc), DD_OK);
    drawing.release(hdc);

    // The surface's own read path: Lock hands back an address into the same
    // pool, and the bytes there are the ones the blit wrote.
    const locked = surface.lock();
    assert.equal(locked.hr, DD_OK);
    const at = /** @type {number} */ (locked.surfacePointer) + (4 * locked.pitch) + (3 * 4);
    assert.equal(pool[at], 0x00, 'blue');
    assert.equal(pool[at + 1], 0x00, 'green');
    assert.equal(pool[at + 2], 0xff, 'red');
    assert.equal(pool[at + (locked.pitch * 1) + 4 + 2], 0xff, 'and the far corner of the blit');
    assert.equal(pool[at - 4], 0x00, 'one pixel left of the rectangle was not touched');
    assert.equal(surface.unlock(), DD_OK);
});

test('a partial lock points at the same bytes a context wrote through', ()=>{
    const { pool, surface } = withDirectDraw();
    assert.ok(surface);
    const drawing = createGdiDrawing();
    const got = surface.getDC();
    const hdc = /** @type {number} */ (got.dc);
    drawing.bind(hdc, createSurface({
        width: surface.width,
        height: surface.height,
        pitch: surface.pitch,
        bytes: pool,
        offset: surface.buffer,
    }));
    drawing.setPixel(hdc, 5, 6, 0x00abcdef);
    surface.releaseDC(hdc);

    // Locking a sub-rectangle whose corner is the pixel just written: the
    // pointer arithmetic and the drawing have to agree byte for byte.
    const locked = surface.lock({ left: 5, top: 6, right: 6, bottom: 7 });
    assert.equal(locked.hr, DD_OK);
    const at = /** @type {number} */ (locked.surfacePointer);
    // A COLORREF is 0x00bbggrr and the bytes are blue, green, red: the two run
    // in opposite directions, so 0xab arrives first and 0xef last.
    assert.equal(pool[at], 0xab, 'blue');
    assert.equal(pool[at + 1], 0xcd, 'green');
    assert.equal(pool[at + 2], 0xef, 'red');
});

// --- gdi32 over this drawing, end to end ---

/** A 16-by-16 32-bit screen, the depth a compatible bitmap then has. */
const WIRED_SCREEN = Object.freeze({ width: 16, height: 16, bitsPerPixel: 32 });

/**
 * gdi32's bookkeeping over this layer's drawing, wired as the graphics module
 * wires them: a memory context draws into its bitmap's own bits, a DIB
 * section's in guest memory and a device-dependent bitmap's in bytes of its
 * own, and a window's context into the screen.
 */
function wiredGdi(){
    const bytes = new Uint8Array(0x40000);
    let next = 0x10000;
    const screen = createSurface({ width: WIRED_SCREEN.width, height: WIRED_SCREEN.height });
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: ()=>'',
        handles: fakeHandles(),
        surfaces: {
            /** @param {number} size */
            allocate(size){
                const address = next;
                next += (size + 0xff) & ~0xff;
                return address;
            },
            free: ()=>undefined,
        },
        screen: WIRED_SCREEN,
        graphics: {
            createDrawing: options=>createGdiDrawing(options),
            surfaceFor(dc, bitmap){
                if (dc.kind !== 'memory')
                {
                    return screen;
                }
                return bitmap.pixels
                    ? surfaceForDdb(bitmap)
                    : surfaceForDibSection(bitmap, bytes, MEMORY_BASE);
            },
        },
    });
    // The handlers declare only the arguments they read; a guest call always
    // carries the whole list.
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (gdi.table));
    const view = new DataView(bytes.buffer);
    return { bytes, view, fns, screen };
}

test('a pattern brush paints the bitmap it was made from, even once that bitmap is gone', ()=>{
    // Wine's test_pattern_brush: the brush keeps the bitmap's pixels as they
    // were when it was made, and outlives the bitmap itself.
    const { fns } = wiredGdi();
    const screen = fns.GetDC.handler([0]);
    const dc = fns.CreateCompatibleDC.handler([screen]);
    const bitmap = fns.CreateCompatibleBitmap.handler([screen, 16, 16]);
    const other = fns.CreateCompatibleBitmap.handler([screen, 16, 16]);
    fns.SelectObject.handler([dc, bitmap]);
    fns.SelectObject.handler([dc, fns.CreateSolidBrush.handler([0xff5511])]);
    assert.equal(fns.PatBlt.handler([dc, 0, 0, 16, 16, PATCOPY]), 1);
    assert.equal(fns.GetPixel.handler([dc, 10, 10]), 0xff5511);

    const brush = fns.CreatePatternBrush.handler([bitmap]);
    assert.notEqual(brush, 0);
    fns.SelectObject.handler([dc, other]);
    assert.equal(fns.DeleteObject.handler([bitmap]), 1);

    fns.SelectObject.handler([dc, fns.CreateSolidBrush.handler([0xabcdef])]);
    fns.PatBlt.handler([dc, 0, 0, 16, 16, PATCOPY]);
    assert.equal(fns.GetPixel.handler([dc, 10, 10]), 0xabcdef);

    fns.SelectObject.handler([dc, brush]);
    assert.equal(fns.PatBlt.handler([dc, 0, 0, 16, 16, PATCOPY]), 1);
    assert.equal(fns.GetPixel.handler([dc, 10, 10]), 0xff5511,
        'the deleted bitmap\'s content, not black and not the brush colour');
});

test('a monochrome pattern brush takes the context\'s colours, and keeps its bits in a mask', ()=>{
    // The documented rule: a 0 bit is drawn in the text colour and a 1 bit in
    // the background colour. Into a monochrome bitmap the bits go as they
    // are, whatever the colours (Wine's test_bitmap_colors).
    const { fns, view } = wiredGdi();
    const PATTERN = 0x100;
    for (let row = 0; row < 8; row++)
    {
        view.setUint16(PATTERN + row * 2, 0x5555, true);
    }
    const bitmap = fns.CreateBitmap.handler([16, 8, 1, 1, PATTERN]);
    const brush = fns.CreatePatternBrush.handler([bitmap]);

    const screen = fns.GetDC.handler([0]);
    const colour = fns.CreateCompatibleDC.handler([screen]);
    fns.SelectObject.handler([colour, fns.CreateCompatibleBitmap.handler([screen, 4, 1])]);
    fns.SelectObject.handler([colour, brush]);
    fns.SetTextColor.handler([colour, 0x0000ff]);
    fns.SetBkColor.handler([colour, 0xff0000]);
    fns.PatBlt.handler([colour, 0, 0, 4, 1, PATCOPY]);
    assert.deepEqual([0, 1, 2, 3].map(x=>fns.GetPixel.handler([colour, x, 0])),
        [0x0000ff, 0xff0000, 0x0000ff, 0xff0000]);

    const mono = fns.CreateCompatibleDC.handler([0]);
    const mask = fns.CreateBitmap.handler([16, 1, 1, 1, 0]);
    fns.SelectObject.handler([mono, mask]);
    fns.SelectObject.handler([mono, brush]);
    fns.SetTextColor.handler([mono, 0x123456]);
    fns.SetBkColor.handler([mono, 0x654321]);
    fns.PatBlt.handler([mono, 0, 0, 16, 1, PATCOPY]);
    fns.SelectObject.handler([mono, fns.CreateBitmap.handler([1, 1, 1, 1, 0])]);
    assert.equal(fns.GetBitmapBits.handler([mask, 2, 0x200]), 2);
    assert.equal(view.getUint16(0x200, true), 0x5555);
});

/** Where the wired tests below put a BITMAPINFO and the bits it describes. */
const WIRED_INFO = 0x300;
const WIRED_BITS = 0x400;

/**
 * A BITMAPINFOHEADER and what follows it: a colour table of RGBQUADs, or a
 * BI_BITFIELDS DIB's three masks.
 *
 * @param {DataView} view
 * @param {{ width: number, height: number, bitCount: number, compression?: number,
 *           table?: number[] }} fields
 */
function putInfo(view, { width, height, bitCount, compression = 0, table = [] }){
    view.setUint32(WIRED_INFO + BITMAPINFOHEADER.biSize, BITMAPINFOHEADER.SIZE, true);
    view.setInt32(WIRED_INFO + BITMAPINFOHEADER.biWidth, width, true);
    view.setInt32(WIRED_INFO + BITMAPINFOHEADER.biHeight, height, true);
    view.setUint16(WIRED_INFO + BITMAPINFOHEADER.biPlanes, 1, true);
    view.setUint16(WIRED_INFO + BITMAPINFOHEADER.biBitCount, bitCount, true);
    view.setUint32(WIRED_INFO + BITMAPINFOHEADER.biCompression, compression, true);
    for (let at = BITMAPINFOHEADER.biSizeImage; at < BITMAPINFOHEADER.SIZE; at += 4)
    {
        view.setUint32(WIRED_INFO + at, 0, true);
    }
    table.forEach((entry, index)=>view.setUint32(WIRED_INFO + 40 + index * 4, entry, true));
}

test('a 5-6-5 DIB draws as 5-6-5, from StretchDIBits and in a section of its own', ()=>{
    const { fns, view, bytes } = wiredGdi();
    const BI_BITFIELDS = 3;
    const screen = fns.GetDC.handler([0]);
    const dc = fns.CreateCompatibleDC.handler([screen]);
    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([screen, 2, 1])]);

    putInfo(view, { width: 2, height: -1, bitCount: 16, compression: BI_BITFIELDS,
        table: [0xf800, 0x07e0, 0x001f] });
    view.setUint16(WIRED_BITS, 0x07e0, true);
    view.setUint16(WIRED_BITS + 2, 0xf800, true);
    assert.equal(fns.StretchDIBits.handler([dc, 0, 0, 2, 1, 0, 0, 2, 1,
        WIRED_BITS, WIRED_INFO, 0, 0x00cc0020]), 1);
    assert.deepEqual([fns.GetPixel.handler([dc, 0, 0]), fns.GetPixel.handler([dc, 1, 0])],
        [0x00ff00, 0x0000ff], 'full green and full red, as COLORREFs');

    const BITS_OUT = 0x500;
    const section = fns.CreateDIBSection.handler([dc, WIRED_INFO, 0, BITS_OUT, 0, 0]);
    assert.notEqual(section, 0);
    fns.SelectObject.handler([dc, section]);
    fns.SetPixel.handler([dc, 0, 0, 0x00ff00]);
    const at = view.getUint32(BITS_OUT, true);
    assert.deepEqual([...bytes.subarray(at, at + 2)], [0xe0, 0x07]);
});

test('GetDIBits into BI_BITFIELDS writes the masks it packs the pixels by', ()=>{
    // Wine's test_GetDIBits_BI_BITFIELDS: with bits, the masks come back
    // filled in, and biSizeImage with them.
    const { fns, view } = wiredGdi();
    const BI_BITFIELDS = 3;
    const screen = fns.GetDC.handler([0]);
    const dc = fns.CreateCompatibleDC.handler([screen]);
    const bitmap = fns.CreateCompatibleBitmap.handler([screen, 2, 1]);
    fns.SelectObject.handler([dc, bitmap]);
    fns.SetPixel.handler([dc, 0, 0, 0x0000ff]);
    fns.SetPixel.handler([dc, 1, 0, 0x00ff00]);

    putInfo(view, { width: 2, height: 1, bitCount: 16, compression: BI_BITFIELDS,
        table: [0, 0, 0] });
    view.setUint32(WIRED_INFO + BITMAPINFOHEADER.biSizeImage, 0xdeadbeef, true);
    assert.equal(fns.GetDIBits.handler([dc, bitmap, 0, 1, WIRED_BITS, WIRED_INFO, 0]), 1);
    assert.deepEqual([0, 4, 8].map(at=>view.getUint32(WIRED_INFO + 40 + at, true)),
        [0xf800, 0x07e0, 0x001f]);
    assert.equal(view.getUint32(WIRED_INFO + BITMAPINFOHEADER.biSizeImage, true), 4);
    assert.deepEqual([view.getUint16(WIRED_BITS, true), view.getUint16(WIRED_BITS + 2, true)],
        [0xf800, 0x07e0], 'red and green, packed by those masks');
});

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

test('a clip with a hole draws round the hole, every other pixel once', ()=>{
    const { objects, drawing, surface } = fixture();
    // A frame round 4..8 x 4..8, as ExcludeClipRect leaves it.
    drawing.setClipRegion(HDC, [
        { left: 0, top: 0, right: 16, bottom: 4 },
        { left: 0, top: 4, right: 4, bottom: 8 },
        { left: 8, top: 4, right: 16, bottom: 8 },
        { left: 0, top: 8, right: 16, bottom: 16 },
    ]);
    const red = objects.create('brush', { style: BS_SOLID, color: RED_COLOR, hatch: 0 });
    assert.equal(drawing.fillRect(HDC, { left: 0, top: 0, right: 16, bottom: 16 }, red), true);
    assert.equal(surface.read(5, 5), BACKGROUND, 'the hole is left as it was');
    assert.equal(surface.read(3, 5), RED_PIXEL);
    assert.equal(surface.read(8, 7), RED_PIXEL);
    assert.equal(surface.read(10, 12), RED_PIXEL);
    assert.equal(drawing.setPixel(HDC, 6, 6, RED_COLOR), CLR_INVALID, 'a pixel in the hole');
    assert.equal(drawing.setPixel(HDC, 9, 6, BLUE_COLOR), BLUE_COLOR);

    // An inversion twice over the same pixel would undo itself.
    drawing.invertRect(HDC, { left: 0, top: 0, right: 16, bottom: 16 });
    assert.equal(surface.read(3, 5), (RED_PIXEL ^ 0xffffffff) >>> 0, 'inverted once');
    assert.equal(surface.read(5, 5), BACKGROUND);

    drawing.setClipRect(HDC, { left: 0, top: 0, right: 16, bottom: 16 });
    drawing.fillRect(HDC, { left: 0, top: 0, right: 16, bottom: 16 }, red);
    assert.equal(surface.read(5, 5), RED_PIXEL, 'a rectangle clip has no hole');
});

test('a picture is drawn by its alpha, scaled, and round a hole in the clip', ()=>{
    const { drawing, surface } = fixture();
    // Two by two: opaque red, transparent, half blue, opaque white.
    const bgra = Uint8Array.of(0, 0, 255, 255, 9, 9, 9, 0, 255, 0, 0, 128, 255, 255, 255, 255);
    const picture = { width: 2, height: 2, bgra };
    assert.equal(drawing.drawPicture(HDC, 1, 1, picture), true);
    assert.equal(surface.read(1, 1), RED_PIXEL);
    assert.equal(surface.read(2, 1), BACKGROUND, 'no alpha leaves what was there');
    assert.equal(surface.read(1, 2), 0x00101090, 'half alpha is blended over it');
    assert.equal(surface.read(2, 2), 0x00ffffff);

    drawing.drawPicture(HDC, 8, 8, picture, 4, 4);
    assert.equal(surface.read(9, 9), RED_PIXEL, 'each pixel two by two');
    assert.equal(surface.read(10, 9), BACKGROUND);
    assert.equal(surface.read(11, 11), 0x00ffffff);

    clearSurface(surface, BACKGROUND);
    drawing.setClipRegion(HDC, [
        { left: 0, top: 0, right: 16, bottom: 2 },
        { left: 0, top: 2, right: 1, bottom: 16 },
        { left: 2, top: 2, right: 16, bottom: 16 },
    ]);
    drawing.drawPicture(HDC, 0, 0, { width: 1, height: 1, bgra: Uint8Array.of(0, 0, 255, 255) },
        4, 4);
    assert.equal(surface.read(1, 1), RED_PIXEL);
    assert.equal(surface.read(1, 3), BACKGROUND, 'the hole kept');
    assert.equal(surface.read(2, 3), RED_PIXEL);
});

test('a blit inside one surface under a region reads its source before writing over it', ()=>{
    const { drawing, surface } = fixture();
    for (let y = 0; y < 16; y++)
    {
        for (let x = 0; x < 16; x++)
        {
            surface.write(x, y, y);
        }
    }
    drawing.bind(SOURCE_HDC, surface);
    drawing.setClipRegion(HDC, [
        { left: 0, top: 0, right: 16, bottom: 6 },
        { left: 0, top: 6, right: 4, bottom: 8 },
        { left: 8, top: 6, right: 16, bottom: 8 },
        { left: 0, top: 8, right: 16, bottom: 16 },
    ]);
    // Everything moved down four rows: each row takes the one four above it.
    drawing.bitBlt(HDC, 0, 4, 16, 12, SOURCE_HDC, 0, 0, SRCCOPY);
    assert.equal(surface.read(0, 15), 11);
    assert.equal(surface.read(0, 9), 5);
    assert.equal(surface.read(0, 4), 0);
    assert.equal(surface.read(5, 7), 7, 'the hole kept its row');
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

test('a halftone InvertRect inverts every other pixel from the brush origin, and again'
    + ' restores them', ()=>{
    const { drawing, surface } = fixture();
    const inverted = (~BACKGROUND) >>> 0;
    const rows = ()=>[0, 1].map(y=>[0, 1, 2, 3].map(x=>surface.read(x, y)));
    assert.equal(drawing.invertRect(HDC, { left: 0, top: 0, right: 4, bottom: 2 }, true), true);
    assert.deepEqual(rows(), [[BACKGROUND, inverted, BACKGROUND, inverted],
        [inverted, BACKGROUND, inverted, BACKGROUND]], 'the gray brush\'s 0x55 over 0xAA');
    drawing.invertRect(HDC, { left: 0, top: 0, right: 4, bottom: 2 }, true);
    assert.deepEqual(rows(), [[BACKGROUND, BACKGROUND, BACKGROUND, BACKGROUND],
        [BACKGROUND, BACKGROUND, BACKGROUND, BACKGROUND]]);

    drawing.setBrushOrgEx(HDC, 1, 0);
    drawing.invertRect(HDC, { left: 0, top: 0, right: 4, bottom: 1 }, true);
    assert.deepEqual(rows()[0], [inverted, BACKGROUND, inverted, BACKGROUND],
        'the checkerboard moves with the origin');
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
    /** @type {number[]} what was set as the last error, in order */
    const errors = [];
    const gdi = createGdiFunctions({
        setLastError: code=>errors.push(code),
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
    return { bytes, view, fns, screen, errors };
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

/**
 * Where the wired tests below put a BITMAPINFO -- room for a full table of
 * 256 behind it -- the bits it describes, and a pointer handed back.
 */
const WIRED_INFO = 0x300;
const WIRED_BITS = 0x800;
const WIRED_POINTER = 0x2f0;

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

test('StretchDIBits answers and draws as Windows does for a top-down DIB', ()=>{
    // Wine's test_StretchDIBits, the top-down and bottom-up destination cases:
    // a copy at its own size reads the source from the top, and answers the
    // lines down to the rectangle's bottom; a stretch reads ySrc from the
    // bottom and answers the height; a source rectangle that starts before
    // the DIB draws nothing and answers zero. The pixels are compared without
    // their top byte.
    const { fns, view } = wiredGdi();
    const source = [0xcafed00d, 0xfeedface, 0xfedcba98, 0x76543210];
    const dc = fns.CreateCompatibleDC.handler([0]);
    /** @param {number} height @returns {number} the section's first pixel's address */
    const destination = height=>{
        putInfo(view, { width: 2, height, bitCount: 32 });
        fns.SelectObject.handler([dc, fns.CreateDIBSection.handler([dc, WIRED_INFO, 0,
            WIRED_POINTER, 0, 0])]);
        return view.getUint32(WIRED_POINTER, true);
    };
    /** @param {number} at @param {number[]} args */
    const stretch = (at, args)=>{
        for (let index = 0; index < 4; index++)
        {
            view.setUint32(at + index * 4, 0, true);
        }
        putInfo(view, { width: 2, height: -2, bitCount: 32 });
        source.forEach((pixel, index)=>view.setUint32(WIRED_BITS + index * 4, pixel, true));
        const answer = fns.StretchDIBits.handler([dc, ...args, WIRED_BITS, WIRED_INFO, 0,
            0x00cc0020]);
        return { answer, pixels: [0, 1, 2, 3].map(index=>view.getUint32(at + index * 4, true)
            & 0xffffff) };
    };
    const [a, b, c, d] = source.map(pixel=>pixel & 0xffffff);
    /** @type {[number[], number[], number][]} */
    const cases = [
        [[0, 0, 2, 2, 0, 0, 2, 2], [a, b, c, d], 2],
        [[0, 0, 1, 1, 0, 0, 1, 1], [a, 0, 0, 0], 1],
        [[0, 0, 2, 2, 0, 0, 1, 1], [c, c, c, c], 2],
        [[0, 0, 1, 1, 0, 0, 2, 2], [0x441000, 0, 0, 0], 2],
        [[0, 0, 2, 2, 1, 1, -2, -2], [0, 0, 0, 0], 0],
        [[1, 1, -2, -2, 1, 1, -2, -2], [0, 0, 0, 0], 0],
        [[1, 1, 2, 2, 0, 0, 2, 2], [0, 0, 0, a], 2],
        [[2, 2, 4, 4, 0, 0, 2, 2], [0, 0, 0, 0], 2],
        [[-4, -4, 4, 4, 0, 0, 4, 4], [0, 0, 0, 0], 2],
    ];
    const topDown = destination(-2);
    for (const [args, pixels, answer] of cases)
    {
        assert.deepEqual(stretch(topDown, args), { answer, pixels }, `${args}`);
    }
    // Windows puts 0xFEEDFACE at the second row's first pixel here, which no
    // mirroring of the source rectangle gives; the rule is not known, and only
    // the answer is held to.
    assert.equal(stretch(topDown, [1, 1, -2, -2, 1, 1, 2, 2]).answer, 2);
    assert.deepEqual(stretch(destination(2), [0, 0, 2, 2, 0, 0, 2, 2]).pixels, [c, d, a, b],
        'into a bottom-up section');
});

test('StretchDIBits answers the DIB\'s height, negative for a top-down one under another '
    + 'operation than SRCCOPY', ()=>{
    // Wine's dib tests, a 4x4 32-bit DIB either way up, at its size, cropped
    // and mirrored, under SRCCOPY and SRCAND.
    const { fns, view } = wiredGdi();
    const dc = fns.CreateCompatibleDC.handler([0]);
    putInfo(view, { width: 128, height: 128, bitCount: 32 });
    fns.SelectObject.handler([dc, fns.CreateDIBSection.handler([dc, WIRED_INFO, 0,
        WIRED_POINTER, 0, 0])]);
    const SRCAND = 0x008800c6;
    for (const height of [4, -4])
    {
        putInfo(view, { width: 4, height, bitCount: 32 });
        /** @type {[number[], number][]} */
        const cases = [[[10, 10, 4, 4, 0, 0, 4, 4], SRCCOPY],
            [[20, 10, 4, 4, 0, 0, 4, 4], SRCAND], [[30, 10, 3, 3, 1, 1, 3, 3], SRCCOPY],
            [[40, 10, 3, 3, 1, 1, 3, 3], SRCAND], [[50, 10, -2, -2, 2, 3, -2, -2], SRCCOPY],
            [[60, 10, -2, -2, 2, 3, -2, -2], SRCAND]];
        for (const [args, rop] of cases)
        {
            assert.equal(fns.StretchDIBits.handler([dc, ...args, WIRED_BITS, WIRED_INFO, 0,
                rop]), rop === SRCCOPY ? 4 : height, `${height}: ${args}, ${rop.toString(16)}`);
        }
    }
});

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

    const BITS_OUT = WIRED_POINTER;
    const section = fns.CreateDIBSection.handler([dc, WIRED_INFO, 0, BITS_OUT, 0, 0]);
    assert.notEqual(section, 0);
    fns.SelectObject.handler([dc, section]);
    fns.SetPixel.handler([dc, 0, 0, 0x00ff00]);
    const at = view.getUint32(BITS_OUT, true);
    assert.deepEqual([...bytes.subarray(at, at + 2)], [0xe0, 0x07]);
});

test('a BI_BITFIELDS section of any masks is drawn and read by them', ()=>{
    // Wine's test_simple_graphics draws into 32-bit sections whose masks put
    // blue high (a8b8g8r8), are ten bits wide (r10g10b10) and six bits wide
    // (r6g6b6), and into a 16-bit r4g4b4 one. Each channel goes into its mask
    // as its top bits, and comes back widened to eight by repeating them.
    const { fns, view } = wiredGdi();
    const BI_BITFIELDS = 3;
    const dc = fns.CreateCompatibleDC.handler([0]);
    const colour = 0x563412;
    const cases = [
        { bitCount: 32, masks: [0x0000ff, 0x00ff00, 0xff0000], stored: 0x00563412,
            back: colour, raw: 0x00ff0080, rawColour: 0xff0080 },
        { bitCount: 32, masks: [0x3ff00000, 0x000ffc00, 0x000003ff],
            stored: (0x12 << 22) | (0x34 << 12) | (0x56 << 2), back: colour,
            raw: 0x3ff003ff, rawColour: 0xff00ff },
        { bitCount: 32, masks: [0x0003f000, 0x00000fc0, 0x0000003f],
            stored: (0x04 << 12) | (0x0d << 6) | 0x15, back: 0x553410,
            raw: 0x0003f03f, rawColour: 0xff00ff },
        { bitCount: 16, masks: [0x0f00, 0x00f0, 0x000f], stored: 0x0135, back: 0x553311,
            raw: 0x0f0f, rawColour: 0xff00ff },
    ];
    for (const { bitCount, masks, stored, back, raw, rawColour } of cases)
    {
        const name = masks.map(mask=>mask.toString(16)).join('/');
        putInfo(view, { width: 4, height: -1, bitCount, compression: BI_BITFIELDS, table: masks });
        const section = fns.CreateDIBSection.handler([dc, WIRED_INFO, 0, WIRED_POINTER, 0, 0]);
        assert.notEqual(section, 0, name);
        const at = view.getUint32(WIRED_POINTER, true);
        /** @param {number} x */
        const pixel = x=>(bitCount === 32 ? view.getUint32(at + x * 4, true)
            : view.getUint16(at + x * 2, true));
        const previous = fns.SelectObject.handler([dc, section]);
        assert.equal(fns.SetPixel.handler([dc, 0, 0, colour]), back, `${name} SetPixel`);
        assert.equal(pixel(0) >>> 0, stored >>> 0, `${name} stored`);
        assert.equal(fns.GetPixel.handler([dc, 0, 0]), back, `${name} GetPixel`);
        if (bitCount === 32)
        {
            view.setUint32(at + 4, raw, true);
        }
        else
        {
            view.setUint16(at + 2, raw, true);
        }
        assert.equal(fns.GetPixel.handler([dc, 1, 0]), rawColour, `${name} read`);

        // A fill and a blit out to plain 32 bits go through the masks too.
        const brush = fns.CreateSolidBrush.handler([colour]);
        fns.SelectObject.handler([dc, brush]);
        fns.PatBlt.handler([dc, 2, 0, 1, 1, PATCOPY]);
        assert.equal(pixel(2) >>> 0, stored >>> 0, `${name} filled`);
        putInfo(view, { width: 4, height: -1, bitCount: 32 });
        const plain = fns.CreateDIBSection.handler([dc, WIRED_INFO, 0, WIRED_POINTER, 0, 0]);
        const plainAt = view.getUint32(WIRED_POINTER, true);
        const other = fns.CreateCompatibleDC.handler([0]);
        fns.SelectObject.handler([other, plain]);
        assert.equal(fns.BitBlt.handler([other, 0, 0, 4, 1, dc, 0, 0, 0x00cc0020]), 1);
        assert.deepEqual([0, 1].map(x=>view.getUint32(plainAt + x * 4, true)),
            [back, rawColour].map(value=>((value & 0xff) << 16 | value & 0xff00
                | value >>> 16) >>> 0), `${name} blitted`);
        fns.DeleteDC.handler([other]);
        fns.SelectObject.handler([dc, previous]);
    }
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

/** @param {DataView} view @param {number} count @returns {number[]} the table after the header */
const tableOf = (view, count)=>[...Array(count).keys()]
    .map(index=>view.getUint32(WIRED_INFO + 40 + index * 4, true));

test('GetDIBits reads a monochrome bitmap out as one bit, black and white, bottom-up', ()=>{
    // Wine's test_GetDIBits: a 16x16 bitmap of alternate rows, read back as a
    // one-bit DIB; the table is two entries and nothing past them is touched.
    const { fns, view, bytes } = wiredGdi();
    const screen = fns.GetDC.handler([0]);
    const ROWS = 0x600;
    for (let y = 0; y < 16; y++)
    {
        view.setUint16(ROWS + y * 2, y % 2 === 0 ? 0xffff : 0, true);
    }
    const mono = fns.CreateBitmap.handler([16, 16, 1, 1, ROWS]);
    putInfo(view, { width: 16, height: 16, bitCount: 1, table: new Array(4).fill(0xaaaaaaaa) });
    view.setUint32(WIRED_INFO + BITMAPINFOHEADER.biClrUsed, 37, true);

    assert.equal(fns.GetDIBits.handler([screen, mono, 0, 16, WIRED_BITS, WIRED_INFO, 0]), 16);
    assert.deepEqual(tableOf(view, 4), [0, 0x00ffffff, 0xaaaaaaaa, 0xaaaaaaaa]);
    assert.equal(view.getUint32(WIRED_INFO + BITMAPINFOHEADER.biClrUsed, true), 0);
    assert.equal(view.getUint32(WIRED_INFO + BITMAPINFOHEADER.biSizeImage, true), 64);
    assert.deepEqual([...bytes.subarray(WIRED_BITS, WIRED_BITS + 8)],
        [0, 0, 0, 0, 0xff, 0xff, 0, 0], 'the last row first, each padded to a DWORD');

    view.setUint32(WIRED_INFO + 40, 0xaaaaaaaa, true);
    view.setUint32(WIRED_INFO + 44, 0xaaaaaaaa, true);
    fns.GetDIBits.handler([screen, mono, 0, 0, 0, WIRED_INFO, 1]);
    assert.deepEqual(tableOf(view, 2), [0x00010000, 0xaaaaaaaa],
        'DIB_PAL_COLORS: the table is the indices 0 and 1, as WORDs');
});

test('GetDIBits reads colour out as four and eight bits against the default palette', ()=>{
    // Wine's test_GetDIBits: at four bits the sixteen VGA colours, at eight the
    // default palette's twenty around a 3-3-2 cube, and each pixel the index
    // of its colour there.
    const { fns, view, bytes } = wiredGdi();
    const screen = fns.GetDC.handler([0]);
    const dc = fns.CreateCompatibleDC.handler([screen]);
    const bitmap = fns.CreateCompatibleBitmap.handler([screen, 2, 1]);
    fns.SelectObject.handler([dc, bitmap]);
    fns.SetPixel.handler([dc, 0, 0, 0x0000ff]);
    fns.SetPixel.handler([dc, 1, 0, 0x804020]);
    fns.SelectObject.handler([dc, fns.CreateBitmap.handler([1, 1, 1, 1, 0])]);

    putInfo(view, { width: 2, height: 1, bitCount: 4 });
    assert.equal(fns.GetDIBits.handler([screen, bitmap, 0, 1, WIRED_BITS, WIRED_INFO, 0]), 1);
    assert.deepEqual(tableOf(view, 16), [
        0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0x808080,
        0xc0c0c0, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
    ]);
    assert.equal(bytes[WIRED_BITS] >>> 4, 9, 'red is the ninth');

    putInfo(view, { width: 2, height: 1, bitCount: 8 });
    assert.equal(fns.GetDIBits.handler([screen, bitmap, 0, 1, WIRED_BITS, WIRED_INFO, 0]), 1);
    const table = tableOf(view, 256);
    assert.deepEqual(table.slice(0, 10), [0x000000, 0x800000, 0x008000, 0x808000, 0x000080,
        0x800080, 0x008080, 0xc0c0c0, 0xc0dcc0, 0xa6caf0]);
    assert.deepEqual(table.slice(246), [0xfffbf0, 0xa0a0a4, 0x808080, 0xff0000, 0x00ff00,
        0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff]);
    assert.equal(table[145], 0x204080,
        'red (145 & 7) << 5, green (145 & 0x38) << 2, blue 145 & 0xc0');
    assert.deepEqual([bytes[WIRED_BITS], bytes[WIRED_BITS + 1]], [249, 145]);
});

test('GetDIBits hands an indexed section back in its own table and its own indices', ()=>{
    // Wine's test_GetDIBits_selected_DIB, at eight and four bits.
    for (const bitCount of [8, 4])
    {
        const { fns, view, bytes } = wiredGdi();
        const ramp = [...Array(1 << bitCount).keys()].map(index=>{
            const grey = index * (1 << (8 - bitCount));
            return (grey << 16) | (grey << 8) | grey;
        });
        putInfo(view, { width: 32, height: 32, bitCount, table: ramp });
        const OUT = WIRED_POINTER;
        const section = fns.CreateDIBSection.handler([0, WIRED_INFO, 0, OUT, 0, 0]);
        const bits = view.getUint32(OUT, true);
        const size = (bitCount * 32 * 32) / 8;
        for (let index = 0; index < size; index++)
        {
            bytes[bits + index] = index % 256;
        }
        const dc = fns.CreateCompatibleDC.handler([0]);
        putInfo(view, { width: 32, height: 32, bitCount, table: ramp.map(()=>0xcccccccc) });
        assert.equal(fns.GetDIBits.handler([dc, section, 0, 32, WIRED_BITS, WIRED_INFO, 0]), 32);
        assert.deepEqual(tableOf(view, 1 << bitCount), ramp);
        assert.deepEqual([...bytes.subarray(WIRED_BITS, WIRED_BITS + size)],
            [...bytes.subarray(bits, bits + size)], `${bitCount} bits`);
    }
});

test('StretchDIBits draws one- and four-bit DIBs through their colour tables', ()=>{
    const { fns, view } = wiredGdi();
    const screen = fns.GetDC.handler([0]);
    const dc = fns.CreateCompatibleDC.handler([screen]);
    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([screen, 3, 1])]);
    /** @returns {number[]} */
    const row = ()=>[0, 1, 2].map(x=>fns.GetPixel.handler([dc, x, 0]));

    putInfo(view, { width: 3, height: -1, bitCount: 1, table: [0x00ff0000, 0x000000ff] });
    view.setUint8(WIRED_BITS, 0b10100000);
    assert.equal(fns.StretchDIBits.handler([dc, 0, 0, 3, 1, 0, 0, 3, 1,
        WIRED_BITS, WIRED_INFO, 0, 0x00cc0020]), 1);
    assert.deepEqual(row(), [0xff0000, 0x0000ff, 0xff0000], 'blue, red, blue as COLORREFs');

    putInfo(view, { width: 3, height: -1, bitCount: 4,
        table: [0, 0x00ff0000, 0x0000ff00, 0x000000ff] });
    view.setUint16(WIRED_BITS, 0x1023, false);
    assert.equal(fns.StretchDIBits.handler([dc, 0, 0, 3, 1, 0, 0, 3, 1,
        WIRED_BITS, WIRED_INFO, 0, 0x00cc0020]), 1);
    assert.deepEqual(row(), [0x0000ff, 0x000000, 0x00ff00]);
});

test('CreateDIBitmap with CBM_INIT converts the bits it is given into the DC\'s format', ()=>{
    // Wine's test_createdibitmap: a one-bit header for the bitmap, a 24-bit
    // BITMAPINFO for the bits, and the white pixel reads back white at 32.
    const { fns, view } = wiredGdi();
    const CBM_INIT = 4;
    const HEADER = 0x1000;
    /** @param {number} width @param {number} bitCount */
    const putHeader = (width, bitCount)=>{
        view.setUint32(HEADER, 40, true);
        view.setInt32(HEADER + 4, width, true);
        view.setInt32(HEADER + 8, 1, true);
        view.setUint16(HEADER + 12, 1, true);
        view.setUint16(HEADER + 14, bitCount, true);
    };
    /** @param {number} bitmap @param {number} width @returns {number[]} */
    const pixelsOf = (bitmap, width)=>{
        putInfo(view, { width, height: 1, bitCount: 32 });
        assert.equal(fns.GetDIBits.handler([screen, bitmap, 0, 1, WIRED_BITS, WIRED_INFO, 0]), 1);
        return [...Array(width).keys()].map(x=>view.getUint32(WIRED_BITS + x * 4, true));
    };
    const screen = fns.GetDC.handler([0]);

    putHeader(1, 1);
    putInfo(view, { width: 1, height: 1, bitCount: 24 });
    view.setUint32(WIRED_BITS, 0xffffffff, true);
    const white = fns.CreateDIBitmap.handler([screen, HEADER, CBM_INIT, WIRED_BITS, WIRED_INFO, 0]);
    assert.ok(white > 0);
    assert.deepEqual(pixelsOf(white, 1), [0x00ffffff]);

    // DIB_PAL_COLORS: the table is indices into the palette the DC has.
    const LOGPALETTE = 0x1100;
    view.setUint16(LOGPALETTE, 0x300, true);
    view.setUint16(LOGPALETTE + 2, 2, true);
    view.setUint32(LOGPALETTE + 4, 0x00332211, true);
    view.setUint32(LOGPALETTE + 8, 0x00ccbbaa, true);
    const dc = fns.CreateCompatibleDC.handler([screen]);
    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([screen, 1, 1])]);
    fns.SelectPalette.handler([dc, fns.CreatePalette.handler([LOGPALETTE]), 0]);
    putHeader(2, 8);
    putInfo(view, { width: 2, height: 1, bitCount: 8, table: [0x00000001] });
    view.setUint32(WIRED_INFO + BITMAPINFOHEADER.biClrUsed, 2, true);
    view.setUint16(WIRED_BITS, 0x0100, true);
    const indexed = fns.CreateDIBitmap.handler([dc, HEADER, CBM_INIT, WIRED_BITS, WIRED_INFO, 1]);
    assert.ok(indexed > 0);
    assert.deepEqual(pixelsOf(indexed, 2), [0x00aabbcc, 0x00112233]);
});

test('StretchDIBits reads a DIB_PAL_COLORS table through the palette the DC has', ()=>{
    // Wine's test_SetDIBits and test_SetDIBitsToDevice: each WORD is an index
    // into the selected palette, wrapping at its end, and an index past
    // biClrUsed is black; test_dib_formats: DIB_PAL_COLORS + 1, whose pixels
    // index the palette directly, is drawn too, and nothing past it is.
    const { fns, view } = wiredGdi();
    const screen = fns.GetDC.handler([0]);
    const dc = fns.CreateCompatibleDC.handler([screen]);
    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([screen, 4, 1])]);
    /** @param {number} usage */
    const stretch = usage=>fns.StretchDIBits.handler([dc, 0, 0, 4, 1, 0, 0, 4, 1,
        WIRED_BITS, WIRED_INFO, usage, 0x00cc0020]);
    /** @returns {number[]} */
    const row = ()=>[0, 1, 2, 3].map(x=>fns.GetPixel.handler([dc, x, 0]));

    putInfo(view, { width: 4, height: 1, bitCount: 8, table: [0x00000002, 0x00000004] });
    view.setUint32(WIRED_INFO + BITMAPINFOHEADER.biClrUsed, 3, true);
    view.setUint32(WIRED_BITS, 0x03020100, true);
    assert.equal(stretch(1), 1);
    assert.deepEqual(row(), [0x008000, 0x000000, 0x800000, 0x000000],
        'the default palette\'s entries 2, 0 and 4, then black past biClrUsed');

    const LOGPALETTE = 0x1100;
    view.setUint16(LOGPALETTE, 0x300, true);
    view.setUint16(LOGPALETTE + 2, 3, true);
    view.setUint32(LOGPALETTE + 4, 0x00332211, true);
    view.setUint32(LOGPALETTE + 8, 0x00665544, true);
    view.setUint32(LOGPALETTE + 12, 0x00998877, true);
    fns.SelectPalette.handler([dc, fns.CreatePalette.handler([LOGPALETTE]), 0]);
    assert.equal(stretch(1), 1);
    assert.deepEqual(row(), [0x998877, 0x332211, 0x665544, 0x000000], 'index 4 wraps to 1');

    assert.equal(stretch(2), 1);
    assert.deepEqual(row(), [0x332211, 0x665544, 0x998877, 0x332211],
        'DIB_PAL_INDICES: the pixel is the palette index, wrapping too');
    assert.equal(stretch(3), 0);
});

// --- scan lines, as Wine's bitmap tests place them ---

/** Where 128 DWORDs of source data, counting up from zero, sit. */
const SCAN_DATA = 0x2000;

/**
 * Wine's fixture for the scan-line tests: an 8x8 32-bit DIB section
 * selected into a memory DC, bottom-up or top-down, and 128 DWORDs of data
 * counting from zero. Its `inverted` is the tests' inverted_data: the same
 * sixteen rows of eight in the other order.
 *
 * @param {boolean} topDown
 */
function scanFixture(topDown){
    const wired = wiredGdi();
    const { fns, view } = wired;
    putInfo(view, { width: 8, height: topDown ? -8 : 8, bitCount: 32 });
    const section = fns.CreateDIBSection.handler([0, WIRED_INFO, 0, WIRED_POINTER, 0, 0]);
    const bits = view.getUint32(WIRED_POINTER, true);
    const dc = fns.CreateCompatibleDC.handler([0]);
    fns.SelectObject.handler([dc, section]);
    for (let index = 0; index < 128; index++)
    {
        view.setUint32(SCAN_DATA + index * 4, index, true);
    }
    return {
        ...wired,
        section,
        dc,
        /** @param {number} height */
        header: height=>putInfo(view, { width: 8, height, bitCount: 32 }),
        fill: ()=>{
            for (let index = 0; index < 64; index++)
            {
                view.setUint32(bits + index * 4, 0xaaaaaaaa, true);
            }
        },
        /** @returns {number[]} the section's 64 DWORDs */
        pixels: ()=>[...Array(64).keys()].map(index=>view.getUint32(bits + index * 4, true)),
        /** The section's own DWORDs counting from zero, as GetDIBits' tests set them. */
        count: ()=>{
            for (let index = 0; index < 64; index++)
            {
                view.setUint32(bits + index * 4, index, true);
            }
        },
    };
}

/** @param {number} index @returns {number} inverted_data[index] */
const inverted = index=>120 - (index & ~7) + (index & 7);

/**
 * What the section should hold: `pick(i)` for each index a range covers, and
 * 0xaaaaaaaa -- untouched -- everywhere else.
 *
 * @param {[number, number, (i: number) => number][]} ranges
 * @returns {number[]}
 */
const expecting = ranges=>[...Array(64).keys()].map(index=>{
    const range = ranges.find(([from, to])=>index >= from && index < to);
    return range ? range[2](index) : 0xaaaaaaaa;
});

/** @param {number} shift @returns {(i: number) => number} data[i + shift] */
const data = shift=>index=>index + shift;
/** @param {number} shift @returns {(i: number) => number} inverted_data[i + shift] */
const flipped = shift=>index=>inverted(index + shift);
/** @param {number[]} indices @param {(i: number) => number} pick */
const only = (indices, pick)=>indices.map(index=>/** @type {[number, number,
    (i: number) => number]} */ ([index, index + 1, pick]));

test('SetDIBitsToDevice draws only the scan lines it was given, from the picture\'s bottom', ()=>{
    // Wine's test_SetDIBitsToDevice, every case outside a mapping mode or an
    // RTL layout: the arguments are xDest, yDest, width, height, xSrc, ySrc,
    // uStartScan and cLines.
    /** @type {[boolean, number, number[], number, [number, number, any][]][]} */
    const cases = [
        [false, 8, [0, 0, 8, 8, 0, 0, 0, 8], 8, [[0, 64, data(0)]]],
        [false, 8, [0, 0, 8, 8, 0, 0, 1, 5], 5, [[8, 48, data(-8)]]],
        [false, 8, [0, 0, 8, 8, 0, 3, 1, 5], 5, [[0, 24, data(16)]]],
        [false, 16, [0, 0, 8, 8, 0, 0, 1, 12], 7, [[8, 64, data(-8)]]],
        [false, 16, [0, 2, 8, 8, 0, 6, 1, 12], 12, [[0, 40, data(56)]]],
        [false, 16, [0, -4, 8, 8, 0, 3, 1, 12], 10, [[32, 64, data(-16)]]],
        [false, 16, [0, 4, 8, 8, 0, -3, 1, 12], 4, [[0, 32, data(0)]]],
        [false, 16, [0, 2, 8, 5, 0, -2, 1, 12], 2, [[32, 48, data(-32)]]],
        [false, 5, [0, 0, 8, 8, 0, 0, 2, 2], 2, [[16, 32, data(-16)]]],
        [false, 5, [3, 3, 2, 2, 1, 2, 1, 5], 3, only([27, 28, 35, 36], data(-18))],
        [false, 5, [0, 0, 16, 16, 0, 0, 0, 5], 5, []],
        [false, 5, [0, 2, 8, 4, 0, -1, 3, 12], 0, []],
        [false, -8, [0, 0, 8, 8, 0, 0, 0, 8], 8, [[0, 64, flipped(64)]]],
        [false, -8, [0, 0, 8, 8, 0, 0, 1, 5], 5, [[8, 48, flipped(80)]]],
        [false, -8, [0, 0, 8, 8, 0, 4, 1, 5], 5, [[0, 16, flipped(112)]]],
        [false, -16, [0, 0, 8, 8, 0, 0, 1, 12], 12, [[8, 64, flipped(24)]]],
        [false, -16, [0, 4, 8, 8, 0, 7, 1, 12], 12, [[0, 16, flipped(112)]]],
        [false, -16, [0, 0, 8, 8, 0, 0, 4, 12], 12, [[32, 64, flipped(0)]]],
        [false, -16, [0, -3, 8, 8, 0, 2, 4, 12], 12, [[40, 64, flipped(-8)]]],
        [false, -16, [0, 3, 8, 8, 0, -2, 4, 12], 12, [[24, 40, flipped(8)]]],
        [false, -16, [0, 0, 8, 8, 0, 0, 5, 12], 12, [[40, 64, flipped(-8)]]],
        [false, -16, [0, 2, 8, 4, 0, -1, 3, 12], 12, []],
        [false, -16, [5, -7, 8, 16, -2, -4, 0, 12], 12, only([31, 39, 47, 55, 63], flipped(1))],
        [false, -5, [0, 0, 8, 8, 0, 0, 1, 2], 2, [[8, 24, flipped(104)]]],
        [false, -5, [5, 4, 2, 2, 6, 3, 1, 5], 5, only([21, 22, 29, 30], flipped(89))],
        [false, -5, [0, 0, 16, 16, 0, 0, 0, 5], 5, []],
        [true, -8, [0, 0, 8, 8, 0, 0, 0, 8], 8, [[0, 64, data(0)]]],
        [true, -8, [0, 0, 8, 8, 0, 0, 1, 5], 5, [[16, 56, data(-16)]]],
        [true, -8, [0, 3, 8, 3, 0, 2, 1, 5], 5, [[24, 48, data(-16)]]],
        [true, -16, [0, 0, 8, 8, 0, 0, 1, 12], 12, [[0, 56, data(40)]]],
        [true, -16, [5, -7, 8, 16, -1, -8, 0, 12], 12, only([6, 7], data(82))],
        [true, -5, [0, 0, 8, 8, 0, 0, 1, 2], 2, [[40, 56, data(-40)]]],
        [true, -5, [7, 2, 8, 8, 1, 0, 0, 5], 5, only([47, 55, 63], data(-46))],
        [true, -5, [0, 0, 16, 16, 0, 0, 0, 5], 5, []],
        [true, 8, [0, 0, 8, 8, 0, 0, 0, 8], 8, [[0, 64, flipped(64)]]],
        [true, 8, [0, 0, 8, 8, 0, 0, 1, 5], 5, [[16, 56, flipped(72)]]],
        [true, 16, [0, 0, 8, 8, 0, 0, 1, 12], 7, [[0, 56, flipped(72)]]],
        [true, 16, [4, 4, 8, 8, 0, -4, 1, 12], 3,
            [[36, 40, flipped(68)], [44, 48, flipped(68)], [52, 56, flipped(68)]]],
        [true, 16, [4, 4, 8, 8, -30, -30, 1, 12], 0, []],
        [true, 16, [5, -5, 8, 16, -2, -4, 4, 12], 8, only([7, 15, 23], flipped(97))],
        [true, 5, [0, 0, 8, 8, 0, 0, 1, 2], 2, [[40, 56, flipped(72)]]],
        [true, 5, [0, 0, 16, 16, 0, 0, 0, 5], 5, []],
    ];
    for (const [topDown, height, args, lines, ranges] of cases)
    {
        const scan = scanFixture(topDown);
        scan.header(height);
        scan.fill();
        const name = `${topDown ? 't-d' : 'b-u'} section, biHeight ${height}, ${args}`;
        assert.equal(scan.fns.SetDIBitsToDevice.handler([scan.dc, ...args,
            SCAN_DATA, WIRED_INFO, 0]), lines, name);
        assert.deepEqual(scan.pixels(), expecting(ranges), name);
    }
});

test('SetDIBitsToDevice places its destination through the mapping mode and the layout', ()=>{
    // Wine's test_SetDIBitsToDevice, the three cases in a mapping mode or an
    // RTL layout: the destination point is mapped to the device and the
    // rectangle keeps its size in device pixels; under RTL the point is the
    // rectangle's right edge, so the picture is placed, not mirrored.
    const scan = scanFixture(false);
    const { fns } = scan;
    scan.header(8);
    fns.SetMapMode.handler([scan.dc, 8]);
    fns.SetWindowExtEx.handler([scan.dc, 3, 3, 0]);
    scan.fill();
    assert.equal(fns.SetDIBitsToDevice.handler([scan.dc, 2, 2, 2, 2, 1, 2, 1, 5, SCAN_DATA,
        WIRED_INFO, 0]), 3);
    assert.deepEqual(scan.pixels(), expecting(only([41, 42, 49, 50], data(-32))), 'a third');

    fns.SetWindowExtEx.handler([scan.dc, -1, -1, 0]);
    scan.fill();
    // Windows answers 4 here, one short of the lines at or below the source
    // rectangle's top that it answers everywhere else; what makes the
    // difference under a mirrored mapping is not known, and 5 is answered.
    fns.SetDIBitsToDevice.handler([scan.dc, 2, 2, 4, 4, 1, 2, 1, 5, SCAN_DATA, WIRED_INFO, 0]);
    assert.deepEqual(scan.pixels(), expecting(only([48, 49, 56, 57], data(-37))), 'mirrored');
    fns.SetMapMode.handler([scan.dc, 1]);

    fns.SetLayout.handler([scan.dc, 1]);
    scan.fill();
    assert.equal(fns.SetDIBitsToDevice.handler([scan.dc, 1, 2, 3, 2, 1, 2, 1, 5, SCAN_DATA,
        WIRED_INFO, 0]), 3);
    assert.deepEqual(scan.pixels(), expecting(only([36, 37, 38, 44, 45, 46], data(-27))),
        'right to left');
});

test('SetDIBits takes DIB_PAL_INDICES into a monochrome bitmap, and only there', ()=>{
    // Wine's test_dib_formats: SetDIBits with DIB_PAL_COLORS + 1 fails into a
    // bitmap compatible with the screen and succeeds into one made with
    // CreateBitmap at one bit; + 2 fails into either. A monochrome bitmap's
    // palette is its two colours, so each pixel is the bit it names.
    const { fns, view, bytes } = wiredGdi();
    const screen = fns.GetDC.handler([0]);
    const mono = fns.CreateBitmap.handler([8, 2, 1, 1, 0]);
    const colour = fns.CreateCompatibleBitmap.handler([screen, 8, 2]);
    putInfo(view, { width: 8, height: 2, bitCount: 1, table: [0x00ff0000, 0x000000ff] });
    bytes.set([0b10110000, 0, 0, 0, 0b01000000, 0, 0, 0], WIRED_BITS);

    assert.equal(fns.SetDIBits.handler([screen, colour, 0, 2, WIRED_BITS, WIRED_INFO, 2]), 0);
    assert.equal(fns.SetDIBits.handler([screen, mono, 0, 2, WIRED_BITS, WIRED_INFO, 3]), 0);
    assert.equal(fns.SetDIBits.handler([screen, mono, 0, 2, WIRED_BITS, WIRED_INFO, 2]), 2);
    const OUT = 0x5000;
    assert.equal(fns.GetBitmapBits.handler([mono, 4, OUT]), 4);
    assert.deepEqual([...bytes.subarray(OUT, OUT + 4)], [0b01000000, 0, 0b10110000, 0],
        'the bits as they were, the top row first');
});

test('SetDIBits lays the scan lines it is given against the top of the bitmap', ()=>{
    // Wine's test_SetDIBits: uStartScan and cLines, and what lands where.
    /** @type {[boolean, number, number, number, [number, number, any][]][]} */
    const cases = [
        [false, 8, 0, 8, [[0, 64, data(0)]]],
        [false, 8, 1, 5, [[8, 48, data(-8)]]],
        [false, 16, 1, 12, [[0, 40, data(56)]]],
        [false, 5, 1, 2, [[32, 48, data(-32)]]],
        [false, -8, 0, 8, [[0, 64, flipped(64)]]],
        [false, -8, 1, 5, [[8, 48, flipped(80)]]],
        [false, -16, 1, 12, [[0, 40, flipped(88)]]],
        [false, -16, 4, 12, [[0, 64, flipped(64)]]],
        [false, -16, 5, 12, [[0, 64, flipped(56)]]],
        [false, -5, 1, 2, [[32, 48, flipped(80)]]],
        [true, -8, 0, 8, [[0, 64, data(0)]]],
        [true, -8, 1, 5, [[16, 56, data(-16)]]],
        [true, -16, 1, 12, [[24, 64, data(-24)]]],
        [true, -5, 1, 2, [[16, 32, data(-16)]]],
        [true, 8, 0, 8, [[0, 64, flipped(64)]]],
        [true, 8, 1, 5, [[16, 56, flipped(72)]]],
        [true, 16, 1, 12, [[24, 64, flipped(8)]]],
        [true, 5, 1, 2, [[16, 32, flipped(96)]]],
    ];
    for (const [topDown, height, start, lines, ranges] of cases)
    {
        const scan = scanFixture(topDown);
        scan.header(height);
        scan.fill();
        const screen = scan.fns.GetDC.handler([0]);
        const name = `${topDown ? 't-d' : 'b-u'} section, biHeight ${height}, ${start}+${lines}`;
        assert.equal(scan.fns.SetDIBits.handler([screen, scan.section, start, lines,
            SCAN_DATA, WIRED_INFO, 0]), lines, name);
        assert.deepEqual(scan.pixels(), expecting(ranges), name);
    }
});

// --- run-length encoded DIBs ---

const RLE_DATA = 0x3800;
const UNTOUCHED = 0xaaaaaaaa;
const BI_RLE8 = 1;
const BI_RLE4 = 2;

/**
 * An RLE DIB's header, a grey table -- entry i is i, i, i -- and its bytes.
 *
 * @param {DataView} view
 * @param {{ width?: number, height?: number, bitCount?: number, compression?: number,
 *           size?: number, planes?: number }} header
 * @param {number[]} [rle]
 */
const putRle = (view, header, rle = [])=>{
    const { width = 8, height = 8, bitCount = 8, compression = BI_RLE8, size, planes = 1 } =
        header;
    putInfo(view, { width, height, bitCount, compression,
        table: [...Array(1 << bitCount).keys()].map(index=>index * 0x010101) });
    view.setUint16(WIRED_INFO + BITMAPINFOHEADER.biPlanes, planes, true);
    view.setUint32(WIRED_INFO + BITMAPINFOHEADER.biSizeImage, size ?? rle.length, true);
    rle.forEach((value, index)=>view.setUint8(RLE_DATA + index, value));
};

/**
 * Rows of greys, bottom first as a bottom-up section stores them; a null is a
 * pixel left as it was.
 *
 * @param {(number | null)[][]} rows
 */
const greys = rows=>[...rows, ...Array(8 - rows.length).fill(Array(8).fill(null))].flat()
    .map(grey=>(grey === null ? UNTOUCHED : grey * 0x010101));

const _ = null;
// Wine's test_SetDIBits_RLE8: 2, 2, 2, f0 x4, <eol>; absolute 4, 5, 6, <pad>;
// delta (1, 2); 80 x5, the fifth past the edge; <eod>.
const RLE8 = [0x03, 0x02, 0x04, 0xf0, 0x00, 0x00, 0x00, 0x03, 0x04, 0x05, 0x06, 0x00,
    0x00, 0x02, 0x01, 0x02, 0x05, 0x80, 0x00, 0x01];
const RLE8_BOTTOM_UP = greys([[2, 2, 2, 0xf0, 0xf0, 0xf0, 0xf0, _], [4, 5, 6, _, _, _, _, _],
    [_, _, _, _, _, _, _, _], [_, _, _, _, 0x80, 0x80, 0x80, 0x80]]);
/** @param {number[]} storage @returns {number[]} the rows the other way up */
const upsideDown = storage=>[...Array(8).keys()].reverse()
    .flatMap(row=>storage.slice(row * 8, row * 8 + 8));
const RLE8_TOP_DOWN = upsideDown(RLE8_BOTTOM_UP);

test('SetDIBits decodes an RLE8 DIB into the lines it names, and nothing else', ()=>{
    // Wine's test_SetDIBits_RLE8, every case: a pixel the runs never reach
    // is left as it was; the start and line count are ignored unless the
    // count is zero; the DIB lies against the bitmap's top whatever its
    // height; the answer is its height; and a top-down RLE DIB is refused.
    for (const topDown of [false, true])
    {
        const scan = scanFixture(topDown);
        const { fns, view, errors } = scan;
        const screen = fns.GetDC.handler([0]);
        const expected = topDown ? RLE8_TOP_DOWN : RLE8_BOTTOM_UP;
        /** @param {number} start @param {number} lines */
        const set = (start, lines)=>{
            scan.fill();
            return fns.SetDIBits.handler([screen, scan.section, start, lines, RLE_DATA,
                WIRED_INFO, 0]);
        };
        /** @param {(index: number) => number} pick */
        const each = pick=>[...Array(64).keys()].map(pick);
        putRle(view, {}, RLE8);
        for (const [start, lines] of [[0, 8], [1, 8], [1, 1]])
        {
            assert.equal(set(start, lines), 8, `${topDown} ${start}, ${lines}`);
            assert.deepEqual(scan.pixels(), expected, `${topDown} ${start}, ${lines}`);
        }
        assert.equal(set(1, 0), 0);
        assert.deepEqual(scan.pixels(), Array(64).fill(UNTOUCHED), 'no lines, nothing');
        if (!topDown)
        {
            putRle(view, { width: 4 }, RLE8);
            assert.equal(set(0, 8), 8);
            assert.deepEqual(scan.pixels(), each(index=>((index & 4) ? UNTOUCHED
                : RLE8_BOTTOM_UP[index])), 'four wide: the left half');
        }
        putRle(view, { height: 4 }, RLE8);
        assert.equal(set(0, 8), 4);
        assert.deepEqual(scan.pixels(), topDown
            ? each(index=>(index < 32 ? RLE8_TOP_DOWN[index + 32] : UNTOUCHED))
            : each(index=>(index < 32 ? UNTOUCHED : RLE8_BOTTOM_UP[index - 32])),
        `${topDown} four high: the top half`);
        putRle(view, { height: 9 }, RLE8);
        assert.equal(set(0, 8), 9);
        assert.deepEqual(scan.pixels(), topDown
            ? each(index=>(index < 8 ? UNTOUCHED : RLE8_TOP_DOWN[index - 8]))
            : each(index=>(index < 56 ? RLE8_BOTTOM_UP[index + 8] : UNTOUCHED)),
        `${topDown} nine high: down a row`);
        putRle(view, { height: -8 }, RLE8);
        assert.equal(set(0, 8), 0);
        assert.deepEqual(errors, [87], 'top-down is ERROR_INVALID_PARAMETER');
    }
});

test('SetDIBits decodes an RLE4 DIB, runs alternating their two nibbles', ()=>{
    // Wine's test_SetDIBits_RLE4.
    const scan = scanFixture(false);
    const { fns, view } = scan;
    putRle(view, { bitCount: 4, compression: BI_RLE4 }, [0x03, 0x52, 0x07, 0x68, 0x00, 0x00,
        0x00, 0x03, 0x14, 0x50, 0x00, 0x05, 0x79, 0xfd, 0xb0, 0x00, 0x00, 0x00,
        0x00, 0x02, 0x01, 0x02, 0x05, 0x87, 0x00, 0x01]);
    scan.fill();
    assert.equal(fns.SetDIBits.handler([fns.GetDC.handler([0]), scan.section, 0, 8, RLE_DATA,
        WIRED_INFO, 0]), 8);
    assert.deepEqual(scan.pixels(), greys([[5, 2, 5, 6, 8, 6, 8, 6],
        [1, 4, 5, 7, 9, 0xf, 0xd, 0xb], [_, _, _, _, _, _, _, _], [_, _, _, _, _, _, _, _],
        [_, 8, 7, 8, 7, 8, _, _]]));
});

test('SetDIBitsToDevice draws an RLE8 DIB whole, its source rectangle as for any DIB', ()=>{
    // Wine's test_SetDIBitsToDevice_RLE8, every case: the start and line
    // count are ignored unless the count is zero, the answer is the DIB's
    // height, and the rectangles fall as they do for an uncompressed DIB
    // with every line supplied -- only the pixels the runs reach drawn.
    const rle = [0x04, 0x02, 0x03, 0xf0, 0x00, 0x00, 0x00, 0x03, 0x04, 0x05, 0x06, 0x00,
        0x00, 0x02, 0x01, 0x02, 0x05, 0x80, 0x00, 0x01];
    const bottomUp = greys([[2, 2, 2, 2, 0xf0, 0xf0, 0xf0, _], [4, 5, 6, _, _, _, _, _],
        [_, _, _, _, _, _, _, _], [_, _, _, _, 0x80, 0x80, 0x80, 0x80]]);
    const topDown = upsideDown(bottomUp);
    /** @param {(index: number) => number} pick */
    const each = pick=>[...Array(64).keys()].map(pick);
    const all = /** @param {number[]} table */ table=>each(index=>table[index]);

    const up = scanFixture(false);
    /**
     * @param {typeof up} scan
     * @param {number[]} args  xDest, yDest, cx, cy, xSrc, ySrc, start, lines
     */
    const draw = (scan, args)=>{
        scan.fill();
        return scan.fns.SetDIBitsToDevice.handler([scan.dc, ...args, RLE_DATA, WIRED_INFO, 0]);
    };
    putRle(up.view, {}, rle);
    /** @type {[number[], number, number[], string][]} */
    const cases = [
        [[0, 0, 8, 8, 0, 0, 0, 8], 8, all(bottomUp), 'whole'],
        [[0, 0, 8, 8, 0, 0, 1, 8], 8, all(bottomUp), 'start ignored'],
        [[0, 0, 8, 8, 0, 0, 1, 1], 8, all(bottomUp), 'lines ignored'],
        [[0, 0, 8, 8, 0, 0, 1, 0], 0, Array(64).fill(UNTOUCHED), 'no lines'],
    ];
    for (const [args, answer, expected, name] of cases)
    {
        assert.equal(draw(up, args), answer, name);
        assert.deepEqual(up.pixels(), expected, name);
    }

    putRle(up.view, { width: 2 }, rle);
    assert.equal(draw(up, [0, 0, 8, 8, 0, 0, 0, 8]), 8);
    assert.deepEqual(up.pixels(), each(index=>((index & 7) < 2 ? bottomUp[index] : UNTOUCHED)),
        'two wide');
    putRle(up.view, { height: 2 }, rle);
    assert.equal(draw(up, [0, 0, 8, 8, 0, 0, 0, 8]), 2);
    assert.deepEqual(up.pixels(), each(index=>(index < 16 ? bottomUp[index] : UNTOUCHED)),
        'two high');
    putRle(up.view, { height: 9 }, rle);
    for (const lines of [8, 9])
    {
        assert.equal(draw(up, [0, 0, 8, 8, 0, 0, 0, lines]), 9);
        assert.deepEqual(up.pixels(), all(bottomUp), `nine high, ${lines} lines`);
    }
    putRle(up.view, {}, rle);
    assert.equal(draw(up, [0, 0, 8, 8, 0, 0, 1, 9]), 8);
    assert.deepEqual(up.pixels(), all(bottomUp));
    assert.equal(draw(up, [0, 3, 8, 8, 0, 0, 0, 8]), 8);
    assert.deepEqual(up.pixels(), each(index=>(index < 40 ? bottomUp[index + 24] : UNTOUCHED)));
    assert.equal(draw(up, [0, 3, 4, 4, 0, 0, 0, 8]), 8);
    assert.deepEqual(up.pixels(), each(index=>(index >= 8 && index < 40 && !(index & 4)
        ? bottomUp[index - 8] : UNTOUCHED)));
    assert.equal(draw(up, [3, 3, 8, 4, 0, 0, 0, 8]), 8);
    assert.deepEqual(up.pixels(), each(index=>(index >= 8 && index < 40 && (index & 7) >= 3
        ? bottomUp[index - 11] : UNTOUCHED)));
    assert.equal(draw(up, [2, 3, 8, 4, 2, 0, 0, 8]), 8);
    assert.deepEqual(up.pixels(), each(index=>(index >= 8 && index < 40 && (index & 7) >= 2
        ? bottomUp[index - 8] : UNTOUCHED)));
    putRle(up.view, { width: 37, height: 37 }, rle);
    assert.equal(draw(up, [-2, 1, 10, 5, 2, -1, 12, 24]), 37);
    assert.deepEqual(up.pixels(), each(index=>{
        if (index < 24)
        {
            return UNTOUCHED;
        }
        if (index === 52)
        {
            return 0x808080;
        }
        return (index & 4) ? UNTOUCHED : bottomUp[index - 20];
    }), 'thirty-seven square');
    putRle(up.view, { height: -8 }, rle);
    assert.equal(draw(up, [0, 0, 8, 8, 0, 0, 0, 8]), 0);
    assert.deepEqual(up.errors, [87], 'top-down is ERROR_INVALID_PARAMETER');

    const down = scanFixture(true);
    putRle(down.view, {}, rle);
    for (const lines of [8, 9])
    {
        assert.equal(draw(down, [0, 0, 8, 8, 0, 0, 0, lines]), 8);
        assert.deepEqual(down.pixels(), all(topDown), `into top-down, ${lines} lines`);
    }
    putRle(down.view, { height: 4 }, rle);
    assert.equal(draw(down, [0, 0, 8, 8, 0, 0, 0, 8]), 4);
    assert.deepEqual(down.pixels(), all(topDown), 'four high');
    putRle(down.view, { height: 9 }, rle);
    for (const lines of [8, 9])
    {
        assert.equal(draw(down, [0, 0, 8, 8, 0, 0, 0, lines]), 9);
        assert.deepEqual(down.pixels(), all(topDown), `nine high, ${lines} lines`);
    }
    assert.equal(draw(down, [2, 3, 8, 6, 2, 2, 0, 8]), 9);
    assert.deepEqual(down.pixels(), each(index=>(index < 24 ? UNTOUCHED : topDown[index - 24])));
    putRle(down.view, { width: 37, height: 37 }, rle);
    assert.equal(draw(down, [-2, 1, 10, 5, 2, -1, 12, 24]), 37);
    assert.deepEqual(down.pixels(), each(index=>{
        if (index >= 40)
        {
            return UNTOUCHED;
        }
        if (index === 12)
        {
            return 0x808080;
        }
        return (index & 4) ? UNTOUCHED : topDown[index + 28];
    }), 'thirty-seven square, into top-down');
});

test('an RLE DIB needs its size, and is drawn but never read back', ()=>{
    // Wine's test_dib_formats: with biSizeImage zero an RLE8 or RLE4 DIB is
    // refused by SetDIBits, SetDIBitsToDevice and StretchDIBits; with a size
    // it is taken, even with no planes; GetDIBits describes one but will not
    // write one; and each compression goes with its own depth only.
    const scan = scanFixture(false);
    const { fns, view } = scan;
    const screen = fns.GetDC.handler([0]);
    const bitmap = fns.CreateCompatibleBitmap.handler([screen, 10, 10]);
    const OUT = 0x3000;
    view.setUint32(RLE_DATA, 0xaaaaaaaa, true);
    /** @returns {number[]} what each of the three calls answers */
    const answers = ()=>[
        fns.SetDIBits.handler([screen, bitmap, 0, 1, RLE_DATA, WIRED_INFO, 0]),
        fns.SetDIBitsToDevice.handler([scan.dc, 0, 0, 1, 1, 0, 0, 0, 1, RLE_DATA, WIRED_INFO, 0]),
        fns.StretchDIBits.handler([scan.dc, 0, 0, 1, 1, 0, 0, 1, 1, RLE_DATA, WIRED_INFO, 0,
            0x00cc0020]),
    ];
    for (const [bitCount, compression] of [[8, BI_RLE8], [4, BI_RLE4]])
    {
        const name = `RLE${bitCount}`;
        putRle(view, { width: 2, height: 2, bitCount, compression, size: 0 });
        assert.deepEqual(answers(), [0, 0, 0], `${name} without a size`);
        for (const planes of [1, 0])
        {
            putRle(view, { width: 2, height: 2, bitCount, compression, size: 1, planes });
            assert.ok(answers().every(answer=>answer !== 0), `${name} with a size, ${planes}`);
        }
        putRle(view, { width: 2, height: 2, bitCount, compression, size: 0 });
        assert.notEqual(fns.GetDIBits.handler([screen, bitmap, 0, 0, OUT, WIRED_INFO, 0]), 0);
        assert.notEqual(fns.GetDIBits.handler([screen, bitmap, 0, 2, 0, WIRED_INFO, 0]), 0);
        assert.equal(fns.GetDIBits.handler([screen, bitmap, 0, 2, OUT, WIRED_INFO, 0]), 0);
        assert.equal(view.getUint16(WIRED_INFO + BITMAPINFOHEADER.biBitCount, true), bitCount);
        putRle(view, { width: 2, height: 2, bitCount: 12 - bitCount, compression, size: 1 });
        assert.deepEqual(answers(), [0, 0, 0], `${name} at the other depth`);
    }
});

test('a DIB of no planes is refused by every call that draws or sets it, not described', ()=>{
    // Wine's test_dib_formats: "all functions check planes except GetDIBits
    // with 0 lines" -- SetDIBits, SetDIBitsToDevice and StretchDIBits refuse
    // an uncompressed DIB whose biPlanes is 0 and take one of 1 or 2, and
    // GetDIBits describes it with no lines but will not fill lines of it.
    const scan = scanFixture(false);
    const { fns, view } = scan;
    const screen = fns.GetDC.handler([0]);
    const bitmap = fns.CreateCompatibleBitmap.handler([screen, 10, 10]);
    const DATA = 0x3000;
    /** @returns {number[]} what each of the three calls answers */
    const answers = ()=>[
        fns.SetDIBits.handler([screen, bitmap, 0, 1, DATA, WIRED_INFO, 0]),
        fns.SetDIBitsToDevice.handler([scan.dc, 0, 0, 1, 1, 0, 0, 0, 1, DATA, WIRED_INFO, 0]),
        fns.StretchDIBits.handler([scan.dc, 0, 0, 1, 1, 0, 0, 1, 1, DATA, WIRED_INFO, 0,
            0x00cc0020]),
    ];
    for (const bitCount of [1, 4, 8, 16, 24, 32])
    {
        for (const planes of [0, 1, 2])
        {
            putInfo(view, { width: 2, height: 2, bitCount,
                table: bitCount <= 8 ? Array(1 << bitCount).fill(0) : [] });
            view.setUint16(WIRED_INFO + BITMAPINFOHEADER.biPlanes, planes, true);
            const name = `${bitCount} bits, ${planes} planes`;
            if (planes === 0)
            {
                assert.deepEqual(answers(), [0, 0, 0], name);
            }
            else
            {
                assert.ok(answers().every(answer=>answer !== 0), name);
            }
            view.setUint16(WIRED_INFO + BITMAPINFOHEADER.biPlanes, planes, true);
            assert.notEqual(fns.GetDIBits.handler([screen, bitmap, 0, 0, DATA, WIRED_INFO, 0]),
                0, `${name}, described`);
            view.setUint16(WIRED_INFO + BITMAPINFOHEADER.biPlanes, planes, true);
            view.setUint16(WIRED_INFO + BITMAPINFOHEADER.biBitCount, bitCount, true);
            assert.equal(fns.GetDIBits.handler([screen, bitmap, 0, 2, DATA, WIRED_INFO, 0]) !== 0,
                planes !== 0, `${name}, filled`);
        }
    }
});

test('StretchDIBits draws an RLE DIB\'s runs and leaves the rest as it was', ()=>{
    // Wine's dib tests draw these through StretchDIBits under SRCCOPY and
    // SRCAND, offset and doubled, and compare the result's hash; here the
    // one-to-one copy is the SetDIBitsToDevice picture, and a doubled one
    // each run pixel twice over.
    const scan = scanFixture(false);
    const { fns, view } = scan;
    putRle(view, {}, RLE8);
    scan.fill();
    assert.equal(fns.StretchDIBits.handler([scan.dc, 0, 0, 8, 8, 0, 0, 8, 8, RLE_DATA,
        WIRED_INFO, 0, 0x00cc0020]), 8);
    assert.deepEqual(scan.pixels(), RLE8_BOTTOM_UP);
    scan.fill();
    fns.StretchDIBits.handler([scan.dc, 0, 0, 8, 8, 0, 0, 4, 4, RLE_DATA, WIRED_INFO, 0,
        0x00cc0020]);
    // The source's bottom-left quarter, doubled: its rows 0 to 3 from the
    // bottom -- a bottom-up DIB's ySrc counts from there -- and columns 0 to 3.
    assert.deepEqual(scan.pixels(), [...Array(64).keys()].map(index=>{
        const row = index >> 3;
        const column = index & 7;
        return RLE8_BOTTOM_UP[(row >> 1) * 8 + (column >> 1)];
    }));
});

test('GetDIBits hands back the scan lines asked for, zeros where the bitmap is not', ()=>{
    // Wine's test_GetDIBits_scanlines, every case: a section whose DWORDs
    // count from zero, read back as bottom-up and top-down DIBs of 5, 8 and
    // 16 rows from uStartScan for cLines. Each range names what lands in the
    // 128-DWORD buffer; everything else is left as it was.
    /** @param {number} index @returns {number} the tests' 64-DWORD inverted_bits */
    const inverted64 = index=>56 - (index & ~7) + (index & 7);
    /** @param {number} shift */
    const own = shift=>(/** @type {number} */ index)=>index + shift;
    /** @param {number} shift */
    const turned = shift=>(/** @type {number} */ index)=>inverted64(index + shift);
    const zero = ()=>0;
    /** @type {[boolean, number, number, number, number, [number, number, any][]][]} */
    const cases = [
        [false, 8, 0, 8, 8, [[0, 64, own(0)]]],
        [false, 8, 1, 5, 5, [[0, 40, own(8)]]],
        [false, 8, 1, 12, 7, [[0, 56, own(8)]]],
        [false, 8, 9, 12, 1, []],
        [false, 16, 1, 12, 5, [[0, 56, zero], [56, 96, own(-56)]]],
        [false, 16, 2, 12, 6, [[0, 48, zero], [48, 96, own(-48)]]],
        [false, 16, 2, 3, 0, [[0, 24, zero]]],
        [false, 5, 1, 2, 2, [[0, 16, own(32)]]],
        [false, -8, 0, 8, 8, [[0, 64, turned(0)]]],
        [false, -8, 1, 5, 5, [[0, 40, turned(16)]]],
        [false, -8, 1, 12, 7, [[0, 56, turned(0)]]],
        [false, -8, 4, 12, 4, [[0, 32, turned(0)]]],
        [false, -8, 3, 12, 5, [[0, 40, turned(0)]]],
        [false, -8, 3, 13, 5, [[0, 40, turned(0)]]],
        [false, -16, 0, 16, 8, [[0, 64, turned(0)], [64, 128, zero]]],
        [false, -16, 1, 12, 5, [[0, 40, turned(24)], [40, 96, zero]]],
        [false, -16, 4, 12, 8, [[0, 64, turned(0)], [64, 96, zero]]],
        [false, -16, 5, 12, 8, [[0, 64, turned(0)], [64, 88, zero]]],
        [false, -16, 9, 12, 7, [[0, 56, turned(0)]]],
        [false, -16, 18, 12, 1, []],
        [false, -5, 1, 2, 2, [[0, 16, turned(16)]]],
        [true, -8, 0, 8, 8, [[0, 64, own(0)]]],
        [true, -8, 1, 5, 5, [[0, 40, own(16)]]],
        [true, -8, 1, 12, 7, [[0, 56, own(0)]]],
        [true, -8, 4, 12, 4, [[0, 32, own(0)]]],
        [true, -8, 3, 12, 5, [[0, 40, own(0)]]],
        [true, -8, 3, 13, 5, [[0, 40, own(0)]]],
        [true, -16, 0, 16, 8, [[0, 64, own(0)], [64, 128, zero]]],
        [true, -16, 1, 12, 5, [[0, 40, own(24)], [40, 96, zero]]],
        [true, -16, 4, 12, 8, [[0, 64, own(0)], [64, 96, zero]]],
        [true, -16, 5, 12, 8, [[0, 64, own(0)], [64, 88, zero]]],
        [true, -16, 9, 12, 7, [[0, 56, own(0)]]],
        [true, -5, 1, 2, 2, [[0, 16, own(16)]]],
        [true, 8, 0, 8, 8, [[0, 64, turned(0)]]],
        [true, 8, 1, 5, 5, [[0, 40, turned(8)]]],
        [true, 8, 1, 12, 7, [[0, 56, turned(8)]]],
        [true, 8, 9, 12, 1, []],
        [true, 16, 1, 12, 5, [[0, 56, zero], [56, 96, turned(-56)]]],
        [true, 16, 2, 12, 6, [[0, 48, zero], [48, 96, turned(-48)]]],
        [true, 16, 2, 3, 0, [[0, 24, zero]]],
        [true, 5, 1, 2, 2, [[0, 16, turned(32)]]],
    ];
    const OUT = 0x3000;
    for (const [topDown, height, start, lines, answer, ranges] of cases)
    {
        const scan = scanFixture(topDown);
        scan.count();
        scan.header(height);
        for (let index = 0; index < 128; index++)
        {
            scan.view.setUint32(OUT + index * 4, 0xaaaaaaaa, true);
        }
        const screen = scan.fns.GetDC.handler([0]);
        const name = `${topDown ? 't-d' : 'b-u'} section, biHeight ${height}, ${start}+${lines}`;
        assert.equal(scan.fns.GetDIBits.handler([screen, scan.section, start, lines, OUT,
            WIRED_INFO, 0]), answer, name);
        const got = [...Array(128).keys()].map(index=>scan.view.getUint32(OUT + index * 4, true));
        const wanted = [...Array(128).keys()].map(index=>{
            const range = ranges.find(([from, to])=>index >= from && index < to);
            return range ? range[2](index) : 0xaaaaaaaa;
        });
        assert.deepEqual(got, wanted, name);
    }
});

test('a DIB pattern brush paints its DIB, a palette-relative one through the DC\'s palette', ()=>{
    // Wine's test_palette_brush: an 8-bit DIB_PAL_COLORS brush made before any
    // palette is selected paints each index through the palette selected
    // when it is drawn, and again through the next one.
    const { fns, view, bytes } = wiredGdi();
    putInfo(view, { width: 16, height: 16, bitCount: 32 });
    const section = fns.CreateDIBSection.handler([0, WIRED_INFO, 0, WIRED_POINTER, 0, 0]);
    const bits = view.getUint32(WIRED_POINTER, true);
    const dc = fns.CreateCompatibleDC.handler([0]);
    fns.SelectObject.handler([dc, section]);

    const PACKED = 0x4000;
    putInfo(view, { width: 16, height: 16, bitCount: 8 });
    bytes.copyWithin(PACKED, WIRED_INFO, WIRED_INFO + 40);
    for (let index = 0; index < 256; index++)
    {
        view.setUint16(PACKED + 40 + index * 2, 255 - index, true);
        bytes[PACKED + 40 + 512 + index] = index;
    }
    const brush = fns.CreateDIBPatternBrushPt.handler([PACKED, 1]);
    assert.notEqual(brush, 0);

    const LOGPALETTE = 0x5000;
    /** @param {(index: number) => number} red */
    const palette = red=>{
        view.setUint16(LOGPALETTE, 0x300, true);
        view.setUint16(LOGPALETTE + 2, 256, true);
        for (let index = 0; index < 256; index++)
        {
            bytes.set([red(index) & 0xff, index * 2 & 0xff, index * 2 & 0xff, 0],
                LOGPALETTE + 4 + index * 4);
        }
        return fns.CreatePalette.handler([LOGPALETTE]);
    };
    fns.SelectObject.handler([dc, brush]);
    for (const red of [(/** @type {number} */ index)=>index * 2,
        (/** @type {number} */ index)=>index * 3])
    {
        fns.SelectPalette.handler([dc, palette(red), 0]);
        bytes.fill(0xaa, bits, bits + 16 * 16 * 4);
        assert.equal(fns.PatBlt.handler([dc, 0, 0, 16, 16, PATCOPY]), 1);
        for (let index = 0; index < 256; index++)
        {
            const entry = 255 - index;
            const expect = ((red(entry) & 0xff) << 16) | ((entry * 2 & 0xff) << 8)
                | (entry * 2 & 0xff);
            assert.equal(view.getUint32(bits + index * 4, true), expect, `${index}`);
        }
    }

    // A DIB_RGB_COLORS brush keeps its own colours, and tiles from the origin.
    putInfo(view, { width: 2, height: -1, bitCount: 1, table: [0x00ff0000, 0x000000ff] });
    bytes.copyWithin(PACKED, WIRED_INFO, WIRED_INFO + 48);
    bytes[PACKED + 48] = 0b01000000;
    fns.SelectObject.handler([dc, fns.CreateDIBPatternBrushPt.handler([PACKED, 0])]);
    fns.PatBlt.handler([dc, 0, 0, 4, 1, PATCOPY]);
    assert.deepEqual([0, 1, 2, 3].map(x=>fns.GetPixel.handler([dc, x, 0])),
        [0x0000ff, 0xff0000, 0x0000ff, 0xff0000], 'red, blue, as COLORREFs');
});

test('a BITMAPCOREHEADER DIB is read, drawn and handed back as Windows does', ()=>{
    // Wine's test_dibsections: GetDIBits fills a BITMAPCOREHEADER with the
    // bitmap's shape, and its colour table as RGBTRIPLEs, and CreateDIBSection
    // takes one. The header's WORD fields -- the height unsigned, so the rows
    // bottom-up -- and three-byte table go through every call that reads a
    // DIB: StretchDIBits, SetDIBitsToDevice, CreateDIBitmap's SetDIBits and
    // a DIB pattern brush.
    const { fns, view, bytes } = wiredGdi();
    const CORE = 0x4000;
    const OUT = 0x5000;
    const DIB = 0x6000;
    /**
     * @param {number} width @param {number} height @param {number} bitCount
     * @param {number[]} [triples]
     */
    const putCore = (width, height, bitCount, triples = [])=>{
        view.setUint32(CORE, 12, true);
        [width, height, 1, bitCount].forEach((value, index)=>
            view.setUint16(CORE + 4 + index * 2, value, true));
        bytes.set(triples, CORE + 12);
    };
    const dc = fns.CreateCompatibleDC.handler([0]);

    putInfo(view, { width: 16, height: 16, bitCount: 1, table: [0x00ff0000, 0x000000ff] });
    view.setUint32(WIRED_INFO + 32, 2, true);
    const section = fns.CreateDIBSection.handler([dc, WIRED_INFO, 0, WIRED_POINTER, 0, 0]);
    const at = view.getUint32(WIRED_POINTER, true);
    for (let index = 0; index < 64; index++)
    {
        bytes[at + index] = index * 37 & 0xff;
    }
    putCore(0, 0, 0);
    assert.ok(fns.GetDIBits.handler([dc, section, 0, 16, 0, CORE, 0]));
    assert.deepEqual([4, 6, 8, 10].map(offset=>view.getUint16(CORE + offset, true)),
        [16, 16, 1, 1], 'bcWidth, bcHeight, bcPlanes, bcBitCount');
    bytes.fill(0xaa, CORE + 12, CORE + 18);
    assert.equal(fns.GetDIBits.handler([dc, section, 0, 16, OUT, CORE, 0]), 16);
    assert.deepEqual([...bytes.subarray(CORE + 12, CORE + 18)], [0, 0, 0xff, 0xff, 0, 0],
        'red and blue, as RGBTRIPLEs');
    /** @param {number} from @returns {number[]} each row's two bytes of pixels */
    const rows = from=>[...Array(16).keys()].flatMap(row=>[bytes[from + row * 4],
        bytes[from + row * 4 + 1]]);
    assert.deepEqual(rows(OUT), rows(at));

    const core = fns.CreateDIBSection.handler([dc, CORE, 0, WIRED_POINTER, 0, 0]);
    assert.notEqual(core, 0, 'CreateDIBSection takes a BITMAPCOREINFO');
    bytes.fill(0, CORE + 12, CORE + 18);
    assert.equal(fns.GetDIBits.handler([dc, core, 0, 16, OUT, CORE, 0]), 16);
    assert.deepEqual([...bytes.subarray(CORE + 12, CORE + 18)], [0, 0, 0xff, 0xff, 0, 0]);

    putInfo(view, { width: 2, height: -2, bitCount: 32 });
    const target = fns.CreateDIBSection.handler([dc, WIRED_INFO, 0, WIRED_POINTER, 0, 0]);
    const pixels = view.getUint32(WIRED_POINTER, true);
    fns.SelectObject.handler([dc, target]);
    const read = ()=>[0, 1, 2, 3].map(index=>view.getUint32(pixels + index * 4, true));
    const RED = 0xff0000;
    const BLUE = 0x0000ff;

    putCore(2, 2, 1, [0, 0, 0xff, 0xff, 0, 0]);
    bytes.set([0b01000000, 0, 0, 0, 0b10000000, 0, 0, 0], DIB);
    assert.equal(fns.StretchDIBits.handler([dc, 0, 0, 2, 2, 0, 0, 2, 2, DIB, CORE, 0,
        0x00cc0020]), 2);
    assert.deepEqual(read(), [BLUE, RED, RED, BLUE], 'the first row of the bits at the bottom');

    putCore(2, 2, 24);
    bytes.set([0x33, 0x22, 0x11, 0x66, 0x55, 0x44, 0, 0,
        0x99, 0x88, 0x77, 0xcc, 0xbb, 0xaa, 0, 0], DIB);
    assert.equal(fns.SetDIBitsToDevice.handler([dc, 0, 0, 2, 2, 0, 0, 0, 2, DIB, CORE, 0]), 2);
    assert.deepEqual(read(), [0x778899, 0xaabbcc, 0x112233, 0x445566]);

    putCore(2, 1, 1, [0, 0, 0xff, 0xff, 0, 0]);
    bytes.set([0b01000000, 0, 0, 0], CORE + 18);
    fns.SelectObject.handler([dc, fns.CreateDIBPatternBrushPt.handler([CORE, 0])]);
    fns.PatBlt.handler([dc, 0, 0, 2, 2, PATCOPY]);
    assert.deepEqual(read(), [RED, BLUE, RED, BLUE], 'a packed BITMAPCOREINFO as a brush');

    putCore(2, 1, 8, [0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
    bytes.set([1, 0, 0, 0], DIB);
    const screen = fns.GetDC.handler([0]);
    const ddb = fns.CreateDIBitmap.handler([screen, CORE, 4, DIB, CORE, 0]);
    assert.notEqual(ddb, 0);
    const other = fns.CreateCompatibleDC.handler([screen]);
    fns.SelectObject.handler([other, ddb]);
    assert.deepEqual([0, 1].map(x=>fns.GetPixel.handler([other, x, 0])), [0x405060, 0x102030],
        'CBM_INIT through the three-byte table, as COLORREFs');
});

test('the nearest colour is what a SetPixel of it reads back as, and draws nothing', ()=>{
    const objects = createGdiObjects(fakeHandles());
    const drawing = createGdiDrawing({ objects, metrics: ()=>METRICS });
    assert.equal(drawing.nearestColor(HDC, RED_COLOR), CLR_INVALID, 'no context');
    const palette = [0x00000000, RED_PIXEL, 0x0000ff00, BLUE_PIXEL];
    for (const options of [{ bitCount: 32 }, { bitCount: 16 }, { bitCount: 8, palette }])
    {
        const surface = createSurface({ width: 2, height: 1, ...options });
        drawing.bind(HDC, surface);
        for (const color of [0x00abcdef, 0x00123456, 0x000000f0])
        {
            const before = surface.read(1, 0);
            const nearest = drawing.nearestColor(HDC, color);
            assert.equal(surface.read(1, 0), before);
            drawing.setPixel(HDC, 0, 0, color);
            assert.equal(nearest, drawing.getPixel(HDC, 0, 0),
                `${options.bitCount} bits, 0x${color.toString(16)}`);
        }
    }
    assert.equal(drawing.nearestColor(HDC, 0x000000f0), RED_COLOR, 'the palette entry nearest');
    drawing.bind(HDC, createSurface({ width: 1, height: 1, bitCount: 16 }));
    assert.equal(drawing.nearestColor(HDC, 0x00abcdef), 0x00adceef, 'five bits a channel');
});

test('the text alignment is the context\'s own, and a new surface does not reset it', ()=>{
    const state = { textAlign: 0, position: { x: 0, y: 0 } };
    const objects = createGdiObjects(fakeHandles());
    const drawing = createGdiDrawing({ objects, metrics: ()=>METRICS });
    drawing.bind(HDC, createSurface({ width: 4, height: 4 }), state);
    assert.equal(drawing.setTextAlign(HDC, TA_CENTER), 0);
    assert.equal(state.textAlign, TA_CENTER, 'kept on the state the bookkeeping half owns');
    drawing.bind(HDC, createSurface({ width: 8, height: 8 }), state);
    assert.equal(drawing.getTextAlign(HDC), TA_CENTER);
    state.textAlign = 0;
    assert.equal(drawing.getTextAlign(HDC), 0, 'and a RestoreDC of the state is seen');
});

// --- MaskBlt, AlphaBlend, GradientFill and ExtFloodFill through a context ---

const MASK_HDC = 0x3000;

test('MaskBlt reads its mask\'s bits from the mask\'s own corner', ()=>{
    const { drawing, surface } = fixture({ width: 8, height: 1 });
    drawing.bind(SOURCE_HDC, createSurface({ width: 8, height: 1 }));
    drawing.clear(SOURCE_HDC, RED_COLOR);
    // A monochrome bitmap: the bits 0xa5, white where they are set.
    const mask = surfaceForDdb({ width: 8, height: 1, bitCount: 1,
        pixels: Uint8Array.of(0xa5, 0) });
    drawing.bind(MASK_HDC, /** @type {any} */ (mask));
    const DSTCOPY = 0x00aa0029;
    const rop = (((DSTCOPY << 8) & 0xff000000) | SRCCOPY) >>> 0;
    assert.equal(drawing.maskBlt(HDC, 0, 0, 8, 1, SOURCE_HDC, 0, 0, MASK_HDC, 0, 0, rop), true);
    assert.deepEqual([...Array(8).keys()].map(x=>surface.read(x, 0) === RED_PIXEL ? 1 : 0),
        [1, 0, 1, 0, 0, 1, 0, 1]);

    clearSurface(surface, BACKGROUND);
    drawing.maskBlt(HDC, 2, 0, 6, 1, SOURCE_HDC, 0, 0, MASK_HDC, 4, 0, rop);
    assert.deepEqual([...Array(8).keys()].map(x=>surface.read(x, 0) === RED_PIXEL ? 1 : 0),
        [0, 0, 0, 1, 0, 1, 0, 0], 'the mask from its fifth bit, and none past its end');
    assert.equal(drawing.maskBlt(HDC, 0, 0, 1, 1, SOURCE_HDC, 0, 0, 0x7777, 0, 0, rop), false,
        'a mask with no pixels');
});

test('AlphaBlend between two contexts blends under the destination\'s clip', ()=>{
    const { drawing, surface } = fixture({ width: 4, height: 1 });
    drawing.bind(SOURCE_HDC, createSurface({ width: 2, height: 1 }));
    drawing.clear(SOURCE_HDC, RED_COLOR);
    drawing.setClipRect(HDC, { left: 0, top: 0, right: 3, bottom: 1 });
    assert.equal(drawing.alphaBlend(HDC, 0, 0, 4, 1, SOURCE_HDC, 0, 0, 2, 1,
        { constantAlpha: 255, perPixel: false }), true);
    assert.deepEqual([0, 1, 2, 3].map(x=>surface.read(x, 0)),
        [RED_PIXEL, RED_PIXEL, RED_PIXEL, BACKGROUND]);
    assert.equal(drawing.alphaBlend(HDC, 0, 0, 1, 1, 0x7777, 0, 0, 1, 1,
        { constantAlpha: 255, perPixel: false }), false, 'no source');
});

test('a gradient is written as it is, whatever the binary raster operation', ()=>{
    const { drawing, surface, context } = fixture({ width: 2, height: 1 });
    context.state.rop2 = 7;
    const red = { x: 0, y: 0, red: 0xff00, green: 0, blue: 0, alpha: 0 };
    assert.equal(drawing.gradientFill(HDC, [red, { ...red, x: 2, y: 1 }], [[0, 1]], 0), true);
    assert.equal(surface.read(0, 0), RED_PIXEL, 'R2_XORPEN would have mixed it in');
    assert.equal(drawing.gradientFill(0x7777, [], [], 0), false);
});

test('a flood fill is bounded by the clip region and painted with the selected brush', ()=>{
    const { objects, drawing, surface, context } = fixture({ width: 8, height: 2 });
    context.state.brush = objects.create('brush', { style: BS_SOLID, color: RED_COLOR, hatch: 0 });
    drawing.setClipRegion(HDC, [
        { left: 0, top: 0, right: 3, bottom: 2 },
        { left: 4, top: 0, right: 8, bottom: 2 },
    ]);
    assert.equal(drawing.floodFill(HDC, 5, 1, colorOf(BACKGROUND), 1), true);
    assert.deepEqual([0, 3, 4, 7].map(x=>surface.read(x, 1)),
        [BACKGROUND, BACKGROUND, RED_PIXEL, RED_PIXEL], 'the gap in the clip is a border');
    assert.equal(drawing.floodFill(HDC, 3, 0, colorOf(BACKGROUND), 1), false, 'in the gap');
    assert.equal(drawing.floodFill(0x7777, 0, 0, 0, 0), false);
});

/** The COLORREF of a pixel. @param {number} pixel */
function colorOf(pixel){
    return ((pixel & 0xff) << 16) | (pixel & 0xff00) | ((pixel >>> 16) & 0xff);
}

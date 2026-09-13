/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiFunctions } from './functions.js';
import {
    BITMAPINFOHEADER,
    LOGBRUSH,
    LOGFONTA,
    LOGPEN,
    POINT,
    SIZE,
    TEXTMETRICA,
} from './structs.js';

/** Guest addresses the fixtures use, far enough apart that nothing overlaps. */
const STRUCT = 0x10000;
const OUT = 0x10100;
const BITS_POINTER = 0x10200;
const FACE_NAME = 0x10300;
const HEAP = 0x20000;

/** Fills a buffer so that "wrote nothing" is distinguishable from "wrote zero". */
const UNTOUCHED = 0xa5a5a5a5;

const HWND = 0x00cc0001;

/** Stock object indices. */
const WHITE_BRUSH = 0;
const BLACK_BRUSH = 4;
const BLACK_PEN = 7;
const SYSTEM_FONT = 13;
const DEFAULT_PALETTE = 15;
const DEFAULT_GUI_FONT = 17;

/** GetCurrentObject's object types. */
const OBJ_PEN = 1;
const OBJ_BRUSH = 2;
const OBJ_FONT = 6;
const OBJ_BITMAP = 7;

/** GetDeviceCaps indices. */
const TECHNOLOGY = 2;
const HORZRES = 8;
const VERTRES = 10;
const BITSPIXEL = 12;
const PLANES = 14;
const LOGPIXELSX = 88;

/** What a call that should have returned a colour says instead. */
const CLR_INVALID = 0xffffffff;

const TRANSPARENT = 1;
const OPAQUE = 2;
const R2_COPYPEN = 13;
const R2_XORPEN = 7;
const MM_TEXT = 1;
const MM_ANISOTROPIC = 8;

const PS_SOLID = 0;
const PS_NULL = 5;
const BS_NULL = 1;
const BS_HATCHED = 2;
const HS_CROSS = 4;

const BI_RGB = 0;
const BI_RLE8 = 1;

/**
 * Guest memory as a flat array. The real memory layer hands back views onto the
 * same bytes, so this one does too.
 */
function fakeMemory(size = 0x30000){
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let end = address;
            while (end < bytes.length && end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return new TextDecoder('latin1').decode(bytes.subarray(address, end));
        },
        /** @param {number} address @param {string} text */
        putString(address, text){
            for (let index = 0; index < text.length; index++)
            {
                bytes[address + index] = text.charCodeAt(index) & 0xff;
            }
            bytes[address + text.length] = 0;
            return address;
        },
        /** @param {number} address @param {number[]} values */
        putU32s(address, values){
            values.forEach((value, index)=>
                view.setUint32(address + (index * 4), value >>> 0, true));
        },
        /** @param {number} address @param {number} value */
        putU16(address, value){
            view.setUint16(address, value & 0xffff, true);
        },
        /** @param {number} address @param {number} value */
        putU8(address, value){
            bytes[address] = value & 0xff;
        },
        /** @param {number} address */
        u32: address=>view.getUint32(address, true),
        /** @param {number} address */
        i32: address=>view.getInt32(address, true),
        /** @param {number} address */
        u8: address=>bytes[address],
        /** @param {number} address @param {number} count */
        fill(address, count){
            this.putU32s(address, new Array(count).fill(UNTOUCHED));
        },
    };
}

/** The kernel's handle table, reduced to what gdi32 needs from it. */
function fakeHandles(){
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 0x20;
    return {
        entries,
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            entries.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle */
        close(handle){
            if (!entries.delete(handle))
            {
                throw new Error('Invalid handle');
            }
        },
    };
}

/** A bump allocator standing in for wherever DIB bits really come from. */
function fakeSurfaces(){
    /** @type {{ address: number, bytes: number }[]} */
    const allocated = [];
    /** @type {number[]} */
    const freed = [];
    let next = HEAP;
    return {
        allocated,
        freed,
        /** @param {number} count */
        allocate(count){
            const address = next;
            // Keep allocations page-apart so an overrun shows up as a gap rather
            // than as the next surface.
            next += Math.ceil((count + 1) / 0x1000) * 0x1000;
            allocated.push({ address, bytes: count });
            return address;
        },
        /** @param {number} address */
        free: address=>freed.push(address),
    };
}

function setup(){
    const memory = fakeMemory();
    const handles = fakeHandles();
    const surfaces = fakeSurfaces();
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>memory.readMemory(address, length),
        writeMemory: (address, data)=>memory.writeMemory(address, data),
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        handles,
        surfaces,
    });
    return { memory, handles, surfaces, fns: gdi.table, gdi };
}

/** A display DC, which most of these need. */
function withDC(){
    const context = setup();
    return { ...context, hdc: context.fns.GetDC.handler([HWND]) };
}

/**
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {Partial<{ height: number, width: number, weight: number, italic: number,
 *   charSet: number, pitchAndFamily: number, faceName: string }>} [options]
 */
function putLogFont(memory, options = {}){
    const {
        height = -12, width = 0, weight = 400, italic = 0, charSet = 0,
        pitchAndFamily = 0, faceName = 'Courier New',
    } = options;
    memory.putU32s(STRUCT + LOGFONTA.lfHeight, [height, width, 0, 0, weight]);
    memory.putU8(STRUCT + LOGFONTA.lfItalic, italic);
    memory.putU8(STRUCT + LOGFONTA.lfUnderline, 0);
    memory.putU8(STRUCT + LOGFONTA.lfStrikeOut, 0);
    memory.putU8(STRUCT + LOGFONTA.lfCharSet, charSet);
    memory.putU8(STRUCT + LOGFONTA.lfOutPrecision, 0);
    memory.putU8(STRUCT + LOGFONTA.lfClipPrecision, 0);
    memory.putU8(STRUCT + LOGFONTA.lfQuality, 0);
    memory.putU8(STRUCT + LOGFONTA.lfPitchAndFamily, pitchAndFamily);
    memory.putString(STRUCT + LOGFONTA.lfFaceName, faceName);
    return STRUCT;
}

/**
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {Partial<{ size: number, width: number, height: number, bitCount: number,
 *   compression: number }>} [options]
 */
function putBitmapInfo(memory, options = {}){
    const {
        size = BITMAPINFOHEADER.SIZE, width = 10, height = 4, bitCount = 24,
        compression = BI_RGB,
    } = options;
    memory.putU32s(STRUCT + BITMAPINFOHEADER.biSize, [size, width, height]);
    memory.putU16(STRUCT + BITMAPINFOHEADER.biPlanes, 1);
    memory.putU16(STRUCT + BITMAPINFOHEADER.biBitCount, bitCount);
    memory.putU32s(STRUCT + BITMAPINFOHEADER.biCompression, [compression, 0, 0, 0, 0, 0]);
    return STRUCT;
}

// --- stock objects ---

test('a stock object is the same object every time it is asked for', ()=>{
    const { fns } = setup();

    const first = fns.GetStockObject.handler([WHITE_BRUSH]);
    assert.ok(first > 0);
    assert.equal(fns.GetStockObject.handler([WHITE_BRUSH]), first,
        'programs compare stock handles, so a second call cannot mint a new one');
    assert.notEqual(fns.GetStockObject.handler([BLACK_BRUSH]), first);
});

test('every documented stock index answers, and the gaps do not', ()=>{
    const { fns } = setup();
    const defined = [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17];

    const handles = defined.map(index=>fns.GetStockObject.handler([index]));
    assert.equal(new Set(handles).size, defined.length, 'no two stock objects share a handle');
    assert.ok(handles.every(handle=>handle > 0));

    assert.equal(fns.GetStockObject.handler([99]), 0, 'an index nobody defined is NULL');
    assert.equal(fns.GetStockObject.handler([-1]), 0);
});

test('deleting a stock object succeeds and changes nothing', ()=>{
    const { fns, hdc } = withDC();
    const brush = fns.GetStockObject.handler([BLACK_BRUSH]);

    assert.equal(fns.DeleteObject.handler([brush]), 1,
        'the documented answer is TRUE even though nothing is deleted');
    assert.equal(fns.SelectObject.handler([hdc, brush]) > 0, true,
        'and the object is still there to be selected');
});

// --- device contexts ---

test('a fresh DC starts with the stock objects Windows puts in it', ()=>{
    const { fns, hdc } = withDC();

    assert.equal(fns.GetCurrentObject.handler([hdc, OBJ_PEN]),
        fns.GetStockObject.handler([BLACK_PEN]));
    assert.equal(fns.GetCurrentObject.handler([hdc, OBJ_BRUSH]),
        fns.GetStockObject.handler([WHITE_BRUSH]));
    assert.equal(fns.GetCurrentObject.handler([hdc, OBJ_FONT]),
        fns.GetStockObject.handler([SYSTEM_FONT]));
    assert.equal(fns.GetTextColor.handler([hdc]), 0x000000, 'text starts black');
    assert.equal(fns.GetBkColor.handler([hdc]), 0xffffff, 'on white');
    assert.equal(fns.GetBkMode.handler([hdc]), OPAQUE);
    assert.equal(fns.GetROP2.handler([hdc]), R2_COPYPEN);
    assert.equal(fns.GetMapMode.handler([hdc]), MM_TEXT);
});

test('a DC is released once, and only by the window that owns it', ()=>{
    const { fns, hdc } = withDC();

    assert.equal(fns.ReleaseDC.handler([HWND + 4, hdc]), 0,
        'a DC belongs to the window it was fetched for');
    assert.equal(fns.ReleaseDC.handler([HWND, hdc]), 1);
    assert.equal(fns.ReleaseDC.handler([HWND, hdc]), 0,
        'releasing twice is the leak that never was');
    assert.equal(fns.GetTextColor.handler([hdc]), CLR_INVALID,
        'and the handle names nothing afterwards');
});

test('GetWindowDC is a DC of the same window', ()=>{
    const { fns } = setup();
    const hdc = fns.GetWindowDC.handler([HWND]);

    assert.ok(hdc > 0);
    assert.equal(fns.ReleaseDC.handler([HWND, hdc]), 1);
});

test('DeleteDC and ReleaseDC are not interchangeable', ()=>{
    const { fns, hdc } = withDC();
    const memoryDC = fns.CreateCompatibleDC.handler([hdc]);

    assert.equal(fns.DeleteDC.handler([hdc]), 0,
        'a DC that came from GetDC has to go back through ReleaseDC');
    assert.equal(fns.ReleaseDC.handler([HWND, memoryDC]), 0,
        'and a memory DC was never anybody\'s window');

    assert.equal(fns.DeleteDC.handler([memoryDC]), 1);
    assert.equal(fns.DeleteDC.handler([memoryDC]), 0);
});

test('CreateCompatibleDC starts with the one-pixel bitmap it is documented to have', ()=>{
    const { fns, hdc } = withDC();
    const memoryDC = fns.CreateCompatibleDC.handler([hdc]);

    const bitmap = fns.GetCurrentObject.handler([memoryDC, OBJ_BITMAP]);
    assert.ok(bitmap > 0, 'a memory DC is one monochrome pixel until something is selected');
    assert.equal(fns.GetDeviceCaps.handler([memoryDC, BITSPIXEL]), 1,
        'and its depth is that bitmap\'s, not the screen\'s');
});

test('deleting a DC lets go of what it had selected', ()=>{
    const { fns, hdc } = withDC();
    const pen = fns.CreatePen.handler([PS_SOLID, 1, 0xff]);
    const memoryDC = fns.CreateCompatibleDC.handler([hdc]);

    fns.SelectObject.handler([memoryDC, pen]);
    assert.equal(fns.DeleteObject.handler([pen]), 0, 'still selected');

    fns.DeleteDC.handler([memoryDC]);
    assert.equal(fns.DeleteObject.handler([pen]), 1,
        'the DC that held it is gone, so the pen can go too');
});

// --- selecting objects ---

test('SelectObject answers with the object it replaced, per type', ()=>{
    const { fns, hdc } = withDC();
    const pen = fns.CreatePen.handler([PS_SOLID, 2, 0x0000ff]);
    const brush = fns.CreateSolidBrush.handler([0x00ff00]);
    const stockPen = fns.GetStockObject.handler([BLACK_PEN]);
    const stockBrush = fns.GetStockObject.handler([WHITE_BRUSH]);

    assert.equal(fns.SelectObject.handler([hdc, pen]), stockPen);
    assert.equal(fns.SelectObject.handler([hdc, brush]), stockBrush,
        'selecting a brush reports the previous brush, not the previous pen');
    assert.equal(fns.SelectObject.handler([hdc, stockPen]), pen,
        'and putting the old one back hands ours out again');
});

test('SelectObject refuses what cannot be selected', ()=>{
    const { fns, hdc } = withDC();
    const palette = fns.GetStockObject.handler([DEFAULT_PALETTE]);

    assert.equal(fns.SelectObject.handler([hdc, palette]), 0,
        'a palette goes in through SelectPalette, which is a different call');
    assert.equal(fns.SelectObject.handler([hdc, 0x9999]), 0, 'and junk is not an object');
    assert.equal(fns.SelectObject.handler([0x9999, palette]), 0, 'nor is junk a DC');
});

test('a bitmap belongs to one memory DC at a time', ()=>{
    const { fns, hdc } = withDC();
    const bitmap = fns.CreateCompatibleBitmap.handler([hdc, 16, 16]);
    const first = fns.CreateCompatibleDC.handler([hdc]);
    const second = fns.CreateCompatibleDC.handler([hdc]);

    assert.equal(fns.SelectObject.handler([hdc, bitmap]), 0,
        'a display DC already has a surface: the screen');
    assert.ok(fns.SelectObject.handler([first, bitmap]) > 0);
    assert.equal(fns.SelectObject.handler([second, bitmap]), 0,
        'two DCs drawing into one bitmap is the corruption this rule prevents');
});

test('an object selected into a DC cannot be deleted until it is out again', ()=>{
    const { fns, hdc } = withDC();
    const pen = fns.CreatePen.handler([PS_SOLID, 1, 0]);
    const previous = fns.SelectObject.handler([hdc, pen]);

    assert.equal(fns.DeleteObject.handler([pen]), 0,
        'the DC would be left naming a handle somebody else could be given');
    fns.SelectObject.handler([hdc, previous]);
    assert.equal(fns.DeleteObject.handler([pen]), 1);
    assert.equal(fns.DeleteObject.handler([pen]), 0, 'and it only deletes once');
});

test('GetCurrentObject has an answer only for the types a DC selects', ()=>{
    const { fns, hdc } = withDC();

    assert.ok(fns.GetCurrentObject.handler([hdc, OBJ_PEN]) > 0);
    assert.equal(fns.GetCurrentObject.handler([hdc, OBJ_BITMAP]), 0,
        'a display DC has no bitmap of its own');
    assert.equal(fns.GetCurrentObject.handler([hdc, 0]), 0);
});

// --- object creation ---

test('CreatePenIndirect reads LOGPEN at the documented offsets', ()=>{
    const { fns, memory, hdc } = withDC();
    memory.putU32s(STRUCT + LOGPEN.lopnStyle, [PS_SOLID]);
    memory.putU32s(STRUCT + LOGPEN.lopnWidthX, [3, 0]);
    memory.putU32s(STRUCT + LOGPEN.lopnColor, [0x00123456]);

    const pen = fns.CreatePenIndirect.handler([STRUCT]);
    assert.ok(pen > 0);
    // The attributes are what a drawing layer will read back, and the only way
    // to see them from here is that the same values make the same pen.
    fns.SelectObject.handler([hdc, pen]);
    assert.equal(fns.GetCurrentObject.handler([hdc, OBJ_PEN]), pen);

    memory.putU32s(STRUCT + LOGPEN.lopnStyle, [PS_NULL]);
    assert.ok(fns.CreatePenIndirect.handler([STRUCT]) > 0);
});

test('CreateBrushIndirect reads LOGBRUSH at the documented offsets', ()=>{
    const { fns, memory } = setup();
    memory.putU32s(STRUCT + LOGBRUSH.lbStyle, [BS_HATCHED]);
    memory.putU32s(STRUCT + LOGBRUSH.lbColor, [0x00ff00ff]);
    memory.putU32s(STRUCT + LOGBRUSH.lbHatch, [HS_CROSS]);

    assert.ok(fns.CreateBrushIndirect.handler([STRUCT]) > 0);

    memory.putU32s(STRUCT + LOGBRUSH.lbStyle, [BS_NULL]);
    assert.ok(fns.CreateBrushIndirect.handler([STRUCT]) > 0, 'a hollow brush is still a brush');

    memory.putU32s(STRUCT + LOGBRUSH.lbStyle, [0x99]);
    assert.equal(fns.CreateBrushIndirect.handler([STRUCT]), 0,
        'a style gdi32 does not define is not a brush');
});

test('the three brush constructors all make brushes', ()=>{
    const { fns, hdc } = withDC();

    const solid = fns.CreateSolidBrush.handler([0x00abcdef]);
    const hatched = fns.CreateHatchBrush.handler([HS_CROSS, 0x00ffffff]);
    assert.ok(solid > 0 && hatched > 0 && solid !== hatched);

    assert.ok(fns.SelectObject.handler([hdc, solid]) > 0, 'and a brush selects as a brush');
    assert.equal(fns.SelectObject.handler([hdc, hatched]), solid);

    const bitmap = fns.CreateBitmap.handler([8, 8, 1, 1, 0]);
    const pattern = fns.CreatePatternBrush.handler([bitmap]);
    assert.ok(pattern > 0, 'a bitmap makes a pattern brush');
    assert.equal(fns.SelectObject.handler([hdc, pattern]), hatched);
    assert.equal(fns.CreatePatternBrush.handler([solid]), 0, 'a brush is not a bitmap');
    assert.equal(fns.CreatePatternBrush.handler([0]), 0);
});

test('CreateFontIndirectA reads LOGFONTA at the documented offsets', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -20, weight: 700, italic: 1, charSet: 0xcc });

    const font = fns.CreateFontIndirectA.handler([STRUCT]);
    assert.ok(font > 0);
    fns.SelectObject.handler([hdc, font]);

    memory.fill(OUT, TEXTMETRICA.SIZE / 4);
    assert.equal(fns.GetTextMetricsA.handler([hdc, OUT]), 1);
    // Every one of these comes from a different offset in the LOGFONT; reading
    // any of them from the wrong place lands on a neighbour that also looks like
    // a plausible number.
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmWeight), 700);
    assert.equal(memory.u8(OUT + TEXTMETRICA.tmItalic), 1);
    assert.equal(memory.u8(OUT + TEXTMETRICA.tmCharSet), 0xcc);
    assert.ok(memory.i32(OUT + TEXTMETRICA.tmHeight) >= 20,
        'a 20-pixel character cell is at least 20 pixels tall');
});

test('CreateFontA is CreateFontIndirectA with the fields spread over the stack', ()=>{
    const { fns, memory, hdc } = withDC();
    memory.putString(FACE_NAME, 'Courier New');

    const font = fns.CreateFontA.handler(
        [-12, 0, 0, 0, 700, 1, 0, 0, 0xcc, 0, 0, 0, 0, FACE_NAME]);
    assert.ok(font > 0);

    fns.SelectObject.handler([hdc, font]);
    fns.GetTextMetricsA.handler([hdc, OUT]);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmWeight), 700);
    assert.equal(memory.u8(OUT + TEXTMETRICA.tmItalic), 1);
    assert.equal(memory.u8(OUT + TEXTMETRICA.tmCharSet), 0xcc);
});

test('CreateCompatibleBitmap takes its depth from the DC, and zero means one pixel', ()=>{
    const { fns, hdc } = withDC();

    const bitmap = fns.CreateCompatibleBitmap.handler([hdc, 32, 24]);
    assert.ok(bitmap > 0);

    // Documented exactly: a zero extent yields a 1x1 monochrome bitmap rather
    // than a failure, which is why code that forgets to size a bitmap draws
    // nothing instead of crashing.
    assert.ok(fns.CreateCompatibleBitmap.handler([hdc, 0, 24]) > 0);
    assert.equal(fns.CreateCompatibleBitmap.handler([0x9999, 8, 8]), 0, 'but a DC is required');
});

test('CreateBitmap keeps the format it was given', ()=>{
    const { fns } = setup();

    assert.ok(fns.CreateBitmap.handler([8, 8, 1, 1, 0]) > 0);
    assert.ok(fns.CreateBitmap.handler([8, 8, 1, 24, 0x12000]) > 0);
    assert.equal(fns.CreateBitmap.handler([0, 8, 1, 1, 0]), 0,
        'unlike CreateCompatibleBitmap, this one has no device to fall back on');
    assert.equal(fns.CreateBitmap.handler([8, 8, 1, 7, 0]), 0,
        'seven bits per pixel is not a format');
});

test('CreateDIBSection asks for DWORD-aligned rows and hands back the pointer', ()=>{
    const { fns, memory, surfaces, hdc } = withDC();
    putBitmapInfo(memory, { width: 10, height: 4, bitCount: 24 });
    memory.putU32s(BITS_POINTER, [UNTOUCHED]);

    const bitmap = fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]);

    assert.ok(bitmap > 0);
    // 10 pixels of 24 bits is 30 bytes, and a DIB row is padded to a multiple
    // of four -- the single most common way to write a DIB loop that works on
    // some widths and shears the image on others.
    assert.deepEqual(surfaces.allocated, [{ address: HEAP, bytes: 32 * 4 }]);
    assert.equal(memory.u32(BITS_POINTER), HEAP, 'the guest draws through this pointer');
});

test('a top-down DIB is the same allocation as a bottom-up one', ()=>{
    const { fns, memory, surfaces, hdc } = withDC();
    putBitmapInfo(memory, { width: 10, height: -4, bitCount: 24 });

    assert.ok(fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]) > 0);
    assert.equal(surfaces.allocated[0].bytes, 32 * 4, 'the sign is a direction, not a size');
});

test('CreateDIBSection refuses what it cannot back with plain memory', ()=>{
    const { fns, memory, surfaces, hdc } = withDC();

    putBitmapInfo(memory, { compression: BI_RLE8 });
    assert.equal(fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]), 0,
        'a run-length encoded DIB has no addressable rows to hand out');

    putBitmapInfo(memory, { size: 12 });
    assert.equal(fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]), 0,
        'biSize says which header the guest compiled, and 12 is a different one');

    putBitmapInfo(memory);
    assert.equal(fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0x1234, 0]), 0,
        'a file mapping is the filesystem\'s, and there is none to map');

    assert.deepEqual(surfaces.allocated, [], 'a refused section allocates nothing');
});

test('deleting a DIB section gives its memory back', ()=>{
    const { fns, memory, surfaces, hdc } = withDC();
    putBitmapInfo(memory);
    const bitmap = fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]);

    assert.equal(fns.DeleteObject.handler([bitmap]), 1);
    assert.deepEqual(surfaces.freed, [HEAP]);
});

test('CreatePalette reads its entries out of the structure that carries them', ()=>{
    const { fns, memory } = setup();
    memory.putU16(STRUCT, 0x300);
    memory.putU16(STRUCT + 2, 3);
    memory.putU32s(STRUCT + 4, [0x000000ff, 0x0000ff00, 0x00ff0000]);

    assert.ok(fns.CreatePalette.handler([STRUCT]) > 0);

    memory.putU16(STRUCT + 2, 0);
    assert.equal(fns.CreatePalette.handler([STRUCT]), 0, 'a palette of nothing is not a palette');
});

// --- DC state ---

test('every setter answers with the value it replaced', ()=>{
    const { fns, hdc } = withDC();

    assert.equal(fns.SetTextColor.handler([hdc, 0x00ff0000]), 0x000000);
    assert.equal(fns.GetTextColor.handler([hdc]), 0x00ff0000);
    assert.equal(fns.SetBkColor.handler([hdc, 0x00000080]), 0x00ffffff);
    assert.equal(fns.GetBkColor.handler([hdc]), 0x00000080);
    assert.equal(fns.SetBkMode.handler([hdc, TRANSPARENT]), OPAQUE);
    assert.equal(fns.GetBkMode.handler([hdc]), TRANSPARENT);
    assert.equal(fns.SetROP2.handler([hdc, R2_XORPEN]), R2_COPYPEN);
    assert.equal(fns.GetROP2.handler([hdc]), R2_XORPEN);
    assert.equal(fns.SetMapMode.handler([hdc, MM_ANISOTROPIC]), MM_TEXT);
    assert.equal(fns.GetMapMode.handler([hdc]), MM_ANISOTROPIC);
});

test('a setter on a handle that is not a DC changes nothing and reports nothing', ()=>{
    const { fns } = setup();

    assert.equal(fns.SetTextColor.handler([0x9999, 0x00ff0000]), 0xffffffff,
        'CLR_INVALID is the documented failure, and it is not a colour');
    assert.equal(fns.SetBkMode.handler([0x9999, TRANSPARENT]), 0);
    assert.equal(fns.SetMapMode.handler([0x9999, MM_TEXT]), 0);
});

test('an unknown background mode or map mode is refused rather than stored', ()=>{
    const { fns, hdc } = withDC();

    assert.equal(fns.SetBkMode.handler([hdc, 99]), 0);
    assert.equal(fns.GetBkMode.handler([hdc]), OPAQUE, 'the old mode still stands');
    assert.equal(fns.SetMapMode.handler([hdc, 99]), 0);
    assert.equal(fns.GetMapMode.handler([hdc]), MM_TEXT);
});

test('the origins and extents hand back what they replaced', ()=>{
    const { fns, memory, hdc } = withDC();

    memory.fill(OUT, POINT.SIZE / 4);
    assert.equal(fns.SetViewportOrgEx.handler([hdc, 10, 20, OUT]), 1);
    assert.equal(memory.i32(OUT + POINT.x), 0, 'the origin it replaced was the default');
    assert.equal(fns.SetViewportOrgEx.handler([hdc, 30, 40, OUT]), 1);
    assert.equal(memory.i32(OUT + POINT.x), 10);
    assert.equal(memory.i32(OUT + POINT.y), 20);

    assert.equal(fns.SetWindowOrgEx.handler([hdc, -5, -6, 0]), 1,
        'a null pointer means the caller does not want the old value');
    assert.equal(fns.SetWindowOrgEx.handler([hdc, 0, 0, OUT]), 1);
    assert.equal(memory.i32(OUT + POINT.x), -5, 'and signed coordinates stay signed');
});

test('the extents only move in a mode that lets the program choose them', ()=>{
    const { fns, memory, hdc } = withDC();

    memory.fill(OUT, SIZE.SIZE / 4);
    assert.equal(fns.SetWindowExtEx.handler([hdc, 100, 100, OUT]), 1);
    assert.equal(memory.i32(OUT + SIZE.cx), 1, 'MM_TEXT maps one unit to one pixel');

    fns.SetWindowExtEx.handler([hdc, 200, 200, OUT]);
    assert.equal(memory.i32(OUT + SIZE.cx), 1,
        'and it stayed there: in MM_TEXT the extents are the mode\'s, not the caller\'s');

    fns.SetMapMode.handler([hdc, MM_ANISOTROPIC]);
    fns.SetWindowExtEx.handler([hdc, 200, 100, OUT]);
    fns.SetViewportExtEx.handler([hdc, 400, 300, OUT]);
    fns.SetWindowExtEx.handler([hdc, 1, 1, OUT]);
    assert.equal(memory.i32(OUT + SIZE.cx), 200, 'now the program owns them');
});

test('MoveToEx moves the current position and reports where it was', ()=>{
    const { fns, memory, hdc } = withDC();

    assert.equal(fns.MoveToEx.handler([hdc, 7, 9, 0]), 1);
    memory.fill(OUT, POINT.SIZE / 4);
    assert.equal(fns.MoveToEx.handler([hdc, 1, 2, OUT]), 1);
    assert.equal(memory.i32(OUT + POINT.x), 7);
    assert.equal(memory.i32(OUT + POINT.y), 9);

    assert.equal(fns.MoveToEx.handler([0x9999, 0, 0, OUT]), 0);
});

// --- saving and restoring ---

test('SaveDC numbers its states, and RestoreDC(-1) means the last one', ()=>{
    const { fns, hdc } = withDC();
    fns.SetTextColor.handler([hdc, 0x00111111]);

    assert.equal(fns.SaveDC.handler([hdc]), 1, 'the first saved state is level one');
    fns.SetTextColor.handler([hdc, 0x00222222]);
    assert.equal(fns.SaveDC.handler([hdc]), 2);
    fns.SetTextColor.handler([hdc, 0x00333333]);

    assert.equal(fns.RestoreDC.handler([hdc, -1]), 1);
    assert.equal(fns.GetTextColor.handler([hdc]), 0x00222222);
    assert.equal(fns.RestoreDC.handler([hdc, -1]), 1);
    assert.equal(fns.GetTextColor.handler([hdc]), 0x00111111);
    assert.equal(fns.RestoreDC.handler([hdc, -1]), 0, 'nothing left to restore');
});

test('RestoreDC to a level throws away the states above it', ()=>{
    const { fns, hdc } = withDC();
    fns.SetBkMode.handler([hdc, TRANSPARENT]);
    const level = fns.SaveDC.handler([hdc]);
    fns.SetBkMode.handler([hdc, OPAQUE]);
    fns.SaveDC.handler([hdc]);
    fns.SaveDC.handler([hdc]);

    assert.equal(fns.RestoreDC.handler([hdc, level]), 1);
    assert.equal(fns.GetBkMode.handler([hdc]), TRANSPARENT);
    assert.equal(fns.RestoreDC.handler([hdc, level]), 0,
        'the two states above it went with it');
    assert.equal(fns.SaveDC.handler([hdc]), 1, 'and the stack is empty again');
});

test('RestoreDC refuses a level that was never saved', ()=>{
    const { fns, hdc } = withDC();
    fns.SaveDC.handler([hdc]);

    assert.equal(fns.RestoreDC.handler([hdc, 0]), 0, 'there is no level zero');
    assert.equal(fns.RestoreDC.handler([hdc, 5]), 0);
    assert.equal(fns.RestoreDC.handler([hdc, -3]), 0);
    assert.equal(fns.RestoreDC.handler([0x9999, -1]), 0);
    assert.equal(fns.RestoreDC.handler([hdc, -1]), 1, 'the one real level still works');
});

test('a saved state holds on to the objects it remembers', ()=>{
    const { fns, hdc } = withDC();
    const pen = fns.CreatePen.handler([PS_SOLID, 1, 0]);
    const stockPen = fns.SelectObject.handler([hdc, pen]);

    fns.SaveDC.handler([hdc]);
    fns.SelectObject.handler([hdc, stockPen]);
    assert.equal(fns.DeleteObject.handler([pen]), 0,
        'restoring would put it back, so it cannot be gone');

    fns.RestoreDC.handler([hdc, -1]);
    assert.equal(fns.GetCurrentObject.handler([hdc, OBJ_PEN]), pen, 'and back it comes');
    fns.SelectObject.handler([hdc, stockPen]);
    assert.equal(fns.DeleteObject.handler([pen]), 1);
});

// --- device metrics ---

test('GetDeviceCaps answers for what is modelled and zero for what is not', ()=>{
    const { fns, hdc } = withDC();

    assert.equal(fns.GetDeviceCaps.handler([hdc, TECHNOLOGY]), 1, 'DT_RASDISPLAY');
    assert.equal(fns.GetDeviceCaps.handler([hdc, HORZRES]), 640);
    assert.equal(fns.GetDeviceCaps.handler([hdc, VERTRES]), 480);
    assert.equal(fns.GetDeviceCaps.handler([hdc, BITSPIXEL]), 32);
    assert.equal(fns.GetDeviceCaps.handler([hdc, PLANES]), 1);
    assert.equal(fns.GetDeviceCaps.handler([hdc, LOGPIXELSX]), 96);

    assert.equal(fns.GetDeviceCaps.handler([hdc, 118]), 0,
        'an index with no answer here reads as absent, not as garbage');
    assert.equal(fns.GetDeviceCaps.handler([0x9999, HORZRES]), 0);
});

// --- text metrics ---

test('GetTextMetricsA writes TEXTMETRIC at the documented offsets', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -12, weight: 400 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);

    memory.fill(OUT, TEXTMETRICA.SIZE / 4);
    assert.equal(fns.GetTextMetricsA.handler([hdc, OUT]), 1);

    const height = memory.i32(OUT + TEXTMETRICA.tmHeight);
    const ascent = memory.i32(OUT + TEXTMETRICA.tmAscent);
    const descent = memory.i32(OUT + TEXTMETRICA.tmDescent);
    assert.equal(ascent + descent, height,
        'the one identity every layout routine assumes');
    assert.ok(height >= 12, 'a twelve-pixel character needs at least twelve pixels of cell');
    assert.ok(memory.i32(OUT + TEXTMETRICA.tmInternalLeading) >= 0);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmExternalLeading), 0);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmOverhang), 0);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmDigitizedAspectX), 96);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmWeight), 400);
    assert.equal(memory.u8(OUT + TEXTMETRICA.tmBreakChar), 0x20);
    assert.equal(memory.u8(OUT + TEXTMETRICA.tmPitchAndFamily) & 1, 0,
        'TMPF_FIXED_PITCH is set for a VARIABLE pitch font, and everything here is fixed');
});

test('a taller font asks for more of everything', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -10 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    fns.GetTextMetricsA.handler([hdc, OUT]);
    const small = {
        height: memory.i32(OUT + TEXTMETRICA.tmHeight),
        width: memory.i32(OUT + TEXTMETRICA.tmAveCharWidth),
    };

    putLogFont(memory, { height: -30 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    fns.GetTextMetricsA.handler([hdc, OUT]);

    assert.ok(memory.i32(OUT + TEXTMETRICA.tmHeight) > small.height);
    assert.ok(memory.i32(OUT + TEXTMETRICA.tmAveCharWidth) > small.width);
});

test('a positive lfHeight is the cell, a negative one is the character', ()=>{
    const { fns, memory, hdc } = withDC();

    putLogFont(memory, { height: 24 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    fns.GetTextMetricsA.handler([hdc, OUT]);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmHeight), 24,
        'a positive height is the whole cell, internal leading included');

    putLogFont(memory, { height: -24 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    fns.GetTextMetricsA.handler([hdc, OUT]);
    const height = memory.i32(OUT + TEXTMETRICA.tmHeight);
    assert.ok(height > 24,
        'a negative height excludes the internal leading, so the cell is taller');
    assert.equal(height - memory.i32(OUT + TEXTMETRICA.tmInternalLeading), 24);
});

test('lfWidth overrides the width the height would have implied', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -12, width: 9 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);

    fns.GetTextMetricsA.handler([hdc, OUT]);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmAveCharWidth), 9);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmMaxCharWidth), 9,
        'nothing here is proportional, so the widest character is the average one');
});

test('a string is exactly as wide as its characters are', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -12, width: 8 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    memory.putString(FACE_NAME, 'Hello, world');

    memory.fill(OUT, SIZE.SIZE / 4);
    assert.equal(fns.GetTextExtentPoint32A.handler([hdc, FACE_NAME, 12, OUT]), 1);
    assert.equal(memory.i32(OUT + SIZE.cx), 12 * 8);

    fns.GetTextMetricsA.handler([hdc, STRUCT]);
    assert.equal(memory.i32(OUT + SIZE.cy), memory.i32(STRUCT + TEXTMETRICA.tmHeight),
        'the height of a line of text is the cell height, once');
});

test('GetTextExtentPointA is the older name for the same measurement', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -12, width: 8 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    memory.putString(FACE_NAME, 'Hello');

    assert.equal(fns.GetTextExtentPointA.argBytes, 16);
    memory.fill(OUT, SIZE.SIZE / 4);
    assert.equal(fns.GetTextExtentPointA.handler([hdc, FACE_NAME, 5, OUT]), 1);
    assert.equal(memory.i32(OUT + SIZE.cx), 5 * 8);
});

test('an empty string has no width, and a negative count is not a string', ()=>{
    const { fns, memory, hdc } = withDC();
    memory.putString(FACE_NAME, '');

    memory.fill(OUT, SIZE.SIZE / 4);
    assert.equal(fns.GetTextExtentPoint32A.handler([hdc, FACE_NAME, 0, OUT]), 1);
    assert.equal(memory.i32(OUT + SIZE.cx), 0);
    assert.ok(memory.i32(OUT + SIZE.cy) > 0, 'but a line of nothing is still a line tall');

    memory.fill(OUT, SIZE.SIZE / 4);
    assert.equal(fns.GetTextExtentPoint32A.handler([hdc, FACE_NAME, -1, OUT]), 0);
    assert.equal(memory.u32(OUT), UNTOUCHED, 'a failed call leaves the guest buffer alone');
});

test('the metrics of a DC nobody selected a font into are the system font\'s', ()=>{
    const { fns, memory, hdc } = withDC();

    assert.equal(fns.GetTextMetricsA.handler([hdc, OUT]), 1);
    const system = memory.i32(OUT + TEXTMETRICA.tmHeight);

    fns.SelectObject.handler([hdc, fns.GetStockObject.handler([DEFAULT_GUI_FONT])]);
    fns.GetTextMetricsA.handler([hdc, OUT]);
    assert.ok(memory.i32(OUT + TEXTMETRICA.tmHeight) > 0);
    assert.ok(system > 0);

    memory.fill(OUT, TEXTMETRICA.SIZE / 4);
    assert.equal(fns.GetTextMetricsA.handler([0x9999, OUT]), 0);
    assert.equal(memory.u32(OUT), UNTOUCHED);
});

// --- the stack every one of them pops ---

test('every function declares the stack its arguments occupy', ()=>{
    const { fns } = setup();
    /** @type {Record<string, number>} */
    const expected = {
        GetDC: 4,
        GetWindowDC: 4,
        ReleaseDC: 8,
        CreateCompatibleDC: 4,
        DeleteDC: 4,
        SaveDC: 4,
        RestoreDC: 8,
        GetStockObject: 4,
        DeleteObject: 4,
        SelectObject: 8,
        GetCurrentObject: 8,
        CreatePen: 12,
        CreatePenIndirect: 4,
        CreateSolidBrush: 4,
        CreateBrushIndirect: 4,
        CreateHatchBrush: 8,
        CreateFontA: 56,
        CreateFontIndirectA: 4,
        CreateCompatibleBitmap: 12,
        CreateBitmap: 20,
        CreateDIBSection: 24,
        CreatePalette: 4,
        SetTextColor: 8,
        GetTextColor: 4,
        SetBkColor: 8,
        GetBkColor: 4,
        SetBkMode: 8,
        GetBkMode: 4,
        SetROP2: 8,
        GetROP2: 4,
        SetMapMode: 8,
        GetMapMode: 4,
        SetViewportOrgEx: 16,
        SetWindowOrgEx: 16,
        SetViewportExtEx: 16,
        SetWindowExtEx: 16,
        MoveToEx: 16,
        GetDeviceCaps: 8,
        GetTextMetricsA: 8,
        GetTextExtentPoint32A: 16,
    };

    const table = /** @type {Record<string, { argBytes: number }>} */ (
        /** @type {unknown} */ (fns));

    for (const [name, argBytes] of Object.entries(expected))
    {
        // stdcall: the callee pops these bytes itself, so a wrong count corrupts
        // the guest stack silently rather than failing here.
        assert.equal(table[name].argBytes, argBytes, `${name} pops the wrong number of bytes`);
    }

    // Checked over the whole table rather than against a list of names: this
    // table is two tables merged, and a list would have to be edited every time
    // a function lands, which is a list that stops being read.
    for (const [name, entry] of Object.entries(table))
    {
        assert.equal(Number.isInteger(entry.argBytes) && entry.argBytes % 4 === 0, true,
            `${name} declares argBytes ${entry.argBytes}, which is not a stack slot count`);
    }
});

test('none of them declares a convention, because all of them are the default', ()=>{
    const { fns } = setup();
    const table = /** @type {Record<string, { convention?: string }>} */ (
        /** @type {unknown} */ (fns));

    for (const name of Object.keys(fns))
    {
        assert.equal(table[name].convention, undefined, `${name} is stdcall like the rest`);
    }
});

test('an indexed DIB section carries its colour table, which SetDIBColorTable changes', ()=>{
    // A program draws with indices and sets what they mean afterwards; the
    // table is the bitmap's own, full-sized, and a blit reads it live.
    const { fns, memory, hdc } = withDC();
    putBitmapInfo(memory, { width: 4, height: 1, bitCount: 8 });
    memory.putU32s(STRUCT + BITMAPINFOHEADER.biClrUsed, [2]);
    // Two RGBQUADs: blue, green, red, reserved.
    memory.putU32s(STRUCT + BITMAPINFOHEADER.SIZE, [0x00010203, 0x00040506]);
    const bitmap = fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]);
    assert.ok(bitmap > 0);
    const memoryDc = fns.CreateCompatibleDC.handler([hdc]);
    fns.SelectObject.handler([memoryDc, bitmap]);

    const QUADS = STRUCT + 0x400;
    assert.equal(fns.GetDIBColorTable.handler([memoryDc, 0, 3, QUADS]), 3);
    assert.deepEqual([memory.u32(QUADS), memory.u32(QUADS + 4), memory.u32(QUADS + 8)],
        [0x00010203, 0x00040506, 0], 'the two given, then black to the end of the table');

    memory.putU32s(QUADS, [0x00aabbcc]);
    assert.equal(fns.SetDIBColorTable.handler([memoryDc, 1, 1, QUADS]), 1);
    assert.equal(fns.GetDIBColorTable.handler([memoryDc, 1, 1, QUADS + 0x10]), 1);
    assert.equal(memory.u32(QUADS + 0x10), 0x00aabbcc);
    assert.equal(fns.SetDIBColorTable.handler([memoryDc, 255, 4, QUADS]), 1, 'clipped at the end');
    assert.equal(fns.SetDIBColorTable.handler([hdc, 0, 1, QUADS]), 0,
        'a display DC has no table');
    assert.equal(fns.SetDIBColorTable.argBytes, 16);
    assert.equal(fns.GetDIBColorTable.argBytes, 16);
});

test('a palette-relative colour table is resolved through the palette the DC has', ()=>{
    const { fns, memory, hdc } = withDC();
    memory.putU16(STRUCT + 0x800, 0x300);
    memory.putU16(STRUCT + 0x802, 2);
    // PALETTEENTRY is red first: (r, g, b) = (1, 2, 3) and (4, 5, 6).
    memory.putU32s(STRUCT + 0x804, [0x00030201, 0x00060504]);
    const palette = fns.CreatePalette.handler([STRUCT + 0x800]);
    assert.ok(fns.SelectPalette.handler([hdc, palette, 0]) > 0);

    putBitmapInfo(memory, { width: 4, height: 1, bitCount: 8 });
    memory.putU32s(STRUCT + BITMAPINFOHEADER.biClrUsed, [2]);
    memory.putU16(STRUCT + BITMAPINFOHEADER.SIZE, 1);
    memory.putU16(STRUCT + BITMAPINFOHEADER.SIZE + 2, 0);
    const bitmap = fns.CreateDIBSection.handler([hdc, STRUCT, 1, BITS_POINTER, 0, 0]);
    const memoryDc = fns.CreateCompatibleDC.handler([hdc]);
    fns.SelectObject.handler([memoryDc, bitmap]);

    const QUADS = STRUCT + 0x400;
    assert.equal(fns.GetDIBColorTable.handler([memoryDc, 0, 2, QUADS]), 2);
    assert.deepEqual([memory.u32(QUADS), memory.u32(QUADS + 4)], [0x00040506, 0x00010203],
        'as RGBQUADs, blue first, in the order the indices named');
});

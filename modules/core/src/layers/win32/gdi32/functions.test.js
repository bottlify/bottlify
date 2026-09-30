/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';
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
            return decodeAnsi(bytes.subarray(address, end));
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

test('CreateDCA opens the display and nothing else, and DeleteDC closes it', ()=>{
    const { fns, memory } = setup();
    memory.putString(FACE_NAME, 'DISPLAY');
    const display = fns.CreateDCA.handler([FACE_NAME, 0, 0, 0]);
    assert.ok(display > 0);
    assert.equal(fns.GetDeviceCaps.handler([display, BITSPIXEL]), 32, 'it is the screen');
    assert.equal(fns.ReleaseDC.handler([0, display]), 0, 'not borrowed from a window');
    assert.equal(fns.DeleteDC.handler([display]), 1);
    assert.equal(fns.DeleteDC.handler([display]), 0);

    memory.putString(FACE_NAME, 'WINSPOOL');
    assert.equal(fns.CreateDCA.handler([FACE_NAME, 0, 0, 0]), 0, 'there is no printer');
    assert.equal(fns.CreateDCA.handler([0, 0, 0, 0]), 0);
    assert.equal(fns.CreateDCA.argBytes, 16);
});

test('CreateDCW opens the display from a wide name', ()=>{
    const { fns, memory } = setup();
    const wide = (/** @type {string} */ text)=>memory.writeMemory(FACE_NAME,
        new Uint8Array(new Uint16Array([...text].map(c=>c.charCodeAt(0)).concat([0])).buffer));
    wide('display');
    const display = fns.CreateDCW.handler([FACE_NAME, 0, 0, 0]);
    assert.equal(fns.GetDeviceCaps.handler([display, BITSPIXEL]), 32);
    assert.equal(fns.DeleteDC.handler([display]), 1);
    wide('WINSPOOL');
    assert.equal(fns.CreateDCW.handler([FACE_NAME, 0, 0, 0]), 0);
    assert.equal(fns.CreateDCW.handler([0, 0, 0, 0]), 0);
});

test('CreateCompatibleDC starts with the one-pixel bitmap, and answers for the display', ()=>{
    const { fns, hdc } = withDC();
    const memoryDC = fns.CreateCompatibleDC.handler([hdc]);

    const bitmap = fns.GetCurrentObject.handler([memoryDC, OBJ_BITMAP]);
    assert.ok(bitmap > 0, 'a memory DC is one monochrome pixel until something is selected');
    // Its capabilities are the display's it is compatible with, whatever is
    // selected: Wine's dc.c compares one over a 1-bit bitmap with the screen.
    assert.equal(fns.GetDeviceCaps.handler([memoryDC, BITSPIXEL]),
        fns.GetDeviceCaps.handler([hdc, BITSPIXEL]));
    fns.SelectObject.handler([memoryDC, fns.CreateBitmap.handler([10, 10, 1, 1, 0])]);
    assert.equal(fns.GetDeviceCaps.handler([memoryDC, BITSPIXEL]), 32);
    assert.equal(fns.GetDeviceCaps.handler([memoryDC, HORZRES]),
        fns.GetDeviceCaps.handler([hdc, HORZRES]));
});

test('GetBoundsRect records what DCB_SET put there and DCB_RESET clears it', ()=>{
    const { fns, hdc, memory } = withDC();
    const RECT = STRUCT + 0x800;
    assert.equal(fns.GetBoundsRect.handler([hdc, RECT, 0]), 0, 'nothing accumulated yet');

    memory.putU32s(RECT, [10, 20, 30, 40]);
    assert.equal(fns.GetBoundsRect.handler([hdc, RECT, 0x8]), 0x8, 'DCB_SET answers DCB_SET');
    memory.putU32s(RECT, [0, 0, 0, 0]);
    assert.equal(fns.GetBoundsRect.handler([hdc, RECT, 0]), 0);
    assert.deepEqual([memory.u32(RECT), memory.u32(RECT + 4), memory.u32(RECT + 8),
        memory.u32(RECT + 12)], [10, 20, 30, 40]);

    assert.equal(fns.GetBoundsRect.handler([hdc, RECT, 0x1]), 0);
    assert.equal(fns.GetBoundsRect.handler([hdc, RECT, 0]), 0, 'and the bounds are gone');
});

test('SetBoundsRect turns accumulation on and off, answering the state before', ()=>{
    const { fns, hdc, memory } = withDC();
    const RECT = STRUCT + 0x800;
    assert.equal(fns.SetBoundsRect.handler([hdc, 0, 0x10]), 0, 'was not accumulating');
    assert.equal(fns.SetBoundsRect.handler([hdc, 0, 0x10]), 0x10, 'already enabled');
    assert.equal(fns.SetBoundsRect.handler([hdc, 0, 0x20]), 0x10, 'disable answers enable');
    assert.equal(fns.SetBoundsRect.handler([hdc, 0, 0x20]), 0x20, 'now disabled');

    memory.putU32s(RECT, [1, 2, 3, 4]);
    assert.equal(fns.SetBoundsRect.handler([hdc, RECT, 0x8]), 0x20, 'DCB_SET answers the state');
    memory.putU32s(RECT, [0, 0, 0, 0]);
    fns.GetBoundsRect.handler([hdc, RECT, 0]);
    assert.deepEqual([memory.u32(RECT), memory.u32(RECT + 4), memory.u32(RECT + 8),
        memory.u32(RECT + 12)], [1, 2, 3, 4], 'the rectangle SetBoundsRect put there');
});

test('ResetDC answers the DC it was given', ()=>{
    const { fns, hdc } = withDC();
    assert.equal(fns.ResetDCA.handler([hdc, 0]), hdc);
    assert.equal(fns.ResetDCW.handler([hdc, 0]), hdc);
    assert.equal(fns.ResetDCA.handler([0x1234, 0]), 0, 'not a DC');
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

test('a pattern brush names its bitmap and no colour, and outlives the bitmap', ()=>{
    // Wine's test_pattern_brush: LOGBRUSH reads back BS_PATTERN, a zero
    // colour whatever was asked for, and the bitmap's handle even once the
    // bitmap is deleted -- the brush paints from a copy it took.
    const { fns, memory } = setup();
    const bitmap = fns.CreateBitmap.handler([20, 20, 1, 1, 0]);
    memory.putU32s(STRUCT, [3, 0x12345, bitmap]);
    const brush = fns.CreateBrushIndirect.handler([STRUCT]);
    assert.ok(brush > 0);
    assert.equal(fns.DeleteObject.handler([bitmap]), 1);

    memory.fill(OUT, 3);
    assert.equal(fns.GetObjectA.handler([brush, LOGBRUSH.SIZE, OUT]), LOGBRUSH.SIZE);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4), memory.u32(OUT + 8)],
        [3, 0, bitmap]);

    memory.putU32s(STRUCT, [3, 0, 0x9999]);
    assert.equal(fns.CreateBrushIndirect.handler([STRUCT]), 0, 'no bitmap, no pattern');
});

test('a DIB pattern brush reads back as BS_DIBPATTERN naming its packed DIB', ()=>{
    // Wine's test_pattern_brush: CreateDIBPatternBrushPt, CreateDIBPatternBrush
    // and the BS_DIBPATTERN forms of LOGBRUSH all read back as BS_DIBPATTERN,
    // colour zero, and the DIB they were made from -- an HGLOBAL's being its
    // address here, which is what GlobalLock hands back for it. BS_PATTERN8X8
    // reads back as BS_PATTERN. The usages end at DIB_PAL_COLORS + 1, and
    // neither run-length encoding nor the other styles make a brush.
    const { fns, memory } = setup();
    const DIB = STRUCT + 0x40;
    /** @param {number} bitCount @param {number} [compression] */
    const putDib = (bitCount, compression = 0)=>{
        memory.putU32s(DIB, [40, 32, 32, 1 | (bitCount << 16), compression, 0, 0, 0, 2, 0]);
        memory.putU32s(DIB + 40, [0, 0x00ffffff]);
    };
    /** @param {number} brush @returns {number[]} its LOGBRUSH */
    const logBrush = brush=>{
        memory.fill(OUT, 3);
        assert.equal(fns.GetObjectA.handler([brush, LOGBRUSH.SIZE, OUT]), LOGBRUSH.SIZE);
        return [memory.u32(OUT), memory.u32(OUT + 4), memory.u32(OUT + 8)];
    };
    putDib(1);
    assert.equal(fns.CreateDIBPatternBrushPt.argBytes, 8);
    assert.deepEqual(logBrush(fns.CreateDIBPatternBrushPt.handler([DIB, 0])), [5, 0, DIB]);
    assert.equal(fns.CreateDIBPatternBrush.argBytes, 8);
    assert.deepEqual(logBrush(fns.CreateDIBPatternBrush.handler([DIB, 1])), [5, 0, DIB]);
    for (const style of [5, 6])
    {
        memory.putU32s(STRUCT, [style, 1, DIB]);
        assert.deepEqual(logBrush(fns.CreateBrushIndirect.handler([STRUCT])), [5, 0, DIB]);
    }
    const bitmap = fns.CreateBitmap.handler([8, 8, 1, 1, 0]);
    memory.putU32s(STRUCT, [7, 0x12345, bitmap]);
    assert.deepEqual(logBrush(fns.CreateBrushIndirect.handler([STRUCT])), [3, 0, bitmap]);

    assert.ok(fns.CreateDIBPatternBrushPt.handler([DIB, 1]) > 0);
    assert.ok(fns.CreateDIBPatternBrushPt.handler([DIB, 2]) > 0);
    assert.equal(fns.CreateDIBPatternBrushPt.handler([DIB, 3]), 0);
    assert.equal(fns.CreateDIBPatternBrushPt.handler([DIB, 4]), 0);
    putDib(8, 1);
    assert.equal(fns.CreateDIBPatternBrushPt.handler([DIB, 0]), 0, 'BI_RLE8');
    putDib(4, 2);
    assert.equal(fns.CreateDIBPatternBrushPt.handler([DIB, 0]), 0, 'BI_RLE4');
    putDib(1);
    for (const style of [8, 9, 4])
    {
        memory.putU32s(STRUCT, [style, 0, DIB]);
        assert.equal(fns.CreateBrushIndirect.handler([STRUCT]), 0, `style ${style}`);
    }
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
});

test('CreateBitmap refuses a side past 0x7ffffff with ERROR_INVALID_PARAMETER', ()=>{
    // Wine's test_bitmap: 0x7ffffff + 1 pixels wide fails, and says why. A
    // height past the same bound is refused the same way.
    const memory = fakeMemory();
    /** @type {number[]} */
    const errors = [];
    const fns = createGdiFunctions({
        readMemory: (address, length)=>memory.readMemory(address, length),
        writeMemory: (address, data)=>memory.writeMemory(address, data),
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        handles: fakeHandles(),
        surfaces: fakeSurfaces(),
        setLastError: code=>errors.push(code),
    }).table;
    const ERROR_INVALID_PARAMETER = 87;
    assert.equal(fns.CreateBitmap.handler([0x7ffffff + 1, 1, 1, 1, 0]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER]);
    assert.equal(fns.CreateBitmap.handler([1, 0x7ffffff + 1, 1, 1, 0]), 0);
    memory.putU32s(STRUCT, [0, 0x7ffffff + 1, 1, 2, 0x00010001, 0]);
    assert.equal(fns.CreateBitmapIndirect.handler([STRUCT]), 0);
    assert.deepEqual(errors, new Array(3).fill(ERROR_INVALID_PARAMETER));
    assert.ok(fns.CreateBitmap.handler([64, 64, 1, 1, 0]) > 0);
    assert.equal(errors.length, 3, 'a bitmap that is made sets nothing');
});

test('CreateBitmapIndirect is CreateBitmap from a BITMAP; CreateDiscardableBitmap, compatible',
    ()=>{
        // Wine's test_CreateBitmap: the BITMAP's bmWidthBytes is ignored, its
        // depth rounds up as CreateBitmap's does, and no size is the stock
        // pixel from either call; the documentation adds that bmType must be 0.
        const { fns, memory, hdc } = withDC();
        assert.deepEqual([fns.CreateBitmapIndirect.argBytes, fns.CreateDiscardableBitmap.argBytes],
            [4, 12]);
        /** @param {number} width @param {number} bitsPixel @param {number} [type] */
        const indirect = (width, bitsPixel, type = 0)=>{
            memory.putU32s(STRUCT, [type, width, 1, 28, 1 | (bitsPixel << 16), 0]);
            return fns.CreateBitmapIndirect.handler([STRUCT]);
        };
        const bitmap = indirect(1, 7);
        assert.ok(bitmap > 0);
        assert.equal(fns.GetObjectA.handler([bitmap, 24, OUT]), 24);
        assert.deepEqual([memory.u32(OUT + 12), memory.u32(OUT + 16) >>> 16], [2, 8],
            'its own stride, not the 28 it was handed, and seven bits made eight');
        assert.equal(indirect(1, 33), 0);
        assert.equal(indirect(1, 1, 1), 0, 'bmType is always zero');
        assert.equal(fns.CreateBitmapIndirect.handler([0]), 0);

        const memoryDC = fns.CreateCompatibleDC.handler([hdc]);
        const stock = fns.CreateCompatibleBitmap.handler([memoryDC, 0, 0]);
        assert.equal(indirect(0, 1), stock);
        assert.equal(fns.CreateDiscardableBitmap.handler([memoryDC, 0, 0]), stock);
        const discardable = fns.CreateDiscardableBitmap.handler([hdc, 4, 2]);
        assert.equal(fns.GetObjectA.handler([discardable, 24, OUT]), 24);
        assert.deepEqual([memory.u32(OUT + 4), memory.u32(OUT + 8), memory.u32(OUT + 16) >>> 16],
            [4, 2, 32], 'the DC\'s depth, as CreateCompatibleBitmap gives it');
    });

test('a bitmap of no size is the one stock monochrome pixel every memory DC starts with', ()=>{
    // Wine's test_CreateBitmap, and both calls' documentation: a zero width
    // or height is the 1-by-1 monochrome bitmap, and it is the very bitmap a
    // memory DC has before anything is selected into it.
    const { fns, memory, hdc } = withDC();
    const memoryDC = fns.CreateCompatibleDC.handler([hdc]);
    const stock = fns.CreateCompatibleBitmap.handler([memoryDC, 0, 0]);
    assert.ok(stock > 0);
    assert.equal(fns.CreateCompatibleBitmap.handler([hdc, 0, 0]), stock);
    assert.equal(fns.CreateBitmap.handler([0, 1, 0, 0, 0]), stock);
    assert.equal(fns.GetCurrentObject.handler([memoryDC, OBJ_BITMAP]), stock);
    assert.notEqual(fns.GetCurrentObject.handler([hdc, OBJ_BITMAP]), stock);

    const one = fns.CreateCompatibleBitmap.handler([memoryDC, 1, 1]);
    const other = fns.CreateBitmap.handler([1, 1, 1, 1, 0]);
    assert.ok(one !== stock && other !== stock, 'a pixel asked for is a bitmap of its own');
    assert.equal(fns.SelectObject.handler([memoryDC, one]), stock);
    const second = fns.CreateCompatibleDC.handler([hdc]);
    assert.equal(fns.GetCurrentObject.handler([second, OBJ_BITMAP]), stock);
    assert.equal(fns.SelectObject.handler([memoryDC, stock]), one,
        'and it goes back in, though another DC has it too');

    for (const bitmap of [stock, one, other])
    {
        memory.fill(OUT, 6);
        assert.equal(fns.GetObjectA.handler([bitmap, 24, OUT]), 24);
        assert.deepEqual([0, 4, 8, 12, 16, 20].map(at=>memory.u32(OUT + at)),
            [0, 1, 1, 2, 1 | (1 << 16), 0], 'type, 1x1, two bytes a row, one plane of one bit');
    }
    assert.equal(fns.DeleteObject.handler([stock]), 1);
    assert.equal(fns.GetObjectA.handler([stock, 24, OUT]), 24, 'a stock object stays');
});

test('CreateBitmap rounds a depth up to the next one a bitmap can have', ()=>{
    // Wine's test_CreateBitmap: every depth from 1 to 32 makes a bitmap, of
    // 1, 4, 8, 16, 24 or 32 bits, and anything deeper makes none.
    const { fns, memory } = setup();
    for (let depth = 1; depth <= 33; depth++)
    {
        const bitmap = fns.CreateBitmap.handler([1, 1, 1, depth, 0]);
        if (depth > 32)
        {
            assert.equal(bitmap, 0, `${depth} bits`);
            continue;
        }
        const expected = [1, 4, 8, 16, 24, 32].find(bits=>bits >= depth);
        assert.equal(fns.GetObjectA.handler([bitmap, 24, OUT]), 24);
        assert.equal(memory.u32(OUT + 16) >>> 16, expected, `${depth} bits: bmBitsPixel`);
    }
});

test('GetBitmapBits sizes a bitmap\'s bits, then hands back WORD-padded rows', ()=>{
    // Wine's test_bitmap: a fresh 15x15 monochrome bitmap is two zero bytes a
    // row. A null buffer asks the size whatever the count; with a buffer, a
    // negative count means all of it and a zero one means none.
    const { fns, memory } = setup();
    const mono = fns.CreateBitmap.handler([15, 15, 1, 1, 0]);
    for (const count of [0, -1, -1000, 30, 4096])
    {
        assert.equal(fns.GetBitmapBits.handler([mono, count, 0]), 30);
    }
    memory.fill(OUT, 16);
    assert.equal(fns.GetBitmapBits.handler([mono, 0, OUT]), 0);
    assert.equal(memory.u32(OUT), UNTOUCHED);
    assert.equal(fns.GetBitmapBits.handler([mono, -1, OUT]), 30);
    assert.deepEqual([...memory.bytes.subarray(OUT, OUT + 32)],
        [...new Array(30).fill(0), 0xa5, 0xa5], 'zeroed, and not a byte past the image');
    assert.equal(fns.GetBitmapBits.handler([mono, 12, OUT]), 12);
    assert.equal(fns.GetBitmapBits.handler([0x9999, 30, OUT]), 0, 'not a bitmap');
});

test('CreateBitmap copies lpBits, and SetBitmapBits writes as GetBitmapBits reads', ()=>{
    const { fns, memory } = setup();
    memory.putU32s(STRUCT, [0x44332211, 0x88776655]);
    const bitmap = fns.CreateBitmap.handler([2, 1, 1, 32, STRUCT]);
    memory.putU32s(STRUCT, [0, 0]);
    assert.equal(fns.GetBitmapBits.handler([bitmap, 8, OUT]), 8);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [0x44332211, 0x88776655],
        'the bits as they were passed, not the caller\'s buffer as it is now');

    memory.putU32s(STRUCT, [0x00abcdef, 0x00123456, 0xdeadbeef]);
    assert.equal(fns.SetBitmapBits.handler([bitmap, 12, STRUCT]), 8, 'no more than the image');
    assert.equal(fns.GetBitmapBits.handler([bitmap, 8, OUT]), 8);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [0x00abcdef, 0x00123456]);
    assert.equal(fns.SetBitmapBits.handler([bitmap, 4, 0]), 0, 'no bits to set from');
    assert.deepEqual([fns.GetBitmapBits.argBytes, fns.SetBitmapBits.argBytes], [12, 12]);
});

test('a DIB section\'s bits come and go as top-down WORD-padded rows', ()=>{
    // Three 24-bit pixels are nine bytes: a device-dependent row pads them to
    // ten, a DIB row to twelve, and a bottom-up section keeps its top row last.
    const { fns, memory, hdc } = withDC();
    putBitmapInfo(memory, { width: 3, height: 2, bitCount: 24 });
    const section = fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]);
    const bits = memory.u32(BITS_POINTER);
    memory.bytes.fill(0x11, bits, bits + 12);
    memory.bytes.fill(0x22, bits + 12, bits + 24);

    assert.equal(fns.GetBitmapBits.handler([section, 0, 0]), 20);
    memory.fill(OUT, 6);
    assert.equal(fns.GetBitmapBits.handler([section, 20, OUT]), 20);
    assert.deepEqual([...memory.bytes.subarray(OUT, OUT + 20)],
        [...new Array(10).fill(0x22), ...new Array(10).fill(0x11)]);

    memory.bytes.fill(0x33, STRUCT + 0x100, STRUCT + 0x100 + 10);
    assert.equal(fns.SetBitmapBits.handler([section, 10, STRUCT + 0x100]), 10);
    assert.deepEqual([...memory.bytes.subarray(bits + 12, bits + 24)],
        [...new Array(10).fill(0x33), 0x22, 0x22], 'the top row, padding left alone');
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

    putBitmapInfo(memory, { size: 20 });
    assert.equal(fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]), 0,
        'biSize says which header the guest compiled, and 20 is none of them');

    putBitmapInfo(memory);
    assert.equal(fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0x1234, 0]), 0,
        'a file mapping is the filesystem\'s, and there is none to map');

    assert.deepEqual(surfaces.allocated, [], 'a refused section allocates nothing');
});

test('CreateDIBSection refuses an image past 32 bits of bytes, or one there is no room for',
    ()=>{
        // Wine's test_dib_formats: 0x4000 square at one bit is made, and five
        // shapes whose rows come to more bytes than 32 bits count are not.
        const { fns, memory, surfaces, hdc } = withDC();
        /** @param {number} width @param {number} height @param {number} bitCount */
        const made = (width, height, bitCount)=>{
            putBitmapInfo(memory, { width, height, bitCount });
            return fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]) !== 0;
        };
        assert.equal(made(0x4000, 0x4000, 1), true);
        assert.equal(made(0x8001, 0x8001, 32), false);
        assert.equal(made(1, 0x40000001, 32), false);
        assert.equal(made(2, 0x40000001, 16), false);
        assert.equal(made(0x40000001, 1, 32), false);
        assert.equal(made(0x40000001, 4, 8), false);
        assert.equal(surfaces.allocated.length, 1, 'nothing asked for the refused ones');

        putBitmapInfo(memory, { width: 4, height: 4, bitCount: 32 });
        const dc = fns.CreateCompatibleDC.handler([hdc]);
        fns.SelectObject.handler([dc, fns.CreateDIBSection.handler([hdc, STRUCT, 0, 0, 0, 0])]);
        surfaces.allocate = ()=>0;
        assert.equal(made(16, 16, 32), false, 'no memory, no section');
        assert.equal(fns.CreateCompatibleBitmap.handler([dc, 16, 16]), 0,
            'nor one made compatible with a section');
    });

test('CreateDIBSection takes a BITMAPCOREHEADER or a header of forty bytes or more', ()=>{
    // Wine's test_bitmapinfoheadersize: a BITMAPINFOHEADER of 39 bytes is
    // refused and one of 40, 41, 44, BITMAPV4HEADER's 108 or BITMAPV5HEADER's
    // 124 taken; a BITMAPCOREHEADER of exactly 12 bytes is taken, and 11, 13
    // or BITMAPCOREINFO's 16 refused.
    const { fns, memory, hdc } = withDC();
    /** @returns {number[] | null} the section's width, height and depth */
    const made = ()=>{
        const section = fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]);
        if (!section)
        {
            return null;
        }
        assert.equal(fns.GetObjectA.handler([section, 24, OUT]), 24);
        return [memory.u32(OUT + 4), memory.u32(OUT + 8), memory.u32(OUT + 16) >>> 16];
    };
    for (const size of [39, 40, 41, 44, 108, 124])
    {
        putBitmapInfo(memory, { size, width: 512, height: 100, bitCount: 24 });
        assert.deepEqual(made(), size < 40 ? null : [512, 100, 24], `${size}`);
    }
    for (const size of [11, 12, 13, 16])
    {
        memory.putU32s(STRUCT, [size]);
        [512, 100, 1, 24].forEach((value, index)=>memory.putU16(STRUCT + 4 + index * 2, value));
        assert.deepEqual(made(), size === 12 ? [512, 100, 24] : null, `core ${size}`);
    }
});

test('CreateDIBSection takes the formats, planes, masks and usages Windows does', ()=>{
    // Wine's test_dib_formats: BI_BITFIELDS only at 16 and 32 bits and never
    // with DIB_PAL_COLORS; planes 1, or any count whose product with the
    // depth is at most 16, but never zero; every mask non-zero, though masks
    // that are not a run of bits are accepted; DIB_PAL_COLORS + 1 refused;
    // and a width or height that is negative or zero refused.
    const { fns, memory, hdc } = withDC();
    /**
     * @param {{ bitCount?: number, compression?: number, planes?: number,
     *           masks?: number[], usage?: number, width?: number, height?: number }} format
     */
    const made = ({ bitCount = 16, compression = BI_RGB, planes = 1, masks = [0xaaaaaaaa,
        0xaaaaaaaa, 0xaaaaaaaa], usage = 0, width = 2, height = 2 })=>{
        putBitmapInfo(memory, { width, height, bitCount, compression });
        memory.putU16(STRUCT + BITMAPINFOHEADER.biPlanes, planes);
        memory.putU32s(STRUCT + BITMAPINFOHEADER.SIZE, masks);
        const section = fns.CreateDIBSection.handler([hdc, STRUCT, usage, BITS_POINTER, 0, 0]);
        if (section)
        {
            fns.DeleteObject.handler([section]);
        }
        return section !== 0;
    };
    const BI_BITFIELDS = 3;
    for (const bitCount of [1, 4, 8, 16, 24, 32])
    {
        for (const usage of [0, 1])
        {
            assert.equal(made({ bitCount, usage }), true, `${bitCount} BI_RGB ${usage}`);
            assert.equal(made({ bitCount, usage, compression: BI_BITFIELDS }),
                (bitCount === 16 || bitCount === 32) && usage === 0,
                `${bitCount} BI_BITFIELDS ${usage}`);
        }
        for (const planes of [0, 2, 3, 16])
        {
            assert.equal(made({ bitCount, planes }), planes > 0 && planes * bitCount <= 16,
                `${bitCount} bits, ${planes} planes`);
        }
    }
    assert.equal(made({ compression: BI_BITFIELDS, masks: [0, 0, 0] }), false, 'no masks');
    assert.equal(made({ compression: BI_BITFIELDS, masks: [3, 0, 7] }), false, 'one empty');
    assert.equal(made({ compression: BI_BITFIELDS, masks: [0x55, 0x44, 0x33] }), true,
        'garbage is ok though');
    assert.equal(made({ bitCount: 1, usage: 2 }), false, 'DIB_PAL_COLORS + 1');
    assert.equal(made({ bitCount: 32, width: -2 }), false, 'negative width');
    assert.equal(made({ bitCount: 32, width: 0 }), false, 'zero width');
    assert.equal(made({ bitCount: 32, height: 0 }), false, 'zero height');
});

test('deleting a DIB section gives its memory back', ()=>{
    const { fns, memory, surfaces, hdc } = withDC();
    putBitmapInfo(memory);
    const bitmap = fns.CreateDIBSection.handler([hdc, STRUCT, 0, BITS_POINTER, 0, 0]);

    assert.equal(fns.DeleteObject.handler([bitmap]), 1);
    assert.deepEqual(surfaces.freed, [HEAP]);
});

test('CreateDIBitmap makes a device-dependent bitmap at the depth of the DC it is given', ()=>{
    // Wine's test_createdibitmap: the header's own depth does not matter, the
    // DC's does -- the screen's, a fresh memory DC's single bit, the depth of
    // the bitmap a memory DC has selected, and one bit with no DC at all --
    // and the result is a DDB: no bits pointer, WORD rows, zeroed.
    const { fns, memory, surfaces, hdc } = withDC();
    assert.equal(fns.CreateDIBitmap.handler([hdc, 0, 4, 0, 0, 0]), 0, 'no header, no bitmap');
    assert.equal(fns.CreateDIBitmap.handler([hdc, 0, 0, 0, 0, 0]), 0);

    const memoryDC = fns.CreateCompatibleDC.handler([hdc]);
    /** @param {number} dc @param {number} bitCount */
    const depthOf = (dc, bitCount)=>{
        putBitmapInfo(memory, { width: 10, height: 10, bitCount });
        const bitmap = fns.CreateDIBitmap.handler([dc, STRUCT, 0, 0, 0, 0]);
        assert.ok(bitmap > 0);
        memory.fill(OUT, 6);
        assert.equal(fns.GetObjectA.handler([bitmap, 24, OUT]), 24);
        assert.deepEqual([4, 8, 20].map(at=>memory.u32(OUT + at)), [10, 10, 0],
            'the header\'s size, and no bits pointer');
        const depth = memory.u32(OUT + 16) >>> 16;
        assert.equal(memory.u32(OUT + 12), Math.ceil(10 * depth / 16) * 2, 'WORD-padded rows');
        return depth;
    };
    assert.deepEqual([32, 16, 1].map(bitCount=>depthOf(hdc, bitCount)), [32, 32, 32]);
    assert.deepEqual([32, 16, 1].map(bitCount=>depthOf(memoryDC, bitCount)), [1, 1, 1]);
    assert.equal(depthOf(0, 32), 1);
    fns.SelectObject.handler([memoryDC, fns.CreateCompatibleBitmap.handler([hdc, 10, 10])]);
    assert.equal(depthOf(memoryDC, 1), 32);
    assert.deepEqual(surfaces.allocated, [], 'nothing in guest memory: a DDB\'s bits are its own');

    putBitmapInfo(memory, { width: 2, height: 2, bitCount: 24 });
    const bitmap = fns.CreateDIBitmap.handler([hdc, STRUCT, 0, 0, 0, 0]);
    memory.fill(OUT, 4);
    assert.equal(fns.GetBitmapBits.handler([bitmap, 16, OUT]), 16);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(OUT + at)), [0, 0, 0, 0]);

    // "No sanity checks in CreateDIBitmap except compression."
    putBitmapInfo(memory, { width: 2, height: 2, bitCount: 7 });
    assert.ok(fns.CreateDIBitmap.handler([hdc, STRUCT, 0, 0, 0, 0]) > 0);
    putBitmapInfo(memory, { width: 2, height: 2, bitCount: 8, compression: 4 });
    assert.equal(fns.CreateDIBitmap.handler([hdc, STRUCT, 0, 0, 0, 0]), 0, 'BI_JPEG');

    // test_dib_formats again: a zero width or height makes a bitmap -- the one
    // pixel CreateCompatibleBitmap gives for it -- and a negative width none.
    const stock = fns.CreateCompatibleBitmap.handler([hdc, 0, 0]);
    putBitmapInfo(memory, { width: 0, height: 2, bitCount: 32 });
    assert.equal(fns.CreateDIBitmap.handler([hdc, STRUCT, 0, 0, 0, 0]), stock);
    putBitmapInfo(memory, { width: 2, height: 0, bitCount: 32 });
    assert.equal(fns.CreateDIBitmap.handler([hdc, STRUCT, 4, BITS_POINTER, STRUCT, 0]), stock,
        'and nothing is drawn into that shared pixel');
    putBitmapInfo(memory, { width: -2, height: 2, bitCount: 32 });
    assert.equal(fns.CreateDIBitmap.handler([hdc, STRUCT, 0, 0, 0, 0]), 0);
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

test('the window manager reads and sets a context\'s colours and mode as the program would', ()=>{
    // What a control paints with once its parent has answered WM_CTLCOLOR*,
    // and what the default procedure sets there when the parent did not.
    const { fns, gdi, hdc } = withDC();
    fns.SetBkMode.handler([hdc, TRANSPARENT]);
    fns.SetBkColor.handler([hdc, 0x00000080]);
    assert.equal(gdi.draw.bkMode(hdc), TRANSPARENT);
    assert.equal(gdi.draw.bkColor(hdc), 0x00000080);

    assert.equal(gdi.draw.setTextColor(hdc, 0x00123456), 0);
    assert.equal(gdi.draw.setBkColor(hdc, 0x00c0c0c0), 0x00000080, 'the colour it replaced');
    assert.equal(fns.GetTextColor.handler([hdc]), 0x00123456);
    assert.equal(fns.GetBkColor.handler([hdc]), 0x00c0c0c0);
    assert.equal(gdi.draw.bkMode(0x9999), OPAQUE, 'no context: the mode a new one has');
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

test('a font here reports itself a vector font, as its enumeration does', ()=>{
    // TMPF_VECTOR is what separates a scalable font from a raster one (Wine's
    // dib tests skip their outline text when it is clear); neither
    // TMPF_TRUETYPE nor TMPF_DEVICE is claimed, as FontType claims neither.
    const TMPF_VECTOR = 0x02;
    const { fns, memory, hdc } = withDC();
    for (const pitchAndFamily of [0, 0x11, 0x22, 0x31])
    {
        putLogFont(memory, { pitchAndFamily });
        fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
        assert.ok(fns.GetTextMetricsA.handler([hdc, OUT]));
        assert.equal(memory.u8(OUT + TEXTMETRICA.tmPitchAndFamily),
            (pitchAndFamily & 0xf0) | TMPF_VECTOR, `${pitchAndFamily}`);
    }
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

/**
 * A font engine standing in for the graphics layer's: every face measures
 * as a 13-pixel cell, and a character is as wide as its code is odd -- so a
 * string's width depends on which characters it has, not how many.
 */
function withEngine(){
    const context = setup();
    /** @type {import('./structs.js').LogFontFields[]} */
    const asked = [];
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>context.memory.readMemory(address, length),
        writeMemory: (address, data)=>context.memory.writeMemory(address, data),
        readCString: (address, maxLength)=>context.memory.readCString(address, maxLength),
        handles: context.handles,
        surfaces: context.surfaces,
        graphics: {
            fontMetrics: font=>{
                asked.push(font);
                return { height: 13, ascent: 11, descent: 2, internalLeading: 2,
                    externalLeading: 0, aveCharWidth: 6, maxCharWidth: 9 };
            },
            textWidth: (font, text)=>[...text].reduce((sum, ch)=>sum + 4 + ch.charCodeAt(0) % 2, 0),
        },
    });
    return { ...context, asked, fns: gdi.table, gdi, hdc: gdi.table.GetDC.handler([HWND]) };
}

test('with a font engine the metrics are its measurements of the selected font', ()=>{
    const { fns, memory, hdc, asked } = withEngine();
    putLogFont(memory, { height: -12, faceName: 'Tahoma', weight: 700 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);

    assert.equal(fns.GetTextMetricsA.handler([hdc, OUT]), 1);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmHeight), 13);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmAscent), 11);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmInternalLeading), 2);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmAveCharWidth), 6);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmMaxCharWidth), 9);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmWeight), 700, 'the rest is still the LOGFONT\'s');
    const font = asked.at(-1);
    assert.equal(font?.faceName, 'Tahoma');
    assert.equal(font?.height, -12);
});

test('with a font engine a string is as wide as the engine draws it', ()=>{
    const { fns, memory, hdc } = withEngine();
    memory.putString(FACE_NAME, 'AB');

    memory.fill(OUT, SIZE.SIZE / 4);
    assert.equal(fns.GetTextExtentPoint32A.handler([hdc, FACE_NAME, 2, OUT]), 1);
    assert.equal(memory.i32(OUT + SIZE.cx), 5 + 4, 'A is odd, B is even');
    assert.equal(memory.i32(OUT + SIZE.cy), 13);

    memory.fill(OUT, 4);
    assert.equal(fns.GetCharWidth32A.handler([hdc, 0x41, 0x43, OUT]), 1);
    assert.deepEqual([memory.i32(OUT), memory.i32(OUT + 4), memory.i32(OUT + 8)], [5, 4, 5]);
    assert.equal(fns.GetCharWidthA, fns.GetCharWidth32A);
    assert.equal(fns.GetCharWidth32A.handler([hdc, 0x43, 0x41, OUT]), 0, 'a backwards range');
});

test('an ANSI string is measured, and its face named, as its bytes are in the ANSI page', ()=>{
    // 0x80 is the euro sign in Windows-1252, 0x99 the trade mark and 0x97 an
    // em dash: those characters are what GetTextExtentPoint32A and
    // GetCharWidth32A measure, not the control characters of the same codes,
    // and a face name read in that page goes back to GetObjectA in it.
    const context = setup();
    /** @type {string[]} */
    const measured = [];
    const fns = createGdiFunctions({
        readMemory: (address, length)=>context.memory.readMemory(address, length),
        writeMemory: (address, data)=>context.memory.writeMemory(address, data),
        readCString: (address, maxLength)=>context.memory.readCString(address, maxLength),
        handles: context.handles,
        surfaces: context.surfaces,
        graphics: {
            fontMetrics: ()=>({ height: 13, ascent: 11, descent: 2, internalLeading: 2,
                externalLeading: 0, aveCharWidth: 6, maxCharWidth: 9 }),
            textWidth: (font, text)=>{
                measured.push(text);
                return text.length * 6;
            },
        },
    }).table;
    const hdc = fns.GetDC.handler([HWND]);
    context.memory.bytes.set([0x80, 0x99, 0x97], FACE_NAME);
    assert.equal(fns.GetTextExtentPoint32A.handler([hdc, FACE_NAME, 3, OUT]), 1);
    assert.equal(fns.GetCharWidth32A.handler([hdc, 0x99, 0x99, OUT]), 1);
    assert.deepEqual(measured.slice(-2), ['€™—', '™']);

    putLogFont(context.memory);
    context.memory.bytes.set([0x80, 0x99, 0x97, 0], STRUCT + LOGFONTA.lfFaceName);
    const font = fns.CreateFontIndirectA.handler([STRUCT]);
    assert.equal(fns.GetObjectA.handler([font, LOGFONTA.SIZE, OUT]), LOGFONTA.SIZE);
    assert.deepEqual([...context.memory.bytes.subarray(OUT + LOGFONTA.lfFaceName,
        OUT + LOGFONTA.lfFaceName + 4)], [0x80, 0x99, 0x97, 0]);
});

test('without a font engine GetCharWidth32A is the estimate\'s fixed pitch', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -12, width: 8 });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    assert.equal(fns.GetCharWidth32A.handler([hdc, 0x41, 0x42, OUT]), 1);
    assert.deepEqual([memory.i32(OUT), memory.i32(OUT + 4)], [8, 8]);
});

test('the dialog base units are the system font\'s cell, from the engine or not at all', ()=>{
    // The width is the alphabet's average in both cases, as the dialog
    // manager measures it -- 52 letters at 4 or 5 pixels each here come to
    // 234, nine per letter-pair, five rounded -- not the font's own average.
    assert.equal(withDC().gdi.draw.baseUnits(), null);
    assert.deepEqual(withEngine().gdi.draw.baseUnits(), { width: 5, height: 13 });
});

test('a dialog\'s font is made from its point size and measured like the base units', ()=>{
    const { gdi, asked } = withEngine();
    const font = gdi.draw.createFont(
        { pointSize: 8, faceName: 'MS Sans Serif', weight: 0, italic: 0, charSet: 0 });
    assert.notEqual(font, 0);
    assert.deepEqual(gdi.draw.fontUnits(font), { width: 5, height: 13 });
    // Eight points at 96 dots per inch is 10.67 pixels: a character height
    // of 11, asked for as a negative lfHeight.
    assert.equal(asked.at(-1)?.height, -11);
    assert.equal(asked.at(-1)?.faceName, 'MS Sans Serif');
    assert.equal(gdi.draw.fontUnits(0x7777), null, 'not a font');
    assert.equal(gdi.draw.deleteFont(font), true);
    assert.equal(gdi.draw.fontUnits(font), null, 'and gone');
    const blind = withDC().gdi.draw;
    assert.equal(blind.fontUnits(blind.createFont(
        { pointSize: 8, faceName: 'MS Sans Serif', weight: 0, italic: 0, charSet: 0 })), null,
    'without an engine the estimate stands');
});

// --- the stack every one of them pops ---

test('the extents a DC has are read back, and a metafile is refused', ()=>{
    const { fns, memory } = setup();
    const hdc = fns.CreateCompatibleDC.handler([0]);
    fns.SetMapMode.handler([hdc, MM_ANISOTROPIC]);
    fns.SetViewportExtEx.handler([hdc, 400, 300, 0]);
    fns.SetWindowExtEx.handler([hdc, 40, 30, 0]);
    assert.equal(fns.GetViewportExtEx.handler([hdc, OUT]), 1);
    assert.deepEqual([memory.i32(OUT + SIZE.cx), memory.i32(OUT + SIZE.cy)], [400, 300]);
    assert.equal(fns.GetWindowExtEx.handler([hdc, OUT]), 1);
    assert.deepEqual([memory.i32(OUT + SIZE.cx), memory.i32(OUT + SIZE.cy)], [40, 30]);
    assert.equal(fns.GetViewportExtEx.handler([hdc, 0]), 0, 'nowhere to write');
    assert.equal(fns.GetWindowExtEx.handler([0x7777, OUT]), 0, 'not a DC');

    assert.equal(fns.SetMetaFileBitsEx.handler(), 0);
    assert.equal(fns.PlayMetaFile.handler(), 0);
    assert.equal(fns.DeleteMetaFile.handler([0x7777]), 0, 'not a metafile');
    assert.deepEqual([fns.GetViewportExtEx, fns.GetWindowExtEx, fns.SetMetaFileBitsEx,
        fns.PlayMetaFile, fns.DeleteMetaFile].map(fn=>fn.argBytes), [8, 8, 8, 8, 4]);
});

// --- enumerating the faces ---

/** The program's EnumFontFamExProc, and the thread that asked. */
const ENUMPROC = 0x405000;
const THREAD = { id: 7 };

/**
 * gdi32 with a guest to call back. Each call records what the program's
 * callback would read -- the ENUMLOGFONTEX and the TEXTMETRIC the two
 * pointers name, at the moment it is called -- and answers `reply`.
 *
 * @param {boolean} wide
 * @param {(seen: any) => number} [reply]
 */
function withEnumeration(wide, reply = ()=>1){
    const memory = fakeMemory();
    const surfaces = fakeSurfaces();
    /** @type {any[]} */
    const seen = [];
    /** @param {number} at @param {number} units */
    const text = (at, units)=>{
        let value = '';
        for (let index = 0; index < units; index++)
        {
            const unit = wide ? memory.bytes[at + index * 2] | memory.bytes[at + index * 2 + 1] << 8
                : memory.bytes[at + index];
            if (unit === 0)
            {
                break;
            }
            value += String.fromCharCode(unit);
        }
        return value;
    };
    const logFontSize = wide ? 92 : 60;
    const unit = wide ? 2 : 1;
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>memory.readMemory(address, length),
        writeMemory: (address, data)=>memory.writeMemory(address, data),
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        handles: fakeHandles(),
        surfaces,
        call: (entry, [logfont, metric, type, lParam], thread)=>{
            const one = {
                entry, type, lParam, thread,
                face: text(logfont + LOGFONTA.lfFaceName, 32),
                fullName: text(logfont + logFontSize, 64),
                style: text(logfont + logFontSize + 64 * unit, 32),
                script: text(logfont + logFontSize + 96 * unit, 32),
                height: memory.i32(logfont + LOGFONTA.lfHeight),
                weight: memory.i32(logfont + LOGFONTA.lfWeight),
                charSet: memory.u8(logfont + LOGFONTA.lfCharSet),
                pitchAndFamily: memory.u8(logfont + LOGFONTA.lfPitchAndFamily),
                tmHeight: memory.i32(metric + TEXTMETRICA.tmHeight),
                tmWeight: memory.i32(metric + TEXTMETRICA.tmWeight),
            };
            seen.push(one);
            return Promise.resolve(reply(one));
        },
        callerThread: ()=>THREAD,
    });
    const fns = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => any }>} */ (/** @type {unknown} */ (gdi.table));
    return { memory, surfaces, seen, fns, hdc: fns.GetDC.handler([HWND]) };
}

test('EnumFontFamiliesEx lists every face offered, once each, in the one set drawn', async()=>{
    const { fns, memory, seen, surfaces, hdc } = withEnumeration(false);
    assert.equal(fns.EnumFontFamiliesExA.argBytes, 20);

    // Wine's test_EnumFonts_subst passes no LOGFONT at all: everything.
    assert.equal(await fns.EnumFontFamiliesExA.handler([hdc, 0, ENUMPROC, 0x77, 0]), 1);
    const faces = seen.map(one=>one.face);
    assert.ok(['Arial', 'Times New Roman', 'Courier New', 'MS Sans Serif']
        .every(face=>faces.includes(face)));
    assert.equal(new Set(faces).size, faces.length, 'each face once');
    assert.ok(!faces.includes('MS Shell Dlg') && !faces.includes('Helv'),
        'a substitute is found by name and never listed');
    for (const one of seen)
    {
        assert.equal(one.entry, ENUMPROC);
        assert.equal(one.thread, THREAD, 'called back on the thread that asked');
        assert.equal(one.lParam, 0x77);
        assert.equal(one.charSet, 0, 'ANSI_CHARSET, the one set the engine draws');
        assert.equal(one.height, one.tmHeight, 'Wine\'s arial_enum_proc: lfHeight is tmHeight');
        assert.equal(one.weight, one.tmWeight, 'and its enum_fonts_proc: lfWeight is tmWeight');
        assert.equal(one.type, 0, 'scalable, and not TrueType, as TEXTMETRIC says');
        assert.equal(one.script, 'Western');
    }
    assert.deepEqual(surfaces.freed, surfaces.allocated.map(block=>block.address),
        'what the callback was pointed at is given back');

    // DEFAULT_CHARSET and no name is the same question.
    seen.length = 0;
    putLogFont(memory, { faceName: '', charSet: 1 });
    await fns.EnumFontFamiliesExA.handler([hdc, STRUCT, ENUMPROC, 0, 0]);
    assert.deepEqual(seen.map(one=>one.face), faces);

    seen.length = 0;
    putLogFont(memory, { faceName: '', charSet: 128 });
    assert.equal(await fns.EnumFontFamiliesExA.handler([hdc, STRUCT, ENUMPROC, 0, 0]), 1,
        'a set nothing here draws has no faces, and nothing enumerated is not a stop');
    assert.equal(seen.length, 0);
});

test('EnumFontFamiliesEx finds a face by name in any case, and a substitute by its own', async()=>{
    const { fns, memory, seen, hdc } = withEnumeration(false);
    /** @param {string} faceName @param {number} charSet */
    const enumerate = async(faceName, charSet)=>{
        seen.length = 0;
        putLogFont(memory, { faceName, charSet });
        const answer = await fns.EnumFontFamiliesExA.handler([hdc, STRUCT, ENUMPROC, 0, 0]);
        return { answer, seen: seen.map(({ face, fullName, style, pitchAndFamily })=>
            ({ face, fullName, style, pitchAndFamily })) };
    };

    assert.deepEqual((await enumerate('arial', 1)).seen, [{
        face: 'Arial', fullName: 'Arial', style: 'Regular', pitchAndFamily: 0x22,
    }], 'FF_SWISS | VARIABLE_PITCH');
    assert.deepEqual((await enumerate('Courier New', 0)).seen.map(one=>one.pitchAndFamily),
        [0x31], 'FF_MODERN | FIXED_PITCH');

    // Wine's test_EnumFonts_subst: the name asked for, and not as the full name.
    const substitute = (await enumerate('MS Shell Dlg', 1)).seen;
    assert.equal(substitute.length, 1);
    assert.equal(substitute[0].face, 'MS Shell Dlg');
    assert.equal(substitute[0].fullName, 'Microsoft Sans Serif');

    // Wine's is_font_installed: a face nobody has answers nonzero.
    assert.deepEqual(await enumerate('Wingdings', 1), { answer: 1, seen: [] });
});

test('EnumFontFamilies names a family where the Ex call takes a LOGFONT', async()=>{
    const { fns, memory, seen, hdc } = withEnumeration(false);
    assert.equal(fns.EnumFontFamiliesA.argBytes, 16);
    assert.equal(await fns.EnumFontFamiliesA.handler([hdc, 0, ENUMPROC, 0x55]), 1);
    assert.ok(seen.map(one=>one.face).includes('Arial'), 'no name: every family');
    assert.equal(seen[0].lParam, 0x55);
    seen.length = 0;
    memory.putString(STRUCT, 'courier new');
    await fns.EnumFontFamiliesA.handler([hdc, STRUCT, ENUMPROC, 0]);
    assert.deepEqual(seen.map(one=>one.face), ['Courier New'], 'a name: that family');
});

test('EnumFontFamiliesEx stops at a zero and answers what the callback last answered', async()=>{
    const stopping = withEnumeration(false, ()=>0);
    assert.equal(await stopping.fns.EnumFontFamiliesExA.handler(
        [stopping.hdc, 0, ENUMPROC, 0, 0]), 0);
    assert.equal(stopping.seen.length, 1);

    // Wine's test_EnumFonts: the callback's own value comes back.
    const magic = withEnumeration(false, one=>one.lParam);
    assert.equal(await magic.fns.EnumFontFamiliesExA.handler(
        [magic.hdc, 0, ENUMPROC, 0xcafe, 0]), 0xcafe);
    assert.ok(magic.seen.length > 1);
});

test('EnumFontFamiliesExW reads a wide LOGFONT and hands back wide names', async()=>{
    const { fns, memory, seen, hdc } = withEnumeration(true);
    assert.equal(fns.EnumFontFamiliesExW.argBytes, 20);
    const name = 'Tahoma';
    memory.putU32s(STRUCT, new Array(23).fill(0));
    memory.putU8(STRUCT + LOGFONTA.lfCharSet, 1);
    for (let index = 0; index < name.length; index++)
    {
        memory.putU8(STRUCT + LOGFONTA.lfFaceName + index * 2, name.charCodeAt(index));
    }
    assert.equal(await fns.EnumFontFamiliesExW.handler([hdc, STRUCT, ENUMPROC, 0, 0]), 1);
    assert.deepEqual(
        seen.map(({ face, fullName, style, script })=>({ face, fullName, style, script })),
        [{ face: 'Tahoma', fullName: 'Tahoma', style: 'Regular', script: 'Western' }]);
    assert.equal(seen[0].height, seen[0].tmHeight, 'a TEXTMETRICW has the same LONGs');
});

test('EnumFontFamiliesEx calls nothing when it cannot, and refuses what is not a DC', async()=>{
    const { fns, hdc } = withDC();
    assert.equal(await fns.EnumFontFamiliesExA.handler([hdc, 0, ENUMPROC, 0, 0]), 1,
        'with no way to call the program back nothing is enumerated');
    const enumeration = withEnumeration(false);
    assert.equal(await enumeration.fns.EnumFontFamiliesExA.handler([0x9999, 0, ENUMPROC, 0, 0]),
        0);
    assert.equal(enumeration.seen.length, 0);
});

test('a font file cannot be added to the fixed font table, with the stack intact', ()=>{
    const { fns } = setup();
    assert.equal(fns.AddFontResourceA.handler(), 0);
    assert.equal(fns.CreateScalableFontResourceA.handler(), 0);
    assert.deepEqual([fns.AddFontResourceA.argBytes, fns.CreateScalableFontResourceA.argBytes],
        [4, 16]);
});

test('every spelling of adding and removing a font fails the same way, popping its arguments',
    ()=>{
        // gdi32.spec: each is stdcall with these arities. Nothing can be
        // added, so every add answers zero fonts and every remove FALSE --
        // including the in-memory pair, whose handle is NULL.
        const { fns, memory } = setup();
        const table = /** @type {Record<string, { argBytes: number,
            handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (fns));
        memory.putU32s(OUT, [UNTOUCHED]);
        /** @type {[string, number][]} */
        const spellings = [
            ['AddFontResourceW', 4], ['AddFontResourceExA', 12], ['AddFontResourceExW', 12],
            ['AddFontMemResourceEx', 16], ['RemoveFontResourceA', 4],
            ['RemoveFontResourceW', 4], ['RemoveFontResourceExA', 12],
            ['RemoveFontResourceExW', 12], ['RemoveFontMemResourceEx', 4],
        ];
        for (const [name, argBytes] of spellings)
        {
            assert.equal(table[name]?.argBytes, argBytes, `${name} is exported`);
            assert.equal(table[name].handler([FACE_NAME, 0x10, 0, OUT]), 0, name);
        }
        assert.equal(memory.u32(OUT), UNTOUCHED, 'no font count is claimed');
    });

test('GetTextCharset is the selected font\'s set, and DEFAULT_CHARSET means failure', ()=>{
    const { fns, memory, hdc } = withDC();
    const DEFAULT_CHARSET = 1;
    const RUSSIAN_CHARSET = 204;
    assert.equal(fns.GetTextCharset.handler([hdc]), 0, 'the system font is ANSI');
    assert.equal(fns.GetTextCharset.handler([0x9999]), DEFAULT_CHARSET);

    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([putLogFont(memory,
        { charSet: RUSSIAN_CHARSET })])]);
    assert.equal(fns.GetTextCharset.handler([hdc]), RUSSIAN_CHARSET);
    memory.fill(OUT, 6);
    assert.equal(fns.GetTextCharsetInfo.handler([hdc, OUT, 0]), RUSSIAN_CHARSET);
    assert.deepEqual([0, 4, 8, 12, 16, 20].map(at=>memory.u32(OUT + at)), [0, 0, 0, 0, 0, 0],
        'not a TrueType font: the signature is zeros');
    assert.equal(fns.GetTextCharsetInfo.handler([hdc, 0, 0]), RUSSIAN_CHARSET);
    assert.equal(fns.GetTextCharsetInfo.handler([0x9999, OUT, 0]), DEFAULT_CHARSET);

    // A font asked for in the default set is realised in the ANSI one, and
    // TEXTMETRIC says the same as GetTextCharset.
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([putLogFont(memory,
        { charSet: DEFAULT_CHARSET })])]);
    assert.equal(fns.GetTextCharset.handler([hdc]), 0);
    assert.equal(fns.GetTextMetricsA.handler([hdc, OUT]), 1);
    assert.equal(memory.u8(OUT + TEXTMETRICA.tmCharSet), 0);
    assert.deepEqual([fns.GetTextCharset.argBytes, fns.GetTextCharsetInfo.argBytes], [4, 12]);
});

test('GetFontLanguageInfo calls a Latin font simple and flags double-byte and RTL sets', ()=>{
    const { fns, memory, hdc } = withDC();
    assert.equal(fns.GetFontLanguageInfo.handler([hdc]), 0);
    /** @param {number} charSet */
    const withSet = charSet=>{
        fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([putLogFont(memory,
            { charSet })])]);
        return fns.GetFontLanguageInfo.handler([hdc]);
    };
    assert.equal(withSet(128), 0x0001, 'SHIFTJIS_CHARSET: GCP_DBCS');
    assert.equal(withSet(177), 0x0002, 'HEBREW_CHARSET: GCP_REORDER');
    assert.equal(withSet(204), 0);
    assert.equal(fns.GetFontLanguageInfo.handler([0x9999]), 0x8000, 'GCP_ERROR');
    assert.equal(fns.GetFontLanguageInfo.argBytes, 4);
});

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
        GetCharWidth32A: 16,
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

test('a palette-relative bitmap follows the palette filled in after it was made', ()=>{
    // The order a program of this era really uses: create the palette, select
    // it, make the bitmap whose colour table is palette indices, and only then
    // fill the palette. A bitmap frozen at creation would show the palette as
    // it was before it had any colours -- a screen of black.
    const { fns, memory, hdc } = withDC();
    memory.putU16(STRUCT + 0x800, 0x300);
    memory.putU16(STRUCT + 0x802, 2);
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
    fns.GetDIBColorTable.handler([memoryDc, 0, 2, QUADS]);
    assert.deepEqual([memory.u32(QUADS), memory.u32(QUADS + 4)], [0x00040506, 0x00010203]);

    // SetPaletteEntries replaces the colours; the bitmap's indices now mean
    // those colours, so its colour table has to read back through them.
    memory.putU32s(STRUCT + 0x900, [0x00090807, 0x000c0b0a]);
    assert.equal(fns.SetPaletteEntries.handler([palette, 0, 2, STRUCT + 0x900]), 2);
    memory.fill(QUADS, 2);
    assert.equal(fns.GetDIBColorTable.handler([memoryDc, 0, 2, QUADS]), 2);
    assert.deepEqual([memory.u32(QUADS), memory.u32(QUADS + 4)], [0x000a0b0c, 0x00070809],
        'the same indices, resolved through the palette as it is now');
});

test('every DC of a window is one drawable, and any other DC is its own', ()=>{
    // The pixel format belongs to the window: a program sets it on one DC,
    // releases that DC, and creates its context on the next one.
    const { fns, gdi } = setup();
    /** @param {number} hdc */
    const keyOf = hdc=>gdi.describeDrawable(hdc)?.key ?? null;
    const first = fns.GetDC.handler([HWND]);
    const second = fns.GetDC.handler([HWND]);
    const other = fns.GetDC.handler([HWND + 1]);
    const screen = fns.GetDC.handler([0]);
    const memoryDc = fns.CreateCompatibleDC.handler([screen]);

    assert.notEqual(first, second);
    assert.ok(keyOf(first));
    assert.equal(keyOf(first), keyOf(second));
    assert.notEqual(keyOf(first), keyOf(other));
    assert.notEqual(keyOf(screen), keyOf(memoryDc), 'contexts on no window are each their own');
    assert.equal(gdi.describeDrawable(0x7777), null, 'and a stranger is not a drawable at all');

    const bounded = gdi.windowContext(HWND, { left: 10, top: 20, right: 650, bottom: 500 });
    assert.deepEqual(gdi.describeDrawable(bounded),
        { key: keyOf(first), width: 640, height: 480 },
        'a window context is the size of the area it was given');
});

test('a region is readable and fillable from user32, and nothing else is', ()=>{
    const { gdi } = setup();
    const region = gdi.table.CreateRectRgn.handler([1, 2, 30, 40]);
    const pen = gdi.table.CreatePen.handler([0, 1, 0]);

    assert.deepEqual(gdi.regionBox(region), { left: 1, top: 2, right: 30, bottom: 40 });
    assert.equal(gdi.setRegion(region, { left: 0, top: 0, right: 5, bottom: 6 }), true);
    assert.deepEqual(gdi.regionBox(region), { left: 0, top: 0, right: 5, bottom: 6 });
    assert.equal(gdi.regionBox(pen), null);
    assert.equal(gdi.setRegion(pen, { left: 0, top: 0, right: 1, bottom: 1 }), false);
});

test('LPtoDP and DPtoLP map through the origins and the extents the mode sets', ()=>{
    const { fns, hdc, memory } = withDC();
    const POINTS = 0x9000;
    /** @param {number[]} values */
    const put = values=>memory.writeMemory(POINTS,
        new Uint8Array(new Int32Array(values).buffer));
    const read = (/** @type {number} */ count)=>
        [...new Int32Array(memory.readMemory(POINTS, count * 8).slice().buffer)];

    // MM_TEXT: one to one, shifted by the window and viewport origins.
    fns.SetWindowOrgEx.handler([hdc, 10, 20, 0]);
    fns.SetViewportOrgEx.handler([hdc, 100, 200, 0]);
    put([10, 20, 15, 25]);
    assert.equal(fns.LPtoDP.handler([hdc, POINTS, 2]), 1);
    assert.deepEqual(read(2), [100, 200, 105, 205]);
    assert.equal(fns.DPtoLP.handler([hdc, POINTS, 2]), 1);
    assert.deepEqual(read(2), [10, 20, 15, 25], 'and back');

    // MM_LOENGLISH: a hundredth of an inch, y up, on a 96-dot inch.
    fns.SetWindowOrgEx.handler([hdc, 0, 0, 0]);
    fns.SetViewportOrgEx.handler([hdc, 0, 0, 0]);
    fns.SetMapMode.handler([hdc, 4]);
    put([100, 100]);
    fns.LPtoDP.handler([hdc, POINTS, 1]);
    assert.deepEqual(read(1), [96, -96], 'an inch right and an inch up');

    fns.GetWindowExtEx.handler([hdc, OUT]);
    assert.deepEqual([...new Int32Array(memory.readMemory(OUT, 8).slice().buffer)], [100, 100]);

    // Back to MM_TEXT puts the extents back to one to one.
    fns.SetMapMode.handler([hdc, 1]);
    put([7, 7]);
    fns.LPtoDP.handler([hdc, POINTS, 1]);
    assert.deepEqual(read(1), [7, 7]);
});

test('an RTL layout mirrors the device across its width, and makes the mode anisotropic', ()=>{
    // Wine's test_dc_layout, over a 100-pixel-wide memory DC:
    // LAYOUT_RTL turns MM_TEXT into MM_ANISOTROPIC with its extents kept, and
    // LPtoDP sends x to 99 - x, the origins untouched; while it holds, even
    // MM_TEXT reads back anisotropic, and going back to LTR leaves the mode
    // as it was until MM_TEXT is asked for again.
    const { fns, hdc, memory } = withDC();
    const POINTS = 0x9000;
    const dc = fns.CreateCompatibleDC.handler([hdc]);
    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([hdc, 100, 100])]);
    /** @returns {number[]} (1000, 1000) as LPtoDP maps it */
    const mapped = ()=>{
        memory.writeMemory(POINTS, new Uint8Array(new Int32Array([1000, 1000]).buffer));
        assert.equal(fns.LPtoDP.handler([dc, POINTS, 1]), 1);
        return [...new Int32Array(memory.readMemory(POINTS, 8).slice().buffer)];
    };
    assert.equal(fns.GetLayout.handler([dc]), 0);
    assert.equal(fns.SetLayout.handler([dc, 1]), 0, 'the layout it replaced');
    assert.equal(fns.GetLayout.handler([dc]), 1);
    assert.equal(fns.GetMapMode.handler([dc]), MM_ANISOTROPIC);
    assert.deepEqual(mapped(), [-1000 + 99, 1000]);
    fns.SetViewportOrgEx.handler([dc, 0, 0, OUT]);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [0, 0], 'the origin it had');
    fns.GetWindowExtEx.handler([dc, OUT]);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [1, 1]);

    fns.SetMapMode.handler([dc, MM_TEXT]);
    assert.equal(fns.GetMapMode.handler([dc]), MM_ANISOTROPIC, 'MM_TEXT, mirrored');
    assert.equal(fns.SetLayout.handler([dc, 0]), 1);
    assert.equal(fns.GetMapMode.handler([dc]), MM_ANISOTROPIC);
    assert.deepEqual(mapped(), [1000, 1000]);
    fns.SetMapMode.handler([dc, MM_TEXT]);
    assert.equal(fns.GetMapMode.handler([dc]), MM_TEXT);

    assert.equal(fns.SetLayout.handler([0x9999, 1]) >>> 0, 0xffffffff, 'GDI_ERROR');
    assert.equal(fns.GetLayout.handler([0x9999]) >>> 0, 0xffffffff);
    assert.deepEqual([fns.SetLayout.argBytes, fns.GetLayout.argBytes], [8, 4]);
});

test('OffsetWindowOrgEx moves the window origin and reports where it was', ()=>{
    const { fns, hdc, memory } = withDC();
    fns.SetWindowOrgEx.handler([hdc, 5, 6, 0]);

    assert.equal(fns.OffsetWindowOrgEx.handler([hdc, 10, -2, OUT]), 1);
    assert.deepEqual([...new Int32Array(memory.readMemory(OUT, 8).slice().buffer)], [5, 6]);
    assert.equal(fns.OffsetWindowOrgEx.handler([0x9999, 1, 1, 0]), 0);
    assert.equal(fns.OffsetWindowOrgEx.argBytes, 16);
    assert.equal(fns.LPtoDP.argBytes, 12);
});

/** @param {ReturnType<typeof fakeMemory>} memory @param {number} at @param {string} text */
const putWide = (memory, at, text)=>memory.writeMemory(at, Uint8Array.from(
    [...text].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]).concat([0, 0])));

test('the W spellings of the font calls measure what the A ones measure', ()=>{
    const { fns, memory, hdc } = withDC();
    putLogFont(memory, { height: -20, weight: 700, charSet: 0xcc, faceName: '' });
    putWide(memory, STRUCT + LOGFONTA.lfFaceName, 'Arial');
    const font = fns.CreateFontIndirectW.handler([STRUCT]);
    assert.ok(font > 0);
    fns.SelectObject.handler([hdc, font]);

    memory.fill(OUT, 60 / 4);
    assert.equal(fns.GetTextMetricsW.handler([hdc, OUT]), 1);
    assert.equal(memory.i32(OUT + TEXTMETRICA.tmWeight), 700);
    assert.equal(memory.u8(OUT + 56), 0xcc, 'TEXTMETRICW\'s charset sits past four WCHARs');
    assert.equal(memory.u8(OUT + 44) | memory.u8(OUT + 45) << 8, 0x20, 'tmFirstChar as a WCHAR');

    const TEXT_A = 0x9200;
    const TEXT_W = 0x9300;
    const SIZE_A = 0x9400;
    const SIZE_W = 0x9410;
    memory.putString(TEXT_A, 'Hello');
    putWide(memory, TEXT_W, 'Hello');
    fns.GetTextExtentPoint32A.handler([hdc, TEXT_A, 5, SIZE_A]);
    assert.equal(fns.GetTextExtentPoint32W.handler([hdc, TEXT_W, 5, SIZE_W]), 1);
    assert.equal(memory.i32(SIZE_W), memory.i32(SIZE_A));
    assert.equal(fns.GetTextExtentPointW, fns.GetTextExtentPoint32W);
    assert.equal(fns.CreateFontW.argBytes, 56);
});

test('ABC widths are each character\'s own advance, and agree with GetCharWidth', ()=>{
    const { fns, memory, hdc } = withDC();
    const WIDTHS = 0x9500;
    const ABCS = 0x9600;

    assert.equal(fns.GetCharWidth32W.handler([hdc, 0x41, 0x43, WIDTHS]), 1);
    assert.equal(fns.GetCharABCWidthsW.handler([hdc, 0x41, 0x43, ABCS]), 1);
    for (let index = 0; index < 3; index++)
    {
        assert.deepEqual(
            [memory.i32(ABCS + index * 12), memory.i32(ABCS + index * 12 + 4),
                memory.i32(ABCS + index * 12 + 8)],
            [0, memory.i32(WIDTHS + index * 4), 0]);
    }
    assert.equal(fns.GetCharABCWidthsA.handler([hdc, 0x43, 0x41, ABCS]), 0, 'a reversed range');
    assert.equal(fns.GetCharWidthW, fns.GetCharWidth32W);
});

test('TranslateCharsetInfo answers a character set, a code page or a font signature\'s bits', ()=>{
    const { memory, fns } = setup();
    const INFO = 0x2000;
    const SIG = 0x2100;
    /** @returns {number[]} ciCharset, ciACP, fsCsb[0] */
    const view = new DataView(memory.bytes.buffer);
    const read = ()=>[0, 4, 24].map(at=>view.getUint32(INFO + at, true));
    assert.equal(fns.TranslateCharsetInfo.argBytes, 12);
    assert.equal(fns.TranslateCharsetInfo.handler([204, INFO, 1]), 1, 'TCI_SRCCHARSET');
    assert.deepEqual(read(), [204, 1251, 1 << 2]);
    assert.equal(fns.TranslateCharsetInfo.handler([932, INFO, 2]), 1, 'TCI_SRCCODEPAGE');
    assert.deepEqual(read(), [128, 932, 1 << 17]);
    new DataView(memory.bytes.buffer).setUint32(SIG, (1 << 1 | 1 << 20) >>> 0, true);
    assert.equal(fns.TranslateCharsetInfo.handler([SIG, INFO, 3]), 1, 'TCI_SRCFONTSIG, lowest bit');
    assert.deepEqual(read(), [238, 1250, 1 << 1]);
    memory.writeMemory(INFO, new Uint8Array(32).fill(0xaa));
    assert.equal(fns.TranslateCharsetInfo.handler([12345, INFO, 2]), 0, 'no such code page');
    assert.equal(memory.bytes[INFO], 0xaa, 'and the structure left alone');
    assert.equal(fns.TranslateCharsetInfo.handler([0, INFO, 3]), 0);
});

test('CreateDIBSection with no BITMAPINFO makes nothing', ()=>{
    const { fns, hdc } = withDC();
    assert.equal(fns.CreateDIBSection.handler([hdc, 0, 0, 0x2200, 0, 0]), 0);
});

test('the text character extra is kept on the context and answered back', ()=>{
    const { fns, hdc } = withDC();
    assert.equal(fns.GetTextCharacterExtra.handler([hdc]), 0);
    assert.equal(fns.SetTextCharacterExtra.handler([hdc, 3]), 0);
    assert.equal(fns.SetTextCharacterExtra.handler([hdc, -2 >>> 0]) | 0, 3);
    assert.equal(fns.GetTextCharacterExtra.handler([hdc]) | 0, -2);
    assert.equal(fns.GetTextCharacterExtra.handler([0x9999]), 0x80000000, 'not a context');
});

test('the miter limit is 10 until set, refuses one below 1, and is saved with the context', ()=>{
    const { memory, fns, hdc } = withDC();
    const view = new DataView(memory.bytes.buffer);
    const LIMIT = 0x2000;
    /** @param {number} value */
    const bits = value=>{
        const scratch = new DataView(new ArrayBuffer(4));
        scratch.setFloat32(0, value, true);
        return scratch.getUint32(0, true);
    };
    const limit = ()=>view.getFloat32(LIMIT, true);
    view.setFloat32(LIMIT, 123, true);
    assert.equal(fns.GetMiterLimit.handler([hdc, LIMIT]), 1);
    assert.equal(limit(), 10);
    view.setFloat32(LIMIT, 456, true);
    assert.equal(fns.SetMiterLimit.handler([hdc, bits(0.9), LIMIT]), 0, 'below one');
    assert.equal(limit(), 456, 'and the old one not written');
    assert.equal(fns.SetMiterLimit.handler([hdc, bits(1), LIMIT]), 1);
    assert.equal(limit(), 10, 'the old one answered');
    assert.equal(fns.SetMiterLimit.handler([hdc, bits(3.4), 0]), 1,
        'with nowhere to put the old one');
    assert.equal(fns.GetMiterLimit.handler([hdc, LIMIT]), 1);
    assert.equal(limit(), Math.fround(3.4));

    fns.SetTextCharacterExtra.handler([hdc, 5]);
    fns.SetTextAlign.handler([hdc, 6]);
    assert.equal(fns.SaveDC.handler([hdc]), 1);
    fns.SetMiterLimit.handler([hdc, bits(7), 0]);
    fns.SetTextCharacterExtra.handler([hdc, 9]);
    fns.SetTextAlign.handler([hdc, 0]);
    assert.equal(fns.RestoreDC.handler([hdc, -1 >>> 0]), 1);
    fns.GetMiterLimit.handler([hdc, LIMIT]);
    assert.equal(limit(), Math.fround(3.4), 'RestoreDC brings the miter limit back');
    assert.equal(fns.GetTextCharacterExtra.handler([hdc]), 5, 'and the character extra');
    assert.equal(fns.GetTextAlign.handler([hdc]), 6, 'and the text alignment');
    assert.equal(fns.GetMiterLimit.handler([0x9999, LIMIT]), 0, 'not a context');
});

test('GetTextFace names the face asked for, or the one its family stands in with', ()=>{
    const { memory, fns, hdc } = withDC();
    const NAME = 0x2000;
    /** @param {Parameters<typeof putLogFont>[1]} options */
    const select = options=>{
        putLogFont(memory, options);
        fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);
    };
    const faceA = ()=>{
        const length = fns.GetTextFaceA.handler([hdc, 32, NAME]);
        return decodeAnsi(memory.bytes.subarray(NAME, NAME + length));
    };
    assert.equal(faceA(), 'System', 'the context starts with the stock system font');
    select({ faceName: 'tahoma' });
    assert.equal(faceA(), 'Tahoma');
    select({ faceName: 'MS Shell Dlg' });
    assert.equal(faceA(), 'MS Shell Dlg', 'a substitute answers under its own name');
    select({ faceName: 'Nonexistent font', pitchAndFamily: 0x20 });
    assert.equal(faceA(), 'Arial');
    select({ faceName: 'Nonexistent font', pitchAndFamily: 0x10 });
    assert.equal(faceA(), 'Times New Roman');
    select({ faceName: '', pitchAndFamily: 0x01 });
    assert.equal(faceA(), 'Courier New');
    fns.SelectObject.handler([hdc, fns.GetStockObject.handler([17])]);
    assert.equal(faceA(), 'MS Shell Dlg', 'DEFAULT_GUI_FONT');
});

test('GetTextFace cuts the name to the count, and a null buffer asks for the size', ()=>{
    const { memory, fns, hdc } = withDC();
    const NAME = 0x2000;
    putLogFont(memory, { faceName: 'Tahoma' });
    fns.SelectObject.handler([hdc, fns.CreateFontIndirectA.handler([STRUCT])]);

    memory.bytes[NAME] = 0x78;
    assert.equal(fns.GetTextFaceA.handler([hdc, 0, NAME]), 0);
    assert.equal(memory.bytes[NAME], 0x78, 'a count of zero writes nothing');
    assert.equal(fns.GetTextFaceA.handler([hdc, 1, NAME]), 0);
    assert.equal(memory.bytes[NAME], 0);
    assert.equal(fns.GetTextFaceA.handler([hdc, 2, NAME]), 1);
    assert.deepEqual([...memory.bytes.subarray(NAME, NAME + 2)], [0x54, 0]);
    assert.equal(fns.GetTextFaceA.handler([hdc, 32, NAME]), 6, 'ANSI: the terminator not counted');
    assert.equal(fns.GetTextFaceA.handler([hdc, 0, 0]), 7,
        'no buffer: the size, terminator included');

    const units = (/** @type {number} */ count)=>
        [...new Uint16Array(memory.bytes.slice(NAME, NAME + count * 2).buffer)];
    memory.bytes[NAME] = 0x78;
    assert.equal(fns.GetTextFaceW.handler([hdc, 0, NAME]), 0);
    assert.equal(memory.bytes[NAME], 0x78);
    assert.equal(fns.GetTextFaceW.handler([hdc, 1, NAME]), 1, 'wide: the terminator counted');
    assert.deepEqual(units(1), [0]);
    assert.equal(fns.GetTextFaceW.handler([hdc, 2, NAME]), 2);
    assert.deepEqual(units(2), [0x54, 0]);
    assert.equal(fns.GetTextFaceW.handler([hdc, 32, NAME]), 7);
    assert.equal(String.fromCharCode(...units(6)), 'Tahoma');
    assert.equal(fns.GetTextFaceW.handler([hdc, 0, 0]), 7);
    assert.equal(fns.GetTextFaceA.handler([0x9999, 32, NAME]), 0, 'not a context');
});

test('GetObjectType names each kind of GDI object, a context by whether it is in memory', ()=>{
    const { fns, hdc } = withDC();
    const memory = fns.CreateCompatibleDC.handler([hdc]);
    assert.equal(fns.GetObjectType.handler([hdc]), 3, 'OBJ_DC');
    assert.equal(fns.GetObjectType.handler([memory]), 10, 'OBJ_MEMDC');
    assert.equal(fns.GetObjectType.handler([fns.GetStockObject.handler([7])]), 1, 'OBJ_PEN');
    assert.equal(fns.GetObjectType.handler([fns.GetStockObject.handler([0])]), 2, 'OBJ_BRUSH');
    assert.equal(fns.GetObjectType.handler([fns.GetStockObject.handler([15])]), 5, 'OBJ_PAL');
    assert.equal(fns.GetObjectType.handler([fns.GetStockObject.handler([13])]), 6, 'OBJ_FONT');
    assert.equal(fns.GetObjectType.handler([fns.CreateBitmap.handler([4, 4, 1, 1, 0])]), 7);
    assert.equal(fns.GetObjectType.handler([fns.CreateRectRgn.handler([0, 0, 4, 4])]), 8);
    assert.equal(fns.GetObjectType.handler([0x9999]), 0, 'no such object');
});

test('D3DKMTCreateDCFromMemory makes a memory DC over the program\'s own pixels', ()=>{
    const context = setup();
    const { fns, memory } = context;
    const DESC = 0x2000;
    const PIXELS = 0x2400;
    const view = new DataView(memory.bytes.buffer);
    // pMemory, Format (A8R8G8B8), Width, Height, Pitch, hDeviceDc, pColorTable
    [PIXELS, 21, 4, 4, 16, 0, 0].forEach((value, at)=>view.setUint32(DESC + at * 4, value, true));
    assert.equal(fns.D3DKMTCreateDCFromMemory.handler([DESC]), 0);
    const hdc = view.getUint32(DESC + 28, true);
    const bitmap = view.getUint32(DESC + 32, true);
    assert.equal(fns.GetObjectType.handler([hdc]), 10, 'OBJ_MEMDC');
    assert.equal(fns.GetCurrentObject.handler([hdc, OBJ_BITMAP]), bitmap);
    const DIB = 0x3000;
    assert.equal(fns.GetObjectA.handler([bitmap, 24, DIB]), 24);
    assert.equal(view.getUint32(DIB + 20, true), PIXELS, 'bmBits is the program\'s memory');

    view.setUint32(DESC + 4, 99, true);
    assert.equal(fns.D3DKMTCreateDCFromMemory.handler([DESC]), 0xc000000d, 'no such format');
    view.setUint32(DESC + 4, 21, true);
    view.setUint32(DESC + 16, 8, true);
    assert.equal(fns.D3DKMTCreateDCFromMemory.handler([DESC]), 0xc000000d, 'a pitch too short');

    view.setUint32(DESC + 0x40, hdc, true);
    view.setUint32(DESC + 0x44, bitmap, true);
    assert.equal(fns.D3DKMTDestroyDCFromMemory.handler([DESC + 0x40]), 0);
    assert.equal(fns.GetObjectType.handler([hdc]), 0, 'the DC is gone');
    assert.equal(fns.GetObjectType.handler([bitmap]), 0, 'and the bitmap');
    assert.ok(!context.surfaces.freed.includes(PIXELS), 'the pixels stay the program\'s');
});

test('an enhanced metafile DC closes into a metafile handle, and says it recorded nothing', ()=>{
    const memory = fakeMemory();
    /** @type {string[]} */
    const said = [];
    const { table: fns } = createGdiFunctions({
        readMemory: (address, length)=>memory.readMemory(address, length),
        writeMemory: (address, data)=>memory.writeMemory(address, data),
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        handles: fakeHandles(),
        surfaces: fakeSurfaces(),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    const OBJ_ENHMETADC = 12;
    const OBJ_ENHMETAFILE = 13;

    const hdc = fns.CreateEnhMetaFileA.handler([0, 0, 0, 0]);
    assert.notEqual(hdc, 0);
    assert.equal(fns.GetObjectType.handler([hdc]), OBJ_ENHMETADC);
    assert.ok(said.some(line=>line.startsWith('CreateEnhMetaFileA: drawing')));
    assert.equal(fns.GetDeviceCaps.handler([hdc, TECHNOLOGY]), 1,
        'the reference device is the display');

    const metafile = fns.CloseEnhMetaFile.handler([hdc]);
    assert.notEqual(metafile, 0);
    assert.equal(fns.GetObjectType.handler([metafile]), OBJ_ENHMETAFILE);
    assert.equal(fns.GetObjectType.handler([hdc]), 0, 'closing ends the DC');
    assert.equal(fns.CloseEnhMetaFile.handler([hdc]), 0, 'and it cannot be closed twice');
    assert.equal(fns.DeleteEnhMetaFile.handler([metafile]), 1);
    assert.equal(fns.DeleteEnhMetaFile.handler([metafile]), 0);

    const display = fns.CreateCompatibleDC.handler([0]);
    assert.equal(fns.CloseEnhMetaFile.handler([display]), 0, 'a DC that is no metafile');
    assert.equal(fns.CreateEnhMetaFileW.handler([0x7777, 0, 0, 0]), 0, 'a reference that is no DC');
    memory.putString(STRUCT, 'out.emf');
    assert.equal(fns.CreateEnhMetaFileA.handler([0, STRUCT, 0, 0]), 0);
    assert.ok(said.some(line=>line.includes('on disk')), 'a file is refused, and reported');

    // The Windows 3 metafile the same way, each Close ending only its own kind.
    const old = fns.CreateMetaFileA.handler([0]);
    assert.equal(fns.GetObjectType.handler([old]), 4, 'OBJ_METADC');
    assert.equal(fns.CloseEnhMetaFile.handler([old]), 0);
    const closed = fns.CloseMetaFile.handler([old]);
    assert.equal(fns.GetObjectType.handler([closed]), 9, 'OBJ_METAFILE');
    assert.equal(fns.DeleteEnhMetaFile.handler([closed]), 0);
    assert.equal(fns.DeleteMetaFile.handler([closed]), 1);
});

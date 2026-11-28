/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BITMAP, BITMAP64, BITMAPCOREHEADER, BITMAPINFOHEADER, DIBSECTION, DIBSECTION64, EXTLOGPEN64,
    LOGBRUSH, LOGBRUSH64, LOGFONTA, LOGFONTW_SIZE, LOGPALETTE, LOGPEN, PALETTEENTRY_SIZE, POINT,
    SIZE, TEXTMETRICA, readLogPen, writeTextMetricsW,
} from './structs.js';
import { guestOver } from '../common/guest.fixture.js';

// sizeof and offsetof of each under wingdi.h, by the compiler's rule for the
// width it is used at: a ULONG_PTR, a pointer or a HANDLE is eight bytes on
// an eight-byte boundary under _WIN64, and a structure holding one is padded
// to eight.

test('the 32-bit structures have wingdi.h\'s sizes and offsets', ()=>{
    assert.deepEqual([LOGPEN.lopnColor, LOGPEN.SIZE], [12, 16]);
    assert.deepEqual([LOGBRUSH.lbHatch, LOGBRUSH.SIZE], [8, 12]);
    assert.deepEqual([LOGFONTA.lfWeight, LOGFONTA.lfItalic, LOGFONTA.lfPitchAndFamily,
        LOGFONTA.lfFaceName, LOGFONTA.SIZE, LOGFONTW_SIZE], [16, 20, 27, 28, 60, 92]);
    assert.deepEqual([BITMAPINFOHEADER.biPlanes, BITMAPINFOHEADER.biBitCount,
        BITMAPINFOHEADER.biCompression, BITMAPINFOHEADER.biClrImportant, BITMAPINFOHEADER.SIZE],
    [12, 14, 16, 36, 40]);
    assert.deepEqual([BITMAPCOREHEADER.bcWidth, BITMAPCOREHEADER.bcBitCount,
        BITMAPCOREHEADER.SIZE], [4, 10, 12]);
    assert.deepEqual([BITMAP.bmPlanes, BITMAP.bmBitsPixel, BITMAP.bmBits, BITMAP.SIZE],
        [16, 18, 20, 24]);
    assert.deepEqual([DIBSECTION.dsBmih, DIBSECTION.dsBitfields, DIBSECTION.dshSection,
        DIBSECTION.dsOffset, DIBSECTION.SIZE], [24, 64, 76, 80, 84]);
    assert.deepEqual([TEXTMETRICA.tmDigitizedAspectY, TEXTMETRICA.tmFirstChar,
        TEXTMETRICA.tmBreakChar, TEXTMETRICA.tmItalic, TEXTMETRICA.tmCharSet, TEXTMETRICA.SIZE],
    [40, 44, 47, 48, 52, 56]);
    assert.deepEqual([POINT.y, POINT.SIZE, SIZE.cy, SIZE.SIZE], [4, 8, 4, 8]);
    assert.deepEqual([LOGPALETTE.palNumEntries, LOGPALETTE.palPalEntry, PALETTEENTRY_SIZE],
        [2, 4, 4]);
});

test('the 64-bit structures move each pointer-sized field to eight', ()=>{
    assert.deepEqual([LOGBRUSH64.lbHatch, LOGBRUSH64.SIZE], [8, 16]);
    assert.deepEqual([BITMAP64.bmBitsPixel, BITMAP64.bmBits, BITMAP64.SIZE], [18, 24, 32]);
    assert.deepEqual([DIBSECTION64.dsBmih, DIBSECTION64.dsBitfields, DIBSECTION64.dshSection,
        DIBSECTION64.dsOffset, DIBSECTION64.SIZE], [32, 72, 88, 96, 104]);
    assert.deepEqual([EXTLOGPEN64.elpColor, EXTLOGPEN64.elpHatch, EXTLOGPEN64.elpNumEntries,
        EXTLOGPEN64.elpStyleEntry, EXTLOGPEN64.SIZE], [12, 16, 24, 28, 32]);
});

test('a TEXTMETRICW puts its characters in WCHARs and everything after four bytes on', ()=>{
    /** @type {Uint8Array} */
    let written = new Uint8Array(0);
    const memory = guestOver(new Uint8Array(60));
    const setBytes = memory.setBytes;
    memory.setBytes = (address, bytes)=>{
        written = bytes.slice();
        setBytes(address, bytes);
    };
    writeTextMetricsW(memory, 0, { height: 16, ascent: 13, descent: 3, internalLeading: 0,
        externalLeading: 0, aveCharWidth: 7, maxCharWidth: 14, weight: 400,
        digitizedAspectX: 96, digitizedAspectY: 96, firstChar: 0x20, lastChar: 0xfffd,
        defaultChar: 0x1f, breakChar: 0x20, italic: 1, underlined: 0, struckOut: 0,
        pitchAndFamily: 0x31, charSet: 0xcc });
    const view = new DataView(written.buffer);
    assert.equal(written.length, 60);
    assert.equal(view.getUint16(46, true), 0xfffd, 'tmLastChar');
    assert.deepEqual([written[52], written[55], written[56]], [1, 0x31, 0xcc]);
});

test('a LOGPEN\'s width is the x of its POINT', ()=>{
    const bytes = new Uint8Array(LOGPEN.SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 5, true);
    view.setInt32(4, 3, true);
    view.setInt32(8, 99, true);
    view.setUint32(12, 0x00ff00, true);
    assert.deepEqual(readLogPen(guestOver(bytes), 0), { style: 5, width: 3, color: 0x00ff00 });
});

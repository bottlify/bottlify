/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiplusFunctions } from './functions.js';
import { encodePng } from '../user32/png.fixture.js';

const Ok = 0;
const InvalidParameter = 2;
const NotImplemented = 6;
const WrongState = 8;
const UnsupportedGdiplusVersion = 17;
const PixelFormat32bppARGB = 0x26200a;
const PixelFormat24bppRGB = 0x21808;
const PixelFormat8bppIndexed = 0x30803;

/** @param {4 | 8} [pointerSize] @param {Record<string, any>} [more] */
function machine(pointerSize = 4, more = {}){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let heap = 0x10000;
    /** @type {string[]} */
    const said = [];
    /** @type {number[]} */
    const freed = [];
    const fns = createGdiplusFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readMemory: (address, length)=>memory.subarray(address, address + length),
        allocate: bytes=>{
            const at = heap;
            heap += Math.ceil(bytes / 16) * 16;
            return at;
        },
        free: address=>freed.push(address),
        pointerSize,
        divergence: api=>said.push(api),
        ...more,
    });
    return { memory, view, fns, said, freed };
}

test('GdiplusStartup takes versions 1 and 2 and hands a token', async()=>{
    // Wine's gdiplus test_startup (pen.c): the versions start from 1, and the
    // first one refused is past 2 - GDI+ 1.1 is version 2.
    const { view, fns } = machine();
    view.setUint32(0x100, 1, true);
    assert.equal(await fns.GdiplusStartup.handler([0x200, 0x100, 0]), Ok);
    assert.notEqual(view.getUint32(0x200, true), 0, 'a token');
    view.setUint32(0x100, 2, true);
    assert.equal(await fns.GdiplusStartup.handler([0x200, 0x100, 0]), Ok);
    view.setUint32(0x100, 3, true);
    assert.equal(await fns.GdiplusStartup.handler([0x200, 0x100, 0]), UnsupportedGdiplusVersion);
    view.setUint32(0x100, 0, true);
    assert.equal(await fns.GdiplusStartup.handler([0x200, 0x100, 0]), UnsupportedGdiplusVersion);
    view.setUint32(0x100, 42, true);
    assert.equal(await fns.GdiplusStartup.handler([0x200, 0x100, 0]), UnsupportedGdiplusVersion);
    assert.equal(await fns.GdiplusStartup.handler([0, 0x100, 0]), InvalidParameter);
});

test('a caller that suppressed the background thread is handed the hook and unhook to call',
    async()=>{
        /** @type {Record<string, number>} */
        const exports = { GdiplusNotificationHook: 0x7000, GdiplusNotificationUnhook: 0x7010 };
        const { view, fns } = machine(4, { procAddress: (/** @type {string} */ name)=>
            exports[name] ?? 0 });
        // GdiplusStartupInput: version 1, no debug callback, SuppressBackgroundThread.
        view.setUint32(0x100, 1, true);
        view.setUint32(0x104, 0, true);
        view.setUint32(0x108, 1, true);
        assert.equal(await fns.GdiplusStartup.handler([0x200, 0x100, 0x300]), Ok);
        assert.deepEqual([view.getUint32(0x300, true), view.getUint32(0x304, true)],
            [0x7000, 0x7010]);
        assert.equal(fns.GdiplusNotificationHook.handler([0x400]), Ok);
        assert.notEqual(view.getUint32(0x400, true), 0, 'a token for the unhook');

        // Not suppressed: the background thread does the work, and there is nothing to call.
        view.setUint32(0x108, 0, true);
        view.setUint32(0x300, 0xffffffff, true);
        assert.equal(await fns.GdiplusStartup.handler([0x200, 0x100, 0x300]), Ok);
        assert.equal(view.getUint32(0x300, true), 0);
    });

test('a bitmap of its own pixels: its size and format, its pixels locked in place', ()=>{
    const { memory, view, fns } = machine();
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([3, 2, 0, PixelFormat24bppRGB, 0, 0x300]),
        Ok);
    const bitmap = view.getUint32(0x300, true);
    fns.GdipGetImageWidth.handler([bitmap, 0x310]);
    fns.GdipGetImageHeight.handler([bitmap, 0x314]);
    fns.GdipGetImagePixelFormat.handler([bitmap, 0x318]);
    assert.deepEqual([0x310, 0x314, 0x318].map(at=>view.getUint32(at, true)),
        [3, 2, PixelFormat24bppRGB]);

    // The whole bitmap, then locked again before the unlock.
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0, 3, PixelFormat24bppRGB, 0x400]), Ok);
    assert.deepEqual([0, 4, 8, 12].map(at=>view.getInt32(0x400 + at, true)),
        [3, 2, 12, PixelFormat24bppRGB], 'rows of nine bytes padded to twelve');
    const scan0 = view.getUint32(0x410, true);
    assert.notEqual(scan0, 0);
    assert.ok(memory.subarray(scan0, scan0 + 24).every(byte=>byte === 0), 'zeroed');
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0, 3, PixelFormat24bppRGB, 0x400]),
        WrongState, 'already locked');
    memory.set([1, 2, 3], scan0 + 12 + 3);
    assert.equal(fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]), Ok);
    assert.equal(fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]), WrongState, 'not locked');

    // A rectangle: the pixel at (1, 1) is where the program wrote it.
    [1, 1, 2, 1].forEach((value, i)=>view.setInt32(0x500 + i * 4, value, true));
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0x500, 1, PixelFormat24bppRGB, 0x400]),
        Ok);
    const at = view.getUint32(0x410, true);
    assert.deepEqual([...memory.subarray(at, at + 3)], [1, 2, 3]);
    fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]);
    [2, 1, 2, 1].forEach((value, i)=>view.setInt32(0x500 + i * 4, value, true));
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0x500, 1, PixelFormat24bppRGB, 0x400]),
        InvalidParameter, 'a rectangle past the bitmap');
});

test('over the caller\'s pixels, a clone of its own, a dispose that frees only its own', ()=>{
    const { memory, view, fns, freed } = machine();
    memory.set([10, 20, 30, 40, 50, 60, 70, 80], 0x800);
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([2, 1, 8, PixelFormat32bppARGB, 0x800,
        0x300]), Ok);
    const bitmap = view.getUint32(0x300, true);
    fns.GdipBitmapLockBits.handler([bitmap, 0, 1, PixelFormat32bppARGB, 0x400]);
    assert.equal(view.getUint32(0x410, true), 0x800, 'the caller\'s own pixels');
    fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]);

    assert.equal(fns.GdipCloneImage.handler([bitmap, 0x304]), Ok);
    const clone = view.getUint32(0x304, true);
    fns.GdipBitmapLockBits.handler([clone, 0, 1, PixelFormat32bppARGB, 0x400]);
    const copied = view.getUint32(0x410, true);
    assert.notEqual(copied, 0x800);
    assert.deepEqual([...memory.subarray(copied, copied + 8)], [10, 20, 30, 40, 50, 60, 70, 80]);

    assert.equal(fns.GdipDisposeImage.handler([bitmap]), Ok);
    assert.deepEqual(freed, [], 'the caller\'s pixels are the caller\'s');
    assert.equal(fns.GdipDisposeImage.handler([clone]), Ok);
    assert.deepEqual(freed, [copied]);
    assert.equal(fns.GdipDisposeImage.handler([clone]), InvalidParameter, 'disposed already');
});

test('the bitmaps refused, and the palettes GDI+ starts a bitmap with', ()=>{
    // Wine's image.c test_Scan0 and test_palette record these answers.
    const { view, fns } = machine();
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([0, 1, 0, PixelFormat32bppARGB, 0,
        0x300]), InvalidParameter, 'no width');
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([1, 1, 0, PixelFormat32bppARGB, 0x800,
        0x300]), InvalidParameter, 'pixels with no stride');
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([1, 1, 10, PixelFormat24bppRGB, 0x800,
        0x300]), InvalidParameter, 'a stride not a multiple of four');
    fns.GdipCreateBitmapFromScan0.handler([1, 1, 0, PixelFormat32bppARGB, 0, 0x300]);
    const bitmap = view.getUint32(0x300, true);
    assert.equal(fns.GdipGetImagePaletteSize.handler([bitmap, 0x310]), Ok);
    assert.equal(view.getUint32(0x310, true), 12, 'the header and room for one entry');
    assert.equal(fns.GdipGetImagePalette.handler([bitmap, 0x320, 12]), Ok);
    assert.equal(view.getUint32(0x324, true), 0, 'no colours');
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([2, 2, 0, PixelFormat8bppIndexed, 0,
        0x300]), Ok);
    const indexed = view.getUint32(0x300, true);
    assert.equal(fns.GdipGetImagePalette.handler([indexed, 0x400, 8 + 256 * 4]), Ok);
    assert.deepEqual([view.getUint32(0x400, true), view.getUint32(0x404, true),
        view.getUint32(0x408 + 8 * 4, true), view.getUint32(0x408 + 40 * 4, true)],
    [4, 256, 0xffc0c0c0, 0xff000000], 'the halftone palette');
    assert.equal(fns.GdipBitmapSetPixel.handler([indexed, 0, 1, 0xffcccccc]), Ok);
    assert.equal(fns.GdipBitmapGetPixel.handler([indexed, 0, 1, 0x500]), Ok);
    assert.equal(view.getUint32(0x500, true), 0xffcccccc, 'the palette\'s own colour');
});

test('a 64-bit process\'s handles and Scan0 are pointers', ()=>{
    const { view, fns } = machine(8);
    view.setUint32(0x300 + 4, 0xcccccccc, true);
    fns.GdipCreateBitmapFromScan0.handler([1, 1, 0, PixelFormat32bppARGB, 0, 0x300]);
    assert.equal(view.getUint32(0x304, true), 0, 'the handle\'s high half written');
    const bitmap = view.getUint32(0x300, true);
    fns.GdipBitmapLockBits.handler([bitmap, 0, 1, PixelFormat32bppARGB, 0x400]);
    assert.notEqual(view.getUint32(0x410, true), 0, 'Scan0 at 16');
});

test('an export not done answers NotImplemented, said once with why', ()=>{
    const { fns, said } = machine();
    const record = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (fns)).GdipRecordMetafile;
    assert.equal(record.handler([]), NotImplemented);
    assert.equal(record.handler([]), NotImplemented);
    assert.deepEqual(said, ['GdipRecordMetafile']);
});

test('GdipCreateBitmapFromFile decodes the file\'s image; a file not there or'
    + ' not an image is said so', async()=>{
    const png = encodePng({ width: 2, height: 1, read: x=>(x === 0 ? 0xff0000 : 0x0000ff) });
    /** @type {Record<string, Uint8Array>} */
    const files = { 'C:\\logo.png': png, 'C:\\text.txt': new TextEncoder().encode('no image') };
    const { memory, view, fns } = machine(4, {
        readWideString: (/** @type {number} */ at)=>{
            let text = '';
            for (let i = at; view.getUint16(i, true) !== 0; i += 2)
            {
                text += String.fromCharCode(view.getUint16(i, true));
            }
            return text;
        },
        readFile: (/** @type {string} */ path)=>files[path] ?? null,
    });
    /** @param {string} text */
    const put = text=>{
        [...text].forEach((c, i)=>view.setUint16(0x100 + i * 2, c.charCodeAt(0), true));
        view.setUint16(0x100 + text.length * 2, 0, true);
        return 0x100;
    };
    assert.equal(await fns.GdipCreateBitmapFromFile.handler([put('C:\\logo.png'), 0x300]), Ok);
    const bitmap = view.getUint32(0x300, true);
    assert.equal(fns.GdipGetImagePixelFormat.handler([bitmap, 0x304]), Ok);
    assert.equal(view.getUint32(0x304, true), PixelFormat24bppRGB, 'its own depth');
    assert.equal(fns.GdipGetImageWidth.handler([bitmap, 0x308]), Ok);
    assert.equal(view.getUint32(0x308, true), 2);
    // Locked for reading: B, G, R, A of red, then of blue.
    view.setUint32(0x400, 0, true);
    view.setUint32(0x404, 0, true);
    view.setUint32(0x408, 2, true);
    view.setUint32(0x40c, 1, true);
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0x400, 1, PixelFormat32bppARGB, 0x500]),
        Ok);
    const scan0 = view.getUint32(0x510, true);
    assert.deepEqual([...memory.subarray(scan0, scan0 + 8)], [0, 0, 255, 255, 255, 0, 0, 255]);

    assert.equal(await fns.GdipCreateBitmapFromFile.handler([put('C:\\gone.png'), 0x300]),
        InvalidParameter, 'a file not there');
    assert.equal(await fns.GdipLoadImageFromFile.handler([put('C:\\gone.png'), 0x300]),
        3, 'OutOfMemory, as GDI+ answers a load');
    assert.equal(await fns.GdipCreateBitmapFromFile.handler([put('C:\\text.txt'), 0x300]),
        13, 'UnknownImageFormat');
});

test('a window\'s graphics, and GDI\'s halftone palette, as WinForms paints a control', ()=>{
    /** @type {string[]} */
    const asked = [];
    const { view, fns } = machine(4, {
        gdi32: (/** @type {string} */ name)=>{
            asked.push(name);
            return 0x4c0;
        },
        user32: (/** @type {string} */ name)=>{
            asked.push(name);
            return 0x88;
        },
    });
    assert.equal(fns.GdipCreateFromHWND.handler([0x1000, 0x300]), Ok);
    assert.equal(fns.GdipCreateFromHWND.handler([0, 0x304]), Ok, 'NULL is the screen');
    assert.equal(fns.GdipCreateFromHWND.handler([0x1000, 0]), InvalidParameter);
    assert.equal(fns.GdipDeleteGraphics.handler([view.getUint32(0x300, true)]), Ok);
    assert.equal(fns.GdipCreateHalftonePalette.handler(), 0x4c0);
    assert.deepEqual(asked, ['GetDC', 'GetDC', 'ReleaseDC', 'CreateHalftonePalette'],
        'the window\'s DC taken and given back');
});

test('GdipCreateHBITMAPFromBitmap hands GDI a top-down 32-bit section, each pixel laid over the'
    + ' background by its alpha', ()=>{
    /** @type {{ name: string, height: number, bits: number }[]} */
    const made = [];
    const { memory, view, fns } = machine(4, {
        gdi32: (/** @type {string} */ name, /** @type {number[]} */ [, info, , bitsOut])=>{
            made.push({ name, height: view.getInt32(info + 8, true), bits: 0x8000 });
            view.setUint32(bitsOut, 0x8000, true);
            return 0x1234;
        },
    });
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([2, 1, 8, PixelFormat32bppARGB, 0x600,
        0x300]), Ok);
    // Opaque green, then half-transparent red.
    memory.set([0, 255, 0, 255, 0, 0, 255, 128], 0x600);
    const bitmap = view.getUint32(0x300, true);
    // Over white (ARGB 0xffffffff).
    assert.equal(fns.GdipCreateHBITMAPFromBitmap.handler([bitmap, 0x310, 0xffffffff]), Ok);
    assert.equal(view.getUint32(0x310, true), 0x1234);
    assert.deepEqual(made, [{ name: 'CreateDIBSection', height: -1, bits: 0x8000 }], 'top-down');
    assert.deepEqual([...memory.subarray(0x8000, 0x8008)], [0, 255, 0, 255, 127, 127, 255, 255]);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gdi32 entry points in front of the drawing service, and the objects that
 * exist only because drawing needs them.
 *
 * Two things are checked throughout. That a build with no drawing service fails
 * truthfully rather than reporting success -- a program told its blit worked has
 * no reason to look again -- and that the object model behind regions, palettes
 * and pixel formats behaves the way a program tests it, since each of those is
 * usually consulted before a decision rather than for its own sake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine } from './drawing.js';
import { createGdiFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';

const HWND = 0x2000;
const STRUCT = 0x30000;
const OUT = 0x30400;
const RAMP = 0x31000;

const RGN_AND = 1;
const RGN_OR = 2;
const RGN_COPY = 5;
const NULLREGION = 1;
const SIMPLEREGION = 2;

const PATCOPY = 0x00f00021;
const DIB_RGB_COLORS = 0;
const DIB_PAL_COLORS = 1;
const SRCCOPY = 0x00cc0020;

function fakeMemory(size = 0x33000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
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
        /** @param {number} address @param {number[]} values */
        putU32s(address, values){
            values.forEach((value, index)=>{
                const at = address + index * 4;
                bytes[at] = value & 0xff;
                bytes[at + 1] = value >>> 8 & 0xff;
                bytes[at + 2] = value >>> 16 & 0xff;
                bytes[at + 3] = value >>> 24 & 0xff;
            });
        },
        /** @param {number} address */
        u32: address=>(bytes[address] | bytes[address + 1] << 8
            | bytes[address + 2] << 16 | bytes[address + 3] << 24) >>> 0,
        /** @param {number} address */
        u16: address=>(bytes[address] | bytes[address + 1] << 8) & 0xffff,
    };
}

function fakeHandles(){
    /** @type {Map<number, any>} */
    const entries = new Map();
    let next = 4;
    return {
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            entries.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle */
        close: handle=>entries.delete(handle),
    };
}

/** The heap CreateDIBSection allocates its bits out of. */
function fakeSurfaces(){
    let next = 0x40000;
    return {
        /** @param {number} bytes */
        allocate(bytes){
            const address = next;
            next += bytes + 0x100;
            return address;
        },
        free: ()=>1,
    };
}

/**
 * A drawing service that records what it was asked to do. Nothing here draws:
 * what these tests are about is whether the guest ABI in front of it resolves
 * the right handles and reports the right answer.
 */
function fakeDrawing(){
    /** @type {any[]} */
    const calls = [];
    /** @type {Map<number, number>} the formats, kept where OPENGL32 keeps them */
    const formats = new Map();
    const surface = { width: 640, height: 480 };
    const drawing = {
        calls,
        /** @param {number} hdc */
        bind(hdc){
            calls.push(['bind', hdc]);
        },
        /** @param {number} hdc @param {any} rect */
        setClipRect(hdc, rect){
            calls.push(['setClipRect', hdc, rect]);
        },
        bitBlt(){
            calls.push(['bitBlt']);
            return true;
        },
        /** @param {number[]} args */
        patBlt(...args){
            calls.push(['patBlt', ...args]);
            return true;
        },
        /** @param {number[]} args */
        stretchBlt(...args){
            calls.push(['stretchBlt', ...args]);
            return true;
        },
        /** @param {number} hdc @param {any} request */
        stretchDIBits(hdc, request){
            const { header, colors, bits } = request.image;
            calls.push(['stretchDIBits', hdc, header.width, header.bitCount, colors.length,
                bits.length, request.destWidth]);
            return Math.abs(request.image.header.height);
        },
        stretchMode: 1,
        /** @param {number} hdc @param {number} mode */
        setStretchBltMode(hdc, mode){
            const previous = this.stretchMode;
            this.stretchMode = mode;
            return previous;
        },
        getStretchBltMode(){
            return this.stretchMode;
        },
        /** @param {number} hdc @param {number} x @param {number} y */
        lineTo(hdc, x, y){
            calls.push(['lineTo', hdc, x, y]);
        },
        /** @param {number} hdc @param {number} x @param {number} y @param {number} color */
        setPixel(hdc, x, y, color){
            calls.push(['setPixel', hdc, x, y, color]);
        },
        getPixel: ()=>0x00112233,
        /** @param {number} hdc @param {number} x @param {number} y @param {string} text */
        textOutA(hdc, x, y, text){
            calls.push(['textOutA', hdc, x, y, text]);
        },
        /** @param {number} hdc @param {any} rect @param {number} brush */
        fillRect(hdc, rect, brush){
            calls.push(['fillRect', hdc, rect, brush]);
        },
    };
    let presented = 0;
    return {
        drawing,
        calls,
        presented: ()=>presented,
        services: {
            createDrawing: ()=>drawing,
            /** @param {any} dc @param {any} bitmap */
            surfaceFor: (dc, bitmap)=>{
                void dc;
                void bitmap;
                return surface;
            },
            presentDesktop: ()=>{
                presented++;
            },
            pixelFormat: {
                count: ()=>3,
                size: ()=>40,
                choose: ()=>2,
                /** @param {number} index */
                describe: index=>index >= 1 && index <= 3 ? new Uint8Array(40).fill(index) : null,
                /** @param {number} hdc @param {number} index */
                set(hdc, index){
                    calls.push(['setPixelFormat', hdc, index]);
                    if (index < 1 || index > 3 || (formats.has(hdc) && formats.get(hdc) !== index))
                    {
                        return false;
                    }
                    formats.set(hdc, index);
                    return true;
                },
                /** @param {number} hdc */
                get: hdc=>formats.get(hdc) ?? 0,
            },
            /** @param {number} hdc */
            swapBuffers(hdc){
                calls.push(['swapBuffers', hdc]);
                return true;
            },
        },
    };
}

/** @param {any} [graphics] */
function setup(graphics){
    const memory = fakeMemory();
    const fns = createGdiFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        surfaces: fakeSurfaces(),
        graphics,
    }).table;
    // Cast once: the table's handlers declare only the arguments they read, and
    // a guest call always arrives with the whole argument array.
    const table = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (fns));
    return { memory, fns: table, hdc: table.GetDC.handler([HWND]) };
}

// --- a build that cannot draw says so ---

test('without a drawing service every drawing call fails, and says which way', ()=>{
    // The failure has to be visible. A blit that reports success and draws
    // nothing leaves a program with no reason to look again.
    const { fns, hdc } = setup();

    assert.equal(fns.BitBlt.handler([hdc, 0, 0, 10, 10, 0, 0, 0, SRCCOPY]), 0);
    assert.equal(fns.LineTo.handler([hdc, 5, 5]), 0);
    assert.equal(fns.TextOutA.handler([hdc, 0, 0, 0, 0]), 0);
    assert.equal(fns.SetPixel.handler([hdc, 1, 1, 0xff]), 0xffffffff,
        'CLR_INVALID, not zero -- zero is black and a program cannot tell them apart');
    assert.equal(fns.GetPixel.handler([hdc, 1, 1]), 0xffffffff);
});

test('with one, the calls reach it with the arguments they were given', ()=>{
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);

    assert.equal(fns.BitBlt.handler([hdc, 1, 2, 3, 4, 0, 5, 6, SRCCOPY]), 1);
    assert.equal(fns.LineTo.handler([hdc, 7, 8]), 1);
    assert.equal(fns.SetPixel.handler([hdc, 9, 10, 0x00abcdef]), 0x00112233,
        'the colour actually set is reported, not the one asked for');

    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'lineTo'), [['lineTo', hdc, 7, 8]]);
    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'setPixel'),
        [['setPixel', hdc, 9, 10, 0x00abcdef]]);
    assert.equal(graphics.calls.filter(call=>call[0] === 'bind').length, 1,
        'the surface is bound once, not on every call');
});

test('a memory context is bound to the bitmap selected into it, and rebound on a change', ()=>{
    // The service is asked for the pixels with what the context reports as
    // its surface: the selected bitmap's own attributes. Selecting another
    // bitmap makes the binding stale, and the next draw binds the new one.
    const graphics = fakeDrawing();
    /** @type {any[]} */
    const asked = [];
    graphics.services.surfaceFor = (/** @type {any} */ dc, /** @type {any} */ bitmap)=>{
        asked.push({ kind: dc.kind, width: bitmap.width });
        return { width: bitmap.width, height: bitmap.height };
    };
    const { fns, hdc } = setup(graphics.services);
    const memoryDc = fns.CreateCompatibleDC.handler([hdc]);
    const first = fns.CreateBitmap.handler([8, 8, 1, 32, 0]);
    const second = fns.CreateBitmap.handler([9, 8, 1, 32, 0]);

    fns.SelectObject.handler([memoryDc, first]);
    assert.equal(fns.LineTo.handler([memoryDc, 1, 1]), 1);
    assert.equal(fns.LineTo.handler([memoryDc, 2, 2]), 1);
    assert.deepEqual(asked, [{ kind: 'memory', width: 8 }], 'bound once while nothing changes');

    fns.SelectObject.handler([memoryDc, second]);
    assert.equal(fns.LineTo.handler([memoryDc, 3, 3]), 1);
    assert.deepEqual(asked.at(-1), { kind: 'memory', width: 9 });
    assert.equal(graphics.calls.filter(call=>call[0] === 'bind').length, 2,
        'once per bitmap');
});

test('a surface whose bytes the guest outgrew is taken again, not drawn into nowhere', ()=>{
    // The emulator grows its memory in place, which detaches every view of it
    // taken before the growth. A context holds one such view for as long as its
    // selected bitmap does, so after a growth every draw through it reads
    // zeroes and writes nowhere -- an installer that copied for ten minutes and
    // then painted its last screen black. The view is taken again at the same
    // guest address, which the growth did not move.
    const graphics = fakeDrawing();
    /** @type {any[]} */
    const surfaces = [];
    graphics.services.surfaceFor = (/** @type {any} */ dc, /** @type {any} */ bitmap)=>{
        void dc;
        const surface = { width: bitmap.width, height: bitmap.height, bytes: new Uint8Array(16) };
        surfaces.push(surface);
        return surface;
    };
    const { fns, hdc } = setup(graphics.services);
    const memoryDc = fns.CreateCompatibleDC.handler([hdc]);
    const bitmap = fns.CreateBitmap.handler([4, 4, 1, 8, 0x1000]);
    fns.SelectObject.handler([memoryDc, bitmap]);

    assert.equal(fns.BitBlt.handler([memoryDc, 0, 0, 2, 2, 0, 0, 0, SRCCOPY]), 1);
    assert.equal(surfaces.length, 1, 'bound while the bytes are there');

    // The emulator's buffer is replaced: the bound view goes empty.
    surfaces[0].bytes = new Uint8Array(0);
    assert.equal(fns.BitBlt.handler([memoryDc, 0, 0, 2, 2, 0, 0, 0, SRCCOPY]), 1);
    assert.equal(surfaces.length, 2, 'the next draw takes the view again');
    assert.equal(graphics.calls.filter(call=>call[0] === 'bind').length, 2,
        'and binds the fresh one, because the old binding is empty');
});

test('the blits that need no source, and the ones that scale, reach the service', ()=>{
    // An installer paints its banner with PatBlt and StretchDIBits; a missing
    // import there was a zero answer that popped nothing, and eight calls
    // later the program returned into its own stack.
    const graphics = fakeDrawing();
    const { fns, hdc, memory } = setup(graphics.services);

    assert.equal(fns.PatBlt.handler([hdc, 1, 2, 30, 40, PATCOPY]), 1);
    assert.equal(fns.StretchBlt.handler([hdc, 0, 0, 10, 10, hdc, 0, 0, 5, 5, SRCCOPY]), 1);
    assert.equal(fns.SetStretchBltMode.handler([hdc, 3]), 1, 'the previous mode comes back');
    assert.equal(fns.GetStretchBltMode.handler([hdc]), 3);

    // A 4-bit DIB: header, sixteen colours, then two rows of two pixels.
    const INFO = 0x800;
    const BITS = 0x900;
    memory.putU32s(INFO, [40, 2, 2]);
    memory.bytes[INFO + 12] = 1;
    memory.bytes[INFO + 14] = 4;
    memory.putU32s(INFO + 16, [0, 0, 0, 0, 16, 0]);
    memory.putU32s(INFO + 40, Array.from({ length: 16 }, (_, index)=>index * 0x111111));
    memory.bytes.set([0x01, 0, 0, 0, 0x23, 0, 0, 0], BITS);
    assert.equal(fns.StretchDIBits.handler(
        [hdc, 0, 0, 4, 4, 0, 0, 2, 2, BITS, INFO, DIB_RGB_COLORS, SRCCOPY]), 2);
    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'stretchDIBits'),
        [['stretchDIBits', hdc, 2, 4, 16, 8, 4]]);
    assert.equal(fns.StretchDIBits.handler(
        [hdc, 0, 0, 4, 4, 0, 0, 2, 2, BITS, INFO, DIB_PAL_COLORS, SRCCOPY]), 2,
    'a palette-relative table is read through the palette');
    assert.equal(fns.StretchDIBits.handler(
        [hdc, 0, 0, 4, 4, 0, 0, 2, 2, BITS, INFO, DIB_PAL_COLORS + 2, SRCCOPY]), 0,
    'and past DIB_PAL_INDICES there is no usage');
    assert.equal(fns.PatBlt.argBytes, 24);
    assert.equal(fns.StretchDIBits.argBytes, 52);
});

test('a draw on a window\'s own context shows the desktop; one on a memory context does not', ()=>{
    // A program that fetches its window's DC once at start-up and blits into
    // it every frame -- never through BeginPaint/EndPaint, never releasing --
    // is still a program that changed what is on screen. Gating the desktop
    // presentation on ReleaseDC or an internal repaint, and not on the draw
    // itself, leaves that program's every frame invisible after the first.
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    const memoryDc = fns.CreateCompatibleDC.handler([hdc]);
    const bitmap = fns.CreateBitmap.handler([8, 8, 1, 32, 0x1000]);
    fns.SelectObject.handler([memoryDc, bitmap]);

    assert.equal(fns.BitBlt.handler([memoryDc, 0, 0, 2, 2, 0, 0, 0, SRCCOPY]), 1);
    assert.equal(graphics.presented(), 0, 'a memory surface is not the screen');

    assert.equal(fns.BitBlt.handler([hdc, 0, 0, 2, 2, 0, 0, 0, SRCCOPY]), 1);
    assert.equal(graphics.presented(), 1);

    assert.equal(fns.LineTo.handler([hdc, 3, 3]), 1);
    assert.equal(graphics.presented(), 2, 'every draw on the window, not only the first');
});

// --- regions ---

test('a region combines the way its own ceiling says it does', ()=>{
    // AND is exact; OR is the bounding box, which repaints more than a real
    // region would and never less. Asserting that directly keeps the ceiling
    // honest rather than letting it drift into a claim of exactness.
    const left = { left: 0, top: 0, right: 10, bottom: 10 };
    const right = { left: 20, top: 20, right: 30, bottom: 30 };

    assert.deepEqual(combine(left, right, RGN_AND),
        { left: 20, top: 20, right: 10, bottom: 10 }, 'disjoint rectangles meet nowhere');
    assert.deepEqual(combine(left, right, RGN_OR),
        { left: 0, top: 0, right: 30, bottom: 30 }, 'and their union is the span between');
    assert.deepEqual(combine(left, right, RGN_COPY), left);
    assert.equal(combine(left, right, 99), null, 'an unknown mode is an error, not a default');
});

test('CombineRgn writes into the destination and reports the shape', ()=>{
    const { memory, fns } = setup();
    const first = fns.CreateRectRgn.handler([0, 0, 10, 10]);
    const second = fns.CreateRectRgn.handler([5, 5, 20, 20]);
    const destination = fns.CreateRectRgn.handler([0, 0, 0, 0]);

    assert.equal(fns.CombineRgn.handler([destination, first, second, RGN_AND]), SIMPLEREGION);
    memory.putU32s(STRUCT, [0, 0, 0, 0]);

    const disjoint = fns.CreateRectRgn.handler([40, 40, 50, 50]);
    assert.equal(fns.CombineRgn.handler([destination, first, disjoint, RGN_AND]), NULLREGION,
        'an intersection with nothing in it is a null region, not an error');
    assert.equal(fns.CombineRgn.handler([destination, 0, second, RGN_AND]), 0,
        'and a handle that is not a region is an error');
});

test('a null clip region means the whole surface, not an empty one', ()=>{
    // The difference is everything: one clips nothing away, the other clips
    // everything, and both are spelled with a zero handle in some other API.
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);

    assert.equal(fns.SelectClipRgn.handler([hdc, 0]), SIMPLEREGION);
    const [, , rect] = graphics.calls.find(call=>call[0] === 'setClipRect');
    assert.ok(rect.right > 0 && rect.bottom > 0, 'the clip covers the surface');

    const empty = fns.CreateRectRgn.handler([5, 5, 5, 5]);
    assert.equal(fns.SelectClipRgn.handler([hdc, empty]), NULLREGION);
});

test('GetClipRgn copies the clip the program selected, and answers 0 for none', ()=>{
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    const region = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    const selected = fns.CreateRectRgn.handler([2, 3, 40, 50]);
    assert.equal(fns.GetClipRgn.handler([hdc, region]), 0, 'nothing selected yet');
    assert.equal(fns.SelectClipRgn.handler([hdc, selected]), SIMPLEREGION);
    assert.equal(fns.GetClipRgn.handler([hdc, region]), 1);
    assert.equal(fns.SelectClipRgn.handler([hdc, 0]), SIMPLEREGION);
    assert.equal(fns.SelectClipRgn.handler([hdc, region]), SIMPLEREGION);
    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'setClipRect').at(-1)?.[2],
        { left: 2, top: 3, right: 40, bottom: 50 }, 'the copy is the selection');
    assert.equal(fns.SelectClipRgn.handler([hdc, 0]), SIMPLEREGION);
    assert.equal(fns.GetClipRgn.handler([hdc, region]), 0, 'a null selection is none again');
    assert.equal(fns.GetClipRgn.handler([hdc, hdc]) | 0, -1, 'not a region');
    assert.equal(fns.GetClipRgn.handler([0x9999, region]) | 0, -1, 'not a context');
});

test('GetRgnBox answers a region\'s bounds, an empty one as zeros', ()=>{
    const { fns, memory } = setup();
    const BOX = 0x3000;
    const box = ()=>[0, 4, 8, 12].map(at=>
        new DataView(memory.bytes.buffer).getInt32(BOX + at, true));
    assert.equal(fns.GetRgnBox.handler([fns.CreateRectRgn.handler([2, 3, 40, 50]), BOX]),
        SIMPLEREGION);
    assert.deepEqual(box(), [2, 3, 40, 50]);
    assert.equal(fns.GetRgnBox.handler([fns.CreateRectRgn.handler([5, 5, 5, 9]), BOX]), NULLREGION);
    assert.deepEqual(box(), [0, 0, 0, 0]);
    assert.equal(fns.GetRgnBox.handler([0x9999, BOX]), 0, 'not a region');
});

test('SetPixelV is SetPixel answered as a BOOL', ()=>{
    const bare = setup();
    assert.equal(bare.fns.SetPixelV.handler([bare.hdc, 1, 1, 0xff]), 0, 'nothing to draw with');
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    assert.equal(fns.SetPixelV.handler([hdc, 9, 10, 0x00abcdef]), 1);
    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'setPixel'),
        [['setPixel', hdc, 9, 10, 0x00abcdef]]);
});

test('a band excluded from the clip is taken off; a cut that would leave an L is not', ()=>{
    const graphics = fakeDrawing();
    const { fns, memory, hdc } = setup(graphics.services);
    const COMPLEXREGION = 3;
    const lastClip = ()=>graphics.calls.filter(call=>call[0] === 'setClipRect').at(-1)?.[2];

    assert.equal(fns.ExcludeClipRect.argBytes, 20);
    assert.equal(fns.ExcludeClipRect.handler([hdc, 0, 0, 640, 100]), SIMPLEREGION,
        'a band across the top');
    assert.deepEqual(lastClip(), { left: 0, top: 100, right: 640, bottom: 480 });
    assert.equal(fns.ExcludeClipRect.handler([hdc, 600, 0, 700, 480]), SIMPLEREGION,
        'a band down the right, reaching past the surface');
    assert.deepEqual(lastClip(), { left: 0, top: 100, right: 600, bottom: 480 });
    assert.equal(fns.ExcludeClipRect.handler([hdc, 10, 200, 20, 210]), COMPLEXREGION,
        'a hole in the middle cannot be one rectangle');
    assert.deepEqual(lastClip(), { left: 0, top: 100, right: 600, bottom: 480 },
        'so nothing changed');
    assert.equal(fns.ExcludeClipRect.handler([hdc, 700, 0, 800, 480]), SIMPLEREGION,
        'a rectangle outside the clip takes nothing');

    memory.putU32s(STRUCT, [0, 0, 5, 5]);
    assert.equal(fns.RectVisible.handler([hdc, STRUCT]), 0, 'above the excluded band');
    memory.putU32s(STRUCT, [0, 95, 5, 105]);
    assert.equal(fns.RectVisible.handler([hdc, STRUCT]), 1, 'straddling its edge');
    assert.equal(fns.RectVisible.handler([hdc, 0]), 0);

    assert.equal(fns.ExcludeClipRect.handler([hdc, 0, 0, 640, 480]), NULLREGION,
        'everything: nothing is left');
    assert.equal(fns.RectVisible.handler([hdc, STRUCT]), 0);
    assert.equal(fns.ExcludeClipRect.handler([0x9999, 0, 0, 1, 1]), 0);
});

// --- objects a program reads back ---

test('GetObjectA sizes a buffer before it fills one', ()=>{
    const { memory, fns } = setup();
    const pen = fns.CreatePen.handler([0, 3, 0x00ff8040]);

    const size = fns.GetObjectA.handler([pen, 0, 0]);
    assert.equal(size, 16, 'a null buffer asks how large one has to be');
    assert.equal(fns.GetObjectA.handler([pen, size - 4, OUT]), 0,
        'and a buffer too small is refused rather than partly filled');

    assert.equal(fns.GetObjectA.handler([pen, size, OUT]), size);
    assert.equal(memory.u32(OUT + 4), 3, 'the pen reports the width it was created with');
    assert.equal(memory.u32(OUT + 12), 0x00ff8040);

    assert.equal(fns.GetObjectA.handler([0x1234, 16, OUT]), 0, 'a stale handle is not an object');
});

/**
 * A BITMAPINFOHEADER at STRUCT, with its colour table after it.
 *
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {{ width: number, height: number, bitCount: number, colors?: number[],
 *     pels?: number[] }} shape
 */
function putInfo(memory, { width, height, bitCount, colors = [], pels = [0, 0] }){
    memory.putU32s(STRUCT, [40, width, height, 0, 0, 0, pels[0], pels[1], colors.length, 0]);
    memory.bytes.set([1, 0, bitCount, 0], STRUCT + 12);
    memory.putU32s(STRUCT + 40, colors);
}

test('GetObject gives a bitmap the stride its rows have, and a DIB section its pointer', ()=>{
    // Wine's bitmap tests: a device-dependent bitmap's rows pad to a WORD and
    // it has no bits a program can address (bmBits NULL), a DIB section's pad
    // to a DWORD and bmBits is the pointer CreateDIBSection handed out.
    const { memory, fns, hdc } = setup();
    /** @param {number} handle */
    const bitmapOf = handle=>{
        memory.bytes.fill(0xee, OUT, OUT + 24);
        assert.equal(fns.GetObjectA.handler([handle, 24, OUT]), 24);
        return {
            type: memory.u32(OUT), width: memory.u32(OUT + 4), height: memory.u32(OUT + 8),
            widthBytes: memory.u32(OUT + 12), planes: memory.u16(OUT + 16),
            bitsPixel: memory.u16(OUT + 18), bits: memory.u32(OUT + 20),
        };
    };

    assert.deepEqual(bitmapOf(fns.CreateBitmap.handler([15, 15, 1, 1, 0])),
        { type: 0, width: 15, height: 15, widthBytes: 2, planes: 1, bitsPixel: 1, bits: 0 });
    assert.deepEqual(bitmapOf(fns.CreateCompatibleBitmap.handler([hdc, 3, 2])),
        { type: 0, width: 3, height: 2, widthBytes: 12, planes: 1, bitsPixel: 32, bits: 0 });
    memory.putU32s(STRUCT + 0x100, [0, 0]);
    assert.equal(bitmapOf(fns.CreateBitmap.handler([2, 2, 1, 4, STRUCT + 0x100])).bits, 0,
        'bmBits must be NULL for device-dependent bitmaps, whatever lpBits was');

    putInfo(memory, { width: 10, height: -4, bitCount: 24 });
    const section = fns.CreateDIBSection.handler([hdc, STRUCT, 0, OUT + 0x80, 0, 0]);
    const pointer = memory.u32(OUT + 0x80);
    assert.deepEqual(bitmapOf(section), { type: 0, width: 10, height: 4, widthBytes: 32,
        planes: 1, bitsPixel: 24, bits: pointer });
});

test('GetObject fills a DIBSECTION for a DIB section when there is room for one', ()=>{
    const { memory, fns, hdc } = setup();
    putInfo(memory, { width: 16, height: 8, bitCount: 1, colors: [0x00ff0000, 0x000000ff],
        pels: [2835, 1417] });
    const section = fns.CreateDIBSection.handler([hdc, STRUCT, 0, OUT + 0x80, 0, 0]);
    const pointer = memory.u32(OUT + 0x80);

    assert.equal(fns.GetObjectA.handler([section, 0, 0]), 24,
        'the size asked with a null buffer is a BITMAP\'s');
    assert.equal(fns.GetObjectA.handler([section, 80, OUT]), 24, 'short of 84 it is a BITMAP');
    memory.bytes.fill(0xaa, OUT, OUT + 84);
    assert.equal(fns.GetObjectA.handler([section, 84 * 2, OUT]), 84);
    assert.equal(memory.u32(OUT + 20), pointer, 'dsBm.bmBits');
    assert.equal(memory.u32(OUT + 12), 4, 'dsBm.bmWidthBytes: a DWORD-padded row');
    const header = OUT + 24;
    assert.deepEqual([0, 4, 8].map(at=>memory.u32(header + at)), [40, 16, 8],
        'biSize, biWidth and biHeight');
    assert.deepEqual([memory.u16(header + 12), memory.u16(header + 14)], [1, 1]);
    assert.deepEqual([16, 20, 24, 28, 32].map(at=>memory.u32(header + at)),
        [0, 4 * 8, 2835, 1417, 2], 'BI_RGB, the image size, the pels, the table counted in full');
    assert.deepEqual([64, 68, 72, 76, 80].map(at=>memory.u32(OUT + at)), [0, 0, 0, 0, 0],
        'no masks for BI_RGB, no file mapping, no offset');

    // A top-down section reports its height without the sign.
    putInfo(memory, { width: 2, height: -3, bitCount: 32 });
    const topDown = fns.CreateDIBSection.handler([hdc, STRUCT, 0, OUT + 0x80, 0, 0]);
    assert.equal(fns.GetObjectA.handler([topDown, 84, OUT]), 84);
    assert.equal(memory.u32(OUT + 24 + 8), 3);
    assert.equal(memory.u32(OUT + 24 + 32), 0, 'no colour table above eight bits');
});

test('CreateCompatibleBitmap on a DC with a DIB section selected makes a DIB section', ()=>{
    // The CreateCompatibleBitmap documentation: with a DIB section selected,
    // the bitmap it makes is a DIB section -- here in the selected one's
    // format, its depth, masks and colours, over rows of its own.
    const { memory, fns, hdc } = setup();
    const dc = fns.CreateCompatibleDC.handler([hdc]);
    const colors = [...Array(256).keys()].map(index=>index * 0x010203 & 0xffffff);
    putInfo(memory, { width: 4, height: -4, bitCount: 8, colors });
    const section = fns.CreateDIBSection.handler([hdc, STRUCT, 0, OUT + 0x80, 0, 0]);
    const first = memory.u32(OUT + 0x80);
    const previous = fns.SelectObject.handler([dc, section]);

    const made = fns.CreateCompatibleBitmap.handler([dc, 5, 3]);
    memory.bytes.fill(0xaa, OUT, OUT + 84);
    assert.equal(fns.GetObjectA.handler([made, 84, OUT]), 84, 'a DIBSECTION, so a section');
    assert.ok(memory.u32(OUT + 20) !== 0 && memory.u32(OUT + 20) !== first, 'rows of its own');
    assert.deepEqual([4, 8, 12].map(at=>memory.u32(OUT + at)), [5, 3, 8]);
    assert.equal(memory.u16(OUT + 18), 8, 'the section\'s depth, not the screen\'s');
    const other = fns.CreateCompatibleDC.handler([hdc]);
    fns.SelectObject.handler([other, made]);
    memory.bytes.fill(0, OUT, OUT + 1024);
    assert.equal(fns.GetDIBColorTable.handler([other, 0, 256, OUT]), 256);
    assert.deepEqual([...Array(256).keys()].map(index=>memory.u32(OUT + index * 4)), colors);
    fns.SelectObject.handler([other, previous]);

    putInfo(memory, { width: 2, height: 2, bitCount: 16, colors: [0xf800, 0x07e0, 0x001f] });
    memory.putU32s(STRUCT + 16, [3]);
    memory.putU32s(STRUCT + 32, [0]);
    fns.SelectObject.handler([dc, fns.CreateDIBSection.handler([hdc, STRUCT, 0, OUT + 0x80,
        0, 0])]);
    const masked = fns.CreateCompatibleBitmap.handler([dc, 2, 2]);
    assert.equal(fns.GetObjectA.handler([masked, 84, OUT]), 84);
    assert.equal(memory.u16(OUT + 18), 16);
    assert.equal(memory.u32(OUT + 24 + 16), 3, 'BI_BITFIELDS');
    assert.deepEqual([64, 68, 72].map(at=>memory.u32(OUT + at)), [0xf800, 0x07e0, 0x001f]);

    fns.SelectObject.handler([dc, fns.CreateCompatibleBitmap.handler([hdc, 2, 2])]);
    assert.equal(fns.GetObjectA.handler([fns.CreateCompatibleBitmap.handler([dc, 2, 2]), 84,
        OUT]), 24, 'with a device-dependent bitmap selected, a device-dependent bitmap');
});

test('GetObject hands a font back as the LOGFONT it was made from, in either spelling', ()=>{
    const { memory, fns } = setup();
    memory.bytes.set([...'Arial'].map(c=>c.charCodeAt(0)).concat(0), STRUCT);
    const font = fns.CreateFontA.handler([-12, 5, 0, 0, 700, 1, 0, 0, 0xcc, 3, 2, 4, 0x22,
        STRUCT]);

    assert.equal(fns.GetObjectA.handler([font, 0, 0]), 60, 'sizeof(LOGFONTA)');
    assert.equal(fns.GetObjectA.handler([font, 59, OUT]), 0);
    memory.bytes.fill(0xee, OUT, OUT + 92);
    assert.equal(fns.GetObjectA.handler([font, 60, OUT]), 60);
    assert.deepEqual([0, 4, 16].map(at=>memory.u32(OUT + at) | 0), [-12, 5, 700]);
    assert.deepEqual([...memory.bytes.subarray(OUT + 20, OUT + 28)],
        [1, 0, 0, 0xcc, 3, 2, 4, 0x22]);
    assert.equal(decodeAnsi(memory.bytes.subarray(OUT + 28, OUT + 34)),
        'Arial\0');
    assert.equal(memory.bytes[OUT + 60], 0xee, 'nothing past the structure');

    assert.equal(fns.GetObjectW.handler([font, 0, 0]), 92, 'sizeof(LOGFONTW)');
    assert.equal(fns.GetObjectW.handler([font, 92, OUT]), 92);
    assert.deepEqual([...memory.bytes.subarray(OUT + 28, OUT + 40)],
        [0x41, 0, 0x72, 0, 0x69, 0, 0x61, 0, 0x6c, 0, 0, 0], 'the face name in UTF-16');

    const DEFAULT_GUI_FONT = 17;
    assert.equal(fns.GetObjectA.handler([fns.GetStockObject.handler([DEFAULT_GUI_FONT]), 60,
        OUT]), 60, 'a stock font is a font too');
});

test('GetObject on a palette is the WORD count of its entries', ()=>{
    const { memory, fns } = setup();
    memory.putU32s(STRUCT, [0x300 | (3 << 16), 0x00112233, 0x00445566, 0x00778899]);
    const palette = fns.CreatePalette.handler([STRUCT]);

    assert.equal(fns.GetObjectA.handler([palette, 0, 0]), 2);
    assert.equal(fns.GetObjectA.handler([palette, 1, OUT]), 0);
    memory.bytes.fill(0xee, OUT, OUT + 4);
    assert.equal(fns.GetObjectW.handler([palette, 4, OUT]), 2);
    assert.deepEqual([...memory.bytes.subarray(OUT, OUT + 4)], [3, 0, 0xee, 0xee]);
});

test('GetObjectW answers what GetObjectA does for everything but a font', ()=>{
    const { memory, fns } = setup();
    assert.equal(fns.GetObjectW.argBytes, 12);
    const pen = fns.CreatePen.handler([0, 3, 0x00ff8040]);
    assert.equal(fns.GetObjectW.handler([pen, 16, OUT]), 16);
    assert.equal(memory.u32(OUT + 12), 0x00ff8040);
    assert.equal(fns.GetObjectW.handler([0x1234, 16, OUT]), 0);
});

// --- palettes, which exist and change nothing ---

test('a palette is real, selectable, and realizes no entries', ()=>{
    // Every surface here is 32-bit, so there is nothing for a palette to be --
    // but a null handle reads as an error, and reporting that entries changed
    // would send a program off to redraw for no reason.
    const { fns, hdc } = setup();
    const palette = fns.CreateHalftonePalette.handler([hdc]);
    assert.notEqual(palette, 0);

    // A DC is never without a palette: the stock default is selected from the
    // moment it exists, which is what the first call hands back.
    const stock = fns.SelectPalette.handler([hdc, palette, 0]);
    assert.notEqual(stock, 0, 'a device context always has one selected');
    assert.notEqual(stock, palette);

    const second = fns.CreateHalftonePalette.handler([hdc]);
    assert.equal(fns.SelectPalette.handler([hdc, second, 0]), palette,
        'and selecting hands back the one it replaced');

    assert.equal(fns.RealizePalette.handler([hdc]), 0);
    assert.equal(fns.GetDIBColorTable.handler([hdc, 0, 256, OUT]), 0);
});

test('a halftone palette is 256 colours, the default palette\'s first and last eight at its ends',
    ()=>{
        // Wine's test_halftone_palette: 256 entries, the first eight those of
        // the stock default palette and the last eight its last eight, flags
        // clear. What lies between is not pinned.
        const { fns, memory, hdc } = setup();
        const palette = fns.CreateHalftonePalette.handler([hdc]);
        assert.equal(fns.GetPaletteEntries.handler([palette, 0, 0, 0]), 256);
        memory.bytes.fill(0xee, OUT, OUT + 1024);
        assert.equal(fns.GetPaletteEntries.handler([palette, 0, 256, OUT]), 256);
        const DEFAULTS = OUT + 0x400;
        assert.equal(fns.GetPaletteEntries.handler([fns.GetStockObject.handler([15]), 0, 20,
            DEFAULTS]), 20);
        for (let index = 0; index < 8; index++)
        {
            assert.equal(memory.u32(OUT + index * 4), memory.u32(DEFAULTS + index * 4),
                `${index}`);
            assert.equal(memory.u32(OUT + (248 + index) * 4),
                memory.u32(DEFAULTS + (12 + index) * 4), `${248 + index}`);
        }
        const distinct = new Set([...Array(256).keys()].map(index=>memory.u32(OUT + index * 4)));
        assert.ok(distinct.size > 200, 'colours spread over the cube, not one repeated');
        assert.ok([...distinct].every(entry=>(entry >>> 24) === 0), 'no flags');
    });

test('UnrealizeObject succeeds for any live object and fails for one that is not', ()=>{
    // The realization it undoes changes nothing here, so all that is left to get
    // right is the handle check: TRUE for an object that exists -- a brush or a
    // palette, and on modern Windows any other kind too -- FALSE for a handle
    // that names nothing.
    const { fns, hdc } = setup();
    const brush = fns.CreateSolidBrush.handler([0x00112233]);
    const palette = fns.CreateHalftonePalette.handler([hdc]);
    const pen = fns.CreatePen.handler([0, 1, 0x00ffffff]);
    assert.notEqual(brush, 0);
    assert.notEqual(palette, 0);

    assert.equal(fns.UnrealizeObject.handler([brush]), 1, 'a brush can be unrealized');
    assert.equal(fns.UnrealizeObject.handler([palette]), 1, 'and so can a palette');
    assert.equal(fns.UnrealizeObject.handler([pen]), 1,
        'any live object answers TRUE, as modern Windows does');

    assert.equal(fns.UnrealizeObject.handler([0x1234]), 0, 'a stale handle is not an object');
    assert.equal(fns.UnrealizeObject.handler([hdc]), 0,
        'a device context is not a GDI object it can unrealize');

    fns.DeleteObject.handler([brush]);
    assert.equal(fns.UnrealizeObject.handler([brush]), 0,
        'and a handle whose object was deleted no longer names one');
});

// --- pixel formats ---

test('a pixel format is set through the service that OPENGL32 reads, never on the DC', ()=>{
    // A program sets the format through GDI32 and creates its context through
    // OPENGL32; a format kept here would be one the context never sees.
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);

    assert.equal(fns.GetPixelFormat.handler([hdc]), 0, 'nothing is set to begin with');
    assert.equal(fns.SetPixelFormat.handler([hdc, 2, 0]), 1);
    assert.equal(fns.GetPixelFormat.handler([hdc]), 2);
    assert.equal(fns.SetPixelFormat.handler([hdc, 2, 0]), 1, 'the same one again succeeds');
    assert.equal(fns.SetPixelFormat.handler([hdc, 1, 0]), 0, 'a different one does not');
    assert.equal(fns.SetPixelFormat.handler([hdc, 99, 0]), 0, 'nor does one that does not exist');
    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'setPixelFormat').map(call=>call[2]),
        [2, 2, 1, 99], 'every request reached the service, which is where the rule lives');
    assert.equal(fns.SetPixelFormat.handler([0x7777, 2, 0]), 0,
        'a handle that is not a DC is refused here');
});

test('DescribePixelFormat answers with the count whether or not it describes', ()=>{
    const graphics = fakeDrawing();
    const { memory, fns, hdc } = setup(graphics.services);

    assert.equal(fns.DescribePixelFormat.handler([hdc, 1, 40, 0]), 3,
        'a null buffer is how a program asks how many there are');
    assert.equal(fns.DescribePixelFormat.handler([hdc, 2, 40, OUT]), 3);
    assert.equal(memory.bytes[OUT], 2, 'and the one asked for was written');
    assert.equal(fns.DescribePixelFormat.handler([hdc, 9, 40, OUT]), 0,
        'an index past the end describes nothing');
});

test('without a pixel-format service the calls fail rather than inventing one', ()=>{
    const { fns, hdc } = setup();
    assert.equal(fns.ChoosePixelFormat.handler([hdc, STRUCT]), 0);
    assert.equal(fns.SetPixelFormat.handler([hdc, 1, 0]), 0);
    assert.equal(fns.DescribePixelFormat.handler([hdc, 1, 40, OUT]), 0);
});

test('SwapBuffers presents the frame through the graphics layer', ()=>{
    // The end of every frame an OpenGL program draws, and the spelling most of
    // them use -- wglSwapBuffers is the other half of the same operation.
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);

    assert.equal(fns.SwapBuffers.handler([hdc]), 1);
    assert.deepEqual(graphics.calls.at(-1), ['swapBuffers', hdc]);
    assert.equal(fns.SwapBuffers.handler([0]), 0, 'and a handle that is not a DC fails');
});

test('a SwapBuffers the graphics layer holds answers once it lets go', async()=>{
    // Once the device is enough frames behind, the graphics layer answers a
    // swap with what it waits on; the call is still the program's to see
    // succeed, only later.
    const graphics = fakeDrawing();
    /** @type {() => void} */
    let letGo = ()=>{};
    /** @type {any} */ (graphics.services).swapBuffers = ()=>new Promise(resolve=>{
        letGo = ()=>resolve(true);
    });
    const { fns, hdc } = setup(graphics.services);
    const answer = /** @type {Promise<number> | number} */ (
        /** @type {unknown} */ (fns.SwapBuffers.handler([hdc])));
    assert.ok(answer instanceof Promise, 'the call waits');
    letGo();
    assert.equal(await answer, 1);
});

test('SwapBuffers is exported and pops its one argument', ()=>{
    // Missing from the table it would reach the unimplemented-import stub,
    // which cleans up nothing, and the caller would return with its stack four
    // bytes adrift once per frame.
    const { fns, hdc } = setup();

    assert.equal(fns.SwapBuffers.argBytes, 4);
    assert.equal(fns.SwapBuffers.handler([hdc]), 0,
        'a build that cannot draw fails rather than presenting nothing');
});

// --- the gamma ramp ---

test('the gamma ramp read back is the identity, in full', ()=>{
    // A program reads it, adjusts it and writes it back. An untouched buffer
    // would leave it multiplying by whatever happened to be there.
    const { memory, fns, hdc } = setup();

    assert.equal(fns.GetDeviceGammaRamp.handler([hdc, RAMP]), 1);
    assert.equal(memory.u16(RAMP), 0);
    assert.equal(memory.u16(RAMP + 2), 257);
    assert.equal(memory.u16(RAMP + 255 * 2), 65535, 'the red channel ends at full scale');
    assert.equal(memory.u16(RAMP + 256 * 2), 0, 'and green starts again at zero');
    assert.equal(memory.u16(RAMP + (3 * 256 - 1) * 2), 65535);

    assert.equal(fns.SetDeviceGammaRamp.handler([hdc, RAMP]), 1);
    assert.equal(fns.GetDeviceGammaRamp.handler([hdc, 0]), 0, 'a null ramp is a failure');
});

// --- what the newly bound entry points actually reach ---

test('a region reports itself as a well-formed region, and sizes its own buffer', ()=>{
    // A null buffer, or one too small, has to answer with the size a caller
    // must allocate. Answering with failure instead leaves it with nothing to
    // allocate from.
    const { memory, fns } = setup();
    const region = fns.CreateRectRgn.handler([3, 4, 30, 40]);

    const needed = fns.GetRegionData.handler([region, 0, 0]);
    assert.equal(needed, 32 + 16, 'the header, then one rectangle');
    assert.equal(fns.GetRegionData.handler([region, needed - 1, OUT]), needed,
        'a buffer one byte short is still answered with the size, not with failure');

    assert.equal(fns.GetRegionData.handler([region, needed, OUT]), needed);
    assert.equal(memory.u32(OUT), 32, 'dwSize is the header, not the whole buffer');
    assert.equal(memory.u32(OUT + 4), 1, 'RDH_RECTANGLES');
    assert.equal(memory.u32(OUT + 8), 1, 'one rectangle');
    assert.deepEqual(
        [memory.u32(OUT + 16), memory.u32(OUT + 20), memory.u32(OUT + 24), memory.u32(OUT + 28)],
        [3, 4, 30, 40], 'and the bounding box is that rectangle');
    assert.equal(memory.u32(OUT + 32), 3, 'the rectangles follow the header');
});

test('a rectangle is in a region when it shares any pixel with it', ()=>{
    // The question is whether the region has to be redrawn, and one shared
    // pixel says it does -- containment would answer no far too often.
    const { memory, fns } = setup();
    const region = fns.CreateRectRgn.handler([10, 10, 20, 20]);

    memory.putU32s(STRUCT, [15, 15, 25, 25]);
    assert.equal(fns.RectInRegion.handler([region, STRUCT]), 1, 'overlapping');
    memory.putU32s(STRUCT, [20, 20, 30, 30]);
    assert.equal(fns.RectInRegion.handler([region, STRUCT]), 0,
        'touching at the corner is not overlapping: the edge is half-open');
    memory.putU32s(STRUCT, [0, 0, 100, 100]);
    assert.equal(fns.RectInRegion.handler([region, STRUCT]), 1, 'containing');
});

test('palette entries are kept, and only as far as the palette goes', ()=>{
    const { memory, fns } = setup();
    // A palette created from a LOGPALETTE, because that is the one with entries
    // in it: a halftone palette here is empty, and a palette with no entries has
    // nowhere for entries to be set.
    memory.putU32s(STRUCT, [3 << 16 | 0x300, 0, 0, 0]);
    const palette = fns.CreatePalette.handler([STRUCT]);
    assert.notEqual(palette, 0);

    memory.putU32s(STRUCT, [0x11111111, 0x22222222, 0x33333333]);
    const written = fns.SetPaletteEntries.handler([palette, 0, 3, STRUCT]);
    assert.equal(written, 3);

    // Past the end is where the copy stops, not an error -- and the count says
    // where it stopped, which is what a caller checks.
    assert.equal(fns.SetPaletteEntries.handler([palette, 1 << 20, 3, STRUCT]), 0);
    assert.equal(fns.SetPaletteEntries.handler([0x1234, 0, 3, STRUCT]), 0,
        'and a handle that is not a palette is not one');
});

test('the stock default palette holds the twenty colours Windows records for it', ()=>{
    // Wine's metafile tests replay a Windows-recorded CreatePalette of the
    // stock palette: these twenty PALETTEENTRYs, red first. Its palette tests
    // read twenty back, and find SetPaletteEntries refused on it.
    const { memory, fns, hdc } = setup();
    const stock = fns.GetStockObject.handler([15]);
    assert.equal(fns.GetPaletteEntries.argBytes, 16);
    assert.equal(fns.GetPaletteEntries.handler([stock, 0, 0, 0]), 20,
        'a null buffer asks the size');
    assert.equal(fns.GetPaletteEntries.handler([stock, 0, 20, OUT]), 20);
    const colours = [...Array(20).keys()].map(index=>memory.u32(OUT + index * 4));
    assert.deepEqual(colours, [
        0x000000, 0x000080, 0x008000, 0x008080, 0x800000, 0x800080, 0x808000, 0xc0c0c0,
        0xc0dcc0, 0xf0caa6, 0xf0fbff, 0xa4a0a0,
        0x808080, 0x0000ff, 0x00ff00, 0x00ffff, 0xff0000, 0xff00ff, 0xffff00, 0xffffff,
    ].map(bgr=>bgr >>> 0));
    assert.equal(fns.GetPaletteEntries.handler([stock, 18, 5, OUT]), 2, 'only as far as it goes');

    memory.putU32s(STRUCT, [0x00123456]);
    assert.equal(fns.SetPaletteEntries.handler([stock, 0, 1, STRUCT]), 0);
    fns.GetPaletteEntries.handler([stock, 0, 1, OUT]);
    assert.equal(memory.u32(OUT), 0, 'and it is not changed');

    // A DIB_PAL_COLORS table is indices into it from the moment a DC exists.
    memory.putU32s(STRUCT, [40, 1, 1, 1 | 8 << 16, 0, 0, 0, 0, 1, 0]);
    memory.bytes[STRUCT + 40] = 13;
    memory.bytes[STRUCT + 41] = 0;
    const section = fns.CreateDIBSection.handler([hdc, STRUCT, 1, 0, 0, 0]);
    const reader = fns.CreateCompatibleDC.handler([hdc]);
    fns.SelectObject.handler([reader, section]);
    assert.equal(fns.GetDIBColorTable.handler([reader, 0, 1, OUT]), 1);
    assert.equal(memory.u32(OUT), 0x00ff0000, 'entry 13 is red');
});

test('the system palette has no entries to report', ()=>{
    // A system palette exists on a device of eight bits or fewer, and this one
    // is 32. Reporting entries would have a program match colours against a
    // palette nothing draws through.
    const { fns, hdc } = setup();
    assert.equal(fns.GetSystemPaletteEntries.handler([hdc, 0, 16, OUT]), 0);
});

test('the batch limit is kept and the previous one answered, and the palette use is static', ()=>{
    const { fns, hdc } = setup();
    assert.equal(fns.GdiSetBatchLimit.handler([1]), 20, 'the default until one is set');
    assert.equal(fns.GdiSetBatchLimit.handler([0]), 1);
    assert.equal(fns.GdiSetBatchLimit.handler([5]), 20, 'zero asked for the default back');
    assert.equal(fns.GetSystemPaletteUse.handler([hdc]), 1, 'SYSPAL_STATIC');
});

test('text alignment is remembered even with nothing to draw on', ()=>{
    // A program that sets an alignment, draws, and restores must get back what
    // it set. Keeping it only on the drawing service would hand it a zero it
    // never set.
    const { fns, hdc } = setup();

    const TA_RIGHT = 2;
    assert.equal(fns.SetTextAlign.handler([hdc, TA_RIGHT]), 0, 'the default is TA_LEFT');
    assert.equal(fns.GetTextAlign.handler([hdc]), TA_RIGHT);
    assert.equal(fns.SetTextAlign.handler([hdc, 0]), TA_RIGHT, 'and the previous comes back');
    assert.equal(fns.SetTextAlign.handler([0x9999, 0]), 0xffffffff,
        'GDI_ERROR for a handle that is not a device context');
});

test('character widths are an estimate, and the same one text is measured with', ()=>{
    const { memory, fns, hdc } = setup();
    memory.putU32s(OUT, [0xdead, 0xdead, 0xdead, 0xdead, 0xdead, 0xdead]);

    assert.equal(fns.GetCharABCWidthsA.handler([hdc, 0x41, 0x42, OUT]), 1);
    assert.equal(memory.u32(OUT), 0, 'no left bearing');
    assert.notEqual(memory.u32(OUT + 4), 0, 'the advance is the whole cell');
    assert.equal(memory.u32(OUT + 8), 0, 'no right bearing');
    assert.equal(memory.u32(OUT + 12), 0, 'and the second character is written too');
    assert.equal(fns.GetCharABCWidthsA.handler([hdc, 0x42, 0x41, OUT]), 0,
        'a range that runs backwards is not a range');
});

test('the drawing entry points reach the service, and fail without one', ()=>{
    const drawing = fakeDrawing();
    /** @type {any[]} */
    const seen = [];
    const service = /** @type {any} */ (drawing.drawing);
    service.rectangle = (/** @type {any[]} */ ...args)=>{
        seen.push(['rectangle', ...args]);
        return true;
    };
    service.extTextOutA = (/** @type {any[]} */ ...args)=>{
        seen.push(['extTextOutA', ...args]);
        return true;
    };
    const { memory, fns, hdc } = setup(drawing.services);

    assert.equal(fns.Rectangle.handler([hdc, 1, 2, 30, 40]), 1);
    assert.deepEqual(seen[0], ['rectangle', hdc, 1, 2, 30, 40]);

    // The count is authoritative and the string is not terminated: reading to a
    // terminator would draw the rest of the caller's buffer.
    memory.bytes.set([0x41, 0x42, 0x43, 0x44], STRUCT);
    assert.equal(fns.ExtTextOutA.handler([hdc, 5, 6, 0, 0, STRUCT, 2, 0]), 1);
    assert.equal(seen[1][6], 'AB');
    // TextOut is the same: the count, and no terminator anywhere near.
    service.textOutA = (/** @type {any[]} */ ...args)=>{
        seen.push(['textOutA', ...args]);
        return true;
    };
    memory.bytes.fill(0x58, STRUCT, STRUCT + 64);
    assert.equal(fns.TextOutA.handler([hdc, 7, 8, STRUCT, 3]), 1);
    assert.deepEqual(seen[2], ['textOutA', hdc, 7, 8, 'XXX']);

    const bare = setup();
    assert.equal(bare.fns.Rectangle.handler([bare.hdc, 0, 0, 1, 1]), 0);
    assert.equal(bare.fns.ExtTextOutA.handler([bare.hdc, 0, 0, 0, 0, 0, 0, 0]), 0);
});

test('ANSI text is drawn as the characters its bytes are in the ANSI page', ()=>{
    // 0x80 is the euro sign in Windows-1252, 0x99 the trade mark and 0x97 an
    // em dash, as DrawTextA and every other ANSI string read them; the glyphs
    // drawn are those, not the control characters of the same codes.
    const drawing = fakeDrawing();
    /** @type {string[]} */
    const drawn = [];
    const service = /** @type {any} */ (drawing.drawing);
    service.extTextOutA = (/** @type {any[]} */ ...args)=>{
        drawn.push(args[5]);
        return true;
    };
    service.textOutA = (/** @type {any[]} */ ...args)=>{
        drawn.push(args[3]);
        return true;
    };
    const { memory, fns, hdc } = setup(drawing.services);
    memory.bytes.set([0x80, 0x99, 0x97, 0xe9], STRUCT);
    assert.equal(fns.ExtTextOutA.handler([hdc, 0, 0, 0, 0, STRUCT, 4, 0]), 1);
    assert.equal(fns.TextOutA.handler([hdc, 0, 0, STRUCT, 4]), 1);
    assert.deepEqual(drawn, ['€™—é', '€™—é']);
});

test('GetDIBits describes a bitmap before it copies one', ()=>{
    // A null buffer and a biBitCount of zero ask for the bitmap's own shape,
    // which is bookkeeping and answerable without any pixels at all -- and is
    // how a caller sizes the buffer it will ask with next. Wine's
    // test_GetDIBits_BI_BITFIELDS: a sixteen- or thirty-two-bit bitmap is
    // described as BI_BITFIELDS, its masks not yet written, and the answer is 1.
    const { memory, fns, hdc } = setup();
    const bitmap = fns.CreateCompatibleBitmap.handler([hdc, 64, 48]);

    memory.putU32s(STRUCT, [40, ...new Array(12).fill(0)]);
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 48, 0, STRUCT, 0]), 1);
    assert.equal(memory.u32(STRUCT), 40, 'biSize');
    assert.equal(memory.u32(STRUCT + 4), 64, 'biWidth');
    assert.equal(memory.u32(STRUCT + 8), 48, 'biHeight');
    assert.equal(memory.u16(STRUCT + 12), 1, 'biPlanes');
    assert.equal(memory.u16(STRUCT + 14), 32, 'biBitCount');
    assert.equal(memory.u32(STRUCT + 16), 3, 'biCompression: BI_BITFIELDS');
    assert.equal(memory.u32(STRUCT + 20), 64 * 4 * 48, 'biSizeImage');
    assert.deepEqual([40, 44, 48].map(at=>memory.u32(STRUCT + at)), [0, 0, 0]);

    // The rows themselves are pixels, and without a drawing service there are
    // none to copy.
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 48, OUT, STRUCT, 0]), 0);
});

test('GetDIBits keeps the format asked for, sizes the image in it, and names its masks', ()=>{
    // Wine's test_GetDIBits_selected_DDB fills biSizeImage this way before
    // allocating; test_GetDIBits_BI_BITFIELDS reads the masks back.
    const { memory, fns, hdc } = setup();
    const bitmap = fns.CreateCompatibleBitmap.handler([hdc, 10, 4]);

    memory.putU32s(STRUCT, [40, 10, 4, 1 | (24 << 16), 0, 0xdeadbeef, 0, 0, 37, 0]);
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 4, 0, STRUCT, 0]), 1);
    assert.equal(memory.u16(STRUCT + 14), 24, 'the depth asked for, not the bitmap\'s');
    assert.equal(memory.u32(STRUCT + 16), 0, 'nor its compression');
    assert.equal(memory.u32(STRUCT + 20), 32 * 4, 'thirty bytes a row, padded to a DWORD');
    assert.equal(memory.u32(STRUCT + 32), 0, 'biClrUsed');

    memory.putU32s(STRUCT, [40, 10, -4, 1 | (16 << 16), 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 0, OUT, STRUCT, 0]), 1,
        'no lines asks the same question a null buffer does');
    assert.equal(memory.u32(STRUCT + 20), 20 * 4, 'a negative height is still four rows');
    assert.deepEqual([40, 44, 48].map(at=>memory.u32(STRUCT + at)), [0xf800, 0x07e0, 0x001f],
        'sixteen bits read out of a device-dependent bitmap are 5-6-5');
    memory.putU32s(STRUCT + 12, [1 | (32 << 16), 3]);
    fns.GetDIBits.handler([hdc, bitmap, 0, 4, 0, STRUCT, 0]);
    assert.deepEqual([40, 44, 48].map(at=>memory.u32(STRUCT + at)),
        [0x00ff0000, 0x0000ff00, 0x000000ff]);

    // Wine's test_dib_formats: seven bits is no format, and neither is a
    // usage past DIB_PAL_COLORS.
    memory.putU32s(STRUCT, [40, 10, 4, 1 | (7 << 16), 0, 0, 0, 0, 0, 0]);
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 4, 0, STRUCT, 0]), 0);
    assert.equal(memory.u16(STRUCT + 14), 7, 'and a refused header is left as it was');
    memory.putU32s(STRUCT, [40, 10, 4, 1 | (24 << 16), 0, 0, 0, 0, 0, 0]);
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 4, 0, STRUCT, 2]), 0);
});

test('TextOutW reads code units and draws through the same engine as the narrow twin', ()=>{
    const drawing = fakeDrawing();
    const { memory, fns, hdc } = setup(drawing.services);

    // Two bytes per character, the count in characters, and no terminator: a
    // caller drawing part of a longer buffer passes the buffer and a short count.
    memory.bytes.set([0x41, 0, 0x42, 0, 0x43, 0, 0x44, 0], STRUCT);
    assert.equal(fns.TextOutW.handler([hdc, 5, 6, STRUCT, 3]), 1);
    assert.deepEqual(drawing.calls.filter(call=>call[0] === 'textOutA'),
        [['textOutA', hdc, 5, 6, 'ABC']]);

    // A character outside Latin-1 survives, since nothing here narrows it.
    memory.bytes.set([0x14, 0x04], STRUCT);
    assert.equal(fns.TextOutW.handler([hdc, 0, 0, STRUCT, 1]), 1);
    assert.equal(drawing.calls.filter(call=>call[0] === 'textOutA')[1][4], '\u0414');

    assert.equal(fns.TextOutW.argBytes, 20, 'the same five arguments as TextOutA');
    const bare = setup();
    assert.equal(bare.fns.TextOutW.handler([bare.hdc, 0, 0, STRUCT, 1]), 0,
        'and it fails the same way without a drawing service');
});

/**
 * Writes a ramp into guest memory as SetDeviceGammaRamp reads it: red, green
 * and blue, 256 words each.
 *
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {(channel: number, index: number) => number} entry
 */
function putRamp(memory, entry){
    const bytes = new Uint8Array(3 * 256 * 2);
    const view = new DataView(bytes.buffer);
    for (let channel = 0; channel < 3; channel++)
    {
        for (let index = 0; index < 256; index++)
        {
            view.setUint16((channel * 256 + index) * 2, entry(channel, index) & 0xffff, true);
        }
    }
    memory.writeMemory(RAMP, bytes);
}

test('SetDeviceGammaRamp refuses a ramp that strays too far from the identity', ()=>{
    // Wine's gdi32 dc.c test_gamma, one channel changed at a time with the
    // others the identity: a channel of zeros, a flat line of the low byte
    // alone, and one jumping to full at the second entry are refused; a steep
    // line, one that wraps round midway and a staircase are taken. A refused
    // ramp leaves the one before it in effect.
    const { memory, fns, hdc } = setup();
    const identity = (/** @type {number} */ channel, /** @type {number} */ index)=>index * 256;
    /** @param {(index: number) => number} red */
    const tryRed = red=>{
        putRamp(memory, (channel, index)=>(channel === 0 ? red(index) : identity(channel, index)));
        return fns.SetDeviceGammaRamp.handler([hdc, RAMP]);
    };
    assert.equal(tryRed(()=>0), 0, 'zeroes');
    assert.equal(tryRed(index=>index), 0, 'low');
    assert.equal(tryRed(index=>index * 256), 1, 'steep');
    assert.equal(tryRed(index=>(index === 0 ? 0 : index === 1 ? 0x7fff : 0xffff)), 0, 'bright');
    assert.equal(fns.GetDeviceGammaRamp.handler([hdc, RAMP]), 1);
    assert.equal(memory.u16(RAMP + 2 * 2), 2 * 256, 'the steep ramp is still the one in effect');
    assert.equal(tryRed(index=>512 * index), 1, 'wraps midway, exactly half the range out');
    assert.equal(tryRed(index=>256 * (index & ~1)), 1, 'stairs');
    assert.equal(fns.GetDeviceGammaRamp.handler([hdc, RAMP]), 1);
    assert.equal(memory.u16(RAMP + 3 * 2), 2 * 256, 'the staircase reads back as set');
    assert.equal(fns.SetDeviceGammaRamp.handler([hdc, 0]), 0, 'a null ramp is a failure');
});

test('the display\'s ramp is the graphics layer\'s: set there, read back from there', ()=>{
    /** @type {any[]} */
    const set = [];
    /** @type {{ red: Uint16Array, green: Uint16Array, blue: Uint16Array } | null} */
    let inEffect = null;
    let applies = true;
    const graphics = {
        ...fakeDrawing().services,
        /** @param {any} ramp */
        setGammaRamp: ramp=>set.push(ramp),
        gammaRamp: ()=>inEffect,
        appliesGamma: ()=>applies,
    };
    const { memory, fns, hdc } = setup(graphics);

    putRamp(memory, (channel, index)=>(channel === 2 ? 0xffff - index * 256 : index * 256));
    assert.equal(fns.SetDeviceGammaRamp.handler([hdc, RAMP]), 0,
        'an inverted channel is refused before it reaches anything');
    assert.equal(set.length, 0);
    putRamp(memory, (channel, index)=>Math.min(0xffff, index * 256 + channel * 64));
    assert.equal(fns.SetDeviceGammaRamp.handler([hdc, RAMP]), 1);
    assert.equal(set.length, 1);
    assert.deepEqual([set[0].red.length, set[0].green.length, set[0].blue.length],
        [256, 256, 256]);
    assert.deepEqual([set[0].red[1], set[0].green[1], set[0].blue[1]], [256, 320, 384]);

    assert.equal(fns.GetDeviceGammaRamp.handler([hdc, RAMP]), 1);
    assert.equal(memory.u16(RAMP + 2), 257, 'nothing in effect reads back as the identity');
    const shown = Uint16Array.from({ length: 256 }, (_, index)=>(255 - index) * 257);
    inEffect = { red: shown, green: shown, blue: shown };
    assert.equal(fns.GetDeviceGammaRamp.handler([hdc, RAMP]), 1);
    assert.equal(memory.u16(RAMP), 0xffff, 'whatever ramp the display shows, whoever set it');
    assert.equal(memory.u16(RAMP + (512 + 255) * 2), 0);

    const COLORMGMTCAPS = 121;
    const CM_GAMMA_RAMP = 2;
    assert.equal(fns.GetDeviceCaps.handler([hdc, COLORMGMTCAPS]), CM_GAMMA_RAMP);
    applies = false;
    assert.equal(fns.GetDeviceCaps.handler([hdc, COLORMGMTCAPS]), 0,
        'claimed only where a ramp reaches the picture');
});

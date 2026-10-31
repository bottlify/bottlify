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
import {
    arcPoints, bezierPoints, isPolyDrawable, lineDdaPoints, roundRectPoints,
} from './drawing.js';
import { createGdiFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { painted, pens } from './fixtures.test.js';

const HWND = 0x2000;
const STRUCT = 0x30000;
const OUT = 0x30400;
const RAMP = 0x31000;

const RGN_AND = 1;
const RGN_OR = 2;
const RGN_DIFF = 4;
const RGN_COPY = 5;
const NULLREGION = 1;
const SIMPLEREGION = 2;

const PATCOPY = 0x00f00021;
const DIB_RGB_COLORS = 0;
const DIB_PAL_COLORS = 1;
const SRCCOPY = 0x00cc0020;
const FLOODFILLSURFACE = 1;

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
        /** @param {number} hdc @param {any[]} rects */
        setClipRegion(hdc, rects){
            calls.push(['setClipRegion', hdc, rects]);
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
        /** @param {number} hdc @param {any[]} points */
        polygon(hdc, points){
            calls.push(['polygon', hdc, points]);
            return true;
        },
        /** @param {number} hdc @param {number[]} box */
        ellipse(hdc, ...box){
            calls.push(['ellipse', hdc, ...box]);
            return true;
        },
        /** @param {number} hdc @param {number} x @param {number} y */
        moveToEx(hdc, x, y){
            calls.push(['moveToEx', hdc, x, y]);
            return { x: 1, y: 2 };
        },
        /** @param {number} hdc @param {number} x @param {number} y @param {number} color */
        setPixel(hdc, x, y, color){
            calls.push(['setPixel', hdc, x, y, color]);
        },
        getPixel: ()=>0x00112233,
        /** @param {number} hdc @param {number} x @param {number} y @param {string} text */
        /**
         * @param {number} hdc @param {number} x @param {number} y @param {number} options
         * @param {any} rect @param {string} text
         */
        extTextOutA(hdc, x, y, options, rect, text){
            calls.push(['extTextOutA', hdc, x, y, options, rect, text]);
            return true;
        },
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
function setup(graphics, more = {}){
    const memory = fakeMemory();
    const fns = createGdiFunctions({
        ...more,
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
    // Guest memory can grow in place, which detaches every view of it
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

    // The memory's buffer is replaced: the bound view goes empty.
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

test('StretchDIBits reads a DIB\'s bits and colours only when the drawing asks for them', ()=>{
    // A window that repaints one bar of itself draws its whole picture into a
    // clip that leaves the picture out; the drawing does not look at the bits
    // then, and they are not copied out of the guest for nothing.
    /** @type {any[]} */
    const asked = [];
    const graphics = fakeDrawing();
    /** @param {number} hdc @param {any} request */
    const stretchDIBits = (hdc, request)=>{
        asked.push(request.image);
        return 1;
    };
    /** @type {any} */ (graphics.drawing).stretchDIBits = stretchDIBits;
    const { fns, hdc, memory } = setup(graphics.services);
    const read = memory.readMemory;
    let bitsRead = 0;
    memory.readMemory = (address, length)=>{
        bitsRead += address === 0x2000 ? 1 : 0;
        return read(address, length);
    };
    memory.putU32s(0x800, [40, 2, 2, 0x00080001]);
    assert.equal(fns.StretchDIBits.handler(
        [hdc, 0, 0, 4, 4, 0, 0, 2, 2, 0x2000, 0x800, DIB_RGB_COLORS, SRCCOPY]), 1);
    assert.equal(bitsRead, 0, 'a drawing that leaves the picture out reads none of it');
    memory.bytes.set([0xab, 0, 0, 0, 0xcd], 0x2000);
    assert.equal(asked[0].bits[0], 0xab, 'and one that draws it reads the bits as they are');
    assert.equal(bitsRead, 1);
    assert.equal(asked[0].colors.length, 256);
    assert.equal(asked[0].bits, asked[0].bits, 'once');
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

test('a region combines exactly: two far-apart rectangles are two, not the span', ()=>{
    const { memory, fns } = setup();
    const left = fns.CreateRectRgn.handler([0, 0, 10, 10]);
    const right = fns.CreateRectRgn.handler([20, 20, 30, 30]);
    const destination = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    const pieces = ()=>{
        const size = fns.GetRegionData.handler([destination, 0, 0]);
        fns.GetRegionData.handler([destination, size, OUT]);
        return Array.from({ length: memory.u32(OUT + 8) }, (_, index)=>[0, 4, 8, 12]
            .map(at=>memory.u32(OUT + 32 + index * 16 + at) | 0));
    };

    assert.equal(fns.CombineRgn.handler([destination, left, right, RGN_OR]), 3, 'COMPLEXREGION');
    assert.deepEqual(pieces(), [[0, 0, 10, 10], [20, 20, 30, 30]]);
    assert.equal(fns.CombineRgn.handler([destination, left, right, RGN_AND]), NULLREGION);
    assert.deepEqual(pieces(), []);
    assert.equal(fns.CombineRgn.handler([destination, left, 0, RGN_COPY]), SIMPLEREGION,
        'COPY reads only the first');
    assert.deepEqual(pieces(), [[0, 0, 10, 10]]);
    assert.equal(fns.CombineRgn.handler([destination, left, 0, RGN_OR]), 0,
        'any other mode needs a second region');
    assert.equal(fns.CombineRgn.handler([destination, left, right, 99]), 0,
        'an unknown mode is an error, not a default');
    const middle = fns.CreateRectRgn.handler([2, 2, 8, 8]);
    assert.equal(fns.CombineRgn.handler([destination, left, middle, RGN_DIFF]), 3);
    assert.deepEqual(pieces(), [[0, 0, 10, 2], [0, 2, 2, 8], [8, 2, 10, 8], [0, 8, 10, 10]],
        'a hole is a frame, in bands');
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
    // With no clip the region is never looked at (Wine's clipping.c test_GetClipRgn).
    assert.equal(fns.GetClipRgn.handler([hdc, 0]), 0, 'a null region, no clip');
    fns.SelectClipRgn.handler([hdc, selected]);
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

    // SetRectRgn makes an existing region that rectangle.
    const region = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    assert.equal(fns.SetRectRgn.handler([region, 7, 8, 30, 40]), 1);
    assert.equal(fns.GetRgnBox.handler([region, BOX]), SIMPLEREGION);
    assert.deepEqual(box(), [7, 8, 30, 40]);
    assert.equal(fns.SetRectRgn.handler([0x9999, 0, 0, 1, 1]), 0, 'not a region');

    // EqualRgn: the same pixels, two empty ones equal wherever they are.
    const same = fns.CreateRectRgn.handler([7, 8, 30, 40]);
    assert.equal(fns.EqualRgn.handler([region, same]), 1);
    fns.SetRectRgn.handler([same, 7, 8, 30, 41]);
    assert.equal(fns.EqualRgn.handler([region, same]), 0);
    assert.equal(fns.EqualRgn.handler([fns.CreateRectRgn.handler([1, 1, 1, 5]),
        fns.CreateRectRgn.handler([9, 9, 3, 9])]), 1, 'two empty regions');
    assert.equal(fns.EqualRgn.handler([region, 0x9999]), 0, 'ERROR');
});

test('GetRandomRgn\'s SYSRGN is where on the screen a window\'s context draws', ()=>{
    const graphics = fakeDrawing();
    const memory = fakeMemory();
    const gdi = createGdiFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        surfaces: fakeSurfaces(),
        graphics: graphics.services,
    });
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (gdi.table));
    const BOX = 0x3000;
    const hdc = gdi.windowContext(HWND, { left: 100, top: 50, right: 300, bottom: 200 });
    const region = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    assert.equal(fns.GetRandomRgn.handler([hdc, region, 4]), 1);
    fns.GetRgnBox.handler([region, BOX]);
    assert.deepEqual([0, 4, 8, 12].map(at=>new DataView(memory.bytes.buffer).getInt32(BOX + at,
        true)), [100, 50, 300, 200], 'the window\'s area, in screen coordinates');
    assert.equal(fns.GetRandomRgn.handler([hdc, region, 2]), 0, 'METARGN holds nothing');
    assert.equal(fns.GetRandomRgn.handler([hdc, 0x9999, 4]), 0xffffffff, 'no region');
});

test('IntersectClipRect narrows the clip, and the program has then selected one', ()=>{
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    const region = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    const lastClip = ()=>graphics.calls.filter(call=>call[0] === 'setClipRect').at(-1)?.[2];
    assert.equal(fns.IntersectClipRect.handler([hdc, 10, 20, 50, 60]), SIMPLEREGION);
    assert.deepEqual(lastClip(), { left: 10, top: 20, right: 50, bottom: 60 });
    assert.equal(fns.IntersectClipRect.handler([hdc, 40, 0, 100, 30]), SIMPLEREGION);
    assert.deepEqual(lastClip(), { left: 40, top: 20, right: 50, bottom: 30 });
    assert.equal(fns.GetClipRgn.handler([hdc, region]), 1);
    assert.equal(fns.IntersectClipRect.handler([hdc, 0, 0, 5, 5]), NULLREGION, 'nothing left');
    assert.equal(fns.IntersectClipRect.handler([0x9999, 0, 0, 5, 5]), 0, 'not a context');
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

test('a band excluded from the clip is taken off; a hole leaves a frame of four pieces', ()=>{
    const graphics = fakeDrawing();
    const { fns, memory, hdc } = setup(graphics.services);
    const COMPLEXREGION = 3;
    const lastClip = ()=>graphics.calls.filter(call=>call[0] === 'setClipRect').at(-1)?.[2];
    const lastRegion = ()=>graphics.calls.filter(call=>call[0] === 'setClipRegion').at(-1)?.[2];

    assert.equal(fns.ExcludeClipRect.argBytes, 20);
    assert.equal(fns.ExcludeClipRect.handler([hdc, 0, 0, 640, 100]), SIMPLEREGION,
        'a band across the top');
    assert.deepEqual(lastClip(), { left: 0, top: 100, right: 640, bottom: 480 });
    assert.equal(fns.ExcludeClipRect.handler([hdc, 600, 0, 700, 480]), SIMPLEREGION,
        'a band down the right, reaching past the surface');
    assert.deepEqual(lastClip(), { left: 0, top: 100, right: 600, bottom: 480 });
    assert.equal(fns.ExcludeClipRect.handler([hdc, 10, 200, 20, 210]), COMPLEXREGION,
        'a hole in the middle');
    assert.deepEqual(lastRegion(), [
        { left: 0, top: 100, right: 600, bottom: 200 },
        { left: 0, top: 200, right: 10, bottom: 210 },
        { left: 20, top: 200, right: 600, bottom: 210 },
        { left: 0, top: 210, right: 600, bottom: 480 },
    ], 'is the clip round it');
    assert.equal(fns.ExcludeClipRect.handler([hdc, 700, 0, 800, 480]), COMPLEXREGION,
        'a rectangle outside the clip takes nothing');

    memory.putU32s(STRUCT, [0, 0, 5, 5]);
    assert.equal(fns.RectVisible.handler([hdc, STRUCT]), 0, 'above the excluded band');
    memory.putU32s(STRUCT, [0, 95, 5, 105]);
    assert.equal(fns.RectVisible.handler([hdc, STRUCT]), 1, 'straddling its edge');
    memory.putU32s(STRUCT, [11, 201, 19, 209]);
    assert.equal(fns.RectVisible.handler([hdc, STRUCT]), 0, 'inside the hole');
    assert.equal(fns.RectVisible.handler([hdc, 0]), 0);

    assert.equal(fns.IntersectClipRect.handler([hdc, 0, 150, 600, 205]), COMPLEXREGION,
        'narrowing keeps the hole');
    assert.deepEqual(lastRegion(), [
        { left: 0, top: 150, right: 600, bottom: 200 },
        { left: 0, top: 200, right: 10, bottom: 205 },
        { left: 20, top: 200, right: 600, bottom: 205 },
    ]);
    assert.equal(fns.IntersectClipRect.handler([hdc, 30, 150, 600, 205]), SIMPLEREGION,
        'and drops it once the rest is one rectangle');
    assert.deepEqual(lastClip(), { left: 30, top: 150, right: 600, bottom: 205 });

    assert.equal(fns.ExcludeClipRect.handler([hdc, 0, 0, 640, 480]), NULLREGION,
        'everything: nothing is left');
    assert.equal(fns.RectVisible.handler([hdc, STRUCT]), 0);
    assert.equal(fns.ExcludeClipRect.handler([0x9999, 0, 0, 1, 1]), 0);
});

test('RestoreDC puts back the clip SaveDC found, a region too', ()=>{
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    const last = ()=>graphics.calls.filter(call=>call[0] === 'setClipRect'
        || call[0] === 'setClipRegion').at(-1);
    assert.equal(fns.ExcludeClipRect.handler([hdc, 10, 10, 20, 20]), 3);
    const level = fns.SaveDC.handler([hdc]);
    assert.equal(fns.IntersectClipRect.handler([hdc, 0, 0, 5, 5]), SIMPLEREGION);
    assert.deepEqual(last(), ['setClipRect', hdc, { left: 0, top: 0, right: 5, bottom: 5 }]);
    assert.equal(fns.RestoreDC.handler([hdc, level]), 1);
    assert.equal(last()?.[0], 'setClipRegion', 'the frame round the hole again');
    assert.equal(last()?.[2].length, 4);
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

test('a 64-bit process\'s GetObject has bmBits, dshSection and a brush\'s hatch a quadword wide',
    ()=>{
        // wingdi.h under _WIN64: the pointer-sized field on an eight-byte
        // boundary, the structure padded to eight.
        const { memory, fns, hdc } = setup(undefined, { pointerSize: 8 });
        const brush = fns.CreateSolidBrush.handler([0x00112233]);
        assert.equal(fns.GetObjectA.handler([brush, 0, 0]), 16, 'LOGBRUSH');
        assert.equal(fns.GetObjectA.handler([brush, 16, OUT]), 16);
        assert.equal(memory.u32(OUT + 4), 0x00112233);

        putInfo(memory, { width: 16, height: 8, bitCount: 32 });
        const section = fns.CreateDIBSection.handler([hdc, STRUCT, 0, OUT + 0x100, 0, 0]);
        const pointer = memory.u32(OUT + 0x100);
        assert.equal(fns.GetObjectA.handler([section, 0, 0]), 32, 'BITMAP');
        memory.bytes.fill(0xaa, OUT, OUT + 104);
        assert.equal(fns.GetObjectA.handler([section, 32, OUT]), 32);
        assert.deepEqual([memory.u32(OUT + 24), memory.u32(OUT + 28)], [pointer, 0],
            'bmBits at 24, both halves');
        assert.equal(fns.GetObjectA.handler([section, 103, OUT]), 32, 'short of 104 a BITMAP');
        assert.equal(fns.GetObjectA.handler([section, 104, OUT]), 104, 'DIBSECTION');
        assert.deepEqual([0, 4, 8].map(at=>memory.u32(OUT + 32 + at)), [40, 16, 8],
            'dsBmih at 32');
        assert.deepEqual([88, 92, 96].map(at=>memory.u32(OUT + at)), [0, 0, 0],
            'dshSection a quadword at 88, dsOffset at 96');
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
    // TextOut is ExtTextOut with no options, rectangle or advances: the
    // count, and no terminator anywhere near.
    memory.bytes.fill(0x58, STRUCT, STRUCT + 64);
    assert.equal(fns.TextOutA.handler([hdc, 7, 8, STRUCT, 3]), 1);
    assert.deepEqual(seen[2], ['extTextOutA', hdc, 7, 8, 0, null, 'XXX', undefined]);

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
    assert.deepEqual(drawing.calls.filter(call=>call[0] === 'extTextOutA'),
        [['extTextOutA', hdc, 5, 6, 0, null, 'ABC']]);

    // A character outside Latin-1 survives, since nothing here narrows it.
    memory.bytes.set([0x14, 0x04], STRUCT);
    assert.equal(fns.TextOutW.handler([hdc, 0, 0, STRUCT, 1]), 1);
    assert.equal(drawing.calls.filter(call=>call[0] === 'extTextOutA')[1][6], '\u0414');

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

test('the pixel-format calls on a handle that is no DC say why with the last error', ()=>{
    /** @type {number[]} */
    const errors = [];
    const graphics = fakeDrawing();
    const memory = fakeMemory();
    const fns = /** @type {any} */ (createGdiFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        surfaces: fakeSurfaces(),
        graphics: graphics.services,
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    }).table);
    const STALE = 0x9999;
    assert.equal(fns.GetPixelFormat.handler([STALE]), 0);
    assert.equal(fns.SetPixelFormat.handler([STALE, 1, 0]), 0);
    assert.equal(fns.DescribePixelFormat.handler([STALE, 0, 0, 0]), 0);
    assert.equal(fns.ChoosePixelFormat.handler([STALE, 0x100]), 0);
    assert.equal(fns.SwapBuffers.handler([STALE]), 0);
    // Wine's opengl32 test_setpixelformat: the format query alone says the
    // format is bad; the rest say the handle is.
    assert.deepEqual(errors, [2000, 6, 6, 6, 6]);
});

test('an arc runs counterclockwise from the start radial to the end one', ()=>{
    const quarter = arcPoints(0, 0, 20, 20, 20, 10, 10, 0);
    assert.deepEqual(quarter[0], { x: 20, y: 10 }, 'starts on the right');
    assert.deepEqual(quarter.at(-1), { x: 10, y: 0 }, 'ends at the top');
    assert.ok(quarter.every(point=>point.x >= 10 && point.y <= 10), 'the upper right quarter');
    const whole = arcPoints(0, 0, 20, 20, 20, 10, 20, 10);
    assert.ok(whole.some(point=>point.x === 0), 'the same radial twice is the whole ellipse');
});

test('Arc draws with the pen and puts the current position back', ()=>{
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    assert.equal(fns.Arc.handler([hdc, 0, 0, 20, 20, 20, 10, 10, 0]), 1);
    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'moveToEx').at(-1),
        ['moveToEx', hdc, 1, 2]);
    assert.ok(graphics.calls.filter(call=>call[0] === 'lineTo').length >= 8);
    assert.equal(fns.Arc.handler([0x7777, 0, 0, 1, 1, 0, 0, 0, 0]), 0, 'not a DC');
});

test('Polyline draws through its points and keeps the position, PolylineTo moves it', ()=>{
    const graphics = fakeDrawing();
    const { memory, fns, hdc } = setup(graphics.services);
    const at = 0x500;
    memory.writeMemory(at, new Uint8Array(new Int32Array([3, 4, 30, 4, 50, -6]).buffer));
    assert.equal(fns.Polyline.handler([hdc, at, 3]), 1);
    const drawn = graphics.calls.filter(call=>call[0] === 'moveToEx' || call[0] === 'lineTo');
    assert.deepEqual(drawn.slice(-4), [
        ['moveToEx', hdc, 3, 4], ['lineTo', hdc, 30, 4], ['lineTo', hdc, 50, -6],
        ['moveToEx', hdc, 1, 2],
    ], 'from the first point, and back where the position was');
    assert.equal(fns.Polyline.handler([hdc, at, 1]), 0, 'one point is no line');
    assert.equal(fns.Polyline.handler([0x7777, at, 3]), 0, 'not a DC');
    const before = graphics.calls.length;
    assert.equal(fns.PolylineTo.handler([hdc, at, 2]), 1);
    assert.deepEqual(graphics.calls.slice(before), [['lineTo', hdc, 3, 4], ['lineTo', hdc, 30, 4]],
        'from the current position on');
});

test('a rounded rectangle is a polygon inside its box, square where the corners are flat', ()=>{
    const points = roundRectPoints({ left: 10, top: 10, right: 40, bottom: 25 }, 3, 4.5);
    assert.ok(points.every(({ x, y })=>x >= 10 && x <= 39 && y >= 10 && y <= 24));
    assert.ok(!points.some(({ x, y })=>x === 10 && y === 10), 'the corner itself is cut');
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    assert.equal(fns.RoundRect.handler([hdc, 10, 10, 40, 25, -6, -9]), 1, 'the sign is dropped');
    assert.equal(graphics.calls.at(-1)[0], 'polygon');
    assert.equal(fns.Ellipse.handler([hdc, 0, 0, 5, 5]), 1);
    assert.deepEqual(graphics.calls.at(-1), ['ellipse', hdc, 0, 0, 5, 5]);
});

test('the arc direction is the DC\'s, and a clockwise Arc runs the other way round', ()=>{
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    assert.equal(fns.GetArcDirection.handler([hdc]), 1, 'counterclockwise to begin with');
    assert.equal(fns.SetArcDirection.handler([hdc, 2]), 1);
    assert.equal(fns.SetArcDirection.handler([hdc, 3]), 0, 'no such direction');
    assert.equal(fns.GetArcDirection.handler([hdc]), 2);
    fns.Arc.handler([hdc, 0, 0, 20, 20, 20, 10, 10, 0]);
    const drawn = graphics.calls.filter(call=>call[0] === 'lineTo').map(([, , x, y])=>({ x, y }));
    assert.ok(drawn.some(({ x })=>x === 0), 'the long way round, past the left side');
});

// --- curves from the current position, and the clip combined and moved ---

/**
 * The recording service, with the current position kept where the real
 * drawing context keeps it: on the DC record bind is handed, which a line
 * moves and GetCurrentPositionEx reads.
 */
function positionedDrawing(){
    const graphics = fakeDrawing();
    /** @type {Map<number, any>} */
    const states = new Map();
    /** @type {any} */
    const drawing = graphics.drawing;
    /** @param {number} hdc @param {any} surface @param {any} state */
    drawing.bind = (hdc, surface, state)=>{
        graphics.calls.push(['bind', hdc]);
        states.set(hdc, state);
    };
    /** @param {number} hdc @param {number} x @param {number} y */
    drawing.lineTo = (hdc, x, y)=>{
        graphics.calls.push(['lineTo', hdc, x, y]);
        states.get(hdc).position = { x, y };
    };
    /** @param {number} hdc @param {number} x @param {number} y */
    drawing.moveToEx = (hdc, x, y)=>{
        graphics.calls.push(['moveToEx', hdc, x, y]);
        const previous = states.get(hdc).position;
        states.get(hdc).position = { x, y };
        return previous;
    };
    /** @param {number} hdc @param {number} x @param {number} y */
    drawing.setBrushOrgEx = (hdc, x, y)=>{
        graphics.calls.push(['setBrushOrgEx', hdc, x, y]);
        return true;
    };
    return graphics;
}

/** @param {ReturnType<typeof setup>} context */
const positionOf = ({ fns, memory, hdc })=>{
    assert.equal(fns.GetCurrentPositionEx.handler([hdc, OUT]), 1);
    const view = new DataView(memory.bytes.buffer);
    return { x: view.getInt32(OUT, true), y: view.getInt32(OUT + 4, true) };
};

/** @param {any[]} calls */
const linesIn = calls=>calls.filter(call=>call[0] === 'lineTo' || call[0] === 'moveToEx')
    .map(([name, , x, y])=>[name, x, y]);

test('a Bézier curve starts and ends on its own points and never repeats one', ()=>{
    const curve = bezierPoints({ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 0 });
    assert.deepEqual(curve[0], { x: 0, y: 0 });
    assert.deepEqual(curve.at(-1), { x: 30, y: 0 });
    assert.ok(curve.length > 10, 'a segment for every couple of pixels');
    assert.ok(curve.every(({ y })=>y >= 0 && y <= 23), 'inside the hull, short of the controls');
    assert.ok(curve.slice(1).every((point, index)=>point.x !== curve[index].x
        || point.y !== curve[index].y), 'no point twice in a row');
    assert.ok(bezierPoints({ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 20, y: 5 }, { x: 40, y: 5 })
        .every(({ y })=>y === 5), 'controls on the line keep the curve on it');
    assert.deepEqual(bezierPoints({ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }),
        [{ x: 3, y: 3 }]);
});

test('ArcTo draws a line to the arc and the arc, and leaves the position at its end', ()=>{
    assert.equal(setup().fns.ArcTo.handler([setup().hdc, 0, 0, 20, 20, 20, 10, 10, 0]), 0,
        'nothing to draw with');
    const graphics = positionedDrawing();
    const context = setup(graphics.services);
    const { fns, hdc } = context;
    assert.equal(fns.ArcTo.argBytes, 36);
    fns.MoveToEx.handler([hdc, 50, 50, 0]);
    const before = graphics.calls.length;
    assert.equal(fns.ArcTo.handler([hdc, 0, 0, 20, 20, 20, 10, 10, 0]), 1);
    const drawn = linesIn(graphics.calls.slice(before));
    // The ellipse leaves the rectangle's right edge out, as Ellipse does.
    assert.deepEqual(drawn[0], ['lineTo', 19, 10], 'from (50, 50) to where the arc starts');
    assert.ok(drawn.every(([name])=>name === 'lineTo'), 'one stroke, no move');
    assert.deepEqual(positionOf(context), { x: 10, y: 0 }, 'and the arc\'s end is the position');

    fns.SetArcDirection.handler([hdc, 2]);
    fns.MoveToEx.handler([hdc, 0, 0, 0]);
    const clockwise = graphics.calls.length;
    fns.ArcTo.handler([hdc, 0, 0, 20, 20, 20, 10, 10, 0]);
    assert.deepEqual(linesIn(graphics.calls.slice(clockwise))[0], ['lineTo', 19, 10]);
    assert.deepEqual(positionOf(context), { x: 10, y: 0 }, 'clockwise ends there too');
    assert.ok(linesIn(graphics.calls.slice(clockwise)).some(([, x])=>x === 0),
        'having gone the long way round');
    assert.equal(fns.ArcTo.handler([0x7777, 0, 0, 1, 1, 0, 0, 0, 0]), 0, 'not a DC');
});

test('PolyBezierTo draws whole curves from the current position and moves it', ()=>{
    const graphics = positionedDrawing();
    const context = setup(graphics.services);
    const { fns, memory, hdc } = context;
    const at = 0x500;
    memory.writeMemory(at, new Uint8Array(new Int32Array([
        0, 20, 20, 20, 20, 0,
        20, -20, 40, -20, 40, 0,
    ]).buffer));
    assert.equal(fns.PolyBezierTo.argBytes, 12);
    assert.equal(fns.PolyBezierTo.handler([hdc, at, 4]), 0, 'not a whole number of curves');
    assert.equal(fns.PolyBezierTo.handler([hdc, at, 0]), 0, 'no curve at all');
    assert.equal(linesIn(graphics.calls).length, 0, 'and nothing was drawn for either');

    assert.equal(fns.PolyBezierTo.handler([hdc, at, 6]), 1);
    const drawn = linesIn(graphics.calls);
    assert.ok(drawn.length > 6 && drawn.every(([name])=>name === 'lineTo'));
    assert.ok(drawn.some(([, x, y])=>x === 20 && y === 0), 'through the first curve\'s end');
    assert.deepEqual(drawn.at(-1), ['lineTo', 40, 0]);
    assert.deepEqual(positionOf(context), { x: 40, y: 0 });
    assert.equal(setup().fns.PolyBezierTo.handler([setup().hdc, at, 3]), 0,
        'nothing to draw with');
});

test('PolyDraw moves, lines, curves and closes, and refuses a type array Windows would', ()=>{
    const PT_CLOSEFIGURE = 1;
    const PT_LINETO = 2;
    const PT_BEZIERTO = 4;
    const PT_MOVETO = 6;
    assert.ok(isPolyDrawable(Uint8Array.of(PT_MOVETO, PT_LINETO, PT_LINETO | PT_CLOSEFIGURE)));
    assert.ok(isPolyDrawable(Uint8Array.of(PT_BEZIERTO, PT_BEZIERTO,
        PT_BEZIERTO | PT_CLOSEFIGURE)));
    assert.ok(!isPolyDrawable(Uint8Array.of(PT_BEZIERTO, PT_BEZIERTO)), 'a curve cut short');
    assert.ok(!isPolyDrawable(Uint8Array.of(PT_BEZIERTO, PT_BEZIERTO | PT_CLOSEFIGURE,
        PT_BEZIERTO)), 'a close inside a curve');
    assert.ok(!isPolyDrawable(Uint8Array.of(PT_MOVETO | PT_CLOSEFIGURE)), 'a closing move');
    assert.ok(!isPolyDrawable(Uint8Array.of(0)), 'no type');

    const graphics = positionedDrawing();
    const context = setup(graphics.services);
    const { fns, memory, hdc } = context;
    const points = 0x500;
    const types = 0x600;
    memory.writeMemory(points, new Uint8Array(new Int32Array([
        10, 10, 30, 10, 30, 30,
        100, 100, 100, 120, 120, 120, 120, 100,
    ]).buffer));
    memory.writeMemory(types, Uint8Array.of(PT_MOVETO, PT_LINETO, PT_LINETO | PT_CLOSEFIGURE,
        PT_MOVETO, PT_BEZIERTO, PT_BEZIERTO, PT_BEZIERTO | PT_CLOSEFIGURE));
    assert.equal(fns.PolyDraw.argBytes, 16);
    assert.equal(fns.PolyDraw.handler([hdc, points, types, 6]), 0,
        'the curve is cut short by the count');
    assert.equal(linesIn(graphics.calls).length, 0, 'and nothing is drawn of what came before');

    assert.equal(fns.PolyDraw.handler([hdc, points, types, 7]), 1);
    const drawn = linesIn(graphics.calls);
    assert.deepEqual(drawn.slice(0, 5), [
        ['moveToEx', 10, 10], ['lineTo', 30, 10], ['lineTo', 30, 30], ['lineTo', 10, 10],
        ['moveToEx', 100, 100],
    ], 'the triangle closed back to its move');
    assert.deepEqual(drawn.at(-2), ['lineTo', 120, 100], 'the curve to its end');
    assert.deepEqual(drawn.at(-1), ['lineTo', 100, 100], 'and closed back to the second move');
    assert.deepEqual(positionOf(context), { x: 100, y: 100 });

    // With no move, the figure starts at the position the call found.
    fns.MoveToEx.handler([hdc, 5, 6, 0]);
    memory.writeMemory(types, Uint8Array.of(PT_LINETO | PT_CLOSEFIGURE));
    const before = graphics.calls.length;
    assert.equal(fns.PolyDraw.handler([hdc, points, types, 1]), 1);
    assert.deepEqual(linesIn(graphics.calls.slice(before)),
        [['lineTo', 10, 10], ['lineTo', 5, 6]]);
    assert.equal(fns.PolyDraw.handler([hdc, points, types, 0]), 1, 'nothing to draw is drawn');
    assert.equal(fns.PolyDraw.handler([hdc, points, types, -1]), 0);
    assert.equal(fns.PolyDraw.handler([0x7777, points, types, 1]), 0, 'not a DC');
});

test('ExtSelectClipRgn combines the region into the clip in each mode, exactly', ()=>{
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);
    const COMPLEXREGION = 3;
    const RGN_XOR = 3;
    const lastClip = ()=>graphics.calls.filter(call=>call[0] === 'setClipRect'
        || call[0] === 'setClipRegion').at(-1)?.[2];
    /** @param {any} area */
    const sorted = area=>[...area].sort((a, b)=>a.top - b.top || a.left - b.left);
    const band = fns.CreateRectRgn.handler([0, 0, 100, 50]);
    const square = fns.CreateRectRgn.handler([50, 25, 150, 75]);
    assert.equal(fns.ExtSelectClipRgn.argBytes, 12);

    assert.equal(fns.ExtSelectClipRgn.handler([hdc, band, RGN_AND]), SIMPLEREGION,
        'with no clip, AND is the region inside the surface');
    assert.deepEqual(lastClip(), { left: 0, top: 0, right: 100, bottom: 50 });
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, square, RGN_AND]), SIMPLEREGION);
    assert.deepEqual(lastClip(), { left: 50, top: 25, right: 100, bottom: 50 });

    assert.equal(fns.ExtSelectClipRgn.handler([hdc, band, RGN_COPY]), SIMPLEREGION);
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, square, RGN_OR]), COMPLEXREGION);
    assert.deepEqual(sorted(lastClip()), [
        { left: 0, top: 0, right: 100, bottom: 25 },
        { left: 0, top: 25, right: 150, bottom: 50 },
        { left: 50, top: 50, right: 150, bottom: 75 },
    ], 'the union, not its bounding box, in bands');

    assert.equal(fns.ExtSelectClipRgn.handler([hdc, band, RGN_COPY]), SIMPLEREGION);
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, square, RGN_DIFF]), COMPLEXREGION);
    assert.deepEqual(sorted(lastClip()), [
        { left: 0, top: 0, right: 100, bottom: 25 },
        { left: 0, top: 25, right: 50, bottom: 50 },
    ]);

    assert.equal(fns.ExtSelectClipRgn.handler([hdc, band, RGN_COPY]), SIMPLEREGION);
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, square, RGN_XOR]), COMPLEXREGION);
    assert.equal(lastClip().length, 4, 'the band less the square, and the square less the band');
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, band, RGN_XOR]), SIMPLEREGION,
        'XOR with the band again gives the square back');
    assert.deepEqual(lastClip(), { left: 50, top: 25, right: 150, bottom: 75 });

    assert.equal(fns.ExtSelectClipRgn.handler([hdc, square, RGN_DIFF]), NULLREGION);
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, 0, RGN_COPY]), SIMPLEREGION,
        'a null region with RGN_COPY is no clip');
    assert.equal(fns.GetClipRgn.handler([hdc, fns.CreateRectRgn.handler([0, 0, 0, 0])]), 0);
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, 0, RGN_AND]), 0,
        'and with any other mode an error');
    assert.equal(fns.ExtSelectClipRgn.handler([hdc, band, 9]), 0, 'no such mode');
    assert.equal(fns.ExtSelectClipRgn.handler([0x7777, band, RGN_AND]), 0, 'not a DC');
});

test('OffsetRgn moves a region and OffsetClipRgn the clip, answering the kind each is', ()=>{
    const graphics = fakeDrawing();
    const { fns, memory, hdc } = setup(graphics.services);
    const BOX = 0x3000;
    const box = ()=>[0, 4, 8, 12].map(at=>
        new DataView(memory.bytes.buffer).getInt32(BOX + at, true));
    const region = fns.CreateRectRgn.handler([10, 20, 30, 40]);
    assert.equal(fns.OffsetRgn.argBytes, 12);
    assert.equal(fns.OffsetRgn.handler([region, -15, 5]), SIMPLEREGION);
    fns.GetRgnBox.handler([region, BOX]);
    assert.deepEqual(box(), [-5, 25, 15, 45]);
    assert.equal(fns.OffsetRgn.handler([fns.CreateRectRgn.handler([5, 5, 5, 9]), 3, 3]),
        NULLREGION, 'an empty region stays empty');
    assert.equal(fns.OffsetRgn.handler([hdc, 1, 1]), 0, 'not a region');

    assert.equal(fns.OffsetClipRgn.argBytes, 12);
    assert.equal(fns.OffsetClipRgn.handler([hdc, 5, 5]), SIMPLEREGION,
        'with no clip selected there is nothing to move');
    assert.equal(fns.GetClipRgn.handler([hdc, region]), 0, 'and none is selected by it');
    fns.IntersectClipRect.handler([hdc, 10, 10, 20, 20]);
    assert.equal(fns.OffsetClipRgn.handler([hdc, 5, -5]), SIMPLEREGION);
    assert.deepEqual(graphics.calls.filter(call=>call[0] === 'setClipRect').at(-1)?.[2],
        { left: 15, top: 5, right: 25, bottom: 15 });
    fns.ExcludeClipRect.handler([hdc, 18, 8, 20, 10]);
    assert.equal(fns.OffsetClipRgn.handler([hdc, 1, 1]), 3, 'a frame moves as a frame');
    assert.ok(graphics.calls.filter(call=>call[0] === 'setClipRegion').at(-1)?.[2]
        .some((/** @type {any} */ piece)=>piece.left === 16 && piece.top === 6));
    assert.equal(fns.OffsetClipRgn.handler([0x7777, 0, 0]), 0, 'not a DC');
});

test('SelectClipPath has no closed path to clip to, and says so', ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errors = [];
    const { table } = createGdiFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        surfaces: fakeSurfaces(),
        setLastError: code=>errors.push(code),
    });
    const fns = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (table));
    const hdc = fns.GetDC.handler([HWND]);
    assert.equal(fns.SelectClipPath.argBytes, 8);
    assert.equal(fns.SelectClipPath.handler([hdc, RGN_COPY]), 0);
    assert.equal(fns.SelectClipPath.handler([0x7777, RGN_COPY]), 0);
    assert.deepEqual(errors, [1003, 6], 'ERROR_CAN_NOT_COMPLETE, then a handle that is no DC');
});

test('the brush origin is the DC\'s, answered back, saved, and given to the drawing', ()=>{
    const graphics = positionedDrawing();
    const { fns, memory, hdc } = setup(graphics.services);
    const view = new DataView(memory.bytes.buffer);
    const origins = ()=>graphics.calls.filter(call=>call[0] === 'setBrushOrgEx');
    assert.equal(fns.SetBrushOrgEx.argBytes, 16);
    assert.equal(fns.SetBrushOrgEx.handler([hdc, 3, -4, OUT]), 1);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [0, 0]);
    assert.equal(origins().length, 0, 'nothing is bound yet, and nothing is bound for it');

    fns.LineTo.handler([hdc, 1, 1]);
    assert.deepEqual(origins().at(-1), ['setBrushOrgEx', hdc, 3, -4], 'handed over at the bind');
    const level = fns.SaveDC.handler([hdc]);
    assert.equal(fns.SetBrushOrgEx.handler([hdc, 7, 8, OUT]), 1);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [3, -4]);
    assert.deepEqual(origins().at(-1), ['setBrushOrgEx', hdc, 7, 8], 'and when it changes');
    fns.RestoreDC.handler([hdc, level]);
    assert.deepEqual(origins().at(-1), ['setBrushOrgEx', hdc, 3, -4], 'and when restored');
    assert.equal(fns.SetBrushOrgEx.handler([hdc, 0, 0, 0]), 1, 'a null pointer wants no answer');
    assert.equal(fns.SetBrushOrgEx.handler([0x7777, 0, 0, OUT]), 0, 'not a DC');
    assert.equal(setup().fns.SetBrushOrgEx.handler([setup().hdc, 1, 2, 0]), 1,
        'kept without anything to draw with');
});

test('the part of its window a DC may draw in holds under any clip the program selects', ()=>{
    // On Windows a context's system region -- its window's visible part --
    // is not the program's to widen: SelectClipRgn(NULL) or a region the size
    // of the screen still draws nothing over the window in front.
    const graphics = fakeDrawing();
    const memory = fakeMemory();
    const gdi = createGdiFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        surfaces: fakeSurfaces(),
        graphics: graphics.services,
    });
    const fns = /** @type {any} */ (gdi.table);
    const hdc = fns.GetDC.handler([HWND]);
    const last = ()=>graphics.calls.filter(call=>call[0] === 'setClipRect'
        || call[0] === 'setClipRegion').at(-1);
    const visible = { left: 10, top: 10, right: 50, bottom: 40 };

    assert.equal(gdi.draw.clip(hdc, [visible]), true);
    assert.deepEqual(last(), ['setClipRect', hdc, visible]);
    fns.SelectClipRgn.handler([hdc, 0]);
    assert.deepEqual(last(), ['setClipRect', hdc, visible], 'dropping the clip does not widen it');
    fns.IntersectClipRect.handler([hdc, 0, 0, 20, 20]);
    assert.deepEqual(last(), ['setClipRect', hdc, { left: 10, top: 10, right: 20, bottom: 20 }],
        'a clip the program narrows is narrowed inside it');
    fns.SelectClipRgn.handler([hdc, fns.CreateRectRgn.handler([0, 0, 640, 480])]);
    assert.deepEqual(last(), ['setClipRect', hdc, visible], 'nor does the whole screen widen it');

    const around = [{ left: 0, top: 0, right: 10, bottom: 10 },
        { left: 20, top: 20, right: 30, bottom: 30 }];
    gdi.draw.clip(hdc, around);
    assert.deepEqual(last(), ['setClipRegion', hdc, around], 'pieces left around a window over it');
    gdi.draw.clip(hdc, []);
    assert.deepEqual(last(), ['setClipRect', hdc, { left: 0, top: 0, right: 0, bottom: 0 }],
        'a window off the screen draws nowhere');
});

// --- the entry points over the drawing engine itself ---

/** Pixels as a 32-bit surface holds them, 0x00RRGGBB. */
const WHITE_PIXEL = 0x00ffffff;
const RED_PIXEL = 0x00ff0000;
const GREEN_PIXEL = 0x0000ff00;
const BLUE_PIXEL = 0x000000ff;
/** The same as COLORREFs, 0x00BBGGRR. */
const RED_COLOR = 0x000000ff;
const GREEN_COLOR = 0x0000ff00;
const BLUE_COLOR = 0x00ff0000;

test('the new entry points pop the arguments their signatures carry', ()=>{
    const { fns } = setup();
    for (const [name, bytes] of /** @type {[string, number][]} */ ([['Chord', 36], ['Pie', 36],
        ['ExtFloodFill', 20], ['FloodFill', 16], ['FrameRgn', 20], ['GetBrushOrgEx', 8],
        ['GetDCOrgEx', 8], ['LineDDA', 24], ['MaskBlt', 48], ['GdiAlphaBlend', 44],
        ['GdiGradientFill', 24]]))
    {
        assert.equal(fns[name]?.argBytes, bytes, name);
    }
});

test('the new drawing calls fail without anything to draw with', ()=>{
    const { fns, hdc, memory } = setup();
    const region = fns.CreateRectRgn.handler([0, 0, 4, 4]);
    const brush = fns.CreateSolidBrush.handler([0]);
    memory.putU32s(STRUCT, [0, 0, 0xff00, 0, 4, 4, 0, 0]);
    memory.putU32s(STRUCT + 0x40, [0, 1]);
    assert.equal(fns.Chord.handler([hdc, 0, 0, 9, 9, 9, 4, 0, 4]), 0);
    assert.equal(fns.Pie.handler([hdc, 0, 0, 9, 9, 9, 4, 0, 4]), 0);
    assert.equal(fns.ExtFloodFill.handler([hdc, 1, 1, 0, 1]), 0);
    assert.equal(fns.FloodFill.handler([hdc, 1, 1, 0]), 0);
    assert.equal(fns.FrameRgn.handler([hdc, region, brush, 1, 1]), 0);
    assert.equal(fns.MaskBlt.handler([hdc, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, PATCOPY]), 0);
    assert.equal(fns.GdiAlphaBlend.handler([hdc, 0, 0, 1, 1, hdc, 0, 0, 1, 1, 0x00ff0000]), 0);
    assert.equal(fns.GdiGradientFill.handler([hdc, STRUCT, 2, STRUCT + 0x40, 1, 0]), 0);
});

test('Arc keeps inside its rectangle, the right and bottom edges left out', ()=>{
    // Wine's test_arcs, pixel for pixel where it pins them.
    const machine = painted(64, 40);
    pens(machine, 0x111111, 0);
    machine.fill(0);
    assert.equal(machine.fns.Arc.handler([machine.dc, 10, 10, 40, 25, 0, 15, 20, 0]), 1);
    for (let y = 9; y <= 26; y++)
    {
        for (let x = 9; x <= 41; x++)
        {
            const colour = machine.pixel(x, y);
            if (x < 10 || y < 10 || x >= 40 || y >= 25 || (x < 22 && y < 16))
            {
                assert.equal(colour, 0, `nothing at (${x}, ${y})`);
            }
            if (((x === 24 || x === 25) && (y === 10 || y === 24))
                || ((x === 10 || x === 39) && y === 17))
            {
                assert.equal(colour, 0x111111, `the pen at (${x}, ${y})`);
            }
        }
    }
});

test('Chord and Pie of the whole ellipse fill it, inside the same rectangle as Arc', ()=>{
    for (const name of ['Chord', 'Pie'])
    {
        const machine = painted(64, 40);
        pens(machine, 0x111111, RED_COLOR);
        machine.fill(0);
        assert.equal(machine.fns[name].handler([machine.dc, 10, 10, 40, 25, 0, 17, 0, 17]), 1);
        for (let y = 0; y < 40; y++)
        {
            for (let x = 0; x < 64; x++)
            {
                if (x < 10 || y < 10 || x >= 40 || y >= 25)
                {
                    assert.equal(machine.pixel(x, y), 0, `${name}: nothing at (${x}, ${y})`);
                }
            }
        }
        for (const [x, y] of [[24, 10], [25, 10], [24, 24], [25, 24], [10, 17], [39, 17]])
        {
            assert.equal(machine.pixel(x, y), 0x111111, `${name}: the pen at (${x}, ${y})`);
        }
        assert.equal(machine.pixel(25, 20), RED_PIXEL, `${name}: the brush inside`);
    }
});

test('a chord is the piece its line cuts off and a pie the wedge, in the arc\'s direction', ()=>{
    const machine = painted(48, 48);
    const { fns, dc, pixel, fill } = machine;
    pens(machine, BLUE_COLOR, RED_COLOR);
    fill(WHITE_PIXEL);
    // From the right round to the left: over the top, counterclockwise.
    assert.equal(fns.Chord.handler([dc, 0, 0, 41, 41, 41, 20, 0, 20]), 1);
    assert.deepEqual([pixel(20, 10), pixel(20, 20), pixel(20, 30)],
        [RED_PIXEL, BLUE_PIXEL, WHITE_PIXEL], 'the top half, closed by the chord along y = 20');
    fill(WHITE_PIXEL);
    fns.SetArcDirection.handler([dc, 2]);
    fns.Chord.handler([dc, 0, 0, 41, 41, 41, 20, 0, 20]);
    assert.deepEqual([pixel(20, 10), pixel(20, 30)], [WHITE_PIXEL, RED_PIXEL],
        'clockwise, the bottom half');
    fns.SetArcDirection.handler([dc, 1]);

    fill(WHITE_PIXEL);
    assert.equal(fns.Pie.handler([dc, 0, 0, 41, 41, 41, 20, 20, 0]), 1);
    assert.deepEqual([pixel(30, 10), pixel(10, 10), pixel(30, 30), pixel(20, 20)],
        [RED_PIXEL, WHITE_PIXEL, WHITE_PIXEL, BLUE_PIXEL],
        'the upper right quarter, to the centre');
    const before = machine.bytes.slice();
    assert.equal(fns.Pie.handler([dc, 5, 5, 5, 20, 0, 0, 9, 9]), 1, 'a rectangle with no inside');
    assert.deepEqual(machine.bytes, before, 'draws nothing');
    assert.equal(fns.Chord.handler([0x7777, 0, 0, 9, 9, 9, 4, 0, 4]), 0, 'not a DC');
});

test('ExtFloodFill paints with the brush over a surface or up to a border, inside the clip', ()=>{
    // Wine's dib.c scene, smaller: blue, a green square, a blue island at its
    // edge, and a bar taken out of the clip that the fill cannot cross.
    const machine = painted(32, 24);
    const { fns, dc, pixel, put, fill } = machine;
    pens(machine, 0, RED_COLOR);
    fill(BLUE_PIXEL);
    for (let y = 2; y < 20; y++)
    {
        for (let x = 2; x < 26; x++)
        {
            put(x, y, x < 6 && y >= 8 && y < 12 ? BLUE_PIXEL : GREEN_PIXEL);
        }
    }
    fns.ExtSelectClipRgn.handler([dc, fns.CreateRectRgn.handler([16, 0, 18, 24]), RGN_DIFF]);
    assert.equal(fns.ExtFloodFill.handler([dc, 10, 10, GREEN_COLOR, FLOODFILLSURFACE]), 1);
    assert.deepEqual([pixel(10, 10), pixel(2, 2), pixel(15, 19), pixel(3, 9), pixel(16, 10),
        pixel(20, 10), pixel(1, 1)], [RED_PIXEL, RED_PIXEL, RED_PIXEL, BLUE_PIXEL, GREEN_PIXEL,
        GREEN_PIXEL, BLUE_PIXEL], 'the green, as far as the bar; not the island, not past it');
    fns.SelectClipRgn.handler([dc, 0]);
    assert.equal(fns.ExtFloodFill.handler([dc, -1, -1, GREEN_COLOR, FLOODFILLSURFACE]), 0,
        'a start off the bitmap');
    assert.equal(fns.ExtFloodFill.handler([dc, 20, 10, BLUE_COLOR, FLOODFILLSURFACE]), 0,
        'a start that is not the surface\'s colour');
    assert.equal(fns.ExtFloodFill.handler([dc, 20, 10, BLUE_COLOR, 2]), 0, 'no such type');

    // FloodFill is the border form: everything up to the blue.
    assert.equal(fns.FloodFill.handler([dc, 20, 10, BLUE_COLOR]), 1);
    assert.deepEqual([pixel(20, 10), pixel(17, 5), pixel(3, 9), pixel(0, 0)],
        [RED_PIXEL, RED_PIXEL, BLUE_PIXEL, BLUE_PIXEL], 'the green and what was filled in it');
    assert.equal(fns.FloodFill.handler([dc, 0, 0, BLUE_COLOR]), 0, 'a start on the border');
});

test('FrameRgn paints a border inside the region, w across the sides and h down the ends', ()=>{
    const machine = painted(16, 12);
    const { fns, dc, pixel, fill } = machine;
    const red = fns.CreateSolidBrush.handler([RED_COLOR]);
    const region = fns.CreateRectRgn.handler([4, 2, 14, 9]);
    const rows = ()=>Array.from({ length: 10 }, (_, y)=>Array.from({ length: 16 }, (__, x)=>
        (pixel(x, y) === RED_PIXEL ? 'r' : '.')).join(''));
    const framed = [
        '................',
        '................',
        '....rrrrrrrrrr..',
        '....rr......rr..',
        '....rr......rr..',
        '....rr......rr..',
        '....rr......rr..',
        '....rr......rr..',
        '....rrrrrrrrrr..',
        '................',
    ];
    fill(WHITE_PIXEL);
    assert.equal(fns.FrameRgn.handler([dc, region, red, 2, 1]), 1);
    assert.deepEqual(rows(), framed);
    fill(WHITE_PIXEL);
    assert.equal(fns.FrameRgn.handler([dc, region, red, -2, -1]), 1);
    assert.deepEqual(rows(), framed, 'the sizes without their signs');

    fill(WHITE_PIXEL);
    fns.FrameRgn.handler([dc, fns.CreateRectRgn.handler([0, 0, 3, 3]), red, 2, 2]);
    assert.deepEqual(rows().slice(0, 4).map(row=>row.slice(0, 4)),
        ['rrr.', 'rrr.', 'rrr.', '....'], 'narrower than two sides is all border');
    assert.equal(fns.FrameRgn.handler([dc, region, fns.CreatePen.handler([0, 1, 0]), 1, 1]), 0,
        'a pen is no brush');
    assert.equal(fns.FrameRgn.handler([dc, red, red, 1, 1]), 0, 'a brush is no region');
});

test('GetBrushOrgEx answers the origin SetBrushOrgEx set, as it was given', ()=>{
    // Wine's test_brush_org: an origin past sixteen bits is kept whole.
    const { fns, memory, hdc } = setup();
    assert.equal(fns.GetBrushOrgEx.handler([hdc, OUT]), 1);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [0, 0]);
    fns.SetBrushOrgEx.handler([hdc, 0x10000, -1, 0]);
    assert.equal(fns.GetBrushOrgEx.handler([hdc, OUT]), 1);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4) | 0], [0x10000, -1]);
    assert.equal(fns.GetBrushOrgEx.handler([hdc, 0]), 0, 'nowhere to write it');
    assert.equal(fns.GetBrushOrgEx.handler([0x7777, OUT]), 0, 'not a DC');
});

test('GetDCOrgEx is where a window DC starts on the screen, and the corner for any other', ()=>{
    const { gdi, fns, dc, view } = painted(1, 1);
    const origin = (/** @type {number} */ hdc)=>(fns.GetDCOrgEx.handler([hdc, 0x300]) === 1
        ? [view.getInt32(0x300, true), view.getInt32(0x304, true)] : null);
    assert.deepEqual(origin(gdi.windowContext(0x2000,
        { left: 100, top: -50, right: 300, bottom: 250 })), [100, -50]);
    assert.deepEqual(origin(gdi.windowContext(0, null)), [0, 0], 'the screen\'s own');
    assert.deepEqual(origin(dc), [0, 0], 'a bitmap\'s');
    fns.SetViewportOrgEx.handler([dc, 7, 9, 0]);
    assert.deepEqual(origin(dc), [0, 0], 'whatever the mapping');
    assert.equal(fns.GetDCOrgEx.handler([dc, 0]), 0);
    assert.equal(fns.GetDCOrgEx.handler([0x7777, 0x300]), 0);
});

test('LineDDA calls back with the points Windows reports, the last left out', async()=>{
    // Wine's test_linedda, every octant it tries.
    /** @param {number[]} flat */
    const pairs = flat=>Array.from({ length: flat.length / 2 }, (_, at)=>
        [flat[at * 2], flat[at * 2 + 1]]);
    const cases = /** @type {[number[], number[][]][]} */ ([
        [[10, 20, 20, 40], pairs([10, 20, 10, 21, 11, 22, 11, 23, 12, 24, 12, 25, 13, 26, 13, 27,
            14, 28, 14, 29, 15, 30, 15, 31, 16, 32, 16, 33, 17, 34, 17, 35, 18, 36, 18, 37, 19, 38,
            19, 39])],
        [[10, 20, 20, 43], pairs([10, 20, 10, 21, 11, 22, 11, 23, 12, 24, 12, 25, 13, 26, 13, 27,
            13, 28, 14, 29, 14, 30, 15, 31, 15, 32, 16, 33, 16, 34, 17, 35, 17, 36, 17, 37, 18, 38,
            18, 39, 19, 40, 19, 41, 20, 42])],
        [[10, 20, 10, 20], []],
        [[10, 20, 11, 27], pairs([10, 20, 10, 21, 10, 22, 10, 23, 11, 24, 11, 25, 11, 26])],
        [[20, 43, 10, 20], pairs([20, 43, 20, 42, 19, 41, 19, 40, 18, 39, 18, 38, 17, 37, 17, 36,
            17, 35, 16, 34, 16, 33, 15, 32, 15, 31, 14, 30, 14, 29, 13, 28, 13, 27, 13, 26, 12, 25,
            12, 24, 11, 23, 11, 22, 10, 21])],
        [[20, 20, 10, 43], pairs([20, 20, 20, 21, 19, 22, 19, 23, 18, 24, 18, 25, 17, 26, 17, 27,
            17, 28, 16, 29, 16, 30, 15, 31, 15, 32, 14, 33, 14, 34, 13, 35, 13, 36, 13, 37, 12, 38,
            12, 39, 11, 40, 11, 41, 10, 42])],
        [[20, 20, 43, 10], pairs([20, 20, 21, 20, 22, 19, 23, 19, 24, 18, 25, 18, 26, 17, 27, 17,
            28, 17, 29, 16, 30, 16, 31, 15, 32, 15, 33, 14, 34, 14, 35, 13, 36, 13, 37, 13, 38, 12,
            39, 12, 40, 11, 41, 11, 42, 10])],
    ]);
    const { fns, called } = painted(1, 1);
    const PROC = 0x401000;
    for (const [line, points] of cases)
    {
        called.length = 0;
        assert.equal(await fns.LineDDA.handler([...line, PROC, 0xabc]), 1);
        assert.deepEqual(called, points.map(([x, y])=>[PROC, x, y, 0xabc]), line.join(', '));
        assert.deepEqual([...lineDdaPoints(line[0], line[1], line[2], line[3])]
            .map(({ x, y })=>[x, y]), points);
    }
    called.length = 0;
    await fns.LineDDA.handler([-2, 0, 0, 0, PROC, 0]);
    assert.deepEqual(called, [[PROC, 0xfffffffe, 0, 0], [PROC, 0xffffffff, 0, 0]],
        'a negative coordinate is the int it is');
    assert.equal(fns.LineDDA.handler([0, 0, 5, 5, 0, 0]), 0, 'no callback to call');
    assert.equal(setup().fns.LineDDA.handler([0, 0, 5, 5, PROC, 0]), 0,
        'nor any way to call one');
    assert.equal(setup().fns.LineDDA.handler([3, 3, 3, 3, PROC, 0]), 1, 'but no points is done');
});

test('MaskBlt takes the foreground operation where the mask is set, the background elsewhere',
    ()=>{
        const machine = painted(8, 1);
        const { fns, dc, pixel, fill, bytes, view, section } = machine;
        const source = section(8, 1);
        source.fill(RED_PIXEL);
        const row = ()=>[...Array(8).keys()].map(x=>(pixel(x, 0) === RED_PIXEL ? 1 : 0));
        bytes.set([0xa5, 0], 0x200);
        const mask = fns.CreateBitmap.handler([8, 1, 1, 1, 0x200]);
        const DSTCOPY = 0x00aa0029;
        const rop = (((DSTCOPY << 8) & 0xff000000) | SRCCOPY) >>> 0;

        fill(WHITE_PIXEL);
        assert.equal(fns.MaskBlt.handler([dc, 0, 0, 8, 1, source.dc, 0, 0, mask, 0, 0, rop]), 1);
        assert.deepEqual(row(), [1, 0, 1, 0, 0, 1, 0, 1]);
        assert.equal(pixel(1, 0), WHITE_PIXEL, 'the background operation left it');

        // A one-bit DIB section is a mask too, its bits read through its table.
        const bits = section(8, 1, { bitCount: 1 });
        bytes[bits.at] = 0x0f;
        fill(WHITE_PIXEL);
        fns.MaskBlt.handler([dc, 0, 0, 8, 1, source.dc, 0, 0, bits.bitmap, 0, 0, rop]);
        assert.deepEqual(row(), [0, 0, 0, 0, 1, 1, 1, 1]);

        fill(WHITE_PIXEL);
        assert.equal(fns.MaskBlt.handler([dc, 0, 0, 8, 1, source.dc, 0, 0, 0, 0, 0, rop]), 1);
        assert.deepEqual(row(), [1, 1, 1, 1, 1, 1, 1, 1], 'no mask is BitBlt with the foreground');

        assert.equal(fns.MaskBlt.handler([dc, 0, 0, 8, 1, source.dc, 0, 0, source.bitmap, 0, 0,
            rop]), 0, 'a mask of colour');
        assert.equal(fns.MaskBlt.handler([dc, 0, 0, 8, 1, source.dc, 0, 0,
            fns.CreateSolidBrush.handler([0]), 0, 0, rop]), 0, 'a mask that is no bitmap');
        assert.equal(fns.MaskBlt.handler([dc, 0, 0, 8, 1, 0, 0, 0, mask, 0, 0, rop]), 0,
            'the foreground reads a source there is not');
        void view;
    });

/** A BLENDFUNCTION as it crosses the stack. @param {number} alpha @param {number} [format] */
const blendOf = (alpha, format = 0)=>((format << 24) | (alpha << 16)) >>> 0;

test('GdiAlphaBlend blends by MSDN\'s sums, rounded as Windows rounds them', ()=>{
    // Wine's test_32bit_ddb: a 32-bit device bitmap of 0x40201008 over a
    // section pixel of 0x80808080, at a constant alpha of 128.
    const machine = painted(2, 1);
    const { fns, dc, pixel, put, view } = machine;
    view.setUint32(0x200, 0x40201008, true);
    const source = fns.CreateCompatibleDC.handler([0]);
    fns.SelectObject.handler([source, fns.CreateBitmap.handler([1, 1, 1, 32, 0x200])]);
    put(0, 0, 0x80808080);
    assert.equal(fns.GdiAlphaBlend.handler([dc, 0, 0, 1, 1, source, 0, 0, 1, 1,
        blendOf(128)]), 1);
    assert.equal(pixel(0, 0), 0x60504844);
    put(0, 0, 0x80808080);
    assert.equal(fns.GdiAlphaBlend.handler([dc, 0, 0, 1, 1, source, 0, 0, 1, 1,
        blendOf(128, 1)]), 1);
    assert.equal(pixel(0, 0), 0x90807874, 'premultiplied');
    put(0, 0, 0);
    put(1, 0, 0);
    fns.GdiAlphaBlend.handler([dc, 0, 0, 2, 1, source, 0, 0, 1, 1, blendOf(255)]);
    assert.deepEqual([pixel(0, 0), pixel(1, 0)], [0x40201008, 0x40201008], 'and stretched');
});

test('GdiAlphaBlend refuses what Windows refuses, and maps both rectangles first', ()=>{
    // Wine's test_GdiAlphaBlend, case by case.
    const machine = painted(100, 100);
    const { fns, dc, errors, section } = machine;
    const source = section(20, 20);
    const blend = blendOf(128);
    /** @param {number[]} args @returns {[number, number | null]} the answer and any error */
    const tried = args=>{
        errors.length = 0;
        return [fns.GdiAlphaBlend.handler(args), errors.at(-1) ?? null];
    };
    const src = source.dc;
    assert.deepEqual(tried([dc, 0, 0, 20, 20, src, 0, 0, 20, 20, blend]), [1, null]);
    for (const [x, y, w, h] of [[-1, 0, 10, 10], [0, -1, 10, 10], [15, 0, 10, 10],
        [10, 10, -2, 3]])
    {
        assert.deepEqual(tried([dc, 0, 0, 20, 20, src, x, y, w, h, blend]), [0, 87],
            `the source ${x}, ${y}, ${w}, ${h}`);
    }
    fns.SetWindowOrgEx.handler([src, -10, -10, 0]);
    assert.deepEqual(tried([dc, 0, 0, 20, 20, src, -1, 0, 10, 10, blend]), [1, null],
        'the source rectangle is logical');
    assert.deepEqual(tried([dc, 0, 0, 20, 20, src, 0, -1, 10, 10, blend]), [1, null]);
    fns.SetWindowOrgEx.handler([src, 0, 0, 0]);
    fns.SetMapMode.handler([dc, 8]);
    fns.SetViewportExtEx.handler([dc, -1, -1, 0]);
    assert.deepEqual(tried([dc, -20, -20, 20, 20, src, 0, 0, 20, 20, blend]), [1, null],
        'a destination the mapping flips');
    assert.deepEqual(tried([dc, 0, -20, 20, -20, src, 0, 0, 20, 20, blend]), [0, 87],
        'but not one given flipped');
    fns.SetMapMode.handler([dc, 1]);

    assert.deepEqual(tried([dc, 0, 0, 20, 20, 0, 0, 0, 20, 20, blend]), [0, null], 'no source');
    assert.deepEqual(tried([dc, 0, 0, 20, 20, dc, 19, 19, 20, 20, blend]), [0, 87], 'overlapping');
    assert.deepEqual(tried([dc, 20, 20, 20, 20, dc, 1, 1, 20, 20, blend]), [0, 87]);
    assert.deepEqual(tried([dc, 0, 0, 20, 20, dc, 20, 10, 20, 20, blend]), [1, null],
        'side by side in one bitmap');
    for (const bad of [blend | 1, blend | 0x100, blendOf(128, 2)])
    {
        assert.deepEqual(tried([dc, 0, 0, 20, 20, src, 0, 0, 20, 20, bad]), [0, 87],
            `BLENDFUNCTION 0x${bad.toString(16)}`);
    }

    // AC_SRC_ALPHA wants a source whose pixels hold an alpha.
    const alpha = blendOf(128, 1);
    assert.deepEqual(tried([dc, 0, 0, 20, 20, src, 0, 0, 20, 20, alpha]), [1, null]);
    const bgra = section(20, 20, { masks: [0xff0000, 0x00ff00, 0x0000ff] });
    assert.deepEqual(tried([dc, 0, 0, 20, 20, bgra.dc, 0, 0, 20, 20, alpha]), [1, null]);
    for (const other of [section(20, 20, { masks: [0x0000ff, 0x00ff00, 0xff0000] }),
        section(20, 20, { bitCount: 24 }), section(20, 20, { bitCount: 1 })])
    {
        assert.deepEqual(tried([dc, 0, 0, 20, 20, other.dc, 0, 0, 20, 20, alpha]), [0, 87]);
    }
    const mono = fns.CreateCompatibleDC.handler([0]);
    fns.SelectObject.handler([mono, fns.CreateBitmap.handler([100, 100, 1, 1, 0])]);
    assert.deepEqual(tried([dc, 0, 0, 20, 20, mono, 0, 0, 20, 20, alpha]), [0, 87]);
    assert.deepEqual(tried([dc, 0, 0, 20, 20, mono, 0, 0, 20, 20, blend]), [1, null],
        'a constant alpha takes any source');
});

/**
 * TRIVERTEXes into guest memory.
 *
 * @param {DataView} view @param {number} at @param {number[][]} vertices
 *     x, y, red, green, blue, alpha each.
 */
function putVertices(view, at, vertices){
    vertices.forEach(([x, y, ...channels], index)=>{
        view.setInt32(at + index * 16, x, true);
        view.setInt32(at + index * 16 + 4, y, true);
        channels.forEach((value, channel)=>view.setUint16(at + index * 16 + 8 + channel * 2,
            value, true));
    });
}

/** @param {DataView} view @param {number} at @param {number[]} indices */
function putIndices(view, at, indices){
    indices.forEach((value, index)=>view.setUint32(at + index * 4, value, true));
}

test('GdiGradientFill checks its arguments and its mesh as Windows does', ()=>{
    // Wine's test_GdiGradientFill, call by call.
    const machine = painted(20, 20);
    const { fns, dc, errors, view } = machine;
    const VT = 0x200;
    const RECTS = 0x300;
    const TRIS = 0x380;
    putVertices(view, VT, [[2, 2, 0xff00, 0, 0, 0x8000], [10, 10, 0, 0xff00, 0, 0x8000],
        [20, 10, 0, 0, 0xff00, 0xff00]]);
    putIndices(view, RECTS, [0, 0, 0, 1, 2, 3]);
    putIndices(view, TRIS, [0, 0, 0, 0, 1, 2, 0, 2, 1, 0, 1, 3]);
    /** @param {number[]} args @returns {[number, number | null]} */
    const tried = args=>{
        errors.length = 0;
        return [fns.GdiGradientFill.handler(args), errors.at(-1) ?? null];
    };
    assert.deepEqual(tried([dc, VT, 3, RECTS, 1, 0]), [1, null]);
    assert.deepEqual(tried([dc, VT, 3, RECTS, 1, 3]), [0, 87], 'no such mode');
    assert.deepEqual(tried([0xdead, VT, 3, RECTS, 1, 0]), [0, 87], 'no such DC');
    assert.deepEqual(tried([0, 0, 0, RECTS, 1, 0]), [0, 87]);
    assert.deepEqual(tried([dc, 0, 0, RECTS, 1, 0]), [0, 87], 'no vertices');
    assert.deepEqual(tried([dc, 0, 3, RECTS, 1, 0]), [0, 87]);
    assert.deepEqual(tried([dc, VT, 3, 0, 0, 0]), [0, 87], 'no mesh');
    assert.deepEqual(tried([dc, VT, 3, 0, 1, 0]), [0, 87]);
    assert.deepEqual(tried([dc, VT, 3, RECTS, 0, 0]), [0, 87]);
    assert.deepEqual(tried([dc, VT, 3, RECTS, 3, 0]), [0, null], 'an index past the vertices');
    putIndices(view, RECTS + 16, [1, 1]);
    assert.deepEqual(tried([dc, VT, 3, RECTS, 3, 0]), [1, null], 'a rectangle of one point');
    assert.deepEqual(tried([dc, VT, 1, RECTS, 1, 0]), [1, null]);
    assert.deepEqual(tried([dc, VT, 1, TRIS, 0, 2]), [0, 87]);
    assert.deepEqual(tried([dc, VT, 1, TRIS, 1, 2]), [1, null], 'a triangle of one point');
    assert.deepEqual(tried([dc, VT, 3, TRIS, 2, 2]), [1, null]);
    assert.deepEqual(tried([dc, VT, 3, TRIS, 3, 2]), [1, null]);
    assert.deepEqual(tried([dc, VT, 3, TRIS, 4, 2]), [0, null]);
    for (const last of [[0, 1, 1], [0, 1, 0]])
    {
        putIndices(view, TRIS + 36, last);
        assert.deepEqual(tried([dc, VT, 3, TRIS, 4, 2]), [0, null], `a line, ${last}`);
    }
    putIndices(view, TRIS + 36, [1, 1, 1]);
    assert.deepEqual(tried([dc, VT, 3, TRIS, 4, 2]), [1, null]);
});

test('GdiGradientFill shades the device\'s pixels where the mapping puts its vertices', ()=>{
    const machine = painted(20, 4);
    const { fns, dc, pixel, fill, view } = machine;
    putVertices(view, 0x200, [[2, 0, 0xff00, 0, 0, 0x8000], [10, 2, 0, 0xff00, 0, 0xff00]]);
    putIndices(view, 0x300, [0, 1]);
    fill(WHITE_PIXEL);
    assert.equal(fns.GdiGradientFill.handler([dc, 0x200, 2, 0x300, 1, 0]), 1);
    assert.deepEqual([pixel(1, 0), pixel(2, 0), pixel(6, 1), pixel(10, 0), pixel(2, 2)],
        [WHITE_PIXEL, 0x80ff0000, 0xbf7f7f00, WHITE_PIXEL, WHITE_PIXEL],
        'red to green across, alpha with them, inside the half-open box');
    fill(WHITE_PIXEL);
    fns.SetViewportOrgEx.handler([dc, 5, 1, 0]);
    fns.GdiGradientFill.handler([dc, 0x200, 2, 0x300, 1, 1]);
    assert.deepEqual([pixel(6, 1), pixel(7, 1), pixel(7, 2), pixel(7, 3)],
        [WHITE_PIXEL, 0x80ff0000, 0xbf7f7f00, WHITE_PIXEL], 'moved by the viewport, shaded down');
});

test('BitBlt reads the source rectangle in the source DC\'s own logical space', ()=>{
    // A strip repainted through a memory DC whose window origin is moved to
    // the strip, then copied out at the same logical x into a DC that is not.
    const { fns, dc, pixel, fill, section } = painted(4, 1);
    const source = section(2, 1);
    source.put(0, 0, RED_PIXEL);
    source.put(1, 0, BLUE_PIXEL);
    fns.SetWindowOrgEx.handler([source.dc, 2, 0, 0]);
    fill(WHITE_PIXEL);
    assert.equal(fns.BitBlt.handler([dc, 2, 0, 2, 1, source.dc, 2, 0, 0x00cc0020]), 1);
    assert.deepEqual([0, 1, 2, 3].map(x=>pixel(x, 0)),
        [WHITE_PIXEL, WHITE_PIXEL, RED_PIXEL, BLUE_PIXEL]);
});

test('GdiTransparentBlt stretches the source over the destination, leaving the key out', ()=>{
    const machine = painted(4, 2);
    const { fns, dc, pixel, fill, section } = machine;
    const source = section(2, 1);
    // Wine's test_GdiTransparentBlt: a key of white leaves out 0xffffffff,
    // the unused byte being no part of the colour.
    source.put(0, 0, 0xffffffff);
    source.put(1, 0, RED_PIXEL);
    fill(0x00123456);
    assert.equal(fns.GdiTransparentBlt.handler([dc, 0, 0, 4, 2, source.dc, 0, 0, 2, 1,
        0x00ffffff]), 1);
    assert.deepEqual([0, 1, 2, 3].map(x=>pixel(x, 1)),
        [0x00123456, 0x00123456, RED_PIXEL, RED_PIXEL], 'stretched twice over, the white left out');

    // A 16-bit source holds the nearest colour it can to the key, and that
    // is what is left out.
    const shallow = section(2, 1, { bitCount: 16 });
    const KEY = 0x00030507;
    fns.SetPixel.handler([shallow.dc, 0, 0, KEY]);
    fns.SetPixel.handler([shallow.dc, 1, 0, BLUE_COLOR]);
    fill(0x00123456);
    assert.equal(fns.GdiTransparentBlt.handler([dc, 0, 0, 2, 1, shallow.dc, 0, 0, 2, 1, KEY]), 1);
    assert.deepEqual([pixel(0, 0), pixel(1, 0)], [0x00123456, BLUE_PIXEL]);

    fns.SetWindowOrgEx.handler([source.dc, -1, 0, 0]);
    fill(0x00123456);
    assert.equal(fns.GdiTransparentBlt.handler([dc, 0, 0, 1, 1, source.dc, 0, 0, 1, 1,
        0x00ffffff]), 1, 'the source rectangle is logical');
    assert.equal(pixel(0, 0), RED_PIXEL);
    fns.SetWindowOrgEx.handler([source.dc, 0, 0, 0]);

    for (const args of [[0, 0, -1, 1, 0, 0, 1, 1], [0, 0, 1, 1, 0, 0, 1, -1],
        [0, 0, 1, 1, -1, 0, 1, 1], [0, 0, 1, 1, 1, 0, 2, 1], [0, 0, 1, 1, 0, 0, 1, 2]])
    {
        const [x, y, w, h, x1, y1, w1, h1] = args;
        assert.equal(fns.GdiTransparentBlt.handler([dc, x, y, w, h, source.dc, x1, y1, w1, h1,
            0]), 0, `refused: ${args}`);
    }
    assert.equal(fns.GdiTransparentBlt.handler([dc, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0]), 0,
        'no source');
    assert.equal(setup().fns.GdiTransparentBlt.handler([setup().hdc, 0, 0, 1, 1, setup().hdc,
        0, 0, 1, 1, 0]), 0, 'nothing to draw with');
});

test('a moved window origin moves every drawing call and the clip a program names, as a'
    + ' framework painting a windowless control relies on', ()=>{
    // A framework paints an image that has no window of its own into its
    // parent's DC: the window origin moved back by the image's corner, the
    // clip narrowed to the image in the image's own coordinates, then the
    // image drawn at 0,0. The pixels have to land at the image's corner.
    const machine = painted(32, 32);
    const { fns, dc, pixel, fill } = machine;
    const BLACK = 0x00000000;
    const WHITE_BRUSH = fns.GetStockObject.handler([0]);
    fill(BLACK);
    const POINT = 0x200;
    assert.equal(fns.SetWindowOrgEx.handler([dc, -10, -12, POINT]), 1);
    assert.equal(fns.IntersectClipRect.handler([dc, 0, 0, 4, 4]), 2, 'SIMPLEREGION');

    // A source with its own pixels, blitted to the logical origin.
    const source = machine.section(8, 8);
    source.fill(0x00ff0000);
    assert.equal(fns.BitBlt.handler([dc, 0, 0, 8, 8, source.dc, 0, 0, SRCCOPY]), 1);
    assert.equal(pixel(10, 12) & 0xffffff, 0xff0000, 'the corner, at the moved origin');
    assert.equal(pixel(13, 15) & 0xffffff, 0xff0000);
    assert.equal(pixel(14, 12) & 0xffffff, 0, 'and clipped to four, in logical units');
    assert.equal(pixel(0, 0) & 0xffffff, 0, 'nothing at the device corner');

    // The same for a fill and a rectangle, outside that clip once it is gone.
    fns.SelectClipRgn.handler([dc, 0]);
    assert.equal(fns.PatBlt.handler([dc, 4, 4, 2, 2, 0x00f00021]), 1, 'PATCOPY');
    assert.notEqual(pixel(14, 16) & 0xffffff, 0, 'the pattern at 14,16');
    assert.equal(pixel(4, 4) & 0xffffff, 0);
    fns.SelectObject.handler([dc, WHITE_BRUSH]);
    assert.equal(fns.Rectangle.handler([dc, -10, -12, -6, -8]), 1);
    assert.notEqual(pixel(1, 1) & 0xffffff, 0, 'a logical -10,-12 is the device corner');

    // A line from the current position, which stays in logical units: a
    // framework draws a bevel's edge from 0,0 to its width.
    fill(BLACK);
    fns.SelectObject.handler([dc, fns.GetStockObject.handler([6])]);
    assert.equal(fns.SetWindowOrgEx.handler([dc, 0, -20, 0]), 1);
    assert.equal(fns.MoveToEx.handler([dc, 0, 0, 0]), 1);
    assert.equal(fns.LineTo.handler([dc, 16, 0]), 1);
    assert.deepEqual([0, 8, 15].map(x=>pixel(x, 20) & 0xffffff), [0xffffff, 0xffffff, 0xffffff],
        'the whole line, along device row 20');
    assert.equal(pixel(16, 20) & 0xffffff, 0, 'its last point left out');
    assert.equal(fns.GetCurrentPositionEx.handler([dc, POINT]), 1);
    assert.deepEqual([machine.view.getInt32(POINT, true), machine.view.getInt32(POINT + 4, true)],
        [16, 0], 'the position where the line ended, logical');

    // Back to the device's own space: drawn where it is named again.
    assert.equal(fns.SetWindowOrgEx.handler([dc, 0, 0, 0]), 1);
    fill(BLACK);
    assert.equal(fns.BitBlt.handler([dc, 0, 0, 2, 2, source.dc, 0, 0, SRCCOPY]), 1);
    assert.equal(pixel(0, 0) & 0xffffff, 0xff0000);
});

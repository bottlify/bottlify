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

const HWND = 0x2000;
const STRUCT = 0x30000;
const OUT = 0x30400;
const RAMP = 0x31000;

const RGN_AND = 1;
const RGN_OR = 2;
const RGN_COPY = 5;
const NULLREGION = 1;
const SIMPLEREGION = 2;

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
            return new TextDecoder('latin1').decode(bytes.subarray(address, end));
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
    return {
        drawing,
        calls,
        services: {
            createDrawing: ()=>drawing,
            surfaceFor: ()=>surface,
            pixelFormat: {
                count: ()=>3,
                size: ()=>40,
                choose: ()=>2,
                /** @param {number} index */
                describe: index=>index >= 1 && index <= 3 ? new Uint8Array(40).fill(index) : null,
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

// --- pixel formats ---

test('a pixel format is set once', ()=>{
    // A program probes formats by setting one and checking. Letting a second,
    // different format through would make every probe succeed.
    const graphics = fakeDrawing();
    const { fns, hdc } = setup(graphics.services);

    assert.equal(fns.GetPixelFormat.handler([hdc]), 0, 'nothing is set to begin with');
    assert.equal(fns.SetPixelFormat.handler([hdc, 2, 0]), 1);
    assert.equal(fns.GetPixelFormat.handler([hdc]), 2);
    assert.equal(fns.SetPixelFormat.handler([hdc, 2, 0]), 1, 'the same one again succeeds');
    assert.equal(fns.SetPixelFormat.handler([hdc, 1, 0]), 0, 'a different one does not');
    assert.equal(fns.SetPixelFormat.handler([hdc, 99, 0]), 0, 'nor does one that does not exist');
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

test('the system palette has no entries to report', ()=>{
    // A system palette exists on a device of eight bits or fewer, and this one
    // is 32. Reporting entries would have a program match colours against a
    // palette nothing draws through.
    const { fns, hdc } = setup();
    assert.equal(fns.GetSystemPaletteEntries.handler([hdc, 0, 16, OUT]), 0);
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

    const bare = setup();
    assert.equal(bare.fns.Rectangle.handler([bare.hdc, 0, 0, 1, 1]), 0);
    assert.equal(bare.fns.ExtTextOutA.handler([bare.hdc, 0, 0, 0, 0, 0, 0, 0]), 0);
});

test('GetDIBits describes a bitmap before it copies one', ()=>{
    // A null buffer asks for the shape, which is bookkeeping and answerable
    // without any pixels at all -- and is how a caller sizes the buffer it will
    // ask with next.
    const { memory, fns, hdc } = setup();
    const bitmap = fns.CreateCompatibleBitmap.handler([hdc, 64, 48]);

    memory.putU32s(STRUCT, new Array(10).fill(0));
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 48, 0, STRUCT, 0]), 48);
    assert.equal(memory.u32(STRUCT), 40, 'biSize');
    assert.equal(memory.u32(STRUCT + 4), 64, 'biWidth');
    assert.equal(memory.u32(STRUCT + 8), 48, 'biHeight');
    assert.equal(memory.u16(STRUCT + 12), 1, 'biPlanes');

    // Without the bitmap selected into the context there is no surface to read,
    // and rows from somewhere else would be worse than none.
    assert.equal(fns.GetDIBits.handler([hdc, bitmap, 0, 48, OUT, STRUCT, 0]), 0);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Bitmaps end to end: gdi32's bookkeeping over this layer's drawing, wired
 * the way app.js wires them, and driven the way a program drives them.
 *
 * The shapes pinned here are the ones every GDI program of the era is built
 * from: a double buffer -- a compatible bitmap in a memory DC, drawn into and
 * blitted to the window -- and a monochrome bitmap made from bits the program
 * supplied, which is what a mask is. Each assertion is a Wine conformance
 * expectation (dlls/gdi32/tests/bitmap.c) or the documented contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphicsModule } from './module.js';
import { createFakeDevice } from './webgpu/internal/fake-device.js';
import { createGdiFunctions } from '../win32/gdi32/functions.js';
import { BITMAPINFOHEADER } from '../win32/gdi32/structs.js';

const SRCCOPY = 0x00cc0020;
const WHITENESS = 0x00ff0062;
const BLACKNESS = 0x00000042;

/** Guest addresses, far enough apart that nothing overlaps. */
const CALLER = 0x1000;
const INFO = 0x1200;
const ROWS = 0x1400;
const HEAP = 0x4000;
const SCREEN = { width: 16, height: 8, bitsPerPixel: 32 };

/**
 * One flat guest memory, the graphics module over a fake device, and the
 * gdi32 table on its drawing engine.
 *
 * @param {{ canvas?: boolean }} [options]  Whether the device has a canvas to show on.
 */
async function assemble({ canvas = false } = {}){
    const ram = new Uint8Array(0x40000);
    const view = new DataView(ram.buffer);
    /** @type {Map<number, { type: string, object: any }>} */
    const handles = new Map();
    let nextHandle = 0x20;
    let nextAddress = HEAP;
    const heap = {
        /** @param {number} size */
        allocate(size){
            const address = nextAddress;
            nextAddress += (size + 15) & ~15;
            return address;
        },
        free(){},
    };
    const gpu = createFakeDevice();
    const graphics = await graphicsModule.create({
        device: {
            device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
            ...(canvas ? { screen: gpu.screen, canvas: gpu.canvas } : {}),
        },
        screen: SCREEN,
        now: ()=>0,
        schedule: ()=>{},
    }, /** @type {any} */ ({
        /** @param {string} name */
        requireApi: name=>{
            if (name === 'memory')
            {
                return {
                    readBytes: (/** @type {number} */ address, /** @type {number} */ length)=>
                        ram.subarray(address, address + length),
                    writeBytes: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
                        ram.set(bytes, address),
                    window: (/** @type {number} */ address, /** @type {number} */ length)=>
                        ram.subarray(address, address + length),
                    readU32: (/** @type {number} */ address)=>view.getUint32(address, true),
                };
            }
            if (name === 'win32')
            {
                return { heap: ()=>heap, windows: ()=>[] };
            }
            return { callGuest: ()=>Promise.resolve(0) };
        },
    }));
    const drawing = graphics.gdiDrawing();
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>ram.subarray(address, address + length),
        writeMemory: (address, bytes)=>ram.set(bytes, address),
        readCString: ()=>'',
        handles: {
            open(type, object){
                const handle = nextHandle;
                nextHandle += 4;
                handles.set(handle, { type, object });
                return handle;
            },
            close: handle=>handles.delete(handle),
        },
        surfaces: heap,
        screen: SCREEN,
        graphics: {
            createDrawing: options=>drawing.create(options),
            surfaceFor: (dc, bitmap)=>drawing.surfaceFor(dc, bitmap),
            presentDesktop: ()=>{},
            setGammaRamp: ramp=>drawing.setDisplayGamma(ramp),
            gammaRamp: ()=>drawing.displayGamma(),
            appliesGamma: ()=>drawing.appliesGamma(),
        },
    });
    // The handlers declare only the arguments they read; a guest call always
    // carries the whole list.
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (gdi.table));
    return { ram, view, fns, graphics };
}

test('a compatible bitmap is a double buffer: drawn into, blitted out, read back', async()=>{
    const { view, fns } = await assemble();
    try
    {
        const screen = fns.GetDC.handler([0]);
        const memory = fns.CreateCompatibleDC.handler([screen]);
        const buffer = fns.CreateCompatibleBitmap.handler([screen, 4, 2]);
        assert.ok(fns.SelectObject.handler([memory, buffer]) > 0);

        assert.equal(fns.PatBlt.handler([memory, 0, 0, 4, 2, WHITENESS]), 1);
        assert.equal(fns.SetPixel.handler([memory, 1, 1, 0x000000ff]), 0x000000ff,
            'the colour actually set');
        assert.equal(fns.GetPixel.handler([memory, 1, 1]), 0x000000ff);
        assert.equal(fns.GetPixel.handler([memory, 0, 0]), 0x00ffffff);

        assert.equal(fns.BitBlt.handler([screen, 3, 2, 4, 2, memory, 0, 0, SRCCOPY]), 1);
        assert.equal(fns.GetPixel.handler([screen, 4, 3]), 0x000000ff, 'on the screen');
        assert.equal(fns.GetPixel.handler([screen, 3, 2]), 0x00ffffff);

        // Wine's test_GetDIBits_selected_DDB: the bitmap is taken out of the DC
        // it was drawn in, and read through another.
        fns.SelectObject.handler([memory, fns.CreateCompatibleBitmap.handler([memory, 1, 1])]);
        const reader = fns.CreateCompatibleDC.handler([0]);
        view.setUint32(INFO + BITMAPINFOHEADER.biSize, BITMAPINFOHEADER.SIZE, true);
        view.setInt32(INFO + BITMAPINFOHEADER.biWidth, 4, true);
        view.setInt32(INFO + BITMAPINFOHEADER.biHeight, -2, true);
        view.setUint16(INFO + BITMAPINFOHEADER.biPlanes, 1, true);
        view.setUint16(INFO + BITMAPINFOHEADER.biBitCount, 32, true);
        assert.equal(fns.GetDIBits.handler([reader, buffer, 0, 2, ROWS, INFO, 0]), 2);
        assert.equal(view.getUint32(ROWS, true), 0x00ffffff);
        assert.equal(view.getUint32(ROWS + 16 + 4, true), 0x00ff0000, 'BGRX, red at (1,1)');
        assert.equal(fns.GetBitmapBits.handler([buffer, 0, 0]), 4 * 4 * 2);
    }
    finally
    {
        await graphicsModule.dispose();
    }
});

test('CreateBitmap copies the bits it is given, and a monochrome bitmap draws', async()=>{
    const { ram, fns } = await assemble();
    try
    {
        // Two rows of sixteen pixels, 0x55: black, white, black, white...
        ram.fill(0x55, CALLER, CALLER + 4);
        const mask = fns.CreateBitmap.handler([16, 2, 1, 1, CALLER]);
        assert.ok(mask > 0);
        ram.fill(0x00, CALLER, CALLER + 4);

        const dc = fns.CreateCompatibleDC.handler([0]);
        fns.SelectObject.handler([dc, mask]);
        assert.equal(fns.GetPixel.handler([dc, 0, 0]), 0x00000000);
        assert.equal(fns.GetPixel.handler([dc, 1, 0]), 0x00ffffff,
            'the bits as they were when the bitmap was made, not the caller\'s buffer now');

        assert.equal(fns.GetBitmapBits.handler([mask, 4, ROWS]), 4);
        assert.deepEqual([...ram.subarray(ROWS, ROWS + 4)], [0x55, 0x55, 0x55, 0x55]);

        assert.equal(fns.PatBlt.handler([dc, 0, 0, 16, 2, BLACKNESS]), 1);
        assert.deepEqual([...ram.subarray(CALLER, CALLER + 4)], [0, 0, 0, 0],
            'drawing lands in the bitmap, never in the caller\'s buffer');
        assert.equal(fns.GetBitmapBits.handler([mask, 4, ROWS]), 4);
        assert.deepEqual([...ram.subarray(ROWS, ROWS + 4)], [0, 0, 0, 0]);

        // Wine's test_mono_bitmap: a colour set on a monochrome bitmap is the
        // nearer of black and white, and SetPixel answers with that.
        assert.equal(fns.SetPixel.handler([dc, 3, 1, 0x00ffffff]), 0x00ffffff);
        assert.equal(fns.SetPixel.handler([dc, 4, 1, 0x00c0c0c0]), 0x00ffffff);
        assert.equal(fns.SetPixel.handler([dc, 5, 1, 0x00404040]), 0x00000000);
        assert.equal(fns.GetBitmapBits.handler([mask, 4, ROWS]), 4);
        assert.deepEqual([...ram.subarray(ROWS, ROWS + 4)], [0, 0, 0x18, 0]);

        // A colour bitmap made from bits keeps them the same way.
        ram.fill(0x11, CALLER, CALLER + 32);
        const colour = fns.CreateBitmap.handler([4, 2, 1, 32, CALLER]);
        ram.fill(0x77, CALLER, CALLER + 32);
        const other = fns.CreateCompatibleDC.handler([0]);
        fns.SelectObject.handler([other, colour]);
        assert.equal(fns.GetPixel.handler([other, 0, 0]), 0x00111111);
    }
    finally
    {
        await graphicsModule.dispose();
    }
});

/**
 * A DIB section selected into a memory DC of its own.
 *
 * @param {Awaited<ReturnType<typeof assemble>>} h
 * @param {{ width: number, height: number, bitCount: number, colors?: number[] }} shape
 *        `colors` as RGBQUAD dwords, 0x00RRGGBB.
 */
function section(h, { width, height, bitCount, colors = [] }){
    const { view, fns } = h;
    view.setUint32(INFO + BITMAPINFOHEADER.biSize, BITMAPINFOHEADER.SIZE, true);
    view.setInt32(INFO + BITMAPINFOHEADER.biWidth, width, true);
    view.setInt32(INFO + BITMAPINFOHEADER.biHeight, height, true);
    view.setUint16(INFO + BITMAPINFOHEADER.biPlanes, 1, true);
    view.setUint16(INFO + BITMAPINFOHEADER.biBitCount, bitCount, true);
    view.setUint32(INFO + BITMAPINFOHEADER.biCompression, 0, true);
    view.setUint32(INFO + BITMAPINFOHEADER.biClrUsed, colors.length, true);
    colors.forEach((color, index)=>
        view.setUint32(INFO + BITMAPINFOHEADER.SIZE + index * 4, color, true));
    const bitmap = fns.CreateDIBSection.handler([0, INFO, 0, ROWS, 0, 0]);
    assert.ok(bitmap > 0);
    const dc = fns.CreateCompatibleDC.handler([0]);
    fns.SelectObject.handler([dc, bitmap]);
    return { dc, bits: view.getUint32(ROWS, true) };
}

test('one-, four- and twenty-four-bit DIB sections are drawn into and blitted from', async()=>{
    const h = await assemble();
    try
    {
        const { ram, fns } = h;
        // Wine's test_mono_dibsection: a one-bit section whose table is white
        // then black; a Rectangle in the default pen and brush is a black
        // border round a white inside, and black is the entry that is set.
        const mono = section(h, { width: 10, height: 10, bitCount: 1,
            colors: [0x00ffffff, 0x00000000] });
        assert.equal(fns.Rectangle.handler([mono.dc, 0, 0, 10, 10]), 1);
        assert.equal(ram[mono.bits], 0xff, 'the bottom row, all border');
        assert.equal(ram[mono.bits + 4], 0x80, 'the row above it: border, then inside');

        const nibbles = section(h, { width: 4, height: -1, bitCount: 4,
            colors: [0, 0x00ff0000, 0x00ffffff] });
        assert.equal(fns.PatBlt.handler([nibbles.dc, 0, 0, 4, 1, WHITENESS]), 1);
        assert.deepEqual([...ram.subarray(nibbles.bits, nibbles.bits + 2)], [0x22, 0x22]);
        assert.equal(fns.SetPixel.handler([nibbles.dc, 1, 0, 0x000000f0]), 0x000000ff);

        const deep = section(h, { width: 2, height: -1, bitCount: 24 });
        assert.equal(fns.SetPixel.handler([deep.dc, 1, 0, 0x00123456]), 0x00123456);
        assert.deepEqual([...ram.subarray(deep.bits, deep.bits + 6)],
            [0, 0, 0, 0x12, 0x34, 0x56]);

        const screen = fns.GetDC.handler([0]);
        for (const { dc } of [mono, nibbles, deep])
        {
            assert.equal(fns.BitBlt.handler([screen, 0, 0, 2, 1, dc, 0, 0, SRCCOPY]), 1);
        }
        assert.equal(fns.GetPixel.handler([screen, 1, 0]), 0x00123456);
        fns.BitBlt.handler([screen, 0, 0, 4, 1, nibbles.dc, 0, 0, SRCCOPY]);
        assert.equal(fns.GetPixel.handler([screen, 1, 0]), 0x000000ff);
    }
    finally
    {
        await graphicsModule.dispose();
    }
});

test('a monochrome blit converts by the device contexts\' colours', async()=>{
    const h = await assemble();
    try
    {
        const { view, fns } = h;
        const target = section(h, { width: 4, height: -1, bitCount: 32 });
        /** @returns {number[]} */
        const row = ()=>[0, 1, 2, 3].map(x=>view.getUint32(target.bits + x * 4, true));

        // Wine's bitmap.c: a one-bit DIB section reads through its own table,
        // whatever the destination's text and background colours are.
        const indexed = section(h, { width: 4, height: -1, bitCount: 1,
            colors: [0x00123456, 0x00335577] });
        h.ram[indexed.bits] = 0x55;
        fns.SetTextColor.handler([target.dc, 0]);
        fns.SetBkColor.handler([target.dc, 0]);
        assert.equal(fns.StretchBlt.handler([target.dc, 0, 0, 4, 1, indexed.dc, 0, 0, 4, 1,
            SRCCOPY]), 1);
        assert.deepEqual(row(), [0x00123456, 0x00335577, 0x00123456, 0x00335577]);

        // A monochrome bitmap's 0 is the destination's text colour and its 1
        // the background colour.
        const maskDc = fns.CreateCompatibleDC.handler([0]);
        fns.SelectObject.handler([maskDc, fns.CreateBitmap.handler([16, 16, 1, 1, 0])]);
        fns.SetPixel.handler([maskDc, 0, 0, 0]);
        fns.SetPixel.handler([maskDc, 1, 0, 0x00ffffff]);
        fns.SetPixel.handler([maskDc, 2, 0, 0x00ffffff]);
        fns.SetPixel.handler([maskDc, 3, 0, 0]);
        fns.SetTextColor.handler([target.dc, 0x00664422]);
        fns.SetBkColor.handler([target.dc, 0x00214365]);
        assert.equal(fns.StretchBlt.handler([target.dc, 0, 0, 4, 1, maskDc, 0, 0, 4, 1,
            SRCCOPY]), 1);
        assert.deepEqual(row(), [0x00224466, 0x00654321, 0x00654321, 0x00224466]);

        // Into a monochrome bitmap, a pixel is 1 only where it is the source's
        // background colour -- the raw pixel, so 0x0fffffff is not white.
        const single = fns.CreateCompatibleDC.handler([0]);
        fns.SelectObject.handler([single, fns.CreateBitmap.handler([1, 1, 1, 1, 0])]);
        const source = section(h, { width: 1, height: 1, bitCount: 32 });
        view.setUint32(source.bits, 0x0fffffff, true);
        fns.SetBkColor.handler([source.dc, 0x00ffffff]);
        fns.StretchBlt.handler([single, 0, 0, 1, 1, source.dc, 0, 0, 1, 1, SRCCOPY]);
        fns.SetBkColor.handler([source.dc, 0x000000ff]);
        fns.StretchBlt.handler([source.dc, 0, 0, 1, 1, single, 0, 0, 1, 1, SRCCOPY]);
        assert.equal(fns.GetPixel.handler([source.dc, 0, 0]), 0);

        // Wine's test_bitmap_colors: a one-bit section onto a monochrome bitmap
        // compares with the table entry nearest the source's background.
        const mask = fns.CreateCompatibleDC.handler([0]);
        const maskBitmap = fns.CreateBitmap.handler([16, 8, 1, 1, 0]);
        fns.SelectObject.handler([mask, maskBitmap]);
        for (const [colors, expected] of [
            [[0x00fffff0, 0x00200000], 0x55],
            [[0x00000010, 0x00fff0ff], 0xaa],
        ])
        {
            const striped = section(h, { width: 16, height: -8, bitCount: 1,
                colors: /** @type {number[]} */ (colors) });
            h.ram.fill(0x55, striped.bits, striped.bits + 32);
            fns.SetTextColor.handler([striped.dc, 0x00ffffff]);
            fns.SetBkColor.handler([striped.dc, 0]);
            fns.BitBlt.handler([mask, 0, 0, 16, 8, striped.dc, 0, 0, SRCCOPY]);
            fns.GetBitmapBits.handler([maskBitmap, 2, ROWS + 0x40]);
            assert.deepEqual([...h.ram.subarray(ROWS + 0x40, ROWS + 0x42)],
                [expected, expected]);
        }
    }
    finally
    {
        await graphicsModule.dispose();
    }
});

test('a ramp gdi32 sets is the display\'s, and a full-screen device\'s is shown over it',
    async()=>{
        const { view, fns, graphics } = await assemble({ canvas: true });
        try
        {
            const screen = fns.GetDC.handler([0]);
            const COLORMGMTCAPS = 121;
            assert.equal(fns.GetDeviceCaps.handler([screen, COLORMGMTCAPS]), 2, 'CM_GAMMA_RAMP');
            /** @param {number} index @returns {number} red's entry, as GetDeviceGammaRamp reads */
            const readBack = index=>{
                assert.equal(fns.GetDeviceGammaRamp.handler([screen, ROWS + 0x800]), 1);
                return view.getUint16(ROWS + 0x800 + index * 2, true);
            };
            for (let index = 0; index < 3 * 256; index++)
            {
                view.setUint16(ROWS + index * 2, Math.min(0xffff, (index % 256) * 256 + 0x100),
                    true);
            }
            assert.equal(fns.SetDeviceGammaRamp.handler([screen, ROWS]), 1);
            assert.equal(readBack(1), 0x200, 'the ramp set, as the display holds it');

            const d3d9 = graphics.create('d3d9');
            /** @type {{ device?: any }} */
            const out = {};
            assert.equal(d3d9.CreateDevice({
                swapEffect: 1, backBufferCount: 1, backBufferWidth: 16, backBufferHeight: 8,
                backBufferFormat: 22, windowed: false,
            }, out), 0);
            const inverted = Uint16Array.from({ length: 256 }, (_, index)=>(255 - index) * 257);
            out.device.SetGammaRamp({ red: inverted, green: inverted, blue: inverted });
            assert.equal(readBack(0), 0xffff, 'the full-screen device\'s ramp is the display\'s');
            assert.equal(out.device.release(), 0);
            assert.equal(readBack(1), 0x200, 'and once it goes, GDI\'s is again');
        }
        finally
        {
            await graphicsModule.dispose();
        }
    });

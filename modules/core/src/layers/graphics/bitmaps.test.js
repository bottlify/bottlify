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
 */
async function assemble(){
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
        device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
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
        },
    });
    // The handlers declare only the arguments they read; a guest call always
    // carries the whole list.
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (gdi.table));
    return { ram, view, fns };
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

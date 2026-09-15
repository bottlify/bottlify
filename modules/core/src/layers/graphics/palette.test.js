/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One palette byte order, end to end.
 *
 * A palette entry lives under two conventions in this tree, and they must not
 * meet: a `PALETTEENTRY` is the bytes red, green, blue, flags in memory -- red
 * in the low byte of the little-endian dword -- while a surface pixel and a
 * resolved DIB colour table are `0x00RRGGBB`, blue in the low byte. The gdi32
 * half keeps entries as the guest wrote them and converts to pixels exactly
 * once, where a palette-relative bitmap's table is resolved; the presenter
 * takes entries in their raw order and expands them itself. Both are right on
 * their own side of that seam, and a swap anywhere in the chain is invisible
 * until a colour lands on the screen the wrong way round.
 *
 * So this is the whole chain pinned with one colour: a `CreatePalette` whose
 * entry is (R=0x40, G=0x34, B=0x30) written into guest memory as PALETTEENTRY
 * bytes, a `DIB_PAL_COLORS` bitmap whose index names that entry, an index byte
 * written into the bitmap as the program writes it, and the pixel as the
 * presenter uploads the desktop it was blitted to -- asserting the uploaded
 * texel is red 0x40, green 0x34, blue 0x30.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphicsModule } from './module.js';
import { createFakeDevice } from './webgpu/internal/fake-device.js';
import { createGdiFunctions } from '../win32/gdi32/functions.js';
import { BITMAPINFOHEADER, LOGPALETTE } from '../win32/gdi32/structs.js';

const SRCCOPY = 0x00cc0020;
const DIB_PAL_COLORS = 1;
const BI_RGB = 0;

/** Guest addresses, far enough apart that nothing overlaps. */
const LOGPALETTE_AT = 0x1000;
const INFO = 0x1200;
const BITS_POINTER = 0x1300;
const HEAP = 0x2000;
const SCREEN = { width: 8, height: 4, bitsPerPixel: 32 };

/**
 * Everything assembled: one flat guest memory, the graphics module over a
 * recording fake device, and the gdi32 tables wired to its drawing engine the
 * way app.js wires the real layers together.
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
    /** @type {(() => void)[]} */
    const armed = [];

    const graphics = await graphicsModule.create({
        device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
        screen: SCREEN,
        now: ()=>0,
        schedule: (/** @type {() => void} */ tick)=>armed.push(tick),
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
                return {
                    gdi: ()=>({
                        createSurfaceDc: (/** @type {any} */ attributes)=>
                            gdi.createSurfaceDc(attributes),
                        deleteSurfaceDc: (/** @type {number} */ handle)=>
                            gdi.deleteSurfaceDc(handle),
                        describeDrawable: (/** @type {number} */ hdc)=>
                            gdi.describeDrawable(hdc),
                    }),
                    heap: ()=>heap,
                    windows: ()=>[],
                };
            }
            return { callGuest: ()=>Promise.resolve(0) };
        },
    }));

    const drawing = graphics.gdiDrawing();
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>ram.subarray(address, address + length),
        writeMemory: (address, bytes)=>ram.set(bytes, address),
        readCString(address){
            let end = address;
            while (end < ram.length && ram[end] !== 0)
            {
                end++;
            }
            return new TextDecoder('latin1').decode(ram.subarray(address, end));
        },
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
            fontMetrics: font=>drawing.fontMetrics(font),
            textWidth: (font, text)=>drawing.textWidth(font, text),
            presentDesktop: ()=>drawing.presentDesktop(),
        },
    });
    return {
        ram,
        view,
        fns: gdi.table,
        /** Shows the desktop, as the window manager does at the end of a paint. */
        present: ()=>drawing.presentDesktop(),
        /** Runs the coalesced burst the way the display tick would. */
        settle(){
            armed.splice(0).forEach(tick=>tick());
        },
        /** The bytes of the last texture upload: BGRA, texel by texel. */
        uploaded(){
            const writes = gpu.of('writeTexture');
            assert.ok(writes.length > 0, 'something reached the queue');
            return writes[writes.length - 1].bytes;
        },
    };
}

test('the palette a program wrote lands on the screen in the order it wrote it', async()=>{
    const h = await assemble();
    try
    {
        // A LOGPALETTE with two PALETTEENTRYs, red first in memory as the
        // structure is defined: (0,0,0) and (0x40,0x34,0x30).
        h.view.setUint16(LOGPALETTE_AT + LOGPALETTE.palVersion, 0x300, true);
        h.view.setUint16(LOGPALETTE_AT + LOGPALETTE.palNumEntries, 2, true);
        const entry = LOGPALETTE_AT + LOGPALETTE.palPalEntry;
        h.ram.set([0x00, 0x00, 0x00, 0x00, 0x40, 0x34, 0x30, 0x00], entry);
        const palette = h.fns.CreatePalette.handler([LOGPALETTE_AT]);
        assert.ok(palette > 0);

        const screen = h.fns.GetDC.handler([0]);
        assert.ok(h.fns.SelectPalette.handler([screen, palette, 0]) >= 0);
        assert.equal(h.fns.RealizePalette.handler([screen]), 0);

        // A 4x2 top-down 8-bit DIB whose colour table is palette-relative:
        // index 0 means entry 0, index 1 means entry 1.
        h.view.setUint32(INFO + BITMAPINFOHEADER.biSize, BITMAPINFOHEADER.SIZE, true);
        h.view.setInt32(INFO + BITMAPINFOHEADER.biWidth, 4, true);
        h.view.setInt32(INFO + BITMAPINFOHEADER.biHeight, -2, true);
        h.view.setUint16(INFO + BITMAPINFOHEADER.biPlanes, 1, true);
        h.view.setUint16(INFO + BITMAPINFOHEADER.biBitCount, 8, true);
        h.view.setUint32(INFO + BITMAPINFOHEADER.biCompression, BI_RGB, true);
        h.view.setUint32(INFO + BITMAPINFOHEADER.biClrUsed, 2, true);
        h.view.setUint16(INFO + BITMAPINFOHEADER.SIZE, 0, true);
        h.view.setUint16(INFO + BITMAPINFOHEADER.SIZE + 2, 1, true);
        const bitmap = h.fns.CreateDIBSection.handler(
            [screen, INFO, DIB_PAL_COLORS, BITS_POINTER, 0, 0]);
        assert.ok(bitmap > 0, 'the section was made');
        const bits = h.view.getUint32(BITS_POINTER, true);

        const mem = h.fns.CreateCompatibleDC.handler([screen]);
        h.fns.SelectObject.handler([mem, bitmap]);

        // The program's own write: an index byte into the bits it was handed.
        h.ram[bits] = 1;
        assert.equal(h.fns.BitBlt.handler([screen, 0, 0, 4, 2, mem, 0, 0, SRCCOPY]), 1);

        // Through the palette the same colour reads back as: a COLORREF is
        // 0x00BBGGRR, so red 0x40 is the low byte here too.
        assert.equal(h.fns.GetPixel.handler([mem, 0, 0]), 0x00303440);

        // The paint pass over: the desktop is shown the way EndPaint shows it.
        h.present();
        h.settle();
        const bytes = h.uploaded();
        assert.deepEqual([...bytes.subarray(0, 4)], [0x30, 0x34, 0x40, 0xff],
            'the uploaded texel is R=0x40, G=0x34, B=0x30, blue first as bgra8unorm stores it');
        assert.deepEqual([...bytes.subarray(4, 8)], [0x00, 0x00, 0x00, 0xff],
            'and the index that named the empty entry stayed black');
    }
    finally
    {
        await graphicsModule.dispose();
    }
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the configured display reaches.
 *
 * The libraries that answer for a screen -- GetSystemMetrics in user32,
 * GetDeviceCaps in gdi32 -- each take one and each fall back to 640x480 when
 * they are not given one. Both fallbacks are correct and both were reached,
 * because nothing handed the module's own `screen` down to either: a caller
 * that configured a display got it in the drawing layer alone, and a program
 * asking the system how big the desktop is was told something the device it
 * then created did not match.
 *
 * These assert the wiring rather than the answer -- the answer already has
 * tests of its own next to each library -- so what they pin is that a screen
 * put into the module's configuration comes back out of both tables.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32Module } from './module.js';

/** SM_CXSCREEN and SM_CYSCREEN, the two a program sizes itself from. */
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

/** HORZRES, VERTRES and BITSPIXEL, as GetDeviceCaps indexes them. */
const HORZRES = 8;
const VERTRES = 10;
const BITSPIXEL = 12;

/** Deliberately none of the fallbacks, so a fallback cannot pass by accident. */
const SCREEN = { width: 1024, height: 768, bitsPerPixel: 16 };

/**
 * The least of a module graph this layer can be built over.
 *
 * Every entry is a thunk the tables close over rather than something they call
 * while being built, so answering nothing is enough for the two questions asked
 * here -- and an answer invented for one of them would be the test agreeing
 * with itself.
 *
 * @returns {import('../../system/contract.js').ScopedModuleHost}
 */
function stubHost(){
    // Handles that tell each other apart: a DC taken twice is two contexts, and
    // a table that hands out zero for both cannot show that.
    /** @type {Map<number, { type: string, object: any }>} */
    const opened = new Map();
    let nextHandle = 0x100;
    /** @type {Record<string, any>} */
    const apis = {
        memory: {
            readBytes: ()=>new Uint8Array(0),
            writeBytes: ()=>{},
            readCString: ()=>'',
            readWideString: ()=>'',
            readU32: ()=>0,
        },
        kernel: {
            handles: {
                /** @param {string} type @param {any} object */
                open: (type, object)=>{
                    const handle = nextHandle++;
                    opened.set(handle, { type, object });
                    return handle;
                },
                /** @param {number} handle */
                close: handle=>(opened.delete(handle) ? true : null),
                /** @param {number} handle */
                resolve: handle=>opened.get(handle)?.object ?? null,
                /** @param {number} handle */
                typeOf: handle=>opened.get(handle)?.type ?? null,
            },
            clock: { virtualTime: ()=>0 },
            currentThread: ()=>null,
            exitThread: ()=>{},
            setEvent: ()=>{},
            onTimeout: ()=>{},
        },
        bridge: {
            register: ()=>0,
            park: ()=>0,
            useHeap: ()=>{},
            publishInterface: ()=>0,
        },
        filesystem: {
            drives: ()=>[],
            stat: ()=>null,
        },
    };
    return /** @type {any} */ ({
        /** @param {string} name */
        requireApi: (/** @type {string} */ name)=>apis[name],
        provide: ()=>{},
    });
}

test('a configured screen reaches the libraries that answer for one', async()=>{
    const api = await win32Module.create({ screen: SCREEN }, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    const gdi32 = api.libraries()['GDI32.dll'];

    assert.equal(user32.GetSystemMetrics.handler([SM_CXSCREEN]), SCREEN.width);
    assert.equal(user32.GetSystemMetrics.handler([SM_CYSCREEN]), SCREEN.height);

    // A display DC: GetDC(NULL) is the desktop, which is the surface these
    // metrics describe.
    const dc = gdi32.GetDC.handler([0]);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, HORZRES]), SCREEN.width);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, VERTRES]), SCREEN.height);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, BITSPIXEL]), SCREEN.bitsPerPixel);

    await win32Module.dispose();
});

test('a DC taken through user32 is one GDI answers for', async()=>{
    // A program asks the display about itself through its own window: GetDC
    // on the window, GetDeviceCaps on what came back. Both libraries live in
    // this module, so user32 hands out GDI's context under the window's name
    // rather than a null one whose caps read as zero.
    const api = await win32Module.create({ screen: SCREEN }, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    const gdi32 = api.libraries()['GDI32.dll'];
    const hwnd = 0x40b4;

    const dc = user32.GetDC.handler([hwnd]);
    assert.notEqual(dc, 0, 'a window has a device context');
    assert.equal(gdi32.GetDeviceCaps.handler([dc, BITSPIXEL]), SCREEN.bitsPerPixel);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, HORZRES]), SCREEN.width);
    assert.equal(user32.ReleaseDC.handler([hwnd, dc]), 1);
    assert.equal(user32.ReleaseDC.handler([hwnd, dc]), 0, 'released once, gone');

    await win32Module.dispose();
});

test('no configured screen leaves both libraries on the same fallback', async()=>{
    const api = await win32Module.create({}, stubHost());
    const user32 = api.libraries()['USER32.dll'];
    const gdi32 = api.libraries()['GDI32.dll'];
    const dc = gdi32.GetDC.handler([0]);

    assert.equal(user32.GetSystemMetrics.handler([SM_CXSCREEN]), 640);
    assert.equal(gdi32.GetDeviceCaps.handler([dc, HORZRES]), 640);

    await win32Module.dispose();
});

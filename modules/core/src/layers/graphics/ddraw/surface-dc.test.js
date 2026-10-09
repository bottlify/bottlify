/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A DirectDraw surface's GetDC over the real gdi32 and drawing engine: the
 * DC draws into the surface's own rows, however far apart they are, and a DC
 * that could not be made leaves the surface free to lock.
 *
 * A text panel eight bits deep and 622 pixels wide has rows 622 bytes apart,
 * which no DIB has. gdi32 refused it, GetDC answered DD_OK with no DC, the
 * program never released what it was not given, and every Lock after that
 * was DDERR_SURFACEBUSY: the panel's buffer was never cleared again, and each
 * message was drawn over the last.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectDraw } from './objects.js';
import { painted } from '../../win32/gdi32/fixtures.test.js';

const DD_OK = 0;
const DDSCL_FULLSCREEN = 0x1;
const DDSCL_EXCLUSIVE = 0x8;
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSCAPS_OFFSCREENPLAIN = 0x40;
const DDSCAPS_PRIMARYSURFACE = 0x200;
const DDPCAPS_8BIT = 0x4;
const DDPCAPS_ALLOW256 = 0x40;
const PATCOPY = 0x00f00021;

/**
 * An eight-bit DirectDraw whose surfaces live in the fixture's memory and
 * whose GetDC is gdi32's own.
 *
 * @param {{ refuse?: boolean }} [options]  gdi32 makes no DC at all.
 */
function eightBit({ refuse = false } = {}){
    const machine = painted(4, 4);
    let next = 0x10000;
    const ddraw = createDirectDraw({
        version: 7,
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += (bytes + 0xff) & ~0xff;
            return at;
        },
        free: ()=>{},
        createDc: attributes=>(refuse ? 0 : machine.gdi.createSurfaceDc(attributes)),
        releaseDc: handle=>machine.gdi.deleteSurfaceDc(handle),
    });
    ddraw.setCooperativeLevel(0x1234, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    assert.equal(ddraw.setDisplayMode(640, 480, 8), DD_OK);
    const primary = /** @type {any} */ (ddraw.createSurface(
        { flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE }).surface);
    const grey = Array.from({ length: 256 }, (_, index)=>index * 0x010101);
    primary.setPalette(ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256, grey).palette);
    /** @param {number} width @param {number} height */
    const offscreen = (width, height)=>/** @type {any} */ (ddraw.createSurface({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT, caps: DDSCAPS_OFFSCREENPLAIN,
        width, height }).surface);
    return { machine, offscreen };
}

test('GetDC on a surface whose rows are not a DIB\'s apart draws into its own rows', ()=>{
    const { machine, offscreen } = eightBit();
    const panel = offscreen(622, 50);
    assert.equal(panel.pitch, 622);
    const got = panel.getDC();
    assert.equal(got.hr, DD_OK);
    assert.ok(got.dc, 'a DC to draw with');
    const { fns } = machine;
    fns.SelectObject.handler([got.dc, fns.CreateSolidBrush.handler([0x00808080])]);
    fns.PatBlt.handler([got.dc, 600, 10, 20, 2, PATCOPY]);
    assert.equal(panel.releaseDC(got.dc), DD_OK);

    // Grey 0x80 is index 0x80 of the palette; the fill is where the rows say.
    const row = (/** @type {number} */ y)=>panel.buffer + y * 622;
    assert.equal(machine.bytes[row(10) + 600], 0x80);
    assert.equal(machine.bytes[row(11) + 619], 0x80);
    assert.equal(machine.bytes[row(12) + 600], 0, 'nothing below the fill');
    assert.equal(panel.lock(null, 0).hr, DD_OK, 'released, the surface locks');
});

test('a DC gdi32 could not make is a failure, and the surface still locks', ()=>{
    const { offscreen } = eightBit({ refuse: true });
    const panel = offscreen(64, 8);
    const got = panel.getDC();
    assert.notEqual(got.hr, DD_OK);
    assert.equal(got.dc, null);
    assert.equal(panel.lock(null, 0).hr, DD_OK);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The DirectDraw seam, driven the way a guest drives it: through interface
 * pointers the bridge's own vtable publisher laid out, by slot number, over a
 * flat buffer standing in for guest memory. Surfaces are allocated inside
 * that buffer, so a blit's effect is read back as bytes at the surface's own
 * address -- byte-exact, because the engine computed them.
 *
 * Every test ends with the ddraw object destroyed: a count that did not reach
 * zero is a resource something still holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import { createGraphicsLibraries } from './exports.js';
import { createDirectDrawSeam } from './ddraw.js';
import {
    IDIRECTDRAW7_SLOTS, IDIRECTDRAW_SLOTS, IDIRECTDRAWSURFACE7_SLOTS, IDIRECTDRAWSURFACE_SLOTS,
    IDIRECTDRAWPALETTE_SLOTS, IDIRECTDRAWCLIPPER_SLOTS,
} from './vtables.js';
import { IID_IDirectDraw4, IID_IDirectDraw7, IID_IDirectDrawSurface7 } from './iids.js';
import { DDBLTFX, DDCAPS, RECT, createFields } from './structs.js';
import { DDSURFACEDESC, DDSURFACEDESC2, writeSurfaceDesc } from '../ddraw/structs.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDBLT_COLORFILL, DDCAPS_BLT, DDERR_DCALREADYCREATED, DDERR_INVALIDPARAMS,
    DDERR_NOCOOPERATIVELEVELSET, DDERR_NOTFLIPPABLE, DDERR_NOTFOUND, DDERR_SURFACEBUSY,
    DDPCAPS_8BIT, DDPF_RGB, DDSCAPS_COMPLEX, DDSCAPS_FLIP, DDSCAPS_OFFSCREENPLAIN,
    DDSCAPS_PRIMARYSURFACE, DDSCL_EXCLUSIVE, DDSCL_FULLSCREEN, DDSCL_NORMAL, DDSD_BACKBUFFERCOUNT,
    DDSD_CAPS, DDSD_HEIGHT, DDSD_PIXELFORMAT, DDSD_WIDTH, DD_OK,
} from '../ddraw/constants.js';

const HWND = 0x00010044;
const SCREEN = { width: 16, height: 16, bitsPerPixel: 32 };

/** @param {[string, number][]} slots @param {string} name */
const slot = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

/** A flat address space with the bridge's vtable publisher over it. */
function machine(){
    const bytes = new Uint8Array(1 << 20);
    let next = 0x100;
    const memory = {
        /** @param {number} at @param {number} length */
        readBytes: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} value */
        writeBytes: (at, value)=>bytes.set(value, at),
        /** @param {number} at */
        readU32: at=>(bytes[at] | bytes[at + 1] << 8
            | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0,
        /** @param {number} at @param {number} value */
        writeU32: (at, value)=>{
            bytes[at] = value & 0xff;
            bytes[at + 1] = value >>> 8 & 0xff;
            bytes[at + 2] = value >>> 16 & 0xff;
            bytes[at + 3] = value >>> 24 & 0xff;
        },
    };
    /** @type {Map<number, any>} */
    const registered = new Map();
    let nextTrap = 1;
    const vtables = createVtables({
        memory,
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            const id = nextTrap++;
            registered.set(id, { name, fn });
            return id;
        },
        heap: {
            /** @param {number} size */
            allocate: size=>{
                const at = next;
                next += size + 16 & ~15;
                return at;
            },
        },
    });
    /** Surfaces live inside the same buffer, from the top half down. */
    let surfaceNext = 0x80000;

    return {
        bytes,
        memory,
        services: {
            /** @param {number} at @param {number} length */
            readMemory: (at, length)=>bytes.slice(at, at + length),
            /** @param {number} at @param {Uint8Array} value */
            writeMemory: (at, value)=>bytes.set(value, at),
        },
        /** @param {number} size */
        allocateSurface: size=>{
            const at = surfaceNext;
            surfaceNext += size + 0xfff & ~0xfff;
            return at;
        },
        /** @param {any} object @param {string} id */
        publishInterface: (object, id)=>vtables.publish(object, id),
        /** @param {number} pointer @param {number} index @param {number[]} args */
        call(pointer, index, args = []){
            const table = memory.readU32(pointer);
            const trap = memory.readU32(table + index * 4);
            const entry = registered.get(trap);
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.fn.handler([pointer, ...args]) >>> 0;
        },
        /**
         * The same, with the answer as the method gave it: a promise stays one.
         *
         * @param {number} pointer @param {number} index @param {number[]} args
         * @returns {Promise<number>}
         */
        async callParked(pointer, index, args){
            const table = memory.readU32(pointer);
            const entry = registered.get(memory.readU32(table + index * 4));
            return (await entry.fn.handler([pointer, ...args])) >>> 0;
        },
        /** @param {number} pointer @param {number} index */
        argBytesOf(pointer, index){
            const table = memory.readU32(pointer);
            return registered.get(memory.readU32(table + index * 4)).fn.argBytes;
        },
        /** @param {number} at @param {string} guid */
        putGuid(at, guid){
            const hex = guid.replace(/[{}-]/g, '');
            const word = (/** @type {number} */ from, /** @type {number} */ width)=>
                parseInt(hex.slice(from, from + width), 16);
            memory.writeU32(at, word(0, 8));
            bytes[at + 4] = word(8, 4) & 0xff;
            bytes[at + 5] = word(8, 4) >>> 8;
            bytes[at + 6] = word(12, 4) & 0xff;
            bytes[at + 7] = word(12, 4) >>> 8;
            for (let index = 0; index < 8; index++)
            {
                bytes[at + 8 + index] = parseInt(hex.slice(16 + index * 2, 18 + index * 2), 16);
            }
            return at;
        },
    };
}

/**
 * The seam over real DirectDraw objects, with spies where GDI and the
 * presenter would be.
 */
function seamed(){
    const box = machine();
    let time = 0;
    /** @type {{ at: number, run: () => void }[]} */
    const timers = [];
    /** @type {any[]} */
    const roots = [];
    /** @type {any[]} */
    const dcs = [];
    /** @type {any[]} */
    const presented = [];
    let nextDc = 0x2000;
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const graphics = {
        /** @param {string} name @param {any} options */
        create: (name, options)=>{
            if (name !== 'ddraw')
            {
                return null;
            }
            const root = createDirectDraw({ ...options, allocate: box.allocateSurface });
            roots.push(root);
            return root;
        },
        available: ()=>false,
    };
    const libraries = createGraphicsLibraries({
        graphics,
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>SCREEN,
        now: ()=>time,
        schedule: (ms, run)=>{
            timers.push({ at: time + ms, run });
        },
        publisher,
        gdi: {
            createSurfaceDc: attributes=>{
                nextDc += 4;
                dcs.push({ event: 'create', handle: nextDc, attributes });
                return nextDc;
            },
            deleteSurfaceDc: handle=>{
                dcs.push({ event: 'delete', handle });
            },
        },
        present: surface=>presented.push(surface),
    });
    const fields = createFields(box.services);
    const ddrawDll = libraries.libraries['DDRAW.dll'];

    return {
        box,
        fields,
        roots,
        /** The display's clock, with what was waiting on it run as it passes. */
        clock: {
            now: ()=>time,
            /** @param {number} ms */
            set(ms){
                time = ms;
            },
            /** @param {number} ms */
            advance(ms){
                time += ms;
                for (const timer of timers.filter(t=>t.at <= time))
                {
                    timers.splice(timers.indexOf(timer), 1);
                    timer.run();
                }
            },
            pending: ()=>timers.length,
            /** Moves the clock to the first wait's time and wakes it. */
            wakeNext(){
                timers.sort((a, b)=>a.at - b.at);
                const timer = timers.shift();
                if (timer)
                {
                    time = timer.at;
                    timer.run();
                }
            },
        },
        dcs,
        presented,
        publisher,
        ddrawDll,
        /** A ddraw object as its seventh generation, under a cooperative level. */
        create7(level = DDSCL_NORMAL){
            const riid = box.putGuid(0x4000, IID_IDirectDraw7);
            assert.equal(ddrawDll.DirectDrawCreateEx.handler([0, 0x4100, riid, 0]), DD_OK);
            const pointer = box.memory.readU32(0x4100);
            assert.equal(box.call(pointer, slot(IDIRECTDRAW7_SLOTS, 'SetCooperativeLevel'),
                [HWND, level]), DD_OK);
            return pointer;
        },
        /**
         * @param {number} ddraw
         * @param {{ caps: number, width?: number, height?: number, backBufferCount?: number }} desc
         */
        createSurface7(ddraw, desc){
            const at = 0x5000;
            box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
            writeSurfaceDesc(box.services, at, DDSURFACEDESC2, {
                flags: DDSD_CAPS
                    | (desc.width === undefined ? 0 : DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT)
                    | (desc.backBufferCount === undefined ? 0 : DDSD_BACKBUFFERCOUNT),
                width: desc.width ?? 0,
                height: desc.height ?? 0,
                pitch: 0,
                backBufferCount: desc.backBufferCount ?? 0,
                mipMapCount: 0,
                caps: desc.caps,
                caps2: 0,
                pixelFormat: { size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
                    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0 },
            });
            const hr = box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateSurface'), [at, 0x5100, 0]);
            assert.equal(hr, DD_OK, 'the fixture surface is created');
            return box.memory.readU32(0x5100);
        },
        /** @param {number} surface @param {string} name @param {number[]} args */
        surface7: (surface, name, args)=>
            box.call(surface, slot(IDIRECTDRAWSURFACE7_SLOTS, name), args),
        /** @param {number} pointer */
        release: pointer=>box.call(pointer, 2, []),
        /** Every root the seam made is dead. */
        assertAllReleased(){
            for (const root of roots)
            {
                assert.ok(root.destroyed, 'the ddraw object reached zero on every generation');
            }
        },
    };
}

test('DirectDrawCreate hands back the first generation and CreateEx the seventh', ()=>{
    const h = seamed();
    assert.equal(h.ddrawDll.DirectDrawCreate.handler([0, 0x4100, 0]), DD_OK);
    const first = h.box.memory.readU32(0x4100);
    const table = h.box.memory.readU32(first);
    assert.notEqual(h.box.memory.readU32(table + (3 + IDIRECTDRAW_SLOTS.length - 1) * 4), 0,
        'WaitForVerticalBlank is the last slot of the first generation');
    assert.equal(h.box.argBytesOf(first, slot(IDIRECTDRAW_SLOTS, 'SetDisplayMode')), 4 + 3 * 4,
        'the first generation sets a mode with three arguments');

    const seventh = h.create7();
    assert.equal(h.box.argBytesOf(seventh, slot(IDIRECTDRAW7_SLOTS, 'SetDisplayMode')),
        4 + 5 * 4);
    const riid = h.box.putGuid(0x4000, IID_IDirectDraw4);
    assert.equal(h.ddrawDll.DirectDrawCreateEx.handler([0, 0x4200, riid, 0]) >>> 0,
        DDERR_INVALIDPARAMS, 'the Ex entry point makes only the seventh');
    assert.equal(h.ddrawDll.DirectDrawCreate.handler([0, 0x4100, 0x1234]) >>> 0, 0x80040110,
        'aggregation is refused');

    assert.equal(h.release(first), 0);
    assert.equal(h.release(seventh), 0);
    h.assertAllReleased();
});

test('a newer generation is reachable from an older pointer, with its own longer table', ()=>{
    const h = seamed();
    assert.equal(h.ddrawDll.DirectDrawCreate.handler([0, 0x4100, 0]), DD_OK);
    const first = h.box.memory.readU32(0x4100);
    const riid = h.box.putGuid(0x4000, IID_IDirectDraw7);
    assert.equal(h.box.call(first, 0, [riid, 0x4300]), 0, 'QueryInterface for IDirectDraw7');
    const seventh = h.box.memory.readU32(0x4300);
    assert.notEqual(seventh, first);
    const table = h.box.memory.readU32(seventh);
    assert.notEqual(h.box.memory.readU32(table + (3 + IDIRECTDRAW7_SLOTS.length - 1) * 4), 0);

    // The two generations do not share a count: the query took one reference
    // on the seventh and none on the first, so releasing the seventh brings it
    // to zero while the object lives on, held by the first.
    const model = h.roots[0];
    assert.equal(model.refCount('IDirectDraw'), 1);
    assert.equal(model.refCount('IDirectDraw7'), 1);
    assert.equal(h.box.call(seventh, 1, []), 2, 'AddRef through the seventh');
    assert.equal(model.refCount('IDirectDraw'), 1, 'leaves the first alone');
    assert.equal(h.release(seventh), 1);
    assert.equal(h.release(seventh), 0);
    assert.equal(model.destroyed, false, 'zero on one generation is not the end');
    assert.equal(h.release(first), 0);
    h.assertAllReleased();
});

test('CreateSurface reads the descriptor its generation takes, after the earlier checks', ()=>{
    const h = seamed();
    const riid = h.box.putGuid(0x4000, IID_IDirectDraw7);
    assert.equal(h.ddrawDll.DirectDrawCreateEx.handler([0, 0x4100, riid, 0]), DD_OK);
    const ddraw = h.box.memory.readU32(0x4100);

    // Garbage where the descriptor should be, and no cooperative level: the
    // level is what the program hears about.
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateSurface'), [0x5000, 0x5100, 0]),
        DDERR_NOCOOPERATIVELEVELSET);
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'SetCooperativeLevel'),
        [HWND, DDSCL_NORMAL]), DD_OK);

    // The older layout handed to the seventh generation has the wrong size.
    writeSurfaceDesc(h.box.services, 0x5000, DDSURFACEDESC, {
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT, width: 8, height: 8, pitch: 0,
        backBufferCount: 0, mipMapCount: 0, caps: DDSCAPS_OFFSCREENPLAIN, caps2: 0,
        pixelFormat: { size: 0x20, flags: 0, fourCC: 0, bitCount: 0, redMask: 0, greenMask: 0,
            blueMask: 0, alphaMask: 0 },
    });
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateSurface'), [0x5000, 0x5100, 0]),
        DDERR_INVALIDPARAMS);

    const surface = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8 });
    assert.notEqual(surface, 0);
    const table = h.box.memory.readU32(surface);
    assert.notEqual(h.box.memory.readU32(table + (3 + IDIRECTDRAWSURFACE7_SLOTS.length - 1) * 4),
        0, 'the surface is a seventh-generation one');

    // Read back through GetSurfaceDesc, which needs the caller to have sized
    // the structure.
    h.box.memory.writeU32(0x5200, DDSURFACEDESC.SIZE);
    assert.equal(h.surface7(surface, 'GetSurfaceDesc', [0x5200]), DDERR_INVALIDPARAMS);
    h.box.memory.writeU32(0x5200, DDSURFACEDESC2.SIZE);
    assert.equal(h.surface7(surface, 'GetSurfaceDesc', [0x5200]), DD_OK);
    assert.equal(h.box.memory.readU32(0x5200 + DDSURFACEDESC2.dwWidth), 8);
    assert.equal(h.box.memory.readU32(0x5200 + DDSURFACEDESC2.lPitch), 32);

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('a lock hands out the corner it named, and a refused lock hands out null', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const surface = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8 });
    const model = h.publisher.objectAt(surface);
    const desc = 0x5200;
    const lockSlot = slot(IDIRECTDRAWSURFACE7_SLOTS, 'Lock');

    h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
    assert.equal(h.box.call(surface, lockSlot, [0, desc, 0, 0]), DD_OK);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.lpSurface), model.buffer);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.lPitch), 32);

    // Locked twice: busy, and the pointer field is nulled rather than left
    // pointing at the surface.
    assert.equal(h.box.call(surface, lockSlot, [0, desc, 0, 0]), DDERR_SURFACEBUSY);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.lpSurface), 0);
    assert.equal(h.surface7(surface, 'Unlock', [0]), DD_OK);

    // A partial lock: pBits - base == top * pitch + left * bpp, pitch unchanged.
    h.fields.writeStruct(0x5300, RECT, { left: 3, top: 2, right: 6, bottom: 5 });
    h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
    assert.equal(h.box.call(surface, lockSlot, [0x5300, desc, 0, 0]), DD_OK);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.lpSurface) - model.buffer,
        2 * 32 + 3 * 4);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.lPitch), 32);
    assert.equal(h.surface7(surface, 'Unlock', [0x5300]), DD_OK);

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('GetDC is a real device context over the surface, and not a mutex with Lock', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const surface = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8 });
    const model = h.publisher.objectAt(surface);
    const out = 0x5400;

    h.box.memory.writeU32(out, 0xdeadbeef);
    assert.equal(h.surface7(surface, 'GetDC', [out]), DD_OK);
    const hdc = h.box.memory.readU32(out);
    assert.notEqual(hdc, 0xdeadbeef);
    assert.deepEqual(h.dcs[0], { event: 'create', handle: hdc, attributes: {
        width: 8, height: 8, pitch: 32, bitCount: 32, bits: model.buffer, palette: null,
        format: '555',
    } }, 'GDI was told exactly where the pixels are');

    h.box.memory.writeU32(out, 0xdeadbeef);
    assert.equal(h.surface7(surface, 'GetDC', [out]), DDERR_DCALREADYCREATED);
    assert.equal(h.box.memory.readU32(out), 0xdeadbeef, 'the handle was left alone');

    const desc = 0x5200;
    h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
    assert.equal(h.surface7(surface, 'Lock', [0, desc, 0, 0]), DDERR_SURFACEBUSY,
        'a held DC blocks a lock');
    assert.equal(h.surface7(surface, 'ReleaseDC', [hdc]), DD_OK);
    assert.deepEqual(h.dcs[1], { event: 'delete', handle: hdc });

    h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
    assert.equal(h.surface7(surface, 'Lock', [0, desc, 0, 0]), DD_OK);
    assert.equal(h.surface7(surface, 'GetDC', [out]), DD_OK, 'but a held lock does not block a DC');
    assert.equal(h.surface7(surface, 'ReleaseDC', [h.box.memory.readU32(out)]), DD_OK);
    assert.equal(h.surface7(surface, 'Unlock', [0]), DD_OK);

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('a flip chain walks front to back and closes, and only the front flips', ()=>{
    const h = seamed();
    const ddraw = h.create7(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    const front = h.createSurface7(ddraw,
        { caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP, backBufferCount: 3 });
    const other = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 16, height: 16 });

    const caps = 0x5500;
    h.box.memory.writeU32(caps, DDSCAPS_FLIP);
    const behind = (/** @type {number} */ surface)=>{
        assert.equal(h.surface7(surface, 'GetAttachedSurface', [caps, 0x5600]), DD_OK);
        const next = h.box.memory.readU32(0x5600);
        assert.equal(h.release(next) >= 1, true, 'the walk took a reference it now gives back');
        return next;
    };
    const back1 = behind(front);
    const back2 = behind(back1);
    const back3 = behind(back2);
    assert.equal(behind(back3), front, 'the loop closes on the front');
    assert.ok(new Set([front, back1, back2, back3]).size === 4);

    const desc = 0x5200;
    for (const [surface, count] of [[front, 3], [back1, 0], [back2, 0], [back3, 0]])
    {
        h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
        assert.equal(h.surface7(surface, 'GetSurfaceDesc', [desc]), DD_OK);
        assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.dwBackBufferCount), count,
            'only the front knows how long the chain is');
    }

    assert.equal(h.surface7(back1, 'Flip', [0, 0]), DDERR_NOTFLIPPABLE, 'a back buffer');
    assert.equal(h.surface7(front, 'Flip', [other, 0]), DDERR_NOTFLIPPABLE, 'a foreign surface');
    assert.equal(h.surface7(front, 'Flip', [front, 0]), DDERR_NOTFLIPPABLE, 'itself');
    const before = h.publisher.objectAt(front).buffer;
    assert.equal(h.surface7(front, 'Flip', [0, 0]), DD_OK);
    assert.notEqual(h.publisher.objectAt(front).buffer, before, 'the front now shows a back');
    assert.equal(h.presented.length, 1, 'and the screen was told');
    assert.equal(h.presented[0].buffer, h.publisher.objectAt(front).buffer);
    assert.equal(h.presented[0].bitCount, 32);

    assert.equal(h.release(other), 0);
    assert.equal(h.release(front), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('byte-exact: a colour fill and a BltFast move the bytes they say, and show the screen', ()=>{
    const h = seamed();
    const ddraw = h.create7(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    const primary = h.createSurface7(ddraw, { caps: DDSCAPS_PRIMARYSURFACE });
    const sprite = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2 });
    const spriteModel = h.publisher.objectAt(sprite);
    const primaryModel = h.publisher.objectAt(primary);

    // Fill the sprite: DDBLTFX with a fill colour whose bytes are all different.
    const fx = 0x5700;
    h.box.memory.writeU32(fx + DDBLTFX.dwSize, DDBLTFX.SIZE);
    h.box.memory.writeU32(fx + DDBLTFX.dwFillColor, 0x00123456);
    assert.equal(h.surface7(sprite, 'Blt', [0, 0, 0, DDBLT_COLORFILL, fx]), DD_OK);
    assert.deepEqual([...h.box.bytes.subarray(spriteModel.buffer, spriteModel.buffer + 16)],
        [0x56, 0x34, 0x12, 0, 0x56, 0x34, 0x12, 0, 0x56, 0x34, 0x12, 0, 0x56, 0x34, 0x12, 0],
        'blue byte first, little-endian, every pixel');
    assert.equal(h.presented.length, 0, 'an offscreen surface is not the screen');

    // Copy it onto the primary at (3, 1): the sprite's rows land at that corner.
    assert.equal(h.surface7(primary, 'BltFast', [3, 1, sprite, 0, 0]), DD_OK);
    const pitch = primaryModel.pitch;
    const at = (/** @type {number} */ x, /** @type {number} */ y)=>
        h.box.memory.readU32(primaryModel.buffer + y * pitch + x * 4);
    assert.equal(at(3, 1), 0x00123456);
    assert.equal(at(4, 2), 0x00123456);
    assert.equal(at(2, 1), 0, 'the pixel to the left is untouched');
    assert.equal(at(5, 1), 0, 'and the one to the right');
    assert.equal(at(3, 3), 0, 'and the row below');
    assert.equal(h.presented.length, 1, 'a blit onto the primary is a change to the screen');

    assert.equal(h.release(sprite), 0);
    assert.equal(h.release(primary), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

// --- colour keys, after Wine's ddraw7 test_range_colorkey and test_ck_operation ---

const DDSD_CKDESTBLT = 0x00004000;
const DDSD_CKSRCBLT = 0x00010000;
const DDCKEY_COLORSPACE = 0x00000001;
const DDCKEY_DESTBLT = 0x00000002;
const DDCKEY_SRCBLT = 0x00000008;
const DDBLT_KEYSRC = 0x00008000;
const DDBLTFAST_SRCCOLORKEY = 0x00000001;
const DDERR_NOCOLORKEYHW = 0x887600dc;

/**
 * A 32-bit X8R8G8B8 surface created with extra descriptor flags and, when
 * given, a source key written into the descriptor. Answers the HRESULT and the
 * surface.
 *
 * @param {ReturnType<typeof seamed>} h @param {number} ddraw
 * @param {{ caps: number, width: number, flags?: number, srcKey?: [number, number] }} desc
 */
function createKeyed(h, ddraw, desc){
    const at = 0x5000;
    h.box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
    writeSurfaceDesc(h.box.services, at, DDSURFACEDESC2, {
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | (desc.flags ?? 0),
        width: desc.width, height: 1, pitch: 0, backBufferCount: 0, mipMapCount: 0,
        caps: desc.caps, caps2: 0,
        pixelFormat: { size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
            redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0 },
    });
    if (desc.srcKey)
    {
        h.box.memory.writeU32(at + DDSURFACEDESC2.ddckCKSrcBlt, desc.srcKey[0]);
        h.box.memory.writeU32(at + DDSURFACEDESC2.ddckCKSrcBlt + 4, desc.srcKey[1]);
    }
    h.box.memory.writeU32(0x5100, 0xdeadbeef);
    const hr = h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateSurface'), [at, 0x5100, 0]);
    return { hr, surface: hr === DD_OK ? h.box.memory.readU32(0x5100) : 0 };
}

test('a colour key is one value: a range collapses to its low end, or is refused', ()=>{
    const h = seamed();
    const ddraw = h.create7();

    // A range at creation is refused, whichever way round it is.
    for (const range of /** @type {[number, number][]} */ ([[0, 1], [1, 0]]))
    {
        assert.equal(createKeyed(h, ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 1,
            flags: DDSD_CKSRCBLT, srcKey: range }).hr, DDERR_NOCOLORKEYHW, `${range}`);
    }
    const { hr, surface } = createKeyed(h, ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 1,
        flags: DDSD_CKSRCBLT, srcKey: [0, 0] });
    assert.equal(hr, DD_OK);

    const key = 0x6100;
    const got = 0x6200;
    /** @param {number} which @param {number} low @param {number} high */
    const set = (which, low, high)=>{
        h.box.memory.writeU32(key, low);
        h.box.memory.writeU32(key + 4, high);
        return h.surface7(surface, 'SetColorKey', [which, key]);
    };
    const get = ()=>{
        assert.equal(h.surface7(surface, 'GetColorKey', [DDCKEY_SRCBLT, got]), DD_OK);
        return [h.box.memory.readU32(got), h.box.memory.readU32(got + 4)];
    };

    assert.equal(set(DDCKEY_SRCBLT, 0, 1), DD_OK);
    assert.deepEqual(get(), [0, 0], 'without DDCKEY_COLORSPACE only the low value counts');
    assert.equal(set(DDCKEY_SRCBLT, 1, 0), DD_OK);
    assert.deepEqual(get(), [1, 1]);

    assert.equal(set(DDCKEY_SRCBLT | DDCKEY_COLORSPACE, 0, 0), DD_OK,
        'a colour space of one value is a key');
    assert.deepEqual(get(), [0, 0], 'and is the key the plain name reads back');
    assert.equal(set(DDCKEY_SRCBLT | DDCKEY_COLORSPACE, 1, 0), DDERR_NOCOLORKEYHW);
    assert.equal(set(DDCKEY_SRCBLT | DDCKEY_COLORSPACE, 0, 1), DDERR_NOCOLORKEYHW);
    assert.equal(set(DDCKEY_DESTBLT | DDCKEY_COLORSPACE, 0, 1), DDERR_NOCOLORKEYHW);
    assert.equal(set(DDCKEY_SRCBLT | DDCKEY_COLORSPACE, 0, 0x01010101), DDERR_NOCOLORKEYHW);
    assert.deepEqual(get(), [0, 0], 'none of the refusals changed the key');

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('byte-exact: a key given at creation keys a blit on its colour bits alone', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const dst = createKeyed(h, ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 4 }).surface;
    const made = createKeyed(h, ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 4,
        flags: DDSD_CKSRCBLT, srcKey: [0x00ff00ff, 0x00ff00ff] });
    assert.equal(made.hr, DD_OK);
    const src = made.surface;
    const srcModel = h.publisher.objectAt(src);
    const dstModel = h.publisher.objectAt(dst);
    [0x77010203, 0x00010203, 0x77ff00ff, 0x00ff00ff].forEach((value, index)=>
        h.box.memory.writeU32(srcModel.buffer + index * 4, value));
    const pixels = ()=>[0, 1, 2, 3].map(index=>h.box.memory.readU32(dstModel.buffer + index * 4));

    for (const blit of [
        ()=>h.surface7(dst, 'Blt', [0, src, 0, DDBLT_KEYSRC, 0]),
        ()=>h.surface7(dst, 'BltFast', [0, 0, src, 0, DDBLTFAST_SRCCOLORKEY]),
    ])
    {
        [0, 1, 2, 3].forEach(index=>h.box.memory.writeU32(dstModel.buffer + index * 4,
            0xcccccccc));
        assert.equal(blit(), DD_OK);
        // The unused top byte takes no part in the comparison and is copied
        // with the rest of the pixel: the result Wine's test takes as its own.
        assert.deepEqual(pixels(), [0x77010203, 0x00010203, 0xcccccccc, 0xcccccccc]);
    }

    // GetSurfaceDesc carries the key, flagged as present.
    const key = 0x6100;
    h.box.memory.writeU32(key, 0x0000ff00);
    h.box.memory.writeU32(key + 4, 0x0000ff00);
    assert.equal(h.surface7(src, 'SetColorKey', [DDCKEY_SRCBLT, key]), DD_OK);
    const desc = 0x6400;
    h.box.bytes.fill(0, desc, desc + DDSURFACEDESC2.SIZE);
    h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
    assert.equal(h.surface7(src, 'GetSurfaceDesc', [desc]), DD_OK);
    const flags = h.box.memory.readU32(desc + DDSURFACEDESC2.dwFlags);
    assert.ok((flags & DDSD_CKSRCBLT) !== 0, 'DDSD_CKSRCBLT');
    assert.equal(flags & DDSD_CKDESTBLT, 0, 'no destination key was set');
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.ddckCKSrcBlt), 0x0000ff00);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.ddckCKSrcBlt + 4), 0x0000ff00);

    assert.equal(h.release(src), 0);
    assert.equal(h.release(dst), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

// --- fills, after Wine's ddraw7 test_color_fill ---

const DDSCAPS_ZBUFFER = 0x00020000;
const DDPF_ZBUFFER = 0x00000400;

/**
 * A sixteen-bit depth buffer, width by one, through the seventh generation.
 *
 * @param {ReturnType<typeof seamed>} h @param {number} ddraw @param {number} width
 */
function createDepth(h, ddraw, width){
    const at = 0x5000;
    h.box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
    writeSurfaceDesc(h.box.services, at, DDSURFACEDESC2, {
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
        width, height: 1, pitch: 0, backBufferCount: 0, mipMapCount: 0,
        caps: DDSCAPS_ZBUFFER, caps2: 0,
        pixelFormat: { size: 0x20, flags: DDPF_ZBUFFER, fourCC: 0, bitCount: 16,
            redMask: 0, greenMask: 0xffff, blueMask: 0, alphaMask: 0 },
    });
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateSurface'), [at, 0x5100, 0]),
        DD_OK);
    return h.box.memory.readU32(0x5100);
}

test('a colour fill is refused on a depth buffer, which it would leave as it was', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const depth = createDepth(h, ddraw, 4);
    const model = h.publisher.objectAt(depth);
    h.box.bytes.fill(0x11, model.buffer, model.buffer + 8);
    const fx = 0x5700;
    h.box.bytes.fill(0, fx, fx + DDBLTFX.SIZE);
    h.box.memory.writeU32(fx + DDBLTFX.dwSize, DDBLTFX.SIZE);
    h.box.memory.writeU32(fx + DDBLTFX.dwFillColor, 0xdeadbeef);

    assert.equal(h.surface7(depth, 'Blt', [0, 0, 0, DDBLT_COLORFILL, fx]), DDERR_INVALIDPARAMS);
    assert.deepEqual([...h.box.bytes.subarray(model.buffer, model.buffer + 8)],
        new Array(8).fill(0x11));

    assert.equal(h.release(depth), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('DeleteAttachedSurface with no surface detaches all of them', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const target = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 4, height: 1 });
    const depth = createDepth(h, ddraw, 4);
    assert.equal(h.surface7(target, 'AddAttachedSurface', [depth]), DD_OK);

    assert.equal(h.surface7(target, 'DeleteAttachedSurface', [0, 0]), DD_OK);
    h.box.bytes.fill(0, 0x7600, 0x7610);
    h.box.memory.writeU32(0x7600, DDSCAPS_ZBUFFER);
    assert.equal(h.surface7(target, 'GetAttachedSurface', [0x7600, 0x7700]), DDERR_NOTFOUND);

    assert.equal(h.release(target), 0);
    assert.equal(h.release(depth), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('the GDI surface is the primary: none without one, flipped to only on a flip chain', ()=>{
    // After Wine's ddraw1 test_gdi_surface.
    const h = seamed();
    const ddraw = h.create7();
    const out = 0x7800;
    const gdi = ()=>h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'GetGDISurface'), [out]);
    const flipToGdi = ()=>h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'FlipToGDISurface'), []);

    h.box.memory.writeU32(out, 0xc0dec0de);
    assert.equal(gdi(), DDERR_NOTFOUND, 'no primary, no GDI surface');
    assert.equal(h.box.memory.readU32(out), 0, 'and the out-parameter says so');
    assert.equal(flipToGdi(), DDERR_NOTFOUND);

    const primary = h.createSurface7(ddraw, { caps: DDSCAPS_PRIMARYSURFACE });
    assert.equal(gdi(), DD_OK);
    assert.equal(h.box.memory.readU32(out), primary);
    assert.equal(h.release(primary), 1, 'GetGDISurface took a reference');
    assert.equal(flipToGdi(), DDERR_NOTFLIPPABLE, 'a primary without a chain has nothing to flip');
    assert.equal(h.release(primary), 0);

    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'SetCooperativeLevel'),
        [HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN]), DD_OK);
    const front = h.createSurface7(ddraw, {
        caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP, backBufferCount: 1,
    });
    assert.equal(h.surface7(front, 'Flip', [0, 0]), DD_OK);
    assert.equal(flipToGdi(), DD_OK);
    assert.equal(gdi(), DD_OK);
    assert.equal(h.box.memory.readU32(out), front);
    assert.equal(h.release(front), 1);

    assert.equal(h.release(front), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

// --- the raster ---

test('the vertical blank comes round once a refresh, and a wait for it lasts until it does',
    async()=>{
        const DDWAITVB_BLOCKBEGIN = 1;
        const DDWAITVB_BLOCKBEGINEVENT = 2;
        const DDWAITVB_BLOCKEND = 4;
        const h = seamed();
        const ddraw = h.create7();
        const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
            h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, name), args);
        const out = 0x7900;
        const period = 1000 / 60;
        const blank = ()=>{
            assert.equal(call('GetVerticalBlankStatus', [out]), DD_OK);
            return h.box.memory.readU32(out);
        };

        h.clock.set(1);
        assert.equal(blank(), 0, 'the top of a frame is not the blank');
        h.clock.set(period - 0.1);
        assert.equal(blank(), 1, 'its last lines are');
        h.clock.set(period + 1);
        assert.equal(blank(), 0, 'and the next frame has started');
        assert.equal(call('GetScanLine', [out]), DD_OK);
        assert.ok(h.box.memory.readU32(out) > 0, 'a scan line that moves with the clock');

        // A wait is a promise the bridge parks the caller on until the clock
        // reaches the edge it names.
        let settled = false;
        const begun = h.box.callParked(ddraw, slot(IDIRECTDRAW7_SLOTS, 'WaitForVerticalBlank'),
            [DDWAITVB_BLOCKBEGIN, 0]).then(hr=>{
            settled = true;
            return hr;
        });
        await Promise.resolve();
        assert.equal(settled, false, 'nothing returns before the blank');
        h.clock.advance(period / 2);
        await Promise.resolve();
        assert.equal(settled, false, 'nor half a frame later, in the frame\'s visible part');
        h.clock.wakeNext();
        assert.equal(await begun, DD_OK);
        assert.ok(h.clock.now() < 2 * period, 'woken in the frame it was waiting in');
        assert.equal(blank(), 1, 'and on return the blank is on');

        const toEnd = h.box.callParked(ddraw, slot(IDIRECTDRAW7_SLOTS, 'WaitForVerticalBlank'),
            [DDWAITVB_BLOCKEND, 0]);
        h.clock.wakeNext();
        assert.equal(await toEnd, DD_OK);
        assert.equal(blank(), 0, 'the end of the blank is the top of the next frame');

        assert.equal(call('WaitForVerticalBlank', [DDWAITVB_BLOCKBEGINEVENT, 0]),
            0x80004001, 'the event form the documentation says is unsupported');
        assert.equal(call('WaitForVerticalBlank', [0x80, 0]), DDERR_INVALIDPARAMS);
        assert.equal(h.clock.pending(), 0);

        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();
    });

test('a surface keeps private data under a GUID, an interface entry with a reference', ()=>{
    // After Wine's ddraw7 test_private_data: the reader takes no reference,
    // and a read with no buffer is refused unless the room is too small.
    const DDSPD_IUNKNOWNPOINTER = 1;
    const DDERR_MOREDATA = 0x887602b2;
    const h = seamed();
    const ddraw = h.create7();
    const surface = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 4, height: 4 });
    const guid = h.box.putGuid(0x7a00, '{FDB37466-428F-4EDF-A37F-9B1DF488C5FC}');
    const other = h.box.putGuid(0x7a10, '{2E5AFAC2-87B5-4C10-9B4B-89D7D112E72B}');
    const model = h.roots[0];
    const count = ()=>model.refCount('IDirectDraw7');

    assert.equal(h.surface7(surface, 'SetPrivateData', [guid, 0, 4, DDSPD_IUNKNOWNPOINTER]),
        DDERR_INVALIDPARAMS);
    assert.equal(h.surface7(surface, 'SetPrivateData', [guid, 0, 0, 0]), DDERR_INVALIDPARAMS);
    assert.equal(h.surface7(surface, 'SetPrivateData', [guid, ddraw, 5, DDSPD_IUNKNOWNPOINTER]),
        DDERR_INVALIDPARAMS);

    const before = count();
    assert.equal(h.surface7(surface, 'SetPrivateData', [guid, ddraw, 4, DDSPD_IUNKNOWNPOINTER]),
        DD_OK);
    assert.equal(count(), before + 1);
    assert.equal(h.surface7(surface, 'FreePrivateData', [guid]), DD_OK);
    assert.equal(count(), before);

    assert.equal(h.surface7(surface, 'SetPrivateData', [guid, ddraw, 4, DDSPD_IUNKNOWNPOINTER]),
        DD_OK);
    const data = 0x7b00;
    const sizeAt = 0x7b10;
    h.box.memory.writeU32(sizeAt, 8);
    assert.equal(h.surface7(surface, 'GetPrivateData', [guid, data, sizeAt]), DD_OK);
    assert.equal(h.box.memory.readU32(data), ddraw);
    assert.equal(h.box.memory.readU32(sizeAt), 4);
    assert.equal(count(), before + 1, 'the reader takes no reference');

    h.box.memory.writeU32(sizeAt, 1);
    assert.equal(h.surface7(surface, 'GetPrivateData', [guid, 0, sizeAt]), DDERR_MOREDATA);
    assert.equal(h.box.memory.readU32(sizeAt), 4);
    h.box.memory.writeU32(sizeAt, 8);
    assert.equal(h.surface7(surface, 'GetPrivateData', [guid, 0, sizeAt]), DDERR_INVALIDPARAMS);
    assert.equal(h.box.memory.readU32(sizeAt), 8);
    assert.equal(h.surface7(surface, 'GetPrivateData', [other, 0, 0]), DDERR_NOTFOUND);
    assert.equal(h.surface7(surface, 'GetPrivateData', [guid, 0, 0]), DDERR_INVALIDPARAMS);

    // A volatile entry lasts only as long as the surface's contents.
    const DDSPD_VOLATILE = 2;
    const DDERR_EXPIRED = 0x887602b3;
    h.box.memory.writeU32(0x7c00, 7);
    assert.equal(h.surface7(surface, 'SetPrivateData', [other, 0x7c00, 4, DDSPD_VOLATILE]),
        DD_OK);
    h.box.memory.writeU32(sizeAt, 4);
    assert.equal(h.surface7(surface, 'GetPrivateData', [other, data, sizeAt]), DD_OK);
    assert.equal(h.surface7(surface, 'ChangeUniquenessValue', []), DD_OK);
    assert.equal(h.surface7(surface, 'GetPrivateData', [other, data, sizeAt]), DDERR_EXPIRED);

    // The surface's going lets go of what its entries held, and of the
    // reference a seventh-generation surface holds on the object that made it.
    assert.equal(h.release(surface), 0);
    assert.equal(count(), before - 1);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('a palette round-trips its entries and is owned by the surface it is set on', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const entries = 0x5800;
    for (let index = 0; index < 256; index++)
    {
        h.box.memory.writeU32(entries + index * 4, 0x01000000 * (index & 3) + index);
    }
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreatePalette'),
        [DDPCAPS_8BIT, entries, 0x5900, 0]), DD_OK);
    const palette = h.box.memory.readU32(0x5900);
    const paletteModel = h.publisher.objectAt(palette);

    h.box.memory.writeU32(0x5a00, 0);
    assert.equal(h.box.call(palette, slot(IDIRECTDRAWPALETTE_SLOTS, 'SetEntries'),
        [0, 10, 1, 0x5a00]), DD_OK);
    assert.equal(h.box.call(palette, slot(IDIRECTDRAWPALETTE_SLOTS, 'GetEntries'),
        [0, 9, 3, 0x5b00]), DD_OK);
    assert.deepEqual([0x5b00, 0x5b04, 0x5b08].map(address=>h.box.memory.readU32(address)),
        [0x01000009, 0, 0x0300000b], 'entry ten was overwritten and its neighbours were not');
    assert.equal(h.box.call(palette, slot(IDIRECTDRAWPALETTE_SLOTS, 'GetEntries'),
        [0, 250, 10, 0x5b00]), DDERR_INVALIDPARAMS, 'past the end');

    const surface = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 4, height: 4 });
    const surfaceModel = h.publisher.objectAt(surface);
    assert.equal(h.surface7(surface, 'SetPalette', [palette]), DD_OK);
    assert.equal(paletteModel.refCount, 2, 'SetPalette raises the palette');
    assert.equal(surfaceModel.refCount, 1, 'and leaves the surface alone');
    assert.equal(h.surface7(surface, 'GetPalette', [0x5c00]), DD_OK);
    assert.equal(h.box.memory.readU32(0x5c00), palette, 'the same interface pointer');
    assert.equal(paletteModel.refCount, 3);
    assert.equal(h.release(palette), 2);

    assert.equal(h.release(surface), 0);
    assert.equal(paletteModel.refCount, 1, 'releasing the surface detached the palette');
    assert.equal(h.release(palette), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('a clipper carries its list as RGNDATA, both ways', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateClipper'), [0, 0x5900, 0]),
        DD_OK);
    const clipper = h.box.memory.readU32(0x5900);
    assert.equal(h.publisher.objectAt(h.box.memory.readU32(0x5900)).refCount, 1);

    const region = 0x5d00;
    h.box.memory.writeU32(region + 4, 1);
    h.box.memory.writeU32(region + 8, 2);
    h.fields.writeStruct(region + 32, RECT, { left: 1, top: 2, right: 3, bottom: 4 });
    h.fields.writeStruct(region + 48, RECT, { left: 5, top: 6, right: 7, bottom: 8 });
    assert.equal(h.box.call(clipper, slot(IDIRECTDRAWCLIPPER_SLOTS, 'SetClipList'), [region, 0]),
        DD_OK);

    // Asked for the size first, then given a buffer.
    const size = 0x5e00;
    h.box.memory.writeU32(size, 0);
    assert.equal(h.box.call(clipper, slot(IDIRECTDRAWCLIPPER_SLOTS, 'GetClipList'), [0, 0, size]),
        DD_OK);
    assert.equal(h.box.memory.readU32(size), 32 + 2 * 16);
    const out = 0x5f00;
    assert.equal(h.box.call(clipper, slot(IDIRECTDRAWCLIPPER_SLOTS, 'GetClipList'),
        [0, out, size]), DD_OK);
    assert.equal(h.box.memory.readU32(out + 8), 2, 'two rectangles');
    assert.deepEqual(h.fields.readStruct(out + 16, RECT),
        { left: 1, top: 2, right: 7, bottom: 8 }, 'bounded by their union');
    assert.deepEqual(h.fields.readStruct(out + 48, RECT), { left: 5, top: 6, right: 7, bottom: 8 });

    assert.equal(h.box.call(clipper, slot(IDIRECTDRAWCLIPPER_SLOTS, 'IsClipListChanged'),
        [0x6000]), DD_OK);
    assert.equal(h.box.memory.readU32(0x6000), 1);
    assert.equal(h.box.call(clipper, slot(IDIRECTDRAWCLIPPER_SLOTS, 'SetHWnd'), [0, HWND]), DD_OK);
    assert.equal(h.box.call(clipper, slot(IDIRECTDRAWCLIPPER_SLOTS, 'GetHWnd'), [0x6000]), DD_OK);
    assert.equal(h.box.memory.readU32(0x6000), HWND);

    assert.equal(h.release(clipper), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('the caps say what this build can do, and refuse a structure of an unknown size', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const caps = 0x6100;
    h.box.memory.writeU32(caps + DDCAPS.dwSize, 0x100);
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'GetCaps'), [caps, 0]),
        DDERR_INVALIDPARAMS);
    h.box.memory.writeU32(caps + DDCAPS.dwSize, DDCAPS.SIZE);
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'GetCaps'), [caps, 0]), DD_OK);
    assert.equal(h.box.memory.readU32(caps + DDCAPS.dwCaps) & DDCAPS_BLT, DDCAPS_BLT);
    assert.ok(h.box.memory.readU32(caps + DDCAPS.dwVidMemTotal) > 0);

    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('a mode set through the first generation is what the seventh reads back', ()=>{
    const h = seamed();
    assert.equal(h.ddrawDll.DirectDrawCreate.handler([0, 0x4100, 0]), DD_OK);
    const first = h.box.memory.readU32(0x4100);
    assert.equal(h.box.call(first, slot(IDIRECTDRAW_SLOTS, 'SetDisplayMode'), [8, 4, 8]), DD_OK,
        'a mode is set with no cooperative level');
    assert.equal(h.box.call(first, slot(IDIRECTDRAW_SLOTS, 'SetCooperativeLevel'),
        [HWND, DDSCL_NORMAL]), DD_OK);

    const desc = 0x5200;
    h.box.memory.writeU32(desc, DDSURFACEDESC.SIZE);
    assert.equal(h.box.call(first, slot(IDIRECTDRAW_SLOTS, 'GetDisplayMode'), [desc]), DD_OK);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC.dwWidth), 8);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC.dwHeight), 4);
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC.lPitch), 8, 'one byte a pixel');
    assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC.ddpfPixelFormat + 0x0c), 8);

    // A primary made now is 8x4 at 8 bits, and the presenter is handed the
    // palette to show it with.
    writeSurfaceDesc(h.box.services, 0x5000, DDSURFACEDESC, {
        flags: DDSD_CAPS, width: 0, height: 0, pitch: 0, backBufferCount: 0, mipMapCount: 0,
        caps: DDSCAPS_PRIMARYSURFACE, caps2: 0,
        pixelFormat: { size: 0x20, flags: 0, fourCC: 0, bitCount: 0, redMask: 0, greenMask: 0,
            blueMask: 0, alphaMask: 0 },
    });
    assert.equal(h.box.call(first, slot(IDIRECTDRAW_SLOTS, 'CreateSurface'), [0x5000, 0x5100, 0]),
        DD_OK);
    const primary = h.box.memory.readU32(0x5100);
    const table = h.box.memory.readU32(primary);
    assert.notEqual(h.box.memory.readU32(table + (3 + IDIRECTDRAWSURFACE_SLOTS.length - 1) * 4), 0,
        'the first generation hands back a first-generation surface');
    assert.equal(h.box.argBytesOf(primary, 3 + IDIRECTDRAWSURFACE_SLOTS.length - 1), 4 + 2 * 4,
        'UpdateOverlayZOrder is its last slot');
    assert.equal(h.publisher.objectAt(primary).width, 8);
    assert.equal(h.publisher.objectAt(primary).bytesPerPixel, 1);

    const riid = h.box.putGuid(0x4000, IID_IDirectDrawSurface7);
    assert.equal(h.box.call(primary, 0, [riid, 0x6200]), 0, 'and the seventh is a query away');
    const seventh = h.box.memory.readU32(0x6200);
    h.box.memory.writeU32(0x5200, DDSURFACEDESC2.SIZE);
    assert.equal(h.surface7(seventh, 'GetSurfaceDesc', [0x5200]), DD_OK);
    assert.equal(h.box.memory.readU32(0x5200 + DDSURFACEDESC2.dwWidth), 8);
    assert.equal(h.release(seventh), 1);

    assert.equal(h.release(primary), 0);
    assert.equal(h.release(first), 0);
    h.assertAllReleased();
});

/**
 * The enumerations, driven through the descriptors directly: each answers
 * with a promise the bridge would suspend the caller on, and the vtable
 * harness above reads a slot's answer as a number.
 */
function enumerating(){
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    /** @type {{ entry: number, args: number[], desc: any }[]} */
    const calls = [];
    let cancelAfter = Infinity;
    const seam = createDirectDrawSeam({
        publisher,
        memory: box.services,
        screen: ()=>SCREEN,
        callGuest: async({ entry, args })=>{
            // What the callback was shown is read now, while it is valid.
            calls.push({ entry, args, desc: {
                width: box.memory.readU32(args[args.length - 2] + DDSURFACEDESC2.dwWidth),
                height: box.memory.readU32(args[args.length - 2] + DDSURFACEDESC2.dwHeight),
                bitCount: box.memory.readU32(
                    args[args.length - 2] + DDSURFACEDESC2.ddpfPixelFormat + 0x0c),
                caps: box.memory.readU32(args[args.length - 2] + DDSURFACEDESC2.dwCaps),
            } });
            return calls.length >= cancelAfter ? 0 : 1;
        },
        scratch: { allocate: box.allocateSurface },
    });
    const root = createDirectDraw({ version: 7, allocate: box.allocateSurface,
        screenWidth: SCREEN.width, screenHeight: SCREEN.height });
    root.setCooperativeLevel(HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    const ddraw7 = seam.interfaces.ddraw[3];
    const surface7 = seam.interfaces.surface[4];
    /** @param {any} descriptor @param {string} name */
    const method = (descriptor, name)=>{
        const found = descriptor.methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(found && found.invoke, `${name} is implemented`);
        return found.invoke;
    };
    return {
        box,
        publisher,
        calls,
        root,
        cancel: (/** @type {number} */ after)=>{
            cancelAfter = after;
        },
        /** @param {string} name @param {number[]} args */
        ddraw: (name, args)=>method(ddraw7, name)(root, args),
        /** @param {any} surface @param {string} name @param {number[]} args */
        surface: (surface, name, args)=>method(surface7, name)(surface, args),
    };
}

test('EnumDisplayModes names every mode at every depth, and stops when told', async()=>{
    const h = enumerating();
    assert.equal(await h.ddraw('EnumDisplayModes', [0, 0, 0x77, 0x1234]), DD_OK);
    // The table has four sizes; the 16x16 screen is not one of them, so five.
    assert.equal(h.calls.length, 5 * 3);
    assert.deepEqual(h.calls[0].desc, { width: 640, height: 480, bitCount: 8, caps: 0 });
    assert.deepEqual(h.calls[5].desc, { width: 800, height: 600, bitCount: 32, caps: 0 });
    assert.deepEqual(h.calls[14].desc, { width: 16, height: 16, bitCount: 32, caps: 0 });
    assert.equal(h.calls[0].entry, 0x1234);
    assert.equal(h.calls[0].args[1], 0x77, 'the context travels');
    assert.equal(h.ddraw('EnumDisplayModes', [0, 0, 0, 0]), DDERR_INVALIDPARAMS, 'no callback');

    h.calls.length = 0;
    h.cancel(2);
    assert.equal(await h.ddraw('EnumDisplayModes', [0, 0, 0, 0x1234]), DD_OK);
    assert.equal(h.calls.length, 2, 'DDENUMRET_CANCEL ends the walk');
    assert.equal(h.root.release('IDirectDraw7'), 0);
});

test('EnumAttachedSurfaces hands each attachment over with a reference of its own', async()=>{
    const h = enumerating();
    const made = h.root.createSurface({
        flags: DDSD_CAPS | DDSD_BACKBUFFERCOUNT,
        caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
        backBufferCount: 2,
    });
    assert.equal(made.hr, DD_OK);
    const front = /** @type {any} */ (made.surface);

    assert.equal(await h.surface(front, 'EnumAttachedSurfaces', [0x55, 0x2000]), DD_OK);
    assert.equal(h.calls.length, 1, 'the front has one attachment, the first back buffer');
    const back = /** @type {any} */ (h.publisher.objectAt(h.calls[0].args[0]));
    assert.equal(back, front.flipNext);
    assert.equal(back.refCount, 2, 'the callback owns a reference the program releases');
    assert.equal(h.calls[0].desc.width, 16);
    assert.equal(h.calls[0].desc.caps & DDSCAPS_FLIP, DDSCAPS_FLIP);
    assert.equal(h.calls[0].args[2], 0x55);
    assert.equal(back.release(), 1);

    assert.equal(front.release(), 0);
    assert.equal(h.root.release('IDirectDraw7'), 0);
    assert.ok(h.root.destroyed);
});

test('EnumSurfaces names all of them, or those that match the caps described', async()=>{
    const h = enumerating();
    /** @type {any} */
    const plain = h.root.createSurface({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        caps: DDSCAPS_OFFSCREENPLAIN, width: 4, height: 4 });
    /** @type {any} */
    const primary = h.root.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE });
    assert.equal(plain.hr, DD_OK);
    assert.equal(primary.hr, DD_OK);

    assert.equal(await h.ddraw('EnumSurfaces', [1, 0, 0, 0x3000]), DD_OK);
    assert.equal(h.calls.length, 2, 'DDENUMSURFACES_ALL');
    for (const call of h.calls)
    {
        h.publisher.objectAt(call.args[0]).release();
    }

    h.calls.length = 0;
    const wanted = 0x6000;
    h.box.memory.writeU32(wanted + DDSURFACEDESC2.dwCaps, DDSCAPS_PRIMARYSURFACE);
    assert.equal(await h.ddraw('EnumSurfaces', [2, wanted, 0, 0x3000]), DD_OK);
    assert.equal(h.calls.length, 1, 'DDENUMSURFACES_MATCH');
    assert.equal(h.publisher.objectAt(h.calls[0].args[0]), primary.surface);
    primary.surface.release();

    h.calls.length = 0;
    assert.equal(await h.ddraw('EnumSurfaces', [4, wanted, 0, 0x3000]), DD_OK);
    assert.equal(h.calls.length, 1, 'DDENUMSURFACES_NOMATCH');
    assert.equal(h.publisher.objectAt(h.calls[0].args[0]), plain.surface);
    plain.surface.release();

    assert.equal(plain.surface.release(), 0);
    assert.equal(primary.surface.release(), 0);
    assert.equal(h.root.release('IDirectDraw7'), 0);
    assert.ok(h.root.destroyed);
});

test('without a way into the guest an enumeration names nothing and succeeds', ()=>{
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const seam = createDirectDrawSeam({ publisher, memory: box.services, screen: ()=>SCREEN });
    const root = createDirectDraw({ version: 7 });
    const method = /** @type {any} */ (seam.interfaces.ddraw[3].methods.find(
        (/** @type {any} */ m)=>m.name === 'EnumDisplayModes'));
    assert.equal(method.invoke(root, [0, 0, 0, 0x1234]), DD_OK);
    assert.equal(root.release('IDirectDraw7'), 0);
});

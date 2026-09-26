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
import {
    IID_IDirectDraw4, IID_IDirectDraw7, IID_IDirectDrawGammaControl, IID_IDirectDrawSurface7,
} from './iids.js';
import { IDIRECTDRAWGAMMACONTROL_SLOTS } from './vtables-ddraw.js';
import { DDBLTFX, DDCAPS, DDCOLORKEY, RECT, createFields } from './structs.js';
import {
    DDDEVICEIDENTIFIER2, DDSURFACEDESC, DDSURFACEDESC2, MAX_DDDEVICEID_STRING, writeSurfaceDesc,
} from '../ddraw/structs.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDBLT_COLORFILL, DDCAPS2_PRIMARYGAMMA, DDCAPS_BLT, DDERR_DCALREADYCREATED, DDERR_INVALIDPARAMS,
    DDGDI_GETHOSTIDENTIFIER, DDERR_NOCOOPERATIVELEVELSET, DDERR_NOTFLIPPABLE, DDERR_NOTFOUND,
    DDERR_NOTONMIPMAPSUBLEVEL, DDERR_SURFACEBUSY, DDPCAPS_8BIT, DDPF_RGB,
    DDSCAPS2_MIPMAPSUBLEVEL, DDSCAPS_BACKBUFFER, DDSCAPS_COMPLEX, DDSCAPS_FLIP, DDSCAPS_MIPMAP,
    DDSCAPS_OFFSCREENPLAIN, DDSCAPS_PRIMARYSURFACE, DDSCAPS_TEXTURE, DDSCL_EXCLUSIVE,
    DDSCL_FULLSCREEN, DDSCL_NORMAL, DDSD_BACKBUFFERCOUNT, DDSD_CAPS, DDSD_HEIGHT,
    DDSD_MIPMAPCOUNT, DDSD_PIXELFORMAT, DDSD_WIDTH, DD_OK, DDERR_UNSUPPORTED,
    DDERR_EXCLUSIVEMODEALREADYSET, DDERR_NOEXCLUSIVEMODE, DDERR_SURFACELOST, DDERR_WRONGMODE,
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
 *
 * @param {{ adapter?: any, gamma?: any, deactivated?: () => boolean,
 *     deactivations?: () => number }} [build]
 *     What the build says the hardware is, where a primary's gamma ramp is
 *     shown, and whether (and how often) the application has been deactivated.
 */
function seamed(build = {}){
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
        adapter: ()=>build.adapter ?? null,
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
        gamma: build.gamma,
        deactivated: build.deactivated,
        deactivations: build.deactivations,
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
         * @param {{ caps: number, caps2?: number, width?: number, height?: number,
         *   backBufferCount?: number, mipMapCount?: number }} desc
         */
        createSurface7(ddraw, desc){
            const at = 0x5000;
            box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
            writeSurfaceDesc(box.services, at, DDSURFACEDESC2, {
                flags: DDSD_CAPS
                    | (desc.width === undefined ? 0 : DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT)
                    | (desc.backBufferCount === undefined ? 0 : DDSD_BACKBUFFERCOUNT)
                    | (desc.mipMapCount === undefined ? 0 : DDSD_MIPMAPCOUNT),
                width: desc.width ?? 0,
                height: desc.height ?? 0,
                pitch: 0,
                backBufferCount: desc.backBufferCount ?? 0,
                mipMapCount: desc.mipMapCount ?? 0,
                caps: desc.caps,
                caps2: desc.caps2 ?? 0,
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

test('a mip chain reports its levels through the descriptor and is walked level by level', ()=>{
    // Wine's ddraw7 test_mipmap: DDSD_MIPMAPCOUNT is set on every level, each
    // counting itself and those below, in GetSurfaceDesc and Lock alike, and
    // the walk by DDSCAPS_COMPLEX ends in DDERR_NOTFOUND.
    const h = seamed();
    const ddraw = h.create7();
    const top = h.createSurface7(ddraw, {
        caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP,
        width: 128, height: 32, mipMapCount: 3,
    });
    const caps = 0x5500;
    const out = 0x5600;
    const desc = 0x5200;
    h.box.bytes.fill(0, caps, caps + 16);
    h.box.memory.writeU32(caps, DDSCAPS_COMPLEX);

    const levels = [top];
    for (;;)
    {
        const hr = h.surface7(levels[levels.length - 1], 'GetAttachedSurface', [caps, out]);
        if (hr !== DD_OK)
        {
            assert.equal(hr, DDERR_NOTFOUND);
            break;
        }
        levels.push(h.box.memory.readU32(out));
    }
    assert.equal(levels.length, 3);
    levels.forEach((level, index)=>{
        for (const method of ['GetSurfaceDesc', 'Lock'])
        {
            h.box.bytes.fill(0, desc, desc + DDSURFACEDESC2.SIZE);
            h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
            assert.equal(h.surface7(level, method,
                method === 'Lock' ? [0, desc, 0, 0] : [desc]), DD_OK);
            const flags = h.box.memory.readU32(desc + DDSURFACEDESC2.dwFlags);
            assert.equal(flags & DDSD_MIPMAPCOUNT, DDSD_MIPMAPCOUNT, `${method} of level ${index}`);
            assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.dwMipMapCount), 3 - index);
            assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.dwWidth), 128 >> index);
            assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.dwHeight), 32 >> index);
            if (method === 'Lock')
            {
                assert.equal(h.surface7(level, 'Unlock', [0]), DD_OK);
            }
        }
    });

    h.box.memory.writeU32(0x5700, 0xff);
    h.box.memory.writeU32(0x5704, 0xff);
    assert.equal(h.surface7(levels[1], 'SetColorKey', [DDCKEY_SRCBLT, 0x5700]),
        DDERR_NOTONMIPMAPSUBLEVEL);
    assert.equal(h.surface7(top, 'SetColorKey', [DDCKEY_SRCBLT, 0x5700]), DD_OK);

    assert.equal(h.release(levels[2]), 1);
    assert.equal(h.release(levels[1]), 1);
    assert.equal(h.release(top), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('GetAttachedSurface reads both words of a DDSCAPS2 and wants every bit of each', ()=>{
    // Wine's ddraw7 test_gdi_surface: the front of a flip chain hands back
    // the buffer behind it for DDSCAPS_BACKBUFFER.
    const h = seamed();
    const ddraw = h.create7(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    const front = h.createSurface7(ddraw,
        { caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP, backBufferCount: 1 });
    const caps = 0x5500;
    const out = 0x5600;
    /** @param {number} dwCaps @param {number} dwCaps2 */
    const ask = (dwCaps, dwCaps2)=>{
        h.box.bytes.fill(0, caps, caps + 16);
        h.box.memory.writeU32(caps, dwCaps);
        h.box.memory.writeU32(caps + 4, dwCaps2);
        return h.surface7(front, 'GetAttachedSurface', [caps, out]);
    };

    assert.equal(ask(DDSCAPS_BACKBUFFER, 0), DD_OK);
    const back = h.box.memory.readU32(out);
    assert.notEqual(back, front);
    assert.equal(h.release(back), 1);
    assert.equal(ask(DDSCAPS_BACKBUFFER, DDSCAPS2_MIPMAPSUBLEVEL), DDERR_NOTFOUND,
        'the back buffer is no mip level');

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

test('a depth fill writes a depth buffer\'s depth bits, and nothing else takes one', ()=>{
    // After Wine's ddraw7 test_color_fill: DDBLT_DEPTHFILL is DD_OK on a
    // Z-buffer and DDERR_INVALIDPARAMS on anything else, the depth being
    // dwFillDepth, which shares dwFillColor's place.
    const DDBLT_DEPTHFILL = 0x02000000;
    const h = seamed();
    const ddraw = h.create7();
    const depth = createDepth(h, ddraw, 4);
    const model = h.publisher.objectAt(depth);
    const fx = 0x5700;
    h.box.bytes.fill(0, fx, fx + DDBLTFX.SIZE);
    h.box.memory.writeU32(fx + DDBLTFX.dwSize, DDBLTFX.SIZE);
    h.box.memory.writeU32(fx + DDBLTFX.dwFillColor, 0xdeadbeef);

    assert.equal(h.surface7(depth, 'Blt', [0, 0, 0, DDBLT_DEPTHFILL, fx]), DD_OK);
    const values = ()=>[0, 1, 2, 3].map(x=>h.box.bytes[model.buffer + x * 2]
        | h.box.bytes[model.buffer + x * 2 + 1] << 8);
    assert.deepEqual(values(), [0xbeef, 0xbeef, 0xbeef, 0xbeef], 'the Z mask of the value');

    const rect = 0x5800;
    h.box.memory.writeU32(rect, 1);
    h.box.memory.writeU32(rect + 4, 0);
    h.box.memory.writeU32(rect + 8, 3);
    h.box.memory.writeU32(rect + 12, 1);
    h.box.memory.writeU32(fx + DDBLTFX.dwFillColor, 0x1234);
    assert.equal(h.surface7(depth, 'Blt', [rect, 0, 0, DDBLT_DEPTHFILL, fx]), DD_OK);
    assert.deepEqual(values(), [0xbeef, 0x1234, 0x1234, 0xbeef], 'and only inside the rectangle');

    const plain = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 4, height: 1 });
    assert.equal(h.surface7(plain, 'Blt', [0, 0, 0, DDBLT_DEPTHFILL, fx]), DDERR_INVALIDPARAMS);

    assert.equal(h.release(plain), 0);
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
    // Wine's ddraw tests look here for DDSCAPS_TEXTURE | DDSCAPS_MIPMAP before
    // building a mip chain; both copies of the surface caps carry it.
    const surfaces = DDSCAPS_TEXTURE | DDSCAPS_MIPMAP | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    assert.equal(h.box.memory.readU32(caps + DDCAPS.ddsCaps) & surfaces, surfaces);
    assert.equal(h.box.memory.readU32(caps + DDCAPS.ddsOldCaps) & surfaces, surfaces);
    h.box.bytes.fill(0, caps, caps + DDCAPS.SIZE);
    h.box.memory.writeU32(caps + DDCAPS.dwSize, 0x13c);
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'GetCaps'), [caps, 0]), DD_OK);
    assert.equal(h.box.memory.readU32(caps + DDCAPS.ddsOldCaps) & surfaces, surfaces,
        'the older structure has only the one');
    assert.equal(h.box.memory.readU32(caps + DDCAPS.ddsCaps), 0, 'and nothing past its end');

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

test('DirectDrawEnumerate names the primary display driver to its callback, the ANSI forms only',
    async()=>{
        // ddrawmodes.c 129-308: a null callback is DDERR_INVALIDPARAMS, the
        // context reaches the callback, the primary device is one callback
        // with a null GUID, Ex refuses unknown flags; the wide forms are not
        // implemented on Windows and say DDERR_UNSUPPORTED.
        const box = machine();
        /** @type {{ entry: number, args: number[], description: string, name: string }[]} */
        const calls = [];
        /** @param {number} at */
        const text = at=>{
            const end = box.bytes.indexOf(0, at);
            return String.fromCharCode(...box.bytes.subarray(at, end));
        };
        const libraries = createGraphicsLibraries({
            graphics: { create: ()=>null, available: ()=>false },
            memory: box.services,
            publishInterface: box.publishInterface,
            screen: ()=>SCREEN,
            callGuest: async({ entry, args })=>{
                calls.push({ entry, args, description: text(args[1]), name: text(args[2]) });
                return 1;
            },
            scratch: { allocate: box.allocateSurface },
        }).libraries['DDRAW.dll'];

        assert.equal(await libraries.DirectDrawEnumerateA.handler([0, 0]), DDERR_INVALIDPARAMS);
        assert.equal(await libraries.DirectDrawEnumerateA.handler([0x1234, 0xdeadbeef]), DD_OK);
        assert.equal(calls.length, 1, 'one device: the primary');
        assert.deepEqual(calls[0], { entry: 0x1234, args: calls[0].args,
            description: 'Primary Display Driver', name: 'display' });
        assert.equal(calls[0].args.length, 4);
        assert.equal(calls[0].args[0], 0, 'the primary is named by a null GUID');
        assert.equal(calls[0].args[3], 0xdeadbeef, 'the context travels');

        calls.length = 0;
        const ex = libraries.DirectDrawEnumerateExA;
        assert.equal(ex.argBytes, 12);
        assert.equal(await ex.handler([0, 0, 0]), DDERR_INVALIDPARAMS);
        assert.equal(await ex.handler([0x1234, 0, ~0]), DDERR_INVALIDPARAMS, 'unknown flags');
        assert.equal(calls.length, 0);
        assert.equal(await ex.handler([0x1234, 0x77, 7]), DD_OK, 'every documented flag');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args.length, 5, 'and a monitor');
        assert.deepEqual([calls[0].args[0], calls[0].args[3], calls[0].args[4]], [0, 0x77, 0],
            'the primary device has no monitor handle of its own');

        calls.length = 0;
        assert.equal(await libraries.DirectDrawEnumerateW.handler([0, 0]), DDERR_INVALIDPARAMS);
        assert.equal(await libraries.DirectDrawEnumerateW.handler([0x1234, 0]),
            DDERR_UNSUPPORTED);
        assert.equal(await libraries.DirectDrawEnumerateExW.handler([0x1234, 0, 0]),
            DDERR_UNSUPPORTED);
        assert.equal(await libraries.DirectDrawEnumerateExW.handler([0, 0, 0]),
            DDERR_UNSUPPORTED);
        assert.equal(calls.length, 0, 'the wide forms call nothing');
    });

test('GetDeviceIdentifier names the driver DLL and the adapter, and fills its own layout only',
    ()=>{
        // ddrawmodes.c: DD_OK with no flags and with DDGDI_GETHOSTIDENTIFIER,
        // a driver name with ".dll" in it, each string's last byte cleared,
        // and nothing written past dwWHQLLevel -- the structure's size
        // rounded to eight is not its size.
        const h = seamed({ adapter: { vendor: 'nvidia', architecture: 'ampere' } });
        const ddraw = h.create7();
        const out = 0x8000;
        const size = DDDEVICEIDENTIFIER2.SIZE;
        const identifierSlot = slot(IDIRECTDRAW7_SLOTS, 'GetDeviceIdentifier');
        /** @param {number} at @returns {string} */
        const text = at=>{
            const bytes = h.box.bytes.subarray(out + at, out + at + MAX_DDDEVICEID_STRING);
            return String.fromCharCode(...bytes.subarray(0, bytes.indexOf(0)));
        };

        for (const flags of [0, DDGDI_GETHOSTIDENTIFIER])
        {
            h.box.bytes.fill(0xcc, out, out + size + 8);
            assert.equal(h.box.call(ddraw, identifierSlot, [out, flags]), DD_OK);
            assert.match(text(DDDEVICEIDENTIFIER2.szDriver), /\.dll/);
            assert.equal(text(DDDEVICEIDENTIFIER2.szDescription), 'nvidia ampere');
            assert.equal(h.box.bytes[out + MAX_DDDEVICEID_STRING - 1], 0);
            assert.equal(h.box.bytes[out + DDDEVICEIDENTIFIER2.szDescription
                + MAX_DDDEVICEID_STRING - 1], 0);
            assert.equal(h.box.memory.readU32(out + DDDEVICEIDENTIFIER2.dwVendorId), 0x10de,
                'the vendor a program keys its card table by');
            assert.equal(h.box.memory.readU32(out + DDDEVICEIDENTIFIER2.dwDeviceId), 0);
            assert.equal(h.box.memory.readU32(out + DDDEVICEIDENTIFIER2.dwWHQLLevel), 1);
            assert.equal(h.box.memory.readU32(out + size), 0xcccccccc, 'nothing past the end');
            assert.equal(h.box.memory.readU32(out + size + 4), 0xcccccccc);
        }
        assert.equal(h.box.call(ddraw, identifierSlot, [0, 0]), DDERR_INVALIDPARAMS);
        assert.equal(h.box.call(ddraw, identifierSlot, [out, 2]), DDERR_INVALIDPARAMS);

        // The fourth generation's structure has no WHQL level, and its end
        // is where that field would be.
        const riid = h.box.putGuid(0x4000, IID_IDirectDraw4);
        assert.equal(h.box.call(ddraw, 0, [riid, 0x4300]), DD_OK);
        const fourth = h.box.memory.readU32(0x4300);
        h.box.bytes.fill(0xcc, out, out + size + 8);
        assert.equal(h.box.call(fourth, identifierSlot, [out, 0]), DD_OK);
        assert.equal(h.box.memory.readU32(out + DDDEVICEIDENTIFIER2.dwVendorId), 0x10de);
        assert.equal(h.box.memory.readU32(out + DDDEVICEIDENTIFIER2.dwWHQLLevel), 0xcccccccc);

        assert.equal(h.release(fourth), 0);
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();
    });

// --- SetSurfaceDesc, after Wine's ddraw7 test_set_surface_desc ---

const DDSD_PITCH = 0x00000008;
const DDSD_LPSURFACE = 0x00000800;
const DDSCAPS_SYSTEMMEMORY = 0x00000800;
const DDSCAPS_VIDEOMEMORY = 0x00004000;
const DDERR_INVALIDCAPS = 0x88760064;
const DDERR_INVALIDSURFACETYPE = 0x88760250;
const X8R8G8B8 = Object.freeze({ size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0 });

/**
 * SetSurfaceDesc through the seventh generation, with a descriptor holding
 * only what is given.
 *
 * @param {ReturnType<typeof seamed>} h @param {number} surface
 * @param {{ flags: number, width?: number, height?: number, pitch?: number, caps?: number,
 *   caps2?: number, pixelFormat?: any, lpSurface?: number }} fields
 * @param {number} [flags]  The call's own flags argument.
 */
function setDesc(h, surface, fields, flags = 0){
    const at = 0x5400;
    h.box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
    writeSurfaceDesc(h.box.services, at, DDSURFACEDESC2, {
        flags: fields.flags, width: fields.width ?? 0, height: fields.height ?? 0,
        pitch: fields.pitch ?? 0, backBufferCount: 0, mipMapCount: 0,
        caps: fields.caps ?? 0, caps2: fields.caps2 ?? 0,
        pixelFormat: fields.pixelFormat ?? X8R8G8B8, surfacePointer: fields.lpSurface,
    });
    return h.surface7(surface, 'SetSurfaceDesc', [at, flags]);
}

/** @param {ReturnType<typeof seamed>} h @param {number} surface @returns {any} */
function descOf(h, surface){
    const at = 0x5600;
    h.box.memory.writeU32(at, DDSURFACEDESC2.SIZE);
    assert.equal(h.surface7(surface, 'GetSurfaceDesc', [at]), DD_OK);
    /** @param {number} offset */
    const field = offset=>h.box.memory.readU32(at + offset);
    return {
        flags: field(DDSURFACEDESC2.dwFlags), width: field(DDSURFACEDESC2.dwWidth),
        height: field(DDSURFACEDESC2.dwHeight), pitch: field(DDSURFACEDESC2.lPitch),
        lpSurface: field(DDSURFACEDESC2.lpSurface), caps: field(DDSURFACEDESC2.dwCaps),
        caps2: field(DDSURFACEDESC2.dwCaps2),
        bitCount: field(DDSURFACEDESC2.ddpfPixelFormat + 0x0c),
    };
}

/** @param {ReturnType<typeof seamed>} h @param {number} surface @returns {number} lpSurface */
function lockedAt(h, surface){
    const at = 0x5800;
    h.box.memory.writeU32(at, DDSURFACEDESC2.SIZE);
    assert.equal(h.surface7(surface, 'Lock', [0, at, 0, 0]), DD_OK);
    const pointer = h.box.memory.readU32(at + DDSURFACEDESC2.lpSurface);
    assert.equal(h.surface7(surface, 'Unlock', [0]), DD_OK);
    return pointer;
}

test('SetSurfaceDesc puts a system-memory surface over the program\'s own memory', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const plain = DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN;
    const surface = h.createSurface7(ddraw, { caps: plain, width: 8, height: 8 });
    const data = 0x9000;

    assert.equal(setDesc(h, surface, { flags: DDSD_LPSURFACE, lpSurface: data }), DD_OK);
    assert.equal(setDesc(h, surface, { flags: DDSD_LPSURFACE, lpSurface: data }), DD_OK,
        'the same memory again is not an error');
    const described = descOf(h, surface);
    assert.equal(described.flags & DDSD_LPSURFACE, 0, 'GetSurfaceDesc does not report it');
    assert.equal(described.lpSurface, 0);
    assert.equal(lockedAt(h, surface), data, 'a lock hands out the program\'s memory');

    // A fill lands in the program's memory, not the memory the surface had.
    const fx = 0x5700;
    h.box.memory.writeU32(fx + DDBLTFX.dwSize, DDBLTFX.SIZE);
    h.box.memory.writeU32(fx + DDBLTFX.dwFillColor, 0x00123456);
    assert.equal(h.surface7(surface, 'Blt', [0, 0, 0, DDBLT_COLORFILL, fx]), DD_OK);
    assert.equal(h.box.memory.readU32(data + 7 * 32 + 7 * 4), 0x00123456);

    assert.equal(setDesc(h, surface, { flags: DDSD_LPSURFACE, lpSurface: data }, 1),
        DDERR_INVALIDPARAMS, 'the flags argument is reserved');
    assert.equal(setDesc(h, surface, { flags: DDSD_LPSURFACE, lpSurface: 0 }),
        DDERR_INVALIDPARAMS, 'a null lpSurface');
    assert.equal(h.surface7(surface, 'SetSurfaceDesc', [0, 0]), DDERR_INVALIDPARAMS);

    // Caps cannot be set: without lpSurface the call is malformed, with it
    // the caps are refused -- unless they are zero, and then caps2 is ignored.
    assert.equal(setDesc(h, surface, { flags: DDSD_CAPS, caps: plain }), DDERR_INVALIDPARAMS);
    assert.equal(setDesc(h, surface, { flags: DDSD_CAPS | DDSD_LPSURFACE, caps: plain,
        lpSurface: data }), DDERR_INVALIDCAPS);
    assert.equal(setDesc(h, surface, { flags: DDSD_CAPS | DDSD_LPSURFACE, caps: 0,
        caps2: 0xdeadbeef, lpSurface: data }), DD_OK);
    assert.deepEqual([descOf(h, surface).caps, descOf(h, surface).caps2], [plain, 0]);

    // The height goes with lpSurface only, and never to zero.
    assert.equal(setDesc(h, surface, { flags: DDSD_HEIGHT, height: 16 }), DDERR_INVALIDPARAMS);
    assert.equal(setDesc(h, surface, { flags: DDSD_HEIGHT | DDSD_LPSURFACE, height: 16,
        lpSurface: data }), DD_OK);
    assert.equal(setDesc(h, surface, { flags: DDSD_HEIGHT | DDSD_LPSURFACE, height: 0,
        lpSurface: data }), DDERR_INVALIDPARAMS);
    assert.deepEqual([descOf(h, surface).width, descOf(h, surface).height], [8, 16]);

    // The width and the pitch go together, and the pitch is dword-aligned
    // and positive but otherwise taken at the program's word.
    const both = DDSD_WIDTH | DDSD_PITCH | DDSD_LPSURFACE;
    assert.equal(setDesc(h, surface, { flags: DDSD_PITCH | DDSD_LPSURFACE, pitch: 64,
        lpSurface: data }), DDERR_INVALIDPARAMS);
    assert.equal(setDesc(h, surface, { flags: DDSD_WIDTH | DDSD_LPSURFACE, width: 16,
        lpSurface: data }), DDERR_INVALIDPARAMS);
    assert.equal(setDesc(h, surface, { flags: both, width: 16, pitch: 64, lpSurface: data }),
        DD_OK);
    assert.deepEqual([descOf(h, surface).width, descOf(h, surface).pitch], [16, 64]);
    for (const [width, pitch, hr] of [[16, 16, DD_OK], [16, 4, DD_OK],
        [16, 65, DDERR_INVALIDPARAMS], [16, 67, DDERR_INVALIDPARAMS],
        [16, -4, DDERR_INVALIDPARAMS], [16, 0, DDERR_INVALIDPARAMS],
        [0, 64, DDERR_INVALIDPARAMS], [16, 64, DD_OK]])
    {
        assert.equal(setDesc(h, surface, { flags: both, width, pitch, lpSurface: data }), hr,
            `width ${width}, pitch ${pitch}`);
    }

    assert.equal(setDesc(h, surface, { flags: DDSD_PIXELFORMAT }), DDERR_INVALIDPARAMS);
    assert.equal(setDesc(h, surface, { flags: DDSD_PIXELFORMAT | DDSD_LPSURFACE,
        lpSurface: data }), DD_OK);
    assert.equal(setDesc(h, surface, { flags: DDSD_CKSRCBLT | DDSD_LPSURFACE, lpSurface: data }),
        DDERR_INVALIDPARAMS, 'a colour key is not the descriptor\'s to set');

    // Everything else about the surface is kept: its colour key survives a
    // new size and format.
    h.fields.writeStruct(0x5a00, DDCOLORKEY, { low: 0x00ff00ff, high: 0x00ff00ff });
    assert.equal(h.surface7(surface, 'SetColorKey', [DDCKEY_SRCBLT, 0x5a00]), DD_OK);
    const rgb565 = { size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 16,
        redMask: 0xf800, greenMask: 0x07e0, blueMask: 0x001f, alphaMask: 0 };
    assert.equal(setDesc(h, surface, { flags: both | DDSD_HEIGHT | DDSD_PIXELFORMAT, width: 8,
        height: 8, pitch: 16, pixelFormat: rgb565, lpSurface: data }), DD_OK);
    assert.equal(h.surface7(surface, 'GetColorKey', [DDCKEY_SRCBLT, 0x5a10]), DD_OK);
    assert.equal(h.box.memory.readU32(0x5a10), 0x00ff00ff);
    assert.deepEqual(descOf(h, surface), { flags: descOf(h, surface).flags, width: 8, height: 8,
        pitch: 16, lpSurface: 0, caps: plain, caps2: 0, bitCount: 16 });
    assert.equal(h.publisher.objectAt(surface).bytesPerPixel, 2);

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('SetSurfaceDesc is for system memory the program may own: not video memory, not the primary',
    ()=>{
        const h = seamed();
        const ddraw = h.create7();
        const data = 0x9000;
        for (const caps of [DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN,
            DDSCAPS_OFFSCREENPLAIN])
        {
            const surface = h.createSurface7(ddraw, { caps, width: 8, height: 8 });
            assert.equal(setDesc(h, surface, { flags: DDSD_LPSURFACE, lpSurface: data }),
                DDERR_INVALIDSURFACETYPE);
            assert.equal(setDesc(h, surface, { flags: DDSD_WIDTH }), DDERR_INVALIDSURFACETYPE,
                'the surface is looked at before the descriptor');
            assert.equal(h.release(surface), 0);
        }
        const primary = h.createSurface7(ddraw,
            { caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_SYSTEMMEMORY });
        assert.equal(setDesc(h, primary, { flags: DDSD_LPSURFACE, lpSurface: data }),
            DDERR_INVALIDSURFACETYPE);
        assert.equal(h.release(primary), 0);

        // A mip chain in system memory: each level is its own memory, and
        // setting one leaves the others where they were.
        const top = h.createSurface7(ddraw, { caps: DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY
            | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP, width: 8, height: 8, mipMapCount: 3 });
        h.box.memory.writeU32(0x5b00, DDSCAPS_TEXTURE);
        h.box.bytes.fill(0, 0x5b04, 0x5b10);
        assert.equal(h.surface7(top, 'GetAttachedSurface', [0x5b00, 0x5b20]), DD_OK);
        const second = h.box.memory.readU32(0x5b20);
        const secondAt = lockedAt(h, second);
        assert.equal(setDesc(h, top, { flags: DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH
            | DDSD_LPSURFACE, width: 8, height: 8, pitch: 32, lpSurface: data }), DD_OK);
        assert.equal(lockedAt(h, second), secondAt);
        assert.equal(setDesc(h, second, { flags: DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH
            | DDSD_LPSURFACE, width: 4, height: 4, pitch: 16, lpSurface: data + 0x400 }), DD_OK);
        assert.equal(lockedAt(h, second), data + 0x400);
        assert.equal(lockedAt(h, top), data);

        assert.equal(h.release(second), 1);
        assert.equal(h.release(top), 0);
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();
    });

test('a surface answers IDirectDrawGammaControl, whose ramp starts as the identity and is kept',
    ()=>{
        // ddraw7.c test_surface_qi (2586) and ddraw1.c (2407): the gamma
        // control is S_OK on a surface; the colour control is not.
        const h = seamed();
        const ddraw = h.create7();
        const surface = h.createSurface7(ddraw, { caps: DDSCAPS_TEXTURE, width: 8, height: 8 });
        const riid = h.box.putGuid(0x4000, IID_IDirectDrawGammaControl);
        assert.equal(h.box.call(surface, 0, [riid, 0x4300]), DD_OK);
        const gamma = h.box.memory.readU32(0x4300);
        assert.notEqual(gamma, 0);
        assert.notEqual(gamma, surface, 'another table, so another pointer');
        h.box.putGuid(0x4000, '{4B9F0EE0-0D7E-11D0-9B06-00A0C903A3B8}');
        assert.equal(h.box.call(surface, 0, [0x4000, 0x4310]), 0x80004002,
            'IDirectDrawColorControl is not there');

        const get = slot(IDIRECTDRAWGAMMACONTROL_SLOTS, 'GetGammaRamp');
        const set = slot(IDIRECTDRAWGAMMACONTROL_SLOTS, 'SetGammaRamp');
        const ramp = 0x7000;
        /** @param {number} channel @param {number} index */
        const entry = (channel, index)=>h.box.bytes[ramp + channel * 512 + index * 2]
            | h.box.bytes[ramp + channel * 512 + index * 2 + 1] << 8;
        assert.equal(h.box.call(gamma, get, [0, ramp]), DD_OK);
        assert.deepEqual([entry(0, 0), entry(0, 255), entry(1, 128), entry(2, 1)],
            [0, 0xffff, 128 * 257, 257], 'every channel straight through');
        assert.equal(h.box.call(gamma, get, [0, 0]), DDERR_INVALIDPARAMS);
        assert.equal(h.box.call(gamma, set, [0, 0]), DDERR_INVALIDPARAMS);

        for (let index = 0; index < 768; index++)
        {
            h.box.bytes[0x7800 + index * 2] = index & 0xff;
            h.box.bytes[0x7800 + index * 2 + 1] = index >> 8;
        }
        assert.equal(h.box.call(gamma, set, [1, 0x7800]), DD_OK, 'DDSGR_CALIBRATE is taken');
        h.box.bytes.fill(0, ramp, ramp + 1536);
        assert.equal(h.box.call(gamma, get, [0, ramp]), DD_OK);
        assert.deepEqual([entry(0, 3), entry(1, 0), entry(2, 255)], [3, 256, 767]);

        // Back to the surface from its gamma control, as from any interface.
        h.box.putGuid(0x4000, IID_IDirectDrawSurface7);
        assert.equal(h.box.call(gamma, 0, [0x4000, 0x4320]), DD_OK);
        assert.equal(h.box.memory.readU32(0x4320), surface);
        h.release(surface);

        h.release(gamma);
        assert.equal(h.release(surface), 0);
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();
    });

test('no surface is an overlay: creating one is refused, and the overlay calls say so', ()=>{
    // ddraw7.c test_offscreen_overlay (13688-13691): UpdateOverlay on a
    // surface that is not an overlay is DDERR_NOTAOVERLAYSURFACE, shown or
    // hidden; a failed create_overlay is the test's own skip.
    const DDSCAPS_OVERLAY = 0x00000080;
    const DDERR_NOOVERLAYHW = 0x88760104;
    const DDERR_NOTAOVERLAYSURFACE = 0x88760244;
    const h = seamed();
    const ddraw = h.create7();
    const at = 0x5000;
    h.box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
    writeSurfaceDesc(h.box.services, at, DDSURFACEDESC2, {
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT, width: 64, height: 64,
        pitch: 0, backBufferCount: 0, mipMapCount: 0, caps: DDSCAPS_OVERLAY, caps2: 0,
        pixelFormat: { size: 0x20, flags: 4, fourCC: 0x59565955, bitCount: 0, redMask: 0,
            greenMask: 0, blueMask: 0, alphaMask: 0 },
    });
    h.box.memory.writeU32(0x5100, 0xdeadbeef);
    assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateSurface'), [at, 0x5100, 0]),
        DDERR_NOOVERLAYHW);

    const primary = h.createSurface7(ddraw, { caps: DDSCAPS_PRIMARYSURFACE });
    const offscreen = h.createSurface7(ddraw,
        { caps: DDSCAPS_OFFSCREENPLAIN, width: 64, height: 64 });
    const DDOVER_SHOW = 0x00004000;
    const DDOVER_HIDE = 0x00000200;
    for (const flags of [DDOVER_SHOW, DDOVER_HIDE])
    {
        assert.equal(h.surface7(offscreen, 'UpdateOverlay', [0, primary, 0, flags, 0]),
            DDERR_NOTAOVERLAYSURFACE);
    }
    assert.equal(h.surface7(offscreen, 'GetOverlayPosition', [0x5200, 0x5204]),
        DDERR_NOTAOVERLAYSURFACE);
    assert.equal(h.surface7(offscreen, 'SetOverlayPosition', [16, 16]),
        DDERR_NOTAOVERLAYSURFACE);
    assert.equal(h.surface7(offscreen, 'UpdateOverlayZOrder', [0, 0]),
        DDERR_NOTAOVERLAYSURFACE);
    assert.equal(h.surface7(offscreen, 'UpdateOverlayDisplay', [0]), DDERR_NOTAOVERLAYSURFACE);
    // The primary has no overlays over it to put in order, and says so by
    // naming none.
    assert.equal(h.surface7(primary, 'EnumOverlayZOrders', [0, 0, 0x1234]), DD_OK);

    assert.equal(h.release(offscreen), 0);
    assert.equal(h.release(primary), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('a managed texture keeps a priority; other textures refuse one and other surfaces more so',
    ()=>{
        // ddraw7.c test_resource_priority (11094-11175, 11201): managed
        // textures start at zero and read back what was set; an unmanaged
        // texture and a mip sublevel are DDERR_INVALIDPARAMS, a surface
        // that is no texture DDERR_INVALIDOBJECT, and a refusal leaves the
        // caller's variable alone.
        const DDSCAPS2_TEXTUREMANAGE = 0x10;
        const DDSCAPS2_D3DTEXTUREMANAGE = 0x20000;
        const DDERR_INVALIDOBJECT = 0x88760082;
        const h = seamed();
        const ddraw = h.create7();
        const out = 0x5c00;
        const cases = /** @type {[number, number, number][]} */ ([
            [DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY, 0, DDERR_INVALIDPARAMS],
            [DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, 0, DDERR_INVALIDPARAMS],
            [DDSCAPS_TEXTURE, DDSCAPS2_TEXTUREMANAGE, DD_OK],
            [DDSCAPS_TEXTURE, DDSCAPS2_D3DTEXTUREMANAGE, DD_OK],
            [DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY, 0, DDERR_INVALIDOBJECT],
            [DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, 0, DDERR_INVALIDOBJECT],
        ]);
        for (const [caps, caps2, hr] of cases)
        {
            const surface = h.createSurface7(ddraw, { caps, caps2, width: 32, height: 32 });
            h.box.memory.writeU32(out, 0xdeadbeef);
            assert.equal(h.surface7(surface, 'GetPriority', [out]), hr);
            assert.equal(h.box.memory.readU32(out), hr === DD_OK ? 0 : 0xdeadbeef);
            assert.equal(h.surface7(surface, 'SetPriority', [1]), hr);
            h.box.memory.writeU32(out, 0xdeadbeef);
            assert.equal(h.surface7(surface, 'GetPriority', [out]), hr);
            assert.equal(h.box.memory.readU32(out), hr === DD_OK ? 1 : 0xdeadbeef);
            assert.equal(h.release(surface), 0);
        }

        const top = h.createSurface7(ddraw, { caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX
            | DDSCAPS_MIPMAP, caps2: DDSCAPS2_TEXTUREMANAGE, width: 32, height: 32,
        mipMapCount: 2 });
        h.box.memory.writeU32(0x5b00, DDSCAPS_COMPLEX);
        h.box.bytes.fill(0, 0x5b04, 0x5b10);
        assert.equal(h.surface7(top, 'GetAttachedSurface', [0x5b00, 0x5b20]), DD_OK);
        const sublevel = h.box.memory.readU32(0x5b20);
        h.box.memory.writeU32(out, 0xdeadbeef);
        assert.equal(h.surface7(sublevel, 'GetPriority', [out]), DDERR_INVALIDPARAMS);
        assert.equal(h.box.memory.readU32(out), 0xdeadbeef);
        assert.equal(h.surface7(top, 'GetPriority', [out]), DD_OK);
        assert.equal(h.box.memory.readU32(out), 0);
        assert.equal(h.surface7(top, 'GetPriority', [0]), DDERR_INVALIDPARAMS);

        assert.equal(h.release(sublevel), 1);
        assert.equal(h.release(top), 0);
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();
    });

test('a surface whose pixels are kept elsewhere is brought up to date before a lock, a DC or a'
    + ' blit reads it, and the caller waits', async()=>{
    // ddraw7.c get_surface_color (453-470) locks a render target read-only
    // after drawing and reads the drawn colour: the pointer a lock hands out
    // has to hold the pixels, wherever they were made.
    const h = seamed();
    const ddraw = h.create7();
    const kept = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2 });
    const other = h.createSurface7(ddraw, { caps: DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2 });
    const keptModel = h.publisher.objectAt(kept);
    const otherModel = h.publisher.objectAt(other);
    /** @type {string[]} */
    const heard = [];
    h.roots[0].watchPixels({
        readBack: (/** @type {any} */ surface)=>{
            if (surface !== keptModel)
            {
                return null;
            }
            heard.push('read');
            // What the copy elsewhere holds: every pixel 0x00abcdef.
            return Promise.resolve().then(()=>{
                for (let at = 0; at < 16; at += 4)
                {
                    h.box.memory.writeU32(keptModel.buffer + at, 0x00abcdef);
                }
            });
        },
        written: (/** @type {any} */ surface)=>{
            heard.push(surface === keptModel ? 'written' : 'other written');
        },
    });
    const lockSlot = slot(IDIRECTDRAWSURFACE7_SLOTS, 'Lock');
    const desc = 0x5200;

    // A read-only lock: parked, then the pointer is to the pixels as kept.
    h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
    const parked = h.box.callParked(kept, lockSlot, [0, desc, 0x10, 0]);
    assert.equal(h.box.memory.readU32(keptModel.buffer), 0, 'not yet current');
    assert.equal(await parked, DD_OK);
    const bits = h.box.memory.readU32(desc + DDSURFACEDESC2.lpSurface);
    assert.equal(bits, keptModel.buffer);
    assert.equal(h.box.memory.readU32(bits + 12), 0x00abcdef);
    assert.equal(h.surface7(kept, 'Unlock', [0]), DD_OK);
    assert.deepEqual(heard, ['read'], 'a read-only lock writes nothing back');

    // A lock of a surface nobody keeps a copy of is answered at once.
    h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
    assert.equal(h.box.call(other, lockSlot, [0, desc, 0, 0]), DD_OK);
    assert.equal(h.surface7(other, 'Unlock', [0]), DD_OK);
    assert.deepEqual(heard, ['read', 'other written']);

    // A blit out of it reads the kept pixels; a blit into it is a write.
    heard.length = 0;
    h.box.memory.writeU32(keptModel.buffer, 0);
    const bltSlot = slot(IDIRECTDRAWSURFACE7_SLOTS, 'Blt');
    assert.equal(await h.box.callParked(other, bltSlot, [0, kept, 0, 0, 0]), DD_OK);
    assert.equal(h.box.memory.readU32(otherModel.buffer), 0x00abcdef);
    assert.deepEqual(heard, ['read', 'other written']);
    heard.length = 0;
    const fastSlot = slot(IDIRECTDRAWSURFACE7_SLOTS, 'BltFast');
    assert.equal(await h.box.callParked(kept, fastSlot, [0, 0, other, 0, 0]), DD_OK);
    assert.deepEqual(heard, ['read', 'written'],
        'the rest of the destination is current before part of it is overwritten');

    // A device context is over the kept pixels too, and releasing it writes.
    heard.length = 0;
    assert.equal(await h.box.callParked(kept, slot(IDIRECTDRAWSURFACE7_SLOTS, 'GetDC'),
        [0x5300]), DD_OK);
    assert.notEqual(h.box.memory.readU32(0x5300), 0);
    assert.equal(h.surface7(kept, 'ReleaseDC', [h.box.memory.readU32(0x5300)]), DD_OK);
    assert.deepEqual(heard, ['read', 'written']);

    assert.equal(h.release(other), 0);
    assert.equal(h.release(kept), 0);
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('a primary\'s gamma ramp is the display\'s, and the caps say so only where one is applied',
    ()=>{
        /** @type {any[][]} */
        const set = [];
        const gamma = {
            /** @param {any} owner @param {any} ramp */
            set: (owner, ramp)=>set.push([owner, ramp]),
            applies: ()=>true,
        };
        const h = seamed({ gamma });
        const ddraw = h.create7();
        const caps = 0x6100;
        h.box.memory.writeU32(caps + DDCAPS.dwSize, DDCAPS.SIZE);
        h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'GetCaps'), [caps, 0]);
        assert.equal(h.box.memory.readU32(caps + DDCAPS.dwCaps2) & DDCAPS2_PRIMARYGAMMA,
            DDCAPS2_PRIMARYGAMMA);

        const riid = h.box.putGuid(0x4000, IID_IDirectDrawGammaControl);
        const controlOf = (/** @type {number} */ surface)=>{
            assert.equal(h.box.call(surface, 0, [riid, 0x4300]), DD_OK);
            return h.box.memory.readU32(0x4300);
        };
        const setRamp = slot(IDIRECTDRAWGAMMACONTROL_SLOTS, 'SetGammaRamp');
        const ramp = 0x7800;
        for (let index = 0; index < 768; index++)
        {
            const value = (255 - (index & 0xff)) * 257;
            h.box.bytes[ramp + index * 2] = value & 0xff;
            h.box.bytes[ramp + index * 2 + 1] = value >> 8;
        }

        const texture = h.createSurface7(ddraw, { caps: DDSCAPS_TEXTURE, width: 8, height: 8 });
        const textureGamma = controlOf(texture);
        assert.equal(h.box.call(textureGamma, setRamp, [0, ramp]), DD_OK);
        assert.equal(set.length, 0, 'a surface that is not the primary keeps its ramp to itself');

        const primary = h.createSurface7(ddraw, { caps: DDSCAPS_PRIMARYSURFACE });
        const primaryGamma = controlOf(primary);
        assert.equal(h.box.call(primaryGamma, setRamp, [0, ramp]), DD_OK);
        assert.equal(set.length, 1);
        const [owner, shown] = set[0];
        assert.equal(owner, h.publisher.objectAt(primary));
        assert.deepEqual([shown.red.length, shown.green.length, shown.blue.length],
            [256, 256, 256]);
        assert.deepEqual([shown.red[0], shown.green[255], shown.blue[128]],
            [0xffff, 0, 127 * 257]);

        h.release(primaryGamma);
        h.release(textureGamma);
        assert.equal(h.release(primary), 0);
        assert.deepEqual(set[1], [owner, null], 'the primary\'s end takes its ramp back');
        assert.equal(h.release(texture), 0);
        assert.equal(set.length, 2);
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();

        const headless = seamed({ gamma: { set: ()=>{}, applies: ()=>false } });
        const other = headless.create7();
        headless.box.memory.writeU32(caps + DDCAPS.dwSize, DDCAPS.SIZE);
        headless.box.call(other, slot(IDIRECTDRAW7_SLOTS, 'GetCaps'), [caps, 0]);
        assert.equal(headless.box.memory.readU32(caps + DDCAPS.dwCaps2) & DDCAPS2_PRIMARYGAMMA, 0,
            'no canvas, no gamma claimed');
        headless.release(other);
    });

// --- TestCooperativeLevel, after Wine's ddraw7 test_lost_device ---

test('exclusive mode is lost while the application is deactivated, and normal mode is not',
    ()=>{
        // test_lost_device: DD_OK in exclusive mode, DDERR_NOEXCLUSIVEMODE once
        // another window is in the foreground, DD_OK again once the program's
        // is; in normal mode DD_OK throughout, the foreground wherever it is.
        let deactivated = false;
        const h = seamed({ deactivated: ()=>deactivated });
        const test7 = slot(IDIRECTDRAW7_SLOTS, 'TestCooperativeLevel');
        const ddraw = h.create7(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
        assert.equal(h.box.call(ddraw, test7, []), DD_OK);
        deactivated = true;
        assert.equal(h.box.call(ddraw, test7, []), DDERR_NOEXCLUSIVEMODE);
        const riid = h.box.putGuid(0x4000, IID_IDirectDraw4);
        assert.equal(h.box.call(ddraw, 0, [riid, 0x4300]), DD_OK);
        const fourth = h.box.memory.readU32(0x4300);
        assert.equal(h.box.call(fourth, test7, []), DDERR_NOEXCLUSIVEMODE,
            'IDirectDraw4 answers the same, from the same slot');
        deactivated = false;
        assert.equal(h.box.call(ddraw, test7, []), DD_OK, 'back in the foreground');

        assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'SetCooperativeLevel'),
            [HWND, DDSCL_NORMAL]), DD_OK);
        deactivated = true;
        assert.equal(h.box.call(ddraw, test7, []), DD_OK, 'normal mode holds nothing to lose');
        deactivated = false;

        // Another object holding the screen is what a normal-mode object is
        // told about (the method's documented DDERR_EXCLUSIVEMODEALREADYSET).
        const other = h.create7(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
        assert.equal(h.box.call(ddraw, test7, []), DDERR_EXCLUSIVEMODEALREADYSET);
        assert.equal(h.box.call(other, test7, []), DD_OK);
        assert.equal(h.release(other), 0);
        assert.equal(h.box.call(ddraw, test7, []), DD_OK, 'and not once it is gone');

        assert.equal(h.release(fourth), 0);
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();

        const alone = seamed();
        const unknowing = alone.create7(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
        assert.equal(alone.box.call(unknowing, test7, []), DD_OK,
            'with nothing to ask about activation the application is taken to be active');
        alone.release(unknowing);
    });

// --- video memory lost with the application, after Wine's ddraw7 test_lost_device ---

test('an exclusive owner loses its video memory when deactivated, and restores it once back',
    ()=>{
        // test_lost_device (10722-10794): deactivated, the flip chain and a
        // video-memory surface are lost, flip and lock answer
        // DDERR_SURFACELOST, Restore answers DDERR_WRONGMODE, and a
        // system-memory surface is untouched; active again, they stay lost
        // until restored.
        let deactivated = false;
        let deactivations = 0;
        const h = seamed({ deactivated: ()=>deactivated, deactivations: ()=>deactivations });
        const ddraw = h.create7(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
        const primary = h.createSurface7(ddraw,
            { caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP, backBufferCount: 1 });
        const sysmem = h.createSurface7(ddraw,
            { caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, width: 16, height: 16 });
        const vidmem = h.createSurface7(ddraw,
            { caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY, width: 16, height: 16 });
        const test7 = ()=>h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'TestCooperativeLevel'), []);
        /** @param {number} surface */
        const isLost = surface=>h.surface7(surface, 'IsLost', []);
        const caps = 0x5500;
        h.box.memory.writeU32(caps, DDSCAPS_BACKBUFFER);
        const back = ()=>{
            const hr = h.surface7(primary, 'GetAttachedSurface', [caps, 0x5600]);
            if (hr === DD_OK)
            {
                h.release(h.box.memory.readU32(0x5600));
            }
            return hr;
        };
        assert.equal(back(), DD_OK);
        const backBuffer = h.box.memory.readU32(0x5600);

        assert.equal(test7(), DD_OK);
        assert.deepEqual([primary, sysmem, vidmem].map(isLost), [DD_OK, DD_OK, DD_OK]);
        assert.equal(h.surface7(primary, 'Flip', [0, 0]), DD_OK);

        deactivated = true;
        deactivations = 1;
        assert.equal(test7(), DDERR_NOEXCLUSIVEMODE);
        assert.deepEqual([primary, sysmem, vidmem].map(isLost),
            [DDERR_SURFACELOST, DD_OK, DDERR_SURFACELOST]);
        assert.equal(h.surface7(primary, 'Flip', [0, 0]), DDERR_SURFACELOST);
        assert.equal(h.surface7(primary, 'Restore', []), DDERR_WRONGMODE);
        assert.equal(h.surface7(vidmem, 'Restore', []), DDERR_WRONGMODE);
        assert.equal(h.surface7(sysmem, 'Restore', []), DD_OK);
        assert.deepEqual([primary, sysmem, vidmem].map(isLost),
            [DDERR_SURFACELOST, DD_OK, DDERR_SURFACELOST], 'nothing came back');
        assert.equal(back(), DDERR_SURFACELOST, 'GetAttachedSurface on a lost surface');
        const desc = 0x5200;
        h.box.memory.writeU32(desc, DDSURFACEDESC2.SIZE);
        h.box.memory.writeU32(desc + DDSURFACEDESC2.lpSurface, 0xdeadbeef);
        assert.equal(h.surface7(vidmem, 'Lock', [0, desc, 0, 0]), DDERR_SURFACELOST);
        assert.equal(h.box.memory.readU32(desc + DDSURFACEDESC2.lpSurface), 0xdeadbeef,
            'and the pointer untouched');
        assert.equal(h.surface7(vidmem, 'Blt', [0, sysmem, 0, 0, 0]), DDERR_SURFACELOST,
            'a blit into one');
        assert.equal(h.surface7(sysmem, 'Blt', [0, vidmem, 0, 0, 0]), DDERR_SURFACELOST,
            'and out of one');

        deactivated = false;
        assert.equal(test7(), DD_OK);
        assert.deepEqual([primary, sysmem, vidmem].map(isLost),
            [DDERR_SURFACELOST, DD_OK, DDERR_SURFACELOST], 'lost until restored');
        assert.equal(h.surface7(primary, 'Flip', [0, 0]), DDERR_SURFACELOST);
        assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'RestoreAllSurfaces'), []),
            DD_OK);
        assert.deepEqual([primary, sysmem, vidmem].map(isLost), [DD_OK, DD_OK, DD_OK]);
        assert.equal(h.surface7(primary, 'Flip', [0, 0]), DD_OK);

        // Away and back between two calls, as a program that stops drawing in
        // the background sees it: the loss is still there when it returns.
        deactivations = 2;
        assert.deepEqual([primary, backBuffer, vidmem].map(isLost),
            [DDERR_SURFACELOST, DDERR_SURFACELOST, DDERR_SURFACELOST]);
        assert.equal(h.surface7(primary, 'Restore', []), DD_OK);
        assert.deepEqual([primary, backBuffer, vidmem].map(isLost),
            [DD_OK, DD_OK, DDERR_SURFACELOST], 'the chain comes back with its front, alone');
        assert.equal(h.surface7(vidmem, 'Restore', []), DD_OK);

        // Normal mode holds no video memory to lose; taking exclusive mode
        // again loses it all, system memory aside (10866-10878).
        assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'SetCooperativeLevel'),
            [HWND, DDSCL_NORMAL]), DD_OK);
        deactivated = true;
        deactivations = 3;
        assert.deepEqual([primary, sysmem, vidmem].map(isLost), [DD_OK, DD_OK, DD_OK]);
        deactivated = false;
        assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'SetCooperativeLevel'),
            [HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN]), DD_OK);
        assert.deepEqual([primary, sysmem, vidmem].map(isLost),
            [DDERR_SURFACELOST, DD_OK, DDERR_SURFACELOST]);

        for (const surface of [vidmem, sysmem, primary])
        {
            assert.equal(h.release(surface), 0);
        }
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();
    });

test('a mode change loses video memory, and a primary made in another mode cannot be restored',
    ()=>{
        // Wine's ddraw7 test_coop_level_mode_set (3400-3405, 3664-3674,
        // 3723-3728): setting or restoring the display mode loses the
        // primary, in normal mode as in exclusive, and the primary answers
        // Restore with DDERR_WRONGMODE while the mode is not the one it was
        // made in; test_primary_palette (8738-8756): a depth is part of the mode.
        const h = seamed();
        const ddraw = h.create7();
        const setMode = (/** @type {number} */ width, /** @type {number} */ height,
            /** @type {number} */ depth)=>
            h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'SetDisplayMode'),
                [width, height, depth, 0, 0]);
        /** @param {number} surface */
        const isLost = surface=>h.surface7(surface, 'IsLost', []);
        const primary = h.createSurface7(ddraw, { caps: DDSCAPS_PRIMARYSURFACE });
        const vidmem = h.createSurface7(ddraw,
            { caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY, width: 8, height: 8 });
        const sysmem = h.createSurface7(ddraw,
            { caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, width: 8, height: 8 });

        assert.equal(setMode(640, 480, 32), DD_OK);
        assert.deepEqual([primary, vidmem, sysmem].map(isLost),
            [DDERR_SURFACELOST, DDERR_SURFACELOST, DD_OK]);
        assert.equal(h.surface7(primary, 'Restore', []), DDERR_WRONGMODE);
        assert.equal(isLost(primary), DDERR_SURFACELOST);
        assert.equal(h.surface7(vidmem, 'Restore', []), DD_OK,
            'a surface of its own size and format is not the mode\'s');
        assert.equal(setMode(640, 480, 32), DD_OK);
        assert.equal(isLost(vidmem), DD_OK, 'setting the mode in effect changes nothing');

        assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'RestoreDisplayMode'), []), DD_OK);
        assert.equal(isLost(vidmem), DDERR_SURFACELOST, 'restoring the mode is a change too');
        assert.equal(h.surface7(primary, 'Restore', []), DD_OK, 'back in the primary\'s own mode');
        assert.equal(isLost(primary), DD_OK);
        assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'RestoreAllSurfaces'), []), DD_OK);
        assert.equal(h.release(primary), 0);

        assert.equal(setMode(640, 480, 8), DD_OK);
        const indexed = h.createSurface7(ddraw, { caps: DDSCAPS_PRIMARYSURFACE });
        assert.equal(setMode(640, 480, 32), DD_OK);
        assert.equal(isLost(indexed), DDERR_SURFACELOST);
        assert.equal(h.surface7(indexed, 'Restore', []), DDERR_WRONGMODE,
            'the same size at another depth is another mode');
        assert.equal(setMode(320, 240, 32), DD_OK);
        assert.equal(h.box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'RestoreAllSurfaces'), []),
            DDERR_WRONGMODE, 'what cannot come back is said');
        assert.deepEqual([vidmem, indexed].map(isLost), [DD_OK, DDERR_SURFACELOST],
            'and what can came back');

        for (const surface of [indexed, sysmem, vidmem])
        {
            assert.equal(h.release(surface), 0);
        }
        assert.equal(h.release(ddraw), 0);
        h.assertAllReleased();
    });

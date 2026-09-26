/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D of DirectX 3, 5 and 6, driven the way a guest drives it:
 * through interface pointers the bridge's own vtable publisher laid out, by
 * slot number, over a flat buffer standing in for guest memory, with
 * DDRAW.dll as the way in.
 *
 * What is checked is translation: which interfaces an object answers and
 * with which count, how large a structure is read and written, what is
 * refused before anything happens. The model behind it has its own tests in
 * `d3d7/legacy.test.js`. The expectations are Wine's ddraw4.c conformance
 * tests, each named where it is used, and every test ends with the DirectDraw
 * object at zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import { createGraphicsLibraries } from './exports.js';
import { IDIRECTDRAW4_SLOTS, IDIRECTDRAWSURFACE4_SLOTS } from './vtables.js';
import {
    IDIRECT3D3_SLOTS, IDIRECT3DDEVICE3_SLOTS, IDIRECT3DLIGHT_SLOTS, IDIRECT3DMATERIAL3_SLOTS,
    IDIRECT3DTEXTURE2_SLOTS, IDIRECT3DVERTEXBUFFER_SLOTS, IDIRECT3DVIEWPORT3_SLOTS,
} from './vtables-ddraw.js';
import {
    IID_IDirect3D, IID_IDirect3D3, IID_IDirect3D7, IID_IDirect3DDevice7,
    IID_IDirect3DMaterial, IID_IDirect3DMaterial2, IID_IDirect3DTexture, IID_IDirect3DTexture2,
    IID_IDirect3DVertexBuffer, IID_IDirect3DVertexBuffer7, IID_IDirect3DViewport,
    IID_IDirect3DViewport2, IID_IDirect3DViewport3, IID_IDirectDraw4,
    IID_IDirectDrawGammaControl,
} from './iids.js';
import {
    D3DDEVICEDESC, D3DFINDDEVICERESULT, D3DFINDDEVICESEARCH, D3DLIGHT, D3DMATERIAL, D3DSTATS,
    D3DVIEWPORT, D3DVIEWPORT2,
} from './structs-legacy.js';
import { D3DPRIMCAPS, D3DVERTEXBUFFERDESC } from './structs.js';
import { guidBytes } from './d3d7.js';
import { createDirectDraw } from '../ddraw/objects.js';
import { DDSURFACEDESC2, writeSurfaceDesc } from '../ddraw/structs.js';
import {
    DDCKEY_SRCBLT, DDERR_NOCOLORKEY, DDPF_RGB, DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN,
    DDSCAPS_TEXTURE, DDSCL_NORMAL, DDSD_CAPS, DDSD_HEIGHT, DDSD_PIXELFORMAT, DDSD_WIDTH, DD_OK,
} from '../ddraw/constants.js';
import {
    D3DDEVCAPS_DRAWPRIMITIVES2EX, D3DDEVCAPS_HWRASTERIZATION, D3DERR_NOCURRENTVIEWPORT,
    D3DERR_VIEWPORTDATANOTSET, D3DERR_VIEWPORTHASNODEVICE, D3DFDS_GUID, D3DLIGHTSTATE,
    D3DLIGHT_ACTIVE, D3DPTEXTURECAPS_POW2, D3D_OK, DDERR_INVALIDPARAMS, DDERR_NOTFOUND,
    DEVICE_IDS,
} from '../d3d7/constants.js';
import { D3DPT } from '../d3d8/constants.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

const HWND = 0x00010044;
const SCREEN = { width: 16, height: 16, bitsPerPixel: 32 };
const E_NOINTERFACE = 0x80004002;
const CLASS_E_NOAGGREGATION = 0x80040110;
const RS_SPECULARENABLE = 29;

const XRGB32 = Object.freeze({
    size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0,
});

/** @param {[string, number][]} slots @param {string} name */
const slot = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

/** A flat address space with the bridge's vtable publisher over it. */
function machine(){
    const bytes = new Uint8Array(1 << 20);
    const view = new DataView(bytes.buffer);
    let next = 0x100;
    const memory = {
        /** @param {number} at @param {number} length */
        readBytes: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} value */
        writeBytes: (at, value)=>bytes.set(value, at),
        /** @param {number} at */
        readU32: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        writeU32: (at, value)=>view.setUint32(at, value >>> 0, true),
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
    let storageNext = 0x80000;

    return {
        bytes,
        view,
        memory,
        services: {
            /** @param {number} at @param {number} length */
            readMemory: (at, length)=>bytes.slice(at, at + length),
            /** @param {number} at @param {Uint8Array} value */
            writeMemory: (at, value)=>bytes.set(value, at),
        },
        /** @param {number} size */
        allocateStorage: size=>{
            const at = storageNext;
            storageNext += size + 0xfff & ~0xfff;
            return at;
        },
        /** @param {any} object @param {string} id */
        publishInterface: (object, id)=>vtables.publish(object, id),
        /**
         * A slot's answer as the bridge has it: a dword, or the promise a
         * call into guest code parks the caller on.
         *
         * @param {number} pointer @param {number} index @param {number[]} args
         */
        callRaw(pointer, index, args = []){
            const table = memory.readU32(pointer);
            const entry = registered.get(memory.readU32(table + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.fn.handler([pointer, ...args]);
        },
        /** @param {number} pointer @param {number} index @param {number[]} args */
        call(pointer, index, args = []){
            return this.callRaw(pointer, index, args) >>> 0;
        },
        /** @param {number} at */
        stringAt(at){
            let end = at;
            while (bytes[end] !== 0)
            {
                end++;
            }
            return String.fromCharCode(...bytes.slice(at, end));
        },
        /** @param {number} at @param {string} guid */
        putGuid(at, guid){
            bytes.set(guidBytes(guid), at);
            return at;
        },
        /** @param {number} at @param {number[]} values */
        putFloats(at, values){
            values.forEach((value, k)=>view.setFloat32(at + k * 4, value, true));
        },
        /** @param {number} at @param {number} count @returns {number[]} */
        floatsAt: (at, count)=>Array.from({ length: count }, (_, k)=>
            view.getFloat32(at + k * 4, true)),
    };
}

/**
 * The whole assembly, as a program reaches it, with an IDirectDraw4 made the
 * way DirectX 6 programs make one: DirectDrawCreate, then a query.
 *
 * @param {(box: any, args: number[]) => any} [observe]  What a callback saw.
 */
function seamed(observe = ()=>null){
    const box = machine();
    /** @type {any[]} */
    const roots = [];
    /** @type {{ entry: number, args: number[], seen: any }[]} */
    const callbacks = [];
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const libraries = createGraphicsLibraries({
        graphics: {
            /** @param {string} name @param {any} options */
            create: (name, options)=>{
                if (name !== 'ddraw')
                {
                    return null;
                }
                const root = createDirectDraw({ ...options, allocate: box.allocateStorage });
                roots.push(root);
                return root;
            },
            available: ()=>false,
        },
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>SCREEN,
        publisher,
        present: ()=>{},
        /** @param {{ entry: number, args: number[] }} call */
        callGuest: async({ entry, args })=>{
            callbacks.push({ entry, args: [...args], seen: observe(box, args) });
            return 1;
        },
        scratch: { allocate: box.allocateStorage },
    });
    const ddrawDll = libraries.libraries['DDRAW.dll'];

    /** @param {number} pointer @param {string} iid @returns {{ hr: number, pointer: number }} */
    const query = (pointer, iid)=>{
        const riid = box.putGuid(0x4000, iid);
        box.memory.writeU32(0x4010, 0xdeadbeef);
        const hr = box.call(pointer, 0, [riid, 0x4010]);
        return { hr, pointer: box.memory.readU32(0x4010) };
    };

    const h = {
        box,
        roots,
        publisher,
        callbacks,
        query,
        /** @param {number} pointer */
        release: pointer=>box.call(pointer, 2, []),
        /** @param {number} pointer */
        addRef: pointer=>box.call(pointer, 1, []),
        /** @param {number} pointer the count after an AddRef and a Release */
        countOf: pointer=>{
            box.call(pointer, 1, []);
            return box.call(pointer, 2, []);
        },

        /** An IDirectDraw4 under a cooperative level, holding the object's only reference. */
        create4(){
            assert.equal(ddrawDll.DirectDrawCreate.handler([0, 0x4100, 0]), DD_OK);
            const first = box.memory.readU32(0x4100);
            const fourth = query(first, IID_IDirectDraw4);
            assert.equal(fourth.hr, DD_OK);
            assert.equal(h.release(first), 0);
            assert.equal(box.call(fourth.pointer, slot(IDIRECTDRAW4_SLOTS, 'SetCooperativeLevel'),
                [HWND, DDSCL_NORMAL]), DD_OK);
            return fourth.pointer;
        },
        /** @param {number} ddraw */
        direct3D(ddraw){
            const made = query(ddraw, IID_IDirect3D3);
            assert.equal(made.hr, DD_OK, 'QueryInterface for IDirect3D3');
            return made.pointer;
        },
        /** @param {number} ddraw @param {number} caps @param {any} [format] */
        surface(ddraw, caps = DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, format = XRGB32){
            const at = 0x5000;
            box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
            writeSurfaceDesc(box.services, at, DDSURFACEDESC2, {
                flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
                width: 8, height: 8, pitch: 0, backBufferCount: 0, mipMapCount: 0,
                caps, caps2: 0, pixelFormat: format,
            });
            assert.equal(box.call(ddraw, slot(IDIRECTDRAW4_SLOTS, 'CreateSurface'),
                [at, 0x5100, 0]), DD_OK, 'the fixture surface is created');
            return box.memory.readU32(0x5100);
        },
        /** @param {number} d3d @param {string} name @param {number[]} args */
        d3d: (d3d, name, args = [])=>box.call(d3d, slot(IDIRECT3D3_SLOTS, name), args),
        /** @param {number} device @param {string} name @param {number[]} args */
        device: (device, name, args = [])=>
            box.call(device, slot(IDIRECT3DDEVICE3_SLOTS, name), args),
        /** @param {number} viewport @param {string} name @param {number[]} args */
        viewport: (viewport, name, args = [])=>
            box.call(viewport, slot(IDIRECT3DVIEWPORT3_SLOTS, name), args),
        /** @param {number} d3d @param {string} method @returns {number} what it made */
        make(d3d, method){
            box.memory.writeU32(0x4400, 0);
            assert.equal(h.d3d(d3d, method, [0x4400, 0]), D3D_OK);
            return box.memory.readU32(0x4400);
        },
        /**
         * A HAL device on a new target, the way Wine's ddraw4.c create_device
         * makes one: the IDirect3D3 it came through is released afterwards.
         *
         * @param {number} ddraw
         */
        createDevice(ddraw){
            const d3d = h.direct3D(ddraw);
            const target = h.surface(ddraw);
            const riid = box.putGuid(0x4300, DEVICE_IDS.HAL);
            assert.equal(h.d3d(d3d, 'CreateDevice', [riid, target, 0x4400, 0]), D3D_OK);
            h.release(d3d);
            return { device: box.memory.readU32(0x4400), target };
        },
        /**
         * @param {number} d3d @param {number} device
         * @returns {number} a viewport added to the device over the whole target
         */
        addViewport(d3d, device){
            const viewport = h.make(d3d, 'CreateViewport');
            assert.equal(h.device(device, 'AddViewport', [viewport]), D3D_OK);
            const at = 0x6000;
            box.bytes.fill(0, at, at + D3DVIEWPORT2.SIZE);
            box.memory.writeU32(at, D3DVIEWPORT2.SIZE);
            box.memory.writeU32(at + D3DVIEWPORT2.dwWidth, 8);
            box.memory.writeU32(at + D3DVIEWPORT2.dwHeight, 8);
            box.putFloats(at + D3DVIEWPORT2.dvClipX, [-1, 1, 2, 2, 0, 1]);
            assert.equal(h.viewport(viewport, 'SetViewport2', [at]), D3D_OK);
            return viewport;
        },
        /** Every root the seam made is dead. */
        assertAllReleased(){
            for (const root of roots)
            {
                assert.ok(root.destroyed, 'the DirectDraw object reached zero');
            }
        },
    };
    return h;
}

// --- the object ---

test('IDirect3D3 is a query away from IDirectDraw4, and keeps the object alive with its count',
    ()=>{
        const h = seamed();
        const ddraw = h.create4();
        const model = h.roots[0];
        const d3d = h.direct3D(ddraw);
        assert.notEqual(d3d, ddraw);
        assert.equal(model.refCount('IDirectDraw4'), 2,
            'the older Direct3D interfaces count with the generation that asked for them');

        // Wine's ddraw4.c create_device releases IDirectDraw4 as soon as it
        // has IDirect3D3, and goes back for it later through the Direct3D one.
        assert.equal(h.release(ddraw), 1);
        assert.equal(model.destroyed, false);
        const again = h.query(d3d, IID_IDirectDraw4);
        assert.equal(again.hr, DD_OK);
        assert.equal(again.pointer, ddraw, 'one object, one pointer per interface');
        assert.equal(h.release(again.pointer), 1);

        const seventh = h.query(d3d, IID_IDirect3D7);
        assert.equal(seventh.hr, DD_OK);
        assert.equal(model.refCount('IDirectDraw4'), 1, 'IDirect3D7 counts elsewhere');
        h.release(seventh.pointer);
        assert.equal(h.release(d3d), 0);
        h.assertAllReleased();
    });

test('CreateDevice makes a third-generation device that answers only its own interfaces', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const d3d = h.direct3D(ddraw);
    const target = h.surface(ddraw);
    const riid = h.box.putGuid(0x4300, DEVICE_IDS.HAL);

    assert.equal(h.d3d(d3d, 'CreateDevice', [riid, target, 0x4400, 0x1234]),
        CLASS_E_NOAGGREGATION);
    h.box.putGuid(0x4300, DEVICE_IDS.TNLHAL);
    assert.equal(h.d3d(d3d, 'CreateDevice', [riid, target, 0x4400, 0]), DDERR_NOTFOUND >>> 0,
        'the T&L device is Direct3D 7\'s');
    assert.equal(h.box.memory.readU32(0x4400), 0);
    h.box.putGuid(0x4300, DEVICE_IDS.HAL);
    assert.equal(h.d3d(d3d, 'CreateDevice', [riid, target, 0x4400, 0]), D3D_OK);
    const device = h.box.memory.readU32(0x4400);
    assert.equal(h.countOf(device), 1);

    // Wine's ddraw4.c test_device_qi, as far as the third generation goes.
    const unknown = h.query(device, '{00000000-0000-0000-C000-000000000046}');
    assert.equal(unknown.hr, DD_OK);
    assert.equal(h.countOf(device), 2, 'IUnknown is the device, with the device\'s count');
    h.release(unknown.pointer);
    for (const iid of [IID_IDirect3DDevice7, IID_IDirect3DViewport3, IID_IDirect3D3,
        IID_IDirectDraw4, IID_IDirect3DTexture2])
    {
        const refused = h.query(device, iid);
        assert.equal(refused.hr, E_NOINTERFACE, iid);
        assert.equal(refused.pointer, 0, 'and the out-pointer is zeroed');
    }

    assert.equal(h.device(device, 'GetDirect3D', [0x4500]), D3D_OK);
    assert.equal(h.box.memory.readU32(0x4500), d3d, 'the object it was made through');
    assert.equal(h.device(device, 'GetRenderTarget', [0x4500]), D3D_OK);
    assert.equal(h.box.memory.readU32(0x4500), target);
    h.release(target);

    assert.equal(h.device(device, 'GetRenderState', [RS_SPECULARENABLE, 0x4600]), D3D_OK);
    assert.equal(h.box.memory.readU32(0x4600), 0, 'specular starts off on the third generation');

    assert.equal(h.release(device), 0);
    h.release(d3d);
    h.release(d3d);
    h.release(target);
    h.release(ddraw);
    h.assertAllReleased();
});

// --- viewports (Wine's ddraw4.c test_viewport_object) ---

test('a viewport answers all three of its generations with one count, and sizes are exact', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const { device, target } = h.createDevice(ddraw);
    h.device(device, 'GetDirect3D', [0x4500]);
    const d3d = h.box.memory.readU32(0x4500);

    const viewport = h.make(d3d, 'CreateViewport');
    assert.equal(h.countOf(viewport), 1);
    assert.equal(h.d3d(d3d, 'CreateViewport', [0x4400, 0x1234]), CLASS_E_NOAGGREGATION);
    for (const [iid, expected] of /** @type {const} */ ([
        [IID_IDirect3DViewport, DD_OK], [IID_IDirect3DViewport2, DD_OK],
        [IID_IDirect3DViewport3, DD_OK], [IID_IDirectDrawGammaControl, E_NOINTERFACE],
    ]))
    {
        const got = h.query(viewport, iid);
        assert.equal(got.hr, expected, iid);
        if (got.hr === DD_OK)
        {
            assert.equal(h.countOf(viewport), 2, 'one count for every generation');
            h.release(got.pointer);
        }
    }

    const at = 0x6000;
    h.box.bytes.fill(0, at, at + 0x40);
    for (const size of [0, D3DVIEWPORT.SIZE + 1, D3DVIEWPORT.SIZE - 1])
    {
        h.box.memory.writeU32(at, size);
        assert.equal(h.viewport(viewport, 'GetViewport', [at]), DDERR_INVALIDPARAMS >>> 0);
    }
    h.box.memory.writeU32(at, D3DVIEWPORT.SIZE);
    assert.equal(h.viewport(viewport, 'GetViewport', [at]), D3DERR_VIEWPORTDATANOTSET >>> 0);
    assert.equal(h.box.memory.readU32(at), D3DVIEWPORT.SIZE);
    assert.equal(h.viewport(viewport, 'GetViewport2', [at]), D3DERR_VIEWPORTDATANOTSET >>> 0);

    // The device's list and its current viewport each hold a reference.
    assert.equal(h.device(device, 'DeleteViewport', [0]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.device(device, 'GetCurrentViewport', [0]), D3DERR_NOCURRENTVIEWPORT >>> 0);
    assert.equal(h.device(device, 'SetCurrentViewport', [viewport]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.device(device, 'AddViewport', [viewport]), D3D_OK);
    assert.equal(h.countOf(viewport), 2);
    h.box.memory.writeU32(0x4700, 0xbaadc0de);
    assert.equal(h.device(device, 'GetCurrentViewport', [0x4700]), D3DERR_NOCURRENTVIEWPORT >>> 0);
    assert.equal(h.box.memory.readU32(0x4700), 0xbaadc0de, 'and the pointer is left alone');
    assert.equal(h.device(device, 'SetCurrentViewport', [viewport]), D3D_OK);
    assert.equal(h.countOf(viewport), 3);
    assert.equal(h.device(device, 'GetCurrentViewport', [0x4700]), D3D_OK);
    assert.equal(h.box.memory.readU32(0x4700), viewport);
    assert.equal(h.release(viewport), 3);

    // The clip volume, written as D3DVIEWPORT2 and read as D3DVIEWPORT.
    h.box.bytes.fill(0, at, at + 0x40);
    h.box.memory.writeU32(at, 0);
    assert.equal(h.viewport(viewport, 'SetViewport2', [at]), DDERR_INVALIDPARAMS >>> 0);
    h.box.memory.writeU32(at, D3DVIEWPORT2.SIZE);
    h.box.memory.writeU32(at + D3DVIEWPORT2.dwX, 160);
    h.box.memory.writeU32(at + D3DVIEWPORT2.dwY, 120);
    h.box.memory.writeU32(at + D3DVIEWPORT2.dwWidth, 480);
    h.box.memory.writeU32(at + D3DVIEWPORT2.dwHeight, 360);
    h.box.putFloats(at + D3DVIEWPORT2.dvClipX, [2, -1.75, 2.5, -1.5, 0.5, 2]);
    assert.equal(h.viewport(viewport, 'SetViewport2', [at]), D3D_OK);
    h.box.bytes.fill(0xff, at, at + D3DVIEWPORT.SIZE);
    h.box.memory.writeU32(at, D3DVIEWPORT.SIZE);
    assert.equal(h.viewport(viewport, 'GetViewport', [at]), D3D_OK);
    assert.deepEqual(h.box.floatsAt(at + D3DVIEWPORT.dvScaleX, 6), [192, -240, 4.5, -1.75, 0, 1]);

    // And back: D3DVIEWPORT's scale names a volume centred on the origin.
    h.box.putFloats(at + D3DVIEWPORT.dvScaleX, [-320, 180, -3, 1.75, 0.5, 2]);
    assert.equal(h.viewport(viewport, 'SetViewport', [at]), D3D_OK);
    h.box.bytes.fill(0xff, at, at + D3DVIEWPORT2.SIZE);
    h.box.memory.writeU32(at, D3DVIEWPORT2.SIZE);
    assert.equal(h.viewport(viewport, 'GetViewport2', [at]), D3D_OK);
    assert.deepEqual(h.box.floatsAt(at + D3DVIEWPORT2.dvClipX, 6), [0.75, 1, -1.5, 2, 0, 1]);

    // Destroying the device removes the viewport and gives both references back.
    assert.equal(h.release(device), 0);
    assert.equal(h.countOf(viewport), 1);
    assert.equal(h.viewport(viewport, 'SetViewport', [at]), D3DERR_VIEWPORTHASNODEVICE >>> 0);
    assert.equal(h.release(viewport), 0);
    h.release(target);
    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

test('a light is set as D3DLIGHT or D3DLIGHT2 by its size, and reads back as large as asked', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const d3d = h.direct3D(ddraw);
    const light = h.make(d3d, 'CreateLight');
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(light, slot(IDIRECT3DLIGHT_SLOTS, name), args);

    const at = 0x6000;
    h.box.bytes.fill(0, at, at + 0x60);
    h.box.memory.writeU32(at + D3DLIGHT.dltType, 3);
    h.box.putFloats(at + D3DLIGHT.dcvColor, [1, 1, 1, 0.5]);
    h.box.putFloats(at + D3DLIGHT.dvDirection, [0, 0, 1]);
    h.box.memory.writeU32(at + D3DLIGHT.dwFlags, D3DLIGHT_ACTIVE);
    assert.equal(call('SetLight', [at]), DDERR_INVALIDPARAMS >>> 0, 'no size');
    assert.equal(call('SetLight', [0]), DDERR_INVALIDPARAMS >>> 0);
    h.box.memory.writeU32(at, D3DLIGHT.SIZE2);
    assert.equal(call('SetLight', [at]), D3D_OK);

    const out = 0x6100;
    h.box.bytes.fill(0xcd, out, out + 0x60);
    h.box.memory.writeU32(out, D3DLIGHT.SIZE2);
    assert.equal(call('GetLight', [out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out + D3DLIGHT.dltType), 3);
    assert.deepEqual(h.box.floatsAt(out + D3DLIGHT.dcvColor, 4), [1, 1, 1, 0.5]);
    assert.equal(h.box.memory.readU32(out + D3DLIGHT.dwFlags), D3DLIGHT_ACTIVE);
    assert.equal(h.box.bytes[out + D3DLIGHT.SIZE2], 0xcd, 'nothing past the structure');
    h.box.bytes.fill(0xcd, out, out + 0x60);
    h.box.memory.writeU32(out, D3DLIGHT.SIZE);
    assert.equal(call('GetLight', [out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out + D3DLIGHT.dwFlags), 0xcdcdcdcd,
        'a D3DLIGHT has no flags to write');

    assert.equal(h.release(light), 0);
    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

test('a material answers three generations, and its handle is what a light state names', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const { device, target } = h.createDevice(ddraw);
    h.device(device, 'GetDirect3D', [0x4500]);
    const d3d = h.box.memory.readU32(0x4500);
    const material = h.make(d3d, 'CreateMaterial');
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(material, slot(IDIRECT3DMATERIAL3_SLOTS, name), args);
    for (const iid of [IID_IDirect3DMaterial, IID_IDirect3DMaterial2])
    {
        const got = h.query(material, iid);
        assert.equal(got.hr, DD_OK);
        h.release(got.pointer);
    }

    const at = 0x6000;
    h.box.bytes.fill(0, at, at + D3DMATERIAL.SIZE);
    h.box.putFloats(at + D3DMATERIAL.emissive, [0, 1, 0, 0]);
    assert.equal(call('SetMaterial', [at]), DDERR_INVALIDPARAMS >>> 0, 'no size');
    h.box.memory.writeU32(at, D3DMATERIAL.SIZE);
    assert.equal(call('SetMaterial', [at]), D3D_OK);
    h.box.bytes.fill(0, at, at + D3DMATERIAL.SIZE);
    assert.equal(call('GetMaterial', [at]), D3D_OK);
    assert.deepEqual(h.box.floatsAt(at + D3DMATERIAL.emissive, 4), [0, 1, 0, 0]);

    assert.equal(call('GetHandle', [device, 0x4600]), D3D_OK);
    const handle = h.box.memory.readU32(0x4600);
    assert.notEqual(handle, 0);
    assert.equal(call('GetHandle', [0, 0x4600]), DDERR_INVALIDPARAMS >>> 0);

    // Wine's ddraw4.c test_material.
    h.box.memory.writeU32(0x4700, 0xcdcdcdcd);
    assert.equal(h.device(device, 'GetLightState', [D3DLIGHTSTATE.MATERIAL, 0x4700]), D3D_OK);
    assert.equal(h.box.memory.readU32(0x4700), 0);
    assert.equal(h.device(device, 'SetLightState', [D3DLIGHTSTATE.MATERIAL, handle]), D3D_OK);
    h.device(device, 'GetLightState', [D3DLIGHTSTATE.MATERIAL, 0x4700]);
    assert.equal(h.box.memory.readU32(0x4700), handle);

    const viewport = h.addViewport(d3d, device);
    assert.equal(h.viewport(viewport, 'SetBackground', [handle]), D3D_OK);
    assert.equal(h.viewport(viewport, 'SetBackground', [0]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.viewport(viewport, 'GetBackground', [0x4700, 0x4704]), D3D_OK);
    assert.deepEqual([h.box.memory.readU32(0x4700), h.box.memory.readU32(0x4704)], [handle, 1]);

    assert.equal(h.release(material), 0);
    assert.equal(h.release(viewport), 1, 'the device holds the viewport');
    assert.equal(h.release(device), 0);
    h.release(target);
    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

// --- finding and enumerating devices ---

test('FindDevice checks both sizes, finds by GUID or hardware, and ignores the colour model', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const d3d = h.direct3D(ddraw);
    const search = 0x6000;
    const result = 0x6100;
    const fullResult = D3DFINDDEVICERESULT.ddHwDesc + 2 * D3DDEVICEDESC.SIZE;
    /** @param {number} resultSize @param {number} flags @param {string} [guid] */
    const find = (resultSize, flags, guid)=>{
        h.box.bytes.fill(0, search, search + D3DFINDDEVICESEARCH.SIZE);
        h.box.bytes.fill(0, result, result + fullResult + 4);
        h.box.memory.writeU32(search, D3DFINDDEVICESEARCH.SIZE);
        h.box.memory.writeU32(search + D3DFINDDEVICESEARCH.dwFlags, flags);
        if (guid)
        {
            h.box.putGuid(search + D3DFINDDEVICESEARCH.guid, guid);
        }
        h.box.memory.writeU32(result, resultSize);
        return h.d3d(d3d, 'FindDevice', [search, result]);
    };
    const hwSize = ()=>h.box.memory.readU32(result + D3DFINDDEVICERESULT.ddHwDesc);

    assert.equal(h.d3d(d3d, 'FindDevice', [0, 0]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.d3d(d3d, 'FindDevice', [0, result]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(find(fullResult, 0), D3D_OK);
    assert.equal(hwSize(), D3DDEVICEDESC.SIZE);
    assert.equal(h.box.memory.readU32(result + D3DFINDDEVICERESULT.ddHwDesc
        + D3DDEVICEDESC.SIZE), D3DDEVICEDESC.SIZE, 'and the software description\'s');
    assert.equal(find(fullResult + 1, 0), DDERR_INVALIDPARAMS >>> 0);
    h.box.memory.writeU32(search, 0);
    assert.equal(h.d3d(d3d, 'FindDevice', [search, result]), DDERR_INVALIDPARAMS >>> 0);

    // A result laid out for an older header: its descriptions sit where
    // that size puts them, and each still says this version's size.
    const v1 = D3DFINDDEVICERESULT.ddHwDesc + 2 * D3DDEVICEDESC.SIZE_V1;
    assert.equal(find(v1, 0), D3D_OK);
    assert.equal(hwSize(), D3DDEVICEDESC.SIZE);
    assert.equal(h.box.memory.readU32(result + D3DFINDDEVICERESULT.ddHwDesc
        + D3DDEVICEDESC.SIZE_V1), D3DDEVICEDESC.SIZE);
    assert.equal(h.box.memory.readU32(result + v1), 0, 'nothing past the smaller result');

    for (const [guid, expected] of /** @type {const} */ ([
        [IID_IDirect3D, DDERR_NOTFOUND], [DEVICE_IDS.RAMP, DDERR_NOTFOUND],
        [DEVICE_IDS.RGB, D3D_OK], [DEVICE_IDS.HAL, D3D_OK], [DEVICE_IDS.MMX, DDERR_NOTFOUND],
        [DEVICE_IDS.REF, DDERR_NOTFOUND], [DEVICE_IDS.TNLHAL, DDERR_NOTFOUND],
        [DEVICE_IDS.NULL, DDERR_NOTFOUND],
    ]))
    {
        assert.equal(find(fullResult, D3DFDS_GUID, guid), expected >>> 0, guid);
        assert.equal(hwSize(), expected === D3D_OK ? D3DDEVICEDESC.SIZE : 0,
            'a device not found writes no description');
    }
    assert.equal(find(fullResult, D3DFDS_GUID, DEVICE_IDS.HAL), D3D_OK);
    assert.deepEqual([...h.box.bytes.slice(result + D3DFINDDEVICERESULT.guid,
        result + D3DFINDDEVICERESULT.guid + 16)], [...guidBytes(DEVICE_IDS.HAL)]);
    assert.equal(find(fullResult, 1), D3D_OK, 'D3DFDS_COLORMODEL alone finds a device');

    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

test('EnumDevices names the software device and then the hardware one', async()=>{
    const h = seamed((box, [guid, text, name, hal, hel])=>{
        const at = (/** @type {number} */ base, /** @type {number} */ offset)=>
            box.memory.readU32(base + offset);
        return {
            guid: [...box.bytes.slice(guid, guid + 16)],
            text: box.stringAt(text),
            name: box.stringAt(name),
            sizes: [at(hal, 0), at(hel, 0)],
            nested: [at(hal, 0x10), at(hal, 0x1c), at(hal, D3DDEVICEDESC.dpcLineCaps),
                at(hal, D3DDEVICEDESC.dpcTriCaps)],
            halFlags: at(hal, D3DDEVICEDESC.dwFlags),
            halCaps: at(hal, D3DDEVICEDESC.dwDevCaps),
            helFlags: at(hel, D3DDEVICEDESC.dwFlags),
            helCaps: at(hel, D3DDEVICEDESC.dwDevCaps),
            helModel: at(hel, D3DDEVICEDESC.dcmColorModel),
            helTexture: at(hel, D3DDEVICEDESC.dpcTriCaps + D3DPRIMCAPS.dwTextureCaps),
            helVertices: at(hel, D3DDEVICEDESC.dwMaxVertexCount),
            halVertices: at(hal, D3DDEVICEDESC.dwMaxVertexCount),
        };
    });
    const ddraw = h.create4();
    const d3d = h.direct3D(ddraw);
    assert.equal(h.d3d(d3d, 'EnumDevices', [0, 0]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(await h.box.callRaw(d3d, slot(IDIRECT3D3_SLOTS, 'EnumDevices'), [0x1234, 0x77]),
        D3D_OK);
    const seen = h.callbacks.map(call=>call.seen);
    assert.deepEqual(seen.map(device=>device.name), ['RGB Emulation', 'Direct3D HAL']);
    assert.deepEqual(seen[0].guid, [...guidBytes(DEVICE_IDS.RGB)]);
    assert.equal(h.callbacks[0].args[5], 0x77, 'the context travels last');
    for (const device of seen)
    {
        assert.deepEqual(device.sizes, [D3DDEVICEDESC.SIZE, D3DDEVICEDESC.SIZE]);
        assert.deepEqual(device.nested, [8, 16, D3DPRIMCAPS.SIZE, D3DPRIMCAPS.SIZE],
            'even an empty description carries its parts\' sizes');
    }
    const [rgb, hal] = seen;
    assert.equal(rgb.halFlags, 0, 'the software device has no hardware side');
    assert.equal(rgb.helModel, 2, 'D3DCOLOR_RGB');
    assert.equal(rgb.helCaps & (D3DDEVCAPS_HWRASTERIZATION | D3DDEVCAPS_DRAWPRIMITIVES2EX), 0);
    assert.equal(rgb.helTexture & D3DPTEXTURECAPS_POW2, D3DPTEXTURECAPS_POW2);
    assert.notEqual(hal.halFlags, 0);
    assert.equal(hal.halCaps & D3DDEVCAPS_DRAWPRIMITIVES2EX, D3DDEVCAPS_DRAWPRIMITIVES2EX);
    assert.equal(hal.helModel, 0, 'the hardware device\'s software side reports little');
    assert.equal(hal.helVertices, hal.halVertices);

    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

test('GetCaps writes each description as large as its caller said, and GetStats counts', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const { device, target } = h.createDevice(ddraw);
    const hal = 0x6000;
    const hel = 0x6200;
    h.box.bytes.fill(0xcd, hal, hal + 0x400);
    h.box.memory.writeU32(hal, D3DDEVICEDESC.SIZE_V2);
    h.box.memory.writeU32(hel, D3DDEVICEDESC.SIZE);
    assert.equal(h.device(device, 'GetCaps', [hal, hel]), D3D_OK);
    assert.equal(h.box.memory.readU32(hal), D3DDEVICEDESC.SIZE_V2, 'the size is the caller\'s');
    assert.equal(h.box.memory.readU32(hal + D3DDEVICEDESC.dwDevCaps)
        & D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWRASTERIZATION);
    assert.equal(h.box.bytes[hal + D3DDEVICEDESC.SIZE_V2], 0xcd, 'and nothing past it');
    h.box.memory.writeU32(hal, D3DDEVICEDESC.SIZE + 4);
    assert.equal(h.device(device, 'GetCaps', [hal, hel]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.device(device, 'GetCaps', [0, hel]), DDERR_INVALIDPARAMS >>> 0);

    const d3d = (()=>{
        h.device(device, 'GetDirect3D', [0x4500]);
        return h.box.memory.readU32(0x4500);
    })();
    const viewport = h.addViewport(d3d, device);
    h.device(device, 'SetCurrentViewport', [viewport]);
    const vertices = 0x7000;
    h.box.bytes.fill(0, vertices, vertices + 4 * 24);
    assert.equal(h.device(device, 'DrawPrimitive', [D3DPT.TRIANGLESTRIP,
        FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR, vertices, 4, 0]), 0x88760000 + 761,
    'D3DERR_SCENE_NOT_IN_SCENE: the draw was read and handed down');
    h.device(device, 'BeginScene');
    assert.equal(h.device(device, 'DrawPrimitive', [D3DPT.TRIANGLESTRIP,
        FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR, vertices, 4, 0]), D3D_OK);
    h.device(device, 'EndScene');
    const stats = 0x6400;
    h.box.memory.writeU32(stats, 0);
    assert.equal(h.device(device, 'GetStats', [stats]), DDERR_INVALIDPARAMS >>> 0);
    h.box.memory.writeU32(stats, D3DSTATS.SIZE);
    assert.equal(h.device(device, 'GetStats', [stats]), D3D_OK);
    assert.equal(h.box.memory.readU32(stats + D3DSTATS.dwTrianglesDrawn), 2);
    assert.equal(h.box.memory.readU32(stats + D3DSTATS.dwVerticesProcessed), 4);

    h.release(viewport);
    assert.equal(h.release(device), 0);
    h.release(target);
    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

// --- vertex buffers and textures ---

test('a DirectX 6 vertex buffer counts on its own and is no IDirect3DVertexBuffer7', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const { device, target } = h.createDevice(ddraw);
    h.device(device, 'GetDirect3D', [0x4500]);
    const d3d = h.box.memory.readU32(0x4500);
    const d3dCount = h.countOf(d3d);
    const deviceCount = h.countOf(device);

    const desc = 0x6000;
    h.box.bytes.fill(0, desc, desc + D3DVERTEXBUFFERDESC.SIZE);
    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwFVF, FVF.XYZ);
    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwNumVertices, 4);
    assert.equal(h.d3d(d3d, 'CreateVertexBuffer', [desc, 0x4400, 0, 0]),
        DDERR_INVALIDPARAMS >>> 0, 'no size');
    h.box.memory.writeU32(desc, D3DVERTEXBUFFERDESC.SIZE);
    assert.equal(h.d3d(d3d, 'CreateVertexBuffer', [desc, 0x4400, 0, 0]), D3D_OK);
    const buffer = h.box.memory.readU32(0x4400);

    // Wine's ddraw4.c test_vb_refcount.
    assert.equal(h.countOf(d3d), d3dCount);
    assert.equal(h.countOf(device), deviceCount);
    assert.equal(h.query(buffer, IID_IDirect3DVertexBuffer).hr, DD_OK);
    h.release(buffer);
    assert.equal(h.query(buffer, IID_IDirect3DVertexBuffer7).hr, E_NOINTERFACE);

    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.box.call(buffer, slot(IDIRECT3DVERTEXBUFFER_SLOTS, name), args);
    assert.equal(call('Lock', [0, 0x4600, 0x4604]), D3D_OK);
    assert.notEqual(h.box.memory.readU32(0x4600), 0);
    assert.equal(h.box.memory.readU32(0x4604), 4 * 12);
    assert.equal(call('Unlock', []), D3D_OK);

    assert.equal(h.release(buffer), 0);
    assert.equal(h.release(device), 0);
    h.release(target);
    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

test('a surface is a texture too, whose Load keeps its colour key when the source has none', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const { device, target } = h.createDevice(ddraw);
    const source = h.surface(ddraw, DDSCAPS_TEXTURE);
    const dest = h.surface(ddraw, DDSCAPS_TEXTURE);
    const sourceTexture = h.query(source, IID_IDirect3DTexture2).pointer;
    const destTexture = h.query(dest, IID_IDirect3DTexture2).pointer;
    assert.notEqual(destTexture, 0);
    assert.equal(h.countOf(dest), 2, 'the texture interface shares the surface\'s count');
    const older = h.query(dest, IID_IDirect3DTexture);
    assert.equal(older.hr, DD_OK);
    h.release(older.pointer);

    const texture = (/** @type {number} */ pointer, /** @type {string} */ name,
        /** @type {number[]} */ args)=>h.box.call(pointer, slot(IDIRECT3DTEXTURE2_SLOTS, name),
        args);
    assert.equal(texture(destTexture, 'GetHandle', [device, 0x4600]), D3D_OK);
    const handle = h.box.memory.readU32(0x4600);
    assert.notEqual(handle, 0);
    texture(destTexture, 'GetHandle', [device, 0x4600]);
    assert.equal(h.box.memory.readU32(0x4600), handle, 'one surface, one handle');

    // Wine's ddraw4.c test_texture_load_ckey.
    assert.equal(h.publisher.objectAt(sourceTexture), h.publisher.objectAt(source),
        'a pointer QueryInterface made names its object');
    const destModel = h.publisher.objectAt(dest);
    const sourceModel = h.publisher.objectAt(source);
    h.box.memory.writeU32(h.publisher.objectAt(source).buffer, 0x00123456);
    assert.equal(texture(destTexture, 'Load', [sourceTexture]), D3D_OK);
    assert.equal(h.box.memory.readU32(destModel.buffer), 0x00123456, 'the pixels came across');
    assert.equal(destModel.getColorKey(DDCKEY_SRCBLT).hr, DDERR_NOCOLORKEY);
    sourceModel.setColorKey(DDCKEY_SRCBLT, { low: 0xff00, high: 0xff00 });
    texture(destTexture, 'Load', [sourceTexture]);
    assert.equal(destModel.getColorKey(DDCKEY_SRCBLT).key.low, 0xff00);
    sourceModel.setColorKey(DDCKEY_SRCBLT, null);
    texture(destTexture, 'Load', [sourceTexture]);
    assert.equal(destModel.getColorKey(DDCKEY_SRCBLT).key?.low, 0xff00,
        'unlike IDirect3DDevice7::Load, which takes it away');

    // SetTexture takes the texture interface and GetTexture hands one back.
    assert.equal(h.device(device, 'SetTexture', [0, destTexture]), D3D_OK);
    assert.equal(h.device(device, 'GetTexture', [0, 0x4700]), D3D_OK);
    assert.equal(h.box.memory.readU32(0x4700), destTexture);
    h.release(destTexture);
    assert.equal(h.device(device, 'SetTexture', [0, 0]), D3D_OK);

    h.release(sourceTexture);
    h.release(destTexture);
    assert.equal(h.release(source), 0);
    assert.equal(h.release(dest), 0);
    assert.equal(h.release(device), 0);
    h.release(target);
    h.release(ddraw);
    h.assertAllReleased();
});

test('an IDirectDrawSurface4 still answers its own slots beside the texture ones', ()=>{
    const h = seamed();
    const ddraw = h.create4();
    const surface = h.surface(ddraw, DDSCAPS_TEXTURE);
    const at = 0x6000;
    h.box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
    h.box.memory.writeU32(at, DDSURFACEDESC2.SIZE);
    assert.equal(h.box.call(surface, slot(IDIRECTDRAWSURFACE4_SLOTS, 'GetSurfaceDesc'), [at]),
        DD_OK);
    assert.equal(h.release(surface), 0);
    h.release(ddraw);
    h.assertAllReleased();
});

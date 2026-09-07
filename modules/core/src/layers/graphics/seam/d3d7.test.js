/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 7 seam, driven the way a guest drives it: through interface
 * pointers the bridge's own vtable publisher laid out, by slot number, over a
 * flat buffer standing in for guest memory.
 *
 * What is checked here is translation and nothing else -- the object model
 * behind it has its own tests, and so does the picture. That means: the
 * interface is reached from DirectDraw rather than from an entry point, an
 * out-parameter is written when the call succeeded and left alone when it
 * failed, a structure is read at the offsets the header gives, and a float
 * arriving in a dword slot is read as the float it is.
 *
 * Every test ends with the DirectDraw object at zero: a count that stayed up
 * is a resource something still holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import { createGraphicsLibraries } from './exports.js';
import { createDirect3D7Seam } from './d3d7.js';
import {
    IDIRECT3D7_SLOTS, IDIRECT3DDEVICE7_SLOTS, IDIRECT3DVERTEXBUFFER7_SLOTS, IDIRECTDRAW7_SLOTS,
} from './vtables.js';
import { IID_IDirect3D7, IID_IDirectDraw7 } from './iids.js';
import {
    D3DDEVICEDESC7, D3DPRIMCAPS, D3DRECT, D3DVERTEXBUFFERDESC, D3DVIEWPORT7,
} from './structs.js';
import { guidBytes } from './d3d7.js';
import { createDirectDraw } from '../ddraw/objects.js';
import { DDSURFACEDESC2, writeSurfaceDesc } from '../ddraw/structs.js';
import {
    DDPF_RGB, DDPF_ZBUFFER, DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCL_NORMAL, DDSD_CAPS,
    DDSD_HEIGHT, DDSD_PIXELFORMAT, DDSD_WIDTH, DD_OK,
} from '../ddraw/constants.js';
import {
    D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWTRANSFORMANDLIGHT, D3DERR_INVALIDVERTEXFORMAT,
    D3DERR_SCENE_NOT_IN_SCENE, D3DERR_VERTEXBUFFERLOCKED, D3D_OK, DDERR_INVALIDCAPS,
    DDERR_INVALIDPARAMS, DDERR_NOTFOUND, DEVICE_IDS, floatToDword,
} from '../d3d7/constants.js';
import { D3DCLEAR, D3DPT } from '../d3d8/constants.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

const HWND = 0x00010044;
const SCREEN = { width: 16, height: 16, bitsPerPixel: 32 };
const FVF_TL = FVF.XYZRHW | FVF.DIFFUSE;

/** Twenty bytes: four floats of position and a packed colour. */
const TL_STRIDE = 20;

const ARGB32 = Object.freeze({
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
    /** Surfaces and vertex buffers live in the same buffer, from the top half down. */
    let storageNext = 0x80000;

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
        allocateStorage: size=>{
            const at = storageNext;
            storageNext += size + 0xfff & ~0xfff;
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
        /** @param {number} pointer @param {number} index */
        argBytesOf(pointer, index){
            const table = memory.readU32(pointer);
            return registered.get(memory.readU32(table + index * 4)).fn.argBytes;
        },
        /** @param {number} at NUL-terminated ANSI, as a name is handed to a callback */
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
    };
}

/** The whole assembly, as a program reaches it: DDRAW.dll and what it leads to. */
function seamed(){
    const box = machine();
    /** @type {any[]} */
    const roots = [];
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
    });
    const ddrawDll = libraries.libraries['DDRAW.dll'];

    const h = {
        box,
        roots,
        publisher,
        /** The DirectDraw object as its seventh generation, under a cooperative level. */
        create7(){
            const riid = box.putGuid(0x4000, IID_IDirectDraw7);
            assert.equal(ddrawDll.DirectDrawCreateEx.handler([0, 0x4100, riid, 0]), DD_OK);
            const pointer = box.memory.readU32(0x4100);
            assert.equal(box.call(pointer, slot(IDIRECTDRAW7_SLOTS, 'SetCooperativeLevel'),
                [HWND, DDSCL_NORMAL]), DD_OK);
            return pointer;
        },
        /** @param {number} ddraw */
        direct3D(ddraw){
            const riid = box.putGuid(0x4000, IID_IDirect3D7);
            assert.equal(box.call(ddraw, 0, [riid, 0x4200]), 0, 'QueryInterface for IDirect3D7');
            return box.memory.readU32(0x4200);
        },
        /** @param {number} ddraw @param {number} caps */
        surface(ddraw, caps = DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN){
            const at = 0x5000;
            box.bytes.fill(0, at, at + DDSURFACEDESC2.SIZE);
            writeSurfaceDesc(box.services, at, DDSURFACEDESC2, {
                flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
                width: 8,
                height: 8,
                pitch: 0,
                backBufferCount: 0,
                mipMapCount: 0,
                caps,
                caps2: 0,
                pixelFormat: ARGB32,
            });
            const hr = box.call(ddraw, slot(IDIRECTDRAW7_SLOTS, 'CreateSurface'), [at, 0x5100, 0]);
            assert.equal(hr, DD_OK, 'the fixture surface is created');
            return box.memory.readU32(0x5100);
        },
        /** @param {number} d3d @param {number} surface @param {string} id */
        createDevice(d3d, surface, id = DEVICE_IDS.TNLHAL){
            const riid = box.putGuid(0x4300, id);
            const hr = box.call(d3d, slot(IDIRECT3D7_SLOTS, 'CreateDevice'),
                [riid, surface, 0x4400]);
            return { hr, device: box.memory.readU32(0x4400) };
        },
        /** @param {number} device @param {string} name @param {number[]} args */
        device: (device, name, args = [])=>
            box.call(device, slot(IDIRECT3DDEVICE7_SLOTS, name), args),
        /** @param {number} buffer @param {string} name @param {number[]} args */
        buffer: (buffer, name, args = [])=>
            box.call(buffer, slot(IDIRECT3DVERTEXBUFFER7_SLOTS, name), args),
        /** @param {number} pointer */
        release: pointer=>box.call(pointer, 2, []),
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

test('Direct3D 7 is a query away from DirectDraw, and shares its count', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const model = h.roots[0];
    assert.equal(model.refCount('IDirectDraw7'), 1);

    const d3d = h.direct3D(ddraw);
    assert.notEqual(d3d, ddraw, 'a different table, so a different pointer');
    assert.equal(model.refCount('IDirectDraw7'), 2,
        'the query took a reference, and it is IDirectDraw7 that holds it');
    const table = h.box.memory.readU32(d3d);
    assert.notEqual(h.box.memory.readU32(table + (3 + IDIRECT3D7_SLOTS.length - 1) * 4), 0,
        'EvictManagedTextures is the last slot');
    assert.equal(h.box.argBytesOf(d3d, slot(IDIRECT3D7_SLOTS, 'CreateDevice')), 4 + 3 * 4);

    // Asking twice answers the same pointer: two would be two identities, and
    // a program comparing them would decide it holds two objects.
    assert.equal(h.direct3D(ddraw), d3d);
    assert.equal(h.release(d3d), 2);
    assert.equal(h.release(d3d), 1);
    assert.equal(model.destroyed, false, 'the object lives while DirectDraw holds it');
    assert.equal(h.release(ddraw), 0);
    h.assertAllReleased();
});

test('CreateDevice refuses what cannot be a target, and publishes what can', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const d3d = h.direct3D(ddraw);
    const target = h.surface(ddraw);

    assert.equal(h.createDevice(d3d, target, DEVICE_IDS.REF).hr, DDERR_NOTFOUND >>> 0,
        'the reference rasteriser is in the header and not in this build');
    assert.equal(h.box.memory.readU32(0x4400), 0, 'and the out-parameter was zeroed');
    assert.equal(h.createDevice(d3d, 0).hr, DDERR_INVALIDPARAMS >>> 0, 'no surface');

    const plain = h.surface(ddraw, DDSCAPS_OFFSCREENPLAIN);
    assert.equal(h.createDevice(d3d, plain).hr, DDERR_INVALIDCAPS >>> 0,
        'a surface with no 3D caps cannot be rendered into');

    const made = h.createDevice(d3d, target);
    assert.equal(made.hr, D3D_OK);
    assert.notEqual(made.device, 0);
    const table = h.box.memory.readU32(made.device);
    assert.notEqual(h.box.memory.readU32(table + (3 + IDIRECT3DDEVICE7_SLOTS.length - 1) * 4), 0,
        'GetInfo is the last of the forty-six');

    // GetDirect3D answers the interface the device was made through, not a
    // second one: the object is the same and so is its pointer.
    assert.equal(h.device(made.device, 'GetDirect3D', [0x4500]), D3D_OK);
    assert.equal(h.box.memory.readU32(0x4500), d3d);
    assert.equal(h.device(made.device, 'GetDirect3D', [0]), DDERR_INVALIDPARAMS >>> 0);

    // Two releases on the Direct3D pointer: the query took one reference and
    // GetDirect3D another, and both are IDirectDraw7's count.
    assert.equal(h.release(made.device), 0, 'the device holds nothing of its own at the end');
    h.release(d3d);
    h.release(d3d);
    h.release(plain);
    h.release(target);
    h.release(ddraw);
    h.assertAllReleased();
});

test('GetCaps writes a description a program reads field by field', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const d3d = h.direct3D(ddraw);
    const target = h.surface(ddraw);
    const device = h.createDevice(d3d, target).device;

    const at = 0x6000;
    h.box.bytes.fill(0xcd, at, at + D3DDEVICEDESC7.SIZE + 16);
    assert.equal(h.device(device, 'GetCaps', [at]), D3D_OK);
    const field = (/** @type {number} */ offset)=>h.box.memory.readU32(at + offset);

    const devCaps = field(D3DDEVICEDESC7.dwDevCaps);
    assert.equal(devCaps & D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWRASTERIZATION);
    assert.equal(devCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT, D3DDEVCAPS_HWTRANSFORMANDLIGHT,
        'the transform-and-lighting device says so, which is what a program branches on');
    assert.equal(field(D3DDEVICEDESC7.dpcLineCaps + D3DPRIMCAPS.dwSize), D3DPRIMCAPS.SIZE);
    assert.equal(field(D3DDEVICEDESC7.dpcTriCaps + D3DPRIMCAPS.dwSize), D3DPRIMCAPS.SIZE,
        'both capability blocks carry their own size, at the offsets the header gives');

    // The only two fields narrower than a dword: a pair of words each, low
    // word first, which is the transcription easiest to get wrong.
    const stages = field(D3DDEVICEDESC7.wMaxTextureBlendStages);
    assert.ok((stages & 0xffff) > 0 && (stages >>> 16) > 0,
        'the blend stages and the simultaneous textures share one dword');

    assert.deepEqual([...h.box.services.readMemory(at + D3DDEVICEDESC7.deviceGUID, 16)],
        [...guidBytes(DEVICE_IDS.TNLHAL)], 'and the description names the device it describes');
    assert.equal(h.box.bytes[at + D3DDEVICEDESC7.SIZE], 0xcd,
        'nothing was written past the end of the structure');
    assert.equal(h.device(device, 'GetCaps', [0]), DDERR_INVALIDPARAMS >>> 0);

    assert.equal(h.release(device), 0);
    h.release(d3d);
    h.release(target);
    h.release(ddraw);
    h.assertAllReleased();
});

test('a viewport goes through as a structure, and Clear reads its Z as a float', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const d3d = h.direct3D(ddraw);
    const target = h.surface(ddraw);
    const device = h.createDevice(d3d, target).device;

    const at = 0x6100;
    h.box.memory.writeU32(at + D3DVIEWPORT7.dwX, 0);
    h.box.memory.writeU32(at + D3DVIEWPORT7.dwY, 2);
    h.box.memory.writeU32(at + D3DVIEWPORT7.dwWidth, 8);
    h.box.memory.writeU32(at + D3DVIEWPORT7.dwHeight, 4);
    h.box.memory.writeU32(at + D3DVIEWPORT7.dvMinZ, floatToDword(0.25));
    h.box.memory.writeU32(at + D3DVIEWPORT7.dvMaxZ, floatToDword(0.75));
    assert.equal(h.device(device, 'SetViewport', [at]), D3D_OK);

    const back = 0x6200;
    assert.equal(h.device(device, 'GetViewport', [back]), D3D_OK);
    assert.equal(h.box.memory.readU32(back + D3DVIEWPORT7.dwWidth), 8);
    assert.equal(h.box.memory.readU32(back + D3DVIEWPORT7.dvMinZ), floatToDword(0.25),
        'the two Z bounds are floats in dword slots, and come back as they went in');
    assert.equal(h.box.memory.readU32(back + D3DVIEWPORT7.dvMaxZ), floatToDword(0.75));
    assert.equal(h.device(device, 'SetViewport', [0]), DDERR_INVALIDPARAMS >>> 0);

    // Clear's Z is the same kind of argument, but arrives in a stack slot
    // rather than a structure: the bytes are the caller's, only the reading
    // differs.
    const rect = 0x6300;
    h.box.memory.writeU32(rect + D3DRECT.x1, 0);
    h.box.memory.writeU32(rect + D3DRECT.y1, 0);
    h.box.memory.writeU32(rect + D3DRECT.x2, 4);
    h.box.memory.writeU32(rect + D3DRECT.y2, 4);
    assert.equal(h.device(device, 'Clear',
        [1, rect, D3DCLEAR.TARGET, 0xff203040, floatToDword(1), 0]), D3D_OK);
    assert.equal(h.device(device, 'Clear', [0, 0, 0, 0, 0, 0]), DDERR_INVALIDPARAMS >>> 0,
        'clearing nothing is not a clear');
    assert.equal(
        h.device(device, 'Clear', [0, 0, D3DCLEAR.ZBUFFER, 0, floatToDword(1), 0]),
        DDERR_INVALIDPARAMS >>> 0, 'and there is no depth buffer attached to clear');

    assert.equal(h.release(device), 0);
    h.release(d3d);
    h.release(target);
    h.release(ddraw);
    h.assertAllReleased();
});

test('a draw reads exactly as many vertex bytes as the format implies', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const d3d = h.direct3D(ddraw);
    const target = h.surface(ddraw);
    const device = h.createDevice(d3d, target).device;
    const vertices = 0x7000;

    assert.equal(
        h.device(device, 'DrawPrimitive', [D3DPT.TRIANGLELIST, FVF_TL, vertices, 3, 0]),
        D3DERR_SCENE_NOT_IN_SCENE >>> 0, 'a draw outside a scene is refused before a read');
    assert.equal(h.device(device, 'BeginScene'), D3D_OK);
    assert.equal(h.device(device, 'DrawPrimitive',
        [D3DPT.TRIANGLELIST, FVF_TL, vertices, 3, 0]), D3D_OK);
    // A format with no position is the one a vertex cannot have: there is no
    // stride to read by, so the refusal has to come before the read.
    assert.equal(h.device(device, 'DrawPrimitive',
        [D3DPT.TRIANGLELIST, FVF.DIFFUSE, vertices, 3, 0]), D3DERR_INVALIDVERTEXFORMAT >>> 0);
    assert.equal(
        h.device(device, 'DrawPrimitive', [D3DPT.TRIANGLELIST, FVF_TL, 0, 3, 0]),
        DDERR_INVALIDPARAMS >>> 0, 'and vertices at address zero are no vertices');

    // The indices of D3D7 are sixteen-bit words, unlike everything after it,
    // so the length read for them is the count doubled.
    const indices = vertices + 3 * TL_STRIDE;
    assert.equal(h.device(device, 'DrawIndexedPrimitive',
        [D3DPT.TRIANGLELIST, FVF_TL, vertices, 3, indices, 3, 0]), D3D_OK);
    assert.equal(h.device(device, 'DrawIndexedPrimitive',
        [D3DPT.TRIANGLELIST, FVF_TL, vertices, 3, 0, 3, 0]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.device(device, 'EndScene'), D3D_OK);

    assert.equal(h.release(device), 0);
    h.release(d3d);
    h.release(target);
    h.release(ddraw);
    h.assertAllReleased();
});

test('a vertex buffer is a guest allocation with a description of its own', ()=>{
    const h = seamed();
    const ddraw = h.create7();
    const d3d = h.direct3D(ddraw);
    const desc = 0x6400;
    const create = ()=>h.box.call(d3d, slot(IDIRECT3D7_SLOTS, 'CreateVertexBuffer'),
        [desc, 0x6500, 0]);

    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwSize, D3DVERTEXBUFFERDESC.SIZE - 4);
    assert.equal(create(), DDERR_INVALIDPARAMS >>> 0,
        'the size field is how the structure says which version it is');

    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwSize, D3DVERTEXBUFFERDESC.SIZE);
    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwCaps, 0);
    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwFVF, FVF.DIFFUSE);
    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwNumVertices, 4);
    assert.equal(create(), D3DERR_INVALIDVERTEXFORMAT >>> 0);

    h.box.memory.writeU32(desc + D3DVERTEXBUFFERDESC.dwFVF, FVF_TL);
    assert.equal(create(), D3D_OK);
    const buffer = h.box.memory.readU32(0x6500);
    assert.notEqual(buffer, 0);

    assert.equal(h.buffer(buffer, 'Lock', [0, 0x6600, 0x6604]), D3D_OK);
    const data = h.box.memory.readU32(0x6600);
    assert.notEqual(data, 0, 'the lock answers a guest address the program writes through');
    assert.equal(h.box.memory.readU32(0x6604), 4 * TL_STRIDE,
        'and the whole buffer, which is all D3D7 can lock');
    assert.equal(h.buffer(buffer, 'Lock', [0, 0x6600, 0]), D3DERR_VERTEXBUFFERLOCKED >>> 0);
    assert.equal(h.buffer(buffer, 'Lock', [0, 0, 0]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.buffer(buffer, 'Unlock'), D3D_OK);

    const back = 0x6700;
    assert.equal(h.buffer(buffer, 'GetVertexBufferDesc', [back]), D3D_OK);
    assert.equal(h.box.memory.readU32(back + D3DVERTEXBUFFERDESC.dwSize),
        D3DVERTEXBUFFERDESC.SIZE, 'the size written back is ours, not whatever was there');
    assert.equal(h.box.memory.readU32(back + D3DVERTEXBUFFERDESC.dwFVF), FVF_TL);
    assert.equal(h.box.memory.readU32(back + D3DVERTEXBUFFERDESC.dwNumVertices), 4);

    assert.equal(h.release(buffer), 0);
    h.release(d3d);
    h.release(ddraw);
    h.assertAllReleased();
});

/**
 * The enumerations, driven through the descriptor directly: each answers with
 * a promise the bridge would suspend the caller on, and the vtable harness
 * above reads a slot's answer as a number.
 *
 * One block of scratch memory serves every callback in a walk, so what a
 * callback was shown is read while it runs and not afterwards -- afterwards
 * every entry holds the last one's bytes. That is the contract, not an
 * accident of this harness: the descriptor belongs to the call.
 *
 * @param {(box: any, args: number[]) => any} [observe]
 */
function enumerating(observe = ()=>null){
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    /** @type {{ entry: number, args: number[], seen: any }[]} */
    const calls = [];
    let cancelAfter = Infinity;
    const seam = createDirect3D7Seam({
        publisher,
        memory: box.services,
        /** @param {{ entry: number, args: number[] }} call */
        callGuest: async({ entry, args })=>{
            calls.push({ entry, args: [...args], seen: observe(box, args) });
            return calls.length >= cancelAfter ? 0 : 1;
        },
        scratch: { allocate: box.allocateStorage },
    });
    const root = createDirectDraw({ version: 7, allocate: box.allocateStorage,
        screenWidth: SCREEN.width, screenHeight: SCREEN.height });
    root.setCooperativeLevel(HWND, DDSCL_NORMAL);
    /** @param {string} name */
    const method = name=>{
        const found = seam.interface.methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(found && found.invoke, `${name} is implemented`);
        return found.invoke;
    };
    return {
        box,
        root,
        calls,
        cancel: (/** @type {number} */ after)=>{
            cancelAfter = after;
        },
        /** @param {string} name @param {number[]} args */
        d3d: (name, args)=>method(name)(root, args),
    };
}

test('EnumDevices names three devices, in the order a card with T&L lists them', async()=>{
    // The callback is shown a description, a name and the capabilities, in
    // that order, and the context it passed in last.
    const h = enumerating((box, [description, name, caps])=>({
        description: box.stringAt(description),
        name: box.stringAt(name),
        devCaps: box.memory.readU32(caps + D3DDEVICEDESC7.dwDevCaps),
    }));
    assert.equal(await h.d3d('EnumDevices', [0x1234, 0x77]), D3D_OK);
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[0].entry, 0x1234);
    assert.equal(h.calls[0].args[3], 0x77, 'the context travels');

    assert.deepEqual(h.calls.map(call=>call.seen.name),
        ['RGB Emulation', 'Direct3D HAL', 'Direct3D T&L HAL']);
    assert.equal(h.calls[0].seen.description, 'Microsoft Direct3D RGB Software Emulation',
        'the description is the longer text, and is not the name');
    const capsOf = (/** @type {number} */ index)=>h.calls[index].seen.devCaps;
    assert.equal(capsOf(0) & D3DDEVCAPS_HWRASTERIZATION, 0,
        'the software device claims no hardware rasterisation');
    assert.equal(capsOf(1) & D3DDEVCAPS_HWTRANSFORMANDLIGHT, 0,
        'and the plain hardware device none of the transform and lighting');
    assert.equal(capsOf(2) & D3DDEVCAPS_HWTRANSFORMANDLIGHT, D3DDEVCAPS_HWTRANSFORMANDLIGHT);

    assert.equal(h.d3d('EnumDevices', [0, 0]), DDERR_INVALIDPARAMS >>> 0, 'no callback');
    h.calls.length = 0;
    h.cancel(1);
    assert.equal(await h.d3d('EnumDevices', [0x1234, 0]), D3D_OK);
    assert.equal(h.calls.length, 1, 'DDENUMRET_CANCEL ends the walk');
    assert.equal(h.root.release('IDirectDraw7'), 0);
});

test('EnumZBufferFormats offers depth alone and depth with stencil', async()=>{
    // A depth format is a DDPIXELFORMAT carrying the Z flag; the bit count is
    // the field a program reads to tell the two apart.
    const h = enumerating((box, [format])=>({
        flags: box.memory.readU32(format + 0x04),
        bitCount: box.memory.readU32(format + 0x0c),
    }));
    const riid = h.box.putGuid(0x4000, DEVICE_IDS.TNLHAL);
    assert.equal(await h.d3d('EnumZBufferFormats', [riid, 0x1234, 0x88]), D3D_OK);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].args[1], 0x88);
    assert.deepEqual(h.calls.map(call=>call.seen.bitCount), [16, 32]);
    assert.equal(h.calls[0].seen.flags, DDPF_ZBUFFER,
        'and the flag is what makes it a depth format rather than a colour one');
    assert.equal(h.d3d('EnumZBufferFormats', [riid, 0, 0]), DDERR_INVALIDPARAMS >>> 0);
    assert.equal(h.root.release('IDirectDraw7'), 0);
});

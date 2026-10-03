/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 8 device seam, driven the way a guest drives it: through the
 * bridge's own vtable publisher, by slot number, over a flat buffer standing in
 * for guest memory.
 *
 * What is checked is translation and nothing else -- the object model behind it
 * has its own tests. That means: a structure is read and written at the offsets
 * the header gives, an out-parameter is written when the call succeeded and left
 * alone when it failed, an interface handed back is the same pointer the program
 * already holds where the object is the same object, and a call this build
 * cannot honour says so rather than answering success.
 *
 * Every test ends by releasing what it took and reading the counts, because a
 * count that stayed up is a reference this seam took and never gave back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import { createGraphicsLibraries } from './exports.js';
import { ADAPTER_GUID, describeAdapter } from './adapter.js';
import { BUFFER, SHADOW, STALE_POINTER, TEXTURE } from './shadow.js';
import {
    IDIRECT3D8_SLOTS, IDIRECT3DCUBETEXTURE8_SLOTS, IDIRECT3DDEVICE8_SLOTS,
    IDIRECT3DSURFACE8_SLOTS, IDIRECT3DTEXTURE8_SLOTS, IDIRECT3DVERTEXBUFFER8_SLOTS,
    IDIRECT3DVOLUME8_SLOTS, IDIRECT3DVOLUMETEXTURE8_SLOTS, IDIRECT3DSWAPCHAIN8_SLOTS,
} from './vtables.js';
import { D3DINDEXBUFFER_DESC9, D3DVERTEXBUFFER_DESC9 } from '../d3d9/structs.js';
import { REFRESH_HZ } from '../../win32/user32/display.js';
import { createSystemFunctions } from '../../win32/user32/system.js';
import {
    D3DCAPS8, D3DDISPLAYMODE, D3DLIGHT7, D3DLOCKED_RECT, D3DPRESENT_PARAMETERS8,
    D3DSURFACE_DESC8, D3DVIEWPORT8, D3DVOLUME_DESC8, POINT, RECT, createFields,
} from './structs.js';
import {
    D3DADAPTER_IDENTIFIER8, D3DCLIPSTATUS8, D3DDEVICE_CREATION_PARAMETERS, D3DGAMMARAMP,
    D3DRASTER_STATUS, GAMMA_RAMP_ENTRIES,
} from '../d3d8/structs.js';
import { createDirect3D8 } from '../d3d8/device.js';
import {
    D3DDEVTYPE, D3DFMT, D3DPOOL, D3DSBT, D3DTOP, D3DTS, D3DTSS, floatToDword,
} from '../d3d8/constants.js';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTAVAILABLE = 0x8876086a;
const E_OUTOFMEMORY = 0x8007000e;
const D3DERR_OUTOFVIDEOMEMORY = 0x8876017c;
const S_FALSE = 1;

const SCREEN = { width: 800, height: 600, bitsPerPixel: 32 };
const HWND = 0x00010044;
const BEHAVIOUR = 0x40;

/**
 * Where the device hands out storage of its own. Its addresses are far past
 * anything the vtables use, so the fixture keeps that range in a block of its
 * own rather than pretending to a four-gigabyte address space.
 */
const DEVICE_STORAGE = 0x40000000;

/** @param {[string, number][]} slots @param {string} name */
const slot = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

/** A flat address space with the bridge's vtable publisher over it. */
function machine(){
    const low = new Uint8Array(1 << 20);
    const high = new Uint8Array(8 << 20);
    let next = 0x100;

    /** @param {number} address */
    const block = address=>(address >= DEVICE_STORAGE
        ? { bytes: high, at: address - DEVICE_STORAGE }
        : { bytes: low, at: address });

    /** @param {number} address @param {number} length */
    const readBytes = (address, length)=>{
        const where = block(address);
        return where.bytes.slice(where.at, where.at + length);
    };

    /** @param {number} address @param {Uint8Array} value */
    const writeBytes = (address, value)=>{
        const where = block(address);
        where.bytes.set(value, where.at);
    };

    const memory = {
        readBytes,
        writeBytes,
        /** @param {number} address */
        readU32: address=>{
            const b = readBytes(address, 4);
            return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
        },
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>writeBytes(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ])),
    };

    /** @type {Map<number, any>} */
    const registered = new Map();
    let nextTrap = 1;
    let arenaEmpty = false;
    /** @param {number} size */
    const allocate = size=>{
        if (arenaEmpty)
        {
            return 0;
        }
        const at = next;
        next += size + 16 & ~15;
        return at;
    };
    const vtables = createVtables({
        memory,
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            const id = nextTrap++;
            registered.set(id, { name, fn });
            return id;
        },
        heap: { allocate },
    });

    return {
        memory,
        allocate,
        /** Leaves nowhere to lay another vtable, the way a long run ends up. */
        exhaustArena(){
            arenaEmpty = true;
        },
        services: { readMemory: readBytes, writeMemory: writeBytes },
        /** @param {any} object @param {string} id */
        publishInterface: (object, id)=>vtables.publish(object, id),

        /** @param {number} pointer @param {number} index @param {number[]} args */
        call(pointer, index, args = []){
            const table = memory.readU32(pointer);
            const entry = registered.get(memory.readU32(table + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.fn.handler([pointer, ...args]) >>> 0;
        },
        /**
         * The slot's answer as the bridge sees it: a number, or the promise
         * it suspends the caller on.
         *
         * @param {number} pointer @param {number} index @param {number[]} args
         * @returns {number | Promise<number>}
         */
        callRaw(pointer, index, args = []){
            const table = memory.readU32(pointer);
            const entry = registered.get(memory.readU32(table + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.fn.handler([pointer, ...args]);
        },
        /**
         * The host's path of a method whose slot holds guest code: the trap
         * the guest routine falls back to, found by its name.
         *
         * @param {number} pointer @param {string} name @param {number[]} args
         */
        trap(pointer, name, args = []){
            const entry = [...registered.values()].find(one=>one.name.endsWith(`::${name}`));
            assert.ok(entry, `${name} has a trap`);
            return entry.fn.handler([pointer, ...args]) >>> 0;
        },

        /**
         * Whether a slot holds guest code rather than a trap: its address is
         * none the bridge registered.
         *
         * @param {number} pointer @param {number} index
         */
        isGuest: (pointer, index)=>!registered.has(memory.readU32(memory.readU32(pointer)
            + index * 4)),

        /** @param {number} pointer @param {number} index */
        argBytesOf(pointer, index){
            const table = memory.readU32(pointer);
            return registered.get(memory.readU32(table + index * 4)).fn.argBytes;
        },
    };
}

/**
 * The whole assembly, as a program reaches it: D3D8.dll and what it leads to.
 *
 * @param {{ shadow?: boolean,
 *           windowClientSize?: (window: number) => { width: number,
 *               height: number } | null,
 *           allocateCode?: (bytes: number) => number, caps?: object }} [options]
 *     Whether the device keeps a block in guest memory, as it does under a
 *     running processor, how a window's client area is measured when a
 *     program asks for zero, and what the root is made with.
 */
function seamed({ shadow = false, windowClientSize, allocateCode, caps } = {}){
    const box = machine();
    /** The display's clock, which the test moves. */
    const clock = { time: 0 };
    /** @type {string[]} */
    const divergences = [];
    /** @type {any[]} */
    const cursors = [];
    /** @type {[number, number][]} */
    /** @type {[number, number, number | undefined, boolean | undefined][]} */
    const resolutions = [];
    /** @type {any[]} */
    const roots = [];
    /** @param {number} window */
    const measureWindow = window=>{
        return window === HWND ? { width: 640, height: 480 } : null;
    };
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const libraries = createGraphicsLibraries({
        graphics: {
            /** @param {string} name */
            create: name=>{
                if (name !== 'd3d8')
                {
                    return null;
                }
                const root = createDirect3D8(caps);
                roots.push(root);
                return root;
            },
            available: ()=>false,
            adapter: ()=>({ vendor: 'nvidia', architecture: 'ampere', description: '' }),
        },
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>SCREEN,
        // One measurable window, so a size asked for as zero has a client area
        // to be answered with; a test wanting the unmeasurable path passes a
        // measurer of its own that answers nothing.
        windowClientSize: windowClientSize ?? measureWindow,
        publisher,
        allocate: shadow ? box.allocate : undefined,
        allocateCode,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        cursor: (/** @type {any} */ notice)=>cursors.push(notice),
        resolution: (/** @type {number} */ w, /** @type {number} */ h,
            /** @type {{ window?: number, fullscreen?: boolean } | undefined} */ where)=>
            resolutions.push([w, h, where?.window, where?.fullscreen]),
        now: ()=>clock.time,
    });
    const fields = createFields(box.services);

    const h = {
        box,
        clock,
        fields,
        publisher,
        roots,
        libraries,
        divergences,
        cursors,
        resolutions,
        /** The IDirect3D8 a program gets from the entry point. */
        create(){
            const pointer = libraries.libraries['D3D8.dll'].Direct3DCreate8.handler([32]);
            assert.notEqual(pointer, 0);
            return pointer;
        },
        /**
         * A device, made the way a program makes one.
         *
         * @param {number} root
         * @param {Record<string, number>} parameters
         */
        createDevice(root, parameters = {}){
            const at = 0x2000;
            box.services.writeMemory(at, new Uint8Array(D3DPRESENT_PARAMETERS8.SIZE));
            fields.writeStruct(at, D3DPRESENT_PARAMETERS8, {
                BackBufferWidth: 64,
                BackBufferHeight: 64,
                BackBufferFormat: D3DFMT.X8R8G8B8,
                BackBufferCount: 1,
                SwapEffect: 1,
                hDeviceWindow: HWND,
                Windowed: 1,
                ...parameters,
            });
            const hr = box.call(root, slot(IDIRECT3D8_SLOTS, 'CreateDevice'),
                [0, D3DDEVTYPE.HAL, HWND, BEHAVIOUR, at, 0x2100]);
            assert.equal(hr, D3D_OK);
            return box.memory.readU32(0x2100);
        },
        /**
         * A slot holding guest code is reached through the trap it falls
         * back to, which is the host's path of the method.
         *
         * @param {number} device @param {string} name @param {number[]} args
         */
        device: (device, name, args = [])=>(box.isGuest(device, slot(IDIRECT3DDEVICE8_SLOTS, name))
            ? box.trap(device, name, args)
            : box.call(device, slot(IDIRECT3DDEVICE8_SLOTS, name), args)),
        /** @param {number} surface @param {string} name @param {number[]} args */
        surface: (surface, name, args = [])=>
            box.call(surface, slot(IDIRECT3DSURFACE8_SLOTS, name), args),
        /** @param {number} texture @param {string} name @param {number[]} args */
        texture: (texture, name, args = [])=>
            box.call(texture, slot(IDIRECT3DTEXTURE8_SLOTS, name), args),
        /** @param {number} buffer @param {string} name @param {number[]} args */
        buffer: (buffer, name, args = [])=>box.trap(buffer, name, args),
        /** @param {number} pointer */
        release: pointer=>box.call(pointer, 2, []),
        /** @param {number} pointer */
        object: pointer=>publisher.objectAt(pointer),
    };
    return h;
}

test('the interrogation a program does before it draws is answered from facts', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);

    // The creation parameters are what CreateDevice was handed, field for
    // field: a device describing itself here would describe one the program
    // never asked for.
    const at = 0x3000;
    assert.equal(h.device(device, 'GetCreationParameters', [at]), D3D_OK);
    const read = h.fields.readStruct(at, D3DDEVICE_CREATION_PARAMETERS);
    assert.equal(read.AdapterOrdinal, 0);
    assert.equal(read.DeviceType, D3DDEVTYPE.HAL);
    assert.equal(read.hFocusWindow, HWND, 'the window the device was created against');
    assert.equal(read.BehaviorFlags, BEHAVIOUR);
    assert.equal(h.device(device, 'GetCreationParameters', [0]), D3DERR_INVALIDCALL);

    // A byte count rather than an HRESULT, which is the trap in this slot: zero
    // would read as success to a caller checking the sign.
    const memory = h.device(device, 'GetAvailableTextureMem');
    assert.ok(memory > 0, 'some texture memory is reported');
    assert.equal(h.device(device, 'ResourceManagerDiscardBytes', [1 << 20]), D3D_OK);

    // The raster runs on the display's clock: at the top of a frame both
    // fields read zero -- and both are written, so which of the two a program
    // reads does not matter -- and in the frame's last lines it is in the blank.
    const status = 0x3100;
    h.box.services.writeMemory(status, new Uint8Array([0xcd, 0xcd, 0xcd, 0xcd,
        0xcd, 0xcd, 0xcd, 0xcd]));
    assert.equal(h.device(device, 'GetRasterStatus', [status]), D3D_OK);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.InVBlank), 0);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.ScanLine), 0);
    h.clock.time = 1000 / REFRESH_HZ / 2;
    assert.equal(h.device(device, 'GetRasterStatus', [status]), D3D_OK);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.InVBlank), 0);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.ScanLine), 328,
        'half of a frame of 600 visible lines and 56 blank ones');
    h.clock.time = 1000 / REFRESH_HZ - 0.1;
    assert.equal(h.device(device, 'GetRasterStatus', [status]), D3D_OK);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.InVBlank), 1);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.ScanLine), 0,
        'no line is being drawn in the blank');

    // The display mode a device reports is the screen it was configured for.
    const mode = 0x3200;
    assert.equal(h.device(device, 'GetDisplayMode', [mode]), D3D_OK);
    assert.equal(h.fields.readU32(mode + D3DDISPLAYMODE.Width), SCREEN.width);
    // At the rate the enumerated modes carry: a program listing the rates of
    // a size and selecting the current one finds it in its own list.
    assert.equal(h.fields.readU32(mode + D3DDISPLAYMODE.RefreshRate), REFRESH_HZ);

    assert.equal(h.release(device), 0, 'the device let go of everything it held');
    // And its pointer stops resolving. This used to assert the count through
    // the pointer, which only worked because every object ever published was
    // held for the life of the process -- the leak, not the contract. The
    // release above is what says the count reached zero.
    assert.equal(h.object(device), null);
    h.release(root);
    assert.equal(h.roots[0].refCount, 0);
});

test('the adapter says who made it, in the shape a card database reads', ()=>{
    // A program looks its adapter up before deciding how much to ask of it,
    // and one refused the answer settles for the most cautious hardware it
    // knows. So the answer exists, the strings are terminated, the vendor is
    // the PCI id for the word WebGPU used, and the fields around them are
    // laid where the header puts them.
    const h = seamed();
    const root = h.create();
    /** @param {string} name @param {number[]} args */
    const ask = (name, args)=>h.box.call(root, slot(IDIRECT3D8_SLOTS, name), args);
    const out = 0x1400;
    h.box.services.writeMemory(out, new Uint8Array(D3DADAPTER_IDENTIFIER8.SIZE + 4).fill(0xcd));

    assert.equal(ask('GetAdapterIdentifier', [0, 0, out]), D3D_OK);
    /** @param {number} at */
    const text = at=>{
        const bytes = h.box.services.readMemory(out + at, 512);
        const end = bytes.indexOf(0);
        return String.fromCharCode(...bytes.subarray(0, end < 0 ? 512 : end));
    };
    assert.equal(text(D3DADAPTER_IDENTIFIER8.Description), 'Bottlify WebGPU Video Adapter');
    assert.equal(text(D3DADAPTER_IDENTIFIER8.Driver), 'webgpu');
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.VendorId), 0x10de);
    // The answer every generation gives, DirectDraw's GetDeviceIdentifier
    // included: a program asking through two compares them.
    const shared = describeAdapter({ vendor: 'nvidia', architecture: 'ampere' });
    assert.equal(text(D3DADAPTER_IDENTIFIER8.Description), shared.description);
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.VendorId), shared.vendorId);
    assert.deepEqual([...h.box.services.readMemory(out + D3DADAPTER_IDENTIFIER8.DeviceIdentifier,
        16)], [...ADAPTER_GUID]);
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.DeviceId), 0);
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.WHQLLevel), 1);
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.DriverVersion + 4), 0x00010000);
    // The fields are written and the padding after them is not: a program
    // built with the structure packed keeps its stack cookie there.
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.FIELDS), 0xcdcdcdcd);

    // The flag that skips the certification lookup answers zero for it.
    assert.equal(ask('GetAdapterIdentifier', [0, 2, out]), D3D_OK);
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.WHQLLevel), 0);

    assert.equal(ask('GetAdapterIdentifier', [1, 0, out]), D3DERR_INVALIDCALL,
        'there is one adapter');
    assert.equal(ask('GetAdapterIdentifier', [0, 0, 0]), D3DERR_INVALIDCALL,
        'and nowhere to write is refused, not written');
    h.release(root);
});

test('the adapter answers what it can make, from the tables that make it', ()=>{
    const h = seamed();
    const root = h.create();
    /** @param {string} name @param {number[]} args */
    const ask = (name, args)=>h.box.call(root, slot(IDIRECT3D8_SLOTS, name), args);

    assert.equal(ask('GetAdapterCount', []), 1);
    // Every size of the era whatever the display, at both rates, in 32-bit
    // colour and then 16-bit, and a program builds its menu from them.
    const count = ask('GetAdapterModeCount', [0]);
    assert.equal(count, 26 * 2 * 2);

    const mode = 0x1200;
    const seen = [];
    for (let index = 0; index < count; index++)
    {
        assert.equal(ask('EnumAdapterModes', [0, index, mode]), D3D_OK);
        seen.push(`${h.fields.readU32(mode + D3DDISPLAYMODE.Width)}x${
            h.fields.readU32(mode + D3DDISPLAYMODE.Height)}@${
            h.fields.readU32(mode + D3DDISPLAYMODE.RefreshRate)}/${
            h.fields.readU32(mode + D3DDISPLAYMODE.Format)}`);
    }
    const sizes = [
        '640x480', '800x600', '1024x768', '1152x864', '1280x720', '1280x800',
        '1280x832', '1280x960', '1280x1024', '1400x1050', '1440x900', '1512x982',
        '1600x900', '1600x1200', '1680x1050', '1728x1117', '1920x1080', '1920x1200',
        '1920x1440', '2048x1536', '2560x1440', '2560x1600', '2560x1664', '2880x1800',
        '3024x1964', '3456x2234',
    ];
    assert.deepEqual(seen, [22, 23].flatMap(format=>
        sizes.flatMap(size=>[`${size}@60/${format}`, `${size}@120/${format}`])),
    'every size at both rates, smallest first, every 32-bit mode before the first 16-bit one');
    assert.equal(ask('EnumAdapterModes', [0, count, mode]), D3DERR_INVALIDCALL,
        'and the index past the end is refused, so a walk ends');

    assert.equal(ask('CheckDeviceType',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, D3DFMT.X8R8G8B8, 1]), D3D_OK);
    assert.equal(ask('CheckDeviceType', [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, D3DFMT.D16, 1]),
        D3DERR_NOTAVAILABLE, 'a depth format is not a back buffer');

    // A texture format that can be created reads as available, and one that
    // cannot reads as unavailable -- the same table answers both questions.
    const texture = 3;
    assert.equal(ask('CheckDeviceFormat',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 0, texture, D3DFMT.A8R8G8B8]), D3D_OK);
    assert.equal(ask('CheckDeviceFormat',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 0, texture, D3DFMT.UNKNOWN]), D3DERR_NOTAVAILABLE);
    const cubeTexture = 5;
    assert.equal(ask('CheckDeviceFormat',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 0, cubeTexture, D3DFMT.A8R8G8B8]), D3D_OK);
    const volumeTexture = 4;
    assert.equal(ask('CheckDeviceFormat',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 0, volumeTexture, D3DFMT.A8R8G8B8]), D3D_OK);
    assert.equal(ask('CheckDeviceFormat',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 0, volumeTexture, D3DFMT.DXT1]),
    D3DERR_NOTAVAILABLE, 'a volume is never made in blocks');
    const vertexBuffer = 6;
    assert.equal(ask('CheckDeviceFormat',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 0, vertexBuffer, D3DFMT.A8R8G8B8]),
    D3DERR_NOTAVAILABLE, 'and a kind of resource that has no format is never available');

    assert.equal(ask('CheckDeviceMultiSampleType',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 1, 0]), D3D_OK, 'one sample per pixel');
    assert.equal(ask('CheckDeviceMultiSampleType',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 1, 2]), D3DERR_NOTAVAILABLE);

    assert.equal(ask('CheckDepthStencilMatch',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, D3DFMT.X8R8G8B8, D3DFMT.D24S8]), D3D_OK);
    assert.equal(ask('CheckDepthStencilMatch',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, D3DFMT.X8R8G8B8, D3DFMT.A8R8G8B8]),
    D3DERR_NOTAVAILABLE);

    // An HMONITOR, not an HRESULT: the one user32 names for every window, so
    // it goes straight into GetMonitorInfo (Wine's d3d8 device.c requires
    // !!monitor). An adapter that does not exist has none.
    const user32 = createSystemFunctions({ host: {}, live: ()=>null, windows: new Map(),
        classes: new Map() });
    assert.equal(ask('GetAdapterMonitor', [0]), user32.MonitorFromWindow.handler());
    assert.notEqual(ask('GetAdapterMonitor', [0]), 0);
    assert.equal(ask('GetAdapterMonitor', [1]), 0);
    // No software rasteriser is ever plugged in, and Direct3D 9 answers the
    // same call with success.
    assert.equal(ask('RegisterSoftwareDevice', [0x1234]), D3D_OK);

    h.release(root);
    assert.equal(h.roots[0].refCount, 0);
});

test('GetDirect3D answers the object the device was made through', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);

    const out = 0x3300;
    assert.equal(h.device(device, 'GetDirect3D', [out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), root,
        'the same object, so the same pointer -- a program compares these');
    assert.equal(h.roots[0].refCount, 3,
        'the device holds one on it, and the call took the reference it owes');
    assert.equal(h.device(device, 'GetDirect3D', [0]), D3DERR_INVALIDCALL);

    assert.equal(h.release(device), 0);
    assert.equal(h.release(root), 1, 'the reference GetDirect3D took is still held');
    assert.equal(h.release(root), 0);
});

test('a gamma ramp is three channels of words, and comes back as it went in', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const at = 0x4000;

    // Before anything is set: each entry stands for itself, widened from eight
    // bits to sixteen, so the last one is the largest value rather than one
    // short of it.
    assert.equal(h.device(device, 'GetGammaRamp', [at]), 0, 'the call is declared void');
    const wordAt = (/** @type {number} */ offset)=>{
        const bytes = h.box.services.readMemory(at + offset, 2);
        return bytes[0] | bytes[1] << 8;
    };
    assert.equal(wordAt(D3DGAMMARAMP.red), 0);
    assert.equal(wordAt(D3DGAMMARAMP.red + 2), 257);
    assert.equal(wordAt(D3DGAMMARAMP.blue + (GAMMA_RAMP_ENTRIES - 1) * 2), 65535);

    // Set a ramp whose three channels differ, so a channel written to the wrong
    // third of the block cannot pass.
    const written = new Uint16Array(GAMMA_RAMP_ENTRIES * 3);
    for (let index = 0; index < GAMMA_RAMP_ENTRIES; index++)
    {
        written[index] = index;
        written[GAMMA_RAMP_ENTRIES + index] = index * 2;
        written[GAMMA_RAMP_ENTRIES * 2 + index] = index * 3;
    }
    const source = 0x5000;
    h.box.services.writeMemory(source, new Uint8Array(written.buffer));
    assert.equal(h.device(device, 'SetGammaRamp', [0, source]), 0);

    h.box.services.writeMemory(at, new Uint8Array(D3DGAMMARAMP.SIZE));
    h.device(device, 'GetGammaRamp', [at]);
    assert.deepEqual([...h.box.services.readMemory(at, D3DGAMMARAMP.SIZE)],
        [...new Uint8Array(written.buffer)]);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a call given nothing to act on is refused, and GetInfo reports nothing', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);

    // A cursor with no surface, a front buffer copy into a pointer that names
    // no surface, vertices processed into no buffer.
    assert.equal(h.device(device, 'SetCursorProperties', [0, 0, 0]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'ShowCursor', [1]), 0, 'no cursor was showing before');
    assert.equal(h.device(device, 'SetCursorPosition', [10, 20, 0]), 0);
    assert.equal(h.device(device, 'GetFrontBuffer', [0x6100]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'ProcessVertices', [0, 0, 3, 0, 0]), D3DERR_INVALIDCALL);

    // GetInfo succeeded and reported nothing, which is what a program checks
    // for before reading the structure it passed.
    assert.equal(h.device(device, 'GetInfo', [1, 0x6100, 16]), S_FALSE);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a vertex shader is made from guest memory and hands its tokens back as they were', ()=>{
    // Wine's d3d8 test_shader, through the ABI: a size asked for with no
    // buffer, a buffer too small refused with the size left alone, and the
    // tokens as the program gave them.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const declaration = [0x20000000, 0x40020000, 0xffffffff];
    const shader = [
        0xfffe0101,
        0x0002fffe, 0x0000ffff, 0xffffffff,        // a comment holding an end token
        0x00000009, 0xc0010000, 0x90e40000, 0xa0e40000,
        0x00000009, 0xc0020000, 0x90e40000, 0xa0e40001,
        0x00000009, 0xc0040000, 0x90e40000, 0xa0e40002,
        0x00000009, 0xc0080000, 0x90e40000, 0xa0e40003,
        0x0000ffff,
    ];
    /** @param {number} at @param {number[]} tokens */
    const write = (at, tokens)=>h.box.services.writeMemory(at,
        new Uint8Array(Uint32Array.from(tokens).buffer));
    /** @param {number} at @param {number} count */
    const read = (at, count)=>Array.from({ length: count }, (_, i)=>h.fields.readU32(at + i * 4));
    write(0x7000, [...declaration, 0xdeadbeef]);
    write(0x7100, [...shader, 0xdeadbeef]);
    const out = 0x7400;
    const size = 0x7404;
    const data = 0x7500;

    assert.equal(h.device(device, 'CreateVertexShader', [0x7000, 0x7100, out, 0]), D3D_OK);
    const made = h.fields.readU32(out);
    assert.equal(made & 1, 1, 'a handle, which no vertex format is');
    assert.equal(h.device(device, 'GetVertexShader', [out]), D3D_OK);
    assert.equal(h.fields.readU32(out), 0, 'made, not set');

    for (const [name, tokens] of /** @type {[string, number[]][]} */ ([
        ['GetVertexShaderDeclaration', declaration], ['GetVertexShaderFunction', shader]]))
    {
        assert.equal(h.device(device, name, [made, 0, size]), D3D_OK);
        assert.equal(h.fields.readU32(size), tokens.length * 4, `${name}: the size alone`);
        h.fields.writeU32(size, 1);
        assert.equal(h.device(device, name, [made, data, size]), D3DERR_INVALIDCALL);
        assert.equal(h.fields.readU32(size), 1, `${name}: the size left as the caller wrote it`);
        h.fields.writeU32(size, 1024);
        assert.equal(h.device(device, name, [made, data, size]), D3D_OK);
        assert.equal(h.fields.readU32(size), tokens.length * 4);
        assert.deepEqual(read(data, tokens.length), tokens);
        assert.equal(h.device(device, name, [made, data, 0]), D3DERR_INVALIDCALL,
            `${name}: nowhere to say the size`);
    }

    // Constants, four floats a register, and none past the last.
    const floats = 0x7600;
    [1.5, 2.5, 3.5, 4.5].forEach((value, i)=>h.fields.writeF32(floats + i * 4, value));
    assert.equal(h.device(device, 'SetVertexShaderConstant', [7, floats, 1]), D3D_OK);
    assert.equal(h.device(device, 'GetVertexShaderConstant', [7, data, 1]), D3D_OK);
    assert.deepEqual([0, 1, 2, 3].map(i=>h.fields.readF32(data + i * 4)), [1.5, 2.5, 3.5, 4.5]);
    assert.equal(h.device(device, 'SetVertexShaderConstant', [255, floats, 2]),
        D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'SetVertexShaderConstant', [0, floats, 0x10000000]),
        D3DERR_INVALIDCALL, 'a count past the file is refused without reading it');
    assert.equal(h.device(device, 'SetVertexShaderConstant', [0, 0, 1]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'GetVertexShaderConstant', [0, 0, 1]), D3DERR_INVALIDCALL);

    // What is not a shader.
    assert.equal(h.device(device, 'CreateVertexShader', [0, 0x7100, out, 0]),
        D3DERR_INVALIDCALL, 'no declaration');
    assert.equal(h.device(device, 'CreateVertexShader', [0x7000, 0x7100, 0, 0]),
        D3DERR_INVALIDCALL, 'nowhere to put the handle');
    write(0x7100, [0xfffe0200, 0x0000ffff]);
    assert.equal(h.device(device, 'CreateVertexShader', [0x7000, 0x7100, out, 0]),
        D3DERR_INVALIDCALL, 'a vs_2_0, past the version the caps claim');
    assert.equal(h.device(device, 'CreatePixelShader', [0x7100, out]), D3DERR_INVALIDCALL,
        'a vertex shader is not a pixel shader');

    assert.equal(h.device(device, 'DeleteVertexShader', [made]), D3D_OK);
    assert.equal(h.device(device, 'DeleteVertexShader', [made]), D3DERR_INVALIDCALL,
        'and a handle deleted is gone');

    // D3DFVF_XYZ | D3DFVF_DIFFUSE: a vertex format, which shares this slot with
    // a shader handle.
    const fvf = 0x002 | 0x040;
    assert.equal(h.device(device, 'SetVertexShader', [fvf]), D3D_OK);
    assert.equal(h.device(device, 'GetVertexShader', [out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), fvf, 'read back exactly as it was written');
    assert.equal(h.device(device, 'SetPixelShader', [0]), D3D_OK, 'binding no pixel shader');
    assert.equal(h.device(device, 'GetPixelShader', [out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), 0);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a pixel shader is made from guest memory, and its constants and function read back', ()=>{
    // Wine's d3d8 test_shader, through the ABI.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const shader = [
        0xffff0101,
        0x00000051, 0xa00f0001, 0x3f800000, 0x00000000, 0x00000000, 0x00000000,
        0x00000042, 0xb00f0000,
        0x00000008, 0x800f0000, 0xa0e40001, 0xa0e40000,
        0x00000005, 0x800f0000, 0x90e40000, 0x80e40000,
        0x00000005, 0x800f0000, 0xb0e40000, 0x80e40000,
        0x0000ffff,
    ];
    h.box.services.writeMemory(0x7100,
        new Uint8Array(Uint32Array.from([...shader, 0xdeadbeef]).buffer));
    const out = 0x7400;
    const size = 0x7404;
    const data = 0x7500;
    assert.equal(h.device(device, 'CreatePixelShader', [0x7100, out]), D3D_OK);
    const made = h.fields.readU32(out);
    assert.equal(h.device(device, 'CreatePixelShader', [0, out]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'CreatePixelShader', [0x7100, 0]), D3DERR_INVALIDCALL);

    assert.equal(h.device(device, 'GetPixelShaderFunction', [made, 0, size]), D3D_OK);
    assert.equal(h.fields.readU32(size), shader.length * 4);
    h.fields.writeU32(size, 1);
    assert.equal(h.device(device, 'GetPixelShaderFunction', [made, data, size]),
        D3DERR_INVALIDCALL);
    assert.equal(h.fields.readU32(size), 1, 'left as the caller wrote it');
    h.fields.writeU32(size, 1024);
    assert.equal(h.device(device, 'GetPixelShaderFunction', [made, data, size]), D3D_OK);
    assert.deepEqual(Array.from({ length: shader.length }, (_, i)=>h.fields.readU32(data + i * 4)),
        shader);

    const floats = 0x7600;
    [0.25, 0.5, 0.75, 1].forEach((value, i)=>h.fields.writeF32(floats + i * 4, value));
    assert.equal(h.device(device, 'SetPixelShaderConstant', [7, floats, 1]), D3D_OK);
    assert.equal(h.device(device, 'GetPixelShaderConstant', [7, data, 1]), D3D_OK);
    assert.deepEqual([0, 1, 2, 3].map(i=>h.fields.readF32(data + i * 4)), [0.25, 0.5, 0.75, 1]);
    assert.equal(h.device(device, 'SetPixelShaderConstant', [7, floats, 2]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'SetPixelShaderConstant', [0, floats, 0x10000000]),
        D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'GetPixelShaderConstant', [0, 0, 1]), D3DERR_INVALIDCALL);

    assert.equal(h.device(device, 'SetPixelShader', [made]), D3D_OK);
    assert.equal(h.device(device, 'GetPixelShader', [out]), D3D_OK);
    assert.equal(h.fields.readU32(out), made);
    assert.equal(h.device(device, 'DeletePixelShader', [made]), D3D_OK);
    assert.equal(h.device(device, 'GetPixelShader', [out]), D3D_OK);
    assert.equal(h.fields.readU32(out), 0);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a getter answers a structure as one write of every byte of it', ()=>{
    const h = seamed();
    const device = h.createDevice(h.create());
    /**
     * The structure a setter took, as bytes: what the getter must hand back,
     * byte for byte.
     *
     * @param {number} at @param {number[]} words
     */
    const put = (at, words)=>{
        const bytes = new Uint8Array(new Uint32Array(words).buffer);
        h.box.services.writeMemory(at, bytes);
        return bytes;
    };
    const f = (/** @type {number} */ value)=>floatToDword(value);
    const matrix = put(0x8000, Array.from({ length: 16 }, (unused, i)=>f(i * 0.5 - 3)));
    assert.equal(h.device(device, 'SetTransform', [D3DTS.WORLD, 0x8000]), D3D_OK);
    const material = put(0x8100, Array.from({ length: 17 }, (unused, i)=>f(i / 8)));
    assert.equal(h.device(device, 'SetMaterial', [0x8100]), D3D_OK);
    const light = put(0x8200, [3, ...Array.from({ length: 25 }, (unused, i)=>f(i + 0.25))]);
    assert.equal(h.device(device, 'SetLight', [2, 0x8200]), D3D_OK);
    const plane = put(0x8300, [f(1), f(-2), f(3), f(-4)]);
    assert.equal(h.device(device, 'SetClipPlane', [1, 0x8300]), D3D_OK);
    const viewport = put(0x8400, [2, 4, 32, 16, f(0.25), f(0.75)]);
    assert.equal(h.device(device, 'SetViewport', [0x8400]), D3D_OK);

    const writeMemory = h.box.services.writeMemory;
    /** @type {[number, number][]} */
    const writes = [];
    h.box.services.writeMemory = (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>{
        writes.push([at, bytes.length]);
        writeMemory(at, bytes);
    };
    /** @type {[string, number[], Uint8Array][]} */
    const getters = [
        ['GetTransform', [D3DTS.WORLD], matrix],
        ['GetMaterial', [], material],
        ['GetLight', [2], light],
        ['GetClipPlane', [1], plane],
        ['GetViewport', [], viewport],
    ];
    for (const [name, args, expected] of getters)
    {
        const out = 0x9000;
        writeMemory(out, new Uint8Array(expected.length).fill(0xcd));
        writes.length = 0;
        assert.equal(h.device(device, name, [...args, out]), D3D_OK);
        assert.deepEqual(writes, [[out, expected.length]], `${name}: one write, the whole answer`);
        assert.deepEqual(h.box.memory.readBytes(out, expected.length), expected,
            `${name}: the bytes the setter took`);
    }
    h.box.services.writeMemory = writeMemory;
});

test('state a program reads back is written at the offsets it reads', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);

    // A transform, written as sixteen floats and multiplied by another.
    const matrix = 0x8000;
    for (let index = 0; index < 16; index++)
    {
        h.fields.writeF32(matrix + index * 4, index % 5 === 0 ? 2 : 0);
    }
    assert.equal(h.device(device, 'SetTransform', [D3DTS.VIEW, matrix]), D3D_OK);
    const back = 0x8100;
    assert.equal(h.device(device, 'GetTransform', [D3DTS.VIEW, back]), D3D_OK);
    assert.equal(h.fields.readF32(back), 2);
    assert.equal(h.fields.readF32(back + 4), 0);
    assert.equal(h.device(device, 'MultiplyTransform', [D3DTS.VIEW, matrix]), D3D_OK);
    assert.equal(h.device(device, 'GetTransform', [D3DTS.VIEW, back]), D3D_OK);
    assert.equal(h.fields.readF32(back), 4, 'twice by twice');
    assert.equal(h.device(device, 'GetTransform', [D3DTS.VIEW, 0]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'MultiplyTransform', [D3DTS.VIEW, 0]), D3DERR_INVALIDCALL);

    // A material: four colours of four floats and a power, in that order.
    const material = 0x8200;
    for (let index = 0; index < 17; index++)
    {
        h.fields.writeF32(material + index * 4, index / 16);
    }
    assert.equal(h.device(device, 'SetMaterial', [material]), D3D_OK);
    const read = 0x8300;
    assert.equal(h.device(device, 'GetMaterial', [read]), D3D_OK);
    for (let index = 0; index < 17; index++)
    {
        assert.equal(h.fields.readF32(read + index * 4), index / 16, `float ${index}`);
    }

    // A light, whose fields are three colours, two vectors and seven floats.
    const light = 0x8400;
    h.box.services.writeMemory(light, new Uint8Array(D3DLIGHT7.SIZE));
    h.fields.writeU32(light + D3DLIGHT7.dltType, 3);
    h.fields.writeF32(light + D3DLIGHT7.dcvDiffuse, 0.25);
    h.fields.writeF32(light + D3DLIGHT7.dvDirection + 8, 1);
    h.fields.writeF32(light + D3DLIGHT7.dvPhi, 0.75);
    assert.equal(h.device(device, 'SetLight', [0, light]), D3D_OK);
    const lightBack = 0x8500;
    assert.equal(h.device(device, 'GetLight', [0, lightBack]), D3D_OK);
    assert.equal(h.fields.readU32(lightBack + D3DLIGHT7.dltType), 3);
    assert.equal(h.fields.readF32(lightBack + D3DLIGHT7.dcvDiffuse), 0.25);
    assert.equal(h.fields.readF32(lightBack + D3DLIGHT7.dvDirection + 8), 1,
        'the z of the direction, which is the field a transcription slip moves');
    assert.equal(h.fields.readF32(lightBack + D3DLIGHT7.dvPhi), 0.75);
    assert.equal(h.device(device, 'SetLight', [0, 0]), D3DERR_INVALIDCALL);

    // A light never written has nothing to read back, and enabling one brings
    // it into existence.
    assert.equal(h.device(device, 'GetLight', [7, lightBack]), D3DERR_INVALIDCALL);
    const enabled = 0x8600;
    assert.equal(h.device(device, 'LightEnable', [7, 1]), D3D_OK);
    assert.equal(h.device(device, 'GetLightEnable', [7, enabled]), D3D_OK);
    assert.notEqual(h.box.memory.readU32(enabled), 0, 'a value a program compares against zero');

    // A clip plane is four floats; the status is two dwords, and D3D8 spells it
    // as neither of D3D7's six extents.
    const plane = 0x8700;
    for (let index = 0; index < 4; index++)
    {
        h.fields.writeF32(plane + index * 4, index + 1);
    }
    assert.equal(h.device(device, 'SetClipPlane', [2, plane]), D3D_OK);
    const planeBack = 0x8800;
    assert.equal(h.device(device, 'GetClipPlane', [2, planeBack]), D3D_OK);
    assert.equal(h.fields.readF32(planeBack + 12), 4);
    assert.equal(h.device(device, 'GetClipPlane', [3, planeBack]), D3D_OK);
    assert.equal(h.fields.readF32(planeBack), 0, 'a plane never written is no plane');
    assert.equal(h.device(device, 'SetClipPlane', [32, plane]), D3DERR_INVALIDCALL);

    const status = 0x8900;
    h.fields.writeStruct(status, D3DCLIPSTATUS8, { ClipUnion: 5, ClipIntersection: 9 });
    assert.equal(h.device(device, 'SetClipStatus', [status]), D3D_OK);
    const statusBack = 0x8a00;
    assert.equal(h.device(device, 'GetClipStatus', [statusBack]), D3D_OK);
    assert.deepEqual(h.fields.readStruct(statusBack, D3DCLIPSTATUS8),
        { ClipUnion: 5, ClipIntersection: 9 });
    assert.equal(h.device(device, 'SetClipStatus', [0]), D3DERR_INVALIDCALL);

    // One pass, which is what this renderer takes for any state it accepts.
    const passes = 0x8b00;
    assert.equal(h.device(device, 'ValidateDevice', [passes]), D3D_OK);
    assert.equal(h.box.memory.readU32(passes), 1);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a state block records what was set and puts it back', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0x9000;
    const value = 0x9100;

    // D3DRS_CULLMODE is 22 and D3DRS_SHADEMODE is 9.
    const cull = 22;
    const shade = 9;
    assert.equal(h.device(device, 'EndStateBlock', [out]), D3DERR_INVALIDCALL,
        'nothing is being recorded');
    assert.equal(h.device(device, 'BeginStateBlock'), D3D_OK);
    assert.equal(h.device(device, 'BeginStateBlock'), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'SetRenderState', [cull, 1]), D3D_OK);
    assert.equal(h.device(device, 'SetTextureStageState', [0, D3DTSS.COLORARG1, 3]), D3D_OK);
    assert.equal(h.device(device, 'EndStateBlock', [out]), D3D_OK);
    const block = h.box.memory.readU32(out);

    assert.equal(h.device(device, 'SetRenderState', [cull, 2]), D3D_OK);
    assert.equal(h.device(device, 'SetRenderState', [shade, 2]), D3D_OK);
    assert.equal(h.device(device, 'SetTextureStageState', [0, D3DTSS.COLORARG1, 0]), D3D_OK);
    assert.equal(h.device(device, 'ApplyStateBlock', [block]), D3D_OK);
    assert.equal(h.device(device, 'GetRenderState', [cull, value]), D3D_OK);
    assert.equal(h.box.memory.readU32(value), 1, 'the recorded state came back');
    assert.equal(h.device(device, 'GetRenderState', [shade, value]), D3D_OK);
    assert.equal(h.box.memory.readU32(value), 2, 'a state outside the block was left alone');
    assert.equal(h.device(device, 'GetTextureStageState', [0, D3DTSS.COLORARG1, value]), D3D_OK);
    assert.equal(h.box.memory.readU32(value), 3);

    // A capture takes the values of the moment for the states the block already
    // holds, and no others.
    assert.equal(h.device(device, 'SetRenderState', [cull, 3]), D3D_OK);
    assert.equal(h.device(device, 'CaptureStateBlock', [block]), D3D_OK);
    assert.equal(h.device(device, 'SetRenderState', [cull, 1]), D3D_OK);
    assert.equal(h.device(device, 'ApplyStateBlock', [block]), D3D_OK);
    assert.equal(h.device(device, 'GetRenderState', [cull, value]), D3D_OK);
    assert.equal(h.box.memory.readU32(value), 3);

    assert.equal(h.device(device, 'DeleteStateBlock', [block]), D3D_OK);
    assert.equal(h.device(device, 'DeleteStateBlock', [block]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'ApplyStateBlock', [block]), D3DERR_INVALIDCALL);

    // A block made rather than recorded holds everything of its kind.
    assert.equal(h.device(device, 'CreateStateBlock', [D3DSBT.ALL, out]), D3D_OK);
    const all = h.box.memory.readU32(out);
    assert.equal(h.device(device, 'SetRenderState', [shade, 1]), D3D_OK);
    assert.equal(h.device(device, 'ApplyStateBlock', [all]), D3D_OK);
    assert.equal(h.device(device, 'GetRenderState', [shade, value]), D3D_OK);
    assert.equal(h.box.memory.readU32(value), 2, 'everything as it stood when the block was made');
    assert.equal(h.device(device, 'CreateStateBlock', [9, out]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'CreateStateBlock', [D3DSBT.ALL, 0]), D3DERR_INVALIDCALL);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a lock that settles later still writes the locked rectangle, and the caller waits',
    async()=>{
        // A render target's lock reads the GPU back first and answers with a
        // promise; the bridge suspends the caller on it, and the
        // D3DLOCKED_RECT is written when it settles.
        const h = seamed();
        const root = h.create();
        const device = h.createDevice(root);
        const back = 0xa100;
        assert.equal(h.device(device, 'GetBackBuffer', [0, 0, back]), D3D_OK);
        const pointer = h.box.memory.readU32(back);
        const surface = h.publisher.objectAt(pointer);
        surface.LockRect = (/** @type {any} */ locked)=>{
            locked.Pitch = 256;
            locked.pBits = 0x12340;
            return Promise.resolve(D3D_OK);
        };
        const locked = 0xa200;
        const answer = h.box.callRaw(pointer, slot(IDIRECT3DSURFACE8_SLOTS, 'LockRect'),
            [locked, 0, 0]);
        assert.ok(answer instanceof Promise, 'the slot hands the promise on');
        assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.pBits), 0, 'nothing yet');
        assert.equal(await answer, D3D_OK);
        assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.Pitch), 256);
        assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.pBits), 0x12340);
    });

test('the surfaces a device already has are one object, however they are reached', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root, { EnableAutoDepthStencil: 1,
        AutoDepthStencilFormat: D3DFMT.D24S8 });

    const target = 0xa000;
    const back = 0xa100;
    assert.equal(h.device(device, 'GetRenderTarget', [target]), D3D_OK);
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, back]), D3D_OK);
    assert.equal(h.box.memory.readU32(target), h.box.memory.readU32(back),
        'the render target and back buffer zero are the same surface');

    // Two references on one implicit surface, and each of them is one on the
    // device: that is what makes a program that forgets one unable to Reset.
    const surface = h.box.memory.readU32(target);
    assert.equal(h.object(surface).refCount, 2);

    const depth = 0xa200;
    assert.equal(h.device(device, 'GetDepthStencilSurface', [depth]), D3D_OK);
    const stencil = h.box.memory.readU32(depth);
    assert.notEqual(stencil, surface);

    // A description read at the offsets a program reads it at.
    const desc = 0xa300;
    assert.equal(h.surface(surface, 'GetDesc', [desc]), D3D_OK);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Width), 64);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Format), D3DFMT.X8R8G8B8);

    assert.equal(h.release(surface), 1);
    assert.equal(h.release(surface), 0);
    assert.equal(h.release(stencil), 0);
    assert.equal(h.release(device), 0);
    assert.equal(h.object(device), null);
    h.release(root);
});

test('a render target and a depth stencil are made, bound and let go', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);

    const out = 0xb000;
    // The fourth argument is the multisample type, which this device renders
    // one sample per pixel whatever it is asked for.
    assert.equal(h.device(device, 'CreateRenderTarget',
        [32, 32, D3DFMT.A8R8G8B8, 0, 1, out]), D3D_OK);
    const target = h.box.memory.readU32(out);
    assert.notEqual(target, 0);
    assert.equal(h.device(device, 'CreateDepthStencilSurface',
        [32, 32, D3DFMT.D16, 0, out]), D3D_OK);
    const depth = h.box.memory.readU32(out);

    assert.equal(h.device(device, 'SetRenderTarget', [target, depth]), D3D_OK);
    const read = 0xb100;
    assert.equal(h.device(device, 'GetRenderTarget', [read]), D3D_OK);
    assert.equal(h.box.memory.readU32(read), target, 'the surface that was bound');
    assert.equal(h.object(target).refCount, 2, 'binding took nothing; the read took one');

    // A lockable render target answers an address in the guest's own memory.
    const locked = 0xb200;
    assert.equal(h.surface(target, 'LockRect', [locked, 0, 0]), D3D_OK);
    assert.notEqual(h.fields.readU32(locked + D3DLOCKED_RECT.pBits), 0);
    assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.Pitch), 32 * 4);
    assert.equal(h.surface(target, 'UnlockRect'), D3D_OK);

    // Put the device's own back, so the two made here are the only things left.
    const original = 0xb300;
    h.device(device, 'GetBackBuffer', [0, 0, original]);
    assert.equal(h.device(device, 'SetRenderTarget', [h.box.memory.readU32(original), 0]), D3D_OK);
    h.release(h.box.memory.readU32(original));

    assert.equal(h.release(target), 1);
    assert.equal(h.release(target), 0);
    assert.equal(h.release(depth), 0);
    assert.equal(h.release(device), 0);
    assert.equal(h.object(device), null);
    h.release(root);
});

test('a copy between surfaces moves the bytes the device named', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0xc000;

    /** @param {number} width @param {number} height */
    const imageSurface = (width, height)=>{
        assert.equal(h.device(device, 'CreateImageSurface',
            [width, height, D3DFMT.A8R8G8B8, out]), D3D_OK);
        return h.box.memory.readU32(out);
    };
    const source = imageSurface(4, 4);
    const destination = imageSurface(4, 4);

    /** @param {number} surface */
    const addressOf = surface=>{
        const locked = 0xc100;
        assert.equal(h.surface(surface, 'LockRect', [locked, 0, 0]), D3D_OK);
        assert.equal(h.surface(surface, 'UnlockRect'), D3D_OK);
        return h.fields.readU32(locked + D3DLOCKED_RECT.pBits);
    };
    const from = addressOf(source);
    const to = addressOf(destination);
    h.box.services.writeMemory(from, Uint8Array.from({ length: 64 }, (_, index)=>index + 1));
    h.box.services.writeMemory(to, new Uint8Array(64));

    // The whole surface, which is what no rectangles means.
    assert.equal(h.device(device, 'CopyRects', [source, 0, 0, destination, 0]), D3D_OK);
    assert.deepEqual([...h.box.services.readMemory(to, 64)],
        [...h.box.services.readMemory(from, 64)]);

    // One rectangle, landing where the point says: the second row of the source
    // becomes the first row of the destination, and nothing else moves.
    h.box.services.writeMemory(to, new Uint8Array(64));
    const rect = 0xc200;
    const point = 0xc300;
    h.fields.writeStruct(rect, RECT, { left: 0, top: 1, right: 4, bottom: 2 });
    h.fields.writeStruct(point, POINT, { x: 0, y: 0 });
    assert.equal(h.device(device, 'CopyRects', [source, rect, 1, destination, point]), D3D_OK);
    assert.deepEqual([...h.box.services.readMemory(to, 16)],
        [...h.box.services.readMemory(from + 16, 16)]);
    assert.deepEqual([...h.box.services.readMemory(to + 16, 16)], new Array(16).fill(0),
        'and the row below it was not touched');

    // A rectangle that leaves the surface is refused, and nothing moves.
    h.fields.writeStruct(rect, RECT, { left: 0, top: 0, right: 8, bottom: 1 });
    assert.equal(h.device(device, 'CopyRects', [source, rect, 1, destination, point]),
        D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'CopyRects', [0, 0, 0, destination, 0]), D3DERR_INVALIDCALL);

    assert.equal(h.release(source), 0);
    assert.equal(h.release(destination), 0);
    assert.equal(h.release(device), 0);
    assert.equal(h.object(device), null);
    h.release(root);
});

test('UpdateTexture carries a system-memory texture into the one that draws', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0xd000;

    /** @param {number} pool */
    const texture = pool=>{
        assert.equal(h.device(device, 'CreateTexture',
            [4, 4, 1, 0, D3DFMT.A8R8G8B8, pool, out]), D3D_OK);
        return h.box.memory.readU32(out);
    };
    const source = texture(D3DPOOL.SYSTEMMEM);
    const destination = texture(D3DPOOL.MANAGED);

    assert.equal(h.texture(source, 'GetLevelCount'), 1);
    const desc = 0xd100;
    assert.equal(h.texture(source, 'GetLevelDesc', [0, desc]), D3D_OK);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Width), 4);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Pool), D3DPOOL.SYSTEMMEM);

    /** @param {number} handle */
    const addressOf = handle=>{
        const locked = 0xd200;
        assert.equal(h.texture(handle, 'LockRect', [0, locked, 0, 0]), D3D_OK);
        assert.equal(h.texture(handle, 'UnlockRect', [0]), D3D_OK);
        return h.fields.readU32(locked + D3DLOCKED_RECT.pBits);
    };
    const from = addressOf(source);
    const to = addressOf(destination);
    h.box.services.writeMemory(from, Uint8Array.from({ length: 64 }, (_, index)=>index ^ 0x5a));
    h.box.services.writeMemory(to, new Uint8Array(64));

    assert.equal(h.device(device, 'UpdateTexture', [source, destination]), D3D_OK);
    assert.deepEqual([...h.box.services.readMemory(to, 64)],
        [...h.box.services.readMemory(from, 64)]);

    // The other direction is not an update: it would carry a texture the device
    // draws from back into one it does not.
    assert.equal(h.device(device, 'UpdateTexture', [destination, source]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'UpdateTexture', [source, 0]), D3DERR_INVALIDCALL);

    // Binding takes no reference, and reading the binding back takes one.
    assert.equal(h.device(device, 'SetTexture', [0, destination]), D3D_OK);
    assert.equal(h.object(destination).refCount, 1, 'binding is not owning');
    const bound = 0xd300;
    assert.equal(h.device(device, 'GetTexture', [0, bound]), D3D_OK);
    assert.equal(h.box.memory.readU32(bound), destination, 'and it is the same pointer');
    assert.equal(h.object(destination).refCount, 2);
    assert.equal(h.release(destination), 1);

    assert.equal(h.device(device, 'SetTexture', [0, 0]), D3D_OK);
    assert.equal(h.device(device, 'GetTexture', [1, bound]), D3D_OK);
    assert.equal(h.box.memory.readU32(bound), 0, 'a stage with nothing bound answers nothing');

    assert.equal(h.release(source), 0);
    assert.equal(h.release(destination), 0);
    assert.equal(h.release(device), 0);
    assert.equal(h.object(device), null);
    h.release(root);
});

/**
 * A GUID as DEFINE_GUID spells it, laid out in guest memory: three
 * little-endian integers, then eight bytes as they stand.
 *
 * @param {any} h @param {number} at
 * @param {[number, number, number, ...number[]]} parts
 */
const putGuid = (h, at, [data1, data2, data3, ...tail])=>{
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data1, true);
    view.setUint16(4, data2, true);
    view.setUint16(6, data3, true);
    bytes.set(tail, 8);
    h.box.services.writeMemory(at, bytes);
};

test('a texture and an index buffer answer QueryInterface for the GUIDs d3d8.h gives them',
    ()=>{
        const h = seamed();
        const root = h.create();
        const device = h.createDevice(root);
        const out = 0xe000;
        assert.equal(h.device(device, 'CreateTexture',
            [4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out]), D3D_OK);
        const texture = h.box.memory.readU32(out);
        assert.equal(h.device(device, 'CreateIndexBuffer',
            [64, 0, 101, D3DPOOL.MANAGED, out]), D3D_OK);
        const indices = h.box.memory.readU32(out);

        const iid = 0xe100;
        const queried = 0xe200;
        putGuid(h, iid, [0xE4CDD575, 0x2866, 0x4F01, 0xB1, 0x2E, 0x7E, 0xEC, 0xE1, 0xEC,
            0x93, 0x58]);
        assert.equal(h.box.call(texture, 0, [iid, queried]), D3D_OK, 'IID_IDirect3DTexture8');
        assert.equal(h.box.memory.readU32(queried), texture, 'the interface it was made as');
        assert.equal(h.release(texture), 1);
        putGuid(h, iid, [0x0E689C9A, 0x053D, 0x44A0, 0x9D, 0x92, 0xDB, 0x0E, 0x3D, 0x75,
            0x0F, 0x86]);
        assert.equal(h.box.call(indices, 0, [iid, queried]), D3D_OK,
            'IID_IDirect3DIndexBuffer8');
        assert.equal(h.box.memory.readU32(queried), indices);
        assert.equal(h.release(indices), 1);

        assert.equal(h.release(texture), 0);
        assert.equal(h.release(indices), 0);
        assert.equal(h.release(device), 0);
        h.release(root);
    });

test('every resource answers what IDirect3DResource8 asks of it', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0xe000;
    /** @param {number} pool */
    const texture = pool=>{
        assert.equal(h.device(device, 'CreateTexture',
            [16, 16, 3, 0, D3DFMT.X8R8G8B8, pool, out]), D3D_OK);
        return h.box.memory.readU32(out);
    };
    /** @param {number} pool @param {number} [usage] */
    const vertices = (pool, usage = 0)=>{
        assert.equal(h.device(device, 'CreateVertexBuffer', [256, usage, 0x102, pool, out]),
            D3D_OK);
        return h.box.memory.readU32(out);
    };
    /** @param {number} pointer @param {string} name @param {number[]} args */
    const vb = (pointer, name, args = [])=>
        h.box.call(pointer, slot(IDIRECT3DVERTEXBUFFER8_SLOTS, name), args);

    // GetType returns the kind itself, not an HRESULT (Wine's d3d8
    // test_resource_type).
    const managed = texture(D3DPOOL.MANAGED);
    assert.equal(h.texture(managed, 'GetType'), 3, 'D3DRTYPE_TEXTURE');
    const buffer = vertices(D3DPOOL.MANAGED, 0x200);
    assert.equal(vb(buffer, 'GetType'), 6, 'D3DRTYPE_VERTEXBUFFER');
    assert.equal(h.device(device, 'CreateIndexBuffer', [64, 0, 101, D3DPOOL.SYSTEMMEM, out]),
        D3D_OK);
    const indices = h.box.memory.readU32(out);
    assert.equal(vb(indices, 'GetType'), 7, 'D3DRTYPE_INDEXBUFFER');

    // The descriptions read back what the buffers were made as.
    const desc = 0xe100;
    h.box.services.writeMemory(desc, new Uint8Array(32).fill(0xcd));
    assert.equal(vb(buffer, 'GetDesc', [desc]), D3D_OK);
    assert.deepEqual(h.fields.readStruct(desc, D3DVERTEXBUFFER_DESC9), {
        Format: 100, Type: 6, Usage: 0x200, Pool: D3DPOOL.MANAGED, Size: 256, FVF: 0x102,
    });
    h.box.services.writeMemory(desc, new Uint8Array(32).fill(0xcd));
    assert.equal(vb(indices, 'GetDesc', [desc]), D3D_OK);
    assert.deepEqual(h.fields.readStruct(desc, D3DINDEXBUFFER_DESC9), {
        Format: 101, Type: 7, Usage: 0, Pool: D3DPOOL.SYSTEMMEM, Size: 64,
    });
    assert.equal(h.fields.readU32(desc + D3DINDEXBUFFER_DESC9.SIZE), 0xcdcdcdcd,
        'an index buffer\'s description has no FVF to write');
    assert.equal(vb(buffer, 'GetDesc', [0]), D3DERR_INVALIDCALL);

    // Only a managed resource keeps a priority; Set answers the one before
    // (Wine's d3d8 test_resource_priority).
    for (const [pool, keeps] of /** @type {[number, boolean][]} */ ([[D3DPOOL.DEFAULT, false],
        [D3DPOOL.SYSTEMMEM, false], [D3DPOOL.MANAGED, true]]))
    {
        // The resource slots are the front of every resource's table.
        for (const resource of [texture(pool), vertices(pool)])
        {
            assert.equal(vb(resource, 'GetPriority'), 0);
            assert.equal(vb(resource, 'SetPriority', [1]), 0);
            assert.equal(vb(resource, 'GetPriority'), keeps ? 1 : 0, `pool ${pool}`);
            assert.equal(vb(resource, 'SetPriority', [0]), keeps ? 1 : 0);
            assert.equal(vb(resource, 'PreLoad'), 0);
            assert.equal(h.release(resource), 0);
        }
    }

    // A level of detail is a managed texture's alone, clamped to its last
    // level; the call answers the level before.
    const unmanaged = texture(D3DPOOL.DEFAULT);
    assert.equal(h.texture(unmanaged, 'SetLOD', [2]), 0);
    assert.equal(h.texture(unmanaged, 'GetLOD'), 0);
    assert.equal(h.texture(managed, 'SetLOD', [1]), 0);
    assert.equal(h.texture(managed, 'GetLOD'), 1);
    assert.equal(h.texture(managed, 'SetLOD', [7]), 1);
    assert.equal(h.texture(managed, 'GetLOD'), 2, 'the last of three levels');

    // Every resource names the device that made it, with a reference.
    const got = 0xe200;
    const before = h.object(device).refCount;
    for (const resource of [managed, buffer, indices])
    {
        h.box.memory.writeU32(got, 0);
        assert.equal(vb(resource, 'GetDevice', [got]), D3D_OK);
        assert.equal(h.box.memory.readU32(got), device);
    }
    assert.equal(h.object(device).refCount, before + 3);
    for (let index = 0; index < 3; index++)
    {
        h.release(device);
    }

    assert.equal(h.release(unmanaged), 0);
    assert.equal(h.release(managed), 0);
    assert.equal(h.release(buffer), 0);
    assert.equal(h.release(indices), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a surface names its container as QueryInterface on it would, and its device', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0xe000;
    assert.equal(h.device(device, 'CreateTexture',
        [128, 128, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, out]), D3D_OK);
    const texture = h.box.memory.readU32(out);
    assert.equal(h.texture(texture, 'GetSurfaceLevel', [0, out]), D3D_OK);
    const level = h.box.memory.readU32(out);
    const iid = 0xe100;
    const container = 0xe200;

    // IDirect3DTexture8 is the pointer the program holds, with a reference.
    putGuid(h, iid, [0xE4CDD575, 0x2866, 0x4F01, 0xB1, 0x2E, 0x7E, 0xEC, 0xE1, 0xEC, 0x93,
        0x58]);
    assert.equal(h.surface(level, 'GetContainer', [iid, container]), D3D_OK);
    assert.equal(h.box.memory.readU32(container), texture);
    assert.equal(h.object(texture).refCount, 3, 'the texture, its level, and the container');
    h.release(texture);
    // The interfaces it derives from answer too: IDirect3DBaseTexture8 is
    // callable as one, and IUnknown is the identity QueryInterface gives.
    putGuid(h, iid, [0xB4211CFA, 0x51B9, 0x4A9F, 0xAB, 0x78, 0xDB, 0x99, 0xB2, 0xBB, 0x67,
        0x8E]);
    assert.equal(h.surface(level, 'GetContainer', [iid, container]), D3D_OK);
    const base = h.box.memory.readU32(container);
    assert.notEqual(base, 0);
    assert.equal(h.box.call(base, slot(IDIRECT3DTEXTURE8_SLOTS, 'GetLevelCount')), 1);
    h.release(base);
    putGuid(h, iid, [0x00000000, 0x0000, 0x0000, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x46]);
    const identity = 0xe300;
    assert.equal(h.surface(level, 'GetContainer', [iid, container]), D3D_OK);
    assert.equal(h.box.call(texture, 0, [iid, identity]), D3D_OK);
    assert.equal(h.box.memory.readU32(container), h.box.memory.readU32(identity),
        'one identity, however it is reached');
    h.release(texture);
    h.release(texture);
    // A surface is not what holds a surface: E_NOINTERFACE, and the pointer
    // cleared.
    putGuid(h, iid, [0xB96EEBCA, 0xB326, 0x4EA5, 0x88, 0x2F, 0x2F, 0xF5, 0xBA, 0xE0, 0x21,
        0xDD]);
    h.box.memory.writeU32(container, 0x1337c0d3);
    assert.equal(h.surface(level, 'GetContainer', [iid, container]), 0x80004002);
    assert.equal(h.box.memory.readU32(container), 0);

    // A surface of its own, the back buffer included, is held by the device.
    putGuid(h, iid, [0x7385E5DF, 0x8FE8, 0x41D5, 0x86, 0xB6, 0xD7, 0xB4, 0x85, 0x47, 0xB6,
        0xCF]);
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, out]), D3D_OK);
    const back = h.box.memory.readU32(out);
    assert.equal(h.surface(back, 'GetContainer', [iid, container]), D3D_OK);
    assert.equal(h.box.memory.readU32(container), device);
    h.release(device);
    assert.equal(h.device(device, 'CreateImageSurface', [8, 8, D3DFMT.X8R8G8B8, out]), D3D_OK);
    const image = h.box.memory.readU32(out);
    for (const surface of [level, back, image])
    {
        h.box.memory.writeU32(container, 0);
        assert.equal(h.surface(surface, 'GetDevice', [container]), D3D_OK);
        assert.equal(h.box.memory.readU32(container), device);
        h.release(device);
    }

    assert.equal(h.release(image), 0);
    assert.equal(h.release(back), 0);
    assert.equal(h.release(level), 1);
    assert.equal(h.release(texture), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a cube texture is made, and answers for its faces through its own vtable', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0xe000;
    assert.equal(h.device(device, 'CreateCubeTexture',
        [8, 0, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out]), D3D_OK);
    const cube = h.box.memory.readU32(out);
    assert.notEqual(cube, 0);
    /** @param {string} name @param {number[]} [args] */
    const call = (name, args = [])=>
        h.box.call(cube, slot(IDIRECT3DCUBETEXTURE8_SLOTS, name), args);

    assert.equal(call('GetType'), 5, 'D3DRTYPE_CUBETEXTURE');
    assert.equal(call('GetLevelCount'), 4, 'a whole chain for zero levels');
    const desc = 0xe100;
    assert.equal(call('GetLevelDesc', [1, desc]), D3D_OK);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Width), 4);

    // Each face locks at its own storage, and one past the sixth is refused.
    const locked = 0xe200;
    assert.equal(call('LockRect', [5, 0, locked, 0, 0]), D3D_OK);
    assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.Pitch), 32);
    const fifth = h.fields.readU32(locked + D3DLOCKED_RECT.pBits);
    assert.equal(call('UnlockRect', [5, 0]), D3D_OK);
    assert.equal(call('LockRect', [0, 0, locked, 0, 0]), D3D_OK);
    assert.notEqual(h.fields.readU32(locked + D3DLOCKED_RECT.pBits), fifth);
    assert.equal(call('UnlockRect', [0, 0]), D3D_OK);
    assert.equal(call('LockRect', [6, 0, locked, 0, 0]), D3DERR_INVALIDCALL);
    assert.equal(call('AddDirtyRect', [1, 0]), D3D_OK);
    assert.equal(call('AddDirtyRect', [6, 0]), D3DERR_INVALIDCALL);

    // A face's surface names the cube as its container, by d3d8.h's GUID.
    assert.equal(call('GetCubeMapSurface', [2, 0, out]), D3D_OK);
    const face = h.box.memory.readU32(out);
    const iid = 0xe300;
    putGuid(h, iid, [0x3EE5B968, 0x2ACA, 0x4C34, 0x8B, 0xB5, 0x7E, 0x0C, 0x3D, 0x19, 0xB7,
        0x50]);
    assert.equal(h.surface(face, 'GetContainer', [iid, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), cube);
    h.release(cube);
    assert.equal(h.release(face), 1, 'the cube holds its face');

    // Bound and read back, it is the pointer the program holds.
    assert.equal(h.device(device, 'SetTexture', [0, cube]), D3D_OK);
    assert.equal(h.device(device, 'GetTexture', [0, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), cube);
    h.release(cube);
    assert.equal(h.device(device, 'SetTexture', [0, 0]), D3D_OK);
    assert.equal(h.release(cube), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a volume texture is made, and its levels lock, describe and name it', ()=>{
    // Wine's d3d8 test_volume_locking, test_lockbox_invalid and
    // test_volume_get_container.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0xe000;
    const dynamic = 0x200;
    assert.equal(h.device(device, 'CreateVolumeTexture',
        [4, 4, 4, 1, dynamic, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out]), D3DERR_INVALIDCALL,
    'a managed volume is not dynamic');
    assert.equal(h.device(device, 'CreateVolumeTexture',
        [4, 4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, out]), D3D_OK);
    const placed = h.box.memory.readU32(out);
    const locked = 0xe100;
    /** @param {number} texture @param {string} name @param {number[]} [args] */
    const call = (texture, name, args = [])=>
        h.box.call(texture, slot(IDIRECT3DVOLUMETEXTURE8_SLOTS, name), args);
    h.box.memory.writeU32(locked + 8, 0xdeadbeef);
    assert.equal(call(placed, 'LockBox', [0, locked, 0, 0]), D3DERR_INVALIDCALL,
        'a default-pool volume that is not dynamic does not lock');
    assert.equal(h.box.memory.readU32(locked + 8), 0, 'and hands out no address');
    assert.equal(h.release(placed), 0);

    assert.equal(h.device(device, 'CreateVolumeTexture',
        [4, 4, 2, 0, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out]), D3D_OK);
    const texture = h.box.memory.readU32(out);
    assert.equal(call(texture, 'GetType'), 4, 'D3DRTYPE_VOLUMETEXTURE');
    assert.equal(call(texture, 'GetLevelCount'), 3);
    const desc = 0xe200;
    assert.equal(call(texture, 'GetLevelDesc', [1, desc]), D3D_OK);
    assert.deepEqual(h.fields.readStruct(desc, D3DVOLUME_DESC8), {
        Format: D3DFMT.A8R8G8B8, Type: 2, Usage: 0, Pool: D3DPOOL.MANAGED, Size: 2 * 2 * 1 * 4,
        Width: 2, Height: 2, Depth: 1,
    });
    assert.equal(call(texture, 'LockBox', [0, locked, 0, 0]), D3D_OK);
    assert.deepEqual([h.box.memory.readU32(locked), h.box.memory.readU32(locked + 4)], [16, 64],
        'the row and slice pitches');
    assert.equal(call(texture, 'UnlockBox', [0]), D3D_OK);

    assert.equal(call(texture, 'GetVolumeLevel', [0, out]), D3D_OK);
    const volume = h.box.memory.readU32(out);
    const iid = 0xe300;
    putGuid(h, iid, [0x4B8AAAFA, 0x140F, 0x42BA, 0x91, 0x31, 0x59, 0x7E, 0xAF, 0xAA, 0x2E,
        0xAD]);
    assert.equal(h.box.call(volume, slot(IDIRECT3DVOLUME8_SLOTS, 'GetContainer'), [iid, out]),
        D3D_OK);
    assert.equal(h.box.memory.readU32(out), texture);
    h.release(texture);
    assert.equal(h.box.call(volume, slot(IDIRECT3DVOLUME8_SLOTS, 'LockBox'), [locked, 0, 0]),
        D3D_OK);
    assert.equal(h.box.call(volume, slot(IDIRECT3DVOLUME8_SLOTS, 'UnlockBox')), D3D_OK);
    assert.equal(h.release(volume), 1);

    assert.equal(h.device(device, 'SetTexture', [0, texture]), D3D_OK);
    assert.equal(h.device(device, 'GetTexture', [0, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), texture);
    h.release(texture);
    assert.equal(h.device(device, 'SetTexture', [0, 0]), D3D_OK);
    assert.equal(h.release(texture), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a texture palette is kept and read back, and one with alpha is refused', ()=>{
    // Wine's d3d8 test_set_palette and visual.c's palette test: an opaque
    // palette is taken and a current one chosen; entries with alpha need
    // D3DPTEXTURECAPS_ALPHAPALETTE, which this device does not claim.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const table = 0xe000;
    const entries = Uint8Array.from({ length: 1024 }, (_, index)=>(index % 4 === 3
        ? 0xff
        : index >> 2));
    h.box.services.writeMemory(table, entries);
    assert.equal(h.device(device, 'SetPaletteEntries', [1, table]), D3D_OK);
    const read = 0xe400;
    assert.equal(h.device(device, 'GetPaletteEntries', [1, read]), D3D_OK);
    assert.deepEqual([...h.box.services.readMemory(read, 1024)], [...entries]);
    assert.equal(h.device(device, 'GetPaletteEntries', [2, read]), D3DERR_INVALIDCALL,
        'a palette never set');
    assert.equal(h.device(device, 'SetCurrentTexturePalette', [1]), D3D_OK);
    const current = 0xe800;
    assert.equal(h.device(device, 'GetCurrentTexturePalette', [current]), D3D_OK);
    assert.equal(h.box.memory.readU32(current), 1);

    h.box.services.writeMemory(table + 7, Uint8Array.of(0x80));
    assert.equal(h.device(device, 'SetPaletteEntries', [1, table]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'GetPaletteEntries', [1, read]), D3D_OK);
    assert.equal(h.box.services.readMemory(read + 7, 1)[0], 0xff, 'the palette as it was');
    assert.equal(h.device(device, 'SetPaletteEntries', [1, 0]), D3DERR_INVALIDCALL);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a stream and an index binding read back as the buffers they were given', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0xe000;

    assert.equal(h.device(device, 'CreateVertexBuffer',
        [1024, 0, 0x002 | 0x040, D3DPOOL.DEFAULT, out]), D3D_OK);
    const vertices = h.box.memory.readU32(out);
    // D3DFMT_INDEX16 is 101.
    assert.equal(h.device(device, 'CreateIndexBuffer',
        [512, 0, 101, D3DPOOL.DEFAULT, out]), D3D_OK);
    const indices = h.box.memory.readU32(out);

    assert.equal(h.device(device, 'SetStreamSource', [0, vertices, 20]), D3D_OK);
    assert.equal(h.device(device, 'SetIndices', [indices, 7]), D3D_OK);
    assert.equal(h.object(vertices).refCount, 1, 'binding a stream takes no reference');

    const buffer = 0xe100;
    const stride = 0xe200;
    assert.equal(h.device(device, 'GetStreamSource', [0, buffer, stride]), D3D_OK);
    assert.equal(h.box.memory.readU32(buffer), vertices);
    assert.equal(h.box.memory.readU32(stride), 20);
    assert.equal(h.object(vertices).refCount, 2, 'reading it back does');
    assert.equal(h.release(vertices), 1);

    const base = 0xe300;
    assert.equal(h.device(device, 'GetIndices', [buffer, base]), D3D_OK);
    assert.equal(h.box.memory.readU32(buffer), indices);
    assert.equal(h.box.memory.readU32(base), 7,
        'the base vertex index travels with the binding in this version');
    assert.equal(h.release(indices), 1);

    // An empty stream answers a null pointer rather than the last buffer read.
    assert.equal(h.device(device, 'GetStreamSource', [3, buffer, stride]), D3D_OK);
    assert.equal(h.box.memory.readU32(buffer), 0);
    assert.equal(h.device(device, 'GetStreamSource', [0, 0, 0]), D3DERR_INVALIDCALL);

    assert.equal(h.device(device, 'SetStreamSource', [0, 0, 0]), D3D_OK);
    assert.equal(h.device(device, 'SetIndices', [0, 0]), D3D_OK);
    assert.equal(h.release(vertices), 0);
    assert.equal(h.release(indices), 0);
    assert.equal(h.release(device), 0);
    assert.equal(h.object(device), null);
    h.release(root);
});

test('every slot the device declares is there, and counts its own arguments', ()=>{
    // A missing slot shifts every method after it, and a miscounted one returns
    // to the wrong address. Both fail somewhere with no connection to here.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const table = h.box.memory.readU32(device);

    for (let index = 0; index < 3 + IDIRECT3DDEVICE8_SLOTS.length; index++)
    {
        assert.notEqual(h.box.memory.readU32(table + index * 4), 0, `slot ${index} is empty`);
    }
    for (const [name, args] of IDIRECT3DDEVICE8_SLOTS)
    {
        assert.equal(h.box.argBytesOf(device, slot(IDIRECT3DDEVICE8_SLOTS, name)), 4 + args * 4,
            `${name} pops this and its arguments`);
    }

    // A viewport, because it is the one structure here whose last two fields
    // are floats in dword slots.
    const viewport = 0xf000;
    h.fields.writeStruct(viewport, D3DVIEWPORT8, {
        X: 0, Y: 0, Width: 32, Height: 16,
        MinZ: floatToDword(0.25), MaxZ: floatToDword(0.75),
    });
    assert.equal(h.device(device, 'SetViewport', [viewport]), D3D_OK);
    const read = 0xf100;
    assert.equal(h.device(device, 'GetViewport', [read]), D3D_OK);
    assert.equal(h.fields.readU32(read + D3DVIEWPORT8.Width), 32);
    assert.equal(h.fields.readF32(read + D3DVIEWPORT8.MinZ), 0.25,
        'the two Z bounds are floats in dword slots');
    assert.equal(h.fields.readF32(read + D3DVIEWPORT8.MaxZ), 0.75);

    assert.equal(h.release(device), 0);
    h.release(root);
});

/**
 * D3DCAPS8 as `d3d8caps.h` declares it: fifty-three fields, every one of them
 * four bytes, in this order. Written as an order rather than as a second copy
 * of the offsets, because the defect this guards against is a field left out --
 * and a table with a field missing has every offset after it wrong while still
 * looking like a table of offsets.
 */
const D3DCAPS8_FIELDS = [
    'DeviceType', 'AdapterOrdinal',
    'Caps', 'Caps2', 'Caps3', 'PresentationIntervals',
    'CursorCaps', 'DevCaps', 'PrimitiveMiscCaps', 'RasterCaps',
    'ZCmpCaps', 'SrcBlendCaps', 'DestBlendCaps', 'AlphaCmpCaps', 'ShadeCaps',
    'TextureCaps', 'TextureFilterCaps', 'CubeTextureFilterCaps', 'VolumeTextureFilterCaps',
    'TextureAddressCaps', 'VolumeTextureAddressCaps', 'LineCaps',
    'MaxTextureWidth', 'MaxTextureHeight', 'MaxVolumeExtent',
    'MaxTextureRepeat', 'MaxTextureAspectRatio', 'MaxAnisotropy',
    'MaxVertexW',
    'GuardBandLeft', 'GuardBandTop', 'GuardBandRight', 'GuardBandBottom', 'ExtentsAdjust',
    'StencilCaps', 'FVFCaps', 'TextureOpCaps',
    'MaxTextureBlendStages', 'MaxSimultaneousTextures',
    'VertexProcessingCaps', 'MaxActiveLights', 'MaxUserClipPlanes',
    'MaxVertexBlendMatrices', 'MaxVertexBlendMatrixIndex',
    'MaxPointSize', 'MaxPrimitiveCount', 'MaxVertexIndex',
    'MaxStreams', 'MaxStreamStride',
    'VertexShaderVersion', 'MaxVertexShaderConst',
    'PixelShaderVersion', 'MaxPixelShaderValue',
];

test('every D3DCAPS8 field is at the offset the header puts it at', ()=>{
    // The five guard-band floats and the extents adjustment sit between the
    // texture limits and the blend-stage counts. A table that skips them writes
    // the maximum texture width into the repeat limit, and the real maximum
    // then reads as zero -- which a program that halves a texture until it fits
    // never escapes.
    const offsets = /** @type {Record<string, number>} */ (D3DCAPS8);
    D3DCAPS8_FIELDS.forEach((name, index)=>{
        assert.equal(offsets[name], index * 4, `${name} is field ${index}`);
    });
    assert.equal(D3DCAPS8.SIZE, 0xd4, 'fifty-three four-byte fields');
    assert.equal(Object.keys(D3DCAPS8).length, D3DCAPS8_FIELDS.length + 1,
        'and nothing in the table that is not one of them');
});

test('the capabilities a device reports are answers, not gaps', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);

    // Poisoned first, so that a field the writer never reaches fails here
    // rather than reading back as a plausible zero.
    const at = 0x3200;
    h.box.services.writeMemory(at, new Uint8Array(D3DCAPS8.SIZE).fill(0xcd));
    assert.equal(h.device(device, 'GetDeviceCaps', [at]), D3D_OK);

    // The two that a program divides by, halves against, or compares a texture
    // to. A zero read as an answer is worse than no answer at all.
    assert.equal(h.fields.readU32(at + D3DCAPS8.MaxTextureWidth), 4096);
    assert.equal(h.fields.readU32(at + D3DCAPS8.MaxTextureHeight), 4096);
    assert.equal(h.fields.readU32(at + D3DCAPS8.MaxTextureRepeat), 8192,
        'and the repeat limit is its own field, not the width in disguise');

    const caps = h.fields.readStruct(at, D3DCAPS8,
        ['MaxVertexW', 'GuardBandLeft', 'GuardBandTop', 'GuardBandRight', 'GuardBandBottom',
            'ExtentsAdjust', 'MaxPointSize', 'MaxPixelShaderValue']);
    assert.equal(caps.DeviceType, D3DDEVTYPE.HAL, 'the first field, so the whole run starts right');
    assert.equal(caps.MaxPixelShaderValue, 1, 'a float');
    assert.equal(caps.MaxTextureAspectRatio, 4096);
    assert.equal(caps.MaxAnisotropy, 1, 'the sampler filters no more than linearly');
    assert.equal(caps.MaxTextureBlendStages, 8);
    assert.equal(caps.MaxSimultaneousTextures, 8);
    assert.equal(caps.MaxActiveLights, 8);
    assert.equal(caps.MaxUserClipPlanes, 0, 'nothing clips against a plane of the program\'s');
    assert.equal(caps.MaxStreams, 16);
    assert.equal(caps.MaxPointSize, 64, 'a float in the middle of the dwords');
    assert.equal(caps.ExtentsAdjust, 0);
    assert.ok(caps.MaxVertexW > 0, 'a zero here is read as no clipping headroom at all');
    assert.ok(caps.GuardBandLeft < 0 && caps.GuardBandRight > 0);

    // Vertex shaders to 1.1 over a file of 256 constants, and pixel shaders
    // to 1.4, whose registers hold [-1, 1].
    assert.equal(caps.VertexShaderVersion, 0xfffe0101);
    assert.equal(caps.MaxVertexShaderConst, 256);
    assert.equal(caps.PixelShaderVersion, 0xffff0104);

    // The bits land in the fields they belong to rather than one field over.
    assert.equal(caps.ZCmpCaps, caps.AlphaCmpCaps, 'both comparison sets are the same set');
    assert.equal(caps.SrcBlendCaps, caps.DestBlendCaps);
    assert.ok((caps.TextureCaps & 0x00004000) !== 0, 'D3DPTEXTURECAPS_MIPMAP');
    assert.ok((caps.TextureAddressCaps & 0x00000001) !== 0, 'D3DPTADDRESSCAPS_WRAP');
    // Each by the value d3d8caps.h gives it. A driver that will not draw
    // without D3DDEVCAPS_DRAWPRIMTLVERTEX turned every adapter down while
    // these three sat one bit over, and its game asked for a DirectX 8 card.
    assert.equal(caps.DevCaps, 0x00010000 | 0x00080000 | 0x00000400 | 0x00002000 | 0x00008000
        | 0x00000010 | 0x00000200 | 0x00001000 | 0x00000800, 'HWTRANSFORMANDLIGHT, '
        + 'HWRASTERIZATION, DRAWPRIMTLVERTEX, DRAWPRIMITIVES2, DRAWPRIMITIVES2EX, '
        + 'EXECUTESYSTEMMEMORY, TEXTUREVIDEOMEMORY, TEXTURENONLOCALVIDMEM, CANRENDERAFTERFLIP');
    // A colour cursor is claimed, because the device keeps the bitmap it is
    // handed and the host shows it. A title was measured drawing its own
    // cursor, from the wrong cell of its sheet, when this field read zero.
    assert.equal(caps.CursorCaps, 0x3, 'D3DCURSORCAPS_COLOR | D3DCURSORCAPS_LOWRES');
    assert.equal(caps.Caps, 0x00020000, 'D3DCAPS_READ_SCANLINE: the raster can be read');
    assert.equal(caps.Caps3, 0, 'nothing was written into the field before the intervals');

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('the fog the raster caps claim is named by the bits d3d8caps.h gives it', ()=>{
    // Table fog is taken over w under a perspective projection and over z
    // under an affine one, which is both of the claims.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const at = 0x3200;
    assert.equal(h.device(device, 'GetDeviceCaps', [at]), D3D_OK);
    const raster = h.fields.readU32(at + D3DCAPS8.RasterCaps);
    assert.ok((raster & 0x00200000) !== 0, 'D3DPRASTERCAPS_ZFOG');
    assert.ok((raster & 0x00100000) !== 0, 'D3DPRASTERCAPS_WFOG');
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('every capability claimed is one the renderer honours', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const at = 0x3200;
    assert.equal(h.device(device, 'GetDeviceCaps', [at]), D3D_OK);
    const caps = h.fields.readStruct(at, D3DCAPS8,
        ['MaxVertexW', 'GuardBandLeft', 'GuardBandTop', 'GuardBandRight', 'GuardBandBottom',
            'ExtentsAdjust', 'MaxPointSize']);

    assert.equal(caps.TextureOpCaps, 0x0000ffff,
        'DISABLE through BLENDCURRENTALPHA, the operations the combiner draws');
    assert.equal(caps.TextureCaps & (0x00000800 | 0x00010000), 0x00010800,
        'cube maps and their chains, which the renderer samples');
    assert.equal(caps.CubeTextureFilterCaps, caps.TextureFilterCaps);
    assert.equal(caps.TextureCaps & 0x0000a000, 0x0000a000, 'volumes and their chains');
    assert.equal(caps.VolumeTextureFilterCaps, caps.TextureFilterCaps);
    assert.equal(caps.VolumeTextureAddressCaps, caps.TextureAddressCaps);
    assert.equal(caps.Caps2 & 0x00020000, 0,
        'no D3DCAPS2_FULLSCREENGAMMA: no display here shows a ramp');
    assert.equal(caps.TextureCaps & 0x00000080, 0,
        'no D3DPTEXTURECAPS_ALPHAPALETTE: no palettised format is made');
    assert.equal(caps.RasterCaps & 0x00004000, 0, 'no D3DRS_ZBIAS, which nothing reads');
    assert.equal(caps.RasterCaps & 0x00020000, 0, 'no anisotropy');
    assert.equal(caps.TextureFilterCaps & (0x00000400 | 0x04000000), 0,
        'no anisotropic minification or magnification');
    assert.equal(caps.RasterCaps & 0x00002000, 0, 'no D3DTSS_MIPMAPLODBIAS, which nothing reads');
    assert.equal(caps.StencilCaps, 0, 'no stencil test in the pipeline');
    assert.equal(caps.MaxVertexBlendMatrices, 0, 'no vertex blending');
    assert.equal(caps.TextureAddressCaps & (0x00000008 | 0x00000020), 0,
        'no border colour and no mirror-once, which the sampler folds into others');
    assert.equal(caps.RasterCaps & 0x00010000, 0x00010000,
        'D3DPRASTERCAPS_FOGRANGE: range fog fades by the distance from the eye');

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a surface keeps private data under a GUID, an interface entry with a reference', ()=>{
    // After Wine's d3d8 test_private_data.
    const D3DSPD_IUNKNOWN = 1;
    const D3DERR_MOREDATA = 0x88760867;
    const D3DERR_NOTFOUND = 0x88760866;
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const guid = 0xd000;
    const other = 0xd010;
    h.box.services.writeMemory(guid, Uint8Array.from({ length: 16 }, (_, i)=>0x40 + i));
    h.box.services.writeMemory(other, Uint8Array.from({ length: 16 }, (_, i)=>0x80 + i));
    const out = 0xd100;
    assert.equal(h.device(device, 'CreateImageSurface', [4, 4, D3DFMT.A8R8G8B8, out]), D3D_OK);
    const surface = h.box.memory.readU32(out);
    const deviceModel = h.object(device);
    const surfaceCall = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        h.surface(surface, name, args);

    for (const size of [0, 5, 8])
    {
        assert.equal(surfaceCall('SetPrivateData', [guid, device, size, D3DSPD_IUNKNOWN]),
            D3DERR_INVALIDCALL, `an interface is the size of a pointer, not ${size}`);
    }
    const before = deviceModel.refCount;
    assert.equal(surfaceCall('SetPrivateData', [guid, device, 4, D3DSPD_IUNKNOWN]), D3D_OK);
    assert.equal(deviceModel.refCount, before + 1, 'the entry holds the device');
    assert.equal(surfaceCall('SetPrivateData', [guid, device, 8, D3DSPD_IUNKNOWN]),
        D3DERR_INVALIDCALL, 'and a refused set leaves it');

    const data = 0xd200;
    const sizeAt = 0xd210;
    h.box.memory.writeU32(sizeAt, 8);
    assert.equal(surfaceCall('GetPrivateData', [guid, data, sizeAt]), D3D_OK);
    assert.equal(h.box.memory.readU32(data), device);
    assert.equal(h.box.memory.readU32(sizeAt), 4);
    assert.equal(deviceModel.refCount, before + 2, 'reading an interface entry takes one more');
    assert.equal(h.release(device), before + 1);

    h.box.memory.writeU32(sizeAt, 1);
    assert.equal(surfaceCall('GetPrivateData', [guid, 0, sizeAt]), D3D_OK, 'a size query');
    assert.equal(h.box.memory.readU32(sizeAt), 4);
    h.box.memory.writeU32(sizeAt, 1);
    h.box.memory.writeU32(data, 0xdeadbeef);
    assert.equal(surfaceCall('GetPrivateData', [guid, data, sizeAt]), D3DERR_MOREDATA);
    assert.equal(h.box.memory.readU32(sizeAt), 4);
    assert.equal(h.box.memory.readU32(data), 0xdeadbeef);
    h.box.memory.writeU32(sizeAt, 0xdeadbabe);
    assert.equal(surfaceCall('GetPrivateData', [other, data, sizeAt]), D3DERR_NOTFOUND);
    assert.equal(h.box.memory.readU32(sizeAt), 0xdeadbabe);

    // Bytes, and a free that gives the device's reference back.
    const bytes = 0xd300;
    h.box.memory.writeU32(bytes, 0x04030201);
    assert.equal(surfaceCall('SetPrivateData', [other, bytes, 4, 0]), D3D_OK);
    h.box.memory.writeU32(sizeAt, 4);
    assert.equal(surfaceCall('GetPrivateData', [other, data, sizeAt]), D3D_OK);
    assert.equal(h.box.memory.readU32(data), 0x04030201);
    assert.equal(surfaceCall('FreePrivateData', [other]), D3D_OK);
    assert.equal(surfaceCall('FreePrivateData', [other]), D3DERR_NOTFOUND);

    // Destroying the surface lets go of what its entries held, and of the
    // device reference every resource holds.
    assert.equal(h.release(surface), 0);
    assert.equal(deviceModel.refCount, before - 1);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a create with nowhere to put the interface fails instead of answering success', ()=>{
    // Publishing an interface takes guest memory for the vtable and a stub per
    // method, and both run out. What the publisher answers then is a null
    // pointer -- and a null pointer written next to D3D_OK is a texture the
    // program goes on to call through, at address zero.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    h.box.exhaustArena();

    const out = 0xe000;
    h.box.memory.writeU32(out, 0xdeadbeef);
    assert.equal(
        h.device(device, 'CreateTexture', [4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out]),
        D3DERR_OUTOFVIDEOMEMORY,
        'a texture that could not be handed back is a failed create');
    assert.equal(h.box.memory.readU32(out), 0, 'and the caller sees no pointer either');

    assert.equal(h.device(device, 'CreateImageSurface', [4, 4, D3DFMT.A8R8G8B8, out]),
        E_OUTOFMEMORY);
    assert.equal(h.device(device, 'CreateVertexBuffer', [64, 0, 0, D3DPOOL.MANAGED, out]),
        D3DERR_OUTOFVIDEOMEMORY);
    assert.equal(h.device(device, 'CreateIndexBuffer',
        [64, 0, 101, D3DPOOL.MANAGED, out]), D3DERR_OUTOFVIDEOMEMORY, 'D3DFMT_INDEX16');
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, out]), E_OUTOFMEMORY);
    assert.equal(h.box.memory.readU32(out), 0);
});

/**
 * A group's count as a guest routine leaves it, and the count of every call
 * raised with it, which is what an entry reads first.
 *
 * @param {ReturnType<typeof seamed>} h @param {number} block
 * @param {number} counter @param {number} value
 */
function counted(h, block, counter, value){
    h.box.memory.writeU32(block + counter, value);
    h.box.memory.writeU32(block + SHADOW.CALLS, h.box.memory.readU32(block + SHADOW.CALLS) + 1);
}

test('a value the host set through the trap is one the guest\'s next write is seen to change', ()=>{
    // The routines leave a shader handle to the host, and MultiplyTransform
    // is the host's alone: both set a value the block holds. Were the block
    // left as it was, the guest setting the value before once more would
    // write what the block already held and read as no change, and the
    // device would keep the handle, or the product.
    const h = seamed({ shadow: true });
    const device = h.createDevice(h.create());
    const block = h.box.memory.readU32(device + 4);
    const out = 0xe000;
    /** @param {number} at @param {number[]} words */
    const write = (at, words)=>h.box.services.writeMemory(at,
        new Uint8Array(Uint32Array.from(words).buffer));
    write(0x7000, [0x20000000, 0x40020000, 0xffffffff]);
    write(0x7100, [0xfffe0101, 0x00000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x0000ffff]);
    assert.equal(h.device(device, 'CreateVertexShader', [0x7000, 0x7100, out, 0]), D3D_OK);
    const handle = h.box.memory.readU32(out);
    const fvf = 0x142;
    /** What the guest routine does with a vertex format. */
    const guestFormat = ()=>{
        h.box.memory.writeU32(block + SHADOW.VERTEX_SHADER, fvf);
        counted(h, block, SHADOW.BINDING_CALLS,
            h.box.memory.readU32(block + SHADOW.BINDING_CALLS) + 1);
    };
    const bound = ()=>{
        assert.equal(h.device(device, 'GetVertexShader', [out]), D3D_OK);
        return h.box.memory.readU32(out);
    };

    guestFormat();
    assert.equal(bound(), fvf);
    assert.equal(h.box.trap(device, 'SetVertexShader', [handle]), D3D_OK);
    assert.equal(bound(), handle);
    guestFormat();
    assert.equal(bound(), fvf, 'the format again, after the handle');
    assert.equal(h.box.trap(device, 'SetVertexShader', [handle]), D3D_OK);
    assert.equal(h.device(device, 'DeleteVertexShader', [handle]), D3D_OK);
    assert.equal(bound(), 0, 'deleting the bound shader unbinds it');
    guestFormat();
    assert.equal(bound(), fvf);

    // WORLD set in the guest, multiplied by the host, set in the guest again.
    const matrix = Array.from({ length: 16 }, (_, i)=>floatToDword(i % 5 === 0 ? 2 : 0));
    const world = block + SHADOW.TRANSFORMS + 24 * 64;
    const guestWorld = ()=>{
        write(world, matrix);
        h.box.memory.writeU32(block + SHADOW.TRANSFORM_MARKS, 1 << 24);
        counted(h, block, SHADOW.TRANSFORM_CALLS,
            h.box.memory.readU32(block + SHADOW.TRANSFORM_CALLS) + 1);
    };
    write(0x8000, matrix);
    guestWorld();
    assert.equal(h.device(device, 'MultiplyTransform', [D3DTS.WORLD, 0x8000]), D3D_OK);
    assert.equal(h.device(device, 'GetTransform', [D3DTS.WORLD, 0x8100]), D3D_OK);
    assert.equal(h.fields.readF32(0x8100), 4, 'twice by twice');
    guestWorld();
    assert.equal(h.device(device, 'GetTransform', [D3DTS.WORLD, 0x8100]), D3D_OK);
    assert.equal(h.fields.readF32(0x8100), 2, 'the matrix again, after the product');
    assert.deepEqual(h.divergences, []);
});

test('a device is handed out with its block already in place, and reads what the guest wrote', ()=>{
    // The guest methods find the block one word past the interface pointer,
    // and that word is written when the interface is published. A device
    // published before it had a block carries a zero there: the guest keeps
    // the program's state at address zero, the host never sees it, and the
    // program draws with the state it started with.
    const h = seamed({ shadow: true });
    const device = h.createDevice(h.create());

    const block = h.box.memory.readU32(device + 4);
    assert.notEqual(block, 0, 'the state word names the block');
    assert.equal(h.libraries.shadow().placed, 1);
    // D3DRS_CULLMODE is 22.
    const cull = 22;
    const out = 0xe000;
    assert.equal(h.device(device, 'GetRenderState', [cull, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(block + SHADOW.RENDER_STATES + cull * 4),
        h.box.memory.readU32(out), 'mirrored as the device holds it');

    // What the guest method does: write the state, mark it, count the call.
    h.box.memory.writeU32(block + SHADOW.RENDER_STATES + cull * 4, 1);
    h.box.memory.writeU32(block + SHADOW.RENDER_STATE_MARKS, 1 << cull);
    counted(h, block, SHADOW.RENDER_STATE_CALLS, 1);
    assert.equal(h.device(device, 'GetRenderState', [cull, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), 1, 'the host answers from the block');
    assert.equal(h.libraries.shadow().renderStateCalls, 1);
    assert.deepEqual(h.divergences, []);

    // A buffer's block names the device's, and a binding the guest wrote
    // reads back as the buffer the pointer names.
    const created = 0xe100;
    assert.equal(h.device(device, 'CreateVertexBuffer', [256, 0, 0, D3DPOOL.MANAGED, created]),
        D3D_OK);
    const vb = h.box.memory.readU32(created);
    const vblock = h.box.memory.readU32(vb + 4);
    assert.notEqual(vblock, 0, 'the buffer has a block');
    assert.equal(h.box.memory.readU32(vblock + BUFFER.DEVICE), block);
    assert.equal(h.box.memory.readU32(vblock + BUFFER.LENGTH), 256);
    h.box.memory.writeU32(block + SHADOW.STREAMS, vb);
    h.box.memory.writeU32(block + SHADOW.STREAMS + 4, 24);
    counted(h, block, SHADOW.BINDING_CALLS, 1);
    const stride = 0xe200;
    assert.equal(h.device(device, 'GetStreamSource', [0, out, stride]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), vb, 'bound to the buffer the guest named');
    assert.equal(h.box.memory.readU32(stride), 24);
    h.release(h.box.memory.readU32(out));

    // An unbinding is the host's. A bind the guest made just before it, at
    // another stride, reaches the device first, and the device keeps the
    // stride that bind set; the block names no buffer after it, so the same
    // buffer bound again is a change.
    h.box.memory.writeU32(block + SHADOW.STREAMS + 4, 40);
    counted(h, block, SHADOW.BINDING_CALLS, 2);
    assert.equal(h.device(device, 'SetStreamSource', [0, 0, 0]), D3D_OK);
    assert.equal(h.device(device, 'GetStreamSource', [0, out, stride]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), 0, 'unbound');
    assert.equal(h.box.memory.readU32(stride), 40, 'at the stride the bind before it set');
    assert.equal(h.box.memory.readU32(block + SHADOW.STREAMS), 0, 'and the block says so');
    h.box.memory.writeU32(block + SHADOW.STREAMS, vb);
    counted(h, block, SHADOW.BINDING_CALLS, 3);
    assert.equal(h.device(device, 'GetStreamSource', [0, out, stride]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), vb, 'the same buffer bound again');
    h.release(h.box.memory.readU32(out));

    // A lock taken in the guest is a lock the host's path refuses; once the
    // guest lets go, the host's path locks, and the block says so.
    h.box.memory.writeU32(vblock + BUFFER.LOCKED, 1);
    h.box.memory.writeU32(vblock + BUFFER.FROM, 0);
    h.box.memory.writeU32(vblock + BUFFER.TO, 64);
    counted(h, block, SHADOW.LOCK_CALLS, 1);
    const bits = 0xe300;
    assert.equal(h.buffer(vb, 'Lock', [0, 0, bits, 0]), D3DERR_INVALIDCALL);
    h.box.memory.writeU32(vblock + BUFFER.LOCKED, 0);
    h.box.memory.writeU32(block + SHADOW.RING, vblock);
    h.box.memory.writeU32(block + SHADOW.RING_HEAD, 1);
    counted(h, block, SHADOW.UNLOCK_CALLS, 1);
    assert.equal(h.buffer(vb, 'Lock', [0, 0, bits, 0]), D3D_OK);
    assert.equal(h.box.memory.readU32(vblock + BUFFER.LOCKED), 1, 'the guest routine sees it');
    assert.equal(h.buffer(vb, 'Unlock'), D3D_OK);
    assert.equal(h.box.memory.readU32(vblock + BUFFER.LOCKED), 0);
    assert.equal(h.libraries.shadow().buffers, 1);
    assert.deepEqual(h.divergences, []);
});

test('a level obtained in the guest leaves the count where the host path leaves it', ()=>{
    // GetSurfaceLevel takes a reference on the surface it hands back, and a
    // level's surface shares its texture's count. The guest routine cannot
    // take one, so it counts what it owes and the host charges the count
    // before any reference is read or given back -- and if that is wrong in
    // either direction, a program that asks for a level every frame either
    // leaks its texture or loses it while it is still drawing with it.
    const h = seamed({ shadow: true });
    const device = h.createDevice(h.create());
    const out = 0xe500;
    assert.equal(h.device(device,
        'CreateTexture', [8, 8, 2, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out]), D3D_OK);
    const texture = h.box.memory.readU32(out);
    const block = h.box.memory.readU32(texture + 4);
    assert.notEqual(block, 0, 'the texture was handed out with its block in place');
    assert.equal(h.box.memory.readU32(block + TEXTURE.LEVEL_COUNT), 2);
    assert.equal(h.box.memory.readU32(block + TEXTURE.LEVELS), 0, 'nothing published yet');
    const object = h.object(texture);
    const held = object.refCount;

    // The host's path, which is what the routine falls back to: it publishes
    // the level and fills its slot in.
    assert.equal(h.box.trap(texture, 'GetSurfaceLevel', [0, out]), D3D_OK);
    const level = h.box.memory.readU32(out);
    assert.notEqual(level, 0);
    assert.equal(h.box.memory.readU32(block + TEXTURE.LEVELS), level);
    assert.equal(object.refCount, held + 1, 'the reference the call owes');
    assert.equal(h.release(level), held, 'and the program gives it back');
    assert.equal(object.refCount, held);

    // What the guest routine does with the slot now filled: the pointer, and
    // the reference counted rather than taken.
    h.box.memory.writeU32(block + TEXTURE.REFS, 1);
    assert.equal(h.release(level), held, 'charged, then given back');
    assert.equal(object.refCount, held, 'the same count the host path left');
    assert.equal(h.libraries.shadow().surfaceLevelCalls, 1);

    // And the count is honest while the program still holds such a level: a
    // Release of the texture cannot take it to zero under the program.
    h.box.memory.writeU32(block + TEXTURE.REFS, 2);
    assert.equal(h.release(texture), 1, 'the level the guest took keeps it alive');
    assert.equal(object.refCount, 1);
    assert.equal(h.release(level), 0);
    assert.equal(object.refCount, 0, 'and the last reference is the one that ends it');
    assert.deepEqual(h.divergences, []);
});

test('the cursor a program sets reaches whoever shows the frame, bitmap and hot spot', ()=>{
    const h = seamed();
    const device = h.createDevice(h.create());
    const out = 0xe400;
    assert.equal(h.device(device, 'CreateImageSurface', [2, 2, D3DFMT.A8R8G8B8, out]), D3D_OK);
    const surface = h.box.memory.readU32(out);
    // Four texels, written the way a program writes them: through a lock.
    const locked = 0xe500;
    assert.equal(h.surface(surface, 'LockRect', [locked, 0, 0]), D3D_OK);
    const bits = h.box.memory.readU32(locked + 4);
    h.box.services.writeMemory(bits, new Uint8Array([
        1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 0, 10, 11, 12, 128,
    ]));
    assert.equal(h.surface(surface, 'UnlockRect', []), D3D_OK);

    assert.equal(h.device(device, 'SetCursorProperties', [1, 0, surface]), D3D_OK);
    assert.equal(h.cursors.length, 1);
    assert.deepEqual(h.cursors[0].hotSpot, { x: 1, y: 0 });
    assert.equal(h.cursors[0].width, 2);
    assert.equal(h.cursors[0].shown, false);
    assert.deepEqual([...h.cursors[0].bgra.slice(0, 8)], [1, 2, 3, 255, 4, 5, 6, 255],
        'the texels as the surface holds them');

    assert.equal(h.device(device, 'ShowCursor', [1]), 0, 'it was hidden before');
    assert.equal(h.cursors[1].shown, true);
    assert.equal(h.device(device, 'ShowCursor', [0]), 1);
    assert.equal(h.device(device, 'SetCursorProperties', [5, 5, surface]), D3DERR_INVALIDCALL,
        'a hot spot outside the bitmap is refused, and nobody is told');
    assert.equal(h.cursors.length, 3);

    // The same cursor set again, as a program does every frame, crosses nothing.
    assert.equal(h.device(device, 'SetCursorProperties', [1, 0, surface]), D3D_OK);
    assert.equal(h.device(device, 'ShowCursor', [0]), 0);
    assert.equal(h.cursors.length, 3, 'nothing changed, nobody is told');
    assert.equal(h.surface(surface, 'LockRect', [locked, 0, 0]), D3D_OK);
    h.box.services.writeMemory(bits, new Uint8Array([9, 9, 9, 255]));
    assert.equal(h.surface(surface, 'UnlockRect', []), D3D_OK);
    assert.equal(h.device(device, 'SetCursorProperties', [1, 0, surface]), D3D_OK);
    assert.equal(h.cursors.length, 4, 'a repainted bitmap is a change');
    assert.deepEqual([...h.cursors[3].bgra.slice(0, 4)], [9, 9, 9, 255]);
});

test('creating a device reports its resolution as the screen the program now has', ()=>{
    const h = seamed();
    const device = h.createDevice(h.create());
    assert.notEqual(device, 0);
    // createDevice builds present parameters at 64x64 (see the fixture).
    assert.deepEqual(h.resolutions.at(-1), [64, 64, HWND, false],
        'the back buffer size a device was created at is reported, with its window, windowed');
});

test('a fullscreen device names the window it takes with it', ()=>{
    // The real device places its window at the mode's size; the window is
    // named so whoever answers can do the same, and fullscreen is the signal.
    const h = seamed();
    assert.notEqual(h.createDevice(h.create(), { Windowed: 0, hDeviceWindow: 0x777 }), 0);
    assert.deepEqual(h.resolutions.at(-1), [64, 64, 0x777, true]);
});

test('a device with no window of its own presents into the focus window', ()=>{
    const h = seamed();
    assert.notEqual(h.createDevice(h.create(), { Windowed: 0, hDeviceWindow: 0 }), 0);
    assert.equal(h.resolutions.at(-1)?.[2], HWND, 'hFocusWindow, as CreateDevice was given');
});

test('a reset that changes the mode names the window it presents into', ()=>{
    // Leaving fullscreen resets to the windowed size, and the window has to be
    // named then too: a window left at the mode's size leaves the program
    // clipping its cursor to a rectangle the picture no longer fills.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const at = 0x2200;
    /** @param {Record<string, number>} over */
    const write = over=>{
        h.box.services.writeMemory(at, new Uint8Array(D3DPRESENT_PARAMETERS8.SIZE));
        h.fields.writeStruct(at, D3DPRESENT_PARAMETERS8, {
            BackBufferWidth: 64, BackBufferHeight: 64, BackBufferFormat: D3DFMT.X8R8G8B8,
            BackBufferCount: 1, SwapEffect: 1, hDeviceWindow: HWND, Windowed: 1, ...over,
        });
    };

    write({ BackBufferWidth: 320, BackBufferHeight: 240, Windowed: 0 });
    assert.equal(h.device(device, 'Reset', [at]), D3D_OK);
    assert.deepEqual(h.resolutions.at(-1), [320, 240, HWND, true], 'fullscreen names the window');

    write({});
    assert.equal(h.device(device, 'Reset', [at]), D3D_OK);
    assert.deepEqual(h.resolutions.at(-1), [64, 64, HWND, false],
        'and so does the reset back to windowed');
});

test('a texture, a stage state and a material the guest wrote reach the device', ()=>{
    const h = seamed({ shadow: true });
    const device = h.createDevice(h.create());
    const block = h.box.memory.readU32(device + 4);
    const out = 0xe000;
    const created = 0xe100;
    assert.equal(h.device(device, 'CreateTexture', [8, 8, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
        created]), D3D_OK);
    const texture = h.box.memory.readU32(created);
    const object = h.object(texture);

    // What the guest routines leave: a pointer in a stage slot, a value in
    // the stage table, seventeen floats, and a count for each.
    h.box.memory.writeU32(block + SHADOW.TEXTURES + 3 * 4, texture);
    counted(h, block, SHADOW.TEXTURE_CALLS, 1);
    h.box.memory.writeU32(block + SHADOW.STAGE_STATES + (3 * 32 + D3DTSS.COLOROP) * 4, D3DTOP.ADD);
    h.box.memory.writeU32(block + SHADOW.STAGE_STATE_MARKS + 3 * 4, 1 << D3DTSS.COLOROP);
    counted(h, block, SHADOW.STAGE_STATE_CALLS, 1);
    const material = 0xe300;
    h.fields.writeF32(block + SHADOW.MATERIAL + 16 * 4, 12.5);   // Power
    counted(h, block, SHADOW.MATERIAL_CALLS, 1);

    assert.equal(h.device(device, 'GetTexture', [3, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), texture, 'bound to the texture the guest named');
    h.release(texture);   // GetTexture's own reference
    assert.equal(h.device(device, 'GetTextureStageState', [3, D3DTSS.COLOROP, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), D3DTOP.ADD);
    assert.equal(h.device(device, 'GetMaterial', [material]), D3D_OK);
    assert.equal(h.fields.readF32(material + 16 * 4), 12.5);
    assert.equal(h.libraries.shadow().textureCalls, 1);
    assert.equal(h.libraries.shadow().stageStateCalls, 1);
    assert.equal(h.libraries.shadow().materialCalls, 1);
    assert.deepEqual(h.divergences, []);

    // The program binds through the guest and lets go of its reference
    // before the host has looked. The release adopts the binding while the
    // pointer still names the texture -- adopted after, it would be a
    // pointer nobody published, and a divergence -- and the slot reads
    // stale after, so the device keeps the texture until the program binds
    // something else there.
    assert.equal(h.device(device, 'CreateTexture', [8, 8, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
        created]), D3D_OK);
    const second = h.box.memory.readU32(created);
    h.box.memory.writeU32(block + SHADOW.TEXTURES, second);
    counted(h, block, SHADOW.TEXTURE_CALLS, 2);
    assert.equal(h.release(second), 0);
    assert.equal(h.object(second), null, 'the program holds nothing');
    assert.equal(h.box.memory.readU32(block + SHADOW.TEXTURES), STALE_POINTER);
    assert.equal(h.libraries.shadow().textureCalls, 2, 'adopted by the release');
    assert.deepEqual(h.divergences, []);

    // The next texture may well be published at the released pointer; bound
    // through the guest, the slot changes from stale and the new one is
    // what the device gets.
    assert.equal(h.device(device, 'CreateTexture', [8, 8, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
        created]), D3D_OK);
    const third = h.box.memory.readU32(created);
    h.box.memory.writeU32(block + SHADOW.TEXTURES, third);
    counted(h, block, SHADOW.TEXTURE_CALLS, 3);
    assert.equal(h.device(device, 'GetTexture', [0, out]), D3D_OK);
    assert.equal(h.object(h.box.memory.readU32(out)), h.object(third));
    h.release(h.box.memory.readU32(out));

    // Unbinding through the guest leaves it, and a stage the program never
    // wrote is left alone whatever the device holds.
    h.box.memory.writeU32(block + SHADOW.TEXTURES, 0);
    counted(h, block, SHADOW.TEXTURE_CALLS, 4);
    assert.equal(h.device(device, 'GetTexture', [0, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), 0);
    assert.equal(h.device(device, 'GetTexture', [3, out]), D3D_OK);
    assert.equal(h.object(h.box.memory.readU32(out)), object);
    h.release(h.box.memory.readU32(out));
    h.release(third);
    h.release(texture);
    assert.deepEqual(h.divergences, []);
});

test('a surface description fills every field, leaving no stack of the caller to be read',
    ()=>{
        // A descriptor is written into memory the program supplied, which for
        // this call is a local. A field nobody fills keeps whatever was on that
        // stack, and the program reads a number we never gave it -- so this
        // fills the struct with a sentinel first and asserts not one dword of it
        // survives. `Size` is the field that made this fatal: it is the
        // surface's length in bytes, and a program sizing a copy from it was
        // sizing it from its own garbage.
        const h = seamed();
        const root = h.create();
        const device = h.createDevice(root);

        const back = 0xa100;
        assert.equal(h.device(device, 'GetBackBuffer', [0, 0, back]), D3D_OK);
        const surface = h.box.memory.readU32(back);

        const desc = 0xa300;
        const SENTINEL = 0xdeadbeef;
        for (let at = 0; at < D3DSURFACE_DESC8.SIZE; at += 4)
        {
            h.fields.writeU32(desc + at, SENTINEL);
        }
        assert.equal(h.surface(surface, 'GetDesc', [desc]), D3D_OK);

        /** @type {string[]} */
        const untouched = [];
        for (const [name, offset] of Object.entries(D3DSURFACE_DESC8))
        {
            if (name === 'SIZE')
            {
                continue;
            }
            if (h.fields.readU32(desc + offset) === SENTINEL)
            {
                untouched.push(name);
            }
        }
        assert.deepEqual(untouched, [], 'every field of the descriptor was written');

        // And the one that decides a length says the surface's own length.
        assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Size),
            h.fields.readU32(desc + D3DSURFACE_DESC8.Width) * 4
                * h.fields.readU32(desc + D3DSURFACE_DESC8.Height),
            'Size is the whole surface in bytes at four bytes a pixel');
        assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.MultiSampleType), 0);

        assert.equal(h.release(surface), 0);
        assert.equal(h.release(device), 0);
        h.release(root);
    });

test('a back buffer asked for as zero by zero is the window, described and stored as one', ()=>{
    // Windowed, zero means the size of the device window, which is what the
    // real device answers. Carried through as a zero it describes a surface
    // with no rows and no storage, which the program then reads with its own
    // idea of the mode -- and that read used to land in the slack of a
    // fixed-megabyte allocation rather than in the next object.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root, {
        BackBufferWidth: 0, BackBufferHeight: 0, Windowed: 1,
        BackBufferFormat: D3DFMT.X8R8G8B8,
    });

    const back = 0xa100;
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, back]), D3D_OK);
    const surface = h.box.memory.readU32(back);

    const desc = 0xa300;
    assert.equal(h.surface(surface, 'GetDesc', [desc]), D3D_OK);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Width), 640);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Height), 480);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Size), 640 * 4 * 480,
        'and its length is that surface, not nothing');

    // Measured rather than assumed, so there is nothing to report.
    assert.deepEqual(h.divergences, []);

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a back buffer asked for as zero by zero, with no window to measure, is the display', ()=>{
    const h = seamed({ windowClientSize: ()=>null });
    const root = h.create();
    const device = h.createDevice(root, {
        BackBufferWidth: 0, BackBufferHeight: 0, Windowed: 1,
        BackBufferFormat: D3DFMT.X8R8G8B8,
    });

    const back = 0xa100;
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, back]), D3D_OK);
    const surface = h.box.memory.readU32(back);

    const desc = 0xa300;
    assert.equal(h.surface(surface, 'GetDesc', [desc]), D3D_OK);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Width), SCREEN.width);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Height), SCREEN.height);

    // And the program is told the size was not its own.
    assert.ok(h.divergences.some(line=>/zero by zero/.test(line)),
        'the assumption is reported rather than made quietly');

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('the guest routines a device writes come from the code pages, not the heap beside its state',
    ()=>{
        // Code beside state the program writes is code a translator keeps
        // finding stored into, and leaves to its interpreter for good.
        /** @type {[number, number][]} */
        const code = [];
        const h = seamed({ shadow: true, allocateCode: (/** @type {number} */ size)=>{
            const at = 0xf000 + code.length * 0x100;
            code.push([at, size]);
            return at;
        } });
        const device = h.createDevice(h.create());
        const out = 0xe500;
        assert.equal(h.device(device,
            'CreateTexture', [8, 8, 2, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out]), D3D_OK);
        assert.ok(code.length > 0, 'a guest routine was placed');
        assert.ok(code.every(([, size])=>size > 0 && size <= 0x100));
    });

test('an additional swap chain has back buffers of its own, and writes back only its count',
    ()=>{
        // Wine's d3d8 test_swapchain.
        const h = seamed();
        const root = h.create();
        const device = h.createDevice(root);
        const at = 0xe400;
        const out = 0xe000;
        /** @param {Record<string, number>} fields */
        const parameters = fields=>{
            h.box.services.writeMemory(at, new Uint8Array(D3DPRESENT_PARAMETERS8.SIZE));
            h.fields.writeStruct(at, D3DPRESENT_PARAMETERS8, {
                Windowed: 1, SwapEffect: 1, BackBufferFormat: D3DFMT.A8R8G8B8, ...fields,
            });
        };
        /** @param {number} chain @param {string} name @param {number[]} [args] */
        const call = (chain, name, args = [])=>
            h.box.call(chain, slot(IDIRECT3DSWAPCHAIN8_SLOTS, name), args);

        parameters({ BackBufferCount: 0 });
        assert.equal(h.device(device, 'CreateAdditionalSwapChain', [at, out]), D3D_OK);
        const first = h.box.memory.readU32(out);
        const written = h.fields.readStruct(at, D3DPRESENT_PARAMETERS8);
        assert.deepEqual([written.BackBufferWidth, written.BackBufferHeight,
            written.BackBufferFormat, written.BackBufferCount, written.hDeviceWindow],
        [0, 0, D3DFMT.A8R8G8B8, 1, 0], 'the count a zero stood for, and nothing else');
        assert.equal(call(first, 'GetBackBuffer', [0, 0, out]), D3D_OK);
        const back = h.box.memory.readU32(out);
        /** @type {{ desc?: any }} */
        const described = {};
        h.object(back).GetDesc(described);
        assert.deepEqual([described.desc.Width, described.desc.Height], [640, 480],
            'the device window\'s client area');
        h.release(back);
        h.box.memory.writeU32(out, 0xdeadbeef);
        assert.equal(call(first, 'GetBackBuffer', [1, 0, out]), D3DERR_INVALIDCALL);
        assert.equal(h.box.memory.readU32(out), 0xdeadbeef);

        parameters({ BackBufferCount: 2 });
        assert.equal(h.device(device, 'CreateAdditionalSwapChain', [at, out]), D3D_OK);
        const second = h.box.memory.readU32(out);
        assert.equal(call(second, 'GetBackBuffer', [0, 0, 0]), D3DERR_INVALIDCALL);
        assert.equal(call(second, 'GetBackBuffer', [0, 1 /* LEFT */, out]), D3D_OK);
        const left = h.box.memory.readU32(out);
        assert.equal(call(second, 'GetBackBuffer', [0, 0, out]), D3D_OK);
        assert.equal(h.box.memory.readU32(out), left, 'the type is not looked at');
        h.release(left);
        h.release(left);
        assert.equal(call(second, 'GetBackBuffer', [1, 0, out]), D3D_OK);
        h.release(h.box.memory.readU32(out));
        assert.equal(call(second, 'GetBackBuffer', [2, 0, out]), D3DERR_INVALIDCALL);
        assert.equal(call(second, 'Present', [0, 0, 0, 0]), D3D_OK);

        parameters({ Windowed: 0, hDeviceWindow: HWND, BackBufferCount: 1,
            BackBufferWidth: 640, BackBufferHeight: 480 });
        h.box.memory.writeU32(out, 0xdeadbeef);
        assert.equal(h.device(device, 'CreateAdditionalSwapChain', [at, out]),
            D3DERR_INVALIDCALL, 'a chain is windowed or not made');
        assert.equal(h.box.memory.readU32(out), 0);

        assert.equal(h.release(second), 0);
        assert.equal(h.release(first), 0);
        assert.equal(h.release(device), 0);
        h.release(root);
    });

test('an additional chain\'s back buffer counts on the device, and may be taken again from none',
    ()=>{
        // Wine's d3d8 test_refcount: GetBackBuffer takes a reference on the
        // device and none on the chain; released to nothing, the buffer is the
        // chain's still, and AddRef from there is fine.
        const h = seamed();
        const root = h.create();
        const device = h.createDevice(root);
        const at = 0xe400;
        const out = 0xe000;
        h.box.services.writeMemory(at, new Uint8Array(D3DPRESENT_PARAMETERS8.SIZE));
        h.fields.writeStruct(at, D3DPRESENT_PARAMETERS8, {
            Windowed: 1, SwapEffect: 1, BackBufferFormat: D3DFMT.A8R8G8B8,
        });
        assert.equal(h.device(device, 'CreateAdditionalSwapChain', [at, out]), D3D_OK);
        const chain = h.box.memory.readU32(out);
        const onDevice = h.object(device).refCount;
        assert.equal(h.box.call(chain, slot(IDIRECT3DSWAPCHAIN8_SLOTS, 'GetBackBuffer'),
            [0, 0, out]), D3D_OK);
        const back = h.box.memory.readU32(out);
        assert.equal(h.object(chain).refCount, 1, 'the chain took nothing');
        assert.equal(h.object(device).refCount, onDevice + 1, 'the device took one');
        assert.equal(h.release(back), 0);
        assert.equal(h.object(device).refCount, onDevice);
        assert.equal(h.box.call(back, 1, []), 1, 'AddRef from nothing');
        assert.equal(h.object(device).refCount, onDevice + 1);
        assert.equal(h.release(back), 0);
        assert.equal(h.release(chain), 0);
        assert.equal(h.release(device), 0);
        h.release(root);
    });

test('D3DCAPS2_FULLSCREENGAMMA is claimed where a full-screen device\'s ramp is shown', ()=>{
    const h = seamed({ caps: { gamma: { set: ()=>{}, applies: ()=>true } } });
    const root = h.create();
    const at = 0x3200;
    assert.equal(h.box.call(root, slot(IDIRECT3D8_SLOTS, 'GetDeviceCaps'),
        [0, D3DDEVTYPE.HAL, at]), D3D_OK);
    assert.equal(h.fields.readU32(at + D3DCAPS8.Caps2) & 0x00020000, 0x00020000,
        'the adapter says so');
    const device = h.createDevice(root);
    assert.equal(h.device(device, 'GetDeviceCaps', [at]), D3D_OK);
    assert.equal(h.fields.readU32(at + D3DCAPS8.Caps2) & 0x00020000, 0x00020000,
        'and so does the device');
    assert.equal(h.release(device), 0);
    h.release(root);
});

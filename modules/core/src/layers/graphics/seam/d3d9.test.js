/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 9 seam, driven the way a guest drives it: through the bridge's
 * own vtable publisher, by slot number, over a flat buffer standing in for
 * guest memory.
 *
 * What is checked is translation and nothing else -- the object model behind
 * it has its own tests. A structure is read and written at the offsets the
 * header gives, an out-parameter is written when the call succeeded and left
 * alone or cleared when it failed as the method documents, an interface
 * handed back is the same pointer the program already holds where the object
 * is the same object, and a call this build cannot honour says so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import { createDirect3D9Seam } from './d3d9.js';
import { IDIRECT3D9_SLOTS } from './vtables.js';
import {
    D3DDISPLAYMODE, D3DLOCKED_RECT, D3DPRESENT_PARAMETERS9, createFields,
} from './structs.js';
import {
    D3DCAPS9, D3DSURFACE_DESC9, D3DVERTEXELEMENT9, D3DVIEWPORT9,
} from '../d3d9/structs.js';
import {
    IDIRECT3DCUBETEXTURE9_SLOTS, IDIRECT3DDEVICE9_SLOTS, IDIRECT3DQUERY9_SLOTS,
    IDIRECT3DSHADER9_SLOTS,
    IDIRECT3DSTATEBLOCK9_SLOTS, IDIRECT3DSURFACE9_SLOTS, IDIRECT3DTEXTURE9_SLOTS,
    IDIRECT3DVERTEXDECLARATION9_SLOTS,
} from '../d3d9/interfaces.js';
import { D3DCREATE, D3DDEVTYPE, D3DQUERYTYPE, createDirect3D9 } from '../d3d9/device.js';
import { D3DFMT, D3DPOOL, D3DRS } from '../d3d9/constants.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from '../d3d9/declaration.js';
import { END_TOKEN, SHADER_KIND, versionToken } from '../d3d9/shader.js';
import { displayModes } from '../../win32/user32/display.js';
import { createSystemFunctions } from '../../win32/user32/system.js';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTAVAILABLE = 0x8876086a;

const SCREEN = { width: 800, height: 600, bitsPerPixel: 32, displayWidth: 1280,
    displayHeight: 1024 };
const HWND = 0x00010044;
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
    /** @param {number} size */
    const allocate = size=>{
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

        /** @param {number} pointer @param {number} index */
        argBytesOf(pointer, index){
            const table = memory.readU32(pointer);
            return registered.get(memory.readU32(table + index * 4)).fn.argBytes;
        },
    };
}

/**
 * The seam over a root, as the entry point would publish it.
 *
 * @param {{ caps?: object,
 *           windowClientSize?: ((window: number) => { width: number,
 *               height: number } | null) | null }} [options]
 */
function seamed(options = {}){
    const box = machine();
    /** @type {string[]} */
    const divergences = [];
    /** @type {(number | boolean | string | undefined)[][]} */
    const resolutions = [];
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    // One measurable window, so a size asked for as zero has a client area to
    // be answered with; a test that wants the unmeasurable path passes null.
    /** @param {number} window */
    const measure = window=>{
        return window === HWND ? { width: 640, height: 480 } : null;
    };
    const windowClientSize = options.windowClientSize ?? measure;
    /** The display's clock, which a test moves. */
    const clock = { time: 0 };
    /** Device contexts handed out over surfaces, by handle. @type {Map<number, any>} */
    const dcs = new Map();
    const seam = createDirect3D9Seam({
        publisher,
        memory: box.services,
        gdi: {
            /** @param {any} attributes */
            createSurfaceDc: attributes=>{
                const handle = 0x7700 + dcs.size;
                dcs.set(handle, attributes);
                return handle;
            },
            /** @param {number} handle */
            deleteSurfaceDc: handle=>{
                dcs.delete(handle);
            },
        },
        screen: ()=>SCREEN,
        now: ()=>clock.time,
        windowClientSize,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        /** @param {number} w @param {number} h
         *  @param {{ window?: number, fullscreen?: boolean, announce?: boolean }} [where] */
        resolution: (w, h, where)=>resolutions.push(where?.announce
            ? [w, h, where?.window, where?.fullscreen, 'announced']
            : [w, h, where?.window, where?.fullscreen]),
        identity: ()=>({ vendor: 'nvidia', architecture: 'ampere', description: '' }),
    });
    // The device reports its own divergences: the assembling caller hands
    // the same sink to both, and so does this.
    const root = createDirect3D9({
        ...options.caps,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    });
    const fields = createFields(box.services);

    return {
        box,
        fields,
        clock,
        dcs,
        publisher,
        seam,
        root,
        divergences,
        resolutions,
        create: ()=>seam.publishRoot(root),
        /**
         * @param {number} pointer
         * @param {Record<string, number>} parameters
         * @param {number} [behaviour]
         */
        createDevice(pointer, parameters = {}, behaviour = D3DCREATE.HARDWARE_VERTEXPROCESSING){
            const at = 0x2000;
            box.services.writeMemory(at, new Uint8Array(D3DPRESENT_PARAMETERS9.SIZE));
            fields.writeStruct(at, D3DPRESENT_PARAMETERS9, {
                BackBufferWidth: 64,
                BackBufferHeight: 64,
                BackBufferFormat: D3DFMT.X8R8G8B8,
                BackBufferCount: 1,
                SwapEffect: 1,
                hDeviceWindow: HWND,
                Windowed: 1,
                ...parameters,
            });
            box.memory.writeU32(0x2100, 0xdeadbeef);
            const hr = box.call(pointer, slot(IDIRECT3D9_SLOTS, 'CreateDevice'),
                [0, D3DDEVTYPE.HAL, HWND, behaviour, at, 0x2100]);
            return { hr, device: box.memory.readU32(0x2100), parameters: at };
        },
        /** @param {number} device @param {string} name @param {number[]} args */
        device: (device, name, args = [])=>
            box.call(device, slot(IDIRECT3DDEVICE9_SLOTS, name), args),
        /** @param {number} pointer */
        release: pointer=>box.call(pointer, 2, []),
        /** @param {number} pointer */
        object: pointer=>publisher.objectAt(pointer),
    };
}

test('the root makes a device and describes itself in the shape the header gives', ()=>{
    const h = seamed();
    const root = h.create();
    const { hr, device, parameters } = h.createDevice(root);
    assert.equal(hr, D3D_OK);
    assert.notEqual(device, 0);
    assert.deepEqual(h.resolutions, [[64, 64, HWND, false]]);
    // The count a zero stood for is written back, as this version does.
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferCount), 1);

    // The device's own vtable has every slot, at this version's argument sizes.
    assert.equal(IDIRECT3DDEVICE9_SLOTS.length, 116);
    assert.equal(h.box.argBytesOf(device, slot(IDIRECT3DDEVICE9_SLOTS, 'CreateTexture')), 36);
    assert.equal(h.box.argBytesOf(device, slot(IDIRECT3DDEVICE9_SLOTS, 'DrawIndexedPrimitive')),
        28);
    assert.equal(h.box.argBytesOf(device, slot(IDIRECT3DDEVICE9_SLOTS, 'CreateQuery')), 12);

    // The capability block: zeroed, then written; the shader versions say
    // this device runs none, and the texture limits are not zero.
    const caps = 0x3000;
    h.box.services.writeMemory(caps, new Uint8Array(D3DCAPS9.SIZE).fill(0xcd));
    assert.equal(h.device(device, 'GetDeviceCaps', [caps]), D3D_OK);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.DeviceType), D3DDEVTYPE.HAL);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.VertexShaderVersion), 0xfffe0200);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.PixelShaderVersion), 0xffff0200);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.MaxTextureWidth), 4096);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.NumSimultaneousRTs), 1);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.MaxPixelShader30InstructionSlots), 0,
        'the last field was written, so nothing past it was');
    assert.equal(h.fields.readF32(caps + D3DCAPS9.MaxPointSize), 64);
    assert.equal(h.device(device, 'GetDeviceCaps', [0]), D3DERR_INVALIDCALL);

    // The same block through the root, for the type asked about.
    assert.equal(h.box.call(root, slot(IDIRECT3D9_SLOTS, 'GetDeviceCaps'),
        [0, D3DDEVTYPE.REF, caps]), D3D_OK);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.DeviceType), D3DDEVTYPE.REF);

    // The display mode, through both.
    const mode = 0x3200;
    assert.equal(h.device(device, 'GetDisplayMode', [0, mode]), D3D_OK);
    assert.equal(h.fields.readU32(mode + D3DDISPLAYMODE.Width), SCREEN.width);
    assert.equal(h.device(device, 'GetDisplayMode', [1, mode]), D3DERR_INVALIDCALL,
        'one swap chain');

    assert.equal(h.device(device, 'GetNumberOfSwapChains'), 1);
    assert.ok(h.device(device, 'GetAvailableTextureMem') > 0);
    assert.equal(h.device(device, 'TestCooperativeLevel'), D3D_OK);

    assert.equal(h.release(device), 0);
    assert.equal(h.object(device), null);
    h.release(root);
    assert.equal(h.root.refCount, 0);
});

test('the raster status follows the display\'s clock, which the caps say can be read', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const caps = 0x3000;
    assert.equal(h.device(device, 'GetDeviceCaps', [caps]), D3D_OK);
    assert.equal(h.fields.readU32(caps + D3DCAPS9.Caps) & 0x00020000, 0x00020000,
        'D3DCAPS_READ_SCANLINE');

    const status = 0x3100;
    const read = ()=>[h.fields.readU32(status), h.fields.readU32(status + 4)];
    const period = 1000 / 60;
    h.clock.time = period / 2;
    assert.equal(h.device(device, 'GetRasterStatus', [0, status]), D3D_OK);
    assert.deepEqual(read(), [0, 328], 'half of 600 visible lines and 56 blank ones');
    h.clock.time = period - 0.1;
    assert.equal(h.device(device, 'GetRasterStatus', [0, status]), D3D_OK);
    assert.deepEqual(read(), [1, 0], 'in the blank, with the line to be ignored');
    assert.equal(h.device(device, 'GetRasterStatus', [1, status]), D3DERR_INVALIDCALL,
        'one swap chain');

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a fullscreen device names the window it takes with it', ()=>{
    // The real device places its window at the mode's size; the window is
    // named so whoever answers can do the same, and fullscreen is the signal.
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root, { Windowed: 0, hDeviceWindow: 0x777 });
    assert.notEqual(device, 0);
    assert.deepEqual(h.resolutions.at(-1), [64, 64, 0x777, true]);
});

test('a fullscreen device tells its window the mode at its first frame, once', ()=>{
    // A mode switch resizes the window and the program hears WM_SIZE for it
    // once its device exists. A window already at the mode's size hears
    // nothing from the placement at creation, so the first frame says it.
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root, { Windowed: 0, hDeviceWindow: 0x777 });
    assert.equal(h.resolutions.length, 1, 'creation placed the window');
    assert.equal(h.device(device, 'Present', [0, 0, 0, 0]), D3D_OK);
    assert.deepEqual(h.resolutions.at(-1), [64, 64, 0x777, true, 'announced']);
    assert.equal(h.device(device, 'Present', [0, 0, 0, 0]), D3D_OK);
    assert.equal(h.resolutions.length, 2, 'the second frame says nothing');

    const windowed = h.createDevice(h.create()).device;
    const before = h.resolutions.length;
    assert.equal(h.device(windowed, 'Present', [0, 0, 0, 0]), D3D_OK);
    assert.equal(h.resolutions.length, before, 'a windowed device has no mode to announce');
});

test('a reset that changes the mode names the window it presents into', ()=>{
    // Leaving fullscreen resets to the windowed size, and the window has to be
    // named then too: a window left at the mode's size leaves the program
    // clipping its cursor to a rectangle the picture no longer fills.
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const at = 0x2200;
    /** @param {Record<string, number>} over */
    const write = over=>{
        h.box.services.writeMemory(at, new Uint8Array(D3DPRESENT_PARAMETERS9.SIZE));
        h.fields.writeStruct(at, D3DPRESENT_PARAMETERS9, {
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

test('a device is refused for the behaviour a program must not ask with', ()=>{
    const h = seamed();
    const root = h.create();
    for (const behaviour of [0, D3DCREATE.HARDWARE_VERTEXPROCESSING
        | D3DCREATE.SOFTWARE_VERTEXPROCESSING, D3DCREATE.FPU_PRESERVE])
    {
        const { hr, device } = h.createDevice(root, {}, behaviour);
        assert.equal(hr, D3DERR_INVALIDCALL);
        assert.equal(device, 0, 'the pointer is cleared');
    }
    assert.equal(h.box.call(root, slot(IDIRECT3D9_SLOTS, 'CreateDevice'),
        [1, D3DDEVTYPE.HAL, HWND, D3DCREATE.HARDWARE_VERTEXPROCESSING, 0x2000, 0x2100]),
    D3DERR_INVALIDCALL, 'no second adapter');
    assert.equal(h.resolutions.length, 0);
    h.release(root);
});

test('a zero back buffer size windowed is the window\'s client area, written back', ()=>{
    // Zero means the client area of the device window, which is what the real
    // device answers. Answered with the display instead, a program lays out and
    // rasterises against a screen its window does not have -- and the size it is
    // told is one no window can be placed at.
    const h = seamed();
    const root = h.create();
    const { hr, device, parameters } = h.createDevice(root, {
        BackBufferWidth: 0, BackBufferHeight: 0, BackBufferFormat: 0, BackBufferCount: 0,
    });
    assert.equal(hr, D3D_OK);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferWidth), 640);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferHeight), 480);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferFormat),
        D3DFMT.X8R8G8B8);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferCount), 1);
    assert.deepEqual(h.resolutions.at(-1), [640, 480, HWND, false],
        'and the screen the program is told it has is its window');
    assert.deepEqual(h.divergences, [], 'a window that was measured is not an assumption');
    h.release(device);
    h.release(root);
});

test('a zero back buffer size with no window to measure falls back to the display', ()=>{
    // The window the parameters name is the focus window a creation was given;
    // one that measures nothing leaves the display as the nearest size, which
    // is an assumption and is reported as one.
    const h = seamed({ windowClientSize: ()=>null });
    const root = h.create();
    const { hr, device, parameters } = h.createDevice(root, {
        BackBufferWidth: 0, BackBufferHeight: 0,
    });
    assert.equal(hr, D3D_OK);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferWidth),
        SCREEN.width);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferHeight),
        SCREEN.height);
    assert.ok(h.divergences.some(line=>/zero by zero/.test(line)),
        'the assumption is reported rather than made quietly');
    h.release(device);
    h.release(root);
});

test('a fullscreen device asked for zero by zero is not made at zero', ()=>{
    // A fullscreen device's back buffer is the mode, and Direct3D refuses the
    // creation outright rather than carrying a zero. The display stands for the
    // mode here: a device made at zero leaves the program computing every
    // layout against a screen that is not there.
    const h = seamed();
    const root = h.create();
    const { hr, device, parameters } = h.createDevice(root, {
        BackBufferWidth: 0, BackBufferHeight: 0, Windowed: 0, hDeviceWindow: 0x777,
    });
    assert.equal(hr, D3D_OK);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferWidth),
        SCREEN.width);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferHeight),
        SCREEN.height);
    assert.deepEqual(h.resolutions.at(-1), [SCREEN.width, SCREEN.height, 0x777, true]);
    h.release(device);
    h.release(root);
});

test('the adapter lists its modes per format, bounded by the display and not the mode', ()=>{
    const h = seamed();
    const root = h.create();
    /** @param {string} name @param {number[]} args */
    const ask = (name, args)=>h.box.call(root, slot(IDIRECT3D9_SLOTS, name), args);
    const expected = displayModes(SCREEN);
    assert.ok(expected.some(mode=>mode.width > SCREEN.width), 'larger than the mode in effect');
    assert.equal(ask('GetAdapterModeCount', [0, D3DFMT.X8R8G8B8]), expected.length);
    assert.equal(ask('GetAdapterModeCount', [0, D3DFMT.R5G6B5]), expected.length);
    assert.equal(ask('GetAdapterModeCount', [0, D3DFMT.D24S8]), 0, 'not an adapter format');
    assert.equal(ask('GetAdapterModeCount', [1, D3DFMT.X8R8G8B8]), 0, 'no second adapter');

    const mode = 0x3200;
    const last = expected.length - 1;
    assert.equal(ask('EnumAdapterModes', [0, D3DFMT.R5G6B5, last, mode]), D3D_OK);
    assert.equal(h.fields.readU32(mode + D3DDISPLAYMODE.Width), expected[last].width);
    assert.equal(h.fields.readU32(mode + D3DDISPLAYMODE.Height), expected[last].height);
    assert.equal(h.fields.readU32(mode + D3DDISPLAYMODE.Format), D3DFMT.R5G6B5,
        'the format asked for, not the display\'s');
    assert.equal(ask('EnumAdapterModes', [0, D3DFMT.X8R8G8B8, expected.length, mode]),
        D3DERR_INVALIDCALL);
    assert.equal(ask('EnumAdapterModes', [0, D3DFMT.X8R8G8B8, 0, 0]), D3DERR_INVALIDCALL);

    assert.equal(ask('GetAdapterCount', []), 1);
    assert.equal(ask('CheckDeviceType', [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, D3DFMT.X8R8G8B8, 1]),
        D3D_OK);
    assert.equal(ask('CheckDeviceFormatConversion', [0, D3DDEVTYPE.HAL, D3DFMT.R5G6B5,
        D3DFMT.X8R8G8B8]), D3D_OK);
    const quality = 0x3300;
    assert.equal(ask('CheckDeviceMultiSampleType', [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 1, 0,
        quality]), D3D_OK);
    assert.equal(h.fields.readU32(quality), 1);
    assert.equal(ask('CheckDeviceMultiSampleType', [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 1, 4,
        quality]), D3DERR_NOTAVAILABLE);
    // The monitor is the one user32 names for every window, so the handle
    // goes straight into GetMonitorInfo (Wine's d3d9 device.c requires
    // !!monitor); an adapter that does not exist has none.
    const user32 = createSystemFunctions({ host: {}, live: ()=>null, windows: new Map(),
        classes: new Map() });
    assert.equal(ask('GetAdapterMonitor', [0]), user32.MonitorFromWindow.handler());
    assert.notEqual(ask('GetAdapterMonitor', [0]), 0);
    assert.equal(ask('GetAdapterMonitor', [1]), 0);
    assert.equal(ask('RegisterSoftwareDevice', [0x1234]), D3D_OK);
    h.release(root);
});

test('a texture is made without a shared handle, described and locked at this version\'s offsets',
    ()=>{
        const h = seamed();
        const root = h.create();
        const { device } = h.createDevice(root);
        const out = 0x3000;
        assert.equal(h.device(device, 'CreateTexture',
            [8, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out, 0x4000]), D3DERR_INVALIDCALL,
        'a shared handle is the extended interface\'s');
        assert.equal(h.device(device, 'CreateTexture',
            [8, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out, 0]), D3D_OK);
        const texture = h.box.memory.readU32(out);
        assert.notEqual(texture, 0);
        /** @param {string} name @param {number[]} args */
        const call = (name, args)=>h.box.call(texture, slot(IDIRECT3DTEXTURE9_SLOTS, name), args);

        assert.equal(call('GetType', []), 3, 'D3DRTYPE_TEXTURE');
        assert.equal(call('GetLevelCount', []), 1);
        assert.equal(call('GetAutoGenFilterType', []), 2);
        const desc = 0x3100;
        assert.equal(call('GetLevelDesc', [0, desc]), D3D_OK);
        assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC9.Width), 8);
        assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC9.Height), 4);
        assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC9.Format), D3DFMT.A8R8G8B8);
        assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC9.MultiSampleQuality), 0);

        const locked = 0x3200;
        assert.equal(call('LockRect', [0, locked, 0, 0]), D3D_OK);
        assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.Pitch), 32);
        assert.ok(h.fields.readU32(locked + D3DLOCKED_RECT.pBits) >= DEVICE_STORAGE);
        assert.equal(call('UnlockRect', [0]), D3D_OK);

        // The device a resource hands back is the pointer the program holds.
        const back = 0x3300;
        assert.equal(call('GetDevice', [back]), D3D_OK);
        assert.equal(h.box.memory.readU32(back), device);
        assert.equal(h.release(device), 2, 'the get took a reference');

        // A level surface, and its own eight resource slots.
        const level = 0x3400;
        assert.equal(call('GetSurfaceLevel', [0, level]), D3D_OK);
        const surface = h.box.memory.readU32(level);
        assert.equal(h.box.call(surface, slot(IDIRECT3DSURFACE9_SLOTS, 'GetType'), []), 1);
        // A device context over the level's own bytes (Wine's d3d9 test_getdc).
        /** @param {string} name @param {number[]} args */
        const onSurface = (name, args)=>
            h.box.call(surface, slot(IDIRECT3DSURFACE9_SLOTS, name), args);
        h.box.memory.writeU32(0x3500, 0x1234);
        assert.equal(onSurface('GetDC', [0]), D3DERR_INVALIDCALL, 'nowhere to write it');
        assert.equal(onSurface('GetDC', [0x3500]), D3D_OK);
        const dc = h.box.memory.readU32(0x3500);
        assert.deepEqual(
            [h.dcs.get(dc)?.width, h.dcs.get(dc)?.height, h.dcs.get(dc)?.bitCount], [8, 4, 32]);
        h.box.memory.writeU32(0x3504, 0x1234);
        assert.equal(onSurface('GetDC', [0x3504]), D3DERR_INVALIDCALL);
        assert.equal(h.box.memory.readU32(0x3504), 0x1234, 'a refused second is left alone');
        assert.equal(call('LockRect', [0, locked, 0, 0]), D3DERR_INVALIDCALL, 'held, not lockable');
        assert.equal(onSurface('ReleaseDC', [dc]), D3D_OK);
        assert.equal(h.dcs.size, 0);
        assert.equal(onSurface('ReleaseDC', [dc]), D3DERR_INVALIDCALL);
        // Private data is each object's own: what the texture keeps, its
        // level does not (Wine's d3d9 test_private_data).
        const guid = 0x3600;
        h.box.services.writeMemory(guid, Uint8Array.from({ length: 16 }, (_, i)=>i + 1));
        const data = 0x3700;
        [1, 2, 3, 4].forEach((value, k)=>h.box.memory.writeU32(data + k * 4, value));
        const sizeAt = 0x3800;
        h.box.memory.writeU32(sizeAt, 16);
        assert.equal(h.box.call(surface, slot(IDIRECT3DSURFACE9_SLOTS, 'SetPrivateData'),
            [0, 0, 0, 0]), D3DERR_INVALIDCALL, 'no GUID and no data');
        assert.equal(call('SetPrivateData', [guid, data, 16, 0]), D3D_OK);
        assert.equal(h.box.call(surface, slot(IDIRECT3DSURFACE9_SLOTS, 'GetPrivateData'),
            [guid, data, sizeAt]), 0x88760866, 'D3DERR_NOTFOUND on the level');
        h.box.services.writeMemory(data, new Uint8Array(16));
        assert.equal(call('GetPrivateData', [guid, data, sizeAt]), D3D_OK);
        assert.deepEqual([0, 1, 2, 3].map(k=>h.box.memory.readU32(data + k * 4)), [1, 2, 3, 4]);
        assert.equal(call('FreePrivateData', [guid]), D3D_OK);
        h.release(surface);
        assert.equal(h.release(texture), 0);
        assert.equal(h.release(device), 0);
        h.release(root);
    });

/**
 * A GUID as DEFINE_GUID spells it, into guest memory.
 *
 * @param {any} h @param {number} at @param {number[]} parts
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

test('a managed resource keeps its priority and level of detail, and nothing else does', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const out = 0x3000;
    /** @param {number} pointer @param {string} name @param {number[]} [args] */
    const call = (pointer, name, args = [])=>
        h.box.call(pointer, slot(IDIRECT3DTEXTURE9_SLOTS, name), args);
    // Wine's d3d9 test_resource_priority: Set answers the priority before,
    // and only the managed pool keeps what it was told -- a texture's level
    // surface never does.
    for (const [pool, keeps] of /** @type {[number, boolean][]} */ ([[D3DPOOL.DEFAULT, false],
        [D3DPOOL.SYSTEMMEM, false], [D3DPOOL.MANAGED, true]]))
    {
        assert.equal(h.device(device, 'CreateTexture',
            [16, 16, 3, 0, D3DFMT.X8R8G8B8, pool, out, 0]), D3D_OK);
        const texture = h.box.memory.readU32(out);
        assert.equal(call(texture, 'GetPriority'), 0);
        assert.equal(call(texture, 'SetPriority', [1]), 0);
        assert.equal(call(texture, 'GetPriority'), keeps ? 1 : 0);
        assert.equal(call(texture, 'SetPriority', [2]), keeps ? 1 : 0);
        assert.equal(call(texture, 'GetSurfaceLevel', [0, out]), D3D_OK);
        const level = h.box.memory.readU32(out);
        /** @param {string} name @param {number[]} [args] */
        const onLevel = (name, args = [])=>
            h.box.call(level, slot(IDIRECT3DSURFACE9_SLOTS, name), args);
        assert.equal(onLevel('SetPriority', [1]), 0);
        assert.equal(onLevel('GetPriority'), 0);
        // Wine's test_lod and maxmip_test: the level of detail is a managed
        // texture's alone, and a level past the last is the last.
        assert.equal(call(texture, 'SetLOD', [1]), 0);
        assert.equal(call(texture, 'GetLOD'), keeps ? 1 : 0);
        assert.equal(call(texture, 'SetLOD', [5]), keeps ? 1 : 0);
        assert.equal(call(texture, 'GetLOD'), keeps ? 2 : 0);
        h.release(level);
        assert.equal(h.release(texture), 0);

        assert.equal(h.device(device, 'CreateVertexBuffer', [64, 0, 0, pool, out, 0]), D3D_OK);
        const buffer = h.box.memory.readU32(out);
        assert.equal(call(buffer, 'SetPriority', [1]), 0);
        assert.equal(call(buffer, 'GetPriority'), keeps ? 1 : 0);
        assert.equal(h.release(buffer), 0);
    }
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a surface names its container: its texture, its swap chain, or its device', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const out = 0x3000;
    const iid = 0x3100;
    const container = 0x3200;
    /** @param {number} surface */
    const containerOf = surface=>{
        h.box.memory.writeU32(container, 0x1337c0d3);
        const hr = h.box.call(surface, slot(IDIRECT3DSURFACE9_SLOTS, 'GetContainer'),
            [iid, container]);
        return { hr, pointer: h.box.memory.readU32(container) };
    };
    assert.equal(h.device(device, 'CreateTexture',
        [128, 128, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, out, 0]), D3D_OK);
    const texture = h.box.memory.readU32(out);
    assert.equal(h.box.call(texture, slot(IDIRECT3DTEXTURE9_SLOTS, 'GetSurfaceLevel'),
        [0, out]), D3D_OK);
    const level = h.box.memory.readU32(out);

    // Wine's d3d9 test_surface_get_container.
    putGuid(h, iid, [0x85c31227, 0x3de5, 0x4f00, 0x9b, 0x3a, 0xf1, 0x1a, 0xc3, 0x8c, 0x18,
        0xb5]);
    assert.deepEqual(containerOf(level), { hr: D3D_OK, pointer: texture },
        'IDirect3DTexture9 is the pointer the program holds');
    h.release(texture);
    putGuid(h, iid, [0x580ca87e, 0x1d3c, 0x4d54, 0x99, 0x1d, 0xb7, 0xd3, 0xe3, 0xc2, 0x98,
        0xce]);
    const base = containerOf(level);
    assert.equal(base.hr, D3D_OK, 'IDirect3DBaseTexture9');
    assert.equal(h.box.call(base.pointer, slot(IDIRECT3DTEXTURE9_SLOTS, 'GetLevelCount')), 1);
    h.release(base.pointer);
    putGuid(h, iid, [0x0cfbaf3a, 0x9ff6, 0x429a, 0x99, 0xb3, 0xa2, 0x79, 0x6a, 0xf8, 0xb8,
        0x9b]);
    assert.deepEqual(containerOf(level), { hr: 0x80004002, pointer: 0 },
        'a surface does not hold a surface');

    // test_refcount: the back buffer's container is the swap chain, a depth
    // stencil's the device.
    putGuid(h, iid, [0x794950f2, 0xadfc, 0x458a, 0x90, 0x5e, 0x10, 0xa1, 0x0b, 0x0b, 0x50,
        0x3b]);
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, 0, out]), D3D_OK);
    const back = h.box.memory.readU32(out);
    assert.equal(h.device(device, 'GetSwapChain', [0, out]), D3D_OK);
    const chain = h.box.memory.readU32(out);
    assert.deepEqual(containerOf(back), { hr: D3D_OK, pointer: chain });
    h.release(chain);
    putGuid(h, iid, [0xd0223b96, 0xbf7a, 0x43fd, 0x92, 0xbd, 0xa4, 0x3b, 0x0d, 0x82, 0xb9,
        0xeb]);
    assert.equal(h.device(device, 'CreateDepthStencilSurface',
        [16, 16, D3DFMT.D24S8, 0, 0, 0, out, 0]), D3D_OK);
    const depth = h.box.memory.readU32(out);
    assert.deepEqual(containerOf(depth), { hr: D3D_OK, pointer: device });
    h.release(device);

    assert.equal(h.release(depth), 0);
    h.release(chain);
    assert.equal(h.release(back), 0);
    assert.equal(h.release(level), 1);
    assert.equal(h.release(texture), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a cube texture is made, and answers for its faces through its own vtable', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const out = 0x3000;
    assert.equal(h.device(device, 'CreateCubeTexture',
        [8, 0, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out, 0x4000]), D3DERR_INVALIDCALL,
    'a shared handle is the extended interface\'s');
    assert.equal(h.device(device, 'CreateCubeTexture',
        [8, 0, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out, 0]), D3D_OK);
    const cube = h.box.memory.readU32(out);
    assert.notEqual(cube, 0);
    /** @param {string} name @param {number[]} [args] */
    const call = (name, args = [])=>
        h.box.call(cube, slot(IDIRECT3DCUBETEXTURE9_SLOTS, name), args);

    assert.equal(call('GetType'), 5, 'D3DRTYPE_CUBETEXTURE');
    assert.equal(call('GetLevelCount'), 4, 'a whole chain for zero levels');
    const desc = 0x3100;
    assert.equal(call('GetLevelDesc', [1, desc]), D3D_OK);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC9.Width), 4);
    assert.equal(call('GetLevelDesc', [4, desc]), D3DERR_INVALIDCALL);

    // Each face locks at its own storage, and one past the sixth is refused.
    const locked = 0x3200;
    assert.equal(call('LockRect', [5, 0, locked, 0, 0]), D3D_OK);
    assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.Pitch), 32);
    const fifth = h.fields.readU32(locked + D3DLOCKED_RECT.pBits);
    assert.equal(call('UnlockRect', [5, 0]), D3D_OK);
    assert.equal(call('UnlockRect', [5, 0]), D3DERR_INVALIDCALL, 'a face owes its unlock');
    assert.equal(call('LockRect', [0, 0, locked, 0, 0]), D3D_OK);
    assert.notEqual(h.fields.readU32(locked + D3DLOCKED_RECT.pBits), fifth);
    assert.equal(call('UnlockRect', [0, 0]), D3D_OK);
    assert.equal(call('LockRect', [6, 0, locked, 0, 0]), D3DERR_INVALIDCALL);
    assert.equal(call('AddDirtyRect', [1, 0]), D3D_OK);
    assert.equal(call('AddDirtyRect', [6, 0]), D3DERR_INVALIDCALL);

    // A face's surface names the cube as its container.
    assert.equal(call('GetCubeMapSurface', [2, 0, out]), D3D_OK);
    const face = h.box.memory.readU32(out);
    const iid = 0x3300;
    putGuid(h, iid, [0xfff32f81, 0xd953, 0x473a, 0x92, 0x23, 0x93, 0xd6, 0x52, 0xab, 0xa9,
        0x3f]);
    assert.equal(h.box.call(face, slot(IDIRECT3DSURFACE9_SLOTS, 'GetContainer'), [iid, out]),
        D3D_OK);
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

test('a volume texture is refused, and the caller\'s pointer cleared', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const out = 0x3000;
    h.box.memory.writeU32(out, 0xdeadbeef);
    assert.equal(h.device(device, 'CreateVolumeTexture',
        [8, 8, 8, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, out, 0]), D3DERR_NOTAVAILABLE);
    assert.equal(h.box.memory.readU32(out), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a declaration is read from the guest to its sentinel and written back with it', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const elements = 0x3000;
    // Position, colour, end: the bytes as the header lays them.
    h.box.services.writeMemory(elements, Uint8Array.from([
        0, 0, 0, 0, D3DDECLTYPE.FLOAT3, 0, D3DDECLUSAGE.POSITION, 0,
        0, 0, 12, 0, D3DDECLTYPE.D3DCOLOR, 0, D3DDECLUSAGE.COLOR, 0,
        0xff, 0, 0, 0, D3DDECLTYPE.UNUSED, 0, 0, 0,
    ]));
    const out = 0x3100;
    assert.equal(h.device(device, 'CreateVertexDeclaration', [elements, out]), D3D_OK);
    const declaration = h.box.memory.readU32(out);
    assert.notEqual(declaration, 0);
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>h.box.call(declaration,
        slot(IDIRECT3DVERTEXDECLARATION9_SLOTS, name), args);

    const count = 0x3200;
    assert.equal(call('GetDeclaration', [0, 0]), D3DERR_INVALIDCALL, 'the count is required');
    assert.equal(call('GetDeclaration', [0, count]), D3D_OK);
    assert.equal(h.fields.readU32(count), 3, 'sentinel included');

    const copy = 0x3300;
    h.fields.writeU32(count, 2);
    assert.equal(call('GetDeclaration', [copy, count]), 0x8876086d, 'D3DERR_MOREDATA');
    assert.equal(h.fields.readU32(count), 3, 'and the count needed is reported');
    h.fields.writeU32(count, 3);
    assert.equal(call('GetDeclaration', [copy, count]), D3D_OK);
    assert.deepEqual(h.box.services.readMemory(copy, 3 * D3DVERTEXELEMENT9.SIZE),
        h.box.services.readMemory(elements, 3 * D3DVERTEXELEMENT9.SIZE));

    assert.equal(h.device(device, 'SetVertexDeclaration', [declaration]), D3D_OK);
    const bound = 0x3400;
    assert.equal(h.device(device, 'GetVertexDeclaration', [bound]), D3D_OK);
    assert.equal(h.box.memory.readU32(bound), declaration, 'the same pointer');
    h.release(declaration);
    const fvf = 0x3500;
    assert.equal(h.device(device, 'GetFVF', [fvf]), D3D_OK);
    assert.equal(h.fields.readU32(fvf), 0, 'a declaration the program made has no format');

    // A format set instead makes a declaration of the device's own, which
    // is handed out like any other and answers GetDevice.
    assert.equal(h.device(device, 'SetFVF', [0x042]), D3D_OK);
    assert.equal(h.device(device, 'GetVertexDeclaration', [bound]), D3D_OK);
    const made = h.box.memory.readU32(bound);
    assert.notEqual(made, declaration);
    const back = 0x3600;
    assert.equal(h.box.call(made, slot(IDIRECT3DVERTEXDECLARATION9_SLOTS, 'GetDevice'), [back]),
        D3D_OK);
    assert.equal(h.box.memory.readU32(back), device);
    h.release(device);
    h.release(made);
    assert.equal(h.device(device, 'SetVertexDeclaration', [0]), D3D_OK);
    assert.equal(h.release(declaration), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a shader is read from the guest up to its end token and handed back as bytes', ()=>{
    const h = seamed({ caps: { vertexShaderVersion: { major: 2, minor: 0 } } });
    const root = h.create();
    const { device } = h.createDevice(root);
    const tokens = [
        versionToken(SHADER_KIND.VERTEX, 2, 0),
        // A comment that happens to contain an end token, which must be
        // stepped over rather than taken as the end.
        (1 << 16) | 0xfffe, END_TOKEN,
        0x02000001, 0x800f0000, 0x90e40000,
        END_TOKEN,
        0xdeadbeef,
    ];
    const at = 0x3000;
    h.box.services.writeMemory(at, new Uint8Array(Uint32Array.from(tokens).buffer));
    const out = 0x3100;
    assert.equal(h.device(device, 'CreateVertexShader', [0, out]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'CreateVertexShader', [at, out]), D3D_OK);
    const shader = h.box.memory.readU32(out);
    assert.notEqual(shader, 0);
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>h.box.call(shader, slot(IDIRECT3DSHADER9_SLOTS, name), args);
    const size = 0x3200;
    assert.equal(call('GetFunction', [0, 0]), D3DERR_INVALIDCALL);
    assert.equal(call('GetFunction', [0, size]), D3D_OK);
    assert.equal(h.fields.readU32(size), (tokens.length - 1) * 4, 'up to the end token');
    const copy = 0x3300;
    h.fields.writeU32(size, 8);
    assert.equal(call('GetFunction', [copy, size]), D3DERR_INVALIDCALL, 'too small');
    h.fields.writeU32(size, (tokens.length - 1) * 4);
    assert.equal(call('GetFunction', [copy, size]), D3D_OK);
    assert.deepEqual([...new Uint32Array(h.box.services.readMemory(copy, 28).buffer)],
        tokens.slice(0, 7));

    // IID_IDirect3DVertexShader9 as d3d9.h defines it: the interface the
    // shader was made as, found by the GUID a program compiled against.
    const iid = 0x3700;
    const queried = 0x3710;
    const guid = new Uint8Array(16);
    const view = new DataView(guid.buffer);
    view.setUint32(0, 0xefc5557e, true);
    view.setUint16(4, 0x6265, true);
    view.setUint16(6, 0x4613, true);
    guid.set([0x8a, 0x94, 0x43, 0x85, 0x78, 0x89, 0xeb, 0x36], 8);
    h.box.services.writeMemory(iid, guid);
    assert.equal(h.box.call(shader, 0, [iid, queried]), D3D_OK);
    assert.equal(h.box.memory.readU32(queried), shader);
    h.release(shader);

    assert.equal(h.device(device, 'SetVertexShader', [shader]), D3D_OK);
    const bound = 0x3400;
    assert.equal(h.device(device, 'GetVertexShader', [bound]), D3D_OK);
    assert.equal(h.box.memory.readU32(bound), shader);
    h.release(shader);

    // Constants: floats in, floats out, at the register named.
    const values = 0x3500;
    h.box.services.writeMemory(values,
        new Uint8Array(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
    assert.equal(h.device(device, 'SetVertexShaderConstantF', [10, values, 2]), D3D_OK);
    assert.equal(h.device(device, 'SetVertexShaderConstantF', [10, 0, 2]), D3DERR_INVALIDCALL);
    const read = 0x3600;
    assert.equal(h.device(device, 'GetVertexShaderConstantF', [11, read, 1]), D3D_OK);
    assert.deepEqual([...new Float32Array(h.box.services.readMemory(read, 16).buffer)],
        [5, 6, 7, 8]);
    assert.equal(h.device(device, 'SetVertexShaderConstantF', [255, values, 2]),
        D3DERR_INVALIDCALL);
    h.box.services.writeMemory(values, new Uint8Array(Int32Array.from([-1, 2, -3, 4]).buffer));
    assert.equal(h.device(device, 'SetVertexShaderConstantI', [0, values, 1]), D3D_OK);
    assert.equal(h.device(device, 'GetVertexShaderConstantI', [0, read, 1]), D3D_OK);
    assert.deepEqual([...new Int32Array(h.box.services.readMemory(read, 16).buffer)],
        [-1, 2, -3, 4]);

    assert.equal(h.device(device, 'SetVertexShader', [0]), D3D_OK);
    assert.equal(h.release(shader), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a shader on a device that runs none is refused with the pointer cleared', ()=>{
    const h = seamed({ caps: { pixelShaderVersion: { major: 0, minor: 0 } } });
    const root = h.create();
    const { device } = h.createDevice(root);
    const at = 0x3000;
    h.box.services.writeMemory(at, new Uint8Array(
        Uint32Array.from([versionToken(SHADER_KIND.PIXEL, 2, 0), END_TOKEN]).buffer));
    const out = 0x3100;
    h.box.memory.writeU32(out, 0xdeadbeef);
    assert.equal(h.device(device, 'CreatePixelShader', [at, out]), D3DERR_INVALIDCALL);
    assert.equal(h.box.memory.readU32(out), 0);
    assert.ok(h.divergences.some(line=>line.includes('pixel shader')));
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a state block is recorded, handed back, and applied through its own vtable', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    assert.equal(h.device(device, 'BeginStateBlock'), D3D_OK);
    assert.equal(h.device(device, 'SetRenderState', [D3DRS.LIGHTING, 0]), D3D_OK);
    const out = 0x3000;
    assert.equal(h.device(device, 'EndStateBlock', [out]), D3D_OK);
    const block = h.box.memory.readU32(out);
    assert.notEqual(block, 0);
    const value = 0x3100;
    assert.equal(h.device(device, 'GetRenderState', [D3DRS.LIGHTING, value]), D3D_OK);
    assert.equal(h.fields.readU32(value), 1, 'not applied while recording');
    assert.equal(h.box.call(block, slot(IDIRECT3DSTATEBLOCK9_SLOTS, 'Apply'), []), D3D_OK);
    assert.equal(h.device(device, 'GetRenderState', [D3DRS.LIGHTING, value]), D3D_OK);
    assert.equal(h.fields.readU32(value), 0);
    assert.equal(h.box.call(block, slot(IDIRECT3DSTATEBLOCK9_SLOTS, 'Capture'), []), D3D_OK);
    assert.equal(h.device(device, 'EndStateBlock', [out]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'CreateStateBlock', [1, 0]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'CreateStateBlock', [1, out]), D3D_OK);
    h.release(h.box.memory.readU32(out));
    assert.equal(h.release(block), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a query answers through its vtable, and a null pointer only asks whether it could', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    assert.equal(h.device(device, 'CreateQuery', [D3DQUERYTYPE.EVENT, 0]), D3D_OK);
    assert.equal(h.device(device, 'CreateQuery', [D3DQUERYTYPE.OCCLUSION, 0]), D3D_OK);
    assert.equal(h.device(device, 'CreateQuery', [10, 0]), D3DERR_NOTAVAILABLE, 'a timestamp');
    const out = 0x3000;
    assert.equal(h.device(device, 'CreateQuery', [D3DQUERYTYPE.EVENT, out]), D3D_OK);
    const query = h.box.memory.readU32(out);
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>h.box.call(query, slot(IDIRECT3DQUERY9_SLOTS, name), args);
    assert.equal(call('GetType', []), D3DQUERYTYPE.EVENT);
    assert.equal(call('GetDataSize', []), 4);
    const data = 0x3100;
    h.fields.writeU32(data, 0xdeadbeef);
    assert.equal(call('GetData', [data, 4, 1]), D3D_OK, 'signalled as created, before any issue');
    assert.equal(h.fields.readU32(data), 1, 'and the event reads as done');
    assert.equal(call('Issue', [1]), D3D_OK);
    assert.equal(call('GetData', [data, 4, 1]), D3D_OK);
    assert.equal(h.fields.readU32(data), 1);
    assert.equal(call('GetData', [0, 0, 1]), D3D_OK);
    assert.equal(h.release(query), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

test('the viewport, scissor and the draws cross with their arguments in this version\'s order',
    ()=>{
        const h = seamed();
        const root = h.create();
        const { device } = h.createDevice(root);
        const viewport = 0x3000;
        h.fields.writeStruct(viewport, D3DVIEWPORT9,
            { X: 8, Y: 4, Width: 32, Height: 16, MinZ: 0.25, MaxZ: 0.75 }, ['MinZ', 'MaxZ']);
        assert.equal(h.device(device, 'SetViewport', [viewport]), D3D_OK);
        const read = 0x3100;
        assert.equal(h.device(device, 'GetViewport', [read]), D3D_OK);
        assert.deepEqual(h.fields.readStruct(read, D3DVIEWPORT9, ['MinZ', 'MaxZ']),
            { X: 8, Y: 4, Width: 32, Height: 16, MinZ: 0.25, MaxZ: 0.75 });

        const rect = 0x3200;
        h.fields.writeStruct(rect, { left: 0, top: 4, right: 8, bottom: 12 },
            { left: 1, top: 2, right: 30, bottom: 40 });
        assert.equal(h.device(device, 'SetScissorRect', [rect]), D3D_OK);
        assert.equal(h.device(device, 'GetScissorRect', [read]), D3D_OK);
        assert.deepEqual(h.fields.readStruct(read, { left: 0, top: 4, right: 8, bottom: 12 }),
            { left: 1, top: 2, right: 30, bottom: 40 });

        // A user-pointer draw of one triangle: the seam reads exactly the
        // vertices the primitive count implies, and the base vertex index of
        // an indexed draw is signed.
        assert.equal(h.device(device, 'SetFVF', [0x002]), D3D_OK);
        assert.equal(h.device(device, 'BeginScene'), D3D_OK);
        assert.equal(h.device(device, 'DrawPrimitiveUP', [4, 1, 0x4000, 12]), D3D_OK);
        assert.equal(h.device(device, 'DrawPrimitiveUP', [4, 1, 0, 12]), D3DERR_INVALIDCALL);
        assert.equal(h.device(device, 'DrawIndexedPrimitive', [4, 0xffffffff, 0, 3, 0, 1]),
            D3DERR_INVALIDCALL, 'no indices bound');
        assert.equal(h.device(device, 'DrawRectPatch', [1, 0, 0]), D3DERR_INVALIDCALL);
        assert.equal(h.device(device, 'EndScene'), D3D_OK);

        // A palette round-trips through memory; patches and processing are refused.
        // Opaque entries: alpha in a palette needs D3DPTEXTURECAPS_ALPHAPALETTE.
        h.box.services.writeMemory(0x4000, Uint8Array.from({ length: 1024 },
            (_, i)=>(i % 4 === 3 ? 0xff : i & 0xff)));
        assert.equal(h.device(device, 'SetPaletteEntries', [2, 0x4000]), D3D_OK);
        assert.equal(h.device(device, 'SetPaletteEntries', [2, 0]), D3DERR_INVALIDCALL);
        assert.equal(h.device(device, 'GetPaletteEntries', [2, 0x4800]), D3D_OK);
        assert.deepEqual(h.box.services.readMemory(0x4800, 1024),
            h.box.services.readMemory(0x4000, 1024));
        assert.equal(h.device(device, 'SetCurrentTexturePalette', [2]), D3D_OK);
        assert.equal(h.device(device, 'GetCurrentTexturePalette', [0x4c00]), D3D_OK);
        assert.equal(h.fields.readU32(0x4c00), 2);
        assert.equal(h.device(device, 'ProcessVertices', [0, 0, 0, 0, 0, 0]), D3DERR_INVALIDCALL);
        assert.equal(h.device(device, 'SetSoftwareVertexProcessing', [0]), D3D_OK);
        assert.equal(h.device(device, 'GetSoftwareVertexProcessing', []), 0);
        assert.equal(h.device(device, 'SetDialogBoxMode', [1]), D3D_OK);
        assert.equal(h.release(device), 0);
        h.release(root);
    });

test('a lock that settles later still writes the locked rectangle, and the caller waits',
    async()=>{
        // A render target's lock reads the GPU back first and answers with a
        // promise; the bridge suspends the caller on it. The D3DLOCKED_RECT
        // has to be written when the promise settles, not skipped because the
        // answer was not yet a number.
        const h = seamed();
        const root = h.create();
        const { device } = h.createDevice(root);
        const out = 0x3000;
        assert.equal(h.device(device, 'GetBackBuffer', [0, 0, 0, out]), D3D_OK);
        const back = h.box.memory.readU32(out);
        const surface = h.publisher.objectAt(back);
        surface.LockRect = (/** @type {any} */ locked)=>{
            locked.Pitch = 256;
            locked.pBits = 0x12340;
            return Promise.resolve(D3D_OK);
        };
        const locked = 0x3200;
        const answer = h.box.callRaw(back, slot(IDIRECT3DSURFACE9_SLOTS, 'LockRect'),
            [locked, 0, 0]);
        assert.ok(answer instanceof Promise, 'the slot hands the promise on');
        assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.pBits), 0, 'nothing yet');
        assert.equal(await answer, D3D_OK);
        assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.Pitch), 256);
        assert.equal(h.fields.readU32(locked + D3DLOCKED_RECT.pBits), 0x12340);
        h.release(back);
        assert.equal(h.release(device), 0);
        h.release(root);
    });

test('a back buffer and the swap chain come back as the device\'s own', ()=>{
    const h = seamed();
    const root = h.create();
    const { device } = h.createDevice(root);
    const out = 0x3000;
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, 0, out]), D3D_OK);
    const back = h.box.memory.readU32(out);
    assert.notEqual(back, 0);
    assert.equal(h.device(device, 'GetBackBuffer', [0, 0, 1, out]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'GetRenderTarget', [0, out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), back, 'target zero is back buffer zero');
    h.release(back);
    h.release(back);
    assert.equal(h.device(device, 'GetDepthStencilSurface', [out]), 0x88760866,
        'D3DERR_NOTFOUND without an automatic depth stencil');
    assert.equal(h.box.memory.readU32(out), 0, 'and the pointer is cleared');
    assert.equal(h.device(device, 'GetSwapChain', [0, out]), D3D_OK);
    const chain = h.box.memory.readU32(out);
    assert.notEqual(chain, 0);
    const parameters = 0x3100;
    assert.equal(h.box.call(chain, 6 + 3, [parameters]), D3D_OK, 'GetPresentParameters');
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.BackBufferWidth), 64);
    assert.equal(h.fields.readU32(parameters + D3DPRESENT_PARAMETERS9.Windowed), 1);
    // The front buffer through either door reaches the device, which here
    // draws nothing it could read back and says so.
    assert.equal(h.device(device, 'CreateOffscreenPlainSurface',
        [4, 4, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM, out, 0]), D3D_OK);
    const plain = h.box.memory.readU32(out);
    assert.equal(h.box.call(chain, 1 + 3, [plain]), D3DERR_INVALIDCALL, 'GetFrontBufferData');
    assert.equal(h.device(device, 'GetFrontBufferData', [0, plain]), D3DERR_INVALIDCALL);
    assert.ok(h.divergences.some(line=>line.includes('GetFrontBufferData was refused')));
    h.release(plain);
    h.release(chain);
    assert.equal(h.release(device), 0);
    h.release(root);
});

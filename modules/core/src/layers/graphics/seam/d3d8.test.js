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
import { BUFFER, SHADOW, STALE_POINTER, TEXTURE } from './shadow.js';
import {
    IDIRECT3D8_SLOTS, IDIRECT3DDEVICE8_SLOTS, IDIRECT3DSURFACE8_SLOTS, IDIRECT3DTEXTURE8_SLOTS,
} from './vtables.js';
import { REFRESH_HZ } from '../../win32/user32/display.js';
import {
    D3DCAPS8, D3DDISPLAYMODE, D3DLIGHT7, D3DLOCKED_RECT, D3DPRESENT_PARAMETERS8,
    D3DSURFACE_DESC8, D3DVIEWPORT8, POINT, RECT, createFields,
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
const E_NOTIMPL = 0x80004001;
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
 * @param {{ shadow?: boolean }} [options]  Whether the device keeps a block in
 *     guest memory, as it does under a running processor.
 */
function seamed({ shadow = false } = {}){
    const box = machine();
    /** @type {string[]} */
    const divergences = [];
    /** @type {any[]} */
    const cursors = [];
    /** @type {[number, number][]} */
    /** @type {[number, number, number | undefined, boolean | undefined][]} */
    const resolutions = [];
    /** @type {any[]} */
    const roots = [];
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const libraries = createGraphicsLibraries({
        graphics: {
            /** @param {string} name */
            create: name=>{
                if (name !== 'd3d8')
                {
                    return null;
                }
                const root = createDirect3D8();
                roots.push(root);
                return root;
            },
            available: ()=>false,
            adapter: ()=>({ vendor: 'nvidia', architecture: 'ampere', description: '' }),
        },
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>SCREEN,
        publisher,
        allocate: shadow ? box.allocate : undefined,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        cursor: (/** @type {any} */ notice)=>cursors.push(notice),
        resolution: (/** @type {number} */ w, /** @type {number} */ h,
            /** @type {{ window?: number, fullscreen?: boolean } | undefined} */ where)=>
            resolutions.push([w, h, where?.window, where?.fullscreen]),
    });
    const fields = createFields(box.services);

    const h = {
        box,
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
        /** @param {number} device @param {string} name @param {number[]} args */
        device: (device, name, args = [])=>
            box.call(device, slot(IDIRECT3DDEVICE8_SLOTS, name), args),
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

    // Nothing scans out here, so both fields of the raster status read as the
    // start of a frame -- and both are written, so which of the two a program
    // reads does not matter.
    const status = 0x3100;
    h.box.services.writeMemory(status, new Uint8Array([0xcd, 0xcd, 0xcd, 0xcd,
        0xcd, 0xcd, 0xcd, 0xcd]));
    assert.equal(h.device(device, 'GetRasterStatus', [status]), D3D_OK);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.InVBlank), 0);
    assert.equal(h.fields.readU32(status + D3DRASTER_STATUS.ScanLine), 0);

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
    assert.equal(text(D3DADAPTER_IDENTIFIER8.Description), 'nvidia ampere');
    assert.equal(text(D3DADAPTER_IDENTIFIER8.Driver), 'webgpu');
    assert.equal(h.fields.readU32(out + D3DADAPTER_IDENTIFIER8.VendorId), 0x10de);
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
    // Every size of the era whatever the display, in 32-bit colour only:
    // five modes, and a program builds its menu from them.
    const count = ask('GetAdapterModeCount', [0]);
    assert.equal(count, 22);

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
    assert.deepEqual(seen,
        ['640x480', '800x600', '1024x768', '1280x720', '1440x900', '1600x900', '1680x1050',
            '1920x1080', '1920x1200', '2560x1440', '2560x1600']
            .flatMap(size=>[`${size}@60/22`, `${size}@120/22`]),
        'every size at both rates, 32-bit, smallest first');
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
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 0, cubeTexture, D3DFMT.A8R8G8B8]),
    D3DERR_NOTAVAILABLE, 'and a kind of resource this build refuses to make is never available');

    assert.equal(ask('CheckDeviceMultiSampleType',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 1, 0]), D3D_OK, 'one sample per pixel');
    assert.equal(ask('CheckDeviceMultiSampleType',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, 1, 2]), D3DERR_NOTAVAILABLE);

    assert.equal(ask('CheckDepthStencilMatch',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, D3DFMT.X8R8G8B8, D3DFMT.D24S8]), D3D_OK);
    assert.equal(ask('CheckDepthStencilMatch',
        [0, D3DDEVTYPE.HAL, D3DFMT.X8R8G8B8, D3DFMT.X8R8G8B8, D3DFMT.A8R8G8B8]),
    D3DERR_NOTAVAILABLE);

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
    assert.equal(h.roots[0].refCount, 2, 'and the call took the reference it owes');
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

test('what this build cannot do says so, and clears the pointer it was given', ()=>{
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);
    const out = 0x6000;

    /** @param {string} name @param {number[]} args */
    const refused = (name, args)=>{
        h.box.memory.writeU32(out, 0xdeadbeef);
        const hr = h.device(device, name, args);
        assert.equal(h.box.memory.readU32(out), 0, `${name} cleared the caller's pointer`);
        return hr;
    };

    // A create that cannot be done reports it and leaves nothing behind: a
    // program tests the pointer as often as the result.
    assert.equal(refused('CreateAdditionalSwapChain', [0, out]), D3DERR_NOTAVAILABLE);
    assert.equal(refused('CreateCubeTexture', [64, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, out]),
        D3DERR_NOTAVAILABLE, 'nothing samples a cube map here');
    assert.equal(
        refused('CreateVolumeTexture', [8, 8, 8, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, out]),
        D3DERR_NOTAVAILABLE);

    // The cursor, the front buffer, the palettes and the transformed-vertex
    // path: each refuses because succeeding would promise a picture nothing
    // here draws.
    assert.equal(h.device(device, 'SetCursorProperties', [0, 0, 0]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'ShowCursor', [1]), 0, 'no cursor was showing before');
    assert.equal(h.device(device, 'SetCursorPosition', [10, 20, 0]), 0);
    assert.equal(h.device(device, 'GetFrontBuffer', [0x6100]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'SetPaletteEntries', [0, 0x6100]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'GetCurrentTexturePalette', [0x6100]), D3DERR_INVALIDCALL);
    assert.equal(h.device(device, 'ProcessVertices', [0, 0, 3, 0, 0]), D3DERR_INVALIDCALL);

    // GetInfo succeeded and reported nothing, which is what a program checks
    // for before reading the structure it passed.
    assert.equal(h.device(device, 'GetInfo', [1, 0x6100, 16]), S_FALSE);

    assert.equal(h.release(device), 0);
    h.release(root);
});

test('a shader cannot be created, and the format that shares its parameter can', ()=>{
    // The renderer draws the fixed-function pipeline and drops a draw with a
    // shader bound. A create that succeeded would send a program down the
    // programmable path and it would never look back; the refusal is what sends
    // it down the one that draws.
    const h = seamed();
    const root = h.create();
    const device = h.createDevice(root);

    assert.equal(h.device(device, 'CreateVertexShader', [0x7000, 0x7100, 0x7200, 0]), E_NOTIMPL);
    assert.equal(h.device(device, 'CreatePixelShader', [0x7100, 0x7200]), E_NOTIMPL);
    assert.equal(h.device(device, 'DeleteVertexShader', [1]), D3DERR_INVALIDCALL,
        'and there is no handle to delete');

    // D3DFVF_XYZ | D3DFVF_DIFFUSE: a vertex format, which shares this slot with
    // a shader handle and is the half that has to work.
    const fvf = 0x002 | 0x040;
    assert.equal(h.device(device, 'SetVertexShader', [fvf]), D3D_OK);
    const out = 0x7300;
    assert.equal(h.device(device, 'GetVertexShader', [out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), fvf, 'read back exactly as it was written');
    assert.equal(h.device(device, 'SetPixelShader', [0]), D3D_OK, 'binding no pixel shader');
    assert.equal(h.device(device, 'GetPixelShader', [out]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), 0);

    assert.equal(h.release(device), 0);
    h.release(root);
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
            'ExtentsAdjust', 'MaxPointSize']);
    assert.equal(caps.DeviceType, D3DDEVTYPE.HAL, 'the first field, so the whole run starts right');
    assert.equal(caps.MaxTextureAspectRatio, 4096);
    assert.equal(caps.MaxAnisotropy, 16);
    assert.equal(caps.MaxTextureBlendStages, 8);
    assert.equal(caps.MaxSimultaneousTextures, 8);
    assert.equal(caps.MaxActiveLights, 8);
    assert.equal(caps.MaxUserClipPlanes, 6);
    assert.equal(caps.MaxStreams, 16);
    assert.equal(caps.MaxPointSize, 64, 'a float in the middle of the dwords');
    assert.equal(caps.ExtentsAdjust, 0);
    assert.ok(caps.MaxVertexW > 0, 'a zero here is read as no clipping headroom at all');
    assert.ok(caps.GuardBandLeft < 0 && caps.GuardBandRight > 0);

    // Both shader versions are zero deliberately: this device runs neither, and
    // the entry points make that claim good.
    assert.equal(caps.VertexShaderVersion, 0);
    assert.equal(caps.PixelShaderVersion, 0);

    // The bits land in the fields they belong to rather than one field over.
    assert.equal(caps.ZCmpCaps, caps.AlphaCmpCaps, 'both comparison sets are the same set');
    assert.equal(caps.SrcBlendCaps, caps.DestBlendCaps);
    assert.ok((caps.TextureCaps & 0x00004000) !== 0, 'D3DPTEXTURECAPS_MIPMAP');
    assert.ok((caps.TextureAddressCaps & 0x00000001) !== 0, 'D3DPTADDRESSCAPS_WRAP');
    assert.ok((caps.DevCaps & 0x00010000) !== 0, 'D3DDEVCAPS_HWTRANSFORMANDLIGHT');
    // A colour cursor is claimed, because the device keeps the bitmap it is
    // handed and the host shows it. A title was measured drawing its own
    // cursor, from the wrong cell of its sheet, when this field read zero.
    assert.equal(caps.CursorCaps, 0x3, 'D3DCURSORCAPS_COLOR | D3DCURSORCAPS_LOWRES');
    assert.equal(caps.Caps3, 0, 'nothing was written into the field before the intervals');

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

    // What the guest method does: write the state, count the call.
    h.box.memory.writeU32(block + SHADOW.RENDER_STATES + cull * 4, 1);
    h.box.memory.writeU32(block + SHADOW.RENDER_STATE_CALLS, 1);
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
    h.box.memory.writeU32(block + SHADOW.BINDING_CALLS, 1);
    const stride = 0xe200;
    assert.equal(h.device(device, 'GetStreamSource', [0, out, stride]), D3D_OK);
    assert.equal(h.box.memory.readU32(out), vb, 'bound to the buffer the guest named');
    assert.equal(h.box.memory.readU32(stride), 24);
    h.release(h.box.memory.readU32(out));

    // A lock taken in the guest is a lock the host's path refuses; once the
    // guest lets go, the host's path locks, and the block says so.
    h.box.memory.writeU32(vblock + BUFFER.LOCKED, 1);
    h.box.memory.writeU32(vblock + BUFFER.FROM, 0);
    h.box.memory.writeU32(vblock + BUFFER.TO, 64);
    h.box.memory.writeU32(block + SHADOW.LOCK_CALLS, 1);
    const bits = 0xe300;
    assert.equal(h.buffer(vb, 'Lock', [0, 0, bits, 0]), D3DERR_INVALIDCALL);
    h.box.memory.writeU32(vblock + BUFFER.LOCKED, 0);
    h.box.memory.writeU32(block + SHADOW.RING, vblock);
    h.box.memory.writeU32(block + SHADOW.RING_HEAD, 1);
    h.box.memory.writeU32(block + SHADOW.UNLOCK_CALLS, 1);
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
    h.box.memory.writeU32(block + SHADOW.TEXTURE_CALLS, 1);
    h.box.memory.writeU32(block + SHADOW.STAGE_STATES + (3 * 32 + D3DTSS.COLOROP) * 4, D3DTOP.ADD);
    h.box.memory.writeU32(block + SHADOW.STAGE_STATE_CALLS, 1);
    const material = 0xe300;
    h.fields.writeF32(block + SHADOW.MATERIAL + 16 * 4, 12.5);   // Power
    h.box.memory.writeU32(block + SHADOW.MATERIAL_CALLS, 1);

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
    h.box.memory.writeU32(block + SHADOW.TEXTURE_CALLS, 2);
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
    h.box.memory.writeU32(block + SHADOW.TEXTURE_CALLS, 3);
    assert.equal(h.device(device, 'GetTexture', [0, out]), D3D_OK);
    assert.equal(h.object(h.box.memory.readU32(out)), h.object(third));
    h.release(h.box.memory.readU32(out));

    // Unbinding through the guest leaves it, and a stage the program never
    // wrote is left alone whatever the device holds.
    h.box.memory.writeU32(block + SHADOW.TEXTURES, 0);
    h.box.memory.writeU32(block + SHADOW.TEXTURE_CALLS, 4);
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

test('a back buffer asked for as zero by zero is the display, described and stored as one', ()=>{
    // Windowed, zero means the size of the device window. Carried through as a
    // zero it describes a surface with no rows and no storage, which the program
    // then reads with its own idea of the mode -- and that read used to land in
    // the slack of a fixed-megabyte allocation rather than in the next object.
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
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Width), SCREEN.width);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Height), SCREEN.height);
    assert.equal(h.fields.readU32(desc + D3DSURFACE_DESC8.Size),
        SCREEN.width * 4 * SCREEN.height, 'and its length is that surface, not nothing');

    // And the program is told the size was not its own.
    assert.ok(h.divergences.some(line=>/zero by zero/.test(line)),
        'the assumption is reported rather than made quietly');

    assert.equal(h.release(surface), 0);
    assert.equal(h.release(device), 0);
    h.release(root);
});

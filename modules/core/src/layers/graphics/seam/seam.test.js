/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * These drive the real vtable publisher rather than a stand-in for it.
 *
 * The seam's whole job is to be correct about somebody else's ABI, and a fake
 * publisher would be correct about this file's idea of that ABI instead --
 * which is the thing under test. So the bridge's own `createVtables` lays the
 * tables out, over a flat buffer standing in for guest memory, and the tests
 * read the same words a guest would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { createPublisher } from './com.js';
import { createGraphicsLibraries, createOpenglTable } from './exports.js';
import { createDirect3D8Seam } from './d3d8.js';
import { describe, IDIRECT3D8_SLOTS, IDIRECT3DDEVICE8_SLOTS } from './vtables.js';
import { IID_IDirect3D8, IID_IDirect3DDevice8 } from './iids.js';
import { D3DPRESENT_PARAMETERS8, D3DPRESENT_PARAMETERS9, createFields } from './structs.js';
import { createDirect3D8 } from '../d3d8/device.js';

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

/** A flat address space, plus the two accessors every piece here wants. */
function machine(){
    const bytes = new Uint8Array(0x10000);
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

    /** Trap ids, so a published slot can be called the way a guest would. */
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

    return {
        bytes,
        memory,
        registered,
        /** The graphics services shape: readMemory/writeMemory. */
        services: {
            /** @param {number} at @param {number} length */
            readMemory: (at, length)=>bytes.slice(at, at + length),
            /** @param {number} at @param {Uint8Array} value */
            writeMemory: (at, value)=>bytes.set(value, at),
        },
        /** @param {any} object @param {string} id */
        publishInterface: (object, id)=>vtables.publish(object, id),

        /**
         * Calls a published slot the way a guest does: through the interface
         * pointer, by index, with `this` first.
         *
         * @param {number} pointer @param {number} slot @param {number[]} args
         */
        call(pointer, slot, args = []){
            const table = memory.readU32(pointer);
            const trap = memory.readU32(table + slot * 4);
            const entry = registered.get(trap);
            assert.ok(entry, `slot ${slot} has no implementation registered`);
            return entry.fn.handler([pointer, ...args]);
        },

        /** @param {number} pointer @param {number} slot */
        argBytesOf(pointer, slot){
            const table = memory.readU32(pointer);
            const trap = memory.readU32(table + slot * 4);
            return registered.get(trap).fn.argBytes;
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
            for (let i = 0; i < 8; i++)
            {
                bytes[at + 8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
            }
            return at;
        },
    };
}

/** The seam over a real Direct3D 8 object. */
function seamed(){
    const box = machine();
    const graphics = {
        /** @param {string} name */
        create: (/** @type {string} */ name)=>(name === 'd3d8' ? createDirect3D8() : null),
        available: ()=>false,
    };
    const libraries = createGraphicsLibraries({
        graphics,
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>({ width: 800, height: 600, bitsPerPixel: 32 }),
    });
    return { box, libraries, fields: createFields(box.services) };
}

test('a program reaches Direct3D through a library, not by asking for an object', ()=>{
    // The whole point of the seam: before it, nothing named D3D8.dll existed
    // and Direct3DCreate8 was not a symbol anything could import.
    const { libraries } = seamed();

    assert.deepEqual(Object.keys(libraries.libraries).sort(),
        ['D3D8.dll', 'D3D9.dll', 'DDRAW.dll']);
    assert.equal(libraries.libraries['D3D8.dll'].Direct3DCreate8.argBytes, 4,
        'one argument, the SDK version');
});

test('an interface pointer points at its vtable, not at itself', ()=>{
    // A program reads *pp to reach the table and then indexes it. Publishing
    // the table where the interface belongs sends every call one level off, and
    // the first thing it reads as a function address is a function address.
    const { box, libraries } = seamed();
    const pointer = libraries.libraries['D3D8.dll'].Direct3DCreate8.handler([32]);

    assert.notEqual(pointer, 0);
    const table = box.memory.readU32(pointer);
    assert.notEqual(table, pointer, 'the first word is a pointer elsewhere');
    assert.notEqual(box.memory.readU32(table), 0, 'and it leads to slot zero');
});

test('every slot the interface declares is there, including the unimplemented ones', ()=>{
    // A missing slot shifts every method after it. E_NOTIMPL is a reply a
    // program handles; a hole is a jump into whatever follows the table.
    const { box, libraries } = seamed();
    const pointer = libraries.libraries['D3D8.dll'].Direct3DCreate8.handler([32]);
    const table = box.memory.readU32(pointer);

    const slots = 3 + IDIRECT3D8_SLOTS.length;
    for (let slot = 0; slot < slots; slot++)
    {
        assert.notEqual(box.memory.readU32(table + slot * 4), 0,
            `slot ${slot} is empty`);
    }

    // RegisterSoftwareDevice is slot 3 and nothing implements it.
    assert.equal(box.call(pointer, 3, [0]) >>> 0, 0x80004001, 'E_NOTIMPL');
});

test('argBytes counts this, so the callee pops what it should', ()=>{
    // These are thiscall and the bridge has the callee pop everything but
    // `this`. A miscount does not return a wrong value, it returns to a wrong
    // address, and the failure lands somewhere with no connection to here.
    const { box, libraries } = seamed();
    const pointer = libraries.libraries['D3D8.dll'].Direct3DCreate8.handler([32]);

    assert.equal(box.argBytesOf(pointer, 0), 12, 'QueryInterface: this, riid, ppv');
    assert.equal(box.argBytesOf(pointer, 1), 4, 'AddRef: this alone');
    // GetAdapterCount takes nothing but `this`; CreateDevice takes six more.
    assert.equal(box.argBytesOf(pointer, 3 + 1), 4);
    assert.equal(box.argBytesOf(pointer, 3 + IDIRECT3D8_SLOTS.length - 1), 4 + 6 * 4);
});

test('CreateDevice hands back an interface, and it is the device interface', ()=>{
    const { box, libraries, fields } = seamed();
    const root = libraries.libraries['D3D8.dll'].Direct3DCreate8.handler([32]);

    const parameters = 0x2000;
    const out = 0x3000;
    fields.writeStruct(parameters, D3DPRESENT_PARAMETERS8, {
        BackBufferWidth: 800,
        BackBufferHeight: 600,
        BackBufferFormat: 22,
        BackBufferCount: 1,
        SwapEffect: 1,
        Windowed: 1,
    });

    const hr = box.call(root, 3 + IDIRECT3D8_SLOTS.length - 1, [0, 1, 0, 0x40, parameters, out]);
    assert.equal(hr, 0, 'S_OK');

    const device = box.memory.readU32(out);
    assert.notEqual(device, 0, 'a pointer was written where the caller asked');

    // The device's own vtable is longer than the root's, which is the cheapest
    // proof that what came back is the device interface and not another copy of
    // the thing that made it.
    const table = box.memory.readU32(device);
    const last = 3 + IDIRECT3DDEVICE8_SLOTS.length - 1;
    assert.notEqual(box.memory.readU32(table + last * 4), 0);
    assert.equal(box.call(device, 3, []), 0, 'TestCooperativeLevel says the device is fine');
});

test('one object is one identity, however often it is asked for', ()=>{
    // Programs compare interface pointers to decide whether two of them name
    // the same object. Two adapters for one object is two identities, and the
    // comparison then answers no when it should answer yes.
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const object = { addRef: ()=>1, release: ()=>0 };
    const interfaces = [describe(IID_IDirect3D8, IDIRECT3D8_SLOTS)];

    const first = publisher.publish(object, interfaces, IID_IDirect3D8);
    const second = publisher.publish(object, interfaces, IID_IDirect3D8);
    assert.equal(first, second);
    assert.equal(publisher.objectAt(first), object, 'and the pointer leads back');
});

test('QueryInterface for IUnknown answers the same pointer through any interface', ()=>{
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const object = { addRef: ()=>1, release: ()=>0 };
    const pointer = publisher.publish(object,
        [describe(IID_IDirect3D8, IDIRECT3D8_SLOTS)], IID_IDirect3D8);

    const riid = box.putGuid(0x4000, IID_IUNKNOWN);
    const out = 0x5000;
    assert.equal(box.call(pointer, 0, [riid, out]), 0, 'S_OK');
    const unknown = box.memory.readU32(out);
    assert.notEqual(unknown, 0);

    // Asked again, through the pointer it just handed back.
    const again = 0x5100;
    assert.equal(box.call(unknown, 0, [riid, again]), 0);
    assert.equal(box.memory.readU32(again), unknown,
        'one IUnknown per object, which is what identity means here');
});

test('an interface the object does not have is refused, and the pointer cleared', ()=>{
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const object = { addRef: ()=>1, release: ()=>0 };
    const pointer = publisher.publish(object,
        [describe(IID_IDirect3D8, IDIRECT3D8_SLOTS)], IID_IDirect3D8);

    const out = 0x5200;
    box.memory.writeU32(out, 0xdeadbeef);
    const riid = box.putGuid(0x4100, IID_IDirect3DDevice8);
    assert.equal(box.call(pointer, 0, [riid, out]) >>> 0, 0x80004002, 'E_NOINTERFACE');
    assert.equal(box.memory.readU32(out), 0,
        'a stale pointer left here is one the caller follows');
});

test('the two present-parameter layouts differ where the versions do', ()=>{
    // A Direct3D 9 structure read with 8's offsets finds Windowed in the
    // depth-stencil format's field -- a boolean that happens to be true, which
    // is why this is a silent failure rather than a loud one.
    assert.equal(D3DPRESENT_PARAMETERS8.SwapEffect, 0x14);
    assert.equal(D3DPRESENT_PARAMETERS9.SwapEffect, 0x18,
        'nine inserts MultiSampleQuality before it');
    assert.equal(D3DPRESENT_PARAMETERS9.SIZE - D3DPRESENT_PARAMETERS8.SIZE, 4);
    assert.equal(D3DPRESENT_PARAMETERS8.Windowed, 0x1c);
    assert.equal(D3DPRESENT_PARAMETERS9.AutoDepthStencilFormat, 0x28,
        'which is where eight keeps Windowed plus twelve');
});

test('a structure round-trips through the field reader', ()=>{
    const box = machine();
    const fields = createFields(box.services);
    fields.writeStruct(0x6000, D3DPRESENT_PARAMETERS8, {
        BackBufferWidth: 1024,
        BackBufferHeight: 768,
        Windowed: 1,
    });
    const read = fields.readStruct(0x6000, D3DPRESENT_PARAMETERS8);
    assert.equal(read.BackBufferWidth, 1024);
    assert.equal(read.BackBufferHeight, 768);
    assert.equal(read.Windowed, 1);
    assert.equal(read.SwapEffect, 0, 'and what was not written reads as zero');
});

test('a float field is read as a float, not as its bits', ()=>{
    const box = machine();
    const fields = createFields(box.services);
    fields.writeF32(0x6100, 0.5);
    assert.equal(fields.readF32(0x6100), 0.5);
    assert.notEqual(fields.readU32(0x6100), 0.5, 'the same four bytes say otherwise');
});

test('GetRenderState writes through the pointer the caller passed', ()=>{
    const { box, libraries } = seamed();
    const root = libraries.libraries['D3D8.dll'].Direct3DCreate8.handler([32]);
    const parameters = 0x7000;
    const fields = createFields(box.services);
    fields.writeStruct(parameters, D3DPRESENT_PARAMETERS8, {
        BackBufferFormat: 22, BackBufferCount: 1, SwapEffect: 1, Windowed: 1,
    });
    box.call(root, 3 + IDIRECT3D8_SLOTS.length - 1, [0, 1, 0, 0x40, parameters, 0x7100]);
    const device = box.memory.readU32(0x7100);

    // D3DRS_ZENABLE is 7; the slots are SetRenderState then GetRenderState.
    const setSlot = 3 + IDIRECT3DDEVICE8_SLOTS.findIndex(([name])=>name === 'SetRenderState');
    const getSlot = 3 + IDIRECT3DDEVICE8_SLOTS.findIndex(([name])=>name === 'GetRenderState');
    assert.equal(box.call(device, setSlot, [7, 1]), 0);

    const out = 0x7200;
    assert.equal(box.call(device, getSlot, [7, out]), 0);
    assert.equal(box.memory.readU32(out), 1);
});

test('GetTexture precedes SetTexture, which is the one pair that reads backwards', ()=>{
    // Worth a test of its own because it looks like a transcription slip in
    // every reading, and swapping them silently binds the wrong stage.
    const get = IDIRECT3DDEVICE8_SLOTS.findIndex(([name])=>name === 'GetTexture');
    const set = IDIRECT3DDEVICE8_SLOTS.findIndex(([name])=>name === 'SetTexture');
    assert.ok(get >= 0 && set === get + 1, `GetTexture at ${get}, SetTexture at ${set}`);
});

test('the OpenGL table is derived only where the derivation holds', ()=>{
    // Its argBytes come from each function's declared parameter count, which is
    // sound only while every argument is one word. A double-precision entry
    // point would take two and break it in the way a wrong argBytes always
    // does: silently, on the return.
    const table = createOpenglTable({
        wgl: {
            wglCreateContext: (/** @type {number} */ hdc)=>hdc + 1,
            SwapBuffers: (/** @type {number} */ hdc)=>hdc !== 0,
            notAnEntryPoint: ()=>0,
        },
        context: {
            glClear: (/** @type {number} */ mask)=>mask,
            glViewport: (/** @type {number} */ x, /** @type {number} */ y,
                /** @type {number} */ w, /** @type {number} */ h)=>x + y + w + h,
            helper: ()=>0,
        },
    });

    assert.deepEqual(Object.keys(table).sort(),
        ['SwapBuffers', 'glClear', 'glViewport', 'wglCreateContext']);
    assert.equal(table.glViewport.argBytes, 16, 'four words');
    assert.equal(table.wglCreateContext.argBytes, 4);
    assert.equal(table.glClear.handler([0x4000]), 0x4000);
    assert.equal(table.SwapBuffers.handler([1]), 1, 'a boolean answer becomes a dword');
});

test('an object with no interfaces still answers AddRef and Release', ()=>{
    // IUnknown is every object's, and a program that queries for it and then
    // releases must not be released into nothing.
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    let count = 1;
    const object = { addRef: ()=>++count, release: ()=>--count };
    const pointer = publisher.publish(object, [], IID_IUNKNOWN);

    assert.notEqual(pointer, 0);
    assert.equal(box.call(pointer, 1, []), 2, 'AddRef');
    assert.equal(box.call(pointer, 2, []), 1, 'Release');
    assert.equal(count, 1, 'and the count is the object\'s own, not a second one');
});

test('the seam publishes through the device it was given, not one of its own', ()=>{
    // The API objects count their own references and decide when a Reset may
    // proceed by reading those counts. A second count here would agree with the
    // first only by accident.
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const seam = createDirect3D8Seam({
        publisher,
        memory: box.services,
        screen: ()=>({ width: 640, height: 480, bitsPerPixel: 32 }),
    });

    let refs = 1;
    const root = { addRef: ()=>++refs, release: ()=>--refs, caps: {} };
    const pointer = seam.publishRoot(root);
    box.call(pointer, 1, []);
    assert.equal(refs, 2, 'AddRef reached the object behind the seam');
});

test('a failed GetDepthStencilSurface clears the pointer it was given', ()=>{
    // A program passes a variable it last received a surface in and tests the
    // pointer rather than the HRESULT. Leaving a stale value there hands it one
    // it goes on to release.
    const { box, libraries } = seamed();
    const root = libraries.libraries['D3D8.dll'].Direct3DCreate8.handler([32]);
    const fields = createFields(box.services);
    const parameters = 0x8000;
    fields.writeStruct(parameters, D3DPRESENT_PARAMETERS8, {
        BackBufferFormat: 22,
        BackBufferCount: 1,
        SwapEffect: 1,
        Windowed: 1,
        EnableAutoDepthStencil: 0,
    });
    box.call(root, 3 + IDIRECT3D8_SLOTS.length - 1, [0, 1, 0, 0x40, parameters, 0x8100]);
    const device = box.memory.readU32(0x8100);

    const out = 0x8200;
    box.memory.writeU32(out, 0xdeadbeef);
    const slot = 3 + IDIRECT3DDEVICE8_SLOTS.findIndex(
        ([name])=>name === 'GetDepthStencilSurface');
    assert.notEqual(box.call(device, slot, [out]), 0, 'there is no depth stencil to hand back');
    assert.equal(box.memory.readU32(out), 0);
});

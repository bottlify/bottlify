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
import { createGraphicsLibraries } from './exports.js';
import { createDirect3D8Seam } from './d3d8.js';
import { describe, IDIRECT3D8_SLOTS, IDIRECT3DDEVICE8_SLOTS } from './vtables.js';
import { IID_IDirect3D8, IID_IDirect3DDevice8 } from './iids.js';
import { D3DPRESENT_PARAMETERS8, D3DPRESENT_PARAMETERS9, createFields } from './structs.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createOpengl } from '../opengl/exports.js';

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
        ['D3D10.dll', 'D3D10_1.dll', 'D3D8.dll', 'D3D9.dll', 'DDRAW.dll', 'DXGI.dll',
            'GLU32.dll', 'OPENGL32.dll', 'vulkan-1.dll']);
    assert.equal(libraries.libraries['D3D8.dll'].Direct3DCreate8.argBytes, 4,
        'one argument, the SDK version');
});

test('Direct3DCreate9Ex hands its object back through a pointer, and says when there is none',
    ()=>{
        // Unlike Direct3DCreate9 it answers an HRESULT and writes the
        // interface: two arguments, the SDK version and the pointer.
        for (const made of [true, false])
        {
            const box = machine();
            const { libraries } = createGraphicsLibraries({
                graphics: {
                    create: (/** @type {string} */ name)=>(made && name === 'd3d9'
                        ? createDirect3D9()
                        : null),
                    available: ()=>false,
                },
                memory: box.services,
                publishInterface: box.publishInterface,
                screen: ()=>({ width: 800, height: 600, bitsPerPixel: 32 }),
            });
            const entry = libraries['D3D9.dll'].Direct3DCreate9Ex;
            assert.equal(entry.argBytes, 8);
            box.memory.writeU32(0x6000, 0xdeadbeef);
            assert.equal(entry.handler([32, 0]) >>> 0, 0x8876086c, 'D3DERR_INVALIDCALL');
            const hr = entry.handler([32, 0x6000]) >>> 0;
            if (made)
            {
                assert.equal(hr, 0);
                assert.notEqual(box.memory.readU32(0x6000), 0);
            }
            else
            {
                assert.equal(hr, 0x8876086a, 'D3DERR_NOTAVAILABLE');
                assert.equal(box.memory.readU32(0x6000), 0);
            }
        }
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

    // RegisterSoftwareDevice is slot 3, the first after IUnknown's three, and
    // is answered from there: accepted, as Direct3D 9 accepts it.
    assert.equal(box.call(pointer, 3, [0]) >>> 0, 0, 'D3D_OK');
});

test('argBytes counts the interface pointer, so the callee pops what it should', ()=>{
    // A COM method is stdcall and the callee pops every argument, the
    // interface pointer included. A miscount does not return a wrong value, it
    // returns to a wrong address, and the failure lands somewhere with no
    // connection to here.
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

test('OPENGL32 is bound entirely, and nothing is made until a program calls it', ()=>{
    // Every export has to be bound whether or not it does anything: these are
    // stdcall, so a name nothing binds gets a stub that cleans the wrong number
    // of bytes off the caller's stack, and the program dies far from the call.
    const box = machine();
    /** @type {string[]} */
    const made = [];
    const seam = createGraphicsLibraries({
        graphics: {
            /** @param {string} name */
            create: name=>{
                made.push(name);
                return createOpengl({
                    readMemory: box.services.readMemory,
                    writeMemory: box.services.writeMemory,
                });
            },
        },
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>({ width: 640, height: 480, bitsPerPixel: 32 }),
    });

    const table = seam.libraries['OPENGL32.dll'];
    assert.equal(table.glViewport.argBytes, 16, 'four words');
    assert.equal(table.glOrtho.argBytes, 48, 'six doubles, which is twelve words');
    assert.equal(table.glVertex3f.argBytes, 12);
    assert.equal(table.glVertex3d.argBytes, 24, 'the same call in doubles takes twice the stack');
    assert.equal(table.SetPixelFormat, undefined, 'that one is GDI32\'s export, not this one\'s');
    assert.deepEqual(made, [], 'nothing was built merely by assembling the table');

    // With no context current glGetError answers GL_INVALID_OPERATION.
    assert.equal(table.glGetError.handler([]), 0x0502);
    assert.deepEqual(made, ['opengl'], 'and the first call built it, once');
    assert.equal(table.glGetError.handler([]), 0x0502);
    assert.deepEqual(made, ['opengl']);
});

test('GDI32 and OPENGL32 negotiate over one runtime, not two', ()=>{
    // On Windows choosing a format through GDI and creating a context through
    // WGL is one negotiation. Two runtimes here would hand a program a format
    // from one list and a context from another, and the frame GDI's
    // SwapBuffers presented would not be the frame the program drew.
    const box = machine();
    /** @type {string[]} */
    const made = [];
    const seam = createGraphicsLibraries({
        graphics: {
            /** @param {string} name */
            create: name=>{
                made.push(name);
                return createOpengl({
                    readMemory: box.services.readMemory,
                    writeMemory: box.services.writeMemory,
                });
            },
        },
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>({ width: 640, height: 480, bitsPerPixel: 32 }),
    });

    assert.deepEqual(made, [], 'the pixel-format service builds nothing either');
    assert.ok(seam.opengl.pixelFormat.count() > 0);
    assert.deepEqual(made, ['opengl']);

    seam.libraries['OPENGL32.dll'].glGetError.handler([]);
    seam.opengl.swapBuffers(0);
    assert.deepEqual(made, ['opengl'], 'both halves reached the one runtime');

    // A kernel's entry point is the same runtime's handler, not a stub: a
    // call through it is a call the program's own trap would have made.
    const glGetError = seam.opengl.entry('glGetError');
    assert.ok(glGetError, 'an implemented name resolves');
    assert.equal(glGetError([]), 0x0502);
    assert.equal(seam.opengl.entry('glNotAnEntryPoint'), null);
    assert.deepEqual(made, ['opengl']);
});

test('a gl entry point declares that it never sets the last error of the thread', ()=>{
    // GL reports through glGetError and touches nothing of Win32's; only the
    // wgl half of the library, which is a Windows API, can leave a last error
    // behind. The bridge reads the thread's error after every call that can
    // set one -- a trip into the kernel layer for a value that did not change
    // -- and a title's frame makes a dozen gl calls per draw, so the table
    // has to say which ones cannot, the way a COM vtable already does.
    const box = machine();
    const seam = createGraphicsLibraries({
        graphics: {
            create: ()=>createOpengl({
                readMemory: box.services.readMemory,
                writeMemory: box.services.writeMemory,
            }),
        },
        memory: box.services,
        publishInterface: box.publishInterface,
        screen: ()=>({ width: 640, height: 480, bitsPerPixel: 32 }),
    });

    const table = seam.libraries['OPENGL32.dll'];
    const reading = Object.entries(table)
        .filter(([name, entry])=>name.startsWith('gl') && entry.lastError !== false)
        .map(([name])=>name);
    assert.deepEqual(reading, [], 'every gl* export declares lastError: false');
    assert.notEqual(table.wglMakeCurrent.lastError, false,
        'a wgl entry point can set one, and the trace still reads it');
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

/**
 * The seam over a device that records what it was handed.
 *
 * A real device answers these calls by drawing, and a test that went through
 * one would be reading the renderer's mind about what the seam passed it. What
 * is under test here is only the translation: how many bytes a drawing call
 * reads out of the program's arrays, and which of its arguments is a float.
 */
function recorded(){
    const box = machine();
    const publisher = createPublisher({ publishInterface: box.publishInterface });
    const seam = createDirect3D8Seam({
        publisher,
        memory: box.services,
        screen: ()=>({ width: 640, height: 480, bitsPerPixel: 32 }),
    });

    /** @type {any[]} */
    const calls = [];
    const spy = (/** @type {string} */ name)=>(/** @type {any[]} */ ...args)=>{
        calls.push({ name, args });
        return 0;
    };
    const device = {
        addRef: ()=>1,
        release: ()=>1,
        Clear: spy('Clear'),
        SetTransform: spy('SetTransform'),
        SetMaterial: spy('SetMaterial'),
        SetTextureStageState: spy('SetTextureStageState'),
        DrawPrimitive: spy('DrawPrimitive'),
        DrawPrimitiveUP: spy('DrawPrimitiveUP'),
        DrawIndexedPrimitiveUP: spy('DrawIndexedPrimitiveUP'),
    };
    const root = {
        addRef: ()=>1,
        release: ()=>1,
        /** @param {any} _wanted @param {{ device?: any }} held */
        CreateDevice: (_wanted, held)=>{
            held.device = device;
            return 0;
        },
    };

    const rootPointer = seam.publishRoot(root);
    const fields = createFields(box.services);
    const parameters = 0x9000;
    fields.writeStruct(parameters, D3DPRESENT_PARAMETERS8, { Windowed: 1 });
    const out = 0x9200;
    box.call(rootPointer, 3 + IDIRECT3D8_SLOTS.findIndex(([name])=>name === 'CreateDevice'),
        [0, 1, 0, 0x40, parameters, out]);

    const pointer = box.memory.readU32(out);
    return {
        box,
        fields,
        calls,
        /** @param {string} name @param {number[]} args */
        invoke: (name, args)=>box.call(pointer,
            3 + IDIRECT3DDEVICE8_SLOTS.findIndex(([slot])=>slot === name), args),
    };
}

test('Clear reads its depth as a float, not as the dword the slot arrived in', ()=>{
    // Z is the one argument here declared float. Read as a dword it becomes a
    // number in the billions, which clears the buffer to the far plane whatever
    // the program asked for -- and nothing reports a depth that is merely wrong.
    const { calls, invoke } = recorded();
    const bits = new DataView(new ArrayBuffer(4));
    bits.setFloat32(0, 0.5, true);

    invoke('Clear', [0, 0, 1, 0xff204060, bits.getUint32(0, true), 0]);

    assert.equal(calls[0].args[4], 0.5);
    assert.equal(calls[0].args[3], 0xff204060, 'while the colour beside it stays a dword');
    assert.equal(calls[0].args[1], null, 'no rectangles means the whole viewport');
});

test('Clear hands over as many rectangles as it was told there are', ()=>{
    const { box, calls, invoke } = recorded();
    const rects = 0x9400;
    for (const [index, edges] of [[1, 2, 3, 4], [5, 6, 7, 8]].entries())
    {
        edges.forEach((value, at)=>box.memory.writeU32(rects + index * 16 + at * 4, value));
    }

    invoke('Clear', [2, rects, 1, 0, 0, 0]);

    assert.deepEqual(calls[0].args[1], [
        { x1: 1, y1: 2, x2: 3, y2: 4 },
        { x1: 5, y1: 6, x2: 7, y2: 8 },
    ]);
});

test('a transform arrives as sixteen floats, in the order the matrix holds them', ()=>{
    const { fields, calls, invoke } = recorded();
    const matrix = 0x9600;
    for (let index = 0; index < 16; index++)
    {
        fields.writeF32(matrix + index * 4, index + 0.5);
    }

    invoke('SetTransform', [2, matrix]);

    assert.equal(calls[0].args[0], 2);
    assert.deepEqual([...calls[0].args[1]],
        Array.from({ length: 16 }, (_, index)=>index + 0.5));
    assert.equal(invoke('SetTransform', [2, 0]), 0x8876086c | 0,
        'and a null matrix is refused here rather than read from address zero');
});

test('a material is four colours and a power, not seventeen anonymous words', ()=>{
    const { fields, calls, invoke } = recorded();
    const material = 0x9800;
    for (let index = 0; index < 17; index++)
    {
        fields.writeF32(material + index * 4, index);
    }

    invoke('SetMaterial', [material]);

    assert.deepEqual(calls[0].args[0], {
        Diffuse: { r: 0, g: 1, b: 2, a: 3 },
        Ambient: { r: 4, g: 5, b: 6, a: 7 },
        Specular: { r: 8, g: 9, b: 10, a: 11 },
        Emissive: { r: 12, g: 13, b: 14, a: 15 },
        Power: 16,
    });
});

test('a draw from the program\'s own memory reads the primitive\'s worth of bytes', ()=>{
    // The call says how many primitives and how wide a vertex is; how far to
    // read follows from the shape. Reading short truncates the last triangle,
    // reading long copies whatever the program keeps after its array.
    const { box, calls, invoke } = recorded();
    const vertices = 0x9a00;
    for (let index = 0; index < 256; index++)
    {
        box.bytes[vertices + index] = index;
    }

    // A strip of three triangles is five vertices, at twelve bytes each.
    invoke('DrawPrimitiveUP', [5, 3, vertices, 12]);

    assert.equal(calls[0].args[2].length, 5 * 12);
    assert.equal(calls[0].args[2][0], 0);
    assert.equal(calls[0].args[2][59], 59);
});

test('an indexed draw from user memory sizes its two arrays separately', ()=>{
    // The index array follows the primitive count and the vertex array follows
    // the vertex count the caller declared: one wrong and the draw reads a
    // neighbouring allocation.
    const { calls, invoke } = recorded();

    // Two triangles in a list: six 16-bit indices over four 20-byte vertices.
    invoke('DrawIndexedPrimitiveUP', [4, 0, 4, 2, 0x9c00, 101, 0x9e00, 20]);

    assert.equal(calls[0].args[4].length, 6 * 2, 'six indices, two bytes each');
    assert.equal(calls[0].args[6].length, 4 * 20);

    invoke('DrawIndexedPrimitiveUP', [4, 0, 4, 2, 0x9c00, 102, 0x9e00, 20]);
    assert.equal(calls[1].args[4].length, 6 * 4, 'and four bytes each when the format is 32-bit');
});

test('Direct3D 8 validates a shader by its version token, and never has messages', ()=>{
    const { box, libraries } = seamed();
    const d3d8 = libraries.libraries['D3D8.dll'];
    const E_FAIL = 0x80004005 | 0;
    const code = 0x9000, caps = 0x9100, errors = 0x9200;
    box.memory.writeU32(errors, 0xcafeface);

    assert.equal(d3d8.ValidateVertexShader.handler([0, 0, 0, 1, errors]), E_FAIL);
    assert.equal(box.memory.readU32(errors), 0, 'no messages, even on failure');
    box.memory.writeU32(code, 0xfffe0101);
    assert.equal(d3d8.ValidateVertexShader.handler([code, 0, 0, 0, 0]), 0);
    box.memory.writeU32(caps + 0xc4, 0xfffe0100);
    assert.equal(d3d8.ValidateVertexShader.handler([code, 0, caps, 0, 0]), E_FAIL,
        'newer than the caps say the device runs');
    box.memory.writeU32(code, 0xfffe0102);
    assert.equal(d3d8.ValidateVertexShader.handler([code, 0, 0, 0, 0]), E_FAIL);

    // dp4 oPos.x, v0, c3, then the end: constants to c3 and an input v0.
    [0xfffe0101, 9, 0xc0010000, 0x90e40000, 0xa0e40003, 0xffff]
        .forEach((word, at)=>box.memory.writeU32(code + at * 4, word));
    box.memory.writeU32(caps + 0xc4, 0xfffe0101);
    box.memory.writeU32(caps + 0xc8, 4);
    assert.equal(d3d8.ValidateVertexShader.handler([code, 0, caps, 0, 0]), 0);
    box.memory.writeU32(caps + 0xc8, 3);
    assert.equal(d3d8.ValidateVertexShader.handler([code, 0, caps, 0, 0]), E_FAIL,
        'c3 is past the three constants the caps give');
    const declaration = 0x9300;
    [0x20000000, 0x40030000, 0xffffffff]
        .forEach((word, at)=>box.memory.writeU32(declaration + at * 4, word));
    assert.equal(d3d8.ValidateVertexShader.handler([code, declaration, 0, 0, 0]), 0);
    box.memory.writeU32(declaration + 4, 0x40030003);
    assert.equal(d3d8.ValidateVertexShader.handler([code, declaration, 0, 0, 0]), E_FAIL,
        'v0 read, only v3 declared');

    box.memory.writeU32(code, 0xffff0104);
    assert.equal(d3d8.ValidatePixelShader.handler([code, 0, 0, 0]), 0);
    box.memory.writeU32(code, 0xffff0200);
    assert.equal(d3d8.ValidatePixelShader.handler([code, 0, 0, 0]), E_FAIL);
    assert.equal(d3d8.ValidatePixelShader.argBytes, 16);
});

test('Direct3DShaderValidatorCreate9 hands out a validator that answers the stream through', ()=>{
    // device.c test_shader_validator calls through the table it gets back
    // with no check: a null pointer there was a call to address zero.
    const { box, libraries } = seamed();
    const entry = libraries.libraries['D3D9.dll'].Direct3DShaderValidatorCreate9;
    assert.equal(entry.argBytes, 0);
    const validator = entry.handler([]);
    assert.notEqual(validator, 0);
    // Begin(callback, context, arg3), Instruction(file, line, tokens, count), End().
    assert.deepEqual([3, 4, 5].map(slot=>box.argBytesOf(validator, slot)), [16, 20, 4]);
    assert.equal(box.call(validator, 3, [0, 0, 0]), 0);
    assert.equal(box.call(validator, 4, [0, 0, 0x100, 3]), 0);
    assert.equal(box.call(validator, 4, [0, 0, 0x100, 0]) >>> 0, 0x80004005, 'no tokens');
    assert.equal(box.call(validator, 5), 0);
    assert.equal(box.call(validator, 2), 0, 'the last reference released');
});

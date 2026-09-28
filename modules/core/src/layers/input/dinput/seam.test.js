/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { writeGuid, readGuid, formatGuid } from '../../win32/ole32/guid.js';
import {
    createDirectInput, createPublisher, describe,
    DI_OK, DI_BUFFEROVERFLOW, DI_NOEFFECT, DIENUM_STOP,
    GUID_SysKeyboard, GUID_SysMouse,
    IID_IDirectInputA, IID_IDirectInputW, IID_IDirectInput7A, IID_IDirectInput2A,
    IID_IDirectInput2W, IID_IDirectInput7W,
    IID_IDirectInput8A, IID_IDirectInput8W, IID_IDirectInputDeviceA, IID_IDirectInputDeviceW,
    IID_IDirectInputDevice2A, IID_IDirectInputDevice7A, IID_IDirectInputDevice8A,
    IID_IDirectInputDevice8W,
    IDIRECTINPUT_SLOTS, IDIRECTINPUT7_SLOTS, IDIRECTINPUT8_SLOTS,
    IDIRECTINPUTDEVICE_SLOTS, IDIRECTINPUTDEVICE2_SLOTS, IDIRECTINPUTDEVICE7_SLOTS,
    IDIRECTINPUTDEVICE8_SLOTS,
    DIDEVICEOBJECTDATA, DIDEVICEINSTANCE, DIDEVICEOBJECTINSTANCE, DIPROPDWORD_DATA,
    DIPROP_BUFFERSIZE, DIDEVCAPS,
} from './seam.js';
import { KEY_DOWN, DIMOUSE_OFS } from './devices.js';

const DIERR_INVALIDPARAM = 0x80070057 | 0;
const DIERR_NOTACQUIRED = 0x8007000c | 0;
const DIERR_UNSUPPORTED = 0x80004001 | 0;
const DIERR_DEVICENOTREG = 0x80040154 | 0;
const DIERR_ACQUIRED = 0x800700aa | 0;
const DIERR_NOTBUFFERED = 0x80040207 | 0;
/** MAKEDIPROP numbers the seam does not export. */
const DIPROP_AXISMODE = 2;
const DIPROP_RANGE = 4;

const DIK_A = 0x1e;
const DIK_S = 0x1f;

/** Where the fixture puts things in its flat guest memory. */
/** The program's module handle, which every DirectInput after the first requires. */
const INSTANCE = 0x00400000;

const AT = Object.freeze({
    guid: 0x0400,
    iid: 0x0420,
    out: 0x1000,
    format: 0x2000,
    property: 0x2100,
    data: 0x3000,
    count: 0x2200,
    state: 0x4000,
    caps: 0x5000,
});

function guestMemory(){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address */
        u32: address=>view.getUint32(address, true),
        /** @param {number} address */
        i32: address=>view.getInt32(address, true),
        /** @param {number} address @param {number} value */
        setU32: (address, value)=>view.setUint32(address, value, true),
    };
}

function fakeBridge(){
    /** @type {Map<number, { object: any, id: string, methods: any[] }>} */
    const byPointer = new Map();
    const published = new WeakMap();
    let next = 0x10000;
    return {
        byPointer,
        /** @param {number} pointer */
        recordAt(pointer){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            return entry;
        },
        /** @param {any} object @param {string} id */
        publishInterface(object, id){
            const record = object.interfaceFor(id);
            if (!record)
            {
                return 0;
            }
            let byInterface = published.get(object);
            if (!byInterface)
            {
                byInterface = new Map();
                published.set(object, byInterface);
            }
            if (byInterface.has(id))
            {
                return byInterface.get(id);
            }
            const pointer = next;
            next += 4;
            byInterface.set(id, pointer);
            byPointer.set(pointer, { object, id, methods: record.methods });
            return pointer;
        },
        /**
         * Calls a method the way the bridge does: the interface pointer the
         * guest pushed identifies the object and is *not* passed on, so `args`
         * begins at the method's first declared argument.
         *
         * @param {number} pointer @param {string} name @param {number[]} args
         */
        call(pointer, name, args = []){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            const method = entry.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method, `${entry.id} has no ${name}`);
            assert.ok(method.invoke, `${entry.id}::${name} is not implemented`);
            return method.invoke(entry.object, args) | 0;
        },
        /**
         * A call whose answer may be a promise, for the methods that call back
         * into guest code -- an enumeration parks the caller while the guest
         * runs, so coercing the answer here would lose it.
         *
         * @param {number} pointer @param {string} name @param {number[]} args
         */
        async callAsync(pointer, name, args = []){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            const method = entry.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method, `${entry.id} has no ${name}`);
            assert.ok(method.invoke, `${entry.id}::${name} is not implemented`);
            return method.invoke(entry.object, args);
        },
        /** @param {number} pointer */
        methodsOf: pointer=>byPointer.get(pointer)?.methods ?? [],
    };
}

function clock(){
    let ms = 5000;
    return { now: ()=>ms, advance: (/** @type {number} */ by)=>{
        ms += by;
    } };
}

/**
 * @param {{ windows?: Record<number, 'top' | 'child'> }} [options]
 *     The windows a SetCooperativeLevel may name, by handle. Without it the
 *     seam is told nothing and takes any handle as a window.
 */
function fixture({ windows } = {}){
    const memory = guestMemory();
    const bridge = fakeBridge();
    const time = clock();
    /** @type {number[]} */
    const signalled = [];
    /**
     * Every call the seam made into guest code, in order, with the structure
     * its first argument pointed at as the callback saw it -- a seam may write
     * the next one over the same memory once the callback has returned.
     *
     * @type {{ entry: number, args: number[], thread: unknown, seen: Uint8Array }[]}
     */
    const calls = [];
    /** What the next guest callback answers; DIENUM_CONTINUE unless told. */
    /** @type {number[]} */
    const answers = [];
    // A fresh token every call, so a test can tell "named once, before the
    // enumeration's first await" from "asked again for a later device" --
    // the second would be a different token in a real bridge, because by
    // then the processor may belong to somebody else.
    let threadRequests = 0;
    let arena = 0x80000;
    const dinput = createDirectInput({
        memory,
        now: time.now,
        publishInterface: (object, id)=>bridge.publishInterface(object, id),
        signal: event=>signalled.push(event),
        /** @param {number} bytes */
        allocate: bytes=>{
            const address = arena;
            arena += (bytes + 15) & ~15;
            return address;
        },
        callGuest: (entry, args, thread)=>{
            calls.push({ entry, args, thread,
                seen: memory.bytes.slice(args[0], args[0] + DIDEVICEINSTANCE.SIZE_W) });
            return Promise.resolve(answers.shift() ?? 1);
        },
        callerThread: ()=>`thread-token-${++threadRequests}`,
        windowKind: windows && (hwnd=>windows[hwnd] ?? null),
    });
    const root = (()=>{
        const result = dinput.libraries['DINPUT.dll']
            .DirectInputCreateA.handler([INSTANCE, 0x0700, AT.out, 0]);
        assert.equal(result, DI_OK);
        return memory.u32(AT.out);
    })();
    return { memory, bridge, time, dinput, signalled, root, calls, answers };
}

/**
 * CreateDevice for one of the two system devices.
 *
 * @param {any} f @param {string} guid
 */
function createDevice(f, guid){
    writeGuid(f.memory, AT.guid, guid);
    const result = f.bridge.call(f.root, 'CreateDevice', [AT.guid, AT.out, 0]);
    assert.equal(result, DI_OK, 'CreateDevice');
    return f.memory.u32(AT.out);
}

const DIDFT_OPTIONAL = 0x80000000;
const ANY_AXIS = 0x00ffff03;
const ANY_BUTTON = 0x00ffff0c;

/**
 * A DIDATAFORMAT and its objects, as dinput.lib's c_dfDIKeyboard (256
 * bytes), c_dfDIMouse (16) and c_dfDIMouse2 (20) lay them out; any other
 * size is `objects`, or none.
 *
 * @param {any} memory @param {number} dataSize
 * @param {{ guid: string | null, offset: number, type: number }[]} [objects]
 */
function dataFormat(memory, dataSize, objects){
    const list = objects ?? (dataSize === 256
        ? Array.from({ length: 256 }, (_, key)=>({
            guid: GUID_Key, offset: key, type: (DIDFT_OPTIONAL | 0x0c | key << 8) >>> 0,
        }))
        : dataSize === 16 || dataSize === 20
            ? [
                { guid: GUID_XAxis, offset: 0, type: ANY_AXIS },
                { guid: GUID_YAxis, offset: 4, type: ANY_AXIS },
                { guid: GUID_ZAxis, offset: 8, type: (DIDFT_OPTIONAL | ANY_AXIS) >>> 0 },
                ...Array.from({ length: dataSize - 12 }, (_, button)=>({
                    guid: null, offset: 12 + button, type: (DIDFT_OPTIONAL | ANY_BUTTON) >>> 0,
                })),
            ]
            : []);
    const guids = [...new Set(list.map(one=>one.guid).filter(guid=>guid !== null))];
    const guidAt = (/** @type {string} */ guid)=>0xd0000 + guids.indexOf(guid) * 16;
    for (const guid of guids)
    {
        writeGuid(memory, guidAt(guid), guid);
    }
    const array = 0xc0000;
    list.forEach((one, index)=>{
        const at = array + index * 16;
        memory.setU32(at, one.guid === null ? 0 : guidAt(one.guid));
        memory.setU32(at + 4, one.offset);
        memory.setU32(at + 8, one.type);
        memory.setU32(at + 12, 0);
    });
    memory.setU32(AT.format + 0x00, 0x18); // dwSize
    memory.setU32(AT.format + 0x04, 0x10); // dwObjSize
    memory.setU32(AT.format + 0x08, 0x02); // DIDF_RELAXIS
    memory.setU32(AT.format + 0x0c, dataSize);
    memory.setU32(AT.format + 0x10, list.length);
    memory.setU32(AT.format + 0x14, array);
    return AT.format;
}

/** @param {any} memory @param {number} address @param {number} max */
function readAnsi(memory, address, max){
    let text = '';
    for (let index = 0; index < max; index++)
    {
        const code = memory.bytes[address + index];
        if (code === 0)
        {
            break;
        }
        text += String.fromCharCode(code);
    }
    return text;
}

/** @param {any} memory @param {number} address @param {number} max */
function readWide(memory, address, max){
    let text = '';
    for (let index = 0; index < max; index++)
    {
        const code = memory.bytes[address + index * 2]
            | memory.bytes[address + index * 2 + 1] << 8;
        if (code === 0)
        {
            break;
        }
        text += String.fromCharCode(code);
    }
    return text;
}

/** A keyboard, created, formatted and acquired. */
function keyboard(f = fixture()){
    const device = createDevice(f, GUID_SysKeyboard);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 256)]), DI_OK);
    assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK);
    return { ...f, device };
}

/** A mouse, created, formatted with DIMOUSESTATE and acquired. */
function mouse(f = fixture(), size = 16){
    const device = createDevice(f, GUID_SysMouse);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, size)]), DI_OK);
    assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK);
    return { ...f, device };
}

/**
 * DIPROP_BUFFERSIZE, set the one way it can be: with the device let go of
 * and taken back afterwards.
 *
 * @param {any} f @param {number} device @param {number} size
 */
function setBufferSize(f, device, size){
    f.bridge.call(device, 'Unacquire', []);
    f.memory.setU32(AT.property + DIPROPDWORD_DATA, size);
    assert.equal(
        f.bridge.call(device, 'SetProperty', [DIPROP_BUFFERSIZE, AT.property]), DI_OK);
    assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK);
}

test('every declared slot counts `this` in its argument size', ()=>{
    for (const slots of [IDIRECTINPUT8_SLOTS, IDIRECTINPUTDEVICE8_SLOTS])
    {
        for (const [name, args] of slots)
        {
            const declared = describe('{00000000-0000-0000-0000-000000000000}',
                [[name, args]]).methods[0];
            assert.equal(declared.argBytes, 4 + args * 4, name);
        }
    }
});

test('IDirectInput8 is not IDirectInput7 with a different name', ()=>{
    // Deriving one from the other puts ConfigureDevices where CreateDeviceEx
    // belongs, and every call after slot 8 lands in the wrong function.
    assert.equal(IDIRECTINPUT7_SLOTS[6][0], 'CreateDeviceEx');
    assert.equal(IDIRECTINPUT8_SLOTS[6][0], 'EnumDevicesBySemantics');
    assert.deepEqual(IDIRECTINPUT8_SLOTS.slice(0, 5), IDIRECTINPUT_SLOTS.slice(0, 5));
});

test('each device generation keeps the previous one\'s slots in place', ()=>{
    const base = IDIRECTINPUTDEVICE_SLOTS.map(([name])=>name);
    const two = IDIRECTINPUTDEVICE2_SLOTS.map(([name])=>name);
    const eight = IDIRECTINPUTDEVICE8_SLOTS.map(([name])=>name);
    assert.deepEqual(two.slice(0, base.length), base);
    assert.deepEqual(eight.slice(0, two.length), two);
    assert.equal(two[base.length], 'CreateEffect');
    assert.equal(eight.at(-1), 'GetImageInfo');
});

test('a published vtable begins with IUnknown\'s three, in order', ()=>{
    const f = fixture();
    const methods = f.bridge.methodsOf(f.root);
    assert.deepEqual(methods.slice(0, 3).map((/** @type {any} */ m)=>m.name),
        IUNKNOWN_METHODS.map(m=>m.name));
    assert.equal(methods[3].name, 'CreateDevice');
});

test('every device slot is present, including the ones nothing implements', ()=>{
    const f = keyboard();
    const names = f.bridge.methodsOf(f.device).slice(3).map((/** @type {any} */ m)=>m.name);
    assert.deepEqual(names, IDIRECTINPUTDEVICE_SLOTS.map(([name])=>name));
    const controlPanel = f.bridge.methodsOf(f.device).find(
        (/** @type {any} */ m)=>m.name === 'RunControlPanel');
    assert.ok(controlPanel, 'a missing slot shifts Initialize and everything after it');
    assert.equal(controlPanel.invoke, undefined);
});

test('CreateDevice hands back the same device for the same GUID', ()=>{
    const f = fixture();
    assert.equal(createDevice(f, GUID_SysKeyboard), createDevice(f, GUID_SysKeyboard));
    assert.notEqual(createDevice(f, GUID_SysMouse), createDevice(f, GUID_SysKeyboard));
});

test('CreateDevice refuses a GUID that names no device it has', ()=>{
    const f = fixture();
    writeGuid(f.memory, AT.guid, '{11111111-2222-3333-4444-555555555555}');
    f.memory.setU32(AT.out, 0xdeadbeef);
    assert.equal(f.bridge.call(f.root, 'CreateDevice', [AT.guid, AT.out, 0]),
        DIERR_DEVICENOTREG);
    assert.equal(f.memory.u32(AT.out), 0, 'and zeroes the pointer it refused to fill');
});

test('CreateDevice hands back the device interface its root is declared with', ()=>{
    // dinput.h: IDirectInput8A::CreateDevice fills an LPDIRECTINPUTDEVICE8A,
    // each earlier root an LPDIRECTINPUTDEVICEA, and a W root the W of either.
    const f = fixture();
    const adapter = f.bridge.recordAt(f.root).object;
    const rootW = f.bridge.publishInterface(adapter, IID_IDirectInputW);
    const root7 = f.bridge.publishInterface(adapter, IID_IDirectInput7A);
    const cases = [
        [f.root, IID_IDirectInputDeviceA, IDIRECTINPUTDEVICE_SLOTS],
        [rootW, IID_IDirectInputDeviceW, IDIRECTINPUTDEVICE_SLOTS],
        [root7, IID_IDirectInputDeviceA, IDIRECTINPUTDEVICE_SLOTS],
        [directInput8(f, false), IID_IDirectInputDevice8A, IDIRECTINPUTDEVICE8_SLOTS],
        [directInput8(f, true), IID_IDirectInputDevice8W, IDIRECTINPUTDEVICE8_SLOTS],
    ];
    for (const [root, id, slots] of /** @type {[number, string, any[]][]} */ (cases))
    {
        writeGuid(f.memory, AT.guid, GUID_SysMouse);
        assert.equal(f.bridge.call(root, 'CreateDevice', [AT.guid, AT.out, 0]), DI_OK);
        const pointer = f.memory.u32(AT.out);
        assert.equal(f.bridge.recordAt(pointer).id, id);
        assert.equal(f.bridge.methodsOf(pointer).length, 3 + slots.length, id);
    }
});

test('CreateDeviceEx hands back the interface the caller named', ()=>{
    const f = fixture();
    writeGuid(f.memory, AT.guid, GUID_SysKeyboard);
    writeGuid(f.memory, AT.iid, IID_IDirectInputDevice8A);
    // CreateDeviceEx arrived with IDirectInput7, so the call has to be made
    // through that interface rather than the one DirectInputCreateA hands out.
    const adapter = f.bridge.recordAt(f.root).object;
    const root7 = f.bridge.publishInterface(adapter, IID_IDirectInput7A);
    assert.equal(f.bridge.call(root7, 'CreateDeviceEx', [AT.guid, AT.iid, AT.out, 0]),
        DI_OK);
    const pointer = f.memory.u32(AT.out);
    // Handing back an IDirectInputDevice here would give a program expecting
    // device8 a vtable fifteen slots long where it calls the twenty-seventh.
    assert.equal(f.bridge.recordAt(pointer).id, IID_IDirectInputDevice8A);
    assert.equal(f.bridge.methodsOf(pointer).length,
        3 + IDIRECTINPUTDEVICE8_SLOTS.length);
});

test('CreateDeviceEx refuses an interface the device does not have', ()=>{
    const f = fixture();
    writeGuid(f.memory, AT.guid, GUID_SysKeyboard);
    writeGuid(f.memory, AT.iid, '{11111111-2222-3333-4444-555555555555}');
    const adapter = f.bridge.recordAt(f.root).object;
    const root7 = f.bridge.publishInterface(adapter, IID_IDirectInput7A);
    assert.equal(f.bridge.call(root7, 'CreateDeviceEx', [AT.guid, AT.iid, AT.out, 0]),
        0x80004002 | 0);
    assert.equal(f.memory.u32(AT.out), 0);
});

test('a device answers to every generation of its interface, and to IUnknown', ()=>{
    const f = keyboard();
    const adapter = f.bridge.recordAt(f.device).object;
    for (const iid of [IID_IDirectInputDeviceA, IID_IDirectInputDevice2A,
        IID_IDirectInputDevice8A, IID_IUNKNOWN])
    {
        assert.ok(adapter.interfaceFor(iid), iid);
    }
    assert.equal(adapter.interfaceFor('{11111111-2222-3333-4444-555555555555}'), null);
});

test('an unacquired device reports so rather than handing back zeroes', ()=>{
    const f = fixture();
    const device = createDevice(f, GUID_SysKeyboard);
    f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 256)]);
    assert.equal(f.bridge.call(device, 'GetDeviceState', [256, AT.state]),
        DIERR_NOTACQUIRED, 'zeroes read as the player letting go of everything');
    // The buffer is another matter before DirectInput 8 -- see the test of it
    // outliving Unacquire -- so the read is refused of a device made by 8.
    const device8th = device8(f, GUID_SysKeyboard, false);
    assert.equal(f.bridge.call(device8th, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]), DIERR_NOTACQUIRED);
});

test('SetDataFormat reads the layout the program describes, object by object', ()=>{
    const f = fixture();
    const device = createDevice(f, GUID_SysMouse);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 16)]), DI_OK);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 20)]), DI_OK);
    // A program's own structure: the Y axis first, then X, then the first
    // button, in twelve bytes of its choosing.
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 12, [
        { guid: GUID_YAxis, offset: 0, type: ANY_AXIS },
        { guid: GUID_XAxis, offset: 4, type: ANY_AXIS },
        { guid: null, offset: 8, type: ANY_BUTTON },
    ])]), DI_OK);
    assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK);
    f.dinput.post({ kind: 'mouseMove', x: 3, y: -2 });
    f.dinput.post({ kind: 'mouseButton', code: 0, down: true });
    assert.equal(f.bridge.call(device, 'GetDeviceState', [12, AT.state]), DI_OK);
    const view = new DataView(f.memory.bytes.buffer);
    assert.equal(view.getInt32(AT.state, true), -2, 'Y where the program put it');
    assert.equal(view.getInt32(AT.state + 4, true), 3);
    assert.equal(f.memory.bytes[AT.state + 8], 0x80);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [0]), DIERR_INVALIDPARAM);
});

test('a format asking for an object the device lacks is refused unless it is optional', ()=>{
    const f = fixture();
    const device = createDevice(f, GUID_SysKeyboard);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 16)]),
        DIERR_INVALIDPARAM, 'a keyboard has no X axis');
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 4, [
        { guid: GUID_XAxis, offset: 0, type: (DIDFT_OPTIONAL | ANY_AXIS) >>> 0 },
    ])]), DI_OK);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 4, [
        { guid: GUID_Key, offset: 4, type: ANY_BUTTON },
    ])]), DIERR_INVALIDPARAM, 'an object past the structure');
});

test('GetDeviceState writes the whole keyboard array', ()=>{
    const f = keyboard();
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [256, AT.state]), DI_OK);
    assert.equal(f.memory.bytes[AT.state + DIK_A], KEY_DOWN);
    assert.equal(f.memory.bytes[AT.state + DIK_S], 0);
});

test('GetDeviceState refuses a size that disagrees with the format that was set', ()=>{
    const f = keyboard();
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [16, AT.state]),
        DIERR_INVALIDPARAM, 'filling 256 bytes would hide the bug behind a smashed stack');
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [256, 0]), DIERR_INVALIDPARAM);
});

test('a size that disagrees with the mouse format that was set is refused', ()=>{
    const f = mouse(fixture(), 16);
    // Both are layouts this device could have had, so only the format the
    // program actually set says which -- and writing twenty bytes into the
    // sixteen it allocated is four bytes of somebody else's stack.
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [20, AT.state]),
        DIERR_INVALIDPARAM);
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [16, AT.state]), DI_OK);
});

test('GetDeviceState writes DIMOUSESTATE as three longs and four buttons', ()=>{
    const f = mouse();
    f.dinput.post({ kind: 'mouseMove', x: 7, y: -4 });
    f.dinput.post({ kind: 'mouseWheel', wheel: 120 });
    f.dinput.post({ kind: 'mouseButton', code: 1, down: true });
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [16, AT.state]), DI_OK);
    assert.equal(f.memory.i32(AT.state + DIMOUSE_OFS.X), 7);
    assert.equal(f.memory.i32(AT.state + DIMOUSE_OFS.Y), -4, 'a signed delta, not a position');
    assert.equal(f.memory.i32(AT.state + DIMOUSE_OFS.Z), 120);
    assert.equal(f.memory.bytes[AT.state + DIMOUSE_OFS.BUTTON0 + 1], KEY_DOWN);
});

test('DIMOUSESTATE2 carries the fifth button DIMOUSESTATE has no room for', ()=>{
    const f = mouse(fixture(), 20);
    f.dinput.post({ kind: 'mouseButton', code: 4, down: true });
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [20, AT.state]), DI_OK);
    assert.equal(f.memory.bytes[AT.state + DIMOUSE_OFS.BUTTON0 + 4], KEY_DOWN);
    // Twenty bytes, not one more: the byte after is the caller's.
    assert.equal(f.memory.bytes[AT.state + 20], 0);
});

test('reading the mouse clears its axes', ()=>{
    const f = mouse();
    f.dinput.post({ kind: 'mouseMove', x: 7, y: 0 });
    f.bridge.call(f.device, 'GetDeviceState', [16, AT.state]);
    f.bridge.call(f.device, 'GetDeviceState', [16, AT.state]);
    assert.equal(f.memory.i32(AT.state + DIMOUSE_OFS.X), 0);
});

test('SetProperty and GetProperty round-trip the buffer size', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 64);
    f.memory.setU32(AT.property + DIPROPDWORD_DATA, 0);
    assert.equal(
        f.bridge.call(f.device, 'GetProperty', [DIPROP_BUFFERSIZE, AT.property]), DI_OK);
    assert.equal(f.memory.u32(AT.property + DIPROPDWORD_DATA), 64);
});

test('an unknown property is accepted on set and refused on get', ()=>{
    const f = keyboard();
    // Ranges and dead zones: the device is already relative and unscaled.
    // joystick8.c takes DIPROP_RANGE on an acquired device.
    assert.equal(f.bridge.call(f.device, 'SetProperty', [DIPROP_RANGE, AT.property]), DI_OK);
    assert.equal(f.bridge.call(f.device, 'GetProperty', [DIPROP_RANGE, AT.property]),
        DIERR_UNSUPPORTED);
    assert.equal(f.bridge.call(f.device, 'SetProperty', [DIPROP_BUFFERSIZE, 0]),
        DIERR_INVALIDPARAM);
});

test('the axis mode is settled before the device is acquired', ()=>{
    // joystick8.c: SetProperty(DIPROP_AXISMODE) on a held device is
    // DIERR_ACQUIRED, as the buffer size is.
    const f = mouse();
    f.memory.setU32(AT.property + DIPROPDWORD_DATA, 1); // DIPROPAXISMODE_REL
    assert.equal(f.bridge.call(f.device, 'SetProperty', [DIPROP_AXISMODE, AT.property]),
        DIERR_ACQUIRED);
    assert.equal(f.bridge.call(f.device, 'Unacquire', []), DI_OK);
    assert.equal(f.bridge.call(f.device, 'SetProperty', [DIPROP_AXISMODE, AT.property]),
        DI_OK);
});

test('GetDeviceData writes DIDEVICEOBJECTDATA and reports how many it wrote', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 32);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    f.time.advance(20);
    f.dinput.post({ kind: 'key', code: DIK_S, down: true });

    f.memory.setU32(AT.count, 10);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]), DI_OK);
    assert.equal(f.memory.u32(AT.count), 2);

    assert.equal(f.memory.u32(AT.data + DIDEVICEOBJECTDATA.dwOfs), DIK_A);
    assert.equal(f.memory.u32(AT.data + DIDEVICEOBJECTDATA.dwData), KEY_DOWN);
    assert.equal(f.memory.u32(AT.data + DIDEVICEOBJECTDATA.dwSequence), 0);
    const second = AT.data + DIDEVICEOBJECTDATA.SIZE;
    assert.equal(f.memory.u32(second + DIDEVICEOBJECTDATA.dwOfs), DIK_S);
    assert.ok(f.memory.u32(second + DIDEVICEOBJECTDATA.dwTimeStamp)
        > f.memory.u32(AT.data + DIDEVICEOBJECTDATA.dwTimeStamp));
});

test('the DirectX 8 entry is twenty bytes and is laid out at that stride', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 32);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    f.dinput.post({ kind: 'key', code: DIK_S, down: true });
    f.memory.setU32(AT.count, 10);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE_DX8, AT.data, AT.count, 0]), DI_OK);
    assert.equal(
        f.memory.u32(AT.data + DIDEVICEOBJECTDATA.SIZE_DX8 + DIDEVICEOBJECTDATA.dwOfs),
        DIK_S, 'at the sixteen-byte stride this would read the first entry\'s tail');
});

test('GetDeviceData refuses an entry size that is neither of the two', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 32);
    f.memory.setU32(AT.count, 10);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData', [12, AT.data, AT.count, 0]),
        DIERR_INVALIDPARAM);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, 0, 0]), DIERR_INVALIDPARAM);
});

test('GetDeviceData on a device with no buffer says it has none', ()=>{
    // joystick8.c: DIERR_NOTBUFFERED until DIPROP_BUFFERSIZE is set, with a
    // well-formed call on a held device -- not an empty read, which a program
    // would take as a device where nothing happened.
    const f = keyboard();
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    f.memory.setU32(AT.count, 1);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 1]), DIERR_NOTBUFFERED);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, 0, AT.count, 0]), DIERR_NOTBUFFERED);
    setBufferSize(f, f.device, 8);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]), DI_OK);
});

test('GetDeviceData with a null array counts without consuming', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 32);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });

    f.memory.setU32(AT.count, 0xffffffff);
    assert.equal(f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, 0, AT.count, 0]), DI_OK);
    assert.equal(f.memory.u32(AT.count), 1);

    f.memory.setU32(AT.count, 10);
    f.bridge.call(f.device, 'GetDeviceData', [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]);
    assert.equal(f.memory.u32(AT.count), 1,
        'a count that consumed would lose every event it reported');
});

test('DIGDD_PEEK leaves the events where they were', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 32);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    f.memory.setU32(AT.count, 10);
    f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 1]);
    assert.equal(f.memory.u32(AT.count), 1);
    f.memory.setU32(AT.count, 10);
    f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]);
    assert.equal(f.memory.u32(AT.count), 1, 'the peek consumed nothing');
});

test('an overflowed buffer answers DI_BUFFEROVERFLOW, which is a success', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 3);
    for (const code of [1, 2, 3, 4])
    {
        f.dinput.post({ kind: 'key', code, down: true });
    }
    f.memory.setU32(AT.count, 10);
    const result = f.bridge.call(f.device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]);
    assert.equal(result, DI_BUFFEROVERFLOW);
    assert.ok(result >= 0, 'a program testing FAILED() must not see this as an error');
    assert.equal(f.memory.u32(AT.count), 2);
});

test('the caller\'s count is a ceiling on how many are drained', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 32);
    for (const code of [1, 2, 3, 4])
    {
        f.dinput.post({ kind: 'key', code, down: true });
    }
    f.memory.setU32(AT.count, 2);
    f.bridge.call(f.device, 'GetDeviceData', [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]);
    assert.equal(f.memory.u32(AT.count), 2);
    assert.equal(f.memory.u32(AT.data + DIDEVICEOBJECTDATA.dwOfs), 1, 'oldest first');
});

test('SetEventNotification is signalled when an event arrives', ()=>{
    const f = keyboard();
    assert.equal(f.bridge.call(f.device, 'SetEventNotification', [0x99]), DI_OK);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    assert.deepEqual(f.signalled, [0x99]);
});

test('nothing is signalled for a device with no notification handle', ()=>{
    const f = keyboard();
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    assert.deepEqual(f.signalled, []);
});

test('an event for a device nobody created is dropped and says so', ()=>{
    const f = fixture();
    assert.equal(f.dinput.post({ kind: 'key', code: DIK_A, down: true }), false);
});

test('unacquiring stops a device taking events, and acquiring resumes it', ()=>{
    const f = keyboard();
    assert.equal(f.bridge.call(f.device, 'Unacquire', []), DI_OK);
    assert.equal(f.dinput.post({ kind: 'key', code: DIK_A, down: true }), false);
    assert.equal(f.bridge.call(f.device, 'Acquire', []), DI_OK);
    assert.equal(f.dinput.post({ kind: 'key', code: DIK_A, down: true }), true);
});

test('a key held across Unacquire and Acquire reads up', ()=>{
    // device8.c test_sys_keyboard: unacquiring resets the device state, so the
    // key still held when the device is taken back is not reported down.
    const f = keyboard();
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [256, AT.state]), DI_OK);
    assert.equal(f.memory.bytes[AT.state + DIK_A], KEY_DOWN);

    assert.equal(f.bridge.call(f.device, 'Unacquire', []), DI_OK);
    assert.equal(f.bridge.call(f.device, 'Acquire', []), DI_OK);
    f.memory.bytes.fill(0xcd, AT.state, AT.state + 256);
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [256, AT.state]), DI_OK);
    const state = [...f.memory.bytes.subarray(AT.state, AT.state + 256)];
    assert.deepEqual(state.flatMap((value, key)=>(value === 0 ? [] : [[key, value]])), []);

    f.dinput.post({ kind: 'key', code: DIK_A, down: false });
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [256, AT.state]), DI_OK);
    assert.equal(f.memory.bytes[AT.state + DIK_A], KEY_DOWN, 'and a new press is seen');
});

test('the buffer outlives Unacquire, and before 8 it can be read while let go', ()=>{
    // device8.c test_sys_mouse with a buffer of five, move for move. Before
    // DirectInput 8 a read between Unacquire and Acquire is DI_OK and takes
    // an event; from 8 it is DIERR_NOTACQUIRED, and the events it left are
    // what overflows the buffer after the next move.
    for (const [version, whileLetGo, afterwards] of [
        [0x0700, DI_OK, DI_OK], [0x0800, DIERR_NOTACQUIRED, DI_BUFFEROVERFLOW]])
    {
        const f = fixture();
        const name = `0x${version.toString(16)}`;
        const root = version === 0x0800 ? directInput8(f, false) : f.root;
        writeGuid(f.memory, AT.guid, GUID_SysMouse);
        assert.equal(f.bridge.call(root, 'CreateDevice', [AT.guid, AT.out, 0]), DI_OK);
        const device = f.memory.u32(AT.out);
        f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 16)]);
        f.memory.setU32(AT.property + DIPROPDWORD_DATA, 5);
        f.bridge.call(device, 'SetProperty', [DIPROP_BUFFERSIZE, AT.property]);
        const read = ()=>{
            f.memory.setU32(AT.count, 1);
            return f.bridge.call(device, 'GetDeviceData',
                [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]);
        };
        const move = ()=>f.dinput.post({ kind: 'mouseMove', x: 10, y: 10 });

        assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK);
        move();
        assert.equal(read(), DI_OK, name);
        assert.equal(f.memory.u32(AT.count), 1);
        move();
        assert.equal(f.bridge.call(device, 'Unacquire', []), DI_OK);
        assert.equal(read(), whileLetGo, name);
        assert.equal(f.memory.u32(AT.count), 1, name);
        assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK);
        move();
        assert.equal(f.bridge.call(device, 'Unacquire', []), DI_OK);
        assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK);
        assert.equal(read(), afterwards, name);
        assert.equal(f.memory.u32(AT.count), 1, name);
    }
});

test('acquiring what is acquired, or releasing what is not, has no effect and says so', ()=>{
    // device8.c test_sys_mouse and test_sys_keyboard: DI_NOEFFECT, which is
    // S_FALSE -- a success, so a program testing FAILED() carries on.
    for (const guid of [GUID_SysMouse, GUID_SysKeyboard])
    {
        const f = fixture();
        const device = createDevice(f, guid);
        const size = guid === GUID_SysMouse ? 16 : 256;
        assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, size)]), DI_OK);
        assert.equal(f.bridge.call(device, 'Unacquire', []), DI_NOEFFECT, guid);
        assert.equal(f.bridge.call(device, 'Acquire', []), DI_OK, guid);
        assert.equal(f.bridge.call(device, 'Acquire', []), DI_NOEFFECT, guid);
        assert.equal(f.bridge.call(device, 'Unacquire', []), DI_OK, guid);
    }
});

test('an acquired device refuses a new buffer size or cooperative level', ()=>{
    // joystick8.c: SetCooperativeLevel and SetProperty(DIPROP_BUFFERSIZE)
    // answer DIERR_ACQUIRED while the device is held, and change nothing.
    const f = keyboard();
    setBufferSize(f, f.device, 8);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    f.memory.setU32(AT.property + DIPROPDWORD_DATA, 64);
    assert.equal(f.bridge.call(f.device, 'SetProperty', [DIPROP_BUFFERSIZE, AT.property]),
        DIERR_ACQUIRED);
    assert.equal(f.bridge.call(f.device, 'SetCooperativeLevel', [0x1234, 0x5]),
        DIERR_ACQUIRED);
    assert.equal(f.dinput.device(GUID_SysKeyboard).bufferSize, 8);
    assert.equal(f.dinput.device(GUID_SysKeyboard).queued, 1, 'and the queue is left alone');

    assert.equal(f.bridge.call(f.device, 'Unacquire', []), DI_OK);
    assert.equal(f.bridge.call(f.device, 'SetCooperativeLevel', [0x1234, 0x5]), DI_OK);
    assert.equal(f.bridge.call(f.device, 'SetProperty', [DIPROP_BUFFERSIZE, AT.property]),
        DI_OK);
    assert.equal(f.dinput.device(GUID_SysKeyboard).bufferSize, 64);
});

test('a device is held exclusively only while acquired at an exclusive level', ()=>{
    const f = fixture();
    const device = createDevice(f, GUID_SysMouse);
    f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 16)]);
    assert.equal(f.bridge.call(device, 'SetCooperativeLevel', [0x1234, 0x1 | 0x4]), DI_OK);
    assert.equal(f.dinput.exclusive('mouse'), false, 'asked for, not yet acquired');
    f.bridge.call(device, 'Acquire', []);
    assert.equal(f.dinput.exclusive('mouse'), true);
    assert.equal(f.dinput.exclusive('keyboard'), false);
    f.bridge.call(device, 'Unacquire', []);
    assert.equal(f.dinput.exclusive('mouse'), false);
    assert.equal(f.bridge.call(device, 'SetCooperativeLevel', [0x1234, 0x2 | 0x4]), DI_OK);
    f.bridge.call(device, 'Acquire', []);
    assert.equal(f.dinput.exclusive('mouse'), false, 'DISCL_NONEXCLUSIVE shares it');
});

test('Poll has nothing to do, and says so from DirectInput 7 on', ()=>{
    // joystick8.c, for a device that does not need polling -- DIDC_ATTACHED
    // | DIDC_EMULATED without DIDC_POLLEDDEVICE, which is what GetCapabilities
    // says of the system pair: DIERR_NOTACQUIRED while it is not held, then
    // DI_OK for a program of a version before 7 and DI_NOEFFECT from 7.
    for (const [version, answer] of [[0x0500, DI_OK], [0x0700, DI_NOEFFECT]])
    {
        const f = fixture();
        assert.equal(f.dinput.libraries['DINPUT.dll']
            .DirectInputCreateA.handler([INSTANCE, version, AT.out, 0]), DI_OK);
        const root = f.memory.u32(AT.out);
        writeGuid(f.memory, AT.guid, GUID_SysMouse);
        assert.equal(f.bridge.call(root, 'CreateDevice', [AT.guid, AT.out, 0]), DI_OK);
        const adapter = f.bridge.recordAt(f.memory.u32(AT.out)).object;
        const device = f.bridge.publishInterface(adapter, IID_IDirectInputDevice2A);
        assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 16)]), DI_OK);
        assert.equal(f.bridge.call(device, 'Poll'), DIERR_NOTACQUIRED, `0x${version.toString(16)}`);
        assert.equal(f.bridge.call(device, 'Acquire'), DI_OK);
        assert.equal(f.bridge.call(device, 'Poll'), answer, `0x${version.toString(16)}`);
    }
    const f = fixture();
    const device = device8(f, GUID_SysKeyboard, false);
    assert.equal(f.bridge.call(device, 'Poll'), DIERR_NOTACQUIRED);
    f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 256)]);
    f.bridge.call(device, 'Acquire');
    assert.equal(f.bridge.call(device, 'Poll'), DI_NOEFFECT);
});

test('SetCooperativeLevel checks its level and its window as Windows does', ()=>{
    // device8.c test_sys_mouse, call for call, and joystick8.c's (NULL, 0).
    const TOP = 0x100;
    const CHILD = 0x200;
    const E_HANDLE = 0x80070006 | 0;
    const EXCLUSIVE = 0x1;
    const NONEXCLUSIVE = 0x2;
    const FOREGROUND = 0x4;
    const BACKGROUND = 0x8;
    const f = fixture({ windows: { [TOP]: 'top', [CHILD]: 'child' } });
    const device = device8(f, GUID_SysMouse, false);
    /** @param {number} hwnd @param {number} flags */
    const level = (hwnd, flags)=>f.bridge.call(device, 'SetCooperativeLevel', [hwnd, flags]);
    assert.equal(level(0, 0), DIERR_INVALIDPARAM);
    assert.deepEqual([
        level(0, FOREGROUND), level(0, FOREGROUND | EXCLUSIVE), level(0, FOREGROUND | NONEXCLUSIVE),
        level(0, BACKGROUND), level(0, BACKGROUND | EXCLUSIVE), level(0, BACKGROUND | NONEXCLUSIVE),
    ], [DIERR_INVALIDPARAM, E_HANDLE, E_HANDLE, DIERR_INVALIDPARAM, E_HANDLE, DI_OK]);
    assert.deepEqual([
        level(TOP, FOREGROUND), level(TOP, FOREGROUND | EXCLUSIVE),
        level(TOP, FOREGROUND | NONEXCLUSIVE), level(TOP, BACKGROUND),
        level(TOP, BACKGROUND | EXCLUSIVE), level(TOP, BACKGROUND | NONEXCLUSIVE),
    ], [DIERR_INVALIDPARAM, DI_OK, DI_OK, DIERR_INVALIDPARAM, DIERR_UNSUPPORTED, DI_OK]);
    assert.deepEqual([
        level(CHILD, FOREGROUND), level(CHILD, FOREGROUND | EXCLUSIVE),
        level(CHILD, FOREGROUND | NONEXCLUSIVE), level(CHILD, BACKGROUND),
        level(CHILD, BACKGROUND | EXCLUSIVE), level(CHILD, BACKGROUND | NONEXCLUSIVE),
    ], [DIERR_INVALIDPARAM, E_HANDLE, E_HANDLE, DIERR_INVALIDPARAM, E_HANDLE, E_HANDLE]);
    assert.equal(level(0x300, FOREGROUND | NONEXCLUSIVE), E_HANDLE, 'a handle to no window');
    assert.equal(level(TOP, FOREGROUND | BACKGROUND | NONEXCLUSIVE), DIERR_INVALIDPARAM);
    assert.equal(level(TOP, FOREGROUND | EXCLUSIVE | NONEXCLUSIVE), DIERR_INVALIDPARAM);

    // test_sys_keyboard: a DirectInput 5 keyboard is never exclusive.
    for (const [version, foreground, background] of [
        [0x0500, DIERR_INVALIDPARAM, DIERR_INVALIDPARAM], [0x0700, DI_OK, DIERR_UNSUPPORTED]])
    {
        assert.equal(f.dinput.libraries['DINPUT.dll']
            .DirectInputCreateA.handler([INSTANCE, version, AT.out, 0]), DI_OK);
        const root = f.memory.u32(AT.out);
        writeGuid(f.memory, AT.guid, GUID_SysKeyboard);
        assert.equal(f.bridge.call(root, 'CreateDevice', [AT.guid, AT.out, 0]), DI_OK);
        const keys = f.memory.u32(AT.out);
        const name = `0x${version.toString(16)}`;
        assert.equal(f.bridge.call(keys, 'SetCooperativeLevel', [TOP, FOREGROUND | EXCLUSIVE]),
            foreground, name);
        assert.equal(f.bridge.call(keys, 'SetCooperativeLevel', [TOP, BACKGROUND | EXCLUSIVE]),
            background, name);
        assert.equal(f.bridge.call(keys, 'SetCooperativeLevel', [0, FOREGROUND | EXCLUSIVE]),
            E_HANDLE, name);
        assert.equal(f.bridge.call(keys, 'SetCooperativeLevel', [TOP, FOREGROUND | NONEXCLUSIVE]),
            DI_OK, name);
    }
});

test('GetCapabilities fills DIDEVCAPS and needs a header that declares its size', ()=>{
    const f = keyboard();
    assert.equal(f.bridge.call(f.device, 'GetCapabilities', [AT.caps]),
        DIERR_INVALIDPARAM);
    f.memory.setU32(AT.caps + DIDEVCAPS.dwSize, DIDEVCAPS.SIZE);
    assert.equal(f.bridge.call(f.device, 'GetCapabilities', [AT.caps]), DI_OK);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwAxes), 0);
    // device8.c test_sys_keyboard: 128, not the 256 bytes of its state.
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwButtons), 128);
});

test('a mouse reports three axes and the five buttons a host can press', ()=>{
    // device8.c test_sys_mouse: 3 or 5 buttons, as the hardware has -- and
    // left, right, middle and the two side buttons are the five a page gives.
    const f = mouse();
    f.memory.setU32(AT.caps + DIDEVCAPS.dwSize, DIDEVCAPS.SIZE);
    f.bridge.call(f.device, 'GetCapabilities', [AT.caps]);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwAxes), 3);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwButtons), 5);
});

test('GetCapabilities names the device type in the codes of the version that made it', ()=>{
    // device8.c test_sys_mouse and test_sys_keyboard: the family in the low
    // byte and the subtype above it, DI8DEVTYPE_* from 8 and DIDEVTYPE_*
    // before it -- the mouse's subtype unknown, the keyboard's PC enhanced.
    const f = fixture();
    const root8 = directInput8(f, false);
    const cases = [
        [f.root, GUID_SysMouse, 0x0102],
        [f.root, GUID_SysKeyboard, 0x0403],
        [root8, GUID_SysMouse, 0x0112],
        [root8, GUID_SysKeyboard, 0x0413],
    ];
    for (const [root, guid, devType] of /** @type {[number, string, number][]} */ (cases))
    {
        writeGuid(f.memory, AT.guid, guid);
        assert.equal(f.bridge.call(root, 'CreateDevice', [AT.guid, AT.out, 0]), DI_OK);
        const device = f.memory.u32(AT.out);
        f.memory.setU32(AT.caps + DIDEVCAPS.dwSize, DIDEVCAPS.SIZE);
        assert.equal(f.bridge.call(device, 'GetCapabilities', [AT.caps]), DI_OK);
        assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwDevType), devType,
            `${guid} from ${f.bridge.recordAt(root).id}`);
        // DIDC_ATTACHED | DIDC_EMULATED, as both tests expect of the system pair.
        assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwFlags), 0x5);
    }
});

test('a device asked for a later generation keeps its version\'s device type', ()=>{
    const f = mouse();
    const adapter = f.bridge.recordAt(f.device).object;
    const device7 = f.bridge.publishInterface(adapter, IID_IDirectInputDevice7A);
    f.memory.setU32(AT.caps + DIDEVCAPS.dwSize, DIDEVCAPS.SIZE);
    assert.equal(f.bridge.call(device7, 'GetCapabilities', [AT.caps]), DI_OK);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwDevType), 0x0102);
});

const E_POINTER = 0x80004003 | 0;
const DIERR_NOTFOUND = 0x80070002 | 0;
const DIDFT_ALL = 0;
const DIDFT_AXIS = 0x03;
const DIDFT_RELAXIS = 0x01;
const DIDFT_PSHBUTTON = 0x04;
const DIDFT_TGLBUTTON = 0x08;
const DIDFT_FFACTUATOR = 0x01000000;
const DIDOI_ASPECTPOSITION = 0x100;
const DIPH_DEVICE = 0;
const DIPH_BYOFFSET = 1;
const DIPH_BYID = 2;
const DIPH_BYUSAGE = 3;
/** @param {number} instance */
const DIDFT_MAKEINSTANCE = instance=>instance << 8;
const GUID_XAxis = '{A36D02E0-C9F3-11CF-BFC7-444553540000}';
const GUID_YAxis = '{A36D02E1-C9F3-11CF-BFC7-444553540000}';
const GUID_ZAxis = '{A36D02E2-C9F3-11CF-BFC7-444553540000}';
const GUID_Button = '{A36D02F0-C9F3-11CF-BFC7-444553540000}';
const GUID_Key = '{55728220-D33C-11CF-BFC7-444553540000}';
const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/**
 * A device made by an IDirectInput8 root, in the width asked for.
 *
 * @param {any} f @param {string} guid @param {boolean} wide
 */
function device8(f, guid, wide){
    const root8 = directInput8(f, wide);
    writeGuid(f.memory, AT.guid, guid);
    assert.equal(f.bridge.call(root8, 'CreateDevice', [AT.guid, AT.out, 0]), DI_OK);
    return f.memory.u32(AT.out);
}

/**
 * The fields of a DIDEVICEOBJECTINSTANCE that Wine's device8.c checks, read
 * from bytes the seam wrote.
 *
 * @param {Uint8Array} bytes @param {boolean} wide
 */
function objectInstance(bytes, wide){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const O = DIDEVICEOBJECTINSTANCE;
    let name = '';
    for (let index = 0; index < O.NAME_CHARS; index++)
    {
        const code = wide ? view.getUint16(O.tszName + index * 2, true)
            : bytes[O.tszName + index];
        if (code === 0)
        {
            break;
        }
        name += String.fromCharCode(code);
    }
    return {
        dwSize: view.getUint32(O.dwSize, true),
        guidType: formatGuid(bytes.subarray(O.guidType, O.guidType + 16)),
        dwOfs: view.getUint32(O.dwOfs, true),
        dwType: view.getUint32(O.dwType, true),
        dwFlags: view.getUint32(O.dwFlags, true),
        name,
    };
}

test('GetDeviceInfo describes the device in the interface\'s width and version', ()=>{
    // device8.c test_sys_mouse and test_sys_keyboard: both instance sizes
    // are accepted, each GUID is the device's own, and the type is the one
    // GetCapabilities gives.
    const f = fixture();
    const mouse8 = device8(f, GUID_SysMouse, true);
    f.memory.bytes.fill(0xaa, AT.state, AT.state + 0x500);
    f.memory.setU32(AT.state, DIDEVICEINSTANCE.SIZE_W);
    assert.equal(f.bridge.call(mouse8, 'GetDeviceInfo', [AT.state]), DI_OK);
    assert.equal(f.memory.u32(AT.state + DIDEVICEINSTANCE.dwSize), DIDEVICEINSTANCE.SIZE_W);
    assert.equal(readGuid(f.memory, AT.state + DIDEVICEINSTANCE.guidInstance), GUID_SysMouse);
    assert.equal(readGuid(f.memory, AT.state + DIDEVICEINSTANCE.guidProduct), GUID_SysMouse);
    assert.equal(f.memory.u32(AT.state + DIDEVICEINSTANCE.dwDevType), 0x0112);
    assert.equal(readWide(f.memory, AT.state + DIDEVICEINSTANCE.tszInstanceName, 260), 'Mouse');
    assert.equal(readWide(f.memory,
        AT.state + DIDEVICEINSTANCE.tszInstanceName + 520, 260), 'Mouse');
    const ffDriver = AT.state + DIDEVICEINSTANCE.tszInstanceName + 1040;
    assert.equal(readGuid(f.memory, ffDriver), GUID_NULL);
    assert.equal(f.memory.u32(ffDriver + 16), 0, 'wUsagePage and wUsage');
    assert.equal(f.memory.bytes[AT.state + DIDEVICEINSTANCE.SIZE_W], 0xaa);

    // DIDEVICEINSTANCE_DX3W ends where guidFFDriver would begin.
    f.memory.bytes.fill(0xaa, AT.state, AT.state + 0x500);
    f.memory.setU32(AT.state, DIDEVICEINSTANCE.SIZE_DX3_W);
    assert.equal(f.bridge.call(mouse8, 'GetDeviceInfo', [AT.state]), DI_OK);
    assert.equal(f.memory.u32(AT.state + DIDEVICEINSTANCE.dwDevType), 0x0112);
    assert.equal(f.memory.bytes[AT.state + DIDEVICEINSTANCE.SIZE_DX3_W], 0xaa,
        'nothing past the size the caller declared');

    const keyboardA = createDevice(f, GUID_SysKeyboard);
    f.memory.setU32(AT.state, DIDEVICEINSTANCE.SIZE_A);
    assert.equal(f.bridge.call(keyboardA, 'GetDeviceInfo', [AT.state]), DI_OK);
    assert.equal(f.memory.u32(AT.state + DIDEVICEINSTANCE.dwDevType), 0x0403);
    assert.equal(readAnsi(f.memory,
        AT.state + DIDEVICEINSTANCE.tszInstanceName, 260), 'Keyboard');
    f.memory.setU32(AT.state, DIDEVICEINSTANCE.SIZE_DX3_A);
    assert.equal(f.bridge.call(keyboardA, 'GetDeviceInfo', [AT.state]), DI_OK);

    f.memory.setU32(AT.state, DIDEVICEINSTANCE.SIZE_A);
    assert.equal(f.bridge.call(mouse8, 'GetDeviceInfo', [AT.state]), DIERR_INVALIDPARAM,
        'an ANSI size through a W interface');
    assert.equal(f.bridge.call(mouse8, 'GetDeviceInfo', [0]), E_POINTER);
});

test('EnumObjects runs the callback once per object of the types asked for', async()=>{
    const f = fixture();
    const device = device8(f, GUID_SysMouse, true);
    f.memory.setU32(AT.caps + DIDEVCAPS.dwSize, DIDEVCAPS.SIZE);
    assert.equal(f.bridge.call(device, 'GetCapabilities', [AT.caps]), DI_OK);
    const axes = f.memory.u32(AT.caps + DIDEVCAPS.dwAxes);
    const buttons = f.memory.u32(AT.caps + DIDEVCAPS.dwButtons);

    // device8.c: the axes and buttons together are what GetCapabilities
    // counted, and the axes alone are three.
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects',
        [0x20, 0x99, DIDFT_AXIS | DIDFT_PSHBUTTON]), DI_OK);
    assert.equal(f.calls.length, axes + buttons);
    assert.ok(f.calls.every(call=>call.entry === 0x20 && call.args[1] === 0x99));
    f.calls.length = 0;
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects', [0x20, 0, DIDFT_AXIS]), DI_OK);
    assert.equal(f.calls.length, 3);

    f.calls.length = 0;
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects', [0x20, 0, DIDFT_ALL]), DI_OK);
    const seen = f.calls.map(call=>objectInstance(call.seen, true));
    const expected = [
        [GUID_XAxis, 0x0, DIDFT_RELAXIS | DIDFT_MAKEINSTANCE(0), DIDOI_ASPECTPOSITION, 'X-axis'],
        [GUID_YAxis, 0x4, DIDFT_RELAXIS | DIDFT_MAKEINSTANCE(1), DIDOI_ASPECTPOSITION, 'Y-axis'],
        [GUID_ZAxis, 0x8, DIDFT_RELAXIS | DIDFT_MAKEINSTANCE(2), DIDOI_ASPECTPOSITION, 'Wheel'],
        [GUID_Button, 0xc, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(3), 0, 'Button 0'],
        [GUID_Button, 0xd, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(4), 0, 'Button 1'],
    ];
    expected.forEach(([guidType, dwOfs, dwType, dwFlags, name], index)=>{
        assert.deepEqual(seen[index], {
            dwSize: DIDEVICEOBJECTINSTANCE.SIZE_W, guidType, dwOfs, dwType, dwFlags, name,
        });
    });
});

test('only DIENUM_STOP ends an object enumeration', async()=>{
    const f = fixture();
    const device = device8(f, GUID_SysMouse, false);
    // device8.c check_object_count_bad_retval: -1 is not a stop.
    f.answers.push(-1, -1);
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects', [0x20, 0, DIDFT_AXIS]), DI_OK);
    assert.equal(f.calls.length, 3);
    f.calls.length = 0;
    f.answers.push(1, DIENUM_STOP);
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects', [0x20, 0, DIDFT_ALL]), DI_OK);
    assert.equal(f.calls.length, 2);
    assert.equal(objectInstance(f.calls[0].seen, false).name, 'X-axis', 'in the ANSI width');
    assert.equal(objectInstance(f.calls[0].seen, false).dwSize, DIDEVICEOBJECTINSTANCE.SIZE_A);

    f.calls.length = 0;
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects',
        [0x20, 0, DIDFT_ALL | DIDFT_FFACTUATOR]), DI_OK);
    assert.equal(f.calls.length, 0, 'nothing here has an actuator');
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects', [0, 0, DIDFT_ALL]),
        DIERR_INVALIDPARAM);
});

test('the keyboard\'s objects are its keys, one per DIK code, in code order', async()=>{
    const f = fixture();
    const device = device8(f, GUID_SysKeyboard, true);
    assert.equal(await f.bridge.callAsync(device, 'EnumObjects', [0x20, 0, DIDFT_ALL]), DI_OK);
    const keys = f.calls.map(call=>objectInstance(call.seen, true));
    assert.ok(keys.length > 100, `a full keyboard, not ${keys.length} keys`);
    // device8.c test_sys_keyboard's first five, names included.
    assert.deepEqual(keys.slice(0, 5).map(key=>[key.guidType, key.dwOfs, key.dwType, key.name]), [
        [GUID_Key, 0x01, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(0x01), 'Esc'],
        [GUID_Key, 0x02, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(0x02), '1'],
        [GUID_Key, 0x03, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(0x03), '2'],
        [GUID_Key, 0x04, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(0x04), '3'],
        [GUID_Key, 0x05, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(0x05), '4'],
    ]);
    const offsets = keys.map(key=>key.dwOfs);
    assert.deepEqual(offsets, [...offsets].sort((a, b)=>a - b));
    assert.ok(keys.every(key=>key.name !== ''), 'every key has a name');
    const byOffset = new Map(keys.map(key=>[key.dwOfs, key.name]));
    assert.equal(byOffset.get(DIK_A), 'A');
    assert.equal(byOffset.get(0xc8), 'Up', 'DIK_UP, an extended key');
});

test('GetObjectInfo finds an object by offset or by id, and not by usage', ()=>{
    const f = fixture();
    const mouse8 = device8(f, GUID_SysMouse, true);
    f.memory.setU32(AT.state, DIDEVICEOBJECTINSTANCE.SIZE_W);
    // device8.c test_sys_mouse, call for call.
    assert.equal(f.bridge.call(mouse8, 'GetObjectInfo', [AT.state, 0x00010030, DIPH_BYUSAGE]),
        DIERR_UNSUPPORTED);
    assert.equal(f.bridge.call(mouse8, 'GetObjectInfo', [AT.state, 4, DIPH_BYOFFSET]), DI_OK);
    assert.deepEqual(objectInstance(f.memory.bytes.subarray(AT.state), true), {
        dwSize: DIDEVICEOBJECTINSTANCE.SIZE_W, guidType: GUID_YAxis, dwOfs: 4,
        dwType: DIDFT_RELAXIS | DIDFT_MAKEINSTANCE(1), dwFlags: DIDOI_ASPECTPOSITION,
        name: 'Y-axis',
    });
    assert.equal(f.bridge.call(mouse8, 'GetObjectInfo', [AT.state, 7, DIPH_BYOFFSET]),
        DIERR_NOTFOUND);
    assert.equal(f.bridge.call(mouse8, 'GetObjectInfo',
        [AT.state, DIDFT_TGLBUTTON | DIDFT_MAKEINSTANCE(3), DIPH_BYID]), DIERR_NOTFOUND);
    assert.equal(f.bridge.call(mouse8, 'GetObjectInfo',
        [AT.state, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(3), DIPH_BYID]), DI_OK);
    assert.equal(objectInstance(f.memory.bytes.subarray(AT.state), true).name, 'Button 0');
    assert.equal(f.bridge.call(mouse8, 'GetObjectInfo', [AT.state, 4, DIPH_DEVICE]),
        DIERR_INVALIDPARAM);

    // test_sys_keyboard: a key's offset is its DIK code, and so is its instance.
    const keyboard8 = device8(f, GUID_SysKeyboard, true);
    assert.equal(f.bridge.call(keyboard8, 'GetObjectInfo', [AT.state, 2, DIPH_BYOFFSET]),
        DI_OK);
    assert.equal(objectInstance(f.memory.bytes.subarray(AT.state), true).name, '1');
    assert.equal(f.bridge.call(keyboard8, 'GetObjectInfo', [AT.state, 423, DIPH_BYOFFSET]),
        DIERR_NOTFOUND);
    assert.equal(f.bridge.call(keyboard8, 'GetObjectInfo',
        [AT.state, DIDFT_PSHBUTTON | DIDFT_MAKEINSTANCE(3), DIPH_BYID]), DI_OK);
    assert.equal(objectInstance(f.memory.bytes.subarray(AT.state), true).dwOfs, 3);
});

test('GetObjectInfo writes the structure size the caller declared, and no more', ()=>{
    const f = fixture();
    const mouseA = createDevice(f, GUID_SysMouse);
    f.memory.bytes.fill(0xaa, AT.state, AT.state + 0x300);
    f.memory.setU32(AT.state, DIDEVICEOBJECTINSTANCE.SIZE_DX3_A);
    assert.equal(f.bridge.call(mouseA, 'GetObjectInfo', [AT.state, 0, DIPH_BYOFFSET]), DI_OK);
    assert.equal(objectInstance(f.memory.bytes.subarray(AT.state), false).name, 'X-axis');
    assert.equal(f.memory.u32(AT.state), DIDEVICEOBJECTINSTANCE.SIZE_DX3_A);
    assert.equal(f.memory.bytes[AT.state + DIDEVICEOBJECTINSTANCE.SIZE_DX3_A], 0xaa);
    f.memory.setU32(AT.state, DIDEVICEOBJECTINSTANCE.SIZE_W);
    assert.equal(f.bridge.call(mouseA, 'GetObjectInfo', [AT.state, 0, DIPH_BYOFFSET]),
        DIERR_INVALIDPARAM, 'a W size through an ANSI interface');
    assert.equal(f.bridge.call(mouseA, 'GetObjectInfo', [0, 0, DIPH_BYOFFSET]), E_POINTER);
});

test('GetDeviceStatus knows the two devices and nothing else', ()=>{
    const f = fixture();
    writeGuid(f.memory, AT.guid, GUID_SysMouse);
    assert.equal(f.bridge.call(f.root, 'GetDeviceStatus', [AT.guid]), DI_OK);
    writeGuid(f.memory, AT.guid, '{11111111-2222-3333-4444-555555555555}');
    assert.equal(f.bridge.call(f.root, 'GetDeviceStatus', [AT.guid]), DIERR_DEVICENOTREG);
});

/**
 * A DirectInput 8 object, published through the interface the caller names.
 *
 * @param {any} f @param {boolean} wide
 */
function directInput8(f, wide){
    writeGuid(f.memory, AT.iid, wide ? IID_IDirectInput8W : IID_IDirectInput8A);
    assert.equal(f.dinput.libraries['DINPUT8.dll']
        .DirectInput8Create.handler([INSTANCE, 0x0800, AT.iid, AT.out, 0]), DI_OK);
    return f.memory.u32(AT.out);
}

test('EnumDevices describes the mouse and the keyboard to the callback', async()=>{
    const f = fixture();
    const root8 = directInput8(f, true);
    assert.equal(await f.bridge.callAsync(root8, 'EnumDevices', [0, 0x7777, 0x9999, 0]),
        DI_OK);
    assert.equal(f.calls.length, 2, 'there is one callback per attached device');
    assert.equal(f.calls[0].entry, 0x7777);
    assert.equal(f.calls[0].args[1], 0x9999, 'the caller\'s context is passed through');

    // Wine's order: the pointer's class is enumerated first, then the
    // keyboard's, and each is written in the width of the W vtable that ran it.
    const mouseInstance = f.calls[0].args[0];
    assert.equal(f.memory.u32(mouseInstance + DIDEVICEINSTANCE.dwSize),
        DIDEVICEINSTANCE.SIZE_W);
    assert.equal(readGuid(f.memory, mouseInstance + DIDEVICEINSTANCE.guidInstance),
        GUID_SysMouse);
    // DI8DEVTYPEMOUSE_UNKNOWN, what joystick8.c's enumeration expects of the
    // system mouse on Windows and what GetCapabilities and GetDeviceInfo say.
    assert.equal(f.memory.u32(mouseInstance + DIDEVICEINSTANCE.dwDevType), 0x0112);
    assert.equal(readWide(f.memory,
        mouseInstance + DIDEVICEINSTANCE.tszInstanceName, 260), 'Mouse');
    assert.equal(readWide(f.memory,
        mouseInstance + DIDEVICEINSTANCE.tszInstanceName + 260 * 2, 260), 'Mouse');

    const keyboardInstance = f.calls[1].args[0];
    assert.equal(readGuid(f.memory, keyboardInstance + DIDEVICEINSTANCE.guidInstance),
        GUID_SysKeyboard);
    assert.equal(f.memory.u32(keyboardInstance + DIDEVICEINSTANCE.dwDevType), 0x0413);
    assert.equal(readWide(f.memory,
        keyboardInstance + DIDEVICEINSTANCE.tszInstanceName, 260), 'Keyboard');
});

test('a second device\'s callback answers on the same thread as the first', async()=>{
    // NFS: Most Wanted's demo enumerates all devices, and its callback
    // creates and acquires each one right there -- so the mouse's callback
    // does not return to `enumerate`'s loop until well after an await. A
    // loop that asked the bridge for "the current thread" again for the
    // keyboard would be asking after that await, when the processor may
    // belong to another thread entirely; the bridge's own contract is to
    // refuse a callback in that position rather than guess. `enumerate` is
    // required to name the thread once, before its first await, and use
    // that same name for every device -- which this pins by giving a fresh
    // token on every ask and requiring both calls to have taken the first.
    const f = fixture();
    const root8 = directInput8(f, true);
    assert.equal(await f.bridge.callAsync(root8, 'EnumDevices', [0, 0x7777, 0x9999, 0]),
        DI_OK);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].thread, 'thread-token-1');
    assert.equal(f.calls[1].thread, 'thread-token-1',
        'the keyboard\'s callback names the same thread the mouse\'s did');
});

test('an interface before 8 uses the older device-type codes', async()=>{
    const f = fixture();
    assert.equal(await f.bridge.callAsync(f.root, 'EnumDevices', [0, 0x20, 0, 0]), DI_OK);
    assert.equal(f.calls.length, 2);
    const mouseInstance = f.calls[0].args[0];
    assert.equal(f.memory.u32(mouseInstance + DIDEVICEINSTANCE.dwSize),
        DIDEVICEINSTANCE.SIZE_A);
    assert.equal(f.memory.u32(mouseInstance + DIDEVICEINSTANCE.dwDevType), 0x0102);
    assert.equal(readAnsi(f.memory,
        mouseInstance + DIDEVICEINSTANCE.tszInstanceName, 260), 'Mouse');
    assert.equal(f.memory.u32(f.calls[1].args[0] + DIDEVICEINSTANCE.dwDevType), 0x0403);
});

test('a class filter narrows the enumeration to that class', async()=>{
    const f = fixture();
    assert.equal(await f.bridge.callAsync(f.root, 'EnumDevices', [3, 0x20, 0, 0]), DI_OK);
    assert.equal(f.calls.length, 1, 'the keyboard class names only the keyboard');
    assert.equal(readAnsi(f.memory,
        f.calls[0].args[0] + DIDEVICEINSTANCE.tszInstanceName, 260), 'Keyboard');
});

test('the pointer class names the mouse, and nothing else', async()=>{
    const f = fixture();
    assert.equal(await f.bridge.callAsync(f.root, 'EnumDevices', [2, 0x20, 0, 0]), DI_OK);
    assert.equal(f.calls.length, 1);
    assert.equal(f.memory.u32(f.calls[0].args[0] + DIDEVICEINSTANCE.dwDevType), 0x0102);
});

test('a specific device type asks for one device rather than a class', async()=>{
    const f = fixture();
    const root8 = directInput8(f, false);
    assert.equal(await f.bridge.callAsync(root8, 'EnumDevices', [0x13, 0x20, 0, 0]), DI_OK);
    assert.equal(f.calls.length, 1);
    assert.equal(f.memory.u32(f.calls[0].args[0] + DIDEVICEINSTANCE.dwDevType), 0x0413);
});

test('a callback that answers DIENUM_STOP ends the enumeration', async()=>{
    const f = fixture();
    const root8 = directInput8(f, true);
    f.answers.push(DIENUM_STOP);
    assert.equal(await f.bridge.callAsync(root8, 'EnumDevices', [0, 0x20, 0, 0]), DI_OK);
    assert.equal(f.calls.length, 1, 'the device after the refusal is never described');
});

test('a force-feedback request lists nothing, because nothing here rumbles', async()=>{
    const f = fixture();
    const root8 = directInput8(f, true);
    assert.equal(await f.bridge.callAsync(root8, 'EnumDevices', [0, 0x20, 0, 0x100]), DI_OK);
    assert.equal(f.calls.length, 0);
});

test('DIEDFL_ATTACHEDONLY still lists both system devices', async()=>{
    const f = fixture();
    const root8 = directInput8(f, true);
    assert.equal(await f.bridge.callAsync(root8, 'EnumDevices', [0, 0x20, 0, 1]), DI_OK);
    assert.equal(f.calls.length, 2);
});

test('EnumDevices refuses a null callback rather than running nothing', async()=>{
    const f = fixture();
    assert.equal(await f.bridge.callAsync(f.root, 'EnumDevices', [0, 0, 0, 0]),
        DIERR_INVALIDPARAM);
    assert.equal(f.calls.length, 0);
});

test('the libraries export the entry points a program links against', ()=>{
    const f = fixture();
    assert.equal(f.dinput.libraries['DINPUT.dll'].DirectInputCreateA.argBytes, 16);
    assert.equal(f.dinput.libraries['DINPUT.dll'].DirectInputCreateEx.argBytes, 20);
    assert.equal(f.dinput.libraries['DINPUT8.dll'].DirectInput8Create.argBytes, 20);
    for (const table of Object.values(f.dinput.libraries))
    {
        for (const [name, entry] of Object.entries(table))
        {
            assert.equal(entry.argBytes % 4, 0, `${name} is not a whole number of slots`);
        }
    }
});

test('DirectInput8Create hands back the interface the caller asked for', ()=>{
    const f = fixture();
    writeGuid(f.memory, AT.iid, IID_IDirectInput8A);
    assert.equal(f.dinput.libraries['DINPUT8.dll']
        .DirectInput8Create.handler([INSTANCE, 0x0800, AT.iid, AT.out, 0]), DI_OK);
    const pointer = f.memory.u32(AT.out);
    assert.equal(f.bridge.recordAt(pointer).id, IID_IDirectInput8A);
    assert.equal(f.bridge.methodsOf(pointer).length, 3 + IDIRECTINPUT8_SLOTS.length);
});

test('DirectInput8Create with an interface it has not answers E_NOINTERFACE', ()=>{
    const f = fixture();
    writeGuid(f.memory, AT.iid, '{11111111-2222-3333-4444-555555555555}');
    assert.equal(f.dinput.libraries['DINPUT8.dll']
        .DirectInput8Create.handler([INSTANCE, 0x0800, AT.iid, AT.out, 0]), 0x80004002 | 0);
    assert.equal(f.memory.u32(AT.out), 0);
});

test('the entry points refuse to write through a null', ()=>{
    const f = fixture();
    assert.equal(f.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0700, 0, 0]), E_POINTER);
});

test('the publisher keeps one adapter per object and can find it again', ()=>{
    let next = 0x9000;
    const publisher = createPublisher({ publishInterface: ()=>{
        next += 4;
        return next;
    } });
    const object = { addRef: ()=>1, release: ()=>0 };
    const interfaces = [describe(IID_IDirectInputA, IDIRECTINPUT_SLOTS)];
    const pointer = publisher.publish(object, interfaces, IID_IDirectInputA);
    assert.equal(publisher.objectAt(pointer), object);
    assert.equal(publisher.objectAt(0), null);
});

/**
 * The seam behind the bridge's own vtable publisher, over the same flat memory
 * and called by slot number -- which is the one path a guest actually takes.
 *
 * The fixture above stands in for the bridge and can therefore disagree with
 * it. This cannot: the publisher is the real one, so where a method's arguments
 * land is decided by the code that decides it in a running program.
 */
function guestMachine(){
    const memory = guestMemory();
    /** @type {Map<number, any>} */
    const traps = new Map();
    let nextTrap = 1;
    let heapNext = 0x8000;
    const vtables = createVtables({
        memory: {
            /** @param {number} at @param {number} length */
            readBytes: (at, length)=>memory.bytes.slice(at, at + length),
            /** @param {number} at @param {Uint8Array} value */
            writeBytes: (at, value)=>memory.bytes.set(value, at),
            /** @param {number} at */
            readU32: at=>memory.u32(at),
            /** @param {number} at @param {number} value */
            writeU32: (at, value)=>memory.setU32(at, value),
        },
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            const trap = nextTrap++;
            traps.set(trap, fn);
            return trap;
        },
        heap: {
            /** @param {number} size */
            allocate: size=>{
                const at = heapNext;
                heapNext += size + 16 & ~15;
                return at;
            },
        },
    });

    const dinput = createDirectInput({
        memory,
        now: ()=>5000,
        publishInterface: (object, id)=>vtables.publish(object, id),
    });

    return {
        memory,
        dinput,
        /**
         * A call as the guest makes it: the interface pointer is pushed like
         * any other argument, and the publisher is what decides it is not one.
         *
         * @param {number} pointer @param {number} index @param {number[]} args
         */
        call(pointer, index, args = []){
            const entry = traps.get(memory.u32(memory.u32(pointer) + index * 4));
            assert.ok(entry, `slot ${index} has an implementation`);
            return entry.handler([pointer, ...args]) | 0;
        },
    };
}

/** @param {[string, number][]} slots @param {string} name */
const slotOf = (slots, name)=>{
    const index = slots.findIndex(([entry])=>entry === name);
    assert.ok(index >= 0, `${name} is a slot`);
    return 3 + index;
};

test('a method reaches the arguments the guest pushed, at the offsets it pushed them', ()=>{
    const g = guestMachine();
    assert.equal(g.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0700, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    assert.notEqual(root, 0);

    writeGuid(g.memory, AT.guid, GUID_SysKeyboard);
    assert.equal(g.call(root, slotOf(IDIRECTINPUT_SLOTS, 'CreateDevice'),
        [AT.guid, AT.out, 0]), DI_OK);
    const device = g.memory.u32(AT.out);
    assert.notEqual(device, 0);

    // SetDataFormat takes one argument, and reading the slot above it would
    // find nothing a program ever pushed there.
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE_SLOTS, 'SetDataFormat'),
        [dataFormat(g.memory, 256)]), DI_OK);
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE_SLOTS, 'Acquire')), DI_OK);

    // GetDeviceState(size, data): two adjacent arguments, so reading them one
    // late takes the pointer for the size and refuses every call.
    g.dinput.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE_SLOTS, 'GetDeviceState'),
        [256, AT.state]), DI_OK);
    assert.equal(g.memory.bytes[AT.state + DIK_A], KEY_DOWN);
});

test('a device made by IDirectInput8 answers Poll from its own slot', ()=>{
    const g = guestMachine();
    writeGuid(g.memory, AT.iid, IID_IDirectInput8A);
    assert.equal(g.dinput.libraries['DINPUT8.dll']
        .DirectInput8Create.handler([INSTANCE, 0x0800, AT.iid, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.guid, GUID_SysMouse);
    assert.equal(g.call(root, slotOf(IDIRECTINPUT8_SLOTS, 'CreateDevice'),
        [AT.guid, AT.out, 0]), DI_OK);
    const device = g.memory.u32(AT.out);
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE8_SLOTS, 'SetDataFormat'),
        [dataFormat(g.memory, 16)]), DI_OK);
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE8_SLOTS, 'Acquire')), DI_OK);
    // Slot 25, ten past the end of an IDirectInputDevice's table: a program
    // holding what IDirectInput8 promised calls it without asking for it.
    assert.equal(slotOf(IDIRECTINPUTDEVICE8_SLOTS, 'Poll'), 25);
    assert.equal(g.call(device, 25), DI_NOEFFECT);
});

test('QueryInterface finds each device generation by the IID the header defines', ()=>{
    const g = guestMachine();
    assert.equal(g.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0500, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.guid, GUID_SysMouse);
    assert.equal(g.call(root, slotOf(IDIRECTINPUT_SLOTS, 'CreateDevice'),
        [AT.guid, AT.out, 0]), DI_OK);
    const device = g.memory.u32(AT.out);
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE_SLOTS, 'SetDataFormat'),
        [dataFormat(g.memory, 16)]), DI_OK);
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE_SLOTS, 'Acquire')), DI_OK);
    // dinput.h:45-52, spelled out rather than taken from the module under test.
    const header = [
        ['{5944E680-C92E-11CF-BFC7-444553540000}', IDIRECTINPUTDEVICE_SLOTS],
        ['{5944E681-C92E-11CF-BFC7-444553540000}', IDIRECTINPUTDEVICE_SLOTS],
        ['{5944E682-C92E-11CF-BFC7-444553540000}', IDIRECTINPUTDEVICE2_SLOTS],
        ['{5944E683-C92E-11CF-BFC7-444553540000}', IDIRECTINPUTDEVICE2_SLOTS],
        ['{57D7C6BC-2356-11D3-8E9D-00C04F6844AE}', IDIRECTINPUTDEVICE7_SLOTS],
        ['{57D7C6BD-2356-11D3-8E9D-00C04F6844AE}', IDIRECTINPUTDEVICE7_SLOTS],
        ['{54D41080-DC15-4833-A41B-748F73A38179}', IDIRECTINPUTDEVICE8_SLOTS],
        ['{54D41081-DC15-4833-A41B-748F73A38179}', IDIRECTINPUTDEVICE8_SLOTS],
    ];
    for (const [iid, slots] of /** @type {[string, [string, number][]][]} */ (header))
    {
        writeGuid(g.memory, AT.iid, iid);
        g.memory.setU32(AT.state, 0);
        assert.equal(g.call(device, 0, [AT.iid, AT.state]), 0, `QueryInterface ${iid}`);
        const asked = g.memory.u32(AT.state);
        assert.notEqual(asked, 0, iid);
        // The table behind the answer is the one that IID names, down to its
        // last slot, which the generation before it does not have.
        assert.equal(g.call(asked, 3 + slots.length - 1), DIERR_UNSUPPORTED, iid);
        if (slots !== IDIRECTINPUTDEVICE_SLOTS)
        {
            assert.equal(g.call(asked, slotOf(slots, 'Poll')), DI_OK, iid);
        }
    }
});

test('a device whose last reference goes is gone through every generation asked for', ()=>{
    // The pointer CreateDevice answered is released first, while the one a
    // QueryInterface answered still holds the device; once that goes too,
    // neither may reach the released device.
    const g = guestMachine();
    assert.equal(g.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0500, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.guid, GUID_SysMouse);
    assert.equal(g.call(root, slotOf(IDIRECTINPUT_SLOTS, 'CreateDevice'),
        [AT.guid, AT.out, 0]), DI_OK);
    const device = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.iid, '{5944E682-C92E-11CF-BFC7-444553540000}');
    assert.equal(g.call(device, 0, [AT.iid, AT.state]), 0);
    const second = g.memory.u32(AT.state);

    assert.equal(g.call(device, 2), 1);
    assert.equal(g.call(second, slotOf(IDIRECTINPUTDEVICE2_SLOTS, 'SetDataFormat'),
        [dataFormat(g.memory, 16)]), DI_OK, 'the device lives while the second is held');
    assert.equal(g.call(second, 2), 0);
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE_SLOTS, 'Acquire')), E_POINTER);
    assert.equal(g.call(second, slotOf(IDIRECTINPUTDEVICE2_SLOTS, 'Acquire')), E_POINTER);
});

test('the DirectInput object counts its references, one count for every interface', ()=>{
    // Wine's dinput.c test_QueryInterface: each interface asked for is one
    // more reference, released back to one, and the last Release answers
    // zero; after it the object is gone through every pointer it had.
    const g = guestMachine();
    assert.equal(g.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0700, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    const [ADDREF, RELEASE] = [1, 2];
    writeGuid(g.memory, AT.iid, '{00000000-0000-0000-C000-000000000046}');
    assert.equal(g.call(root, 0, [AT.iid, AT.state]), 0);
    const unknown = g.memory.u32(AT.state);
    assert.equal(g.call(unknown, RELEASE), 1);
    writeGuid(g.memory, AT.iid, '{5944E662-AA8A-11CF-BFC7-444553540000}');
    assert.equal(g.call(root, 0, [AT.iid, AT.state]), 0, 'IDirectInput2A');
    const second = g.memory.u32(AT.state);
    assert.equal(g.call(second, ADDREF), 3);
    assert.equal(g.call(second, RELEASE), 2);
    assert.equal(g.call(second, RELEASE), 1);

    assert.equal(g.call(root, RELEASE), 0);
    assert.equal(g.call(root, ADDREF), E_POINTER);
    assert.equal(g.call(second, ADDREF), E_POINTER);
    assert.equal(g.call(unknown, ADDREF), E_POINTER);
});

test('a device goes on working after the DirectInput object that made it is released', ()=>{
    // Wine's device8.c test_sys_keyboard_action_format: the object's last
    // Release answers zero while a device it made is still held, and the
    // device still answers.
    const g = guestMachine();
    writeGuid(g.memory, AT.iid, IID_IDirectInput8A);
    assert.equal(g.dinput.libraries['DINPUT8.dll']
        .DirectInput8Create.handler([INSTANCE, 0x0800, AT.iid, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.guid, GUID_SysKeyboard);
    assert.equal(g.call(root, slotOf(IDIRECTINPUT8_SLOTS, 'CreateDevice'),
        [AT.guid, AT.out, 0]), DI_OK);
    const device = g.memory.u32(AT.out);

    assert.equal(g.call(root, 2), 0, 'the device takes no reference the program sees');
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE8_SLOTS, 'SetDataFormat'),
        [dataFormat(g.memory, 256)]), DI_OK);
    assert.equal(g.call(device, slotOf(IDIRECTINPUTDEVICE8_SLOTS, 'Acquire')), DI_OK);
    assert.equal(g.call(device, 2), 0);
});

test('a pointer the bridge let go of names no device any more', ()=>{
    // Its words go back to the heap: a pointer handed to SetCooperativeLevel
    // or kept by a program past its Release must not find the released device.
    const g = guestMachine();
    assert.equal(g.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0500, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.guid, GUID_SysMouse);
    assert.equal(g.call(root, slotOf(IDIRECTINPUT_SLOTS, 'CreateDevice'),
        [AT.guid, AT.out, 0]), DI_OK);
    const device = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.iid, '{5944E682-C92E-11CF-BFC7-444553540000}');
    assert.equal(g.call(device, 0, [AT.iid, AT.state]), 0);
    const second = g.memory.u32(AT.state);
    const { publisher } = g.dinput;

    const held = publisher.objectAt(device);
    assert.notEqual(held, null);
    assert.equal(g.call(device, 2), 1);
    assert.equal(publisher.objectAt(device), held, 'still held, through the second');
    assert.equal(g.call(second, 2), 0);
    assert.equal(publisher.objectAt(device), null);
    assert.equal(g.call(root, 2), 0);
    assert.equal(publisher.objectAt(root), null);
});

test('diagnostics report what a run actually did', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 8);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    const report = f.dinput.diagnostics();
    assert.equal(report.devices.length, 1);
    assert.deepEqual(report.devices[0],
        { guid: GUID_SysKeyboard, kind: 'keyboard', acquired: true, buffered: 8, queued: 1 });
});

test('DirectInput refuses a creation as Windows does: pointer, interface, module, version', ()=>{
    // Wine's dinput.c test_DirectInputCreate, test_DirectInputCreateEx and
    // test_DirectInput8Create.
    const f = fixture();
    const legacy = f.dinput.libraries['DINPUT.dll'];
    const eight = f.dinput.libraries['DINPUT8.dll'].DirectInput8Create;
    const IID_IUnknown = '{00000000-0000-0000-C000-000000000046}';
    /** @param {() => number} call @param {number} expected @param {number} [left] */
    const refused = (call, expected, left = 0)=>{
        f.memory.setU32(AT.out, 0xdeadbeef);
        assert.equal(call(), expected);
        assert.equal(f.memory.u32(AT.out), left >>> 0, 'what the pointer was left as');
    };
    const createA = (/** @type {number} */ instance, /** @type {number} */ version)=>
        legacy.DirectInputCreateA.handler([instance, version, AT.out, 0]);
    assert.equal(legacy.DirectInputCreateA.handler([0, 0, 0, 0]), E_POINTER);
    refused(()=>createA(0, 0x700), DIERR_INVALIDPARAM);
    refused(()=>createA(INSTANCE, 0), 0x80070015 | 0, 0);
    refused(()=>createA(INSTANCE, 0x6ff), 0x80070481 | 0);
    refused(()=>createA(INSTANCE, 0x701), 0x8007047e | 0);
    assert.equal(createA(0, 0x300), DI_OK, 'the first DirectInput needed no module');
    assert.equal(createA(INSTANCE, 0x61a), DI_OK);
    refused(()=>legacy.DirectInputCreateA.handler([INSTANCE, 0x700, AT.out, 0x5000]), DI_OK);

    writeGuid(f.memory, AT.iid, IID_IUnknown);
    refused(()=>legacy.DirectInputCreateEx.handler([INSTANCE, 0x700, AT.iid, AT.out, 0]),
        0x80004002 | 0, 0xdeadbeef);
    assert.equal(legacy.DirectInputCreateEx.handler([INSTANCE, 0x700, AT.iid, 0, 0]),
        0x80004002 | 0, 'the interface is looked at before the pointer');
    writeGuid(f.memory, AT.iid, IID_IDirectInput7A);
    refused(()=>legacy.DirectInputCreateEx.handler([INSTANCE, 0x800, AT.iid, AT.out, 0]),
        0x8007047e | 0);

    refused(()=>eight.handler([INSTANCE, 0x800, AT.iid, AT.out, 0]), 0x80004002 | 0);
    writeGuid(f.memory, AT.iid, IID_IDirectInput8A);
    refused(()=>eight.handler([INSTANCE, 0x7ff, AT.iid, AT.out, 0]), 0x80070481 | 0);
    refused(()=>eight.handler([INSTANCE, 0x801, AT.iid, AT.out, 0]), 0x8007047e | 0);
    refused(()=>eight.handler([0, 0x800, AT.iid, AT.out, 0]), DIERR_INVALIDPARAM);
    assert.equal(eight.handler([INSTANCE, 0x800, AT.iid, AT.out, 0]), DI_OK);
    assert.notEqual(f.memory.u32(AT.out), 0);
});

test('a DirectInput before 8 is one pointer per width, the wide one its IUnknown', ()=>{
    // Wine's dinput.c test_QueryInterface: IDirectInput2A and 7A are the
    // IDirectInputA pointer, the wide ones and IUnknown another; no
    // generation of the other family is there to be asked for.
    const g = guestMachine();
    assert.equal(g.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0700, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    /** @param {number} pointer @param {string} iid */
    const query = (pointer, iid)=>{
        writeGuid(g.memory, AT.iid, iid);
        g.memory.setU32(AT.state, 0xdeadbeef);
        const result = g.call(pointer, 0, [AT.iid, AT.state]);
        return { result, pointer: g.memory.u32(AT.state) };
    };
    for (const iid of [IID_IDirectInput2A, IID_IDirectInput7A])
    {
        assert.deepEqual(query(root, iid), { result: 0, pointer: root }, iid);
    }
    const unknown = query(root, '{00000000-0000-0000-C000-000000000046}').pointer;
    assert.notEqual(unknown, root);
    for (const iid of [IID_IDirectInputW, IID_IDirectInput2W, IID_IDirectInput7W])
    {
        assert.deepEqual(query(root, iid), { result: 0, pointer: unknown }, iid);
    }
    assert.deepEqual(query(root, IID_IDirectInput8A), { result: 0x80004002 | 0, pointer: 0 });
    // The shared table is the longest generation's, so the last slot is there.
    assert.equal(g.call(root, 3 + IDIRECTINPUT7_SLOTS.length - 1, [0, 0, 0, 0]),
        DIERR_INVALIDPARAM, 'CreateDeviceEx is reached through the IDirectInputA pointer');

    g.dinput.libraries['DINPUT8.dll'].DirectInput8Create.handler(
        [INSTANCE, 0x800, (writeGuid(g.memory, AT.iid, IID_IDirectInput8A), AT.iid), AT.out, 0]);
    assert.deepEqual(query(g.memory.u32(AT.out), IID_IDirectInput7A),
        { result: 0x80004002 | 0, pointer: 0 }, 'nor an earlier generation from an 8');
});

test('the root checks what it is handed before it looks for a device', ()=>{
    const f = fixture({ windows: { 0x100: 'top' } });
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        f.bridge.call(f.root, name, args);
    f.memory.setU32(AT.out, 0xdeadbeef);
    assert.equal(call('CreateDevice', [0, AT.out, 0]), E_POINTER);
    assert.equal(f.memory.u32(AT.out), 0);
    assert.equal(call('CreateDevice', [AT.guid, 0, 0]), E_POINTER);
    assert.equal(call('GetDeviceStatus', [0]), E_POINTER);
    writeGuid(f.memory, AT.guid, '{11111111-2222-3333-4444-555555555555}');
    assert.equal(call('GetDeviceStatus', [AT.guid]), 0x80040154 | 0, 'DIERR_DEVICENOTREG');
    writeGuid(f.memory, AT.guid, GUID_SysMouse);
    assert.equal(call('GetDeviceStatus', [AT.guid]), DI_OK);

    assert.equal(call('RunControlPanel', [0, 0]), DI_OK);
    assert.equal(call('RunControlPanel', [0, 0xffffffff]), DIERR_INVALIDPARAM);
    assert.equal(call('RunControlPanel', [0xdeadbeef, 0]), 0x80070006 | 0, 'E_HANDLE');
    assert.equal(call('RunControlPanel', [0x100, 0]), DI_OK);

    assert.equal(call('Initialize', [0, 0]), DIERR_INVALIDPARAM);
    assert.equal(call('Initialize', [INSTANCE, 0]), 0x80070015 | 0);
    assert.equal(call('Initialize', [INSTANCE, 0x6ff]), 0x80070481 | 0);
    assert.equal(call('Initialize', [INSTANCE, 0x701]), 0x8007047e | 0);
    assert.equal(call('Initialize', [INSTANCE, 0x500]), DI_OK);

    assert.equal(call('EnumDevices', [0xdeadbeef, 0x7000, 0, 0]), DIERR_INVALIDPARAM);
    assert.equal(call('EnumDevices', [0, 0x7000, 0, 0xffffffff]), DIERR_INVALIDPARAM);
});

test('a device released to nothing is made anew by the next CreateDevice', async()=>{
    // Wine's device8.c releases the device CreateDevice answered for one GUID
    // and creates it again for another naming the same device.
    const g = guestMachine();
    assert.equal(g.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([INSTANCE, 0x0700, AT.out, 0]), DI_OK);
    const root = g.memory.u32(AT.out);
    writeGuid(g.memory, AT.guid, GUID_SysMouse);
    const create = ()=>{
        assert.equal(g.call(root, slotOf(IDIRECTINPUT_SLOTS, 'CreateDevice'),
            [AT.guid, AT.out, 0]), DI_OK);
        return g.memory.u32(AT.out);
    };
    const first = create();
    assert.equal(g.call(first, 2), 0);
    const second = create();
    assert.equal(g.call(second, slotOf(IDIRECTINPUTDEVICE_SLOTS, 'SetDataFormat'),
        [dataFormat(g.memory, 16)]), DI_OK, 'the new device answers');
    const third = create();
    assert.equal(third, second, 'one still held is handed out again');
    assert.equal(g.call(third, 2), 1, 'with a reference of its own');
    assert.equal(g.call(second, 2), 0);
});

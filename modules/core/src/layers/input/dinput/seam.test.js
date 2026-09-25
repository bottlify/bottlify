/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVtables } from '../../bridge/internal/vtable.js';
import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { writeGuid, readGuid } from '../../win32/ole32/guid.js';
import {
    createDirectInput, createPublisher, describe,
    DI_OK, DI_BUFFEROVERFLOW, DIENUM_STOP,
    GUID_SysKeyboard, GUID_SysMouse,
    IID_IDirectInputA, IID_IDirectInputW, IID_IDirectInput7A,
    IID_IDirectInput8A, IID_IDirectInput8W, IID_IDirectInputDeviceA, IID_IDirectInputDeviceW,
    IID_IDirectInputDevice2A, IID_IDirectInputDevice8A, IID_IDirectInputDevice8W,
    IDIRECTINPUT_SLOTS, IDIRECTINPUT7_SLOTS, IDIRECTINPUT8_SLOTS,
    IDIRECTINPUTDEVICE_SLOTS, IDIRECTINPUTDEVICE2_SLOTS, IDIRECTINPUTDEVICE8_SLOTS,
    DIDEVICEOBJECTDATA, DIDEVICEINSTANCE, DIPROPDWORD_DATA, DIPROP_BUFFERSIZE, DIDEVCAPS,
} from './seam.js';
import { KEY_DOWN, DIMOUSE_OFS } from './devices.js';

const DIERR_INVALIDPARAM = 0x80070057 | 0;
const DIERR_NOTACQUIRED = 0x8007000c | 0;
const DIERR_UNSUPPORTED = 0x80004001 | 0;
const DIERR_DEVICENOTREG = 0x80040154 | 0;

const DIK_A = 0x1e;
const DIK_S = 0x1f;

/** Where the fixture puts things in its flat guest memory. */
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

function fixture(){
    const memory = guestMemory();
    const bridge = fakeBridge();
    const time = clock();
    /** @type {number[]} */
    const signalled = [];
    /** Every call the seam made into guest code, in order. */
    /** @type {{ entry: number, args: number[], thread: unknown }[]} */
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
            calls.push({ entry, args, thread });
            return Promise.resolve(answers.shift() ?? 1);
        },
        callerThread: ()=>`thread-token-${++threadRequests}`,
    });
    const root = (()=>{
        const result = dinput.libraries['DINPUT.dll']
            .DirectInputCreateA.handler([0, 0x0700, AT.out, 0]);
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

/**
 * A DIDATAFORMAT whose only field that matters here is dwDataSize.
 *
 * @param {any} memory @param {number} dataSize
 */
function dataFormat(memory, dataSize){
    memory.setU32(AT.format + 0x00, 0x18); // dwSize
    memory.setU32(AT.format + 0x04, 0x10); // dwObjSize
    memory.setU32(AT.format + 0x08, 0x02); // DIDF_RELAXIS
    memory.setU32(AT.format + 0x0c, dataSize);
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

/** @param {any} f @param {number} device @param {number} size */
function setBufferSize(f, device, size){
    f.memory.setU32(AT.property + DIPROPDWORD_DATA, size);
    assert.equal(
        f.bridge.call(device, 'SetProperty', [DIPROP_BUFFERSIZE, AT.property]), DI_OK);
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
    const enumObjects = f.bridge.methodsOf(f.device).find(
        (/** @type {any} */ m)=>m.name === 'EnumObjects');
    assert.ok(enumObjects, 'a missing slot shifts GetProperty and everything after it');
    assert.equal(enumObjects.invoke, undefined);
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
    assert.equal(f.bridge.call(device, 'GetDeviceData',
        [DIDEVICEOBJECTDATA.SIZE, AT.data, AT.count, 0]), DIERR_NOTACQUIRED);
});

test('SetDataFormat picks the layout from the size the caller states', ()=>{
    const f = fixture();
    const device = createDevice(f, GUID_SysMouse);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 16)]), DI_OK);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 20)]), DI_OK);
});

test('a format of an unfamiliar size is refused, not guessed at', ()=>{
    const f = fixture();
    const device = createDevice(f, GUID_SysMouse);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 40)]),
        DIERR_UNSUPPORTED,
        'writing at guessed offsets would smash the caller\'s structure');
    assert.equal(f.bridge.call(device, 'SetDataFormat', [0]), DIERR_INVALIDPARAM);
});

test('a keyboard format on a mouse is refused', ()=>{
    const f = fixture();
    const device = createDevice(f, GUID_SysMouse);
    assert.equal(f.bridge.call(device, 'SetDataFormat', [dataFormat(f.memory, 256)]),
        DIERR_INVALIDPARAM);
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

test('DIMOUSESTATE2 is the same with four more buttons', ()=>{
    const f = mouse(fixture(), 20);
    f.dinput.post({ kind: 'mouseButton', code: 6, down: true });
    assert.equal(f.bridge.call(f.device, 'GetDeviceState', [20, AT.state]), DI_OK);
    assert.equal(f.memory.bytes[AT.state + DIMOUSE_OFS.BUTTON0 + 6], KEY_DOWN);
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
    // Axis mode and dead zones: the device is already relative and unscaled.
    assert.equal(f.bridge.call(f.device, 'SetProperty', [2, AT.property]), DI_OK);
    assert.equal(f.bridge.call(f.device, 'GetProperty', [2, AT.property]),
        DIERR_UNSUPPORTED);
    assert.equal(f.bridge.call(f.device, 'SetProperty', [DIPROP_BUFFERSIZE, 0]),
        DIERR_INVALIDPARAM);
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
    setBufferSize(f, f.device, 2);
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

test('GetCapabilities fills DIDEVCAPS and needs a header that declares its size', ()=>{
    const f = keyboard();
    assert.equal(f.bridge.call(f.device, 'GetCapabilities', [AT.caps]),
        DIERR_INVALIDPARAM);
    f.memory.setU32(AT.caps + DIDEVCAPS.dwSize, DIDEVCAPS.SIZE);
    assert.equal(f.bridge.call(f.device, 'GetCapabilities', [AT.caps]), DI_OK);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwAxes), 0);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwButtons), 256);
});

test('a mouse reports three axes', ()=>{
    const f = mouse();
    f.memory.setU32(AT.caps + DIDEVCAPS.dwSize, DIDEVCAPS.SIZE);
    f.bridge.call(f.device, 'GetCapabilities', [AT.caps]);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwAxes), 3);
    assert.equal(f.memory.u32(AT.caps + DIDEVCAPS.dwButtons), 8);
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
        .DirectInput8Create.handler([0, 0x0800, AT.iid, AT.out, 0]), DI_OK);
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
    assert.equal(f.memory.u32(mouseInstance + DIDEVICEINSTANCE.dwDevType), 0x0212);
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
    assert.equal(f.memory.u32(mouseInstance + DIDEVICEINSTANCE.dwDevType), 0x0202);
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
    assert.equal(f.memory.u32(f.calls[0].args[0] + DIDEVICEINSTANCE.dwDevType), 0x0202);
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
        .DirectInput8Create.handler([0, 0x0800, AT.iid, AT.out, 0]), DI_OK);
    const pointer = f.memory.u32(AT.out);
    assert.equal(f.bridge.recordAt(pointer).id, IID_IDirectInput8A);
    assert.equal(f.bridge.methodsOf(pointer).length, 3 + IDIRECTINPUT8_SLOTS.length);
});

test('DirectInput8Create with an interface it has not answers E_NOINTERFACE', ()=>{
    const f = fixture();
    writeGuid(f.memory, AT.iid, '{11111111-2222-3333-4444-555555555555}');
    assert.equal(f.dinput.libraries['DINPUT8.dll']
        .DirectInput8Create.handler([0, 0x0800, AT.iid, AT.out, 0]), 0x80004002 | 0);
    assert.equal(f.memory.u32(AT.out), 0);
});

test('the entry points refuse to write through a null', ()=>{
    const f = fixture();
    assert.equal(f.dinput.libraries['DINPUT.dll']
        .DirectInputCreateA.handler([0, 0x0700, 0, 0]), DIERR_INVALIDPARAM);
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
        .DirectInputCreateA.handler([0, 0x0700, AT.out, 0]), DI_OK);
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
        .DirectInput8Create.handler([0, 0x0800, AT.iid, AT.out, 0]), DI_OK);
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
    assert.equal(g.call(device, 25), DI_OK);
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

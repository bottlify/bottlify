/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { writeGuid } from '../../win32/ole32/guid.js';
import {
    createDirectInput, createPublisher, describe,
    DI_OK, DI_BUFFEROVERFLOW,
    GUID_SysKeyboard, GUID_SysMouse,
    IID_IDirectInputA, IID_IDirectInput7A, IID_IDirectInput8A, IID_IDirectInputDeviceA,
    IID_IDirectInputDevice2A, IID_IDirectInputDevice8A,
    IDIRECTINPUT_SLOTS, IDIRECTINPUT7_SLOTS, IDIRECTINPUT8_SLOTS,
    IDIRECTINPUTDEVICE_SLOTS, IDIRECTINPUTDEVICE2_SLOTS, IDIRECTINPUTDEVICE8_SLOTS,
    DIDEVICEOBJECTDATA, DIPROPDWORD_DATA, DIPROP_BUFFERSIZE, DIDEVCAPS,
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
        /** @param {number} pointer @param {string} name @param {number[]} args */
        call(pointer, name, args = []){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            const method = entry.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method, `${entry.id} has no ${name}`);
            assert.ok(method.invoke, `${entry.id}::${name} is not implemented`);
            return method.invoke(entry.object, [pointer, ...args]) | 0;
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
    const dinput = createDirectInput({
        memory,
        now: time.now,
        publishInterface: (object, id)=>bridge.publishInterface(object, id),
        signal: event=>signalled.push(event),
    });
    const root = (()=>{
        const result = dinput.libraries['DINPUT.dll']
            .DirectInputCreateA.handler([0, 0x0700, AT.out, 0]);
        assert.equal(result, DI_OK);
        return memory.u32(AT.out);
    })();
    return { memory, bridge, time, dinput, signalled, root };
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

test('diagnostics report what a run actually did', ()=>{
    const f = keyboard();
    setBufferSize(f, f.device, 8);
    f.dinput.post({ kind: 'key', code: DIK_A, down: true });
    const report = f.dinput.diagnostics();
    assert.equal(report.devices.length, 1);
    assert.deepEqual(report.devices[0],
        { guid: GUID_SysKeyboard, kind: 'keyboard', acquired: true, buffered: 8, queued: 1 });
});

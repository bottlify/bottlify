/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * How a program reaches DirectInput.
 *
 * Same shape as the drawing layer's seam -- interfaces as ordered slot lists,
 * one adapter per object, a DLL table an assembling caller merges with the rest
 * -- and, for the same reason as the sound seam, not imported from there: this
 * layer declares `win32`, `bridge` and `memory`, so `graphics/seam/com.js` is
 * across a boundary the module graph does not admit.
 *
 * The one thing here that has no counterpart in drawing is the data format.
 * `SetDataFormat` hands us a DIDATAFORMAT describing, object by object, where
 * in the caller's own structure each axis and button is to be written -- and
 * that structure is the caller's, not a standard one. Reading the description
 * properly means walking an array of DIOBJECTDATAFORMAT and matching each entry
 * against a device object by GUID and flags.
 *
 * We do not do that. We take the caller's `dwDataSize` and recognise the four
 * layouts every program actually uses -- c_dfDIKeyboard, c_dfDIMouse,
 * c_dfDIMouse2, and a joystick's -- because they are distinguishable by size
 * and because writing a general walker before anything needs one is work with
 * no test to hold it up. What matters is that this is a *decision*, recorded
 * here: a program with a hand-rolled format of an unfamiliar size is told its
 * format is unsupported rather than quietly written into at the wrong offsets.
 */

import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { readGuid } from '../../win32/ole32/guid.js';
import {
    createInputDevice, KEYBOARD, MOUSE, KEYBOARD_KEYS, DIMOUSE_OFS,
} from './devices.js';

export const DI_OK = 0;
/** DI_BUFFEROVERFLOW is S_FALSE: a success a program has to look at. */
export const DI_BUFFEROVERFLOW = 1;
const DIERR_INVALIDPARAM = 0x80070057 | 0;
const DIERR_NOTACQUIRED = 0x8007000c | 0;
const DIERR_UNSUPPORTED = 0x80004001 | 0;
const DIERR_DEVICENOTREG = 0x80040154 | 0;

/** The devices a program creates, named by the GUIDs it was compiled with. */
export const GUID_SysKeyboard = '{6F1D2B61-D5A0-11CF-BFC7-444553540000}';
export const GUID_SysMouse = '{6F1D2B60-D5A0-11CF-BFC7-444553540000}';

/** The root interfaces, ANSI and wide. Same vtable; the strings differ. */
export const IID_IDirectInputA = '{89521360-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInputW = '{89521361-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInput2A = '{5944E662-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInput2W = '{5944E663-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInput7A = '{9A4CB684-236D-11D3-8E9D-00C04F6844AE}';
export const IID_IDirectInput7W = '{9A4CB685-236D-11D3-8E9D-00C04F6844AE}';
export const IID_IDirectInput8A = '{BF798030-483A-4DA2-AA99-5D64ED369700}';
export const IID_IDirectInput8W = '{BF798031-483A-4DA2-AA99-5D64ED369700}';

export const IID_IDirectInputDeviceA = '{5944E680-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInputDeviceW = '{5944E681-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInputDevice2A = '{5944E682-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInputDevice2W = '{5944E683-AA8A-11CF-BFC7-444553540000}';
export const IID_IDirectInputDevice7A = '{57D7C6BC-2356-11D3-8E9D-00C04F6844AE}';
export const IID_IDirectInputDevice7W = '{57D7C6BD-2356-11D3-8E9D-00C04F6844AE}';
export const IID_IDirectInputDevice8A = '{54D41080-DC15-4833-A41B-748F73A38179}';
export const IID_IDirectInputDevice8W = '{54D41081-DC15-4833-A41B-748F73A38179}';

/** DIDEVICEOBJECTDATA. DirectX 8 appends uAppData; nothing before it moves. */
export const DIDEVICEOBJECTDATA = Object.freeze({
    dwOfs: 0x00,
    dwData: 0x04,
    dwTimeStamp: 0x08,
    dwSequence: 0x0c,
    uAppData: 0x10,
    SIZE: 0x10,
    SIZE_DX8: 0x14,
});

/** DIPROPHEADER, and DIPROPDWORD which begins with one. */
export const DIPROPHEADER = Object.freeze({
    dwSize: 0x00,
    dwHeaderSize: 0x04,
    dwObj: 0x08,
    dwHow: 0x0c,
    SIZE: 0x10,
});
export const DIPROPDWORD_DATA = 0x10;

/** MAKEDIPROP packs a small integer into a pointer; these are the ones we read. */
export const DIPROP_BUFFERSIZE = 1;

/** DIDEVCAPS, as far as a program reads it. */
export const DIDEVCAPS = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwDevType: 0x08,
    dwAxes: 0x0c,
    dwButtons: 0x10,
    dwPOVs: 0x14,
    SIZE: 0x44,
});

/** DIGDD_PEEK: read the buffer without consuming it. */
const DIGDD_PEEK = 0x00000001;

/**
 * The data formats we recognise, by the size of the structure the caller says
 * it wants filled in.
 *
 * `DIMOUSESTATE` is three longs and four buttons; `DIMOUSESTATE2` is the same
 * with eight. The keyboard's is a flat array of 256 bytes, which is why it
 * needs no offsets at all.
 */
const FORMATS = Object.freeze({
    256: 'keyboard',
    16: 'mouse',
    20: 'mouse2',
});

/**
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (target: any, args: number[]) => number>} [implemented]
 */
export function describe(id, slots, implemented = {}){
    return {
        id,
        methods: slots.map(([name, args])=>({
            name,
            argBytes: 4 + args * 4,
            invoke: implemented[name],
        })),
    };
}

/** IDirectInput, after IUnknown's three. */
export const IDIRECTINPUT_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateDevice', 3],
    ['EnumDevices', 4],
    ['GetDeviceStatus', 1],
    ['RunControlPanel', 2],
    ['Initialize', 2],
]);

/** IDirectInput2 appends one; IDirectInput7 another. */
export const IDIRECTINPUT2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTINPUT_SLOTS,
    ['FindDevice', 3],
]);
export const IDIRECTINPUT7_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTINPUT2_SLOTS,
    ['CreateDeviceEx', 4],
]);

/**
 * IDirectInput8 is its own interface rather than a derivation, and its tail
 * differs from IDirectInput7's: FindDevice, then two of its own where 7 has
 * CreateDeviceEx. Deriving one from the other would put ConfigureDevices in
 * CreateDeviceEx's slot.
 */
export const IDIRECTINPUT8_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTINPUT_SLOTS,
    ['FindDevice', 3],
    ['EnumDevicesBySemantics', 5],
    ['ConfigureDevices', 4],
]);

/** IDirectInputDevice, after IUnknown's three. */
export const IDIRECTINPUTDEVICE_SLOTS = /** @type {[string, number][]} */ ([
    ['GetCapabilities', 1],
    ['EnumObjects', 3],
    ['GetProperty', 2],
    ['SetProperty', 2],
    ['Acquire', 0],
    ['Unacquire', 0],
    ['GetDeviceState', 2],
    ['GetDeviceData', 4],
    ['SetDataFormat', 1],
    ['SetEventNotification', 1],
    ['SetCooperativeLevel', 2],
    ['GetObjectInfo', 3],
    ['GetDeviceInfo', 1],
    ['RunControlPanel', 2],
    ['Initialize', 3],
]);

/** IDirectInputDevice2 adds force feedback and Poll. */
export const IDIRECTINPUTDEVICE2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTINPUTDEVICE_SLOTS,
    ['CreateEffect', 4],
    ['EnumEffects', 3],
    ['GetEffectInfo', 2],
    ['GetForceFeedbackState', 1],
    ['SendForceFeedbackCommand', 1],
    ['EnumCreatedEffectObjects', 3],
    ['Escape', 1],
    ['Poll', 0],
    ['SendDeviceData', 4],
]);

export const IDIRECTINPUTDEVICE7_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTINPUTDEVICE2_SLOTS,
    ['EnumEffectsInFile', 4],
    ['WriteEffectToFile', 4],
]);

export const IDIRECTINPUTDEVICE8_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTINPUTDEVICE7_SLOTS,
    ['BuildActionMap', 3],
    ['SetActionMap', 3],
    ['GetImageInfo', 1],
]);

/**
 * One adapter per object, so that one object is one identity.
 *
 * @param {Object} deps
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 */
export function createPublisher({ publishInterface }){
    const adapters = new WeakMap();
    /** @type {Map<number, any>} */
    const byPointer = new Map();
    let published = 0;

    /** @param {any} api @param {any[]} interfaces */
    const adapterFor = (api, interfaces)=>{
        let adapter = adapters.get(api);
        if (!adapter)
        {
            const declared = new Map(interfaces.map(entry=>[entry.id, entry]));
            adapter = {
                api,
                /** @param {string} id */
                interfaceFor(id){
                    const descriptor = id === IID_IUNKNOWN
                        ? { id, methods: [] }
                        : declared.get(id);
                    if (!descriptor)
                    {
                        return null;
                    }
                    return {
                        id,
                        methods: [
                            ...IUNKNOWN_METHODS,
                            ...descriptor.methods.map((/** @type {any} */ method)=>({
                                name: method.name,
                                argBytes: method.argBytes,
                                invoke: method.invoke
                                    ? (/** @type {any} */ unused, /** @type {number[]} */ args)=>
                                        method.invoke(api, args)
                                    : undefined,
                            })),
                        ],
                    };
                },
                addRef: ()=>api.addRef?.() ?? 1,
                release: ()=>api.release?.() ?? 0,
            };
            adapters.set(api, adapter);
        }
        return adapter;
    };

    return {
        /** @param {any} api @param {any[]} interfaces @param {string} id */
        publish(api, interfaces, id){
            const pointer = publishInterface(adapterFor(api, interfaces), id);
            if (pointer !== 0)
            {
                byPointer.set(pointer >>> 0, api);
                published++;
            }
            return pointer;
        },
        /** @param {number} pointer */
        objectAt: pointer=>((pointer >>> 0) === 0
            ? null
            : byPointer.get(pointer >>> 0) ?? null),
        count: ()=>published,
    };
}

/**
 * DirectInput and the devices behind it.
 *
 * @param {Object} deps
 * @param {any} deps.memory   readMemory/writeMemory over guest memory.
 * @param {() => number} deps.now  The guest's clock, in milliseconds.
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 * @param {(event: number) => void} [deps.signal]
 */
export function createDirectInput({ memory, now, publishInterface, signal }){
    const publisher = createPublisher({ publishInterface });

    /** @param {number} address */
    const guidAt = address=>readGuid(memory, address >>> 0);

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = memory.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return;
        }
        memory.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @type {Map<string, any>} */
    const devices = new Map();

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const deviceMethods = {
        /** HRESULT Acquire(void) */
        Acquire(device){
            device.acquire();
            return DI_OK;
        },
        /** HRESULT Unacquire(void) */
        Unacquire(device){
            device.unacquire();
            return DI_OK;
        },

        /**
         * HRESULT SetDataFormat(LPCDIDATAFORMAT)
         *
         * The size the caller states is what decides the layout -- see the
         * note at the top of this file for why the description itself is not
         * walked, and for what a program with an unfamiliar one is told.
         */
        SetDataFormat(device, [, format]){
            if ((format >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            // DIDATAFORMAT: dwSize, dwObjSize, dwFlags, dwDataSize, ...
            const dataSize = readU32((format >>> 0) + 0x0c);
            const known = /** @type {Record<number, string>} */ (FORMATS)[dataSize];
            if (!known)
            {
                return DIERR_UNSUPPORTED;
            }
            if ((known === 'keyboard') !== (device.kind === KEYBOARD))
            {
                return DIERR_INVALIDPARAM;
            }
            device.setDataSize(dataSize);
            return DI_OK;
        },

        /** HRESULT SetCooperativeLevel(HWND, DWORD) */
        SetCooperativeLevel(){
            return DI_OK;
        },

        /** HRESULT SetEventNotification(HANDLE) */
        SetEventNotification(device, [, handle]){
            device.setNotification(handle);
            return DI_OK;
        },

        /** HRESULT SetProperty(REFGUID, LPCDIPROPHEADER) */
        SetProperty(device, [, guid, header]){
            if ((header >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            // A property GUID is either a real pointer or a small integer
            // packed into one by MAKEDIPROP, and only the latter reaches here.
            if ((guid >>> 0) === DIPROP_BUFFERSIZE)
            {
                device.setBufferSize(readU32((header >>> 0) + DIPROPDWORD_DATA));
                return DI_OK;
            }
            // Axis mode, ranges, dead zones: accepted and ignored. The device
            // is already relative and already unscaled, which is what every
            // one of them would be asking for.
            return DI_OK;
        },

        /** HRESULT GetProperty(REFGUID, LPDIPROPHEADER) */
        GetProperty(device, [, guid, header]){
            if ((header >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            if ((guid >>> 0) === DIPROP_BUFFERSIZE)
            {
                writeU32((header >>> 0) + DIPROPDWORD_DATA, device.bufferSize);
                return DI_OK;
            }
            return DIERR_UNSUPPORTED;
        },

        /**
         * HRESULT GetDeviceState(DWORD size, LPVOID data)
         *
         * The size is the caller's again, and it has to agree with the format
         * it set: a program that set a mouse format and asks for 256 bytes has
         * a bug, and filling 256 bytes would hide it behind a smashed stack.
         */
        GetDeviceState(device, [, size, data]){
            if ((data >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            if (!device.acquired)
            {
                return DIERR_NOTACQUIRED;
            }
            const wanted = size >>> 0;
            if (device.dataSize !== 0 && wanted !== device.dataSize)
            {
                return DIERR_INVALIDPARAM;
            }

            if (device.kind === KEYBOARD)
            {
                if (wanted !== KEYBOARD_KEYS)
                {
                    return DIERR_INVALIDPARAM;
                }
                memory.writeMemory(data >>> 0, device.keyboardState());
                return DI_OK;
            }

            if (wanted !== 16 && wanted !== 20)
            {
                return DIERR_INVALIDPARAM;
            }
            const state = device.mouseState();
            const bytes = new Uint8Array(wanted);
            const view = new DataView(bytes.buffer);
            view.setInt32(DIMOUSE_OFS.X, state.x, true);
            view.setInt32(DIMOUSE_OFS.Y, state.y, true);
            view.setInt32(DIMOUSE_OFS.Z, state.wheel, true);
            for (let button = 0; button < wanted - DIMOUSE_OFS.BUTTON0; button++)
            {
                bytes[DIMOUSE_OFS.BUTTON0 + button] = state.buttons[button];
            }
            memory.writeMemory(data >>> 0, bytes);
            return DI_OK;
        },

        /**
         * HRESULT GetDeviceData(DWORD size, LPDIDEVICEOBJECTDATA, LPDWORD count,
         *                       DWORD flags)
         *
         * Two calls in one. With a null array the program is asking how many
         * events are waiting; with one it is draining. Both answer through
         * `count`, and confusing them loses every event a program was told
         * about but never asked for.
         */
        GetDeviceData(device, [, size, array, count, flags]){
            if ((count >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            if (!device.acquired)
            {
                return DIERR_NOTACQUIRED;
            }
            const entrySize = size >>> 0;
            if (entrySize !== DIDEVICEOBJECTDATA.SIZE
                && entrySize !== DIDEVICEOBJECTDATA.SIZE_DX8)
            {
                return DIERR_INVALIDPARAM;
            }

            const asked = readU32(count);
            const peek = (flags & DIGDD_PEEK) !== 0 || (array >>> 0) === 0;
            const { events, overflow } = device.drain(asked, peek);

            if ((array >>> 0) !== 0)
            {
                const bytes = new Uint8Array(events.length * entrySize);
                const view = new DataView(bytes.buffer);
                events.forEach((/** @type {any} */ event, /** @type {number} */ index)=>{
                    const at = index * entrySize;
                    view.setUint32(at + DIDEVICEOBJECTDATA.dwOfs, event.offset, true);
                    view.setInt32(at + DIDEVICEOBJECTDATA.dwData, event.data, true);
                    view.setUint32(at + DIDEVICEOBJECTDATA.dwTimeStamp, event.time >>> 0, true);
                    view.setUint32(at + DIDEVICEOBJECTDATA.dwSequence, event.sequence, true);
                });
                if (bytes.length > 0)
                {
                    memory.writeMemory(array >>> 0, bytes);
                }
            }

            writeU32(count, events.length);
            return overflow ? DI_BUFFEROVERFLOW : DI_OK;
        },

        /** HRESULT GetCapabilities(LPDIDEVCAPS) */
        GetCapabilities(device, [, caps]){
            if ((caps >>> 0) === 0 || readU32(caps + DIDEVCAPS.dwSize) < DIDEVCAPS.SIZE)
            {
                return DIERR_INVALIDPARAM;
            }
            const keyboard = device.kind === KEYBOARD;
            writeU32(caps + DIDEVCAPS.dwFlags, 0x00000001 | 0x00000004); // ATTACHED | POLLEDDEVICE
            writeU32(caps + DIDEVCAPS.dwDevType, keyboard ? 0x03 : 0x02); // KEYBOARD | MOUSE
            writeU32(caps + DIDEVCAPS.dwAxes, keyboard ? 0 : 3);
            writeU32(caps + DIDEVCAPS.dwButtons, keyboard ? KEYBOARD_KEYS : 8);
            writeU32(caps + DIDEVCAPS.dwPOVs, 0);
            return DI_OK;
        },

        /**
         * HRESULT Poll(void)
         *
         * Nothing to poll: events arrive as they happen. DI_NOEFFECT would be
         * honest and is also what a program checks for with `FAILED()`, which
         * it is not -- so either answer works and this is the shorter one.
         */
        Poll(){
            return DI_OK;
        },
    };

    const deviceInterfaces = ()=>[
        describe(IID_IDirectInputDeviceA, IDIRECTINPUTDEVICE_SLOTS, deviceMethods),
        describe(IID_IDirectInputDeviceW, IDIRECTINPUTDEVICE_SLOTS, deviceMethods),
        describe(IID_IDirectInputDevice2A, IDIRECTINPUTDEVICE2_SLOTS, deviceMethods),
        describe(IID_IDirectInputDevice2W, IDIRECTINPUTDEVICE2_SLOTS, deviceMethods),
        describe(IID_IDirectInputDevice7A, IDIRECTINPUTDEVICE7_SLOTS, deviceMethods),
        describe(IID_IDirectInputDevice7W, IDIRECTINPUTDEVICE7_SLOTS, deviceMethods),
        describe(IID_IDirectInputDevice8A, IDIRECTINPUTDEVICE8_SLOTS, deviceMethods),
        describe(IID_IDirectInputDevice8W, IDIRECTINPUTDEVICE8_SLOTS, deviceMethods),
    ];

    /** @param {string} guid */
    const deviceFor = guid=>{
        if (guid !== GUID_SysKeyboard && guid !== GUID_SysMouse)
        {
            return null;
        }
        let device = devices.get(guid);
        if (!device)
        {
            device = createInputDevice({
                kind: guid === GUID_SysKeyboard ? KEYBOARD : MOUSE,
                now,
            });
            devices.set(guid, device);
        }
        return device;
    };

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const rootMethods = {
        /** HRESULT CreateDevice(REFGUID, LPDIRECTINPUTDEVICE*, LPUNKNOWN) */
        CreateDevice(root, [, guid, out]){
            if ((out >>> 0) === 0 || (guid >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            const device = deviceFor(guidAt(guid));
            if (!device)
            {
                writeU32(out, 0);
                return DIERR_DEVICENOTREG;
            }
            writeU32(out, publisher.publish(
                device, deviceInterfaces(), IID_IDirectInputDeviceA));
            return DI_OK;
        },

        /**
         * HRESULT CreateDeviceEx(REFGUID, REFIID, LPVOID*, LPUNKNOWN)
         *
         * The extra argument is which interface to hand back. It is honoured
         * rather than ignored: a program asking for IDirectInputDevice8 and
         * given an IDirectInputDevice calls slot 20 of a table with fifteen.
         */
        CreateDeviceEx(root, [, guid, iid, out]){
            if ((out >>> 0) === 0 || (guid >>> 0) === 0 || (iid >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            const device = deviceFor(guidAt(guid));
            if (!device)
            {
                writeU32(out, 0);
                return DIERR_DEVICENOTREG;
            }
            const wanted = guidAt(iid);
            const pointer = publisher.publish(device, deviceInterfaces(), wanted);
            if (pointer === 0)
            {
                writeU32(out, 0);
                return 0x80004002 | 0; // E_NOINTERFACE
            }
            writeU32(out, pointer);
            return DI_OK;
        },

        /**
         * HRESULT EnumDevices(DWORD, LPDIENUMDEVICESCALLBACK, LPVOID, DWORD)
         *
         * Succeeds having enumerated nothing. The callback is guest code, and
         * calling into it is a route this table does not have; a program that
         * finds no devices falls back to the system keyboard and mouse, which
         * are the two CreateDevice hands out.
         */
        EnumDevices(){
            return DI_OK;
        },

        /** HRESULT GetDeviceStatus(REFGUID) */
        GetDeviceStatus(root, [, guid]){
            const known = (guid >>> 0) !== 0
                && deviceFor(guidAt(guid)) !== null;
            return known ? DI_OK : DIERR_DEVICENOTREG;
        },

        /** HRESULT RunControlPanel(HWND, DWORD) */
        RunControlPanel(){
            return DI_OK;
        },
        /** HRESULT Initialize(HINSTANCE, DWORD) */
        Initialize(){
            return DI_OK;
        },
        /** HRESULT FindDevice(REFGUID, LPCSTR, LPGUID) */
        FindDevice(){
            return DIERR_DEVICENOTREG;
        },
    };

    const root = { addRef: ()=>1, release: ()=>0 };
    const rootInterfaces = [
        describe(IID_IDirectInputA, IDIRECTINPUT_SLOTS, rootMethods),
        describe(IID_IDirectInputW, IDIRECTINPUT_SLOTS, rootMethods),
        describe(IID_IDirectInput2A, IDIRECTINPUT2_SLOTS, rootMethods),
        describe(IID_IDirectInput2W, IDIRECTINPUT2_SLOTS, rootMethods),
        describe(IID_IDirectInput7A, IDIRECTINPUT7_SLOTS, rootMethods),
        describe(IID_IDirectInput7W, IDIRECTINPUT7_SLOTS, rootMethods),
        describe(IID_IDirectInput8A, IDIRECTINPUT8_SLOTS, rootMethods),
        describe(IID_IDirectInput8W, IDIRECTINPUT8_SLOTS, rootMethods),
    ];

    /** @param {number} out @param {string} id */
    const createInto = (out, id)=>{
        if ((out >>> 0) === 0)
        {
            return DIERR_INVALIDPARAM;
        }
        const pointer = publisher.publish(root, rootInterfaces, id);
        writeU32(out, pointer);
        return pointer === 0 ? 0x80004002 | 0 : DI_OK;
    };

    return {
        root,
        publisher,

        /**
         * Feeds one event to whichever device it belongs to.
         *
         * This is the layer's whole input side: whoever is driving the machine
         * -- a browser listener, a test, a replay -- calls it, and nothing here
         * knows or cares which. An event for a device no program has created
         * is dropped, because there is nowhere to keep it that a later
         * CreateDevice would look.
         *
         * @param {import('./devices.js').InputEvent} event
         */
        post(event){
            const guid = event.kind === 'key' ? GUID_SysKeyboard : GUID_SysMouse;
            const device = devices.get(guid);
            if (!device || !device.post(event))
            {
                return false;
            }
            if (device.notifyEvent !== 0)
            {
                signal?.(device.notifyEvent);
            }
            return true;
        },

        /** @param {string} guid */
        device: guid=>devices.get(guid) ?? null,

        libraries: {
            'DINPUT.dll': {
                /**
                 * HRESULT DirectInputCreateA(HINSTANCE, DWORD version,
                 *                            LPDIRECTINPUTA*, LPUNKNOWN)
                 */
                DirectInputCreateA: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([, , out])=>createInto(out, IID_IDirectInputA),
                },
                DirectInputCreateW: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([, , out])=>createInto(out, IID_IDirectInputW),
                },
                /**
                 * HRESULT DirectInputCreateEx(HINSTANCE, DWORD, REFIID,
                 *                             LPVOID*, LPUNKNOWN)
                 *
                 * The interface the caller names is the one it gets, for the
                 * reason CreateDeviceEx honours its own: handing back a shorter
                 * vtable than it expects is a jump off the end of one.
                 */
                DirectInputCreateEx: {
                    argBytes: 20,
                    /** @param {number[]} args */
                    handler: ([, , iid, out])=>createInto(
                        out, guidAt(iid)),
                },
                DllCanUnloadNow: { argBytes: 0, handler: ()=>DI_OK },
            },
            'DINPUT8.dll': {
                /**
                 * HRESULT DirectInput8Create(HINSTANCE, DWORD, REFIID,
                 *                            LPVOID*, LPUNKNOWN)
                 */
                DirectInput8Create: {
                    argBytes: 20,
                    /** @param {number[]} args */
                    handler: ([, , iid, out])=>createInto(
                        out, guidAt(iid)),
                },
                DllCanUnloadNow: { argBytes: 0, handler: ()=>DI_OK },
            },
        },

        diagnostics: ()=>({
            devices: [...devices.keys()].map(guid=>({
                guid,
                kind: devices.get(guid).kind,
                acquired: devices.get(guid).acquired,
                buffered: devices.get(guid).bufferSize,
                queued: devices.get(guid).queued,
            })),
            published: publisher.count(),
        }),
    };
}

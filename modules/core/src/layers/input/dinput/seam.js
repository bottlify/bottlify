/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
import { readGuid, parseGuid } from '../../win32/ole32/guid.js';
import {
    createInputDevice, objectsOf, KEYBOARD, MOUSE, KEYBOARD_KEYS, DIMOUSE_OFS, MOUSE_BUTTONS,
} from './devices.js';

export const DI_OK = 0;
/** DI_BUFFEROVERFLOW is S_FALSE: a success a program has to look at. */
export const DI_BUFFEROVERFLOW = 1;
/** DI_NOEFFECT is S_FALSE too: the call succeeded and changed nothing. */
export const DI_NOEFFECT = 1;
const DIERR_INVALIDPARAM = 0x80070057 | 0;
const DIERR_NOTACQUIRED = 0x8007000c | 0;
const DIERR_ACQUIRED = 0x800700aa | 0;
const DIERR_UNSUPPORTED = 0x80004001 | 0;
const DIERR_DEVICENOTREG = 0x80040154 | 0;
const DIERR_NOTFOUND = 0x80070002 | 0;
const DIERR_NOTBUFFERED = 0x80040207 | 0;
const E_POINTER = 0x80004003 | 0;
const E_HANDLE = 0x80070006 | 0;

/** What a program's enumeration callback answers: another, or no more. */
export const DIENUM_CONTINUE = 1;
export const DIENUM_STOP = 0;

/**
 * The class a program asks EnumDevices for, and the device type each answers
 * with. The class values are 0..4 and the types are the same numbers with the
 * device family in the high byte, which is why the two are compared through
 * the low byte.
 */
const DI8DEVCLASS_ALL = 0;
const DI8DEVCLASS_POINTER = 2;
const DI8DEVCLASS_KEYBOARD = 3;
const DI8DEVCLASS_GAMECTRL = 4;
const DI8DEVTYPE_MOUSE = 0x12;
const DI8DEVTYPE_KEYBOARD = 0x13;
const DIDEVTYPE_MOUSE = 2;
const DIDEVTYPE_KEYBOARD = 3;
/** The same value in both generations' subtype tables, as PCENH is. */
const DEVTYPEMOUSE_UNKNOWN = 1;
const DI8DEVTYPEKEYBOARD_PCENH = 4;
/**
 * The buttons Windows counts on the system keyboard, as against the 256 bytes
 * of its state -- the number device8.c's test_sys_keyboard expects.
 */
const KEYBOARD_BUTTONS = 128;
const DIDC_ATTACHED = 0x00000001;
const DIDC_EMULATED = 0x00000004;
const DIEDFL_FORCEFEEDBACK = 0x00000100;
const DISCL_EXCLUSIVE = 0x00000001;
const DISCL_NONEXCLUSIVE = 0x00000002;
const DISCL_FOREGROUND = 0x00000004;
const DISCL_BACKGROUND = 0x00000008;

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

export const IID_IDirectInputDeviceA = '{5944E680-C92E-11CF-BFC7-444553540000}';
export const IID_IDirectInputDeviceW = '{5944E681-C92E-11CF-BFC7-444553540000}';
export const IID_IDirectInputDevice2A = '{5944E682-C92E-11CF-BFC7-444553540000}';
export const IID_IDirectInputDevice2W = '{5944E683-C92E-11CF-BFC7-444553540000}';
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
const DIPROP_AXISMODE = 2;

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

/**
 * DIDEVICEINSTANCE, the structure an enumeration callback is handed.
 *
 * The two names are inline fixed arrays rather than pointers, so the wide
 * form puts every field after them at a different offset and is nearly twice
 * the size: 580 bytes for the single-byte names and 1100 for the wide ones.
 * Only the fields a callback reads are named; the tail -- guidFFDriver and
 * the usage number -- stays zero, which is the honest answer here.
 */
export const DIDEVICEINSTANCE = Object.freeze({
    dwSize: 0x00,
    guidInstance: 0x04,
    guidProduct: 0x14,
    dwDevType: 0x24,
    tszInstanceName: 0x28,
    NAME_CHARS: 260,
    SIZE_A: 580,
    SIZE_W: 1100,
    // DIDEVICEINSTANCE_DX3: the same, ending where guidFFDriver begins.
    SIZE_DX3_A: 560,
    SIZE_DX3_W: 1080,
});

/**
 * DIDEVICEOBJECTINSTANCE, what EnumObjects and GetObjectInfo describe one
 * object in. The name is inline again; after it DirectX 5 appended
 * force-feedback and HID fields, which a keyboard and a mouse leave zero.
 */
export const DIDEVICEOBJECTINSTANCE = Object.freeze({
    dwSize: 0x00,
    guidType: 0x04,
    dwOfs: 0x14,
    dwType: 0x18,
    dwFlags: 0x1c,
    tszName: 0x20,
    NAME_CHARS: 260,
    SIZE_A: 316,
    SIZE_W: 576,
    SIZE_DX3_A: 292,
    SIZE_DX3_W: 552,
});

/** DIGDD_PEEK: read the buffer without consuming it. */
const DIGDD_PEEK = 0x00000001;

/** How GetObjectInfo's caller names the object. */
const DIPH_BYOFFSET = 1;
const DIPH_BYID = 2;
const DIPH_BYUSAGE = 3;

/**
 * The attribute bits of an EnumObjects filter -- actuator, effect trigger,
 * vendor-defined, alias, output. Each asks for objects that have it, and
 * nothing on a system keyboard or mouse does.
 */
const DIDFT_ATTRIBUTES = 0x1f000000;

/**
 * What a device says it is, to EnumDevices, GetCapabilities and GetDeviceInfo
 * alike: its family in the low byte, in the codes of the generation the
 * interface belongs to, and its subtype above that. The system mouse's
 * subtype is unknown, not traditional -- the answer Windows gives in Wine's
 * device8.c and joystick8.c, where Wine's own differs.
 *
 * @param {'keyboard' | 'mouse'} kind @param {boolean} legacy
 */
function devTypeOf(kind, legacy){
    return kind === KEYBOARD
        ? (legacy ? DIDEVTYPE_KEYBOARD : DI8DEVTYPE_KEYBOARD) | DI8DEVTYPEKEYBOARD_PCENH << 8
        : (legacy ? DIDEVTYPE_MOUSE : DI8DEVTYPE_MOUSE) | DEVTYPEMOUSE_UNKNOWN << 8;
}

/**
 * A string as it sits in one of the inline name arrays, with its terminator.
 *
 * @param {string} text @param {boolean} wide
 */
function textBytes(text, wide){
    const units = wide ? 2 : 1;
    const bytes = new Uint8Array((text.length + 1) * units);
    for (let index = 0; index < text.length; index++)
    {
        const code = text.charCodeAt(index);
        bytes[index * units] = code & 0xff;
        if (wide)
        {
            bytes[index * units + 1] = code >>> 8 & 0xff;
        }
    }
    return bytes;
}

/**
 * A whole DIDEVICEINSTANCE in the width asked for. Both GUIDs are the
 * device's own, as Windows reports the system keyboard and mouse;
 * guidFFDriver and the usage stay zero because nothing here rumbles.
 *
 * @param {string} guid @param {number} devType
 * @param {string} instanceName @param {string} productName @param {boolean} wide
 */
function deviceInstanceBytes(guid, devType, instanceName, productName, wide){
    const I = DIDEVICEINSTANCE;
    const size = wide ? I.SIZE_W : I.SIZE_A;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    const id = parseGuid(guid) ?? new Uint8Array(16);
    view.setUint32(I.dwSize, size, true);
    bytes.set(id, I.guidInstance);
    bytes.set(id, I.guidProduct);
    view.setUint32(I.dwDevType, devType, true);
    bytes.set(textBytes(instanceName, wide), I.tszInstanceName);
    bytes.set(textBytes(productName, wide), I.tszInstanceName + I.NAME_CHARS * (wide ? 2 : 1));
    return bytes;
}

/**
 * A whole DIDEVICEOBJECTINSTANCE in the width asked for.
 *
 * @param {import('./devices.js').DeviceObject} object @param {boolean} wide
 */
function objectInstanceBytes(object, wide){
    const O = DIDEVICEOBJECTINSTANCE;
    const size = wide ? O.SIZE_W : O.SIZE_A;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(O.dwSize, size, true);
    bytes.set(parseGuid(object.guidType) ?? new Uint8Array(16), O.guidType);
    view.setUint32(O.dwOfs, object.offset, true);
    view.setUint32(O.dwType, object.type, true);
    view.setUint32(O.dwFlags, object.flags, true);
    bytes.set(textBytes(object.name, wide), O.tszName);
    return bytes;
}

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
 * @param {Record<string, (target: any, args: number[], descriptor: any) => any>} [implemented]
 * @param {{ wide?: boolean, legacy?: boolean }} [options]
 *     `wide` for a W interface, `legacy` for one of the pre-8 generations.
 *     Both are facts the method itself needs and the interface it arrived on
 *     is the only thing that carries them.
 */
export function describe(id, slots, implemented = {}, options = {}){
    return {
        id,
        wide: options.wide === true,
        legacy: options.legacy === true,
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
 * One method list per interface descriptor, shared by every object that
 * exposes it, as a compiled program shares one vtable among all instances of
 * a class. The publisher keys its table of stubs by the list's identity, so a
 * list built afresh for each object was a table of stubs per object -- and
 * the stubs come out of a table of sixteen thousand, which a program making a
 * thousand textures had used up. Each method is reached through the adapter
 * the call arrived on, which is what makes one list serve every object.
 *
 * @type {WeakMap<any, any[]>}
 */
const methodLists = new WeakMap();
/** IUnknown alone, one list for everyone: it names no method of the object's own. */
const IUNKNOWN_ONLY = Object.freeze([...IUNKNOWN_METHODS]);

/** @param {any} descriptor */
function methodsFor(descriptor){
    let methods = methodLists.get(descriptor);
    if (!methods)
    {
        methods = [
            ...IUNKNOWN_METHODS,
            ...descriptor.methods.map((/** @type {any} */ method)=>({
                name: method.name,
                argBytes: method.argBytes,
                invoke: method.invoke
                    ? (/** @type {any} */ adapter, /** @type {number[]} */ args)=>
                        method.invoke(adapter.api, args, descriptor) ?? 0
                    : undefined,
            })),
        ];
        methodLists.set(descriptor, methods);
    }
    return methods;
}


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
                    if (id === IID_IUNKNOWN)
                    {
                        return { id, methods: IUNKNOWN_ONLY };
                    }
                    const descriptor = declared.get(id);
                    if (!descriptor)
                    {
                        return null;
                    }
                    return { id, methods: methodsFor(descriptor) };
                },
                addRef: ()=>api.addRef?.() ?? 1,
                release: ()=>api.release?.() ?? 0,
                // A device keeps one count whichever generation it is reached
                // through, so its last reference ends them all; an object that
                // says nothing ends only the interface it was released through.
                get destroyed(){
                    return api.destroyed === true;
                },
                /** @param {number} pointer */
                forgotten: pointer=>{
                    if (byPointer.get(pointer) === api)
                    {
                        byPointer.delete(pointer);
                    }
                },
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
 * @param {(bytes: number) => number} [deps.allocate]  Guest memory for a
 *        structure an enumeration callback is handed.
 * @param {(entry: number, args: number[], thread?: any) => Promise<number>} [deps.callGuest]
 *        Runs a guest routine and answers with what it returned. An
 *        enumeration callback is guest code and Windows runs it before
 *        EnumDevices returns, so a seam without this route cannot describe
 *        any device truthfully.
 * @param {() => unknown} [deps.callerThread]
 *        Whose call `EnumDevices` is answering. A callback that names a
 *        second device is a call made after the first callback's own await,
 *        by when the thread the processor is on may no longer be this one --
 *        so the loop names it once, before that first await, rather than
 *        asking the bridge to guess a second time.
 * @param {(hwnd: number) => 'top' | 'child' | null | undefined} [deps.windowKind]
 *        What a handle names: a top-level window, a child one, nothing -- or
 *        undefined when there are no windows to ask about, in which case any
 *        handle is taken as a window. SetCooperativeLevel wants a top-level one.
 */
export function createDirectInput(
    { memory, now, publishInterface, signal, allocate, callGuest, callerThread, windowKind },
)
{
    const publisher = createPublisher({ publishInterface });
    // The arena a structure handed to a callback is written in. It answers
    // zero when no heap was handed down, and the enumeration that needs one
    // refuses before it ever asks.
    const arena = allocate ?? (()=>0);

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

    /**
     * Fills a structure the caller sized, in one of the two sizes its width
     * allows -- the DirectX 3 one or the whole one -- and never past it. The
     * caller's own dwSize stays as it wrote it.
     *
     * @param {number} address @param {Uint8Array} whole
     * @param {number[]} sizes  The two sizes the caller may have declared.
     * @returns {number} DI_OK, or why nothing was written.
     */
    const fillSized = (address, whole, sizes)=>{
        if ((address >>> 0) === 0)
        {
            return E_POINTER;
        }
        const size = readU32(address);
        if (!sizes.includes(size))
        {
            return DIERR_INVALIDPARAM;
        }
        memory.writeMemory((address >>> 0) + 4, whole.subarray(4, size));
        return DI_OK;
    };

    /**
     * The object GetObjectInfo's caller named, or the error that says why
     * there is none. By id, the instance has to be the object's and the type
     * bits have to include its type: a toggle button is not a push button.
     *
     * @param {any} device @param {number} which @param {number} how
     * @returns {import('./devices.js').DeviceObject | number}
     */
    const objectNamed = (device, which, how)=>{
        const objects = objectsOf(device.kind);
        let found;
        switch (how){
            case DIPH_BYOFFSET:
                found = objects.find(object=>object.offset === which);
                break;
            case DIPH_BYID:
                found = objects.find(object=>(object.type >>> 8 & 0xffff) === (which >>> 8 & 0xffff)
                    && (object.type & which & 0xff) !== 0);
                break;
            case DIPH_BYUSAGE:
                // A HID usage names an object of a HID device, and the system
                // keyboard and mouse are not reached as HID here.
                return DIERR_UNSUPPORTED;
            default:
                return DIERR_INVALIDPARAM;
        }
        return found ?? DIERR_NOTFOUND;
    };

    /** @type {Record<string, (target: any, args: number[], descriptor?: any) => any>} */
    const deviceMethods = {
        /**
         * HRESULT Acquire(void)
         *
         * A second Acquire, or an Unacquire of a device nobody holds, changes
         * nothing and answers DI_NOEFFECT -- S_FALSE, still a success.
         */
        Acquire(device){
            if (device.acquired)
            {
                return DI_NOEFFECT;
            }
            device.acquire();
            return DI_OK;
        },
        /** HRESULT Unacquire(void) */
        Unacquire(device){
            if (!device.acquired)
            {
                return DI_NOEFFECT;
            }
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
        SetDataFormat(device, [format]){
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

        /**
         * HRESULT SetCooperativeLevel(HWND, DWORD)
         *
         * Like the buffer size, a level is settled before the device is
         * taken: a held device refuses a new one with DIERR_ACQUIRED. The
         * one part of it anything here acts on is DISCL_EXCLUSIVE -- see
         * `exclusive` below for what holding a device that way takes away.
         *
         * The rest is checked as Windows checks it (Wine's device8.c, for
         * the system mouse and keyboard): exactly one of exclusive and
         * nonexclusive and one of foreground and background, a top-level
         * window unless the level is background and nonexclusive, and never
         * background and exclusive at once for these two devices. A keyboard
         * made by a version before 7 is not exclusive at all.
         */
        SetCooperativeLevel(device, [hwnd, flags]){
            if (device.acquired)
            {
                return DIERR_ACQUIRED;
            }
            const exclusive = (flags & DISCL_EXCLUSIVE) !== 0;
            const background = (flags & DISCL_BACKGROUND) !== 0;
            if (exclusive === ((flags & DISCL_NONEXCLUSIVE) !== 0)
                || background === ((flags & DISCL_FOREGROUND) !== 0))
            {
                return DIERR_INVALIDPARAM;
            }
            const window = hwnd >>> 0;
            const kind = window === 0 ? null : windowKind?.(window);
            if (window === 0 ? exclusive || !background : kind === null || kind === 'child')
            {
                return E_HANDLE;
            }
            if (exclusive && device.kind === KEYBOARD && device.version < 0x0700)
            {
                return DIERR_INVALIDPARAM;
            }
            if (exclusive && background)
            {
                return DIERR_UNSUPPORTED;
            }
            device.setExclusive(exclusive);
            return DI_OK;
        },

        /** HRESULT SetEventNotification(HANDLE) */
        SetEventNotification(device, [handle]){
            device.setNotification(handle);
            return DI_OK;
        },

        /** HRESULT SetProperty(REFGUID, LPCDIPROPHEADER) */
        SetProperty(device, [guid, header]){
            if ((header >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            // A property GUID is either a real pointer or a small integer
            // packed into one by MAKEDIPROP, and only the latter reaches here.
            // The queue's size and the axis mode are settled while nobody
            // reads the device; a held one keeps what it was acquired with.
            const property = guid >>> 0;
            if ((property === DIPROP_BUFFERSIZE || property === DIPROP_AXISMODE)
                && device.acquired)
            {
                return DIERR_ACQUIRED;
            }
            if (property === DIPROP_BUFFERSIZE)
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
        GetProperty(device, [guid, header]){
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
        GetDeviceState(device, [size, data]){
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
        GetDeviceData(device, [size, array, count, flags]){
            if ((count >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            // Before DirectInput 8 the buffer stays readable once the device
            // is let go of; from 8 it waits, kept, for the next Acquire
            // (Wine's device8.c, test_sys_mouse).
            if (!device.acquired && device.version >= 0x0800)
            {
                return DIERR_NOTACQUIRED;
            }
            const entrySize = size >>> 0;
            if (entrySize !== DIDEVICEOBJECTDATA.SIZE
                && entrySize !== DIDEVICEOBJECTDATA.SIZE_DX8)
            {
                return DIERR_INVALIDPARAM;
            }
            // A device that was never given a buffer has no events to hand
            // out, which is not the same as having none waiting.
            if (device.bufferSize === 0)
            {
                return DIERR_NOTBUFFERED;
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
        GetCapabilities(device, [caps], descriptor){
            if ((caps >>> 0) === 0 || readU32(caps + DIDEVCAPS.dwSize) < DIDEVCAPS.SIZE)
            {
                return DIERR_INVALIDPARAM;
            }
            const keyboard = device.kind === KEYBOARD;
            writeU32(caps + DIDEVCAPS.dwFlags, DIDC_ATTACHED | DIDC_EMULATED);
            writeU32(caps + DIDEVCAPS.dwDevType,
                devTypeOf(device.kind, descriptor?.legacy === true));
            writeU32(caps + DIDEVCAPS.dwAxes, keyboard ? 0 : 3);
            writeU32(caps + DIDEVCAPS.dwButtons, keyboard ? KEYBOARD_BUTTONS : MOUSE_BUTTONS);
            writeU32(caps + DIDEVCAPS.dwPOVs, 0);
            return DI_OK;
        },

        /**
         * HRESULT GetDeviceInfo(LPDIDEVICEINSTANCE)
         *
         * The same description EnumDevices hands a callback, in the width of
         * the interface and with the type GetCapabilities gives.
         *
         * @param {any} device @param {number[]} args
         * @param {{ wide?: boolean, legacy?: boolean }} [descriptor]
         */
        GetDeviceInfo(device, [info], descriptor){
            const wide = descriptor?.wide === true;
            const keyboard = device.kind === KEYBOARD;
            const name = keyboard ? 'Keyboard' : 'Mouse';
            const whole = deviceInstanceBytes(keyboard ? GUID_SysKeyboard : GUID_SysMouse,
                devTypeOf(device.kind, descriptor?.legacy === true), name, name, wide);
            return fillSized(info, whole, wide
                ? [DIDEVICEINSTANCE.SIZE_DX3_W, DIDEVICEINSTANCE.SIZE_W]
                : [DIDEVICEINSTANCE.SIZE_DX3_A, DIDEVICEINSTANCE.SIZE_A]);
        },

        /**
         * HRESULT GetObjectInfo(LPDIDEVICEOBJECTINSTANCE, DWORD obj, DWORD how)
         *
         * @param {any} device @param {number[]} args
         * @param {{ wide?: boolean }} [descriptor]
         */
        GetObjectInfo(device, [info, which, how], descriptor){
            const wide = descriptor?.wide === true;
            /** @type {number[]} */
            const sizes = wide
                ? [DIDEVICEOBJECTINSTANCE.SIZE_DX3_W, DIDEVICEOBJECTINSTANCE.SIZE_W]
                : [DIDEVICEOBJECTINSTANCE.SIZE_DX3_A, DIDEVICEOBJECTINSTANCE.SIZE_A];
            if ((info >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (!sizes.includes(readU32(info)))
            {
                return DIERR_INVALIDPARAM;
            }
            const found = objectNamed(device, which >>> 0, how >>> 0);
            return typeof found === 'number'
                ? found
                : fillSized(info, objectInstanceBytes(found, wide), sizes);
        },

        /**
         * HRESULT EnumObjects(LPDIENUMDEVICEOBJECTSCALLBACK, LPVOID, DWORD flags)
         *
         * The callback is guest code, run once per object whose type the
         * filter's low byte includes (all of them for DIDFT_ALL), with the
         * caller parked meanwhile -- EnumDevices' shape. Only DIENUM_STOP ends
         * it; any other answer is taken as going on. One structure is written
         * over for each object: it is the callback's to read, not to keep.
         *
         * @param {any} device @param {number[]} args
         * @param {{ wide?: boolean }} [descriptor]
         * @returns {number | Promise<number>}
         */
        EnumObjects(device, [callback, context, flags], descriptor){
            if ((callback >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            const run = callGuest;
            if (!run || allocate === undefined)
            {
                return DI_OK;
            }
            const types = flags & 0xff;
            const wanted = (flags & DIDFT_ATTRIBUTES) !== 0 ? [] : objectsOf(device.kind)
                .filter(object=>types === 0 || (object.type & types) !== 0);
            if (wanted.length === 0)
            {
                return DI_OK;
            }
            const wide = descriptor?.wide === true;
            const address = arena(wide ? DIDEVICEOBJECTINSTANCE.SIZE_W
                : DIDEVICEOBJECTINSTANCE.SIZE_A);
            // Named before the first await, for the reason `enumerate` gives.
            const thread = callerThread?.();
            return (async()=>{
                for (const object of wanted)
                {
                    memory.writeMemory(address, objectInstanceBytes(object, wide));
                    const more = await run(callback >>> 0, [address, context >>> 0], thread);
                    if ((more | 0) === DIENUM_STOP)
                    {
                        break;
                    }
                }
                return DI_OK;
            })();
        },

        /**
         * HRESULT Poll(void)
         *
         * Nothing to poll: events arrive as they happen, and the device does
         * not claim DIDC_POLLEDDEVICE. Windows answers such a device with
         * DI_NOEFFECT from DirectInput 7 on and DI_OK before it, and a device
         * nobody holds with DIERR_NOTACQUIRED (Wine's joystick8.c).
         */
        Poll(device){
            if (!device.acquired)
            {
                return DIERR_NOTACQUIRED;
            }
            return device.version >= 0x0700 ? DI_NOEFFECT : DI_OK;
        },
    };

    // The generation and the width travel with the interface, as they do on
    // the roots: they are what GetCapabilities' device type and the string
    // structures are answered in.
    const deviceInterfaces = ()=>[
        describe(IID_IDirectInputDeviceA, IDIRECTINPUTDEVICE_SLOTS, deviceMethods,
            { legacy: true }),
        describe(IID_IDirectInputDeviceW, IDIRECTINPUTDEVICE_SLOTS, deviceMethods,
            { legacy: true, wide: true }),
        describe(IID_IDirectInputDevice2A, IDIRECTINPUTDEVICE2_SLOTS, deviceMethods,
            { legacy: true }),
        describe(IID_IDirectInputDevice2W, IDIRECTINPUTDEVICE2_SLOTS, deviceMethods,
            { legacy: true, wide: true }),
        describe(IID_IDirectInputDevice7A, IDIRECTINPUTDEVICE7_SLOTS, deviceMethods,
            { legacy: true }),
        describe(IID_IDirectInputDevice7W, IDIRECTINPUTDEVICE7_SLOTS, deviceMethods,
            { legacy: true, wide: true }),
        describe(IID_IDirectInputDevice8A, IDIRECTINPUTDEVICE8_SLOTS, deviceMethods),
        describe(IID_IDirectInputDevice8W, IDIRECTINPUTDEVICE8_SLOTS, deviceMethods,
            { wide: true }),
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

    /** How many times a program has asked what devices there are. */
    let enumerations = 0;

    /**
     * One DIDEVICEINSTANCE, in the width the interface asked about, in memory
     * of its own for a callback to be handed.
     *
     * @param {string} guid @param {number} devType
     * @param {string} instanceName @param {string} productName
     * @param {boolean} wide
     */
    const writeInstance = (guid, devType, instanceName, productName, wide)=>{
        const bytes = deviceInstanceBytes(guid, devType, instanceName, productName, wide);
        const address = arena(bytes.length);
        memory.writeMemory(address, bytes);
        return address;
    };

    /**
     * Describes the attached devices to a program's own callback, as Windows
     * does.
     *
     * For the class the caller asked (all, pointer or keyboard) each attached
     * device is written into a DIDEVICEINSTANCE in guest memory and the
     * callback is run on it; a callback that answers DIENUM_STOP ends the
     * enumeration there. The callback is guest code, so this runs the guest
     * from inside a host call and returns a promise the bridge parks the
     * caller on -- the same shape the sound seam's enumeration has.
     *
     * @param {number} type @param {number} callback @param {number} context
     * @param {number} flags @param {boolean} wide @param {boolean} legacy
     * @returns {number | Promise<number>}
     */
    const enumerate = (type, callback, context, flags, wide, legacy)=>{
        if ((callback >>> 0) === 0)
        {
            return DIERR_INVALIDPARAM;
        }
        const run = callGuest;
        if (!run || allocate === undefined)
        {
            // No route to guest code -- a test harness, or an engine assembled
            // without a bridge or a heap. Saying nothing is better than
            // reporting no devices, which a program reads as a machine with no
            // keyboard at all.
            return DI_OK;
        }
        const requested = type >>> 0;
        // A class is 0..4; anything above that names one device type, and the
        // class it belongs to is then "all" with the type filtering.
        const byClass = requested <= DI8DEVCLASS_GAMECTRL;
        const deviceClass = byClass ? requested : DI8DEVCLASS_ALL;
        const deviceType = byClass ? 0 : requested;

        /** @type {{ guid: string, name: string, product: string,
         *           devType: number }[]} */
        const attached = [];
        if (deviceClass === DI8DEVCLASS_ALL || deviceClass === DI8DEVCLASS_POINTER)
        {
            attached.push({
                guid: GUID_SysMouse,
                name: 'Mouse',
                product: 'Mouse',
                devType: devTypeOf(MOUSE, legacy),
            });
        }
        if (deviceClass === DI8DEVCLASS_ALL || deviceClass === DI8DEVCLASS_KEYBOARD)
        {
            attached.push({
                guid: GUID_SysKeyboard,
                name: 'Keyboard',
                product: 'Keyboard',
                devType: devTypeOf(KEYBOARD, legacy),
            });
        }

        enumerations++;
        // Named once, before the loop's first await: after that, the thread
        // the processor happens to be on is whoever else's turn the scheduler
        // gave it, not the thread EnumDevices is answering for.
        const thread = callerThread?.();
        return (async()=>{
            for (const offer of attached)
            {
                if (deviceType !== 0 && (offer.devType & 0xff) !== deviceType)
                {
                    continue;
                }
                // Nothing here can rumble, so a force-feedback request matches
                // nothing: the guid a device would name its driver by is null.
                if ((flags & DIEDFL_FORCEFEEDBACK) !== 0)
                {
                    continue;
                }
                const instance = writeInstance(
                    offer.guid, offer.devType, offer.name, offer.product, wide);
                const more = await run(callback >>> 0, [instance, context >>> 0], thread);
                if ((more | 0) === DIENUM_STOP)
                {
                    break;
                }
            }
            return DI_OK;
        })();
    };

    /** @type {Record<string, (target: any, args: number[], descriptor?: any) => any>} */
    const rootMethods = {
        /**
         * HRESULT CreateDevice(REFGUID, LPDIRECTINPUTDEVICE*, LPUNKNOWN)
         *
         * What comes back is the device interface the root is declared with:
         * IDirectInputDevice8 from IDirectInput8, IDirectInputDevice from
         * every earlier root, each in the root's width. A program holding an
         * IDirectInput8 calls Poll at slot 25 of what it is given without
         * asking for anything, so the shorter table is a call past its end.
         *
         * @param {any} root @param {number[]} args
         * @param {{ wide?: boolean, legacy?: boolean }} [descriptor]
         */
        CreateDevice(root, [guid, out], descriptor){
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
            const wide = descriptor?.wide === true;
            const id = descriptor?.legacy === false
                ? (wide ? IID_IDirectInputDevice8W : IID_IDirectInputDevice8A)
                : (wide ? IID_IDirectInputDeviceW : IID_IDirectInputDeviceA);
            device.setVersion(root.version);
            writeU32(out, publisher.publish(device, deviceInterfaces(), id));
            return DI_OK;
        },

        /**
         * HRESULT CreateDeviceEx(REFGUID, REFIID, LPVOID*, LPUNKNOWN)
         *
         * The extra argument is which interface to hand back. It is honoured
         * rather than ignored: a program asking for IDirectInputDevice8 and
         * given an IDirectInputDevice calls slot 20 of a table with fifteen.
         */
        CreateDeviceEx(root, [guid, iid, out]){
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
            device.setVersion(root.version);
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
         * The callback is guest code and the instance structure is written in
         * the width of the vtable the call arrived on, which is the one thing
         * the descriptor carries that the arguments do not. A DI8 interface
         * answers with DI8DEVTYPE_* and a pre-8 one with DIDEVTYPE_*, as the
         * version the program created the object with decides.
         *
         * @param {any} root
         * @param {number[]} args
         * @param {{ wide?: boolean, legacy?: boolean }} descriptor
         */
        EnumDevices(root, args, descriptor){
            const [type, callback, context, flags] = args;
            return enumerate(
                type >>> 0, callback, context, flags >>> 0,
                descriptor?.wide === true, descriptor?.legacy === true);
        },

        /** HRESULT GetDeviceStatus(REFGUID) */
        GetDeviceStatus(root, [guid]){
            const known = (guid >>> 0) !== 0
                && deviceFor(guidAt(guid)) !== null;
            return known ? DI_OK : DIERR_DEVICENOTREG;
        },

        /** HRESULT RunControlPanel(HWND, DWORD) */
        RunControlPanel(){
            return DI_OK;
        },
        /** HRESULT Initialize(HINSTANCE, DWORD version) */
        Initialize(root, [, version]){
            root.version = version >>> 0;
            return DI_OK;
        },
        /** HRESULT FindDevice(REFGUID, LPCSTR, LPGUID) */
        FindDevice(){
            return DIERR_DEVICENOTREG;
        },
    };

    const rootInterfaces = [
        describe(IID_IDirectInputA, IDIRECTINPUT_SLOTS, rootMethods, { legacy: true }),
        describe(IID_IDirectInputW, IDIRECTINPUT_SLOTS, rootMethods,
            { legacy: true, wide: true }),
        describe(IID_IDirectInput2A, IDIRECTINPUT2_SLOTS, rootMethods, { legacy: true }),
        describe(IID_IDirectInput2W, IDIRECTINPUT2_SLOTS, rootMethods,
            { legacy: true, wide: true }),
        describe(IID_IDirectInput7A, IDIRECTINPUT7_SLOTS, rootMethods, { legacy: true }),
        describe(IID_IDirectInput7W, IDIRECTINPUT7_SLOTS, rootMethods,
            { legacy: true, wide: true }),
        describe(IID_IDirectInput8A, IDIRECTINPUT8_SLOTS, rootMethods),
        describe(IID_IDirectInput8W, IDIRECTINPUT8_SLOTS, rootMethods, { wide: true }),
    ];

    /**
     * A new DirectInput object, as each creation call makes on Windows. It
     * remembers the version the program asked for: the devices it makes
     * answer as that version does.
     *
     * It counts its references as one object whichever interface each came
     * through, and the devices it made take none a program can see: Wine's
     * dinput tests release it to zero while a device is still held, and the
     * device goes on answering, since it keeps what it needs of its own.
     *
     * @param {number} out @param {string} id @param {number} version
     */
    const createInto = (out, id, version)=>{
        if ((out >>> 0) === 0)
        {
            return DIERR_INVALIDPARAM;
        }
        let references = 1;
        const root = {
            version: version >>> 0,
            addRef: ()=>++references,
            release: ()=>(references = Math.max(0, references - 1)),
            get destroyed(){
                return references === 0;
            },
        };
        const pointer = publisher.publish(root, rootInterfaces, id);
        writeU32(out, pointer);
        return pointer === 0 ? 0x80004002 | 0 : DI_OK;
    };

    return {
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

        /**
         * Whether a program holds this device exclusively right now: acquired
         * at a cooperative level with DISCL_EXCLUSIVE. While it does, the
         * device's input reaches the program through DirectInput alone --
         * Windows takes it as raw input with RIDEV_NOLEGACY, and the window's
         * own mouse or key messages stop, so one click is not read twice.
         *
         * @param {'keyboard' | 'mouse'} kind
         */
        exclusive(kind){
            const device = devices.get(kind === KEYBOARD ? GUID_SysKeyboard : GUID_SysMouse);
            return device !== undefined && device.acquired && device.exclusive;
        },

        libraries: {
            'DINPUT.dll': {
                /**
                 * HRESULT DirectInputCreateA(HINSTANCE, DWORD version,
                 *                            LPDIRECTINPUTA*, LPUNKNOWN)
                 */
                DirectInputCreateA: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([, version, out])=>createInto(out, IID_IDirectInputA, version),
                },
                DirectInputCreateW: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([, version, out])=>createInto(out, IID_IDirectInputW, version),
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
                    handler: ([, version, iid, out])=>createInto(
                        out, guidAt(iid), version),
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
                    handler: ([, version, iid, out])=>createInto(
                        out, guidAt(iid), version),
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
            // How often a program asked what devices there are. A program that
            // enumerates and then creates nothing is the question this answers.
            enumerations,
        }),
    };
}

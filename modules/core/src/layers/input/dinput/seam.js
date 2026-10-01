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
 * That is what `readFormat` does, so a program's own format -- not only
 * c_dfDIKeyboard and c_dfDIMouse -- is filled in where it asked, and the
 * offsets its buffered events carry are the ones its format gave.
 */

import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { readGuid, parseGuid } from '../../win32/ole32/guid.js';
import {
    createInputDevice, objectsOf, KEYBOARD, MOUSE, DIMOUSE_OFS, MOUSE_BUTTONS,
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
const DIERR_NOINTERFACE = 0x80004002 | 0;
/** ERROR_NOT_READY: an object no version was given to. */
const DIERR_NOTINITIALIZED = 0x80070015 | 0;
/** ERROR_RMODE_APP: a version no DirectInput was released as. */
const DIERR_BETADIRECTINPUTVERSION = 0x80070481 | 0;
/** ERROR_OLD_WIN_VERSION: a version later than this DirectInput. */
const DIERR_OLDDIRECTINPUTVERSION = 0x8007047e | 0;

/**
 * The versions a DirectInput before 8 was released as, which DirectInputCreate
 * and Initialize take: any other up to the last is a beta's, and one past it
 * asks for a later DirectInput than this one. DirectInput 8 takes 0x800 alone.
 */
const LEGACY_VERSIONS = new Set([0x300, 0x500, 0x50a, 0x5b2, 0x602, 0x61a, 0x700]);
const LAST_LEGACY_VERSION = 0x700;
const VERSION_8 = 0x800;

/**
 * Whether a DirectInput object can be what `version` asks for, as creation and
 * Initialize both decide: DI_OK or the refusal.
 *
 * @param {number} instance  The program's module handle.
 * @param {number} version
 * @param {boolean} eight   An IDirectInput8 object rather than an earlier one.
 * @returns {number}
 */
export function versionRefusal(instance, version, eight){
    const asked = version >>> 0;
    // Only the first DirectInput let a program leave out its module handle.
    if ((instance >>> 0) === 0 && (eight || asked !== 0x300))
    {
        return DIERR_INVALIDPARAM;
    }
    if (asked === 0)
    {
        return DIERR_NOTINITIALIZED;
    }
    if (eight)
    {
        return asked === VERSION_8 ? DI_OK
            : (asked < VERSION_8 ? DIERR_BETADIRECTINPUTVERSION : DIERR_OLDDIRECTINPUTVERSION);
    }
    if (asked > LAST_LEGACY_VERSION)
    {
        return DIERR_OLDDIRECTINPUTVERSION;
    }
    return LEGACY_VERSIONS.has(asked) ? DI_OK : DIERR_BETADIRECTINPUTVERSION;
}

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
/** Every EnumDevices flag: attached only, force feedback, aliases, phantoms, hidden. */
const DIEDFL_KNOWN = 0x00070101;

/**
 * Whether EnumDevices can be asked for this: a class, 0 to 4, or a device
 * type in either generation's numbering -- DIDEVTYPE_* up to 5 with the HID
 * bit, DI8DEVTYPE_* from 0x11 to 0x1c -- with a subtype in the second byte.
 *
 * @param {number} type
 */
const isDeviceKind = type=>{
    const low = type & 0xff;
    return (type & ~0x1ffff) === 0 && (low <= 5 || (low >= 0x11 && low <= 0x1c));
};
const DISCL_EXCLUSIVE = 0x00000001;
const DISCL_NONEXCLUSIVE = 0x00000002;
const DISCL_FOREGROUND = 0x00000004;
const DISCL_BACKGROUND = 0x00000008;

/** The devices a program creates, named by the GUIDs it was compiled with. */
export const GUID_SysKeyboard = '{6F1D2B61-D5A0-11CF-BFC7-444553540000}';
export const GUID_SysMouse = '{6F1D2B60-D5A0-11CF-BFC7-444553540000}';
/** The same two devices reached as emulated ones, each a device of its own. */
const GUID_SysMouseEm = '{6F1D2B80-D5A0-11CF-BFC7-444553540000}';
const GUID_SysMouseEm2 = '{6F1D2B81-D5A0-11CF-BFC7-444553540000}';
const GUID_SysKeyboardEm = '{6F1D2B82-D5A0-11CF-BFC7-444553540000}';
const GUID_SysKeyboardEm2 = '{6F1D2B83-D5A0-11CF-BFC7-444553540000}';
const KEYBOARD_GUIDS = new Set([GUID_SysKeyboard, GUID_SysKeyboardEm, GUID_SysKeyboardEm2]);
const MOUSE_GUIDS = new Set([GUID_SysMouse, GUID_SysMouseEm, GUID_SysMouseEm2]);
/** IDirectInputJoyConfig8, which an IDirectInput8 answers for and DirectInput8Create does not. */
const IID_IDirectInputJoyConfig8 = '{EB0D7DFA-1990-4F27-B4D6-EDF2EEC4A44C}';

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
/** The other MAKEDIPROP properties, by number. */
const DIPROP = Object.freeze({
    GRANULARITY: 3, RANGE: 4, DEADZONE: 5, SATURATION: 6, FFGAIN: 7, FFLOAD: 8,
    AUTOCENTER: 9, CALIBRATIONMODE: 10, CALIBRATION: 11, GUIDANDPATH: 12, INSTANCENAME: 13,
    PRODUCTNAME: 14, JOYSTICKID: 15, GETPORTDISPLAYNAME: 16, PHYSICALRANGE: 18,
    LOGICALRANGE: 19, KEYNAME: 20, CPOINTS: 21, APPDATA: 22, SCANCODE: 23, VIDPID: 24,
    USERNAME: 25, TYPENAME: 26,
});
/** The structure each property is read through: DIPROPDWORD, DIPROPRANGE and so on. */
const PROPERTY_SIZE = new Map([
    [DIPROP_BUFFERSIZE, 20], [DIPROP_AXISMODE, 20], [DIPROP.GRANULARITY, 20],
    [DIPROP.RANGE, 24], [DIPROP.DEADZONE, 20], [DIPROP.SATURATION, 20], [DIPROP.FFGAIN, 20],
    [DIPROP.FFLOAD, 20], [DIPROP.AUTOCENTER, 20], [DIPROP.CALIBRATIONMODE, 20],
    [DIPROP.CALIBRATION, 28], [DIPROP.GUIDANDPATH, 552], [DIPROP.INSTANCENAME, 536],
    [DIPROP.PRODUCTNAME, 536], [DIPROP.JOYSTICKID, 20], [DIPROP.GETPORTDISPLAYNAME, 536],
    [DIPROP.PHYSICALRANGE, 24], [DIPROP.LOGICALRANGE, 24], [DIPROP.KEYNAME, 536],
    [DIPROP.CPOINTS, 84], [DIPROP.APPDATA, 20], [DIPROP.SCANCODE, 20], [DIPROP.VIDPID, 20],
    [DIPROP.USERNAME, 536], [DIPROP.TYPENAME, 536],
]);
const DIPROPHEADER_SIZE = 16;
const DIPROPRANGE_NOMIN = 0x80000000 | 0;
const DIPROPRANGE_NOMAX = 0x7fffffff;
const DIPROPAXISMODE_ABS = 0;
const DIPROPAXISMODE_REL = 1;
const DIDF_RELAXIS = 0x00000002;
/**
 * The scan code DIPROP_SCANCODE reports for a key, as the bytes the keyboard
 * sends, first byte lowest: an extended key behind its 0xE0, and NumLock and
 * Pause each with the other's sequence, as Windows reports them.
 *
 * @param {number} dik
 */
const scanCodeOf = dik=>(dik === 0x45 ? 0x451de1 : dik === 0xc5 ? 0x45
    : dik >= 0x80 ? 0xe0 | ((dik & 0x7f) << 8) : dik);
/** A wheel notch, as the mouse reports its Z axis. */
const WHEEL_DELTA = 120;
const DIPH_DEVICE = 0;

/** DIDEVCAPS, as far as a program reads it. */
export const DIDEVCAPS = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwDevType: 0x08,
    dwAxes: 0x0c,
    dwButtons: 0x10,
    dwPOVs: 0x14,
    /** DirectX 3's structure ends after dwPOVs; the whole one carries five more. */
    SIZE_DX3: 24,
    SIZE: 44,
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

/** DIDATAFORMAT and DIOBJECTDATAFORMAT, as SetDataFormat reads them. */
const DIDATAFORMAT = Object.freeze({
    dwSize: 0x00, dwObjSize: 0x04, dwDataSize: 0x0c, dwNumObjs: 0x10, rgodf: 0x14, SIZE: 24,
});
const DIOBJECTDATAFORMAT = Object.freeze({ pguid: 0x0, dwOfs: 0x4, dwType: 0x8, SIZE: 16 });
const DIDFT_AXIS = 0x03;
const DIDFT_POV = 0x10;
/**
 * DIACTIONFORMAT and DIACTION, the action map a program describes its
 * controls with: the two widths differ only in the format's trailing name.
 */
const DIACTIONFORMAT = Object.freeze({
    dwSize: 0x00, dwActionSize: 0x04, dwNumActions: 0x0c, rgoAction: 0x10, guidActionMap: 0x14,
    dwBufferSize: 0x28,
    SIZE_A: 0x148, SIZE_W: 0x24c,
});
const DIACTION = Object.freeze({
    uAppData: 0x00, dwSemantic: 0x04, dwFlags: 0x08, guidInstance: 0x10, dwObjID: 0x20,
    dwHow: 0x24, SIZE: 40,
});
/** DIA_*: the program's own word on an action. */
const DIA_APPMAPPED = 0x02;
const DIA_APPNOMAP = 0x04;
/** DIAH_*: how an action came to be mapped. */
const DIAH_UNMAPPED = 0;
const DIAH_APPREQUESTED = 0x02;
const DIAH_DEFAULT = 0x20;
const DIAH_ERROR = 0x80000000;
const DIDBAM_INITIALIZE = 0x02;
const DIDSAM_FORCESAVE = 0x02;
/** A success that says the map applied was not kept for the user. */
const DI_SETTINGSNOTSAVED = 0x0000000b;
/** A semantic's top byte names its device for these two. */
const SEMANTIC_KEYBOARD = 0x81;
const SEMANTIC_MOUSE = 0x82;
const DIEDBS_MAPPEDPRI1 = 0x01;
const DIEDBSFL_FORCEFEEDBACK = 0x100;
const DIEDBSFL_THISUSER = 0x10;
const DIEDBSFL_AVAILABLEDEVICES = 0x1000;
/** The owner a device is given by a SetActionMap that names no user: whoever is logged on. */
const LOGGED_ON_USER = Symbol('logged-on user');
const DIDFT_ANYINSTANCE = 0xffff;
const DIDFT_OPTIONAL = 0x80000000;

/**
 * A program's data format read against a device's objects: where in the
 * program's structure each object it asked for goes, by the object's own
 * offset. Entries are matched in order, each to the first object not taken
 * yet whose GUID (when the entry names one), type and instance (unless any)
 * agree; an entry no object answers refuses the format unless it is
 * optional, as Windows refuses it (Wine's dinput tests). Null for a format
 * that cannot be read.
 *
 * @param {(address: number) => number} readU32
 * @param {(address: number) => string} guidAt
 * @param {number} format
 * @param {readonly import('./devices.js').DeviceObject[]} objects
 * @param {(why: string) => void} [refused]  Told what refused the format.
 * @returns {{ dataSize: number, places: Map<number, number>, centred: number[] } | null}
 *     `centred` is where an optional point-of-view entry no object answered
 *     sits: the state reads it as a POV at rest, all ones.
 */
export function readFormat(readU32, guidAt, format, objects, refused = ()=>{}){
    const dataSize = readU32(format + DIDATAFORMAT.dwDataSize);
    if (readU32(format + DIDATAFORMAT.dwSize) !== DIDATAFORMAT.SIZE
        || readU32(format + DIDATAFORMAT.dwObjSize) !== DIOBJECTDATAFORMAT.SIZE
        || dataSize % 4 !== 0)
    {
        refused(`a header of ${readU32(format + DIDATAFORMAT.dwSize)} bytes, objects of`
            + ` ${readU32(format + DIDATAFORMAT.dwObjSize)} and data of ${dataSize}`);
        return null;
    }
    const count = readU32(format + DIDATAFORMAT.dwNumObjs);
    const array = readU32(format + DIDATAFORMAT.rgodf);
    /** @type {Map<number, number>} */
    const places = new Map();
    /** @type {number[]} */
    const centred = [];
    const taken = new Set();
    for (let index = 0; index < count; index++)
    {
        const at = array + index * DIOBJECTDATAFORMAT.SIZE;
        const guid = readU32(at + DIOBJECTDATAFORMAT.pguid);
        const offset = readU32(at + DIOBJECTDATAFORMAT.dwOfs);
        const type = readU32(at + DIOBJECTDATAFORMAT.dwType);
        const instance = (type >>> 8) & 0xffff;
        const named = guid === 0 ? null : guidAt(guid);
        const object = objects.find(candidate=>!taken.has(candidate)
            && (named === null || candidate.guidType === named)
            && ((type & 0xff) === 0 || (candidate.type & type & 0xff) !== 0)
            && (instance === DIDFT_ANYINSTANCE || ((candidate.type >>> 8) & 0xffff) === instance));
        if (!object)
        {
            if ((type & DIDFT_OPTIONAL) === 0)
            {
                refused(`object ${index} of ${count} (${named ?? 'any'}, type`
                    + ` 0x${(type >>> 0).toString(16)}, at ${offset})`
                    + ' matches none of the device objects');
                return null;
            }
            if ((type & DIDFT_POV) !== 0 && offset + 4 <= dataSize)
            {
                centred.push(offset);
            }
            continue;
        }
        const width = (object.type & DIDFT_AXIS) !== 0 ? 4 : 1;
        if (offset + width > dataSize || offset % width !== 0)
        {
            refused(`object ${index} is placed at ${offset} of ${dataSize} bytes`);
            return null;
        }
        taken.add(object);
        places.set(object.offset, offset);
    }
    return { dataSize, places, centred };
}

/**
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (target: any, args: number[], descriptor: any) => any>} [implemented]
 * @param {{ wide?: boolean, legacy?: boolean, sharedWith?: string, unknown?: boolean }} [options]
 *     `wide` for a W interface, `legacy` for one of the pre-8 generations.
 *     Both are facts the method itself needs and the interface it arrived on
 *     is the only thing that carries them. `sharedWith` names the interface
 *     whose pointer answers this one too -- its table holding this one's and
 *     more -- and `unknown` makes this interface's pointer the object's
 *     IUnknown, as COM identity has one of them be.
 */
export function describe(id, slots, implemented = {}, options = {}){
    return {
        id,
        wide: options.wide === true,
        legacy: options.legacy === true,
        sharedWith: options.sharedWith,
        unknown: options.unknown === true,
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

/** IDirectInputJoyConfig8, after IUnknown's three. */
const IDIRECTINPUTJOYCONFIG8_SLOTS = /** @type {[string, number][]} */ ([
    ['Acquire', 0], ['Unacquire', 0], ['SetCooperativeLevel', 2], ['SendNotify', 0],
    ['EnumTypes', 2], ['GetTypeInfo', 3], ['SetTypeInfo', 4], ['DeleteType', 1],
    ['GetConfig', 3], ['SetConfig', 3], ['DeleteConfig', 1], ['GetUserValues', 2],
    ['SetUserValues', 1], ['AddNewHardware', 2], ['OpenTypeKey', 3], ['OpenAppStatusKey', 1],
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
                // DirectInput answers a null interface id with E_POINTER and
                // leaves the caller's pointer as it was.
                nullInterface: 'pointer',
                /** @param {string} id */
                interfaceFor(id){
                    if (id !== IID_IUNKNOWN && api.offers && !api.offers(id))
                    {
                        return null;
                    }
                    const descriptor = id === IID_IUNKNOWN
                        ? interfaces.find(entry=>entry.unknown === true)
                        : declared.get(id);
                    if (!descriptor)
                    {
                        return id === IID_IUNKNOWN ? { id, methods: IUNKNOWN_ONLY } : null;
                    }
                    const sharedWith = descriptor.sharedWith
                        ?? (id === IID_IUNKNOWN ? descriptor.id : undefined);
                    return {
                        id,
                        methods: methodsFor(descriptor),
                        ...sharedWith === undefined ? {} : { sharedWith },
                    };
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
 * @param {(api: string, detail: string) => void} [deps.divergence]
 *        Where a refusal the program may not expect is said.
 * @param {(hwnd: number) => 'top' | 'child' | null | undefined} [deps.windowKind]
 *        What a handle names: a top-level window, a child one, nothing -- or
 *        undefined when there are no windows to ask about, in which case any
 *        handle is taken as a window. SetCooperativeLevel wants a top-level one.
 */
export function createDirectInput(
    { memory, now, publishInterface, signal, allocate, callGuest, callerThread, windowKind,
        divergence },
)
{
    const publisher = createPublisher({ publishInterface });
    // The arena a structure handed to a callback is written in. It answers
    // zero when no heap was handed down, and the enumeration that needs one
    // refuses before it ever asks.
    const arena = allocate ?? (()=>0);

    /** @param {number} address */
    const guidAt = address=>readGuid(memory, address >>> 0);

    /**
     * What each device's SetDataFormat, or SetActionMap, settled on.
     *
     * @type {WeakMap<object, { dataSize: number, places: Map<number, number>,
     *     appData?: Map<number, number>, relative?: boolean, centred?: number[] }>}
     */
    const formats = new WeakMap();
    /**
     * Whose each device is, once a SetActionMap gave it to a user.
     *
     * @type {WeakMap<object, string | symbol>}
     */
    const owners = new WeakMap();

    /**
     * A user name a program passes, in its width; no name and an empty one
     * are both the empty string.
     *
     * @param {number} pointer @param {boolean} wide
     */
    const readName = (pointer, wide)=>{
        if ((pointer >>> 0) === 0)
        {
            return '';
        }
        const width = wide ? 2 : 1;
        const bytes = memory.readMemory(pointer >>> 0, 256 * width);
        let text = '';
        for (let at = 0; at + width <= bytes.length; at += width)
        {
            const unit = wide ? bytes[at] | bytes[at + 1] << 8 : bytes[at];
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /** Each device's force-feedback gain, which these devices keep and never use. */
    const gains = new WeakMap();

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

    /** @param {any} device */
    const guidOfDevice = device=>instanceGuids.get(device)
        ?? (device.kind === KEYBOARD ? GUID_SysKeyboard : GUID_SysMouse);

    /**
     * A DIACTIONFORMAT's actions, or null for one that cannot be read.
     *
     * @param {number} format
     */
    const readActions = format=>{
        if ((format >>> 0) === 0)
        {
            return null;
        }
        const size = readU32(format + DIACTIONFORMAT.dwSize);
        const count = readU32(format + DIACTIONFORMAT.dwNumActions);
        const array = readU32(format + DIACTIONFORMAT.rgoAction);
        if ((size !== DIACTIONFORMAT.SIZE_A && size !== DIACTIONFORMAT.SIZE_W)
            || readU32(format + DIACTIONFORMAT.dwActionSize) !== DIACTION.SIZE
            || (count > 0 && array === 0))
        {
            divergence?.('DirectInput', `an action format of ${size} bytes, actions of`
                + ` ${readU32(format + DIACTIONFORMAT.dwActionSize)}, ${count} at 0x${
                    array.toString(16)} was refused`);
            return null;
        }
        return {
            count,
            /** @param {number} index */
            at: index=>array + index * DIACTION.SIZE,
            bufferSize: readU32(format + DIACTIONFORMAT.dwBufferSize),
        };
    };

    /**
     * The object of this device a semantic names, if it names one: a
     * keyboard semantic carries its key's DIK code and a mouse semantic its
     * offset in DIMOUSESTATE2, both in the low byte. A genre's semantic names
     * a control of a game device, and neither of these is one.
     *
     * @param {any} device @param {number} semantic
     */
    const objectForSemantic = (device, semantic)=>{
        const kind = semantic >>> 24;
        if ((kind === SEMANTIC_KEYBOARD && device.kind === KEYBOARD)
            || (kind === SEMANTIC_MOUSE && device.kind === MOUSE))
        {
            return objectsOf(device.kind).find(object=>object.offset === (semantic & 0xff))
                ?? null;
        }
        return null;
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
         * The description is read object by object (`readFormat`), and a
         * held device cannot change it.
         */
        SetDataFormat(device, [format]){
            if ((format >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            if (device.acquired)
            {
                return DIERR_ACQUIRED;
            }
            const read = readFormat(readU32, guidAt, format >>> 0, objectsOf(device.kind),
                why=>divergence?.('DirectInput', `SetDataFormat on the ${device.kind} was`
                    + ` refused: ${why}`));
            if (!read)
            {
                return DIERR_INVALIDPARAM;
            }
            formats.set(device, {
                ...read,
                relative: (readU32((format >>> 0) + 8) & DIDF_RELAXIS) !== 0,
            });
            device.setDataSize(read.dataSize);
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
            if (property === DIPROP.FFGAIN)
            {
                const gain = readU32((header >>> 0) + DIPROPDWORD_DATA);
                if (gain > 10000)
                {
                    return DIERR_INVALIDPARAM;
                }
                gains.set(device, gain);
                return DI_OK;
            }
            // Axis mode, ranges, dead zones: accepted and ignored. The device
            // is already relative and already unscaled, which is what every
            // one of them would be asking for.
            return DI_OK;
        },

        /**
         * HRESULT GetProperty(REFGUID, LPDIPROPHEADER)
         *
         * As Windows answers for its system mouse and keyboard (Wine's
         * device8.c): the structure has to be the property's, an object is
         * named by its offset in the program's format or by its id, and what
         * these devices do not have is DIERR_UNSUPPORTED.
         */
        GetProperty(device, [guid, header]){
            if ((header >>> 0) === 0)
            {
                return DIERR_INVALIDPARAM;
            }
            const property = guid >>> 0;
            const expected = PROPERTY_SIZE.get(property);
            if (expected === undefined)
            {
                return DIERR_UNSUPPORTED;
            }
            const at = header >>> 0;
            if (readU32(at) !== expected || readU32(at + 4) !== DIPROPHEADER_SIZE)
            {
                return DIERR_INVALIDPARAM;
            }
            const which = readU32(at + 8);
            const how = readU32(at + 12);
            const eight = device.version >= 0x0800;
            if (how === DIPH_DEVICE)
            {
                if (which !== 0)
                {
                    return DIERR_INVALIDPARAM;
                }
                switch (property)
                {
                    case DIPROP_BUFFERSIZE:
                        writeU32(at + DIPROPDWORD_DATA, device.bufferSize);
                        return DI_OK;
                    case DIPROP_AXISMODE:
                        writeU32(at + DIPROPDWORD_DATA, formats.get(device)?.relative === true
                            ? DIPROPAXISMODE_REL : DIPROPAXISMODE_ABS);
                        return DI_OK;
                    case DIPROP.FFGAIN:
                        writeU32(at + DIPROPDWORD_DATA, gains.get(device) ?? 10000);
                        return DI_OK;
                    case DIPROP.USERNAME:
                        if (!eight)
                        {
                            return DIERR_UNSUPPORTED;
                        }
                        memory.writeMemory(at + DIPROPHEADER_SIZE, new Uint8Array(2));
                        return DI_NOEFFECT;
                    case DIPROP.SCANCODE:
                    case DIPROP.KEYNAME:
                        // An object's property, asked of the whole device.
                        return eight ? DIERR_INVALIDPARAM : DIERR_UNSUPPORTED;
                    default:
                        return DIERR_UNSUPPORTED;
                }
            }
            if (how === DIPH_BYUSAGE)
            {
                return DIERR_UNSUPPORTED;
            }
            /** @type {import('./devices.js').DeviceObject | undefined} */
            let object;
            if (how === DIPH_BYOFFSET)
            {
                // The offset is the program's, in the format it set.
                const places = formats.get(device)?.places;
                const own = places
                    ? [...places].find(([, place])=>place === which)?.[0] : undefined;
                object = own === undefined ? undefined
                    : objectsOf(device.kind).find(candidate=>candidate.offset === own);
            }
            else if (how === DIPH_BYID)
            {
                const named = objectNamed(device, which, DIPH_BYID);
                object = typeof named === 'number' ? undefined : named;
            }
            else
            {
                return DIERR_INVALIDPARAM;
            }
            if (!object)
            {
                return DIERR_NOTFOUND;
            }
            const axis = (object.type & DIDFT_AXIS) !== 0;
            if (axis && property === DIPROP.GRANULARITY)
            {
                writeU32(at + DIPROPDWORD_DATA,
                    object.offset === DIMOUSE_OFS.Z ? WHEEL_DELTA : 1);
                return DI_OK;
            }
            if (axis && property === DIPROP.RANGE)
            {
                writeU32(at + DIPROPDWORD_DATA, DIPROPRANGE_NOMIN);
                writeU32(at + DIPROPDWORD_DATA + 4, DIPROPRANGE_NOMAX);
                return DI_OK;
            }
            if (device.kind === KEYBOARD && property === DIPROP.SCANCODE)
            {
                if (!eight)
                {
                    return DIERR_UNSUPPORTED;
                }
                writeU32(at + DIPROPDWORD_DATA, scanCodeOf(object.offset));
                return DI_OK;
            }
            if (device.kind === KEYBOARD && property === DIPROP.KEYNAME)
            {
                memory.writeMemory(at + DIPROPHEADER_SIZE, textBytes(object.name, true));
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

            const format = formats.get(device);
            if (!format)
            {
                return DIERR_INVALIDPARAM;
            }
            // Each object the format asked for, where it asked: an axis a
            // long, a key or a button a byte. What it did not ask for is zero.
            const bytes = new Uint8Array(wanted);
            const view = new DataView(bytes.buffer);
            if (device.kind === KEYBOARD)
            {
                const keys = device.keyboardState();
                for (const [own, place] of format.places)
                {
                    bytes[place] = keys[own];
                }
            }
            else
            {
                const state = device.mouseState();
                const axes = [state.x, state.y, state.wheel];
                for (const [own, place] of format.places)
                {
                    if (own < DIMOUSE_OFS.BUTTON0)
                    {
                        view.setInt32(place, axes[own / 4], true);
                    }
                    else
                    {
                        bytes[place] = state.buttons[own - DIMOUSE_OFS.BUTTON0];
                    }
                }
            }
            for (const place of format.centred ?? [])
            {
                view.setUint32(place, 0xffffffff, true);
            }
            memory.writeMemory(data >>> 0, bytes);
            return DI_OK;
        },

        /**
         * HRESULT GetDeviceData(DWORD size, LPDIDEVICEOBJECTDATA, LPDWORD count,
         *                       DWORD flags)
         *
         * Drains up to `count` events into the array, answering through
         * `count` how many; a null array drains them all the same, which is
         * how a program flushes the buffer. DIGDD_PEEK leaves them where they
         * were.
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
            // A null array is still a read: what it would have received is
            // taken out of the buffer, which is how a program flushes it.
            const peek = (flags & DIGDD_PEEK) !== 0;
            const drained = device.drain(asked, peek);
            const overflow = drained.overflow;
            // An event carries its object's offset in the program's format,
            // and an object the format left out is not reported.
            const places = formats.get(device)?.places;
            const appData = formats.get(device)?.appData;
            const events = places
                ? drained.events.filter((/** @type {any} */ event)=>places.has(event.offset))
                    .map((/** @type {any} */ event)=>({ ...event, offset: places.get(event.offset) }))
                : drained.events;

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
                    if (entrySize === DIDEVICEOBJECTDATA.SIZE_DX8)
                    {
                        view.setUint32(at + DIDEVICEOBJECTDATA.uAppData,
                            appData?.get(event.offset) ?? 0, true);
                    }
                });
                if (bytes.length > 0)
                {
                    memory.writeMemory(array >>> 0, bytes);
                }
            }

            writeU32(count, events.length);
            return overflow ? DI_BUFFEROVERFLOW : DI_OK;
        },

        /**
         * HRESULT BuildActionMap(LPDIACTIONFORMAT, LPCTSTR user, DWORD flags)
         *
         * Each action whose semantic names an object of this device is mapped
         * to it -- its guidInstance this device, its dwObjID the object, how
         * DIAH_DEFAULT -- unless another device already holds it; an action
         * the program mapped itself is checked against the object it named.
         * DI_NOEFFECT when nothing here answers any of them.
         */
        BuildActionMap(device, [format, , flags]){
            const actions = readActions(format);
            if (!actions)
            {
                return DIERR_INVALIDPARAM;
            }
            const own = guidOfDevice(device);
            const ownBytes = parseGuid(own) ?? new Uint8Array(16);
            let mapped = 0;
            for (let index = 0; index < actions.count; index++)
            {
                const at = actions.at(index);
                // Initializing starts over: what the program said of each
                // action before is dropped with the mapping it had.
                if ((flags & DIDBAM_INITIALIZE) !== 0)
                {
                    writeU32(at + DIACTION.dwFlags, 0);
                }
                const actionFlags = readU32(at + DIACTION.dwFlags);
                const holder = guidAt(at + DIACTION.guidInstance);
                if ((actionFlags & DIA_APPNOMAP) !== 0)
                {
                    continue;
                }
                if ((actionFlags & DIA_APPMAPPED) !== 0)
                {
                    if (holder === own)
                    {
                        const named = objectNamed(device, readU32(at + DIACTION.dwObjID),
                            DIPH_BYID);
                        writeU32(at + DIACTION.dwHow,
                            typeof named === 'number' ? DIAH_ERROR : DIAH_APPREQUESTED);
                        mapped += typeof named === 'number' ? 0 : 1;
                    }
                    continue;
                }
                if (readU32(at + DIACTION.dwHow) !== DIAH_UNMAPPED && holder !== own
                    && (flags & DIDBAM_INITIALIZE) === 0)
                {
                    continue;
                }
                const object = objectForSemantic(device, readU32(at + DIACTION.dwSemantic));
                if (!object)
                {
                    continue;
                }
                memory.writeMemory(at + DIACTION.guidInstance, ownBytes);
                writeU32(at + DIACTION.dwObjID, object.type);
                writeU32(at + DIACTION.dwHow, DIAH_DEFAULT);
                mapped++;
            }
            return mapped > 0 ? DI_OK : DI_NOEFFECT;
        },

        /**
         * HRESULT SetActionMap(LPDIACTIONFORMAT, LPCTSTR user, DWORD flags)
         *
         * The device's data format becomes the action map: a dword per action,
         * in the actions' order, each mapped one's object reported at its
         * action's place and with its action's uAppData; the format's buffer
         * size is the device's. Settled while nobody holds the device.
         */
        SetActionMap(device, [format, user, flags], descriptor){
            const actions = readActions(format);
            if (!actions)
            {
                return DIERR_INVALIDPARAM;
            }
            if (device.acquired)
            {
                return DIERR_ACQUIRED;
            }
            const own = guidOfDevice(device);
            /** @type {Map<number, number>} */
            const places = new Map();
            /** @type {Map<number, number>} */
            const appData = new Map();
            for (let index = 0; index < actions.count; index++)
            {
                const at = actions.at(index);
                const how = readU32(at + DIACTION.dwHow);
                if (how === DIAH_UNMAPPED || (how & DIAH_ERROR) !== 0
                    || guidAt(at + DIACTION.guidInstance) !== own)
                {
                    continue;
                }
                const object = objectNamed(device, readU32(at + DIACTION.dwObjID), DIPH_BYID);
                if (typeof object === 'number' || places.has(object.offset))
                {
                    continue;
                }
                places.set(object.offset, index * 4);
                appData.set(index * 4, readU32(at + DIACTION.uAppData));
            }
            const dataSize = actions.count * 4;
            formats.set(device, { dataSize, places, appData });
            // The device is the user's from now on, as EnumDevicesBySemantics
            // tells a program asking whose it is.
            owners.set(device, readName(user, descriptor?.wide === true) || LOGGED_ON_USER);
            device.setDataSize(dataSize);
            if (actions.bufferSize > 0)
            {
                device.setBufferSize(actions.bufferSize);
            }
            // There is nowhere a user's map is kept, so one forced to be
            // saved is applied and not saved.
            return (flags & DIDSAM_FORCESAVE) !== 0 ? DI_SETTINGSNOTSAVED : DI_OK;
        },

        /**
         * HRESULT Initialize(HINSTANCE, DWORD version, REFGUID)
         *
         * The device becomes the one the GUID names among those of its own
         * kind -- the system device or one of its emulated twins -- as that
         * version makes it.
         */
        Initialize(device, [, version, guid]){
            if ((guid >>> 0) === 0)
            {
                return E_POINTER;
            }
            const named = guidAt(guid);
            const kind = KEYBOARD_GUIDS.has(named) ? KEYBOARD
                : MOUSE_GUIDS.has(named) ? MOUSE : null;
            if (kind !== device.kind)
            {
                return DIERR_DEVICENOTREG;
            }
            instanceGuids.set(device, named);
            if ((version >>> 0) !== 0)
            {
                device.setVersion(version >>> 0);
            }
            return DI_OK;
        },

        /** HRESULT GetCapabilities(LPDIDEVCAPS) */
        GetCapabilities(device, [caps], descriptor){
            const size = (caps >>> 0) === 0 ? 0 : readU32(caps + DIDEVCAPS.dwSize);
            if (size !== DIDEVCAPS.SIZE && size !== DIDEVCAPS.SIZE_DX3)
            {
                return DIERR_INVALIDPARAM;
            }
            if (size === DIDEVCAPS.SIZE)
            {
                // No force feedback, no firmware or hardware to name.
                memory.writeMemory(caps + DIDEVCAPS.SIZE_DX3,
                    new Uint8Array(DIDEVCAPS.SIZE - DIDEVCAPS.SIZE_DX3));
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
            const whole = deviceInstanceBytes(guidOfDevice(device),
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

    /** @param {string} guid  Whether it names a device this machine has. */
    const isDevice = guid=>KEYBOARD_GUIDS.has(guid) || MOUSE_GUIDS.has(guid);

    /**
     * The interfaces of one generation: a device made by IDirectInput8 is
     * reached as IDirectInputDevice8 and nothing older, one made by an
     * earlier root as the older ones and not as 8 (Wine's device8.c).
     *
     * @param {any} device
     */
    const generationOf = device=>(/** @type {string} */ id)=>
        (id === IID_IDirectInputDevice8A || id === IID_IDirectInputDevice8W)
            === (device.version >= 0x0800);

    /** The GUID each device was made or initialized as. @type {WeakMap<object, string>} */
    const instanceGuids = new WeakMap();

    /** @param {string} guid */
    const deviceFor = guid=>{
        if (!isDevice(guid))
        {
            return null;
        }
        let device = devices.get(guid);
        // A device released to nothing is over, and a new CreateDevice makes
        // a new one rather than handing back a pointer the bridge has let go.
        // One still held is handed out again with a reference for this caller.
        if (device && !device.destroyed)
        {
            device.addRef();
            return device;
        }
        device = createInputDevice({
            kind: KEYBOARD_GUIDS.has(guid) ? KEYBOARD : MOUSE,
            now,
        });
        device.offers = generationOf(device);
        instanceGuids.set(device, guid);
        devices.set(guid, device);
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
        if ((callback >>> 0) === 0 || (flags & ~DIEDFL_KNOWN) !== 0 || !isDeviceKind(type))
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
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if ((guid >>> 0) === 0)
            {
                writeU32(out, 0);
                return E_POINTER;
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

        /**
         * HRESULT EnumDevicesBySemantics(LPCTSTR user, LPDIACTIONFORMAT,
         *     LPDIENUMDEVICESBYSEMANTICSCB, LPVOID, DWORD flags)
         *
         * Each attached device is made and handed to the program's callback
         * with how the actions map to it and how many devices are still to
         * come; the program keeps one by taking a reference of its own, since
         * the one it was handed with is let go of after the callback.
         *
         * @param {any} root @param {number[]} args
         * @param {{ wide?: boolean }} descriptor
         */
        EnumDevicesBySemantics(root, [user, format, callback, context, flags], descriptor){
            const actions = readActions(format);
            if (!actions || (callback >>> 0) === 0
                || memory.readMemory((format >>> 0) + DIACTIONFORMAT.guidActionMap, 16)
                    .every((/** @type {number} */ byte)=>byte === 0))
            {
                return DIERR_INVALIDPARAM;
            }
            const run = callGuest;
            if (!run || allocate === undefined || (flags & DIEDBSFL_FORCEFEEDBACK) !== 0)
            {
                return DI_OK;
            }
            const wide = descriptor?.wide === true;
            const semantics = Array.from({ length: actions.count },
                (_, index)=>readU32(actions.at(index) + DIACTION.dwSemantic));
            // Which devices, by whose they are (Wine's dinput.c
            // test_EnumDevicesBySemantics): a user's own are those a
            // SetActionMap gave that user -- any user's, when none is named --
            // and the available ones those nobody has.
            const asked = readName(user, wide);
            const mine = (/** @type {any} */ device)=>{
                const owner = owners.get(device);
                return owner !== undefined && (asked === '' || owner === asked);
            };
            const free = (/** @type {any} */ device)=>!owners.has(device);
            const wanted = (/** @type {any} */ device)=>{
                switch (flags & (DIEDBSFL_THISUSER | DIEDBSFL_AVAILABLEDEVICES))
                {
                    case DIEDBSFL_THISUSER: return mine(device);
                    case DIEDBSFL_AVAILABLEDEVICES: return free(device);
                    case DIEDBSFL_THISUSER | DIEDBSFL_AVAILABLEDEVICES:
                        return mine(device) || free(device);
                    default: return true;
                }
            };
            const offers = /** @type {const} */ ([
                { guid: GUID_SysKeyboard, kind: KEYBOARD, name: 'Keyboard' },
                { guid: GUID_SysMouse, kind: MOUSE, name: 'Mouse' },
            ]).filter(offer=>wanted(deviceFor(offer.guid)));
            enumerations++;
            const thread = callerThread?.();
            return (async()=>{
                for (const [index, offer] of offers.entries())
                {
                    const device = /** @type {any} */ (deviceFor(offer.guid));
                    device.setVersion(root.version);
                    const pointer = publisher.publish(device, deviceInterfaces(),
                        wide ? IID_IDirectInputDevice8W : IID_IDirectInputDevice8A);
                    const instance = writeInstance(offer.guid, devTypeOf(offer.kind, false),
                        offer.name, offer.name, wide);
                    const mapped = semantics.some(semantic=>objectForSemantic(device, semantic));
                    const more = await run(callback >>> 0, [instance, pointer,
                        mapped ? DIEDBS_MAPPEDPRI1 : 0, offers.length - 1 - index,
                        context >>> 0], thread);
                    device.release();
                    if ((more | 0) === DIENUM_STOP)
                    {
                        break;
                    }
                }
                return DI_OK;
            })();
        },

        /** HRESULT GetDeviceStatus(REFGUID) */
        GetDeviceStatus(root, [guid]){
            if ((guid >>> 0) === 0)
            {
                return E_POINTER;
            }
            return isDevice(guidAt(guid)) ? DI_OK : DIERR_DEVICENOTREG;
        },

        /**
         * HRESULT RunControlPanel(HWND, DWORD)
         *
         * There is no control panel to show; what can be refused is.
         */
        RunControlPanel(root, [owner, flags]){
            if ((owner >>> 0) !== 0 && windowKind?.(owner >>> 0) === null)
            {
                return E_HANDLE;
            }
            return (flags >>> 0) !== 0 ? DIERR_INVALIDPARAM : DI_OK;
        },
        /**
         * HRESULT Initialize(HINSTANCE, DWORD version)
         *
         * Refused as creation refuses, and checked again each time: a version
         * already taken does not make a bad one good.
         */
        Initialize(root, [instance, version]){
            const refused = versionRefusal(instance, version, root.eight);
            if (refused !== DI_OK)
            {
                return refused;
            }
            root.version = version >>> 0;
            return DI_OK;
        },
        /** HRESULT FindDevice(REFGUID, LPCSTR, LPGUID) */
        FindDevice(){
            return DIERR_DEVICENOTREG;
        },
    };

    // A root before 8 is one object with two tables, the ANSI and the wide
    // IDirectInput7; each earlier generation's pointer is the same table, which
    // holds its methods first, and the wide one is the object's IUnknown.
    const legacyA = describe(IID_IDirectInput7A, IDIRECTINPUT7_SLOTS, rootMethods,
        { legacy: true });
    const legacyW = describe(IID_IDirectInput7W, IDIRECTINPUT7_SLOTS, rootMethods,
        { legacy: true, wide: true, unknown: true });
    /** @param {string} id @param {any} table */
    const sameAs = (id, table)=>({ ...table, id, sharedWith: table.id, unknown: false });
    const legacyRootInterfaces = [
        sameAs(IID_IDirectInputA, legacyA), sameAs(IID_IDirectInput2A, legacyA), legacyA,
        sameAs(IID_IDirectInputW, legacyW), sameAs(IID_IDirectInput2W, legacyW), legacyW,
    ];
    const rootInterfaces8 = [
        describe(IID_IDirectInput8A, IDIRECTINPUT8_SLOTS, rootMethods),
        describe(IID_IDirectInput8W, IDIRECTINPUT8_SLOTS, rootMethods, { wide: true }),
    ];
    const isRootOf = (/** @type {string} */ id, /** @type {boolean} */ eight)=>
        (eight ? rootInterfaces8 : legacyRootInterfaces).some(entry=>entry.id === id);
    // A root a program already holds also answers as the joystick
    // configuration interface; the configuration it would change is none
    // here, so each method is the not-implemented answer.
    const joyConfigInterface = describe(IID_IDirectInputJoyConfig8,
        IDIRECTINPUTJOYCONFIG8_SLOTS, {});

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
     * @param {Object} request
     * @param {number} request.instance
     * @param {number} request.version
     * @param {string} request.id
     * @param {number} request.out
     * @param {number} request.outer
     * @param {boolean} request.eight  DirectInput8Create's rather than an earlier call's.
     */
    const create = ({ instance, version, id, out, outer, eight })=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        if (!isRootOf(id, eight))
        {
            writeU32(out, 0);
            return DIERR_NOINTERFACE;
        }
        // Asked to be part of another object, Windows makes nothing and
        // says so only through the pointer it leaves null.
        if ((outer >>> 0) !== 0)
        {
            writeU32(out, 0);
            return DI_OK;
        }
        const refused = versionRefusal(instance, version, eight);
        if (refused !== DI_OK)
        {
            writeU32(out, 0);
            return refused;
        }
        let references = 1;
        const root = {
            version: version >>> 0,
            eight,
            addRef: ()=>++references,
            release: ()=>(references = Math.max(0, references - 1)),
            get destroyed(){
                return references === 0;
            },
        };
        const pointer = publisher.publish(root,
            eight ? [...rootInterfaces8, joyConfigInterface] : legacyRootInterfaces, id);
        writeU32(out, pointer);
        return pointer === 0 ? DIERR_NOINTERFACE : DI_OK;
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
            // The system device and its emulated twins all hear the keyboard,
            // or the mouse, each taking it as its own state allows.
            const guids = event.kind === 'key' ? KEYBOARD_GUIDS : MOUSE_GUIDS;
            let taken = false;
            for (const guid of guids)
            {
                const device = devices.get(guid);
                if (!device || device.destroyed || !device.post(event))
                {
                    continue;
                }
                taken = true;
                if (device.notifyEvent !== 0)
                {
                    signal?.(device.notifyEvent);
                }
            }
            return taken;
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
                    handler: ([instance, version, out, outer])=>create(
                        { instance, version, id: IID_IDirectInputA, out, outer, eight: false }),
                },
                DirectInputCreateW: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([instance, version, out, outer])=>create(
                        { instance, version, id: IID_IDirectInputW, out, outer, eight: false }),
                },
                /**
                 * HRESULT DirectInputCreateEx(HINSTANCE, DWORD, REFIID,
                 *                             LPVOID*, LPUNKNOWN)
                 *
                 * The interface the caller names is the one it gets, for the
                 * reason CreateDeviceEx honours its own: handing back a shorter
                 * vtable than it expects is a jump off the end of one. One that
                 * is no IDirectInput before 8 is refused before anything else
                 * is looked at, the pointer left as it was.
                 */
                DirectInputCreateEx: {
                    argBytes: 20,
                    /** @param {number[]} args */
                    handler: ([instance, version, iid, out, outer])=>{
                        const id = (iid >>> 0) === 0 ? '' : guidAt(iid);
                        return isRootOf(id, false)
                            ? create({ instance, version, id, out, outer, eight: false })
                            : DIERR_NOINTERFACE;
                    },
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
                    handler: ([instance, version, iid, out, outer])=>create({
                        instance, version, id: (iid >>> 0) === 0 ? '' : guidAt(iid), out, outer,
                        eight: true,
                    }),
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

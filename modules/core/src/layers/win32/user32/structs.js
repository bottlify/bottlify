/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The user32 structures, declared once as winuser.h and windef.h declare
 * them (`system/layout.js`): their offsets and sizes at either pointer width
 * are derived from the declaration, so a field read from the wrong place - a
 * plausible-looking value rather than an error - is not a typo in a table.
 *
 * Reading and writing them lives here too, so that the layouts and the code
 * that uses them cannot drift apart.
 */
import { paramsOf, wideParams } from '../common/pointers.js';
import { POINT, RECT as RECT_LAYOUT, fieldOf, highOf, struct, union }
    from '../../../system/layout.js';

/** @typedef {import('../../../system/layout.js').Table} Table */

/** WNDCLASSA's fields, which WNDCLASSEXA has between its cbSize and its hIconSm. */
const WNDCLASS_FIELDS = /** @type {const} */ ([
    ['style', 'u32'], ['lpfnWndProc', 'ptr'], ['cbClsExtra', 'i32'], ['cbWndExtra', 'i32'],
    ['hInstance', 'ptr'], ['hIcon', 'handle'], ['hCursor', 'handle'],
    ['hbrBackground', 'handle'], ['lpszMenuName', 'ptr'], ['lpszClassName', 'ptr'],
]);
/** WNDCLASSA, the classic form RegisterClassA takes. */
const WNDCLASSA_LAYOUT = struct(WNDCLASS_FIELDS);
/**
 * WNDCLASSEXA. Not WNDCLASSA with two fields bolted on: cbSize comes first, so
 * at 32 bits every other field sits four bytes further along than its classic
 * twin.
 */
const WNDCLASSEXA_LAYOUT = struct([['cbSize', 'u32'], ...WNDCLASS_FIELDS, ['hIconSm', 'handle']]);
/** MSG. Its `pt` member is a POINT inlined at the end, hence two fields here. */
const MSG_LAYOUT = struct([['hwnd', 'handle'], ['message', 'u32'], ['wParam', 'ptr'],
    ['lParam', 'handle'], ['time', 'u32'], ['ptX', 'i32'], ['ptY', 'i32']]);
/**
 * PAINTSTRUCT. The trailing reserved bytes are part of the size a guest
 * allocated, so they are named here even though nothing writes them.
 */
const PAINTSTRUCT_LAYOUT = struct([['hdc', 'handle'], ['fErase', 'i32'],
    ['rcPaint', RECT_LAYOUT], ['fRestore', 'i32'], ['fIncUpdate', 'i32'],
    ['rgbReserved', 'u8', 32]]);
const CREATESTRUCTA_LAYOUT = struct([['lpCreateParams', 'ptr'], ['hInstance', 'ptr'],
    ['hMenu', 'handle'], ['hwndParent', 'handle'], ['cy', 'i32'], ['cx', 'i32'], ['y', 'i32'],
    ['x', 'i32'], ['style', 'i32'], ['lpszName', 'ptr'], ['lpszClass', 'ptr'],
    ['dwExStyle', 'u32']]);
const CBT_CREATEWNDA_LAYOUT = struct([['lpcs', 'ptr'], ['hwndInsertAfter', 'handle']]);
const WINDOWPOS_LAYOUT = struct([['hwnd', 'handle'], ['hwndInsertAfter', 'handle'],
    ['x', 'i32'], ['y', 'i32'], ['cx', 'i32'], ['cy', 'i32'], ['flags', 'u32']]);
/** CBTACTIVATESTRUCT: whether a click did it, and the window active until now. */
const CBTACTIVATESTRUCT_LAYOUT = struct([['fMouse', 'i32'], ['hWndActive', 'handle']]);
/** MOUSEHOOKSTRUCT: the point on the screen, the window, the hit, the extra word. */
const MOUSEHOOKSTRUCT_LAYOUT = struct([['ptX', 'i32'], ['ptY', 'i32'], ['hwnd', 'handle'],
    ['wHitTestCode', 'u32'], ['dwExtraInfo', 'ptr']]);
/**
 * INPUT, as SendInput reads it: the type, then the union of MOUSEINPUT,
 * KEYBDINPUT and HARDWAREINPUT, whose dwExtraInfo puts it on an eight-byte
 * boundary at 64 bits. The members' fields are named in the INPUT itself, the
 * keyboard's dwFlags and each member's dwExtraInfo by their member.
 */
const INPUT_LAYOUT = struct([['type', 'u32'], [null, union([
    [['dx', 'i32'], ['dy', 'i32'], ['mouseData', 'u32'], ['dwFlags', 'u32'], [null, 'u32'],
        ['mouseExtra', 'ptr']],
    [['wVk', 'u16'], ['wScan', 'u16'], ['keyFlags', 'u32'], [null, 'u32'], ['keyExtra', 'ptr']],
    [[null, 'u32'], [null, 'u16'], [null, 'u16']],
])]]);
/** NCCALCSIZE_PARAMS: three RECTs, then the WINDOWPOS's address. */
const NCCALCSIZE_PARAMS_LAYOUT = struct([['rgrc', RECT_LAYOUT, 3], ['lppos', 'ptr']]);

/** WNDCLASSA at 32 bits (`userLayouts` for a process's width). */
export const WNDCLASSA = WNDCLASSA_LAYOUT.at(4);
/** WNDCLASSEXA at 32 bits. */
export const WNDCLASSEXA = WNDCLASSEXA_LAYOUT.at(4);
/** MSG at 32 bits. */
export const MSG = MSG_LAYOUT.at(4);
/** RECT, in the order a guest reads it back. */
export const RECT = RECT_LAYOUT.at(4);
/** PAINTSTRUCT at 32 bits. */
export const PAINTSTRUCT = PAINTSTRUCT_LAYOUT.at(4);

/**
 * @typedef {Object} UserLayouts
 * @property {4 | 8} pointerSize
 * @property {Table} WNDCLASSA
 * @property {Table} WNDCLASSEXA
 * @property {Table} MSG
 * @property {Table} PAINTSTRUCT
 * @property {Table} CREATESTRUCTA
 * @property {Table} CBT_CREATEWNDA
 * @property {Table} WINDOWPOS
 * @property {Table} NCCALCSIZE_PARAMS
 * @property {Table} CBTACTIVATESTRUCT
 * @property {Table} MOUSEHOOKSTRUCT
 * @property {Table} INPUT
 */

/** @type {Map<number, UserLayouts>} */
const LAYOUTS = new Map();

/**
 * The structures at a process's pointer width.
 *
 * @param {number} [pointerSize]  4 or 8; 4 by default
 * @returns {UserLayouts}
 */
export function userLayouts(pointerSize = 4){
    const width = pointerSize === 8 ? 8 : 4;
    let layouts = LAYOUTS.get(width);
    if (!layouts)
    {
        layouts = Object.freeze({
            pointerSize: width,
            WNDCLASSA: WNDCLASSA_LAYOUT.at(width),
            WNDCLASSEXA: WNDCLASSEXA_LAYOUT.at(width),
            MSG: MSG_LAYOUT.at(width),
            PAINTSTRUCT: PAINTSTRUCT_LAYOUT.at(width),
            CREATESTRUCTA: CREATESTRUCTA_LAYOUT.at(width),
            CBT_CREATEWNDA: CBT_CREATEWNDA_LAYOUT.at(width),
            WINDOWPOS: WINDOWPOS_LAYOUT.at(width),
            NCCALCSIZE_PARAMS: NCCALCSIZE_PARAMS_LAYOUT.at(width),
            CBTACTIVATESTRUCT: CBTACTIVATESTRUCT_LAYOUT.at(width),
            MOUSEHOOKSTRUCT: MOUSEHOOKSTRUCT_LAYOUT.at(width),
            INPUT: INPUT_LAYOUT.at(width),
        });
        LAYOUTS.set(width, layouts);
    }
    return layouts;
}

/**
 * Whether a field is pointer-sized at the table's width: eight bytes at 64
 * bits, its high dword the kind's (`highOf`).
 *
 * @param {Table} layout @param {string} name
 */
const wideField = (layout, name)=>fieldOf(layout, name)?.size === 8;

/**
 * Lays named fields of a structure into `view` at `base`: every one a DWORD
 * as the engine holds it, and a pointer-sized field at 64 bits its high dword
 * after - an address's zero, or its own past 4 GiB, a handle's or an LPARAM's
 * sign, so HWND_TOPMOST is -1 whole.
 *
 * @param {DataView} view @param {number} base
 * @param {Table} layout @param {Record<string, number>} values
 */
export function putFields(view, base, layout, values){
    for (const [name, value] of Object.entries(values))
    {
        const at = base + layout[name];
        view.setUint32(at, value >>> 0, true);
        if (wideField(layout, name))
        {
            view.setUint32(at + 4, highOf(value,
                /** @type {'ptr' | 'handle'} */ (fieldOf(layout, name)?.kind)), true);
        }
    }
}

/**
 * Writes named fields of a structure in guest memory, each in place: the
 * fields not named are left as they were.
 *
 * @param {StructMemory} memory @param {number} address
 * @param {Table} layout @param {Record<string, number>} values
 */
export function writeFields(memory, address, layout, values){
    for (const [name, value] of Object.entries(values))
    {
        const bytes = new Uint8Array(wideField(layout, name) ? 8 : 4);
        putFields(new DataView(bytes.buffer), -layout[name], layout, { [name]: value });
        memory.writeMemory(address + layout[name], bytes);
    }
}

/**
 * @typedef {Object} StructMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {number} the DWORD at that address, unsigned
 */
export function readU32(memory, address){
    const bytes = memory.readMemory(address, 4);
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/**
 * Writes consecutive DWORDs. Every structure here is a run of them, so one
 * write covers a whole struct and no field can land on a stale neighbour.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {number[]} values
 */
export function writeU32s(memory, address, values){
    const bytes = new Uint8Array(values.length * 4);
    for (let index = 0; index < values.length; index++)
    {
        const value = values[index] >>> 0;
        const at = index * 4;
        bytes[at] = value & 0xff;
        bytes[at + 1] = (value >>> 8) & 0xff;
        bytes[at + 2] = (value >>> 16) & 0xff;
        bytes[at + 3] = (value >>> 24) & 0xff;
    }
    memory.writeMemory(address, bytes);
}

/**
 * @typedef {Object} WindowClassFields
 * @property {number} style
 * @property {number} wndProc
 * @property {number} classExtra
 * @property {number} windowExtra
 * @property {number} instance
 * @property {number} icon
 * @property {number} cursor
 * @property {number} background
 * @property {number} menuName    Pointer, or an ordinal; never dereferenced here.
 * @property {number} className   Pointer to the name the class registers under.
 * @property {number} iconSm      Zero for the classic form, which has no such field.
 */

/**
 * Reads either form of the class structure. The layout decides which fields
 * exist; everything past that is the same set of values, which is why the two
 * registration entry points differ by one argument and nothing else.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {Table} layout  A WNDCLASS or WNDCLASSEX at either width.
 * @returns {WindowClassFields}
 */
export function readWindowClass(memory, address, layout){
    /** @param {number} offset */
    const field = offset=>readU32(memory, address + offset);
    /**
     * An address field, whole in a 64-bit structure: a procedure or a name in
     * an image past 4 GiB is not its low dword.
     *
     * @param {string} name
     */
    const address64 = name=>(wideField(layout, name)
        ? field(layout[name]) + readU32(memory, address + layout[name] + 4) * 2 ** 32
        : field(layout[name]));
    return {
        style: field(layout.style),
        wndProc: address64('lpfnWndProc'),
        classExtra: field(layout.cbClsExtra) | 0,
        windowExtra: field(layout.cbWndExtra) | 0,
        instance: address64('hInstance'),
        icon: field(layout.hIcon),
        cursor: field(layout.hCursor),
        background: field(layout.hbrBackground),
        menuName: address64('lpszMenuName'),
        className: address64('lpszClassName'),
        iconSm: 'hIconSm' in layout ? field(layout.hIconSm) : 0,
    };
}

/**
 * Fills in a WNDCLASS or a WNDCLASSEX for GetClassInfo(Ex), the layout saying
 * which; cbSize is the caller's and is left as it was. The name pointer it
 * reports back is the one the class was registered with: the guest owns that
 * string, and handing back a pointer into a buffer of ours would outlive
 * nothing it can see.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {WindowClassFields} fields
 * @param {UserLayouts} [layouts]  The process's width; a 32-bit one's by default.
 * @param {Table} [layout]  WNDCLASSA by default.
 */
export function writeWindowClass(memory, address, fields, layouts = userLayouts(4),
    layout = layouts.WNDCLASSA)
{
    writeFields(memory, address, layout, {
        style: fields.style,
        lpfnWndProc: fields.wndProc,
        cbClsExtra: fields.classExtra,
        cbWndExtra: fields.windowExtra,
        hInstance: fields.instance,
        hIcon: fields.icon,
        hCursor: fields.cursor,
        hbrBackground: fields.background,
        lpszMenuName: fields.menuName,
        lpszClassName: fields.className,
        ...'hIconSm' in layout ? { hIconSm: fields.iconSm ?? 0 } : {},
    });
}

/**
 * @typedef {Object} MessageFields
 * @property {number} hwnd
 * @property {number} message
 * @property {number} wParam
 * @property {number} lParam
 * @property {number} time
 * @property {number} x
 * @property {number} y
 * @property {import('../common/pointers.js').WideParams} [wide]
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {MessageFields} message
 * @param {UserLayouts} [layouts]  The process's width; a 32-bit one's by default.
 */
export function writeMessage(memory, address, message, layouts = userLayouts(4)){
    const layout = layouts.MSG;
    const bytes = new Uint8Array(layout.SIZE);
    putFields(new DataView(bytes.buffer), 0, layout, {
        hwnd: message.hwnd,
        message: message.message,
        wParam: message.wParam,
        lParam: message.lParam,
        time: message.time,
        ptX: message.x,
        ptY: message.y,
    });
    // What a 64-bit poster passed that the dwords do not say goes back whole.
    const [w, l] = layouts.pointerSize === 8 ? paramsOf(message) : [0, 0];
    const view = new DataView(bytes.buffer);
    if (typeof w === 'bigint')
    {
        view.setBigUint64(layout.wParam, w, true);
    }
    if (typeof l === 'bigint')
    {
        view.setBigUint64(layout.lParam, l, true);
    }
    // The 32-bit MSG ends at the point; a 64-bit one's lPrivate after it is
    // the system's, and left as the caller had it.
    memory.writeMemory(address, bytes.subarray(0, layout.ptY + 4));
}

/**
 * Reads back the part of a MSG that TranslateMessage and DispatchMessageA act
 * on: the four fields a window procedure takes, and the timestamp, which is
 * what a TIMERPROC takes in their place. The cursor position is the queue's
 * own bookkeeping and nothing here decides anything by it.
 *
 * A field of a 64-bit MSG is read by its low half; a WPARAM or an LPARAM whose
 * high half says more than the dword does is carried beside it (`wide`).
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {UserLayouts} [layouts]  The process's width; a 32-bit one's by default.
 * @returns {{ hwnd: number, message: number, wParam: number, lParam: number,
 *             time: number, wide?: import('../common/pointers.js').WideParams }}
 */
export function readMessage(memory, address, layouts = userLayouts(4)){
    const layout = layouts.MSG;
    const wParam = readU32(memory, address + layout.wParam);
    const lParam = readU32(memory, address + layout.lParam);
    const wide = layouts.pointerSize === 8 ? wideParams(wParam,
        readU32(memory, address + layout.wParam + 4), lParam,
        readU32(memory, address + layout.lParam + 4)) : undefined;
    return {
        hwnd: readU32(memory, address + layout.hwnd),
        message: readU32(memory, address + layout.message),
        wParam,
        lParam,
        // What a TIMERPROC is handed as its tick count when DispatchMessage
        // calls it.
        time: readU32(memory, address + layout.time),
        ...wide ? { wide } : {},
    };
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {{ left: number, top: number, right: number, bottom: number }} rect
 */
export function writeRect(memory, address, rect){
    writeU32s(memory, address, [rect.left, rect.top, rect.right, rect.bottom]);
}

/** MONITORINFO. cbSize is written by the caller and tells us which it wants. */
const MONITORINFO_FIELDS = /** @type {const} */ ([['cbSize', 'u32'], ['rcMonitor', RECT_LAYOUT],
    ['rcWork', RECT_LAYOUT], ['dwFlags', 'u32']]);
export const MONITORINFO = struct(MONITORINFO_FIELDS).at(4);

/** MONITORINFOEXA is MONITORINFO plus a device name. */
export const MONITORINFOEXA_SIZE = struct([...MONITORINFO_FIELDS, ['szDevice', 'u8', 32]])
    .sizeOf(4);

/**
 * DISPLAY_DEVICE, both spellings. Four fixed-length strings with the state
 * word between the second and the third, which is why the wide form is not
 * the ANSI one doubled: every field past cb sits at its own place in each,
 * and the size the caller declares says which of the two it built.
 *
 * @param {'u8' | 'u16'} char
 */
const displayDevice = char=>struct([['cb', 'u32'], ['DeviceName', char, 32],
    ['DeviceString', char, 128], ['StateFlags', 'u32'], ['DeviceID', char, 128],
    ['DeviceKey', char, 128]]).at(4);
export const DISPLAY_DEVICEA = displayDevice('u8');
export const DISPLAY_DEVICEW = displayDevice('u16');

/** The characters each DISPLAY_DEVICE string field holds, in either spelling. */
export const DISPLAY_DEVICE_CHARS = Object.freeze(Object.fromEntries(
    ['DeviceName', 'DeviceString', 'DeviceID', 'DeviceKey'].map(name=>[name,
        /** @type {import('../../../system/layout.js').Field} */ (
            fieldOf(DISPLAY_DEVICEA, name)).count])));

/**
 * WINDOWINFO. The last two members are WORDs, which is why the structure ends
 * at 60 rather than at a multiple of four fields.
 */
export const WINDOWINFO = struct([['cbSize', 'u32'], ['rcWindow', RECT_LAYOUT],
    ['rcClient', RECT_LAYOUT], ['dwStyle', 'u32'], ['dwExStyle', 'u32'],
    ['dwWindowStatus', 'u32'], ['cxWindowBorders', 'u32'], ['cyWindowBorders', 'u32'],
    ['atomWindowType', 'u16'], ['wCreatorVersion', 'u16']]).at(4);

/** WINDOWPLACEMENT. */
export const WINDOWPLACEMENT = struct([['length', 'u32'], ['flags', 'u32'], ['showCmd', 'u32'],
    ['ptMinPosition', POINT], ['ptMaxPosition', POINT], ['rcNormalPosition', RECT_LAYOUT]]).at(4);

/**
 * DEVMODE, either spelling. Only the members a display-mode enumeration
 * touches are named: the printer members and the union at 44 are room, and
 * naming a field this layer never reads or writes would suggest it means
 * something here. The wide form's two names move every member after the
 * first by 32 and those after the second by 64.
 *
 * @param {'u8' | 'u16'} char
 */
const devMode = char=>struct([['dmDeviceName', char, 32], ['dmSpecVersion', 'u16'],
    ['dmDriverVersion', 'u16'], ['dmSize', 'u16'], ['dmDriverExtra', 'u16'], ['dmFields', 'u32'],
    // The printer's eight shorts, or the display's dmPosition, then its orientation.
    [null, union([[[null, 'i16', 8]], [[null, 'i32', 2], ['dmDisplayOrientation', 'u32'],
        [null, 'u32']]])],
    // dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate, dmFormName, dmLogPixels.
    [null, 'i16', 5], [null, char, 32], [null, 'u16'],
    ['dmBitsPerPel', 'u32'], ['dmPelsWidth', 'u32'], ['dmPelsHeight', 'u32'],
    ['dmDisplayFlags', 'u32'], ['dmDisplayFrequency', 'u32'],
    // dmICMMethod to dmPanningHeight.
    [null, 'u32', 8]]).at(4);
export const DEVMODEA = devMode('u8');
export const DEVMODEW = devMode('u16');

/** The dmFields bits this layer fills in. */
export const DM_BITSPERPEL = 0x00040000;
export const DM_PELSWIDTH = 0x00080000;
export const DM_PELSHEIGHT = 0x00100000;
export const DM_DISPLAYFREQUENCY = 0x00400000;

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
export function readRect(memory, address){
    return {
        left: readU32(memory, address + RECT.left) | 0,
        top: readU32(memory, address + RECT.top) | 0,
        right: readU32(memory, address + RECT.right) | 0,
        bottom: readU32(memory, address + RECT.bottom) | 0,
    };
}

/**
 * Writes a WORD without disturbing the one beside it. Two of WINDOWINFO's
 * members share a DWORD, so the whole-DWORD writer cannot be used for them.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {number} value
 */
export function writeU16(memory, address, value){
    memory.writeMemory(address, new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The user32 structures, laid out the way the guest compiled them.
 *
 * Every field of every one of these is four bytes on a 32-bit target, so each
 * offset is just its position in the declaration times four. They are written
 * out anyway, because an offset is part of the ABI: a field read from the wrong
 * place is a plausible-looking value rather than an error, and the guest is the
 * only one who can tell the difference.
 *
 * Reading and writing them lives here too, so that the offsets and the code
 * that uses them cannot drift apart.
 */

/** WNDCLASSA, the classic form RegisterClassA takes. */
export const WNDCLASSA = Object.freeze({
    style: 0,
    lpfnWndProc: 4,
    cbClsExtra: 8,
    cbWndExtra: 12,
    hInstance: 16,
    hIcon: 20,
    hCursor: 24,
    hbrBackground: 28,
    lpszMenuName: 32,
    lpszClassName: 36,
    SIZE: 40,
});

/**
 * WNDCLASSEXA. Not WNDCLASSA with two fields bolted on: cbSize comes first, so
 * every other field sits four bytes further along than its classic twin.
 */
export const WNDCLASSEXA = Object.freeze({
    cbSize: 0,
    style: 4,
    lpfnWndProc: 8,
    cbClsExtra: 12,
    cbWndExtra: 16,
    hInstance: 20,
    hIcon: 24,
    hCursor: 28,
    hbrBackground: 32,
    lpszMenuName: 36,
    lpszClassName: 40,
    hIconSm: 44,
    SIZE: 48,
});

/** MSG. Its `pt` member is a POINT inlined at the end, hence two fields here. */
export const MSG = Object.freeze({
    hwnd: 0,
    message: 4,
    wParam: 8,
    lParam: 12,
    time: 16,
    ptX: 20,
    ptY: 24,
    SIZE: 28,
});

/** RECT, in the order a guest reads it back. */
export const RECT = Object.freeze({
    left: 0,
    top: 4,
    right: 8,
    bottom: 12,
    SIZE: 16,
});

/**
 * The structures whose fields include pointers, handles or WPARAM-sized
 * values, laid out for a 64-bit process: those fields are eight bytes and on
 * an eight-byte boundary, which moves every field after them and pads the
 * end to eight. `WIDE` names each such field and how a 32-bit value the
 * engine holds widens into it -- a pointer or a handle, and an LPARAM or an
 * LRESULT, sign-extended as a LONG is, so -1 is -1 whole; a WPARAM or a
 * UINT_PTR zero-extended as a UINT is. The offsets are winuser.h's under
 * _WIN64.
 */
const WNDCLASSA64 = Object.freeze({
    style: 0, lpfnWndProc: 8, cbClsExtra: 16, cbWndExtra: 20, hInstance: 24, hIcon: 32,
    hCursor: 40, hbrBackground: 48, lpszMenuName: 56, lpszClassName: 64, SIZE: 72,
});
const WNDCLASSEXA64 = Object.freeze({
    cbSize: 0, style: 4, lpfnWndProc: 8, cbClsExtra: 16, cbWndExtra: 20, hInstance: 24,
    hIcon: 32, hCursor: 40, hbrBackground: 48, lpszMenuName: 56, lpszClassName: 64,
    hIconSm: 72, SIZE: 80,
});
const MSG64 = Object.freeze({
    hwnd: 0, message: 8, wParam: 16, lParam: 24, time: 32, ptX: 36, ptY: 40, SIZE: 48,
});
const PAINTSTRUCT64 = Object.freeze({
    hdc: 0, fErase: 8, rcPaint: 12, fRestore: 28, fIncUpdate: 32, rgbReserved: 36, SIZE: 72,
});
const CREATESTRUCTA64 = Object.freeze({
    lpCreateParams: 0, hInstance: 8, hMenu: 16, hwndParent: 24, cy: 32, cx: 36, y: 40, x: 44,
    style: 48, lpszName: 56, lpszClass: 64, dwExStyle: 72, SIZE: 80,
});
const CREATESTRUCTA32 = Object.freeze({
    lpCreateParams: 0x00, hInstance: 0x04, hMenu: 0x08, hwndParent: 0x0c, cy: 0x10, cx: 0x14,
    y: 0x18, x: 0x1c, style: 0x20, lpszName: 0x24, lpszClass: 0x28, dwExStyle: 0x2c, SIZE: 0x30,
});
const CBT_CREATEWNDA32 = Object.freeze({ lpcs: 0, hwndInsertAfter: 4, SIZE: 8 });
const CBT_CREATEWNDA64 = Object.freeze({ lpcs: 0, hwndInsertAfter: 8, SIZE: 16 });
const WINDOWPOS32 = Object.freeze({
    hwnd: 0, hwndInsertAfter: 4, x: 8, y: 12, cx: 16, cy: 20, flags: 24, SIZE: 28,
});
const WINDOWPOS64 = Object.freeze({
    hwnd: 0, hwndInsertAfter: 8, x: 16, y: 20, cx: 24, cy: 28, flags: 32, SIZE: 40,
});
/** NCCALCSIZE_PARAMS: three RECTs, then the WINDOWPOS's address. */
const NCCALCSIZE_PARAMS32 = Object.freeze({ rgrc: 0, lppos: 48, SIZE: 52 });
const NCCALCSIZE_PARAMS64 = Object.freeze({ rgrc: 0, lppos: 48, SIZE: 56 });

/** How each eight-byte field widens a 32-bit value: as a LONG, or as a UINT. */
const WIDE = Object.freeze({
    hwnd: 'signed', hwndInsertAfter: 'signed', lpfnWndProc: 'signed', hInstance: 'signed',
    hIcon: 'signed', hCursor: 'signed', hbrBackground: 'signed', lpszMenuName: 'signed',
    lpszClassName: 'signed', hIconSm: 'signed', wParam: 'unsigned', lParam: 'signed',
    hdc: 'signed', lpCreateParams: 'signed', hMenu: 'signed', hwndParent: 'signed',
    lpszName: 'signed', lpszClass: 'signed', lpcs: 'signed', lppos: 'signed',
});

/**
 * @typedef {Object} UserLayouts
 * @property {4 | 8} pointerSize
 * @property {Record<string, number>} WNDCLASSA
 * @property {Record<string, number>} WNDCLASSEXA
 * @property {Record<string, number>} MSG
 * @property {Record<string, number>} PAINTSTRUCT
 * @property {Record<string, number>} CREATESTRUCTA
 * @property {Record<string, number>} CBT_CREATEWNDA
 * @property {Record<string, number>} WINDOWPOS
 * @property {Record<string, number>} NCCALCSIZE_PARAMS
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
    const wide = pointerSize === 8;
    let layouts = LAYOUTS.get(pointerSize);
    if (!layouts)
    {
        layouts = Object.freeze({
            pointerSize: wide ? 8 : 4,
            WNDCLASSA: wide ? WNDCLASSA64 : WNDCLASSA,
            WNDCLASSEXA: wide ? WNDCLASSEXA64 : WNDCLASSEXA,
            MSG: wide ? MSG64 : MSG,
            PAINTSTRUCT: wide ? PAINTSTRUCT64 : PAINTSTRUCT,
            CREATESTRUCTA: wide ? CREATESTRUCTA64 : CREATESTRUCTA32,
            CBT_CREATEWNDA: wide ? CBT_CREATEWNDA64 : CBT_CREATEWNDA32,
            WINDOWPOS: wide ? WINDOWPOS64 : WINDOWPOS32,
            NCCALCSIZE_PARAMS: wide ? NCCALCSIZE_PARAMS64 : NCCALCSIZE_PARAMS32,
        });
        LAYOUTS.set(pointerSize, layouts);
    }
    return layouts;
}

/**
 * Lays named fields of a structure into `view` at `base`: a field `WIDE`
 * names is eight bytes at 64 bits, widened as it says, every other one a
 * DWORD.
 *
 * @param {DataView} view @param {number} base @param {UserLayouts} layouts
 * @param {Record<string, number>} layout @param {Record<string, number>} values
 */
export function putFields(view, base, layouts, layout, values){
    for (const [name, value] of Object.entries(values))
    {
        const at = base + layout[name];
        view.setUint32(at, value >>> 0, true);
        if (layouts.pointerSize === 8 && Object.hasOwn(WIDE, name))
        {
            const signed = WIDE[/** @type {keyof typeof WIDE} */ (name)] === 'signed';
            view.setUint32(at + 4, signed && (value | 0) < 0 ? 0xffffffff : 0, true);
        }
    }
}

/**
 * Writes named fields of a structure in guest memory, each in place: the
 * fields not named are left as they were.
 *
 * @param {StructMemory} memory @param {number} address @param {UserLayouts} layouts
 * @param {Record<string, number>} layout @param {Record<string, number>} values
 */
export function writeFields(memory, address, layouts, layout, values){
    for (const [name, value] of Object.entries(values))
    {
        const wide = layouts.pointerSize === 8 && Object.hasOwn(WIDE, name);
        const bytes = new Uint8Array(wide ? 8 : 4);
        putFields(new DataView(bytes.buffer), -layout[name], layouts, layout, { [name]: value });
        memory.writeMemory((address + layout[name]) >>> 0, bytes);
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
 * @param {Record<string, number>} layout  A WNDCLASS or WNDCLASSEX at either width.
 * @returns {WindowClassFields}
 */
export function readWindowClass(memory, address, layout){
    /** @param {number} offset */
    const field = offset=>readU32(memory, address + offset);
    return {
        style: field(layout.style),
        wndProc: field(layout.lpfnWndProc),
        classExtra: field(layout.cbClsExtra) | 0,
        windowExtra: field(layout.cbWndExtra) | 0,
        instance: field(layout.hInstance),
        icon: field(layout.hIcon),
        cursor: field(layout.hCursor),
        background: field(layout.hbrBackground),
        menuName: field(layout.lpszMenuName),
        className: field(layout.lpszClassName),
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
 * @param {Record<string, number>} [layout]  WNDCLASSA by default.
 */
export function writeWindowClass(memory, address, fields, layouts = userLayouts(4),
    layout = layouts.WNDCLASSA)
{
    writeFields(memory, address, layouts, layout, {
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
    putFields(new DataView(bytes.buffer), 0, layouts, layout, {
        hwnd: message.hwnd,
        message: message.message,
        wParam: message.wParam,
        lParam: message.lParam,
        time: message.time,
        ptX: message.x,
        ptY: message.y,
    });
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
 * A field of a 64-bit MSG is read by its low half: a pointer, a handle and
 * every value the queue holds lie within it.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {UserLayouts} [layouts]  The process's width; a 32-bit one's by default.
 * @returns {{ hwnd: number, message: number, wParam: number, lParam: number,
 *             time: number }}
 */
export function readMessage(memory, address, layouts = userLayouts(4)){
    const layout = layouts.MSG;
    return {
        hwnd: readU32(memory, address + layout.hwnd),
        message: readU32(memory, address + layout.message),
        wParam: readU32(memory, address + layout.wParam),
        lParam: readU32(memory, address + layout.lParam),
        // What a TIMERPROC is handed as its tick count when DispatchMessage
        // calls it.
        time: readU32(memory, address + layout.time),
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

/**
 * PAINTSTRUCT. The trailing reserved bytes are part of the size a guest
 * allocated, so they are named here even though nothing writes them.
 */
export const PAINTSTRUCT = Object.freeze({
    hdc: 0,
    fErase: 4,
    rcPaint: 8,
    fRestore: 24,
    fIncUpdate: 28,
    rgbReserved: 32,
    SIZE: 64,
});

/** MONITORINFO. cbSize is written by the caller and tells us which it wants. */
export const MONITORINFO = Object.freeze({
    cbSize: 0,
    rcMonitor: 4,
    rcWork: 20,
    dwFlags: 36,
    SIZE: 40,
});

/** MONITORINFOEXA is MONITORINFO plus a device name. */
export const MONITORINFOEXA_SIZE = 40 + 32;

/**
 * DISPLAY_DEVICE, both spellings. Four fixed-length strings with the state
 * word between the second and the third, which is why the wide form is not
 * the ANSI one doubled: every field past cb sits at its own place in each,
 * and the size the caller declares says which of the two it built.
 */
export const DISPLAY_DEVICEA = Object.freeze({
    cb: 0,
    DeviceName: 4,
    DeviceString: 36,
    StateFlags: 164,
    DeviceID: 168,
    DeviceKey: 296,
    SIZE: 424,
});

export const DISPLAY_DEVICEW = Object.freeze({
    cb: 0,
    DeviceName: 4,
    DeviceString: 68,
    StateFlags: 324,
    DeviceID: 328,
    DeviceKey: 584,
    SIZE: 840,
});

/** The characters each DISPLAY_DEVICE string field holds, in either spelling. */
export const DISPLAY_DEVICE_CHARS = Object.freeze({
    DeviceName: 32,
    DeviceString: 128,
    DeviceID: 128,
    DeviceKey: 128,
});

/**
 * WINDOWINFO. The last two members are WORDs, which is why the structure ends
 * at 60 rather than at a multiple of four fields.
 */
export const WINDOWINFO = Object.freeze({
    cbSize: 0,
    rcWindow: 4,
    rcClient: 20,
    dwStyle: 36,
    dwExStyle: 40,
    dwWindowStatus: 44,
    cxWindowBorders: 48,
    cyWindowBorders: 52,
    atomWindowType: 56,
    wCreatorVersion: 58,
    SIZE: 60,
});

/** WINDOWPLACEMENT. */
export const WINDOWPLACEMENT = Object.freeze({
    length: 0,
    flags: 4,
    showCmd: 8,
    ptMinPosition: 12,
    ptMaxPosition: 20,
    rcNormalPosition: 28,
    SIZE: 44,
});

/**
 * DEVMODEA, only the members a display-mode enumeration touches. The union at
 * 44 and the printer members after it are skipped deliberately: naming a field
 * this layer never reads or writes would suggest it means something here.
 */
export const DEVMODEA = Object.freeze({
    dmDeviceName: 0,
    dmSpecVersion: 32,
    dmDriverVersion: 34,
    dmSize: 36,
    dmDriverExtra: 38,
    dmFields: 40,
    dmBitsPerPel: 104,
    dmPelsWidth: 108,
    dmPelsHeight: 112,
    dmDisplayFlags: 116,
    dmDisplayFrequency: 120,
    SIZE: 156,
});

/**
 * DEVMODEW, the same members with both names wide: the device name's 32 more
 * bytes move every member after it along by 32, and the form name's move the
 * ones after that by 64.
 */
export const DEVMODEW = Object.freeze({
    dmDeviceName: 0,
    dmSpecVersion: 64,
    dmDriverVersion: 66,
    dmSize: 68,
    dmDriverExtra: 70,
    dmFields: 72,
    dmBitsPerPel: 168,
    dmPelsWidth: 172,
    dmPelsHeight: 176,
    dmDisplayFlags: 180,
    dmDisplayFrequency: 184,
    SIZE: 220,
});

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

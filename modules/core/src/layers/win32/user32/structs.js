/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
 * @param {typeof WNDCLASSA | typeof WNDCLASSEXA} layout
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
 * Fills in a WNDCLASSA for GetClassInfoA. The name pointer it reports back is
 * the one the class was registered with: the guest owns that string, and
 * handing back a pointer into a buffer of ours would outlive nothing it can see.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {WindowClassFields} fields
 */
export function writeWindowClassA(memory, address, fields){
    writeU32s(memory, address, [
        fields.style,
        fields.wndProc,
        fields.classExtra,
        fields.windowExtra,
        fields.instance,
        fields.icon,
        fields.cursor,
        fields.background,
        fields.menuName,
        fields.className,
    ]);
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
 */
export function writeMessage(memory, address, message){
    writeU32s(memory, address, [
        message.hwnd,
        message.message,
        message.wParam,
        message.lParam,
        message.time,
        message.x,
        message.y,
    ]);
}

/**
 * Reads back the part of a MSG that TranslateMessage and DispatchMessageA act
 * on. The timestamp and the cursor position are the queue's own bookkeeping and
 * nothing here decides anything by them.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {{ hwnd: number, message: number, wParam: number, lParam: number }}
 */
export function readMessage(memory, address){
    return {
        hwnd: readU32(memory, address + MSG.hwnd),
        message: readU32(memory, address + MSG.message),
        wParam: readU32(memory, address + MSG.wParam),
        lParam: readU32(memory, address + MSG.lParam),
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

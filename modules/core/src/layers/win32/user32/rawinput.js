/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Raw input: the devices a program registers for, and the WM_INPUT they bring.
 *
 * A program names the top-level collections it wants by HID usage -- the mouse
 * and the keyboard are the two a program of this era asks for -- and is then
 * posted WM_INPUT for every movement, button and key of them, its lParam a
 * handle GetRawInputData reads the report through. The report is the device's
 * own motion, not where the pointer went, so only the input layer can say what
 * it was: it hands each event to `deliver`, and this decides who is told.
 */

import { readU32, writeU32s } from './structs.js';

const WM_INPUT = 0x00ff;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;

/** A RAWINPUTDEVICE, and the RAWINPUTHEADER every report starts with. */
const RAWINPUTDEVICE_SIZE = 12;
const RAWINPUTHEADER_SIZE = 16;
/** RAWINPUT for each device: the header and a RAWMOUSE or a RAWKEYBOARD. */
const RAWINPUT_MOUSE_SIZE = RAWINPUTHEADER_SIZE + 24;
const RAWINPUT_KEYBOARD_SIZE = RAWINPUTHEADER_SIZE + 16;

const RIDEV_REMOVE = 0x00000001;
/** The four modes the second nibble holds: it is a number, not four bits. */
const RIDEV_MODE_MASK = 0x000000f0;
const RIDEV_EXCLUDE = 0x00000010;
const RIDEV_PAGEONLY = 0x00000020;
const RIDEV_NOLEGACY = 0x00000030;
const RIDEV_INPUTSINK = 0x00000100;
const RIDEV_EXINPUTSINK = 0x00001000;

const RID_INPUT = 0x10000003;
const RID_HEADER = 0x10000005;
const RIM_INPUT = 0;
const RIM_INPUTSINK = 1;
const RIM_TYPEMOUSE = 0;
const RIM_TYPEKEYBOARD = 1;
const RI_KEY_BREAK = 0x0001;
const RI_KEY_E0 = 0x0002;
const RI_MOUSE_WHEEL = 0x0400;

/** The generic desktop page, and the two collections on it the input layer feeds. */
const HID_USAGE_PAGE_GENERIC = 0x01;
const HID_USAGE_GENERIC_MOUSE = 0x02;
const HID_USAGE_GENERIC_KEYBOARD = 0x06;

/** A button's RI_MOUSE_ transitions, down then up, by the input layer's name for it. */
const BUTTON_FLAGS = Object.freeze({
    left: [0x0001, 0x0002], right: [0x0004, 0x0008], middle: [0x0010, 0x0020],
    x1: [0x0040, 0x0080], x2: [0x0100, 0x0200],
});

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const FAILED = 0xffffffff;

/**
 * How many reports are kept for GetRawInputData. A report is read while its
 * WM_INPUT is handled; one this many inputs old belongs to a message nobody
 * is handling any more.
 */
const KEPT_REPORTS = 256;
/** The first handle a report is given, away from zero and the small numbers. */
const FIRST_REPORT = 0x00010000;

/**
 * One event of a device, as the input layer hands it over.
 *
 * @typedef {Object} RawInputEvent
 * @property {'mouse' | 'key'} device
 * @property {number} [dx]      For the mouse: relative motion, in its counts.
 * @property {number} [dy]
 * @property {'left' | 'right' | 'middle' | 'x1' | 'x2'} [button]
 *           For the mouse: a button that went down or up.
 * @property {number} [wheel]   For the mouse: the wheel's signed delta, 120 a notch.
 * @property {boolean} [down]   A button's or a key's direction.
 * @property {number} [scan]    For a key: its make code, without the E0 prefix.
 * @property {boolean} [extended] For a key: whether it sends the E0 prefix.
 * @property {number} [vk]      For a key: its virtual key.
 * @property {number} [message] For a key: the message it was, when not
 *           WM_KEYDOWN or WM_KEYUP -- a key held with Alt is WM_SYSKEYDOWN.
 */

/**
 * @param {Object} options
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void,
 *     queue: { post: (message: { hwnd: number, message: number, wParam: number,
 *         lParam: number }) => void,
 *         peek?: (filter: import('./messages.js').MessageFilter) => { lParam: number } | null },
 *     setLastError?: (code: number) => void,
 *     divergence?: (api: string, detail: string) => void }} options.host
 * @param {(hwnd: number) => boolean} options.isWindow
 * @param {() => number} options.focus
 *        Where input with no window named goes: the keyboard focus, or the
 *        active window when nothing has it.
 * @param {(hwnd: number) => boolean} options.foreground
 *        Whether a window's top-level window is the active one.
 */
export function createRawInput({ host, isWindow, focus, foreground }){
    /**
     * What is registered, by `page:usage`. A PAGEONLY registration is kept
     * under usage 0, which is what it names.
     *
     * @type {Map<string, { page: number, usage: number, flags: number, hwnd: number }>}
     */
    const registered = new Map();
    /** @type {Map<number, Uint8Array>} */
    const reports = new Map();
    let nextReport = FIRST_REPORT;

    /** @param {number} code */
    const fail = code=>{
        host.setLastError?.(code);
        return FAILED;
    };

    /**
     * The registration a collection's input goes by: its own, unless it is
     * excluded, and otherwise its page's.
     *
     * @param {number} page @param {number} usage
     */
    const registrationFor = (page, usage)=>{
        const own = registered.get(`${page}:${usage}`);
        if (own)
        {
            return (own.flags & RIDEV_MODE_MASK) === RIDEV_EXCLUDE ? null : own;
        }
        const whole = registered.get(`${page}:0`);
        return whole && (whole.flags & RIDEV_MODE_MASK) === RIDEV_PAGEONLY ? whole : null;
    };

    /** @param {Uint8Array} bytes */
    const keep = bytes=>{
        const handle = nextReport;
        nextReport = nextReport >= 0x7fff0000 ? FIRST_REPORT : nextReport + 4;
        reports.set(handle, bytes);
        if (reports.size > KEPT_REPORTS)
        {
            reports.delete(reports.keys().next().value ?? 0);
        }
        return handle;
    };

    /**
     * A RAWINPUT: the header, then the device's own structure. hDevice is 0,
     * as for input a program injects: no device handles are enumerated here.
     *
     * @param {number} type @param {number} size @param {number} wParam
     */
    const report = (type, size, wParam)=>{
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, type, true);
        view.setUint32(4, size, true);
        view.setUint32(12, wParam, true);
        return { bytes, view };
    };

    /** @param {RawInputEvent} event @param {number} wParam */
    const mouseReport = (event, wParam)=>{
        const { bytes, view } = report(RIM_TYPEMOUSE, RAWINPUT_MOUSE_SIZE, wParam);
        const at = RAWINPUTHEADER_SIZE;
        let buttons = 0;
        const transitions = event.button ? BUTTON_FLAGS[event.button] : undefined;
        if (transitions)
        {
            buttons |= transitions[event.down ? 0 : 1];
        }
        if (event.wheel)
        {
            buttons |= RI_MOUSE_WHEEL;
            view.setInt16(at + 6, event.wheel, true);
        }
        // usFlags 0 is MOUSE_MOVE_RELATIVE: lLastX and lLastY are motion.
        view.setUint16(at + 4, buttons, true);
        view.setInt32(at + 12, (event.dx ?? 0) | 0, true);
        view.setInt32(at + 16, (event.dy ?? 0) | 0, true);
        return bytes;
    };

    /** @param {RawInputEvent} event @param {number} wParam */
    const keyboardReport = (event, wParam)=>{
        const { bytes, view } = report(RIM_TYPEKEYBOARD, RAWINPUT_KEYBOARD_SIZE, wParam);
        const at = RAWINPUTHEADER_SIZE;
        view.setUint16(at, (event.scan ?? 0) & 0xffff, true);
        view.setUint16(at + 2, (event.down ? 0 : RI_KEY_BREAK)
            | (event.extended ? RI_KEY_E0 : 0), true);
        view.setUint16(at + 6, (event.vk ?? 0) & 0xffff, true);
        view.setUint32(at + 8, event.message ?? (event.down ? WM_KEYDOWN : WM_KEYUP), true);
        return bytes;
    };

    /**
     * Posts WM_INPUT for one device event to whoever registered for it: the
     * window it named, or the focus. A window whose top-level window is not
     * the active one hears it only if it registered as a sink.
     *
     * @param {RawInputEvent} event
     */
    const deliver = event=>{
        const mouse = event.device === 'mouse';
        const registration = registrationFor(HID_USAGE_PAGE_GENERIC,
            mouse ? HID_USAGE_GENERIC_MOUSE : HID_USAGE_GENERIC_KEYBOARD);
        if (!registration)
        {
            return;
        }
        const hwnd = registration.hwnd !== 0 ? registration.hwnd : focus();
        if (hwnd === 0 || !isWindow(hwnd))
        {
            return;
        }
        const inFront = foreground(hwnd);
        if (!inFront && (registration.flags & (RIDEV_INPUTSINK | RIDEV_EXINPUTSINK)) === 0)
        {
            return;
        }
        const wParam = inFront ? RIM_INPUT : RIM_INPUTSINK;
        const bytes = mouse ? mouseReport(event, wParam) : keyboardReport(event, wParam);
        host.queue.post({ hwnd, message: WM_INPUT, wParam, lParam: keep(bytes) });
    };

    /**
     * Checks every device before registering any: a call with one bad entry
     * changes nothing.
     *
     * @param {number} array @param {number} count
     */
    const register = (array, count)=>{
        const devices = [];
        for (let index = 0; index < count; index++)
        {
            const at = array + index * RAWINPUTDEVICE_SIZE;
            const pair = readU32(host, at);
            const device = { page: pair & 0xffff, usage: pair >>> 16,
                flags: readU32(host, at + 4), hwnd: readU32(host, at + 8) };
            const removing = (device.flags & RIDEV_REMOVE) !== 0;
            const sink = (device.flags & (RIDEV_INPUTSINK | RIDEV_EXINPUTSINK)) !== 0;
            const pageOnly = (device.flags & RIDEV_MODE_MASK) === RIDEV_PAGEONLY;
            if ((removing && device.hwnd !== 0) || (sink && device.hwnd === 0)
                || (pageOnly && device.usage !== 0))
            {
                host.setLastError?.(ERROR_INVALID_PARAMETER);
                return 0;
            }
            devices.push(device);
        }
        for (const device of devices)
        {
            const key = `${device.page}:${device.usage}`;
            if ((device.flags & RIDEV_REMOVE) !== 0)
            {
                registered.delete(key);
                continue;
            }
            registered.set(key, device);
            if ((device.flags & RIDEV_MODE_MASK) === RIDEV_NOLEGACY)
            {
                host.divergence?.('RegisterRawInputDevices',
                    'RIDEV_NOLEGACY: the legacy mouse and keyboard messages are still posted');
            }
        }
        return 1;
    };

    const table = {
        /**
         * BOOL RegisterRawInputDevices(PCRAWINPUTDEVICE pRawInputDevices,
         *   UINT uiNumDevices, UINT cbSize)
         *
         * A registration replaces the one its collection had, RIDEV_REMOVE
         * takes it away and must name no window, and a sink must name one.
         */
        RegisterRawInputDevices: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([array, count, size])=>{
                if ((array >>> 0) === 0 || (count >>> 0) === 0
                    || (size >>> 0) !== RAWINPUTDEVICE_SIZE)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return register(array >>> 0, count >>> 0);
            },
        },

        /**
         * UINT GetRegisteredRawInputDevices(PRAWINPUTDEVICE pRawInputDevices,
         *   PUINT puiNumDevices, UINT cbSize)
         *
         * The registrations, ordered by page and usage: a null buffer is told
         * how many there are, a buffer too small is told so and how many.
         */
        GetRegisteredRawInputDevices: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([array, countAt, size])=>{
                if ((countAt >>> 0) === 0 || (size >>> 0) !== RAWINPUTDEVICE_SIZE)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const devices = [...registered.values()]
                    .sort((one, two)=>one.page - two.page || one.usage - two.usage);
                if ((array >>> 0) === 0)
                {
                    writeU32s(host, countAt, [devices.length]);
                    return 0;
                }
                const room = readU32(host, countAt);
                if (room === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (room < devices.length)
                {
                    writeU32s(host, countAt, [devices.length]);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                devices.forEach((device, index)=>writeU32s(host,
                    (array >>> 0) + index * RAWINPUTDEVICE_SIZE,
                    [(device.usage << 16 | device.page) >>> 0, device.flags, device.hwnd]));
                return devices.length;
            },
        },

        /**
         * LRESULT DefRawInputProc(PRAWINPUT *paRawInput, INT nInput, UINT cbSizeHeader)
         *
         * Nothing to do with the reports: 0, or -1 for a header size that is
         * not a RAWINPUTHEADER's; the last error is left alone (input.c
         * test_DefRawInputProc).
         */
        DefRawInputProc: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , headerSize])=>((headerSize >>> 0) === RAWINPUTHEADER_SIZE ? 0 : FAILED),
        },

        /**
         * UINT GetRawInputBuffer(PRAWINPUT pData, PUINT pcbSize, UINT cbSizeHeader)
         *
         * The reports whose WM_INPUT are still queued, taken off the queue
         * in the order they came and laid end to end as many as fit; a null
         * buffer is told the size of the first. One that does not fit even
         * alone is ERROR_INSUFFICIENT_BUFFER, with the size it needs.
         */
        GetRawInputBuffer: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([data, sizeAt, headerSize])=>{
                if ((sizeAt >>> 0) === 0 || (headerSize >>> 0) !== RAWINPUTHEADER_SIZE)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                /** @param {boolean} remove */
                const next = remove=>host.queue.peek?.({ hwnd: null, first: WM_INPUT,
                    last: WM_INPUT, remove }) ?? null;
                const waiting = next(false);
                const first = waiting ? reports.get(waiting.lParam >>> 0) : undefined;
                if ((data >>> 0) === 0)
                {
                    writeU32s(host, sizeAt >>> 0, [first ? first.length : 0]);
                    return 0;
                }
                const room = readU32(host, sizeAt >>> 0);
                if (!first)
                {
                    writeU32s(host, sizeAt >>> 0, [0]);
                    return 0;
                }
                if (first.length > room)
                {
                    writeU32s(host, sizeAt >>> 0, [first.length]);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                let used = 0;
                let count = 0;
                for (let entry = waiting; entry; entry = next(false))
                {
                    const bytes = reports.get(entry.lParam >>> 0);
                    if (!bytes || used + bytes.length > room)
                    {
                        break;
                    }
                    next(true);
                    host.writeMemory((data >>> 0) + used, bytes);
                    used += bytes.length;
                    count++;
                }
                return count;
            },
        },

        /**
         * UINT GetRawInputData(HRAWINPUT hRawInput, UINT uiCommand, LPVOID pData,
         *   PUINT pcbSize, UINT cbSizeHeader)
         *
         * The report a WM_INPUT's lParam names, whole or its header alone; a
         * null buffer is told the size the report needs.
         */
        GetRawInputData: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, command, data, sizeAt, headerSize])=>{
                const bytes = reports.get(handle >>> 0);
                if (!bytes)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const whole = (command >>> 0) === RID_INPUT;
                if ((headerSize >>> 0) !== RAWINPUTHEADER_SIZE || (sizeAt >>> 0) === 0
                    || (!whole && (command >>> 0) !== RID_HEADER))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const size = whole ? bytes.length : RAWINPUTHEADER_SIZE;
                if ((data >>> 0) === 0)
                {
                    writeU32s(host, sizeAt, [size]);
                    return 0;
                }
                if (readU32(host, sizeAt) < size)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(data >>> 0, bytes.subarray(0, size));
                return size;
            },
        },
    };

    return { table, deliver };
}

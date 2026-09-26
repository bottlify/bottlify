/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a DirectInput device is, without any of the COM around it.
 *
 * DirectInput does not deliver messages. A program acquires a device and then
 * either asks it for its whole state or drains a queue of the changes since it
 * last asked, and which of the two it gets depends on a property it set
 * beforehand. Both readings come from the same events, so both live here.
 *
 * Three things about the model are not obvious and are each a bug if guessed:
 *
 * - **A mouse's axes are deltas and are consumed by reading.** `GetDeviceState`
 *   reports the movement since the previous call, not a position. Reporting a
 *   position makes the view spin to a corner and stay there; not clearing the
 *   delta makes it spin for ever.
 * - **The buffer is a ring with a stated size, and overflow is reportable.** A
 *   program sets DIPROP_BUFFERSIZE and is entitled to be told when it did not
 *   drain in time, because that is how it knows to resynchronise from the
 *   device state rather than trusting the events it did get.
 * - **An unacquired device answers DIERR_NOTACQUIRED, not zeroes.** A program
 *   that lost the device re-acquires on that error; one that reads zeroes
 *   believes the player let go of everything and carries on.
 */

import { KNOWN_KEYS, keyFor, dikOf, characterOf } from '../../win32/user32/keys.js';

/** Which device this is. Both are the identity a program creates by GUID. */
export const KEYBOARD = 'keyboard';
export const MOUSE = 'mouse';

/** How many keys the keyboard state array covers, one byte each. */
export const KEYBOARD_KEYS = 256;

/** The high bit of a key's byte is "down"; the rest is undefined and zero. */
export const KEY_DOWN = 0x80;

/** DIDEVICEOBJECTDATA offsets a buffered read is reported through. */
export const DIMOUSE_OFS = Object.freeze({
    X: 0x00,
    Y: 0x04,
    Z: 0x08,
    BUTTON0: 0x0c,
});

/** How many buttons the mouse has: DIMOUSESTATE2's eight. */
export const MOUSE_BUTTONS = 8;

/** A buffer size of zero means the device is not buffered at all. */
const UNBUFFERED = 0;

/** DIDFT_* object types: the byte of an object's type below its instance number. */
const DIDFT = Object.freeze({
    RELAXIS: 0x01,
    PSHBUTTON: 0x04,
});
const DIDOI_ASPECTPOSITION = 0x00000100;

const GUID_XAxis = '{A36D02E0-C9F3-11CF-BFC7-444553540000}';
const GUID_YAxis = '{A36D02E1-C9F3-11CF-BFC7-444553540000}';
const GUID_ZAxis = '{A36D02E2-C9F3-11CF-BFC7-444553540000}';
const GUID_Button = '{A36D02F0-C9F3-11CF-BFC7-444553540000}';
const GUID_Key = '{55728220-D33C-11CF-BFC7-444553540000}';

/**
 * What a key that types nothing is called, by DIK code, on the one US layout
 * this build has. A key that types a character is called by that character.
 *
 * @type {ReadonlyMap<number, string>}
 */
const KEY_NAMES = new Map(/** @type {[number, string][]} */ ([
    [0x01, 'Esc'], [0x0e, 'Backspace'], [0x0f, 'Tab'], [0x1c, 'Enter'], [0x1d, 'Ctrl'],
    [0x2a, 'Shift'], [0x36, 'Right Shift'], [0x37, 'Num *'], [0x38, 'Alt'],
    [0x39, 'Space'], [0x3a, 'Caps Lock'],
    [0x3b, 'F1'], [0x3c, 'F2'], [0x3d, 'F3'], [0x3e, 'F4'], [0x3f, 'F5'], [0x40, 'F6'],
    [0x41, 'F7'], [0x42, 'F8'], [0x43, 'F9'], [0x44, 'F10'], [0x57, 'F11'], [0x58, 'F12'],
    [0x45, 'Num Lock'], [0x46, 'Scroll Lock'],
    [0x47, 'Num 7'], [0x48, 'Num 8'], [0x49, 'Num 9'], [0x4a, 'Num -'],
    [0x4b, 'Num 4'], [0x4c, 'Num 5'], [0x4d, 'Num 6'], [0x4e, 'Num +'],
    [0x4f, 'Num 1'], [0x50, 'Num 2'], [0x51, 'Num 3'], [0x52, 'Num 0'], [0x53, 'Num Del'],
    [0x56, '\\'],
    [0x9c, 'Num Enter'], [0x9d, 'Right Ctrl'], [0xb5, 'Num /'], [0xb7, 'Prnt Scrn'],
    [0xb8, 'Right Alt'], [0xc5, 'Pause'], [0xc7, 'Home'], [0xc8, 'Up'], [0xc9, 'Page Up'],
    [0xcb, 'Left'], [0xcd, 'Right'], [0xcf, 'End'], [0xd0, 'Down'], [0xd1, 'Page Down'],
    [0xd2, 'Insert'], [0xd3, 'Delete'], [0xdb, 'Left Windows'], [0xdc, 'Right Windows'],
    [0xdd, 'Application'],
]));

/**
 * One object of a device -- an axis or a button -- as DirectInput describes
 * it to EnumObjects and GetObjectInfo.
 *
 * @typedef {Object} DeviceObject
 * @property {string} guidType
 * @property {number} offset  Where its value sits in the device's data format.
 * @property {number} type    DIDFT_* with the instance number above it.
 * @property {number} flags   DIDOI_*.
 * @property {string} name
 */

/**
 * The mouse's three axes and its buttons, at their DIMOUSESTATE2 offsets,
 * numbered in that order.
 *
 * @type {readonly DeviceObject[]}
 */
const MOUSE_OBJECTS = Object.freeze([
    ...[[GUID_XAxis, 'X-axis'], [GUID_YAxis, 'Y-axis'], [GUID_ZAxis, 'Wheel']]
        .map(([guidType, name], index)=>({
            guidType,
            offset: index * 4,
            type: DIDFT.RELAXIS | index << 8,
            flags: DIDOI_ASPECTPOSITION,
            name,
        })),
    ...Array.from({ length: MOUSE_BUTTONS }, (_, index)=>({
        guidType: GUID_Button,
        offset: DIMOUSE_OFS.BUTTON0 + index,
        type: DIDFT.PSHBUTTON | 3 + index << 8,
        flags: 0,
        name: `Button ${index}`,
    })),
]);

/**
 * One button per key a host can press, in DIK order. A key's offset in
 * c_dfDIKeyboard and its instance number are both its DIK code.
 *
 * @type {readonly DeviceObject[]}
 */
const KEYBOARD_OBJECTS = Object.freeze(KNOWN_KEYS
    .map(code=>/** @type {import('../../win32/user32/keys.js').KeyMapping} */ (keyFor(code)))
    .map(mapping=>{
        const dik = dikOf(mapping);
        const typed = characterOf(mapping.vk);
        return {
            guidType: GUID_Key,
            offset: dik,
            type: DIDFT.PSHBUTTON | dik << 8,
            flags: 0,
            name: KEY_NAMES.get(dik)
                ?? (typed === null ? '' : String.fromCharCode(typed).toUpperCase()),
        };
    })
    .sort((a, b)=>a.offset - b.offset));

/**
 * What a device of this kind is made of.
 *
 * @param {'keyboard' | 'mouse'} kind
 * @returns {readonly DeviceObject[]}
 */
export function objectsOf(kind){
    return kind === KEYBOARD ? KEYBOARD_OBJECTS : MOUSE_OBJECTS;
}

/**
 * @typedef {Object} InputEvent
 * @property {'key' | 'mouseMove' | 'mouseWheel' | 'mouseButton'} kind
 * @property {number} [code]     A DIK scan code, or a button index.
 * @property {boolean} [down]
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [wheel]
 */

/**
 * One device.
 *
 * @param {Object} options
 * @param {'keyboard' | 'mouse'} options.kind
 * @param {() => number} options.now  The guest's clock, for event timestamps.
 */
export function createInputDevice({ kind, now }){
    const keys = new Uint8Array(KEYBOARD_KEYS);
    const buttons = new Uint8Array(MOUSE_BUTTONS);
    let deltaX = 0;
    let deltaY = 0;
    let deltaWheel = 0;

    let acquired = false;
    let bufferSize = UNBUFFERED;
    /** @type {{ offset: number, data: number, time: number, sequence: number }[]} */
    let queue = [];
    let overflowed = false;
    let sequence = 0;
    let notifyEvent = 0;
    /** Whether the cooperative level asked for DISCL_EXCLUSIVE. */
    let exclusive = false;
    let references = 1;
    /** What SetDataFormat settled on, and zero until it is called. */
    let dataSize = 0;

    /** @param {number} offset @param {number} data */
    const record = (offset, data)=>{
        if (bufferSize === UNBUFFERED)
        {
            return;
        }
        queue.push({ offset, data, time: now(), sequence: sequence++ });
        // A buffer of N holds N - 1 -- one of one holds nothing and only
        // reports that it overflowed, as Windows does in Wine's joystick8.c.
        if (queue.length > bufferSize - 1)
        {
            // The oldest goes, not the newest: a program draining a ring reads
            // the most recent events, and dropping those instead would make an
            // overflow look like the player stopped moving. joystick8.c's
            // first read after an overflow is the oldest of the newer events.
            queue.shift();
            overflowed = true;
        }
    };

    /** @param {InputEvent} event */
    const apply = event=>{
        switch (event.kind){
            case 'key': {
                const code = (event.code ?? 0) & 0xff;
                const value = event.down ? KEY_DOWN : 0;
                if (keys[code] === value)
                {
                    // A key repeat is not a state change, and queueing one
                    // fills the ring with events a program has already seen.
                    return;
                }
                keys[code] = value;
                record(code, value);
                break;
            }
            case 'mouseMove':
                deltaX += event.x ?? 0;
                deltaY += event.y ?? 0;
                if ((event.x ?? 0) !== 0)
                {
                    record(DIMOUSE_OFS.X, event.x ?? 0);
                }
                if ((event.y ?? 0) !== 0)
                {
                    record(DIMOUSE_OFS.Y, event.y ?? 0);
                }
                break;
            case 'mouseWheel':
                deltaWheel += event.wheel ?? 0;
                record(DIMOUSE_OFS.Z, event.wheel ?? 0);
                break;
            case 'mouseButton': {
                const index = (event.code ?? 0) & 7;
                const value = event.down ? KEY_DOWN : 0;
                if (buttons[index] === value)
                {
                    return;
                }
                buttons[index] = value;
                record(DIMOUSE_OFS.BUTTON0 + index, value);
                break;
            }
        }
    };

    return {
        get kind(){
            return kind;
        },
        get acquired(){
            return acquired;
        },
        get bufferSize(){
            return bufferSize;
        },
        get exclusive(){
            return exclusive;
        },
        /** @param {boolean} value */
        setExclusive(value){
            exclusive = value;
        },
        get notifyEvent(){
            return notifyEvent;
        },
        get dataSize(){
            return dataSize;
        },
        /** @param {number} size */
        setDataSize(size){
            dataSize = size >>> 0;
        },
        get queued(){
            return queue.length;
        },

        addRef: ()=>++references,
        release: ()=>Math.max(0, --references),

        acquire(){
            acquired = true;
        },
        unacquire(){
            acquired = false;
            // What happened while nobody was listening is not a program's to
            // read when it comes back: it re-reads the state instead.
            queue = [];
            overflowed = false;
            deltaX = 0;
            deltaY = 0;
            deltaWheel = 0;
        },

        /** @param {number} size */
        setBufferSize(size){
            bufferSize = size >>> 0;
            queue = [];
            overflowed = false;
        },

        /** @param {number} handle */
        setNotification(handle){
            notifyEvent = handle >>> 0;
        },

        /**
         * Feeds one event in. Events arriving while unacquired are dropped
         * rather than stored: a program that has released the device gets the
         * state it finds when it takes it back, not a backlog.
         *
         * @param {InputEvent} event
         */
        post(event){
            if (!acquired)
            {
                return false;
            }
            apply(event);
            return true;
        },

        /**
         * The keyboard's whole state, as bytes. A copy, because the array is
         * written into guest memory and then keeps changing here.
         */
        keyboardState(){
            return keys.slice();
        },

        /**
         * The mouse's state: three axes and the buttons.
         *
         * Reading clears the axes, which is the part that is easy to leave out
         * -- they are what has happened since the last read, not where anything
         * is. The buttons are levels and stay.
         *
         * @returns {{ x: number, y: number, wheel: number, buttons: Uint8Array }}
         */
        mouseState(){
            const state = {
                x: deltaX, y: deltaY, wheel: deltaWheel, buttons: buttons.slice(),
            };
            deltaX = 0;
            deltaY = 0;
            deltaWheel = 0;
            return state;
        },

        /**
         * Up to `count` buffered events, oldest first.
         *
         * @param {number} count
         * @param {boolean} peek  DIGDD_PEEK: look without consuming.
         * @returns {{ events: any[], overflow: boolean }}
         */
        drain(count, peek = false){
            const events = queue.slice(0, Math.min(count, queue.length));
            const overflow = overflowed;
            if (!peek)
            {
                queue = queue.slice(events.length);
            }
            // Reported once and cleared, by a peek as well. A program
            // resynchronises from the device state when it hears this; hearing
            // it again on every later call would make it resynchronise for
            // ever.
            overflowed = false;
            return { events, overflow };
        },
    };
}

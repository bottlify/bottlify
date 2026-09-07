/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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

/** A buffer size of zero means the device is not buffered at all. */
const UNBUFFERED = 0;

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
    const buttons = new Uint8Array(8);
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
        if (queue.length > bufferSize)
        {
            // The oldest goes, not the newest: a program draining a ring reads
            // the most recent events, and dropping those instead would make an
            // overflow look like the player stopped moving.
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
                // Reported once and cleared. A program resynchronises from the
                // device state when it hears this; hearing it again on every
                // later call would make it resynchronise for ever.
                overflowed = false;
            }
            return { events, overflow };
        },
    };
}

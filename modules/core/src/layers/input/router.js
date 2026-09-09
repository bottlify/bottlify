/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One event in, two programs' worth of input out.
 *
 * A Win32 program of this era reads input twice over and expects both readings
 * to describe the same world: the message queue tells it a key went down, and
 * DirectInput tells it the key is down, and a program commonly steers with one
 * and takes commands with the other. So there is exactly one place an event
 * arrives, and it feeds both -- because two entry points is how the two
 * readings drift apart.
 *
 * Nothing here knows what a browser is. What arrives is a normalised event
 * naming a physical key, a pointer motion, a button, a wheel notch or a change
 * of focus; where it came from -- a page, a test, a recorded session -- is the
 * caller's business. That is what makes the whole contract testable without a
 * browser, which is where its correctness is actually established.
 */

import { keyFor, dikOf } from './keys.js';

/** The messages this layer produces. */
export const WM = Object.freeze({
    ACTIVATE: 0x0006,
    SETFOCUS: 0x0007,
    KILLFOCUS: 0x0008,
    SETCURSOR: 0x0020,
    ACTIVATEAPP: 0x001c,
    KEYDOWN: 0x0100,
    KEYUP: 0x0101,
    CHAR: 0x0102,
    SYSKEYDOWN: 0x0104,
    SYSKEYUP: 0x0105,
    SYSCHAR: 0x0106,
    MOUSEMOVE: 0x0200,
    MOUSEWHEEL: 0x020a,
});

/** WM_ACTIVATE's low word. */
const WA_ACTIVE = 1;

/** The hit-test code WM_SETCURSOR reports for the client area. */
const HTCLIENT = 1;

/** The virtual keys this file has an opinion about. */
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_F10 = 0x79;

/** What a mouse message's wParam says is held. */
const MK = Object.freeze({
    LBUTTON: 0x0001,
    RBUTTON: 0x0002,
    SHIFT: 0x0004,
    CONTROL: 0x0008,
    MBUTTON: 0x0010,
    XBUTTON1: 0x0020,
    XBUTTON2: 0x0040,
});

/**
 * Buttons, named rather than numbered.
 *
 * A number would be three different numbers at once: a browser calls the middle
 * button 1, a mouse message pairs it with 0x0207, and DirectInput puts it at
 * index 2. Naming the button is what keeps a caller from having to know which
 * of the three it is holding.
 *
 * @type {Readonly<Record<string, readonly [number, number, number, number, number]>>}
 */
const BUTTONS = Object.freeze({
    // down message, up message, wParam bit, DirectInput index, XBUTTON id
    left: [0x0201, 0x0202, MK.LBUTTON, 0, 0],
    right: [0x0204, 0x0205, MK.RBUTTON, 1, 0],
    middle: [0x0207, 0x0208, MK.MBUTTON, 2, 0],
    x1: [0x020b, 0x020c, MK.XBUTTON1, 3, 1],
    x2: [0x020b, 0x020c, MK.XBUTTON2, 4, 2],
});

/**
 * @typedef {Object} HostInputEvent
 * @property {'key' | 'text' | 'pointerMove' | 'pointerButton' | 'wheel' | 'focus'
 *           | 'padAxis' | 'padButton'} kind
 * @property {string} [code]     For `key`: a `KeyboardEvent.code`.
 * @property {boolean} [down]    For `key`, `pointerButton` and `padButton`.
 * @property {string} [text]     For `text`: the character the browser composed.
 * @property {number} [x]        For `pointerMove`: client coordinates.
 * @property {number} [y]
 * @property {number} [dx]       For `pointerMove`: relative motion, if known.
 * @property {number} [dy]
 * @property {string} [button]   For `pointerButton`: a key of BUTTONS.
 * @property {number} [delta]    For `wheel`: signed multiples of WHEEL_DELTA.
 * @property {boolean} [gained]  For `focus`.
 * @property {number} [axis]     For `padAxis` and `padButton`.
 * @property {number} [value]
 * @property {number} [index]    For `padButton`.
 */

/**
 * @typedef {Object} RouterDeps
 * @property {(message: {
 *     hwnd: number, message: number, wParam: number, lParam: number,
 *     time: number, x: number, y: number }) => void} post
 *     Where a window message goes: the thread's message queue.
 * @property {(event: import('./dinput/devices.js').InputEvent) => unknown} device
 *     Where the DirectInput reading goes.
 * @property {(character: number, lParam: number) => void} [compose]
 *     Where a character the host's layout produced is left for the
 *     TranslateMessage that will turn it into a WM_CHAR. Absent in a build with
 *     no message queue, where there is nothing to translate it for.
 * @property {() => number} [now]     The guest's clock, for a message's time.
 * @property {() => number} [target]  The window input is for.
 * @property {(() => { width: number, height: number }) | null} [bounds]
 *     The client area the cursor is confined to, when the caller knows it.
 */

/**
 * @param {RouterDeps} deps
 */
export function createInputRouter({ post, device, now, target, bounds = null, compose }){
    const clock = now ?? (()=>0);
    const targetWindow = target ?? (()=>0);
    const composeCharacter = compose ?? (()=>{});

    /** Virtual keys that are down. Indexed by VK, both the paired and the sided. */
    const keys = new Uint8Array(256);
    /** @type {Map<string, import('./keys.js').KeyMapping>} */
    const held = new Map();
    /** @type {Set<string>} */
    const pressed = new Set();
    const cursor = { x: 0, y: 0 };
    /** @type {number[]} */
    const padAxes = [];
    /** @type {number[]} */
    const padButtons = [];

    /**
     * The lParam of the key that is producing characters right now.
     *
     * WM_CHAR carries the lParam of the key press it came from, and the press
     * and the character arrive here separately -- the character is composed by
     * the keyboard layout, which is the host's, not ours.
     */
    let lastKeyLParam = 0;
    /**
     * Whether the program is owed a WM_SETCURSOR. Windows *sends* one on every
     * mouse move; this queue only posts, and posting one per move would double
     * the traffic of the busiest message there is. So it is posted when the
     * answer could have changed -- focus arriving, a button going either way --
     * which is where a program that sets its own cursor sets it.
     */
    let cursorDirty = true;
    /**
     * Whether the program has been told it is the active application. Once, and
     * never taken back: see `focus` below.
     */
    let activated = false;
    let posted = 0;
    let dropped = 0;

    /** @param {number} message @param {number} wParam @param {number} lParam */
    const emit = (message, wParam, lParam)=>{
        post({
            hwnd: targetWindow() >>> 0,
            message,
            wParam: wParam >>> 0,
            lParam: lParam >>> 0,
            time: clock() >>> 0,
            x: cursor.x,
            y: cursor.y,
        });
        posted++;
    };

    /** Client coordinates, as a mouse message packs them. */
    const point = ()=>((cursor.y & 0xffff) << 16 | cursor.x & 0xffff) >>> 0;

    /** What is held, as a mouse message's wParam reports it. */
    const mask = ()=>{
        let bits = keys[VK_SHIFT] ? MK.SHIFT : 0;
        bits |= keys[VK_CONTROL] ? MK.CONTROL : 0;
        for (const name of pressed)
        {
            bits |= BUTTONS[name][2];
        }
        return bits;
    };

    /** @param {number} message  The mouse message this cursor question precedes. */
    const announceCursor = message=>{
        if (!cursorDirty)
        {
            return;
        }
        cursorDirty = false;
        emit(WM.SETCURSOR, targetWindow(), (message & 0xffff) << 16 | HTCLIENT);
    };

    /** @param {HostInputEvent} event */
    const key = event=>{
        const mapping = keyFor(event.code ?? '');
        if (!mapping)
        {
            dropped++;
            return false;
        }

        const wasDown = held.has(event.code ?? '');
        const altBefore = keys[VK_MENU] !== 0;
        if (event.down)
        {
            held.set(String(event.code), mapping);
            keys[mapping.vk] = 1;
            keys[mapping.vkSide] = 1;
        }
        else
        {
            held.delete(String(event.code));
            keys[mapping.vkSide] = 0;
            // A modifier is two keys and one virtual key: letting go of the
            // left shift while the right is down does not mean shift is up.
            keys[mapping.vk] = [...held.values()].some(other=>other.vk === mapping.vk) ? 1 : 0;
        }

        // ALT decides which of the two pairs of messages this is; F10 is a
        // system key on its own, which is how a menu opens without one. What
        // ALT does not decide is the context bit, which reports whether it is
        // down *now* -- so releasing ALT is a system message with the bit clear.
        const system = altBefore || mapping.vk === VK_MENU || mapping.vk === VK_F10;
        const lParam = (1
            | (mapping.scan & 0xff) << 16
            | (mapping.extended ? 1 << 24 : 0)
            | (system && keys[VK_MENU] !== 0 ? 1 << 29 : 0)
            // A key that is going up was down, whether or not this router saw
            // it happen: a program reading the transition off a key-up whose
            // previous-state bit is clear concludes the key never went down.
            | (!event.down || wasDown ? 1 << 30 : 0)
            | (event.down ? 0 : 1 << 31)) >>> 0;

        if (event.down)
        {
            lastKeyLParam = lParam;
        }
        const messages = event.down
            ? [WM.KEYDOWN, WM.SYSKEYDOWN]
            : [WM.KEYUP, WM.SYSKEYUP];
        emit(messages[system ? 1 : 0], mapping.vk, lParam);
        device({ kind: 'key', code: dikOf(mapping), down: event.down === true });
        return true;
    };

    /** @param {HostInputEvent} event */
    const text = event=>{
        const string = event.text ?? '';
        for (let index = 0; index < string.length; index++)
        {
            // Handed over, not posted. Windows makes a WM_CHAR inside
            // TranslateMessage and nowhere else, so a program that calls it
            // sees exactly one and a program that does not sees none. Posting
            // here as well gave every keystroke twice: once from the host's
            // layout and once from TranslateMessage's own table.
            //
            // One per code unit, which is what a surrogate pair produces on
            // Windows too -- the program reassembles it, if it cares.
            composeCharacter(string.charCodeAt(index), lastKeyLParam);
        }
        return string.length > 0;
    };

    /** @param {number} value @param {number} limit */
    const confine = (value, limit)=>Math.max(0, Math.min(limit - 1, value));

    /** @param {HostInputEvent} event */
    const move = event=>{
        const box = bounds?.() ?? null;
        // Relative motion is what DirectInput reports and absolute is what a
        // message carries, and a host knows one, the other, or both: a locked
        // pointer has no position, a touch has no delta. Whichever is missing
        // is derived from the one that is not.
        const dx = event.dx ?? (event.x === undefined ? 0 : (event.x | 0) - cursor.x);
        const dy = event.dy ?? (event.y === undefined ? 0 : (event.y | 0) - cursor.y);
        const x = event.x === undefined ? cursor.x + dx : event.x | 0;
        const y = event.y === undefined ? cursor.y + dy : event.y | 0;
        const moved = x !== cursor.x || y !== cursor.y;
        cursor.x = box ? confine(x, box.width) : x;
        cursor.y = box ? confine(y, box.height) : y;

        if (moved)
        {
            announceCursor(WM.MOUSEMOVE);
            emit(WM.MOUSEMOVE, mask(), point());
        }
        if (dx !== 0 || dy !== 0)
        {
            device({ kind: 'mouseMove', x: dx, y: dy });
        }
        return true;
    };

    /** @param {HostInputEvent} event */
    const button = event=>{
        const entry = BUTTONS[event.button ?? ''];
        if (!entry)
        {
            dropped++;
            return false;
        }
        const [downMessage, upMessage, , index, extra] = entry;
        if (event.down)
        {
            pressed.add(String(event.button));
        }
        else
        {
            pressed.delete(String(event.button));
        }

        const message = event.down ? downMessage : upMessage;
        // A button is the moment a program is most likely to want a different
        // cursor, so the question is always asked again here.
        cursorDirty = true;
        announceCursor(message);
        emit(message, extra << 16 | mask(), point());
        device({ kind: 'mouseButton', code: index, down: event.down === true });
        return true;
    };

    /** @param {HostInputEvent} event */
    const wheel = event=>{
        const delta = (event.delta ?? 0) | 0;
        if (delta === 0)
        {
            return false;
        }
        // WM_MOUSEWHEEL's lParam is in screen coordinates rather than client
        // ones. There is no desktop for a window to sit somewhere on, so the
        // two spaces are the same space, and this will need the window's own
        // origin the moment one is not at zero.
        emit(WM.MOUSEWHEEL, (delta & 0xffff) << 16 | mask(), point());
        device({ kind: 'mouseWheel', wheel: delta });
        return true;
    };

    /**
     * The page's focus, which is a page concern and almost never the program's.
     *
     * What focus legitimately decides is whether this element receives
     * keystrokes at all. It is not the program's window activation, and the two
     * are not even related: a person clicking a button beside the canvas takes
     * the focus away without anything happening to the program, and a browser
     * takes it away again for reasons of its own. Handing that through as
     * WM_ACTIVATEAPP and WM_KILLFOCUS gives a program a state change it has no
     * reason to see, and a program that reacts to going into the background --
     * by pausing itself, or by abandoning a cinematic -- then does so because
     * something happened to a web page. In this machine there is one window and
     * it is the active one, always.
     *
     * The program is told it is active once, by `arm` below, when input is
     * wired to a window -- not by a focus event, which would be the page
     * deciding when a program becomes active. What still happens here on the
     * way out is the release
     * of everything held: a key whose release is never delivered stays down for
     * the rest of the session, the player walks into a wall for ever, and no
     * later event can undo it because as far as the program is concerned
     * nothing has happened. That is not browser state reaching the program --
     * it is the keyboard and the mouse, finished properly.
     *
     * @param {HostInputEvent} event
     */
    const focus = event=>{
        if (event.gained)
        {
            cursorDirty = true;
            return true;
        }

        for (const code of [...held.keys()])
        {
            key({ kind: 'key', code, down: false });
        }
        for (const name of [...pressed])
        {
            button({ kind: 'pointerButton', button: name, down: false });
        }
        return true;
    };

    return {
        /**
         * Feeds one host event in. Answers whether anything came of it, which
         * is a fact worth having: an unmapped key or an unknown button is
         * dropped here rather than reaching a program as a wrong one.
         *
         * @param {HostInputEvent} event
         */
        /**
         * The one activation this machine ever sends.
         *
         * Called when input is wired to a window, which is a fact about this
         * machine rather than a browser event: there is one window here and it
         * is the active one. A program that waits to be told so before it will
         * do anything is owed this once -- and it is never taken back, whatever
         * the page's focus does afterwards.
         */
        arm(){
            if (activated)
            {
                return;
            }
            activated = true;
            emit(WM.ACTIVATEAPP, 1, 0);
            emit(WM.ACTIVATE, WA_ACTIVE, 0);
            emit(WM.SETFOCUS, 0, 0);
        },

        /** @param {HostInputEvent} event */
        send(event){
            switch (event.kind){
                case 'key':
                    return key(event);
                case 'text':
                    return text(event);
                case 'pointerMove':
                    return move(event);
                case 'pointerButton':
                    return button(event);
                case 'wheel':
                    return wheel(event);
                case 'focus':
                    return focus(event);
                case 'padAxis':
                    padAxes[event.axis ?? 0] = event.value ?? 0;
                    return true;
                case 'padButton':
                    padButtons[event.index ?? 0] = event.down ? 1 : 0;
                    return true;
                default:
                    dropped++;
                    return false;
            }
        },

        /**
         * Whether a virtual key is down, in the form GetAsyncKeyState answers
         * with. Nothing asks yet -- user32 reports no keyboard at all -- and
         * this is where that answer comes from when it does.
         *
         * @param {number} vk
         */
        keyState: vk=>(keys[vk & 0xff] ? 0x8000 : 0),

        /** Where the cursor is, in client coordinates. */
        cursor: ()=>({ x: cursor.x, y: cursor.y }),

        /**
         * The pad, as the last poll left it. There is no DirectInput joystick
         * device yet, so nothing reads this; it is kept because the alternative
         * is a host adapter holding state the layer that will need it cannot
         * see.
         */
        pad: ()=>({ axes: [...padAxes], buttons: [...padButtons] }),

        diagnostics: ()=>({
            posted,
            dropped,
            keysDown: [...held.keys()],
            buttonsDown: [...pressed],
            cursor: { ...cursor },
        }),
    };
}

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

import { keyFor, dikOf, codeForVk, codeForScan } from '../win32/user32/keys.js';

/** The messages this layer produces. */
export const WM = Object.freeze({
    ACTIVATE: 0x0006,
    SETFOCUS: 0x0007,
    KILLFOCUS: 0x0008,
    SETCURSOR: 0x0020,
    ACTIVATEAPP: 0x001c,
    NCACTIVATE: 0x0086,
    KEYDOWN: 0x0100,
    KEYUP: 0x0101,
    CHAR: 0x0102,
    SYSKEYDOWN: 0x0104,
    SYSKEYUP: 0x0105,
    SYSCHAR: 0x0106,
    MOUSEMOVE: 0x0200,
    MOUSEWHEEL: 0x020a,
});

/** The hit-test code WM_SETCURSOR reports for the client area. */
const HTCLIENT = 1;

/** The virtual keys this file has an opinion about. */
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_CAPITAL = 0x14;
const VK_NUMLOCK = 0x90;
const VK_SCROLL = 0x91;
const VK_F10 = 0x79;

/** The three keys whose low bit reports a toggle rather than a press. */
const TOGGLE_KEYS = new Set([VK_CAPITAL, VK_NUMLOCK, VK_SCROLL]);

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
 * A number would be four different numbers at once: a browser calls the middle
 * button 1, a mouse message pairs it with 0x0207, DirectInput puts it at index
 * 2 and the key state at VK_MBUTTON, 4. Naming the button is what keeps a
 * caller from having to know which of them it is holding.
 *
 * @type {Readonly<Record<string, readonly [number, number, number, number, number, number]>>}
 */
const BUTTONS = Object.freeze({
    // down message, up message, wParam bit, DirectInput index, XBUTTON id, virtual key
    left: [0x0201, 0x0202, MK.LBUTTON, 0, 0, 0x01],
    right: [0x0204, 0x0205, MK.RBUTTON, 1, 0, 0x02],
    middle: [0x0207, 0x0208, MK.MBUTTON, 2, 0, 0x04],
    x1: [0x020b, 0x020c, MK.XBUTTON1, 3, 1, 0x05],
    x2: [0x020b, 0x020c, MK.XBUTTON2, 4, 2, 0x06],
});

/**
 * @typedef {Object} HostInputEvent
 * @property {'key' | 'text' | 'paste' | 'pointerMove' | 'pointerButton' | 'wheel' | 'focus'
 *           | 'padAxis' | 'padButton'} kind
 * @property {string} [code]     For `key`: a `KeyboardEvent.code`.
 * @property {number} [vk]       For `key` with no `code`: a virtual key,
 *           `SendInput`'s own way of naming one -- resolved to the physical
 *           key it names before anything else happens.
 * @property {number} [scan]     For `key` with no `code`: a scan code,
 *           `SendInput`'s other way, read together with `extended`.
 * @property {boolean} [extended] Whether `scan` carries the E0 prefix.
 * @property {boolean} [down]    For `key`, `pointerButton` and `padButton`.
 * @property {string} [text]     For `text`: the character the browser composed.
 *           For `paste`: what the person pasted, for the clipboard.
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
 * One press or release, as it arrived and as the guest will read it.
 *
 * Both halves in one record on purpose: the question a dead button raises is
 * whether the press arrived and whether the position it was mapped to is the
 * one the program hit-tests against, and two records a reader has to pair up
 * answer it worse than one line that carries both.
 *
 * @typedef {Object} PressRecord
 * @property {string} button    A key of BUTTONS, as the page named it.
 * @property {boolean} down
 * @property {number} x         Where it landed, in the picture's own pixels.
 * @property {number} y
 * @property {number} hwnd      The window the message went to.
 * @property {number} message   The window message synthesised from it.
 * @property {number} wParam
 * @property {number} lParam
 * @property {boolean} withheld  The message was kept from the window, because
 *           DirectInput holds the mouse exclusively; the press reached the
 *           program through that alone.
 */

/** @typedef {import('../win32/user32/rawinput.js').RawInputEvent} RawReport */

/**
 * @typedef {Object} RouterDeps
 * @property {(message: {
 *     hwnd: number, message: number, wParam: number, lParam: number,
 *     time: number, x: number, y: number }) => void} post
 *     Where a window message goes: the thread's message queue.
 * @property {(event: import('./dinput/devices.js').InputEvent) => unknown} device
 *     Where the DirectInput reading goes.
 * @property {(press: PressRecord) => void} [trace]
 *     Where a press or a release is written down as it arrives, for a reader
 *     asking whether one arrived at all. Absent in a build with nothing
 *     listening, and then a press costs no record.
 * @property {(character: number, lParam: number) => void} [compose]
 *     Where a character the host's layout produced is left for the
 *     TranslateMessage that will turn it into a WM_CHAR. Absent in a build with
 *     no message queue, where there is nothing to translate it for.
 * @property {() => number} [now]     The guest's clock, for a message's time.
 * @property {() => number} [target]  The window input is for.
 * @property {(() => { width: number, height: number }) | null} [bounds]
 *     The client area the cursor is confined to, when the caller knows it.
 * @property {(text: string) => void} [paste]
 *     Where pasted text goes: the clipboard, for a program to read. Absent
 *     in a build with no clipboard, where a paste is dropped.
 * @property {(device: 'keyboard' | 'mouse') => boolean} [exclusive]
 *     Whether DirectInput holds that device exclusively, in which case its
 *     events reach the program through DirectInput and the window gets none
 *     of its messages. Absent, the window always gets them.
 * @property {(report: RawReport) => void} [rawInput]
 *     Where each event goes as the device reported it, for the WM_INPUT of a
 *     program that registered for raw input: user32 decides who is told.
 *     Absent in a build with no windows.
 */

/**
 * @param {RouterDeps} deps
 */
export function createInputRouter(
    { post, device, now, target, bounds, compose, trace, paste, exclusive, rawInput },
)
{
    /** The configured screen, or nothing: what the cursor falls back to. */
    const screen = bounds ?? null;
    // Where the cursor may go. The configured screen until something wires a
    // viewport to the machine, and that viewport's own pixels afterwards: the
    // picture a person is looking at is the space they are pointing into, and
    // confining the cursor to a different one leaves a strip of the picture
    // that cannot be reached however far the mouse is moved.
    let confinedTo = screen;
    const clock = now ?? (()=>0);
    const targetWindow = target ?? (()=>0);
    const composeCharacter = compose ?? (()=>{});
    const report = rawInput ?? (()=>{});
    /**
     * Whether the window is told what this device does. An exclusive
     * DirectInput device is taken as raw input with RIDEV_NOLEGACY, which
     * stops the legacy messages -- a program that reads a click both ways
     * would otherwise act on it twice.
     *
     * @param {'keyboard' | 'mouse'} kind
     */
    const windowHears = kind=>exclusive?.(kind) !== true;

    /**
     * Virtual keys that are down as the thread sees them: what GetKeyState
     * and GetKeyboardState read, and what SetKeyboardState rewrites. Indexed
     * by VK, both the paired and the sided.
     */
    const keys = new Uint8Array(256);
    /**
     * Virtual keys that are physically down: what GetAsyncKeyState reads.
     * SetKeyboardState leaves this alone -- a table that says A is down does
     * not press A.
     */
    const physical = new Uint8Array(256);
    /**
     * Whether a toggle key is toggled on, the low bit GetKeyboardState and
     * GetKeyState report for CapsLock, NumLock and ScrollLock.
     */
    const toggles = new Uint8Array(256);
    /**
     * Keys that have gone down since GetAsyncKeyState last read them. That
     * call's low bit promises a press happened, not that one is happening,
     * and the read is what clears it.
     */
    const pressedSinceRead = new Uint8Array(256);
    /** @type {Map<string, import('../win32/user32/keys.js').KeyMapping>} */
    const held = new Map();
    /** @type {Set<string>} */
    const pressed = new Set();
    const cursor = { x: 0, y: 0 };
    /**
     * The space the program reckons the cursor in, when it has declared one
     * with ClipCursor, or null. A menu built for 640x480 shown in a larger
     * backbuffer confines the cursor to 640x480 and moves it by DirectInput
     * counts it expects to span exactly that: so a pointer's travel across the
     * real viewport is scaled into this space, and the same sweep covers the
     * same fraction of each. Undeclared, the viewport itself is that space and
     * the scale is one -- which is the 640x480-into-640x480 case, unchanged.
     * @type {{ left: number, top: number, right: number, bottom: number } | null}
     */
    let clipRect = null;
    // The fraction of a scaled motion not yet delivered as a whole count, so a
    // slow drag through a shrinking scale is not rounded away to nothing.
    let residualX = 0;
    let residualY = 0;
    // The last absolute pointer position in real-viewport pixels, to derive a
    // relative motion from when the host gives a position but no delta.
    let rawX = 0;
    let rawY = 0;
    // Whether the program has placed the cursor itself. While it holds the
    // cursor -- hidden, or with a button down as in a drag -- the pointer's
    // absolute position means nothing to it: the cursor it reckons with is
    // the one it put down plus what has moved since, so a position the host
    // reports is taken as the motion from the last one instead. Once the
    // cursor is shown again and no button is held, the pointer the person
    // sees is the cursor, and its next position is where the cursor is: a
    // real warp would have moved the pointer, and this one could not, so the
    // two are brought together at the first chance instead of drifting apart
    // by the width of the warp for the rest of the run.
    let placed = false;
    // Whether the program shows the cursor, as it last told the page.
    let cursorVisible = true;
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

    /**
     * A physical key going down or up -- named the way a browser names one,
     * by `event.code`, or the way `SendInput` does, by a virtual key or a
     * scan code resolved back to the same physical key before anything else
     * here runs. Whichever named it, everything past this line is one key on
     * one keyboard, and cannot tell the two apart.
     *
     * @param {HostInputEvent} event
     */
    const key = event=>{
        const code = event.code
            ?? (event.scan !== undefined ? codeForScan(event.scan, event.extended === true)
                : event.vk !== undefined ? codeForVk(event.vk) : null);
        if (code === null)
        {
            dropped++;
            return false;
        }
        const mapping = keyFor(code);
        if (!mapping)
        {
            dropped++;
            return false;
        }

        const wasDown = held.has(code);
        const altBefore = keys[VK_MENU] !== 0;
        if (event.down)
        {
            held.set(code, mapping);
            keys[mapping.vk] = physical[mapping.vk] = 1;
            keys[mapping.vkSide] = physical[mapping.vkSide] = 1;
            // A repeat is the same press still held, not a new one: the
            // async low bit is owed on the transition only.
            if (!wasDown)
            {
                pressedSinceRead[mapping.vk] = 1;
                pressedSinceRead[mapping.vkSide] = 1;
                if (TOGGLE_KEYS.has(mapping.vk))
                {
                    toggles[mapping.vk] ^= 1;
                }
            }
        }
        else
        {
            held.delete(code);
            keys[mapping.vkSide] = physical[mapping.vkSide] = 0;
            // A modifier is two keys and one virtual key: letting go of the
            // left shift while the right is down does not mean shift is up.
            keys[mapping.vk] = physical[mapping.vk] =
                [...held.values()].some(other=>other.vk === mapping.vk) ? 1 : 0;
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
        if (windowHears('keyboard'))
        {
            emit(messages[system ? 1 : 0], mapping.vk, lParam);
        }
        device({ kind: 'key', code: dikOf(mapping), down: event.down === true });
        report({ device: 'key', scan: mapping.scan & 0xff, extended: mapping.extended === true,
            vk: mapping.vk, down: event.down === true, message: messages[system ? 1 : 0] });
        return true;
    };

    /** @param {HostInputEvent} event */
    const text = event=>{
        const string = event.text ?? '';
        if (!windowHears('keyboard'))
        {
            // No key message went out for TranslateMessage to find this by.
            return false;
        }
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

    /** @param {number} value @param {number} low @param {number} high */
    const confineRange = (value, low, high)=>Math.max(low, Math.min(high - 1, value));

    /** @param {HostInputEvent} event */
    const move = event=>{
        const box = confinedTo?.() ?? null;
        const clip = clipRect;
        // How a pointer's travel across the real viewport (the canvas) maps onto
        // the space the program reckons the cursor in (what it declared with
        // ClipCursor). Declared smaller than the viewport, the same sweep must
        // cover the same fraction of each; undeclared, the two spaces are one.
        const scaleX = clip && box && box.width > 0
            ? (clip.right - clip.left) / box.width : 1;
        const scaleY = clip && box && box.height > 0
            ? (clip.bottom - clip.top) / box.height : 1;

        // Relative motion in real-viewport pixels is what DirectInput reports
        // and absolute is what a message carries, and a host knows one, the
        // other, or both: a locked pointer has no position, a touch has no
        // delta. Whichever is missing is derived from the one that is not.
        const rawDx = event.dx ?? (event.x === undefined ? 0 : (event.x | 0) - rawX);
        const rawDy = event.dy ?? (event.y === undefined ? 0 : (event.y | 0) - rawY);
        if (event.x !== undefined)
        {
            rawX = event.x | 0;
        }
        if (event.y !== undefined)
        {
            rawY = event.y | 0;
        }

        // That motion in the declared space, its fraction carried so a slow
        // drag is not rounded away. This is what DirectInput reports and what
        // the program's own cursor accumulates and clamps -- as on hardware,
        // the device reports the scaled motion whether or not it is clipped.
        residualX += rawDx * scaleX;
        residualY += rawDy * scaleY;
        const stepX = Math.trunc(residualX);
        const stepY = Math.trunc(residualY);
        residualX -= stepX;
        residualY -= stepY;

        // Where that leaves the cursor in the declared space: from an absolute
        // position when the host gives one, else advanced by the scaled step.
        if (placed && cursorVisible && pressed.size === 0 && event.x !== undefined)
        {
            placed = false;
            residualX = 0;
            residualY = 0;
        }
        const px = cursor.x;
        const py = cursor.y;
        let nx = event.x === undefined || placed
            ? cursor.x + stepX
            : (clip ? clip.left : 0) + Math.round((event.x | 0) * scaleX);
        let ny = event.y === undefined || placed
            ? cursor.y + stepY
            : (clip ? clip.top : 0) + Math.round((event.y | 0) * scaleY);
        if (clip)
        {
            nx = confineRange(nx, clip.left, clip.right);
            ny = confineRange(ny, clip.top, clip.bottom);
        }
        else if (box)
        {
            nx = confine(nx, box.width);
            ny = confine(ny, box.height);
        }
        cursor.x = nx;
        cursor.y = ny;

        if ((cursor.x !== px || cursor.y !== py) && windowHears('mouse'))
        {
            announceCursor(WM.MOUSEMOVE);
            emit(WM.MOUSEMOVE, mask(), point());
        }
        if (stepX !== 0 || stepY !== 0)
        {
            device({ kind: 'mouseMove', x: stepX, y: stepY });
            report({ device: 'mouse', dx: stepX, dy: stepY });
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
        const [downMessage, upMessage, , index, extra, vk] = entry;
        // A button is a virtual key too, in the table GetKeyState,
        // GetAsyncKeyState and GetKeyboardState read.
        if (event.down)
        {
            if (!physical[vk])
            {
                pressedSinceRead[vk] = 1;
            }
            keys[vk] = physical[vk] = 1;
            pressed.add(String(event.button));
        }
        else
        {
            keys[vk] = physical[vk] = 0;
            pressed.delete(String(event.button));
        }

        const message = event.down ? downMessage : upMessage;
        // A button is the moment a program is most likely to want a different
        // cursor, so the question is always asked again here.
        cursorDirty = true;
        const wParam = (extra << 16 | mask()) >>> 0;
        const lParam = point();
        const withheld = !windowHears('mouse');
        if (!withheld)
        {
            announceCursor(message);
            emit(message, wParam, lParam);
        }
        // After the message, so a record exists only for a press the guest was
        // actually told about -- by the message, or by DirectInput alone when
        // that holds the mouse -- and its absence means the press never got
        // here.
        trace?.({
            button: String(event.button),
            down: event.down === true,
            x: cursor.x,
            y: cursor.y,
            hwnd: targetWindow() >>> 0,
            message,
            wParam,
            lParam,
            withheld,
        });
        device({ kind: 'mouseButton', code: index, down: event.down === true });
        // BUTTONS named it, so it is one of the five a RAWMOUSE has.
        const named = /** @type {RawReport['button']} */ (event.button);
        report({ device: 'mouse', button: named, down: event.down === true });
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
        if (windowHears('mouse'))
        {
            emit(WM.MOUSEWHEEL, (delta & 0xffff) << 16 | mask(), point());
        }
        device({ kind: 'mouseWheel', wheel: delta });
        report({ device: 'mouse', wheel: delta });
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
     * The program is told it is the active application by user32, when it
     * shows a window -- not by a focus event, which would be the page
     * deciding when a program becomes active. What still happens here on the
     * way out is the release of everything held: a key whose release is
     * never delivered stays down for the rest of the session, the player
     * walks into a wall for ever, and no
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
         * Confines the cursor to the viewport now showing the program, in that
         * viewport's own pixels.
         *
         * @param {(() => { width: number, height: number }) | null} viewport
         */
        confineTo(viewport){
            confinedTo = viewport ?? screen;
        },

        /**
         * The coordinate space the program declared for the cursor, via
         * ClipCursor. A degenerate or null rect clears it, and motion maps
         * straight into the viewport again.
         *
         * @param {{ left: number, top: number, right: number, bottom: number } | null} rect
         */
        clip(rect){
            clipRect = rect && rect.right - rect.left > 0 && rect.bottom - rect.top > 0
                ? {
                    left: rect.left | 0,
                    top: rect.top | 0,
                    right: rect.right | 0,
                    bottom: rect.bottom | 0,
                }
                : null;
            residualX = 0;
            residualY = 0;
        },

        /**
         * Puts the cursor where the program says, in the space it reckons the
         * cursor in, as SetCursorPos does. A game of the mouse-look kind reads
         * the cursor, takes its distance from the centre as the frame's motion
         * and puts it back to the centre; left where it was, that distance is
         * the whole way to the edge every frame. Placing is not motion: the
         * relative device sees nothing, and the message a real cursor warp
         * produces is the only word of it.
         *
         * @param {number} x @param {number} y
         */
        place(x, y){
            const clip = clipRect;
            const box = confinedTo?.() ?? null;
            const px = cursor.x;
            const py = cursor.y;
            cursor.x = clip ? confineRange(x | 0, clip.left, clip.right)
                : box ? confine(x | 0, box.width) : x | 0;
            cursor.y = clip ? confineRange(y | 0, clip.top, clip.bottom)
                : box ? confine(y | 0, box.height) : y | 0;
            placed = true;
            residualX = 0;
            residualY = 0;
            if (cursor.x !== px || cursor.y !== py)
            {
                announceCursor(WM.MOUSEMOVE);
                emit(WM.MOUSEMOVE, mask(), point());
            }
        },

        /**
         * What the program last said about the cursor's visibility, from
         * ShowCursor's count or a device cursor: what decides whether a
         * placement it made outlives the pointer's next position.
         *
         * @param {boolean} visible
         */
        shown(visible){
            cursorVisible = visible;
        },

        /** @param {HostInputEvent} event */
        send(event){
            switch (event.kind){
                case 'key':
                    return key(event);
                case 'text':
                    return text(event);
                case 'paste':
                    if (!paste || typeof event.text !== 'string')
                    {
                        dropped++;
                        return false;
                    }
                    paste(event.text);
                    return true;
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
         * Whether a virtual key is down, in the form GetKeyState answers with:
         * the high bit set while it is held and the low bit while it is toggled
         * on, the same two bits GetKeyboardState reports. This is the
         * synchronous state the queue also reads, never the async one.
         *
         * @param {number} vk
         */
        keyState: vk=>(keys[vk & 0xff] ? 0x8000 : 0) | toggles[vk & 0xff],

        /**
         * Whether a virtual key is down and whether it went down since the
         * last read, in the form GetAsyncKeyState answers with. The low bit is
         * a promise that a press happened, and reading is what clears it, so
         * two calls with no event between them answer the second without it.
         *
         * @param {number} vk
         */
        asyncKeyState(vk){
            const index = vk & 0xff;
            const answer = (physical[index] ? 0x8000 : 0) | (pressedSinceRead[index] ? 1 : 0);
            pressedSinceRead[index] = 0;
            return answer;
        },

        /**
         * The whole keyboard as 256 bytes, one per virtual key, in the form
         * GetKeyboardState fills its caller's array: the high bit of a byte
         * says the key is down and the low bit the toggle for CapsLock,
         * NumLock and ScrollLock.
         *
         * A copy, because the array is written into guest memory and then
         * keeps changing here.
         */
        keyboardState(){
            const state = new Uint8Array(256);
            for (let index = 0; index < 256; index++)
            {
                state[index] = (keys[index] ? 0x80 : 0) | toggles[index];
            }
            return state;
        },

        /**
         * Makes the 256-byte table the synchronous state: the down bits and
         * the toggle bits in it become what GetKeyState answers. The physical
         * state GetAsyncKeyState reads is not the thread's to set.
         *
         * @param {Uint8Array} bytes
         */
        setKeyboardState(bytes){
            for (let index = 0; index < 256; index++)
            {
                keys[index] = (bytes[index] & 0x80) ? 1 : 0;
                toggles[index] = bytes[index] & 1;
            }
        },

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
            // The two spaces a pointer travels between. A cursor that lands
            // short of where it was aimed is these two disagreeing, and
            // nothing else in this report can show which one is wrong.
            viewport: confinedTo?.() ?? null,
            clip: clipRect ? { ...clipRect } : null,
        }),
    };
}

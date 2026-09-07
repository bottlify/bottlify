/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One key, in the three forms a program reads it as.
 *
 * A Win32 program does not ask for "the A key". It reads a virtual key out of
 * a message's wParam, a PS/2 set-1 scan code out of that message's lParam, and
 * a DirectInput key code out of a 256-byte array -- and it is entitled to have
 * all three agree about the same physical key. So the table is keyed by the
 * physical key and carries all of them.
 *
 * The identity of a physical key is `KeyboardEvent.code`, never `keyCode`:
 * `code` names the position on the keyboard regardless of the layout in force,
 * which is exactly what a scan code is. `keyCode` is deprecated, is derived
 * from the layout, and would put a French player's A on the scan code of Q.
 *
 * Two things about the mapping are easy to get wrong and are the reason this is
 * a table rather than arithmetic:
 *
 * - **A DirectInput code is the scan code with the E0 prefix folded into bit 7**
 *   (DIK_RCONTROL is 0x9d, the 0x1d of a control key plus 0x80). So the flag is
 *   stored, and both consumers derive their form of it.
 * - **A message names the modifier, not the side.** Pressing either shift puts
 *   VK_SHIFT in wParam, and only lParam's extended bit and scan code say which
 *   one it was. The side-specific key exists as well, because that is what
 *   GetAsyncKeyState is asked about, so both are kept.
 */

/**
 * @typedef {Object} KeyMapping
 * @property {number} scan      Set-1 scan code, without the E0 prefix.
 * @property {number} vk        The virtual key a window message carries.
 * @property {boolean} extended Whether the real scan code is prefixed with E0.
 * @property {number} vkSide    The virtual key that distinguishes left from right.
 */

/**
 * `KeyboardEvent.code` -> scan code, virtual key, extended flag, side-specific
 * virtual key. The last two are absent for the great majority of keys.
 *
 * @type {Readonly<Record<string, readonly [number, number, (0 | 1)?, number?]>>}
 */
const TABLE = Object.freeze({
    Escape: [0x01, 0x1b],
    Digit1: [0x02, 0x31], Digit2: [0x03, 0x32], Digit3: [0x04, 0x33],
    Digit4: [0x05, 0x34], Digit5: [0x06, 0x35], Digit6: [0x07, 0x36],
    Digit7: [0x08, 0x37], Digit8: [0x09, 0x38], Digit9: [0x0a, 0x39],
    Digit0: [0x0b, 0x30],
    Minus: [0x0c, 0xbd], Equal: [0x0d, 0xbb],
    Backspace: [0x0e, 0x08], Tab: [0x0f, 0x09],
    KeyQ: [0x10, 0x51], KeyW: [0x11, 0x57], KeyE: [0x12, 0x45], KeyR: [0x13, 0x52],
    KeyT: [0x14, 0x54], KeyY: [0x15, 0x59], KeyU: [0x16, 0x55], KeyI: [0x17, 0x49],
    KeyO: [0x18, 0x4f], KeyP: [0x19, 0x50],
    BracketLeft: [0x1a, 0xdb], BracketRight: [0x1b, 0xdd],
    Enter: [0x1c, 0x0d],
    ControlLeft: [0x1d, 0x11, 0, 0xa2],
    KeyA: [0x1e, 0x41], KeyS: [0x1f, 0x53], KeyD: [0x20, 0x44], KeyF: [0x21, 0x46],
    KeyG: [0x22, 0x47], KeyH: [0x23, 0x48], KeyJ: [0x24, 0x4a], KeyK: [0x25, 0x4b],
    KeyL: [0x26, 0x4c],
    Semicolon: [0x27, 0xba], Quote: [0x28, 0xde], Backquote: [0x29, 0xc0],
    ShiftLeft: [0x2a, 0x10, 0, 0xa0],
    Backslash: [0x2b, 0xdc],
    KeyZ: [0x2c, 0x5a], KeyX: [0x2d, 0x58], KeyC: [0x2e, 0x43], KeyV: [0x2f, 0x56],
    KeyB: [0x30, 0x42], KeyN: [0x31, 0x4e], KeyM: [0x32, 0x4d],
    Comma: [0x33, 0xbc], Period: [0x34, 0xbe], Slash: [0x35, 0xbf],
    ShiftRight: [0x36, 0x10, 0, 0xa1],
    NumpadMultiply: [0x37, 0x6a],
    AltLeft: [0x38, 0x12, 0, 0xa4],
    Space: [0x39, 0x20],
    CapsLock: [0x3a, 0x14],
    F1: [0x3b, 0x70], F2: [0x3c, 0x71], F3: [0x3d, 0x72], F4: [0x3e, 0x73],
    F5: [0x3f, 0x74], F6: [0x40, 0x75], F7: [0x41, 0x76], F8: [0x42, 0x77],
    F9: [0x43, 0x78], F10: [0x44, 0x79],
    NumLock: [0x45, 0x90],
    ScrollLock: [0x46, 0x91],
    Numpad7: [0x47, 0x67], Numpad8: [0x48, 0x68], Numpad9: [0x49, 0x69],
    NumpadSubtract: [0x4a, 0x6d],
    Numpad4: [0x4b, 0x64], Numpad5: [0x4c, 0x65], Numpad6: [0x4d, 0x66],
    NumpadAdd: [0x4e, 0x6b],
    Numpad1: [0x4f, 0x61], Numpad2: [0x50, 0x62], Numpad3: [0x51, 0x63],
    Numpad0: [0x52, 0x60],
    NumpadDecimal: [0x53, 0x6e],
    IntlBackslash: [0x56, 0xe2],
    F11: [0x57, 0x7a], F12: [0x58, 0x7b],

    // The E0 half. A scan code here is the same byte as an unprefixed key's --
    // the numeric keypad's, in nearly every case -- and only the prefix tells
    // the arrow cluster apart from the numbers that share its codes.
    NumpadEnter: [0x1c, 0x0d, 1],
    ControlRight: [0x1d, 0x11, 1, 0xa3],
    NumpadDivide: [0x35, 0x6f, 1],
    PrintScreen: [0x37, 0x2c, 1],
    AltRight: [0x38, 0x12, 1, 0xa5],
    // Pause and NumLock are the pair this catches out: Pause is the extended
    // one (DIK_PAUSE is 0xc5) and NumLock, despite sitting beside it, is not.
    Pause: [0x45, 0x13, 1],
    Home: [0x47, 0x24, 1],
    ArrowUp: [0x48, 0x26, 1],
    PageUp: [0x49, 0x21, 1],
    ArrowLeft: [0x4b, 0x25, 1],
    ArrowRight: [0x4d, 0x27, 1],
    End: [0x4f, 0x23, 1],
    ArrowDown: [0x50, 0x28, 1],
    PageDown: [0x51, 0x22, 1],
    Insert: [0x52, 0x2d, 1],
    Delete: [0x53, 0x2e, 1],
    MetaLeft: [0x5b, 0x5b, 1],
    MetaRight: [0x5c, 0x5c, 1],
    ContextMenu: [0x5d, 0x5d, 1],
});

/** @type {Map<string, KeyMapping>} */
const KEYS = new Map(Object.entries(TABLE).map(([code, [scan, vk, extended, side]])=>[code, {
    scan,
    vk,
    extended: extended === 1,
    vkSide: side ?? vk,
}]));

/**
 * The key at a physical position, or null for one this table does not name.
 *
 * Null rather than a guess: a key with no scan code has nothing to put in
 * lParam, and inventing one would have a program bind an action to a key that
 * cannot be pressed again.
 *
 * @param {string} code  A `KeyboardEvent.code` value.
 * @returns {KeyMapping | null}
 */
export function keyFor(code){
    return KEYS.get(code) ?? null;
}

/**
 * The DirectInput code for a key: the scan code, with the E0 prefix as bit 7.
 *
 * @param {KeyMapping} mapping
 */
export function dikOf(mapping){
    return mapping.extended ? mapping.scan | 0x80 : mapping.scan;
}

/** Every physical key this build knows, for a diagnostic that wants to say. */
export const KNOWN_KEYS = Object.freeze([...KEYS.keys()]);

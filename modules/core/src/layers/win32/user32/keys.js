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
    // The media keys, E0-prefixed codes of their own; DirectInput names
    // them by the same bytes (DIK_PREVTRACK is 0x90).
    MediaTrackPrevious: [0x10, 0xb1, 1], MediaTrackNext: [0x19, 0xb0, 1],
    AudioVolumeMute: [0x20, 0xad, 1], LaunchApp2: [0x21, 0xb7, 1],
    MediaPlayPause: [0x22, 0xb3, 1], MediaStop: [0x24, 0xb2, 1],
    AudioVolumeDown: [0x2e, 0xae, 1], AudioVolumeUp: [0x30, 0xaf, 1],
    BrowserHome: [0x32, 0xac, 1],
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
 * The reverse of `keyFor`, built once: a virtual key or a scan code back to
 * the physical key it names -- what `SendInput`'s `INPUT_KEYBOARD` is given
 * instead of a `KeyboardEvent.code`, and has to be resolved to one before it
 * can take the same path a real key press does.
 *
 * A generic virtual key (`VK_SHIFT`, `VK_CONTROL`, `VK_MENU`) does not say
 * which side, and Windows resolves it to the left one -- which is what
 * iterating the table in its own order and keeping the first hit does here,
 * since the left of each such pair is declared first.
 *
 * @type {Map<number, string>}
 */
const CODE_BY_VK = new Map();
/** Keyed by the scan code with the E0 prefix folded into bit 8, so the two
 *  scan-code spaces (prefixed and not) never collide. @type {Map<number, string>} */
const CODE_BY_SCAN = new Map();
for (const [code, mapping] of KEYS)
{
    if (!CODE_BY_VK.has(mapping.vk))
    {
        CODE_BY_VK.set(mapping.vk, code);
    }
    CODE_BY_VK.set(mapping.vkSide, code);
    CODE_BY_SCAN.set(mapping.extended ? mapping.scan | 0x100 : mapping.scan, code);
}

/**
 * @param {number} vk
 * @returns {string | null}
 */
export function codeForVk(vk){
    return CODE_BY_VK.get(vk) ?? null;
}

/**
 * @param {number} scan @param {boolean} extended
 * @returns {string | null}
 */
export function codeForScan(scan, extended){
    return CODE_BY_SCAN.get(extended ? scan | 0x100 : scan) ?? null;
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

/**
 * The character each key produces on the one US layout this build has,
 * unshifted and shifted. A letter is not here: its case is shift XOR caps
 * lock, not a fixed pair. A key absent from here and from the rules in
 * `characterOf` produces no character -- an arrow, a function key -- which is
 * what every call that asks answers for one.
 *
 * @type {ReadonlyMap<number, readonly [string, string]>}
 */
const LAYOUT = new Map(/** @type {[number, [string, string]][]} */ ([
    [0x30, ['0', ')']], [0x31, ['1', '!']], [0x32, ['2', '@']], [0x33, ['3', '#']],
    [0x34, ['4', '$']], [0x35, ['5', '%']], [0x36, ['6', '^']], [0x37, ['7', '&']],
    [0x38, ['8', '*']], [0x39, ['9', '(']],
    [0x20, [' ', ' ']],
    [0xbd, ['-', '_']], [0xbb, ['=', '+']],
    [0xdb, ['[', '{']], [0xdd, [']', '}']], [0xdc, ['\\', '|']],
    [0xba, [';', ':']], [0xde, ["'", '"']], [0xc0, ['`', '~']],
    [0xbc, [',', '<']], [0xbe, ['.', '>']], [0xbf, ['/', '?']],
    // The numeric keypad, with num lock on -- the state a keyboard starts in
    // and the one a program typing a number expects. Shift does not change
    // them here, since nothing turns num lock off.
    [0x60, ['0', '0']], [0x61, ['1', '1']], [0x62, ['2', '2']], [0x63, ['3', '3']],
    [0x64, ['4', '4']], [0x65, ['5', '5']], [0x66, ['6', '6']], [0x67, ['7', '7']],
    [0x68, ['8', '8']], [0x69, ['9', '9']],
    [0x6a, ['*', '*']], [0x6b, ['+', '+']], [0x6d, ['-', '-']], [0x6e, ['.', '.']],
    [0x6f, ['/', '/']],
]));

/**
 * Keys whose virtual-key code is the character they produce: the control keys
 * inherited their numbers from ASCII.
 */
const SELF_ENCODING = new Set([0x08, 0x09, 0x0d, 0x1b]);

/** What control makes of the keys that make anything with it besides letters. */
const WITH_CONTROL = new Map([[0xdb, 0x1b], [0xdc, 0x1c], [0xdd, 0x1d], [0x0d, 0x0a],
    [0x08, 0x7f], [0x1b, 0x1b], [0x20, 0x20]]);

/**
 * @typedef {Object} Modifiers
 * @property {boolean} [shift]
 * @property {boolean} [capsLock]
 * @property {boolean} [control]
 */

/**
 * The character a key produces under a set of modifiers, as a code unit, or
 * null when it produces none. The one answer TranslateMessage, ToUnicode,
 * ToAscii and MapVirtualKey's character form all read, so a program that
 * types a key and one that asks what the key would type cannot disagree.
 *
 * Control with a letter is the letter's control code (Ctrl+A is 1), as a
 * terminal and every edit control read it; with most other keys it is
 * nothing at all.
 *
 * @param {number} vk
 * @param {Modifiers} [modifiers]
 * @returns {number | null}
 */
export function characterOf(vk, { shift = false, capsLock = false, control = false } = {}){
    const isLetter = vk >= 0x41 && vk <= 0x5a;
    if (control)
    {
        return isLetter ? vk - 0x40 : WITH_CONTROL.get(vk) ?? null;
    }
    if (isLetter)
    {
        return shift !== capsLock ? vk : vk + 0x20;
    }
    if (SELF_ENCODING.has(vk))
    {
        return vk;
    }
    const pair = LAYOUT.get(vk);
    return pair ? pair[shift ? 1 : 0].charCodeAt(0) : null;
}

/**
 * The key and modifiers that type a character, the other way round from
 * `characterOf` -- what VkKeyScan answers: the virtual key in the low byte
 * and the shift state (1 shift, 2 control) in the high byte, or null for a
 * character no key on this layout types. Where two keys type it, the main
 * block's is answered, not the keypad's.
 *
 * @param {number} character
 * @returns {number | null}
 */
export function keyForCharacter(character){
    if (character >= 0x61 && character <= 0x7a)
    {
        return character - 0x20;
    }
    if (character >= 0x41 && character <= 0x5a)
    {
        return 0x100 | character;
    }
    if (SELF_ENCODING.has(character))
    {
        return character;
    }
    const typed = String.fromCharCode(character);
    for (const [vk, [plain, shifted]] of LAYOUT)
    {
        if (plain === typed)
        {
            return vk;
        }
        if (shifted === typed)
        {
            return 0x100 | vk;
        }
    }
    // Before the letters, so a line feed is control and enter, as Windows
    // answers it, rather than control and J.
    for (const [vk, code] of WITH_CONTROL)
    {
        if (code === character)
        {
            return 0x200 | vk;
        }
    }
    if (character >= 0x01 && character <= 0x1a)
    {
        return 0x200 | (character + 0x40);
    }
    return null;
}

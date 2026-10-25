/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A keyboard with no keys of its own -- a phone's, drawn on its screen --
 * turned into the key presses a program reads.
 *
 * Such a keyboard says only what it typed: an edit of a text field, never a
 * key. A program of this era reads keys -- WM_KEYDOWN, GetAsyncKeyState,
 * DirectInput's array -- and its characters come from TranslateMessage made
 * out of those keys, so a character with nothing pressed for it reaches no
 * one. So each character is typed on the US layout's key that types it,
 * with Shift held where that key needs it, exactly as a person at a real
 * keyboard would have typed it; a character no key on that layout types is
 * sent as Windows sends SendInput's Unicode input, a VK_PACKET press (the
 * router's `type`).
 */

import { codeForVk, keyForCharacter } from '../win32/user32/keys.js';

/**
 * What a key press means as text, where the browser's own answer is a name
 * rather than a character.
 */
export const CONTROL_TEXT = Object.freeze({
    Enter: '\r',
    NumpadEnter: '\r',
    Tab: '\t',
    Backspace: '\b',
    Escape: '\x1b',
});

/** @typedef {import('./router.js').HostInputEvent} HostInputEvent */

/**
 * A key pressed and let go, with the character it types between the two, as
 * a keyboard with keys sends it.
 *
 * @param {string} code  A `KeyboardEvent.code`.
 * @param {string | null} [character]  What it types; a control key's own if left out.
 * @returns {HostInputEvent[]}
 */
export function keyTap(code, character){
    const text = character === undefined
        ? /** @type {Record<string, string>} */ (CONTROL_TEXT)[code] ?? null : character;
    return [
        { kind: 'key', code, down: true },
        ...(text === null ? [] : [{ kind: /** @type {const} */ ('text'), text }]),
        { kind: 'key', code, down: false },
    ];
}

/**
 * One character typed, as the presses that type it.
 *
 * @param {string} character  One UTF-16 code unit, or a surrogate pair.
 * @returns {HostInputEvent[]}
 */
export function typeCharacter(character){
    if (character === '\n' || character === '\r')
    {
        return keyTap('Enter');
    }
    const scan = character.length === 1 ? keyForCharacter(character.charCodeAt(0)) : null;
    // Plain or with Shift: what control or alt types is not text a keyboard
    // with no keys produces.
    const shifted = scan !== null && scan >>> 8 === 1;
    const code = scan !== null && scan >>> 8 <= 1 ? codeForVk(scan & 0xff) : null;
    if (code === null)
    {
        return [{ kind: 'type', text: character }];
    }
    const tap = keyTap(code, character);
    return shifted
        ? [{ kind: 'key', code: 'ShiftLeft', down: true }, ...tap,
            { kind: 'key', code: 'ShiftLeft', down: false }]
        : tap;
}

/**
 * What an edit of the field such a keyboard types into sends: its
 * `beforeinput` event's kind and data. Inserted text is typed character by
 * character, a line break is Enter and a deletion is Backspace or Delete;
 * an edit that types nothing -- formatting, a history step -- sends nothing.
 *
 * @param {{ inputType: string, data?: string | null }} edit
 * @returns {HostInputEvent[]}
 */
export function editEvents({ inputType, data }){
    switch (inputType)
    {
        case 'insertText':
        case 'insertReplacementText':
        case 'insertFromPaste':
        case 'insertFromDrop':
            // By code point, so a character outside the basic plane is one
            // VK_PACKET pair per code unit inside one `type`, as SendInput's.
            return [...(data ?? '')].flatMap(typeCharacter);
        case 'insertLineBreak':
        case 'insertParagraph':
            return keyTap('Enter');
        case 'deleteContentBackward':
        case 'deleteWordBackward':
        case 'deleteSoftLineBackward':
        case 'deleteHardLineBackward':
            return keyTap('Backspace');
        case 'deleteContentForward':
        case 'deleteWordForward':
            return keyTap('Delete', null);
        default:
            return [];
    }
}

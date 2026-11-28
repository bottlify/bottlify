/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A control's text in guest memory, in either spelling: what an item
 * structure's pszText points at, read when it is handed in and written into
 * the program's buffer when it asks for one back.
 */

/** What a control keeps of one text. */
export const MAX_TEXT = 1024;

/** The text pointer that asks the parent each time it is wanted. */
export const LPSTR_TEXTCALLBACK = 0xffffffff;

/**
 * A string handed in, read up to its terminator or `max` characters.
 *
 * @param {{ guest: import('../common/guest.js').Guest }} host
 * @param {number} address @param {boolean} wide @param {number} [max]
 */
export function readText(host, address, wide, max = MAX_TEXT){
    return host.guest.text(address, wide, wide ? max * 2 : max);
}

/**
 * Copies a text into a program's buffer of `room` characters, cut to fit with
 * its terminator; nothing for a null buffer or no room.
 *
 * @param {{ guest: import('../common/guest.js').Guest }} host
 * @param {number} address @param {string} text @param {boolean} wide @param {number} room
 * @returns {number} the characters copied, the terminator not counted
 */
export function writeText(host, address, text, wide, room){
    return address >>> 0 === 0 ? 0 : host.guest.setText(address, text, wide, room);
}

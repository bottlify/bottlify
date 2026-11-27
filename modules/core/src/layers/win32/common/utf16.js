/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Text as the bytes of a wide string: UTF-16, little-endian, a JavaScript
 * string's code units as they are. A character past U+FFFF is a string's two
 * surrogate units already, and a lone surrogate - which a wide string read
 * from a program may hold - goes back as the unit it was, so what a program
 * wrote comes back to it whole. Iterating the string by code point and
 * taking one unit of each would drop the second half of every pair.
 */

/**
 * @param {ArrayLike<number>} units  UTF-16 code units.
 * @param {number} [room]  Units the bytes hold, the rest zero: past `units` for a terminator.
 * @returns {Uint8Array}
 */
export function bytesOfUnits(units, room = units.length){
    const bytes = new Uint8Array(room * 2);
    for (let at = 0; at < units.length; at++)
    {
        bytes[at * 2] = units[at] & 0xff;
        bytes[at * 2 + 1] = units[at] >>> 8 & 0xff;
    }
    return bytes;
}

/**
 * @param {string} text
 * @param {number} room  Units the bytes hold, the rest zero.
 */
const encode = (text, room)=>{
    const bytes = new Uint8Array(room * 2);
    for (let at = 0; at < text.length; at++)
    {
        const unit = text.charCodeAt(at);
        bytes[at * 2] = unit & 0xff;
        bytes[at * 2 + 1] = unit >>> 8;
    }
    return bytes;
};

/**
 * The text's UTF-16LE bytes, with no terminator.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export const utf16 = text=>encode(text, text.length);

/**
 * The text's UTF-16LE bytes and a terminating NUL unit.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export const utf16z = text=>encode(text, text.length + 1);

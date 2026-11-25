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

import { encodeAnsi } from '../kernel32/locale.js';
import { wholeAddress } from '../common/pointers.js';
import { utf16z } from '../common/utf16.js';

/** What a control keeps of one text. */
export const MAX_TEXT = 1024;

/** The text pointer that asks the parent each time it is wanted. */
export const LPSTR_TEXTCALLBACK = 0xffffffff;

/**
 * A string handed in, read a piece at a time up to its terminator: a buffer
 * at the top of the stack has nothing readable past it.
 *
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     readCString: (address: number, max: number) => string }} host
 * @param {number} address @param {boolean} wide @param {number} [max]
 */
export function readText(host, address, wide, max = MAX_TEXT){
    if (!wide)
    {
        return host.readCString(wholeAddress(address), max);
    }
    let text = '';
    for (let at = wholeAddress(address); text.length < max; at += 32)
    {
        const bytes = host.readMemory(at, 32);
        for (let i = 0; i < 32; i += 2)
        {
            const unit = bytes[i] | bytes[i + 1] << 8;
            if (unit === 0)
            {
                return text;
            }
            text += String.fromCharCode(unit);
        }
    }
    return text;
}

/**
 * Copies a text into a program's buffer of `room` characters, cut to fit with
 * its terminator; nothing for a null buffer or no room.
 *
 * @param {{ writeMemory: (address: number, bytes: Uint8Array) => void }} host
 * @param {number} address @param {string} text @param {boolean} wide @param {number} room
 * @returns {number} the characters copied, the terminator not counted
 */
export function writeText(host, address, text, wide, room){
    if (address >>> 0 === 0 || room <= 0)
    {
        return 0;
    }
    const clipped = text.slice(0, room - 1);
    if (!wide)
    {
        const bytes = encodeAnsi(clipped);
        const fit = bytes.subarray(0, room - 1);
        const out = new Uint8Array(fit.length + 1);
        out.set(fit);
        host.writeMemory(wholeAddress(address), out);
        return fit.length;
    }
    const bytes = utf16z(clipped);
    host.writeMemory(wholeAddress(address), bytes);
    return clipped.length;
}

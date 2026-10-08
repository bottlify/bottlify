/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two spellings of a shlwapi string: the ANSI page a byte at a time, and
 * UTF-16 two bytes a character. Every string function here is written once
 * over a `Width` and exported twice, so the A and the W answer alike by
 * construction rather than by two bodies kept in step.
 *
 * The ANSI page is a single-byte one, so a character's index in the text is
 * its byte offset in the caller's buffer, which is what lets the functions
 * that answer with a pointer into that buffer compute it from an index.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

/** As long as a string a program hands these may be, terminator included. */
export const MAX_LENGTH = 0x1000;

/**
 * @typedef {Object} Width
 * @property {boolean} wide
 * @property {number} unit  Bytes a character takes, which is how far a pointer moves.
 * @property {(address: number, limit?: number) => string | null} read
 *           The string at an address, null for a null pointer or a build that
 *           cannot read this spelling.
 * @property {(text: string) => Uint8Array} bytes  Text as stored, no terminator.
 * @property {(text: string) => Uint8Array} sz     Text as stored, terminated.
 * @property {(code: number) => string} char
 *           One character of this spelling by its code: a byte of the ANSI
 *           page, or a UTF-16 unit.
 */

/**
 * @typedef {Object} TextHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 */

/** @param {string} text */
const utf16 = text=>{
    const bytes = new Uint8Array(text.length * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
    }
    return bytes;
};

/**
 * @param {TextHost} host
 * @returns {{ A: Width, W: Width }}
 */
export function createWidths(host){
    /** @type {Width} */
    const A = {
        wide: false,
        unit: 1,
        read: (address, limit = MAX_LENGTH)=>
            ((address >>> 0) === 0 ? null : host.readCString(address >>> 0, limit)),
        bytes: text=>encodeAnsi(text),
        sz: text=>encodeAnsi(`${text}\0`),
        char: code=>decodeAnsi(Uint8Array.of(code & 0xff)),
    };
    /** @type {Width} */
    const W = {
        wide: true,
        unit: 2,
        read: (address, limit = MAX_LENGTH)=>((address >>> 0) === 0 || !host.readWideString
            ? null : host.readWideString(address >>> 0, limit)),
        bytes: utf16,
        sz: text=>utf16(`${text}\0`),
        char: code=>String.fromCharCode(code & 0xffff),
    };
    return { A, W };
}

/** @param {number} value @returns {Uint8Array} a little-endian DWORD */
export const dword = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff,
    value >>> 16 & 0xff, value >>> 24 & 0xff);

/** @param {Uint8Array} bytes @param {number} [at] */
export const u32 = (bytes, at = 0)=>(bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
    | bytes[at + 3] << 24) >>> 0;

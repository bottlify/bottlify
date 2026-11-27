/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a watch in front of a guest function reports of each call's
 * arguments, read while the call is made: a name built on the caller's stack
 * is gone by the time the answer comes. Each is named as the launcher's
 * `?hook=` and the tools' `--hook` / `--watch-import` spell it:
 *
 * - `N`: argument N as a pointer to a C string.
 * - `ecx`, `edx`: the register as a pointer to a C string.
 * - `@hex`: an address of the program's own, as a C string.
 * - `where*len`: `len` bytes where `where` points rather than a string.
 * - `[where.off]*len`: `len` bytes of what the pointer at `where + off`
 *   points at, the object a field of the argument names.
 * - `$N*len`: `len` bytes of the stack from argument N on, the arguments
 *   themselves -- a double or a structure passed by value.
 *
 * Bytes come back as `0xADDRESS:hex`, an address not mapped as
 * `0xADDRESS:unmapped`, a string not readable as its pointer.
 */

/**
 * @typedef {Object} WatchedCall
 * @property {(address: number) => number} readU32
 * @property {(address: number, length: number) => Uint8Array} readBytes
 * @property {(address: number, max: number) => string} readCString
 * @property {number} esp  the call's stack: the return address, then the arguments
 * @property {number} ecx
 * @property {number} edx
 */

const BYTES = /^(\[)?(ecx|edx|\d+|@[0-9a-f]+)(?:\.(\d+)\])?\*(\d+)$/;
const STACK = /^\$(\d+)\*(\d+)$/;

/** @param {Uint8Array} bytes */
const hex = bytes=>[...bytes].map(b=>b.toString(16).padStart(2, '0')).join('');

/**
 * One argument as the watch names it.
 *
 * @param {string | number} where @param {WatchedCall} call
 * @returns {string}
 */
export function watchedArgument(where, call){
    /** @param {string} at */
    const pointerOf = at=>(at.startsWith('@') ? parseInt(at.slice(1), 16) >>> 0
        : at === 'ecx' ? call.ecx >>> 0
            : at === 'edx' ? call.edx >>> 0
                : call.readU32(call.esp + 4 + Number(at) * 4) >>> 0);
    /** @param {number} at @param {number} length */
    const bytesAt = (at, length)=>{
        try
        {
            return `0x${at.toString(16)}:${hex(call.readBytes(at, length))}`;
        }
        catch {
            return `0x${at.toString(16)}:unmapped`;
        }
    };
    const text = String(where);
    const stack = STACK.exec(text);
    if (stack)
    {
        return bytesAt((call.esp + 4 + Number(stack[1]) * 4) >>> 0, Number(stack[2]));
    }
    const bytes = BYTES.exec(text);
    if (bytes)
    {
        let at = pointerOf(bytes[2]);
        if (bytes[1])
        {
            at = call.readU32(at + Number(bytes[3])) >>> 0;
        }
        return bytesAt(at, Number(bytes[4]));
    }
    const pointer = pointerOf(text);
    try
    {
        return call.readCString(pointer, 260);
    }
    catch {
        return `0x${pointer.toString(16)}`;
    }
}

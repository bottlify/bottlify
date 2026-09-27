/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { HANDLE_STDERR, HANDLE_STDIN } from './console.js';

/**
 * What a handle value names before the table is asked.
 *
 * The low two bits of a kernel handle are the program's: Windows ignores them
 * when it looks a handle up, and a program may keep a flag there. The values
 * that are not table entries at all -- the pseudo-handles counting down from
 * -1, the standard-handle numbers from -10, and the console handles this
 * engine hands out -- keep every bit, because each of them is a name in its
 * own right.
 */

/** Below this every value is a pseudo-handle or a standard-handle number. */
const PSEUDO_FLOOR = 0xfffffff0;

/** GetStdHandle's arguments, which kernel32's waits accept for the handles themselves. */
const STD_ERROR_HANDLE = 0xfffffff4;
const STD_INPUT_HANDLE = 0xfffffff6;

/**
 * The value the handle table knows this one by.
 *
 * @param {number} handle
 * @returns {number}
 */
export function untagged(handle){
    const value = handle >>> 0;
    return value > HANDLE_STDERR && value < PSEUDO_FLOOR ? (value & ~3) >>> 0 : value;
}

/**
 * Whether a value names a standard stream: a console handle GetStdHandle hands
 * out, or the STD_*_HANDLE number kernel32 reads as that handle. Neither is in
 * the handle table.
 *
 * @param {number} handle
 */
export function isStandardHandle(handle){
    const value = handle >>> 0;
    return (value >= HANDLE_STDIN && value <= HANDLE_STDERR)
        || (value >= STD_ERROR_HANDLE && value <= STD_INPUT_HANDLE);
}

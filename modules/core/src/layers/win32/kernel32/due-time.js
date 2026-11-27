/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * A due time as Windows gives one: a LARGE_INTEGER in hundreds of nanoseconds,
 * negative for an interval from now and positive for a moment in system time
 * (a FILETIME). SetWaitableTimer, the thread pool's timers and every native
 * timeout read it; one reading serves them all.
 */

/** Milliseconds from FILETIME's epoch (1601) to the Unix epoch (1970). */
export const FILETIME_EPOCH_MS = 11644473600000;

/**
 * How many milliseconds from now a due time is, never negative.
 *
 * @param {bigint} raw  the LARGE_INTEGER
 * @param {number} wallClockMs  the system time now, in milliseconds since 1970
 * @returns {number}
 */
export function dueInMs(raw, wallClockMs){
    if (raw <= 0n)
    {
        return Number(-raw) / 10000;
    }
    return Math.max(0, Number(raw / 10000n) - FILETIME_EPOCH_MS - wallClockMs);
}

/**
 * The LARGE_INTEGER at an address.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory
 * @param {number} pointer
 * @returns {bigint}
 */
export function readLargeInteger(readMemory, pointer){
    const bytes = readMemory(wholeAddress(pointer), 8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
}

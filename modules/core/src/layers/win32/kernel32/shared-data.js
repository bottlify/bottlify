/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * KUSER_SHARED_DATA: the page every Windows NT process finds at 0x7FFE0000,
 * read without a call.
 *
 * The system keeps in it what any process may read at no cost: the tick count
 * and the times GetTickCount and GetSystemTimeAsFileTime are made from, the
 * NT version, the product type, the system root, the processor's features. A
 * program reads it directly -- a runtime's inlined tick count, a protection
 * comparing the version GetVersionEx answers with the one the system keeps
 * here, which a compatibility shim changes in the one place and not the other.
 * So the version is the same record every other road reads (`versions.js`),
 * and the clocks are the ones GetTickCount and GetSystemTimeAsFileTime answer
 * with, refreshed wherever guest time moves.
 *
 * Layout as the x86 structure has it from XP to Windows 10; fields this does
 * not fill are zero, as a field the running system leaves unset is.
 */

import { PROCESSOR_FEATURES } from './processor.js';

export const SHARED_USER_DATA = 0x7ffe0000;

/** Field offsets, and the page it occupies. */
export const KUSER = Object.freeze({
    TICK_COUNT_LOW: 0x000,
    TICK_COUNT_MULTIPLIER: 0x004,
    INTERRUPT_TIME: 0x008,
    SYSTEM_TIME: 0x014,
    TIME_ZONE_BIAS: 0x020,
    IMAGE_NUMBER_LOW: 0x02c,
    IMAGE_NUMBER_HIGH: 0x02e,
    NT_SYSTEM_ROOT: 0x030,
    NT_PRODUCT_TYPE: 0x264,
    PRODUCT_TYPE_IS_VALID: 0x268,
    NT_MAJOR_VERSION: 0x26c,
    NT_MINOR_VERSION: 0x270,
    PROCESSOR_FEATURES: 0x274,
    SUITE_MASK: 0x2d0,
    NUMBER_OF_PHYSICAL_PAGES: 0x2e8,
    TICK_COUNT: 0x320,
    SIZE: 0x1000,
});

/** IMAGE_FILE_MACHINE_I386, the images this system runs natively. */
const MACHINE_I386 = 0x14c;
/** NtProductWinNt: a workstation. */
const NT_PRODUCT_WIN_NT = 1;
/**
 * The tick count kept in milliseconds, so the multiplier that turns it into
 * GetTickCount's milliseconds is one (in 8.24 fixed point): what a reader
 * computes is what GetTickCount answers.
 */
const MULTIPLIER_ONE = 0x01000000;
/** Milliseconds between 1601 and 1970, FILETIME's epoch and Date's. */
const FILETIME_EPOCH_MS = 11644473600000;
const TWO_16 = 0x10000;
const TWO_32 = 0x100000000;

/**
 * @param {Object} options
 * @param {any} options.memory  The memory layer's API.
 * @param {{ major: number, minor: number, suiteMask?: number }} options.version
 * @param {number} [options.physicalPages]
 * @returns {{ address: number,
 *     refresh: (milliseconds: number, systemTimeMs: number) => void } | null}
 *     null where the page cannot be had: memory too small to reach it, or taken
 */
export function createSharedUserData({ memory, version, physicalPages = 0x40000 }){
    /** @param {string} access */
    const region = access=>memory.register({
        name: 'kuser-shared-data',
        base: SHARED_USER_DATA,
        size: KUSER.SIZE,
        kind: memory.RegionKind.THUNK_DATA,
        access,
    });
    // Written while it may be, and read-only from then on, as the program
    // finds it on Windows; the clocks move through the RAM's own words.
    const words = memory.wordsOver?.(SHARED_USER_DATA, KUSER.SIZE) ?? null;
    try
    {
        region(memory.Access.READ_WRITE);
    } catch {
        return null;
    }
    const page = new Uint8Array(KUSER.SIZE);
    const view = new DataView(page.buffer);
    view.setUint32(KUSER.TICK_COUNT_MULTIPLIER, MULTIPLIER_ONE, true);
    view.setUint16(KUSER.IMAGE_NUMBER_LOW, MACHINE_I386, true);
    view.setUint16(KUSER.IMAGE_NUMBER_HIGH, MACHINE_I386, true);
    [...'C:\\WINDOWS'].forEach((character, at)=>
        view.setUint16(KUSER.NT_SYSTEM_ROOT + at * 2, character.charCodeAt(0), true));
    view.setUint32(KUSER.NT_PRODUCT_TYPE, NT_PRODUCT_WIN_NT, true);
    page[KUSER.PRODUCT_TYPE_IS_VALID] = 1;
    view.setUint32(KUSER.NT_MAJOR_VERSION, version.major, true);
    view.setUint32(KUSER.NT_MINOR_VERSION, version.minor, true);
    for (const [feature, present] of PROCESSOR_FEATURES)
    {
        page[KUSER.PROCESSOR_FEATURES + feature] = present ? 1 : 0;
    }
    view.setUint32(KUSER.SUITE_MASK, version.suiteMask ?? 0, true);
    view.setUint32(KUSER.NUMBER_OF_PHYSICAL_PAGES, physicalPages, true);
    try
    {
        memory.writeBytes(SHARED_USER_DATA, page);
    } catch {
        // A machine given less memory than reaches the address has no page.
        memory.unregister('kuser-shared-data');
        return null;
    }
    if (words)
    {
        memory.unregister('kuser-shared-data');
        region(memory.Access.READ);
    }

    /**
     * A KSYSTEM_TIME the way the kernel writes one: the second high word,
     * the low word, then the first high word, so a reader that finds the two
     * high words equal has a whole value.
     *
     * The value is milliseconds, written as 100-nanosecond units -- in plain
     * numbers, a millisecond count split in two so no product passes 2^53:
     * BigInt arithmetic here was an allocation per field wherever guest time
     * moved.
     *
     * @param {number} at @param {number} milliseconds
     */
    const writeTime = (at, milliseconds)=>{
        const whole = Math.floor(milliseconds);
        const upper = Math.floor(whole / TWO_16) * 10_000;
        const lower = whole % TWO_16 * 10_000;
        const sum = upper % TWO_16 * TWO_16 + lower;
        const high = Math.floor(upper / TWO_16) + Math.floor(sum / TWO_32);
        put(at + 8, high);
        put(at, sum % TWO_32);
        put(at + 4, high);
    };
    /**
     * A word of the page: through the RAM's words where the memory layer has
     * them, every store an atomic one for a reader on another executor; the
     * checked path, which the page left writable for, where it has not.
     *
     * @param {number} at @param {number} value
     */
    const put = (at, value)=>{
        if (words)
        {
            Atomics.store(words, at >> 2, value | 0);
        }
        else
        {
            memory.writeU32(SHARED_USER_DATA + at, value >>> 0);
        }
    };

    return {
        address: SHARED_USER_DATA,
        // ponytail: TimeZoneBias stays zero; fill it from GetTimeZoneInformation's
        // zone when a program is seen reading local time from here.
        refresh(milliseconds, systemTimeMs){
            const ticks = Math.floor(milliseconds);
            put(KUSER.TICK_COUNT_LOW, ticks % TWO_32);
            // The tick count in milliseconds (the multiplier is one), its high
            // word in both high slots.
            const tickHigh = Math.floor(ticks / TWO_32);
            put(KUSER.TICK_COUNT + 8, tickHigh);
            put(KUSER.TICK_COUNT, ticks % TWO_32);
            put(KUSER.TICK_COUNT + 4, tickHigh);
            writeTime(KUSER.INTERRUPT_TIME, ticks);
            writeTime(KUSER.SYSTEM_TIME, Math.floor(systemTimeMs) + FILETIME_EPOCH_MS);
        },
    };
}

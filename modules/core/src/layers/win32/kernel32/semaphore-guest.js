/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WaitForSingleObject and ReleaseSemaphore on a semaphore, answered in the
 * guest while no thread is queued on it.
 *
 * Each handle below SLOTS has a word in the kernel's table (`wait-one.js`); a
 * semaphore's is the address of its own two words with SEMAPHORE_TAG set
 * (`kernel/internal/semaphore-words.js`): its count, with HOST set while the
 * host keeps it, and its maximum. A wait takes a count there with
 * `lock cmpxchg`, and a poll of a semaphore at zero times out there, whoever
 * keeps it; a release adds its counts there, the previous count written where
 * the caller asked. Everything else goes to the host as the call was made: a
 * wait that has to wait, a semaphore the host keeps (a thread is queued on
 * it, or the host is changing it), a count that is not positive or goes past
 * the maximum, an exchange lost to another thread, a handle with no word.
 *
 * WaitForSingleObject's guest code (`waitOneCode`) reads the table first and
 * comes here, as the call was made, for a word with SEMAPHORE_TAG.
 */

/**
 * The guest's memory and its exchange.
 *
 * @typedef {import('../msvcrt/guest-code.js').GuestMemory} Guest
 */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */

/** Handles below four times this have a word (`wait-one.js`'s EVENT_SLOTS). */
const SLOTS = 0x4000;
/** The low bits of a semaphore's word in the table (the kernel's SEMAPHORE_TAG). */
const TAG = 3;
/** A semaphore's own word: the host keeps it (`SEMAPHORE_WORD.HOST`). */
const HOST = 0x80000000;
/** ...and its count (`SEMAPHORE_WORD.COUNT`). */
const COUNT = 0x7fffffff;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;

/**
 * The kernel's table of handle words: its address, written into the code's
 * copy of this table where the code is placed.
 */
export const HANDLE_WORDS = new Uint32Array(1);

/**
 * DWORD WaitForSingleObject(HANDLE, DWORD dwMilliseconds) on a semaphore.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} handle @param {u32} timeout
 * @returns {u32}
 */
export function waitSemaphore({ u32, compareExchange, host }, handle, timeout){
    const index = handle >>> 2;
    if (index >= SLOTS)
    {
        return host();
    }
    const word = u32(HANDLE_WORDS[0] + index * 4);
    if (word < 4 || (word & 3) !== TAG)
    {
        return host();
    }
    const at = (word - TAG) >>> 0;
    const state = u32(at);
    if ((state & COUNT) === 0)
    {
        if (timeout !== 0)
        {
            return host();
        }
        return WAIT_TIMEOUT;
    }
    if ((state & HOST) !== 0 || compareExchange(at, state, state - 1) !== state)
    {
        return host();
    }
    return WAIT_OBJECT_0;
}

/**
 * BOOL ReleaseSemaphore(HANDLE, LONG lReleaseCount, LPLONG lpPreviousCount)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} handle @param {u32} count @param {u32} previous
 * @returns {u32}
 */
export function ReleaseSemaphore({ u32, setU32, compareExchange, host }, handle, count, previous){
    const index = handle >>> 2;
    if (index >= SLOTS)
    {
        return host();
    }
    const word = u32(HANDLE_WORDS[0] + index * 4);
    if (word < 4 || (word & 3) !== TAG)
    {
        return host();
    }
    const at = (word - TAG) >>> 0;
    const state = u32(at);
    // A count of zero or less is refused, and one past the maximum, by the host.
    if ((state & HOST) !== 0 || (count | 0) <= 0 || count > (u32(at + 4) - state) >>> 0)
    {
        return host();
    }
    if (compareExchange(at, state, state + count) !== state)
    {
        return host();
    }
    if (previous !== 0)
    {
        setU32(previous, state);
    }
    return 1;
}

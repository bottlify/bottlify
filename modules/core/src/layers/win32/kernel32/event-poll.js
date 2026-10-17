/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WaitForSingleObject's poll of an event, answered in the guest.
 *
 * A poll -- a zero timeout -- of an event that is not signalled times out and
 * changes nothing, so the guest answers it from the event's word in the
 * kernel's table (`kernel/internal/event-mirror.js`) and never crosses into
 * the host. Everything else goes to the host as it did: a timeout to wait, a
 * signalled event to take, a handle that is not an event of this process or
 * is past the table.
 *
 *     mov eax, [esp+8]            ; dwMilliseconds
 *     test eax, eax
 *     jnz slow
 *     mov eax, [esp+4]            ; hHandle, its low two bits the program's
 *     shr eax, 2
 *     cmp eax, EVENT_SLOTS
 *     jae slow
 *     cmp dword [table+eax*4], CLEAR   ; the kernel's word for an unsignalled event
 *     jne slow
 *     mov eax, WAIT_TIMEOUT
 *     ret 8
 *   slow:
 *     jmp trap
 */

/**
 * Handles below four times this have a word: 64 KiB of table, and a program
 * has opened sixteen thousand handles before its next event is the host's.
 */
export const EVENT_SLOTS = 0x4000;

const WAIT_TIMEOUT = 0x102;

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * @param {number} at     Where the code lands, for the jump to the trap.
 * @param {number} trap   The host's WaitForSingleObject.
 * @param {number} table  The kernel's words, one a handle.
 * @param {number} clear  The word of an event that is not signalled.
 * @returns {Uint8Array}
 */
export function eventPollCode(at, trap, table, clear){
    const slow = 40;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x08,                                      // mov eax, [esp+8]
        0x85, 0xc0,                                                  // test eax, eax
        0x75, slow - 8,                                              // jnz slow
        0x8b, 0x44, 0x24, 0x04,                                      // mov eax, [esp+4]
        0xc1, 0xe8, 0x02,                                            // shr eax, 2
        0x3d, ...dword(EVENT_SLOTS),                                 // cmp eax, EVENT_SLOTS
        0x73, slow - 22,                                             // jae slow
        0x83, 0x3c, 0x85, ...dword(table), clear,                    // cmp dword [table+eax*4]
        0x75, slow - 32,                                             // jne slow
        0xb8, ...dword(WAIT_TIMEOUT),                                // mov eax, WAIT_TIMEOUT
        0xc2, 0x08, 0x00,                                            // ret 8
        // slow: (40)
        0xe9, ...dword(trap - (at + slow + 5)),                      // jmp trap
    ]);
}

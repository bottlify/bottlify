/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WaitForSingleObject, ReleaseMutex, SetEvent and ResetEvent, answered in the
 * guest where the answer changes nothing the host keeps, or only a mutex
 * nobody waits for.
 *
 * Each handle below EVENT_SLOTS has a word in the kernel's table:
 * an event's says whether it is signalled (`kernel/internal/event-mirror.js`),
 * and a poll -- a zero timeout -- of one that is not times out here; a mutex's
 * is the address of the mutex's own word with MUTEX_TAG set
 * (`kernel/internal/mutex-words.js`), and a free mutex, or one the caller owns
 * already, is taken here with `lock cmpxchg`, and one the caller owns given
 * back the same way. SetEvent of a signalled event and ResetEvent of one that
 * is not change nothing, and are answered here too. Everything else goes to
 * the host as the call was made: a timeout to wait, a signalled event to take,
 * an event to change, a mutex another thread holds or the host keeps, an
 * exchange lost to another thread, a handle with no word.
 *
 *   WaitForSingleObject(handle, milliseconds):
 *     mov eax, [esp+4]            ; handle, its low two bits the program's
 *     shr eax, 2
 *     cmp eax, EVENT_SLOTS
 *     jae slow
 *     mov eax, [table+eax*4]
 *     cmp eax, 4                  ; a mutex's word is an address
 *     jae mutex
 *     cmp eax, CLEAR              ; an event not signalled...
 *     jne slow
 *     cmp dword [esp+8], 0        ; ...polled
 *     jne slow
 *     mov eax, WAIT_TIMEOUT
 *     ret 8
 *   mutex:
 *     lea ecx, [eax-MUTEX_TAG]    ; the mutex's word
 *     mov edx, fs:[0x24]          ; the caller's id
 *     shl edx, 8
 *     mov eax, [ecx]
 *     test eax, eax
 *     jnz held
 *     or edx, 1                   ; free: the caller's, taken once
 *     lock cmpxchg [ecx], edx
 *     jne slow
 *     xor eax, eax                ; WAIT_OBJECT_0
 *     ret 8
 *   held:
 *     xor eax, edx                ; the count, if the caller owns it and the host does not keep it
 *     cmp eax, 0x7f
 *     jae slow
 *     xor eax, edx
 *     lea edx, [eax+1]            ; taken once more
 *     lock cmpxchg [ecx], edx
 *     jne slow
 *     xor eax, eax
 *     ret 8
 *   slow:
 *     jmp trap
 */

/**
 * Handles below four times this have a word: 64 KiB of table, and a program
 * has opened sixteen thousand handles before its next event is the host's.
 */
export const EVENT_SLOTS = 0x4000;

/** Mutexes with a word of their own (`mutex-words.js`): 64 KiB of them. */
export const MUTEX_SLOTS = 0x4000;

const WAIT_TIMEOUT = 0x102;
const TEB_THREAD_ID = 0x24;

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** `jcc rel32` from `from` to `to`, the condition's second opcode byte given. */
const jcc = (/** @type {number} */ op, /** @type {number} */ from, /** @type {number} */ to)=>
    [0x0f, op, ...dword((to - (from + 6)) | 0)];

const JAE = 0x83;
const JB = 0x82;
const JNE = 0x85;
const JA = 0x87;

/**
 * @param {number} at     Where the code lands, for the jump to the trap.
 * @param {number} trap   The host's WaitForSingleObject.
 * @param {number} table  The kernel's words, one a handle.
 * @param {number} clear  The word of an event that is not signalled.
 * @param {number} tag    The low bits of a mutex's word.
 * @returns {Uint8Array}
 */
export function waitOneCode(at, trap, table, clear, tag){
    const mutex = 62;
    const held = 99;
    const slow = 130;
    const bytes = [
        0x8b, 0x44, 0x24, 0x04,                                      // 0: mov eax, [esp+4]
        0xc1, 0xe8, 0x02,                                            // 4: shr eax, 2
        0x3d, ...dword(EVENT_SLOTS),                                 // 7: cmp eax, EVENT_SLOTS
        ...jcc(JAE, 12, slow),                                       // 12: jae slow
        0x8b, 0x04, 0x85, ...dword(table),                           // 18: mov eax, [table+eax*4]
        0x83, 0xf8, 0x04,                                            // 25: cmp eax, 4
        ...jcc(JAE, 28, mutex),                                      // 28: jae mutex
        0x83, 0xf8, clear,                                           // 34: cmp eax, CLEAR
        ...jcc(JNE, 37, slow),                                       // 37: jne slow
        0x83, 0x7c, 0x24, 0x08, 0x00,                                // 43: cmp dword [esp+8], 0
        ...jcc(JNE, 48, slow),                                       // 48: jne slow
        0xb8, ...dword(WAIT_TIMEOUT),                                // 54: mov eax, WAIT_TIMEOUT
        0xc2, 0x08, 0x00,                                            // 59: ret 8
        // mutex: (62)
        0x8d, 0x48, (-tag) & 0xff,                                   // 62: lea ecx, [eax-tag]
        0x64, 0x8b, 0x15, ...dword(TEB_THREAD_ID),                   // 65: mov edx, fs:[0x24]
        0xc1, 0xe2, 0x08,                                            // 72: shl edx, 8
        0x8b, 0x01,                                                  // 75: mov eax, [ecx]
        0x85, 0xc0,                                                  // 77: test eax, eax
        0x75, held - 81,                                             // 79: jnz held
        0x83, 0xca, 0x01,                                            // 81: or edx, 1
        0xf0, 0x0f, 0xb1, 0x11,                                      // 84: lock cmpxchg [ecx], edx
        ...jcc(JNE, 88, slow),                                       // 88: jne slow
        0x31, 0xc0,                                                  // 94: xor eax, eax
        0xc2, 0x08, 0x00,                                            // 96: ret 8
        // held: (99)
        0x31, 0xd0,                                                  // 99: xor eax, edx
        0x83, 0xf8, 0x7f,                                            // 101: cmp eax, 0x7f
        ...jcc(JAE, 104, slow),                                      // 104: jae slow
        0x31, 0xd0,                                                  // 110: xor eax, edx
        0x8d, 0x50, 0x01,                                            // 112: lea edx, [eax+1]
        0xf0, 0x0f, 0xb1, 0x11,                                      // 115: lock cmpxchg [ecx], edx
        ...jcc(JNE, 119, slow),                                      // 119: jne slow
        0x31, 0xc0,                                                  // 125: xor eax, eax
        0xc2, 0x08, 0x00,                                            // 127: ret 8
        // slow: (130)
        0xe9, ...dword(trap - (at + slow + 5)),                      // 130: jmp trap
    ];
    return new Uint8Array(bytes);
}

/**
 * ReleaseMutex as guest code: a mutex the caller owns and the host does not
 * keep is given back by one with `lock cmpxchg`, freed at its last; every
 * other call -- not the caller's, the host's to keep, a handle with no word, a
 * lost exchange -- is the host's, which answers failures and their errors.
 *
 *     mov eax, [esp+4]
 *     shr eax, 2
 *     cmp eax, EVENT_SLOTS
 *     jae slow
 *     mov eax, [table+eax*4]
 *     cmp eax, 4
 *     jb slow                     ; an event's word, or none
 *     lea ecx, [eax-MUTEX_TAG]
 *     mov edx, fs:[0x24]
 *     shl edx, 8
 *     mov eax, [ecx]
 *     xor eax, edx                ; the count, if the caller owns it and the host does not keep it
 *     dec eax
 *     cmp eax, 0x7e
 *     ja slow
 *     test eax, eax
 *     jz last
 *     inc eax
 *     xor eax, edx
 *     lea edx, [eax-1]
 *     lock cmpxchg [ecx], edx
 *     jne slow
 *     mov eax, 1
 *     ret 4
 *   last:
 *     lea eax, [edx+1]            ; owned once: free
 *     xor edx, edx
 *     lock cmpxchg [ecx], edx
 *     jne slow
 *     mov eax, 1
 *     ret 4
 *   slow:
 *     jmp trap
 *
 * @param {number} at     Where the code lands, for the jump to the trap.
 * @param {number} trap   The host's ReleaseMutex.
 * @param {number} table  The kernel's words, one a handle.
 * @param {number} tag    The low bits of a mutex's word.
 * @returns {Uint8Array}
 */
export function releaseMutexCode(at, trap, table, tag){
    const last = 89;
    const slow = 112;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // 0: mov eax, [esp+4]
        0xc1, 0xe8, 0x02,                                            // 4: shr eax, 2
        0x3d, ...dword(EVENT_SLOTS),                                 // 7: cmp eax, EVENT_SLOTS
        ...jcc(JAE, 12, slow),                                       // 12: jae slow
        0x8b, 0x04, 0x85, ...dword(table),                           // 18: mov eax, [table+eax*4]
        0x83, 0xf8, 0x04,                                            // 25: cmp eax, 4
        ...jcc(JB, 28, slow),                                        // 28: jb slow
        0x8d, 0x48, (-tag) & 0xff,                                   // 34: lea ecx, [eax-tag]
        0x64, 0x8b, 0x15, ...dword(TEB_THREAD_ID),                   // 37: mov edx, fs:[0x24]
        0xc1, 0xe2, 0x08,                                            // 44: shl edx, 8
        0x8b, 0x01,                                                  // 47: mov eax, [ecx]
        0x31, 0xd0,                                                  // 49: xor eax, edx
        0x48,                                                        // 51: dec eax
        0x83, 0xf8, 0x7e,                                            // 52: cmp eax, 0x7e
        ...jcc(JA, 55, slow),                                        // 55: ja slow
        0x85, 0xc0,                                                  // 61: test eax, eax
        0x74, last - 65,                                             // 63: jz last
        0x40,                                                        // 65: inc eax
        0x31, 0xd0,                                                  // 66: xor eax, edx
        0x8d, 0x50, 0xff,                                            // 68: lea edx, [eax-1]
        0xf0, 0x0f, 0xb1, 0x11,                                      // 71: lock cmpxchg [ecx], edx
        ...jcc(JNE, 75, slow),                                       // 75: jne slow
        0xb8, ...dword(1),                                           // 81: mov eax, 1
        0xc2, 0x04, 0x00,                                            // 86: ret 4
        // last: (89)
        0x8d, 0x42, 0x01,                                            // 89: lea eax, [edx+1]
        0x31, 0xd2,                                                  // 92: xor edx, edx
        0xf0, 0x0f, 0xb1, 0x11,                                      // 94: lock cmpxchg [ecx], edx
        ...jcc(JNE, 98, slow),                                       // 98: jne slow
        0xb8, ...dword(1),                                           // 104: mov eax, 1
        0xc2, 0x04, 0x00,                                            // 109: ret 4
        // slow: (112)
        0xe9, ...dword(trap - (at + slow + 5)),                      // 112: jmp trap
    ]);
}

/**
 * SetEvent or ResetEvent as guest code: a call that asks for the state the
 * event's word already says it is in changes nothing and answers TRUE here --
 * a signalled event has no waiter to release, its waiters having been released
 * as it was set. Call of Duty 4 set events already set 16.9 million times in a
 * nine-minute session, 95% of its SetEvent calls and two thirds of all its
 * crossings, each from another executor a wait for the process's executor to
 * answer. Every other call is the host's: an event
 * to change, a handle with no word or past the table, a mutex's word.
 *
 *     mov eax, [esp+4]
 *     shr eax, 2
 *     cmp eax, EVENT_SLOTS
 *     jae slow
 *     cmp dword [table+eax*4], state  ; the state the call asks for
 *     jne slow
 *     mov eax, 1
 *     ret 4
 *   slow:
 *     jmp trap
 *
 * @param {number} at       Where the code lands, for the jump to the trap.
 * @param {number} trap     The host's SetEvent or ResetEvent.
 * @param {number} table    The kernel's words, one a handle.
 * @param {number} already  The word of an event the call leaves as it is.
 * @returns {Uint8Array}
 */
export function eventStateCode(at, trap, table, already){
    const slow = 40;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // 0: mov eax, [esp+4]
        0xc1, 0xe8, 0x02,                                            // 4: shr eax, 2
        0x3d, ...dword(EVENT_SLOTS),                                 // 7: cmp eax, EVENT_SLOTS
        ...jcc(JAE, 12, slow),                                       // 12: jae slow
        0x83, 0x3c, 0x85, ...dword(table), already,                  // 18: cmp [table+eax*4], state
        ...jcc(JNE, 26, slow),                                       // 26: jne slow
        0xb8, ...dword(1),                                           // 32: mov eax, 1
        0xc2, 0x04, 0x00,                                            // 37: ret 4
        // slow: (40)
        0xe9, ...dword(trap - (at + slow + 5)),                      // 40: jmp trap
    ]);
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WaitForSingleObject, ReleaseMutex, SetEvent and ResetEvent, answered in the
 * guest where the answer changes nothing the host keeps, or only a mutex or an
 * event nobody waits for.
 *
 * Each handle below EVENT_SLOTS has a word in the kernel's table. An event's
 * is the address of the event's own word with EVENT_TAG set
 * (`kernel/internal/event-words.js`): a signalled one is taken there with
 * `lock cmpxchg` (an auto-reset event goes clear, a manual-reset one stays
 * signalled), a poll -- a zero timeout -- of one that is not times out there,
 * and SetEvent and ResetEvent change it there; while the host keeps the word
 * (HOST: a thread waits on the event) it still says whether the event is
 * signalled, and what changes nothing -- a poll of an event that is not, a set
 * of one that is, a reset of one that is not -- is still answered there. An
 * event with no word of its own has its state in the table instead
 * (`kernel/internal/event-mirror.js`):
 * a poll of one that is not signalled times out here, and SetEvent of a
 * signalled one or ResetEvent of one that is not changes nothing and answers
 * here. A mutex's word is the address of the mutex's own word with MUTEX_TAG
 * set (`kernel/internal/mutex-words.js`): a free mutex, or one the caller owns
 * already, is taken there with `lock cmpxchg`, and one the caller owns given
 * back the same way. Everything else goes to the host as the call was made: a
 * timeout to wait, an event or a mutex the host keeps, a mutex another thread
 * holds, an exchange lost to another thread, a handle with no word.
 *
 * Every answer that takes or changes a word does so with `lock cmpxchg`, even
 * one that writes the word back as it was: the exchange orders the caller's
 * memory against the other thread's as the host's crossing did, which a
 * plain read does not on a host that reorders loads.
 *
 *   WaitForSingleObject(handle, milliseconds):
 *     mov eax, [esp+4]            ; handle, its low two bits the program's
 *     shr eax, 2
 *     cmp eax, EVENT_SLOTS
 *     jae slow
 *     mov eax, [table+eax*4]
 *     cmp eax, 4                  ; an object's own word is an address
 *     jae word
 *     cmp eax, CLEAR              ; an event not signalled...
 *     jne other
 *   poll:
 *     cmp dword [esp+8], 0        ; ...polled
 *     jne slow
 *     mov eax, WAIT_TIMEOUT
 *     ret 8
 *   word:
 *     test al, MUTEX_TAG
 *     jnz mutex
 *     lea ecx, [eax-EVENT_TAG]    ; the event's word
 *     mov eax, [ecx]
 *     test al, SIGNALLED
 *     jz poll                     ; whoever keeps it
 *     cmp eax, 3                  ; past SIGNALLED|MANUAL: the host keeps it
 *     ja slow
 *     mov edx, eax                ; a manual-reset event stays signalled...
 *     test al, MANUAL
 *     jnz taken
 *     xor edx, edx                ; ...an auto-reset one goes clear
 *   taken:
 *     lock cmpxchg [ecx], edx
 *     jne slow
 *     xor eax, eax                ; WAIT_OBJECT_0
 *     ret 8
 *   mutex:
 *     test al, EVENT_TAG          ; both tags: a semaphore's words
 *     jnz semaphore               ; (`semaphore-guest.js`), as the call was made
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
 *   other:
 *     cmp eax, INVALID            ; handles 0 to 3: NULL, and the console's
 *     jne slow
 *     cmp dword [esp+4], 0        ; NULL itself
 *     jne slow
 *     mov dword fs:[0x34], ERROR_INVALID_HANDLE
 *     or eax, -1                  ; WAIT_FAILED, whatever the timeout
 *     ret 8
 */

/**
 * Handles below four times this have a word: 64 KiB of table, and a program
 * has opened sixteen thousand handles before its next event is the host's.
 */
export const EVENT_SLOTS = 0x4000;

/** Mutexes with a word of their own (`mutex-words.js`): 64 KiB of them. */
export const MUTEX_SLOTS = 0x4000;

/** Events with a word of their own (`event-words.js`): 64 KiB of them. */
export const EVENT_WORD_SLOTS = 0x4000;

/** Semaphores with words of their own (`semaphore-words.js`), two each: 64 KiB of them. */
export const SEMAPHORE_SLOTS = 0x2000;

/**
 * What the kernel's words say, from the kernel (`kernel.EventMirror`,
 * `kernel.MUTEX_TAG`, `kernel.EVENT_TAG`); a semaphore's word has both tags.
 *
 * @typedef {Object} HandleWordValues
 * @property {number} clear     the word of an event with none of its own, not signalled
 * @property {number} set       the same, signalled
 * @property {number} invalid   the word of NULL, a handle nothing can be
 * @property {number} mutexTag  the low bits of a mutex's word
 * @property {number} eventTag  the low bits of an event's word
 */

const WAIT_TIMEOUT = 0x102;
const TEB_THREAD_ID = 0x24;
const TEB_LAST_ERROR = 0x34;
const ERROR_INVALID_HANDLE = 6;

/** An event's own word (`event-words.js`): its state, past which the host keeps it. */
const SIGNALLED = 0x1;
const MANUAL = 0x2;
const GUEST_STATES = SIGNALLED | MANUAL;

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** `jcc rel32` from `from` to `to`, the condition's second opcode byte given. */
const jcc = (/** @type {number} */ op, /** @type {number} */ from, /** @type {number} */ to)=>
    [0x0f, op, ...dword((to - (from + 6)) | 0)];

const JAE = 0x83;
const JB = 0x82;
const JE = 0x84;
const JNE = 0x85;
const JA = 0x87;

/**
 * @param {number} at     Where the code lands, for the jump to the trap.
 * @param {number} trap   The host's WaitForSingleObject.
 * @param {number} table  The kernel's words, one a handle.
 * @param {HandleWordValues} values
 * @param {number} semaphore  The wait on a semaphore (`semaphore-guest.js`), placed.
 * @returns {Uint8Array}
 */
export function waitOneCode(at, trap, table, { clear, invalid, mutexTag, eventTag }, semaphore){
    const poll = 43;
    const word = 62;
    const taken = 96;
    const mutex = 111;
    const held = 156;
    const slow = 187;
    const other = 192;
    const bytes = [
        0x8b, 0x44, 0x24, 0x04,                                      // 0: mov eax, [esp+4]
        0xc1, 0xe8, 0x02,                                            // 4: shr eax, 2
        0x3d, ...dword(EVENT_SLOTS),                                 // 7: cmp eax, EVENT_SLOTS
        ...jcc(JAE, 12, slow),                                       // 12: jae slow
        0x8b, 0x04, 0x85, ...dword(table),                           // 18: mov eax, [table+eax*4]
        0x83, 0xf8, 0x04,                                            // 25: cmp eax, 4
        ...jcc(JAE, 28, word),                                       // 28: jae word
        0x83, 0xf8, clear,                                           // 34: cmp eax, CLEAR
        ...jcc(JNE, 37, other),                                      // 37: jne other
        // poll: (43)
        0x83, 0x7c, 0x24, 0x08, 0x00,                                // 43: cmp dword [esp+8], 0
        ...jcc(JNE, 48, slow),                                       // 48: jne slow
        0xb8, ...dword(WAIT_TIMEOUT),                                // 54: mov eax, WAIT_TIMEOUT
        0xc2, 0x08, 0x00,                                            // 59: ret 8
        // word: (62)
        0xa8, mutexTag,                                              // 62: test al, MUTEX_TAG
        ...jcc(JNE, 64, mutex),                                      // 64: jnz mutex
        0x8d, 0x48, (-eventTag) & 0xff,                              // 70: lea ecx, [eax-EVENT_TAG]
        0x8b, 0x01,                                                  // 73: mov eax, [ecx]
        0xa8, SIGNALLED,                                             // 75: test al, SIGNALLED
        0x74, (poll - 79) & 0xff,                                    // 77: jz poll
        0x83, 0xf8, GUEST_STATES,                                    // 79: cmp eax, 3
        ...jcc(JA, 82, slow),                                        // 82: ja slow
        0x89, 0xc2,                                                  // 88: mov edx, eax
        0xa8, MANUAL,                                                // 90: test al, MANUAL
        0x75, taken - 94,                                            // 92: jnz taken
        0x31, 0xd2,                                                  // 94: xor edx, edx
        // taken: (96)
        0xf0, 0x0f, 0xb1, 0x11,                                      // 96: lock cmpxchg [ecx], edx
        ...jcc(JNE, 100, slow),                                      // 100: jne slow
        0x31, 0xc0,                                                  // 106: xor eax, eax
        0xc2, 0x08, 0x00,                                            // 108: ret 8
        // mutex: (111)
        0xa8, eventTag,                                              // 111: test al, EVENT_TAG
        ...jcc(JNE, 113, semaphore - at),                            // 113: jnz semaphore
        0x8d, 0x48, (-mutexTag) & 0xff,                              // 119: lea ecx, [eax-tag]
        0x64, 0x8b, 0x15, ...dword(TEB_THREAD_ID),                   // 122: mov edx, fs:[0x24]
        0xc1, 0xe2, 0x08,                                            // 129: shl edx, 8
        0x8b, 0x01,                                                  // 132: mov eax, [ecx]
        0x85, 0xc0,                                                  // 134: test eax, eax
        0x75, held - 138,                                            // 136: jnz held
        0x83, 0xca, 0x01,                                            // 138: or edx, 1
        0xf0, 0x0f, 0xb1, 0x11,                                      // 141: lock cmpxchg [ecx], edx
        ...jcc(JNE, 145, slow),                                      // 145: jne slow
        0x31, 0xc0,                                                  // 151: xor eax, eax
        0xc2, 0x08, 0x00,                                            // 153: ret 8
        // held: (156)
        0x31, 0xd0,                                                  // 156: xor eax, edx
        0x83, 0xf8, 0x7f,                                            // 158: cmp eax, 0x7f
        ...jcc(JAE, 161, slow),                                      // 161: jae slow
        0x31, 0xd0,                                                  // 167: xor eax, edx
        0x8d, 0x50, 0x01,                                            // 169: lea edx, [eax+1]
        0xf0, 0x0f, 0xb1, 0x11,                                      // 172: lock cmpxchg [ecx], edx
        ...jcc(JNE, 176, slow),                                      // 176: jne slow
        0x31, 0xc0,                                                  // 182: xor eax, eax
        0xc2, 0x08, 0x00,                                            // 184: ret 8
        // slow: (187)
        0xe9, ...dword(trap - (at + slow + 5)),                      // 187: jmp trap
        // other: (192)
        0x83, 0xf8, invalid,                                         // 192: cmp eax, INVALID
        0x75, (slow - 197) & 0xff,                                   // 195: jne slow
        0x83, 0x7c, 0x24, 0x04, 0x00,                                // 197: cmp dword [esp+4], 0
        0x75, (slow - 204) & 0xff,                                   // 202: jne slow
        0x64, 0xc7, 0x05, ...dword(TEB_LAST_ERROR),                  // 204: mov dword fs:[0x34],
        ...dword(ERROR_INVALID_HANDLE),                              //      ERROR_INVALID_HANDLE
        0x83, 0xc8, 0xff,                                            // 215: or eax, -1
        0xc2, 0x08, 0x00,                                            // 218: ret 8
    ];
    return new Uint8Array(bytes);
}

/**
 * ReleaseMutex as guest code: a mutex the caller owns and the host does not
 * keep is given back by one with `lock cmpxchg`, freed at its last; every
 * other call -- not the caller's, the host's to keep, an event's handle, a
 * handle with no word, a lost exchange -- is the host's, which answers
 * failures and their errors.
 *
 *     mov eax, [esp+4]
 *     shr eax, 2
 *     cmp eax, EVENT_SLOTS
 *     jae slow
 *     mov eax, [table+eax*4]
 *     cmp eax, 4
 *     jb slow                     ; an event's state, or nothing
 *     test al, MUTEX_TAG
 *     jz slow                     ; an event's own word
 *     test al, EVENT_TAG
 *     jnz slow                    ; a semaphore's
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
 * @param {HandleWordValues} values
 * @returns {Uint8Array}
 */
export function releaseMutexCode(at, trap, table, { mutexTag, eventTag }){
    const last = 105;
    const slow = 128;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // 0: mov eax, [esp+4]
        0xc1, 0xe8, 0x02,                                            // 4: shr eax, 2
        0x3d, ...dword(EVENT_SLOTS),                                 // 7: cmp eax, EVENT_SLOTS
        ...jcc(JAE, 12, slow),                                       // 12: jae slow
        0x8b, 0x04, 0x85, ...dword(table),                           // 18: mov eax, [table+eax*4]
        0x83, 0xf8, 0x04,                                            // 25: cmp eax, 4
        ...jcc(JB, 28, slow),                                        // 28: jb slow
        0xa8, mutexTag,                                              // 34: test al, MUTEX_TAG
        ...jcc(JE, 36, slow),                                        // 36: jz slow
        0xa8, eventTag,                                              // 42: test al, EVENT_TAG
        ...jcc(JNE, 44, slow),                                       // 44: jnz slow
        0x8d, 0x48, (-mutexTag) & 0xff,                              // 50: lea ecx, [eax-MUTEX_TAG]
        0x64, 0x8b, 0x15, ...dword(TEB_THREAD_ID),                   // 53: mov edx, fs:[0x24]
        0xc1, 0xe2, 0x08,                                            // 60: shl edx, 8
        0x8b, 0x01,                                                  // 63: mov eax, [ecx]
        0x31, 0xd0,                                                  // 65: xor eax, edx
        0x48,                                                        // 67: dec eax
        0x83, 0xf8, 0x7e,                                            // 68: cmp eax, 0x7e
        ...jcc(JA, 71, slow),                                        // 71: ja slow
        0x85, 0xc0,                                                  // 77: test eax, eax
        0x74, last - 81,                                             // 79: jz last
        0x40,                                                        // 81: inc eax
        0x31, 0xd0,                                                  // 82: xor eax, edx
        0x8d, 0x50, 0xff,                                            // 84: lea edx, [eax-1]
        0xf0, 0x0f, 0xb1, 0x11,                                      // 87: lock cmpxchg [ecx], edx
        ...jcc(JNE, 91, slow),                                       // 91: jne slow
        0xb8, ...dword(1),                                           // 97: mov eax, 1
        0xc2, 0x04, 0x00,                                            // 102: ret 4
        // last: (105)
        0x8d, 0x42, 0x01,                                            // 105: lea eax, [edx+1]
        0x31, 0xd2,                                                  // 108: xor edx, edx
        0xf0, 0x0f, 0xb1, 0x11,                                      // 110: lock cmpxchg [ecx], edx
        ...jcc(JNE, 114, slow),                                      // 114: jne slow
        0xb8, ...dword(1),                                           // 120: mov eax, 1
        0xc2, 0x04, 0x00,                                            // 125: ret 4
        // slow: (128)
        0xe9, ...dword(trap - (at + slow + 5)),                      // 128: jmp trap
    ]);
}

/**
 * SetEvent or ResetEvent as guest code. An event with a word of its own,
 * which the host does not keep, is set or cleared there with `lock cmpxchg`:
 * the host keeps every event a thread is queued on, so a word the guest has
 * is an event with no waiter to release. An event already in the state the
 * call asks for changes nothing and answers TRUE here, whoever keeps its word
 * (a signalled event has no waiter either), the word exchanged with itself to
 * order the caller's memory as a change would; an event with no word of its
 * own the same, by the state its handle's word says. Call of Duty 4 set events
 * already set 16.9 million times in a nine-minute session, 95% of its SetEvent
 * calls and two thirds of all its crossings, each from another executor a wait
 * for the process's executor to answer. Every other call is the host's: an
 * event to change that the host keeps or that has no word, a handle with no
 * word or past the table, a mutex's word, a lost exchange.
 *
 *     mov eax, [esp+4]
 *     shr eax, 2
 *     cmp eax, EVENT_SLOTS
 *     jae slow
 *     mov ecx, [table+eax*4]
 *     cmp ecx, state              ; no word of its own, in the state the call asks for
 *     je done
 *     cmp ecx, 4
 *     jb slow
 *     test cl, MUTEX_TAG
 *     jnz slow
 *     mov eax, [ecx-EVENT_TAG]    ; the event's word
 *     mov edx, eax
 *     test al, SIGNALLED
 *     jnz same                    ; ResetEvent: jz
 *     cmp eax, 3                  ; past SIGNALLED|MANUAL: the host keeps it
 *     ja slow
 *     or edx, SIGNALLED           ; ResetEvent: and edx, ~SIGNALLED
 *   same:
 *     lock cmpxchg [ecx-EVENT_TAG], edx
 *     jne slow
 *   done:
 *     mov eax, 1
 *     ret 4
 *   slow:
 *     jmp trap
 *
 * @param {number} at       Where the code lands, for the jump to the trap.
 * @param {number} trap     The host's SetEvent or ResetEvent.
 * @param {number} table    The kernel's words, one a handle.
 * @param {HandleWordValues} values
 * @param {boolean} signal  SetEvent; ResetEvent where false
 * @returns {Uint8Array}
 */
export function eventStateCode(at, trap, table, { clear, set, mutexTag, eventTag }, signal){
    const same = 73;
    const done = 84;
    const slow = 92;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                                      // 0: mov eax, [esp+4]
        0xc1, 0xe8, 0x02,                                            // 4: shr eax, 2
        0x3d, ...dword(EVENT_SLOTS),                                 // 7: cmp eax, EVENT_SLOTS
        ...jcc(JAE, 12, slow),                                       // 12: jae slow
        0x8b, 0x0c, 0x85, ...dword(table),                           // 18: mov ecx, [table+eax*4]
        0x83, 0xf9, signal ? set : clear,                            // 25: cmp ecx, state
        ...jcc(JE, 28, done),                                        // 28: je done
        0x83, 0xf9, 0x04,                                            // 34: cmp ecx, 4
        ...jcc(JB, 37, slow),                                        // 37: jb slow
        0xf6, 0xc1, mutexTag,                                        // 43: test cl, MUTEX_TAG
        ...jcc(JNE, 46, slow),                                       // 46: jnz slow
        0x8b, 0x41, (-eventTag) & 0xff,                              // 52: mov eax, [ecx-EVENT_TAG]
        0x89, 0xc2,                                                  // 55: mov edx, eax
        0xa8, SIGNALLED,                                             // 57: test al, SIGNALLED
        signal ? 0x75 : 0x74, same - 61,                             // 59: jnz same / jz same
        0x83, 0xf8, GUEST_STATES,                                    // 61: cmp eax, 3
        ...jcc(JA, 64, slow),                                        // 64: ja slow
        ...signal ? [0x83, 0xca, SIGNALLED]                          // 70: or edx, SIGNALLED
            : [0x83, 0xe2, ~SIGNALLED & 0xff],                       // 70: and edx, ~SIGNALLED
        // same: (73)
        0xf0, 0x0f, 0xb1, 0x51, (-eventTag) & 0xff,                  // 73: lock cmpxchg [ecx-1],edx
        ...jcc(JNE, 78, slow),                                       // 78: jne slow
        // done: (84)
        0xb8, ...dword(1),                                           // 84: mov eax, 1
        0xc2, 0x04, 0x00,                                            // 89: ret 4
        // slow: (92)
        0xe9, ...dword(trap - (at + slow + 5)),                      // 92: jmp trap
    ]);
}

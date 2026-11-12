/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interlocked arithmetic, as guest code.
 *
 * Each of these is one locked instruction on the program's own dword, and a
 * program calls them where it counts references -- an AddRef and a Release, a
 * string a runtime shares -- so a crossing into the host cost many times the
 * work it did. As guest code the operation is atomic for the reason it is on
 * Windows: the scheduler preempts only between instructions, and the read,
 * the change and the write are one of them. A pointer the program got wrong
 * faults in the guest, at the instruction that touched it.
 *
 * All five are stdcall and position-independent: they read their arguments
 * off the stack, touch nothing but ECX, EDX, EAX and the flags, and reach no
 * other code, so they are placed as they are. A 64-bit process runs no i386:
 * there each is the same locked instruction on the arguments x64 passes in
 * RCX, EDX and R8D (`long`), code of the module rather than a trap.
 */

/**
 * LONG InterlockedIncrement(LONG volatile *Addend): the value after.
 *
 *     mov ecx, [esp+4]
 *     mov eax, 1
 *     lock xadd [ecx], eax    ; eax = the value before
 *     inc eax
 *     ret 4
 */
export const INCREMENT_CODE = Uint8Array.of(
    0x8b, 0x4c, 0x24, 0x04,
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xf0, 0x0f, 0xc1, 0x01,
    0x40,
    0xc2, 0x04, 0x00,
);

/**
 * LONG InterlockedDecrement(LONG volatile *Addend): the value after.
 *
 *     mov ecx, [esp+4]
 *     mov eax, -1
 *     lock xadd [ecx], eax
 *     dec eax
 *     ret 4
 */
export const DECREMENT_CODE = Uint8Array.of(
    0x8b, 0x4c, 0x24, 0x04,
    0xb8, 0xff, 0xff, 0xff, 0xff,
    0xf0, 0x0f, 0xc1, 0x01,
    0x48,
    0xc2, 0x04, 0x00,
);

/**
 * LONG InterlockedExchange(LONG volatile *Target, LONG Value): the value
 * before. `xchg` with memory is locked without the prefix.
 *
 *     mov ecx, [esp+4]
 *     mov eax, [esp+8]
 *     xchg [ecx], eax
 *     ret 8
 */
export const EXCHANGE_CODE = Uint8Array.of(
    0x8b, 0x4c, 0x24, 0x04,
    0x8b, 0x44, 0x24, 0x08,
    0x87, 0x01,
    0xc2, 0x08, 0x00,
);

/**
 * LONG InterlockedExchangeAdd(LONG volatile *Addend, LONG Value): the value
 * before.
 *
 *     mov ecx, [esp+4]
 *     mov eax, [esp+8]
 *     lock xadd [ecx], eax
 *     ret 8
 */
export const EXCHANGE_ADD_CODE = Uint8Array.of(
    0x8b, 0x4c, 0x24, 0x04,
    0x8b, 0x44, 0x24, 0x08,
    0xf0, 0x0f, 0xc1, 0x01,
    0xc2, 0x08, 0x00,
);

/**
 * LONG InterlockedCompareExchange(LONG volatile *Destination, LONG Exchange,
 * LONG Comparand): the value before, whether or not it was exchanged.
 *
 *     mov ecx, [esp+4]
 *     mov edx, [esp+8]
 *     mov eax, [esp+12]
 *     lock cmpxchg [ecx], edx
 *     ret 12
 */
export const COMPARE_EXCHANGE_CODE = Uint8Array.of(
    0x8b, 0x4c, 0x24, 0x04,
    0x8b, 0x54, 0x24, 0x08,
    0x8b, 0x44, 0x24, 0x0c,
    0xf0, 0x0f, 0xb1, 0x11,
    0xc2, 0x0c, 0x00,
);

/**
 * The five at 64 bits, the pointer in RCX, the value in EDX, the comparand
 * in R8D:
 *
 *     Increment:        mov eax, 1;  lock xadd [rcx], eax; inc eax; ret
 *     Decrement:        mov eax, -1; lock xadd [rcx], eax; dec eax; ret
 *     Exchange:         mov eax, edx; xchg [rcx], eax; ret
 *     ExchangeAdd:      mov eax, edx; lock xadd [rcx], eax; ret
 *     CompareExchange:  mov eax, r8d; lock cmpxchg [rcx], edx; ret
 */
export const LONG_INCREMENT_CODE = Uint8Array.of(
    0xb8, 0x01, 0x00, 0x00, 0x00, 0xf0, 0x0f, 0xc1, 0x01, 0xff, 0xc0, 0xc3);
export const LONG_DECREMENT_CODE = Uint8Array.of(
    0xb8, 0xff, 0xff, 0xff, 0xff, 0xf0, 0x0f, 0xc1, 0x01, 0xff, 0xc8, 0xc3);
export const LONG_EXCHANGE_CODE = Uint8Array.of(0x89, 0xd0, 0x87, 0x01, 0xc3);
export const LONG_EXCHANGE_ADD_CODE = Uint8Array.of(
    0x89, 0xd0, 0xf0, 0x0f, 0xc1, 0x01, 0xc3);
export const LONG_COMPARE_EXCHANGE_CODE = Uint8Array.of(
    0x44, 0x89, 0xc0, 0xf0, 0x0f, 0xb1, 0x11, 0xc3);

/** Each export, the stack it pops and its code, at 32 bits and at 64 (`long`). */
export const INTERLOCKED = Object.freeze({
    InterlockedIncrement: { argBytes: 4, code: INCREMENT_CODE, long: LONG_INCREMENT_CODE },
    InterlockedDecrement: { argBytes: 4, code: DECREMENT_CODE, long: LONG_DECREMENT_CODE },
    InterlockedExchange: { argBytes: 8, code: EXCHANGE_CODE, long: LONG_EXCHANGE_CODE },
    InterlockedExchangeAdd: { argBytes: 8, code: EXCHANGE_ADD_CODE,
        long: LONG_EXCHANGE_ADD_CODE },
    InterlockedCompareExchange: { argBytes: 12, code: COMPARE_EXCHANGE_CODE,
        long: LONG_COMPARE_EXCHANGE_CODE },
});

/**
 * LONGLONG InterlockedCompareExchange64(LONGLONG volatile *Destination,
 * LONGLONG Exchange, LONGLONG Comparand): the value before, in EDX:EAX,
 * whether or not it was exchanged. The exchange goes in ECX:EBX, so EBX is
 * kept around it, and ESI with it for the pointer.
 *     push ebx
 *     push esi
 *     mov esi, [esp+12]
 *     mov ebx, [esp+16]
 *     mov ecx, [esp+20]
 *     mov eax, [esp+24]
 *     mov edx, [esp+28]
 *     lock cmpxchg8b [esi]
 *     pop esi
 *     pop ebx
 *     ret 20
 * At 64 bits: mov rax, r8; lock cmpxchg [rcx], rdx; ret.
 */
export const COMPARE_EXCHANGE64_CODE = Uint8Array.of(
    0x53, 0x56,
    0x8b, 0x74, 0x24, 0x0c,
    0x8b, 0x5c, 0x24, 0x10,
    0x8b, 0x4c, 0x24, 0x14,
    0x8b, 0x44, 0x24, 0x18,
    0x8b, 0x54, 0x24, 0x1c,
    0xf0, 0x0f, 0xc7, 0x0e,
    0x5e, 0x5b,
    0xc2, 0x14, 0x00,
);
export const LONG_COMPARE_EXCHANGE64_CODE = Uint8Array.of(
    0x4c, 0x89, 0xc0, 0xf0, 0x48, 0x0f, 0xb1, 0x11, 0xc3);

/**
 * The quadword one, beside the five: Windows Vista's, which a library built
 * for it imports (ASP.NET's webengine4.dll).
 */
export const INTERLOCKED_64 = Object.freeze({
    InterlockedCompareExchange64: { argBytes: 20, code: COMPARE_EXCHANGE64_CODE,
        long: LONG_COMPARE_EXCHANGE64_CODE },
});

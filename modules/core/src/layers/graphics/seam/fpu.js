/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What Direct3D 8 and 9 do to the calling thread's x87 when a device is made
 * without D3DCREATE_FPU_PRESERVE: single precision, rounding to nearest, and
 * every exception masked -- the control word's precision, rounding and mask
 * fields cleared and the six mask bits set, as Wine's `setup_fpu` does. A
 * program's runtime reads the masks to decide whether a domain error in its
 * maths raises STATUS_FLOAT_INVALID_OPERATION or answers a NaN; left as the
 * program found them, a game that never unmasked anything on Windows could
 * end on an exception Windows never raised.
 *
 * It is the thread's own register, so it is set in the guest, in the slot of
 * CreateDevice, which then goes on to the method's trap with the stack as it
 * came.
 */

/** D3DCREATE_FPU_PRESERVE. */
const FPU_PRESERVE = 0x2;

/**
 * The slot's code at `at`, ahead of the trap: BehaviorFlags is the method's
 * fourth argument in IDirect3D8::CreateDevice, IDirect3D9::CreateDevice and
 * IDirect3D9Ex::CreateDeviceEx alike.
 *
 *     sub esp, 4
 *     fnstcw [esp]
 *     test byte [esp+24], FPU_PRESERVE   ; flags: past the word, the return, this, three
 *     jnz kept
 *     and word [esp], 0xf0c0             ; precision, rounding and masks cleared
 *     or word [esp], 0x3f                ; every exception masked
 *     fldcw [esp]
 *   kept:
 *     add esp, 4
 *     jmp trap
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function fpuSetupCode(at, trap){
    const head = [
        0x83, 0xec, 0x04,
        0xd9, 0x3c, 0x24,
        0xf6, 0x44, 0x24, 0x18, FPU_PRESERVE,
        0x75, 0x0e,
        0x66, 0x81, 0x24, 0x24, 0xc0, 0xf0,
        0x66, 0x83, 0x0c, 0x24, 0x3f,
        0xd9, 0x2c, 0x24,
        0x83, 0xc4, 0x04,
        0xe9,
    ];
    const relative = (trap - (at + head.length + 4)) | 0;
    return Uint8Array.from([...head, relative & 0xff, relative >>> 8 & 0xff,
        relative >>> 16 & 0xff, relative >>> 24 & 0xff]);
}

/**
 * The routine's shape, for whoever follows a slot to its trap without
 * running it: its first dword, and where its `jmp rel32`'s displacement is
 * and ends.
 */
export const FPU_SETUP = Object.freeze({ HEAD: 0xd904ec83, JUMP: 31, LENGTH: 35 });

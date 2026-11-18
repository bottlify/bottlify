/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The floating-point groups of a 32-bit CONTEXT: CONTEXT_FLOATING_POINT's
 * FLOATING_SAVE_AREA and CONTEXT_EXTENDED_REGISTERS' 512 bytes, laid into the
 * record from the processor's images of a thread's x87 and SSE state and
 * taken out of it again (the images are the cpu layer's, `fpu-image.js`).
 *
 * Every path a context travels goes through here - GetThreadContext,
 * SetThreadContext, the record an exception's handler is handed and continues
 * from, NtContinue - because a runtime that suspends a thread to collect its
 * garbage (.NET's) takes the context whole and puts it back whole, and a
 * thread stopped between a call that left its result in ST(0) and the
 * instruction that takes it went on with somebody else's registers wherever
 * one path left the groups out.
 */

/** ContextFlags' floating-point groups (winnt.h). */
export const CONTEXT_FLOATING_POINT = 0x10008;
export const CONTEXT_EXTENDED_REGISTERS = 0x10020;
/** Where the groups are in the record, and how long. */
const FLOAT_SAVE_AT = 0x1c;
const FLOAT_SAVE_BYTES = 112;
const EXTENDED_AT = 0xcc;
const EXTENDED_BYTES = 512;

/**
 * @typedef {{ floatSave?: Uint8Array, extended?: Uint8Array }} FloatImages
 */

/**
 * The processor's side, as win32 is handed it.
 *
 * @typedef {Object} FloatState
 * @property {(context?: any) => Required<FloatImages> | null} images
 *           The images of a stopped thread's context, or of the running
 *           thread with none given; null where there is no state to read.
 * @property {(context: any, images: FloatImages) => boolean} restore
 *           Puts images back into a stopped thread's context, or into the
 *           running thread with null; false where there is nothing to take them.
 */

/**
 * Lays the groups `flags` names into a record's bytes.
 *
 * @param {FloatImages | null} images @param {Uint8Array} bytes @param {number} flags
 */
export function writeFloatGroups(images, bytes, flags){
    if ((flags & CONTEXT_FLOATING_POINT) === CONTEXT_FLOATING_POINT && images?.floatSave)
    {
        bytes.set(images.floatSave.subarray(0, FLOAT_SAVE_BYTES), FLOAT_SAVE_AT);
    }
    if ((flags & CONTEXT_EXTENDED_REGISTERS) === CONTEXT_EXTENDED_REGISTERS && images?.extended)
    {
        bytes.set(images.extended, EXTENDED_AT);
    }
}

/**
 * The groups a record's flags name, taken out of its bytes: the extended
 * registers where they are named (the x87 registers are among them), else the
 * FLOATING_SAVE_AREA; null where the flags name neither.
 *
 * @param {Uint8Array} bytes @param {number} flags
 * @returns {FloatImages | null}
 */
export function floatGroupsOf(bytes, flags){
    if ((flags & CONTEXT_EXTENDED_REGISTERS) === CONTEXT_EXTENDED_REGISTERS)
    {
        return { extended: bytes.slice(EXTENDED_AT, EXTENDED_AT + EXTENDED_BYTES) };
    }
    if ((flags & CONTEXT_FLOATING_POINT) === CONTEXT_FLOATING_POINT)
    {
        return { floatSave: bytes.slice(FLOAT_SAVE_AT, FLOAT_SAVE_AT + FLOAT_SAVE_BYTES) };
    }
    return null;
}

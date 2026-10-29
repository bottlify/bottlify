/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An exception a host handler raises in the guest, as the function on
 * Windows raises it: InitializeCriticalSectionEx's STATUS_INVALID_HANDLE, a
 * division's STATUS_INTEGER_DIVIDE_BY_ZERO. The handler throws it; the
 * dispatcher hands it to the exception dispatch, which raises it on the
 * calling thread with the code, flags and ExceptionInformation given, the
 * address the call's own. The program's handlers see it as they would on
 * Windows; one that continues gets the call back answering zero, and none
 * at all ends the process with it.
 *
 * Told apart by `code`, the way memory's GUEST_ACCESS is, because the
 * dispatcher that catches it is in a layer below this one.
 */

export const GUEST_EXCEPTION = 'GUEST_EXCEPTION';

/**
 * @typedef {Error & { code: typeof GUEST_EXCEPTION, status: number, flags: number,
 *     parameters: number[] }} GuestException
 */

/**
 * @param {number} status  The exception code, an NTSTATUS.
 * @param {number} [flags]  EXCEPTION_NONCONTINUABLE (1), or none.
 * @param {number[]} [parameters]  ExceptionInformation, at most fifteen.
 * @returns {GuestException}
 */
export function guestException(status, flags = 0, parameters = []){
    const error = /** @type {GuestException} */ (new Error(
        `exception 0x${(status >>> 0).toString(16)} raised in the guest`));
    error.code = GUEST_EXCEPTION;
    error.status = status >>> 0;
    error.flags = flags >>> 0;
    error.parameters = parameters.slice(0, 15).map(value=>value >>> 0);
    return error;
}

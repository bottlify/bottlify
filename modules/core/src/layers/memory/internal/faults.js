/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two ways a guest address can fail a host read or write, told apart by
 * `code` rather than by message, because the caller's answer differs.
 *
 * A fault is the access a processor would have refused: the guest pointer is
 * not there, or not for this. Windows raises STATUS_ACCESS_VIOLATION for it,
 * or answers with an error where the function guards its argument. A string
 * with no terminator within the caller's limit is no fault at all -- the
 * memory is there -- and is what an API with a length limit (an atom name, a
 * path) answers with its own error. A layer above tells them apart by
 * `code` alone: it cannot import this module.
 */

/** A read or write the processor would have refused. */
export const GUEST_FAULT = 'GUEST_FAULT';
/** A string whose terminator is not within the limit asked for. */
export const UNTERMINATED = 'UNTERMINATED';

/**
 * @typedef {Error & { code: typeof GUEST_FAULT, address: number, length: number,
 *     mode: 'read' | 'write' | 'execute' }} GuestFault
 * @typedef {Error & { code: typeof UNTERMINATED, address: number, limit: number }} Unterminated
 */

/**
 * @param {string} message
 * @param {number} address  The first byte refused.
 * @param {number} length
 * @param {'read' | 'write' | 'execute'} mode
 * @returns {GuestFault}
 */
export function guestFault(message, address, length, mode){
    const error = /** @type {GuestFault} */ (new Error(message));
    error.code = GUEST_FAULT;
    error.address = address >>> 0;
    error.length = length;
    error.mode = mode;
    return error;
}

/**
 * @param {string} message
 * @param {number} address
 * @param {number} limit  In bytes.
 * @returns {Unterminated}
 */
export function unterminated(message, address, limit){
    const error = /** @type {Unterminated} */ (new Error(message));
    error.code = UNTERMINATED;
    error.address = address >>> 0;
    error.limit = limit;
    return error;
}

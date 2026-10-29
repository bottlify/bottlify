/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The rights a handle opened by name is granted: what the caller asked for,
 * its generic rights mapped to the kind's own, and refused where it asked for
 * nothing or for a right the kind does not have. A handle carries what it was
 * granted, and a call that needs a right it lacks fails as Windows' does --
 * a wait without SYNCHRONIZE, SetEvent without EVENT_MODIFY_STATE.
 */

export const SYNCHRONIZE = 0x00100000;
/** The query and modify rights of an event, a semaphore and a waitable timer. */
export const QUERY_STATE = 0x0001;
export const MODIFY_STATE = 0x0002;

/** DELETE, READ_CONTROL, WRITE_DAC, WRITE_OWNER and SYNCHRONIZE. */
const STANDARD_RIGHTS_ALL = 0x001f0000;
/** READ_CONTROL, which each of STANDARD_RIGHTS_READ, _WRITE and _EXECUTE is. */
const READ_CONTROL = 0x00020000;
const ACCESS_SYSTEM_SECURITY = 0x01000000;
const MAXIMUM_ALLOWED = 0x02000000;
const GENERIC_ALL = 0x10000000;
const GENERIC_EXECUTE = 0x20000000;
const GENERIC_WRITE = 0x40000000;
const GENERIC_READ = 0x80000000;

const ERROR_ACCESS_DENIED = 5;
const ERROR_PRIVILEGE_NOT_HELD = 1314;

/**
 * Each kind's own rights, and what its generic rights stand for (winnt.h's
 * MUTANT_*, EVENT_*, SEMAPHORE_*, TIMER_* and the objects' generic mappings).
 *
 * @type {Record<string, { own: number, read: number, write: number, execute: number }>}
 */
const KINDS = {
    mutex: { own: QUERY_STATE, read: READ_CONTROL | QUERY_STATE, write: READ_CONTROL,
        execute: READ_CONTROL | SYNCHRONIZE },
    event: { own: QUERY_STATE | MODIFY_STATE, read: READ_CONTROL | QUERY_STATE,
        write: READ_CONTROL | MODIFY_STATE, execute: READ_CONTROL | SYNCHRONIZE },
    semaphore: { own: QUERY_STATE | MODIFY_STATE, read: READ_CONTROL | QUERY_STATE,
        write: READ_CONTROL | MODIFY_STATE, execute: READ_CONTROL | SYNCHRONIZE },
    timer: { own: QUERY_STATE | MODIFY_STATE, read: READ_CONTROL | QUERY_STATE,
        write: READ_CONTROL | MODIFY_STATE, execute: READ_CONTROL | SYNCHRONIZE },
};

/**
 * What an open asking for `desired` is granted: null for every right, the
 * rights where fewer, or the error it fails with.
 *
 * @param {string} kind @param {number} desired
 * @returns {{ granted: number | null } | { error: number }}
 */
export function grantedAccess(kind, desired){
    const rights = KINDS[kind];
    const asked = desired >>> 0;
    if (!rights)
    {
        return { granted: null };
    }
    const all = (STANDARD_RIGHTS_ALL | rights.own) >>> 0;
    if ((asked & ACCESS_SYSTEM_SECURITY) !== 0)
    {
        return { error: ERROR_PRIVILEGE_NOT_HELD };
    }
    const known = all | MAXIMUM_ALLOWED | GENERIC_ALL | GENERIC_EXECUTE | GENERIC_WRITE
        | GENERIC_READ;
    if (asked === 0 || (asked & ~known) !== 0)
    {
        return { error: ERROR_ACCESS_DENIED };
    }
    if ((asked & (MAXIMUM_ALLOWED | GENERIC_ALL)) !== 0)
    {
        return { granted: null };
    }
    const granted = (asked & all) | ((asked & GENERIC_READ) ? rights.read : 0)
        | ((asked & GENERIC_WRITE) ? rights.write : 0)
        | ((asked & GENERIC_EXECUTE) ? rights.execute : 0);
    return { granted: (granted >>> 0) === all ? null : granted >>> 0 };
}

/**
 * Whether a handle may do what needs `right`: every handle may that was
 * granted every right.
 *
 * @param {number | null} granted @param {number} right
 */
export const allows = (granted, right)=>granted === null || (granted & right) === right;

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
/** A keyed event's two rights: to wait on a key, and to release one. */
export const KEYEDEVENT_WAIT = 0x0001;
export const KEYEDEVENT_WAKE = 0x0002;

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

/** A thread's own rights, and the ones a query or a change of its information needs. */
const THREAD_RIGHTS = 0xffff;
export const THREAD_SET_INFORMATION = 0x0020;
export const THREAD_QUERY_INFORMATION = 0x0040;
export const THREAD_SET_LIMITED_INFORMATION = 0x0400;
export const THREAD_QUERY_LIMITED_INFORMATION = 0x0800;

const ERROR_ACCESS_DENIED = 5;
const ERROR_PRIVILEGE_NOT_HELD = 1314;

/**
 * Each kind's own rights, and what its generic rights stand for (winnt.h's
 * MUTANT_*, EVENT_*, SEMAPHORE_*, TIMER_*, KEYEDEVENT_*, THREAD_* and the objects' generic
 * mappings); `implied`, a right that carries a lesser one with it.
 *
 * @type {Record<string, { own: number, read: number, write: number, execute: number,
 *     implied?: [number, number][] }>}
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
    // KEYEDEVENT_ALL_ACCESS has no SYNCHRONIZE: a wait on the handle needs it asked.
    keyedevent: { own: KEYEDEVENT_WAIT | KEYEDEVENT_WAKE, read: READ_CONTROL | KEYEDEVENT_WAIT,
        write: READ_CONTROL | KEYEDEVENT_WAKE, execute: READ_CONTROL },
    // THREAD_TERMINATE and on, the low word. Read is GET_CONTEXT and
    // QUERY_INFORMATION; write TERMINATE, SUSPEND_RESUME, SET_CONTEXT and
    // SET_INFORMATION; QUERY_INFORMATION and SET_INFORMATION carry their
    // limited forms with them.
    thread: { own: THREAD_RIGHTS, read: READ_CONTROL | 0x0048, write: READ_CONTROL | 0x0033,
        execute: READ_CONTROL | SYNCHRONIZE,
        implied: [[THREAD_QUERY_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION],
            [THREAD_SET_INFORMATION, THREAD_SET_LIMITED_INFORMATION]] },
    // PROCESS_TERMINATE and on, the low word. Read is VM_READ and
    // QUERY_INFORMATION; write CREATE_THREAD, VM_OPERATION, VM_WRITE,
    // DUP_HANDLE, CREATE_PROCESS, SET_QUOTA, SET_INFORMATION and
    // SUSPEND_RESUME; execute TERMINATE and QUERY_LIMITED_INFORMATION.
    // QUERY_INFORMATION and SET_INFORMATION carry their limited forms.
    process: { own: 0xffff, read: READ_CONTROL | 0x0410, write: READ_CONTROL | 0x0bea,
        execute: READ_CONTROL | SYNCHRONIZE | 0x1001,
        implied: [[0x0400, 0x1000], [0x0200, 0x2000]] },
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
    let granted = (asked & all) | ((asked & GENERIC_READ) ? rights.read : 0)
        | ((asked & GENERIC_WRITE) ? rights.write : 0)
        | ((asked & GENERIC_EXECUTE) ? rights.execute : 0);
    for (const [right, lesser] of rights.implied ?? [])
    {
        granted |= (granted & right) !== 0 ? lesser : 0;
    }
    return { granted: (granted >>> 0) === all ? null : granted >>> 0 };
}

/**
 * Whether a handle may do what needs `right`: every handle may that was
 * granted every right.
 *
 * @param {number | null} granted @param {number} right
 */
export const allows = (granted, right)=>granted === null || (granted & right) === right;

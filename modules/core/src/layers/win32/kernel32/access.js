/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

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

/** A file's rights to its data: to read, to write anywhere, to write at its end. */
export const FILE_READ_DATA = 0x0001;
export const FILE_WRITE_DATA = 0x0002;
export const FILE_APPEND_DATA = 0x0004;
/** What CreateFile asks beside what its caller asked: to wait on it and read its attributes. */
export const FILE_IMPLIED = SYNCHRONIZE | 0x0080;

/** A thread's own rights, and the ones a query or a change of its information needs. */
const THREAD_RIGHTS = 0xffff;
const THREAD_SET_INFORMATION = 0x0020;
export const THREAD_QUERY_INFORMATION = 0x0040;
const THREAD_SET_LIMITED_INFORMATION = 0x0400;
export const THREAD_QUERY_LIMITED_INFORMATION = 0x0800;

const ERROR_ACCESS_DENIED = 5;
const ERROR_PRIVILEGE_NOT_HELD = 1314;

/** A file object's rights: a file's, a directory's, a pipe end's. */
const FILE_RIGHTS = { own: 0x01ff, read: READ_CONTROL | SYNCHRONIZE | 0x0089,
    write: READ_CONTROL | SYNCHRONIZE | 0x0116, execute: READ_CONTROL | SYNCHRONIZE | 0x00a0,
    bounded: true };

/**
 * Each kind's own rights, and what its generic rights stand for (winnt.h's
 * MUTANT_*, EVENT_*, SEMAPHORE_*, TIMER_*, KEYEDEVENT_*, THREAD_*, FILE_* and the objects'
 * generic mappings); `implied`, a right that carries a lesser one with it; `bounded`, a kind
 * whose duplicate cannot be granted a right its source handle lacks.
 *
 * @type {Record<string, { own: number, read: number, write: number, execute: number,
 *     implied?: [number, number][], bounded?: boolean }>}
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
    // A section's: QUERY, MAP_WRITE, MAP_READ, MAP_EXECUTE and EXTEND_SIZE,
    // FILE_MAP_* by another name; a section has no SYNCHRONIZE of its own.
    mapping: { own: 0x001f, read: READ_CONTROL | 0x0005, write: READ_CONTROL | 0x0002,
        execute: READ_CONTROL | 0x0008 },
    // FILE_READ_DATA and on, FILE_ALL_ACCESS's low bits. FILE_GENERIC_READ is
    // READ_DATA, READ_ATTRIBUTES, READ_EA; _WRITE WRITE_DATA, APPEND_DATA,
    // WRITE_ATTRIBUTES, WRITE_EA; _EXECUTE EXECUTE and READ_ATTRIBUTES - each
    // with SYNCHRONIZE. A file object's rights are what it was opened with:
    // a duplicate asking more is refused (Wine's kernel32:file test_file_access).
    file: FILE_RIGHTS,
    // A pipe end is a file object of the pipe file system, with a file's rights.
    pipe: FILE_RIGHTS,
};

/**
 * The rights `desired` stands for once its generic rights are mapped to the
 * kind's own, refusing nothing: null for every right. An open that may ask
 * for none, a file's, is granted what this answers.
 *
 * @param {string} kind @param {number} desired
 * @returns {number | null}
 */
export function mappedAccess(kind, desired){
    const rights = KINDS[kind];
    const asked = wholeAddress(desired);
    if (!rights || (asked & (MAXIMUM_ALLOWED | GENERIC_ALL)) !== 0)
    {
        return null;
    }
    const all = (STANDARD_RIGHTS_ALL | rights.own) >>> 0;
    let granted = (asked & all) | ((asked & GENERIC_READ) ? rights.read : 0)
        | ((asked & GENERIC_WRITE) ? rights.write : 0)
        | ((asked & GENERIC_EXECUTE) ? rights.execute : 0);
    for (const [right, lesser] of rights.implied ?? [])
    {
        granted |= (granted & right) !== 0 ? lesser : 0;
    }
    return (granted >>> 0) === all ? null : granted >>> 0;
}

/**
 * What an open asking for `desired` is granted: null for every right, the
 * rights where fewer, or the error it fails with.
 *
 * @param {string} kind @param {number} desired
 * @returns {{ granted: number | null } | { error: number }}
 */
export function grantedAccess(kind, desired){
    const rights = KINDS[kind];
    const asked = wholeAddress(desired);
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
    return { granted: mappedAccess(kind, asked) };
}

/**
 * What a duplicate of a handle is granted (DuplicateHandle, NtDuplicateObject):
 * with DUPLICATE_SAME_ACCESS the source handle's rights; otherwise what was
 * asked, its generic rights mapped to the kind's own - and asking for nothing
 * is a handle with no rights at all, not a refusal as an open by name is. A
 * kind whose rights are its source's to give (`bounded`, a file) refuses a
 * right the source lacks, ERROR_ACCESS_DENIED.
 *
 * @param {string} kind @param {number} desired
 * @param {number | null} source  the source handle's rights
 * @param {boolean} same  DUPLICATE_SAME_ACCESS
 * @returns {{ granted: number | null } | { error: number }}
 */
export function duplicateAccess(kind, desired, source, same){
    if (same)
    {
        return { granted: source };
    }
    if ((desired >>> 0) === 0)
    {
        return { granted: 0 };
    }
    const asked = grantedAccess(kind, desired);
    if (KINDS[kind]?.bounded && 'granted' in asked && source !== null
        && (asked.granted === null || (asked.granted & ~source) !== 0))
    {
        return { error: ERROR_ACCESS_DENIED };
    }
    return asked;
}

/**
 * Whether a handle may do what needs `right`: every handle may that was
 * granted every right.
 *
 * @param {number | null} granted @param {number} right
 */
export const allows = (granted, right)=>granted === null || (granted & right) === right;

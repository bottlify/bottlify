/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * NtCompareObjects, the native form of CompareObjectHandles over kernel32's
 * own entry so a handle has one table, and the native calls about an
 * object's lifetime. They answer a status and leave the thread's last error
 * as it was. NtDuplicateObject and NtClose are kernel32's own natives, which
 * DuplicateHandle and CloseHandle answer from.
 */

import { STATUS } from './status.js';

/** STATUS_NOT_SAME_OBJECT: two handles onto different objects. */
const STATUS_NOT_SAME_OBJECT = 0xc00001ac;
/** STATUS_PRIVILEGE_NOT_HELD: a user without SeCreatePermanentPrivilege. */
const STATUS_PRIVILEGE_NOT_HELD = 0xc0000061;
/** STATUS_NO_CALLBACK_ACTIVE: NtCallbackReturn with no kernel callback to return from. */
const STATUS_NO_CALLBACK_ACTIVE = 0xc0000258;

/** The kernel32 entries these stand on. */
export const HANDLE_ENTRIES = Object.freeze(['CompareObjectHandles', 'GetLastError',
    'SetLastError']);

/**
 * @typedef {Object} HandleNativesHost
 * @property {Record<string, { argBytes?: number, handler: Function }>} kernel32
 */

/** @param {HandleNativesHost} host */
export function createHandleNatives({ kernel32 }){
    /**
     * Runs a kernel32 call and puts the thread's last error back as it was.
     *
     * @template T @param {() => T} call @returns {[T, number]} the answer and its error
     */
    const keepingLastError = call=>{
        const before = kernel32.GetLastError.handler([]) >>> 0;
        kernel32.SetLastError.handler([0]);
        const answer = call();
        const error = kernel32.GetLastError.handler([]) >>> 0;
        kernel32.SetLastError.handler([before]);
        return [answer, error];
    };

    /** @param {number} handle @returns {boolean} a handle onto an object */
    const opens = handle=>keepingLastError(()=>
        kernel32.CompareObjectHandles.handler([handle, handle]))[0] !== 0;

    return {
        /**
         * NTSTATUS NtMakeTemporaryObject(HANDLE): a named object's name goes
         * with its last handle - what every object made here does already.
         */
        NtMakeTemporaryObject: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(opens(handle) ? STATUS.SUCCESS : STATUS.INVALID_HANDLE),
        },

        /**
         * NTSTATUS NtMakePermanentObject(HANDLE): keeping a name past its last
         * handle takes SeCreatePermanentPrivilege, which the interactive
         * user's token does not hold.
         */
        NtMakePermanentObject: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(opens(handle) ? STATUS_PRIVILEGE_NOT_HELD
                : STATUS.INVALID_HANDLE),
        },

        /**
         * NTSTATUS NtCallbackReturn(PVOID Result, ULONG ResultLength, NTSTATUS):
         * the end of a callback the kernel made into user mode; no window
         * procedure here is entered that way, so there is none to return from.
         */
        NtCallbackReturn: {
            argBytes: 12,
            handler: ()=>STATUS_NO_CALLBACK_ACTIVE,
        },

        /**
         * NTSTATUS NtCompareObjects(HANDLE First, HANDLE Second): one object
         * behind both, or STATUS_NOT_SAME_OBJECT.
         */
        NtCompareObjects: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const [same] = keepingLastError(()=>
                    kernel32.CompareObjectHandles.handler([first, second]));
                return same !== 0 ? STATUS.SUCCESS : STATUS_NOT_SAME_OBJECT;
            },
        },
    };
}

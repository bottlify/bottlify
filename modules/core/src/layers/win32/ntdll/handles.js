/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * NtDuplicateObject and NtCompareObjects: the native forms of DuplicateHandle
 * and CompareObjectHandles, over kernel32's own entries so a handle has one
 * table, and the native calls about an object's lifetime. They answer a
 * status and leave the thread's last error as it was.
 */

import { STATUS } from './status.js';
import { wholeAddress } from '../common/pointers.js';

/** HandleAttributes: the duplicate is inherited by a child. */
const OBJ_INHERIT = 0x02;
/** The options DuplicateHandle shares; DUPLICATE_SAME_ATTRIBUTES is the native call's own. */
const DUPLICATE_CLOSE_SOURCE = 0x01;
const DUPLICATE_SAME_ACCESS = 0x02;

/** STATUS_NOT_SAME_OBJECT: two handles onto different objects. */
const STATUS_NOT_SAME_OBJECT = 0xc00001ac;
/** STATUS_PRIVILEGE_NOT_HELD: a user without SeCreatePermanentPrivilege. */
const STATUS_PRIVILEGE_NOT_HELD = 0xc0000061;
/** STATUS_NO_CALLBACK_ACTIVE: NtCallbackReturn with no kernel callback to return from. */
const STATUS_NO_CALLBACK_ACTIVE = 0xc0000258;

/** The status a win32 error of DuplicateHandle's stands for. */
const STATUS_OF_ERROR = new Map([
    [5, STATUS.ACCESS_DENIED],
    [6, STATUS.INVALID_HANDLE],
    [50, STATUS.NOT_SUPPORTED],
    [87, STATUS.INVALID_PARAMETER],
]);

/** The kernel32 entries these stand on. */
export const HANDLE_ENTRIES = Object.freeze(['DuplicateHandle', 'CompareObjectHandles',
    'GetLastError', 'SetLastError']);

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
         * NTSTATUS NtDuplicateObject(HANDLE SourceProcess, HANDLE SourceHandle,
         *   HANDLE TargetProcess, PHANDLE TargetHandle, ACCESS_MASK DesiredAccess,
         *   ULONG HandleAttributes, ULONG Options)
         *
         * DuplicateHandle with OBJ_INHERIT for its inherit flag. No target
         * pointer is allowed with DUPLICATE_CLOSE_SOURCE: the source is closed
         * and nothing made, as the kernel does it.
         */
        NtDuplicateObject: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([sourceProcess, source, targetProcess, target, access, attributes,
                options])=>{
                const shared = options & (DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS);
                if (wholeAddress(target) === 0 && (options & DUPLICATE_CLOSE_SOURCE) !== 0)
                {
                    const [closed] = keepingLastError(()=>
                        kernel32.CloseHandle?.handler([source]) ?? 0);
                    return closed !== 0 ? STATUS.SUCCESS : STATUS.INVALID_HANDLE;
                }
                const [made, error] = keepingLastError(()=>kernel32.DuplicateHandle.handler(
                    [sourceProcess, source, targetProcess, target, access,
                        (attributes & OBJ_INHERIT) !== 0 ? 1 : 0, shared]));
                return made !== 0 ? STATUS.SUCCESS
                    : STATUS_OF_ERROR.get(error) ?? STATUS.INVALID_HANDLE;
            },
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

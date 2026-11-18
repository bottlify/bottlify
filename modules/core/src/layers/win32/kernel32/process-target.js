/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The process a handle names, for a call that works on a process's memory or
 * threads: this one -- the pseudo-handle, or a handle OpenProcess gave for its
 * own id -- or a child, reached where it runs (`cross-process.js`). The
 * handle must carry the right the call needs, as on Windows: VirtualAllocEx
 * through a handle opened without PROCESS_VM_OPERATION is refused with
 * ERROR_ACCESS_DENIED, whichever process it names.
 */

import { allows } from './access.js';

/** GetCurrentProcess()'s pseudo-handle. */
export const CURRENT_PROCESS = 0xffffffff;

/** The process rights the memory and thread calls need (winnt.h's PROCESS_*). */
export const PROCESS_TERMINATE = 0x0001;
export const PROCESS_CREATE_THREAD = 0x0002;
export const PROCESS_VM_OPERATION = 0x0008;
export const PROCESS_VM_READ = 0x0010;
export const PROCESS_VM_WRITE = 0x0020;
export const PROCESS_DUP_HANDLE = 0x0040;
export const PROCESS_QUERY_INFORMATION = 0x0400;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;

/**
 * @typedef {{ here: true } | { child: any } | { error: number }} ProcessTarget
 */

/**
 * @param {{ kernel: any, processId: () => number }} host
 * @returns {(handle: number, right: number) => ProcessTarget}
 */
export function createProcessTarget({ kernel, processId }){
    return (handle, right)=>{
        const value = handle >>> 0;
        if (value === CURRENT_PROCESS)
        {
            return { here: true };
        }
        let object;
        try
        {
            object = kernel.handles.resolve(value, 'process');
        }
        catch (e){
            void e;
            object = null;
        }
        if (!object)
        {
            return { error: ERROR_INVALID_HANDLE };
        }
        if (!allows(kernel.handles.access?.(value) ?? null, right))
        {
            return { error: ERROR_ACCESS_DENIED };
        }
        if (object.current === true || (object.id >>> 0) === (processId() >>> 0))
        {
            return { here: true };
        }
        return { child: object };
    };
}

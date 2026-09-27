/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { STATUS } from './status.js';

/**
 * The native waits, over kernel32's.
 *
 * kernel32's waits are these on Windows, with two translations in between,
 * and those are all that is written here. A timeout is a pointer to a
 * LARGE_INTEGER in hundreds of nanoseconds -- negative for an interval,
 * positive for a moment in system time, no pointer for no limit -- rather than
 * a count of milliseconds. And the answer is a status, which for every wait
 * that ends is the same number kernel32 answers: WAIT_OBJECT_0 + n is
 * STATUS_WAIT_0 + n, WAIT_ABANDONED_0 + n STATUS_ABANDONED_WAIT_0 + n,
 * WAIT_TIMEOUT STATUS_TIMEOUT and WAIT_IO_COMPLETION STATUS_USER_APC. So a wait
 * that parks its thread is woken with its status already in place; only a
 * failure, which kernel32 reports through the last error, is translated.
 *
 * kernel32 reads the standard-handle numbers (-10 to -12) as the streams they
 * name; the native calls do not, and refuse them as the handles they are not.
 */

/** kernel32's refusal, and the last error that says why. */
const WAIT_FAILED = 0xffffffff;
const ERROR_INVALID_HANDLE = 6;

/** The longest wait short of INFINITE, in milliseconds. */
const LONGEST = 0xfffffffe;
const INFINITE = 0xffffffff;

/** STD_ERROR_HANDLE to STD_INPUT_HANDLE. */
const STD_FIRST = 0xfffffff4;
const STD_LAST = 0xfffffff6;

/** NtWaitForMultipleObjects's WAIT_TYPE. */
const WAIT_ALL = 0;
const WAIT_ANY = 1;
const MAXIMUM_WAIT_OBJECTS = 64;
const STATUS_INVALID_PARAMETER_1 = 0xc00000ef;

/** Hundreds of nanoseconds in a millisecond. */
const TICKS_PER_MS = 10000n;

/**
 * @typedef {{ argBytes: number, handler: Function }} Entry
 */

/**
 * @typedef {Object} WaitHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {Record<string, Entry>} kernel32
 * @property {(bytes: number) => number} allocate  scratch for reading the system time
 */

/**
 * @param {WaitHost} host
 */
export function createWaitFunctions(host){
    const { kernel32 } = host;

    let clock = 0;
    /** The system time now, as a FILETIME count, for a timeout that names a moment. */
    const systemTime = ()=>{
        clock ||= host.allocate(8);
        kernel32.GetSystemTimeAsFileTime.handler([clock]);
        return new DataView(host.readMemory(clock, 8).buffer).getBigUint64(0, true);
    };

    /**
     * A native timeout as kernel32's milliseconds.
     *
     * @param {number} pointer
     */
    const milliseconds = pointer=>{
        if ((pointer >>> 0) === 0)
        {
            return INFINITE;
        }
        const value = new DataView(host.readMemory(pointer >>> 0, 8).buffer)
            .getBigInt64(0, true);
        const ticks = value < 0n ? -value : value - BigInt(systemTime());
        if (ticks <= 0n)
        {
            return 0;
        }
        const ms = (ticks + TICKS_PER_MS - 1n) / TICKS_PER_MS;
        return ms > BigInt(LONGEST) ? LONGEST : Number(ms);
    };

    /**
     * kernel32's answer as a status.
     *
     * @param {any} answer
     */
    const status = answer=>{
        if (typeof answer !== 'number' || (answer >>> 0) !== WAIT_FAILED)
        {
            return answer;
        }
        return kernel32.GetLastError.handler([]) === ERROR_INVALID_HANDLE
            ? STATUS.INVALID_HANDLE : STATUS.INVALID_PARAMETER;
    };

    /** @param {number} handle */
    const standard = handle=>(handle >>> 0) >= STD_FIRST && (handle >>> 0) <= STD_LAST;

    return {
        /**
         * NTSTATUS NtWaitForSingleObject(HANDLE Handle, BOOLEAN Alertable,
         *                                PLARGE_INTEGER Timeout)
         */
        NtWaitForSingleObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, alertable, timeout])=>{
                if (standard(handle))
                {
                    return STATUS.INVALID_HANDLE;
                }
                return status(kernel32.WaitForSingleObjectEx.handler(
                    [handle, milliseconds(timeout), alertable & 0xff]));
            },
        },

        /**
         * NTSTATUS NtWaitForMultipleObjects(ULONG Count, const HANDLE *Handles,
         *     WAIT_TYPE WaitType, BOOLEAN Alertable, PLARGE_INTEGER Timeout)
         */
        NtWaitForMultipleObjects: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([count, handles, type, alertable, timeout])=>{
                const total = count >>> 0;
                if (total === 0 || total > MAXIMUM_WAIT_OBJECTS)
                {
                    return STATUS_INVALID_PARAMETER_1;
                }
                if (type !== WAIT_ALL && type !== WAIT_ANY)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const view = new DataView(host.readMemory(handles >>> 0, total * 4).buffer);
                for (let at = 0; at < total; at++)
                {
                    if (standard(view.getUint32(at * 4, true)))
                    {
                        return STATUS.INVALID_HANDLE;
                    }
                }
                return status(kernel32.WaitForMultipleObjectsEx.handler([total, handles,
                    type === WAIT_ALL ? 1 : 0, milliseconds(timeout), alertable & 0xff]));
            },
        },

        /**
         * NTSTATUS NtDelayExecution(BOOLEAN Alertable, PLARGE_INTEGER DelayInterval)
         *
         * SleepEx's answers are already the statuses: STATUS_SUCCESS, and
         * STATUS_USER_APC when an APC ended an alertable delay.
         */
        NtDelayExecution: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([alertable, interval])=>
                kernel32.SleepEx.handler([milliseconds(interval), alertable & 0xff]),
        },
    };
}

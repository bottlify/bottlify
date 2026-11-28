/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ntdll's time: the calendar arithmetic over a system time, the clocks under
 * kernel32's, the time zone, and the timer resolution.
 *
 * A system time is a LARGE_INTEGER of 100-nanosecond intervals since
 * 1601-01-01 in UTC, the same count as a FILETIME. The calendar calls take it
 * apart into a TIME_FIELDS and back; the clocks are kernel32's own, so a time
 * read here and one read through kernel32 are from the same clock; the zone is
 * the one kernel32 reports (filetime.js: this machine keeps UTC), and local
 * time is system time less its bias.
 */

import { STATUS } from './status.js';
import { wholeAddress } from '../common/pointers.js';

const STATUS_PRIVILEGE_NOT_HELD = 0xc0000061;
const STATUS_TIMER_RESOLUTION_NOT_SET = 0xc0000245;

/** 100-nanosecond intervals in a second, a minute, a day. */
const SECOND = 10_000_000n;
const DAY = 86_400n * SECOND;
/** 1970-01-01 and 1980-01-01 as system times. */
const EPOCH_1970 = 116_444_736_000_000_000n;
const EPOCH_1980 = 119_600_064_000_000_000n;
/**
 * The timer's resolutions in 100-nanosecond units: the coarsest the system
 * ticks at (15.625 ms) and the finest a program may ask for (0.5 ms), as
 * NtQueryTimerResolution reports them on a PC.
 */
const COARSEST = 156_250;
const FINEST = 5_000;

/** @param {number} year */
const isLeap = year=>(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
/** @param {number} year @param {number} month 1..12 */
const daysIn = (year, month)=>(month === 2 ? (isLeap(year) ? 29 : 28)
    : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]);
/** Days from 1601-01-01 to the first of a year. @param {number} year */
const daysBefore = year=>{
    const y = year - 1601;
    return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
};

/** NtQuerySystemInformation's classes this family answers. */
const SYSTEM_TIME_OF_DAY_INFORMATION = 3;
const SYSTEM_CURRENT_TIME_ZONE_INFORMATION = 44;
const SYSTEM_DYNAMIC_TIME_ZONE_INFORMATION = 102;
/** TIME_ZONE_INFORMATION and DYNAMIC_TIME_ZONE_INFORMATION, in bytes. */
const ZONE_SIZE = 172;
const DYNAMIC_ZONE_SIZE = 432;

/**
 * @typedef {Object} TimeHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {Record<string, { handler: Function }>} kernel32
 * @property {(bytes: number) => number} allocate  From the process heap.
 * @property {(address: number) => boolean} free
 */

/**
 * @param {TimeHost} host
 * @returns {{ table: Record<string, { argBytes: number, handler: Function }>,
 *     systemClasses: Record<number, import('./query.js').SystemClass> }}
 */
export function createTimeFunctions({ guest, kernel32, allocate, free }){
    /** The zone's bias in minutes (UTC = local + bias), kernel32's report. */
    const bias = ()=>{
        if (!kernel32.GetTimeZoneInformation)
        {
            return 0;
        }
        // TIME_ZONE_INFORMATION is 172 bytes; the bias is its first LONG.
        const scratch = allocate(172);
        if (scratch === 0)
        {
            return 0;
        }
        kernel32.GetTimeZoneInformation.handler([scratch]);
        const value = guest.i32(scratch);
        free(scratch);
        return value;
    };
    let resolution = COARSEST;
    let resolutionSet = false;
    /**
     * What a kernel32 call writes into a buffer of `size` bytes it is handed.
     *
     * @param {string} name @param {number} size
     */
    const filled = (name, size)=>{
        const scratch = allocate(size);
        try
        {
            kernel32[name].handler([scratch]);
            return guest.snapshot(scratch, size);
        }
        finally
        {
            free(scratch);
        }
    };
    /** The system time now, kernel32's clock. */
    const now = ()=>{
        const scratch = allocate(8);
        try
        {
            kernel32.GetSystemTimeAsFileTime.handler([scratch]);
            return guest.i64(scratch);
        }
        finally
        {
            free(scratch);
        }
    };

    /** @type {Record<string, { argBytes: number, handler: Function }>} */
    const table = {
        /**
         * VOID RtlTimeToTimeFields(PLARGE_INTEGER Time, PTIME_FIELDS TimeFields)
         *
         * Year, month, day, hour, minute, second, milliseconds and the weekday
         * (Sunday 0), each a CSHORT; 1601-01-01 was a Monday.
         */
        RtlTimeToTimeFields: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([time, fields])=>{
                const value = guest.u64(wholeAddress(time));
                let days = Number(value / DAY);
                const rest = Number(value % DAY / 10_000n);
                const weekday = (days + 1) % 7;
                let year = 1601 + Math.floor(days / 365.2425);
                while (daysBefore(year) > days)
                {
                    year--;
                }
                while (daysBefore(year + 1) <= days)
                {
                    year++;
                }
                days -= daysBefore(year);
                let month = 1;
                while (days >= daysIn(year, month))
                {
                    days -= daysIn(year, month);
                    month++;
                }
                const at = wholeAddress(fields);
                guest.set16(at, year);
                guest.set16(at + 2, month);
                guest.set16(at + 4, days + 1);
                guest.set16(at + 6, Math.floor(rest / 3_600_000));
                guest.set16(at + 8, Math.floor(rest / 60_000) % 60);
                guest.set16(at + 10, Math.floor(rest / 1000) % 60);
                guest.set16(at + 12, rest % 1000);
                guest.set16(at + 14, weekday);
                return 0;
            },
        },

        /**
         * BOOLEAN RtlTimeFieldsToTime(PTIME_FIELDS TimeFields, PLARGE_INTEGER Time)
         *
         * The weekday is not read; a field out of its range (a 30th of
         * February, a 24th hour, a year before 1601) is FALSE and no time.
         */
        RtlTimeFieldsToTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([fields, time])=>{
                const at = wholeAddress(fields);
                const [year, month, day, hour, minute, second, millisecond] = [0, 1, 2, 3, 4, 5, 6]
                    .map(index=>guest.i16(at + index * 2));
                if (year < 1601 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)
                    || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0
                    || second > 59 || millisecond < 0 || millisecond > 999)
                {
                    return 0;
                }
                let days = daysBefore(year) + day - 1;
                for (let m = 1; m < month; m++)
                {
                    days += daysIn(year, m);
                }
                const milliseconds = ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
                guest.set64(wholeAddress(time),
                    BigInt(days) * DAY + BigInt(milliseconds) * 10_000n);
                return 1;
            },
        },

        /** BOOLEAN RtlTimeToSecondsSince1970(PLARGE_INTEGER Time, PULONG ElapsedSeconds) */
        RtlTimeToSecondsSince1970: since(EPOCH_1970),
        /** BOOLEAN RtlTimeToSecondsSince1980(PLARGE_INTEGER Time, PULONG ElapsedSeconds) */
        RtlTimeToSecondsSince1980: since(EPOCH_1980),
        /** VOID RtlSecondsSince1970ToTime(ULONG ElapsedSeconds, PLARGE_INTEGER Time) */
        RtlSecondsSince1970ToTime: toTime(EPOCH_1970),
        /** VOID RtlSecondsSince1980ToTime(ULONG ElapsedSeconds, PLARGE_INTEGER Time) */
        RtlSecondsSince1980ToTime: toTime(EPOCH_1980),

        /** NTSTATUS RtlSystemTimeToLocalTime(PLARGE_INTEGER SystemTime, PLARGE_INTEGER LocalTime) */
        RtlSystemTimeToLocalTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([system, local])=>{
                guest.set64(wholeAddress(local),
                    guest.i64(wholeAddress(system)) - BigInt(bias()) * 60n * SECOND);
                return STATUS.SUCCESS;
            },
        },
        /** NTSTATUS RtlLocalTimeToSystemTime(PLARGE_INTEGER LocalTime, PLARGE_INTEGER SystemTime) */
        RtlLocalTimeToSystemTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([local, system])=>{
                guest.set64(wholeAddress(system),
                    guest.i64(wholeAddress(local)) + BigInt(bias()) * 60n * SECOND);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtQueryTimerResolution(PULONG Minimum, PULONG Maximum, PULONG Current)
         *
         * The coarsest resolution, the finest, and the one in force: the
         * coarsest until a program asked for another.
         */
        NtQueryTimerResolution: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([minimum, maximum, current])=>{
                if (wholeAddress(minimum) === 0 || wholeAddress(maximum) === 0
                    || wholeAddress(current) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                guest.set32(wholeAddress(minimum), COARSEST);
                guest.set32(wholeAddress(maximum), FINEST);
                guest.set32(wholeAddress(current), resolution);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtSetTimerResolution(ULONG Desired, BOOLEAN Set, PULONG Current)
         *
         * A request between the finest and the coarsest is granted at that
         * value, clamped there otherwise; releasing a request never made is
         * STATUS_TIMER_RESOLUTION_NOT_SET. The engine's timers are not made
         * coarser by the request's absence: this is the figure a program reads.
         */
        NtSetTimerResolution: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([desired, set, current])=>{
                if (wholeAddress(current) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                /** @type {number} */
                let status = STATUS.SUCCESS;
                if ((set & 0xff) !== 0)
                {
                    resolution = Math.min(COARSEST, Math.max(FINEST, desired >>> 0));
                    resolutionSet = true;
                }
                else if (resolutionSet)
                {
                    resolution = COARSEST;
                    resolutionSet = false;
                }
                else
                {
                    status = STATUS_TIMER_RESOLUTION_NOT_SET;
                }
                guest.set32(wholeAddress(current), resolution);
                return status;
            },
        },

        /**
         * NTSTATUS NtSetSystemTime(PLARGE_INTEGER NewTime, PLARGE_INTEGER OldTime)
         *
         * Refused as Windows refuses a caller without SeSystemtimePrivilege
         * enabled: the clock is the run's own (filetime.js).
         */
        NtSetSystemTime: {
            argBytes: 8,
            handler: ()=>STATUS_PRIVILEGE_NOT_HELD,
        },

        /** NTSTATUS RtlSetTimeZoneInformation(PRTL_TIME_ZONE_INFORMATION): refused the same way. */
        RtlSetTimeZoneInformation: {
            argBytes: 4,
            handler: ()=>STATUS_PRIVILEGE_NOT_HELD,
        },
    };

    if (kernel32.QueryPerformanceCounter && kernel32.QueryPerformanceFrequency)
    {
        /**
         * NTSTATUS NtQueryPerformanceCounter(PLARGE_INTEGER Counter, PLARGE_INTEGER Frequency)
         *
         * kernel32's counter, and its frequency where asked; no counter to
         * write is an access violation.
         */
        table.NtQueryPerformanceCounter = {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([counter, frequency])=>{
                if ((counter >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                kernel32.QueryPerformanceCounter.handler([wholeAddress(counter)]);
                if ((frequency >>> 0) !== 0)
                {
                    kernel32.QueryPerformanceFrequency.handler([wholeAddress(frequency)]);
                }
                return STATUS.SUCCESS;
            },
        };
        /** BOOLEAN RtlQueryPerformanceCounter(PLARGE_INTEGER): kernel32's is forwarded here. */
        table.RtlQueryPerformanceCounter = {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([counter])=>(kernel32.QueryPerformanceCounter.handler(
                [wholeAddress(counter)]) !== 0 ? 1 : 0),
        };
        /** BOOLEAN RtlQueryPerformanceFrequency(PLARGE_INTEGER) */
        table.RtlQueryPerformanceFrequency = {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([frequency])=>(kernel32.QueryPerformanceFrequency.handler(
                [wholeAddress(frequency)]) !== 0 ? 1 : 0),
        };
    }
    if (kernel32.QueryUnbiasedInterruptTime)
    {
        /** BOOL RtlQueryUnbiasedInterruptTime(PULONGLONG): kernel32's under it. */
        table.RtlQueryUnbiasedInterruptTime = {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>kernel32.QueryUnbiasedInterruptTime.handler([wholeAddress(out)]),
        };
    }
    if (kernel32.GetTimeZoneInformation)
    {
        /**
         * NTSTATUS RtlQueryTimeZoneInformation(PRTL_TIME_ZONE_INFORMATION)
         *
         * The same 172 bytes as TIME_ZONE_INFORMATION, kernel32's report.
         */
        table.RtlQueryTimeZoneInformation = {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([information])=>{
                if ((information >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                kernel32.GetTimeZoneInformation.handler([wholeAddress(information)]);
                return STATUS.SUCCESS;
            },
        };
    }
    if (kernel32.GetDynamicTimeZoneInformation)
    {
        /** NTSTATUS RtlQueryDynamicTimeZoneInformation(PRTL_DYNAMIC_TIME_ZONE_INFORMATION) */
        table.RtlQueryDynamicTimeZoneInformation = {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([information])=>{
                if ((information >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                kernel32.GetDynamicTimeZoneInformation.handler([wholeAddress(information)]);
                return STATUS.SUCCESS;
            },
        };
    }
    if (kernel32.GetTickCount)
    {
        /** ULONG NtGetTickCount(void): kernel32's clock. */
        table.NtGetTickCount = { argBytes: 0, handler: ()=>kernel32.GetTickCount.handler([]) };
    }
    /**
     * The classes of NtQuerySystemInformation over this clock and zone: the
     * time of day (boot time, now, the zone's bias in 100-nanosecond units and
     * its identifier, a prefix of it given to a shorter buffer, as Windows
     * copies one) and the two zone structures whole.
     *
     * @type {Record<number, import('./query.js').SystemClass>}
     */
    const systemClasses = {};
    if (kernel32.GetSystemTimeAsFileTime && kernel32.GetTickCount)
    {
        systemClasses[SYSTEM_TIME_OF_DAY_INFORMATION] = {
            partial: true,
            read: ()=>{
                const view = new DataView(new ArrayBuffer(48));
                const current = now();
                const uptime = BigInt(kernel32.GetTickCount.handler([]) >>> 0) * 10_000n;
                view.setBigInt64(0, current - uptime, true);
                view.setBigInt64(8, current, true);
                view.setBigInt64(16, BigInt(bias()) * 60n * SECOND, true);
                return new Uint8Array(view.buffer);
            },
        };
    }
    if (kernel32.GetTimeZoneInformation)
    {
        systemClasses[SYSTEM_CURRENT_TIME_ZONE_INFORMATION] = { exact: true,
            read: ()=>filled('GetTimeZoneInformation', ZONE_SIZE) };
    }
    if (kernel32.GetDynamicTimeZoneInformation)
    {
        systemClasses[SYSTEM_DYNAMIC_TIME_ZONE_INFORMATION] = { exact: true,
            read: ()=>filled('GetDynamicTimeZoneInformation', DYNAMIC_ZONE_SIZE) };
    }
    return { table, systemClasses };

    /** @param {bigint} epoch */
    function since(epoch){
        return {
            argBytes: 8,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [time, seconds])=>{
                const value = guest.i64(wholeAddress(time)) - epoch;
                if (value < 0n || value / SECOND > 0xffffffffn)
                {
                    return 0;
                }
                guest.set32(wholeAddress(seconds), Number(value / SECOND));
                return 1;
            },
        };
    }

    /** @param {bigint} epoch */
    function toTime(epoch){
        return {
            argBytes: 8,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [seconds, time])=>{
                guest.set64(wholeAddress(time), epoch + BigInt(seconds >>> 0) * SECOND);
                return 0;
            },
        };
    }
}

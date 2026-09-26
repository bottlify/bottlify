/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C time functions.
 *
 * Two clocks, and they are not the same one. `time` reports the wall clock,
 * which a program prints and stamps files with; `clock` reports how long this
 * process has been running, which a program *subtracts from itself* to measure
 * an interval. Both come from the guest's own clock rather than the host's,
 * because a frame loop that starts an interval with one and ends it with the
 * other measures the difference between two clocks instead of the time that
 * passed, and the answer can be negative.
 *
 * `localtime` and `gmtime` return the same thing here: this runtime has no
 * timezone, so the guest's wall clock is its local time by definition. A
 * program that formats a timestamp gets a consistent answer; one that computes
 * an offset from UTC gets zero.
 */

import { encodeAnsi } from '../kernel32/locale.js';

const MAX_STRING = 1 << 20;

/** msvcrt's clock ticks once per millisecond, unlike most Unix runtimes. */
export const CLOCKS_PER_SEC = 1000;

/** `struct tm`: nine ints, in this order, and the order is the layout. */
export const TM = Object.freeze({
    SEC: 0, MIN: 4, HOUR: 8, MDAY: 12, MON: 16, YEAR: 20, WDAY: 24, YDAY: 28, ISDST: 32,
    SIZE: 36,
});

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/** @param {number} value @param {number} width */
const pad = (value, width = 2)=>String(value).padStart(width, '0');

/**
 * asctime's format, which is fixed at 24 characters plus a newline so that
 * callers can and do index into it.
 *
 * @param {Date} when
 */
export function asctime(when){
    return `${DAYS[when.getUTCDay()].slice(0, 3)} ${MONTHS[when.getUTCMonth()].slice(0, 3)}`
        + ` ${String(when.getUTCDate()).padStart(2, ' ')} ${pad(when.getUTCHours())}`
        + `:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`
        + ` ${when.getUTCFullYear()}\n`;
}

/**
 * @param {string} format
 * @param {Date} when
 */
export function strftime(format, when){
    const dayOfYear = Math.floor(
        (Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate())
            - Date.UTC(when.getUTCFullYear(), 0, 1)) / 86400000);
    /** @param {number} firstDay */
    const weekOfYear = firstDay=>pad(Math.floor(
        (dayOfYear + 7 - (when.getUTCDay() - firstDay + 7) % 7) / 7));

    /** @type {Record<string, () => string>} */
    const fields = {
        a: ()=>DAYS[when.getUTCDay()].slice(0, 3),
        A: ()=>DAYS[when.getUTCDay()],
        b: ()=>MONTHS[when.getUTCMonth()].slice(0, 3),
        B: ()=>MONTHS[when.getUTCMonth()],
        c: ()=>asctime(when).slice(0, -1),
        d: ()=>pad(when.getUTCDate()),
        H: ()=>pad(when.getUTCHours()),
        I: ()=>pad(when.getUTCHours() % 12 === 0 ? 12 : when.getUTCHours() % 12),
        j: ()=>pad(dayOfYear + 1, 3),
        m: ()=>pad(when.getUTCMonth() + 1),
        M: ()=>pad(when.getUTCMinutes()),
        p: ()=>(when.getUTCHours() < 12 ? 'AM' : 'PM'),
        S: ()=>pad(when.getUTCSeconds()),
        U: ()=>weekOfYear(0),
        w: ()=>String(when.getUTCDay()),
        W: ()=>weekOfYear(1),
        x: ()=>`${pad(when.getUTCMonth() + 1)}/${pad(when.getUTCDate())}`
            + `/${pad(when.getUTCFullYear() % 100)}`,
        X: ()=>`${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`
            + `:${pad(when.getUTCSeconds())}`,
        y: ()=>pad(when.getUTCFullYear() % 100),
        Y: ()=>String(when.getUTCFullYear()),
        Z: ()=>'UTC',
        '%': ()=>'%',
    };

    let text = '';
    for (let at = 0; at < format.length; at++)
    {
        if (format[at] !== '%' || at + 1 === format.length)
        {
            text += format[at];
            continue;
        }
        const field = fields[format[++at]];
        // An unknown specifier is undefined behaviour; msvcrt drops it, and
        // dropping keeps the rest of the string in the positions the caller
        // laid out.
        text += field ? field() : '';
    }
    return text;
}

/**
 * @typedef {Object} TimeHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate
 * @property {() => number} systemTimeMs  Guest wall clock, milliseconds since 1970.
 * @property {() => number} now           Guest running time, milliseconds.
 * @property {import('./float.js').FloatHost} [fpu]
 */

/**
 * @param {TimeHost} host
 */
export function createTimeFunctions(host){
    /** @param {number} pointer @param {number} value */
    const writeInt = (pointer, value)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(pointer, bytes);
    };

    /** @param {number} pointer */
    const readInt = pointer=>
        new DataView(host.readMemory(pointer, 4).slice().buffer).getInt32(0, true);

    /** In the ANSI page a format is read in. @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        host.writeMemory(pointer, encodeAnsi(`${text}\0`));
    };

    /**
     * The static results. Every one of these functions documents that its
     * answer is overwritten by the next call, and code copies it out at once.
     */
    let tmBlock = 0;
    let textBlock = 0;
    const staticTm = ()=>(tmBlock === 0 ? (tmBlock = host.allocate(TM.SIZE)) : tmBlock);
    const staticText = ()=>(textBlock === 0 ? (textBlock = host.allocate(64)) : textBlock);

    /** @param {number} seconds */
    const fillTm = seconds=>{
        const when = new Date(seconds * 1000);
        const block = staticTm();
        const bytes = new Uint8Array(TM.SIZE);
        const view = new DataView(bytes.buffer);
        view.setInt32(TM.SEC, when.getUTCSeconds(), true);
        view.setInt32(TM.MIN, when.getUTCMinutes(), true);
        view.setInt32(TM.HOUR, when.getUTCHours(), true);
        view.setInt32(TM.MDAY, when.getUTCDate(), true);
        view.setInt32(TM.MON, when.getUTCMonth(), true);
        view.setInt32(TM.YEAR, when.getUTCFullYear() - 1900, true);
        view.setInt32(TM.WDAY, when.getUTCDay(), true);
        view.setInt32(TM.YDAY, Math.floor(
            (Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate())
                - Date.UTC(when.getUTCFullYear(), 0, 1)) / 86400000), true);
        view.setInt32(TM.ISDST, 0, true);
        host.writeMemory(block, bytes);
        return block;
    };

    /** @param {number} block @returns {Date} */
    const readTm = block=>new Date(Date.UTC(
        readInt(block + TM.YEAR) + 1900,
        readInt(block + TM.MON),
        readInt(block + TM.MDAY),
        readInt(block + TM.HOUR),
        readInt(block + TM.MIN),
        readInt(block + TM.SEC)));

    /** @param {number[]} args */
    const brokenDown = ([pointer])=>fillTm(readInt(pointer));

    const localtime = {
        convention: 'cdecl',
        argBytes: 4,
        handler: brokenDown,
    };

    /** double difftime(time_t later, time_t earlier) -- only with the FPU seam */
    const difftime = host.fpu
        ? {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [later, earlier])=>{
                // Signed: a caller subtracts in the order it chose, and a
                // negative difference is a meaningful answer rather than a
                // wrapped one.
                host.fpu?.setResult((later | 0) - (earlier | 0));
                return 0;
            },
        }
        : null;

    return {
        ...(difftime ? { difftime } : {}),

        /** time_t time(time_t *destination) */
        time: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([destination])=>{
                const seconds = Math.floor(host.systemTimeMs() / 1000);
                writeInt(destination, seconds);
                return seconds | 0;
            },
        },

        /** clock_t clock(void) */
        clock: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>Math.floor(host.now()) | 0,
        },

        /** struct tm *localtime(const time_t *) */
        localtime,

        /** struct tm *gmtime(const time_t *) */
        gmtime: localtime,

        /**
         * time_t mktime(struct tm *broken)
         *
         * Normalising is the part that gets used: a caller adds thirty to
         * tm_mday and expects the month to roll over, and Date does exactly
         * that with an out-of-range field.
         */
        mktime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                const when = readTm(block);
                if (Number.isNaN(when.getTime()))
                {
                    return -1;
                }
                // The normalised fields are written back, which is the whole
                // reason the argument is not const.
                fillTm(Math.floor(when.getTime() / 1000));
                host.writeMemory(block, host.readMemory(staticTm(), TM.SIZE).slice());
                return Math.floor(when.getTime() / 1000) | 0;
            },
        },

        /** char *ctime(const time_t *) */
        ctime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const text = staticText();
                writeString(text, asctime(new Date(readInt(pointer) * 1000)));
                return text;
            },
        },

        /** char *asctime(const struct tm *) */
        asctime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                const text = staticText();
                writeString(text, asctime(readTm(block)));
                return text;
            },
        },

        /**
         * size_t strftime(char *dest, size_t max, const char *format,
         *                 const struct tm *broken)
         *
         * Nothing is written when the result would not fit, and the answer is
         * zero -- not a truncated string. A caller cannot tell an overflow from
         * an empty format, which is a defect in the interface rather than here.
         */
        strftime: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, max, format, block])=>{
                const text = strftime(host.readCString(format, MAX_STRING), readTm(block));
                if (text.length + 1 > (max >>> 0))
                {
                    return 0;
                }
                writeString(destination, text);
                return text.length;
            },
        },

        /** void _strdate(char *buffer) -- exactly nine bytes, "MM/DD/YY" */
        _strdate: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                writeString(buffer, strftime('%m/%d/%y', new Date(host.systemTimeMs())));
                return buffer;
            },
        },

        /** void _strtime(char *buffer) -- exactly nine bytes, "HH:MM:SS" */
        _strtime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                writeString(buffer, strftime('%H:%M:%S', new Date(host.systemTimeMs())));
                return buffer;
            },
        },

        /**
         * void _ftime(struct _timeb *result)
         *
         * struct _timeb is { time_t time; unsigned short millitm; short
         * timezone; short dstflag; } -- the four-byte seconds first, then three
         * shorts, and the compiler pads the tail to twelve bytes.
         */
        _ftime: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([result])=>{
                const milliseconds = host.systemTimeMs();
                const bytes = new Uint8Array(12);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, Math.floor(milliseconds / 1000), true);
                view.setUint16(4, Math.floor(milliseconds) % 1000, true);
                host.writeMemory(result, bytes);
                return 0;
            },
        },
    };
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's locale as its own C++ library reads it.
 *
 * The C++ library built against this runtime does not ask `setlocale` what
 * the locale is: it reads the runtime's variables in place -- the code page,
 * the collation page, the handle of each category -- and calls the
 * runtime's own wrappers of CompareString and LCMapString, taking the
 * runtime's locks around what it reads. So these are exports a program
 * never names and its libraries depend on.
 *
 * Only the C locale is carried (`setlocale` says so), and every answer here
 * is the C locale's: code page and handles zero, which is what tells the
 * library to compare and transform bytes as bytes, and a `localeconv` with a
 * point for the decimal and nothing else.
 */

import { encodeAnsi } from '../kernel32/locale.js';

const MAX_STRING = 1 << 20;

/** CompareString's answers. */
const CSTR_LESS_THAN = 1;
const CSTR_EQUAL = 2;
const CSTR_GREATER_THAN = 3;

/** The flags these wrappers act on. */
const NORM_IGNORECASE = 0x00000001;
const LCMAP_LOWERCASE = 0x00000100;
const LCMAP_UPPERCASE = 0x00000200;
const LCMAP_SORTKEY = 0x00000400;

/** `struct lconv`: ten string pointers, then eight chars. */
const LCONV = Object.freeze({ STRINGS: 10, CHARS: 8, SIZE: 48 });

/** What a C locale's lconv says of a value it does not have. */
const CHAR_MAX = 127;

/** The categories `__lc_handle` holds a handle for: LC_ALL through LC_TIME. */
const CATEGORIES = 6;

/**
 * @typedef {Object} LocaleHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate
 * @property {() => any} [currentThread]  Who holds a lock. Absent, one thread.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {number} value @returns {Uint8Array} */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** ASCII lowered, as the C locale folds. @param {number} byte */
const lower = byte=>(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
/** @param {number} byte */
const upper = byte=>(byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte);

/**
 * @param {LocaleHost} host
 */
export function createLocaleFunctions(host){
    /**
     * A string's bytes as these wrappers count them: a count of -1 is to the
     * terminator -- which a mapping writes too and a comparison does not
     * compare; any other count stops at a terminator inside it, as the
     * runtime trims before it calls the system.
     *
     * @param {number} pointer @param {number} count @param {boolean} terminated
     */
    const bytesOf = (pointer, count, terminated)=>{
        if ((count | 0) < 0)
        {
            const text = host.readCString(pointer, MAX_STRING);
            return encodeAnsi(terminated ? `${text}\0` : text);
        }
        const bytes = host.readMemory(pointer, count | 0).slice();
        const end = bytes.indexOf(0);
        return end < 0 ? bytes : bytes.subarray(0, end);
    };

    /** The lconv, built once: its strings are the runtime's to keep. */
    let conventions = 0;
    const localeConventions = ()=>{
        if (conventions !== 0)
        {
            return conventions;
        }
        const block = host.allocate(LCONV.SIZE + 3);
        if (block === 0)
        {
            return 0;
        }
        const point = block + LCONV.SIZE;
        const empty = point + 2;
        const bytes = new Uint8Array(LCONV.SIZE + 3);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < LCONV.STRINGS; at++)
        {
            view.setUint32(at * 4, at === 0 ? point : empty, true);
        }
        bytes.fill(CHAR_MAX, LCONV.STRINGS * 4, LCONV.SIZE);
        bytes.set([0x2e, 0, 0], LCONV.SIZE);
        host.writeMemory(block, bytes);
        conventions = block;
        return block;
    };

    /**
     * The runtime's locks by number: recursive, as the critical sections
     * behind them are, and handed to the first waiter when released.
     *
     * @type {Map<number, { owner: any, depth: number,
     *                      waiters: { thread: any, resume: (value: number) => void }[] }>}
     */
    const locks = new Map();
    const ONE_THREAD = {};
    const caller = ()=>host.currentThread?.() ?? ONE_THREAD;

    return {
        /**
         * struct lconv *localeconv(void)
         *
         * The C locale's: "." for the decimal point, every other string
         * empty, every number CHAR_MAX -- the same structure each call.
         */
        localeconv: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>localeConventions(),
        },

        /**
         * int __crtCompareStringA(LCID locale, DWORD flags, LPCSTR left, int leftCount,
         *                         LPCSTR right, int rightCount, int codePage)
         *
         * CompareString's answer -- 1 less, 2 equal, 3 greater -- in the C
         * locale's collation, which is the bytes' order; NORM_IGNORECASE
         * folds ASCII first. A shorter string that is the other's start is
         * the less.
         */
        __crtCompareStringA: {
            convention: 'cdecl',
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, flags, left, leftCount, right, rightCount])=>{
                const fold = ((flags >>> 0) & NORM_IGNORECASE) !== 0
                    ? lower
                    : (/** @type {number} */ byte)=>byte;
                const a = bytesOf(left, leftCount, false);
                const b = bytesOf(right, rightCount, false);
                const length = Math.min(a.length, b.length);
                for (let at = 0; at < length; at++)
                {
                    const difference = fold(a[at]) - fold(b[at]);
                    if (difference !== 0)
                    {
                        return difference < 0 ? CSTR_LESS_THAN : CSTR_GREATER_THAN;
                    }
                }
                return a.length === b.length ? CSTR_EQUAL
                    : (a.length < b.length ? CSTR_LESS_THAN : CSTR_GREATER_THAN);
            },
        },

        /**
         * int __crtLCMapStringA(LCID locale, DWORD flags, LPCSTR source, int sourceCount,
         *                       LPSTR destination, int destinationCount, int codePage,
         *                       BOOL error)
         *
         * LCMapString's answer: the bytes written, or with no room asked for
         * the bytes needed, and zero when the room given is short. Upper and
         * lower case are ASCII's; a sort key, under the C locale's collation,
         * is the bytes themselves and a terminator, so two keys compare as
         * their strings do. Any other mapping is reported and left a copy.
         */
        __crtLCMapStringA: {
            convention: 'cdecl',
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, flags, source, sourceCount, destination, destinationCount])=>{
                const asked = flags >>> 0;
                let bytes = bytesOf(source, sourceCount, true);
                if ((asked & LCMAP_SORTKEY) !== 0)
                {
                    const text = bytes[bytes.length - 1] === 0 ? bytes.subarray(0, -1) : bytes;
                    const key = new Uint8Array(text.length + 1);
                    key.set(text);
                    bytes = key;
                }
                else if ((asked & LCMAP_LOWERCASE) !== 0)
                {
                    bytes = bytes.map(lower);
                }
                else if ((asked & LCMAP_UPPERCASE) !== 0)
                {
                    bytes = bytes.map(upper);
                }
                else if (asked !== 0)
                {
                    host.divergence?.('__crtLCMapStringA',
                        `mapping 0x${asked.toString(16)} is not carried; the text is copied`);
                }
                const room = destinationCount | 0;
                if (room === 0)
                {
                    return bytes.length;
                }
                if (bytes.length > room)
                {
                    return 0;
                }
                host.writeMemory(destination >>> 0, bytes);
                return bytes.length;
            },
        },

        /**
         * UINT __lc_codepage, UINT __lc_collate_cp, LCID __lc_handle[6]
         *
         * The C locale's: zero for each, which the library reads as "no
         * locale -- bytes are bytes".
         */
        __lc_codepage: { data: ()=>dword(0) },
        __lc_collate_cp: { data: ()=>dword(0) },
        __lc_handle: { data: ()=>new Uint8Array(CATEGORIES * 4) },

        /**
         * int __setlc_active, int __unguarded_readlc_active
         *
         * How many threads are changing the locale and how many reading it
         * unguarded. Nothing here changes the locale, so both stay zero,
         * which tells a reader it need not take the locale lock.
         */
        __setlc_active: { data: ()=>dword(0) },
        __unguarded_readlc_active: { data: ()=>dword(0) },

        /**
         * void _lock(int lockNumber)
         *
         * One of the runtime's own locks, taken for the calling thread: again
         * by its owner, it counts; held by another, the caller waits for it.
         */
        _lock: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([number])=>{
                const thread = caller();
                const lock = locks.get(number | 0);
                if (!lock || lock.owner === null)
                {
                    locks.set(number | 0,
                        { owner: thread, depth: 1, waiters: lock?.waiters ?? [] });
                    return 0;
                }
                if (lock.owner === thread)
                {
                    lock.depth++;
                    return 0;
                }
                return new Promise(resume=>lock.waiters.push({ thread, resume }));
            },
        },

        /**
         * void _unlock(int lockNumber)
         *
         * Released when its owner has unlocked it as often as it locked it,
         * straight to the first thread waiting. A release by a thread that
         * does not hold it changes nothing.
         */
        _unlock: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([number])=>{
                const lock = locks.get(number | 0);
                if (!lock || lock.owner !== caller() || --lock.depth > 0)
                {
                    return 0;
                }
                const next = lock.waiters.shift();
                lock.owner = next ? next.thread : null;
                lock.depth = next ? 1 : 0;
                next?.resume(0);
                return 0;
            },
        },
    };
}

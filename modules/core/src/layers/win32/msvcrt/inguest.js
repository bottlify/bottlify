/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime functions that run in the guest, written once: each `@guestCode`
 * function here is compiled by the build (`scripts/guest-code/compile.mjs`)
 * into the i386 of `inguest.x86.js`, which the export's slot carries, and is
 * itself the export's handler and the reference the x86 is tested against.
 * What the subset allows, and why, is written at the compiler.
 *
 * Each keeps the answers of the handler it replaced, under the C locale:
 * ASCII case, comparisons normalised to -1, 0 and 1, bytes ordered as the
 * handlers ordered the strings they decoded (`ORDER`).
 */

import { decodeAnsi } from '../kernel32/locale.js';

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').u32} u32 */
/** @typedef {import('./guest-code.js').f64} f64 */
/** @typedef {import('./guest-code.js').x87} x87 */
/** @typedef {import('./guest-code.js').i64} i64 */

/**
 * The order the comparisons put bytes in: each byte's character in the ANSI
 * page, as the handlers that compared decoded strings had it -- a byte's own
 * value, but for the sixteen of 0x80..0x9f that Windows-1252 gives characters
 * above 0xff (0x80 the euro sign sorts after every other byte).
 */
export const ORDER = Uint16Array.from({ length: 256 },
    (_, byte)=>decodeAnsi(Uint8Array.of(byte)).charCodeAt(0));

/** Each byte uppercased in the C locale: ASCII letters, and nothing else. */
export const UPPER = Uint8Array.from({ length: 256 },
    (_, code)=>(code >= 0x61 && code <= 0x7a ? code - 0x20 : code));

/**
 * double floor(double x)
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function floor(x){
    return Math.floor(x);
}

/**
 * int toupper(int c)
 *
 * A value outside a byte comes back as it went in, EOF included.
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {u32}
 */
export function toupper(c){
    return c < 256 ? UPPER[c] : c;
}

/**
 * int strncmp(const char *left, const char *right, size_t count)
 *
 * No further than either terminator, and no further than `count`.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 * @returns {i32}
 */
export function strncmp({ u8 }, left, right, count){
    for (/** @type {u32} */ let i = 0; i < count; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a !== b)
        {
            return ORDER[a] < ORDER[b] ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
    return 0;
}

/**
 * __int64 _ftol(double value), and `_ftol2` and `_ftol2_sse` with it
 *
 * The cast every `(int)` in compiled C goes through: the value the caller
 * left in ST0, popped, truncated toward zero into EDX:EAX -- the integer
 * indefinite for NaN and out of range, as `fisttp` stores it.
 *
 * @guestCode cdecl
 * @param {x87} value
 * @returns {i64}
 */
export function _ftol(value){
    return value;
}

/**
 * void qsort(void *base, size_t num, size_t width,
 *            int (*compare)(const void *, const void *))
 *
 * Shell's sort with the gaps halved, in place: the elements are swapped in
 * the program's memory as they move, so the comparator is always handed the
 * real addresses of the array as it stands. The order of equal elements is
 * not kept -- the standard promises none, and msvcrt's own sort keeps none.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} base @param {u32} num @param {u32} width
 * @param {u32} compare
 */
export function qsort({ u8, setU8, call }, base, num, width, compare){
    if (width === 0)
    {
        return;
    }
    for (let gap = num >>> 1; gap !== 0; gap = gap >>> 1)
    {
        for (let i = gap; i < num; i++)
        {
            for (let j = i; j >= gap; j -= gap)
            {
                const a = (base + Math.imul(j - gap, width)) >>> 0;
                const b = (base + Math.imul(j, width)) >>> 0;
                if (call(compare, a, b) <= 0)
                {
                    break;
                }
                for (/** @type {u32} */ let k = 0; k < width; k++)
                {
                    const kept = u8(a + k);
                    setU8(a + k, u8(b + k));
                    setU8(b + k, kept);
                }
            }
        }
    }
}

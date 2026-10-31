/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OVERLAPPED as a process of either width lays it out. Internal and
 * InternalHigh are ULONG_PTRs, so at 64 bits each is eight bytes and Offset,
 * OffsetHigh and hEvent come eight bytes later than at 32: a 64-bit read
 * taken at the 32-bit offset read InternalHigh as its position, and every
 * overlapped read came from the start of the file.
 */

/**
 * @typedef {Object} OverlappedLayout
 * @property {number} internal      The status, a ULONG_PTR.
 * @property {number} internalHigh  The bytes transferred, a ULONG_PTR.
 * @property {number} offset        The position's low dword.
 * @property {number} offsetHigh    And its high one.
 * @property {number} event         hEvent.
 * @property {4 | 8} word           The bytes of Internal and InternalHigh.
 */

/** @type {Map<number, OverlappedLayout>} */
const layouts = new Map();

/**
 * @param {number} [pointerSize]  4 or 8; 4 by default.
 * @returns {OverlappedLayout}
 */
export function overlappedLayout(pointerSize = 4){
    const known = layouts.get(pointerSize);
    if (known)
    {
        return known;
    }
    const word = pointerSize === 8 ? 8 : 4;
    /** @type {OverlappedLayout} */
    const layout = { internal: 0, internalHigh: word, offset: 2 * word,
        offsetHigh: 2 * word + 4, event: 2 * word + 8, word };
    layouts.set(pointerSize, layout);
    return layout;
}

/**
 * The position an OVERLAPPED names, both of its dwords.
 *
 * @param {(address: number) => number} readDword
 * @param {OverlappedLayout} layout @param {number} at
 */
export function overlappedPosition(readDword, layout, at){
    return (readDword(at + layout.offset) >>> 0)
        + (readDword(at + layout.offsetHigh) >>> 0) * 0x100000000;
}

/**
 * Internal and InternalHigh written whole: the status and what moved, the
 * high halves of a 64-bit process's zero. `transferred` absent, only the
 * status.
 *
 * @param {(address: number, value: number) => void} writeDword
 * @param {OverlappedLayout} layout @param {number} at
 * @param {number} status @param {number} [transferred]
 */
export function overlappedResult(writeDword, layout, at, status, transferred){
    writeDword(at + layout.internal, status >>> 0);
    if (layout.word === 8)
    {
        writeDword(at + layout.internal + 4, 0);
    }
    if (transferred === undefined)
    {
        return;
    }
    writeDword(at + layout.internalHigh, transferred >>> 0);
    if (layout.word === 8)
    {
        writeDword(at + layout.internalHigh + 4, 0);
    }
}

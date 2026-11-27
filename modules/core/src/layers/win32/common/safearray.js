/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SAFEARRAY as a process of either width lays it out: cDims and fFeatures,
 * WORDs; cbElements and cLocks, DWORDs; pvData, a pointer; then one
 * SAFEARRAYBOUND (cElements, lLbound) per dimension. At 64 bits the pointer
 * is eight bytes and aligned to eight, so pvData is at 16 and the bounds at
 * 24, where at 32 bits they are at 12 and 16. In front of the descriptor its
 * allocation keeps the IID (the 16 bytes before it), the VARTYPE (the dword
 * before it) or the IRecordInfo (the pointer before it). Laid out at the
 * 32-bit offsets in a 64-bit process, a program that read pvData read the
 * first bound, and one that read an element of strings read half of one.
 */

import { struct } from '../../../system/layout.js';

/**
 * @typedef {Object} SafeArrayLayout
 * @property {number} FEATURES  @property {number} ELEMENT_BYTES  @property {number} LOCKS
 * @property {number} DATA  @property {number} BOUNDS
 * @property {number} RECORD_INFO  Negative: before the descriptor.
 * @property {number} POINTER  A pointer's size, as an element of strings or interfaces.
 */

/** SAFEARRAY as oaidl.h declares it, its first SAFEARRAYBOUND in place. */
const SAFEARRAY = struct([['cDims', 'u16'], ['FEATURES', 'u16'], ['ELEMENT_BYTES', 'u32'],
    ['LOCKS', 'u32'], ['DATA', 'ptr'], ['BOUNDS', struct([['cElements', 'u32'],
        ['lLbound', 'i32']])]]);

/** @param {4 | 8} width @returns {Readonly<SafeArrayLayout>} */
const at = width=>{
    const { FEATURES, ELEMENT_BYTES, LOCKS, DATA, BOUNDS } = SAFEARRAY.at(width);
    return Object.freeze({ FEATURES, ELEMENT_BYTES, LOCKS, DATA, BOUNDS, RECORD_INFO: -width,
        POINTER: width });
};
const NARROW = at(4);
const WIDE = at(8);

/**
 * The SAFEARRAY of a process whose pointers are `pointerSize` bytes.
 *
 * @param {number} [pointerSize]  4 or 8; 4 by default.
 * @returns {Readonly<SafeArrayLayout>}
 */
export function safeArrayLayout(pointerSize = 4){
    return pointerSize === 8 ? WIDE : NARROW;
}

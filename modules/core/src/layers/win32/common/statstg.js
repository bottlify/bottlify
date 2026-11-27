/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * STATSTG as a process of either width lays it out: pwcsName, a pointer;
 * type, a DWORD; cbSize, a ULARGE_INTEGER; three FILETIMEs; grfMode,
 * grfLocksSupported; clsid; grfStateBits; reserved. At 64 bits the name is
 * eight bytes and cbSize is aligned to eight, so everything from the type on
 * moves: type to 8, cbSize to 16, the rest eight further than at 32 bits, and
 * the whole is 80 bytes where it is 72. Read or written at the 32-bit offsets,
 * a 64-bit stream's size was its type and padding.
 */

/**
 * @typedef {Object} StatstgLayout
 * @property {number} NAME  @property {number} TYPE  @property {number} SIZE
 * @property {number} MTIME  @property {number} CTIME  @property {number} ATIME
 * @property {number} MODE  @property {number} LOCKS  @property {number} CLSID
 * @property {number} STATE_BITS  @property {number} SIZE_OF
 */

const NARROW = Object.freeze({
    NAME: 0, TYPE: 4, SIZE: 8, MTIME: 16, CTIME: 24, ATIME: 32, MODE: 40, LOCKS: 44,
    CLSID: 48, STATE_BITS: 64, SIZE_OF: 72,
});
const WIDE = Object.freeze({
    NAME: 0, TYPE: 8, SIZE: 16, MTIME: 24, CTIME: 32, ATIME: 40, MODE: 48, LOCKS: 52,
    CLSID: 56, STATE_BITS: 72, SIZE_OF: 80,
});

/**
 * The STATSTG of a process whose pointers are `pointerSize` bytes.
 *
 * @param {number} [pointerSize]  4 or 8; 4 by default.
 * @returns {Readonly<StatstgLayout>}
 */
export function statstgLayout(pointerSize = 4){
    return pointerSize === 8 ? WIDE : NARROW;
}

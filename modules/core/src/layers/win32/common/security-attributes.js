/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SECURITY_ATTRIBUTES as a process of either width lays it out: nLength, a
 * DWORD; lpSecurityDescriptor, a pointer; bInheritHandle, a BOOL. At 64 bits
 * the pointer is eight bytes and aligned to eight, so the descriptor is at 8
 * and the flag at 16, where at 32 bits they are at 4 and 8. Read at the
 * 32-bit offsets, a 64-bit process's flag was the descriptor's low dword -
 * zero when it names none - and no handle it made was inherited by its
 * children.
 */

/**
 * @typedef {Object} SecurityAttributes
 * @property {number} descriptor  lpSecurityDescriptor, 0 for none.
 * @property {boolean} inherit    bInheritHandle.
 */

/**
 * The structure at `at`, read whole; null where `at` is null.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory
 * @param {number} at  The address, whole.
 * @param {number} [pointerSize]  4 or 8; 4 by default.
 * @returns {SecurityAttributes | null}
 */
export function readSecurityAttributes(readMemory, at, pointerSize = 4){
    if (at === 0)
    {
        return null;
    }
    const word = pointerSize === 8 ? 8 : 4;
    const bytes = readMemory(at, 3 * word);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const descriptor = word === 8
        ? view.getUint32(8, true) + view.getUint32(12, true) * 2 ** 32
        : view.getUint32(4, true);
    return { descriptor, inherit: view.getUint32(2 * word, true) !== 0 };
}

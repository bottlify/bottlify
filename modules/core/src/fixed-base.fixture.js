/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit fixture as a game ships: its relocations stripped, its base fixed
 * where the linker put it, past 4 GiB (0x140000000). A loader cannot move
 * such an image below 4 GiB, so a run over a wide window keeps every address
 * of its code and data there - what a dword cut from one names another place.
 */

import assert from 'node:assert/strict';

/**
 * @param {Uint8Array} bytes  the image, changed in place
 * @returns {Uint8Array} the same bytes
 */
export function fixedPastFourGiB(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const pe = view.getUint32(0x3c, true);
    const optional = pe + 24;
    assert.ok(view.getBigUint64(optional + 24, true) >= 2n ** 32n, 'linked past 4 GiB');
    view.setUint16(pe + 22, view.getUint16(pe + 22, true) | 1, true); // RELOCS_STRIPPED
    view.setBigUint64(optional + 112 + 5 * 8, 0n, true); // no base relocation directory
    // Not DYNAMIC_BASE: nothing left to relocate it by.
    view.setUint16(optional + 70, view.getUint16(optional + 70, true) & ~0x40, true);
    return bytes;
}

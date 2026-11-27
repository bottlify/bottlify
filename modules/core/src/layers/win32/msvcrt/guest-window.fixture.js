/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A C or C++ runtime's `guest` over a test's own bytes placed at an address of
 * the test's choosing: past 2 GiB, where a dword read signed names another
 * place, or past 4 GiB, where only a whole pointer names it. The memory
 * layer's accessors, the same a run's view goes through, over one readable
 * and writable region; the first `closed` bytes are none of it, as a
 * process's first page is not, so a handler that touches a null pointer's
 * neighbourhood faults.
 */

import { createAccessors } from '../../memory/internal/accessors.js';
import { Access, RegionKind, createRegionMap } from '../../memory/internal/regions.js';
import { createGuest } from '../common/guest.js';

/**
 * @param {Uint8Array} bytes  the guest's memory, byte 0 at `base`
 * @param {{ base?: number, closed?: number, pointerSize?: 4 | 8 }} [options]
 */
export function guestWindow(bytes, { base = 0, closed = 0, pointerSize = 4 } = {}){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const regions = createRegionMap();
    regions.register({ name: 'test', base: base + closed, size: bytes.length - closed,
        kind: RegionKind.STACK, access: Access.READ_WRITE });
    const accessors = createAccessors({ regions, raw: {
        readPhysical: (address, length)=>bytes.subarray(address - base, address - base + length),
        writePhysical: (address, data)=>bytes.set(data, address - base),
        readU32: address=>view.getUint32(address - base, true),
        writeU32Data: (address, value)=>view.setUint32(address - base, value >>> 0, true),
    } });
    return createGuest(accessors, pointerSize);
}

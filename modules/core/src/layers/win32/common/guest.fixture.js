/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library's `guest` over a test's own bytes: the memory layer's accessors,
 * the same that a run's view goes through, over one readable and writable
 * region at address 0 the length of the buffer - what a handler is handed,
 * with no machine around it.
 */

import { createAccessors } from '../../memory/internal/accessors.js';
import { Access, RegionKind, createRegionMap } from '../../memory/internal/regions.js';
import { createGuest } from './guest.js';

/**
 * @param {Uint8Array} bytes  the guest's memory, byte 0 at address 0
 * @param {4 | 8} [pointerSize]
 */
export function guestOver(bytes, pointerSize = 4){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const regions = createRegionMap();
    regions.register({ name: 'test', base: 0, size: bytes.length, kind: RegionKind.STACK,
        access: Access.READ_WRITE });
    const accessors = createAccessors({ regions, raw: {
        readPhysical: (address, length)=>bytes.subarray(address, address + length),
        writePhysical: (address, data)=>bytes.set(data, address),
        readU32: address=>view.getUint32(address, true),
        writeU32Data: (address, value)=>view.setUint32(address, value >>> 0, true),
    } });
    return createGuest(accessors, pointerSize);
}

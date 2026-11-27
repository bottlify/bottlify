/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library's `guest` over a test's own bytes: the memory layer's accessors,
 * the same that a run's view goes through, over readable and writable
 * regions from address 0 to the buffer's end - what a handler is handed,
 * with no machine around it. `ends` parts them where an allocation ends and
 * nothing may be read across it, as memory refuses a read across a region's
 * end.
 */

import { createAccessors } from '../../memory/internal/accessors.js';
import { Access, RegionKind, createRegionMap } from '../../memory/internal/regions.js';
import { createGuest } from './guest.js';

/**
 * @param {Uint8Array} bytes  the guest's memory, byte 0 at address 0
 * @param {4 | 8} [pointerSize]
 * @param {number[]} [ends]  where one region ends and the next begins
 */
export function guestOver(bytes, pointerSize = 4, ends = []){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const regions = createRegionMap();
    const starts = [0, ...ends.filter(end=>end > 0 && end < bytes.length).sort((a, b)=>a - b)];
    starts.forEach((base, index)=>regions.register({ name: `test ${index}`, base,
        size: (starts[index + 1] ?? bytes.length) - base, kind: RegionKind.STACK,
        access: Access.READ_WRITE }));
    const accessors = createAccessors({ regions, raw: {
        readPhysical: (address, length)=>bytes.subarray(address, address + length),
        writePhysical: (address, data)=>bytes.set(data, address),
        readU32: address=>view.getUint32(address, true),
        writeU32Data: (address, value)=>view.setUint32(address, value >>> 0, true),
    } });
    return createGuest(accessors, pointerSize);
}

/**
 * How much the host's external memory (array buffers and the like) grew
 * across a call, and what it threw: a handler that makes a buffer of a
 * guest's length before the guest's memory says it is there shows as
 * gigabytes here, where Windows faulted at the destination's first byte.
 *
 * @param {() => unknown} call
 * @returns {{ grown: number, error: any }}
 */
export function externalGrowth(call){
    const before = process.memoryUsage().external;
    let error = null;
    try
    {
        call();
    }
    catch (e){
        error = e;
    }
    return { grown: process.memoryUsage().external - before, error };
}

/** The most a call that writes into the guest in place may grow external memory by. */
export const IN_PLACE = 4 * 2 ** 20;

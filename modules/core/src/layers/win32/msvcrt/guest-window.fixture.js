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
import { WHOLE, createGuest } from '../common/guest.js';
import { decodeAnsi } from '../kernel32/locale.js';

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
        // In place, as a run's RAM fills: a fill makes no buffer of its length.
        fillData: (address, value, length)=>void bytes.fill(value, address - base,
            address - base + length),
    } });
    return createGuest(accessors, pointerSize);
}

/**
 * The same view over a test's own read and write of a machine's memory - its
 * physical pages, or a host that counts what it is asked - where no region
 * map stands behind them: each value read and written through those two.
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {(address: number, bytes: Uint8Array) => void} write
 * @param {4 | 8} [pointerSize]
 */
export function guestThrough(read, write, pointerSize = 4){
    /** @param {number} address @param {number} length */
    const value = (address, length)=>{
        const bytes = read(address, length);
        let result = 0;
        for (let at = length - 1; at >= 0; at--)
        {
            result = result * 0x100 + bytes[at];
        }
        return result;
    };
    /** @param {number} address @param {number} number @param {number} length */
    const put = (address, number, length)=>{
        const bytes = new Uint8Array(length);
        for (let at = 0; at < length; at++)
        {
            bytes[at] = Math.floor((number >>> 0) / 2 ** (8 * at)) & 0xff;
        }
        write(address, bytes);
    };
    /** @param {number} address @param {number} unit @param {number} limit */
    const units = (address, unit, limit)=>{
        let text = '';
        for (let at = 0; at + unit <= limit; at += unit)
        {
            const code = value(address + at, unit);
            if (code === 0)
            {
                return text;
            }
            text += unit === 1 ? decodeAnsi(Uint8Array.of(code)) : String.fromCharCode(code);
        }
        return text;
    };
    return createGuest({
        readU8: address=>value(address, 1),
        readU16: address=>value(address, 2),
        readU32: address=>value(address, 4),
        writeU8: (address, number)=>put(address, number, 1),
        writeU16: (address, number)=>put(address, number, 2),
        writeU32: (address, number)=>put(address, number, 4),
        readBytes: read,
        window: read,
        writeBytes: write,
        fillBytes: (address, number, length)=>write(address, new Uint8Array(length).fill(number)),
        readCString: (address, limit = WHOLE)=>units(address, 1, limit),
        readWideString: (address, limit = WHOLE)=>units(address, 2, limit),
    }, pointerSize);
}

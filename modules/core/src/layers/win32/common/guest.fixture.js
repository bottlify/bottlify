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
 * @param {Uint8Array} bytes  the guest's memory, byte 0 at address `at`
 * @param {4 | 8} [pointerSize]
 * @param {number[]} [ends]  where one region ends and the next begins
 * @param {number} [from]  where memory begins: nothing below it is there
 * @param {number} [at]  the address of the first byte, past 4 GiB for a 64-bit
 *     process's image there
 */
export function guestOver(bytes, pointerSize = 4, ends = [], from = 0, at = 0){
    return createGuest(accessorsOver(bytes, ends, from, at), pointerSize);
}

/**
 * The memory layer's accessors over a test's bytes, as `guestOver` lays them
 * out: for a test that counts or marks what goes through them before the
 * guest is made over them.
 *
 * @param {Uint8Array} bytes @param {number[]} [ends] @param {number} [from] @param {number} [at]
 */
export function accessorsOver(bytes, ends = [], from = 0, at = 0){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const regions = createRegionMap();
    const top = at + bytes.length;
    const first = Math.max(from, at);
    const starts = [first, ...ends.filter(end=>end > first && end < top).sort((a, b)=>a - b)];
    starts.forEach((base, index)=>regions.register({ name: `test ${index}`, base,
        size: (starts[index + 1] ?? top) - base, kind: RegionKind.STACK,
        access: Access.READ_WRITE }));
    return createAccessors({ regions, raw: {
        readPhysical: (address, length)=>bytes.subarray(address - at, address - at + length),
        writePhysical: (address, data)=>bytes.set(data, address - at),
        readU32: address=>view.getUint32(address - at, true),
        writeU32Data: (address, value)=>view.setUint32(address - at, value >>> 0, true),
    } });
}

/** The page a recorded guest's memory is made of as it is first touched. */
const PAGE = 0x1000;

/**
 * A guest over the whole 4 GiB a test may name, its pages made zeroed as
 * they are first touched, that keeps what each write wrote: by the address
 * it was written at, its bytes as they went in (`written`), for a test that
 * reads an out-parameter back as the handler wrote it. A string at an
 * address `names` holds reads as that text in either width, for a test that
 * hands names without laying them out. `use` lays a test's own buffer over
 * the addresses from 0, read and written in place from then on.
 *
 * @param {{ names?: Record<number, string> | Map<number, string>, pointerSize?: 4 | 8 }}
 *     [options]
 * @returns {{ guest: import('./guest.js').Guest, written: Map<number, Uint8Array>,
 *     bytes: (address: number, length: number) => Uint8Array,
 *     plant: (address: number, data: ArrayLike<number>) => void,
 *     use: (flat: Uint8Array) => void }}
 */
export function recordingGuest({ names, pointerSize = 4 } = {}){
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map();
    /** @param {number} at */
    const page = at=>{
        const number = Math.floor(at / PAGE);
        let found = pages.get(number);
        if (!found)
        {
            found = new Uint8Array(PAGE);
            pages.set(number, found);
        }
        return found;
    };
    /** @type {Uint8Array | null} */
    let flat = null;
    /** @param {number} at */
    const byteAt = at=>(flat && at < flat.length ? flat[at] : page(at)[at % PAGE]);
    /** @param {number} address @param {number} length */
    const bytes = (address, length)=>Uint8Array.from({ length }, (_, at)=>byteAt(address + at));
    /** @param {number} address @param {ArrayLike<number>} data */
    const plant = (address, data)=>{
        for (let at = 0; at < data.length; at++)
        {
            const where = address + at;
            if (flat && where < flat.length)
            {
                flat[where] = data[at];
            }
            else
            {
                page(where)[where % PAGE] = data[at];
            }
        }
    };
    /** @type {Map<number, Uint8Array>} */
    const written = new Map();
    /** @param {number} address @param {Uint8Array} data */
    const write = (address, data)=>{
        plant(address, data);
        written.set(address, data.slice());
    };
    /** @param {number} address @param {number} length */
    const value = (address, length)=>bytes(address, length)
        .reduceRight((sum, byte)=>sum * 0x100 + byte, 0);
    /** @param {number} address @param {number} number @param {number} length */
    const put = (address, number, length)=>write(address,
        Uint8Array.from({ length }, (_, at)=>Math.floor((number >>> 0) / 2 ** (8 * at)) & 0xff));
    /** @param {number} address @param {number} unit @param {number} limit */
    const terminator = (address, unit, limit)=>{
        let count = 0;
        for (let at = 0; at + unit <= limit; at += unit, count++)
        {
            if (value(address + at, unit) === 0)
            {
                return count;
            }
        }
        return count;
    };
    const guest = createGuest({
        readU8: address=>value(address, 1),
        readU16: address=>value(address, 2),
        readU32: address=>value(address, 4),
        writeU8: (address, number)=>put(address, number, 1),
        writeU16: (address, number)=>put(address, number, 2),
        writeU32: (address, number)=>put(address, number, 4),
        readBytes: bytes,
        window: bytes,
        writeBytes: write,
        fillBytes: (address, number, length)=>write(address, new Uint8Array(length).fill(number)),
        scanCString: (address, limit = 4096)=>({ index: terminator(address, 1, limit) }),
        scanWideString: (address, limit = 8192)=>terminator(address, 2, limit),
    }, pointerSize);
    if (names)
    {
        const { text } = guest;
        /** @type {import('./guest.js').Guest['text']} */
        guest.text = (address, wide, limit, counted)=>{
            const named = names instanceof Map ? names.get(address) : names[address];
            // Cut at the limit, as the guest's reader is.
            return named === undefined ? text(address, wide, limit, counted)
                : named.slice(0, limit === undefined ? undefined : wide ? limit >> 1 : limit);
        };
        guest.cstr = (address, limit)=>guest.text(address, false, limit);
        guest.wstr = (address, limit)=>guest.text(address, true, limit);
    }
    return { guest, written, bytes, plant, use: given=>{
        flat = given;
    } };
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

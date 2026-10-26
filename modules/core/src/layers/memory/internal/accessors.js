/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Typed access to guest memory, validated against the region map.
 *
 * Every read and write in the codebase should come through here rather than
 * packing bytes by hand at the call site. Two reasons, and the second is the
 * one that matters: hand-rolled little-endian packing is easy to get subtly
 * wrong and impossible to grep for, and a raw byte poke bypasses the region
 * map entirely, which is where an out-of-bounds or wrong-permission access
 * would otherwise have been caught.
 */

import { guestFault, unterminated } from './faults.js';

/**
 * @typedef {Object} RawMemory
 * @property {(address: number, bytes: Uint8Array) => void} [writeData]
 *     Writes bytes the guest cannot execute, without telling the emulator's
 *     compiler anything. Absent in a build whose memory is a plain buffer.
 * @property {(address: number, value: number, length: number) => void} [fillData]
 *     The same, for a run of one repeated byte, with no buffer to hold the
 *     pattern. Absent in a build whose memory has no such path.
 * @property {(address: number, length: number) => Uint8Array} readPhysical
 * @property {(address: number) => number} [readU32]
 *     A dword read in place, with nothing allocated. Absent in a build whose
 *     memory has no such path.
 * @property {(address: number) => number} [readF32]
 *     The same, reinterpreted as a float. Absent in a build whose memory has
 *     no such path.
 * @property {(address: number, count: number, into: number[], at: number) => void}
 *     [readU32sInto]  Several dwords at once, signed, into an array. Absent in
 *     a build whose memory has no such path.
 * @property {() => Uint8Array | null} [ramView]
 *     The RAM in place, byte 0 at address 0; stale once empty or detached.
 * @property {(address: number, bytes: Uint8Array) => void} writePhysical
 * @property {(address: number, length: number) => void} [markWritten]
 *     Bytes another thread wrote in place: a watch of their pages finds them
 *     written. Absent where the engine watches no writes.
 * @property {(address: number, length: number) =>
 *     ({ take: (address: number, length: number) => number[] } | null)} [watchWrites]
 *     A watch over the range's writes (`write-clock.js`); null where the engine cannot say.
 */

/**
 * How much a scan for a string's terminator reads at a time.
 *
 * A limit on a string read is how far the caller is willing to look, not how
 * long the string is, and the two differ by orders of magnitude: a handler that
 * reads a name hands over a megabyte of headroom for a few dozen bytes. Reading
 * the whole span to find the end copied that megabyte for every string however
 * short, so the scan walks the same span a chunk at a time and copies only the
 * string it found. The chunk is large enough that a long string is not a
 * thousand reads and small enough that a short one is not a region copied.
 */
const SCAN_CHUNK = 256;

/** The scan table that marks nothing: only a terminator ends the walk. */
const NO_BYTES = new Uint8Array(256);

/**
 * Windows-1252 from 0x80 to 0x9F, where it parts from Latin-1: the character
 * each byte stands for, 0 where the page defines none and the byte reads as
 * its own code point.
 */
const CP1252_C1 = [
    0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0000, 0x017d, 0x0000,
    0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];
const LATIN1 = new TextDecoder('latin1');
const C1 = /[\u0080-\u009f]/;
const C1_ALL = /[\u0080-\u009f]/g;

/**
 * Bytes of the ANSI page as text. The encoding standard makes 'latin1' a
 * label of windows-1252, and Chrome decodes it so; Node 22 decodes it -- and
 * 'windows-1252' itself -- as ISO-8859-1, reading 0x80 to 0x9F as C1
 * controls, so what those come back as is mapped here and both hosts agree.
 *
 * @param {Uint8Array} bytes
 */
export const decodeAnsiBytes = bytes=>{
    const text = LATIN1.decode(bytes);
    return C1.test(text)
        ? text.replace(C1_ALL, c=>String.fromCharCode(CP1252_C1[c.charCodeAt(0) - 0x80]
            || c.charCodeAt(0)))
        : text;
};

/**
 * @param {Object} options
 * @param {RawMemory} options.raw            Physical memory, normally the cpu layer.
 * @param {ReturnType<import('./regions.js').createRegionMap>} options.regions
 * @param {((length: number) => void) | null} [options.charge]
 *     Charges a write to whoever is in flight. Absent where nothing publishes
 *     the account, so the write path keeps a branch rather than a call.
 * @param {import('./reader.js').DwordReader | null} [options.reader]
 *     The dword reads, checked and made out of the machine's RAM.
 */
export function createAccessors({ raw, regions, charge = null, reader = null }){
    /**
     * The last regions a read validated, by span and the table's version. A
     * host call reads several dwords -- its arguments on the stack, the fields
     * behind them, the TEB for the thread's last error -- and nearly all of
     * them fall in one of a handful of regions; asking the table each time
     * cost a fifth of what a call cost. Four, because a call's stack, its
     * data and the TEB are three, and a two-entry cache missed on every read
     * of that cycle.
     * @type {{ from: number, to: number, version: number }[]}
     */
    const readable = [];
    let replace = 0;

    /**
     * Validates a span for reading and answers the cached region it fell in.
     *
     * @param {number} address
     * @param {number} length
     */
    const readableSpan = (address, length)=>{
        const version = regions.version;
        for (let i = 0; i < readable.length; i++)
        {
            const span = readable[i];
            if (span.version === version && address >= span.from && address + length <= span.to)
            {
                return span;
            }
        }
        const region = regions.assert(address, length, 'read');
        const span = { from: region.base, to: region.base + region.size, version };
        if (readable.length < 4)
        {
            readable.push(span);
        }
        else
        {
            readable[replace++ & 3] = span;
        }
        return span;
    };

    /**
     * @param {number} address
     * @param {number} length
     * @returns {Uint8Array}
     */
    const read = (address, length)=>{
        // The region the last read fell in, as for a dword below: a handler
        // that reads a structure reads it out of the region its pointer is in.
        readableSpan(address, length);
        // A copy, not a window. The emulator hands back a subarray of its own
        // memory, and a caller that holds one has a value that changes under it
        // -- read two ranges, write one, and the other has silently moved. The
        // shape of that bug is a wrong result with nothing to point at. A hot
        // path that genuinely wants the window can ask for one explicitly, once
        // there is a measurement saying the copy costs something.
        return raw.readPhysical(address, length).slice();
    };

    /**
     * The bytes in place, for a scan done with them before anything else
     * runs: the search for a terminator. Each chunk of a string's scan copied
     * by `read` was most of what reading a string cost a host call. Not for a
     * decode -- `TextDecoder` refuses a view of shared memory, which a page's
     * guest memory is.
     *
     * @param {number} address @param {number} length
     */
    const view = (address, length)=>{
        readableSpan(address, length);
        return raw.readPhysical(address, length);
    };

    /**
     * The terminator's place in a UTF-16 string, in code units: its length,
     * for a caller that does not want the text.
     *
     * @param {number} address
     * @param {number} [limit]  Bytes, not characters.
     * @returns {number}
     */
    const scanWideString = (address, limit = 8192)=>{
        // The span and the chunk are both even, so a code unit never straddles
        // two chunks and the scan can read a chunk at a time like the byte one.
        const span = scannable(address, limit) & ~1;
        for (let at = 0; at < span; at += SCAN_CHUNK)
        {
            const bytes = view(address + at, Math.min(SCAN_CHUNK, span - at));
            for (let i = 0; i + 1 < bytes.length; i += 2)
            {
                if (bytes[i] === 0 && bytes[i + 1] === 0)
                {
                    return (at + i) >>> 1;
                }
            }
        }
        throw unended('wide NUL', address, limit & ~1, span, 2);
    };

    /**
     * How far a scan for a terminator may actually read.
     *
     * A limit is how far the caller is willing to look, not a claim that all of
     * it is mapped -- a string at the end of a region is ordinary, and demanding
     * the whole limit be readable fails on it. Clamped to the region, so the
     * scan still cannot wander into whatever is next.
     *
     * @param {number} address
     * @param {number} limit
     */
    const scannable = (address, limit)=>{
        const region = regions.find(address);
        return region ? Math.min(limit, region.base + region.size - address) : limit;
    };

    /**
     * Why a scan found no terminator: its region ended first -- the next
     * byte is a fault, as the processor would have taken it -- or the limit
     * did, and the string is only longer than the caller would look.
     *
     * @param {string} what @param {number} address @param {number} limit
     * @param {number} span  How far the scan read. @param {number} unit
     */
    const unended = (what, address, limit, span, unit)=>(span < limit
        ? guestFault(`No ${what} before the end of the region, from 0x${address.toString(16)}`,
            address + span, unit, 'read')
        : unterminated(`No ${what} within ${limit} bytes of 0x${address.toString(16)}`,
            address, limit));

    /**
     * @param {number} address
     * @param {Uint8Array} bytes
     */
    const write = (address, bytes)=>{
        regions.assert(address, bytes.length, 'write');
        if (charge)
        {
            charge(bytes.length);
        }
        // Only a write the guest could execute has anything to tell the
        // emulator's compiler. Everything else -- a structure field, an
        // out-parameter, a surface -- goes straight into memory.
        if (raw.writeData && !regions.executable(address))
        {
            raw.writeData(address, bytes);
            return;
        }
        raw.writePhysical(address, bytes);
    };

    /**
     * Sets a range to one byte value.
     *
     * The point is the buffer that is not made. Clearing recycled guest memory
     * through `writeBytes` means allocating the range on the host, having the
     * runtime zero it and copying it across -- three passes over bytes the
     * guest's memory can be filled with in one, and a large short-lived
     * allocation besides. The lengths are whole heap blocks, so this runs
     * inside the guest's own call and holds its thread for the duration.
     *
     * @param {number} address
     * @param {number} value    The byte; only its low eight bits are used.
     * @param {number} length
     */
    const fill = (address, value, length)=>{
        if (length <= 0)
        {
            return;
        }
        // An executable target has the emulator's compiler to tell, and the
        // write path is what tells it. That is a guest code page rather than a
        // heap block, so it is rare, and a buffer there costs nothing worth
        // saving. An unmapped address lands here too, and is refused by the
        // same assertion a write would have made.
        if (!raw.fillData || regions.executable(address))
        {
            write(address, new Uint8Array(length).fill(value & 0xff));
            return;
        }
        regions.assert(address, length, 'write');
        if (charge)
        {
            // Once for the range, as the equivalent write would be charged.
            charge(length);
        }
        raw.fillData(address, value & 0xff, length);
    };

    /** Scratch for the integer writers, so a dword does not cost an allocation. */
    const scratch = new Uint8Array(8);

    /** Scratch for reinterpreting a dword's bits as the float it carries. */
    const floatBits = new DataView(new ArrayBuffer(4));

    /**
     * @param {number} address
     * @param {number} length
     * @returns {number}
     */
    const readInteger = (address, length)=>{
        if (length === 4 && reader !== null)
        {
            return reader.readU32(address);
        }
        if (length === 4 && raw.readU32)
        {
            // The one read every host call makes several of -- an argument, a
            // pointer, a field -- and the one that must not cost a copy.
            readableSpan(address, 4);
            return raw.readU32(address);
        }
        const bytes = read(address, length);
        let value = 0;
        for (let i = length - 1; i >= 0; i--)
        {
            value = value * 0x100 + bytes[i];
        }
        return value >>> 0;
    };

    /**
     * A host call's stack words, straight into the array it fills: one span
     * check rather than one per word, and nothing allocated.
     *
     * A stack is one region on every guest this engine has run, but nothing
     * guarantees it -- a thread's stack straddling two adjacent regions is
     * legal layout, and the span check refuses a span that crosses one. That
     * rare case falls back here to reading each word on its own, so the
     * caller never has to.
     *
     * @param {number} address
     * @param {number} count
     * @param {number[]} into
     * @param {number} [at]  Where in `into` the first word lands.
     */
    const readU32sInto = (address, count, into, at = 0)=>{
        if (reader !== null)
        {
            try
            {
                reader.readU32sInto(address, count, into, at);
                return;
            }
            catch {
                // Not one readable region: word by word below, each word
                // failing as a read of it alone does.
            }
        }
        else if (raw.readU32)
        {
            let region;
            try
            {
                region = readableSpan(address, count * 4);
            }
            catch {
                region = null;
            }
            if (region)
            {
                // One call into the machine for the span, where there is one:
                // the words of a crossing are read on every host call, and each
                // word's own call down through the cpu layer's api to its host
                // cost more than the read -- and several times more in a
                // process's second machine, whose code finds no single machine's
                // functions to count on.
                if (raw.readU32sInto)
                {
                    raw.readU32sInto(address, count, into, at);
                    return;
                }
                for (let word = 0; word < count; word++)
                {
                    into[at + word] = raw.readU32(address + word * 4) | 0;
                }
                return;
            }
        }
        for (let word = 0; word < count; word++)
        {
            into[at + word] = readInteger(address + word * 4, 4) | 0;
        }
    };

    /**
     * The float form of the same read, for a fixed-count vector argument
     * (`glProgramEnvParameter4fvARB`'s four words, `glLoadMatrixf`'s sixteen):
     * one span check, `raw.readF32` per word, nothing allocated.
     *
     * @param {number} address
     * @param {number} count
     * @param {number[] | Float32Array} into
     */
    const readF32sInto = (address, count, into)=>{
        if (raw.readF32)
        {
            let region;
            try
            {
                region = readableSpan(address, count * 4);
            }
            catch {
                region = null;
            }
            if (region)
            {
                for (let word = 0; word < count; word++)
                {
                    into[word] = raw.readF32(address + word * 4);
                }
                return;
            }
        }
        for (let word = 0; word < count; word++)
        {
            floatBits.setUint32(0, readInteger(address + word * 4, 4) >>> 0, true);
            into[word] = floatBits.getFloat32(0, true);
        }
    };

    /**
     * @param {number} address
     * @param {number} value
     * @param {number} length
     */
    const writeInteger = (address, value, length)=>{
        for (let i = 0; i < length; i++)
        {
            scratch[i] = (value >>> (i * 8)) & 0xff;
        }
        write(address, scratch.subarray(0, length));
    };

    return {
        readBytes: read,
        writeBytes: write,
        fillBytes: fill,

        /**
         * Bytes another thread wrote into the guest's memory in place -- a
         * worker sharing it -- taken as this thread's own write: the range is
         * the program's to have written, it is charged, and a range the
         * guest could execute is told to the emulator's compiler, as a write
         * through here would have been.
         *
         * @param {number} address @param {number} length
         */
        adopt(address, length){
            if (length <= 0)
            {
                return;
            }
            regions.assert(address, length, 'write');
            if (charge)
            {
                charge(length);
            }
            if (!raw.writeData || regions.executable(address))
            {
                raw.writePhysical(address, raw.readPhysical(address, length).slice());
            }
            else
            {
                raw.markWritten?.(address, length);
            }
        },

        /**
         * The window the copy above refuses: the emulator's own bytes, valid
         * only until control returns to the guest. For a path that reads a
         * block every call and has measured what the copy costs.
         *
         * @param {number} address @param {number} length
         */
        window(address, length){
            regions.assert(address, length, 'read');
            return raw.readPhysical(address, length);
        },

        /** @param {number} address */
        readU8: address=>readInteger(address, 1),
        /** @param {number} address */
        readU16: address=>readInteger(address, 2),
        /** @param {number} address */
        readU32: address=>readInteger(address, 4),

        readU32sInto,
        readF32sInto,

        /** @param {number} address @param {number} value */
        writeU8: (address, value)=>writeInteger(address, value, 1),
        /** @param {number} address @param {number} value */
        writeU16: (address, value)=>writeInteger(address, value, 2),
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>writeInteger(address, value, 4),

        /**
         * Reads a NUL-terminated byte string, as the guest's own APIs hand them over.
         *
         * @param {number} address
         * @param {number} [limit]  Refuses to scan past this many bytes.
         * @returns {string}
         */
        readCString(address, limit = 4096){
            const span = scannable(address, limit);
            let length = -1;
            for (let at = 0; at < span; at += SCAN_CHUNK)
            {
                const end = view(address + at, Math.min(SCAN_CHUNK, span - at)).indexOf(0);
                if (end !== -1)
                {
                    length = at + end;
                    break;
                }
            }
            if (length === -1)
            {
                throw unended('NUL', address, limit, span, 1);
            }
            return decodeAnsiBytes(read(address, length));
        },

        /**
         * The scan form of the same walk: the first byte a table marks, or the
         * terminator, whichever comes first, as an index and the byte itself.
         *
         * For the C functions whose answer sits near the front of a string that
         * is not near -- a span, a search -- and for the ones that want the
         * string's length rather than its text. readCString answers those too,
         * but only by materialising the whole string as a JS string first: a
         * copy, a decode and a byte of garbage collection per character, for a
         * caller that was only ever going to look at the first few.
         *
         * @param {number} address
         * @param {number} limit    Refuses to scan past this many bytes.
         * @param {Uint8Array} wanted  Byte values that end the scan, nonzero at
         *     the ones that do. The terminator ends it whether marked or not.
         * @returns {{ index: number, byte: number }}
         */
        scanCString(address, limit = 4096, wanted = NO_BYTES){
            const span = scannable(address, limit);
            for (let at = 0; at < span; at += SCAN_CHUNK)
            {
                const bytes = view(address + at, Math.min(SCAN_CHUNK, span - at));
                for (let i = 0; i < bytes.length; i++)
                {
                    const byte = bytes[i];
                    if (byte === 0 || wanted[byte] !== 0)
                    {
                        return { index: at + i, byte };
                    }
                }
            }
            throw unended('NUL', address, limit, span, 1);
        },

        /**
         * The same for a UTF-16 string, which is what every W-suffixed entry
         * point is handed.
         *
         * @param {number} address
         * @param {number} [limit]  Bytes, not characters.
         * @returns {string}
         */
        readWideString(address, limit = 8192){
            const units = scanWideString(address, limit);
            return new TextDecoder('utf-16le').decode(read(address, units * 2));
        },

        scanWideString,
    };
}

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
 * @property {(address: number, bytes: Uint8Array) => void} writePhysical
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
 * @param {Object} options
 * @param {RawMemory} options.raw            Physical memory, normally the cpu layer.
 * @param {ReturnType<import('./regions.js').createRegionMap>} options.regions
 * @param {((length: number) => void) | null} [options.charge]
 *     Charges a write to whoever is in flight. Absent where nothing publishes
 *     the account, so the write path keeps a branch rather than a call.
 */
export function createAccessors({ raw, regions, charge = null }){
    /**
     * The last two regions a read validated, by span and the table's version.
     * A host call reads several dwords -- its arguments, the fields behind
     * them, and often the TEB beside its own stack -- and nearly all of them
     * fall in one of the last two regions a read did; asking the table each
     * time cost a fifth of what a call cost, and a stack/TEB alternation
     * missed a one-entry cache on every single read.
     * @type {{ from: number, to: number, version: number } | null}
     */
    let mostRecentReadable = null;
    /** @type {{ from: number, to: number, version: number } | null} */
    let secondMostRecentReadable = null;

    /**
     * Validates a span for reading and answers the cached region it fell in.
     *
     * @param {number} address
     * @param {number} length
     */
    const readableSpan = (address, length)=>{
        if (mostRecentReadable && mostRecentReadable.version === regions.version
            && address >= mostRecentReadable.from && address + length <= mostRecentReadable.to)
        {
            return mostRecentReadable;
        }
        if (secondMostRecentReadable && secondMostRecentReadable.version === regions.version
            && address >= secondMostRecentReadable.from
            && address + length <= secondMostRecentReadable.to)
        {
            [mostRecentReadable, secondMostRecentReadable]
                = [secondMostRecentReadable, mostRecentReadable];
            return mostRecentReadable;
        }
        const region = regions.assert(address, length, 'read');
        secondMostRecentReadable = mostRecentReadable;
        mostRecentReadable = {
            from: region.base, to: region.base + region.size, version: regions.version,
        };
        return mostRecentReadable;
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


    /**
     * @param {number} address
     * @param {number} length
     * @returns {number}
     */
    const readInteger = (address, length)=>{
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
                const end = read(address + at, Math.min(SCAN_CHUNK, span - at)).indexOf(0);
                if (end !== -1)
                {
                    length = at + end;
                    break;
                }
            }
            if (length === -1)
            {
                throw new Error(
                    `No NUL within ${limit} bytes of 0x${address.toString(16)}`);
            }
            return new TextDecoder('latin1').decode(read(address, length));
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
                const bytes = read(address + at, Math.min(SCAN_CHUNK, span - at));
                for (let i = 0; i < bytes.length; i++)
                {
                    const byte = bytes[i];
                    if (byte === 0 || wanted[byte] !== 0)
                    {
                        return { index: at + i, byte };
                    }
                }
            }
            throw new Error(
                `No NUL within ${limit} bytes of 0x${address.toString(16)}`);
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
            // The span and the chunk are both even, so a code unit never straddles
            // two chunks and the scan can read a chunk at a time like the byte one.
            const span = scannable(address, limit) & ~1;
            let length = -1;
            for (let at = 0; at < span && length === -1; at += SCAN_CHUNK)
            {
                const bytes = read(address + at, Math.min(SCAN_CHUNK, span - at));
                for (let i = 0; i + 1 < bytes.length; i += 2)
                {
                    if (bytes[i] === 0 && bytes[i + 1] === 0)
                    {
                        length = at + i;
                        break;
                    }
                }
            }
            if (length === -1)
            {
                throw new Error(
                    `No wide NUL within ${limit} bytes of 0x${address.toString(16)}`);
            }
            return new TextDecoder('utf-16le').decode(read(address, length));
        },
    };
}

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
 * @property {(address: number, length: number) => Uint8Array} readPhysical
 * @property {(address: number) => number} [readU32]
 *     A dword read in place, with nothing allocated. Absent in a build whose
 *     memory has no such path.
 * @property {(address: number, bytes: Uint8Array) => void} writePhysical
 */

/**
 * @param {Object} options
 * @param {RawMemory} options.raw            Physical memory, normally the cpu layer.
 * @param {ReturnType<import('./regions.js').createRegionMap>} options.regions
 */
export function createAccessors({ raw, regions }){
    /**
     * The region the last dword read fell in, by its span and the table's
     * version. A host call reads several dwords -- its arguments, the fields
     * behind them -- and nearly all of them fall in the region the last one
     * did; asking the table each time cost a fifth of what a call cost.
     */
    let readableFrom = 0;
    let readableTo = 0;
    let readableVersion = -1;

    /**
     * @param {number} address
     * @param {number} length
     * @returns {Uint8Array}
     */
    const read = (address, length)=>{
        // The region the last read fell in, as for a dword below: a handler
        // that reads a structure reads it out of the region its pointer is in.
        if (readableVersion !== regions.version
            || address < readableFrom || address + length > readableTo)
        {
            const region = regions.assert(address, length, 'read');
            readableFrom = region.base;
            readableTo = region.base + region.size;
            readableVersion = regions.version;
        }
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
            if (readableVersion !== regions.version
                || address < readableFrom || address + 4 > readableTo)
            {
                const region = regions.assert(address, 4, 'read');
                readableFrom = region.base;
                readableTo = region.base + region.size;
                readableVersion = regions.version;
            }
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
            const bytes = read(address, scannable(address, limit));
            const end = bytes.indexOf(0);
            if (end === -1)
            {
                throw new Error(
                    `No NUL within ${limit} bytes of 0x${address.toString(16)}`);
            }
            return new TextDecoder('latin1').decode(bytes.subarray(0, end));
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
            const bytes = read(address, scannable(address, limit) & ~1);
            for (let at = 0; at + 1 < bytes.length; at += 2)
            {
                if (bytes[at] === 0 && bytes[at + 1] === 0)
                {
                    return new TextDecoder('utf-16le').decode(bytes.subarray(0, at));
                }
            }
            throw new Error(
                `No wide NUL within ${limit} bytes of 0x${address.toString(16)}`);
        },
    };
}

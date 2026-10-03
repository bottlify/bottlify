/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The host's dword reads of guest memory -- a host call's stack words, a
 * thread block's field -- checked against the region map and read straight
 * out of the machine's RAM.
 *
 * A class rather than closures a `create()` makes: its methods are one set of
 * functions for the realm, optimised once and inlined into their callers in
 * every machine a process makes, where a closure of a later machine starts
 * unoptimised and is compiled around what the machines before it left.
 * What differs between machines -- the table, the
 * RAM, the spans read last -- is the instance's.
 */

/**
 * @typedef {Object} ReaderRegions
 * @property {number} version  Bumped whenever a region comes, goes or changes access.
 * @property {(address: number, length: number, mode: 'read') =>
 *     { base: number, size: number }} assert
 *     The region a span lies in, or a throw that says why it lies in none.
 */

/**
 * @typedef {Object} ReaderMachine
 * @property {() => Uint8Array | null} [ramView]
 *     The guest's RAM, byte 0 at address 0: empty or detached once the
 *     machine's memory has moved, and asked for again.
 * @property {(address: number) => number} readU32
 * @property {(address: number, count: number, into: number[], at: number) => void} [readU32sInto]
 */

/** How many validated spans a reader keeps: a call's stack, its thread's block, its data. */
const SPANS = 4;

export class DwordReader {
    /** @param {ReaderRegions} regions @param {ReaderMachine} machine */
    constructor(regions, machine){
        this.regions = regions;
        this.machine = machine;
        /** @type {DataView | null} */
        this.data = null;
        this.lends = typeof machine.ramView === 'function';
        // The last spans a read validated, as [from, to) pairs, and the
        // table's version they were validated at: a host call reads its
        // stack, its thread's block and the data its arguments point at, and
        // a cache of fewer missed on every read of that cycle.
        this.version = -1;
        this.spans = new Float64Array(SPANS * 2);
        this.replace = 0;
    }

    /**
     * Whether the span lies in a region a read validated since the table
     * last changed -- the question every read asks first, answered here
     * without a call.
     *
     * @param {number} address @param {number} end
     */
    known(address, end){
        if (this.version !== this.regions.version)
        {
            return false;
        }
        const spans = this.spans;
        for (let at = 0; at < SPANS * 2; at += 2)
        {
            if (address >= spans[at] && end <= spans[at + 1])
            {
                return true;
            }
        }
        return false;
    }

    /**
     * Throws, as the region map does, unless every byte of the span is in one
     * readable region, and remembers the region for the reads after it.
     *
     * @param {number} address @param {number} length
     */
    check(address, length){
        if (this.known(address, address + length))
        {
            return;
        }
        if (this.version !== this.regions.version)
        {
            this.version = this.regions.version;
            this.spans.fill(0);
        }
        const region = this.regions.assert(address, length, 'read');
        const at = this.replace;
        this.spans[at] = region.base;
        this.spans[at + 1] = region.base + region.size;
        this.replace = (at + 2) % (SPANS * 2);
    }

    /**
     * The RAM as a DataView, asked of the machine when there is none; null
     * when it lends none.
     */
    ram(){
        if (this.data === null && this.lends)
        {
            const bytes = this.machine.ramView?.() ?? null;
            if (bytes === null)
            {
                this.lends = false;
                return null;
            }
            this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
        return this.data;
    }

    /**
     * Dwords, signed, into an array.
     *
     * @param {number} address @param {number} count
     * @param {number[]} into @param {number} at  Where the first lands.
     */
    readU32sInto(address, count, into, at){
        const data = this.data;
        if (data !== null && this.known(address, address + count * 4))
        {
            try
            {
                for (let word = 0; word < count; word++)
                {
                    into[at + word] = data.getInt32(address + word * 4, true);
                }
                return;
            }
            catch {
                // Detached: the machine's memory moved, and the view is
                // asked for again below.
                this.data = null;
            }
        }
        this.readSlowly(address, count, into, at);
    }

    /**
     * The same, off the path every crossing takes: a span not yet validated,
     * a view not yet taken or gone stale, or a machine that lends none.
     *
     * @param {number} address @param {number} count
     * @param {number[]} into @param {number} at
     */
    readSlowly(address, count, into, at){
        this.check(address, count * 4);
        const data = this.ram();
        if (data !== null)
        {
            try
            {
                for (let word = 0; word < count; word++)
                {
                    into[at + word] = data.getInt32(address + word * 4, true);
                }
                return;
            }
            catch {
                this.data = null;
            }
        }
        const machine = this.machine;
        if (machine.readU32sInto)
        {
            machine.readU32sInto(address, count, into, at);
            return;
        }
        for (let word = 0; word < count; word++)
        {
            into[at + word] = machine.readU32(address + word * 4) | 0;
        }
    }

    /** @param {number} address */
    readU32(address){
        const data = this.data;
        if (data !== null && this.known(address, address + 4))
        {
            try
            {
                return data.getUint32(address, true);
            }
            catch {
                this.data = null;
            }
        }
        this.check(address, 4);
        const fresh = this.ram();
        if (fresh !== null)
        {
            try
            {
                return fresh.getUint32(address, true);
            }
            catch {
                this.data = null;
            }
        }
        return this.machine.readU32(address) >>> 0;
    }
}

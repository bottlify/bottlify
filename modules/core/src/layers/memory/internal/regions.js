/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The region map: what exists in the guest address space, and who may touch it.
 *
 * This is a registry and a validator, not an allocator. Callers decide where
 * things go; this records the decision, refuses layouts that overlap, and
 * answers whether a given access is legal. Keeping allocation out means the map
 * stays truthful even for memory we did not place ourselves -- a PE image loads
 * at the base its headers demand, and pointers handed to us by the guest are
 * checked against the same map.
 */

/** What a region holds. Drives permissions and, later, diagnostics. */
export const RegionKind = {
    /** The first megabyte: real-mode leftovers and our boot ROM. */
    LOW_MEM: 'low_mem',
    /** A mapped PE image. */
    IMAGE: 'image',
    /** Guest-side call stubs. Executable and never written after setup. */
    THUNK_CODE: 'thunk_code',
    /** Scratch the host writes for the guest to read (entry vector and friends). */
    THUNK_DATA: 'thunk_data',
    /** A thread stack. */
    STACK: 'stack',
    /** Deliberately unusable: a guard band between other regions. */
    RESERVED: 'reserved',
};

/** Access modes a region can permit. */
export const Access = {
    NONE: 'none',
    READ: 'r',
    READ_WRITE: 'rw',
    READ_EXECUTE: 'rx',
    READ_WRITE_EXECUTE: 'rwx',
};

const PERMITS = {
    [Access.NONE]: { read: false, write: false, execute: false },
    [Access.READ]: { read: true, write: false, execute: false },
    [Access.READ_WRITE]: { read: true, write: true, execute: false },
    [Access.READ_EXECUTE]: { read: true, write: false, execute: true },
    [Access.READ_WRITE_EXECUTE]: { read: true, write: true, execute: true },
};

/**
 * @typedef {Object} Region
 * @property {string} name
 * @property {number} base
 * @property {number} size
 * @property {string} kind    One of RegionKind.
 * @property {string} access  One of Access.
 */

/**
 * Creates an empty region map.
 */
export function createRegionMap(){
    /** @type {Region[]} */
    const regions = [];
    /**
     * The last two regions a lookup found, most recent first. Regions are only
     * ever added, so both stay valid once set. Two rather than one because a
     * host call reads its own stack and the TEB in the same crossing, and those
     * alternate: a one-entry cache misses on every single lookup for a pattern
     * that a two-entry one answers from cache every time but the first.
     * @type {Region | undefined}
     */
    let mostRecent;
    /** @type {Region | undefined} */
    let secondMostRecent;
    /** Bumped only when a lookup falls through to the linear scan below. */
    let scans = 0;

    /**
     * @param {number} base
     * @param {number} size
     * @returns {Region | undefined}
     */
    const overlapping = (base, size)=>regions.find(
        region=>base < region.base + region.size && region.base < base + size);

    /**
     * Bumped whenever the table or a region's permissions change, so a caller
     * that remembers the region an address fell in can tell when that memory
     * is stale rather than asking again on every read.
     */
    let version = 0;

    return {
        get version(){
            return version;
        },
        /**
         * Records a region, refusing anything that collides with what is already
         * mapped. An overlap is a layout bug, and it is far cheaper to hear about
         * it here than to debug a guest whose stack quietly grew into its own code.
         *
         * @param {Region} region
         * @returns {Region}
         */
        register(region){
            if (region.size <= 0)
            {
                throw new Error(`Region "${region.name}" must have a positive size`);
            }
            if (!(region.access in PERMITS))
            {
                throw new Error(`Region "${region.name}" has unknown access "${region.access}"`);
            }
            const clash = overlapping(region.base, region.size);
            if (clash)
            {
                throw new Error(
                    `Region "${region.name}" at 0x${region.base.toString(16)}`
                    + `+0x${region.size.toString(16)} overlaps "${clash.name}"`
                    + ` at 0x${clash.base.toString(16)}+0x${clash.size.toString(16)}`);
            }
            regions.push({ ...region });
            version++;
            return region;
        },

        /**
         * Changes what a region permits, the way VirtualProtect does.
         *
         * The case this exists for: thunk code is written once at setup and must
         * be read-only afterwards, so a later stray write is caught instead of
         * silently rewriting the stubs the guest calls through.
         *
         * @param {string} name
         * @param {string} access
         */
        protect(name, access){
            const region = regions.find(candidate=>candidate.name === name);
            if (!region)
            {
                throw new Error(`No region named "${name}"`);
            }
            if (!(access in PERMITS))
            {
                throw new Error(`Unknown access "${access}"`);
            }
            region.access = access;
            version++;
        },

        /**
         * @param {number} address
         * @returns {Region | undefined}
         */
        find(address){
            // Asked on every read and write the host makes, thousands a
            // frame, nearly all of them in one of the last two regions hit:
            // those are tried first, and the walk below makes no closure.
            if (mostRecent
                && address >= mostRecent.base && address < mostRecent.base + mostRecent.size)
            {
                return mostRecent;
            }
            if (secondMostRecent
                && address >= secondMostRecent.base
                && address < secondMostRecent.base + secondMostRecent.size)
            {
                [mostRecent, secondMostRecent] = [secondMostRecent, mostRecent];
                return mostRecent;
            }
            scans++;
            for (let index = 0; index < regions.length; index++)
            {
                const region = regions[index];
                if (address >= region.base && address < region.base + region.size)
                {
                    secondMostRecent = mostRecent;
                    mostRecent = region;
                    return region;
                }
            }
            return undefined;
        },

        /** How many lookups missed both cached regions. Diagnostics and tests only. */
        get scans(){
            return scans;
        },

        /**
         * The mapped region with the lowest base above an address, for
         * answering how far a free gap runs: `VirtualQuery` on an
         * unmapped address needs where the *next* thing starts, not what
         * contains it. Uncached and a linear scan, unlike `find` above --
         * asked only when a query already fell through to the free branch,
         * never on the hot read/write path.
         *
         * @param {number} address
         * @returns {Region | undefined}
         */
        nextRegionAfter(address){
            /** @type {Region | undefined} */
            let closest;
            for (let index = 0; index < regions.length; index++)
            {
                const region = regions[index];
                if (region.base > address && (!closest || region.base < closest.base))
                {
                    closest = region;
                }
            }
            return closest;
        },

        /**
         * Throws unless the whole span sits inside one region that permits `mode`.
         *
         * A span crossing two adjacent regions is rejected on purpose: adjacency
         * is a coincidence of layout, not permission to treat them as one buffer.
         *
         * @param {number} address
         * @param {number} length
         * @param {'read' | 'write' | 'execute'} mode
         */
        assert(address, length, mode){
            const region = this.find(address);
            if (!region)
            {
                throw new Error(
                    `Unmapped ${mode} at 0x${address.toString(16)} (${length} bytes)`);
            }
            if (address + length > region.base + region.size)
            {
                throw new Error(
                    `${mode} of ${length} bytes at 0x${address.toString(16)}`
                    + ` runs past the end of region "${region.name}"`);
            }
            if (!PERMITS[region.access][mode])
            {
                throw new Error(
                    `Region "${region.name}" (${region.access}) does not permit ${mode}`
                    + ` at 0x${address.toString(16)}`);
            }
            return region;
        },

        /**
         * Whether anything at this address could ever be executed.
         *
         * Asked by whoever writes on the host's behalf: a write into memory the
         * guest can execute may be changing code the emulator has compiled, and
         * has to say so. A write anywhere else cannot be, and paying the
         * emulator's invalidation for it is pure loss.
         *
         * @param {number} address
         * @returns {boolean} true when nothing is known, which is the safe answer.
         */
        executable(address){
            const region = this.find(address);
            return region ? PERMITS[region.access].execute : true;
        },

        /** @returns {Region[]} every region, lowest address first. */
        list(){
            return [...regions].sort((a, b)=>a.base - b.base);
        },
    };
}

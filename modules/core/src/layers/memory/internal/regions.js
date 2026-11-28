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

import { guestFault } from './faults.js';

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
     * The last two regions a lookup found, most recent first. Both are
     * forgotten when a region is given back, the one change that can make
     * either stale. Two rather than one because a host call reads its own
     * stack and the TEB in the same crossing, and those alternate: a
     * one-entry cache misses on every single lookup for a pattern that a
     * two-entry one answers from cache every time but the first.
     * @type {Region | undefined}
     */
    let mostRecent;
    /** @type {Region | undefined} */
    let secondMostRecent;

    /**
     * @param {number} base
     * @param {number} size
     * @returns {Region | undefined}
     */
    const overlapping = (base, size)=>regions.find(
        region=>base < region.base + region.size && region.base < base + size);

    // Plain fields rather than getters over closed-over counters: a getter in
    // this literal put the whole table in V8's dictionary mode, and `version`,
    // read twice on every host read of guest memory, was a tenth of what a
    // host call cost.
    const table = {
        /**
         * Bumped whenever the table or a region's permissions change, so a
         * caller that remembers the region an address fell in can tell when
         * that memory is stale rather than asking again on every read.
         */
        version: 0,
        /** How many lookups missed both cached regions. Diagnostics and tests only. */
        scans: 0,
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
            // A name has one owner: `unregister` takes the first by name, and
            // two regions of one name let one owner's release unmap the other's.
            if (regions.some(candidate=>candidate.name === region.name))
            {
                throw new Error(`Region "${region.name}" is already registered`);
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
            table.version++;
            return region;
        },

        /**
         * Gives a region back: its span is unmapped from here on, and free for
         * whatever is registered next. For memory whose owner is gone -- the
         * stack of a thread that has exited -- and never for memory someone
         * may still reach.
         *
         * @param {string} name
         */
        unregister(name){
            const at = regions.findIndex(candidate=>candidate.name === name);
            if (at < 0)
            {
                throw new Error(`No region named "${name}"`);
            }
            regions.splice(at, 1);
            mostRecent = undefined;
            secondMostRecent = undefined;
            table.version++;
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
            table.version++;
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
            table.scans++;
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
         * Throws unless every byte of the span is mapped and permits `mode`.
         * A span across regions side by side is one access, as Windows takes
         * it: refused only at the first byte not there or not for this, which
         * the fault names. Answers the region the span starts in.
         *
         * @param {number} address
         * @param {number} length
         * @param {'read' | 'write' | 'execute'} mode
         */
        assert(address, length, mode){
            const first = this.find(address);
            const end = address + length;
            for (let region = first, at = address; ; region = this.find(at))
            {
                if (!region)
                {
                    throw guestFault(`Unmapped ${mode} at 0x${at.toString(16)} (${length} bytes`
                        + ` from 0x${address.toString(16)})`, at, length, mode);
                }
                if (!PERMITS[region.access][mode])
                {
                    throw guestFault(`Region "${region.name}" (${region.access}) does not permit`
                        + ` ${mode} at 0x${at.toString(16)}`, at, length, mode);
                }
                at = region.base + region.size;
                if (at >= end)
                {
                    return /** @type {Region} */ (first);
                }
            }
        },

        /**
         * Where the run of regions side by side from `address` that permit
         * `mode` ends: how far a scan from it may read. `address` itself where
         * it is not there or not for this.
         *
         * @param {number} address @param {'read' | 'write'} mode
         */
        extent(address, mode){
            let at = address;
            for (let region = this.find(at); region && PERMITS[region.access][mode];
                region = this.find(at))
            {
                at = region.base + region.size;
            }
            return at;
        },

        /**
         * Whether anything of a span could ever be executed.
         *
         * Asked by whoever writes on the host's behalf: a write into memory the
         * guest can execute may be changing code the translator has compiled,
         * and has to say so - one that runs on into code from data too. A
         * write anywhere else cannot be, and paying the translator's
         * invalidation for it is pure loss.
         *
         * @param {number} address
         * @param {number} [length]
         * @returns {boolean} true when nothing is known, which is the safe answer.
         */
        executable(address, length = 1){
            const end = address + length;
            for (let at = address; at < end;)
            {
                const region = this.find(at);
                if (!region || PERMITS[region.access].execute)
                {
                    return true;
                }
                at = region.base + region.size;
            }
            return false;
        },

        /** @returns {Region[]} every region, lowest address first. */
        list(){
            return [...regions].sort((a, b)=>a.base - b.base);
        },
    };
    return table;
}

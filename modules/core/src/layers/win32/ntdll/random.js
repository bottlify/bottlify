/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * ntdll's random numbers over a seed the caller keeps.
 *
 * RtlUniform is the linear congruential generator Microsoft documents as
 * Lehmer's: the next value is (seed * 0x7fffffed + 0x7fffffc3) mod 0x7fffffff,
 * written back as the seed. The modulus is MAXLONG, not MAXLONG + 1 as the
 * documentation reads: RtlUniform of 0 and of MAXLONG answer alike on Windows
 * (Wine's ntdll:rtl measures it). RtlRandom and RtlRandomEx draw from a table
 * of earlier values the generator refills, Bays and Durham's shuffle, so two
 * calls in a row are not two neighbours of one sequence.
 */

const MULTIPLIER = 0x7fffffedn;
const INCREMENT = 0x7fffffc3n;
const MODULUS = 0x7fffffffn;
/** How many earlier values the shuffle keeps. */
const TABLE = 128;

/**
 * @typedef {Object} RandomHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/** @param {number} seed @returns {number} the next value of the sequence */
export const uniformStep = seed=>Number((BigInt(seed >>> 0) * MULTIPLIER + INCREMENT) % MODULUS);

/**
 * @param {RandomHost} host
 */
export function createRandomFunctions(host){
    /** @param {number} at */
    const readSeed = at=>{
        const bytes = host.readMemory(wholeAddress(at), 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const writeSeed = (at, value)=>host.writeMemory(wholeAddress(at),
        Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24));

    // The shuffle's table, filled from a fixed start the first time it is
    // drawn on: the process's own, as Windows' is.
    /** @type {number[]} */
    const table = [];
    let filler = 0x2f6e2b1;
    for (let at = 0; at < TABLE; at++)
    {
        filler = uniformStep(filler);
        table.push(filler);
    }

    /** One step of the shuffle over the caller's seed. @param {number} pointer */
    const shuffled = pointer=>{
        const first = uniformStep(readSeed(pointer));
        const second = uniformStep(first);
        writeSeed(pointer, second);
        const slot = second % TABLE;
        const drawn = table[slot];
        table[slot] = first;
        return drawn;
    };

    return {
        /** ULONG RtlUniform(PULONG Seed) */
        RtlUniform: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const next = uniformStep(readSeed(pointer));
                writeSeed(pointer, next);
                return next;
            },
        },
        /** ULONG RtlRandom(PULONG Seed) */
        RtlRandom: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>shuffled(pointer),
        },
        /** ULONG RtlRandomEx(PULONG Seed): RtlRandom's numbers, Vista on. */
        RtlRandomEx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>shuffled(pointer),
        },
    };
}

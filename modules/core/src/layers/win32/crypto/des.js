/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DES, one 64-bit block at a time (electronic codebook), written out from its
 * definition in FIPS 46-3: the initial and final permutations, sixteen rounds
 * of the expansion, the eight S-boxes and the permutation P, and the key
 * schedule's PC-1, rotations and PC-2. What the LAN Manager hash and the
 * SystemFunction family of advapi32 are built from.
 *
 * The tables are numbered from 1, as the standard prints them, bit 1 being
 * the most significant bit of the block.
 */

/** Initial permutation IP. */
const IP = [
    58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
    62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

/** Final permutation, IP's inverse. */
const FP = [
    40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
    38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

/** The expansion E: 32 bits to 48. */
const E = [
    32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
    16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

/** The permutation P of the S-boxes' output. */
const P = [
    16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
    2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

/** The eight S-boxes, each four rows of sixteen. */
const S = [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
        0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
        4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
        15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
        3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
        0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
        13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
        13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
        13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
        1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
        13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
        10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
        3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
        14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
        4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
        11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
        10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
        9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
        4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
        13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
        1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
        6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
        1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
        7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
        2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

/** Permuted choice 1: the key's 56 bits, parity dropped, as C and D. */
const PC1 = [
    57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
    10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
    63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
    14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];

/** Permuted choice 2: each round's 48-bit key from C and D. */
const PC2 = [
    14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8,
    16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
    44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

/** How far C and D rotate before each round. */
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

/**
 * The bits a table picks from a bit array, in the table's order.
 *
 * @param {Uint8Array} bits  One bit per byte, bit 1 first. @param {number[]} table
 */
const permute = (bits, table)=>Uint8Array.from(table, at=>bits[at - 1]);

/** @param {Uint8Array} bytes @returns {Uint8Array} one bit per byte, most significant first */
const toBits = bytes=>Uint8Array.from({ length: bytes.length * 8 },
    (_, at)=>bytes[at >> 3] >> (7 - (at & 7)) & 1);

/** @param {Uint8Array} bits @returns {Uint8Array} */
const fromBits = bits=>{
    const bytes = new Uint8Array(bits.length >> 3);
    bits.forEach((bit, at)=>{
        bytes[at >> 3] |= bit << (7 - (at & 7));
    });
    return bytes;
};

/**
 * The sixteen round keys of an eight-byte key, its parity bits ignored.
 *
 * @param {Uint8Array} key @returns {Uint8Array[]}
 */
const schedule = key=>{
    const chosen = permute(toBits(key), PC1);
    let c = chosen.slice(0, 28);
    let d = chosen.slice(28);
    return SHIFTS.map(shift=>{
        c = Uint8Array.from([...c.slice(shift), ...c.slice(0, shift)]);
        d = Uint8Array.from([...d.slice(shift), ...d.slice(0, shift)]);
        return permute(Uint8Array.from([...c, ...d]), PC2);
    });
};

/**
 * One block through the sixteen rounds, the round keys in the order given.
 *
 * @param {Uint8Array} block @param {Uint8Array[]} keys @returns {Uint8Array}
 */
const crypt = (block, keys)=>{
    const bits = permute(toBits(block), IP);
    let left = bits.slice(0, 32);
    let right = bits.slice(32);
    for (const key of keys)
    {
        const mixed = permute(right, E).map((bit, at)=>bit ^ key[at]);
        const out = new Uint8Array(32);
        for (let box = 0; box < 8; box++)
        {
            const six = mixed.subarray(box * 6, box * 6 + 6);
            const row = six[0] << 1 | six[5];
            const column = six[1] << 3 | six[2] << 2 | six[3] << 1 | six[4];
            const value = S[box][row * 16 + column];
            for (let bit = 0; bit < 4; bit++)
            {
                out[box * 4 + bit] = value >> (3 - bit) & 1;
            }
        }
        const next = permute(out, P).map((bit, at)=>bit ^ left[at]);
        left = right;
        right = next;
    }
    return fromBits(permute(Uint8Array.from([...right, ...left]), FP));
};

/**
 * @param {Uint8Array} key  Eight bytes.
 * @returns {{ encrypt: (block: Uint8Array) => Uint8Array,
 *             decrypt: (block: Uint8Array) => Uint8Array }} one block each way
 */
export function createDes(key){
    const keys = schedule(key);
    const reversed = [...keys].reverse();
    return {
        encrypt: block=>crypt(block, keys),
        decrypt: block=>crypt(block, reversed),
    };
}

/**
 * The eight-byte key a seven-byte one stands for, as the LAN Manager hash
 * and its kin spread one: seven bits to a byte, the low bit -- parity, which
 * DES ignores -- left clear.
 *
 * @param {Uint8Array} seven @returns {Uint8Array}
 */
export function expandKey(seven){
    const bits = toBits(seven);
    return Uint8Array.from({ length: 8 }, (_, at)=>{
        let byte = 0;
        for (let bit = 0; bit < 7; bit++)
        {
            byte |= bits[at * 7 + bit] << (7 - bit);
        }
        return byte;
    });
}

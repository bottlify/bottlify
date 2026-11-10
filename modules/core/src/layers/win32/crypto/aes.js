/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * AES, one 128-bit block at a time, written out from its definition in
 * FIPS 197: SubBytes, ShiftRows, MixColumns and AddRoundKey, and the key
 * expansion for 128-, 192- and 256-bit keys. The S-box is computed as the
 * standard defines it (the inverse in GF(2^8), then the affine map), not
 * copied as a table. What bcrypt's symmetric keys are built from.
 */

/** Multiplication by x in GF(2^8), modulo x^8 + x^4 + x^3 + x + 1. @param {number} a */
const xtime = a=>((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

/** @param {number} a @param {number} b */
const multiply = (a, b)=>{
    let product = 0;
    for (; b; b >>= 1, a = xtime(a))
    {
        if (b & 1)
        {
            product ^= a;
        }
    }
    return product;
};

const SBOX = new Uint8Array(256);
const INVERSE_SBOX = new Uint8Array(256);
for (let x = 0; x < 256; x++)
{
    // The multiplicative inverse (0 for 0), then the affine transformation (5.1.1).
    let inverse = 0;
    for (let y = 1; y < 256 && inverse === 0; y++)
    {
        if (multiply(x, y) === 1)
        {
            inverse = y;
        }
    }
    let s = inverse;
    for (let shift = 1; shift <= 4; shift++)
    {
        s ^= ((inverse << shift) | (inverse >> (8 - shift))) & 0xff;
    }
    SBOX[x] = s ^ 0x63;
    INVERSE_SBOX[SBOX[x]] = x;
}

/**
 * The round keys of a 16-, 24- or 32-byte key (5.2), as 4 * (rounds + 1) bytes per row.
 *
 * @param {Uint8Array} key
 * @returns {Uint8Array}
 */
function expandKey(key){
    const words = key.length / 4;
    const rounds = words + 6;
    const total = 4 * (rounds + 1);
    const w = new Uint8Array(total * 4);
    w.set(key);
    let rcon = 1;
    for (let i = words; i < total; i++)
    {
        let t = w.slice((i - 1) * 4, i * 4);
        if (i % words === 0)
        {
            t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]);
            rcon = xtime(rcon);
        }
        else if (words > 6 && i % words === 4)
        {
            t = t.map(byte=>SBOX[byte]);
        }
        for (let j = 0; j < 4; j++)
        {
            w[i * 4 + j] = w[(i - words) * 4 + j] ^ t[j];
        }
    }
    return w;
}

/**
 * A cipher of one key: each call takes and gives one 16-byte block.
 *
 * @param {Uint8Array} key  16, 24 or 32 bytes
 * @returns {{ encrypt: (block: Uint8Array) => Uint8Array,
 *     decrypt: (block: Uint8Array) => Uint8Array }}
 */
export function createAes(key){
    if (key.length !== 16 && key.length !== 24 && key.length !== 32)
    {
        throw new RangeError(`an AES key is 16, 24 or 32 bytes, not ${key.length}`);
    }
    const w = expandKey(key);
    const rounds = key.length / 4 + 6;
    /** @param {Uint8Array} s @param {number} round */
    const addRoundKey = (s, round)=>{
        for (let i = 0; i < 16; i++)
        {
            s[i] ^= w[round * 16 + i];
        }
    };
    // The state is column-major, as the input is laid into it (3.4): byte r + 4c.
    /** @param {Uint8Array} s @param {1 | -1} direction */
    const shiftRows = (s, direction)=>{
        const copy = s.slice();
        for (let r = 1; r < 4; r++)
        {
            for (let c = 0; c < 4; c++)
            {
                s[r + 4 * c] = copy[r + 4 * ((c + direction * r + 4) % 4)];
            }
        }
    };
    /** @param {Uint8Array} s @param {number[]} m */
    const mixColumns = (s, m)=>{
        for (let c = 0; c < 4; c++)
        {
            const a = s.slice(4 * c, 4 * c + 4);
            for (let r = 0; r < 4; r++)
            {
                s[4 * c + r] = multiply(m[0], a[r]) ^ multiply(m[1], a[(r + 1) % 4])
                    ^ multiply(m[2], a[(r + 2) % 4]) ^ multiply(m[3], a[(r + 3) % 4]);
            }
        }
    };
    return {
        encrypt: block=>{
            const s = block.slice(0, 16);
            addRoundKey(s, 0);
            for (let round = 1; round <= rounds; round++)
            {
                for (let i = 0; i < 16; i++)
                {
                    s[i] = SBOX[s[i]];
                }
                shiftRows(s, 1);
                if (round !== rounds)
                {
                    mixColumns(s, [2, 3, 1, 1]);
                }
                addRoundKey(s, round);
            }
            return s;
        },
        decrypt: block=>{
            const s = block.slice(0, 16);
            addRoundKey(s, rounds);
            for (let round = rounds - 1; round >= 0; round--)
            {
                shiftRows(s, -1);
                for (let i = 0; i < 16; i++)
                {
                    s[i] = INVERSE_SBOX[s[i]];
                }
                addRoundKey(s, round);
                if (round !== 0)
                {
                    mixColumns(s, [14, 11, 13, 9]);
                }
            }
            return s;
        },
    };
}

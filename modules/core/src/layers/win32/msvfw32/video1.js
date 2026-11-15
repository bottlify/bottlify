/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Microsoft Video 1 (FOURCC MSVC, also CRAM), msvidc32's format: the picture
 * in 4x4 blocks, the bottom row of blocks first, left to right, each block one
 * 16-bit code word and what it names:
 *
 * - 0x84xx-0x87xx: skip ((code - 0x8400)) blocks, which keep the previous frame;
 * - below 0x8000: two colours and a bit a pixel (a set bit the first colour),
 *   or, in 16 bits with the first colour's top bit set, eight colours, two for
 *   each 2x2 quarter;
 * - 8 bits, 0x9000 and up: eight colours, two a quarter;
 * - otherwise one colour for the whole block (8 bits: the low byte; 16 bits:
 *   the word itself).
 *
 * A pixel's bit is read from the low end up, its row from the block's bottom
 * row up, as the DIB lays rows out. Colours are palette indices in 8 bits and
 * RGB555 in 16.
 */

/** A pixel's bit in a block's flags: rows from the bottom, four bits a row. */
const bitOf = (/** @type {number} */ flags, /** @type {number} */ x, /** @type {number} */ y)=>
    flags >> (y * 4 + x) & 1;

/**
 * An eight-colour block: each 2x2 quarter its own pair, a set bit the pair's first.
 *
 * @param {number[]} colours @param {number} flags
 */
const eightColours = (colours, flags)=>(/** @type {number} */ x, /** @type {number} */ y)=>
    colours[((y & 2) << 1) + (x & 2) + (bitOf(flags, x, y) ^ 1)];

/**
 * Decodes one frame over the previous one: `pixels` holds one value a pixel
 * (an index, or an RGB555 word), bottom row first, `width` a row, and keeps
 * what a skipped block or a picture that ends early does not reach.
 *
 * @param {Uint8Array} data
 * @param {number} width @param {number} height  in pixels; the blocks cover
 *     the multiple of four below each
 * @param {8 | 16} depth
 * @param {Uint8Array | Uint16Array} pixels
 */
export function decodeVideo1(data, width, height, depth, pixels){
    const blocksWide = width >> 2;
    const blocksHigh = height >> 2;
    const total = blocksWide * blocksHigh;
    let at = 0;
    let skip = 0;
    const byte = ()=>data[at++] ?? 0;
    const word = ()=>{
        const value = (data[at] ?? 0) | (data[at + 1] ?? 0) << 8;
        at += 2;
        return value;
    };
    /** @param {number} block @param {(x: number, y: number) => number} colour */
    const fill = (block, colour)=>{
        const left = (block % blocksWide) * 4;
        const bottom = Math.floor(block / blocksWide) * 4;
        for (let y = 0; y < 4; y++)
        {
            for (let x = 0; x < 4; x++)
            {
                pixels[(bottom + y) * width + left + x] = colour(x, y);
            }
        }
    };
    for (let block = 0; block < total; block++)
    {
        if (skip > 0)
        {
            skip--;
            continue;
        }
        if (at + 1 >= data.length)
        {
            break;
        }
        const low = byte();
        const high = byte();
        const flags = high << 8 | low;
        if ((high & 0xfc) === 0x84)
        {
            skip = ((high - 0x84) << 8) + low - 1;
            continue;
        }
        if (depth === 8)
        {
            if (high < 0x80)
            {
                const colours = [byte(), byte()];
                fill(block, (x, y)=>colours[bitOf(flags, x, y) ^ 1]);
            }
            else if (high >= 0x90)
            {
                const colours = Array.from({ length: 8 }, byte);
                fill(block, eightColours(colours, flags));
            }
            else
            {
                fill(block, ()=>low);
            }
            continue;
        }
        if (high < 0x80)
        {
            const first = word();
            const second = word();
            if (first & 0x8000)
            {
                const colours = [first, second, ...Array.from({ length: 6 }, word)];
                fill(block, eightColours(colours, flags));
            }
            else
            {
                fill(block, (x, y)=>(bitOf(flags, x, y) === 1 ? first : second));
            }
        }
        else
        {
            fill(block, ()=>flags);
        }
    }
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The store's map of blocks to the regions holding them, as its record keeps
 * it: twelve bytes a block (its address, its region's entry, and both tops in
 * the third word), sorted by block, and read by binary search. Every process of
 * a run reads it as its runtime starts; held as a Map of `keyOf` numbers it
 * cost some 55 bytes a block (the keys past a small integer are heap numbers),
 * 66 MB in 3DMark06's engine thread for 1.2 million blocks, once more in every
 * process.
 */

import { keyOf } from './entries.js';

/** The words of a block's entry: its address, its region's entry, the tops. */
const WORDS = 3;

/** @param {Uint32Array} words @param {number} at  the entry's index */
const blockAt = (words, at)=>keyOf(words[at * WORDS], words[at * WORDS + 2] >>> 4);

export class StoredBlocks {
    /**
     * @param {Uint32Array} words  `WORDS` a block, sorted by `keyOf` of the block
     */
    constructor(words){
        this.words = words;
        this.size = words.length / WORDS;
    }

    /** The bytes of a block in the record. */
    static BYTES = WORDS * 4;

    /** None. */
    static empty(){
        return new StoredBlocks(new Uint32Array(0));
    }

    /**
     * The map as the store's record holds it. A record put before the map was
     * kept sorted is sorted here once; a record of a length no map has is none.
     *
     * @param {Uint8Array} bytes
     */
    static fromBytes(bytes){
        if (bytes.length % (WORDS * 4) !== 0)
        {
            return StoredBlocks.empty();
        }
        // A copy: the record's bytes need not be aligned, and they are its owner's.
        const words = new Uint32Array(bytes.length / 4);
        new Uint8Array(words.buffer).set(bytes);
        const blocks = new StoredBlocks(words);
        return blocks.sorted() ? blocks : blocks.sortedCopy();
    }

    /** @param {Map<number, number>} map  owner by block, both as `keyOf` packs them */
    static fromMap(map){
        const words = new Uint32Array(map.size * WORDS);
        let at = 0;
        for (const [block, owner] of map)
        {
            words[at] = Math.floor(block / 16);
            words[at + 1] = Math.floor(owner / 16);
            words[at + 2] = (block % 16) << 4 | owner % 16;
            at += WORDS;
        }
        return new StoredBlocks(words).sortedCopy();
    }

    /** Whether each block is past the one before it. */
    sorted(){
        for (let at = 1; at < this.size; at++)
        {
            if (blockAt(this.words, at - 1) >= blockAt(this.words, at))
            {
                return false;
            }
        }
        return true;
    }

    /** The same blocks sorted, the last of a block kept where it came twice. */
    sortedCopy(){
        const order = Array.from({ length: this.size }, (_, at)=>at);
        order.sort((a, b)=>blockAt(this.words, a) - blockAt(this.words, b) || a - b);
        const words = new Uint32Array(this.words.length);
        let kept = 0;
        for (const [index, at] of order.entries())
        {
            const next = order[index + 1];
            if (next !== undefined && blockAt(this.words, next) === blockAt(this.words, at))
            {
                continue;
            }
            words.set(this.words.subarray(at * WORDS, at * WORDS + WORDS), kept * WORDS);
            kept++;
        }
        return new StoredBlocks(words.slice(0, kept * WORDS));
    }

    /**
     * The region holding a block, as `keyOf` packs its entry, or undefined.
     *
     * @param {number} block  as `keyOf` packs it
     */
    get(block){
        let low = 0;
        let high = this.size - 1;
        while (low <= high)
        {
            const middle = (low + high) >>> 1;
            const here = blockAt(this.words, middle);
            if (here === block)
            {
                return keyOf(this.words[middle * WORDS + 1], this.words[middle * WORDS + 2] & 15);
            }
            if (here < block)
            {
                low = middle + 1;
            }
            else
            {
                high = middle - 1;
            }
        }
        return undefined;
    }

    /** The record's bytes. */
    bytes(){
        return new Uint8Array(this.words.buffer, this.words.byteOffset, this.words.byteLength);
    }
}

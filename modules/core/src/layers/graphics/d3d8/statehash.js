/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A map of states that keeps a hash of its whole contents as it changes.
 *
 * The renderer names a device's state by its render and stage states, some
 * hundreds of pairs, whenever any of them changes -- between most draws of a
 * program that toggles a state per model. Laid out and hashed in full, that
 * naming was the largest share of a draw's preparation. Kept here instead, the
 * hash moves by one pair's worth on each `set`, and the renderer reads it.
 *
 * The hash is a sum of each pair's mix, so it does not depend on the order
 * pairs were set in, and two sums of independent mixes make it 64 bits: two
 * different states share it with a chance far below anything a session sees.
 */

/** @param {number} hash @returns {number} */
const finish = hash=>{
    let h = hash;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h | 0;
};

/** @param {number} key @param {number} value */
const mixLow = (key, value)=>finish(Math.imul(key ^ 0x9e3779b9, 0x85ebca6b) ^ (value | 0));
/** @param {number} key @param {number} value */
const mixHigh = (key, value)=>finish(Math.imul(value | 0, 0xcc9e2d51)
    ^ Math.imul((key + 0x7f4a7c15) | 0, 0x1b873593));

/** @extends {Map<number, number>} */
export class HashedStates extends Map {
    /** The hash's two halves; set before any pair is, since nothing is passed to the constructor. */
    low = 0;
    high = 0;

    /** @param {number} key @param {number} value */
    set(key, value){
        if (super.has(key))
        {
            const old = /** @type {number} */ (super.get(key));
            this.low = ((this.low | 0) - mixLow(key, old)) | 0;
            this.high = ((this.high | 0) - mixHigh(key, old)) | 0;
        }
        super.set(key, value);
        this.low = ((this.low | 0) + mixLow(key, value)) | 0;
        this.high = ((this.high | 0) + mixHigh(key, value)) | 0;
        return this;
    }

    /** @param {number} key */
    delete(key){
        if (super.has(key))
        {
            const old = /** @type {number} */ (super.get(key));
            this.low = ((this.low | 0) - mixLow(key, old)) | 0;
            this.high = ((this.high | 0) - mixHigh(key, old)) | 0;
        }
        return super.delete(key);
    }

    clear(){
        super.clear();
        this.low = 0;
        this.high = 0;
    }
}

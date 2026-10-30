/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An LZMA decoder, written from the LZMA specification (Igor Pavlov,
 * lzma-specification.txt, placed in the public domain): a range coder over
 * adaptive bit probabilities, literals coded against the previous byte and
 * the match byte, and matches whose distances repeat through four slots.
 * It decodes a raw stream of known length, which is how Steam's "VZa"
 * chunks hold one: the five property bytes, then the stream, the size in the
 * footer.
 */

const PROB_BITS = 11;
const PROB_INIT = 1 << (PROB_BITS - 1);
const MOVE_BITS = 5;
const TOP = 1 << 24;

const STATES = 12;
const POS_BITS_MAX = 4;
const LEN_LOW_BITS = 3;
const LEN_MID_BITS = 3;
const LEN_HIGH_BITS = 8;
const MATCH_MIN = 2;
const END_POS_MODEL = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL >> 1);
const ALIGN_BITS = 4;
const DIST_STATES = 4;

/** @param {number} count */
const probs = count=>new Uint16Array(count).fill(PROB_INIT);

/** The range decoder over the compressed bytes. */
class RangeDecoder {
    /** @param {Uint8Array} input @param {number} at */
    constructor(input, at){
        this.input = input;
        this.at = at;
        if (input[this.at++] !== 0)
        {
            throw new Error('lzma: the stream does not begin with a zero byte');
        }
        this.range = 0xffffffff;
        this.code = 0;
        for (let i = 0; i < 4; i++)
        {
            this.code = ((this.code << 8) | this.input[this.at++]) >>> 0;
        }
        if (this.code === this.range)
        {
            throw new Error('lzma: a corrupt stream');
        }
    }

    normalize(){
        if (this.range < TOP)
        {
            this.range = (this.range << 8) >>> 0;
            this.code = ((this.code << 8) | this.input[this.at++]) >>> 0;
        }
    }

    /** @param {number} count  bits read with a probability of a half each */
    direct(count){
        let result = 0;
        for (let i = 0; i < count; i++)
        {
            this.range >>>= 1;
            this.code = (this.code - this.range) >>> 0;
            // All ones when code went below zero, which undoes the subtraction.
            const mask = 0 - (this.code >>> 31);
            this.code = (this.code + (this.range & mask)) >>> 0;
            result = ((result << 1) + (mask + 1)) >>> 0;
            this.normalize();
        }
        return result;
    }

    /** @param {Uint16Array} p @param {number} index */
    bit(p, index){
        const bound = (this.range >>> PROB_BITS) * p[index];
        let symbol;
        if (this.code < bound)
        {
            p[index] += ((1 << PROB_BITS) - p[index]) >>> MOVE_BITS;
            this.range = bound;
            symbol = 0;
        }
        else
        {
            p[index] -= p[index] >>> MOVE_BITS;
            this.code = (this.code - bound) >>> 0;
            this.range = (this.range - bound) >>> 0;
            symbol = 1;
        }
        this.normalize();
        return symbol;
    }

    /** @param {Uint16Array} p @param {number} base @param {number} bits */
    tree(p, base, bits){
        let m = 1;
        for (let i = 0; i < bits; i++)
        {
            m = (m << 1) + this.bit(p, base + m);
        }
        return m - (1 << bits);
    }

    /** @param {Uint16Array} p @param {number} base @param {number} bits */
    reverseTree(p, base, bits){
        let m = 1;
        let symbol = 0;
        for (let i = 0; i < bits; i++)
        {
            const bit = this.bit(p, base + m);
            m = (m << 1) + bit;
            symbol |= bit << i;
        }
        return symbol;
    }
}

class LengthDecoder {
    constructor(){
        this.choice = probs(2);
        this.low = probs(1 << (POS_BITS_MAX + LEN_LOW_BITS));
        this.mid = probs(1 << (POS_BITS_MAX + LEN_MID_BITS));
        this.high = probs(1 << LEN_HIGH_BITS);
    }

    /** @param {RangeDecoder} rc @param {number} posState */
    decode(rc, posState){
        if (rc.bit(this.choice, 0) === 0)
        {
            return rc.tree(this.low, posState << LEN_LOW_BITS, LEN_LOW_BITS);
        }
        if (rc.bit(this.choice, 1) === 0)
        {
            return (1 << LEN_LOW_BITS) + rc.tree(this.mid, posState << LEN_MID_BITS, LEN_MID_BITS);
        }
        return (1 << LEN_LOW_BITS) + (1 << LEN_MID_BITS) + rc.tree(this.high, 0, LEN_HIGH_BITS);
    }
}

/**
 * Decodes a raw LZMA stream.
 *
 * @param {Uint8Array} properties  Five bytes: lc/lp/pb, then the dictionary size.
 * @param {Uint8Array} input  The compressed stream.
 * @param {number} size  The bytes it decodes to.
 * @returns {Uint8Array}
 */
export function decodeLzma(properties, input, size){
    let d = properties[0];
    if (d >= 9 * 5 * 5)
    {
        throw new Error('lzma: bad properties');
    }
    const lc = d % 9;
    d = (d / 9) | 0;
    const lp = d % 5;
    const pb = (d / 5) | 0;

    const out = new Uint8Array(size);
    let pos = 0;
    const rc = new RangeDecoder(input, 0);

    const literals = probs(0x300 << (lc + lp));
    const posSlot = probs(DIST_STATES << 6);
    const posDecoders = probs(1 + FULL_DISTANCES - END_POS_MODEL);
    const align = probs(1 << ALIGN_BITS);
    const isMatch = probs(STATES << POS_BITS_MAX);
    const isRep = probs(STATES);
    const isRepG0 = probs(STATES);
    const isRepG1 = probs(STATES);
    const isRepG2 = probs(STATES);
    const isRep0Long = probs(STATES << POS_BITS_MAX);
    const lengths = new LengthDecoder();
    const repLengths = new LengthDecoder();

    const pbMask = (1 << pb) - 1;
    const lpMask = (1 << lp) - 1;
    let state = 0;
    let rep0 = 0;
    let rep1 = 0;
    let rep2 = 0;
    let rep3 = 0;

    /** @param {number} distance  one less than how far back */
    const byteBack = distance=>out[pos - distance - 1];

    const literal = ()=>{
        const previous = pos > 0 ? out[pos - 1] : 0;
        const base = 0x300 * (((pos & lpMask) << lc) + (previous >>> (8 - lc)));
        let symbol = 1;
        if (state >= 7)
        {
            let matchByte = byteBack(rep0);
            do {
                const matchBit = (matchByte >>> 7) & 1;
                matchByte <<= 1;
                const bit = rc.bit(literals, base + ((1 + matchBit) << 8) + symbol);
                symbol = (symbol << 1) | bit;
                if (matchBit !== bit)
                {
                    break;
                }
            } while (symbol < 0x100);
        }
        while (symbol < 0x100)
        {
            symbol = (symbol << 1) | rc.bit(literals, base + symbol);
        }
        out[pos++] = symbol & 0xff;
    };

    /** @param {number} length */
    const distance = length=>{
        const lenState = Math.min(length, DIST_STATES - 1);
        const slot = rc.tree(posSlot, lenState << 6, 6);
        if (slot < 4)
        {
            return slot;
        }
        const bits = (slot >>> 1) - 1;
        let dist = ((2 | (slot & 1)) << bits) >>> 0;
        if (slot < END_POS_MODEL)
        {
            dist += rc.reverseTree(posDecoders, dist - slot, bits);
        }
        else
        {
            dist += (rc.direct(bits - ALIGN_BITS) << ALIGN_BITS) >>> 0;
            dist += rc.reverseTree(align, 0, ALIGN_BITS);
        }
        return dist >>> 0;
    };

    while (pos < size)
    {
        const posState = pos & pbMask;
        if (rc.bit(isMatch, (state << POS_BITS_MAX) + posState) === 0)
        {
            literal();
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
            continue;
        }
        let length;
        if (rc.bit(isRep, state) !== 0)
        {
            if (pos === 0)
            {
                throw new Error('lzma: a repeated match before any byte');
            }
            if (rc.bit(isRepG0, state) === 0)
            {
                if (rc.bit(isRep0Long, (state << POS_BITS_MAX) + posState) === 0)
                {
                    state = state < 7 ? 9 : 11;
                    out[pos] = byteBack(rep0);
                    pos++;
                    continue;
                }
            }
            else
            {
                let dist;
                if (rc.bit(isRepG1, state) === 0)
                {
                    dist = rep1;
                }
                else
                {
                    if (rc.bit(isRepG2, state) === 0)
                    {
                        dist = rep2;
                    }
                    else
                    {
                        dist = rep3;
                        rep3 = rep2;
                    }
                    rep2 = rep1;
                }
                rep1 = rep0;
                rep0 = dist;
            }
            length = repLengths.decode(rc, posState);
            state = state < 7 ? 8 : 11;
        }
        else
        {
            rep3 = rep2;
            rep2 = rep1;
            rep1 = rep0;
            length = lengths.decode(rc, posState);
            state = state < 7 ? 7 : 10;
            rep0 = distance(length);
            if (rep0 === 0xffffffff)
            {
                // The end marker: a stream of known size may still carry one.
                break;
            }
            if (rep0 >= pos)
            {
                throw new Error('lzma: a match reaches before the start');
            }
        }
        length += MATCH_MIN;
        if (length > size - pos)
        {
            throw new Error('lzma: a match runs past the end');
        }
        for (let i = 0; i < length; i++, pos++)
        {
            out[pos] = out[pos - rep0 - 1];
        }
    }
    if (pos !== size)
    {
        throw new Error(`lzma: ${pos} bytes decoded of ${size}`);
    }
    return out;
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A set of a function's locals, by index, as bits. The region emitter keeps
 * one per block, call and way out of what the code wrote, read first and
 * wrote on every way (`Body.touch`, `planPaths`), and joins them along the
 * region's edges until nothing changes: as `Set`s of numbers that was a
 * fifth of the time translating took and much of what it left the collector,
 * where a word of bits joins thirty-two locals at once and a copy is a few
 * words.
 */
export class LocalSet {
    /** @param {Iterable<number>} [locals] */
    constructor(locals){
        /** @type {Uint32Array} */
        this.words = new Uint32Array(2);
        if (locals !== undefined)
        {
            for (const local of locals)
            {
                this.add(local);
            }
        }
    }

    /** @param {number} local */
    add(local){
        const word = local >>> 5;
        if (word >= this.words.length)
        {
            this.grow(word + 1);
        }
        this.words[word] |= 1 << (local & 31);
        return this;
    }

    /** @param {number} local */
    has(local){
        const word = local >>> 5;
        return word < this.words.length && (this.words[word] & 1 << (local & 31)) !== 0;
    }

    /**
     * Every local of another set added to this one.
     *
     * @param {LocalSet} other
     * @returns {boolean}  whether this set grew
     */
    addAll(other){
        const from = other.words;
        if (from.length > this.words.length)
        {
            this.grow(from.length);
        }
        const into = this.words;
        let grew = 0;
        for (let i = 0; i < from.length; i++)
        {
            const before = into[i];
            into[i] = before | from[i];
            grew |= into[i] ^ before;
        }
        return grew !== 0;
    }

    /**
     * Every local of another set not killed by `kill` added to this one.
     *
     * @param {LocalSet} other @param {LocalSet | undefined} kill
     * @returns {boolean}  whether this set grew
     */
    addAllBut(other, kill){
        if (kill === undefined)
        {
            return this.addAll(other);
        }
        const from = other.words;
        if (from.length > this.words.length)
        {
            this.grow(from.length);
        }
        const into = this.words;
        const killed = kill.words;
        let grew = 0;
        for (let i = 0; i < from.length; i++)
        {
            const before = into[i];
            into[i] = before | from[i] & ~(i < killed.length ? killed[i] : 0);
            grew |= into[i] ^ before;
        }
        return grew !== 0;
    }

    /** Only the locals another set holds too kept. @param {LocalSet} other */
    retainAll(other){
        const into = this.words;
        const from = other.words;
        for (let i = 0; i < into.length; i++)
        {
            into[i] &= i < from.length ? from[i] : 0;
        }
        return this;
    }

    copy(){
        const copy = new LocalSet();
        copy.words = this.words.slice();
        return copy;
    }

    /** The locals, lowest first. */
    *[Symbol.iterator](){
        const { words } = this;
        for (let i = 0; i < words.length; i++)
        {
            for (let bits = words[i]; bits !== 0; bits &= bits - 1)
            {
                yield i << 5 | 31 - Math.clz32(bits & -bits);
            }
        }
    }

    /** @param {number} length  in words */
    grow(length){
        const grown = new Uint32Array(Math.max(length, this.words.length * 2));
        grown.set(this.words);
        this.words = grown;
    }
}

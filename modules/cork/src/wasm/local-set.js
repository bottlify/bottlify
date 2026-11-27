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
 * words. The words are an array of 32-bit patterns (signed, as `|` leaves them),
 * not a typed array: a region makes thousands of sets, and a typed array is a view and
 * a buffer of its own besides its bytes, three times the array's size.
 */
export class LocalSet {
    /** @param {Iterable<number>} [locals] @param {number[]} [words]  taken as they are */
    constructor(locals, words = [0, 0]){
        /** @type {number[]} */
        this.words = words;
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
        return new LocalSet(undefined, this.words.slice());
    }

    /**
     * The least local of the set not below `from`, or -1: `for (let local = set.after(0);
     * local >= 0; local = set.after(local + 1))` goes through the set making nothing.
     *
     * @param {number} from
     */
    after(from){
        const { words } = this;
        for (let i = from >>> 5; i < words.length; i++)
        {
            const bits = i === from >>> 5 ? words[i] & -1 << (from & 31) : words[i];
            if (bits !== 0)
            {
                return i << 5 | 31 - Math.clz32(bits & -bits);
            }
        }
        return -1;
    }

    /** The locals, lowest first. @returns {Iterator<number>} */
    [Symbol.iterator](){
        return new Locals(this);
    }

    /** @param {number} length  in words */
    grow(length){
        const { words } = this;
        for (let i = words.length, to = Math.max(length, words.length * 2); i < to; i++)
        {
            words.push(0);
        }
    }
}

/**
 * The iterator of a set's locals: an object of its own and one result it answers every
 * step with, which a generator's step would make afresh.
 * @implements {Iterator<number>}
 */
class Locals {
    /** @param {LocalSet} set */
    constructor(set){
        this.set = set;
        /** The local the next step answers, or -1 once done. */
        this.local = set.after(0);
        /** @type {IteratorResult<number>} */
        this.result = { done: false, value: 0 };
    }

    /** @returns {IteratorResult<number>} */
    next(){
        const { local, result } = this;
        if (local < 0)
        {
            result.done = true;
            result.value = undefined;
            return result;
        }
        result.value = local;
        this.local = this.set.after(local + 1);
        return result;
    }
}

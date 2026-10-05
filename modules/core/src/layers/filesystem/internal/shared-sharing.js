/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The volume's sharing (`handles.js`'s `Sharing`) in shared memory, where
 * every thread a process of the run stands on settles its own opens.
 *
 * CreateFile's sharing is the system's: an open is settled against every
 * other process's. Kept on the system's thread, each open of a process in a
 * worker of its own is a call across a link and back, and the thread it asks
 * is woken from sleep for it -- tens to hundreds of microseconds a file, for a
 * check that takes a few. Here the table is one block of memory every thread
 * holds, and an open is settled under a lock held for that check: the same
 * terms, the same answer, on whichever thread asks.
 *
 * A slot holds one open: its token, its terms and its key. A key is compared
 * whole where it fits in a slot -- every path a program names short of the
 * longest Windows allows -- and past that by two hashes of it, the only place
 * two keys could be taken for one.
 */

import { ErrorCode, fsError } from './errors.js';

/** How many files the run may hold open at once, across every process. */
export const SLOTS = 2048;

/** UTF-16 units of a key kept whole; a longer one is kept by its hashes. */
const KEY_UNITS = 300;

const LOCK = 0;
const SEQUENCE = 1;
const HIGH = 2;
const HEADER = 4;

// A slot: its token (0: free), its terms, its key's length and hashes, its key.
const TOKEN = 0;
const TERMS = 1;
const LENGTH = 2;
const HASH_A = 3;
const HASH_B = 4;
const KEY = 5;
const SLOT_WORDS = KEY + KEY_UNITS / 2;

const READ = 1;
const WRITE = 2;
const SHARE_READ = 4;
const SHARE_WRITE = 8;

/** The memory of a run's sharing, handed to every thread that opens files. */
export function createSharingMemory(){
    return new SharedArrayBuffer((HEADER + SLOTS * SLOT_WORDS) * 4);
}

/** @param {string} key @param {number} seed */
const hashOf = (key, seed)=>{
    let hash = seed;
    for (let index = 0; index < key.length; index++)
    {
        hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
    }
    return hash | 0;
};

/** @param {import('./handles.js').OpenTerms} terms */
const bitsOf = terms=>(terms.access.read ? READ : 0) | (terms.access.write ? WRITE : 0)
    | (terms.share.read ? SHARE_READ : 0) | (terms.share.write ? SHARE_WRITE : 0);

/**
 * Whether one open refuses the other: either's access not shared by the
 * other, as `createSharing` settles it.
 *
 * @param {number} mine @param {number} theirs
 */
const refuses = (mine, theirs)=>((mine & READ) !== 0 && (theirs & SHARE_READ) === 0)
    || ((mine & WRITE) !== 0 && (theirs & SHARE_WRITE) === 0)
    || ((theirs & READ) !== 0 && (mine & SHARE_READ) === 0)
    || ((theirs & WRITE) !== 0 && (mine & SHARE_WRITE) === 0);

/**
 * The run's sharing over `memory`, from any thread.
 *
 * @param {SharedArrayBuffer} memory  from `createSharingMemory`
 * @returns {import('./handles.js').Sharing}
 */
export function openSharedSharing(memory){
    const words = new Int32Array(memory);
    /** Whether this thread may sleep for the lock: never the page's own. */
    const canBlock = typeof Atomics.wait === 'function'
        && typeof globalThis.window === 'undefined';

    // Held for a scan of the table and a write of one slot: a thread that
    // finds it held tries again, and sleeps only if the holder was put off
    // its processor in the middle.
    const lock = ()=>{
        for (let tries = 0; Atomics.compareExchange(words, LOCK, 0, 1) !== 0; tries++)
        {
            if (tries > 1000 && canBlock)
            {
                Atomics.wait(words, LOCK, 1, 1);
            }
        }
    };
    const unlock = ()=>{
        Atomics.store(words, LOCK, 0);
        Atomics.notify(words, LOCK, 1);
    };

    /** @param {string} key */
    const shapeOf = key=>({ key, length: key.length, a: hashOf(key, 0x811c9dc5 | 0),
        b: hashOf(key, 0x2545f491) });

    /**
     * Whether the slot at `at` holds the key: whole, or by its hashes past
     * what a slot holds.
     *
     * @param {number} at @param {ReturnType<typeof shapeOf>} shape
     */
    const holds = (at, shape)=>{
        if (words[at + LENGTH] !== shape.length || words[at + HASH_A] !== shape.a
            || words[at + HASH_B] !== shape.b)
        {
            return false;
        }
        if (shape.length > KEY_UNITS)
        {
            return true;
        }
        for (let index = 0; index < shape.length; index += 2)
        {
            const pair = words[at + KEY + (index >> 1)];
            if ((pair & 0xffff) !== shape.key.charCodeAt(index)
                || (index + 1 < shape.length && (pair >>> 16) !== shape.key.charCodeAt(index + 1)))
            {
                return false;
            }
        }
        return true;
    };

    /** @param {number} slot */
    const startOf = slot=>HEADER + slot * SLOT_WORDS;

    return {
        admit(terms){
            const shape = shapeOf(terms.key);
            const mine = bitsOf(terms);
            lock();
            try
            {
                const high = words[HIGH];
                let free = -1;
                for (let slot = 0; slot < high; slot++)
                {
                    const at = startOf(slot);
                    if (words[at + TOKEN] === 0)
                    {
                        free = free === -1 ? slot : free;
                        continue;
                    }
                    if (!terms.inherited && holds(at, shape) && refuses(mine, words[at + TERMS]))
                    {
                        throw fsError(ErrorCode.SHARING_VIOLATION,
                            `"${terms.path}" is already open on incompatible terms`);
                    }
                }
                if (free === -1)
                {
                    if (high >= SLOTS)
                    {
                        throw fsError(ErrorCode.ACCESS_DENIED, 'Too many files open in the run');
                    }
                    free = high;
                    words[HIGH] = high + 1;
                }
                // A token names its slot, and which of the slot's opens it was:
                // a token released twice frees nothing the second time.
                const sequence = (words[SEQUENCE] + 1) & 0x7ffff;
                words[SEQUENCE] = sequence;
                const token = (sequence * SLOTS + free) + 1;
                const at = startOf(free);
                words[at + TERMS] = mine;
                words[at + LENGTH] = shape.length;
                words[at + HASH_A] = shape.a;
                words[at + HASH_B] = shape.b;
                if (shape.length <= KEY_UNITS)
                {
                    for (let index = 0; index < shape.length; index += 2)
                    {
                        const next = index + 1 < shape.length ? shape.key.charCodeAt(index + 1) : 0;
                        words[at + KEY + (index >> 1)] = shape.key.charCodeAt(index) | (next << 16);
                    }
                }
                words[at + TOKEN] = token;
                return token;
            }
            finally
            {
                unlock();
            }
        },
        release(token){
            const slot = (token - 1) % SLOTS;
            if (!(token > 0) || slot < 0)
            {
                return;
            }
            lock();
            try
            {
                const at = startOf(slot);
                if (words[at + TOKEN] === token)
                {
                    words[at + TOKEN] = 0;
                }
            }
            finally
            {
                unlock();
            }
        },
        isOpen(key){
            const shape = shapeOf(key);
            lock();
            try
            {
                const high = words[HIGH];
                for (let slot = 0; slot < high; slot++)
                {
                    const at = startOf(slot);
                    if (words[at + TOKEN] !== 0 && holds(at, shape))
                    {
                        return true;
                    }
                }
                return false;
            }
            finally
            {
                unlock();
            }
        },
    };
}

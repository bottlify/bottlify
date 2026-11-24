/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's index as every thread sees it: three pieces of shared memory
 * the keeper writes and every thread reads without asking anyone.
 *
 * - `records`: one record a name, at a fixed place for the run (its id), in a
 *   growable buffer every thread's view follows as it grows. A record says
 *   where the name's body is -- a segment and an offset while hot, a pack and
 *   an offset on the disk -- and, in one word, its state and how many threads
 *   read the body now. One word so that a reader coming in and the keeper
 *   taking the body away are decided by one compare-and-swap: the keeper takes
 *   only a body no one reads, a reader enters only a body still hot.
 * - `names`: each record's name, in UTF-16 units, appended and never moved.
 * - `table`: name -> record, open addressing over the record's ids. The keeper
 *   builds a larger one when this one fills and sends it out; a thread still
 *   on the old one finds every name the old one held and misses the newer
 *   ones, which a cache may.
 *
 * A record's fields other than the state word change only while its state
 * says no reader can be inside (writing, moving, cold), and the state is
 * stored after them: whoever enters a hot record reads its place as the keeper
 * wrote it.
 */

/** The records' header, in 32-bit words. */
export const HEADER_WORDS = 16;
/** Records in use. */
export const H_COUNT = 0;
/** The keeper's clock, in ms since the store opened: a reader's use is stamped with it. */
export const H_TICK = 1;
/** Units of `names` in use. */
export const H_NAMES = 2;

/** One record, in 32-bit words. */
export const RECORD_WORDS = 12;
export const R_HASH_A = 0;
export const R_HASH_B = 1;
/** State in the top 8 bits, readers inside in the 24 below. */
export const R_STATE = 2;
export const R_SEGMENT = 3;
export const R_OFFSET = 4;
export const R_LENGTH = 5;
/** `H_TICK` at the last use. */
export const R_TICK = 6;
export const R_NAME = 7;
export const R_NAME_LENGTH = 8;
/** The pack holding the body on the disk, -1 for none. */
export const R_PACK = 9;
export const R_PACK_OFFSET = 10;
export const R_FLAGS = 11;

/** The body has no other source: it may go to the disk, never away. */
export const F_ONLY_COPY = 1;
/** The disk's copy is the body's: going cold writes nothing. */
export const F_ON_DISK = 2;
/** Asked away while read: the keeper takes it once the readers are out. */
export const F_DROP = 4;

/** No body: never had one, or dropped. */
export const GONE = 0;
/** Being written by the thread that reserved it. */
export const WRITING = 1;
/** In a segment. */
export const HOT = 2;
/** On the disk only. */
export const COLD = 3;
/** The keeper is taking it out of its segment. */
export const MOVING = 4;

const READERS = 0xffffff;

/** @param {number} word */
export const stateOf = word=>word >>> 24;
/** @param {number} word */
export const readersOf = word=>word & READERS;
/** @param {number} state @param {number} [readers] */
export const stateWord = (state, readers = 0)=>((state << 24) | readers) | 0;

/**
 * Two 32-bit lanes of FNV-1a over the name's UTF-16 units, each from its own
 * basis: the table probes by the first, a record is matched by both and then
 * by its name.
 *
 * @param {string} name
 * @returns {[number, number]}
 */
export function hashName(name){
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    for (let i = 0; i < name.length; i++)
    {
        const unit = name.charCodeAt(i);
        a = Math.imul(a ^ unit, 0x01000193);
        b = Math.imul(b ^ (unit + i), 0x01000193);
    }
    return [a | 0, b | 0];
}

/**
 * A shared buffer that grows in place, every thread's views following it
 * (ES2024; the project's type library is older).
 *
 * @typedef {SharedArrayBuffer & { grow: (bytes: number) => void, maxByteLength: number }} Growable
 */

/**
 * @param {number} bytes @param {number} most
 * @returns {Growable}
 */
export const growableShared = (bytes, most)=>/** @type {Growable} */ (
    new /** @type {any} */ (SharedArrayBuffer)(bytes, { maxByteLength: most }));

/**
 * @typedef {Object} SharedIndex
 * @property {Growable} records
 * @property {Growable} names
 * @property {SharedArrayBuffer} table
 */

/**
 * A thread's views over the index.
 *
 * @param {SharedIndex} shared
 */
export function viewIndex(shared){
    // Without a length the views follow their growable buffers.
    const words = new Int32Array(shared.records);
    const names = new Uint16Array(shared.names);
    let table = new Int32Array(shared.table);
    let tableBuffer = shared.table;

    /** @param {number} id */
    const at = id=>HEADER_WORDS + id * RECORD_WORDS;

    /**
     * The record holding `name`, or -1.
     *
     * @param {string} name @param {[number, number]} [hash]
     */
    const find = (name, hash = hashName(name))=>{
        const mask = table.length - 1;
        for (let slot = hash[0] & mask, probes = 0; probes <= mask;
            slot = (slot + 1) & mask, probes++)
        {
            const entry = Atomics.load(table, slot);
            if (entry === 0)
            {
                return -1;
            }
            const base = at(entry - 1);
            if (words[base + R_HASH_A] === hash[0] && words[base + R_HASH_B] === hash[1]
                && words[base + R_NAME_LENGTH] === name.length
                && sameName(words[base + R_NAME], name))
            {
                return entry - 1;
            }
        }
        return -1;
    };
    /** @param {number} from @param {string} name */
    const sameName = (from, name)=>{
        for (let i = 0; i < name.length; i++)
        {
            if (names[from + i] !== name.charCodeAt(i))
            {
                return false;
            }
        }
        return true;
    };

    return {
        words,
        names,
        at,
        find,
        /** @param {SharedArrayBuffer} buffer */
        adoptTable(buffer){
            if (buffer.byteLength > tableBuffer.byteLength)
            {
                tableBuffer = buffer;
                table = new Int32Array(buffer);
            }
        },
        table: ()=>table,
        /**
         * Enters a hot record to read its body: true where it is hot and now
         * counts this reader, false where it is not hot.
         *
         * @param {number} id
         */
        enter(id){
            const index = at(id) + R_STATE;
            for (;;)
            {
                const word = Atomics.load(words, index);
                if (stateOf(word) !== HOT || readersOf(word) === READERS)
                {
                    return false;
                }
                if (Atomics.compareExchange(words, index, word, word + 1) === word)
                {
                    return true;
                }
            }
        },
        /** @param {number} id */
        leave(id){
            Atomics.sub(words, at(id) + R_STATE, 1);
        },
        /** @param {number} id */
        state: id=>stateOf(Atomics.load(words, at(id) + R_STATE)),
        /** @param {number} id */
        stamp(id){
            words[at(id) + R_TICK] = Atomics.load(words, H_TICK);
        },
    };
}

/** @typedef {ReturnType<typeof viewIndex>} IndexView */

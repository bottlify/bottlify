/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Records from one thread to another through shared memory, and a word the
 * reader sleeps on until there is something to read.
 *
 * A thread that runs a program cannot stop to take a message: a message is
 * delivered only when the thread returns to its event loop, and the point of
 * running the program in a worker of its own is that it never has to. What it
 * is sent -- input, a file's bytes, an answer -- is written here instead and
 * read between two guest turns, and when it has nothing to run it waits on
 * the ring's doorbell rather than on the event loop.
 *
 * One writer and one reader. Nothing written is lost: a record that does not
 * fit is refused, and the writer either tries again or waits for the reader
 * to make room. Records are bytes of any length up to `maxRecord`, each one
 * whole in the buffer -- one that would run past the end is put at the start,
 * behind a marker that says so -- so the reader is handed a view, not a copy.
 *
 * The indices are counts of bytes ever written and ever read, not positions:
 * the difference is what the ring holds, and an empty ring cannot be mistaken
 * for a full one. They wrap at 2^32, which the arithmetic here does too.
 *
 * The doorbell can be the ring's own or a word shared with other rings, so a
 * thread with several inbound rings sleeps on one word and is woken by any.
 * It is rung after the record is published, and a reader that read it before
 * looking compares that value when it waits: a record written between its
 * look and its wait makes the wait return at once, and no wake-up is lost.
 */

/** Words of the control block. */
const WRITTEN = 0;
const READ = 1;
/** Rung by the reader when it frees room: what a full ring's writer waits on. */
const ROOM = 2;
/** The ring's own doorbell, where it is not given one. */
const BELL = 3;
const CONTROL_WORDS = 4;

/** A record's length word that means "the rest of the buffer is unused; go to the start". */
const WRAP = 0xffffffff;

/** Every record's length word and its bytes are kept aligned to this. */
const ALIGN = 4;

/** @param {number} n */
const aligned = n=>(n + ALIGN - 1) & ~(ALIGN - 1);

/**
 * @typedef {Object} RingMemory
 * @property {SharedArrayBuffer} control
 * @property {SharedArrayBuffer} data
 * @property {{ buffer: SharedArrayBuffer, index: number } | null} bell
 *     a doorbell word kept elsewhere, shared with other rings; null for the ring's own
 */

/**
 * The memory of a new ring, to be opened on both sides.
 *
 * @param {number} capacity  bytes, rounded up to a power of two of at least 64
 * @param {{ buffer: SharedArrayBuffer, index: number } | null} [bell]
 * @returns {RingMemory}
 */
export function createRingMemory(capacity, bell = null){
    let size = 64;
    while (size < capacity)
    {
        size *= 2;
    }
    if (size > 1 << 30)
    {
        throw new Error('ring: a ring holds at most 1 GiB');
    }
    return { control: new SharedArrayBuffer(CONTROL_WORDS * 4), data: new SharedArrayBuffer(size),
        bell };
}

/**
 * A doorbell several rings can share: one word, which `createRingMemory`
 * takes as `{ buffer, index }`.
 *
 * @returns {{ buffer: SharedArrayBuffer, index: number }}
 */
export function createDoorbell(){
    return { buffer: new SharedArrayBuffer(4), index: 0 };
}

/**
 * Waits on a doorbell until it is no longer `seen`, or for `timeoutMs`.
 * Only where the thread may block: a worker, never a page's window.
 *
 * @param {{ buffer: SharedArrayBuffer, index: number }} bell
 * @param {number} seen  what `ringOf(bell)` said before the reader last looked
 * @param {number} [timeoutMs]
 * @returns {'ok' | 'not-equal' | 'timed-out'}
 */
export function waitDoorbell(bell, seen, timeoutMs = Infinity){
    return Atomics.wait(new Int32Array(bell.buffer), bell.index, seen, timeoutMs);
}

/**
 * The doorbell's count now: read before looking at the rings it serves, and
 * handed to `waitDoorbell` after finding them empty.
 *
 * @param {{ buffer: SharedArrayBuffer, index: number }} bell
 */
export function doorbellOf(bell){
    return Atomics.load(new Int32Array(bell.buffer), bell.index);
}

/**
 * One side of a ring. Either side may be opened from the same memory in any
 * thread; each method belongs to one of them, as its comment says.
 *
 * @param {RingMemory} memory
 */
export function openRing(memory){
    const control = new Int32Array(memory.control);
    const bytes = new Uint8Array(memory.data);
    const words = new DataView(memory.data);
    const capacity = bytes.length;
    const mask = capacity - 1;
    const bell = memory.bell ?? { buffer: memory.control, index: BELL };
    const bellWords = new Int32Array(bell.buffer);
    /** The longest record: one that fits however the ring is positioned. */
    const maxRecord = capacity / 2 - ALIGN;

    /** @param {number} index */
    const load = index=>Atomics.load(control, index) >>> 0;

    return {
        capacity,
        maxRecord,
        bell,

        /**
         * The writer's: puts one record in, and rings the doorbell. False,
         * and nothing written, when there is not room for it now.
         *
         * @param {Uint8Array} record
         * @returns {boolean}
         */
        write(record){
            const length = record.length;
            if (length > maxRecord)
            {
                throw new Error(`ring: a record of ${length} bytes is longer than ${maxRecord}`);
            }
            const written = load(WRITTEN);
            const free = capacity - ((written - load(READ)) >>> 0);
            const at = written & mask;
            const need = ALIGN + aligned(length);
            // What runs past the end is put at the start, and the tail it
            // skips is spent: a record is always whole, so it is read in place.
            const tail = capacity - at;
            const skip = tail < need ? tail : 0;
            if (skip + need > free)
            {
                return false;
            }
            if (skip > 0)
            {
                words.setUint32(at, WRAP, true);
            }
            const start = (at + skip) & mask;
            words.setUint32(start, length, true);
            bytes.set(record, start + ALIGN);
            // The record is published by the index, and the index by the store
            // being atomic: a reader that sees the new count sees the bytes.
            Atomics.store(control, WRITTEN, (written + skip + need) | 0);
            Atomics.add(bellWords, bell.index, 1);
            Atomics.notify(bellWords, bell.index);
            return true;
        },

        /**
         * The writer's, where it may block: puts one record in, waiting up to
         * `timeoutMs` in all for the reader to make room.
         *
         * @param {Uint8Array} record
         * @param {number} [timeoutMs]
         * @returns {boolean} whether it was written
         */
        writeWaiting(record, timeoutMs = Infinity){
            const until = Date.now() + timeoutMs;
            for (;;)
            {
                const room = Atomics.load(control, ROOM);
                if (this.write(record))
                {
                    return true;
                }
                const left = until - Date.now();
                if (left <= 0)
                {
                    return false;
                }
                Atomics.wait(control, ROOM, room, left);
            }
        },

        /**
         * The reader's: the next record, as a view into the ring that stays
         * valid until `release` -- or null when there is none.
         *
         * @returns {Uint8Array | null}
         */
        peek(){
            let read = load(READ);
            const written = load(WRITTEN);
            if (read === written)
            {
                return null;
            }
            let at = read & mask;
            let length = words.getUint32(at, true);
            if (length === WRAP)
            {
                read = (read + (capacity - at)) >>> 0;
                Atomics.store(control, READ, read | 0);
                at = 0;
                length = words.getUint32(0, true);
            }
            return bytes.subarray(at + ALIGN, at + ALIGN + length);
        },

        /**
         * The reader's: gives the record `peek` returned back to the writer.
         */
        release(){
            const read = load(READ);
            const at = read & mask;
            const length = words.getUint32(at, true);
            Atomics.store(control, READ, (read + ALIGN + aligned(length)) | 0);
            Atomics.add(control, ROOM, 1);
            Atomics.notify(control, ROOM);
        },

        /**
         * The reader's: every record there is now, each handed to `take`
         * before the next is read. Returns how many.
         *
         * @param {(record: Uint8Array) => void} take
         */
        drain(take){
            let count = 0;
            for (let record = this.peek(); record !== null; record = this.peek())
            {
                take(record);
                this.release();
                count++;
            }
            return count;
        },

        /** Bytes held, records and their framing: for diagnostics. */
        held: ()=>(load(WRITTEN) - load(READ)) >>> 0,
    };
}

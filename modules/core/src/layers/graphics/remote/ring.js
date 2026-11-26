/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics worker's transport: a root's calls go to the worker through a
 * Cellar ring (`vendor/cellar`) and what the played side says comes back
 * through another, every record read where it lies.
 *
 * A record is a head -- what it is (`KIND`), a number it carries, the time it
 * was sent at on the clock both threads read -- and a body at a multiple of
 * eight of the ring's memory: a batch of calls as `wire.js` writes them, a
 * value the played side says, a mark, or a part of a batch or a value too
 * long for one record.
 *
 * The writing side builds a batch where it will be read: its writer asks for
 * the most room the ring has (`place`), up to half the ring, and what it wrote
 * there is published as it lies. A batch that outgrows that room, or finds
 * none, goes on in the writer's own buffer and is copied in; one longer than
 * a record goes as parts, one after another. Neither side ever waits for room:
 * the engine's thread runs the program, and a call the program waits for
 * parks the program's thread, not this one; the worker plays every root's
 * calls. What does not fit now waits on its side, in order, every record
 * after it behind it, and goes as the reader makes room.
 *
 * The reading side takes each record as it comes and gives it back once it
 * is done with it: at once for a batch played, or -- for one whose bytes an
 * answer still to come views -- when that answer has settled, reading nothing
 * after it meanwhile (`resume`): a ring frees only from its head, and batches
 * are played in the order they were sent.
 */

import { RingClosed, openRing } from '../../../../vendor/cellar/cellar.js';
import { createWriter } from './wire.js';

export { createRingMemory } from '../../../../vendor/cellar/cellar.js';

/** What a record is. */
export const KIND = Object.freeze({
    /** a batch of calls (`wire.js`) */
    BATCH: 1,
    /** a part of a batch or a value too long for a record; its number the whole's length */
    PART: 2,
    /** a mark the writing side placed among its batches; its number says which */
    MARK: 3,
    /** a value the played side says (`createWriter`'s `value`) */
    VALUE: 4,
});

/**
 * The bytes of a root's ring of calls: a batch builds in place in up to half
 * of it (Cellar's `maxRecord`), so 2 MiB holds the batches of a frame -- tens
 * of kilobytes each, two or three a frame in a steady run -- and one of up to
 * 1 MiB, the largest buffer a writer keeps to write on (`SPARE_LARGEST`,
 * `wire.js`). A longer one, a texture's upload, goes as parts.
 */
export const CALLS_BYTES = 2 << 20;

/** The bytes of a root's ring back: answers, presents and diagnostics, a few a frame. */
export const REPLIES_BYTES = 256 << 10;

/** A record's head: its kind (and a part's whole's kind above it), its number, its time. */
const HEAD = 16;
/** The head and the most the body's alignment to eight may take. */
const SLACK = HEAD + 4;
/** The least room a writer asks for in place; a batch that finds no more goes on in its own buffer. */
const LEAST_ROOM = 4 << 10;

/**
 * Where the body of the record whose room the ring gave at `room` begins.
 *
 * @param {number} room
 */
const bodyAt = room=>((room + 7) & ~7) + HEAD;

/**
 * @typedef {{ kind: number, number: number, at: number, bytes: Uint8Array | null,
 *     own: boolean, sent: number }} Waiting
 *     a record that found no room: its bytes, `sent` of them already gone as
 *     parts; `own` when they are the writer's buffer, given back once sent
 */

/**
 * The writing side of a ring.
 *
 * @param {import('../../../../vendor/cellar/cellar.js').RingMemory} memory
 * @param {{ intern?: boolean }} [options]  as `createWriter`'s
 */
export function openRingOut(memory, { intern = true } = {}){
    const ring = openRing(memory);
    const data = /** @type {SharedArrayBuffer} */ (ring.bytes.buffer);
    const words = new DataView(data);
    /** The longest body one record holds. */
    const longest = (ring.maxRecord - SLACK) & ~7;
    /** Records that found no room, oldest first. @type {Waiting[]} */
    const waiting = [];
    /** Whether a wait for room is out: what it wakes to writes the next record. */
    let waking = false;
    /** Where the room the writer builds in begins, while it holds some. */
    let room = -1;
    let closed = false;
    /**
     * Records published, batches built in place and published where they
     * lay, the bytes copied in from the writer's own buffer (`copiedIn`), the parts long
     * records went as, and the records that waited for room.
     */
    const figures = { records: 0, inPlace: 0, copiedIn: 0, parts: 0, waited: 0 };

    /** @param {unknown} e */
    const ended = e=>{
        if (!(e instanceof RingClosed))
        {
            throw e;
        }
        closed = true;
        waiting.length = 0;
    };

    /** @param {number} least @returns {Uint8Array | null} */
    const place = least=>{
        if (closed || waiting.length > 0)
        {
            return null;
        }
        try
        {
            // The most room there is: a ring the reader keeps up with is
            // nearly empty, and one behind still has some.
            for (let length = ring.maxRecord; length >= least + SLACK && length >= LEAST_ROOM;
                length = (length >>> 1) & ~3)
            {
                const at = ring.reserve(length);
                if (at >= 0)
                {
                    room = at;
                    const body = bodyAt(at);
                    return new Uint8Array(data, body, at + length - body);
                }
            }
        }
        catch (e){
            ended(e);
        }
        return null;
    };
    const writer = createWriter({ place, unplaced: ()=>{
        ring.abandon();
        room = -1;
    }, intern });

    /**
     * Writes the head of the record whose room begins at `at`, then publishes
     * it with `length` bytes of body.
     *
     * @param {number} at @param {number} kind @param {number} number @param {number} time
     * @param {number} length
     */
    const commit = (at, kind, number, time, length)=>{
        const head = bodyAt(at) - HEAD;
        words.setUint32(head, kind, true);
        words.setUint32(head + 4, number, true);
        words.setFloat64(head + 8, time, true);
        ring.commit(bodyAt(at) - at + length);
        figures.records++;
    };

    /**
     * The next record of a waiting one: all of it, or its next part.
     *
     * @param {Waiting} item
     */
    const next = item=>{
        const total = item.bytes?.length ?? 0;
        const whole = total <= longest;
        const length = whole ? total : Math.min(longest, total - item.sent);
        return { length, kind: whole ? item.kind : KIND.PART | (item.kind << 8),
            number: whole ? item.number : total };
    };
    /**
     * Writes the next record of `item` into the room at `at`; true when that
     * was its last.
     *
     * @param {Waiting} item @param {number} at
     */
    const fill = (item, at)=>{
        const { length, kind, number } = next(item);
        if (item.bytes && length > 0)
        {
            ring.bytes.set(item.bytes.subarray(item.sent, item.sent + length), bodyAt(at));
            figures.copiedIn += length;
        }
        commit(at, kind, number, item.at, length);
        if (kind !== item.kind)
        {
            figures.parts++;
        }
        item.sent += length;
        return item.sent >= (item.bytes?.length ?? 0);
    };
    /** Writes what waits, in order, as far as there is room; then waits for more. */
    const flushWaiting = ()=>{
        if (waking)
        {
            return;
        }
        try
        {
            while (waiting.length > 0)
            {
                const item = waiting[0];
                const at = ring.reserve(next(item).length + SLACK);
                if (at < 0)
                {
                    wait();
                    return;
                }
                if (fill(item, at))
                {
                    done(/** @type {Waiting} */ (waiting.shift()));
                }
            }
        }
        catch (e){
            ended(e);
        }
    };
    /** @param {Waiting} item */
    const done = item=>{
        if (item.own && item.bytes)
        {
            writer.reuse(/** @type {ArrayBuffer} */ (item.bytes.buffer));
        }
    };
    /** Waits, on the event loop, for room for the next record of the oldest waiting. */
    const wait = ()=>{
        waking = true;
        figures.waited++;
        ring.reserveWaitingAsync(next(waiting[0]).length + SLACK).then(at=>{
            waking = false;
            if (closed || waiting.length === 0)
            {
                ring.abandon();
                return;
            }
            try
            {
                if (fill(waiting[0], at))
                {
                    done(/** @type {Waiting} */ (waiting.shift()));
                }
            }
            catch (e){
                ended(e);
            }
            flushWaiting();
        }, e=>{
            waking = false;
            ended(e);
        });
    };
    /** @param {Waiting} item */
    const send = item=>{
        if (closed)
        {
            done(item);
            return;
        }
        waiting.push(item);
        flushWaiting();
    };

    return {
        /** The writer a batch or a value is written with, in place where there is room. */
        writer,

        /**
         * Publishes what the writer holds as one record of `kind`, sent at
         * `time`: where it was built, or copied in, now or once there is
         * room. Answers its bytes; nothing written, nothing sent.
         *
         * @param {number} kind @param {number} time
         * @returns {number}
         */
        publish(kind, time){
            if (writer.empty())
            {
                return 0;
            }
            const length = writer.size();
            if (writer.placed())
            {
                const at = room;
                room = -1;
                writer.published();
                if (closed)
                {
                    return length;
                }
                try
                {
                    commit(at, kind, 0, time, length);
                    figures.inPlace++;
                }
                catch (e){
                    ended(e);
                }
                return length;
            }
            const { buffer } = writer.give();
            send({ kind, number: 0, at: time, bytes: new Uint8Array(buffer, 0, length), own: true,
                sent: 0 });
            return length;
        },

        /**
         * Puts `bytes` in as one record of `kind`, sent at `time`, copied in
         * now or once there is room: they stay as they are until then. The
         * writer must hold nothing unpublished. For records made elsewhere --
         * a capture's, played again.
         *
         * @param {number} kind @param {Uint8Array} bytes @param {number} time
         */
        put(kind, bytes, time){
            if (!writer.empty())
            {
                throw new Error('remote: a record put in the middle of a batch');
            }
            send({ kind, number: 0, at: time, bytes, own: false, sent: 0 });
        },

        /**
         * A mark among the records, after every one published so far: what
         * the reader is told in order with them (`KIND.MARK`). The writer
         * must hold nothing unpublished.
         *
         * @param {number} number
         */
        mark(number){
            if (!writer.empty())
            {
                throw new Error('remote: a mark in the middle of a batch');
            }
            send({ kind: KIND.MARK, number, at: 0, bytes: null, own: false, sent: 0 });
        },

        /** Records waiting for room now. */
        waiting: ()=>waiting.length,

        /** What `figures` above counts, as it stands, and the records waiting for room now. */
        figures: ()=>({ ...figures, waiting: waiting.length }),

        /** Whether either side closed the ring. */
        closed: ()=>closed || ring.closed(),

        /** Ends the ring for both sides; what waited goes nowhere. */
        close(){
            closed = true;
            waiting.length = 0;
            ring.abandon();
            room = -1;
            ring.close();
        },
    };
}

/**
 * The reading side of a ring.
 *
 * `take` is handed each record: its kind, the buffer and place it lies at,
 * its length, its number and when it was sent; a part's whole once the last
 * of its parts is in, as the whole's own kind, in a buffer of its own. It
 * answers false to keep the record past its call -- what it views of it
 * stays as it is -- and then `resume` gives it back; nothing after it is
 * taken meanwhile.
 *
 * @param {import('../../../../vendor/cellar/cellar.js').RingMemory} memory
 * @param {(kind: number, buffer: ArrayBufferLike, start: number, length: number,
 *     number: number, time: number) => boolean | void} take
 */
export function openRingIn(memory, take){
    const ring = openRing(memory);
    const data = /** @type {SharedArrayBuffer} */ (ring.bytes.buffer);
    const words = new DataView(data);
    /** Whether a record taken is kept past its call, and whether it is in the ring. */
    let held = false;
    let heldInRing = false;
    /** A long record's parts so far. @type {ArrayBuffer | null} */
    let whole = null;
    let wholeAt = 0;
    /** What the serving loop waits on while a record is held. @type {(() => void) | null} */
    let resumed = null;
    let serving = false;

    /**
     * Takes every record there is, until one is held: how many.
     *
     * @returns {number}
     */
    const drain = ()=>{
        let count = 0;
        while (!held)
        {
            const record = ring.peek();
            if (!record)
            {
                break;
            }
            count++;
            const body = bodyAt(record.byteOffset);
            const head = body - HEAD;
            const kind = words.getUint32(head, true);
            const number = words.getUint32(head + 4, true);
            const time = words.getFloat64(head + 8, true);
            const length = record.byteOffset + record.length - body;
            if ((kind & 0xff) === KIND.PART)
            {
                whole ??= new ArrayBuffer(number);
                new Uint8Array(whole, wholeAt, length).set(new Uint8Array(data, body, length));
                wholeAt += length;
                ring.release();
                if (wholeAt < whole.byteLength)
                {
                    continue;
                }
                const read = whole;
                whole = null;
                wholeAt = 0;
                if (take(kind >>> 8, read, 0, read.byteLength, 0, time) === false)
                {
                    held = true;
                }
                continue;
            }
            if (take(kind, data, body, length, number, time) === false)
            {
                held = true;
                heldInRing = true;
                break;
            }
            ring.release();
        }
        return count;
    };

    return {
        drain,

        /** Gives back the record `take` kept, and goes on reading. */
        resume(){
            if (!held)
            {
                return;
            }
            held = false;
            if (heldInRing)
            {
                heldInRing = false;
                ring.release();
            }
            if (resumed)
            {
                const wake = resumed;
                resumed = null;
                wake();
            }
            else if (!serving)
            {
                drain();
            }
        },

        /**
         * Takes the records as they come, on the event loop, until the ring
         * is closed and every record written before is taken.
         *
         * @returns {Promise<void>}
         */
        async serve(){
            serving = true;
            for (;;)
            {
                if (held)
                {
                    await new Promise(resolve=>{
                        resumed = ()=>resolve(undefined);
                    });
                    continue;
                }
                const seen = ring.bell.seen();
                drain();
                if (held)
                {
                    continue;
                }
                // Records written before the close are still read.
                if (ring.closed())
                {
                    drain();
                    if (held)
                    {
                        continue;
                    }
                    break;
                }
                await ring.bell.waitAsync(seen);
            }
            serving = false;
        },

        /** Whether a record is kept past its taking, or written and not taken yet. */
        unread: ()=>held || ring.held() > 0,

        /** Whether either side closed the ring. */
        closed: ()=>ring.closed(),

        /** Ends the ring for both sides. */
        close: ()=>ring.close(),
    };
}

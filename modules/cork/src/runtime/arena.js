/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translation cache arena: the functions a process's translation emitted,
 * kept as bytes in shared memory, so every translation worker working for
 * the process takes what any of them emitted, and a worker that leaves takes
 * nothing with it (roadmap/v2, stage 2). A worker's own heap cannot be shared
 * or handed on; a `SharedArrayBuffer` can.
 *
 * Layout: a header of words, an index of slots, and the data, cut into
 * segments written in turn. A new entry is written at the current segment's
 * end; when it does not fit, the next segment -- the oldest -- is taken over
 * whole, its generation moves on, and every slot that named it is stale from
 * then on. A hit in the older half is written again at the end, so what is
 * used stays and what is not ages out: the order a least-recently-used cache
 * keeps, at the cost of a copy now and then.
 *
 * Every read and write holds one lock, a word taken by compare-and-exchange:
 * a lookup copies its entry out under it and decodes after, so a reader never
 * sees an entry half written or a segment being taken over. What it guards is
 * short -- an index probe and a copy of a few kilobytes -- against the
 * milliseconds an emission takes, so the lock spins rather than sleeps, and
 * the engine thread of a page, which may not sleep, takes it too.
 *
 * An entry: five words -- its whole length, the key's bytes, the shape's
 * numbers, the body's bytes, the rest's bytes -- then the key (UTF-8), the
 * shape (float64, aligned), the function's body, and the rest as JSON (its type,
 * locals and hints, and what the emitter answered for the region).
 */

/** The header's words. */
const Header = /** @type {const} */ ({
    LOCK: 0,
    CURRENT: 1,      // the segment written now
    USED: 2,         // bytes of it written
    SEGMENTS: 3,
    SEGMENT_BYTES: 4,
    SLOTS: 5,
    HITS: 6,         // lookups that found their function, every worker's
    LOOKUPS: 7,
    WRITES: 8,
    REFRESHED: 9,    // hits copied forward out of the older half
    WORDS: 16,       // the segments' generations follow
});
/** A slot: the key's hash (never 0), the entry's offset + 1 (0: empty), its segment's
 * generation when written. */
const SLOT_WORDS = 3;
const ENTRY_WORDS = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @typedef {Object} KeptFunction  What a hit hands the emitter.
 * @property {number} typeIndex
 * @property {number[]} locals
 * @property {Uint8Array} body
 * @property {number[]} hints
 * @property {any} region  what the emitter answered for the region
 */

/**
 * A fresh arena.
 *
 * @param {number} [bytes]  of functions kept, the oldest segment going first
 * @param {{ segments?: number, slots?: number }} [shape]
 * @returns {SharedArrayBuffer}
 */
export function createArena(bytes = 48 << 20, { segments = 8, slots = 1 << 14 } = {}){
    const segmentBytes = Math.floor(bytes / segments / 8) * 8;
    const headerBytes = (Header.WORDS + segments) * 4;
    const indexBytes = slots * SLOT_WORDS * 4;
    const dataAt = Math.ceil((headerBytes + indexBytes) / 8) * 8;
    const buffer = new SharedArrayBuffer(dataAt + segmentBytes * segments);
    const words = new Int32Array(buffer, 0, Header.WORDS);
    words[Header.SEGMENTS] = segments;
    words[Header.SEGMENT_BYTES] = segmentBytes;
    words[Header.SLOTS] = slots;
    return buffer;
}

/** FNV-1a over the key's UTF-16 units: the slot a key starts its probe at. */
function hashOf(/** @type {string} */ key){
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++)
    {
        hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
    }
    // Never 0, which marks nothing; an int32, as the index holds it.
    return hash | 1;
}

/**
 * The arena seen from one thread.
 *
 * @param {SharedArrayBuffer} buffer
 */
export function openArena(buffer){
    const head = new Int32Array(buffer, 0, Header.WORDS);
    const segments = head[Header.SEGMENTS];
    const segmentBytes = head[Header.SEGMENT_BYTES];
    const slotCount = head[Header.SLOTS];
    const gens = new Int32Array(buffer, Header.WORDS * 4, segments);
    const indexAt = (Header.WORDS + segments) * 4;
    const index = new Int32Array(buffer, indexAt, slotCount * SLOT_WORDS);
    const dataAt = Math.ceil((indexAt + slotCount * SLOT_WORDS * 4) / 8) * 8;
    const data = new Uint8Array(buffer, dataAt, segmentBytes * segments);
    const view = new DataView(buffer, dataAt, segmentBytes * segments);

    const lock = ()=>{
        while (Atomics.compareExchange(head, Header.LOCK, 0, 1) !== 0)
        {
            // Spun: what the lock guards is a probe and a copy.
        }
    };
    const unlock = ()=>{
        Atomics.store(head, Header.LOCK, 0);
    };
    /** The live entry's slot for the key, or -1; with the lock held. */
    const find = (/** @type {string} */ key, /** @type {number} */ hash)=>{
        for (let probe = 0; probe < slotCount; probe++)
        {
            const slot = ((hash >>> 0) + probe) % slotCount * SLOT_WORDS;
            const at = index[slot + 1] - 1;
            if (at < 0)
            {
                return -1;
            }
            if (index[slot] === hash && gens[Math.floor(at / segmentBytes)] === index[slot + 2]
                && keyAt(at) === key)
            {
                return slot;
            }
        }
        return -1;
    };
    const keyAt = (/** @type {number} */ at)=>{
        const length = view.getUint32(at + 4, true);
        return decoder.decode(data.slice(at + ENTRY_WORDS * 4, at + ENTRY_WORDS * 4 + length));
    };
    /** A free or stale slot along the key's probe; with the lock held. */
    const freeSlot = (/** @type {number} */ hash)=>{
        for (let probe = 0; probe < slotCount; probe++)
        {
            const slot = ((hash >>> 0) + probe) % slotCount * SLOT_WORDS;
            const at = index[slot + 1] - 1;
            if (at < 0 || gens[Math.floor(at / segmentBytes)] !== index[slot + 2])
            {
                return slot;
            }
        }
        return -1;
    };
    /**
     * Copies an entry's bytes to the end of the current segment, taking the
     * next one over when they do not fit; with the lock held.
     * @param {Uint8Array} bytes @returns {number} where, or -1 when larger than a segment
     */
    const append = bytes=>{
        if (bytes.length > segmentBytes)
        {
            return -1;
        }
        let current = head[Header.CURRENT];
        let used = head[Header.USED];
        if (used + bytes.length > segmentBytes)
        {
            current = (current + 1) % segments;
            gens[current] = (gens[current] + 1) | 0;
            used = 0;
            head[Header.CURRENT] = current;
        }
        const at = current * segmentBytes + used;
        data.set(bytes, at);
        head[Header.USED] = used + ((bytes.length + 7) & ~7);
        return at;
    };
    /** @param {number} slot @param {number} hash @param {number} at */
    const place = (slot, hash, at)=>{
        index[slot] = hash;
        index[slot + 1] = at + 1;
        index[slot + 2] = gens[Math.floor(at / segmentBytes)];
    };
    /** Whether the segment holding `at` is in the older half: next to be taken over. */
    const ageing = (/** @type {number} */ at)=>{
        const age = (head[Header.CURRENT] - Math.floor(at / segmentBytes) + segments) % segments;
        return age >= segments >> 1;
    };

    return {
        buffer,
        /**
         * The function kept under the key, if its shape is the one asked for.
         * @param {string} key @param {number[]} shape
         * @returns {KeptFunction | undefined}
         */
        get(key, shape){
            const hash = hashOf(key);
            /** @type {Uint8Array | null} */
            let bytes = null;
            lock();
            try
            {
                head[Header.LOOKUPS]++;
                const slot = find(key, hash);
                if (slot >= 0)
                {
                    const at = index[slot + 1] - 1;
                    bytes = data.slice(at, at + view.getUint32(at, true));
                    if (ageing(at))
                    {
                        const moved = append(bytes);
                        if (moved >= 0)
                        {
                            place(slot, hash, moved);
                            head[Header.REFRESHED]++;
                        }
                    }
                }
            }
            finally
            {
                unlock();
            }
            if (bytes === null)
            {
                return undefined;
            }
            const entry = decodeEntry(bytes);
            if (!sameShape(entry.shape, shape))
            {
                return undefined;
            }
            Atomics.add(head, Header.HITS, 1);
            return entry.kept;
        },
        /**
         * Keeps a function under the key, unless one is kept there already --
         * a second worker that emitted it at the same time.
         * @param {string} key @param {number[]} shape @param {KeptFunction} kept
         */
        set(key, shape, kept){
            const bytes = encodeEntry(key, shape, kept);
            const hash = hashOf(key);
            lock();
            try
            {
                if (find(key, hash) >= 0)
                {
                    return;
                }
                const slot = freeSlot(hash);
                if (slot < 0)
                {
                    return;
                }
                const at = append(bytes);
                if (at >= 0)
                {
                    place(slot, hash, at);
                    head[Header.WRITES]++;
                }
            }
            finally
            {
                unlock();
            }
        },
        /** Every worker's counts, as the diagnostics name them. */
        counts(){
            return {
                hits: Atomics.load(head, Header.HITS),
                lookups: Atomics.load(head, Header.LOOKUPS),
                writes: Atomics.load(head, Header.WRITES),
                refreshed: Atomics.load(head, Header.REFRESHED),
                bytes: segments * segmentBytes,
            };
        },
    };
}

/**
 * @param {string} key @param {number[]} shape @param {KeptFunction} kept
 * @returns {Uint8Array}
 */
function encodeEntry(key, shape, { typeIndex, locals, body, hints, region }){
    const keyBytes = encoder.encode(key);
    const rest = encoder.encode(JSON.stringify([typeIndex, locals, hints, region]));
    const shapeAt = (ENTRY_WORDS * 4 + keyBytes.length + 7) & ~7;
    const bodyAt = shapeAt + shape.length * 8;
    const restAt = bodyAt + body.length;
    const bytes = new Uint8Array(restAt + rest.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length, true);
    view.setUint32(4, keyBytes.length, true);
    view.setUint32(8, shape.length, true);
    view.setUint32(12, body.length, true);
    view.setUint32(16, rest.length, true);
    bytes.set(keyBytes, ENTRY_WORDS * 4);
    new Float64Array(bytes.buffer, shapeAt, shape.length).set(shape);
    bytes.set(body, bodyAt);
    bytes.set(rest, restAt);
    return bytes;
}

/**
 * @param {Uint8Array} bytes  an entry copied out of the arena (its own buffer, aligned)
 * @returns {{ shape: Float64Array, kept: KeptFunction }}
 */
function decodeEntry(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const keyLength = view.getUint32(4, true);
    const shapeCount = view.getUint32(8, true);
    const bodyLength = view.getUint32(12, true);
    const restLength = view.getUint32(16, true);
    const shapeAt = (ENTRY_WORDS * 4 + keyLength + 7) & ~7;
    const bodyAt = shapeAt + shapeCount * 8;
    const restAt = bodyAt + bodyLength;
    const shape = new Float64Array(bytes.buffer, bytes.byteOffset + shapeAt, shapeCount);
    const [typeIndex, locals, hints, region] = JSON.parse(
        decoder.decode(bytes.subarray(restAt, restAt + restLength)));
    return { shape, kept: { typeIndex, locals, body: bytes.slice(bodyAt, restAt), hints, region } };
}

/** @param {Float64Array} kept @param {number[]} shape */
function sameShape(kept, shape){
    if (kept.length !== shape.length)
    {
        return false;
    }
    for (let i = 0; i < shape.length; i++)
    {
        if (kept[i] !== shape[i])
        {
            return false;
        }
    }
    return true;
}

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The texels a device keeps past the call that made them - a level no draw
 * has needed yet, an upload that waits for its frame's replay - as bodies of
 * the run's cache under the device's own names (`texels/<n>/`, the owner's
 * channel, `cache/module.js` `channelSpace`), not as arrays of the drawing
 * thread's heap: one budget, one eviction, and the page file on the disk
 * where they go idle. Every device that keeps texels keeps them here.
 *
 * A body is handed over (`put`) and is the store's from then on: readable at
 * once, in place (`with`), or taken back as the caller's own (`take`), until
 * it is dropped. Where it lies is the store's to say: in plain memory while
 * the cache has not granted its room (room is asked for without waiting), when
 * it refused, for a body smaller than the cache's unit of room, and always
 * where there is no cache under the store (a test, a device on a thread
 * without one) - the same contract, the bytes in this heap. Each body is the
 * only copy of what it holds for this run (a level's texels as the program
 * made them, an upload's as they stood when it was recorded), which is why
 * the owner's names go to the disk when idle (`disk: 'run'`) and never away;
 * what a device can make again from guest memory at once (an upload that goes
 * to the GPU in the same call) is never kept here.
 *
 * A body the cache cannot give back is a loss: said once a body
 * (`divergence(detail, 'loss')`), counted, and read as zeros of its length,
 * so the level draws blank instead of the device stopping.
 */

/**
 * Bytes of a body below which it stays in plain memory: the cache's unit of
 * room. A body there holds at least a unit while it is hot (4 KiB, Cellar's
 * buddy block), and its name and record cost about 0.6 KB here and 90 bytes
 * of the cache's index: a smaller body would hold more of the cache than it
 * lets go of here. A mip chain's levels are each a quarter of the one above,
 * so its one level from a unit up to four holds three quarters of the bytes
 * of its levels under four units.
 */
export const KEPT_FROM = 4 * 1024;

/**
 * What a store keeps its bodies in: an owner's names in the run's cache
 * (`channelSpace`), room asked for ahead without waiting (`ask`), a body
 * written into granted room (`put`), granted room let go of unwritten
 * (`forgo`).
 *
 * @typedef {{ space: import('../../cache/module.js').CacheSpace,
 *     ask: (key: string, length: number) => Promise<boolean>,
 *     put: (key: string, bytes: Uint8Array) => boolean,
 *     forgo: (key: string, length: number) => void }} TexelCache
 */

/**
 * One body: its bytes while they are in plain memory, null once they are in
 * the cache under `name`; `name` null while none was asked for.
 *
 * @typedef {{ bytes: Uint8Array | null, length: number, name: string | null }} Body
 */

/**
 * @typedef {ReturnType<typeof createTexelStore>} TexelStore
 */

/**
 * @param {{ cache?: TexelCache | null,
 *     divergence?: ((detail: string, severity: 'loss') => void) | null,
 *     from?: number }} [options]
 *     `cache`: the owner's names, none for plain memory; `divergence`: where a
 *     loss is said; `from`: the bytes below which a body stays in plain memory
 */
export function createTexelStore({ cache = null, divergence = null, from = KEPT_FROM } = {}){
    /** @type {Map<string, Body>} */
    const bodies = new Map();
    /** The cache's names, one a body put: a key put again while its room is asked is another. */
    let names = 0;
    const counts = {
        put: 0, putBytes: 0,
        moved: 0, movedBytes: 0,
        refused: 0, forgone: 0,
        taken: 0, takenBytes: 0,
        lost: 0,
        plainBytes: 0, cachedBytes: 0,
    };

    /** @param {Body} body */
    const letGo = body=>{
        if (body.bytes !== null)
        {
            counts.plainBytes -= body.length;
        }
        else if (body.name !== null)
        {
            counts.cachedBytes -= body.length;
            cache?.space.drop(body.name);
        }
    };

    /**
     * Room for a body, asked for without waiting: the body moves into it once
     * granted, unless it was dropped or taken meanwhile, when the room is let
     * go of unwritten.
     *
     * @param {string} key @param {Body} body @param {TexelCache} into
     */
    const move = (key, body, into)=>{
        const name = String(++names);
        body.name = name;
        into.ask(name, body.length).then(granted=>{
            if (bodies.get(key) !== body)
            {
                if (granted)
                {
                    into.forgo(name, body.length);
                }
                counts.forgone++;
                return;
            }
            // Still held under its key, a body has not moved: its bytes are here.
            if (!granted || !into.put(name, /** @type {Uint8Array} */ (body.bytes)))
            {
                body.name = null;
                counts.refused++;
                return;
            }
            body.bytes = null;
            counts.plainBytes -= body.length;
            counts.cachedBytes += body.length;
            counts.moved++;
            counts.movedBytes += body.length;
        }, ()=>{
            if (bodies.get(key) === body)
            {
                body.name = null;
            }
            counts.refused++;
        });
    };

    /**
     * A body's bytes read in place inside `read`; zeros of its length where
     * the cache lost them, and the loss said. Undefined for a key not held.
     *
     * @template T
     * @param {string} key @param {Body} body @param {(bytes: Uint8Array) => T} read
     * @returns {T}
     */
    const readBody = (key, body, read)=>{
        if (body.bytes !== null)
        {
            return read(body.bytes);
        }
        let found = false;
        /** @type {T | undefined} */
        const value = cache?.space.with(/** @type {string} */ (body.name), bytes=>{
            found = true;
            return read(bytes);
        }, { wait: true });
        if (found)
        {
            return /** @type {T} */ (value);
        }
        counts.lost++;
        counts.cachedBytes -= body.length;
        bodies.delete(key);
        divergence?.(`texels kept in the run's cache (${body.length} bytes) could not be read`
            + ' back: they read as zeros', 'loss');
        return read(new Uint8Array(body.length));
    };

    return {
        /** Whether bodies go into the run's cache: without one, a move is no move. */
        cached: cache !== null,

        /**
         * Hands `bytes` over under `key`, replacing what it held: the caller
         * writes them no more.
         *
         * @param {string} key @param {Uint8Array} bytes
         */
        put(key, bytes){
            const held = bodies.get(key);
            if (held)
            {
                letGo(held);
            }
            /** @type {Body} */
            const body = { bytes, length: bytes.byteLength, name: null };
            bodies.set(key, body);
            counts.put++;
            counts.putBytes += body.length;
            counts.plainBytes += body.length;
            if (cache !== null && body.length >= from)
            {
                move(key, body, cache);
            }
        },

        /**
         * `key`'s bytes read in place inside `read`, never kept past it;
         * undefined for a key not held.
         *
         * @template T
         * @param {string} key @param {(bytes: Uint8Array) => T} read
         * @returns {T | undefined}
         */
        with(key, read){
            const body = bodies.get(key);
            return body ? readBody(key, body, read) : undefined;
        },

        /**
         * `key`'s bytes back as the caller's own, the key let go of: the bytes
         * themselves where they are in plain memory, one copy out where they
         * are in the cache, whose memory is not the caller's to keep or write.
         * Null for a key not held.
         *
         * @param {string} key @returns {Uint8Array | null}
         */
        take(key){
            const body = bodies.get(key);
            if (!body)
            {
                return null;
            }
            const plain = body.bytes;
            const bytes = plain ?? readBody(key, body, read=>read.slice());
            if (bodies.get(key) === body)
            {
                letGo(body);
                bodies.delete(key);
            }
            counts.taken++;
            counts.takenBytes += plain === null ? body.length : 0;
            return bytes;
        },

        /** @param {string} key */
        drop(key){
            const body = bodies.get(key);
            if (body)
            {
                letGo(body);
                bodies.delete(key);
            }
        },

        /** @param {string} key */
        has: key=>bodies.has(key),

        /** @param {string} key @returns {number} its bytes, 0 for a key not held */
        lengthOf: key=>bodies.get(key)?.length ?? 0,

        /**
         * What the store holds and has done: bodies and their bytes in plain
         * memory and in the cache; those put, moved into the cache, refused
         * room, whose room was let go of because they went first (`forgone`),
         * taken back (`takenBytes` copied out of the cache) and lost.
         */
        figures: ()=>({ bodies: bodies.size, cache: cache !== null, ...counts }),
    };
}

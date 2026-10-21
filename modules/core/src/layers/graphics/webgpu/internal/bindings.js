/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Bind groups, their cache, and the per-draw uniform pool.
 *
 * Three separate failures live here, and they look nothing alike:
 *
 * - A cache that outlives the pass it was filled in rebinds groups the new pass
 *   never received, and the draws quietly do not appear -- with no validation
 *   error. So a cache is created per pass and thrown away with it; this module
 *   has no long-lived one to reset by mistake.
 * - An automatic bind-group layout drops a binding the generated shader did not
 *   use, the group then fails validation, and every textured draw disappears.
 *   A layout is a required argument here, and `'auto'` is refused by name.
 * - One uniform buffer rewritten between draws in a pass shows every draw the
 *   *last* write: the queue applies the writes before the encoded commands run.
 *   The draws render, with the wrong values, which is why this one survives so
 *   long. Each block therefore gets its own buffer, and the cache key includes
 *   buffer identity so a stale group cannot rebind the wrong one.
 */

/** @type {WeakMap<object, number>} */
const identities = new WeakMap();
let nextIdentity = 1;

/**
 * A stable per-object number, so a cache key can name a GPU object without
 * holding it alive or relying on how it prints.
 *
 * @param {object} resource
 * @returns {number}
 */
export function resourceId(resource){
    let id = identities.get(resource);
    if (id === undefined)
    {
        id = nextIdentity++;
        identities.set(resource, id);
    }
    return id;
}

/**
 * The dynamic offsets a group's buffer bindings are bound at, in binding
 * order, or nothing when no binding carries one.
 *
 * @param {any[]} entries
 * @param {number[]} [into]
 *     Where the offsets go, its length set to their count: a caller that hands
 *     them on at once -- setBindGroup copies them -- need not have an array made
 *     for every draw. A fresh one when not given.
 * @returns {number[] | undefined}
 */
export function dynamicOffsetsOf(entries, into){
    // Every draw binds through here: one pass when the entries already come
    // in binding order, as a renderer lays them out.
    let count = 0;
    let last = -Infinity;
    for (let i = 0; i < entries.length; i++)
    {
        const entry = entries[i];
        const resource = entry.resource;
        if (!resource || typeof resource !== 'object' || !resource.buffer
            || resource.dynamicOffset === undefined)
        {
            continue;
        }
        if (entry.binding < last)
        {
            const sorted = entries
                .filter(one=>one.resource && typeof one.resource === 'object'
                    && one.resource.buffer && one.resource.dynamicOffset !== undefined)
                .sort((left, right)=>left.binding - right.binding)
                .map(one=>one.resource.dynamicOffset);
            if (into === undefined)
            {
                return sorted;
            }
            into.length = 0;
            into.push(...sorted);
            return into;
        }
        last = entry.binding;
        if (count === 0 && into === undefined)
        {
            into = [];
        }
        /** @type {number[]} */ (into)[count++] = resource.dynamicOffset;
    }
    if (count === 0)
    {
        return undefined;
    }
    const offsets = /** @type {number[]} */ (into);
    offsets.length = count;
    return offsets;
}

/**
 * A bind-group cache with the lifetime of one render pass.
 *
 * @param {{ device: import('../contract.js').GpuDeviceLike }} options
 * @returns {any}
 */
export function createBindingCache(options){
    /** @type {Map<number, any>} */
    const groups = new Map();
    let created = 0;
    let reused = 0;
    /**
     * The groups' keys as words -- the layout, then each entry's binding and
     * what it binds -- numbered by an FNV-1a hash of them, a hit compared in
     * full: a key is asked for on every draw, and a string for it was most of
     * what a draw left on the heap.
     *
     * @type {Map<number, { words: Int32Array, key: number }[]>}
     */
    const keys = new Map();
    let nextKey = 0;
    let words = new Int32Array(64);

    /** @param {any} layout @param {any[]} entries @returns {number} */
    const keyOf = (layout, entries)=>{
        const needed = 1 + entries.length * 5;
        if (needed > words.length)
        {
            words = new Int32Array(Math.max(needed, words.length * 2));
        }
        let at = 0;
        words[at++] = resourceId(layout);
        for (let i = 0; i < entries.length; i++)
        {
            const resource = entries[i].resource;
            words[at++] = entries[i].binding;
            if (resource && typeof resource === 'object' && resource.buffer)
            {
                // The dynamic offset is not part of the group: it is given at
                // bind time, which is what lets one group serve every draw.
                words[at++] = 1;
                words[at++] = resourceId(resource.buffer);
                words[at++] = resource.offset === undefined ? 0 : resource.offset;
                words[at++] = resource.size === undefined ? -1 : resource.size;
            }
            else
            {
                words[at++] = 0;
                words[at++] = resourceId(resource);
            }
        }
        let hash = 0x811c9dc5;
        for (let i = 0; i < at; i++)
        {
            hash = Math.imul(hash ^ words[i], 0x01000193);
        }
        const bucket = keys.get(hash);
        if (bucket !== undefined)
        {
            for (let i = 0; i < bucket.length; i++)
            {
                if (sameWords(bucket[i].words, words, at))
                {
                    return bucket[i].key;
                }
            }
        }
        const entry = { words: words.slice(0, at), key: nextKey++ };
        if (bucket !== undefined)
        {
            bucket.push(entry);
        }
        else
        {
            keys.set(hash, [entry]);
        }
        return entry.key;
    };

    return {
        /**
         * @param {any} layout an explicit bind-group layout, never 'auto'
         * @param {any[]} entries
         * @param {string} [label]
         */
        get(layout, entries, label){
            if (!layout || typeof layout !== 'object')
            {
                throw new Error('A bind group needs an explicit layout object');
            }
            const key = keyOf(layout, entries);
            const cached = groups.get(key);
            if (cached)
            {
                reused++;
                return cached;
            }
            // The entries are the caller's, and may be written over for its
            // next draw, a buffer binding's too: the group is made from a copy
            // of them as they are.
            const group = options.device.createBindGroup({
                label,
                layout,
                entries: entries.map(entry=>({
                    binding: entry.binding,
                    resource: entry.resource && typeof entry.resource === 'object'
                        && entry.resource.buffer ? { ...entry.resource } : entry.resource,
                })),
            });
            groups.set(key, group);
            created++;
            return group;
        },

        stats(){
            return { created, reused };
        },

        /** Groups built so far: a number, read around every draw's `get`. */
        created: ()=>created,
    };
}

/**
 * @param {Int32Array} stored @param {Int32Array} words @param {number} count
 * @returns {boolean}
 */
function sameWords(stored, words, count){
    if (stored.length !== count)
    {
        return false;
    }
    for (let i = 0; i < count; i++)
    {
        if (stored[i] !== words[i])
        {
            return false;
        }
    }
    return true;
}

/** Uniform buffer offsets and sizes are quantised to this in WebGPU. */
export const UNIFORM_ALIGNMENT = 256;

/**
 * Hands out uniform blocks from one ring buffer, each at its own offset.
 *
 * A block is bound with a dynamic offset, so the bind group that names the
 * ring names nothing that changes per draw: one group serves every draw that
 * samples the same texture through the same sampler, frame after frame.
 *
 * The blocks are laid into a copy of the ring on this side and reach the GPU
 * in one write per frame, at `flush` before the frame's submit, rather than a
 * write per block: a frame of shader draws hands out several blocks a draw,
 * and each write is a trip to the GPU process. The queue orders those writes
 * after the submits before them, so a wrap overwrites only blocks whose frames
 * have finished; what was laid before a wrap or a new ring is written first.
 * That holds only while one frame's blocks fit the ring: the writes of a frame
 * all land before its own submit, so a frame that wrapped onto its own first
 * blocks would draw them with its last ones. A frame that would is handed a
 * ring twice the size instead, and the draws it has already bound keep theirs.
 *
 * @param {Object} options
 * @param {import('../contract.js').GpuDeviceLike} options.device
 * @param {import('../contract.js').GpuQueueLike} options.queue
 * @param {number} [options.capacity]  Bytes in the ring.
 * @param {number} [options.usage]
 * @returns {any}
 */
export function createUniformPool(options){
    let capacity = options.capacity === undefined ? 1 << 22 : options.capacity;
    let cursor = 0;
    let created = 0;
    let reused = 0;
    let writes = 0;
    /** @type {any} */
    let ring = null;
    /** @type {Uint8Array} */
    let staging = new Uint8Array(0);
    /**
     * The same bytes as floats, which a block of floats is copied through.
     *
     * @type {Float32Array}
     */
    let stagingFloats = new Float32Array(0);
    /** The laid bytes not yet written: [pendingFrom, pendingTo). */
    let pendingFrom = 0;
    let pendingTo = 0;
    /** Ring bytes the frame being recorded has used, a wrap's skipped tail included. */
    let frameUsed = 0;
    /**
     * The last blocks laid and where, by the frame and ring they were laid
     * in (`laying`): the same block handed again in that frame -- a stage's
     * integer and boolean registers, kept while they hold still -- binds the
     * slot it already has, with nothing copied or written again.
     */
    const RECENT = 8;
    const recentBlocks = /** @type {(ArrayBufferView | null)[]} */ (new Array(RECENT).fill(null));
    const recentAt = new Int32Array(RECENT);
    const recentLaying = new Int32Array(RECENT);
    let recentNext = 0;
    /** Raised at each frame's end and each new ring: a slot kept from before is not reused. */
    let laying = 1;
    let shared = 0;

    const flush = ()=>{
        if (ring && pendingTo > pendingFrom)
        {
            options.queue.writeBuffer(ring, pendingFrom, staging, pendingFrom,
                pendingTo - pendingFrom);
            writes++;
        }
        pendingFrom = cursor;
        pendingTo = cursor;
    };

    const make = ()=>{
        flush();
        laying++;
        ring = options.device.createBuffer({
            label: `uniforms#${created}`,
            size: capacity,
            usage: options.usage,
        });
        staging = new Uint8Array(capacity);
        stagingFloats = new Float32Array(staging.buffer);
        created++;
        cursor = 0;
        pendingFrom = 0;
        pendingTo = 0;
    };

    /**
     * The binding of a block laid at `at`: the slot covers one block at offset
     * zero, and the offset the draw reads from travels beside it, for
     * setBindGroup.
     *
     * @param {ArrayBufferView} block @param {number} at
     * @param {{ buffer: any, offset: number, size: number, dynamicOffset: number }} [into]
     */
    const slotOf = (block, at, into)=>{
        if (into)
        {
            into.buffer = ring;
            into.offset = 0;
            into.size = block.byteLength;
            into.dynamicOffset = at;
            return into;
        }
        return { buffer: ring, offset: 0, size: block.byteLength, dynamicOffset: at };
    };

    return {
        /**
         * @param {ArrayBufferView} block
         * @param {{ buffer: any, offset: number, size: number, dynamicOffset: number }} [into]
         *     Where the slot is written, rather than an object made for it: a
         *     caller that binds it at once and keeps nothing.
         * @returns {{ buffer: any, offset: number, size: number, dynamicOffset: number }}
         */
        allocate(block, into){
            for (let index = 0; index < RECENT; index++)
            {
                if (recentBlocks[index] === block && recentLaying[index] === laying)
                {
                    shared++;
                    return slotOf(block, recentAt[index], into);
                }
            }
            const needed = Math.ceil(block.byteLength / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT;
            const tail = cursor + needed > capacity ? capacity - cursor : 0;
            if (needed > capacity || (ring && frameUsed + tail + needed > capacity))
            {
                capacity = Math.max(capacity * 2, needed);
                make();
                frameUsed = 0;
            }
            if (!ring)
            {
                make();
            }
            else if (cursor + needed > capacity)
            {
                flush();
                frameUsed += capacity - cursor;
                cursor = 0;
                pendingFrom = 0;
                pendingTo = 0;
            }
            const at = cursor;
            cursor += needed;
            frameUsed += needed;
            reused++;
            // A block of floats is copied as floats -- the same type, which
            // copies bits -- rather than through a byte view made for it.
            if (block instanceof Float32Array)
            {
                stagingFloats.set(block, at >>> 2);
            }
            else
            {
                staging.set(block instanceof Uint8Array
                    ? block
                    : new Uint8Array(block.buffer, block.byteOffset, block.byteLength), at);
            }
            pendingTo = at + block.byteLength;
            recentBlocks[recentNext] = block;
            recentAt[recentNext] = at;
            recentLaying[recentNext] = laying;
            recentNext = (recentNext + 1) % RECENT;
            return slotOf(block, at, into);
        },

        /** Writes what was laid since the last write; before every submit. */
        flush,

        /** The frame is submitted: the next may wrap onto its blocks. */
        endFrame(){
            frameUsed = 0;
            laying++;
        },

        stats(){
            return { created, reused, writes, shared };
        },
    };
}

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
 * @param {any} resource
 * @returns {string}
 */
function resourceKey(resource){
    if (resource && typeof resource === 'object' && resource.buffer)
    {
        // The dynamic offset is not part of the group: it is given at bind
        // time, which is what lets one group serve every draw.
        const offset = resource.offset === undefined ? 0 : resource.offset;
        const size = resource.size === undefined ? 'all' : resource.size;
        return `b${resourceId(resource.buffer)}@${offset}+${size}`;
    }
    return `r${resourceId(resource)}`;
}

/**
 * The dynamic offsets a group's buffer bindings are bound at, in binding
 * order, or nothing when no binding carries one.
 *
 * @param {any[]} entries
 * @returns {number[] | undefined}
 */
export function dynamicOffsetsOf(entries){
    // Every draw binds through here: one pass and one array when the entries
    // already come in binding order, as a renderer lays them out.
    /** @type {number[] | undefined} */
    let offsets;
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
            return entries
                .filter(one=>one.resource && typeof one.resource === 'object'
                    && one.resource.buffer && one.resource.dynamicOffset !== undefined)
                .sort((left, right)=>left.binding - right.binding)
                .map(one=>one.resource.dynamicOffset);
        }
        last = entry.binding;
        (offsets ??= []).push(resource.dynamicOffset);
    }
    return offsets;
}

/**
 * A bind-group cache with the lifetime of one render pass.
 *
 * @param {{ device: import('../contract.js').GpuDeviceLike }} options
 * @returns {any}
 */
export function createBindingCache(options){
    /** @type {Map<string, any>} */
    const groups = new Map();
    let created = 0;
    let reused = 0;

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
            // A plain loop rather than `.map().join()`: this key is built on
            // every draw to ask the cache below, hit or miss, so the array
            // `.map()` would allocate here is thrown away before the lookup
            // it fed ever runs.
            let key = `${resourceId(layout)}|`;
            for (let i = 0; i < entries.length; i++)
            {
                if (i > 0)
                {
                    key += ',';
                }
                key += `${entries[i].binding}:${resourceKey(entries[i].resource)}`;
            }
            const cached = groups.get(key);
            if (cached)
            {
                reused++;
                return cached;
            }
            // The entries are the caller's, and may be written over for its
            // next draw: the group is made from a copy of them as they are.
            const group = options.device.createBindGroup({
                label,
                layout,
                entries: entries.map(entry=>({ binding: entry.binding, resource: entry.resource })),
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
    /** The laid bytes not yet written: [pendingFrom, pendingTo). */
    let pendingFrom = 0;
    let pendingTo = 0;
    /** Ring bytes the frame being recorded has used, a wrap's skipped tail included. */
    let frameUsed = 0;

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
        ring = options.device.createBuffer({
            label: `uniforms#${created}`,
            size: capacity,
            usage: options.usage,
        });
        staging = new Uint8Array(capacity);
        created++;
        cursor = 0;
        pendingFrom = 0;
        pendingTo = 0;
    };

    return {
        /**
         * @param {ArrayBufferView} block
         * @returns {{ buffer: any, offset: number, size: number, dynamicOffset: number }}
         */
        allocate(block){
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
            const bytes = block instanceof Uint8Array
                ? block
                : new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
            staging.set(bytes, at);
            pendingTo = at + bytes.byteLength;
            // The binding covers one block at offset zero; the offset the draw
            // actually reads from travels beside it, for setBindGroup.
            return { buffer: ring, offset: 0, size: block.byteLength, dynamicOffset: at };
        },

        /** Writes what was laid since the last write; before every submit. */
        flush,

        /** The frame is submitted: the next may wrap onto its blocks. */
        endFrame(){
            frameUsed = 0;
        },

        stats(){
            return { created, reused, writes };
        },
    };
}

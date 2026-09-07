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
        const offset = resource.offset === undefined ? 0 : resource.offset;
        const size = resource.size === undefined ? 'all' : resource.size;
        return `b${resourceId(resource.buffer)}@${offset}+${size}`;
    }
    return `r${resourceId(resource)}`;
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
            const key = `${resourceId(layout)}|`
                + entries.map(entry=>`${entry.binding}:${resourceKey(entry.resource)}`).join(',');
            const cached = groups.get(key);
            if (cached)
            {
                reused++;
                return cached;
            }
            const group = options.device.createBindGroup({ label, layout, entries });
            groups.set(key, group);
            created++;
            return group;
        },

        stats(){
            return { created, reused };
        },
    };
}

/** Uniform buffer offsets and sizes are quantised to this in WebGPU. */
export const UNIFORM_ALIGNMENT = 256;

/**
 * Hands out one buffer per uniform block, recycled between frames.
 *
 * @param {Object} options
 * @param {import('../contract.js').GpuDeviceLike} options.device
 * @param {import('../contract.js').GpuQueueLike} options.queue
 * @param {number} [options.blockSize]
 * @param {number} [options.usage]
 * @returns {any}
 */
export function createUniformPool(options){
    const blockSize = options.blockSize === undefined ? UNIFORM_ALIGNMENT : options.blockSize;
    /** @type {any[]} */
    const free = [];
    /** @type {any[]} */
    const inUse = [];
    let created = 0;
    let reused = 0;

    return {
        /**
         * @param {ArrayBufferView} block
         * @returns {{ buffer: any, offset: number, size: number }}
         */
        allocate(block){
            const needed = Math.max(blockSize,
                Math.ceil(block.byteLength / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT);
            const index = free.findIndex(candidate=>candidate.size >= needed);
            let buffer;
            if (index < 0)
            {
                buffer = {
                    size: needed,
                    gpu: options.device.createBuffer({
                        label: `uniforms#${created}`,
                        size: needed,
                        usage: options.usage,
                    }),
                };
                created++;
            }
            else
            {
                buffer = free.splice(index, 1)[0];
                reused++;
            }
            inUse.push(buffer);
            // `writeBuffer` counts its offset and size in elements of the view it
            // is given, so blocks travel as bytes regardless of how they were built.
            const bytes = block instanceof Uint8Array
                ? block
                : new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
            options.queue.writeBuffer(buffer.gpu, 0, bytes, 0, bytes.byteLength);
            return { buffer: buffer.gpu, offset: 0, size: block.byteLength };
        },

        /**
         * Blocks are read by draws recorded in the frame that allocated them, so
         * they only return to the pool once that frame has been submitted.
         */
        endFrame(){
            while (inUse.length > 0)
            {
                free.push(inUse.pop());
            }
        },

        stats(){
            return { created, reused };
        },
    };
}

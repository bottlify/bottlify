/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Vulkan handle names on this side.
 *
 * Vulkan has two kinds and a program treats both as opaque. A *dispatchable*
 * handle (`VkInstance`, `VkPhysicalDevice`, `VkDevice`, `VkQueue`,
 * `VkCommandBuffer`) is a pointer; a real loader keeps a dispatch table at the
 * address, but nothing a program does depends on that, so here it is a number
 * from a range nothing else in the engine mints, and is never dereferenced. A
 * *non-dispatchable* handle is a 64-bit integer with no address semantics at
 * all; those count up from one.
 *
 * Neither is reused. A program that destroys an object and then uses the
 * stale handle has a bug, and the only useful answer is "that is not an
 * object", not "that is whatever was made next".
 *
 * Every object carries its kind, and a lookup names the kind it expects: a
 * `VkImage` handed where a `VkImageView` goes is a different bug from a stale
 * handle, and it is reported as one.
 */

/** Dispatchable handles start here; spaced so no two are within a cache line. */
const DISPATCHABLE_BASE = 0x0f000000;
const DISPATCHABLE_STRIDE = 0x40;

export function createHandles(){
    /** @type {Map<number, { kind: string }>} */
    const objects = new Map();
    let nextDispatchable = DISPATCHABLE_BASE;
    let nextOpaque = 1;

    return {
        /**
         * @template {{ kind: string }} T
         * @param {T} object
         * @returns {number} a pointer-sized handle
         */
        mintDispatchable(object){
            const handle = nextDispatchable;
            nextDispatchable += DISPATCHABLE_STRIDE;
            objects.set(handle, object);
            return handle;
        },

        /**
         * @template {{ kind: string }} T
         * @param {T} object
         * @returns {number} a 64-bit handle, as a number
         */
        mint(object){
            const handle = nextOpaque++;
            objects.set(handle, object);
            return handle;
        },

        /**
         * @param {number} handle
         * @param {string} kind
         * @returns {{ kind: string } | null}
         */
        get(handle, kind){
            const object = objects.get(handle);
            return object && object.kind === kind ? object : null;
        },

        /** @param {number} handle @returns {string | null} the kind, for a report */
        kindOf(handle){
            return objects.get(handle)?.kind ?? null;
        },

        /** @param {number} handle */
        release(handle){
            objects.delete(handle);
        },

        /** How many objects are alive, by kind. */
        census(){
            /** @type {Record<string, number>} */
            const counts = {};
            for (const object of objects.values())
            {
                counts[object.kind] = (counts[object.kind] ?? 0) + 1;
            }
            return counts;
        },
    };
}

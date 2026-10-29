/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The handle table: the guest's name for a kernel object.
 *
 * A handle is an opaque 32-bit value the guest passes back to us. Everything
 * about the shape below exists because the guest can be wrong -- it can close a
 * handle twice, keep using one after closing it, or invent one -- and the answer
 * to each of those has to be a defined error, not an accidental hit on whatever
 * object now occupies that slot.
 */

/** Windows returns this from APIs that fail to produce a handle. */
export const INVALID_HANDLE_VALUE = 0xffffffff;

/**
 * Handles are multiples of four. Real Windows does this too, and it means a
 * guest that treats a handle as a pointer, an index or a small integer breaks
 * loudly here rather than subtly later.
 */
const HANDLE_STRIDE = 4;

/**
 * Above every value a brush argument means as a system colour plus one
 * (COLOR_* + 1, up to 31): a class background, FillRect's brush. A brush and
 * a device context are handles of this table, and where Windows' GDI handles
 * never fall in that range, one of these at 8 was read as COLOR_WINDOWFRAME's
 * black instead of the brush the program made.
 */
export const FIRST_HANDLE = 0x40;

/**
 * Reuse is deferred as long as possible: a fresh handle is issued while the
 * range lasts, and only then does the table fall back to closed ones. A
 * use-after-close therefore lands on nothing -- a diagnosable error -- rather
 * than silently addressing whichever object was created next, which is the
 * failure this table exists to make impossible.
 *
 * @param {Object} [options]
 * @param {number} [options.limit]  Highest handle to issue before reusing closed ones.
 * @param {{ opened: (handle: number, type: string, object: any, access: number | null) => void,
 *     closed: (handle: number) => void }} [options.watch]  told of every open and close
 */
export function createHandleTable({ limit = 0x40000000, watch } = {}){
    /** @type {Map<number, { type: string, object: any, access: number | null }>} */
    const entries = new Map();
    /** @type {number[]} */
    const free = [];
    let next = FIRST_HANDLE;
    let opened = 0;
    let closed = 0;

    return {
        /**
         * @param {string} type    Kind of object, for diagnostics and type checks.
         * @param {any} object
         * @param {number | null} [access]  The rights the handle was granted, where
         *        it was opened with fewer than all of them; null for every right.
         * @returns {number} the handle
         */
        open(type, object, access = null){
            let handle;
            if (next <= limit)
            {
                handle = next;
                next += HANDLE_STRIDE;
            }
            else if (free.length > 0)
            {
                handle = /** @type {number} */ (free.shift());
            }
            else
            {
                throw new Error('Handle table exhausted');
            }
            entries.set(handle, { type, object, access });
            opened++;
            watch?.opened(handle, type, object, access);
            return handle;
        },

        /**
         * Resolves a handle, optionally asserting what kind of object it names.
         *
         * @param {number} handle
         * @param {string} [type]
         * @returns {any}
         */
        resolve(handle, type){
            const entry = entries.get(handle);
            if (!entry)
            {
                throw new Error(`Invalid handle 0x${(handle >>> 0).toString(16)}`);
            }
            if (type && entry.type !== type)
            {
                throw new Error(
                    `Handle 0x${(handle >>> 0).toString(16)} is a ${entry.type}, not a ${type}`);
            }
            return entry.object;
        },

        /** @param {number} handle @returns {boolean} */
        has(handle){
            return entries.has(handle);
        },

        /**
         * Whether anything still holds a handle to this object.
         *
         * A scan, because handles are looked up by number and this asks the
         * question the other way round. Affordable: the only caller is the
         * name registry, which asks once per named create, and a program makes
         * a handful of those in its whole life.
         *
         * @param {any} object @returns {boolean}
         */
        holds(object){
            for (const entry of entries.values())
            {
                if (entry.object === object)
                {
                    return true;
                }
            }
            return false;
        },

        /** @param {number} handle @returns {string | null} */
        typeOf(handle){
            return entries.get(handle)?.type ?? null;
        },

        /**
         * The rights a handle was granted: null for every right, as every
         * handle but one opened by name with fewer has.
         *
         * @param {number} handle @returns {number | null}
         */
        access(handle){
            return entries.get(handle)?.access ?? null;
        },

        /**
         * Closes a handle. Closing one that is not open is an error the caller
         * turns into a failure code, not something to ignore: a guest that closes
         * twice is usually a guest whose bookkeeping has already gone wrong.
         *
         * @param {number} handle
         * @returns {any} the object the handle named
         */
        close(handle){
            const entry = entries.get(handle);
            if (!entry)
            {
                throw new Error(`Cannot close invalid handle 0x${(handle >>> 0).toString(16)}`);
            }
            entries.delete(handle);
            free.push(handle);
            closed++;
            watch?.closed(handle);
            return entry.object;
        },

        /** @returns {{ handle: number, type: string, object: any, access: number | null }[]} */
        list(){
            return [...entries.entries()].map(([handle, entry])=>({ handle, type: entry.type,
                object: entry.object, access: entry.access }));
        },

        diagnostics(){
            /** @type {Record<string, number>} */
            const byType = {};
            for (const entry of entries.values())
            {
                byType[entry.type] = (byType[entry.type] ?? 0) + 1;
            }
            return { open: entries.size, opened, closed, pendingReuse: free.length, byType };
        },
    };
}

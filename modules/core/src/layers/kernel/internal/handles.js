/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
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
const FIRST_HANDLE = HANDLE_STRIDE;

/**
 * Reuse is deferred as long as possible: a fresh handle is issued while the
 * range lasts, and only then does the table fall back to closed ones. A
 * use-after-close therefore lands on nothing -- a diagnosable error -- rather
 * than silently addressing whichever object was created next, which is the
 * failure this table exists to make impossible.
 *
 * @param {Object} [options]
 * @param {number} [options.limit]  Highest handle to issue before reusing closed ones.
 */
export function createHandleTable({ limit = 0x40000000 } = {}){
    /** @type {Map<number, { type: string, object: any }>} */
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
         * @returns {number} the handle
         */
        open(type, object){
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
            entries.set(handle, { type, object });
            opened++;
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

        /** @param {number} handle @returns {string | null} */
        typeOf(handle){
            return entries.get(handle)?.type ?? null;
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
            return entry.object;
        },

        /** @returns {{ handle: number, type: string }[]} */
        list(){
            return [...entries.entries()].map(([handle, entry])=>({ handle, type: entry.type }));
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

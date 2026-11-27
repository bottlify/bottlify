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
 * HANDLE_FLAG_PROTECT_FROM_CLOSE. A handle's flags are its own, as its rights
 * are: they go with its close, and a number reused starts with none.
 */
const PROTECT_FROM_CLOSE = 0x2;

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
    /** @typedef {{ type: string, object: any, access: number | null, flags: number }} Entry */
    /** @type {Map<number, Entry>} */
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
         * @param {number} [flags]  HANDLE_FLAG_*: inheritable, protected from close.
         * @returns {number} the handle
         */
        open(type, object, access = null, flags = 0){
            let handle;
            // Past the numbers a handle was adopted at.
            while (next <= limit && entries.has(next))
            {
                next += HANDLE_STRIDE;
            }
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
            entries.set(handle, { type, object, access, flags });
            opened++;
            watch?.opened(handle, type, object, access);
            return handle;
        },

        /**
         * Files an object under a handle number chosen elsewhere: a handle a
         * child inherits has its parent's number, which the parent told it on
         * its command line, and the rights and flags its parent's handle had.
         * Refused for a number taken or not a handle's.
         *
         * @param {number} handle @param {string} type @param {any} object
         * @param {number | null} [access]  null for all of them
         * @param {number} [flags]  HANDLE_FLAG_*
         * @returns {boolean}
         */
        adopt(handle, type, object, access = null, flags = 0){
            if (entries.has(handle) || handle < FIRST_HANDLE || handle % HANDLE_STRIDE !== 0
                || handle > limit)
            {
                return false;
            }
            // A number closed before is free no longer.
            const freed = free.indexOf(handle);
            if (freed >= 0)
            {
                free.splice(freed, 1);
            }
            entries.set(handle, { type, object, access, flags });
            opened++;
            watch?.opened(handle, type, object, access);
            return true;
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

        /** A handle's HANDLE_FLAG_* flags, null for no handle. @param {number} handle */
        flags(handle){
            return entries.get(handle)?.flags ?? null;
        },

        /**
         * SetHandleInformation's: the flags `mask` names set to `flags`'.
         * False for no handle. @param {number} handle @param {number} mask @param {number} flags
         */
        setFlags(handle, mask, flags){
            const entry = entries.get(handle);
            if (!entry)
            {
                return false;
            }
            entry.flags = (entry.flags & ~mask) | (flags & mask);
            return true;
        },

        /**
         * Closes a handle. Closing one that is not open, or one protected from
         * close, is an error the caller turns into a failure code, not
         * something to ignore: a guest that closes twice is usually a guest
         * whose bookkeeping has already gone wrong.
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
            if ((entry.flags & PROTECT_FROM_CLOSE) !== 0)
            {
                throw new Error(`Handle 0x${(handle >>> 0).toString(16)} is protected from close`);
            }
            entries.delete(handle);
            free.push(handle);
            closed++;
            watch?.closed(handle);
            return entry.object;
        },

        /** @returns {({ handle: number } & Entry)[]} */
        list(){
            return [...entries].map(([handle, entry])=>({ handle, ...entry }));
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

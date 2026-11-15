/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The global and local memory families over the process heap: a fixed block
 * is its own handle, and a moveable one is a handle that has to be locked
 * into a pointer.
 *
 * A moveable handle is the address of the pointer field of an entry in the
 * process's handle table - an entry being two pointer-sized words, its flags
 * then the block's address - so it is a pointer's width past an alignment of
 * two pointers, where no heap block ever starts: that is how every call of the
 * family tells a handle from a fixed block. Programs read the entry through
 * the handle (`*(void **)hMem` is the block's address while it is not
 * discarded) and Wine's heap tests read its flags word, so both live in guest
 * memory as Windows lays them out: in use 1, moveable 2, discardable 4,
 * discarded 8, DDE-shared 0x8000, and the lock count in bits 16 to 23,
 * stopping at 255. A freed entry's flags word is the address of the next free
 * one and its pointer is NULL. The table holds 65536 entries, as Windows'
 * does, made a chunk at a time as they are needed.
 *
 * The block a moveable handle owns carries the handle as its heap user value
 * (RtlGetUserInfoHeap, user flags 0x200), which is how GlobalHandle finds the
 * handle from a locked pointer.
 */

/** The entry's flags word. */
const IN_USE = 0x1;
const MOVEABLE = 0x2;
const DISCARDABLE = 0x4;
const DISCARDED = 0x8;
const DDE_SHARED = 0x8000;
const LOCK_SHIFT = 16;
const MOST_LOCKS = 0xff;

/** The user flags a moveable handle's block carries (BASE_HEAP_FLAG_MOVEABLE). */
export const MOVEABLE_USER_FLAGS = 0x200;

/** The calls' flags, in both spellings where they differ. */
const GMEM_MOVEABLE = 0x0002;
const GMEM_ZEROINIT = 0x0040;
const GMEM_MODIFY = 0x0080;
const GMEM_DISCARDABLE = 0x0100;
const GMEM_DDESHARE = 0x2000;
const GMEM_DISCARDED = 0x4000;
const GMEM_INVALID_HANDLE = 0x8000;
const LMEM_DISCARDABLE = 0x0f00;

const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_DISCARDED = 157;
const ERROR_NOT_LOCKED = 158;
const ERROR_NOACCESS = 998;

/** Entries in the table, and in each chunk of it made at once. */
const CAPACITY = 0x10000;
const CHUNK_ENTRIES = 256;

/**
 * @typedef {Object} GlobalMemoryHost
 * @property {(bytes: number) => number} allocate  A block of the process heap, or 0.
 * @property {(address: number) => boolean} free
 * @property {(address: number) => ({ address: number, size: number } | null)} block
 *     A live heap block that starts at the address.
 * @property {(block: { address: number, size: number, owner: any }, wanted: number,
 *     how: { zeroTail: boolean, mayMove: boolean }) => number} reallocate
 * @property {(address: number, length: number) => void} zero
 *     Zeroes what a fresh allocation handed over, where it is not zero already.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {Map<number, { value: number, flags: number }>} userInfo
 *     The heap user value and flags of each block that has them.
 * @property {4 | 8} [pointerSize]
 */

/**
 * @typedef {Object} Entry
 * @property {number} flags  The entry's flags word, lock count included.
 * @property {number} pointer  Its block, or 0 while it is discarded.
 */

/**
 * @typedef {ReturnType<typeof createGlobalMemory>} GlobalMemory
 */

/**
 * The handle table and the family's calls in both spellings.
 *
 * @param {GlobalMemoryHost} host
 */
export function createGlobalMemory(host){
    const width = host.pointerSize ?? 4;
    const entrySize = width * 2;
    /** @type {Map<number, Entry>} live entries, by handle */
    const live = new Map();
    /** How many entries the chunks made so far hold. */
    let created = 0;
    /** @type {number[]} free entries' addresses, the next to hand out last */
    const unused = [];
    /** The first chunk, whose address a freed entry links to when no other is free. */
    let firstChunk = 0;

    /** @param {number} handle */
    const isHandle = handle=>(handle & (entrySize - 1)) === width;

    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>{
        const bytes = new Uint8Array(width);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} handle @param {Entry} entry */
    const store = (handle, entry)=>{
        writeWord(handle - width, entry.flags);
        writeWord(handle, entry.pointer);
    };

    /** A free entry's handle, a chunk made for it if none is free; 0 when the table is full. */
    const take = ()=>{
        if (unused.length === 0)
        {
            if (created >= CAPACITY)
            {
                return 0;
            }
            // The chunk's first entry's room is left unused, so no handle is
            // the start of the heap block the chunk is.
            const chunk = host.allocate(entrySize * (CHUNK_ENTRIES + 1));
            if (chunk === 0)
            {
                return 0;
            }
            if (firstChunk === 0)
            {
                firstChunk = chunk;
            }
            created += CHUNK_ENTRIES;
            for (let index = CHUNK_ENTRIES; index >= 1; index--)
            {
                unused.push(chunk + index * entrySize);
            }
        }
        return /** @type {number} */ (unused.pop()) + width;
    };

    /** @param {number} handle */
    const giveBack = handle=>{
        live.delete(handle);
        const entry = handle - width;
        // A freed entry links to the next free one, as Windows' free list does.
        writeWord(entry, unused.at(-1) ?? firstChunk);
        writeWord(handle, 0);
        unused.push(entry);
    };

    /** @param {number} pointer @param {number} handle */
    const own = (pointer, handle)=>{
        host.userInfo.set(pointer, { value: handle, flags: MOVEABLE_USER_FLAGS });
    };

    /** @param {number} pointer */
    const release = pointer=>{
        host.userInfo.delete(pointer);
        host.free(pointer);
    };

    /** @param {Entry} entry */
    const locks = entry=>(entry.flags >>> LOCK_SHIFT) & MOST_LOCKS;

    /**
     * A live entry by its handle, or null with ERROR_INVALID_HANDLE said: a
     * freed handle and a number shaped like one alike.
     *
     * @param {number} handle
     */
    const entryOf = handle=>{
        const entry = live.get(handle);
        if (!entry)
        {
            host.setLastError(ERROR_INVALID_HANDLE);
            return null;
        }
        return entry;
    };

    /**
     * One spelling of the family: what its discardable flag is, and whether it
     * knows DDE sharing.
     *
     * @param {{ discardable: number, shared: number }} spelling
     */
    const family = ({ discardable, shared })=>{
        /** @param {number} flags */
        const entryBits = flags=>IN_USE | MOVEABLE
            | ((flags & discardable) !== 0 ? DISCARDABLE : 0)
            | ((flags & GMEM_DDESHARE & shared) !== 0 ? DDE_SHARED : 0);

        /** @param {number} flags @param {number} bytes */
        const allocate = (flags, bytes)=>{
            if ((flags & GMEM_MOVEABLE) === 0)
            {
                const size = bytes === 0 ? 1 : bytes;
                const address = host.allocate(size);
                if (address === 0)
                {
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                if (flags & GMEM_ZEROINIT)
                {
                    host.zero(address, size);
                }
                return address;
            }
            const handle = take();
            if (handle === 0)
            {
                host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                return 0;
            }
            /** @type {Entry} */
            const entry = { flags: entryBits(flags), pointer: 0 };
            if (bytes === 0)
            {
                entry.flags |= DISCARDED;
            }
            else
            {
                entry.pointer = host.allocate(bytes);
                if (entry.pointer === 0)
                {
                    giveBack(handle);
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                if (flags & GMEM_ZEROINIT)
                {
                    host.zero(entry.pointer, bytes);
                }
                own(entry.pointer, handle);
            }
            live.set(handle, entry);
            store(handle, entry);
            return handle;
        };

        /** @param {number} handle */
        const lock = handle=>{
            if (!isHandle(handle))
            {
                if (host.block(handle))
                {
                    return handle;
                }
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const entry = entryOf(handle);
            if (!entry)
            {
                return 0;
            }
            if (entry.pointer === 0)
            {
                host.setLastError(ERROR_DISCARDED);
                return 0;
            }
            if (locks(entry) < MOST_LOCKS)
            {
                entry.flags += 1 << LOCK_SHIFT;
                store(handle, entry);
            }
            return entry.pointer;
        };

        /**
         * TRUE while the block stays locked: a fixed block always is, and so
         * is a handle that is no entry, with ERROR_INVALID_HANDLE said. The
         * last unlock answers FALSE with ERROR_SUCCESS, one more FALSE with
         * ERROR_NOT_LOCKED.
         *
         * @param {number} handle
         */
        const unlock = handle=>{
            if (!isHandle(handle))
            {
                return 1;
            }
            const entry = entryOf(handle);
            if (!entry)
            {
                return 1;
            }
            const count = locks(entry);
            if (count === 0)
            {
                host.setLastError(ERROR_NOT_LOCKED);
                return 0;
            }
            entry.flags -= 1 << LOCK_SHIFT;
            store(handle, entry);
            if (count === 1)
            {
                host.setLastError(ERROR_SUCCESS);
                return 0;
            }
            return 1;
        };

        /**
         * NULL once the memory is gone, the handle back otherwise: a freed
         * handle with ERROR_INVALID_HANDLE, a pointer that is no block with
         * ERROR_NOACCESS.
         *
         * @param {number} handle
         */
        const free = handle=>{
            if (handle === 0)
            {
                return 0;
            }
            if (!isHandle(handle))
            {
                if (host.block(handle) && host.free(handle))
                {
                    host.userInfo.delete(handle);
                    return 0;
                }
                host.setLastError(ERROR_NOACCESS);
                return handle;
            }
            const entry = entryOf(handle);
            if (!entry)
            {
                return handle;
            }
            if (entry.pointer !== 0)
            {
                release(entry.pointer);
            }
            giveBack(handle);
            return 0;
        };

        /** @param {number} handle */
        const size = handle=>{
            if (!isHandle(handle))
            {
                const block = host.block(handle);
                if (!block)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                return block.size;
            }
            const entry = entryOf(handle);
            if (!entry || entry.pointer === 0)
            {
                return 0;
            }
            return host.block(entry.pointer)?.size ?? 0;
        };

        /** @param {number} handle */
        const flagsOf = handle=>{
            if (!isHandle(handle))
            {
                if (host.block(handle))
                {
                    return 0;
                }
                host.setLastError(ERROR_INVALID_HANDLE);
                return GMEM_INVALID_HANDLE;
            }
            const entry = entryOf(handle);
            if (!entry)
            {
                return GMEM_INVALID_HANDLE;
            }
            return locks(entry)
                | ((entry.flags & DISCARDABLE) !== 0 ? discardable : 0)
                | ((entry.flags & DISCARDED) !== 0 ? GMEM_DISCARDED : 0)
                | ((entry.flags & DDE_SHARED) !== 0 ? GMEM_DDESHARE & shared : 0);
        };

        /**
         * The handle of a pointer: a moveable block's own, which it carries as
         * its heap user value, or a fixed block itself.
         *
         * @param {number} pointer
         */
        const handleOf = pointer=>{
            const info = host.userInfo.get(pointer);
            if (info && (info.flags & MOVEABLE_USER_FLAGS) !== 0 && host.block(pointer))
            {
                return info.value;
            }
            if (host.block(pointer))
            {
                return pointer;
            }
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        };

        /**
         * A fixed block resized, or turned moveable by GMEM_MODIFY with
         * GMEM_MOVEABLE; GMEM_MODIFY alone changes nothing, and a discardable
         * fixed block is not a thing.
         *
         * @param {number} handle @param {number} bytes @param {number} flags
         */
        const reallocateFixed = (handle, bytes, flags)=>{
            const block = host.block(handle);
            if (!block)
            {
                host.setLastError(ERROR_NOACCESS);
                return 0;
            }
            if (flags & GMEM_MODIFY)
            {
                if ((flags & GMEM_MOVEABLE) === 0)
                {
                    return handle;
                }
                const moveable = take();
                if (moveable === 0)
                {
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                /** @type {Entry} */
                const entry = { flags: entryBits(flags) & ~DDE_SHARED, pointer: handle };
                own(handle, moveable);
                live.set(moveable, entry);
                store(moveable, entry);
                return moveable;
            }
            if (flags & discardable)
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const moved = host.reallocate(/** @type {any} */ (block), bytes, {
                zeroTail: (flags & GMEM_ZEROINIT) !== 0,
                mayMove: (flags & GMEM_MOVEABLE) !== 0,
            });
            if (moved === 0)
            {
                host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
            }
            return moved;
        };

        /**
         * A moveable block resized under its handle: an unlocked one goes
         * wherever it fits, a locked one moves only with GMEM_MOVEABLE; no
         * bytes discards an unlocked one asked with GMEM_MOVEABLE; GMEM_MODIFY
         * only makes it discardable.
         *
         * @param {number} handle @param {number} bytes @param {number} flags
         */
        const reallocateMoveable = (handle, bytes, flags)=>{
            const entry = entryOf(handle);
            if (!entry)
            {
                return 0;
            }
            if (flags & GMEM_MODIFY)
            {
                if (flags & discardable)
                {
                    entry.flags |= DISCARDABLE;
                    store(handle, entry);
                }
                return handle;
            }
            const locked = locks(entry) !== 0;
            if ((flags & discardable) !== 0
                || (bytes === 0 && (locked || (flags & GMEM_MOVEABLE) === 0)))
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            if (bytes === 0)
            {
                if (entry.pointer !== 0)
                {
                    release(entry.pointer);
                }
                entry.pointer = 0;
                entry.flags |= DISCARDED;
                store(handle, entry);
                return handle;
            }
            if (entry.pointer === 0)
            {
                const fresh = host.allocate(bytes);
                if (fresh === 0)
                {
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                if (flags & GMEM_ZEROINIT)
                {
                    host.zero(fresh, bytes);
                }
                own(fresh, handle);
                entry.pointer = fresh;
                entry.flags &= ~DISCARDED;
                store(handle, entry);
                return handle;
            }
            const block = host.block(entry.pointer);
            if (!block)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const was = entry.pointer;
            const moved = host.reallocate(/** @type {any} */ (block), bytes, {
                zeroTail: (flags & GMEM_ZEROINIT) !== 0,
                mayMove: !locked || (flags & GMEM_MOVEABLE) !== 0,
            });
            if (moved === 0)
            {
                host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                return 0;
            }
            if (moved !== was)
            {
                host.userInfo.delete(was);
                own(moved, handle);
                entry.pointer = moved;
                store(handle, entry);
            }
            return handle;
        };

        /** @param {number} handle @param {number} bytes @param {number} flags */
        const reallocate = (handle, bytes, flags)=>{
            if (handle === 0)
            {
                host.setLastError(ERROR_NOACCESS);
                return 0;
            }
            return isHandle(handle) ? reallocateMoveable(handle, bytes, flags)
                : reallocateFixed(handle, bytes, flags);
        };

        return { allocate, lock, unlock, free, size, flags: flagsOf, handleOf, reallocate,
            discard: (/** @type {number} */ handle)=>reallocate(handle, 0, GMEM_MOVEABLE) };
    };

    return {
        global: family({ discardable: GMEM_DISCARDABLE, shared: GMEM_DDESHARE }),
        local: family({ discardable: LMEM_DISCARDABLE, shared: 0 }),
        isHandle,
        /**
         * Whether the handle is a live entry, or a fixed block's address.
         *
         * @param {number} handle
         */
        has: handle=>(isHandle(handle) ? live.has(handle) : host.block(handle) !== null),
        /**
         * A handle's block as it stands, or a fixed block's own - what a
         * memory stream over an HGLOBAL reads and writes - without locking it.
         *
         * @param {number} handle
         */
        pointer: handle=>(isHandle(handle) ? live.get(handle)?.pointer ?? 0
            : host.block(handle) ? handle : 0),
    };
}

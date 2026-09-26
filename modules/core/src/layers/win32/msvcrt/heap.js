/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * malloc, and the C++ allocation operators that are the same thing under
 * another name.
 *
 * There is one allocator behind all of these, and there has to be: a C++
 * program frees with `delete` memory that a C library function inside the same
 * runtime allocated with `malloc`, and a program that mixes a `new[]` with a
 * `free` -- which is a bug, but a common and survivable one on Windows -- gets
 * away with it there and must here too.
 *
 * `realloc` is where the contract has teeth. It may move the block, and when it
 * does the old pointer is dead; when it cannot satisfy the request it must
 * return null and leave the *original* block alive, which is the case that
 * `p = realloc(p, n)` loses and a careful caller does not.
 */

import { EINVAL, ENOMEM } from './globals.js';

/**
 * @typedef {Object} HeapHost
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => boolean} free
 * @property {(address: number) => { size: number, capacity: number } | null} block
 * @property {(address: number, bytes: number) => boolean} resize
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, value: number, length: number) => void} fillMemory
 *     Sets a range to one byte value in place, with no host buffer holding
 *     the pattern: the lengths are the program's, and a clear of a megabyte
 *     through writeMemory costs an allocation and two extra passes.
 * @property {(code: number) => void} [errno]  Where a failure says why.
 */

/** A pointer's size: what an aligned block keeps below itself, and its least alignment. */
const POINTER = 4;

/**
 * @param {HeapHost} host
 */
export function createHeapFunctions(host){
    /** @param {number} bytes */
    const malloc = bytes=>host.allocate(bytes >>> 0);

    /** @type {(args: number[]) => number} */
    const mallocHandler = ([bytes])=>malloc(bytes);

    /** @type {(args: number[]) => number} */
    const freeHandler = ([address])=>{
        // Freeing null is defined and common: it is what a cleanup path does
        // when the allocation it is unwinding never happened.
        if ((address >>> 0) !== 0)
        {
            host.free(address);
        }
        return 0;
    };

    const allocator = {
        convention: 'cdecl',
        argBytes: 4,
        handler: mallocHandler,
    };

    const deallocator = {
        convention: 'cdecl',
        argBytes: 4,
        handler: freeHandler,
    };

    return {
        /** void *malloc(size_t size) */
        malloc: allocator,

        /** void free(void *block) */
        free: deallocator,

        /** void *calloc(size_t count, size_t size) */
        calloc: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([count, size])=>{
                const bytes = (count >>> 0) * (size >>> 0);
                if (bytes > 0xffffffff)
                {
                    return 0;
                }
                const address = malloc(bytes);
                if (address !== 0)
                {
                    host.fillMemory(address, 0, bytes);
                }
                return address;
            },
        },

        /** void *realloc(void *block, size_t size) */
        realloc: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, size])=>{
                const bytes = size >>> 0;
                if ((address >>> 0) === 0)
                {
                    return malloc(bytes);
                }
                if (bytes === 0)
                {
                    host.free(address);
                    return 0;
                }
                const existing = host.block(address);
                if (!existing)
                {
                    return 0;
                }
                if (host.resize(address, bytes))
                {
                    return address;
                }

                const moved = malloc(bytes);
                if (moved === 0)
                {
                    // The original stays alive. Returning null and freeing it
                    // anyway is the failure mode that turns an out-of-memory
                    // condition into a use-after-free somewhere unrelated.
                    return 0;
                }
                host.writeMemory(moved,
                    host.readMemory(address, Math.min(existing.size, bytes)).slice());
                host.free(address);
                return moved;
            },
        },

        /** size_t _msize(void *block) */
        _msize: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>host.block(address)?.size ?? 0,
        },

        /**
         * void *_expand(void *block, size_t size)
         *
         * Grows or shrinks without moving, and answers null rather than moving
         * -- the whole point of it is that the pointer stays valid.
         */
        _expand: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, size])=>host.resize(address, size >>> 0) ? address : 0,
        },

        /**
         * void *_aligned_malloc(size_t size, size_t alignment)
         *
         * A block at a multiple of `alignment`, a power of two -- zero counts
         * -- carved from a malloc block large enough to move it up that far.
         * The address malloc gave is kept in the pointer just below the one
         * handed out, which is where _aligned_free looks for it; nothing is
         * aligned to less than a pointer, so that slot is always whole. Any
         * other alignment, or a size of zero, is NULL and EINVAL, and a
         * failed allocation ENOMEM (Wine's msvcrt test_aligned, and the
         * documentation).
         */
        _aligned_malloc: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, alignment])=>{
                const align = alignment >>> 0;
                if ((align & (align - 1)) !== 0 || (size >>> 0) === 0)
                {
                    host.errno?.(EINVAL);
                    return 0;
                }
                const step = Math.max(align, POINTER);
                const bytes = (size >>> 0) + step + POINTER;
                const base = bytes > 0xffffffff ? 0 : malloc(bytes);
                if (base === 0)
                {
                    host.errno?.(ENOMEM);
                    return 0;
                }
                const block = Math.ceil((base + POINTER) / step) * step;
                const saved = new Uint8Array(POINTER);
                new DataView(saved.buffer).setUint32(0, base, true);
                host.writeMemory(block - POINTER, saved);
                return block;
            },
        },

        /** void _aligned_free(void *block) -- NULL does nothing. */
        _aligned_free: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                if ((block >>> 0) !== 0)
                {
                    const saved = host.readMemory((block >>> 0) - POINTER, POINTER);
                    host.free(new DataView(saved.buffer, saved.byteOffset, POINTER)
                        .getUint32(0, true));
                }
                return 0;
            },
        },

        // The C++ operators, by their decorated names, because that is what a
        // compiled object actually imports. Failure is a null return: this
        // runtime has no way to throw std::bad_alloc into guest code, and code
        // built against the older runtime checked for null anyway.
        '??2@YAPAXI@Z': allocator,   // operator new(unsigned int)
        '??_U@YAPAXI@Z': allocator,  // operator new[](unsigned int)
        '??3@YAXPAX@Z': deallocator, // operator delete(void *)
        '??_V@YAXPAX@Z': deallocator, // operator delete[](void *)
    };
}

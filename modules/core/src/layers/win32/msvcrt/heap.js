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
import {
    callocCode, freeCode, mallocCode, msizeCode, reallocCode,
} from '../kernel32/guest-heap.js';
import {
    bindLong, callocLongCode, freeLongCode, mallocLongCode, msizeLongCode, reallocLongCode,
} from '../kernel32/guest-heap-long.js';

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
 * @property {ReturnType<typeof import('../kernel32/guest-heap.js').createGuestHeap>} [guestHeap]
 *     Where the small blocks are the guest's own: malloc, free, calloc,
 *     realloc and _msize are then guest code over `heapHandle`'s heap, each
 *     falling back to its handler here.
 * @property {() => number} [heapHandle]
 * @property {(bytes: number) => number} [allocateCode]
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} [callGuest]
 *     How the program's new handler is run when an allocation fails. Absent,
 *     a handler can be set but is never called.
 * @property {() => any} [currentThread]
 */

/** A pointer's size: what an aligned block keeps below itself, and its least alignment. */
const POINTER = 4;

/** The small-block threshold's step and its most. */
const SBH_STEP = 16;
const SBH_MAX = 1016;

/**
 * @param {HeapHost} host
 */
export function createHeapFunctions(host){
    /** @param {number} bytes */
    const malloc = bytes=>host.allocate(bytes >>> 0);

    /**
     * The program's new handler, `int (__cdecl *)(size_t)`, and whether
     * malloc calls it too (`_set_new_mode(1)`) or only operator new does.
     */
    let newHandler = 0;
    let newMode = 0;
    let sbhThreshold = 0;

    /**
     * Where an aligned block keeps the address malloc gave: the
     * pointer-aligned slot just below it.
     *
     * @param {number} block
     */
    const savedSlot = block=>(block - POINTER & ~(POINTER - 1)) >>> 0;

    /** The address malloc gave for an aligned block. @param {number} block */
    const alignedBase = block=>{
        const saved = host.readMemory(savedSlot(block), POINTER);
        return new DataView(saved.buffer, saved.byteOffset, POINTER).getUint32(0, true);
    };

    /**
     * _aligned_offset_malloc's body.
     *
     * @param {number} size @param {number} alignment @param {number} offset
     */
    const alignedAllocate = (size, alignment, offset)=>{
        if ((alignment & (alignment - 1)) !== 0 || size === 0 || offset >= size)
        {
            host.errno?.(EINVAL);
            return 0;
        }
        const step = Math.max(alignment, POINTER);
        const bytes = size + step + POINTER;
        const base = bytes > 0xffffffff ? 0 : malloc(bytes);
        if (base === 0)
        {
            host.errno?.(ENOMEM);
            return 0;
        }
        const block = Math.ceil((base + POINTER + offset) / step) * step - offset;
        const saved = new Uint8Array(POINTER);
        new DataView(saved.buffer).setUint32(0, base, true);
        host.writeMemory(savedSlot(block), saved);
        return block;
    };

    /**
     * _aligned_offset_realloc's body.
     *
     * @param {number} block @param {number} size @param {number} alignment
     * @param {number} offset
     */
    const alignedResize = (block, size, alignment, offset)=>{
        if (block === 0)
        {
            return alignedAllocate(size, alignment, offset);
        }
        if (size === 0)
        {
            host.free(alignedBase(block));
            return 0;
        }
        const moved = alignedAllocate(size, alignment, offset);
        if (moved === 0)
        {
            return 0;
        }
        const base = alignedBase(block);
        const held = Math.max(0, (host.block(base)?.size ?? 0) - (block - base));
        const kept = Math.min(held, size);
        if (kept > 0)
        {
            host.writeMemory(moved, host.readMemory(block, kept).slice());
        }
        host.free(base);
        return moved;
    };

    /**
     * An allocation that failed, retried for as long as the new handler says
     * it freed something: zero from the handler, or no handler, is the null
     * the caller gets. The handler is guest code, so this answers late.
     *
     * @param {number} bytes
     * @returns {number | Promise<number>}
     */
    const rescue = bytes=>{
        if (newHandler === 0 || !host.callGuest)
        {
            return 0;
        }
        const callGuest = host.callGuest;
        const thread = host.currentThread?.();
        /** @returns {Promise<number>} */
        const attempt = ()=>(newHandler === 0
            ? Promise.resolve(0)
            : callGuest(newHandler, [bytes >>> 0], thread).then(answer=>{
                if ((answer | 0) === 0)
                {
                    return 0;
                }
                const address = malloc(bytes);
                return address !== 0 ? address : attempt();
            }));
        return attempt();
    };

    /** @type {(args: number[]) => number | Promise<number>} */
    const mallocHandler = ([bytes])=>{
        const address = malloc(bytes);
        return address === 0 && newMode !== 0 ? rescue(bytes) : address;
    };

    /** @type {(args: number[]) => number | Promise<number>} */
    const newHandlerCall = ([bytes])=>{
        const address = malloc(bytes);
        return address === 0 ? rescue(bytes) : address;
    };

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

    /**
     * The guest's routines, placed once on the first bind of any of them,
     * each falling back to its handler through a trap of its own.
     *
     * @type {Record<'malloc' | 'new' | 'free' | 'calloc' | 'realloc' | 'msize', number> | null}
     */
    let routines = null;
    /** @param {{ register: (label: string, trap: any) => number }} builder */
    const placedRoutines = builder=>{
        if (routines)
        {
            return routines;
        }
        const guest = /** @type {NonNullable<HeapHost['guestHeap']>} */ (host.guestHeap);
        const placement = guest.placement();
        const heap = /** @type {() => number} */ (host.heapHandle)();
        const allocateCode = /** @type {(bytes: number) => number} */ (host.allocateCode);
        /**
         * @param {string} label @param {{ argBytes: number, handler: Function }} entry
         * @param {(p: import('../kernel32/guest-heap.js').Placement, at: number, trap: number)
         *     => Uint8Array} code
         */
        const place = (label, entry, code)=>{
            const trap = builder.register(label, {
                convention: 'cdecl', argBytes: entry.argBytes, handler: entry.handler,
            });
            if (placement === null || !guest.isHeap(heap))
            {
                return trap;
            }
            const at = allocateCode(code(placement, 0, trap).length);
            host.writeMemory(at, code(placement, at, trap));
            return at;
        };
        routines = {
            malloc: place('<malloc>', allocator,
                (p, at, trap)=>mallocCode(p, at, trap, heap)),
            new: place('<new>', newAllocator,
                (p, at, trap)=>mallocCode(p, at, trap, heap)),
            free: place('<free>', deallocator, freeCode),
            calloc: place('<calloc>', table.calloc, (p, at, trap)=>callocCode(p, at, trap, heap)),
            realloc: place('<realloc>', table.realloc, reallocCode),
            msize: place('<msize>', table._msize, msizeCode),
        };
        return routines;
    };
    /** @param {'malloc' | 'new' | 'free' | 'calloc' | 'realloc' | 'msize'} which */
    /**
     * The same routines in x86-64 for a 64-bit process, each placed with its
     * module by the loader: the export each hands over to, and the routine
     * over the tables' placement and the heap.
     *
     * @type {Record<'malloc' | 'new' | 'free' | 'calloc' | 'realloc' | 'msize',
     *     [() => { argBytes: number, handler: Function },
     *     (p: import('../kernel32/guest-heap.js').Placement, heap: number)
     *         => import('../kernel32/guest-heap-long.js').LongRoutine]>}
     */
    const longRoutines = {
        malloc: [()=>allocator, mallocLongCode],
        new: [()=>newAllocator, mallocLongCode],
        free: [()=>deallocator, freeLongCode],
        calloc: [()=>table.calloc, callocLongCode],
        realloc: [()=>table.realloc, reallocLongCode],
        msize: [()=>table._msize, msizeLongCode],
    };
    /** @param {'malloc' | 'new' | 'free' | 'calloc' | 'realloc' | 'msize'} which */
    const routine = which=>(host.guestHeap && host.heapHandle && host.allocateCode
        ? {
            /** @param {{ register: (label: string, trap: any) => number }} builder */
            guest: builder=>placedRoutines(builder)[which],
            /** @param {import('../kernel32/guest-heap-long.js').LongBuilder} builder */
            long: builder=>{
                const [entryOf, make] = longRoutines[which];
                const guest = /** @type {NonNullable<HeapHost['guestHeap']>} */ (host.guestHeap);
                const placement = guest.placement();
                const heap = /** @type {() => number} */ (host.heapHandle)();
                const entry = entryOf();
                return bindLong(builder, placement === null || !guest.isHeap(heap) ? null
                    : make(placement, heap), {
                    convention: 'cdecl', argBytes: entry.argBytes, handler: entry.handler,
                });
            },
        }
        : {});

    const allocator = {
        convention: 'cdecl',
        argBytes: 4,
        handler: mallocHandler,
        ...routine('malloc'),
    };

    /**
     * operator new: malloc, but a failure is the new handler's to answer
     * whatever the new mode -- a routine of its own for that, the guest's
     * fast path the same as malloc's.
     */
    const newAllocator = {
        convention: 'cdecl',
        argBytes: 4,
        handler: newHandlerCall,
        ...routine('new'),
    };

    const deallocator = {
        convention: 'cdecl',
        argBytes: 4,
        handler: freeHandler,
        ...routine('free'),
    };

    /** _PNH _set_new_handler(_PNH handler): the previous handler back. */
    const setNewHandler = {
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([handler])=>{
            const previous = newHandler;
            newHandler = handler >>> 0;
            return previous;
        },
    };

    const table = {
        /** void *malloc(size_t size) */
        malloc: allocator,

        /** void free(void *block) */
        free: deallocator,

        /** void *calloc(size_t count, size_t size) */
        calloc: {
            convention: 'cdecl',
            argBytes: 8,
            ...routine('calloc'),
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
            ...routine('realloc'),
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

        /**
         * int _heapchk(void) -- _HEAPOK (-2): the heap is the host's, and a
         * guest write past a block cannot corrupt anything the check walks.
         */
        _heapchk: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>0xfffffffe,
        },

        /** size_t _msize(void *block) */
        _msize: {
            convention: 'cdecl',
            argBytes: 4,
            ...routine('msize'),
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
         * void *_aligned_offset_malloc(size_t size, size_t alignment, size_t offset)
         *
         * A block whose byte at `offset` -- none, for the first -- sits at a
         * multiple of `alignment`, a power of two (zero counts), carved from
         * a malloc block large enough to move it up that far. The address
         * malloc gave is kept in the pointer-aligned slot just below the
         * block, which is where _aligned_free looks for it. Any other
         * alignment, a size of zero or an offset not inside the block is
         * NULL and EINVAL, and a failed allocation ENOMEM (Wine's msvcrt
         * test_aligned, and the documentation).
         */
        _aligned_malloc: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, alignment])=>alignedAllocate(size >>> 0, alignment >>> 0, 0),
        },
        _aligned_offset_malloc: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([size, alignment, offset])=>
                alignedAllocate(size >>> 0, alignment >>> 0, offset >>> 0),
        },

        /**
         * void *_aligned_realloc(void *block, size_t size, size_t alignment)
         * void *_aligned_offset_realloc(void *block, size_t size, size_t alignment,
         *                               size_t offset)
         *
         * A new aligned block with as much of the old one's bytes as both
         * hold, the old one freed: no block is an allocation, a size of zero
         * a free answering NULL. A request the allocation would refuse is
         * NULL with EINVAL, the old block kept -- the alignment and offset
         * may differ from the ones it was made with.
         */
        _aligned_realloc: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([block, size, alignment])=>
                alignedResize(block >>> 0, size >>> 0, alignment >>> 0, 0),
        },
        _aligned_offset_realloc: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([block, size, alignment, offset])=>
                alignedResize(block >>> 0, size >>> 0, alignment >>> 0, offset >>> 0),
        },

        /** void _aligned_free(void *block) -- NULL does nothing. */
        _aligned_free: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                if ((block >>> 0) !== 0)
                {
                    host.free(alignedBase(block >>> 0));
                }
                return 0;
            },
        },

        /**
         * int _set_sbh_threshold(size_t size) and size_t _get_sbh_threshold(void)
         *
         * The size below which the old runtime took a block from its
         * small-block heap: kept rounded up to sixteen, up to 1016 -- past it
         * the call fails with 0 -- and zero for none. Every block here comes
         * from one heap, so the number is only kept.
         */
        _set_sbh_threshold: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([size])=>{
                if ((size >>> 0) > SBH_MAX)
                {
                    return 0;
                }
                sbhThreshold = Math.ceil((size >>> 0) / SBH_STEP) * SBH_STEP;
                return 1;
            },
        },
        _get_sbh_threshold: { convention: 'cdecl', argBytes: 0, handler: ()=>sbhThreshold },

        ...host.heapHandle ? {
            /** intptr_t _get_heap_handle(void) -- the runtime's own heap, not the process's. */
            _get_heap_handle: {
                convention: 'cdecl',
                argBytes: 0,
                handler: ()=>/** @type {() => number} */ (host.heapHandle)(),
            },
        } : {},

        // The C++ operators, by their decorated names, because that is what a
        // compiled object actually imports. Failure is a null return: this
        // runtime has no way to throw std::bad_alloc into guest code, and code
        // built against the older runtime checked for null anyway.
        '??2@YAPAXI@Z': newAllocator,   // operator new(unsigned int)
        '??_U@YAPAXI@Z': newAllocator,  // operator new[](unsigned int)
        '??3@YAXPAX@Z': deallocator, // operator delete(void *)
        '??_V@YAXPAX@Z': deallocator, // operator delete[](void *)

        /**
         * _PNH _set_new_handler(_PNH handler), by its C++ name, and
         * _PNH _query_new_handler(void). Zero is no handler.
         */
        '?_set_new_handler@@YAP6AHI@ZP6AHI@Z@Z': setNewHandler,
        '?_query_new_handler@@YAP6AHI@ZXZ': {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>newHandler,
        },

        /**
         * int _set_new_mode(int mode) and int _query_new_mode(void): with 1,
         * a failed malloc calls the new handler as operator new does. Only 0
         * and 1 are modes; anything else is -1 and EINVAL, the mode kept.
         */
        '?_set_new_mode@@YAHH@Z': {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([mode])=>{
                if ((mode >>> 0) > 1)
                {
                    host.errno?.(EINVAL);
                    return -1;
                }
                const previous = newMode;
                newMode = mode >>> 0;
                return previous;
            },
        },
        '?_query_new_mode@@YAHXZ': {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>newMode,
        },

        /**
         * int _callnewh(size_t size)
         *
         * The new handler called once for `size`: 1 when it answered that it
         * freed something, 0 when it did not or there is none.
         */
        _callnewh: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([size])=>(newHandler === 0 || !host.callGuest
                ? 0
                : host.callGuest(newHandler, [size >>> 0], host.currentThread?.())
                    .then(answer=>((answer | 0) === 0 ? 0 : 1))),
        },
    };
    return table;
}

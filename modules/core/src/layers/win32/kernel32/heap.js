/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The kernel32 memory surface: the heap and the virtual allocator.
 *
 * The bookkeeping lives here, on the host side, and never in guest memory. A
 * program that overruns a buffer overwrites its own neighbour -- which is what
 * would happen on Windows -- instead of rewriting a block header and taking the
 * allocator down with it; and a corrupted heap is the kind of failure that is
 * discovered a million instructions after its cause.
 *
 * Where the arena comes from is not this file's decision: the caller hands over
 * a byte range out of the address space the memory layer already accounts for.
 * Inventing an address here would put memory on the map that nothing else knows
 * about.
 */

/** Flags the guest passes; the rest of HeapAlloc's flags do not change behaviour here. */
const HEAP_ZERO_MEMORY = 0x00000008;
const HEAP_REALLOC_IN_PLACE_ONLY = 0x00000010;

const MEM_COMMIT = 0x00001000;
const MEM_DECOMMIT = 0x00004000;
const MEM_RELEASE = 0x00008000;

/** What HeapSize returns when it cannot answer: (SIZE_T)-1. */
const INVALID_SIZE = 0xffffffff;

/** Every block starts on an 8-byte boundary, which is what malloc guarantees. */
const ALIGNMENT = 8;

const PAGE_SIZE = 4096;

/** Marks the blocks VirtualAlloc handed out, so HeapFree cannot reach them. */
const VIRTUAL = Symbol('virtual');

/** @param {number} value @param {number} to */
const roundUp = (value, to)=>Math.ceil(value / to) * to;

/**
 * @typedef {Object} HeapBlock
 * @property {number} address
 * @property {number} size       What the guest asked for; what HeapSize reports.
 * @property {number} capacity   What was actually taken from the arena.
 * @property {any} owner         The heap handle, or the VirtualAlloc marker.
 */

/**
 * A first-fit allocator over one byte range.
 *
 * Free space is a list of spans kept in address order and never adjacent, so
 * two blocks freed side by side become one span and a later request the size of
 * both still fits. First fit rather than best fit: it is the cheaper scan, and
 * the fragmentation difference between the two only starts to matter at
 * lifetimes far longer than a process.
 *
 * @param {{ base: number, size: number }} arena
 */
export function createHeapAllocator({ base, size }){
    /** @type {{ base: number, size: number }[]} */
    const spans = [{ base, size }];
    /** @type {Map<number, HeapBlock>} */
    const live = new Map();

    /** @param {{ base: number, size: number }} span */
    const release = span=>{
        let at = spans.findIndex(candidate=>candidate.base > span.base);
        if (at < 0)
        {
            at = spans.length;
        }
        spans.splice(at, 0, span);

        const previous = spans[at - 1];
        if (previous && previous.base + previous.size === span.base)
        {
            previous.size += span.size;
            spans.splice(at, 1);
            at--;
        }
        const merged = spans[at];
        const next = spans[at + 1];
        if (next && merged.base + merged.size === next.base)
        {
            merged.size += next.size;
            spans.splice(at + 1, 1);
        }
    };

    return {
        /**
         * @param {number} bytes
         * @param {Object} [options]
         * @param {number} [options.alignment]
         * @param {any} [options.owner]
         * @returns {number} the address, or 0 when nothing fits
         */
        allocate(bytes, { alignment = ALIGNMENT, owner = null } = {}){
            // A zero-byte request still yields a distinct pointer, because a
            // program compares it against NULL to decide whether it failed.
            const capacity = Math.max(ALIGNMENT, roundUp(bytes, ALIGNMENT));

            for (let i = 0; i < spans.length; i++)
            {
                const span = spans[i];
                const start = roundUp(span.base, alignment);
                const end = start + capacity;
                if (end > span.base + span.size)
                {
                    continue;
                }

                /** @type {{ base: number, size: number }[]} */
                const remainder = [];
                if (start > span.base)
                {
                    remainder.push({ base: span.base, size: start - span.base });
                }
                if (end < span.base + span.size)
                {
                    remainder.push({ base: end, size: span.base + span.size - end });
                }
                spans.splice(i, 1, ...remainder);

                live.set(start, { address: start, size: bytes, capacity, owner });
                return start;
            }
            return 0;
        },

        /**
         * @param {number} address
         * @returns {boolean} false when the address is not the start of a live block
         */
        free(address){
            const block = live.get(address);
            if (!block)
            {
                return false;
            }
            live.delete(address);
            release({ base: block.address, size: block.capacity });
            return true;
        },

        /** @param {number} address @returns {HeapBlock | null} */
        block: address=>live.get(address) ?? null,

        /**
         * Adjusts a block's reported size without moving it. Only what was
         * already reserved is available: growing into the neighbouring free span
         * would make the allocator's answer depend on what happens to sit next
         * to the block, which is exactly the kind of nondeterminism that makes a
         * heap bug unreproducible.
         *
         * @param {number} address @param {number} bytes
         * @returns {boolean} whether the block could stay where it is
         */
        resize(address, bytes){
            const block = live.get(address);
            if (!block || bytes > block.capacity)
            {
                return false;
            }
            block.size = bytes;
            return true;
        },

        /** @param {any} owner @returns {number[]} */
        owned(owner){
            return [...live.values()]
                .filter(block=>block.owner === owner)
                .map(block=>block.address);
        },

        diagnostics(){
            let used = 0;
            for (const block of live.values())
            {
                used += block.capacity;
            }
            return {
                blocks: live.size,
                used,
                free: spans.reduce((total, span)=>total + span.size, 0),
                // A large free total next to a small largest span is
                // fragmentation, and it is the reason an allocation fails while
                // the heap looks half empty.
                largestFree: spans.reduce((largest, span)=>Math.max(largest, span.size), 0),
            };
        },
    };
}

/**
 * @typedef {Object} HeapHost
 * @property {{ base: number, size: number }} arena   Guest bytes to allocate out of.
 * @property {any} [allocator]  An allocator over that arena, when one is shared.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * All of these are stdcall, which is the bridge's default, so none of them says
 * so. `argBytes` is the size of the argument list the guest compiled against.
 *
 * Every heap shares the one arena and a heap handle is an ownership tag over
 * it: HeapCreate's sizes are advisory even on Windows (a private heap grows),
 * and honouring them by carving the arena would only produce failures Windows
 * would not have. What the tag buys is the part programs do observe --
 * HeapDestroy releasing exactly its own blocks, and a pointer freed against the
 * wrong heap failing.
 *
 * @param {HeapHost} host
 */
export function createHeapFunctions(host){
    // One allocator for the whole arena, whoever asks. The caller may bring its
    // own so that everything guest memory is handed out from -- the heap, a DIB
    // section, COM task memory -- comes from the same free list rather than from
    // arenas carved up in advance into sizes nobody can predict.
    const allocator = host.allocator ?? createHeapAllocator(host.arena);

    /** Handles are opaque to the guest: only ever compared, never dereferenced. */
    let nextHeap = 4;
    const newHandle = ()=>{
        nextHeap += 4;
        return nextHeap;
    };

    const processHeap = newHandle();
    const heaps = new Set([processHeap]);

    /** @param {number} address @param {number} length */
    const zero = (address, length)=>{
        if (length > 0)
        {
            host.writeMemory(address, new Uint8Array(length));
        }
    };

    /**
     * The block at `address`, but only if it belongs to `heap`. Windows leaves
     * a cross-heap free undefined; refusing it turns a bug that would otherwise
     * surface as unrelated corruption into a FALSE the caller can see.
     *
     * @param {number} heap @param {number} address
     */
    const blockOf = (heap, address)=>{
        const block = allocator.block(address);
        return block && block.owner === heap ? block : null;
    };

    return {
        /** HANDLE GetProcessHeap(VOID) */
        GetProcessHeap: {
            argBytes: 0,
            handler: ()=>processHeap,
        },

        /** HANDLE HeapCreate(DWORD flOptions, SIZE_T dwInitialSize, SIZE_T dwMaximumSize) */
        HeapCreate: {
            argBytes: 12,
            handler: ()=>{
                const heap = newHandle();
                heaps.add(heap);
                return heap;
            },
        },

        /** BOOL HeapDestroy(HANDLE hHeap) */
        HeapDestroy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const heap = handle >>> 0;
                // Destroying the process heap takes the CRT's own allocations
                // with it, so Windows documents it as forbidden rather than
                // supported-but-fatal.
                if (heap === processHeap || !heaps.has(heap))
                {
                    return 0;
                }
                for (const address of allocator.owned(heap))
                {
                    allocator.free(address);
                }
                heaps.delete(heap);
                return 1;
            },
        },

        /** LPVOID HeapAlloc(HANDLE hHeap, DWORD dwFlags, SIZE_T dwBytes) */
        HeapAlloc: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, flags, bytes])=>{
                const heap = handle >>> 0;
                if (!heaps.has(heap))
                {
                    return 0;
                }
                const size = bytes >>> 0;
                const address = allocator.allocate(size, { owner: heap });
                // Out of memory is a NULL, not an exception: the guest tests the
                // pointer, and a throw here would take down a program that was
                // prepared to handle the failure.
                if (address === 0)
                {
                    return 0;
                }
                if (flags & HEAP_ZERO_MEMORY)
                {
                    zero(address, size);
                }
                return address;
            },
        },

        /** LPVOID HeapReAlloc(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem, SIZE_T dwBytes) */
        HeapReAlloc: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, flags, pointer, bytes])=>{
                const heap = handle >>> 0;
                const address = pointer >>> 0;
                const wanted = bytes >>> 0;
                const block = blockOf(heap, address);
                if (!block)
                {
                    return 0;
                }

                const previous = block.size;
                if (allocator.resize(address, wanted))
                {
                    if ((flags & HEAP_ZERO_MEMORY) && wanted > previous)
                    {
                        zero(address + previous, wanted - previous);
                    }
                    return address;
                }
                if (flags & HEAP_REALLOC_IN_PLACE_ONLY)
                {
                    return 0;
                }

                const moved = allocator.allocate(wanted, { owner: heap });
                // On failure the original block stays exactly as it was: callers
                // written as `p = realloc(p, n)` leak on failure, but callers
                // written correctly still own their data.
                if (moved === 0)
                {
                    return 0;
                }
                const kept = Math.min(previous, wanted);
                host.writeMemory(moved, host.readMemory(address, kept).slice());
                if ((flags & HEAP_ZERO_MEMORY) && wanted > kept)
                {
                    zero(moved + kept, wanted - kept);
                }
                allocator.free(address);
                return moved;
            },
        },

        /** BOOL HeapFree(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem) */
        HeapFree: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, , pointer])=>{
                const address = pointer >>> 0;
                // free(NULL) is a no-op in C and CRT wrappers pass it straight
                // through, so answering TRUE keeps those wrappers honest.
                if (address === 0)
                {
                    return 1;
                }
                if (!blockOf(handle >>> 0, address))
                {
                    return 0;
                }
                return allocator.free(address) ? 1 : 0;
            },
        },

        /** SIZE_T HeapSize(HANDLE hHeap, DWORD dwFlags, LPCVOID lpMem) */
        HeapSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, , pointer])=>{
                const block = blockOf(handle >>> 0, pointer >>> 0);
                // The requested size, not the rounded one: a program that copies
                // HeapSize bytes out of a block would otherwise read whatever
                // padding follows it.
                return block ? block.size : INVALID_SIZE;
            },
        },

        /** LPVOID VirtualAlloc(LPVOID lpAddress, SIZE_T dwSize, DWORD flAllocationType, DWORD) */
        VirtualAlloc: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pointer, bytes, type])=>{
                const size = bytes >>> 0;
                if (size === 0)
                {
                    return 0;
                }
                const requested = pointer >>> 0;
                const rounded = roundUp(size, PAGE_SIZE);

                let address;
                if (requested !== 0)
                {
                    // Reserve-then-commit is a common two-step, so committing
                    // inside something we already handed out succeeds. An
                    // address we never gave out cannot be honoured: this
                    // allocator places memory, it does not map it.
                    const existing = allocator.block(requested);
                    if (!existing || existing.owner !== VIRTUAL || existing.capacity < rounded)
                    {
                        return 0;
                    }
                    address = requested;
                }
                else
                {
                    address = allocator.allocate(rounded,
                        { alignment: PAGE_SIZE, owner: VIRTUAL });
                    if (address === 0)
                    {
                        return 0;
                    }
                }

                if (type & MEM_COMMIT)
                {
                    zero(address, rounded);
                }
                return address;
            },
        },

        /** BOOL VirtualFree(LPVOID lpAddress, SIZE_T dwSize, DWORD dwFreeType) */
        VirtualFree: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, bytes, type])=>{
                const address = pointer >>> 0;
                const block = allocator.block(address);
                if (!block || block.owner !== VIRTUAL)
                {
                    return 0;
                }
                if (type & MEM_RELEASE)
                {
                    // Documented: MEM_RELEASE frees the whole reservation and
                    // dwSize must be zero.
                    return bytes === 0 && allocator.free(address) ? 1 : 0;
                }
                // Decommit keeps the reservation. Page-level commit state is not
                // modelled, so the memory stays readable -- observably identical
                // except for the fault a program would have to be provoking on
                // purpose to notice.
                return (type & MEM_DECOMMIT) ? 1 : 0;
            },
        },
    };
}

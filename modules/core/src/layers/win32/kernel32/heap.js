/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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

/** GlobalAlloc's spelling of the same request. */
const GMEM_MOVEABLE = 0x00000002;
const GMEM_ZEROINIT = 0x00000040;
const GMEM_MODIFY = 0x00000080;
const GMEM_INVALID_HANDLE = 0x8000;
const HEAP_REALLOC_IN_PLACE_ONLY = 0x00000010;

const MEM_COMMIT = 0x00001000;
const MEM_DECOMMIT = 0x00004000;
const MEM_RELEASE = 0x00008000;

/** What HeapSize returns when it cannot answer: (SIZE_T)-1. */
const INVALID_SIZE = 0xffffffff;

/** Every block starts on an 8-byte boundary, which is what malloc guarantees. */
const ALIGNMENT = 8;

const PAGE_SIZE = 4096;

/**
 * Where a VirtualAlloc reservation may begin.
 *
 * Windows places every reservation on a 64 KiB boundary and says so through
 * GetSystemInfo, and allocators built on VirtualAlloc take it at its word: a
 * common design keeps no back-pointer in a block header at all, storing only
 * the top sixteen bits of the segment it came from and recovering the segment
 * by shifting them back. Handing out a page-aligned base breaks that
 * arithmetic -- the recovered "segment" lands in the middle of some earlier
 * allocation, and the header read from it is whatever data was there.
 */
const ALLOCATION_GRANULARITY = 64 * 1024;

/** Codes this surface reports. */
const ERROR_INVALID_PARAMETER = 87;
/** What VirtualAlloc reports for an address outside anything it reserved. */
const ERROR_INVALID_ADDRESS = 487;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_NOT_ENOUGH_MEMORY = 8;

/**
 * The one page protection this build offers.
 *
 * Nothing here enforces page permissions -- guest memory is one buffer the
 * emulator reads and writes freely -- so every page is readable, writable and
 * executable. VirtualProtect and VirtualQuery both report that rather than
 * echoing back whatever a caller asked for, because a caller that saves the old
 * protection and restores it must get something true both times.
 */
const PAGE_NOACCESS = 0x01;
const PAGE_EXECUTE_READWRITE = 0x40;

/** VirtualQuery's State and Type, beside the MEM_COMMIT already declared above. */
const MEM_FREE = 0x10000;
const MEM_PRIVATE = 0x20000;

/**
 * MEMORY_BASIC_INFORMATION, as the 32-bit guest compiled it. Seven fields, all
 * four bytes, and the order matters more than the size: a caller reads State to
 * decide whether the address is usable at all.
 */
const MEMORY_BASIC_INFORMATION = Object.freeze({
    BaseAddress: 0,
    AllocationBase: 4,
    AllocationProtect: 8,
    RegionSize: 12,
    State: 16,
    Protect: 20,
    Type: 24,
    SIZE: 28,
});

/**
 * MEMORYSTATUS. Eight DWORDs, the first of which is the structure's own size --
 * which is how the later MEMORYSTATUSEX is told apart from this one.
 */
const MEMORYSTATUS = Object.freeze({
    dwLength: 0,
    dwMemoryLoad: 4,
    dwTotalPhys: 8,
    dwAvailPhys: 12,
    dwTotalPageFile: 16,
    dwAvailPageFile: 20,
    dwTotalVirtual: 24,
    dwAvailVirtual: 28,
    SIZE: 32,
});

/**
 * MEMORYSTATUSEX. The same eight figures widened to 64 bits, plus one that is
 * always zero; the caller fills in dwLength before asking, and a size that is
 * not this one is refused, as Windows refuses it.
 */
const MEMORYSTATUSEX = Object.freeze({
    dwLength: 0,
    dwMemoryLoad: 4,
    ullTotalPhys: 8,
    ullAvailPhys: 16,
    ullTotalPageFile: 24,
    ullAvailPageFile: 32,
    ullTotalVirtual: 40,
    ullAvailVirtual: 48,
    ullAvailExtendedVirtual: 56,
    SIZE: 64,
});

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
 * @property {boolean} fresh
 *     Whether every byte of it comes from arena the allocator had never handed
 *     out before. Guest memory begins zero and only the guest writes into it,
 *     so fresh memory reads as zeroes already; recycled memory holds whatever
 *     its previous owner left, and a caller promising zeroes has to clear it.
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
 * @param {{ base: number, size: number }} arena  Memory nothing has written yet.
 */
export function createHeapAllocator({ base, size }){
    /** @type {{ base: number, size: number }[]} */
    const spans = [{ base, size }];
    /** @type {Map<number, HeapBlock>} */
    const live = new Map();
    /**
     * The first address in the arena that has never been inside a block.
     *
     * Above it the arena is untouched, and untouched arena is zero: nothing but
     * the guest writes there, and the guest can only write where it was given
     * memory. That is what lets a caller who has to hand over zeroes skip the
     * memset -- the cost real Windows never pays either, because there a
     * committed page is a promise the first touch collects on.
     */
    let handedTo = base;

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

                const fresh = start >= handedTo;
                handedTo = Math.max(handedTo, end);
                live.set(start, { address: start, size: bytes, capacity, owner, fresh });
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
         * The live block an address falls inside, rather than the one it
         * starts. A reservation is committed a page at a time, and every page
         * after the first is an interior address of a block the allocator
         * already handed out.
         *
         * @param {number} address
         * @returns {HeapBlock | null}
         */
        blockContaining(address){
            for (const block of live.values())
            {
                if (address >= block.address && address < block.address + block.capacity)
                {
                    return block;
                }
            }
            return null;
        },

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
 * @property {(code: number) => void} setLastError
 * @property {(address: number) => { base: number, size: number } | null} [regionAt]
 *           The memory layer's region map, when the assembling caller wired one.
 *           Without it VirtualQuery reports every address as free.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a refused allocation is reported: a program that is told it
 *           has run out of memory says so in its own words and exits, and
 *           without this nothing says how much it asked for and what was left.
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

    /**
     * An allocation the arena could not serve, said with what was asked and
     * what was left, since the program will only say it ran out of memory.
     *
     * @param {string} api @param {number} size
     */
    const refused = (api, size)=>{
        const state = allocator.diagnostics();
        host.divergence?.(api, `${size} bytes refused: ${state.largestFree} largest free`
            + ` of ${state.free} free, ${state.used} used in ${state.blocks} blocks`);
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} address @param {number} length */
    const zero = (address, length)=>{
        if (length > 0)
        {
            host.writeMemory(address, new Uint8Array(length));
        }
    };

    /**
     * A block handed over as zeroes, at the price of what it actually costs.
     *
     * The observable contract is exact -- the caller reads zeroes -- but a
     * block out of arena that has never been handed out is already zero, and
     * writing a megabyte of zeroes over a megabyte of zeroes is a memset the
     * program pays for inside its own call. Windows pays nothing there either:
     * a committed page is backed and reads as zero, and the cost of making it
     * so is spread over the program's own first writes.
     *
     * Recycled memory is the case that has to be cleared, and it is the one
     * that matters: without it one allocation's data leaks into the next.
     *
     * @param {number} address @param {number} length
     */
    const zeroHandedOver = (address, length)=>{
        if (!allocator.block(address)?.fresh)
        {
            zero(address, length);
        }
    };

    /**
     * Reservations with pages the program gave back, as one range covering
     * them.
     *
     * A decommitted page is gone on Windows, and committing it again yields a
     * fresh zero-filled one. Page-level commit state is not modelled here, so
     * what is modelled is that promise: the range is noted, and cleared when
     * the program commits inside it again. Noted rather than cleared at the
     * decommit, so a program that never asks for the memory back never pays
     * for it.
     *
     * @type {Map<number, { from: number, to: number }>}
     */
    const decommitted = new Map();

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

    /**
     * A block given a new size, where it is if it fits and elsewhere if it may
     * move. The address it ends up at, or 0 with the block left exactly as it
     * was: callers written as `p = realloc(p, n)` leak on failure, but callers
     * written correctly still own their data.
     *
     * @param {{ address: number, size: number, owner: any }} block
     * @param {number} wanted
     * @param {{ zeroTail: boolean, mayMove: boolean }} how
     */
    const reallocate = (block, wanted, { zeroTail, mayMove })=>{
        const { address, size: previous } = block;
        if (allocator.resize(address, wanted))
        {
            if (zeroTail && wanted > previous)
            {
                zero(address + previous, wanted - previous);
            }
            return address;
        }
        if (!mayMove)
        {
            return 0;
        }
        const moved = allocator.allocate(wanted, { owner: block.owner });
        if (moved === 0)
        {
            return 0;
        }
        const kept = Math.min(previous, wanted);
        host.writeMemory(moved, host.readMemory(address, kept).slice());
        if (zeroTail && wanted > kept)
        {
            zero(moved + kept, wanted - kept);
        }
        allocator.free(address);
        return moved;
    };

    const table = {
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
                    refused('HeapAlloc', size);
                    return 0;
                }
                if (flags & HEAP_ZERO_MEMORY)
                {
                    zeroHandedOver(address, size);
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
                const block = blockOf(heap, address);
                if (!block)
                {
                    return 0;
                }
                return reallocate(block, bytes >>> 0, {
                    zeroTail: (flags & HEAP_ZERO_MEMORY) !== 0,
                    mayMove: (flags & HEAP_REALLOC_IN_PLACE_ONLY) === 0,
                });
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
            handler: ([pointer, bytes])=>{
                const size = bytes >>> 0;
                if (size === 0)
                {
                    return 0;
                }
                const requested = pointer >>> 0;
                const rounded = roundUp(size, PAGE_SIZE);

                if (requested !== 0)
                {
                    // Reserve-then-commit is a common two-step, and the second
                    // step names a page rather than the reservation: a program
                    // reserves a span and commits pages inside it one at a
                    // time as it grows into them, so every commit after the
                    // first arrives with an interior address. Looking the
                    // address up as the *start* of a block accepts only that
                    // first page and refuses the rest, which a program reads
                    // as having run out of memory while most of what it
                    // reserved sits untouched.
                    //
                    // An address we never gave out is still refused: this
                    // allocator places memory, it does not map it.
                    //
                    // The range committed is whole pages: from the page the
                    // address is in to the end of the page the last byte is
                    // in, as Windows rounds it.
                    const page = requested & ~(PAGE_SIZE - 1);
                    const needed = roundUp(requested + size - page, PAGE_SIZE);
                    const existing = allocator.blockContaining(requested);
                    const offset = existing ? page - existing.address : 0;
                    if (!existing || existing.owner !== VIRTUAL
                        || existing.capacity - offset < needed)
                    {
                        host.setLastError(ERROR_INVALID_ADDRESS);
                        host.divergence?.('VirtualAlloc', `commit of ${size} bytes at 0x${
                            requested.toString(16)} refused: ${existing
                            ? `the reservation at 0x${existing.address.toString(16)} holds ${
                                existing.capacity} bytes, ${existing.owner === VIRTUAL
                                ? 'virtual' : 'not virtual'}`
                            : 'no reservation there'}`);
                        return 0;
                    }
                    // Committing inside a reservation writes nothing.
                    //
                    // A page of a reservation the program has not committed
                    // yet reads as zero already -- the reservation was handed
                    // over that way below, and the program cannot have written
                    // where it had not committed -- so the zeroes Windows
                    // promises are there without anyone putting them there.
                    // What is not free is a page the program gave back: that
                    // one it did write, and Windows would hand it over fresh.
                    const given = decommitted.get(existing.address);
                    if (given)
                    {
                        const from = Math.max(page, given.from);
                        const to = Math.min(page + needed, given.to);
                        zero(from, Math.max(0, to - from));
                    }
                    // A page that is already committed keeps what the program
                    // put in it: Windows documents committing one twice as
                    // succeeding without zeroing, and an allocator that
                    // commits up to its high-water mark each time it grows
                    // does exactly that.
                    return page;
                }

                // A reservation is granted in whole allocation granules, as
                // Windows grants it: a program that reserves a size and commits
                // pages up to the granule's end is within its rights, and was
                // refused here as if it had left its reservation.
                const span = roundUp(size, ALLOCATION_GRANULARITY);
                const address = allocator.allocate(span,
                    { alignment: ALLOCATION_GRANULARITY, owner: VIRTUAL });
                if (address === 0)
                {
                    // A caller checks the return and then asks why. A zero with
                    // no code behind it leaves whatever the previous call
                    // happened to set, which is worse than useless.
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    refused('VirtualAlloc', rounded);
                    return 0;
                }
                // The whole reservation reads as zero from here on, whether
                // this call commits any of it or not, and that is what lets
                // every commit inside it above cost nothing.
                //
                // Two things want it. A commit has to yield zero-filled pages,
                // which a program relies on. And a page the program reserved
                // but has not committed reads as whatever was there before --
                // on Windows touching it faults, here it yields old bytes, and
                // a stale value that happens to look like a pointer is read as
                // one, then dereferenced far from anything that would explain
                // where it came from. Reading zero where Windows would fault is
                // the more forgiving of the two wrong answers, and the only one
                // that cannot be mistaken for data.
                //
                // Arena that was never handed out is zero already; only what
                // something else finished with costs a write.
                decommitted.delete(address);
                zeroHandedOver(address, span);
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
                    if (bytes !== 0 || !allocator.free(address))
                    {
                        return 0;
                    }
                    decommitted.delete(address);
                    return 1;
                }
                if ((type & MEM_DECOMMIT) === 0)
                {
                    return 0;
                }
                // Decommit keeps the reservation. Page-level commit state is not
                // modelled, so the memory stays readable -- observably identical
                // except for the fault a program would have to be provoking on
                // purpose to notice. What is remembered is the range, because a
                // commit of it later has to read as zeroes: Windows took those
                // pages away and gives back new ones.
                const span = bytes >>> 0;
                const to = address + (span === 0
                    ? block.capacity
                    : Math.min(roundUp(span, PAGE_SIZE), block.capacity));
                const given = decommitted.get(address);
                decommitted.set(address, given
                    ? { from: Math.min(given.from, address), to: Math.max(given.to, to) }
                    : { from: address, to });
                return 1;
            },
        },

        /**
         * HGLOBAL GlobalAlloc(UINT uFlags, SIZE_T dwBytes)
         *
         * The 16-bit inheritance: a moveable allocation was a handle that had to
         * be locked into a pointer, and a fixed one was already a pointer. Win32
         * kept both spellings and made them the same thing, so the handle a
         * program locks is the pointer it gets back, and GlobalLock is identity.
         * Programs still write the lock/unlock pairs, and they still have to
         * balance -- so they are answered, they are simply not moving anything.
         */
        GlobalAlloc: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags, bytes])=>{
                const size = bytes >>> 0;
                const address = allocator.allocate(size === 0 ? 1 : size);
                if (address === 0)
                {
                    return 0;
                }
                if (flags & GMEM_ZEROINIT)
                {
                    zeroHandedOver(address, size);
                }
                return address;
            },
        },

        /**
         * HGLOBAL GlobalReAlloc(HGLOBAL hMem, SIZE_T dwBytes, UINT uFlags)
         *
         * A fixed block stays put unless the caller allowed it to move, which
         * is what GMEM_MOVEABLE means on this call; GMEM_MODIFY changes only
         * attributes, and there are none here to change.
         */
        GlobalReAlloc: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, bytes, flags])=>{
                const block = allocator.block(handle >>> 0);
                if (!block)
                {
                    return 0;
                }
                if (flags & GMEM_MODIFY)
                {
                    return handle >>> 0;
                }
                return reallocate(block, bytes >>> 0, {
                    zeroTail: (flags & GMEM_ZEROINIT) !== 0,
                    mayMove: (flags & GMEM_MOVEABLE) !== 0,
                });
            },
        },

        /**
         * UINT GlobalFlags(HGLOBAL hMem)
         *
         * Nothing here is discardable or moveable and nothing is locked, so a
         * live block has no flags and no lock count; a handle that is not a
         * block is GMEM_INVALID_HANDLE.
         */
        GlobalFlags: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>allocator.block(handle >>> 0) ? 0 : GMEM_INVALID_HANDLE,
        },

        /** HGLOBAL GlobalFree(HGLOBAL hMem) */
        GlobalFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const address = handle >>> 0;
                // Windows returns NULL on success and the handle back on failure,
                // which is the opposite of almost everything else in this file.
                return allocator.free(address) ? 0 : address;
            },
        },

        /** LPVOID GlobalLock(HGLOBAL hMem) */
        GlobalLock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>allocator.block(handle >>> 0) ? handle >>> 0 : 0,
        },

        /**
         * BOOL GlobalUnlock(HGLOBAL hMem)
         *
         * Nothing is locked, so the count never reaches zero and this reports
         * "still locked" -- which is what Windows reports for a fixed block, and
         * what a caller of a fixed allocation therefore already handles.
         */
        GlobalUnlock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>allocator.block(handle >>> 0) ? 1 : 0,
        },

        /** SIZE_T GlobalSize(HGLOBAL hMem) */
        GlobalSize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>allocator.block(handle >>> 0)?.size ?? 0,
        },

        /**
         * HLOCAL LocalAlloc(UINT uFlags, SIZE_T uBytes)
         *
         * The other spelling of the same heap: LMEM_ZEROINIT is GMEM_ZEROINIT's
         * value, and a block one family allocates the other may free.
         */
        LocalAlloc: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags, bytes])=>{
                const size = bytes >>> 0;
                const address = allocator.allocate(size === 0 ? 1 : size);
                if (address !== 0 && (flags & GMEM_ZEROINIT))
                {
                    zeroHandedOver(address, size);
                }
                return address;
            },
        },

        /** HLOCAL LocalFree(HLOCAL hMem) */
        LocalFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const address = handle >>> 0;
                return allocator.free(address) ? 0 : address;
            },
        },
        /**
         * HGLOBAL GlobalHandle(LPCVOID pMem)
         *
         * A handle and a pointer are the same number here, because every block
         * this allocator hands out is fixed -- there is no moveable memory to
         * indirect through. The call still has to check the pointer: its whole
         * purpose is to turn a pointer a caller is unsure about into a handle or
         * a failure.
         */
        GlobalHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>allocator.block(address >>> 0) ? address >>> 0 : 0,
        },

        /**
         * DWORD GetProcessHeaps(DWORD NumberOfHeaps, PHANDLE ProcessHeaps)
         *
         * Reports how many there are whatever room the caller offered, which is
         * the two-call protocol: asked with room for none, it answers with the
         * count so the caller can allocate and ask again.
         */
        GetProcessHeaps: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([count, buffer])=>{
                const all = [...heaps];
                if (buffer !== 0 && (count >>> 0) >= all.length)
                {
                    const data = new Uint8Array(all.length * 4);
                    const view = new DataView(data.buffer);
                    all.forEach((heap, at)=>view.setUint32(at * 4, heap, true));
                    host.writeMemory(buffer >>> 0, data);
                }
                return all.length;
            },
        },

        /**
         * BOOL HeapLock(HANDLE hHeap)
         *
         * A heap is serialised against other threads on Windows and a caller
         * takes the lock to walk it without anything changing underneath. Guest
         * threads here are switched by the scheduler and never inside a host
         * call, so a walk cannot be interrupted and the lock has nothing to
         * exclude. The handle is still checked, because a caller that locked the
         * wrong heap wants to know.
         */
        HeapLock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>heaps.has(handle >>> 0) ? 1 : 0,
        },

        /** BOOL HeapUnlock(HANDLE hHeap) */
        HeapUnlock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>heaps.has(handle >>> 0) ? 1 : 0,
        },

        /**
         * BOOL HeapValidate(HANDLE hHeap, DWORD dwFlags, LPCVOID lpMem)
         *
         * With a pointer, whether that block belongs to that heap; without one,
         * whether the heap exists. Both are real answers rather than a constant
         * yes -- a debug runtime calls this after every allocation and treats a
         * no as corruption, so answering yes for a block that was freed would
         * hide exactly what it is looking for.
         */
        HeapValidate: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, , address])=>{
                const heap = handle >>> 0;
                if (!heaps.has(heap))
                {
                    return 0;
                }
                return address === 0 ? 1 : (blockOf(heap, address >>> 0) ? 1 : 0);
            },
        },

        /**
         * SIZE_T HeapCompact(HANDLE hHeap, DWORD dwFlags)
         *
         * Returns the largest free span. The allocator coalesces on free, so
         * there is never anything to compact and the number is simply measured.
         * Zero would mean the heap is full, which it is not.
         */
        HeapCompact: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!heaps.has(handle >>> 0))
                {
                    return 0;
                }
                return allocator.diagnostics().largestFree;
            },
        },

        /**
         * BOOL HeapWalk(HANDLE hHeap, LPPROCESS_HEAP_ENTRY lpEntry)
         *
         * Not implemented, and it says so with the code that ends a walk. A
         * caller loops until this returns FALSE and then checks the error; told
         * there are no more items it stops cleanly, where any other failure
         * would have it report a corrupt heap.
         */
        HeapWalk: {
            argBytes: 8,
            handler: ()=>{
                host.setLastError(ERROR_NO_MORE_ITEMS);
                return 0;
            },
        },

        /**
         * BOOL VirtualProtect(LPVOID lpAddress, SIZE_T dwSize, DWORD flNewProtect,
         *                     PDWORD lpflOldProtect)
         *
         * Reports the previous protection and changes nothing, because there is
         * nothing to change: this build does not enforce page protection, so
         * every page is already readable, writable and executable and every
         * request a caller makes is already satisfied. A runtime making its
         * generated code executable gets what it asked for.
         *
         * The old protection is not invented -- it is what this build actually
         * offers -- and lpflOldProtect must be written, because a caller that
         * puts the protection back afterwards reads it from there.
         */
        VirtualProtect: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([address, size, , oldProtect])=>{
                if (address === 0 || (size >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (oldProtect !== 0)
                {
                    writeDword(oldProtect >>> 0, PAGE_EXECUTE_READWRITE);
                }
                return 1;
            },
        },

        /**
         * BOOL FlushInstructionCache(HANDLE hProcess, LPCVOID lpBaseAddress,
         *                            SIZE_T dwSize)
         *
         * Nothing to do and it must still succeed. A program that has just
         * written code -- a runtime, a patched import, a copy-protection
         * trampoline -- calls this before jumping into it, and treats failure as
         * a reason not to jump. The processor here notices a written code page
         * on its own, so the request is already satisfied by the time it arrives.
         */
        FlushInstructionCache: {
            argBytes: 12,
            handler: ()=>1,
        },

        /**
         * SIZE_T VirtualQuery(LPCVOID lpAddress, PMEMORY_BASIC_INFORMATION lpBuffer,
         *                     SIZE_T dwLength)
         *
         * Answered from the memory layer's own region map when the assembling
         * caller supplied one, so that what is reported mapped is what actually
         * is. A build without it answers that the address is free, which is the
         * honest form of not knowing -- inventing a committed region would have
         * a caller write into memory nothing backs.
         */
        VirtualQuery: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([address, buffer, length])=>{
                if (buffer === 0 || (length >>> 0) < MEMORY_BASIC_INFORMATION.SIZE)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const at = address >>> 0;
                const region = host.regionAt ? host.regionAt(at) : null;
                const data = new Uint8Array(MEMORY_BASIC_INFORMATION.SIZE);
                const view = new DataView(data.buffer);
                view.setUint32(MEMORY_BASIC_INFORMATION.BaseAddress, at, true);
                if (region)
                {
                    view.setUint32(MEMORY_BASIC_INFORMATION.AllocationBase,
                        region.base, true);
                    view.setUint32(MEMORY_BASIC_INFORMATION.AllocationProtect,
                        PAGE_EXECUTE_READWRITE, true);
                    view.setUint32(MEMORY_BASIC_INFORMATION.RegionSize,
                        region.base + region.size - at, true);
                    view.setUint32(MEMORY_BASIC_INFORMATION.State, MEM_COMMIT, true);
                    view.setUint32(MEMORY_BASIC_INFORMATION.Protect,
                        PAGE_EXECUTE_READWRITE, true);
                    view.setUint32(MEMORY_BASIC_INFORMATION.Type, MEM_PRIVATE, true);
                }
                else
                {
                    view.setUint32(MEMORY_BASIC_INFORMATION.RegionSize, PAGE_SIZE, true);
                    view.setUint32(MEMORY_BASIC_INFORMATION.State, MEM_FREE, true);
                    view.setUint32(MEMORY_BASIC_INFORMATION.Protect, PAGE_NOACCESS, true);
                }
                host.writeMemory(buffer >>> 0, data);
                return MEMORY_BASIC_INFORMATION.SIZE;
            },
        },

        /**
         * BOOL VirtualLock(LPVOID lpAddress, SIZE_T dwSize)
         *
         * Locking pages into the working set is a promise about paging, and
         * there is no paging here -- guest memory is one buffer that is always
         * present. The promise therefore already holds.
         */
        VirtualLock: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, size])=>address !== 0 && (size >>> 0) !== 0 ? 1 : 0,
        },

        /** BOOL VirtualUnlock(LPVOID lpAddress, SIZE_T dwSize) */
        VirtualUnlock: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, size])=>address !== 0 && (size >>> 0) !== 0 ? 1 : 0,
        },

        /**
         * VOID GlobalMemoryStatus(LPMEMORYSTATUS lpBuffer)
         *
         * What the arena actually holds, not a number chosen to look generous. A
         * program sizes a cache from this, and one told about memory that is not
         * there allocates until it fails.
         *
         * dwLength is written back because the structure is versioned by its own
         * size and a caller checks it.
         */
        GlobalMemoryStatus: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                if (buffer === 0)
                {
                    return 0;
                }
                const free = allocator.diagnostics().free;
                const total = host.arena.size;
                const data = new Uint8Array(MEMORYSTATUS.SIZE);
                const view = new DataView(data.buffer);
                view.setUint32(MEMORYSTATUS.dwLength, MEMORYSTATUS.SIZE, true);
                view.setUint32(MEMORYSTATUS.dwMemoryLoad,
                    total === 0 ? 0 : Math.round((total - free) / total * 100), true);
                view.setUint32(MEMORYSTATUS.dwTotalPhys, total, true);
                view.setUint32(MEMORYSTATUS.dwAvailPhys, free, true);
                // No page file, so the virtual figures are the physical ones --
                // which is what a machine with paging turned off reports.
                view.setUint32(MEMORYSTATUS.dwTotalPageFile, total, true);
                view.setUint32(MEMORYSTATUS.dwAvailPageFile, free, true);
                view.setUint32(MEMORYSTATUS.dwTotalVirtual, total, true);
                view.setUint32(MEMORYSTATUS.dwAvailVirtual, free, true);
                host.writeMemory(buffer >>> 0, data);
                return 0;
            },
        },

        /** BOOL GlobalMemoryStatusEx(LPMEMORYSTATUSEX lpBuffer) */
        GlobalMemoryStatusEx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                const header = buffer === 0 ? null : host.readMemory(buffer >>> 0, 4);
                const length = header === null
                    ? 0
                    : new DataView(header.buffer, header.byteOffset, 4).getUint32(0, true);
                if (length !== MEMORYSTATUSEX.SIZE)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const free = allocator.diagnostics().free;
                const total = host.arena.size;
                const data = new Uint8Array(MEMORYSTATUSEX.SIZE);
                const view = new DataView(data.buffer);
                view.setUint32(MEMORYSTATUSEX.dwLength, MEMORYSTATUSEX.SIZE, true);
                view.setUint32(MEMORYSTATUSEX.dwMemoryLoad,
                    total === 0 ? 0 : Math.round((total - free) / total * 100), true);
                view.setBigUint64(MEMORYSTATUSEX.ullTotalPhys, BigInt(total), true);
                view.setBigUint64(MEMORYSTATUSEX.ullAvailPhys, BigInt(free), true);
                view.setBigUint64(MEMORYSTATUSEX.ullTotalPageFile, BigInt(total), true);
                view.setBigUint64(MEMORYSTATUSEX.ullAvailPageFile, BigInt(free), true);
                view.setBigUint64(MEMORYSTATUSEX.ullTotalVirtual, BigInt(total), true);
                view.setBigUint64(MEMORYSTATUSEX.ullAvailVirtual, BigInt(free), true);
                host.writeMemory(buffer >>> 0, data);
                return 1;
            },
        },
    };

    // The rest of the local family is the global one under another name: the
    // same heap, the same handles, the same flag values.
    return {
        ...table,
        LocalReAlloc: table.GlobalReAlloc,
        LocalLock: table.GlobalLock,
        LocalUnlock: table.GlobalUnlock,
        LocalSize: table.GlobalSize,
        LocalHandle: table.GlobalHandle,
    };
}

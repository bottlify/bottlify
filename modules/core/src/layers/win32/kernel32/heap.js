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

import { askChild } from './cross-process.js';
import {
    globalAllocCode, globalFreeCode, heapAllocCode, heapFreeCode, heapReAllocCode, heapSizeCode,
} from './guest-heap.js';
import {
    bindLong, globalAllocLongCode, globalFreeLongCode, heapAllocLongCode, heapFreeLongCode,
    heapReAllocLongCode, heapSizeLongCode,
} from './guest-heap-long.js';

/** Flags the guest passes; the rest of HeapAlloc's flags do not change behaviour here. */
const HEAP_ZERO_MEMORY = 0x00000008;

/** GlobalAlloc's spelling of the same request. */
const GMEM_MOVEABLE = 0x00000002;
const GMEM_ZEROINIT = 0x00000040;
const GMEM_MODIFY = 0x00000080;
const GMEM_INVALID_HANDLE = 0x8000;
const HEAP_REALLOC_IN_PLACE_ONLY = 0x00000010;

const MEM_COMMIT = 0x00001000;
const MEM_RESERVE = 0x00002000;
const MEM_DECOMMIT = 0x00004000;
const MEM_RELEASE = 0x00008000;
const MEM_RESET = 0x00080000;
const MEM_WRITE_WATCH = 0x00200000;
/** GetWriteWatch's one flag: start the watch over once the pages are told. */
const WRITE_WATCH_FLAG_RESET = 0x1;

/**
 * Every VirtualAlloc type bit accepted. MEM_TOP_DOWN asks for the highest
 * address that fits, a hint whose absence nothing observes; MEM_WRITE_WATCH
 * makes a reservation GetWriteWatch answers for. MEM_RESET_UNDO, MEM_PHYSICAL
 * and MEM_LARGE_PAGES promise what this arena cannot, and fall outside.
 */
const ALLOCATION_TYPES = MEM_COMMIT | MEM_RESERVE | MEM_RESET | 0x00100000 | MEM_WRITE_WATCH;

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

/** HeapCreate's option that leaves a heap unserialised. */
const HEAP_NO_SERIALIZE = 0x00000001;

/** The HEAP_INFORMATION_CLASS values, and the one compatibility value there is. */
const HEAP_COMPATIBILITY_INFORMATION = 0;
const HEAP_ENABLE_TERMINATION_ON_CORRUPTION = 1;
const LOW_FRAGMENTATION_HEAP = 2;

/** Codes this surface reports. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_HANDLE = 6;
const ERROR_GEN_FAILURE = 31;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NOACCESS = 998;
/** What VirtualAlloc reports for an address outside anything it reserved. */
const ERROR_INVALID_ADDRESS = 487;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_NOT_ENOUGH_MEMORY = 8;

/** The pseudo-handle for the running process, the one process the Ex forms reach. */
const CURRENT_PROCESS = 0xffffffff;

/** HEAP_SUMMARY: its own size, then what is allocated, committed, reserved and may be. */
const HEAP_SUMMARY_SIZE = 20;

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
 * VirtualQuery's Type for a mapped executable image. The CRT's SEH handler
 * (_ValidateEH3RN) asks VirtualQuery about a frame's scope table and trusts it
 * only inside an image, whose headers it then reads from AllocationBase.
 */
const MEM_IMAGE = 0x1000000;

/**
 * `lpMaximumApplicationAddress`: where 32-bit user address space ends. A free
 * gap that nothing maps above runs to here, not to `0xffffffff` -- the top
 * 64 KiB before the 2 GiB boundary is reserved and never handed out.
 */
const USER_ADDRESS_SPACE_TOP = 0x7fff0000;

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

/**
 * PROCESS_MEMORY_COUNTERS(_EX): cb, the page-fault count, then SIZE_T figures
 * -- peak and current working set, four pool quotas, current and peak page
 * file use and, in the Ex form, the private bytes.
 */
const PROCESS_MEMORY_COUNTERS = Object.freeze({
    cb: 0,
    PageFaultCount: 4,
    PeakWorkingSetSize: 8,
    WorkingSetSize: 12,
    PagefileUsage: 32,
    PeakPagefileUsage: 36,
    PrivateUsage: 40,
    SIZE: 40,
    SIZE_EX: 44,
});

const ERROR_BAD_LENGTH = 24;

/**
 * PERFORMANCE_INFORMATION: thirteen counters after cb, the memory ones in
 * pages and the last three plain counts.
 */
const PERFORMANCE_INFORMATION = Object.freeze({
    cb: 0, CommitTotal: 4, CommitLimit: 8, CommitPeak: 12, PhysicalTotal: 16,
    PhysicalAvailable: 20, SystemCache: 24, KernelTotal: 28, KernelPaged: 32,
    KernelNonpaged: 36, PageSize: 40, HandleCount: 44, ProcessCount: 48, ThreadCount: 52,
    SIZE: 56,
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
 * @typedef {Object} FreeSpan
 * @property {number} base
 * @property {number} size
 * @property {number} bin   Which size class holds it.
 * @property {number} at    Its index in that class, so it can be removed without a search.
 */

/**
 * The size classes free spans are kept in.
 *
 * Class zero holds what is too small to hand out at all -- the slivers a
 * coarser alignment leaves in front of a block, kept only so they can
 * coalesce. Then one class per multiple of eight up to a kilobyte, which is
 * where nearly every allocation a program makes lands, so a request of that
 * size is answered from spans of exactly its class. Above that, one class
 * per power of two.
 */
const SMALL_CLASSES = 128;
const SMALL_LIMIT = SMALL_CLASSES * ALIGNMENT;
const BINS = SMALL_CLASSES + 32;

/** How many null entries the address maps carry before they are rebuilt. */
const STALE_LIMIT = 65536;

/** @param {number} size */
const binOf = size=>(size < SMALL_LIMIT
    ? size >>> 3
    : SMALL_CLASSES + (31 - Math.clz32(size)) - (31 - Math.clz32(SMALL_LIMIT)));

/**
 * What VirtualQuery answers for an arena page no reservation holds: free to
 * the end of the free run it begins (a whole page of it), or the heap's own
 * blocks up to the next page that is a reservation's or wholly free. Read off
 * the blocks in address order on either side of the page, where it walked
 * every free span and every block -- a hundred microseconds a call.
 *
 * @param {ReturnType<typeof createHeapAllocator>} allocator
 * @param {number} page @param {number} arenaBase @param {number} arenaEnd
 * @param {(block: HeapBlock) => boolean} isReservation
 * @returns {{ free: boolean, end: number }}
 */
export function arenaRegion(allocator, page, arenaBase, arenaEnd, isReservation){
    const before = allocator.blockAtOrBefore(page);
    let gapStart = before ? before.address + before.capacity : arenaBase;
    const blocks = allocator.blocksAbove(page);
    let next = blocks.next();
    const gapEnd = next.done ? arenaEnd : next.value.address;
    if (gapStart <= page && gapEnd >= page + PAGE_SIZE)
    {
        return { free: true, end: (gapEnd & ~(PAGE_SIZE - 1)) >>> 0 };
    }
    for (; !next.done; next = blocks.next())
    {
        const block = next.value;
        const first = roundUp(gapStart, PAGE_SIZE);
        if (first > page && first + PAGE_SIZE <= block.address)
        {
            return { free: false, end: first };
        }
        if (isReservation(block))
        {
            return { free: false, end: block.address };
        }
        gapStart = block.address + block.capacity;
    }
    const first = roundUp(gapStart, PAGE_SIZE);
    return { free: false, end: first > page && first + PAGE_SIZE <= arenaEnd ? first : arenaEnd };
}

/** The blocks of a run of the address index (`createAddressIndex`) before it is split. */
const ADDRESS_RUN = 512;

/**
 * Blocks in address order, kept as sorted runs: placing or freeing one moves
 * the blocks of its run alone, and the block at or below an address is two
 * binary searches away.
 */
export function createAddressIndex(){
    /** @type {HeapBlock[][]} */
    const runs = [];
    /** The last run whose first block starts at or below `address`, or -1. @param {number} address */
    const runOf = address=>{
        let low = 0;
        let high = runs.length;
        while (low < high)
        {
            const mid = (low + high) >>> 1;
            if (runs[mid][0].address <= address)
            {
                low = mid + 1;
            }
            else
            {
                high = mid;
            }
        }
        return low - 1;
    };
    /** The first block of `run` starting above `address`. @param {HeapBlock[]} run @param {number} address */
    const after = (run, address)=>{
        let low = 0;
        let high = run.length;
        while (low < high)
        {
            const mid = (low + high) >>> 1;
            if (run[mid].address <= address)
            {
                low = mid + 1;
            }
            else
            {
                high = mid;
            }
        }
        return low;
    };
    return {
        /** @param {HeapBlock} block */
        insert(block){
            if (runs.length === 0)
            {
                runs.push([block]);
                return;
            }
            const at = Math.max(runOf(block.address), 0);
            const run = runs[at];
            run.splice(after(run, block.address), 0, block);
            if (run.length > ADDRESS_RUN * 2)
            {
                runs.splice(at + 1, 0, run.splice(ADDRESS_RUN));
            }
        },
        /** @param {number} address */
        remove(address){
            const at = runOf(address);
            if (at < 0)
            {
                return;
            }
            const run = runs[at];
            const index = after(run, address) - 1;
            if (index >= 0 && run[index].address === address)
            {
                run.splice(index, 1);
                if (run.length === 0)
                {
                    runs.splice(at, 1);
                }
            }
        },
        /** @param {number} address @returns {HeapBlock | undefined} */
        atOrBefore(address){
            const at = runOf(address);
            if (at < 0)
            {
                return undefined;
            }
            const run = runs[at];
            return run[after(run, address) - 1];
        },
        /** The blocks starting above `address`, in order. @param {number} address */
        *above(address){
            let at = runOf(address);
            let index = 0;
            if (at < 0)
            {
                at = 0;
            }
            else
            {
                index = after(runs[at], address);
            }
            for (; at < runs.length; at++, index = 0)
            {
                const run = runs[at];
                for (; index < run.length; index++)
                {
                    yield run[index];
                }
            }
        },
    };
}

/**
 * An allocator over one byte range.
 *
 * Free space is kept in size classes -- a stack of spans per class, taken
 * last in first out -- and coalesced through two maps that find a span by
 * where it ends and where it begins, so a block freed between two free
 * neighbours becomes one span with them and a later request the size of all
 * three still fits. Every step is a lookup or a push: a free list walked in
 * address order cost a walk over every span per call, and a program that had
 * loaded a level had thousands, which made an allocation of sixteen bytes
 * the most expensive thing it did.
 *
 * Deterministic: the same sequence of requests yields the same addresses,
 * which is what makes a heap bug reproducible.
 *
 * @param {{ base: number, size: number }} arena  Memory nothing has written yet.
 */
export function createHeapAllocator({ base, size }){
    /** @type {FreeSpan[][]} */
    const bins = Array.from({ length: BINS }, ()=>[]);
    // Three maps by address, and none of them is ever deleted from: an entry
    // that goes away is set to null and stays. Deleting a key from a large
    // map and setting it again -- which is what freeing a block and handing
    // the same address out again does, and what a program does all day --
    // cost tens of microseconds a time in the engine underneath, growing
    // with the map, where writing over a key that is there costs nothing.
    // The maps are rebuilt without their nulls once those outnumber the
    // entries, so a long run does not keep every address it ever used.
    /** @type {Map<number, FreeSpan | null>} */
    let byBase = new Map();
    /** @type {Map<number, FreeSpan | null>} */
    let byEnd = new Map();
    /** @type {Map<number, HeapBlock | null>} */
    let live = new Map();
    let stale = 0;
    // The live blocks by address, for the block an interior address falls in:
    // VirtualAlloc's commit, VirtualQuery, VirtualProtect and VirtualFree each
    // ask, and a walk over every block (and every null left behind) cost 50 to
    // 100 microseconds a call in a title with thousands of reservations. In
    // runs of at most twice ADDRESS_RUN blocks: one sorted array moved every
    // block above the one placed or freed, and a title with a quarter of a
    // million live blocks spent half its engine thread in those moves.
    const byAddress = createAddressIndex();
    /** @param {HeapBlock} block */
    const placed = block=>{
        live.set(block.address, block);
        byAddress.insert(block);
    };
    let liveBlocks = 0;
    let liveSpans = 0;
    /**
     * @template T
     * @param {Map<number, T | null>} map
     * @returns {Map<number, T | null>}
     */
    const compacted = map=>{
        /** @type {Map<number, T | null>} */
        const kept = new Map();
        for (const [key, value] of map)
        {
            if (value !== null)
            {
                kept.set(key, value);
            }
        }
        return kept;
    };
    const forget = ()=>{
        stale++;
        if (stale >= STALE_LIMIT && stale > liveBlocks + 2 * liveSpans)
        {
            byBase = compacted(byBase);
            byEnd = compacted(byEnd);
            live = compacted(live);
            stale = 0;
        }
    };
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

    /** @param {number} spanBase @param {number} spanSize */
    const insert = (spanBase, spanSize)=>{
        const bin = binOf(spanSize);
        const span = { base: spanBase, size: spanSize, bin, at: bins[bin].length };
        bins[bin].push(span);
        byBase.set(spanBase, span);
        byEnd.set(spanBase + spanSize, span);
        liveSpans++;
    };

    /** @param {FreeSpan} span */
    const remove = span=>{
        const bin = bins[span.bin];
        const last = /** @type {FreeSpan} */ (bin.pop());
        if (last !== span)
        {
            bin[span.at] = last;
            last.at = span.at;
        }
        byBase.set(span.base, null);
        byEnd.set(span.base + span.size, null);
        liveSpans--;
        forget();
    };

    /**
     * A span at least `need` bytes long, or null.
     *
     * The smallest class that can hold it is looked at first, and the classes
     * above it in turn. A class above a kilobyte holds spans of more than one
     * size, so the class the request falls in is searched for one that fits;
     * every class above it fits without looking.
     *
     * @param {number} need
     * @returns {FreeSpan | null}
     */
    const fit = need=>{
        let bin = binOf(need);
        if (need >= SMALL_LIMIT)
        {
            const candidates = bins[bin];
            for (let i = candidates.length - 1; i >= 0; i--)
            {
                if (candidates[i].size >= need)
                {
                    return candidates[i];
                }
            }
            bin++;
        }
        for (; bin < BINS; bin++)
        {
            const candidates = bins[bin];
            if (candidates.length > 0)
            {
                return candidates[candidates.length - 1];
            }
        }
        return null;
    };

    if (size > 0)
    {
        insert(base, size);
    }

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
            if (capacity > size)
            {
                return 0;
            }
            // Room for the padding a coarser alignment may need in front: a
            // span begins on an eight-byte boundary, so at most this much.
            const span = fit(capacity + (alignment > ALIGNMENT ? alignment - ALIGNMENT : 0));
            if (span === null)
            {
                return 0;
            }
            const start = roundUp(span.base, alignment);
            const end = start + capacity;
            const spanEnd = span.base + span.size;
            remove(span);
            if (start > span.base)
            {
                insert(span.base, start - span.base);
            }
            if (end < spanEnd)
            {
                insert(end, spanEnd - end);
            }

            const fresh = start >= handedTo;
            handedTo = Math.max(handedTo, end);
            placed({ address: start, size: bytes, capacity, owner, fresh });
            liveBlocks++;
            return start;
        },

        /**
         * A block at exactly `address`, when the whole of it is free.
         *
         * What a program asks for when it names where its reservation goes: a
         * loader placing an image at its preferred base, a runtime rebuilding
         * a heap at the address a saved pointer expects. Unlike `allocate`
         * there is no choosing, so there is no bin to look in -- only the one
         * free span that could hold it, found by walking them.
         *
         * @param {number} address
         * @param {number} bytes
         * @param {Object} [options]
         * @param {any} [options.owner]
         * @returns {boolean} false when any of the range is taken or outside the arena
         */
        allocateAt(address, bytes, { owner = null } = {}){
            const capacity = Math.max(ALIGNMENT, roundUp(bytes, ALIGNMENT));
            const start = address >>> 0;
            const end = start + capacity;
            if (start % ALIGNMENT !== 0 || start < base || end > base + size)
            {
                return false;
            }
            let span = null;
            for (const candidate of byBase.values())
            {
                if (candidate && candidate.base <= start && candidate.base + candidate.size >= end)
                {
                    span = candidate;
                    break;
                }
            }
            if (span === null)
            {
                return false;
            }
            const spanEnd = span.base + span.size;
            remove(span);
            if (start > span.base)
            {
                insert(span.base, start - span.base);
            }
            if (end < spanEnd)
            {
                insert(end, spanEnd - end);
            }
            const fresh = start >= handedTo;
            handedTo = Math.max(handedTo, end);
            placed({ address: start, size: bytes, capacity, owner, fresh });
            liveBlocks++;
            return true;
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
            live.set(address, null);
            byAddress.remove(address);
            liveBlocks--;
            forget();
            let spanBase = block.address;
            let spanEnd = block.address + block.capacity;
            const before = byEnd.get(spanBase);
            if (before)
            {
                remove(before);
                spanBase = before.base;
            }
            const after = byBase.get(spanEnd);
            if (after)
            {
                remove(after);
                spanEnd = after.base + after.size;
            }
            insert(spanBase, spanEnd - spanBase);
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
            const block = byAddress.atOrBefore(address);
            return block !== undefined && address < block.address + block.capacity ? block : null;
        },

        /**
         * The last live block starting at or below an address, or null.
         *
         * @param {number} address
         * @returns {HeapBlock | null}
         */
        blockAtOrBefore: address=>byAddress.atOrBefore(address) ?? null,

        /**
         * The live blocks starting above an address, in address order.
         *
         * @param {number} address
         * @returns {Generator<HeapBlock>}
         */
        *blocksAbove(address){
            yield* byAddress.above(address);
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

        /** @returns {{ base: number, size: number }[]} every free span */
        freeSpans(){
            /** @type {{ base: number, size: number }[]} */
            const spans = [];
            for (const span of byBase.values())
            {
                if (span)
                {
                    spans.push({ base: span.base, size: span.size });
                }
            }
            return spans;
        },

        /** @param {any} owner @returns {number[]} */
        owned(owner){
            return [...live.values()]
                .filter(block=>block !== null && block.owner === owner)
                .map(block=>(/** @type {HeapBlock} */ (block)).address);
        },

        /**
         * The first arena address never inside a block: above it the arena is
         * as untouched as it was given, which a caller handing the memory to
         * another process trusts to know what it has to zero.
         */
        handedTo: ()=>handedTo,

        diagnostics(){
            let used = 0;
            for (const block of live.values())
            {
                used += block ? block.capacity : 0;
            }
            let free = 0;
            let largestFree = 0;
            for (const span of byBase.values())
            {
                free += span ? span.size : 0;
                largestFree = Math.max(largestFree, span ? span.size : 0);
            }
            // A large free total next to a small largest span is
            // fragmentation, and it is the reason an allocation fails while
            // the heap looks half empty.
            return { blocks: liveBlocks, used, free, largestFree };
        },
    };
}

/**
 * @typedef {Object} HeapHost
 * @property {{ base: number, size: number }} arena   Guest bytes to allocate out of.
 * @property {any} [allocator]  An allocator over that arena, when one is shared.
 * @property {() => { processes: number, threads: number }} [systemCounts]
 *     The processes and threads running, for GetPerformanceInfo.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, value: number, length: number) => void} fillMemory
 *           Sets a range to one byte value in the guest's own memory. Separate
 *           from writeMemory because the ranges here are whole heap blocks:
 *           a buffer holding the pattern would be allocated, zeroed and copied
 *           inside the program's own call, for bytes that can be filled once.
 * @property {(code: number) => void} setLastError
 * @property {(handle: number) => any} [childOf]  The child process a handle names, or null.
 * @property {import('./cross-process.js').AskHost['askChild']} [askChild]
 *           A call made in a child where it runs; absent, no child is reached.
 * @property {() => any} [currentThread]
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 * @property {(address: number) => { base: number, size: number, kind?: string } | null} [regionAt]
 *           The memory layer's region map, when the assembling caller wired one.
 *           A region of kind `image` is answered as MEM_IMAGE.
 *           Without it VirtualQuery knows only the arena.
 * @property {(address: number) => { base: number, size: number } | null} [nextRegionAfter]
 *           The mapped region with the lowest base above an address, when the
 *           assembling caller wired one. VirtualQuery uses it to coalesce a
 *           free gap into one answer instead of one page; without it a free
 *           gap is reported as running to the top of user address space.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a refused allocation is reported: a program that is told it
 *           has run out of memory says so in its own words and exits, and
 *           without this nothing says how much it asked for and what was left.
 * @property {ReturnType<typeof import('./guest-heap.js').createGuestHeap>} [guestHeap]
 *           The small blocks the guest allocates and frees itself
 *           (`guest-heap.js`), with `allocator` its `wrap()`: a heap is then its
 *           control block, and HeapAlloc, HeapFree, HeapSize and HeapReAlloc are
 *           guest code that falls back to the handlers here.
 * @property {(bytes: number) => number} [allocateCode]  Pages of their own for
 *           that code (`code-arena.js`).
 * @property {(address: number, length: number, open: boolean) => boolean} [pageAccess]
 *           Opens or closes pages to the program (the memory layer's `pageAccess`):
 *           a reservation's pages not committed, and those protected
 *           PAGE_NOACCESS, fault on any access, as on Windows. False where the
 *           processor does not fault a read, and then every page reads.
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
    /** The most the arena has had handed out at any GetProcessMemoryInfo. */
    let peakUsed = 0;

    /** Handles are opaque to the guest: only ever compared, never dereferenced. */
    let nextHeap = 4;
    const newHandle = ()=>{
        nextHeap += 4;
        return nextHeap;
    };

    const guestHeap = host.guestHeap ?? null;
    // A heap is its control block where the guest keeps its small blocks, and
    // a number of the host's own where the arena had no room for one.
    const makeHeap = ()=>guestHeap?.createHeap() || newHandle();

    const processHeap = makeHeap();
    const heaps = new Set([processHeap]);
    /** Heaps made with HEAP_NO_SERIALIZE, which cannot take the low-fragmentation heap. */
    const unserialized = new Set();
    /** Heaps the program turned the low-fragmentation heap on for. */
    const lowFragmentation = new Set();

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

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
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
            host.fillMemory(address, 0, length);
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
     * Reservations with pages the program gave back, as the ranges it gave.
     *
     * A decommitted page is gone on Windows, and committing it again yields a
     * fresh zero-filled one. Page-level commit state is not modelled here, so
     * what is modelled is that promise: the ranges are noted, and cleared when
     * the program commits inside them again. Noted rather than cleared at the
     * decommit, so a program that never asks for the memory back never pays
     * for it. Kept apart rather than as one range around them all, because a
     * page between two that were given back is still committed, and committing
     * it again must leave what the program put there.
     *
     * @type {Map<number, { from: number, to: number }[]>}
     */
    const decommitted = new Map();

    /**
     * The pages of each reservation that are committed, as ordered ranges
     * that never touch. Page-level commit changes nothing about what the
     * guest can read here, but VirtualQuery reports it: an allocator asks
     * which pages of its reservation it has committed before it commits more.
     *
     * @type {Map<number, { from: number, to: number }[]>}
     */
    const committed = new Map();

    /**
     * The pages of each reservation protected PAGE_NOACCESS, committed or not:
     * a commit with that protection, or VirtualProtect to it.
     *
     * @type {Map<number, Set<number>>}
     */
    const unreadable = new Map();

    /**
     * Opens what of [from, to) of a reservation the program may touch -- its
     * committed pages not protected PAGE_NOACCESS -- and closes the rest, where
     * the processor faults a closed page (`pageAccess`).
     *
     * @param {number} reservation @param {number} from @param {number} to
     */
    const settleAccess = (reservation, from, to)=>{
        if (!host.pageAccess?.(from, 0, false) || to <= from)
        {
            return;
        }
        host.pageAccess(from, to - from, false);
        for (const range of committed.get(reservation) ?? [])
        {
            const start = Math.max(range.from, from);
            const end = Math.min(range.to, to);
            if (start < end)
            {
                host.pageAccess(start, end - start, true);
            }
        }
        for (const page of unreadable.get(reservation) ?? [])
        {
            if (page >= from && page < to)
            {
                host.pageAccess(page, PAGE_SIZE, false);
            }
        }
    };

    /**
     * Notes the protection [from, to) of a reservation was given: PAGE_NOACCESS
     * closes the pages, anything else leaves them to their commit.
     *
     * @param {number} reservation @param {number} from @param {number} to
     * @param {number} protection
     */
    const noteProtection = (reservation, from, to, protection)=>{
        let pages = unreadable.get(reservation);
        if ((protection & 0xff) === PAGE_NOACCESS)
        {
            if (!pages)
            {
                pages = new Set();
                unreadable.set(reservation, pages);
            }
            for (let page = from; page < to; page += PAGE_SIZE)
            {
                pages.add(page);
            }
            return;
        }
        if (!pages)
        {
            return;
        }
        for (let page = from; page < to; page += PAGE_SIZE)
        {
            pages.delete(page);
        }
    };

    /** The reservations made with MEM_WRITE_WATCH, by base. */
    const watched = new Set();

    /**
     * The watched reservation a range lies wholly inside, or null.
     *
     * @param {number} address @param {number} size
     */
    const watchedRegion = (address, size)=>{
        const block = size === 0 ? null : allocator.blockContaining(address);
        return block && block.owner === VIRTUAL && watched.has(block.address)
            && address + size <= block.address + block.capacity ? block : null;
    };

    /**
     * Marks [from, to) of a reservation committed or not.
     *
     * @param {number} reservation @param {number} from @param {number} to
     * @param {boolean} on
     */
    const markCommitted = (reservation, from, to, on)=>{
        /** @type {{ from: number, to: number }[]} */
        const kept = [];
        let start = from;
        let end = to;
        for (const range of committed.get(reservation) ?? [])
        {
            if (range.to < from || range.from > to)
            {
                kept.push(range);
                continue;
            }
            if (on)
            {
                start = Math.min(start, range.from);
                end = Math.max(end, range.to);
                continue;
            }
            if (range.from < from)
            {
                kept.push({ from: range.from, to: from });
            }
            if (range.to > to)
            {
                kept.push({ from: to, to: range.to });
            }
        }
        if (on)
        {
            kept.push({ from: start, to: end });
        }
        committed.set(reservation, kept.sort((a, b)=>a.from - b.from));
    };

    /**
     * Notes [from, to) of a reservation as given back.
     *
     * @param {number} reservation @param {number} from @param {number} to
     */
    const giveBack = (reservation, from, to)=>{
        let merged = { from, to };
        const kept = [];
        for (const range of decommitted.get(reservation) ?? [])
        {
            if (range.to < merged.from || range.from > merged.to)
            {
                kept.push(range);
            }
            else
            {
                merged = {
                    from: Math.min(range.from, merged.from), to: Math.max(range.to, merged.to),
                };
            }
        }
        kept.push(merged);
        decommitted.set(reservation, kept);
    };

    /**
     * Commits [from, to) of a reservation: whatever of it was given back is
     * zeroed and is no longer noted, and the rest is left as it is.
     *
     * @param {number} reservation @param {number} from @param {number} to
     */
    const takeBack = (reservation, from, to)=>{
        const given = decommitted.get(reservation);
        if (!given)
        {
            return;
        }
        const kept = [];
        for (const range of given)
        {
            const start = Math.max(range.from, from);
            const end = Math.min(range.to, to);
            if (start >= end)
            {
                kept.push(range);
                continue;
            }
            zero(start, end - start);
            if (range.from < start)
            {
                kept.push({ from: range.from, to: start });
            }
            if (end < range.to)
            {
                kept.push({ from: end, to: range.to });
            }
        }
        if (kept.length > 0)
        {
            decommitted.set(reservation, kept);
        }
        else
        {
            decommitted.delete(reservation);
        }
    };

    /**
     * What VirtualQuery says about a page of the arena, as its seven fields in
     * order: base, allocation base, allocation protection, size, state,
     * protection, type.
     *
     * @param {number} page @param {number} arenaEnd
     * @returns {[number, number, number, number, number, number, number]}
     */
    const arenaAnswer = (page, arenaEnd)=>{
        const block = allocator.blockContaining(page);
        if (block && block.owner === VIRTUAL)
        {
            const end = block.address + block.capacity;
            const ranges = committed.get(block.address) ?? [];
            const inside = ranges.find(range=>page >= range.from && page < range.to);
            if (inside)
            {
                return [page, block.address, PAGE_EXECUTE_READWRITE,
                    Math.min(inside.to, end) - page, MEM_COMMIT, PAGE_EXECUTE_READWRITE,
                    MEM_PRIVATE];
            }
            const next = ranges.find(range=>range.from > page);
            return [page, block.address, PAGE_EXECUTE_READWRITE,
                (next ? Math.min(next.from, end) : end) - page, MEM_RESERVE, 0, MEM_PRIVATE];
        }
        const region = arenaRegion(allocator, page, host.arena.base, arenaEnd,
            one=>one.owner === VIRTUAL);
        return region.free
            ? [page, 0, 0, region.end - page, MEM_FREE, PAGE_NOACCESS, 0]
            : [page, host.arena.base, PAGE_EXECUTE_READWRITE, region.end - page, MEM_COMMIT,
                PAGE_EXECUTE_READWRITE, MEM_PRIVATE];
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

    /**
     * The guest's routines, placed once on the first bind of any of them: each
     * falls back to its export's handler through a trap of its own.
     *
     * @type {Record<'alloc' | 'free' | 'size' | 'reAlloc' | 'globalAlloc' | 'globalFree', number>
     *     | null}
     */
    let routines = null;
    /** @param {import('./sync.js').GuestBuilder} builder */
    const placedRoutines = builder=>{
        if (routines)
        {
            return routines;
        }
        const guest = /** @type {NonNullable<typeof guestHeap>} */ (guestHeap);
        const placement = guest.placement();
        /**
         * @param {string} label
         * @param {'HeapAlloc' | 'HeapFree' | 'HeapSize' | 'HeapReAlloc' | 'GlobalAlloc'
         *     | 'GlobalFree'} name
         * @param {(p: import('./guest-heap.js').Placement, at: number, trap: number)
         *     => Uint8Array} code
         */
        const place = (label, name, code)=>{
            const trap = builder.register(label, {
                argBytes: table[name].argBytes,
                /** @param {number[]} args */
                handler: args=>table[name].handler(args),
            });
            if (placement === null || !host.allocateCode)
            {
                return trap;
            }
            // Sized by a throwaway rendering: the bytes depend on where they
            // land only through the jump to the trap.
            const at = host.allocateCode(code(placement, 0, trap).length);
            host.writeMemory(at, code(placement, at, trap));
            return at;
        };
        const alloc = place('<heap-alloc>', 'HeapAlloc', heapAllocCode);
        const free = place('<heap-free>', 'HeapFree', heapFreeCode);
        routines = {
            alloc,
            free,
            size: place('<heap-size>', 'HeapSize', heapSizeCode),
            reAlloc: place('<heap-realloc>', 'HeapReAlloc', heapReAllocCode),
            // The global family over the same routines, on the process heap.
            globalAlloc: place('KERNEL32.dll!GlobalAlloc', 'GlobalAlloc',
                (_, at, trap)=>globalAllocCode(at, trap, processHeap, alloc)),
            globalFree: place('KERNEL32.dll!GlobalFree', 'GlobalFree',
                (_, at, trap)=>globalFreeCode(at, trap, processHeap, free)),
        };
        return routines;
    };
    /**
     * The same routines in x86-64 (`guest-heap-long.js`) for a 64-bit
     * process, each placed with its module by the loader: the export each
     * hands over to, and the routine over the tables' placement.
     *
     * @type {Record<'alloc' | 'free' | 'size' | 'reAlloc' | 'globalAlloc' | 'globalFree',
     *     ['HeapAlloc' | 'HeapFree' | 'HeapSize' | 'HeapReAlloc' | 'GlobalAlloc' | 'GlobalFree',
     *     (p: import('./guest-heap.js').Placement)
     *         => import('./guest-heap-long.js').LongRoutine]>}
     */
    const longRoutines = {
        alloc: ['HeapAlloc', heapAllocLongCode],
        free: ['HeapFree', heapFreeLongCode],
        size: ['HeapSize', heapSizeLongCode],
        reAlloc: ['HeapReAlloc', heapReAllocLongCode],
        globalAlloc: ['GlobalAlloc', p=>globalAllocLongCode(p, processHeap)],
        globalFree: ['GlobalFree', p=>globalFreeLongCode(p, processHeap)],
    };
    /**
     * An export's guest routine where the small blocks are the guest's, and
     * its x86-64 for a 64-bit process.
     *
     * @param {'alloc' | 'free' | 'size' | 'reAlloc' | 'globalAlloc' | 'globalFree'} which
     */
    const routine = which=>(guestHeap && host.allocateCode
        ? {
            /** @param {import('./sync.js').GuestBuilder} builder */
            guest: builder=>placedRoutines(builder)[which],
            /** @param {import('./guest-heap-long.js').LongBuilder} builder */
            long: builder=>{
                const [name, make] = longRoutines[which];
                const placement = guestHeap.placement();
                return bindLong(builder, placement === null ? null : make(placement), {
                    argBytes: table[name].argBytes,
                    /** @param {number[]} args */
                    handler: args=>table[name].handler(args),
                });
            },
        }
        : {});

    const table = {
        /** HANDLE GetProcessHeap(VOID) */
        GetProcessHeap: {
            argBytes: 0,
            handler: ()=>processHeap,
            // mov eax, fs:[0x30]; mov eax, [eax + 0x18]; ret -- PEB->ProcessHeap,
            // which the process block is written with from this handler
            code: ()=>Uint8Array.from([0x64, 0xa1, 0x30, 0, 0, 0, 0x8b, 0x40, 0x18, 0xc3]),
            // mov rax, gs:[0x60]; mov rax, [rax + 0x30]; ret -- the same at 64 bits
            long: ()=>Uint8Array.from([0x65, 0x48, 0x8b, 0x04, 0x25, 0x60, 0, 0, 0,
                0x48, 0x8b, 0x40, 0x30, 0xc3]),
        },

        /** HANDLE HeapCreate(DWORD flOptions, SIZE_T dwInitialSize, SIZE_T dwMaximumSize) */
        HeapCreate: {
            argBytes: 12,
            /** @param {number[]} [args] */
            handler: ([options] = [0])=>{
                const heap = makeHeap();
                heaps.add(heap);
                if ((options & HEAP_NO_SERIALIZE) !== 0)
                {
                    unserialized.add(heap);
                }
                return heap;
            },
        },

        /**
         * BOOL HeapSetInformation(HANDLE, HEAP_INFORMATION_CLASS, PVOID, SIZE_T)
         *
         * The low-fragmentation heap is a promise about how the heap lays out
         * small blocks, which this allocator keeps whatever it is told; what
         * is kept is the answer, since a program turns it on and later asks.
         * It cannot be turned off again, and a heap without serialisation
         * cannot have it. Ending the process on corruption is asked of no heap
         * in particular and accepted.
         */
        HeapSetInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, kind, information, length])=>{
                const heap = handle >>> 0;
                if (kind === HEAP_ENABLE_TERMINATION_ON_CORRUPTION)
                {
                    return 1;
                }
                if (kind !== HEAP_COMPATIBILITY_INFORMATION || (length >>> 0) < 4
                    || information === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (!heaps.has(heap))
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const value = readDword(information >>> 0);
                if (lowFragmentation.has(heap))
                {
                    if (value === LOW_FRAGMENTATION_HEAP)
                    {
                        return 1;
                    }
                    host.setLastError(ERROR_GEN_FAILURE);
                    return 0;
                }
                if (value === 0)
                {
                    return 1;
                }
                if (value !== LOW_FRAGMENTATION_HEAP || unserialized.has(heap))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                lowFragmentation.add(heap);
                return 1;
            },
        },

        /**
         * BOOL HeapQueryInformation(HANDLE, HEAP_INFORMATION_CLASS, PVOID,
         *                           SIZE_T, PSIZE_T ReturnLength)
         */
        HeapQueryInformation: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, kind, information, length, returned])=>{
                const heap = handle >>> 0;
                if (!heaps.has(heap))
                {
                    host.setLastError(ERROR_NOACCESS);
                    return 0;
                }
                if (kind !== HEAP_COMPATIBILITY_INFORMATION)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (returned !== 0)
                {
                    writeDword(returned >>> 0, 4);
                }
                if ((length >>> 0) < 4 || information === 0)
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                writeDword(information >>> 0,
                    lowFragmentation.has(heap) ? LOW_FRAGMENTATION_HEAP : 0);
                return 1;
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
                guestHeap?.destroyHeap(heap);
                for (const address of allocator.owned(heap))
                {
                    allocator.free(address);
                }
                heaps.delete(heap);
                unserialized.delete(heap);
                lowFragmentation.delete(heap);
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
            ...routine('alloc'),
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
            ...routine('reAlloc'),
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
            ...routine('free'),
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
            ...routine('size'),
        },

        /**
         * LPVOID VirtualAlloc(LPVOID lpAddress, SIZE_T dwSize, DWORD flAllocationType,
         *                     DWORD flProtect)
         *
         * What the call does is the allocation type's to say, and the address
         * only says where: MEM_RESERVE at an address places a reservation
         * there, MEM_COMMIT alone commits pages of one already made, and
         * MEM_RESET marks committed pages as holding nothing worth keeping. A
         * type naming none of those, or MEM_RESET with either of the others,
         * is refused, as Windows refuses it.
         */
        VirtualAlloc: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pointer, bytes, type, protect])=>{
                const kind = type >>> 0;
                const size = bytes >>> 0;
                const requested = pointer >>> 0;
                const protection = protect >>> 0;
                const acting = kind & (MEM_COMMIT | MEM_RESERVE | MEM_RESET);
                if ((kind & ~ALLOCATION_TYPES) !== 0 || acting === 0
                    || ((kind & MEM_RESET) !== 0 && acting !== MEM_RESET) || size === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const rounded = roundUp(size, PAGE_SIZE);

                if (requested !== 0 && (kind & MEM_RESERVE) !== 0)
                {
                    // A reservation begins on an allocation granule, the
                    // address rounded down to one, and runs to the end of the
                    // page the last byte asked for is in. Whatever of that is
                    // already taken -- another reservation, or anything else
                    // -- refuses the whole of it: a reservation is never
                    // made around something that is in its way.
                    const start = (requested & ~(ALLOCATION_GRANULARITY - 1)) >>> 0;
                    const span = roundUp(requested + size - start, PAGE_SIZE);
                    if (!allocator.allocateAt(start, span, { owner: VIRTUAL }))
                    {
                        host.setLastError(ERROR_INVALID_ADDRESS);
                        host.divergence?.('VirtualAlloc', `reservation of ${span} bytes at 0x${
                            start.toString(16)} refused: ${allocator.blockContaining(start)
                            ?? allocator.blockContaining(start + span - 1)
                            ? 'something is already there' : 'not free in the arena'}`);
                        return 0;
                    }
                    decommitted.delete(start);
                    committed.set(start, []);
                    unreadable.delete(start);
                    // Committed with it, the whole of what was reserved: from
                    // the granule's start, which is the address answered, not
                    // from the page asked for -- a program writes from the
                    // base it was handed (Wine's virtual_alloc maps the one
                    // range both ways).
                    if ((kind & MEM_COMMIT) !== 0)
                    {
                        markCommitted(start, start, start + span, true);
                        noteProtection(start, start, start + span, protection);
                    }
                    if ((kind & MEM_WRITE_WATCH) !== 0)
                    {
                        watched.add(start);
                    }
                    zeroHandedOver(start, span);
                    settleAccess(start, start, start + span);
                    return start;
                }

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
                    // An address inside no reservation is refused: there is
                    // nothing there to commit.
                    //
                    // The range is whole pages: from the page the address is
                    // in to the end of the page the last byte is in, as
                    // Windows rounds it.
                    const page = requested & ~(PAGE_SIZE - 1);
                    const needed = roundUp(requested + size - page, PAGE_SIZE);
                    const existing = allocator.blockContaining(requested);
                    const offset = existing ? page - existing.address : 0;
                    if (!existing || existing.owner !== VIRTUAL
                        || existing.capacity - offset < needed)
                    {
                        host.setLastError(ERROR_INVALID_ADDRESS);
                        host.divergence?.('VirtualAlloc', `${acting === MEM_RESET
                            ? 'reset' : 'commit'} of ${size} bytes at 0x${
                            requested.toString(16)} refused: ${existing
                            ? `the reservation at 0x${existing.address.toString(16)} holds ${
                                existing.capacity} bytes, ${existing.owner === VIRTUAL
                                ? 'virtual' : 'not virtual'}`
                            : 'no reservation there'}`);
                        return 0;
                    }
                    if (acting === MEM_RESET)
                    {
                        // The pages keep whatever they hold: MEM_RESET lets the
                        // system throw the contents away instead of paging them
                        // out, and says they are undefined afterwards, not
                        // zero. With no paging there is nothing to spare.
                        return page;
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
                    //
                    // A page that is already committed keeps what the program
                    // put in it: Windows documents committing one twice as
                    // succeeding without zeroing, and an allocator that
                    // commits up to its high-water mark each time it grows
                    // does exactly that.
                    takeBack(existing.address, page, page + needed);
                    markCommitted(existing.address, page, page + needed, true);
                    noteProtection(existing.address, page, page + needed, protection);
                    settleAccess(existing.address, page, page + needed);
                    return page;
                }

                if (acting === MEM_RESET)
                {
                    // Resetting needs pages to reset.
                    host.setLastError(ERROR_INVALID_ADDRESS);
                    return 0;
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
                // where it came from. Where the processor faults a closed page
                // (`settleAccess`) the pages not committed fault as on Windows --
                // a program that commits a page in its own handler when it is
                // touched depends on it; elsewhere they read zero, the more
                // forgiving of the two wrong answers.
                //
                // Arena that was never handed out is zero already; only what
                // something else finished with costs a write.
                decommitted.delete(address);
                committed.set(address, []);
                unreadable.delete(address);
                if ((kind & MEM_COMMIT) !== 0)
                {
                    markCommitted(address, address, address + rounded, true);
                    noteProtection(address, address, address + rounded, protection);
                }
                if ((kind & MEM_WRITE_WATCH) !== 0)
                {
                    watched.add(address);
                }
                zeroHandedOver(address, span);
                settleAccess(address, address, address + span);
                return address;
            },
        },

        /**
         * BOOL VirtualFree(LPVOID lpAddress, SIZE_T dwSize, DWORD dwFreeType)
         *
         * Exactly one of MEM_DECOMMIT and MEM_RELEASE. A release names the
         * reservation by its base and frees all of it, so it takes no size; a
         * decommit names pages anywhere inside one. Each failure says why
         * through the last error: an address that is not a reservation's is
         * ERROR_INVALID_ADDRESS, a malformed request ERROR_INVALID_PARAMETER.
         */
        VirtualFree: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, bytes, type])=>{
                const address = pointer >>> 0;
                const kind = type >>> 0;
                const size = bytes >>> 0;
                if (kind !== MEM_DECOMMIT && kind !== MEM_RELEASE)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const block = allocator.blockContaining(address);
                if (!block || block.owner !== VIRTUAL)
                {
                    host.setLastError(ERROR_INVALID_ADDRESS);
                    return 0;
                }
                const end = block.address + block.capacity;
                if (kind === MEM_RELEASE)
                {
                    if (size !== 0)
                    {
                        host.setLastError(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    if (address !== block.address)
                    {
                        host.setLastError(ERROR_INVALID_ADDRESS);
                        return 0;
                    }
                    // Back to the arena, whose next owner -- a heap, another
                    // reservation -- finds it open.
                    host.pageAccess?.(address, end - address, true);
                    allocator.free(address);
                    decommitted.delete(address);
                    committed.delete(address);
                    unreadable.delete(address);
                    watched.delete(address);
                    return 1;
                }
                // Decommit keeps the reservation and closes the pages where the
                // processor faults a closed one (`settleAccess`). What is
                // remembered is the range, because a commit of it later has to
                // read as zeroes: Windows took those pages away and gives back
                // new ones.
                //
                // No size is the whole reservation, and only from its base: a
                // page inside it with no size is refused and nothing is taken
                // (Wine's NtFreeVirtualMemory, STATUS_FREE_VM_NOT_AT_BASE).
                // World of Warcraft's allocator decommits its pages one by one
                // and then names the first of them with no size; taken as the
                // rest of the reservation, that closed the MPQ hash table it
                // had just read beside them.
                const page = (address & ~(PAGE_SIZE - 1)) >>> 0;
                if (size === 0 && page !== block.address)
                {
                    host.setLastError(ERROR_INVALID_ADDRESS);
                    return 0;
                }
                const to = size === 0 ? end : roundUp(address + size, PAGE_SIZE);
                if (to > end)
                {
                    host.setLastError(ERROR_INVALID_ADDRESS);
                    return 0;
                }
                giveBack(block.address, Math.max(page, block.address), to);
                markCommitted(block.address, Math.max(page, block.address), to, false);
                settleAccess(block.address, Math.max(page, block.address), to);
                return 1;
            },
        },

        /**
         * UINT GetWriteWatch(DWORD dwFlags, PVOID lpBaseAddress, SIZE_T dwRegionSize,
         *   PVOID *lpAddresses, ULONG_PTR *lpdwCount, LPDWORD lpdwGranularity)
         *
         * The pages of a MEM_WRITE_WATCH reservation written since the watch
         * began. Writes are not tracked, so every committed page of the range
         * is told as written: what a collector rescans is more than it must,
         * never less. A range outside a watched reservation, or no room for
         * an answer, fails with (UINT)-1.
         */
        GetWriteWatch: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([flags, base, bytes, addresses, count, granularity])=>{
                const address = base >>> 0;
                const block = watchedRegion(address, bytes >>> 0);
                if ((flags & ~WRITE_WATCH_FLAG_RESET) !== 0 || !block)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0xffffffff;
                }
                const room = (count >>> 0) === 0 ? -1 : readDword(count >>> 0);
                if (room === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0xffffffff;
                }
                if (room < 0 || (granularity >>> 0) === 0 || (addresses >>> 0) === 0)
                {
                    host.setLastError(ERROR_NOACCESS);
                    return 0xffffffff;
                }
                host.divergence?.('GetWriteWatch',
                    'writes are not tracked; every committed page is told as written');
                const end = address + (bytes >>> 0);
                /** @type {number[]} */
                const written = [];
                for (const range of committed.get(block.address) ?? [])
                {
                    let page = Math.max(range.from, address & ~(PAGE_SIZE - 1));
                    for (; page < Math.min(range.to, end) && written.length < room;
                        page += PAGE_SIZE)
                    {
                        written.push(page >>> 0);
                    }
                }
                written.forEach((page, at)=>writeDword((addresses >>> 0) + at * 4, page));
                writeDword(count >>> 0, written.length);
                writeDword(granularity >>> 0, PAGE_SIZE);
                return 0;
            },
        },

        /**
         * UINT ResetWriteWatch(LPVOID lpBaseAddress, SIZE_T dwRegionSize)
         *
         * Starts a watch over; with no writes tracked there is nothing to
         * clear, and only the range is checked.
         */
        ResetWriteWatch: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([base, bytes])=>{
                if (!watchedRegion(base >>> 0, bytes >>> 0))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0xffffffff;
                }
                return 0;
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
                // The process heap's, as on Windows NT and as the guest's
                // routine allocates it: HeapFree and HeapSize of the process
                // heap take the block too.
                const address = allocator.allocate(size === 0 ? 1 : size, { owner: processHeap });
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
            ...routine('globalAlloc'),
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
            ...routine('globalFree'),
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

        /**
         * GlobalWire and GlobalFix, GlobalUnWire and GlobalUnfix: the 16-bit
         * calls that fixed a block in low memory, which on Win32 lock and
         * unlock it -- and a block here never moves.
         *
         * LPVOID GlobalWire(HGLOBAL), VOID GlobalFix(HGLOBAL),
         * BOOL GlobalUnWire(HGLOBAL), VOID GlobalUnfix(HGLOBAL)
         */
        GlobalWire: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>allocator.block(handle >>> 0) ? handle >>> 0 : 0,
        },
        GlobalFix: {
            argBytes: 4,
            handler: ()=>0,
        },
        GlobalUnWire: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>allocator.block(handle >>> 0) ? 1 : 0,
        },
        GlobalUnfix: {
            argBytes: 4,
            handler: ()=>0,
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
                const address = allocator.allocate(size === 0 ? 1 : size, { owner: processHeap });
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
         * BOOL HeapSummary(HANDLE hHeap, DWORD dwFlags, LPHEAP_SUMMARY lpSummary)
         *
         * What the heap's live blocks add up to, as asked for, with the
         * structure's own size in its first field or ERROR_INVALID_PARAMETER.
         * The blocks sit in pages the arena already holds, so what is
         * committed and what is reserved are both the allocated figure.
         */
        HeapSummary: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, , summary])=>{
                const heap = handle >>> 0;
                if (summary === 0 || readDword(summary >>> 0) !== HEAP_SUMMARY_SIZE)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if (!heaps.has(heap))
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                let allocated = 0;
                for (const address of allocator.owned(heap))
                {
                    allocated += allocator.block(address)?.size ?? 0;
                }
                writeDword((summary >>> 0) + 4, allocated);
                writeDword((summary >>> 0) + 8, allocated);
                writeDword((summary >>> 0) + 12, allocated);
                writeDword((summary >>> 0) + 16, 0);
                return 1;
            },
        },

        /**
         * BOOL VirtualProtect(LPVOID lpAddress, SIZE_T dwSize, DWORD flNewProtect,
         *                     PDWORD lpflOldProtect)
         *
         * PAGE_NOACCESS is the one protection enforced, on a reservation's pages
         * and where the processor faults a closed page: a program that closes
         * pages to catch the touch of them gets its fault. Every other request
         * is already satisfied -- a page that is open is readable, writable and
         * executable -- so a runtime making its generated code executable gets
         * what it asked for.
         *
         * The old protection is not invented -- PAGE_NOACCESS where the first
         * page was closed, otherwise what this build offers -- and
         * lpflOldProtect must be written, because a caller that puts the
         * protection back afterwards reads it from there.
         */
        VirtualProtect: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([address, size, protect, oldProtect])=>{
                if (address === 0 || (size >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                // The old protection is not optional: Windows writes it before
                // it changes anything, and faults on nowhere to write it.
                if (oldProtect === 0)
                {
                    host.setLastError(ERROR_NOACCESS);
                    return 0;
                }
                const block = allocator.blockContaining(address >>> 0);
                const first = ((address >>> 0) & ~(PAGE_SIZE - 1)) >>> 0;
                const was = block?.owner === VIRTUAL
                    && unreadable.get(block.address)?.has(first) === true;
                writeDword(oldProtect >>> 0, was ? PAGE_NOACCESS : PAGE_EXECUTE_READWRITE);
                if (block && block.owner === VIRTUAL)
                {
                    const end = Math.min(roundUp((address >>> 0) + (size >>> 0), PAGE_SIZE),
                        block.address + block.capacity);
                    noteProtection(block.address, first, end, protect >>> 0);
                    settleAccess(block.address, first, end);
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
         * The arena is answered from the allocator, which knows what is in it:
         * a VirtualAlloc reservation as its own allocation, committed and
         * reserved page by page; free arena as free; and the heap's blocks as
         * committed memory. Anything else is answered from the memory layer's
         * region map when the assembling caller supplied one.
         *
         * Every answer covers the whole run of pages that share the state of
         * the one asked about, because a guest that walks its address space
         * with `address += RegionSize` (a crash reporter, a heap manager)
         * would otherwise step one page at a time across every gigabyte.
         *
         * Free is said only where VirtualAlloc can reserve, which is inside the
         * arena: an address nothing maps outside it is reported reserved, by
         * someone else, since a program that finds free space goes on to
         * reserve it there.
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
                if (at >= USER_ADDRESS_SPACE_TOP)
                {
                    // Windows refuses a query at or above lpMaximumApplicationAddress
                    // outright, which is what stops a walker there; answering a free
                    // region here would give it a RegionSize of 0 and no way to advance.
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const page = (at & ~(PAGE_SIZE - 1)) >>> 0;
                const arenaEnd = host.arena.base + host.arena.size;
                const inArena = page >= host.arena.base && page < arenaEnd;
                const region = inArena ? null : host.regionAt ? host.regionAt(at) : null;
                /** @type {[number, number, number, number, number, number, number]} */
                let answer;
                if (inArena)
                {
                    answer = arenaAnswer(page, arenaEnd);
                }
                else if (region && region.kind === 'image')
                {
                    answer = [page, region.base, PAGE_EXECUTE_READWRITE,
                        region.base + region.size - page, MEM_COMMIT, PAGE_EXECUTE_READWRITE,
                        MEM_IMAGE];
                }
                else if (region)
                {
                    answer = [at, region.base, PAGE_EXECUTE_READWRITE,
                        region.base + region.size - at, MEM_COMMIT, PAGE_EXECUTE_READWRITE,
                        MEM_PRIVATE];
                }
                else
                {
                    const next = host.nextRegionAfter ? host.nextRegionAfter(at) : null;
                    let limit = next ? next.base : USER_ADDRESS_SPACE_TOP;
                    if (host.arena.base > at && host.arena.base < limit)
                    {
                        limit = host.arena.base;
                    }
                    answer = [page, page, PAGE_NOACCESS, limit - page, MEM_RESERVE, 0,
                        MEM_PRIVATE];
                }
                const data = new Uint8Array(MEMORY_BASIC_INFORMATION.SIZE);
                const view = new DataView(data.buffer);
                const [base, allocationBase, allocationProtect, size, state, protect, type]
                    = answer;
                view.setUint32(MEMORY_BASIC_INFORMATION.BaseAddress, base, true);
                view.setUint32(MEMORY_BASIC_INFORMATION.AllocationBase, allocationBase, true);
                view.setUint32(MEMORY_BASIC_INFORMATION.AllocationProtect, allocationProtect,
                    true);
                view.setUint32(MEMORY_BASIC_INFORMATION.RegionSize, size, true);
                view.setUint32(MEMORY_BASIC_INFORMATION.State, state, true);
                view.setUint32(MEMORY_BASIC_INFORMATION.Protect, protect, true);
                view.setUint32(MEMORY_BASIC_INFORMATION.Type, type, true);
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
                // The commit limit: memory and the page file Windows manages
                // itself, as large as memory by default. A program refuses a
                // machine whose limit is no more than its memory -- paging
                // turned off -- and the 32-bit form stops at 4 GB, as Windows
                // clips it.
                view.setUint32(MEMORYSTATUS.dwTotalPageFile, Math.min(2 * total, 0xffffffff),
                    true);
                view.setUint32(MEMORYSTATUS.dwAvailPageFile, Math.min(free + total, 0xffffffff),
                    true);
                view.setUint32(MEMORYSTATUS.dwTotalVirtual, total, true);
                view.setUint32(MEMORYSTATUS.dwAvailVirtual, free, true);
                host.writeMemory(buffer >>> 0, data);
                return 0;
            },
        },

        /**
         * BOOL K32GetProcessMemoryInfo(HANDLE Process,
         *     PPROCESS_MEMORY_COUNTERS ppsmemCounters, DWORD cb),
         * psapi's GetProcessMemoryInfo.
         *
         * The bytes the arena has handed out are the working set, the page
         * file use and the private bytes alike: nothing is paged out or
         * shared. The peak is the most seen by any call so far. A buffer
         * smaller than the plain structure is refused with ERROR_BAD_LENGTH;
         * one large enough for the Ex form gets PrivateUsage too, and cb says
         * which form was written. The only address space is the running one.
         */
        K32GetProcessMemoryInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, buffer, cb])=>{
                if ((cb >>> 0) < PROCESS_MEMORY_COUNTERS.SIZE)
                {
                    host.setLastError(ERROR_BAD_LENGTH);
                    return 0;
                }
                if (buffer === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const size = (cb >>> 0) >= PROCESS_MEMORY_COUNTERS.SIZE_EX
                    ? PROCESS_MEMORY_COUNTERS.SIZE_EX
                    : PROCESS_MEMORY_COUNTERS.SIZE;
                const used = Math.max(0, host.arena.size - allocator.diagnostics().free);
                peakUsed = Math.max(peakUsed, used);
                const data = new Uint8Array(size);
                const view = new DataView(data.buffer);
                view.setUint32(PROCESS_MEMORY_COUNTERS.cb, size, true);
                view.setUint32(PROCESS_MEMORY_COUNTERS.PeakWorkingSetSize, peakUsed, true);
                view.setUint32(PROCESS_MEMORY_COUNTERS.WorkingSetSize, used, true);
                view.setUint32(PROCESS_MEMORY_COUNTERS.PagefileUsage, used, true);
                view.setUint32(PROCESS_MEMORY_COUNTERS.PeakPagefileUsage, peakUsed, true);
                if (size === PROCESS_MEMORY_COUNTERS.SIZE_EX)
                {
                    view.setUint32(PROCESS_MEMORY_COUNTERS.PrivateUsage, used, true);
                }
                host.writeMemory(buffer >>> 0, data);
                return 1;
            },
        },

        /**
         * BOOL K32GetPerformanceInfo(PPERFORMANCE_INFORMATION pPerformanceInformation,
         *     DWORD cb), psapi's GetPerformanceInfo.
         *
         * The arena is the machine: its size is the physical memory and the
         * commit limit, what it has handed out the commit charge. A cb other
         * than the structure's own size is ERROR_BAD_LENGTH, as Wine's psapi
         * tests find Windows answering. No kernel or cache is modelled, so
         * those read zero, and handles are not counted across the machine.
         * The process and thread counts are the kernel's when the host has
         * them, the one running process and thread otherwise.
         */
        K32GetPerformanceInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, cb])=>{
                if ((cb >>> 0) !== PERFORMANCE_INFORMATION.SIZE)
                {
                    host.setLastError(ERROR_BAD_LENGTH);
                    return 0;
                }
                if (buffer === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const used = Math.max(0, host.arena.size - allocator.diagnostics().free);
                peakUsed = Math.max(peakUsed, used);
                const pages = (/** @type {number} */ bytes)=>Math.floor(bytes / PAGE_SIZE);
                const counts = host.systemCounts?.() ?? { processes: 1, threads: 1 };
                const data = new Uint8Array(PERFORMANCE_INFORMATION.SIZE);
                const view = new DataView(data.buffer);
                const set = (/** @type {keyof typeof PERFORMANCE_INFORMATION} */ field,
                    /** @type {number} */ value)=>view.setUint32(PERFORMANCE_INFORMATION[field],
                    value >>> 0, true);
                set('cb', PERFORMANCE_INFORMATION.SIZE);
                set('CommitTotal', pages(used));
                set('CommitLimit', pages(host.arena.size));
                set('CommitPeak', pages(peakUsed));
                set('PhysicalTotal', pages(host.arena.size));
                set('PhysicalAvailable', pages(host.arena.size - used));
                set('PageSize', PAGE_SIZE);
                set('ProcessCount', counts.processes);
                set('ThreadCount', counts.threads);
                host.writeMemory(buffer >>> 0, data);
                return 1;
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
                // Memory and a system-managed page file as large (GlobalMemoryStatus).
                view.setBigUint64(MEMORYSTATUSEX.ullTotalPageFile, BigInt(2 * total), true);
                view.setBigUint64(MEMORYSTATUSEX.ullAvailPageFile, BigInt(free + total), true);
                view.setBigUint64(MEMORYSTATUSEX.ullTotalVirtual, BigInt(total), true);
                view.setBigUint64(MEMORYSTATUSEX.ullAvailVirtual, BigInt(free), true);
                host.writeMemory(buffer >>> 0, data);
                return 1;
            },
        },
    };

    /**
     * Each call's arguments as they cross to a child, and where in this
     * process the bytes it writes go back: the old protection, the region's
     * description. A NULL there stays NULL, for the child to refuse.
     *
     * @type {Record<string, (args: number[]) => { args: import('./cross-process.js').CrossArg[],
     *     into: (number | null)[] }>}
     */
    const crossing = {
        VirtualAlloc: args=>({ args, into: [] }),
        VirtualFree: args=>({ args, into: [] }),
        VirtualProtect: ([base, size, protect, old])=>({
            args: [base, size, protect, (old >>> 0) === 0 ? 0 : { out: 4 }],
            into: [null, null, null, old >>> 0],
        }),
        VirtualQuery: ([address, buffer, length])=>({
            args: [address, (buffer >>> 0) === 0 ? 0
                : { out: Math.min(length >>> 0, MEMORY_BASIC_INFORMATION.SIZE) }, length],
            into: [null, buffer >>> 0, null],
        }),
    };

    /**
     * A virtual-memory call's Ex form: the plain one, on the running process,
     * and on a child the same call made in the child (`cross-process.js`).
     *
     * @param {'VirtualAlloc' | 'VirtualFree' | 'VirtualProtect' | 'VirtualQuery'} name
     * @param {number} argBytes
     */
    const inProcess = (name, argBytes)=>({
        argBytes,
        /** @param {number[]} args */
        handler: ([process, ...rest])=>{
            const child = (process >>> 0) === CURRENT_PROCESS ? null : host.childOf?.(process);
            if (child && host.currentThread && host.setLastErrorFor)
            {
                const { args, into } = crossing[name](rest);
                const asked = askChild({ askChild: host.askChild, writeMemory: host.writeMemory,
                    currentThread: host.currentThread, setLastErrorFor: host.setLastErrorFor },
                child, { call: name, args }, into);
                if (asked)
                {
                    return asked;
                }
            }
            if ((process >>> 0) !== CURRENT_PROCESS)
            {
                if ((process >>> 0) !== 0)
                {
                    host.divergence?.(`${name}Ex`, `process 0x${(process >>> 0).toString(16)}`
                        + ' is not the running one, and no other is reachable');
                }
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            return table[name].handler(rest);
        },
    });

    // The rest of the local family is the global one under another name: the
    // same heap, the same handles, the same flag values.
    return {
        ...table,
        /** LPVOID VirtualAllocEx(HANDLE, LPVOID, SIZE_T, DWORD, DWORD) */
        VirtualAllocEx: inProcess('VirtualAlloc', 20),
        /** BOOL VirtualFreeEx(HANDLE, LPVOID, SIZE_T, DWORD) */
        VirtualFreeEx: inProcess('VirtualFree', 16),
        /** BOOL VirtualProtectEx(HANDLE, LPVOID, SIZE_T, DWORD, PDWORD) */
        VirtualProtectEx: inProcess('VirtualProtect', 20),
        /** SIZE_T VirtualQueryEx(HANDLE, LPCVOID, PMEMORY_BASIC_INFORMATION, SIZE_T) */
        VirtualQueryEx: inProcess('VirtualQuery', 16),
        LocalReAlloc: table.GlobalReAlloc,
        LocalLock: table.GlobalLock,
        LocalUnlock: table.GlobalUnlock,
        LocalSize: table.GlobalSize,
        LocalHandle: table.GlobalHandle,
        LocalFlags: table.GlobalFlags,

        /**
         * SIZE_T GlobalCompact(DWORD dwMinFree), SIZE_T LocalCompact(UINT uMinFree)
         * and SIZE_T LocalShrink(HLOCAL hMem, UINT cbNewSize)
         *
         * The 16-bit heap calls, which on Win32 compact the process heap and
         * answer its largest free block -- HeapCompact's answer for it. The
         * allocator coalesces as it frees, so there is nothing to move and
         * the number is only measured.
         */
        GlobalCompact: {
            argBytes: 4,
            handler: ()=>table.HeapCompact.handler([processHeap, 0]),
        },
        LocalCompact: {
            argBytes: 4,
            handler: ()=>table.HeapCompact.handler([processHeap, 0]),
        },
        LocalShrink: {
            argBytes: 8,
            handler: ()=>table.HeapCompact.handler([processHeap, 0]),
        },

        /**
         * VOID RtlMoveMemory(VOID UNALIGNED *Destination, const VOID UNALIGNED
         *     *Source, SIZE_T Length), RtlZeroMemory(Destination, Length) and
         * RtlFillMemory(Destination, Length, UCHAR Fill)
         *
         * kernel32's exports of ntdll's routines, which a program imports
         * from kernel32 as often as it calls the macros of the same names.
         * The move reads the whole source before it writes, so regions that
         * overlap either way come out as memmove leaves them; the fill value
         * comes last, where memset takes it second.
         */
        RtlMoveMemory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, length])=>{
                if ((length >>> 0) !== 0)
                {
                    // A copy of its own: a reader that answers a view of
                    // guest memory would see the write move under it.
                    host.writeMemory(destination >>> 0,
                        host.readMemory(source >>> 0, length >>> 0).slice());
                }
                return 0;
            },
        },
        RtlZeroMemory: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, length])=>{
                if ((length >>> 0) !== 0)
                {
                    host.fillMemory(destination >>> 0, 0, length >>> 0);
                }
                return 0;
            },
        },
        RtlFillMemory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, length, fill])=>{
                if ((length >>> 0) !== 0)
                {
                    host.fillMemory(destination >>> 0, fill & 0xff, length >>> 0);
                }
                return 0;
            },
        },
    };
}

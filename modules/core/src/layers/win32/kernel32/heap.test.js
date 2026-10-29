/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arenaRegion, createAddressIndex, createHeapAllocator, createHeapFunctions }
    from './heap.js';

const HEAP_ZERO_MEMORY = 0x8;
const HEAP_REALLOC_IN_PLACE_ONLY = 0x10;
const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_DECOMMIT = 0x4000;
const MEM_RESET = 0x80000;
const MEM_TOP_DOWN = 0x100000;
const ERROR_INVALID_ADDRESS = 487;
const MEM_RELEASE = 0x8000;
const INVALID_SIZE = 0xffffffff;
const PAGE_SIZE = 4096;
const MEM_FREE = 0x10000;
const MEM_PRIVATE = 0x20000;
const PAGE_NOACCESS = 0x01;
/** `lpMaximumApplicationAddress`: where a free gap with nothing above it ends. */
const USER_ADDRESS_SPACE_TOP = 0x7fff0000;
const ERROR_INVALID_PARAMETER = 87;
/** Offsets into MEMORY_BASIC_INFORMATION, matching heap.js's own layout. */
const MBI = {
    BaseAddress: 0, AllocationBase: 4, AllocationProtect: 8, RegionSize: 12,
    State: 16, Protect: 20, Type: 24, SIZE: 28,
};
/** Where Windows may begin a reservation, and so where this one may too. */
const GRANULARITY = 64 * 1024;
const GMEM_MOVEABLE = 0x0002;
const GMEM_ZEROINIT = 0x0040;

const ARENA = { base: 0x1000, size: 0x4000 };
/** For the VirtualAlloc tests: room for several whole allocation granules. */
const RESERVING_ARENA = { base: GRANULARITY, size: 4 * GRANULARITY };

/**
 * Guest memory, as the emulator's own is: zero until something writes.
 *
 * The fixture holds that premise rather than contradicting it, because it is
 * what the allocator's zeroing rests on -- a pre-dirtied arena would describe a
 * machine this engine does not have. What a previous owner left behind is
 * produced the way a program produces it, by writing into a block and giving it
 * back, which is what `dirty` below does.
 *
 * `written` counts the bytes the host put into guest memory, because a memset
 * that never crosses is the whole point of not zeroing what is already zero.
 * It is split by how they got there: `copied` came through a buffer built on
 * the host, `filled` went into the guest's own memory in place.
 */
function fakeHost(arena = ARENA){
    const bytes = new Uint8Array(arena.base + arena.size);
    let copied = 0;
    let filled = 0;

    return {
        bytes,
        arena,
        written: ()=>copied + filled,
        copied: ()=>copied,
        filled: ()=>filled,
        /**
         * The program writing into memory it was given: straight into the
         * buffer, because the host is not the one doing it.
         *
         * @param {number} address @param {number} length
         */
        dirty(address, length){
            bytes.fill(0xaa, address, address + length);
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        setLastError: ()=>{},
        /** @param {number} address @param {Uint8Array} data */
        writeMemory(address, data){
            copied += data.length;
            for (let i = 0; i < data.length; i++)
            {
                bytes[address + i] = data[i];
            }
        },
        /** @param {number} address @param {number} value @param {number} length */
        fillMemory(address, value, length){
            filled += length;
            bytes.fill(value, address, address + length);
        },
    };
}

function setup(arena = ARENA){
    const host = fakeHost(arena);
    return { host, fns: createHeapFunctions(host) };
}

/**
 * A host whose `regionAt`/`nextRegionAfter` answer from a fixed list of
 * mapped spans -- the shape VirtualQuery needs from the memory layer,
 * without pulling that layer in.
 *
 * @param {{ base: number, size: number, kind?: string }[]} regions
 */
function regionHost(regions){
    return {
        ...fakeHost(),
        /** @param {number} address */
        regionAt: address=>
            regions.find(region=>address >= region.base && address < region.base + region.size)
                ?? null,
        /** @param {number} address */
        nextRegionAfter: address=>{
            /** @type {{ base: number, size: number } | null} */
            let closest = null;
            for (const region of regions)
            {
                if (region.base > address && (!closest || region.base < closest.base))
                {
                    closest = region;
                }
            }
            return closest;
        },
    };
}

/** @param {Uint8Array} bytes @param {number} value */
const all = (bytes, value)=>bytes.every(byte=>byte === value);

test('the allocator hands out eight-byte-aligned blocks that do not overlap', ()=>{
    const allocator = createHeapAllocator(ARENA);

    const first = allocator.allocate(1);
    const second = allocator.allocate(17);
    const third = allocator.allocate(8);

    for (const address of [first, second, third])
    {
        assert.equal(address % 8, 0, 'malloc-grade alignment is part of the contract');
        assert.ok(address >= ARENA.base && address < ARENA.base + ARENA.size);
    }
    assert.ok(second >= first + 8, 'a one-byte request still occupies a whole block');
    assert.ok(third >= second + 24, '17 bytes round up to 24, not to 17');
});

test('an allocation that does not fit is refused rather than thrown', ()=>{
    const allocator = createHeapAllocator(ARENA);

    assert.equal(allocator.allocate(ARENA.size + 1), 0);
    assert.equal(allocator.allocate(0xffffffff), 0);
    assert.ok(allocator.allocate(64) !== 0, 'the arena is still usable afterwards');
});

test('freed neighbours coalesce, so the space comes back as one span', ()=>{
    const allocator = createHeapAllocator(ARENA);

    const first = allocator.allocate(0x800);
    const second = allocator.allocate(0x800);
    allocator.allocate(0x800);

    assert.ok(allocator.free(first));
    assert.ok(allocator.free(second));

    // Without coalescing this fits nowhere: the two spans are 0x800 each.
    assert.equal(allocator.allocate(0x1000), first);
});

test('freeing something that was never allocated says so instead of corrupting the map', ()=>{
    const allocator = createHeapAllocator(ARENA);
    const address = allocator.allocate(32);

    assert.equal(allocator.free(address + 4), false, 'the interior of a block is not a block');
    assert.equal(allocator.free(ARENA.base + ARENA.size), false);
    assert.equal(allocator.free(address), true);
    assert.equal(allocator.free(address), false, 'the second free finds nothing');
    assert.equal(allocator.block(address), null);
});

test('a block freed between two free neighbours becomes one span with both', ()=>{
    const allocator = createHeapAllocator(ARENA);

    const first = allocator.allocate(0x400);
    const second = allocator.allocate(0x400);
    const third = allocator.allocate(0x400);
    allocator.allocate(0x400);

    assert.ok(allocator.free(first));
    assert.ok(allocator.free(third));
    assert.ok(allocator.free(second));

    assert.equal(allocator.allocate(0xc00), first, 'three neighbours came back as one');
    assert.equal(allocator.diagnostics().blocks, 2);
});

test('the same requests yield the same addresses, whatever the heap has been through', ()=>{
    /** @param {ReturnType<typeof createHeapAllocator>} allocator */
    const exercise = allocator=>{
        /** @type {number[]} */
        const out = [];
        /** @type {number[]} */
        const held = [];
        let seed = 7;
        for (let i = 0; i < 2000; i++)
        {
            seed = (seed * 1103515245 + 12345) >>> 0;
            const address = allocator.allocate(1 + (seed >>> 8) % 300);
            out.push(address);
            held.push(address);
            if ((seed & 3) === 0 && held.length > 0)
            {
                allocator.free(/** @type {number} */ (held.splice((seed >>> 4) % held.length, 1)[0]));
            }
        }
        return out;
    };
    const arena = { base: 0x10000, size: 0x100000 };
    assert.deepEqual(exercise(createHeapAllocator(arena)), exercise(createHeapAllocator(arena)));
});

test('an allocation costs the same in a heap of a hundred thousand blocks as in an empty one', t=>{
    // What a program pays for a block once it has loaded a level, where every
    // free list walked in order and every map deleted from grew with the
    // heap: at a hundred thousand live blocks an allocation of sixteen bytes
    // and its free were measured at two hundred microseconds together.
    const allocator = createHeapAllocator({ base: 0x10000000, size: 0x30000000 });
    const held = [];
    let seed = 12345;
    for (let i = 0; i < 200000; i++)
    {
        seed = (seed * 1103515245 + 12345) >>> 0;
        held.push(allocator.allocate(16 + (seed >>> 8) % 500));
    }
    for (let i = 0; i < held.length; i += 2)
    {
        allocator.free(held[i]);
    }
    const PAIRS = 20000;
    const started = process.hrtime.bigint();
    for (let i = 0; i < PAIRS; i++)
    {
        allocator.free(allocator.allocate(16));
    }
    const perPair = Number(process.hrtime.bigint() - started) / PAIRS;
    t.diagnostic(
        `allocate and free among 100000 live blocks: ${(perPair / 1000).toFixed(2)} us a pair`);
    assert.ok(perPair < 50_000, `${perPair} ns a pair is a walk over the heap, not a lookup`);
    assert.equal(allocator.diagnostics().blocks, 100000);
});

test('handing the same address out and back many times does not grow the allocator', ()=>{
    // The maps by address are never deleted from -- see the allocator -- so
    // they are rebuilt once the entries that went away outnumber the ones
    // that are there. Everything has to keep working across that.
    const allocator = createHeapAllocator({ base: 0x10000, size: 0x100000 });
    const kept = allocator.allocate(64);
    const neighbour = allocator.allocate(64);
    let address = 0;
    for (let i = 0; i < 70000; i++)
    {
        const next = allocator.allocate(64);
        assert.ok(address === 0 || next === address, 'the same span answers every time');
        address = next;
        assert.ok(allocator.free(next));
    }
    assert.equal(allocator.block(kept)?.size, 64, 'a block that stayed is still found');
    assert.equal(allocator.block(address), null, 'a block that went is not');
    assert.ok(allocator.free(neighbour));
    assert.ok(allocator.free(kept));
    assert.equal(allocator.allocate(0x100000), 0x10000,
        'and everything coalesced back to one span');
});

test('a sliver too small for any block is never handed out', ()=>{
    // An arena that starts off the alignment leaves four bytes in front of
    // its first block, and the tail can end the same way. They coalesce with
    // a neighbour that is freed, and until then nobody gets them.
    const allocator = createHeapAllocator({ base: 0x1004, size: 0x20 });

    assert.equal(allocator.allocate(8), 0x1008);
    assert.equal(allocator.allocate(8), 0x1010);
    assert.equal(allocator.allocate(8), 0x1018);
    assert.equal(allocator.allocate(8), 0, 'eight bytes are left, in two slivers of four');
    assert.ok(allocator.free(0x1018));
    assert.equal(allocator.diagnostics().largestFree, 12,
        'the tail sliver came back with its neighbour');
    assert.equal(allocator.allocate(8), 0x1018);
});

test('the allocator honours a coarser alignment than its default', ()=>{
    const allocator = createHeapAllocator({ base: 0x1004, size: 0x8000 });

    const address = allocator.allocate(1, { alignment: PAGE_SIZE });

    assert.equal(address % PAGE_SIZE, 0);
    assert.ok(address >= 0x1004, 'padding comes out of the arena, not before it');
});

test('GetProcessHeap answers with one handle for the life of the process', ()=>{
    const { fns } = setup();

    const heap = fns.GetProcessHeap.handler();

    assert.ok(heap !== 0);
    assert.equal(fns.GetProcessHeap.handler(), heap);
});

test('HeapSize reports what was asked for, not what was reserved', ()=>{
    const { fns } = setup();
    const heap = fns.GetProcessHeap.handler();

    const address = fns.HeapAlloc.handler([heap, 0, 17]);

    assert.equal(address % 8, 0);
    assert.equal(fns.HeapSize.handler([heap, 0, address]), 17,
        'a program that copies HeapSize bytes must not read into its neighbour');
});

test('HEAP_ZERO_MEMORY zeroes the memory it hands over', ()=>{
    const { host, fns } = setup();
    const heap = fns.GetProcessHeap.handler();

    const clean = fns.HeapAlloc.handler([heap, HEAP_ZERO_MEMORY, 64]);
    assert.ok(all(host.bytes.subarray(clean, clean + 64), 0),
        'the flag is the whole reason a program passes it');
    assert.equal(host.written(), 0,
        'arena nobody has had is zero already, and a memset over it is time the program pays');
});

test('memory handed out again does not carry the last owner\'s data into this one', ()=>{
    const { host, fns } = setup();
    const heap = fns.GetProcessHeap.handler();

    const first = fns.HeapAlloc.handler([heap, HEAP_ZERO_MEMORY, 64]);
    host.dirty(first, 64);
    assert.equal(fns.HeapFree.handler([heap, 0, first]), 1);

    const again = fns.HeapAlloc.handler([heap, HEAP_ZERO_MEMORY, 64]);
    assert.equal(again, first, 'the same memory comes back');
    assert.ok(all(host.bytes.subarray(again, again + 64), 0),
        'this is the case a lazy zeroing must not get wrong: it is a data leak');
    assert.equal(host.written(), 64, 'and it is paid for exactly once');
});

test('a recycled block is cleared in place, with no buffer of zeroes to copy', ()=>{
    // The clearing that has to happen is a whole block, inside the program's
    // own call: building the zeroes on the host first would allocate the block
    // again, have the runtime zero that, and copy it across.
    const { host, fns } = setup();
    const heap = fns.GetProcessHeap.handler();

    const first = fns.HeapAlloc.handler([heap, 0, 1024]);
    host.dirty(first, 1024);
    assert.equal(fns.HeapFree.handler([heap, 0, first]), 1);

    const again = fns.HeapAlloc.handler([heap, HEAP_ZERO_MEMORY, 1024]);
    assert.ok(all(host.bytes.subarray(again, again + 1024), 0));
    assert.equal(host.filled(), 1024, 'cleared as a fill of the memory the guest already has');
    assert.equal(host.copied(), 0, 'and nothing was carried across from the host');
});

test('HeapAlloc returns NULL when the arena cannot fit the request', ()=>{
    const { fns } = setup();
    const heap = fns.GetProcessHeap.handler();

    assert.equal(fns.HeapAlloc.handler([heap, 0, ARENA.size * 2]), 0);
    assert.equal(fns.HeapAlloc.handler([0x1234, 0, 16]), 0, 'an unknown heap allocates nothing');
});

test('HeapFree refuses a pointer it did not hand out', ()=>{
    const { fns } = setup();
    const heap = fns.GetProcessHeap.handler();
    const address = fns.HeapAlloc.handler([heap, 0, 32]);

    assert.equal(fns.HeapFree.handler([heap, 0, address + 8]), 0);
    assert.equal(fns.HeapFree.handler([heap, 0, ARENA.base + ARENA.size]), 0);
    assert.equal(fns.HeapFree.handler([heap, 0, address]), 1);
    assert.equal(fns.HeapFree.handler([heap, 0, address]), 0, 'a double free is a failure');
});

test('HeapSize of a freed block fails rather than answering a stale size', ()=>{
    const { fns } = setup();
    const heap = fns.GetProcessHeap.handler();
    const address = fns.HeapAlloc.handler([heap, 0, 40]);

    fns.HeapFree.handler([heap, 0, address]);

    assert.equal(fns.HeapSize.handler([heap, 0, address]), INVALID_SIZE);
});

test('a block belongs to the heap it came from', ()=>{
    const { fns } = setup();
    const processHeap = fns.GetProcessHeap.handler();
    const other = fns.HeapCreate.handler();
    const address = fns.HeapAlloc.handler([other, 0, 32]);

    assert.notEqual(other, processHeap);
    assert.equal(fns.HeapFree.handler([processHeap, 0, address]), 0);
    assert.equal(fns.HeapSize.handler([processHeap, 0, address]), INVALID_SIZE);
    assert.equal(fns.HeapFree.handler([other, 0, address]), 1);
});

test('HeapReAlloc that has to move carries the contents across', ()=>{
    const { host, fns } = setup();
    const heap = fns.GetProcessHeap.handler();
    const address = fns.HeapAlloc.handler([heap, 0, 64]);
    host.writeMemory(address, new Uint8Array(64).fill(0x5a));
    // Pins the block: growing in place would run into this one.
    fns.HeapAlloc.handler([heap, 0, 64]);

    const moved = fns.HeapReAlloc.handler([heap, 0, address, 0x400]);

    assert.notEqual(moved, address, 'the block cannot grow where it stands');
    assert.ok(all(host.bytes.subarray(moved, moved + 64), 0x5a));
    assert.equal(fns.HeapSize.handler([heap, 0, moved]), 0x400);
    assert.equal(fns.HeapSize.handler([heap, 0, address]), INVALID_SIZE,
        'the old block is released, not leaked');
});

test('HeapReAlloc that shrinks keeps the pointer and the surviving contents', ()=>{
    const { host, fns } = setup();
    const heap = fns.GetProcessHeap.handler();
    const address = fns.HeapAlloc.handler([heap, 0, 0x400]);
    host.writeMemory(address, new Uint8Array(0x400).fill(0x3c));

    const smaller = fns.HeapReAlloc.handler([heap, 0, address, 16]);

    assert.equal(smaller, address);
    assert.equal(fns.HeapSize.handler([heap, 0, address]), 16);
    assert.ok(all(host.bytes.subarray(address, address + 16), 0x3c));
});

test('HEAP_REALLOC_IN_PLACE_ONLY fails instead of moving, and leaves the block alone', ()=>{
    const { fns } = setup();
    const heap = fns.GetProcessHeap.handler();
    const address = fns.HeapAlloc.handler([heap, 0, 64]);
    fns.HeapAlloc.handler([heap, 0, 64]);

    const result = fns.HeapReAlloc.handler([heap, HEAP_REALLOC_IN_PLACE_ONLY, address, 0x400]);

    assert.equal(result, 0);
    assert.equal(fns.HeapSize.handler([heap, 0, address]), 64,
        'a failed HeapReAlloc must not disturb what the caller still owns');
});

test('HEAP_ZERO_MEMORY on HeapReAlloc zeroes only the part that is new', ()=>{
    const { host, fns } = setup();
    const heap = fns.GetProcessHeap.handler();

    // Grown in place: 17 bytes reserve 24, so the last 7 are already there.
    const stays = fns.HeapAlloc.handler([heap, 0, 17]);
    host.writeMemory(stays, new Uint8Array(17).fill(0x11));
    assert.equal(fns.HeapReAlloc.handler([heap, HEAP_ZERO_MEMORY, stays, 24]), stays);
    assert.ok(all(host.bytes.subarray(stays, stays + 17), 0x11));
    assert.ok(all(host.bytes.subarray(stays + 17, stays + 24), 0));

    // Grown by moving: the extension lands on memory somebody else dirtied.
    const moves = fns.HeapAlloc.handler([heap, 0, 64]);
    host.writeMemory(moves, new Uint8Array(64).fill(0x22));
    fns.HeapAlloc.handler([heap, 0, 64]);
    const grown = fns.HeapReAlloc.handler([heap, HEAP_ZERO_MEMORY, moves, 0x200]);
    assert.ok(all(host.bytes.subarray(grown, grown + 64), 0x22));
    assert.ok(all(host.bytes.subarray(grown + 64, grown + 0x200), 0));
});

test('HeapDestroy releases every block the heap held', ()=>{
    const { fns } = setup();
    const heap = fns.HeapCreate.handler();
    const first = fns.HeapAlloc.handler([heap, 0, 0x1000]);
    const second = fns.HeapAlloc.handler([heap, 0, 0x1000]);

    assert.equal(fns.HeapDestroy.handler([heap]), 1);

    assert.equal(fns.HeapSize.handler([heap, 0, first]), INVALID_SIZE);
    assert.equal(fns.HeapAlloc.handler([heap, 0, 16]), 0, 'a destroyed heap allocates nothing');
    assert.ok(second !== 0);

    // The space is back: this only fits if both blocks were returned.
    const process = fns.GetProcessHeap.handler();
    assert.notEqual(fns.HeapAlloc.handler([process, 0, 0x2000]), 0);
});

test('the process heap cannot be destroyed out from under the program', ()=>{
    const { fns } = setup();
    const heap = fns.GetProcessHeap.handler();
    const address = fns.HeapAlloc.handler([heap, 0, 32]);

    assert.equal(fns.HeapDestroy.handler([heap]), 0);
    assert.equal(fns.HeapSize.handler([heap, 0, address]), 32);
});

test('a heap turns the low-fragmentation heap on once and reports it, as Wine\'s heap test has it',
    ()=>{
        const ERROR_GEN_FAILURE = 31;
        const ERROR_INSUFFICIENT_BUFFER = 122;
        const ERROR_NOACCESS = 998;
        const HEAP_NO_SERIALIZE = 0x1;
        /** @type {number[]} */
        const errors = [];
        const host = { ...fakeHost(), setLastError: (/** @type {number} */ e)=>errors.push(e) };
        const fns = createHeapFunctions(host);
        const view = new DataView(host.bytes.buffer);
        const INFO = 0x10;
        const SIZE = 0x20;
        /** @param {number} heap @param {number} length */
        const query = (heap, length)=>
            fns.HeapQueryInformation.handler([heap, 0, INFO, length, SIZE]);
        /** @param {number} heap @param {number} value */
        const set = (heap, value)=>{
            view.setUint32(INFO, value, true);
            return fns.HeapSetInformation.handler([heap, 0, INFO, 4]);
        };

        const heap = fns.HeapCreate.handler([0, 0, 0]);
        assert.equal(query(heap, 4), 1);
        assert.equal(view.getUint32(INFO, true), 0, 'not on to begin with');
        assert.equal(view.getUint32(SIZE, true), 4);
        assert.equal(query(heap, 0), 0);
        assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
        assert.equal(query(0, 4), 0, 'no heap');
        assert.equal(errors.at(-1), ERROR_NOACCESS);

        assert.equal(set(heap, 2), 1);
        assert.equal(query(heap, 4), 1);
        assert.equal(view.getUint32(INFO, true), 2);
        assert.equal(set(heap, 0), 0, 'and cannot be undone');
        assert.equal(errors.at(-1), ERROR_GEN_FAILURE);

        const unserialized = fns.HeapCreate.handler([HEAP_NO_SERIALIZE, 0, 0]);
        assert.equal(set(unserialized, 2), 0);
        assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);

        const HeapEnableTerminationOnCorruption = 1;
        assert.equal(fns.HeapSetInformation.handler([0, HeapEnableTerminationOnCorruption, 0, 0]),
            1, 'asked of no heap in particular, as a runtime asks at startup');
        assert.equal(fns.HeapSetInformation.argBytes, 16);
        assert.equal(fns.HeapQueryInformation.argBytes, 20);
    });

test('VirtualAlloc commits granular, zeroed memory', ()=>{
    const { host, fns } = setup(RESERVING_ARENA);

    const address = fns.VirtualAlloc.handler([0, 100, MEM_COMMIT | MEM_RESERVE, 0x04]);

    assert.notEqual(address, 0);
    // Not merely page-aligned: an allocator built on VirtualAlloc may recover
    // the base of a reservation from the top bits of an address inside it,
    // which only works because Windows never begins one anywhere else.
    assert.equal(address % GRANULARITY, 0);
    assert.ok(all(host.bytes.subarray(address, address + PAGE_SIZE), 0),
        'a committed page reads as zero on Windows, and code depends on it');
    assert.equal(host.written(), 0,
        'and on Windows that costs nothing at the call: the page is a promise, not a memset');
    assert.equal(fns.VirtualAlloc.handler([0, 0, MEM_COMMIT, 0x04]), 0, 'zero bytes is a failure');
});

test('a reservation over memory something else had is cleared before it is handed back', ()=>{
    const { host, fns } = setup(RESERVING_ARENA);

    const first = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE, 0x04]);
    host.dirty(first, GRANULARITY);
    assert.equal(fns.VirtualFree.handler([first, 0, MEM_RELEASE]), 1);

    const again = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE, 0x04]);
    assert.equal(again, first);
    assert.ok(all(host.bytes.subarray(again, again + GRANULARITY), 0),
        'a program that reserves memory must not be able to read the last tenant\'s');
});

test('committing a page a second time keeps what the program put in it', ()=>{
    // Documented: MEM_COMMIT on already-committed pages succeeds and does not
    // zero them. An allocator built on VirtualAlloc commits up to its own
    // high-water mark every time it grows, so it does this constantly -- and
    // zeroing there would erase the objects it is growing around.
    const { host, fns } = setup(RESERVING_ARENA);
    const reserved = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE, 0x04]);

    assert.equal(fns.VirtualAlloc.handler([reserved, PAGE_SIZE, MEM_COMMIT, 0x04]), reserved);
    host.dirty(reserved, PAGE_SIZE);
    const before = host.written();

    assert.equal(fns.VirtualAlloc.handler([reserved, PAGE_SIZE * 2, MEM_COMMIT, 0x04]), reserved);
    assert.ok(all(host.bytes.subarray(reserved, reserved + PAGE_SIZE), 0xaa),
        'the page that was already committed keeps its contents');
    assert.ok(all(host.bytes.subarray(reserved + PAGE_SIZE, reserved + PAGE_SIZE * 2), 0),
        'and the page that was not reads as zero');
    assert.equal(host.written(), before, 'neither costs a write');
});

test('a page given back reads as zeroes when the program commits it again', ()=>{
    const { host, fns } = setup(RESERVING_ARENA);
    const reserved = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE, 0x04]);
    fns.VirtualAlloc.handler([reserved, PAGE_SIZE * 2, MEM_COMMIT, 0x04]);
    host.dirty(reserved, PAGE_SIZE * 2);

    // Windows takes the pages away and gives new ones back on the next commit.
    assert.equal(fns.VirtualFree.handler([reserved, PAGE_SIZE, MEM_DECOMMIT]), 1);
    const before = host.written();
    assert.equal(fns.VirtualAlloc.handler([reserved, PAGE_SIZE, MEM_COMMIT, 0x04]), reserved);

    assert.ok(all(host.bytes.subarray(reserved, reserved + PAGE_SIZE), 0));
    assert.equal(host.written() - before, PAGE_SIZE, 'exactly the page that was given back');
    assert.ok(all(host.bytes.subarray(reserved + PAGE_SIZE, reserved + PAGE_SIZE * 2), 0xaa),
        'the page that was kept is untouched');
});

test('VirtualFree releases whole reservations only', ()=>{
    const { fns } = setup(RESERVING_ARENA);
    const address = fns.VirtualAlloc.handler([0, PAGE_SIZE, MEM_COMMIT | MEM_RESERVE, 0x04]);
    const heap = fns.GetProcessHeap.handler();
    const block = fns.HeapAlloc.handler([heap, 0, 32]);

    assert.equal(fns.VirtualFree.handler([address, PAGE_SIZE, MEM_RELEASE]), 0,
        'MEM_RELEASE with a size is the documented way to get FALSE');
    assert.equal(fns.VirtualFree.handler([block, 0, MEM_RELEASE]), 0,
        'a heap block is not a reservation');
    assert.equal(fns.VirtualFree.handler([address, PAGE_SIZE, MEM_DECOMMIT]), 1);
    assert.equal(fns.VirtualFree.handler([address, 0, MEM_RELEASE]), 1);
    assert.equal(fns.VirtualFree.handler([address, 0, MEM_RELEASE]), 0, 'released once, no more');
});

test('VirtualAlloc at a chosen address only succeeds where we already have it', ()=>{
    const { fns } = setup();
    const address = fns.VirtualAlloc.handler([0, PAGE_SIZE * 2, MEM_RESERVE, 0x04]);

    assert.equal(fns.VirtualAlloc.handler([address, PAGE_SIZE, MEM_COMMIT, 0x04]), address,
        'committing inside an existing reservation is the common two-step pattern');
    assert.equal(fns.VirtualAlloc.handler([address, PAGE_SIZE * 4, MEM_COMMIT, 0x04]), 0,
        'a request larger than the reservation cannot be satisfied there');
    assert.equal(fns.VirtualAlloc.handler([0x900000, PAGE_SIZE, MEM_COMMIT, 0x04]), 0,
        'an address we never handed out is not ours to map');
});

/**
 * The VirtualAlloc setup, with the last errors it set kept in order.
 *
 * @param {{ base: number, size: number }} [arena]
 */
function recording(arena = RESERVING_ARENA){
    /** @type {number[]} */
    const errors = [];
    const host = { ...fakeHost(arena), setLastError: (/** @type {number} */ code)=>{
        errors.push(code);
    } };
    return { host, errors, fns: createHeapFunctions(host) };
}

test('the allocator places a block at a chosen address only when all of it is free', ()=>{
    const allocator = createHeapAllocator({ base: 0x10000, size: 0x40000 });

    assert.equal(allocator.allocateAt(0x20000, 0x10000, { owner: 'mine' }), true);
    assert.equal(allocator.block(0x20000)?.owner, 'mine');
    assert.equal(allocator.allocateAt(0x28000, 0x1000), false, 'inside a block already there');
    assert.equal(allocator.allocateAt(0x1f000, 0x2000), false, 'running into one');
    assert.equal(allocator.allocateAt(0x48000, 0x10000), false, 'running out of the arena');
    assert.equal(allocator.allocateAt(0x8000, 0x1000), false, 'before the arena');

    // What is left on either side is still there to be handed out.
    assert.equal(allocator.allocateAt(0x10000, 0x10000), true);
    assert.equal(allocator.allocateAt(0x30000, 0x20000), true);
    assert.equal(allocator.allocate(8), 0, 'and that was all of it');
    assert.equal(allocator.free(0x20000), true);
    assert.equal(allocator.allocate(0x10000), 0x20000, 'a placed block frees like any other');
});

test('MEM_RESERVE at an address places the reservation there, on its granule', ()=>{
    const { fns, errors } = recording();
    const wanted = 2 * GRANULARITY + 0x1234;

    assert.equal(fns.VirtualAlloc.handler([wanted, PAGE_SIZE, MEM_RESERVE, 0x04]),
        2 * GRANULARITY, 'the address is rounded down to where a reservation may begin');
    assert.equal(fns.VirtualAlloc.handler([wanted + PAGE_SIZE, 0x100, MEM_COMMIT, 0x04]),
        2 * GRANULARITY + 2 * PAGE_SIZE, 'and its pages can be committed');
    assert.equal(fns.VirtualAlloc.handler([wanted + PAGE_SIZE, PAGE_SIZE, MEM_COMMIT, 0x04]), 0,
        'up to the page the last byte asked for, and not past it');

    assert.equal(fns.VirtualAlloc.handler([wanted, PAGE_SIZE, MEM_RESERVE, 0x04]), 0,
        'a reservation cannot be made over another');
    assert.equal(fns.VirtualAlloc.handler([2 * GRANULARITY, PAGE_SIZE, MEM_RESERVE | MEM_COMMIT,
        0x04]), 0, 'nor committed into being there');
    assert.deepEqual(errors, Array(3).fill(ERROR_INVALID_ADDRESS));

    assert.equal(fns.VirtualAlloc.handler([3 * GRANULARITY, 2 * PAGE_SIZE,
        MEM_RESERVE | MEM_COMMIT, 0x04]), 3 * GRANULARITY, 'where it is free, both at once');
});

test('VirtualAlloc refuses a type that asks for nothing, or MEM_RESET with more', ()=>{
    const { fns, errors } = recording();

    assert.equal(fns.VirtualAlloc.handler([0, PAGE_SIZE, 0, 0x04]), 0);
    assert.equal(fns.VirtualAlloc.handler([0, PAGE_SIZE, MEM_DECOMMIT, 0x04]), 0);
    assert.equal(fns.VirtualAlloc.handler([0, PAGE_SIZE, MEM_RESET | MEM_COMMIT, 0x04]), 0);
    assert.equal(fns.VirtualAlloc.handler([0, 0, MEM_COMMIT, 0x04]), 0);
    assert.deepEqual(errors, Array(4).fill(ERROR_INVALID_PARAMETER));

    assert.notEqual(fns.VirtualAlloc.handler([0, PAGE_SIZE, MEM_COMMIT | MEM_TOP_DOWN, 0x04]), 0,
        'a hint nothing here acts on is not a reason to refuse');
});

test('MEM_RESET keeps the pages and what is in them, inside a reservation only', ()=>{
    const { host, fns, errors } = recording();
    const reserved = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE | MEM_COMMIT, 0x04]);
    host.dirty(reserved, PAGE_SIZE);
    const before = host.written();

    assert.equal(fns.VirtualAlloc.handler([reserved + 0x10, PAGE_SIZE, MEM_RESET, 0x04]),
        reserved);
    assert.equal(host.written(), before, 'nothing is written: the contents are only undefined');
    assert.equal(fns.VirtualAlloc.handler([0, PAGE_SIZE, MEM_RESET, 0x04]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_ADDRESS]);
});

test('VirtualFree says why it failed', ()=>{
    const { fns, errors } = recording();
    const reserved = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE, 0x04]);

    assert.equal(fns.VirtualFree.handler([reserved, 0, MEM_RELEASE | MEM_DECOMMIT]), 0);
    assert.equal(fns.VirtualFree.handler([reserved, 0, 0]), 0);
    assert.equal(fns.VirtualFree.handler([reserved, PAGE_SIZE, MEM_RELEASE]), 0);
    assert.equal(fns.VirtualFree.handler([reserved + PAGE_SIZE, 0, MEM_RELEASE]), 0,
        'a release names the reservation by its base');
    assert.equal(fns.VirtualFree.handler([3 * GRANULARITY, 0, MEM_RELEASE]), 0);
    assert.equal(fns.VirtualFree.handler([reserved, GRANULARITY * 2, MEM_DECOMMIT]), 0,
        'a decommit past the reservation\'s end');
    assert.deepEqual(errors, [
        ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER,
        ERROR_INVALID_ADDRESS, ERROR_INVALID_ADDRESS, ERROR_INVALID_ADDRESS,
    ]);
    assert.equal(fns.VirtualFree.handler([reserved, 0, MEM_RELEASE]), 1);
});

test('pages decommitted apart are given back apart: the one between keeps its contents', ()=>{
    const { host, fns } = recording();
    const reserved = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE | MEM_COMMIT, 0x04]);
    host.dirty(reserved, 3 * PAGE_SIZE);

    assert.equal(fns.VirtualFree.handler([reserved, PAGE_SIZE, MEM_DECOMMIT]), 1);
    assert.equal(fns.VirtualFree.handler([reserved + 2 * PAGE_SIZE + 8, 8, MEM_DECOMMIT]), 1,
        'a decommit may name any page inside the reservation');
    fns.VirtualAlloc.handler([reserved, 3 * PAGE_SIZE, MEM_COMMIT, 0x04]);

    assert.ok(all(host.bytes.subarray(reserved, reserved + PAGE_SIZE), 0));
    assert.ok(all(host.bytes.subarray(reserved + PAGE_SIZE, reserved + 2 * PAGE_SIZE), 0xaa),
        'the page that was never given back');
    assert.ok(all(host.bytes.subarray(reserved + 2 * PAGE_SIZE, reserved + 3 * PAGE_SIZE), 0));
});

test('a decommit with no size takes the whole reservation from its base and is refused inside it',
    ()=>{
        const { host, fns, errors } = recording();
        const reserved = fns.VirtualAlloc.handler([0, GRANULARITY, MEM_RESERVE | MEM_COMMIT, 0x04]);
        host.dirty(reserved, 4 * PAGE_SIZE);

        // Wine's NtFreeVirtualMemory: STATUS_FREE_VM_NOT_AT_BASE, and nothing taken.
        assert.equal(fns.VirtualFree.handler([reserved + PAGE_SIZE, 0, MEM_DECOMMIT]), 0);
        assert.deepEqual(errors, [ERROR_INVALID_ADDRESS]);
        fns.VirtualAlloc.handler([reserved, 4 * PAGE_SIZE, MEM_COMMIT, 0x04]);
        assert.ok(all(host.bytes.subarray(reserved, reserved + 4 * PAGE_SIZE), 0xaa),
            'every page keeps what it held');

        assert.equal(fns.VirtualFree.handler([reserved, 0, MEM_DECOMMIT]), 1);
        fns.VirtualAlloc.handler([reserved, 4 * PAGE_SIZE, MEM_COMMIT, 0x04]);
        assert.ok(all(host.bytes.subarray(reserved, reserved + 4 * PAGE_SIZE), 0),
            'from the base, all of it is given back');
    });

test('every function declares the stack it pops', ()=>{
    const { fns } = setup();
    // stdcall: the callee cleans up, so a wrong count corrupts the guest stack
    // silently. These are the documented signatures, in bytes.
    assert.equal(fns.GetProcessHeap.argBytes, 0);
    assert.equal(fns.HeapCreate.argBytes, 12);
    assert.equal(fns.HeapDestroy.argBytes, 4);
    assert.equal(fns.HeapAlloc.argBytes, 12);
    assert.equal(fns.HeapReAlloc.argBytes, 16);
    assert.equal(fns.HeapFree.argBytes, 12);
    assert.equal(fns.HeapSize.argBytes, 12);
    assert.equal(fns.VirtualAlloc.argBytes, 16);
    assert.equal(fns.VirtualFree.argBytes, 12);
});

test('a global allocation is already the pointer a caller has to lock for', ()=>{
    // The 16-bit inheritance: moveable memory was a handle you locked into a
    // pointer. Win32 made them the same thing, but programs still write the
    // lock/unlock pairs and those still have to balance.
    const { fns } = setup();

    const handle = fns.GlobalAlloc.handler([GMEM_MOVEABLE, 64]);
    assert.notEqual(handle, 0);
    assert.equal(fns.GlobalLock.handler([handle]), handle, 'locking moves nothing');
    assert.equal(fns.GlobalUnlock.handler([handle]), 1);
    assert.equal(fns.GlobalSize.handler([handle]), 64);
});

test('GlobalWire and GlobalFix lock a block, GlobalUnWire and GlobalUnfix unlock it', ()=>{
    // The 16-bit calls a heap library still looks up: each the lock or the
    // unlock it stood for, and a block here never moves.
    const { fns } = setup();
    const handle = fns.GlobalAlloc.handler([GMEM_MOVEABLE, 64]);
    assert.equal(fns.GlobalWire.handler([handle]), handle);
    assert.equal(fns.GlobalUnWire.handler([handle]), 1);
    assert.equal(fns.GlobalFix.handler(), 0);
    assert.equal(fns.GlobalUnfix.handler(), 0);
    assert.equal(fns.GlobalWire.handler([handle + 0x10000]), 0, 'no block, no pointer');
    assert.deepEqual([fns.GlobalWire, fns.GlobalFix, fns.GlobalUnWire, fns.GlobalUnfix]
        .map(fn=>fn.argBytes), [4, 4, 4, 4]);
});

test('a zero-initialised global allocation is actually zeroed', ()=>{
    const { host, fns } = setup();

    const handle = fns.GlobalAlloc.handler([GMEM_ZEROINIT, 32]);
    assert.equal(all(host.bytes.subarray(handle, handle + 32), 0), true);

    host.dirty(handle, 32);
    assert.equal(fns.GlobalFree.handler([handle]), 0);
    const kept = fns.GlobalAlloc.handler([0, 32]);
    assert.equal(kept, handle);
    assert.equal(all(host.bytes.subarray(kept, kept + 32), 0xaa), true,
        'and one that did not ask for it is left as it was found');
});

test('freeing answers with nothing on success and the handle back on failure', ()=>{
    // The opposite of almost everything else here, and a program tests it.
    const { fns } = setup();

    const handle = fns.GlobalAlloc.handler([0, 16]);
    assert.equal(fns.GlobalFree.handler([handle]), 0);
    assert.equal(fns.GlobalFree.handler([handle]), handle, 'freeing it twice fails');
    assert.equal(fns.GlobalLock.handler([handle]), 0, 'and it can no longer be locked');
});

test('LocalFree releases the same blocks GlobalAlloc hands out', ()=>{
    // Win32 keeps both spellings over one heap, and a program mixes them.
    const { fns } = setup();

    const handle = fns.GlobalAlloc.handler([0, 16]);
    assert.equal(fns.LocalFree.handler([handle]), 0);
    assert.equal(fns.LocalFree.handler([handle]), handle);
});

test('the local heap is the global heap, flags and handles alike', ()=>{
    const { host, fns } = setup();

    const handle = fns.LocalAlloc.handler([GMEM_ZEROINIT, 32]);
    assert.notEqual(handle, 0);
    assert.equal(all(host.bytes.subarray(handle, handle + 32), 0), true);
    assert.equal(fns.LocalLock.handler([handle]), handle);
    assert.equal(fns.LocalSize.handler([handle]), 32);
    assert.equal(fns.LocalHandle.handler([handle]), handle);
    assert.equal(fns.LocalUnlock.handler([handle]), 1);
    assert.equal(fns.GlobalFree.handler([handle]), 0, 'and the other spelling frees it');
    assert.equal(fns.LocalAlloc.argBytes, 8);
    assert.equal(fns.LocalLock.argBytes, 4);
});

test('a global block grows in place when it can and moves only when allowed to', ()=>{
    const { host, fns } = setup();

    const handle = fns.GlobalAlloc.handler([0, 16]);
    host.writeMemory(handle, new Uint8Array([1, 2, 3, 4]));
    // The neighbour stops the first block from growing where it is.
    const neighbour = fns.GlobalAlloc.handler([0, 16]);
    assert.notEqual(neighbour, 0);

    assert.equal(fns.GlobalReAlloc.handler([handle, 8, 0]), handle, 'shrinking stays put');
    assert.equal(fns.GlobalReAlloc.handler([handle, 4096, 0]), 0,
        'growing past the neighbour without GMEM_MOVEABLE fails');
    assert.equal(fns.GlobalSize.handler([handle]), 8, 'and leaves the block as it was');

    const moved = fns.LocalReAlloc.handler([handle, 4096, GMEM_MOVEABLE | GMEM_ZEROINIT]);
    assert.notEqual(moved, 0);
    assert.notEqual(moved, handle);
    assert.deepEqual([...host.bytes.subarray(moved, moved + 4)], [1, 2, 3, 4],
        'the data went with it');
    assert.equal(all(host.bytes.subarray(moved + 8, moved + 4096), 0), true, 'the tail is zeroed');
    assert.equal(fns.GlobalLock.handler([handle]), 0, 'the old block is gone');
    assert.equal(fns.GlobalReAlloc.argBytes, 12);
});

test('a live global block has no flags and a stranger is GMEM_INVALID_HANDLE', ()=>{
    const { fns } = setup();
    const handle = fns.GlobalAlloc.handler([GMEM_MOVEABLE, 16]);
    assert.equal(fns.GlobalFlags.handler([handle]), 0);
    assert.equal(fns.GlobalFlags.handler([0x1234]), 0x8000);
    assert.equal(fns.GlobalFlags.argBytes, 4);
    assert.equal(fns.LocalFlags, fns.GlobalFlags, 'LocalFlags is the same call');
});

test('HeapSummary adds up the heap\'s live blocks, and wants its own size first', ()=>{
    // kernel32's heap tests: a structure whose cb is not its size is
    // ERROR_INVALID_PARAMETER; the allocated figure is the live blocks' sizes.
    /** @type {number[]} */
    const errors = [];
    const host = {
        ...fakeHost({ base: 0x1000, size: 0x10000 }),
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    };
    const fns = createHeapFunctions(host);
    const heap = fns.HeapCreate.handler([0, 0, 0]);
    fns.HeapAlloc.handler([heap, 0, 0x100]);
    fns.HeapAlloc.handler([heap, 0, 0x200]);
    const freed = fns.HeapAlloc.handler([heap, 0, 0x300]);
    fns.HeapAlloc.handler([fns.GetProcessHeap.handler(), 0, 0x400]);
    fns.HeapFree.handler([heap, 0, freed]);
    const summary = 0x100;
    const dword = (/** @type {number} */ at)=>new DataView(host.bytes.buffer).getUint32(at, true);

    assert.equal(fns.HeapSummary.handler([heap, 0, summary]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER]);

    host.bytes.set([20, 0, 0, 0], summary);
    assert.equal(fns.HeapSummary.handler([heap, 0, summary]), 1);
    assert.equal(dword(summary + 4), 0x300, 'the blocks still allocated in that heap');
    assert.ok(dword(summary + 8) >= dword(summary + 4), 'committed covers allocated');
    assert.ok(dword(summary + 12) >= dword(summary + 8), 'reserved covers committed');
    assert.equal(fns.HeapSummary.argBytes, 12);
});

test('the global functions declare the stack they pop', ()=>{
    const { fns } = setup();
    assert.equal(fns.GlobalAlloc.argBytes, 8);
    assert.equal(fns.GlobalFree.argBytes, 4);
    assert.equal(fns.GlobalLock.argBytes, 4);
    assert.equal(fns.GlobalUnlock.argBytes, 4);
    assert.equal(fns.GlobalSize.argBytes, 4);
    assert.equal(fns.LocalFree.argBytes, 4);
});

test('GlobalMemoryStatusEx reports the arena in 64-bit fields and insists on its own size', ()=>{
    const { host, fns } = setup();
    const view = new DataView(host.bytes.buffer);
    const at = 0x100;
    assert.equal(fns.GlobalMemoryStatusEx.argBytes, 4);

    view.setUint32(at, 32, true);
    assert.equal(fns.GlobalMemoryStatusEx.handler([at]), 0,
        'a MEMORYSTATUS-sized buffer is refused');
    assert.equal(fns.GlobalMemoryStatusEx.handler([0]), 0);

    view.setUint32(at, 64, true);
    assert.equal(fns.GlobalMemoryStatusEx.handler([at]), 1);
    assert.equal(view.getUint32(at, true), 64);
    assert.equal(view.getBigUint64(at + 8, true), BigInt(ARENA.size), 'total physical');
    const free = view.getBigUint64(at + 16, true);
    assert.ok(free > 0n && free <= BigInt(ARENA.size), 'available physical is what the arena has');
    assert.equal(view.getBigUint64(at + 24, true), 2n * BigInt(ARENA.size),
        'the commit limit: memory and a page file as large');
    assert.equal(view.getBigUint64(at + 32, true), free + BigInt(ARENA.size));
    assert.equal(view.getBigUint64(at + 40, true), BigInt(ARENA.size), 'total virtual');
    assert.equal(view.getBigUint64(at + 56, true), 0n, 'no extended virtual');
});

test('GetProcessMemoryInfo reports what the arena handed out, in the form cb asks for', ()=>{
    /** @type {number[]} */
    const errors = [];
    const host = { ...fakeHost(), setLastError: (/** @type {number} */ e)=>errors.push(e) };
    const fns = createHeapFunctions(host);
    const view = new DataView(host.bytes.buffer);
    const at = 0x100;
    assert.equal(fns.K32GetProcessMemoryInfo.argBytes, 12);

    assert.equal(fns.K32GetProcessMemoryInfo.handler([-1, at, 36]), 0, 'too small');
    assert.deepEqual(errors, [24], 'ERROR_BAD_LENGTH');

    const heap = fns.GetProcessHeap.handler();
    assert.notEqual(fns.HeapAlloc.handler([heap, 0, 0x1000]), 0);
    view.setUint32(at + 40, 0xdeadbeef, true);
    assert.equal(fns.K32GetProcessMemoryInfo.handler([-1, at, 40]), 1);
    assert.equal(view.getUint32(at, true), 40);
    const working = view.getUint32(at + 12, true);
    assert.ok(working >= 0x1000 && working <= ARENA.size, 'the working set covers the allocation');
    assert.ok(view.getUint32(at + 8, true) >= working, 'the peak covers the current figure');
    assert.equal(view.getUint32(at + 32, true), working, 'page file use is the same bytes');
    assert.equal(view.getUint32(at + 40, true), 0xdeadbeef, 'the plain form stops at 40 bytes');

    assert.equal(fns.K32GetProcessMemoryInfo.handler([-1, at, 44]), 1);
    assert.equal(view.getUint32(at, true), 44);
    assert.equal(view.getUint32(at + 40, true), view.getUint32(at + 12, true), 'private bytes');
});

test('GetPerformanceInfo reports the arena in pages and takes only its own size', ()=>{
    /** @type {number[]} */
    const errors = [];
    const host = { ...fakeHost(), setLastError: (/** @type {number} */ e)=>errors.push(e) };
    const fns = createHeapFunctions(host);
    const view = new DataView(host.bytes.buffer);
    const at = 0x100;
    assert.equal(fns.K32GetPerformanceInfo.argBytes, 8);
    assert.equal(fns.K32GetPerformanceInfo.handler([at, 55]), 0, 'one byte short');
    assert.equal(fns.K32GetPerformanceInfo.handler([at, 57]), 0, 'one byte over');
    assert.deepEqual(errors, [24, 24], 'ERROR_BAD_LENGTH both ways');

    const heap = fns.GetProcessHeap.handler();
    assert.notEqual(fns.HeapAlloc.handler([heap, 0, 0x2000]), 0);
    assert.equal(fns.K32GetPerformanceInfo.handler([at, 56]), 1);
    const field = (/** @type {number} */ offset)=>view.getUint32(at + offset, true);
    assert.equal(field(0), 56);
    assert.equal(field(40), 4096, 'PageSize');
    assert.equal(field(16), Math.floor(ARENA.size / 4096), 'PhysicalTotal in pages');
    assert.ok(field(4) >= 2 && field(4) <= field(8), 'the commit charge covers the allocation');
    assert.equal(field(4) + field(20), field(16), 'committed and available make the whole');
    assert.ok(field(12) >= field(4), 'the peak covers the current charge');
    assert.equal(field(48), 1, 'the one running process');
    assert.equal(field(52), 1);
});

test('a refused allocation says what was asked and what was left', ()=>{
    // A program told it has run out of memory says so in its own words and
    // exits; the report is the only account of how much it asked for.
    const host = fakeHost();
    /** @type {[string, string][]} */
    const reports = [];
    const fns = createHeapFunctions({
        ...host,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>{
            reports.push([api, detail]);
        },
    });
    const heap = fns.GetProcessHeap.handler();
    assert.notEqual(fns.HeapAlloc.handler([heap, 0, 64]), 0);
    assert.equal(fns.HeapAlloc.handler([heap, 0, ARENA.size * 2]), 0);
    assert.equal(fns.VirtualAlloc.handler([0, ARENA.size * 2, 0x1000, 4]), 0);
    assert.equal(reports.length, 2);
    assert.equal(reports[0][0], 'HeapAlloc');
    assert.match(reports[0][1], /^\d+ bytes refused: \d+ largest free of \d+ free, \d+ used in 1 blocks$/);
    assert.equal(reports[1][0], 'VirtualAlloc');
});

test('a reservation is a whole granule, and a commit inside it is whole pages', ()=>{
    // Windows reserves in 64K granules whatever size was asked, so a program
    // that reserves a size and commits up to the granule's end is within its
    // rights; and a commit names a byte, not a page, and covers the pages the
    // bytes lie in.
    const host = fakeHost({ base: 0x100000, size: 0x200000 });
    /** @type {string[]} */
    const reports = [];
    const fns = createHeapFunctions({
        ...host,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>{
            reports.push(`${api}: ${detail}`);
        },
    });
    const reserved = fns.VirtualAlloc.handler([0, 0x11000, MEM_RESERVE, 4]);
    assert.notEqual(reserved, 0);
    assert.equal(reserved % 0x10000, 0, 'granule aligned');
    // The last page of the granule, past the size that was asked for.
    assert.equal(fns.VirtualAlloc.handler([reserved + 0x1f000, 0x1000, MEM_COMMIT, 4]),
        reserved + 0x1f000, 'the last page of the granule is the program to commit');
    // An unaligned address and a size that reach into the next page.
    assert.equal(fns.VirtualAlloc.handler([reserved + 0x1010, 0x1000, MEM_COMMIT, 4]),
        reserved + 0x1000, 'answered with the page the address is in');
    assert.deepEqual(reports, [], 'nothing was refused');
    // Past the granule is another matter, and says so.
    assert.equal(fns.VirtualAlloc.handler([reserved + 0x20000, 0x1000, MEM_COMMIT, 4]), 0);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /^VirtualAlloc: commit of 4096 bytes at 0x[0-9a-f]+ refused/);
});

test('FlushInstructionCache succeeds, because a program that has written code checks it', ()=>{
    const { fns } = setup();
    // A runtime writes a thunk, flushes, and jumps into it. Failure here is a
    // reason not to jump, and the processor already notices a written code page.
    assert.equal(fns.FlushInstructionCache.handler(), 1);
    assert.equal(fns.FlushInstructionCache.argBytes, 12);
});

test('VirtualQuery on a gap outside the arena answers the whole run up to the next region', ()=>{
    // A crash reporter or heap manager walking the address space with
    // `addr += RegionSize` must see the whole gap, not one page of it. It is
    // reserved rather than free: nothing can be reserved there.
    const host = regionHost([
        { base: 0x10000, size: 0x1000 },
        { base: 0x20000, size: 0x1000 },
    ]);
    const fns = createHeapFunctions(host);
    const buffer = host.arena.base;

    assert.equal(fns.VirtualQuery.handler([0x11234, buffer, MBI.SIZE]), MBI.SIZE);

    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint32(buffer + MBI.BaseAddress, true), 0x11000,
        'BaseAddress rounded down to the page the query address is in');
    assert.equal(view.getUint32(buffer + MBI.AllocationBase, true), 0x11000);
    assert.equal(view.getUint32(buffer + MBI.AllocationProtect, true), PAGE_NOACCESS);
    assert.equal(view.getUint32(buffer + MBI.RegionSize, true), 0x20000 - 0x11000,
        'the gap coalesced into one region, up to the next mapped base');
    assert.equal(view.getUint32(buffer + MBI.State, true), MEM_RESERVE);
    assert.equal(view.getUint32(buffer + MBI.Protect, true), 0);
    assert.equal(view.getUint32(buffer + MBI.Type, true), MEM_PRIVATE);
});

test('VirtualQuery on a mapped image answers MEM_IMAGE from the image base', ()=>{
    // The CRT's __except_handler3 validates a frame's scope table this way: a
    // table not in MEM_IMAGE is not trusted, the frame's filter is never run,
    // and an exception the program itself catches (SetThreadName's
    // 0x406D1388) goes unhandled.
    const host = regionHost([{ base: 0x400000, size: 0x300000, kind: 'image' }]);
    const fns = createHeapFunctions(host);
    const buffer = host.arena.base;

    assert.equal(fns.VirtualQuery.handler([0x6d4878, buffer, MBI.SIZE]), MBI.SIZE);

    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint32(buffer + MBI.BaseAddress, true), 0x6d4000);
    assert.equal(view.getUint32(buffer + MBI.AllocationBase, true), 0x400000,
        'the image base, where its headers are');
    assert.equal(view.getUint32(buffer + MBI.RegionSize, true), 0x700000 - 0x6d4000);
    assert.equal(view.getUint32(buffer + MBI.State, true), MEM_COMMIT);
    assert.equal(view.getUint32(buffer + MBI.Type, true), 0x1000000);
});

test('VirtualQuery on a view of a section answers MEM_MAPPED, as long as the view', ()=>{
    // A program opening a section another made learns its size this way.
    const host = { ...fakeHost(),
        viewAt: (/** @type {number} */ at)=>(at >= 0x7f0000 && at < 0x7f3000
            ? { base: 0x7f0000, length: 0x2100, writable: true } : null) };
    const fns = createHeapFunctions(host);
    const buffer = host.arena.base;
    assert.equal(fns.VirtualQuery.handler([0x7f1234, buffer, MBI.SIZE]), MBI.SIZE);
    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint32(buffer + MBI.BaseAddress, true), 0x7f1000);
    assert.equal(view.getUint32(buffer + MBI.AllocationBase, true), 0x7f0000);
    assert.equal(view.getUint32(buffer + MBI.RegionSize, true), 0x2000,
        'to the view\'s last page, rounded up');
    assert.equal(view.getUint32(buffer + MBI.Protect, true), 0x04, 'PAGE_READWRITE');
    assert.equal(view.getUint32(buffer + MBI.Type, true), 0x40000, 'MEM_MAPPED');
});

test('VirtualQuery above the last region answers up to the top of user address space', ()=>{
    const host = regionHost([{ base: 0x10000, size: 0x1000 }]);
    const fns = createHeapFunctions(host);
    const buffer = host.arena.base;

    assert.equal(fns.VirtualQuery.handler([0x50000, buffer, MBI.SIZE]), MBI.SIZE);

    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint32(buffer + MBI.BaseAddress, true), 0x50000);
    assert.equal(view.getUint32(buffer + MBI.RegionSize, true), USER_ADDRESS_SPACE_TOP - 0x50000);
    assert.equal(view.getUint32(buffer + MBI.State, true), MEM_RESERVE);
});

test('a free-space walker crosses three regions and stops at the top, never with a RegionSize of 0',
    ()=>{
        // The §13.8 regression: `for (a = 0; a < top; a += mbi.RegionSize)`
        // must step over each gap once, not 4 KiB at a time across it -- and,
        // at the real top of user address space, must be refused outright
        // rather than answered a free region it can never step across.
        const regions = [
            { base: 0x2000, size: 0x1000 },
            { base: 0x8000, size: 0x2000 },
            { base: 0x20000, size: 0x1000 },
        ];
        const host = regionHost(regions);
        const fns = createHeapFunctions(host);
        const buffer = host.arena.base;
        const view = new DataView(host.bytes.buffer);

        let address = 0;
        let calls = 0;
        let ret;
        for (;;)
        {
            ret = fns.VirtualQuery.handler([address, buffer, MBI.SIZE]);
            calls++;
            assert.ok(calls <= 2 * regions.length + 2,
                `not one page at a time (${calls} calls)`);
            if (ret === 0)
                break;
            const regionSize = view.getUint32(buffer + MBI.RegionSize, true);
            assert.ok(regionSize > 0, 'every answer advances the walk, never stalls at 0');
            address += regionSize;
        }

        assert.equal(ret, 0,
            'the walker is refused at the top of address space, never left spinning there');
    });

/**
 * The heap functions over an arena the memory layer maps as one region, as the
 * machine maps it, with somewhere below it for the answers to be written.
 */
function arenaQuery(){
    const host = {
        ...fakeHost(RESERVING_ARENA),
        /** @param {number} address */
        regionAt: address=>address >= RESERVING_ARENA.base
            && address < RESERVING_ARENA.base + RESERVING_ARENA.size ? RESERVING_ARENA : null,
        /** @param {number} address */
        nextRegionAfter: address=>address < RESERVING_ARENA.base ? RESERVING_ARENA : null,
    };
    const fns = createHeapFunctions(host);
    const buffer = 0x100;
    const view = new DataView(host.bytes.buffer);
    /** @param {number} address */
    const query = address=>{
        assert.equal(fns.VirtualQuery.handler([address, buffer, MBI.SIZE]), MBI.SIZE);
        return {
            base: view.getUint32(buffer + MBI.BaseAddress, true),
            allocationBase: view.getUint32(buffer + MBI.AllocationBase, true),
            size: view.getUint32(buffer + MBI.RegionSize, true),
            state: view.getUint32(buffer + MBI.State, true),
            protect: view.getUint32(buffer + MBI.Protect, true),
        };
    };
    return { fns, query };
}

test('VirtualQuery inside a reservation answers the reservation, page by page as committed',
    ()=>{
        // Wine's VirtualAlloc test: a reservation is its own allocation, its
        // pages are reserved until committed, and a query answers the run of
        // pages that share the state of the one asked about.
        const { fns, query } = arenaQuery();
        const reserved = fns.VirtualAlloc.handler([0, 2 * GRANULARITY, MEM_RESERVE, 1]);
        assert.notEqual(reserved, 0);
        assert.equal(fns.VirtualAlloc.handler([reserved + 0x1000, 0x1000, MEM_COMMIT, 4]),
            reserved + 0x1000);

        assert.deepEqual(query(reserved), { base: reserved, allocationBase: reserved,
            size: 0x1000, state: MEM_RESERVE, protect: 0 });
        assert.deepEqual(query(reserved + 0x1234), { base: reserved + 0x1000,
            allocationBase: reserved, size: 0x1000, state: MEM_COMMIT, protect: 0x40 });
        assert.deepEqual(query(reserved + 0x8000), { base: reserved + 0x8000,
            allocationBase: reserved, size: 2 * GRANULARITY - 0x8000, state: MEM_RESERVE,
            protect: 0 });

        assert.equal(fns.VirtualFree.handler([reserved + 0x1000, 0x1000, MEM_DECOMMIT]), 1);
        assert.equal(query(reserved).size, 2 * GRANULARITY, 'decommitted, it is reserved again');

        const committed = fns.VirtualAlloc.handler([0, 0x1000, MEM_COMMIT, 4]);
        assert.deepEqual(query(committed), { base: committed, allocationBase: committed,
            size: 0x1000, state: MEM_COMMIT, protect: 0x40 });
    });

test('VirtualQuery says free only where VirtualAlloc can reserve', ()=>{
    // "Free pages ... available to be allocated": an address the arena does
    // not reach cannot be reserved, and a walker looking for room to reserve
    // must not be sent there.
    const { fns, query } = arenaQuery();
    const inside = RESERVING_ARENA.base + 2 * GRANULARITY;
    assert.equal(query(inside).state, MEM_FREE);
    assert.equal(fns.VirtualAlloc.handler([inside, GRANULARITY, MEM_RESERVE, 1]), inside);

    const above = RESERVING_ARENA.base + RESERVING_ARENA.size + GRANULARITY;
    assert.equal(query(above).state, MEM_RESERVE);
    assert.equal(fns.VirtualAlloc.handler([above, GRANULARITY, MEM_RESERVE, 1]), 0);
    assert.equal(query(0x3000).state, MEM_RESERVE, 'below the arena too');
});

test('VirtualQuery at or above the top of user address space is refused, not answered as free',
    ()=>{
        // Windows: NtQueryVirtualMemory refuses an address at or above
        // lpMaximumApplicationAddress; VirtualQueryEx turns that into
        // 0 / ERROR_INVALID_PARAMETER, which is what stops a walker there.
        /** @type {number[]} */
        const errors = [];
        /** @param {number} e */
        const setLastError = e=>{ errors.push(e); };
        const host = { ...regionHost([]), setLastError };
        const fns = createHeapFunctions(host);
        const buffer = host.arena.base;

        assert.equal(fns.VirtualQuery.handler([0x80001000, buffer, MBI.SIZE]), 0,
            'an address above the limit is refused outright, not answered as a huge free region');
        assert.deepEqual(errors, [ERROR_INVALID_PARAMETER]);
    });

test('VirtualProtect with nowhere to write the old protection fails with ERROR_NOACCESS', ()=>{
    // Wine's kernel32 virtual test_VirtualProtect: the old protection is not
    // optional, and nothing is changed without it.
    /** @type {number[]} */
    const errors = [];
    const host = { ...fakeHost(RESERVING_ARENA), setLastError: (/** @type {number} */ code)=>
        errors.push(code) };
    const fns = createHeapFunctions(host);
    const base = fns.VirtualAlloc.handler([0, 4096, 0x3000, 0x04]);
    assert.notEqual(base, 0);
    assert.equal(fns.VirtualProtect.handler([base, 4096, 0x02, 0]), 0);
    assert.deepEqual(errors, [998]);
});

test('the Ex forms act on the running process, and refuse any other', ()=>{
    /** @type {number[]} */
    const errors = [];
    const host = { ...fakeHost(RESERVING_ARENA), setLastError: (/** @type {number} */ code)=>
        errors.push(code) };
    const fns = createHeapFunctions(host);
    const self = 0xffffffff;

    const base = fns.VirtualAllocEx.handler([self, 0, 0x8000, 0x1000, 0x40]);
    assert.notEqual(base, 0);
    assert.equal(fns.VirtualQueryEx.handler([self, base, 0x100, 28]), 28);
    assert.equal(fns.VirtualProtectEx.handler([self, base, 4096, 0x04, 0x200]), 1);
    assert.equal(fns.VirtualFreeEx.handler([0, base, 0, 0x8000]), 0, 'no process at all');
    assert.equal(fns.VirtualAllocEx.handler([0, 0, 0x8000, 0x1000, 0x40]), 0);
    assert.deepEqual(errors, [6, 6], 'ERROR_INVALID_HANDLE, as Windows says for NULL');
    assert.equal(fns.VirtualFreeEx.handler([self, base, 0, 0x8000]), 1);

    assert.equal(fns.VirtualAllocEx.handler([0x44, 0, 0x8000, 0x1000, 0x40]), 0,
        'a child\'s address space does not exist before it runs');
    assert.equal(fns.VirtualAllocEx.argBytes, 20);
    assert.equal(fns.VirtualFreeEx.argBytes, 16);
    assert.equal(fns.VirtualProtectEx.argBytes, 20);
    assert.equal(fns.VirtualQueryEx.argBytes, 16);
});

test('GetWriteWatch tells every committed page of a watched reservation as written', ()=>{
    // Writes are not tracked, so the answer errs on the side a collector can
    // live with: it rescans more than it must, never less.
    const MEM_WRITE_WATCH = 0x200000;
    const ERROR_NOACCESS = 998;
    const FAILED = 0xffffffff;
    const { host, errors, fns } = recording();
    const view = new DataView(host.bytes.buffer);
    const base = fns.VirtualAlloc.handler([0, 3 * PAGE_SIZE, MEM_RESERVE | MEM_WRITE_WATCH, 0x04]);
    assert.notEqual(base, 0);
    /** @param {number} from @param {number} size @param {number} room */
    const watch = (from, size, room)=>{
        view.setUint32(0x100, room, true);
        return fns.GetWriteWatch.handler([0, from, size, 0x200, 0x100, 0x104]);
    };
    assert.equal(watch(base, 3 * PAGE_SIZE, 64), 0);
    assert.equal(view.getUint32(0x100, true), 0, 'nothing committed, nothing written');

    fns.VirtualAlloc.handler([base + PAGE_SIZE, 2 * PAGE_SIZE, MEM_COMMIT, 0x04]);
    assert.equal(watch(base, 3 * PAGE_SIZE, 64), 0);
    assert.equal(view.getUint32(0x100, true), 2);
    assert.deepEqual([view.getUint32(0x200, true), view.getUint32(0x204, true)],
        [base + PAGE_SIZE, base + 2 * PAGE_SIZE]);
    assert.equal(view.getUint32(0x104, true), PAGE_SIZE, 'the granularity is a page');
    assert.equal(watch(base, 3 * PAGE_SIZE, 1), 0);
    assert.equal(view.getUint32(0x100, true), 1, 'no more than there is room for');
    assert.equal(fns.ResetWriteWatch.handler([base, PAGE_SIZE]), 0);

    assert.equal(watch(base, 3 * PAGE_SIZE, 0), FAILED, 'no room at all');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(fns.GetWriteWatch.handler([0, base, PAGE_SIZE, 0x200, 0, 0x104]), FAILED);
    assert.equal(errors.at(-1), ERROR_NOACCESS, 'nowhere to say how many');
    assert.equal(watch(base, 0, 64), FAILED, 'an empty range');
    assert.equal(watch(base + 2 * PAGE_SIZE, GRANULARITY, 64), FAILED, 'past the reservation');
    const plain = fns.VirtualAlloc.handler([0, PAGE_SIZE, MEM_RESERVE | MEM_COMMIT, 0x04]);
    assert.equal(watch(plain, PAGE_SIZE, 64), FAILED, 'a reservation made without the watch');
    assert.equal(fns.ResetWriteWatch.handler([plain, PAGE_SIZE]), FAILED);
    fns.VirtualFree.handler([base, 0, MEM_RELEASE]);
    assert.equal(watch(base, PAGE_SIZE, 64), FAILED, 'a released reservation is watched no more');
});

test('kernel32\'s Rtl memory routines move, zero and fill, overlap either way', ()=>{
    const { host, fns: typed } = setup();
    const fns = /** @type {any} */ (typed);
    const at = ARENA.base;
    host.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], at);
    assert.equal(fns.RtlMoveMemory.argBytes, 12);
    fns.RtlMoveMemory.handler([at + 2, at, 6]);
    assert.deepEqual([...host.bytes.subarray(at, at + 8)], [1, 2, 1, 2, 3, 4, 5, 6],
        'forward over itself, as memmove');
    fns.RtlMoveMemory.handler([at, at + 2, 6]);
    assert.deepEqual([...host.bytes.subarray(at, at + 8)], [1, 2, 3, 4, 5, 6, 5, 6],
        'and backward');

    assert.equal(fns.RtlFillMemory.argBytes, 12);
    fns.RtlFillMemory.handler([at, 3, 0x1ab]);
    assert.deepEqual([...host.bytes.subarray(at, at + 4)], [0xab, 0xab, 0xab, 4],
        'the fill comes last, and only its low byte');
    assert.equal(fns.RtlZeroMemory.argBytes, 8);
    fns.RtlZeroMemory.handler([at, 2]);
    assert.deepEqual([...host.bytes.subarray(at, at + 4)], [0, 0, 0xab, 4]);

    const before = host.written();
    fns.RtlMoveMemory.handler([at, at + 4, 0]);
    fns.RtlZeroMemory.handler([at, 0]);
    assert.equal(host.written(), before, 'a length of zero touches nothing');
});

test('GlobalCompact, LocalCompact and LocalShrink answer the process heap\'s largest free block',
    ()=>{
        const fns = /** @type {any} */ (setup().fns);
        const heap = fns.GetProcessHeap.handler([]);
        const largest = fns.HeapCompact.handler([heap, 0]);
        assert.ok(largest > 0);
        assert.equal(fns.GlobalCompact.handler([0]), largest);
        assert.equal(fns.LocalCompact.handler([0]), largest);
        assert.equal(fns.LocalShrink.handler([0, 0]), largest);
        assert.deepEqual([fns.GlobalCompact.argBytes, fns.LocalCompact.argBytes,
            fns.LocalShrink.argBytes], [4, 4, 8]);
        fns.HeapAlloc.handler([heap, 0, 0x100]);
        assert.ok(fns.GlobalCompact.handler([0]) < largest, 'and it is measured, not fixed');
    });

test('the block an address falls inside is the one a walk over every live block finds,'
    + ' whatever was allocated and freed before', ()=>{
    // The allocator answers from blocks kept in address order; the walk is the
    // answer by definition. Seeded, so a failure names the program that makes it.
    for (let seed = 1; seed <= 20; seed++)
    {
        let state = seed;
        const next = (/** @type {number} */ below)=>{
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return (state >>> 0) % below;
        };
        const base = 0x100000;
        const size = 0x400000;
        const allocator = createHeapAllocator({ base, size });
        /** @type {number[]} */
        const held = [];
        for (let step = 0; step < 600; step++)
        {
            if (held.length > 0 && next(3) === 0)
            {
                const [address] = held.splice(next(held.length), 1);
                assert.equal(allocator.free(address), true);
            }
            else
            {
                const address = allocator.allocate(8 + next(0x3000));
                if (address !== 0)
                {
                    held.push(address);
                }
            }
            const probe = base + next(size);
            const walked = held.map(address=>/** @type {any} */ (allocator.block(address)))
                .find(block=>probe >= block.address && probe < block.address + block.capacity)
                ?? null;
            assert.equal(allocator.blockContaining(probe), walked,
                `seed ${seed}, step ${step}, address 0x${probe.toString(16)}`);
        }
    }
});

test('the VirtualQuery answer for an arena page outside every reservation is the one a walk'
    + ' over every free span and every reservation gives', ()=>{
    const PAGE = 4096;
    const roundUp = (/** @type {number} */ v, /** @type {number} */ to)=>Math.ceil(v / to) * to;
    /** The answer as it was: every free span, then every reservation and span. */
    /**
     * @param {any} allocator @param {number} page @param {number} arenaEnd
     * @param {Set<number>} reservations
     */
    const walked = (allocator, page, arenaEnd, reservations)=>{
        /** @type {{ base: number, size: number }[]} */
        const spans = allocator.freeSpans();
        const free = spans.find(span=>span.base <= page && span.base + span.size >= page + PAGE);
        if (free)
        {
            return { free: true, end: ((free.base + free.size) & ~(PAGE - 1)) >>> 0 };
        }
        let end = arenaEnd;
        for (const reservation of reservations)
        {
            if (reservation > page && reservation < end)
            {
                end = reservation;
            }
        }
        for (const span of spans)
        {
            const first = roundUp(span.base, PAGE);
            if (first > page && first + PAGE <= span.base + span.size && first < end)
            {
                end = first;
            }
        }
        return { free: false, end };
    };
    for (let seed = 1; seed <= 20; seed++)
    {
        let state = seed;
        const next = (/** @type {number} */ below)=>{
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return (state >>> 0) % below;
        };
        const base = 0x100000;
        const size = 0x200000;
        const allocator = createHeapAllocator({ base, size });
        const reserve = {};
        const heap = {};
        /** @type {number[]} */
        const held = [];
        const reservations = new Set();
        for (let step = 0; step < 400; step++)
        {
            if (held.length > 0 && next(3) === 0)
            {
                const [address] = held.splice(next(held.length), 1);
                reservations.delete(address);
                allocator.free(address);
            }
            else
            {
                const reserving = next(4) === 0;
                const address = allocator.allocate(reserving ? 0x10000 : 8 + next(0x2000),
                    { owner: reserving ? reserve : heap });
                if (address !== 0)
                {
                    held.push(address);
                    if (reserving)
                    {
                        reservations.add(address);
                    }
                }
            }
            const page = (base + next(size)) & ~(PAGE - 1);
            const block = allocator.blockContaining(page);
            if (block && block.owner === reserve)
            {
                continue;
            }
            assert.deepEqual(arenaRegion(allocator, page, base, base + size,
                one=>one.owner === reserve), walked(allocator, page, base + size, reservations),
            `seed ${seed}, step ${step}, page 0x${page.toString(16)}`);
        }
    }
});

test('the address index answers what one sorted array answers, across splits and emptied'
    + ' runs', ()=>{
    const index = createAddressIndex();
    /** @type {{ address: number }[]} */
    const model = [];
    let seed = 0x2f6e2b1;
    const next = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed;
    };
    /** @param {number} address */
    const modelAtOrBefore = address=>{
        let found;
        for (const block of model)
        {
            if (block.address <= address)
            {
                found = block;
            }
        }
        return found;
    };
    for (let step = 0; step < 20000; step++)
    {
        const address = (next() % 4000) * 8;
        const present = model.findIndex(block=>block.address === address);
        if (present < 0 && next() % 3 !== 0)
        {
            const block = /** @type {any} */ ({ address });
            index.insert(block);
            model.splice(model.findIndex(one=>one.address > address) >>> 0, 0, block);
        }
        else if (present >= 0)
        {
            index.remove(address);
            model.splice(present, 1);
        }
        const probe = (next() % 4100) * 8 - 64;
        assert.equal(index.atOrBefore(probe), modelAtOrBefore(probe), `step ${step} at ${probe}`);
        if (step % 500 === 0)
        {
            assert.deepEqual([...index.above(probe)], model.filter(block=>block.address > probe),
                `step ${step} above ${probe}`);
        }
    }
});

test('MEM_RESERVE with MEM_COMMIT at an address commits from the base it answers', ()=>{
    const { fns, host } = recording();
    const wanted = 3 * GRANULARITY + 0x8000;
    assert.equal(fns.VirtualAlloc.handler([wanted, 0x400, MEM_RESERVE | MEM_COMMIT, 0x40]),
        3 * GRANULARITY, 'the granule the address is in');
    const buffer = fns.VirtualAlloc.handler([0, PAGE_SIZE, MEM_RESERVE | MEM_COMMIT, 0x04]);
    assert.notEqual(buffer, 0);
    assert.equal(fns.VirtualQuery.handler([3 * GRANULARITY, buffer, MBI.SIZE]), MBI.SIZE);
    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint32(buffer + MBI.State, true), MEM_COMMIT,
        'the base itself is committed, where the program writes first');
    assert.equal(view.getUint32(buffer + MBI.RegionSize, true), 0x9000,
        'through the page the last byte asked for');
});

test('GlobalMemoryStatus answers a commit limit past memory, as a machine that pages does', ()=>{
    // A program refuses one whose limit is no more than its memory: paging off.
    const { host, fns } = setup();
    const view = new DataView(host.bytes.buffer);
    const at = 0x100;
    fns.GlobalMemoryStatus.handler([at]);
    assert.ok(view.getUint32(at + 16, true) > view.getUint32(at + 8, true),
        'dwTotalPageFile past dwTotalPhys');
    assert.ok(view.getUint32(at + 20, true) > view.getUint32(at + 12, true),
        'and what is free of it past free memory');
});

test('QueryWorkingSetEx: a committed page is resident with its protection, an image\'s shared',
    ()=>{
        const host = regionHost([
            { base: 0x10000, size: 0x1000 },
            { base: 0x20000, size: 0x1000, kind: 'image' },
        ]);
        const fns = createHeapFunctions(host);
        const at = host.arena.base;
        const view = new DataView(host.bytes.buffer);
        [0x10010, 0x20020, 0x30000].forEach((address, index)=>{
            view.setUint32(at + index * 8, address, true);
            view.setUint32(at + index * 8 + 4, 0xffffffff, true);
        });
        assert.equal(fns.K32QueryWorkingSetEx.handler([0xffffffff, at, 24]), 1);
        assert.equal(view.getUint32(at + 4, true), 1 | 0x40 << 4, 'valid, read-write-execute');
        assert.equal(view.getUint32(at + 12, true), 1 | 1 << 1 | 0x40 << 4 | 1 << 15,
            'an image\'s page is shared');
        assert.equal(view.getUint32(at + 20, true), 0, 'a reserved gap is not valid');
        assert.equal(view.getUint32(at, true), 0x10010, 'the address is left as it was');
        assert.equal(fns.K32QueryWorkingSetEx.handler([0xffffffff, at, 4]), 0);
        assert.equal(fns.K32QueryWorkingSetEx.handler([0x44, at, 24]), 0);

        assert.equal(fns.DiscardVirtualMemory.handler([0x10000, 0x1000]), 0);
        assert.equal(fns.DiscardVirtualMemory.handler([0x30000, 0x1000]), 87);
    });

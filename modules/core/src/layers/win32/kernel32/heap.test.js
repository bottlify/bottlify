/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeapAllocator, createHeapFunctions } from './heap.js';

const HEAP_ZERO_MEMORY = 0x8;
const HEAP_REALLOC_IN_PLACE_ONLY = 0x10;
const MEM_COMMIT = 0x1000;
const MEM_RESERVE = 0x2000;
const MEM_DECOMMIT = 0x4000;
const MEM_RELEASE = 0x8000;
const INVALID_SIZE = 0xffffffff;
const PAGE_SIZE = 4096;
const GMEM_MOVEABLE = 0x0002;
const GMEM_ZEROINIT = 0x0040;

const ARENA = { base: 0x1000, size: 0x4000 };

/**
 * Guest memory, dirtied on purpose.
 *
 * Every byte starts at 0xaa so that "this range is zero" is an assertion about
 * what the allocator did, not about what a fresh buffer happened to contain.
 */
function fakeHost(arena = ARENA){
    const bytes = new Uint8Array(arena.base + arena.size);
    bytes.fill(0xaa);

    return {
        bytes,
        arena,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory(address, data){
            for (let i = 0; i < data.length; i++)
            {
                bytes[address + i] = data[i];
            }
        },
    };
}

function setup(arena = ARENA){
    const host = fakeHost(arena);
    return { host, fns: createHeapFunctions(host) };
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

    const dirty = fns.HeapAlloc.handler([heap, 0, 64]);
    const clean = fns.HeapAlloc.handler([heap, HEAP_ZERO_MEMORY, 64]);

    assert.ok(all(host.bytes.subarray(clean, clean + 64), 0),
        'the flag is the whole reason a program passes it');
    assert.ok(dirty !== 0);
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

test('VirtualAlloc commits page-aligned, zeroed memory', ()=>{
    const { host, fns } = setup();

    const address = fns.VirtualAlloc.handler([0, 100, MEM_COMMIT | MEM_RESERVE, 0x04]);

    assert.notEqual(address, 0);
    assert.equal(address % PAGE_SIZE, 0);
    assert.ok(all(host.bytes.subarray(address, address + PAGE_SIZE), 0),
        'a committed page reads as zero on Windows, and code depends on it');
    assert.equal(fns.VirtualAlloc.handler([0, 0, MEM_COMMIT, 0x04]), 0, 'zero bytes is a failure');
});

test('VirtualFree releases whole reservations only', ()=>{
    const { fns } = setup();
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

test('a zero-initialised global allocation is actually zeroed', ()=>{
    const { host, fns } = setup();

    const handle = fns.GlobalAlloc.handler([GMEM_ZEROINIT, 32]);
    assert.equal(all(host.bytes.subarray(handle, handle + 32), 0), true);

    const dirty = fns.GlobalAlloc.handler([0, 32]);
    assert.equal(all(host.bytes.subarray(dirty, dirty + 32), 0xaa), true,
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

test('the global functions declare the stack they pop', ()=>{
    const { fns } = setup();
    assert.equal(fns.GlobalAlloc.argBytes, 8);
    assert.equal(fns.GlobalFree.argBytes, 4);
    assert.equal(fns.GlobalLock.argBytes, 4);
    assert.equal(fns.GlobalUnlock.argBytes, 4);
    assert.equal(fns.GlobalSize.argBytes, 4);
    assert.equal(fns.LocalFree.argBytes, 4);
});

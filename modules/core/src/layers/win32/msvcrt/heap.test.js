/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeapFunctions } from './heap.js';
import { fakeMemory } from './harness.test.js';

/**
 * An allocator with the same surface as the process heap, and a switch that
 * makes the next allocation fail -- the case realloc must survive without
 * losing the block it was given.
 *
 * @param {any} memory
 */
function fakeAllocator(memory){
    /** @type {Map<number, { size: number, capacity: number }>} */
    const live = new Map();
    /** Freed blocks come back, which is what makes calloc's zeroing matter. */
    const recycled = /** @type {{ at: number, capacity: number }[]} */ ([]);
    let exhausted = false;
    return {
        exhaust(){
            exhausted = true;
        },
        allocate(/** @type {number} */ bytes){
            if (exhausted)
            {
                return 0;
            }
            const capacity = Math.max(bytes, 8);
            const reused = recycled.findIndex(block=>block.capacity >= capacity);
            const at = reused === -1
                ? memory.allocate(capacity)
                : recycled.splice(reused, 1)[0].at;
            live.set(at, { size: bytes, capacity });
            return at;
        },
        free(/** @type {number} */ address){
            const block = live.get(address);
            if (block)
            {
                recycled.push({ at: address, capacity: block.capacity });
            }
            return live.delete(address);
        },
        block: (/** @type {number} */ address)=>live.get(address) ?? null,
        resize(/** @type {number} */ address, /** @type {number} */ bytes){
            const block = live.get(address);
            if (!block || bytes > block.capacity)
            {
                return false;
            }
            block.size = bytes;
            return true;
        },
    };
}

const build = ()=>{
    const memory = fakeMemory();
    const allocator = fakeAllocator(memory);
    /** @type {number[]} */
    const errno = [];
    return {
        memory,
        allocator,
        errno,
        table: /** @type {Record<string, any>} */ (createHeapFunctions({
            allocate: bytes=>allocator.allocate(bytes),
            free: address=>allocator.free(address),
            block: address=>allocator.block(address),
            resize: (address, bytes)=>allocator.resize(address, bytes),
            readMemory: memory.readMemory,
            writeMemory: memory.writeMemory,
            fillMemory: memory.fillMemory,
            errno: code=>errno.push(code),
        })),
    };
};

test('_aligned_malloc answers a multiple of any power of two, and refuses anything else', ()=>{
    // Wine's msvcrt test_aligned: 256 bytes at each power of two, zero
    // among them, is a block that far aligned; at 3 or 127 it is NULL and
    // EINVAL. "If alignment isn't a power of 2 or size is zero ... returns
    // NULL and sets errno to EINVAL"; a failed allocation is ENOMEM.
    const { memory, allocator, errno, table } = build();
    for (const alignment of [0, 1, 2, 4, 8, 16, 32, 64, 128])
    {
        const block = table._aligned_malloc.handler([256, alignment]);
        assert.notEqual(block, 0, String(alignment));
        assert.equal(block % Math.max(alignment, 1), 0, String(alignment));
        const base = memory.u32(block - 4);
        assert.ok((allocator.block(base)?.size ?? 0) >= block - base + 256,
            'the whole request fits');
        assert.equal(table._aligned_free.handler([block]), 0);
        assert.equal(allocator.block(base), null, '_aligned_free frees what malloc gave');
    }
    assert.deepEqual(errno, []);
    assert.equal(table._aligned_malloc.handler([256, 3]), 0);
    assert.equal(table._aligned_malloc.handler([256, 127]), 0);
    assert.equal(table._aligned_malloc.handler([0, 16]), 0);
    allocator.exhaust();
    assert.equal(table._aligned_malloc.handler([256, 16]), 0);
    const [EINVAL, ENOMEM] = [22, 12];
    assert.deepEqual(errno, [EINVAL, EINVAL, EINVAL, ENOMEM]);
    assert.doesNotThrow(()=>table._aligned_free.handler([0]), 'freeing NULL does nothing');
    assert.deepEqual([table._aligned_malloc.argBytes, table._aligned_free.argBytes], [8, 4]);
});

test('malloc answers a distinct address and _msize remembers the request', ()=>{
    const { table } = build();
    const first = table.malloc.handler([16]);
    const second = table.malloc.handler([16]);
    assert.notEqual(first, second);
    assert.equal(table._msize.handler([first]), 16);
});

test('calloc zeroes what it hands back', ()=>{
    const { memory, table } = build();
    const dirty = table.malloc.handler([16]);
    memory.writeMemory(dirty, new Uint8Array(16).fill(0xcd));
    table.free.handler([dirty]);

    const clean = table.calloc.handler([4, 4]);
    assert.deepEqual([...memory.readMemory(clean, 16)], new Array(16).fill(0));
});

test('freeing null is a no-op rather than a failure', ()=>{
    const { table } = build();
    assert.doesNotThrow(()=>table.free.handler([0]));
});

test('realloc of null is malloc, and to zero bytes is free', ()=>{
    const { table } = build();
    const fresh = table.realloc.handler([0, 8]);
    assert.notEqual(fresh, 0);
    assert.equal(table.realloc.handler([fresh, 0]), 0);
    assert.equal(table._msize.handler([fresh]), 0, 'the block is gone');
});

test('realloc keeps the contents when it has to move the block', ()=>{
    const { memory, table } = build();
    const original = table.malloc.handler([8]);
    memory.writeMemory(original, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const moved = table.realloc.handler([original, 64]);
    assert.notEqual(moved, original, 'it cannot grow in place here');
    assert.deepEqual([...memory.readMemory(moved, 8)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a realloc that cannot be satisfied leaves the original block alive', ()=>{
    const { table, allocator } = build();
    const original = table.malloc.handler([8]);
    allocator.exhaust();
    assert.equal(table.realloc.handler([original, 64]), 0);
    assert.equal(table._msize.handler([original]), 8, 'still there to be freed');
});

test('realloc shrinking stays where it is', ()=>{
    const { table } = build();
    const original = table.malloc.handler([64]);
    assert.equal(table.realloc.handler([original, 8]), original);
    assert.equal(table._msize.handler([original]), 8);
});

test('_expand refuses to move, answering null instead', ()=>{
    const { table } = build();
    const original = table.malloc.handler([8]);
    assert.equal(table._expand.handler([original, 4]), original);
    assert.equal(table._expand.handler([original, 4096]), 0);
});

test('operator new and delete are the same allocator as malloc and free', ()=>{
    const { table } = build();
    const fromNew = table['??2@YAPAXI@Z'].handler([32]);
    assert.equal(table._msize.handler([fromNew]), 32);
    // A program that news and frees, or mallocs and deletes, must survive it.
    table.free.handler([fromNew]);
    assert.equal(table._msize.handler([fromNew]), 0);

    const fromMalloc = table.malloc.handler([32]);
    table['??3@YAXPAX@Z'].handler([fromMalloc]);
    assert.equal(table._msize.handler([fromMalloc]), 0);
});

test('an allocation this heap cannot make is null, not an exception', ()=>{
    const { table, allocator } = build();
    allocator.exhaust();
    assert.equal(table.malloc.handler([16]), 0);
    assert.equal(table['??2@YAPAXI@Z'].handler([16]), 0);
});

test('a failed operator new calls the new handler until it gives up or memory is found', async()=>{
    const memory = fakeMemory();
    const allocator = fakeAllocator(memory);
    allocator.exhaust();
    /** @type {number[][]} */
    const calls = [];
    let answers = [1, 1, 0];
    const table = /** @type {Record<string, any>} */ (createHeapFunctions({
        allocate: bytes=>allocator.allocate(bytes),
        free: address=>allocator.free(address),
        block: address=>allocator.block(address),
        resize: (address, bytes)=>allocator.resize(address, bytes),
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        fillMemory: memory.fillMemory,
        callGuest: async(entry, args)=>{
            calls.push([entry, ...args]);
            return /** @type {number} */ (answers.shift());
        },
    }));
    const SET = '?_set_new_handler@@YAP6AHI@ZP6AHI@Z@Z';

    assert.equal(table['??2@YAPAXI@Z'].handler([16]), 0, 'no handler: null at once');
    assert.equal(table[SET].handler([0x401000]), 0, 'the previous handler, none');
    assert.equal(table['?_query_new_handler@@YAP6AHI@ZXZ'].handler([]), 0x401000);

    assert.equal(await table['??2@YAPAXI@Z'].handler([16]), 0);
    assert.deepEqual(calls, [[0x401000, 16], [0x401000, 16], [0x401000, 16]],
        'called again while it answers nonzero, null when it answers zero');

    // A handler that frees something: the retry finds memory.
    calls.length = 0;
    answers = [1];
    const real = fakeAllocator(memory);
    let failOnce = true;
    allocator.allocate = bytes=>{
        if (failOnce)
        {
            failOnce = false;
            return 0;
        }
        return real.allocate(bytes);
    };
    const address = await table['??_U@YAPAXI@Z'].handler([24]);
    assert.notEqual(address, 0);
    assert.equal(calls.length, 1);

    assert.equal(table[SET].handler([0]), 0x401000);
});

test('malloc calls the new handler only in new mode 1, and _callnewh calls it once', async()=>{
    const memory = fakeMemory();
    const allocator = fakeAllocator(memory);
    /** @type {number[]} */
    const errno = [];
    let called = 0;
    const table = /** @type {Record<string, any>} */ (createHeapFunctions({
        allocate: bytes=>allocator.allocate(bytes),
        free: address=>allocator.free(address),
        block: address=>allocator.block(address),
        resize: (address, bytes)=>allocator.resize(address, bytes),
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        fillMemory: memory.fillMemory,
        errno: code=>errno.push(code),
        callGuest: async()=>{
            called++;
            return 0;
        },
    }));
    const SET_MODE = '?_set_new_mode@@YAHH@Z';
    assert.equal(table._callnewh.handler([8]), 0, 'no handler to call');
    table['?_set_new_handler@@YAP6AHI@ZP6AHI@Z@Z'].handler([0x402000]);
    allocator.exhaust();

    assert.equal(table.malloc.handler([8]), 0, 'mode 0: malloc does not call it');
    assert.equal(called, 0);
    assert.equal(table[SET_MODE].handler([1]), 0);
    assert.equal(table['?_query_new_mode@@YAHXZ'].handler([]), 1);
    assert.equal(await table.malloc.handler([8]), 0);
    assert.equal(called, 1);
    assert.equal(await table._callnewh.handler([8]), 0, 'it freed nothing');
    assert.equal(called, 2);

    assert.equal(table[SET_MODE].handler([2]), -1);
    assert.deepEqual(errno, [22]);
    assert.equal(table['?_query_new_mode@@YAHXZ'].handler([]), 1, 'the mode kept');
});

test('_heapchk finds the heap whole: _HEAPOK', ()=>{
    const { table } = build();
    table.malloc.handler([16]);
    assert.equal(table._heapchk.handler([]) | 0, -2);
});

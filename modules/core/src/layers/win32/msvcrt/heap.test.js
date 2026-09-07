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
    return {
        memory,
        allocator,
        table: /** @type {Record<string, any>} */ (createHeapFunctions({
            allocate: bytes=>allocator.allocate(bytes),
            free: address=>allocator.free(address),
            block: address=>allocator.block(address),
            resize: (address, bytes)=>allocator.resize(address, bytes),
            readMemory: memory.readMemory,
            writeMemory: memory.writeMemory,
        })),
    };
};

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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_ORDINALS, createDataStructureFunctions } from './dpa.js';

/**
 * A guest of plain memory, a heap that remembers each block's size, and
 * callbacks that are JavaScript functions at made-up addresses.
 */
function machine(){
    const memory = new Uint8Array(0x40000);
    const sizes = new Map();
    let next = 0x1000;
    const allocate = (/** @type {number} */ bytes)=>{
        const at = next;
        next += Math.max(16, bytes + 15 & ~15);
        sizes.set(at, bytes);
        memory.fill(0, at, at + bytes);
        return at;
    };
    /** @type {Record<string, (args: number[]) => number>} */
    const kernel32 = {
        GetProcessHeap: ()=>0x77,
        HeapAlloc: ([, , bytes])=>allocate(bytes),
        HeapReAlloc: ([, , old, bytes])=>{
            const at = allocate(bytes);
            memory.copyWithin(at, old, old + Math.min(sizes.get(old), bytes));
            return at;
        },
        HeapFree: ([, , at])=>(sizes.delete(at) ? 1 : 0),
        LocalAlloc: ([, bytes])=>allocate(bytes),
        LocalReAlloc: ([old, bytes])=>kernel32.HeapReAlloc([0, 0, old, bytes]),
        LocalFree: ([at])=>(sizes.delete(at) ? 0 : at),
        LocalSize: ([at])=>sizes.get(at) ?? 0,
        SetLastError: ()=>0,
    };
    /** @type {Map<number, (...args: number[]) => number>} */
    const callbacks = new Map();
    const f = createDataStructureFunctions({
        readMemory: (at, length)=>memory.slice(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        kernel32: name=>kernel32[name],
        call: (entry, args)=>/** @type {any} */ (callbacks.get(entry))(...args),
    });
    const run = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        /** @type {any} */ (f)[name].handler(args);
    const view = new DataView(memory.buffer);
    return { f, run, memory, view, callbacks, allocate };
}

test('a DPA keeps its count and pointers where the SDK macros read them', ()=>{
    const { run, view } = machine();
    const dpa = run('DPA_Create', [0]);
    assert.equal(run('DPA_SetPtr', [dpa, 1, 6]), 1, 'past the end');
    assert.equal(run('DPA_SetPtr', [dpa, 0, 5]), 1, 'the gap filled');
    assert.equal(run('DPA_InsertPtr', [dpa, 1, 1]), 1);
    assert.equal(run('DPA_InsertPtr', [dpa, 9, 2]), 3, 'past the end appends');
    assert.equal(run('DPA_InsertPtr', [dpa, 0x7fffffff, 4]), 4, 'DPA_APPEND');
    // DPA_GetPtrCount and DPA_FastGetPtr read the structure itself.
    assert.equal(view.getInt32(dpa, true), 5);
    const block = view.getUint32(dpa + 4, true);
    assert.deepEqual([0, 1, 2, 3, 4].map(i=>view.getUint32(block + i * 4, true)), [5, 1, 6, 2, 4]);
    assert.equal(run('DPA_GetPtr', [dpa, 5]), 0, 'NULL past the end');
    assert.equal(run('DPA_GetPtrIndex', [dpa, 6]), 2);
    assert.equal(run('DPA_DeletePtr', [dpa, 2]), 6);
    assert.equal(run('DPA_DeletePtr', [dpa, -1]), 0);
    assert.equal(run('DPA_GetPtr', [dpa, 3]), 4);
    const copy = run('DPA_Clone', [dpa, 0]);
    assert.equal(view.getInt32(copy, true), 4);
    assert.equal(run('DPA_DeleteAllPtrs', [dpa]), 1);
    assert.equal(view.getInt32(dpa, true), 0);
    assert.equal(run('DPA_GetPtr', [copy, 0]), 5, 'the clone has its own pointers');
    assert.equal(run('DPA_Destroy', [dpa]), 1);
});

test('a DPA sorts stably and searches sorted with its insertion point', async()=>{
    const { run, callbacks } = machine();
    callbacks.set(0x500, (a, b)=>(a >> 4) - (b >> 4));
    const dpa = run('DPA_Create', [4]);
    for (const value of [0x31, 0x12, 0x32, 0x11, 0x50])
    {
        run('DPA_InsertPtr', [dpa, 0x7fffffff, value]);
    }
    assert.equal(await run('DPA_Sort', [dpa, 0x500, 0]), 1);
    assert.deepEqual([0, 1, 2, 3, 4].map(i=>run('DPA_GetPtr', [dpa, i])),
        [0x12, 0x11, 0x31, 0x32, 0x50], 'equal keys keep their order');
    assert.ok([2, 3].includes(await run('DPA_Search', [dpa, 0x30, 0, 0x500, 0, 1])), 'found');
    assert.equal(await run('DPA_Search', [dpa, 0x40, 0, 0x500, 0, 1]), -1, 'not there');
    assert.equal(await run('DPA_Search', [dpa, 0x40, 0, 0x500, 0, 1 | 4]), 4, 'where it would go');
    assert.equal(await run('DPA_Search', [dpa, 0x10, 2, 0x500, 0, 0]), -1,
        'a linear search from iStart');
});

test('a merge intersects and unites, telling the program each step', async()=>{
    const { run, callbacks } = machine();
    callbacks.set(0x500, (a, b)=>a - b);
    const told = [0, 0, 0, 0];
    callbacks.set(0x600, (op, p1, p2)=>{
        told[op]++;
        return op === 1 ? p2 + 1 : p1;
    });
    const dest = run('DPA_Create', [0]);
    const source = run('DPA_Create', [0]);
    [6, 5, 4, 3, 2, 1].forEach(v=>run('DPA_InsertPtr', [dest, 0x7fffffff, v]));
    [1, 3, 5].forEach(v=>run('DPA_InsertPtr', [source, 0x7fffffff, v]));
    assert.equal(await run('DPA_Merge', [dest, source, 8, 0x500, 0x600, 0]), 1);
    assert.deepEqual([0, 1, 2].map(i=>run('DPA_GetPtr', [dest, i])), [2, 4, 6]);
    assert.equal(run('DPA_GetPtr', [dest, 3]), 0);
    assert.deepEqual(told, [0, 3, 3, 0], 'three merged, three deleted');

    told.fill(0);
    run('DPA_DeleteAllPtrs', [dest]);
    [2, 4, 6].forEach(v=>run('DPA_InsertPtr', [dest, 0x7fffffff, v]));
    assert.equal(await run('DPA_Merge', [dest, source, 4 | 1, 0x500, 0x600, 0]), 1);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i=>run('DPA_GetPtr', [dest, i])), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(told, [0, 0, 0, 3], 'three inserted');
});

test('an enumeration reads the array again after each callback, and stops at zero', async()=>{
    const { run, callbacks } = machine();
    const dpa = run('DPA_Create', [0]);
    [1, 2, 3, 4].forEach(v=>run('DPA_InsertPtr', [dpa, 0x7fffffff, v]));
    /** @type {number[]} */
    const seen = [];
    callbacks.set(0x700, (item, data)=>{
        seen.push(item);
        run('DPA_SetPtr', [data, seen.length - 1, 7]);
        return item === 3 ? 0 : 1;
    });
    await run('DPA_EnumCallback', [dpa, 0x700, dpa]);
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual([0, 1, 2, 3].map(i=>run('DPA_GetPtr', [dpa, i])), [7, 7, 7, 4]);
});

test('a DSA copies its items in and out', ()=>{
    const { run, memory, allocate } = machine();
    const dsa = run('DSA_Create', [6, 2]);
    const item = allocate(6);
    for (const [index, byte] of [[0, 0xa], [0, 0xb], [5, 0xc]])
    {
        memory.fill(byte, item, item + 6);
        run('DSA_InsertItem', [dsa, index, item]);
    }
    const out = allocate(6);
    assert.equal(run('DSA_GetItem', [dsa, 1, out]), 1);
    assert.equal(memory[out], 0xa);
    assert.equal(memory[run('DSA_GetItemPtr', [dsa, 2])], 0xc, 'past the end appended');
    assert.equal(run('DSA_DeleteItem', [dsa, 0]), 1);
    assert.equal(memory[run('DSA_GetItemPtr', [dsa, 0])], 0xa);
    assert.equal(run('DSA_GetItemPtr', [dsa, 2]), 0);
    assert.equal(run('DSA_Destroy', [dsa]), 1);
});

test('the allocator and the string slots, by number alone', ()=>{
    const { run, memory, view, allocate } = machine();
    const block = run('#71', [1]);
    assert.equal(run('#74', [block]), 1);
    const grown = run('#72', [block, 2]);
    assert.equal(run('#74', [grown]), 2);
    assert.equal(run('#73', [grown]), 1);
    assert.equal(run('#73', [0]), 1, 'NULL is nothing to free');

    const source = allocate(32);
    memory.set(new TextEncoder().encode('Just a source\0'), source);
    const dest = allocate(32);
    assert.equal(run('#233', [source, 0, 0]), 14, 'its length with the terminator');
    assert.equal(run('#233', [source, dest, 5]), 5, 'what fitted, terminator counted');
    assert.equal(new TextDecoder().decode(memory.slice(dest, dest + 5)), 'Just\0');
    assert.equal(run('#233', [0, dest, 5]), 0);
    assert.equal(memory[dest], 0);

    const slot = allocate(4);
    assert.equal(run('#234', [slot, source]), 1);
    const copy = view.getUint32(slot, true);
    assert.equal(new TextDecoder().decode(memory.slice(copy, copy + 13)), 'Just a source');
    assert.equal(run('#234', [slot, 0]), 1);
    assert.equal(view.getUint32(slot, true), 0, 'NULL frees the copy');
    assert.equal(DATA_ORDINALS[71], '#71');
    assert.equal(DATA_ORDINALS[328], 'DPA_Create');
});

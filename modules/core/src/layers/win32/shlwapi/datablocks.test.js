/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { DATABLOCK_ORDINALS, blocksOf, stored } from './datablocks.js';
import { SHLWAPI_ORDINALS } from './forwards.js';

/** A machine whose LocalAlloc is the fixture's heap, and a block put in its memory. */
function machine(){
    /** @type {number[]} */
    const freed = [];
    /** @type {any} */
    let m = null;
    const kernel32 = {
        LocalAlloc: { handler: (/** @type {number[]} */ [, bytes])=>m.base.allocate(bytes) },
        LocalFree: { handler: (/** @type {number[]} */ [at])=>{
            freed.push(at);
            return 0;
        } },
    };
    m = shlwapiMachine({ library: name=>(name === 'KERNEL32.dll' ? kernel32 : undefined) });
    /** @param {number} signature @param {number} data  bytes after the header */
    const block = (signature, data)=>{
        const at = m.put('', false, 64);
        m.view.setUint32(at, 8 + data, true);
        m.view.setUint32(at + 4, signature, true);
        for (let i = 0; i < data; i++)
        {
            m.memory[at + 8 + i] = i * 2;
        }
        return at;
    };
    return { m, block, freed };
}

test('the data block functions are exported by their numbers', ()=>{
    for (const [ordinal, name] of DATABLOCK_ORDINALS)
    {
        assert.equal(SHLWAPI_ORDINALS[ordinal], name, `#${ordinal}`);
    }
});

test('a block whose size is no multiple of four is kept in a container', ()=>{
    const odd = Uint8Array.of(9, 0, 0, 0, 7, 0, 0, 0, 1);
    const kept = stored(odd);
    assert.equal(kept.length, 8 + 12);
    assert.deepEqual([...kept.subarray(0, 8)], [20, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    assert.deepEqual([...kept.subarray(8, 17)], [...odd]);
    const even = stored(Uint8Array.of(8, 0, 0, 0, 3, 0, 0, 0));
    const list = Uint8Array.of(...kept, ...even, 0, 0, 0, 0);
    assert.deepEqual(blocksOf(list).map(found=>[found.at, found.block.length]), [[8, 9], [20, 8]]);
});

test('blocks are added, found and removed, and the list freed when it is empty', ()=>{
    // Wine's test_CList.
    const { m, block, freed } = machine();
    const slot = m.count(0);
    assert.equal(m.fns.SHAddDataBlock.handler([slot, block(1, 4)]), 1);
    assert.equal(m.fns.SHAddDataBlock.handler([slot, block(2, 5)]), 1);
    const list = m.dwordAt(slot);
    const found = m.fns.SHFindDataBlock.handler([list, 2]);
    assert.equal(m.dwordAt(found + 4), 2, 'the block, not its container');
    assert.equal(m.dwordAt(found - 4), 0xffffffff, 'inside a container');
    assert.equal(m.memory[found + 8 + 4], 8, 'its data');
    assert.equal(m.fns.SHFindDataBlock.handler([list, 99]), 0);
    const small = block(33, 0);
    m.view.setUint32(small, 7, true);
    assert.equal(m.fns.SHAddDataBlock.handler([slot, small]), 0, 'smaller than its header');
    assert.equal(m.fns.SHAddDataBlock.handler([0, block(3, 4)]), 0);
    assert.equal(m.fns.SHAddDataBlock.handler([slot, block(0xffffffff, 36)]), 0, 'a container');
    assert.equal(m.fns.SHRemoveDataBlock.handler([slot, 1]), 1);
    assert.equal(m.fns.SHRemoveDataBlock.handler([slot, 1]), 0);
    assert.equal(m.fns.SHRemoveDataBlock.handler([slot, 2]), 1);
    assert.equal(m.dwordAt(slot), 0, 'no blocks, no list');
    assert.ok(freed.length >= 1);
});

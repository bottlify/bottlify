/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStackPool } from './stacks.js';

const GRANULE = 0x10000;

/** The memory layer as the pool uses it: what it zeroes, and what it registers. */
function fakeMemory(){
    /** @type {[number, number][]} */
    const filled = [];
    return {
        filled,
        RegionKind: { STACK: 'stack' },
        Access: { READ_WRITE: 'rw' },
        register: ()=>{},
        unregister: ()=>{},
        charge: ()=>true,
        /** @param {number} address @param {number} value @param {number} length */
        fillBytes: (address, value, length)=>{
            filled.push([address, length]);
        },
    };
}

test('in a gone process\'s memory a stack is zeroed as it is first taken, below where that'
    + ' process\'s stacks reached, and not again once it is this process\'s own', ()=>{
    const memory = fakeMemory();
    const base = 0x08000000;
    const pool = createStackPool({ memory, base, size: GRANULE, limit: base + 16 * GRANULE,
        dirtyTo: base + 3 * GRANULE / 2 });
    const first = pool.allocate({}, ()=>false);
    const second = pool.allocate({}, ()=>false);
    assert.deepEqual(memory.filled, [[base, GRANULE], [base + GRANULE, GRANULE / 2]],
        'each below the gone process\'s reach, the rest as a new memory has it');
    assert.equal(first?.base, base);
    assert.equal(second?.base, base + GRANULE);
    assert.ok(first && second);
    // The first one's thread gone, the second's not.
    first.owner = 'gone';
    second.owner = 'running';
    const third = pool.allocate({}, owner=>owner === 'gone');
    assert.equal(third?.base, base, 'a stack let go of, taken again');
    assert.equal(memory.filled.length, 2, 'this process\'s own: as it left it');
    assert.equal(pool.reached(), base + 2 * GRANULE, 'past the gone process\'s reach now');

    const fresh = fakeMemory();
    const own = createStackPool({ memory: fresh, base, size: GRANULE, limit: base + 4 * GRANULE });
    own.allocate({}, ()=>false);
    assert.deepEqual(fresh.filled, [], 'a memory just made: nothing to zero');
    assert.equal(own.reached(), base + GRANULE);
});

test('a stack the pool has no room for is taken from its lender and given back once let go', ()=>{
    const base = 0x08000000;
    const pool = createStackPool({ memory: fakeMemory(), base, size: GRANULE,
        limit: base + 2 * GRANULE });
    assert.equal(pool.allocate({}, ()=>false)?.base, base);
    assert.equal(pool.allocate({}, ()=>false)?.base, base + GRANULE);
    assert.equal(pool.allocate({}, ()=>false), null, 'full, and no lender: no stack');
    /** @type {number[]} */
    const given = [];
    pool.lend({ take: bytes=>(bytes === GRANULE ? 0x20000000 : 0), give: at=>given.push(at) });
    const lent = pool.allocate({}, ()=>false);
    assert.equal(lent?.base, 0x20000000, 'the lender\'s, at the size the pool would have given');
    assert.equal(pool.diagnostics().stacksLent, 1);
    if (lent)
    {
        lent.owner = { gone: true };
    }
    pool.allocate({}, owner=>owner?.gone === true);
    assert.deepEqual(given, [0x20000000], 'given back once its thread let it go');
});

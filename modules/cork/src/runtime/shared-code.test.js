/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_WRITE_SLOTS, SHARED_CODE_BYTES, createSharedCode } from './shared-code.js';
import { PAGE } from './layout.js';

/** A shared memory with room for the record at its start. */
const memory = ()=>new WebAssembly.Memory({ initial: Math.ceil(SHARED_CODE_BYTES / PAGE),
    maximum: Math.ceil(SHARED_CODE_BYTES / PAGE), shared: true });

test('a page stays held while any executor holds code on it', ()=>{
    const m = memory();
    const [a, b] = [0, 1].map(index=>createSharedCode(m, 0, index));
    a.hold(7);
    b.hold(7);
    assert.equal(a.release(7), true, 'b still holds it');
    assert.equal(b.release(7), false, 'nobody does');
    a.hold(9);
    assert.equal(a.release(9), false);
});

test('each executor reads the stores into code the others met, in order, and not its own', ()=>{
    const m = memory();
    const [a, b, c] = [0, 1, 2].map(index=>createSharedCode(m, 0, index));
    a.publish(0x1000, 4);
    b.publish(0x2000, 8);
    a.publish(0x3000, 1);
    /** @param {ReturnType<typeof createSharedCode>} who */
    const read = who=>{
        /** @type {number[][]} */
        const seen = [];
        who.take((address, size)=>seen.push([address, size]));
        return seen;
    };
    assert.deepEqual(read(c), [[0x1000, 4], [0x2000, 8], [0x3000, 1]]);
    assert.deepEqual(read(b), [[0x1000, 4], [0x3000, 1]]);
    assert.deepEqual(read(a), [[0x2000, 8]]);
    assert.deepEqual(read(a), [], 'nothing new');
    // One that joins later reads only what was written after it.
    const d = createSharedCode(m, 0, 3);
    b.publish(0x4000, 2);
    assert.deepEqual(read(d), [[0x4000, 2]]);
});

test('a reader the ring lapped is told everything went', ()=>{
    const m = memory();
    const [a, b] = [0, 1].map(index=>createSharedCode(m, 0, index));
    for (let i = 0; i <= CODE_WRITE_SLOTS; i++)
    {
        a.publish(i * 16, 1);
    }
    /** @type {number[][]} */
    const seen = [];
    b.take((address, size)=>seen.push([address, size >>> 0]));
    assert.deepEqual(seen, [[0, 0xffffffff]]);
    a.publish(0x5000, 4);
    seen.length = 0;
    b.take((address, size)=>seen.push([address, size]));
    assert.deepEqual(seen, [[0x5000, 4]], 'and goes on from there');
});

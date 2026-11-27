/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocationPerAwait, allocationPerCall, bytesPerAwait, bytesPerCall }
    from './allocation.mjs';

const SIZE = 3 << 20;

// The sampler sees a typed array's header, never its backing store: a call
// that makes and drops 3 MiB has to show 3 MiB, or the garbage tests hold
// pass on the garbage they are there to catch.
test('a buffer made and dropped each call counts its backing store', async()=>{
    let last = null;
    const made = await allocationPerCall(()=>{ last = new Uint8Array(SIZE); }, { calls: 200 });
    assert.ok(made.buffers >= SIZE, `buffers ${made.buffers} a call`);
    assert.ok(made.heap < 4096, `heap ${made.heap} a call`);
    assert.ok(await bytesPerCall(()=>{ last = new Uint8Array(SIZE); }, { calls: 200 }) >= SIZE);
    assert.ok(last);
});

test('a buffer reused each call counts nothing', async()=>{
    const kept = new Uint8Array(SIZE);
    const reused = await allocationPerCall(()=>{ kept.fill(1, 0, 64); }, { calls: 200 });
    assert.ok(reused.buffers < 64, `buffers ${reused.buffers} a call`);
    assert.ok(reused.heap < 64, `heap ${reused.heap} a call`);
    assert.ok(await bytesPerCall(()=>{ kept.fill(2, 0, 64); }, { calls: 200 }) < 64);
});

test('an awaited call counts the buffers it makes', async()=>{
    let last = null;
    const made = await allocationPerAwait(async()=>{ last = new ArrayBuffer(SIZE); },
        { calls: 100 });
    assert.ok(made.buffers >= SIZE, `buffers ${made.buffers} a call`);
    assert.ok(await bytesPerAwait(async()=>{ last = new ArrayBuffer(SIZE); }, { calls: 100 })
        >= SIZE);
    assert.ok(last);
});

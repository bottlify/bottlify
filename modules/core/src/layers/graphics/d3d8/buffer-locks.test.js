/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBufferLocks } from './buffer-locks.js';
import { D3DLOCK } from './constants.js';

/** A buffer's locks over a renderer that writes down what it is told. */
function locks(){
    /** @type {string[]} */
    const told = [];
    const held = createBufferLocks({
        length: 1024,
        lock: (offset, length, flags)=>told.push(`lock ${offset}+${length} ${flags}`),
        unlock: ()=>told.push('unlock'),
    });
    return { held, told };
}

test('locks nest, and the renderer holds one lock of their union until the last unlock', ()=>{
    // A dynamic index buffer filled a piece at a time, the next piece locked
    // before the last is unlocked.
    const { held, told } = locks();
    assert.equal(held.take(100, 20, 0), 20);
    assert.equal(held.take(110, 5, 0), 5, 'inside what is held: nothing to take again');
    assert.equal(held.take(120, 30, 0), 30);
    assert.equal(held.count, 3);
    assert.deepEqual(told, ['lock 100+20 0', 'unlock', `lock 100+50 ${D3DLOCK.NOOVERWRITE}`],
        'a lock reaching outside takes the union again, keeping what was written');
    assert.equal(held.release(), true);
    assert.equal(held.release(), true);
    assert.equal(told.length, 3, 'still held');
    assert.equal(held.release(), true);
    assert.deepEqual(told.slice(3), ['unlock'], 'the last unlock lets it go');
    assert.equal(held.release(), false, 'an unlock past the locks owes nothing');
});

test('a range the buffer does not have is refused and leaves the count alone', ()=>{
    const { held, told } = locks();
    assert.equal(held.take(1000, 30, 0), null, 'past the end');
    assert.equal(held.take(1024, 0, 0), null, 'nothing left to the end');
    assert.equal(held.take(1000, 0, 0), 24, 'zero means to the end');
    assert.equal(held.count, 1);
    assert.deepEqual(told, ['lock 1000+24 0']);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedViews } from './shared-views.js';

/** A process's memory, and a view of a section in it. */
function processMemory(){
    const bytes = new Uint8Array(0x10000);
    return {
        bytes,
        /** @param {number} process @param {number} address @param {number} offset @param {number} length */
        view: (process, address, offset, length)=>({
            process, address, offset, length,
            read: (/** @type {number} */ at, /** @type {number} */ count)=>
                bytes.subarray(at, at + count),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        }),
    };
}

test('a write in one process is read in the other once its turn has ended', ()=>{
    const shared = createSharedViews();
    const section = {};
    const one = processMemory();
    const two = processMemory();
    const first = one.view(1, 0x1000, 0, 64);
    const second = two.view(2, 0x2000, 0, 64);
    shared.attach(section, 64, first);
    shared.attach(section, 64, second);

    shared.enter(1);
    one.bytes[0x1000 + 5] = 0x55;
    one.bytes[0x1000 + 63] = 0x77;
    shared.leave(1);
    assert.equal(two.bytes[0x2000 + 5], 0, 'not before the reader\'s turn');
    shared.enter(2);
    assert.equal(two.bytes[0x2000 + 5], 0x55);
    assert.equal(two.bytes[0x2000 + 63], 0x77, 'a byte past the last whole word too');
    // The reader answers in a byte the writer did not touch: both writes stand.
    two.bytes[0x2000 + 6] = 0x66;
    shared.leave(2);
    shared.enter(1);
    assert.deepEqual([...one.bytes.subarray(0x1005, 0x1007)], [0x55, 0x66]);
    shared.leave(1);
});

test('writes to different bytes in the same turn round are merged, not overwritten', ()=>{
    const shared = createSharedViews();
    const section = {};
    const one = processMemory();
    const two = processMemory();
    shared.attach(section, 16, one.view(1, 0x100, 0, 16));
    shared.attach(section, 16, two.view(2, 0x200, 0, 16));
    shared.enter(1);
    one.bytes[0x100] = 1;
    shared.leave(1);
    // Process two's turn writes another byte; it began after one's ended.
    shared.enter(2);
    two.bytes[0x201] = 2;
    shared.leave(2);
    shared.enter(1);
    assert.deepEqual([...one.bytes.subarray(0x100, 0x102)], [1, 2]);
});

test('a view of part of a section, a late view, two views in one process, and an unmap', ()=>{
    const shared = createSharedViews();
    const section = {};
    const one = processMemory();
    const two = processMemory();
    const whole = one.view(1, 0x1000, 0, 32);
    const sibling = one.view(1, 0x3000, 16, 16);
    shared.attach(section, 32, whole);
    shared.attach(section, 32, sibling);
    shared.enter(1);
    one.bytes[0x1000 + 20] = 9;
    shared.leave(1);
    shared.enter(1);
    assert.equal(one.bytes[0x3000 + 4], 9, 'the sibling view sees it the next turn');
    shared.leave(1);

    // A view mapped later starts with what the section holds.
    const late = two.view(2, 0x2000, 0, 32);
    shared.attach(section, 32, late);
    assert.equal(two.bytes[0x2000 + 20], 9);

    // What a view wrote before it was unmapped reaches the others.
    shared.enter(2);
    two.bytes[0x2000] = 4;
    shared.detach(late);
    shared.leave(2);
    shared.enter(1);
    assert.equal(one.bytes[0x1000], 4);
    shared.leave(1);
    assert.equal(shared.diagnostics().sections, 1);
    shared.detach(sibling);
    assert.equal(shared.diagnostics().sections, 0, 'one view left: nothing to agree');
});

test('a section with one view costs a turn nothing', ()=>{
    const shared = createSharedViews();
    const one = processMemory();
    shared.attach({}, 4096, one.view(1, 0x1000, 0, 4096));
    shared.enter(1);
    shared.leave(1);
    assert.equal(shared.diagnostics().compared, 0);
});

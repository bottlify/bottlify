/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * check-wide-addresses.mjs's judgement of one pair of calls: what the bridge
 * puts into RAX, an answer moved by the bases' distance, and the dwords a call
 * wrote. The sweep over every handler is the check itself (`npm run
 * check:boundaries`); this holds what it calls a difference to what it means.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    HIGH, LOW, mangledPointers, raxOf, sameAnswer, writeDifferences,
} from './check-wide-addresses.mjs';

test('RAX is a dword sign-extended, a bigint whole, nothing for no number', ()=>{
    assert.equal(raxOf(0x100000), 0x100000n);
    assert.equal(raxOf(0x90100000), 0xffffffff90100000n);
    assert.equal(raxOf(-1), 0xffffffffffffffffn);
    assert.equal(raxOf(0x90100000n), 0x90100000n);
    assert.equal(raxOf(undefined), null);
    // An address the spec declares (`returns: 'pointer'`) is zero-extended, as the bridge does.
    assert.equal(raxOf(0x90100000, { returns: 'pointer' }), 0x90100000n);
    assert.equal(raxOf(-1, { returns: 'pointer' }), 0xffffffffn);
});

test('an answer pointing into the window may move by the distance, nothing else may', ()=>{
    const distance = BigInt(HIGH - LOW);
    assert.ok(sameAnswer(5n, 5n, LOW, HIGH));
    assert.ok(sameAnswer(BigInt(LOW + 0x40), BigInt(LOW + 0x40) + distance, LOW, HIGH));
    // A pointer past 2 GiB answered as a signed dword is the bug the check is for.
    assert.ok(!sameAnswer(BigInt(LOW + 0x40), raxOf(HIGH + 0x40), LOW, HIGH));
    // A value outside the window does not move.
    assert.ok(!sameAnswer(7n, 7n + distance, LOW, HIGH));
    assert.ok(!sameAnswer(null, 0n, LOW, HIGH));
});

test('a written dword may differ by the distance where it points into the window', ()=>{
    const before = new Uint8Array(16);
    const low = new Uint8Array(16);
    const high = new Uint8Array(16);
    const lowView = new DataView(low.buffer);
    const highView = new DataView(high.buffer);
    // A pointer written into an out-structure, moved with its window.
    lowView.setUint32(0, LOW + 0x10, true);
    highView.setUint32(0, HIGH + 0x10, true);
    assert.deepEqual(writeDifferences(before, low, before, high, LOW, HIGH), []);
    // Its upper dword written signed at the high base.
    highView.setUint32(4, 0xffffffff, true);
    assert.deepEqual(writeDifferences(before, low, before, high, LOW, HIGH), [4]);
    // A count that differs is a difference whatever it is.
    lowView.setUint32(8, 3, true);
    highView.setUint32(8, 4, true);
    assert.deepEqual(writeDifferences(before, low, before, high, LOW, HIGH), [4, 8]);
});

test('what a call did not write is not its own, however the windows had parted', ()=>{
    const lowBefore = Uint8Array.of(1, 0, 0, 0);
    const highBefore = Uint8Array.of(2, 0, 0, 0);
    assert.deepEqual(writeDifferences(lowBefore, Uint8Array.from(lowBefore), highBefore,
        Uint8Array.from(highBefore), LOW, HIGH), []);
});

test('an address may point anywhere in its own window, a value is judged by its low dword', ()=>{
    // Two arenas parted by a call before: each answer inside its own window is right.
    assert.equal(sameAnswer(0x156040n, 0x90160000n, LOW, HIGH, 'address'), true);
    // Zero-extension's fault: an address sign-extended past 2 GiB.
    assert.equal(sameAnswer(0x110000n, 0xffffffff90110000n, LOW, HIGH, 'address'), false);
    // An int computed from an address: sign-extended by its type, as Windows does.
    assert.equal(sameAnswer(0x110000n, 0xffffffff90110000n, LOW, HIGH, 'value'), true);
    assert.equal(sameAnswer(5n, 5n, LOW, HIGH, 'value'), true);
    assert.equal(sameAnswer(5n, 6n, LOW, HIGH, 'value'), false);
});

test('an MSVC name says which of its arguments are addresses', ()=>{
    assert.deepEqual(mangledPointers('??2@YAPAXI@Z'), [], 'operator new(unsigned int)');
    assert.deepEqual(mangledPointers('??2@YAPEAX_K@Z'), [], 'operator new(unsigned __int64)');
    assert.deepEqual(mangledPointers('??3@YAXPAX@Z'), [0], 'operator delete(void *)');
    assert.deepEqual(mangledPointers('??3@YAXPEAX@Z'), [0]);
    assert.equal(mangledPointers('?f@@YAXVclass@@@Z'), null, 'a class is not read');
    assert.equal(mangledPointers('??0exception@@QAE@XZ'), null, 'a constructor is not read');
    // A member's `this` is its first argument; a count after it is none.
    assert.deepEqual(mangledPointers('?allocate@?$allocator@D@std@@QEAAPEAD_K@Z'), [0],
        'std::allocator<char>::allocate(unsigned __int64)');
    assert.deepEqual(mangledPointers('?deallocate@?$allocator@D@std@@QEAAXPEAD_K@Z'), [0, 1]);
    assert.deepEqual(mangledPointers('?max_size@?$allocator@D@std@@QBEIXZ'), [0], 'const, 32-bit');
    assert.equal(mangledPointers('GetProcessHeap'), null);
});

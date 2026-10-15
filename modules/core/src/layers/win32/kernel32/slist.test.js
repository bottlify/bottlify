/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSListFunctions } from './slist.js';

const HEADER = 0x100;
const ITEM1 = 0x200;
const ITEM2 = 0x210;
const ITEM3 = 0x220;
const CODE = 0x300;
const TRAP = 0x1000;

function setup(){
    const bytes = new Uint8Array(0x400);
    const fns = createSListFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        allocate: ()=>CODE,
    });
    const view = new DataView(bytes.buffer);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    const depth = ()=>fns.QueryDepthSList.handler([HEADER]);
    return { bytes, view, fns, u32, depth };
}

test('entries push and pop last in, first out, the depth counting them', ()=>{
    // kernel32's sync tests (test_slist): each push answers the entry that
    // was first before it, and a pop the entry it took.
    const { bytes, fns, u32, depth } = setup();
    bytes.fill(0xff, HEADER, HEADER + 8);
    fns.InitializeSListHead.handler([HEADER]);
    assert.equal(depth(), 0);

    assert.equal(fns.InterlockedPushEntrySList.handler([HEADER, ITEM1]), 0);
    assert.equal(fns.InterlockedPushEntrySList.handler([HEADER, ITEM2]), ITEM1);
    assert.equal(fns.InterlockedPushEntrySList.handler([HEADER, ITEM3]), ITEM2);
    assert.equal(depth(), 3);
    assert.equal(u32(HEADER), ITEM3, 'the header names the first entry');
    assert.equal(u32(ITEM3), ITEM2, 'and each entry the next');

    assert.equal(fns.InterlockedPopEntrySList.handler([HEADER]), ITEM3);
    assert.equal(depth(), 2);
    assert.equal(fns.InterlockedFlushSList.handler([HEADER]), ITEM2, 'the chain, still linked');
    assert.equal(u32(ITEM2), ITEM1);
    assert.equal(depth(), 0);
    assert.equal(fns.InterlockedPopEntrySList.handler([HEADER]), 0, 'empty');
});

test('a list pushed whole adds its count, and flushing an empty list keeps the depth', ()=>{
    const { bytes, view, u32, fns, depth } = setup();
    fns.InitializeSListHead.handler([HEADER]);
    fns.InterlockedPushEntrySList.handler([HEADER, ITEM3]);
    // The chain arrives linked by the caller: ITEM2, then ITEM1.
    view.setUint32(ITEM2, ITEM1, true);
    const pushList = fns.InterlockedPushEntrySList.natives.RtlInterlockedPushListSListEx;
    assert.equal(pushList.handler([HEADER, ITEM2, ITEM1, 42]), ITEM3);
    assert.equal(depth(), 43, 'the count as given');
    assert.equal(u32(ITEM1), ITEM3, 'the chain\'s end links to what was first');
    for (const expected of [ITEM2, ITEM1, ITEM3])
    {
        assert.equal(fns.InterlockedPopEntrySList.handler([HEADER]), expected);
    }
    assert.equal(depth(), 40);
    assert.equal(fns.InterlockedFlushSList.handler([HEADER]), 0);
    assert.equal(depth(), 40, 'an empty flush changes nothing');
    assert.deepEqual([fns.InterlockedPushEntrySList.argBytes, pushList.argBytes], [8, 16]);
    assert.equal(bytes[CODE], 0, 'nothing placed for the Ex form');
});

test('the fastcall push moves ECX and EDX under the return address and jumps to a trap', ()=>{
    // RtlInterlockedPushListSList is __fastcall, which a trap cannot be bound
    // as; its code hands the stdcall trap all four arguments.
    const { bytes, fns, depth } = setup();
    /** @type {any} */
    let trap = null;
    const builder = {
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            trap = fn;
            return TRAP;
        },
    };
    const fast = fns.InterlockedPushEntrySList.natives.RtlInterlockedPushListSList;
    assert.equal(fast.guest(builder), CODE);
    const relative = TRAP - (CODE + 9);
    assert.deepEqual([...bytes.subarray(CODE, CODE + 9)], [0x58, 0x52, 0x51, 0x50, 0xe9,
        relative & 0xff, relative >>> 8 & 0xff, relative >>> 16 & 0xff, relative >>> 24 & 0xff]);
    assert.equal(trap.argBytes, 16, 'the two registers and the two stack words, all popped');
    fns.InitializeSListHead.handler([HEADER]);
    assert.equal(trap.handler([HEADER, ITEM1, ITEM1, 1]), 0);
    assert.equal(depth(), 1);
    assert.equal(fast.guest(builder), CODE, 'placed once');
});

test('a push that another thread\'s change overtakes looks again, and loses neither', ()=>{
    // Between the host's read of the header and its swap, a thread on
    // another executor pushes with its own lock cmpxchg8b: the host's swap
    // fails, and the push is made again over what that thread left.
    const bytes = new Uint8Array(0x400);
    const view = new DataView(bytes.buffer);
    /** @type {(() => void) | null} */
    let meanwhile = null;
    const fns = createSListFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        compareExchangeU64: (address, expected, value)=>{
            const other = meanwhile;
            meanwhile = null;
            other?.();
            const held = view.getBigUint64(address, true);
            if (held === expected)
            {
                view.setBigUint64(address, value, true);
            }
            return held;
        },
        allocate: ()=>CODE,
    });
    fns.InitializeSListHead.handler([HEADER]);
    meanwhile = ()=>{
        // Their push of ITEM2 onto the empty list: next 0, depth 1, sequence 1.
        view.setUint32(ITEM2, 0, true);
        view.setUint32(HEADER, ITEM2, true);
        view.setUint16(HEADER + 4, 1, true);
        view.setUint16(HEADER + 6, 1, true);
    };
    assert.equal(fns.InterlockedPushEntrySList.handler([HEADER, ITEM1]), ITEM2,
        'the entry that was first when it was made');
    assert.equal(view.getUint32(HEADER, true), ITEM1);
    assert.equal(view.getUint32(ITEM1, true), ITEM2, 'linked to theirs');
    assert.equal(fns.QueryDepthSList.handler([HEADER]), 2);
    assert.equal(view.getUint16(HEADER + 6, true), 2, 'and a sequence each');
});
